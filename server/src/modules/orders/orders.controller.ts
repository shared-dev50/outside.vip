import { Request, Response, NextFunction } from 'express';
import { prisma } from '../../db/prisma.js';
import { stripe } from '../../lib/stripe.js';
import { fulfillPaidOrder } from '../webhooks/webhook.service.js';
import { NotFoundError, ForbiddenError, UnauthorizedError, BadRequestError } from '../../utils/errors.js';
import { generateTicketsPdf } from './ticketPdf.service.js';

const orderInclude = {
  event: {
    select: {
      id: true,
      slug: true,
      title: true,
      tagline: true,
      description: true,
      category: true,
      startAt: true,
      endAt: true,
      venueName: true,
      venueAddress: true,
      city: true,
      country: true,
      timezone: true,
      ageRestriction: true,
      coverImageUrl: true,
      organizerId: true,
      organizer: {
        select: {
          name: true,
          organizer: {
            select: {
              displayName: true,
            },
          },
        },
      },
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
          description: true,
          priceInCents: true,
          currency: true,
        },
      },
    },
  },
};

/**
 * Common order loader with reconciliation and strict access authorization.
 */
async function fetchAndAuthorizeOrder(req: Request, orderNumber: string) {
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
  // 4. OR organizer of the event
  const hasValidAccessToken =
    Boolean(order.orderAccessToken) &&
    Boolean(providedToken) &&
    providedToken === order.orderAccessToken;

  const isOwner =
    Boolean(req.user?.userId) && Boolean(order.userId) && req.user?.userId === order.userId;

  const isAdmin = req.user?.role === 'ADMIN';

  const isOrganizer =
    req.user?.role === 'ORGANIZER' && order.event?.organizerId === req.user?.userId;

  if (!hasValidAccessToken && !isOwner && !isAdmin && !isOrganizer) {
    if (!providedToken && !req.user) {
      throw new UnauthorizedError('Order access token or authentication required to access this order');
    }
    throw new ForbiddenError('You do not have permission to access details for this order');
  }

  // Resilient reconciliation fallback:
  // If order is still PENDING and has a Stripe PaymentIntent ID,
  // verify with Stripe whether payment completed and fulfill idempotently.
  if (order.status === 'PENDING' && order.paymentReference) {
    try {
      const paymentIntent = await stripe.paymentIntents.retrieve(order.paymentReference);
      if (paymentIntent.status === 'succeeded') {
        await fulfillPaidOrder(paymentIntent);
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

  return order;
}

export async function getOrderByOrderNumber(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { orderNumber } = req.params;
    const order = await fetchAndAuthorizeOrder(req, orderNumber);

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
          platformFeeInCents: order.platformFeeInCents,
          organizerNetInCents: order.organizerNetInCents,
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

/**
 * Stream/Download PDF for all tickets in the order (or a specific ticket if ticketId is passed).
 */
export async function downloadOrderTicketsPdf(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { orderNumber } = req.params;
    const specificTicketId = (req.query.ticketId as string | undefined) || (req.params.ticketId as string | undefined);

    const order = await fetchAndAuthorizeOrder(req, orderNumber);

    // Verify order is paid / completed before releasing tickets
    if (order.status !== 'COMPLETED') {
      throw new BadRequestError(
        `Tickets are only downloadable for confirmed and paid orders. Current order status: ${order.status}`
      );
    }

    if (!order.tickets || order.tickets.length === 0) {
      throw new NotFoundError('No issued tickets found for this order.');
    }

    if (specificTicketId) {
      const exists = order.tickets.some((t) => t.id === specificTicketId);
      if (!exists) {
        throw new NotFoundError(`Ticket '${specificTicketId}' not found in order ${orderNumber}`);
      }
    }

    const pdfBuffer = await generateTicketsPdf(order as any, specificTicketId);

    const safeTitle = (order.event?.title || 'event')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 35);

    const filename = specificTicketId
      ? `outside-ticket-${safeTitle}-${order.orderNumber}.pdf`
      : `outside-passes-${safeTitle}-${order.orderNumber}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');

    res.send(pdfBuffer);
  } catch (error) {
    next(error);
  }
}

/**
 * Stream/Download PDF for a single specific ticket.
 */
export async function downloadSingleTicketPdf(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  return downloadOrderTicketsPdf(req, res, next);
}
