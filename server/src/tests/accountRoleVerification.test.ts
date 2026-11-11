import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { prisma } from '../db/prisma.js';
import { stripe } from '../lib/stripe.js';
import {
  sentVerificationEmails,
  resetSentVerificationEmails,
  getLatestVerificationEmail,
} from '../lib/email.service.js';
import {
  recordedAdminAuditLogs,
  resetRecordedAdminAuditLogs,
} from '../lib/auditLogger.js';
import {
  hashVerificationCode,
  resetVerificationRateLimits,
} from '../modules/auth/auth.controller.js';

describe('Account, Role, Email Verification, Organizer Onboarding & Admin Architecture', () => {
  const createdUserIds: string[] = [];
  const createdEventIds: string[] = [];
  const createdOrderNumbers: string[] = [];
  const originalAdminEmails = process.env.ADMIN_EMAILS;

  let seededPublishedEventId: string;
  let seededActiveTierId: string;

  beforeAll(async () => {
    const publishedEvents = await prisma.event.findMany({
      where: {
        status: 'PUBLISHED',
        isPasswordProtected: false,
        endAt: { gt: new Date() },
      },
      include: {
        ticketTiers: true,
      },
    });

    let chosenEvent = publishedEvents.find((ev) =>
      ev.ticketTiers.some(
        (t) =>
          t.status === 'ACTIVE' &&
          t.totalCapacity > t.soldQuantity + t.reservedQuantity + 5 &&
          !t.salesStartAt &&
          !t.salesEndAt
      )
    );

    if (!chosenEvent) {
      chosenEvent = publishedEvents[0];
    }

    expect(chosenEvent).toBeTruthy();
    seededPublishedEventId = chosenEvent!.id;
    const validTier = chosenEvent!.ticketTiers.find(
      (t) =>
        t.status === 'ACTIVE' &&
        t.totalCapacity > t.soldQuantity + t.reservedQuantity + 5 &&
        !t.salesStartAt &&
        !t.salesEndAt
    );
    seededActiveTierId = validTier ? validTier.id : chosenEvent!.ticketTiers[0].id;
  });

  beforeEach(() => {
    resetSentVerificationEmails();
    resetRecordedAdminAuditLogs();
    resetVerificationRateLimits();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env.ADMIN_EMAILS = originalAdminEmails;
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    process.env.ADMIN_EMAILS = originalAdminEmails;

    if (createdOrderNumbers.length > 0) {
      const orders = await prisma.order.findMany({
        where: { orderNumber: { in: createdOrderNumbers } },
        select: { id: true },
      });
      const orderIds = orders.map((o) => o.id);
      if (orderIds.length > 0) {
        await prisma.ticket.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.ticketReservation.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.paymentTransaction.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
      }
    }

    if (createdEventIds.length > 0) {
      await prisma.eventGalleryImage.deleteMany({ where: { eventId: { in: createdEventIds } } });
      await prisma.eventFeature.deleteMany({ where: { eventId: { in: createdEventIds } } });
      await prisma.ticketTier.deleteMany({ where: { eventId: { in: createdEventIds } } });
      await prisma.event.deleteMany({ where: { id: { in: createdEventIds } } });
    }

    if (createdUserIds.length > 0) {
      await prisma.emailVerificationCode.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.adminAuditLog.deleteMany({ where: { actorUserId: { in: createdUserIds } } });
      await prisma.organizerProfile.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
  });

  // =========================================================================
  // 1. New registration defaults to attendee functionality
  // =========================================================================
  describe('1. Registration & Default Attendee Functionality', () => {
    it('registers new users with ATTENDEE role and emailVerified=false by default even if ORGANIZER role is passed', async () => {
      const email = `new_attendee_${Date.now()}@outside.vip`;
      const res = await request(app).post('/api/auth/register').send({
        email: `  ${email.toUpperCase()}  `,
        password: 'OutsidePassword2026!',
        name: 'Default Attendee User',
        role: 'ORGANIZER',
      });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.user.email).toBe(email);
      expect(res.body.data.user.role).toBe('ATTENDEE');
      expect(res.body.data.user.emailVerified).toBe(false);
      expect(res.body.data.user.emailVerifiedAt).toBeNull();
      expect(res.body.data.verificationRequired).toBe(true);

      createdUserIds.push(res.body.data.user.id);

      // Verify OTP email was sent and stored hashed (not plaintext) in DB
      const sentEmail = getLatestVerificationEmail(email);
      expect(sentEmail).toBeDefined();
      expect(sentEmail!.code).toMatch(/^\d{6}$/);

      const dbCode = await prisma.emailVerificationCode.findFirst({
        where: { userId: res.body.data.user.id },
      });
      expect(dbCode).toBeTruthy();
      expect(dbCode!.codeHash).not.toBe(sentEmail!.code);
      expect(dbCode!.codeHash).toBe(hashVerificationCode(res.body.data.user.id, sentEmail!.code));
    });

    it('allows newly registered attendee to purchase tickets and view their attendee order', async () => {
      vi.spyOn(stripe.paymentIntents, 'create').mockResolvedValue({
        id: `pi_att_default_${Date.now()}`,
        client_secret: 'pi_att_default_secret_123',
        status: 'requires_payment_method',
      } as any);

      const email = `buyer_attendee_${Date.now()}@outside.vip`;
      const regRes = await request(app).post('/api/auth/register').send({
        email,
        password: 'OutsidePassword2026!',
        name: 'Attendee Ticket Buyer',
      });
      expect(regRes.status).toBe(201);
      const token = regRes.body.data.token;
      createdUserIds.push(regRes.body.data.user.id);

      const checkoutRes = await request(app)
        .post('/api/checkout/create-session')
        .set('Authorization', `Bearer ${token}`)
        .send({
          eventId: seededPublishedEventId,
          customerEmail: email,
          customerName: 'Attendee Ticket Buyer',
          customerPhone: '+14155552671',
          marketingConsent: true,
          idempotencyKey: `idem_att_${Date.now()}`,
          items: [{ ticketTierId: seededActiveTierId, quantity: 1 }],
        });

      expect(checkoutRes.status).toBe(201);
      expect(checkoutRes.body.success).toBe(true);
      const orderNumber = checkoutRes.body.data.orderNumber;
      createdOrderNumbers.push(orderNumber);

      // Authenticated attendee can view their own order without guest access token
      const orderRes = await request(app)
        .get(`/api/orders/${orderNumber}`)
        .set('Authorization', `Bearer ${token}`);
      expect(orderRes.status).toBe(200);
      expect(orderRes.body.data.order.orderNumber).toBe(orderNumber);
    });
  });

  // =========================================================================
  // 2. Email verification success, expiry, reuse, cooldown, and rate limits
  // =========================================================================
  describe('2. Six-Digit Single-Use OTP Email Verification', () => {
    it('verifies a valid 6-digit OTP code, persists emailVerified & emailVerifiedAt, and prevents code reuse', async () => {
      const email = `otp_verify_${Date.now()}@outside.vip`;
      const regRes = await request(app).post('/api/auth/register').send({
        email,
        password: 'OutsidePassword2026!',
        name: 'OTP Verify User',
      });
      expect(regRes.status).toBe(201);
      const userId = regRes.body.data.user.id;
      const token = regRes.body.data.token;
      createdUserIds.push(userId);

      const sentEmail = getLatestVerificationEmail(email);
      expect(sentEmail).toBeDefined();
      const otpCode = sentEmail!.code;

      const verifyRes = await request(app)
        .post('/api/auth/verify-email')
        .set('Authorization', `Bearer ${token}`)
        .send({ code: otpCode });

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.success).toBe(true);
      expect(verifyRes.body.data.user.emailVerified).toBe(true);
      expect(verifyRes.body.data.user.emailVerifiedAt).toBeTruthy();

      // Reusing the same code after verification must be rejected
      const reuseRes = await request(app)
        .post('/api/auth/verify-email')
        .set('Authorization', `Bearer ${token}`)
        .send({ code: otpCode });

      expect(reuseRes.status).toBe(400);
      expect(reuseRes.body.error.code).toBe('VERIFICATION_CODE_USED');
    });

    it('rejects expired verification codes (after 10 minutes)', async () => {
      const email = `otp_expired_${Date.now()}@outside.vip`;
      const regRes = await request(app).post('/api/auth/register').send({
        email,
        password: 'OutsidePassword2026!',
        name: 'Expired OTP User',
      });
      const userId = regRes.body.data.user.id;
      const token = regRes.body.data.token;
      createdUserIds.push(userId);

      const sentEmail = getLatestVerificationEmail(email)!;

      // Simulate code expiring after 10 minutes
      await prisma.emailVerificationCode.updateMany({
        where: { userId },
        data: {
          expiresAt: new Date(Date.now() - 1000),
        },
      });

      const verifyRes = await request(app)
        .post('/api/auth/verify-email')
        .set('Authorization', `Bearer ${token}`)
        .send({ code: sentEmail.code });

      expect(verifyRes.status).toBe(400);
      expect(verifyRes.body.error.code).toBe('VERIFICATION_CODE_EXPIRED');
    });

    it('enforces resend cooldown (60s) and invalidates older codes when a new code is issued', async () => {
      const email = `otp_resend_${Date.now()}@outside.vip`;
      const regRes = await request(app).post('/api/auth/register').send({
        email,
        password: 'OutsidePassword2026!',
        name: 'Resend Cooldown User',
      });
      const userId = regRes.body.data.user.id;
      const token = regRes.body.data.token;
      createdUserIds.push(userId);

      const firstCode = getLatestVerificationEmail(email)!.code;

      // Immediate resend within 60s cooldown should return 429
      const immediateResend = await request(app)
        .post('/api/auth/resend-verification')
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(immediateResend.status).toBe(429);
      expect(immediateResend.body.error.code).toBe('VERIFICATION_RESEND_COOLDOWN');

      // Backdate createdAt past 60s cooldown so resend succeeds
      await prisma.emailVerificationCode.updateMany({
        where: { userId },
        data: {
          createdAt: new Date(Date.now() - 65 * 1000),
        },
      });

      const resendRes = await request(app)
        .post('/api/auth/resend-verification')
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(resendRes.status).toBe(200);

      const secondCode = getLatestVerificationEmail(email)!.code;

      // If the random 6-digit code differs, the old code must no longer work
      if (firstCode !== secondCode) {
        const oldCodeAttempt = await request(app)
          .post('/api/auth/verify-email')
          .set('Authorization', `Bearer ${token}`)
          .send({ code: firstCode });
        expect(oldCodeAttempt.status).toBe(400);
      }

      // New code succeeds
      const newCodeAttempt = await request(app)
        .post('/api/auth/verify-email')
        .set('Authorization', `Bearer ${token}`)
        .send({ code: secondCode });
      expect(newCodeAttempt.status).toBe(200);
      expect(newCodeAttempt.body.data.user.emailVerified).toBe(true);
    });

    it('rate-limits repeated invalid verification attempts and resend requests', async () => {
      const email = `otp_ratelimit_${Date.now()}@outside.vip`;
      const regRes = await request(app).post('/api/auth/register').send({
        email,
        password: 'OutsidePassword2026!',
        name: 'Rate Limit User',
      });
      const userId = regRes.body.data.user.id;
      const token = regRes.body.data.token;
      createdUserIds.push(userId);

      // Exhaust max attempts (5) on the code with wrong codes
      for (let i = 0; i < 5; i++) {
        const wrongRes = await request(app)
          .post('/api/auth/verify-email')
          .set('Authorization', `Bearer ${token}`)
          .send({ code: '000000' });
        expect(wrongRes.status).toBe(400);
      }

      // 6th attempt on the same code returns 429 VERIFICATION_MAX_ATTEMPTS
      const lockedRes = await request(app)
        .post('/api/auth/verify-email')
        .set('Authorization', `Bearer ${token}`)
        .send({ code: '000000' });
      expect(lockedRes.status).toBe(429);
      expect(lockedRes.body.error.code).toBe('VERIFICATION_MAX_ATTEMPTS');
    });
  });

  // =========================================================================
  // 3. Unverified users cannot create events or access organizer endpoints
  // =========================================================================
  describe('3. Backend Enforcement of Email Verification for Organizer Access', () => {
    it('blocks unverified users from creating events or accessing organizer endpoints with 403 Forbidden', async () => {
      const email = `unverified_org_${Date.now()}@outside.vip`;
      const regRes = await request(app).post('/api/auth/register').send({
        email,
        password: 'OutsidePassword2026!',
        name: 'Unverified User',
      });
      const token = regRes.body.data.token;
      createdUserIds.push(regRes.body.data.user.id);

      const createEventRes = await request(app)
        .post('/api/organizer/events')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'Blocked Unverified Event',
          coverImageUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819',
          venueName: 'Test Venue',
          city: 'New York',
          startAt: new Date(Date.now() + 86400000 * 3).toISOString(),
          endAt: new Date(Date.now() + 86400000 * 3 + 14400000).toISOString(),
        });
      expect(createEventRes.status).toBe(403);
      expect(createEventRes.body.error.message).toMatch(/verification/i);

      const dashRes = await request(app)
        .get('/api/organizer/dashboard')
        .set('Authorization', `Bearer ${token}`);
      expect(dashRes.status).toBe(403);

      const financeRes = await request(app)
        .get('/api/organizer/finance/account')
        .set('Authorization', `Bearer ${token}`);
      expect(financeRes.status).toBe(403);
    });
  });

  // =========================================================================
  // 4 & 5 & 6. Verified attendees can create drafts, publish free events,
  // and paid event publishing requires Stripe readiness
  // =========================================================================
  describe('4, 5 & 6. Verified Attendee Organizer Onboarding, Drafts, Free vs Paid Publishing & Dual Attendee-Organizer Capability', () => {
    let verifiedAttendeeToken: string;
    let verifiedAttendeeId: string;
    let verifiedAttendeeEmail: string;
    let freeDraftEventId: string;
    let paidDraftEventId: string;

    beforeAll(async () => {
      verifiedAttendeeEmail = `verified_creator_${Date.now()}@outside.vip`;
      const regRes = await request(app).post('/api/auth/register').send({
        email: verifiedAttendeeEmail,
        password: 'OutsidePassword2026!',
        name: 'Verified Event Creator',
      });
      verifiedAttendeeId = regRes.body.data.user.id;
      createdUserIds.push(verifiedAttendeeId);

      const otpCode = getLatestVerificationEmail(verifiedAttendeeEmail)!.code;
      const verifyRes = await request(app)
        .post('/api/auth/verify-email')
        .set('Authorization', `Bearer ${regRes.body.data.token}`)
        .send({ code: otpCode });

      expect(verifyRes.status).toBe(200);
      verifiedAttendeeToken = verifyRes.body.data.token;
    });

    it('4a. Verified attendee can create and save event drafts (both free and paid) without Stripe onboarding, auto-creating an OrganizerProfile workspace', async () => {
      // Create a free event draft
      const freeRes = await request(app)
        .post('/api/organizer/events')
        .set('Authorization', `Bearer ${verifiedAttendeeToken}`)
        .send({
          title: 'Community Rooftop Open Decks (Free)',
          tagline: 'Free open-air community synthesizer & DJ session',
          description: 'Bring your own records and modular gear.',
          category: 'MUSIC',
          status: 'DRAFT',
          coverImageUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819',
          venueName: 'Skyline Commons',
          venueAddress: '200 Rooftop Way',
          city: 'New York',
          country: 'United States',
          startAt: new Date(Date.now() + 86400000 * 5).toISOString(),
          endAt: new Date(Date.now() + 86400000 * 5 + 14400000).toISOString(),
          timezone: 'America/New_York',
          ticketTiers: [
            {
              name: 'Free RSVP Pass',
              description: 'Complimentary community admission',
              priceInCents: 0,
              currency: 'USD',
              totalCapacity: 150,
              minPerOrder: 1,
              maxPerOrder: 4,
              status: 'ACTIVE',
            },
          ],
        });

      expect(freeRes.status).toBe(201);
      expect(freeRes.body.data.event.status).toBe('DRAFT');
      freeDraftEventId = freeRes.body.data.event.id;
      createdEventIds.push(freeDraftEventId);

      // Verify OrganizerProfile workspace was automatically created
      const wsRes = await request(app)
        .get('/api/organizer/workspace')
        .set('Authorization', `Bearer ${verifiedAttendeeToken}`);
      expect(wsRes.status).toBe(200);
      expect(wsRes.body.data.organizer).toBeTruthy();
      expect(wsRes.body.data.organizer.displayName).toBe('Verified Event Creator');

      // Create a second event (paid draft) without Stripe onboarding
      const paidRes = await request(app)
        .post('/api/organizer/events')
        .set('Authorization', `Bearer ${verifiedAttendeeToken}`)
        .send({
          title: 'Paid Warehouse Showcase (Draft)',
          tagline: 'Late night showcase',
          description: 'Paid ticketed showcase saved as draft before Stripe onboarding.',
          category: 'NIGHTLIFE',
          status: 'DRAFT',
          coverImageUrl: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745',
          venueName: 'Dockyard 9',
          venueAddress: '99 Pier St',
          city: 'New York',
          country: 'United States',
          startAt: new Date(Date.now() + 86400000 * 10).toISOString(),
          endAt: new Date(Date.now() + 86400000 * 10 + 18000000).toISOString(),
          timezone: 'America/New_York',
          ticketTiers: [
            {
              name: 'General Admission',
              priceInCents: 3500,
              currency: 'USD',
              totalCapacity: 200,
              minPerOrder: 1,
              maxPerOrder: 4,
              status: 'ACTIVE',
            },
          ],
        });

      expect(paidRes.status).toBe(201);
      expect(paidRes.body.data.event.status).toBe('DRAFT');
      paidDraftEventId = paidRes.body.data.event.id;
      createdEventIds.push(paidDraftEventId);

      // Verify user can edit the draft and manage multiple events
      const listRes = await request(app)
        .get('/api/organizer/events')
        .set('Authorization', `Bearer ${verifiedAttendeeToken}`);
      expect(listRes.status).toBe(200);
      expect(listRes.body.data.events.length).toBeGreaterThanOrEqual(2);
    });

    it('5. Verified attendee can publish a FREE event without Stripe onboarding', async () => {
      const pubRes = await request(app)
        .post(`/api/organizer/events/${freeDraftEventId}/publish`)
        .set('Authorization', `Bearer ${verifiedAttendeeToken}`);

      expect(pubRes.status).toBe(200);
      expect(pubRes.body.success).toBe(true);
      expect(pubRes.body.data.event.status).toBe('PUBLISHED');
    });

    it('6a. Paid event publishing is rejected when organizer has not connected Stripe Express, explaining what is needed', async () => {
      const pubRes = await request(app)
        .post(`/api/organizer/events/${paidDraftEventId}/publish`)
        .set('Authorization', `Bearer ${verifiedAttendeeToken}`);

      expect(pubRes.status).toBe(400);
      expect(pubRes.body.success).toBe(false);
      expect(pubRes.body.error.code).toBe('STRIPE_ONBOARDING_INCOMPLETE');
      expect(pubRes.body.error.message).toMatch(/Stripe/i);
      expect(pubRes.body.error.message).toMatch(/transfer/i);
    });

    it('6b. Paid event publishing is rejected when Stripe Express onboarding is incomplete (missing requirements / transfers inactive), listing missing requirements', async () => {
      const testStripeAcctId = `acct_incomplete_${Date.now()}`;
      await prisma.user.update({
        where: { id: verifiedAttendeeId },
        data: { stripeAccountId: testStripeAcctId },
      });

      vi.spyOn(stripe.accounts, 'retrieve').mockResolvedValue({
        id: testStripeAcctId,
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
          pending_verification: [],
          disabled_reason: 'requirements.past_due',
        },
      } as any);

      const pubRes = await request(app)
        .post(`/api/organizer/events/${paidDraftEventId}/publish`)
        .set('Authorization', `Bearer ${verifiedAttendeeToken}`);

      expect(pubRes.status).toBe(400);
      expect(pubRes.body.error.code).toBe('STRIPE_ONBOARDING_INCOMPLETE');
      // Must explain human-readable requirements needed to complete onboarding
      expect(pubRes.body.error.message).toMatch(/government-issued photo ID/i);
      expect(pubRes.body.error.message).toMatch(/settlement bank account/i);
    });

    it('6c. Paid event publishing succeeds once Stripe Connect Express account has active transfers and completed onboarding', async () => {
      vi.spyOn(stripe.accounts, 'retrieve').mockResolvedValue({
        id: 'acct_incomplete_test_01',
        details_submitted: true,
        charges_enabled: true,
        payouts_enabled: true,
        capabilities: {
          card_payments: 'active',
          transfers: 'active',
        },
        requirements: {
          currently_due: [],
          eventually_due: [],
          past_due: [],
          pending_verification: [],
          disabled_reason: null,
        },
      } as any);

      const pubRes = await request(app)
        .post(`/api/organizer/events/${paidDraftEventId}/publish`)
        .set('Authorization', `Bearer ${verifiedAttendeeToken}`);

      expect(pubRes.status).toBe(200);
      expect(pubRes.body.success).toBe(true);
      expect(pubRes.body.data.event.status).toBe('PUBLISHED');
    });

    it('4b. Becoming an organizer does NOT remove ability to purchase tickets or manage attendee orders', async () => {
      vi.spyOn(stripe.paymentIntents, 'create').mockResolvedValue({
        id: `pi_org_attendee_${Date.now()}`,
        client_secret: 'pi_org_attendee_secret_456',
        status: 'requires_payment_method',
      } as any);

      const checkoutRes = await request(app)
        .post('/api/checkout/create-session')
        .set('Authorization', `Bearer ${verifiedAttendeeToken}`)
        .send({
          eventId: seededPublishedEventId,
          customerEmail: verifiedAttendeeEmail,
          customerName: 'Verified Event Creator',
          customerPhone: '+14155552672',
          marketingConsent: false,
          idempotencyKey: `idem_org_att_${Date.now()}`,
          items: [{ ticketTierId: seededActiveTierId, quantity: 1 }],
        });

      expect(checkoutRes.status).toBe(201);
      expect(checkoutRes.body.success).toBe(true);
      const orderNumber = checkoutRes.body.data.orderNumber;
      createdOrderNumbers.push(orderNumber);

      const orderRes = await request(app)
        .get(`/api/orders/${orderNumber}`)
        .set('Authorization', `Bearer ${verifiedAttendeeToken}`);
      expect(orderRes.status).toBe(200);
      expect(orderRes.body.data.order.orderNumber).toBe(orderNumber);
    });
  });

  // =========================================================================
  // 7 & 8. Existing organizers retain access & Guest checkout works without auth
  // =========================================================================
  describe('7 & 8. Existing Seeded Organizers & Guest Checkout Preservation', () => {
    it('7. Existing seeded organizer (sol@outside.vip) is verified and retains full event & organization management access', async () => {
      const loginRes = await request(app).post('/api/auth/login').send({
        email: 'sol@outside.vip',
        password: 'Outside2026!',
      });

      expect(loginRes.status).toBe(200);
      expect(loginRes.body.data.user.emailVerified).toBe(true);
      expect(loginRes.body.data.user.organizer).toBeTruthy();
      expect(loginRes.body.data.user.organizer.slug).toBe('sol-collective');

      const eventsRes = await request(app)
        .get('/api/organizer/events')
        .set('Authorization', `Bearer ${loginRes.body.data.token}`);
      expect(eventsRes.status).toBe(200);
      expect(eventsRes.body.data.events.length).toBeGreaterThanOrEqual(6);
    });

    it('8. Guest checkout remains functional without authentication and order is accessible via access token', async () => {
      vi.spyOn(stripe.paymentIntents, 'create').mockResolvedValue({
        id: `pi_guest_${Date.now()}`,
        client_secret: 'pi_guest_secret_789',
        status: 'requires_payment_method',
      } as any);

      const guestCheckoutRes = await request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: seededPublishedEventId,
          customerEmail: `guest_${Date.now()}@example.com`,
          customerName: 'Unauthenticated Guest Buyer',
          customerPhone: '+14155552679',
          marketingConsent: false,
          idempotencyKey: `idem_guest_${Date.now()}`,
          items: [{ ticketTierId: seededActiveTierId, quantity: 1 }],
        });

      expect(guestCheckoutRes.status).toBe(201);
      expect(guestCheckoutRes.body.success).toBe(true);
      const { orderNumber, orderAccessToken } = guestCheckoutRes.body.data;
      expect(orderAccessToken).toBeTruthy();
      createdOrderNumbers.push(orderNumber);

      // Guest can retrieve order using orderAccessToken without any Bearer header
      const guestOrderRes = await request(app).get(
        `/api/orders/${orderNumber}?token=${orderAccessToken}`
      );
      expect(guestOrderRes.status).toBe(200);
      expect(guestOrderRes.body.data.order.orderNumber).toBe(orderNumber);
    });
  });

  // =========================================================================
  // 9 & 10. Admin allowlist provisioning & privilege escalation prevention
  // =========================================================================
  describe('9 & 10. Admin Allowlist Provisioning & Security Controls', () => {
    it('9. Provisions ADMIN role only AFTER an allowlisted email address is verified (with email normalization and audit logging)', async () => {
      const allowlistedEmail = `allowlisted_admin_${Date.now()}@outside.vip`;
      process.env.ADMIN_EMAILS = `  other@example.com , ${allowlistedEmail.toUpperCase()} `;

      // Register: must NOT be ADMIN yet while unverified
      const regRes = await request(app).post('/api/auth/register').send({
        email: allowlistedEmail,
        password: 'OutsidePassword2026!',
        name: 'Allowlisted Admin Candidate',
      });
      expect(regRes.status).toBe(201);
      expect(regRes.body.data.user.role).toBe('ATTENDEE');
      expect(regRes.body.data.user.emailVerified).toBe(false);
      createdUserIds.push(regRes.body.data.user.id);

      // Login before verification: still must NOT be provisioned as ADMIN
      const unverifiedLoginRes = await request(app).post('/api/auth/login').send({
        email: allowlistedEmail,
        password: 'OutsidePassword2026!',
      });
      expect(unverifiedLoginRes.status).toBe(200);
      expect(unverifiedLoginRes.body.data.user.role).toBe('ATTENDEE');

      // Verify email via OTP: now automatically provisioned as ADMIN and audit-logged
      const otpCode = getLatestVerificationEmail(allowlistedEmail)!.code;
      const verifyRes = await request(app)
        .post('/api/auth/verify-email')
        .set('Authorization', `Bearer ${regRes.body.data.token}`)
        .send({ code: otpCode });

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.data.user.emailVerified).toBe(true);
      expect(verifyRes.body.data.user.role).toBe('ADMIN');

      expect(
        recordedAdminAuditLogs.some(
          (log) =>
            log.action === 'ADMIN_PROVISIONED_FROM_ALLOWLIST' &&
            log.actorEmail === allowlistedEmail
        )
      ).toBe(true);
    });

    it('10a. Prevents users from self-assigning ADMIN during registration or profile updates', async () => {
      const email = `hacker_${Date.now()}@outside.vip`;

      // Attempt to register with role: 'ADMIN'
      const regAdminAttempt = await request(app).post('/api/auth/register').send({
        email,
        password: 'OutsidePassword2026!',
        name: 'Self Admin Hacker',
        role: 'ADMIN',
      });
      expect(regAdminAttempt.status).toBe(403);

      // Register normally, then attempt to escalate role via PATCH /api/auth/profile
      const regNormal = await request(app).post('/api/auth/register').send({
        email,
        password: 'OutsidePassword2026!',
        name: 'Normal User',
      });
      expect(regNormal.status).toBe(201);
      const token = regNormal.body.data.token;
      createdUserIds.push(regNormal.body.data.user.id);

      const profileEscalateRes = await request(app)
        .patch('/api/auth/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'ADMIN', emailVerified: true });
      expect(profileEscalateRes.status).toBe(403);
    });

    it('10b. Prevents non-allowlisted verified users from becoming ADMIN and blocks admins from promoting other users', async () => {
      process.env.ADMIN_EMAILS = 'admin@outside.vip';

      const nonAllowlistedEmail = `regular_verified_${Date.now()}@outside.vip`;
      const regRes = await request(app).post('/api/auth/register').send({
        email: nonAllowlistedEmail,
        password: 'OutsidePassword2026!',
        name: 'Non Allowlisted User',
      });
      const userId = regRes.body.data.user.id;
      createdUserIds.push(userId);

      const otpCode = getLatestVerificationEmail(nonAllowlistedEmail)!.code;
      const verifyRes = await request(app)
        .post('/api/auth/verify-email')
        .set('Authorization', `Bearer ${regRes.body.data.token}`)
        .send({ code: otpCode });

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.data.user.role).toBe('ATTENDEE');

      // Log in as seeded admin and attempt to promote the user to ADMIN
      const adminLogin = await request(app).post('/api/auth/login').send({
        email: 'admin@outside.vip',
        password: 'Outside2026!',
      });
      expect(adminLogin.status).toBe(200);
      const adminToken = adminLogin.body.data.token;

      const promoteRes = await request(app)
        .patch(`/api/auth/users/${userId}/role`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ role: 'ADMIN' });
      expect(promoteRes.status).toBe(403);
      expect(
        recordedAdminAuditLogs.some((log) => log.action === 'BLOCKED_ROLE_PROMOTION_ATTEMPT')
      ).toBe(true);
    });
  });

  // =========================================================================
  // 11. Organization ownership and authorization remain enforced
  // =========================================================================
  describe('11. Organization Ownership & Event Authorization Enforcement', () => {
    it('prevents one verified organizer from editing, publishing, cancelling, or deleting another organizer’s event', async () => {
      // Create Organizer A and Organizer B (both verified)
      const emailA = `org_owner_a_${Date.now()}@outside.vip`;
      const regA = await request(app).post('/api/auth/register').send({
        email: emailA,
        password: 'OutsidePassword2026!',
        name: 'Organizer Owner A',
      });
      createdUserIds.push(regA.body.data.user.id);
      const verifyA = await request(app)
        .post('/api/auth/verify-email')
        .set('Authorization', `Bearer ${regA.body.data.token}`)
        .send({ code: getLatestVerificationEmail(emailA)!.code });
      const tokenA = verifyA.body.data.token;

      const emailB = `org_intruder_b_${Date.now()}@outside.vip`;
      const regB = await request(app).post('/api/auth/register').send({
        email: emailB,
        password: 'OutsidePassword2026!',
        name: 'Organizer Intruder B',
      });
      createdUserIds.push(regB.body.data.user.id);
      const verifyB = await request(app)
        .post('/api/auth/verify-email')
        .set('Authorization', `Bearer ${regB.body.data.token}`)
        .send({ code: getLatestVerificationEmail(emailB)!.code });
      const tokenB = verifyB.body.data.token;

      // Organizer A creates a draft event
      const createRes = await request(app)
        .post('/api/organizer/events')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          title: 'Organizer A Exclusive Event',
          status: 'DRAFT',
          coverImageUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819',
          venueName: 'Private Loft',
          city: 'New York',
          startAt: new Date(Date.now() + 86400000 * 6).toISOString(),
          endAt: new Date(Date.now() + 86400000 * 6 + 14400000).toISOString(),
          ticketTiers: [
            {
              name: 'Free Entry',
              priceInCents: 0,
              totalCapacity: 50,
              status: 'ACTIVE',
            },
          ],
        });
      expect(createRes.status).toBe(201);
      const eventAId = createRes.body.data.event.id;
      createdEventIds.push(eventAId);

      // Organizer B cannot edit, publish, cancel, or delete Organizer A's event
      const editAttempt = await request(app)
        .put(`/api/organizer/events/${eventAId}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ title: 'Hijacked Title' });
      expect(editAttempt.status).toBe(403);

      const publishAttempt = await request(app)
        .post(`/api/organizer/events/${eventAId}/publish`)
        .set('Authorization', `Bearer ${tokenB}`);
      expect(publishAttempt.status).toBe(403);

      const cancelAttempt = await request(app)
        .post(`/api/organizer/events/${eventAId}/cancel`)
        .set('Authorization', `Bearer ${tokenB}`);
      expect(cancelAttempt.status).toBe(403);

      const deleteAttempt = await request(app)
        .delete(`/api/organizer/events/${eventAId}`)
        .set('Authorization', `Bearer ${tokenB}`);
      expect(deleteAttempt.status).toBe(403);
    });
  });

  // =========================================================================
  // 12. Demo authentication cannot be accessed via direct API requests
  // =========================================================================
  describe('12. Demo Authentication Prevention & Production Hardening', () => {
    it('rejects direct requests to demo authentication routes (/api/auth/demo, /api/auth/demo-login, /api/auth/quick-login)', async () => {
      for (const route of ['/api/auth/demo', '/api/auth/demo-login', '/api/auth/quick-login']) {
        const res = await request(app).post(route).send({ role: 'organizer' });
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('DEMO_AUTH_DISABLED');
      }
    });

    it('rejects POST /api/auth/login payloads containing demo shortcut parameters or headers', async () => {
      const payloadRes = await request(app).post('/api/auth/login').send({
        email: 'sol@outside.vip',
        password: 'Outside2026!',
        demoRole: 'organizer',
      });
      expect(payloadRes.status).toBe(403);
      expect(payloadRes.body.error.code).toBe('DEMO_AUTH_DISABLED');

      const headerRes = await request(app)
        .post('/api/auth/login')
        .set('x-demo-auth', 'true')
        .send({
          email: 'sol@outside.vip',
          password: 'Outside2026!',
        });
      expect(headerRes.status).toBe(403);
      expect(headerRes.body.error.code).toBe('DEMO_AUTH_DISABLED');
    });

    it('blocks exposed demo credential logins in production mode while preserving seeded database records', async () => {
      const previousNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        for (const demoEmail of ['sol@outside.vip', 'alex@outside.vip', 'admin@outside.vip']) {
          const prodRes = await request(app).post('/api/auth/login').send({
            email: demoEmail,
            password: 'Outside2026!',
          });
          expect(prodRes.status).toBe(403);
          expect(prodRes.body.error.code).toBe('DEMO_AUTH_DISABLED');
        }
      } finally {
        process.env.NODE_ENV = previousNodeEnv;
      }

      // Verify seeded users and organizer profile remain intact in database
      const solUser = await prisma.user.findUnique({
        where: { email: 'sol@outside.vip' },
        include: { organizer: true },
      });
      expect(solUser).not.toBeNull();
      expect(solUser!.organizer).not.toBeNull();
    });
  });
});
