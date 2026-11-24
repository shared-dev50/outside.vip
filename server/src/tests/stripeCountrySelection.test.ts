import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { prisma } from '../db/prisma.js';
import { stripe } from '../lib/stripe.js';
import { STRIPE_EXPRESS_SUPPORTED_COUNTRIES } from '../modules/finance/stripeCountries.js';

describe('Stripe Connect Express Country Selection & Validation (US Launch)', () => {
  let organizerToken: string;
  let organizerUserId: string;
  let attendeeToken: string;
  const originalConfiguredCountries = process.env.STRIPE_CONNECT_SUPPORTED_COUNTRIES;

  beforeAll(async () => {
    const organizerLogin = await request(app).post('/api/auth/login').send({
      email: 'sol@outside.vip',
      password: 'Outside2026!',
    });
    expect(organizerLogin.status).toBe(200);
    organizerToken = organizerLogin.body.data.token;
    organizerUserId = organizerLogin.body.data.user.id;

    const attendeeLogin = await request(app).post('/api/auth/login').send({
      email: 'alex@outside.vip',
      password: 'Outside2026!',
    });
    expect(attendeeLogin.status).toBe(200);
    attendeeToken = attendeeLogin.body.data.token;
  });

  beforeEach(async () => {
    if (originalConfiguredCountries === undefined) {
      delete process.env.STRIPE_CONNECT_SUPPORTED_COUNTRIES;
    } else {
      process.env.STRIPE_CONNECT_SUPPORTED_COUNTRIES = originalConfiguredCountries;
    }
    await prisma.user.update({
      where: { id: organizerUserId },
      data: {
        stripeAccountId: null,
        stripeAccountCountry: null,
        stripeAccountCreationKey: null,
        stripeAccountCreationLockedBy: null,
        stripeAccountCreationLockedUntil: null,
      },
    });
  });

  afterEach(() => {
    if (originalConfiguredCountries === undefined) {
      delete process.env.STRIPE_CONNECT_SUPPORTED_COUNTRIES;
    } else {
      process.env.STRIPE_CONNECT_SUPPORTED_COUNTRIES = originalConfiguredCountries;
    }
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await prisma.user.update({
      where: { id: organizerUserId },
      data: {
        stripeAccountId: null,
        stripeAccountCountry: null,
        stripeAccountCreationKey: null,
        stripeAccountCreationLockedBy: null,
        stripeAccountCreationLockedUntil: null,
      },
    });
  });

  describe('1. Supported Countries API (GET /api/organizer/finance/countries)', () => {
    it('returns strictly US and default US for authenticated organizers under initial US/USD launch', async () => {
      const res = await request(app)
        .get('/api/organizer/finance/countries')
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.defaultCountry).toBe('US');
      expect(res.body.data.countries).toEqual([{ code: 'US', name: 'United States' }]);
      expect(STRIPE_EXPRESS_SUPPORTED_COUNTRIES).toEqual([{ code: 'US', name: 'United States' }]);
    });

    it('allows configuration-driven country expansion when STRIPE_CONNECT_SUPPORTED_COUNTRIES is configured', async () => {
      process.env.STRIPE_CONNECT_SUPPORTED_COUNTRIES = 'US,CA';
      const res = await request(app)
        .get('/api/organizer/finance/countries')
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.countries.map((c: { code: string }) => c.code)).toEqual(['US', 'CA']);
    });

    it('rejects unauthenticated requests with 401 and attendee requests with 403', async () => {
      const unauth = await request(app).get('/api/organizer/finance/countries');
      expect(unauth.status).toBe(401);

      const attendee = await request(app)
        .get('/api/organizer/finance/countries')
        .set('Authorization', `Bearer ${attendeeToken}`);
      expect(attendee.status).toBe(403);
    });
  });

  describe('2. Country Validation on Onboarding Link Generation (POST /api/organizer/finance/onboarding-link)', () => {
    it('rejects non-US country codes (CA, GB, DE, KE) and unknown codes with 400 UNSUPPORTED_COUNTRY', async () => {
      for (const code of ['XX', 'CA', 'GB', 'DE', 'KE']) {
        const res = await request(app)
          .post('/api/organizer/finance/onboarding-link')
          .set('Authorization', `Bearer ${organizerToken}`)
          .send({ country: code });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error.code).toBe('UNSUPPORTED_COUNTRY');
      }
    });

    it('rejects invalid country string formats with 400 validation error', async () => {
      const res = await request(app)
        .post('/api/organizer/finance/onboarding-link')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({ country: 'USA' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('accepts lowercase us and normalizes to uppercase US', async () => {
      const createAccountSpy = vi.spyOn(stripe.accounts, 'create').mockResolvedValueOnce({
        id: 'acct_test_us_norm',
        country: 'US',
        default_currency: 'usd',
      } as any);

      vi.spyOn(stripe.accountLinks, 'create').mockResolvedValueOnce({
        url: 'https://connect.stripe.com/setup/s/norm_us_test',
        created: Math.floor(Date.now() / 1000),
        expires_at: Math.floor(Date.now() / 1000) + 300,
        object: 'account_link',
      } as any);

      const res = await request(app)
        .post('/api/organizer/finance/onboarding-link')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({ country: 'us' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(createAccountSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'express',
          country: 'US',
        }),
        expect.objectContaining({
          idempotencyKey: expect.stringMatching(/^acct_create_/),
        })
      );

      const user = await prisma.user.findUnique({ where: { id: organizerUserId } });
      expect(user?.stripeAccountId).toBe('acct_test_us_norm');
      expect(user?.stripeAccountCountry).toBe('US');
    });
  });

  describe('3. Account Creation, Reuse & Guarded Reconnect', () => {
    it('defaults to US when no country is provided during initial account creation', async () => {
      const createAccountSpy = vi.spyOn(stripe.accounts, 'create').mockResolvedValueOnce({
        id: 'acct_test_us_default',
        country: 'US',
        default_currency: 'usd',
      } as any);

      vi.spyOn(stripe.accountLinks, 'create').mockResolvedValueOnce({
        url: 'https://connect.stripe.com/setup/s/us_link_def',
        created: Math.floor(Date.now() / 1000),
        expires_at: Math.floor(Date.now() / 1000) + 300,
        object: 'account_link',
      } as any);

      const res = await request(app)
        .post('/api/organizer/finance/onboarding-link')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({});

      expect(res.status).toBe(200);
      expect(createAccountSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          country: 'US',
        }),
        expect.anything()
      );

      const user = await prisma.user.findUnique({ where: { id: organizerUserId } });
      expect(user?.stripeAccountId).toBe('acct_test_us_default');
      expect(user?.stripeAccountCountry).toBe('US');
    });

    it('reuses existing US account on subsequent onboarding attempts', async () => {
      await prisma.user.update({
        where: { id: organizerUserId },
        data: {
          stripeAccountId: 'acct_existing_us_456',
          stripeAccountCountry: 'US',
        },
      });

      const createAccountSpy = vi.spyOn(stripe.accounts, 'create');
      const createLinkSpy = vi.spyOn(stripe.accountLinks, 'create').mockResolvedValueOnce({
        url: 'https://connect.stripe.com/setup/s/reuse_link',
        created: Math.floor(Date.now() / 1000),
        expires_at: Math.floor(Date.now() / 1000) + 300,
        object: 'account_link',
      } as any);

      const res = await request(app)
        .post('/api/organizer/finance/onboarding-link')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({});

      expect(res.status).toBe(200);
      expect(createAccountSpy).not.toHaveBeenCalled();
      expect(createLinkSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          account: 'acct_existing_us_456',
        })
      );
    });

    it('allows reconnect: true only when existing account is confirmed invalid/inaccessible in Stripe', async () => {
      await prisma.user.update({
        where: { id: organizerUserId },
        data: {
          stripeAccountId: 'acct_old_broken_us',
          stripeAccountCountry: 'US',
        },
      });

      vi.spyOn(stripe.accounts, 'retrieve').mockRejectedValueOnce({
        type: 'StripeInvalidRequestError',
        code: 'resource_missing',
        message: 'No such account: acct_old_broken_us',
        statusCode: 404,
      });

      const createAccountSpy = vi.spyOn(stripe.accounts, 'create').mockResolvedValueOnce({
        id: 'acct_new_us_789',
        country: 'US',
        default_currency: 'usd',
      } as any);

      vi.spyOn(stripe.accountLinks, 'create').mockResolvedValueOnce({
        url: 'https://connect.stripe.com/setup/s/reconnect_link',
        created: Math.floor(Date.now() / 1000),
        expires_at: Math.floor(Date.now() / 1000) + 300,
        object: 'account_link',
      } as any);

      const res = await request(app)
        .post('/api/organizer/finance/onboarding-link')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({ reconnect: true });

      expect(res.status).toBe(200);
      expect(createAccountSpy).toHaveBeenCalledWith(
        expect.objectContaining({ country: 'US' }),
        expect.anything()
      );

      const user = await prisma.user.findUnique({ where: { id: organizerUserId } });
      expect(user?.stripeAccountId).toBe('acct_new_us_789');
      expect(user?.stripeAccountCountry).toBe('US');
    });
  });

  describe('4. Status Endpoint & Stripe Country Rejection Handling', () => {
    it('returns US country and US-only supportedCountries in /api/organizer/finance/account', async () => {
      await prisma.user.update({
        where: { id: organizerUserId },
        data: {
          stripeAccountId: 'acct_verified_us',
          stripeAccountCountry: 'US',
        },
      });

      vi.spyOn(stripe.accounts, 'retrieve').mockResolvedValueOnce({
        id: 'acct_verified_us',
        charges_enabled: true,
        payouts_enabled: true,
        details_submitted: true,
        country: 'US',
        default_currency: 'usd',
        capabilities: { card_payments: 'active', transfers: 'active' },
        requirements: {
          currently_due: [],
          eventually_due: [],
          past_due: [],
          disabled_reason: null,
        },
        external_accounts: { data: [] },
      } as any);

      const res = await request(app)
        .get('/api/organizer/finance/account')
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.connected).toBe(true);
      expect(res.body.data.country).toBe('US');
      expect(res.body.data.supportedCountries).toEqual([{ code: 'US', name: 'United States' }]);
    });

    it('gracefully handles Stripe country_unsupported rejection when expanded via config', async () => {
      process.env.STRIPE_CONNECT_SUPPORTED_COUNTRIES = 'US,CH';
      const stripeErr: any = new Error(
        'The country is not supported for Express accounts on this platform.'
      );
      stripeErr.code = 'country_unsupported';
      stripeErr.type = 'StripeInvalidRequestError';

      vi.spyOn(stripe.accounts, 'create').mockRejectedValueOnce(stripeErr);

      const res = await request(app)
        .post('/api/organizer/finance/onboarding-link')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({ country: 'CH' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('STRIPE_COUNTRY_UNSUPPORTED');
    });
  });
});
