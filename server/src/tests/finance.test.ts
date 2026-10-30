import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { prisma } from '../db/prisma.js';
import { stripe } from '../lib/stripe.js';
import { processStripeWebhookEvent } from '../modules/webhooks/webhook.service.js';

describe('Outside.vip Stripe Connect Finance & Account Dashboard API', () => {
  let organizerToken: string;
  let organizerUserId: string;
  let attendeeToken: string;
  let secondOrganizerToken: string;
  let secondOrganizerUserId: string;

  beforeAll(async () => {
    // Authenticate seeded organizer
    const organizerLogin = await request(app).post('/api/auth/login').send({
      email: 'sol@outside.vip',
      password: 'Outside2026!',
    });
    expect(organizerLogin.status).toBe(200);
    organizerToken = organizerLogin.body.data.token;
    organizerUserId = organizerLogin.body.data.user.id;

    // Authenticate seeded attendee
    const attendeeLogin = await request(app).post('/api/auth/login').send({
      email: 'alex@outside.vip',
      password: 'Outside2026!',
    });
    expect(attendeeLogin.status).toBe(200);
    attendeeToken = attendeeLogin.body.data.token;

    // Create and authenticate second organizer for isolation verification
    const secondEmail = `org2_${Date.now()}@outside.vip`;
    const regRes = await request(app).post('/api/auth/register').send({
      email: secondEmail,
      name: 'Second Organizer',
      password: 'Outside2026!',
      role: 'ORGANIZER',
    });
    expect(regRes.status).toBe(201);
    secondOrganizerToken = regRes.body.data.token;
    secondOrganizerUserId = regRes.body.data.user.id;
  });

  beforeEach(async () => {
    // Reset test organizers' stripeAccountId before each test
    await prisma.user.updateMany({
      where: { id: { in: [organizerUserId, secondOrganizerUserId] } },
      data: { stripeAccountId: null },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    // Clean up test state and reset seeded organizer's stripeAccountId
    await prisma.user.updateMany({
      where: { id: { in: [organizerUserId, secondOrganizerUserId] } },
      data: { stripeAccountId: null },
    });
  });

  describe('1. Authentication & Role-based Authorization', () => {
    it('rejects unauthenticated requests to /api/organizer/finance/account with 401', async () => {
      const res = await request(app).get('/api/organizer/finance/account');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('rejects attendee requests to /api/organizer/finance/account with 403 Forbidden', async () => {
      const res = await request(app)
        .get('/api/organizer/finance/account')
        .set('Authorization', `Bearer ${attendeeToken}`);
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('rejects unauthenticated requests to balance, payouts, and disputes endpoints', async () => {
      const [bal, pay, disp] = await Promise.all([
        request(app).get('/api/organizer/finance/balance'),
        request(app).get('/api/organizer/finance/payouts'),
        request(app).get('/api/organizer/finance/disputes'),
      ]);
      expect(bal.status).toBe(401);
      expect(pay.status).toBe(401);
      expect(disp.status).toBe(401);
    });
  });

  describe('2. Empty State & Missing Connected Account Handling', () => {
    it('returns clean disconnected status when organizer has no connected Stripe account', async () => {
      const res = await request(app)
        .get('/api/organizer/finance/account')
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.connected).toBe(false);
      expect(res.body.data.stripeAccountId).toBeNull();
      expect(res.body.data.sellTickets.enabled).toBe(false);
      expect(res.body.data.sellTickets.status).toBe('disabled');
      expect(res.body.data.transferBalance.enabled).toBe(false);
      expect(res.body.data.transferBalance.status).toBe('disabled');
      expect(res.body.data.externalAccounts).toEqual([]);
      expect(res.body.data.payoutSchedule).toBeNull();
    });

    it('returns empty balance arrays when not connected without throwing errors', async () => {
      const res = await request(app)
        .get('/api/organizer/finance/balance')
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.available).toEqual([]);
      expect(res.body.data.pending).toEqual([]);
    });

    it('returns empty payouts and disputes arrays when not connected', async () => {
      const [payRes, dispRes] = await Promise.all([
        request(app)
          .get('/api/organizer/finance/payouts')
          .set('Authorization', `Bearer ${organizerToken}`),
        request(app)
          .get('/api/organizer/finance/disputes')
          .set('Authorization', `Bearer ${organizerToken}`),
      ]);

      expect(payRes.status).toBe(200);
      expect(payRes.body.data.payouts).toEqual([]);

      expect(dispRes.status).toBe(200);
      expect(dispRes.body.data.disputes).toEqual([]);
    });
  });

  describe('3. Onboarding & Account Link Generation', () => {
    it('creates an Express connected account and returns an onboarding link', async () => {
      const mockStripeAccountId = 'acct_test_express_001';
      const mockOnboardingUrl = 'https://connect.stripe.com/setup/s/test_token_123';

      const createAccountSpy = vi
        .spyOn(stripe.accounts, 'create')
        .mockResolvedValueOnce({
          id: mockStripeAccountId,
          object: 'account',
          type: 'express',
        } as any);

      const createLinkSpy = vi
        .spyOn(stripe.accountLinks, 'create')
        .mockResolvedValueOnce({
          object: 'account_link',
          url: mockOnboardingUrl,
          created: Math.floor(Date.now() / 1000),
          expires_at: Math.floor(Date.now() / 1000) + 300,
        } as any);

      const res = await request(app)
        .post('/api/organizer/finance/onboarding-link')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          returnUrl: 'http://localhost:5173/organizer/finance?stripe_return=true',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.url).toBe(mockOnboardingUrl);
      expect(res.body.data.stripeAccountId).toBe(mockStripeAccountId);

      // Verify Stripe API calls
      expect(createAccountSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'express',
          capabilities: {
            card_payments: { requested: true },
            transfers: { requested: true },
          },
        })
      );
      expect(createLinkSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          account: mockStripeAccountId,
          type: 'account_onboarding',
        })
      );

      // Verify database persistence
      const updatedUser = await prisma.user.findUnique({
        where: { id: organizerUserId },
      });
      expect(updatedUser?.stripeAccountId).toBe(mockStripeAccountId);
    });

    it('reuses existing stripeAccountId when generating subsequent onboarding links without duplicating accounts', async () => {
      const existingAcctId = 'acct_test_existing_456';
      await prisma.user.update({
        where: { id: organizerUserId },
        data: { stripeAccountId: existingAcctId },
      });

      const createAccountSpy = vi.spyOn(stripe.accounts, 'create');
      const createLinkSpy = vi
        .spyOn(stripe.accountLinks, 'create')
        .mockResolvedValueOnce({
          object: 'account_link',
          url: 'https://connect.stripe.com/setup/s/existing_link',
        } as any);

      const res = await request(app)
        .post('/api/organizer/finance/onboarding-link')
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      expect(createAccountSpy).not.toHaveBeenCalled();
      expect(createLinkSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          account: existingAcctId,
        })
      );
    });

    it('creates a single-use login link into Stripe Express Dashboard for onboarded organizers', async () => {
      const existingAcctId = 'acct_test_login_789';
      await prisma.user.update({
        where: { id: organizerUserId },
        data: { stripeAccountId: existingAcctId },
      });

      const mockLoginUrl = 'https://connect.stripe.com/express/acct_login_url_test';
      const loginSpy = vi
        .spyOn(stripe.accounts, 'createLoginLink')
        .mockResolvedValueOnce({
          object: 'login_link',
          url: mockLoginUrl,
        } as any);

      const res = await request(app)
        .post('/api/organizer/finance/login-link')
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.url).toBe(mockLoginUrl);
      expect(loginSpy).toHaveBeenCalledWith(existingAcctId);
    });
  });

  describe('4. Connected Account Retrieval, Requirements & Masked Methods', () => {
    it('returns full verified status, human-readable requirements, and masked bank account', async () => {
      const mockAcctId = 'acct_test_verified_101';
      await prisma.user.update({
        where: { id: organizerUserId },
        data: { stripeAccountId: mockAcctId },
      });

      vi.spyOn(stripe.accounts, 'retrieve').mockResolvedValueOnce({
        id: mockAcctId,
        object: 'account',
        details_submitted: true,
        charges_enabled: true,
        payouts_enabled: true,
        default_currency: 'usd',
        country: 'US',
        capabilities: {
          card_payments: 'active',
          transfers: 'active',
        },
        requirements: {
          currently_due: [],
          eventually_due: ['individual.verification.document'],
          past_due: [],
          disabled_reason: null,
          pending_verification: [],
        },
        settings: {
          payouts: {
            schedule: {
              interval: 'weekly',
              delay_days: 2,
              weekly_anchor: 'friday',
              monthly_anchor: null,
            },
          },
        },
        external_accounts: {
          object: 'list',
          data: [
            {
              id: 'ba_test_bank_01',
              object: 'bank_account',
              bank_name: 'JPMorgan Chase',
              account_holder_name: 'Sol Experience Group',
              last4: '4892',
              routing_number: '111000025',
              currency: 'usd',
              default_for_currency: true,
              status: 'verified',
            },
          ],
        },
      } as any);

      const res = await request(app)
        .get('/api/organizer/finance/account')
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const data = res.body.data;
      expect(data.connected).toBe(true);
      expect(data.stripeAccountId).toBe(mockAcctId);
      expect(data.sellTickets.enabled).toBe(true);
      expect(data.sellTickets.status).toBe('enabled');
      expect(data.transferBalance.enabled).toBe(true);
      expect(data.transferBalance.status).toBe('enabled');

      // Check human-readable requirement translation
      expect(data.requirements.eventuallyDue.length).toBe(1);
      expect(data.requirements.eventuallyDue[0].description).toContain('photo ID');

      // Check external accounts - must be sanitized with routing masked
      expect(data.externalAccounts.length).toBe(1);
      const bank = data.externalAccounts[0];
      expect(bank.bankName).toBe('JPMorgan Chase');
      expect(bank.last4).toBe('4892');
      expect(bank.routingNumber).toBe('••••0025');
      expect(bank.isDefault).toBe(true);

      // Check payout schedule
      expect(data.payoutSchedule.interval).toBe('weekly');
      expect(data.payoutSchedule.weeklyAnchor).toBe('friday');
      expect(data.payoutSchedule.delayDays).toBe(2);
    });

    it('correctly marks sellTickets and transferBalance action_required when requirements are due', async () => {
      const mockAcctId = 'acct_test_pending_202';
      await prisma.user.update({
        where: { id: organizerUserId },
        data: { stripeAccountId: mockAcctId },
      });

      vi.spyOn(stripe.accounts, 'retrieve').mockResolvedValueOnce({
        id: mockAcctId,
        object: 'account',
        details_submitted: false,
        charges_enabled: false,
        payouts_enabled: false,
        capabilities: {
          card_payments: 'inactive',
          transfers: 'inactive',
        },
        requirements: {
          currently_due: ['individual.verification.document', 'external_account'],
          eventually_due: [],
          past_due: [],
          disabled_reason: null,
          pending_verification: [],
        },
        external_accounts: { data: [] },
      } as any);

      const res = await request(app)
        .get('/api/organizer/finance/account')
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      const data = res.body.data;
      expect(data.sellTickets.enabled).toBe(false);
      expect(data.sellTickets.status).toBe('action_required');
      expect(data.transferBalance.enabled).toBe(false);
      expect(data.transferBalance.status).toBe('action_required');
      expect(data.requirements.currentlyDue.length).toBe(2);
    });
  });

  describe('5. Real Balance, Multi-Currency Support & Payout History', () => {
    it('retrieves and formats multi-currency balance from Stripe', async () => {
      const mockAcctId = 'acct_test_bal_303';
      await prisma.user.update({
        where: { id: organizerUserId },
        data: { stripeAccountId: mockAcctId },
      });

      const retrieveSpy = vi.spyOn(stripe.balance, 'retrieve').mockResolvedValueOnce({
        object: 'balance',
        available: [
          { amount: 145000, currency: 'usd', source_types: { card: 145000 } },
          { amount: 5000000, currency: 'kes' },
        ],
        pending: [
          { amount: 35000, currency: 'usd', source_types: { card: 35000 } },
        ],
      } as any);

      const res = await request(app)
        .get('/api/organizer/finance/balance')
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(retrieveSpy).toHaveBeenCalledWith({ stripeAccount: mockAcctId });

      const { available, pending } = res.body.data;
      expect(available.length).toBe(2);
      expect(available[0]).toEqual({
        amount: 145000,
        currency: 'USD',
        sourceTypes: { card: 145000 },
      });
      expect(available[1]).toEqual({
        amount: 5000000,
        currency: 'KES',
      });
      expect(pending.length).toBe(1);
      expect(pending[0].amount).toBe(35000);
    });

    it('retrieves sanitized payout history from Stripe', async () => {
      const mockAcctId = 'acct_test_pay_404';
      await prisma.user.update({
        where: { id: organizerUserId },
        data: { stripeAccountId: mockAcctId },
      });

      const nowSeconds = Math.floor(Date.now() / 1000);
      const listSpy = vi.spyOn(stripe.payouts, 'list').mockResolvedValueOnce({
        object: 'list',
        data: [
          {
            id: 'po_test_01',
            amount: 85000,
            currency: 'usd',
            status: 'paid',
            arrival_date: nowSeconds + 86400,
            created: nowSeconds,
            destination: 'ba_test_bank_01',
            failure_code: null,
            failure_message: null,
          },
          {
            id: 'po_test_02',
            amount: 25000,
            currency: 'usd',
            status: 'failed',
            arrival_date: nowSeconds,
            created: nowSeconds - 86400,
            destination: 'ba_test_bank_02',
            failure_code: 'account_closed',
            failure_message: 'The receiving bank account has been closed.',
          },
        ],
      } as any);

      const res = await request(app)
        .get('/api/organizer/finance/payouts?limit=5')
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      expect(listSpy).toHaveBeenCalledWith(
        { limit: 5 },
        { stripeAccount: mockAcctId }
      );

      const payouts = res.body.data.payouts;
      expect(payouts.length).toBe(2);
      expect(payouts[0].amount).toBe(85000);
      expect(payouts[0].status).toBe('paid');
      expect(payouts[1].status).toBe('failed');
      expect(payouts[1].failureCode).toBe('account_closed');
    });

    it('retrieves disputes associated with the connected account', async () => {
      const mockAcctId = 'acct_test_disp_505';
      await prisma.user.update({
        where: { id: organizerUserId },
        data: { stripeAccountId: mockAcctId },
      });

      const nowSeconds = Math.floor(Date.now() / 1000);
      vi.spyOn(stripe.disputes, 'list').mockResolvedValueOnce({
        object: 'list',
        data: [
          {
            id: 'dp_test_01',
            amount: 5000,
            currency: 'usd',
            status: 'needs_response',
            reason: 'fraudulent',
            created: nowSeconds,
            evidence_details: {
              due_by: nowSeconds + 7 * 86400,
            },
            is_charge_refundable: false,
          },
        ],
      } as any);

      const res = await request(app)
        .get('/api/organizer/finance/disputes')
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      const disputes = res.body.data.disputes;
      expect(disputes.length).toBe(1);
      expect(disputes[0].amount).toBe(5000);
      expect(disputes[0].reason).toBe('fraudulent');
      expect(disputes[0].status).toBe('needs_response');
    });
  });

  describe('6. Payout Schedule Configuration', () => {
    it('updates payout schedule interval and weekly anchor', async () => {
      const mockAcctId = 'acct_test_sched_606';
      await prisma.user.update({
        where: { id: organizerUserId },
        data: { stripeAccountId: mockAcctId },
      });

      const updateSpy = vi.spyOn(stripe.accounts, 'update').mockResolvedValueOnce({
        id: mockAcctId,
        settings: {
          payouts: {
            schedule: {
              interval: 'weekly',
              delay_days: 2,
              weekly_anchor: 'tuesday',
              monthly_anchor: null,
            },
          },
        },
      } as any);

      const res = await request(app)
        .patch('/api/organizer/finance/payout-schedule')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          interval: 'weekly',
          weeklyAnchor: 'tuesday',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.payoutSchedule.interval).toBe('weekly');
      expect(res.body.data.payoutSchedule.weeklyAnchor).toBe('tuesday');

      expect(updateSpy).toHaveBeenCalledWith(
        mockAcctId,
        expect.objectContaining({
          settings: {
            payouts: {
              schedule: expect.objectContaining({
                interval: 'weekly',
                weekly_anchor: 'tuesday',
              }),
            },
          },
        })
      );
    });
  });

  describe('7. Security & Organizer Financial Isolation', () => {
    it('guarantees an organizer cannot view or access another organizer’s connected account or balance', async () => {
      const org1Acct = `acct_org1_${Date.now()}`;
      const org2Acct = `acct_org2_${Date.now()}`;

      await prisma.user.update({
        where: { id: organizerUserId },
        data: { stripeAccountId: org1Acct },
      });
      await prisma.user.update({
        where: { id: secondOrganizerUserId },
        data: { stripeAccountId: org2Acct },
      });

      const retrieveSpy = vi.spyOn(stripe.accounts, 'retrieve').mockResolvedValue({
        id: org2Acct,
        object: 'account',
        capabilities: { card_payments: 'active', transfers: 'active' },
        charges_enabled: true,
        payouts_enabled: true,
      } as any);

      // Org 2 calls get account
      const res = await request(app)
        .get('/api/organizer/finance/account')
        .set('Authorization', `Bearer ${secondOrganizerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.stripeAccountId).toBe(org2Acct);
      expect(retrieveSpy).toHaveBeenCalledWith(org2Acct);
      expect(retrieveSpy).not.toHaveBeenCalledWith(org1Acct);
    });
  });

  describe('8. Webhook Connected Account Synchronization', () => {
    it('idempotently updates masked bank account details in OrganizerPayoutDetails on account.updated event', async () => {
      const testAcctId = 'acct_webhook_test_808';
      await prisma.user.update({
        where: { id: organizerUserId },
        data: { stripeAccountId: testAcctId },
      });

      // Ensure user has an OrganizerPayoutDetails record
      await prisma.organizerPayoutDetails.upsert({
        where: { userId: organizerUserId },
        create: {
          userId: organizerUserId,
          orgType: 'Company',
          registeredName: 'Sol Experience Group',
          country: 'Kenya',
          contactPersonName: 'Sol Omondi',
          contactEmail: 'sol@outside.vip',
          accountHolderName: 'Sol Experience Group',
          bankName: 'Previous Bank',
          bankCountry: 'Kenya',
          accountNumberMasked: '•••• •••• •••• 1111',
          accountNumberLast4: '1111',
        },
        update: {},
      });

      const mockAccountUpdatedEvent: any = {
        id: `evt_acct_up_${Date.now()}`,
        type: 'account.updated',
        data: {
          object: {
            id: testAcctId,
            object: 'account',
            external_accounts: {
              object: 'list',
              data: [
                {
                  id: 'ba_wh_new_01',
                  object: 'bank_account',
                  bank_name: 'Standard Chartered Bank',
                  account_holder_name: 'Sol Experience Group',
                  country: 'Kenya',
                  last4: '9988',
                  routing_number: '02042',
                  currency: 'usd',
                  default_for_currency: true,
                },
              ],
            },
          },
        },
      };

      const result = await processStripeWebhookEvent(mockAccountUpdatedEvent);
      expect(result.handled).toBe(true);

      // Verify OrganizerPayoutDetails was updated with masked number
      const updatedDetails = await prisma.organizerPayoutDetails.findUnique({
        where: { userId: organizerUserId },
      });

      expect(updatedDetails?.bankName).toBe('Standard Chartered Bank');
      expect(updatedDetails?.accountNumberLast4).toBe('9988');
      expect(updatedDetails?.accountNumberMasked).toBe('•••• •••• •••• 9988');
      expect(updatedDetails?.routingCode).toBe('••••2042');
    });
  });

  describe('9. Stripe Error Handling, State Distinction & Security Redaction', () => {
    it('handles invalid or inaccessible connected account without leaking account ID or silently creating a new account', async () => {
      const invalidAcct = 'acct_invalid_stale_999';
      await prisma.user.update({
        where: { id: organizerUserId },
        data: { stripeAccountId: invalidAcct },
      });

      const retrieveSpy = vi.spyOn(stripe.accounts, 'retrieve').mockRejectedValue({
        type: 'StripeInvalidRequestError',
        code: 'resource_missing',
        message: `No such account: '${invalidAcct}'`,
        statusCode: 404,
      });

      const createSpy = vi.spyOn(stripe.accounts, 'create');

      const res = await request(app)
        .get('/api/organizer/finance/account')
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.connected).toBe(false);
      expect(res.body.data.connectionStatus).toBe('invalid_or_inaccessible');
      // Redaction: Never leak the invalid internal account ID to the frontend
      expect(res.body.data.stripeAccountId).toBeNull();
      expect(res.body.data.sellTickets.enabled).toBe(false);
      expect(res.body.data.sellTickets.status).toBe('disabled');
      expect(res.body.data.sellTickets.message).toContain('reconnect');

      // Requirement 8: Do not silently create new connected accounts when an existing account ID is invalid
      expect(createSpy).not.toHaveBeenCalled();

      // Database record remains unchanged until explicit user reconnection action
      const userAfter = await prisma.user.findUnique({
        where: { id: organizerUserId },
        select: { stripeAccountId: true },
      });
      expect(userAfter?.stripeAccountId).toBe(invalidAcct);
      expect(retrieveSpy).toHaveBeenCalledWith(invalidAcct);
    });

    it('handles Stripe authentication failure without leaking raw API key or secret fragments to response', async () => {
      const dummyAcct = 'acct_test_dummy_key_001';
      await prisma.user.update({
        where: { id: organizerUserId },
        data: { stripeAccountId: dummyAcct },
      });

      const leakedSecretFragment = 'sk_test_51URyM2ECbc8JnRTOmq3v3JWczvSYgsJbK3zffc9Y';
      vi.spyOn(stripe.accounts, 'retrieve').mockRejectedValue({
        type: 'StripeAuthenticationError',
        message: `Invalid API Key provided: ${leakedSecretFragment}...`,
        statusCode: 401,
      });

      const res = await request(app)
        .get('/api/organizer/finance/account')
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.connected).toBe(false);
      expect(res.body.data.connectionStatus).toBe('configuration_unavailable');
      expect(res.body.data.stripeAccountId).toBeNull();
      expect(res.body.data.sellTickets.message).toContain('configured');

      // Security Invariant: Stripe secret key fragments must NEVER appear in the response payload
      const responseBodyString = JSON.stringify(res.body);
      expect(responseBodyString).not.toContain(leakedSecretFragment);
      expect(responseBodyString).not.toContain('sk_test_');
      expect(responseBodyString).not.toContain('Invalid API Key');
    });

    it('returns structured INVALID_CONNECTED_ACCOUNT on balance request when connected account is invalid without leaking ID', async () => {
      const invalidAcct = 'acct_webhook_test_808';
      await prisma.user.update({
        where: { id: organizerUserId },
        data: { stripeAccountId: invalidAcct },
      });

      vi.spyOn(stripe.balance, 'retrieve').mockRejectedValue({
        type: 'StripeInvalidRequestError',
        code: 'resource_missing',
        message: `No such account: '${invalidAcct}'`,
        statusCode: 404,
      });

      const res = await request(app)
        .get('/api/organizer/finance/balance')
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_CONNECTED_ACCOUNT');
      expect(res.body.error.message).toContain('reconnect');

      // Security Invariant: The raw account ID must never leak in the error message
      expect(res.body.error.message).not.toContain(invalidAcct);
      expect(JSON.stringify(res.body)).not.toContain(invalidAcct);
    });

    it('returns structured STRIPE_SERVICE_UNAVAILABLE on transient network or Stripe 5xx error', async () => {
      const validAcct = 'acct_transient_test_500';
      await prisma.user.update({
        where: { id: organizerUserId },
        data: { stripeAccountId: validAcct },
      });

      vi.spyOn(stripe.balance, 'retrieve').mockRejectedValue({
        type: 'StripeConnectionError',
        code: 'ETIMEDOUT',
        message: 'Connection timed out to api.stripe.com:443',
        statusCode: 503,
      });

      const res = await request(app)
        .get('/api/organizer/finance/balance')
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(503);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('STRIPE_SERVICE_UNAVAILABLE');
      expect(res.body.error.message).toContain('temporarily unreachable');
      expect(JSON.stringify(res.body)).not.toContain('api.stripe.com');
    });

    it('supports explicit reconnection with reconnect: true to replace an invalid account ID without silent auto-creation', async () => {
      const oldInvalidAcct = 'acct_old_broken_001';
      const freshNewAcct = 'acct_fresh_new_002';
      await prisma.user.update({
        where: { id: organizerUserId },
        data: { stripeAccountId: oldInvalidAcct },
      });

      const createAccountSpy = vi.spyOn(stripe.accounts, 'create').mockResolvedValue({
        id: freshNewAcct,
        object: 'account',
      } as any);

      const createLinkSpy = vi.spyOn(stripe.accountLinks, 'create').mockResolvedValue({
        url: 'https://connect.stripe.com/setup/s/fresh_test_session',
      } as any);

      const res = await request(app)
        .post('/api/organizer/finance/onboarding-link')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({ reconnect: true });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(createAccountSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'express',
          metadata: expect.objectContaining({ userId: organizerUserId }),
        })
      );
      expect(createLinkSpy).toHaveBeenCalledWith(
        expect.objectContaining({ account: freshNewAcct })
      );

      // Verify the user's account ID was updated in the database
      const userAfter = await prisma.user.findUnique({
        where: { id: organizerUserId },
        select: { stripeAccountId: true },
      });
      expect(userAfter?.stripeAccountId).toBe(freshNewAcct);
    });
  });
});
