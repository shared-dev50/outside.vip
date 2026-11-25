import crypto from 'crypto';
import {
  OrderRefundStatus,
  OrderRefundTicketLockState,
  OrderStatus,
  PaymentProvider,
  PaymentStatus,
  Prisma,
  RefundFeeBearer,
  RefundInitiatorRole,
  Role,
  TicketStatus,
} from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../../utils/errors.js';
import {
  computeLocalFreeTicketCancellationPlan,
  computeTicketRefundQuote,
  RefundDomainRuleError,
  RefundEligibleTicketSnapshot,
} from './refundAllocation.domain.js';
import {
  ensureOrderTicketAllocationsInTx,
  executeLocalFreeTicketCancellationInTx,
  initiateTicketRefundInTx,
  triggerPostCommitWaitlistAdvancement,
} from './refundAdmissionState.service.js';
import { triggerOrderRefundDispatch } from './orderRefundWorker.js';
import { InitiateOrderRefundBody, PreviewOrderRefundBody } from './refund.schema.js';

export interface RefundActorContext {
  userId: string;
  role: Role;
  email?: string;
}

export interface SerializedRefundTicket {
  id: string;
  ticketCode: string;
  ticketTierId: string;
  tierName: string;
  status: TicketStatus;
  attendeeName: string | null;
  attendeeEmail: string | null;
  checkedInAt: string | null;
  refundedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  allocatedGrossInCents: number;
  allocatedPlatformFeeInCents: number;
  allocatedServiceFeeInCents: number;
  allocatedProcessingFeeInCents: number;
  allocatedBuyerTotalInCents: number;
  activeRefundLock: boolean;
  refundEligibleForOrganizer: boolean;
  refundEligibleForAdmin: boolean;
}

export interface SerializedOrderRefundRecord {
  id: string;
  status: OrderRefundStatus;
  refundKind: string;
  initiatorRole: RefundInitiatorRole;
  feeBearer: RefundFeeBearer;
  refundStripeProcessingFee: boolean;
  amountInCents: number;
  ticketSubtotalInCents: number;
  platformFeeReversedInCents: number;
  serviceFeeReversedInCents: number;
  processingFeeInCents: number;
  organizerDebitInCents: number;
  platformExpenseInCents: number;
  restoreInventory: boolean;
  inventoryRestoredCount: number;
  currency: string;
  reason: string;
  stripeRefundId: string | null;
  requiresManualResolution: boolean;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  ticketIds: string[];
  createdAt: string;
  succeededAt: string | null;
  failedAt: string | null;
  cancelledAt: string | null;
}

export interface OrderRefundSummaryResponse {
  order: {
    id: string;
    orderNumber: string;
    status: OrderStatus;
    currency: string;
    totalInCents: number;
    refundedAmountInCents: number;
    pendingRefundAmountInCents: number;
    remainingRefundableInCents: number;
    platformFeeInCents: number;
    organizerNetInCents: number;
    paymentProvider: PaymentProvider;
    isFreeOrder: boolean;
    customerName: string;
    customerEmail: string;
    eventId: string;
    eventTitle: string;
  };
  capabilities: {
    initiatorRole: RefundInitiatorRole;
    canOverrideCheckedIn: boolean;
    canShiftFeeToPlatform: boolean;
  };
  tickets: SerializedRefundTicket[];
  refunds: SerializedOrderRefundRecord[];
}

export interface RefundQuotePreviewResponse {
  orderId: string;
  orderNumber: string;
  currency: string;
  isFreeCancellation: boolean;
  initiatorRole: RefundInitiatorRole;
  checkedInOverrideApplied: boolean;
  buyerRefundAmountInCents: number;
  ticketSubtotalInCents: number;
  platformFeeReversedInCents: number;
  serviceFeeReversedInCents: number;
  stripeProcessingFeeInCents: number;
  refundStripeProcessingFee: boolean;
  feeBearer: RefundFeeBearer;
  organizerDebitInCents: number;
  platformExpenseInCents: number;
  remainingOrderRefundableAfterInCents: number;
  restoreInventory: boolean;
  selectedTicketIds: string[];
  lineItems: Array<{
    ticketId: string;
    allocatedGrossInCents: number;
    allocatedPlatformFeeInCents: number;
    allocatedServiceFeeInCents: number;
    allocatedProcessingFeeInCents: number;
    allocatedBuyerTotalInCents: number;
    refundedAmountInCents: number;
  }>;
}

export interface InitiateOrderRefundResponse {
  mode: 'STRIPE_REFUND_QUEUED' | 'FREE_LOCAL_CANCELLED';
  replayed: boolean;
  orderRefundId: string | null;
  status: string;
  currency: string;
  refundAmountInCents: number;
  organizerDebitInCents: number;
  platformExpenseInCents: number;
  checkedInOverrideAudited: boolean;
  cancelledTicketIds?: string[];
  inventoryRestoredCount?: number;
}

export function resolveRefundInitiatorRoleForOrder(
  eventOrganizerId: string,
  user: RefundActorContext | undefined
): RefundInitiatorRole {
  if (!user) {
    throw new UnauthorizedError('Authentication required to manage order refunds.');
  }
  if (user.role === Role.ADMIN) {
    return RefundInitiatorRole.ADMIN;
  }
  if (user.role === Role.ORGANIZER && eventOrganizerId === user.userId) {
    return RefundInitiatorRole.ORGANIZER;
  }
  throw new ForbiddenError(
    'Only the event owner or platform administrators may view, preview, or initiate order refunds.'
  );
}

function mapRefundDomainErrorToHttpError(err: RefundDomainRuleError): Error {
  const code: string = err.code;
  switch (code) {
    case 'UNAUTHORIZED_REFUND_INITIATOR':
      return new ForbiddenError(err.message, code);
    case 'CHECKED_IN_TICKET_NOT_REFUNDABLE':
    case 'TICKET_NOT_ISSUED':
    case 'TICKET_ALREADY_LOCKED_FOR_REFUND':
    case 'CUMULATIVE_REFUND_CAP_EXCEEDED':
    case 'LOCK_STATE_MISMATCH':
      return new ConflictError(err.message, code);
    default:
      return new BadRequestError(err.message, code);
  }
}

function resolveFeePolicy(
  initiatorRole: RefundInitiatorRole,
  input: { refundStripeProcessingFee?: boolean; feeBearer?: RefundFeeBearer }
): { refundStripeProcessingFee: boolean; feeBearer: RefundFeeBearer } {
  const refundStripeProcessingFee = Boolean(input.refundStripeProcessingFee);
  const feeBearer = input.feeBearer ?? RefundFeeBearer.ORGANIZER;

  if (initiatorRole !== RefundInitiatorRole.ADMIN && feeBearer !== RefundFeeBearer.ORGANIZER) {
    throw new ForbiddenError(
      'Only platform administrators may allocate refund processing fees to the platform.',
      'PLATFORM_FEE_BEARER_ADMIN_ONLY'
    );
  }

  return { refundStripeProcessingFee, feeBearer };
}

function validateCheckedInPolicy(params: {
  initiatorRole: RefundInitiatorRole;
  tickets: Array<{ id: string; status: TicketStatus }>;
  allowCheckedInOverride?: boolean;
  overrideReason?: string;
}): boolean {
  const checkedInTickets = params.tickets.filter((t) => t.status === TicketStatus.CHECKED_IN);
  if (params.allowCheckedInOverride && params.initiatorRole !== RefundInitiatorRole.ADMIN) {
    throw new ForbiddenError(
      'Only platform administrators may override checked-in ticket refund restrictions.',
      'CHECKED_IN_OVERRIDE_ADMIN_ONLY'
    );
  }

  if (checkedInTickets.length === 0) {
    return false;
  }

  if (params.initiatorRole !== RefundInitiatorRole.ADMIN || !params.allowCheckedInOverride) {
    throw new ConflictError(
      `Ticket '${checkedInTickets[0].id}' has already checked in and cannot be refunded by organizers.`,
      'CHECKED_IN_TICKET_NOT_REFUNDABLE'
    );
  }

  const cleanReason = (params.overrideReason || '').trim();
  if (cleanReason.length < 5) {
    throw new BadRequestError(
      'Platform ADMIN override for checked-in tickets requires an explicit overrideReason (minimum 5 characters).',
      'ADMIN_OVERRIDE_REASON_REQUIRED'
    );
  }

  return true;
}

/**
 * Returns full refund summary, ticket allocations/locks, and historical refund records
 * for an authorized event owner or platform ADMIN.
 */
export async function getOrderRefundSummary(
  orderId: string,
  user: RefundActorContext
): Promise<OrderRefundSummaryResponse> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      event: {
        select: {
          id: true,
          title: true,
          organizerId: true,
        },
      },
      tickets: {
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: {
          ticketTier: {
            select: { id: true, name: true, priceInCents: true },
          },
          refundAllocations: {
            where: {
              lockState: {
                in: [OrderRefundTicketLockState.ACTIVE_PENDING, OrderRefundTicketLockState.CONFIRMED],
              },
            },
            select: { id: true, lockState: true },
          },
        },
      },
      refunds: {
        orderBy: { createdAt: 'desc' },
        include: {
          refundTickets: {
            orderBy: { ticketId: 'asc' },
            select: { ticketId: true },
          },
        },
      },
    },
  });

  if (!order) {
    throw new NotFoundError(`Order '${orderId}' not found.`);
  }

  const initiatorRole = resolveRefundInitiatorRoleForOrder(order.event.organizerId, user);

  // Backfill allocations deterministically if missing on a paid completed order so UI preview matches server math
  let allocationMap = new Map<
    string,
    {
      allocatedGrossInCents: number;
      allocatedPlatformFeeInCents: number;
      allocatedServiceFeeInCents: number;
      allocatedProcessingFeeInCents: number;
      allocatedBuyerTotalInCents: number;
    }
  >();

  if (order.totalInCents > 0 && order.tickets.length > 0) {
    const hasMissingAlloc = order.tickets.some(
      (t) =>
        t.allocatedGrossInCents === null ||
        t.allocatedBuyerTotalInCents === null
    );
    if (hasMissingAlloc) {
      allocationMap = await prisma.$transaction(async (tx) => {
        return ensureOrderTicketAllocationsInTx(tx, order.id);
      });
    }
  }

  const serializedTickets: SerializedRefundTicket[] = order.tickets.map((t) => {
    const alloc = allocationMap.get(t.id);
    const gross = alloc?.allocatedGrossInCents ?? t.allocatedGrossInCents ?? t.ticketTier.priceInCents;
    const platform = alloc?.allocatedPlatformFeeInCents ?? t.allocatedPlatformFeeInCents ?? 0;
    const service = alloc?.allocatedServiceFeeInCents ?? t.allocatedServiceFeeInCents ?? 0;
    const processing = alloc?.allocatedProcessingFeeInCents ?? t.allocatedProcessingFeeInCents ?? 0;
    const buyerTotal = alloc?.allocatedBuyerTotalInCents ?? t.allocatedBuyerTotalInCents ?? gross;
    const hasLock = t.refundAllocations.length > 0;

    return {
      id: t.id,
      ticketCode: t.id.slice(0, 8).toUpperCase(),
      ticketTierId: t.ticketTierId,
      tierName: t.ticketTier.name,
      status: t.status,
      attendeeName: t.attendeeName,
      attendeeEmail: t.attendeeEmail,
      checkedInAt: t.checkedInAt ? t.checkedInAt.toISOString() : null,
      refundedAt: t.refundedAt ? t.refundedAt.toISOString() : null,
      cancelledAt: t.cancelledAt ? t.cancelledAt.toISOString() : null,
      cancellationReason: t.cancellationReason,
      allocatedGrossInCents: gross,
      allocatedPlatformFeeInCents: platform,
      allocatedServiceFeeInCents: service,
      allocatedProcessingFeeInCents: processing,
      allocatedBuyerTotalInCents: buyerTotal,
      activeRefundLock: hasLock,
      refundEligibleForOrganizer:
        !hasLock &&
        order.status === OrderStatus.COMPLETED &&
        t.status === TicketStatus.ISSUED,
      refundEligibleForAdmin:
        !hasLock &&
        order.status === OrderStatus.COMPLETED &&
        (t.status === TicketStatus.ISSUED || t.status === TicketStatus.CHECKED_IN),
    };
  });

  const serializedRefunds: SerializedOrderRefundRecord[] = order.refunds.map((r) => ({
    id: r.id,
    status: r.status,
    refundKind: r.refundKind,
    initiatorRole: r.initiatorRole,
    feeBearer: r.feeBearer,
    refundStripeProcessingFee: r.refundStripeProcessingFee,
    amountInCents: r.amountInCents,
    ticketSubtotalInCents: r.ticketSubtotalInCents,
    platformFeeReversedInCents: r.platformFeeReversedInCents,
    serviceFeeReversedInCents: r.serviceFeeReversedInCents,
    processingFeeInCents: r.processingFeeInCents,
    organizerDebitInCents: r.organizerDebitInCents,
    platformExpenseInCents: r.platformExpenseInCents,
    restoreInventory: r.restoreInventory,
    inventoryRestoredCount: r.inventoryRestoredCount,
    currency: r.currency,
    reason: r.reason,
    stripeRefundId: r.stripeRefundId,
    requiresManualResolution: r.requiresManualResolution,
    lastErrorCode: r.lastErrorCode,
    lastErrorMessage: r.lastErrorMessage,
    ticketIds: r.refundTickets.map((rt) => rt.ticketId),
    createdAt: r.createdAt.toISOString(),
    succeededAt: r.succeededAt ? r.succeededAt.toISOString() : null,
    failedAt: r.failedAt ? r.failedAt.toISOString() : null,
    cancelledAt: r.cancelledAt ? r.cancelledAt.toISOString() : null,
  }));

  const remainingRefundableInCents = Math.max(
    0,
    order.totalInCents - order.refundedAmountInCents - order.pendingRefundAmountInCents
  );

  return {
    order: {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      currency: order.currency,
      totalInCents: order.totalInCents,
      refundedAmountInCents: order.refundedAmountInCents,
      pendingRefundAmountInCents: order.pendingRefundAmountInCents,
      remainingRefundableInCents,
      platformFeeInCents: order.platformFeeInCents,
      organizerNetInCents: order.organizerNetInCents,
      paymentProvider: order.paymentProvider,
      isFreeOrder: order.totalInCents === 0,
      customerName: order.customerName,
      customerEmail: order.customerEmail,
      eventId: order.event.id,
      eventTitle: order.event.title,
    },
    capabilities: {
      initiatorRole,
      canOverrideCheckedIn: initiatorRole === RefundInitiatorRole.ADMIN,
      canShiftFeeToPlatform: initiatorRole === RefundInitiatorRole.ADMIN,
    },
    tickets: serializedTickets,
    refunds: serializedRefunds,
  };
}

/**
 * Generates an authoritative server-computed refund quote preview (no state mutation except
 * optional idempotent legacy allocation backfill) separating buyer refund vs non-refundable Stripe fee.
 */
export async function previewOrderTicketRefund(
  orderId: string,
  user: RefundActorContext,
  input: PreviewOrderRefundBody
): Promise<RefundQuotePreviewResponse> {
  const uniqueTicketIds = Array.from(new Set(input.ticketIds)).sort();

  return await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: {
        event: { select: { id: true, organizerId: true } },
        tickets: {
          where: { id: { in: uniqueTicketIds } },
          include: {
            ticketTier: { select: { id: true, priceInCents: true } },
            refundAllocations: {
              where: {
                lockState: {
                  in: [OrderRefundTicketLockState.ACTIVE_PENDING, OrderRefundTicketLockState.CONFIRMED],
                },
              },
              select: { id: true },
            },
          },
        },
      },
    });

    if (!order) {
      throw new NotFoundError(`Order '${orderId}' not found.`);
    }

    const initiatorRole = resolveRefundInitiatorRoleForOrder(order.event.organizerId, user);
    const { refundStripeProcessingFee, feeBearer } = resolveFeePolicy(initiatorRole, input);

    if (order.status !== OrderStatus.COMPLETED) {
      throw new ConflictError(
        `Only COMPLETED orders can be refunded or cancelled (current status: ${order.status}).`
      );
    }

    if (order.tickets.length !== uniqueTicketIds.length) {
      throw new NotFoundError('One or more selected tickets do not belong to this order.');
    }

    const checkedInOverrideApplied = validateCheckedInPolicy({
      initiatorRole,
      tickets: order.tickets,
      allowCheckedInOverride: input.allowCheckedInOverride,
      overrideReason: input.overrideReason,
    });

    // Zero-dollar / free order local cancellation preview
    if (order.totalInCents === 0) {
      try {
        const plan = computeLocalFreeTicketCancellationPlan({
          orderId: order.id,
          orderTotalInCents: order.totalInCents,
          initiatorRole,
          initiatedByUserId: user.userId,
          reason: 'Refund preview check',
          restoreInventory: input.restoreInventory,
          tickets: order.tickets.map((t) => ({
            id: t.id,
            orderId: t.orderId,
            ticketTierId: t.ticketTierId,
            status:
              checkedInOverrideApplied && t.status === TicketStatus.CHECKED_IN
                ? TicketStatus.ISSUED
                : t.status,
            hasActiveOrConfirmedRefundLock: t.refundAllocations.length > 0,
            tierPriceInCents: t.ticketTier.priceInCents,
            allocatedGrossInCents: t.allocatedGrossInCents,
            allocatedPlatformFeeInCents: t.allocatedPlatformFeeInCents,
            allocatedServiceFeeInCents: t.allocatedServiceFeeInCents,
            allocatedProcessingFeeInCents: t.allocatedProcessingFeeInCents,
            allocatedBuyerTotalInCents: t.allocatedBuyerTotalInCents,
          })),
        });

        return {
          orderId: order.id,
          orderNumber: order.orderNumber,
          currency: order.currency,
          isFreeCancellation: true,
          initiatorRole,
          checkedInOverrideApplied,
          buyerRefundAmountInCents: 0,
          ticketSubtotalInCents: 0,
          platformFeeReversedInCents: 0,
          serviceFeeReversedInCents: 0,
          stripeProcessingFeeInCents: 0,
          refundStripeProcessingFee: false,
          feeBearer: RefundFeeBearer.NOT_APPLICABLE,
          organizerDebitInCents: 0,
          platformExpenseInCents: 0,
          remainingOrderRefundableAfterInCents: 0,
          restoreInventory: plan.restoreInventory,
          selectedTicketIds: plan.ticketIds,
          lineItems: plan.ticketIds.map((ticketId) => ({
            ticketId,
            allocatedGrossInCents: 0,
            allocatedPlatformFeeInCents: 0,
            allocatedServiceFeeInCents: 0,
            allocatedProcessingFeeInCents: 0,
            allocatedBuyerTotalInCents: 0,
            refundedAmountInCents: 0,
          })),
        };
      } catch (err) {
        if (err instanceof RefundDomainRuleError) {
          throw mapRefundDomainErrorToHttpError(err);
        }
        throw err;
      }
    }

    const allocMap = await ensureOrderTicketAllocationsInTx(tx, order.id);

    const domainSnapshots: RefundEligibleTicketSnapshot[] = order.tickets.map((t) => {
      const alloc = allocMap.get(t.id);
      return {
        id: t.id,
        orderId: t.orderId,
        status:
          checkedInOverrideApplied && t.status === TicketStatus.CHECKED_IN
            ? TicketStatus.ISSUED
            : t.status,
        allocatedGrossInCents: alloc?.allocatedGrossInCents ?? t.allocatedGrossInCents,
        allocatedPlatformFeeInCents:
          alloc?.allocatedPlatformFeeInCents ?? t.allocatedPlatformFeeInCents,
        allocatedServiceFeeInCents:
          alloc?.allocatedServiceFeeInCents ?? t.allocatedServiceFeeInCents,
        allocatedProcessingFeeInCents:
          alloc?.allocatedProcessingFeeInCents ?? t.allocatedProcessingFeeInCents,
        allocatedBuyerTotalInCents:
          alloc?.allocatedBuyerTotalInCents ?? t.allocatedBuyerTotalInCents,
        hasActiveOrConfirmedRefundLock: t.refundAllocations.length > 0,
      };
    });

    try {
      const quote = computeTicketRefundQuote({
        orderId: order.id,
        orderTotalInCents: order.totalInCents,
        orderRefundedAmountInCents: order.refundedAmountInCents,
        orderPendingRefundAmountInCents: order.pendingRefundAmountInCents,
        initiatorRole,
        tickets: domainSnapshots,
        refundStripeProcessingFee,
        feeBearer,
      });

      return {
        orderId: order.id,
        orderNumber: order.orderNumber,
        currency: order.currency,
        isFreeCancellation: false,
        initiatorRole,
        checkedInOverrideApplied,
        buyerRefundAmountInCents: quote.refundAmountInCents,
        ticketSubtotalInCents: quote.ticketSubtotalInCents,
        platformFeeReversedInCents: quote.platformFeeReversedInCents,
        serviceFeeReversedInCents: quote.serviceFeeReversedInCents,
        stripeProcessingFeeInCents: quote.processingFeeInCents,
        refundStripeProcessingFee: quote.refundStripeProcessingFee,
        feeBearer: quote.feeBearer,
        organizerDebitInCents: quote.organizerDebitInCents,
        platformExpenseInCents: quote.platformExpenseInCents,
        remainingOrderRefundableAfterInCents: quote.remainingOrderRefundableAfterInCents,
        restoreInventory: Boolean(input.restoreInventory),
        selectedTicketIds: uniqueTicketIds,
        lineItems: quote.lineItems,
      };
    } catch (err) {
      if (err instanceof RefundDomainRuleError) {
        throw mapRefundDomainErrorToHttpError(err);
      }
      throw err;
    }
  });
}

/**
 * Initiates a durable Stripe ticket refund (or immediate local cancellation for $0 free orders).
 * Strictly transactional before queueing post-commit P2-04 worker dispatch or waitlist advancement.
 */
export async function initiateOrderTicketRefund(
  orderId: string,
  user: RefundActorContext,
  input: InitiateOrderRefundBody,
  options?: {
    headerIdempotencyKey?: string;
    ipAddress?: string | null;
  }
): Promise<InitiateOrderRefundResponse> {
  const uniqueTicketIds = Array.from(new Set(input.ticketIds)).sort();
  const idempotencyKey = (
    options?.headerIdempotencyKey ||
    input.idempotencyKey ||
    `refund-init:${crypto.randomUUID()}`
  ).trim();

  if (idempotencyKey.length < 8) {
    throw new BadRequestError('Idempotency key must be at least 8 characters long.');
  }

  let wakeRefundWorker = false;
  let waitlistTierIdsToAdvance: string[] = [];

  const result = await prisma.$transaction(
    async (tx) => {
      const orderLookup = await tx.order.findUnique({
        where: { id: orderId },
        include: {
          event: { select: { id: true, organizerId: true } },
          transactions: {
            where: {
              provider: PaymentProvider.STRIPE,
              status: PaymentStatus.SUCCEEDED,
            },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { providerTransactionId: true },
          },
        },
      });

      if (!orderLookup) {
        throw new NotFoundError(`Order '${orderId}' not found.`);
      }

      const initiatorRole = resolveRefundInitiatorRoleForOrder(orderLookup.event.organizerId, user);
      const { refundStripeProcessingFee, feeBearer } = resolveFeePolicy(initiatorRole, input);

      // Zero-dollar / free order local cancellation branch (no Stripe call or ledger entry)
      if (orderLookup.totalInCents === 0) {
        const selectedTickets = await tx.ticket.findMany({
          where: { id: { in: uniqueTicketIds }, orderId: orderLookup.id },
          select: { id: true, status: true },
        });
        if (selectedTickets.length !== uniqueTicketIds.length) {
          throw new NotFoundError('One or more selected tickets do not belong to this order.');
        }

        const overrideApplied = validateCheckedInPolicy({
          initiatorRole,
          tickets: selectedTickets,
          allowCheckedInOverride: input.allowCheckedInOverride,
          overrideReason: input.overrideReason,
        });

        try {
          if (overrideApplied) {
            await tx.ticket.updateMany({
              where: {
                id: { in: selectedTickets.filter((t) => t.status === TicketStatus.CHECKED_IN).map((t) => t.id) },
                orderId: orderLookup.id,
              },
              data: { status: TicketStatus.ISSUED },
            });
          }

          const freeRes = await executeLocalFreeTicketCancellationInTx(tx, {
            orderId: orderLookup.id,
            ticketIds: uniqueTicketIds,
            initiatorRole,
            initiatedByUserId: user.userId,
            reason: input.reason,
            restoreInventory: input.restoreInventory,
          });

          if (overrideApplied) {
            await tx.adminAuditLog.create({
              data: {
                actorUserId: user.userId,
                actorEmail: user.email || 'admin@outside.vip',
                action: 'ADMIN_FREE_TICKET_CHECKED_IN_CANCEL_OVERRIDE',
                targetType: 'Order',
                targetId: orderLookup.id,
                metadata: {
                  orderId: orderLookup.id,
                  orderNumber: orderLookup.orderNumber,
                  ticketIds: freeRes.plan.ticketIds,
                  overrideReason: input.overrideReason?.trim() || '',
                  cancellationReason: input.reason.trim(),
                },
                ipAddress: options?.ipAddress ?? null,
              },
            });
          }

          waitlistTierIdsToAdvance = freeRes.tiersToAdvanceWaitlist;

          return {
            mode: 'FREE_LOCAL_CANCELLED' as const,
            replayed: false,
            orderRefundId: null,
            status: 'CANCELLED',
            currency: orderLookup.currency,
            refundAmountInCents: 0,
            organizerDebitInCents: 0,
            platformExpenseInCents: 0,
            checkedInOverrideAudited: overrideApplied,
            cancelledTicketIds: freeRes.plan.ticketIds,
            inventoryRestoredCount: freeRes.inventoryRestoredCount,
          };
        } catch (err) {
          if (err instanceof RefundDomainRuleError) {
            throw mapRefundDomainErrorToHttpError(err);
          }
          throw err;
        }
      }

      if (input.allowCheckedInOverride && initiatorRole !== RefundInitiatorRole.ADMIN) {
        throw new ForbiddenError(
          'Only platform administrators may override checked-in ticket refund restrictions.',
          'CHECKED_IN_OVERRIDE_ADMIN_ONLY'
        );
      }

      const stripePaymentIntentId =
        (orderLookup.paymentReference && orderLookup.paymentReference.startsWith('pi_')
          ? orderLookup.paymentReference
          : null) ||
        orderLookup.transactions[0]?.providerTransactionId ||
        null;

      if (!stripePaymentIntentId) {
        throw new ConflictError(
          'Order does not have a valid Stripe PaymentIntent reference for refund execution.'
        );
      }

      let initRes;
      try {
        initRes = await initiateTicketRefundInTx(tx, {
          orderId: orderLookup.id,
          ticketIds: uniqueTicketIds,
          idempotencyKey,
          stripePaymentIntentId,
          stripeChargeId: orderLookup.stripeSettledChargeId ?? null,
          initiatorRole,
          initiatedByUserId: user.userId,
          initiatedByEmail: user.email,
          reason: input.reason,
          feeBearer,
          refundStripeProcessingFee,
          restoreInventory: input.restoreInventory,
          allowCheckedInOverride: input.allowCheckedInOverride,
          overrideReason: input.overrideReason,
          ipAddress: options?.ipAddress ?? null,
        });
      } catch (err) {
        if (err instanceof RefundDomainRuleError) {
          throw mapRefundDomainErrorToHttpError(err);
        }
        throw err;
      }

      if (!initRes.created) {
        // Validate replay payload consistency to block accidental or malicious key reuse across tickets/orders
        if (initRes.orderRefund.orderId !== orderLookup.id) {
          throw new ConflictError(
            'Idempotency-Key was already used for a different order refund.'
          );
        }

        const existingLines = await tx.orderRefundTicket.findMany({
          where: { orderRefundId: initRes.orderRefund.id },
          orderBy: { ticketId: 'asc' },
          select: { ticketId: true },
        });
        const existingTicketIds = existingLines.map((l) => l.ticketId).sort();
        const sameTickets =
          existingTicketIds.length === uniqueTicketIds.length &&
          existingTicketIds.every((id, idx) => id === uniqueTicketIds[idx]);

        if (
          !sameTickets ||
          initRes.orderRefund.refundStripeProcessingFee !== refundStripeProcessingFee ||
          initRes.orderRefund.feeBearer !== feeBearer ||
          initRes.orderRefund.restoreInventory !== Boolean(input.restoreInventory)
        ) {
          throw new ConflictError(
            'Idempotency-Key was already used with different ticket selection or refund options.'
          );
        }
      }

      if (initRes.orderRefund.status === OrderRefundStatus.PENDING) {
        wakeRefundWorker = true;
      }

      return {
        mode: 'STRIPE_REFUND_QUEUED' as const,
        replayed: !initRes.created,
        orderRefundId: initRes.orderRefund.id,
        status: initRes.orderRefund.status,
        currency: initRes.orderRefund.currency,
        refundAmountInCents: initRes.orderRefund.amountInCents,
        organizerDebitInCents: initRes.orderRefund.organizerDebitInCents,
        platformExpenseInCents: initRes.orderRefund.platformExpenseInCents,
        checkedInOverrideAudited: initRes.checkedInOverrideAudited,
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      timeout: 15000,
    }
  );

  // Strictly post-commit non-blocking wake-ups
  if (wakeRefundWorker) {
    triggerOrderRefundDispatch();
  }
  if (waitlistTierIdsToAdvance.length > 0) {
    await triggerPostCommitWaitlistAdvancement(waitlistTierIdsToAdvance);
  }

  return result;
}
