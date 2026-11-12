import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { Role, AccountStatus } from '@prisma/client';
import { app } from '../app.js';
import { prisma, getUserDbReadCount, resetUserDbReadCount } from '../db/prisma.js';
import { getRedisClient, setSimulatedRedisFailure } from '../lib/redis.js';
import {
  SESSION_COOKIE_NAME,
  SESSION_PREFIX,
  USER_AUTH_CACHE_PREFIX,
  getCachedUserAuth,
  invalidateUserAuthCache,
  resolveUserAuthWithCache,
} from '../lib/session.service.js';
import { resetVerificationRateLimits } from '../modules/auth/auth.controller.js';
import {
  resetSentVerificationEmails,
  getLatestVerificationEmail,
} from '../lib/email.service.js';

function extractCookieFromResponse(res: request.Response, cookieName = SESSION_COOKIE_NAME): {
  rawHeader: string;
  value: string;
  cookiePair: string;
} | null {
  const setCookieHeaders = res.headers['set-cookie'];
  if (!setCookieHeaders) return null;
  const headerList = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  for (const header of headerList) {
    if (header.startsWith(`${cookieName}=`)) {
      const firstPart = header.split(';')[0];
      const eqIdx = firstPart.indexOf('=');
      const val = decodeURIComponent(firstPart.slice(eqIdx + 1));
      return {
        rawHeader: header,
        value: val,
        cookiePair: `${cookieName}=${encodeURIComponent(val)}`,
      };
    }
  }
  return null;
}

describe('Server-Side Redis Sessions & 30-Second Redis User Authorization Cache', () => {
  const createdUserIds: string[] = [];
  const createdEventIds: string[] = [];
  const previousAdminEmails = process.env.ADMIN_EMAILS;

  beforeAll(async () => {
    process.env.ADMIN_EMAILS = 'admin@outside.vip,redis_admin_allow@outside.vip';
    resetSentVerificationEmails();
    resetVerificationRateLimits();
  });

  beforeEach(() => {
    setSimulatedRedisFailure(false);
    resetUserDbReadCount();
  });

  afterAll(async () => {
    setSimulatedRedisFailure(false);
    process.env.ADMIN_EMAILS = previousAdminEmails;

    if (createdEventIds.length > 0) {
      await prisma.ticketTier.deleteMany({ where: { eventId: { in: createdEventIds } } });
      await prisma.event.deleteMany({ where: { id: { in: createdEventIds } } });
    }
    if (createdUserIds.length > 0) {
      await prisma.adminAuditLog.deleteMany({ where: { actorUserId: { in: createdUserIds } } });
      await prisma.emailVerificationCode.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.organizerProfile.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
  });

  describe('1. __Host-outside_sid Cookie & One-Way Redis Verifier', () => {
    it('sets a host-only __Host-outside_sid cookie (HttpOnly, Secure, SameSite=Lax, Path=/, no Domain) and stores only a SHA-256 verifier in Redis', async () => {
      const email = `session_spec_${Date.now()}@outside.vip`;
      const regRes = await request(app).post('/api/auth/register').send({
        email,
        password: 'OutsidePassword2026!',
        name: 'Session Spec Tester',
      });

      expect(regRes.status).toBe(201);
      createdUserIds.push(regRes.body.data.user.id);

      const cookie = extractCookieFromResponse(regRes);
      expect(cookie).not.toBeNull();
      expect(cookie!.rawHeader).toContain(`${SESSION_COOKIE_NAME}=`);
      expect(cookie!.rawHeader).toContain('Path=/');
      expect(cookie!.rawHeader).toContain('HttpOnly');
      expect(cookie!.rawHeader).toContain('Secure');
      expect(cookie!.rawHeader).toContain('SameSite=Lax');
      expect(cookie!.rawHeader.toLowerCase()).not.toContain('domain=');

      // Verify Cache-Control: no-store and security headers on auth response
      expect(regRes.headers['cache-control']).toContain('no-store');
      expect(regRes.headers['strict-transport-security']).toContain('max-age=63072000');
      expect(regRes.headers['x-content-type-options']).toBe('nosniff');
      expect(regRes.headers['x-frame-options']).toBe('DENY');
      expect(regRes.headers['content-security-policy']).toContain("default-src 'self'");

      // Split <sessionId>.<sessionSecret> and inspect Redis directly
      const [sessionId, sessionSecret] = cookie!.value.split('.');
      expect(sessionId.length).toBeGreaterThanOrEqual(20); // 128-bit base64url
      expect(sessionSecret.length).toBeGreaterThanOrEqual(40); // 256-bit base64url

      const redis = getRedisClient();
      const rawSessionJson = await redis.get(`${SESSION_PREFIX}${sessionId}`);
      expect(rawSessionJson).not.toBeNull();
      // Raw sessionSecret must NEVER be stored in Redis
      expect(rawSessionJson!).not.toContain(sessionSecret);
      const parsedSession = JSON.parse(rawSessionJson!);
      expect(parsedSession.verifierHash).toMatch(/^[a-f0-9]{64}$/);
      expect(parsedSession.userId).toBe(regRes.body.data.user.id);

      // Tampering with sessionSecret must fail verification
      const tamperedCookie = `${SESSION_COOKIE_NAME}=${sessionId}.tampered_secret_value_12345678901234567890`;
      const meTampered = await request(app)
        .get('/api/auth/me')
        .set('Cookie', tamperedCookie);
      expect(meTampered.status).toBe(401);
    });

    it('omits token from JSON responses and ignores Authorization: Bearer headers in production mode', async () => {
      const email = `prod_cookie_only_${Date.now()}@outside.vip`;
      const regRes = await request(app).post('/api/auth/register').send({
        email,
        password: 'OutsidePassword2026!',
        name: 'Prod Mode User',
      });
      createdUserIds.push(regRes.body.data.user.id);

      const previousNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      process.env.ALLOW_MEMORY_REDIS_IN_TEST = 'true';
      try {
        const loginRes = await request(app).post('/api/auth/login').send({
          email,
          password: 'OutsidePassword2026!',
        });
        expect(loginRes.status).toBe(200);
        // In production, no session token is exposed in the JSON body
        expect(loginRes.body.data.token).toBeUndefined();
        expect(loginRes.body.data.csrfToken).toBeDefined();

        const cookie = extractCookieFromResponse(loginRes);
        expect(cookie).not.toBeNull();

        // Bearer header without cookie is rejected in production
        const bearerAttempt = await request(app)
          .get('/api/auth/me')
          .set('Authorization', `Bearer ${cookie!.value}`);
        expect(bearerAttempt.status).toBe(401);

        // Host-only __Host-outside_sid cookie succeeds in production
        const cookieAttempt = await request(app)
          .get('/api/auth/me')
          .set('Cookie', cookie!.cookiePair);
        expect(cookieAttempt.status).toBe(200);
        expect(cookieAttempt.body.data.user.email).toBe(email);
      } finally {
        process.env.NODE_ENV = previousNodeEnv;
        delete process.env.ALLOW_MEMORY_REDIS_IN_TEST;
      }
    });
  });

  describe('2 & 3. 30-Second Redis User Authorization Cache Hits & Expiration', () => {
    let userId: string;
    let sessionCookie: string;
    let csrfToken: string;

    beforeAll(async () => {
      const email = `cache_hit_${Date.now()}@outside.vip`;
      const regRes = await request(app).post('/api/auth/register').send({
        email,
        password: 'OutsidePassword2026!',
        name: 'Cache Hit Organizer',
      });
      userId = regRes.body.data.user.id;
      createdUserIds.push(userId);

      const initialCookie = extractCookieFromResponse(regRes)!;
      const initialCsrf = regRes.body.data.csrfToken;
      const otp = getLatestVerificationEmail(email)!.code;

      const verifyRes = await request(app)
        .post('/api/auth/verify-email')
        .set('Cookie', initialCookie.cookiePair)
        .set('X-CSRF-Token', initialCsrf)
        .send({ code: otp });
      expect(verifyRes.status).toBe(200);

      sessionCookie = extractCookieFromResponse(verifyRes)!.cookiePair;
      csrfToken = verifyRes.body.data.csrfToken;
    });

    it('stores only { userId, role, emailVerified, accountStatus } in user_auth_cache:<userId> and serves ordinary authenticated requests with zero User table lookups', async () => {
      const redis = getRedisClient();
      const rawCache = await redis.get(`${USER_AUTH_CACHE_PREFIX}${userId}`);
      expect(rawCache).not.toBeNull();

      const parsedCache = JSON.parse(rawCache!);
      expect(Object.keys(parsedCache).sort()).toEqual([
        'accountStatus',
        'emailVerified',
        'role',
        'userId',
      ]);
      expect(parsedCache).toEqual({
        userId,
        role: 'ATTENDEE',
        emailVerified: true,
        accountStatus: 'ACTIVE',
      });

      const ttlMs = await redis.pttl(`${USER_AUTH_CACHE_PREFIX}${userId}`);
      expect(ttlMs).toBeGreaterThan(20_000);
      expect(ttlMs).toBeLessThanOrEqual(30_000);

      // Ordinary authenticated requests must hit Redis cache (0 DB lookups on User)
      resetUserDbReadCount();

      const dashRes1 = await request(app)
        .get('/api/organizer/dashboard')
        .set('Cookie', sessionCookie);
      expect(dashRes1.status).toBe(200);

      const eventsRes = await request(app)
        .get('/api/organizer/events')
        .set('Cookie', sessionCookie);
      expect(eventsRes.status).toBe(200);

      const dashRes2 = await request(app)
        .get('/api/organizer/dashboard')
        .set('Cookie', sessionCookie);
      expect(dashRes2.status).toBe(200);

      expect(getUserDbReadCount()).toBe(0);
    });

    it('re-queries PostgreSQL once when the 30-second user cache expires and repopulates the cache', async () => {
      const redis = getRedisClient();
      // Simulate 30-second TTL expiration on user_auth_cache:<userId>
      await redis.del(`${USER_AUTH_CACHE_PREFIX}${userId}`);
      expect(await getCachedUserAuth(userId)).toBeNull();

      resetUserDbReadCount();

      // First request after cache expiry queries PostgreSQL once and repopulates Redis cache
      const res1 = await request(app)
        .get('/api/organizer/events')
        .set('Cookie', sessionCookie);
      expect(res1.status).toBe(200);
      expect(getUserDbReadCount()).toBe(1);
      expect(await getCachedUserAuth(userId)).not.toBeNull();

      // Subsequent request uses the repopulated cache without querying PostgreSQL
      const res2 = await request(app)
        .get('/api/organizer/events')
        .set('Cookie', sessionCookie);
      expect(res2.status).toBe(200);
      expect(getUserDbReadCount()).toBe(1);
    });
  });

  describe('4, 5 & 8. Immediate Cache Invalidation & Atomic Anti-Race Protection', () => {
    it('immediately invalidates user cache and rotates session when email verification and ADMIN_EMAILS promotion occur', async () => {
      const adminEmail = 'redis_admin_allow@outside.vip';
      await prisma.user.deleteMany({ where: { email: adminEmail } });

      const regRes = await request(app).post('/api/auth/register').send({
        email: adminEmail,
        password: 'OutsidePassword2026!',
        name: 'Allowlisted Redis Admin',
      });
      expect(regRes.status).toBe(201);
      const userId = regRes.body.data.user.id;
      createdUserIds.push(userId);

      const preVerifyCookie = extractCookieFromResponse(regRes)!;
      const preVerifyCsrf = regRes.body.data.csrfToken;

      // Cache initially holds ATTENDEE and emailVerified: false
      const cachedBefore = await getCachedUserAuth(userId);
      expect(cachedBefore).toEqual({
        userId,
        role: Role.ATTENDEE,
        emailVerified: false,
        accountStatus: AccountStatus.ACTIVE,
      });

      // Verify email -> triggers immediate cache invalidation, ADMIN promotion, and session rotation
      const otp = getLatestVerificationEmail(adminEmail)!.code;
      const verifyRes = await request(app)
        .post('/api/auth/verify-email')
        .set('Cookie', preVerifyCookie.cookiePair)
        .set('X-CSRF-Token', preVerifyCsrf)
        .send({ code: otp });
      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.data.user.role).toBe('ADMIN');
      expect(verifyRes.body.data.user.emailVerified).toBe(true);

      const postVerifyCookie = extractCookieFromResponse(verifyRes)!;
      expect(postVerifyCookie.value).not.toBe(preVerifyCookie.value);

      // Old session ID must be immediately invalidated in Redis
      const oldSessionAttempt = await request(app)
        .get('/api/organizer/dashboard')
        .set('Cookie', preVerifyCookie.cookiePair);
      expect(oldSessionAttempt.status).toBe(401);

      // Redis cache immediately reflects ADMIN and emailVerified: true without waiting 30s
      const cachedAfter = await getCachedUserAuth(userId);
      expect(cachedAfter).toEqual({
        userId,
        role: Role.ADMIN,
        emailVerified: true,
        accountStatus: AccountStatus.ACTIVE,
      });
    });

    it('prevents stale cache repopulation when a concurrent invalidation occurs during an in-flight DB read', async () => {
      const dummyUserId = `race_user_${Date.now()}`;
      await invalidateUserAuthCache(dummyUserId);

      // Simulate Request A experiencing a cache miss and reading stale data from DB,
      // while Request B concurrently invalidates the user's cache before Request A writes to Redis.
      const resolved = await resolveUserAuthWithCache(
        dummyUserId,
        async () => ({
          userId: dummyUserId,
          role: Role.ATTENDEE,
          emailVerified: false,
          accountStatus: AccountStatus.ACTIVE,
        }),
        {
          onBeforeCacheWrite: async () => {
            // Concurrent invalidation happens while DB read is in flight
            await invalidateUserAuthCache(dummyUserId);
          },
        }
      );

      expect(resolved.fromCache).toBe(false);
      // Because the invalidation version incremented concurrently, the atomic Lua script
      // MUST have rejected the stale cache write!
      const cachedAfterRace = await getCachedUserAuth(dummyUserId);
      expect(cachedAfterRace).toBeNull();
    });
  });

  describe('5 & 6. Suspended / Disabled Accounts & Immediate Session Revocation', () => {
    it('immediately invalidates user cache and revokes all active sessions when an admin suspends or disables an account', async () => {
      // 1. Create and verify a target user with two concurrent sessions
      const targetEmail = `suspend_target_${Date.now()}@outside.vip`;
      const regRes = await request(app).post('/api/auth/register').send({
        email: targetEmail,
        password: 'OutsidePassword2026!',
        name: 'Target Suspend User',
      });
      const targetUserId = regRes.body.data.user.id;
      createdUserIds.push(targetUserId);

      const regCookie = extractCookieFromResponse(regRes)!;
      const otp = getLatestVerificationEmail(targetEmail)!.code;
      const verifyRes = await request(app)
        .post('/api/auth/verify-email')
        .set('Cookie', regCookie.cookiePair)
        .set('X-CSRF-Token', regRes.body.data.csrfToken)
        .send({ code: otp });
      const device1Cookie = extractCookieFromResponse(verifyRes)!.cookiePair;

      // Second login (Device 2)
      const login2Res = await request(app).post('/api/auth/login').send({
        email: targetEmail,
        password: 'OutsidePassword2026!',
      });
      const device2Cookie = extractCookieFromResponse(login2Res)!.cookiePair;

      // Warm cache on Device 1
      const dashOk = await request(app)
        .get('/api/organizer/dashboard')
        .set('Cookie', device1Cookie);
      expect(dashOk.status).toBe(200);
      expect(await getCachedUserAuth(targetUserId)).not.toBeNull();

      // 2. Log in as seeded Admin (`admin@outside.vip`)
      const adminLogin = await request(app).post('/api/auth/login').send({
        email: 'admin@outside.vip',
        password: 'Outside2026!',
      });
      expect(adminLogin.status).toBe(200);
      const adminCookie = extractCookieFromResponse(adminLogin)!.cookiePair;
      const adminCsrf = adminLogin.body.data.csrfToken;

      // 3. Admin suspends the target user
      const suspendRes = await request(app)
        .patch(`/api/auth/users/${targetUserId}/status`)
        .set('Cookie', adminCookie)
        .set('X-CSRF-Token', adminCsrf)
        .send({ status: 'SUSPENDED', reason: 'Security policy violation' });

      expect(suspendRes.status).toBe(200);
      expect(suspendRes.body.data.user.status).toBe('SUSPENDED');
      expect(suspendRes.body.data.revokedSessions).toBeGreaterThanOrEqual(2);

      // Cache must be immediately cleared
      expect(await getCachedUserAuth(targetUserId)).toBeNull();

      // Both Device 1 and Device 2 sessions must be immediately rejected
      const dev1After = await request(app)
        .get('/api/organizer/dashboard')
        .set('Cookie', device1Cookie);
      expect(dev1After.status).toBe(401);

      const dev2After = await request(app)
        .get('/api/organizer/dashboard')
        .set('Cookie', device2Cookie);
      expect(dev2After.status).toBe(401);

      // Suspended user cannot log back in
      const blockedLogin = await request(app).post('/api/auth/login').send({
        email: targetEmail,
        password: 'OutsidePassword2026!',
      });
      expect(blockedLogin.status).toBe(403);
      expect(blockedLogin.body.error.code).toBe('ACCOUNT_SUSPENDED');
    });
  });

  describe('7. Mandatory Fresh Database Verification for Sensitive Actions', () => {
    it('always queries PostgreSQL directly for sensitive actions (admin, withdrawals, password change) even when Redis user cache is warm', async () => {
      const email = `fresh_db_check_${Date.now()}@outside.vip`;
      const regRes = await request(app).post('/api/auth/register').send({
        email,
        password: 'OutsidePassword2026!',
        name: 'Sensitive Action User',
      });
      const userId = regRes.body.data.user.id;
      createdUserIds.push(userId);

      const regCookie = extractCookieFromResponse(regRes)!;
      const otp = getLatestVerificationEmail(email)!.code;
      const verifyRes = await request(app)
        .post('/api/auth/verify-email')
        .set('Cookie', regCookie.cookiePair)
        .set('X-CSRF-Token', regRes.body.data.csrfToken)
        .send({ code: otp });

      const cookiePair = extractCookieFromResponse(verifyRes)!.cookiePair;
      const csrfToken = verifyRes.body.data.csrfToken;

      // Ensure user cache is warm
      expect(await getCachedUserAuth(userId)).not.toBeNull();

      resetUserDbReadCount();

      // 1. Ordinary endpoint (GET /api/organizer/events) -> 0 User DB queries
      await request(app).get('/api/organizer/events').set('Cookie', cookiePair);
      expect(getUserDbReadCount()).toBe(0);

      // 2. Sensitive endpoint: GET /api/auth/me -> forces fresh PostgreSQL verification
      const meRes = await request(app).get('/api/auth/me').set('Cookie', cookiePair);
      expect(meRes.status).toBe(200);
      expect(getUserDbReadCount()).toBeGreaterThan(0);

      resetUserDbReadCount();

      // 3. Sensitive endpoint: POST /api/organizer/finance/withdraw -> forces fresh PostgreSQL verification
      await request(app)
        .post('/api/organizer/finance/withdraw')
        .set('Cookie', cookiePair)
        .set('X-CSRF-Token', csrfToken)
        .send({ amountInCents: 5000, idempotencyKey: `idem_sens_${Date.now()}` });
      expect(getUserDbReadCount()).toBeGreaterThan(0);
    });
  });

  describe('9. Fail-Closed Behavior on Redis Failures', () => {
    it('fails closed with 503 AUTH_STORE_UNAVAILABLE when Redis fails during an authenticated request and never bypasses session validation', async () => {
      const loginRes = await request(app).post('/api/auth/login').send({
        email: 'sol@outside.vip',
        password: 'Outside2026!',
      });
      expect(loginRes.status).toBe(200);
      const cookiePair = extractCookieFromResponse(loginRes)!.cookiePair;

      // Simulate Redis outage
      setSimulatedRedisFailure(true);
      try {
        const dashRes = await request(app)
          .get('/api/organizer/dashboard')
          .set('Cookie', cookiePair);
        expect(dashRes.status).toBe(503);
        expect(dashRes.body.error.code).toBe('AUTH_STORE_UNAVAILABLE');
      } finally {
        setSimulatedRedisFailure(false);
      }
    });
  });

  describe('10. Idle & Absolute Expiration, Logout, Password Change & CSRF Enforcement', () => {
    it('enforces 30-minute idle timeout and 7-day absolute session lifetime', async () => {
      const loginRes = await request(app).post('/api/auth/login').send({
        email: 'sol@outside.vip',
        password: 'Outside2026!',
      });
      const cookie = extractCookieFromResponse(loginRes)!;
      const [sessionId] = cookie.value.split('.');
      const redis = getRedisClient();

      // 1. Simulate session idle for 31 minutes (> 30m idle timeout)
      const rawJson = await redis.get(`${SESSION_PREFIX}${sessionId}`);
      const record = JSON.parse(rawJson!);
      record.lastActiveAt = Date.now() - 31 * 60 * 1000;
      await redis.setPx(`${SESSION_PREFIX}${sessionId}`, JSON.stringify(record), 60_000);

      const idleExpiredRes = await request(app)
        .get('/api/organizer/dashboard')
        .set('Cookie', cookie.cookiePair);
      expect(idleExpiredRes.status).toBe(401);

      // 2. Create another session and simulate 7-day absolute lifetime reached despite recent activity
      const loginRes2 = await request(app).post('/api/auth/login').send({
        email: 'sol@outside.vip',
        password: 'Outside2026!',
      });
      const cookie2 = extractCookieFromResponse(loginRes2)!;
      const [sessionId2] = cookie2.value.split('.');
      const rawJson2 = await redis.get(`${SESSION_PREFIX}${sessionId2}`);
      const record2 = JSON.parse(rawJson2!);
      record2.createdAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
      record2.absoluteExpiresAt = Date.now() - 1000; // Expired 1s ago
      record2.lastActiveAt = Date.now(); // Active just now
      await redis.setPx(`${SESSION_PREFIX}${sessionId2}`, JSON.stringify(record2), 60_000);

      const absExpiredRes = await request(app)
        .get('/api/organizer/dashboard')
        .set('Cookie', cookie2.cookiePair);
      expect(absExpiredRes.status).toBe(401);
    });

    it('invalidates session immediately on logout and revokes all prior sessions on password change', async () => {
      const email = `pwd_revoke_${Date.now()}@outside.vip`;
      const regRes = await request(app).post('/api/auth/register').send({
        email,
        password: 'InitialPassword2026!',
        name: 'Password Revoke Tester',
      });
      createdUserIds.push(regRes.body.data.user.id);
      const session1Cookie = extractCookieFromResponse(regRes)!.cookiePair;
      const session1Csrf = regRes.body.data.csrfToken;

      // Second concurrent session
      const login2Res = await request(app).post('/api/auth/login').send({
        email,
        password: 'InitialPassword2026!',
      });
      const session2Cookie = extractCookieFromResponse(login2Res)!.cookiePair;
      const session2Csrf = login2Res.body.data.csrfToken;

      // Change password from Session 2 -> revokes Session 1 & old Session 2, issues rotated Session 3
      const changePwdRes = await request(app)
        .post('/api/auth/change-password')
        .set('Cookie', session2Cookie)
        .set('X-CSRF-Token', session2Csrf)
        .send({
          currentPassword: 'InitialPassword2026!',
          newPassword: 'UpdatedPassword2026!',
        });
      expect(changePwdRes.status).toBe(200);
      const session3Cookie = extractCookieFromResponse(changePwdRes)!.cookiePair;
      const session3Csrf = changePwdRes.body.data.csrfToken;

      // Session 1 and old Session 2 are now revoked
      const s1Check = await request(app).get('/api/auth/me').set('Cookie', session1Cookie);
      expect(s1Check.status).toBe(401);

      const s2Check = await request(app).get('/api/auth/me').set('Cookie', session2Cookie);
      expect(s2Check.status).toBe(401);

      // Rotated Session 3 works
      const s3Check = await request(app).get('/api/auth/me').set('Cookie', session3Cookie);
      expect(s3Check.status).toBe(200);

      // Logout from Session 3 invalidates it immediately
      const logoutRes = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', session3Cookie)
        .set('X-CSRF-Token', session3Csrf);
      expect(logoutRes.status).toBe(200);

      const s3AfterLogout = await request(app).get('/api/auth/me').set('Cookie', session3Cookie);
      expect(s3AfterLogout.status).toBe(401);
    });

    it('enforces CSRF token and Origin validation on state-changing requests', async () => {
      const loginRes = await request(app).post('/api/auth/login').send({
        email: 'sol@outside.vip',
        password: 'Outside2026!',
      });
      const cookiePair = extractCookieFromResponse(loginRes)!.cookiePair;
      const validCsrf = loginRes.body.data.csrfToken;

      // 1. Missing X-CSRF-Token on cookie-authenticated PATCH -> 403 CSRF_TOKEN_MISSING
      const missingCsrfRes = await request(app)
        .patch('/api/auth/profile')
        .set('Cookie', cookiePair)
        .send({ name: 'Sol Updated' });
      expect(missingCsrfRes.status).toBe(403);
      expect(missingCsrfRes.body.error.code).toBe('CSRF_TOKEN_MISSING');

      // 2. Invalid X-CSRF-Token -> 403 CSRF_TOKEN_INVALID
      const invalidCsrfRes = await request(app)
        .patch('/api/auth/profile')
        .set('Cookie', cookiePair)
        .set('X-CSRF-Token', 'forged_csrf_token_value')
        .send({ name: 'Sol Updated' });
      expect(invalidCsrfRes.status).toBe(403);
      expect(invalidCsrfRes.body.error.code).toBe('CSRF_TOKEN_INVALID');

      // 3. Untrusted Origin header -> 403 CSRF_ORIGIN_MISMATCH
      const badOriginRes = await request(app)
        .patch('/api/auth/profile')
        .set('Origin', 'https://evil-attacker.example.com')
        .set('Cookie', cookiePair)
        .set('X-CSRF-Token', validCsrf)
        .send({ name: 'Sol Updated' });
      expect(badOriginRes.status).toBe(403);
      expect(badOriginRes.body.error.code).toBe('CSRF_ORIGIN_MISMATCH');

      // 4. Sec-Fetch-Site: cross-site -> 403 CSRF_CROSS_SITE_BLOCKED
      const crossSiteRes = await request(app)
        .patch('/api/auth/profile')
        .set('Sec-Fetch-Site', 'cross-site')
        .set('Cookie', cookiePair)
        .set('X-CSRF-Token', validCsrf)
        .send({ name: 'Sol Updated' });
      expect(crossSiteRes.status).toBe(403);
      expect(crossSiteRes.body.error.code).toBe('CSRF_CROSS_SITE_BLOCKED');

      // 5. Valid Origin + Valid X-CSRF-Token -> 200 OK (for https://out-side.vip, https://www.out-side.vip, and https://outside.vip)
      for (const trustedOrigin of [
        'https://out-side.vip',
        'https://www.out-side.vip',
        'https://outside.vip',
      ]) {
        const validUpdateRes = await request(app)
          .patch('/api/auth/profile')
          .set('Origin', trustedOrigin)
          .set('Cookie', cookiePair)
          .set('X-CSRF-Token', validCsrf)
          .send({ name: 'Sol Collective' });
        expect(validUpdateRes.status).toBe(200);
      }
    });
  });
});
