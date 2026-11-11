import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';
import { getAllAllowedOrigins, isOriginAllowed } from '../config/cors.js';
import { ForbiddenError } from '../utils/errors.js';
import { extractSessionCookie } from '../lib/session.service.js';

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function getCsrfHmacSecret(): string {
  return (process.env.SESSION_SECRET || env.SESSION_SECRET || env.JWT_SECRET).trim();
}

export function generateStatelessCsrfToken(): string {
  const nonce = crypto.randomBytes(24).toString('base64url');
  const sig = crypto
    .createHmac('sha256', getCsrfHmacSecret())
    .update(`csrf:${nonce}`)
    .digest('base64url');
  return `${nonce}.${sig}`;
}

export function verifyStatelessCsrfToken(token: string): boolean {
  if (!token || typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return false;
  const nonce = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expectedSig = crypto
    .createHmac('sha256', getCsrfHmacSecret())
    .update(`csrf:${nonce}`)
    .digest('base64url');

  const aBuf = Buffer.from(sig, 'utf8');
  const bBuf = Buffer.from(expectedSig, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function timingSafeStringEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

/**
 * Enforces Origin / Sec-Fetch-Site validation and Synchronizer CSRF Token verification
 * for state-changing requests (`POST`, `PUT`, `PATCH`, `DELETE`).
 */
export function csrfProtection(req: Request, _res: Response, next: NextFunction): void {
  try {
    if (!STATE_CHANGING_METHODS.has(req.method.toUpperCase())) {
      return next();
    }

    const requestPath = req.originalUrl || req.path || '';
    // Stripe webhooks use raw body HMAC signature verification via Stripe-Signature
    if (requestPath.startsWith('/api/webhooks')) {
      return next();
    }

    // 1. Validate Sec-Fetch-Site if supplied by a modern browser
    const secFetchSite = req.headers['sec-fetch-site'];
    if (typeof secFetchSite === 'string' && secFetchSite.toLowerCase() === 'cross-site') {
      throw new ForbiddenError(
        'Cross-site state-changing requests are forbidden.',
        'CSRF_CROSS_SITE_BLOCKED'
      );
    }

    // 2. Validate Origin header against explicitly configured trusted origins
    const originHeader = req.headers.origin;
    if (typeof originHeader === 'string' && originHeader.trim().length > 0) {
      const allowedOrigins = getAllAllowedOrigins();
      if (!isOriginAllowed(originHeader, allowedOrigins)) {
        throw new ForbiddenError(
          `Request origin "${originHeader}" is not trusted for state-changing operations.`,
          'CSRF_ORIGIN_MISMATCH'
        );
      }
    }

    // 3. If the request is authenticated via the __Host-outside_sid session cookie,
    // require a valid X-CSRF-Token header matching `req.session.csrfToken`.
    if (req.session && extractSessionCookie(req)) {
      const incomingToken =
        (req.headers['x-csrf-token'] as string | undefined) ||
        (req.headers['csrf-token'] as string | undefined);

      const isCredentialAuthEntry =
        requestPath.startsWith('/api/auth/login') ||
        requestPath.startsWith('/api/auth/register');

      if (!incomingToken || typeof incomingToken !== 'string') {
        if (!isCredentialAuthEntry) {
          throw new ForbiddenError(
            'Missing CSRF token header (X-CSRF-Token) on authenticated state-changing request.',
            'CSRF_TOKEN_MISSING'
          );
        }
      } else if (!timingSafeStringEquals(incomingToken.trim(), req.session.csrfToken)) {
        throw new ForbiddenError(
          'Invalid CSRF token for the active session.',
          'CSRF_TOKEN_INVALID'
        );
      }
    }

    next();
  } catch (err) {
    next(err);
  }
}
