import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  EventStatus,
  LedgerBalanceType,
  LedgerEntryType,
  OrderRefundKind,
  OrderRefundStatus,
  OrderRefundTicketLockState,
  OrderStatus,
  RefundFeeBearer,
  RefundInitiatorRole,
  Role,
  StripeSettlementStatus,
  TicketStatus,
  TicketTierStatus,
} from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { getRedisClient } from '../lib/redis.js';
import { checkInTicket } from '../modules/organizer/organizer.controller.js';
import {
  filterEligiblePdfTickets,
  generateTicketsPdf,
  isTicketAdmissionEligible,
} from '../modules/orders/ticketPdf.service.js';
import {
  downloadOrderTicketsPdf,
  getOrderByOrderNumber,
} from '../modules/orders/orders.controller.js';
import {
  getOrganizerFinancialSummary,
  recordTicketRefundLedgerInTx,
  settleOrderEarnings,
} from '../modules/finance/ledger.service.js';
import { executeWithdrawal } from '../modules/finance/transfer.service.js';
import {
  cancelTicketRefundInTx,
  confirmTicketRefundSucceededInTx,
  executeLocalFreeTicketCancellationInTx,
  initiateTicketRefundInTx,
  triggerPostCommitWaitlistAdvancement,
} from '../modules/refunds/refundAdmissionState.service.js';
import { allocateOrderTicketPayments } from '../modules/refunds/refundAllocation.domain.js';
import { calculateCheckoutFeeBreakdown } from '../modules/checkout/checkout.financials.js';
import * as waitlistService from '../modules/waitlist/waitlist.service.js';

function createMockRes() {
  const headers = new Map<string, string>();
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
    setHeader(k: string, v: string) {
      headers.set(k.toLowerCase(), String(v));
      return this;
    },
    send(payload: any) {
      this.body = payload;
      return this;
    },
    headers,
  };
  return res;
}

describe('Stage 4 P0-03 Workstream C — Admission, PDF/QR & Accounting Foundation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('1. Check-in / Refund concurrency serialization & stale Redis protection', () => {
    it('prevents stale Redis COMPLETED 200 replay after a ticket transitions to REFUND_PENDING or REFUNDED', async () => {
      const redis = getRedisClient();
      const scannerUserId = 'org_stale_1';
      const idemKey = `idem_stale_${Date.now()}`;
      const redisKey = `checkin_idem:${scannerUserId}:${idemKey}`;

      await redis.setNxPx(
        redisKey,
        JSON.stringify({
          lockId: 'lock_old',
          scannerUserId,
          token: 'tkt_sec_stale_token_1234',
          eventId: '',
          resolvedEventId: 'evt_stale_1',
          authorizedVia: 'OWNER',
          ticketId: 'tkt_stale_1',
          status: 'COMPLETED',
          responseStatus: 200,
          responseBody: {
            success: true,
            data: {
              result: 'SUCCESS',
              message: 'Valid admission pass verified.',
              ticket: { id: 'tkt_stale_1' },
            },
          },
          createdAt: Date.now(),
        }),
        60_000
      );

      // DB shows ticket is now REFUND_PENDING despite cached Redis 200 SUCCESS
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValueOnce({ id: 'evt_stale_1' } as any);
      vi.spyOn(prisma.ticket, 'findUnique').mockResolvedValueOnce({
        id: 'tkt_stale_1',
        eventId: 'evt_stale_1',
        ticketToken: 'tkt_sec_stale_token_1234',
        status: TicketStatus.REFUND_PENDING,
        order: { status: OrderStatus.COMPLETED },
      } as any);
      const logSpy = vi.spyOn(prisma.checkInLog, 'create').mockResolvedValueOnce({ id: 'log_1' } as any);

      const req: any = {
        user: { userId: scannerUserId, role: Role.ORGANIZER, email: 'org@outside.vip' },
        headers: { 'idempotency-key': idemKey },
        body: { token: 'tkt_sec_stale_token_1234' },
      };
      const res = createMockRes();
      const next = vi.fn();

      await checkInTicket(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(400);
      expect(res.body.data.result).toBe('REFUND_PENDING_TICKET');
      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ result: 'REFUND_PENDING_TICKET' }),
        })
      );
      // Stale Redis cache entry must be purged
      expect(await redis.get(redisKey)).toBeNull();
    });

    it('serializes check-in inside a DB transaction locking Order FOR SHARE -> Ticket FOR UPDATE and rejects raced REFUND_PENDING instead of ALREADY_CHECKED_IN', async () => {
      vi.spyOn(prisma.ticket, 'findUnique').mockResolvedValueOnce({
        id: 'tkt_race_1',
        orderId: 'ord_race_1',
        eventId: 'evt_race_1',
        ticketToken: 'tkt_sec_race_token_1234',
        attendeeName: 'Buyer Race',
        attendeeEmail: 'buyer@outside.vip',
        status: TicketStatus.ISSUED, // Read ISSUED before tx lock
        checkedInAt: null,
        checkedInByUserId: null,
        event: {
          id: 'evt_race_1',
          slug: 'evt-race',
          title: 'Race Event',
          organizerId: 'org_race_1',
          timezone: 'UTC',
          startAt: new Date(Date.now() - 3600_000),
          endAt: new Date(Date.now() + 3600_000),
        },
        ticketTier: { name: 'GA', validityStartAt: null, validityEndAt: null },
        order: {
          orderNumber: 'OUT-RACE-1',
          status: OrderStatus.COMPLETED,
          customerName: 'Buyer Race',
          customerEmail: 'buyer@outside.vip',
        },
        checkedInByUser: null,
      } as any);

      // Inside transaction lock, concurrent refund already transitioned Ticket -> REFUND_PENDING
      const txQueries: string[] = [];
      const txMock: any = {
        $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
          const sql = strings.join(' ');
          txQueries.push(sql);
          if (sql.includes('FROM "Order"')) {
            return [{ status: OrderStatus.COMPLETED }];
          }
          if (sql.includes('FROM "Ticket"')) {
            return [
              {
                id: 'tkt_race_1',
                status: TicketStatus.REFUND_PENDING,
                checkedInAt: null,
                checkedInByUserId: null,
              },
            ];
          }
          return [];
        }),
        ticket: { update: vi.fn() },
        checkInLog: { create: vi.fn().mockResolvedValueOnce({ id: 'log_race_1' }) },
      };

      vi.spyOn(prisma, '$transaction').mockImplementationOnce(async (cb: any) => cb(txMock));

      const req: any = {
        user: { userId: 'org_race_1', role: Role.ORGANIZER, email: 'org@outside.vip' },
        headers: {},
        body: { token: 'tkt_sec_race_token_1234' },
      };
      const res = createMockRes();
      const next = vi.fn();

      await checkInTicket(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(400);
      expect(res.body.data.result).toBe('REFUND_PENDING_TICKET');
      expect(txMock.ticket.update).not.toHaveBeenCalled();
      // Canonical lock order check: Order FOR SHARE before Ticket FOR UPDATE
      expect(txQueries[0]).toContain('FROM "Order"');
      expect(txQueries[0]).toContain('FOR SHARE');
      expect(txQueries[1]).toContain('FROM "Ticket"');
      expect(txQueries[1]).toContain('FOR UPDATE');
    });

    it('enforces organizer block on checked-in refunds and explicit reasoned+audited ADMIN override + cancel restoration', async () => {
      const checkedInAt = new Date('2026-11-24T22:00:00.000Z');
      const checkout = calculateCheckoutFeeBreakdown([{ priceInCents: 2000, quantity: 1 }]);
      const alloc = allocateOrderTicketPayments(
        { buyerTotalInCents: checkout.buyerTotalInCents },
        [{ ticketId: 'tkt_ci_1', ticketTierId: 'tier_1', grossPriceInCents: 2000 }]
      ).tickets[0];

      const makeTx = () => ({
        $queryRaw: vi
          .fn()
          .mockResolvedValueOnce([
            {
              id: 'ord_ci_1',
              status: OrderStatus.COMPLETED,
              totalInCents: checkout.buyerTotalInCents,
              refundedAmountInCents: 0,
              pendingRefundAmountInCents: 0,
              currency: 'USD',
              orderNumber: 'OUT-CI-1',
            },
          ])
          .mockResolvedValueOnce([
            {
              id: 'tkt_ci_1',
              orderId: 'ord_ci_1',
              ticketTierId: 'tier_1',
              status: TicketStatus.CHECKED_IN,
              checkedInAt,
              allocatedGrossInCents: alloc.allocatedGrossInCents,
              allocatedPlatformFeeInCents: alloc.allocatedPlatformFeeInCents,
              allocatedServiceFeeInCents: alloc.allocatedServiceFeeInCents,
              allocatedProcessingFeeInCents: alloc.allocatedProcessingFeeInCents,
              allocatedBuyerTotalInCents: alloc.allocatedBuyerTotalInCents,
              createdAt: new Date(),
            },
          ]),
        orderRefund: {
          findUnique: vi.fn().mockResolvedValueOnce(null),
          create: vi.fn().mockResolvedValueOnce({
            id: 'ref_ci_admin_1',
            orderId: 'ord_ci_1',
            amountInCents: checkout.buyerTotalInCents - alloc.allocatedProcessingFeeInCents,
          }),
        },
        orderRefundTicket: { findMany: vi.fn().mockResolvedValueOnce([]) },
        order: {
          findUnique: vi.fn().mockResolvedValueOnce({
            id: 'ord_ci_1',
            totalInCents: checkout.buyerTotalInCents,
            items: [{ ticketTierId: 'tier_1', unitPriceInCents: 2000 }],
            tickets: [{ id: 'tkt_ci_1', ticketTierId: 'tier_1', ...alloc }],
          }),
          update: vi.fn().mockResolvedValueOnce({}),
        },
        ticket: { updateMany: vi.fn().mockResolvedValueOnce({ count: 1 }) },
        adminAuditLog: { create: vi.fn().mockResolvedValueOnce({ id: 'audit_1' }) },
      });

      // Organizer blocked from overriding CHECKED_IN
      await expect(
        initiateTicketRefundInTx(makeTx() as any, {
          orderId: 'ord_ci_1',
          ticketIds: ['tkt_ci_1'],
          idempotencyKey: 'idem_org_ci_block',
          stripePaymentIntentId: 'pi_ci_1',
          initiatorRole: RefundInitiatorRole.ORGANIZER,
          initiatedByUserId: 'org_1',
          reason: 'Organizer attempt',
          feeBearer: RefundFeeBearer.ORGANIZER,
          allowCheckedInOverride: true,
          overrideReason: 'Should still fail for non-admin',
        })
      ).rejects.toThrow(/already checked in/);

      // Admin without overrideReason blocked
      await expect(
        initiateTicketRefundInTx(makeTx() as any, {
          orderId: 'ord_ci_1',
          ticketIds: ['tkt_ci_1'],
          idempotencyKey: 'idem_admin_no_reason',
          stripePaymentIntentId: 'pi_ci_1',
          initiatorRole: RefundInitiatorRole.ADMIN,
          initiatedByUserId: 'adm_1',
          reason: 'Dispute prevention',
          feeBearer: RefundFeeBearer.PLATFORM,
          allowCheckedInOverride: true,
          overrideReason: 'ok', // < 5 chars
        })
      ).rejects.toThrow(/overrideReason/);

      // Valid Admin override succeeds, locks ticket as REFUND_PENDING, and writes AdminAuditLog
      const txAdmin = makeTx();
      const initiated = await initiateTicketRefundInTx(txAdmin as any, {
        orderId: 'ord_ci_1',
        ticketIds: ['tkt_ci_1'],
        idempotencyKey: 'idem_admin_ok',
        stripePaymentIntentId: 'pi_ci_1',
        initiatorRole: RefundInitiatorRole.ADMIN,
        initiatedByUserId: 'adm_1',
        initiatedByEmail: 'admin@outside.vip',
        reason: 'Fraudulent gate scan compensation',
        feeBearer: RefundFeeBearer.PLATFORM,
        allowCheckedInOverride: true,
        overrideReason: 'Verified scanner false-positive at VIP gate',
      });

      expect(initiated.created).toBe(true);
      expect(initiated.checkedInOverrideAudited).toBe(true);
      expect(txAdmin.adminAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'ADMIN_REFUND_CHECKED_IN_TICKET_OVERRIDE',
            targetId: 'ref_ci_admin_1',
          }),
        })
      );

      // If definitively cancelled prior to Stripe confirmation, ticket restores back to CHECKED_IN (not ISSUED)
      const cancelTx: any = {
        orderRefund: {
          findUnique: vi.fn().mockResolvedValueOnce({ id: 'ref_ci_admin_1', orderId: 'ord_ci_1' }),
          update: vi.fn().mockResolvedValueOnce({
            id: 'ref_ci_admin_1',
            status: OrderRefundStatus.CANCELLED,
          }),
        },
        $queryRaw: vi
          .fn()
          .mockResolvedValueOnce([{ id: 'ord_ci_1', pendingRefundAmountInCents: 2295 }])
          .mockResolvedValueOnce([{ id: 'tkt_ci_1', checkedInAt }])
          .mockResolvedValueOnce([
            {
              id: 'ref_ci_admin_1',
              orderId: 'ord_ci_1',
              status: OrderRefundStatus.PENDING,
              amountInCents: 2295,
            },
          ]),
        orderRefundTicket: {
          findMany: vi.fn().mockResolvedValueOnce([{ ticketId: 'tkt_ci_1' }]),
          updateMany: vi.fn().mockResolvedValueOnce({ count: 1 }),
        },
        ticket: { update: vi.fn().mockResolvedValueOnce({}) },
        order: { update: vi.fn().mockResolvedValueOnce({}) },
      };

      const cancelled = await cancelTicketRefundInTx(cancelTx, {
        orderRefundId: 'ref_ci_admin_1',
        cancellationReason: 'Stripe refund aborted by operator',
      });

      expect(cancelled.alreadyCancelled).toBe(false);
      expect(cancelTx.ticket.update).toHaveBeenCalledWith({
        where: { id: 'tkt_ci_1' },
        data: { status: TicketStatus.CHECKED_IN },
      });
    });
  });

  describe('2. PDF, QR & Confirmation-Page Eligibility', () => {
    it('excludes REFUND_PENDING, REFUNDED, and CANCELLED tickets from PDF generation and QRs while allowing active partial passes', async () => {
      expect(isTicketAdmissionEligible(TicketStatus.ISSUED)).toBe(true);
      expect(isTicketAdmissionEligible(TicketStatus.CHECKED_IN)).toBe(true);
      expect(isTicketAdmissionEligible(TicketStatus.REFUND_PENDING)).toBe(false);
      expect(isTicketAdmissionEligible(TicketStatus.REFUNDED)).toBe(false);
      expect(isTicketAdmissionEligible(TicketStatus.CANCELLED)).toBe(false);

      const tickets = [
        { id: 't_issued', ticketToken: 'tkt_sec_issued_111', status: TicketStatus.ISSUED, ticketTier: { id: 'tr1', name: 'GA', priceInCents: 2000 } },
        { id: 't_pending', ticketToken: 'tkt_sec_pending_222', status: TicketStatus.REFUND_PENDING, ticketTier: { id: 'tr1', name: 'GA', priceInCents: 2000 } },
        { id: 't_refunded', ticketToken: 'tkt_sec_refunded_333', status: TicketStatus.REFUNDED, ticketTier: { id: 'tr1', name: 'GA', priceInCents: 2000 } },
        { id: 't_cancelled', ticketToken: 'tkt_sec_cancel_444', status: TicketStatus.CANCELLED, ticketTier: { id: 'tr1', name: 'GA', priceInCents: 2000 } },
      ];

      expect(filterEligiblePdfTickets(tickets).map((t) => t.id)).toEqual(['t_issued']);
      expect(filterEligiblePdfTickets(tickets, 't_pending')).toEqual([]);
      expect(filterEligiblePdfTickets(tickets, 't_refunded')).toEqual([]);

      const partialPdf = await generateTicketsPdf({
        orderNumber: 'OUT-PARTIAL-PDF',
        createdAt: new Date(),
        customerName: 'Buyer',
        customerEmail: 'buyer@outside.vip',
        event: {
          title: 'Partial PDF Event',
          category: 'MUSIC',
          startAt: new Date(),
        },
        tickets,
      });
      expect(partialPdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');

      await expect(
        generateTicketsPdf({
          orderNumber: 'OUT-NONE-PDF',
          createdAt: new Date(),
          customerName: 'Buyer',
          customerEmail: 'buyer@outside.vip',
          event: { title: 'No Passes', category: 'MUSIC', startAt: new Date() },
          tickets: tickets.slice(1), // all ineligible
        })
      ).rejects.toThrow(/No eligible admission tickets/);
    });

    it('redacts tokens for REFUND_PENDING/REFUNDED/CANCELLED in confirmation response and blocks ineligible single-ticket PDF downloads', async () => {
      const mockOrder = {
        id: 'ord_conf_1',
        orderNumber: 'OUT-CONF-1',
        userId: 'usr_buyer_1',
        orderAccessToken: 'oat_secret_token',
        status: OrderStatus.COMPLETED,
        customerName: 'Buyer',
        customerEmail: 'buyer@outside.vip',
        customerPhone: null,
        marketingConsent: false,
        marketingConsentAt: null,
        totalInCents: 4500,
        currency: 'USD',
        platformFeeInCents: 500,
        organizerNetInCents: 4000,
        createdAt: new Date(),
        expiresAt: new Date(),
        event: { organizerId: 'org_1', title: 'Test Event', slug: 'test-evt' },
        items: [],
        tickets: [
          {
            id: 't_ok',
            ticketToken: 'tkt_sec_active_token',
            status: TicketStatus.ISSUED,
            attendeeName: 'Buyer',
            attendeeEmail: 'buyer@outside.vip',
            checkedInAt: null,
            ticketTier: { id: 'tr1', name: 'GA', priceInCents: 2000, currency: 'USD' },
          },
          {
            id: 't_pending',
            ticketToken: 'tkt_sec_pending_token',
            status: TicketStatus.REFUND_PENDING,
            attendeeName: 'Buyer',
            attendeeEmail: 'buyer@outside.vip',
            checkedInAt: null,
            ticketTier: { id: 'tr1', name: 'GA', priceInCents: 2000, currency: 'USD' },
          },
          {
            id: 't_refunded',
            ticketToken: 'tkt_sec_refunded_token',
            status: TicketStatus.REFUNDED,
            attendeeName: 'Buyer',
            attendeeEmail: 'buyer@outside.vip',
            checkedInAt: null,
            ticketTier: { id: 'tr1', name: 'GA', priceInCents: 2000, currency: 'USD' },
          },
        ],
      };

      vi.spyOn(prisma.order, 'findUnique').mockResolvedValueOnce(mockOrder as any);
      const reqConf: any = {
        params: { orderNumber: 'OUT-CONF-1' },
        query: { token: 'oat_secret_token' },
        headers: {},
      };
      const resConf = createMockRes();
      await getOrderByOrderNumber(reqConf, resConf, vi.fn());

      expect(resConf.statusCode).toBe(200);
      expect(resConf.body.data.order.tickets[0].ticketToken).toBe('tkt_sec_active_token');
      expect(resConf.body.data.order.tickets[0].admissionEligible).toBe(true);
      expect(resConf.body.data.order.tickets[1].ticketToken).toBeNull();
      expect(resConf.body.data.order.tickets[1].admissionEligible).toBe(false);
      expect(resConf.body.data.order.tickets[2].ticketToken).toBeNull();
      expect(resConf.body.data.order.tickets[2].admissionEligible).toBe(false);

      // Single-ticket PDF download for REFUND_PENDING ticket fails closed via next(err)
      vi.spyOn(prisma.order, 'findUnique').mockResolvedValueOnce(mockOrder as any);
      const reqPdf: any = {
        params: { orderNumber: 'OUT-CONF-1', ticketId: 't_pending' },
        query: { token: 'oat_secret_token' },
        headers: {},
      };
      const resPdf = createMockRes();
      const nextPdf = vi.fn();
      await downloadOrderTicketsPdf(reqPdf, resPdf, nextPdf);
      expect(nextPdf).toHaveBeenCalledTimes(1);
      expect(nextPdf.mock.calls[0][0].code).toBe('TICKET_NOT_ELIGIBLE_FOR_PDF');
    });
  });

  describe('3. Exact refund ledger, settlement protection, withdrawal protection & inventory/waitlist', () => {
    it('deducts pre-settlement PENDING balance using exact allocations so settleOrderEarnings only clears remaining unrefunded earnings', async () => {
      // Simulate a 2-ticket order ($20.00 each = $40.00 net = 4000 organizerNetInCents)
      // Pre-settlement: organizerBalance.pending = 4000, ledger PENDING has +4000
      const createdLedgerEntries: any[] = [
        {
          id: 'le_sale_pending',
          orderId: 'ord_settle_1',
          type: LedgerEntryType.TICKET_SALE_PENDING,
          balanceType: LedgerBalanceType.PENDING,
          amountInCents: 4000,
          metadata: {},
        },
      ];
      let balanceState = {
        id: 'bal_1',
        userId: 'org_settle_1',
        currency: 'USD',
        pendingBalanceInCents: 4000,
        availableBalanceInCents: 0,
        transferredBalanceInCents: 0,
        updatedAt: new Date(),
      };

      const txMock: any = {
        $executeRaw: vi.fn().mockResolvedValue(1),
        $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
          const sql = strings.join(' ');
          if (sql.includes('FROM "OrganizerBalance"')) {
            return [{ ...balanceState }];
          }
          return [];
        }),
        order: {
          findUnique: vi.fn().mockResolvedValue({
            id: 'ord_settle_1',
            orderNumber: 'OUT-STL-1',
            eventId: 'evt_1',
            currency: 'USD',
            organizerNetInCents: 4000,
            stripeSettlementStatus: StripeSettlementStatus.PENDING,
            stripeFundsAvailableAt: null,
            stripeSettledChargeId: null,
            stripeBalanceTransactionId: null,
            stripeAvailableOn: null,
            event: { id: 'evt_1', organizerId: 'org_settle_1', title: 'Test' },
          }),
          update: vi.fn().mockResolvedValue({}),
        },
        organizerBalance: {
          findUnique: vi.fn(async () => ({ ...balanceState })),
          update: vi.fn(async ({ data }: any) => {
            if (typeof data.pendingBalanceInCents?.decrement === 'number') {
              balanceState.pendingBalanceInCents -= data.pendingBalanceInCents.decrement;
            }
            if (typeof data.availableBalanceInCents?.increment === 'number') {
              balanceState.availableBalanceInCents += data.availableBalanceInCents.increment;
            }
            return { ...balanceState };
          }),
        },
        financialLedgerEntry: {
          findMany: vi.fn(async ({ where }: any) =>
            createdLedgerEntries.filter((e) => {
              if (where?.orderId && e.orderId !== where.orderId) return false;
              if (where?.balanceType && e.balanceType !== where.balanceType) return false;
              return true;
            })
          ),
          findFirst: vi.fn(async ({ where }: any) =>
            createdLedgerEntries.find((e) => {
              if (where?.orderId && e.orderId !== where.orderId) return false;
              if (where?.type && e.type !== where.type) return false;
              return true;
            }) ?? null
          ),
          create: vi.fn(async ({ data }: any) => {
            const row = { id: `le_${createdLedgerEntries.length + 1}`, ...data };
            createdLedgerEntries.push(row);
            return row;
          }),
        },
      };

      // Refund 1 ticket ($20.00 gross + $2.00 platform + $0.95 service + $0.99 processing absorbed by PLATFORM)
      const firstPost = await recordTicketRefundLedgerInTx(txMock, {
        orderId: 'ord_settle_1',
        orderRefundId: 'ref_partial_1',
        amountInCents: 2394,
        ticketSubtotalInCents: 2000,
        platformFeeReversedInCents: 200,
        serviceFeeReversedInCents: 95,
        processingFeeInCents: 99,
        organizerDebitInCents: 2000,
        platformExpenseInCents: 99,
        stripeRefundId: 're_partial_1',
        reason: 'Partial ticket refund',
      });
      expect(firstPost).toEqual({ recorded: true, duplicate: false });
      expect(balanceState.pendingBalanceInCents).toBe(2000);

      // Duplicate call must be completely idempotent
      const dupPost = await recordTicketRefundLedgerInTx(txMock, {
        orderId: 'ord_settle_1',
        orderRefundId: 'ref_partial_1',
        amountInCents: 2394,
        ticketSubtotalInCents: 2000,
        platformFeeReversedInCents: 200,
        serviceFeeReversedInCents: 95,
        processingFeeInCents: 99,
        organizerDebitInCents: 2000,
        platformExpenseInCents: 99,
        stripeRefundId: 're_partial_1',
      });
      expect(dupPost).toEqual({ recorded: false, duplicate: true });

      // Platform expense stored as positive PLATFORM_EXPENSE; fee reversal negative on PLATFORM_REVENUE
      const expEntry = createdLedgerEntries.find((e) => e.balanceType === LedgerBalanceType.PLATFORM_EXPENSE);
      const revEntry = createdLedgerEntries.find((e) => e.balanceType === LedgerBalanceType.PLATFORM_REVENUE);
      expect(expEntry?.amountInCents).toBe(99);
      expect(revEntry?.amountInCents).toBe(-295);

      // Now settlement clears ONLY the remaining 2000 pending cents (never the refunded 2000!)
      await settleOrderEarnings(txMock, { orderId: 'ord_settle_1', stripeChargeId: 'ch_1' });
      expect(balanceState.pendingBalanceInCents).toBe(0);
      expect(balanceState.availableBalanceInCents).toBe(2000);
    });

    it('creates signed negative RECOVERABLE liability post-transfer and nets it out of organizer balance & withdrawal allowance', async () => {
      // Settled & transferred order: organizer available=500, refund debit=2000 -> 500 CLEARED + 1500 RECOVERABLE
      const ledgerRows: any[] = [
        {
          id: 'le_cleared',
          orderId: 'ord_post_1',
          organizerId: 'org_post_1',
          type: LedgerEntryType.TICKET_SALE_CLEARED,
          balanceType: LedgerBalanceType.AVAILABLE,
          amountInCents: 4000,
          metadata: {},
        },
      ];
      const balanceState = {
        id: 'bal_post_1',
        userId: 'org_post_1',
        currency: 'USD',
        pendingBalanceInCents: 0,
        availableBalanceInCents: 500,
        transferredBalanceInCents: 3500,
        updatedAt: new Date(),
      };

      const txMock: any = {
        $executeRaw: vi.fn().mockResolvedValue(1),
        $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
          const sql = strings.join(' ');
          if (sql.includes('FROM "OrganizerBalance"')) {
            return [{ ...balanceState }];
          }
          return [];
        }),
        order: {
          findUnique: vi.fn().mockResolvedValue({
            id: 'ord_post_1',
            orderNumber: 'OUT-POST-1',
            eventId: 'evt_1',
            currency: 'USD',
            event: { id: 'evt_1', organizerId: 'org_post_1', title: 'Test' },
          }),
        },
        organizerBalance: {
          findUnique: vi.fn(async () => ({ ...balanceState })),
          update: vi.fn(async ({ data }: any) => {
            if (typeof data.availableBalanceInCents?.decrement === 'number') {
              balanceState.availableBalanceInCents -= data.availableBalanceInCents.decrement;
            }
            return { ...balanceState };
          }),
        },
        financialLedgerEntry: {
          findMany: vi.fn(async ({ where }: any) =>
            ledgerRows.filter((e) => {
              if (where?.orderId && e.orderId !== where.orderId) return false;
              if (where?.organizerId && e.organizerId !== where.organizerId) return false;
              if (where?.balanceType && e.balanceType !== where.balanceType) return false;
              return true;
            })
          ),
          findFirst: vi.fn(async ({ where }: any) =>
            ledgerRows.find((e) => {
              if (where?.orderId && e.orderId !== where.orderId) return false;
              if (where?.type && e.type !== where.type) return false;
              return true;
            }) ?? null
          ),
          create: vi.fn(async ({ data }: any) => {
            const row = { id: `le_${ledgerRows.length + 1}`, ...data };
            ledgerRows.push(row);
            return row;
          }),
        },
      };

      await recordTicketRefundLedgerInTx(txMock, {
        orderId: 'ord_post_1',
        orderRefundId: 'ref_post_1',
        amountInCents: 2295,
        ticketSubtotalInCents: 2000,
        platformFeeReversedInCents: 200,
        serviceFeeReversedInCents: 95,
        processingFeeInCents: 99,
        organizerDebitInCents: 2000,
        platformExpenseInCents: 0,
        stripeRefundId: 're_post_1',
      });

      expect(balanceState.availableBalanceInCents).toBe(0);
      const recoverableRow = ledgerRows.find((e) => e.balanceType === LedgerBalanceType.RECOVERABLE);
      expect(recoverableRow?.type).toBe(LedgerEntryType.REFUND_POST_TRANSFER);
      expect(recoverableRow?.amountInCents).toBe(-1500);

      // Verify getOrganizerBalance & executeWithdrawal enforce netAvailableInCents protection
      vi.spyOn(prisma.organizerBalance, 'findUnique').mockResolvedValueOnce({ ...balanceState } as any);
      vi.spyOn(prisma.financialLedgerEntry, 'findMany')
        .mockResolvedValueOnce([recoverableRow] as any)
        .mockResolvedValueOnce([ledgerRows[0]] as any);
      const summary = await getOrganizerFinancialSummary('org_post_1');
      expect(summary.recoverableInCents).toBe(1500);
      expect(summary.netAvailableInCents).toBe(0);

      // If organizer later receives $20.00 (2000 available) while $15.00 recoverable remains,
      // requesting $10.00 (1000 > net 500) must be blocked by executeWithdrawal!
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce({
        id: 'org_post_1',
        email: 'org@outside.vip',
        name: 'Org',
        stripeAccountId: 'acct_test_1',
        stripeAccountCountry: 'US',
        role: Role.ORGANIZER,
      } as any);
      const { stripe } = await import('../lib/stripe.js');
      vi.spyOn(stripe.accounts, 'retrieve').mockResolvedValueOnce({
        id: 'acct_test_1',
        country: 'US',
        default_currency: 'usd',
        charges_enabled: true,
        payouts_enabled: true,
        capabilities: { transfers: 'active' },
      } as any);
      vi.spyOn(prisma.organizerTransfer, 'findUnique').mockResolvedValueOnce(null);

      const withdrawTx: any = {
        $executeRaw: vi.fn().mockResolvedValue(1),
        $queryRaw: vi.fn().mockResolvedValue([
          {
            id: 'bal_post_1',
            userId: 'org_post_1',
            currency: 'USD',
            availableBalanceInCents: 2000,
            pendingBalanceInCents: 0,
            transferredBalanceInCents: 3500,
          },
        ]),
        organizerBalance: {
          findUnique: vi.fn().mockResolvedValueOnce({ userId: 'org_post_1', availableBalanceInCents: 2000 }),
        },
        financialLedgerEntry: {
          findMany: vi.fn().mockResolvedValueOnce([recoverableRow]),
        },
      };
      vi.spyOn(prisma, '$transaction').mockImplementationOnce(async (cb: any) => cb(withdrawTx));

      await expect(
        executeWithdrawal({
          userId: 'org_post_1',
          amountInCents: 1000, // net available = 2000 - 1500 = 500
          idempotencyKey: 'wd_blocked_1',
        })
      ).rejects.toThrow(/Insufficient available balance/);
    });

    it('restores inventory safely on confirmed refund only for open sales, skips cancelled events, and advances waitlist strictly post-commit', async () => {
      // Part A: Confirmed refund with restoreInventory=true on open SOLD_OUT waitlist tier -> restores + returns tier post-commit
      const txOpen: any = {
        $executeRaw: vi.fn().mockResolvedValue(1),
        orderRefund: {
          findUnique: vi.fn().mockResolvedValueOnce({
            id: 'ref_inv_1',
            orderId: 'ord_inv_1',
            refundKind: OrderRefundKind.ORGANIZER_TICKET_REFUND,
          }),
          update: vi.fn().mockResolvedValueOnce({
            id: 'ref_inv_1',
            status: OrderRefundStatus.SUCCEEDED,
            inventoryRestoredCount: 1,
          }),
        },
        $queryRaw: vi
          .fn()
          .mockResolvedValueOnce([
            { id: 'ord_inv_1', eventId: 'evt_open_1', status: OrderStatus.COMPLETED, pendingRefundAmountInCents: 2295 },
          ])
          .mockResolvedValueOnce([{ id: 'tkt_inv_1', ticketTierId: 'tier_waitlist_1', status: TicketStatus.REFUND_PENDING }])
          .mockResolvedValueOnce([
            {
              id: 'ref_inv_1',
              orderId: 'ord_inv_1',
              refundKind: OrderRefundKind.ORGANIZER_TICKET_REFUND,
              status: OrderRefundStatus.PROCESSING,
              amountInCents: 2295,
              ticketSubtotalInCents: 2000,
              platformFeeReversedInCents: 200,
              serviceFeeReversedInCents: 95,
              processingFeeInCents: 99,
              organizerDebitInCents: 2000,
              platformExpenseInCents: 0,
              restoreInventory: true,
              inventoryRestoredCount: 0,
              reason: 'Customer request',
              stripeChargeId: 'ch_1',
            },
          ])
          .mockResolvedValueOnce([
            {
              id: 'b1',
              userId: 'org_1',
              currency: 'USD',
              pendingBalanceInCents: 2000,
              availableBalanceInCents: 0,
              transferredBalanceInCents: 0,
            },
          ])
          .mockResolvedValueOnce([
            {
              id: 'tier_waitlist_1',
              status: TicketTierStatus.SOLD_OUT,
              isHidden: false,
              salesDisabled: false,
              salesEndAt: null,
              waitlistEnabled: true,
              totalCapacity: 10,
              soldQuantity: 10,
              reservedQuantity: 0,
            },
          ]),
        orderRefundTicket: {
          findMany: vi.fn().mockResolvedValueOnce([
            { id: 'ort_1', ticketId: 'tkt_inv_1', restoreInventory: true, inventoryRestored: false },
          ]),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        ticket: {
          updateMany: vi.fn().mockResolvedValueOnce({ count: 1 }),
          count: vi.fn().mockResolvedValueOnce(1), // 1 remaining active ticket -> partial refund stays COMPLETED
        },
        order: {
          findUnique: vi.fn().mockResolvedValue({
            id: 'ord_inv_1',
            orderNumber: 'OUT-INV-1',
            eventId: 'evt_open_1',
            currency: 'USD',
            event: { id: 'evt_open_1', organizerId: 'org_1', title: 'Open' },
          }),
          update: vi.fn().mockResolvedValueOnce({}),
        },
        organizerBalance: {
          findUnique: vi.fn().mockResolvedValueOnce({
            id: 'b1',
            userId: 'org_1',
            currency: 'USD',
            pendingBalanceInCents: 2000,
            availableBalanceInCents: 0,
          }),
          update: vi.fn().mockResolvedValueOnce({}),
        },
        financialLedgerEntry: {
          findMany: vi
            .fn()
            .mockResolvedValueOnce([]) // idempotency check
            .mockResolvedValueOnce([{ amountInCents: 4000 }]), // order PENDING
          findFirst: vi.fn().mockResolvedValueOnce(null),
          create: vi.fn().mockResolvedValue({ id: 'le_new' }),
        },
        event: {
          findUnique: vi.fn().mockResolvedValueOnce({
            id: 'evt_open_1',
            status: EventStatus.PUBLISHED,
            endAt: new Date(Date.now() + 86_400_000),
          }),
        },
        ticketTier: {
          update: vi.fn().mockResolvedValueOnce({}),
        },
      };

      const processWaitlistSpy = vi
        .spyOn(waitlistService, 'processWaitlistForTier')
        .mockResolvedValue({ ticketTierId: 'tier_waitlist_1', offersCreated: 1, availableRemaining: 0 });

      const resultOpen = await confirmTicketRefundSucceededInTx(txOpen, {
        orderRefundId: 'ref_inv_1',
        stripeRefundId: 're_inv_1',
        confirmedByUserId: 'org_1',
      });

      expect(resultOpen.alreadyFinalized).toBe(false);
      expect(resultOpen.orderFullyRefunded).toBe(false);
      expect(resultOpen.inventoryRestoredCount).toBe(1);
      expect(resultOpen.tiersToAdvanceWaitlist).toEqual(['tier_waitlist_1']);
      expect(txOpen.ticketTier.update).toHaveBeenCalledWith({
        where: { id: 'tier_waitlist_1' },
        data: { soldQuantity: 9, status: TicketTierStatus.ACTIVE },
      });
      // Waitlist must NOT have been called inside the transaction
      expect(processWaitlistSpy).not.toHaveBeenCalled();

      // Caller triggers post-commit waitlist handoff safely
      await triggerPostCommitWaitlistAdvancement(resultOpen.tiersToAdvanceWaitlist);
      expect(processWaitlistSpy).toHaveBeenCalledWith('tier_waitlist_1');

      // Part B: Local free-ticket cancellation on CANCELLED event never restores capacity or creates ledger/OrderRefund
      const freeCancelledTx: any = {
        $queryRaw: vi
          .fn()
          .mockResolvedValueOnce([{ id: 'ord_free_c1', eventId: 'evt_cancelled', totalInCents: 0 }])
          .mockResolvedValueOnce([
            {
              id: 't_free_c1',
              orderId: 'ord_free_c1',
              ticketTierId: 'tier_free_1',
              status: TicketStatus.ISSUED,
              checkedInAt: null,
              allocatedGrossInCents: null,
              allocatedPlatformFeeInCents: null,
              allocatedServiceFeeInCents: null,
              allocatedProcessingFeeInCents: null,
              allocatedBuyerTotalInCents: null,
              createdAt: new Date(),
            },
          ]),
        ticketTier: {
          findMany: vi.fn().mockResolvedValueOnce([{ id: 'tier_free_1', priceInCents: 0 }]),
          update: vi.fn(),
        },
        orderRefundTicket: { findMany: vi.fn().mockResolvedValueOnce([]) },
        ticket: { updateMany: vi.fn().mockResolvedValueOnce({ count: 1 }) },
        event: {
          findUnique: vi.fn().mockResolvedValueOnce({
            id: 'evt_cancelled',
            status: EventStatus.CANCELLED,
            endAt: new Date(Date.now() + 86_400_000),
          }),
        },
      };

      const freeRes = await executeLocalFreeTicketCancellationInTx(freeCancelledTx, {
        orderId: 'ord_free_c1',
        ticketIds: ['t_free_c1'],
        initiatorRole: RefundInitiatorRole.ORGANIZER,
        initiatedByUserId: 'org_1',
        reason: 'Event cancelled cleanup',
        restoreInventory: true,
      });

      expect(freeRes.plan.createOrderRefundRecord).toBe(false);
      expect(freeRes.plan.stripeRefundAmountInCents).toBe(0);
      expect(freeRes.plan.ledgerRefundAmountInCents).toBe(0);
      expect(freeRes.inventoryRestoredCount).toBe(0);
      expect(freeRes.tiersToAdvanceWaitlist).toEqual([]);
      expect(freeCancelledTx.ticketTier.update).not.toHaveBeenCalled();
    });
  });
});
