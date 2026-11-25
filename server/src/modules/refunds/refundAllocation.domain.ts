import {
  OrderRefundKind,
  OrderRefundStatus,
  OrderRefundTicketLockState,
  RefundFeeBearer,
  RefundInitiatorRole,
  TicketStatus,
} from '@prisma/client';
import { calculateCheckoutFeeBreakdown } from '../checkout/checkout.financials.js';

export const LATE_PAYMENT_REFUND_IDEMPOTENCY_PREFIX = 'late-refund:';

/**
 * Builds the deterministic idempotency key for P2-04 late-payment automatic refunds.
 */
export function buildLatePaymentRefundIdempotencyKey(paymentIntentId: string): string {
  return `${LATE_PAYMENT_REFUND_IDEMPOTENCY_PREFIX}${paymentIntentId}`;
}

export interface OrderTicketAllocationInput {
  ticketId: string;
  ticketTierId: string;
  grossPriceInCents: number;
}

export interface PersistedTicketPaymentAllocation {
  ticketId: string;
  ticketTierId: string;
  allocatedGrossInCents: number;
  allocatedPlatformFeeInCents: number;
  allocatedServiceFeeInCents: number;
  allocatedProcessingFeeInCents: number;
  allocatedBuyerTotalInCents: number;
}

export interface OrderAllocationSummary {
  ticketSubtotalInCents: number;
  platformFeeInCents: number;
  serviceFeeInCents: number;
  processingFeeInCents: number;
  buyerTotalInCents: number;
  tickets: PersistedTicketPaymentAllocation[];
}

export interface OrderLevelFeeTargets {
  buyerTotalInCents: number;
  ticketSubtotalInCents?: number;
  platformFeeInCents?: number;
  serviceFeeInCents?: number;
  processingFeeInCents?: number;
}

function assertNonNegativeSafeInteger(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative integer, received ${value}`);
  }
  return value;
}

/**
 * Deterministic Hamilton / largest-remainder integer-cent distribution.
 * Distributes `totalCents` proportionally to `weights`, breaking ties strictly by
 * positional index so `sum(result) === totalCents` always holds without cent drift.
 */
export function distributeIntegerCents(totalCents: number, weights: number[]): number[] {
  const safeTotal = assertNonNegativeSafeInteger(totalCents, 'totalCents');
  if (weights.length === 0) {
    if (safeTotal !== 0) {
      throw new Error(`Cannot distribute ${safeTotal} cents across 0 items`);
    }
    return [];
  }

  const normalizedWeights = weights.map((w, idx) =>
    assertNonNegativeSafeInteger(w, `weights[${idx}]`)
  );

  let effectiveWeights = normalizedWeights;
  let weightSum = effectiveWeights.reduce((sum, w) => sum + w, 0);
  if (weightSum === 0) {
    effectiveWeights = weights.map(() => 1);
    weightSum = effectiveWeights.length;
  }

  const shares = new Array<number>(effectiveWeights.length);
  const remainders: Array<{ index: number; numerator: number }> = [];

  let assignedSum = 0;
  for (let i = 0; i < effectiveWeights.length; i++) {
    const product = safeTotal * effectiveWeights[i];
    const base = Math.floor(product / weightSum);
    const numerator = product % weightSum;
    shares[i] = base;
    assignedSum += base;
    remainders.push({ index: i, numerator });
  }

  const remainingCents = safeTotal - assignedSum;
  remainders.sort((a, b) => {
    if (b.numerator !== a.numerator) {
      return b.numerator - a.numerator;
    }
    return a.index - b.index;
  });

  for (let i = 0; i < remainingCents; i++) {
    shares[remainders[i].index] += 1;
  }

  return shares;
}

/**
 * Deterministically allocates exact integer-cent payment components across every ticket
 * in an order. Callers should pass `tickets` in deterministic creation order (e.g.
 * `(createdAt ASC, id ASC)`) so allocations are 100% reproducible.
 *
 * Guarantees:
 * - sum(allocatedGrossInCents) === ticketSubtotalInCents
 * - sum(allocatedPlatformFeeInCents) === platformFeeInCents
 * - sum(allocatedServiceFeeInCents) === serviceFeeInCents
 * - sum(allocatedProcessingFeeInCents) === processingFeeInCents
 * - sum(allocatedBuyerTotalInCents) === buyerTotalInCents === targets.buyerTotalInCents
 */
export function allocateOrderTicketPayments(
  targets: OrderLevelFeeTargets,
  tickets: OrderTicketAllocationInput[]
): OrderAllocationSummary {
  if (tickets.length === 0) {
    throw new Error('Cannot allocate order ticket payments across 0 tickets');
  }

  const expectedBuyerTotal = assertNonNegativeSafeInteger(
    targets.buyerTotalInCents,
    'targets.buyerTotalInCents'
  );
  const ticketGrossPrices = tickets.map((t, idx) =>
    assertNonNegativeSafeInteger(t.grossPriceInCents, `tickets[${idx}].grossPriceInCents`)
  );
  const computedGrossSum = ticketGrossPrices.reduce((sum, price) => sum + price, 0);

  if (expectedBuyerTotal === 0) {
    if (computedGrossSum !== 0) {
      throw new Error(
        `Free order totalInCents=0 contradicts positive ticket gross sum=${computedGrossSum}`
      );
    }
    if (
      (targets.ticketSubtotalInCents ?? 0) !== 0 ||
      (targets.platformFeeInCents ?? 0) !== 0 ||
      (targets.serviceFeeInCents ?? 0) !== 0 ||
      (targets.processingFeeInCents ?? 0) !== 0
    ) {
      throw new Error('Free order totalInCents=0 cannot carry non-zero fee components');
    }

    return {
      ticketSubtotalInCents: 0,
      platformFeeInCents: 0,
      serviceFeeInCents: 0,
      processingFeeInCents: 0,
      buyerTotalInCents: 0,
      tickets: tickets.map((t) => ({
        ticketId: t.ticketId,
        ticketTierId: t.ticketTierId,
        allocatedGrossInCents: 0,
        allocatedPlatformFeeInCents: 0,
        allocatedServiceFeeInCents: 0,
        allocatedProcessingFeeInCents: 0,
        allocatedBuyerTotalInCents: 0,
      })),
    };
  }

  const canonical = calculateCheckoutFeeBreakdown(
    ticketGrossPrices.map((priceInCents) => ({ priceInCents, quantity: 1 }))
  );

  const ticketSubtotalInCents =
    targets.ticketSubtotalInCents !== undefined
      ? assertNonNegativeSafeInteger(targets.ticketSubtotalInCents, 'targets.ticketSubtotalInCents')
      : canonical.ticketSubtotalInCents;
  if (ticketSubtotalInCents !== computedGrossSum) {
    throw new Error(
      `Ticket gross sum (${computedGrossSum}) does not match order ticketSubtotalInCents (${ticketSubtotalInCents})`
    );
  }

  const platformFeeInCents =
    targets.platformFeeInCents !== undefined
      ? assertNonNegativeSafeInteger(targets.platformFeeInCents, 'targets.platformFeeInCents')
      : canonical.platformFeeInCents;
  const serviceFeeInCents =
    targets.serviceFeeInCents !== undefined
      ? assertNonNegativeSafeInteger(targets.serviceFeeInCents, 'targets.serviceFeeInCents')
      : canonical.serviceFeeInCents;
  const processingFeeInCents =
    targets.processingFeeInCents !== undefined
      ? assertNonNegativeSafeInteger(targets.processingFeeInCents, 'targets.processingFeeInCents')
      : canonical.processingFeeInCents;

  const summedComponents =
    ticketSubtotalInCents + platformFeeInCents + serviceFeeInCents + processingFeeInCents;
  if (summedComponents !== expectedBuyerTotal) {
    throw new Error(
      `Fee breakdown sum (${summedComponents}) does not match order buyerTotalInCents (${expectedBuyerTotal})`
    );
  }

  const platformFeeShares = distributeIntegerCents(platformFeeInCents, ticketGrossPrices);
  const serviceFeeShares = distributeIntegerCents(
    serviceFeeInCents,
    tickets.map(() => 1)
  );
  const preProcessingTotals = tickets.map(
    (_, idx) => ticketGrossPrices[idx] + platformFeeShares[idx] + serviceFeeShares[idx]
  );
  const processingFeeShares = distributeIntegerCents(processingFeeInCents, preProcessingTotals);

  const allocatedTickets: PersistedTicketPaymentAllocation[] = tickets.map((ticket, idx) => {
    const gross = ticketGrossPrices[idx];
    const platform = platformFeeShares[idx];
    const service = serviceFeeShares[idx];
    const processing = processingFeeShares[idx];
    return {
      ticketId: ticket.ticketId,
      ticketTierId: ticket.ticketTierId,
      allocatedGrossInCents: gross,
      allocatedPlatformFeeInCents: platform,
      allocatedServiceFeeInCents: service,
      allocatedProcessingFeeInCents: processing,
      allocatedBuyerTotalInCents: gross + platform + service + processing,
    };
  });

  const allocatedTotalSum = allocatedTickets.reduce(
    (sum, t) => sum + t.allocatedBuyerTotalInCents,
    0
  );
  if (allocatedTotalSum !== expectedBuyerTotal) {
    throw new Error(
      `Allocated ticket sum (${allocatedTotalSum}) drifted from expectedBuyerTotal (${expectedBuyerTotal})`
    );
  }

  return {
    ticketSubtotalInCents,
    platformFeeInCents,
    serviceFeeInCents,
    processingFeeInCents,
    buyerTotalInCents: expectedBuyerTotal,
    tickets: allocatedTickets,
  };
}

export interface RefundEligibleTicketSnapshot {
  id: string;
  orderId: string;
  status: TicketStatus;
  allocatedGrossInCents: number | null;
  allocatedPlatformFeeInCents: number | null;
  allocatedServiceFeeInCents: number | null;
  allocatedProcessingFeeInCents: number | null;
  allocatedBuyerTotalInCents: number | null;
  hasActiveOrConfirmedRefundLock: boolean;
}

export type TicketRefundRejectionReason =
  | 'UNAUTHORIZED_INITIATOR_ROLE'
  | 'EMPTY_TICKET_SELECTION'
  | 'DUPLICATE_TICKET_SELECTION'
  | 'CROSS_ORDER_TICKET_SELECTION'
  | 'FREE_TICKET_NOT_REFUNDABLE'
  | 'CHECKED_IN_TICKET_NOT_REFUNDABLE'
  | 'TICKET_NOT_ISSUED'
  | 'TICKET_ALREADY_LOCKED_FOR_REFUND'
  | 'MISSING_PERSISTED_ALLOCATION'
  | 'INVALID_PERSISTED_ALLOCATION'
  | 'PAID_TICKET_REQUIRES_MONETARY_REFUND'
  | 'REFUND_AMOUNT_PARITY_MISMATCH'
  | 'LOCK_STATE_MISMATCH';

export class RefundDomainRuleError extends Error {
  public readonly code: TicketRefundRejectionReason | 'CUMULATIVE_REFUND_CAP_EXCEEDED' | 'INVALID_FEE_BEARER' | 'INVALID_REFUND_AMOUNT';

  constructor(
    code:
      | TicketRefundRejectionReason
      | 'CUMULATIVE_REFUND_CAP_EXCEEDED'
      | 'INVALID_FEE_BEARER'
      | 'INVALID_REFUND_AMOUNT',
    message: string
  ) {
    super(message);
    this.name = 'RefundDomainRuleError';
    this.code = code;
  }
}

export interface ValidateTicketRefundSelectionParams {
  orderId: string;
  orderTotalInCents: number;
  initiatorRole: RefundInitiatorRole;
  tickets: RefundEligibleTicketSnapshot[];
}

/**
 * Enforces P0-03 Workstream B locked domain rules for ticket-based refunds:
 * - Initiator must be ORGANIZER or ADMIN (buyers cannot self-initiate in this release)
 * - Partial/full refunds always operate on non-empty unique tickets from one order
 * - Checked-in, already refunded, refund-pending, cancelled, locked, or free $0 tickets are rejected
 * - Every selected ticket must carry a valid persisted integer allocation
 */
export function validateTicketRefundSelection(params: ValidateTicketRefundSelectionParams): void {
  if (
    params.initiatorRole !== RefundInitiatorRole.ORGANIZER &&
    params.initiatorRole !== RefundInitiatorRole.ADMIN
  ) {
    throw new RefundDomainRuleError(
      'UNAUTHORIZED_INITIATOR_ROLE',
      `Only ORGANIZER or ADMIN can initiate ticket refunds (received ${params.initiatorRole})`
    );
  }

  if (params.tickets.length === 0) {
    throw new RefundDomainRuleError(
      'EMPTY_TICKET_SELECTION',
      'At least one ticket must be selected for a ticket-based refund'
    );
  }

  if (params.orderTotalInCents <= 0) {
    throw new RefundDomainRuleError(
      'FREE_TICKET_NOT_REFUNDABLE',
      'Free orders ($0 total) cannot create monetary Stripe refunds'
    );
  }

  const seenIds = new Set<string>();
  for (const ticket of params.tickets) {
    if (seenIds.has(ticket.id)) {
      throw new RefundDomainRuleError(
        'DUPLICATE_TICKET_SELECTION',
        `Duplicate ticketId in selection: ${ticket.id}`
      );
    }
    seenIds.add(ticket.id);

    if (ticket.orderId !== params.orderId) {
      throw new RefundDomainRuleError(
        'CROSS_ORDER_TICKET_SELECTION',
        `Ticket ${ticket.id} belongs to order ${ticket.orderId}, expected ${params.orderId}`
      );
    }

    if (ticket.hasActiveOrConfirmedRefundLock) {
      throw new RefundDomainRuleError(
        'TICKET_ALREADY_LOCKED_FOR_REFUND',
        `Ticket ${ticket.id} is already in an active or confirmed refund`
      );
    }

    if (ticket.status === TicketStatus.CHECKED_IN) {
      throw new RefundDomainRuleError(
        'CHECKED_IN_TICKET_NOT_REFUNDABLE',
        `Ticket ${ticket.id} is already CHECKED_IN and cannot be refunded`
      );
    }

    if (ticket.status !== TicketStatus.ISSUED) {
      throw new RefundDomainRuleError(
        'TICKET_NOT_ISSUED',
        `Ticket ${ticket.id} has status ${ticket.status} and is not eligible for refund`
      );
    }

    if (
      ticket.allocatedGrossInCents === null ||
      ticket.allocatedPlatformFeeInCents === null ||
      ticket.allocatedServiceFeeInCents === null ||
      ticket.allocatedProcessingFeeInCents === null ||
      ticket.allocatedBuyerTotalInCents === null
    ) {
      throw new RefundDomainRuleError(
        'MISSING_PERSISTED_ALLOCATION',
        `Ticket ${ticket.id} lacks persisted integer payment allocation`
      );
    }

    const expectedTotal =
      ticket.allocatedGrossInCents +
      ticket.allocatedPlatformFeeInCents +
      ticket.allocatedServiceFeeInCents +
      ticket.allocatedProcessingFeeInCents;
    if (
      ticket.allocatedGrossInCents < 0 ||
      ticket.allocatedPlatformFeeInCents < 0 ||
      ticket.allocatedServiceFeeInCents < 0 ||
      ticket.allocatedProcessingFeeInCents < 0 ||
      ticket.allocatedBuyerTotalInCents !== expectedTotal
    ) {
      throw new RefundDomainRuleError(
        'INVALID_PERSISTED_ALLOCATION',
        `Ticket ${ticket.id} has corrupted persisted integer allocation`
      );
    }

    if (ticket.allocatedBuyerTotalInCents <= 0) {
      throw new RefundDomainRuleError(
        'FREE_TICKET_NOT_REFUNDABLE',
        `Free ticket ${ticket.id} ($0 allocation) cannot initiate a monetary refund`
      );
    }
  }
}

export interface ComputeTicketRefundQuoteParams {
  orderId: string;
  orderTotalInCents: number;
  orderRefundedAmountInCents: number;
  orderPendingRefundAmountInCents: number;
  initiatorRole: RefundInitiatorRole;
  tickets: RefundEligibleTicketSnapshot[];
  /**
   * When false (default), refunds each ticket's gross + platform fee + service fee,
   * excluding Stripe processing fees unless explicitly borne/included.
   * When true, returns the full persisted buyer-paid allocation including Stripe processing fee.
   */
  refundStripeProcessingFee?: boolean;
  /**
   * Who bears non-returned Stripe processing costs when refunding (ORGANIZER, PLATFORM, SHARED).
   */
  feeBearer: RefundFeeBearer;
}

export interface TicketRefundLineQuote {
  ticketId: string;
  allocatedGrossInCents: number;
  allocatedPlatformFeeInCents: number;
  allocatedServiceFeeInCents: number;
  allocatedProcessingFeeInCents: number;
  allocatedBuyerTotalInCents: number;
  refundedAmountInCents: number;
}

export interface TicketRefundQuote {
  refundKind: OrderRefundKind;
  refundAmountInCents: number;
  ticketSubtotalInCents: number;
  platformFeeReversedInCents: number;
  serviceFeeReversedInCents: number;
  processingFeeInCents: number;
  refundStripeProcessingFee: boolean;
  feeBearer: RefundFeeBearer;
  organizerDebitInCents: number;
  platformExpenseInCents: number;
  remainingOrderRefundableAfterInCents: number;
  lineItems: TicketRefundLineQuote[];
}

/**
 * Computes exact integer-cent ticket refund amounts and organizer/platform cost attribution
 * from persisted ticket allocations and asserts cumulative order refund caps.
 */
export function computeTicketRefundQuote(params: ComputeTicketRefundQuoteParams): TicketRefundQuote {
  validateTicketRefundSelection({
    orderId: params.orderId,
    orderTotalInCents: params.orderTotalInCents,
    initiatorRole: params.initiatorRole,
    tickets: params.tickets,
  });

  if (params.feeBearer === RefundFeeBearer.NOT_APPLICABLE) {
    throw new RefundDomainRuleError(
      'INVALID_FEE_BEARER',
      'Ticket-based refunds require an explicit feeBearer (ORGANIZER, PLATFORM, or SHARED)'
    );
  }

  const refundStripeProcessingFee = Boolean(params.refundStripeProcessingFee);
  const lineItems: TicketRefundLineQuote[] = [];
  let ticketSubtotalInCents = 0;
  let platformFeeReversedInCents = 0;
  let serviceFeeReversedInCents = 0;
  let processingFeeInCents = 0;
  let refundAmountInCents = 0;

  for (const ticket of params.tickets) {
    const gross = ticket.allocatedGrossInCents!;
    const platform = ticket.allocatedPlatformFeeInCents!;
    const service = ticket.allocatedServiceFeeInCents!;
    const processing = ticket.allocatedProcessingFeeInCents!;
    const buyerTotal = ticket.allocatedBuyerTotalInCents!;
    const ticketRefundCents = refundStripeProcessingFee ? buyerTotal : gross + platform + service;

    if (ticketRefundCents <= 0 || ticketRefundCents > buyerTotal) {
      throw new RefundDomainRuleError(
        'INVALID_REFUND_AMOUNT',
        `Computed refund amount ${ticketRefundCents} for ticket ${ticket.id} exceeds buyer allocation ${buyerTotal}`
      );
    }

    ticketSubtotalInCents += gross;
    platformFeeReversedInCents += platform;
    serviceFeeReversedInCents += service;
    processingFeeInCents += processing;
    refundAmountInCents += ticketRefundCents;

    lineItems.push({
      ticketId: ticket.id,
      allocatedGrossInCents: gross,
      allocatedPlatformFeeInCents: platform,
      allocatedServiceFeeInCents: service,
      allocatedProcessingFeeInCents: processing,
      allocatedBuyerTotalInCents: buyerTotal,
      refundedAmountInCents: ticketRefundCents,
    });
  }

  const alreadyCommitted = params.orderRefundedAmountInCents + params.orderPendingRefundAmountInCents;
  if (
    params.orderRefundedAmountInCents < 0 ||
    params.orderPendingRefundAmountInCents < 0 ||
    alreadyCommitted + refundAmountInCents > params.orderTotalInCents
  ) {
    throw new RefundDomainRuleError(
      'CUMULATIVE_REFUND_CAP_EXCEEDED',
      `Refund of ${refundAmountInCents} cents plus committed refunds (${alreadyCommitted}) exceeds original payment total (${params.orderTotalInCents})`
    );
  }

  // Processing fee cost attribution:
  // Stripe processing fees incurred on the original charge are not returned by Stripe to the merchant.
  // When refunded to the buyer (refundStripeProcessingFee=true), or absorbed by organizer vs platform,
  // organizerDebitInCents and platformExpenseInCents explicitly record who absorbs processingFeeInCents.
  let organizerProcessingCharge = 0;
  let platformProcessingExpense = 0;
  if (refundStripeProcessingFee && processingFeeInCents > 0) {
    if (params.feeBearer === RefundFeeBearer.ORGANIZER) {
      organizerProcessingCharge = processingFeeInCents;
    } else if (params.feeBearer === RefundFeeBearer.PLATFORM) {
      platformProcessingExpense = processingFeeInCents;
    } else if (params.feeBearer === RefundFeeBearer.SHARED) {
      // Deterministic even split with odd remainder borne by platform
      organizerProcessingCharge = Math.floor(processingFeeInCents / 2);
      platformProcessingExpense = processingFeeInCents - organizerProcessingCharge;
    }
  }

  const organizerDebitInCents = ticketSubtotalInCents + organizerProcessingCharge;
  const platformExpenseInCents = platformProcessingExpense;

  const refundKind =
    params.initiatorRole === RefundInitiatorRole.ADMIN
      ? OrderRefundKind.ADMIN_TICKET_REFUND
      : OrderRefundKind.ORGANIZER_TICKET_REFUND;

  return {
    refundKind,
    refundAmountInCents,
    ticketSubtotalInCents,
    platformFeeReversedInCents,
    serviceFeeReversedInCents,
    processingFeeInCents,
    refundStripeProcessingFee,
    feeBearer: params.feeBearer,
    organizerDebitInCents,
    platformExpenseInCents,
    remainingOrderRefundableAfterInCents:
      params.orderTotalInCents - (alreadyCommitted + refundAmountInCents),
    lineItems,
  };
}

/**
 * Canonical lock state corresponding to each OrderRefundStatus lifecycle state.
 */
export function resolveLockStateForOrderRefundStatus(
  status: OrderRefundStatus
): OrderRefundTicketLockState {
  switch (status) {
    case OrderRefundStatus.PENDING:
    case OrderRefundStatus.PROCESSING:
    case OrderRefundStatus.STRIPE_PENDING:
    case OrderRefundStatus.MANUAL_REVIEW_REQUIRED:
      return OrderRefundTicketLockState.ACTIVE_PENDING;
    case OrderRefundStatus.SUCCEEDED:
    case OrderRefundStatus.MANUALLY_RESOLVED:
      return OrderRefundTicketLockState.CONFIRMED;
    case OrderRefundStatus.CANCELLED:
      return OrderRefundTicketLockState.RELEASED;
  }
}

export interface FreeTicketCancellationSnapshot {
  id: string;
  orderId: string;
  ticketTierId: string;
  status: TicketStatus;
  hasActiveOrConfirmedRefundLock: boolean;
  /** Optional unit gross price of the ticket tier in cents; if provided on a paid tier (> 0), rejects local-only cancellation. */
  tierPriceInCents?: number | null;
  allocatedGrossInCents?: number | null;
  allocatedPlatformFeeInCents?: number | null;
  allocatedServiceFeeInCents?: number | null;
  allocatedProcessingFeeInCents?: number | null;
  allocatedBuyerTotalInCents?: number | null;
}

export interface ValidateFreeTicketCancellationParams {
  orderId: string;
  orderTotalInCents: number;
  initiatorRole: RefundInitiatorRole;
  tickets: FreeTicketCancellationSnapshot[];
}

export interface ComputeLocalFreeTicketCancellationPlanParams
  extends ValidateFreeTicketCancellationParams {
  initiatedByUserId: string;
  reason: string;
  restoreInventory?: boolean;
}

export interface LocalFreeTicketCancellationPlan {
  action: 'LOCAL_FREE_TICKET_CANCELLATION';
  orderId: string;
  initiatorRole: RefundInitiatorRole;
  initiatedByUserId: string;
  reason: string;
  targetTicketStatus: TicketStatus;
  createOrderRefundRecord: false;
  stripeRefundAmountInCents: 0;
  ledgerRefundAmountInCents: 0;
  ticketIds: string[];
  restoreInventory: boolean;
  inventoryReleaseByTier: Array<{ ticketTierId: string; releaseQuantity: number }>;
}

/**
 * Validates whether a selection of tickets qualifies for local-only free-ticket cancellation
 * without any Stripe refund or financial ledger entry.
 *
 * Mixed-cart rule: if `orderTotalInCents > 0`, a `$0` tier ticket in a paid order may carry a
 * persisted `$0.95` service-fee + processing-fee allocation under `calculateCheckoutFeeBreakdown`.
 * This guard NEVER discards paid buyer fees or guesses missing allocations—it permits local-only
 * cancellation ONLY when persisted allocations prove `allocatedBuyerTotalInCents === 0` (and gross === 0),
 * or when `orderTotalInCents === 0` and no non-zero entitlement exists.
 */
export function validateFreeTicketCancellationSelection(
  params: ValidateFreeTicketCancellationParams
): void {
  if (
    params.initiatorRole !== RefundInitiatorRole.ORGANIZER &&
    params.initiatorRole !== RefundInitiatorRole.ADMIN
  ) {
    throw new RefundDomainRuleError(
      'UNAUTHORIZED_INITIATOR_ROLE',
      `Only ORGANIZER or ADMIN can cancel free tickets (received ${params.initiatorRole})`
    );
  }

  if (!Number.isInteger(params.orderTotalInCents) || params.orderTotalInCents < 0) {
    throw new RefundDomainRuleError(
      'INVALID_REFUND_AMOUNT',
      `Order totalInCents must be a non-negative integer, received ${params.orderTotalInCents}`
    );
  }

  if (params.tickets.length === 0) {
    throw new RefundDomainRuleError(
      'EMPTY_TICKET_SELECTION',
      'At least one ticket must be selected for free-ticket cancellation'
    );
  }

  const seenIds = new Set<string>();
  for (const ticket of params.tickets) {
    if (seenIds.has(ticket.id)) {
      throw new RefundDomainRuleError(
        'DUPLICATE_TICKET_SELECTION',
        `Duplicate ticketId in selection: ${ticket.id}`
      );
    }
    seenIds.add(ticket.id);

    if (ticket.orderId !== params.orderId) {
      throw new RefundDomainRuleError(
        'CROSS_ORDER_TICKET_SELECTION',
        `Ticket ${ticket.id} belongs to order ${ticket.orderId}, expected ${params.orderId}`
      );
    }

    if (ticket.hasActiveOrConfirmedRefundLock) {
      throw new RefundDomainRuleError(
        'TICKET_ALREADY_LOCKED_FOR_REFUND',
        `Ticket ${ticket.id} has an active or confirmed refund lock`
      );
    }

    if (ticket.status === TicketStatus.CHECKED_IN) {
      throw new RefundDomainRuleError(
        'CHECKED_IN_TICKET_NOT_REFUNDABLE',
        `Ticket ${ticket.id} is already CHECKED_IN and cannot be cancelled`
      );
    }

    if (ticket.status !== TicketStatus.ISSUED) {
      throw new RefundDomainRuleError(
        'TICKET_NOT_ISSUED',
        `Ticket ${ticket.id} has status ${ticket.status} and cannot be cancelled locally`
      );
    }

    if (typeof ticket.tierPriceInCents === 'number' && ticket.tierPriceInCents > 0) {
      throw new RefundDomainRuleError(
        'PAID_TICKET_REQUIRES_MONETARY_REFUND',
        `Ticket ${ticket.id} belongs to paid tier (${ticket.tierPriceInCents} cents) and must use the monetary refund workflow`
      );
    }

    const allocFields = [
      ticket.allocatedGrossInCents,
      ticket.allocatedPlatformFeeInCents,
      ticket.allocatedServiceFeeInCents,
      ticket.allocatedProcessingFeeInCents,
      ticket.allocatedBuyerTotalInCents,
    ];
    const hasAnyAlloc = allocFields.some((v) => v !== undefined && v !== null);
    const hasAllAlloc = allocFields.every((v) => v !== undefined && v !== null);

    if (hasAnyAlloc && !hasAllAlloc) {
      throw new RefundDomainRuleError(
        'INVALID_PERSISTED_ALLOCATION',
        `Ticket ${ticket.id} has partially populated allocation fields`
      );
    }

    if (hasAllAlloc) {
      const gross = ticket.allocatedGrossInCents!;
      const platform = ticket.allocatedPlatformFeeInCents!;
      const service = ticket.allocatedServiceFeeInCents!;
      const processing = ticket.allocatedProcessingFeeInCents!;
      const total = ticket.allocatedBuyerTotalInCents!;

      if (
        gross < 0 ||
        platform < 0 ||
        service < 0 ||
        processing < 0 ||
        total !== gross + platform + service + processing
      ) {
        throw new RefundDomainRuleError(
          'INVALID_PERSISTED_ALLOCATION',
          `Ticket ${ticket.id} has corrupted persisted integer allocation`
        );
      }

      if (params.orderTotalInCents === 0 && total !== 0) {
        throw new RefundDomainRuleError(
          'INVALID_PERSISTED_ALLOCATION',
          `Free order ($0 total) ticket ${ticket.id} cannot carry non-zero allocation (${total} cents)`
        );
      }

      if (total > 0) {
        throw new RefundDomainRuleError(
          'PAID_TICKET_REQUIRES_MONETARY_REFUND',
          `Ticket ${ticket.id} carries ${total} cents of allocated buyer payment and requires a monetary refund`
        );
      }
    } else if (params.orderTotalInCents > 0) {
      throw new RefundDomainRuleError(
        'MISSING_PERSISTED_ALLOCATION',
        `Ticket ${ticket.id} belongs to a paid or mixed order (${params.orderTotalInCents} cents) without persisted ticket allocations; cannot prove $0 refundable entitlement`
      );
    }
  }
}

/**
 * Computes a local-only cancellation plan for eligible zero-value free tickets.
 * Guarantees zero Stripe refund, zero financial-ledger refund, and no OrderRefund record.
 */
export function computeLocalFreeTicketCancellationPlan(
  params: ComputeLocalFreeTicketCancellationPlanParams
): LocalFreeTicketCancellationPlan {
  validateFreeTicketCancellationSelection({
    orderId: params.orderId,
    orderTotalInCents: params.orderTotalInCents,
    initiatorRole: params.initiatorRole,
    tickets: params.tickets,
  });

  const restoreInventory = params.restoreInventory ?? true;
  const tierCounts = new Map<string, number>();
  for (const ticket of params.tickets) {
    tierCounts.set(ticket.ticketTierId, (tierCounts.get(ticket.ticketTierId) ?? 0) + 1);
  }

  const inventoryReleaseByTier = restoreInventory
    ? Array.from(tierCounts.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([ticketTierId, releaseQuantity]) => ({ ticketTierId, releaseQuantity }))
    : [];

  return {
    action: 'LOCAL_FREE_TICKET_CANCELLATION',
    orderId: params.orderId,
    initiatorRole: params.initiatorRole,
    initiatedByUserId: params.initiatedByUserId,
    reason: params.reason.trim(),
    targetTicketStatus: TicketStatus.CANCELLED,
    createOrderRefundRecord: false,
    stripeRefundAmountInCents: 0,
    ledgerRefundAmountInCents: 0,
    ticketIds: params.tickets.map((t) => t.id),
    restoreInventory,
    inventoryReleaseByTier,
  };
}

/**
 * Explicit mapping from persisted OrderRefund records to Order refund counters:
 *
 * 1. Scope by `refundKind`:
 *    - Order-payment refund kinds (`ORGANIZER_TICKET_REFUND`, `ADMIN_TICKET_REFUND`,
 *      `EVENT_CANCELLATION`, `EXTERNAL_STRIPE_RECONCILED`) consume `Order.totalInCents` and
 *      contribute to `Order.refundedAmountInCents` or `Order.pendingRefundAmountInCents`.
 *    - `LATE_PAYMENT` (P2-04 duplicate-PI / late-payment / amount-mismatch refunds) does NOT
 *      consume fulfilled `Order.totalInCents` counters because it represents rejected/duplicate
 *      payments rather than ticket entitlement refunds; it is tracked separately in
 *      `latePaymentRefundAmountInCents`.
 *
 * 2. Scope by `status` (for order-payment refund kinds):
 *    - `PENDING`, `PROCESSING`, `STRIPE_PENDING`, `MANUAL_REVIEW_REQUIRED` -> `pendingRefundAmountInCents`
 *    - `SUCCEEDED` -> `refundedAmountInCents`
 *    - `MANUALLY_RESOLVED`:
 *        * `resolutionAction` in (`NO_REFUND_NEEDED`, `FULFILLED_MANUALLY`) -> 0 (released)
 *        * otherwise (`REFUNDED_MANUALLY`, `CONFIRMED_ALREADY_REFUNDED`, or unset) -> `refundedAmountInCents`
 *    - `CANCELLED` -> 0 (released)
 */
export const ORDER_PAYMENT_COUNTER_REFUND_KINDS: ReadonlySet<OrderRefundKind> = new Set([
  OrderRefundKind.ORGANIZER_TICKET_REFUND,
  OrderRefundKind.ADMIN_TICKET_REFUND,
  OrderRefundKind.EVENT_CANCELLATION,
  OrderRefundKind.EXTERNAL_STRIPE_RECONCILED,
]);

export type RefundCounterBucket = 'CONFIRMED' | 'ACTIVE_PENDING' | 'RELEASED' | 'LATE_PAYMENT';

export function classifyOrderRefundCounterBucket(params: {
  refundKind: OrderRefundKind;
  status: OrderRefundStatus;
  resolutionAction?: string | null;
}): RefundCounterBucket {
  if (params.refundKind === OrderRefundKind.LATE_PAYMENT) {
    return 'LATE_PAYMENT';
  }

  switch (params.status) {
    case OrderRefundStatus.PENDING:
    case OrderRefundStatus.PROCESSING:
    case OrderRefundStatus.STRIPE_PENDING:
    case OrderRefundStatus.MANUAL_REVIEW_REQUIRED:
      return 'ACTIVE_PENDING';
    case OrderRefundStatus.SUCCEEDED:
      return 'CONFIRMED';
    case OrderRefundStatus.MANUALLY_RESOLVED:
      if (
        params.resolutionAction === 'NO_REFUND_NEEDED' ||
        params.resolutionAction === 'FULFILLED_MANUALLY'
      ) {
        return 'RELEASED';
      }
      return 'CONFIRMED';
    case OrderRefundStatus.CANCELLED:
      return 'RELEASED';
  }
}

export interface PersistedOrderRefundTicketRecord {
  ticketId: string;
  orderId: string;
  lockState: OrderRefundTicketLockState;
  allocatedGrossInCents: number;
  allocatedPlatformFeeInCents: number;
  allocatedServiceFeeInCents: number;
  allocatedProcessingFeeInCents: number;
  allocatedBuyerTotalInCents: number;
  refundedAmountInCents: number;
}

export interface PersistedOrderRefundRecord {
  id: string;
  orderId: string | null;
  refundKind: OrderRefundKind;
  status: OrderRefundStatus;
  amountInCents: number;
  resolutionAction?: string | null;
  tickets?: PersistedOrderRefundTicketRecord[];
}

export interface ReconcileOrderRefundCountersInput {
  orderId: string;
  orderTotalInCents: number;
  refunds: PersistedOrderRefundRecord[];
}

export interface ReconciledOrderRefundCounters {
  orderId: string;
  orderTotalInCents: number;
  refundedAmountInCents: number;
  pendingRefundAmountInCents: number;
  remainingRefundableInCents: number;
  latePaymentRefundAmountInCents: number;
  latePaymentRefundCount: number;
  activeTicketIds: string[];
  confirmedTicketIds: string[];
}

/**
 * Pure, deterministic, idempotent reconciliation of `Order.refundedAmountInCents` and
 * `Order.pendingRefundAmountInCents` from authoritative persisted `OrderRefund` +
 * `OrderRefundTicket` records.
 */
export function reconcileOrderRefundCountersFromRecords(
  input: ReconcileOrderRefundCountersInput
): ReconciledOrderRefundCounters {
  const orderTotalInCents = assertNonNegativeSafeInteger(
    input.orderTotalInCents,
    'orderTotalInCents'
  );

  let refundedAmountInCents = 0;
  let pendingRefundAmountInCents = 0;
  let latePaymentRefundAmountInCents = 0;
  let latePaymentRefundCount = 0;
  const activeTicketIds = new Set<string>();
  const confirmedTicketIds = new Set<string>();
  const seenRefundIds = new Set<string>();

  const sortedRefunds = [...input.refunds].sort((a, b) => a.id.localeCompare(b.id));

  for (const refund of sortedRefunds) {
    if (seenRefundIds.has(refund.id)) {
      throw new RefundDomainRuleError(
        'DUPLICATE_TICKET_SELECTION',
        `Duplicate OrderRefund record id '${refund.id}' passed to reconciliation`
      );
    }
    seenRefundIds.add(refund.id);

    if (refund.orderId !== input.orderId) {
      throw new RefundDomainRuleError(
        'CROSS_ORDER_TICKET_SELECTION',
        `OrderRefund '${refund.id}' orderId (${refund.orderId}) does not match target order '${input.orderId}'`
      );
    }

    if (!Number.isInteger(refund.amountInCents) || refund.amountInCents <= 0) {
      throw new RefundDomainRuleError(
        'INVALID_REFUND_AMOUNT',
        `OrderRefund '${refund.id}' amountInCents (${refund.amountInCents}) must be a positive integer`
      );
    }

    const ticketItems = refund.tickets ?? [];
    const requiresTicketLineItems =
      refund.refundKind === OrderRefundKind.ORGANIZER_TICKET_REFUND ||
      refund.refundKind === OrderRefundKind.ADMIN_TICKET_REFUND;

    if (requiresTicketLineItems && ticketItems.length === 0) {
      throw new RefundDomainRuleError(
        'REFUND_AMOUNT_PARITY_MISMATCH',
        `Ticket-based OrderRefund '${refund.id}' (${refund.refundKind}) has 0 OrderRefundTicket line items`
      );
    }

    const expectedLockState = resolveLockStateForOrderRefundStatus(refund.status);
    let ticketSumInCents = 0;
    const seenRefundTickets = new Set<string>();

    for (const line of ticketItems) {
      if (seenRefundTickets.has(line.ticketId)) {
        throw new RefundDomainRuleError(
          'DUPLICATE_TICKET_SELECTION',
          `Duplicate ticketId '${line.ticketId}' within OrderRefund '${refund.id}'`
        );
      }
      seenRefundTickets.add(line.ticketId);

      if (line.orderId !== input.orderId) {
        throw new RefundDomainRuleError(
          'CROSS_ORDER_TICKET_SELECTION',
          `OrderRefundTicket '${line.ticketId}' belongs to order '${line.orderId}', expected '${input.orderId}'`
        );
      }

      if (
        !Number.isInteger(line.allocatedGrossInCents) ||
        !Number.isInteger(line.allocatedPlatformFeeInCents) ||
        !Number.isInteger(line.allocatedServiceFeeInCents) ||
        !Number.isInteger(line.allocatedProcessingFeeInCents) ||
        !Number.isInteger(line.allocatedBuyerTotalInCents) ||
        !Number.isInteger(line.refundedAmountInCents) ||
        line.allocatedGrossInCents < 0 ||
        line.allocatedPlatformFeeInCents < 0 ||
        line.allocatedServiceFeeInCents < 0 ||
        line.allocatedProcessingFeeInCents < 0 ||
        line.allocatedBuyerTotalInCents !==
          line.allocatedGrossInCents +
            line.allocatedPlatformFeeInCents +
            line.allocatedServiceFeeInCents +
            line.allocatedProcessingFeeInCents ||
        line.refundedAmountInCents <= 0 ||
        line.refundedAmountInCents > line.allocatedBuyerTotalInCents
      ) {
        throw new RefundDomainRuleError(
          'INVALID_PERSISTED_ALLOCATION',
          `OrderRefundTicket '${line.ticketId}' on OrderRefund '${refund.id}' has invalid integer amounts`
        );
      }

      // Note: MANUALLY_RESOLVED with NO_REFUND_NEEDED / FULFILLED_MANUALLY releases ticket lock
      const effectiveExpectedLock =
        refund.status === OrderRefundStatus.MANUALLY_RESOLVED &&
        (refund.resolutionAction === 'NO_REFUND_NEEDED' ||
          refund.resolutionAction === 'FULFILLED_MANUALLY')
          ? OrderRefundTicketLockState.RELEASED
          : expectedLockState;

      if (line.lockState !== effectiveExpectedLock) {
        throw new RefundDomainRuleError(
          'LOCK_STATE_MISMATCH',
          `OrderRefundTicket '${line.ticketId}' lockState '${line.lockState}' does not match OrderRefund '${refund.id}' status '${refund.status}' (expected '${effectiveExpectedLock}')`
        );
      }

      if (line.lockState === OrderRefundTicketLockState.ACTIVE_PENDING) {
        if (activeTicketIds.has(line.ticketId) || confirmedTicketIds.has(line.ticketId)) {
          throw new RefundDomainRuleError(
            'TICKET_ALREADY_LOCKED_FOR_REFUND',
            `Ticket '${line.ticketId}' has multiple active/confirmed refund locks`
          );
        }
        activeTicketIds.add(line.ticketId);
      } else if (line.lockState === OrderRefundTicketLockState.CONFIRMED) {
        if (activeTicketIds.has(line.ticketId) || confirmedTicketIds.has(line.ticketId)) {
          throw new RefundDomainRuleError(
            'TICKET_ALREADY_LOCKED_FOR_REFUND',
            `Ticket '${line.ticketId}' has multiple active/confirmed refund locks`
          );
        }
        confirmedTicketIds.add(line.ticketId);
      }

      ticketSumInCents += line.refundedAmountInCents;
    }

    if (ticketItems.length > 0 && ticketSumInCents !== refund.amountInCents) {
      throw new RefundDomainRuleError(
        'REFUND_AMOUNT_PARITY_MISMATCH',
        `OrderRefund '${refund.id}' amountInCents (${refund.amountInCents}) differs from sum of OrderRefundTicket line items (${ticketSumInCents})`
      );
    }

    const bucket = classifyOrderRefundCounterBucket({
      refundKind: refund.refundKind,
      status: refund.status,
      resolutionAction: refund.resolutionAction,
    });

    if (bucket === 'LATE_PAYMENT') {
      latePaymentRefundCount += 1;
      latePaymentRefundAmountInCents += refund.amountInCents;
    } else if (bucket === 'CONFIRMED') {
      refundedAmountInCents += refund.amountInCents;
    } else if (bucket === 'ACTIVE_PENDING') {
      pendingRefundAmountInCents += refund.amountInCents;
    }
  }

  if (refundedAmountInCents + pendingRefundAmountInCents > orderTotalInCents) {
    throw new RefundDomainRuleError(
      'CUMULATIVE_REFUND_CAP_EXCEEDED',
      `Reconciled refunded (${refundedAmountInCents}) + pending (${pendingRefundAmountInCents}) exceeds orderTotalInCents (${orderTotalInCents})`
    );
  }

  return {
    orderId: input.orderId,
    orderTotalInCents,
    refundedAmountInCents,
    pendingRefundAmountInCents,
    remainingRefundableInCents:
      orderTotalInCents - (refundedAmountInCents + pendingRefundAmountInCents),
    latePaymentRefundAmountInCents,
    latePaymentRefundCount,
    activeTicketIds: Array.from(activeTicketIds).sort(),
    confirmedTicketIds: Array.from(confirmedTicketIds).sort(),
  };
}
