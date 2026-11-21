import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { Role, AccountStatus } from '@prisma/client';
import { app } from '../app.js';
import { prisma } from '../db/prisma.js';
import * as sessionService from '../lib/session.service.js';
import * as emailService from '../lib/email.service.js';
import * as redisModule from '../lib/redis.js';
import { ServiceUnavailableError } from '../utils/errors.js';
import {
  LOGIN_OTP_PREFIX,
  hashLoginOtp,
} from '../modules/auth/auth.controller.js';

describe('Stage 1: Standalone Passwordless Email-OTP Authentication', () => {
  const passwordlessUser = {
    id: 'user-pwless-scanner-001',
    email: 'scanner.staff@outside.vip',
    name: 'Gate Scanner',
    passwordHash: null,
    role: Role.ATTENDEE,
    status: AccountStatus.ACTIVE,
    emailVerified: true,
    emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
    avatarUrl: null,
    organizer: null,
  };

  beforeEach(async () => {
    vi.restoreAllMocks();
    redisModule.setSimulatedRedisFailure(false);
    emailService.resetSentLoginOtpEmails();
    emailService.resetSentVerificationEmails();
    const redis = redisModule.getRedisClient();
    if (redis.flushAllForTests) {
      await redis.flushAllForTests();
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    redisModule.setSimulatedRedisFailure(false);
    emailService.resetSentLoginOtpEmails();
    const redis = redisModule.getRedisClient();
    if (redis.flushAllForTests) {
      await redis.flushAllForTests();
    }
  });

  describe('1. OTP Request Eligibility, Cooldown & Anti-Enumeration (POST /api/auth/otp/request)', () => {
    it('issues a 6-digit OTP email and stores generation-tagged HMAC hash in Redis for an existing ACTIVE passwordless account', async () => {
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(passwordlessUser as any);

      const res = await request(app)
        .post('/api/auth/otp/request')
        .send({ email: '  Scanner.Staff@Outside.VIP  ' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.cooldownSeconds).toBe(60);
      expect(res.body.data.expiresInMinutes).toBe(10);
      expect(res.body.data.message).toContain('6-digit sign-in code');

      expect(emailService.sentLoginOtpEmails).toHaveLength(1);
      const sent = emailService.sentLoginOtpEmails[0];
      expect(sent.to).toBe(passwordlessUser.email);
      expect(sent.code).toMatch(/^\d{6}$/);
      expect(sent.subject).toContain(sent.code);

      const rawStored = await redisModule
        .getRedisClient()
        .get(`${LOGIN_OTP_PREFIX}${passwordlessUser.id}`);
      expect(rawStored).toBeTruthy();
      const parsed = JSON.parse(rawStored!);
      expect(parsed.generationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(parsed.codeHash).toBe(hashLoginOtp(passwordlessUser.id, sent.code));
      expect(parsed.codeHash).not.toContain(sent.code);
      expect(parsed.attempts).toBe(0);
      expect(parsed.expiresAt - parsed.issuedAt).toBe(10 * 60 * 1000);
    });

    it('returns the exact same public 200 response for a nonexistent email without issuing an OTP', async () => {
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(passwordlessUser as any);
      const eligibleRes = await request(app)
        .post('/api/auth/otp/request')
        .send({ email: passwordlessUser.email });

      emailService.resetSentLoginOtpEmails();
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(null);
      const missingRes = await request(app)
        .post('/api/auth/otp/request')
        .send({ email: 'does.not.exist@outside.vip' });

      expect(missingRes.status).toBe(200);
      expect(missingRes.body).toEqual(eligibleRes.body);
      expect(emailService.sentLoginOtpEmails).toHaveLength(0);
    });

    it('does not issue an OTP for an existing password-based account and returns uniform 200 response', async () => {
      const passwordUser = {
        ...passwordlessUser,
        id: 'user-organizer-pw-002',
        email: 'organizer@outside.vip',
        passwordHash: '$2a$10$existingbcryptpasswordhash',
        role: Role.ORGANIZER,
      };
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(passwordUser as any);

      const res = await request(app)
        .post('/api/auth/otp/request')
        .send({ email: passwordUser.email });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(emailService.sentLoginOtpEmails).toHaveLength(0);

      const stored = await redisModule
        .getRedisClient()
        .get(`${LOGIN_OTP_PREFIX}${passwordUser.id}`);
      expect(stored).toBeNull();
    });

    it('does not issue an OTP for a SUSPENDED or DISABLED passwordless account and returns uniform 200 response', async () => {
      const suspendedUser = {
        ...passwordlessUser,
        id: 'user-suspended-003',
        email: 'suspended@outside.vip',
        status: AccountStatus.SUSPENDED,
      };
      const disabledUser = {
        ...passwordlessUser,
        id: 'user-disabled-004',
        email: 'disabled@outside.vip',
        status: AccountStatus.DISABLED,
      };

      vi.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(suspendedUser as any);
      const resSuspended = await request(app)
        .post('/api/auth/otp/request')
        .send({ email: suspendedUser.email });

      vi.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(disabledUser as any);
      const resDisabled = await request(app)
        .post('/api/auth/otp/request')
        .send({ email: disabledUser.email });

      expect(resSuspended.status).toBe(200);
      expect(resDisabled.status).toBe(200);
      expect(resSuspended.body).toEqual(resDisabled.body);
      expect(emailService.sentLoginOtpEmails).toHaveLength(0);
      expect(
        await redisModule.getRedisClient().get(`${LOGIN_OTP_PREFIX}${suspendedUser.id}`)
      ).toBeNull();
      expect(
        await redisModule.getRedisClient().get(`${LOGIN_OTP_PREFIX}${disabledUser.id}`)
      ).toBeNull();
    });

    it('handles concurrent resend/request operations safely so exactly one succeeds and others hit uniform 429 cooldown', async () => {
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(passwordlessUser as any);

      const [r1, r2, r3] = await Promise.all([
        request(app).post('/api/auth/otp/request').send({ email: passwordlessUser.email }),
        request(app).post('/api/auth/otp/request').send({ email: passwordlessUser.email }),
        request(app).post('/api/auth/otp/request').send({ email: passwordlessUser.email }),
      ]);

      const statuses = [r1.status, r2.status, r3.status].sort();
      expect(statuses).toEqual([200, 429, 429]);
      expect(emailService.sentLoginOtpEmails).toHaveLength(1);

      const rejected = [r1, r2, r3].filter((r) => r.status === 429);
      for (const rej of rejected) {
        expect(rej.body.error.code).toBe('OTP_RESEND_COOLDOWN');
      }
    });

    it('does not expose account existence via lock or cooldown responses across nonexistent, password-based, suspended, disabled, and eligible accounts', async () => {
      const accounts: Array<{ label: string; email: string; dbRecord: any }> = [
        { label: 'nonexistent', email: 'enum-none@outside.vip', dbRecord: null },
        {
          label: 'password-based',
          email: 'enum-pw@outside.vip',
          dbRecord: { ...passwordlessUser, id: 'enum-pw', email: 'enum-pw@outside.vip', passwordHash: '$2a$10$hash' },
        },
        {
          label: 'suspended',
          email: 'enum-susp@outside.vip',
          dbRecord: { ...passwordlessUser, id: 'enum-susp', email: 'enum-susp@outside.vip', status: AccountStatus.SUSPENDED },
        },
        {
          label: 'disabled',
          email: 'enum-dis@outside.vip',
          dbRecord: { ...passwordlessUser, id: 'enum-dis', email: 'enum-dis@outside.vip', status: AccountStatus.DISABLED },
        },
        {
          label: 'eligible',
          email: 'enum-ok@outside.vip',
          dbRecord: { ...passwordlessUser, id: 'enum-ok', email: 'enum-ok@outside.vip' },
        },
      ];

      for (const acct of accounts) {
        const redis = redisModule.getRedisClient();
        if (redis.flushAllForTests) await redis.flushAllForTests();
        vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(acct.dbRecord);

        // Concurrent /otp/request -> always exactly one 200 and one 429 OTP_RESEND_COOLDOWN (never 409)
        const [reqA, reqB] = await Promise.all([
          request(app).post('/api/auth/otp/request').send({ email: acct.email }),
          request(app).post('/api/auth/otp/request').send({ email: acct.email }),
        ]);
        expect([reqA.status, reqB.status].sort()).toEqual([200, 429]);
        const cdResp = reqA.status === 429 ? reqA : reqB;
        expect(cdResp.body.error.code).toBe('OTP_RESEND_COOLDOWN');

        // Concurrent /otp/verify with wrong code -> always uniform 400 INVALID_OTP_CODE (never 409)
        const [verA, verB] = await Promise.all([
          request(app).post('/api/auth/otp/verify').send({ email: acct.email, code: '999999' }),
          request(app).post('/api/auth/otp/verify').send({ email: acct.email, code: '888888' }),
        ]);
        expect([verA.status, verB.status]).toEqual([400, 400]);
        expect(verA.body.error.code).toBe('INVALID_OTP_CODE');
        expect(verB.body.error.code).toBe('INVALID_OTP_CODE');
      }
    });

    it('ensures cooldown retries do not exhaust the 15-minute email quota', async () => {
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(passwordlessUser as any);
      const emailHash = sessionService.hashRateLimitIdentifier(passwordlessUser.email);
      const cooldownRedisKey = `cooldown:auth_login_otp:${emailHash}`;
      const ipBurstKey = `ratelimit:auth_otp_req_ip_burst:${sessionService.hashRateLimitIdentifier('::ffff:127.0.0.1')}`;

      // 1st legitimate request succeeds
      const first = await request(app)
        .post('/api/auth/otp/request')
        .send({ email: passwordlessUser.email });
      expect(first.status).toBe(200);

      // 4 rapid retries during cooldown hit 429 OTP_RESEND_COOLDOWN and must NOT consume email 15m quota
      for (let i = 0; i < 4; i++) {
        const retry = await request(app)
          .post('/api/auth/otp/request')
          .send({ email: passwordlessUser.email });
        expect(retry.status).toBe(429);
        expect(retry.body.error.code).toBe('OTP_RESEND_COOLDOWN');
      }

      // After cooldown expires (and burst resets), 4 more distinct requests MUST still succeed
      // proving the 4 cooldown retries did not consume the 5-per-15m email quota
      const redis = redisModule.getRedisClient();
      for (let i = 0; i < 4; i++) {
        await redis.del(cooldownRedisKey, ipBurstKey);
        const next = await request(app)
          .post('/api/auth/otp/request')
          .send({ email: passwordlessUser.email });
        expect(next.status).toBe(200);
      }

      // 6th actual request within 15m now hits the 5-per-15m email rate limit
      await redis.del(cooldownRedisKey, ipBurstKey);
      const sixth = await request(app)
        .post('/api/auth/otp/request')
        .send({ email: passwordlessUser.email });
      expect(sixth.status).toBe(429);
      expect(sixth.body.error.code).toBe('OTP_RATE_LIMIT');
    });

    it('preserves a previously active OTP on email delivery failure and releases only its own cooldown', async () => {
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(passwordlessUser as any);
      const redis = redisModule.getRedisClient();
      const emailHash = sessionService.hashRateLimitIdentifier(passwordlessUser.email);
      const cooldownRedisKey = `cooldown:auth_login_otp:${emailHash}`;

      // 1. Issue OTP_1 successfully
      const first = await request(app)
        .post('/api/auth/otp/request')
        .send({ email: passwordlessUser.email });
      expect(first.status).toBe(200);
      const otp1 = emailService.sentLoginOtpEmails[0].code;

      // Simulate cooldown expiry before resend
      await redis.del(cooldownRedisKey);

      // 2. Resend fails during email delivery -> OTP_1 must be restored intact & cooldown released
      vi.spyOn(emailService, 'sendLoginOtpEmail').mockRejectedValueOnce(new Error('Resend 503'));
      const failedResend = await request(app)
        .post('/api/auth/otp/request')
        .send({ email: passwordlessUser.email });
      expect(failedResend.status).toBe(503);
      expect(failedResend.body.error.code).toBe('EMAIL_DELIVERY_FAILED');

      // Cooldown was released so user can retry immediately if desired
      expect(await redis.get(cooldownRedisKey)).toBeNull();

      // OTP_1 is still valid and authenticates cleanly
      const verifyOtp1 = await request(app)
        .post('/api/auth/otp/verify')
        .send({ email: passwordlessUser.email, code: otp1 });
      expect(verifyOtp1.status).toBe(200);
      expect(verifyOtp1.body.data.user.id).toBe(passwordlessUser.id);
    });

    it('does not clobber newer OTP state or another request cooldown when slow email delivery fails after a competing change', async () => {
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(passwordlessUser as any);
      const redis = redisModule.getRedisClient();
      const otpKey = `${LOGIN_OTP_PREFIX}${passwordlessUser.id}`;
      const emailHash = sessionService.hashRateLimitIdentifier(passwordlessUser.email);
      const cooldownRedisKey = `cooldown:auth_login_otp:${emailHash}`;

      // Seed an active OTP_1
      const otp1 = '111222';
      await redis.setPx(
        otpKey,
        JSON.stringify({
          generationId: 'gen-prior-1',
          codeHash: hashLoginOtp(passwordlessUser.id, otp1),
          issuedAt: Date.now() - 5000,
          expiresAt: Date.now() + 500_000,
          attempts: 0,
        }),
        500_000
      );

      // While Request A's email send is in flight, a competing request replaces otpKey with OTP_3
      // and installs its own cooldown owner token.
      const otp3 = '333444';
      const competingCooldownOwner = 'competing-owner-token-999';
      vi.spyOn(emailService, 'sendLoginOtpEmail').mockImplementationOnce(async () => {
        await redis.setPx(
          otpKey,
          JSON.stringify({
            generationId: 'gen-competing-3',
            codeHash: hashLoginOtp(passwordlessUser.id, otp3),
            issuedAt: Date.now(),
            expiresAt: Date.now() + 600_000,
            attempts: 0,
          }),
          600_000
        );
        await redis.setPx(cooldownRedisKey, competingCooldownOwner, 60_000);
        throw new Error('Slow SMTP timeout after competing update');
      });

      const failedSlowReq = await request(app)
        .post('/api/auth/otp/request')
        .send({ email: passwordlessUser.email });
      expect(failedSlowReq.status).toBe(503);
      expect(failedSlowReq.body.error.code).toBe('EMAIL_DELIVERY_FAILED');

      // Competing request's cooldown MUST still be intact (ownership-verified release did not delete it)
      expect(await redis.get(cooldownRedisKey)).toBe(competingCooldownOwner);

      // Competing OTP_3 MUST still be intact (rollback did NOT restore OTP_1 or delete OTP_3)
      const storedAfter = JSON.parse((await redis.get(otpKey))!);
      expect(storedAfter.generationId).toBe('gen-competing-3');

      const verifyOtp3 = await request(app)
        .post('/api/auth/otp/verify')
        .send({ email: passwordlessUser.email, code: otp3 });
      expect(verifyOtp3.status).toBe(200);
    });

    it('does not resurrect a consumed OTP when slow email delivery fails after otpKey was deleted', async () => {
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(passwordlessUser as any);
      const redis = redisModule.getRedisClient();
      const otpKey = `${LOGIN_OTP_PREFIX}${passwordlessUser.id}`;

      const priorCode = '556677';
      await redis.setPx(
        otpKey,
        JSON.stringify({
          generationId: 'gen-old-prior',
          codeHash: hashLoginOtp(passwordlessUser.id, priorCode),
          issuedAt: Date.now() - 5000,
          expiresAt: Date.now() + 500_000,
          attempts: 0,
        }),
        500_000
      );

      // Simulate otpKey being consumed while slow email send fails
      vi.spyOn(emailService, 'sendLoginOtpEmail').mockImplementationOnce(async () => {
        await redis.del(otpKey);
        throw new Error('SMTP failure after consumption');
      });

      const res = await request(app)
        .post('/api/auth/otp/request')
        .send({ email: passwordlessUser.email });
      expect(res.status).toBe(503);

      // Prior OTP must NOT be resurrected
      expect(await redis.get(otpKey)).toBeNull();
    });
  });

  describe('2. Atomic OTP Verification, Concurrency & Session Security (POST /api/auth/otp/verify)', () => {
    it('verifies a valid 6-digit OTP, rotates pre-existing session, sets __Host-outside_sid + CSRF, and never creates duplicate accounts', async () => {
      const userCreateSpy = vi.spyOn(prisma.user, 'create');
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(passwordlessUser as any);

      const reqRes = await request(app)
        .post('/api/auth/otp/request')
        .send({ email: passwordlessUser.email });
      expect(reqRes.status).toBe(200);
      const otpCode = emailService.sentLoginOtpEmails[0].code;

      const priorSession = await sessionService.createSession({ userId: passwordlessUser.id });

      const verifyRes = await request(app)
        .post('/api/auth/otp/verify')
        .set(
          'Cookie',
          `${sessionService.SESSION_COOKIE_NAME}=${encodeURIComponent(priorSession.rawCookieValue)}`
        )
        .send({ email: 'SCANNER.STAFF@OUTSIDE.VIP', code: otpCode });

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.success).toBe(true);
      expect(verifyRes.body.data.user.id).toBe(passwordlessUser.id);
      expect(verifyRes.body.data.user.email).toBe(passwordlessUser.email);
      expect(verifyRes.body.data.user.role).toBe(Role.ATTENDEE);
      expect(verifyRes.body.data.user.emailVerified).toBe(true);
      expect(verifyRes.body.data.csrfToken).toBeTruthy();
      expect(verifyRes.headers['x-csrf-token']).toBe(verifyRes.body.data.csrfToken);

      const setCookies = verifyRes.headers['set-cookie'] as unknown as string[];
      expect(Array.isArray(setCookies)).toBe(true);
      const sidCookie = setCookies.find((c) => c.startsWith(`${sessionService.SESSION_COOKIE_NAME}=`));
      expect(sidCookie).toBeTruthy();
      expect(sidCookie).toContain('HttpOnly');
      expect(sidCookie).toContain('Secure');
      expect(sidCookie).toContain('SameSite=Lax');
      expect(sidCookie).toContain('Path=/');
      expect(sidCookie).not.toContain('Domain=');

      expect(await sessionService.validateAndTouchSession(priorSession.rawCookieValue)).toBeNull();
      const newSessionValid = await sessionService.validateAndTouchSession(verifyRes.body.data.token);
      expect(newSessionValid?.userId).toBe(passwordlessUser.id);
      expect(userCreateSpy).not.toHaveBeenCalled();

      const cached = await sessionService.getCachedUserAuth(passwordlessUser.id);
      expect(cached).toMatchObject({
        userId: passwordlessUser.id,
        email: passwordlessUser.email,
        role: Role.ATTENDEE,
        emailVerified: true,
        accountStatus: AccountStatus.ACTIVE,
      });
    });

    it('allows exactly one winner when two simultaneous requests submit the same valid OTP via Promise.all', async () => {
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(passwordlessUser as any);
      const rotateSpy = vi.spyOn(sessionService, 'rotateSession');

      await request(app)
        .post('/api/auth/otp/request')
        .send({ email: passwordlessUser.email });
      const validCode = emailService.sentLoginOtpEmails[0].code;

      const [resA, resB] = await Promise.all([
        request(app)
          .post('/api/auth/otp/verify')
          .send({ email: passwordlessUser.email, code: validCode }),
        request(app)
          .post('/api/auth/otp/verify')
          .send({ email: passwordlessUser.email, code: validCode }),
      ]);

      const statuses = [resA.status, resB.status].sort();
      expect(statuses).toEqual([200, 400]);

      const loser = resA.status === 400 ? resA : resB;
      expect(loser.body.error.code).toBe('INVALID_OTP_CODE');
      expect(rotateSpy).toHaveBeenCalledTimes(1);
    });

    it('remains exact-once even when slow DB work overlaps with a competing verification (no lock-expiry vulnerability)', async () => {
      await request(app)
        .post('/api/auth/otp/request')
        .send({ email: passwordlessUser.email });

      // Reset and run with controlled DB delay on post-consume lookup
      const redis = redisModule.getRedisClient();
      if (redis.flushAllForTests) await redis.flushAllForTests();
      emailService.resetSentLoginOtpEmails();

      let findCount = 0;
      vi.spyOn(prisma.user, 'findUnique').mockImplementation((async () => {
        findCount++;
        // Inject delay on post-OTP freshUser lookup of first verifier
        if (findCount === 3) {
          await new Promise((r) => setTimeout(r, 80));
        }
        return passwordlessUser as any;
      }) as any);

      await request(app)
        .post('/api/auth/otp/request')
        .send({ email: passwordlessUser.email });
      const validCode = emailService.sentLoginOtpEmails[0].code;

      const [r1, r2] = await Promise.all([
        request(app)
          .post('/api/auth/otp/verify')
          .send({ email: passwordlessUser.email, code: validCode }),
        request(app)
          .post('/api/auth/otp/verify')
          .send({ email: passwordlessUser.email, code: validCode }),
      ]);

      expect([r1.status, r2.status].sort()).toEqual([200, 400]);
    });

    it('enforces single-use OTP consumption so replaying a used OTP is rejected', async () => {
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(passwordlessUser as any);

      await request(app)
        .post('/api/auth/otp/request')
        .send({ email: passwordlessUser.email });
      const otpCode = emailService.sentLoginOtpEmails[0].code;

      const firstVerify = await request(app)
        .post('/api/auth/otp/verify')
        .send({ email: passwordlessUser.email, code: otpCode });
      expect(firstVerify.status).toBe(200);

      const replayVerify = await request(app)
        .post('/api/auth/otp/verify')
        .send({ email: passwordlessUser.email, code: otpCode });
      expect(replayVerify.status).toBe(400);
      expect(replayVerify.body.error.code).toBe('INVALID_OTP_CODE');
    });

    it('prevents a stale OTP verification from deleting a newly issued OTP', async () => {
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(passwordlessUser as any);
      const redis = redisModule.getRedisClient();
      const emailHash = sessionService.hashRateLimitIdentifier(passwordlessUser.email);

      // Issue OTP_1
      await request(app)
        .post('/api/auth/otp/request')
        .send({ email: passwordlessUser.email });
      const otp1 = emailService.sentLoginOtpEmails[0].code;

      // Clear cooldown and issue OTP_2
      await redis.del(`cooldown:auth_login_otp:${emailHash}`);
      await request(app)
        .post('/api/auth/otp/request')
        .send({ email: passwordlessUser.email });
      const otp2 = emailService.sentLoginOtpEmails[1].code;
      expect(otp2).not.toBe(otp1);

      // Submitting stale OTP_1 fails and MUST NOT delete OTP_2
      const staleRes = await request(app)
        .post('/api/auth/otp/verify')
        .send({ email: passwordlessUser.email, code: otp1 });
      expect(staleRes.status).toBe(400);
      expect(staleRes.body.error.code).toBe('INVALID_OTP_CODE');

      // OTP_2 still exists and succeeds
      const freshRes = await request(app)
        .post('/api/auth/otp/verify')
        .send({ email: passwordlessUser.email, code: otp2 });
      expect(freshRes.status).toBe(200);
      expect(freshRes.body.data.user.id).toBe(passwordlessUser.id);
    });

    it('rejects expired OTP codes and deletes stale Redis record', async () => {
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(passwordlessUser as any);

      const code = '482910';
      const otpKey = `${LOGIN_OTP_PREFIX}${passwordlessUser.id}`;
      await redisModule.getRedisClient().setPx(
        otpKey,
        JSON.stringify({
          generationId: 'gen-expired-1',
          codeHash: hashLoginOtp(passwordlessUser.id, code),
          issuedAt: Date.now() - 11 * 60 * 1000,
          expiresAt: Date.now() - 60 * 1000,
          attempts: 0,
        }),
        60_000
      );

      const res = await request(app)
        .post('/api/auth/otp/verify')
        .send({ email: passwordlessUser.email, code });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('OTP_EXPIRED');
      expect(await redisModule.getRedisClient().get(otpKey)).toBeNull();
    });

    it('enforces five-attempt lockout under both sequential and concurrent wrong guesses and blocks the real code afterwards', async () => {
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(passwordlessUser as any);

      await request(app)
        .post('/api/auth/otp/request')
        .send({ email: passwordlessUser.email });
      const realCode = emailService.sentLoginOtpEmails[0].code;
      const wrongCode = realCode === '000000' ? '111111' : '000000';

      // Fire 5 simultaneous wrong attempts via Promise.all
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(app)
            .post('/api/auth/otp/verify')
            .send({ email: passwordlessUser.email, code: wrongCode })
        )
      );

      const statusCounts = results.reduce<Record<number, number>>((acc, r) => {
        acc[r.status] = (acc[r.status] || 0) + 1;
        return acc;
      }, {});
      expect(statusCounts[400]).toBe(4);
      expect(statusCounts[429]).toBe(1);

      const lockedResp = results.find((r) => r.status === 429)!;
      expect(lockedResp.body.error.code).toBe('OTP_MAX_ATTEMPTS');

      // Subsequent submission with the real code is blocked
      const sixthWithRealCode = await request(app)
        .post('/api/auth/otp/verify')
        .send({ email: passwordlessUser.email, code: realCode });
      expect(sixthWithRealCode.status).toBe(429);
      expect(sixthWithRealCode.body.error.code).toBe('OTP_MAX_ATTEMPTS');
    });

    it('rejects account suspended or disabled between initial user lookup and final authentication (TOCTOU) and cleans up sessions', async () => {
      // Case A: SUSPENDED between initial lookup and post-OTP freshUser lookup
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(passwordlessUser as any);
      await request(app)
        .post('/api/auth/otp/request')
        .send({ email: passwordlessUser.email });
      const code1 = emailService.sentLoginOtpEmails[0].code;

      const invalidateSpy = vi.spyOn(sessionService, 'invalidateUserAuthCache');
      const revokeAllSpy = vi.spyOn(sessionService, 'revokeAllUserSessions');
      const rotateSpy = vi.spyOn(sessionService, 'rotateSession');

      vi.spyOn(prisma.user, 'findUnique')
        .mockResolvedValueOnce(passwordlessUser as any) // initial lookup
        .mockResolvedValueOnce({ ...passwordlessUser, status: AccountStatus.SUSPENDED } as any); // freshUser lookup

      const suspRes = await request(app)
        .post('/api/auth/otp/verify')
        .send({ email: passwordlessUser.email, code: code1 });

      expect(suspRes.status).toBe(403);
      expect(suspRes.body.error.code).toBe('ACCOUNT_SUSPENDED');
      expect(invalidateSpy).toHaveBeenCalledWith(passwordlessUser.id);
      expect(revokeAllSpy).toHaveBeenCalledWith(passwordlessUser.id);
      expect(rotateSpy).not.toHaveBeenCalled();
      // Consumed OTP cannot be replayed
      expect(await redisModule.getRedisClient().get(`${LOGIN_OTP_PREFIX}${passwordlessUser.id}`)).toBeNull();

      // Case B: DISABLED between initial lookup and post-OTP freshUser lookup
      const redis = redisModule.getRedisClient();
      if (redis.flushAllForTests) await redis.flushAllForTests();
      emailService.resetSentLoginOtpEmails();
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(passwordlessUser as any);
      await request(app)
        .post('/api/auth/otp/request')
        .send({ email: passwordlessUser.email });
      const code2 = emailService.sentLoginOtpEmails[0].code;

      vi.spyOn(prisma.user, 'findUnique')
        .mockResolvedValueOnce(passwordlessUser as any)
        .mockResolvedValueOnce({ ...passwordlessUser, status: AccountStatus.DISABLED } as any);

      const disRes = await request(app)
        .post('/api/auth/otp/verify')
        .send({ email: passwordlessUser.email, code: code2 });

      expect(disRes.status).toBe(403);
      expect(disRes.body.error.code).toBe('ACCOUNT_DISABLED');
    });

    it('transitions emailVerified from false to true ONLY after successful OTP proof and NOT on failed guesses', async () => {
      const unverifiedPwless = {
        ...passwordlessUser,
        id: 'user-pwless-unverified-010',
        email: 'unverified.pwless@outside.vip',
        emailVerified: false,
        emailVerifiedAt: null,
      };
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(unverifiedPwless as any);
      const updateSpy = vi.spyOn(prisma.user, 'update').mockResolvedValue({
        ...unverifiedPwless,
        emailVerified: true,
        emailVerifiedAt: new Date(),
      } as any);

      await request(app)
        .post('/api/auth/otp/request')
        .send({ email: unverifiedPwless.email });
      const realCode = emailService.sentLoginOtpEmails[0].code;
      const wrongCode = realCode === '123456' ? '654321' : '123456';

      // Failed OTP must NOT mark emailVerified
      const badRes = await request(app)
        .post('/api/auth/otp/verify')
        .send({ email: unverifiedPwless.email, code: wrongCode });
      expect(badRes.status).toBe(400);
      expect(updateSpy).not.toHaveBeenCalled();

      // Successful OTP marks emailVerified: true
      const okRes = await request(app)
        .post('/api/auth/otp/verify')
        .send({ email: unverifiedPwless.email, code: realCode });
      expect(okRes.status).toBe(200);
      expect(okRes.body.data.user.emailVerified).toBe(true);
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: unverifiedPwless.id },
          data: expect.objectContaining({ emailVerified: true }),
        })
      );
    });

    it('fails closed on rotateSession() failure with no Set-Cookie and no replayable OTP', async () => {
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(passwordlessUser as any);

      await request(app)
        .post('/api/auth/otp/request')
        .send({ email: passwordlessUser.email });
      const code = emailService.sentLoginOtpEmails[0].code;

      vi.spyOn(sessionService, 'rotateSession').mockRejectedValueOnce(
        new ServiceUnavailableError('Redis down during rotateSession', 'AUTH_STORE_UNAVAILABLE')
      );

      const failedRes = await request(app)
        .post('/api/auth/otp/verify')
        .send({ email: passwordlessUser.email, code });

      expect(failedRes.status).toBe(503);
      expect(failedRes.body.error.code).toBe('AUTH_STORE_UNAVAILABLE');
      expect(failedRes.headers['set-cookie']).toBeUndefined();

      // Consumed OTP cannot be replayed
      const replayRes = await request(app)
        .post('/api/auth/otp/verify')
        .send({ email: passwordlessUser.email, code });
      expect(replayRes.status).toBe(400);
      expect(replayRes.body.error.code).toBe('INVALID_OTP_CODE');
    });
  });

  describe('3. Rate Limiting, Targeted Redis Failures, CSRF & Password Login Preservation', () => {
    it('enforces normalized-email and IP rate limits on OTP request and verify endpoints', async () => {
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(passwordlessUser as any);
      vi.spyOn(sessionService, 'acquireOwnedRedisCooldown').mockResolvedValue({
        allowed: true,
        retryAfterSeconds: 0,
        ownerToken: 'mock-owner',
      });

      for (let i = 0; i < 5; i++) {
        const res = await request(app)
          .post('/api/auth/otp/request')
          .send({ email: passwordlessUser.email });
        expect(res.status).toBe(200);
      }

      const emailBlocked = await request(app)
        .post('/api/auth/otp/request')
        .send({ email: passwordlessUser.email });
      expect(emailBlocked.status).toBe(429);
      expect(emailBlocked.body.error.code).toBe('OTP_RATE_LIMIT');

      // IP burst rate limit (10 requests per 60s across distinct emails)
      const redis = redisModule.getRedisClient();
      if (redis.flushAllForTests) await redis.flushAllForTests();
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(null);

      for (let i = 0; i < 10; i++) {
        const res = await request(app)
          .post('/api/auth/otp/request')
          .send({ email: `burst-user-${i}@outside.vip` });
        expect(res.status).toBe(200);
      }

      const ipBurstBlocked = await request(app)
        .post('/api/auth/otp/request')
        .send({ email: 'burst-user-overflow@outside.vip' });
      expect(ipBurstBlocked.status).toBe(429);
      expect(ipBurstBlocked.body.error.code).toBe('OTP_RATE_LIMIT');

      // Verify endpoint email rate limit (8 attempts per 15 min)
      if (redis.flushAllForTests) await redis.flushAllForTests();
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(null);
      for (let i = 0; i < 8; i++) {
        const res = await request(app)
          .post('/api/auth/otp/verify')
          .send({ email: 'verify-limit@outside.vip', code: '123456' });
        expect(res.status).toBe(400);
      }
      const verifyBlocked = await request(app)
        .post('/api/auth/otp/verify')
        .send({ email: 'verify-limit@outside.vip', code: '123456' });
      expect(verifyBlocked.status).toBe(429);
      expect(verifyBlocked.body.error.code).toBe('VERIFICATION_RATE_LIMIT');
    });

    it('fails closed with 503 AUTH_STORE_UNAVAILABLE when Redis fails at each critical operation boundary', async () => {
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(passwordlessUser as any);
      const redis = redisModule.getRedisClient();

      // 1. Failure at initial rate-limit boundary
      redisModule.setSimulatedRedisFailure(true);
      const rateFail = await request(app)
        .post('/api/auth/otp/request')
        .send({ email: passwordlessUser.email });
      expect(rateFail.status).toBe(503);
      expect(rateFail.body.error.code).toBe('AUTH_STORE_UNAVAILABLE');
      redisModule.setSimulatedRedisFailure(false);

      // 2. Failure during acquireOwnedRedisCooldown
      vi.spyOn(sessionService, 'acquireOwnedRedisCooldown').mockRejectedValueOnce(
        new ServiceUnavailableError('Redis down on cooldown', 'AUTH_STORE_UNAVAILABLE')
      );
      const cooldownFail = await request(app)
        .post('/api/auth/otp/request')
        .send({ email: passwordlessUser.email });
      expect(cooldownFail.status).toBe(503);
      expect(cooldownFail.body.error.code).toBe('AUTH_STORE_UNAVAILABLE');

      // 3. Failure during setLoginOtpReturningPrior -> fails closed, no email sent, cooldown released
      if (redis.flushAllForTests) await redis.flushAllForTests();
      vi.spyOn(redis, 'setLoginOtpReturningPrior').mockRejectedValueOnce(
        new Error('Redis write failure')
      );
      const writeFail = await request(app)
        .post('/api/auth/otp/request')
        .send({ email: passwordlessUser.email });
      expect(writeFail.status).toBe(503);
      expect(writeFail.body.error.code).toBe('AUTH_STORE_UNAVAILABLE');
      expect(emailService.sentLoginOtpEmails).toHaveLength(0);
      const emailHash = sessionService.hashRateLimitIdentifier(passwordlessUser.email);
      expect(await redis.get(`cooldown:auth_login_otp:${emailHash}`)).toBeNull();

      // 4. Failure during verifyAndConsumeLoginOtp
      vi.spyOn(redis, 'verifyAndConsumeLoginOtp').mockRejectedValueOnce(
        new Error('Redis eval failure')
      );
      const verifyEvalFail = await request(app)
        .post('/api/auth/otp/verify')
        .send({ email: passwordlessUser.email, code: '123456' });
      expect(verifyEvalFail.status).toBe(503);
      expect(verifyEvalFail.body.error.code).toBe('AUTH_STORE_UNAVAILABLE');
      expect(verifyEvalFail.headers['set-cookie']).toBeUndefined();

      // 5. Failure during post-OTP auth cache sync
      if (redis.flushAllForTests) await redis.flushAllForTests();
      await request(app)
        .post('/api/auth/otp/request')
        .send({ email: passwordlessUser.email });
      const validCode = emailService.sentLoginOtpEmails[0].code;
      vi.spyOn(sessionService, 'invalidateUserAuthCache').mockRejectedValueOnce(
        new ServiceUnavailableError('Redis down on cache sync', 'AUTH_STORE_UNAVAILABLE')
      );
      const cacheSyncFail = await request(app)
        .post('/api/auth/otp/verify')
        .send({ email: passwordlessUser.email, code: validCode });
      expect(cacheSyncFail.status).toBe(503);
      expect(cacheSyncFail.body.error.code).toBe('AUTH_STORE_UNAVAILABLE');
      expect(cacheSyncFail.headers['set-cookie']).toBeUndefined();
    });

    it('enforces CSRF Origin, Sec-Fetch-Site, invalid X-CSRF-Token, and exact pathname matching on OTP endpoints', async () => {
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(passwordlessUser as any);

      // Cross-site Sec-Fetch-Site is blocked
      const crossSiteRes = await request(app)
        .post('/api/auth/otp/request')
        .set('Sec-Fetch-Site', 'cross-site')
        .send({ email: passwordlessUser.email });
      expect(crossSiteRes.status).toBe(403);
      expect(crossSiteRes.body.error.code).toBe('CSRF_CROSS_SITE_BLOCKED');

      // Untrusted Origin is blocked
      const badOriginRes = await request(app)
        .post('/api/auth/otp/verify')
        .set('Origin', 'https://evil-attacker.example')
        .send({ email: passwordlessUser.email, code: '123456' });
      expect(badOriginRes.status).toBe(403);
      expect(badOriginRes.body.error.code).toBe('CSRF_ORIGIN_MISMATCH');

      // Authenticated cookie with invalid X-CSRF-Token is blocked
      const existingSession = await sessionService.createSession({ userId: passwordlessUser.id });
      const badCsrfRes = await request(app)
        .post('/api/auth/otp/request')
        .set(
          'Cookie',
          `${sessionService.SESSION_COOKIE_NAME}=${encodeURIComponent(existingSession.rawCookieValue)}`
        )
        .set('X-CSRF-Token', 'forged-invalid-csrf-token')
        .send({ email: passwordlessUser.email });
      expect(badCsrfRes.status).toBe(403);
      expect(badCsrfRes.body.error.code).toBe('CSRF_TOKEN_INVALID');

      // Non-exact prefix path does NOT bypass missing CSRF token check
      const prefixBypassAttempt = await request(app)
        .post('/api/auth/otp/request-other')
        .set(
          'Cookie',
          `${sessionService.SESSION_COOKIE_NAME}=${encodeURIComponent(existingSession.rawCookieValue)}`
        )
        .send({ email: passwordlessUser.email });
      expect(prefixBypassAttempt.status).toBe(403);
      expect(prefixBypassAttempt.body.error.code).toBe('CSRF_TOKEN_MISSING');
    });

    it('preserves standard password-based login unchanged', async () => {
      const passwordHash = await bcrypt.hash('StrongPass123!', 10);
      const pwUser = {
        id: 'user-pw-standard-009',
        email: 'organizer.pw@outside.vip',
        name: 'Standard Organizer',
        passwordHash,
        role: Role.ORGANIZER,
        status: AccountStatus.ACTIVE,
        emailVerified: true,
        emailVerifiedAt: new Date(),
        avatarUrl: null,
        organizer: null,
      };
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(pwUser as any);

      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: pwUser.email, password: 'StrongPass123!' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.user.id).toBe(pwUser.id);
      expect(res.body.data.user.role).toBe(Role.ORGANIZER);
      expect(res.body.data.csrfToken).toBeTruthy();

      // Passwordless account still rejected by password login
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(passwordlessUser as any);
      const pwlessLoginRes = await request(app)
        .post('/api/auth/login')
        .send({ email: passwordlessUser.email, password: 'AnyPassword123!' });
      expect(pwlessLoginRes.status).toBe(401);
    });

    it('falls back to configured secret when process.env.SESSION_SECRET is whitespace-only and enforces integer Lua TTLs', () => {
      const prevSessionSecret = process.env.SESSION_SECRET;
      try {
        delete process.env.SESSION_SECRET;
        const baselineHash = hashLoginOtp(passwordlessUser.id, '123456');

        process.env.SESSION_SECRET = '   \t\n  ';
        const whitespaceFallbackHash = hashLoginOtp(passwordlessUser.id, '123456');

        expect(whitespaceFallbackHash).toBe(baselineHash);
        expect(whitespaceFallbackHash).toMatch(/^[a-f0-9]{64}$/);
      } finally {
        if (prevSessionSecret === undefined) {
          delete process.env.SESSION_SECRET;
        } else {
          process.env.SESSION_SECRET = prevSessionSecret;
        }
      }

      expect(redisModule.ROLLBACK_LOGIN_OTP_IF_MATCHES_LUA).toContain(
        'math.floor(math.max(1000, priorExpiresAt - nowMs))'
      );
      expect(redisModule.VERIFY_AND_CONSUME_LOGIN_OTP_LUA).toContain(
        'math.floor(math.max(1000, expiresAt - nowMs))'
      );
    });
  });
});
