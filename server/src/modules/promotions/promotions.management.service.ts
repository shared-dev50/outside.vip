import crypto from 'crypto';
import { Prisma, PromotionLinkType, PromotionLinkStatus } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
} from '../../utils/errors.js';
import {
  isValidSlugFormat,
  RESERVED_SLUGS,
} from './promotions.constants.js';

export interface CreateCampaignLinkParams {
  eventId: string;
  createdById: string;
  name: string;
  customSlug?: string;
}

export interface CustomizeSlugParams {
  linkId: string;
  eventId: string;
  newSlug: string;
  requestingUserId: string;
}

/**
 * Normalizes string to a URL-safe lowercase slug format.
 */
function slugify(text: string): string {
  const cleaned = text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'campaign';
}

/**
 * Creates a new CAMPAIGN promotional link for an event with a primary slug.
 */
export async function createCampaignLink(params: CreateCampaignLinkParams) {
  const { eventId, createdById, name, customSlug } = params;

  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new BadRequestError('Link name is required');
  }

  const cleanName = name.trim().slice(0, 100);

  // Validate or generate slug
  let chosenSlug: string;
  if (customSlug && typeof customSlug === 'string' && customSlug.trim()) {
    const candidate = customSlug.trim().toLowerCase();
    if (!isValidSlugFormat(candidate)) {
      throw new BadRequestError(
        'Invalid slug format. Slugs must be 2-64 lowercase alphanumeric characters and single hyphens.'
      );
    }
    if (RESERVED_SLUGS.has(candidate)) {
      throw new BadRequestError(`Slug '${candidate}' is reserved and cannot be used.`);
    }

    const existing = await prisma.promotionSlugRegistry.findUnique({
      where: { slug: candidate },
    });
    if (existing) {
      throw new ConflictError(`Slug '${candidate}' is already in use.`);
    }
    chosenSlug = candidate;
  } else {
    // Generate URL-safe slug from campaign name
    const base = slugify(cleanName).slice(0, 48);
    let candidate = `${base}-${crypto.randomBytes(3).toString('hex')}`;
    while (RESERVED_SLUGS.has(candidate) || (await prisma.promotionSlugRegistry.findUnique({ where: { slug: candidate } }))) {
      candidate = `${base}-${crypto.randomBytes(3).toString('hex')}`;
    }
    chosenSlug = candidate;
  }

  // Create Campaign Link with primary slug
  const link = await prisma.promotionLink.create({
    data: {
      eventId,
      type: PromotionLinkType.CAMPAIGN,
      status: PromotionLinkStatus.ACTIVE,
      name: cleanName,
      createdById,
      slugRegistry: {
        create: [
          {
            slug: chosenSlug,
            isPrimary: true,
          },
        ],
      },
    },
    include: {
      slugRegistry: true,
    },
  });

  return {
    id: link.id,
    eventId: link.eventId,
    type: link.type,
    status: link.status,
    name: link.name,
    primarySlug: chosenSlug,
    shortUrl: `/r/${chosenSlug}`,
    createdAt: link.createdAt,
  };
}

/**
 * Updates a promotional link's name or status (ACTIVE, DISABLED, ARCHIVED).
 */
export async function updatePromotionLink(
  linkId: string,
  eventId: string,
  updates: { name?: string; status?: PromotionLinkStatus }
) {
  const link = await prisma.promotionLink.findFirst({
    where: { id: linkId, eventId },
    include: {
      hostMember: true,
    },
  });

  if (!link) {
    throw new NotFoundError('Promotion link not found');
  }

  // INVARIANT ENFORCEMENT: A Host link may be ACTIVE only when its associated
  // membership has role = HOST and status = ACTIVE.
  if (updates.status === 'ACTIVE' && link.type === 'HOST') {
    if (!link.hostMember || link.hostMember.role !== 'HOST' || link.hostMember.status !== 'ACTIVE') {
      throw new BadRequestError(
        'Cannot activate Host promotional link because the associated team member is not an active Host'
      );
    }
  }

  const data: Prisma.PromotionLinkUpdateInput = {};
  if (updates.name && updates.name.trim()) {
    data.name = updates.name.trim().slice(0, 100);
  }
  if (updates.status) {
    data.status = updates.status;
  }

  return await prisma.promotionLink.update({
    where: { id: link.id },
    data,
    include: {
      slugRegistry: {
        where: { isPrimary: true },
      },
    },
  });
}

/**
 * Customizes the primary promotional slug of a Host or Campaign link.
 * Demotes current primary slug to a historical alias and registers the new slug as primary.
 */
export async function customizePromotionSlug(params: CustomizeSlugParams) {
  const { linkId, eventId, newSlug, requestingUserId } = params;

  if (!newSlug || typeof newSlug !== 'string') {
    throw new BadRequestError('New slug is required');
  }

  const normalizedSlug = newSlug.trim().toLowerCase();

  if (!isValidSlugFormat(normalizedSlug)) {
    throw new BadRequestError(
      'Invalid slug format. Slugs must be 2-64 lowercase alphanumeric characters and single hyphens.'
    );
  }

  if (RESERVED_SLUGS.has(normalizedSlug)) {
    throw new BadRequestError(`Slug '${normalizedSlug}' is reserved.`);
  }

  const link = await prisma.promotionLink.findFirst({
    where: { id: linkId, eventId },
    include: {
      hostMember: true,
      slugRegistry: true,
    },
  });

  if (!link) {
    throw new NotFoundError('Promotion link not found');
  }

  // Verify caller authorization for this link
  if (link.type === PromotionLinkType.HOST) {
    // If HOST link: caller must be the assigned Host member or event owner
    const event = await prisma.event.findUnique({ where: { id: eventId } });
    const isOwner = event?.organizerId === requestingUserId;
    const isAssignedHost = link.hostMember?.userId === requestingUserId;
    if (!isOwner && !isAssignedHost) {
      throw new ForbiddenError('You can only customize your own Host promotional link slug.');
    }
  }

  // Check if requested slug is already primary for this link
  const currentPrimary = link.slugRegistry.find((s) => s.isPrimary);
  if (currentPrimary && currentPrimary.slug === normalizedSlug) {
    return {
      success: true,
      primarySlug: normalizedSlug,
      linkId: link.id,
      unchanged: true,
    };
  }

  // Check if requested slug is already used elsewhere in PromotionSlugRegistry
  const existingSlug = await prisma.promotionSlugRegistry.findUnique({
    where: { slug: normalizedSlug },
  });

  if (existingSlug && existingSlug.promotionLinkId !== link.id) {
    throw new ConflictError(`Slug '${normalizedSlug}' is already in use by another link.`);
  }

  // Execute primary slug switch in a transaction
  return await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // 1. Demote current primary slug(s) to historical alias(es)
    await tx.promotionSlugRegistry.updateMany({
      where: {
        promotionLinkId: link.id,
        isPrimary: true,
      },
      data: {
        isPrimary: false,
      },
    });

    // 2. Upsert or insert the new slug as primary
    if (existingSlug && existingSlug.promotionLinkId === link.id) {
      // Re-promoting an existing historical alias to primary
      await tx.promotionSlugRegistry.update({
        where: { slug: normalizedSlug },
        data: { isPrimary: true },
      });
    } else {
      await tx.promotionSlugRegistry.create({
        data: {
          slug: normalizedSlug,
          promotionLinkId: link.id,
          isPrimary: true,
        },
      });
    }

    return {
      success: true,
      primarySlug: normalizedSlug,
      previousSlug: currentPrimary?.slug,
      shortUrl: `/r/${normalizedSlug}`,
    };
  });
}

/**
 * Lists promotional links for an event with their primary slugs and historical aliases.
 */
export async function getEventPromotionalLinks(eventId: string) {
  const links = await prisma.promotionLink.findMany({
    where: { eventId },
    include: {
      slugRegistry: {
        orderBy: { createdAt: 'desc' },
      },
      hostMember: {
        include: {
          user: {
            select: {
              name: true,
              email: true,
            },
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return links.map((link) => {
    const primary = link.slugRegistry.find((s) => s.isPrimary);
    const aliases = link.slugRegistry.filter((s) => !s.isPrimary).map((s) => s.slug);

    return {
      id: link.id,
      eventId: link.eventId,
      type: link.type,
      status: link.status,
      name: link.name,
      primarySlug: primary?.slug || null,
      shortUrl: primary ? `/r/${primary.slug}` : null,
      historicalAliases: aliases,
      host: link.hostMember ? {
        memberId: link.hostMember.id,
        name: link.hostMember.user.name,
        email: link.hostMember.user.email,
      } : null,
      createdAt: link.createdAt,
    };
  });
}

/**
 * Returns traffic-only promotional analytics for an event or specific campaign.
 * STRICT: Excludes all sales, revenue, tickets, and conversions.
 */
export async function getEventPromotionalAnalytics(
  eventId: string,
  options: {
    linkId?: string;
    startDate?: Date;
    endDate?: Date;
  } = {}
) {
  const { linkId, startDate, endDate } = options;

  // 1. Where clauses for clicks and visitor-days
  const clickWhere: Prisma.PromotionClickWhereInput = { eventId };
  const dayWhere: Prisma.PromotionVisitorDayWhereInput = { eventId };

  if (linkId) {
    clickWhere.promotionLinkId = linkId;
    dayWhere.promotionLinkId = linkId;
  }

  if (startDate || endDate) {
    const dateFilter: Prisma.DateTimeFilter = {};
    if (startDate) dateFilter.gte = startDate;
    if (endDate) dateFilter.lte = endDate;

    clickWhere.clickedAt = dateFilter;
    dayWhere.visitDate = dateFilter;
  }

  // 2. Total clicks
  const totalClicks = await prisma.promotionClick.count({ where: clickWhere });

  // 3. Unique visitors (distinct canonicalVisitorId in PromotionVisitorDay)
  const uniqueVisitorRows = await prisma.promotionVisitorDay.findMany({
    where: dayWhere,
    select: { canonicalVisitorId: true },
    distinct: ['canonicalVisitorId'],
  });
  const uniqueVisitors = uniqueVisitorRows.length;

  // 4. Daily visits breakdown (clicks & unique visitors per day)
  const dailyVisitorDays = await prisma.promotionVisitorDay.findMany({
    where: dayWhere,
    orderBy: { visitDate: 'asc' },
  });

  const dailyMap = new Map<string, { date: string; clicks: number; visitors: Set<string> }>();
  for (const row of dailyVisitorDays) {
    const key = row.visitDate.toISOString().slice(0, 10);
    if (!dailyMap.has(key)) {
      dailyMap.set(key, { date: key, clicks: 0, visitors: new Set() });
    }
    const entry = dailyMap.get(key)!;
    entry.clicks += row.clickCount;
    entry.visitors.add(row.canonicalVisitorId);
  }

  const dailyVisits = Array.from(dailyMap.values()).map((e) => ({
    date: e.date,
    clicks: e.clicks,
    uniqueVisitors: e.visitors.size,
  }));

  // 5. Top Referrers
  const referrerClicks = await prisma.promotionClick.groupBy({
    by: ['referrer'],
    where: {
      ...clickWhere,
      referrer: { not: null },
    },
    _count: { _all: true },
    orderBy: { _count: { referrer: 'desc' } },
    take: 10,
  });

  const topReferrers = referrerClicks.map((r) => ({
    referrer: r.referrer || 'Direct / None',
    clicks: r._count._all,
  }));

  // 6. Top UTM Sources
  const utmSources = await prisma.promotionClick.groupBy({
    by: ['utmSource'],
    where: {
      ...clickWhere,
      utmSource: { not: null },
    },
    _count: { _all: true },
    orderBy: { _count: { utmSource: 'desc' } },
    take: 10,
  });

  // 7. Per-Link Traffic Breakdown (if querying event-wide)
  let linksBreakdown: Array<{
    linkId: string;
    name: string;
    type: PromotionLinkType;
    primarySlug: string | null;
    totalClicks: number;
    uniqueVisitors: number;
  }> = [];

  if (!linkId) {
    const links = await prisma.promotionLink.findMany({
      where: { eventId, status: { not: 'ARCHIVED' } },
      include: {
        slugRegistry: { where: { isPrimary: true } },
      },
    });

    const linkStats = await Promise.all(
      links.map(async (l) => {
        const clicks = await prisma.promotionClick.count({
          where: { promotionLinkId: l.id },
        });
        const visitors = await prisma.promotionVisitorDay.findMany({
          where: { promotionLinkId: l.id },
          select: { canonicalVisitorId: true },
          distinct: ['canonicalVisitorId'],
        });
        return {
          linkId: l.id,
          name: l.name,
          type: l.type,
          primarySlug: l.slugRegistry[0]?.slug || null,
          totalClicks: clicks,
          uniqueVisitors: visitors.length,
        };
      })
    );
    linksBreakdown = linkStats;
  }

  return {
    traffic: {
      totalClicks,
      uniqueVisitors,
      dailyVisits,
      topReferrers,
      utmBreakdown: utmSources.map((u) => ({
        source: u.utmSource,
        clicks: u._count._all,
      })),
      linksBreakdown: linksBreakdown.length > 0 ? linksBreakdown : undefined,
    },
  };
}

/**
 * Returns traffic-only analytics strictly for a Host's assigned personal link.
 * STRICT ISOLATION: Host cannot see any other links, hosts, attendees, buyers, or financials.
 */
export async function getHostPromotionalAnalytics(
  eventId: string,
  userId: string
) {
  // Find host member record
  const hostMember = await prisma.eventTeamMember.findUnique({
    where: {
      eventId_userId: {
        eventId,
        userId,
      },
    },
  });

  if (!hostMember || hostMember.role !== 'HOST' || hostMember.status !== 'ACTIVE') {
    throw new ForbiddenError('Active Event Host membership required to view Host analytics.');
  }

  // Find host's personal link
  const hostLink = await prisma.promotionLink.findFirst({
    where: {
      eventId,
      hostMemberId: hostMember.id,
      status: { not: 'ARCHIVED' },
    },
    include: {
      slugRegistry: {
        where: { isPrimary: true },
      },
    },
  });

  if (!hostLink) {
    throw new NotFoundError('No active promotional link assigned to this Host.');
  }

  const primarySlug = hostLink.slugRegistry[0]?.slug || null;

  // Query stats strictly scoped to hostLink.id
  const totalClicks = await prisma.promotionClick.count({
    where: { promotionLinkId: hostLink.id },
  });

  const uniqueVisitorRows = await prisma.promotionVisitorDay.findMany({
    where: { promotionLinkId: hostLink.id },
    select: { canonicalVisitorId: true },
    distinct: ['canonicalVisitorId'],
  });

  const dailyVisitorDays = await prisma.promotionVisitorDay.findMany({
    where: { promotionLinkId: hostLink.id },
    orderBy: { visitDate: 'asc' },
  });

  const dailyMap = new Map<string, { date: string; clicks: number; visitors: Set<string> }>();
  for (const row of dailyVisitorDays) {
    const key = row.visitDate.toISOString().slice(0, 10);
    if (!dailyMap.has(key)) {
      dailyMap.set(key, { date: key, clicks: 0, visitors: new Set() });
    }
    const entry = dailyMap.get(key)!;
    entry.clicks += row.clickCount;
    entry.visitors.add(row.canonicalVisitorId);
  }

  const dailyVisits = Array.from(dailyMap.values()).map((e) => ({
    date: e.date,
    clicks: e.clicks,
    uniqueVisitors: e.visitors.size,
  }));

  const referrerClicks = await prisma.promotionClick.groupBy({
    by: ['referrer'],
    where: {
      promotionLinkId: hostLink.id,
      referrer: { not: null },
    },
    _count: { _all: true },
    orderBy: { _count: { referrer: 'desc' } },
    take: 5,
  });

  return {
    link: {
      id: hostLink.id,
      name: hostLink.name,
      primarySlug,
      shortUrl: primarySlug ? `/r/${primarySlug}` : null,
      status: hostLink.status,
    },
    traffic: {
      totalClicks,
      uniqueVisitors: uniqueVisitorRows.length,
      dailyVisits,
      topReferrers: referrerClicks.map((r) => ({
        referrer: r.referrer || 'Direct / None',
        clicks: r._count._all,
      })),
    },
  };
}

