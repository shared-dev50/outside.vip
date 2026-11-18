import { Request, Response, NextFunction } from 'express';
import { prisma } from '../../db/prisma.js';
import { UnauthorizedError } from '../../utils/errors.js';

export async function getScannerGates(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      throw new UnauthorizedError('Authentication required to access scanner gates');
    }

    const isAdmin = user.role === 'ADMIN';
    const isOrganizer = user.role === 'ORGANIZER';

    let events: Array<{
      id: string;
      title: string;
      slug: string;
      startAt: Date;
      endAt: Date;
      venueName: string | null;
      city: string | null;
      country: string | null;
      role: 'ADMIN' | 'ORGANIZER' | 'STAFF';
    }> = [];

    if (isAdmin) {
      const dbEvents = await prisma.event.findMany({
        where: {
          status: 'PUBLISHED',
        },
        select: {
          id: true,
          title: true,
          slug: true,
          startAt: true,
          endAt: true,
          venueName: true,
          city: true,
          country: true,
        },
        orderBy: { startAt: 'asc' },
      });

      events = dbEvents.map((e) => ({ ...e, role: 'ADMIN' as const }));
    } else if (isOrganizer) {
      const [ownedEvents, staffAssignments] = await Promise.all([
        prisma.event.findMany({
          where: {
            organizerId: user.userId,
            status: 'PUBLISHED',
          },
          select: {
            id: true,
            title: true,
            slug: true,
            startAt: true,
            endAt: true,
            venueName: true,
            city: true,
            country: true,
          },
          orderBy: { startAt: 'asc' },
        }),
        prisma.eventStaff.findMany({
          where: {
            userId: user.userId,
            status: 'ACTIVE',
            event: { status: 'PUBLISHED' },
          },
          select: {
            event: {
              select: {
                id: true,
                title: true,
                slug: true,
                startAt: true,
                endAt: true,
                venueName: true,
                city: true,
                country: true,
              },
            },
          },
        }),
      ]);

      const seen = new Set<string>();
      for (const e of ownedEvents) {
        seen.add(e.id);
        events.push({ ...e, role: 'ORGANIZER' as const });
      }
      for (const s of staffAssignments) {
        if (!seen.has(s.event.id)) {
          seen.add(s.event.id);
          events.push({ ...s.event, role: 'STAFF' as const });
        }
      }
    } else {
      const staffAssignments = await prisma.eventStaff.findMany({
        where: {
          userId: user.userId,
          status: 'ACTIVE',
          event: { status: 'PUBLISHED' },
        },
        select: {
          event: {
            select: {
              id: true,
              title: true,
              slug: true,
              startAt: true,
              endAt: true,
              venueName: true,
              city: true,
              country: true,
            },
          },
        },
        orderBy: { event: { startAt: 'asc' } },
      });

      events = staffAssignments.map((s) => ({
        ...s.event,
        role: 'STAFF' as const,
      }));
    }

    res.json({
      success: true,
      data: { events },
      events,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Lightweight scanner keep-alive endpoint.
 * Requires an active authenticated session (enforced by authenticateUser & requireAuth).
 * Touches the Redis session to prevent idle timeout while scanning, without DB overhead.
 */
export async function pingScanner(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user) {
      throw new UnauthorizedError('Authentication required to access scanner');
    }

    res.json({
      success: true,
      data: {
        timestamp: Date.now(),
      },
    });
  } catch (error) {
    next(error);
  }
}


