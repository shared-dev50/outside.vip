import dotenv from 'dotenv';
import path from 'path';
import { z } from 'zod';
import { validatePlatformCurrencyConfig } from '../modules/finance/stripeCountries.js';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.string().default('4000').transform((val) => parseInt(val, 10)),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  REDIS_URL: z.string().default(''),
  REDIS_TLS_REJECT_UNAUTHORIZED: z.string().default('true'),
  SESSION_SECRET: z.string().default(''),
  SESSION_IDLE_TIMEOUT_MS: z
    .string()
    .default('1800000')
    .transform((val) => parseInt(val, 10)),
  SESSION_ABSOLUTE_TIMEOUT_MS: z
    .string()
    .default('604800000')
    .transform((val) => parseInt(val, 10)),
  USER_AUTH_CACHE_TTL_MS: z
    .string()
    .default('30000')
    .transform((val) => parseInt(val, 10)),
  ALLOW_VERCEL_PREVIEW_ORIGINS: z.string().default('false'),
  CLIENT_URL: z.string().default('http://localhost:5173'),
  ALLOWED_ORIGINS: z.string().default(''),
  STRIPE_SECRET_KEY: z.string().default('sk_test_placeholder'),
  STRIPE_PUBLISHABLE_KEY: z.string().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().default('whsec_placeholder'),
  STRIPE_CONNECT_WEBHOOK_SECRET: z.string().default(''),
  STRIPE_CONNECT_SUPPORTED_COUNTRIES: z.string().default('US'),
  PLATFORM_SUPPORTED_CURRENCIES: z.string().default('USD'),
  PLATFORM_COMMISSION_PERCENT: z
    .string()
    .default('5')
    .transform((val) => parseFloat(val)),
  EMAIL_FROM: z.string().default('Outside.vip <no-reply@out-side.vip>'),
  RESEND_API_KEY: z.string().default(''),
  ADMIN_EMAILS: z.string().default(''),
  CLOUDINARY_CLOUD_NAME: z.string().default(''),
  CLOUDINARY_API_KEY: z.string().default(''),
  CLOUDINARY_API_SECRET: z.string().default(''),
  GOOGLE_PLACES_API_KEY: z.string().default(''),
  GOOGLE_MAPS_API_KEY: z.string().default(''),
  DEFAULT_PLACES_COUNTRY_CODE: z.string().default('US'),
  PROMOTION_ATTRIBUTION_HMAC_KEY: z
    .string()
    .default('dev-attribution-hmac-key-min-32-chars-long-secret-outside-vip'),
  PROMOTION_ATTRIBUTION_HMAC_KEY_PREVIOUS: z.string().default(''),
  PROMOTION_ATTRIBUTION_KEY_VERSION: z.string().default('v1'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid server environment configuration:', parsed.error.format());
  throw new Error('Environment variable validation failed');
}

validatePlatformCurrencyConfig(parsed.data.PLATFORM_SUPPORTED_CURRENCIES);

export function validateStripeWebhookProductionConfig(config: {
  NODE_ENV?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_CONNECT_WEBHOOK_SECRET?: string;
}): void {
  if (config.NODE_ENV !== 'production') {
    return;
  }

  const platformSecret = (config.STRIPE_WEBHOOK_SECRET || '').trim();
  const connectSecret = (config.STRIPE_CONNECT_WEBHOOK_SECRET || '').trim();

  if (!platformSecret || platformSecret === 'whsec_placeholder') {
    throw new Error(
      'FATAL: STRIPE_WEBHOOK_SECRET must be configured with a non-placeholder signing secret in production.'
    );
  }

  if (!connectSecret || connectSecret === 'whsec_placeholder') {
    throw new Error(
      'FATAL: STRIPE_CONNECT_WEBHOOK_SECRET must be independently configured with a non-placeholder signing secret in production.'
    );
  }

  if (connectSecret === platformSecret) {
    throw new Error(
      'FATAL: STRIPE_CONNECT_WEBHOOK_SECRET must be independently configured and distinct from STRIPE_WEBHOOK_SECRET in production.'
    );
  }
}

if (parsed.data.NODE_ENV === 'production') {
  if (
    !parsed.data.PROMOTION_ATTRIBUTION_HMAC_KEY ||
    parsed.data.PROMOTION_ATTRIBUTION_HMAC_KEY.length < 32 ||
    parsed.data.PROMOTION_ATTRIBUTION_HMAC_KEY === 'dev-attribution-hmac-key-min-32-chars-long-secret-outside-vip'
  ) {
    throw new Error('FATAL: PROMOTION_ATTRIBUTION_HMAC_KEY is required and must be at least 32 characters in production');
  }
  validateStripeWebhookProductionConfig(parsed.data);
}

export const env = parsed.data;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function getAdminEmailsAllowlist(): Set<string> {
  const raw = process.env.ADMIN_EMAILS !== undefined ? process.env.ADMIN_EMAILS : env.ADMIN_EMAILS;
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((entry) => normalizeEmail(entry))
      .filter((entry) => entry.length > 0)
  );
}

export function isEmailInAdminAllowlist(email: string): boolean {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  return getAdminEmailsAllowlist().has(normalized);
}
