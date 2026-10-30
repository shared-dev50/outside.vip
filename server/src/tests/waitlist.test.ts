import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { prisma } from '../db/prisma.js';
import {
  joinWaitlist,
  processWaitlistForTier,
  lookupWaitlistOffer,
  declineWaitlistOffer,
  sweepExpiredOffers,
  cancelWaitlistForEventIds,
  generateOfferToken,
  hashOfferToken,
} from '../modules/waitlist/waitlist.service.js';
import {
  sentWaitlistEmails,
  resetSentWaitlistEmails,
} from '../modules/waitlist/waitlistEmail.service.js';
import { runWaitlistMaintenancePass } from '../modules/waitlist/waitlistWorker.js';
import { processStripeWebhookEvent } from '../modules/webhooks/webhook.service.js';
import { EventStatus, WaitlistEntryStatus, WaitlistOfferStatus } from '@prisma/client';

describe('Automatic Ticket Waitlist System', () => {
  let organizerToken: string;
  let attendeeToken: string;
  let organizerUserId: string;

  let testEventId: string;
  let testEventSlug: string;
  let soldOutTierId: string;
  let waitlistDisabledTierId: string;

  let recurringSeriesId: string;
  let occurrenceAId: string;
  let occurrenceBId: string;
  let occurrenceASlug: string;
  let occurrenceBSlug: string;
  let occurrenceATierId: string;
  let occurrenceBTierId: string;

  beforeAll(async () => {
    resetSentWaitlistEmails();

        const orgLogin = await request(app).post('/api/auth/login').send({
      email: 'sol@outside.vip',
      password: 'Outside2026!',
    });
    expect(orgLogin.status).toBe(200);
    organizerToken = orgLogin.body.data.token;
    organizerUserId = orgLogin.body.data.user.id;

        const attLogin = await request(app).post('/api/auth/login').send({
      email: 'alex@outside.vip',
      password: 'Outside2026!',
    });
    expect(attLogin.status).toBe(200);
    attendeeToken = attLogin.body.data.token;

    // Create a test event with a sold-out tier with waitlist enabled and another with waitlist disabled
    const eventRes = await request(app)
      .post('/api/organizer/events')
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({
        title: 'Waitlist Testing Gala 2026',
        tagline: 'High concurrency queue test',
        description: 'Test event for Outside.vip automated waitlist flow',
        category: 'MUSIC',
        coverImageUrl: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?auto=format&fit=crop&w=1600&q=85',
        city: 'Nairobi',
        venueName: 'Alchemist Bar',
        startAt: new Date(Date.now() + 86400000 * 7).toISOString(),
        endAt: new Date(Date.now() + 86400000 * 7 + 14400000).toISOString(),
        timezone: 'Africa/Nairobi',
        ticketTiers: [
          {
            name: 'Sold Out VIP',
            description: 'Exclusive tier that starts sold out',
            priceInCents: 5000,
            currency: 'USD',
            totalCapacity: 5,
            minPerOrder: 1,
            maxPerOrder: 4,
            status: 'ACTIVE',
            waitlistEnabled: true,
          },
          {
            name: 'No Waitlist Tier',
            description: 'Tier with waitlist disabled',
            priceInCents: 2500,
            currency: 'USD',
            totalCapacity: 5,
            minPerOrder: 1,
            maxPerOrder: 4,
            status: 'ACTIVE',
            waitlistEnabled: false,
          },
        ],
      });

    expect(eventRes.status).toBe(201);
    testEventId = eventRes.body.data.event.id;
    testEventSlug = eventRes.body.data.event.slug;

    const tiers = eventRes.body.data.event.ticketTiers;
    const vip = tiers.find((t: any) => t.name === 'Sold Out VIP');
    const noWaitlist = tiers.find((t: any) => t.name === 'No Waitlist Tier');

    soldOutTierId = vip.id;
    waitlistDisabledTierId = noWaitlist.id;

    // Mark soldOutTier as actually sold out by setting soldQuantity = totalCapacity
    await prisma.ticketTier.update({
      where: { id: soldOutTierId },
      data: { soldQuantity: 5 },
    });

        await request(app)
      .post(`/api/organizer/events/${testEventId}/publish`)
      .set('Authorization', `Bearer ${organizerToken}`);

    // Create a recurring event with 2 occurrences to test occurrence isolation
    const seriesRes = await request(app)
      .post('/api/organizer/events')
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({
        title: 'Recurring Sunset Sessions',
        tagline: 'Weekly weekend party',
        description: 'Recurring waitlist isolation test',
        category: 'NIGHTLIFE',
        coverImageUrl: 'https://images.unsplash.com/photo-1533174072545-7a4b6ad7a6c3?auto=format&fit=crop&w=1600&q=85',
        city: 'Nairobi',
        venueName: 'K1 Klub House',
        startAt: new Date(Date.now() + 86400000 * 14).toISOString(),
        endAt: new Date(Date.now() + 86400000 * 14 + 14400000).toISOString(),
        timezone: 'Africa/Nairobi',
        recurrence: {
          frequency: 'DAILY',
          interval: 1,
          count: 2,
        },
        ticketTiers: [
          {
            name: 'Daily Pass',
            priceInCents: 3000,
            currency: 'USD',
            totalCapacity: 2,
            minPerOrder: 1,
            maxPerOrder: 2,
            status: 'ACTIVE',
            waitlistEnabled: true,
          },
        ],
      });

    expect(seriesRes.status).toBe(201);
    recurringSeriesId = seriesRes.body.data.event.series.id;
    const occurrences = seriesRes.body.data.event.series.occurrences;
    occurrenceAId = occurrences[0].id;
    occurrenceBId = occurrences[1].id;
    occurrenceASlug = occurrences[0].slug;
    occurrenceBSlug = occurrences[1].slug;

    const occATiers = await prisma.ticketTier.findMany({ where: { eventId: occurrenceAId } });
    const occBTiers = await prisma.ticketTier.findMany({ where: { eventId: occurrenceBId } });
    occurrenceATierId = occATiers[0].id;
    occurrenceBTierId = occBTiers[0].id;

    // Mark both occurrence tiers as sold out
    await prisma.ticketTier.update({ where: { id: occurrenceATierId }, data: { soldQuantity: 2 } });
    await prisma.ticketTier.update({ where: { id: occurrenceBTierId }, data: { soldQuantity: 2 } });
  });

  afterAll(async () => {
    // Cleanup events, tiers, entries, offers, orders
    const allEventIds = [testEventId, occurrenceAId, occurrenceBId].filter(Boolean);
    for (const eid of allEventIds) {
      try {
        const orders = await prisma.order.findMany({ where: { eventId: eid }, select: { id: true } });
        const oids = orders.map((o) => o.id);
        if (oids.length > 0) {
          await prisma.ticket.deleteMany({ where: { orderId: { in: oids } } });
          await prisma.orderItem.deleteMany({ where: { orderId: { in: oids } } });
          await prisma.ticketReservation.deleteMany({ where: { orderId: { in: oids } } });
          await prisma.ticketWaitlistOffer.deleteMany({ where: { orderId: { in: oids } } });
          await prisma.order.deleteMany({ where: { id: { in: oids } } });
        }
        await prisma.ticketWaitlistOffer.deleteMany({ where: { ticketTier: { eventId: eid } } });
        await prisma.ticketWaitlistEntry.deleteMany({ where: { ticketTier: { eventId: eid } } });
        await prisma.ticketReservation.deleteMany({ where: { ticketTier: { eventId: eid } } });
        await prisma.ticketTier.deleteMany({ where: { eventId: eid } });
        await prisma.event.delete({ where: { id: eid } });
      } catch {
        // ignore
      }
    }
    if (recurringSeriesId) {
      try {
        await prisma.eventSeries.delete({ where: { id: recurringSeriesId } });
      } catch {
        // ignore
      }
    }
  });

    // Registration Validation & Duplicate Prevention
    describe('1. Registration Validation & Duplicate Prevention', () => {
    it('rejects waitlist join if tier does not have waitlist enabled', async () => {
      const res = await request(app)
        .post(`/api/events/${testEventSlug}/waitlist`)
        .send({
          ticketTierId: waitlistDisabledTierId,
          customerName: 'Sam Waiter',
          customerEmail: 'sam@outside.vip',
          quantity: 2,
        });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/Waitlist is not enabled/i);
    });

    it('rejects registration with invalid email or zero/negative quantity', async () => {
      const badEmail = await request(app)
        .post(`/api/events/${testEventSlug}/waitlist`)
        .send({
          ticketTierId: soldOutTierId,
          customerName: 'Bad Email',
          customerEmail: 'not-an-email',
          quantity: 1,
        });
      expect(badEmail.status).toBe(400);

      const badQty = await request(app)
        .post(`/api/events/${testEventSlug}/waitlist`)
        .send({
          ticketTierId: soldOutTierId,
          customerName: 'Zero Quantity',
          customerEmail: 'valid@outside.vip',
          quantity: 0,
        });
      expect(badQty.status).toBe(400);
    });

    it('rejects registration exceeding tier maxPerOrder limit', async () => {
      const res = await request(app)
        .post(`/api/events/${testEventSlug}/waitlist`)
        .send({
          ticketTierId: soldOutTierId,
          customerName: 'Greedy Buyer',
          customerEmail: 'greedy@outside.vip',
          quantity: 10, // maxPerOrder is 4
        });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/exceed.*maximum/i);
    });

    it('allows successful waitlist registration and returns queue position', async () => {
      const res = await request(app)
        .post(`/api/events/${testEventSlug}/waitlist`)
        .send({
          ticketTierId: soldOutTierId,
          customerName: 'First Attendee',
          customerEmail: 'first@outside.vip',
          customerPhone: '+254711111111',
          quantity: 2,
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.entry.customerEmail).toBe('first@outside.vip');
      expect(res.body.data.entry.quantity).toBe(2);
      expect(res.body.data.entry.status).toBe('WAITING');
      expect(res.body.data.entry.position).toBe(1);
    });

    it('prevents duplicate active registration for normalized email (case-insensitive & trimmed)', async () => {
      const duplicateRes = await request(app)
        .post(`/api/events/${testEventSlug}/waitlist`)
        .send({
          ticketTierId: soldOutTierId,
          customerName: 'First Attendee Again',
          customerEmail: '  FIRST@OUTSIDE.VIP  ',
          quantity: 1,
        });

      expect(duplicateRes.status).toBe(409);
      expect(duplicateRes.body.error.message).toMatch(/already.*active.*waitlist/i);
    });

    it('allows the same customer to register for a different ticket tier or occurrence', async () => {
      const diffOccurrenceRes = await request(app)
        .post(`/api/events/${occurrenceASlug}/waitlist`)
        .send({
          ticketTierId: occurrenceATierId,
          customerName: 'First Attendee',
          customerEmail: 'first@outside.vip',
          quantity: 1,
        });

      expect(diffOccurrenceRes.status).toBe(201);
      expect(diffOccurrenceRes.body.data.entry.customerEmail).toBe('first@outside.vip');
    });
  });

    // FIFO Queue Policy & Head-of-Line Fair Queue
    describe('2. FIFO Queue Policy & Head-of-Line Fair Queue', () => {
    it('maintains strict FIFO order and queues subsequent registrations', async () => {
      // Second customer: needs 1 ticket
      const reg2 = await request(app)
        .post(`/api/events/${testEventSlug}/waitlist`)
        .send({
          ticketTierId: soldOutTierId,
          customerName: 'Second Attendee',
          customerEmail: 'second@outside.vip',
          quantity: 1,
        });
      expect(reg2.status).toBe(201);
      expect(reg2.body.data.entry.position).toBe(2);

      // Third customer: needs 2 tickets
      const reg3 = await request(app)
        .post(`/api/events/${testEventSlug}/waitlist`)
        .send({
          ticketTierId: soldOutTierId,
          customerName: 'Third Attendee',
          customerEmail: 'third@outside.vip',
          quantity: 2,
        });
      expect(reg3.status).toBe(201);
      expect(reg3.body.data.entry.position).toBe(3);
    });

    it('preserves head-of-line: holds 1 ticket until head-of-line customer (needs 2) can be satisfied', async () => {
      // Simulate 1 ticket becoming available (capacity increased from 5 to 6)
      await prisma.ticketTier.update({
        where: { id: soldOutTierId },
        data: { totalCapacity: 6 }, // 6 capacity - 5 sold = 1 available
      });

      // Process waitlist: Customer 1 needs 2 tickets, Customer 2 needs 1 ticket.
      // Fair queue policy holds inventory and does NOT skip Customer 1!
      const outcome = await processWaitlistForTier(soldOutTierId);
      expect(outcome.offersCreated).toBe(0);

      // Verify no offers were created and reservedQuantity is still 0
      const tier = await prisma.ticketTier.findUniqueOrThrow({ where: { id: soldOutTierId } });
      expect(tier.reservedQuantity).toBe(0);

      const entries = await prisma.ticketWaitlistEntry.findMany({
        where: { ticketTierId: soldOutTierId, status: 'WAITING' },
        orderBy: { createdAt: 'asc' },
      });
      expect(entries.length).toBe(3);
      expect(entries[0].customerEmail).toBe('first@outside.vip');
    });

    it('creates an offer once enough inventory is available for head-of-line customer', async () => {
      resetSentWaitlistEmails();

      // Now 1 more ticket becomes available (capacity 7 - 5 sold = 2 available)
      await prisma.ticketTier.update({
        where: { id: soldOutTierId },
        data: { totalCapacity: 7 },
      });

      const outcome = await processWaitlistForTier(soldOutTierId);
      expect(outcome.offersCreated).toBe(1);

      // Verify Customer 1 is OFFERED and tier reservedQuantity is atomically increased to 2
      const updatedTier = await prisma.ticketTier.findUniqueOrThrow({ where: { id: soldOutTierId } });
      expect(updatedTier.reservedQuantity).toBe(2);

      const customer1Entry = await prisma.ticketWaitlistEntry.findFirstOrThrow({
        where: { ticketTierId: soldOutTierId, customerEmail: 'first@outside.vip' },
      });
      expect(customer1Entry.status).toBe('OFFERED');

      // Verify branded notification email was triggered
      expect(sentWaitlistEmails.length).toBe(1);
      expect(sentWaitlistEmails[0].to).toBe('first@outside.vip');
      expect(sentWaitlistEmails[0].claimUrl).toContain('offerToken=wlot_');
      expect(sentWaitlistEmails[0].quantity).toBe(2);
    });
  });

    // Timed Offer Lifecycle, Expiry & Token Security
    describe('3. Timed Offer Lifecycle, Expiry & Token Security', () => {
    let offerToken: string;
    let customer2Token: string;

    it('stores bearer token hash in DB and retrieves sanitized offer details via raw token', async () => {
      const email = sentWaitlistEmails.find((e) => e.to === 'first@outside.vip')!;
      expect(email).toBeDefined();
      const match = email.claimUrl.match(/offerToken=(wlot_[A-Za-z0-9_-]+)/);
      expect(match).not.toBeNull();
      offerToken = match![1];

      // Verify DB stores hash, not raw token
      const expectedHash = hashOfferToken(offerToken);
      const dbOffer = await prisma.ticketWaitlistOffer.findUnique({
        where: { tokenHash: expectedHash },
      });
      expect(dbOffer).not.toBeNull();
      expect(dbOffer?.tokenHash).toBe(expectedHash);

      // Lookup via public endpoint
      const res = await request(app).get(`/api/waitlist/offers/${offerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.offer.quantity).toBe(2);
      expect(res.body.data.offer.tierName).toBe('Sold Out VIP');
      expect(res.body.data.offer.status).toBe('PENDING');
      // Must not expose other customers' private data
      expect(res.body.data.offer.customerEmail).toBe('first@outside.vip');
    });

    it('rejects invalid or forged bearer tokens', async () => {
      const res = await request(app).get('/api/waitlist/offers/wlot_fake_token_1234567890');
      expect(res.status).toBe(404);
      expect(res.body.error.message).toMatch(/Waitlist offer not found/i);
    });

    it('expires offer when time window elapses, releases reservation, and advances queue', async () => {
      resetSentWaitlistEmails();

      // Backdate offer expiry to simulate expiration
      const tokenHash = hashOfferToken(offerToken);
      await prisma.ticketWaitlistOffer.update({
        where: { tokenHash },
        data: { expiresAt: new Date(Date.now() - 60000) },
      });

      // Run background sweep / maintenance
      const maintenanceRes = await request(app).post('/api/waitlist/maintenance');
      expect(maintenanceRes.status).toBe(200);
      expect(maintenanceRes.body.data.sweptExpiredOffers).toBeGreaterThanOrEqual(1);

      // Verify first offer status is EXPIRED
      const expiredOffer = await prisma.ticketWaitlistOffer.findUniqueOrThrow({
        where: { tokenHash },
      });
      expect(expiredOffer.status).toBe('EXPIRED');

      const customer1Entry = await prisma.ticketWaitlistEntry.findFirstOrThrow({
        where: { ticketTierId: soldOutTierId, customerEmail: 'first@outside.vip' },
      });
      expect(customer1Entry.status).toBe('EXPIRED');

      // Verify queue advanced: Customer 2 (needs 1 ticket) now received an offer!
      const customer2Entry = await prisma.ticketWaitlistEntry.findFirstOrThrow({
        where: { ticketTierId: soldOutTierId, customerEmail: 'second@outside.vip' },
      });
      expect(customer2Entry.status).toBe('OFFERED');

      // Customer 2 received email
      const customer2Email = sentWaitlistEmails.find((e) => e.to === 'second@outside.vip')!;
      expect(customer2Email).toBeDefined();
      expect(customer2Email.quantity).toBe(1);
      customer2Token = customer2Email.claimUrl.match(/offerToken=(wlot_[A-Za-z0-9_-]+)/)![1];

      // Reserved quantity is now 1 (Customer 2's reservation)
      const tier = await prisma.ticketTier.findUniqueOrThrow({ where: { id: soldOutTierId } });
      expect(tier.reservedQuantity).toBe(1);
    });

    it('allows a customer to explicitly decline an offer, immediately advancing the queue', async () => {
      // Customer 2 declines offer
      const declineRes = await request(app).post(`/api/waitlist/offers/${customer2Token}/decline`);
      expect(declineRes.status).toBe(200);
      expect(declineRes.body.success).toBe(true);
      expect(declineRes.body.message).toMatch(/declined/i);

      // Customer 2 entry is DECLINED
      const customer2Entry = await prisma.ticketWaitlistEntry.findFirstOrThrow({
        where: { ticketTierId: soldOutTierId, customerEmail: 'second@outside.vip' },
      });
      expect(customer2Entry.status).toBe('DECLINED');

      // Now 2 tickets are available: Customer 3 needs 2 tickets! Customer 3 receives the offer!
      const customer3Entry = await prisma.ticketWaitlistEntry.findFirstOrThrow({
        where: { ticketTierId: soldOutTierId, customerEmail: 'third@outside.vip' },
      });
      expect(customer3Entry.status).toBe('OFFERED');

      const customer3Email = sentWaitlistEmails.find((e) => e.to === 'third@outside.vip')!;
      expect(customer3Email).toBeDefined();
      expect(customer3Email.quantity).toBe(2);
    });
  });

    // Checkout Integration & Stripe Webhook Fulfillment
    describe('4. Checkout Integration & Stripe Webhook Fulfillment', () => {
    let customer3Token: string;
    let createdOrderNumber: string;

    it('initiates checkout with offerToken, validating reservation without double-decrementing inventory', async () => {
      const email = sentWaitlistEmails.find((e) => e.to === 'third@outside.vip')!;
      expect(email).toBeDefined();
      const match = email.claimUrl.match(/offerToken=(wlot_[A-Za-z0-9_-]+)/);
      customer3Token = match![1];

      // Customer 3 initiates checkout session with offerToken
      const sessionRes = await request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: testEventId,
          items: [{ ticketTierId: soldOutTierId, quantity: 2 }],
          customerName: 'Third Attendee',
          customerEmail: 'third@outside.vip',
          customerPhone: '+254733333333',
          offerToken: customer3Token,
        });

      expect(sessionRes.status).toBe(201);
      expect(sessionRes.body.success).toBe(true);
      expect(sessionRes.body.data.orderNumber).toBeDefined();
      createdOrderNumber = sessionRes.body.data.orderNumber;

      // Verify the order was created and the offer linked
      const order = await prisma.order.findUniqueOrThrow({
        where: { orderNumber: createdOrderNumber },
        include: { waitlistOffers: true },
      });
      expect(order.status).toBe('PENDING');
      expect(order.waitlistOffers.length).toBeGreaterThan(0);
      expect(order.waitlistOffers[0]?.tokenHash).toBe(hashOfferToken(customer3Token));
    });

    it('rejects attempt to reuse an offer in a conflicting second checkout', async () => {
      const reuseRes = await request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: testEventId,
          items: [{ ticketTierId: soldOutTierId, quantity: 2 }],
          customerName: 'Impostor',
          customerEmail: 'impostor@outside.vip',
          offerToken: customer3Token,
        });

      // Email mismatch or already linked returns 400 or 409
      expect([400, 409]).toContain(reuseRes.status);
    });

    it('fulfills offer and marks entry PURCHASED upon successful Stripe payment', async () => {
      const order = await prisma.order.findUniqueOrThrow({
        where: { orderNumber: createdOrderNumber },
      });

      // Call webhook processor with Stripe payment_intent.succeeded
      const webhookRes = await processStripeWebhookEvent({
        id: `evt_test_${order.id}`,
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: order.paymentReference || `pi_test_${order.id}`,
            status: 'succeeded',
            amount: order.totalInCents,
            currency: order.currency.toLowerCase(),
            metadata: { orderId: order.id },
          } as any,
        },
      } as any);

      expect(webhookRes.handled).toBe(true);

      // Verify offer is ACCEPTED and entry is PURCHASED
      const entry = await prisma.ticketWaitlistEntry.findFirstOrThrow({
        where: { ticketTierId: soldOutTierId, customerEmail: 'third@outside.vip' },
      });
      expect(entry.status).toBe('PURCHASED');

      const offer = await prisma.ticketWaitlistOffer.findUniqueOrThrow({
        where: { tokenHash: hashOfferToken(customer3Token) },
      });
      expect(offer.status).toBe('ACCEPTED');
    });

    it('idempotently handles duplicate completion without error or duplicate tickets', async () => {
      const order = await prisma.order.findUniqueOrThrow({
        where: { orderNumber: createdOrderNumber },
      });

      // Deliver duplicate webhook event
      const duplicateWebhookRes = await processStripeWebhookEvent({
        id: `evt_test_${order.id}`,
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: order.paymentReference || `pi_test_${order.id}`,
            status: 'succeeded',
            amount: order.totalInCents,
            currency: order.currency.toLowerCase(),
            metadata: { orderId: order.id },
          } as any,
        },
      } as any);

      expect(duplicateWebhookRes.handled).toBe(true);
      expect(duplicateWebhookRes.duplicate).toBe(true);

      const offer = await prisma.ticketWaitlistOffer.findUniqueOrThrow({
        where: { tokenHash: hashOfferToken(customer3Token) },
      });
      expect(offer.status).toBe('ACCEPTED');
    });
  });

    // Recurring Events & Occurrence Isolation
    describe('5. Recurring Events & Occurrence Isolation', () => {
    it('keeps occurrence waitlists completely isolated from sibling occurrences', async () => {
      // Register for Occurrence B
      const regOccB = await request(app)
        .post(`/api/events/${occurrenceBSlug}/waitlist`)
        .send({
          ticketTierId: occurrenceBTierId,
          customerName: 'Sunday Goer',
          customerEmail: 'sunday@outside.vip',
          quantity: 1,
        });

      expect(regOccB.status).toBe(201);
      expect(regOccB.body.data.entry.ticketTierId).toBe(occurrenceBTierId);

      // Entries for Occurrence A and Occurrence B must be distinct
      const entriesA = await prisma.ticketWaitlistEntry.findMany({
        where: { ticketTierId: occurrenceATierId },
      });
      const entriesB = await prisma.ticketWaitlistEntry.findMany({
        where: { ticketTierId: occurrenceBTierId },
      });

      expect(entriesA.length).toBe(1);
      expect(entriesA[0].customerEmail).toBe('first@outside.vip');

      expect(entriesB.length).toBe(1);
      expect(entriesB[0].customerEmail).toBe('sunday@outside.vip');
    });

    it('cancelling one occurrence only cancels its own waitlist and preserves sibling occurrences', async () => {
      // Cancel Occurrence A
      const cancelRes = await request(app)
        .post(`/api/organizer/events/${occurrenceAId}/cancel`)
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(cancelRes.status).toBe(200);

      // Occurrence A waitlist entry is CANCELLED
      const entryA = await prisma.ticketWaitlistEntry.findFirstOrThrow({
        where: { ticketTierId: occurrenceATierId },
      });
      expect(entryA.status).toBe('CANCELLED');

      // Occurrence B waitlist entry is completely unaffected and still WAITING
      const entryB = await prisma.ticketWaitlistEntry.findFirstOrThrow({
        where: { ticketTierId: occurrenceBTierId },
      });
      expect(entryB.status).toBe('WAITING');
    });
  });

    // Organiser Management & Authorization
    describe('6. Organiser Management & Authorization', () => {
    it('returns waitlist summary and entries for authorized event organizer', async () => {
      const res = await request(app)
        .get(`/api/organizer/events/${testEventId}/waitlist`)
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.tierSummaries).toBeDefined();
      expect(res.body.data.entries).toBeDefined();

      const vipSummary = res.body.data.tierSummaries.find(
        (t: any) => t.tierId === soldOutTierId
      );
      expect(vipSummary).toBeDefined();
      expect(vipSummary.waitlistEnabled).toBe(true);
      expect(vipSummary.purchasedCount).toBe(1); // Customer 3
      expect(vipSummary.expiredCount).toBe(1);   // Customer 1
      expect(vipSummary.declinedCount).toBe(1);  // Customer 2
    });

    it('forbids unauthorized users from viewing event waitlist', async () => {
      const forbiddenRes = await request(app)
        .get(`/api/organizer/events/${testEventId}/waitlist`)
        .set('Authorization', `Bearer ${attendeeToken}`);

      expect(forbiddenRes.status).toBe(403);
    });

    it('includes waitlist counts in getOrganizerEventById', async () => {
      const res = await request(app)
        .get(`/api/organizer/events/${testEventId}`)
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      const tiers = res.body.data.event.ticketTiers;
      const vip = tiers.find((t: any) => t.id === soldOutTierId);
      expect(vip.waitlistEnabled).toBe(true);
      expect(vip.waitlistWaitingCount).toBeDefined();
      expect(vip.waitlistOfferedCount).toBeDefined();
    });

    it('safely handles disabling waitlist: preserves existing entries and forbids new registrations', async () => {
      // Organizer disables waitlist on soldOutTierId
      const updateRes = await request(app)
        .put(`/api/organizer/events/${testEventId}`)
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          ticketTiers: [
            {
              id: soldOutTierId,
              name: 'Sold Out VIP',
              priceInCents: 5000,
              currency: 'USD',
              totalCapacity: 7,
              minPerOrder: 1,
              maxPerOrder: 4,
              status: 'ACTIVE',
              waitlistEnabled: false, // Turned OFF
            },
            {
              id: waitlistDisabledTierId,
              name: 'No Waitlist Tier',
              priceInCents: 2500,
              currency: 'USD',
              totalCapacity: 5,
              minPerOrder: 1,
              maxPerOrder: 4,
              status: 'ACTIVE',
              waitlistEnabled: false,
            },
          ],
        });

      expect(updateRes.status).toBe(200);

      // Verify past entries are intact
      const existingEntries = await prisma.ticketWaitlistEntry.findMany({
        where: { ticketTierId: soldOutTierId },
      });
      expect(existingEntries.length).toBe(3);

      // Attempting to join now must fail
      const joinFail = await request(app)
        .post(`/api/events/${testEventSlug}/waitlist`)
        .send({
          ticketTierId: soldOutTierId,
          customerName: 'Latecomer',
          customerEmail: 'late@outside.vip',
          quantity: 1,
        });

      expect(joinFail.status).toBe(400);
      expect(joinFail.body.error.message).toMatch(/Waitlist is not enabled/i);
    });
  });

    // Advanced Concurrency, Active Checkout Protection & Maintenance Security
    describe('7. Advanced Concurrency, Active Checkout Protection & Maintenance Security', () => {
    let testTierId: string;
    let customerToken: string;
    let checkoutOrderNumber: string;

    beforeAll(async () => {
      // Create a fresh tier for Section 7 tests
      const tier = await prisma.ticketTier.create({
        data: {
          eventId: testEventId,
          name: `Section 7 Protected Pass ${Date.now()}`,
          priceInCents: 6000,
          currency: 'USD',
          totalCapacity: 2,
          reservedQuantity: 0,
          soldQuantity: 0,
          minPerOrder: 1,
          maxPerOrder: 2,
          status: 'ACTIVE',
          waitlistEnabled: true,
        },
      });
      testTierId = tier.id;
    });

    it('protects in-progress checkout: does not expire an offer when an active checkout order is pending even if offer window elapsed', async () => {
      // Join waitlist
      await request(app)
        .post(`/api/events/${testEventSlug}/waitlist`)
        .send({
          ticketTierId: testTierId,
          customerName: 'Active Buyer',
          customerEmail: 'activebuyer@outside.vip',
          quantity: 2,
        });

      // Generate offer
      await processWaitlistForTier(testTierId);
      const email = sentWaitlistEmails.find((e) => e.to === 'activebuyer@outside.vip')!;
      expect(email).toBeDefined();
      customerToken = email.claimUrl.match(/offerToken=(wlot_[A-Za-z0-9_-]+)/)![1];

      // Initiate checkout session
      const sessionRes = await request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: testEventId,
          items: [{ ticketTierId: testTierId, quantity: 2 }],
          customerName: 'Active Buyer',
          customerEmail: 'activebuyer@outside.vip',
          offerToken: customerToken,
        });

      expect(sessionRes.status).toBe(201);
      checkoutOrderNumber = sessionRes.body.data.orderNumber;

      // Simulate offer's 30-minute window passing while order reservation is still actively alive
      await prisma.ticketWaitlistOffer.update({
        where: { tokenHash: hashOfferToken(customerToken) },
        data: { expiresAt: new Date(Date.now() - 5 * 60 * 1000) },
      });

      // Run maintenance sweep
      const sweepRes = await runWaitlistMaintenancePass();
      expect(sweepRes.expiredOffers).toBe(0); // Protected by active checkout!

      // Verify offer is STILL PENDING and can be looked up
      const lookupRes = await request(app).get(`/api/waitlist/offers/${customerToken}`);
      expect(lookupRes.status).toBe(200);
      expect(lookupRes.body.data.valid).toBe(true);
      expect(lookupRes.body.data.expired).toBe(false);

      // Complete Stripe payment successfully
      const order = await prisma.order.findUniqueOrThrow({
        where: { orderNumber: checkoutOrderNumber },
      });

      const webhookRes = await processStripeWebhookEvent({
        id: `evt_sec7_${order.id}`,
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: order.paymentReference || `pi_sec7_${order.id}`,
            status: 'succeeded',
            amount: order.totalInCents,
            currency: order.currency.toLowerCase(),
            metadata: { orderId: order.id },
          } as any,
        },
      } as any);

      expect(webhookRes.handled).toBe(true);

      const fulfilledOffer = await prisma.ticketWaitlistOffer.findUniqueOrThrow({
        where: { tokenHash: hashOfferToken(customerToken) },
      });
      expect(fulfilledOffer.status).toBe('ACCEPTED');
    }, 15000);

    it('releases reservation holds and marks offers expired when checkout order expires, without double-decrementing', async () => {
      // Create another tier with capacity 1
      const tier = await prisma.ticketTier.create({
        data: {
          eventId: testEventId,
          name: `Section 7 Abandon Pass ${Date.now()}`,
          priceInCents: 4000,
          currency: 'USD',
          totalCapacity: 1,
          reservedQuantity: 0,
          soldQuantity: 0,
          minPerOrder: 1,
          maxPerOrder: 1,
          status: 'ACTIVE',
          waitlistEnabled: true,
        },
      });

      // Join waitlist
      await request(app)
        .post(`/api/events/${testEventSlug}/waitlist`)
        .send({
          ticketTierId: tier.id,
          customerName: 'Abandoner',
          customerEmail: 'abandon@outside.vip',
          quantity: 1,
        });

      await processWaitlistForTier(tier.id);
      const email = sentWaitlistEmails.find((e) => e.to === 'abandon@outside.vip')!;
      const token = email.claimUrl.match(/offerToken=(wlot_[A-Za-z0-9_-]+)/)![1];

      // Initiate checkout
      const sessionRes = await request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: testEventId,
          items: [{ ticketTierId: tier.id, quantity: 1 }],
          customerName: 'Abandoner',
          customerEmail: 'abandon@outside.vip',
          offerToken: token,
        });

      expect(sessionRes.status).toBe(201);
      const orderNum = sessionRes.body.data.orderNumber;

      // Both offer and order expire
      const past = new Date(Date.now() - 10 * 60 * 1000);
      await prisma.ticketWaitlistOffer.update({
        where: { tokenHash: hashOfferToken(token) },
        data: { expiresAt: past },
      });
      await prisma.order.update({
        where: { orderNumber: orderNum },
        data: { expiresAt: past },
      });
      await prisma.ticketReservation.updateMany({
        where: { order: { orderNumber: orderNum } },
        data: { expiresAt: past },
      });

      // Run maintenance pass
      const sweepRes = await runWaitlistMaintenancePass();
      expect(sweepRes.releasedReservations).toBe(1);

      // Verify tier reservedQuantity was decremented by EXACTLY 1 (not double-decremented to -1)
      const updatedTier = await prisma.ticketTier.findUniqueOrThrow({
        where: { id: tier.id },
      });
      expect(updatedTier.reservedQuantity).toBe(0);

      // Verify offer is EXPIRED
      const updatedOffer = await prisma.ticketWaitlistOffer.findUniqueOrThrow({
        where: { tokenHash: hashOfferToken(token) },
      });
      expect(updatedOffer.status).toBe('EXPIRED');
    });

    it('enforces authorization on /api/waitlist/maintenance when CRON_SECRET is configured', async () => {
      const secretKey = 'test_cron_secret_auth_789';
      process.env.CRON_SECRET = secretKey;

      try {
        // Without auth -> 401
        const unauthRes = await request(app).post('/api/waitlist/maintenance');
        expect(unauthRes.status).toBe(401);

        // With wrong secret -> 401
        const badAuthRes = await request(app)
          .post('/api/waitlist/maintenance')
          .set('Authorization', 'Bearer wrong_token');
        expect(badAuthRes.status).toBe(401);

        // With correct Bearer secret -> 200
        const goodBearerRes = await request(app)
          .post('/api/waitlist/maintenance')
          .set('Authorization', `Bearer ${secretKey}`);
        expect(goodBearerRes.status).toBe(200);

        // With correct custom header -> 200
        const goodHeaderRes = await request(app)
          .post('/api/waitlist/maintenance')
          .set('x-cron-secret', secretKey);
        expect(goodHeaderRes.status).toBe(200);
      } finally {
        delete process.env.CRON_SECRET;
      }
    });
  });
});
