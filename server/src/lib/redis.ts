import crypto from 'crypto';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';

export const SET_USER_CACHE_IF_VERSION_MATCHES_LUA = `
local currentVer = redis.call('GET', KEYS[2]) or '0'
if currentVer ~= ARGV[1] then
  return 0
end
redis.call('SET', KEYS[1], ARGV[2], 'PX', tonumber(ARGV[3]))
return 1
`;

export const INVALIDATE_USER_CACHE_LUA = `
local nextVer = redis.call('INCR', KEYS[2])
redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[1]))
redis.call('DEL', KEYS[1])
return nextVer
`;

export const INCR_WITH_TTL_LUA = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[1]))
end
return count
`;

export const SADD_WITH_TTL_LUA = `
redis.call('SADD', KEYS[1], ARGV[1])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
return 1
`;

export const DEL_LOCK_IF_MATCHES_LUA = `
local current = redis.call('GET', KEYS[1])
if not current then
  return 0
end
if string.find(current, ARGV[1], 1, true) then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
`;

export const COMPLETE_LOCK_IF_MATCHES_LUA = `
local current = redis.call('GET', KEYS[1])
if not current then
  redis.call('SET', KEYS[1], ARGV[2], 'PX', tonumber(ARGV[3]))
  return 1
end
if string.find(current, ARGV[1], 1, true) then
  redis.call('SET', KEYS[1], ARGV[2], 'PX', tonumber(ARGV[3]))
  return 1
else
  return 0
end
`;

export const EXTEND_LOCK_IF_MATCHES_LUA = `
local current = redis.call('GET', KEYS[1])
if not current then
  return 0
end
if string.find(current, ARGV[1], 1, true) then
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
  return 1
else
  return 0
end
`;

export const SET_LOGIN_OTP_RETURNING_PRIOR_LUA = `
local prior = redis.call('GET', KEYS[1])
redis.call('SET', KEYS[1], ARGV[1], 'PX', tonumber(ARGV[2]))
return prior
`;

export const ROLLBACK_LOGIN_OTP_IF_MATCHES_LUA = `
local currentRaw = redis.call('GET', KEYS[1])
if not currentRaw then
  return 'NOOP_MISSING'
end
local okCur, current = pcall(cjson.decode, currentRaw)
if not okCur or type(current) ~= 'table' or current.generationId ~= ARGV[1] then
  return 'NOOP_REPLACED'
end
local priorRaw = ARGV[2]
local nowMs = tonumber(ARGV[3])
local maxAttempts = tonumber(ARGV[4])
if priorRaw and priorRaw ~= '' then
  local okPrior, prior = pcall(cjson.decode, priorRaw)
  if okPrior and type(prior) == 'table' then
    local priorExpiresAt = tonumber(prior.expiresAt) or 0
    local priorAttempts = tonumber(prior.attempts) or 0
    if priorExpiresAt > nowMs and priorAttempts < maxAttempts then
      local remainingTtl = math.floor(math.max(1000, priorExpiresAt - nowMs))
      redis.call('SET', KEYS[1], priorRaw, 'PX', remainingTtl)
      return 'RESTORED_PRIOR'
    end
  end
end
redis.call('DEL', KEYS[1])
return 'DELETED'
`;

export const VERIFY_AND_CONSUME_LOGIN_OTP_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then
  return 'NOT_FOUND'
end
local ok, record = pcall(cjson.decode, raw)
if not ok or type(record) ~= 'table' or type(record.codeHash) ~= 'string' then
  redis.call('DEL', KEYS[1])
  return 'NOT_FOUND'
end
local attempts = tonumber(record.attempts) or 0
local maxAttempts = tonumber(ARGV[3])
if attempts >= maxAttempts then
  return 'MAX_ATTEMPTS'
end
local expiresAt = tonumber(record.expiresAt) or 0
local nowMs = tonumber(ARGV[2])
if expiresAt <= nowMs then
  redis.call('DEL', KEYS[1])
  return 'EXPIRED'
end
local storedHash = record.codeHash
local submittedHash = ARGV[1]
local isMatch = false
if #storedHash == #submittedHash then
  local diff = 0
  for i = 1, #storedHash do
    if string.byte(storedHash, i) ~= string.byte(submittedHash, i) then
      diff = 1
    end
  end
  isMatch = (diff == 0)
end
if isMatch then
  redis.call('DEL', KEYS[1])
  return 'OK:' .. tostring(record.generationId or '')
end
local nextAttempts = attempts + 1
record.attempts = nextAttempts
local remainingTtl = math.floor(math.max(1000, expiresAt - nowMs))
redis.call('SET', KEYS[1], cjson.encode(record), 'PX', remainingTtl)
if nextAttempts >= maxAttempts then
  return 'MAX_ATTEMPTS'
end
return 'INVALID:' .. tostring(nextAttempts)
`;

export const SLIDING_WINDOW_RATE_LIMIT_LUA = `
local key = KEYS[1]
local nowMs = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local maxRequests = tonumber(ARGV[3])
local memberId = ARGV[4]

if not nowMs or not windowMs or not maxRequests or windowMs <= 0 or maxRequests <= 0 then
  return {0, 0, math.max(1, math.floor(windowMs or 1000))}
end

local cutoff = nowMs - windowMs
redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)

local count = tonumber(redis.call('ZCARD', key)) or 0
if count >= maxRequests then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retryAfterMs = windowMs
  if oldest and #oldest >= 2 then
    local oldestScore = tonumber(oldest[2])
    if oldestScore then
      retryAfterMs = math.max(1, math.floor((oldestScore + windowMs) - nowMs))
    end
  end
  return {0, count, retryAfterMs}
end

redis.call('ZADD', key, nowMs, memberId)
redis.call('PEXPIRE', key, math.max(1, math.floor(windowMs)))
return {1, count + 1, 0}
`;

export interface SlidingWindowRateLimitResult {
  allowed: boolean;
  count: number;
  retryAfterMs: number;
}

export type LoginOtpRollbackResult =
  | 'RESTORED_PRIOR'
  | 'DELETED'
  | 'NOOP_MISSING'
  | 'NOOP_REPLACED';

export type LoginOtpVerifyResult =
  | { status: 'OK'; generationId: string }
  | { status: 'NOT_FOUND' }
  | { status: 'EXPIRED' }
  | { status: 'MAX_ATTEMPTS' }
  | { status: 'INVALID'; attempts: number };

function parseLoginOtpVerifyLuaResult(raw: string): LoginOtpVerifyResult {
  if (raw.startsWith('OK:')) {
    return { status: 'OK', generationId: raw.slice(3) };
  }
  if (raw === 'EXPIRED') {
    return { status: 'EXPIRED' };
  }
  if (raw === 'MAX_ATTEMPTS') {
    return { status: 'MAX_ATTEMPTS' };
  }
  if (raw.startsWith('INVALID:')) {
    return { status: 'INVALID', attempts: parseInt(raw.slice(8), 10) || 1 };
  }
  return { status: 'NOT_FOUND' };
}

export interface RedisStoreClient {
  get(key: string): Promise<string | null>;
  setPx(key: string, value: string, ttlMs: number): Promise<void>;
  setNxPx(key: string, value: string, ttlMs: number): Promise<boolean>;
  delLockIfMatches(key: string, lockId: string): Promise<boolean>;
  completeIdempotencyLock(
    key: string,
    lockId: string,
    completedJson: string,
    ttlMs: number
  ): Promise<boolean>;
  extendLockIfMatches(key: string, lockId: string, ttlMs: number): Promise<boolean>;
  setLoginOtpReturningPrior(
    otpKey: string,
    newRecordJson: string,
    ttlMs: number
  ): Promise<string | null>;
  rollbackLoginOtpIfMatches(
    otpKey: string,
    expectedGenerationId: string,
    priorRecordJson: string | null,
    nowMs: number,
    maxAttempts: number
  ): Promise<LoginOtpRollbackResult>;
  verifyAndConsumeLoginOtp(
    otpKey: string,
    submittedHash: string,
    nowMs: number,
    maxAttempts: number
  ): Promise<LoginOtpVerifyResult>;
  del(...keys: string[]): Promise<number>;
  pttl(key: string): Promise<number>;
  pexpire(key: string, ttlMs: number): Promise<number>;
  incrWithTtl(key: string, ttlMs: number): Promise<number>;
  saddWithTtl(key: string, member: string, ttlMs: number): Promise<void>;
  srem(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  setUserCacheIfVersionMatches(
    cacheKey: string,
    versionKey: string,
    expectedVersion: string,
    payloadJson: string,
    ttlMs: number
  ): Promise<boolean>;
  invalidateUserCacheAtomically(
    cacheKey: string,
    versionKey: string,
    versionTtlMs?: number
  ): Promise<number>;
  ping(): Promise<string>;
  consumeSlidingWindowRateLimit(
    key: string,
    maxRequests: number,
    windowMs: number,
    nowMs?: number,
    memberId?: string
  ): Promise<SlidingWindowRateLimitResult>;
  delByPrefixForTests?(prefix: string): Promise<number>;
  flushAllForTests?(): Promise<void>;
}

let simulatedRedisFailure = false;

export function setSimulatedRedisFailure(shouldFail: boolean): void {
  simulatedRedisFailure = shouldFail;
}

export function isSimulatedRedisFailureActive(): boolean {
  return simulatedRedisFailure;
}

function assertRedisAvailable(): void {
  if (simulatedRedisFailure) {
    throw new Error('Redis operation failed: connection unavailable (simulated failure)');
  }
}

class IoRedisStoreAdapter implements RedisStoreClient {
  private client: Redis;

  constructor(redisUrl: string) {
    const isTls = redisUrl.startsWith('rediss://');
    const rejectUnauthorized =
      (process.env.REDIS_TLS_REJECT_UNAUTHORIZED ?? env.REDIS_TLS_REJECT_UNAUTHORIZED) !== 'false';

    this.client = new Redis(redisUrl, {
      maxRetriesPerRequest: 2,
      connectTimeout: 5000,
      commandTimeout: 3000,
      enableReadyCheck: true,
      ...(isTls ? { tls: { rejectUnauthorized } } : {}),
    });

    this.client.on('error', (err) => {
      if ((process.env.NODE_ENV || env.NODE_ENV) !== 'test') {
        console.error('[Redis] Connection error:', err.message);
      }
    });
  }

  async get(key: string): Promise<string | null> {
    assertRedisAvailable();
    return this.client.get(key);
  }

  async setPx(key: string, value: string, ttlMs: number): Promise<void> {
    assertRedisAvailable();
    await this.client.set(key, value, 'PX', Math.max(1, Math.floor(ttlMs)));
  }

  async setNxPx(key: string, value: string, ttlMs: number): Promise<boolean> {
    assertRedisAvailable();
    const res = await this.client.set(
      key,
      value,
      'PX',
      Math.max(1, Math.floor(ttlMs)),
      'NX'
    );
    return res === 'OK';
  }

  async delLockIfMatches(key: string, lockId: string): Promise<boolean> {
    assertRedisAvailable();
    const res = await this.client.eval(DEL_LOCK_IF_MATCHES_LUA, 1, key, lockId);
    return Number(res) === 1;
  }

  async completeIdempotencyLock(
    key: string,
    lockId: string,
    completedJson: string,
    ttlMs: number
  ): Promise<boolean> {
    assertRedisAvailable();
    const res = await this.client.eval(
      COMPLETE_LOCK_IF_MATCHES_LUA,
      1,
      key,
      lockId,
      completedJson,
      Math.max(1, Math.floor(ttlMs)).toString()
    );
    return Number(res) === 1;
  }

  async extendLockIfMatches(key: string, lockId: string, ttlMs: number): Promise<boolean> {
    assertRedisAvailable();
    const res = await this.client.eval(
      EXTEND_LOCK_IF_MATCHES_LUA,
      1,
      key,
      lockId,
      Math.max(1, Math.floor(ttlMs)).toString()
    );
    return Number(res) === 1;
  }

  async setLoginOtpReturningPrior(
    otpKey: string,
    newRecordJson: string,
    ttlMs: number
  ): Promise<string | null> {
    assertRedisAvailable();
    const res = await this.client.eval(
      SET_LOGIN_OTP_RETURNING_PRIOR_LUA,
      1,
      otpKey,
      newRecordJson,
      Math.max(1, Math.floor(ttlMs)).toString()
    );
    return typeof res === 'string' ? res : null;
  }

  async rollbackLoginOtpIfMatches(
    otpKey: string,
    expectedGenerationId: string,
    priorRecordJson: string | null,
    nowMs: number,
    maxAttempts: number
  ): Promise<LoginOtpRollbackResult> {
    assertRedisAvailable();
    const res = await this.client.eval(
      ROLLBACK_LOGIN_OTP_IF_MATCHES_LUA,
      1,
      otpKey,
      expectedGenerationId,
      priorRecordJson ?? '',
      Math.floor(nowMs).toString(),
      Math.floor(maxAttempts).toString()
    );
    const str = String(res);
    if (
      str === 'RESTORED_PRIOR' ||
      str === 'DELETED' ||
      str === 'NOOP_MISSING' ||
      str === 'NOOP_REPLACED'
    ) {
      return str;
    }
    return 'NOOP_REPLACED';
  }

  async verifyAndConsumeLoginOtp(
    otpKey: string,
    submittedHash: string,
    nowMs: number,
    maxAttempts: number
  ): Promise<LoginOtpVerifyResult> {
    assertRedisAvailable();
    const res = await this.client.eval(
      VERIFY_AND_CONSUME_LOGIN_OTP_LUA,
      1,
      otpKey,
      submittedHash,
      Math.floor(nowMs).toString(),
      Math.floor(maxAttempts).toString()
    );
    return parseLoginOtpVerifyLuaResult(String(res));
  }

  async del(...keys: string[]): Promise<number> {
    assertRedisAvailable();
    if (keys.length === 0) return 0;
    return this.client.del(...keys);
  }

  async pttl(key: string): Promise<number> {
    assertRedisAvailable();
    return this.client.pttl(key);
  }

  async pexpire(key: string, ttlMs: number): Promise<number> {
    assertRedisAvailable();
    return this.client.pexpire(key, Math.max(1, Math.floor(ttlMs)));
  }

  async incrWithTtl(key: string, ttlMs: number): Promise<number> {
    assertRedisAvailable();
    const res = await this.client.eval(
      INCR_WITH_TTL_LUA,
      1,
      key,
      Math.max(1, Math.floor(ttlMs)).toString()
    );
    return Number(res);
  }

  async saddWithTtl(key: string, member: string, ttlMs: number): Promise<void> {
    assertRedisAvailable();
    await this.client.eval(
      SADD_WITH_TTL_LUA,
      1,
      key,
      member,
      Math.max(1, Math.floor(ttlMs)).toString()
    );
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    assertRedisAvailable();
    if (members.length === 0) return 0;
    return this.client.srem(key, ...members);
  }

  async smembers(key: string): Promise<string[]> {
    assertRedisAvailable();
    return this.client.smembers(key);
  }

  async setUserCacheIfVersionMatches(
    cacheKey: string,
    versionKey: string,
    expectedVersion: string,
    payloadJson: string,
    ttlMs: number
  ): Promise<boolean> {
    assertRedisAvailable();
    const res = await this.client.eval(
      SET_USER_CACHE_IF_VERSION_MATCHES_LUA,
      2,
      cacheKey,
      versionKey,
      expectedVersion,
      payloadJson,
      Math.max(1, Math.floor(ttlMs)).toString()
    );
    return Number(res) === 1;
  }

  async invalidateUserCacheAtomically(
    cacheKey: string,
    versionKey: string,
    versionTtlMs = 3_600_000
  ): Promise<number> {
    assertRedisAvailable();
    const res = await this.client.eval(
      INVALIDATE_USER_CACHE_LUA,
      2,
      cacheKey,
      versionKey,
      Math.max(1, Math.floor(versionTtlMs)).toString()
    );
    return Number(res);
  }

  async ping(): Promise<string> {
    assertRedisAvailable();
    return this.client.ping();
  }

  async consumeSlidingWindowRateLimit(
    key: string,
    maxRequests: number,
    windowMs: number,
    nowMs = Date.now(),
    memberId?: string
  ): Promise<SlidingWindowRateLimitResult> {
    assertRedisAvailable();
    const effectiveNow = Math.floor(nowMs);
    const effectiveWindow = Math.max(1, Math.floor(windowMs));
    const effectiveMax = Math.max(0, Math.floor(maxRequests));
    const uniqueMember = memberId ?? `${effectiveNow}:${crypto.randomUUID()}`;
    const raw = (await this.client.eval(
      SLIDING_WINDOW_RATE_LIMIT_LUA,
      1,
      key,
      effectiveNow.toString(),
      effectiveWindow.toString(),
      effectiveMax.toString(),
      uniqueMember
    )) as unknown[];
    const allowed = Number(Array.isArray(raw) ? raw[0] : 0) === 1;
    const count = Number(Array.isArray(raw) ? raw[1] : 0) || 0;
    const retryAfterMs = Number(Array.isArray(raw) ? raw[2] : 0) || 0;
    return { allowed, count, retryAfterMs };
  }

  async delByPrefixForTests(prefix: string): Promise<number> {
    if ((process.env.NODE_ENV || env.NODE_ENV) === 'production') {
      throw new Error('delByPrefixForTests is not permitted in production');
    }
    assertRedisAvailable();
    let cursor = '0';
    let deleted = 0;
    do {
      const [nextCursor, keys] = await this.client.scan(
        cursor,
        'MATCH',
        `${prefix}*`,
        'COUNT',
        100
      );
      cursor = nextCursor;
      if (keys.length > 0) {
        deleted += await this.client.del(...keys);
      }
    } while (cursor !== '0');
    return deleted;
  }
}

interface MemoryZSetEntry {
  entries: Map<string, number>;
  expiresAt: number | null;
}

interface MemoryEntry {
  value: string;
  expiresAt: number | null;
}

interface MemorySetEntry {
  members: Set<string>;
  expiresAt: number | null;
}

/**
 * Atomic in-process Redis-compatible adapter used strictly in test/local dev
 * when an external REDIS_URL is not configured. Implements exact millisecond TTLs,
 * sets, and atomic version-guarded Lua script semantics.
 */
class AtomicMemoryRedisAdapter implements RedisStoreClient {
  private kv = new Map<string, MemoryEntry>();
  private sets = new Map<string, MemorySetEntry>();
  private zsets = new Map<string, MemoryZSetEntry>();

  private isExpired(expiresAt: number | null, referenceNowMs = Date.now()): boolean {
    return expiresAt !== null && referenceNowMs >= expiresAt;
  }

  private getValidStringEntry(key: string): MemoryEntry | null {
    const entry = this.kv.get(key);
    if (!entry) return null;
    if (this.isExpired(entry.expiresAt)) {
      this.kv.delete(key);
      return null;
    }
    return entry;
  }

  private getValidSetEntry(key: string): MemorySetEntry | null {
    const entry = this.sets.get(key);
    if (!entry) return null;
    if (this.isExpired(entry.expiresAt)) {
      this.sets.delete(key);
      return null;
    }
    return entry;
  }

  private getValidZSetEntry(key: string, referenceNowMs = Date.now()): MemoryZSetEntry | null {
    const entry = this.zsets.get(key);
    if (!entry) return null;
    if (this.isExpired(entry.expiresAt, referenceNowMs)) {
      this.zsets.delete(key);
      return null;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    assertRedisAvailable();
    const entry = this.getValidStringEntry(key);
    return entry ? entry.value : null;
  }

  async setPx(key: string, value: string, ttlMs: number): Promise<void> {
    assertRedisAvailable();
    this.kv.set(key, {
      value,
      expiresAt: Date.now() + Math.max(1, Math.floor(ttlMs)),
    });
  }

  async setNxPx(key: string, value: string, ttlMs: number): Promise<boolean> {
    assertRedisAvailable();
    const existing = this.getValidStringEntry(key);
    if (existing) {
      return false;
    }
    this.kv.set(key, {
      value,
      expiresAt: Date.now() + Math.max(1, Math.floor(ttlMs)),
    });
    return true;
  }

  async delLockIfMatches(key: string, lockId: string): Promise<boolean> {
    assertRedisAvailable();
    const entry = this.getValidStringEntry(key);
    if (!entry) return false;
    if (entry.value.includes(lockId)) {
      this.kv.delete(key);
      return true;
    }
    return false;
  }

  async completeIdempotencyLock(
    key: string,
    lockId: string,
    completedJson: string,
    ttlMs: number
  ): Promise<boolean> {
    assertRedisAvailable();
    const entry = this.getValidStringEntry(key);
    if (!entry || entry.value.includes(lockId)) {
      this.kv.set(key, {
        value: completedJson,
        expiresAt: Date.now() + Math.max(1, Math.floor(ttlMs)),
      });
      return true;
    }
    return false;
  }

  async extendLockIfMatches(key: string, lockId: string, ttlMs: number): Promise<boolean> {
    assertRedisAvailable();
    const entry = this.getValidStringEntry(key);
    if (entry && entry.value.includes(lockId)) {
      this.kv.set(key, {
        value: entry.value,
        expiresAt: Date.now() + Math.max(1, Math.floor(ttlMs)),
      });
      return true;
    }
    return false;
  }

  async setLoginOtpReturningPrior(
    otpKey: string,
    newRecordJson: string,
    ttlMs: number
  ): Promise<string | null> {
    assertRedisAvailable();
    const existing = this.getValidStringEntry(otpKey);
    const prior = existing ? existing.value : null;
    this.kv.set(otpKey, {
      value: newRecordJson,
      expiresAt: Date.now() + Math.max(1, Math.floor(ttlMs)),
    });
    return prior;
  }

  async rollbackLoginOtpIfMatches(
    otpKey: string,
    expectedGenerationId: string,
    priorRecordJson: string | null,
    nowMs: number,
    maxAttempts: number
  ): Promise<LoginOtpRollbackResult> {
    assertRedisAvailable();
    const currentEntry = this.getValidStringEntry(otpKey);
    if (!currentEntry) {
      return 'NOOP_MISSING';
    }
    let current: any;
    try {
      current = JSON.parse(currentEntry.value);
    } catch {
      return 'NOOP_REPLACED';
    }
    if (!current || typeof current !== 'object' || current.generationId !== expectedGenerationId) {
      return 'NOOP_REPLACED';
    }
    if (priorRecordJson) {
      try {
        const prior = JSON.parse(priorRecordJson);
        const priorExpiresAt = Number(prior?.expiresAt) || 0;
        const priorAttempts = Number(prior?.attempts) || 0;
        if (prior && typeof prior === 'object' && priorExpiresAt > nowMs && priorAttempts < maxAttempts) {
          const remainingTtl = Math.max(1_000, priorExpiresAt - nowMs);
          this.kv.set(otpKey, {
            value: priorRecordJson,
            expiresAt: Date.now() + remainingTtl,
          });
          return 'RESTORED_PRIOR';
        }
      } catch {
        // Malformed prior record: fall through to delete
      }
    }
    this.kv.delete(otpKey);
    return 'DELETED';
  }

  async verifyAndConsumeLoginOtp(
    otpKey: string,
    submittedHash: string,
    nowMs: number,
    maxAttempts: number
  ): Promise<LoginOtpVerifyResult> {
    assertRedisAvailable();
    const entry = this.getValidStringEntry(otpKey);
    if (!entry) {
      return { status: 'NOT_FOUND' };
    }
    let record: any;
    try {
      record = JSON.parse(entry.value);
    } catch {
      this.kv.delete(otpKey);
      return { status: 'NOT_FOUND' };
    }
    if (!record || typeof record !== 'object' || typeof record.codeHash !== 'string') {
      this.kv.delete(otpKey);
      return { status: 'NOT_FOUND' };
    }
    const attempts = Number(record.attempts) || 0;
    if (attempts >= maxAttempts) {
      return { status: 'MAX_ATTEMPTS' };
    }
    const expiresAt = Number(record.expiresAt) || 0;
    if (expiresAt <= nowMs) {
      this.kv.delete(otpKey);
      return { status: 'EXPIRED' };
    }
    const storedBuf = Buffer.from(record.codeHash, 'utf8');
    const submittedBuf = Buffer.from(submittedHash, 'utf8');
    const isMatch =
      storedBuf.length === submittedBuf.length && crypto.timingSafeEqual(storedBuf, submittedBuf);
    if (isMatch) {
      this.kv.delete(otpKey);
      return { status: 'OK', generationId: String(record.generationId || '') };
    }
    const nextAttempts = attempts + 1;
    record.attempts = nextAttempts;
    const remainingTtl = Math.max(1_000, expiresAt - nowMs);
    this.kv.set(otpKey, {
      value: JSON.stringify(record),
      expiresAt: Date.now() + remainingTtl,
    });
    if (nextAttempts >= maxAttempts) {
      return { status: 'MAX_ATTEMPTS' };
    }
    return { status: 'INVALID', attempts: nextAttempts };
  }

  async del(...keys: string[]): Promise<number> {
    assertRedisAvailable();
    let count = 0;
    for (const k of keys) {
      if (this.kv.delete(k)) count++;
      if (this.sets.delete(k)) count++;
      if (this.zsets.delete(k)) count++;
    }
    return count;
  }

  async pttl(key: string): Promise<number> {
    assertRedisAvailable();
    const strEntry = this.getValidStringEntry(key);
    if (strEntry) {
      return strEntry.expiresAt === null ? -1 : Math.max(0, strEntry.expiresAt - Date.now());
    }
    const setEntry = this.getValidSetEntry(key);
    if (setEntry) {
      return setEntry.expiresAt === null ? -1 : Math.max(0, setEntry.expiresAt - Date.now());
    }
    const zsetEntry = this.getValidZSetEntry(key);
    if (zsetEntry) {
      return zsetEntry.expiresAt === null ? -1 : Math.max(0, zsetEntry.expiresAt - Date.now());
    }
    return -2;
  }

  async pexpire(key: string, ttlMs: number): Promise<number> {
    assertRedisAvailable();
    const nextExpiresAt = Date.now() + Math.max(1, Math.floor(ttlMs));
    const strEntry = this.getValidStringEntry(key);
    if (strEntry) {
      strEntry.expiresAt = nextExpiresAt;
      return 1;
    }
    const setEntry = this.getValidSetEntry(key);
    if (setEntry) {
      setEntry.expiresAt = nextExpiresAt;
      return 1;
    }
    const zsetEntry = this.getValidZSetEntry(key);
    if (zsetEntry) {
      zsetEntry.expiresAt = nextExpiresAt;
      return 1;
    }
    return 0;
  }

  async incrWithTtl(key: string, ttlMs: number): Promise<number> {
    assertRedisAvailable();
    const existing = this.getValidStringEntry(key);
    if (!existing) {
      this.kv.set(key, {
        value: '1',
        expiresAt: Date.now() + Math.max(1, Math.floor(ttlMs)),
      });
      return 1;
    }
    const nextVal = (parseInt(existing.value, 10) || 0) + 1;
    existing.value = String(nextVal);
    return nextVal;
  }

  async saddWithTtl(key: string, member: string, ttlMs: number): Promise<void> {
    assertRedisAvailable();
    const expiresAt = Date.now() + Math.max(1, Math.floor(ttlMs));
    const existing = this.getValidSetEntry(key);
    if (!existing) {
      this.sets.set(key, {
        members: new Set([member]),
        expiresAt,
      });
      return;
    }
    existing.members.add(member);
    existing.expiresAt = expiresAt;
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    assertRedisAvailable();
    const existing = this.getValidSetEntry(key);
    if (!existing) return 0;
    let removed = 0;
    for (const m of members) {
      if (existing.members.delete(m)) removed++;
    }
    if (existing.members.size === 0) {
      this.sets.delete(key);
    }
    return removed;
  }

  async smembers(key: string): Promise<string[]> {
    assertRedisAvailable();
    const existing = this.getValidSetEntry(key);
    if (!existing) return [];
    return Array.from(existing.members);
  }

  async setUserCacheIfVersionMatches(
    cacheKey: string,
    versionKey: string,
    expectedVersion: string,
    payloadJson: string,
    ttlMs: number
  ): Promise<boolean> {
    assertRedisAvailable();
    const currentVerEntry = this.getValidStringEntry(versionKey);
    const currentVer = currentVerEntry ? currentVerEntry.value : '0';
    if (currentVer !== expectedVersion) {
      return false;
    }
    this.kv.set(cacheKey, {
      value: payloadJson,
      expiresAt: Date.now() + Math.max(1, Math.floor(ttlMs)),
    });
    return true;
  }

  async invalidateUserCacheAtomically(
    cacheKey: string,
    versionKey: string,
    versionTtlMs = 3_600_000
  ): Promise<number> {
    assertRedisAvailable();
    const existingVer = this.getValidStringEntry(versionKey);
    const nextVer = (existingVer ? parseInt(existingVer.value, 10) || 0 : 0) + 1;
    this.kv.set(versionKey, {
      value: String(nextVer),
      expiresAt: Date.now() + Math.max(1, Math.floor(versionTtlMs)),
    });
    this.kv.delete(cacheKey);
    return nextVer;
  }

  async ping(): Promise<string> {
    assertRedisAvailable();
    return 'PONG';
  }

  async consumeSlidingWindowRateLimit(
    key: string,
    maxRequests: number,
    windowMs: number,
    nowMs = Date.now(),
    memberId?: string
  ): Promise<SlidingWindowRateLimitResult> {
    assertRedisAvailable();
    if (!Number.isFinite(nowMs) || !Number.isFinite(windowMs) || !Number.isFinite(maxRequests) || windowMs <= 0 || maxRequests <= 0) {
      return {
        allowed: false,
        count: 0,
        retryAfterMs: Math.max(1, Math.floor(windowMs || 1000)),
      };
    }

    const effectiveNow = Math.floor(nowMs);
    const effectiveWindow = Math.max(1, Math.floor(windowMs));
    const effectiveMax = Math.floor(maxRequests);
    const cutoff = effectiveNow - effectiveWindow;

    let entry = this.getValidZSetEntry(key, effectiveNow);
    if (entry) {
      for (const [m, score] of entry.entries.entries()) {
        if (score <= cutoff) {
          entry.entries.delete(m);
        }
      }
      if (entry.entries.size === 0) {
        this.zsets.delete(key);
        entry = null;
      }
    }

    const count = entry ? entry.entries.size : 0;
    if (count >= effectiveMax && entry) {
      let oldestScore: number | null = null;
      for (const score of entry.entries.values()) {
        if (oldestScore === null || score < oldestScore) {
          oldestScore = score;
        }
      }
      const retryAfterMs =
        oldestScore !== null
          ? Math.max(1, Math.floor(oldestScore + effectiveWindow - effectiveNow))
          : effectiveWindow;
      return { allowed: false, count, retryAfterMs };
    }

    const activeEntry: MemoryZSetEntry = entry ?? {
      entries: new Map<string, number>(),
      expiresAt: effectiveNow + effectiveWindow,
    };
    const uniqueMember = memberId ?? `${effectiveNow}:${crypto.randomUUID()}`;
    activeEntry.entries.set(uniqueMember, effectiveNow);
    activeEntry.expiresAt = effectiveNow + effectiveWindow;
    this.zsets.set(key, activeEntry);

    return {
      allowed: true,
      count: activeEntry.entries.size,
      retryAfterMs: 0,
    };
  }

  async delByPrefixForTests(prefix: string): Promise<number> {
    if ((process.env.NODE_ENV || env.NODE_ENV) === 'production') {
      throw new Error('delByPrefixForTests is not permitted in production');
    }
    let deleted = 0;
    for (const k of Array.from(this.kv.keys())) {
      if (k.startsWith(prefix) && this.kv.delete(k)) deleted++;
    }
    for (const k of Array.from(this.sets.keys())) {
      if (k.startsWith(prefix) && this.sets.delete(k)) deleted++;
    }
    for (const k of Array.from(this.zsets.keys())) {
      if (k.startsWith(prefix) && this.zsets.delete(k)) deleted++;
    }
    return deleted;
  }

  async flushAllForTests(): Promise<void> {
    this.kv.clear();
    this.sets.clear();
    this.zsets.clear();
  }
}

let activeClient: RedisStoreClient | null = null;
const memoryFallbackClient = new AtomicMemoryRedisAdapter();

export function getRedisClient(): RedisStoreClient {
  const configuredUrl = (process.env.REDIS_URL ?? env.REDIS_URL ?? '').trim();
  const nodeEnv = process.env.NODE_ENV || env.NODE_ENV;

  if (configuredUrl) {
    if (!activeClient || activeClient === memoryFallbackClient) {
      activeClient = new IoRedisStoreAdapter(configuredUrl);
    }
    return activeClient;
  }

  if (nodeEnv === 'production' && process.env.ALLOW_MEMORY_REDIS_IN_TEST !== 'true') {
    throw new Error(
      'REDIS_URL is required in production. Server-side session validation cannot run without Managed Redis.'
    );
  }

  return memoryFallbackClient;
}

