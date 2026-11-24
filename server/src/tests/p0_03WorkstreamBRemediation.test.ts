import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  OrderRefundKind,
  OrderRefundStatus,
  OrderStatus,
  Role,
  TicketStatus,
} from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { stripe } from '../lib/stripe.js';
import {
  claimPendingOrderRefundBatch,
  evaluateExistingStripeRefunds,
  processClaimedOrderRefundItem,
  reconcileOrderRefundFromStripeWebhook,
} from '../modules/refunds/orderRefund.service.js';
import { processStripeWebhookEvent } from '../modules/webhooks/webhook.service.js';
import * as ledgerService from '../modules/finance/ledger.service.js';
import { checkInTicket } from '../modules/organizer/organizer.controller.js';

describe('Stage 4 P0-03 Workstream B — P2-04 Isolation & Explicit Check-In Statuses', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('P2-04 late-payment isolation when PaymentIntent has multiple refunds', () => {
    it('claimPendingOrderRefundBatch SQL claims LATE_PAYMENT and buyer ticket refunds while worker ignores unclaimable kinds like EVENT_CANCELLATION', async () => {
      const queryRawSpy = vi
        .spyOn(prisma, '$queryRaw')
        .mockResolvedValueOnce([]) // reapExpiredExhaustedRefundLeases
        .mockResolvedValueOnce([]); // claimPendingOrderRefundBatch CTE

      await claimPendingOrderRefundBatch({ workerId: 'worker-1', batchSize: 5 });

      expect(queryRawSpy).toHaveBeenCalledTimes(2);
      const reapSql = (queryRawSpy.mock.calls[0][0] as unknown as string[]).join(' ');
      const claimSql = (queryRawSpy.mock.calls[1][0] as unknown as string[]).join(' ');
      expect(reapSql).toContain('\'LATE_PAYMENT\'::"OrderRefundKind"');
      expect(claimSql).toContain('\'LATE_PAYMENT\'::"OrderRefundKind"');
      expect(reapSql).toContain('\'ORGANIZER_TICKET_REFUND\'::"OrderRefundKind"');
      expect(claimSql).toContain('\'ADMIN_TICKET_REFUND\'::"OrderRefundKind"');
      expect(claimSql).not.toContain('\'EVENT_CANCELLATION\'::"OrderRefundKind"');

      const refundsListSpy = vi.spyOn(stripe.refunds, 'list');
      const refundsCreateSpy = vi.spyOn(stripe.refunds, 'create');

      const cancellationRefund = {
        id: 'refund_cancel_1',
        orderId: 'ord_1',
        stripePaymentIntentId: 'pi_shared_1',
        stripeChargeId: 'ch_1',
        stripeRefundId: null,
        idempotencyKey: 'cancel-refund:refund_cancel_1',
        refundKind: OrderRefundKind.EVENT_CANCELLATION,
        amountInCents: 2295,
        currency: 'USD',
        status: OrderRefundStatus.PROCESSING,
      } as any;

      const outcome = await processClaimedOrderRefundItem(cancellationRefund, 'worker-1');
      expect(outcome).toBe('leaseLost');
      expect(refundsListSpy).not.toHaveBeenCalled();
      expect(refundsCreateSpy).not.toHaveBeenCalled();
    });

    it('evaluateExistingStripeRefunds excludes known sibling buyer refunds on the same PaymentIntent without false manual review', () => {
      const siblingExclusions = {
        orderRefundIds: new Set(['buyer_refund_1']),
        stripeRefundIds: new Set(['re_buyer_partial_1']),
      };

      // Case 1: Only a sibling partial buyer refund exists on Stripe -> LATE_PAYMENT sees NONE and proceeds safely
      const noneResult = evaluateExistingStripeRefunds(
        [
          {
            id: 're_buyer_partial_1',
            amount: 2295,
            currency: 'usd',
            status: 'succeeded',
            metadata: { orderRefundId: 'buyer_refund_1' },
          } as any,
        ],
        5000,
        'USD',
        'late_refund_1',
        null,
        siblingExclusions
      );
      expect(noneResult.kind).toBe('NONE');

      // Case 2: Both sibling buyer refund and matching LATE_PAYMENT refund exist -> LATE_PAYMENT reconciles cleanly
      const reconciledResult = evaluateExistingStripeRefunds(
        [
          {
            id: 're_buyer_partial_1',
            amount: 2295,
            currency: 'usd',
            status: 'succeeded',
            metadata: { orderRefundId: 'buyer_refund_1' },
          } as any,
          {
            id: 're_late_1',
            amount: 5000,
            currency: 'usd',
            status: 'succeeded',
            metadata: { orderRefundId: 'late_refund_1' },
          } as any,
        ],
        5000,
        'USD',
        'late_refund_1',
        null,
        siblingExclusions
      );
      expect(reconciledResult.kind).toBe('RECONCILED_SUCCEEDED');
      if (reconciledResult.kind === 'RECONCILED_SUCCEEDED') {
        expect(reconciledResult.refund.id).toBe('re_late_1');
      }

      // Case 3: Without sibling ownership, two active refunds still escalate to MANUAL_REVIEW_REQUIRED
      const unattributedConflict = evaluateExistingStripeRefunds(
        [
          { id: 're_unknown_1', amount: 2295, currency: 'usd', status: 'succeeded', metadata: {} } as any,
          { id: 're_late_1', amount: 5000, currency: 'usd', status: 'succeeded', metadata: { orderRefundId: 'late_refund_1' } } as any,
        ],
        5000,
        'USD',
        'late_refund_1',
        null,
        siblingExclusions
      );
      expect(unattributedConflict.kind).toBe('AMBIGUOUS_ESCALATE');
    });

    it('reconcileOrderRefundFromStripeWebhook ignores buyer refund webhooks and avoids false mismatch when sibling buyer refunds exist', async () => {
      // 1. Only buyer partial refund exists on PI (SQL filtered to LATE_PAYMENT returns [])
      const txOnlyBuyer: any = {
        $queryRaw: vi.fn().mockResolvedValueOnce([]),
        orderRefund: { findMany: vi.fn(), update: vi.fn() },
        order: { update: vi.fn() },
        paymentTransaction: { updateMany: vi.fn() },
        emailOutbox: { createMany: vi.fn(), findUnique: vi.fn() },
      };

      const resBuyerOnly = await reconcileOrderRefundFromStripeWebhook(txOnlyBuyer, {
        lockedOrder: {
          id: 'ord_1',
          orderNumber: 'OUT-1',
          status: OrderStatus.COMPLETED,
          customerEmail: 'buyer@example.com',
          customerName: 'Buyer',
          eventTitle: 'Event',
        },
        paymentIntentId: 'pi_shared',
        refunds: [
          {
            id: 're_buyer_1',
            amount: 2295,
            currency: 'USD',
            status: 'succeeded',
            payment_intent: 'pi_shared',
            metadata: { orderRefundId: 'buyer_ref_1' },
          },
        ],
      });

      expect(resBuyerOnly).toEqual({ matchedLatePaymentRefund: false, enqueuedEmail: false });
      expect(txOnlyBuyer.orderRefund.update).not.toHaveBeenCalled();
      expect(txOnlyBuyer.paymentTransaction.updateMany).not.toHaveBeenCalled();
      expect(txOnlyBuyer.emailOutbox.createMany).not.toHaveBeenCalled();

      // Verify SQL strictly filters LATE_PAYMENT
      const sqlFragments = (txOnlyBuyer.$queryRaw.mock.calls[0][0] as unknown as string[]).join(' ');
      expect(sqlFragments).toContain('"refundKind" = \'LATE_PAYMENT\'::"OrderRefundKind"');

      // 2. Shared PI has a sibling buyer refund AND a LATE_PAYMENT refund in charge.refunded -> reconciles LATE_PAYMENT cleanly
      const lateRow = {
        id: 'late_ref_1',
        orderId: 'ord_2',
        stripePaymentIntentId: 'pi_shared_2',
        stripeRefundId: 're_late_2',
        idempotencyKey: 'late-refund:pi_shared_2',
        refundKind: OrderRefundKind.LATE_PAYMENT,
        amountInCents: 5000,
        currency: 'USD',
        reason: 'DUPLICATE_PAYMENT_INTENT',
        status: OrderRefundStatus.STRIPE_PENDING,
        requiresManualResolution: false,
      };

      const txMixed: any = {
        $queryRaw: vi.fn().mockResolvedValueOnce([lateRow]),
        orderRefund: {
          findMany: vi.fn().mockResolvedValueOnce([{ id: 'buyer_ref_2', stripeRefundId: 're_buyer_2' }]),
          update: vi.fn().mockResolvedValueOnce({ ...lateRow, status: OrderRefundStatus.SUCCEEDED }),
        },
        order: { update: vi.fn() },
        paymentTransaction: { updateMany: vi.fn().mockResolvedValueOnce({ count: 1 }) },
        emailOutbox: {
          createMany: vi.fn().mockResolvedValueOnce({ count: 1 }),
          findUnique: vi.fn().mockResolvedValueOnce({ id: 'email_1' }),
        },
      };

      const resMixed = await reconcileOrderRefundFromStripeWebhook(txMixed, {
        lockedOrder: {
          id: 'ord_2',
          orderNumber: 'OUT-2',
          status: OrderStatus.COMPLETED,
          customerEmail: 'buyer@example.com',
          customerName: 'Buyer',
          eventTitle: 'Event',
        },
        paymentIntentId: 'pi_shared_2',
        refunds: [
          {
            id: 're_buyer_2',
            amount: 2295,
            currency: 'USD',
            status: 'succeeded',
            payment_intent: 'pi_shared_2',
            metadata: { orderRefundId: 'buyer_ref_2' },
          },
          {
            id: 're_late_2',
            amount: 5000,
            currency: 'USD',
            status: 'succeeded',
            payment_intent: 'pi_shared_2',
            metadata: { orderRefundId: 'late_ref_1' },
          },
        ],
      });

      expect(resMixed).toEqual({ matchedLatePaymentRefund: true, enqueuedEmail: true });
      expect(txMixed.orderRefund.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'late_ref_1' },
          data: expect.objectContaining({ status: OrderRefundStatus.SUCCEEDED }),
        })
      );
    });

    it('handleChargeRefunded and handleChargeUpdated scope late-payment lookups to LATE_PAYMENT', async () => {
      const orderRecord = {
        id: 'ord_wh_1',
        orderNumber: 'OUT-WH-1',
        status: OrderStatus.COMPLETED,
        currency: 'USD',
        paymentReference: 'pi_wh_1',
        customerEmail: 'buyer@example.com',
        customerName: 'Buyer',
        eventId: 'evt_1',
        event: { id: 'evt_1', title: 'Event', organizerId: 'org_1', status: 'PUBLISHED' },
        items: [],
      };

      const orderRefundFindFirst = vi
        .fn()
        .mockResolvedValueOnce(null); // orderRefundForIncomingCharge (LATE_PAYMENT scoped) -> null even if buyer refund exists

      vi.spyOn(prisma.processedWebhookEvent, 'findUnique').mockResolvedValueOnce(null);

      const txMock: any = {
        processedWebhookEvent: {
          findUnique: vi.fn().mockResolvedValueOnce(null),
          create: vi.fn().mockResolvedValueOnce({ id: 'pwe_1' }),
        },
        $queryRaw: vi
          .fn()
          .mockResolvedValueOnce([{ id: orderRecord.id }]) // lockOrderByIdentifier
          .mockResolvedValueOnce([]), // reconcileOrderRefundFromStripeWebhook (LATE_PAYMENT filtered)
        order: {
          findUnique: vi.fn().mockResolvedValueOnce(orderRecord),
        },
        orderRefund: {
          findFirst: orderRefundFindFirst,
          findMany: vi.fn().mockResolvedValueOnce([]),
        },
        financialLedgerEntry: {
          findFirst: vi.fn().mockResolvedValueOnce({ id: 'sale_ledger_1' }),
        },
      };

      vi.spyOn(prisma, '$transaction').mockImplementationOnce(async (cb: any) => cb(txMock));
      const recordRefundLedgerSpy = vi
        .spyOn(ledgerService, 'recordRefundLedger')
        .mockResolvedValueOnce(undefined);

      await processStripeWebhookEvent({
        id: 'evt_stripe_refund_1',
        type: 'charge.refunded',
        data: {
          object: {
            id: 'ch_wh_1',
            amount_refunded: 2295,
            currency: 'usd',
            payment_intent: 'pi_wh_1',
            metadata: { orderId: orderRecord.id },
            refunds: {
              has_more: false,
              data: [
                {
                  id: 're_buyer_wh_1',
                  amount: 2295,
                  currency: 'usd',
                  status: 'succeeded',
                  payment_intent: 'pi_wh_1',
                  metadata: { orderRefundId: 'buyer_ref_wh_1' },
                },
              ],
            },
          },
        },
      } as any);

      expect(orderRefundFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            refundKind: OrderRefundKind.LATE_PAYMENT,
          }),
        })
      );
      expect(recordRefundLedgerSpy).toHaveBeenCalledTimes(1);

      // Verify handleChargeUpdated fallback (when paymentIntentId is null) scopes to LATE_PAYMENT
      vi.spyOn(prisma.processedWebhookEvent, 'findUnique').mockResolvedValueOnce(null);
      const chargeUpdateFindFirst = vi.fn().mockResolvedValueOnce(null);
      const txChargeUpdated: any = {
        processedWebhookEvent: {
          findUnique: vi.fn().mockResolvedValueOnce(null),
          create: vi.fn().mockResolvedValueOnce({ id: 'pwe_2' }),
        },
        $queryRaw: vi.fn().mockResolvedValueOnce([{ id: orderRecord.id }]),
        order: {
          findUnique: vi.fn().mockResolvedValueOnce(orderRecord),
          update: vi.fn().mockResolvedValueOnce(orderRecord),
        },
        orderRefund: {
          findFirst: chargeUpdateFindFirst,
        },
        financialLedgerEntry: {
          findFirst: vi.fn().mockResolvedValueOnce(null),
        },
      };
      vi.spyOn(prisma, '$transaction').mockImplementationOnce(async (cb: any) => cb(txChargeUpdated));
      vi.spyOn(ledgerService, 'hasOpenDisputeForOrder').mockResolvedValueOnce(false);
      vi.spyOn(ledgerService, 'recordTicketSalePending').mockResolvedValueOnce(undefined);

      await processStripeWebhookEvent({
        id: 'evt_stripe_charge_upd_1',
        type: 'charge.updated',
        data: {
          object: {
            id: 'ch_wh_upd_1',
            status: 'succeeded',
            currency: 'usd',
            disputed: false,
            payment_intent: null,
            balance_transaction: null,
            metadata: { orderId: orderRecord.id },
          },
        },
      } as any);

      expect(chargeUpdateFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            orderId: orderRecord.id,
            refundKind: OrderRefundKind.LATE_PAYMENT,
          }),
        })
      );
    });
  });

  describe('Explicit check-in status rejection for REFUND_PENDING and REFUNDED tickets', () => {
    function createMockRes() {
      const res: any = {
        statusCode: 200,
        body: null,
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

    it('rejects REFUND_PENDING and REFUNDED tickets on a COMPLETED order with distinct CheckInResult codes (never ALREADY_CHECKED_IN)', async () => {
      for (const testCase of [
        {
          ticketStatus: TicketStatus.REFUND_PENDING,
          expectedCode: 'REFUND_PENDING_TICKET',
        },
        {
          ticketStatus: TicketStatus.REFUNDED,
          expectedCode: 'REFUNDED_TICKET',
        },
      ]) {
        vi.restoreAllMocks();
        const findUniqueSpy = vi.spyOn(prisma.ticket, 'findUnique').mockResolvedValueOnce({
          id: 'tkt_1',
          ticketToken: 'tkt_sec_abc1234567890',
          eventId: 'evt_1',
          attendeeName: 'Buyer Name',
          attendeeEmail: 'buyer@example.com',
          status: testCase.ticketStatus,
          checkedInAt: null,
          checkedInByUserId: null,
          event: {
            id: 'evt_1',
            slug: 'evt-slug',
            title: 'Test Event',
            organizerId: 'org_1',
            timezone: 'UTC',
            startAt: new Date(Date.now() - 3600_000),
            endAt: new Date(Date.now() + 3600_000),
          },
          ticketTier: {
            name: 'GA',
            validityStartAt: null,
            validityEndAt: null,
          },
          order: {
            orderNumber: 'OUT-2026-100',
            status: OrderStatus.COMPLETED,
            customerName: 'Buyer Name',
            customerEmail: 'buyer@example.com',
          },
          checkedInByUser: null,
        } as any);

        const checkInLogSpy = vi
          .spyOn(prisma.checkInLog, 'create')
          .mockResolvedValueOnce({ id: 'log_1' } as any);
        const updateManySpy = vi.spyOn(prisma.ticket, 'updateMany');

        const req: any = {
          user: { userId: 'org_1', role: Role.ORGANIZER, email: 'org@example.com' },
          headers: {},
          body: { token: 'tkt_sec_abc1234567890' },
        };
        const res = createMockRes();
        const next = vi.fn();

        await checkInTicket(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(findUniqueSpy).toHaveBeenCalledTimes(1);
        expect(updateManySpy).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(400);
        expect(res.body.error.code).toBe(testCase.expectedCode);
        expect(res.body.data.result).toBe(testCase.expectedCode);
        expect(res.body.data.result).not.toBe('ALREADY_CHECKED_IN');
        expect(checkInLogSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              ticketId: 'tkt_1',
              result: testCase.expectedCode,
            }),
          })
        );
      }
    });
  });
});
