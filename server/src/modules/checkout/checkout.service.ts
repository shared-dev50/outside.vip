import { Prisma, OrderStatus, ReservationStatus, TicketTierStatus, EventStatus, WaitlistOfferStatus, WaitlistEntryStatus } from '@prisma/client';
import { nanoid } from 'nanoid';
import { prisma } from '../../db/prisma.js';
import { stripe } from '../../lib/stripe.js';
import { env } from '../../config/env.js';
import { BadRequestError, ConflictError, NotFoundError, ForbiddenError } from '../../utils/errors.js';
import { isTicketTierHidden, isTicketTierSalesDisabled } from '../../utils/ticketTierState.js';
import { verifyEventAccessToken } from '../events/passwordAccess.service.js';
import { hashOfferToken, processWaitlistForTier } from '../waitlist/waitlist.service.js';
import { isSupportedPlatformCurrency } from '../finance/stripeCountries.js';
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

export const DEFAULT_RESERVATION_EXPIRY_BATCH_SIZE = 50;

interface ExpiredReservationBatchResult {
  claimedOrderCount: number;
  releasedReservationCount: number;
  releasedTierIds: string[];
}

async function releaseExpiredReservationBatch(
  tx: Prisma.TransactionClient,
  batchSize: number
): Promise<ExpiredReservationBatchResult> {
  // Pass UTC Date parameter matching Prisma's TIMESTAMP(3) UTC column storage
  const now = new Date();

  // Canonical Lock Hierarchy:
  // Order (FOR UPDATE SKIP LOCKED) -> TicketReservation (FOR UPDATE) ->
  // TicketWaitlistOffer (FOR UPDATE) -> TicketTier (sorted id ASC FOR UPDATE)
  const lockedOrders = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT o.id
    FROM "Order" o
    WHERE o.status = 'PENDING'::"OrderStatus"
      AND EXISTS (
        SELECT 1
        FROM "TicketReservation" r
        WHERE r."orderId" = o.id
          AND r.status = 'ACTIVE'::"ReservationStatus"
          AND r."expiresAt" < (${now}::timestamptz AT TIME ZONE 'UTC')
      )
    ORDER BY o."expiresAt" ASC, o.id ASC
    LIMIT ${batchSize}
    FOR UPDATE OF o SKIP LOCKED
  `;

  if (lockedOrders.length === 0) {
    return {
      claimedOrderCount: 0,
      releasedReservationCount: 0,
      releasedTierIds: [],
    };
  }

  const lockedOrderIds = lockedOrders.map((o) => o.id);

  const lockedReservations = await tx.$queryRaw<
    Array<{
      id: string;
      orderId: string;
      ticketTierId: string;
      quantity: number;
    }>
  >`
    SELECT r.id, r."orderId", r."ticketTierId", r.quantity
    FROM "TicketReservation" r
    WHERE r."orderId" = ANY(${lockedOrderIds})
      AND r.status = 'ACTIVE'::"ReservationStatus"
      AND r."expiresAt" < (${now}::timestamptz AT TIME ZONE 'UTC')
    ORDER BY r.id ASC
    FOR UPDATE
  `;

  if (lockedReservations.length === 0) {
    return {
      claimedOrderCount: lockedOrders.length,
      releasedReservationCount: 0,
      releasedTierIds: [],
    };
  }

  const reservationIds = lockedReservations.map((r) => r.id);
  const affectedOrderIds = Array.from(new Set(lockedReservations.map((r) => r.orderId)));
  const tierQuantityMap = new Map<string, number>();

  for (const reservation of lockedReservations) {
    tierQuantityMap.set(
      reservation.ticketTierId,
      (tierQuantityMap.get(reservation.ticketTierId) || 0) + reservation.quantity
    );
  }

  const linkedPendingOffers = await tx.$queryRaw<
    Array<{ id: string; entryId: string }>
  >`
    SELECT id, "entryId"
    FROM "TicketWaitlistOffer"
    WHERE "orderId" = ANY(${affectedOrderIds})
      AND status = 'PENDING'::"WaitlistOfferStatus"
    ORDER BY id ASC
    FOR UPDATE
  `;

  const sortedTierIds = Array.from(tierQuantityMap.keys()).sort();
  if (sortedTierIds.length > 0) {
    const lockedTiers = await tx.$queryRaw<
      Array<{ id: string; reservedQuantity: number }>
    >`
      SELECT id, "reservedQuantity"
      FROM "TicketTier"
      WHERE id = ANY(${sortedTierIds})
      ORDER BY id ASC
      FOR UPDATE
    `;

    const lockedTierMap = new Map(lockedTiers.map((t) => [t.id, t]));
    for (const tierId of sortedTierIds) {
      const releaseQty = tierQuantityMap.get(tierId) || 0;
      const lockedTier = lockedTierMap.get(tierId);
      if (!lockedTier || releaseQty <= 0) continue;

      const nextReserved = Math.max(0, lockedTier.reservedQuantity - releaseQty);
      if (lockedTier.reservedQuantity < releaseQty) {
        console.warn(
          `[ReservationExpiry] Clamping reservedQuantity for tier ${tierId}: had ${lockedTier.reservedQuantity}, releasing ${releaseQty}`
        );
      }

      await tx.ticketTier.update({
        where: { id: tierId },
        data: { reservedQuantity: nextReserved },
      });
    }
  }

  const releasedResult = await tx.ticketReservation.updateMany({
    where: {
      id: { in: reservationIds },
      status: ReservationStatus.ACTIVE,
    },
    data: { status: ReservationStatus.RELEASED },
  });

  // Only mark orders EXPIRED if they remain PENDING and have no active reservations left
  const remainingActiveOrders = await tx.ticketReservation.findMany({
    where: {
      orderId: { in: affectedOrderIds },
      status: ReservationStatus.ACTIVE,
    },
    select: { orderId: true },
  });
  const stillActiveOrderIds = new Set(remainingActiveOrders.map((r) => r.orderId));
  const ordersToExpire = affectedOrderIds.filter((id) => !stillActiveOrderIds.has(id));

  if (ordersToExpire.length > 0) {
    await tx.order.updateMany({
      where: {
        id: { in: ordersToExpire },
        status: OrderStatus.PENDING,
      },
      data: { status: OrderStatus.EXPIRED },
    });
  }

  if (linkedPendingOffers.length > 0) {
    const offerIds = linkedPendingOffers.map((o) => o.id);
    const entryIds = Array.from(new Set(linkedPendingOffers.map((o) => o.entryId)));

    await tx.ticketWaitlistOffer.updateMany({
      where: {
        id: { in: offerIds },
        status: WaitlistOfferStatus.PENDING,
      },
      data: { status: WaitlistOfferStatus.EXPIRED },
    });

    await tx.ticketWaitlistEntry.updateMany({
      where: {
        id: { in: entryIds },
        status: WaitlistEntryStatus.OFFERED,
      },
      data: { status: WaitlistEntryStatus.EXPIRED },
    });
  }

  return {
    claimedOrderCount: lockedOrders.length,
    releasedReservationCount: releasedResult.count,
    releasedTierIds: sortedTierIds,
  };
}

/**
 * Atomically sweeps and releases expired ACTIVE reservations belonging to PENDING orders
 * in bounded PostgreSQL transactions using FOR UPDATE SKIP LOCKED.
 * Loops until all claimable batches are drained and advances waitlists strictly post-commit.
 */
export async function releaseExpiredReservations(
  txClientOrOptions?: Prisma.TransactionClient | { batchSize?: number },
  options?: { batchSize?: number }
): Promise<number> {
  const isExternalTx = Boolean(
    txClientOrOptions &&
      typeof txClientOrOptions === 'object' &&
      '$queryRaw' in txClientOrOptions
  );
  const resolvedOptions = isExternalTx ? options : (txClientOrOptions as { batchSize?: number } | undefined);
  const batchSize = Math.max(
    1,
    Math.min(resolvedOptions?.batchSize ?? DEFAULT_RESERVATION_EXPIRY_BATCH_SIZE, 200)
  );

  let totalReleased = 0;
  const affectedTierIds = new Set<string>();

  if (isExternalTx) {
    const externalTx = txClientOrOptions as Prisma.TransactionClient;
    let batchResult: ExpiredReservationBatchResult;
    do {
      batchResult = await releaseExpiredReservationBatch(externalTx, batchSize);
      totalReleased += batchResult.releasedReservationCount;
      for (const tierId of batchResult.releasedTierIds) {
        affectedTierIds.add(tierId);
      }
    } while (batchResult.claimedOrderCount === batchSize);

    return totalReleased;
  }

  let batchResult: ExpiredReservationBatchResult;
  do {
    batchResult = await prisma.$transaction(
      async (tx) => releaseExpiredReservationBatch(tx, batchSize),
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        timeout: 10000,
      }
    );
    totalReleased += batchResult.releasedReservationCount;
    for (const tierId of batchResult.releasedTierIds) {
      affectedTierIds.add(tierId);
    }
  } while (batchResult.claimedOrderCount === batchSize);

  for (const tierId of Array.from(affectedTierIds).sort()) {
    await processWaitlistForTier(tierId).catch((err) => {
      console.error(`Error advancing waitlist after releasing reservations for tier ${tierId}:`, err);
    });
  }

  return totalReleased;
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

  const {
    eventId,
    items,
    customerEmail,
    customerName,
    customerPhone,
    idempotencyKey: clientIdempotency,
    offerToken,
    marketingConsent,
  } = input;

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
    if (!verifyEventAccessToken(input.eventAccessToken, event.id, event.passwordHash)) {
      throw new ForbiddenError(
        'This event is password protected. Valid access token required to checkout.'
      );
    }
  }

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

    if (isTicketTierHidden(tier)) {
      throw new BadRequestError(`Ticket tier '${tier.name}' is currently unavailable for purchase`);
    }

    if (isTicketTierSalesDisabled(tier)) {
      throw new BadRequestError(`Sales for '${tier.name}' are currently disabled`);
    }

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

  const currency = foundTiers[0].currency.toUpperCase();
  if (!foundTiers.every((t) => t.currency.toUpperCase() === currency)) {
    throw new BadRequestError('All ticket tiers in a single checkout must share the same currency');
  }
  if (!isSupportedPlatformCurrency(currency)) {
    throw new BadRequestError(
      `Unsupported ticket currency '${currency}'. Only USD purchases are currently supported.`,
      'UNSUPPORTED_CURRENCY'
    );
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
        // Lock waitlist offer BEFORE TicketTier to maintain canonical lock order:
        // TicketWaitlistOffer -> TicketTier (sorted id ASC)
        if (verifiedOffer) {
          const lockedOffers = await tx.$queryRaw<
            Array<{
              id: string;
              status: WaitlistOfferStatus;
              expiresAt: Date;
              orderId: string | null;
            }>
          >`
            SELECT id, status, "expiresAt", "orderId"
            FROM "TicketWaitlistOffer"
            WHERE id = ${verifiedOffer.id}
            FOR UPDATE
          `;
          const lockedOffer = lockedOffers[0];
          const lockNow = new Date();
          if (
            !lockedOffer ||
            lockedOffer.status !== WaitlistOfferStatus.PENDING ||
            lockedOffer.expiresAt < lockNow
          ) {
            throw new BadRequestError('This waitlist offer has expired or is no longer valid');
          }
          if (lockedOffer.orderId) {
            const linkedOrder = await tx.order.findUnique({
              where: { id: lockedOffer.orderId },
              select: { status: true, expiresAt: true, idempotencyKey: true },
            });
            if (linkedOrder && linkedOrder.status === OrderStatus.COMPLETED) {
              throw new BadRequestError('This waitlist offer has already been completed and purchased');
            }
            if (
              linkedOrder &&
              linkedOrder.status === OrderStatus.PENDING &&
              linkedOrder.expiresAt > lockNow &&
              linkedOrder.idempotencyKey !== (clientIdempotency || '')
            ) {
              throw new ConflictError('A checkout session is already in progress for this waitlist offer');
            }
          }
        }

        // Lock tier rows in deterministic ID order to prevent overselling and deadlocks
        const lockedTiers = await tx.$queryRaw<
          Array<{
            id: string;
            totalCapacity: number;
            soldQuantity: number;
            reservedQuantity: number;
            priceInCents: number;
            currency: string;
            name: string;
            status: TicketTierStatus;
            isHidden: boolean;
            salesDisabled: boolean;
          }>
        >`
          SELECT id, "totalCapacity", "soldQuantity", "reservedQuantity", "priceInCents", currency, name, status, "isHidden", "salesDisabled"
          FROM "TicketTier"
          WHERE id = ANY(${tierIds})
          ORDER BY id ASC
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

          if (isTicketTierHidden(locked)) {
            throw new BadRequestError(`Ticket tier '${locked.name}' is currently unavailable for purchase`);
          }

          if (isTicketTierSalesDisabled(locked)) {
            throw new BadRequestError(`Sales for '${locked.name}' are currently disabled`);
          }

          if (locked.status !== TicketTierStatus.ACTIVE) {
            throw new BadRequestError(`Ticket tier '${locked.name}' is currently unavailable for purchase`);
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
            marketingConsent: Boolean(marketingConsent),
            marketingConsentAt: marketingConsent ? new Date() : null,
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

    // Roll back reservations on payment setup failure using canonical lock order:
    // Order (FOR UPDATE) -> TicketReservation (ACTIVE FOR UPDATE) -> TicketWaitlistOffer (FOR UPDATE) -> TicketTier (sorted id ASC FOR UPDATE)
    const rollbackResult = await prisma.$transaction(async (tx) => {
      const lockedOrders = await tx.$queryRaw<
        Array<{ id: string; status: OrderStatus }>
      >`
        SELECT id, status
        FROM "Order"
        WHERE id = ${createdOrder.id}
        FOR UPDATE
      `;
      const lockedOrder = lockedOrders[0];
      if (!lockedOrder || lockedOrder.status !== OrderStatus.PENDING) {
        return { cancelled: false, releasedTierIds: [] as string[] };
      }

      const activeReservations = await tx.$queryRaw<
        Array<{ id: string; ticketTierId: string; quantity: number }>
      >`
        SELECT id, "ticketTierId", quantity
        FROM "TicketReservation"
        WHERE "orderId" = ${createdOrder.id}
          AND status = 'ACTIVE'::"ReservationStatus"
        ORDER BY id ASC
        FOR UPDATE
      `;

      let restoredOfferToUnlinked = false;
      if (verifiedOffer) {
        const lockedOffers = await tx.$queryRaw<
          Array<{ id: string; status: WaitlistOfferStatus; orderId: string | null }>
        >`
          SELECT id, status, "orderId"
          FROM "TicketWaitlistOffer"
          WHERE id = ${verifiedOffer.id}
          FOR UPDATE
        `;
        const lockedOffer = lockedOffers[0];
        if (
          lockedOffer &&
          lockedOffer.status === WaitlistOfferStatus.PENDING &&
          lockedOffer.orderId === createdOrder.id
        ) {
          await tx.ticketWaitlistOffer.updateMany({
            where: {
              id: verifiedOffer.id,
              status: WaitlistOfferStatus.PENDING,
              orderId: createdOrder.id,
            },
            data: { orderId: null },
          });
          restoredOfferToUnlinked = true;
        }
      }

      // Compute signed delta to apply to TicketTier.reservedQuantity per tier (negative = release, positive = restore waitlist hold difference)
      const tierDeltaMap = new Map<string, number>();
      const releasedTierSet = new Set<string>();

      for (const res of activeReservations) {
        if (!verifiedOffer || verifiedOffer.ticketTierId !== res.ticketTierId) {
          tierDeltaMap.set(res.ticketTierId, (tierDeltaMap.get(res.ticketTierId) || 0) - res.quantity);
          releasedTierSet.add(res.ticketTierId);
        } else if (restoredOfferToUnlinked) {
          if (res.quantity < verifiedOffer.quantity) {
            const diff = verifiedOffer.quantity - res.quantity;
            tierDeltaMap.set(res.ticketTierId, (tierDeltaMap.get(res.ticketTierId) || 0) + diff);
          }
        } else {
          tierDeltaMap.set(res.ticketTierId, (tierDeltaMap.get(res.ticketTierId) || 0) - res.quantity);
          releasedTierSet.add(res.ticketTierId);
        }
      }

      const sortedTierIds = Array.from(tierDeltaMap.keys()).sort();
      if (sortedTierIds.length > 0) {
        const lockedTiers = await tx.$queryRaw<
          Array<{ id: string; reservedQuantity: number }>
        >`
          SELECT id, "reservedQuantity"
          FROM "TicketTier"
          WHERE id = ANY(${sortedTierIds})
          ORDER BY id ASC
          FOR UPDATE
        `;
        const lockedTierMap = new Map(lockedTiers.map((t) => [t.id, t]));

        for (const tierId of sortedTierIds) {
          const delta = tierDeltaMap.get(tierId) || 0;
          const lockedTier = lockedTierMap.get(tierId);
          if (!lockedTier || delta === 0) continue;

          if (delta < 0 && lockedTier.reservedQuantity < Math.abs(delta)) {
            console.warn('[InventoryUnderflow]', {
              context: 'createCheckoutSessionRollback',
              ticketTierId: tierId,
              expectedReleaseQty: Math.abs(delta),
              observedReservedQty: lockedTier.reservedQuantity,
              clampedReservedQty: 0,
            });
          }

          const nextReserved = Math.max(0, lockedTier.reservedQuantity + delta);
          await tx.ticketTier.update({
            where: { id: tierId },
            data: { reservedQuantity: nextReserved },
          });
        }
      }

      if (activeReservations.length > 0) {
        await tx.ticketReservation.updateMany({
          where: {
            id: { in: activeReservations.map((r) => r.id) },
            status: ReservationStatus.ACTIVE,
          },
          data: { status: ReservationStatus.RELEASED },
        });
      }

      await tx.order.updateMany({
        where: {
          id: createdOrder.id,
          status: OrderStatus.PENDING,
        },
        data: { status: OrderStatus.CANCELLED },
      });

      return { cancelled: true, releasedTierIds: Array.from(releasedTierSet).sort() };
    });

    if (rollbackResult.cancelled) {
      for (const tierId of rollbackResult.releasedTierIds) {
        processWaitlistForTier(tierId).catch(() => {});
      }
    }

    throw new BadRequestError('Payment provider session creation failed. Your reservation was safely released.');
  }
}
