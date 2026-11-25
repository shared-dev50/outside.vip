import {
  EventStatus,
  OrderRefund,
  OrderRefundKind,
  OrderRefundStatus,
  OrderRefundTicketLockState,
  OrderStatus,
  Prisma,
  RefundFeeBearer,
  RefundInitiatorRole,
  TicketStatus,
  TicketTierStatus,
} from '@prisma/client';
import {
  allocateOrderTicketPayments,
  computeLocalFreeTicketCancellationPlan,
  computeTicketRefundQuote,
  LocalFreeTicketCancellationPlan,
  PersistedTicketPaymentAllocation,
  RefundDomainRuleError,
  RefundEligibleTicketSnapshot,
  TicketRefundQuote,
} from './refundAllocation.domain.js';
import { calculateCheckoutFeeBreakdown } from '../checkout/checkout.financials.js';
import { recordTicketRefundLedgerInTx } from '../finance/ledger.service.js';
import { processWaitlistForTier } from '../waitlist/waitlist.service.js';
import { isTicketTierHidden, isTicketTierSalesDisabled } from '../../utils/ticketTierState.js';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../utils/errors.js';

export interface InitiateTicketRefundInTxParams {
  orderId: string;
  ticketIds: string[];
  idempotencyKey: string;
  stripePaymentIntentId: string;
  stripeChargeId?: string | null;
  initiatorRole: RefundInitiatorRole;
  initiatedByUserId: string;
  initiatedByEmail?: string | null;
  reason: string;
  feeBearer: RefundFeeBearer;
  refundStripeProcessingFee?: boolean;
  restoreInventory?: boolean;
  allowCheckedInOverride?: boolean;
  overrideReason?: string | null;
  ipAddress?: string | null;
}

export interface InitiateTicketRefundResult {
  created: boolean;
  orderRefund: OrderRefund;
  quote: TicketRefundQuote | null;
  checkedInOverrideAudited: boolean;
}

export interface ConfirmTicketRefundSucceededInTxParams {
  orderRefundId: string;
  stripeRefundId: string;
  stripeChargeId?: string | null;
  confirmedByUserId?: string | null;
  succeededAt?: Date;
  expectedLockedBy?: string;
}

export interface ConfirmTicketRefundSucceededResult {
  alreadyFinalized: boolean;
  leaseLost?: boolean;
  orderRefund: OrderRefund;
  orderFullyRefunded: boolean;
  ledgerRecorded: boolean;
  inventoryRestoredCount: number;
  tiersToAdvanceWaitlist: string[];
}

export interface CancelTicketRefundInTxParams {
  orderRefundId: string;
  cancellationReason: string;
  cancelledAt?: Date;
}

export interface CancelTicketRefundResult {
  alreadyCancelled: boolean;
  orderRefund: OrderRefund;
  restoredTicketIds: string[];
}

export interface ExecuteLocalFreeCancellationInTxParams {
  orderId: string;
  ticketIds: string[];
  initiatorRole: RefundInitiatorRole;
  initiatedByUserId: string;
  reason: string;
  restoreInventory?: boolean;
}

export interface ExecuteLocalFreeCancellationResult {
  plan: LocalFreeTicketCancellationPlan;
  inventoryRestoredCount: number;
  tiersToAdvanceWaitlist: string[];
}

interface LockedTicketRow {
  id: string;
  orderId: string;
  ticketTierId: string;
  status: TicketStatus;
  checkedInAt: Date | null;
  allocatedGrossInCents: number | null;
  allocatedPlatformFeeInCents: number | null;
  allocatedServiceFeeInCents: number | null;
  allocatedProcessingFeeInCents: number | null;
  allocatedBuyerTotalInCents: number | null;
  createdAt: Date;
}

/**
 * Ensures all tickets on an order have exact persisted integer-cent payment allocations,
 * deterministically backfilling legacy unallocated tickets when the order matches canonical
 * checkout math without drifting a single cent.
 */
export async function ensureOrderTicketAllocationsInTx(
  tx: Prisma.TransactionClient,
  orderId: string
): Promise<Map<string, PersistedTicketPaymentAllocation>> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      totalInCents: true,
      items: {
        select: {
          ticketTierId: true,
          unitPriceInCents: true,
        },
      },
      tickets: {
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          ticketTierId: true,
          allocatedGrossInCents: true,
          allocatedPlatformFeeInCents: true,
          allocatedServiceFeeInCents: true,
          allocatedProcessingFeeInCents: true,
          allocatedBuyerTotalInCents: true,
        },
      },
    },
  });

  if (!order) {
    throw new NotFoundError(`Order '${orderId}' not found.`);
  }

  const allAllocated = order.tickets.every(
    (t) =>
      t.allocatedGrossInCents !== null &&
      t.allocatedPlatformFeeInCents !== null &&
      t.allocatedServiceFeeInCents !== null &&
      t.allocatedProcessingFeeInCents !== null &&
      t.allocatedBuyerTotalInCents !== null
  );

  const map = new Map<string, PersistedTicketPaymentAllocation>();
  if (allAllocated) {
    for (const t of order.tickets) {
      map.set(t.id, {
        ticketId: t.id,
        ticketTierId: t.ticketTierId,
        allocatedGrossInCents: t.allocatedGrossInCents!,
        allocatedPlatformFeeInCents: t.allocatedPlatformFeeInCents!,
        allocatedServiceFeeInCents: t.allocatedServiceFeeInCents!,
        allocatedProcessingFeeInCents: t.allocatedProcessingFeeInCents!,
        allocatedBuyerTotalInCents: t.allocatedBuyerTotalInCents!,
      });
    }
    return map;
  }

  // Deterministic unit gross lookup per tier from OrderItem snapshot
  const tierUnitPriceMap = new Map<string, number>();
  for (const item of order.items) {
    if (!tierUnitPriceMap.has(item.ticketTierId)) {
      tierUnitPriceMap.set(item.ticketTierId, item.unitPriceInCents);
    }
  }

  const inputs = order.tickets.map((t) => ({
    ticketId: t.id,
    ticketTierId: t.ticketTierId,
    grossPriceInCents: tierUnitPriceMap.get(t.ticketTierId) ?? 0,
  }));

  const canonical = calculateCheckoutFeeBreakdown(
    inputs.map((i) => ({ priceInCents: i.grossPriceInCents, quantity: 1 }))
  );
  if (order.totalInCents !== canonical.buyerTotalInCents) {
    throw new RefundDomainRuleError(
      'MISSING_PERSISTED_ALLOCATION',
      `Order '${orderId}' totalInCents (${order.totalInCents}) does not match canonical checkout breakdown (${canonical.buyerTotalInCents}) and cannot auto-backfill legacy ticket allocations`
    );
  }

  const computed = allocateOrderTicketPayments({ buyerTotalInCents: order.totalInCents }, inputs);

  for (const alloc of computed.tickets) {
    await tx.ticket.update({
      where: { id: alloc.ticketId },
      data: {
        allocatedGrossInCents: alloc.allocatedGrossInCents,
        allocatedPlatformFeeInCents: alloc.allocatedPlatformFeeInCents,
        allocatedServiceFeeInCents: alloc.allocatedServiceFeeInCents,
        allocatedProcessingFeeInCents: alloc.allocatedProcessingFeeInCents,
        allocatedBuyerTotalInCents: alloc.allocatedBuyerTotalInCents,
      },
    });
    map.set(alloc.ticketId, alloc);
  }

  return map;
}

/**
 * Initiates a ticket-based paid refund inside the caller's PostgreSQL transaction.
 * Enforces canonical lock ordering: Order (FOR UPDATE) -> Ticket (id ASC, FOR UPDATE).
 * Transitions eligible tickets immediately to TicketStatus.REFUND_PENDING so gate check-in
 * and PDF QR access are blocked before any Stripe call runs.
 */
export async function initiateTicketRefundInTx(
  tx: Prisma.TransactionClient,
  params: InitiateTicketRefundInTxParams
): Promise<InitiateTicketRefundResult> {
  if (
    params.initiatorRole !== RefundInitiatorRole.ORGANIZER &&
    params.initiatorRole !== RefundInitiatorRole.ADMIN
  ) {
    throw new ForbiddenError('Only event organizers or platform admins may initiate refunds.');
  }

  const cleanReason = (params.reason || '').trim();
  if (cleanReason.length < 3) {
    throw new BadRequestError('A refund reason (at least 3 characters) is required.');
  }

  const uniqueTicketIds = Array.from(new Set(params.ticketIds)).sort();
  if (uniqueTicketIds.length === 0) {
    throw new BadRequestError('At least one ticket must be selected for refund.');
  }

  // Canonical Lock Step 1: Lock Order FOR UPDATE first
  const orderRows = await tx.$queryRaw<
    Array<{
      id: string;
      status: OrderStatus;
      totalInCents: number;
      refundedAmountInCents: number;
      pendingRefundAmountInCents: number;
      currency: string;
      orderNumber: string;
    }>
  >`
    SELECT id, status, "totalInCents", "refundedAmountInCents", "pendingRefundAmountInCents", currency, "orderNumber"
    FROM "Order"
    WHERE id = ${params.orderId}
    FOR UPDATE
  `;
  const lockedOrder = orderRows[0];
  if (!lockedOrder) {
    throw new NotFoundError(`Order '${params.orderId}' not found.`);
  }

  // Idempotency replay by idempotencyKey
  const existingByIdem = await tx.orderRefund.findUnique({
    where: { idempotencyKey: params.idempotencyKey },
  });
  if (existingByIdem) {
    return {
      created: false,
      orderRefund: existingByIdem,
      quote: null,
      checkedInOverrideAudited: false,
    };
  }

  if (lockedOrder.status !== OrderStatus.COMPLETED) {
    throw new ConflictError(
      `Only COMPLETED orders can issue ticket refunds (current status: ${lockedOrder.status}).`
    );
  }

  // Canonical Lock Step 2: Lock selected Ticket rows in deterministic id ASC order
  const lockedTickets = await tx.$queryRaw<LockedTicketRow[]>`
    SELECT
      id,
      "orderId",
      "ticketTierId",
      status,
      "checkedInAt",
      "allocatedGrossInCents",
      "allocatedPlatformFeeInCents",
      "allocatedServiceFeeInCents",
      "allocatedProcessingFeeInCents",
      "allocatedBuyerTotalInCents",
      "createdAt"
    FROM "Ticket"
    WHERE id = ANY(${uniqueTicketIds})
    ORDER BY id ASC
    FOR UPDATE
  `;

  if (lockedTickets.length !== uniqueTicketIds.length) {
    throw new NotFoundError('One or more selected tickets could not be found.');
  }

  for (const t of lockedTickets) {
    if (t.orderId !== lockedOrder.id) {
      throw new BadRequestError(`Ticket '${t.id}' does not belong to order '${lockedOrder.id}'.`);
    }
  }

  // Check active/confirmed locks from OrderRefundTicket
  const existingTicketLocks = await tx.orderRefundTicket.findMany({
    where: {
      ticketId: { in: uniqueTicketIds },
      lockState: { in: [OrderRefundTicketLockState.ACTIVE_PENDING, OrderRefundTicketLockState.CONFIRMED] },
    },
    select: { ticketId: true },
  });
  const lockedTicketSet = new Set(existingTicketLocks.map((l) => l.ticketId));

  // Verify checked-in override policy cleanly
  const checkedInTickets = lockedTickets.filter((t) => t.status === TicketStatus.CHECKED_IN);
  let checkedInOverrideAudited = false;
  const cleanOverrideReason = (params.overrideReason || '').trim();

  if (checkedInTickets.length > 0) {
    if (params.initiatorRole !== RefundInitiatorRole.ADMIN || !params.allowCheckedInOverride) {
      throw new ConflictError(
        `Ticket '${checkedInTickets[0].id}' has already checked in and cannot be refunded by organizers.`,
        'CHECKED_IN_TICKET_NOT_REFUNDABLE'
      );
    }
    if (cleanOverrideReason.length < 5) {
      throw new BadRequestError(
        'Platform ADMIN override for checked-in ticket refunds requires an explicit overrideReason (minimum 5 characters).',
        'ADMIN_OVERRIDE_REASON_REQUIRED'
      );
    }
    checkedInOverrideAudited = true;
  }

  // Ensure persisted allocations exist before quoting
  const allocMap = await ensureOrderTicketAllocationsInTx(tx, lockedOrder.id);

  // Build domain snapshot; for explicit ADMIN checked-in override we pass ISSUED eligibility to compute quote
  // after recording explicit ADMIN override check above.
  const domainSnapshots: RefundEligibleTicketSnapshot[] = lockedTickets.map((t) => {
    const alloc = allocMap.get(t.id);
    return {
      id: t.id,
      orderId: t.orderId,
      status:
        checkedInOverrideAudited && t.status === TicketStatus.CHECKED_IN
          ? TicketStatus.ISSUED
          : t.status,
      allocatedGrossInCents: alloc?.allocatedGrossInCents ?? t.allocatedGrossInCents,
      allocatedPlatformFeeInCents: alloc?.allocatedPlatformFeeInCents ?? t.allocatedPlatformFeeInCents,
      allocatedServiceFeeInCents: alloc?.allocatedServiceFeeInCents ?? t.allocatedServiceFeeInCents,
      allocatedProcessingFeeInCents:
        alloc?.allocatedProcessingFeeInCents ?? t.allocatedProcessingFeeInCents,
      allocatedBuyerTotalInCents: alloc?.allocatedBuyerTotalInCents ?? t.allocatedBuyerTotalInCents,
      hasActiveOrConfirmedRefundLock: lockedTicketSet.has(t.id),
    };
  });

  const quote = computeTicketRefundQuote({
    orderId: lockedOrder.id,
    orderTotalInCents: lockedOrder.totalInCents,
    orderRefundedAmountInCents: lockedOrder.refundedAmountInCents,
    orderPendingRefundAmountInCents: lockedOrder.pendingRefundAmountInCents,
    initiatorRole: params.initiatorRole,
    tickets: domainSnapshots,
    refundStripeProcessingFee: params.refundStripeProcessingFee,
    feeBearer: params.feeBearer,
  });

  const restoreInventory = Boolean(params.restoreInventory);

  const createdRefund = await tx.orderRefund.create({
    data: {
      orderId: lockedOrder.id,
      stripePaymentIntentId: params.stripePaymentIntentId,
      stripeChargeId: params.stripeChargeId ?? null,
      idempotencyKey: params.idempotencyKey,
      refundKind: quote.refundKind,
      initiatorRole: params.initiatorRole,
      initiatedByUserId: params.initiatedByUserId,
      feeBearer: quote.feeBearer,
      refundStripeProcessingFee: quote.refundStripeProcessingFee,
      amountInCents: quote.refundAmountInCents,
      ticketSubtotalInCents: quote.ticketSubtotalInCents,
      platformFeeReversedInCents: quote.platformFeeReversedInCents,
      serviceFeeReversedInCents: quote.serviceFeeReversedInCents,
      processingFeeInCents: quote.processingFeeInCents,
      organizerDebitInCents: quote.organizerDebitInCents,
      platformExpenseInCents: quote.platformExpenseInCents,
      restoreInventory,
      currency: lockedOrder.currency.toUpperCase(),
      reason: cleanReason,
      status: OrderRefundStatus.PENDING,
      refundTickets: {
        create: quote.lineItems.map((line) => ({
          ticketId: line.ticketId,
          lockState: OrderRefundTicketLockState.ACTIVE_PENDING,
          allocatedGrossInCents: line.allocatedGrossInCents,
          allocatedPlatformFeeInCents: line.allocatedPlatformFeeInCents,
          allocatedServiceFeeInCents: line.allocatedServiceFeeInCents,
          allocatedProcessingFeeInCents: line.allocatedProcessingFeeInCents,
          allocatedBuyerTotalInCents: line.allocatedBuyerTotalInCents,
          refundedAmountInCents: line.refundedAmountInCents,
          restoreInventory,
        })),
      },
    },
  });

  await tx.order.update({
    where: { id: lockedOrder.id },
    data: {
      pendingRefundAmountInCents: { increment: quote.refundAmountInCents },
    },
  });

  await tx.ticket.updateMany({
    where: { id: { in: uniqueTicketIds }, orderId: lockedOrder.id },
    data: { status: TicketStatus.REFUND_PENDING },
  });

  if (checkedInOverrideAudited) {
    await tx.adminAuditLog.create({
      data: {
        actorUserId: params.initiatedByUserId,
        actorEmail: params.initiatedByEmail || 'admin@outside.vip',
        action: 'ADMIN_REFUND_CHECKED_IN_TICKET_OVERRIDE',
        targetType: 'OrderRefund',
        targetId: createdRefund.id,
        metadata: {
          orderId: lockedOrder.id,
          orderNumber: lockedOrder.orderNumber,
          orderRefundId: createdRefund.id,
          overriddenTicketIds: checkedInTickets.map((t) => t.id),
          overrideReason: cleanOverrideReason,
          refundReason: cleanReason,
        },
        ipAddress: params.ipAddress ?? null,
      },
    });
  }

  return {
    created: true,
    orderRefund: createdRefund,
    quote,
    checkedInOverrideAudited,
  };
}

/**
 * Shared inventory restoration helper respecting event/sales closure rules and
 * canonical TicketTier lock order (`id ASC`).
 * Returns tier IDs eligible for post-commit waitlist advancement.
 */
async function restoreTierInventoryForTicketsInTx(
  tx: Prisma.TransactionClient,
  params: {
    eventId: string;
    ticketTierIds: string[];
  }
): Promise<{ restoredCount: number; tiersToAdvanceWaitlist: string[]; restoredTierIds: Set<string> }> {
  if (params.ticketTierIds.length === 0) {
    return { restoredCount: 0, tiersToAdvanceWaitlist: [], restoredTierIds: new Set() };
  }

  const event = await tx.event.findUnique({
    where: { id: params.eventId },
    select: { id: true, status: true, endAt: true },
  });

  const now = new Date();
  if (!event || event.status !== EventStatus.PUBLISHED || event.endAt < now) {
    return { restoredCount: 0, tiersToAdvanceWaitlist: [], restoredTierIds: new Set() };
  }

  const countByTier = new Map<string, number>();
  for (const tierId of params.ticketTierIds) {
    countByTier.set(tierId, (countByTier.get(tierId) ?? 0) + 1);
  }
  const sortedTierIds = Array.from(countByTier.keys()).sort();

  const lockedTiers = await tx.$queryRaw<
    Array<{
      id: string;
      status: TicketTierStatus;
      isHidden: boolean;
      salesDisabled: boolean;
      salesEndAt: Date | null;
      waitlistEnabled: boolean;
      totalCapacity: number;
      soldQuantity: number;
      reservedQuantity: number;
    }>
  >`
    SELECT
      id,
      status,
      "isHidden",
      "salesDisabled",
      "salesEndAt",
      "waitlistEnabled",
      "totalCapacity",
      "soldQuantity",
      "reservedQuantity"
    FROM "TicketTier"
    WHERE id = ANY(${sortedTierIds})
    ORDER BY id ASC
    FOR UPDATE
  `;

  let restoredCount = 0;
  const tiersToAdvanceWaitlist: string[] = [];
  const restoredTierIds = new Set<string>();

  for (const tier of lockedTiers) {
    const requestedRestore = countByTier.get(tier.id) ?? 0;
    if (requestedRestore <= 0) continue;

    // Do not restore capacity automatically when tier sales are disabled/closed
    if (
      isTicketTierHidden(tier) ||
      isTicketTierSalesDisabled(tier) ||
      (tier.salesEndAt && tier.salesEndAt < now)
    ) {
      continue;
    }

    const actualDecrement = Math.min(requestedRestore, Math.max(0, tier.soldQuantity));
    const newSold = Math.max(0, tier.soldQuantity - actualDecrement);
    const availableAfter = tier.totalCapacity - newSold - tier.reservedQuantity;

    await tx.ticketTier.update({
      where: { id: tier.id },
      data: {
        soldQuantity: newSold,
        ...(tier.status === TicketTierStatus.SOLD_OUT && availableAfter > 0
          ? { status: TicketTierStatus.ACTIVE }
          : {}),
      },
    });

    if (actualDecrement > 0) {
      restoredCount += actualDecrement;
      restoredTierIds.add(tier.id);
      if (tier.waitlistEnabled && availableAfter > 0) {
        tiersToAdvanceWaitlist.push(tier.id);
      }
    }
  }

  return {
    restoredCount,
    tiersToAdvanceWaitlist: tiersToAdvanceWaitlist.sort(),
    restoredTierIds,
  };
}

/**
 * Confirms a ticket-based refund strictly AFTER Stripe refund success.
 * Idempotent under duplicate finalization / webhook delivery.
 * Canonical lock ordering: Order -> Ticket (id ASC) -> OrderRefund -> TicketTier (id ASC) -> OrganizerBalance.
 */
export async function confirmTicketRefundSucceededInTx(
  tx: Prisma.TransactionClient,
  params: ConfirmTicketRefundSucceededInTxParams
): Promise<ConfirmTicketRefundSucceededResult> {
  const preLookup = await tx.orderRefund.findUnique({
    where: { id: params.orderRefundId },
    select: { id: true, orderId: true, refundKind: true },
  });
  if (!preLookup || !preLookup.orderId) {
    throw new NotFoundError(`Ticket OrderRefund '${params.orderRefundId}' not found.`);
  }
  if (preLookup.refundKind === OrderRefundKind.LATE_PAYMENT) {
    throw new BadRequestError('LATE_PAYMENT refunds must finalize via P2-04 late-payment flow.');
  }

  // Canonical Lock Step 1: Order FOR UPDATE
  const orderRows = await tx.$queryRaw<
    Array<{
      id: string;
      eventId: string;
      status: OrderStatus;
      pendingRefundAmountInCents: number;
    }>
  >`
    SELECT id, "eventId", status, "pendingRefundAmountInCents"
    FROM "Order"
    WHERE id = ${preLookup.orderId}
    FOR UPDATE
  `;
  const lockedOrder = orderRows[0];
  if (!lockedOrder) {
    throw new NotFoundError(`Order '${preLookup.orderId}' not found.`);
  }

  // Canonical Lock Step 2: Tickets associated with this refund (id ASC FOR UPDATE)
  const refundTickets = await tx.orderRefundTicket.findMany({
    where: { orderRefundId: params.orderRefundId },
    orderBy: { ticketId: 'asc' },
    select: {
      id: true,
      ticketId: true,
      restoreInventory: true,
      inventoryRestored: true,
    },
  });
  const ticketIds = refundTickets.map((rt) => rt.ticketId);
  const lockedTickets =
    ticketIds.length > 0
      ? await tx.$queryRaw<Array<{ id: string; ticketTierId: string; status: TicketStatus }>>`
          SELECT id, "ticketTierId", status
          FROM "Ticket"
          WHERE id = ANY(${ticketIds})
          ORDER BY id ASC
          FOR UPDATE
        `
      : [];

  // Canonical Lock Step 3: OrderRefund FOR UPDATE
  const refundRows = await tx.$queryRaw<OrderRefund[]>`
    SELECT * FROM "OrderRefund" WHERE id = ${params.orderRefundId} FOR UPDATE
  `;
  const refund = refundRows[0];
  if (!refund) {
    throw new NotFoundError(`OrderRefund '${params.orderRefundId}' not found.`);
  }

  if (
    refund.status === OrderRefundStatus.SUCCEEDED ||
    refund.status === OrderRefundStatus.MANUALLY_RESOLVED
  ) {
    return {
      alreadyFinalized: true,
      orderRefund: refund,
      orderFullyRefunded: lockedOrder.status === OrderStatus.REFUNDED,
      ledgerRecorded: false,
      inventoryRestoredCount: refund.inventoryRestoredCount,
      tiersToAdvanceWaitlist: [],
    };
  }

  if (refund.status === OrderRefundStatus.CANCELLED) {
    throw new ConflictError(`OrderRefund '${refund.id}' was already cancelled and cannot succeed.`);
  }

  if (
    params.expectedLockedBy &&
    (refund.status !== OrderRefundStatus.PROCESSING || refund.lockedBy !== params.expectedLockedBy)
  ) {
    return {
      alreadyFinalized: false,
      leaseLost: true,
      orderRefund: refund,
      orderFullyRefunded: lockedOrder.status === OrderStatus.REFUNDED,
      ledgerRecorded: false,
      inventoryRestoredCount: refund.inventoryRestoredCount,
      tiersToAdvanceWaitlist: [],
    };
  }

  const now = params.succeededAt ?? new Date();

  await tx.orderRefundTicket.updateMany({
    where: {
      orderRefundId: refund.id,
      lockState: OrderRefundTicketLockState.ACTIVE_PENDING,
    },
    data: { lockState: OrderRefundTicketLockState.CONFIRMED },
  });

  if (ticketIds.length > 0) {
    await tx.ticket.updateMany({
      where: { id: { in: ticketIds }, orderId: lockedOrder.id },
      data: {
        status: TicketStatus.REFUNDED,
        refundedAt: now,
        ...(params.confirmedByUserId ? { refundedByUserId: params.confirmedByUserId } : {}),
      },
    });
  }

  // Determine whether all order tickets are now REFUNDED or CANCELLED
  const remainingActiveTickets = await tx.ticket.count({
    where: {
      orderId: lockedOrder.id,
      status: { notIn: [TicketStatus.REFUNDED, TicketStatus.CANCELLED] },
    },
  });
  const orderFullyRefunded = remainingActiveTickets === 0;

  const newPending = Math.max(0, lockedOrder.pendingRefundAmountInCents - refund.amountInCents);
  await tx.order.update({
    where: { id: lockedOrder.id },
    data: {
      pendingRefundAmountInCents: newPending,
      refundedAmountInCents: { increment: refund.amountInCents },
      ...(orderFullyRefunded ? { status: OrderStatus.REFUNDED } : {}),
    },
  });

  // Post exact persisted-allocation ledger accounting
  const ledgerRes = await recordTicketRefundLedgerInTx(tx, {
    orderId: lockedOrder.id,
    orderRefundId: refund.id,
    amountInCents: refund.amountInCents,
    ticketSubtotalInCents: refund.ticketSubtotalInCents,
    platformFeeReversedInCents: refund.platformFeeReversedInCents,
    serviceFeeReversedInCents: refund.serviceFeeReversedInCents,
    processingFeeInCents: refund.processingFeeInCents,
    organizerDebitInCents: refund.organizerDebitInCents,
    platformExpenseInCents: refund.platformExpenseInCents,
    stripeRefundId: params.stripeRefundId,
    stripeChargeId: params.stripeChargeId ?? refund.stripeChargeId,
    reason: refund.reason,
  });

  // Canonical Lock Step 4: Restore inventory only if explicitly requested and not yet restored
  let inventoryRestoredCount = 0;
  let tiersToAdvanceWaitlist: string[] = [];
  if (refund.restoreInventory) {
    const ticketTierMap = new Map(lockedTickets.map((t) => [t.id, t.ticketTierId]));
    const unRestoredRt = refundTickets.filter((rt) => rt.restoreInventory && !rt.inventoryRestored);
    const tierIdsToRestore = unRestoredRt
      .map((rt) => ticketTierMap.get(rt.ticketId))
      .filter((id): id is string => Boolean(id));

    if (tierIdsToRestore.length > 0) {
      const invResult = await restoreTierInventoryForTicketsInTx(tx, {
        eventId: lockedOrder.eventId,
        ticketTierIds: tierIdsToRestore,
      });
      inventoryRestoredCount = invResult.restoredCount;
      tiersToAdvanceWaitlist = invResult.tiersToAdvanceWaitlist;

      if (invResult.restoredTierIds.size > 0) {
        const restoredLineIds = unRestoredRt
          .filter((rt) => {
            const tid = ticketTierMap.get(rt.ticketId);
            return tid ? invResult.restoredTierIds.has(tid) : false;
          })
          .map((rt) => rt.id);

        if (restoredLineIds.length > 0) {
          await tx.orderRefundTicket.updateMany({
            where: { id: { in: restoredLineIds } },
            data: { inventoryRestored: true },
          });
        }
      }
    }
  }

  const updatedRefund = await tx.orderRefund.update({
    where: { id: refund.id },
    data: {
      status: OrderRefundStatus.SUCCEEDED,
      stripeRefundId: params.stripeRefundId,
      succeededAt: now,
      inventoryRestoredCount,
      lockedBy: null,
      lockedUntil: null,
      lastErrorCategory: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    },
  });

  return {
    alreadyFinalized: false,
    orderRefund: updatedRefund,
    orderFullyRefunded,
    ledgerRecorded: ledgerRes.recorded,
    inventoryRestoredCount,
    tiersToAdvanceWaitlist,
  };
}

/**
 * Definitively cancels an unconfirmed ticket refund, releasing ticket locks (`RELEASED`),
 * decrementing `pendingRefundAmountInCents`, and restoring each ticket's admission status
 * (`CHECKED_IN` if originally admitted prior to an ADMIN override, else `ISSUED`).
 */
export async function cancelTicketRefundInTx(
  tx: Prisma.TransactionClient,
  params: CancelTicketRefundInTxParams
): Promise<CancelTicketRefundResult> {
  const preLookup = await tx.orderRefund.findUnique({
    where: { id: params.orderRefundId },
    select: { id: true, orderId: true },
  });
  if (!preLookup || !preLookup.orderId) {
    throw new NotFoundError(`OrderRefund '${params.orderRefundId}' not found.`);
  }

  const orderRows = await tx.$queryRaw<
    Array<{ id: string; pendingRefundAmountInCents: number }>
  >`
    SELECT id, "pendingRefundAmountInCents"
    FROM "Order"
    WHERE id = ${preLookup.orderId}
    FOR UPDATE
  `;
  const lockedOrder = orderRows[0];
  if (!lockedOrder) {
    throw new NotFoundError(`Order '${preLookup.orderId}' not found.`);
  }

  const refundTickets = await tx.orderRefundTicket.findMany({
    where: { orderRefundId: params.orderRefundId },
    orderBy: { ticketId: 'asc' },
    select: { ticketId: true },
  });
  const ticketIds = refundTickets.map((rt) => rt.ticketId);
  const lockedTickets =
    ticketIds.length > 0
      ? await tx.$queryRaw<Array<{ id: string; checkedInAt: Date | null }>>`
          SELECT id, "checkedInAt"
          FROM "Ticket"
          WHERE id = ANY(${ticketIds})
          ORDER BY id ASC
          FOR UPDATE
        `
      : [];

  const refundRows = await tx.$queryRaw<OrderRefund[]>`
    SELECT * FROM "OrderRefund" WHERE id = ${params.orderRefundId} FOR UPDATE
  `;
  const refund = refundRows[0];
  if (!refund) {
    throw new NotFoundError(`OrderRefund '${params.orderRefundId}' not found.`);
  }

  if (refund.status === OrderRefundStatus.CANCELLED) {
    return {
      alreadyCancelled: true,
      orderRefund: refund,
      restoredTicketIds: [],
    };
  }

  if (
    refund.status === OrderRefundStatus.SUCCEEDED ||
    refund.status === OrderRefundStatus.MANUALLY_RESOLVED
  ) {
    throw new ConflictError(
      `Confirmed OrderRefund '${refund.id}' (${refund.status}) cannot be cancelled.`
    );
  }

  const now = params.cancelledAt ?? new Date();

  await tx.orderRefundTicket.updateMany({
    where: {
      orderRefundId: refund.id,
      lockState: OrderRefundTicketLockState.ACTIVE_PENDING,
    },
    data: { lockState: OrderRefundTicketLockState.RELEASED },
  });

  const restoredTicketIds: string[] = [];
  for (const t of lockedTickets) {
    const restoredStatus = t.checkedInAt ? TicketStatus.CHECKED_IN : TicketStatus.ISSUED;
    await tx.ticket.update({
      where: { id: t.id },
      data: { status: restoredStatus },
    });
    restoredTicketIds.push(t.id);
  }

  await tx.order.update({
    where: { id: lockedOrder.id },
    data: {
      pendingRefundAmountInCents: Math.max(
        0,
        lockedOrder.pendingRefundAmountInCents - refund.amountInCents
      ),
    },
  });

  const cancelledRefund = await tx.orderRefund.update({
    where: { id: refund.id },
    data: {
      status: OrderRefundStatus.CANCELLED,
      cancelledAt: now,
      cancellationReason: params.cancellationReason.trim(),
      requiresManualResolution: false,
      lockedBy: null,
      lockedUntil: null,
    },
  });

  return {
    alreadyCancelled: false,
    orderRefund: cancelledRefund,
    restoredTicketIds,
  };
}

/**
 * Executes local-only cancellation of zero-value free tickets inside caller's transaction.
 * Never creates an OrderRefund or FinancialLedgerEntry.
 */
export async function executeLocalFreeTicketCancellationInTx(
  tx: Prisma.TransactionClient,
  params: ExecuteLocalFreeCancellationInTxParams
): Promise<ExecuteLocalFreeCancellationResult> {
  const uniqueTicketIds = Array.from(new Set(params.ticketIds)).sort();

  const orderRows = await tx.$queryRaw<
    Array<{ id: string; eventId: string; totalInCents: number }>
  >`
    SELECT id, "eventId", "totalInCents"
    FROM "Order"
    WHERE id = ${params.orderId}
    FOR UPDATE
  `;
  const lockedOrder = orderRows[0];
  if (!lockedOrder) {
    throw new NotFoundError(`Order '${params.orderId}' not found.`);
  }

  const lockedTickets =
    uniqueTicketIds.length > 0
      ? await tx.$queryRaw<LockedTicketRow[]>`
          SELECT
            id,
            "orderId",
            "ticketTierId",
            status,
            "checkedInAt",
            "allocatedGrossInCents",
            "allocatedPlatformFeeInCents",
            "allocatedServiceFeeInCents",
            "allocatedProcessingFeeInCents",
            "allocatedBuyerTotalInCents",
            "createdAt"
          FROM "Ticket"
          WHERE id = ANY(${uniqueTicketIds})
          ORDER BY id ASC
          FOR UPDATE
        `
      : [];

  if (lockedTickets.length !== uniqueTicketIds.length) {
    throw new NotFoundError('One or more selected tickets could not be found.');
  }

  const tierIds = Array.from(new Set(lockedTickets.map((t) => t.ticketTierId)));
  const tiers = await tx.ticketTier.findMany({
    where: { id: { in: tierIds } },
    select: { id: true, priceInCents: true },
  });
  const tierPriceMap = new Map(tiers.map((t) => [t.id, t.priceInCents]));

  const existingLocks = await tx.orderRefundTicket.findMany({
    where: {
      ticketId: { in: uniqueTicketIds },
      lockState: {
        in: [OrderRefundTicketLockState.ACTIVE_PENDING, OrderRefundTicketLockState.CONFIRMED],
      },
    },
    select: { ticketId: true },
  });
  const lockedSet = new Set(existingLocks.map((l) => l.ticketId));

  const plan = computeLocalFreeTicketCancellationPlan({
    orderId: lockedOrder.id,
    orderTotalInCents: lockedOrder.totalInCents,
    initiatorRole: params.initiatorRole,
    initiatedByUserId: params.initiatedByUserId,
    reason: params.reason,
    restoreInventory: params.restoreInventory ?? true,
    tickets: lockedTickets.map((t) => ({
      id: t.id,
      orderId: t.orderId,
      ticketTierId: t.ticketTierId,
      status: t.status,
      hasActiveOrConfirmedRefundLock: lockedSet.has(t.id),
      tierPriceInCents: tierPriceMap.get(t.ticketTierId) ?? null,
      allocatedGrossInCents: t.allocatedGrossInCents,
      allocatedPlatformFeeInCents: t.allocatedPlatformFeeInCents,
      allocatedServiceFeeInCents: t.allocatedServiceFeeInCents,
      allocatedProcessingFeeInCents: t.allocatedProcessingFeeInCents,
      allocatedBuyerTotalInCents: t.allocatedBuyerTotalInCents,
    })),
  });

  const now = new Date();
  await tx.ticket.updateMany({
    where: { id: { in: plan.ticketIds }, orderId: lockedOrder.id },
    data: {
      status: TicketStatus.CANCELLED,
      cancelledAt: now,
      cancelledByUserId: params.initiatedByUserId,
      cancellationReason: plan.reason,
    },
  });

  let inventoryRestoredCount = 0;
  let tiersToAdvanceWaitlist: string[] = [];
  if (plan.restoreInventory && plan.inventoryReleaseByTier.length > 0) {
    const tierIdsToRestore = lockedTickets.map((t) => t.ticketTierId);
    const invRes = await restoreTierInventoryForTicketsInTx(tx, {
      eventId: lockedOrder.eventId,
      ticketTierIds: tierIdsToRestore,
    });
    inventoryRestoredCount = invRes.restoredCount;
    tiersToAdvanceWaitlist = invRes.tiersToAdvanceWaitlist;
  }

  return {
    plan,
    inventoryRestoredCount,
    tiersToAdvanceWaitlist,
  };
}

/**
 * Triggers waitlist advancement strictly AFTER the caller's PostgreSQL refund/cancellation
 * transaction commits. Never throws on background dispatch failure.
 */
export async function triggerPostCommitWaitlistAdvancement(tierIds: string[]): Promise<void> {
  const uniqueSortedTierIds = Array.from(new Set(tierIds)).sort();
  for (const tierId of uniqueSortedTierIds) {
    await processWaitlistForTier(tierId).catch((err) => {
      console.error(`[RefundWaitlistHandoff] Failed to advance waitlist for tier ${tierId}:`, err);
    });
  }
}
