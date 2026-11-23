import { Request, Response, NextFunction } from 'express';
import { prisma } from '../../db/prisma.js';
import {
  joinWaitlist,
  lookupWaitlistOffer,
  declineWaitlistOffer,
  getOrganizerWaitlist,
} from './waitlist.service.js';
import { runWaitlistMaintenancePass } from './waitlistWorker.js';
import { joinWaitlistSchema } from './waitlist.schema.js';
import { NotFoundError, ForbiddenError } from '../../utils/errors.js';
import { verifyEventAccessToken } from '../events/passwordAccess.service.js';

export async function handleJoinWaitlist(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { slug } = req.params;
    const input = joinWaitlistSchema.parse(req.body);

    const event = await prisma.event.findUnique({
      where: { slug },
      select: {
        id: true,
        slug: true,
        isPasswordProtected: true,
        status: true,
      },
    });

    if (!event) {
      throw new NotFoundError(`Event with slug '${slug}' was not found`);
    }

    if (event.isPasswordProtected) {
      const accessToken =
        (req.headers['x-event-access-token'] as string) ||
        (req.headers.authorization?.startsWith('Bearer ')
          ? req.headers.authorization.substring(7)
          : undefined);

      const hasAccess = accessToken
        ? verifyEventAccessToken(accessToken, event.id)
        : false;

      if (!hasAccess) {
        throw new ForbiddenError(
          'This event is password protected. Please unlock the event before joining the waitlist.'
        );
      }
    }

    const result = await joinWaitlist({
      eventId: event.id,
      ticketTierId: input.ticketTierId,
      customerName: input.customerName,
      customerEmail: input.customerEmail,
      customerPhone: input.customerPhone,
      quantity: input.quantity,
    });

    res.status(201).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

export async function handleLookupWaitlistOffer(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { token } = req.params;
    const result = await lookupWaitlistOffer(token);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

export async function handleDeclineWaitlistOffer(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { token } = req.params;
    const result = await declineWaitlistOffer(token);

    res.json({
      success: true,
      message: result.message,
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

export async function handleWaitlistMaintenance(
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const result = await runWaitlistMaintenancePass();
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

export async function handleGetOrganizerWaitlist(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id: eventId } = req.params;
    const { ticketTierId } = req.query;
    const organizerId = req.user!.userId;

    const result = await getOrganizerWaitlist(
      eventId,
      organizerId,
      typeof ticketTierId === 'string' ? ticketTierId : undefined
    );

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
}
