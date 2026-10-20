import type { CorsOptions } from 'cors';
import { env } from './env.js';


export function normalizeOrigin(origin: string): string {
  if (!origin) return '';
  let cleaned = origin.trim();

  // Strip surrounding quotes if present (e.g., from .env quotes)
  cleaned = cleaned.replace(/^["']+|["']+$/g, '').trim();

  // Strip trailing slashes
  cleaned = cleaned.replace(/\/+$/, '');

  if (!cleaned) return '';

  try {
    const parsed = new URL(cleaned);
    return parsed.origin;
  } catch {
    // If not a full URL (e.g. malformed or partial), return trimmed lowercase
    return cleaned.toLowerCase();
  }
}

/**
 * Compiles all permitted origins from configuration and defaults.
 */
export function getAllAllowedOrigins(): Set<string> {
  const origins = new Set<string>();

  // 1. Mandatory production frontend origins
  const defaultProductionOrigins = [
    'https://outside-vip.vercel.app',
    'https://outside.vip',
    'https://www.outside.vip',
  ];
  for (const origin of defaultProductionOrigins) {
    const normalized = normalizeOrigin(origin);
    if (normalized) origins.add(normalized);
  }

  // 2. Local development origins
  const defaultLocalOrigins = [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:4173',
    'http://127.0.0.1:4173',
  ];
  for (const origin of defaultLocalOrigins) {
    const normalized = normalizeOrigin(origin);
    if (normalized) origins.add(normalized);
  }

  // 3. Configured CLIENT_URL from environment
  if (env.CLIENT_URL) {
    const normalizedClient = normalizeOrigin(env.CLIENT_URL);
    if (normalizedClient) origins.add(normalizedClient);
  }

  // 4. Configured ALLOWED_ORIGINS list (comma- or space-separated)
  if (env.ALLOWED_ORIGINS) {
    const customOrigins = env.ALLOWED_ORIGINS.split(/[\s,]+/);
    for (const item of customOrigins) {
      const normalized = normalizeOrigin(item);
      if (normalized) origins.add(normalized);
    }
  }

  return origins;
}

// Regex matching official Outside.vip Vercel preview deployments (e.g. outside-vip-git-main-xxx.vercel.app)
const VERCEL_PREVIEW_PATTERN = /^https:\/\/outside-vip(-[a-z0-9-]+)?\.vercel\.app$/i;

/**
 * Validates whether an origin is allowed to access the Outside.vip API.
 */
export function isOriginAllowed(
  requestOrigin: string,
  allowedOrigins: Set<string> = getAllAllowedOrigins()
): boolean {
  if (!requestOrigin) return false;

  const normalized = normalizeOrigin(requestOrigin);
  if (!normalized) return false;

  // Direct match against allowed origin set
  if (allowedOrigins.has(normalized)) {
    return true;
  }

  // Match against Vercel deployment pattern
  if (VERCEL_PREVIEW_PATTERN.test(normalized)) {
    return true;
  }

  return false;
}


export const corsOptions: CorsOptions = {
  origin: (requestOrigin, callback) => {
    // Allow non-browser requests (e.g., server-to-server, curl, health-check monitors) with no origin header
    if (!requestOrigin) {
      return callback(null, true);
    }

    const allowedOrigins = getAllAllowedOrigins();
    if (isOriginAllowed(requestOrigin, allowedOrigins)) {
      return callback(null, true);
    }

    // Log diagnostic warning for rejected origins without exposing internal tokens or database secrets
    console.warn(
      `[CORS] Blocked request from unauthorized origin: "${requestOrigin}". Allowed origins: [${Array.from(
        allowedOrigins
      ).join(', ')}]`
    );

    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'Accept',
    'Origin',
    'x-order-token',
  ],
  exposedHeaders: ['Content-Disposition'],
  optionsSuccessStatus: 204,
  maxAge: 86400, // 24 hours preflight cache
};
