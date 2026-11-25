import {
  EventStatus,
  LedgerBalanceType,
  LedgerEntryType,
  OrderStatus,
  Prisma,
  ReservationStatus,
  Role,
  TicketStatus,
} from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { NotFoundError, ForbiddenError } from '../../utils/errors.js';
import {
  enqueueEventCancelledBuyerEmail,
  enqueueEventCancelledOrganizerEmail,
} from '../notifications/emailOutbox.service.js';
import { triggerEmailOutboxDispatch } from '../notifications/emailOutboxWorker.js';
import { cancelWaitlistForEventIds } from '../waitlist/waitlist.service.js';

export interface CancelEventsInput {
  eventIds: string[];
  actorUserId: string;
  actorEmail: string;
  actorRole: Role | string;
  reason?: string | null;
  isAdminOverride?: boolean;
  isSeriesCancellation?: boolean;
  seriesId?: string | null;
  ipAddress?: string | null;
}

export interface CancelEventsResult {
  cancelledEventIds: string[];
  alreadyCancelledEventIds: string[];
  cancelledPendingOrdersCount: number;
  releasedReservationCount: number;
  affectedCompletedOrdersCount: number;
  enqueuedEmailCount: number;
  cancelledAt: Date;
}

const DEFAULT_CANCELLATION_REASON = 'Event cancelled by organizer';

/**
 * Executes atomic, idempotent event cancellation inside an active Prisma transaction:
 * 1. Locks Event rows in ascending ID order.
 * 2. Skips already-CANCELLED events safely without re-emitting emails or audit duplicates.
 * 3. Sets cancelledAt, cancelledByUserId, and cancellationReason on newly cancelled events.
 * 4. Cancels PENDING orders & releases ACTIVE TicketReservations for cancelled events while
 *    preserving all COMPLETED/REFUNDED orders, issued tickets (for P0-03 refund selection
 *    & audit history), and in-flight P0-03 / P2-04 OrderRefund records.
 * 5. Invalidates all pending waitlist offers & entries cleanly without accidental fulfillment.
 * 6. Captures financial balance snapshot in AdminAuditLog WITHOUT auto-refunding buyers,
 *    reversing Connect transfers, or manufacturing RECOVERABLE debt.
 * 7. Enqueues manual-refund-policy notifications for organizer and active buyers via EmailOutbox.
 */
export async function executeEventCancellationInTx(
  tx: Prisma.TransactionClient,
  input: CancelEventsInput
): Promise<CancelEventsResult> {
  const uniqueEventIds = Array.from(new Set(input.eventIds.filter(Boolean))).sort();
  let now = new Date();

  if (uniqueEventIds.length === 0) {
    return {
      cancelledEventIds: [],
      alreadyCancelledEventIds: [],
      cancelledPendingOrdersCount: 0,
      releasedReservationCount: 0,
      affectedCompletedOrdersCount: 0,
      enqueuedEmailCount: 0,
      cancelledAt: now,
    };
  }

  // Canonical Lock Step 1: Event rows sorted by id ASC FOR UPDATE.
  // Serializes cleanly against executeWithdrawal (which acquires Event FOR SHARE before OrganizerBalance FOR UPDATE).
  const lockedEvents = await tx.$queryRaw<
    Array<{
      id: string;
      status: EventStatus;
      organizerId: string;
      title: string;
      startAt: Date;
    }>
  >`
    SELECT id, status, "organizerId", title, "startAt"
    FROM "Event"
    WHERE id = ANY(${uniqueEventIds})
    ORDER BY id ASC
    FOR UPDATE
  `;

  const toCancel = lockedEvents.filter((e) => e.status !== EventStatus.CANCELLED);
  const alreadyCancelled = lockedEvents.filter((e) => e.status === EventStatus.CANCELLED);

  if (toCancel.length === 0) {
    return {
      cancelledEventIds: [],
      alreadyCancelledEventIds: alreadyCancelled.map((e) => e.id),
      cancelledPendingOrdersCount: 0,
      releasedReservationCount: 0,
      affectedCompletedOrdersCount: 0,
      enqueuedEmailCount: 0,
      cancelledAt: now,
    };
  }

  const toCancelIds = toCancel.map((e) => e.id);
  const organizerIds = Array.from(new Set(toCancel.map((e) => e.organizerId))).sort();

  // Ensure cancelledAt is strictly greater than any pre-cancellation TRANSFER_INITIATED timestamp
  // that may have committed earlier within the same millisecond before Event FOR UPDATE blocked withdrawals.
  if (typeof (tx as any)?.financialLedgerEntry?.findFirst === 'function' && organizerIds.length > 0) {
    const latestTransferEntry = await tx.financialLedgerEntry.findFirst({
      where: {
        organizerId: { in: organizerIds },
        type: LedgerEntryType.TRANSFER_INITIATED,
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (latestTransferEntry?.createdAt) {
      const latestMs = new Date(latestTransferEntry.createdAt).getTime();
      if (latestMs >= now.getTime()) {
        now = new Date(latestMs + 1);
      }
    }
  }

  const cleanReason =
    (input.reason || '').trim().slice(0, 500) || DEFAULT_CANCELLATION_REASON;

  await tx.event.updateMany({
    where: {
      id: { in: toCancelIds },
      status: { not: EventStatus.CANCELLED },
    },
    data: {
      status: EventStatus.CANCELLED,
      cancelledAt: now,
      cancelledByUserId: input.actorUserId,
      cancellationReason: cleanReason,
    },
  });

  // Canonical Lock Step 2: Pending unpaid orders for these events (id ASC FOR UPDATE)
  const pendingOrders = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id
    FROM "Order"
    WHERE "eventId" = ANY(${toCancelIds})
      AND status = 'PENDING'::"OrderStatus"
    ORDER BY id ASC
    FOR UPDATE
  `;
  const pendingOrderIds = pendingOrders.map((o) => o.id);

  let cancelledPendingOrdersCount = 0;
  let releasedReservationCount = 0;

  if (pendingOrderIds.length > 0) {
    const resRelease = await tx.ticketReservation.updateMany({
      where: {
        orderId: { in: pendingOrderIds },
        status: ReservationStatus.ACTIVE,
      },
      data: { status: ReservationStatus.RELEASED },
    });
    releasedReservationCount = resRelease.count;

    const orderCancelRes = await tx.order.updateMany({
      where: {
        id: { in: pendingOrderIds },
        status: OrderStatus.PENDING,
      },
      data: { status: OrderStatus.CANCELLED },
    });
    cancelledPendingOrdersCount = orderCancelRes.count;
  }

  // Release any orphaned ACTIVE reservations on non-completed orders of cancelled events
  const orphanResRelease = await tx.ticketReservation.updateMany({
    where: {
      status: ReservationStatus.ACTIVE,
      order: {
        eventId: { in: toCancelIds },
        status: { not: OrderStatus.COMPLETED },
      },
    },
    data: { status: ReservationStatus.RELEASED },
  });
  releasedReservationCount += orphanResRelease.count;

  // Canonical Lock Step 3: Cancel pending waitlist offers & waiting entries, reconciling reservedQuantity
  await cancelWaitlistForEventIds(toCancelIds, tx);

  // Canonical Lock Step 4: Lock existing OrganizerBalance rows deterministically (userId ASC FOR UPDATE)
  // AFTER Event -> Order -> TicketWaitlistOffer -> TicketTier locks so cancellation and withdrawal
  // maintain strict deadlock-free lock ordering with Stage 2 settlement and P0-03 refund paths.
  let balances: Array<{
    userId: string;
    currency: string;
    pendingBalanceInCents: number;
    availableBalanceInCents: number;
    transferredBalanceInCents: number;
  }> = [];

  if (organizerIds.length > 0 && typeof tx.$queryRaw === 'function') {
    const lockedBalanceRows = await tx.$queryRaw<
      Array<{
        userId: string;
        currency: string;
        pendingBalanceInCents: number;
        availableBalanceInCents: number;
        transferredBalanceInCents: number;
      }>
    >`
      SELECT
        "userId",
        currency,
        "pendingBalanceInCents",
        "availableBalanceInCents",
        "transferredBalanceInCents"
      FROM "OrganizerBalance"
      WHERE "userId" = ANY(${organizerIds})
      ORDER BY "userId" ASC
      FOR UPDATE
    `;
    if (Array.isArray(lockedBalanceRows)) {
      balances = lockedBalanceRows;
    }
  }

  if (balances.length === 0 && typeof (tx as any)?.organizerBalance?.findMany === 'function') {
    const queriedBalances = await tx.organizerBalance.findMany({
      where: { userId: { in: organizerIds } },
      select: {
        userId: true,
        currency: true,
        pendingBalanceInCents: true,
        availableBalanceInCents: true,
        transferredBalanceInCents: true,
      },
    });
    if (Array.isArray(queriedBalances)) {
      balances = queriedBalances;
    }
  }

  // Snapshot organizer metadata & ledger totals for audit metadata (never mutate or auto-refund)
  const [organizers, pendingOrderCountsByEvent, clearedByEvent] = await Promise.all([
    tx.user.findMany({
      where: { id: { in: organizerIds } },
      select: { id: true, email: true, name: true },
    }),
    tx.order.groupBy({
      by: ['eventId'],
      where: { id: { in: pendingOrderIds } },
      _count: { _all: true },
    }),
    tx.financialLedgerEntry.findMany({
      where: {
        eventId: { in: toCancelIds },
        type: { in: [LedgerEntryType.TICKET_SALE_CLEARED, LedgerEntryType.REFUND_CLEARED] },
        balanceType: LedgerBalanceType.AVAILABLE,
      },
      select: { eventId: true, amountInCents: true },
    }),
  ]);

  const organizerMap = new Map(organizers.map((u) => [u.id, u]));
  const balanceMap = new Map(balances.map((b) => [b.userId, b]));
  const pendingCountMap = new Map(
    pendingOrderCountsByEvent.map((g) => [g.eventId, g._count._all])
  );
  const netClearedByEvent = new Map<string, number>();
  for (const entry of clearedByEvent) {
    if (!entry.eventId) continue;
    netClearedByEvent.set(
      entry.eventId,
      (netClearedByEvent.get(entry.eventId) ?? 0) + entry.amountInCents
    );
  }

  // Enqueue buyer & organizer cancellation notices inside tx via EmailOutbox
  const completedOrders = await tx.order.findMany({
    where: {
      eventId: { in: toCancelIds },
      status: OrderStatus.COMPLETED,
    },
    select: {
      id: true,
      eventId: true,
      orderNumber: true,
      customerEmail: true,
      customerName: true,
      totalInCents: true,
      currency: true,
      tickets: {
        select: { id: true, status: true },
      },
    },
  });

  const completedByEvent = new Map<string, typeof completedOrders>();
  for (const ord of completedOrders) {
    const activeOrPendingTickets = ord.tickets.filter(
      (t) => t.status !== TicketStatus.REFUNDED && t.status !== TicketStatus.CANCELLED
    );
    if (activeOrPendingTickets.length === 0 && ord.tickets.length > 0) {
      continue;
    }
    const list = completedByEvent.get(ord.eventId) || [];
    list.push(ord);
    completedByEvent.set(ord.eventId, list);
  }

  let enqueuedEmailCount = 0;
  let affectedCompletedOrdersCount = 0;

  for (const evt of toCancel) {
    const evtAffectedOrders = completedByEvent.get(evt.id) || [];
    affectedCompletedOrdersCount += evtAffectedOrders.length;

    for (const ord of evtAffectedOrders) {
      if (!ord.customerEmail) continue;
      const activeTicketCount = ord.tickets.filter(
        (t) => t.status !== TicketStatus.REFUNDED && t.status !== TicketStatus.CANCELLED
      ).length;
      const emailRes = await enqueueEventCancelledBuyerEmail(tx, {
        eventId: evt.id,
        orderId: ord.id,
        recipientEmail: ord.customerEmail,
        snapshot: {
          orderNumber: ord.orderNumber,
          buyerName: ord.customerName,
          eventTitle: evt.title,
          eventStartAtIso: evt.startAt ? evt.startAt.toISOString() : null,
          cancelledAtIso: now.toISOString(),
          cancellationReason: cleanReason,
          ticketCount: Math.max(1, activeTicketCount || ord.tickets.length),
          orderTotalInCents: ord.totalInCents,
          currency: ord.currency,
        },
      });
      if (emailRes.enqueued) {
        enqueuedEmailCount += 1;
      }
    }

    const organizerUser = organizerMap.get(evt.organizerId);
    if (organizerUser?.email) {
      const orgEmailRes = await enqueueEventCancelledOrganizerEmail(tx, {
        eventId: evt.id,
        recipientEmail: organizerUser.email,
        snapshot: {
          organizerName: organizerUser.name || 'Organizer',
          eventTitle: evt.title,
          eventStartAtIso: evt.startAt ? evt.startAt.toISOString() : null,
          cancelledAtIso: now.toISOString(),
          actorEmail: input.actorEmail,
          cancellationReason: cleanReason,
          affectedOrdersCount: evtAffectedOrders.length,
          cancelledPendingOrdersCount: pendingCountMap.get(evt.id) ?? 0,
        },
      });
      if (orgEmailRes.enqueued) {
        enqueuedEmailCount += 1;
      }
    }
  }

  const auditAction = input.isSeriesCancellation
    ? 'EVENT_SERIES_CANCELLED'
    : input.isAdminOverride
    ? 'ADMIN_EVENT_CANCEL_OVERRIDE'
    : 'EVENT_CANCELLED';

  await tx.adminAuditLog.create({
    data: {
      actorUserId: input.actorUserId,
      actorEmail: input.actorEmail,
      action: auditAction,
      targetType: input.isSeriesCancellation ? 'EventSeries' : 'Event',
      targetId: input.isSeriesCancellation && input.seriesId ? input.seriesId : toCancelIds[0],
      metadata: {
        actorRole: String(input.actorRole),
        cancelledAt: now.toISOString(),
        reason: cleanReason,
        cancelledEventIds: toCancelIds,
        alreadyCancelledEventIds: alreadyCancelled.map((e) => e.id),
        cancelledPendingOrdersCount,
        releasedReservationCount,
        affectedCompletedOrdersCount,
        automaticRefundsIssued: false,
        heldClearedEarningsByEvent: Object.fromEntries(
          toCancelIds.map((eid) => [eid, Math.max(0, netClearedByEvent.get(eid) ?? 0)])
        ),
        organizerBalanceSnapshots: organizerIds.map((oid) => ({
          organizerId: oid,
          balance: balanceMap.get(oid) ?? null,
        })),
      },
      ipAddress: input.ipAddress ?? null,
    },
  });

  return {
    cancelledEventIds: toCancelIds,
    alreadyCancelledEventIds: alreadyCancelled.map((e) => e.id),
    cancelledPendingOrdersCount,
    releasedReservationCount,
    affectedCompletedOrdersCount,
    enqueuedEmailCount,
    cancelledAt: now,
  };
}

/**
 * Transactional entry point for single-event or series cancellation with strict post-commit
 * email outbox dispatch.
 */
export async function cancelEventsTransactionally(
  input: CancelEventsInput
): Promise<CancelEventsResult> {
  const result = await prisma.$transaction(
    async (tx) => executeEventCancellationInTx(tx, input),
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      timeout: 15000,
    }
  );

  if (result.enqueuedEmailCount > 0) {
    triggerEmailOutboxDispatch();
  }

  return result;
}

/**
 * Resolves and cancels all upcoming non-cancelled occurrences of an EventSeries inside
 * a single atomic transaction:
 * 1. Locks EventSeries row FOR UPDATE (canonical parent lock before child Event rows).
 * 2. Enforces strict owner/platform ADMIN authorization on the locked series.
 * 3. Resolves and locks upcoming non-cancelled occurrences (ORDER BY id ASC FOR UPDATE).
 * 4. Delegates to executeEventCancellationInTx and dispatches emails post-commit.
 */
export async function cancelSeriesEventsTransactionally(input: {
  seriesId: string;
  actorUserId: string;
  actorEmail: string;
  actorRole: Role | string;
  reason?: string | null;
  ipAddress?: string | null;
}): Promise<CancelEventsResult> {
  const result = await prisma.$transaction(
    async (tx) => {
      const seriesRows = await tx.$queryRaw<
        Array<{ id: string; organizerId: string }>
      >`
        SELECT id, "organizerId"
        FROM "EventSeries"
        WHERE id = ${input.seriesId}
        FOR UPDATE
      `;
      const series = seriesRows[0];
      if (!series) {
        throw new NotFoundError('Event series not found');
      }

      const isAdmin = input.actorRole === Role.ADMIN;
      if (series.organizerId !== input.actorUserId && !isAdmin) {
        throw new ForbiddenError('You do not have permission to cancel this series');
      }

      const cutoffNow = new Date();
      const upcomingRows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id
        FROM "Event"
        WHERE "seriesId" = ${input.seriesId}
          AND "startAt" >= ${cutoffNow}
          AND status <> 'CANCELLED'::"EventStatus"
        ORDER BY id ASC
        FOR UPDATE
      `;
      const upcomingEventIds = upcomingRows.map((r) => r.id);

      return executeEventCancellationInTx(tx, {
        eventIds: upcomingEventIds,
        actorUserId: input.actorUserId,
        actorEmail: input.actorEmail,
        actorRole: input.actorRole,
        reason: input.reason ?? null,
        isAdminOverride: series.organizerId !== input.actorUserId && isAdmin,
        isSeriesCancellation: true,
        seriesId: input.seriesId,
        ipAddress: input.ipAddress ?? null,
      });
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      timeout: 15000,
    }
  );

  if (result.enqueuedEmailCount > 0) {
    triggerEmailOutboxDispatch();
  }

  return result;
}
