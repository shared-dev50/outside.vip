import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { nanoid } from 'nanoid';
import {
  EmailOutboxType,
  EventStatus,
  OrderStatus,
  PaymentProvider,
  ReservationStatus,
  Role,
  TicketStatus,
  TicketTierStatus,
  WaitlistEntryStatus,
  WaitlistOfferStatus,
} from '@prisma/client';
import { app } from '../app.js';
import { prisma } from '../db/prisma.js';
import { stripe } from '../lib/stripe.js';
import {
  hashEventPassword,
  signEventAccessToken,
} from '../modules/events/passwordAccess.service.js';
import { hashOfferToken } from '../modules/waitlist/waitlist.service.js';
import * as emailOutboxService from '../modules/notifications/emailOutbox.service.js';
import { runEmailOutboxPass } from '../modules/notifications/emailOutbox.service.js';
import {
  resetSentOrderConfirmationEmails,
  sentOrderConfirmationEmails,
} from '../lib/email.service.js';
import { FREE_ORDER_BURST_MAX_ORDERS_PER_EMAIL } from '../modules/checkout/checkout.service.js';

describe('Stage 4 P0-01: Free-Ticket Checkout and Fulfillment — PostgreSQL Integration', () => {
  let organizerId: string;
  let publishedEventId: string;
  let freeTierAId: string;
  let freeTierBId: string;
  let paidTierId: string;
  let limitedFreeTierId: string;
  let restrictedFreeTierId: string;
  let passwordEventId: string;
  let passwordFreeTierId: string;
  let validPasswordToken: string;
  let waitlistEventId: string;
  let waitlistFreeTierId: string;

  const createdEventIds: string[] = [];
  const createdTierIds: string[] = [];

  beforeAll(async () => {
    const suffix = nanoid(8);
    const organizer = await prisma.user.create({
      data: {
        email: `p001_org_${suffix}@outside.vip`,
        name: 'P0-01 Test Organizer',
        role: Role.ORGANIZER,
        emailVerified: true,
        organizer: {
          create: {
            displayName: 'P0-01 Organizers Collective',
            slug: `p001-org-${suffix}`,
          },
        },
      },
    });
    organizerId = organizer.id;

    const now = Date.now();
    const event = await prisma.event.create({
      data: {
        slug: `p001-free-fest-${suffix}`,
        organizerId,
        title: 'P0-01 Community Sunset Sessions',
        description: 'Free community event integration baseline',
        status: EventStatus.PUBLISHED,
        coverImageUrl: 'https://example.com/p001-cover.jpg',
        venueName: 'Civic Lawn',
        venueAddress: '100 Commons Way',
        city: 'Austin',
        country: 'US',
        startAt: new Date(now + 24 * 3600 * 1000),
        endAt: new Date(now + 30 * 3600 * 1000),
        timezone: 'America/Chicago',
      },
    });
    publishedEventId = event.id;
    createdEventIds.push(publishedEventId);

    const [tierA, tierB, paidTier, limitedTier, restrictedTier] = await Promise.all([
      prisma.ticketTier.create({
        data: {
          eventId: publishedEventId,
          name: 'General Free RSVP',
          priceInCents: 0,
          currency: 'USD',
          totalCapacity: 200,
          reservedQuantity: 0,
          soldQuantity: 0,
          minPerOrder: 1,
          maxPerOrder: 5,
          status: TicketTierStatus.ACTIVE,
        },
      }),
      prisma.ticketTier.create({
        data: {
          eventId: publishedEventId,
          name: 'Early Entry Free Pass',
          priceInCents: 0,
          currency: 'USD',
          totalCapacity: 100,
          reservedQuantity: 0,
          soldQuantity: 0,
          minPerOrder: 1,
          maxPerOrder: 4,
          status: TicketTierStatus.ACTIVE,
        },
      }),
      prisma.ticketTier.create({
        data: {
          eventId: publishedEventId,
          name: 'VIP Lounge Upgrade',
          priceInCents: 2000,
          currency: 'USD',
          totalCapacity: 50,
          reservedQuantity: 0,
          soldQuantity: 0,
          minPerOrder: 1,
          maxPerOrder: 5,
          status: TicketTierStatus.ACTIVE,
        },
      }),
      prisma.ticketTier.create({
        data: {
          eventId: publishedEventId,
          name: 'Tiny Free Capacity',
          priceInCents: 0,
          currency: 'USD',
          totalCapacity: 2,
          reservedQuantity: 0,
          soldQuantity: 0,
          minPerOrder: 1,
          maxPerOrder: 1,
          status: TicketTierStatus.ACTIVE,
        },
      }),
      prisma.ticketTier.create({
        data: {
          eventId: publishedEventId,
          name: 'Restricted Free Tier',
          priceInCents: 0,
          currency: 'USD',
          totalCapacity: 20,
          reservedQuantity: 0,
          soldQuantity: 0,
          minPerOrder: 2,
          maxPerOrder: 3,
          status: TicketTierStatus.ACTIVE,
        },
      }),
    ]);

    freeTierAId = tierA.id;
    freeTierBId = tierB.id;
    paidTierId = paidTier.id;
    limitedFreeTierId = limitedTier.id;
    restrictedFreeTierId = restrictedTier.id;
    createdTierIds.push(freeTierAId, freeTierBId, paidTierId, limitedFreeTierId, restrictedFreeTierId);

    const passwordHash = await hashEventPassword('secret-rsvp-2026');
    const pwdEvent = await prisma.event.create({
      data: {
        slug: `p001-pwd-free-${suffix}`,
        organizerId,
        title: 'Secret Free Showcase',
        description: 'Password-protected free event',
        status: EventStatus.PUBLISHED,
        isPasswordProtected: true,
        passwordHash,
        coverImageUrl: 'https://example.com/p001-pwd.jpg',
        venueName: 'Studio B',
        venueAddress: '200 Secret Ln',
        city: 'Austin',
        country: 'US',
        startAt: new Date(now + 24 * 3600 * 1000),
        endAt: new Date(now + 30 * 3600 * 1000),
        timezone: 'America/Chicago',
      },
    });
    passwordEventId = pwdEvent.id;
    createdEventIds.push(passwordEventId);
    validPasswordToken = signEventAccessToken(passwordEventId, passwordHash);

    const pwdTier = await prisma.ticketTier.create({
      data: {
        eventId: passwordEventId,
        name: 'Invite Free Pass',
        priceInCents: 0,
        currency: 'USD',
        totalCapacity: 25,
        status: TicketTierStatus.ACTIVE,
      },
    });
    passwordFreeTierId = pwdTier.id;
    createdTierIds.push(passwordFreeTierId);

    const wlEvent = await prisma.event.create({
      data: {
        slug: `p001-wl-free-${suffix}`,
        organizerId,
        title: 'Waitlist Free Showcase',
        description: 'Waitlist-gated free tier',
        status: EventStatus.PUBLISHED,
        coverImageUrl: 'https://example.com/p001-wl.jpg',
        venueName: 'Annex Hall',
        venueAddress: '300 Hall St',
        city: 'Austin',
        country: 'US',
        startAt: new Date(now + 24 * 3600 * 1000),
        endAt: new Date(now + 30 * 3600 * 1000),
        timezone: 'America/Chicago',
      },
    });
    waitlistEventId = wlEvent.id;
    createdEventIds.push(waitlistEventId);

    const wlTier = await prisma.ticketTier.create({
      data: {
        eventId: waitlistEventId,
        name: 'Waitlist Free Tier',
        priceInCents: 0,
        currency: 'USD',
        totalCapacity: 3,
        reservedQuantity: 2,
        soldQuantity: 1,
        waitlistEnabled: true,
        minPerOrder: 1,
        maxPerOrder: 5,
        status: TicketTierStatus.ACTIVE,
      },
    });
    waitlistFreeTierId = wlTier.id;
    createdTierIds.push(waitlistFreeTierId);
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    resetSentOrderConfirmationEmails();
  });

  afterAll(async () => {
    const orders = await prisma.order.findMany({
      where: { eventId: { in: createdEventIds } },
      select: { id: true },
    });
    const orderIds = orders.map((o) => o.id);

    if (orderIds.length > 0) {
      await prisma.emailOutbox.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.paymentTransaction.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.financialLedgerEntry.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderRefund.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.ticketWaitlistOffer.deleteMany({ where: { eventId: { in: createdEventIds } } });
      await prisma.ticketWaitlistEntry.deleteMany({ where: { eventId: { in: createdEventIds } } });
      await prisma.ticket.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.ticketReservation.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    } else {
      await prisma.ticketWaitlistOffer.deleteMany({ where: { eventId: { in: createdEventIds } } });
      await prisma.ticketWaitlistEntry.deleteMany({ where: { eventId: { in: createdEventIds } } });
    }

    await prisma.ticketTier.deleteMany({ where: { eventId: { in: createdEventIds } } });
    await prisma.event.deleteMany({ where: { id: { in: createdEventIds } } });
    await prisma.organizerProfile.deleteMany({ where: { userId: organizerId } });
    await prisma.user.deleteMany({ where: { id: organizerId } });
  });

  it('1, 3, 4, 5, 12, 14: fulfills a free single-tier order atomically with PaymentProvider.FREE, issues tickets and outbox email without calling Stripe or creating ledger/payment rows', async () => {
    const piCreateSpy = vi.spyOn(stripe.paymentIntents, 'create');
    const piRetrieveSpy = vi.spyOn(stripe.paymentIntents, 'retrieve');

    const tierBefore = await prisma.ticketTier.findUnique({ where: { id: freeTierAId } });
    const email = `free_single_${nanoid(6)}@example.com`;

    const res = await request(app)
      .post('/api/checkout/create-session')
      .send({
        eventId: publishedEventId,
        items: [{ ticketTierId: freeTierAId, quantity: 2 }],
        customerEmail: email,
        customerName: 'Free Attendee',
        customerPhone: '+15551234567',
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe(OrderStatus.COMPLETED);
    expect(res.body.data.paymentProvider).toBe(PaymentProvider.FREE);
    expect(res.body.data.isFreeOrder).toBe(true);
    expect(res.body.data.clientSecret).toBeNull();
    expect(res.body.data.totalInCents).toBe(0);
    expect(res.body.data.orderAccessToken).toMatch(/^oat_/);
    expect(piCreateSpy).not.toHaveBeenCalled();

    const dbOrder = await prisma.order.findUnique({
      where: { orderNumber: res.body.data.orderNumber },
      include: {
        items: true,
        tickets: true,
        reservations: true,
        transactions: true,
        ledgerEntries: true,
        emailOutbox: true,
        refunds: true,
      },
    });

    expect(dbOrder).not.toBeNull();
    expect(dbOrder?.status).toBe(OrderStatus.COMPLETED);
    expect(dbOrder?.paymentProvider).toBe(PaymentProvider.FREE);
    expect(dbOrder?.paymentReference).toBeNull();
    expect(dbOrder?.stripeSettlementStatus).toBeNull();
    expect(dbOrder?.totalInCents).toBe(0);
    expect(dbOrder?.platformFeeInCents).toBe(0);
    expect(dbOrder?.organizerNetInCents).toBe(0);
    expect(dbOrder?.tickets.length).toBe(2);
    expect(dbOrder?.tickets.every((t) => t.status === TicketStatus.ISSUED && t.ticketToken.startsWith('tkt_sec_'))).toBe(true);
    expect(dbOrder?.reservations.length).toBe(0);
    expect(dbOrder?.transactions.length).toBe(0);
    expect(dbOrder?.ledgerEntries.length).toBe(0);
    expect(dbOrder?.refunds.length).toBe(0);
    expect(dbOrder?.emailOutbox.length).toBe(1);
    expect(dbOrder?.emailOutbox[0].type).toBe(EmailOutboxType.ORDER_CONFIRMATION);
    expect((dbOrder?.emailOutbox[0].contentSnapshot as any)?.totalInCents).toBe(0);

    const tierAfter = await prisma.ticketTier.findUnique({ where: { id: freeTierAId } });
    expect(tierAfter?.soldQuantity).toBe((tierBefore?.soldQuantity ?? 0) + 2);
    expect(tierAfter?.reservedQuantity).toBe(tierBefore?.reservedQuantity ?? 0);

    // Order confirmation endpoint works and never triggers Stripe retrieval
    const orderLookup = await request(app).get(
      `/api/orders/${dbOrder!.orderNumber}?token=${encodeURIComponent(dbOrder!.orderAccessToken!)}`
    );
    expect(orderLookup.status).toBe(200);
    expect(orderLookup.body.data.order.status).toBe(OrderStatus.COMPLETED);
    expect(orderLookup.body.data.order.tickets.length).toBe(2);
    expect(piRetrieveSpy).not.toHaveBeenCalled();

    // Drain outbox passes (handles any pre-existing unrelated pending rows in shared test DB)
    // and verify the rendered confirmation shows $0.00 (Free) without Stripe refs.
    let delivered = sentOrderConfirmationEmails.find((m) => m.orderNumber === dbOrder!.orderNumber);
    for (let pass = 0; pass < 10 && !delivered; pass++) {
      const stats = await runEmailOutboxPass();
      delivered = sentOrderConfirmationEmails.find((m) => m.orderNumber === dbOrder!.orderNumber);
      if (delivered || stats.claimed === 0) break;
    }
    expect(delivered).toBeDefined();
    expect(delivered?.text).toContain('$0.00 (Free)');
    expect(delivered?.text).not.toContain('pi_');
    expect(delivered?.ticketAccessUrl).toContain(`/orders/${dbOrder!.orderNumber}?token=${dbOrder!.orderAccessToken}`);
  });

  it('2: fulfills a free multi-tier order and issues exact per-tier ticket counts atomically', async () => {
    const piCreateSpy = vi.spyOn(stripe.paymentIntents, 'create');
    const [beforeA, beforeB] = await Promise.all([
      prisma.ticketTier.findUnique({ where: { id: freeTierAId } }),
      prisma.ticketTier.findUnique({ where: { id: freeTierBId } }),
    ]);

    const res = await request(app)
      .post('/api/checkout/create-session')
      .send({
        eventId: publishedEventId,
        items: [
          { ticketTierId: freeTierAId, quantity: 2 },
          { ticketTierId: freeTierBId, quantity: 3 },
        ],
        customerEmail: `multi_${nanoid(6)}@example.com`,
        customerName: 'Multi Free Buyer',
        customerPhone: '+15552223333',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.isFreeOrder).toBe(true);
    expect(res.body.data.paymentProvider).toBe(PaymentProvider.FREE);
    expect(piCreateSpy).not.toHaveBeenCalled();

    const dbOrder = await prisma.order.findUnique({
      where: { orderNumber: res.body.data.orderNumber },
      include: { tickets: true },
    });
    expect(dbOrder?.tickets.length).toBe(5);
    expect(dbOrder?.tickets.filter((t) => t.ticketTierId === freeTierAId).length).toBe(2);
    expect(dbOrder?.tickets.filter((t) => t.ticketTierId === freeTierBId).length).toBe(3);

    const [afterA, afterB] = await Promise.all([
      prisma.ticketTier.findUnique({ where: { id: freeTierAId } }),
      prisma.ticketTier.findUnique({ where: { id: freeTierBId } }),
    ]);
    expect(afterA?.soldQuantity).toBe((beforeA?.soldQuantity ?? 0) + 2);
    expect(afterB?.soldQuantity).toBe((beforeB?.soldQuantity ?? 0) + 3);
  });

  it('6: concurrent free claims cannot oversell limited capacity', async () => {
    const piCreateSpy = vi.spyOn(stripe.paymentIntents, 'create');

    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, idx) =>
        request(app)
          .post('/api/checkout/create-session')
          .send({
            eventId: publishedEventId,
            items: [{ ticketTierId: limitedFreeTierId, quantity: 1 }],
            customerEmail: `race_free_${idx}_${nanoid(6)}@example.com`,
            customerName: `Race Buyer ${idx}`,
            customerPhone: '+15551112222',
          })
      )
    );

    const successes = responses.filter((r) => r.status === 201);
    const conflicts = responses.filter((r) => r.status === 409);

    expect(successes.length).toBe(2);
    expect(conflicts.length).toBe(4);
    expect(piCreateSpy).not.toHaveBeenCalled();

    const tierAfter = await prisma.ticketTier.findUnique({ where: { id: limitedFreeTierId } });
    expect(tierAfter?.soldQuantity).toBe(2);
    expect(tierAfter?.reservedQuantity).toBe(0);

    const issuedTicketsCount = await prisma.ticket.count({
      where: { ticketTierId: limitedFreeTierId },
    });
    expect(issuedTicketsCount).toBe(2);
  });

  it('7: sequential and concurrent duplicate submissions with same idempotencyKey never duplicate tickets, mismatch returns 409, and burst claims are rate-limited', async () => {
    const idemKey = `free_idem_${nanoid(12)}`;
    const buyerEmail = `idem_buyer_${nanoid(6)}@example.com`;
    const tierBefore = await prisma.ticketTier.findUnique({ where: { id: freeTierAId } });

    const payload = {
      eventId: publishedEventId,
      items: [{ ticketTierId: freeTierAId, quantity: 2 }],
      customerEmail: buyerEmail,
      customerName: 'Idempotent Free Buyer',
      customerPhone: '+15553334444',
      idempotencyKey: idemKey,
    };

    // Concurrent race on identical idempotencyKey
    const [r1, r2] = await Promise.all([
      request(app).post('/api/checkout/create-session').send(payload),
      request(app).post('/api/checkout/create-session').send(payload),
    ]);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r1.body.data.orderNumber).toBe(r2.body.data.orderNumber);
    expect(r1.body.data.orderAccessToken).toBe(r2.body.data.orderAccessToken);

    // Sequential retry with exact same idempotencyKey
    const r3 = await request(app).post('/api/checkout/create-session').send(payload);
    expect(r3.status).toBe(201);
    expect(r3.body.data.orderNumber).toBe(r1.body.data.orderNumber);

    // Payload mismatch using same idempotencyKey rejects with 409
    const mismatchRes = await request(app)
      .post('/api/checkout/create-session')
      .send({
        ...payload,
        items: [{ ticketTierId: freeTierAId, quantity: 3 }],
      });
    expect(mismatchRes.status).toBe(409);

    const matchingOrders = await prisma.order.findMany({
      where: { idempotencyKey: idemKey },
      include: { tickets: true, emailOutbox: true },
    });
    expect(matchingOrders.length).toBe(1);
    expect(matchingOrders[0].tickets.length).toBe(2);
    expect(matchingOrders[0].emailOutbox.length).toBe(1);

    const tierAfterIdem = await prisma.ticketTier.findUnique({ where: { id: freeTierAId } });
    expect(tierAfterIdem?.soldQuantity).toBe((tierBefore?.soldQuantity ?? 0) + 2);

    // Burst rate limit across distinct keys for same (event, email)
    for (let i = 1; i < FREE_ORDER_BURST_MAX_ORDERS_PER_EMAIL; i++) {
      const burstRes = await request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: publishedEventId,
          items: [{ ticketTierId: freeTierAId, quantity: 1 }],
          customerEmail: buyerEmail,
          customerName: 'Idempotent Free Buyer',
          customerPhone: '+15553334444',
        });
      expect(burstRes.status).toBe(201);
    }

    const throttledRes = await request(app)
      .post('/api/checkout/create-session')
      .send({
        eventId: publishedEventId,
        items: [{ ticketTierId: freeTierAId, quantity: 1 }],
        customerEmail: buyerEmail,
        customerName: 'Idempotent Free Buyer',
        customerPhone: '+15553334444',
      });
    expect(throttledRes.status).toBe(429);
    expect(throttledRes.body.error.code).toBe('FREE_CHECKOUT_RATE_LIMIT');

    // Original idempotent replay STILL succeeds even after hitting new-claim burst limit
    const replayAfterBurst = await request(app).post('/api/checkout/create-session').send(payload);
    expect(replayAfterBurst.status).toBe(201);
    expect(replayAfterBurst.body.data.orderNumber).toBe(r1.body.data.orderNumber);
  });

  it('8 & 9: mixed free/paid carts and paid-only orders stay strictly on the Stripe checkout path', async () => {
    const piCreateSpy = vi
      .spyOn(stripe.paymentIntents, 'create')
      .mockImplementation(async (params: any) => ({
        id: `pi_mock_${nanoid(10)}`,
        client_secret: `pi_mock_${nanoid(10)}_secret_123`,
        amount: params.amount,
        currency: params.currency,
        status: 'requires_payment_method',
      }) as any);

    // Mixed cart: $0 tier + $20 tier -> MUST use Stripe path
    const mixedRes = await request(app)
      .post('/api/checkout/create-session')
      .send({
        eventId: publishedEventId,
        items: [
          { ticketTierId: freeTierAId, quantity: 1 },
          { ticketTierId: paidTierId, quantity: 1 },
        ],
        customerEmail: `mixed_${nanoid(6)}@example.com`,
        customerName: 'Mixed Buyer',
        customerPhone: '+15556667777',
      });

    expect(mixedRes.status).toBe(201);
    expect(mixedRes.body.data.isFreeOrder).toBe(false);
    expect(mixedRes.body.data.paymentProvider).toBe(PaymentProvider.STRIPE);
    expect(mixedRes.body.data.status).toBe(OrderStatus.PENDING);
    expect(mixedRes.body.data.clientSecret).toContain('_secret_');
    expect(mixedRes.body.data.totalInCents).toBeGreaterThan(2000);

    const mixedDbOrder = await prisma.order.findUnique({
      where: { orderNumber: mixedRes.body.data.orderNumber },
      include: { tickets: true, reservations: true },
    });
    expect(mixedDbOrder?.status).toBe(OrderStatus.PENDING);
    expect(mixedDbOrder?.paymentProvider).toBe(PaymentProvider.STRIPE);
    expect(mixedDbOrder?.tickets.length).toBe(0);
    expect(mixedDbOrder?.reservations.every((r) => r.status === ReservationStatus.ACTIVE)).toBe(true);

    // Paid-only cart continues through Stripe unchanged
    const paidRes = await request(app)
      .post('/api/checkout/create-session')
      .send({
        eventId: publishedEventId,
        items: [{ ticketTierId: paidTierId, quantity: 1 }],
        customerEmail: `paid_${nanoid(6)}@example.com`,
        customerName: 'Paid Buyer',
        customerPhone: '+15558889999',
      });

    expect(paidRes.status).toBe(201);
    expect(paidRes.body.data.isFreeOrder).toBe(false);
    expect(paidRes.body.data.paymentProvider).toBe(PaymentProvider.STRIPE);
    expect(paidRes.body.data.status).toBe(OrderStatus.PENDING);
    expect(paidRes.body.data.clientSecret).toContain('_secret_');
    expect(piCreateSpy).toHaveBeenCalledTimes(2);
  });

  it('10: enforces password protection, min/max purchase limits, and tier availability rules on free orders', async () => {
    const piCreateSpy = vi.spyOn(stripe.paymentIntents, 'create');

    // Without access token -> 403
    const deniedRes = await request(app)
      .post('/api/checkout/create-session')
      .send({
        eventId: passwordEventId,
        items: [{ ticketTierId: passwordFreeTierId, quantity: 1 }],
        customerEmail: `pwd_denied_${nanoid(6)}@example.com`,
        customerName: 'Unauthorized Guest',
        customerPhone: '+15551230000',
      });
    expect(deniedRes.status).toBe(403);

    // With valid access token -> 201 free fulfillment
    const allowedRes = await request(app)
      .post('/api/checkout/create-session')
      .send({
        eventId: passwordEventId,
        items: [{ ticketTierId: passwordFreeTierId, quantity: 1 }],
        customerEmail: `pwd_ok_${nanoid(6)}@example.com`,
        customerName: 'Invited Guest',
        customerPhone: '+15551230001',
        eventAccessToken: validPasswordToken,
      });
    expect(allowedRes.status).toBe(201);
    expect(allowedRes.body.data.isFreeOrder).toBe(true);
    expect(allowedRes.body.data.status).toBe(OrderStatus.COMPLETED);

    // Enforce minPerOrder (2) and maxPerOrder (3)
    const belowMinRes = await request(app)
      .post('/api/checkout/create-session')
      .send({
        eventId: publishedEventId,
        items: [{ ticketTierId: restrictedFreeTierId, quantity: 1 }],
        customerEmail: `min_${nanoid(6)}@example.com`,
        customerName: 'Min Fail',
        customerPhone: '+15551230002',
      });
    expect(belowMinRes.status).toBe(400);
    expect(belowMinRes.body.error.message).toContain('Minimum purchase');

    const aboveMaxRes = await request(app)
      .post('/api/checkout/create-session')
      .send({
        eventId: publishedEventId,
        items: [{ ticketTierId: restrictedFreeTierId, quantity: 4 }],
        customerEmail: `max_${nanoid(6)}@example.com`,
        customerName: 'Max Fail',
        customerPhone: '+15551230003',
      });
    expect(aboveMaxRes.status).toBe(400);
    expect(aboveMaxRes.body.error.message).toContain('Maximum purchase');

    // Disabled sales -> rejected
    await prisma.ticketTier.update({
      where: { id: restrictedFreeTierId },
      data: { salesDisabled: true },
    });
    const disabledRes = await request(app)
      .post('/api/checkout/create-session')
      .send({
        eventId: publishedEventId,
        items: [{ ticketTierId: restrictedFreeTierId, quantity: 2 }],
        customerEmail: `disabled_${nanoid(6)}@example.com`,
        customerName: 'Disabled Tier Buyer',
        customerPhone: '+15551230004',
      });
    expect(disabledRes.status).toBe(400);
    expect(disabledRes.body.error.message).toContain('currently disabled');

    await prisma.ticketTier.update({
      where: { id: restrictedFreeTierId },
      data: { salesDisabled: false },
    });

    expect(piCreateSpy).not.toHaveBeenCalled();
  });

  it('11: prevents unauthorized free claims from consuming waitlist-reserved capacity and fulfills valid free waitlist offer atomically', async () => {
    // waitlistFreeTierId has totalCapacity=3, soldQuantity=1, reservedQuantity=2 (0 unallocated!)
    const offerEmail = `wl_holder_${nanoid(6)}@example.com`;
    const rawOfferToken = `wl_raw_${nanoid(24)}`;

    const wlEntry = await prisma.ticketWaitlistEntry.create({
      data: {
        eventId: waitlistEventId,
        ticketTierId: waitlistFreeTierId,
        customerEmail: offerEmail,
        customerName: 'Waitlist Guest',
        quantity: 2,
        status: WaitlistEntryStatus.OFFERED,
      },
    });
    const wlOffer = await prisma.ticketWaitlistOffer.create({
      data: {
        entryId: wlEntry.id,
        eventId: waitlistEventId,
        ticketTierId: waitlistFreeTierId,
        quantity: 2,
        status: WaitlistOfferStatus.PENDING,
        tokenHash: hashOfferToken(rawOfferToken),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });

    // Uninvited buyer CANNOT consume the 2 waitlist-held slots
    const intruderRes = await request(app)
      .post('/api/checkout/create-session')
      .send({
        eventId: waitlistEventId,
        items: [{ ticketTierId: waitlistFreeTierId, quantity: 1 }],
        customerEmail: `intruder_${nanoid(6)}@example.com`,
        customerName: 'Uninvited Buyer',
        customerPhone: '+15554445555',
      });
    expect(intruderRes.status).toBe(409);

    // Valid offer holder redeems partial quantity (1 of 2 offered) with idempotencyKey
    const wlIdemKey = `wl_free_idem_${nanoid(10)}`;
    const claimRes = await request(app)
      .post('/api/checkout/create-session')
      .send({
        eventId: waitlistEventId,
        items: [{ ticketTierId: waitlistFreeTierId, quantity: 1 }],
        customerEmail: offerEmail,
        customerName: 'Waitlist Guest',
        customerPhone: '+15554445556',
        offerToken: rawOfferToken,
        idempotencyKey: wlIdemKey,
      });
    expect(claimRes.status).toBe(201);
    expect(claimRes.body.data.isFreeOrder).toBe(true);
    expect(claimRes.body.data.status).toBe(OrderStatus.COMPLETED);

    // Idempotent retry of the same waitlist claim returns original completed order without re-erroring
    const retryClaimRes = await request(app)
      .post('/api/checkout/create-session')
      .send({
        eventId: waitlistEventId,
        items: [{ ticketTierId: waitlistFreeTierId, quantity: 1 }],
        customerEmail: offerEmail,
        customerName: 'Waitlist Guest',
        customerPhone: '+15554445556',
        offerToken: rawOfferToken,
        idempotencyKey: wlIdemKey,
      });
    expect(retryClaimRes.status).toBe(201);
    expect(retryClaimRes.body.data.orderNumber).toBe(claimRes.body.data.orderNumber);

    // Second different attempt using already-accepted offerToken fails cleanly
    const reuseRes = await request(app)
      .post('/api/checkout/create-session')
      .send({
        eventId: waitlistEventId,
        items: [{ ticketTierId: waitlistFreeTierId, quantity: 1 }],
        customerEmail: offerEmail,
        customerName: 'Waitlist Guest',
        customerPhone: '+15554445556',
        offerToken: rawOfferToken,
      });
    expect(reuseRes.status).toBe(400);

    const [updatedOffer, updatedEntry, updatedTier] = await Promise.all([
      prisma.ticketWaitlistOffer.findUnique({ where: { id: wlOffer.id } }),
      prisma.ticketWaitlistEntry.findUnique({ where: { id: wlEntry.id } }),
      prisma.ticketTier.findUnique({ where: { id: waitlistFreeTierId } }),
    ]);

    expect(updatedOffer?.status).toBe(WaitlistOfferStatus.ACCEPTED);
    expect(updatedEntry?.status).toBe(WaitlistEntryStatus.PURCHASED);
    expect(updatedTier?.reservedQuantity).toBe(0);
    expect(updatedTier?.soldQuantity).toBe(2); // 1 prior + 1 redeemed; 1 slot freed back to pool
  });

  it('13: rolls back order, tickets, and inventory completely when mid-transaction fulfillment fails', async () => {
    const email = `rollback_${nanoid(6)}@example.com`;
    const tierBefore = await prisma.ticketTier.findUnique({ where: { id: freeTierBId } });
    const ticketCountBefore = await prisma.ticket.count({ where: { ticketTierId: freeTierBId } });

    const enqueueSpy = vi
      .spyOn(emailOutboxService, 'enqueueOrderConfirmationEmail')
      .mockRejectedValueOnce(new Error('Simulated outbox DB failure'));

    const res = await request(app)
      .post('/api/checkout/create-session')
      .send({
        eventId: publishedEventId,
        items: [{ ticketTierId: freeTierBId, quantity: 2 }],
        customerEmail: email,
        customerName: 'Rollback Check',
        customerPhone: '+15559990000',
      });

    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(res.status).toBeGreaterThanOrEqual(400);

    const [ordersAfter, tierAfter, ticketCountAfter] = await Promise.all([
      prisma.order.findMany({ where: { eventId: publishedEventId, customerEmail: email } }),
      prisma.ticketTier.findUnique({ where: { id: freeTierBId } }),
      prisma.ticket.count({ where: { ticketTierId: freeTierBId } }),
    ]);

    expect(ordersAfter.length).toBe(0);
    expect(tierAfter?.soldQuantity).toBe(tierBefore?.soldQuantity ?? 0);
    expect(tierAfter?.reservedQuantity).toBe(tierBefore?.reservedQuantity ?? 0);
    expect(ticketCountAfter).toBe(ticketCountBefore);
  });

  it('15 (adversarial): concurrent pure free claims and mixed-cart paid reservations competing on the same free tier never oversell capacity', async () => {
    const contestedFreeTier = await prisma.ticketTier.create({
      data: {
        eventId: publishedEventId,
        name: `Contested Free Tier ${nanoid(6)}`,
        priceInCents: 0,
        currency: 'USD',
        totalCapacity: 2,
        reservedQuantity: 0,
        soldQuantity: 0,
        minPerOrder: 1,
        maxPerOrder: 1,
        status: TicketTierStatus.ACTIVE,
      },
    });

    vi.spyOn(stripe.paymentIntents, 'create').mockImplementation(async (params: any) => ({
      id: `pi_race_mixed_${nanoid(10)}`,
      client_secret: `pi_race_mixed_${nanoid(10)}_secret`,
      amount: params.amount,
      currency: params.currency,
      status: 'requires_payment_method',
    }) as any);

    const freeCalls = Array.from({ length: 3 }, (_, idx) =>
      request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: publishedEventId,
          items: [{ ticketTierId: contestedFreeTier.id, quantity: 1 }],
          customerEmail: `contend_free_${idx}_${nanoid(6)}@example.com`,
          customerName: `Contend Free ${idx}`,
          customerPhone: '+15551010101',
        })
    );
    const mixedCalls = Array.from({ length: 3 }, (_, idx) =>
      request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: publishedEventId,
          items: [
            { ticketTierId: contestedFreeTier.id, quantity: 1 },
            { ticketTierId: paidTierId, quantity: 1 },
          ],
          customerEmail: `contend_mixed_${idx}_${nanoid(6)}@example.com`,
          customerName: `Contend Mixed ${idx}`,
          customerPhone: '+15552020202',
        })
    );

    const results = await Promise.all([...freeCalls, ...mixedCalls]);
    const freeResults = results.slice(0, 3);
    const mixedResults = results.slice(3);

    const freeSuccesses = freeResults.filter((r) => r.status === 201);
    const mixedSuccesses = mixedResults.filter((r) => r.status === 201);
    const conflicts = results.filter((r) => r.status === 409);

    expect(freeSuccesses.length + mixedSuccesses.length).toBe(2);
    expect(conflicts.length).toBe(4);

    for (const r of freeSuccesses) {
      expect(r.body.data.paymentProvider).toBe(PaymentProvider.FREE);
      expect(r.body.data.status).toBe(OrderStatus.COMPLETED);
    }
    for (const r of mixedSuccesses) {
      expect(r.body.data.paymentProvider).toBe(PaymentProvider.STRIPE);
      expect(r.body.data.status).toBe(OrderStatus.PENDING);
    }

    const tierAfter = await prisma.ticketTier.findUnique({ where: { id: contestedFreeTier.id } });
    expect(tierAfter).not.toBeNull();
    expect(tierAfter!.soldQuantity).toBe(freeSuccesses.length);
    expect(tierAfter!.reservedQuantity).toBe(mixedSuccesses.length);
    expect(tierAfter!.soldQuantity + tierAfter!.reservedQuantity).toBe(2);
    expect(tierAfter!.totalCapacity - tierAfter!.soldQuantity - tierAfter!.reservedQuantity).toBe(0);

    const issuedOnContested = await prisma.ticket.count({
      where: { ticketTierId: contestedFreeTier.id },
    });
    expect(issuedOnContested).toBe(freeSuccesses.length);
  });

  it('16 (adversarial): rejects expired waitlist offer on free checkout cleanly without issuing tickets or altering inventory', async () => {
    const expiredEmail = `wl_expired_${nanoid(6)}@example.com`;
    const rawExpiredToken = `wl_exp_raw_${nanoid(24)}`;
    const expiredTier = await prisma.ticketTier.create({
      data: {
        eventId: waitlistEventId,
        name: `Expired WL Free Tier ${nanoid(6)}`,
        priceInCents: 0,
        currency: 'USD',
        totalCapacity: 2,
        reservedQuantity: 1,
        soldQuantity: 0,
        waitlistEnabled: true,
        status: TicketTierStatus.ACTIVE,
      },
    });

    const entry = await prisma.ticketWaitlistEntry.create({
      data: {
        eventId: waitlistEventId,
        ticketTierId: expiredTier.id,
        customerEmail: expiredEmail,
        customerName: 'Expired Offer User',
        quantity: 1,
        status: WaitlistEntryStatus.OFFERED,
      },
    });
    await prisma.ticketWaitlistOffer.create({
      data: {
        entryId: entry.id,
        eventId: waitlistEventId,
        ticketTierId: expiredTier.id,
        quantity: 1,
        status: WaitlistOfferStatus.PENDING,
        tokenHash: hashOfferToken(rawExpiredToken),
        expiresAt: new Date(Date.now() - 60_000),
      },
    });

    const res = await request(app)
      .post('/api/checkout/create-session')
      .send({
        eventId: waitlistEventId,
        items: [{ ticketTierId: expiredTier.id, quantity: 1 }],
        customerEmail: expiredEmail,
        customerName: 'Expired Offer User',
        customerPhone: '+15553030303',
        offerToken: rawExpiredToken,
      });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('expired or is no longer valid');

    const [tierAfter, ticketCount, orderCount] = await Promise.all([
      prisma.ticketTier.findUnique({ where: { id: expiredTier.id } }),
      prisma.ticket.count({ where: { ticketTierId: expiredTier.id } }),
      prisma.order.count({ where: { eventId: waitlistEventId, customerEmail: expiredEmail } }),
    ]);

    expect(tierAfter?.soldQuantity).toBe(0);
    expect(tierAfter?.reservedQuantity).toBe(1);
    expect(ticketCount).toBe(0);
    expect(orderCount).toBe(0);
  });

  it('17 (adversarial): partial waitlist redemption advances next waiting entry post-commit and handles concurrent same-key offer race idempotently', async () => {
    const partialTier = await prisma.ticketTier.create({
      data: {
        eventId: waitlistEventId,
        name: `Partial Advance Free Tier ${nanoid(6)}`,
        priceInCents: 0,
        currency: 'USD',
        totalCapacity: 3,
        reservedQuantity: 2,
        soldQuantity: 1,
        waitlistEnabled: true,
        minPerOrder: 1,
        maxPerOrder: 5,
        status: TicketTierStatus.ACTIVE,
      },
    });

    const holder1Email = `wl_p1_${nanoid(6)}@example.com`;
    const holder2Email = `wl_p2_${nanoid(6)}@example.com`;
    const rawOfferToken = `wl_partial_adv_${nanoid(24)}`;

    const entry1 = await prisma.ticketWaitlistEntry.create({
      data: {
        eventId: waitlistEventId,
        ticketTierId: partialTier.id,
        customerEmail: holder1Email,
        customerName: 'First Offer Holder',
        quantity: 2,
        status: WaitlistEntryStatus.OFFERED,
      },
    });
    const offer1 = await prisma.ticketWaitlistOffer.create({
      data: {
        entryId: entry1.id,
        eventId: waitlistEventId,
        ticketTierId: partialTier.id,
        quantity: 2,
        status: WaitlistOfferStatus.PENDING,
        tokenHash: hashOfferToken(rawOfferToken),
        expiresAt: new Date(Date.now() + 15 * 60_000),
      },
    });
    const entry2 = await prisma.ticketWaitlistEntry.create({
      data: {
        eventId: waitlistEventId,
        ticketTierId: partialTier.id,
        customerEmail: holder2Email,
        customerName: 'Second Waiting User',
        quantity: 1,
        status: WaitlistEntryStatus.WAITING,
      },
    });

    // Fire two concurrent identical requests claiming 1 of 2 offered tickets with the same idempotencyKey
    const raceIdemKey = `wl_concurrent_idem_${nanoid(10)}`;
    const payload = {
      eventId: waitlistEventId,
      items: [{ ticketTierId: partialTier.id, quantity: 1 }],
      customerEmail: holder1Email,
      customerName: 'First Offer Holder',
      customerPhone: '+15554040404',
      offerToken: rawOfferToken,
      idempotencyKey: raceIdemKey,
    };

    const [resA, resB] = await Promise.all([
      request(app).post('/api/checkout/create-session').send(payload),
      request(app).post('/api/checkout/create-session').send(payload),
    ]);

    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);
    expect(resA.body.data.orderNumber).toBe(resB.body.data.orderNumber);
    expect(resA.body.data.orderAccessToken).toBe(resB.body.data.orderAccessToken);

    // Wait briefly for post-commit async processWaitlistForTier(partialTier.id) to promote entry2
    let offer2 = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      offer2 = await prisma.ticketWaitlistOffer.findFirst({
        where: { entryId: entry2.id, ticketTierId: partialTier.id },
      });
      if (offer2) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const [updatedOffer1, updatedEntry1, updatedEntry2, tierAfter, ticketsIssued] = await Promise.all([
      prisma.ticketWaitlistOffer.findUnique({ where: { id: offer1.id } }),
      prisma.ticketWaitlistEntry.findUnique({ where: { id: entry1.id } }),
      prisma.ticketWaitlistEntry.findUnique({ where: { id: entry2.id } }),
      prisma.ticketTier.findUnique({ where: { id: partialTier.id } }),
      prisma.ticket.count({ where: { ticketTierId: partialTier.id } }),
    ]);

    expect(updatedOffer1?.status).toBe(WaitlistOfferStatus.ACCEPTED);
    expect(updatedEntry1?.status).toBe(WaitlistEntryStatus.PURCHASED);
    expect(offer2).not.toBeNull();
    expect(offer2?.status).toBe(WaitlistOfferStatus.PENDING);
    expect(offer2?.quantity).toBe(1);
    expect(updatedEntry2?.status).toBe(WaitlistEntryStatus.OFFERED);
    expect(tierAfter?.soldQuantity).toBe(2); // 1 prior + 1 redeemed
    expect(tierAfter?.reservedQuantity).toBe(1); // held for entry2's newly created offer
    expect(ticketsIssued).toBe(1);
  });

  it('18 (adversarial): enforces cross-tier burst limit under concurrency per (event, email) while isolating distinct emails and preserving idempotent replay', async () => {
    const burstTierSingle = await prisma.ticketTier.create({
      data: {
        eventId: publishedEventId,
        name: `Concurrent Burst Tier A ${nanoid(6)}`,
        priceInCents: 0,
        currency: 'USD',
        totalCapacity: 100,
        reservedQuantity: 0,
        soldQuantity: 0,
        minPerOrder: 1,
        maxPerOrder: 1,
        status: TicketTierStatus.ACTIVE,
      },
    });
    const burstTierOther = await prisma.ticketTier.create({
      data: {
        eventId: publishedEventId,
        name: `Concurrent Burst Tier B ${nanoid(6)}`,
        priceInCents: 0,
        currency: 'USD',
        totalCapacity: 100,
        reservedQuantity: 0,
        soldQuantity: 0,
        minPerOrder: 1,
        maxPerOrder: 1,
        status: TicketTierStatus.ACTIVE,
      },
    });

    // 1. Concurrent requests against the SAME tier serialize strictly at 10 orders
    const singleTierBurstEmail = `conc_burst_1_${nanoid(6)}@example.com`;
    const singleTierResponses = await Promise.all(
      Array.from({ length: 13 }, () =>
        request(app)
          .post('/api/checkout/create-session')
          .send({
            eventId: publishedEventId,
            items: [{ ticketTierId: burstTierSingle.id, quantity: 1 }],
            customerEmail: singleTierBurstEmail,
            customerName: 'Concurrent Burst User',
            customerPhone: '+15555050505',
          })
      )
    );

    const unexpectedSingle = singleTierResponses.filter((r) => r.status !== 201 && r.status !== 429);
    expect(unexpectedSingle.map((r) => ({ status: r.status, body: r.body }))).toEqual([]);
    expect(singleTierResponses.filter((r) => r.status === 201).length).toBe(
      FREE_ORDER_BURST_MAX_ORDERS_PER_EMAIL
    );
    expect(singleTierResponses.filter((r) => r.status === 429).length).toBe(3);

    // 2. Concurrent requests spread across DIFFERENT free tiers of the SAME event & SAME email
    // (mixed casing too!) MUST strictly cap total committed free orders at 10 (plus replay check)
    const crossTierBase = `conc_cross_tier_${nanoid(6)}@example.com`;
    const replayIdemKey = `cross_tier_replay_${nanoid(10)}`;
    const seededFirstRes = await request(app)
      .post('/api/checkout/create-session')
      .send({
        eventId: publishedEventId,
        items: [{ ticketTierId: burstTierSingle.id, quantity: 1 }],
        customerEmail: crossTierBase,
        customerName: 'Cross Tier Burst User',
        customerPhone: '+15556060606',
        idempotencyKey: replayIdemKey,
      });
    expect(seededFirstRes.status).toBe(201);

    // Fire 14 concurrent requests (7 on Tier A, 7 on Tier B) -> max 9 more can succeed (1 + 9 = 10 total!)
    const crossTierResponses = await Promise.all([
      ...Array.from({ length: 7 }, (_, i) =>
        request(app)
          .post('/api/checkout/create-session')
          .send({
            eventId: publishedEventId,
            items: [{ ticketTierId: burstTierSingle.id, quantity: 1 }],
            customerEmail: i % 2 === 0 ? crossTierBase : crossTierBase.toUpperCase(),
            customerName: 'Cross Tier Burst User',
            customerPhone: '+15556060606',
          })
      ),
      ...Array.from({ length: 7 }, (_, i) =>
        request(app)
          .post('/api/checkout/create-session')
          .send({
            eventId: publishedEventId,
            items: [{ ticketTierId: burstTierOther.id, quantity: 1 }],
            customerEmail: i % 2 === 0 ? crossTierBase : crossTierBase.toUpperCase(),
            customerName: 'Cross Tier Burst User',
            customerPhone: '+15556060606',
          })
      ),
    ]);

    const unexpectedCross = crossTierResponses.filter((r) => r.status !== 201 && r.status !== 429);
    expect(unexpectedCross.map((r) => ({ status: r.status, body: r.body }))).toEqual([]);
    const crossTier201s = crossTierResponses.filter((r) => r.status === 201);
    const crossTier429s = crossTierResponses.filter((r) => r.status === 429);
    expect(crossTier201s.length).toBe(FREE_ORDER_BURST_MAX_ORDERS_PER_EMAIL - 1);
    expect(crossTier429s.length).toBe(5);
    expect(
      crossTier429s.every((r) => r.body.error.code === 'FREE_CHECKOUT_RATE_LIMIT')
    ).toBe(true);

    const committedCrossTierCount = await prisma.order.count({
      where: {
        eventId: publishedEventId,
        customerEmail: { equals: crossTierBase, mode: 'insensitive' },
        paymentProvider: PaymentProvider.FREE,
        status: OrderStatus.COMPLETED,
      },
    });
    expect(committedCrossTierCount).toBe(FREE_ORDER_BURST_MAX_ORDERS_PER_EMAIL);

    // 3. Idempotent replay after hitting the cross-tier burst limit STILL succeeds without creating extra orders
    const replayAfterBurstRes = await request(app)
      .post('/api/checkout/create-session')
      .send({
        eventId: publishedEventId,
        items: [{ ticketTierId: burstTierSingle.id, quantity: 1 }],
        customerEmail: crossTierBase,
        customerName: 'Cross Tier Burst User',
        customerPhone: '+15556060606',
        idempotencyKey: replayIdemKey,
      });
    expect(replayAfterBurstRes.status).toBe(201);
    expect(replayAfterBurstRes.body.data.orderNumber).toBe(seededFirstRes.body.data.orderNumber);

    // 4. Concurrent requests from DIFFERENT emails on the same tiers succeed independently
    const distinctEmailResponses = await Promise.all(
      Array.from({ length: 6 }, (_, idx) =>
        request(app)
          .post('/api/checkout/create-session')
          .send({
            eventId: publishedEventId,
            items: [{ ticketTierId: idx % 2 === 0 ? burstTierSingle.id : burstTierOther.id, quantity: 1 }],
            customerEmail: `distinct_burst_${idx}_${nanoid(6)}@example.com`,
            customerName: `Distinct User ${idx}`,
            customerPhone: '+15557070707',
          })
      )
    );
    expect(distinctEmailResponses.every((r) => r.status === 201)).toBe(true);

    const committedCrossTierFinalCount = await prisma.order.count({
      where: {
        eventId: publishedEventId,
        customerEmail: { equals: crossTierBase, mode: 'insensitive' },
        paymentProvider: PaymentProvider.FREE,
        status: OrderStatus.COMPLETED,
      },
    });
    expect(committedCrossTierFinalCount).toBe(FREE_ORDER_BURST_MAX_ORDERS_PER_EMAIL);
  });
});
