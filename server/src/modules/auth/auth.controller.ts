import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { env, normalizeEmail, isEmailInAdminAllowlist } from '../../config/env.js';
import {
  registerSchema,
  loginSchema,
  verifyEmailSchema,
  resendVerificationSchema,
  updateProfileSchema,
} from './auth.schema.js';
import {
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  ConflictError,
  TooManyRequestsError,
  NotFoundError,
} from '../../utils/errors.js';
import { AuthUserPayload } from '../../middleware/auth.js';
import { sendVerificationOtpEmail } from '../../lib/email.service.js';
import { recordAdminAuditLog } from '../../lib/auditLogger.js';

export const OTP_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
export const RESEND_COOLDOWN_MS = 60 * 1000; // 60 seconds
export const MAX_CODE_ATTEMPTS = 5;
export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
export const MAX_VERIFY_REQUESTS_PER_WINDOW = 8;
export const MAX_RESEND_REQUESTS_PER_WINDOW = 5;

const verifyAttemptTimestamps = new Map<string, number[]>();
const resendRequestTimestamps = new Map<string, number[]>();

export function resetVerificationRateLimits(): void {
  verifyAttemptTimestamps.clear();
  resendRequestTimestamps.clear();
}

function checkSlidingWindowRateLimit(
  store: Map<string, number[]>,
  key: string,
  maxRequests: number,
  windowMs: number
): boolean {
  const now = Date.now();
  const existing = store.get(key) || [];
  const active = existing.filter((ts) => now - ts < windowMs);
  if (active.length >= maxRequests) {
    store.set(key, active);
    return false;
  }
  active.push(now);
  store.set(key, active);
  return true;
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
  emailVerified: true,
  emailVerifiedAt: true,
  avatarUrl: true,
  organizer: true,
} as const;

async function issueVerificationCodeForUser(user: {
  id: string;
  email: string;
  name: string;
}): Promise<{ code: string; expiresAt: Date }> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + OTP_EXPIRY_MS);
  const code = generateSixDigitOtp();
  const codeHash = hashVerificationCode(user.id, code);

  // Expire any previous unused codes for this user so only the latest code is valid
  await prisma.emailVerificationCode.updateMany({
    where: {
      userId: user.id,
      usedAt: null,
      expiresAt: { gt: now },
    },
    data: {
      expiresAt: new Date(now.getTime() - 1000),
    },
  });

  await prisma.emailVerificationCode.create({
    data: {
      userId: user.id,
      email: normalizeEmail(user.email),
      codeHash,
      expiresAt,
    },
  });

  await sendVerificationOtpEmail({
    to: user.email,
    name: user.name,
    code,
    expiresInMinutes: 10,
  });

  return { code, expiresAt };
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

    // Every registered user starts with default ATTENDEE functionality and unverified email.
    // Frontend role values are never trusted to grant elevated roles on registration.
    const user = await prisma.user.create({
      data: {
        email: normalizedEmail,
        passwordHash,
        name: input.name,
        role: Role.ATTENDEE,
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

    await issueVerificationCodeForUser({
      id: user.id,
      email: user.email,
      name: user.name,
    });

    const tokenPayload: AuthUserPayload = {
      userId: user.id,
      email: user.email,
      role: user.role,
      emailVerified: user.emailVerified,
    };

    const token = jwt.sign(tokenPayload, env.JWT_SECRET, {
      expiresIn: env.JWT_EXPIRES_IN as any,
    });

    res.status(201).json({
      success: true,
      data: {
        user,
        token,
        verificationRequired: true,
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
      throw new UnauthorizedError('Authentication or email address is required to verify email.');
    }

    if (!targetUser) {
      throw new NotFoundError('User account not found.');
    }

    const rateKey = `verify:${targetUser.id}`;
    if (
      !checkSlidingWindowRateLimit(
        verifyAttemptTimestamps,
        rateKey,
        MAX_VERIFY_REQUESTS_PER_WINDOW,
        RATE_LIMIT_WINDOW_MS
      )
    ) {
      throw new TooManyRequestsError(
        'Too many verification attempts. Please wait before trying again.',
        'VERIFICATION_RATE_LIMIT'
      );
    }

    const submittedHash = hashVerificationCode(targetUser.id, input.code);
    const now = new Date();

    // Check if this exact code was already used previously
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

    const tokenPayload: AuthUserPayload = {
      userId: updatedUser.id,
      email: updatedUser.email,
      role: updatedUser.role,
      emailVerified: updatedUser.emailVerified,
    };

    const token = jwt.sign(tokenPayload, env.JWT_SECRET, {
      expiresIn: env.JWT_EXPIRES_IN as any,
    });

    res.json({
      success: true,
      data: {
        user: updatedUser,
        token,
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

    // Check cooldown against the most recently created verification code first
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

    const rateKey = `resend:${targetUser.id}`;
    if (
      !checkSlidingWindowRateLimit(
        resendRequestTimestamps,
        rateKey,
        MAX_RESEND_REQUESTS_PER_WINDOW,
        RATE_LIMIT_WINDOW_MS
      )
    ) {
      throw new TooManyRequestsError(
        'Too many verification code requests. Please try again later.',
        'VERIFICATION_RESEND_RATE_LIMIT'
      );
    }

    const { expiresAt } = await issueVerificationCodeForUser({
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

    let user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      include: {
        organizer: true,
      },
    });

    if (!user) {
      throw new UnauthorizedError('Invalid email or password.');
    }

    const isValidPassword = await bcrypt.compare(input.password, user.passwordHash);
    if (!isValidPassword) {
      throw new UnauthorizedError('Invalid email or password.');
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

    const tokenPayload: AuthUserPayload = {
      userId: user.id,
      email: user.email,
      role: user.role,
      emailVerified: user.emailVerified,
    };

    const token = jwt.sign(tokenPayload, env.JWT_SECRET, {
      expiresIn: env.JWT_EXPIRES_IN as any,
    });

    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          emailVerified: user.emailVerified,
          emailVerifiedAt: user.emailVerifiedAt,
          avatarUrl: user.avatarUrl,
          organizer: user.organizer,
        },
        token,
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
      throw new UnauthorizedError('User account not found');
    }

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
    }

    res.json({
      success: true,
      data: { user },
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
          attemptedEmailVerified: req.body.emailVerified,
        },
        ipAddress: req.ip,
      });
      throw new ForbiddenError('Users cannot modify role or email verification status.');
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
