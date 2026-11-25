import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import Stripe from 'stripe';
import { nanoid } from 'nanoid';
import {
  EventCategory,
  EventStatus,
  LedgerEntryType,
  OrderStatus,
  PaymentProvider,
  PayoutStatus,
  ReservationStatus,
  Role,
  TicketTierStatus,
} from '@prisma/client';
import { app } from '../app.js';
import { prisma } from '../db/prisma.js';
import { stripe } from '../lib/stripe.js';
import {
  env,
  validateStripeProductionConfig,
  validateStripeWebhookProductionConfig,
} from '../config/env.js';
import { processStripeWebhookEvent } from '../modules/webhooks/webhook.service.js';
import { getConnectedAccountPayouts } from '../modules/finance/finance.service.js';
import { calculateCheckoutFeeBreakdown } from '../modules/checkout/checkout.financials.js';

describe('Stage 5: Stripe Webhooks, Reconciliation & Production Readiness (Real PostgreSQL)', () => {
  const createdUserIds: string[] = [];
  const createdEventIds: string[] = [];
  const createdOrderIds: string[] = [];
  const createdWebhookEventIds: string[] = [];
  const createdPayoutIds: string[] = [];

  const originalPlatformWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const originalConnectWebhookSecret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  const originalStripeSecretKey = process.env.STRIPE_SECRET_KEY;

  beforeAll(async () => {
    const [{ current_database }] = await prisma.$queryRaw<Array<{ current_database: string }>>`
      SELECT current_database()::text AS current_database
    `;
    expect(current_database).toBe('outside_vip_stage4_verify');
  }, 30_000);

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalPlatformWebhookSecret === undefined) {
      delete process.env.STRIPE_WEBHOOK_SECRET;
    } else {
      process.env.STRIPE_WEBHOOK_SECRET = originalPlatformWebhookSecret;
    }
    if (originalConnectWebhookSecret === undefined) {
      delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
    } else {
      process.env.STRIPE_CONNECT_WEBHOOK_SECRET = originalConnectWebhookSecret;
    }
    if (originalStripeSecretKey === undefined) {
      delete process.env.STRIPE_SECRET_KEY;
    } else {
      process.env.STRIPE_SECRET_KEY = originalStripeSecretKey;
    }
  });

  afterAll(async () => {
    if (createdWebhookEventIds.length > 0) {
      await prisma.processedWebhookEvent.deleteMany({
        where: { eventId: { in: createdWebhookEventIds } },
      });
    }
    if (createdPayoutIds.length > 0) {
      await prisma.connectedPayout.deleteMany({
        where: { stripePayoutId: { in: createdPayoutIds } },
      });
    }
    if (createdOrderIds.length > 0) {
      await prisma.emailOutbox.deleteMany({
        where: { orderId: { in: createdOrderIds } },
      });
      await prisma.financialLedgerEntry.deleteMany({
        where: { orderId: { in: createdOrderIds } },
      });
      await prisma.paymentTransaction.deleteMany({
        where: { orderId: { in: createdOrderIds } },
      });
      await prisma.ticketReservation.deleteMany({
        where: { orderId: { in: createdOrderIds } },
      });
      await prisma.ticket.deleteMany({
        where: { orderId: { in: createdOrderIds } },
      });
      await prisma.orderItem.deleteMany({
        where: { orderId: { in: createdOrderIds } },
      });
      await prisma.order.deleteMany({
        where: { id: { in: createdOrderIds } },
      });
    }
    if (createdEventIds.length > 0) {
      await prisma.ticketTier.deleteMany({
        where: { eventId: { in: createdEventIds } },
      });
      await prisma.event.deleteMany({
        where: { id: { in: createdEventIds } },
      });
    }
    if (createdUserIds.length > 0) {
      await prisma.organizerBalance.deleteMany({
        where: { userId: { in: createdUserIds } },
      });
      await prisma.organizerProfile.deleteMany({
        where: { userId: { in: createdUserIds } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: createdUserIds } },
      });
    }
  }, 30_000);

  function trackEvt<T extends Stripe.Event>(evt: T): T {
    createdWebhookEventIds.push(evt.id);
    return evt;
  }

  async function createOrderScenario(tag: string) {
    const suffix = `${tag}_${nanoid(6)}`;
    const organizer = await prisma.user.create({
      data: {
        email: `s5_org_${suffix}@outside.vip`,
        name: `S5 Org ${tag}`,
        role: Role.ORGANIZER,
        emailVerified: true,
        stripeAccountId: `acct_s5_${suffix}`,
        stripeAccountCountry: 'US',
        stripeAccountDefaultCurrency: 'usd',
        stripeAccountDetailsSubmitted: true,
        stripeAccountChargesEnabled: true,
        stripeAccountPayoutsEnabled: true,
        stripeAccountTransfersCapability: 'active',
        organizer: {
          create: {
            displayName: `S5 Collective ${suffix}`,
            slug: `s5-coll-${suffix}`.toLowerCase(),
          },
        },
      },
    });
    createdUserIds.push(organizer.id);

    const event = await prisma.event.create({
      data: {
        slug: `s5-evt-${suffix}`.toLowerCase(),
        organizerId: organizer.id,
        title: `S5 Event ${suffix}`,
        description: 'Stage 5 webhook readiness verification',
        category: EventCategory.MUSIC,
        status: EventStatus.PUBLISHED,
        coverImageUrl: 'https://example.com/s5-cover.jpg',
        venueName: 'Stage 5 Hall',
        venueAddress: '1 Stage 5 Rd',
        city: 'Nairobi',
        country: 'US',
        startAt: new Date(Date.now() + 86_400_000),
        endAt: new Date(Date.now() + 90_000_000),
        timezone: 'UTC',
      },
    });
    createdEventIds.push(event.id);

    const tier = await prisma.ticketTier.create({
      data: {
        eventId: event.id,
        name: 'GA Stage 5',
        priceInCents: 2000,
        currency: 'USD',
        totalCapacity: 20,
        reservedQuantity: 1,
        soldQuantity: 0,
        status: TicketTierStatus.ACTIVE,
      },
    });

    const breakdown = calculateCheckoutFeeBreakdown([{ priceInCents: 2000, quantity: 1 }]);
    const piId = `pi_s5_${suffix}`;
    const order = await prisma.order.create({
      data: {
        orderNumber: `OUT-S5-${suffix}`,
        eventId: event.id,
        status: OrderStatus.PENDING,
        customerEmail: `buyer_${suffix}@example.com`,
        customerName: 'Stage 5 Buyer',
        totalInCents: breakdown.buyerTotalInCents,
        currency: 'USD',
        platformFeeInCents: breakdown.platformRevenueInCents,
        organizerNetInCents: breakdown.organizerEarningsInCents,
        idempotencyKey: `idem_s5_${suffix}`,
        paymentProvider: PaymentProvider.STRIPE,
        paymentReference: piId,
        expiresAt: new Date(Date.now() + 900_000),
        items: {
          create: {
            ticketTierId: tier.id,
            quantity: 1,
            unitPriceInCents: 2000,
            subtotalInCents: 2000,
          },
        },
        reservations: {
          create: {
            ticketTierId: tier.id,
            quantity: 1,
            status: ReservationStatus.ACTIVE,
            expiresAt: new Date(Date.now() + 900_000),
          },
        },
      },
    });
    createdOrderIds.push(order.id);

    return { organizer, event, tier, order, piId, breakdown };
  }

  describe('1. Production Configuration Validation', () => {
    it('requires sk_live_ key and distinct non-placeholder whsec_ secrets in production while never leaking secret material', () => {
      const dummyLiveSecret = `sk_live_${'AbcDef1234567890Xyz'}`;
      const dummyTestSecret = `sk_test_${'AbcDef1234567890Xyz'}`;
      const dummyPlatWh = `whsec_${'platformSecretValue123'}`;
      const dummyConnWh = `whsec_${'connectSecretValue456'}`;

      // Valid live configuration passes
      expect(() =>
        validateStripeProductionConfig({
          NODE_ENV: 'production',
          STRIPE_SECRET_KEY: dummyLiveSecret,
          STRIPE_WEBHOOK_SECRET: dummyPlatWh,
          STRIPE_CONNECT_WEBHOOK_SECRET: dummyConnWh,
        })
      ).not.toThrow();

      // Test key rejected in production without exposing key value in message
      let testKeyErr: Error | null = null;
      try {
        validateStripeProductionConfig({
          NODE_ENV: 'production',
          STRIPE_SECRET_KEY: dummyTestSecret,
          STRIPE_WEBHOOK_SECRET: dummyPlatWh,
          STRIPE_CONNECT_WEBHOOK_SECRET: dummyConnWh,
        });
      } catch (err: any) {
        testKeyErr = err;
      }
      expect(testKeyErr?.message).toMatch(/sk_live_/i);
      expect(testKeyErr?.message).not.toContain(dummyTestSecret);

      // Placeholder, empty, malformed Stripe secret keys rejected
      for (const badKey of ['', 'sk_test_placeholder', 'rk_live_1234567890abcdef', 'sk_live_short']) {
        expect(() =>
          validateStripeProductionConfig({
            NODE_ENV: 'production',
            STRIPE_SECRET_KEY: badKey,
            STRIPE_WEBHOOK_SECRET: dummyPlatWh,
            STRIPE_CONNECT_WEBHOOK_SECRET: dummyConnWh,
          })
        ).toThrow(/STRIPE_SECRET_KEY/i);
      }

      // Malformed / shared / placeholder webhook secrets rejected
      expect(() =>
        validateStripeWebhookProductionConfig({
          NODE_ENV: 'production',
          STRIPE_WEBHOOK_SECRET: 'not_a_whsec',
          STRIPE_CONNECT_WEBHOOK_SECRET: dummyConnWh,
        })
      ).toThrow(/whsec_/i);

      expect(() =>
        validateStripeWebhookProductionConfig({
          NODE_ENV: 'production',
          STRIPE_WEBHOOK_SECRET: dummyPlatWh,
          STRIPE_CONNECT_WEBHOOK_SECRET: dummyPlatWh,
        })
      ).toThrow(/distinct/i);

      // Development & test mode continue to allow test keys
      expect(() =>
        validateStripeProductionConfig({
          NODE_ENV: 'test',
          STRIPE_SECRET_KEY: 'sk_test_placeholder',
          STRIPE_WEBHOOK_SECRET: 'whsec_placeholder',
          STRIPE_CONNECT_WEBHOOK_SECRET: '',
        })
      ).not.toThrow();
    });
  });

  describe('2. Platform & Separate Connect Endpoints + Signature Verification', () => {
    it('verifies dedicated /api/webhooks/stripe/connect endpoint, enforces Connect scope, and rejects invalid/missing signatures', async () => {
      const platformSecret = 'whsec_stage5_platform_secret_key';
      const connectSecret = 'whsec_stage5_connect_secret_key';
      process.env.STRIPE_WEBHOOK_SECRET = platformSecret;
      process.env.STRIPE_CONNECT_WEBHOOK_SECRET = connectSecret;

      const connectEvtId = `evt_s5_conn_ep_${nanoid(8)}`;
      createdWebhookEventIds.push(connectEvtId);
      const connectPayload = JSON.stringify({
        id: connectEvtId,
        object: 'event',
        api_version: '2024-12-18.acacia',
        account: 'acct_s5_nonexistent',
        created: Math.floor(Date.now() / 1000),
        type: 'payout.canceled',
        data: {
          object: {
            id: `po_s5_unlinked_${nanoid(6)}`,
            object: 'payout',
            amount: 1000,
            currency: 'usd',
            status: 'canceled',
          },
        },
      });
      const connectSig = stripe.webhooks.generateTestHeaderString({
        payload: connectPayload,
        secret: connectSecret,
      });

      const validConnectRes = await request(app)
        .post('/api/webhooks/stripe/connect')
        .set('Content-Type', 'application/json')
        .set('stripe-signature', connectSig)
        .send(connectPayload);
      expect(validConnectRes.status).toBe(200);
      expect(validConnectRes.body.received).toBe(true);

      // Platform event sent to dedicated Connect endpoint must be rejected (400)
      const platformPayload = JSON.stringify({
        id: `evt_s5_plat_on_conn_${nanoid(8)}`,
        object: 'event',
        type: 'charge.updated',
        data: { object: { id: 'ch_ignored' } },
      });
      const platOnConnSig = stripe.webhooks.generateTestHeaderString({
        payload: platformPayload,
        secret: connectSecret,
      });
      const wrongScopeRes = await request(app)
        .post('/api/webhooks/stripe/connect')
        .set('Content-Type', 'application/json')
        .set('stripe-signature', platOnConnSig)
        .send(platformPayload);
      expect(wrongScopeRes.status).toBe(400);

      // Invalid signature on Connect endpoint returns 400
      const invalidSigRes = await request(app)
        .post('/api/webhooks/stripe/connect')
        .set('Content-Type', 'application/json')
        .set('stripe-signature', 't=123,v1=invalid_hmac')
        .send(connectPayload);
      expect(invalidSigRes.status).toBe(400);
    });
  });

  describe('3. Concurrent Duplicate Delivery, Checkout Session Events & Failure Retry Recovery', () => {
    it('handles concurrent duplicate payment_intent.succeeded deliveries cleanly under PostgreSQL locks', async () => {
      const { order, piId } = await createOrderScenario('conc_dup');
      const evt = trackEvt({
        id: `evt_s5_conc_${nanoid(8)}`,
        object: 'event',
        type: 'payment_intent.succeeded',
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            id: piId,
            object: 'payment_intent',
            status: 'succeeded',
            amount: order.totalInCents,
            currency: 'usd',
            metadata: { orderId: order.id },
          } as any,
        },
      } as any);

      const [r1, r2] = await Promise.all([
        processStripeWebhookEvent(evt),
        processStripeWebhookEvent(evt),
      ]);

      expect(r1.handled).toBe(true);
      expect(r2.handled).toBe(true);
      expect([Boolean(r1.duplicate), Boolean(r2.duplicate)]).toContain(true);

      const tickets = await prisma.ticket.findMany({ where: { orderId: order.id } });
      expect(tickets).toHaveLength(1);
      const ledgerPending = await prisma.financialLedgerEntry.findMany({
        where: { orderId: order.id, type: LedgerEntryType.TICKET_SALE_PENDING },
      });
      expect(ledgerPending).toHaveLength(1);
    });

    it('handles checkout.session.completed (with PaymentIntent retrieve outside tx) and checkout.session.expired safely', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock_stage5_key';

      // 1. checkout.session.completed fulfills PENDING order and survives retry on transient retrieval failure
      const s1 = await createOrderScenario('cs_comp');
      const evtId = `evt_s5_cs_comp_${nanoid(8)}`;
      const sessionCompletedEvent = {
        id: evtId,
        object: 'event',
        type: 'checkout.session.completed',
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            id: `cs_test_${nanoid(8)}`,
            object: 'checkout.session',
            payment_status: 'paid',
            payment_intent: s1.piId,
            amount_total: s1.order.totalInCents,
            currency: 'usd',
            metadata: { orderId: s1.order.id },
          } as any,
        },
      } as any;

      // Transient Stripe network outage -> MUST NOT write ProcessedWebhookEvent
      vi.spyOn(stripe.paymentIntents, 'retrieve').mockRejectedValueOnce(
        Object.assign(new Error('Stripe ECONNRESET'), { type: 'StripeConnectionError' })
      );
      await expect(processStripeWebhookEvent(sessionCompletedEvent)).rejects.toThrow(/ECONNRESET/);
      expect(
        await prisma.processedWebhookEvent.findUnique({ where: { eventId: evtId } })
      ).toBeNull();

      // Retry succeeds cleanly
      trackEvt(sessionCompletedEvent);
      vi.spyOn(stripe.paymentIntents, 'retrieve').mockResolvedValueOnce({
        id: s1.piId,
        status: 'succeeded',
        amount: s1.order.totalInCents,
        currency: 'usd',
        metadata: { orderId: s1.order.id },
      } as any);

      const okRes = await processStripeWebhookEvent(sessionCompletedEvent);
      expect(okRes).toEqual({ handled: true });
      const completedOrder = await prisma.order.findUniqueOrThrow({ where: { id: s1.order.id } });
      expect(completedOrder.status).toBe(OrderStatus.COMPLETED);

      // 2. checkout.session.expired cancels PENDING order and releases capacity
      const s2 = await createOrderScenario('cs_exp');
      const expiredEvt = trackEvt({
        id: `evt_s5_cs_exp_${nanoid(8)}`,
        object: 'event',
        type: 'checkout.session.expired',
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            id: `cs_exp_${nanoid(8)}`,
            object: 'checkout.session',
            payment_status: 'unpaid',
            payment_intent: s2.piId,
            amount_total: s2.order.totalInCents,
            currency: 'usd',
            metadata: { orderId: s2.order.id },
          } as any,
        },
      } as any);

      await processStripeWebhookEvent(expiredEvt);
      const cancelledOrder = await prisma.order.findUniqueOrThrow({ where: { id: s2.order.id } });
      const updatedTier = await prisma.ticketTier.findUniqueOrThrow({ where: { id: s2.tier.id } });
      expect(cancelledOrder.status).toBe(OrderStatus.CANCELLED);
      expect(updatedTier.reservedQuantity).toBe(0);
    });
  });

  describe('4. Late Dispute Charge Linkage & Payout Cancellation/Reconciliation Isolation', () => {
    it('resolves late dispute charge outside tx, fails retryably on transient Stripe outage, and links order on retry', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock_stage5_dispute';
      const { organizer, order, piId } = await createOrderScenario('dispute_late');

      await processStripeWebhookEvent(
        trackEvt({
          id: `evt_s5_pi_ok_${nanoid(8)}`,
          object: 'event',
          type: 'payment_intent.succeeded',
          created: Math.floor(Date.now() / 1000),
          data: {
            object: {
              id: piId,
              status: 'succeeded',
              amount: order.totalInCents,
              currency: 'usd',
              metadata: { orderId: order.id },
            } as any,
          },
        } as any)
      );

      const chargeId = `ch_late_disp_${nanoid(6)}`;
      const disputeEvt = {
        id: `evt_s5_disp_late_${nanoid(8)}`,
        object: 'event',
        type: 'charge.dispute.created',
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            id: `dp_s5_${nanoid(6)}`,
            object: 'dispute',
            charge: chargeId,
            amount: order.totalInCents,
            currency: 'usd',
            status: 'needs_response',
            reason: 'fraudulent',
          } as any,
        },
      } as any;

      // Transient API timeout retrieving unknown charge MUST throw before ProcessedWebhookEvent
      vi.spyOn(stripe.charges, 'retrieve').mockRejectedValueOnce(
        Object.assign(new Error('Stripe API timeout'), { type: 'StripeAPIError', statusCode: 503 })
      );
      await expect(processStripeWebhookEvent(disputeEvt)).rejects.toThrow(/timeout/);
      expect(
        await prisma.processedWebhookEvent.findUnique({ where: { eventId: disputeEvt.id } })
      ).toBeNull();

      // Retry retrieves charge outside tx, links Order, records DISPUTE_HOLD
      trackEvt(disputeEvt);
      vi.spyOn(stripe.charges, 'retrieve').mockResolvedValueOnce({
        id: chargeId,
        payment_intent: piId,
        metadata: { orderId: order.id },
      } as any);

      await processStripeWebhookEvent(disputeEvt);
      const updatedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(updatedOrder.stripeSettledChargeId).toBe(chargeId);
      const holdEntries = await prisma.financialLedgerEntry.findMany({
        where: { organizerId: organizer.id, orderId: order.id, type: LedgerEntryType.DISPUTE_HOLD },
      });
      expect(holdEntries).toHaveLength(1);
    }, 30_000);

    it('processes payout.canceled Connect webhook and reconciles delayed payout state via getConnectedAccountPayouts with organizer isolation', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock_stage5_payout';
      const sA = await createOrderScenario('conn_a');
      const sB = await createOrderScenario('conn_b');

      const payoutIdA = `po_s5_cancel_${nanoid(6)}`;
      createdPayoutIds.push(payoutIdA);

      // Connect payout.canceled persists CANCELLED solely for organizer A
      await processStripeWebhookEvent(
        trackEvt({
          id: `evt_s5_po_cancel_${nanoid(8)}`,
          object: 'event',
          account: sA.organizer.stripeAccountId!,
          type: 'payout.canceled',
          created: Math.floor(Date.now() / 1000),
          data: {
            object: {
              id: payoutIdA,
              object: 'payout',
              amount: 4500,
              currency: 'usd',
              status: 'canceled',
            } as any,
          },
        } as any)
      );

      const savedA = await prisma.connectedPayout.findUniqueOrThrow({
        where: { stripePayoutId: payoutIdA },
      });
      expect(savedA.organizerId).toBe(sA.organizer.id);
      expect(savedA.status).toBe(PayoutStatus.CANCELLED);

      // Delayed payout.paid missed by webhook is reconciled locally on getConnectedAccountPayouts(organizer B)
      const payoutIdB = `po_s5_sync_${nanoid(6)}`;
      createdPayoutIds.push(payoutIdB);
      vi.spyOn(stripe.payouts, 'list').mockResolvedValueOnce({
        object: 'list',
        data: [
          {
            id: payoutIdB,
            amount: 7200,
            currency: 'usd',
            status: 'paid',
            created: Math.floor(Date.now() / 1000),
            arrival_date: Math.floor(Date.now() / 1000) + 86400,
            destination: 'ba_mock_1',
          } as any,
        ],
      } as any);

      const listRes = await getConnectedAccountPayouts(sB.organizer.id, 10);
      expect(listRes.payouts).toHaveLength(1);
      expect(listRes.payouts[0].status).toBe('paid');

      const syncedB = await prisma.connectedPayout.findUniqueOrThrow({
        where: { stripePayoutId: payoutIdB },
      });
      expect(syncedB.organizerId).toBe(sB.organizer.id);
      expect(syncedB.status).toBe(PayoutStatus.PAID);
      expect(syncedB.amountInCents).toBe(7200);
    }, 30_000);
  });
});
