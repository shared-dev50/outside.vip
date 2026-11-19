import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { env } from '../../config/env.js';
import { getRedisClient } from '../../lib/redis.js';
import {
  ATTRIBUTION_WINDOW_MS,
  CLICK_DEDUP_WINDOW_SECONDS,
  ALLOWED_QUERY_PARAMS,
  isBotUserAgent,
} from './promotions.constants.js';

export interface ResolveSlugResult {
  slug: string;
  isPrimary: boolean;
  link: {
    id: string;
    eventId: string;
    type: 'CAMPAIGN' | 'HOST';
    status: 'ACTIVE' | 'DISABLED' | 'ARCHIVED';
    name: string;
    hostMemberId: string | null;
  };
  event: {
    id: string;
    slug: string | null;
    title: string;
    status: string;
    organizerId: string;
  };
}

export interface RecordClickParams {
  rawVid?: string | null;
  canonicalVisitorId?: string | null;
  visitorIdHash?: string | null;
  eventId: string;
  promotionLinkId: string;
  referrer?: string | null;
  userAgent?: string | null;
  utmParams?: Record<string, string>;
  isBot?: boolean;
}

export interface UpsertAttributionParams {
  rawVid: string;
  eventId: string;
  promotionLinkId: string;
  clickedAt?: Date;
}

/**
 * Derives a deterministic, unkeyed canonical visitor ID from the first-party cookie.
 * This internal UUID/hash never stores the raw token and remains completely stable
 * across HMAC key rotations.
 */
export function deriveCanonicalVisitorId(rawVid: string): string {
  if (!rawVid || typeof rawVid !== 'string') {
    throw new Error('rawVid is required to derive canonicalVisitorId');
  }
  return crypto
    .createHash('sha256')
    .update(`outside_canonical_vid_v1:${rawVid.trim()}`)
    .digest('hex');
}

/**
 * Computes a versioned keyed HMAC hash of the visitor token for tamper-proof lookup.
 */
export function hashVisitorId(
  rawVid: string,
  key = env.PROMOTION_ATTRIBUTION_HMAC_KEY,
  version = env.PROMOTION_ATTRIBUTION_KEY_VERSION
): string {
  if (!rawVid || typeof rawVid !== 'string') {
    throw new Error('rawVid is required to compute visitorIdHash');
  }
  const hmac = crypto
    .createHmac('sha256', key)
    .update(rawVid.trim())
    .digest('hex');
  return `v${version}:${hmac}`;
}

/**
 * Generates an opaque, cryptographically random 128-bit visitor cookie token.
 */
export function generateVisitorToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Filters an incoming query object to only retain whitelisted marketing/tracking params.
 */
export function extractWhitelistedParams(
  query: Record<string, unknown>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (ALLOWED_QUERY_PARAMS.has(key) && typeof value === 'string' && value.trim()) {
      result[key] = value.trim();
    }
  }
  return result;
}

/**
 * Resolves a URL slug from the PromotionSlugRegistry, including historical aliases.
 */
export async function resolvePromotionSlug(
  rawSlug: string
): Promise<ResolveSlugResult | null> {
  if (!rawSlug || typeof rawSlug !== 'string') return null;
  const normalizedSlug = rawSlug.trim().toLowerCase();

  const registry = await prisma.promotionSlugRegistry.findUnique({
    where: { slug: normalizedSlug },
    include: {
      promotionLink: {
        include: {
          event: {
            select: {
              id: true,
              slug: true,
              title: true,
              status: true,
              organizerId: true,
            },
          },
        },
      },
    },
  });

  if (!registry || !registry.promotionLink || !registry.promotionLink.event) {
    return null;
  }

  return {
    slug: registry.slug,
    isPrimary: registry.isPrimary,
    link: {
      id: registry.promotionLink.id,
      eventId: registry.promotionLink.eventId,
      type: registry.promotionLink.type,
      status: registry.promotionLink.status,
      name: registry.promotionLink.name,
      hostMemberId: registry.promotionLink.hostMemberId,
    },
    event: registry.promotionLink.event,
  };
}

/**
 * Records a click event with bot detection and 15-minute deduplication via Redis.
 */
export async function recordPromotionClick(
  params: RecordClickParams
): Promise<boolean> {
  const {
    canonicalVisitorId,
    visitorIdHash,
    eventId,
    promotionLinkId,
    referrer,
    userAgent,
    utmParams = {},
    isBot = false,
  } = params;

  // 1. Bots are completely ignored for click recording and attribution
  if (isBot || isBotUserAgent(userAgent)) {
    return false;
  }

  // 2. 15-minute Redis click deduplication if visitor identity is present
  if (canonicalVisitorId) {
    try {
      const redis = getRedisClient();
      const dedupKey = `click_dedup:${canonicalVisitorId}:${promotionLinkId}`;
      const isNewClick = await redis.setNxPx(
        dedupKey,
        '1',
        CLICK_DEDUP_WINDOW_SECONDS * 1000
      );

      if (!isNewClick) {
        // Duplicate click within 15-minute window; skip raw log insert
        return false;
      }
    } catch {
      // Redis unavailable: proceed gracefully with database write
    }
  }

  // 3. Insert raw PromotionClick record
  await prisma.promotionClick.create({
    data: {
      eventId,
      promotionLinkId,
      visitorIdHash: visitorIdHash || null,
      canonicalVisitorId: canonicalVisitorId || null,
      referrer: referrer || null,
      userAgent: userAgent || null,
      utmSource: utmParams.utm_source || null,
      utmMedium: utmParams.utm_medium || null,
      utmCampaign: utmParams.utm_campaign || null,
      utmTerm: utmParams.utm_term || null,
      utmContent: utmParams.utm_content || null,
      fbclid: utmParams.fbclid || null,
      gclid: utmParams.gclid || null,
      ttclid: utmParams.ttclid || null,
    },
  });

  return true;
}

/**
 * Upserts persistent event-specific visitor attribution and daily visitor-day records.
 * Uses PostgreSQL advisory locking for collision-safe serialization across key rotations.
 */
export async function upsertVisitorAttribution(
  params: UpsertAttributionParams
): Promise<{
  canonicalVisitorId: string;
  visitorIdHash: string;
  expiresAt: Date;
}> {
  const { rawVid, eventId, promotionLinkId } = params;
  const clickedAt = params.clickedAt || new Date();

  const canonicalVisitorId = deriveCanonicalVisitorId(rawVid);
  const currentKey = env.PROMOTION_ATTRIBUTION_HMAC_KEY;
  const currentVersion = env.PROMOTION_ATTRIBUTION_KEY_VERSION;
  const visitorIdHashV2 = hashVisitorId(rawVid, currentKey, currentVersion);

  const prevKey = env.PROMOTION_ATTRIBUTION_HMAC_KEY_PREVIOUS;
  const visitorIdHashV1 =
    prevKey && prevKey !== currentKey ? hashVisitorId(rawVid, prevKey, 'v1') : null;

  // Execute database attribution update within a transaction
  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // 1. Transaction-scoped advisory lock serializes concurrent visits for this (event, visitor)
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        (hashtext(${eventId})::BIGINT << 32) | (hashtext(${canonicalVisitorId})::BIGINT & 4294967295)
      )
    `;

    // 2. Query existing attribution record by unique (canonicalVisitorId, eventId)
    const existing = await tx.promotionVisitorAttribution.findUnique({
      where: {
        canonicalVisitorId_eventId: {
          canonicalVisitorId,
          eventId,
        },
      },
    });

    // 3. Determine winning click timestamp and winning promotionLinkId (last-click-wins)
    let winningClick = clickedAt;
    let winningLink = promotionLinkId;

    if (existing && existing.clickedAt > clickedAt) {
      // Delayed older request cannot overwrite a newer click
      winningClick = existing.clickedAt;
      winningLink = existing.promotionLinkId;
    }

    // Expiration is strictly calculated from the winning click (30-day attribution window)
    const expiresAt = new Date(winningClick.getTime() + ATTRIBUTION_WINDOW_MS);

    // 4. Atomic upsert into PromotionVisitorAttribution keyed by (canonicalVisitorId, eventId)
    // Upgrades visitorIdHash to latest key version in-place without creating duplicate records
    await tx.promotionVisitorAttribution.upsert({
      where: {
        canonicalVisitorId_eventId: {
          canonicalVisitorId,
          eventId,
        },
      },
      create: {
        canonicalVisitorId,
        visitorIdHash: visitorIdHashV2,
        eventId,
        promotionLinkId: winningLink,
        clickedAt: winningClick,
        expiresAt,
      },
      update: {
        visitorIdHash: visitorIdHashV2,
        promotionLinkId: winningLink,
        clickedAt: winningClick,
        expiresAt,
      },
    });

    // 5. Upsert into PromotionVisitorDay using canonicalVisitorId
    const visitDate = new Date(
      Date.UTC(clickedAt.getUTCFullYear(), clickedAt.getUTCMonth(), clickedAt.getUTCDate())
    );

    await tx.promotionVisitorDay.upsert({
      where: {
        promotionLinkId_canonicalVisitorId_visitDate: {
          promotionLinkId: winningLink,
          canonicalVisitorId,
          visitDate,
        },
      },
      create: {
        eventId,
        promotionLinkId: winningLink,
        canonicalVisitorId,
        visitDate,
        clickCount: 1,
      },
      update: {
        clickCount: { increment: 1 },
      },
    });

    return { canonicalVisitorId, visitorIdHash: visitorIdHashV2, expiresAt, winningLink };
  });

  // 7. Synchronize Redis cache post-commit (Redis failure does not fail the request)
  try {
    const redis = getRedisClient();
    const remainingMs = result.expiresAt.getTime() - Date.now();
    if (remainingMs > 0) {
      await redis.setPx(
        `visitor_attr:${eventId}:${canonicalVisitorId}`,
        result.winningLink,
        remainingMs
      );
      await redis.setPx(
        `visitor_attr:${eventId}:${result.visitorIdHash}`,
        result.winningLink,
        remainingMs
      );
    }
  } catch (err) {
    console.warn('[Promotions] Redis attribution cache sync failed (falling back to DB):', err);
  }

  return {
    canonicalVisitorId: result.canonicalVisitorId,
    visitorIdHash: result.visitorIdHash,
    expiresAt: result.expiresAt,
  };
}

export interface PrunePromotionClicksResult {
  deletedCount: number;
  cutoffDate: Date;
}

/**
 * Prunes raw PromotionClick log records older than the specified retention window (default 90 days).
 * Independent analytics summaries (PromotionVisitorDay) and persistent attribution (PromotionVisitorAttribution)
 * are strictly preserved and unaffected.
 */
export async function pruneExpiredPromotionClicks(
  olderThanDays = 90
): Promise<PrunePromotionClicksResult> {
  const cutoffDate = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);

  const result = await prisma.promotionClick.deleteMany({
    where: {
      clickedAt: {
        lt: cutoffDate,
      },
    },
  });

  return {
    deletedCount: result.count,
    cutoffDate,
  };
}
