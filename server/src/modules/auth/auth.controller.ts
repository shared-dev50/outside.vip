import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { Role, AccountStatus } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { env, normalizeEmail, isEmailInAdminAllowlist } from '../../config/env.js';
import {
  registerSchema,
  loginSchema,
  requestLoginOtpSchema,
  verifyLoginOtpSchema,
  verifyEmailSchema,
  resendVerificationSchema,
  updateProfileSchema,
  changePasswordSchema,
  updateUserStatusSchema,
} from './auth.schema.js';
import {
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  ConflictError,
  TooManyRequestsError,
  NotFoundError,
  ServiceUnavailableError,
} from '../../utils/errors.js';
import {
  sendVerificationOtpEmail,
  sendLoginOtpEmail,
  EmailDeliveryResult,
} from '../../lib/email.service.js';
import { recordAdminAuditLog } from '../../lib/auditLogger.js';
import { getRedisClient } from '../../lib/redis.js';
import {
  createSession,
  rotateSession,
  revokeSession,
  revokeAllUserSessions,
  listUserSessions,
  setSessionCookie,
  clearSessionCookie,
  invalidateUserAuthCache,
  getUserAuthCacheVersion,
  populateUserAuthCacheAtomically,
  checkRedisRateLimit,
  checkRedisRateLimitWithRetryAfter,
  checkRedisSlidingWindowRateLimit,
  resetSlidingWindowRateLimitsByPrefixForTests,
  acquireOwnedRedisCooldown,
  releaseOwnedRedisCooldown,
  hashRateLimitIdentifier,
  resolveRotatedSessionUserId,
} from '../../lib/session.service.js';
import { generateStatelessCsrfToken } from '../../middleware/csrf.js';

export const OTP_EXPIRY_MS = 10 * 60 * 1000;
export const RESEND_COOLDOWN_MS = 60 * 1000;
export const MAX_CODE_ATTEMPTS = 5;
export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const MAX_VERIFY_REQUESTS_PER_WINDOW = 8;
export const MAX_RESEND_REQUESTS_PER_WINDOW = 5;
export const MAX_LOGIN_ATTEMPTS_PER_WINDOW = 20;

export const LOGIN_OTP_PREFIX = 'auth_login_otp:';
export const LOGIN_OTP_EXPIRY_MS = 10 * 60 * 1000;
export const LOGIN_OTP_RESEND_COOLDOWN_MS = 60 * 1000;
export const LOGIN_OTP_MAX_ATTEMPTS = 5;
export const LOGIN_OTP_REQUEST_IP_BURST_MAX = 10;
export const LOGIN_OTP_REQUEST_IP_BURST_WINDOW_MS = 60 * 1000;
export const LOGIN_OTP_REQUEST_IP_SUSTAINED_MAX = 30;
export const LOGIN_OTP_REQUEST_EMAIL_MAX = 5;
export const LOGIN_OTP_VERIFY_IP_MAX = 15;
export const LOGIN_OTP_VERIFY_EMAIL_MAX = 8;

const UNIFORM_LOGIN_OTP_REQUEST_MESSAGE =
  'If an eligible passwordless account exists for this email, a 6-digit sign-in code has been sent.';

interface StoredLoginOtpRecord {
  generationId: string;
  codeHash: string;
  issuedAt: number;
  expiresAt: number;
  attempts: number;
}

export function hashLoginOtp(userId: string, code: string): string {
  const secret =
    process.env.SESSION_SECRET?.trim() ||
    env.SESSION_SECRET.trim() ||
    env.JWT_SECRET.trim();
  return crypto
    .createHmac('sha256', secret)
    .update(`login_otp:${userId}:${code.trim()}`)
    .digest('hex');
}

function wrapOtpRedisError(err: unknown): never {
  if (err instanceof ServiceUnavailableError) {
    throw err;
  }
  const message = err instanceof Error ? err.message : 'Unknown Redis error';
  throw new ServiceUnavailableError(
    `Authentication session store is temporarily unavailable (${message}).`,
    'AUTH_STORE_UNAVAILABLE'
  );
}

const OTP_VERIFY_RATE_LIMIT_PREFIX = 'otp_verify:';
const OTP_RESEND_RATE_LIMIT_PREFIX = 'otp_resend:';

export async function resetVerificationRateLimits(): Promise<void> {
  await resetSlidingWindowRateLimitsByPrefixForTests(OTP_VERIFY_RATE_LIMIT_PREFIX);
  await resetSlidingWindowRateLimitsByPrefixForTests(OTP_RESEND_RATE_LIMIT_PREFIX);
}

export function hashVerificationCode(userId: string, code: string): string {
  return crypto
    .createHmac('sha256', env.JWT_SECRET)
    .update(`${userId}:${code.trim()}`)
    .digest('hex');
}

function generateSixDigitOtp(): string {
  return crypto.randomInt(100000, 1000000).toString();
}

function timingSafeHashEquals(aHex: string, bHex: string): boolean {
  const aBuf = Buffer.from(aHex, 'utf8');
  const bBuf = Buffer.from(bHex, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

const USER_PUBLIC_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  status: true,
  emailVerified: true,
  emailVerifiedAt: true,
  avatarUrl: true,
  organizer: true,
} as const;

async function syncUserToAuthCache(user: {
  id: string;
  email: string;
  role: Role;
  emailVerified: boolean;
  status?: AccountStatus;
}): Promise<void> {
  await invalidateUserAuthCache(user.id);
  const ver = await getUserAuthCacheVersion(user.id);
  await populateUserAuthCacheAtomically(
    {
      userId: user.id,
      email: user.email,
      role: user.role,
      emailVerified: user.emailVerified,
      accountStatus: user.status ?? AccountStatus.ACTIVE,
    },
    ver
  );
}

async function issueVerificationCodeForUser(user: {
  id: string;
  email: string;
  name: string;
}): Promise<{ expiresAt: Date; emailDelivery: EmailDeliveryResult }> {
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + OTP_EXPIRY_MS);
  const code = generateSixDigitOtp();
  const codeHash = hashVerificationCode(user.id, code);
  const codeId = crypto.randomUUID();

  // Dispatch email BEFORE invalidating prior valid codes or creating a cooldown row
  // so failed deliveries preserve previously active OTPs and avoid starting the 60s cooldown.
  const emailDelivery = await sendVerificationOtpEmail({
    to: user.email,
    name: user.name,
    code,
    expiresInMinutes: 10,
    idempotencyKey: `otp-verification-${codeId}`,
  });

  const now = new Date();
  await prisma.$transaction([
    prisma.emailVerificationCode.updateMany({
      where: {
        userId: user.id,
        usedAt: null,
        expiresAt: { gt: now },
      },
      data: {
        expiresAt: new Date(now.getTime() - 1000),
      },
    }),
    prisma.emailVerificationCode.create({
      data: {
        id: codeId,
        userId: user.id,
        email: normalizeEmail(user.email),
        codeHash,
        expiresAt,
      },
    }),
  ]);

  return { expiresAt, emailDelivery };
}

export async function getCsrfToken(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const csrfToken = req.session ? req.session.csrfToken : generateStatelessCsrfToken();
    res.setHeader('X-CSRF-Token', csrfToken);
    res.json({
      success: true,
      data: { csrfToken },
    });
  } catch (error) {
    next(error);
  }
}

export async function register(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // Reject any attempt to self-assign ADMIN during registration
    if (
      req.body &&
      typeof req.body.role === 'string' &&
      req.body.role.trim().toUpperCase() === Role.ADMIN
    ) {
      await recordAdminAuditLog({
        actorEmail: typeof req.body.email === 'string' ? req.body.email : 'unknown',
        action: 'BLOCKED_SELF_ADMIN_REGISTRATION',
        targetType: 'User',
        metadata: { requestedRole: req.body.role },
        ipAddress: req.ip,
      });
      throw new ForbiddenError('Users cannot assign themselves the ADMIN role.');
    }

    const input = registerSchema.parse(req.body);
    const normalizedEmail = normalizeEmail(input.email);

    const existingUser = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (existingUser) {
      throw new ConflictError('An account with this email already exists.');
    }

    const passwordHash = await bcrypt.hash(input.password, 10);

    // Every registered user starts with default ATTENDEE functionality, ACTIVE status, and unverified email.
    const user = await prisma.user.create({
      data: {
        email: normalizedEmail,
        passwordHash,
        name: input.name,
        role: Role.ATTENDEE,
        status: AccountStatus.ACTIVE,
        emailVerified: false,
        emailVerifiedAt: null,
        ...(input.organizerDisplayName && {
          organizer: {
            create: {
              displayName: input.organizerDisplayName,
              slug:
                input.organizerDisplayName
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, '-')
                  .replace(/(^-|-$)/g, '') + `-${Date.now().toString(36)}`,
            },
          },
        }),
      },
      select: USER_PUBLIC_SELECT,
    });

    let emailDelivery: EmailDeliveryResult;
    try {
      const issued = await issueVerificationCodeForUser({
        id: user.id,
        email: user.email,
        name: user.name,
      });
      emailDelivery = issued.emailDelivery;
    } catch (deliveryError) {
      // Roll back the newly created account if the initial verification email cannot be sent
      // so the user does not hit a false success or a duplicate-email conflict when retrying.
      await prisma.user.delete({ where: { id: user.id } }).catch(() => { });
      throw deliveryError;
    }

    await syncUserToAuthCache(user);

    // Rotate any pre-existing session and issue a fresh Redis session
    const issuedSession = await rotateSession({
      oldSessionId: req.session?.sessionId ?? null,
      userId: user.id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] || null,
    });

    setSessionCookie(res, issuedSession.rawCookieValue);
    res.setHeader('X-CSRF-Token', issuedSession.csrfToken);

    const activeNodeEnv = process.env.NODE_ENV || env.NODE_ENV;

    res.status(201).json({
      success: true,
      data: {
        user,
        csrfToken: issuedSession.csrfToken,
        ...(activeNodeEnv !== 'production' ? { token: issuedSession.rawCookieValue } : {}),
        verificationRequired: true,
        emailDelivery,
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function verifyEmail(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = verifyEmailSchema.parse(req.body);

    let targetUser: {
      id: string;
      email: string;
      name: string;
      role: Role;
      status: AccountStatus;
      emailVerified: boolean;
      emailVerifiedAt: Date | null;
    } | null = null;

    if (req.user?.userId) {
      targetUser = await prisma.user.findUnique({
        where: { id: req.user.userId },
      });
    } else if (input.email) {
      targetUser = await prisma.user.findUnique({
        where: { email: normalizeEmail(input.email) },
      });
    } else {
      const rotatedUserId = await resolveRotatedSessionUserId(req);
      if (rotatedUserId) {
        targetUser = await prisma.user.findUnique({
          where: { id: rotatedUserId },
        });
      } else {
        throw new UnauthorizedError('Authentication or email address is required to verify email.');
      }
    }

    if (!targetUser) {
      throw new NotFoundError('User account not found.');
    }

    if (targetUser.status !== AccountStatus.ACTIVE) {
      await invalidateUserAuthCache(targetUser.id);
      await revokeAllUserSessions(targetUser.id);
      throw new ForbiddenError(
        `Your account has been ${targetUser.status.toLowerCase()}.`,
        `ACCOUNT_${targetUser.status}`
      );
    }

    const rateKey = `${OTP_VERIFY_RATE_LIMIT_PREFIX}${hashRateLimitIdentifier(targetUser.id)}`;
    const verifyRate = await checkRedisSlidingWindowRateLimit(
      rateKey,
      MAX_VERIFY_REQUESTS_PER_WINDOW,
      RATE_LIMIT_WINDOW_MS
    );
    if (!verifyRate.allowed) {
      throw new TooManyRequestsError(
        'Too many verification attempts. Please wait before trying again.',
        'VERIFICATION_RATE_LIMIT',
        verifyRate.retryAfterSeconds
      );
    }

    const submittedHash = hashVerificationCode(targetUser.id, input.code);
    const now = new Date();

    const previouslyUsedCode = await prisma.emailVerificationCode.findFirst({
      where: {
        userId: targetUser.id,
        codeHash: submittedHash,
        usedAt: { not: null },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (previouslyUsedCode) {
      throw new BadRequestError(
        'This verification code has already been used.',
        'VERIFICATION_CODE_USED'
      );
    }

    const latestCode = await prisma.emailVerificationCode.findFirst({
      where: {
        userId: targetUser.id,
        usedAt: null,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!latestCode) {
      throw new BadRequestError(
        'No active verification code found. Please request a new code.',
        'VERIFICATION_CODE_NOT_FOUND'
      );
    }

    if (latestCode.attempts >= MAX_CODE_ATTEMPTS) {
      throw new TooManyRequestsError(
        'Maximum verification attempts exceeded for this code. Please request a new code.',
        'VERIFICATION_MAX_ATTEMPTS'
      );
    }

    if (latestCode.expiresAt.getTime() <= now.getTime()) {
      throw new BadRequestError(
        'Verification code has expired. Please request a new code.',
        'VERIFICATION_CODE_EXPIRED'
      );
    }

    const isMatch = timingSafeHashEquals(latestCode.codeHash, submittedHash);
    if (!isMatch) {
      const nextAttempts = latestCode.attempts + 1;
      await prisma.emailVerificationCode.update({
        where: { id: latestCode.id },
        data: {
          attempts: nextAttempts,
          ...(nextAttempts >= MAX_CODE_ATTEMPTS ? { expiresAt: new Date(now.getTime() - 1000) } : {}),
        },
      });
      throw new BadRequestError('Invalid verification code.', 'INVALID_VERIFICATION_CODE');
    }

    // Mark code as used and expire any other unused codes for this user
    await prisma.emailVerificationCode.update({
      where: { id: latestCode.id },
      data: { usedAt: now },
    });

    await prisma.emailVerificationCode.updateMany({
      where: {
        userId: targetUser.id,
        id: { not: latestCode.id },
        usedAt: null,
      },
      data: {
        expiresAt: new Date(now.getTime() - 1000),
      },
    });

    // Check if the now-verified email matches ADMIN_EMAILS allowlist
    const shouldProvisionAdmin = isEmailInAdminAllowlist(targetUser.email);
    const nextRole = shouldProvisionAdmin ? Role.ADMIN : targetUser.role;

    const updatedUser = await prisma.user.update({
      where: { id: targetUser.id },
      data: {
        emailVerified: true,
        emailVerifiedAt: targetUser.emailVerifiedAt ?? now,
        role: nextRole,
      },
      select: USER_PUBLIC_SELECT,
    });

    if (shouldProvisionAdmin && targetUser.role !== Role.ADMIN) {
      await recordAdminAuditLog({
        actorUserId: updatedUser.id,
        actorEmail: updatedUser.email,
        action: 'ADMIN_PROVISIONED_FROM_ALLOWLIST',
        targetType: 'User',
        targetId: updatedUser.id,
        metadata: {
          previousRole: targetUser.role,
          newRole: Role.ADMIN,
          trigger: 'email_verification',
        },
        ipAddress: req.ip,
      });
    }

    // Immediately invalidate and update the 30-second Redis User Authorization Cache
    await syncUserToAuthCache(updatedUser);

    // Rotate session ID on email verification / privilege elevation
    const rotatedSession = await rotateSession({
      oldSessionId: req.session?.sessionId ?? null,
      userId: updatedUser.id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] || null,
      preserveLifetime: true,
    });

    setSessionCookie(res, rotatedSession.rawCookieValue);
    res.setHeader('X-CSRF-Token', rotatedSession.csrfToken);

    const activeNodeEnv = process.env.NODE_ENV || env.NODE_ENV;

    res.json({
      success: true,
      data: {
        user: updatedUser,
        csrfToken: rotatedSession.csrfToken,
        ...(activeNodeEnv !== 'production' ? { token: rotatedSession.rawCookieValue } : {}),
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function resendVerification(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const input = resendVerificationSchema.parse(req.body || {});

    let targetUser: {
      id: string;
      email: string;
      name: string;
      emailVerified: boolean;
    } | null = null;

    if (req.user?.userId) {
      targetUser = await prisma.user.findUnique({
        where: { id: req.user.userId },
      });
    } else if (input.email) {
      targetUser = await prisma.user.findUnique({
        where: { email: normalizeEmail(input.email) },
      });
    } else {
      throw new UnauthorizedError('Authentication or email address is required to resend code.');
    }

    if (!targetUser) {
      throw new NotFoundError('User account not found.');
    }

    if (targetUser.emailVerified) {
      throw new BadRequestError('Email address is already verified.', 'EMAIL_ALREADY_VERIFIED');
    }

    const latestCode = await prisma.emailVerificationCode.findFirst({
      where: { userId: targetUser.id },
      orderBy: { createdAt: 'desc' },
    });

    const now = Date.now();
    if (latestCode && now - latestCode.createdAt.getTime() < RESEND_COOLDOWN_MS) {
      const retryAfterSeconds = Math.ceil(
        (RESEND_COOLDOWN_MS - (now - latestCode.createdAt.getTime())) / 1000
      );
      throw new TooManyRequestsError(
        `Please wait ${retryAfterSeconds} seconds before requesting another verification code.`,
        'VERIFICATION_RESEND_COOLDOWN'
      );
    }

    const rateKey = `${OTP_RESEND_RATE_LIMIT_PREFIX}${hashRateLimitIdentifier(targetUser.id)}`;
    const resendRate = await checkRedisSlidingWindowRateLimit(
      rateKey,
      MAX_RESEND_REQUESTS_PER_WINDOW,
      RATE_LIMIT_WINDOW_MS
    );
    if (!resendRate.allowed) {
      throw new TooManyRequestsError(
        'Too many verification code requests. Please try again later.',
        'VERIFICATION_RESEND_RATE_LIMIT',
        resendRate.retryAfterSeconds
      );
    }

    const { expiresAt, emailDelivery } = await issueVerificationCodeForUser({
      id: targetUser.id,
      email: targetUser.email,
      name: targetUser.name,
    });

    res.json({
      success: true,
      data: {
        message: 'A new 6-digit verification code has been sent to your email.',
        expiresAt,
        cooldownSeconds: Math.floor(RESEND_COOLDOWN_MS / 1000),
        emailDelivery,
      },
    });
  } catch (error) {
    next(error);
  }
}

const DEMO_SEED_EMAILS = new Set(['sol@outside.vip', 'alex@outside.vip', 'admin@outside.vip']);
const EXPOSED_DEMO_PASSWORD = 'Outside2026!';

export async function forbidDemoAuth(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    await recordAdminAuditLog({
      actorUserId: req.user?.userId ?? null,
      actorEmail:
        req.user?.email ||
        (typeof req.body?.email === 'string' ? req.body.email : 'anonymous'),
      action: 'BLOCKED_DEMO_AUTH_ATTEMPT',
      targetType: 'Auth',
      metadata: {
        path: req.originalUrl,
        method: req.method,
      },
      ipAddress: req.ip,
    });
    throw new ForbiddenError('Demo authentication is disabled.', 'DEMO_AUTH_DISABLED');
  } catch (error) {
    next(error);
  }
}

export async function login(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (
      req.body &&
      (req.body.demo !== undefined ||
        req.body.demoRole !== undefined ||
        req.body.quickLogin !== undefined ||
        req.body.isDemo !== undefined ||
        req.headers['x-demo-auth'] !== undefined)
    ) {
      await recordAdminAuditLog({
        actorEmail: typeof req.body.email === 'string' ? req.body.email : 'anonymous',
        action: 'BLOCKED_DEMO_AUTH_ATTEMPT',
        targetType: 'Auth',
        metadata: {
          demoRole: req.body.demoRole ?? req.body.quickLogin ?? true,
        },
        ipAddress: req.ip,
      });
      throw new ForbiddenError('Demo authentication is disabled.', 'DEMO_AUTH_DISABLED');
    }

    const input = loginSchema.parse(req.body);
    const normalizedEmail = normalizeEmail(input.email);

    const activeNodeEnv = process.env.NODE_ENV || env.NODE_ENV;
    if (
      activeNodeEnv === 'production' &&
      DEMO_SEED_EMAILS.has(normalizedEmail) &&
      input.password === EXPOSED_DEMO_PASSWORD
    ) {
      await recordAdminAuditLog({
        actorEmail: normalizedEmail,
        action: 'BLOCKED_PRODUCTION_DEMO_CREDENTIAL_LOGIN',
        targetType: 'User',
        metadata: {
          email: normalizedEmail,
        },
        ipAddress: req.ip,
      });
      throw new ForbiddenError(
        'Demo authentication is disabled in production.',
        'DEMO_AUTH_DISABLED'
      );
    }

    const loginRateAllowed = await checkRedisRateLimit(
      `login:${normalizedEmail}:${req.ip || 'unknown'}`,
      MAX_LOGIN_ATTEMPTS_PER_WINDOW,
      RATE_LIMIT_WINDOW_MS
    );
    if (!loginRateAllowed) {
      throw new TooManyRequestsError(
        'Too many sign-in attempts. Please wait before trying again.',
        'LOGIN_RATE_LIMIT'
      );
    }

    let user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      include: {
        organizer: true,
      },
    });

    if (!user) {
      throw new UnauthorizedError('Invalid email or password.');
    }

    if (!user.passwordHash) {
      throw new UnauthorizedError('Invalid email or password.');
    }

    const isValidPassword = await bcrypt.compare(input.password, user.passwordHash);
    if (!isValidPassword) {
      throw new UnauthorizedError('Invalid email or password.');
    }

    if (user.status !== AccountStatus.ACTIVE) {
      await invalidateUserAuthCache(user.id);
      await revokeAllUserSessions(user.id);
      clearSessionCookie(res);
      throw new ForbiddenError(
        `Your account has been ${user.status.toLowerCase()}.`,
        `ACCOUNT_${user.status}`
      );
    }

    // Only verified email addresses matching ADMIN_EMAILS can be provisioned as ADMIN
    if (user.emailVerified && isEmailInAdminAllowlist(user.email) && user.role !== Role.ADMIN) {
      const previousRole = user.role;
      user = await prisma.user.update({
        where: { id: user.id },
        data: { role: Role.ADMIN },
        include: { organizer: true },
      });
      await recordAdminAuditLog({
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'ADMIN_PROVISIONED_FROM_ALLOWLIST',
        targetType: 'User',
        targetId: user.id,
        metadata: {
          previousRole,
          newRole: Role.ADMIN,
          trigger: 'login',
        },
        ipAddress: req.ip,
      });
    }

    // Immediately sync the 30-second Redis User Authorization Cache
    await syncUserToAuthCache(user);

    // Rotate any existing session ID on login and create a new Redis session
    const issuedSession = await rotateSession({
      oldSessionId: req.session?.sessionId ?? null,
      userId: user.id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] || null,
    });

    setSessionCookie(res, issuedSession.rawCookieValue);
    res.setHeader('X-CSRF-Token', issuedSession.csrfToken);

    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          status: user.status,
          emailVerified: user.emailVerified,
          emailVerifiedAt: user.emailVerifiedAt,
          avatarUrl: user.avatarUrl,
          organizer: user.organizer,
        },
        csrfToken: issuedSession.csrfToken,
        ...(activeNodeEnv !== 'production' ? { token: issuedSession.rawCookieValue } : {}),
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Standalone passwordless email-OTP sign-in request.
 * Strictly restricted to existing ACTIVE passwordless accounts (`passwordHash === null`).
 * Uses ownership-tagged cooldown and atomic Redis Lua rollback without holding a short-lived
 * mutex across external email I/O. Returns a uniform public response to prevent enumeration.
 */
export async function requestLoginOtp(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const input = requestLoginOtpSchema.parse(req.body);
    const normalizedEmail = normalizeEmail(input.email);
    const clientIp = req.ip || req.socket?.remoteAddress || 'unknown';
    const ipHash = hashRateLimitIdentifier(clientIp);
    const emailHash = hashRateLimitIdentifier(normalizedEmail);

    // 1. Enforce IP burst limit first to block raw floods before touching cooldown/email quotas
    const ipBurst = await checkRedisRateLimitWithRetryAfter(
      `auth_otp_req_ip_burst:${ipHash}`,
      LOGIN_OTP_REQUEST_IP_BURST_MAX,
      LOGIN_OTP_REQUEST_IP_BURST_WINDOW_MS
    );
    if (!ipBurst.allowed) {
      throw new TooManyRequestsError(
        'Too many sign-in code requests. Please wait before trying again.',
        'OTP_RATE_LIMIT',
        ipBurst.retryAfterSeconds
      );
    }

    // 2. Enforce uniform 60-second ownership-tagged cooldown keyed by hashed email BEFORE
    // 15-minute quota increments and BEFORE user lookup so:
    //   a) repeated cooldown retries do not exhaust the 15-minute email quota,
    //   b) concurrent duplicate requests are serialized uniformly across all emails, and
    //   c) cooldown timing cannot act as an account-enumeration oracle.
    const cooldownKey = `auth_login_otp:${emailHash}`;
    const cooldown = await acquireOwnedRedisCooldown(cooldownKey, LOGIN_OTP_RESEND_COOLDOWN_MS);
    if (!cooldown.allowed) {
      throw new TooManyRequestsError(
        `Please wait ${cooldown.retryAfterSeconds} seconds before requesting another sign-in code.`,
        'OTP_RESEND_COOLDOWN',
        cooldown.retryAfterSeconds
      );
    }

    // 3. Enforce sustained IP and normalized-email rate limits; release owned cooldown on reject
    let ipSustained;
    try {
      ipSustained = await checkRedisRateLimitWithRetryAfter(
        `auth_otp_req_ip:${ipHash}`,
        LOGIN_OTP_REQUEST_IP_SUSTAINED_MAX,
        RATE_LIMIT_WINDOW_MS
      );
    } catch (err) {
      await releaseOwnedRedisCooldown(cooldownKey, cooldown.ownerToken);
      throw err;
    }
    if (!ipSustained.allowed) {
      await releaseOwnedRedisCooldown(cooldownKey, cooldown.ownerToken);
      throw new TooManyRequestsError(
        'Too many sign-in code requests. Please wait before trying again.',
        'OTP_RATE_LIMIT',
        ipSustained.retryAfterSeconds
      );
    }

    let emailRate;
    try {
      emailRate = await checkRedisRateLimitWithRetryAfter(
        `auth_otp_req_email:${emailHash}`,
        LOGIN_OTP_REQUEST_EMAIL_MAX,
        RATE_LIMIT_WINDOW_MS
      );
    } catch (err) {
      await releaseOwnedRedisCooldown(cooldownKey, cooldown.ownerToken);
      throw err;
    }
    if (!emailRate.allowed) {
      await releaseOwnedRedisCooldown(cooldownKey, cooldown.ownerToken);
      throw new TooManyRequestsError(
        'Too many sign-in code requests for this email. Please wait before trying again.',
        'OTP_RATE_LIMIT',
        emailRate.retryAfterSeconds
      );
    }

    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: {
        id: true,
        email: true,
        name: true,
        passwordHash: true,
        status: true,
      },
    });

    const uniformResponse = {
      success: true,
      data: {
        message: UNIFORM_LOGIN_OTP_REQUEST_MESSAGE,
        cooldownSeconds: Math.floor(LOGIN_OTP_RESEND_COOLDOWN_MS / 1000),
        expiresInMinutes: Math.floor(LOGIN_OTP_EXPIRY_MS / 60_000),
      },
    };

    // Policy: Standalone OTP login is strictly limited to existing ACTIVE passwordless accounts.
    // Nonexistent, password-based, suspended, and disabled accounts receive the exact same response
    // without issuing or storing an OTP.
    if (!user || user.passwordHash !== null || user.status !== AccountStatus.ACTIVE) {
      res.json(uniformResponse);
      return;
    }

    const redis = getRedisClient();
    const otpKey = `${LOGIN_OTP_PREFIX}${user.id}`;
    const generationId = crypto.randomUUID();
    const now = Date.now();
    const code = generateSixDigitOtp();
    const codeHash = hashLoginOtp(user.id, code);
    const record: StoredLoginOtpRecord = {
      generationId,
      codeHash,
      issuedAt: now,
      expiresAt: now + LOGIN_OTP_EXPIRY_MS,
      attempts: 0,
    };

    // Atomically write the new OTP generation and capture any prior record without holding a mutex
    let priorRaw: string | null = null;
    try {
      priorRaw = await redis.setLoginOtpReturningPrior(
        otpKey,
        JSON.stringify(record),
        LOGIN_OTP_EXPIRY_MS
      );
    } catch (err) {
      await releaseOwnedRedisCooldown(cooldownKey, cooldown.ownerToken);
      wrapOtpRedisError(err);
    }

    try {
      await sendLoginOtpEmail({
        to: user.email,
        name: user.name,
        code,
        expiresInMinutes: Math.floor(LOGIN_OTP_EXPIRY_MS / 60_000),
        idempotencyKey: `login-otp-${user.id}-${generationId}`,
      });
    } catch {
      // Ownership-aware atomic rollback: only restores unexpired prior OTP or deletes otpKey
      // if otpKey still holds this exact generationId; never overwrites a competing update
      // and never resurrects a consumed, expired, or attempt-exhausted OTP.
      try {
        await redis.rollbackLoginOtpIfMatches(
          otpKey,
          generationId,
          priorRaw,
          Date.now(),
          LOGIN_OTP_MAX_ATTEMPTS
        );
      } catch {
        // Best-effort rollback on Redis outage
      }
      await releaseOwnedRedisCooldown(cooldownKey, cooldown.ownerToken);
      throw new ServiceUnavailableError(
        'Unable to deliver sign-in code email. Please try again.',
        'EMAIL_DELIVERY_FAILED'
      );
    }

    res.json(uniformResponse);
  } catch (error) {
    next(error);
  }
}

/**
 * Verifies a standalone 6-digit login OTP for an existing ACTIVE passwordless account.
 * Uses an atomic Redis Lua operation for expiry, 5-attempt lockout, full-length byte-by-byte
 * hash comparison (which avoids early-exit short-circuiting but does not guarantee hardware-level
 * constant-time execution inside the Redis Lua VM; the in-memory adapter uses `crypto.timingSafeEqual`),
 * and exact-once single-use consumption—eliminating mutex expiry races and lock-contention
 * enumeration oracles. DB verification, auth cache sync, and session rotation run outside Redis locks.
 */
export async function verifyLoginOtp(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const input = verifyLoginOtpSchema.parse(req.body);
    const normalizedEmail = normalizeEmail(input.email);
    const clientIp = req.ip || req.socket?.remoteAddress || 'unknown';
    const ipHash = hashRateLimitIdentifier(clientIp);
    const emailHash = hashRateLimitIdentifier(normalizedEmail);

    // 1. Enforce Redis-backed IP and normalized-email verification rate limits (fail closed)
    const ipRate = await checkRedisRateLimitWithRetryAfter(
      `auth_otp_ver_ip:${ipHash}`,
      LOGIN_OTP_VERIFY_IP_MAX,
      RATE_LIMIT_WINDOW_MS
    );
    if (!ipRate.allowed) {
      throw new TooManyRequestsError(
        'Too many verification attempts. Please wait before trying again.',
        'VERIFICATION_RATE_LIMIT',
        ipRate.retryAfterSeconds
      );
    }

    const emailRate = await checkRedisRateLimitWithRetryAfter(
      `auth_otp_ver_email:${emailHash}`,
      LOGIN_OTP_VERIFY_EMAIL_MAX,
      RATE_LIMIT_WINDOW_MS
    );
    if (!emailRate.allowed) {
      throw new TooManyRequestsError(
        'Too many verification attempts. Please wait before trying again.',
        'VERIFICATION_RATE_LIMIT',
        emailRate.retryAfterSeconds
      );
    }

    // 2. Resolve existing user by normalized email (never creates duplicate accounts)
    let user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      include: {
        organizer: true,
      },
    });

    if (!user || user.passwordHash !== null) {
      throw new BadRequestError(
        'Invalid or expired sign-in code. Please request a new code.',
        'INVALID_OTP_CODE'
      );
    }

    const redis = getRedisClient();
    const otpKey = `${LOGIN_OTP_PREFIX}${user.id}`;
    const submittedHash = hashLoginOtp(user.id, input.code);

    // 3. Atomic Redis Lua verify-and-consume (exact-once consumption, atomic 5-attempt cap & expiry)
    let verifyOutcome;
    try {
      verifyOutcome = await redis.verifyAndConsumeLoginOtp(
        otpKey,
        submittedHash,
        Date.now(),
        LOGIN_OTP_MAX_ATTEMPTS
      );
    } catch (err) {
      wrapOtpRedisError(err);
    }

    if (verifyOutcome.status === 'NOT_FOUND') {
      throw new BadRequestError(
        'Invalid or expired sign-in code. Please request a new code.',
        'INVALID_OTP_CODE'
      );
    }

    if (verifyOutcome.status === 'EXPIRED') {
      throw new BadRequestError(
        'Sign-in code has expired. Please request a new code.',
        'OTP_EXPIRED'
      );
    }

    if (verifyOutcome.status === 'MAX_ATTEMPTS') {
      throw new TooManyRequestsError(
        'Maximum verification attempts exceeded. Please request a new code.',
        'OTP_MAX_ATTEMPTS'
      );
    }

    if (verifyOutcome.status === 'INVALID') {
      throw new BadRequestError('Invalid verification code.', 'INVALID_OTP_CODE');
    }

    // 4. Re-confirm authoritative DB state before session issuance (OTP is already consumed)
    const freshUser = await prisma.user.findUnique({
      where: { id: user.id },
      include: {
        organizer: true,
      },
    });

    if (!freshUser || freshUser.passwordHash !== null) {
      throw new BadRequestError(
        'Invalid or expired sign-in code. Please request a new code.',
        'INVALID_OTP_CODE'
      );
    }

    if (freshUser.status !== AccountStatus.ACTIVE) {
      await invalidateUserAuthCache(freshUser.id);
      await revokeAllUserSessions(freshUser.id);
      clearSessionCookie(res);
      throw new ForbiddenError(
        `Your account has been ${freshUser.status.toLowerCase()}.`,
        `ACCOUNT_${freshUser.status}`
      );
    }

    if (freshUser.emailVerified !== true) {
      user = await prisma.user.update({
        where: { id: freshUser.id },
        data: {
          emailVerified: true,
          emailVerifiedAt: freshUser.emailVerifiedAt ?? new Date(),
        },
        include: {
          organizer: true,
        },
      });
    } else {
      user = freshUser;
    }

    // 5. Synchronize user authorization cache and rotate Redis session
    await syncUserToAuthCache(user);

    const issuedSession = await rotateSession({
      oldSessionId: req.session?.sessionId ?? null,
      userId: user.id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] || null,
    });

    setSessionCookie(res, issuedSession.rawCookieValue);
    res.setHeader('X-CSRF-Token', issuedSession.csrfToken);

    const activeNodeEnv = process.env.NODE_ENV || env.NODE_ENV;

    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          status: user.status,
          emailVerified: user.emailVerified,
          emailVerifiedAt: user.emailVerifiedAt,
          avatarUrl: user.avatarUrl,
          organizer: user.organizer,
        },
        csrfToken: issuedSession.csrfToken,
        ...(activeNodeEnv !== 'production' ? { token: issuedSession.rawCookieValue } : {}),
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function logout(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (req.session) {
      await revokeSession(req.session.sessionId, req.session.userId);
    }
    clearSessionCookie(res);

    res.json({
      success: true,
      data: {
        message: 'Signed out and invalidated session.',
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function logoutAll(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new UnauthorizedError('Not authenticated');
    }

    const revokedCount = await revokeAllUserSessions(req.user.userId);
    clearSessionCookie(res);

    res.json({
      success: true,
      data: {
        revokedCount,
        message: 'All active sessions have been revoked.',
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function listSessions(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new UnauthorizedError('Not authenticated');
    }

    const sessions = await listUserSessions(req.user.userId);
    res.json({
      success: true,
      data: {
        currentSessionId: req.session?.sessionId ?? null,
        sessions,
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function revokeSessionById(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user) {
      throw new UnauthorizedError('Not authenticated');
    }

    const targetSessionId = req.params.sessionId;
    if (!targetSessionId) {
      throw new BadRequestError('Session ID is required.');
    }

    const userSessions = await listUserSessions(req.user.userId);
    const ownsSession = userSessions.some((s) => s.sessionId === targetSessionId);
    if (!ownsSession) {
      throw new NotFoundError('Session not found for this account.');
    }

    await revokeSession(targetSessionId, req.user.userId);

    if (req.session?.sessionId === targetSessionId) {
      clearSessionCookie(res);
    }

    res.json({
      success: true,
      data: {
        revokedSessionId: targetSessionId,
        message: 'Session revoked.',
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function changePassword(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user) {
      throw new UnauthorizedError('Not authenticated');
    }

    const input = changePasswordSchema.parse(req.body);

    const dbUser = await prisma.user.findUnique({
      where: { id: req.user.userId },
    });

    if (!dbUser) {
      throw new UnauthorizedError('User account not found');
    }

    if (!dbUser.passwordHash) {
      throw new BadRequestError('This account does not have a password set.', 'NO_PASSWORD_SET');
    }

    const isCurrentValid = await bcrypt.compare(input.currentPassword, dbUser.passwordHash);
    if (!isCurrentValid) {
      throw new UnauthorizedError('Current password is incorrect.', 'INVALID_CURRENT_PASSWORD');
    }

    const newPasswordHash = await bcrypt.hash(input.newPassword, 10);
    await prisma.user.update({
      where: { id: dbUser.id },
      data: { passwordHash: newPasswordHash },
    });

    // Immediately invalidate Redis user cache and revoke all existing sessions
    await invalidateUserAuthCache(dbUser.id);
    await revokeAllUserSessions(dbUser.id);

    // Issue a fresh rotated session for the active client
    const newSession = await createSession({
      userId: dbUser.id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] || null,
    });
    await syncUserToAuthCache(dbUser);

    setSessionCookie(res, newSession.rawCookieValue);
    res.setHeader('X-CSRF-Token', newSession.csrfToken);

    await recordAdminAuditLog({
      actorUserId: dbUser.id,
      actorEmail: dbUser.email,
      action: 'PASSWORD_CHANGED_SESSIONS_REVOKED',
      targetType: 'User',
      targetId: dbUser.id,
      ipAddress: req.ip,
    });

    const activeNodeEnv = process.env.NODE_ENV || env.NODE_ENV;

    res.json({
      success: true,
      data: {
        message: 'Password updated and all previous sessions have been revoked.',
        csrfToken: newSession.csrfToken,
        ...(activeNodeEnv !== 'production' ? { token: newSession.rawCookieValue } : {}),
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function updateUserStatus(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user) {
      throw new UnauthorizedError('Not authenticated');
    }

    const targetUserId = req.params.id;
    if (!targetUserId) {
      throw new BadRequestError('Target user ID is required.');
    }

    if (targetUserId === req.user.userId) {
      throw new BadRequestError('Administrators cannot suspend or disable their own account.');
    }

    const input = updateUserStatusSchema.parse(req.body);
    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId },
    });

    if (!targetUser) {
      throw new NotFoundError('Target user account not found.');
    }

    const updatedUser = await prisma.user.update({
      where: { id: targetUserId },
      data: {
        status: input.status as AccountStatus,
      },
      select: USER_PUBLIC_SELECT,
    });

    // Immediately invalidate the Redis user authorization cache
    await invalidateUserAuthCache(targetUserId);

    // If account is suspended or disabled, immediately revoke all active sessions
    let revokedSessions = 0;
    if (updatedUser.status !== AccountStatus.ACTIVE) {
      revokedSessions = await revokeAllUserSessions(targetUserId);
    } else {
      await syncUserToAuthCache(updatedUser);
    }

    await recordAdminAuditLog({
      actorUserId: req.user.userId,
      actorEmail: req.user.email || 'admin',
      action: 'USER_ACCOUNT_STATUS_CHANGED',
      targetType: 'User',
      targetId: targetUserId,
      metadata: {
        previousStatus: targetUser.status,
        newStatus: updatedUser.status,
        reason: input.reason ?? null,
        revokedSessions,
      },
      ipAddress: req.ip,
    });

    res.json({
      success: true,
      data: {
        user: updatedUser,
        revokedSessions,
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function getCurrentUser(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user) {
      throw new UnauthorizedError('Not authenticated');
    }

    let user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: USER_PUBLIC_SELECT,
    });

    if (!user) {
      await invalidateUserAuthCache(req.user.userId);
      await revokeAllUserSessions(req.user.userId);
      clearSessionCookie(res);
      throw new UnauthorizedError('User account not found');
    }

    if (user.status !== AccountStatus.ACTIVE) {
      await invalidateUserAuthCache(user.id);
      await revokeAllUserSessions(user.id);
      clearSessionCookie(res);
      throw new ForbiddenError(
        `Your account has been ${user.status.toLowerCase()}.`,
        `ACCOUNT_${user.status}`
      );
    }

    let activeCsrfToken = req.session?.csrfToken;

    if (user.emailVerified && isEmailInAdminAllowlist(user.email) && user.role !== Role.ADMIN) {
      const previousRole = user.role;
      user = await prisma.user.update({
        where: { id: user.id },
        data: { role: Role.ADMIN },
        select: USER_PUBLIC_SELECT,
      });
      await recordAdminAuditLog({
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'ADMIN_PROVISIONED_FROM_ALLOWLIST',
        targetType: 'User',
        targetId: user.id,
        metadata: {
          previousRole,
          newRole: Role.ADMIN,
          trigger: 'get_current_user',
        },
        ipAddress: req.ip,
      });

      // Immediately invalidate cache and rotate session ID on privilege elevation
      await syncUserToAuthCache(user);
      if (req.session) {
        const rotated = await rotateSession({
          oldSessionId: req.session.sessionId,
          userId: user.id,
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'] || null,
          preserveLifetime: true,
        });
        setSessionCookie(res, rotated.rawCookieValue);
        activeCsrfToken = rotated.csrfToken;
      }
    } else {
      await syncUserToAuthCache(user);
    }

    if (activeCsrfToken) {
      res.setHeader('X-CSRF-Token', activeCsrfToken);
    }

    res.json({
      success: true,
      data: {
        user,
        ...(activeCsrfToken ? { csrfToken: activeCsrfToken } : {}),
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function updateProfile(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user) {
      throw new UnauthorizedError('Not authenticated');
    }

    if (
      req.body &&
      (req.body.role !== undefined ||
        req.body.status !== undefined ||
        req.body.emailVerified !== undefined ||
        req.body.emailVerifiedAt !== undefined)
    ) {
      await recordAdminAuditLog({
        actorUserId: req.user.userId,
        actorEmail: req.user.email,
        action: 'BLOCKED_PROFILE_PRIVILEGE_ESCALATION',
        targetType: 'User',
        targetId: req.user.userId,
        metadata: {
          attemptedRole: req.body.role,
          attemptedStatus: req.body.status,
          attemptedEmailVerified: req.body.emailVerified,
        },
        ipAddress: req.ip,
      });
      throw new ForbiddenError('Users cannot modify role, status, or email verification status.');
    }

    const input = updateProfileSchema.parse(req.body);

    const updatedUser = await prisma.user.update({
      where: { id: req.user.userId },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.avatarUrl !== undefined && { avatarUrl: input.avatarUrl }),
      },
      select: USER_PUBLIC_SELECT,
    });

    res.json({
      success: true,
      data: { user: updatedUser },
    });
  } catch (error) {
    next(error);
  }
}

export async function forbidRolePromotion(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user) {
      throw new UnauthorizedError('Not authenticated');
    }

    await recordAdminAuditLog({
      actorUserId: req.user.userId,
      actorEmail: req.user.email,
      action: 'BLOCKED_ROLE_PROMOTION_ATTEMPT',
      targetType: 'User',
      targetId: req.params.id || req.body?.userId || req.user.userId,
      metadata: {
        actorRole: req.user.role,
        requestedRole: req.body?.role,
      },
      ipAddress: req.ip,
    });

    throw new ForbiddenError(
      'Administrator privileges are managed strictly via the backend ADMIN_EMAILS allowlist and cannot be granted via API.'
    );
  } catch (error) {
    next(error);
  }
}
