import { Request, Response, NextFunction } from 'express';
import { EventStatus, OrderStatus, TicketStatus, Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { listEventsQuerySchema, verifyEventPasswordSchema } from './events.schema.js';
import { NotFoundError, UnauthorizedError } from '../../utils/errors.js';
import {
  checkPasswordRateLimit,
  recordFailedPasswordAttempt,
  clearPasswordRateLimit,
  verifyEventPasswordMatch,
  signEventAccessToken,
  verifyEventAccessToken,
} from './passwordAccess.service.js';

export async function listEvents(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = listEventsQuerySchema.parse(req.query);
    const { search, category, city, featuredOnly, timeFilter, sortBy = 'date_asc', page, limit } = query;

    const where: Prisma.EventWhereInput = {
      status: EventStatus.PUBLISHED,
      showOnExplore: true,
    };

    if (search && search.trim().length > 0) {
      where.OR = [
        { title: { contains: search.trim(), mode: 'insensitive' } },
        { tagline: { contains: search.trim(), mode: 'insensitive' } },
        { description: { contains: search.trim(), mode: 'insensitive' } },
        { venueName: { contains: search.trim(), mode: 'insensitive' } },
        { city: { contains: search.trim(), mode: 'insensitive' } },
      ];
    }

    if (category) {
      where.category = category;
    }

    if (city) {
      where.city = { equals: city.trim(), mode: 'insensitive' };
    }

    if (featuredOnly) {
      where.isFeatured = true;
    }

    const now = new Date();
    if (timeFilter === 'upcoming') {
      where.endAt = { gte: now };
    } else if (timeFilter === 'this_weekend') {
      // Find upcoming Friday 18:00 to Sunday 23:59
      const today = new Date();
      const dayOfWeek = today.getDay(); // 0 is Sunday, 5 is Friday
      const daysUntilFriday = (5 - dayOfWeek + 7) % 7;
      const friday = new Date(today);
      friday.setDate(today.getDate() + daysUntilFriday);
      friday.setHours(12, 0, 0, 0);

      const sunday = new Date(friday);
      sunday.setDate(friday.getDate() + 2);
      sunday.setHours(23, 59, 59, 999);

      where.startAt = { gte: now, lte: sunday };
      where.endAt = { gte: friday };
    } else if (timeFilter === 'this_month') {
      const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
      where.startAt = { gte: now, lte: endOfMonth };
    }

    const skip = (page - 1) * limit;

    const dateOrder: Prisma.EventOrderByWithRelationInput =
      sortBy === 'date_desc' ? { startAt: 'desc' } : { startAt: 'asc' };

    const [events, total] = await Promise.all([
      prisma.event.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ isFeatured: 'desc' }, dateOrder],
        include: {
          organizer: {
            select: {
              id: true,
              name: true,
              avatarUrl: true,
              organizer: {
                select: {
                  displayName: true,
                  slug: true,
                  logoUrl: true,
                },
              },
            },
          },
          ticketTiers: {
            where: {
              status: { in: ['ACTIVE', 'SOLD_OUT'] },
            },
            select: {
              id: true,
              name: true,
              priceInCents: true,
              currency: true,
              totalCapacity: true,
              soldQuantity: true,
              status: true,
            },
          },
        },
      }),
      prisma.event.count({ where }),
    ]);

    // Enhance events with lowest price and availability status, ensuring passwordHash is stripped
    let enhancedEvents = events.map((event) => {
      const { passwordHash: _, ...eventWithoutHash } = event;
      const minPrice =
        event.ticketTiers.length > 0
          ? Math.min(...event.ticketTiers.map((t) => t.priceInCents))
          : 0;

      const currency = event.ticketTiers[0]?.currency || 'USD';
      const isSoldOut = event.ticketTiers.every(
        (t) => t.status === 'SOLD_OUT' || t.soldQuantity >= t.totalCapacity
      );

      return {
        ...eventWithoutHash,
        minPriceInCents: minPrice,
        currency,
        isSoldOut,
        tierCount: event.ticketTiers.length,
      };
    });

    if (sortBy === 'price_asc') {
      enhancedEvents = enhancedEvents.sort((a, b) => (a.minPriceInCents || 0) - (b.minPriceInCents || 0));
    } else if (sortBy === 'price_desc') {
      enhancedEvents = enhancedEvents.sort((a, b) => (b.minPriceInCents || 0) - (a.minPriceInCents || 0));
    }

    res.json({
      success: true,
      data: {
        events: enhancedEvents,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
          hasMore: skip + events.length < total,
        },
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function getEventBySlug(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { slug } = req.params;

    const event = await prisma.event.findUnique({
      where: { slug },
      include: {
        organizer: {
          select: {
            id: true,
            name: true,
            avatarUrl: true,
            organizer: {
              select: {
                displayName: true,
                slug: true,
                bio: true,
                websiteUrl: true,
                instagramHandle: true,
                twitterHandle: true,
                logoUrl: true,
              },
            },
          },
        },
        ticketTiers: {
          orderBy: { priceInCents: 'asc' },
          select: {
            id: true,
            name: true,
            description: true,
            priceInCents: true,
            currency: true,
            totalCapacity: true,
            reservedQuantity: true,
            soldQuantity: true,
            minPerOrder: true,
            maxPerOrder: true,
            salesStartAt: true,
            salesEndAt: true,
            status: true,
            waitlistEnabled: true,
          },
        },
        galleryImages: {
          orderBy: { displayOrder: 'asc' },
          select: {
            id: true,
            imageUrl: true,
            publicId: true,
            displayOrder: true,
          },
        },
        features: {
          orderBy: { displayOrder: 'asc' },
          select: {
            id: true,
            name: true,
            type: true,
            imageUrl: true,
            imagePublicId: true,
            description: true,
            displayOrder: true,
          },
        },
        series: {
          select: {
            id: true,
            title: true,
            frequency: true,
            interval: true,
            byWeekday: true,
            events: {
              where: {
                status: EventStatus.PUBLISHED,
                endAt: { gte: new Date() },
              },
              orderBy: { startAt: 'asc' },
              take: 6,
              select: {
                id: true,
                slug: true,
                occurrenceIndex: true,
                startAt: true,
                endAt: true,
              },
            },
          },
        },
      },
    });

    if (!event) {
      throw new NotFoundError(`Event with slug '${slug}' was not found`);
    }

    // Determine access permissions
    const accessToken =
      (req.headers['x-event-access-token'] as string) ||
      (req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.substring(7)
        : undefined);

    const hasTokenAccess = accessToken ? verifyEventAccessToken(accessToken, event.id) : false;
    const isOwner = req.user && (req.user.userId === event.organizerId || req.user.role === 'ADMIN');
    const hasAccess = !event.isPasswordProtected || hasTokenAccess || Boolean(isOwner);

    // If password-protected and unauthenticated, return sanitized teaser without sensitive content
    if (event.isPasswordProtected && !hasAccess) {
      res.json({
        success: true,
        data: {
          event: {
            id: event.id,
            slug: event.slug,
            title: event.title,
            tagline: event.tagline,
            coverImageUrl: event.coverImageUrl,
            thumbnailUrl: event.thumbnailUrl,
            category: event.category,
            city: event.city,
            country: event.country,
            startAt: event.startAt,
            endAt: event.endAt,
            timezone: event.timezone,
            isPasswordProtected: true,
            isLocked: true,
            hasAccess: false,
            organizer: event.organizer,
            ticketTiers: [],
            galleryImages: [],
            features: [],
            youtubeVideoId: null,
            youtubeVideoUrl: null,
            guestCount: null,
            description: null,
            venueName: event.venueName,
            venueAddress: null,
          },
        },
      });
      return;
    }

    // Calculate available remaining tickets per tier
    const tiersWithAvailability = event.ticketTiers.map((tier) => {
      const remaining = Math.max(0, tier.totalCapacity - tier.soldQuantity - tier.reservedQuantity);
      return {
        ...tier,
        remainingCapacity: remaining,
        isAvailable: tier.status === 'ACTIVE' && remaining > 0,
      };
    });

    // Compute verified attendee count if guest count is not hidden
    let guestCount: number | null = null;
    if (!event.hideGuestCount) {
      guestCount = await prisma.ticket.count({
        where: {
          eventId: event.id,
          status: { in: [TicketStatus.ISSUED, TicketStatus.CHECKED_IN] },
          order: {
            status: OrderStatus.COMPLETED,
          },
        },
      });
    }

    const { passwordHash: _, ...eventWithoutHash } = event;

    res.json({
      success: true,
      data: {
        event: {
          ...eventWithoutHash,
          isLocked: false,
          hasAccess: true,
          guestCount,
          ticketTiers: tiersWithAvailability,
        },
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function verifyEventPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { slug } = req.params;
    const { password } = verifyEventPasswordSchema.parse(req.body);

    const event = await prisma.event.findUnique({
      where: { slug },
      select: {
        id: true,
        slug: true,
        isPasswordProtected: true,
        passwordHash: true,
      },
    });

    if (!event) {
      throw new NotFoundError(`Event with slug '${slug}' was not found`);
    }

    if (!event.isPasswordProtected || !event.passwordHash) {
      res.json({
        success: true,
        data: {
          hasAccess: true,
          message: 'Event is not password protected',
        },
      });
      return;
    }

    const clientIp =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.socket.remoteAddress ||
      req.ip ||
      'unknown';
    const rateLimitKey = `${clientIp}:${event.id}`;

    checkPasswordRateLimit(rateLimitKey);

    const isMatch = await verifyEventPasswordMatch(password, event.passwordHash);
    if (!isMatch) {
      recordFailedPasswordAttempt(rateLimitKey);
      throw new UnauthorizedError('Incorrect password');
    }

    clearPasswordRateLimit(rateLimitKey);
    const eventAccessToken = signEventAccessToken(event.id);

    res.json({
      success: true,
      data: {
        eventAccessToken,
        eventId: event.id,
        hasAccess: true,
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function getFeaturedEvents(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const events = await prisma.event.findMany({
      where: {
        status: EventStatus.PUBLISHED,
        showOnExplore: true,
        isFeatured: true,
        endAt: { gte: new Date() },
      },
      take: 4,
      orderBy: { startAt: 'asc' },
      include: {
        ticketTiers: {
          select: {
            priceInCents: true,
            currency: true,
            status: true,
          },
        },
      },
    });

    const enhanced = events.map((e) => {
      const { passwordHash: _, ...clean } = e;
      return {
        ...clean,
        minPriceInCents: clean.ticketTiers.length > 0 ? Math.min(...clean.ticketTiers.map((t) => t.priceInCents)) : 0,
        currency: clean.ticketTiers[0]?.currency || 'USD',
      };
    });

    res.json({
      success: true,
      data: { events: enhanced },
    });
  } catch (error) {
    next(error);
  }
}

export async function getCities(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const cities = await prisma.event.findMany({
      where: {
        status: EventStatus.PUBLISHED,
        showOnExplore: true,
      },
      select: { city: true },
      distinct: ['city'],
    });

    res.json({
      success: true,
      data: { cities: cities.map((c) => c.city) },
    });
  } catch (error) {
    next(error);
  }
}
