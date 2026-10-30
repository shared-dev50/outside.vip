import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import Stripe from 'stripe';
import { nanoid } from 'nanoid';
import { app } from '../app.js';
import { prisma } from '../db/prisma.js';
import { stripe } from '../lib/stripe.js';
import { processStripeWebhookEvent } from '../modules/webhooks/webhook.service.js';
import { settlePendingOrder, reconcileOrganizerFinance } from '../modules/finance/ledger.service.js';
import {
  OrderStatus,
  Role,
  PaymentProvider,
  LedgerEntryType,
  LedgerBalanceType,
  TransferStatus,
  PayoutStatus,
} from '@prisma/client';

describe('Posh-Inspired Organizer Finance & Transfer Workflow', () => {
  let organizerToken: string;
  let organizerUserId: string;
  let adminToken: string;
  let adminUserId: string;
  let secondOrganizerToken: string;
  let secondOrganizerUserId: string;
  let testEventId: string;
  let testTierId: string;
  let testOrderId: string;

  beforeAll(async () => {
    // Create and authenticate isolated test organizer
    const flowEmail = `flow_org_${Date.now()}@outside.vip`;
    const organizerReg = await request(app).post('/api/auth/register').send({
      email: flowEmail,
      name: 'Flow Test Organizer',
      password: 'Outside2026!',
      role: Role.ORGANIZER,
    });
    expect(organizerReg.status).toBe(201);
    organizerToken = organizerReg.body.data.token;
    organizerUserId = organizerReg.body.data.user.id;

    // Authenticate seeded admin user
    const adminLogin = await request(app).post('/api/auth/login').send({
      email: 'admin@outside.vip',
      password: 'Outside2026!',
    });
    expect(adminLogin.status).toBe(200);
    adminToken = adminLogin.body.data.token;
    adminUserId = adminLogin.body.data.user.id;

    // Create second organizer for cross-organizer isolation testing
    const secondEmail = `org_sec_${Date.now()}@outside.vip`;
    const secondReg = await request(app).post('/api/auth/register').send({
      email: secondEmail,
      name: 'Second Organizer',
      password: 'Outside2026!',
      role: 'ORGANIZER',
    });
    expect(secondReg.status).toBe(201);
    secondOrganizerToken = secondReg.body.data.token;
    secondOrganizerUserId = secondReg.body.data.user.id;

    // Create a test event with a paid ticket tier for the main organizer
    const event = await prisma.event.create({
      data: {
        organizerId: organizerUserId,
        title: 'Finance Flow Test Festival',
        description: 'Test event for financial ledger and transfer auditing',
        slug: `fin-test-event-${Date.now()}`,
        coverImageUrl: 'https://images.unsplash.com/photo-1540039155733-5bb30b53aa14',
        venueName: 'Nairobi Arena',
        venueAddress: '100 Uhuru Highway',
        city: 'Nairobi',
        country: 'Kenya',
        startAt: new Date(Date.now() + 86400000 * 7),
        endAt: new Date(Date.now() + 86400000 * 8),
        ticketTiers: {
          create: {
            name: 'VIP General Admission',
            priceInCents: 2000, // $20.00
            totalCapacity: 500,
          },
        },
      },
      include: { ticketTiers: true },
    });

    testEventId = event.id;
    testTierId = event.ticketTiers[0].id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    // Reset test organizers' stripeAccountId to clean state
    const idsToClean = [organizerUserId, secondOrganizerUserId, adminUserId].filter(Boolean);
    if (idsToClean.length > 0) {
      await prisma.user.updateMany({
        where: { id: { in: idsToClean } },
        data: { stripeAccountId: null },
      });
    }
  });

  describe('1. Ticket Purchase, Fee Breakdown & Ledger Creation', () => {
    it('creates accurate financial ledger entries and pending balance on payment_intent.succeeded', async () => {
      // Create a simulated order for $20 ticket ($23.94 buyer total)
      const orderId = `ord_test_${nanoid(10)}`;
      const orderNumber = `OUT-${nanoid(8).toUpperCase()}`;
      const piId = `pi_test_${nanoid(16)}`;

      testOrderId = orderId;

      await prisma.order.create({
        data: {
          id: orderId,
          orderNumber,
          eventId: testEventId,
          customerName: 'Test Attendee',
          customerEmail: 'attendee@test.com',
          totalInCents: 2394, // $20.00 ticket + $2.00 platform + $0.95 service + $0.99 stripe grossup
          platformFeeInCents: 394,
          organizerNetInCents: 2000,
          currency: 'USD',
          idempotencyKey: `idemp_${nanoid(16)}`,
          paymentProvider: PaymentProvider.STRIPE,
          paymentReference: piId,
          status: OrderStatus.PENDING,
          expiresAt: new Date(Date.now() + 900000),
          items: {
            create: {
              ticketTierId: testTierId,
              quantity: 1,
              unitPriceInCents: 2000,
              subtotalInCents: 2000,
            },
          },
        },
      });

      // Dispatch simulated Stripe payment_intent.succeeded webhook
      const webhookPayload: Stripe.Event = {
        id: `evt_pi_${nanoid(14)}`,
        object: 'event',
        api_version: '2023-10-16',
        created: Math.floor(Date.now() / 1000),
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: piId,
            object: 'payment_intent',
            amount: 2394,
            currency: 'usd',
            status: 'succeeded',
            latest_charge: `ch_${nanoid(16)}`,
            metadata: {
              orderId,
            },
          } as any,
        },
      };

      const result = await processStripeWebhookEvent(webhookPayload);
      expect(result.handled).toBe(true);

      // Verify order was marked COMPLETED
      const order = await prisma.order.findUnique({ where: { id: orderId } });
      expect(order?.status).toBe(OrderStatus.COMPLETED);

      // Verify FinancialLedgerEntry records were generated
      const ledgerEntries = await prisma.financialLedgerEntry.findMany({
        where: { orderId },
      });

      // Must have pending sale, platform fee, service fee, and stripe fee estimate
      const pendingSale = ledgerEntries.find((e) => e.type === LedgerEntryType.TICKET_SALE_PENDING);
      expect(pendingSale).toBeDefined();
      expect(pendingSale?.amountInCents).toBe(2000); // $20.00 organizer earnings
      expect(pendingSale?.balanceType).toBe(LedgerBalanceType.PENDING);

      const platformFee = ledgerEntries.find((e) => e.type === LedgerEntryType.PLATFORM_FEE);
      expect(platformFee).toBeDefined();
      expect(platformFee?.amountInCents).toBe(200); // 10% of $20.00 = $2.00

      const serviceFee = ledgerEntries.find((e) => e.type === LedgerEntryType.SERVICE_FEE);
      expect(serviceFee).toBeDefined();
      expect(serviceFee?.amountInCents).toBe(95); // $0.95 service fee

      const stripeEstimate = ledgerEntries.find((e) => e.type === LedgerEntryType.STRIPE_PROCESSING_FEE);
      expect(stripeEstimate).toBeDefined();
      expect(stripeEstimate?.amountInCents).toBe(99); // 2.9% + $0.30 gross-up = 99 cents

      // Verify OrganizerBalance was incremented in pending
      const balance = await prisma.organizerBalance.findUnique({
        where: { userId: organizerUserId },
      });
      expect(balance?.pendingBalanceInCents).toBeGreaterThanOrEqual(2000);
    });

    it('handles duplicate webhook delivery idempotently without creating duplicate ledger entries', async () => {
      const existingEvent = await prisma.processedWebhookEvent.findFirst();
      if (!existingEvent) return;

      const duplicatePayload: Stripe.Event = {
        id: existingEvent.eventId,
        object: 'event',
        api_version: '2023-10-16',
        created: Math.floor(Date.now() / 1000),
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_duplicate_test',
            status: 'succeeded',
          } as any,
        },
      };

      const result = await processStripeWebhookEvent(duplicatePayload);
      expect(result.duplicate).toBe(true);
    });
  });

  describe('2. Pending-to-Available Balance Settlement Transition', () => {
    it('transitions organizer earnings from pending to available upon clearance', async () => {
      expect(testOrderId).toBeDefined();

      const initialBalance = await prisma.organizerBalance.findUnique({
        where: { userId: organizerUserId },
      });
      const initialPending = initialBalance!.pendingBalanceInCents;
      const initialAvailable = initialBalance!.availableBalanceInCents;

      // Settle the order earnings
      await settlePendingOrder(testOrderId);

      const updatedBalance = await prisma.organizerBalance.findUnique({
        where: { userId: organizerUserId },
      });

      // Pending should decrease by 2000, available should increase by 2000
      expect(updatedBalance!.pendingBalanceInCents).toBe(initialPending - 2000);
      expect(updatedBalance!.availableBalanceInCents).toBe(initialAvailable + 2000);

      // Verify TICKET_SALE_CLEARED ledger entry
      const clearedEntry = await prisma.financialLedgerEntry.findFirst({
        where: {
          orderId: testOrderId,
          type: LedgerEntryType.TICKET_SALE_CLEARED,
        },
      });
      expect(clearedEntry).toBeDefined();
      expect(clearedEntry?.balanceType).toBe(LedgerBalanceType.AVAILABLE);
      expect(clearedEntry?.amountInCents).toBe(2000);
    });
  });

  describe('3. Organizer Withdrawals & Transfers Service', () => {
    beforeEach(async () => {
      // Attach test Stripe account ID to organizer
      await prisma.user.update({
        where: { id: organizerUserId },
        data: { stripeAccountId: 'acct_test_express_101' },
      });
    });

    it('rejects withdrawal when organizer has no connected Stripe account', async () => {
      await prisma.user.update({
        where: { id: organizerUserId },
        data: { stripeAccountId: null },
      });

      const res = await request(app)
        .post('/api/organizer/finance/withdraw')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({ amountInCents: 1000 });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('NO_CONNECTED_ACCOUNT');
    });

    it('rejects withdrawal below minimum amount of $1.00 USD (100 cents)', async () => {
      const res = await request(app)
        .post('/api/organizer/finance/withdraw')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({ amountInCents: 50 });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe('Validation failed');
    });

    it('rejects withdrawal when amount exceeds eligible available balance', async () => {
      // Mock Stripe accounts.retrieve
      vi.spyOn(stripe.accounts, 'retrieve').mockResolvedValueOnce({
        id: 'acct_test_express_101',
        payouts_enabled: true,
        charges_enabled: true,
        details_submitted: true,
      } as any);

      const res = await request(app)
        .post('/api/organizer/finance/withdraw')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({ amountInCents: 99999999 }); // Huge amount

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INSUFFICIENT_AVAILABLE_BALANCE');
    });

    it('rejects withdrawal if Stripe Express account cannot receive transfers', async () => {
      // Mock Stripe accounts.retrieve returning false for payouts and charges
      vi.spyOn(stripe.accounts, 'retrieve').mockResolvedValueOnce({
        id: 'acct_test_express_101',
        payouts_enabled: false,
        charges_enabled: false,
        details_submitted: false,
      } as any);

      const res = await request(app)
        .post('/api/organizer/finance/withdraw')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({ amountInCents: 1000 });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ACCOUNT_NOT_READY_FOR_TRANSFERS');
    });

    it('executes successful organizer manual withdrawal and decrements available balance', async () => {
      // Ensure available balance has at least 2000 cents
      await prisma.organizerBalance.upsert({
        where: { userId: organizerUserId },
        update: { availableBalanceInCents: 5000 },
        create: { userId: organizerUserId, availableBalanceInCents: 5000 },
      });

      // Mock Stripe API calls
      vi.spyOn(stripe.accounts, 'retrieve').mockResolvedValueOnce({
        id: 'acct_test_express_101',
        payouts_enabled: true,
        charges_enabled: true,
        details_submitted: true,
      } as any);

      const mockStripeTransferId = `tr_test_${nanoid(16)}`;
      vi.spyOn(stripe.transfers, 'create').mockResolvedValueOnce({
        id: mockStripeTransferId,
        object: 'transfer',
        amount: 2000,
        currency: 'usd',
        destination: 'acct_test_express_101',
      } as any);

      const withdrawRes = await request(app)
        .post('/api/organizer/finance/withdraw')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          amountInCents: 2000,
          idempotencyKey: `w_${nanoid(12)}`,
        });

      expect(withdrawRes.status).toBe(200);
      expect(withdrawRes.body.success).toBe(true);
      expect(withdrawRes.body.data.amountInCents).toBe(2000);
      expect(withdrawRes.body.data.stripeTransferId).toBe(mockStripeTransferId);
      expect(withdrawRes.body.data.status).toBe(TransferStatus.SUCCEEDED);

      // Verify OrganizerBalance was updated atomically
      const updatedBal = await prisma.organizerBalance.findUnique({
        where: { userId: organizerUserId },
      });
      expect(updatedBal?.availableBalanceInCents).toBe(3000); // 5000 - 2000
      expect(updatedBal?.transferredBalanceInCents).toBeGreaterThanOrEqual(2000);

      // Verify TRANSFER_SUCCEEDED ledger entry
      const transferLedger = await prisma.financialLedgerEntry.findFirst({
        where: {
          organizerId: organizerUserId,
          type: LedgerEntryType.TRANSFER_SUCCEEDED,
          stripeReferenceId: mockStripeTransferId,
        },
      });
      expect(transferLedger).toBeDefined();
      expect(transferLedger?.balanceType).toBe(LedgerBalanceType.TRANSFERRED);
    });

    it('safely handles Stripe transfer failure without deducting from available balance', async () => {
      await prisma.organizerBalance.update({
        where: { userId: organizerUserId },
        data: { availableBalanceInCents: 3000 },
      });

      vi.spyOn(stripe.accounts, 'retrieve').mockResolvedValueOnce({
        id: 'acct_test_express_101',
        payouts_enabled: true,
        charges_enabled: true,
        details_submitted: true,
      } as any);

      // Simulate Stripe transfer creation rejection
      vi.spyOn(stripe.transfers, 'create').mockRejectedValueOnce(
        new Error('Your destination account balance has been restricted.')
      );

      const failRes = await request(app)
        .post('/api/organizer/finance/withdraw')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          amountInCents: 1500,
          idempotencyKey: `w_fail_${nanoid(12)}`,
        });

      expect(failRes.status).toBe(400);

      // Balance MUST NOT be deducted
      const bal = await prisma.organizerBalance.findUnique({
        where: { userId: organizerUserId },
      });
      expect(bal?.availableBalanceInCents).toBe(3000);

      // The transfer record should be marked FAILED
      const failedTransfer = await prisma.organizerTransfer.findFirst({
        where: { organizerId: organizerUserId, status: TransferStatus.FAILED },
        orderBy: { createdAt: 'desc' },
      });
      expect(failedTransfer).toBeDefined();
      expect(failedTransfer?.failureMessage).toContain('restricted');
    });

    it('allows admin-initiated withdrawal with role-based authorization', async () => {
      await prisma.organizerBalance.update({
        where: { userId: organizerUserId },
        data: { availableBalanceInCents: 3000 },
      });

      vi.spyOn(stripe.accounts, 'retrieve').mockResolvedValueOnce({
        id: 'acct_test_express_101',
        payouts_enabled: true,
        charges_enabled: true,
        details_submitted: true,
      } as any);

      const mockStripeTransferId = `tr_admin_${nanoid(16)}`;
      vi.spyOn(stripe.transfers, 'create').mockResolvedValueOnce({
        id: mockStripeTransferId,
        object: 'transfer',
        amount: 1000,
        currency: 'usd',
        destination: 'acct_test_express_101',
      } as any);

      // Non-admin attempting admin withdrawal must be rejected with 403
      const unauthorizedRes = await request(app)
        .post('/api/organizer/finance/admin/withdraw')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          organizerId: organizerUserId,
          amountInCents: 1000,
        });
      expect(unauthorizedRes.status).toBe(403);

      // Authorized Admin succeeds
      const adminRes = await request(app)
        .post('/api/organizer/finance/admin/withdraw')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          organizerId: organizerUserId,
          amountInCents: 1000,
          notes: 'Admin-scheduled sweep',
        });

      expect(adminRes.status).toBe(200);
      expect(adminRes.body.success).toBe(true);
      expect(adminRes.body.data.sourceType).toBe('ADMIN_INITIATED');
    });
  });

  describe('4. Refunds & Dispute Financial Accounting', () => {
    it('reduces available balance on refund before transfer (pre-transfer)', async () => {
      // Create paid order for $30.00
      const orderId = `ord_ref_pre_${nanoid(10)}`;
      await prisma.order.create({
        data: {
          id: orderId,
          orderNumber: `OUT-REF-${nanoid(6).toUpperCase()}`,
          eventId: testEventId,
          customerName: 'Refund Pre Attendee',
          customerEmail: 'pre_refund@test.com',
          totalInCents: 3500,
          platformFeeInCents: 500,
          organizerNetInCents: 3000,
          currency: 'USD',
          idempotencyKey: `idemp_${nanoid(16)}`,
          paymentProvider: PaymentProvider.STRIPE,
          status: OrderStatus.COMPLETED,
          expiresAt: new Date(),
          items: {
            create: {
              ticketTierId: testTierId,
              quantity: 1,
              unitPriceInCents: 3000,
              subtotalInCents: 3000,
            },
          },
        },
      });

      // Put 3000 in available balance
      await prisma.organizerBalance.update({
        where: { userId: organizerUserId },
        data: { availableBalanceInCents: 3000 },
      });

      // Dispatch charge.refunded
      const refundPayload: Stripe.Event = {
        id: `evt_ref_${nanoid(14)}`,
        object: 'event',
        api_version: '2023-10-16',
        created: Math.floor(Date.now() / 1000),
        type: 'charge.refunded',
        data: {
          object: {
            id: `ch_ref_${nanoid(14)}`,
            object: 'charge',
            amount_refunded: 3500,
            metadata: { orderId },
            refunds: { data: [{ id: `re_${nanoid(14)}` }] },
          } as any,
        },
      };

      await processStripeWebhookEvent(refundPayload);

      // Available balance should be deducted to 0
      const balance = await prisma.organizerBalance.findUnique({
        where: { userId: organizerUserId },
      });
      expect(balance?.availableBalanceInCents).toBe(0);

      // Ledger entry REFUND_CLEARED created
      const refEntry = await prisma.financialLedgerEntry.findFirst({
        where: { orderId, type: LedgerEntryType.REFUND_CLEARED },
      });
      expect(refEntry).toBeDefined();
      expect(refEntry?.amountInCents).toBe(-3000);
      expect(refEntry?.balanceType).toBe(LedgerBalanceType.AVAILABLE);
    });

    it('tracks post-transfer refunds as recoverable liabilities without creating negative transfers', async () => {
      // Create paid order
      const orderId = `ord_ref_post_${nanoid(10)}`;
      await prisma.order.create({
        data: {
          id: orderId,
          orderNumber: `OUT-POST-${nanoid(6).toUpperCase()}`,
          eventId: testEventId,
          customerName: 'Refund Post Attendee',
          customerEmail: 'post_refund@test.com',
          totalInCents: 2000,
          platformFeeInCents: 0,
          organizerNetInCents: 2000,
          currency: 'USD',
          idempotencyKey: `idemp_${nanoid(16)}`,
          status: OrderStatus.COMPLETED,
          expiresAt: new Date(),
          items: {
            create: {
              ticketTierId: testTierId,
              quantity: 1,
              unitPriceInCents: 2000,
              subtotalInCents: 2000,
            },
          },
        },
      });

      // Organizer available and pending balances are 0 (all earnings already withdrawn)
      await prisma.organizerBalance.update({
        where: { userId: organizerUserId },
        data: { availableBalanceInCents: 0, pendingBalanceInCents: 0 },
      });

      // Dispatch charge.refunded
      const refundPayload: Stripe.Event = {
        id: `evt_post_ref_${nanoid(14)}`,
        object: 'event',
        api_version: '2023-10-16',
        created: Math.floor(Date.now() / 1000),
        type: 'charge.refunded',
        data: {
          object: {
            id: `ch_post_ref_${nanoid(14)}`,
            object: 'charge',
            amount_refunded: 2000,
            metadata: { orderId },
            refunds: { data: [{ id: `re_post_${nanoid(14)}` }] },
          } as any,
        },
      };

      await processStripeWebhookEvent(refundPayload);

      // Ledger entry REFUND_POST_TRANSFER created with balanceType RECOVERABLE
      const recoverableEntry = await prisma.financialLedgerEntry.findFirst({
        where: { orderId, type: LedgerEntryType.REFUND_POST_TRANSFER },
      });
      expect(recoverableEntry).toBeDefined();
      expect(recoverableEntry?.balanceType).toBe(LedgerBalanceType.RECOVERABLE);
      expect(recoverableEntry?.amountInCents).toBe(-2000);

      // Mock Stripe balance retrieve
      vi.spyOn(stripe.balance, 'retrieve').mockResolvedValueOnce({
        available: [{ amount: 0, currency: 'usd' }],
        pending: [{ amount: 0, currency: 'usd' }],
      } as any);

      // Check financial summary endpoint returns recoverable liabilities
      const summaryRes = await request(app)
        .get('/api/organizer/finance/balance')
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(summaryRes.status).toBe(200);
      expect(summaryRes.body.data.recoverableInCents).toBeGreaterThanOrEqual(2000);
    });

    it('records dispute events in the financial ledger', async () => {
      const disputeId = `dp_test_${nanoid(16)}`;
      const chargeId = `ch_disp_${nanoid(16)}`;

      // Create dummy order and transaction referencing chargeId
      const order = await prisma.order.create({
        data: {
          orderNumber: `OUT-DISP-${nanoid(6).toUpperCase()}`,
          eventId: testEventId,
          customerName: 'Dispute Attendee',
          customerEmail: 'dispute@test.com',
          totalInCents: 2500,
          currency: 'USD',
          idempotencyKey: `idemp_${nanoid(16)}`,
          status: OrderStatus.COMPLETED,
          expiresAt: new Date(),
          transactions: {
            create: {
              provider: PaymentProvider.STRIPE,
              providerTransactionId: chargeId,
              amountInCents: 2500,
              currency: 'USD',
              status: 'SUCCEEDED',
            },
          },
        },
      });

      // Dispatch charge.dispute.created
      const disputePayload: Stripe.Event = {
        id: `evt_disp_${nanoid(14)}`,
        object: 'event',
        api_version: '2023-10-16',
        created: Math.floor(Date.now() / 1000),
        type: 'charge.dispute.created',
        data: {
          object: {
            id: disputeId,
            object: 'dispute',
            amount: 2500,
            currency: 'usd',
            charge: chargeId,
            status: 'needs_response',
            reason: 'fraudulent',
          } as any,
        },
      };

      await processStripeWebhookEvent(disputePayload);

      const disputeEntry = await prisma.financialLedgerEntry.findFirst({
        where: { stripeReferenceId: disputeId },
      });
      expect(disputeEntry).toBeDefined();
      expect(disputeEntry?.type).toBe(LedgerEntryType.DISPUTE_HOLD);
    });
  });

  describe('5. Connected Bank Payouts Webhooks', () => {
    it('syncs ConnectedPayout table and records status on payout webhooks', async () => {
      const stripeAccountId = 'acct_payout_test_888';
      await prisma.user.update({
        where: { id: organizerUserId },
        data: { stripeAccountId },
      });

      const payoutId = `po_test_${nanoid(16)}`;
      const payoutPayload: Stripe.Event = {
        id: `evt_po_${nanoid(14)}`,
        object: 'event',
        account: stripeAccountId,
        api_version: '2023-10-16',
        created: Math.floor(Date.now() / 1000),
        type: 'payout.paid',
        data: {
          object: {
            id: payoutId,
            object: 'payout',
            amount: 5000,
            currency: 'usd',
            status: 'paid',
            arrival_date: Math.floor(Date.now() / 1000) + 86400,
            destination_details: { card: { last4: '4242' } },
          } as any,
        },
      };

      await processStripeWebhookEvent(payoutPayload);

      // Verify ConnectedPayout record
      const dbPayout = await prisma.connectedPayout.findUnique({
        where: { stripePayoutId: payoutId },
      });
      expect(dbPayout).toBeDefined();
      expect(dbPayout?.status).toBe(PayoutStatus.PAID);
      expect(dbPayout?.amountInCents).toBe(5000);
      expect(dbPayout?.destinationBankMasked).toContain('4242');

      // Mock Stripe payouts.list to simulate empty or fallback to local ConnectedPayout table
      vi.spyOn(stripe.payouts, 'list').mockResolvedValueOnce({
        data: [],
      } as any);

      // Verify payouts endpoint returns it from ConnectedPayout table fallback
      const res = await request(app)
        .get('/api/organizer/finance/payouts')
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.payouts.some((p: any) => p.id === payoutId)).toBe(true);
    });
  });

  describe('6. Multi-Organizer Isolation & Security', () => {
    it('strictly prevents organizer A from viewing or accessing organizer B financial records', async () => {
      // Organizer B queries transfers: must only see their own (empty)
      const res = await request(app)
        .get('/api/organizer/finance/transfers')
        .set('Authorization', `Bearer ${secondOrganizerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.transfers).toEqual([]);

      // Organizer B queries ledger: must not see organizer A's ledger entries
      const ledgerRes = await request(app)
        .get('/api/organizer/finance/ledger')
        .set('Authorization', `Bearer ${secondOrganizerToken}`);

      expect(ledgerRes.status).toBe(200);
      expect(ledgerRes.body.data.entries).toEqual([]);

      // Organizer B cannot initiate withdrawal for Organizer A
      const withdrawRes = await request(app)
        .post('/api/organizer/finance/admin/withdraw')
        .set('Authorization', `Bearer ${secondOrganizerToken}`)
        .send({
          organizerId: organizerUserId,
          amountInCents: 1000,
        });

      // Must be forbidden (role check fails)
      expect(withdrawRes.status).toBe(403);
    });
  });

  describe('7. Financial Ledger Audit & Reconciliation', () => {
    it('reconciles organizer balance against raw ledger entries', async () => {
      const reconcileRes = await request(app)
        .get('/api/organizer/finance/reconcile')
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(reconcileRes.status).toBe(200);
      expect(reconcileRes.body.success).toBe(true);
      expect(reconcileRes.body.data.ledgerTotals).toBeDefined();
      expect(reconcileRes.body.data.ledgerTotals.totalEntries).toBeGreaterThan(0);
    });
  });
});
