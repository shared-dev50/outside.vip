import dotenv from 'dotenv';
import path from 'path';
import { z } from 'zod';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.string().default('4000').transform((val) => parseInt(val, 10)),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  CLIENT_URL: z.string().default('http://localhost:5173'),
  ALLOWED_ORIGINS: z.string().default(''),
  STRIPE_SECRET_KEY: z.string().default('sk_test_placeholder'),
  STRIPE_PUBLISHABLE_KEY: z.string().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().default('whsec_placeholder'),
  PLATFORM_COMMISSION_PERCENT: z
    .string()
    .default('5')
    .transform((val) => parseFloat(val)),
  EMAIL_FROM: z.string().default('tickets@outside.vip'),
  RESEND_API_KEY: z.string().default(''),
  ADMIN_EMAILS: z.string().default(''),
  CLOUDINARY_CLOUD_NAME: z.string().default(''),
  CLOUDINARY_API_KEY: z.string().default(''),
  CLOUDINARY_API_SECRET: z.string().default(''),
  GOOGLE_PLACES_API_KEY: z.string().default(''),
  GOOGLE_MAPS_API_KEY: z.string().default(''),
  DEFAULT_PLACES_COUNTRY_CODE: z.string().default('US'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid server environment configuration:', parsed.error.format());
  throw new Error('Environment variable validation failed');
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
