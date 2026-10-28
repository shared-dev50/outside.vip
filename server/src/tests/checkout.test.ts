import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { prisma } from '../db/prisma.js';
import { stripe } from '../lib/stripe.js';
import {
  calculateFinancialBreakdown,
  calculateCheckoutFeeBreakdown,
} from '../modules/checkout/checkout.financials.js';
import { releaseExpiredReservations } from '../modules/checkout/checkout.service.js';
import { EventStatus, OrderStatus, ReservationStatus, TicketStatus, TicketTierStatus } from '@prisma/client';

describe('Outside.vip Checkout, Atomic Reservations & Payments API', () => {
  let publishedEventId: string;
  let activeTierId: string;
  let limitedTierId: string;
  let attendeeUser: any;

  beforeAll(async () => {
    // Ensure we have a published active event with known active ticket tiers
    let event = await prisma.event.findFirst({
      where: {
        status: EventStatus.PUBLISHED,
        endAt: { gt: new Date() },
      },
      include: {
        ticketTiers: true,
      },
    });

    if (!event) {
      event = await prisma.event.findFirst({
        where: {
          status: EventStatus.PUBLISHED,
        },
        include: {
          ticketTiers: true,
        },
      });
    }

    if (!event) {
      throw new Error('Test baseline requires a published event with ticket tiers');
    }

    publishedEventId = event.id;
    const activeTier = event.ticketTiers.find((t) => t.status === TicketTierStatus.ACTIVE && t.totalCapacity > 100);
    if (!activeTier) {
      throw new Error('Active ticket tier not found on seeded event');
    }
    activeTierId = activeTier.id;

    // Create a temporary limited capacity tier for concurrency tests
    const limitedTier = await prisma.ticketTier.create({
      data: {
        eventId: publishedEventId,
        name: `Test Limited Pass ${Date.now()}`,
        priceInCents: 4500,
        currency: 'USD',
        totalCapacity: 2,
        reservedQuantity: 0,
        soldQuantity: 0,
        minPerOrder: 1,
        maxPerOrder: 2,
        status: TicketTierStatus.ACTIVE,
      },
    });
    limitedTierId = limitedTier.id;

    attendeeUser = await prisma.user.findUnique({
      where: { email: 'alex@outside.vip' },
    });
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('1. Financial Breakdown & Commission Calculations', () => {
    it('calculates 5% platform fee and organizer net correctly with integer cents', () => {
      // $100.00 -> $5.00 fee, $95.00 organizer
      const breakdown1 = calculateFinancialBreakdown(10000, 5);
      expect(breakdown1.platformFeeInCents).toBe(500);
      expect(breakdown1.organizerNetInCents).toBe(9500);
      expect(breakdown1.platformFeeInCents + breakdown1.organizerNetInCents).toBe(10000);

      // $47.33 (4733 cents) -> 5% = 236.65 -> 237 cents fee, 4496 cents organizer
      const breakdown2 = calculateFinancialBreakdown(4733, 5);
      expect(breakdown2.platformFeeInCents).toBe(237);
      expect(breakdown2.organizerNetInCents).toBe(4496);
      expect(breakdown2.platformFeeInCents + breakdown2.organizerNetInCents).toBe(4733);
    });

    it('rejects negative amounts or invalid commission percentages', () => {
      expect(() => calculateFinancialBreakdown(-100)).toThrow('cannot be negative');
      expect(() => calculateFinancialBreakdown(1000, -1)).toThrow('between 0 and 100');
      expect(() => calculateFinancialBreakdown(1000, 105)).toThrow('between 0 and 100');
    });
  });

  describe('2. POST /api/checkout/create-session - PaymentIntent Creation & Validation', () => {
    it('rejects checkout with missing customer email or invalid input', async () => {
      const res = await request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: publishedEventId,
          items: [{ ticketTierId: activeTierId, quantity: 1 }],
          customerEmail: 'not-an-email',
          customerName: '',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toBe('Validation failed');
    });

    it('rejects checkout for a nonexistent or unpublished event', async () => {
      const res = await request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: '00000000-0000-0000-0000-000000000000',
          items: [{ ticketTierId: activeTierId, quantity: 1 }],
          customerEmail: 'buyer@outside.vip',
          customerName: 'Test Buyer',
        });

      expect(res.status).toBe(404);
      expect(res.body.error.message).toContain('Event not found');
    });

    it('rejects checkout when ticket tier does not belong to the specified event', async () => {
      const otherTier = await prisma.ticketTier.findFirst({
        where: { eventId: { not: publishedEventId } },
      });

      if (!otherTier) return;

      const res = await request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: publishedEventId,
          items: [{ ticketTierId: otherTier.id, quantity: 1 }],
          customerEmail: 'buyer@outside.vip',
          customerName: 'Test Buyer',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('do not belong to this event');
    });

    it('rejects checkout exceeding remaining capacity with 409 Conflict', async () => {
      const res = await request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: publishedEventId,
          items: [{ ticketTierId: limitedTierId, quantity: 3 }],
          customerEmail: 'greedy@outside.vip',
          customerName: 'Greedy Buyer',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('Maximum purchase');
    });

    it('creates PaymentIntent, order, reservations, and returns clientSecret on success', async () => {
      const mockPaymentIntentId = `pi_test_${Date.now()}`;
      const mockClientSecret = `${mockPaymentIntentId}_secret_xyz`;

      const stripeSpy = vi.spyOn(stripe.paymentIntents, 'create').mockResolvedValueOnce({
        id: mockPaymentIntentId,
        client_secret: mockClientSecret,
        amount: 10000,
        currency: 'usd',
        status: 'requires_payment_method',
      } as any);

      const res = await request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: publishedEventId,
          items: [{ ticketTierId: activeTierId, quantity: 2 }],
          customerEmail: 'valid_buyer@outside.vip',
          customerName: 'Valid Buyer',
          customerPhone: '+254700000000',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.clientSecret).toBe(mockClientSecret);
      expect(res.body.data).toHaveProperty('orderNumber');
      expect(res.body.data).toHaveProperty('orderAccessToken');
      expect(res.body.data.orderAccessToken).toMatch(/^oat_/);
      expect(res.body.data.currency).toBe('USD');

      // Verify PaymentIntent creation payload sent to Stripe
      expect(stripeSpy).toHaveBeenCalled();
      const createPayload = stripeSpy.mock.calls[0][0];
      expect(createPayload.amount).toBe(res.body.data.totalInCents);
      expect(createPayload.currency).toBe('usd');
      expect(createPayload.metadata.orderNumber).toBe(res.body.data.orderNumber);

      // Verify order record in DB
      const dbOrder = await prisma.order.findUnique({
        where: { orderNumber: res.body.data.orderNumber },
        include: { items: true, reservations: true },
      });

      expect(dbOrder).toBeDefined();
      expect(dbOrder?.status).toBe(OrderStatus.PENDING);
      expect(dbOrder?.paymentReference).toBe(mockPaymentIntentId);
      expect(dbOrder?.platformFeeInCents).toBeGreaterThan(0);
      expect(dbOrder?.organizerNetInCents).toBeGreaterThan(0);
      expect(dbOrder?.platformFeeInCents! + dbOrder?.organizerNetInCents!).toBe(dbOrder?.totalInCents);
      expect(dbOrder?.reservations.length).toBe(1);
      expect(dbOrder?.reservations[0].status).toBe(ReservationStatus.ACTIVE);

      stripeSpy.mockRestore();
    });

    it('verifies exact agreement between buyer total, breakdown, and Stripe PaymentIntent amount for 1 and multiple tickets', async () => {
      const tier = await prisma.ticketTier.findUnique({ where: { id: activeTierId } });
      const price = tier!.priceInCents;

      // 1. Single ticket test
      const singleExpected = calculateCheckoutFeeBreakdown(price, 1);
      const mockPiSingle = `pi_single_${Date.now()}`;
      const spySingle = vi.spyOn(stripe.paymentIntents, 'create').mockResolvedValueOnce({
        id: mockPiSingle,
        client_secret: `${mockPiSingle}_secret`,
        amount: singleExpected.buyerTotalInCents,
        currency: 'usd',
      } as any);

      const resSingle = await request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: publishedEventId,
          items: [{ ticketTierId: activeTierId, quantity: 1 }],
          customerEmail: 'single_buyer@outside.vip',
          customerName: 'Single Buyer',
        });

      expect(resSingle.status).toBe(201);
      expect(resSingle.body.data.totalInCents).toBe(singleExpected.buyerTotalInCents);
      expect(resSingle.body.data.breakdown).toBeDefined();
      expect(resSingle.body.data.breakdown.ticketSubtotalInCents).toBe(singleExpected.ticketSubtotalInCents);
      expect(resSingle.body.data.breakdown.platformFeeInCents).toBe(singleExpected.platformFeeInCents);
      expect(resSingle.body.data.breakdown.serviceFeeInCents).toBe(singleExpected.serviceFeeInCents);
      expect(resSingle.body.data.breakdown.processingFeeInCents).toBe(singleExpected.processingFeeInCents);
      expect(resSingle.body.data.breakdown.buyerTotalInCents).toBe(singleExpected.buyerTotalInCents);
      expect(spySingle.mock.calls[0][0].amount).toBe(singleExpected.buyerTotalInCents);
      spySingle.mockRestore();

      // 2. Multiple tickets test (2 tickets)
      const multiExpected = calculateCheckoutFeeBreakdown(price * 2, 2);
      const mockPiMulti = `pi_multi_${Date.now()}`;
      const spyMulti = vi.spyOn(stripe.paymentIntents, 'create').mockResolvedValueOnce({
        id: mockPiMulti,
        client_secret: `${mockPiMulti}_secret`,
        amount: multiExpected.buyerTotalInCents,
        currency: 'usd',
      } as any);

      const resMulti = await request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: publishedEventId,
          items: [{ ticketTierId: activeTierId, quantity: 2 }],
          customerEmail: 'multi_buyer@outside.vip',
          customerName: 'Multi Buyer',
        });

      expect(resMulti.status).toBe(201);
      expect(resMulti.body.data.totalInCents).toBe(multiExpected.buyerTotalInCents);
      expect(resMulti.body.data.breakdown.ticketSubtotalInCents).toBe(multiExpected.ticketSubtotalInCents);
      expect(resMulti.body.data.breakdown.platformFeeInCents).toBe(multiExpected.platformFeeInCents);
      expect(resMulti.body.data.breakdown.serviceFeeInCents).toBe(multiExpected.serviceFeeInCents);
      expect(resMulti.body.data.breakdown.processingFeeInCents).toBe(multiExpected.processingFeeInCents);
      expect(resMulti.body.data.breakdown.buyerTotalInCents).toBe(multiExpected.buyerTotalInCents);
      expect(spyMulti.mock.calls[0][0].amount).toBe(multiExpected.buyerTotalInCents);
      spyMulti.mockRestore();
    });

    it('idempotency: returns existing pending order and PaymentIntent clientSecret on duplicate submission', async () => {
      const idempotencyKey = `idem_dup_test_${Date.now()}`;
      const mockPaymentIntentId = `pi_dup_${Date.now()}`;
      const mockClientSecret = `${mockPaymentIntentId}_secret_dup`;

      const createSpy = vi.spyOn(stripe.paymentIntents, 'create').mockResolvedValueOnce({
        id: mockPaymentIntentId,
        client_secret: mockClientSecret,
        amount: 5000,
        currency: 'usd',
      } as any);

      // First submission
      const res1 = await request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: publishedEventId,
          items: [{ ticketTierId: activeTierId, quantity: 1 }],
          customerEmail: 'dup_buyer@outside.vip',
          customerName: 'Dup Buyer',
          idempotencyKey,
        });

      expect(res1.status).toBe(201);
      const firstOrderNumber = res1.body.data.orderNumber;

      // Second duplicate submission with same idempotencyKey
      const retrieveSpy = vi.spyOn(stripe.paymentIntents, 'retrieve').mockResolvedValueOnce({
        id: mockPaymentIntentId,
        client_secret: mockClientSecret,
        amount: 5000,
        currency: 'usd',
      } as any);

      const res2 = await request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: publishedEventId,
          items: [{ ticketTierId: activeTierId, quantity: 1 }],
          customerEmail: 'dup_buyer@outside.vip',
          customerName: 'Dup Buyer',
          idempotencyKey,
        });

      expect(res2.status).toBe(201);
      expect(res2.body.data.orderNumber).toBe(firstOrderNumber);
      expect(res2.body.data.clientSecret).toBe(mockClientSecret);
      expect(res2.body.data.breakdown).toBeDefined();
      expect(res2.body.data.breakdown.ticketSubtotalInCents).toBeGreaterThan(0);
      expect(res2.body.data.breakdown.buyerTotalInCents).toBe(res2.body.data.totalInCents);

      createSpy.mockRestore();
      retrieveSpy.mockRestore();
    });

    it('rolls back reservation cleanly when PaymentIntent creation fails', async () => {
      const stripeSpy = vi.spyOn(stripe.paymentIntents, 'create').mockRejectedValueOnce(
        new Error('Stripe API network timeout')
      );

      const tierBefore = await prisma.ticketTier.findUnique({ where: { id: activeTierId } });
      const initialReserved = tierBefore?.reservedQuantity || 0;

      const res = await request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: publishedEventId,
          items: [{ ticketTierId: activeTierId, quantity: 2 }],
          customerEmail: 'rollback_test@outside.vip',
          customerName: 'Rollback Buyer',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('Payment provider session creation failed');

      // Verify stock was restored
      const tierAfter = await prisma.ticketTier.findUnique({ where: { id: activeTierId } });
      expect(tierAfter?.reservedQuantity).toBe(initialReserved);

      stripeSpy.mockRestore();
    });
  });

  describe('3. POST /api/webhooks/stripe - Signature Verification & PaymentIntent Fulfillment', () => {
    it('rejects webhooks without valid Stripe signature with 400', async () => {
      const res = await request(app)
        .post('/api/webhooks/stripe')
        .set('stripe-signature', 'invalid_signature_mock')
        .send({ id: 'evt_fake_test' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('signature verification failed');
    });

    it('fulfills order on payment_intent.succeeded with status=succeeded', async () => {
      const orderAccessToken = `oat_test_wh_${Date.now()}`;
      const mockPaymentIntentId = `pi_test_wh_${Date.now()}`;

      const order = await prisma.order.create({
        data: {
          orderNumber: `OUT-TEST-WH-${Date.now()}`,
          eventId: publishedEventId,
          status: OrderStatus.PENDING,
          customerEmail: 'wh_attendee@outside.vip',
          customerName: 'Webhook Attendee',
          totalInCents: 10000,
          currency: 'USD',
          platformFeeInCents: 500,
          organizerNetInCents: 9500,
          orderAccessToken,
          paymentReference: mockPaymentIntentId,
          idempotencyKey: `idem_wh_test_${Date.now()}`,
          expiresAt: new Date(Date.now() + 15 * 60 * 1000),
          items: {
            create: [
              {
                ticketTierId: activeTierId,
                quantity: 2,
                unitPriceInCents: 5000,
                subtotalInCents: 10000,
              },
            ],
          },
          reservations: {
            create: [
              {
                ticketTierId: activeTierId,
                quantity: 2,
                expiresAt: new Date(Date.now() + 15 * 60 * 1000),
                status: ReservationStatus.ACTIVE,
              },
            ],
          },
        },
      });

      await prisma.ticketTier.update({
        where: { id: activeTierId },
        data: { reservedQuantity: { increment: 2 } },
      });

      const tierBefore = await prisma.ticketTier.findUnique({ where: { id: activeTierId } });
      const initialSold = tierBefore?.soldQuantity || 0;
      const initialReserved = tierBefore?.reservedQuantity || 0;

      const eventId = `evt_test_${Date.now()}`;
      const mockEvent = {
        id: eventId,
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: mockPaymentIntentId,
            status: 'succeeded',
            amount: 10000,
            currency: 'usd',
            metadata: {
              orderId: order.id,
              orderNumber: order.orderNumber,
            },
          },
        },
      };

      const constructSpy = vi.spyOn(stripe.webhooks, 'constructEvent').mockReturnValueOnce(mockEvent as any);

      const res = await request(app)
        .post('/api/webhooks/stripe')
        .set('stripe-signature', 'valid_test_signature')
        .send(mockEvent);

      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);

      // Verify order transitioned to COMPLETED
      const updatedOrder = await prisma.order.findUnique({
        where: { id: order.id },
        include: { tickets: true, reservations: true, transactions: true },
      });

      expect(updatedOrder?.status).toBe(OrderStatus.COMPLETED);
      expect(updatedOrder?.reservations[0].status).toBe(ReservationStatus.CONFIRMED);

      // Verify 2 tickets issued with cryptographic unguessable tokens
      expect(updatedOrder?.tickets.length).toBe(2);
      for (const tkt of updatedOrder?.tickets || []) {
        expect(tkt.status).toBe(TicketStatus.ISSUED);
        expect(tkt.ticketToken).toMatch(/^tkt_sec_/);
        expect(tkt.attendeeEmail).toBe('wh_attendee@outside.vip');
      }

      // Verify stock shifts: reserved decremented by 2, sold incremented by 2
      const tierAfter = await prisma.ticketTier.findUnique({ where: { id: activeTierId } });
      expect(tierAfter?.reservedQuantity).toBe(initialReserved - 2);
      expect(tierAfter?.soldQuantity).toBe(initialSold + 2);

      // Verify PaymentTransaction created
      expect(updatedOrder?.transactions.length).toBe(1);
      expect(updatedOrder?.transactions[0].status).toBe('SUCCEEDED');

      // Webhook Idempotency Check: send the same event again
      const constructSpy2 = vi.spyOn(stripe.webhooks, 'constructEvent').mockReturnValueOnce(mockEvent as any);

      const resDuplicate = await request(app)
        .post('/api/webhooks/stripe')
        .set('stripe-signature', 'valid_test_signature')
        .send(mockEvent);

      expect(resDuplicate.status).toBe(200);
      expect(resDuplicate.body.duplicate).toBe(true);

      // Verify no duplicate tickets or inventory changes
      const orderAfterDuplicate = await prisma.order.findUnique({
        where: { id: order.id },
        include: { tickets: true },
      });
      expect(orderAfterDuplicate?.tickets.length).toBe(2);

      const tierFinal = await prisma.ticketTier.findUnique({ where: { id: activeTierId } });
      expect(tierFinal?.soldQuantity).toBe(initialSold + 2);

      constructSpy.mockRestore();
      constructSpy2.mockRestore();
    });

    it('records failed transaction on payment_intent.payment_failed without premature order cancellation', async () => {
      const order = await prisma.order.create({
        data: {
          orderNumber: `OUT-FAIL-${Date.now()}`,
          eventId: publishedEventId,
          status: OrderStatus.PENDING,
          customerEmail: 'failed_card@outside.vip',
          customerName: 'Failed Card Buyer',
          totalInCents: 5000,
          currency: 'USD',
          idempotencyKey: `idem_fail_${Date.now()}`,
          expiresAt: new Date(Date.now() + 15 * 60 * 1000),
          items: {
            create: [{ ticketTierId: activeTierId, quantity: 1, unitPriceInCents: 5000, subtotalInCents: 5000 }],
          },
          reservations: {
            create: [{ ticketTierId: activeTierId, quantity: 1, expiresAt: new Date(Date.now() + 15 * 60 * 1000) }],
          },
        },
      });

      const mockEvent = {
        id: `evt_failed_${Date.now()}`,
        type: 'payment_intent.payment_failed',
        data: {
          object: {
            id: `pi_failed_${Date.now()}`,
            amount: 5000,
            currency: 'usd',
            metadata: { orderId: order.id },
            last_payment_error: { message: 'Your card has insufficient funds.' },
          },
        },
      };

      const constructSpy = vi.spyOn(stripe.webhooks, 'constructEvent').mockReturnValueOnce(mockEvent as any);

      const res = await request(app)
        .post('/api/webhooks/stripe')
        .set('stripe-signature', 'valid_test_signature')
        .send(mockEvent);

      expect(res.status).toBe(200);

      // Order must remain PENDING so customer can retry before reservation expires
      const checkOrder = await prisma.order.findUnique({
        where: { id: order.id },
        include: { transactions: true },
      });

      expect(checkOrder?.status).toBe(OrderStatus.PENDING);
      expect(checkOrder?.transactions.length).toBe(1);
      expect(checkOrder?.transactions[0].status).toBe('FAILED');

      constructSpy.mockRestore();
    });

    it('rejects payment_intent.succeeded with mismatched amount or currency', async () => {
      const order = await prisma.order.create({
        data: {
          orderNumber: `OUT-MISMATCH-${Date.now()}`,
          eventId: publishedEventId,
          status: OrderStatus.PENDING,
          customerEmail: 'mismatch@outside.vip',
          customerName: 'Mismatch Buyer',
          totalInCents: 10000,
          currency: 'USD',
          idempotencyKey: `idem_mismatch_${Date.now()}`,
          expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        },
      });

      const mockEvent = {
        id: `evt_mismatch_${Date.now()}`,
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: `pi_mismatch_${Date.now()}`,
            status: 'succeeded',
            amount: 5000, // Mismatched amount (5000 vs 10000)
            currency: 'usd',
            metadata: { orderId: order.id },
          },
        },
      };

      const constructSpy = vi.spyOn(stripe.webhooks, 'constructEvent').mockReturnValueOnce(mockEvent as any);

      const res = await request(app)
        .post('/api/webhooks/stripe')
        .set('stripe-signature', 'valid_test_signature')
        .send(mockEvent);

      expect(res.status).toBe(500);

      const checkOrder = await prisma.order.findUnique({ where: { id: order.id } });
      expect(checkOrder?.status).toBe(OrderStatus.PENDING);

      constructSpy.mockRestore();
    });

    it('late payment safety: issues tickets and increments soldQuantity safely even if reservations were released', async () => {
      const order = await prisma.order.create({
        data: {
          orderNumber: `OUT-LATE-${Date.now()}`,
          eventId: publishedEventId,
          status: OrderStatus.PENDING,
          customerEmail: 'late@outside.vip',
          customerName: 'Late Buyer',
          totalInCents: 5000,
          currency: 'USD',
          idempotencyKey: `idem_late_${Date.now()}`,
          expiresAt: new Date(Date.now() - 60 * 1000), // hold already expired
          items: {
            create: [{ ticketTierId: activeTierId, quantity: 1, unitPriceInCents: 5000, subtotalInCents: 5000 }],
          },
          reservations: {
            create: [{ ticketTierId: activeTierId, quantity: 1, expiresAt: new Date(Date.now() - 60 * 1000), status: ReservationStatus.RELEASED }],
          },
        },
      });

      const tierBefore = await prisma.ticketTier.findUnique({ where: { id: activeTierId } });
      const initialSold = tierBefore?.soldQuantity || 0;

      const mockEvent = {
        id: `evt_late_${Date.now()}`,
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: `pi_late_${Date.now()}`,
            status: 'succeeded',
            amount: 5000,
            currency: 'usd',
            metadata: { orderId: order.id },
          },
        },
      };

      const constructSpy = vi.spyOn(stripe.webhooks, 'constructEvent').mockReturnValueOnce(mockEvent as any);

      const res = await request(app)
        .post('/api/webhooks/stripe')
        .set('stripe-signature', 'valid_test_signature')
        .send(mockEvent);

      expect(res.status).toBe(200);

      const checkOrder = await prisma.order.findUnique({
        where: { id: order.id },
        include: { tickets: true },
      });
      expect(checkOrder?.status).toBe(OrderStatus.COMPLETED);
      expect(checkOrder?.tickets.length).toBe(1);

      // Verify soldQuantity incremented without corrupting reservedQuantity
      const tierAfter = await prisma.ticketTier.findUnique({ where: { id: activeTierId } });
      expect(tierAfter?.soldQuantity).toBe(initialSold + 1);

      constructSpy.mockRestore();
    });
  });

  describe('4. GET /api/orders/:orderNumber - Secure Order Lookup & Delayed Webhook Reconciliation', () => {
    it('rejects access without valid order access token or authentication with 401 or 403', async () => {
      const order = await prisma.order.create({
        data: {
          orderNumber: `OUT-LOOKUP-SEC-${Date.now()}`,
          eventId: publishedEventId,
          status: OrderStatus.COMPLETED,
          customerEmail: 'secret@outside.vip',
          customerName: 'Secret Buyer',
          totalInCents: 5000,
          currency: 'USD',
          orderAccessToken: `oat_valid_token_${Date.now()}`,
          idempotencyKey: `idem_sec_${Date.now()}`,
          expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        },
      });

      const resNoAuth = await request(app).get(`/api/orders/${order.orderNumber}`);
      expect(resNoAuth.status).toBe(401);

      const resWrongToken = await request(app).get(`/api/orders/${order.orderNumber}?token=wrong_token`);
      expect(resWrongToken.status).toBe(403);
    });

    it('returns full order and issued passes when correct orderAccessToken is supplied', async () => {
      const orderToken = `oat_correct_${Date.now()}`;
      const order = await prisma.order.create({
        data: {
          orderNumber: `OUT-LOOKUP-OK-${Date.now()}`,
          eventId: publishedEventId,
          status: OrderStatus.COMPLETED,
          customerEmail: 'confirmed@outside.vip',
          customerName: 'Confirmed Attendee',
          totalInCents: 5000,
          currency: 'USD',
          orderAccessToken: orderToken,
          idempotencyKey: `idem_ok_${Date.now()}`,
          expiresAt: new Date(Date.now() + 15 * 60 * 1000),
          tickets: {
            create: [
              {
                ticketToken: `tkt_sec_real_${Date.now()}`,
                eventId: publishedEventId,
                ticketTierId: activeTierId,
                attendeeName: 'Confirmed Attendee',
                attendeeEmail: 'confirmed@outside.vip',
                status: TicketStatus.ISSUED,
              },
            ],
          },
        },
      });

      const res = await request(app).get(`/api/orders/${order.orderNumber}?token=${orderToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.order.event.id).toBe(publishedEventId);
      expect(typeof res.body.data.order.event.title).toBe('string');
      expect(res.body.data.order.tickets.length).toBe(1);
      expect(res.body.data.order.tickets[0].ticketToken).toMatch(/^tkt_sec_/);
    });

    it('reconciles stuck pending orders on lookup by retrieving PaymentIntent and fulfills tickets exactly once', async () => {
      const orderToken = `oat_reconcile_${Date.now()}`;
      const mockPaymentIntentId = `pi_reconcile_${Date.now()}`;

      const tierBefore = await prisma.ticketTier.findUnique({ where: { id: activeTierId } });
      const initialReserved = tierBefore?.reservedQuantity || 0;
      const initialSold = tierBefore?.soldQuantity || 0;

      const order = await prisma.order.create({
        data: {
          orderNumber: `OUT-RECONCILE-${Date.now()}`,
          eventId: publishedEventId,
          status: OrderStatus.PENDING,
          customerEmail: 'stuck_buyer@outside.vip',
          customerName: 'Stuck Buyer',
          totalInCents: 10000,
          currency: 'USD',
          platformFeeInCents: 500,
          organizerNetInCents: 9500,
          orderAccessToken: orderToken,
          paymentReference: mockPaymentIntentId,
          idempotencyKey: `idem_reconcile_${Date.now()}`,
          expiresAt: new Date(Date.now() + 15 * 60 * 1000),
          items: {
            create: [
              {
                ticketTierId: activeTierId,
                quantity: 2,
                unitPriceInCents: 5000,
                subtotalInCents: 10000,
              },
            ],
          },
          reservations: {
            create: [
              {
                ticketTierId: activeTierId,
                quantity: 2,
                expiresAt: new Date(Date.now() + 15 * 60 * 1000),
                status: ReservationStatus.ACTIVE,
              },
            ],
          },
        },
      });

      await prisma.ticketTier.update({
        where: { id: activeTierId },
        data: { reservedQuantity: { increment: 2 } },
      });

      // Mock Stripe PaymentIntent returning succeeded
      const stripeSpy = vi.spyOn(stripe.paymentIntents, 'retrieve').mockResolvedValueOnce({
        id: mockPaymentIntentId,
        status: 'succeeded',
        amount: 10000,
        currency: 'usd',
        metadata: {
          orderId: order.id,
          orderNumber: order.orderNumber,
        },
      } as any);

      // Call GET /api/orders/:orderNumber
      const res = await request(app).get(`/api/orders/${order.orderNumber}?token=${orderToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.order.status).toBe(OrderStatus.COMPLETED);
      expect(res.body.data.order.tickets.length).toBe(2);
      expect(res.body.data.order.tickets[0].ticketToken).toMatch(/^tkt_sec_/);

      // Verify DB updates
      const updatedOrder = await prisma.order.findUnique({
        where: { id: order.id },
        include: { tickets: true, reservations: true, transactions: true },
      });

      expect(updatedOrder?.status).toBe(OrderStatus.COMPLETED);
      expect(updatedOrder?.reservations[0].status).toBe(ReservationStatus.CONFIRMED);
      expect(updatedOrder?.tickets.length).toBe(2);
      expect(updatedOrder?.transactions.length).toBe(1);
      expect(updatedOrder?.transactions[0].status).toBe('SUCCEEDED');

      // Verify inventory shifted exactly once
      const tierAfter = await prisma.ticketTier.findUnique({ where: { id: activeTierId } });
      expect(tierAfter?.reservedQuantity).toBe(initialReserved);
      expect(tierAfter?.soldQuantity).toBe(initialSold + 2);

      // Verify subsequent lookup does not duplicate tickets
      const resSecond = await request(app).get(`/api/orders/${order.orderNumber}?token=${orderToken}`);
      expect(resSecond.status).toBe(200);
      expect(resSecond.body.data.order.tickets.length).toBe(2);

      stripeSpy.mockRestore();
    });
  });

  describe('5. Expired Reservation Cleanup', () => {
    it('automatically restores inventory for expired active reservations', async () => {
      const order = await prisma.order.create({
        data: {
          orderNumber: `OUT-STALE-${Date.now()}`,
          eventId: publishedEventId,
          status: OrderStatus.PENDING,
          customerEmail: 'stale@outside.vip',
          customerName: 'Stale Buyer',
          totalInCents: 5000,
          currency: 'USD',
          idempotencyKey: `idem_stale_${Date.now()}`,
          expiresAt: new Date(Date.now() - 5 * 60 * 1000),
          reservations: {
            create: [
              {
                ticketTierId: activeTierId,
                quantity: 3,
                expiresAt: new Date(Date.now() - 5 * 60 * 1000),
                status: ReservationStatus.ACTIVE,
              },
            ],
          },
        },
      });

      await prisma.ticketTier.update({
        where: { id: activeTierId },
        data: { reservedQuantity: { increment: 3 } },
      });

      const tierBefore = await prisma.ticketTier.findUnique({ where: { id: activeTierId } });
      const reservedBefore = tierBefore?.reservedQuantity || 0;

      const releasedCount = await releaseExpiredReservations();
      expect(releasedCount).toBeGreaterThanOrEqual(1);

      const tierAfter = await prisma.ticketTier.findUnique({ where: { id: activeTierId } });
      expect(tierAfter?.reservedQuantity).toBe(reservedBefore - 3);

      const checkOrder = await prisma.order.findUnique({
        where: { id: order.id },
        include: { reservations: true },
      });
      expect(checkOrder?.status).toBe(OrderStatus.EXPIRED);
      expect(checkOrder?.reservations[0].status).toBe(ReservationStatus.RELEASED);
    });
  });
});
