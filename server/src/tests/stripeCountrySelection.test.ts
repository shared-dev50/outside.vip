import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { prisma } from '../db/prisma.js';
import { stripe } from '../lib/stripe.js';
import { STRIPE_EXPRESS_SUPPORTED_COUNTRIES } from '../modules/finance/stripeCountries.js';

describe('Stripe Connect Express Country Selection & Validation', () => {
  let organizerToken: string;
  let organizerUserId: string;
  let attendeeToken: string;

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
  });

  beforeEach(async () => {
    // Reset test organizer's stripeAccountId and stripeAccountCountry before each test
    await prisma.user.update({
      where: { id: organizerUserId },
      data: {
        stripeAccountId: null,
        stripeAccountCountry: null,
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    // Clean up test state
    await prisma.user.update({
      where: { id: organizerUserId },
      data: {
        stripeAccountId: null,
        stripeAccountCountry: null,
      },
    });
  });

  describe('1. Supported Countries API (GET /api/organizer/finance/countries)', () => {
    it('returns allowlisted supported countries and default US for authenticated organizers', async () => {
      const res = await request(app)
        .get('/api/organizer/finance/countries')
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.defaultCountry).toBe('US');
      expect(Array.isArray(res.body.data.countries)).toBe(true);

      const countryCodes = res.body.data.countries.map((c: { code: string }) => c.code);
      expect(countryCodes).toContain('US');
      expect(countryCodes).toContain('CA');
      expect(countryCodes).toContain('GB');
      expect(countryCodes).toContain('AU');
      expect(countryCodes).toContain('FR');
      expect(countryCodes).toContain('DE');
      expect(countryCodes).toContain('JP');
      // Verify non-cross-border or unsupported country is not present
      expect(countryCodes).not.toContain('KE');
      expect(countryCodes).not.toContain('BR');
      expect(countryCodes).not.toContain('IN');

      // Check ISO alpha-2 uppercase formatting
      for (const item of res.body.data.countries) {
        expect(item.code).toMatch(/^[A-Z]{2}$/);
        expect(typeof item.name).toBe('string');
        expect(item.name.length).toBeGreaterThan(1);
      }
    });

    it('rejects unauthenticated requests with 401', async () => {
      const res = await request(app).get('/api/organizer/finance/countries');
      expect(res.status).toBe(401);
    });

    it('rejects attendee requests with 403 Forbidden', async () => {
      const res = await request(app)
        .get('/api/organizer/finance/countries')
        .set('Authorization', `Bearer ${attendeeToken}`);
      expect(res.status).toBe(403);
    });
  });

  describe('2. Country Validation on Onboarding Link Generation (POST /api/organizer/finance/onboarding-link)', () => {
    it('rejects unsupported arbitrary country code with 400 UNSUPPORTED_COUNTRY', async () => {
      const res = await request(app)
        .post('/api/organizer/finance/onboarding-link')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({ country: 'XX' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('UNSUPPORTED_COUNTRY');
      expect(res.body.error.message).toContain('XX');
    });

    it('rejects invalid country string formats with 400 validation error', async () => {
      const res = await request(app)
        .post('/api/organizer/finance/onboarding-link')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({ country: 'USA' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('accepts lowercase supported country code and normalizes to uppercase', async () => {
      const createAccountSpy = vi.spyOn(stripe.accounts, 'create').mockResolvedValueOnce({
        id: 'acct_test_ca_norm',
        country: 'CA',
      } as any);

      const createLinkSpy = vi.spyOn(stripe.accountLinks, 'create').mockResolvedValueOnce({
        url: 'https://connect.stripe.com/setup/s/norm_ca_test',
        created: Math.floor(Date.now() / 1000),
        expires_at: Math.floor(Date.now() / 1000) + 300,
        object: 'account_link',
      } as any);

      const res = await request(app)
        .post('/api/organizer/finance/onboarding-link')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({ country: 'ca' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(createAccountSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'express',
          country: 'CA',
        })
      );

      // Verify persisted in DB as uppercase CA
      const user = await prisma.user.findUnique({ where: { id: organizerUserId } });
      expect(user?.stripeAccountId).toBe('acct_test_ca_norm');
      expect(user?.stripeAccountCountry).toBe('CA');
    });
  });

  describe('3. Account Creation & Country Persistence in Database', () => {
    it('creates an Express account with specified country and persists stripeAccountCountry', async () => {
      const createAccountSpy = vi.spyOn(stripe.accounts, 'create').mockResolvedValueOnce({
        id: 'acct_test_gb_123',
        country: 'GB',
      } as any);

      const createLinkSpy = vi.spyOn(stripe.accountLinks, 'create').mockResolvedValueOnce({
        url: 'https://connect.stripe.com/setup/s/gb_link_123',
        created: Math.floor(Date.now() / 1000),
        expires_at: Math.floor(Date.now() / 1000) + 300,
        object: 'account_link',
      } as any);

      const res = await request(app)
        .post('/api/organizer/finance/onboarding-link')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({ country: 'GB' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.url).toBe('https://connect.stripe.com/setup/s/gb_link_123');

      expect(createAccountSpy).toHaveBeenCalledWith({
        type: 'express',
        country: 'GB',
        email: 'sol@outside.vip',
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_type: 'individual',
        metadata: {
          userId: organizerUserId,
          platform: 'outside.vip',
        },
      });

      // Verify persistence in Postgres database
      const user = await prisma.user.findUnique({ where: { id: organizerUserId } });
      expect(user?.stripeAccountId).toBe('acct_test_gb_123');
      expect(user?.stripeAccountCountry).toBe('GB');
    });

    it('defaults to US when no country is provided during initial account creation', async () => {
      const createAccountSpy = vi.spyOn(stripe.accounts, 'create').mockResolvedValueOnce({
        id: 'acct_test_us_default',
        country: 'US',
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
        })
      );

      const user = await prisma.user.findUnique({ where: { id: organizerUserId } });
      expect(user?.stripeAccountId).toBe('acct_test_us_default');
      expect(user?.stripeAccountCountry).toBe('US');
    });
  });

  describe('4. Reuse of Existing Connected Accounts and Country Retention', () => {
    it('reuses existing account and retains its original country on subsequent onboarding attempts', async () => {
      // Setup user with existing account and country CA
      await prisma.user.update({
        where: { id: organizerUserId },
        data: {
          stripeAccountId: 'acct_existing_ca_456',
          stripeAccountCountry: 'CA',
        },
      });

      const createAccountSpy = vi.spyOn(stripe.accounts, 'create');
      const createLinkSpy = vi.spyOn(stripe.accountLinks, 'create').mockResolvedValueOnce({
        url: 'https://connect.stripe.com/setup/s/reuse_link',
        created: Math.floor(Date.now() / 1000),
        expires_at: Math.floor(Date.now() / 1000) + 300,
        object: 'account_link',
      } as any);

      // Subsequent onboarding attempt passes a different country "AU", but account already exists!
      const res = await request(app)
        .post('/api/organizer/finance/onboarding-link')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({ country: 'AU' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Must NOT recreate account
      expect(createAccountSpy).not.toHaveBeenCalled();
      expect(createLinkSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          account: 'acct_existing_ca_456',
        })
      );

      // Country in DB must retain CA
      const user = await prisma.user.findUnique({ where: { id: organizerUserId } });
      expect(user?.stripeAccountId).toBe('acct_existing_ca_456');
      expect(user?.stripeAccountCountry).toBe('CA');
    });

    it('reconnect: true creates a new account with the requested country', async () => {
      // Existing account with CA
      await prisma.user.update({
        where: { id: organizerUserId },
        data: {
          stripeAccountId: 'acct_old_ca',
          stripeAccountCountry: 'CA',
        },
      });

      const createAccountSpy = vi.spyOn(stripe.accounts, 'create').mockResolvedValueOnce({
        id: 'acct_new_de_789',
        country: 'DE',
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
        .send({ reconnect: true, country: 'DE' });

      expect(res.status).toBe(200);
      expect(createAccountSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          country: 'DE',
        })
      );

      const user = await prisma.user.findUnique({ where: { id: organizerUserId } });
      expect(user?.stripeAccountId).toBe('acct_new_de_789');
      expect(user?.stripeAccountCountry).toBe('DE');
    });

    it('reconnect: true without country falls back to original persisted country', async () => {
      await prisma.user.update({
        where: { id: organizerUserId },
        data: {
          stripeAccountId: 'acct_old_nz',
          stripeAccountCountry: 'NZ',
        },
      });

      const createAccountSpy = vi.spyOn(stripe.accounts, 'create').mockResolvedValueOnce({
        id: 'acct_new_nz_999',
        country: 'NZ',
      } as any);

      vi.spyOn(stripe.accountLinks, 'create').mockResolvedValueOnce({
        url: 'https://connect.stripe.com/setup/s/reconnect_nz',
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
        expect.objectContaining({
          country: 'NZ',
        })
      );

      const user = await prisma.user.findUnique({ where: { id: organizerUserId } });
      expect(user?.stripeAccountId).toBe('acct_new_nz_999');
      expect(user?.stripeAccountCountry).toBe('NZ');
    });
  });

  describe('5. Status Endpoint Country Reporting (GET /api/organizer/finance/account)', () => {
    it('returns the connected account country and supported countries list', async () => {
      await prisma.user.update({
        where: { id: organizerUserId },
        data: {
          stripeAccountId: 'acct_verified_au',
          stripeAccountCountry: 'AU',
        },
      });

      vi.spyOn(stripe.accounts, 'retrieve').mockResolvedValueOnce({
        id: 'acct_verified_au',
        charges_enabled: true,
        payouts_enabled: true,
        details_submitted: true,
        country: 'AU',
        default_currency: 'aud',
        requirements: {
          currently_due: [],
          eventually_due: [],
          past_due: [],
          disabled_reason: null,
        },
        external_accounts: {
          data: [],
        },
      } as any);

      const res = await request(app)
        .get('/api/organizer/finance/account')
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.connected).toBe(true);
      expect(res.body.data.country).toBe('AU');
      expect(Array.isArray(res.body.data.supportedCountries)).toBe(true);
      expect(res.body.data.supportedCountries.length).toBe(STRIPE_EXPRESS_SUPPORTED_COUNTRIES.length);
    });

    it('returns persisted country in disconnected status when account was reset', async () => {
      await prisma.user.update({
        where: { id: organizerUserId },
        data: {
          stripeAccountId: null,
          stripeAccountCountry: 'FR',
        },
      });

      const res = await request(app)
        .get('/api/organizer/finance/account')
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.connected).toBe(false);
      expect(res.body.data.country).toBe('FR');
      expect(Array.isArray(res.body.data.supportedCountries)).toBe(true);
    });
  });

  describe('6. Error Handling for Stripe Country Rejections', () => {
    it('gracefully handles Stripe country_unsupported rejection', async () => {
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
