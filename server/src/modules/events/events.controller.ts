import { Request, Response, NextFunction } from 'express';
import { EventStatus, Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { listEventsQuerySchema } from './events.schema.js';
import { NotFoundError } from '../../utils/errors.js';

export async function listEvents(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = listEventsQuerySchema.parse(req.query);
    const { search, category, city, featuredOnly, timeFilter, page, limit } = query;

    const where: Prisma.EventWhereInput = {
      status: EventStatus.PUBLISHED,
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

    const [events, total] = await Promise.all([
      prisma.event.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ isFeatured: 'desc' }, { startAt: 'asc' }],
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

    // Enhance events with lowest price and availability status
    const enhancedEvents = events.map((event) => {
      const activeTiers = event.ticketTiers.filter((t) => t.status === 'ACTIVE');
      const minPrice =
        event.ticketTiers.length > 0
          ? Math.min(...event.ticketTiers.map((t) => t.priceInCents))
          : 0;

      const currency = event.ticketTiers[0]?.currency || 'USD';
      const isSoldOut = event.ticketTiers.every(
        (t) => t.status === 'SOLD_OUT' || t.soldQuantity >= t.totalCapacity
      );

      return {
        ...event,
        minPriceInCents: minPrice,
        currency,
        isSoldOut,
        tierCount: event.ticketTiers.length,
      };
    });

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
          },
        },
      },
    });

    if (!event) {
      throw new NotFoundError(`Event with slug '${slug}' was not found`);
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

    res.json({
      success: true,
      data: {
        event: {
          ...event,
          ticketTiers: tiersWithAvailability,
        },
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

    const enhanced = events.map((e) => ({
      ...e,
      minPriceInCents: e.ticketTiers.length > 0 ? Math.min(...e.ticketTiers.map((t) => t.priceInCents)) : 0,
      currency: e.ticketTiers[0]?.currency || 'USD',
    }));

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
      where: { status: EventStatus.PUBLISHED },
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
