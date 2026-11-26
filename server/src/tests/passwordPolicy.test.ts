import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import { AccountStatus, Role } from '@prisma/client';
import { app } from '../app.js';
import { prisma } from '../db/prisma.js';
import { getRedisClient } from '../lib/redis.js';
import * as emailService from '../lib/email.service.js';
import { SESSION_COOKIE_NAME, clearEmergencySessionVersionFloorForTests } from '../lib/session.service.js';
import {
  PASSWORD_ACCEPTED_SPECIAL_CHARS,
  PASSWORD_MIN_LENGTH,
  evaluatePasswordPolicy,
} from '../modules/auth/passwordPolicy.js';
import {
  changePasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
} from '../modules/auth/auth.schema.js';
import {
  hashPasswordResetToken,
  resetPasswordResetRateLimits,
} from '../modules/auth/passwordReset.service.js';

function extractCookieValue(res: request.Response, cookieName = SESSION_COOKIE_NAME): string | null {
  const setCookieHeaders = res.headers['set-cookie'];
  if (!setCookieHeaders) return null;
  const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  for (const header of list) {
    if (header.startsWith(`${cookieName}=`)) {
      const firstPart = header.split(';')[0];
      const eqIdx = firstPart.indexOf('=');
      return decodeURIComponent(firstPart.slice(eqIdx + 1));
    }
  }
  return null;
}

describe('Password Policy Enforcement & Existing Account Compatibility', () => {
  const createdUserIds: string[] = [];

  async function createTestUser(overrides?: {
    email?: string;
    password?: string | null;
    status?: AccountStatus;
    role?: Role;
  }) {
    const suffix = nanoid(8).toLowerCase();
    const email = (overrides?.email || `pwpolicy_${suffix}@outside.vip`).toLowerCase();
    const passwordHash =
      overrides?.password === null
        ? null
        : await bcrypt.hash(overrides?.password ?? 'ValidStart1!', 10);

    const user = await prisma.user.create({
      data: {
        email,
        name: `Policy User ${suffix}`,
        passwordHash,
        role: overrides?.role ?? Role.ATTENDEE,
        status: overrides?.status ?? AccountStatus.ACTIVE,
        emailVerified: true,
        emailVerifiedAt: new Date(),
      },
    });
    createdUserIds.push(user.id);
    return user;
  }

  beforeEach(async () => {
    clearEmergencySessionVersionFloorForTests();
    emailService.resetEmailServiceTestOptions();
    emailService.resetSentVerificationEmails();
    await resetPasswordResetRateLimits();
    const redis = getRedisClient();
    if (redis.flushAllForTests) {
      await redis.flushAllForTests();
    }
  });

  afterEach(async () => {
    clearEmergencySessionVersionFloorForTests();
    await resetPasswordResetRateLimits();
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({
        where: { id: { in: createdUserIds } },
      });
    }
  });

  describe('1. Password Policy Evaluator & Zod Schemas', () => {
    it('accepts passwords satisfying minimum length (8), uppercase letter, number, and any accepted special character', () => {
      const baseline = evaluatePasswordPolicy('Strong1!');
      expect(baseline.valid).toBe(true);
      expect(baseline.errors).toEqual([]);

      for (const symbol of PASSWORD_ACCEPTED_SPECIAL_CHARS) {
        const candidate = `Passw0r${symbol}`;
        expect(candidate.length).toBe(PASSWORD_MIN_LENGTH);
        const res = evaluatePasswordPolicy(candidate);
        expect(res.valid, `Expected symbol "${symbol}" to be accepted`).toBe(true);
      }

      expect(
        registerSchema.safeParse({
          email: 'user@outside.vip',
          password: 'ValidPassword1!',
          name: 'Valid User',
        }).success
      ).toBe(true);

      expect(
        resetPasswordSchema.safeParse({
          token: 'tok_123',
          newPassword: 'ValidPassword1!',
          confirmPassword: 'ValidPassword1!',
        }).success
      ).toBe(true);

      expect(
        changePasswordSchema.safeParse({
          currentPassword: 'old',
          newPassword: 'ValidPassword1!',
        }).success
      ).toBe(true);
    });

    it('rejects passwords missing uppercase, number, special character, or below minimum length (8)', () => {
      // Missing uppercase
      const noUpper = evaluatePasswordPolicy('lowercase1!');
      expect(noUpper.valid).toBe(false);
      expect(noUpper.checks.uppercase).toBe(false);
      expect(noUpper.errors).toContain('Password must include at least one uppercase letter (A-Z).');

      // Missing number
      const noNumber = evaluatePasswordPolicy('NoNumberPass!');
      expect(noNumber.valid).toBe(false);
      expect(noNumber.checks.number).toBe(false);
      expect(noNumber.errors).toContain('Password must include at least one number (0-9).');

      // Missing special character (whitespace alone is not a special character)
      const noSpecial = evaluatePasswordPolicy('NoSpecial123');
      expect(noSpecial.valid).toBe(false);
      expect(noSpecial.checks.special).toBe(false);
      expect(noSpecial.errors).toContain(
        'Password must include at least one special character (for example !@#$%^&*).'
      );

      const spaceOnly = evaluatePasswordPolicy('Has Space1');
      expect(spaceOnly.valid).toBe(false);
      expect(spaceOnly.checks.special).toBe(false);

      // Below minimum length (7 chars, has upper, number, special)
      const tooShort = evaluatePasswordPolicy('Short1!');
      expect(tooShort.valid).toBe(false);
      expect(tooShort.checks.minLength).toBe(false);
      expect(tooShort.errors).toContain('Password must be at least 8 characters long.');
    });

    it('does NOT apply new composition rules to loginSchema', () => {
      const legacyWeakCases = ['weakpw', '1234', 'a', 'lowercaseonly', 'NoSymbols123'];
      for (const pw of legacyWeakCases) {
        const parsed = loginSchema.safeParse({
          email: 'legacy@outside.vip',
          password: pw,
        });
        expect(parsed.success).toBe(true);
      }
    });
  });

  describe('2. Registration Endpoint (POST /api/auth/register)', () => {
    const weakRegistrationCases = [
      {
        label: 'below minimum length',
        password: 'Ab1!def',
        expectedMessage: 'at least 8 characters',
      },
      {
        label: 'missing uppercase letter',
        password: 'lowercase1!',
        expectedMessage: 'uppercase letter',
      },
      {
        label: 'missing number',
        password: 'NoDigitsHere!',
        expectedMessage: 'one number',
      },
      {
        label: 'missing special character',
        password: 'NoSpecial123',
        expectedMessage: 'special character',
      },
    ];

    it.each(weakRegistrationCases)(
      'rejects registration when password is $label',
      async ({ password, expectedMessage }) => {
        const email = `reg_weak_${nanoid(6).toLowerCase()}@outside.vip`;
        const res = await request(app).post('/api/auth/register').send({
          email,
          password,
          name: 'Weak Reg User',
        });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error.message).toBe('Validation failed');
        const details: Array<{ field: string; message: string }> = res.body.error.details || [];
        expect(details.some((d) => d.field === 'password' && d.message.toLowerCase().includes(expectedMessage))).toBe(
          true
        );

        const created = await prisma.user.findUnique({ where: { email } });
        expect(created).toBeNull();
      }
    );

    it('accepts registration when password satisfies all four requirements', async () => {
      const email = `reg_strong_${nanoid(6).toLowerCase()}@outside.vip`;
      const res = await request(app).post('/api/auth/register').send({
        email,
        password: 'OutsideStrong2026!',
        name: 'Strong Reg User',
      });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      if (res.body.data?.user?.id) {
        createdUserIds.push(res.body.data.user.id);
      }
    });
  });

  describe('3. Password Reset Endpoint (POST /api/auth/reset-password)', () => {
    it('rejects weak new passwords without consuming the reset token, then accepts compliant password', async () => {
      const user = await createTestUser({ password: 'OldPassword1!' });
      const rawToken = `reset_policy_${nanoid(24)}`;
      await prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: hashPasswordResetToken(rawToken),
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        },
      });

      const invalidPasswords = [
        'Short1!', // too short
        'alllowercase1!', // missing uppercase
        'NoNumberPassword!', // missing number
        'NoSpecialChar123', // missing special character
      ];

      for (const badPassword of invalidPasswords) {
        const failRes = await request(app)
          .post('/api/auth/reset-password')
          .set('X-Forwarded-For', '203.0.113.55')
          .send({
            token: rawToken,
            newPassword: badPassword,
            confirmPassword: badPassword,
          });

        expect(failRes.status).toBe(400);
        expect(failRes.body.error.message).toBe('Validation failed');
      }

      // Token must still be unconsumed so the user can retry with a compliant password
      const successRes = await request(app)
        .post('/api/auth/reset-password')
        .set('X-Forwarded-For', '203.0.113.55')
        .send({
          token: rawToken,
          newPassword: 'ResetStrong2026!',
          confirmPassword: 'ResetStrong2026!',
        });

      expect(successRes.status).toBe(200);
      expect(successRes.body.success).toBe(true);

      const loginRes = await request(app).post('/api/auth/login').send({
        email: user.email,
        password: 'ResetStrong2026!',
      });
      expect(loginRes.status).toBe(200);
    });
  });

  describe('4. Authenticated Password Change Endpoint (POST /api/auth/change-password)', () => {
    it('enforces the password policy on POST /api/auth/change-password', async () => {
      const currentPassword = 'CurrentStrong2026!';
      const user = await createTestUser({ password: currentPassword });

      const loginRes = await request(app).post('/api/auth/login').send({
        email: user.email,
        password: currentPassword,
      });
      expect(loginRes.status).toBe(200);

      const sessionCookie = extractCookieValue(loginRes);
      const csrfToken = loginRes.body.data?.csrfToken || loginRes.headers['x-csrf-token'];
      expect(sessionCookie).toBeTruthy();
      expect(csrfToken).toBeTruthy();

      for (const weakPassword of ['Ab1!', 'weaklower1!', 'WeakNoNum!', 'WeakNoSpecial1']) {
        const res = await request(app)
          .post('/api/auth/change-password')
          .set('Cookie', `${SESSION_COOKIE_NAME}=${sessionCookie}`)
          .set('X-CSRF-Token', csrfToken)
          .send({
            currentPassword,
            newPassword: weakPassword,
          });

        expect(res.status).toBe(400);
        expect(res.body.error.message).toBe('Validation failed');
      }

      const okRes = await request(app)
        .post('/api/auth/change-password')
        .set('Cookie', `${SESSION_COOKIE_NAME}=${sessionCookie}`)
        .set('X-CSRF-Token', csrfToken)
        .send({
          currentPassword,
          newPassword: 'UpdatedStrong2026#',
        });

      expect(okRes.status).toBe(200);
      expect(okRes.body.success).toBe(true);
    });
  });

  describe('5. Existing Accounts Login Backward Compatibility (POST /api/auth/login)', () => {
    it('allows existing users whose stored password lacks uppercase, number, special char, or 8+ chars to keep logging in', async () => {
      const legacyWeakPassword = 'legacy'; // 6 lowercase letters, no digit, no special character
      const legacyUser = await createTestUser({ password: legacyWeakPassword });

      // Wrong password fails with 401 (never 400 composition error)
      const wrongRes = await request(app).post('/api/auth/login').send({
        email: legacyUser.email,
        password: 'wrong',
      });
      expect(wrongRes.status).toBe(401);

      // Correct legacy weak password logs in seamlessly
      const loginRes = await request(app).post('/api/auth/login').send({
        email: legacyUser.email,
        password: legacyWeakPassword,
      });
      expect(loginRes.status).toBe(200);
      expect(loginRes.body.success).toBe(true);
      expect(loginRes.body.data.user.id).toBe(legacyUser.id);
    });
  });
});
