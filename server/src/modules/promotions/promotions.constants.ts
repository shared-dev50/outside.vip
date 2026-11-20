/**
 * Promotional Link and Attribution Constants
 */

export const VISITOR_COOKIE_NAME = 'outside_vid';

export const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60; // 365 days in seconds (1-year sliding window)
export const ATTRIBUTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days in milliseconds (last-click validity window)
export const CLICK_DEDUP_WINDOW_SECONDS = 15 * 60; // 15 minutes in seconds

/**
 * SEC-10 Part A: Event Team Invitation Creation Rate Limits
 * - Per authenticated actor across all events: 20 new invitations per hour
 * - Per event across all authorized actors: 40 new invitations per hour
 */
export const TEAM_INVITE_CREATE_ACTOR_MAX_PER_HOUR = 20;
export const TEAM_INVITE_CREATE_EVENT_MAX_PER_HOUR = 40;
export const TEAM_INVITE_CREATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/**
 * SEC-10 Part B: Event Team Invitation Resend Cooldown & Rate Limits
 * - Minimum per-invitation resend cooldown: 60 seconds (enforced atomically via Redis SET NX PX)
 * - Per authenticated actor across all events: 10 resend requests per hour
 * - Per event across all authorized actors: 25 resend requests per hour
 */
export const TEAM_INVITE_RESEND_COOLDOWN_MS = 60 * 1000; // 60 seconds
export const TEAM_INVITE_RESEND_ACTOR_MAX_PER_HOUR = 10;
export const TEAM_INVITE_RESEND_EVENT_MAX_PER_HOUR = 25;
export const TEAM_INVITE_RESEND_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/**
 * SEC-10 Part C: Public Event Team Invitation Inspection Rate Limits
 * - Burst limit per trusted IP: 20 requests per minute
 * - Sustained limit per trusted IP: 60 requests per 15 minutes
 */
export const TEAM_INVITE_INSPECT_IP_BURST_MAX = 20;
export const TEAM_INVITE_INSPECT_IP_BURST_WINDOW_MS = 60 * 1000; // 1 minute
export const TEAM_INVITE_INSPECT_IP_SUSTAINED_MAX = 60;
export const TEAM_INVITE_INSPECT_IP_SUSTAINED_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

/**
 * SEC-10 Part D: Maximum Historical Promotional Slug Aliases per PromotionLink
 * - Each link has 1 active primary slug (isPrimary = true) and up to 10 historical aliases (isPrimary = false),
 *   for an effective maximum of 11 total slugs registered across the link's lifetime.
 */
export const MAX_HISTORICAL_SLUG_ALIASES_PER_LINK = 10;

/**
 * SEC-10 Part E: Cookie-less Promotional Resolver Abuse Protection
 * - 30-second duplicate/retry deduplication per (ipHash, promotionLinkId, slugHash, uaHash)
 * - Per-(ipHash, promotionLinkId) burst ceiling: 3 cookie-less clicks recorded per 60 seconds
 * - Per-ipHash global resolver ceiling: 15 cookie-less clicks recorded per 60 seconds across all links
 */
export const COOKIELESS_CLICK_RETRY_DEDUP_WINDOW_MS = 30 * 1000; // 30 seconds
export const COOKIELESS_LINK_BURST_MAX = 3;
export const COOKIELESS_LINK_BURST_WINDOW_MS = 60 * 1000; // 60 seconds
export const COOKIELESS_IP_SUSTAINED_MAX = 15;
export const COOKIELESS_IP_SUSTAINED_WINDOW_MS = 60 * 1000; // 60 seconds

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
  /bot|crawl|spider|slurp|facebookexternalhit|whatsapp|telegrambot|twitterbot|linkedinbot|slackbot|discordbot|bingpreview|google-structured-data-testing-tool|applebot|snapchat|pinterest|meta-externalagent/i;

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

