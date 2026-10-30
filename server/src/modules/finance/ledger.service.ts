import { Prisma, LedgerEntryType, LedgerBalanceType } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { calculateCheckoutFeeBreakdown } from '../checkout/checkout.financials.js';

export interface RecordTicketSaleParams {
  orderId: string;
  paymentIntentId?: string;
  stripeChargeId?: string;
  autoSettle?: boolean;
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
 * Retrieves or initializes the single OrganizerBalance record for a user.
 * Must be executed within a transaction to maintain consistency.
 */
export async function getOrCreateOrganizerBalance(
  tx: Prisma.TransactionClient,
  userId: string,
  currency = 'USD'
) {
  let balance = await tx.organizerBalance.findUnique({
    where: { userId },
  });

  if (!balance) {
    balance = await tx.organizerBalance.create({
      data: {
        userId,
        currency: currency.toUpperCase(),
        pendingBalanceInCents: 0,
        availableBalanceInCents: 0,
        transferredBalanceInCents: 0,
      },
    });
  }

  return balance;
}

// Records pending earnings, platform fees, service fees, and estimated processing fees for a completed order.
export async function recordTicketSalePending(
  tx: Prisma.TransactionClient,
  params: RecordTicketSaleParams
): Promise<void> {
  const { orderId, paymentIntentId, stripeChargeId, autoSettle = false } = params;

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

    await getOrCreateOrganizerBalance(tx, organizerId, order.currency);
    await tx.organizerBalance.update({
      where: { userId: organizerId },
      data: {
        pendingBalanceInCents: { increment: organizerEarnings },
      },
    });
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

// Clears pending earnings to available balance once settled
export async function settleOrderEarnings(
  tx: Prisma.TransactionClient,
  params: { orderId: string; stripeChargeId?: string }
): Promise<void> {
  const { orderId, stripeChargeId } = params;

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
    return;
  }

  const balance = await getOrCreateOrganizerBalance(tx, organizerId, order.currency);
  const decrementPending = Math.min(balance.pendingBalanceInCents, organizerEarnings);

  await tx.organizerBalance.update({
    where: { userId: organizerId },
    data: {
      pendingBalanceInCents: { decrement: decrementPending },
      availableBalanceInCents: { increment: organizerEarnings },
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

  await tx.financialLedgerEntry.create({
    data: {
      type: LedgerEntryType.TICKET_SALE_CLEARED,
      balanceType: LedgerBalanceType.AVAILABLE,
      amountInCents: organizerEarnings,
      currency: order.currency.toUpperCase(),
      organizerId,
      eventId: order.eventId,
      orderId: order.id,
      stripeReferenceId: stripeChargeId || null,
      description: `Earnings cleared and available for withdrawal for order #${order.orderNumber}`,
      metadata: {
        idempotencyKey: `order_${order.id}_settle_cleared`,
        orderNumber: order.orderNumber,
        settledAmountInCents: organizerEarnings,
      },
    },
  });
}

/**
 * Records actual Stripe processing fees upon receipt of Stripe balance transaction.
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
      balanceType: LedgerBalanceType.PLATFORM_REVENUE,
      amountInCents: actualFeeInCents,
      currency: (currency || 'USD').toUpperCase(),
      organizerId,
      eventId,
      orderId,
      stripeReferenceId: stripeChargeId,
      description: `Reconciled Stripe processing fee of $${(actualFeeInCents / 100).toFixed(2)}`,
      metadata: {
        isActualReconciliation: true,
        actualFeeInCents,
      },
    },
  });
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
  } else if (balance.pendingBalanceInCents >= organizerRefundPortion) {
    // Absorbed from pending balance
    preTransferDeducted = organizerRefundPortion;
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

  if (!organizerId && stripeChargeId) {
    const entry = await tx.financialLedgerEntry.findFirst({
      where: { stripeReferenceId: stripeChargeId },
    });
    if (entry) {
      organizerId = entry.organizerId;
      eventId = entry.eventId;
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

  await tx.financialLedgerEntry.create({
    data: {
      type: entryType,
      balanceType: entryType === LedgerEntryType.DISPUTE_LOST ? LedgerBalanceType.RECOVERABLE : LedgerBalanceType.AVAILABLE,
      amountInCents: entryType === LedgerEntryType.DISPUTE_LOST ? -amountInCents : 0,
      currency: 'USD',
      organizerId,
      eventId,
      orderId,
      stripeReferenceId: stripeDisputeId,
      description: `Dispute ${status} (${stripeDisputeId})${reason ? `: ${reason}` : ''}`,
      metadata: {
        stripeChargeId: stripeChargeId || null,
        disputeStatus: status,
        disputeAmountInCents: amountInCents,
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

  // Calculate recoverable liabilities and lifetime earnings from ledger
  const recoverableEntries = await prisma.financialLedgerEntry.findMany({
    where: {
      organizerId: userId,
      balanceType: LedgerBalanceType.RECOVERABLE,
    },
  });

  const totalRecoverableInCents = recoverableEntries.reduce(
    (sum, e) => sum + Math.abs(e.amountInCents),
    0
  );

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
  let calculatedRecoverable = 0;

  for (const entry of ledgerEntries) {
    if (entry.balanceType === LedgerBalanceType.PENDING) {
      calculatedPending += entry.amountInCents;
    } else if (entry.balanceType === LedgerBalanceType.AVAILABLE) {
      calculatedAvailable += entry.amountInCents;
    } else if (entry.balanceType === LedgerBalanceType.TRANSFERRED) {
      calculatedTransferred += entry.amountInCents;
    } else if (entry.balanceType === LedgerBalanceType.RECOVERABLE) {
      calculatedRecoverable += Math.abs(entry.amountInCents);
    }
  }

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
      totalEntries: ledgerEntries.length,
    },
  };
}
