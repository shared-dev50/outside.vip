import { Request, Response, NextFunction } from 'express';
import { PromotionLinkStatus } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { BadRequestError, ForbiddenError, UnauthorizedError, NotFoundError } from '../../utils/errors.js';
import { resolveEventAuthorization } from '../eventTeam/eventTeam.permissions.js';
import {
  createCampaignLink,
  updatePromotionLink,
  customizePromotionSlug,
  getEventPromotionalLinks,
  getEventPromotionalAnalytics,
  getHostPromotionalAnalytics,
  parseAndValidateAnalyticsDateRange,
} from './promotions.management.service.js';

/**
 * Creates a new CAMPAIGN promotional link for an event.
 * Requires Event Owner or Event Admin with 'canManagePromotions: true'.
 */
export async function handleCreateCampaignLink(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const user = req.user;
    if (!user) throw new UnauthorizedError('Authentication required');

    const eventId = req.params.eventId;
    await resolveEventAuthorization(eventId, user, 'canManagePromotions');

    const { name, slug } = req.body;
    const link = await createCampaignLink({
      eventId,
      createdById: user.userId,
      name,
      customSlug: slug,
    });

    res.status(201).json({
      success: true,
      link,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Updates a promotional link's status (ACTIVE, DISABLED, ARCHIVED) or name.
 * Requires Event Owner or Event Admin with 'canManagePromotions: true'.
 */
export async function handleUpdatePromotionLink(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const user = req.user;
    if (!user) throw new UnauthorizedError('Authentication required');

    const { eventId, linkId } = req.params;
    await resolveEventAuthorization(eventId, user, 'canManagePromotions');

    const { name, status } = req.body;
    const updated = await updatePromotionLink(linkId, eventId, {
      name,
      status: status as PromotionLinkStatus | undefined,
    });

    res.json({
      success: true,
      link: updated,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Customizes the primary promotional slug for a link.
 * Demotes existing primary slug to a historical alias and activates new slug.
 */
export async function handleCustomizePromotionSlug(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const user = req.user;
    if (!user) throw new UnauthorizedError('Authentication required');

    const { eventId, linkId } = req.params;
    await resolveEventAuthorization(eventId, user, 'canManagePromotions');

    const { slug } = req.body;
    if (!slug || typeof slug !== 'string') {
      throw new BadRequestError('Slug is required');
    }

    const result = await customizePromotionSlug({
      linkId,
      eventId,
      newSlug: slug,
      requestingUserId: user.userId,
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * Lists all promotional links (campaign & host links) for an event.
 * Requires Event Owner or Event Admin with 'canManagePromotions: true' or 'canViewAnalytics: true'.
 */
export async function handleGetEventPromotionalLinks(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const user = req.user;
    if (!user) throw new UnauthorizedError('Authentication required');

    const eventId = req.params.eventId;
    try {
      await resolveEventAuthorization(eventId, user, 'canManagePromotions');
    } catch {
      await resolveEventAuthorization(eventId, user, 'canViewAnalytics');
    }

    const links = await getEventPromotionalLinks(eventId);
    res.json({
      success: true,
      links,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Returns event-wide or campaign-specific promotional traffic analytics.
 * STRICT: Traffic reporting only (clicks, visitors, daily breakdown, referrers, utms).
 * Excludes tickets, sales, revenue, orders, and conversions.
 * Requires Event Owner or Event Admin with 'canViewAnalytics: true'.
 */
export async function handleGetEventPromotionalAnalytics(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const user = req.user;
    if (!user) throw new UnauthorizedError('Authentication required');

    const eventId = req.params.eventId;
    await resolveEventAuthorization(eventId, user, 'canViewAnalytics');

    const { linkId, startDate, endDate } = req.query;
    if (linkId !== undefined && typeof linkId !== 'string') {
      throw new BadRequestError('Invalid linkId parameter.', 'INVALID_LINK_ID');
    }

    const { startDate: start, endDate: end } = parseAndValidateAnalyticsDateRange(
      startDate,
      endDate
    );

    const analytics = await getEventPromotionalAnalytics(eventId, {
      linkId: linkId || undefined,
      startDate: start,
      endDate: end,
    });

    res.json({
      success: true,
      analytics,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Returns traffic analytics strictly isolated to the requesting Host's personal promotional link.
 * Hosts cannot access other hosts' traffic, attendee personal info, buyer info, or financials.
 */
export async function handleGetHostPromotionalAnalytics(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const user = req.user;
    if (!user) throw new UnauthorizedError('Authentication required');

    const eventId = req.params.eventId;
    const { startDate, endDate } = parseAndValidateAnalyticsDateRange(
      req.query.startDate,
      req.query.endDate
    );
    const analytics = await getHostPromotionalAnalytics(eventId, user.userId, {
      startDate,
      endDate,
    });

    res.json({
      success: true,
      ...analytics,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Customizes the Host's personal promotional slug for an assigned event.
 */
export async function handleCustomizeHostSlug(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const user = req.user;
    if (!user) throw new UnauthorizedError('Authentication required');

    const eventId = req.params.eventId;
    const { slug } = req.body;
    if (!slug || typeof slug !== 'string') {
      throw new BadRequestError('Slug is required');
    }

    // Find host member and their link
    const hostMember = await prisma.eventTeamMember.findUnique({
      where: {
        eventId_userId: {
          eventId,
          userId: user.userId,
        },
      },
    });

    if (!hostMember || hostMember.role !== 'HOST' || hostMember.status !== 'ACTIVE') {
      throw new ForbiddenError('Active Event Host membership required to customize promotional slug.');
    }

    const hostLink = await prisma.promotionLink.findFirst({
      where: {
        eventId,
        hostMemberId: hostMember.id,
        status: { not: 'ARCHIVED' },
      },
    });

    if (!hostLink) {
      throw new NotFoundError('No active promotional link assigned to this Host');
    }

    const result = await customizePromotionSlug({
      linkId: hostLink.id,
      eventId,
      newSlug: slug,
      requestingUserId: user.userId,
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
}

