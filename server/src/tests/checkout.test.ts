import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { prisma } from '../db/prisma.js';
import { stripe } from '../lib/stripe.js';
import { calculateFinancialBreakdown } from '../modules/checkout/checkout.financials.js';
import { releaseExpiredReservations } from '../modules/checkout/checkout.service.js';
import { EventStatus, OrderStatus, ReservationStatus, TicketStatus, TicketTierStatus } from '@prisma/client';

describe('Outside.vip Checkout, Atomic Reservations & Payments API', () => {
  let publishedEventId: string;
  let activeTierId: string;
  let limitedTierId: string;
  let attendeeUser: any;

  beforeEach(async () => {
    vi.restoreAllMocks();

    // Ensure we have a published event with known active ticket tiers
    const event = await prisma.event.findFirst({
      where: {
        status: EventStatus.PUBLISHED,
        slug: 'sol-fest-baobab-edition-2026',
      },
      include: {
        ticketTiers: true,
      },
    });

    if (!event) {
      throw new Error('Test baseline requires seeded event sol-fest-baobab-edition-2026');
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

  describe('2. POST /api/checkout/create-session - Validation & Stock Protection', () => {
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
      // Find a tier from a different event
      const otherTier = await prisma.ticketTier.findFirst({
        where: { eventId: { not: publishedEventId } },
      });

      if (otherTier) {
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
      }
    });

    it('rejects checkout exceeding maxPerOrder limit', async () => {
      const res = await request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: publishedEventId,
          items: [{ ticketTierId: limitedTierId, quantity: 5 }], // max is 2
          customerEmail: 'buyer@outside.vip',
          customerName: 'Test Buyer',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('Maximum purchase');
    });

    it('rejects checkout when requested quantity exceeds available remaining capacity', async () => {
      // Mock Stripe to allow first reservation
      const stripeSpy = vi.spyOn(stripe.checkout.sessions, 'create').mockResolvedValueOnce({
        id: 'cs_test_mock_session_1',
        url: 'https://checkout.stripe.com/pay/cs_test_mock_session_1',
      } as any);

      const resSuccess = await request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: publishedEventId,
          items: [{ ticketTierId: limitedTierId, quantity: 2 }],
          customerEmail: 'buyer1@outside.vip',
          customerName: 'Buyer 1',
        });

      expect(resSuccess.status).toBe(201);
      expect(resSuccess.body.data).toHaveProperty('checkoutUrl');

      // Now tier has 2 reserved out of 2 total capacity -> 0 remaining
      // Second attempt must fail with 409 Conflict
      const resConflict = await request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: publishedEventId,
          items: [{ ticketTierId: limitedTierId, quantity: 1 }],
          customerEmail: 'buyer2@outside.vip',
          customerName: 'Buyer 2',
        });

      expect(resConflict.status).toBe(409);
      expect(resConflict.body.error.message).toContain('Insufficient ticket availability');

      stripeSpy.mockRestore();
    });

    it('calculates total strictly server-side and rolls back reservation if Stripe creation fails', async () => {
      // Mock Stripe session creation failure
      const stripeSpy = vi.spyOn(stripe.checkout.sessions, 'create').mockRejectedValueOnce(
        new Error('Stripe API network timeout')
      );

      const tierBefore = await prisma.ticketTier.findUnique({
        where: { id: activeTierId },
      });
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

      // Verify reservedQuantity was safely rolled back to initial value
      const tierAfter = await prisma.ticketTier.findUnique({
        where: { id: activeTierId },
      });
      expect(tierAfter?.reservedQuantity).toBe(initialReserved);

      stripeSpy.mockRestore();
    });

    it('creates order, reservations, financial breakdown, and returns Stripe session URL on success', async () => {
      const mockSessionId = `cs_test_${Date.now()}`;
      const mockCheckoutUrl = `https://checkout.stripe.com/pay/${mockSessionId}`;

      const stripeSpy = vi.spyOn(stripe.checkout.sessions, 'create').mockResolvedValueOnce({
        id: mockSessionId,
        url: mockCheckoutUrl,
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
      expect(res.body.data.checkoutUrl).toBe(mockCheckoutUrl);
      expect(res.body.data).toHaveProperty('orderNumber');
      expect(res.body.data).toHaveProperty('orderAccessToken');
      expect(res.body.data.orderAccessToken).toMatch(/^oat_/);

      // Verify order record in DB
      const dbOrder = await prisma.order.findUnique({
        where: { orderNumber: res.body.data.orderNumber },
        include: { items: true, reservations: true },
      });

      expect(dbOrder).toBeDefined();
      expect(dbOrder?.status).toBe(OrderStatus.PENDING);
      expect(dbOrder?.paymentReference).toBe(mockSessionId);
      expect(dbOrder?.platformFeeInCents).toBeGreaterThan(0);
      expect(dbOrder?.organizerNetInCents).toBeGreaterThan(0);
      expect(dbOrder?.platformFeeInCents! + dbOrder?.organizerNetInCents!).toBe(dbOrder?.totalInCents);
      expect(dbOrder?.reservations.length).toBe(1);
      expect(dbOrder?.reservations[0].status).toBe(ReservationStatus.ACTIVE);

      // Regression check: Stripe requires expires_at to be at least 30 minutes (1800s) from creation
      const sessionPayload = stripeSpy.mock.calls[0][0];
      const nowSeconds = Math.floor(Date.now() / 1000);
      expect(sessionPayload.expires_at).toBeDefined();
      expect(sessionPayload.expires_at - nowSeconds).toBeGreaterThanOrEqual(1800);

      stripeSpy.mockRestore();
    });

    it('regression: rolls back reservation cleanly when Stripe throws parameter validation errors', async () => {
      // Simulate Stripe throwing the exact 30-minute validation error
      const stripeSpy = vi.spyOn(stripe.checkout.sessions, 'create').mockRejectedValueOnce(
        new Error("The `expires_at` timestamp must be at least 30 minutes from Checkout Session creation.")
      );

      const tierBefore = await prisma.ticketTier.findUnique({ where: { id: activeTierId } });
      const initialReserved = tierBefore?.reservedQuantity || 0;

      const res = await request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: publishedEventId,
          items: [{ ticketTierId: activeTierId, quantity: 1 }],
          customerEmail: 'regression_test@outside.vip',
          customerName: 'Regression Buyer',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('Payment provider session creation failed');

      // Verify stock was restored
      const tierAfter = await prisma.ticketTier.findUnique({ where: { id: activeTierId } });
      expect(tierAfter?.reservedQuantity).toBe(initialReserved);

      stripeSpy.mockRestore();
    });
  });

  describe('3. POST /api/webhooks/stripe - Signature Verification & Fulfillment', () => {
    it('rejects webhooks without valid Stripe signature with 400', async () => {
      const res = await request(app)
        .post('/api/webhooks/stripe')
        .set('stripe-signature', 'invalid_signature_mock')
        .send({ id: 'evt_fake_test' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('signature verification failed');
    });

    it('fulfills order on checkout.session.completed with payment_status=paid', async () => {
      // 1. Create a real pending order and reservation in database
      const orderAccessToken = `oat_test_wh_${Date.now()}`;
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

      // Update tier reserved quantity
      await prisma.ticketTier.update({
        where: { id: activeTierId },
        data: { reservedQuantity: { increment: 2 } },
      });

      const tierBefore = await prisma.ticketTier.findUnique({ where: { id: activeTierId } });
      const initialSold = tierBefore?.soldQuantity || 0;
      const initialReserved = tierBefore?.reservedQuantity || 0;

      // Mock webhook signature validation to pass
      const eventId = `evt_test_${Date.now()}`;
      const mockEvent = {
        id: eventId,
        type: 'checkout.session.completed',
        data: {
          object: {
            id: `cs_test_wh_${Date.now()}`,
            payment_status: 'paid',
            amount_total: 10000,
            currency: 'usd',
            payment_intent: `pi_test_${Date.now()}`,
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

      // Verify no duplicate tickets were issued
      const orderAfterDuplicate = await prisma.order.findUnique({
        where: { id: order.id },
        include: { tickets: true },
      });
      expect(orderAfterDuplicate?.tickets.length).toBe(2);

      constructSpy.mockRestore();
      constructSpy2.mockRestore();
    });

    it('does not issue tickets if checkout.session.completed has payment_status=unpaid', async () => {
      const order = await prisma.order.create({
        data: {
          orderNumber: `OUT-UNPAID-${Date.now()}`,
          eventId: publishedEventId,
          status: OrderStatus.PENDING,
          customerEmail: 'unpaid@outside.vip',
          customerName: 'Unpaid Buyer',
          totalInCents: 5000,
          currency: 'USD',
          platformFeeInCents: 250,
          organizerNetInCents: 4750,
          idempotencyKey: `idem_unpaid_${Date.now()}`,
          expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        },
      });

      const mockEvent = {
        id: `evt_unpaid_${Date.now()}`,
        type: 'checkout.session.completed',
        data: {
          object: {
            id: `cs_unpaid_${Date.now()}`,
            payment_status: 'unpaid', // async payment pending
            amount_total: 5000,
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

      expect(checkOrder?.status).toBe(OrderStatus.PENDING);
      expect(checkOrder?.tickets.length).toBe(0);

      constructSpy.mockRestore();
    });

    it('releases reservations on checkout.session.expired', async () => {
      const order = await prisma.order.create({
        data: {
          orderNumber: `OUT-EXP-${Date.now()}`,
          eventId: publishedEventId,
          status: OrderStatus.PENDING,
          customerEmail: 'expired@outside.vip',
          customerName: 'Expired Buyer',
          totalInCents: 5000,
          currency: 'USD',
          idempotencyKey: `idem_exp_${Date.now()}`,
          expiresAt: new Date(Date.now() + 15 * 60 * 1000),
          items: {
            create: [{ ticketTierId: activeTierId, quantity: 1, unitPriceInCents: 5000, subtotalInCents: 5000 }],
          },
          reservations: {
            create: [{ ticketTierId: activeTierId, quantity: 1, expiresAt: new Date(Date.now() + 15 * 60 * 1000) }],
          },
        },
      });

      await prisma.ticketTier.update({
        where: { id: activeTierId },
        data: { reservedQuantity: { increment: 1 } },
      });

      const mockEvent = {
        id: `evt_exp_${Date.now()}`,
        type: 'checkout.session.expired',
        data: {
          object: {
            id: `cs_exp_${Date.now()}`,
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

      const updated = await prisma.order.findUnique({
        where: { id: order.id },
        include: { reservations: true },
      });

      expect(updated?.status).toBe(OrderStatus.EXPIRED);
      expect(updated?.reservations[0].status).toBe(ReservationStatus.RELEASED);

      constructSpy.mockRestore();
    });
  });

  describe('4. GET /api/orders/:orderNumber - Secure Order & Pass Lookup', () => {
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

      // Attempt 1: No credentials at all -> 401
      const resNoAuth = await request(app).get(`/api/orders/${order.orderNumber}`);
      expect(resNoAuth.status).toBe(401);

      // Attempt 2: Wrong token -> 403
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
      expect(res.body.data.order.orderNumber).toBe(order.orderNumber);
      expect(res.body.data.order.customerName).toBe('Confirmed Attendee');
      expect(res.body.data.order.event.title).toContain('SOL FEST');
      expect(res.body.data.order.tickets.length).toBe(1);
      expect(res.body.data.order.tickets[0].ticketToken).toMatch(/^tkt_sec_/);
    });

    it('regression: reconciles stuck paid pending orders on lookup with Stripe and fulfills tickets exactly once', async () => {
      const orderToken = `oat_reconcile_${Date.now()}`;
      const mockSessionId = `cs_test_stuck_${Date.now()}`;

      const tierBefore = await prisma.ticketTier.findUnique({ where: { id: activeTierId } });
      const initialReserved = tierBefore?.reservedQuantity || 0;
      const initialSold = tierBefore?.soldQuantity || 0;

      // Create a pending order with active reservations
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
          paymentReference: mockSessionId,
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

      // Mock Stripe returning that payment completed successfully (paid)
      const stripeSpy = vi.spyOn(stripe.checkout.sessions, 'retrieve').mockResolvedValueOnce({
        id: mockSessionId,
        payment_status: 'paid',
        amount_total: 10000,
        currency: 'usd',
        payment_intent: `pi_reconcile_${Date.now()}`,
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
      expect(tierAfter?.reservedQuantity).toBe(initialReserved); // incremented 2, then decremented 2 -> initial
      expect(tierAfter?.soldQuantity).toBe(initialSold + 2);

      // Verify subsequent lookup does not duplicate tickets or transactions
      const resSecond = await request(app).get(`/api/orders/${order.orderNumber}?token=${orderToken}`);
      expect(resSecond.status).toBe(200);
      expect(resSecond.body.data.order.tickets.length).toBe(2);

      const tierFinal = await prisma.ticketTier.findUnique({ where: { id: activeTierId } });
      expect(tierFinal?.soldQuantity).toBe(initialSold + 2);

      stripeSpy.mockRestore();
    });
  });

  describe('5. Expired Reservation Cleanup', () => {
    it('automatically restores inventory for expired active reservations', async () => {
      // Create an expired reservation
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
          expiresAt: new Date(Date.now() - 5 * 60 * 1000), // 5 minutes ago
          reservations: {
            create: [
              {
                ticketTierId: activeTierId,
                quantity: 3,
                expiresAt: new Date(Date.now() - 5 * 60 * 1000), // expired hold
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

      // Run cleanup
      const releasedCount = await releaseExpiredReservations();
      expect(releasedCount).toBeGreaterThanOrEqual(1);

      // Verify reserved quantity was decremented by at least 3
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
