import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { TooManyRequestsError } from '../../utils/errors.js';

interface RateLimitRecord {
  failedAttempts: number;
  lockedUntil?: number;
}

// In-memory rate limiting per slug:ip
const attemptsMap = new Map<string, RateLimitRecord>();

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

export interface EventAccessTokenPayload {
  eventId: string;
  scope: 'event_access';
  pwdSig?: string;
  iat?: number;
  exp?: number;
}

export function checkPasswordRateLimit(key: string): void {
  const record = attemptsMap.get(key);
  if (!record) return;

  const now = Date.now();
  if (record.lockedUntil) {
    if (now < record.lockedUntil) {
      const remainingMinutes = Math.ceil((record.lockedUntil - now) / 60000);
      throw new TooManyRequestsError(
        `Too many incorrect password attempts. Please try again in ${remainingMinutes} minute(s).`
      );
    } else {
      attemptsMap.delete(key);
    }
  }
}

export function recordFailedPasswordAttempt(key: string): number {
  const record = attemptsMap.get(key) || { failedAttempts: 0 };
  record.failedAttempts += 1;

  if (record.failedAttempts >= MAX_FAILED_ATTEMPTS) {
    record.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
    attemptsMap.set(key, record);
    throw new TooManyRequestsError(
      'Too many incorrect password attempts. Access is locked for 15 minutes.'
    );
  }

  attemptsMap.set(key, record);
  return MAX_FAILED_ATTEMPTS - record.failedAttempts;
}

export function clearPasswordRateLimit(key: string): void {
  attemptsMap.delete(key);
}

export async function hashEventPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyEventPasswordMatch(
  plaintext: string,
  storedHash?: string | null
): Promise<boolean> {
  if (!storedHash) return false;
  return bcrypt.compare(plaintext, storedHash);
}

/**
 * Creates a deterministic fingerprint of the event's password hash.
 * If the organizer changes or clears the password, this fingerprint will change,
 * automatically invalidating previously issued event access tokens.
 */
export function createPasswordFingerprint(passwordHash?: string | null): string {
  if (!passwordHash) return 'none';
  return crypto.createHash('sha256').update(passwordHash).digest('hex').substring(0, 16);
}

/**
 * Signs a short-lived event access token bound to the specific event ID and current password hash.
 */
export function signEventAccessToken(eventId: string, passwordHash?: string | null): string {
  return jwt.sign(
    {
      eventId,
      scope: 'event_access',
      pwdSig: createPasswordFingerprint(passwordHash),
    } satisfies EventAccessTokenPayload,
    env.JWT_SECRET,
    { expiresIn: '12h' }
  );
}

/**
 * Verifies an event access token.
 * Validates scope, eventId, token expiration, and matches the password fingerprint
 * so password changes or resets immediately invalidate previously granted access.
 */
export function verifyEventAccessToken(
  token?: string | null,
  eventId?: string,
  currentPasswordHash?: string | null
): boolean {
  if (!token || !eventId) return false;

  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as EventAccessTokenPayload;
    if (decoded.eventId !== eventId || decoded.scope !== 'event_access') {
      return false;
    }

    if (currentPasswordHash) {
      const expectedSig = createPasswordFingerprint(currentPasswordHash);
      if (decoded.pwdSig && decoded.pwdSig !== expectedSig) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}
