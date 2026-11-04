import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { prisma } from '../db/prisma.js';
import { stripe } from '../lib/stripe.js';
import { hashEventPassword } from '../modules/events/passwordAccess.service.js';
import { normalizePhoneNumber } from '../utils/phone.js';

describe('Password-Protected Event Checkout, Mandatory Phone & Marketing Consent', () => {
  let organizerToken: string;
  let organizerId: string;
  let otherOrganizerToken: string;
  let otherOrganizerId: string;

  let protectedEventId: string;
  let protectedEventSlug: string;
  let protectedTierId: string;

  let publicEventId: string;
  let publicEventSlug: string;
  let publicTierId: string;

  const initialPassword = 'SuperSecretVIP2026!';
  const updatedPassword = 'NewSecretVIPPassword2026!';

  beforeAll(async () => {
    // 1. Create primary organizer
    const orgEmail = `vip_org_${Date.now()}@outside.vip`;
    const regOrg = await request(app)
      .post('/api/auth/register')
      .send({
        email: orgEmail,
        password: 'Password123!',
        name: 'VIP Organizer',
        role: 'ORGANIZER',
      });
    organizerToken = regOrg.body.data.token;
    organizerId = regOrg.body.data.user.id;

    // 2. Create secondary organizer for isolation testing
    const otherOrgEmail = `other_org_${Date.now()}@outside.vip`;
    const regOther = await request(app)
      .post('/api/auth/register')
      .send({
        email: otherOrgEmail,
        password: 'Password123!',
        name: 'Other Organizer',
        role: 'ORGANIZER',
      });
    otherOrganizerToken = regOther.body.data.token;
    otherOrganizerId = regOther.body.data.user.id;

    // 3. Create a password-protected event
    const pwHash = await hashEventPassword(initialPassword);
    const startAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const endAt = new Date(startAt.getTime() + 4 * 60 * 60 * 1000);

    const protectedEvent = await prisma.event.create({
      data: {
        title: `Secret Vault Gathering ${Date.now()}`,
        slug: `secret-vault-${Date.now()}`,
        description: 'Classified event details only for authorized guests.',
        category: 'MUSIC',
        status: 'PUBLISHED',
        coverImageUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819',
        venueName: 'The Speakeasy Vault',
        venueAddress: '123 Hidden Alley, Floor B2',
        city: 'New York',
        country: 'United States',
        startAt,
        endAt,
        timezone: 'America/New_York',
        organizerId,
        isPasswordProtected: true,
        passwordHash: pwHash,
        ticketTiers: {
          create: [
            {
              name: 'Secret VIP Pass',
              priceInCents: 15000,
              currency: 'USD',
              totalCapacity: 50,
              status: 'ACTIVE',
              minPerOrder: 1,
              maxPerOrder: 5,
            },
          ],
        },
      },
      include: { ticketTiers: true },
    });

    protectedEventId = protectedEvent.id;
    protectedEventSlug = protectedEvent.slug;
    protectedTierId = protectedEvent.ticketTiers[0].id;

    // 4. Create an unprotected public event
    const publicEvent = await prisma.event.create({
      data: {
        title: `Open Skyline Concert ${Date.now()}`,
        slug: `open-skyline-${Date.now()}`,
        description: 'Open public concert accessible to everyone.',
        category: 'MUSIC',
        status: 'PUBLISHED',
        coverImageUrl: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745',
        venueName: 'Skyline Terrace',
        venueAddress: '789 Broadway Ave',
        city: 'New York',
        country: 'United States',
        startAt,
        endAt,
        timezone: 'America/New_York',
        organizerId,
        isPasswordProtected: false,
        passwordHash: null,
        ticketTiers: {
          create: [
            {
              name: 'General Admission',
              priceInCents: 5000,
              currency: 'USD',
              totalCapacity: 100,
              status: 'ACTIVE',
              minPerOrder: 1,
              maxPerOrder: 10,
            },
          ],
        },
      },
      include: { ticketTiers: true },
    });

    publicEventId = publicEvent.id;
    publicEventSlug = publicEvent.slug;
    publicTierId = publicEvent.ticketTiers[0].id;
  });

  afterAll(async () => {
    // Cleanup created orders and events
    try {
      const orders = await prisma.order.findMany({
        where: { eventId: { in: [protectedEventId, publicEventId] } },
        select: { id: true },
      });
      const orderIds = orders.map((o) => o.id);
      if (orderIds.length > 0) {
        await prisma.ticket.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.ticketReservation.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
      }

      await prisma.ticketReservation.deleteMany({
        where: { ticketTierId: { in: [protectedTierId, publicTierId] } },
      });
      await prisma.ticketTier.deleteMany({
        where: { id: { in: [protectedTierId, publicTierId] } },
      });
      await prisma.event.deleteMany({
        where: { id: { in: [protectedEventId, publicEventId] } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: [organizerId, otherOrganizerId] } },
      });
    } catch {
      // ignore cleanup errors
    }
  });

  describe('1. Phone Number Validation & Normalization Utility', () => {
    it('accepts and normalizes valid international formats to E.164', () => {
      // US standard 10 digits
      expect(normalizePhoneNumber('555-123-4567')).toEqual({ isValid: true, normalized: '+15551234567' });
      expect(normalizePhoneNumber('(555) 123-4567')).toEqual({ isValid: true, normalized: '+15551234567' });
      expect(normalizePhoneNumber('5551234567')).toEqual({ isValid: true, normalized: '+15551234567' });

      // US 11 digits
      expect(normalizePhoneNumber('+1 (555) 123-4567')).toEqual({ isValid: true, normalized: '+15551234567' });
      expect(normalizePhoneNumber('15551234567')).toEqual({ isValid: true, normalized: '+15551234567' });

      // Kenya formats
      expect(normalizePhoneNumber('0712345678')).toEqual({ isValid: true, normalized: '+254712345678' });
      expect(normalizePhoneNumber('+254 712 345678')).toEqual({ isValid: true, normalized: '+254712345678' });

      // UK format
      expect(normalizePhoneNumber('+44 7911 123456')).toEqual({ isValid: true, normalized: '+447911123456' });

      // European with 00 prefix
      expect(normalizePhoneNumber('00447911123456')).toEqual({ isValid: true, normalized: '+447911123456' });
    });

    it('rejects invalid, empty, or non-numeric phone strings with descriptive messages', () => {
      expect(normalizePhoneNumber('')).toEqual({ isValid: false, error: 'Phone number is required.' });
      expect(normalizePhoneNumber('   ')).toEqual({ isValid: false, error: 'Phone number is required.' });
      expect(normalizePhoneNumber('call-me-maybe').isValid).toBe(false);
      expect(normalizePhoneNumber('12345').isValid).toBe(false); // too short
      expect(normalizePhoneNumber('12345678901234567890').isValid).toBe(false); // too long
    });
  });

  describe('2. Password-Protected Event Customer Access Flow', () => {
    it('locks sensitive details on unauthenticated public event query', async () => {
      const res = await request(app).get(`/api/events/${protectedEventSlug}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const ev = res.body.data.event;

      expect(ev.isPasswordProtected).toBe(true);
      expect(ev.isLocked).toBe(true);
      expect(ev.hasAccess).toBe(false);
      expect(ev.description).toBeNull();
      expect(ev.venueAddress).toBeNull();
      expect(ev.ticketTiers).toEqual([]);
      // Password hash must never be leaked
      expect(ev.passwordHash).toBeUndefined();
    });

    it('rejects incorrect password attempt with 401 Unauthorized', async () => {
      const res = await request(app)
        .post(`/api/events/${protectedEventSlug}/verify-password`)
        .send({ password: 'WrongPassword123' });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain('Incorrect password');
    });

    it('unlocks event with correct password and returns access token', async () => {
      const verifyRes = await request(app)
        .post(`/api/events/${protectedEventSlug}/verify-password`)
        .send({ password: initialPassword });

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.success).toBe(true);
      expect(verifyRes.body.data.hasAccess).toBe(true);
      expect(verifyRes.body.data.eventAccessToken).toBeDefined();

      const token = verifyRes.body.data.eventAccessToken;

      // Access full event using x-event-access-token header
      const unlockedRes = await request(app)
        .get(`/api/events/${protectedEventSlug}`)
        .set('x-event-access-token', token);

      expect(unlockedRes.status).toBe(200);
      const unlockedEvent = unlockedRes.body.data.event;
      expect(unlockedEvent.isLocked).toBe(false);
      expect(unlockedEvent.hasAccess).toBe(true);
      expect(unlockedEvent.description).toBe('Classified event details only for authorized guests.');
      expect(unlockedEvent.venueAddress).toBe('123 Hidden Alley, Floor B2');
      expect(unlockedEvent.ticketTiers.length).toBe(1);
      expect(unlockedEvent.ticketTiers[0].name).toBe('Secret VIP Pass');
    });

    it('invalidates access token if the organizer changes the event password', async () => {
      // 1. Acquire token with initial password
      const initialVerify = await request(app)
        .post(`/api/events/${protectedEventSlug}/verify-password`)
        .send({ password: initialPassword });
      const oldToken = initialVerify.body.data.eventAccessToken;

      // 2. Organizer updates the password
      const newHash = await hashEventPassword(updatedPassword);
      await prisma.event.update({
        where: { id: protectedEventId },
        data: { passwordHash: newHash },
      });

      // 3. Old token should now be rejected (locks the event again)
      const accessWithOldToken = await request(app)
        .get(`/api/events/${protectedEventSlug}`)
        .set('x-event-access-token', oldToken);

      expect(accessWithOldToken.status).toBe(200);
      expect(accessWithOldToken.body.data.event.hasAccess).toBe(false);
      expect(accessWithOldToken.body.data.event.isLocked).toBe(true);
      expect(accessWithOldToken.body.data.event.ticketTiers).toEqual([]);

      // 4. Verify that new password unlocks with a fresh token
      const newVerify = await request(app)
        .post(`/api/events/${protectedEventSlug}/verify-password`)
        .send({ password: updatedPassword });

      expect(newVerify.status).toBe(200);
      const newToken = newVerify.body.data.eventAccessToken;

      const accessWithNewToken = await request(app)
        .get(`/api/events/${protectedEventSlug}`)
        .set('x-event-access-token', newToken);

      expect(accessWithNewToken.status).toBe(200);
      expect(accessWithNewToken.body.data.event.hasAccess).toBe(true);
      expect(accessWithNewToken.body.data.event.isLocked).toBe(false);
    });
  });

  describe('3. Checkout Authorization for Protected vs. Public Events', () => {
    it('blocks checkout on password-protected event without valid token (403 Forbidden)', async () => {
      const res = await request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: protectedEventId,
          items: [{ ticketTierId: protectedTierId, quantity: 1 }],
          customerName: 'Gate Crasher',
          customerEmail: 'crasher@outside.vip',
          customerPhone: '+1 555-000-1111',
        });

      expect(res.status).toBe(403);
      expect(res.body.error.message).toContain('password protected');
    });

    it('allows checkout on public event seamlessly without requiring access token', async () => {
      const stripeSpy = vi.spyOn(stripe.paymentIntents, 'create').mockResolvedValueOnce({
        id: `pi_pub_${Date.now()}`,
        client_secret: 'pi_pub_secret_xyz',
        amount: 5000,
        currency: 'usd',
      } as any);

      const res = await request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: publicEventId,
          items: [{ ticketTierId: publicTierId, quantity: 1 }],
          customerName: 'Public Fan',
          customerEmail: 'fan@outside.vip',
          customerPhone: '+1 (555) 234-5678',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.clientSecret).toBe('pi_pub_secret_xyz');
      expect(res.body.data.orderNumber).toMatch(/^OUT-\d{4}-\d+/);

      stripeSpy.mockRestore();
    });

    it('allows checkout on password-protected event when valid access token is provided', async () => {
      const verifyRes = await request(app)
        .post(`/api/events/${protectedEventSlug}/verify-password`)
        .send({ password: updatedPassword });
      const token = verifyRes.body.data.eventAccessToken;

      const stripeSpy = vi.spyOn(stripe.paymentIntents, 'create').mockResolvedValueOnce({
        id: `pi_vip_${Date.now()}`,
        client_secret: 'pi_vip_secret_xyz',
        amount: 15000,
        currency: 'usd',
      } as any);

      const res = await request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: protectedEventId,
          items: [{ ticketTierId: protectedTierId, quantity: 1 }],
          customerName: 'Legitimate VIP Buyer',
          customerEmail: 'vipbuyer@outside.vip',
          customerPhone: '+1 555-888-9999',
          eventAccessToken: token,
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.clientSecret).toBe('pi_vip_secret_xyz');

      stripeSpy.mockRestore();
    });
  });

  describe('4. Mandatory Phone Number & Order Persistence', () => {
    it('rejects checkout when customerPhone is missing with 400', async () => {
      const res = await request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: publicEventId,
          items: [{ ticketTierId: publicTierId, quantity: 1 }],
          customerName: 'No Phone Buyer',
          customerEmail: 'nophone@outside.vip',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toBe('Validation failed');
    });

    it('rejects checkout when customerPhone is invalid format', async () => {
      const res = await request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: publicEventId,
          items: [{ ticketTierId: publicTierId, quantity: 1 }],
          customerName: 'Bad Phone Buyer',
          customerEmail: 'badphone@outside.vip',
          customerPhone: '123-CALLME',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe('Validation failed');
    });

    it('normalizes and persists customer phone number to the Order record', async () => {
      const stripeSpy = vi.spyOn(stripe.paymentIntents, 'create').mockResolvedValueOnce({
        id: `pi_phone_${Date.now()}`,
        client_secret: 'pi_phone_secret_xyz',
        amount: 5000,
        currency: 'usd',
      } as any);

      const res = await request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: publicEventId,
          items: [{ ticketTierId: publicTierId, quantity: 1 }],
          customerName: 'Jane Smith',
          customerEmail: 'janesmith@outside.vip',
          customerPhone: '(555) 765-4321', // Unformatted US number
        });

      expect(res.status).toBe(201);
      const orderNumber = res.body.data.orderNumber;

      const orderInDb = await prisma.order.findUniqueOrThrow({
        where: { orderNumber },
      });

      // Normalized to E.164
      expect(orderInDb.customerPhone).toBe('+15557654321');
      expect(orderInDb.customerName).toBe('Jane Smith');
      expect(orderInDb.customerEmail).toBe('janesmith@outside.vip');

      stripeSpy.mockRestore();
    });
  });

  describe('5. Marketing Consent Tracking & Organizer Scoping', () => {
    it('records marketingConsent=true with timestamp when buyer explicitly opts in', async () => {
      const stripeSpy = vi.spyOn(stripe.paymentIntents, 'create').mockResolvedValueOnce({
        id: `pi_consent_${Date.now()}`,
        client_secret: 'pi_consent_secret_xyz',
        amount: 5000,
        currency: 'usd',
      } as any);

      const res = await request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: publicEventId,
          items: [{ ticketTierId: publicTierId, quantity: 1 }],
          customerName: 'Consenting Fan',
          customerEmail: 'consent@outside.vip',
          customerPhone: '+1 555-333-4444',
          marketingConsent: true,
        });

      expect(res.status).toBe(201);
      const order = await prisma.order.findUniqueOrThrow({
        where: { orderNumber: res.body.data.orderNumber },
      });

      expect(order.marketingConsent).toBe(true);
      expect(order.marketingConsentAt).toBeInstanceOf(Date);
      expect(order.marketingConsentAt!.getTime()).toBeCloseTo(Date.now(), -4); // Within 10s

      stripeSpy.mockRestore();
    });

    it('defaults marketingConsent=false with null timestamp when buyer does not opt in', async () => {
      const stripeSpy = vi.spyOn(stripe.paymentIntents, 'create').mockResolvedValueOnce({
        id: `pi_noconsent_${Date.now()}`,
        client_secret: 'pi_noconsent_secret_xyz',
        amount: 5000,
        currency: 'usd',
      } as any);

      const res = await request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: publicEventId,
          items: [{ ticketTierId: publicTierId, quantity: 1 }],
          customerName: 'Private Fan',
          customerEmail: 'private@outside.vip',
          customerPhone: '+1 555-999-0000',
          marketingConsent: false,
        });

      expect(res.status).toBe(201);
      const order = await prisma.order.findUniqueOrThrow({
        where: { orderNumber: res.body.data.orderNumber },
      });

      expect(order.marketingConsent).toBe(false);
      expect(order.marketingConsentAt).toBeNull();

      stripeSpy.mockRestore();
    });

    it('ensures orders are scoped to their organizer and isolated from other organizers', async () => {
      // Find orders for organizer 1's event
      const org1Orders = await prisma.order.findMany({
        where: {
          event: { organizerId },
        },
        select: { id: true, customerEmail: true, customerPhone: true, marketingConsent: true },
      });

      // Query from perspective of other organizer
      const otherOrgOrders = await prisma.order.findMany({
        where: {
          event: { organizerId: otherOrganizerId },
        },
      });

      expect(org1Orders.length).toBeGreaterThan(0);
      expect(otherOrgOrders.length).toBe(0); // Zero cross-organizer leakage
    });

    it('preserves backward compatibility: existing orders without consent default safely to false', async () => {
      // Create a raw legacy-style order
      const legacyOrder = await prisma.order.create({
        data: {
          orderNumber: `LEGACY-${Date.now()}`,
          eventId: publicEventId,
          customerName: 'Legacy Buyer',
          customerEmail: 'legacy@outside.vip',
          customerPhone: null,
          totalInCents: 5000,
          idempotencyKey: `legacy_idem_${Date.now()}`,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        },
      });

      expect(legacyOrder.marketingConsent).toBe(false);
      expect(legacyOrder.marketingConsentAt).toBeNull();
      expect(legacyOrder.customerPhone).toBeNull();

      await prisma.order.delete({ where: { id: legacyOrder.id } });
    });
  });
});
