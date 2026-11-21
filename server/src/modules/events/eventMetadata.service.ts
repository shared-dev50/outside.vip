import { Event, EventStatus } from '@prisma/client';
import { env } from '../../config/env.js';

export interface EventSocialMetadata {
  title: string;
  description: string;
  imageUrl: string;
  url: string;
  type: string;
  twitterCard: 'summary_large_image' | 'summary';
  siteName: string;
}

/**
 * Single authoritative publication-eligibility check for crawler HTML and public social metadata.
 * Only events with status === PUBLISHED may expose public metadata.
 */
export function isEventPubliclyPublished(
  event: { status?: EventStatus | string | null } | null | undefined
): boolean {
  return Boolean(event && event.status === EventStatus.PUBLISHED);
}

/**
 * Escapes special characters for safe inclusion in HTML attributes and content.
 */
export function escapeHtml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Builds normalized, privacy-aware social preview metadata for an event.
 */
export function buildEventSocialMetadata(
  event: Pick<Event, 'title' | 'slug' | 'description' | 'coverImageUrl'> & {
    tagline?: string | null;
    isPasswordProtected?: boolean | null;
    status?: string | null;
  },
  options?: { baseUrl?: string }
): EventSocialMetadata {
  const baseUrl = (options?.baseUrl || env.CLIENT_URL || 'https://outside.vip').replace(/\/+$/, '');
  const siteName = 'Outside.vip';
  const defaultFallbackImage = `${baseUrl}/android-chrome-512x512.png`;

  // Protect private password-protected events from crawler data leakage
  if (event.isPasswordProtected) {
    return {
      title: `Private Event | ${siteName}`,
      description: `This event is private and password protected on ${siteName}. Enter access password to view details.`,
      imageUrl: defaultFallbackImage,
      url: `${baseUrl}/events/${encodeURIComponent(event.slug)}`,
      type: 'website',
      twitterCard: 'summary_large_image',
      siteName,
    };
  }

  const rawTitle = event.title?.trim() || 'Event Details';
  const title = `${rawTitle} | ${siteName}`;

  // Description sanitization & truncation
  let cleanDesc = (event.tagline || event.description || '')
    .replace(/<[^>]*>/g, '') // strip HTML tags
    .replace(/\s+/g, ' ') // collapse whitespace
    .trim();

  if (!cleanDesc) {
    cleanDesc = `Get tickets for ${rawTitle} on ${siteName}. Discover event details, schedule, and ticket tiers.`;
  } else if (cleanDesc.length > 250) {
    cleanDesc = cleanDesc.slice(0, 247).trim() + '...';
  }

  // Absolute image URL resolution
  let imageUrl = defaultFallbackImage;
  if (event.coverImageUrl && typeof event.coverImageUrl === 'string' && event.coverImageUrl.trim()) {
    const rawImage = event.coverImageUrl.trim();
    if (rawImage.startsWith('http://') || rawImage.startsWith('https://')) {
      imageUrl = rawImage;
    } else {
      imageUrl = `${baseUrl}${rawImage.startsWith('/') ? '' : '/'}${rawImage}`;
    }
  }

  const url = `${baseUrl}/events/${encodeURIComponent(event.slug)}`;

  return {
    title,
    description: cleanDesc,
    imageUrl,
    url,
    type: 'website',
    twitterCard: 'summary_large_image',
    siteName,
  };
}

/**
 * Renders a lightweight, crawler-readable HTML document exposing Open Graph and Twitter Card tags.
 */
export function renderCrawlerHtml(
  metadata: EventSocialMetadata,
  options?: { redirectUrl?: string }
): string {
  const escapedTitle = escapeHtml(metadata.title);
  const escapedDesc = escapeHtml(metadata.description);
  const escapedImage = escapeHtml(metadata.imageUrl);
  const escapedUrl = escapeHtml(metadata.url);
  const escapedSiteName = escapeHtml(metadata.siteName);
  const targetUrl = options?.redirectUrl ? escapeHtml(options.redirectUrl) : escapedUrl;
  const refreshTag = options?.redirectUrl
    ? `\n  <!-- Refresh Redirect for Short-Link Resolvers -->\n  <meta http-equiv="refresh" content="0; url=${escapeHtml(options.redirectUrl)}" />`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapedTitle}</title>
  <meta name="description" content="${escapedDesc}" />
  <link rel="canonical" href="${escapedUrl}" />

  <!-- Open Graph / Facebook -->
  <meta property="og:type" content="${metadata.type}" />
  <meta property="og:url" content="${escapedUrl}" />
  <meta property="og:title" content="${escapedTitle}" />
  <meta property="og:description" content="${escapedDesc}" />
  <meta property="og:image" content="${escapedImage}" />
  <meta property="og:site_name" content="${escapedSiteName}" />

  <!-- Twitter Card -->
  <meta name="twitter:card" content="${metadata.twitterCard}" />
  <meta name="twitter:url" content="${escapedUrl}" />
  <meta name="twitter:title" content="${escapedTitle}" />
  <meta name="twitter:description" content="${escapedDesc}" />
  <meta name="twitter:image" content="${escapedImage}" />${refreshTag}
</head>
<body style="font-family: sans-serif; background: #FAF8F5; color: #1c1917; padding: 2rem;">
  <h2>${escapedTitle}</h2>
  <p>${escapedDesc}</p>
  <p><a href="${targetUrl}">Continue to Event &rarr;</a></p>
</body>
</html>`;
}

