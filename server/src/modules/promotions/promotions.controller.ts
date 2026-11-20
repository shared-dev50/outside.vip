import { Request, Response } from 'express';
import { env } from '../../config/env.js';
import {
  VISITOR_COOKIE_NAME,
  COOKIE_MAX_AGE_SECONDS,
  isBotUserAgent,
} from './promotions.constants.js';
import {
  generateVisitorToken,
  deriveCanonicalVisitorId,
  hashVisitorId,
  extractWhitelistedParams,
  resolvePromotionSlug,
  recordPromotionClick,
  upsertVisitorAttribution,
} from './promotions.service.js';

/**
 * Handles short-link resolution and HTTP 302 redirection.
 * Sets the host-only outside_vid cookie, forwards whitelisted UTMs,
 * filters bots, deduplicates clicks, and establishes persistent attribution.
 */
export async function handleShortLinkRedirect(
  req: Request,
  res: Response
): Promise<void> {
  const rawSlug = req.params.slug;
  if (!rawSlug) {
    res.status(404).json({ error: 'Promotion slug required' });
    return;
  }

  // 1. Resolve slug from PromotionSlugRegistry
  const resolved = await resolvePromotionSlug(rawSlug);
  if (!resolved) {
    // If slug not registered, respond with 404
    res.status(404).json({ error: 'Promotion link not found' });
    return;
  }

  const { link, event } = resolved;

  // 2. Extract or generate first-party visitor cookie
  let rawVid = req.cookies?.[VISITOR_COOKIE_NAME];
  if (!rawVid || typeof rawVid !== 'string' || rawVid.trim().length < 16) {
    rawVid = generateVisitorToken();
  } else {
    rawVid = rawVid.trim();
  }

  // 3. Bot Detection
  const userAgent = req.headers['user-agent'] as string | undefined;
  const isBot = isBotUserAgent(userAgent);

  // 4. Extract whitelisted marketing query parameters
  const whitelistedParams = extractWhitelistedParams(req.query as Record<string, unknown>);

  // 5. If not a bot and link is ACTIVE, record click and establish persistent attribution
  // Disabled or archived links redirect to public event without recording clicks, visitor-days, or attribution
  if (!isBot && link.status === 'ACTIVE') {
    const canonicalVisitorId = deriveCanonicalVisitorId(rawVid);
    const visitorIdHash = hashVisitorId(rawVid);
    const referrer = (req.headers['referer'] || req.headers['referrer']) as string | undefined;

    // Record click with 15-minute deduplication
    await recordPromotionClick({
      rawVid,
      canonicalVisitorId,
      visitorIdHash,
      eventId: event.id,
      promotionLinkId: link.id,
      referrer,
      userAgent,
      utmParams: whitelistedParams,
      isBot: false,
    }).catch((err) => {
      console.warn('[Promotions] Click recording error:', err);
    });

    // Establish persistent 30-day attribution
    await upsertVisitorAttribution({
      rawVid,
      eventId: event.id,
      promotionLinkId: link.id,
    }).catch((err) => {
      console.warn('[Promotions] Attribution upsert error:', err);
    });
  }

  // 6. Set Host-Only outside_vid cookie (HttpOnly, SameSite=Lax, Secure, NO Domain)
  const isProduction = env.NODE_ENV === 'production';
  const cookieParts = [
    `${VISITOR_COOKIE_NAME}=${encodeURIComponent(rawVid)}`,
    'Path=/',
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (isProduction) {
    cookieParts.push('Secure');
  }

  res.append('Set-Cookie', cookieParts.join('; '));

  // 7. Construct destination event URL with whitelisted query parameters
  const eventIdentifier = event.slug || event.id;
  const targetPath = `/events/${encodeURIComponent(eventIdentifier)}`;

  const searchParams = new URLSearchParams(whitelistedParams);
  const queryString = searchParams.toString();
  const redirectUrl = queryString ? `${targetPath}?${queryString}` : targetPath;

  // 8. Execute HTTP 302 Redirect
  res.redirect(302, redirectUrl);
}

