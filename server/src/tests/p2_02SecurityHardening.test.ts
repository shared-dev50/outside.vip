import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import {
  AccountStatus,
  EventStatus,
  EventTeamRole,
  PromotionLinkStatus,
  PromotionLinkType,
  Role,
  TeamMemberStatus,
} from '@prisma/client';
import { app } from '../app.js';
import { prisma } from '../db/prisma.js';
import {
  SLIDING_WINDOW_RATE_LIMIT_LUA,
  getRedisClient,
  setSimulatedRedisFailure,
} from '../lib/redis.js';
import {
  SLIDING_WINDOW_RATE_LIMIT_PREFIX,
  checkRedisSlidingWindowRateLimit,
  createSession,
  hashRateLimitIdentifier,
} from '../lib/session.service.js';
import {
  MAX_RESEND_REQUESTS_PER_WINDOW,
  MAX_VERIFY_REQUESTS_PER_WINDOW,
  RATE_LIMIT_WINDOW_MS,
  resetVerificationRateLimits,
} from '../modules/auth/auth.controller.js';
import { getLatestVerificationEmail, resetSentVerificationEmails } from '../lib/email.service.js';
import { ensureOrganizerWorkspaceForUser } from '../modules/organizer/organizer.controller.js';

describe('P2-02 Security Hardening: Redis OTP Sliding-Window Rate Limiting & HOST->ADMIN Guard', () => {
  const runId = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const createdUserIds: string[] = [];
  const createdEventIds: string[] = [];
  let validPasswordHash: string;

  async function issueSessionAuth(userId: string) {
    const session = await createSession({
      userId,
      ipAddress: '127.0.0.1',
      userAgent: 'P2-02Vitest',
    });
    return {
      cookie: `__Host-outside_sid=${session.rawCookieValue}`,
      csrf: session.csrfToken,
    };
  }

  beforeAll(async () => {
    validPasswordHash = await bcrypt.hash('StrongPass#2026!', 10);
  });

  beforeEach(async () => {
    setSimulatedRedisFailure(false);
    resetSentVerificationEmails();
    await resetVerificationRateLimits();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    setSimulatedRedisFailure(false);
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    setSimulatedRedisFailure(false);
    await resetVerificationRateLimits();

    if (createdEventIds.length > 0) {
      await prisma.promotionLink.updateMany({
        where: { eventId: { in: createdEventIds } },
        data: { status: PromotionLinkStatus.ARCHIVED },
      });
      await prisma.promotionSlugRegistry.deleteMany({
        where: { promotionLink: { eventId: { in: createdEventIds } } },
      });
      await prisma.promotionLink.deleteMany({ where: { eventId: { in: createdEventIds } } });
      await prisma.eventTeamInvitation.deleteMany({ where: { eventId: { in: createdEventIds } } });
      await prisma.eventTeamMember.deleteMany({ where: { eventId: { in: createdEventIds } } });
      await prisma.event.deleteMany({ where: { id: { in: createdEventIds } } });
    }

    if (createdUserIds.length > 0) {
      await prisma.emailVerificationCode.deleteMany({
        where: { userId: { in: createdUserIds } },
      });
      await prisma.organizerProfile.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
  });

  // ==========================================
  // Workstream A: Redis-backed OTP Rate Limiting
  // ==========================================
  describe('Workstream A: Genuine Redis Sliding-Window OTP Rate Limiting', () => {
    it('exports an atomic ZSET Lua script and sets TTL without leaking raw IDs in Redis keys', async () => {
      expect(SLIDING_WINDOW_RATE_LIMIT_LUA).toContain('ZREMRANGEBYSCORE');
      expect(SLIDING_WINDOW_RATE_LIMIT_LUA).toContain('ZCARD');
      expect(SLIDING_WINDOW_RATE_LIMIT_LUA).toContain('ZADD');
      expect(SLIDING_WINDOW_RATE_LIMIT_LUA).toContain('PEXPIRE');

      const rawUserId = `user_sensitive_id_${runId}`;
      const hashed = hashRateLimitIdentifier(rawUserId);
      expect(hashed).not.toContain(rawUserId);

      const key = `otp_verify:${hashed}`;
      const redis = getRedisClient();
      const res = await checkRedisSlidingWindowRateLimit(
        key,
        MAX_VERIFY_REQUESTS_PER_WINDOW,
        RATE_LIMIT_WINDOW_MS
      );
      expect(res.allowed).toBe(true);
      expect(res.count).toBe(1);

      const fullRedisKey = `${SLIDING_WINDOW_RATE_LIMIT_PREFIX}${key}`;
      expect(fullRedisKey).not.toContain(rawUserId);
      const ttlMs = await redis.pttl(fullRedisKey);
      expect(ttlMs).toBeGreaterThan(0);
      expect(ttlMs).toBeLessThanOrEqual(RATE_LIMIT_WINDOW_MS);
    });

    it('enforces genuine sliding-window expiration (partial bucket expiry without fixed-window double-burst)', async () => {
      const redis = getRedisClient();
      const key = `${SLIDING_WINDOW_RATE_LIMIT_PREFIX}sliding_parity_${runId}`;
      const windowMs = RATE_LIMIT_WINDOW_MS; // 15 minutes
      const max = MAX_RESEND_REQUESTS_PER_WINDOW; // 5
      const t0 = 1_700_000_000_000;

      // 2 requests at t = 0
      expect((await redis.consumeSlidingWindowRateLimit(key, max, windowMs, t0)).allowed).toBe(true);
      expect((await redis.consumeSlidingWindowRateLimit(key, max, windowMs, t0 + 100)).allowed).toBe(true);

      // 3 requests at t = 10 minutes
      const t10m = t0 + 10 * 60 * 1000;
      expect((await redis.consumeSlidingWindowRateLimit(key, max, windowMs, t10m)).allowed).toBe(true);
      expect((await redis.consumeSlidingWindowRateLimit(key, max, windowMs, t10m + 1)).allowed).toBe(true);
      expect((await redis.consumeSlidingWindowRateLimit(key, max, windowMs, t10m + 2)).allowed).toBe(true);

      // 6th request inside 15 minutes is blocked, retryAfter reflects oldest event (t = 0)
      const blockedBeforeExpiry = await redis.consumeSlidingWindowRateLimit(
        key,
        max,
        windowMs,
        t0 + windowMs - 500
      );
      expect(blockedBeforeExpiry.allowed).toBe(false);
      expect(blockedBeforeExpiry.count).toBe(5);
      expect(blockedBeforeExpiry.retryAfterMs).toBe(500);

      // Advance just past 15m from t0: ONLY the 2 entries from t0..t0+100 expire!
      // The 3 entries at t = 10m remain active -> only 2 new slots open (not 5).
      const tAfterFirstTwoExpire = t0 + windowMs + 200;
      const slot4 = await redis.consumeSlidingWindowRateLimit(
        key,
        max,
        windowMs,
        tAfterFirstTwoExpire
      );
      expect(slot4.allowed).toBe(true);
      expect(slot4.count).toBe(4);

      const slot5 = await redis.consumeSlidingWindowRateLimit(
        key,
        max,
        windowMs,
        tAfterFirstTwoExpire + 10
      );
      expect(slot5.allowed).toBe(true);
      expect(slot5.count).toBe(5);

      const slot6Blocked = await redis.consumeSlidingWindowRateLimit(
        key,
        max,
        windowMs,
        tAfterFirstTwoExpire + 20
      );
      expect(slot6Blocked.allowed).toBe(false);
      expect(slot6Blocked.count).toBe(5);

      // After t10m + windowMs + 10s, all 5 previous requests have aged out cleanly
      const tAllExpired = tAfterFirstTwoExpire + windowMs + 10_000;
      const freshAfterFullWindow = await redis.consumeSlidingWindowRateLimit(
        key,
        max,
        windowMs,
        tAllExpired
      );
      expect(freshAfterFullWindow.allowed).toBe(true);
      expect(freshAfterFullWindow.count).toBe(1);
    });

    it('prevents concurrent burst bypass under same-millisecond Promise.all contention', async () => {
      const key = `concurrent_burst_${runId}`;
      const fixedSameMs = 1_700_100_000_000;

      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          checkRedisSlidingWindowRateLimit(
            key,
            MAX_VERIFY_REQUESTS_PER_WINDOW,
            RATE_LIMIT_WINDOW_MS,
            fixedSameMs
          )
        )
      );

      const allowedCount = results.filter((r) => r.allowed).length;
      const blockedCount = results.filter((r) => !r.allowed).length;
      expect(allowedCount).toBe(MAX_VERIFY_REQUESTS_PER_WINDOW);
      expect(blockedCount).toBe(12);
    });

    it('shares OTP verify & resend rate-limit state across independent requests, isolates buckets, and preserves thresholds (8/15m verify, 5/15m resend)', async () => {
      const email = `otp_redis_http_${runId}@outside.vip`;
      const regRes = await request(app)
        .post('/api/auth/register')
        .send({
          email,
          password: 'OutsidePassword2026!',
          name: 'OTP Redis User',
        })
        .expect(201);

      const userId = regRes.body.data.user.id as string;
      const token = regRes.body.data.token as string;
      createdUserIds.push(userId);

      // Simulate 5 resend requests inside 15 minutes (moving only the current active code's createdAt past 60s cooldown)
      for (let i = 0; i < MAX_RESEND_REQUESTS_PER_WINDOW; i++) {
        await prisma.emailVerificationCode.updateMany({
          where: { userId, usedAt: null, expiresAt: { gt: new Date() } },
          data: { createdAt: new Date(Date.now() - 65_000) },
        });
        const resendRes = await request(app)
          .post('/api/auth/resend-verification')
          .set('Authorization', `Bearer ${token}`)
          .send({});
        expect(resendRes.status).toBe(200);
      }

      // 6th resend request within 15 minutes must be blocked with exact 429 VERIFICATION_RESEND_RATE_LIMIT
      await prisma.emailVerificationCode.updateMany({
        where: { userId, usedAt: null, expiresAt: { gt: new Date() } },
        data: { createdAt: new Date(Date.now() - 65_000) },
      });
      const sixthResend = await request(app)
        .post('/api/auth/resend-verification')
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(sixthResend.status).toBe(429);
      expect(sixthResend.body.error.code).toBe('VERIFICATION_RESEND_RATE_LIMIT');
      expect(sixthResend.body.error.message).toBe(
        'Too many verification code requests. Please try again later.'
      );

      // Verify bucket MUST be independent of exhausted resend bucket:
      // Make 8 verify attempts (resetting attempts on the active code after 4 wrong tries so sliding limit is isolated)
      for (let i = 0; i < MAX_VERIFY_REQUESTS_PER_WINDOW; i++) {
        if (i === 4) {
          await prisma.emailVerificationCode.updateMany({
            where: { userId, usedAt: null, expiresAt: { gt: new Date() } },
            data: { attempts: 0 },
          });
        }
        const wrongVerify = await request(app)
          .post('/api/auth/verify-email')
          .set('Authorization', `Bearer ${token}`)
          .send({ code: '000000' });
        expect(wrongVerify.status).toBe(400);
      }

      // 9th verify attempt hits Redis sliding-window limit (even before inspecting DB code attempts)
      const ninthVerify = await request(app)
        .post('/api/auth/verify-email')
        .set('Authorization', `Bearer ${token}`)
        .send({ code: '000000' });
      expect(ninthVerify.status).toBe(429);
      expect(ninthVerify.body.error.code).toBe('VERIFICATION_RATE_LIMIT');
      expect(ninthVerify.body.error.message).toBe(
        'Too many verification attempts. Please wait before trying again.'
      );

      // Concurrent verify requests when already exhausted stay blocked with 429
      const concurrentBlocked = await Promise.all(
        Array.from({ length: 4 }, () =>
          request(app)
            .post('/api/auth/verify-email')
            .set('Authorization', `Bearer ${token}`)
            .send({ code: '000000' })
        )
      );
      for (const r of concurrentBlocked) {
        expect(r.status).toBe(429);
        expect(r.body.error.code).toBe('VERIFICATION_RATE_LIMIT');
      }

      // After rate-limit window clears, valid OTP verification completes normally
      await resetVerificationRateLimits();
      await prisma.emailVerificationCode.updateMany({
        where: { userId, usedAt: null, expiresAt: { gt: new Date() } },
        data: { attempts: 0 },
      });
      const latestEmail = getLatestVerificationEmail(email);
      expect(latestEmail).toBeTruthy();

      const successVerify = await request(app)
        .post('/api/auth/verify-email')
        .set('Authorization', `Bearer ${token}`)
        .send({ code: latestEmail!.code });
      expect(successVerify.status).toBe(200);
      expect(successVerify.body.data.user.emailVerified).toBe(true);
    });

    it('shares rate-limit state across independent worker instances sharing the Redis backend', async () => {
      const email = `otp_cross_worker_${runId}@outside.vip`;
      const regRes = await request(app)
        .post('/api/auth/register')
        .send({
          email,
          password: 'OutsidePassword2026!',
          name: 'Cross Worker User',
        })
        .expect(201);

      const userId = regRes.body.data.user.id as string;
      const token = regRes.body.data.token as string;
      createdUserIds.push(userId);

      // Worker 1 records 7 attempts directly in Redis via the shared session helper
      const rateKey = `otp_verify:${hashRateLimitIdentifier(userId)}`;
      for (let i = 0; i < 7; i++) {
        const check = await checkRedisSlidingWindowRateLimit(
          rateKey,
          MAX_VERIFY_REQUESTS_PER_WINDOW,
          RATE_LIMIT_WINDOW_MS
        );
        expect(check.allowed).toBe(true);
      }

      // Worker 2 handling HTTP /api/auth/verify-email sees the 8th attempt, then blocks 9th
      const attempt8 = await request(app)
        .post('/api/auth/verify-email')
        .set('Authorization', `Bearer ${token}`)
        .send({ code: '000000' });
      expect(attempt8.status).toBe(400);

      const attempt9 = await request(app)
        .post('/api/auth/verify-email')
        .set('Authorization', `Bearer ${token}`)
        .send({ code: '000000' });
      expect(attempt9.status).toBe(429);
      expect(attempt9.body.error.code).toBe('VERIFICATION_RATE_LIMIT');
    });

    it('fails closed with 503 AUTH_STORE_UNAVAILABLE on Redis outage (never falls back to in-memory Maps) and rejects missing REDIS_URL in production', async () => {
      const email = `otp_fail_closed_${runId}@outside.vip`;
      const regRes = await request(app)
        .post('/api/auth/register')
        .send({
          email,
          password: 'OutsidePassword2026!',
          name: 'Fail Closed User',
        })
        .expect(201);

      const userId = regRes.body.data.user.id as string;
      const token = regRes.body.data.token as string;
      createdUserIds.push(userId);

      setSimulatedRedisFailure(true);

      const verifyOutage = await request(app)
        .post('/api/auth/verify-email')
        .set('Authorization', `Bearer ${token}`)
        .send({ code: '123456' });
      expect(verifyOutage.status).toBe(503);
      expect(verifyOutage.body.error.code).toBe('AUTH_STORE_UNAVAILABLE');

      const resendOutage = await request(app)
        .post('/api/auth/resend-verification')
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(resendOutage.status).toBe(503);
      expect(resendOutage.body.error.code).toBe('AUTH_STORE_UNAVAILABLE');

      setSimulatedRedisFailure(false);

      // Verify production fails fast if REDIS_URL is missing instead of using AtomicMemoryRedisAdapter
      const prevNodeEnv = process.env.NODE_ENV;
      const prevRedisUrl = process.env.REDIS_URL;
      const prevAllowMem = process.env.ALLOW_MEMORY_REDIS_IN_TEST;
      try {
        process.env.NODE_ENV = 'production';
        delete process.env.REDIS_URL;
        delete process.env.ALLOW_MEMORY_REDIS_IN_TEST;
        expect(() => getRedisClient()).toThrow(/REDIS_URL is required in production/i);
      } finally {
        process.env.NODE_ENV = prevNodeEnv;
        if (prevRedisUrl === undefined) {
          delete process.env.REDIS_URL;
        } else {
          process.env.REDIS_URL = prevRedisUrl;
        }
        if (prevAllowMem === undefined) {
          delete process.env.ALLOW_MEMORY_REDIS_IN_TEST;
        } else {
          process.env.ALLOW_MEMORY_REDIS_IN_TEST = prevAllowMem;
        }
      }
    });
  });

  // ==========================================
  // Workstream B: HOST -> ADMIN Promotion Guard
  // ==========================================
  describe('Workstream B: Passwordless & Inactive HOST -> ADMIN Promotion Guard', () => {
    let ownerUser: any;
    let ownerAuth: { cookie: string; csrf: string };
    let event: any;

    beforeAll(async () => {
      ownerUser = await prisma.user.create({
        data: {
          email: `p202_owner_${runId}@outside.vip`,
          name: 'P202 Event Owner',
          passwordHash: validPasswordHash,
          role: Role.ORGANIZER,
          status: AccountStatus.ACTIVE,
          emailVerified: true,
          emailVerifiedAt: new Date(),
        },
      });
      createdUserIds.push(ownerUser.id);
      await ensureOrganizerWorkspaceForUser(ownerUser.id, ownerUser.name);

      event = await prisma.event.create({
        data: {
          organizerId: ownerUser.id,
          title: `P202 Guard Event ${runId}`,
          description: 'Event for HOST->ADMIN promotion guard tests',
          coverImageUrl: 'https://example.com/p202-cover.jpg',
          venueName: 'Nairobi Grounds',
          venueAddress: '100 Arena Way',
          city: 'Nairobi',
          country: 'Kenya',
          slug: `p202-guard-${runId}`.toLowerCase(),
          category: 'MUSIC',
          status: EventStatus.PUBLISHED,
          startAt: new Date(Date.now() + 86400_000),
          endAt: new Date(Date.now() + 2 * 86400_000),
          timezone: 'Africa/Nairobi',
        },
      });
      createdEventIds.push(event.id);
      ownerAuth = await issueSessionAuth(ownerUser.id);
    });

    async function createHostWithPromoLink(opts: {
      suffix: string;
      passwordHash: string | null;
      status: AccountStatus;
    }) {
      const user = await prisma.user.create({
        data: {
          email: `p202_host_${opts.suffix}_${runId}@outside.vip`,
          name: `Host ${opts.suffix}`,
          passwordHash: opts.passwordHash,
          role: Role.ATTENDEE,
          status: opts.status,
          emailVerified: true,
          emailVerifiedAt: new Date(),
        },
      });
      createdUserIds.push(user.id);

      const member = await prisma.eventTeamMember.create({
        data: {
          eventId: event.id,
          userId: user.id,
          role: EventTeamRole.HOST,
          status: TeamMemberStatus.ACTIVE,
          permissions: undefined,
        },
      });

      const slugValue = `p202-${opts.suffix}-${runId}-${crypto.randomBytes(2).toString('hex')}`
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-');
      const promoLink = await prisma.promotionLink.create({
        data: {
          eventId: event.id,
          hostMemberId: member.id,
          name: `Host Link ${opts.suffix}`,
          type: PromotionLinkType.HOST,
          status: PromotionLinkStatus.ACTIVE,
          createdById: ownerUser.id,
          slugRegistry: {
            create: {
              slug: slugValue,
              isPrimary: true,
            },
          },
        },
      });

      return { user, member, promoLink };
    }

    it('rejects promoting a passwordless HOST (passwordHash: null) to ADMIN with 403 ADMIN_PASSWORD_REQUIRED and leaves DB + promo link untouched', async () => {
      const { member, promoLink } = await createHostWithPromoLink({
        suffix: 'pwless_null',
        passwordHash: null,
        status: AccountStatus.ACTIVE,
      });

      const res = await request(app)
        .patch(`/api/events/${event.id}/team/members/${member.id}`)
        .set('Cookie', ownerAuth.cookie)
        .set('x-csrf-token', ownerAuth.csrf)
        .send({
          role: EventTeamRole.ADMIN,
          permissions: { canEditDetails: true, canManageTeam: false },
        });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ADMIN_PASSWORD_REQUIRED');

      const memberAfter = await prisma.eventTeamMember.findUnique({ where: { id: member.id } });
      expect(memberAfter?.role).toBe(EventTeamRole.HOST);
      expect(memberAfter?.permissions).toBeNull();

      // Critical atomicity assertion: HOST's promotional link must NOT be archived on rejected promotion
      const linkAfter = await prisma.promotionLink.findUnique({ where: { id: promoLink.id } });
      expect(linkAfter?.status).toBe(PromotionLinkStatus.ACTIVE);
    });

    it('rejects promoting a HOST with whitespace-only passwordHash to ADMIN with 403 ADMIN_PASSWORD_REQUIRED', async () => {
      const { member, promoLink } = await createHostWithPromoLink({
        suffix: 'pw_blank',
        passwordHash: '   ',
        status: AccountStatus.ACTIVE,
      });

      const res = await request(app)
        .patch(`/api/events/${event.id}/team/members/${member.id}`)
        .set('Cookie', ownerAuth.cookie)
        .set('x-csrf-token', ownerAuth.csrf)
        .send({ role: EventTeamRole.ADMIN });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ADMIN_PASSWORD_REQUIRED');

      const memberAfter = await prisma.eventTeamMember.findUnique({ where: { id: member.id } });
      expect(memberAfter?.role).toBe(EventTeamRole.HOST);
      expect(memberAfter?.permissions).toBeNull();

      const linkAfter = await prisma.promotionLink.findUnique({ where: { id: promoLink.id } });
      expect(linkAfter?.status).toBe(PromotionLinkStatus.ACTIVE);
    });

    it('rejects promoting a suspended/disabled HOST (even with valid passwordHash) to ADMIN with 403 and leaves DB unchanged', async () => {
      const { member, promoLink } = await createHostWithPromoLink({
        suffix: 'suspended',
        passwordHash: validPasswordHash,
        status: AccountStatus.SUSPENDED,
      });

      const res = await request(app)
        .patch(`/api/events/${event.id}/team/members/${member.id}`)
        .set('Cookie', ownerAuth.cookie)
        .set('x-csrf-token', ownerAuth.csrf)
        .send({ role: EventTeamRole.ADMIN });

      expect(res.status).toBe(403);

      const memberAfter = await prisma.eventTeamMember.findUnique({ where: { id: member.id } });
      expect(memberAfter?.role).toBe(EventTeamRole.HOST);

      const linkAfter = await prisma.promotionLink.findUnique({ where: { id: promoLink.id } });
      expect(linkAfter?.status).toBe(PromotionLinkStatus.ACTIVE);
    });

    it('allows promoting an ACTIVE password-protected HOST to ADMIN, initializing permissions and archiving HOST link', async () => {
      const { member, promoLink } = await createHostWithPromoLink({
        suffix: 'eligible',
        passwordHash: validPasswordHash,
        status: AccountStatus.ACTIVE,
      });

      const res = await request(app)
        .patch(`/api/events/${event.id}/team/members/${member.id}`)
        .set('Cookie', ownerAuth.cookie)
        .set('x-csrf-token', ownerAuth.csrf)
        .send({
          role: EventTeamRole.ADMIN,
          permissions: { canEditDetails: true, canManageTickets: true },
        });

      expect(res.status).toBe(200);
      expect(res.body.member.role).toBe(EventTeamRole.ADMIN);

      const memberAfter = await prisma.eventTeamMember.findUnique({ where: { id: member.id } });
      expect(memberAfter?.role).toBe(EventTeamRole.ADMIN);
      expect((memberAfter?.permissions as Record<string, boolean>)?.canEditDetails).toBe(true);
      expect((memberAfter?.permissions as Record<string, boolean>)?.canManageTickets).toBe(true);

      const linkAfter = await prisma.promotionLink.findUnique({ where: { id: promoLink.id } });
      expect(linkAfter?.status).toBe(PromotionLinkStatus.ARCHIVED);

      // Existing ADMIN -> ADMIN permission updates continue working normally
      const adminUpdate = await request(app)
        .patch(`/api/events/${event.id}/team/members/${member.id}`)
        .set('Cookie', ownerAuth.cookie)
        .set('x-csrf-token', ownerAuth.csrf)
        .send({
          permissions: { canEditDetails: false, canManageTickets: true },
        });
      expect(adminUpdate.status).toBe(200);
      expect((adminUpdate.body.member.permissions as Record<string, boolean>)?.canEditDetails).toBe(
        false
      );
    });

    it('keeps passwordless HOST -> HOST status updates unaffected', async () => {
      const { member } = await createHostWithPromoLink({
        suffix: 'host_to_host',
        passwordHash: null,
        status: AccountStatus.ACTIVE,
      });

      const suspendRes = await request(app)
        .patch(`/api/events/${event.id}/team/members/${member.id}`)
        .set('Cookie', ownerAuth.cookie)
        .set('x-csrf-token', ownerAuth.csrf)
        .send({ status: TeamMemberStatus.INACTIVE });

      expect(suspendRes.status).toBe(200);
      expect(suspendRes.body.member.role).toBe(EventTeamRole.HOST);
      expect(suspendRes.body.member.status).toBe(TeamMemberStatus.INACTIVE);
    });
  });
});
