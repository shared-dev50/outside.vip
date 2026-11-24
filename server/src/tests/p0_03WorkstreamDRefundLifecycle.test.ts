import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  EmailOutboxStatus,
  EmailOutboxType,
  LedgerEntryType,
  OrderRefundKind,
  OrderRefundStatus,
  OrderRefundTicketLockState,
  OrderStatus,
  PaymentProvider,
  PaymentStatus,
  RefundFeeBearer,
  RefundInitiatorRole,
  Role,
  TicketStatus,
} from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { stripe } from '../lib/stripe.js';
import {
  BUYER_REFUND_TEMPLATE_VERSION,
  sentBuyerRefundEmails,
} from '../lib/email.service.js';
import {
  enqueueBuyerRefundEmail,
  runEmailOutboxPass,
} from '../modules/notifications/emailOutbox.service.js';
import {
  getOrderRefundSummary,
  initiateOrderTicketRefund,
  previewOrderTicketRefund,
} from '../modules/refunds/refund.service.js';
import {
  processClaimedOrderRefundItem,
  reconcileBuyerRefundsFromStripeWebhook,
} from '../modules/refunds/orderRefund.service.js';
import { processStripeWebhookEvent } from '../modules/webhooks/webhook.service.js';
import * as ledgerService from '../modules/finance/ledger.service.js';
import * as refundAdmission from '../modules/refunds/refundAdmissionState.service.js';
import * as refundWorker from '../modules/refunds/orderRefundWorker.js';
import { getOrganizerOrders } from '../modules/organizer/organizer.controller.js';
import * as eventAuth from '../modules/eventTeam/eventTeam.permissions.js';

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

describe('Stage 4 P0-03 Workstream D — Buyer Refund Lifecycle', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sentBuyerRefundEmails.length = 0;
  });

  describe('1. Authorization & Role Enforcement', () => {
    it('allows event owner ORGANIZER and platform ADMIN, but rejects unauthorized users and delegated team members with 403', async () => {
      const orderFixture = {
        id: 'ord_auth_1',
        orderNumber: 'OUT-AUTH-1',
        status: OrderStatus.COMPLETED,
        currency: 'USD',
        totalInCents: 2495,
        refundedAmountInCents: 0,
        pendingRefundAmountInCents: 0,
        platformFeeInCents: 200,
        organizerNetInCents: 1800,
        paymentProvider: PaymentProvider.STRIPE,
        customerName: 'Alice Buyer',
        customerEmail: 'alice@example.com',
        eventId: 'evt_1',
        event: {
          id: 'evt_1',
          title: 'Rooftop Night',
          organizerId: 'org_owner_1',
        },
        tickets: [
          {
            id: 'tkt_1',
            ticketCode: 'CODE-1',
            ticketTierId: 'tier_1',
            status: TicketStatus.ISSUED,
            attendeeName: 'Alice Buyer',
            attendeeEmail: 'alice@example.com',
            checkedInAt: null,
            refundedAt: null,
            cancelledAt: null,
            cancellationReason: null,
            allocatedGrossInCents: 2000,
            allocatedPlatformFeeInCents: 200,
            allocatedServiceFeeInCents: 195,
            allocatedProcessingFeeInCents: 100,
            allocatedBuyerTotalInCents: 2495,
            ticketTier: { id: 'tier_1', name: 'GA', priceInCents: 2000 },
            refundAllocations: [],
          },
        ],
        refunds: [],
      };

      const findUniqueSpy = vi
        .spyOn(prisma.order, 'findUnique')
        .mockResolvedValue(orderFixture as any);

      // Owner ORGANIZER succeeds
      const ownerSummary = await getOrderRefundSummary('ord_auth_1', {
        userId: 'org_owner_1',
        role: Role.ORGANIZER,
      });
      expect(ownerSummary.capabilities.initiatorRole).toBe(RefundInitiatorRole.ORGANIZER);
      expect(ownerSummary.capabilities.canOverrideCheckedIn).toBe(false);
      expect(ownerSummary.capabilities.canShiftFeeToPlatform).toBe(false);

      // Platform ADMIN succeeds
      const adminSummary = await getOrderRefundSummary('ord_auth_1', {
        userId: 'admin_1',
        role: Role.ADMIN,
      });
      expect(adminSummary.capabilities.initiatorRole).toBe(RefundInitiatorRole.ADMIN);
      expect(adminSummary.capabilities.canOverrideCheckedIn).toBe(true);
      expect(adminSummary.capabilities.canShiftFeeToPlatform).toBe(true);

      // Another organizer -> 403 ForbiddenError
      await expect(
        getOrderRefundSummary('ord_auth_1', { userId: 'org_other_2', role: Role.ORGANIZER })
      ).rejects.toMatchObject({ statusCode: 403 });

      // Attendee / EventTeamMember -> 403 ForbiddenError even if querying preview
      await expect(
        getOrderRefundSummary('ord_auth_1', { userId: 'team_member_1', role: Role.ATTENDEE })
      ).rejects.toMatchObject({ statusCode: 403 });

      findUniqueSpy.mockRestore();
    });

    it('rejects organizer attempt to shift Stripe processing fees to PLATFORM or override checked-in tickets', async () => {
      const checkedInOrder = {
        id: 'ord_ci_1',
        orderNumber: 'OUT-CI-1',
        status: OrderStatus.COMPLETED,
        currency: 'USD',
        totalInCents: 2495,
        refundedAmountInCents: 0,
        pendingRefundAmountInCents: 0,
        event: { id: 'evt_1', organizerId: 'org_owner_1' },
        tickets: [
          {
            id: 'tkt_ci_1',
            orderId: 'ord_ci_1',
            ticketTierId: 'tier_1',
            status: TicketStatus.CHECKED_IN,
            allocatedGrossInCents: 2000,
            allocatedPlatformFeeInCents: 200,
            allocatedServiceFeeInCents: 195,
            allocatedProcessingFeeInCents: 100,
            allocatedBuyerTotalInCents: 2495,
            ticketTier: { id: 'tier_1', priceInCents: 2000 },
            refundAllocations: [],
          },
        ],
      };

      vi.spyOn(prisma, '$transaction').mockImplementation(async (cb: any) =>
        cb({
          order: { findUnique: vi.fn().mockResolvedValue(checkedInOrder) },
        })
      );

      // Organizer trying feeBearer: PLATFORM -> 403
      await expect(
        previewOrderTicketRefund(
          'ord_ci_1',
          { userId: 'org_owner_1', role: Role.ORGANIZER },
          {
            ticketIds: ['tkt_ci_1'],
            refundStripeProcessingFee: true,
            feeBearer: RefundFeeBearer.PLATFORM,
            restoreInventory: true,
            allowCheckedInOverride: false,
          }
        )
      ).rejects.toMatchObject({ statusCode: 403 });

      // Organizer trying allowCheckedInOverride -> 403
      await expect(
        previewOrderTicketRefund(
          'ord_ci_1',
          { userId: 'org_owner_1', role: Role.ORGANIZER },
          {
            ticketIds: ['tkt_ci_1'],
            refundStripeProcessingFee: false,
            restoreInventory: true,
            allowCheckedInOverride: true,
            overrideReason: 'Try override',
          }
        )
      ).rejects.toMatchObject({ statusCode: 403 });

      // Organizer without override flag gets 409 ConflictError (checked-in blocked)
      await expect(
        previewOrderTicketRefund(
          'ord_ci_1',
          { userId: 'org_owner_1', role: Role.ORGANIZER },
          {
            ticketIds: ['tkt_ci_1'],
            refundStripeProcessingFee: false,
            restoreInventory: true,
            allowCheckedInOverride: false,
          }
        )
      ).rejects.toMatchObject({ statusCode: 409 });

      // ADMIN without reason gets 400
      await expect(
        previewOrderTicketRefund(
          'ord_ci_1',
          { userId: 'admin_1', role: Role.ADMIN },
          {
            ticketIds: ['tkt_ci_1'],
            refundStripeProcessingFee: false,
            restoreInventory: true,
            allowCheckedInOverride: true,
            overrideReason: 'no',
          }
        )
      ).rejects.toMatchObject({ statusCode: 400 });

      // ADMIN with valid override + reason succeeds in preview
      vi.spyOn(refundAdmission, 'ensureOrderTicketAllocationsInTx').mockResolvedValueOnce(
        new Map([
          [
            'tkt_ci_1',
            {
              ticketId: 'tkt_ci_1',
              ticketTierId: 'tier_1',
              allocatedGrossInCents: 2000,
              allocatedPlatformFeeInCents: 200,
              allocatedServiceFeeInCents: 195,
              allocatedProcessingFeeInCents: 100,
              allocatedBuyerTotalInCents: 2495,
            },
          ],
        ])
      );

      const adminPreview = await previewOrderTicketRefund(
        'ord_ci_1',
        { userId: 'admin_1', role: Role.ADMIN },
        {
          ticketIds: ['tkt_ci_1'],
          refundStripeProcessingFee: true,
          feeBearer: RefundFeeBearer.PLATFORM,
          restoreInventory: true,
          allowCheckedInOverride: true,
          overrideReason: 'Gate scanner double-tapped at entry',
        }
      );

      expect(adminPreview.checkedInOverrideApplied).toBe(true);
      expect(adminPreview.buyerRefundAmountInCents).toBe(2495);
      expect(adminPreview.platformExpenseInCents).toBe(100);
      expect(adminPreview.organizerDebitInCents).toBe(2000);
    });

    it('exposes canManageRefunds=false on getOrganizerOrders for delegated Event Admin (canViewOrders) and true for owner', async () => {
      vi.spyOn(eventAuth, 'resolveEventAuthorization').mockResolvedValueOnce({
        eventId: 'evt_1',
        isOwner: false,
        isAdmin: true,
        role: 'ADMIN',
        permissions: { canViewOrders: true },
      } as any);

      vi.spyOn(prisma.event, 'findFirst').mockResolvedValueOnce({
        id: 'evt_1',
        organizerId: 'org_owner_1',
      } as any);
      vi.spyOn(prisma.order, 'count').mockResolvedValueOnce(1);
      vi.spyOn(prisma.order, 'findMany').mockResolvedValueOnce([
        {
          id: 'ord_view_1',
          orderNumber: 'OUT-VIEW-1',
          status: OrderStatus.COMPLETED,
          customerName: 'Bob',
          customerEmail: 'bob@example.com',
          customerPhone: null,
          totalInCents: 2500,
          refundedAmountInCents: 500,
          pendingRefundAmountInCents: 0,
          currency: 'USD',
          platformFeeInCents: 200,
          organizerNetInCents: 2000,
          paymentProvider: PaymentProvider.STRIPE,
          paymentReference: 'pi_1',
          createdAt: new Date(),
          updatedAt: new Date(),
          eventId: 'evt_1',
          event: {
            id: 'evt_1',
            organizerId: 'org_owner_1',
            title: 'Event One',
            slug: 'event-one',
            startAt: new Date(),
            endAt: new Date(),
            venueName: 'Hall',
            city: 'Riyadh',
            country: 'SA',
          },
          items: [
            {
              id: 'oi_1',
              ticketTierId: 'tier_1',
              quantity: 2,
              unitPriceInCents: 1000,
              subtotalInCents: 2000,
              ticketTier: { id: 'tier_1', name: 'GA' },
            },
          ],
          _count: { tickets: 2 },
        },
      ] as any);

      const req: any = {
        user: { userId: 'delegated_team_user', role: Role.ATTENDEE },
        query: { eventId: 'evt_1', page: '1', limit: '20' },
      };
      const res = createMockRes();
      await getOrganizerOrders(req, res, (err) => {
        if (err) throw err;
      });

      expect(res.body.success).toBe(true);
      expect(res.body.data.orders[0].canManageRefunds).toBe(false);
      expect(res.body.data.orders[0].refundedAmountInCents).toBe(500);
    });
  });

  describe('2. Refund Preview, Idempotency Replay & Free Ticket Local Cancellation', () => {
    it('replays duplicate Idempotency-Key cleanly and rejects payload mismatch with 409', async () => {
      const existingOrderRefund = {
        id: 'or_idem_1',
        orderId: 'ord_1',
        status: OrderRefundStatus.PENDING,
        currency: 'USD',
        amountInCents: 2395,
        organizerDebitInCents: 2000,
        platformExpenseInCents: 0,
        refundStripeProcessingFee: false,
        feeBearer: RefundFeeBearer.ORGANIZER,
        restoreInventory: true,
      };

      const txReplayMock: any = {
        order: {
          findUnique: vi.fn().mockResolvedValue({
            id: 'ord_1',
            totalInCents: 4990,
            currency: 'USD',
            paymentReference: 'pi_idem_1',
            stripeSettledChargeId: 'ch_1',
            event: { id: 'evt_1', organizerId: 'org_1' },
            transactions: [{ providerTransactionId: 'pi_idem_1' }],
          }),
        },
        orderRefundTicket: {
          findMany: vi.fn().mockResolvedValue([{ ticketId: 'tkt_a' }]),
        },
      };

      vi.spyOn(prisma, '$transaction').mockImplementation(async (cb: any) => cb(txReplayMock));
      vi.spyOn(refundAdmission, 'initiateTicketRefundInTx').mockResolvedValue({
        created: false,
        orderRefund: existingOrderRefund as any,
        quote: null,
        checkedInOverrideAudited: false,
      });
      const wakeSpy = vi.spyOn(refundWorker, 'triggerOrderRefundDispatch').mockImplementation(() => {});

      const replayed = await initiateOrderTicketRefund(
        'ord_1',
        { userId: 'org_1', role: Role.ORGANIZER },
        {
          ticketIds: ['tkt_a'],
          reason: 'Attendee requested refund',
          refundStripeProcessingFee: false,
          restoreInventory: true,
          allowCheckedInOverride: false,
          confirm: true,
        },
        { headerIdempotencyKey: 'idem-key-0001' }
      );

      expect(replayed.replayed).toBe(true);
      expect(replayed.orderRefundId).toBe('or_idem_1');
      expect(wakeSpy).toHaveBeenCalledTimes(1);

      // Reusing same Idempotency-Key with DIFFERENT ticket set fails 409 ConflictError
      await expect(
        initiateOrderTicketRefund(
          'ord_1',
          { userId: 'org_1', role: Role.ORGANIZER },
          {
            ticketIds: ['tkt_b'],
            reason: 'Different ticket with same key',
            refundStripeProcessingFee: false,
            restoreInventory: true,
            allowCheckedInOverride: false,
            confirm: true,
          },
          { headerIdempotencyKey: 'idem-key-0001' }
        )
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it('executes free $0 ticket cancellation locally and advances waitlist post-commit without calling Stripe', async () => {
      const txFreeMock: any = {
        order: {
          findUnique: vi.fn().mockResolvedValue({
            id: 'ord_free_1',
            orderNumber: 'OUT-FREE-1',
            totalInCents: 0,
            currency: 'USD',
            event: { id: 'evt_1', organizerId: 'org_1' },
            transactions: [],
          }),
        },
        ticket: {
          findMany: vi.fn().mockResolvedValue([{ id: 'tkt_free_1', status: TicketStatus.ISSUED }]),
        },
      };

      vi.spyOn(prisma, '$transaction').mockImplementation(async (cb: any) => cb(txFreeMock));
      const freeExecSpy = vi
        .spyOn(refundAdmission, 'executeLocalFreeTicketCancellationInTx')
        .mockResolvedValueOnce({
          plan: {
            orderId: 'ord_free_1',
            ticketIds: ['tkt_free_1'],
            initiatorRole: RefundInitiatorRole.ORGANIZER,
            initiatedByUserId: 'org_1',
            reason: 'Attendee cancelled',
            restoreInventory: true,
            inventoryReleaseByTier: [{ ticketTierId: 'tier_free_1', quantity: 1 }],
          },
          inventoryRestoredCount: 1,
          tiersToAdvanceWaitlist: ['tier_free_1'],
        });
      const waitlistSpy = vi
        .spyOn(refundAdmission, 'triggerPostCommitWaitlistAdvancement')
        .mockResolvedValueOnce(undefined);
      const stripeCreateSpy = vi.spyOn(stripe.refunds, 'create');

      const result = await initiateOrderTicketRefund(
        'ord_free_1',
        { userId: 'org_1', role: Role.ORGANIZER },
        {
          ticketIds: ['tkt_free_1'],
          reason: 'Attendee cancelled',
          refundStripeProcessingFee: false,
          restoreInventory: true,
          allowCheckedInOverride: false,
          confirm: true,
        },
        { headerIdempotencyKey: 'free-cancel-key-01' }
      );

      expect(result.mode).toBe('FREE_LOCAL_CANCELLED');
      expect(result.refundAmountInCents).toBe(0);
      expect(result.inventoryRestoredCount).toBe(1);
      expect(freeExecSpy).toHaveBeenCalledTimes(1);
      expect(waitlistSpy).toHaveBeenCalledWith(['tier_free_1']);
      expect(stripeCreateSpy).not.toHaveBeenCalled();
    });
  });

  describe('3. Durable Worker Execution, Partial Refunds & Failure Escalation', () => {
    it('executes second partial buyer refund on shared PI while excluding first partial sibling, then enqueues confirmed email & waitlist post-commit', async () => {
      const item2 = {
        id: 'or_partial_2',
        orderId: 'ord_multi_1',
        stripePaymentIntentId: 'pi_multi_1',
        stripeChargeId: 'ch_multi_1',
        stripeRefundId: null,
        idempotencyKey: 'ticket-refund:or_partial_2',
        refundKind: OrderRefundKind.ORGANIZER_TICKET_REFUND,
        initiatedByUserId: 'org_1',
        amountInCents: 2395,
        currency: 'USD',
        reason: 'Second partial refund',
        status: OrderRefundStatus.PROCESSING,
        attempts: 1,
        maxAttempts: 8,
        lockedBy: 'worker-d',
      } as any;

      // Stripe has sibling refund #1 (re_1 for or_partial_1)
      vi.spyOn(stripe.refunds, 'list').mockResolvedValueOnce({
        data: [
          {
            id: 're_1',
            amount: 2395,
            currency: 'usd',
            status: 'succeeded',
            metadata: { orderRefundId: 'or_partial_1' },
          },
        ],
        has_more: false,
      } as any);

      vi.spyOn(prisma.orderRefund, 'findMany').mockResolvedValueOnce([
        { id: 'or_partial_1', stripeRefundId: 're_1' } as any,
      ]);

      const stripeCreateSpy = vi.spyOn(stripe.refunds, 'create').mockResolvedValueOnce({
        id: 're_2',
        amount: 2395,
        currency: 'usd',
        status: 'succeeded',
        charge: 'ch_multi_1',
      } as any);

      const txWorkerMock: any = {
        order: {
          findUnique: vi.fn().mockResolvedValueOnce({
            id: 'ord_multi_1',
            orderNumber: 'OUT-MULTI-1',
            customerEmail: 'buyer@example.com',
            customerName: 'Multi Buyer',
            event: { title: 'Rooftop Party' },
          }),
        },
        orderRefundTicket: { count: vi.fn().mockResolvedValueOnce(1) },
        ticket: { count: vi.fn().mockResolvedValueOnce(2) },
        emailOutbox: {
          createMany: vi.fn().mockResolvedValueOnce({ count: 1 }),
        },
      };

      vi.spyOn(prisma, '$transaction').mockImplementationOnce(async (cb: any) => cb(txWorkerMock));
      vi.spyOn(refundAdmission, 'confirmTicketRefundSucceededInTx').mockResolvedValueOnce({
        alreadyFinalized: false,
        orderRefund: { ...item2, status: OrderRefundStatus.SUCCEEDED, stripeRefundId: 're_2' },
        orderFullyRefunded: false,
        ledgerRecorded: true,
        inventoryRestoredCount: 1,
        tiersToAdvanceWaitlist: ['tier_multi_1'],
      });
      const waitlistSpy = vi
        .spyOn(refundAdmission, 'triggerPostCommitWaitlistAdvancement')
        .mockResolvedValueOnce(undefined);

      const outcome = await processClaimedOrderRefundItem(item2, 'worker-d');

      expect(outcome).toBe('succeeded');
      expect(stripeCreateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          payment_intent: 'pi_multi_1',
          amount: 2395,
          metadata: expect.objectContaining({
            orderRefundId: 'or_partial_2',
            refundKind: OrderRefundKind.ORGANIZER_TICKET_REFUND,
          }),
        }),
        { idempotencyKey: 'ticket-refund:or_partial_2' }
      );
      expect(txWorkerMock.emailOutbox.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [
            expect.objectContaining({
              type: EmailOutboxType.BUYER_REFUND_CONFIRMED,
              dedupeKey: 'buyer_refund_confirmed:or_partial_2',
            }),
          ],
        })
      );
      expect(waitlistSpy).toHaveBeenCalledWith(['tier_multi_1']);
    });

    it('transitions to STRIPE_PENDING without emitting confirmation email when Stripe returns pending', async () => {
      const pendingItem = {
        id: 'or_pend_1',
        orderId: 'ord_p_1',
        stripePaymentIntentId: 'pi_p_1',
        stripeRefundId: null,
        idempotencyKey: 'ticket-refund:or_pend_1',
        refundKind: OrderRefundKind.ORGANIZER_TICKET_REFUND,
        amountInCents: 2000,
        currency: 'USD',
        reason: 'Pending test',
        status: OrderRefundStatus.PROCESSING,
        attempts: 1,
        maxAttempts: 8,
        lockedBy: 'worker-d',
      } as any;

      vi.spyOn(stripe.refunds, 'list').mockResolvedValueOnce({ data: [], has_more: false } as any);
      vi.spyOn(prisma.orderRefund, 'findMany').mockResolvedValueOnce([]);
      vi.spyOn(stripe.refunds, 'create').mockResolvedValueOnce({
        id: 're_pending_1',
        amount: 2000,
        currency: 'usd',
        status: 'pending',
      } as any);

      const updateManySpy = vi
        .spyOn(prisma.orderRefund, 'updateMany')
        .mockResolvedValueOnce({ count: 1 });
      const createEmailSpy = vi.spyOn(prisma.emailOutbox, 'createMany');

      const outcome = await processClaimedOrderRefundItem(pendingItem, 'worker-d');

      expect(outcome).toBe('stripePending');
      expect(updateManySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: OrderRefundStatus.STRIPE_PENDING,
            stripeRefundId: 're_pending_1',
          }),
        })
      );
      expect(createEmailSpy).not.toHaveBeenCalled();
    });

    it('escalates permanent Stripe refund failure to MANUAL_REVIEW_REQUIRED and enqueues BUYER_REFUND_MANUAL_REVIEW (never confirmed)', async () => {
      const failItem = {
        id: 'or_fail_1',
        orderId: 'ord_f_1',
        stripePaymentIntentId: 'pi_f_1',
        stripeRefundId: null,
        idempotencyKey: 'ticket-refund:or_fail_1',
        refundKind: OrderRefundKind.ADMIN_TICKET_REFUND,
        amountInCents: 3000,
        currency: 'USD',
        reason: 'Admin override refund',
        status: OrderRefundStatus.PROCESSING,
        attempts: 1,
        maxAttempts: 8,
        lockedBy: 'worker-d',
      } as any;

      vi.spyOn(stripe.refunds, 'list').mockResolvedValueOnce({ data: [], has_more: false } as any);
      vi.spyOn(prisma.orderRefund, 'findMany').mockResolvedValueOnce([]);
      vi.spyOn(stripe.refunds, 'create').mockResolvedValueOnce({
        id: 're_fail_1',
        amount: 3000,
        currency: 'usd',
        status: 'failed',
        failure_reason: 'expired_or_canceled_card',
      } as any);

      const txFailMock: any = {
        $queryRaw: vi.fn().mockResolvedValueOnce([{ id: 'ord_f_1' }]),
        order: {
          findUnique: vi.fn().mockResolvedValueOnce({
            id: 'ord_f_1',
            orderNumber: 'OUT-FAIL-1',
            customerEmail: 'fail@example.com',
            customerName: 'Fail Buyer',
            event: { title: 'Test Event' },
          }),
        },
        orderRefund: { updateMany: vi.fn().mockResolvedValueOnce({ count: 1 }) },
        orderRefundTicket: { count: vi.fn().mockResolvedValueOnce(1) },
        ticket: { count: vi.fn().mockResolvedValueOnce(1) },
        emailOutbox: { createMany: vi.fn().mockResolvedValueOnce({ count: 1 }) },
      };

      vi.spyOn(prisma, '$transaction').mockImplementationOnce(async (cb: any) => cb(txFailMock));

      const outcome = await processClaimedOrderRefundItem(failItem, 'worker-d');

      expect(outcome).toBe('manualReview');
      expect(txFailMock.orderRefund.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: OrderRefundStatus.MANUAL_REVIEW_REQUIRED,
            requiresManualResolution: true,
            stripeRefundId: 're_fail_1',
          }),
        })
      );
      expect(txFailMock.emailOutbox.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [
            expect.objectContaining({
              type: EmailOutboxType.BUYER_REFUND_MANUAL_REVIEW,
              dedupeKey: 'buyer_refund_manual_review:or_fail_1',
            }),
          ],
        })
      );
    });
  });

  describe('4. Stripe Webhook Reconciliation & External Dashboard Refunds', () => {
    it('reconciles multiple partial buyer refunds on charge.refunded without double-posting pro-rata recordRefundLedger', async () => {
      const ord = {
        id: 'ord_wh_multi',
        orderNumber: 'OUT-WHM-1',
        status: OrderStatus.COMPLETED,
        currency: 'USD',
        totalInCents: 4990,
        refundedAmountInCents: 0,
        pendingRefundAmountInCents: 4790,
        paymentReference: 'pi_whm_1',
        customerEmail: 'buyer@example.com',
        customerName: 'WH Buyer',
        eventId: 'evt_whm_1',
        event: { id: 'evt_whm_1', title: 'WH Event', organizerId: 'org_1' },
        items: [],
      };

      const buyerRef1 = {
        id: 'or_wh_1',
        orderId: 'ord_wh_multi',
        stripePaymentIntentId: 'pi_whm_1',
        stripeChargeId: 'ch_whm_1',
        stripeRefundId: 're_wh_1',
        refundKind: OrderRefundKind.ORGANIZER_TICKET_REFUND,
        initiatedByUserId: 'org_1',
        amountInCents: 2395,
        currency: 'USD',
        reason: 'Partial 1',
        status: OrderRefundStatus.SUCCEEDED, // already succeeded earlier
        requiresManualResolution: false,
      };
      const buyerRef2 = {
        id: 'or_wh_2',
        orderId: 'ord_wh_multi',
        stripePaymentIntentId: 'pi_whm_1',
        stripeChargeId: 'ch_whm_1',
        stripeRefundId: 're_wh_2',
        refundKind: OrderRefundKind.ORGANIZER_TICKET_REFUND,
        initiatedByUserId: 'org_1',
        amountInCents: 2395,
        currency: 'USD',
        reason: 'Partial 2',
        status: OrderRefundStatus.STRIPE_PENDING,
        requiresManualResolution: false,
      };

      const txWhMock: any = {
        processedWebhookEvent: {
          findUnique: vi.fn().mockResolvedValueOnce(null),
          create: vi.fn().mockResolvedValueOnce({ id: 'pwe_whm' }),
        },
        $queryRaw: vi
          .fn()
          .mockResolvedValueOnce([{ id: ord.id }]) // lockOrderByIdentifier
          .mockResolvedValueOnce([]), // LATE_PAYMENT query
        order: {
          findUnique: vi.fn().mockResolvedValueOnce(ord),
        },
        orderRefund: {
          findMany: vi.fn().mockResolvedValueOnce([buyerRef1, buyerRef2]),
          findFirst: vi.fn().mockResolvedValueOnce(null),
        },
        orderRefundTicket: {
          count: vi.fn().mockResolvedValueOnce(1),
        },
        ticket: {
          count: vi.fn().mockResolvedValueOnce(2),
        },
        financialLedgerEntry: {
          findFirst: vi.fn().mockResolvedValueOnce({ id: 'sale_1' }),
        },
        emailOutbox: {
          createMany: vi.fn().mockResolvedValueOnce({ count: 1 }),
        },
      };

      vi.spyOn(prisma.processedWebhookEvent, 'findUnique').mockResolvedValueOnce(null);
      vi.spyOn(prisma, '$transaction').mockImplementationOnce(async (cb: any) => cb(txWhMock));

      const confirmSpy = vi
        .spyOn(refundAdmission, 'confirmTicketRefundSucceededInTx')
        .mockResolvedValueOnce({
          alreadyFinalized: false,
          orderRefund: { ...buyerRef2, status: OrderRefundStatus.SUCCEEDED } as any,
          orderFullyRefunded: true,
          ledgerRecorded: true,
          inventoryRestoredCount: 1,
          tiersToAdvanceWaitlist: ['tier_whm_1'],
        });
      const proRataLedgerSpy = vi.spyOn(ledgerService, 'recordRefundLedger');

      await processStripeWebhookEvent({
        id: 'evt_whm_charge_refunded',
        type: 'charge.refunded',
        data: {
          object: {
            id: 'ch_whm_1',
            amount_refunded: 4790,
            currency: 'usd',
            payment_intent: 'pi_whm_1',
            metadata: { orderId: ord.id },
            refunds: {
              has_more: false,
              data: [
                {
                  id: 're_wh_1',
                  amount: 2395,
                  currency: 'usd',
                  status: 'succeeded',
                  payment_intent: 'pi_whm_1',
                  metadata: { orderRefundId: 'or_wh_1' },
                },
                {
                  id: 're_wh_2',
                  amount: 2395,
                  currency: 'usd',
                  status: 'succeeded',
                  payment_intent: 'pi_whm_1',
                  metadata: { orderRefundId: 'or_wh_2' },
                },
              ],
            },
          },
        },
      } as any);

      // Finalized ONLY buyerRef2 (buyerRef1 was skipped cleanly since SUCCEEDED)
      expect(confirmSpy).toHaveBeenCalledTimes(1);
      expect(confirmSpy).toHaveBeenCalledWith(
        txWhMock,
        expect.objectContaining({ orderRefundId: 'or_wh_2', stripeRefundId: 're_wh_2' })
      );
      // Both re_wh_1 and re_wh_2 are tracked -> pro-rata recordRefundLedger MUST NOT be called!
      expect(proRataLedgerSpy).not.toHaveBeenCalled();
      expect(txWhMock.emailOutbox.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [
            expect.objectContaining({
              type: EmailOutboxType.BUYER_REFUND_CONFIRMED,
              dedupeKey: 'buyer_refund_confirmed:or_wh_2',
            }),
          ],
        })
      );
    });

    it('reconciles untracked external Stripe Dashboard refund separately while preserving tracked buyer refund ledger', async () => {
      const ord = {
        id: 'ord_ext_1',
        orderNumber: 'OUT-EXT-1',
        status: OrderStatus.COMPLETED,
        currency: 'USD',
        totalInCents: 4990,
        refundedAmountInCents: 2395,
        pendingRefundAmountInCents: 0,
        paymentReference: 'pi_ext_1',
        customerEmail: 'buyer@example.com',
        customerName: 'EXT Buyer',
        eventId: 'evt_ext_1',
        event: { id: 'evt_ext_1', title: 'Ext Event', organizerId: 'org_1' },
        items: [],
      };

      const trackedBuyer = {
        id: 'or_tracked_1',
        orderId: 'ord_ext_1',
        stripePaymentIntentId: 'pi_ext_1',
        stripeRefundId: 're_tracked_1',
        refundKind: OrderRefundKind.ORGANIZER_TICKET_REFUND,
        amountInCents: 2395,
        currency: 'USD',
        status: OrderRefundStatus.SUCCEEDED,
        requiresManualResolution: false,
      };

      const txExtMock: any = {
        processedWebhookEvent: {
          findUnique: vi.fn().mockResolvedValueOnce(null),
          create: vi.fn().mockResolvedValueOnce({ id: 'pwe_ext' }),
        },
        $queryRaw: vi
          .fn()
          .mockResolvedValueOnce([{ id: ord.id }])
          .mockResolvedValueOnce([]),
        order: {
          findUnique: vi.fn().mockResolvedValueOnce(ord),
          update: vi.fn().mockResolvedValueOnce({ ...ord, refundedAmountInCents: 3395 }),
        },
        orderRefund: {
          findMany: vi.fn().mockResolvedValueOnce([trackedBuyer]),
          findFirst: vi.fn().mockResolvedValueOnce(null),
        },
        financialLedgerEntry: {
          findFirst: vi.fn().mockResolvedValueOnce({ id: 'sale_ext' }),
        },
      };

      vi.spyOn(prisma.processedWebhookEvent, 'findUnique').mockResolvedValueOnce(null);
      vi.spyOn(prisma, '$transaction').mockImplementationOnce(async (cb: any) => cb(txExtMock));
      const recordRefundSpy = vi
        .spyOn(ledgerService, 'recordRefundLedger')
        .mockResolvedValueOnce(undefined);

      await processStripeWebhookEvent({
        id: 'evt_ext_dashboard',
        type: 'charge.refunded',
        data: {
          object: {
            id: 'ch_ext_1',
            amount_refunded: 3395,
            currency: 'usd',
            payment_intent: 'pi_ext_1',
            metadata: { orderId: ord.id },
            refunds: {
              has_more: false,
              data: [
                {
                  id: 're_tracked_1',
                  amount: 2395,
                  currency: 'usd',
                  status: 'succeeded',
                  payment_intent: 'pi_ext_1',
                  metadata: { orderRefundId: 'or_tracked_1' },
                },
                {
                  id: 're_dashboard_ext_2',
                  amount: 1000,
                  currency: 'usd',
                  status: 'succeeded',
                  payment_intent: 'pi_ext_1',
                  metadata: {},
                },
              ],
            },
          },
        },
      } as any);

      // Only the untracked $10 external Dashboard refund calls recordRefundLedger
      expect(recordRefundSpy).toHaveBeenCalledTimes(1);
      expect(recordRefundSpy).toHaveBeenCalledWith(
        txExtMock,
        expect.objectContaining({
          orderId: 'ord_ext_1',
          amountInCents: 1000,
          stripeRefundId: 're_dashboard_ext_2',
        })
      );
    });
  });

  describe('5. Buyer Refund Email Outbox Dispatch', () => {
    it('renders and dispatches BUYER_REFUND_CONFIRMED and BUYER_REFUND_MANUAL_REVIEW through EmailOutbox and blocks premature CONFIRMED notices', async () => {
      const confirmedSnapshot = {
        templateVersion: BUYER_REFUND_TEMPLATE_VERSION,
        orderRefundId: 'or_email_1',
        fromEmail: 'tickets@outside.vip',
        orderNumber: 'OUT-EMAIL-1',
        refundAmountInCents: 2395,
        currency: 'USD',
        buyerName: 'Dana Buyer',
        eventTitle: 'Desert Gathering',
        ticketCount: 1,
        isPartialRefund: true,
        stripeRefundId: 're_email_1',
        confirmedAtIso: '2026-11-24T20:00:00.000Z',
        reasonSummary: 'Schedule conflict',
      };

      const manualSnapshot = {
        ...confirmedSnapshot,
        orderRefundId: 'or_email_2',
        stripeRefundId: null,
        confirmedAtIso: null,
      };

      const prematureSnapshot = {
        ...confirmedSnapshot,
        orderRefundId: 'or_email_premature',
      };

      const txEnqueueMock: any = {
        emailOutbox: {
          createMany: vi.fn().mockResolvedValueOnce({ count: 1 }),
        },
      };
      const enqueued = await enqueueBuyerRefundEmail(txEnqueueMock, {
        kind: 'CONFIRMED',
        orderRefundId: 'or_email_1',
        orderId: 'ord_e_1',
        recipientEmail: 'DANA@example.com',
        snapshot: confirmedSnapshot,
      });
      expect(enqueued).toEqual({
        enqueued: true,
        dedupeKey: 'buyer_refund_confirmed:or_email_1',
        idempotencyKey: 'buyer-refund-confirmed:or_email_1',
      });

      vi.spyOn(prisma, '$queryRaw')
        .mockResolvedValueOnce([]) // reapExpiredExhaustedEmailLeases
        .mockResolvedValueOnce([
          {
            id: 'eb_1',
            type: EmailOutboxType.BUYER_REFUND_CONFIRMED,
            status: EmailOutboxStatus.PROCESSING,
            recipientEmail: 'dana@example.com',
            idempotencyKey: 'buyer-refund-confirmed:or_email_1',
            contentSnapshot: confirmedSnapshot,
            attempts: 1,
            maxAttempts: 8,
            lockedBy: 'outbox-w1',
          },
          {
            id: 'eb_2',
            type: EmailOutboxType.BUYER_REFUND_MANUAL_REVIEW,
            status: EmailOutboxStatus.PROCESSING,
            recipientEmail: 'dana@example.com',
            idempotencyKey: 'buyer-refund-manual-review:or_email_2',
            contentSnapshot: manualSnapshot,
            attempts: 1,
            maxAttempts: 8,
            lockedBy: 'outbox-w1',
          },
          {
            id: 'eb_3',
            type: EmailOutboxType.BUYER_REFUND_CONFIRMED,
            status: EmailOutboxStatus.PROCESSING,
            recipientEmail: 'dana@example.com',
            idempotencyKey: 'buyer-refund-confirmed:or_email_premature',
            contentSnapshot: prematureSnapshot,
            attempts: 1,
            maxAttempts: 8,
            lockedBy: 'outbox-w1',
          },
        ] as any);

      vi.spyOn(prisma.orderRefund, 'findUnique')
        .mockResolvedValueOnce({
          id: 'or_email_1',
          status: OrderRefundStatus.SUCCEEDED,
          requiresManualResolution: false,
          stripeRefundId: 're_email_1',
        } as any)
        .mockResolvedValueOnce({
          id: 'or_email_2',
          status: OrderRefundStatus.MANUAL_REVIEW_REQUIRED,
          requiresManualResolution: true,
          stripeRefundId: null,
        } as any)
        .mockResolvedValueOnce({
          id: 'or_email_premature',
          status: OrderRefundStatus.STRIPE_PENDING,
          requiresManualResolution: false,
          stripeRefundId: 're_pending_x',
        } as any);

      const outboxUpdateSpy = vi
        .spyOn(prisma.emailOutbox, 'updateMany')
        .mockResolvedValue({ count: 1 });

      const stats = await runEmailOutboxPass({ workerId: 'outbox-w1' });

      expect(stats.accepted).toBe(2);
      expect(stats.failedPermanent).toBe(1);
      expect(outboxUpdateSpy).toHaveBeenCalledTimes(3);
      expect(sentBuyerRefundEmails).toHaveLength(2);
      expect(sentBuyerRefundEmails[0].kind).toBe('CONFIRMED');
      expect(sentBuyerRefundEmails[0].text).toContain('partial ticket refund (1 ticket)');
      expect(sentBuyerRefundEmails[1].kind).toBe('MANUAL_REVIEW');
      expect(sentBuyerRefundEmails[1].subject).toContain('Refund review in progress');
    });
  });
});
