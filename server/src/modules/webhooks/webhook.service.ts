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
  StripeSettlementStatus,
} from '@prisma/client';
import { nanoid } from 'nanoid';
import { prisma } from '../../db/prisma.js';
import { stripe } from '../../lib/stripe.js';
import { env } from '../../config/env.js';
import { isTicketTierHidden, isTicketTierSalesDisabled } from '../../utils/ticketTierState.js';
import {
  getOrCreateOrganizerBalance,
  hasOpenDisputeForOrder,
  recordTicketSalePending,
  settleOrderEarnings,
  recordActualStripeFee,
  reconcileChargeRefundBeforeSettlement,
  recordRefundLedger,
  recordDisputeLedger,
} from '../finance/ledger.service.js';
import {
  emitTransferCriticalAlert,
  finalizeTransferSucceededInTx,
  sanitizeTransferDiagnosticMessage,
} from '../finance/transferReconciliation.service.js';
import { logStripeDiagnostic } from '../finance/stripeError.js';
import {
  classifyStripeSettlementRetrievalError,
  emitSettlementCriticalAlert,
  handleBalanceAvailableWebhook,
  sanitizeSettlementDiagnosticMessage,
  SettlementErrorClassification,
} from '../finance/settlementRecovery.service.js';
import { triggerSettlementRecoveryDispatch } from '../finance/settlementRecoveryWorker.js';
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

interface ChargeBalanceResolution {
  balanceTx: Stripe.BalanceTransaction | null;
  retrievalFailure: SettlementErrorClassification | null;
  rawError?: any;
}

async function resolveChargeBalanceTransaction(
  charge: Stripe.Charge
): Promise<ChargeBalanceResolution> {
  if (typeof charge.balance_transaction === 'object' && charge.balance_transaction !== null) {
    return {
      balanceTx: charge.balance_transaction as Stripe.BalanceTransaction,
      retrievalFailure: null,
    };
  }

  const effectiveStripeKey = process.env.STRIPE_SECRET_KEY ?? env.STRIPE_SECRET_KEY;
  if (
    typeof charge.balance_transaction === 'string' &&
    effectiveStripeKey &&
    effectiveStripeKey !== 'sk_test_placeholder'
  ) {
    try {
      const balanceTx = await stripe.balanceTransactions.retrieve(charge.balance_transaction);
      return { balanceTx, retrievalFailure: null };
    } catch (err: any) {
      logStripeDiagnostic('resolveChargeBalanceTransaction', err, {
        chargeId: charge.id,
        balanceTransactionId: charge.balance_transaction,
      });
      return {
        balanceTx: null,
        retrievalFailure: classifyStripeSettlementRetrievalError(err),
        rawError: err,
      };
    }
  }

  return { balanceTx: null, retrievalFailure: null };
}

export async function processStripeWebhookEvent(
  event: Stripe.Event
): Promise<{ handled: boolean; duplicate?: boolean }> {
  // Fast non-locking duplicate check before any external Stripe HTTP pre-fetch
  const alreadyProcessed = await prisma.processedWebhookEvent.findUnique({
    where: { eventId: event.id },
    select: { id: true },
  });
  if (alreadyProcessed) {
    return { handled: true, duplicate: true };
  }

  // Retrieve Stripe BalanceTransaction strictly OUTSIDE Prisma transactions / row locks
  let balanceResolution: ChargeBalanceResolution = {
    balanceTx: null,
    retrievalFailure: null,
  };
  if (event.type === 'charge.updated') {
    balanceResolution = await resolveChargeBalanceTransaction(
      event.data.object as Stripe.Charge
    );
    // Transient Stripe API/network failures must NOT acknowledge the webhook as processed;
    // throwing before ProcessedWebhookEvent write allows Stripe retries and recovery worker fallback.
    if (balanceResolution.retrievalFailure?.disposition === 'RETRY') {
      throw (
        balanceResolution.rawError ??
        new Error(balanceResolution.retrievalFailure.message)
      );
    }
  }

  let txResult: {
    handled: boolean;
    duplicate?: boolean;
    shouldWakeOutbox?: boolean;
    shouldWakeRefund?: boolean;
    shouldWakeSettlement?: boolean;
  };

  try {
    txResult = await prisma.$transaction(
      async (tx) => {
        // Re-check inside transaction in case of concurrent duplicate delivery
        const existing = await tx.processedWebhookEvent.findUnique({
          where: { eventId: event.id },
        });

        if (existing) {
          return {
            handled: true,
            duplicate: true,
            shouldWakeOutbox: false,
            shouldWakeRefund: false,
            shouldWakeSettlement: false,
          };
        }

        let shouldWakeOutbox = false;
        let shouldWakeRefund = false;
        let shouldWakeSettlement = false;

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
            await handleChargeUpdated(tx, charge, {
              balanceTx: balanceResolution.balanceTx,
              permanentRetrievalFailure:
                balanceResolution.retrievalFailure?.disposition === 'PERMANENT'
                  ? balanceResolution.retrievalFailure
                  : null,
            });
            break;
          }

          case 'balance.available': {
            shouldWakeSettlement = await handleBalanceAvailableWebhook(tx);
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
            const dispRes = await handleDisputeEvent(tx, event.type, dispute);
            shouldWakeSettlement = shouldWakeSettlement || dispRes.shouldWakeSettlement;
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
            await handleAccountUpdated(tx, account, event.created);
            break;
          }

          case 'capability.updated': {
            const capability = event.data.object as Stripe.Capability;
            const stripeAccountId =
              ((event as any).account as string | undefined) ||
              (typeof capability.account === 'string'
                ? capability.account
                : capability.account?.id);
            await handleCapabilityUpdated(tx, capability, stripeAccountId, event.created);
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

        return { handled: true, shouldWakeOutbox, shouldWakeRefund, shouldWakeSettlement };
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
  if (txResult.shouldWakeSettlement) {
    triggerSettlementRecoveryDispatch();
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
  const settlementChargeId = latestChargeId || order.stripeSettledChargeId || undefined;

  await tx.order.update({
    where: { id: order.id },
    data: {
      status: OrderStatus.COMPLETED,
      paymentReference: paymentIntent.id,
      ...(order.orderAccessToken ? {} : { orderAccessToken: ensuredOrderAccessToken }),
      ...(settlementChargeId && !order.stripeSettledChargeId
        ? { stripeSettledChargeId: settlementChargeId }
        : {}),
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
  // settle immediately via autoSettle (unless an open dispute already exists on the order)
  const expandedLatestCharge =
    typeof paymentIntent.latest_charge === 'object' && paymentIntent.latest_charge !== null
      ? (paymentIntent.latest_charge as Stripe.Charge)
      : null;
  const shouldAutoSettleFromPriorCharge =
    Boolean(order.stripeFundsAvailableAt) &&
    !(await hasOpenDisputeForOrder(tx, order.id, expandedLatestCharge));

  await recordTicketSalePending(tx, {
    orderId: order.id,
    paymentIntentId: paymentIntent.id,
    stripeChargeId: settlementChargeId,
    autoSettle: shouldAutoSettleFromPriorCharge,
  });

  // If charge.updated arrived out-of-order BEFORE payment_intent.succeeded and buffered the actual Stripe fee,
  // record the reconciled Stripe fee entry once now that the sale is fulfilled.
  if (
    typeof order.stripeActualFeeInCents === 'number' &&
    !order.stripeActualFeeRecordedAt &&
    settlementChargeId
  ) {
    await recordActualStripeFee(tx, {
      stripeChargeId: settlementChargeId,
      actualFeeInCents: order.stripeActualFeeInCents,
      currency: order.stripeActualFeeCurrency || order.currency,
      orderId: order.id,
    });
    await tx.order.update({
      where: { id: order.id },
      data: {
        stripeActualFeeRecordedAt: new Date(),
        stripeActualFeeInCents: null,
      },
    });
  }

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
  charge: Stripe.Charge,
  resolution?:
    | Stripe.BalanceTransaction
    | null
    | {
        balanceTx?: Stripe.BalanceTransaction | null;
        permanentRetrievalFailure?: SettlementErrorClassification | null;
      }
): Promise<void> {
  const paymentIntentId = typeof charge.payment_intent === 'string'
    ? charge.payment_intent
    : (charge.payment_intent as Stripe.PaymentIntent)?.id;

  const preloadedBalanceTx =
    resolution && 'balanceTx' in resolution
      ? (resolution.balanceTx ?? null)
      : ((resolution as Stripe.BalanceTransaction | null | undefined) ?? null);
  const permanentRetrievalFailure =
    resolution && 'permanentRetrievalFailure' in resolution
      ? (resolution.permanentRetrievalFailure ?? null)
      : null;

  // Balance transaction was retrieved strictly outside this DB transaction / Order lock
  const balanceTx: Stripe.BalanceTransaction | null =
    preloadedBalanceTx ??
    (typeof charge.balance_transaction === 'object' && charge.balance_transaction !== null
      ? (charge.balance_transaction as Stripe.BalanceTransaction)
      : null);

  const rawBalanceTxId =
    balanceTx?.id ||
    (typeof charge.balance_transaction === 'string' ? charge.balance_transaction : null);
  const availableOnDate =
    balanceTx && typeof balanceTx.available_on === 'number'
      ? new Date(balanceTx.available_on * 1000)
      : null;

  const orderId = charge.metadata?.orderId as string | undefined;
  const order = await lockOrderByIdentifier(tx, orderId, paymentIntentId);

  if (!order) {
    return;
  }

  // Scope OrderRefund check by PaymentIntent when available so a duplicate PI's OrderRefund
  // does not block legitimate settlement for the original PI on the same Order.
  const hasLatePaymentRefundForPi = paymentIntentId
    ? Boolean(
        await tx.orderRefund.findUnique({
          where: { stripePaymentIntentId: paymentIntentId },
          select: { id: true },
        })
      )
    : Boolean(
        await tx.orderRefund.findFirst({
          where: { orderId: order.id },
          select: { id: true },
        })
      );

  const isDifferentPiFromOrder = Boolean(
    paymentIntentId &&
      order.paymentReference &&
      order.paymentReference !== paymentIntentId
  );

  const existingSaleLedger = await tx.financialLedgerEntry.findFirst({
    where: {
      orderId: order.id,
      type: { in: [LedgerEntryType.TICKET_SALE_PENDING, LedgerEntryType.TICKET_SALE_CLEARED] },
    },
    select: { id: true },
  });

  const existingClearedLedger = await tx.financialLedgerEntry.findFirst({
    where: {
      orderId: order.id,
      type: LedgerEntryType.TICKET_SALE_CLEARED,
    },
    select: { id: true },
  });

  if (permanentRetrievalFailure) {
    if (
      !hasLatePaymentRefundForPi &&
      !isDifferentPiFromOrder &&
      !existingClearedLedger &&
      order.stripeSettlementStatus !== StripeSettlementStatus.SETTLED
    ) {
      const safeMsg = sanitizeSettlementDiagnosticMessage(permanentRetrievalFailure.message);
      await tx.order.update({
        where: { id: order.id },
        data: {
          stripeSettlementStatus: StripeSettlementStatus.FAILED_PERMANENT,
          stripeSettlementFailedAt: order.stripeSettlementFailedAt ?? new Date(),
          stripeSettlementLockedBy: null,
          stripeSettlementLockedUntil: null,
          stripeSettlementNextAttemptAt: null,
          stripeSettlementLastAttemptAt: new Date(),
          stripeSettlementLastErrorCategory: 'PERMANENT',
          stripeSettlementLastErrorCode: permanentRetrievalFailure.code,
          stripeSettlementLastErrorMessage: safeMsg,
          ...(order.stripeSettledChargeId ? {} : { stripeSettledChargeId: charge.id }),
          ...(rawBalanceTxId && !order.stripeBalanceTransactionId
            ? { stripeBalanceTransactionId: rawBalanceTxId }
            : {}),
        },
      });

      emitSettlementCriticalAlert({
        orderId: order.id,
        orderNumber: order.orderNumber,
        stripeChargeId: charge.id,
        stripeBalanceTransactionId: rawBalanceTxId,
        code: permanentRetrievalFailure.code,
        message: safeMsg,
      });
    }
    return;
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

  const isCompletedSale =
    !hasLatePaymentRefundForPi &&
    !isDifferentPiFromOrder &&
    (order.status === OrderStatus.COMPLETED || Boolean(existingSaleLedger));

  const hasFeeNumber = Boolean(balanceTx && typeof balanceTx.fee === 'number');
  if (isCompletedSale && hasFeeNumber && !order.stripeActualFeeRecordedAt) {
    await recordActualStripeFee(tx, {
      stripeChargeId: charge.id,
      actualFeeInCents: balanceTx!.fee,
      currency: balanceTx!.currency || charge.currency || order.currency,
      orderId: order.id,
    });
    await tx.order.update({
      where: { id: order.id },
      data: {
        stripeActualFeeRecordedAt: new Date(),
        stripeActualFeeInCents: null,
      },
    });
  }

  if (isCompletedSale) {
    if (charge.status === 'succeeded' && isFundsAvailable) {
      if (order.status === OrderStatus.COMPLETED) {
        await reconcileChargeRefundBeforeSettlement(tx, {
          orderId: order.id,
          paymentReference: order.paymentReference,
          charge,
        });
      }

      if (await hasOpenDisputeForOrder(tx, order.id, charge)) {
        await tx.order.update({
          where: { id: order.id },
          data: {
            stripeSettlementStatus: StripeSettlementStatus.PENDING,
            stripeFundsAvailableAt: order.stripeFundsAvailableAt ?? new Date(),
            ...(order.stripeSettledChargeId ? {} : { stripeSettledChargeId: charge.id }),
            ...(rawBalanceTxId && !order.stripeBalanceTransactionId
              ? { stripeBalanceTransactionId: rawBalanceTxId }
              : {}),
            ...(availableOnDate && !order.stripeAvailableOn
              ? { stripeAvailableOn: availableOnDate }
              : {}),
            stripeSettlementNextAttemptAt: new Date(Date.now() + 3_600_000),
          },
        });
      } else {
        await settleOrderEarnings(tx, {
          orderId: order.id,
          stripeChargeId: charge.id,
          stripeBalanceTransactionId: balanceTx?.id,
          availableOn: availableOnDate,
        });
      }
    } else if (
      charge.status === 'failed' &&
      !existingClearedLedger &&
      order.stripeSettlementStatus !== StripeSettlementStatus.SETTLED
    ) {
      await tx.order.update({
        where: { id: order.id },
        data: {
          stripeSettlementStatus: StripeSettlementStatus.FAILED_PERMANENT,
          stripeSettlementFailedAt: order.stripeSettlementFailedAt ?? new Date(),
          stripeSettlementLockedBy: null,
          stripeSettlementLockedUntil: null,
          stripeSettlementNextAttemptAt: null,
          stripeSettlementLastErrorCategory: 'PERMANENT',
          stripeSettlementLastErrorCode: 'CHARGE_NOT_SUCCEEDED',
          stripeSettlementLastErrorMessage: `Stripe charge ${charge.id} status is '${charge.status}'.`,
          ...(order.stripeSettledChargeId ? {} : { stripeSettledChargeId: charge.id }),
        },
      });
    } else if (!existingClearedLedger && order.stripeSettlementStatus !== StripeSettlementStatus.SETTLED) {
      // Persist Stripe identifiers and expected clearing timestamp for recovery worker
      const nowMs = Date.now();
      const nextCheckAt =
        availableOnDate && availableOnDate.getTime() > nowMs
          ? new Date(Math.max(nowMs + 60_000, availableOnDate.getTime()))
          : new Date(nowMs + 5 * 60_000);
      await tx.order.update({
        where: { id: order.id },
        data: {
          ...(order.stripeSettledChargeId ? {} : { stripeSettledChargeId: charge.id }),
          ...(rawBalanceTxId && !order.stripeBalanceTransactionId
            ? { stripeBalanceTransactionId: rawBalanceTxId }
            : {}),
          ...(availableOnDate ? { stripeAvailableOn: availableOnDate } : {}),
          ...(order.organizerNetInCents > 0 && order.paymentProvider === PaymentProvider.STRIPE
            ? {
                stripeSettlementStatus: StripeSettlementStatus.PENDING,
                stripeSettlementNextAttemptAt: nextCheckAt,
              }
            : {}),
        },
      });
    }
  } else if (
    order.status === OrderStatus.PENDING &&
    !hasLatePaymentRefundForPi &&
    !isDifferentPiFromOrder
  ) {
    // Out-of-order charge.updated arrived BEFORE payment_intent.succeeded:
    // Persist funds-available + actual fee metadata on Order without crediting balances yet.
    // Never set stripeFundsAvailableAt if the charge already shows disputed=true or an open dispute exists.
    const updateData: Prisma.OrderUpdateInput = {};
    const disputedOutOfOrder =
      Boolean(charge.disputed) || (await hasOpenDisputeForOrder(tx, order.id, charge));
    if (
      charge.status === 'succeeded' &&
      isFundsAvailable &&
      !disputedOutOfOrder &&
      !order.stripeFundsAvailableAt
    ) {
      updateData.stripeFundsAvailableAt = new Date();
      updateData.stripeSettledChargeId = charge.id;
    }
    if (rawBalanceTxId && !order.stripeBalanceTransactionId) {
      updateData.stripeBalanceTransactionId = rawBalanceTxId;
    }
    if (availableOnDate && !order.stripeAvailableOn) {
      updateData.stripeAvailableOn = availableOnDate;
    }
    if (hasFeeNumber && !order.stripeActualFeeRecordedAt) {
      updateData.stripeActualFeeInCents = balanceTx!.fee;
      updateData.stripeActualFeeCurrency = (
        balanceTx!.currency ||
        charge.currency ||
        order.currency
      ).toUpperCase();
      if (!updateData.stripeSettledChargeId && !order.stripeSettledChargeId) {
        updateData.stripeSettledChargeId = charge.id;
      }
    }
    if (!order.stripeSettledChargeId && !updateData.stripeSettledChargeId) {
      updateData.stripeSettledChargeId = charge.id;
    }
    if (Object.keys(updateData).length > 0) {
      await tx.order.update({
        where: { id: order.id },
        data: updateData,
      });
    }
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

  const hasMoreRefunds = Boolean(charge.refunds?.has_more);
  const chargeRefunds = (charge.refunds?.data || []).map((r) => ({
    id: r.id,
    amount: typeof r.amount === 'number' ? r.amount : -1,
    currency: (r.currency || charge.currency || order?.currency || 'USD').toUpperCase(),
    status: typeof (r as any).status === 'string' ? (r as any).status : null,
    failure_reason: r.failure_reason,
    payment_intent:
      typeof r.payment_intent === 'string'
        ? r.payment_intent
        : (r.payment_intent as Stripe.PaymentIntent)?.id ?? paymentIntentId ?? null,
    metadata: (r.metadata || null) as Record<string, string> | null,
  }));

  const refundIds = chargeRefunds.map((r) => r.id).filter(Boolean);
  const metaOrderRefundIds = chargeRefunds
    .map((r) => r.metadata?.orderRefundId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);

  // Resolve Order strictly via trustworthy refund/PaymentIntent evidence if charge metadata missed it
  if (!order && (paymentIntentId || refundIds.length > 0 || metaOrderRefundIds.length > 0)) {
    const linkedRefund = await tx.orderRefund.findFirst({
      where: {
        OR: [
          ...(paymentIntentId ? [{ stripePaymentIntentId: paymentIntentId }] : []),
          ...(refundIds.length > 0 ? [{ stripeRefundId: { in: refundIds } }] : []),
          ...(metaOrderRefundIds.length > 0 ? [{ id: { in: metaOrderRefundIds } }] : []),
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
    hasMoreRefunds,
    refunds: chargeRefunds,
  });

  if (!order) {
    if (lateReconcile.matchedLatePaymentRefund) {
      return { enqueuedEmail: lateReconcile.enqueuedEmail };
    }
    throw new Error(`[ChargeRefunded] Order not found for charge ${charge.id}; throwing to trigger Stripe webhook retry`);
  }

  // Isolate refund ledger effects by PaymentIntent:
  // Check whether this incoming charge/refund belongs to an OrderRefund OR a distinct PI from the fulfilled Order.
  const orderRefundForIncomingCharge =
    paymentIntentId || refundIds.length > 0 || metaOrderRefundIds.length > 0
      ? await tx.orderRefund.findFirst({
          where: {
            OR: [
              ...(paymentIntentId ? [{ stripePaymentIntentId: paymentIntentId }] : []),
              ...(refundIds.length > 0 ? [{ stripeRefundId: { in: refundIds } }] : []),
              ...(metaOrderRefundIds.length > 0 ? [{ id: { in: metaOrderRefundIds } }] : []),
            ],
          },
          select: { id: true },
        })
      : null;

  const isDifferentPiFromCompletedOrder = Boolean(
    paymentIntentId &&
      order.paymentReference &&
      order.paymentReference !== paymentIntentId
  );

  const saleLedgerEvidence = await tx.financialLedgerEntry.findFirst({
    where: {
      orderId: order.id,
      type: { in: [LedgerEntryType.TICKET_SALE_PENDING, LedgerEntryType.TICKET_SALE_CLEARED] },
    },
    select: { id: true },
  });

  const isLegitimateSaleRefund =
    !orderRefundForIncomingCharge &&
    !isDifferentPiFromCompletedOrder &&
    (Boolean(saleLedgerEvidence) || order.status === OrderStatus.COMPLETED);

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
  const metaOrderRefundId = refund.metadata?.orderRefundId as string | undefined;
  let order = await lockOrderByIdentifier(tx, metaOrderId, paymentIntentId);

  if (!order) {
    const linked = await tx.orderRefund.findFirst({
      where: {
        OR: [
          ...(refund.id ? [{ stripeRefundId: refund.id }] : []),
          ...(paymentIntentId ? [{ stripePaymentIntentId: paymentIntentId }] : []),
          ...(metaOrderRefundId ? [{ id: metaOrderRefundId }] : []),
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
    hasMoreRefunds: false,
    refunds: [
      {
        id: refund.id,
        amount: refund.amount,
        currency: (refund.currency || order?.currency || 'USD').toUpperCase(),
        status: typeof refund.status === 'string' ? refund.status : null,
        failure_reason: refund.failure_reason,
        payment_intent: paymentIntentId ?? null,
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
): Promise<{ shouldWakeSettlement: boolean }> {
  const chargeId = typeof dispute.charge === 'string'
    ? dispute.charge
    : (dispute.charge as Stripe.Charge)?.id;

  let order: any = null;

  if (chargeId) {
    // 1. Try finding by existing financial ledger entry or settledChargeId for this charge
    const existingLedger = await tx.financialLedgerEntry.findFirst({
      where: { stripeReferenceId: chargeId },
    });
    if (existingLedger?.orderId) {
      order = await tx.order.findUnique({
        where: { id: existingLedger.orderId },
      });
    }

    if (!order) {
      order = await tx.order.findFirst({
        where: { stripeSettledChargeId: chargeId },
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

  if (order?.id) {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${order.id} FOR UPDATE`;
    order = await tx.order.findUnique({ where: { id: order.id } });
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

  // When a dispute closes as won or lost on a settlement-pending order, nudge recovery check
  if (
    order?.id &&
    (status === 'won' || status === 'lost') &&
    order.status === OrderStatus.COMPLETED &&
    order.stripeSettlementStatus === StripeSettlementStatus.PENDING
  ) {
    await tx.order.update({
      where: { id: order.id },
      data: {
        stripeSettlementNextAttemptAt: new Date(),
      },
    });
    return { shouldWakeSettlement: true };
  }

  return { shouldWakeSettlement: false };
}

async function handleTransferEvent(
  tx: Prisma.TransactionClient,
  eventType: string,
  transfer: Stripe.Transfer
): Promise<void> {
  const destId =
    typeof transfer.destination === 'string'
      ? transfer.destination
      : (transfer.destination as Stripe.Account | null)?.id || null;
  const metaTransferId = transfer.metadata?.transferId || null;
  const transferGroup = transfer.transfer_group || transfer.metadata?.transferNumber || null;

  // Lock OrganizerTransfer FOR UPDATE first: lookup by stripeTransferId, then durable metadata/transfer_group fallback
  let lockedTransfers = await tx.$queryRaw<
    Array<{
      id: string;
      organizerId: string;
      stripeAccountId: string;
      status: TransferStatus;
      amountInCents: number;
      reversedAmountInCents: number;
      currency: string;
      transferNumber: string;
      stripeTransferId: string | null;
    }>
  >`
    SELECT id, "organizerId", "stripeAccountId", status, "amountInCents", "reversedAmountInCents", currency, "transferNumber", "stripeTransferId"
    FROM "OrganizerTransfer"
    WHERE "stripeTransferId" = ${transfer.id}
    FOR UPDATE
  `;

  if (!lockedTransfers[0] && (metaTransferId || transferGroup)) {
    lockedTransfers = await tx.$queryRaw<
      Array<{
        id: string;
        organizerId: string;
        stripeAccountId: string;
        status: TransferStatus;
        amountInCents: number;
        reversedAmountInCents: number;
        currency: string;
        transferNumber: string;
        stripeTransferId: string | null;
      }>
    >`
      SELECT id, "organizerId", "stripeAccountId", status, "amountInCents", "reversedAmountInCents", currency, "transferNumber", "stripeTransferId"
      FROM "OrganizerTransfer"
      WHERE (
        (${metaTransferId}::text IS NOT NULL AND id = ${metaTransferId})
        OR (${metaTransferId}::text IS NULL AND ${transferGroup}::text IS NOT NULL AND "transferNumber" = ${transferGroup})
      )
      AND "amountInCents" = ${transfer.amount}
      AND UPPER(currency) = ${String(transfer.currency || 'USD').toUpperCase()}
      ${destId ? Prisma.sql`AND "stripeAccountId" = ${destId}` : Prisma.empty}
      FOR UPDATE
    `;
  }

  let existing = lockedTransfers[0];
  if (!existing) {
    return;
  }

  const webhookAmount = transfer.amount;
  const webhookCurrency = String(transfer.currency || '').trim().toUpperCase();
  const existingCurrency = existing.currency.trim().toUpperCase();
  if (
    typeof webhookAmount !== 'number' ||
    webhookAmount !== existing.amountInCents ||
    !webhookCurrency ||
    webhookCurrency !== existingCurrency
  ) {
    emitTransferCriticalAlert({
      transferId: existing.id,
      transferNumber: existing.transferNumber,
      organizerId: existing.organizerId,
      stripeTransferId: transfer.id,
      code: 'TRANSFER_AMOUNT_CURRENCY_MISMATCH',
      message: `Webhook ${eventType} amount/currency (${String(webhookAmount)} ${webhookCurrency || 'UNKNOWN'}) mismatches local transfer #${existing.transferNumber} (${existing.amountInCents} ${existingCurrency}).`,
    });
    return;
  }

  // Reconcile pending/ambiguous transfers when transfer.created arrives (or if transfer.updated/reversed beats API commit)
  if (existing.status === TransferStatus.PENDING) {
    const finalized = await finalizeTransferSucceededInTx(tx, {
      transferId: existing.id,
      stripeTransfer: transfer,
    });
    if (
      finalized.outcome === 'conflictAfterFailure' ||
      finalized.outcome === 'amountCurrencyMismatch' ||
      !finalized.transfer
    ) {
      return;
    }
    existing = {
      ...existing,
      status: finalized.transfer.status,
      stripeTransferId: finalized.transfer.stripeTransferId,
      reversedAmountInCents: finalized.transfer.reversedAmountInCents ?? 0,
    };
  }

  if (existing.status === TransferStatus.FAILED) {
    return;
  }

  // Reversal handling for both transfer.reversed and transfer.updated
  const rawAmountReversed = (transfer as any).amount_reversed;
  const hasNumericAmountReversed =
    typeof rawAmountReversed === 'number' && Number.isFinite(rawAmountReversed);

  let authoritativeCumulativeReversed: number;
  if (hasNumericAmountReversed) {
    authoritativeCumulativeReversed = Math.max(
      0,
      Math.min(existing.amountInCents, Math.trunc(rawAmountReversed))
    );
  } else if (eventType === 'transfer.reversed') {
    // Explicit legacy fixture compatibility: older tests send { id, amount, currency } without amount_reversed
    authoritativeCumulativeReversed =
      (transfer as any).reversed === false ? 0 : existing.amountInCents;
  } else if (eventType === 'transfer.updated' && (transfer as any).reversed === true) {
    authoritativeCumulativeReversed = existing.amountInCents;
  } else {
    return;
  }

  const prevReversed = Math.max(0, existing.reversedAmountInCents ?? 0);
  const delta = Math.min(
    authoritativeCumulativeReversed - prevReversed,
    existing.amountInCents - prevReversed
  );

  // Ignore duplicates, zero-delta updates, and out-of-order stale smaller cumulative events
  if (delta <= 0) {
    return;
  }

  const newCumulativeReversed = prevReversed + delta;
  const reversalStepKey = `tr_rev_${existing.id}_${prevReversed}_${newCumulativeReversed}`;

  // Canonical lock order preserved: OrganizerTransfer was locked above; now lock OrganizerBalance FOR UPDATE
  await getOrCreateOrganizerBalance(tx, existing.organizerId, existing.currency);

  await tx.organizerTransfer.update({
    where: { id: existing.id },
    data: {
      reversedAmountInCents: newCumulativeReversed,
      status:
        newCumulativeReversed >= existing.amountInCents
          ? TransferStatus.REVERSED
          : TransferStatus.SUCCEEDED,
    },
  });

  // Restore exact reversal delta: decrement transferred balance, increment available balance
  await tx.organizerBalance.update({
    where: { userId: existing.organizerId },
    data: {
      transferredBalanceInCents: { decrement: delta },
      availableBalanceInCents: { increment: delta },
    },
  });

  const isPartial = newCumulativeReversed < existing.amountInCents;
  const revLabel = isPartial ? 'partially reversed' : 'reversed';

  await tx.financialLedgerEntry.create({
    data: {
      type: LedgerEntryType.ADJUSTMENT,
      balanceType: LedgerBalanceType.TRANSFERRED,
      amountInCents: -delta,
      currency: existing.currency.toUpperCase(),
      organizerId: existing.organizerId,
      transferId: existing.id,
      stripeReferenceId: transfer.id,
      description: `Stripe transfer ${revLabel} ($${(delta / 100).toFixed(2)}, cumulative $${(newCumulativeReversed / 100).toFixed(2)}) for transfer #${existing.transferNumber}`,
      metadata: {
        transferId: existing.id,
        transferNumber: existing.transferNumber,
        stripeTransferId: transfer.id,
        reversalStepKey,
        previousReversedAmountInCents: prevReversed,
        cumulativeReversedAmountInCents: newCumulativeReversed,
        deltaInCents: delta,
      },
    },
  });

  await tx.financialLedgerEntry.create({
    data: {
      type: LedgerEntryType.ADJUSTMENT,
      balanceType: LedgerBalanceType.AVAILABLE,
      amountInCents: delta,
      currency: existing.currency.toUpperCase(),
      organizerId: existing.organizerId,
      transferId: existing.id,
      stripeReferenceId: transfer.id,
      description: `Restored available balance ($${(delta / 100).toFixed(2)}) for ${revLabel} transfer #${existing.transferNumber}`,
      metadata: {
        transferId: existing.id,
        transferNumber: existing.transferNumber,
        stripeTransferId: transfer.id,
        reversalStepKey,
        previousReversedAmountInCents: prevReversed,
        cumulativeReversedAmountInCents: newCumulativeReversed,
        deltaInCents: delta,
      },
    },
  });
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
  account: Stripe.Account,
  eventCreated?: number
): Promise<void> {
  const lockedUsers = await tx.$queryRaw<
    Array<{
      id: string;
      stripeAccountCountry: string | null;
      stripeAccountEventCreatedAt: number | null;
      stripeAccountCapabilities: Prisma.JsonValue | null;
    }>
  >`
    SELECT id, "stripeAccountCountry", "stripeAccountEventCreatedAt", "stripeAccountCapabilities"
    FROM "User"
    WHERE "stripeAccountId" = ${account.id}
    FOR UPDATE
  `;
  const user = lockedUsers[0];

  if (!user) {
    return;
  }

  // Prevent stale out-of-order webhooks from overwriting newer capability or restriction state
  const isStaleEvent =
    typeof eventCreated === 'number' &&
    typeof user.stripeAccountEventCreatedAt === 'number' &&
    eventCreated < user.stripeAccountEventCreatedAt;

  if (!isStaleEvent) {
    const existingCaps =
      user.stripeAccountCapabilities && typeof user.stripeAccountCapabilities === 'object'
        ? (user.stripeAccountCapabilities as Record<string, string>)
        : {};
    const incomingCaps = account.capabilities
      ? {
          ...existingCaps,
          ...(account.capabilities.transfers ? { transfers: account.capabilities.transfers } : {}),
          ...(account.capabilities.card_payments
            ? { card_payments: account.capabilities.card_payments }
            : {}),
        }
      : existingCaps;

    const transfersCap =
      account.capabilities?.transfers ??
      (incomingCaps.transfers || null);

    await tx.user.update({
      where: { id: user.id },
      data: {
        ...(account.country ? { stripeAccountCountry: account.country.toUpperCase() } : {}),
        ...(account.default_currency
          ? { stripeAccountDefaultCurrency: account.default_currency.toUpperCase() }
          : {}),
        stripeAccountDetailsSubmitted: Boolean(account.details_submitted),
        stripeAccountChargesEnabled: Boolean(account.charges_enabled),
        stripeAccountPayoutsEnabled: Boolean(account.payouts_enabled),
        stripeAccountTransfersCapability: transfersCap,
        stripeAccountDisabledReason: account.requirements?.disabled_reason || null,
        stripeAccountCapabilities: incomingCaps,
        stripeAccountRequirements: {
          currentlyDue: account.requirements?.currently_due || [],
          pastDue: account.requirements?.past_due || [],
          eventuallyDue: account.requirements?.eventually_due || [],
          pendingVerification: account.requirements?.pending_verification || [],
          disabledReason: account.requirements?.disabled_reason || null,
        },
        stripeAccountEventCreatedAt:
          typeof eventCreated === 'number' ? eventCreated : user.stripeAccountEventCreatedAt,
        stripeAccountSyncedAt: new Date(),
      },
    });
  }

  // If Stripe account has bank account, reflect safe masked details in OrganizerPayoutDetails
  const bankAccounts = (account.external_accounts?.data || []).filter(
    (e) => e.object === 'bank_account'
  ) as Stripe.BankAccount[];

  if (bankAccounts.length > 0 && !isStaleEvent) {
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

async function handleCapabilityUpdated(
  tx: Prisma.TransactionClient,
  capability: Stripe.Capability,
  stripeAccountId?: string,
  eventCreated?: number
): Promise<void> {
  if (!stripeAccountId) {
    return;
  }

  const lockedUsers = await tx.$queryRaw<
    Array<{
      id: string;
      stripeAccountEventCreatedAt: number | null;
      stripeAccountCapabilities: Prisma.JsonValue | null;
      stripeAccountDisabledReason: string | null;
      stripeAccountRequirements: Prisma.JsonValue | null;
    }>
  >`
    SELECT id, "stripeAccountEventCreatedAt", "stripeAccountCapabilities", "stripeAccountDisabledReason", "stripeAccountRequirements"
    FROM "User"
    WHERE "stripeAccountId" = ${stripeAccountId}
    FOR UPDATE
  `;
  const user = lockedUsers[0];
  if (!user) {
    return;
  }

  if (
    typeof eventCreated === 'number' &&
    typeof user.stripeAccountEventCreatedAt === 'number' &&
    eventCreated < user.stripeAccountEventCreatedAt
  ) {
    return;
  }

  const existingCaps =
    user.stripeAccountCapabilities && typeof user.stripeAccountCapabilities === 'object'
      ? { ...(user.stripeAccountCapabilities as Record<string, string>) }
      : {};
  existingCaps[capability.id] = capability.status;

  const capReqs = capability.requirements;
  const existingReqs =
    user.stripeAccountRequirements && typeof user.stripeAccountRequirements === 'object'
      ? { ...(user.stripeAccountRequirements as Record<string, any>) }
      : {};

  if (capReqs) {
    existingReqs.currentlyDue = capReqs.currently_due || existingReqs.currentlyDue || [];
    existingReqs.pastDue = capReqs.past_due || existingReqs.pastDue || [];
    existingReqs.eventuallyDue = capReqs.eventually_due || existingReqs.eventuallyDue || [];
    existingReqs.pendingVerification =
      capReqs.pending_verification || existingReqs.pendingVerification || [];
    existingReqs.disabledReason = capReqs.disabled_reason ?? null;
  }

  await tx.user.update({
    where: { id: user.id },
    data: {
      stripeAccountCapabilities: existingCaps,
      ...(capability.id === 'transfers'
        ? { stripeAccountTransfersCapability: capability.status }
        : {}),
      ...(capReqs
        ? {
            stripeAccountDisabledReason: capReqs.disabled_reason ?? null,
            stripeAccountRequirements: existingReqs,
          }
        : {}),
      stripeAccountEventCreatedAt:
        typeof eventCreated === 'number' ? eventCreated : user.stripeAccountEventCreatedAt,
      stripeAccountSyncedAt: new Date(),
    },
  });

  if (capability.id === 'transfers' && capability.status !== 'active') {
    console.warn('[StripeConnect][CapabilityRestricted]', {
      userId: user.id,
      capability: capability.id,
      status: capability.status,
      disabledReason: sanitizeTransferDiagnosticMessage(capReqs?.disabled_reason || 'none'),
    });
  }
}
