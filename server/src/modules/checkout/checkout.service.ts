import { Prisma, OrderStatus, ReservationStatus, TicketTierStatus, EventStatus, WaitlistOfferStatus, WaitlistEntryStatus } from '@prisma/client';
import { nanoid } from 'nanoid';
import { prisma } from '../../db/prisma.js';
import { stripe } from '../../lib/stripe.js';
import { env } from '../../config/env.js';
import { BadRequestError, ConflictError, NotFoundError, ForbiddenError } from '../../utils/errors.js';
import { verifyEventAccessToken } from '../events/passwordAccess.service.js';
import { hashOfferToken, processWaitlistForTier } from '../waitlist/waitlist.service.js';
import {
  calculateFinancialBreakdown,
  calculateCheckoutFeeBreakdown,
  CheckoutFeeBreakdown,
} from './checkout.financials.js';
import { CreateCheckoutSessionInput } from './checkout.schema.js';

export interface CheckoutResult {
  orderNumber: string;
  orderAccessToken: string;
  clientSecret: string;
  publishableKey?: string;
  totalInCents: number;
  currency: string;
  expiresAt: string;
  breakdown?: CheckoutFeeBreakdown;
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

  const tierQuantityMap = new Map<string, number>();
  const reservationIds: string[] = [];
  const orderIds: string[] = [];

  for (const reservation of expiredReservations) {
    reservationIds.push(reservation.id);
    orderIds.push(reservation.orderId);
    const current = tierQuantityMap.get(reservation.ticketTierId) || 0;
    tierQuantityMap.set(reservation.ticketTierId, current + reservation.quantity);
  }

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

  await prismaClient.ticketReservation.updateMany({
    where: { id: { in: reservationIds } },
    data: { status: ReservationStatus.RELEASED },
  });

  await prismaClient.order.updateMany({
    where: {
      id: { in: orderIds },
      status: OrderStatus.PENDING,
    },
    data: { status: OrderStatus.EXPIRED },
  });

  // Also expire linked waitlist offers
  const linkedExpiredOffers = await prismaClient.ticketWaitlistOffer.findMany({
    where: {
      orderId: { in: orderIds },
      status: WaitlistOfferStatus.PENDING,
    },
  });

  if (linkedExpiredOffers.length > 0) {
    const offerIds = linkedExpiredOffers.map((o) => o.id);
    const entryIds = linkedExpiredOffers.map((o) => o.entryId);

    await prismaClient.ticketWaitlistOffer.updateMany({
      where: { id: { in: offerIds } },
      data: { status: WaitlistOfferStatus.EXPIRED },
    });

    await prismaClient.ticketWaitlistEntry.updateMany({
      where: { id: { in: entryIds } },
      data: { status: WaitlistEntryStatus.EXPIRED },
    });
  }

  for (const tierId of tierQuantityMap.keys()) {
    processWaitlistForTier(tierId).catch((err) => {
      console.error(`Error advancing waitlist after releasing reservations for tier ${tierId}:`, err);
    });
  }

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
  await releaseExpiredReservations();

  const { eventId, items, customerEmail, customerName, customerPhone, idempotencyKey: clientIdempotency, offerToken } = input;

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

  if (event.isPasswordProtected) {
    if (!verifyEventAccessToken(input.eventAccessToken, event.id)) {
      throw new ForbiddenError(
        'This event is password protected. Valid access token required to checkout.'
      );
    }
  }

  // Validate waitlist offer token if provided
  let verifiedOffer: any = null;
  if (offerToken) {
    const tokenHash = hashOfferToken(offerToken);
    verifiedOffer = await prisma.ticketWaitlistOffer.findUnique({
      where: { tokenHash },
      include: { entry: true, ticketTier: true },
    });

    if (!verifiedOffer) {
      throw new BadRequestError('Invalid waitlist offer token');
    }

    if (verifiedOffer.status !== WaitlistOfferStatus.PENDING || verifiedOffer.expiresAt < now) {
      throw new BadRequestError('This waitlist offer has expired or is no longer valid');
    }

    if (verifiedOffer.entry.customerEmail.toLowerCase() !== customerEmail.trim().toLowerCase()) {
      throw new BadRequestError('Customer email does not match the waitlist offer recipient');
    }

    if (items.length !== 1 || items[0].ticketTierId !== verifiedOffer.ticketTierId) {
      throw new BadRequestError('Checkout items do not match the offered ticket tier');
    }

    if (items[0].quantity > verifiedOffer.quantity) {
      throw new BadRequestError(`Cannot purchase more tickets than offered (${verifiedOffer.quantity})`);
    }

    if (verifiedOffer.orderId) {
      const existingLinkedOrder = await prisma.order.findUnique({
        where: { id: verifiedOffer.orderId },
      });
      if (existingLinkedOrder && existingLinkedOrder.status === OrderStatus.COMPLETED) {
        throw new BadRequestError('This waitlist offer has already been completed and purchased');
      }
      if (
        existingLinkedOrder &&
        existingLinkedOrder.status === OrderStatus.PENDING &&
        existingLinkedOrder.expiresAt > now &&
        existingLinkedOrder.idempotencyKey !== (clientIdempotency || '')
      ) {
        throw new ConflictError('A checkout session is already in progress for this waitlist offer');
      }
    }
  }

  // Check idempotency if provided
  const finalIdempotencyKey = clientIdempotency || `idem_${nanoid(24)}`;
  const existingOrder = await prisma.order.findUnique({
    where: { idempotencyKey: finalIdempotencyKey },
    include: { items: { include: { ticketTier: true } } },
  });

  if (existingOrder && existingOrder.status === OrderStatus.PENDING && existingOrder.expiresAt > now) {
    if (existingOrder.paymentReference) {
      try {
        const paymentIntent = await stripe.paymentIntents.retrieve(existingOrder.paymentReference);
        if (paymentIntent && paymentIntent.client_secret) {
          return {
            orderNumber: existingOrder.orderNumber,
            orderAccessToken: existingOrder.orderAccessToken || '',
            clientSecret: paymentIntent.client_secret,
            publishableKey: env.STRIPE_PUBLISHABLE_KEY,
            totalInCents: existingOrder.totalInCents,
            currency: existingOrder.currency,
            expiresAt: existingOrder.expiresAt.toISOString(),
            breakdown: calculateCheckoutFeeBreakdown(existingOrder.items),
          };
        }
      } catch {
        // Proceed with a fresh session if retrieving the previous intent fails
      }
    }
  }

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

  // Stripe requires session expiry to be at least 30 minutes in the future.
  // 30m + 60s buffer absorbs clock skew.
  const reservationHoldMinutes = 30;
  const expiresAt = new Date(Date.now() + (reservationHoldMinutes * 60 + 60) * 1000);
  const orderNumber = `OUT-${now.getFullYear()}-${Math.floor(10000 + Math.random() * 90000)}`;
  const orderAccessToken = `oat_${nanoid(32)}`;

  let reservationResult: { order: any; feeBreakdown: CheckoutFeeBreakdown };

  try {
    reservationResult = await prisma.$transaction(
      async (tx) => {
        // Lock tier rows to prevent overselling on concurrent checkouts
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

        let ticketSubtotalInCents = 0;
        let totalTicketQuantity = 0;
        const orderItemsData = [];
        const reservationData = [];

        for (const item of items) {
          const locked = lockedMap.get(item.ticketTierId);
          if (!locked) {
            throw new BadRequestError(`Ticket tier '${item.ticketTierId}' not found`);
          }

          const isOfferItem = verifiedOffer && verifiedOffer.ticketTierId === item.ticketTierId;
          const effectiveAvailable = isOfferItem
            ? locked.totalCapacity - locked.soldQuantity - locked.reservedQuantity + verifiedOffer.quantity
            : locked.totalCapacity - locked.soldQuantity - locked.reservedQuantity;

          if (effectiveAvailable < item.quantity) {
            throw new ConflictError(
              `Insufficient ticket availability for '${locked.name}'. Requested ${item.quantity}, but only ${Math.max(0, effectiveAvailable)} remaining.`
            );
          }

          const subtotalInCents = locked.priceInCents * item.quantity;
          ticketSubtotalInCents += subtotalInCents;
          totalTicketQuantity += item.quantity;

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

          // Waitlist tickets were already held in reservedQuantity.
          // If the buyer took fewer than offered, release the difference back.
          if (isOfferItem) {
            if (item.quantity < verifiedOffer.quantity) {
              const diff = verifiedOffer.quantity - item.quantity;
              await tx.ticketTier.update({
                where: { id: item.ticketTierId },
                data: {
                  reservedQuantity: {
                    decrement: diff,
                  },
                },
              });
            }
          } else {
            await tx.ticketTier.update({
              where: { id: item.ticketTierId },
              data: {
                reservedQuantity: {
                  increment: item.quantity,
                },
              },
            });
          }
        }

        const feeBreakdown = calculateCheckoutFeeBreakdown(ticketSubtotalInCents, totalTicketQuantity);

        const order = await tx.order.create({
          data: {
            orderNumber,
            userId: authenticatedUserId || null,
            eventId: event.id,
            status: OrderStatus.PENDING,
            customerEmail,
            customerName,
            customerPhone: customerPhone || null,
            totalInCents: feeBreakdown.buyerTotalInCents,
            currency: currency.toUpperCase(),
            platformFeeInCents: feeBreakdown.buyerTotalInCents - feeBreakdown.organizerEarningsInCents,
            organizerNetInCents: feeBreakdown.organizerEarningsInCents,
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

        if (verifiedOffer) {
          await tx.ticketWaitlistOffer.update({
            where: { id: verifiedOffer.id },
            data: { orderId: order.id },
          });
        }

        return { order, feeBreakdown };
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

  const createdOrder = reservationResult.order;
  const createdFeeBreakdown = reservationResult.feeBreakdown;

  try {
    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: createdOrder.totalInCents,
        currency: createdOrder.currency.toLowerCase(),
        description: `Outside.vip Passes - ${event.title} (${createdOrder.orderNumber})`,
        metadata: {
          orderId: createdOrder.id,
          orderNumber: createdOrder.orderNumber,
          eventId: event.id,
          orderAccessToken,
          ticketSubtotalInCents: createdFeeBreakdown?.ticketSubtotalInCents.toString() || '0',
          platformFeeInCents: createdFeeBreakdown?.platformFeeInCents.toString() || '0',
          serviceFeeInCents: createdFeeBreakdown?.serviceFeeInCents.toString() || '0',
          processingFeeInCents: createdFeeBreakdown?.processingFeeInCents.toString() || '0',
        },
        receipt_email: customerEmail,
        automatic_payment_methods: {
          enabled: true,
        },
      },
      {
        idempotencyKey: `stripe_pi_${finalIdempotencyKey}`,
      }
    );

    if (!paymentIntent.client_secret) {
      throw new Error('Stripe PaymentIntent client secret missing in provider response');
    }

    await prisma.order.update({
      where: { id: createdOrder.id },
      data: { paymentReference: paymentIntent.id },
    });

    return {
      orderNumber: createdOrder.orderNumber,
      orderAccessToken,
      clientSecret: paymentIntent.client_secret,
      publishableKey: env.STRIPE_PUBLISHABLE_KEY,
      totalInCents: createdOrder.totalInCents,
      currency: createdOrder.currency,
      expiresAt: expiresAt.toISOString(),
      breakdown: createdFeeBreakdown || undefined,
    };
  } catch (stripeError) {
    console.error('Stripe PaymentIntent creation failed; initiating reservation rollback:', stripeError);

    // Roll back reservations on payment setup failure
    await prisma.$transaction(async (tx) => {
      for (const item of createdOrder.items) {
        if (!verifiedOffer || verifiedOffer.ticketTierId !== item.ticketTierId) {
          await tx.ticketTier.update({
            where: { id: item.ticketTierId },
            data: {
              reservedQuantity: {
                decrement: item.quantity,
              },
            },
          });
        } else if (item.quantity < verifiedOffer.quantity) {
          const diff = verifiedOffer.quantity - item.quantity;
          await tx.ticketTier.update({
            where: { id: item.ticketTierId },
            data: {
              reservedQuantity: {
                increment: diff,
              },
            },
          });
        }
      }

      if (verifiedOffer) {
        await tx.ticketWaitlistOffer.update({
          where: { id: verifiedOffer.id },
          data: { orderId: null },
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

    for (const item of createdOrder.items) {
      processWaitlistForTier(item.ticketTierId).catch(() => {});
    }

    throw new BadRequestError('Payment provider session creation failed. Your reservation was safely released.');
  }
}
