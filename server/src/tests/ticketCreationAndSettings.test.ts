import crypto from 'crypto';
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  AccountStatus,
  EventStatus,
  OrderStatus,
  Role,
  TicketStatus,
  TicketTierStatus,
  WaitlistEntryStatus,
  WaitlistOfferStatus,
} from '@prisma/client';
import { app } from '../app.js';
import { prisma } from '../db/prisma.js';
import { createSession } from '../lib/session.service.js';
import { stripe } from '../lib/stripe.js';
import * as financeService from '../modules/finance/finance.service.js';
import { hashOfferToken, processWaitlistForTier } from '../modules/waitlist/waitlist.service.js';
import {
  isTicketTierHidden,
  isTicketTierSalesDisabled,
  resolveTicketTierPersistenceState,
} from '../utils/ticketTierState.js';

describe('Ticket Creation & Additional Settings (Hide Ticket & Disable Ticket Sales) — Integration & Security Suite', () => {
  const runId = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const createdUserIds: string[] = [];
  const createdEventIds: string[] = [];

  let organizerUser: any;
  let organizerAuth: { cookie: string; csrf: string };
  let otherOrganizerUser: any;
  let otherOrganizerAuth: { cookie: string; csrf: string };

  async function issueSessionAuth(userId: string) {
    const session = await createSession({
      userId,
      ipAddress: '127.0.0.1',
      userAgent: 'TicketCreationSettingsVitest',
    });
    return {
      cookie: `__Host-outside_sid=${session.rawCookieValue}`,
      csrf: session.csrfToken,
    };
  }

  beforeAll(async () => {
    vi.spyOn(financeService, 'assertStripeReadyForPaidPublishing').mockResolvedValue({
      connected: true,
      detailsSubmitted: true,
      transferBalance: { enabled: true, message: 'Ready' },
      sellTickets: { enabled: true, message: 'Ready' },
      requirements: { disabledReason: null },
    } as any);

    organizerUser = await prisma.user.create({
      data: {
        email: `org-ticket-ctrl-${runId}@outside.vip`,
        passwordHash: 'dummy-hash-not-used-for-session',
        name: 'Ticket Controls Organizer',
        role: Role.ORGANIZER,
        status: AccountStatus.ACTIVE,
        emailVerified: true,
        emailVerifiedAt: new Date(),
        stripeAccountId: `acct_test_${runId}`,
      },
    });
    createdUserIds.push(organizerUser.id);
    organizerAuth = await issueSessionAuth(organizerUser.id);

    otherOrganizerUser = await prisma.user.create({
      data: {
        email: `other-org-ticket-ctrl-${runId}@outside.vip`,
        passwordHash: 'dummy-hash-not-used-for-session',
        name: 'Unauthorized Other Organizer',
        role: Role.ORGANIZER,
        status: AccountStatus.ACTIVE,
        emailVerified: true,
        emailVerifiedAt: new Date(),
      },
    });
    createdUserIds.push(otherOrganizerUser.id);
    otherOrganizerAuth = await issueSessionAuth(otherOrganizerUser.id);
  }, 30000);

  afterAll(async () => {
    if (createdEventIds.length > 0) {
      await prisma.checkInLog.deleteMany({ where: { eventId: { in: createdEventIds } } });
      await prisma.ticket.deleteMany({ where: { eventId: { in: createdEventIds } } });
      await prisma.ticketReservation.deleteMany({
        where: { ticketTier: { eventId: { in: createdEventIds } } },
      });
      await prisma.orderItem.deleteMany({
        where: { order: { eventId: { in: createdEventIds } } },
      });
      await prisma.order.deleteMany({ where: { eventId: { in: createdEventIds } } });
      await prisma.ticketWaitlistOffer.deleteMany({
        where: { eventId: { in: createdEventIds } },
      });
      await prisma.ticketWaitlistEntry.deleteMany({
        where: { eventId: { in: createdEventIds } },
      });
      await prisma.ticketTier.deleteMany({ where: { eventId: { in: createdEventIds } } });
      await prisma.event.deleteMany({ where: { id: { in: createdEventIds } } });
    }
    if (createdUserIds.length > 0) {
      await prisma.organizerProfile.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
  }, 30000);

  describe('1. State Resolution & Backward Compatibility Unit Checks', () => {
    it('treats legacy HIDDEN and PAUSED rows compatibly without requiring data mutation', () => {
      expect(isTicketTierHidden({ status: TicketTierStatus.HIDDEN, isHidden: false })).toBe(true);
      expect(isTicketTierHidden({ status: TicketTierStatus.ACTIVE, isHidden: true })).toBe(true);
      expect(isTicketTierHidden({ status: TicketTierStatus.ACTIVE, isHidden: false })).toBe(false);

      expect(
        isTicketTierSalesDisabled({ status: TicketTierStatus.PAUSED, salesDisabled: false })
      ).toBe(true);
      expect(
        isTicketTierSalesDisabled({ status: TicketTierStatus.ACTIVE, salesDisabled: true })
      ).toBe(true);
      expect(
        isTicketTierSalesDisabled({ status: TicketTierStatus.ACTIVE, salesDisabled: false })
      ).toBe(false);
    });

    it('preserves Hide ticket and Disable ticket sales independently', () => {
      const bothOn = resolveTicketTierPersistenceState({
        isHidden: true,
        salesDisabled: true,
      });
      expect(bothOn).toEqual({
        status: TicketTierStatus.HIDDEN,
        isHidden: true,
        salesDisabled: true,
      });

      const unhiddenStillDisabled = resolveTicketTierPersistenceState(
        { isHidden: false },
        bothOn
      );
      expect(unhiddenStillDisabled).toEqual({
        status: TicketTierStatus.PAUSED,
        isHidden: false,
        salesDisabled: true,
      });

      const reenabled = resolveTicketTierPersistenceState(
        { salesDisabled: false },
        unhiddenStillDisabled
      );
      expect(reenabled).toEqual({
        status: TicketTierStatus.ACTIVE,
        isHidden: false,
        salesDisabled: false,
      });
    });
  });

  describe('2. Empty Ticket Creation, Validation, & Independent Settings Persistence', () => {
    let draftEventId: string;
    let managedEventId: string;
    let managedEventSlug: string;
    let visibleActiveTierId: string;
    let hiddenTierId: string;
    let disabledSalesTierId: string;
    let bothHiddenAndDisabledTierId: string;

    it('allows creating a DRAFT event with an empty ticket list and rejects publishing with 0 tickets', async () => {
      const startAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
      const endAt = new Date(Date.now() + 7 * 24 * 3600 * 1000 + 4 * 3600 * 1000).toISOString();

      const createRes = await request(app)
        .post('/api/organizer/events')
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .send({
          title: `Zero Ticket Draft ${runId}`,
          description: 'Draft with no auto-created ticket templates',
          category: 'MUSIC',
          coverImageUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819',
          venueName: 'Studio A',
          venueAddress: '100 Main St',
          city: 'New York',
          country: 'United States',
          startAt,
          endAt,
          status: 'DRAFT',
          ticketTiers: [],
        });

      expect(createRes.status).toBe(201);
      expect(createRes.body.data.event.ticketTiers).toEqual([]);
      draftEventId = createRes.body.data.event.id;
      createdEventIds.push(draftEventId);

      // Attempting to publish with 0 tickets must fail cleanly
      const publishRes = await request(app)
        .post(`/api/organizer/events/${draftEventId}/publish`)
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .send({});

      expect(publishRes.status).toBe(400);
      expect(publishRes.body.success).toBe(false);
    });

    it('rejects tickets with blank/whitespace-only names or invalid capacities', async () => {
      const res = await request(app)
        .put(`/api/organizer/events/${draftEventId}`)
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .send({
          ticketTiers: [
            {
              name: '   ',
              priceInCents: 2000,
              totalCapacity: 50,
            },
          ],
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('rejects publishing an event when every configured ticket is hidden', async () => {
      const startAt = new Date(Date.now() + 8 * 24 * 3600 * 1000).toISOString();
      const endAt = new Date(Date.now() + 8 * 24 * 3600 * 1000 + 4 * 3600 * 1000).toISOString();

      const res = await request(app)
        .post('/api/organizer/events')
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .send({
          title: `All Hidden Event ${runId}`,
          description: 'Cannot publish with only hidden tickets',
          category: 'MUSIC',
          coverImageUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819',
          venueName: 'Studio B',
          venueAddress: '200 Main St',
          city: 'New York',
          country: 'United States',
          startAt,
          endAt,
          status: 'PUBLISHED',
          ticketTiers: [
            {
              name: 'Hidden Only Tier',
              priceInCents: 0,
              totalCapacity: 25,
              isHidden: true,
              salesDisabled: false,
            },
          ],
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('persists Hide ticket and Disable ticket sales independently across create, get, and update', async () => {
      const startAt = new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString();
      const endAt = new Date(Date.now() + 10 * 24 * 3600 * 1000 + 5 * 3600 * 1000).toISOString();

      const createRes = await request(app)
        .post('/api/organizer/events')
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .send({
          title: `Advanced Ticket Controls ${runId}`,
          description: 'Testing Hide ticket and Disable ticket sales end-to-end',
          category: 'MUSIC',
          coverImageUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819',
          venueName: 'Grand Hall',
          venueAddress: '300 Main St',
          city: 'Austin',
          country: 'United States',
          startAt,
          endAt,
          status: 'PUBLISHED',
          showOnExplore: true,
          ticketTiers: [
            {
              name: 'Public Regular Pass',
              description: 'Visible and purchasable',
              priceInCents: 4000,
              totalCapacity: 100,
              isHidden: false,
              salesDisabled: false,
              waitlistEnabled: true,
            },
            {
              name: 'Hidden Artist Pass',
              description: 'Must never appear publicly',
              priceInCents: 500, // Lower price than public tier to verify it never leaks into minPriceInCents
              totalCapacity: 20,
              isHidden: true,
              salesDisabled: false,
              waitlistEnabled: true,
            },
            {
              name: 'Sales Disabled VIP',
              description: 'Visible on page as unavailable',
              priceInCents: 8000,
              totalCapacity: 30,
              isHidden: false,
              salesDisabled: true,
              waitlistEnabled: true,
            },
            {
              name: 'Hidden And Disabled Tier',
              description: 'Both toggles enabled independently',
              priceInCents: 1000,
              totalCapacity: 15,
              isHidden: true,
              salesDisabled: true,
            },
          ],
        });

      expect(createRes.status).toBe(201);
      const evt = createRes.body.data.event;
      managedEventId = evt.id;
      managedEventSlug = evt.slug;
      createdEventIds.push(managedEventId);

      // Fetch via organizer edit endpoint to verify persistence
      const getOrgRes = await request(app)
        .get(`/api/organizer/events/${managedEventId}`)
        .set('Cookie', organizerAuth.cookie);

      expect(getOrgRes.status).toBe(200);
      const tiers = getOrgRes.body.data.event.ticketTiers;
      expect(tiers.length).toBe(4);

      const activeTier = tiers.find((t: any) => t.name === 'Public Regular Pass');
      const hiddenTier = tiers.find((t: any) => t.name === 'Hidden Artist Pass');
      const disabledTier = tiers.find((t: any) => t.name === 'Sales Disabled VIP');
      const bothTier = tiers.find((t: any) => t.name === 'Hidden And Disabled Tier');

      expect(activeTier).toMatchObject({ isHidden: false, salesDisabled: false, status: 'ACTIVE' });
      expect(hiddenTier).toMatchObject({ isHidden: true, salesDisabled: false, status: 'HIDDEN' });
      expect(disabledTier).toMatchObject({ isHidden: false, salesDisabled: true, status: 'PAUSED' });
      expect(bothTier).toMatchObject({ isHidden: true, salesDisabled: true, status: 'HIDDEN' });

      visibleActiveTierId = activeTier.id;
      hiddenTierId = hiddenTier.id;
      disabledSalesTierId = disabledTier.id;
      bothHiddenAndDisabledTierId = bothTier.id;

      // Verify editing: unhide `bothTier` while keeping `salesDisabled: true`
      const updateRes = await request(app)
        .put(`/api/organizer/events/${managedEventId}`)
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .send({
          ticketTiers: tiers.map((t: any) =>
            t.id === bothHiddenAndDisabledTierId
              ? {
                  id: t.id,
                  name: t.name,
                  description: t.description,
                  priceInCents: t.priceInCents,
                  totalCapacity: t.totalCapacity,
                  isHidden: false,
                  salesDisabled: true,
                }
              : {
                  id: t.id,
                  name: t.name,
                  description: t.description,
                  priceInCents: t.priceInCents,
                  totalCapacity: t.totalCapacity,
                  isHidden: t.isHidden,
                  salesDisabled: t.salesDisabled,
                  waitlistEnabled: t.waitlistEnabled,
                }
          ),
        });

      expect(updateRes.status).toBe(200);
      const updatedBoth = updateRes.body.data.event.ticketTiers.find(
        (t: any) => t.id === bothHiddenAndDisabledTierId
      );
      expect(updatedBoth).toMatchObject({
        isHidden: false,
        salesDisabled: true,
        status: 'PAUSED',
      });

      // Re-hide `bothTier` so public tests below verify both hidden tiers are excluded
      const rehideRes = await request(app)
        .put(`/api/organizer/events/${managedEventId}`)
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .send({
          ticketTiers: updateRes.body.data.event.ticketTiers.map((t: any) => ({
            id: t.id,
            name: t.name,
            description: t.description,
            priceInCents: t.priceInCents,
            totalCapacity: t.totalCapacity,
            isHidden: t.id === bothHiddenAndDisabledTierId ? true : t.isHidden,
            salesDisabled: t.salesDisabled,
            waitlistEnabled: t.waitlistEnabled,
          })),
        });
      expect(rehideRes.status).toBe(200);
    });

    it('excludes hidden tickets from public event detail and public discovery, and marks sales-disabled tickets unavailable', async () => {
      // 1. Public event detail
      const detailRes = await request(app).get(`/api/events/${managedEventSlug}`);
      expect(detailRes.status).toBe(200);
      const publicEvent = detailRes.body.data.event;
      const publicTierNames = publicEvent.ticketTiers.map((t: any) => t.name);

      expect(publicTierNames).toContain('Public Regular Pass');
      expect(publicTierNames).toContain('Sales Disabled VIP');
      expect(publicTierNames).not.toContain('Hidden Artist Pass');
      expect(publicTierNames).not.toContain('Hidden And Disabled Tier');

      // minPriceInCents must NOT reflect the cheaper hidden tiers ($5 / $10)
      expect(publicEvent.minPriceInCents).toBeGreaterThan(4000);

      const publicActive = publicEvent.ticketTiers.find((t: any) => t.id === visibleActiveTierId);
      const publicDisabled = publicEvent.ticketTiers.find((t: any) => t.id === disabledSalesTierId);
      expect(publicActive.isAvailable).toBe(true);
      expect(publicActive.salesDisabled).toBe(false);
      expect(publicDisabled.isAvailable).toBe(false);
      expect(publicDisabled.salesDisabled).toBe(true);

      // 2. Public event discovery listing
      const listRes = await request(app)
        .get('/api/events')
        .query({ search: `Advanced Ticket Controls ${runId}` });
      expect(listRes.status).toBe(200);
      const listed = listRes.body.data.events.find((e: any) => e.id === managedEventId);
      expect(listed).toBeDefined();
      const listedTierNames = listed.ticketTiers.map((t: any) => t.name);
      expect(listedTierNames).not.toContain('Hidden Artist Pass');
      expect(listedTierNames).not.toContain('Hidden And Disabled Tier');
      expect(listed.minPriceInCents).toBeGreaterThan(4000);
    });

    it('rejects direct checkout and waitlist requests for both hidden tickets and sales-disabled tickets', async () => {
      // Direct checkout for hidden ticket -> 400
      const hiddenCheckoutRes = await request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: managedEventId,
          customerEmail: 'buyer-hidden@example.com',
          customerName: 'Hidden Tester',
          customerPhone: '+15551234567',
          items: [{ ticketTierId: hiddenTierId, quantity: 1 }],
        });
      expect(hiddenCheckoutRes.status).toBe(400);
      expect(hiddenCheckoutRes.body.success).toBe(false);

      // Direct checkout for sales-disabled ticket -> 400
      const disabledCheckoutRes = await request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: managedEventId,
          customerEmail: 'buyer-disabled@example.com',
          customerName: 'Disabled Tester',
          customerPhone: '+15551234567',
          items: [{ ticketTierId: disabledSalesTierId, quantity: 1 }],
        });
      expect(disabledCheckoutRes.status).toBe(400);
      expect(disabledCheckoutRes.body.success).toBe(false);
      expect(disabledCheckoutRes.body.error.message).toContain('disabled');

      // Waitlist join for hidden ticket -> 404 (does not leak existence)
      const hiddenWaitlistRes = await request(app)
        .post(`/api/events/${managedEventSlug}/waitlist`)
        .send({
          ticketTierId: hiddenTierId,
          customerName: 'Waitlist Tester',
          customerEmail: 'wl-hidden@example.com',
          quantity: 1,
        });
      expect(hiddenWaitlistRes.status).toBe(404);

      // Waitlist join for sales-disabled ticket -> 400
      const disabledWaitlistRes = await request(app)
        .post(`/api/events/${managedEventSlug}/waitlist`)
        .send({
          ticketTierId: disabledSalesTierId,
          customerName: 'Waitlist Tester',
          customerEmail: 'wl-disabled@example.com',
          quantity: 1,
        });
      expect(disabledWaitlistRes.status).toBe(400);
    });

    it('does NOT invalidate or block gate scanning of existing issued tickets when ticket sales are disabled or hidden', async () => {
      const orderNumber = `OUT-2026-DS${Math.floor(10000 + Math.random() * 89999)}`;
      const ticketToken = `tkt_sec_${crypto.randomBytes(16).toString('hex')}`;

      const order = await prisma.order.create({
        data: {
          orderNumber,
          idempotencyKey: `idem_ds_${runId}_${Date.now()}`,
          eventId: managedEventId,
          customerEmail: 'valid-holder@example.com',
          customerName: 'Existing Ticket Holder',
          totalInCents: 8500,
          platformFeeInCents: 500,
          organizerNetInCents: 8000,
          currency: 'USD',
          status: OrderStatus.COMPLETED,
          expiresAt: new Date(Date.now() + 3600000),
        },
      });

      const issuedTicket = await prisma.ticket.create({
        data: {
          ticketToken,
          orderId: order.id,
          eventId: managedEventId,
          ticketTierId: disabledSalesTierId, // Sales disabled on this tier!
          attendeeName: 'Existing Ticket Holder',
          attendeeEmail: 'valid-holder@example.com',
          status: TicketStatus.ISSUED,
        },
      });

      const scanRes = await request(app)
        .post('/api/scanner/check-in')
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .send({
          token: issuedTicket.ticketToken,
          eventId: managedEventId,
        });

      expect(scanRes.status).toBe(200);
      expect(scanRes.body.success).toBe(true);
      expect(scanRes.body.data.result).toBe('SUCCESS');
    });

    it('enforces backend ownership/authorization checks when another user tries to toggle Hide/Disable settings', async () => {
      const res = await request(app)
        .put(`/api/organizer/events/${managedEventId}`)
        .set('Cookie', otherOrganizerAuth.cookie)
        .set('x-csrf-token', otherOrganizerAuth.csrf)
        .send({
          ticketTiers: [
            {
              id: visibleActiveTierId,
              name: 'Hijacked Tier',
              priceInCents: 100,
              totalCapacity: 100,
              isHidden: true,
              salesDisabled: true,
            },
          ],
        });

      expect(res.status).toBe(403);
    });
  });

  describe('3. Backward Compatibility with Legacy HIDDEN/PAUSED Database Records & Independent Validity/Sales Windows', () => {
    let legacyEvent: any;
    let legacyHiddenTier: any;
    let legacyPausedTier: any;
    let windowedTier: any;

    beforeAll(async () => {
      legacyEvent = await prisma.event.create({
        data: {
          organizerId: organizerUser.id,
          title: `Legacy Compat Event ${runId}`,
          slug: `legacy-compat-${runId}`,
          description: 'Simulates pre-migration TicketTier rows',
          category: 'MUSIC',
          status: EventStatus.PUBLISHED,
          showOnExplore: true,
          coverImageUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819',
          venueName: 'Legacy Hall',
          venueAddress: '1 Old St',
          city: 'Chicago',
          country: 'United States',
          startAt: new Date(Date.now() + 5 * 24 * 3600 * 1000),
          endAt: new Date(Date.now() + 5 * 24 * 3600 * 1000 + 5 * 3600 * 1000),
          timezone: 'America/Chicago',
        },
      });
      createdEventIds.push(legacyEvent.id);

      // Legacy rows: boolean flags stay false (migration default), legacy enum carries HIDDEN / PAUSED
      legacyHiddenTier = await prisma.ticketTier.create({
        data: {
          eventId: legacyEvent.id,
          name: 'Legacy Hidden Tier',
          priceInCents: 100,
          totalCapacity: 50,
          status: TicketTierStatus.HIDDEN,
          isHidden: false,
          salesDisabled: false,
        },
      });

      legacyPausedTier = await prisma.ticketTier.create({
        data: {
          eventId: legacyEvent.id,
          name: 'Legacy Paused Tier',
          priceInCents: 3000,
          totalCapacity: 50,
          status: TicketTierStatus.PAUSED,
          isHidden: false,
          salesDisabled: false,
        },
      });

      // Active tier with future salesStartAt and explicit validity window (independent of Hide/Disable)
      windowedTier = await prisma.ticketTier.create({
        data: {
          eventId: legacyEvent.id,
          name: 'Windowed Active Tier',
          priceInCents: 5000,
          totalCapacity: 100,
          status: TicketTierStatus.ACTIVE,
          isHidden: false,
          salesDisabled: false,
          salesStartAt: new Date(Date.now() + 24 * 3600 * 1000),
          salesEndAt: new Date(Date.now() + 48 * 3600 * 1000),
          validityStartAt: new Date(Date.now() + 5 * 24 * 3600 * 1000),
          validityEndAt: new Date(Date.now() + 5 * 24 * 3600 * 1000 + 2 * 3600 * 1000),
        },
      });
    });

    it('normalizes legacy HIDDEN and PAUSED rows in organizer GET API and enforces them in public API & checkout', async () => {
      const orgRes = await request(app)
        .get(`/api/organizer/events/${legacyEvent.id}`)
        .set('Cookie', organizerAuth.cookie);
      expect(orgRes.status).toBe(200);

      const orgHidden = orgRes.body.data.event.ticketTiers.find(
        (t: any) => t.id === legacyHiddenTier.id
      );
      const orgPaused = orgRes.body.data.event.ticketTiers.find(
        (t: any) => t.id === legacyPausedTier.id
      );
      expect(orgHidden.isHidden).toBe(true);
      expect(orgHidden.salesDisabled).toBe(false);
      expect(orgPaused.isHidden).toBe(false);
      expect(orgPaused.salesDisabled).toBe(true);

      // Public event page omits legacy HIDDEN tier and exposes legacy PAUSED as salesDisabled
      const pubRes = await request(app).get(`/api/events/${legacyEvent.slug}`);
      expect(pubRes.status).toBe(200);
      const pubTiers = pubRes.body.data.event.ticketTiers;
      expect(pubTiers.some((t: any) => t.id === legacyHiddenTier.id)).toBe(false);

      const pubPaused = pubTiers.find((t: any) => t.id === legacyPausedTier.id);
      expect(pubPaused).toBeDefined();
      expect(pubPaused.salesDisabled).toBe(true);
      expect(pubPaused.isAvailable).toBe(false);

      // Checkout rejects both legacy HIDDEN and legacy PAUSED tiers
      const checkoutLegacyPaused = await request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: legacyEvent.id,
          customerEmail: 'legacy@example.com',
          customerName: 'Legacy Buyer',
          customerPhone: '+15551234567',
          items: [{ ticketTierId: legacyPausedTier.id, quantity: 1 }],
        });
      expect(checkoutLegacyPaused.status).toBe(400);
      expect(checkoutLegacyPaused.body.error.message).toContain('disabled');

      // Windowed active tier still enforces salesStartAt independently
      const checkoutFutureWindow = await request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: legacyEvent.id,
          customerEmail: 'window@example.com',
          customerName: 'Window Buyer',
          customerPhone: '+15551234567',
          items: [{ ticketTierId: windowedTier.id, quantity: 1 }],
        });
      expect(checkoutFutureWindow.status).toBe(400);
      expect(checkoutFutureWindow.body.error.message).toContain('have not started yet');
    });
  });

  describe('4. TC-R01: Direct PUT Publish-Eligibility Invariant Enforcement', () => {
    it('rejects publishing via PUT with 0 tiers, only hidden tiers (flag or legacy), or 0 capacity, and blocks hiding/removing all tiers on a published event', async () => {
      const startAt = new Date(Date.now() + 14 * 24 * 3600 * 1000);
      const endAt = new Date(startAt.getTime() + 4 * 3600 * 1000);

      // 1. Draft with zero ticket tiers
      const zeroTierDraft = await prisma.event.create({
        data: {
          organizerId: organizerUser.id,
          title: `PUT Publish Zero Tier ${runId}`,
          slug: `put-pub-zero-${runId}`,
          description: 'Draft with no tiers',
          category: 'MUSIC',
          status: EventStatus.DRAFT,
          coverImageUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819',
          venueName: 'Hall 1',
          venueAddress: '10 Main St',
          city: 'New York',
          country: 'United States',
          startAt,
          endAt,
        },
      });
      createdEventIds.push(zeroTierDraft.id);

      const putZeroNoPayloadTiers = await request(app)
        .put(`/api/organizer/events/${zeroTierDraft.id}`)
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .send({ status: 'PUBLISHED' });
      expect(putZeroNoPayloadTiers.status).toBe(400);
      expect(putZeroNoPayloadTiers.body.error.message).toContain('At least one active ticket tier');

      const putZeroExplicitEmpty = await request(app)
        .put(`/api/organizer/events/${zeroTierDraft.id}`)
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .send({ status: 'PUBLISHED', ticketTiers: [] });
      expect(putZeroExplicitEmpty.status).toBe(400);

      // 2. Draft with only hidden ticket tiers (isHidden: true) and legacy HIDDEN status
      const putOnlyHidden = await request(app)
        .put(`/api/organizer/events/${zeroTierDraft.id}`)
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .send({
          status: 'PUBLISHED',
          ticketTiers: [
            { name: 'Secret Only', priceInCents: 0, totalCapacity: 20, isHidden: true },
          ],
        });
      expect(putOnlyHidden.status).toBe(400);

      const putLegacyHidden = await request(app)
        .put(`/api/organizer/events/${zeroTierDraft.id}`)
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .send({
          status: 'PUBLISHED',
          ticketTiers: [
            { name: 'Legacy Secret Only', priceInCents: 0, totalCapacity: 20, status: 'HIDDEN' },
          ],
        });
      expect(putLegacyHidden.status).toBe(400);

      // 3. Draft with a DB tier that has totalCapacity: 0 (no eligible tier with positive capacity)
      const zeroCapTier = await prisma.ticketTier.create({
        data: {
          eventId: zeroTierDraft.id,
          name: 'Zero Cap Tier',
          priceInCents: 0,
          totalCapacity: 0,
          status: TicketTierStatus.ACTIVE,
        },
      });
      const putZeroCapacityExisting = await request(app)
        .put(`/api/organizer/events/${zeroTierDraft.id}`)
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .send({ status: 'PUBLISHED' });
      expect(putZeroCapacityExisting.status).toBe(400);

      // 4. Positive case: publishing with at least one visible tier with positive capacity succeeds
      const putValidPublish = await request(app)
        .put(`/api/organizer/events/${zeroTierDraft.id}`)
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .send({
          status: 'PUBLISHED',
          ticketTiers: [
            {
              id: zeroCapTier.id,
              name: 'Public GA',
              priceInCents: 0,
              totalCapacity: 50,
              isHidden: false,
              salesDisabled: false,
            },
          ],
        });
      expect(putValidPublish.status).toBe(200);
      expect(putValidPublish.body.data.event.status).toBe('PUBLISHED');

      // 5. Already-published event cannot have all eligible tiers hidden or removed via PUT
      const hideAllOnPublished = await request(app)
        .put(`/api/organizer/events/${zeroTierDraft.id}`)
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .send({
          ticketTiers: [
            {
              id: zeroCapTier.id,
              name: 'Public GA',
              priceInCents: 0,
              totalCapacity: 50,
              isHidden: true,
              salesDisabled: false,
            },
          ],
        });
      expect(hideAllOnPublished.status).toBe(400);

      const removeAllOnPublished = await request(app)
        .put(`/api/organizer/events/${zeroTierDraft.id}`)
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .send({ ticketTiers: [] });
      expect(removeAllOnPublished.status).toBe(400);
    });
  });

  describe('5. TC-R02: Waitlist Offer Lookup Invalidation for Hidden, Sales-Disabled & Legacy Tiers', () => {
    let offerEvent: any;
    let activeOfferTier: any;
    let targetTier: any;
    let activeOfferToken: string;
    let targetOfferToken: string;

    beforeAll(async () => {
      const startAt = new Date(Date.now() + 16 * 24 * 3600 * 1000);
      const endAt = new Date(startAt.getTime() + 4 * 3600 * 1000);

      offerEvent = await prisma.event.create({
        data: {
          organizerId: organizerUser.id,
          title: `Waitlist Offer Visibility ${runId}`,
          slug: `wl-offer-vis-${runId}`,
          description: 'Testing waitlist offer lookup against hidden/disabled tiers',
          category: 'MUSIC',
          status: EventStatus.PUBLISHED,
          coverImageUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819',
          venueName: 'Queue Room',
          venueAddress: '20 Main St',
          city: 'Miami',
          country: 'United States',
          startAt,
          endAt,
        },
      });
      createdEventIds.push(offerEvent.id);

      activeOfferTier = await prisma.ticketTier.create({
        data: {
          eventId: offerEvent.id,
          name: 'Unrelated Active Tier',
          priceInCents: 3500,
          totalCapacity: 20,
          reservedQuantity: 1,
          status: TicketTierStatus.ACTIVE,
          waitlistEnabled: true,
        },
      });

      targetTier = await prisma.ticketTier.create({
        data: {
          eventId: offerEvent.id,
          name: 'Confidential Offer Tier',
          priceInCents: 6500,
          totalCapacity: 20,
          reservedQuantity: 1,
          status: TicketTierStatus.ACTIVE,
          waitlistEnabled: true,
        },
      });

      const createOfferForTier = async (tierId: string, email: string) => {
        const entry = await prisma.ticketWaitlistEntry.create({
          data: {
            eventId: offerEvent.id,
            ticketTierId: tierId,
            customerName: 'Queue Fan',
            customerEmail: email,
            quantity: 1,
            status: WaitlistEntryStatus.OFFERED,
          },
        });
        const rawToken = `wlot_test_${crypto.randomBytes(16).toString('hex')}`;
        await prisma.ticketWaitlistOffer.create({
          data: {
            entryId: entry.id,
            eventId: offerEvent.id,
            ticketTierId: tierId,
            quantity: 1,
            tokenHash: hashOfferToken(rawToken),
            status: WaitlistOfferStatus.PENDING,
            expiresAt: new Date(Date.now() + 20 * 60 * 1000),
          },
        });
        return rawToken;
      };

      activeOfferToken = await createOfferForTier(activeOfferTier.id, `active-wl-${runId}@example.com`);
      targetOfferToken = await createOfferForTier(targetTier.id, `target-wl-${runId}@example.com`);
    });

    it('keeps active offers valid, marks offers unavailable when hidden/disabled or legacy HIDDEN/PAUSED, hides metadata, and leaves unrelated offers valid', async () => {
      // 1. Active visible tier offer is valid
      const validRes = await request(app).get(`/api/waitlist/offers/${targetOfferToken}`);
      expect(validRes.status).toBe(200);
      expect(validRes.body.data.valid).toBe(true);
      expect(validRes.body.data.offer.tierName).toBe('Confidential Offer Tier');

      // 2. Hide tier (isHidden: true) -> offer becomes unavailable and does NOT leak hidden tier metadata
      await prisma.ticketTier.update({
        where: { id: targetTier.id },
        data: { isHidden: true, salesDisabled: false, status: TicketTierStatus.HIDDEN },
      });
      const hiddenRes = await request(app).get(`/api/waitlist/offers/${targetOfferToken}`);
      expect(hiddenRes.status).toBe(200);
      expect(hiddenRes.body.data.valid).toBe(false);
      expect(hiddenRes.body.data.expired).toBe(false);
      expect(hiddenRes.body.data.offer).toBeUndefined();
      expect(JSON.stringify(hiddenRes.body)).not.toContain('Confidential Offer Tier');

      // 3. Disable sales (salesDisabled: true, isHidden: false) -> offer becomes unavailable
      await prisma.ticketTier.update({
        where: { id: targetTier.id },
        data: { isHidden: false, salesDisabled: true, status: TicketTierStatus.PAUSED },
      });
      const disabledRes = await request(app).get(`/api/waitlist/offers/${targetOfferToken}`);
      expect(disabledRes.status).toBe(200);
      expect(disabledRes.body.data.valid).toBe(false);
      expect(disabledRes.body.data.offer).toBeUndefined();

      // 4. Legacy HIDDEN row (isHidden: false, status: HIDDEN) -> unavailable
      await prisma.ticketTier.update({
        where: { id: targetTier.id },
        data: { isHidden: false, salesDisabled: false, status: TicketTierStatus.HIDDEN },
      });
      const legacyHiddenRes = await request(app).get(`/api/waitlist/offers/${targetOfferToken}`);
      expect(legacyHiddenRes.status).toBe(200);
      expect(legacyHiddenRes.body.data.valid).toBe(false);
      expect(legacyHiddenRes.body.data.offer).toBeUndefined();

      // 5. Legacy PAUSED row (salesDisabled: false, status: PAUSED) -> unavailable
      await prisma.ticketTier.update({
        where: { id: targetTier.id },
        data: { isHidden: false, salesDisabled: false, status: TicketTierStatus.PAUSED },
      });
      const legacyPausedRes = await request(app).get(`/api/waitlist/offers/${targetOfferToken}`);
      expect(legacyPausedRes.status).toBe(200);
      expect(legacyPausedRes.body.data.valid).toBe(false);
      expect(legacyPausedRes.body.data.offer).toBeUndefined();

      // 6. Unrelated active tier's pending offer remains completely unaffected and valid
      const unrelatedRes = await request(app).get(`/api/waitlist/offers/${activeOfferToken}`);
      expect(unrelatedRes.status).toBe(200);
      expect(unrelatedRes.body.data.valid).toBe(true);
      expect(unrelatedRes.body.data.offer.tierName).toBe('Unrelated Active Tier');
    });
  });

  describe('6. TC-R04: SOLD_OUT Status Preservation Across Hide/Unhide & Capacity Increase', () => {
    it('returns a hidden sold-out tier to SOLD_OUT when made visible again without increasing capacity, and to ACTIVE when capacity increases', async () => {
      const startAt = new Date(Date.now() + 18 * 24 * 3600 * 1000);
      const endAt = new Date(startAt.getTime() + 4 * 3600 * 1000);

      const soldOutEvent = await prisma.event.create({
        data: {
          organizerId: organizerUser.id,
          title: `Sold Out Toggle Event ${runId}`,
          slug: `sold-out-toggle-${runId}`,
          description: 'Testing SOLD_OUT status preservation',
          category: 'MUSIC',
          status: EventStatus.PUBLISHED,
          coverImageUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819',
          venueName: 'Full House',
          venueAddress: '30 Main St',
          city: 'Seattle',
          country: 'United States',
          startAt,
          endAt,
        },
      });
      createdEventIds.push(soldOutEvent.id);

      const visibleFallback = await prisma.ticketTier.create({
        data: {
          eventId: soldOutEvent.id,
          name: 'Backup Visible Tier',
          priceInCents: 0,
          totalCapacity: 50,
          status: TicketTierStatus.ACTIVE,
        },
      });

      const soldOutTier = await prisma.ticketTier.create({
        data: {
          eventId: soldOutEvent.id,
          name: 'Sold Out Early Bird',
          priceInCents: 0,
          totalCapacity: 10,
          soldQuantity: 10,
          status: TicketTierStatus.SOLD_OUT,
        },
      });

      // Step 1: Hide the sold-out tier
      const hideRes = await request(app)
        .put(`/api/organizer/events/${soldOutEvent.id}`)
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .send({
          ticketTiers: [
            { id: visibleFallback.id, name: visibleFallback.name, priceInCents: 0, totalCapacity: 50, isHidden: false, salesDisabled: false },
            { id: soldOutTier.id, name: soldOutTier.name, priceInCents: 0, totalCapacity: 10, isHidden: true, salesDisabled: false },
          ],
        });
      expect(hideRes.status).toBe(200);
      const hiddenSaved = hideRes.body.data.event.ticketTiers.find((t: any) => t.id === soldOutTier.id);
      expect(hiddenSaved).toMatchObject({ status: 'HIDDEN', isHidden: true, salesDisabled: false });

      // Step 2: Unhide without increasing capacity -> returns to SOLD_OUT
      const unhideRes = await request(app)
        .put(`/api/organizer/events/${soldOutEvent.id}`)
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .send({
          ticketTiers: [
            { id: visibleFallback.id, name: visibleFallback.name, priceInCents: 0, totalCapacity: 50, isHidden: false, salesDisabled: false },
            { id: soldOutTier.id, name: soldOutTier.name, priceInCents: 0, totalCapacity: 10, isHidden: false, salesDisabled: false },
          ],
        });
      expect(unhideRes.status).toBe(200);
      const unhiddenSaved = unhideRes.body.data.event.ticketTiers.find((t: any) => t.id === soldOutTier.id);
      expect(unhiddenSaved).toMatchObject({ status: 'SOLD_OUT', isHidden: false, salesDisabled: false });

      // Step 3: Increase capacity above soldQuantity -> transitions to ACTIVE
      const expandRes = await request(app)
        .put(`/api/organizer/events/${soldOutEvent.id}`)
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .send({
          ticketTiers: [
            { id: visibleFallback.id, name: visibleFallback.name, priceInCents: 0, totalCapacity: 50, isHidden: false, salesDisabled: false },
            { id: soldOutTier.id, name: soldOutTier.name, priceInCents: 0, totalCapacity: 25, isHidden: false, salesDisabled: false },
          ],
        });
      expect(expandRes.status).toBe(200);
      const expandedSaved = expandRes.body.data.event.ticketTiers.find((t: any) => t.id === soldOutTier.id);
      expect(expandedSaved).toMatchObject({ status: 'ACTIVE', isHidden: false, salesDisabled: false });
    });
  });

  describe('7. TC-R03 & TC-R05: Concurrency, Existing Holds, Cross-Event Tier Injection, Featured Filtering & Waitlist Skip', () => {
    it('TC-R05.1 (Concurrency): blocks a concurrent checkout inside FOR UPDATE once a concurrent sales-disable transaction commits', async () => {
      const startAt = new Date(Date.now() + 20 * 24 * 3600 * 1000);
      const endAt = new Date(startAt.getTime() + 4 * 3600 * 1000);

      const raceEvent = await prisma.event.create({
        data: {
          organizerId: organizerUser.id,
          title: `Concurrency Lock Event ${runId}`,
          slug: `concurrency-lock-${runId}`,
          description: 'Testing PostgreSQL FOR UPDATE row lock serialization',
          category: 'MUSIC',
          status: EventStatus.PUBLISHED,
          coverImageUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819',
          venueName: 'Lock Arena',
          venueAddress: '40 Main St',
          city: 'Boston',
          country: 'United States',
          startAt,
          endAt,
        },
      });
      createdEventIds.push(raceEvent.id);

      const raceTier = await prisma.ticketTier.create({
        data: {
          eventId: raceEvent.id,
          name: 'Race Guarded Tier',
          priceInCents: 2500,
          totalCapacity: 50,
          status: TicketTierStatus.ACTIVE,
          isHidden: false,
          salesDisabled: false,
        },
      });

      // Deterministically exercise the exact TOCTOU window:
      // 1. Tx A acquires the row lock and marks salesDisabled = true (not yet committed, so pre-tx reads still see false).
      // 2. While Tx A holds the row lock, POST /api/checkout/create-session passes its pre-transaction check
      //    and blocks on SELECT ... FOR UPDATE.
      // 3. Tx A commits; checkout unblocks, re-reads locked row (salesDisabled = true), and rejects with 400.
      let releaseTxA!: () => void;
      const txAHoldingLock = new Promise<void>((resolve) => {
        releaseTxA = resolve;
      });
      let notifyLocked!: () => void;
      const lockedReady = new Promise<void>((resolve) => {
        notifyLocked = resolve;
      });

      const disableTxPromise = prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          UPDATE "TicketTier"
          SET "salesDisabled" = true, status = 'PAUSED'::"TicketTierStatus"
          WHERE id = ${raceTier.id}
        `;
        notifyLocked();
        await txAHoldingLock;
      });

      await lockedReady;

      const checkoutPromise = request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: raceEvent.id,
          customerEmail: `race-buyer-${runId}@example.com`,
          customerName: 'Race Buyer',
          customerPhone: '+15551234567',
          items: [{ ticketTierId: raceTier.id, quantity: 1 }],
        });

      // Allow checkout request time to pass pre-tx validation and block on PostgreSQL FOR UPDATE
      await new Promise((r) => setTimeout(r, 150));
      releaseTxA();

      const [, checkoutRes] = await Promise.all([disableTxPromise, checkoutPromise]);
      expect(checkoutRes.status).toBe(400);
      expect(checkoutRes.body.success).toBe(false);
      expect(checkoutRes.body.error.message).toContain('disabled');

      const refreshedTier = await prisma.ticketTier.findUnique({ where: { id: raceTier.id } });
      expect(refreshedTier?.reservedQuantity).toBe(0);
    });

    it('TC-R03 (Existing Holds): preserves unexpired checkout session replay created before disable while rejecting new reservations', async () => {
      const startAt = new Date(Date.now() + 21 * 24 * 3600 * 1000);
      const endAt = new Date(startAt.getTime() + 4 * 3600 * 1000);

      const holdEvent = await prisma.event.create({
        data: {
          organizerId: organizerUser.id,
          title: `Existing Hold Event ${runId}`,
          slug: `existing-hold-${runId}`,
          description: 'Testing TC-R03 existing hold preservation',
          category: 'MUSIC',
          status: EventStatus.PUBLISHED,
          coverImageUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819',
          venueName: 'Hold Hall',
          venueAddress: '45 Main St',
          city: 'Denver',
          country: 'United States',
          startAt,
          endAt,
        },
      });
      createdEventIds.push(holdEvent.id);

      const holdTier = await prisma.ticketTier.create({
        data: {
          eventId: holdEvent.id,
          name: 'Holdable Pass',
          priceInCents: 3000,
          totalCapacity: 50,
          status: TicketTierStatus.ACTIVE,
        },
      });

      const mockPiId = `pi_test_hold_${runId}`;
      const mockClientSecret = `${mockPiId}_secret_abc`;
      const createSpy = vi.spyOn(stripe.paymentIntents, 'create').mockResolvedValue({
        id: mockPiId,
        client_secret: mockClientSecret,
      } as any);
      const retrieveSpy = vi.spyOn(stripe.paymentIntents, 'retrieve').mockResolvedValue({
        id: mockPiId,
        client_secret: mockClientSecret,
      } as any);

      try {
        const existingIdemKey = `idem_hold_${runId}`;
        const initialRes = await request(app)
          .post('/api/checkout/create-session')
          .send({
            eventId: holdEvent.id,
            idempotencyKey: existingIdemKey,
            customerEmail: `hold-buyer-${runId}@example.com`,
            customerName: 'Hold Buyer',
            customerPhone: '+15551234567',
            items: [{ ticketTierId: holdTier.id, quantity: 1 }],
          });
        expect(initialRes.status).toBe(201);
        expect(initialRes.body.data.clientSecret).toBe(mockClientSecret);

        // Organizer disables ticket sales after the checkout session was already legitimately created
        await prisma.ticketTier.update({
          where: { id: holdTier.id },
          data: { salesDisabled: true, status: TicketTierStatus.PAUSED },
        });

        // Existing unexpired checkout hold still resolves its existing PaymentIntent cleanly
        const replayRes = await request(app)
          .post('/api/checkout/create-session')
          .send({
            eventId: holdEvent.id,
            idempotencyKey: existingIdemKey,
            customerEmail: `hold-buyer-${runId}@example.com`,
            customerName: 'Hold Buyer',
            customerPhone: '+15551234567',
            items: [{ ticketTierId: holdTier.id, quantity: 1 }],
          });
        expect(replayRes.status).toBe(201);
        expect(replayRes.body.data.clientSecret).toBe(mockClientSecret);
        expect(replayRes.body.data.orderNumber).toBe(initialRes.body.data.orderNumber);

        // Any NEW reservation after disable is strictly rejected with 400
        const newCheckoutRes = await request(app)
          .post('/api/checkout/create-session')
          .send({
            eventId: holdEvent.id,
            idempotencyKey: `idem_new_${runId}`,
            customerEmail: `second-buyer-${runId}@example.com`,
            customerName: 'Second Buyer',
            customerPhone: '+15551234567',
            items: [{ ticketTierId: holdTier.id, quantity: 1 }],
          });
        expect(newCheckoutRes.status).toBe(400);
        expect(newCheckoutRes.body.error.message).toContain('disabled');
      } finally {
        createSpy.mockRestore();
        retrieveSpy.mockRestore();
      }
    });

    it('TC-R05.2 (SEC-04 Cross-Event Tier ID Injection): rejects an authorized organizer passing another event’s ticketTier.id', async () => {
      const startAt = new Date(Date.now() + 22 * 24 * 3600 * 1000);
      const endAt = new Date(startAt.getTime() + 4 * 3600 * 1000);

      const eventA = await prisma.event.create({
        data: {
          organizerId: organizerUser.id,
          title: `Owner Event A ${runId}`,
          slug: `owner-evt-a-${runId}`,
          description: 'Event A owned by organizer',
          category: 'MUSIC',
          status: EventStatus.DRAFT,
          coverImageUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819',
          venueName: 'Hall A',
          venueAddress: '1 A St',
          city: 'New York',
          country: 'United States',
          startAt,
          endAt,
        },
      });
      createdEventIds.push(eventA.id);

      const eventB = await prisma.event.create({
        data: {
          organizerId: otherOrganizerUser.id,
          title: `Foreign Event B ${runId}`,
          slug: `foreign-evt-b-${runId}`,
          description: 'Event B owned by another organizer',
          category: 'MUSIC',
          status: EventStatus.DRAFT,
          coverImageUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819',
          venueName: 'Hall B',
          venueAddress: '2 B St',
          city: 'New York',
          country: 'United States',
          startAt,
          endAt,
        },
      });
      createdEventIds.push(eventB.id);

      const foreignTier = await prisma.ticketTier.create({
        data: {
          eventId: eventB.id,
          name: 'Untouched Foreign Tier',
          priceInCents: 5000,
          totalCapacity: 100,
          status: TicketTierStatus.ACTIVE,
          isHidden: false,
          salesDisabled: false,
        },
      });

      // Authorized owner of Event A attempts to pass Event B's ticketTier.id
      const res = await request(app)
        .put(`/api/organizer/events/${eventA.id}`)
        .set('Cookie', organizerAuth.cookie)
        .set('x-csrf-token', organizerAuth.csrf)
        .send({
          ticketTiers: [
            {
              id: foreignTier.id,
              name: 'Tampered Foreign Tier',
              priceInCents: 100,
              totalCapacity: 10,
              isHidden: true,
              salesDisabled: true,
            },
          ],
        });

      expect(res.status).toBe(403);
      expect(res.body.error.message).toContain('does not belong to this event');

      const foreignAfter = await prisma.ticketTier.findUnique({ where: { id: foreignTier.id } });
      expect(foreignAfter).toMatchObject({
        name: 'Untouched Foreign Tier',
        priceInCents: 5000,
        isHidden: false,
        salesDisabled: false,
        status: TicketTierStatus.ACTIVE,
      });
    });

    it('TC-R05.3 (Featured Events): GET /api/events/featured excludes hidden tiers and excludes their cheaper prices from minPriceInCents', async () => {
      // Earliest upcoming featured event so it is guaranteed within take: 4 ordered by startAt asc
      const startAt = new Date(Date.now() + 2 * 3600 * 1000);
      const endAt = new Date(startAt.getTime() + 4 * 3600 * 1000);

      const featuredEvent = await prisma.event.create({
        data: {
          organizerId: organizerUser.id,
          title: `Featured Hidden Guard ${runId}`,
          slug: `featured-hidden-${runId}`,
          description: 'Verifies featured endpoint omits hidden tiers',
          category: 'MUSIC',
          status: EventStatus.PUBLISHED,
          showOnExplore: true,
          isFeatured: true,
          coverImageUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819',
          venueName: 'Spotlight Venue',
          venueAddress: '99 Main St',
          city: 'Los Angeles',
          country: 'United States',
          startAt,
          endAt,
        },
      });
      createdEventIds.push(featuredEvent.id);

      await prisma.ticketTier.createMany({
        data: [
          {
            eventId: featuredEvent.id,
            name: 'Hidden Ultra Cheap',
            priceInCents: 100,
            totalCapacity: 20,
            status: TicketTierStatus.HIDDEN,
            isHidden: true,
            salesDisabled: false,
          },
          {
            eventId: featuredEvent.id,
            name: 'Legacy Hidden Cheap',
            priceInCents: 200,
            totalCapacity: 20,
            status: TicketTierStatus.HIDDEN,
            isHidden: false,
            salesDisabled: false,
          },
          {
            eventId: featuredEvent.id,
            name: 'Featured Public Tier',
            priceInCents: 6000,
            totalCapacity: 100,
            status: TicketTierStatus.ACTIVE,
            isHidden: false,
            salesDisabled: false,
          },
        ],
      });

      const res = await request(app).get('/api/events/featured');
      expect(res.status).toBe(200);
      const found = res.body.data.events.find((e: any) => e.id === featuredEvent.id);
      expect(found).toBeDefined();
      expect(found.ticketTiers.length).toBe(1);
      expect(found.minPriceInCents).toBeGreaterThan(6000);
    });

    it('TC-R05.4 (Waitlist Offer Skipping): processWaitlistForTier skips automatic offer generation when tier is hidden or sales-disabled', async () => {
      const startAt = new Date(Date.now() + 24 * 24 * 3600 * 1000);
      const endAt = new Date(startAt.getTime() + 4 * 3600 * 1000);

      const wlEvent = await prisma.event.create({
        data: {
          organizerId: organizerUser.id,
          title: `Waitlist Skip Event ${runId}`,
          slug: `wl-skip-${runId}`,
          description: 'Verifies processWaitlistForTier skips hidden/disabled tiers',
          category: 'MUSIC',
          status: EventStatus.PUBLISHED,
          coverImageUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819',
          venueName: 'Skip Hall',
          venueAddress: '55 Main St',
          city: 'Atlanta',
          country: 'United States',
          startAt,
          endAt,
        },
      });
      createdEventIds.push(wlEvent.id);

      const hiddenWlTier = await prisma.ticketTier.create({
        data: {
          eventId: wlEvent.id,
          name: 'Hidden Waitlist Tier',
          priceInCents: 2000,
          totalCapacity: 10,
          soldQuantity: 0,
          status: TicketTierStatus.HIDDEN,
          isHidden: true,
          salesDisabled: false,
          waitlistEnabled: true,
        },
      });

      const disabledWlTier = await prisma.ticketTier.create({
        data: {
          eventId: wlEvent.id,
          name: 'Disabled Waitlist Tier',
          priceInCents: 2000,
          totalCapacity: 10,
          soldQuantity: 0,
          status: TicketTierStatus.PAUSED,
          isHidden: false,
          salesDisabled: true,
          waitlistEnabled: true,
        },
      });

      await prisma.ticketWaitlistEntry.createMany({
        data: [
          {
            eventId: wlEvent.id,
            ticketTierId: hiddenWlTier.id,
            customerName: 'Waiting Fan 1',
            customerEmail: `wait-hidden-${runId}@example.com`,
            quantity: 1,
            status: WaitlistEntryStatus.WAITING,
          },
          {
            eventId: wlEvent.id,
            ticketTierId: disabledWlTier.id,
            customerName: 'Waiting Fan 2',
            customerEmail: `wait-disabled-${runId}@example.com`,
            quantity: 1,
            status: WaitlistEntryStatus.WAITING,
          },
        ],
      });

      const hiddenResult = await processWaitlistForTier(hiddenWlTier.id);
      expect(hiddenResult.offersCreated).toBe(0);

      const disabledResult = await processWaitlistForTier(disabledWlTier.id);
      expect(disabledResult.offersCreated).toBe(0);

      const offerCount = await prisma.ticketWaitlistOffer.count({
        where: { eventId: wlEvent.id },
      });
      expect(offerCount).toBe(0);
    });
  });
});

