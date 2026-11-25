import crypto from 'crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { nanoid } from 'nanoid';
import {
  EventCategory,
  EventStatus,
  LedgerBalanceType,
  LedgerEntryType,
  OrderRefundKind,
  OrderRefundStatus,
  OrderRefundTicketLockState,
  OrderStatus,
  PaymentProvider,
  Prisma,
  RefundFeeBearer,
  RefundInitiatorRole,
  Role,
  TicketStatus,
} from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { calculateCheckoutFeeBreakdown } from '../modules/checkout/checkout.financials.js';
import {
  cancelTicketRefundInTx,
  confirmTicketRefundSucceededInTx,
  ensureOrderTicketAllocationsInTx,
  initiateTicketRefundInTx,
} from '../modules/refunds/refundAdmissionState.service.js';
import { RefundDomainRuleError } from '../modules/refunds/refundAllocation.domain.js';

describe('Stage 4 P0-03 — Real PostgreSQL Refund Initiation Regression Suite', () => {
  const createdUserIds: string[] = [];
  const createdEventIds: string[] = [];
  const createdOrderIds: string[] = [];
  const createdRefundIds: string[] = [];

  let resolvedDatabaseName = '';

  beforeAll(async () => {
    const [{ current_database }] = await prisma.$queryRaw<Array<{ current_database: string }>>`
      SELECT current_database()::text AS current_database
    `;
    resolvedDatabaseName = current_database;
    expect(resolvedDatabaseName).toBe('outside_vip_stage4_verify');
  });

  afterAll(async () => {
    if (resolvedDatabaseName !== 'outside_vip_stage4_verify') {
      return;
    }

    // Delete in strict RESTRICT-safe FK dependency order
    if (createdRefundIds.length > 0 || createdOrderIds.length > 0) {
      await prisma.orderRefundTicket.deleteMany({
        where: {
          OR: [
            ...(createdRefundIds.length > 0 ? [{ orderRefundId: { in: createdRefundIds } }] : []),
            ...(createdOrderIds.length > 0 ? [{ orderId: { in: createdOrderIds } }] : []),
          ],
        },
      });
    }
    if (createdRefundIds.length > 0 || createdOrderIds.length > 0) {
      await prisma.adminAuditLog.deleteMany({
        where: {
          OR: [
            ...(createdRefundIds.length > 0 ? [{ targetId: { in: createdRefundIds } }] : []),
            ...(createdOrderIds.length > 0 ? [{ targetId: { in: createdOrderIds } }] : []),
          ],
        },
      });
      await prisma.orderRefund.deleteMany({
        where: {
          OR: [
            ...(createdRefundIds.length > 0 ? [{ id: { in: createdRefundIds } }] : []),
            ...(createdOrderIds.length > 0 ? [{ orderId: { in: createdOrderIds } }] : []),
          ],
        },
      });
    }
    if (createdOrderIds.length > 0) {
      await prisma.financialLedgerEntry.deleteMany({
        where: { orderId: { in: createdOrderIds } },
      });
      await prisma.checkInLog.deleteMany({
        where: { ticket: { orderId: { in: createdOrderIds } } },
      });
      await prisma.ticket.deleteMany({
        where: { orderId: { in: createdOrderIds } },
      });
      await prisma.orderItem.deleteMany({
        where: { orderId: { in: createdOrderIds } },
      });
      await prisma.order.deleteMany({
        where: { id: { in: createdOrderIds } },
      });
    }
    if (createdEventIds.length > 0) {
      await prisma.financialLedgerEntry.deleteMany({
        where: { eventId: { in: createdEventIds } },
      });
      await prisma.ticketTier.deleteMany({
        where: { eventId: { in: createdEventIds } },
      });
      await prisma.event.deleteMany({
        where: { id: { in: createdEventIds } },
      });
    }
    if (createdUserIds.length > 0) {
      await prisma.organizerBalance.deleteMany({
        where: { userId: { in: createdUserIds } },
      });
      await prisma.organizerProfile.deleteMany({
        where: { userId: { in: createdUserIds } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: createdUserIds } },
      });
    }
  });

  async function createPaidOrderFixture(ticketCount: number) {
    const suffix = nanoid(8);
    const organizer = await prisma.user.create({
      data: {
        email: `p003_pg_org_${suffix}@outside.vip`,
        name: `P003 Org ${suffix}`,
        role: Role.ORGANIZER,
        emailVerified: true,
        organizer: {
          create: {
            displayName: `P003 Collective ${suffix}`,
            slug: `p003-pg-${suffix}`.toLowerCase(),
          },
        },
      },
    });
    createdUserIds.push(organizer.id);

    const event = await prisma.event.create({
      data: {
        slug: `p003-pg-evt-${suffix}`.toLowerCase(),
        organizerId: organizer.id,
        title: `P003 PG Event ${suffix}`,
        description: 'Real PostgreSQL P0-03 verification event',
        category: EventCategory.MUSIC,
        status: EventStatus.PUBLISHED,
        coverImageUrl: 'https://example.com/p003-cover.jpg',
        venueName: 'Verify Hall',
        venueAddress: '1 Verify Way',
        city: 'Nairobi',
        country: 'US',
        startAt: new Date(Date.now() + 3_600_000),
        endAt: new Date(Date.now() + 7_200_000),
        timezone: 'UTC',
      },
    });
    createdEventIds.push(event.id);

    const tier = await prisma.ticketTier.create({
      data: {
        eventId: event.id,
        name: 'GA Paid',
        priceInCents: 2000,
        currency: 'USD',
        totalCapacity: 50,
        soldQuantity: ticketCount,
        reservedQuantity: 0,
      },
    });

    const breakdown = calculateCheckoutFeeBreakdown([{ priceInCents: 2000, quantity: ticketCount }]);
    const piId = `pi_p003_pg_${suffix}`;
    const order = await prisma.order.create({
      data: {
        orderNumber: `OUT-P003-${suffix}`,
        eventId: event.id,
        status: OrderStatus.COMPLETED,
        customerEmail: `buyer_${suffix}@example.com`,
        customerName: 'P003 Buyer',
        totalInCents: breakdown.buyerTotalInCents,
        currency: 'USD',
        platformFeeInCents: breakdown.platformRevenueInCents,
        organizerNetInCents: breakdown.organizerEarningsInCents,
        idempotencyKey: `idem_ord_p003_${suffix}`,
        paymentProvider: PaymentProvider.STRIPE,
        paymentReference: piId,
        expiresAt: new Date(Date.now() + 3_600_000),
        items: {
          create: {
            ticketTierId: tier.id,
            quantity: ticketCount,
            unitPriceInCents: 2000,
            subtotalInCents: 2000 * ticketCount,
          },
        },
      },
    });
    createdOrderIds.push(order.id);

    await prisma.organizerBalance.create({
      data: {
        userId: organizer.id,
        currency: 'USD',
        availableBalanceInCents: breakdown.organizerEarningsInCents,
      },
    });
    await prisma.financialLedgerEntry.create({
      data: {
        type: LedgerEntryType.TICKET_SALE_CLEARED,
        balanceType: LedgerBalanceType.AVAILABLE,
        amountInCents: breakdown.organizerEarningsInCents,
        currency: 'USD',
        organizerId: organizer.id,
        eventId: event.id,
        orderId: order.id,
        description: 'Cleared paid tickets for P0-03 PG test',
      },
    });

    const tickets = [];
    for (let i = 0; i < ticketCount; i++) {
      const ticket = await prisma.ticket.create({
        data: {
          ticketToken: `tkt_sec_p003_${suffix}_${i}`,
          orderId: order.id,
          eventId: event.id,
          ticketTierId: tier.id,
          attendeeName: `Attendee ${i + 1}`,
          attendeeEmail: `att_${i}_${suffix}@example.com`,
          status: TicketStatus.ISSUED,
        },
      });
      tickets.push(ticket);
    }

    await prisma.$transaction((tx) => ensureOrderTicketAllocationsInTx(tx, order.id));

    return { organizer, event, tier, order, tickets, piId, breakdown };
  }

  it('persists OrderRefund and OrderRefundTicket via nested create with composite relations, updates Ticket and Order counters, and supports multiple partial refunds on one PaymentIntent', async () => {
    const { organizer, order, tickets, piId } = await createPaidOrderFixture(2);
    const [t1, t2] = tickets;

    const init1 = await prisma.$transaction((tx) =>
      initiateTicketRefundInTx(tx, {
        orderId: order.id,
        ticketIds: [t1.id],
        idempotencyKey: `idem_p003_ref1_${nanoid(6)}`,
        stripePaymentIntentId: piId,
        initiatorRole: RefundInitiatorRole.ORGANIZER,
        initiatedByUserId: organizer.id,
        reason: 'Partial refund ticket 1 in PG',
        feeBearer: RefundFeeBearer.ORGANIZER,
        refundStripeProcessingFee: false,
        restoreInventory: true,
      })
    );
    createdRefundIds.push(init1.orderRefund.id);

    expect(init1.created).toBe(true);
    expect(init1.quote).toBeTruthy();
    expect(init1.orderRefund.status).toBe(OrderRefundStatus.PENDING);
    expect(init1.orderRefund.refundKind).toBe(OrderRefundKind.ORGANIZER_TICKET_REFUND);
    expect(init1.orderRefund.orderId).toBe(order.id);

    const persistedRefund1 = await prisma.orderRefund.findUniqueOrThrow({
      where: { id: init1.orderRefund.id },
      include: { refundTickets: true },
    });
    expect(persistedRefund1.refundTickets).toHaveLength(1);
    expect(persistedRefund1.refundTickets[0].orderId).toBe(order.id);
    expect(persistedRefund1.refundTickets[0].ticketId).toBe(t1.id);
    expect(persistedRefund1.refundTickets[0].lockState).toBe(OrderRefundTicketLockState.ACTIVE_PENDING);
    expect(persistedRefund1.refundTickets[0].refundedAmountInCents).toBe(init1.orderRefund.amountInCents);

    const persistedT1 = await prisma.ticket.findUniqueOrThrow({ where: { id: t1.id } });
    const persistedT2 = await prisma.ticket.findUniqueOrThrow({ where: { id: t2.id } });
    expect(persistedT1.status).toBe(TicketStatus.REFUND_PENDING);
    expect(persistedT2.status).toBe(TicketStatus.ISSUED);

    const orderMid = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(orderMid.pendingRefundAmountInCents).toBe(init1.orderRefund.amountInCents);
    expect(orderMid.refundedAmountInCents).toBe(0);

    // Second partial refund for sibling ticket t2 on the SAME PaymentIntent while t1 is still PENDING
    const init2 = await prisma.$transaction((tx) =>
      initiateTicketRefundInTx(tx, {
        orderId: order.id,
        ticketIds: [t2.id],
        idempotencyKey: `idem_p003_ref2_${nanoid(6)}`,
        stripePaymentIntentId: piId,
        initiatorRole: RefundInitiatorRole.ORGANIZER,
        initiatedByUserId: organizer.id,
        reason: 'Partial refund ticket 2 on same PI in PG',
        feeBearer: RefundFeeBearer.ORGANIZER,
        refundStripeProcessingFee: false,
        restoreInventory: true,
      })
    );
    createdRefundIds.push(init2.orderRefund.id);

    expect(init2.created).toBe(true);
    const orderAfterBoth = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(orderAfterBoth.pendingRefundAmountInCents).toBe(
      init1.orderRefund.amountInCents + init2.orderRefund.amountInCents
    );

    // Finalize first partial refund -> CONFIRMED lock & REFUNDED ticket without releasing sibling
    const conf1 = await prisma.$transaction((tx) =>
      confirmTicketRefundSucceededInTx(tx, {
        orderRefundId: init1.orderRefund.id,
        stripeRefundId: `re_p003_1_${nanoid(8)}`,
        confirmedByUserId: organizer.id,
      })
    );
    expect(conf1.orderFullyRefunded).toBe(false);

    const t1Confirmed = await prisma.ticket.findUniqueOrThrow({ where: { id: t1.id } });
    expect(t1Confirmed.status).toBe(TicketStatus.REFUNDED);

    // Composite RESTRICT constraint prevents deleting referenced OrderRefund or Ticket
    await expect(
      prisma.ticket.delete({ where: { id: t1.id } })
    ).rejects.toThrow(/RESTRICT|23001|foreign key/i);
  });

  it('enforces idempotency, rejects duplicate/concurrent refund initiation safely, and rolls back failed transactions cleanly', async () => {
    const { organizer, order, tickets, piId } = await createPaidOrderFixture(2);
    const [t1, t2] = tickets;
    const idemKey1 = `idem_p003_dup_${nanoid(6)}`;

    const first = await prisma.$transaction((tx) =>
      initiateTicketRefundInTx(tx, {
        orderId: order.id,
        ticketIds: [t1.id],
        idempotencyKey: idemKey1,
        stripePaymentIntentId: piId,
        initiatorRole: RefundInitiatorRole.ORGANIZER,
        initiatedByUserId: organizer.id,
        reason: 'Initial refund lock',
        feeBearer: RefundFeeBearer.ORGANIZER,
      })
    );
    createdRefundIds.push(first.orderRefund.id);

    // Idempotent replay with same key returns existing OrderRefund without creating duplicates
    const replay = await prisma.$transaction((tx) =>
      initiateTicketRefundInTx(tx, {
        orderId: order.id,
        ticketIds: [t1.id],
        idempotencyKey: idemKey1,
        stripePaymentIntentId: piId,
        initiatorRole: RefundInitiatorRole.ORGANIZER,
        initiatedByUserId: organizer.id,
        reason: 'Initial refund lock',
        feeBearer: RefundFeeBearer.ORGANIZER,
      })
    );
    expect(replay.created).toBe(false);
    expect(replay.orderRefund.id).toBe(first.orderRefund.id);

    // Different idempotencyKey against already REFUND_PENDING ticket rejects cleanly without mutation
    await expect(
      prisma.$transaction((tx) =>
        initiateTicketRefundInTx(tx, {
          orderId: order.id,
          ticketIds: [t1.id],
          idempotencyKey: `idem_p003_conflict_${nanoid(6)}`,
          stripePaymentIntentId: piId,
          initiatorRole: RefundInitiatorRole.ORGANIZER,
          initiatedByUserId: organizer.id,
          reason: 'Conflicting refund attempt',
          feeBearer: RefundFeeBearer.ORGANIZER,
        })
      )
    ).rejects.toThrow(RefundDomainRuleError);

    const orderBeforeRollback = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(orderBeforeRollback.pendingRefundAmountInCents).toBe(first.orderRefund.amountInCents);

    // Failed mid-transaction abort after initiateTicketRefundInTx leaves zero partial OrderRefund/OrderRefundTicket/counter changes
    const rolledBackIdem = `idem_p003_rollback_${nanoid(6)}`;
    await expect(
      prisma.$transaction(async (tx) => {
        await initiateTicketRefundInTx(tx, {
          orderId: order.id,
          ticketIds: [t2.id],
          idempotencyKey: rolledBackIdem,
          stripePaymentIntentId: piId,
          initiatorRole: RefundInitiatorRole.ORGANIZER,
          initiatedByUserId: organizer.id,
          reason: 'Transaction must roll back',
          feeBearer: RefundFeeBearer.ORGANIZER,
        });
        throw new Error('SIMULATED_POST_INIT_TX_FAILURE');
      })
    ).rejects.toThrow('SIMULATED_POST_INIT_TX_FAILURE');

    expect(
      await prisma.orderRefund.findUnique({ where: { idempotencyKey: rolledBackIdem } })
    ).toBeNull();
    const t2AfterRollback = await prisma.ticket.findUniqueOrThrow({ where: { id: t2.id } });
    expect(t2AfterRollback.status).toBe(TicketStatus.ISSUED);
    const orderAfterRollback = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(orderAfterRollback.pendingRefundAmountInCents).toBe(first.orderRefund.amountInCents);

    // Concurrent race on t2 serializes under Order FOR UPDATE: exactly 1 succeeds, 1 rejects
    const concurrent = await Promise.allSettled([
      prisma.$transaction((tx) =>
        initiateTicketRefundInTx(tx, {
          orderId: order.id,
          ticketIds: [t2.id],
          idempotencyKey: `idem_p003_race_a_${nanoid(6)}`,
          stripePaymentIntentId: piId,
          initiatorRole: RefundInitiatorRole.ORGANIZER,
          initiatedByUserId: organizer.id,
          reason: 'Concurrent race A',
          feeBearer: RefundFeeBearer.ORGANIZER,
        })
      ),
      prisma.$transaction((tx) =>
        initiateTicketRefundInTx(tx, {
          orderId: order.id,
          ticketIds: [t2.id],
          idempotencyKey: `idem_p003_race_b_${nanoid(6)}`,
          stripePaymentIntentId: piId,
          initiatorRole: RefundInitiatorRole.ORGANIZER,
          initiatedByUserId: organizer.id,
          reason: 'Concurrent race B',
          feeBearer: RefundFeeBearer.ORGANIZER,
        })
      ),
    ]);

    const fulfilled = concurrent.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof initiateTicketRefundInTx>>> =>
        r.status === 'fulfilled'
    );
    const rejected = concurrent.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    createdRefundIds.push(fulfilled[0].value.orderRefund.id);

    // Verify partial unique index blocks raw duplicate ACTIVE_PENDING lock even outside domain service
    await expect(
      prisma.$executeRaw`
        INSERT INTO "OrderRefundTicket" (
          id, "orderRefundId", "orderId", "ticketId", "lockState",
          "allocatedGrossInCents", "allocatedPlatformFeeInCents", "allocatedServiceFeeInCents",
          "allocatedProcessingFeeInCents", "allocatedBuyerTotalInCents", "refundedAmountInCents", "updatedAt"
        ) VALUES (
          ${crypto.randomUUID()}, ${first.orderRefund.id}, ${order.id}, ${t2.id},
          'ACTIVE_PENDING'::"OrderRefundTicketLockState",
          2000, 200, 95, 70, 2365, 2295, NOW()
        )
      `
    ).rejects.toThrow(/23505|OrderRefundTicket_active_or_confirmed_ticket_key|unique constraint/i);

    // Cancelling an active refund transitions lock to RELEASED and restores Ticket ISSUED & Order counter
    await prisma.$transaction((tx) =>
      cancelTicketRefundInTx(tx, {
        orderRefundId: fulfilled[0].value.orderRefund.id,
        cancellationReason: 'PG release test',
      })
    );
    const t2Released = await prisma.ticket.findUniqueOrThrow({ where: { id: t2.id } });
    expect(t2Released.status).toBe(TicketStatus.ISSUED);
  });
});
