import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { AccountStatus, EmailOutboxStatus, EmailOutboxType } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { normalizeEmail } from '../../config/env.js';
import {
  BadRequestError,
  ForbiddenError,
  TooManyRequestsError,
} from '../../utils/errors.js';
import { maskEmailForLog, normalizeClientOrigin, sanitizeEmailLogMessage } from '../../lib/email.service.js';
import { getRedisClient } from '../../lib/redis.js';
import { recordAdminAuditLog } from '../../lib/auditLogger.js';
import {
  checkRedisSlidingWindowRateLimit,
  hashRateLimitIdentifier,
  invalidateUserAuthCache,
  recordDurableSessionInvalidationTx,
  recordEmergencySessionVersionFloor,
  resetSlidingWindowRateLimitsByPrefixForTests,
  revokeAllUserSessions,
  setCachedUserSessionVersion,
} from '../../lib/session.service.js';
import {
  PASSWORD_RESET_DELIVERY_SECRET_PREFIX,
  dispatchEmailOutboxItemById,
  encryptPasswordResetDeliveryToken,
  enqueuePasswordResetEmail,
} from '../notifications/emailOutbox.service.js';
import {
  isEmailOutboxWorkerRunning,
  triggerEmailOutboxDispatch,
} from '../notifications/emailOutboxWorker.js';
import { PASSWORD_MAX_LENGTH, evaluatePasswordPolicy } from './passwordPolicy.js';

export const PASSWORD_RESET_EXPIRY_MINUTES = 30;
export const PASSWORD_RESET_EXPIRY_MS = PASSWORD_RESET_EXPIRY_MINUTES * 60 * 1000;
export const PASSWORD_RESET_RETENTION_MS = 24 * 60 * 60 * 1000;

export const PASSWORD_RESET_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const PASSWORD_RESET_REQ_IP_BURST_WINDOW_MS = 60 * 1000;
export const PASSWORD_RESET_REQ_IP_BURST_MAX = 5;
export const PASSWORD_RESET_REQ_IP_SUSTAINED_MAX = 15;
export const PASSWORD_RESET_REQ_IP_EMAIL_MAX = 3;
// Global emergency inbox-flood circuit breaker over a 1-hour window so a handful of attacker IPs
// cannot silently suppress legitimate password-reset requests for a target email.
export const PASSWORD_RESET_EMAIL_SOFT_CAP_MAX = 20;
export const PASSWORD_RESET_EMAIL_SOFT_CAP_WINDOW_MS = 60 * 60 * 1000;
export const PASSWORD_RESET_SUBMIT_IP_MAX = 10;

const PWRESET_REQ_IP_BURST_PREFIX = 'pwreset_req_ip_burst:';
const PWRESET_REQ_IP_PREFIX = 'pwreset_req_ip:';
const PWRESET_REQ_IP_EMAIL_PREFIX = 'pwreset_req_ip_email:';
const PWRESET_MAIL_CAP_PREFIX = 'pwreset_mail_cap:';
const PWRESET_SUBMIT_IP_PREFIX = 'pwreset_submit_ip:';

export const UNIFORM_FORGOT_PASSWORD_MESSAGE =
  'If an account with that email address exists, we have sent password reset instructions.';

export function hashPasswordResetToken(rawToken: string): string {
  return crypto
    .createHash('sha256')
    .update(rawToken.trim(), 'utf8')
    .digest('hex');
}

export function generatePasswordResetToken(): { rawToken: string; tokenHash: string } {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  return {
    rawToken,
    tokenHash: hashPasswordResetToken(rawToken),
  };
}

export async function resetPasswordResetRateLimits(): Promise<void> {
  await Promise.all([
    resetSlidingWindowRateLimitsByPrefixForTests(PWRESET_REQ_IP_BURST_PREFIX),
    resetSlidingWindowRateLimitsByPrefixForTests(PWRESET_REQ_IP_PREFIX),
    resetSlidingWindowRateLimitsByPrefixForTests(PWRESET_REQ_IP_EMAIL_PREFIX),
    resetSlidingWindowRateLimitsByPrefixForTests(PWRESET_MAIL_CAP_PREFIX),
    resetSlidingWindowRateLimitsByPrefixForTests(PWRESET_SUBMIT_IP_PREFIX),
  ]);
}

/**
 * Deletes stale PasswordResetToken records expired beyond the retention window (24h).
 */
export async function purgeExpiredPasswordResetTokens(now = new Date()): Promise<number> {
  const retentionCutoff = new Date(now.getTime() - PASSWORD_RESET_RETENTION_MS);
  const result = await prisma.passwordResetToken.deleteMany({
    where: {
      expiresAt: { lt: retentionCutoff },
    },
  });
  return result.count;
}

/**
 * Initiates a forgot-password flow without leaking account existence.
 * Uses multi-layer Redis sliding-window rate limiting keyed by IP and (IP + email)
 * so attackers cannot lock legitimate users out from other IPs.
 */
export async function requestPasswordReset(params: {
  email: string;
  ipAddress?: string | null;
}): Promise<{ message: string; expiresInMinutes: number }> {
  const normalizedEmail = normalizeEmail(params.email);
  const clientIp = (params.ipAddress || 'unknown').trim() || 'unknown';
  const ipHash = hashRateLimitIdentifier(clientIp);
  const emailHash = hashRateLimitIdentifier(normalizedEmail);

  const ipBurst = await checkRedisSlidingWindowRateLimit(
    `${PWRESET_REQ_IP_BURST_PREFIX}${ipHash}`,
    PASSWORD_RESET_REQ_IP_BURST_MAX,
    PASSWORD_RESET_REQ_IP_BURST_WINDOW_MS
  );
  if (!ipBurst.allowed) {
    throw new TooManyRequestsError(
      'Too many password reset requests. Please wait before trying again.',
      'PASSWORD_RESET_RATE_LIMIT',
      ipBurst.retryAfterSeconds
    );
  }

  const ipSustained = await checkRedisSlidingWindowRateLimit(
    `${PWRESET_REQ_IP_PREFIX}${ipHash}`,
    PASSWORD_RESET_REQ_IP_SUSTAINED_MAX,
    PASSWORD_RESET_RATE_LIMIT_WINDOW_MS
  );
  if (!ipSustained.allowed) {
    throw new TooManyRequestsError(
      'Too many password reset requests. Please wait before trying again.',
      'PASSWORD_RESET_RATE_LIMIT',
      ipSustained.retryAfterSeconds
    );
  }

  const ipEmailRate = await checkRedisSlidingWindowRateLimit(
    `${PWRESET_REQ_IP_EMAIL_PREFIX}${ipHash}:${emailHash}`,
    PASSWORD_RESET_REQ_IP_EMAIL_MAX,
    PASSWORD_RESET_RATE_LIMIT_WINDOW_MS
  );
  if (!ipEmailRate.allowed) {
    throw new TooManyRequestsError(
      'Too many password reset requests for this email address from your connection. Please wait before trying again.',
      'PASSWORD_RESET_RATE_LIMIT',
      ipEmailRate.retryAfterSeconds
    );
  }

  const uniformResponse = {
    message: UNIFORM_FORGOT_PASSWORD_MESSAGE,
    expiresInMinutes: PASSWORD_RESET_EXPIRY_MINUTES,
  };

  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: {
      id: true,
      email: true,
      name: true,
      status: true,
    },
  });

  if (!user || user.status !== AccountStatus.ACTIVE) {
    return uniformResponse;
  }

  // Silent emergency cap across distributed IPs over 1 hour so distributed floods cannot spam a
  // user's inbox OR trivially suppress the legitimate account owner's reset flow.
  const mailCap = await checkRedisSlidingWindowRateLimit(
    `${PWRESET_MAIL_CAP_PREFIX}${emailHash}`,
    PASSWORD_RESET_EMAIL_SOFT_CAP_MAX,
    PASSWORD_RESET_EMAIL_SOFT_CAP_WINDOW_MS
  );
  if (!mailCap.allowed) {
    return uniformResponse;
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + PASSWORD_RESET_EXPIRY_MS);
  const retentionCutoff = new Date(now.getTime() - PASSWORD_RESET_RETENTION_MS);
  const clientOrigin = normalizeClientOrigin();
  const { rawToken, tokenHash } = generatePasswordResetToken();
  const outboxId = crypto.randomUUID();
  const deliveryKey = `${PASSWORD_RESET_DELIVERY_SECRET_PREFIX}${outboxId}`;
  const encryptedDeliverySecret = encryptPasswordResetDeliveryToken(rawToken);

  try {
    await getRedisClient().setPx(
      deliveryKey,
      encryptedDeliverySecret,
      PASSWORD_RESET_EXPIRY_MS
    );
  } catch (err) {
    const safeMsg = sanitizeEmailLogMessage(
      err instanceof Error ? err.message : 'Unknown Redis error',
      [rawToken, encryptedDeliverySecret]
    );
    console.error(
      `[PasswordReset] Failed to stage ephemeral delivery secret in Redis for ${maskEmailForLog(user.email)}: ${safeMsg}`
    );
    // Preserve anti-enumeration by returning the identical response without creating orphaned DB records.
    return uniformResponse;
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.passwordResetToken.deleteMany({
        where: {
          userId: user.id,
          expiresAt: { lt: retentionCutoff },
        },
      });

      const createdToken = await tx.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash,
          expiresAt,
        },
        select: { id: true },
      });

      await enqueuePasswordResetEmail(tx, {
        outboxId,
        passwordResetTokenId: createdToken.id,
        recipientEmail: user.email,
        recipientName: user.name,
        expiresInMinutes: PASSWORD_RESET_EXPIRY_MINUTES,
        expiresAt,
        clientOrigin,
      });
    });
  } catch (err) {
    try {
      await getRedisClient().del(deliveryKey);
    } catch {
      // Best-effort cleanup; Redis key also expires cleanly at 30 minutes
    }
    throw err;
  }

  if (isEmailOutboxWorkerRunning()) {
    triggerEmailOutboxDispatch();
  } else {
    try {
      await dispatchEmailOutboxItemById(outboxId);
    } catch {
      // Transient delivery errors leave EmailOutbox in PENDING state with backoff for worker retry.
    }
  }

  return uniformResponse;
}

/**
 * Validates whether a reset token is currently active without consuming it.
 */
export async function inspectPasswordResetToken(params: {
  rawToken: string;
  ipAddress?: string | null;
}): Promise<{ valid: true; expiresInMinutes: number }> {
  const clientIp = (params.ipAddress || 'unknown').trim() || 'unknown';
  const ipHash = hashRateLimitIdentifier(clientIp);

  const submitRate = await checkRedisSlidingWindowRateLimit(
    `${PWRESET_SUBMIT_IP_PREFIX}${ipHash}`,
    PASSWORD_RESET_SUBMIT_IP_MAX,
    PASSWORD_RESET_RATE_LIMIT_WINDOW_MS
  );
  if (!submitRate.allowed) {
    throw new TooManyRequestsError(
      'Too many password reset attempts. Please wait before trying again.',
      'PASSWORD_RESET_RATE_LIMIT',
      submitRate.retryAfterSeconds
    );
  }

  const trimmedToken = params.rawToken.trim();
  if (!trimmedToken) {
    throw new BadRequestError(
      'This password reset link is invalid or has expired. Please request a new one.',
      'INVALID_RESET_TOKEN'
    );
  }

  const tokenHash = hashPasswordResetToken(trimmedToken);
  const tokenRecord = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    select: {
      usedAt: true,
      expiresAt: true,
      user: {
        select: {
          status: true,
        },
      },
    },
  });

  if (!tokenRecord || !tokenRecord.user) {
    throw new BadRequestError(
      'This password reset link is invalid or has expired. Please request a new one.',
      'INVALID_RESET_TOKEN'
    );
  }

  if (tokenRecord.usedAt) {
    throw new BadRequestError(
      'This password reset link has already been used. Please request a new one.',
      'RESET_TOKEN_USED'
    );
  }

  if (tokenRecord.expiresAt.getTime() <= Date.now()) {
    throw new BadRequestError(
      'This password reset link has expired. Please request a new one.',
      'RESET_TOKEN_EXPIRED'
    );
  }

  if (tokenRecord.user.status !== AccountStatus.ACTIVE) {
    throw new ForbiddenError(
      `Your account has been ${tokenRecord.user.status.toLowerCase()}.`,
      `ACCOUNT_${tokenRecord.user.status}`
    );
  }

  return {
    valid: true,
    expiresInMinutes: PASSWORD_RESET_EXPIRY_MINUTES,
  };
}

/**
 * Atomically consumes a valid single-use reset token, updates the password hash,
 * invalidates all other outstanding reset tokens for the user, and revokes all active sessions.
 */
export async function completePasswordReset(params: {
  rawToken: string;
  newPassword: string;
  ipAddress?: string | null;
}): Promise<{ userId: string; revokedSessions: number; message: string }> {
  const clientIp = (params.ipAddress || 'unknown').trim() || 'unknown';
  const ipHash = hashRateLimitIdentifier(clientIp);

  const submitRate = await checkRedisSlidingWindowRateLimit(
    `${PWRESET_SUBMIT_IP_PREFIX}${ipHash}`,
    PASSWORD_RESET_SUBMIT_IP_MAX,
    PASSWORD_RESET_RATE_LIMIT_WINDOW_MS
  );
  if (!submitRate.allowed) {
    throw new TooManyRequestsError(
      'Too many password reset attempts. Please wait before trying again.',
      'PASSWORD_RESET_RATE_LIMIT',
      submitRate.retryAfterSeconds
    );
  }

  const trimmedToken = params.rawToken.trim();
  if (!trimmedToken) {
    throw new BadRequestError(
      'This password reset link is invalid or has expired. Please request a new one.',
      'INVALID_RESET_TOKEN'
    );
  }

  const passwordEvaluation = evaluatePasswordPolicy(params.newPassword);
  if (!passwordEvaluation.valid) {
    throw new BadRequestError(
      passwordEvaluation.firstError || 'Password does not meet security requirements.',
      'WEAK_PASSWORD'
    );
  }
  if (params.newPassword.length > PASSWORD_MAX_LENGTH) {
    throw new BadRequestError(
      `Password must be at most ${PASSWORD_MAX_LENGTH} characters long.`,
      'PASSWORD_TOO_LONG'
    );
  }

  const tokenHash = hashPasswordResetToken(trimmedToken);
  const newPasswordHash = await bcrypt.hash(params.newPassword, 10);

  const txResult = await prisma.$transaction(async (tx) => {
    const now = new Date();
    const expiredAt = new Date(now.getTime() - 1000);
    const retentionCutoff = new Date(now.getTime() - PASSWORD_RESET_RETENTION_MS);

    // Atomic single-use claim: PostgreSQL row lock serializes concurrent updates so only one succeeds.
    const claimed = await tx.passwordResetToken.updateMany({
      where: {
        tokenHash,
        usedAt: null,
        expiresAt: { gt: now },
      },
      data: {
        usedAt: now,
      },
    });

    if (claimed.count !== 1) {
      const existing = await tx.passwordResetToken.findUnique({
        where: { tokenHash },
        select: {
          usedAt: true,
          expiresAt: true,
        },
      });

      if (existing?.usedAt) {
        throw new BadRequestError(
          'This password reset link has already been used. Please request a new one.',
          'RESET_TOKEN_USED'
        );
      }

      if (existing && existing.expiresAt.getTime() <= now.getTime()) {
        throw new BadRequestError(
          'This password reset link has expired. Please request a new one.',
          'RESET_TOKEN_EXPIRED'
        );
      }

      throw new BadRequestError(
        'This password reset link is invalid or has expired. Please request a new one.',
        'INVALID_RESET_TOKEN'
      );
    }

    const tokenRecord = await tx.passwordResetToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        userId: true,
        user: {
          select: {
            id: true,
            email: true,
            status: true,
          },
        },
      },
    });

    if (!tokenRecord || !tokenRecord.user) {
      throw new BadRequestError(
        'This password reset link is invalid or has expired. Please request a new one.',
        'INVALID_RESET_TOKEN'
      );
    }

    if (tokenRecord.user.status !== AccountStatus.ACTIVE) {
      throw new ForbiddenError(
        `Your account has been ${tokenRecord.user.status.toLowerCase()}.`,
        `ACCOUNT_${tokenRecord.user.status}`
      );
    }

    const updatedUser = await tx.user.update({
      where: { id: tokenRecord.userId },
      data: {
        passwordHash: newPasswordHash,
        passwordChangedAt: now,
        sessionVersion: { increment: 1 },
      },
      select: {
        sessionVersion: true,
      },
    });

    await recordDurableSessionInvalidationTx(tx, tokenRecord.userId, updatedUser.sessionVersion);

    // Invalidate all other outstanding unused reset tokens for this user
    await tx.passwordResetToken.updateMany({
      where: {
        userId: tokenRecord.userId,
        id: { not: tokenRecord.id },
        usedAt: null,
        expiresAt: { gt: now },
      },
      data: {
        expiresAt: expiredAt,
      },
    });

    const pendingOutboxRows = await tx.emailOutbox.findMany({
      where: {
        type: EmailOutboxType.PASSWORD_RESET,
        status: EmailOutboxStatus.PENDING,
        recipientEmail: normalizeEmail(tokenRecord.user.email),
      },
      select: { id: true },
    });

    // Cancel any queued but unsent password-reset outbox messages for this user
    if (pendingOutboxRows.length > 0) {
      await tx.emailOutbox.updateMany({
        where: {
          id: { in: pendingOutboxRows.map((row) => row.id) },
          status: EmailOutboxStatus.PENDING,
        },
        data: {
          status: EmailOutboxStatus.CANCELLED,
          lockedBy: null,
          lockedUntil: null,
          lastErrorCode: 'PASSWORD_RESET_COMPLETED',
          lastErrorMessage: 'Superseded by completed password reset.',
        },
      });
    }

    // Opportunistic cleanup of old expired rows for this user
    await tx.passwordResetToken.deleteMany({
      where: {
        userId: tokenRecord.userId,
        expiresAt: { lt: retentionCutoff },
      },
    });

    return {
      userId: tokenRecord.userId,
      email: tokenRecord.user.email,
      sessionVersion: updatedUser.sessionVersion,
      cancelledOutboxIds: pendingOutboxRows.map((row) => row.id),
    };
  });

  // L-02: Clear Redis delivery secrets for any pending outbox items cancelled during reset
  if (txResult.cancelledOutboxIds.length > 0) {
    try {
      await getRedisClient().del(
        ...txResult.cancelledOutboxIds.map(
          (outboxId) => `${PASSWORD_RESET_DELIVERY_SECRET_PREFIX}${outboxId}`
        )
      );
    } catch {
      // Best-effort cleanup; expired/invalid tokens cannot be dispatched or redeemed
    }
  }

  // M-02: Always record durable in-process floor and best-effort revoke/invalidate Redis sessions
  // independently so post-commit Redis failures cannot leave pre-reset sessions usable.
  let cacheInvalidated = false;
  try {
    await invalidateUserAuthCache(txResult.userId);
    await setCachedUserSessionVersion(txResult.userId, txResult.sessionVersion);
    cacheInvalidated = true;
  } catch (err) {
    const safeMsg = sanitizeEmailLogMessage(err instanceof Error ? err.message : 'Unknown error');
    console.error(
      `[PasswordReset] Post-reset auth cache invalidation failed for user=${txResult.userId}: ${safeMsg}`
    );
  }

  let revokedSessions = 0;
  let sessionsRevoked = false;
  try {
    revokedSessions = await revokeAllUserSessions(txResult.userId);
    sessionsRevoked = true;
  } catch (err) {
    const safeMsg = sanitizeEmailLogMessage(err instanceof Error ? err.message : 'Unknown error');
    console.error(
      `[PasswordReset] Post-reset Redis session revocation failed for user=${txResult.userId}: ${safeMsg}`
    );
  }

  if (!cacheInvalidated || !sessionsRevoked) {
    recordEmergencySessionVersionFloor(txResult.userId, txResult.sessionVersion);
  }

  await recordAdminAuditLog({
    actorUserId: txResult.userId,
    actorEmail: txResult.email,
    action: 'PASSWORD_RESET_COMPLETED_SESSIONS_REVOKED',
    targetType: 'User',
    targetId: txResult.userId,
    metadata: { revokedSessions },
    ipAddress: params.ipAddress ?? null,
  });

  return {
    userId: txResult.userId,
    revokedSessions,
    message: 'Your password has been reset successfully. Please sign in with your new password.',
  };
}
