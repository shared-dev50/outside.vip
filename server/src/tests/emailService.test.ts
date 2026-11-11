import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { prisma } from '../db/prisma.js';
import {
  DEFAULT_EMAIL_FROM,
  EmailDeliveryError,
  getLatestVerificationEmail,
  resetEmailServiceTestOptions,
  resetSentVerificationEmails,
  resolveEmailFrom,
  sanitizeEmailLogMessage,
  sentVerificationEmails,
  sendVerificationOtpEmail,
  setEmailServiceTestOptions,
} from '../lib/email.service.js';
import { resetVerificationRateLimits } from '../modules/auth/auth.controller.js';

describe('Resend Email Service Hardening & Delivery Reliability', () => {
  const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    EMAIL_FROM: process.env.EMAIL_FROM,
  };
  const createdUserIds: string[] = [];

  beforeEach(() => {
    resetSentVerificationEmails();
    resetEmailServiceTestOptions();
    resetVerificationRateLimits();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv.NODE_ENV;
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
    resetEmailServiceTestOptions();
    resetSentVerificationEmails();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await prisma.emailVerificationCode.deleteMany({
        where: { userId: { in: createdUserIds } },
      });
      await prisma.adminAuditLog.deleteMany({
        where: { actorUserId: { in: createdUserIds } },
      });
      await prisma.organizerProfile.deleteMany({
        where: { userId: { in: createdUserIds } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: createdUserIds } },
      });
    }
  });

  describe('1. Sender Standardization & HTML Escaping', () => {
    it('standardizes default sender to Outside.vip <no-reply@out-side.vip> and honors EMAIL_FROM env', () => {
      expect(DEFAULT_EMAIL_FROM).toBe('Outside.vip <no-reply@out-side.vip>');

      process.env.EMAIL_FROM = '  "Outside.vip <no-reply@out-side.vip>"  ';
      expect(resolveEmailFrom()).toBe('Outside.vip <no-reply@out-side.vip>');

      process.env.EMAIL_FROM = '   ';
      expect(resolveEmailFrom()).toBe('Outside.vip <no-reply@out-side.vip>');
    });

    it('properly escapes HTML special characters in template recipient name', async () => {
      const result = await sendVerificationOtpEmail({
        to: 'xss_test@example.com',
        name: '<script>alert("xss")</script> & \'Co\'',
        code: '654321',
      });

      expect(result.sent).toBe(true);
      expect(result.provider).toBe('test-recorder');
      const recorded = getLatestVerificationEmail('xss_test@example.com');
      expect(recorded).toBeDefined();
      expect(recorded!.html).not.toContain('<script>');
      expect(recorded!.html).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; &amp; &#39;Co&#39;');
    });
  });

  describe('2. Resend SDK Dispatch, Error Classification & Timeout/Retry Reliability', () => {
    const fakeApiKey = 're_test_secret_api_key_999';

    it('dispatches verification OTP via Resend SDK in production without retaining plaintext OTP in logs or memory', async () => {
      process.env.NODE_ENV = 'production';
      process.env.RESEND_API_KEY = fakeApiKey;
      process.env.EMAIL_FROM = 'Outside.vip <no-reply@out-side.vip>';

      const otp = '739104';
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 're_msg_success_001' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const result = await sendVerificationOtpEmail({
        to: '  ATTENDEE@Example.com  ',
        name: 'Alex Mwangi',
        code: otp,
        idempotencyKey: 'otp-verification-test-001',
      });

      expect(result).toMatchObject({
        sent: true,
        status: 'sent',
        provider: 'resend',
        messageId: 're_msg_success_001',
        from: 'Outside.vip <no-reply@out-side.vip>',
        to: 'attendee@example.com',
        expiresInMinutes: 10,
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [calledUrl, init] = fetchSpy.mock.calls[0];
      expect(String(calledUrl)).toBe('https://api.resend.com/emails');
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe(`Bearer ${fakeApiKey}`);
      expect(headers.get('idempotency-key')).toBe('otp-verification-test-001');

      const body = JSON.parse(String(init?.body));
      expect(body.from).toBe('Outside.vip <no-reply@out-side.vip>');
      expect(body.to).toEqual(['attendee@example.com']);
      expect(body.text).toContain(otp);
      expect(body.html).toContain(otp);

      // Zero plaintext OTP retention in memory or logs during production execution
      expect(sentVerificationEmails).toHaveLength(0);
      expect(getLatestVerificationEmail('attendee@example.com')).toBeUndefined();

      const allLogs = [
        ...logSpy.mock.calls,
        ...infoSpy.mock.calls,
        ...warnSpy.mock.calls,
        ...errorSpy.mock.calls,
      ]
        .flat()
        .join(' ');
      expect(allLogs).not.toContain(otp);
      expect(allLogs).not.toContain(fakeApiKey);
    });

    it('fails closed in production when RESEND_API_KEY is missing without logging OTPs', async () => {
      process.env.NODE_ENV = 'production';
      process.env.RESEND_API_KEY = '';

      const otp = '812349';
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(
        sendVerificationOtpEmail({
          to: 'user@example.com',
          name: 'User',
          code: otp,
        })
      ).rejects.toMatchObject({
        statusCode: 503,
        code: 'EMAIL_SERVICE_UNCONFIGURED',
      });

      expect(sentVerificationEmails).toHaveLength(0);
      const allLogs = [...infoSpy.mock.calls, ...errorSpy.mock.calls].flat().join(' ');
      expect(allLogs).not.toContain(otp);
    });

    it('handles invalid API key (401) without retrying and sanitizes secrets from error logs', async () => {
      process.env.NODE_ENV = 'production';
      process.env.RESEND_API_KEY = fakeApiKey;

      const otp = '559922';
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            statusCode: 401,
            name: 'invalid_api_key',
            message: `Invalid key Bearer ${fakeApiKey} when sending code ${otp}`,
          }),
          { status: 401, headers: { 'Content-Type': 'application/json' } }
        )
      );

      await expect(
        sendVerificationOtpEmail({
          to: 'user@example.com',
          name: 'User',
          code: otp,
        })
      ).rejects.toMatchObject({
        name: 'EmailDeliveryError',
        statusCode: 503,
        code: 'EMAIL_PROVIDER_AUTH_FAILED',
        providerStatusCode: 401,
      });

      // Must fail fast without retrying non-retryable 401 auth errors
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const errorLog = errorSpy.mock.calls.flat().join(' ');
      expect(errorLog).not.toContain(fakeApiKey);
      expect(errorLog).not.toContain(otp);
      expect(errorLog).toContain('EMAIL_PROVIDER_AUTH_FAILED');
    });

    it('handles Resend 4xx validation and rate-limit errors cleanly without retrying', async () => {
      setEmailServiceTestOptions({ useResendInTest: true, retryDelayMs: 5, maxRetries: 1 });
      process.env.RESEND_API_KEY = fakeApiKey;
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              statusCode: 422,
              name: 'validation_error',
              message: 'The from domain is not verified',
            }),
            { status: 422, headers: { 'Content-Type': 'application/json' } }
          )
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              statusCode: 429,
              name: 'rate_limit_exceeded',
              message: 'Too many requests',
            }),
            { status: 429, headers: { 'Content-Type': 'application/json' } }
          )
        );

      await expect(
        sendVerificationOtpEmail({
          to: 'user@example.com',
          name: 'User',
          code: '123456',
        })
      ).rejects.toMatchObject({
        statusCode: 503,
        code: 'EMAIL_DELIVERY_REJECTED',
        providerStatusCode: 422,
      });

      await expect(
        sendVerificationOtpEmail({
          to: 'user@example.com',
          name: 'User',
          code: '123456',
        })
      ).rejects.toMatchObject({
        statusCode: 503,
        code: 'EMAIL_PROVIDER_RATE_LIMITED',
        providerStatusCode: 429,
      });

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(errorSpy).toHaveBeenCalledTimes(2);
    });

    it('retries Resend 5xx once with identical Idempotency-Key and succeeds on recovery, or fails after exhausting retries', async () => {
      setEmailServiceTestOptions({ useResendInTest: true, retryDelayMs: 5, maxRetries: 1 });
      process.env.RESEND_API_KEY = fakeApiKey;
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Case 1: Transient 502 recovers on retry with matching Idempotency-Key
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ statusCode: 502, name: 'application_error', message: 'Bad Gateway' }),
            { status: 502, headers: { 'Content-Type': 'application/json' } }
          )
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: 're_msg_retry_ok' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        );

      const recovered = await sendVerificationOtpEmail({
        to: 'user@example.com',
        name: 'User',
        code: '246810',
        idempotencyKey: 'otp-idem-key-retry',
      });

      expect(recovered.sent).toBe(true);
      expect(recovered.messageId).toBe('re_msg_retry_ok');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(new Headers(fetchSpy.mock.calls[0][1]?.headers).get('idempotency-key')).toBe(
        'otp-idem-key-retry'
      );
      expect(new Headers(fetchSpy.mock.calls[1][1]?.headers).get('idempotency-key')).toBe(
        'otp-idem-key-retry'
      );
      expect(warnSpy).toHaveBeenCalledTimes(1);

      // Case 2: Persistent 500 fails cleanly after 1 retry
      fetchSpy.mockReset();
      fetchSpy.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              statusCode: 500,
              name: 'internal_server_error',
              message: 'Provider internal failure',
            }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
          )
        )
      );

      await expect(
        sendVerificationOtpEmail({
          to: 'user@example.com',
          name: 'User',
          code: '246810',
          idempotencyKey: 'otp-idem-key-fail',
        })
      ).rejects.toMatchObject({
        statusCode: 503,
        code: 'EMAIL_PROVIDER_UNAVAILABLE',
        providerStatusCode: 500,
      });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(errorSpy).toHaveBeenCalled();
    });

    it('handles network failures cleanly across retry attempts', async () => {
      setEmailServiceTestOptions({ useResendInTest: true, retryDelayMs: 5, maxRetries: 1 });
      process.env.RESEND_API_KEY = fakeApiKey;
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('connect ECONNREFUSED'));

      await expect(
        sendVerificationOtpEmail({
          to: 'user@example.com',
          name: 'User',
          code: '987654',
          idempotencyKey: 'otp-network-fail',
        })
      ).rejects.toBeInstanceOf(EmailDeliveryError);

      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('aborts and fails cleanly when Resend requests exceed timeout', async () => {
      setEmailServiceTestOptions({
        useResendInTest: true,
        timeoutMs: 35,
        retryDelayMs: 5,
        maxRetries: 1,
      });
      process.env.RESEND_API_KEY = fakeApiKey;
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      let abortedSignals = 0;
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            abortedSignals++;
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      });

      await expect(
        sendVerificationOtpEmail({
          to: 'user@example.com',
          name: 'User',
          code: '112233',
          idempotencyKey: 'otp-timeout-test',
        })
      ).rejects.toMatchObject({
        statusCode: 503,
        code: 'EMAIL_DELIVERY_TIMEOUT',
        timedOut: true,
      });

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(abortedSignals).toBe(2);
    });

    it('sanitizeEmailLogMessage masks API keys, Bearer tokens, and sensitive OTP strings', () => {
      const sanitized = sanitizeEmailLogMessage(
        'Error using Bearer secret_jwt_val and key re_abc123XYZ789 for OTP 482910',
        ['482910']
      );
      expect(sanitized).not.toContain('re_abc123XYZ789');
      expect(sanitized).not.toContain('secret_jwt_val');
      expect(sanitized).not.toContain('482910');
      expect(sanitized).toContain('[REDACTED_API_KEY]');
      expect(sanitized).toContain('[REDACTED]');
    });
  });

  describe('3. Auth Registration & Resend Cooldown / OTP Preservation Integration', () => {
    const fakeApiKey = 're_test_integration_key_555';

    it('rolls back registration and returns 503 EMAIL_DELIVERY_FAILED when initial Resend delivery fails, then allows retry', async () => {
      setEmailServiceTestOptions({ useResendInTest: true, timeoutMs: 200, retryDelayMs: 5, maxRetries: 0 });
      process.env.RESEND_API_KEY = fakeApiKey;
      process.env.EMAIL_FROM = 'Outside.vip <no-reply@out-side.vip>';
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const email = `reg_fail_rollback_${Date.now()}@outside.vip`;

      // Attempt 1: Resend returns 401 -> registration must fail cleanly and roll back the user
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({ statusCode: 401, name: 'invalid_api_key', message: 'Unauthorized' }),
          { status: 401, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const failRes = await request(app).post('/api/auth/register').send({
        email,
        password: 'OutsidePassword2026!',
        name: 'Rollback User',
      });

      expect(failRes.status).toBe(503);
      expect(failRes.body.success).toBe(false);
      expect(failRes.body.error.code).toBe('EMAIL_PROVIDER_AUTH_FAILED');

      const userAfterFail = await prisma.user.findUnique({ where: { email } });
      expect(userAfterFail).toBeNull();

      // Attempt 2: Resend succeeds -> user registers cleanly with accurate delivery metadata
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 're_msg_reg_ok_1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const okRes = await request(app).post('/api/auth/register').send({
        email,
        password: 'OutsidePassword2026!',
        name: 'Rollback User',
      });

      expect(okRes.status).toBe(201);
      expect(okRes.body.success).toBe(true);
      expect(okRes.body.data.emailDelivery).toMatchObject({
        sent: true,
        status: 'sent',
        provider: 'resend',
        messageId: 're_msg_reg_ok_1',
        from: 'Outside.vip <no-reply@out-side.vip>',
      });
      createdUserIds.push(okRes.body.data.user.id);
    });

    it('preserves previously valid OTP and does NOT start resend cooldown when resend delivery fails', async () => {
      setEmailServiceTestOptions({ useResendInTest: true, timeoutMs: 200, retryDelayMs: 5, maxRetries: 0 });
      process.env.RESEND_API_KEY = fakeApiKey;
      process.env.EMAIL_FROM = 'Outside.vip <no-reply@out-side.vip>';
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      const email = `resend_preserve_${Date.now()}@outside.vip`;
      const capturedOtps: string[] = [];

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
        const payload = JSON.parse(String(init?.body || '{}'));
        const match = String(payload.subject || '').match(/^\d{6}/);
        if (match) capturedOtps.push(match[0]);
        return Promise.resolve(
          new Response(JSON.stringify({ id: `re_msg_${capturedOtps.length}` }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        );
      });

      // 1. Register cleanly -> receives OTP #1
      const regRes = await request(app).post('/api/auth/register').send({
        email,
        password: 'OutsidePassword2026!',
        name: 'Cooldown Preserve User',
      });
      expect(regRes.status).toBe(201);
      const userId = regRes.body.data.user.id;
      const token = regRes.body.data.token;
      createdUserIds.push(userId);
      expect(capturedOtps).toHaveLength(1);
      const firstOtp = capturedOtps[0];

      // 2. Fast-forward initial code createdAt past the 60s resend cooldown
      await prisma.emailVerificationCode.updateMany({
        where: { userId },
        data: { createdAt: new Date(Date.now() - 65 * 1000) },
      });

      // 3. Mock Resend 500 failure on resend-verification
      fetchSpy.mockImplementationOnce(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ statusCode: 500, name: 'internal_server_error', message: 'Resend down' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
          )
        )
      );

      const failedResend = await request(app)
        .post('/api/auth/resend-verification')
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(failedResend.status).toBe(503);
      expect(failedResend.body.success).toBe(false);
      expect(failedResend.body.error.code).toBe('EMAIL_PROVIDER_UNAVAILABLE');

      // 4. Retry resend immediately (1s later): cooldown MUST NOT have started!
      fetchSpy.mockImplementationOnce((_url, init) => {
        const payload = JSON.parse(String(init?.body || '{}'));
        const match = String(payload.subject || '').match(/^\d{6}/);
        if (match) capturedOtps.push(match[0]);
        return Promise.resolve(
          new Response(JSON.stringify({ id: 're_msg_recovered_resend' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        );
      });

      // Wait: before calling a successful resend, verify firstOtp is STILL valid if the user enters it, OR test in two steps:
      // Let's verify cooldown wasn't triggered first by performing the recovered resend, then check cooldown IS triggered after success!
      const recoveredResend = await request(app)
        .post('/api/auth/resend-verification')
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(recoveredResend.status).toBe(200);
      expect(recoveredResend.body.success).toBe(true);
      expect(recoveredResend.body.data.emailDelivery).toMatchObject({
        sent: true,
        status: 'sent',
        provider: 'resend',
        messageId: 're_msg_recovered_resend',
      });

      // 5. After successful resend, immediate follow-up resend MUST now enforce 60s cooldown
      const cooldownRes = await request(app)
        .post('/api/auth/resend-verification')
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(cooldownRes.status).toBe(429);
      expect(cooldownRes.body.error.code).toBe('VERIFICATION_RESEND_COOLDOWN');

      // 6. Test in a second user that a failed resend leaves firstOtp completely valid for verify-email
      const email2 = `otp_preserved_verify_${Date.now()}@outside.vip`;
      const reg2Otps: string[] = [];
      fetchSpy.mockImplementation((_url, init) => {
        const payload = JSON.parse(String(init?.body || '{}'));
        const match = String(payload.subject || '').match(/^\d{6}/);
        if (match) reg2Otps.push(match[0]);
        return Promise.resolve(
          new Response(JSON.stringify({ id: 're_msg_user2_initial' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        );
      });

      const reg2Res = await request(app).post('/api/auth/register').send({
        email: email2,
        password: 'OutsidePassword2026!',
        name: 'Preserved OTP User',
      });
      expect(reg2Res.status).toBe(201);
      const user2Id = reg2Res.body.data.user.id;
      const token2 = reg2Res.body.data.token;
      createdUserIds.push(user2Id);
      const preservedOtp = reg2Otps[0];
      expect(preservedOtp).toMatch(/^\d{6}$/);

      await prisma.emailVerificationCode.updateMany({
        where: { userId: user2Id },
        data: { createdAt: new Date(Date.now() - 65 * 1000) },
      });

      fetchSpy.mockImplementationOnce(() => Promise.reject(new Error('Network offline')));
      const failedResend2 = await request(app)
        .post('/api/auth/resend-verification')
        .set('Authorization', `Bearer ${token2}`)
        .send({});
      expect(failedResend2.status).toBe(503);

      // The previously issued OTP must still verify the user cleanly
      const verifyRes = await request(app)
        .post('/api/auth/verify-email')
        .set('Authorization', `Bearer ${token2}`)
        .send({ code: preservedOtp });
      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.data.user.emailVerified).toBe(true);

      // Confirm neither OTP nor API key leaked to logs
      const allLogs = [...errorSpy.mock.calls, ...infoSpy.mock.calls].flat().join(' ');
      expect(allLogs).not.toContain(firstOtp);
      expect(allLogs).not.toContain(preservedOtp);
      expect(allLogs).not.toContain(fakeApiKey);
    });
  });
});

