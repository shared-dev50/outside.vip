import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import {
  CheckInResult,
  EmailOutboxType,
  OrderRefundKind,
  OrderRefundStatus,
  OrderRefundTicketLockState,
  Prisma,
  RefundFeeBearer,
  RefundInitiatorRole,
  TicketStatus,
} from '@prisma/client';
import {
  allocateOrderTicketPayments,
  buildLatePaymentRefundIdempotencyKey,
  classifyOrderRefundCounterBucket,
  computeLocalFreeTicketCancellationPlan,
  computeTicketRefundQuote,
  distributeIntegerCents,
  reconcileOrderRefundCountersFromRecords,
  RefundDomainRuleError,
  resolveLockStateForOrderRefundStatus,
  validateFreeTicketCancellationSelection,
  validateTicketRefundSelection,
} from '../modules/refunds/refundAllocation.domain.js';
import { calculateCheckoutFeeBreakdown } from '../modules/checkout/checkout.financials.js';

const SERVER_ROOT = path.resolve(__dirname, '../..');
const SCHEMA_PATH = path.join(SERVER_ROOT, 'prisma/schema.prisma');
const MIGRATION_SQL_PATH = path.join(
  SERVER_ROOT,
  'prisma/migrations/20261124235000_p0_03_refund_schema_domain_foundation/migration.sql'
);

describe('Stage 4 P0-03 Workstream B — Refund Schema & Domain Foundation', () => {
  describe('Prisma DMMF & SQL migration constraints', () => {
    it('drops unique constraint on OrderRefund.stripePaymentIntentId while keeping idempotencyKey and stripeRefundId unique', () => {
      const orderRefundModel = Prisma.dmmf.datamodel.models.find((m) => m.name === 'OrderRefund');
      expect(orderRefundModel).toBeDefined();

      const piField = orderRefundModel!.fields.find((f) => f.name === 'stripePaymentIntentId');
      const idemField = orderRefundModel!.fields.find((f) => f.name === 'idempotencyKey');
      const refundIdField = orderRefundModel!.fields.find((f) => f.name === 'stripeRefundId');

      expect(piField?.isUnique).toBe(false);
      expect(idemField?.isUnique).toBe(true);
      expect(refundIdField?.isUnique).toBe(true);

      expect(orderRefundModel!.uniqueFields).toContainEqual(['id', 'orderId']);
    });

    it('adds P0-03 enums, Order cumulative refund counters, Ticket allocations, and OrderRefundTicket join model', () => {
      const orderModel = Prisma.dmmf.datamodel.models.find((m) => m.name === 'Order');
      const ticketModel = Prisma.dmmf.datamodel.models.find((m) => m.name === 'Ticket');
      const refundModel = Prisma.dmmf.datamodel.models.find((m) => m.name === 'OrderRefund');
      const joinModel = Prisma.dmmf.datamodel.models.find((m) => m.name === 'OrderRefundTicket');

      expect(orderModel?.fields.map((f) => f.name)).toEqual(
        expect.arrayContaining(['refundedAmountInCents', 'pendingRefundAmountInCents', 'refundTickets'])
      );

      expect(ticketModel?.fields.map((f) => f.name)).toEqual(
        expect.arrayContaining([
          'allocatedGrossInCents',
          'allocatedPlatformFeeInCents',
          'allocatedServiceFeeInCents',
          'allocatedProcessingFeeInCents',
          'allocatedBuyerTotalInCents',
          'refundedAt',
          'refundedByUserId',
          'cancelledAt',
          'cancelledByUserId',
          'cancellationReason',
          'refundAllocations',
        ])
      );
      expect(ticketModel?.uniqueFields).toContainEqual(['id', 'orderId']);

      // Composite relationships modeled natively in Prisma with RESTRICT deletion semantics
      const refundRel = joinModel?.fields.find((f) => f.name === 'orderRefund');
      const ticketRel = joinModel?.fields.find((f) => f.name === 'ticket');
      const orderRel = joinModel?.fields.find((f) => f.name === 'order');
      expect(refundRel?.relationFromFields).toEqual(['orderRefundId', 'orderId']);
      expect(refundRel?.relationToFields).toEqual(['id', 'orderId']);
      expect(refundRel?.relationOnDelete).toBe('Restrict');
      expect(ticketRel?.relationFromFields).toEqual(['ticketId', 'orderId']);
      expect(ticketRel?.relationToFields).toEqual(['id', 'orderId']);
      expect(ticketRel?.relationOnDelete).toBe('Restrict');
      expect(orderRel?.relationOnDelete).toBe('Restrict');

      expect(refundModel?.fields.map((f) => f.name)).toEqual(
        expect.arrayContaining([
          'refundKind',
          'initiatorRole',
          'initiatedByUserId',
          'feeBearer',
          'refundStripeProcessingFee',
          'ticketSubtotalInCents',
          'platformFeeReversedInCents',
          'serviceFeeReversedInCents',
          'processingFeeInCents',
          'organizerDebitInCents',
          'platformExpenseInCents',
          'restoreInventory',
          'inventoryRestoredCount',
          'cancelledAt',
          'cancellationReason',
          'refundTickets',
        ])
      );

      expect(joinModel).toBeDefined();
      expect(joinModel!.uniqueFields).toContainEqual(['orderRefundId', 'ticketId']);

      // Verify added enum values compile and resolve properly from @prisma/client
      expect(TicketStatus.REFUND_PENDING).toBe('REFUND_PENDING');
      expect(CheckInResult.REFUND_PENDING_TICKET).toBe('REFUND_PENDING_TICKET');
      expect(CheckInResult.REFUNDED_TICKET).toBe('REFUNDED_TICKET');
      expect(OrderRefundStatus.CANCELLED).toBe('CANCELLED');
      expect(EmailOutboxType.BUYER_REFUND_CONFIRMED).toBe('BUYER_REFUND_CONFIRMED');
      expect(EmailOutboxType.BUYER_REFUND_MANUAL_REVIEW).toBe('BUYER_REFUND_MANUAL_REVIEW');
      expect(OrderRefundKind.LATE_PAYMENT).toBe('LATE_PAYMENT');
      expect(OrderRefundKind.ORGANIZER_TICKET_REFUND).toBe('ORGANIZER_TICKET_REFUND');
      expect(OrderRefundKind.ADMIN_TICKET_REFUND).toBe('ADMIN_TICKET_REFUND');
      expect(OrderRefundTicketLockState.ACTIVE_PENDING).toBe('ACTIVE_PENDING');
      expect(OrderRefundTicketLockState.CONFIRMED).toBe('CONFIRMED');
      expect(OrderRefundTicketLockState.RELEASED).toBe('RELEASED');
    });

    it('declares SQL partial unique index, cumulative cap check constraints, and composite order-ticket FKs', () => {
      const schemaText = fs.readFileSync(SCHEMA_PATH, 'utf8');
      const migrationSql = fs.readFileSync(MIGRATION_SQL_PATH, 'utf8');

      expect(schemaText).toContain('@@index([stripePaymentIntentId])');
      expect(migrationSql).toContain('DROP INDEX IF EXISTS "OrderRefund_stripePaymentIntentId_key"');
      expect(migrationSql).toContain('Order_cumulativeRefundCap_chk');
      expect(migrationSql).toContain('"refundedAmountInCents" + "pendingRefundAmountInCents" <= "totalInCents"');
      expect(migrationSql).toContain('Ticket_persistedAllocation_chk');
      expect(migrationSql).toContain('OrderRefund_amounts_chk');
      expect(migrationSql).toContain('OrderRefundTicket_amounts_chk');
      expect(migrationSql).toContain('OrderRefundTicket_active_or_confirmed_ticket_key');
      expect(migrationSql).toContain('WHERE "lockState" IN (\'ACTIVE_PENDING\', \'CONFIRMED\')');
      expect(migrationSql).toContain('FOREIGN KEY ("orderRefundId", "orderId") REFERENCES "OrderRefund"("id", "orderId") ON DELETE RESTRICT ON UPDATE RESTRICT');
      expect(migrationSql).toContain('FOREIGN KEY ("ticketId", "orderId") REFERENCES "Ticket"("id", "orderId") ON DELETE RESTRICT ON UPDATE RESTRICT');
      expect(migrationSql).not.toContain('ON DELETE CASCADE');
      expect(migrationSql).toContain('--create-only');
    });
  });

  describe('Deterministic per-ticket payment allocation', () => {
    it('distributes odd remainder cents deterministically without losing or inventing cents', () => {
      expect(distributeIntegerCents(100, [1, 1, 1])).toEqual([34, 33, 33]);
      expect(distributeIntegerCents(10, [300, 100])).toEqual([8, 2]);
      expect(distributeIntegerCents(0, [100, 200])).toEqual([0, 0]);
      expect(distributeIntegerCents(5, [0, 0, 0])).toEqual([2, 2, 1]);
    });

    it('allocates exact integer-cent shares matching canonical checkout totals across odd quantities and multi-tier carts', () => {
      const testCases: Array<Array<{ priceInCents: number; quantity: number }>> = [
        [{ priceInCents: 1, quantity: 1 }], // minimum positive gross ($1.30 buyer total)
        [{ priceInCents: 2000, quantity: 3 }],
        [{ priceInCents: 1337, quantity: 7 }],
        [
          { priceInCents: 1500, quantity: 2 },
          { priceInCents: 4250, quantity: 3 },
          { priceInCents: 10000, quantity: 1 },
        ],
        [
          { priceInCents: 0, quantity: 1 },
          { priceInCents: 1234, quantity: 5 },
          { priceInCents: 99, quantity: 2 },
        ],
      ];

      for (let caseIdx = 0; caseIdx < testCases.length; caseIdx++) {
        const cart = testCases[caseIdx];
        const checkout = calculateCheckoutFeeBreakdown(cart);

        const tickets = cart.flatMap((line, tierIdx) =>
          Array.from({ length: line.quantity }, (_, qIdx) => ({
            ticketId: `tkt_${caseIdx}_${tierIdx}_${qIdx}`,
            ticketTierId: `tier_${tierIdx}`,
            grossPriceInCents: line.priceInCents,
          }))
        );

        const allocated = allocateOrderTicketPayments(
          { buyerTotalInCents: checkout.buyerTotalInCents },
          tickets
        );

        expect(allocated.tickets).toHaveLength(tickets.length);
        expect(allocated.buyerTotalInCents).toBe(checkout.buyerTotalInCents);

        const sumGross = allocated.tickets.reduce((s, t) => s + t.allocatedGrossInCents, 0);
        const sumPlatform = allocated.tickets.reduce((s, t) => s + t.allocatedPlatformFeeInCents, 0);
        const sumService = allocated.tickets.reduce((s, t) => s + t.allocatedServiceFeeInCents, 0);
        const sumProcessing = allocated.tickets.reduce((s, t) => s + t.allocatedProcessingFeeInCents, 0);
        const sumBuyerTotal = allocated.tickets.reduce((s, t) => s + t.allocatedBuyerTotalInCents, 0);

        expect(sumGross).toBe(checkout.ticketSubtotalInCents);
        expect(sumPlatform).toBe(checkout.platformFeeInCents);
        expect(sumService).toBe(checkout.serviceFeeInCents);
        expect(sumProcessing).toBe(checkout.processingFeeInCents);
        expect(sumBuyerTotal).toBe(checkout.buyerTotalInCents);

        for (const t of allocated.tickets) {
          expect(t.allocatedBuyerTotalInCents).toBe(
            t.allocatedGrossInCents +
              t.allocatedPlatformFeeInCents +
              t.allocatedServiceFeeInCents +
              t.allocatedProcessingFeeInCents
          );
        }

        // Re-running with identical ticket sequence yields identical per-ticket values
        const secondRun = allocateOrderTicketPayments(
          { buyerTotalInCents: checkout.buyerTotalInCents },
          tickets
        );
        expect(secondRun.tickets).toEqual(allocated.tickets);
      }
    });

    it('allocates exact zeroes for $0 free orders and rejects inconsistent free totals', () => {
      const freeAllocation = allocateOrderTicketPayments(
        { buyerTotalInCents: 0 },
        [
          { ticketId: 't_free_1', ticketTierId: 'tier_free', grossPriceInCents: 0 },
          { ticketId: 't_free_2', ticketTierId: 'tier_free', grossPriceInCents: 0 },
        ]
      );
      expect(freeAllocation.buyerTotalInCents).toBe(0);
      expect(freeAllocation.tickets.every((t) => t.allocatedBuyerTotalInCents === 0)).toBe(true);

      expect(() =>
        allocateOrderTicketPayments(
          { buyerTotalInCents: 0 },
          [{ ticketId: 't_bad', ticketTierId: 'tier_paid', grossPriceInCents: 500 }]
        )
      ).toThrow();
    });

    it('rejects mismatched order totals instead of silently dropping cents', () => {
      const checkout = calculateCheckoutFeeBreakdown([{ priceInCents: 2500, quantity: 2 }]);
      expect(() =>
        allocateOrderTicketPayments(
          { buyerTotalInCents: checkout.buyerTotalInCents + 1 },
          [
            { ticketId: 't1', ticketTierId: 'tier_1', grossPriceInCents: 2500 },
            { ticketId: 't2', ticketTierId: 'tier_1', grossPriceInCents: 2500 },
          ]
        )
      ).toThrow();
    });
  });

  describe('Ticket refund constraints, repeated partial refunds, and cost attribution', () => {
    function buildSampleOrderTickets() {
      const cart = [
        { priceInCents: 2000, quantity: 2 },
        { priceInCents: 5000, quantity: 1 },
      ];
      const checkout = calculateCheckoutFeeBreakdown(cart);
      const allocated = allocateOrderTicketPayments(
        { buyerTotalInCents: checkout.buyerTotalInCents },
        [
          { ticketId: 'tkt_1', ticketTierId: 'ga', grossPriceInCents: 2000 },
          { ticketId: 'tkt_2', ticketTierId: 'ga', grossPriceInCents: 2000 },
          { ticketId: 'tkt_3', ticketTierId: 'vip', grossPriceInCents: 5000 },
        ]
      );
      return {
        orderId: 'order_123',
        orderTotalInCents: checkout.buyerTotalInCents,
        tickets: allocated.tickets.map((t) => ({
          id: t.ticketId,
          orderId: 'order_123',
          status: TicketStatus.ISSUED,
          allocatedGrossInCents: t.allocatedGrossInCents,
          allocatedPlatformFeeInCents: t.allocatedPlatformFeeInCents,
          allocatedServiceFeeInCents: t.allocatedServiceFeeInCents,
          allocatedProcessingFeeInCents: t.allocatedProcessingFeeInCents,
          allocatedBuyerTotalInCents: t.allocatedBuyerTotalInCents,
          hasActiveOrConfirmedRefundLock: false,
        })),
      };
    }

    it('enforces initiator role, single-order selection, non-checked-in state, lock uniqueness, and persisted allocations', () => {
      const { orderId, orderTotalInCents, tickets } = buildSampleOrderTickets();

      expect(() =>
        validateTicketRefundSelection({
          orderId,
          orderTotalInCents,
          initiatorRole: RefundInitiatorRole.SYSTEM,
          tickets: [tickets[0]],
        })
      ).toThrow(RefundDomainRuleError);

      expect(() =>
        validateTicketRefundSelection({
          orderId,
          orderTotalInCents,
          initiatorRole: RefundInitiatorRole.ORGANIZER,
          tickets: [],
        })
      ).toThrow(/At least one ticket/);

      expect(() =>
        validateTicketRefundSelection({
          orderId,
          orderTotalInCents,
          initiatorRole: RefundInitiatorRole.ORGANIZER,
          tickets: [tickets[0], tickets[0]],
        })
      ).toThrow(/Duplicate ticketId/);

      expect(() =>
        validateTicketRefundSelection({
          orderId,
          orderTotalInCents,
          initiatorRole: RefundInitiatorRole.ADMIN,
          tickets: [{ ...tickets[0], orderId: 'other_order' }],
        })
      ).toThrow(/belongs to order/);

      expect(() =>
        validateTicketRefundSelection({
          orderId,
          orderTotalInCents,
          initiatorRole: RefundInitiatorRole.ORGANIZER,
          tickets: [{ ...tickets[0], status: TicketStatus.CHECKED_IN }],
        })
      ).toThrow(/CHECKED_IN/);

      expect(() =>
        validateTicketRefundSelection({
          orderId,
          orderTotalInCents,
          initiatorRole: RefundInitiatorRole.ORGANIZER,
          tickets: [{ ...tickets[0], status: TicketStatus.REFUND_PENDING }],
        })
      ).toThrow(/not eligible/);

      expect(() =>
        validateTicketRefundSelection({
          orderId,
          orderTotalInCents,
          initiatorRole: RefundInitiatorRole.ORGANIZER,
          tickets: [{ ...tickets[0], hasActiveOrConfirmedRefundLock: true }],
        })
      ).toThrow(/already in an active or confirmed refund/);

      expect(() =>
        validateTicketRefundSelection({
          orderId,
          orderTotalInCents,
          initiatorRole: RefundInitiatorRole.ORGANIZER,
          tickets: [{ ...tickets[0], allocatedBuyerTotalInCents: null }],
        })
      ).toThrow(/lacks persisted integer/);

      expect(() =>
        validateTicketRefundSelection({
          orderId,
          orderTotalInCents: 0,
          initiatorRole: RefundInitiatorRole.ORGANIZER,
          tickets: [
            {
              ...tickets[0],
              allocatedGrossInCents: 0,
              allocatedPlatformFeeInCents: 0,
              allocatedServiceFeeInCents: 0,
              allocatedProcessingFeeInCents: 0,
              allocatedBuyerTotalInCents: 0,
            },
          ],
        })
      ).toThrow(/Free orders/);
    });

    it('supports repeated partial refunds across tickets summing strictly to original payment and enforces cumulative cap', () => {
      const { orderId, orderTotalInCents, tickets } = buildSampleOrderTickets();

      const quote1 = computeTicketRefundQuote({
        orderId,
        orderTotalInCents,
        orderRefundedAmountInCents: 0,
        orderPendingRefundAmountInCents: 0,
        initiatorRole: RefundInitiatorRole.ORGANIZER,
        tickets: [tickets[0]],
        refundStripeProcessingFee: true,
        feeBearer: RefundFeeBearer.ORGANIZER,
      });

      const quote2 = computeTicketRefundQuote({
        orderId,
        orderTotalInCents,
        orderRefundedAmountInCents: quote1.refundAmountInCents,
        orderPendingRefundAmountInCents: 0,
        initiatorRole: RefundInitiatorRole.ADMIN,
        tickets: [tickets[1]],
        refundStripeProcessingFee: true,
        feeBearer: RefundFeeBearer.PLATFORM,
      });

      const quote3 = computeTicketRefundQuote({
        orderId,
        orderTotalInCents,
        orderRefundedAmountInCents: quote1.refundAmountInCents,
        orderPendingRefundAmountInCents: quote2.refundAmountInCents,
        initiatorRole: RefundInitiatorRole.ORGANIZER,
        tickets: [tickets[2]],
        refundStripeProcessingFee: true,
        feeBearer: RefundFeeBearer.SHARED,
      });

      expect(quote1.refundKind).toBe(OrderRefundKind.ORGANIZER_TICKET_REFUND);
      expect(quote2.refundKind).toBe(OrderRefundKind.ADMIN_TICKET_REFUND);
      expect(
        quote1.refundAmountInCents + quote2.refundAmountInCents + quote3.refundAmountInCents
      ).toBe(orderTotalInCents);
      expect(quote3.remainingOrderRefundableAfterInCents).toBe(0);

      // Shared processing fee attribution splits exactly without losing 1 cent
      expect(quote3.organizerDebitInCents + quote3.platformExpenseInCents).toBe(
        quote3.ticketSubtotalInCents + quote3.processingFeeInCents
      );

      // Any further refund exceeding orderTotalInCents must be rejected
      expect(() =>
        computeTicketRefundQuote({
          orderId,
          orderTotalInCents,
          orderRefundedAmountInCents: quote1.refundAmountInCents + quote2.refundAmountInCents,
          orderPendingRefundAmountInCents: quote3.refundAmountInCents,
          initiatorRole: RefundInitiatorRole.ADMIN,
          tickets: [tickets[0]],
          refundStripeProcessingFee: false,
          feeBearer: RefundFeeBearer.PLATFORM,
        })
      ).toThrow(/exceeds original payment total/);
    });

    it('defaults to excluding Stripe processing fee while keeping P2-04 key format and lock state transitions', () => {
      const { orderId, orderTotalInCents, tickets } = buildSampleOrderTickets();

      const defaultPolicyQuote = computeTicketRefundQuote({
        orderId,
        orderTotalInCents,
        orderRefundedAmountInCents: 0,
        orderPendingRefundAmountInCents: 0,
        initiatorRole: RefundInitiatorRole.ORGANIZER,
        tickets: [tickets[0]],
        feeBearer: RefundFeeBearer.ORGANIZER,
      });

      expect(defaultPolicyQuote.refundStripeProcessingFee).toBe(false);
      expect(defaultPolicyQuote.refundAmountInCents).toBe(
        tickets[0].allocatedGrossInCents! +
          tickets[0].allocatedPlatformFeeInCents! +
          tickets[0].allocatedServiceFeeInCents!
      );
      expect(defaultPolicyQuote.organizerDebitInCents).toBe(tickets[0].allocatedGrossInCents);
      expect(defaultPolicyQuote.platformExpenseInCents).toBe(0);

      expect(buildLatePaymentRefundIdempotencyKey('pi_abc123')).toBe('late-refund:pi_abc123');
      expect(resolveLockStateForOrderRefundStatus(OrderRefundStatus.PENDING)).toBe(
        OrderRefundTicketLockState.ACTIVE_PENDING
      );
      expect(resolveLockStateForOrderRefundStatus(OrderRefundStatus.SUCCEEDED)).toBe(
        OrderRefundTicketLockState.CONFIRMED
      );
      expect(resolveLockStateForOrderRefundStatus(OrderRefundStatus.CANCELLED)).toBe(
        OrderRefundTicketLockState.RELEASED
      );
    });
  });

  describe('Free-ticket local cancellation workflow & mixed-cart distinction', () => {
    it('produces zero Stripe refund and zero ledger refund plan for $0 free orders', () => {
      const plan = computeLocalFreeTicketCancellationPlan({
        orderId: 'order_free_1',
        orderTotalInCents: 0,
        initiatorRole: RefundInitiatorRole.ORGANIZER,
        initiatedByUserId: 'org_user_1',
        reason: 'Attendee cannot attend',
        tickets: [
          {
            id: 't_free_1',
            orderId: 'order_free_1',
            ticketTierId: 'tier_free_a',
            status: TicketStatus.ISSUED,
            hasActiveOrConfirmedRefundLock: false,
            tierPriceInCents: 0,
            allocatedGrossInCents: 0,
            allocatedPlatformFeeInCents: 0,
            allocatedServiceFeeInCents: 0,
            allocatedProcessingFeeInCents: 0,
            allocatedBuyerTotalInCents: 0,
          },
          {
            id: 't_free_2',
            orderId: 'order_free_1',
            ticketTierId: 'tier_free_a',
            status: TicketStatus.ISSUED,
            hasActiveOrConfirmedRefundLock: false,
            tierPriceInCents: 0,
            allocatedGrossInCents: 0,
            allocatedPlatformFeeInCents: 0,
            allocatedServiceFeeInCents: 0,
            allocatedProcessingFeeInCents: 0,
            allocatedBuyerTotalInCents: 0,
          },
        ],
      });

      expect(plan).toEqual({
        action: 'LOCAL_FREE_TICKET_CANCELLATION',
        orderId: 'order_free_1',
        initiatorRole: RefundInitiatorRole.ORGANIZER,
        initiatedByUserId: 'org_user_1',
        reason: 'Attendee cannot attend',
        targetTicketStatus: TicketStatus.CANCELLED,
        createOrderRefundRecord: false,
        stripeRefundAmountInCents: 0,
        ledgerRefundAmountInCents: 0,
        ticketIds: ['t_free_1', 't_free_2'],
        restoreInventory: true,
        inventoryReleaseByTier: [{ ticketTierId: 'tier_free_a', releaseQuantity: 2 }],
      });

      // Legacy/unbackfilled $0 free order (null allocations, orderTotalInCents === 0) is also allowed
      expect(() =>
        validateFreeTicketCancellationSelection({
          orderId: 'order_free_legacy',
          orderTotalInCents: 0,
          initiatorRole: RefundInitiatorRole.ADMIN,
          tickets: [
            {
              id: 't_free_legacy_1',
              orderId: 'order_free_legacy',
              ticketTierId: 'tier_free_a',
              status: TicketStatus.ISSUED,
              hasActiveOrConfirmedRefundLock: false,
            },
          ],
        })
      ).not.toThrow();
    });

    it('rejects paid tickets, unauthorized roles, checked-in/cancelled/refunded tickets, and mixed-cart fee-bearing tickets', () => {
      // Paid or mixed cart: $0 tier ticket in mixed cart carried $0.95 service + processing fees
      const mixedCheckout = calculateCheckoutFeeBreakdown([
        { priceInCents: 0, quantity: 1 },
        { priceInCents: 2000, quantity: 1 },
      ]);
      const mixedAlloc = allocateOrderTicketPayments(
        { buyerTotalInCents: mixedCheckout.buyerTotalInCents },
        [
          { ticketId: 't_mixed_free', ticketTierId: 'tier_free', grossPriceInCents: 0 },
          { ticketId: 't_mixed_paid', ticketTierId: 'tier_paid', grossPriceInCents: 2000 },
        ]
      );

      // Must reject local-only cancellation when ticket absorbed allocated buyer fees (> 0)
      expect(() =>
        validateFreeTicketCancellationSelection({
          orderId: 'order_mixed_1',
          orderTotalInCents: mixedCheckout.buyerTotalInCents,
          initiatorRole: RefundInitiatorRole.ORGANIZER,
          tickets: [
            {
              id: 't_mixed_free',
              orderId: 'order_mixed_1',
              ticketTierId: 'tier_free',
              status: TicketStatus.ISSUED,
              hasActiveOrConfirmedRefundLock: false,
              tierPriceInCents: 0,
              ...mixedAlloc.tickets[0],
            },
          ],
        })
      ).toThrow(/allocated buyer payment/);

      // Must reject mixed/paid order ticket missing persisted allocations (ambiguous entitlement)
      expect(() =>
        validateFreeTicketCancellationSelection({
          orderId: 'order_mixed_1',
          orderTotalInCents: mixedCheckout.buyerTotalInCents,
          initiatorRole: RefundInitiatorRole.ADMIN,
          tickets: [
            {
              id: 't_mixed_unallocated',
              orderId: 'order_mixed_1',
              ticketTierId: 'tier_free',
              status: TicketStatus.ISSUED,
              hasActiveOrConfirmedRefundLock: false,
            },
          ],
        })
      ).toThrow(/without persisted ticket allocations/);

      // Reject paid tier even if allocations omitted
      expect(() =>
        validateFreeTicketCancellationSelection({
          orderId: 'order_paid_1',
          orderTotalInCents: 2394,
          initiatorRole: RefundInitiatorRole.ORGANIZER,
          tickets: [
            {
              id: 't_paid_1',
              orderId: 'order_paid_1',
              ticketTierId: 'tier_paid',
              status: TicketStatus.ISSUED,
              hasActiveOrConfirmedRefundLock: false,
              tierPriceInCents: 2000,
              allocatedGrossInCents: 2000,
              allocatedPlatformFeeInCents: 200,
              allocatedServiceFeeInCents: 95,
              allocatedProcessingFeeInCents: 99,
              allocatedBuyerTotalInCents: 2394,
            },
          ],
        })
      ).toThrow(RefundDomainRuleError);

      // Reject unauthorized initiator, CHECKED_IN, CANCELLED, REFUNDED, REFUND_PENDING, cross-order
      expect(() =>
        validateFreeTicketCancellationSelection({
          orderId: 'order_free_1',
          orderTotalInCents: 0,
          initiatorRole: RefundInitiatorRole.SYSTEM,
          tickets: [
            {
              id: 't_1',
              orderId: 'order_free_1',
              ticketTierId: 'tier_free',
              status: TicketStatus.ISSUED,
              hasActiveOrConfirmedRefundLock: false,
            },
          ],
        })
      ).toThrow(/Only ORGANIZER or ADMIN/);

      for (const badStatus of [
        TicketStatus.CHECKED_IN,
        TicketStatus.CANCELLED,
        TicketStatus.REFUND_PENDING,
        TicketStatus.REFUNDED,
      ]) {
        expect(() =>
          validateFreeTicketCancellationSelection({
            orderId: 'order_free_1',
            orderTotalInCents: 0,
            initiatorRole: RefundInitiatorRole.ORGANIZER,
            tickets: [
              {
                id: 't_bad_status',
                orderId: 'order_free_1',
                ticketTierId: 'tier_free',
                status: badStatus,
                hasActiveOrConfirmedRefundLock: false,
              },
            ],
          })
        ).toThrow(RefundDomainRuleError);
      }
    });
  });

  describe('Counter reconciliation & amount parity (reconcileOrderRefundCountersFromRecords)', () => {
    function makeLine(
      ticketId: string,
      orderId: string,
      lockState: OrderRefundTicketLockState,
      gross: number,
      platform: number,
      service: number,
      processing: number,
      refunded: number
    ) {
      return {
        ticketId,
        orderId,
        lockState,
        allocatedGrossInCents: gross,
        allocatedPlatformFeeInCents: platform,
        allocatedServiceFeeInCents: service,
        allocatedProcessingFeeInCents: processing,
        allocatedBuyerTotalInCents: gross + platform + service + processing,
        refundedAmountInCents: refunded,
      };
    }

    it('explicitly classifies order-payment refund statuses vs LATE_PAYMENT and stays idempotent', () => {
      expect(
        classifyOrderRefundCounterBucket({
          refundKind: OrderRefundKind.LATE_PAYMENT,
          status: OrderRefundStatus.SUCCEEDED,
        })
      ).toBe('LATE_PAYMENT');
      expect(
        classifyOrderRefundCounterBucket({
          refundKind: OrderRefundKind.ORGANIZER_TICKET_REFUND,
          status: OrderRefundStatus.MANUALLY_RESOLVED,
          resolutionAction: 'NO_REFUND_NEEDED',
        })
      ).toBe('RELEASED');
      expect(
        classifyOrderRefundCounterBucket({
          refundKind: OrderRefundKind.ADMIN_TICKET_REFUND,
          status: OrderRefundStatus.MANUALLY_RESOLVED,
          resolutionAction: 'REFUNDED_MANUALLY',
        })
      ).toBe('CONFIRMED');

      // 3-ticket order totaling 10000 cents with mixed statuses:
      // r1: SUCCEEDED partial (2295)
      // r2: PENDING partial (2295)
      // r3: PROCESSING partial (2295)
      // r4: CANCELLED partial (2295 - must contribute 0 and leave ticket unlocked)
      // r5: legacy LATE_PAYMENT duplicate-PI refund without ticket rows (10000 - must not consume order cap)
      const records = [
        {
          id: 'ref_pending_1',
          orderId: 'ord_1',
          refundKind: OrderRefundKind.ORGANIZER_TICKET_REFUND,
          status: OrderRefundStatus.PENDING,
          amountInCents: 2295,
          tickets: [
            makeLine('t2', 'ord_1', OrderRefundTicketLockState.ACTIVE_PENDING, 2000, 200, 95, 99, 2295),
          ],
        },
        {
          id: 'ref_late_legacy',
          orderId: 'ord_1',
          refundKind: OrderRefundKind.LATE_PAYMENT,
          status: OrderRefundStatus.SUCCEEDED,
          amountInCents: 10000,
          tickets: [],
        },
        {
          id: 'ref_cancelled_1',
          orderId: 'ord_1',
          refundKind: OrderRefundKind.ORGANIZER_TICKET_REFUND,
          status: OrderRefundStatus.CANCELLED,
          amountInCents: 2295,
          tickets: [
            makeLine('t4', 'ord_1', OrderRefundTicketLockState.RELEASED, 2000, 200, 95, 99, 2295),
          ],
        },
        {
          id: 'ref_succeeded_1',
          orderId: 'ord_1',
          refundKind: OrderRefundKind.ADMIN_TICKET_REFUND,
          status: OrderRefundStatus.SUCCEEDED,
          amountInCents: 2394,
          tickets: [
            makeLine('t1', 'ord_1', OrderRefundTicketLockState.CONFIRMED, 2000, 200, 95, 99, 2394),
          ],
        },
        {
          id: 'ref_stripe_pending_1',
          orderId: 'ord_1',
          refundKind: OrderRefundKind.ORGANIZER_TICKET_REFUND,
          status: OrderRefundStatus.STRIPE_PENDING,
          amountInCents: 2295,
          tickets: [
            makeLine('t3', 'ord_1', OrderRefundTicketLockState.ACTIVE_PENDING, 2000, 200, 95, 99, 2295),
          ],
        },
      ];

      const run1 = reconcileOrderRefundCountersFromRecords({
        orderId: 'ord_1',
        orderTotalInCents: 10000,
        refunds: records,
      });
      const run2 = reconcileOrderRefundCountersFromRecords({
        orderId: 'ord_1',
        orderTotalInCents: 10000,
        refunds: [...records].reverse(),
      });

      expect(run1).toEqual({
        orderId: 'ord_1',
        orderTotalInCents: 10000,
        refundedAmountInCents: 2394,
        pendingRefundAmountInCents: 4590,
        remainingRefundableInCents: 3016,
        latePaymentRefundAmountInCents: 10000,
        latePaymentRefundCount: 1,
        activeTicketIds: ['t2', 't3'],
        confirmedTicketIds: ['t1'],
      });
      // Deterministic & idempotent regardless of record input order
      expect(run2).toEqual(run1);
    });

    it('rejects amount parity mismatches and cumulative cap violations', () => {
      // Mismatch between OrderRefund.amountInCents and OrderRefundTicket sum
      expect(() =>
        reconcileOrderRefundCountersFromRecords({
          orderId: 'ord_1',
          orderTotalInCents: 5000,
          refunds: [
            {
              id: 'ref_mismatch',
              orderId: 'ord_1',
              refundKind: OrderRefundKind.ORGANIZER_TICKET_REFUND,
              status: OrderRefundStatus.PENDING,
              amountInCents: 2300,
              tickets: [
                makeLine('t1', 'ord_1', OrderRefundTicketLockState.ACTIVE_PENDING, 2000, 200, 95, 99, 2295),
              ],
            },
          ],
        })
      ).toThrow(/differs from sum/);

      // Ticket-based refund missing line items
      expect(() =>
        reconcileOrderRefundCountersFromRecords({
          orderId: 'ord_1',
          orderTotalInCents: 5000,
          refunds: [
            {
              id: 'ref_no_lines',
              orderId: 'ord_1',
              refundKind: OrderRefundKind.ADMIN_TICKET_REFUND,
              status: OrderRefundStatus.SUCCEEDED,
              amountInCents: 2000,
              tickets: [],
            },
          ],
        })
      ).toThrow(/0 OrderRefundTicket/);

      // Cumulative cap violation across mixed succeeded + pending refunds
      expect(() =>
        reconcileOrderRefundCountersFromRecords({
          orderId: 'ord_1',
          orderTotalInCents: 4000,
          refunds: [
            {
              id: 'r1',
              orderId: 'ord_1',
              refundKind: OrderRefundKind.ORGANIZER_TICKET_REFUND,
              status: OrderRefundStatus.SUCCEEDED,
              amountInCents: 2295,
              tickets: [
                makeLine('t1', 'ord_1', OrderRefundTicketLockState.CONFIRMED, 2000, 200, 95, 99, 2295),
              ],
            },
            {
              id: 'r2',
              orderId: 'ord_1',
              refundKind: OrderRefundKind.ORGANIZER_TICKET_REFUND,
              status: OrderRefundStatus.PENDING,
              amountInCents: 2295,
              tickets: [
                makeLine('t2', 'ord_1', OrderRefundTicketLockState.ACTIVE_PENDING, 2000, 200, 95, 99, 2295),
              ],
            },
          ],
        })
      ).toThrow(/exceeds orderTotalInCents/);
    });
  });
});
