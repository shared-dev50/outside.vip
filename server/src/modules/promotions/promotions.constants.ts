/**
 * Promotional Link and Attribution Constants
 */

export const VISITOR_COOKIE_NAME = 'outside_vid';

export const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60; // 365 days in seconds (1-year sliding window)
export const ATTRIBUTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days in milliseconds (last-click validity window)
export const CLICK_DEDUP_WINDOW_SECONDS = 15 * 60; // 15 minutes in seconds

/**
 * Whitelisted marketing and tracking query parameters to forward on short-link redirect.
 * All other query parameters are stripped to protect against query parameter pollution.
 */
export const ALLOWED_QUERY_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'fbclid',
  'gclid',
  'ttclid',
]);

/**
 * Global reserved URL slugs that cannot be registered by Campaign or Host links.
 */
export const RESERVED_SLUGS = new Set([
  'api',
  'auth',
  'admin',
  'scanner',
  'events',
  'orders',
  'tickets',
  'staff',
  'team',
  'host',
  'settings',
  'help',
  'terms',
  'privacy',
  'webhook',
  'webhooks',
  'health',
  'checkout',
  'login',
  'register',
  'forgot-password',
  'reset-password',
  'dashboard',
  'profile',
  'organizer',
  'finance',
  'r',
  'static',
  'assets',
  'favicon.ico',
  'robots.txt',
  'sitemap.xml',
]);

/**
 * Regex identifying search engines, link preview fetchers, and automated bots.
 * Bots are redirected without incrementing click metrics or creating attribution.
 */
const BOT_USER_AGENT_PATTERN =
  /bot|crawl|spider|slurp|facebookexternalhit|whatsapp|telegrambot|twitterbot|linkedinbot|slackbot|discordbot|bingpreview|google-structured-data-testing-tool|applebot/i;

export function isBotUserAgent(userAgent?: string | null): boolean {
  if (!userAgent || typeof userAgent !== 'string') return false;
  return BOT_USER_AGENT_PATTERN.test(userAgent.trim());
}

/**
 * Validates whether a slug format is URL-safe: lowercase alphanumeric with single hyphens.
 */
export function isValidSlugFormat(slug: string): boolean {
  if (!slug || slug.length < 2 || slug.length > 64) return false;
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

