import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { Role, AccountStatus } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { env, normalizeEmail } from '../../config/env.js';
import { getRedisClient } from '../../lib/redis.js';
import {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
  TooManyRequestsError,
  UnauthorizedError,
  ServiceUnavailableError,
  AppError,
} from '../../utils/errors.js';
import {
  checkRedisRateLimit,
  rotateSession,
  revokeAllUserSessions,
  setSessionCookie,
  clearSessionCookie,
  invalidateUserAuthCache,
  getUserAuthCacheVersion,
  populateUserAuthCacheAtomically,
} from '../../lib/session.service.js';
import { sendStaffOtpEmail } from '../../lib/email.service.js';
import {
  invitationTokenParamSchema,
  verifyStaffOtpSchema,
} from './staff.schema.js';

const OTP_EXPIRY_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const MAX_VERIFY_REQUESTS_PER_WINDOW = 8;
const MAX_OTP_REQUESTS_PER_WINDOW = 5;
const MAX_METADATA_REQUESTS_PER_WINDOW = 60;

function maskEmail(email: string): string {
  const atIndex = email.indexOf('@');
  if (atIndex <= 0) return '***';
  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex);
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}***${domain}`;
}

function timingSafeHashEquals(aHex: string, bHex: string): boolean {
  const aBuf = Buffer.from(aHex, 'utf8');
  const bBuf = Buffer.from(bHex, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function hashStaffOtp(invitationId: string, code: string): string {
  const secret = env.SESSION_SECRET || env.JWT_SECRET;
  return crypto
    .createHmac('sha256', secret)
    .update(`${invitationId}:${code.trim()}`)
    .digest('hex');
}

export async function getInvitationMetadata(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { token } = invitationTokenParamSchema.parse(req.params);
    const ip = req.ip || 'unknown';

    const isRateAllowed = await checkRedisRateLimit(
      `staff_meta:${ip}`,
      MAX_METADATA_REQUESTS_PER_WINDOW,
      RATE_LIMIT_WINDOW_MS
    );
    if (!isRateAllowed) {
      throw new TooManyRequestsError(
        'Too many invitation requests. Please wait before trying again.',
        'RATE_LIMIT_EXCEEDED'
      );
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const invitation = await prisma.eventStaffInvitation.findUnique({
      where: { tokenHash },
      include: {
        event: {
          select: {
            id: true,
            title: true,
            slug: true,
            startAt: true,
            endAt: true,
            venueName: true,
            city: true,
            country: true,
            organizer: {
              select: {
                name: true,
                organizer: {
                  select: {
                    displayName: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!invitation) {
      throw new NotFoundError('Invitation not found', 'INVITATION_NOT_FOUND');
    }

    if (invitation.status === 'REVOKED') {
      throw new ForbiddenError(
        'This invitation has been revoked by the event organizer.',
        'INVITATION_REVOKED'
      );
    }

    const now = new Date();
    if (invitation.status === 'PENDING' && invitation.expiresAt.getTime() <= now.getTime()) {
      throw new AppError('This invitation has expired.', 410, true, 'INVITATION_EXPIRED');
    }

    const existingUser = await prisma.user.findUnique({
      where: { email: normalizeEmail(invitation.email) },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        status: true,
      },
    });

    // Check existing EventStaff assignment for accepted invitations
    let staffAssignment: { id: string; status: string } | null = null;
    if (existingUser) {
      staffAssignment = await prisma.eventStaff.findUnique({
        where: {
          eventId_userId: {
            eventId: invitation.eventId,
            userId: existingUser.id,
          },
        },
        select: {
          id: true,
          status: true,
        },
      });
    }

    const isAssignmentActive = invitation.status === 'ACCEPTED'
      ? staffAssignment?.status === 'ACTIVE'
      : true;

    const isAccountActive = !existingUser || existingUser.status === AccountStatus.ACTIVE;
    const hasPassword = Boolean(existingUser && existingUser.passwordHash !== null);
    const currentSessionUser = req.user;
    const isCurrentAccount = Boolean(
      currentSessionUser &&
        normalizeEmail(currentSessionUser.email) === normalizeEmail(invitation.email)
    );
    const requiresLogin = hasPassword && !isCurrentAccount;
    const canResumeSession =
      invitation.status === 'ACCEPTED' &&
      !hasPassword &&
      !isCurrentAccount &&
      isAssignmentActive &&
      isAccountActive;

    res.json({
      success: true,
      data: {
        invitation: {
          id: invitation.id,
          status: invitation.status,
          expiresAt: invitation.expiresAt,
          maskedEmail: maskEmail(invitation.email),
          hasPassword,
          requiresLogin,
          isCurrentAccount,
          isAssignmentActive,
          canResumeSession,
        },
        event: {
          id: invitation.event.id,
          title: invitation.event.title,
          slug: invitation.event.slug,
          startAt: invitation.event.startAt,
          endAt: invitation.event.endAt,
          venueName: invitation.event.venueName,
          city: invitation.event.city,
          country: invitation.event.country,
          organizerName:
            invitation.event.organizer?.organizer?.displayName ||
            invitation.event.organizer?.name ||
            'The event organizer',
        },
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function requestInvitationOtp(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { token } = invitationTokenParamSchema.parse(req.params);
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  const invitation = await prisma.eventStaffInvitation.findUnique({
    where: { tokenHash },
    include: {
      event: {
        select: {
          id: true,
          title: true,
        },
      },
    },
  });

  if (!invitation) {
    throw new NotFoundError('Invitation not found', 'INVITATION_NOT_FOUND');
  }

  if (invitation.status === 'REVOKED') {
    throw new ForbiddenError(
      'This invitation has been revoked by the event organizer.',
      'INVITATION_REVOKED'
    );
  }

  const now = Date.now();
  if (invitation.status === 'EXPIRED' || invitation.expiresAt.getTime() <= now) {
    throw new AppError('This invitation has expired.', 410, true, 'INVITATION_EXPIRED');
  }

  const existingUser = await prisma.user.findUnique({
    where: { email: normalizeEmail(invitation.email) },
    select: { id: true, email: true, passwordHash: true, status: true },
  });

  if (existingUser && existingUser.status !== AccountStatus.ACTIVE) {
    await invalidateUserAuthCache(existingUser.id);
    await revokeAllUserSessions(existingUser.id);
    throw new ForbiddenError(
      `Your account has been ${String(existingUser.status || 'disabled').toLowerCase()}.`,
      `ACCOUNT_${existingUser.status || 'DISABLED'}`
    );
  }

  if (existingUser && existingUser.passwordHash !== null) {
    throw new BadRequestError(
      'This account has a password set. Please sign in with your password to accept this invitation.',
      'PASSWORD_LOGIN_REQUIRED'
    );
  }

  if (invitation.status === 'ACCEPTED') {
    if (!existingUser) {
      throw new NotFoundError('User account not found', 'USER_NOT_FOUND');
    }

    const staffAssignment = await prisma.eventStaff.findUnique({
      where: {
        eventId_userId: {
          eventId: invitation.eventId,
          userId: existingUser.id,
        },
      },
      select: { id: true, status: true },
    });

    if (!staffAssignment || staffAssignment.status !== 'ACTIVE') {
      throw new ForbiddenError(
        'Your staff assignment for this event is no longer active.',
        'STAFF_ASSIGNMENT_NOT_ACTIVE'
      );
    }
  }

  const ip = req.ip || 'unknown';
  const ipRateAllowed = await checkRedisRateLimit(
    `staff_otp_ip:${ip}`,
    MAX_OTP_REQUESTS_PER_WINDOW * 2,
    RATE_LIMIT_WINDOW_MS
  );
  const inviteRateAllowed = await checkRedisRateLimit(
    `staff_otp_invite:${invitation.id}`,
    MAX_OTP_REQUESTS_PER_WINDOW,
    RATE_LIMIT_WINDOW_MS
  );

  if (!ipRateAllowed || !inviteRateAllowed) {
    throw new TooManyRequestsError(
      'Too many verification code requests. Please try again later.',
      'OTP_RATE_LIMIT'
    );
  }

  const redis = getRedisClient();
  const lockId = crypto.randomUUID();
  const lockKey = `lock:invitation_otp:${invitation.id}`;
  const acquired = await redis.setNxPx(lockKey, lockId, 3000);

  if (!acquired) {
    throw new ConflictError(
      'A verification operation for this invitation is currently processing. Please retry in a moment.',
      'INVITATION_MUTEX_LOCKED'
    );
  }

  try {
    const freshInvite = await prisma.eventStaffInvitation.findUnique({
      where: { id: invitation.id },
    });

    if (!freshInvite || (freshInvite.status !== 'PENDING' && freshInvite.status !== 'ACCEPTED')) {
      throw new BadRequestError('Invitation is no longer pending or accepted.', 'INVITATION_NOT_PENDING');
    }

    if (freshInvite.status === 'ACCEPTED') {
      const freshAssignment = await prisma.eventStaff.findUnique({
        where: {
          eventId_userId: {
            eventId: freshInvite.eventId,
            userId: existingUser!.id,
          },
        },
        select: { status: true },
      });
      if (!freshAssignment || freshAssignment.status !== 'ACTIVE') {
        throw new ForbiddenError(
          'Your staff assignment for this event is no longer active.',
          'STAFF_ASSIGNMENT_NOT_ACTIVE'
        );
      }
    }

    if (
      freshInvite.otpSentAt &&
      now - freshInvite.otpSentAt.getTime() < RESEND_COOLDOWN_MS
    ) {
      const retryAfter = Math.ceil(
        (RESEND_COOLDOWN_MS - (now - freshInvite.otpSentAt.getTime())) / 1000
      );
      throw new TooManyRequestsError(
        `Please wait ${retryAfter} seconds before requesting another verification code.`,
        'OTP_RESEND_COOLDOWN'
      );
    }

    const code = crypto.randomInt(100000, 1000000).toString();
    const codeHash = hashStaffOtp(freshInvite.id, code);

    await prisma.eventStaffInvitation.update({
      where: { id: freshInvite.id },
      data: {
        codeHash,
        otpSentAt: new Date(now),
        otpExpiresAt: new Date(now + OTP_EXPIRY_MS),
        attempts: 0,
      },
    });

    try {
      await sendStaffOtpEmail({
        to: freshInvite.email,
        code,
        eventTitle: invitation.event.title,
        expiresInMinutes: 10,
        idempotencyKey: `staff-otp-${freshInvite.id}-${now}`,
      });
    } catch {
      await prisma.eventStaffInvitation.updateMany({
        where: {
          id: freshInvite.id,
          codeHash,
        },
        data: {
          codeHash: freshInvite.codeHash,
          otpSentAt: freshInvite.otpSentAt,
          otpExpiresAt: freshInvite.otpExpiresAt,
          attempts: freshInvite.attempts,
        },
      }).catch(() => {});

      throw new ServiceUnavailableError(
        'Unable to deliver verification code email. Please try again.',
        'EMAIL_DELIVERY_FAILED'
      );
    }

    res.json({
      success: true,
      data: {
        message: 'A 6-digit verification code has been sent to your email.',
        cooldownSeconds: Math.floor(RESEND_COOLDOWN_MS / 1000),
        expiresInMinutes: 10,
      },
    });
  } finally {
    await redis.delLockIfMatches(lockKey, lockId).catch(() => {});
  }
  } catch (error) {
    next(error);
  }
}

export async function verifyInvitationOtp(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { token } = invitationTokenParamSchema.parse(req.params);
  const input = verifyStaffOtpSchema.parse(req.body);
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  const ip = req.ip || 'unknown';
  const isRateAllowed = await checkRedisRateLimit(
    `staff_verify_ip:${ip}`,
    MAX_VERIFY_REQUESTS_PER_WINDOW,
    RATE_LIMIT_WINDOW_MS
  );
  if (!isRateAllowed) {
    throw new TooManyRequestsError(
      'Too many verification attempts. Please wait before trying again.',
      'VERIFICATION_RATE_LIMIT'
    );
  }

  const invitation = await prisma.eventStaffInvitation.findUnique({
    where: { tokenHash },
    include: {
      event: {
        select: {
          id: true,
          title: true,
        },
      },
    },
  });

  if (!invitation) {
    throw new NotFoundError('Invitation not found', 'INVITATION_NOT_FOUND');
  }

  if (invitation.status === 'REVOKED') {
    throw new ForbiddenError(
      'This invitation has been revoked by the event organizer.',
      'INVITATION_REVOKED'
    );
  }

  const now = Date.now();
  if (invitation.status === 'EXPIRED' || invitation.expiresAt.getTime() <= now) {
    throw new AppError('This invitation has expired.', 410, true, 'INVITATION_EXPIRED');
  }

  const existingUser = await prisma.user.findUnique({
    where: { email: normalizeEmail(invitation.email) },
    select: { id: true, email: true, passwordHash: true, status: true },
  });

  if (existingUser && existingUser.status !== AccountStatus.ACTIVE) {
    await invalidateUserAuthCache(existingUser.id);
    await revokeAllUserSessions(existingUser.id);
    clearSessionCookie(res);
    throw new ForbiddenError(
      `Your account has been ${String(existingUser.status || 'disabled').toLowerCase()}.`,
      `ACCOUNT_${existingUser.status || 'DISABLED'}`
    );
  }

  if (existingUser && existingUser.passwordHash !== null) {
    throw new BadRequestError(
      'This account has a password set. Please sign in with your password to accept this invitation.',
      'PASSWORD_LOGIN_REQUIRED'
    );
  }

  if (invitation.status === 'ACCEPTED') {
    if (!existingUser) {
      throw new NotFoundError('User account not found', 'USER_NOT_FOUND');
    }

    const staffAssignment = await prisma.eventStaff.findUnique({
      where: {
        eventId_userId: {
          eventId: invitation.eventId,
          userId: existingUser.id,
        },
      },
      select: { id: true, status: true },
    });

    if (!staffAssignment || staffAssignment.status !== 'ACTIVE') {
      throw new ForbiddenError(
        'Your staff assignment for this event is no longer active.',
        'STAFF_ASSIGNMENT_NOT_ACTIVE'
      );
    }
  }

  const redis = getRedisClient();
  const lockId = crypto.randomUUID();
  const lockKey = `lock:invitation_otp:${invitation.id}`;
  const acquired = await redis.setNxPx(lockKey, lockId, 3000);

  if (!acquired) {
    throw new ConflictError(
      'A verification operation for this invitation is currently processing. Please retry in a moment.',
      'INVITATION_MUTEX_LOCKED'
    );
  }

  try {
    const freshInvite = await prisma.eventStaffInvitation.findUnique({
      where: { id: invitation.id },
    });

    if (!freshInvite || (freshInvite.status !== 'PENDING' && freshInvite.status !== 'ACCEPTED')) {
      throw new BadRequestError('Invitation is no longer pending or accepted.', 'INVITATION_NOT_PENDING');
    }

    if (freshInvite.status === 'ACCEPTED') {
      const freshAssignment = await prisma.eventStaff.findUnique({
        where: {
          eventId_userId: {
            eventId: freshInvite.eventId,
            userId: existingUser!.id,
          },
        },
        select: { status: true },
      });
      if (!freshAssignment || freshAssignment.status !== 'ACTIVE') {
        throw new ForbiddenError(
          'Your staff assignment for this event is no longer active.',
          'STAFF_ASSIGNMENT_NOT_ACTIVE'
        );
      }
    }

    if (!freshInvite.codeHash || !freshInvite.otpExpiresAt) {
      throw new BadRequestError(
        'No active verification code found. Please request a new code.',
        'OTP_NOT_FOUND'
      );
    }

    if (freshInvite.attempts >= MAX_OTP_ATTEMPTS) {
      throw new TooManyRequestsError(
        'Maximum verification attempts exceeded. Please request a new code.',
        'OTP_MAX_ATTEMPTS'
      );
    }

    if (freshInvite.otpExpiresAt.getTime() <= now) {
      throw new BadRequestError(
        'Verification code has expired. Please request a new code.',
        'OTP_EXPIRED'
      );
    }

    const submittedHash = hashStaffOtp(freshInvite.id, input.code);
    const isMatch = timingSafeHashEquals(freshInvite.codeHash, submittedHash);

    if (!isMatch) {
      const nextAttempts = freshInvite.attempts + 1;
      await prisma.eventStaffInvitation.update({
        where: { id: freshInvite.id },
        data: {
          attempts: nextAttempts,
          ...(nextAttempts >= MAX_OTP_ATTEMPTS
            ? { otpExpiresAt: new Date(now - 1000) }
            : {}),
        },
      });
      throw new BadRequestError('Invalid verification code.', 'INVALID_OTP_CODE');
    }

    const normEmail = normalizeEmail(freshInvite.email);
    let blockedNonActiveUserId: string | null = null;

    let transactionResult;
    try {
      transactionResult = await prisma.$transaction(async (tx) => {
      const lockedInvite = await tx.eventStaffInvitation.findUnique({
        where: { id: freshInvite.id },
      });

      if (
        !lockedInvite ||
        (lockedInvite.status !== 'PENDING' && lockedInvite.status !== 'ACCEPTED') ||
        lockedInvite.expiresAt.getTime() <= Date.now()
      ) {
        throw new ConflictError(
          'Invitation is no longer valid.',
          'INVITATION_INVALID'
        );
      }

      if (lockedInvite.status === 'ACCEPTED') {
        const user = await tx.user.findUnique({
          where: { email: normEmail },
        });

        if (!user) {
          throw new NotFoundError('User account not found.', 'USER_NOT_FOUND');
        }

        if (user.status !== AccountStatus.ACTIVE) {
          blockedNonActiveUserId = user.id;
          throw new ForbiddenError(
            `Your account has been ${String(user.status || 'disabled').toLowerCase()}.`,
            `ACCOUNT_${user.status || 'DISABLED'}`
          );
        }

        if (user.passwordHash !== null) {
          throw new BadRequestError(
            'This account has a password set. Please sign in with your password to accept this invitation.',
            'PASSWORD_LOGIN_REQUIRED'
          );
        }

        const existingStaff = await tx.eventStaff.findUnique({
          where: {
            eventId_userId: {
              eventId: lockedInvite.eventId,
              userId: user.id,
            },
          },
        });

        if (!existingStaff || existingStaff.status !== 'ACTIVE') {
          throw new ForbiddenError(
            'Staff assignment is no longer active for this event.',
            'STAFF_ASSIGNMENT_NOT_ACTIVE'
          );
        }

        await tx.eventStaffInvitation.update({
          where: { id: lockedInvite.id },
          data: {
            codeHash: null,
            otpExpiresAt: null,
            otpSentAt: null,
            attempts: 0,
          },
        });

        return { user, staffRecord: existingStaff, isReturningStaff: true };
      }

      let user = await tx.user.findUnique({
        where: { email: normEmail },
      });

      if (user && user.status !== AccountStatus.ACTIVE) {
        blockedNonActiveUserId = user.id;
        throw new ForbiddenError(
          `Your account has been ${String(user.status || 'disabled').toLowerCase()}.`,
          `ACCOUNT_${user.status || 'DISABLED'}`
        );
      }

      if (user && user.passwordHash !== null) {
        throw new BadRequestError(
          'This account has a password set. Please sign in with your password to accept this invitation.',
          'PASSWORD_LOGIN_REQUIRED'
        );
      }

      if (!user) {
        try {
          user = await tx.user.create({
            data: {
              email: normEmail,
              name: normEmail.split('@')[0],
              passwordHash: null,
              role: Role.ATTENDEE,
              status: AccountStatus.ACTIVE,
              emailVerified: true,
              emailVerifiedAt: new Date(),
            },
          });
        } catch {
          user = await tx.user.findUnique({ where: { email: normEmail } });
          if (!user) throw new ServiceUnavailableError('Unable to resolve user account.');
          if (user.status !== AccountStatus.ACTIVE) {
            blockedNonActiveUserId = user.id;
            throw new ForbiddenError(
              `Your account has been ${String(user.status || 'disabled').toLowerCase()}.`,
              `ACCOUNT_${user.status || 'DISABLED'}`
            );
          }
          if (user.passwordHash !== null) {
            throw new BadRequestError(
              'This account has a password set. Please sign in with your password to accept this invitation.',
              'PASSWORD_LOGIN_REQUIRED'
            );
          }
        }
      } else if (user.emailVerified !== true) {
        user = await tx.user.update({
          where: { id: user.id },
          data: {
            emailVerified: true,
            emailVerifiedAt: new Date(),
          },
        });
      }

      const existingStaff = await tx.eventStaff.findUnique({
        where: {
          eventId_userId: {
            eventId: lockedInvite.eventId,
            userId: user.id,
          },
        },
      });

      let staffRecord;
      if (existingStaff) {
        staffRecord = await tx.eventStaff.update({
          where: { id: existingStaff.id },
          data: {
            status: 'ACTIVE',
            assignedByUserId: lockedInvite.invitedByUserId,
            assignedAt: new Date(),
            revokedAt: null,
            revokedByUserId: null,
          },
        });
      } else {
        staffRecord = await tx.eventStaff.create({
          data: {
            eventId: lockedInvite.eventId,
            userId: user.id,
            email: normEmail,
            status: 'ACTIVE',
            assignedByUserId: lockedInvite.invitedByUserId,
          },
        });
      }

      await tx.eventStaffInvitation.update({
        where: { id: lockedInvite.id },
        data: {
          status: 'ACCEPTED',
          acceptedAt: new Date(),
          codeHash: null,
          otpExpiresAt: null,
          otpSentAt: null,
          attempts: 0,
        },
      });

      return { user, staffRecord, isReturningStaff: false };
      });
    } catch (txError) {
      if (blockedNonActiveUserId) {
        await invalidateUserAuthCache(blockedNonActiveUserId).catch(() => {});
        await revokeAllUserSessions(blockedNonActiveUserId).catch(() => {});
        clearSessionCookie(res);
      }
      throw txError;
    }

    if (transactionResult.user.status !== AccountStatus.ACTIVE) {
      await invalidateUserAuthCache(transactionResult.user.id);
      await revokeAllUserSessions(transactionResult.user.id);
      clearSessionCookie(res);
      throw new ForbiddenError(
        `Your account has been ${String(transactionResult.user.status || 'disabled').toLowerCase()}.`,
        `ACCOUNT_${transactionResult.user.status || 'DISABLED'}`
      );
    }

    await invalidateUserAuthCache(transactionResult.user.id);
    const ver = await getUserAuthCacheVersion(transactionResult.user.id);
    await populateUserAuthCacheAtomically(
      {
        userId: transactionResult.user.id,
        email: transactionResult.user.email,
        role: transactionResult.user.role,
        emailVerified: true,
        accountStatus: transactionResult.user.status,
      },
      ver
    );

    const issuedSession = await rotateSession({
      oldSessionId: req.session?.sessionId ?? null,
      userId: transactionResult.user.id,
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
          id: transactionResult.user.id,
          email: transactionResult.user.email,
          name: transactionResult.user.name,
          role: transactionResult.user.role,
        },
        csrfToken: issuedSession.csrfToken,
        ...(activeNodeEnv !== 'production' ? { token: issuedSession.rawCookieValue } : {}),
        eventId: freshInvite.eventId,
        status: 'ACTIVE',
      },
    });
  } finally {
    await redis.delLockIfMatches(lockKey, lockId).catch(() => {});
  }
  } catch (error) {
    next(error);
  }
}

export async function acceptInvitationWithSession(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { token } = invitationTokenParamSchema.parse(req.params);
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const currentUser = req.user;
    if (!currentUser) {
      throw new UnauthorizedError('Authentication required to accept invitation');
    }

    if (!currentUser.emailVerified) {
      throw new ForbiddenError(
        'Email verification is required before accepting a staff invitation.',
        'EMAIL_VERIFICATION_REQUIRED'
      );
    }

    const invitation = await prisma.eventStaffInvitation.findUnique({
      where: { tokenHash },
    });

    if (!invitation) {
      throw new NotFoundError('Invitation not found', 'INVITATION_NOT_FOUND');
    }

    if (invitation.status === 'REVOKED') {
      throw new ForbiddenError(
        'This invitation has been revoked by the event organizer.',
        'INVITATION_REVOKED'
      );
    }

    const normInviteEmail = normalizeEmail(invitation.email);
    const normUserEmail = normalizeEmail(currentUser.email);

    if (normUserEmail !== normInviteEmail) {
      throw new ForbiddenError(
        `You are currently signed in as ${currentUser.email}, but this invitation was sent to ${invitation.email}. Please sign in with the invited account to accept.`,
        'INVITATION_EMAIL_MISMATCH'
      );
    }

    if (invitation.status === 'ACCEPTED') {
      const dbUser = await prisma.user.findUnique({
        where: { id: currentUser.userId },
        select: {
          id: true,
          email: true,
          role: true,
          status: true,
          emailVerified: true,
        },
      });

      if (!dbUser) {
        throw new UnauthorizedError('User account not found');
      }

      if (dbUser.status !== AccountStatus.ACTIVE) {
        await invalidateUserAuthCache(dbUser.id);
        await revokeAllUserSessions(dbUser.id);
        clearSessionCookie(res);
        throw new ForbiddenError(
          `Your account has been ${String(dbUser.status || 'disabled').toLowerCase()}.`,
          `ACCOUNT_${dbUser.status || 'DISABLED'}`
        );
      }

      if (dbUser.emailVerified !== true) {
        throw new ForbiddenError(
          'Email verification is required before accepting a staff invitation.',
          'EMAIL_VERIFICATION_REQUIRED'
        );
      }

      const existingStaff = await prisma.eventStaff.findUnique({
        where: {
          eventId_userId: {
            eventId: invitation.eventId,
            userId: currentUser.userId,
          },
        },
      });

      if (!existingStaff || existingStaff.status !== 'ACTIVE') {
        throw new ForbiddenError(
          'Your staff assignment for this event is no longer active.',
          'STAFF_ASSIGNMENT_NOT_ACTIVE'
        );
      }

      res.json({
        success: true,
        data: {
          eventId: invitation.eventId,
          status: 'ACTIVE',
          user: {
            id: dbUser.id,
            email: dbUser.email,
            role: dbUser.role,
          },
        },
      });
      return;
    }

    const now = Date.now();
    if (invitation.expiresAt.getTime() <= now) {
      throw new AppError('This invitation has expired.', 410, true, 'INVITATION_EXPIRED');
    }

    let blockedAcceptUserId: string | null = null;
    let transactionResult;
    try {
      transactionResult = await prisma.$transaction(async (tx) => {
      const lockedInvite = await tx.eventStaffInvitation.findUnique({
        where: { id: invitation.id },
      });

      if (
        !lockedInvite ||
        lockedInvite.status !== 'PENDING' ||
        lockedInvite.expiresAt.getTime() <= Date.now()
      ) {
        throw new ConflictError(
          'Invitation is no longer valid or has already been accepted.',
          'INVITATION_INVALID'
        );
      }

      const dbUser = await tx.user.findUnique({
        where: { id: currentUser.userId },
      });

      if (!dbUser) {
        throw new UnauthorizedError('User account not found');
      }

      if (dbUser.status !== AccountStatus.ACTIVE) {
        blockedAcceptUserId = dbUser.id;
        throw new ForbiddenError(
          `Your account has been ${String(dbUser.status || 'disabled').toLowerCase()}.`,
          `ACCOUNT_${dbUser.status || 'DISABLED'}`
        );
      }

      if (dbUser.emailVerified !== true) {
        throw new ForbiddenError(
          'Email verification is required before accepting a staff invitation.',
          'EMAIL_VERIFICATION_REQUIRED'
        );
      }

      const existingStaff = await tx.eventStaff.findUnique({
        where: {
          eventId_userId: {
            eventId: lockedInvite.eventId,
            userId: currentUser.userId,
          },
        },
      });

      let staffRecord;
      if (existingStaff) {
        staffRecord = await tx.eventStaff.update({
          where: { id: existingStaff.id },
          data: {
            status: 'ACTIVE',
            assignedByUserId: lockedInvite.invitedByUserId,
            assignedAt: new Date(),
            revokedAt: null,
            revokedByUserId: null,
          },
        });
      } else {
        staffRecord = await tx.eventStaff.create({
          data: {
            eventId: lockedInvite.eventId,
            userId: currentUser.userId,
            email: normInviteEmail,
            status: 'ACTIVE',
            assignedByUserId: lockedInvite.invitedByUserId,
          },
        });
      }

      await tx.eventStaffInvitation.update({
        where: { id: lockedInvite.id },
        data: {
          status: 'ACCEPTED',
          acceptedAt: new Date(),
          codeHash: null,
          otpExpiresAt: null,
          otpSentAt: null,
          attempts: 0,
        },
      });

      return { user: dbUser, staffRecord };
      });
    } catch (txError) {
      if (blockedAcceptUserId) {
        await invalidateUserAuthCache(blockedAcceptUserId).catch(() => {});
        await revokeAllUserSessions(blockedAcceptUserId).catch(() => {});
        clearSessionCookie(res);
      }
      throw txError;
    }

    await invalidateUserAuthCache(transactionResult.user.id);
    const ver = await getUserAuthCacheVersion(transactionResult.user.id);
    await populateUserAuthCacheAtomically(
      {
        userId: transactionResult.user.id,
        email: transactionResult.user.email,
        role: transactionResult.user.role,
        emailVerified: transactionResult.user.emailVerified,
        accountStatus: transactionResult.user.status,
      },
      ver
    );

    res.json({
      success: true,
      data: {
        eventId: invitation.eventId,
        status: 'ACTIVE',
        user: {
          id: transactionResult.user.id,
          email: transactionResult.user.email,
          role: transactionResult.user.role,
        },
      },
    });
  } catch (error) {
    next(error);
  }
}
