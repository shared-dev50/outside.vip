import crypto from 'crypto';
import { Request, Response } from 'express';
import { Role, AccountStatus } from '@prisma/client';
import { env } from '../config/env.js';
import { getRedisClient } from './redis.js';
import { ServiceUnavailableError } from '../utils/errors.js';

export const SESSION_COOKIE_NAME = '__Host-outside_sid';
export const SESSION_PREFIX = 'sess:';
export const USER_SESSIONS_PREFIX = 'user_sessions:';
export const USER_AUTH_CACHE_PREFIX = 'user_auth_cache:';
export const USER_AUTH_VERSION_PREFIX = 'user_auth_ver:';

export interface StoredSessionRecord {
  sessionId: string;
  userId: string;
  verifierHash: string;
  csrfToken: string;
  createdAt: number;
  lastActiveAt: number;
  absoluteExpiresAt: number;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface IssuedSession {
  sessionId: string;
  rawCookieValue: string;
  csrfToken: string;
  record: StoredSessionRecord;
}

/**
 * Contains ONLY the minimum required authorization fields cached in Redis (30s TTL).
 */
export interface CachedUserAuthRecord {
  userId: string;
  role: Role;
  emailVerified: boolean;
  accountStatus: AccountStatus;
}

export function getSessionIdleTimeoutMs(): number {
  const raw = process.env.SESSION_IDLE_TIMEOUT_MS;
  if (raw !== undefined) {
    const parsed = parseInt(raw, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return env.SESSION_IDLE_TIMEOUT_MS || 1_800_000;
}

export function getSessionAbsoluteTimeoutMs(): number {
  const raw = process.env.SESSION_ABSOLUTE_TIMEOUT_MS;
  if (raw !== undefined) {
    const parsed = parseInt(raw, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return env.SESSION_ABSOLUTE_TIMEOUT_MS || 604_800_000;
}

export function getUserAuthCacheTtlMs(): number {
  const raw = process.env.USER_AUTH_CACHE_TTL_MS;
  if (raw !== undefined) {
    const parsed = parseInt(raw, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return env.USER_AUTH_CACHE_TTL_MS || 30_000;
}

export function computeSessionVerifierHash(sessionSecret: string): string {
  return crypto.createHash('sha256').update(sessionSecret, 'utf8').digest('hex');
}

export function timingSafeHexEquals(aHex: string, bHex: string): boolean {
  const aBuf = Buffer.from(aHex, 'utf8');
  const bBuf = Buffer.from(bHex, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function wrapRedisError(err: unknown): never {
  if (err instanceof ServiceUnavailableError) {
    throw err;
  }
  const message = err instanceof Error ? err.message : 'Unknown Redis error';
  throw new ServiceUnavailableError(
    `Authentication session store is temporarily unavailable (${message}).`,
    'AUTH_STORE_UNAVAILABLE'
  );
}

/**
 * Generates a cryptographically random session with 128-bit sessionId,
 * 256-bit sessionSecret (stored only as a SHA-256 verifier in Redis), and 256-bit csrfToken.
 */
export async function createSession(params: {
  userId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  preserveCreatedAt?: number;
  preserveAbsoluteExpiresAt?: number;
}): Promise<IssuedSession> {
  try {
    const redis = getRedisClient();
    const now = Date.now();
    const idleTimeoutMs = getSessionIdleTimeoutMs();
    const absoluteTimeoutMs = getSessionAbsoluteTimeoutMs();

    // 128 bits of entropy for sessionId, 256 bits for sessionSecret, 256 bits for csrfToken
    const sessionId = crypto.randomBytes(16).toString('base64url');
    const sessionSecret = crypto.randomBytes(32).toString('base64url');
    const csrfToken = crypto.randomBytes(32).toString('base64url');
    const verifierHash = computeSessionVerifierHash(sessionSecret);

    const createdAt = params.preserveCreatedAt ?? now;
    const absoluteExpiresAt = params.preserveAbsoluteExpiresAt ?? createdAt + absoluteTimeoutMs;
    const effectiveTtlMs = Math.max(1, Math.min(idleTimeoutMs, absoluteExpiresAt - now));

    const record: StoredSessionRecord = {
      sessionId,
      userId: params.userId,
      verifierHash,
      csrfToken,
      createdAt,
      lastActiveAt: now,
      absoluteExpiresAt,
      ipAddress: params.ipAddress ?? null,
      userAgent: params.userAgent ?? null,
    };

    const sessionKey = `${SESSION_PREFIX}${sessionId}`;
    const userSessionsKey = `${USER_SESSIONS_PREFIX}${params.userId}`;

    await redis.setPx(sessionKey, JSON.stringify(record), effectiveTtlMs);
    await redis.saddWithTtl(
      userSessionsKey,
      sessionId,
      Math.max(1, absoluteExpiresAt - now)
    );

    return {
      sessionId,
      rawCookieValue: `${sessionId}.${sessionSecret}`,
      csrfToken,
      record,
    };
  } catch (err) {
    wrapRedisError(err);
  }
}

/**
 * Validates `<sessionId>.<sessionSecret>` against Redis on every authenticated request.
 * Enforces the 30-minute idle timeout and 7-day absolute lifetime, and refreshes lastActiveAt.
 * Fails closed (throws 503 ServiceUnavailableError) if Redis is unreachable.
 */
export async function validateAndTouchSession(
  rawCookieValue: string
): Promise<StoredSessionRecord | null> {
  if (!rawCookieValue || typeof rawCookieValue !== 'string') {
    return null;
  }

  const dotIndex = rawCookieValue.indexOf('.');
  if (dotIndex <= 0 || dotIndex === rawCookieValue.length - 1) {
    return null;
  }

  const sessionId = rawCookieValue.slice(0, dotIndex).trim();
  const sessionSecret = rawCookieValue.slice(dotIndex + 1).trim();
  if (!sessionId || !sessionSecret) {
    return null;
  }

  try {
    const redis = getRedisClient();
    const sessionKey = `${SESSION_PREFIX}${sessionId}`;
    const rawJson = await redis.get(sessionKey);
    if (!rawJson) {
      return null;
    }

    let record: StoredSessionRecord;
    try {
      record = JSON.parse(rawJson) as StoredSessionRecord;
    } catch {
      await redis.del(sessionKey);
      return null;
    }

    const incomingHash = computeSessionVerifierHash(sessionSecret);
    if (!timingSafeHexEquals(incomingHash, record.verifierHash)) {
      return null;
    }

    const now = Date.now();
    const idleTimeoutMs = getSessionIdleTimeoutMs();

    // Enforce 7-day absolute lifetime and 30-minute idle timeout
    if (
      now >= record.absoluteExpiresAt ||
      now - record.lastActiveAt > idleTimeoutMs
    ) {
      await redis.del(sessionKey);
      await redis.srem(`${USER_SESSIONS_PREFIX}${record.userId}`, sessionId);
      return null;
    }

    // Sliding idle timeout renewal capped by absoluteExpiresAt
    record.lastActiveAt = now;
    const remainingAbsoluteMs = record.absoluteExpiresAt - now;
    const nextTtlMs = Math.max(1, Math.min(idleTimeoutMs, remainingAbsoluteMs));
    await redis.setPx(sessionKey, JSON.stringify(record), nextTtlMs);

    return record;
  } catch (err) {
    wrapRedisError(err);
  }
}

/**
 * Rotates a session identifier after login or privilege/verification changes.
 * Destroys the old session ID immediately and issues a new sessionId + sessionSecret + csrfToken.
 */
export async function rotateSession(params: {
  oldSessionId?: string | null;
  userId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  preserveLifetime?: boolean;
}): Promise<IssuedSession> {
  try {
    const redis = getRedisClient();
    let preserveCreatedAt: number | undefined;
    let preserveAbsoluteExpiresAt: number | undefined;

    if (params.oldSessionId) {
      const oldKey = `${SESSION_PREFIX}${params.oldSessionId}`;
      const existingRaw = await redis.get(oldKey);
      if (existingRaw) {
        try {
          const parsed = JSON.parse(existingRaw) as StoredSessionRecord;
          if (params.preserveLifetime && parsed.userId === params.userId) {
            preserveCreatedAt = parsed.createdAt;
            preserveAbsoluteExpiresAt = parsed.absoluteExpiresAt;
          }
          await redis.srem(`${USER_SESSIONS_PREFIX}${parsed.userId}`, params.oldSessionId);
        } catch {
          // Ignore malformed record
        }
      }
      await redis.del(oldKey);
      await redis.setPx(`rotated_sess_user:${params.oldSessionId}`, params.userId, 60_000);
    }

    return await createSession({
      userId: params.userId,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
      preserveCreatedAt,
      preserveAbsoluteExpiresAt,
    });
  } catch (err) {
    wrapRedisError(err);
  }
}

export async function revokeSession(sessionId: string, userId?: string): Promise<boolean> {
  try {
    const redis = getRedisClient();
    const sessionKey = `${SESSION_PREFIX}${sessionId}`;
    let ownerId = userId;

    if (!ownerId) {
      const raw = await redis.get(sessionKey);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as StoredSessionRecord;
          ownerId = parsed.userId;
        } catch {
          // Ignore
        }
      }
    }

    const deleted = await redis.del(sessionKey);
    if (ownerId) {
      await redis.srem(`${USER_SESSIONS_PREFIX}${ownerId}`, sessionId);
    }
    return deleted > 0;
  } catch (err) {
    wrapRedisError(err);
  }
}

export async function revokeAllUserSessions(
  userId: string,
  exceptSessionId?: string
): Promise<number> {
  try {
    const redis = getRedisClient();
    const userSessionsKey = `${USER_SESSIONS_PREFIX}${userId}`;
    const sessionIds = await redis.smembers(userSessionsKey);

    const toDelete = sessionIds.filter((sid) => sid !== exceptSessionId);
    if (toDelete.length > 0) {
      await redis.del(...toDelete.map((sid) => `${SESSION_PREFIX}${sid}`));
      await redis.srem(userSessionsKey, ...toDelete);
    }

    if (!exceptSessionId) {
      await redis.del(userSessionsKey);
    }

    return toDelete.length;
  } catch (err) {
    wrapRedisError(err);
  }
}

export async function listUserSessions(userId: string): Promise<
  Array<{
    sessionId: string;
    createdAt: number;
    lastActiveAt: number;
    absoluteExpiresAt: number;
    ipAddress: string | null;
    userAgent: string | null;
  }>
> {
  try {
    const redis = getRedisClient();
    const userSessionsKey = `${USER_SESSIONS_PREFIX}${userId}`;
    const sessionIds = await redis.smembers(userSessionsKey);
    const active: Array<{
      sessionId: string;
      createdAt: number;
      lastActiveAt: number;
      absoluteExpiresAt: number;
      ipAddress: string | null;
      userAgent: string | null;
    }> = [];
    const staleIds: string[] = [];

    for (const sid of sessionIds) {
      const raw = await redis.get(`${SESSION_PREFIX}${sid}`);
      if (!raw) {
        staleIds.push(sid);
        continue;
      }
      try {
        const parsed = JSON.parse(raw) as StoredSessionRecord;
        active.push({
          sessionId: parsed.sessionId,
          createdAt: parsed.createdAt,
          lastActiveAt: parsed.lastActiveAt,
          absoluteExpiresAt: parsed.absoluteExpiresAt,
          ipAddress: parsed.ipAddress,
          userAgent: parsed.userAgent,
        });
      } catch {
        staleIds.push(sid);
      }
    }

    if (staleIds.length > 0) {
      await redis.srem(userSessionsKey, ...staleIds);
    }

    return active.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  } catch (err) {
    wrapRedisError(err);
  }
}

export async function getCachedUserAuth(userId: string): Promise<CachedUserAuthRecord | null> {
  try {
    const redis = getRedisClient();
    const raw = await redis.get(`${USER_AUTH_CACHE_PREFIX}${userId}`);
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw);
      if (
        !parsed ||
        typeof parsed.userId !== 'string' ||
        typeof parsed.role !== 'string' ||
        typeof parsed.emailVerified !== 'boolean' ||
        typeof parsed.accountStatus !== 'string'
      ) {
        await redis.del(`${USER_AUTH_CACHE_PREFIX}${userId}`);
        return null;
      }
      return {
        userId: parsed.userId,
        role: parsed.role as Role,
        emailVerified: parsed.emailVerified,
        accountStatus: parsed.accountStatus as AccountStatus,
      };
    } catch {
      await redis.del(`${USER_AUTH_CACHE_PREFIX}${userId}`);
      return null;
    }
  } catch (err) {
    wrapRedisError(err);
  }
}

export async function getUserAuthCacheVersion(userId: string): Promise<string> {
  try {
    const redis = getRedisClient();
    const ver = await redis.get(`${USER_AUTH_VERSION_PREFIX}${userId}`);
    return ver ?? '0';
  } catch (err) {
    wrapRedisError(err);
  }
}

/**
 * Atomically populates `user_auth_cache:<userId>` (30s TTL) with ONLY
 * `{ userId, role, emailVerified, accountStatus }` if and only if
 * `user_auth_ver:<userId>` still matches `expectedVersion`.
 */
export async function populateUserAuthCacheAtomically(
  record: CachedUserAuthRecord,
  expectedVersion: string
): Promise<boolean> {
  try {
    const redis = getRedisClient();
    const minimalPayload: CachedUserAuthRecord = {
      userId: record.userId,
      role: record.role,
      emailVerified: record.emailVerified,
      accountStatus: record.accountStatus,
    };

    return await redis.setUserCacheIfVersionMatches(
      `${USER_AUTH_CACHE_PREFIX}${record.userId}`,
      `${USER_AUTH_VERSION_PREFIX}${record.userId}`,
      expectedVersion,
      JSON.stringify(minimalPayload),
      getUserAuthCacheTtlMs()
    );
  } catch (err) {
    wrapRedisError(err);
  }
}

/**
 * Immediately invalidates `user_auth_cache:<userId>` and atomically increments
 * `user_auth_ver:<userId>` so any in-flight DB read cannot repopulate stale data.
 */
export async function invalidateUserAuthCache(userId: string): Promise<number> {
  try {
    const redis = getRedisClient();
    return await redis.invalidateUserCacheAtomically(
      `${USER_AUTH_CACHE_PREFIX}${userId}`,
      `${USER_AUTH_VERSION_PREFIX}${userId}`
    );
  } catch (err) {
    wrapRedisError(err);
  }
}

/**
 * Resolves a user's authorization record using the 30s Redis User Cache for ordinary
 * requests, or forces a fresh PostgreSQL lookup when `forceFreshDb` is true.
 */
export async function resolveUserAuthWithCache(
  userId: string,
  dbLoader: (id: string) => Promise<CachedUserAuthRecord | null>,
  options?: {
    forceFreshDb?: boolean;
    onBeforeCacheWrite?: () => Promise<void>;
  }
): Promise<{ user: CachedUserAuthRecord | null; fromCache: boolean }> {
  if (!options?.forceFreshDb) {
    const cached = await getCachedUserAuth(userId);
    if (cached) {
      return { user: cached, fromCache: true };
    }
  }

  const versionBeforeDb = await getUserAuthCacheVersion(userId);
  const freshUser = await dbLoader(userId);

  if (!freshUser) {
    await invalidateUserAuthCache(userId);
    return { user: null, fromCache: false };
  }

  if (options?.onBeforeCacheWrite) {
    await options.onBeforeCacheWrite();
  }

  // Only cache ACTIVE accounts or cache exact status with atomic version check
  await populateUserAuthCacheAtomically(freshUser, versionBeforeDb);
  return { user: freshUser, fromCache: false };
}

/**
 * Sets the host-only `__Host-outside_sid` cookie:
 * HttpOnly, Secure, SameSite=Lax, Path=/, NO Domain attribute.
 */
export function setSessionCookie(res: Response, rawCookieValue: string): void {
  const maxAgeSeconds = Math.floor(getSessionAbsoluteTimeoutMs() / 1000);
  const cookieHeader = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(rawCookieValue)}`,
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');

  res.append('Set-Cookie', cookieHeader);
}

/**
 * Clears `__Host-outside_sid` immediately.
 */
export function clearSessionCookie(res: Response): void {
  const cookieHeader = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');

  res.append('Set-Cookie', cookieHeader);
}

export function extractSessionCookie(req: Request): string | null {
  if (req.cookies && typeof req.cookies[SESSION_COOKIE_NAME] === 'string') {
    const val = req.cookies[SESSION_COOKIE_NAME].trim();
    return val ? decodeURIComponent(val) : null;
  }

  const rawCookieHeader = req.headers.cookie;
  if (!rawCookieHeader) return null;

  const pairs = rawCookieHeader.split(';');
  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    const name = pair.slice(0, eqIdx).trim();
    if (name === SESSION_COOKIE_NAME) {
      const value = pair.slice(eqIdx + 1).trim();
      return value ? decodeURIComponent(value) : null;
    }
  }
  return null;
}

/**
 * Used exclusively by `POST /api/auth/verify-email` when a client retries
 * submitting an OTP code with a session token that was just rotated moments earlier,
 * allowing `verifyEmail` to return `400 VERIFICATION_CODE_USED` rather than `401`.
 */
export async function resolveRotatedSessionUserId(req: Request): Promise<string | null> {
  const rawToken =
    extractSessionCookie(req) ||
    (req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7).trim()
      : null);

  if (!rawToken) return null;
  const dotIdx = rawToken.indexOf('.');
  if (dotIdx <= 0) return null;
  const sessionId = rawToken.slice(0, dotIdx).trim();
  if (!sessionId) return null;

  try {
    const redis = getRedisClient();
    return await redis.get(`rotated_sess_user:${sessionId}`);
  } catch {
    return null;
  }
}

export async function checkRedisRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number
): Promise<boolean> {
  try {
    const redis = getRedisClient();
    const count = await redis.incrWithTtl(`ratelimit:${key}`, windowMs);
    return count <= maxRequests;
  } catch (err) {
    wrapRedisError(err);
  }
}
