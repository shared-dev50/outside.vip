import { Request, Response, NextFunction } from 'express';
import { prisma } from '../../db/prisma.js';
import { stripe } from '../../lib/stripe.js';
import { fulfillPaidOrder } from '../webhooks/webhook.service.js';
import { NotFoundError, ForbiddenError, UnauthorizedError } from '../../utils/errors.js';

const orderInclude = {
  event: {
    select: {
      id: true,
      slug: true,
      title: true,
      startAt: true,
      endAt: true,
      venueName: true,
      venueAddress: true,
      city: true,
      country: true,
      timezone: true,
      coverImageUrl: true,
    },
  },
  items: {
    include: {
      ticketTier: {
        select: {
          id: true,
          name: true,
          priceInCents: true,
          currency: true,
        },
      },
    },
  },
  tickets: {
    orderBy: { createdAt: 'asc' as const },
    select: {
      id: true,
      ticketToken: true,
      attendeeName: true,
      attendeeEmail: true,
      status: true,
      checkedInAt: true,
      ticketTier: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  },
};

export async function getOrderByOrderNumber(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { orderNumber } = req.params;
    const providedToken =
      (req.query.token as string | undefined) ||
      (req.headers['x-order-token'] as string | undefined);

    let order = await prisma.order.findUnique({
      where: { orderNumber },
      include: orderInclude,
    });

    if (!order) {
      throw new NotFoundError(`Order with number '${orderNumber}' not found`);
    }

    // Access authorization check:
    // 1. Valid order access token provided in query or header (guest checkout link)
    // 2. OR authenticated user who owns the order
    // 3. OR admin user
    const hasValidAccessToken =
      Boolean(order.orderAccessToken) &&
      Boolean(providedToken) &&
      providedToken === order.orderAccessToken;

    const isOwner =
      Boolean(req.user?.userId) && Boolean(order.userId) && req.user?.userId === order.userId;

    const isAdmin = req.user?.role === 'ADMIN';

    if (!hasValidAccessToken && !isOwner && !isAdmin) {
      if (!providedToken && !req.user) {
        throw new UnauthorizedError('Order access token or authentication required to view this order');
      }
      throw new ForbiddenError('You do not have permission to view details for this order');
    }

    // Resilient reconciliation fallback:
    // If order is still PENDING and has a Stripe Checkout session ID,
    // verify with Stripe whether payment completed and fulfill idempotently.
    if (order.status === 'PENDING' && order.paymentReference) {
      try {
        const session = await stripe.checkout.sessions.retrieve(order.paymentReference);
        if (session.payment_status === 'paid') {
          await fulfillPaidOrder(session);
          const refreshed = await prisma.order.findUnique({
            where: { orderNumber },
            include: orderInclude,
          });
          if (refreshed) {
            order = refreshed;
          }
        }
      } catch (err: any) {
        console.warn(`Payment reconciliation fallback failed for order ${orderNumber}:`, err.message);
      }
    }

    res.json({
      success: true,
      data: {
        order: {
          id: order.id,
          orderNumber: order.orderNumber,
          status: order.status,
          customerName: order.customerName,
          customerEmail: order.customerEmail,
          customerPhone: order.customerPhone,
          totalInCents: order.totalInCents,
          currency: order.currency,
          createdAt: order.createdAt,
          expiresAt: order.expiresAt,
          event: order.event,
          items: order.items,
          tickets: order.tickets,
        },
      },
    });
  } catch (error) {
    next(error);
  }
}
