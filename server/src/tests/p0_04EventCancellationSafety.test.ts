import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CheckInResult,
  EmailOutboxStatus,
  EmailOutboxType,
  EventStatus,
  LedgerBalanceType,
  LedgerEntryType,
  OrderStatus,
  PaymentProvider,
  ReservationStatus,
  Role,
  StripeSettlementStatus,
  TicketStatus,
  TicketTierStatus,
} from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { stripe } from '../lib/stripe.js';
import {
  EVENT_CANCELLED_TEMPLATE_VERSION,
  sentEventCancelledBuyerEmails,
  sentEventCancelledOrganizerEmails,
} from '../lib/email.service.js';
import { runEmailOutboxPass } from '../modules/notifications/emailOutbox.service.js';
import { executeEventCancellationInTx } from '../modules/events/eventCancellation.service.js';
import * as waitlistService from '../modules/waitlist/waitlist.service.js';
import {
  cancelOrganizerEvent,
  cancelOrganizerSeries,
  checkInTicket,
  publishEvent,
  unpublishEvent,
  updateOrganizerEvent,
} from '../modules/organizer/organizer.controller.js';
import {
  downloadOrderTicketsPdf,
  getOrderByOrderNumber,
} from '../modules/orders/orders.controller.js';
import { generateTicketsPdf } from '../modules/orders/ticketPdf.service.js';
import { createCheckoutSession } from '../modules/checkout/checkout.service.js';
import {
  computeCancelledEventHeldAvailableInCents,
  getOrganizerFinancialSummary,
  settleOrderEarnings,
} from '../modules/finance/ledger.service.js';
import { executeWithdrawal } from '../modules/finance/transfer.service.js';
import { claimPendingSettlementBatch } from '../modules/finance/settlementRecovery.service.js';
import * as eventPermissions from '../modules/eventTeam/eventTeam.permissions.js';

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
    setHeader() {
      return this;
    },
    send(payload: any) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

describe('Stage 4 P0-04 — Event Cancellation Financial and Admission Safety', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sentEventCancelledBuyerEmails.length = 0;
    sentEventCancelledOrganizerEmails.length = 0;
  });

  describe('1. Atomic Cancellation, Audit Logging, Idempotency & No Auto-Refunds', () => {
    it('cancels event, releases PENDING orders & ACTIVE reservations, invalidates waitlist, preserves COMPLETED orders/tickets, logs AdminAuditLog, and enqueues buyer + organizer emails without auto-refunding', async () => {
      const txMock: any = {
        $queryRaw: vi
          .fn()
          .mockResolvedValueOnce([
            {
              id: 'evt_cancel_1',
              status: EventStatus.PUBLISHED,
              organizerId: 'org_1',
              title: 'Desert Echoes',
              startAt: new Date('2026-12-20T20:00:00.000Z'),
            },
          ])
          .mockResolvedValueOnce([{ id: 'ord_pending_1' }]),
        event: {
          updateMany: vi.fn().mockResolvedValueOnce({ count: 1 }),
        },
        ticketReservation: {
          updateMany: vi
            .fn()
            .mockResolvedValueOnce({ count: 2 }) // pending orders reservations
            .mockResolvedValueOnce({ count: 0 }), // orphaned reservations
        },
        order: {
          updateMany: vi.fn().mockResolvedValueOnce({ count: 1 }),
          groupBy: vi.fn().mockResolvedValueOnce([{ eventId: 'evt_cancel_1', _count: { _all: 1 } }]),
          findMany: vi.fn().mockResolvedValueOnce([
            {
              id: 'ord_comp_1',
              eventId: 'evt_cancel_1',
              orderNumber: 'OUT-COMP-1',
              customerEmail: 'BUYER@example.com',
              customerName: 'Nadia Buyer',
              totalInCents: 5000,
              currency: 'USD',
              tickets: [{ id: 'tkt_1', status: TicketStatus.ISSUED }],
            },
            {
              id: 'ord_already_refunded',
              eventId: 'evt_cancel_1',
              orderNumber: 'OUT-REF-1',
              customerEmail: 'oldrefund@example.com',
              customerName: 'Already Refunded',
              totalInCents: 2500,
              currency: 'USD',
              tickets: [{ id: 'tkt_old', status: TicketStatus.REFUNDED }],
            },
          ]),
        },
        user: {
          findMany: vi.fn().mockResolvedValueOnce([
            { id: 'org_1', email: 'organizer@example.com', name: 'Event Owner' },
          ]),
        },
        organizerBalance: {
          findMany: vi.fn().mockResolvedValueOnce([
            {
              userId: 'org_1',
              currency: 'USD',
              pendingBalanceInCents: 2000,
              availableBalanceInCents: 5000,
              transferredBalanceInCents: 1000,
            },
          ]),
        },
        financialLedgerEntry: {
          findMany: vi.fn().mockResolvedValueOnce([
            { eventId: 'evt_cancel_1', amountInCents: 4000 },
          ]),
        },
        emailOutbox: {
          createMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        adminAuditLog: {
          create: vi.fn().mockResolvedValueOnce({ id: 'audit_1' }),
        },
      };

      const cancelWaitlistSpy = vi
        .spyOn(waitlistService, 'cancelWaitlistForEventIds')
        .mockResolvedValueOnce(undefined);
      const stripeRefundSpy = vi.spyOn(stripe.refunds, 'create');
      const stripeTransferRevSpy = vi.spyOn(stripe.transfers, 'createReversal');

      const result = await executeEventCancellationInTx(txMock, {
        eventIds: ['evt_cancel_1'],
        actorUserId: 'org_1',
        actorEmail: 'organizer@example.com',
        actorRole: Role.ORGANIZER,
        reason: 'Severe weather warning',
        ipAddress: '127.0.0.1',
      });

      expect(result.cancelledEventIds).toEqual(['evt_cancel_1']);
      expect(result.cancelledPendingOrdersCount).toBe(1);
      expect(result.releasedReservationCount).toBe(2);
      expect(result.affectedCompletedOrdersCount).toBe(1); // skipped ord_already_refunded
      expect(result.enqueuedEmailCount).toBe(2); // 1 buyer + 1 organizer

      expect(txMock.event.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: EventStatus.CANCELLED,
            cancelledByUserId: 'org_1',
            cancellationReason: 'Severe weather warning',
          }),
        })
      );
      expect(txMock.ticketReservation.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: ReservationStatus.RELEASED },
        })
      );
      expect(txMock.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['ord_pending_1'] }, status: OrderStatus.PENDING },
          data: { status: OrderStatus.CANCELLED },
        })
      );
      expect(cancelWaitlistSpy).toHaveBeenCalledWith(['evt_cancel_1'], txMock);
      expect(txMock.adminAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            actorUserId: 'org_1',
            action: 'EVENT_CANCELLED',
            metadata: expect.objectContaining({
              reason: 'Severe weather warning',
              automaticRefundsIssued: false,
            }),
          }),
        })
      );
      // Never auto-refund buyers or reverse Connect transfers
      expect(stripeRefundSpy).not.toHaveBeenCalled();
      expect(stripeTransferRevSpy).not.toHaveBeenCalled();
    });

    it('treats repeated cancellation attempts idempotently without duplicate emails or audit logs', async () => {
      const txRepeat: any = {
        $queryRaw: vi.fn().mockResolvedValueOnce([
          {
            id: 'evt_done_1',
            status: EventStatus.CANCELLED,
            organizerId: 'org_1',
            title: 'Already Cancelled',
            startAt: new Date('2026-12-20T20:00:00.000Z'),
          },
        ]),
        event: { updateMany: vi.fn() },
        emailOutbox: { createMany: vi.fn() },
        adminAuditLog: { create: vi.fn() },
      };

      const res = await executeEventCancellationInTx(txRepeat, {
        eventIds: ['evt_done_1'],
        actorUserId: 'org_1',
        actorEmail: 'organizer@example.com',
        actorRole: Role.ORGANIZER,
        reason: 'Repeat request',
      });

      expect(res.cancelledEventIds).toEqual([]);
      expect(res.alreadyCancelledEventIds).toEqual(['evt_done_1']);
      expect(res.enqueuedEmailCount).toBe(0);
      expect(txRepeat.event.updateMany).not.toHaveBeenCalled();
      expect(txRepeat.emailOutbox.createMany).not.toHaveBeenCalled();
      expect(txRepeat.adminAuditLog.create).not.toHaveBeenCalled();
    });
  });

  describe('2. Authorization & Re-publish Protection', () => {
    it('enforces team canCancelEvent & preserves strict owner/ADMIN series restriction', async () => {
      vi.spyOn(prisma.event, 'findUnique').mockResolvedValueOnce({
        id: 'evt_team_1',
        organizerId: 'org_owner_1',
        series: null,
      } as any);
      vi.spyOn(eventPermissions, 'resolveEventAuthorization').mockRejectedValueOnce(
        Object.assign(new Error("You lack the 'canCancelEvent' permission"), { statusCode: 403 })
      );

      const nextCancel = vi.fn();
      await cancelOrganizerEvent(
        {
          user: { userId: 'team_admin_no_perm', role: Role.ATTENDEE, email: 'team@example.com' },
          params: { id: 'evt_team_1' },
          body: {},
        } as any,
        createMockRes(),
        nextCancel
      );
      expect(nextCancel).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));

      // Series cancellation forbids even a delegated Event Admin
      vi.spyOn(prisma.eventSeries, 'findUnique').mockResolvedValueOnce({
        id: 'series_1',
        organizerId: 'org_owner_1',
        events: [{ id: 'evt_occ_1' }],
      } as any);

      const nextSeries = vi.fn();
      await cancelOrganizerSeries(
        {
          user: { userId: 'team_admin_no_series', role: Role.ATTENDEE, email: 'team@example.com' },
          params: { id: 'series_1' },
          body: {},
        } as any,
        createMockRes(),
        nextSeries
      );
      expect(nextSeries).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));

      // Cancelled event cannot be republished
      vi.spyOn(prisma.event, 'findUnique').mockResolvedValueOnce({
        id: 'evt_cancelled_pub',
        organizerId: 'org_owner_1',
        status: EventStatus.CANCELLED,
        ticketTiers: [],
      } as any);

      const nextPublish = vi.fn();
      await publishEvent(
        {
          user: { userId: 'org_owner_1', role: Role.ORGANIZER, email: 'org@example.com' },
          params: { id: 'evt_cancelled_pub' },
        } as any,
        createMockRes(),
        nextPublish
      );
      expect(nextPublish).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409 }));
    });
  });

  describe('3. Admission Rejection, Confirmation Visibility, PDF Blocking & Checkout Prevention', () => {
    it('rejects door check-in on a CANCELLED event cleanly and logs EVENT_CANCELLED', async () => {
      vi.spyOn(prisma.ticket, 'findUnique').mockResolvedValueOnce({
        id: 'tkt_cancel_adm',
        eventId: 'evt_c_1',
        ticketToken: 'tkt_sec_cancel_adm_1',
        status: TicketStatus.ISSUED,
        event: {
          id: 'evt_c_1',
          slug: 'cancelled-show',
          title: 'Cancelled Show',
          status: EventStatus.CANCELLED,
          organizerId: 'org_1',
          timezone: 'UTC',
          startAt: new Date(),
          endAt: new Date(Date.now() + 3600_000),
        },
        ticketTier: { name: 'VIP', validityStartAt: null, validityEndAt: null },
        order: {
          orderNumber: 'OUT-CAN-1',
          status: OrderStatus.COMPLETED,
          customerName: 'Sam',
          customerEmail: 'sam@example.com',
        },
      } as any);

      const logSpy = vi
        .spyOn(prisma.checkInLog, 'create')
        .mockResolvedValueOnce({ id: 'chklog_1' } as any);

      const req: any = {
        user: { userId: 'org_1', role: Role.ORGANIZER, email: 'org@example.com' },
        headers: {},
        body: { token: 'tkt_sec_cancel_adm_1' },
      };
      const res = createMockRes();
      const next = vi.fn();

      await checkInTicket(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(400);
      expect(res.body.data.result).toBe('EVENT_CANCELLED');
      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            result: CheckInResult.EVENT_CANCELLED,
          }),
        })
      );
    });

    it('keeps cancelled-event order/tickets visible in getOrderByOrderNumber with redacted ticketToken & blocks PDF pass downloads', async () => {
      const orderRecord = {
        id: 'ord_vis_1',
        orderNumber: 'OUT-VIS-1',
        status: OrderStatus.COMPLETED,
        userId: 'user_buyer_1',
        customerName: 'Sam',
        customerEmail: 'sam@example.com',
        customerPhone: null,
        marketingConsent: false,
        marketingConsentAt: null,
        totalInCents: 3000,
        currency: 'USD',
        platformFeeInCents: 200,
        organizerNetInCents: 2500,
        orderAccessToken: 'oat_vis_secret_1234',
        createdAt: new Date(),
        expiresAt: new Date(),
        event: {
          id: 'evt_vis_1',
          organizerId: 'org_1',
          status: EventStatus.CANCELLED,
          title: 'Cancelled Festival',
        },
        items: [],
        tickets: [
          {
            id: 'tkt_vis_1',
            ticketToken: 'tkt_sec_should_be_redacted',
            status: TicketStatus.ISSUED,
          },
        ],
      };

      vi.spyOn(prisma.order, 'findUnique').mockResolvedValue(orderRecord as any);

      const reqConfirm: any = {
        params: { orderNumber: 'OUT-VIS-1' },
        query: { token: 'oat_vis_secret_1234' },
        headers: {},
      };
      const resConfirm = createMockRes();
      await getOrderByOrderNumber(reqConfirm, resConfirm, vi.fn());

      expect(resConfirm.body.success).toBe(true);
      expect(resConfirm.body.data.order.tickets).toHaveLength(1);
      expect(resConfirm.body.data.order.tickets[0].admissionEligible).toBe(false);
      expect(resConfirm.body.data.order.tickets[0].ticketToken).toBeNull();

      // PDF pass download must be rejected
      const nextPdf = vi.fn();
      await downloadOrderTicketsPdf(
        {
          params: { orderNumber: 'OUT-VIS-1' },
          query: { token: 'oat_vis_secret_1234' },
          headers: {},
        } as any,
        createMockRes(),
        nextPdf
      );
      expect(nextPdf).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 400,
          code: 'EVENT_CANCELLED_NO_ADMISSION_PASSES',
        })
      );
    });

    it('blocks checkout inside transaction if event raced to CANCELLED before lock acquisition', async () => {
      vi.spyOn(prisma.event, 'findUnique').mockResolvedValueOnce({
        id: 'evt_race_checkout',
        slug: 'race-event',
        title: 'Race Event',
        status: EventStatus.PUBLISHED,
        endAt: new Date(Date.now() + 86_400_000),
        isPasswordProtected: false,
        passwordHash: null,
        organizer: { name: 'Organizer', organizer: { displayName: 'Org Display' } },
        ticketTiers: [
          {
            id: 'tier_race_1',
            name: 'GA',
            priceInCents: 2500,
            currency: 'USD',
            status: TicketTierStatus.ACTIVE,
            isHidden: false,
            salesDisabled: false,
            salesStartAt: null,
            salesEndAt: null,
            minPerOrder: 1,
            maxPerOrder: 10,
          },
        ],
      } as any);

      const txReleaseEmptyMock: any = {
        $queryRaw: vi.fn().mockResolvedValueOnce([]),
      };
      const txCheckoutMock: any = {
        $queryRaw: vi.fn().mockResolvedValueOnce([
          { status: EventStatus.CANCELLED, endAt: new Date(Date.now() + 86_400_000) },
        ]),
      };
      vi.spyOn(prisma, '$transaction')
        .mockImplementationOnce(async (cb: any) => cb(txReleaseEmptyMock))
        .mockImplementationOnce(async (cb: any) => cb(txCheckoutMock));

      await expect(
        createCheckoutSession({
          eventId: 'evt_race_checkout',
          items: [{ ticketTierId: 'tier_race_1', quantity: 1 }],
          customerName: 'Late Buyer',
          customerEmail: 'late@example.com',
          marketingConsent: false,
        })
      ).rejects.toMatchObject({ statusCode: 400, code: 'EVENT_CANCELLED' });
    });
  });

  describe('4. Settlement Block & Cancelled-Event Withdrawal Hold Protection', () => {
    it('prevents settleOrderEarnings from releasing PENDING funds to AVAILABLE when event is CANCELLED', async () => {
      const txSettleMock: any = {
        $queryRaw: vi.fn().mockResolvedValueOnce([{ id: 'ord_settle_cancel' }]),
        order: {
          findUnique: vi.fn().mockResolvedValueOnce({
            id: 'ord_settle_cancel',
            orderNumber: 'OUT-SC-1',
            eventId: 'evt_cancelled_s1',
            organizerNetInCents: 4000,
            currency: 'USD',
            stripeSettlementStatus: StripeSettlementStatus.PENDING,
            stripeSettlementFailedAt: null,
            stripeSettledChargeId: null,
            stripeBalanceTransactionId: null,
            stripeAvailableOn: null,
            stripeFundsAvailableAt: null,
            event: {
              id: 'evt_cancelled_s1',
              organizerId: 'org_s1',
              title: 'Cancelled Event',
              status: EventStatus.CANCELLED,
            },
          }),
          update: vi.fn().mockResolvedValueOnce({ id: 'ord_settle_cancel' }),
        },
        financialLedgerEntry: {
          findFirst: vi.fn().mockResolvedValueOnce(null), // no existing TICKET_SALE_CLEARED
          create: vi.fn(),
        },
        organizerBalance: {
          update: vi.fn(),
        },
      };

      await settleOrderEarnings(txSettleMock, {
        orderId: 'ord_settle_cancel',
        stripeChargeId: 'ch_1',
      });

      expect(txSettleMock.organizerBalance.update).not.toHaveBeenCalled();
      expect(txSettleMock.financialLedgerEntry.create).not.toHaveBeenCalled();
      expect(txSettleMock.order.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ord_settle_cancel' },
          data: expect.objectContaining({
            stripeSettlementStatus: StripeSettlementStatus.FAILED_PERMANENT,
            stripeSettlementLastErrorCode: 'EVENT_CANCELLED',
          }),
        })
      );
    });

    it('claimPendingSettlementBatch SQL explicitly excludes CANCELLED events', async () => {
      const queryRawSpy = vi
        .spyOn(prisma, '$queryRaw')
        .mockResolvedValueOnce([]) // reap
        .mockResolvedValueOnce([]); // claim

      await claimPendingSettlementBatch({ workerId: 'settle-w1' });

      const claimSql = (queryRawSpy.mock.calls[1][0] as unknown as string[]).join(' ');
      expect(claimSql).toContain("e.status <> 'CANCELLED'::\"EventStatus\"");
    });

    it('holds settled cancelled-event earnings from netAvailable and blocks improper withdrawal while preserving active-event withdrawals and avoiding duplicate RECOVERABLE deduction', async () => {
      // Scenario: Organizer has $180 AVAILABLE total: $100 active event + $80 cancelled event (partially/unrefunded).
      const dbHoldMock: any = {
        event: {
          findMany: vi.fn().mockResolvedValueOnce([{ id: 'evt_cancelled_h1' }]),
        },
        financialLedgerEntry: {
          findMany: vi.fn().mockResolvedValueOnce([
            // Cancelled event cleared $80, $20 refunded from available -> $60 hold remains
            { eventId: 'evt_cancelled_h1', amountInCents: 8000 },
            { eventId: 'evt_cancelled_h1', amountInCents: -2000 },
          ]),
        },
      };
      const hold = await computeCancelledEventHeldAvailableInCents(dbHoldMock, 'org_h1');
      expect(hold).toBe(6000);

      // Summary reflects $180 available - $60 cancelled hold = $120 netAvailable (0 recoverable created)
      vi.spyOn(prisma.organizerBalance, 'findUnique').mockResolvedValueOnce({
        userId: 'org_h1',
        currency: 'USD',
        pendingBalanceInCents: 0,
        availableBalanceInCents: 18000,
        transferredBalanceInCents: 5000, // prior transfer remains untouched
        updatedAt: new Date(),
      } as any);
      vi.spyOn(prisma.event, 'findMany').mockResolvedValueOnce([
        { id: 'evt_cancelled_h1' } as any,
      ]);
      vi.spyOn(prisma.financialLedgerEntry, 'findMany')
        .mockResolvedValueOnce([]) // RECOVERABLE = 0
        .mockResolvedValueOnce([
          { eventId: 'evt_cancelled_h1', amountInCents: 8000 },
          { eventId: 'evt_cancelled_h1', amountInCents: -2000 },
        ] as any) // cancelled hold
        .mockResolvedValueOnce([]); // earnings entries

      const summary = await getOrganizerFinancialSummary('org_h1');
      expect(summary.availableInCents).toBe(18000);
      expect(summary.cancelledEventHoldInCents).toBe(6000);
      expect(summary.netAvailableInCents).toBe(12000);
      expect(summary.recoverableInCents).toBe(0);
      expect(summary.transferredInCents).toBe(5000);

      // Withdrawal attempt of $130 (> $120 netAvailable) must be rejected cleanly inside executeWithdrawal
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock_valid';
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce({
        id: 'org_h1',
        email: 'org@example.com',
        name: 'Org',
        stripeAccountId: 'acct_test_1',
        stripeAccountCountry: 'US',
        role: Role.ORGANIZER,
      } as any);
      vi.spyOn(stripe.accounts, 'retrieve').mockResolvedValueOnce({
        id: 'acct_test_1',
        country: 'US',
        default_currency: 'usd',
        payouts_enabled: true,
        capabilities: { transfers: 'active' },
        requirements: { past_due: [] },
      } as any);
      vi.spyOn(prisma.organizerTransfer, 'findUnique').mockResolvedValueOnce(null);

      const txWithdrawMock: any = {
        $executeRaw: vi.fn().mockResolvedValue(1),
        organizerBalance: {
          findUnique: vi.fn().mockResolvedValueOnce({ id: 'bal_1', userId: 'org_h1', currency: 'USD' }),
          update: vi.fn(),
        },
        $queryRaw: vi.fn().mockResolvedValue([
          {
            id: 'bal_1',
            userId: 'org_h1',
            currency: 'USD',
            availableBalanceInCents: 18000,
            pendingBalanceInCents: 0,
            transferredBalanceInCents: 5000,
          },
        ]),
        event: {
          findMany: vi.fn().mockResolvedValueOnce([{ id: 'evt_cancelled_h1' }]),
        },
        financialLedgerEntry: {
          findMany: vi
            .fn()
            .mockResolvedValueOnce([]) // recoverableEntries
            .mockResolvedValueOnce([
              { eventId: 'evt_cancelled_h1', amountInCents: 8000 },
              { eventId: 'evt_cancelled_h1', amountInCents: -2000 },
            ]), // cancelledEventHold
        },
      };
      vi.spyOn(prisma, '$transaction').mockImplementationOnce(async (cb: any) => cb(txWithdrawMock));

      await expect(
        executeWithdrawal({
          userId: 'org_h1',
          amountInCents: 13000,
          idempotencyKey: 'withdraw_blocked_cancel_hold',
        })
      ).rejects.toMatchObject({
        statusCode: 400,
        code: 'INSUFFICIENT_AVAILABLE_BALANCE',
      });
      expect(txWithdrawMock.organizerBalance.update).not.toHaveBeenCalled();
    });
  });

  describe('5. Buyer & Organizer Event Cancellation Email Outbox Dispatch', () => {
    it('dispatches buyer and organizer cancellation emails accurately without claiming refunds were issued', async () => {
      const buyerSnapshot = {
        templateVersion: EVENT_CANCELLED_TEMPLATE_VERSION,
        eventId: 'evt_mail_1',
        orderId: 'ord_mail_1',
        fromEmail: 'tickets@outside.vip',
        orderNumber: 'OUT-MAIL-1',
        buyerName: 'Sam Buyer',
        eventTitle: 'Oasis Sunset',
        eventStartAtIso: '2026-12-20T18:00:00.000Z',
        cancelledAtIso: '2026-11-25T09:00:00.000Z',
        cancellationReason: 'Venue emergency closure',
        ticketCount: 2,
        orderTotalInCents: 5000,
        currency: 'USD',
      };

      const orgSnapshot = {
        templateVersion: EVENT_CANCELLED_TEMPLATE_VERSION,
        eventId: 'evt_mail_1',
        fromEmail: 'tickets@outside.vip',
        organizerName: 'Maya Host',
        eventTitle: 'Oasis Sunset',
        eventStartAtIso: '2026-12-20T18:00:00.000Z',
        cancelledAtIso: '2026-11-25T09:00:00.000Z',
        actorEmail: 'maya@outside.vip',
        cancellationReason: 'Venue emergency closure',
        affectedOrdersCount: 1,
        cancelledPendingOrdersCount: 2,
      };

      vi.spyOn(prisma, '$queryRaw')
        .mockResolvedValueOnce([]) // reapExpiredExhaustedEmailLeases
        .mockResolvedValueOnce([
          {
            id: 'eb_cancel_buyer',
            type: EmailOutboxType.EVENT_CANCELLED_BUYER,
            status: EmailOutboxStatus.PROCESSING,
            recipientEmail: 'sam@example.com',
            idempotencyKey: 'event-cancelled-buyer:evt_mail_1:ord_mail_1',
            contentSnapshot: buyerSnapshot,
            attempts: 1,
            maxAttempts: 8,
            lockedBy: 'outbox-c1',
          },
          {
            id: 'eb_cancel_org',
            type: EmailOutboxType.EVENT_CANCELLED_ORGANIZER,
            status: EmailOutboxStatus.PROCESSING,
            recipientEmail: 'maya@outside.vip',
            idempotencyKey: 'event-cancelled-organizer:evt_mail_1',
            contentSnapshot: orgSnapshot,
            attempts: 1,
            maxAttempts: 8,
            lockedBy: 'outbox-c1',
          },
        ] as any);

      vi.spyOn(prisma.emailOutbox, 'updateMany').mockResolvedValue({ count: 1 });

      const stats = await runEmailOutboxPass({ workerId: 'outbox-c1' });
      expect(stats.accepted).toBe(2);
      expect(stats.failedPermanent).toBe(0);

      expect(sentEventCancelledBuyerEmails).toHaveLength(1);
      expect(sentEventCancelledBuyerEmails[0].text).toContain('Refunds are NOT issued automatically');
      expect(sentEventCancelledBuyerEmails[0].text).toContain('handled manually');
      expect(sentEventCancelledBuyerEmails[0].text).not.toContain('refund has been confirmed');

      expect(sentEventCancelledOrganizerEmails).toHaveLength(1);
      expect(sentEventCancelledOrganizerEmails[0].text).toContain('Buyer refunds were NOT issued automatically');
    });
  });

  describe('6. Targeted Remediation Regressions (Held-Balance Attribution, Reversion Closures, Series/Update Locking & PDF Guard)', () => {
    it('attributes pre-cancel full & partial pooled withdrawals without creating phantom holds against active events, handles failures/reversals/RECOVERABLE/NO_REFUND_NEEDED accurately', async () => {
      const t1 = new Date('2026-11-01T10:00:00.000Z');
      const t2 = new Date('2026-11-02T10:00:00.000Z');
      const tCancel = new Date('2026-11-03T10:00:00.000Z');
      const t4 = new Date('2026-11-04T10:00:00.000Z');
      const t5 = new Date('2026-11-05T10:00:00.000Z');

      // Case A: Event B settles 8000, fully withdrawn before cancel, then Active Event A settles 10000 -> hold = 0, netAvailable = 10000
      const mockFullyWithdrawnBeforeCancel: any = {
        event: {
          findMany: vi.fn().mockResolvedValueOnce([{ id: 'evt_b', cancelledAt: tCancel }]),
        },
        financialLedgerEntry: {
          findMany: vi.fn().mockResolvedValueOnce([
            {
              id: 'l1',
              type: LedgerEntryType.TICKET_SALE_CLEARED,
              balanceType: LedgerBalanceType.AVAILABLE,
              amountInCents: 8000,
              eventId: 'evt_b',
              transferId: null,
              createdAt: t1,
            },
            {
              id: 'l2',
              type: LedgerEntryType.TRANSFER_INITIATED,
              balanceType: LedgerBalanceType.AVAILABLE,
              amountInCents: -8000,
              eventId: null,
              transferId: 'tr_1',
              createdAt: t2,
            },
            {
              id: 'l3',
              type: LedgerEntryType.TICKET_SALE_CLEARED,
              balanceType: LedgerBalanceType.AVAILABLE,
              amountInCents: 10000,
              eventId: 'evt_a',
              transferId: null,
              createdAt: t4,
            },
          ]),
        },
      };
      expect(await computeCancelledEventHeldAvailableInCents(mockFullyWithdrawnBeforeCancel, 'org_a')).toBe(0);

      // Summary check on Case A
      vi.spyOn(prisma.organizerBalance, 'findUnique').mockResolvedValueOnce({
        userId: 'org_a',
        currency: 'USD',
        pendingBalanceInCents: 0,
        availableBalanceInCents: 10000,
        transferredBalanceInCents: 8000,
        updatedAt: new Date(),
      } as any);
      vi.spyOn(prisma.event, 'findMany').mockResolvedValueOnce([{ id: 'evt_b', cancelledAt: tCancel } as any]);
      vi.spyOn(prisma.financialLedgerEntry, 'findMany')
        .mockResolvedValueOnce([]) // RECOVERABLE
        .mockResolvedValueOnce([
          {
            id: 'l1',
            type: LedgerEntryType.TICKET_SALE_CLEARED,
            balanceType: LedgerBalanceType.AVAILABLE,
            amountInCents: 8000,
            eventId: 'evt_b',
            transferId: null,
            createdAt: t1,
          },
          {
            id: 'l2',
            type: LedgerEntryType.TRANSFER_INITIATED,
            balanceType: LedgerBalanceType.AVAILABLE,
            amountInCents: -8000,
            eventId: null,
            transferId: 'tr_1',
            createdAt: t2,
          },
          {
            id: 'l3',
            type: LedgerEntryType.TICKET_SALE_CLEARED,
            balanceType: LedgerBalanceType.AVAILABLE,
            amountInCents: 10000,
            eventId: 'evt_a',
            transferId: null,
            createdAt: t4,
          },
        ] as any)
        .mockResolvedValueOnce([]); // earnings entries

      const summaryA = await getOrganizerFinancialSummary('org_a');
      expect(summaryA.availableInCents).toBe(10000);
      expect(summaryA.cancelledEventHoldInCents).toBe(0);
      expect(summaryA.netAvailableInCents).toBe(10000);

      // Case B: Partial transfer (3000) before cancel + partial refund (1500) before cancel + Active Event A (10000)
      const mockPartial: any = {
        event: {
          findMany: vi.fn().mockResolvedValueOnce([{ id: 'evt_b', cancelledAt: tCancel }]),
        },
        financialLedgerEntry: {
          findMany: vi.fn().mockResolvedValueOnce([
            {
              id: 'p1',
              type: LedgerEntryType.TICKET_SALE_CLEARED,
              balanceType: LedgerBalanceType.AVAILABLE,
              amountInCents: 8000,
              eventId: 'evt_b',
              transferId: null,
              createdAt: t1,
            },
            {
              id: 'p2',
              type: LedgerEntryType.REFUND_CLEARED,
              balanceType: LedgerBalanceType.AVAILABLE,
              amountInCents: -1500,
              eventId: 'evt_b',
              transferId: null,
              createdAt: new Date(t1.getTime() + 1000),
            },
            {
              id: 'p3',
              type: LedgerEntryType.TRANSFER_INITIATED,
              balanceType: LedgerBalanceType.AVAILABLE,
              amountInCents: -3000,
              eventId: null,
              transferId: 'tr_p1',
              createdAt: t2,
            },
            {
              id: 'p4',
              type: LedgerEntryType.TICKET_SALE_CLEARED,
              balanceType: LedgerBalanceType.AVAILABLE,
              amountInCents: 10000,
              eventId: 'evt_a',
              transferId: null,
              createdAt: t4,
            },
          ]),
        },
      };
      // Remaining on evt_b: 8000 - 1500 - 3000 = 3500 held
      expect(await computeCancelledEventHeldAvailableInCents(mockPartial, 'org_b')).toBe(3500);

      // Case C: Failed transfer & transfer reversal restore held funds back to evt_b
      const mockFailedAndReversal: any = {
        event: {
          findMany: vi.fn().mockResolvedValueOnce([{ id: 'evt_b', cancelledAt: tCancel }]),
        },
        financialLedgerEntry: {
          findMany: vi.fn().mockResolvedValueOnce([
            {
              id: 'f1',
              type: LedgerEntryType.TICKET_SALE_CLEARED,
              balanceType: LedgerBalanceType.AVAILABLE,
              amountInCents: 8000,
              eventId: 'evt_b',
              transferId: null,
              createdAt: t1,
            },
            {
              id: 'f2',
              type: LedgerEntryType.TRANSFER_INITIATED,
              balanceType: LedgerBalanceType.AVAILABLE,
              amountInCents: -3000,
              eventId: null,
              transferId: 'tr_fail',
              createdAt: t2,
            },
            {
              id: 'f3',
              type: LedgerEntryType.TRANSFER_FAILED,
              balanceType: LedgerBalanceType.AVAILABLE,
              amountInCents: 3000,
              eventId: null,
              transferId: 'tr_fail',
              createdAt: t4,
            },
            {
              id: 'f4',
              type: LedgerEntryType.TRANSFER_INITIATED,
              balanceType: LedgerBalanceType.AVAILABLE,
              amountInCents: -5000,
              eventId: null,
              transferId: 'tr_rev',
              createdAt: new Date(t2.getTime() + 1000),
            },
            {
              id: 'f5',
              type: LedgerEntryType.ADJUSTMENT,
              balanceType: LedgerBalanceType.AVAILABLE,
              amountInCents: 2000,
              eventId: null,
              transferId: 'tr_rev',
              createdAt: t5,
            },
          ]),
        },
      };
      // 8000 - 3000 + 3000 - 5000 + 2000 = 5000 restored to hold
      expect(await computeCancelledEventHeldAvailableInCents(mockFailedAndReversal, 'org_c')).toBe(5000);

      // Case D: Post-cancel withdrawal from Active Event A NEVER reduces Cancelled Event B hold
      const mockPostCancelWithdraw: any = {
        event: {
          findMany: vi.fn().mockResolvedValueOnce([{ id: 'evt_b', cancelledAt: tCancel }]),
        },
        financialLedgerEntry: {
          findMany: vi.fn().mockResolvedValueOnce([
            {
              id: 'd1',
              type: LedgerEntryType.TICKET_SALE_CLEARED,
              balanceType: LedgerBalanceType.AVAILABLE,
              amountInCents: 8000,
              eventId: 'evt_b',
              transferId: null,
              createdAt: t1,
            },
            {
              id: 'd2',
              type: LedgerEntryType.TICKET_SALE_CLEARED,
              balanceType: LedgerBalanceType.AVAILABLE,
              amountInCents: 10000,
              eventId: 'evt_a',
              transferId: null,
              createdAt: t2,
            },
            {
              id: 'd3',
              type: LedgerEntryType.TRANSFER_INITIATED,
              balanceType: LedgerBalanceType.AVAILABLE,
              amountInCents: -10000,
              eventId: null,
              transferId: 'tr_after_cancel',
              createdAt: t4, // AFTER tCancel
            },
          ]),
        },
      };
      // Post-cancel withdrawal of 10000 came solely from evt_a; evt_b remains 8000 held
      expect(await computeCancelledEventHeldAvailableInCents(mockPostCancelWithdraw, 'org_d')).toBe(8000);

      // Case E: Active Event A withdrawn BEFORE Event B settled -> Event B still holds 8000
      const mockPriorActiveWithdraw: any = {
        event: {
          findMany: vi.fn().mockResolvedValueOnce([{ id: 'evt_b', cancelledAt: tCancel }]),
        },
        financialLedgerEntry: {
          findMany: vi.fn().mockResolvedValueOnce([
            {
              id: 'e1',
              type: LedgerEntryType.TICKET_SALE_CLEARED,
              balanceType: LedgerBalanceType.AVAILABLE,
              amountInCents: 10000,
              eventId: 'evt_a',
              transferId: null,
              createdAt: t1,
            },
            {
              id: 'e2',
              type: LedgerEntryType.TRANSFER_INITIATED,
              balanceType: LedgerBalanceType.AVAILABLE,
              amountInCents: -10000,
              eventId: null,
              transferId: 'tr_a_only',
              createdAt: t2,
            },
            {
              id: 'e3',
              type: LedgerEntryType.TICKET_SALE_CLEARED,
              balanceType: LedgerBalanceType.AVAILABLE,
              amountInCents: 8000,
              eventId: 'evt_b',
              transferId: null,
              createdAt: new Date(t2.getTime() + 1000),
            },
          ]),
        },
      };
      expect(await computeCancelledEventHeldAvailableInCents(mockPriorActiveWithdraw, 'org_e')).toBe(8000);

      // Case F: Post-transfer refund creating RECOVERABLE liability (no double deduction)
      const mockRecoverableNoDouble: any = {
        event: {
          findMany: vi.fn().mockResolvedValueOnce([{ id: 'evt_b', cancelledAt: tCancel }]),
        },
        financialLedgerEntry: {
          findMany: vi.fn().mockResolvedValueOnce([
            {
              id: 'r1',
              type: LedgerEntryType.TICKET_SALE_CLEARED,
              balanceType: LedgerBalanceType.AVAILABLE,
              amountInCents: 8000,
              eventId: 'evt_b',
              transferId: null,
              createdAt: t1,
            },
            {
              id: 'r2',
              type: LedgerEntryType.TRANSFER_INITIATED,
              balanceType: LedgerBalanceType.AVAILABLE,
              amountInCents: -8000,
              eventId: null,
              transferId: 'tr_r1',
              createdAt: t2,
            },
            {
              id: 'r3',
              type: LedgerEntryType.REFUND_POST_TRANSFER,
              balanceType: LedgerBalanceType.RECOVERABLE,
              amountInCents: -8299,
              eventId: 'evt_b',
              transferId: null,
              createdAt: t4,
            },
            {
              id: 'r4',
              type: LedgerEntryType.TICKET_SALE_CLEARED,
              balanceType: LedgerBalanceType.AVAILABLE,
              amountInCents: 10000,
              eventId: 'evt_a',
              transferId: null,
              createdAt: t5,
            },
          ]),
        },
      };
      expect(await computeCancelledEventHeldAvailableInCents(mockRecoverableNoDouble, 'org_f')).toBe(0);

      // Case G: MANUALLY_RESOLVED NO_REFUND_NEEDED (no refund ledger entry) keeps unwithdrawn 8000 held,
      // and pooled liability recovery ADJUSTMENT deducts active Event A before touching cancelled Event B
      const mockLiabilityAndManualNoRefund: any = {
        event: {
          findMany: vi.fn().mockResolvedValueOnce([{ id: 'evt_b', cancelledAt: tCancel }]),
        },
        financialLedgerEntry: {
          findMany: vi.fn().mockResolvedValueOnce([
            {
              id: 'g1',
              type: LedgerEntryType.TICKET_SALE_CLEARED,
              balanceType: LedgerBalanceType.AVAILABLE,
              amountInCents: 8000,
              eventId: 'evt_b',
              transferId: null,
              createdAt: t1,
            },
            {
              id: 'g2',
              type: LedgerEntryType.TICKET_SALE_CLEARED,
              balanceType: LedgerBalanceType.AVAILABLE,
              amountInCents: 10000,
              eventId: 'evt_a',
              transferId: null,
              createdAt: t2,
            },
            {
              id: 'g3',
              type: LedgerEntryType.ADJUSTMENT,
              balanceType: LedgerBalanceType.AVAILABLE,
              amountInCents: -1200,
              eventId: null,
              transferId: null,
              createdAt: t4,
            },
          ]),
        },
      };
      // Liability adjustment (-1200) deducts from unheld Event A (10000 -> 8800); Event B stays 8000 held
      expect(await computeCancelledEventHeldAvailableInCents(mockLiabilityAndManualNoRefund, 'org_g')).toBe(8000);
    });

    it('blocks unpublishEvent on CANCELLED single events (upfront and concurrent race) with 409 EVENT_CANCELLED while preserving unpublishSeries', async () => {
      // 1. Direct unpublish on CANCELLED event
      vi.spyOn(prisma.event, 'findUnique').mockResolvedValueOnce({
        id: 'evt_unpub_1',
        organizerId: 'org_u1',
        status: EventStatus.CANCELLED,
        seriesId: null,
      } as any);
      const next1 = vi.fn();
      await unpublishEvent(
        {
          user: { userId: 'org_u1', role: Role.ORGANIZER, email: 'org@example.com' },
          params: { id: 'evt_unpub_1' },
          query: {},
          body: {},
        } as any,
        createMockRes(),
        next1
      );
      expect(next1).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: 409, code: 'EVENT_CANCELLED' })
      );

      // 2. Concurrent race: findUnique saw PUBLISHED, concurrent cancel ran before updateMany
      vi.spyOn(prisma.event, 'findUnique').mockResolvedValueOnce({
        id: 'evt_unpub_race',
        organizerId: 'org_u1',
        status: EventStatus.PUBLISHED,
        seriesId: null,
      } as any);
      const updateManySpy = vi
        .spyOn(prisma.event, 'updateMany')
        .mockResolvedValueOnce({ count: 0 } as any);
      const nextRace = vi.fn();
      await unpublishEvent(
        {
          user: { userId: 'org_u1', role: Role.ORGANIZER, email: 'org@example.com' },
          params: { id: 'evt_unpub_race' },
          query: {},
          body: {},
        } as any,
        createMockRes(),
        nextRace
      );
      expect(updateManySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'evt_unpub_race', status: { not: EventStatus.CANCELLED } },
          data: { status: EventStatus.DRAFT },
        })
      );
      expect(nextRace).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: 409, code: 'EVENT_CANCELLED' })
      );

      // 3. Series unpublish excludes CANCELLED occurrences (where status: PUBLISHED)
      vi.spyOn(prisma.event, 'findUnique')
        .mockResolvedValueOnce({
          id: 'evt_ser_1',
          organizerId: 'org_u1',
          status: EventStatus.PUBLISHED,
          seriesId: 'series_u1',
        } as any)
        .mockResolvedValueOnce({
          id: 'evt_ser_1',
          status: EventStatus.DRAFT,
          ticketTiers: [],
        } as any);
      const seriesUpdateSpy = vi
        .spyOn(prisma.event, 'updateMany')
        .mockResolvedValueOnce({ count: 2 } as any);
      const resSeries = createMockRes();
      await unpublishEvent(
        {
          user: { userId: 'org_u1', role: Role.ORGANIZER, email: 'org@example.com' },
          params: { id: 'evt_ser_1' },
          query: { unpublishSeries: 'true' },
          body: {},
        } as any,
        resSeries,
        vi.fn()
      );
      expect(seriesUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: EventStatus.PUBLISHED }),
          data: { status: EventStatus.DRAFT },
        })
      );
      expect(resSeries.body.success).toBe(true);
    });

    it('blocks updateOrganizerEvent with applyToFuture=true from reverting cancelled future occurrences to DRAFT or PUBLISHED and preserves non-status metadata updates', async () => {
      const startPrimary = new Date('2026-12-01T20:00:00.000Z');
      const startOcc2 = new Date('2026-12-08T20:00:00.000Z');
      const existingPrimary = {
        id: 'evt_p1',
        organizerId: 'org_s1',
        seriesId: 'ser_s1',
        status: EventStatus.PUBLISHED,
        startAt: startPrimary,
        endAt: new Date('2026-12-01T23:00:00.000Z'),
        coverImageUrl: 'https://example.com/c.jpg',
        coverImagePublicId: null,
        payoutDetailsId: null,
        ticketTiers: [{ id: 'tier_1', priceInCents: 0 }],
        galleryImages: [],
        features: [],
      };

      // Reject applyToFuture status: DRAFT AND PUBLISHED when an upcoming occurrence is CANCELLED
      for (const requestedStatus of [EventStatus.DRAFT, EventStatus.PUBLISHED]) {
        vi.spyOn(prisma.event, 'findUnique').mockResolvedValueOnce(existingPrimary as any);
        const txReject: any = {
          $queryRaw: vi
            .fn()
            .mockResolvedValueOnce([{ id: 'ser_s1' }]) // EventSeries FOR UPDATE
            .mockResolvedValueOnce([
              { id: 'evt_p1', status: EventStatus.PUBLISHED, startAt: startPrimary },
              { id: 'evt_p2', status: EventStatus.CANCELLED, startAt: startOcc2 },
            ]),
          event: {
            findMany: vi.fn().mockResolvedValueOnce([
              {
                id: 'evt_p2',
                status: EventStatus.CANCELLED,
                startAt: startOcc2,
                coverImageUrl: 'https://example.com/c.jpg',
                ticketTiers: [],
              },
            ]),
            updateMany: vi.fn(),
          },
        };
        vi.spyOn(prisma, '$transaction').mockImplementationOnce(async (cb: any) => cb(txReject));

        const nextErr = vi.fn();
        await updateOrganizerEvent(
          {
            user: { userId: 'org_s1', role: Role.ORGANIZER, email: 'org@example.com' },
            params: { id: 'evt_p1' },
            body: { applyToFuture: true, status: requestedStatus },
          } as any,
          createMockRes(),
          nextErr
        );
        expect(nextErr).toHaveBeenCalledWith(
          expect.objectContaining({ statusCode: 409, code: 'EVENT_CANCELLED' })
        );
        expect(txReject.event.updateMany).not.toHaveBeenCalled();
      }

      // Non-status metadata + tier update on series keeps cancelled occurrence CANCELLED and never churns its tiers
      vi.spyOn(prisma.event, 'findUnique').mockResolvedValueOnce(existingPrimary as any);
      const occUpdateSpy = vi.fn().mockResolvedValue({});
      const occTierDeleteSpy = vi.fn();
      const occTierCreateSpy = vi.fn();
      const txMeta: any = {
        $queryRaw: vi
          .fn()
          .mockResolvedValueOnce([{ id: 'ser_s1' }])
          .mockResolvedValueOnce([
            { id: 'evt_p1', status: EventStatus.PUBLISHED, startAt: startPrimary },
            { id: 'evt_p2', status: EventStatus.CANCELLED, startAt: startOcc2 },
          ]),
        eventSeries: { update: vi.fn().mockResolvedValue({}) },
        ticketTier: {
          update: vi.fn().mockResolvedValue({}),
          deleteMany: occTierDeleteSpy,
          createMany: occTierCreateSpy,
        },
        event: {
          findMany: vi.fn().mockResolvedValueOnce([
            {
              id: 'evt_p2',
              status: EventStatus.CANCELLED,
              startAt: startOcc2,
              coverImageUrl: 'https://example.com/c.jpg',
              ticketTiers: [{ id: 'occ_tier_old', soldQuantity: 0 }],
            },
          ]),
          update: occUpdateSpy,
          findUnique: vi.fn().mockResolvedValueOnce({ ...existingPrimary, title: 'Updated Title', ticketTiers: [] }),
        },
      };
      vi.spyOn(prisma, '$transaction').mockImplementationOnce(async (cb: any) => cb(txMeta));

      const resMeta = createMockRes();
      await updateOrganizerEvent(
        {
          user: { userId: 'org_s1', role: Role.ORGANIZER, email: 'org@example.com' },
          params: { id: 'evt_p1' },
          body: {
            applyToFuture: true,
            title: 'Updated Title',
            ticketTiers: [{ id: 'tier_1', name: 'Free GA', priceInCents: 0, totalCapacity: 100 }],
          },
        } as any,
        resMeta,
        vi.fn()
      );
      expect(resMeta.body.success).toBe(true);
      expect(occUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'evt_p2' },
          data: expect.not.objectContaining({ status: expect.anything() }),
        })
      );
      expect(occTierDeleteSpy).not.toHaveBeenCalled();
      expect(occTierCreateSpy).not.toHaveBeenCalled();
    });

    it('resolves upcoming series occurrences inside the transaction under EventSeries -> Event locks in cancelOrganizerSeries', async () => {
      vi.spyOn(prisma.eventSeries, 'findUnique').mockResolvedValueOnce({
        id: 'ser_lock_1',
        organizerId: 'org_l1',
      } as any);

      const txSeriesMock: any = {
        $queryRaw: vi
          .fn()
          .mockResolvedValueOnce([{ id: 'ser_lock_1', organizerId: 'org_l1' }]) // EventSeries FOR UPDATE
          .mockResolvedValueOnce([{ id: 'evt_occ_1' }, { id: 'evt_occ_2' }]) // Upcoming Event IDs FOR UPDATE
          .mockResolvedValueOnce([
            { id: 'evt_occ_1', status: EventStatus.PUBLISHED, organizerId: 'org_l1', title: 'Occ 1', startAt: new Date() },
            { id: 'evt_occ_2', status: EventStatus.PUBLISHED, organizerId: 'org_l1', title: 'Occ 2', startAt: new Date() },
          ]) // executeEventCancellationInTx Event FOR UPDATE
          .mockResolvedValueOnce([]) // PENDING orders
          .mockResolvedValueOnce([]), // OrganizerBalance FOR UPDATE
        financialLedgerEntry: {
          findFirst: vi.fn().mockResolvedValueOnce(null),
          findMany: vi.fn().mockResolvedValueOnce([]),
        },
        event: { updateMany: vi.fn().mockResolvedValueOnce({ count: 2 }) },
        ticketReservation: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        organizerBalance: { findMany: vi.fn().mockResolvedValueOnce([]) },
        user: { findMany: vi.fn().mockResolvedValueOnce([{ id: 'org_l1', email: 'org@example.com', name: 'Org' }]) },
        order: {
          groupBy: vi.fn().mockResolvedValueOnce([]),
          findMany: vi.fn().mockResolvedValueOnce([]),
        },
        emailOutbox: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
        adminAuditLog: { create: vi.fn().mockResolvedValueOnce({ id: 'aud_ser_1' }) },
      };

      vi.spyOn(waitlistService, 'cancelWaitlistForEventIds').mockResolvedValueOnce(undefined);
      vi.spyOn(prisma, '$transaction').mockImplementationOnce(async (cb: any) => cb(txSeriesMock));

      const res = createMockRes();
      await cancelOrganizerSeries(
        {
          user: { userId: 'org_l1', role: Role.ORGANIZER, email: 'org@example.com' },
          params: { id: 'ser_lock_1' },
          body: { reason: 'Season cancelled' },
        } as any,
        res,
        vi.fn()
      );
      expect(res.body.success).toBe(true);
      expect(res.body.data.cancelledCount).toBe(2);
    });

    it('attributes DISPUTE_LOST and subsequent pooled AVAILABLE_BALANCE liability recovery strictly to the disputed event without draining another cancelled event hold or active event earnings', async () => {
      const t1 = new Date('2026-11-01T10:00:00.000Z');
      const t2 = new Date('2026-11-02T10:00:00.000Z');
      const tCancelB = new Date('2026-11-03T10:00:00.000Z');
      const tCancelC = new Date('2026-11-03T11:00:00.000Z');
      const t4 = new Date('2026-11-04T10:00:00.000Z');
      const t5 = new Date('2026-11-05T10:00:00.000Z');

      const baseSaleAndDispute = [
        {
          id: 'dl_1',
          type: LedgerEntryType.TICKET_SALE_CLEARED,
          balanceType: LedgerBalanceType.AVAILABLE,
          amountInCents: 8000,
          eventId: 'evt_b',
          transferId: null,
          createdAt: t1,
        },
        {
          id: 'dl_2',
          type: LedgerEntryType.TICKET_SALE_CLEARED,
          balanceType: LedgerBalanceType.AVAILABLE,
          amountInCents: 10000,
          eventId: 'evt_c',
          transferId: null,
          createdAt: t2,
        },
        {
          id: 'dl_3',
          type: LedgerEntryType.DISPUTE_LOST,
          balanceType: LedgerBalanceType.RECOVERABLE,
          amountInCents: -8000,
          eventId: 'evt_b',
          transferId: null,
          createdAt: t4,
        },
      ];

      // Before recovery: available=18000, totalRecoverable=8000, hold(B)=0 shadowed, hold(C)=10000 -> totalHold=10000
      const mockBeforeRecovery: any = {
        event: {
          findMany: vi.fn().mockResolvedValueOnce([
            { id: 'evt_b', cancelledAt: tCancelB },
            { id: 'evt_c', cancelledAt: tCancelC },
          ]),
        },
        financialLedgerEntry: {
          findMany: vi.fn().mockResolvedValueOnce(baseSaleAndDispute),
        },
      };
      expect(await computeCancelledEventHeldAvailableInCents(mockBeforeRecovery, 'org_bc1')).toBe(10000);

      // After AVAILABLE_BALANCE liability recovery (-8000 AVAILABLE + 8000 RECOVERABLE):
      // B settles its own 8000 debt (pool[B]=0), preserving C's entire 10000 hold untouched;
      // Active Event A's 5000 remains 100% withdrawable (netAvailable = 5000).
      const entriesAfterRecovery = [
        ...baseSaleAndDispute,
        {
          id: 'dl_4',
          type: LedgerEntryType.TICKET_SALE_CLEARED,
          balanceType: LedgerBalanceType.AVAILABLE,
          amountInCents: 5000,
          eventId: 'evt_a',
          transferId: null,
          createdAt: t5,
        },
        {
          id: 'dl_5',
          type: LedgerEntryType.ADJUSTMENT,
          balanceType: LedgerBalanceType.AVAILABLE,
          amountInCents: -8000,
          eventId: null,
          transferId: null,
          createdAt: t5,
        },
        {
          id: 'dl_6',
          type: LedgerEntryType.ADJUSTMENT,
          balanceType: LedgerBalanceType.RECOVERABLE,
          amountInCents: 8000,
          eventId: null,
          transferId: null,
          createdAt: t5,
        },
      ];

      vi.spyOn(prisma.organizerBalance, 'findUnique').mockResolvedValueOnce({
        userId: 'org_bc1',
        currency: 'USD',
        pendingBalanceInCents: 0,
        availableBalanceInCents: 15000, // 8000 + 10000 + 5000 - 8000
        transferredBalanceInCents: 0,
        updatedAt: new Date(),
      } as any);
      vi.spyOn(prisma.event, 'findMany').mockResolvedValueOnce([
        { id: 'evt_b', cancelledAt: tCancelB } as any,
        { id: 'evt_c', cancelledAt: tCancelC } as any,
      ]);
      vi.spyOn(prisma.financialLedgerEntry, 'findMany')
        .mockResolvedValueOnce([
          { amountInCents: -8000 },
          { amountInCents: 8000 },
        ] as any) // net RECOVERABLE = 0
        .mockResolvedValueOnce(entriesAfterRecovery as any)
        .mockResolvedValueOnce([]);

      const summaryAfter = await getOrganizerFinancialSummary('org_bc1');
      expect(summaryAfter.availableInCents).toBe(15000);
      expect(summaryAfter.recoverableInCents).toBe(0);
      expect(summaryAfter.cancelledEventHoldInCents).toBe(10000);
      expect(summaryAfter.netAvailableInCents).toBe(5000);

      // EXTERNAL_RECOVERY (+8000 RECOVERABLE only, available untouched at 18000):
      // B's 8000 remains unrefunded in OrganizerBalance, so B (8000) + C (10000) = 18000 held!
      const mockExternalRecovery: any = {
        event: {
          findMany: vi.fn().mockResolvedValueOnce([
            { id: 'evt_b', cancelledAt: tCancelB },
            { id: 'evt_c', cancelledAt: tCancelC },
          ]),
        },
        financialLedgerEntry: {
          findMany: vi.fn().mockResolvedValueOnce([
            ...baseSaleAndDispute,
            {
              id: 'dl_ext',
              type: LedgerEntryType.ADJUSTMENT,
              balanceType: LedgerBalanceType.RECOVERABLE,
              amountInCents: 8000,
              eventId: null,
              transferId: null,
              createdAt: t5,
            },
          ]),
        },
      };
      expect(await computeCancelledEventHeldAvailableInCents(mockExternalRecovery, 'org_bc1')).toBe(18000);
    });

    it('blocks direct generateTicketsPdf calls when order.event.status is CANCELLED', async () => {
      await expect(
        generateTicketsPdf({
          orderNumber: 'OUT-PDF-CANCEL',
          createdAt: new Date(),
          customerName: 'Buyer',
          customerEmail: 'buyer@example.com',
          event: {
            title: 'Cancelled Night',
            status: EventStatus.CANCELLED,
            category: 'MUSIC',
            startAt: new Date(),
          },
          tickets: [
            {
              id: 'tkt_1',
              ticketToken: 'tkt_tok_1',
              status: TicketStatus.ISSUED,
            },
          ],
        })
      ).rejects.toMatchObject({
        statusCode: 400,
        code: 'EVENT_CANCELLED_NO_ADMISSION_PASSES',
      });
    });
  });
});
