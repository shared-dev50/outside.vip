import crypto from 'crypto';
import { Prisma, LedgerEntryType, LedgerBalanceType, PaymentProvider, StripeSettlementStatus } from '@prisma/client';
import type Stripe from 'stripe';
import { prisma } from '../../db/prisma.js';
import { calculateCheckoutFeeBreakdown } from '../checkout/checkout.financials.js';

export interface RecordTicketSaleParams {
  orderId: string;
  paymentIntentId?: string;
  stripeChargeId?: string;
  autoSettle?: boolean;
}

export interface SettleOrderEarningsParams {
  orderId: string;
  stripeChargeId?: string;
  stripeBalanceTransactionId?: string;
  availableOn?: Date | null;
  fundsAvailableAt?: Date;
}

export interface RecordRefundParams {
  orderId: string;
  amountInCents: number;
  stripeRefundId?: string;
  stripeChargeId?: string;
  reason?: string;
}

export interface RecordDisputeParams {
  stripeDisputeId: string;
  stripeChargeId?: string;
  orderId?: string;
  amountInCents: number;
  status: 'needs_response' | 'under_review' | 'won' | 'lost' | 'warning_needs_response';
  reason?: string;
}

/**
 * Retrieves or initializes the single OrganizerBalance record for a user,
 * acquiring an exclusive PostgreSQL row lock (FOR UPDATE) inside the caller's transaction.
 */
export async function getOrCreateOrganizerBalance(
  tx: Prisma.TransactionClient,
  userId: string,
  currency = 'USD'
) {
  await tx.$executeRaw`
    INSERT INTO "OrganizerBalance" (
      id,
      "userId",
      "pendingBalanceInCents",
      "availableBalanceInCents",
      "transferredBalanceInCents",
      currency,
      "createdAt",
      "updatedAt"
    )
    VALUES (
      ${crypto.randomUUID()},
      ${userId},
      0,
      0,
      0,
      ${currency.toUpperCase()},
      (NOW() AT TIME ZONE 'UTC'),
      (NOW() AT TIME ZONE 'UTC')
    )
    ON CONFLICT ("userId") DO NOTHING
  `;

  const locked = await tx.$queryRaw<
    Array<{
      id: string;
      userId: string;
      pendingBalanceInCents: number;
      availableBalanceInCents: number;
      transferredBalanceInCents: number;
      currency: string;
      createdAt: Date;
      updatedAt: Date;
    }>
  >`
    SELECT
      id,
      "userId",
      "pendingBalanceInCents",
      "availableBalanceInCents",
      "transferredBalanceInCents",
      currency,
      "createdAt",
      "updatedAt"
    FROM "OrganizerBalance"
    WHERE "userId" = ${userId}
    FOR UPDATE
  `;

  if (!locked[0]) {
    throw new Error(`OrganizerBalance record missing after upsert for user ${userId}`);
  }

  return locked[0];
}

// Records pending earnings, platform fees, service fees, and estimated processing fees for a completed order.
export async function recordTicketSalePending(
  tx: Prisma.TransactionClient,
  params: RecordTicketSaleParams
): Promise<void> {
  const { orderId, paymentIntentId, stripeChargeId, autoSettle = false } = params;

  await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;

  const order = await tx.order.findUnique({
    where: { id: orderId },
    include: {
      items: true,
      event: { select: { id: true, organizerId: true, title: true } },
    },
  });

  if (!order) {
    throw new Error(`Order ${orderId} not found for ledger recording.`);
  }

  const organizerId = order.event.organizerId;
  const refKey = `order_${order.id}_pending_sale`;

  const existingPending = await tx.financialLedgerEntry.findFirst({
    where: {
      orderId: order.id,
      type: LedgerEntryType.TICKET_SALE_PENDING,
    },
  });

  if (existingPending) {
    if (autoSettle) {
      await settleOrderEarnings(tx, { orderId, stripeChargeId });
    }
    return;
  }

  const feeBreakdown = calculateCheckoutFeeBreakdown(order.items);
  const organizerEarnings = order.organizerNetInCents > 0
    ? order.organizerNetInCents
    : feeBreakdown.organizerEarningsInCents;
  const platformFee = feeBreakdown.platformFeeInCents;
  const serviceFee = feeBreakdown.serviceFeeInCents;
  const stripeEstFee = feeBreakdown.processingFeeInCents;

  if (organizerEarnings > 0) {
    await getOrCreateOrganizerBalance(tx, organizerId, order.currency);

    await tx.financialLedgerEntry.create({
      data: {
        type: LedgerEntryType.TICKET_SALE_PENDING,
        balanceType: LedgerBalanceType.PENDING,
        amountInCents: organizerEarnings,
        currency: order.currency.toUpperCase(),
        organizerId,
        eventId: order.eventId,
        orderId: order.id,
        stripeReferenceId: stripeChargeId || paymentIntentId || null,
        description: `Ticket sale earnings (pending clearance) for order #${order.orderNumber} - ${order.event.title}`,
        metadata: {
          idempotencyKey: refKey,
          orderNumber: order.orderNumber,
          buyerTotalInCents: order.totalInCents,
          organizerEarningsInCents: organizerEarnings,
        },
      },
    });

    await tx.organizerBalance.update({
      where: { userId: organizerId },
      data: {
        pendingBalanceInCents: { increment: organizerEarnings },
      },
    });

    if (
      !autoSettle &&
      order.paymentProvider === PaymentProvider.STRIPE &&
      order.stripeSettlementStatus === null
    ) {
      await tx.order.update({
        where: { id: order.id },
        data: {
          stripeSettlementStatus: StripeSettlementStatus.PENDING,
          ...(stripeChargeId && !order.stripeSettledChargeId
            ? { stripeSettledChargeId: stripeChargeId }
            : {}),
          ...(order.stripeSettlementNextAttemptAt
            ? {}
            : { stripeSettlementNextAttemptAt: order.stripeAvailableOn ?? new Date(Date.now() + 60_000) }),
        },
      });
    }
  }

  if (platformFee > 0) {
    await tx.financialLedgerEntry.create({
      data: {
        type: LedgerEntryType.PLATFORM_FEE,
        balanceType: LedgerBalanceType.PLATFORM_REVENUE,
        amountInCents: platformFee,
        currency: order.currency.toUpperCase(),
        organizerId,
        eventId: order.eventId,
        orderId: order.id,
        stripeReferenceId: stripeChargeId || paymentIntentId || null,
        description: `Outside.vip 10% platform fee on order #${order.orderNumber}`,
        metadata: {
          idempotencyKey: `order_${order.id}_platform_fee`,
          rate: '10%',
          amountInCents: platformFee,
        },
      },
    });
  }

  if (serviceFee > 0) {
    await tx.financialLedgerEntry.create({
      data: {
        type: LedgerEntryType.SERVICE_FEE,
        balanceType: LedgerBalanceType.PLATFORM_REVENUE,
        amountInCents: serviceFee,
        currency: order.currency.toUpperCase(),
        organizerId,
        eventId: order.eventId,
        orderId: order.id,
        stripeReferenceId: stripeChargeId || paymentIntentId || null,
        description: `Outside.vip ticket service fee ($0.95/tkt) on order #${order.orderNumber}`,
        metadata: {
          idempotencyKey: `order_${order.id}_service_fee`,
          ticketQuantity: feeBreakdown.totalTicketQuantity,
          rateCentsPerTicket: 95,
          amountInCents: serviceFee,
        },
      },
    });
  }

  if (stripeEstFee > 0) {
    await tx.financialLedgerEntry.create({
      data: {
        type: LedgerEntryType.STRIPE_PROCESSING_FEE,
        balanceType: LedgerBalanceType.PLATFORM_REVENUE,
        amountInCents: stripeEstFee,
        currency: order.currency.toUpperCase(),
        organizerId,
        eventId: order.eventId,
        orderId: order.id,
        stripeReferenceId: stripeChargeId || paymentIntentId || null,
        description: `Estimated Stripe processing fee (2.9% + $0.30) for order #${order.orderNumber}`,
        metadata: {
          idempotencyKey: `order_${order.id}_stripe_fee_est`,
          amountInCents: stripeEstFee,
        },
      },
    });
  }

  if (autoSettle) {
    await settleOrderEarnings(tx, { orderId, stripeChargeId });
  }
}

/**
 * Returns true if the given order currently has an unresolved Stripe dispute hold.
 */
export async function hasOpenDisputeForOrder(
  tx: Prisma.TransactionClient,
  orderId: string,
  charge?: Pick<Stripe.Charge, 'disputed'> | null
): Promise<boolean> {
  const disputeEntries = await tx.financialLedgerEntry.findMany({
    where: {
      orderId,
      type: {
        in: [
          LedgerEntryType.DISPUTE_HOLD,
          LedgerEntryType.DISPUTE_WON,
          LedgerEntryType.DISPUTE_LOST,
        ],
      },
    },
    select: {
      type: true,
      stripeReferenceId: true,
    },
  });

  const closedDisputeIds = new Set<string>();
  for (const entry of disputeEntries) {
    if (
      (entry.type === LedgerEntryType.DISPUTE_WON ||
        entry.type === LedgerEntryType.DISPUTE_LOST) &&
      entry.stripeReferenceId
    ) {
      closedDisputeIds.add(entry.stripeReferenceId);
    }
  }

  for (const entry of disputeEntries) {
    if (
      entry.type === LedgerEntryType.DISPUTE_HOLD &&
      (!entry.stripeReferenceId || !closedDisputeIds.has(entry.stripeReferenceId))
    ) {
      return true;
    }
  }

  // Out-of-order protection: Stripe reports charge.disputed=true before charge.dispute.created arrived
  if (charge?.disputed && closedDisputeIds.size === 0) {
    return true;
  }

  return false;
}

// Clears pending earnings to available balance once settled, reconciling pre-settlement pending refunds
export async function settleOrderEarnings(
  tx: Prisma.TransactionClient,
  params: SettleOrderEarningsParams
): Promise<void> {
  const { orderId, stripeChargeId, stripeBalanceTransactionId, availableOn, fundsAvailableAt } = params;

  await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;

  const order = await tx.order.findUnique({
    where: { id: orderId },
    include: {
      event: { select: { id: true, organizerId: true, title: true } },
    },
  });

  if (!order) {
    throw new Error(`Order ${orderId} not found for settlement.`);
  }

  const organizerId = order.event.organizerId;
  const organizerEarnings = order.organizerNetInCents;

  if (organizerEarnings <= 0) {
    return;
  }

  const existingCleared = await tx.financialLedgerEntry.findFirst({
    where: {
      orderId: order.id,
      type: LedgerEntryType.TICKET_SALE_CLEARED,
    },
  });

  if (existingCleared) {
    if (
      order.stripeSettlementStatus !== StripeSettlementStatus.SETTLED ||
      order.stripeSettlementLockedBy !== null
    ) {
      await tx.order.update({
        where: { id: order.id },
        data: {
          stripeSettlementStatus: StripeSettlementStatus.SETTLED,
          stripeFundsAvailableAt: order.stripeFundsAvailableAt ?? fundsAvailableAt ?? new Date(),
          ...(stripeChargeId && !order.stripeSettledChargeId
            ? { stripeSettledChargeId: stripeChargeId }
            : {}),
          ...(stripeBalanceTransactionId && !order.stripeBalanceTransactionId
            ? { stripeBalanceTransactionId }
            : {}),
          ...(availableOn && !order.stripeAvailableOn ? { stripeAvailableOn: availableOn } : {}),
          stripeSettlementLockedBy: null,
          stripeSettlementLockedUntil: null,
          stripeSettlementNextAttemptAt: null,
          stripeSettlementLastErrorCategory: null,
          stripeSettlementLastErrorCode: null,
          stripeSettlementLastErrorMessage: null,
        },
      });
    }
    return;
  }

  // If settleOrderEarnings was called out-of-order before recordTicketSalePending,
  // establish the initial pending ledger entry and pending balance first
  const existingPending = await tx.financialLedgerEntry.findFirst({
    where: {
      orderId: order.id,
      type: LedgerEntryType.TICKET_SALE_PENDING,
    },
  });

  if (!existingPending) {
    await recordTicketSalePending(tx, {
      orderId: order.id,
      stripeChargeId,
      autoSettle: false,
    });
  }

  const balance = await getOrCreateOrganizerBalance(tx, organizerId, order.currency);

  // Sum PENDING entries for this order so any pre-settlement REFUND_PENDING deductions
  // reduce what clears to available (preventing refunded funds from becoming withdrawable).
  const pendingOrderEntries = await tx.financialLedgerEntry.findMany({
    where: {
      orderId: order.id,
      balanceType: LedgerBalanceType.PENDING,
    },
    select: {
      amountInCents: true,
    },
  });
  const remainingOrderPendingInCents = pendingOrderEntries.reduce(
    (sum, e) => sum + e.amountInCents,
    0
  );
  const settleAmountInCents = Math.max(
    0,
    Math.min(organizerEarnings, remainingOrderPendingInCents)
  );
  const decrementPending =
    settleAmountInCents > 0
      ? Math.min(balance.pendingBalanceInCents, settleAmountInCents)
      : 0;

  if (settleAmountInCents > 0) {
    await tx.organizerBalance.update({
      where: { userId: organizerId },
      data: {
        pendingBalanceInCents: { decrement: decrementPending },
        availableBalanceInCents: { increment: settleAmountInCents },
      },
    });

    if (decrementPending > 0) {
      await tx.financialLedgerEntry.create({
        data: {
          type: LedgerEntryType.ADJUSTMENT,
          balanceType: LedgerBalanceType.PENDING,
          amountInCents: -decrementPending,
          currency: order.currency.toUpperCase(),
          organizerId,
          eventId: order.eventId,
          orderId: order.id,
          stripeReferenceId: stripeChargeId || null,
          description: `Pending balance cleared to available for order #${order.orderNumber}`,
          metadata: {
            idempotencyKey: `order_${order.id}_settle_pending_cleared`,
            orderNumber: order.orderNumber,
            clearedAmountInCents: decrementPending,
          },
        },
      });
    }
  }

  await tx.financialLedgerEntry.create({
    data: {
      type: LedgerEntryType.TICKET_SALE_CLEARED,
      balanceType: LedgerBalanceType.AVAILABLE,
      amountInCents: settleAmountInCents,
      currency: order.currency.toUpperCase(),
      organizerId,
      eventId: order.eventId,
      orderId: order.id,
      stripeReferenceId: stripeChargeId || null,
      description:
        settleAmountInCents > 0
          ? `Earnings cleared and available for withdrawal for order #${order.orderNumber}`
          : `Order #${order.orderNumber} finalized at $0.00 after pre-settlement refund`,
      metadata: {
        idempotencyKey: `order_${order.id}_settle_cleared`,
        orderNumber: order.orderNumber,
        settledAmountInCents: settleAmountInCents,
        preSettlementRefundDeductedInCents: Math.max(0, organizerEarnings - settleAmountInCents),
      },
    },
  });

  await tx.order.update({
    where: { id: order.id },
    data: {
      stripeSettlementStatus: StripeSettlementStatus.SETTLED,
      stripeFundsAvailableAt: order.stripeFundsAvailableAt ?? fundsAvailableAt ?? new Date(),
      ...(stripeChargeId && !order.stripeSettledChargeId
        ? { stripeSettledChargeId: stripeChargeId }
        : {}),
      ...(stripeBalanceTransactionId && !order.stripeBalanceTransactionId
        ? { stripeBalanceTransactionId }
        : {}),
      ...(availableOn && !order.stripeAvailableOn ? { stripeAvailableOn: availableOn } : {}),
      stripeSettlementLockedBy: null,
      stripeSettlementLockedUntil: null,
      stripeSettlementNextAttemptAt: null,
      stripeSettlementLastErrorCategory: null,
      stripeSettlementLastErrorCode: null,
      stripeSettlementLastErrorMessage: null,
    },
  });

  // Automatically offset any outstanding RECOVERABLE liabilities from newly cleared funds
  if (settleAmountInCents > 0) {
    await recoverOrganizerLiabilitiesInTx(tx, {
      organizerId,
      orderId: order.id,
      stripeReferenceId: stripeChargeId || undefined,
      idempotencyKey: `order_${order.id}_recover_liability`,
      source: 'AVAILABLE_BALANCE',
      reason: `Recovered outstanding liability upon settlement of order #${order.orderNumber}`,
    });
  }
}

/**
 * Records actual Stripe processing fees upon receipt of Stripe balance transaction.
 * Stored as LedgerBalanceType.PLATFORM_EXPENSE so buyer-collected fee estimates (PLATFORM_REVENUE)
 * and actual Stripe costs are never double-counted as positive platform revenue.
 */
export async function recordActualStripeFee(
  tx: Prisma.TransactionClient,
  params: {
    stripeChargeId: string;
    actualFeeInCents: number;
    currency: string;
    orderId?: string;
  }
): Promise<void> {
  const { stripeChargeId, actualFeeInCents, currency, orderId } = params;

  const existingFeeEntries = await tx.financialLedgerEntry.findMany({
    where: {
      ...(orderId ? { orderId } : { stripeReferenceId: stripeChargeId }),
      type: LedgerEntryType.STRIPE_PROCESSING_FEE,
    },
    select: { id: true, metadata: true },
  });
  if (existingFeeEntries.some((e) => (e.metadata as any)?.isActualReconciliation === true)) {
    return;
  }

  let organizerId: string | null = null;
  let eventId: string | null = null;

  if (orderId) {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { event: true },
    });
    if (order) {
      organizerId = order.event.organizerId;
      eventId = order.eventId;
    }
  }

  if (!organizerId) {
    const entry = await tx.financialLedgerEntry.findFirst({
      where: { stripeReferenceId: stripeChargeId },
    });
    if (entry) {
      organizerId = entry.organizerId;
      eventId = entry.eventId;
    }
  }

  if (!organizerId) {
    return;
  }

  await tx.financialLedgerEntry.create({
    data: {
      type: LedgerEntryType.STRIPE_PROCESSING_FEE,
      balanceType: LedgerBalanceType.PLATFORM_EXPENSE,
      amountInCents: actualFeeInCents,
      currency: (currency || 'USD').toUpperCase(),
      organizerId,
      eventId,
      orderId,
      stripeReferenceId: stripeChargeId,
      description: `Reconciled Stripe processing fee expense of $${(actualFeeInCents / 100).toFixed(2)}`,
      metadata: {
        isActualReconciliation: true,
        actualFeeInCents,
      },
    },
  });
}

/**
 * Reconciles missed or out-of-order Stripe charge refunds into the ledger prior to settlement.
 * Caller MUST already hold Order FOR UPDATE.
 */
export async function reconcileChargeRefundBeforeSettlement(
  tx: Prisma.TransactionClient,
  params: {
    orderId: string;
    paymentReference?: string | null;
    charge: Pick<Stripe.Charge, 'id' | 'amount_refunded' | 'refunds'>;
  }
): Promise<void> {
  const { orderId, paymentReference, charge } = params;
  if (typeof charge.amount_refunded !== 'number' || charge.amount_refunded <= 0) {
    return;
  }

  const hasLateRefund = paymentReference
    ? await tx.orderRefund.findUnique({
        where: { stripePaymentIntentId: paymentReference },
        select: { id: true },
      })
    : null;

  if (hasLateRefund) {
    return;
  }

  const singleStripeRefundId =
    charge.refunds?.data?.length === 1 ? charge.refunds.data[0].id : undefined;
  await recordRefundLedger(tx, {
    orderId,
    amountInCents: charge.amount_refunded,
    stripeRefundId: singleStripeRefundId,
    stripeChargeId: charge.id,
    reason: 'Stripe charge refund reconciled prior to settlement',
  });
}

/**
 * Returns the net outstanding recoverable liability in positive cents from signed RECOVERABLE entries.
 * Debt entries carry negative amounts (-X) and recovery offsets carry positive amounts (+Y).
 */
export async function getOutstandingRecoverableInCents(
  tx: Prisma.TransactionClient,
  organizerId: string
): Promise<number> {
  const recoverableEntries = await tx.financialLedgerEntry.findMany({
    where: {
      organizerId,
      balanceType: LedgerBalanceType.RECOVERABLE,
    },
    select: { amountInCents: true },
  });
  const signedSum = recoverableEntries.reduce((sum, e) => sum + e.amountInCents, 0);
  return Math.max(0, -signedSum);
}

/**
 * Applies an idempotent offset against an organizer's outstanding RECOVERABLE liability,
 * either from their internal available balance or from an external recovery payment/adjustment.
 */
export async function recoverOrganizerLiabilitiesInTx(
  tx: Prisma.TransactionClient,
  params: {
    organizerId: string;
    maxAmountInCents?: number;
    orderId?: string;
    stripeReferenceId?: string;
    idempotencyKey?: string;
    source?: 'AVAILABLE_BALANCE' | 'EXTERNAL_RECOVERY';
    reason?: string;
  }
): Promise<{
  recoveredInCents: number;
  remainingRecoverableInCents: number;
  duplicate: boolean;
}> {
  const {
    organizerId,
    maxAmountInCents,
    orderId,
    stripeReferenceId,
    idempotencyKey,
    source = 'AVAILABLE_BALANCE',
    reason,
  } = params;

  const balance = await getOrCreateOrganizerBalance(tx, organizerId);

  if (idempotencyKey) {
    const existingOffsets = await tx.financialLedgerEntry.findMany({
      where: {
        organizerId,
        balanceType: LedgerBalanceType.RECOVERABLE,
        type: LedgerEntryType.ADJUSTMENT,
      },
      select: { metadata: true },
    });
    if (existingOffsets.some((e) => (e.metadata as any)?.idempotencyKey === idempotencyKey)) {
      const remainingRecoverableInCents = await getOutstandingRecoverableInCents(tx, organizerId);
      return {
        recoveredInCents: 0,
        remainingRecoverableInCents,
        duplicate: true,
      };
    }
  }

  const outstanding = await getOutstandingRecoverableInCents(tx, organizerId);
  if (outstanding <= 0) {
    return {
      recoveredInCents: 0,
      remainingRecoverableInCents: 0,
      duplicate: false,
    };
  }

  const boundedMax =
    typeof maxAmountInCents === 'number' && maxAmountInCents >= 0
      ? Math.min(outstanding, Math.trunc(maxAmountInCents))
      : outstanding;
  const recoverableCap =
    source === 'AVAILABLE_BALANCE'
      ? Math.min(boundedMax, Math.max(0, balance.availableBalanceInCents))
      : boundedMax;

  if (recoverableCap <= 0) {
    return {
      recoveredInCents: 0,
      remainingRecoverableInCents: outstanding,
      duplicate: false,
    };
  }

  if (source === 'AVAILABLE_BALANCE') {
    await tx.organizerBalance.update({
      where: { userId: organizerId },
      data: {
        availableBalanceInCents: { decrement: recoverableCap },
      },
    });

    await tx.financialLedgerEntry.create({
      data: {
        type: LedgerEntryType.ADJUSTMENT,
        balanceType: LedgerBalanceType.AVAILABLE,
        amountInCents: -recoverableCap,
        currency: balance.currency.toUpperCase(),
        organizerId,
        orderId: orderId || null,
        stripeReferenceId: stripeReferenceId || null,
        description: reason || 'Available balance applied toward recoverable liability',
        metadata: {
          ...(idempotencyKey ? { idempotencyKey } : {}),
          source,
          recoveredAmountInCents: recoverableCap,
        },
      },
    });
  }

  await tx.financialLedgerEntry.create({
    data: {
      type: LedgerEntryType.ADJUSTMENT,
      balanceType: LedgerBalanceType.RECOVERABLE,
      amountInCents: recoverableCap,
      currency: balance.currency.toUpperCase(),
      organizerId,
      orderId: orderId || null,
      stripeReferenceId: stripeReferenceId || null,
      description: reason || 'Recoverable liability offset',
      metadata: {
        ...(idempotencyKey ? { idempotencyKey } : {}),
        source,
        recoveredAmountInCents: recoverableCap,
      },
    },
  });

  return {
    recoveredInCents: recoverableCap,
    remainingRecoverableInCents: outstanding - recoverableCap,
    duplicate: false,
  };
}

export async function recoverOrganizerLiabilities(params: {
  organizerId: string;
  maxAmountInCents?: number;
  orderId?: string;
  stripeReferenceId?: string;
  idempotencyKey?: string;
  source?: 'AVAILABLE_BALANCE' | 'EXTERNAL_RECOVERY';
  reason?: string;
}) {
  return prisma.$transaction((tx) => recoverOrganizerLiabilitiesInTx(tx, params));
}

/**
 * Handles refunds with strict pre-transfer vs post-transfer tracking:
 * - If funds were still pending or available in OrganizerBalance:
 *   Reduces pending/available accordingly (pre-transfer).
 * - If funds were already transferred:
 *   Tracks as REFUND_POST_TRANSFER in RECOVERABLE balance without creating negative transfers.
 */
export async function recordRefundLedger(
  tx: Prisma.TransactionClient,
  params: RecordRefundParams
): Promise<void> {
  const { orderId, amountInCents, stripeRefundId, stripeChargeId, reason } = params;

  await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;

  const order = await tx.order.findUnique({
    where: { id: orderId },
    include: {
      event: { select: { id: true, organizerId: true, title: true } },
    },
  });

  if (!order) {
    throw new Error(`Order ${orderId} not found for refund processing.`);
  }

  const organizerId = order.event.organizerId;
  const balance = await getOrCreateOrganizerBalance(tx, organizerId, order.currency);

  // If a specific Stripe refund ID was provided, verify it hasn't been processed yet
  if (stripeRefundId) {
    const existingRefund = await tx.financialLedgerEntry.findFirst({
      where: {
        orderId: order.id,
        stripeReferenceId: stripeRefundId,
      },
    });
    if (existingRefund) {
      return;
    }
  }

  // Calculate previous refund deductions for this order to prevent duplicate deductions on cumulative amounts
  const previousRefundEntries = await tx.financialLedgerEntry.findMany({
    where: {
      orderId: order.id,
      type: {
        in: [
          LedgerEntryType.REFUND_PENDING,
          LedgerEntryType.REFUND_CLEARED,
          LedgerEntryType.REFUND_POST_TRANSFER,
        ],
      },
    },
  });

  const totalPreviousDeduction = previousRefundEntries.reduce(
    (sum, e) => sum + Math.abs(e.amountInCents),
    0
  );

  const totalOrganizerEntitlement = Math.min(
    order.organizerNetInCents,
    Math.round((amountInCents / order.totalInCents) * order.organizerNetInCents)
  );

  const organizerRefundPortion = Math.max(0, totalOrganizerEntitlement - totalPreviousDeduction);
  if (organizerRefundPortion <= 0) {
    return;
  }

  let preTransferDeducted = 0;
  let postTransferRecoverable = 0;

  // Try to absorb from available balance first
  if (balance.availableBalanceInCents >= organizerRefundPortion) {
    preTransferDeducted = organizerRefundPortion;
    await tx.organizerBalance.update({
      where: { userId: organizerId },
      data: {
        availableBalanceInCents: { decrement: preTransferDeducted },
      },
    });

    await tx.financialLedgerEntry.create({
      data: {
        type: LedgerEntryType.REFUND_CLEARED,
        balanceType: LedgerBalanceType.AVAILABLE,
        amountInCents: -preTransferDeducted,
        currency: order.currency.toUpperCase(),
        organizerId,
        eventId: order.eventId,
        orderId: order.id,
        stripeReferenceId: stripeRefundId || stripeChargeId || null,
        description: `Refund deduction (from available balance) for order #${order.orderNumber}${reason ? `: ${reason}` : ''}`,
        metadata: {
          stripeRefundId,
          totalRefundAmountInCents: amountInCents,
          organizerDeductionInCents: preTransferDeducted,
        },
      },
    });
  } else if (balance.availableBalanceInCents > 0) {
    // Partially covered by available balance, remainder is post-transfer recoverable
    preTransferDeducted = balance.availableBalanceInCents;
    postTransferRecoverable = organizerRefundPortion - preTransferDeducted;

    await tx.organizerBalance.update({
      where: { userId: organizerId },
      data: {
        availableBalanceInCents: 0,
      },
    });

    await tx.financialLedgerEntry.create({
      data: {
        type: LedgerEntryType.REFUND_CLEARED,
        balanceType: LedgerBalanceType.AVAILABLE,
        amountInCents: -preTransferDeducted,
        currency: order.currency.toUpperCase(),
        organizerId,
        eventId: order.eventId,
        orderId: order.id,
        stripeReferenceId: stripeRefundId || stripeChargeId || null,
        description: `Partial refund deduction (from available balance) for order #${order.orderNumber}`,
        metadata: {
          stripeRefundId,
          organizerDeductionInCents: preTransferDeducted,
        },
      },
    });

    await tx.financialLedgerEntry.create({
      data: {
        type: LedgerEntryType.REFUND_POST_TRANSFER,
        balanceType: LedgerBalanceType.RECOVERABLE,
        amountInCents: -postTransferRecoverable,
        currency: order.currency.toUpperCase(),
        organizerId,
        eventId: order.eventId,
        orderId: order.id,
        stripeReferenceId: stripeRefundId || stripeChargeId || null,
        description: `Post-transfer refund liability tracked as recoverable for order #${order.orderNumber}`,
        metadata: {
          stripeRefundId,
          recoverableInCents: postTransferRecoverable,
        },
      },
    });
  } else if (balance.pendingBalanceInCents > 0) {
    // Partially or fully absorbed from pending balance; any remainder becomes post-transfer recoverable
    preTransferDeducted = Math.min(balance.pendingBalanceInCents, organizerRefundPortion);
    postTransferRecoverable = organizerRefundPortion - preTransferDeducted;

    await tx.organizerBalance.update({
      where: { userId: organizerId },
      data: {
        pendingBalanceInCents: { decrement: preTransferDeducted },
      },
    });

    await tx.financialLedgerEntry.create({
      data: {
        type: LedgerEntryType.REFUND_PENDING,
        balanceType: LedgerBalanceType.PENDING,
        amountInCents: -preTransferDeducted,
        currency: order.currency.toUpperCase(),
        organizerId,
        eventId: order.eventId,
        orderId: order.id,
        stripeReferenceId: stripeRefundId || stripeChargeId || null,
        description: `Refund deduction (from pending balance) for order #${order.orderNumber}${reason ? `: ${reason}` : ''}`,
        metadata: {
          stripeRefundId,
          organizerDeductionInCents: preTransferDeducted,
        },
      },
    });

    if (postTransferRecoverable > 0) {
      await tx.financialLedgerEntry.create({
        data: {
          type: LedgerEntryType.REFUND_POST_TRANSFER,
          balanceType: LedgerBalanceType.RECOVERABLE,
          amountInCents: -postTransferRecoverable,
          currency: order.currency.toUpperCase(),
          organizerId,
          eventId: order.eventId,
          orderId: order.id,
          stripeReferenceId: stripeRefundId || stripeChargeId || null,
          description: `Post-transfer refund liability tracked as recoverable for order #${order.orderNumber}${reason ? `: ${reason}` : ''}`,
          metadata: {
            stripeRefundId,
            recoverableInCents: postTransferRecoverable,
          },
        },
      });
    }
  } else {
    // Fully post-transfer: balance already withdrawn
    postTransferRecoverable = organizerRefundPortion;

    await tx.financialLedgerEntry.create({
      data: {
        type: LedgerEntryType.REFUND_POST_TRANSFER,
        balanceType: LedgerBalanceType.RECOVERABLE,
        amountInCents: -postTransferRecoverable,
        currency: order.currency.toUpperCase(),
        organizerId,
        eventId: order.eventId,
        orderId: order.id,
        stripeReferenceId: stripeRefundId || stripeChargeId || null,
        description: `Post-transfer refund tracked as recoverable liability for order #${order.orderNumber}${reason ? `: ${reason}` : ''}`,
        metadata: {
          stripeRefundId,
          recoverableInCents: postTransferRecoverable,
        },
      },
    });
  }
}

/**
 * Records disputes (opened, won, lost) in the financial ledger.
 */
export async function recordDisputeLedger(
  tx: Prisma.TransactionClient,
  params: RecordDisputeParams
): Promise<void> {
  const { stripeDisputeId, stripeChargeId, orderId, amountInCents, status, reason } = params;
  let organizerId: string | null = null;
  let eventId: string | null = null;
  let resolvedOrderId: string | null = orderId || null;

  if (resolvedOrderId) {
    const order = await tx.order.findUnique({
      where: { id: resolvedOrderId },
      include: { event: true },
    });
    if (order) {
      organizerId = order.event.organizerId;
      eventId = order.eventId;
    }
  }

  if (!organizerId && stripeChargeId) {
    const entry = await tx.financialLedgerEntry.findFirst({
      where: { stripeReferenceId: stripeChargeId },
    });
    if (entry) {
      organizerId = entry.organizerId;
      eventId = entry.eventId;
      if (!resolvedOrderId && entry.orderId) {
        resolvedOrderId = entry.orderId;
      }
    }
  }

  if (!organizerId) {
    console.warn(`[DisputeLedger] Could not locate organizer for dispute ${stripeDisputeId}`);
    return;
  }

  let entryType: LedgerEntryType = LedgerEntryType.DISPUTE_HOLD;
  if (status === 'won') {
    entryType = LedgerEntryType.DISPUTE_WON;
  } else if (status === 'lost') {
    entryType = LedgerEntryType.DISPUTE_LOST;
  }

  // Idempotency: do not re-record if this exact dispute event type has already been logged for this dispute
  const existingDisputeEntry = await tx.financialLedgerEntry.findFirst({
    where: {
      stripeReferenceId: stripeDisputeId,
      type: entryType,
    },
  });
  if (existingDisputeEntry) {
    return;
  }

  // Out-of-order protection: if dispute is already closed (won or lost), do not accept an older hold
  if (entryType === LedgerEntryType.DISPUTE_HOLD) {
    const alreadyClosed = await tx.financialLedgerEntry.findFirst({
      where: {
        stripeReferenceId: stripeDisputeId,
        type: { in: [LedgerEntryType.DISPUTE_WON, LedgerEntryType.DISPUTE_LOST] },
      },
    });
    if (alreadyClosed) {
      return;
    }
  }

  // Calculate organizer's net liability:
  // The organizer is only liable up to their net ticket earnings on the order (less any already-refunded amounts)
  let organizerLiability = amountInCents;
  if (resolvedOrderId) {
    const order = await tx.order.findUnique({ where: { id: resolvedOrderId } });
    if (order) {
      const previousDeductions = await tx.financialLedgerEntry.findMany({
        where: {
          orderId: order.id,
          type: {
            in: [
              LedgerEntryType.REFUND_PENDING,
              LedgerEntryType.REFUND_CLEARED,
              LedgerEntryType.REFUND_POST_TRANSFER,
              LedgerEntryType.DISPUTE_LOST,
            ],
          },
        },
      });
      const totalPrevious = previousDeductions.reduce(
        (sum, e) => sum + Math.abs(e.amountInCents),
        0
      );
      const remainingEntitlement = Math.max(0, order.organizerNetInCents - totalPrevious);
      const proportionalLiability = Math.min(
        order.organizerNetInCents,
        Math.round((amountInCents / order.totalInCents) * order.organizerNetInCents)
      );
      organizerLiability = Math.min(remainingEntitlement, proportionalLiability);
    }
  }

  await tx.financialLedgerEntry.create({
    data: {
      type: entryType,
      balanceType: entryType === LedgerEntryType.DISPUTE_LOST ? LedgerBalanceType.RECOVERABLE : LedgerBalanceType.AVAILABLE,
      amountInCents: entryType === LedgerEntryType.DISPUTE_LOST ? -organizerLiability : 0,
      currency: 'USD',
      organizerId,
      eventId,
      orderId: resolvedOrderId,
      stripeReferenceId: stripeDisputeId,
      description: `Dispute ${status} (${stripeDisputeId})${reason ? `: ${reason}` : ''}`,
      metadata: {
        stripeChargeId: stripeChargeId || null,
        disputeStatus: status,
        disputeAmountInCents: amountInCents,
        organizerLiabilityInCents: organizerLiability,
        reason,
      },
    },
  });
}

/**
 * Returns organizer's financial summary:
 * - Authoritative OrganizerBalance record.
 * - Recoverable liabilities from ledger.
 * - Net available amount (available - recoverable).
 * - Total pending, transferred, lifetime earnings.
 */
export async function getOrganizerFinancialSummary(userId: string) {
  const balance = await prisma.organizerBalance.findUnique({
    where: { userId },
  });

  // Calculate net recoverable liabilities using signed entries (-liability, +offset)
  const recoverableEntries = await prisma.financialLedgerEntry.findMany({
    where: {
      organizerId: userId,
      balanceType: LedgerBalanceType.RECOVERABLE,
    },
  });

  const signedRecoverableInCents = recoverableEntries.reduce(
    (sum, e) => sum + e.amountInCents,
    0
  );
  const totalRecoverableInCents = Math.max(0, -signedRecoverableInCents);

  const earningsEntries = await prisma.financialLedgerEntry.findMany({
    where: {
      organizerId: userId,
      type: { in: [LedgerEntryType.TICKET_SALE_PENDING, LedgerEntryType.TICKET_SALE_CLEARED] },
      balanceType: { in: [LedgerBalanceType.PENDING, LedgerBalanceType.AVAILABLE] },
    },
  });

  // Filter unique order earnings to compute lifetime earnings
  const seenOrders = new Set<string>();
  let lifetimeEarningsInCents = 0;
  for (const entry of earningsEntries) {
    if (entry.orderId && entry.amountInCents > 0 && !seenOrders.has(entry.orderId)) {
      seenOrders.add(entry.orderId);
      lifetimeEarningsInCents += entry.amountInCents;
    }
  }

  if (!balance) {
    return {
      currency: 'USD',
      pendingInCents: 0,
      availableInCents: 0,
      netAvailableInCents: 0,
      transferredInCents: 0,
      lifetimeEarningsInCents,
      recoverableInCents: totalRecoverableInCents,
      lastSettledAt: null,
    };
  }

  const netAvailableInCents = Math.max(0, balance.availableBalanceInCents - totalRecoverableInCents);

  return {
    currency: balance.currency.toUpperCase(),
    pendingInCents: balance.pendingBalanceInCents,
    availableInCents: balance.availableBalanceInCents,
    netAvailableInCents,
    transferredInCents: balance.transferredBalanceInCents,
    lifetimeEarningsInCents,
    recoverableInCents: totalRecoverableInCents,
    lastSettledAt: balance.updatedAt.toISOString(),
  };
}

/**
 * Returns paginated ledger entries for the organizer.
 */
export async function getOrganizerLedgerEntries(
  userId: string,
  options: {
    page?: number;
    limit?: number;
    eventId?: string;
    entryType?: LedgerEntryType;
  } = {}
) {
  const page = Math.max(1, options.page || 1);
  const limit = Math.min(100, Math.max(1, options.limit || 20));
  const skip = (page - 1) * limit;

  const where: Prisma.FinancialLedgerEntryWhereInput = {
    organizerId: userId,
    ...(options.eventId ? { eventId: options.eventId } : {}),
    ...(options.entryType ? { type: options.entryType } : {}),
  };

  const [total, entries] = await Promise.all([
    prisma.financialLedgerEntry.count({ where }),
    prisma.financialLedgerEntry.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: {
        event: { select: { id: true, title: true, slug: true } },
        order: { select: { id: true, orderNumber: true, customerName: true } },
      },
    }),
  ]);

  return {
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    entries: entries.map((e) => ({
      id: e.id,
      entryType: e.type,
      balanceType: e.balanceType,
      amountInCents: e.amountInCents,
      currency: e.currency.toUpperCase(),
      description: e.description,
      createdAt: e.createdAt.toISOString(),
      event: e.event ? { id: e.event.id, title: e.event.title, slug: e.event.slug } : null,
      order: e.order ? { id: e.order.id, orderNumber: e.order.orderNumber } : null,
      stripeReferenceId: e.stripeReferenceId,
    })),
  };
}

/**
 * Convenience helper to settle a pending order outside of webhooks (e.g. in tests or manual triggers).
 */
export async function settlePendingOrder(orderId: string, stripeChargeId?: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await settleOrderEarnings(tx, { orderId, stripeChargeId });
  });
}

/**
 * Reconciles the organizer's database balance table against raw ledger entries and Stripe.
 */
export async function reconcileOrganizerFinance(userId: string) {
  const balance = await prisma.organizerBalance.findUnique({ where: { userId } });
  const ledgerEntries = await prisma.financialLedgerEntry.findMany({
    where: { organizerId: userId },
  });

  let calculatedPending = 0;
  let calculatedAvailable = 0;
  let calculatedTransferred = 0;
  let signedRecoverable = 0;
  let calculatedPlatformRevenue = 0;
  let calculatedPlatformExpense = 0;

  for (const entry of ledgerEntries) {
    if (entry.balanceType === LedgerBalanceType.PENDING) {
      calculatedPending += entry.amountInCents;
    } else if (entry.balanceType === LedgerBalanceType.AVAILABLE) {
      calculatedAvailable += entry.amountInCents;
    } else if (entry.balanceType === LedgerBalanceType.TRANSFERRED) {
      calculatedTransferred += entry.amountInCents;
    } else if (entry.balanceType === LedgerBalanceType.RECOVERABLE) {
      signedRecoverable += entry.amountInCents;
    } else if (entry.balanceType === LedgerBalanceType.PLATFORM_REVENUE) {
      calculatedPlatformRevenue += entry.amountInCents;
    } else if (entry.balanceType === LedgerBalanceType.PLATFORM_EXPENSE) {
      calculatedPlatformExpense += entry.amountInCents;
    }
  }
  const calculatedRecoverable = Math.max(0, -signedRecoverable);

  const discrepancies: string[] = [];
  if (balance) {
    if (balance.pendingBalanceInCents !== calculatedPending) {
      discrepancies.push(
        `Pending balance discrepancy: balance record has ${balance.pendingBalanceInCents}, ledger sum is ${calculatedPending}`
      );
    }
    if (balance.availableBalanceInCents !== calculatedAvailable) {
      discrepancies.push(
        `Available balance discrepancy: balance record has ${balance.availableBalanceInCents}, ledger sum is ${calculatedAvailable}`
      );
    }
    if (balance.transferredBalanceInCents !== calculatedTransferred) {
      discrepancies.push(
        `Transferred balance discrepancy: balance record has ${balance.transferredBalanceInCents}, ledger sum is ${calculatedTransferred}`
      );
    }
  }

  return {
    isReconciled: discrepancies.length === 0,
    discrepancies,
    balanceRecord: balance
      ? {
          pendingInCents: balance.pendingBalanceInCents,
          availableInCents: balance.availableBalanceInCents,
          transferredInCents: balance.transferredBalanceInCents,
        }
      : null,
    ledgerTotals: {
      pendingInCents: calculatedPending,
      availableInCents: calculatedAvailable,
      transferredInCents: calculatedTransferred,
      recoverableInCents: calculatedRecoverable,
      platformRevenueInCents: calculatedPlatformRevenue,
      platformExpenseInCents: calculatedPlatformExpense,
      totalEntries: ledgerEntries.length,
    },
  };
}
