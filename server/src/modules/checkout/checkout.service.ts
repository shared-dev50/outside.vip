import { Prisma, OrderStatus, ReservationStatus, TicketTierStatus, EventStatus } from '@prisma/client';
import { nanoid } from 'nanoid';
import { prisma } from '../../db/prisma.js';
import { stripe } from '../../lib/stripe.js';
import { env } from '../../config/env.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../utils/errors.js';
import { calculateFinancialBreakdown } from './checkout.financials.js';
import { CreateCheckoutSessionInput } from './checkout.schema.js';

export interface CheckoutResult {
  orderNumber: string;
  orderAccessToken: string;
  checkoutUrl: string;
  totalInCents: number;
  currency: string;
  expiresAt: string;
}

/**
 * Sweeps and releases expired reservations where expiresAt < now and status === ACTIVE.
 * Atomically restores reserved quantities to the tiers and marks orders EXPIRED.
 */
export async function releaseExpiredReservations(
  prismaClient: Prisma.TransactionClient = prisma
): Promise<number> {
  const now = new Date();

  const expiredReservations = await prismaClient.ticketReservation.findMany({
    where: {
      status: ReservationStatus.ACTIVE,
      expiresAt: { lt: now },
    },
    include: {
      order: true,
    },
  });

  if (expiredReservations.length === 0) {
    return 0;
  }

  // Group released quantities by ticket tier
  const tierQuantityMap = new Map<string, number>();
  const reservationIds: string[] = [];
  const orderIds: string[] = [];

  for (const reservation of expiredReservations) {
    reservationIds.push(reservation.id);
    orderIds.push(reservation.orderId);
    const current = tierQuantityMap.get(reservation.ticketTierId) || 0;
    tierQuantityMap.set(reservation.ticketTierId, current + reservation.quantity);
  }

  // Restore inventory on tiers
  for (const [tierId, qty] of tierQuantityMap.entries()) {
    await prismaClient.ticketTier.update({
      where: { id: tierId },
      data: {
        reservedQuantity: {
          decrement: qty,
        },
      },
    });
  }

  // Mark reservations as RELEASED
  await prismaClient.ticketReservation.updateMany({
    where: { id: { in: reservationIds } },
    data: { status: ReservationStatus.RELEASED },
  });

  // Mark pending orders as EXPIRED
  await prismaClient.order.updateMany({
    where: {
      id: { in: orderIds },
      status: OrderStatus.PENDING,
    },
    data: { status: OrderStatus.EXPIRED },
  });

  return expiredReservations.length;
}

/**
 * Creates an atomic ticket reservation, creates the PENDING Order record,
 * and initializes a hosted Stripe Checkout Session.
 */
export async function createCheckoutSession(
  input: CreateCheckoutSessionInput,
  authenticatedUserId?: string
): Promise<CheckoutResult> {
  // 1. Release any expired holds so inventory is fresh
  await releaseExpiredReservations();

  const { eventId, items, customerEmail, customerName, customerPhone, idempotencyKey: clientIdempotency } = input;

  // 2. Fetch event and validate status
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    include: {
      ticketTiers: true,
    },
  });

  if (!event) {
    throw new NotFoundError('Event not found');
  }

  if (event.status !== EventStatus.PUBLISHED) {
    throw new BadRequestError('Tickets can only be purchased for published events');
  }

  const now = new Date();
  if (event.endAt < now) {
    throw new BadRequestError('This event has already concluded');
  }

  // Check idempotency if provided
  const finalIdempotencyKey = clientIdempotency || `idem_${nanoid(24)}`;
  const existingOrder = await prisma.order.findUnique({
    where: { idempotencyKey: finalIdempotencyKey },
    include: { items: { include: { ticketTier: true } } },
  });

  if (existingOrder && existingOrder.status === OrderStatus.PENDING && existingOrder.expiresAt > now) {
    // If a session was already created, retrieve it or return its URL
    if (existingOrder.paymentReference) {
      try {
        const session = await stripe.checkout.sessions.retrieve(existingOrder.paymentReference);
        if (session && session.url) {
          return {
            orderNumber: existingOrder.orderNumber,
            orderAccessToken: existingOrder.orderAccessToken || '',
            checkoutUrl: session.url,
            totalInCents: existingOrder.totalInCents,
            currency: existingOrder.currency,
            expiresAt: existingOrder.expiresAt.toISOString(),
          };
        }
      } catch {
        // If retrieve fails, proceed to generate new session
      }
    }
  }

  // 3. Validate requested items against event ticket tiers
  const requestedTierMap = new Map<string, number>();
  for (const item of items) {
    if (requestedTierMap.has(item.ticketTierId)) {
      throw new BadRequestError('Duplicate ticket tier specified in checkout request');
    }
    requestedTierMap.set(item.ticketTierId, item.quantity);
  }

  const tierIds = Array.from(requestedTierMap.keys());
  const foundTiers = event.ticketTiers.filter((t) => requestedTierMap.has(t.id));

  if (foundTiers.length !== tierIds.length) {
    throw new BadRequestError('One or more selected ticket tiers do not belong to this event');
  }

  for (const tier of foundTiers) {
    const qty = requestedTierMap.get(tier.id)!;

    if (tier.status !== TicketTierStatus.ACTIVE) {
      throw new BadRequestError(`Ticket tier '${tier.name}' is currently unavailable for purchase`);
    }

    if (tier.salesStartAt && tier.salesStartAt > now) {
      throw new BadRequestError(`Sales for '${tier.name}' have not started yet`);
    }

    if (tier.salesEndAt && tier.salesEndAt < now) {
      throw new BadRequestError(`Sales for '${tier.name}' have concluded`);
    }

    if (qty < tier.minPerOrder) {
      throw new BadRequestError(
        `Minimum purchase for '${tier.name}' is ${tier.minPerOrder} ticket(s)`
      );
    }

    if (qty > tier.maxPerOrder) {
      throw new BadRequestError(
        `Maximum purchase for '${tier.name}' is ${tier.maxPerOrder} tickets per order`
      );
    }
  }

  const currency = foundTiers[0].currency;
  if (!foundTiers.every((t) => t.currency.toUpperCase() === currency.toUpperCase())) {
    throw new BadRequestError('All ticket tiers in a single checkout must share the same currency');
  }

  // 4. Atomic PostgreSQL Transaction with row-level locking
  // Stripe requires Checkout Session expires_at to be at least 30 minutes in the future.
  // We use 30 minutes + 60s buffer (31 minutes / 1860s) to safely exceed the minimum and absorb clock skew.
  const reservationHoldMinutes = 30;
  const expiresAt = new Date(Date.now() + (reservationHoldMinutes * 60 + 60) * 1000);
  const orderNumber = `OUT-${now.getFullYear()}-${Math.floor(10000 + Math.random() * 90000)}`;
  const orderAccessToken = `oat_${nanoid(32)}`;

  let createdOrder: any = null;

  try {
    createdOrder = await prisma.$transaction(
      async (tx) => {
        // Lock the requested tier rows for update
        const lockedTiers = await tx.$queryRaw<
          Array<{
            id: string;
            totalCapacity: number;
            soldQuantity: number;
            reservedQuantity: number;
            priceInCents: number;
            currency: string;
            name: string;
          }>
        >`
          SELECT id, "totalCapacity", "soldQuantity", "reservedQuantity", "priceInCents", currency, name
          FROM "TicketTier"
          WHERE id = ANY(${tierIds})
          FOR UPDATE
        `;

        const lockedMap = new Map(lockedTiers.map((t) => [t.id, t]));

        // Calculate verified total strictly from database prices
        let totalInCents = 0;
        const orderItemsData = [];
        const reservationData = [];

        for (const item of items) {
          const locked = lockedMap.get(item.ticketTierId);
          if (!locked) {
            throw new BadRequestError(`Ticket tier '${item.ticketTierId}' not found`);
          }

          const available = locked.totalCapacity - locked.soldQuantity - locked.reservedQuantity;
          if (available < item.quantity) {
            throw new ConflictError(
              `Insufficient ticket availability for '${locked.name}'. Requested ${item.quantity}, but only ${Math.max(0, available)} remaining.`
            );
          }

          const subtotalInCents = locked.priceInCents * item.quantity;
          totalInCents += subtotalInCents;

          orderItemsData.push({
            ticketTierId: item.ticketTierId,
            quantity: item.quantity,
            unitPriceInCents: locked.priceInCents,
            subtotalInCents,
          });

          reservationData.push({
            ticketTierId: item.ticketTierId,
            quantity: item.quantity,
            expiresAt,
            status: ReservationStatus.ACTIVE,
          });

          // Atomically increment reserved quantity on tier
          await tx.ticketTier.update({
            where: { id: item.ticketTierId },
            data: {
              reservedQuantity: {
                increment: item.quantity,
              },
            },
          });
        }

        // Calculate financial breakdown
        const financials = calculateFinancialBreakdown(totalInCents);

        // Create the pending order record
        const order = await tx.order.create({
          data: {
            orderNumber,
            userId: authenticatedUserId || null,
            eventId: event.id,
            status: OrderStatus.PENDING,
            customerEmail,
            customerName,
            customerPhone: customerPhone || null,
            totalInCents,
            currency: currency.toUpperCase(),
            platformFeeInCents: financials.platformFeeInCents,
            organizerNetInCents: financials.organizerNetInCents,
            orderAccessToken,
            idempotencyKey: finalIdempotencyKey,
            expiresAt,
            items: {
              create: orderItemsData,
            },
            reservations: {
              create: reservationData,
            },
          },
          include: {
            items: {
              include: { ticketTier: true },
            },
          },
        });

        return order;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        timeout: 10000,
      }
    );
  } catch (error) {
    if (error instanceof ConflictError || error instanceof BadRequestError) {
      throw error;
    }
    console.error('Reservation transaction failed:', error);
    throw new BadRequestError('Could not secure ticket reservation. Please try again.');
  }

  // 5. Create Stripe Checkout Session
  try {
    const lineItems = createdOrder.items.map((item: any) => ({
      price_data: {
        currency: createdOrder.currency.toLowerCase(),
        unit_amount: item.unitPriceInCents,
        product_data: {
          name: `${event.title} · ${item.ticketTier.name}`,
          description: item.ticketTier.description || `Ticket pass for ${event.title}`,
        },
      },
      quantity: item.quantity,
    }));

    // Expire Stripe session when database reservation expires
    const stripeExpiresAt = Math.floor(expiresAt.getTime() / 1000);

    const session = await stripe.checkout.sessions.create(
      {
        mode: 'payment',
        customer_email: customerEmail,
        client_reference_id: createdOrder.id,
        line_items: lineItems,
        metadata: {
          orderId: createdOrder.id,
          orderNumber: createdOrder.orderNumber,
          eventId: event.id,
          orderAccessToken,
        },
        success_url: `${env.CLIENT_URL}/orders/${createdOrder.orderNumber}?token=${orderAccessToken}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${env.CLIENT_URL}/events/${event.slug}?checkout=cancelled&orderNumber=${createdOrder.orderNumber}`,
        expires_at: stripeExpiresAt,
      },
      {
        idempotencyKey: `stripe_sess_${finalIdempotencyKey}`,
      }
    );

    if (!session.url) {
      throw new Error('Stripe Checkout session URL missing in provider response');
    }

    // Attach Stripe session ID to order
    await prisma.order.update({
      where: { id: createdOrder.id },
      data: { paymentReference: session.id },
    });

    return {
      orderNumber: createdOrder.orderNumber,
      orderAccessToken,
      checkoutUrl: session.url,
      totalInCents: createdOrder.totalInCents,
      currency: createdOrder.currency,
      expiresAt: expiresAt.toISOString(),
    };
  } catch (stripeError) {
    console.error('Stripe session creation failed; initiating reservation rollback:', stripeError);

    // Rollback reservation atomically so stock is not locked up
    await prisma.$transaction(async (tx) => {
      for (const item of createdOrder.items) {
        await tx.ticketTier.update({
          where: { id: item.ticketTierId },
          data: {
            reservedQuantity: {
              decrement: item.quantity,
            },
          },
        });
      }

      await tx.ticketReservation.updateMany({
        where: { orderId: createdOrder.id },
        data: { status: ReservationStatus.RELEASED },
      });

      await tx.order.update({
        where: { id: createdOrder.id },
        data: { status: OrderStatus.CANCELLED },
      });
    });

    throw new BadRequestError('Payment provider session creation failed. Your reservation was safely released.');
  }
}
