import net from 'net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../app.js';
import { prisma } from '../db/prisma.js';
import { resetSentVerificationEmails } from '../lib/email.service.js';
import {
  IoRedisStoreAdapter,
  SLIDING_WINDOW_RATE_LIMIT_LUA,
  createIoRedisClientForTests,
  getRedisClient,
  initActiveRedisClientForTests,
  resetActiveRedisClientForTests,
} from '../lib/redis.js';
import {
  SESSION_PREFIX,
  SLIDING_WINDOW_RATE_LIMIT_PREFIX,
  USER_AUTH_CACHE_PREFIX,
  USER_AUTH_VERSION_PREFIX,
  USER_SESSIONS_PREFIX,
  checkRedisSlidingWindowRateLimit,
  hashRateLimitIdentifier,
} from '../lib/session.service.js';
import {
  MAX_RESEND_REQUESTS_PER_WINDOW,
  MAX_VERIFY_REQUESTS_PER_WINDOW,
  RATE_LIMIT_WINDOW_MS,
} from '../modules/auth/auth.controller.js';

function getUnusedLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('Unable to allocate ephemeral port')));
        return;
      }
      const { port } = addr;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

describe('P2-02 Real Redis Integration Verification (Upstash TLS)', () => {
  const runId = `${Date.now()}_${Math.floor(Math.random() * 100_000)}`;
  const namespace = `p2_02_integration:${runId}:`;
  const createdUserIds: string[] = [];
  const trackedRedisKeys = new Set<string>();
  const extraClients: IoRedisStoreAdapter[] = [];
  let originalRedisUrl: string | undefined;

  function trackKey(key: string): string {
    trackedRedisKeys.add(key);
    return key;
  }

  beforeAll(async () => {
    originalRedisUrl = process.env.REDIS_URL?.trim();
    if (!originalRedisUrl) {
      throw new Error(
        'REDIS_URL is required to execute real-Redis P2-02 integration verification. Refusing to fall back to AtomicMemoryRedisAdapter.'
      );
    }

    resetSentVerificationEmails();
    const active = await initActiveRedisClientForTests(originalRedisUrl);
    expect(active).toBeInstanceOf(IoRedisStoreAdapter);
    await active.waitUntilReadyForTests(20_000);
    const pong = await active.ping();
    expect(pong).toBe('PONG');
  }, 45_000);

  afterAll(async () => {
    if (originalRedisUrl) {
      process.env.REDIS_URL = originalRedisUrl;
    }

    try {
      await resetActiveRedisClientForTests();
      if (originalRedisUrl) {
        const cleanupClient = createIoRedisClientForTests(originalRedisUrl);
        try {
          await cleanupClient.waitUntilReadyForTests();
          await cleanupClient.delByPrefixForTests(namespace);
          if (trackedRedisKeys.size > 0) {
            await cleanupClient.del(...Array.from(trackedRedisKeys));
          }
        } finally {
          await cleanupClient.quitForTests().catch(() => cleanupClient.disconnectForTests());
        }
      }
    } finally {
      for (const client of extraClients) {
        await client.quitForTests().catch(() => client.disconnectForTests());
      }
      await resetActiveRedisClientForTests().catch(() => {});
    }

    if (createdUserIds.length > 0) {
      await prisma.emailVerificationCode.deleteMany({
        where: { userId: { in: createdUserIds } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: createdUserIds } },
      });
    }
  }, 30_000);

  it('A. executes SLIDING_WINDOW_RATE_LIMIT_LUA via IoRedisStoreAdapter with accurate counts, rejections, retry timing, and TTL', async () => {
    expect(SLIDING_WINDOW_RATE_LIMIT_LUA).toContain('ZREMRANGEBYSCORE');
    expect(SLIDING_WINDOW_RATE_LIMIT_LUA).toContain('ZCARD');
    expect(SLIDING_WINDOW_RATE_LIMIT_LUA).toContain('ZADD');
    expect(SLIDING_WINDOW_RATE_LIMIT_LUA).toContain('PEXPIRE');

    const client = createIoRedisClientForTests(originalRedisUrl);
    extraClients.push(client);
    await client.waitUntilReadyForTests();

    const key = trackKey(`${namespace}scenario_a`);
    const maxRequests = 4;
    const windowMs = 60_000;
    const baseNow = Date.now();

    for (let i = 1; i <= maxRequests; i++) {
      const res = await client.consumeSlidingWindowRateLimit(
        key,
        maxRequests,
        windowMs,
        baseNow + i
      );
      expect(res.allowed).toBe(true);
      expect(res.count).toBe(i);
      expect(res.retryAfterMs).toBe(0);
    }

    const rejected = await client.consumeSlidingWindowRateLimit(
      key,
      maxRequests,
      windowMs,
      baseNow + 50
    );
    expect(rejected.allowed).toBe(false);
    expect(rejected.count).toBe(maxRequests);
    expect(rejected.retryAfterMs).toBeGreaterThan(0);
    expect(rejected.retryAfterMs).toBeLessThanOrEqual(windowMs);

    const pttl = await client.pttl(key);
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(windowMs);

    await client.quitForTests();
  }, 30_000);

  it('B. shares sliding-window counters and enforces thresholds identically across two independent IoRedisStoreAdapter clients', async () => {
    const clientA = createIoRedisClientForTests(originalRedisUrl);
    let clientB: IoRedisStoreAdapter | null = null;
    extraClients.push(clientA);

    try {
      await clientA.waitUntilReadyForTests(30_000);
      clientB = createIoRedisClientForTests(originalRedisUrl);
      extraClients.push(clientB);
      await clientB.waitUntilReadyForTests(30_000);

      expect(clientA).not.toBe(clientB);
      expect(await clientA.ping()).toBe('PONG');
      expect(await clientB.ping()).toBe('PONG');

      const key = trackKey(`${namespace}scenario_b_shared`);
      const maxRequests = 5;
      const windowMs = 60_000;
      const now = Date.now();

      for (let i = 1; i <= 3; i++) {
        const resA = await clientA.consumeSlidingWindowRateLimit(
          key,
          maxRequests,
          windowMs,
          now + i
        );
        expect(resA.allowed).toBe(true);
        expect(resA.count).toBe(i);
      }

      for (let i = 4; i <= 5; i++) {
        const resB = await clientB.consumeSlidingWindowRateLimit(
          key,
          maxRequests,
          windowMs,
          now + i
        );
        expect(resB.allowed).toBe(true);
        expect(resB.count).toBe(i);
      }

      const blockedOnA = await clientA.consumeSlidingWindowRateLimit(
        key,
        maxRequests,
        windowMs,
        now + 500
      );
      expect(blockedOnA.allowed).toBe(false);
      expect(blockedOnA.count).toBe(maxRequests);
      expect(blockedOnA.retryAfterMs).toBeGreaterThan(0);

      const blockedOnB = await clientB.consumeSlidingWindowRateLimit(
        key,
        maxRequests,
        windowMs,
        now + 600
      );
      expect(blockedOnB.allowed).toBe(false);
      expect(blockedOnB.count).toBe(maxRequests);
      expect(blockedOnB.retryAfterMs).toBeGreaterThan(0);
    } finally {
      await Promise.all([
        clientA.quitForTests().catch(() => clientA.disconnectForTests()),
        clientB ? clientB.quitForTests().catch(() => clientB.disconnectForTests()) : Promise.resolve(),
      ]);
    }
  }, 45_000);

  it('C. maintains strict Lua atomicity under concurrent requests across two independent Redis clients', async () => {
    const clientA = createIoRedisClientForTests(originalRedisUrl);
    let clientB: IoRedisStoreAdapter | null = null;
    extraClients.push(clientA);

    try {
      await clientA.waitUntilReadyForTests(30_000);
      clientB = createIoRedisClientForTests(originalRedisUrl);
      extraClients.push(clientB);
      await clientB.waitUntilReadyForTests(30_000);

      const key = trackKey(`${namespace}scenario_c_concurrent`);
      const maxRequests = MAX_VERIFY_REQUESTS_PER_WINDOW; // 8
      const windowMs = 60_000;
      const now = Date.now();

      const tasks = Array.from({ length: 20 }, (_, idx) => {
        const client = idx % 2 === 0 ? clientA : clientB;
        return client.consumeSlidingWindowRateLimit(
          key,
          maxRequests,
          windowMs,
          now + (idx % 3)
        );
      });

      const results = await Promise.all(tasks);
      const allowed = results.filter((r) => r.allowed);
      const rejected = results.filter((r) => !r.allowed);

      expect(allowed).toHaveLength(maxRequests);
      expect(rejected).toHaveLength(12);
      expect(allowed.map((r) => r.count).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      for (const r of rejected) {
        expect(r.count).toBe(maxRequests);
        expect(r.retryAfterMs).toBeGreaterThan(0);
      }
    } finally {
      await Promise.all([
        clientA.quitForTests().catch(() => clientA.disconnectForTests()),
        clientB ? clientB.quitForTests().catch(() => clientB.disconnectForTests()) : Promise.resolve(),
      ]);
    }
  }, 45_000);

  it('D. expires sliding-window keys after real Redis PEXPIRE TTL and allows requests again', async () => {
    const client = createIoRedisClientForTests(originalRedisUrl);
    extraClients.push(client);
    await client.waitUntilReadyForTests();

    const key = trackKey(`${namespace}scenario_d_ttl`);
    const maxRequests = 2;
    const windowMs = 4_000;

    // Issue two initial requests within window
    const r1 = await client.consumeSlidingWindowRateLimit(key, maxRequests, windowMs, Date.now());
    const r2 = await client.consumeSlidingWindowRateLimit(key, maxRequests, windowMs, Date.now());
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);

    // Must be blocked immediately before 4s window finishes
    const r3 = await client.consumeSlidingWindowRateLimit(key, maxRequests, windowMs, Date.now());
    expect(r3.allowed).toBe(false);
    expect(r3.count).toBe(2);
    expect(r3.retryAfterMs).toBeGreaterThan(0);

    const remainingPttl = await client.pttl(key);
    expect(remainingPttl).toBeGreaterThan(0);

    // Wait past real Redis PEXPIRE expiration
    await new Promise((resolve) => setTimeout(resolve, remainingPttl + 600));

    const expiredPttl = await client.pttl(key);
    expect(expiredPttl).toBe(-2); // Key evicted by Redis

    const afterExpiry = await client.consumeSlidingWindowRateLimit(
      key,
      maxRequests,
      windowMs,
      Date.now()
    );
    expect(afterExpiry.allowed).toBe(true);
    expect(afterExpiry.count).toBe(1);

    await client.quitForTests();
  }, 30_000);

  it('E. fails closed with HTTP 503 AUTH_STORE_UNAVAILABLE on real Redis outage (no memory fallback) and recovers on reconnect', async () => {
    expect(MAX_VERIFY_REQUESTS_PER_WINDOW).toBe(8);
    expect(MAX_RESEND_REQUESTS_PER_WINDOW).toBe(5);
    expect(RATE_LIMIT_WINDOW_MS).toBe(15 * 60 * 1000);

    // 1. Register a real unverified user using live Upstash Redis
    const email = `p2_02_real_redis_${runId}@outside.vip`;
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({
        email,
        password: 'OutsideRealRedis2026!',
        name: 'Real Redis Test User',
      })
      .expect(201);

    const userId = regRes.body.data.user.id as string;
    const token = regRes.body.data.token as string;
    createdUserIds.push(userId);

    const hashedUserId = hashRateLimitIdentifier(userId);
    const verifyRateKey = trackKey(`${SLIDING_WINDOW_RATE_LIMIT_PREFIX}otp_verify:${hashedUserId}`);
    const resendRateKey = trackKey(`${SLIDING_WINDOW_RATE_LIMIT_PREFIX}otp_resend:${hashedUserId}`);
    trackKey(`${USER_SESSIONS_PREFIX}${userId}`);
    trackKey(`${USER_AUTH_CACHE_PREFIX}${userId}`);
    trackKey(`${USER_AUTH_VERSION_PREFIX}${userId}`);

    // Baseline pre-outage verify attempt reaches OTP verification (wrong code -> 400) and stores key in Upstash
    const preOutageVerify = await request(app)
      .post('/api/auth/verify-email')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: '000000' });
    expect(preOutageVerify.status).toBe(400);

    const activeBeforeOutage = getRedisClient();
    expect(activeBeforeOutage).toBeInstanceOf(IoRedisStoreAdapter);
    expect(await activeBeforeOutage.pttl(verifyRateKey)).toBeGreaterThan(0);

    // Move verification code createdAt past 60s resend cooldown so resend hits Redis rate limit
    await prisma.emailVerificationCode.updateMany({
      where: { userId, usedAt: null },
      data: { createdAt: new Date(Date.now() - 65_000) },
    });

    // 2A. Connection drop on the active initialized IoRedisStoreAdapter instance -> fail closed 503
    await (activeBeforeOutage as IoRedisStoreAdapter).disconnectForTests();

    const verifyDuringDrop = await request(app)
      .post('/api/auth/verify-email')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: '000000' });
    expect(verifyDuringDrop.status).toBe(503);
    expect(verifyDuringDrop.body.error.code).toBe('AUTH_STORE_UNAVAILABLE');

    const resendDuringDrop = await request(app)
      .post('/api/auth/resend-verification')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(resendDuringDrop.status).toBe(503);
    expect(resendDuringDrop.body.error.code).toBe('AUTH_STORE_UNAVAILABLE');

    // 2B. Unreachable Redis endpoint outage on fresh IoRedisStoreAdapter initialization -> fail closed 503 (no memory fallback)
    const unusedPort = await getUnusedLocalPort();
    await resetActiveRedisClientForTests();
    process.env.REDIS_URL = `redis://127.0.0.1:${unusedPort}`;

    const verifyUnreachable = await request(app)
      .post('/api/auth/verify-email')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: '000000' });
    expect(verifyUnreachable.status).toBe(503);
    expect(verifyUnreachable.body.error.code).toBe('AUTH_STORE_UNAVAILABLE');

    // 3. Restore real Upstash Redis connectivity and verify full recovery + persisted counter state
    process.env.REDIS_URL = originalRedisUrl;
    const recoveredClient = await initActiveRedisClientForTests(originalRedisUrl);
    expect(recoveredClient).toBeInstanceOf(IoRedisStoreAdapter);
    await recoveredClient.waitUntilReadyForTests(20_000);
    expect(await recoveredClient.ping()).toBe('PONG');

    const postRecoveryVerify = await request(app)
      .post('/api/auth/verify-email')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: '000000' });
    expect(postRecoveryVerify.status).toBe(400);

    // Pre-outage attempt #1 + post-recovery attempt #2 both remain persisted in Upstash Redis (count = 2)
    const verifyCountCheck = await checkRedisSlidingWindowRateLimit(
      `otp_verify:${hashedUserId}`,
      MAX_VERIFY_REQUESTS_PER_WINDOW,
      RATE_LIMIT_WINDOW_MS
    );
    expect(verifyCountCheck.allowed).toBe(true);
    expect(verifyCountCheck.count).toBe(3);

    // Resend also recovers cleanly after connectivity returns
    const postRecoveryResend = await request(app)
      .post('/api/auth/resend-verification')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(postRecoveryResend.status).toBe(200);
    expect(await recoveredClient.pttl(resendRateKey)).toBeGreaterThan(0);

    // Track session key for clean removal in afterAll
    const sessionMatches = await recoveredClient.smembers(`${USER_SESSIONS_PREFIX}${userId}`);
    for (const sid of sessionMatches) {
      trackKey(`${SESSION_PREFIX}${sid}`);
    }
  }, 45_000);
});
