import type { CorsOptions } from 'cors';
import { env } from './env.js';


export function normalizeOrigin(origin: string): string {
  if (!origin) return '';
  let cleaned = origin.trim();

  cleaned = cleaned.replace(/^["']+|["']+$/g, '').trim();
  cleaned = cleaned.replace(/\/+$/, '');

  if (!cleaned || cleaned.includes('*')) return '';

  try {
    const parsed = new URL(cleaned);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '';
    }
    return parsed.origin;
  } catch {
    return '';
  }
}

function addOriginWithWwwVariant(origins: Set<string>, rawOrigin: string): void {
  const normalized = normalizeOrigin(rawOrigin);
  if (!normalized) return;

  origins.add(normalized);

  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'https:') return;

    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host.endsWith('.vercel.app') ||
      host.endsWith('.onrender.com')
    ) {
      return;
    }

    const portSuffix = parsed.port ? `:${parsed.port}` : '';
    if (host.startsWith('www.')) {
      const apexHost = host.slice(4);
      if (apexHost.includes('.')) {
        origins.add(`${parsed.protocol}//${apexHost}${portSuffix}`);
      }
    } else if (host.split('.').length === 2) {
      origins.add(`${parsed.protocol}//www.${host}${portSuffix}`);
    }
  } catch {
    // Non-URL string; already added if normalized
  }
}

export function getAllAllowedOrigins(): Set<string> {
  const origins = new Set<string>();

  const defaultProductionOrigins = [
    'https://out-side.vip',
    'https://www.out-side.vip',
    'https://outside.vip',
    'https://www.outside.vip',
    'https://outside-vip.vercel.app',
  ];
  for (const origin of defaultProductionOrigins) {
    addOriginWithWwwVariant(origins, origin);
  }

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

  const rawClientUrls = [
    process.env.CLIENT_URL,
    process.env.FRONTEND_URL,
    env.CLIENT_URL,
  ];
  for (const raw of rawClientUrls) {
    if (raw) {
      for (const item of raw.split(/[\s,]+/)) {
        addOriginWithWwwVariant(origins, item);
      }
    }
  }

  const allowedOriginsEnv =
    process.env.ALLOWED_ORIGINS !== undefined ? process.env.ALLOWED_ORIGINS : env.ALLOWED_ORIGINS;
  if (allowedOriginsEnv) {
    const customOrigins = allowedOriginsEnv.split(/[\s,]+/);
    for (const item of customOrigins) {
      addOriginWithWwwVariant(origins, item);
    }
  }

  return origins;
}

// Outside.vip Vercel preview deployments (e.g. outside-vip-git-main-xxx.vercel.app)
const VERCEL_PREVIEW_PATTERN = /^https:\/\/outside-vip(-[a-z0-9-]+)?\.vercel\.app$/i;

export function isOriginAllowed(
  requestOrigin: string,
  allowedOrigins: Set<string> = getAllAllowedOrigins()
): boolean {
  if (!requestOrigin) return false;

  const normalized = normalizeOrigin(requestOrigin);
  if (!normalized) return false;

  if (allowedOrigins.has(normalized)) {
    return true;
  }

  const activeNodeEnv =
    process.env.NODE_ENV !== undefined ? process.env.NODE_ENV : env.NODE_ENV;
  const rawAllowPreview =
    process.env.ALLOW_VERCEL_PREVIEW_ORIGINS !== undefined
      ? process.env.ALLOW_VERCEL_PREVIEW_ORIGINS
      : env.ALLOW_VERCEL_PREVIEW_ORIGINS;
  const allowPreviewInProd = rawAllowPreview === 'true';

  if (activeNodeEnv !== 'production' || allowPreviewInProd) {
    if (VERCEL_PREVIEW_PATTERN.test(normalized)) {
      return true;
    }
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
    'x-event-access-token',
    'X-CSRF-Token',
  ],
  exposedHeaders: ['Content-Disposition', 'X-CSRF-Token'],
  optionsSuccessStatus: 204,
  maxAge: 86400,
};
