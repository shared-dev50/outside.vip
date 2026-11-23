import Stripe from 'stripe';
import {
  Prisma,
  PaymentProvider,
  PaymentStatus,
  OrderStatus,
  ReservationStatus,
  TicketStatus,
  TicketTierStatus,
  EventStatus,
  WaitlistOfferStatus,
  WaitlistEntryStatus,
  TransferStatus,
  PayoutStatus,
  LedgerEntryType,
  LedgerBalanceType,
} from '@prisma/client';
import { nanoid } from 'nanoid';
import { prisma } from '../../db/prisma.js';
import { stripe } from '../../lib/stripe.js';
import { env } from '../../config/env.js';
import { isTicketTierHidden, isTicketTierSalesDisabled } from '../../utils/ticketTierState.js';
import {
  recordTicketSalePending,
  settleOrderEarnings,
  recordActualStripeFee,
  recordRefundLedger,
  recordDisputeLedger,
} from '../finance/ledger.service.js';
import { enqueueOrderConfirmationEmail } from '../notifications/emailOutbox.service.js';
import { triggerEmailOutboxDispatch } from '../notifications/emailOutboxWorker.js';
import {
  enqueueOrderRefund,
  reconcileOrderRefundFromStripeWebhook,
} from '../refunds/orderRefund.service.js';
import { triggerOrderRefundDispatch } from '../refunds/orderRefundWorker.js';

export class PaymentValidationError extends Error {
  public readonly anomalyCode: string;
  constructor(message: string, anomalyCode = 'PAYMENT_AMOUNT_OR_CURRENCY_MISMATCH') {
    super(message);
    this.name = 'PaymentValidationError';
    this.anomalyCode = anomalyCode;
  }
}

export async function processStripeWebhookEvent(
  event: Stripe.Event
): Promise<{ handled: boolean; duplicate?: boolean }> {
  let txResult: {
    handled: boolean;
    duplicate?: boolean;
    shouldWakeOutbox?: boolean;
    shouldWakeRefund?: boolean;
  };

  try {
    txResult = await prisma.$transaction(
      async (tx) => {
        // Skip duplicate deliveries
        const existing = await tx.processedWebhookEvent.findUnique({
          where: { eventId: event.id },
        });

        if (existing) {
          return {
            handled: true,
            duplicate: true,
            shouldWakeOutbox: false,
            shouldWakeRefund: false,
          };
        }

        let shouldWakeOutbox = false;
        let shouldWakeRefund = false;

        switch (event.type) {
          case 'payment_intent.succeeded': {
            const paymentIntent = event.data.object as Stripe.PaymentIntent;
            const fulfillment = await handlePaymentIntentSucceeded(tx, paymentIntent, {
              throwOnAmountOrCurrencyMismatch: false,
            });
            shouldWakeOutbox = fulfillment.enqueuedEmail;
            shouldWakeRefund = fulfillment.enqueuedRefund;
            break;
          }

          case 'payment_intent.payment_failed': {
            const paymentIntent = event.data.object as Stripe.PaymentIntent;
            await handlePaymentIntentFailed(tx, paymentIntent);
            break;
          }

          case 'charge.updated': {
            const charge = event.data.object as Stripe.Charge;
            await handleChargeUpdated(tx, charge);
            break;
          }

          case 'charge.refunded': {
            const charge = event.data.object as Stripe.Charge;
            const res = await handleChargeRefunded(tx, charge);
            shouldWakeOutbox = shouldWakeOutbox || res.enqueuedEmail;
            break;
          }

          case 'refund.created':
          case 'refund.updated':
          case 'refund.failed': {
            const refund = event.data.object as Stripe.Refund;
            const res = await handleRefundEvent(tx, refund);
            shouldWakeOutbox = shouldWakeOutbox || res.enqueuedEmail;
            break;
          }

          case 'charge.dispute.created':
          case 'charge.dispute.updated':
          case 'charge.dispute.closed': {
            const dispute = event.data.object as Stripe.Dispute;
            await handleDisputeEvent(tx, event.type, dispute);
            break;
          }

          case 'transfer.created':
          case 'transfer.updated':
          case 'transfer.reversed': {
            const transfer = event.data.object as Stripe.Transfer;
            await handleTransferEvent(tx, event.type, transfer);
            break;
          }

          case 'account.updated': {
            const account = event.data.object as Stripe.Account;
            await handleAccountUpdated(tx, account);
            break;
          }

          case 'payout.created':
          case 'payout.updated':
          case 'payout.paid':
          case 'payout.failed': {
            const payout = event.data.object as Stripe.Payout;
            const stripeAccountId = (event as any).account as string | undefined;
            await handlePayoutEvent(tx, event.type, payout, stripeAccountId);
            break;
          }

          default:
            break;
        }

        // Record processed event to guarantee idempotent retries
        await tx.processedWebhookEvent.create({
          data: {
            provider: PaymentProvider.STRIPE,
            eventId: event.id,
          },
        });

        return { handled: true, shouldWakeOutbox, shouldWakeRefund };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        timeout: 10000,
      }
    );
  } catch (error: any) {
    // Handle concurrent duplicate delivery of the exact same Stripe event ID cleanly
    if (error?.code === 'P2002') {
      const target = error?.meta?.target;
      const isEventIdUnique =
        (Array.isArray(target) && target.includes('eventId')) ||
        (typeof target === 'string' && target.includes('eventId'));
      if (isEventIdUnique) {
        return { handled: true, duplicate: true };
      }
    }
    throw error;
  }

  // Strictly post-commit, non-blocking wake-ups: never affect webhook response or durability
  if (txResult.shouldWakeOutbox) {
    triggerEmailOutboxDispatch();
  }
  if (txResult.shouldWakeRefund) {
    triggerOrderRefundDispatch();
  }

  return txResult.duplicate
    ? { handled: txResult.handled, duplicate: true }
    : { handled: txResult.handled };
}

export async function fulfillPaidOrder(
  paymentIntent: Stripe.PaymentIntent
): Promise<boolean> {
  let txResult: { fulfilled: boolean; enqueuedEmail: boolean; enqueuedRefund: boolean };

  try {
    txResult = await prisma.$transaction(
      async (tx) => {
        return await handlePaymentIntentSucceeded(tx, paymentIntent, {
          throwOnAmountOrCurrencyMismatch: true,
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        timeout: 10000,
      }
    );
  } catch (err) {
    if (err instanceof PaymentValidationError && paymentIntent.id) {
      // Persist anomalous manual-review record outside the rolled-back tx (without queueing buyer email)
      // while preserving the thrown validation error for reconciliation callers.
      await recordPaymentMismatchAnomalyOutOfBand(paymentIntent, err).catch(() => {});
    }
    throw err;
  }

  // Strictly post-commit, non-blocking wake-ups: never affect reconciliation response
  if (txResult.enqueuedEmail) {
    triggerEmailOutboxDispatch();
  }
  if (txResult.enqueuedRefund) {
    triggerOrderRefundDispatch();
  }

  return true;
}

async function recordPaymentMismatchAnomalyOutOfBand(
  paymentIntent: Stripe.PaymentIntent,
  err: PaymentValidationError
): Promise<void> {
  const metaOrderId = paymentIntent.metadata?.orderId as string | undefined;
  let order = metaOrderId
    ? await prisma.order.findUnique({ where: { id: metaOrderId }, select: { id: true, totalInCents: true, currency: true } })
    : null;
  if (!order && paymentIntent.id) {
    order = await prisma.order.findFirst({
      where: { paymentReference: paymentIntent.id },
      select: { id: true, totalInCents: true, currency: true },
    });
  }
  const latestChargeId = typeof paymentIntent.latest_charge === 'string'
    ? paymentIntent.latest_charge
    : (paymentIntent.latest_charge as Stripe.Charge)?.id;

  await enqueueOrderRefund(prisma, {
    orderId: order?.id ?? null,
    stripePaymentIntentId: paymentIntent.id,
    stripeChargeId: latestChargeId ?? null,
    amountInCents: typeof paymentIntent.amount === 'number' ? paymentIntent.amount : (order?.totalInCents ?? 0),
    currency: (paymentIntent.currency || order?.currency || 'USD').toUpperCase(),
    reason: 'PAYMENT_AMOUNT_OR_CURRENCY_MISMATCH',
    initialStatus: 'MANUAL_REVIEW_REQUIRED',
    errorCategory: 'ANOMALY',
    errorCode: err.anomalyCode,
    errorMessage: err.message,
    metadata: {
      expectedAmountInCents: order?.totalInCents ?? null,
      receivedAmountInCents: paymentIntent.amount ?? null,
      expectedCurrency: order?.currency ?? null,
      receivedCurrency: paymentIntent.currency ?? null,
    },
  });
}

async function ensureSucceededPaymentTransaction(
  tx: Prisma.TransactionClient,
  orderId: string,
  orderCurrency: string,
  orderTotalInCents: number,
  paymentIntent: Stripe.PaymentIntent
): Promise<void> {
  const existingTx = await tx.paymentTransaction.findFirst({
    where: {
      orderId,
      providerTransactionId: paymentIntent.id,
      status: PaymentStatus.SUCCEEDED,
    },
  });
  if (!existingTx) {
    await tx.paymentTransaction.create({
      data: {
        orderId,
        provider: PaymentProvider.STRIPE,
        providerTransactionId: paymentIntent.id,
        status: PaymentStatus.SUCCEEDED,
        amountInCents: paymentIntent.amount || orderTotalInCents,
        currency: (paymentIntent.currency || orderCurrency).toUpperCase(),
        rawResponse: paymentIntent as any,
      },
    });
  }
}

export async function handlePaymentIntentSucceeded(
  tx: Prisma.TransactionClient,
  paymentIntent: Stripe.PaymentIntent,
  options?: { throwOnAmountOrCurrencyMismatch?: boolean }
): Promise<{ fulfilled: boolean; enqueuedEmail: boolean; enqueuedRefund: boolean }> {
  // Fulfill ONLY when payment is verified as succeeded
  if (paymentIntent.status !== 'succeeded') {
    console.info(`Stripe PaymentIntent ${paymentIntent.id} status is '${paymentIntent.status}', deferring fulfillment.`);
    return { fulfilled: false, enqueuedEmail: false, enqueuedRefund: false };
  }

  const orderId = paymentIntent.metadata?.orderId as string | undefined;
  const latestChargeId = typeof paymentIntent.latest_charge === 'string'
    ? paymentIntent.latest_charge
    : (paymentIntent.latest_charge as Stripe.Charge)?.id;

  // Acquire an exclusive row-level lock on the target Order BEFORE reading its completion state.
  // Canonical lock order: Order -> TicketReservation -> TicketWaitlistOffer -> TicketWaitlistEntry -> TicketTier (sorted id ASC) -> OrderRefund
  let lockedOrderId: string | undefined;
  if (orderId) {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE
    `;
    lockedOrderId = locked[0]?.id;
  }

  if (!lockedOrderId && paymentIntent.id) {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Order" WHERE "paymentReference" = ${paymentIntent.id} ORDER BY "createdAt" ASC LIMIT 1 FOR UPDATE
    `;
    lockedOrderId = locked[0]?.id;
  }

  if (!lockedOrderId) {
    console.warn(`Order referenced by Stripe PaymentIntent ${paymentIntent.id} not found.`);
    if (paymentIntent.id) {
      const anomalyRefund = await enqueueOrderRefund(tx, {
        orderId: null,
        stripePaymentIntentId: paymentIntent.id,
        stripeChargeId: latestChargeId ?? null,
        amountInCents: typeof paymentIntent.amount === 'number' ? paymentIntent.amount : 0,
        currency: (paymentIntent.currency || 'USD').toUpperCase(),
        reason: 'ORDER_NOT_FOUND',
        initialStatus: 'MANUAL_REVIEW_REQUIRED',
        errorCategory: 'ANOMALY',
        errorCode: 'ORDER_NOT_FOUND',
        errorMessage: `No Order matched metadata.orderId (${orderId || 'none'}) or paymentReference (${paymentIntent.id}).`,
        metadata: {
          metadataOrderId: orderId || null,
        },
        buyerNotification: paymentIntent.receipt_email
          ? {
              customerEmail: paymentIntent.receipt_email,
              customerName: 'Customer',
              orderNumber: (paymentIntent.metadata?.orderNumber as string) || 'UNKNOWN',
              eventTitle: 'Outside.vip Event',
            }
          : undefined,
      });
      return {
        fulfilled: false,
        enqueuedEmail: anomalyRefund.enqueuedEmail,
        enqueuedRefund: false,
      };
    }
    return { fulfilled: false, enqueuedEmail: false, enqueuedRefund: false };
  }

  const order = await tx.order.findUnique({
    where: { id: lockedOrderId },
    include: {
      event: {
        include: {
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
      items: { include: { ticketTier: true } },
      reservations: true,
      tickets: true,
    },
  });

  if (!order) {
    console.warn(`Order referenced by Stripe PaymentIntent ${paymentIntent.id} not found after lock.`);
    return { fulfilled: false, enqueuedEmail: false, enqueuedRefund: false };
  }

  // Idempotency guard: if an OrderRefund already exists for this PaymentIntent, do not re-process
  const existingRefundForPi = await tx.orderRefund.findUnique({
    where: { stripePaymentIntentId: paymentIntent.id },
  });
  if (existingRefundForPi) {
    return { fulfilled: false, enqueuedEmail: false, enqueuedRefund: false };
  }

  // Detect duplicate PaymentIntent succeeded for the same Order
  const otherSucceededTx = await tx.paymentTransaction.findFirst({
    where: {
      orderId: order.id,
      status: PaymentStatus.SUCCEEDED,
      providerTransactionId: { not: paymentIntent.id },
    },
  });
  const hasConflictingPiReference =
    order.status === OrderStatus.COMPLETED &&
    Boolean(order.paymentReference) &&
    order.paymentReference !== paymentIntent.id;

  if (otherSucceededTx || hasConflictingPiReference) {
    const dupRefund = await enqueueOrderRefund(tx, {
      orderId: order.id,
      stripePaymentIntentId: paymentIntent.id,
      stripeChargeId: latestChargeId ?? null,
      amountInCents:
        typeof paymentIntent.amount === 'number' ? paymentIntent.amount : order.totalInCents,
      currency: (paymentIntent.currency || order.currency).toUpperCase(),
      reason: 'DUPLICATE_PAYMENT_INTENT',
      initialStatus: 'MANUAL_REVIEW_REQUIRED',
      errorCategory: 'ANOMALY',
      errorCode: 'DUPLICATE_PAYMENT_INTENT',
      errorMessage: `Order ${order.orderNumber} already has a distinct succeeded PaymentIntent (${otherSucceededTx?.providerTransactionId || order.paymentReference}).`,
      metadata: {
        existingPaymentReference: order.paymentReference,
        otherSucceededTxId: otherSucceededTx?.providerTransactionId ?? null,
      },
      buyerNotification: {
        customerEmail: order.customerEmail,
        customerName: order.customerName,
        orderNumber: order.orderNumber,
        eventTitle: order.event?.title || 'Outside.vip Event',
      },
    });
    return {
      fulfilled: false,
      enqueuedEmail: dupRefund.enqueuedEmail,
      enqueuedRefund: false,
    };
  }

  if (order.status === OrderStatus.COMPLETED) {
    return { fulfilled: false, enqueuedEmail: false, enqueuedRefund: false };
  }

  if (order.status === OrderStatus.REFUNDED) {
    const refundedAnomaly = await enqueueOrderRefund(tx, {
      orderId: order.id,
      stripePaymentIntentId: paymentIntent.id,
      stripeChargeId: latestChargeId ?? null,
      amountInCents:
        typeof paymentIntent.amount === 'number' ? paymentIntent.amount : order.totalInCents,
      currency: (paymentIntent.currency || order.currency).toUpperCase(),
      reason: 'PAYMENT_ON_REFUNDED_ORDER',
      initialStatus: 'MANUAL_REVIEW_REQUIRED',
      errorCategory: 'ANOMALY',
      errorCode: 'ORDER_ALREADY_REFUNDED',
      errorMessage: `Received payment_intent.succeeded (${paymentIntent.id}) for already REFUNDED order ${order.orderNumber}.`,
      buyerNotification: {
        customerEmail: order.customerEmail,
        customerName: order.customerName,
        orderNumber: order.orderNumber,
        eventTitle: order.event?.title || 'Outside.vip Event',
      },
    });
    return {
      fulfilled: false,
      enqueuedEmail: refundedAnomaly.enqueuedEmail,
      enqueuedRefund: false,
    };
  }

  // Validate amount and currency strictly before any fulfillment or refund amount decision
  const receivedAmount = paymentIntent.amount;
  const amountInvalid =
    receivedAmount === null ||
    receivedAmount === undefined ||
    !Number.isInteger(receivedAmount) ||
    receivedAmount <= 0 ||
    order.totalInCents <= 0 ||
    receivedAmount !== order.totalInCents;

  if (amountInvalid) {
    const msg = `Amount mismatch for order ${order.orderNumber}: expected ${order.totalInCents}, received ${receivedAmount}`;
    if (options?.throwOnAmountOrCurrencyMismatch !== false) {
      throw new PaymentValidationError(msg, 'AMOUNT_MISMATCH');
    }
    const anomaly = await enqueueOrderRefund(tx, {
      orderId: order.id,
      stripePaymentIntentId: paymentIntent.id,
      stripeChargeId: latestChargeId ?? null,
      amountInCents: typeof receivedAmount === 'number' && receivedAmount > 0 ? receivedAmount : order.totalInCents,
      currency: (paymentIntent.currency || order.currency).toUpperCase(),
      reason: 'PAYMENT_AMOUNT_OR_CURRENCY_MISMATCH',
      initialStatus: 'MANUAL_REVIEW_REQUIRED',
      errorCategory: 'ANOMALY',
      errorCode: 'AMOUNT_MISMATCH',
      errorMessage: msg,
      metadata: {
        expectedAmountInCents: order.totalInCents,
        receivedAmountInCents: receivedAmount ?? null,
      },
    });
    return {
      fulfilled: false,
      enqueuedEmail: anomaly.enqueuedEmail,
      enqueuedRefund: false,
    };
  }

  if (
    paymentIntent.currency &&
    paymentIntent.currency.toUpperCase() !== order.currency.toUpperCase()
  ) {
    const msg = `Currency mismatch for order ${order.orderNumber}: expected ${order.currency}, received ${paymentIntent.currency}`;
    if (options?.throwOnAmountOrCurrencyMismatch !== false) {
      throw new PaymentValidationError(msg, 'CURRENCY_MISMATCH');
    }
    const anomaly = await enqueueOrderRefund(tx, {
      orderId: order.id,
      stripePaymentIntentId: paymentIntent.id,
      stripeChargeId: latestChargeId ?? null,
      amountInCents: order.totalInCents,
      currency: paymentIntent.currency.toUpperCase(),
      reason: 'PAYMENT_AMOUNT_OR_CURRENCY_MISMATCH',
      initialStatus: 'MANUAL_REVIEW_REQUIRED',
      errorCategory: 'ANOMALY',
      errorCode: 'CURRENCY_MISMATCH',
      errorMessage: msg,
      metadata: {
        expectedCurrency: order.currency,
        receivedCurrency: paymentIntent.currency,
      },
    });
    return {
      fulfilled: false,
      enqueuedEmail: anomaly.enqueuedEmail,
      enqueuedRefund: false,
    };
  }

  // Detect inconsistent non-completed order with already-issued tickets or missing items
  if (order.tickets.length > 0 || order.items.length === 0) {
    await ensureSucceededPaymentTransaction(
      tx,
      order.id,
      order.currency,
      order.totalInCents,
      paymentIntent
    );
    const anomaly = await enqueueOrderRefund(tx, {
      orderId: order.id,
      stripePaymentIntentId: paymentIntent.id,
      stripeChargeId: latestChargeId ?? null,
      amountInCents: order.totalInCents,
      currency: order.currency,
      reason: 'INCONSISTENT_ORDER_STATE',
      initialStatus: 'MANUAL_REVIEW_REQUIRED',
      errorCategory: 'ANOMALY',
      errorCode: order.tickets.length > 0 ? 'NON_COMPLETED_ORDER_HAS_TICKETS' : 'ORDER_HAS_NO_ITEMS',
      errorMessage: `Order ${order.orderNumber} (status=${order.status}) has ${order.tickets.length} tickets and ${order.items.length} items.`,
      buyerNotification: {
        customerEmail: order.customerEmail,
        customerName: order.customerName,
        orderNumber: order.orderNumber,
        eventTitle: order.event?.title || 'Outside.vip Event',
      },
    });
    return {
      fulfilled: false,
      enqueuedEmail: anomaly.enqueuedEmail,
      enqueuedRefund: false,
    };
  }

  // Canonical lock step 2: TicketReservation
  const lockedReservations = await tx.$queryRaw<
    Array<{ id: string; ticketTierId: string; quantity: number; status: ReservationStatus }>
  >`
    SELECT id, "ticketTierId", quantity, status
    FROM "TicketReservation"
    WHERE "orderId" = ${order.id}
    ORDER BY id ASC
    FOR UPDATE
  `;

  // Canonical lock step 3: TicketWaitlistOffer (before TicketTier to preserve Offer -> Tier ordering)
  const linkedOffers = await tx.$queryRaw<
    Array<{ id: string; entryId: string; status: WaitlistOfferStatus }>
  >`
    SELECT id, "entryId", status
    FROM "TicketWaitlistOffer"
    WHERE "orderId" = ${order.id}
    ORDER BY id ASC
    FOR UPDATE
  `;

  const tierQuantityMap = new Map<string, number>();
  for (const item of order.items) {
    tierQuantityMap.set(
      item.ticketTierId,
      (tierQuantityMap.get(item.ticketTierId) || 0) + item.quantity
    );
  }
  const sortedTierIds = Array.from(tierQuantityMap.keys()).sort();

  // Canonical lock step 5: TicketTier (sorted id ASC)
  const lockedTiers =
    sortedTierIds.length > 0
      ? await tx.$queryRaw<
          Array<{
            id: string;
            totalCapacity: number;
            soldQuantity: number;
            reservedQuantity: number;
            status: TicketTierStatus;
            isHidden: boolean;
            salesDisabled: boolean;
            salesStartAt: Date | null;
            salesEndAt: Date | null;
          }>
        >`
          SELECT
            id,
            "totalCapacity",
            "soldQuantity",
            "reservedQuantity",
            status,
            "isHidden",
            "salesDisabled",
            "salesStartAt",
            "salesEndAt"
          FROM "TicketTier"
          WHERE id = ANY(${sortedTierIds})
          ORDER BY id ASC
          FOR UPDATE
        `
      : [];
  const lockedTierMap = new Map(lockedTiers.map((t) => [t.id, t]));

  const now = new Date();

  // Check active reservations covering the order
  const activeReservedByTier = new Map<string, number>();
  for (const res of lockedReservations) {
    if (res.status === ReservationStatus.ACTIVE) {
      activeReservedByTier.set(
        res.ticketTierId,
        (activeReservedByTier.get(res.ticketTierId) || 0) + res.quantity
      );
    }
  }
  const hasActiveReservations = lockedReservations.some(
    (r) => r.status === ReservationStatus.ACTIVE
  );
  const allItemsCoveredByActiveReservations =
    hasActiveReservations &&
    sortedTierIds.every(
      (tierId) => (activeReservedByTier.get(tierId) || 0) >= (tierQuantityMap.get(tierId) || 0)
    );

  // Rule 2D: Cancelled order, cancelled/ended event, or explicitly closed tier/sales window cannot fulfill
  const isEventCancelledOrEnded =
    !order.event ||
    order.event.status === EventStatus.CANCELLED ||
    order.event.endAt < now;

  let refundReason: string | null = null;
  let refundDiagnostic: string | null = null;

  if (order.status === OrderStatus.CANCELLED) {
    refundReason = 'ORDER_CANCELLED_LATE_PAYMENT';
    refundDiagnostic = `Order ${order.orderNumber} was CANCELLED before PaymentIntent ${paymentIntent.id} succeeded.`;
  } else if (isEventCancelledOrEnded) {
    refundReason = 'EVENT_OR_SALES_CLOSED';
    refundDiagnostic = `Event for order ${order.orderNumber} is cancelled or has already ended.`;
  } else if (order.status === OrderStatus.PENDING && allItemsCoveredByActiveReservations) {
    // Rule 2A: PENDING order with intact ACTIVE reservations fulfills normally unless tier sales were closed
    for (const tierId of sortedTierIds) {
      const tier = lockedTierMap.get(tierId);
      if (!tier) {
        refundReason = 'LATE_PAYMENT_CAPACITY_REALLOCATED';
        refundDiagnostic = `Ticket tier ${tierId} no longer exists.`;
        break;
      }
      if (
        isTicketTierSalesDisabled(tier) ||
        (tier.salesEndAt && tier.salesEndAt < now)
      ) {
        refundReason = 'EVENT_OR_SALES_CLOSED';
        refundDiagnostic = `Ticket sales window for tier ${tierId} has closed.`;
        break;
      }
    }
  } else if (
    order.status === OrderStatus.PENDING &&
    lockedReservations.length === 0 &&
    order.expiresAt > now
  ) {
    // Legacy non-reserved PENDING order created within hold window: preserve compatibility while enforcing tier existence & capacity
    for (const tierId of sortedTierIds) {
      const neededQty = tierQuantityMap.get(tierId) || 0;
      const tier = lockedTierMap.get(tierId);
      if (!tier) {
        refundReason = 'LATE_PAYMENT_CAPACITY_REALLOCATED';
        refundDiagnostic = `Ticket tier ${tierId} no longer exists.`;
        break;
      }
      if (isTicketTierSalesDisabled(tier) || (tier.salesEndAt && tier.salesEndAt < now)) {
        refundReason = 'EVENT_OR_SALES_CLOSED';
        refundDiagnostic = `Ticket sales window for tier ${tierId} has closed.`;
        break;
      }
      const available = tier.totalCapacity - tier.soldQuantity - tier.reservedQuantity;
      if (available < neededQty) {
        refundReason = 'LATE_PAYMENT_CAPACITY_REALLOCATED';
        refundDiagnostic = `Insufficient capacity for tier ${tierId}: needed ${neededQty}, available ${available}.`;
        break;
      }
    }
  } else {
    // Rule 2B, 2C, 2D, 2E: EXPIRED order (or PENDING whose reservations were released / expired without active hold)
    if (order.event.status !== EventStatus.PUBLISHED || order.event.endAt < now) {
      refundReason = 'EVENT_OR_SALES_CLOSED';
      refundDiagnostic = `Event status is ${order.event.status} (must be PUBLISHED and ongoing/upcoming) for expired order ${order.orderNumber}.`;
    } else {
      for (const tierId of sortedTierIds) {
        const neededQty = tierQuantityMap.get(tierId) || 0;
        const tier = lockedTierMap.get(tierId);
        if (!tier) {
          refundReason = 'LATE_PAYMENT_CAPACITY_REALLOCATED';
          refundDiagnostic = `Ticket tier ${tierId} no longer exists.`;
          break;
        }
        if (
          isTicketTierHidden(tier) ||
          isTicketTierSalesDisabled(tier) ||
          tier.status !== TicketTierStatus.ACTIVE ||
          (tier.salesStartAt && tier.salesStartAt > now) ||
          (tier.salesEndAt && tier.salesEndAt < now)
        ) {
          refundReason = 'EVENT_OR_SALES_CLOSED';
          refundDiagnostic = `Ticket tier ${tierId} is not active/open for online sales.`;
          break;
        }
        // Account for any partial ACTIVE reservation still held by this order vs unallocated capacity
        const ownActiveQty = activeReservedByTier.get(tierId) || 0;
        const unallocated = tier.totalCapacity - tier.soldQuantity - tier.reservedQuantity;
        const totalAvailableForOrder = unallocated + ownActiveQty;
        if (totalAvailableForOrder < neededQty) {
          refundReason = 'LATE_PAYMENT_CAPACITY_REALLOCATED';
          refundDiagnostic = `Capacity reallocated for tier ${tierId}: requested ${neededQty}, genuinely unallocated ${Math.max(0, totalAvailableForOrder)}.`;
          break;
        }
      }
    }
  }

  // Automatic Refund Path (Rule 2C / 2D / 2E fallback when cannot safely fulfill)
  if (refundReason) {
    // If an un-swept PENDING order still had ACTIVE reservations before rejection, release them cleanly
    if (hasActiveReservations) {
      const releaseIds: string[] = [];
      for (const res of lockedReservations) {
        if (res.status !== ReservationStatus.ACTIVE) continue;
        releaseIds.push(res.id);
        const tier = lockedTierMap.get(res.ticketTierId);
        if (tier) {
          const nextReserved = Math.max(0, tier.reservedQuantity - res.quantity);
          tier.reservedQuantity = nextReserved;
          await tx.ticketTier.update({
            where: { id: res.ticketTierId },
            data: { reservedQuantity: nextReserved },
          });
        }
      }
      if (releaseIds.length > 0) {
        await tx.ticketReservation.updateMany({
          where: { id: { in: releaseIds }, status: ReservationStatus.ACTIVE },
          data: { status: ReservationStatus.RELEASED },
        });
      }
    }

    // Never leave an unfulfilled late-paid order as PENDING (prevents order-lookup reconciliation retries)
    if (order.status === OrderStatus.PENDING) {
      await tx.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.EXPIRED },
      });
    }

    await ensureSucceededPaymentTransaction(
      tx,
      order.id,
      order.currency,
      order.totalInCents,
      paymentIntent
    );

    const refundEnqueue = await enqueueOrderRefund(tx, {
      orderId: order.id,
      stripePaymentIntentId: paymentIntent.id,
      stripeChargeId: latestChargeId ?? null,
      amountInCents: order.totalInCents,
      currency: order.currency,
      reason: refundReason,
      initialStatus: 'PENDING',
      metadata: {
        orderNumber: order.orderNumber,
        originalOrderStatus: order.status,
        diagnostic: refundDiagnostic,
      },
    });

    return {
      fulfilled: false,
      enqueuedEmail: refundEnqueue.enqueuedEmail,
      enqueuedRefund: refundEnqueue.created || refundEnqueue.orderRefund.status === 'PENDING',
    };
  }

  // Normal Fulfillment Path (Rule 2A or Rule 2B with genuinely unallocated capacity)
  const ensuredOrderAccessToken = order.orderAccessToken || `oat_${nanoid(32)}`;

  await tx.order.update({
    where: { id: order.id },
    data: {
      status: OrderStatus.COMPLETED,
      paymentReference: paymentIntent.id,
      ...(order.orderAccessToken ? {} : { orderAccessToken: ensuredOrderAccessToken }),
    },
  });

  if (hasActiveReservations) {
    await tx.ticketReservation.updateMany({
      where: { orderId: order.id, status: ReservationStatus.ACTIVE },
      data: { status: ReservationStatus.CONFIRMED },
    });
  }

  if (linkedOffers.length > 0) {
    const offerIds = linkedOffers.map((o) => o.id);
    const entryIds = Array.from(new Set(linkedOffers.map((o) => o.entryId)));

    await tx.ticketWaitlistOffer.updateMany({
      where: { id: { in: offerIds } },
      data: {
        status: WaitlistOfferStatus.ACCEPTED,
        claimedAt: now,
      },
    });

    await tx.ticketWaitlistEntry.updateMany({
      where: { id: { in: entryIds } },
      data: {
        status: WaitlistEntryStatus.PURCHASED,
      },
    });
  }

  for (const tierId of sortedTierIds) {
    const qty = tierQuantityMap.get(tierId) || 0;
    const lockedTier = lockedTierMap.get(tierId);
    if (!lockedTier || qty <= 0) continue;

    // Only decrement reservedQuantity by the portion actively reserved by this order
    const releaseReservedQty = Math.min(qty, activeReservedByTier.get(tierId) || 0);
    let nextReservedUpdate: { reservedQuantity?: number } = {};
    if (releaseReservedQty > 0) {
      if (lockedTier.reservedQuantity < releaseReservedQty) {
        console.warn('[InventoryUnderflow]', {
          context: 'handlePaymentIntentSucceeded',
          ticketTierId: tierId,
          expectedReleaseQty: releaseReservedQty,
          observedReservedQty: lockedTier.reservedQuantity,
          clampedReservedQty: 0,
        });
      }
      nextReservedUpdate = {
        reservedQuantity: Math.max(0, lockedTier.reservedQuantity - releaseReservedQty),
      };
    }

    await tx.ticketTier.update({
      where: { id: tierId },
      data: {
        ...nextReservedUpdate,
        soldQuantity: { increment: qty },
      },
    });
  }

  let issuedTicketCount = order.tickets.length;
  if (order.tickets.length === 0) {
    for (const item of order.items) {
      for (let i = 0; i < item.quantity; i++) {
        const ticketToken = `tkt_sec_${nanoid(24)}`;
        await tx.ticket.create({
          data: {
            ticketToken,
            orderId: order.id,
            eventId: order.eventId,
            ticketTierId: item.ticketTierId,
            attendeeName: order.customerName,
            attendeeEmail: order.customerEmail,
            status: TicketStatus.ISSUED,
          },
        });
        issuedTicketCount += 1;
      }
    }
  }

  await ensureSucceededPaymentTransaction(
    tx,
    order.id,
    order.currency,
    order.totalInCents,
    paymentIntent
  );

  // If charge.updated(available) arrived out-of-order BEFORE payment_intent.succeeded,
  // settle immediately via autoSettle so settlement is never permanently lost.
  const shouldAutoSettleFromPriorCharge = Boolean(order.stripeFundsAvailableAt);
  const settlementChargeId = latestChargeId || order.stripeSettledChargeId || undefined;

  await recordTicketSalePending(tx, {
    orderId: order.id,
    paymentIntentId: paymentIntent.id,
    stripeChargeId: settlementChargeId,
    autoSettle: shouldAutoSettleFromPriorCharge,
  });

  // Atomically enqueue the durable buyer confirmation email inside the same transaction.
  // Never performs external email I/O here.
  let enqueuedEmail = false;
  if (issuedTicketCount > 0 && order.event) {
    const outboxResult = await enqueueOrderConfirmationEmail(tx, order);
    enqueuedEmail = outboxResult.enqueued;
  }

  return { fulfilled: true, enqueuedEmail, enqueuedRefund: false };
}

export async function handlePaymentIntentFailed(
  tx: Prisma.TransactionClient,
  paymentIntent: Stripe.PaymentIntent
): Promise<void> {
  const orderId = paymentIntent.metadata?.orderId as string | undefined;

  let order = orderId
    ? await tx.order.findUnique({
        where: { id: orderId },
        include: { items: true },
      })
    : null;

  if (!order && paymentIntent.id) {
    order = await tx.order.findFirst({
      where: { paymentReference: paymentIntent.id },
      include: { items: true },
    });
  }

  if (!order || order.status === OrderStatus.COMPLETED) {
    return;
  }

  // Record failed transaction for auditing while allowing the attendee to retry
  const failureReason = paymentIntent.last_payment_error?.message || 'Payment attempt failed';
  await tx.paymentTransaction.create({
    data: {
      orderId: order.id,
      provider: PaymentProvider.STRIPE,
      providerTransactionId: paymentIntent.id,
      status: PaymentStatus.FAILED,
      amountInCents: paymentIntent.amount || order.totalInCents,
      currency: order.currency,
      rawResponse: {
        ...(paymentIntent as any),
        failureReason,
      },
    },
  });
}

async function lockOrderByIdentifier(
  tx: Prisma.TransactionClient,
  orderId?: string | null,
  paymentIntentId?: string | null
) {
  let lockedOrderId: string | undefined;
  if (orderId) {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE
    `;
    lockedOrderId = locked[0]?.id;
  }

  if (!lockedOrderId && paymentIntentId) {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Order" WHERE "paymentReference" = ${paymentIntentId} ORDER BY "createdAt" ASC LIMIT 1 FOR UPDATE
    `;
    lockedOrderId = locked[0]?.id;
  }

  if (!lockedOrderId) {
    return null;
  }

  return tx.order.findUnique({
    where: { id: lockedOrderId },
    include: {
      event: { select: { title: true } },
    },
  });
}

async function handleChargeUpdated(
  tx: Prisma.TransactionClient,
  charge: Stripe.Charge
): Promise<void> {
  const paymentIntentId = typeof charge.payment_intent === 'string'
    ? charge.payment_intent
    : (charge.payment_intent as Stripe.PaymentIntent)?.id;

  const orderId = charge.metadata?.orderId as string | undefined;
  const order = await lockOrderByIdentifier(tx, orderId, paymentIntentId);

  if (!order) {
    return;
  }

  let balanceTx: Stripe.BalanceTransaction | null = null;
  if (typeof charge.balance_transaction === 'object' && charge.balance_transaction !== null) {
    balanceTx = charge.balance_transaction as Stripe.BalanceTransaction;
  } else if (
    typeof charge.balance_transaction === 'string' &&
    env.STRIPE_SECRET_KEY &&
    env.STRIPE_SECRET_KEY !== 'sk_test_placeholder'
  ) {
    try {
      balanceTx = await stripe.balanceTransactions.retrieve(charge.balance_transaction);
    } catch (err: any) {
      console.warn(`[Settlement] Could not retrieve balance transaction ${charge.balance_transaction}: ${err?.message}`);
    }
  }

  // Financially correct settlement detection:
  // Only transition organizer earnings from PENDING to AVAILABLE if the underlying
  // Stripe BalanceTransaction has actually become available in the platform Stripe balance
  // (status === 'available').
  const isFundsAvailable = Boolean(
    balanceTx &&
      balanceTx.status === 'available' &&
      (typeof balanceTx.available_on !== 'number' || balanceTx.available_on * 1000 <= Date.now())
  );

  // Check actual sale/ledger evidence OR completed status; never settle unfulfilled late-payment/expired/refunded orders.
  const existingSaleLedger = await tx.financialLedgerEntry.findFirst({
    where: {
      orderId: order.id,
      type: { in: [LedgerEntryType.TICKET_SALE_PENDING, LedgerEntryType.TICKET_SALE_CLEARED] },
    },
    select: { id: true },
  });
  const hasLatePaymentRefund = Boolean(
    await tx.orderRefund.findFirst({
      where: { orderId: order.id },
      select: { id: true },
    })
  );

  const isCompletedSale =
    !hasLatePaymentRefund &&
    (order.status === OrderStatus.COMPLETED || Boolean(existingSaleLedger));

  if (charge.status === 'succeeded' && isFundsAvailable) {
    if (isCompletedSale) {
      await settleOrderEarnings(tx, {
        orderId: order.id,
        stripeChargeId: charge.id,
      });
    } else if (
      order.status === OrderStatus.PENDING &&
      !order.stripeFundsAvailableAt
    ) {
      // Out-of-order charge.updated arrived before payment_intent.succeeded:
      // Persist durable availability signal so normal fulfillment settles immediately without
      // crediting organizer balances prematurely if this turns out to be a late payment.
      await tx.order.update({
        where: { id: order.id },
        data: {
          stripeFundsAvailableAt: new Date(),
          stripeSettledChargeId: charge.id,
        },
      });
    }
  }

  // Reconcile actual Stripe fee only for legitimate completed sales
  if (isCompletedSale && balanceTx && typeof balanceTx.fee === 'number') {
    await recordActualStripeFee(tx, {
      stripeChargeId: charge.id,
      actualFeeInCents: balanceTx.fee,
      currency: charge.currency,
      orderId: order.id,
    });
  }
}

async function handleChargeRefunded(
  tx: Prisma.TransactionClient,
  charge: Stripe.Charge
): Promise<{ enqueuedEmail: boolean }> {
  const paymentIntentId = typeof charge.payment_intent === 'string'
    ? charge.payment_intent
    : (charge.payment_intent as Stripe.PaymentIntent)?.id;

  const orderId = charge.metadata?.orderId as string | undefined;

  let order = await lockOrderByIdentifier(tx, orderId, paymentIntentId);

  const chargeRefunds = (charge.refunds?.data || []).map((r) => ({
    id: r.id,
    amount: typeof r.amount === 'number' ? r.amount : charge.amount_refunded,
    currency: (r.currency || charge.currency || order?.currency || 'USD').toUpperCase(),
    status: (r as any).status ?? null,
    failure_reason: r.failure_reason,
    metadata: (r.metadata || null) as Record<string, string> | null,
  }));

  // If Order wasn't matched directly via charge metadata/paymentReference, resolve Order via OrderRefund
  if (!order && (paymentIntentId || chargeRefunds.length > 0)) {
    const refundIds = chargeRefunds.map((r) => r.id).filter(Boolean);
    const linkedRefund = await tx.orderRefund.findFirst({
      where: {
        OR: [
          ...(paymentIntentId ? [{ stripePaymentIntentId: paymentIntentId }] : []),
          ...(refundIds.length > 0 ? [{ stripeRefundId: { in: refundIds } }] : []),
        ],
      },
      select: { orderId: true },
    });
    if (linkedRefund?.orderId) {
      order = await lockOrderByIdentifier(tx, linkedRefund.orderId, null);
    }
  }

  const lockedOrderSummary = order
    ? {
        id: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        customerEmail: order.customerEmail,
        customerName: order.customerName,
        eventTitle: order.event?.title || 'Outside.vip Event',
      }
    : null;

  const lateReconcile = await reconcileOrderRefundFromStripeWebhook(tx, {
    lockedOrder: lockedOrderSummary,
    paymentIntentId: paymentIntentId ?? null,
    refunds: chargeRefunds,
  });

  if (!order) {
    if (lateReconcile.matchedLatePaymentRefund) {
      return { enqueuedEmail: lateReconcile.enqueuedEmail };
    }
    throw new Error(`[ChargeRefunded] Order not found for charge ${charge.id}; throwing to trigger Stripe webhook retry`);
  }

  // Use actual sale/ledger evidence before mutating organizer balances so late-payment refunds
  // never create bogus organizer debits or phantom RECOVERABLE liabilities.
  const saleLedgerEvidence = await tx.financialLedgerEntry.findFirst({
    where: {
      orderId: order.id,
      type: { in: [LedgerEntryType.TICKET_SALE_PENDING, LedgerEntryType.TICKET_SALE_CLEARED] },
    },
    select: { id: true },
  });

  const isLegitimateSaleRefund =
    Boolean(saleLedgerEvidence) ||
    (!lateReconcile.matchedLatePaymentRefund && order.status === OrderStatus.COMPLETED);

  if (isLegitimateSaleRefund) {
    const stripeRefundId = charge.refunds?.data?.[0]?.id;
    await recordRefundLedger(tx, {
      orderId: order.id,
      amountInCents: charge.amount_refunded,
      stripeRefundId,
      stripeChargeId: charge.id,
      reason: 'Stripe charge refunded',
    });
  }

  return { enqueuedEmail: lateReconcile.enqueuedEmail };
}

async function handleRefundEvent(
  tx: Prisma.TransactionClient,
  refund: Stripe.Refund
): Promise<{ enqueuedEmail: boolean }> {
  const paymentIntentId = typeof refund.payment_intent === 'string'
    ? refund.payment_intent
    : (refund.payment_intent as Stripe.PaymentIntent)?.id;

  const metaOrderId = refund.metadata?.orderId as string | undefined;
  let order = await lockOrderByIdentifier(tx, metaOrderId, paymentIntentId);

  if (!order) {
    const linked = await tx.orderRefund.findFirst({
      where: {
        OR: [
          ...(refund.id ? [{ stripeRefundId: refund.id }] : []),
          ...(paymentIntentId ? [{ stripePaymentIntentId: paymentIntentId }] : []),
        ],
      },
      select: { orderId: true },
    });
    if (linked?.orderId) {
      order = await lockOrderByIdentifier(tx, linked.orderId, null);
    }
  }

  const res = await reconcileOrderRefundFromStripeWebhook(tx, {
    lockedOrder: order
      ? {
          id: order.id,
          orderNumber: order.orderNumber,
          status: order.status,
          customerEmail: order.customerEmail,
          customerName: order.customerName,
          eventTitle: order.event?.title || 'Outside.vip Event',
        }
      : null,
    paymentIntentId: paymentIntentId ?? null,
    refunds: [
      {
        id: refund.id,
        amount: refund.amount,
        currency: (refund.currency || order?.currency || 'USD').toUpperCase(),
        status: refund.status,
        failure_reason: refund.failure_reason,
        metadata: (refund.metadata || null) as Record<string, string> | null,
      },
    ],
  });

  return { enqueuedEmail: res.enqueuedEmail };
}

async function handleDisputeEvent(
  tx: Prisma.TransactionClient,
  eventType: string,
  dispute: Stripe.Dispute
): Promise<void> {
  const chargeId = typeof dispute.charge === 'string'
    ? dispute.charge
    : (dispute.charge as Stripe.Charge)?.id;

  let order: any = null;

  if (chargeId) {
    // 1. Try finding by existing financial ledger entry for this charge
    const existingLedger = await tx.financialLedgerEntry.findFirst({
      where: { stripeReferenceId: chargeId },
    });
    if (existingLedger?.orderId) {
      order = await tx.order.findUnique({
        where: { id: existingLedger.orderId },
      });
    }

    // 2. Try finding by payment transaction
    if (!order) {
      order = await tx.order.findFirst({
        where: {
          transactions: {
            some: { providerTransactionId: chargeId },
          },
        },
      });
    }

    // 3. If still not found and Stripe key available, retrieve charge to inspect payment_intent
    if (!order && env.STRIPE_SECRET_KEY && env.STRIPE_SECRET_KEY !== 'sk_test_placeholder') {
      try {
        const stripeCharge = await stripe.charges.retrieve(chargeId);
        const piId = typeof stripeCharge.payment_intent === 'string'
          ? stripeCharge.payment_intent
          : (stripeCharge.payment_intent as Stripe.PaymentIntent)?.id;
        const metaOrderId = stripeCharge.metadata?.orderId;
        if (metaOrderId) {
          order = await tx.order.findUnique({ where: { id: metaOrderId } });
        }
        if (!order && piId) {
          order = await tx.order.findFirst({
            where: { paymentReference: piId },
          });
        }
      } catch (err: any) {
        console.warn(`[Dispute] Could not retrieve charge ${chargeId}: ${err?.message}`);
      }
    }
  }

  let status: 'needs_response' | 'under_review' | 'won' | 'lost' | 'warning_needs_response' = 'needs_response';
  if (dispute.status === 'won') {
    status = 'won';
  } else if (dispute.status === 'lost') {
    status = 'lost';
  } else if (dispute.status === 'under_review') {
    status = 'under_review';
  }

  await recordDisputeLedger(tx, {
    stripeDisputeId: dispute.id,
    stripeChargeId: chargeId,
    orderId: order?.id,
    amountInCents: dispute.amount,
    status,
    reason: dispute.reason,
  });
}

async function handleTransferEvent(
  tx: Prisma.TransactionClient,
  eventType: string,
  transfer: Stripe.Transfer
): Promise<void> {
  if (eventType === 'transfer.reversed') {
    const existing = await tx.organizerTransfer.findUnique({
      where: { stripeTransferId: transfer.id },
    });

    if (existing && existing.status !== TransferStatus.REVERSED) {
      await tx.organizerTransfer.update({
        where: { id: existing.id },
        data: { status: TransferStatus.REVERSED },
      });

      // Restore organizer balance: decrement transferred balance, increment available balance
      await tx.organizerBalance.update({
        where: { userId: existing.organizerId },
        data: {
          transferredBalanceInCents: { decrement: existing.amountInCents },
          availableBalanceInCents: { increment: existing.amountInCents },
        },
      });

      await tx.financialLedgerEntry.create({
        data: {
          type: LedgerEntryType.ADJUSTMENT,
          balanceType: LedgerBalanceType.TRANSFERRED,
          amountInCents: -existing.amountInCents,
          currency: existing.currency.toUpperCase(),
          organizerId: existing.organizerId,
          transferId: existing.id,
          stripeReferenceId: transfer.id,
          description: `Stripe transfer reversed for transfer #${existing.transferNumber}`,
          metadata: {
            transferId: existing.id,
            transferNumber: existing.transferNumber,
            stripeTransferId: transfer.id,
          },
        },
      });

      await tx.financialLedgerEntry.create({
        data: {
          type: LedgerEntryType.ADJUSTMENT,
          balanceType: LedgerBalanceType.AVAILABLE,
          amountInCents: existing.amountInCents,
          currency: existing.currency.toUpperCase(),
          organizerId: existing.organizerId,
          transferId: existing.id,
          stripeReferenceId: transfer.id,
          description: `Restored available balance for reversed transfer #${existing.transferNumber}`,
          metadata: {
            transferId: existing.id,
            transferNumber: existing.transferNumber,
            stripeTransferId: transfer.id,
          },
        },
      });
    }
  }
}

async function handlePayoutEvent(
  tx: Prisma.TransactionClient,
  eventType: string,
  payout: Stripe.Payout,
  stripeAccountId?: string
): Promise<void> {
  if (!stripeAccountId) {
    return;
  }

  const user = await tx.user.findFirst({
    where: { stripeAccountId },
  });

  if (!user) {
    return;
  }

  let status: PayoutStatus = PayoutStatus.PENDING;
  if (payout.status === 'paid') {
    status = PayoutStatus.PAID;
  } else if (payout.status === 'failed') {
    status = PayoutStatus.FAILED;
  } else if (payout.status === 'canceled') {
    status = PayoutStatus.CANCELLED;
  }

  const arrivalDate = payout.arrival_date ? new Date(payout.arrival_date * 1000) : null;
  const failureCode = payout.failure_code || null;
  const failureMessage = payout.failure_message || null;

  // Masked bank account details from payout destination where available
  const destinationBankMasked = (payout as any).destination_details?.card?.last4
    ? `•••• ${(payout as any).destination_details?.card?.last4}`
    : null;

  await tx.connectedPayout.upsert({
    where: { stripePayoutId: payout.id },
    update: {
      status,
      arrivalDate,
      failureCode,
      failureMessage,
      destinationBankMasked,
    },
    create: {
      stripePayoutId: payout.id,
      organizerId: user.id,
      stripeAccountId,
      amountInCents: payout.amount,
      currency: payout.currency.toUpperCase(),
      status,
      arrivalDate,
      failureCode,
      failureMessage,
      destinationBankMasked,
    },
  });
}

async function handleAccountUpdated(
  tx: Prisma.TransactionClient,
  account: Stripe.Account
): Promise<void> {
  const user = await tx.user.findUnique({
    where: { stripeAccountId: account.id },
  });

  if (!user) {
    return;
  }

  // If Stripe account has bank account, reflect safe masked details in OrganizerPayoutDetails
  const bankAccounts = (account.external_accounts?.data || []).filter(
    (e) => e.object === 'bank_account'
  ) as Stripe.BankAccount[];

  if (bankAccounts.length > 0) {
    const defaultBank =
      bankAccounts.find((b) => (b as any).default_for_currency) || bankAccounts[0];

    const masked = `•••• •••• •••• ${defaultBank.last4 || '••••'}`;
    const last4 = defaultBank.last4 || '';

    const existingPayout = await tx.organizerPayoutDetails.findUnique({
      where: { userId: user.id },
    });

    if (existingPayout) {
      await tx.organizerPayoutDetails.update({
        where: { userId: user.id },
        data: {
          accountHolderName: defaultBank.account_holder_name || existingPayout.accountHolderName,
          bankName: defaultBank.bank_name || existingPayout.bankName,
          bankCountry: defaultBank.country || existingPayout.bankCountry,
          accountCurrency: defaultBank.currency
            ? defaultBank.currency.toUpperCase()
            : existingPayout.accountCurrency,
          accountNumberMasked: masked,
          accountNumberLast4: last4,
          routingCode: defaultBank.routing_number
            ? `••••${defaultBank.routing_number.slice(-4)}`
            : existingPayout.routingCode,
        },
      });
    }
  }
}
