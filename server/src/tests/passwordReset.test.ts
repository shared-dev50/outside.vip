import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import {
  AccountStatus,
  EmailOutboxStatus,
  EmailOutboxType,
  Role,
} from '@prisma/client';
import { app } from '../app.js';
import { prisma } from '../db/prisma.js';
import * as emailService from '../lib/email.service.js';
import { getRedisClient, setSimulatedRedisFailure } from '../lib/redis.js';
import {
  SESSION_COOKIE_NAME,
  SESSION_PREFIX,
  USER_AUTH_CACHE_PREFIX,
  USER_SESSION_VERSION_PREFIX,
  checkRedisSlidingWindowRateLimit,
  clearEmergencySessionVersionFloorForTests,
  createSession,
  getCachedUserSessionVersion,
  hashRateLimitIdentifier,
  listUserSessions,
  revokeAllUserSessions,
  invalidateUserAuthCache,
} from '../lib/session.service.js';
import {
  PASSWORD_RESET_DELIVERY_SECRET_PREFIX,
  processClaimedEmailOutboxItem,
  reapExpiredExhaustedLeases,
  runEmailOutboxPass,
} from '../modules/notifications/emailOutbox.service.js';
import {
  startEmailOutboxWorker,
  stopEmailOutboxWorker,
} from '../modules/notifications/emailOutboxWorker.js';
import {
  PASSWORD_RESET_EMAIL_SOFT_CAP_MAX,
  PASSWORD_RESET_EMAIL_SOFT_CAP_WINDOW_MS,
  PASSWORD_RESET_EXPIRY_MS,
  PASSWORD_RESET_REQ_IP_EMAIL_MAX,
  PASSWORD_RESET_RETENTION_MS,
  PASSWORD_RESET_SUBMIT_IP_MAX,
  UNIFORM_FORGOT_PASSWORD_MESSAGE,
  hashPasswordResetToken,
  purgeExpiredPasswordResetTokens,
  resetPasswordResetRateLimits,
} from '../modules/auth/passwordReset.service.js';
import {
  isPasswordResetCleanupWorkerRunning,
  runPasswordResetCleanupPass,
  startPasswordResetCleanupWorker,
  stopPasswordResetCleanupWorker,
} from '../modules/auth/passwordResetCleanupWorker.js';

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

function extractRawTokenFromUrl(resetUrl: string): string {
  const parsed = new URL(resetUrl);
  const token = parsed.searchParams.get('token');
  if (!token) {
    throw new Error(`Expected reset token query param in URL: ${resetUrl}`);
  }
  return token;
}

describe('Forgot Password & Secure Password Reset Integration Tests', () => {
  const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    CLIENT_URL: process.env.CLIENT_URL,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    EMAIL_FROM: process.env.EMAIL_FROM,
  };

  const createdUserIds: string[] = [];

  async function createTestUser(overrides?: {
    email?: string;
    name?: string;
    password?: string | null;
    status?: AccountStatus;
    role?: Role;
    emailVerified?: boolean;
  }) {
    const suffix = nanoid(8).toLowerCase();
    const email = (overrides?.email || `pwreset_${suffix}@outside.vip`).toLowerCase();
    const passwordHash =
      overrides?.password === null
        ? null
        : await bcrypt.hash(overrides?.password || 'InitialPass123!', 10);

    const user = await prisma.user.create({
      data: {
        email,
        name: overrides?.name || `Reset User ${suffix}`,
        passwordHash,
        role: overrides?.role ?? Role.ATTENDEE,
        status: overrides?.status ?? AccountStatus.ACTIVE,
        emailVerified: overrides?.emailVerified ?? true,
        emailVerifiedAt: overrides?.emailVerified === false ? null : new Date(),
      },
    });
    createdUserIds.push(user.id);
    return user;
  }

  beforeEach(async () => {
    vi.restoreAllMocks();
    await stopEmailOutboxWorker(0);
    await stopPasswordResetCleanupWorker(0);
    clearEmergencySessionVersionFloorForTests();
    setSimulatedRedisFailure(false);
    emailService.resetEmailServiceTestOptions();
    emailService.resetSentPasswordResetEmails();
    await resetPasswordResetRateLimits();
    const redis = getRedisClient();
    if (redis.flushAllForTests) {
      await redis.flushAllForTests();
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await stopEmailOutboxWorker(0);
    await stopPasswordResetCleanupWorker(0);
    clearEmergencySessionVersionFloorForTests();
    setSimulatedRedisFailure(false);
    emailService.resetEmailServiceTestOptions();
    emailService.resetSentPasswordResetEmails();
    await resetPasswordResetRateLimits();

    if (originalEnv.CLIENT_URL === undefined) {
      delete process.env.CLIENT_URL;
    } else {
      process.env.CLIENT_URL = originalEnv.CLIENT_URL;
    }
    if (originalEnv.RESEND_API_KEY === undefined) {
      delete process.env.RESEND_API_KEY;
    } else {
      process.env.RESEND_API_KEY = originalEnv.RESEND_API_KEY;
    }
    if (originalEnv.EMAIL_FROM === undefined) {
      delete process.env.EMAIL_FROM;
    } else {
      process.env.EMAIL_FROM = originalEnv.EMAIL_FROM;
    }
    process.env.NODE_ENV = originalEnv.NODE_ENV;
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      const users = await prisma.user.findMany({
        where: { id: { in: createdUserIds } },
        select: { id: true, email: true },
      });
      const emails = users.map((u) => u.email.toLowerCase());
      for (const id of createdUserIds) {
        await revokeAllUserSessions(id).catch(() => {});
        await invalidateUserAuthCache(id).catch(() => {});
      }
      if (emails.length > 0) {
        await prisma.emailOutbox.deleteMany({
          where: { recipientEmail: { in: emails } },
        });
      }
      await prisma.adminAuditLog.deleteMany({
        where: { actorUserId: { in: createdUserIds } },
      });
      await prisma.passwordResetToken.deleteMany({
        where: { userId: { in: createdUserIds } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: createdUserIds } },
      });
    }
  });

  describe('1. Anti-Enumeration, URL Construction, and Hashed Token Storage', () => {
    it('returns identical uniform responses for registered and unregistered emails without exposing account existence', async () => {
      const user = await createTestUser();

      const registeredRes = await request(app)
        .post('/api/auth/forgot-password')
        .set('X-Forwarded-For', '203.0.113.10')
        .send({ email: `  ${user.email.toUpperCase()}  ` });

      expect(registeredRes.status).toBe(200);
      expect(registeredRes.body).toEqual({
        success: true,
        data: {
          message: UNIFORM_FORGOT_PASSWORD_MESSAGE,
          expiresInMinutes: 30,
        },
      });
      expect(emailService.sentPasswordResetEmails).toHaveLength(1);

      emailService.resetSentPasswordResetEmails();

      const unregisteredRes = await request(app)
        .post('/api/auth/forgot-password')
        .set('X-Forwarded-For', '203.0.113.11')
        .send({ email: `nonexistent_${nanoid(6)}@outside.vip` });

      expect(unregisteredRes.status).toBe(200);
      expect(unregisteredRes.body).toEqual(registeredRes.body);
      expect(emailService.sentPasswordResetEmails).toHaveLength(0);

      // Suspended accounts also receive identical response and no email
      const suspended = await createTestUser({ status: AccountStatus.SUSPENDED });
      const suspendedRes = await request(app)
        .post('/api/auth/forgot-password')
        .set('X-Forwarded-For', '203.0.113.12')
        .send({ email: suspended.email });

      expect(suspendedRes.status).toBe(200);
      expect(suspendedRes.body).toEqual(registeredRes.body);
      expect(emailService.sentPasswordResetEmails).toHaveLength(0);
    });

    it('stores only SHA-256 tokenHash in PostgreSQL, constructs canonical CLIENT_URL reset link, sets 30-min expiry, and clears ephemeral secret after delivery', async () => {
      process.env.CLIENT_URL = 'https://out-side.vip/';
      const user = await createTestUser({ name: 'Nadia <Security>' });

      const res = await request(app)
        .post('/api/auth/forgot-password')
        .set('X-Forwarded-For', '203.0.113.20')
        .send({ email: user.email });

      expect(res.status).toBe(200);

      const sent = emailService.getLatestPasswordResetEmail(user.email);
      expect(sent).toBeDefined();
      expect(sent!.resetUrl.startsWith('https://out-side.vip/reset-password?token=')).toBe(true);
      expect(sent!.subject).toBe('Reset your Outside.vip password');
      expect(sent!.text).toContain('30 minutes');
      expect(sent!.text).toContain('safely ignore this email');
      expect(sent!.html).not.toContain('<Security>');
      expect(sent!.html).toContain('&lt;Security&gt;');
      expect(sent!.html).toContain('30 minutes');
      expect(sent!.html).toContain('Reset Password');

      const rawToken = extractRawTokenFromUrl(sent!.resetUrl);
      expect(rawToken.length).toBeGreaterThanOrEqual(32);

      const tokens = await prisma.passwordResetToken.findMany({
        where: { userId: user.id },
      });
      expect(tokens).toHaveLength(1);
      const tokenRow = tokens[0];
      expect(tokenRow.tokenHash).toBe(hashPasswordResetToken(rawToken));
      expect(tokenRow.tokenHash).not.toBe(rawToken);
      expect(tokenRow.usedAt).toBeNull();

      const lifetimeMs = tokenRow.expiresAt.getTime() - tokenRow.createdAt.getTime();
      expect(lifetimeMs).toBeGreaterThanOrEqual(PASSWORD_RESET_EXPIRY_MS - 5000);
      expect(lifetimeMs).toBeLessThanOrEqual(PASSWORD_RESET_EXPIRY_MS + 5000);

      const outboxRow = await prisma.emailOutbox.findUnique({
        where: { dedupeKey: `password_reset:${tokenRow.id}` },
      });
      expect(outboxRow).not.toBeNull();
      expect(outboxRow!.type).toBe(EmailOutboxType.PASSWORD_RESET);
      expect(outboxRow!.status).toBe(EmailOutboxStatus.SENT);
      expect(JSON.stringify(outboxRow!.contentSnapshot)).not.toContain(rawToken);

      const redisSecretAfterSend = await getRedisClient().get(
        `${PASSWORD_RESET_DELIVERY_SECRET_PREFIX}${outboxRow!.id}`
      );
      expect(redisSecretAfterSend).toBeNull();
    });
  });

  describe('2. Token Validation, Expiration, Single-Use, and Concurrency', () => {
    it('rejects invalid and tampered tokens without mutating any account', async () => {
      const validateRes = await request(app)
        .post('/api/auth/reset-password/validate')
        .set('X-Forwarded-For', '203.0.113.30')
        .send({ token: 'invalid_token_value_123456' });

      expect(validateRes.status).toBe(400);
      expect(validateRes.body.error.code).toBe('INVALID_RESET_TOKEN');

      const resetRes = await request(app)
        .post('/api/auth/reset-password')
        .set('X-Forwarded-For', '203.0.113.30')
        .send({
          token: 'invalid_token_value_123456',
          newPassword: 'NewSecurePassword2026!',
          confirmPassword: 'NewSecurePassword2026!',
        });

      expect(resetRes.status).toBe(400);
      expect(resetRes.body.error.code).toBe('INVALID_RESET_TOKEN');
    });

    it('rejects expired tokens and supports stale token cleanup', async () => {
      const user = await createTestUser({ password: 'OldPassword123!' });

      await request(app)
        .post('/api/auth/forgot-password')
        .set('X-Forwarded-For', '203.0.113.31')
        .send({ email: user.email });

      const sent = emailService.getLatestPasswordResetEmail(user.email)!;
      const rawToken = extractRawTokenFromUrl(sent.resetUrl);
      const tokenHash = hashPasswordResetToken(rawToken);

      // Expire the token slightly into the past
      await prisma.passwordResetToken.update({
        where: { tokenHash },
        data: { expiresAt: new Date(Date.now() - 5000) },
      });

      const validateRes = await request(app)
        .post('/api/auth/reset-password/validate')
        .set('X-Forwarded-For', '203.0.113.31')
        .send({ token: rawToken });
      expect(validateRes.status).toBe(400);
      expect(validateRes.body.error.code).toBe('RESET_TOKEN_EXPIRED');

      const resetRes = await request(app)
        .post('/api/auth/reset-password')
        .set('X-Forwarded-For', '203.0.113.31')
        .send({
          token: rawToken,
          newPassword: 'UpdatedPassword2026!',
          confirmPassword: 'UpdatedPassword2026!',
        });
      expect(resetRes.status).toBe(400);
      expect(resetRes.body.error.code).toBe('RESET_TOKEN_EXPIRED');

      // Verify password was not changed
      const loginOldRes = await request(app)
        .post('/api/auth/login')
        .send({ email: user.email, password: 'OldPassword123!' });
      expect(loginOldRes.status).toBe(200);

      // Verify cleanup removes tokens expired beyond 24h retention window
      await prisma.passwordResetToken.update({
        where: { tokenHash },
        data: { expiresAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
      });
      const purgedCount = await purgeExpiredPasswordResetTokens();
      expect(purgedCount).toBeGreaterThanOrEqual(1);
      const deletedRow = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });
      expect(deletedRow).toBeNull();
    });

    it('updates password, enforces single-use, invalidates outstanding tokens, and revokes all existing sessions', async () => {
      const user = await createTestUser({ password: 'OldPassword123!' });

      // Create two active sessions for this user across different user agents
      const login1 = await request(app)
        .post('/api/auth/login')
        .set('User-Agent', 'SessionOne')
        .send({ email: user.email, password: 'OldPassword123!' });
      const login2 = await request(app)
        .post('/api/auth/login')
        .set('User-Agent', 'SessionTwo')
        .send({ email: user.email, password: 'OldPassword123!' });

      expect(login1.status).toBe(200);
      expect(login2.status).toBe(200);

      const cookie1 = `${SESSION_COOKIE_NAME}=${encodeURIComponent(extractCookieValue(login1)!)}`;
      const cookie2 = `${SESSION_COOKIE_NAME}=${encodeURIComponent(extractCookieValue(login2)!)}`;
      expect(await listUserSessions(user.id)).toHaveLength(2);

      // Request two reset tokens before using the second one
      await request(app)
        .post('/api/auth/forgot-password')
        .set('X-Forwarded-For', '203.0.113.40')
        .send({ email: user.email });
      const firstToken = extractRawTokenFromUrl(
        emailService.getLatestPasswordResetEmail(user.email)!.resetUrl
      );

      await request(app)
        .post('/api/auth/forgot-password')
        .set('X-Forwarded-For', '203.0.113.40')
        .send({ email: user.email });
      const secondToken = extractRawTokenFromUrl(
        emailService.getLatestPasswordResetEmail(user.email)!.resetUrl
      );

      expect(firstToken).not.toBe(secondToken);

      // Validate active token
      const checkRes = await request(app)
        .post('/api/auth/reset-password/validate')
        .set('X-Forwarded-For', '203.0.113.40')
        .send({ token: secondToken });
      expect(checkRes.status).toBe(200);
      expect(checkRes.body.data).toEqual({ valid: true, expiresInMinutes: 30 });

      // Reset password using secondToken
      const resetRes = await request(app)
        .post('/api/auth/reset-password')
        .set('X-Forwarded-For', '203.0.113.40')
        .send({
          token: secondToken,
          newPassword: 'BrandNewPassword2026!',
          confirmPassword: 'BrandNewPassword2026!',
        });

      expect(resetRes.status).toBe(200);
      expect(resetRes.body.success).toBe(true);
      expect(JSON.stringify(resetRes.body)).not.toContain(secondToken);
      expect(JSON.stringify(resetRes.body)).not.toContain('BrandNewPassword2026!');

      // Both previous active sessions are immediately invalidated
      expect(await listUserSessions(user.id)).toHaveLength(0);
      const me1 = await request(app).get('/api/auth/me').set('Cookie', cookie1);
      const me2 = await request(app).get('/api/auth/me').set('Cookie', cookie2);
      expect(me1.status).toBe(401);
      expect(me2.status).toBe(401);

      // Replaying the consumed secondToken fails
      const replayRes = await request(app)
        .post('/api/auth/reset-password')
        .set('X-Forwarded-For', '203.0.113.40')
        .send({
          token: secondToken,
          newPassword: 'AnotherPassword2026!',
          confirmPassword: 'AnotherPassword2026!',
        });
      expect(replayRes.status).toBe(400);
      expect(replayRes.body.error.code).toBe('RESET_TOKEN_USED');

      // Earlier outstanding firstToken is also invalidated
      const firstTokenReplay = await request(app)
        .post('/api/auth/reset-password')
        .set('X-Forwarded-For', '203.0.113.40')
        .send({
          token: firstToken,
          newPassword: 'AnotherPassword2026!',
          confirmPassword: 'AnotherPassword2026!',
        });
      expect(firstTokenReplay.status).toBe(400);
      expect(firstTokenReplay.body.error.code).toBe('RESET_TOKEN_EXPIRED');

      // Old password fails; new password logs in
      const oldLogin = await request(app)
        .post('/api/auth/login')
        .send({ email: user.email, password: 'OldPassword123!' });
      expect(oldLogin.status).toBe(401);

      const newLogin = await request(app)
        .post('/api/auth/login')
        .send({ email: user.email, password: 'BrandNewPassword2026!' });
      expect(newLogin.status).toBe(200);

      // Audit log exists without secrets
      const auditLogs = await prisma.adminAuditLog.findMany({
        where: {
          actorUserId: user.id,
          action: 'PASSWORD_RESET_COMPLETED_SESSIONS_REVOKED',
        },
      });
      expect(auditLogs).toHaveLength(1);
      expect(JSON.stringify(auditLogs[0])).not.toContain(secondToken);
      expect(JSON.stringify(auditLogs[0])).not.toContain('BrandNewPassword2026!');
    });

    it('prevents concurrent password-reset consumption of the same token', async () => {
      const user = await createTestUser({ password: 'StartPassword123!' });

      await request(app)
        .post('/api/auth/forgot-password')
        .set('X-Forwarded-For', '203.0.113.50')
        .send({ email: user.email });

      const rawToken = extractRawTokenFromUrl(
        emailService.getLatestPasswordResetEmail(user.email)!.resetUrl
      );

      const [resA, resB] = await Promise.all([
        request(app)
          .post('/api/auth/reset-password')
          .set('X-Forwarded-For', '203.0.113.51')
          .send({
            token: rawToken,
            newPassword: 'WinnerPasswordAAA2026!',
            confirmPassword: 'WinnerPasswordAAA2026!',
          }),
        request(app)
          .post('/api/auth/reset-password')
          .set('X-Forwarded-For', '203.0.113.52')
          .send({
            token: rawToken,
            newPassword: 'WinnerPasswordBBB2026!',
            confirmPassword: 'WinnerPasswordBBB2026!',
          }),
      ]);

      const statuses = [resA.status, resB.status].sort();
      expect(statuses).toEqual([200, 400]);

      const winningPassword =
        resA.status === 200 ? 'WinnerPasswordAAA2026!' : 'WinnerPasswordBBB2026!';
      const losingPassword =
        resA.status === 200 ? 'WinnerPasswordBBB2026!' : 'WinnerPasswordAAA2026!';

      const winLogin = await request(app)
        .post('/api/auth/login')
        .send({ email: user.email, password: winningPassword });
      expect(winLogin.status).toBe(200);

      const loseLogin = await request(app)
        .post('/api/auth/login')
        .send({ email: user.email, password: losingPassword });
      expect(loseLogin.status).toBe(401);
    });
  });

  describe('3. Redis Rate Limiting Without Trivial Lockout & Fail-Closed Behaviour', () => {
    it('rate-limits excessive requests from an attacker IP without locking out the legitimate user on another IP', async () => {
      const user = await createTestUser();

      for (let i = 0; i < PASSWORD_RESET_REQ_IP_EMAIL_MAX; i++) {
        const res = await request(app)
          .post('/api/auth/forgot-password')
          .set('X-Forwarded-For', '198.51.100.10')
          .send({ email: user.email });
        expect(res.status).toBe(200);
      }

      const attackerBlocked = await request(app)
        .post('/api/auth/forgot-password')
        .set('X-Forwarded-For', '198.51.100.10')
        .send({ email: user.email });

      expect(attackerBlocked.status).toBe(429);
      expect(attackerBlocked.body.error.code).toBe('PASSWORD_RESET_RATE_LIMIT');

      // Legitimate user from another IP can still request password reset
      const legitimateRes = await request(app)
        .post('/api/auth/forgot-password')
        .set('X-Forwarded-For', '203.0.113.99')
        .send({ email: user.email });
      expect(legitimateRes.status).toBe(200);
    });

    it('rate-limits reset submission attempts per IP and fails closed when Redis is unavailable', async () => {
      for (let i = 0; i < PASSWORD_RESET_SUBMIT_IP_MAX; i++) {
        const res = await request(app)
          .post('/api/auth/reset-password')
          .set('X-Forwarded-For', '198.51.100.77')
          .send({
            token: `bad_token_${i}`,
            newPassword: 'ValidPassword2026!',
          });
        expect(res.status).toBe(400);
      }

      const blockedSubmit = await request(app)
        .post('/api/auth/reset-password')
        .set('X-Forwarded-For', '198.51.100.77')
        .send({
          token: 'bad_token_overflow',
          newPassword: 'ValidPassword2026!',
        });
      expect(blockedSubmit.status).toBe(429);
      expect(blockedSubmit.body.error.code).toBe('PASSWORD_RESET_RATE_LIMIT');

      // Redis outage fails closed
      setSimulatedRedisFailure(true);
      const outageRes = await request(app)
        .post('/api/auth/forgot-password')
        .set('X-Forwarded-For', '203.0.113.88')
        .send({ email: 'anyone@outside.vip' });
      expect(outageRes.status).toBe(503);
      expect(outageRes.body.error.code).toBe('AUTH_STORE_UNAVAILABLE');
    });
  });

  describe('4. EmailOutbox Integration & Transient Resend Retry Behaviour', () => {
    it('persists EmailOutbox PENDING retry with sanitized error on transient 500 failure and completes delivery on retry pass', async () => {
      process.env.RESEND_API_KEY = 're_test_mock_key_999999';
      process.env.CLIENT_URL = 'https://out-side.vip';
      emailService.setEmailServiceTestOptions({
        useResendInTest: true,
        timeoutMs: 2000,
        retryDelayMs: 0,
        maxRetries: 0,
      });

      const user = await createTestUser();
      const capturedPayloads: Array<{
        subject: string;
        html: string;
        text: string;
        idempotencyKey: string | null;
      }> = [];

      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (_url, init) => {
          const parsedBody = JSON.parse(String(init?.body || '{}'));
          const headers = new Headers(init?.headers as HeadersInit | undefined);
          capturedPayloads.push({
            subject: parsedBody.subject,
            html: parsedBody.html,
            text: parsedBody.text,
            idempotencyKey: headers.get('idempotency-key'),
          });

          if (capturedPayloads.length === 1) {
            return new globalThis.Response(
              JSON.stringify({
                statusCode: 500,
                name: 'application_error',
                message: `Transient upstream failure referencing ${parsedBody.text}`,
              }),
              {
                status: 500,
                headers: { 'content-type': 'application/json' },
              }
            );
          }

          return new globalThis.Response(
            JSON.stringify({ id: 're_pwreset_retry_success' }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }
          );
        });

      // Request triggers immediate outbox dispatch -> Resend returns 500 -> moves to PENDING retry
      const reqRes = await request(app)
        .post('/api/auth/forgot-password')
        .set('X-Forwarded-For', '203.0.113.120')
        .send({ email: user.email });

      expect(reqRes.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const tokenRow = await prisma.passwordResetToken.findFirst({
        where: { userId: user.id },
      });
      expect(tokenRow).not.toBeNull();

      const afterFirstAttempt = await prisma.emailOutbox.findUnique({
        where: { dedupeKey: `password_reset:${tokenRow!.id}` },
      });
      expect(afterFirstAttempt).not.toBeNull();
      expect(afterFirstAttempt!.status).toBe(EmailOutboxStatus.PENDING);
      expect(afterFirstAttempt!.attempts).toBe(1);
      expect(afterFirstAttempt!.lastErrorCode).toBe('EMAIL_PROVIDER_UNAVAILABLE');
      // Sensitive URL/token must never leak into stored error messages
      expect(afterFirstAttempt!.lastErrorMessage).toContain('[REDACTED]');

      // Ephemeral Redis delivery secret stays present for retry
      const redisSecretBeforeRetry = await getRedisClient().get(
        `${PASSWORD_RESET_DELIVERY_SECRET_PREFIX}${afterFirstAttempt!.id}`
      );
      expect(redisSecretBeforeRetry).toBeTruthy();

      // Advance nextAttemptAt so retry pass claims and sends immediately
      await prisma.emailOutbox.update({
        where: { id: afterFirstAttempt!.id },
        data: { nextAttemptAt: new Date(Date.now() - 1000) },
      });

      const passStats = await runEmailOutboxPass({ workerId: 'pwreset-retry-worker' });
      expect(passStats.accepted).toBeGreaterThanOrEqual(1);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(capturedPayloads[0].idempotencyKey).toBeTruthy();
      expect(capturedPayloads[0].idempotencyKey).toBe(capturedPayloads[1].idempotencyKey);
      expect(capturedPayloads[0].html).toBe(capturedPayloads[1].html);

      const sentRow = await prisma.emailOutbox.findUnique({
        where: { id: afterFirstAttempt!.id },
      });
      expect(sentRow!.status).toBe(EmailOutboxStatus.SENT);
      expect(sentRow!.provider).toBe('resend');
      expect(sentRow!.providerMessageId).toBe('re_pwreset_retry_success');

      // Ephemeral Redis delivery secret is purged once accepted
      const redisSecretAfterRetry = await getRedisClient().get(
        `${PASSWORD_RESET_DELIVERY_SECRET_PREFIX}${afterFirstAttempt!.id}`
      );
      expect(redisSecretAfterRetry).toBeNull();

      // Delivered link actually resets password
      const match = capturedPayloads[1].text.match(/https:\/\/out-side\.vip\/reset-password\?token=[^\s]+/);
      expect(match).not.toBeNull();
      const rawToken = extractRawTokenFromUrl(match![0]);
      const completeRes = await request(app)
        .post('/api/auth/reset-password')
        .set('X-Forwarded-For', '203.0.113.120')
        .send({
          token: rawToken,
          newPassword: 'OutboxVerifiedPassword2026!',
          confirmPassword: 'OutboxVerifiedPassword2026!',
        });
      expect(completeRes.status).toBe(200);
    });

    it('cancels queued PASSWORD_RESET outbox item automatically if token was already used or expired', async () => {
      const user = await createTestUser();
      startEmailOutboxWorker(60_000);

      // Simulate transient Resend failure while worker is stopped so row remains PENDING
      await stopEmailOutboxWorker(0);
      process.env.RESEND_API_KEY = 're_test_mock_key_cancel';
      emailService.setEmailServiceTestOptions({ useResendInTest: true, retryDelayMs: 0, maxRetries: 0 });
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new globalThis.Response(
          JSON.stringify({
            statusCode: 500,
            name: 'application_error',
            message: 'Temporary error',
          }),
          {
            status: 500,
            headers: { 'content-type': 'application/json' },
          }
        )
      );

      await request(app)
        .post('/api/auth/forgot-password')
        .set('X-Forwarded-For', '203.0.113.130')
        .send({ email: user.email });

      const tokenRow = await prisma.passwordResetToken.findFirst({
        where: { userId: user.id },
      });
      expect(tokenRow).not.toBeNull();

      const outbox = await prisma.emailOutbox.findUnique({
        where: { dedupeKey: `password_reset:${tokenRow!.id}` },
      });
      expect(outbox!.status).toBe(EmailOutboxStatus.PENDING);

      // Consume token before retry fires
      await prisma.passwordResetToken.update({
        where: { id: tokenRow!.id },
        data: { usedAt: new Date() },
      });
      await prisma.emailOutbox.update({
        where: { id: outbox!.id },
        data: { nextAttemptAt: new Date(Date.now() - 1000) },
      });

      const stats = await runEmailOutboxPass({ workerId: 'pwreset-cancel-worker' });
      expect(stats.cancelled).toBeGreaterThanOrEqual(1);

      const cancelled = await prisma.emailOutbox.findUnique({
        where: { id: outbox!.id },
      });
      expect(cancelled!.status).toBe(EmailOutboxStatus.CANCELLED);
      expect(cancelled!.lastErrorCode).toBe('PASSWORD_RESET_TOKEN_INACTIVE');
    });
  });

  describe('5. H-01 & H-02 Redis Handoff Race and Transient Read Retry Remediation', () => {
    it('H-01: stages encrypted Redis delivery secret strictly before committing EmailOutbox so concurrent worker polling never misses it', async () => {
      const user = await createTestUser();
      const redis = getRedisClient();

      const eventOrder: string[] = [];
      let stagedKey: string | null = null;
      const origSetPx = redis.setPx.bind(redis);
      vi.spyOn(redis, 'setPx').mockImplementation(async (key, val, ttl) => {
        if (key.startsWith(PASSWORD_RESET_DELIVERY_SECRET_PREFIX)) {
          eventOrder.push('redis.setPx');
          stagedKey = key;
        }
        return origSetPx(key, val, ttl);
      });

      const origTransaction = prisma.$transaction.bind(prisma);
      vi.spyOn(prisma, '$transaction').mockImplementation((async (fn: any, opts?: any) => {
        // By the time PostgreSQL tx begins, the Redis delivery key must already be populated
        expect(stagedKey).toBeTruthy();
        const existingInRedis = await redis.get(stagedKey!);
        expect(existingInRedis).toBeTruthy();
        eventOrder.push('prisma.$transaction');
        return origTransaction(fn, opts);
      }) as any);

      startEmailOutboxWorker(20);
      let stopPolling = false;
      const pollLoop = (async () => {
        while (!stopPolling) {
          await runEmailOutboxPass({ workerId: 'aggressive-race-worker' });
          await new Promise((r) => setTimeout(r, 5));
        }
      })();

      const res = await request(app)
        .post('/api/auth/forgot-password')
        .set('X-Forwarded-For', '203.0.113.140')
        .send({ email: user.email });

      await new Promise((r) => setTimeout(r, 150));
      stopPolling = true;
      await pollLoop;
      await stopEmailOutboxWorker(2000);

      expect(res.status).toBe(200);
      expect(eventOrder[0]).toBe('redis.setPx');
      expect(eventOrder[1]).toBe('prisma.$transaction');

      const tokenRow = await prisma.passwordResetToken.findFirst({
        where: { userId: user.id },
      });
      expect(tokenRow).not.toBeNull();

      const outbox = await prisma.emailOutbox.findUnique({
        where: { dedupeKey: `password_reset:${tokenRow!.id}` },
      });
      expect(outbox).not.toBeNull();
      expect(outbox!.status).toBe(EmailOutboxStatus.SENT);
      expect(outbox!.lastErrorCode).toBeNull();
      expect(emailService.getLatestPasswordResetEmail(user.email)).toBeDefined();
    });

    it('H-01: creates zero DB records and preserves identical uniform 200 response if Redis setPx fails', async () => {
      const user = await createTestUser();
      const redis = getRedisClient();

      const origSetPx = redis.setPx.bind(redis);
      vi.spyOn(redis, 'setPx').mockImplementation(async (key, val, ttl) => {
        if (key.startsWith(PASSWORD_RESET_DELIVERY_SECRET_PREFIX)) {
          throw new Error('ECONNRESET: Redis write failed');
        }
        return origSetPx(key, val, ttl);
      });

      const registeredRes = await request(app)
        .post('/api/auth/forgot-password')
        .set('X-Forwarded-For', '203.0.113.141')
        .send({ email: user.email });

      const unregisteredRes = await request(app)
        .post('/api/auth/forgot-password')
        .set('X-Forwarded-For', '203.0.113.142')
        .send({ email: `missing_${nanoid(6)}@outside.vip` });

      expect(registeredRes.status).toBe(200);
      expect(registeredRes.body).toEqual({
        success: true,
        data: {
          message: UNIFORM_FORGOT_PASSWORD_MESSAGE,
          expiresInMinutes: 30,
        },
      });
      expect(registeredRes.body).toEqual(unregisteredRes.body);

      const dbTokens = await prisma.passwordResetToken.findMany({ where: { userId: user.id } });
      const dbOutbox = await prisma.emailOutbox.findMany({ where: { recipientEmail: user.email } });
      expect(dbTokens).toHaveLength(0);
      expect(dbOutbox).toHaveLength(0);
    });

    it('H-01: performs best-effort Redis key cleanup if PostgreSQL transaction fails', async () => {
      const user = await createTestUser();
      const redis = getRedisClient();
      let capturedDeliveryKey: string | null = null;

      const origSetPx = redis.setPx.bind(redis);
      vi.spyOn(redis, 'setPx').mockImplementation(async (key, val, ttl) => {
        if (key.startsWith(PASSWORD_RESET_DELIVERY_SECRET_PREFIX)) {
          capturedDeliveryKey = key;
        }
        return origSetPx(key, val, ttl);
      });

      vi.spyOn(prisma, '$transaction').mockRejectedValueOnce(new Error('DB connection dropped'));

      const res = await request(app)
        .post('/api/auth/forgot-password')
        .set('X-Forwarded-For', '203.0.113.143')
        .send({ email: user.email });

      expect(res.status).toBe(500);
      expect(capturedDeliveryKey).toBeTruthy();
      expect(await redis.get(capturedDeliveryKey!)).toBeNull();
    });

    it('H-02: permanently fails when Redis get cleanly returns null, but schedules retry and preserves Redis key on transient Redis read errors until recovery', async () => {
      const user = await createTestUser();
      const redis = getRedisClient();

      // Case A: genuinely missing Redis secret (get returns null) -> FAILED_PERMANENT
      const origGet = redis.get.bind(redis);
      let stagedKeyA: string | null = null;
      const origSetPx = redis.setPx.bind(redis);
      vi.spyOn(redis, 'setPx').mockImplementation(async (key, val, ttl) => {
        if (key.startsWith(PASSWORD_RESET_DELIVERY_SECRET_PREFIX)) {
          stagedKeyA = key;
        }
        return origSetPx(key, val, ttl);
      });

      // Defer immediate dispatch by deleting staged key right after tx starts? Easier: use Resend failure on attempt 1
      // or simulate null during processClaimedEmailOutboxItem by pausing worker & blocking immediate dispatch via worker flag.
      startEmailOutboxWorker(60_000);
      await request(app)
        .post('/api/auth/forgot-password')
        .set('X-Forwarded-For', '203.0.113.144')
        .send({ email: user.email });
      await stopEmailOutboxWorker(0);

      expect(stagedKeyA).toBeTruthy();
      const outboxIdA = stagedKeyA!.slice(PASSWORD_RESET_DELIVERY_SECRET_PREFIX.length);
      await redis.del(stagedKeyA!);

      const missingStats = await runEmailOutboxPass({ workerId: 'missing-secret-worker' });
      expect(missingStats.failedPermanent).toBeGreaterThanOrEqual(1);
      const missingRow = await prisma.emailOutbox.findUnique({ where: { id: outboxIdA } });
      expect(missingRow!.status).toBe(EmailOutboxStatus.FAILED_PERMANENT);
      expect(missingRow!.lastErrorCode).toBe('RESET_DELIVERY_SECRET_UNAVAILABLE');

      // Case B: transient Redis get exception -> RETRY with backoff, Redis key preserved, recovery succeeds & deletes key
      emailService.resetSentPasswordResetEmails();
      let stagedKeyB: string | null = null;
      vi.restoreAllMocks();
      vi.spyOn(redis, 'setPx').mockImplementation(async (key, val, ttl) => {
        if (key.startsWith(PASSWORD_RESET_DELIVERY_SECRET_PREFIX)) {
          stagedKeyB = key;
        }
        return origSetPx(key, val, ttl);
      });

      startEmailOutboxWorker(60_000);
      await request(app)
        .post('/api/auth/forgot-password')
        .set('X-Forwarded-For', '203.0.113.145')
        .send({ email: user.email });
      await stopEmailOutboxWorker(0);

      expect(stagedKeyB).toBeTruthy();
      const outboxIdB = stagedKeyB!.slice(PASSWORD_RESET_DELIVERY_SECRET_PREFIX.length);

      vi.spyOn(redis, 'get').mockImplementationOnce(async (key) => {
        if (key === stagedKeyB) {
          throw new Error('Redis read timeout');
        }
        return origGet(key);
      });

      const retryStats = await runEmailOutboxPass({ workerId: 'transient-get-worker', randomFn: () => 0.5 });
      expect(retryStats.retried).toBe(1);

      const retriedRow = await prisma.emailOutbox.findUnique({ where: { id: outboxIdB } });
      expect(retriedRow!.status).toBe(EmailOutboxStatus.PENDING);
      expect(retriedRow!.attempts).toBe(1);
      expect(retriedRow!.lastErrorCode).toBe('REDIS_DELIVERY_READ_FAILED');
      expect(retriedRow!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
      // Redis key must remain preserved for retry!
      expect(await origGet(stagedKeyB!)).toBeTruthy();

      // Advance nextAttemptAt and recover cleanly
      await prisma.emailOutbox.update({
        where: { id: outboxIdB },
        data: { nextAttemptAt: new Date(Date.now() - 1000) },
      });
      const recoveredStats = await runEmailOutboxPass({ workerId: 'recovery-worker' });
      expect(recoveredStats.accepted).toBe(1);

      const sentRow = await prisma.emailOutbox.findUnique({ where: { id: outboxIdB } });
      expect(sentRow!.status).toBe(EmailOutboxStatus.SENT);
      expect(await origGet(stagedKeyB!)).toBeNull();
      expect(emailService.getLatestPasswordResetEmail(user.email)).toBeDefined();
    });

    it('H-02: respects lease ownership on transient Redis read failure and enforces retry exhaustion at maxAttempts', async () => {
      const user = await createTestUser();
      const redis = getRedisClient();
      const origSetPx = redis.setPx.bind(redis);
      let stagedKey: string | null = null;

      vi.spyOn(redis, 'setPx').mockImplementation(async (key, val, ttl) => {
        if (key.startsWith(PASSWORD_RESET_DELIVERY_SECRET_PREFIX)) {
          stagedKey = key;
        }
        return origSetPx(key, val, ttl);
      });

      startEmailOutboxWorker(60_000);
      await request(app)
        .post('/api/auth/forgot-password')
        .set('X-Forwarded-For', '203.0.113.146')
        .send({ email: user.email });
      await stopEmailOutboxWorker(0);

      const outboxId = stagedKey!.slice(PASSWORD_RESET_DELIVERY_SECRET_PREFIX.length);
      const processingRow = await prisma.emailOutbox.update({
        where: { id: outboxId },
        data: {
          status: EmailOutboxStatus.PROCESSING,
          lockedBy: 'new-lease-holder',
          attempts: 1,
        },
      });

      vi.spyOn(redis, 'get').mockRejectedValueOnce(new Error('Transient Redis timeout'));

      // Stale worker attempts processing while lockedBy belongs to 'new-lease-holder'
      const leaseOutcome = await processClaimedEmailOutboxItem(processingRow, 'stale-worker');
      expect(leaseOutcome).toBe('leaseLost');

      const untouched = await prisma.emailOutbox.findUnique({ where: { id: outboxId } });
      expect(untouched!.status).toBe(EmailOutboxStatus.PROCESSING);
      expect(untouched!.lockedBy).toBe('new-lease-holder');

      // Exhaustion check when attempts >= maxAttempts on transient Redis read failure
      const exhaustedRow = await prisma.emailOutbox.update({
        where: { id: outboxId },
        data: {
          status: EmailOutboxStatus.PROCESSING,
          lockedBy: 'exhaust-worker',
          attempts: processingRow.maxAttempts,
        },
      });
      vi.spyOn(redis, 'get').mockRejectedValueOnce(new Error('Persistent Redis outage'));
      const exhaustOutcome = await processClaimedEmailOutboxItem(exhaustedRow, 'exhaust-worker');
      expect(exhaustOutcome).toBe('failedPermanent');

      const failedRow = await prisma.emailOutbox.findUnique({ where: { id: outboxId } });
      expect(failedRow!.status).toBe(EmailOutboxStatus.FAILED_PERMANENT);
      expect(failedRow!.lastErrorCode).toBe('REDIS_DELIVERY_READ_FAILED');
    });
  });

  describe('6. M-01 Global Per-Email Soft Cap & Multi-IP Flood Isolation', () => {
    it('prevents 6 attacker IPs from suppressing a legitimate user reset on another IP', async () => {
      const user = await createTestUser();

      // 6 attacker IPs x 3 requests each = 18 requests (< 20 hourly soft cap)
      for (let ipIdx = 1; ipIdx <= 6; ipIdx++) {
        for (let attempt = 0; attempt < PASSWORD_RESET_REQ_IP_EMAIL_MAX; attempt++) {
          const attackerRes = await request(app)
            .post('/api/auth/forgot-password')
            .set('X-Forwarded-For', `198.51.100.${ipIdx}`)
            .send({ email: user.email });
          expect(attackerRes.status).toBe(200);
          expect(attackerRes.body.data.message).toBe(UNIFORM_FORGOT_PASSWORD_MESSAGE);
        }
      }

      // Legitimate user on separate IP still receives an email/token
      const legitRes = await request(app)
        .post('/api/auth/forgot-password')
        .set('X-Forwarded-For', '203.0.113.210')
        .send({ email: user.email });
      expect(legitRes.status).toBe(200);
      expect(legitRes.body.data.message).toBe(UNIFORM_FORGOT_PASSWORD_MESSAGE);

      const tokens = await prisma.passwordResetToken.findMany({ where: { userId: user.id } });
      expect(tokens).toHaveLength(19);
    });

    it('enforces global hourly soft cap of 20 quietly with uniform 200 response and zero extra emails', async () => {
      const user = await createTestUser();

      expect(PASSWORD_RESET_EMAIL_SOFT_CAP_MAX).toBe(20);
      expect(PASSWORD_RESET_EMAIL_SOFT_CAP_WINDOW_MS).toBe(60 * 60 * 1000);

      // Reach cap of 20 across distinct IPs (max 3 per IP+email pair)
      let sent = 0;
      for (let ipIdx = 10; sent < PASSWORD_RESET_EMAIL_SOFT_CAP_MAX; ipIdx++) {
        for (
          let attempt = 0;
          attempt < PASSWORD_RESET_REQ_IP_EMAIL_MAX && sent < PASSWORD_RESET_EMAIL_SOFT_CAP_MAX;
          attempt++
        ) {
          const res = await request(app)
            .post('/api/auth/forgot-password')
            .set('X-Forwarded-For', `198.51.100.${ipIdx}`)
            .send({ email: user.email });
          expect(res.status).toBe(200);
          sent++;
        }
      }

      // Request #21 from a clean IP is silently suppressed with identical response
      const suppressedRes = await request(app)
        .post('/api/auth/forgot-password')
        .set('X-Forwarded-For', '203.0.113.211')
        .send({ email: user.email });

      expect(suppressedRes.status).toBe(200);
      expect(suppressedRes.body).toEqual({
        success: true,
        data: {
          message: UNIFORM_FORGOT_PASSWORD_MESSAGE,
          expiresInMinutes: 30,
        },
      });

      const tokens = await prisma.passwordResetToken.findMany({ where: { userId: user.id } });
      expect(tokens).toHaveLength(PASSWORD_RESET_EMAIL_SOFT_CAP_MAX);

      const outboxCount = await prisma.emailOutbox.count({
        where: { recipientEmail: user.email, type: EmailOutboxType.PASSWORD_RESET },
      });
      expect(outboxCount).toBe(PASSWORD_RESET_EMAIL_SOFT_CAP_MAX);
    });

    it('recovers after 1-hour window expiry and handles concurrent burst near soft cap cleanly', async () => {
      const emailHash = hashRateLimitIdentifier(`cap_window_${nanoid(6)}@outside.vip`);
      const capKey = `pwreset_mail_cap:${emailHash}`;
      const baseMs = Date.now();

      // Consume 18 entries sequentially
      for (let i = 0; i < 18; i++) {
        const res = await checkRedisSlidingWindowRateLimit(
          capKey,
          PASSWORD_RESET_EMAIL_SOFT_CAP_MAX,
          PASSWORD_RESET_EMAIL_SOFT_CAP_WINDOW_MS,
          baseMs + i
        );
        expect(res.allowed).toBe(true);
      }

      // Concurrent 5-request burst with 2 remaining capacity -> at most 2 allowed, 3 blocked
      const burstResults = await Promise.all(
        Array.from({ length: 5 }, (_, idx) =>
          checkRedisSlidingWindowRateLimit(
            capKey,
            PASSWORD_RESET_EMAIL_SOFT_CAP_MAX,
            PASSWORD_RESET_EMAIL_SOFT_CAP_WINDOW_MS,
            baseMs + 100 + idx
          )
        )
      );
      expect(burstResults.filter((r) => r.allowed)).toHaveLength(2);
      expect(burstResults.filter((r) => !r.allowed)).toHaveLength(3);

      // After full 1h window expiry, soft cap recovers automatically
      const recovered = await checkRedisSlidingWindowRateLimit(
        capKey,
        PASSWORD_RESET_EMAIL_SOFT_CAP_MAX,
        PASSWORD_RESET_EMAIL_SOFT_CAP_WINDOW_MS,
        baseMs + PASSWORD_RESET_EMAIL_SOFT_CAP_WINDOW_MS + 5_000
      );
      expect(recovered.allowed).toBe(true);
      expect(recovered.count).toBe(1);
    });
  });

  describe('7. M-02 Durable Session Invalidation & Failure Modes', () => {
    it('rejects stale sessions after password reset even when post-commit Redis revocation & cache invalidation fail', async () => {
      const user = await createTestUser({ password: 'OldPassword123!' });
      const redis = getRedisClient();

      // Log in to obtain an active session before password reset
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ email: user.email, password: 'OldPassword123!' });
      expect(loginRes.status).toBe(200);
      const preResetCookie = `${SESSION_COOKIE_NAME}=${extractCookieValue(loginRes)}`;

      // Warm /api/auth/me succeeds before reset
      const preResetMe = await request(app).get('/api/auth/me').set('Cookie', preResetCookie);
      expect(preResetMe.status).toBe(200);
      expect(await getCachedUserSessionVersion(user.id)).toBe(0);

      // Request password reset
      const forgotRes = await request(app)
        .post('/api/auth/forgot-password')
        .set('X-Forwarded-For', '203.0.113.150')
        .send({ email: user.email });
      expect(forgotRes.status).toBe(200);

      const dispatched = emailService.getLatestPasswordResetEmail(user.email);
      expect(dispatched).toBeDefined();
      const rawToken = extractRawTokenFromUrl(dispatched!.resetUrl);

      // Simulate post-commit Redis outage during cache invalidation + session revocation
      vi.spyOn(redis, 'invalidateUserCacheAtomically').mockRejectedValue(
        new Error('Simulated Redis write outage during invalidation')
      );
      vi.spyOn(redis, 'smembers').mockRejectedValue(
        new Error('Simulated Redis outage during session listing')
      );
      vi.spyOn(redis, 'setPx').mockRejectedValue(
        new Error('Simulated Redis outage during version update')
      );

      const resetRes = await request(app)
        .post('/api/auth/reset-password')
        .set('X-Forwarded-For', '203.0.113.151')
        .send({
          token: rawToken,
          newPassword: 'DurableNewPassword2026!',
          confirmPassword: 'DurableNewPassword2026!',
        });
      expect(resetRes.status).toBe(200);

      // Restore Redis mocks to verify stale Redis session/cache records were left behind by the simulated failure
      vi.restoreAllMocks();

      // DB durably incremented sessionVersion and recorded passwordChangedAt
      const updatedUser = await prisma.user.findUnique({
        where: { id: user.id },
        select: { sessionVersion: true, passwordChangedAt: true },
      });
      expect(updatedUser!.sessionVersion).toBe(1);
      expect(updatedUser!.passwordChangedAt).toBeInstanceOf(Date);

      // Request #1: Immediate rejection via in-process emergency floor even with stale Redis cache
      const immediateStaleMe = await request(app).get('/api/auth/me').set('Cookie', preResetCookie);
      expect(immediateStaleMe.status).toBe(401);

      // Simulate another server instance or cold cache: clear emergency floor + delete cached user_sess_ver,
      // leaving only stale session record in Redis and stale auth cache
      clearEmergencySessionVersionFloorForTests();
      await redis.del(`${USER_SESSION_VERSION_PREFIX}${user.id}`);

      // Request #2: Durable PostgreSQL sessionVersion fallback still catches & rejects stale session
      const crossWorkerStaleMe = await request(app)
        .get('/api/auth/me')
        .set('Cookie', preResetCookie);
      expect(crossWorkerStaleMe.status).toBe(401);

      // Re-authenticating with the new password yields a session at sessionVersion=1 that passes /me
      const postResetLogin = await request(app)
        .post('/api/auth/login')
        .send({ email: user.email, password: 'DurableNewPassword2026!' });
      expect(postResetLogin.status).toBe(200);
      const freshCookie = `${SESSION_COOKIE_NAME}=${extractCookieValue(postResetLogin)}`;

      const freshMe = await request(app).get('/api/auth/me').set('Cookie', freshCookie);
      expect(freshMe.status).toBe(200);
      expect(freshMe.body.data.user.email).toBe(user.email);
      expect(await redis.get(`${USER_SESSION_VERSION_PREFIX}${user.id}`)).toBe('1');
    });

    it('changePassword increments sessionVersion and durably invalidates other active sessions', async () => {
      const user = await createTestUser({ password: 'ChangeMeStart123!' });
      const redis = getRedisClient();

      const loginA = await request(app)
        .post('/api/auth/login')
        .send({ email: user.email, password: 'ChangeMeStart123!' });
      const loginB = await request(app)
        .post('/api/auth/login')
        .send({ email: user.email, password: 'ChangeMeStart123!' });
      expect(loginA.status).toBe(200);
      expect(loginB.status).toBe(200);

      const cookieA = `${SESSION_COOKIE_NAME}=${extractCookieValue(loginA)}`;
      const cookieB = `${SESSION_COOKIE_NAME}=${extractCookieValue(loginB)}`;
      const csrfA = loginA.body.data.csrfToken as string;

      // Simulate Redis revocation failure during change-password
      vi.spyOn(redis, 'smembers').mockRejectedValue(new Error('Redis list sessions failure'));
      vi.spyOn(redis, 'invalidateUserCacheAtomically').mockRejectedValue(
        new Error('Redis cache invalidation failure')
      );

      const changeRes = await request(app)
        .post('/api/auth/change-password')
        .set('Cookie', cookieA)
        .set('x-csrf-token', csrfA)
        .send({
          currentPassword: 'ChangeMeStart123!',
          newPassword: 'ChangeMeUpdated456!',
        });
      expect(changeRes.status).toBe(200);
      vi.restoreAllMocks();

      // Other session (cookieB) must fail even if emergency floor is cleared
      clearEmergencySessionVersionFloorForTests();
      await redis.del(`${USER_SESSION_VERSION_PREFIX}${user.id}`);
      const meB = await request(app).get('/api/auth/me').set('Cookie', cookieB);
      expect(meB.status).toBe(401);

      const dbUser = await prisma.user.findUnique({
        where: { id: user.id },
        select: { sessionVersion: true, passwordChangedAt: true },
      });
      expect(dbUser!.sessionVersion).toBe(1);
      expect(dbUser!.passwordChangedAt).not.toBeNull();

      // Fresh login works cleanly
      const relogin = await request(app)
        .post('/api/auth/login')
        .send({ email: user.email, password: 'ChangeMeUpdated456!' });
      expect(relogin.status).toBe(200);
    });

    it('multi-instance M-02: rejects stale session on Instance B even when Redis still caches stale version 0 and old session after password reset or change', async () => {
      const user = await createTestUser({
        password: 'MultiInstanceStart123!',
        role: Role.ORGANIZER,
      });
      const redis = getRedisClient();

      // 1. Existing session S0 has sessionVersion=0 and Redis caches user_sess_ver=0 + user_auth_cache
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ email: user.email, password: 'MultiInstanceStart123!' });
      expect(loginRes.status).toBe(200);
      const staleCookie = `${SESSION_COOKIE_NAME}=${extractCookieValue(loginRes)}`;

      const warmRes = await request(app)
        .get('/api/organizer/events')
        .set('Cookie', staleCookie);
      expect(warmRes.status).toBe(200);
      expect(await redis.get(`${USER_SESSION_VERSION_PREFIX}${user.id}`)).toBe('0');
      expect(await redis.get(`${USER_AUTH_CACHE_PREFIX}${user.id}`)).not.toBeNull();

      // 2. Request reset and capture raw token
      await request(app)
        .post('/api/auth/forgot-password')
        .set('X-Forwarded-For', '203.0.113.157')
        .send({ email: user.email });
      const resetMail = emailService.getLatestPasswordResetEmail(user.email);
      const rawToken = extractRawTokenFromUrl(resetMail!.resetUrl);

      // 3. Simulate total post-commit Redis invalidation/cache/session-revocation failure so Redis
      // STILL keeps user_sess_ver:<userId>='0', warm user_auth_cache, and S0!
      const origDel = redis.del.bind(redis);
      vi.spyOn(redis, 'invalidateUserCacheAtomically').mockRejectedValue(
        new Error('Redis cache invalidation failure')
      );
      vi.spyOn(redis, 'setPx').mockRejectedValue(new Error('Redis cache setPx failure'));
      vi.spyOn(redis, 'smembers').mockRejectedValue(new Error('Redis session lookup failure'));
      vi.spyOn(redis, 'del').mockImplementation(async (...keys: string[]) => {
        if (keys.some((k) => k.startsWith(USER_SESSION_VERSION_PREFIX) || k.startsWith(USER_AUTH_CACHE_PREFIX))) {
          throw new Error('Redis del failure');
        }
        return origDel(...keys);
      });

      const resetRes = await request(app)
        .post('/api/auth/reset-password')
        .set('X-Forwarded-For', '203.0.113.158')
        .send({
          token: rawToken,
          newPassword: 'MultiInstanceReset2026!',
          confirmPassword: 'MultiInstanceReset2026!',
        });
      expect(resetRes.status).toBe(200);

      // Restore Redis spies and verify Redis LITERALLY still contains stale version '0' and S0
      vi.restoreAllMocks();
      expect(await redis.get(`${USER_SESSION_VERSION_PREFIX}${user.id}`)).toBe('0');
      expect(await redis.get(`${USER_AUTH_CACHE_PREFIX}${user.id}`)).not.toBeNull();
      expect((await listUserSessions(user.id)).length).toBeGreaterThanOrEqual(1);

      // Verify PostgreSQL committed User.sessionVersion=1 and SessionInvalidation.minSessionVersion=1
      const invalidationRow = await prisma.sessionInvalidation.findUnique({
        where: { userId: user.id },
      });
      expect(invalidationRow?.minSessionVersion).toBe(1);

      // 4. Simulate Instance B (brand new app process -> zero in-memory floor from Instance A)
      // receiving S0 while Redis still holds stale version '0' on BOTH ordinary cached routes
      // (/api/organizer/events, /api/auth/sessions) AND sensitive routes (/api/auth/me).
      clearEmergencySessionVersionFloorForTests();
      const instanceBEventsRes = await request(app)
        .get('/api/organizer/events')
        .set('Cookie', staleCookie);
      expect(instanceBEventsRes.status).toBe(401);

      // Clear local floor again to prove /api/auth/sessions also rejects independently without Instance B memory
      clearEmergencySessionVersionFloorForTests();
      const instanceBSessionsRes = await request(app)
        .get('/api/auth/sessions')
        .set('Cookie', staleCookie);
      expect(instanceBSessionsRes.status).toBe(401);

      // 5. Repeat multi-instance stale-Redis test for POST /api/auth/change-password
      const reloginRes = await request(app)
        .post('/api/auth/login')
        .send({ email: user.email, password: 'MultiInstanceReset2026!' });
      expect(reloginRes.status).toBe(200);
      const session1CookieA = `${SESSION_COOKIE_NAME}=${extractCookieValue(reloginRes)}`;
      const csrfA = reloginRes.body.data.csrfToken as string;

      const loginBRes = await request(app)
        .post('/api/auth/login')
        .send({ email: user.email, password: 'MultiInstanceReset2026!' });
      expect(loginBRes.status).toBe(200);
      const session1CookieB = `${SESSION_COOKIE_NAME}=${extractCookieValue(loginBRes)}`;

      expect(await redis.get(`${USER_SESSION_VERSION_PREFIX}${user.id}`)).toBe('1');

      // Fail Redis writes/invalidations during change-password so Redis STILL caches version '1'
      vi.spyOn(redis, 'invalidateUserCacheAtomically').mockRejectedValue(
        new Error('Redis cache invalidation failure')
      );
      vi.spyOn(redis, 'smembers').mockRejectedValue(new Error('Redis smembers failure'));
      vi.spyOn(redis, 'del').mockImplementation(async (...keys: string[]) => {
        if (keys.some((k) => k.startsWith(USER_SESSION_VERSION_PREFIX) || k.startsWith(USER_AUTH_CACHE_PREFIX))) {
          throw new Error('Redis del failure');
        }
        return origDel(...keys);
      });
      const origSetPx = redis.setPx.bind(redis);
      vi.spyOn(redis, 'setPx').mockImplementation(async (k, v, ttl) => {
        if (k.startsWith(USER_SESSION_VERSION_PREFIX) || k.startsWith(USER_AUTH_CACHE_PREFIX)) {
          throw new Error('Redis setPx cache failure');
        }
        return origSetPx(k, v, ttl);
      });

      const changeRes = await request(app)
        .post('/api/auth/change-password')
        .set('Cookie', session1CookieA)
        .set('x-csrf-token', csrfA)
        .send({
          currentPassword: 'MultiInstanceReset2026!',
          newPassword: 'MultiInstanceChanged2026!',
        });
      expect(changeRes.status).toBe(200);
      vi.restoreAllMocks();

      // Redis STILL holds stale version '1' while PostgreSQL holds minSessionVersion='2'
      expect(await redis.get(`${USER_SESSION_VERSION_PREFIX}${user.id}`)).toBe('1');
      const invalidationAfterChange = await prisma.sessionInvalidation.findUnique({
        where: { userId: user.id },
      });
      expect(invalidationAfterChange?.minSessionVersion).toBe(2);

      // Instance B (no local floor) rejects old session1CookieB on /api/organizer/events
      clearEmergencySessionVersionFloorForTests();
      const instanceBAfterChange = await request(app)
        .get('/api/organizer/events')
        .set('Cookie', session1CookieB);
      expect(instanceBAfterChange.status).toBe(401);

      // Fresh login at version=2 succeeds cleanly on Instance B
      const postChangeLogin = await request(app)
        .post('/api/auth/login')
        .send({ email: user.email, password: 'MultiInstanceChanged2026!' });
      expect(postChangeLogin.status).toBe(200);
      const validV2Cookie = `${SESSION_COOKIE_NAME}=${extractCookieValue(postChangeLogin)}`;

      clearEmergencySessionVersionFloorForTests();
      const instanceBV2Ok = await request(app)
        .get('/api/organizer/events')
        .set('Cookie', validV2Cookie);
      expect(instanceBV2Ok.status).toBe(200);
    });

    it('keeps active sessions valid when no password change occurs and blocks OTP after passwordless reset', async () => {
      // 1. Active session without password change stays valid even if user_sess_ver is evicted
      const regularUser = await createTestUser({ password: 'StablePassword123!' });
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ email: regularUser.email, password: 'StablePassword123!' });
      expect(loginRes.status).toBe(200);
      const regularCookie = `${SESSION_COOKIE_NAME}=${extractCookieValue(loginRes)}`;

      await getRedisClient().del(`${USER_SESSION_VERSION_PREFIX}${regularUser.id}`);
      const stillValidMe = await request(app).get('/api/auth/me').set('Cookie', regularCookie);
      expect(stillValidMe.status).toBe(200);

      // 2. Passwordless user resetting password sets sessionVersion=1, invalidates prior OTP session,
      // and blocks subsequent login-OTP generation because account now has a passwordHash.
      const otpUser = await createTestUser({ password: null });
      const otpSession = await createSession({
        userId: otpUser.id,
        sessionVersion: 0,
      });
      const otpCookie = `${SESSION_COOKIE_NAME}=${otpSession.rawCookieValue}`;

      expect((await request(app).get('/api/auth/me').set('Cookie', otpCookie)).status).toBe(200);

      await request(app)
        .post('/api/auth/forgot-password')
        .set('X-Forwarded-For', '203.0.113.152')
        .send({ email: otpUser.email });
      const otpResetEmail = emailService.getLatestPasswordResetEmail(otpUser.email);
      expect(otpResetEmail).toBeDefined();
      const rawOtpResetToken = extractRawTokenFromUrl(otpResetEmail!.resetUrl);

      const resetRes = await request(app)
        .post('/api/auth/reset-password')
        .set('X-Forwarded-For', '203.0.113.153')
        .send({
          token: rawOtpResetToken,
          newPassword: 'PasswordlessNowSet2026!',
          confirmPassword: 'PasswordlessNowSet2026!',
        });
      expect(resetRes.status).toBe(200);

      // Old OTP session is rejected
      expect((await request(app).get('/api/auth/me').set('Cookie', otpCookie)).status).toBe(401);

      // Requesting login OTP now creates zero OTP state because passwordHash is non-null
      const otpReqRes = await request(app)
        .post('/api/auth/otp/request')
        .set('X-Forwarded-For', '203.0.113.154')
        .send({ email: otpUser.email });
      expect(otpReqRes.status).toBe(200);
      expect(await getRedisClient().get(`auth_login_otp:${otpUser.id}`)).toBeNull();
    });

    it('concurrent password reset and authenticated /me request converges cleanly with stale session rejected', async () => {
      const user = await createTestUser({ password: 'RacePassword123!' });
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ email: user.email, password: 'RacePassword123!' });
      expect(loginRes.status).toBe(200);
      const staleCookie = `${SESSION_COOKIE_NAME}=${extractCookieValue(loginRes)}`;

      await request(app)
        .post('/api/auth/forgot-password')
        .set('X-Forwarded-For', '203.0.113.155')
        .send({ email: user.email });
      const resetMail = emailService.getLatestPasswordResetEmail(user.email);
      const rawToken = extractRawTokenFromUrl(resetMail!.resetUrl);

      const [resetOutcome, concurrentMe] = await Promise.all([
        request(app)
          .post('/api/auth/reset-password')
          .set('X-Forwarded-For', '203.0.113.156')
          .send({
            token: rawToken,
            newPassword: 'RacePasswordUpdated2026!',
            confirmPassword: 'RacePasswordUpdated2026!',
          }),
        request(app).get('/api/auth/me').set('Cookie', staleCookie),
      ]);

      expect(resetOutcome.status).toBe(200);
      expect([200, 401]).toContain(concurrentMe.status);

      // Every request after commit is guaranteed rejected (also clear warm auth cache edge case)
      await getRedisClient().del(`${USER_AUTH_CACHE_PREFIX}${user.id}`);
      const postCommitMe = await request(app).get('/api/auth/me').set('Cookie', staleCookie);
      expect(postCommitMe.status).toBe(401);
    });
  });

  describe('8. L-01 Periodic Expired Token Cleanup Worker', () => {
    it('purges expired tokens past retention window while keeping active & recent tokens intact', async () => {
      const user = await createTestUser();

      const oldExpiredToken = await prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: hashPasswordResetToken(`old_expired_${nanoid(16)}`),
          expiresAt: new Date(Date.now() - PASSWORD_RESET_RETENTION_MS - 60_000),
        },
      });
      const recentExpiredToken = await prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: hashPasswordResetToken(`recent_expired_${nanoid(16)}`),
          expiresAt: new Date(Date.now() - 60_000),
        },
      });
      const activeToken = await prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: hashPasswordResetToken(`active_${nanoid(16)}`),
          expiresAt: new Date(Date.now() + PASSWORD_RESET_EXPIRY_MS),
        },
      });

      const purged = await runPasswordResetCleanupPass();
      expect(purged).toBeGreaterThanOrEqual(1);

      expect(
        await prisma.passwordResetToken.findUnique({ where: { id: oldExpiredToken.id } })
      ).toBeNull();
      expect(
        await prisma.passwordResetToken.findUnique({ where: { id: recentExpiredToken.id } })
      ).not.toBeNull();
      expect(
        await prisma.passwordResetToken.findUnique({ where: { id: activeToken.id } })
      ).not.toBeNull();
    });

    it('guards against overlapping runs, logs safely on DB error, and starts/stops cleanly', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      let releaseDelete!: () => void;
      const blockedDelete = new Promise<void>((resolve) => {
        releaseDelete = resolve;
      });

      const purgeStub = vi
        .fn<() => Promise<number>>()
        .mockImplementationOnce(async () => {
          await blockedDelete;
          return 2;
        })
        .mockRejectedValueOnce(new Error('Transient Postgres maintenance restart'));

      const firstRunPromise = runPasswordResetCleanupPass(purgeStub);
      // Give event loop one tick so firstRun sets in-flight flag
      await new Promise((r) => setTimeout(r, 10));
      const overlappingRunCount = await runPasswordResetCleanupPass(purgeStub);
      expect(overlappingRunCount).toBe(0);

      releaseDelete();
      expect(await firstRunPromise).toBe(2);

      // Subsequent run encounters DB error -> catches and returns 0 without throwing
      expect(await runPasswordResetCleanupPass(purgeStub)).toBe(0);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[PasswordResetCleanup] Cleanup pass failed:')
      );
      expect(purgeStub).toHaveBeenCalledTimes(2);

      // Worker lifecycle start / stop
      expect(isPasswordResetCleanupWorkerRunning()).toBe(false);
      startPasswordResetCleanupWorker(60_000, 60_000);
      expect(isPasswordResetCleanupWorkerRunning()).toBe(true);
      await stopPasswordResetCleanupWorker(1_000);
      expect(isPasswordResetCleanupWorkerRunning()).toBe(false);
    });
  });

  describe('9. L-02 Redis Delivery Secret Lifecycle Cleanup', () => {
    it('deletes staged Redis delivery secrets when completePasswordReset cancels prior PENDING outbox rows', async () => {
      process.env.RESEND_API_KEY = 're_test_mock_key_l02_cancel';
      process.env.EMAIL_FROM = 'Outside.vip <noreply@outside.vip>';
      emailService.setEmailServiceTestOptions({
        useResendInTest: true,
        timeoutMs: 2000,
        retryDelayMs: 0,
        maxRetries: 0,
      });
      const user = await createTestUser();
      const redis = getRedisClient();

      // Request #1 fails transiently against Resend -> remains PENDING with delivery secret staged
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new globalThis.Response(JSON.stringify({ message: 'Upstream 503' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        })
      );

      await request(app)
        .post('/api/auth/forgot-password')
        .set('X-Forwarded-For', '203.0.113.160')
        .send({ email: user.email });

      vi.restoreAllMocks();
      emailService.resetEmailServiceTestOptions();
      delete process.env.RESEND_API_KEY;

      // Request #2 dispatches via in-memory test transport so we obtain a valid token,
      // while Request #1 remains PENDING in backoff
      await request(app)
        .post('/api/auth/forgot-password')
        .set('X-Forwarded-For', '203.0.113.161')
        .send({ email: user.email });

      const outboxRows = await prisma.emailOutbox.findMany({
        where: { recipientEmail: user.email, type: EmailOutboxType.PASSWORD_RESET },
        orderBy: { createdAt: 'asc' },
      });
      expect(outboxRows).toHaveLength(2);
      const pendingRow = outboxRows[0];
      expect(pendingRow.status).toBe(EmailOutboxStatus.PENDING);

      const pendingSecretKey = `${PASSWORD_RESET_DELIVERY_SECRET_PREFIX}${pendingRow.id}`;
      expect(await redis.get(pendingSecretKey)).toBeTruthy();

      const dispatchedEmail = emailService.getLatestPasswordResetEmail(user.email);
      const rawToken = extractRawTokenFromUrl(dispatchedEmail!.resetUrl);

      const resetRes = await request(app)
        .post('/api/auth/reset-password')
        .set('X-Forwarded-For', '203.0.113.162')
        .send({
          token: rawToken,
          newPassword: 'CancelPendingOutbox2026!',
          confirmPassword: 'CancelPendingOutbox2026!',
        });
      expect(resetRes.status).toBe(200);

      const updatedPendingRow = await prisma.emailOutbox.findUnique({
        where: { id: pendingRow.id },
      });
      expect(updatedPendingRow!.status).toBe(EmailOutboxStatus.CANCELLED);
      // L-02: staged Redis delivery secret must be deleted proactively when cancelled
      expect(await redis.get(pendingSecretKey)).toBeNull();
    });

    it('deletes staged Redis delivery secret when reapExpiredExhaustedLeases marks an exhausted lease FAILED_PERMANENT', async () => {
      process.env.RESEND_API_KEY = 're_test_mock_key_l02_reap';
      process.env.EMAIL_FROM = 'Outside.vip <noreply@outside.vip>';
      emailService.setEmailServiceTestOptions({
        useResendInTest: true,
        timeoutMs: 2000,
        retryDelayMs: 0,
        maxRetries: 0,
      });
      const user = await createTestUser();
      const redis = getRedisClient();

      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new globalThis.Response(JSON.stringify({ message: 'Transient 500' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        })
      );

      await request(app)
        .post('/api/auth/forgot-password')
        .set('X-Forwarded-For', '203.0.113.163')
        .send({ email: user.email });

      vi.restoreAllMocks();
      emailService.resetEmailServiceTestOptions();

      const row = await prisma.emailOutbox.findFirst({
        where: { recipientEmail: user.email, type: EmailOutboxType.PASSWORD_RESET },
      });
      expect(row).not.toBeNull();

      const deliveryKey = `${PASSWORD_RESET_DELIVERY_SECRET_PREFIX}${row!.id}`;
      expect(await redis.get(deliveryKey)).toBeTruthy();

      // Simulate crashed worker leaving an expired PROCESSING lease at attempts >= maxAttempts
      await prisma.emailOutbox.update({
        where: { id: row!.id },
        data: {
          status: EmailOutboxStatus.PROCESSING,
          attempts: row!.maxAttempts,
          lockedBy: 'crashed-worker',
          lastAttemptAt: new Date(Date.now() - 10 * 60 * 1000),
          lockedUntil: new Date(Date.now() - 60 * 1000),
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });

      const reaped = await reapExpiredExhaustedLeases();
      expect(reaped).toBeGreaterThanOrEqual(1);

      const finalRow = await prisma.emailOutbox.findUnique({ where: { id: row!.id } });
      expect(finalRow!.status).toBe(EmailOutboxStatus.FAILED_PERMANENT);
      expect(finalRow!.lastErrorCode).toBe('WORKER_LEASE_EXPIRED_MAX_ATTEMPTS');
      expect(await redis.get(deliveryKey)).toBeNull();
    });
  });
});
