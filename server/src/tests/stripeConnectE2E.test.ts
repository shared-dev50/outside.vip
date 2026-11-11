import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import Stripe from 'stripe';
import { nanoid } from 'nanoid';
import { app } from '../app.js';
import { prisma } from '../db/prisma.js';
import { stripe } from '../lib/stripe.js';
import { env } from '../config/env.js';
import { processStripeWebhookEvent } from '../modules/webhooks/webhook.service.js';
import { settlePendingOrder } from '../modules/finance/ledger.service.js';
import {
  OrderStatus,
  Role,
  PaymentProvider,
  LedgerEntryType,
  LedgerBalanceType,
  TransferStatus,
} from '@prisma/client';

describe('Stripe Connect End-to-End Automated Integration Test Suite', () => {
  let organizerToken: string;
  let organizerUserId: string;
  let organizerEmail: string;
  let testEventId: string;
  let testTierId: string;
  const testConnectedAccountId = 'acct_e2e_express_101';

  beforeAll(async () => {
    organizerEmail = `e2e_connect_${Date.now()}@outside.vip`;
    const regRes = await request(app).post('/api/auth/register').send({
      email: organizerEmail,
      name: 'E2E Stripe Organizer',
      password: 'Outside2026!',
      role: Role.ORGANIZER,
    });
    expect(regRes.status).toBe(201);
    organizerToken = regRes.body.data.token;
    organizerUserId = regRes.body.data.user.id;
    await prisma.user.update({
      where: { id: organizerUserId },
      data: { emailVerified: true, emailVerifiedAt: new Date() },
    });

    const event = await prisma.event.create({
      data: {
        organizerId: organizerUserId,
        title: 'E2E Stripe Connect Festival',
        description: 'Automated integration testing for Outside.vip Connect flows',
        slug: `e2e-connect-fest-${Date.now()}`,
        coverImageUrl: 'https://images.unsplash.com/photo-1540039155733-5bb30b53aa14',
        venueName: 'Metropolis Arena',
        venueAddress: '100 Main Street',
        city: 'New York',
        country: 'US',
        startAt: new Date(Date.now() + 86400000 * 5),
        endAt: new Date(Date.now() + 86400000 * 6),
        ticketTiers: {
          create: {
            name: 'VIP Admission',
            priceInCents: 2000, // $20.00
            totalCapacity: 200,
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
    await prisma.user.update({
      where: { id: organizerUserId },
      data: { stripeAccountId: null, stripeAccountCountry: null },
    });
  });

  // ==========================================
  // 1. Account Creation & Country Selection
  // ==========================================
  describe('1. Account Creation & Country Selection', () => {
    it('GET /api/organizer/finance/countries returns only US platform allowlisted countries', async () => {
      const res = await request(app)
        .get('/api/organizer/finance/countries')
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.defaultCountry).toBe('US');
      expect(Array.isArray(res.body.data.countries)).toBe(true);
      expect(res.body.data.countries.length).toBe(38);

      const countryCodes = res.body.data.countries.map((c: any) => c.code);
      expect(countryCodes).toContain('US');
      expect(countryCodes).toContain('CA');
      expect(countryCodes).toContain('GB');
      expect(countryCodes).toContain('AU');
      expect(countryCodes).not.toContain('XX');
      expect(countryCodes).not.toContain('KE');
    });

    it('rejects client-supplied unauthorized country codes on onboarding-link creation with 400', async () => {
      const res = await request(app)
        .post('/api/organizer/finance/onboarding-link')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({ country: 'ZZ' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('UNSUPPORTED_COUNTRY');
    });

    it('passes country: countryCode to stripe.accounts.create and persists in database', async () => {
      const createAccountSpy = vi.spyOn(stripe.accounts, 'create').mockResolvedValueOnce({
        id: testConnectedAccountId,
        country: 'CA',
      } as any);

      vi.spyOn(stripe.accountLinks, 'create').mockResolvedValueOnce({
        url: 'https://connect.stripe.com/setup/s/e2e_ca_link',
      } as any);

      const res = await request(app)
        .post('/api/organizer/finance/onboarding-link')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({ country: 'CA' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.url).toBe('https://connect.stripe.com/setup/s/e2e_ca_link');
      expect(createAccountSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'express',
          country: 'CA',
        })
      );

      const dbUser = await prisma.user.findUnique({ where: { id: organizerUserId } });
      expect(dbUser?.stripeAccountId).toBe(testConnectedAccountId);
      expect(dbUser?.stripeAccountCountry).toBe('CA');
    });

    it('re-uses existing connected account and preserves original country without duplicating accounts', async () => {
      const createAccountSpy = vi.spyOn(stripe.accounts, 'create');
      const createLinkSpy = vi.spyOn(stripe.accountLinks, 'create').mockResolvedValueOnce({
        url: 'https://connect.stripe.com/setup/s/e2e_reuse_link',
      } as any);

      // Subsequent call attempting to pass 'GB'
      const res = await request(app)
        .post('/api/organizer/finance/onboarding-link')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({ country: 'GB' });

      expect(res.status).toBe(200);
      expect(createAccountSpy).not.toHaveBeenCalled();
      expect(createLinkSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          account: testConnectedAccountId,
        })
      );

      const dbUser = await prisma.user.findUnique({ where: { id: organizerUserId } });
      expect(dbUser?.stripeAccountId).toBe(testConnectedAccountId);
      expect(dbUser?.stripeAccountCountry).toBe('CA');
    });
  });

  // ==========================================
  // 2. Live Stripe Test Mode API Operations
  // ==========================================
  describe('2. Live Stripe Test Mode API Operations', () => {
    it('verifies live Stripe test mode API can retrieve connected accounts and generate onboarding URLs', async () => {
      const liveAccounts = await stripe.accounts.list({ limit: 1 });
      expect(Array.isArray(liveAccounts.data)).toBe(true);
      expect(liveAccounts.data.length).toBeGreaterThan(0);

      const liveAcct = liveAccounts.data[0];
      expect(liveAcct.id).toMatch(/^acct_/);

      const retrieved = await stripe.accounts.retrieve(liveAcct.id);
      expect(retrieved.id).toBe(liveAcct.id);

      const liveLink = await stripe.accountLinks.create({
        account: liveAcct.id,
        refresh_url: 'http://localhost:5173/organizer/finance?stripe_refresh=true',
        return_url: 'http://localhost:5173/organizer/finance?stripe_return=true',
        type: 'account_onboarding',
      });

      expect(typeof liveLink.url).toBe('string');
      expect(liveLink.url).toContain('https://connect.stripe.com/setup/');
    });
  });

  // ==========================================
  // 3. Webhook Signature Verification
  // ==========================================
  describe('3. Webhook Signature Verification', () => {
    it('rejects webhook requests missing stripe-signature header with 400', async () => {
      const res = await request(app)
        .post('/api/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ id: 'evt_test' }));

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('Missing Stripe signature header');
    });

    it('rejects webhook requests with forged or invalid signature with 400', async () => {
      const payload = JSON.stringify({ id: 'evt_forged_123', type: 'charge.updated' });
      const res = await request(app)
        .post('/api/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('stripe-signature', 't=12345,v1=bad_signature_hash')
        .send(payload);

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('Webhook signature verification failed');
    });

    it('verifies valid signature generated with primary STRIPE_WEBHOOK_SECRET', async () => {
      const payload = JSON.stringify({
        id: `evt_valid_platform_${Date.now()}`,
        object: 'event',
        api_version: '2023-10-16',
        created: Math.floor(Date.now() / 1000),
        type: 'charge.updated',
        data: {
          object: {
            id: 'ch_test_valid',
            payment_intent: 'pi_test_valid',
            amount: 1000,
            currency: 'usd',
            paid: true,
          },
        },
      });

      const signature = stripe.webhooks.generateTestHeaderString({
        payload,
        secret: env.STRIPE_WEBHOOK_SECRET,
      });

      const res = await request(app)
        .post('/api/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('stripe-signature', signature)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
    });

    it('verifies signature signed with STRIPE_CONNECT_WEBHOOK_SECRET via fallback mechanism', async () => {
      const testConnectSecret = 'whsec_connect_test_secret_for_suite_2026';
      process.env.STRIPE_CONNECT_WEBHOOK_SECRET = testConnectSecret;

      const payload = JSON.stringify({
        id: `evt_valid_connect_${Date.now()}`,
        object: 'event',
        api_version: '2023-10-16',
        created: Math.floor(Date.now() / 1000),
        type: 'charge.updated',
        data: {
          object: {
            id: 'ch_test_connect',
            payment_intent: 'pi_test_connect',
            amount: 2000,
            currency: 'usd',
            paid: true,
          },
        },
      });

      const signature = stripe.webhooks.generateTestHeaderString({
        payload,
        secret: testConnectSecret,
      });

      const res = await request(app)
        .post('/api/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('stripe-signature', signature)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
    });
  });

  // ==========================================
  // 4. account.updated Processing
  // ==========================================
  describe('4. account.updated Webhook Processing', () => {
    it('syncs connected account capabilities and external bank details into OrganizerPayoutDetails', async () => {
      await prisma.organizerPayoutDetails.upsert({
        where: { userId: organizerUserId },
        update: {
          bankName: 'Previous Bank',
          accountNumberMasked: '•••• 0000',
        },
        create: {
          userId: organizerUserId,
          orgType: 'Company',
          registeredName: 'E2E Organizer Inc',
          country: 'Canada',
          contactPersonName: 'E2E Organizer',
          contactEmail: organizerEmail,
          accountHolderName: 'E2E Organizer',
          bankName: 'Previous Bank',
          bankCountry: 'Canada',
          accountCurrency: 'CAD',
          accountNumberMasked: '•••• 0000',
          accountNumberLast4: '0000',
        },
      });

      const mockAccountUpdatedEvent: Stripe.Event = {
        id: `evt_acct_up_${Date.now()}`,
        object: 'event',
        api_version: '2023-10-16',
        created: Math.floor(Date.now() / 1000),
        type: 'account.updated',
        data: {
          object: {
            id: testConnectedAccountId,
            object: 'account',
            business_type: 'individual',
            country: 'CA',
            default_currency: 'cad',
            charges_enabled: true,
            payouts_enabled: true,
            details_submitted: true,
            external_accounts: {
              object: 'list',
              data: [
                {
                  id: 'ba_test_sync_001',
                  object: 'bank_account',
                  account_holder_name: 'E2E Stripe Organizer',
                  bank_name: 'Royal Bank of Canada',
                  country: 'CA',
                  currency: 'cad',
                  last4: '9876',
                  routing_number: '12345001',
                  status: 'verified',
                  default_for_currency: true,
                } as any,
              ],
              has_more: false,
              total_count: 1,
              url: `/v1/accounts/${testConnectedAccountId}/external_accounts`,
            },
            requirements: {
              currently_due: [],
              eventually_due: [],
              past_due: [],
            },
          } as any,
        },
      };

      const result = await processStripeWebhookEvent(mockAccountUpdatedEvent);
      expect(result.handled).toBe(true);

      const payoutDetails = await prisma.organizerPayoutDetails.findUnique({
        where: { userId: organizerUserId },
      });

      expect(payoutDetails).not.toBeNull();
      expect(payoutDetails?.bankName).toBe('Royal Bank of Canada');
      expect(payoutDetails?.accountHolderName).toBe('E2E Stripe Organizer');
      expect(payoutDetails?.accountNumberLast4).toBe('9876');
      expect(payoutDetails?.accountNumberMasked).toContain('9876');
    });
  });

  // ==========================================
  // 5. Payment Processing & Ledger Allocation
  // ==========================================
  describe('5. Payment Processing & Ledger Allocation', () => {
    let orderId: string;
    let paymentIntentId: string;

    it('creates order, processes payment_intent.succeeded webhook, and records ledger allocation', async () => {
      orderId = `ord_e2e_${nanoid(10)}`;
      const orderNumber = `OUT-E2E-${nanoid(6).toUpperCase()}`;
      paymentIntentId = `pi_e2e_${nanoid(16)}`;

      await prisma.order.create({
        data: {
          id: orderId,
          orderNumber,
          eventId: testEventId,
          customerName: 'E2E Attendee',
          customerEmail: 'attendee@outside.vip',
          totalInCents: 2394, // $20.00 ticket + $3.94 fees
          platformFeeInCents: 394,
          organizerNetInCents: 2000, // $20.00 net
          currency: 'USD',
          idempotencyKey: `idemp_${nanoid(16)}`,
          paymentProvider: PaymentProvider.STRIPE,
          paymentReference: paymentIntentId,
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

      const paymentIntentEvent: Stripe.Event = {
        id: `evt_pi_${Date.now()}`,
        object: 'event',
        api_version: '2023-10-16',
        created: Math.floor(Date.now() / 1000),
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: paymentIntentId,
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

      const processRes = await processStripeWebhookEvent(paymentIntentEvent);
      expect(processRes.handled).toBe(true);

      const updatedOrder = await prisma.order.findUnique({ where: { id: orderId } });
      expect(updatedOrder?.status).toBe(OrderStatus.COMPLETED);

      const ledgerEntries = await prisma.financialLedgerEntry.findMany({
        where: { orderId },
      });

      const pendingSale = ledgerEntries.find((e) => e.type === LedgerEntryType.TICKET_SALE_PENDING);
      expect(pendingSale).toBeDefined();
      expect(pendingSale?.amountInCents).toBe(2000);
      expect(pendingSale?.balanceType).toBe(LedgerBalanceType.PENDING);

      const platformFee = ledgerEntries.find((e) => e.type === LedgerEntryType.PLATFORM_FEE);
      expect(platformFee).toBeDefined();
      expect(platformFee?.amountInCents).toBe(200);

      // Verify pending balance in OrganizerBalance
      const balance = await prisma.organizerBalance.findUnique({
        where: { userId: organizerUserId },
      });
      expect(balance?.pendingBalanceInCents).toBe(2000);

      // Settle the order to transition from pending to available
      await settlePendingOrder(orderId);

      const clearedBalance = await prisma.organizerBalance.findUnique({
        where: { userId: organizerUserId },
      });
      expect(clearedBalance?.pendingBalanceInCents).toBe(0);
      expect(clearedBalance?.availableBalanceInCents).toBe(2000);
    });

    it('enforces webhook idempotency on duplicate payment_intent.succeeded delivery', async () => {
      const duplicateEvent: Stripe.Event = {
        id: `evt_dup_${nanoid(12)}`,
        object: 'event',
        api_version: '2023-10-16',
        created: Math.floor(Date.now() / 1000),
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: paymentIntentId,
            object: 'payment_intent',
            amount: 2394,
            currency: 'usd',
            status: 'succeeded',
            metadata: {
              orderId,
            },
          } as any,
        },
      };

      const firstRes = await processStripeWebhookEvent(duplicateEvent);
      expect(firstRes.handled).toBe(true);

      const secondRes = await processStripeWebhookEvent(duplicateEvent);
      expect(secondRes.handled).toBe(true);
      expect(secondRes.duplicate).toBe(true);

      // Verify no extra ledger entries created
      const clearedEntries = await prisma.financialLedgerEntry.findMany({
        where: { orderId, type: LedgerEntryType.TICKET_SALE_CLEARED },
      });
      expect(clearedEntries.length).toBe(1);
    });
  });

  // ==========================================
  // 6. Transfer Creation & Withdrawal Failures
  // ==========================================
  describe('6. Transfer Creation & Withdrawal Failure Handling', () => {
    it('rejects withdrawal if amount is below $1.00 USD (100 cents)', async () => {
      const res = await request(app)
        .post('/api/organizer/finance/withdraw')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({ amountInCents: 50 });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('rejects withdrawal when requested amount exceeds available balance', async () => {
      vi.spyOn(stripe.accounts, 'retrieve').mockResolvedValueOnce({
        id: testConnectedAccountId,
        capabilities: { transfers: 'active', card_payments: 'active' },
        payouts_enabled: true,
        charges_enabled: true,
        details_submitted: true,
      } as any);

      const res = await request(app)
        .post('/api/organizer/finance/withdraw')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({ amountInCents: 10000 }); // $100.00 > $20.00 available

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INSUFFICIENT_AVAILABLE_BALANCE');
    });

    it('rejects withdrawal when connected account cannot receive transfers (transfers disabled)', async () => {
      vi.spyOn(stripe.accounts, 'retrieve').mockResolvedValueOnce({
        id: testConnectedAccountId,
        capabilities: { transfers: 'inactive', card_payments: 'inactive' },
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

    it('safely handles Stripe transfer failure without deducting from organizer available balance', async () => {
      vi.spyOn(stripe.accounts, 'retrieve').mockResolvedValueOnce({
        id: testConnectedAccountId,
        capabilities: { transfers: 'active', card_payments: 'active' },
        payouts_enabled: true,
        charges_enabled: true,
        details_submitted: true,
      } as any);

      vi.spyOn(stripe.transfers, 'create').mockRejectedValueOnce(
        new Error('Your destination account balance has been restricted.')
      );

      const failRes = await request(app)
        .post('/api/organizer/finance/withdraw')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          amountInCents: 1000, // $10.00
          idempotencyKey: `w_fail_${nanoid(12)}`,
        });

      expect(failRes.status).toBe(400);

      // Verify available balance remains unaffected ($20.00)
      const balance = await prisma.organizerBalance.findUnique({
        where: { userId: organizerUserId },
      });
      expect(balance?.availableBalanceInCents).toBe(2000);

      // Verify transfer was marked FAILED
      const failedTransfer = await prisma.organizerTransfer.findFirst({
        where: { organizerId: organizerUserId, status: TransferStatus.FAILED },
        orderBy: { createdAt: 'desc' },
      });
      expect(failedTransfer).toBeDefined();
      expect(failedTransfer?.failureMessage).toContain('restricted');
    });

    it('successfully executes organizer withdrawal via separate transfer and updates ledger and balances', async () => {
      vi.spyOn(stripe.accounts, 'retrieve').mockResolvedValueOnce({
        id: testConnectedAccountId,
        capabilities: { transfers: 'active', card_payments: 'active' },
        payouts_enabled: true,
        charges_enabled: true,
        details_submitted: true,
      } as any);

      const mockStripeTransferId = `tr_e2e_success_${Date.now()}`;
      vi.spyOn(stripe.transfers, 'create').mockResolvedValueOnce({
        id: mockStripeTransferId,
        object: 'transfer',
        amount: 1000,
        currency: 'usd',
        destination: testConnectedAccountId,
        created: Math.floor(Date.now() / 1000),
      } as any);

      const res = await request(app)
        .post('/api/organizer/finance/withdraw')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          amountInCents: 1000, // $10.00
          notes: 'Festival earnings payout',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.amountInCents).toBe(1000);
      expect(res.body.data.stripeTransferId).toBe(mockStripeTransferId);

      // Verify available balance decremented ($20.00 - $10.00 = $10.00)
      const balance = await prisma.organizerBalance.findUnique({
        where: { userId: organizerUserId },
      });
      expect(balance?.availableBalanceInCents).toBe(1000);
      expect(balance?.transferredBalanceInCents).toBe(1000);

      // Verify withdrawal ledger entry created
      const withdrawalEntry = await prisma.financialLedgerEntry.findFirst({
        where: {
          organizerId: organizerUserId,
          type: LedgerEntryType.TRANSFER_INITIATED,
        },
      });
      expect(withdrawalEntry).not.toBeNull();
      expect(withdrawalEntry?.amountInCents).toBe(-1000);
    });
  });
});
