import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { nanoid } from 'nanoid';
import {
  EventStatus,
  OrderStatus,
  PaymentProvider,
  PaymentStatus,
  ReservationStatus,
  Role,
  TicketTierStatus,
} from '@prisma/client';
import { app } from '../app.js';
import { prisma } from '../db/prisma.js';
import { stripe } from '../lib/stripe.js';
import {
  calculateDisplayPriceFromGross,
  calculateGrossPriceFromDisplay,
  MIN_PAID_DISPLAY_PRICE_CENTS,
  STRIPE_MIN_USD_CHARGE_CENTS,
} from '../modules/checkout/checkout.financials.js';
import * as checkoutFinancials from '../modules/checkout/checkout.financials.js';
import { createTicketTierSchema } from '../modules/events/events.schema.js';
import { ticketTierInputSchema } from '../modules/organizer/organizer.schema.js';

describe('Stage 4 P0-02: Checkout Validation & Payment-Method Alignment — Integration & Schemas', () => {
  let organizerId: string;
  let publishedEventId: string;
  let oneCentPaidTierId: string;
  let standardPaidTierId: string;
  let freeTierId: string;

  const createdEventIds: string[] = [];
  const createdTierIds: string[] = [];

  beforeAll(async () => {
    const suffix = nanoid(8);
    const organizer = await prisma.user.create({
      data: {
        email: `p002_org_${suffix}@outside.vip`,
        name: 'P0-02 Test Organizer',
        role: Role.ORGANIZER,
        emailVerified: true,
        organizer: {
          create: {
            displayName: 'P0-02 Events Collective',
            slug: `p002-org-${suffix}`,
          },
        },
      },
    });
    organizerId = organizer.id;

    const now = Date.now();
    const event = await prisma.event.create({
      data: {
        slug: `p002-validation-${suffix}`,
        organizerId,
        title: 'P0-02 Checkout Validation Live',
        description: 'P0-02 integration suite',
        status: EventStatus.PUBLISHED,
        coverImageUrl: 'https://example.com/p002-cover.jpg',
        venueName: 'Main Room',
        venueAddress: '200 Congress Ave',
        city: 'Austin',
        country: 'US',
        startAt: new Date(now + 24 * 3600 * 1000),
        endAt: new Date(now + 30 * 3600 * 1000),
        timezone: 'America/Chicago',
      },
    });
    publishedEventId = event.id;
    createdEventIds.push(publishedEventId);

    const [oneCentTier, standardTier, freeTier] = await Promise.all([
      prisma.ticketTier.create({
        data: {
          eventId: publishedEventId,
          name: 'Penny Paid Tier',
          priceInCents: 1,
          currency: 'USD',
          totalCapacity: 50,
          minPerOrder: 1,
          maxPerOrder: 10,
          status: TicketTierStatus.ACTIVE,
        },
      }),
      prisma.ticketTier.create({
        data: {
          eventId: publishedEventId,
          name: 'Standard Paid Tier',
          priceInCents: 2000,
          currency: 'USD',
          totalCapacity: 50,
          minPerOrder: 1,
          maxPerOrder: 10,
          status: TicketTierStatus.ACTIVE,
        },
      }),
      prisma.ticketTier.create({
        data: {
          eventId: publishedEventId,
          name: 'Free Entry Tier',
          priceInCents: 0,
          currency: 'USD',
          totalCapacity: 50,
          minPerOrder: 1,
          maxPerOrder: 10,
          status: TicketTierStatus.ACTIVE,
        },
      }),
    ]);

    oneCentPaidTierId = oneCentTier.id;
    standardPaidTierId = standardTier.id;
    freeTierId = freeTier.id;
    createdTierIds.push(oneCentPaidTierId, standardPaidTierId, freeTierId);
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await prisma.order.deleteMany({
      where: { eventId: { in: createdEventIds } },
    });
    await prisma.ticketTier.deleteMany({
      where: { id: { in: createdTierIds } },
    });
    await prisma.event.deleteMany({
      where: { id: { in: createdEventIds } },
    });
    await prisma.user.deleteMany({
      where: { id: organizerId },
    });
  });

  describe('1. Tier Schema Minimum Paid Display Price & Contradictory Pricing Validation', () => {
    const baseEventTier = {
      name: 'GA Pass',
      currency: 'USD',
      totalCapacity: 100,
    };

    it('derives MIN_PAID_DISPLAY_PRICE_CENTS = 130 from the existing formula', () => {
      expect(calculateDisplayPriceFromGross(1)).toBe(130);
      expect(MIN_PAID_DISPLAY_PRICE_CENTS).toBe(130);
      expect(calculateGrossPriceFromDisplay(130)).toBe(1);
    });

    it.each([1, 50, 100, 128, 129])(
      'rejects displayPriceInCents=%i cents in both createTicketTierSchema and ticketTierInputSchema',
      (invalidDisplayCents) => {
        const resA = createTicketTierSchema.safeParse({
          ...baseEventTier,
          displayPriceInCents: invalidDisplayCents,
        });
        expect(resA.success).toBe(false);

        const resB = ticketTierInputSchema.safeParse({
          ...baseEventTier,
          displayPriceInCents: invalidDisplayCents,
        });
        expect(resB.success).toBe(false);
      }
    );

    it('preserves zero as a valid free-ticket price and resolves 130 cents to 1 cent gross', () => {
      for (const schema of [createTicketTierSchema, ticketTierInputSchema]) {
        const freeRes = schema.safeParse({
          ...baseEventTier,
          displayPriceInCents: 0,
        });
        expect(freeRes.success).toBe(true);
        if (freeRes.success) {
          expect(freeRes.data.priceInCents).toBe(0);
        }

        const minPaidRes = schema.safeParse({
          ...baseEventTier,
          displayPriceInCents: 130,
        });
        expect(minPaidRes.success).toBe(true);
        if (minPaidRes.success) {
          expect(minPaidRes.data.priceInCents).toBe(1);
        }
      }
    });

    it('rejects contradictory gross/display inputs such as { priceInCents: 0, displayPriceInCents: 2000 }', () => {
      for (const schema of [createTicketTierSchema, ticketTierInputSchema]) {
        const zeroVsPaid = schema.safeParse({
          ...baseEventTier,
          priceInCents: 0,
          displayPriceInCents: 2000,
        });
        expect(zeroVsPaid.success).toBe(false);

        const paidVsZero = schema.safeParse({
          ...baseEventTier,
          priceInCents: 2000,
          displayPriceInCents: 0,
        });
        expect(paidVsZero.success).toBe(false);

        const mismatchedFormula = schema.safeParse({
          ...baseEventTier,
          priceInCents: 2000,
          displayPriceInCents: 2000,
        });
        expect(mismatchedFormula.success).toBe(false);
      }
    });

    it('accepts matching gross and display inputs for both free and paid tiers', () => {
      for (const schema of [createTicketTierSchema, ticketTierInputSchema]) {
        const validFree = schema.safeParse({
          ...baseEventTier,
          priceInCents: 0,
          displayPriceInCents: 0,
        });
        expect(validFree.success).toBe(true);

        const validPaid = schema.safeParse({
          ...baseEventTier,
          priceInCents: 2000,
          displayPriceInCents: 2394,
        });
        expect(validPaid.success).toBe(true);
        if (validPaid.success) {
          expect(validPaid.data.priceInCents).toBe(2000);
        }

        const validMinPaid = schema.safeParse({
          ...baseEventTier,
          priceInCents: 1,
          displayPriceInCents: 130,
        });
        expect(validMinPaid.success).toBe(true);
        if (validMinPaid.success) {
          expect(validMinPaid.data.priceInCents).toBe(1);
        }
      }
    });
  });

  describe('2. Pre-Stripe Minimum Guard, Card-Only PaymentIntents, and P0-01 Separation', () => {
    it('rejects non-free USD totals below 50 cents before creating an order, reserving inventory, or calling Stripe', async () => {
      const piSpy = vi.spyOn(stripe.paymentIntents, 'create');
      vi.spyOn(checkoutFinancials, 'calculateCheckoutFeeBreakdown').mockReturnValueOnce({
        ticketSubtotalInCents: 20,
        totalTicketQuantity: 1,
        platformFeeInCents: 2,
        serviceFeeInCents: 0,
        preProcessingTotalInCents: 22,
        processingFeeInCents: 27,
        customerServiceFeeInCents: 29,
        buyerTotalInCents: STRIPE_MIN_USD_CHARGE_CENTS - 1,
        organizerEarningsInCents: 20,
        platformRevenueInCents: 2,
      });

      const idemKey = `p002_submin_${nanoid(8)}`;
      const tierBefore = await prisma.ticketTier.findUnique({ where: { id: oneCentPaidTierId } });

      const res = await request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: publishedEventId,
          items: [{ ticketTierId: oneCentPaidTierId, quantity: 1 }],
          customerEmail: 'submin@outside.vip',
          customerName: 'SubMin Buyer',
          customerPhone: '+15551112222',
          idempotencyKey: idemKey,
        });

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('PAYMENT_AMOUNT_BELOW_MINIMUM');
      expect(piSpy).not.toHaveBeenCalled();

      const createdOrder = await prisma.order.findUnique({
        where: { idempotencyKey: idemKey },
      });
      expect(createdOrder).toBeNull();

      const tierAfter = await prisma.ticketTier.findUnique({ where: { id: oneCentPaidTierId } });
      expect(tierAfter?.reservedQuantity).toBe(tierBefore?.reservedQuantity);
    });

    it('accepts 1-cent gross tickets ($1.30 buyer total) and creates PaymentIntent with card-only payment_method_types', async () => {
      let capturedPiArgs: any = null;
      const piSpy = vi.spyOn(stripe.paymentIntents, 'create').mockImplementationOnce((async (
        args: any
      ) => {
        capturedPiArgs = args;
        return {
          id: `pi_p002_cardonly_${nanoid(8)}`,
          client_secret: 'pi_p002_secret_cardonly',
          status: 'requires_payment_method',
        } as any;
      }) as any);

      const res = await request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: publishedEventId,
          items: [{ ticketTierId: oneCentPaidTierId, quantity: 1 }],
          customerEmail: 'penny@outside.vip',
          customerName: 'Penny Paid Buyer',
          customerPhone: '+15551113333',
          idempotencyKey: `p002_penny_${nanoid(8)}`,
        });

      expect(res.status).toBe(201);
      expect(res.body.data.isFreeOrder).toBe(false);
      expect(res.body.data.totalInCents).toBe(130);
      expect(res.body.data.currency).toBe('USD');
      expect(piSpy).toHaveBeenCalledTimes(1);
      expect(capturedPiArgs.amount).toBe(130);
      expect(capturedPiArgs.currency).toBe('usd');
      expect(capturedPiArgs.payment_method_types).toEqual(['card']);
      expect(capturedPiArgs.automatic_payment_methods).toBeUndefined();
    });

    it('keeps P0-01 free-ticket checkout completely Stripe-free and unchanged', async () => {
      const piSpy = vi.spyOn(stripe.paymentIntents, 'create');

      const res = await request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: publishedEventId,
          items: [{ ticketTierId: freeTierId, quantity: 2 }],
          customerEmail: 'p002free@outside.vip',
          customerName: 'Free Buyer',
          customerPhone: '+15551114444',
          idempotencyKey: `p002_free_${nanoid(8)}`,
        });

      expect(res.status).toBe(201);
      expect(res.body.data.isFreeOrder).toBe(true);
      expect(res.body.data.paymentProvider).toBe(PaymentProvider.FREE);
      expect(res.body.data.status).toBe(OrderStatus.COMPLETED);
      expect(res.body.data.clientSecret).toBeNull();
      expect(piSpy).not.toHaveBeenCalled();
    });
  });

  describe('3. Processing and Canceled Webhook & Reconciliation Lifecycle', () => {
    it('handles payment_intent.processing defensively without issuing tickets or ledger entries', async () => {
      const piId = `pi_proc_${nanoid(8)}`;
      const tierBefore = await prisma.ticketTier.findUnique({ where: { id: standardPaidTierId } });
      const order = await prisma.order.create({
        data: {
          orderNumber: `OUT-PROC-${Date.now()}`,
          eventId: publishedEventId,
          status: OrderStatus.PENDING,
          paymentReference: piId,
          customerEmail: 'proc@outside.vip',
          customerName: 'Processing Buyer',
          totalInCents: 2394,
          currency: 'USD',
          platformFeeInCents: 295,
          organizerNetInCents: 2000,
          idempotencyKey: `idem_proc_${nanoid(8)}`,
          orderAccessToken: `oat_proc_${nanoid(12)}`,
          expiresAt: new Date(Date.now() + 20 * 60 * 1000),
          items: {
            create: [
              {
                ticketTierId: standardPaidTierId,
                quantity: 1,
                unitPriceInCents: 2000,
                subtotalInCents: 2000,
              },
            ],
          },
          reservations: {
            create: [
              {
                ticketTierId: standardPaidTierId,
                quantity: 1,
                expiresAt: new Date(Date.now() + 20 * 60 * 1000),
                status: ReservationStatus.ACTIVE,
              },
            ],
          },
        },
      });
      await prisma.ticketTier.update({
        where: { id: standardPaidTierId },
        data: { reservedQuantity: { increment: 1 } },
      });

      const mockEvent = {
        id: `evt_proc_${nanoid(8)}`,
        type: 'payment_intent.processing',
        data: {
          object: {
            id: piId,
            status: 'processing',
            amount: 2394,
            currency: 'usd',
            metadata: { orderId: order.id },
          },
        },
      };
      vi.spyOn(stripe.webhooks, 'constructEvent').mockReturnValueOnce(mockEvent as any);

      const res = await request(app)
        .post('/api/webhooks/stripe')
        .set('stripe-signature', 'valid_sig')
        .send(mockEvent);

      expect(res.status).toBe(200);

      const reloaded = await prisma.order.findUnique({
        where: { id: order.id },
        include: { tickets: true, transactions: true, ledgerEntries: true },
      });
      expect(reloaded?.status).toBe(OrderStatus.PENDING);
      expect(reloaded?.tickets.length).toBe(0);
      expect(reloaded?.ledgerEntries.length).toBe(0);
      expect(reloaded?.transactions.some((t) => t.status === PaymentStatus.INITIATED)).toBe(true);

      // Clean up manual reservation increment so tier stays balanced
      await prisma.ticketTier.update({
        where: { id: standardPaidTierId },
        data: { reservedQuantity: tierBefore?.reservedQuantity ?? 0 },
      });
    });

    it('handles payment_intent.canceled by releasing reservations and cancelling PENDING order without marking REFUNDED', async () => {
      const piId = `pi_cancel_${nanoid(8)}`;
      const tierBefore = await prisma.ticketTier.findUnique({ where: { id: standardPaidTierId } });
      await prisma.ticketTier.update({
        where: { id: standardPaidTierId },
        data: { reservedQuantity: (tierBefore?.reservedQuantity ?? 0) + 2 },
      });

      const order = await prisma.order.create({
        data: {
          orderNumber: `OUT-CAN-${Date.now()}`,
          eventId: publishedEventId,
          status: OrderStatus.PENDING,
          paymentReference: piId,
          customerEmail: 'canceled@outside.vip',
          customerName: 'Canceled Buyer',
          totalInCents: 2394,
          currency: 'USD',
          platformFeeInCents: 295,
          organizerNetInCents: 2000,
          idempotencyKey: `idem_can_${nanoid(8)}`,
          orderAccessToken: `oat_can_${nanoid(12)}`,
          expiresAt: new Date(Date.now() + 20 * 60 * 1000),
          items: {
            create: [
              {
                ticketTierId: standardPaidTierId,
                quantity: 2,
                unitPriceInCents: 2000,
                subtotalInCents: 4000,
              },
            ],
          },
          reservations: {
            create: [
              {
                ticketTierId: standardPaidTierId,
                quantity: 2,
                expiresAt: new Date(Date.now() + 20 * 60 * 1000),
                status: ReservationStatus.ACTIVE,
              },
            ],
          },
        },
      });

      const mockEvent = {
        id: `evt_can_${nanoid(8)}`,
        type: 'payment_intent.canceled',
        data: {
          object: {
            id: piId,
            status: 'canceled',
            cancellation_reason: 'abandoned',
            amount: 2394,
            currency: 'usd',
            metadata: { orderId: order.id },
          },
        },
      };
      vi.spyOn(stripe.webhooks, 'constructEvent').mockReturnValueOnce(mockEvent as any);

      const res = await request(app)
        .post('/api/webhooks/stripe')
        .set('stripe-signature', 'valid_sig')
        .send(mockEvent);

      expect(res.status).toBe(200);

      const reloaded = await prisma.order.findUnique({
        where: { id: order.id },
        include: { reservations: true, tickets: true, transactions: true, refunds: true },
      });
      expect(reloaded?.status).toBe(OrderStatus.CANCELLED);
      expect(reloaded?.tickets.length).toBe(0);
      expect(reloaded?.refunds).toEqual([]);
      expect(reloaded?.reservations.every((r) => r.status === ReservationStatus.RELEASED)).toBe(true);
      expect(reloaded?.transactions.some((t) => t.status === PaymentStatus.FAILED)).toBe(true);
      expect(reloaded?.transactions.some((t) => t.status === PaymentStatus.REFUNDED)).toBe(false);

      const tierAfter = await prisma.ticketTier.findUnique({ where: { id: standardPaidTierId } });
      expect(tierAfter?.reservedQuantity).toBe(tierBefore?.reservedQuantity ?? 0);
    });

    it('preserves EXPIRED order status across payment_intent.canceled so P2-04 late-payment policy stays intact', async () => {
      const piId = `pi_exp_can_${nanoid(8)}`;
      const order = await prisma.order.create({
        data: {
          orderNumber: `OUT-EXPCAN-${Date.now()}`,
          eventId: publishedEventId,
          status: OrderStatus.EXPIRED,
          paymentReference: piId,
          customerEmail: 'expired@outside.vip',
          customerName: 'Expired Buyer',
          totalInCents: 2394,
          currency: 'USD',
          idempotencyKey: `idem_expcan_${nanoid(8)}`,
          expiresAt: new Date(Date.now() - 60 * 1000),
          items: {
            create: [
              {
                ticketTierId: standardPaidTierId,
                quantity: 1,
                unitPriceInCents: 2000,
                subtotalInCents: 2000,
              },
            ],
          },
          reservations: {
            create: [
              {
                ticketTierId: standardPaidTierId,
                quantity: 1,
                expiresAt: new Date(Date.now() - 60 * 1000),
                status: ReservationStatus.RELEASED,
              },
            ],
          },
        },
      });

      const mockEvent = {
        id: `evt_expcan_${nanoid(8)}`,
        type: 'payment_intent.canceled',
        data: {
          object: {
            id: piId,
            status: 'canceled',
            amount: 2394,
            currency: 'usd',
            metadata: { orderId: order.id },
          },
        },
      };
      vi.spyOn(stripe.webhooks, 'constructEvent').mockReturnValueOnce(mockEvent as any);

      const res = await request(app)
        .post('/api/webhooks/stripe')
        .set('stripe-signature', 'valid_sig')
        .send(mockEvent);

      expect(res.status).toBe(200);
      const reloaded = await prisma.order.findUnique({ where: { id: order.id } });
      expect(reloaded?.status).toBe(OrderStatus.EXPIRED);
    });

    it('does not claim cancellation when order lookup sees Stripe status=processing', async () => {
      const piId = `pi_order_proc_${nanoid(8)}`;
      const accessToken = `oat_proc_get_${nanoid(12)}`;
      const order = await prisma.order.create({
        data: {
          orderNumber: `OUT-GETPROC-${Date.now()}`,
          eventId: publishedEventId,
          status: OrderStatus.PENDING,
          paymentReference: piId,
          customerEmail: 'getproc@outside.vip',
          customerName: 'GetProc Buyer',
          totalInCents: 2394,
          currency: 'USD',
          idempotencyKey: `idem_getproc_${nanoid(8)}`,
          orderAccessToken: accessToken,
          expiresAt: new Date(Date.now() + 20 * 60 * 1000),
        },
      });

      vi.spyOn(stripe.paymentIntents, 'retrieve').mockResolvedValueOnce({
        id: piId,
        status: 'processing',
      } as any);

      const res = await request(app)
        .get(`/api/orders/${order.orderNumber}?token=${encodeURIComponent(accessToken)}`);

      expect(res.status).toBe(200);
      expect(res.body.data.order.status).toBe(OrderStatus.PENDING);
    });
  });

  describe('4. Canceled, Mismatched, Transient-Error, and Reusable Idempotency Replay', () => {
    it('fast-path replay rejects a canceled PaymentIntent with 409 without creating a duplicate order or PaymentIntent', async () => {
      const piId = `pi_replay_can_${nanoid(8)}`;
      const idemKey = `idem_replay_can_${nanoid(8)}`;
      await prisma.order.create({
        data: {
          orderNumber: `OUT-REPCAN-${Date.now()}`,
          eventId: publishedEventId,
          status: OrderStatus.PENDING,
          paymentReference: piId,
          customerEmail: 'repcan@outside.vip',
          customerName: 'RepCan Buyer',
          totalInCents: 2394,
          currency: 'USD',
          idempotencyKey: idemKey,
          orderAccessToken: `oat_repcan_${nanoid(12)}`,
          expiresAt: new Date(Date.now() + 20 * 60 * 1000),
          items: {
            create: [
              {
                ticketTierId: standardPaidTierId,
                quantity: 1,
                unitPriceInCents: 2000,
                subtotalInCents: 2000,
              },
            ],
          },
        },
      });

      const retrieveSpy = vi.spyOn(stripe.paymentIntents, 'retrieve').mockResolvedValueOnce({
        id: piId,
        status: 'canceled',
        client_secret: 'pi_canceled_secret_should_never_return',
      } as any);
      const createSpy = vi.spyOn(stripe.paymentIntents, 'create');

      const res = await request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: publishedEventId,
          items: [{ ticketTierId: standardPaidTierId, quantity: 1 }],
          customerEmail: 'repcan@outside.vip',
          customerName: 'RepCan Buyer',
          customerPhone: '+15551115555',
          idempotencyKey: idemKey,
        });

      expect(res.status).toBe(409);
      expect(res.body.error?.code).toBe('PAYMENT_SESSION_CANCELED');
      expect(res.body.data).toBeUndefined();
      expect(retrieveSpy).toHaveBeenCalledTimes(1);
      expect(createSpy).not.toHaveBeenCalled();

      const ordersWithKey = await prisma.order.findMany({ where: { idempotencyKey: idemKey } });
      expect(ordersWithKey).toHaveLength(1);
    });

    it('P2002 concurrent-replay fallback rejects a canceled PaymentIntent without returning its client secret or duplicating order', async () => {
      const piId = `pi_p2002_can_${nanoid(8)}`;
      const idemKey = `idem_p2002_can_${nanoid(8)}`;
      await prisma.order.create({
        data: {
          orderNumber: `OUT-P2002CAN-${Date.now()}`,
          eventId: publishedEventId,
          status: OrderStatus.PENDING,
          paymentReference: piId,
          customerEmail: 'p2002can@outside.vip',
          customerName: 'P2002 Can Buyer',
          totalInCents: 2394,
          currency: 'USD',
          idempotencyKey: idemKey,
          orderAccessToken: `oat_p2002can_${nanoid(12)}`,
          expiresAt: new Date(Date.now() + 20 * 60 * 1000),
          items: {
            create: [
              {
                ticketTierId: standardPaidTierId,
                quantity: 1,
                unitPriceInCents: 2000,
                subtotalInCents: 2000,
              },
            ],
          },
        },
      });

      // Simulate race: pre-transaction findUnique sees null, tx hits real PostgreSQL P2002,
      // and catch block reloads concurrentOrder from DB and retrieves canceled PI.
      const origFindUnique = prisma.order.findUnique;
      let bypassedPrecheck = false;
      (prisma.order as any).findUnique = ((args: any) => {
        if (!bypassedPrecheck && args?.where?.idempotencyKey === idemKey) {
          bypassedPrecheck = true;
          return Promise.resolve(null);
        }
        return origFindUnique.call(prisma.order, args);
      }) as any;

      const retrieveSpy = vi.spyOn(stripe.paymentIntents, 'retrieve').mockResolvedValueOnce({
        id: piId,
        status: 'canceled',
        client_secret: 'pi_concurrent_canceled_secret',
      } as any);
      const createSpy = vi.spyOn(stripe.paymentIntents, 'create');

      try {
        const res = await request(app)
          .post('/api/checkout/create-session')
          .send({
            eventId: publishedEventId,
            items: [{ ticketTierId: standardPaidTierId, quantity: 1 }],
            customerEmail: 'p2002can@outside.vip',
            customerName: 'P2002 Can Buyer',
            customerPhone: '+15551116666',
            idempotencyKey: idemKey,
          });

        expect(res.status).toBe(409);
        expect(res.body.error?.code).toBe('PAYMENT_SESSION_CANCELED');
        expect(res.body.data).toBeUndefined();
        expect(retrieveSpy).toHaveBeenCalledTimes(1);
        expect(createSpy).not.toHaveBeenCalled();

        const ordersWithKey = await prisma.order.findMany({ where: { idempotencyKey: idemKey } });
        expect(ordersWithKey).toHaveLength(1);
      } finally {
        (prisma.order as any).findUnique = origFindUnique;
      }
    });

    it('rejects replay with mismatched payload (different email/quantity) before touching Stripe', async () => {
      const piId = `pi_mismatch_rep_${nanoid(8)}`;
      const idemKey = `idem_mismatch_rep_${nanoid(8)}`;
      await prisma.order.create({
        data: {
          orderNumber: `OUT-MISREP-${Date.now()}`,
          eventId: publishedEventId,
          status: OrderStatus.PENDING,
          paymentReference: piId,
          customerEmail: 'original@outside.vip',
          customerName: 'Original Buyer',
          totalInCents: 2394,
          currency: 'USD',
          idempotencyKey: idemKey,
          orderAccessToken: `oat_misrep_${nanoid(12)}`,
          expiresAt: new Date(Date.now() + 20 * 60 * 1000),
          items: {
            create: [
              {
                ticketTierId: standardPaidTierId,
                quantity: 1,
                unitPriceInCents: 2000,
                subtotalInCents: 2000,
              },
            ],
          },
        },
      });

      const retrieveSpy = vi.spyOn(stripe.paymentIntents, 'retrieve');
      const createSpy = vi.spyOn(stripe.paymentIntents, 'create');

      const res = await request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: publishedEventId,
          items: [{ ticketTierId: standardPaidTierId, quantity: 1 }],
          customerEmail: 'different@outside.vip',
          customerName: 'Different Buyer',
          customerPhone: '+15551117777',
          idempotencyKey: idemKey,
        });

      expect(res.status).toBe(409);
      expect(res.body.error?.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
      expect(retrieveSpy).not.toHaveBeenCalled();
      expect(createSpy).not.toHaveBeenCalled();
    });

    it('replays a valid reusable PaymentIntent cleanly without creating a second order or PaymentIntent', async () => {
      const piId = `pi_reusable_${nanoid(8)}`;
      const idemKey = `idem_reusable_${nanoid(8)}`;
      const created = await prisma.order.create({
        data: {
          orderNumber: `OUT-REUSE-${Date.now()}`,
          eventId: publishedEventId,
          status: OrderStatus.PENDING,
          paymentReference: piId,
          customerEmail: 'reuse@outside.vip',
          customerName: 'Reusable Buyer',
          totalInCents: 2394,
          currency: 'USD',
          idempotencyKey: idemKey,
          orderAccessToken: `oat_reuse_${nanoid(12)}`,
          expiresAt: new Date(Date.now() + 20 * 60 * 1000),
          items: {
            create: [
              {
                ticketTierId: standardPaidTierId,
                quantity: 1,
                unitPriceInCents: 2000,
                subtotalInCents: 2000,
              },
            ],
          },
        },
      });

      const retrieveSpy = vi.spyOn(stripe.paymentIntents, 'retrieve').mockResolvedValueOnce({
        id: piId,
        status: 'requires_payment_method',
        client_secret: 'pi_reusable_secret_ok',
      } as any);
      const createSpy = vi.spyOn(stripe.paymentIntents, 'create');

      const res = await request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: publishedEventId,
          items: [{ ticketTierId: standardPaidTierId, quantity: 1 }],
          customerEmail: 'reuse@outside.vip',
          customerName: 'Reusable Buyer',
          customerPhone: '+15551118888',
          idempotencyKey: idemKey,
        });

      expect(res.status).toBe(201);
      expect(res.body.data.orderNumber).toBe(created.orderNumber);
      expect(res.body.data.clientSecret).toBe('pi_reusable_secret_ok');
      expect(retrieveSpy).toHaveBeenCalledTimes(1);
      expect(createSpy).not.toHaveBeenCalled();
    });

    it('handles Stripe retrieval failure transiently without marking canceled or creating duplicate orders', async () => {
      const piId = `pi_retrieve_err_${nanoid(8)}`;
      const idemKey = `idem_retrieve_err_${nanoid(8)}`;
      const order = await prisma.order.create({
        data: {
          orderNumber: `OUT-RETERR-${Date.now()}`,
          eventId: publishedEventId,
          status: OrderStatus.PENDING,
          paymentReference: piId,
          customerEmail: 'reterr@outside.vip',
          customerName: 'RetErr Buyer',
          totalInCents: 2394,
          currency: 'USD',
          idempotencyKey: idemKey,
          orderAccessToken: `oat_reterr_${nanoid(12)}`,
          expiresAt: new Date(Date.now() + 20 * 60 * 1000),
          items: {
            create: [
              {
                ticketTierId: standardPaidTierId,
                quantity: 1,
                unitPriceInCents: 2000,
                subtotalInCents: 2000,
              },
            ],
          },
        },
      });

      vi.spyOn(stripe.paymentIntents, 'retrieve').mockRejectedValueOnce(
        new Error('Stripe API transient timeout')
      );
      const createSpy = vi.spyOn(stripe.paymentIntents, 'create');

      const res = await request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: publishedEventId,
          items: [{ ticketTierId: standardPaidTierId, quantity: 1 }],
          customerEmail: 'reterr@outside.vip',
          customerName: 'RetErr Buyer',
          customerPhone: '+15551119999',
          idempotencyKey: idemKey,
        });

      expect(res.status).toBe(503);
      expect(res.body.error?.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
      expect(createSpy).not.toHaveBeenCalled();

      const reloaded = await prisma.order.findMany({ where: { idempotencyKey: idemKey } });
      expect(reloaded).toHaveLength(1);
      expect(reloaded[0].id).toBe(order.id);
      expect(reloaded[0].status).toBe(OrderStatus.PENDING);
    });
  });
});
