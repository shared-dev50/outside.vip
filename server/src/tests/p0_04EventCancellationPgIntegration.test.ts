import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'crypto';
import { nanoid } from 'nanoid';
import {
  EventCategory,
  EventStatus,
  LedgerBalanceType,
  LedgerEntryType,
  OrderRefundKind,
  OrderRefundStatus,
  OrderStatus,
  PaymentProvider,
  RefundInitiatorRole,
  Role,
  TransferSourceType,
  TransferStatus,
} from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { stripe } from '../lib/stripe.js';
import {
  computeCancelledEventHeldAvailableInCents,
  getOrganizerFinancialSummary,
} from '../modules/finance/ledger.service.js';
import { executeWithdrawal } from '../modules/finance/transfer.service.js';
import {
  cancelEventsTransactionally,
  cancelSeriesEventsTransactionally,
} from '../modules/events/eventCancellation.service.js';
import { unpublishEvent } from '../modules/organizer/organizer.controller.js';
import { buildEventCancelledOrganizerDedupeKey } from '../modules/notifications/emailOutbox.service.js';

function createMockRes() {
  const res: any = {
    statusCode: 200,
    body: null as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

describe('Stage 4 P0-04 — Real PostgreSQL Accounting & Concurrency Integration', () => {
  const createdUserIds: string[] = [];
  const createdSeriesIds: string[] = [];
  const createdEventIds: string[] = [];
  const createdOrderIds: string[] = [];

  async function createOrganizerFixture(tag: string) {
    const suffix = `${tag}_${nanoid(6)}`;
    const user = await prisma.user.create({
      data: {
        email: `p004_pg_${suffix}@outside.vip`,
        name: `P004 Org ${tag}`,
        role: Role.ORGANIZER,
        emailVerified: true,
        stripeAccountId: `acct_pg_${suffix}`,
        organizer: {
          create: {
            displayName: `P004 Collective ${suffix}`,
            slug: `p004-pg-${suffix}`.toLowerCase(),
          },
        },
      },
    });
    createdUserIds.push(user.id);
    return user;
  }

  async function createEventFixture(params: {
    organizerId: string;
    title: string;
    status?: EventStatus;
    seriesId?: string | null;
    startAt?: Date;
    occurrenceIndex?: number | null;
  }) {
    const startAt = params.startAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const evt = await prisma.event.create({
      data: {
        slug: `p004-evt-${nanoid(8)}`.toLowerCase(),
        organizerId: params.organizerId,
        seriesId: params.seriesId ?? null,
        occurrenceIndex: params.occurrenceIndex ?? null,
        title: params.title,
        description: 'P0-04 PG integration fixture',
        category: EventCategory.MUSIC,
        status: params.status ?? EventStatus.PUBLISHED,
        coverImageUrl: 'https://example.com/p004-pg.jpg',
        venueName: 'Warehouse Stage',
        venueAddress: '100 Basin St',
        city: 'Austin',
        country: 'US',
        startAt,
        endAt: new Date(startAt.getTime() + 4 * 60 * 60 * 1000),
        timezone: 'America/Chicago',
      },
    });
    createdEventIds.push(evt.id);
    return evt;
  }

  beforeAll(() => {
    process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_mock_p004';
    vi.spyOn(stripe.accounts, 'retrieve').mockResolvedValue({
      id: 'acct_pg_mock',
      country: 'US',
      default_currency: 'usd',
      payouts_enabled: true,
      capabilities: { transfers: 'active' },
      requirements: { past_due: [] },
    } as any);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (createdUserIds.length > 0) {
      const organizerOutboxKeys = createdEventIds.map((eid) =>
        buildEventCancelledOrganizerDedupeKey(eid)
      );
      if (createdOrderIds.length > 0 || organizerOutboxKeys.length > 0) {
        await prisma.emailOutbox.deleteMany({
          where: {
            OR: [
              ...(createdOrderIds.length > 0 ? [{ orderId: { in: createdOrderIds } }] : []),
              ...(organizerOutboxKeys.length > 0
                ? [{ dedupeKey: { in: organizerOutboxKeys } }]
                : []),
            ],
          },
        }).catch(() => {});
      }
      await prisma.orderRefund.deleteMany({
        where: { orderId: { in: createdOrderIds } },
      }).catch(() => {});
      await prisma.order.deleteMany({
        where: { id: { in: createdOrderIds } },
      }).catch(() => {});
      await prisma.financialLedgerEntry.deleteMany({
        where: { organizerId: { in: createdUserIds } },
      }).catch(() => {});
      await prisma.organizerTransfer.deleteMany({
        where: { organizerId: { in: createdUserIds } },
      }).catch(() => {});
      await prisma.organizerBalance.deleteMany({
        where: { userId: { in: createdUserIds } },
      }).catch(() => {});
      await prisma.adminAuditLog.deleteMany({
        where: { actorUserId: { in: createdUserIds } },
      }).catch(() => {});
      await prisma.event.deleteMany({
        where: { id: { in: createdEventIds } },
      }).catch(() => {});
      await prisma.eventSeries.deleteMany({
        where: { id: { in: createdSeriesIds } },
      }).catch(() => {});
      await prisma.user.deleteMany({
        where: { id: { in: createdUserIds } },
      }).catch(() => {});
    }
  });

  it('proves real PostgreSQL accounting for pre-cancel transfer + active event, partial transfer, DISPUTE_LOST recovery across B/C, and MANUALLY_RESOLVED NO_REFUND_NEEDED', async () => {
    const org = await createOrganizerFixture('acct');
    const eventB = await createEventFixture({ organizerId: org.id, title: 'Cancelled Event B' });
    const eventC = await createEventFixture({ organizerId: org.id, title: 'Cancelled Event C' });
    const eventA = await createEventFixture({ organizerId: org.id, title: 'Active Event A' });

    const t0 = new Date('2026-11-10T10:00:00.000Z');
    const t1 = new Date('2026-11-10T11:00:00.000Z');
    const t2 = new Date('2026-11-10T12:00:00.000Z');
    const t3 = new Date('2026-11-10T13:00:00.000Z');
    const t4 = new Date('2026-11-10T14:00:00.000Z');

    await prisma.organizerBalance.create({
      data: {
        userId: org.id,
        currency: 'USD',
        pendingBalanceInCents: 0,
        availableBalanceInCents: 25000, // 8000 (B) - 3000 (tr1) + 10000 (C) + 10000 (A)
        transferredBalanceInCents: 3000,
      },
    });

    const tr1 = await prisma.organizerTransfer.create({
      data: {
        transferNumber: `TRF-PG1-${nanoid(6)}`,
        organizerId: org.id,
        stripeAccountId: org.stripeAccountId!,
        amountInCents: 3000,
        currency: 'USD',
        status: TransferStatus.SUCCEEDED,
        sourceType: TransferSourceType.MANUAL_ORGANIZER_REQUEST,
        idempotencyKey: `idem_pg1_${nanoid(8)}`,
        initiatedByUserId: org.id,
      },
    });

    await prisma.financialLedgerEntry.createMany({
      data: [
        {
          id: crypto.randomUUID(),
          type: LedgerEntryType.TICKET_SALE_CLEARED,
          balanceType: LedgerBalanceType.AVAILABLE,
          amountInCents: 8000,
          currency: 'USD',
          organizerId: org.id,
          eventId: eventB.id,
          description: 'Event B settled',
          createdAt: t0,
        },
        {
          id: crypto.randomUUID(),
          type: LedgerEntryType.TRANSFER_INITIATED,
          balanceType: LedgerBalanceType.AVAILABLE,
          amountInCents: -3000,
          currency: 'USD',
          organizerId: org.id,
          transferId: tr1.id,
          description: 'Partial withdrawal before cancel',
          createdAt: t1,
        },
        {
          id: crypto.randomUUID(),
          type: LedgerEntryType.TICKET_SALE_CLEARED,
          balanceType: LedgerBalanceType.AVAILABLE,
          amountInCents: 10000,
          currency: 'USD',
          organizerId: org.id,
          eventId: eventC.id,
          description: 'Event C settled',
          createdAt: new Date(t1.getTime() + 1000),
        },
        {
          id: crypto.randomUUID(),
          type: LedgerEntryType.TICKET_SALE_CLEARED,
          balanceType: LedgerBalanceType.AVAILABLE,
          amountInCents: 10000,
          currency: 'USD',
          organizerId: org.id,
          eventId: eventA.id,
          description: 'Active Event A settled',
          createdAt: t3,
        },
      ],
    });

    await prisma.event.updateMany({
      where: { id: { in: [eventB.id, eventC.id] } },
      data: {
        status: EventStatus.CANCELLED,
        cancelledAt: t2,
        cancelledByUserId: org.id,
      },
    });

    // MANUALLY_RESOLVED with NO_REFUND_NEEDED does not release cancelled hold
    const ordB = await prisma.order.create({
      data: {
        orderNumber: `OUT-PG-${nanoid(6)}`,
        eventId: eventB.id,
        status: OrderStatus.COMPLETED,
        paymentProvider: PaymentProvider.STRIPE,
        paymentReference: `pi_pg_${nanoid(8)}`,
        idempotencyKey: `idem_pg_ord_${nanoid(8)}`,
        customerEmail: 'buyer_pg@example.com',
        customerName: 'PG Buyer',
        totalInCents: 9289,
        currency: 'USD',
        platformFeeInCents: 800,
        organizerNetInCents: 8000,
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    createdOrderIds.push(ordB.id);

    await prisma.orderRefund.create({
      data: {
        orderId: ordB.id,
        refundKind: OrderRefundKind.ORGANIZER_TICKET_REFUND,
        initiatorRole: RefundInitiatorRole.ORGANIZER,
        initiatedByUserId: org.id,
        stripePaymentIntentId: ordB.paymentReference!,
        amountInCents: 4645,
        organizerDebitInCents: 4150,
        currency: 'USD',
        idempotencyKey: `idem_ref_pg_${nanoid(8)}`,
        reason: 'Duplicate attempt',
        status: OrderRefundStatus.MANUALLY_RESOLVED,
        resolutionAction: 'NO_REFUND_NEEDED',
        resolvedAt: t4,
      },
    });

    const summary = await getOrganizerFinancialSummary(org.id);
    // Held: B remaining 5000 + C 10000 = 15000; Active A = 10000 withdrawable
    expect(summary.cancelledEventHoldInCents).toBe(15000);
    expect(summary.netAvailableInCents).toBe(10000);

    // Completing remaining 5000 pre-cancel transfer on B with consistent OrganizerBalance & distinct transfer
    const tr2 = await prisma.organizerTransfer.create({
      data: {
        transferNumber: `TRF-PG2-${nanoid(6)}`,
        organizerId: org.id,
        stripeAccountId: org.stripeAccountId!,
        amountInCents: 5000,
        currency: 'USD',
        status: TransferStatus.SUCCEEDED,
        sourceType: TransferSourceType.MANUAL_ORGANIZER_REQUEST,
        idempotencyKey: `idem_pg2_${nanoid(8)}`,
        initiatedByUserId: org.id,
      },
    });
    await prisma.financialLedgerEntry.create({
      data: {
        id: crypto.randomUUID(),
        type: LedgerEntryType.TRANSFER_INITIATED,
        balanceType: LedgerBalanceType.AVAILABLE,
        amountInCents: -5000,
        currency: 'USD',
        organizerId: org.id,
        transferId: tr2.id,
        description: 'Remaining pre-cancel withdrawal on B',
        createdAt: new Date(t1.getTime() + 500),
      },
    });
    await prisma.organizerBalance.update({
      where: { userId: org.id },
      data: {
        availableBalanceInCents: { decrement: 5000 },
        transferredBalanceInCents: { increment: 5000 },
      },
    });

    // B hold drops to 0, leaving C (10000) held and Active A (10000) withdrawable
    expect(await computeCancelledEventHeldAvailableInCents(prisma, org.id)).toBe(10000);

    // DISPUTE_LOST (-10000 on C) followed by AVAILABLE_BALANCE recovery (-10000) zeroes C hold cleanly
    await prisma.financialLedgerEntry.createMany({
      data: [
        {
          id: crypto.randomUUID(),
          type: LedgerEntryType.DISPUTE_LOST,
          balanceType: LedgerBalanceType.RECOVERABLE,
          amountInCents: -10000,
          currency: 'USD',
          organizerId: org.id,
          eventId: eventC.id,
          description: 'Dispute lost on C',
          createdAt: new Date(t4.getTime() + 1000),
        },
        {
          id: crypto.randomUUID(),
          type: LedgerEntryType.ADJUSTMENT,
          balanceType: LedgerBalanceType.AVAILABLE,
          amountInCents: -10000,
          currency: 'USD',
          organizerId: org.id,
          description: 'Liability recovery from AVAILABLE',
          createdAt: new Date(t4.getTime() + 2000),
        },
        {
          id: crypto.randomUUID(),
          type: LedgerEntryType.ADJUSTMENT,
          balanceType: LedgerBalanceType.RECOVERABLE,
          amountInCents: 10000,
          currency: 'USD',
          organizerId: org.id,
          description: 'Recoverable liability offset',
          createdAt: new Date(t4.getTime() + 2000),
        },
      ],
    });
    await prisma.organizerBalance.update({
      where: { userId: org.id },
      data: { availableBalanceInCents: { decrement: 10000 } },
    });

    const summaryPostDispute = await getOrganizerFinancialSummary(org.id);
    expect(summaryPostDispute.availableInCents).toBe(10000);
    expect(summaryPostDispute.recoverableInCents).toBe(0);
    expect(summaryPostDispute.cancelledEventHoldInCents).toBe(0);
    expect(summaryPostDispute.netAvailableInCents).toBe(10000);
  });

  it('serializes concurrent executeWithdrawal vs cancelEventsTransactionally in real PostgreSQL with explicit barriers for both lock orderings', async () => {
    const transfersCreateSpy = vi
      .spyOn(stripe.transfers, 'create')
      .mockResolvedValue({
        id: `tr_stripe_${nanoid(8)}`,
        amount: 8000,
        currency: 'usd',
      } as any);

    // Ordering 1: Cancellation acquires Event FOR UPDATE first -> concurrent withdrawal blocks and rejects
    {
      const org = await createOrganizerFixture('conc_cancel_first');
      const evt = await createEventFixture({ organizerId: org.id, title: 'Concurrent Event 1' });
      await prisma.organizerBalance.create({
        data: {
          userId: org.id,
          currency: 'USD',
          pendingBalanceInCents: 0,
          availableBalanceInCents: 8000,
          transferredBalanceInCents: 0,
        },
      });
      await prisma.financialLedgerEntry.create({
        data: {
          type: LedgerEntryType.TICKET_SALE_CLEARED,
          balanceType: LedgerBalanceType.AVAILABLE,
          amountInCents: 8000,
          currency: 'USD',
          organizerId: org.id,
          eventId: evt.id,
          description: 'Settled before race',
        },
      });

      let lockHeldResolve!: () => void;
      const lockHeld = new Promise<void>((r) => {
        lockHeldResolve = r;
      });
      let releaseCancel!: () => void;
      const cancelBarrier = new Promise<void>((r) => {
        releaseCancel = r;
      });

      const cancelTx = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Event" WHERE id = ${evt.id} FOR UPDATE`;
        lockHeldResolve();
        await cancelBarrier;
        await tx.event.update({
          where: { id: evt.id },
          data: { status: EventStatus.CANCELLED, cancelledAt: new Date(), cancelledByUserId: org.id },
        });
      });

      await lockHeld;
      let withdrawalFinishedBeforeCancel = false;
      const withdrawPromise = executeWithdrawal({
        userId: org.id,
        amountInCents: 8000,
        idempotencyKey: `conc_w1_${nanoid(6)}`,
      }).finally(() => {
        withdrawalFinishedBeforeCancel = true;
      });

      await new Promise((r) => setTimeout(r, 80));
      expect(withdrawalFinishedBeforeCancel).toBe(false);
      releaseCancel();

      await cancelTx;
      await expect(withdrawPromise).rejects.toMatchObject({
        statusCode: 400,
        code: 'INSUFFICIENT_AVAILABLE_BALANCE',
      });
      expect(transfersCreateSpy).not.toHaveBeenCalled();

      const balAfter = await prisma.organizerBalance.findUniqueOrThrow({ where: { userId: org.id } });
      expect(balAfter.availableBalanceInCents).toBe(8000);
    }

    // Ordering 2 (Deterministic): Holder acquires Event FOR SHARE -> cancellation blocks on FOR UPDATE
    // while executeWithdrawal acquires compatible Event FOR SHARE, completes transfer cleanly, and only
    // after FOR SHARE releases does cancellation commit with 0 phantom hold remaining.
    {
      const org = await createOrganizerFixture('conc_withdraw_first');
      const evt = await createEventFixture({ organizerId: org.id, title: 'Concurrent Event 2' });
      await prisma.organizerBalance.create({
        data: {
          userId: org.id,
          currency: 'USD',
          pendingBalanceInCents: 0,
          availableBalanceInCents: 8000,
          transferredBalanceInCents: 0,
        },
      });
      await prisma.financialLedgerEntry.create({
        data: {
          type: LedgerEntryType.TICKET_SALE_CLEARED,
          balanceType: LedgerBalanceType.AVAILABLE,
          amountInCents: 8000,
          currency: 'USD',
          organizerId: org.id,
          eventId: evt.id,
          description: 'Settled before race',
        },
      });

      let shareHeldResolve!: () => void;
      const shareHeld = new Promise<void>((r) => {
        shareHeldResolve = r;
      });
      let releaseShare!: () => void;
      const shareBarrier = new Promise<void>((r) => {
        releaseShare = r;
      });

      const shareHolderTx = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Event" WHERE id = ${evt.id} FOR SHARE`;
        shareHeldResolve();
        await shareBarrier;
      });

      await shareHeld;

      let cancelCompletedEarly = false;
      const cancelPromise = cancelEventsTransactionally({
        eventIds: [evt.id],
        actorUserId: org.id,
        actorEmail: org.email,
        actorRole: Role.ORGANIZER,
        reason: 'Concurrent cancel waiting on FOR SHARE',
      }).then((res) => {
        cancelCompletedEarly = true;
        return res;
      });

      await new Promise((r) => setTimeout(r, 80));
      // Cancellation MUST still be blocked by FOR SHARE before withdrawal commits
      expect(cancelCompletedEarly).toBe(false);

      // Concurrent executeWithdrawal acquires compatible Event FOR SHARE + OrganizerBalance FOR UPDATE cleanly
      const wResult = await executeWithdrawal({
        userId: org.id,
        amountInCents: 8000,
        idempotencyKey: `conc_w2_${nanoid(6)}`,
      });
      expect(wResult.status).toBe(TransferStatus.SUCCEEDED);

      // Release FOR SHARE so queued cancellation finishes
      releaseShare();
      await shareHolderTx;
      const cancelRes = await cancelPromise;
      expect(cancelRes.cancelledEventIds).toEqual([evt.id]);

      const balAfter = await prisma.organizerBalance.findUniqueOrThrow({ where: { userId: org.id } });
      expect(balAfter.availableBalanceInCents).toBe(0);
      expect(balAfter.transferredBalanceInCents).toBe(8000);
      expect(await computeCancelledEventHeldAvailableInCents(prisma, org.id)).toBe(0);
    }
  });

  it('locks EventSeries FOR UPDATE so concurrently inserted series occurrences cannot escape cancelSeriesEventsTransactionally, and enforces conditional unpublishEvent', async () => {
    const org = await createOrganizerFixture('ser_unpub');
    const series = await prisma.eventSeries.create({
      data: {
        organizerId: org.id,
        title: 'Weekly PG Series',
        frequency: 'WEEKLY',
        interval: 1,
        byWeekday: [],
        startDate: new Date(Date.now() + 86400_000),
        timezone: 'UTC',
      },
    });
    createdSeriesIds.push(series.id);

    const evt1 = await createEventFixture({
      organizerId: org.id,
      title: 'Series Occ 1',
      seriesId: series.id,
      occurrenceIndex: 1,
    });
    const evt2 = await createEventFixture({
      organizerId: org.id,
      title: 'Series Occ 2',
      seriesId: series.id,
      occurrenceIndex: 2,
      startAt: new Date(Date.now() + 8 * 86400_000),
    });

    let seriesLockHeldResolve!: () => void;
    const seriesLockHeld = new Promise<void>((r) => {
      seriesLockHeldResolve = r;
    });
    let releaseCreator!: () => void;
    const creatorBarrier = new Promise<void>((r) => {
      releaseCreator = r;
    });

    // Concurrently create a 3rd occurrence while holding EventSeries FOR UPDATE;
    // cancelSeriesEventsTransactionally MUST block on EventSeries FOR UPDATE until occ3 commits, then discover & cancel occ3 too.
    let evt3Id = '';
    const concurrentCreatorTx = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "EventSeries" WHERE id = ${series.id} FOR UPDATE`;
      seriesLockHeldResolve();
      await creatorBarrier;
      const startAt3 = new Date(Date.now() + 15 * 86400_000);
      const occ3 = await tx.event.create({
        data: {
          slug: `p004-evt3-${nanoid(8)}`.toLowerCase(),
          organizerId: org.id,
          seriesId: series.id,
          occurrenceIndex: 3,
          title: 'Series Occ 3 (Concurrent)',
          description: 'Concurrently added occurrence',
          category: EventCategory.MUSIC,
          status: EventStatus.PUBLISHED,
          coverImageUrl: 'https://example.com/p004-pg.jpg',
          venueName: 'Warehouse Stage',
          venueAddress: '100 Basin St',
          city: 'Austin',
          country: 'US',
          startAt: startAt3,
          endAt: new Date(startAt3.getTime() + 4 * 60 * 60 * 1000),
          timezone: 'America/Chicago',
        },
      });
      evt3Id = occ3.id;
      createdEventIds.push(occ3.id);
    });

    await seriesLockHeld;

    let seriesCancelFinishedEarly = false;
    const cancelSeriesPromise = cancelSeriesEventsTransactionally({
      seriesId: series.id,
      actorUserId: org.id,
      actorEmail: org.email,
      actorRole: Role.ORGANIZER,
      reason: 'Series stopped',
    }).then((res) => {
      seriesCancelFinishedEarly = true;
      return res;
    });

    await new Promise((r) => setTimeout(r, 80));
    expect(seriesCancelFinishedEarly).toBe(false);

    releaseCreator();
    await concurrentCreatorTx;
    const serRes = await cancelSeriesPromise;

    expect(serRes.cancelledEventIds.sort()).toEqual([evt1.id, evt2.id, evt3Id].sort());

    const evt3Row = await prisma.event.findUniqueOrThrow({ where: { id: evt3Id } });
    expect(evt3Row.status).toBe(EventStatus.CANCELLED);

    const next = vi.fn();
    await unpublishEvent(
      {
        user: { userId: org.id, role: Role.ORGANIZER, email: org.email },
        params: { id: evt1.id },
        query: {},
        body: {},
      } as any,
      createMockRes(),
      next
    );
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 409, code: 'EVENT_CANCELLED' })
    );
  });
});
