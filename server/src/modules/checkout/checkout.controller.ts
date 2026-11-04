import { Request, Response, NextFunction } from 'express';
import { createCheckoutSessionSchema } from './checkout.schema.js';
import { createCheckoutSession, releaseExpiredReservations } from './checkout.service.js';

export async function handleCreateCheckoutSession(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const headerToken = req.headers['x-event-access-token'] as string | undefined;
    const input = createCheckoutSessionSchema.parse({
      ...req.body,
      eventAccessToken: req.body.eventAccessToken || headerToken,
    });
    const userId = req.user?.userId;

    const result = await createCheckoutSession(input, userId);

    res.status(201).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

export async function handleCleanupReservations(
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const releasedCount = await releaseExpiredReservations();
    res.json({
      success: true,
      data: { releasedCount },
    });
  } catch (error) {
    next(error);
  }
}
