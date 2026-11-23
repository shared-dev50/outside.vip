import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { nanoid } from 'nanoid';
import {
  EmailOutboxStatus,
  EmailOutboxType,
  EventStatus,
  LedgerEntryType,
  OrderStatus,
  ReservationStatus,
  TicketStatus,
  TicketTierStatus,
} from '@prisma/client';
import { app } from '../app.js';
import { prisma } from '../db/prisma.js';
import { stripe } from '../lib/stripe.js';
import {
  getLatestOrderConfirmationEmail,
  resetEmailServiceTestOptions,
  resetSentOrderConfirmationEmails,
  sentOrderConfirmationEmails,
  setEmailServiceTestOptions,
} from '../lib/email.service.js';
import {
  claimPendingEmailOutboxBatch,
  EMAIL_OUTBOX_MAX_ATTEMPTS,
  processClaimedEmailOutboxItem,
  runEmailOutboxPass,
} from '../modules/notifications/emailOutbox.service.js';
import {
  isEmailOutboxWorkerRunning,
  startEmailOutboxWorker,
  stopEmailOutboxWorker,
} from '../modules/notifications/emailOutboxWorker.js';
import {
  fulfillPaidOrder,
  processStripeWebhookEvent,
} from '../modules/webhooks/webhook.service.js';

describe('P1-01 Buyer Ticket Confirmation Email — PostgreSQL Integration Tests', () => {
  const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    EMAIL_FROM: process.env.EMAIL_FROM,
    CLIENT_URL: process.env.CLIENT_URL,
  };

  let organizerUserId: string;
  let testEventId: string;
  let testTierId: string;
  const createdOrderIds: string[] = [];
  const createdOutboxIds: string[] = [];
  const createdWebhookEventIds: string[] = [];

  async function createPendingTestOrder(options?: {
    quantity?: number;
    email?: string;
    name?: string;
    omitAccessToken?: boolean;
    status?: OrderStatus;
    expired?: boolean;
  }) {
    const qty = options?.quantity ?? 2;
    const unitPrice = 5000;
    const total = unitPrice * qty;
    const suffix = nanoid(10);
    const paymentIntentId = `pi_p101_${suffix}`;
    const orderNumber = `OUT-P101-${suffix.toUpperCase()}`;
    const expiresAt = options?.expired
      ? new Date(Date.now() - 10 * 60 * 1000)
      : new Date(Date.now() + 30 * 60 * 1000);

    const order = await prisma.order.create({
      data: {
        orderNumber,
        eventId: testEventId,
        status: options?.status ?? OrderStatus.PENDING,
        customerEmail: options?.email ?? `buyer_${suffix}@example.com`,
        customerName: options?.name ?? 'Jordan Mensah',
        totalInCents: total,
        currency: 'USD',
        platformFeeInCents: Math.round(total * 0.05),
        organizerNetInCents: total - Math.round(total * 0.05),
        orderAccessToken: options?.omitAccessToken ? null : `oat_${nanoid(32)}`,
        paymentReference: paymentIntentId,
        idempotencyKey: `idem_p101_${suffix}`,
        expiresAt,
        items: {
          create: [
            {
              ticketTierId: testTierId,
              quantity: qty,
              unitPriceInCents: unitPrice,
              subtotalInCents: total,
            },
          ],
        },
        reservations: {
          create: [
            {
              ticketTierId: testTierId,
              quantity: qty,
              expiresAt,
              status: options?.expired ? ReservationStatus.RELEASED : ReservationStatus.ACTIVE,
            },
          ],
        },
      },
      include: { items: true, reservations: true },
    });

    if (!options?.expired) {
      await prisma.ticketTier.update({
        where: { id: testTierId },
        data: { reservedQuantity: { increment: qty } },
      });
    }

    createdOrderIds.push(order.id);
    return { order, paymentIntentId };
  }

  function makeSucceededPaymentIntent(order: {
    id: string;
    orderNumber: string;
    totalInCents: number;
    currency: string;
  }, paymentIntentId: string) {
    return {
      id: paymentIntentId,
      status: 'succeeded',
      amount: order.totalInCents,
      currency: order.currency.toLowerCase(),
      metadata: {
        orderId: order.id,
        orderNumber: order.orderNumber,
      },
    } as any;
  }

  beforeAll(async () => {
    await stopEmailOutboxWorker(0);

    const organizer = await prisma.user.findFirst({
      where: { role: 'ORGANIZER' },
    });
    if (!organizer) {
      throw new Error('Integration test requires at least one seeded organizer user');
    }
    organizerUserId = organizer.id;

    const suffix = nanoid(8);
    const event = await prisma.event.create({
      data: {
        slug: `p101-email-outbox-test-${suffix}`,
        organizerId: organizerUserId,
        title: `Outside P1-01 Live ${suffix}`,
        description: 'Integration test event for buyer confirmation email outbox',
        status: EventStatus.PUBLISHED,
        coverImageUrl: 'https://example.com/cover.jpg',
        venueName: 'Skyline Pavilion',
        venueAddress: '220 West 42nd St',
        city: 'New York',
        country: 'US',
        startAt: new Date('2027-06-15T19:00:00.000Z'),
        endAt: new Date('2027-06-16T01:00:00.000Z'),
        timezone: 'America/New_York',
      },
    });
    testEventId = event.id;

    const tier = await prisma.ticketTier.create({
      data: {
        eventId: testEventId,
        name: 'VIP Lounge Pass',
        priceInCents: 5000,
        currency: 'USD',
        totalCapacity: 500,
        reservedQuantity: 0,
        soldQuantity: 0,
        minPerOrder: 1,
        maxPerOrder: 10,
        validityStartAt: new Date('2027-06-15T20:00:00.000Z'),
        validityEndAt: new Date('2027-06-15T23:30:00.000Z'),
        status: TicketTierStatus.ACTIVE,
      },
    });
    testTierId = tier.id;
  });

  beforeEach(async () => {
    await stopEmailOutboxWorker(0);
    resetEmailServiceTestOptions();
    resetSentOrderConfirmationEmails();
    vi.restoreAllMocks();
    process.env.CLIENT_URL = 'https://out-side.vip';
    process.env.EMAIL_FROM = 'Outside.vip <no-reply@out-side.vip>';
  });

  afterEach(async () => {
    await stopEmailOutboxWorker(0);
    process.env.NODE_ENV = originalEnv.NODE_ENV;
    if (originalEnv.RESEND_API_KEY === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = originalEnv.RESEND_API_KEY;
    if (originalEnv.EMAIL_FROM === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = originalEnv.EMAIL_FROM;
    if (originalEnv.CLIENT_URL === undefined) delete process.env.CLIENT_URL;
    else process.env.CLIENT_URL = originalEnv.CLIENT_URL;

    resetEmailServiceTestOptions();
    resetSentOrderConfirmationEmails();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await stopEmailOutboxWorker(0);

    if (createdOutboxIds.length > 0) {
      await prisma.emailOutbox.deleteMany({
        where: { id: { in: createdOutboxIds } },
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
      await prisma.ticket.deleteMany({
        where: { orderId: { in: createdOrderIds } },
      });
      await prisma.ticketReservation.deleteMany({
        where: { orderId: { in: createdOrderIds } },
      });
      await prisma.orderItem.deleteMany({
        where: { orderId: { in: createdOrderIds } },
      });
      await prisma.order.deleteMany({
        where: { id: { in: createdOrderIds } },
      });
    }
    if (createdWebhookEventIds.length > 0) {
      await prisma.processedWebhookEvent.deleteMany({
        where: { eventId: { in: createdWebhookEventIds } },
      });
    }
    if (testTierId) {
      await prisma.ticketTier.deleteMany({ where: { id: testTierId } });
    }
    if (testEventId) {
      await prisma.event.deleteMany({ where: { id: testEventId } });
    }
  });

  describe('1. Fulfillment, Concurrency & Deduplication', () => {
    it('creates one completed order, tickets, and one durable outbox entry on webhook fulfillment, then dispatches once', async () => {
      const { order, paymentIntentId } = await createPendingTestOrder({ quantity: 2 });
      const eventId = `evt_p101_ok_${nanoid(10)}`;
      createdWebhookEventIds.push(eventId);

      const mockEvent = {
        id: eventId,
        type: 'payment_intent.succeeded',
        data: { object: makeSucceededPaymentIntent(order, paymentIntentId) },
      };

      const constructSpy = vi
        .spyOn(stripe.webhooks, 'constructEvent')
        .mockReturnValueOnce(mockEvent as any);

      const res = await request(app)
        .post('/api/webhooks/stripe')
        .set('stripe-signature', 'sig_valid')
        .send(mockEvent);

      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
      constructSpy.mockRestore();

      const updatedOrder = await prisma.order.findUnique({
        where: { id: order.id },
        include: { tickets: true },
      });
      expect(updatedOrder?.status).toBe(OrderStatus.COMPLETED);
      expect(updatedOrder?.tickets).toHaveLength(2);

      // Outbox record persisted durably while worker is stopped
      const outboxRows = await prisma.emailOutbox.findMany({ where: { orderId: order.id } });
      expect(outboxRows).toHaveLength(1);
      expect(outboxRows[0].dedupeKey).toBe(`order_confirmation:${order.id}`);
      expect(outboxRows[0].idempotencyKey).toBe(`order-confirmation:${order.id}`);
      expect(outboxRows[0].status).toBe(EmailOutboxStatus.PENDING);
      expect(JSON.stringify(outboxRows[0].contentSnapshot)).not.toContain(order.orderAccessToken!);

      // Process outbox pass -> dispatches exactly 1 confirmation email
      const stats = await runEmailOutboxPass();
      expect(stats.accepted).toBeGreaterThanOrEqual(1);

      const sentRow = await prisma.emailOutbox.findUnique({ where: { id: outboxRows[0].id } });
      expect(sentRow?.status).toBe(EmailOutboxStatus.SENT);
      expect(sentRow?.providerMessageId).toBeTruthy();
      expect(sentRow?.sentAt).toBeInstanceOf(Date);
      expect(sentRow?.attempts).toBe(1);

      const recorded = getLatestOrderConfirmationEmail(order.customerEmail);
      expect(recorded).toBeDefined();
      expect(recorded!.orderNumber).toBe(order.orderNumber);
      expect(recorded!.ticketAccessUrl).toBe(
        `https://out-side.vip/orders/${order.orderNumber}?token=${order.orderAccessToken}`
      );
      expect(recorded!.html).toContain('VIP Lounge Pass');
      expect(recorded!.html).toContain('Entry validity:');
    });

    it('prevents duplicate tickets and notifications on repeated webhook and distinct webhook events for same payment', async () => {
      const { order, paymentIntentId } = await createPendingTestOrder({ quantity: 2 });
      const eventId1 = `evt_p101_dup1_${nanoid(10)}`;
      const eventId2 = `evt_p101_dup2_${nanoid(10)}`;
      createdWebhookEventIds.push(eventId1, eventId2);

      const pi = makeSucceededPaymentIntent(order, paymentIntentId);
      const evt1 = { id: eventId1, type: 'payment_intent.succeeded', data: { object: pi } } as any;
      const evt2 = { id: eventId2, type: 'payment_intent.succeeded', data: { object: pi } } as any;

      const r1 = await processStripeWebhookEvent(evt1);
      const r1Dup = await processStripeWebhookEvent(evt1);
      const r2Distinct = await processStripeWebhookEvent(evt2);

      expect(r1.handled).toBe(true);
      expect(r1Dup.duplicate).toBe(true);
      expect(r2Distinct.handled).toBe(true);

      const tickets = await prisma.ticket.findMany({ where: { orderId: order.id } });
      expect(tickets).toHaveLength(2);

      const outboxRows = await prisma.emailOutbox.findMany({ where: { orderId: order.id } });
      expect(outboxRows).toHaveLength(1);
    });

    it('serializes concurrent webhook and reconciliation calls via FOR UPDATE with zero duplicate tickets, inventory drift, ledger entries, or notifications', async () => {
      const { order, paymentIntentId } = await createPendingTestOrder({ quantity: 3 });
      const tierBefore = await prisma.ticketTier.findUnique({ where: { id: testTierId } });
      const initialSold = tierBefore!.soldQuantity;
      const initialReserved = tierBefore!.reservedQuantity;

      const eventId = `evt_p101_race_${nanoid(10)}`;
      createdWebhookEventIds.push(eventId);
      const pi = makeSucceededPaymentIntent(order, paymentIntentId);

      const retrieveSpy = vi
        .spyOn(stripe.paymentIntents, 'retrieve')
        .mockResolvedValue(pi);
      const constructSpy = vi
        .spyOn(stripe.webhooks, 'constructEvent')
        .mockReturnValue({
          id: eventId,
          type: 'payment_intent.succeeded',
          data: { object: pi },
        } as any);

      // Fire webhook + reconciliation HTTP lookup + direct fulfillPaidOrder simultaneously
      const [webhookRes, lookupRes, directRes] = await Promise.all([
        request(app)
          .post('/api/webhooks/stripe')
          .set('stripe-signature', 'sig_race')
          .send({ id: eventId }),
        request(app).get(`/api/orders/${order.orderNumber}?token=${order.orderAccessToken}`),
        fulfillPaidOrder(pi),
      ]);

      retrieveSpy.mockRestore();
      constructSpy.mockRestore();

      expect(webhookRes.status).toBe(200);
      expect(lookupRes.status).toBe(200);
      expect(directRes).toBe(true);

      const [tickets, outboxRows, ledgerSales, tierAfter] = await Promise.all([
        prisma.ticket.findMany({ where: { orderId: order.id } }),
        prisma.emailOutbox.findMany({ where: { orderId: order.id } }),
        prisma.financialLedgerEntry.findMany({
          where: { orderId: order.id, type: LedgerEntryType.TICKET_SALE_PENDING },
        }),
        prisma.ticketTier.findUnique({ where: { id: testTierId } }),
      ]);

      expect(tickets).toHaveLength(3);
      expect(outboxRows).toHaveLength(1);
      expect(ledgerSales).toHaveLength(1);
      expect(tierAfter!.soldQuantity).toBe(initialSold + 3);
      expect(tierAfter!.reservedQuantity).toBe(initialReserved - 3);
    });

    it('generates a missing orderAccessToken atomically during fulfillment before outbox dispatch', async () => {
      const { order, paymentIntentId } = await createPendingTestOrder({
        quantity: 1,
        omitAccessToken: true,
      });
      expect(order.orderAccessToken).toBeNull();

      await fulfillPaidOrder(makeSucceededPaymentIntent(order, paymentIntentId));

      const completed = await prisma.order.findUnique({ where: { id: order.id } });
      expect(completed?.orderAccessToken).toMatch(/^oat_/);

      await runEmailOutboxPass();
      const recorded = getLatestOrderConfirmationEmail(order.customerEmail);
      expect(recorded?.ticketAccessUrl).toContain(`?token=${completed!.orderAccessToken}`);
    });
  });

  describe('2. Durability, Worker Recovery & Concurrent Claiming', () => {
    it('persists PENDING outbox row while worker is stopped and processes it after restart', async () => {
      expect(isEmailOutboxWorkerRunning()).toBe(false);
      const { order, paymentIntentId } = await createPendingTestOrder({ quantity: 1 });

      await fulfillPaidOrder(makeSucceededPaymentIntent(order, paymentIntentId));

      // Still PENDING while worker is stopped
      const pending = await prisma.emailOutbox.findUnique({
        where: { dedupeKey: `order_confirmation:${order.id}` },
      });
      expect(pending?.status).toBe(EmailOutboxStatus.PENDING);
      expect(sentOrderConfirmationEmails).toHaveLength(0);

      // Simulate worker restart and verify it drains the persisted row
      startEmailOutboxWorker(60_000);
      await runEmailOutboxPass();
      await stopEmailOutboxWorker(2000);

      const after = await prisma.emailOutbox.findUnique({ where: { id: pending!.id } });
      expect(after?.status).toBe(EmailOutboxStatus.SENT);
      expect(getLatestOrderConfirmationEmail(order.customerEmail)).toBeDefined();
    });

    it('prevents concurrent workers from claiming the same notification via FOR UPDATE SKIP LOCKED', async () => {
      const { order, paymentIntentId } = await createPendingTestOrder({ quantity: 1 });
      await fulfillPaidOrder(makeSucceededPaymentIntent(order, paymentIntentId));

      // Drain any unrelated pending rows first by scoping test assertion to our target row
      const [claimA, claimB] = await Promise.all([
        claimPendingEmailOutboxBatch({ workerId: 'worker-A', batchSize: 10 }),
        claimPendingEmailOutboxBatch({ workerId: 'worker-B', batchSize: 10 }),
      ]);

      const aIds = claimA.claimed.map((r) => r.orderId);
      const bIds = claimB.claimed.map((r) => r.orderId);
      const claimedCountForOrder =
        (aIds.includes(order.id) ? 1 : 0) + (bIds.includes(order.id) ? 1 : 0);

      expect(claimedCountForOrder).toBe(1);

      // Process whichever worker won so DB stays tidy
      const winner = aIds.includes(order.id)
        ? { workerId: claimA.workerId, item: claimA.claimed.find((r) => r.orderId === order.id)! }
        : { workerId: claimB.workerId, item: claimB.claimed.find((r) => r.orderId === order.id)! };
      const outcome = await processClaimedEmailOutboxItem(winner.item, winner.workerId);
      expect(outcome).toBe('accepted');
    });

    it('recovers expired PROCESSING leases and prevents stale workers from overwriting newer state', async () => {
      const { order, paymentIntentId } = await createPendingTestOrder({ quantity: 1 });
      await fulfillPaidOrder(makeSucceededPaymentIntent(order, paymentIntentId));

      const outbox = await prisma.emailOutbox.findUniqueOrThrow({
        where: { dedupeKey: `order_confirmation:${order.id}` },
      });

      // Simulate crashed worker-old holding an expired lease
      const staleSnapshotRow = await prisma.emailOutbox.update({
        where: { id: outbox.id },
        data: {
          status: EmailOutboxStatus.PROCESSING,
          lockedBy: 'crashed-worker-old',
          lockedUntil: new Date(Date.now() - 120_000),
          attempts: 1,
          lastAttemptAt: new Date(Date.now() - 210_000),
        },
      });

      // New worker reclaims and successfully sends
      const stats = await runEmailOutboxPass({ workerId: 'recovery-worker-new' });
      expect(stats.accepted).toBeGreaterThanOrEqual(1);

      const sentState = await prisma.emailOutbox.findUniqueOrThrow({ where: { id: outbox.id } });
      expect(sentState.status).toBe(EmailOutboxStatus.SENT);
      expect(sentState.attempts).toBe(2);
      const originalMessageId = sentState.providerMessageId;

      // Stale worker attempts to finish late using its old lockedBy -> lease guard rejects overwrite
      const staleOutcome = await processClaimedEmailOutboxItem(
        staleSnapshotRow,
        'crashed-worker-old'
      );
      expect(staleOutcome).toBe('leaseLost');

      const finalState = await prisma.emailOutbox.findUniqueOrThrow({ where: { id: outbox.id } });
      expect(finalState.status).toBe(EmailOutboxStatus.SENT);
      expect(finalState.providerMessageId).toBe(originalMessageId);
    });
  });

  describe('3. Resend Retry Semantics, Immutable Payload Stability & Error Modes', () => {
    const fakeKey = 're_test_p101_integration_secret_123';

    it('retries 503, 429, 409-concurrent, and timeout with byte-for-byte identical payload even after event edits, then marks SENT on 200', async () => {
      process.env.RESEND_API_KEY = fakeKey;
      setEmailServiceTestOptions({ useResendInTest: true, timeoutMs: 40 });
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const { order, paymentIntentId } = await createPendingTestOrder({ quantity: 2 });
      await fulfillPaidOrder(makeSucceededPaymentIntent(order, paymentIntentId));

      const outbox = await prisma.emailOutbox.findUniqueOrThrow({
        where: { dedupeKey: `order_confirmation:${order.id}` },
      });

      // Mutate Event title and TicketTier name AFTER fulfillment to prove retries use the immutable snapshot
      const originalEvent = await prisma.event.findUniqueOrThrow({ where: { id: testEventId } });
      const originalTier = await prisma.ticketTier.findUniqueOrThrow({ where: { id: testTierId } });
      await prisma.event.update({
        where: { id: testEventId },
        data: { title: 'MUTATED EVENT TITLE AFTER PURCHASE' },
      });
      await prisma.ticketTier.update({
        where: { id: testTierId },
        data: { name: 'MUTATED TIER NAME AFTER PURCHASE' },
      });

      const capturedPayloads: string[] = [];
      const capturedKeys: string[] = [];

      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementationOnce(async (_url, init) => {
          capturedPayloads.push(String(init?.body));
          capturedKeys.push(new Headers(init?.headers).get('idempotency-key') || '');
          return new Response(
            JSON.stringify({ statusCode: 503, name: 'application_error', message: 'Upstream down' }),
            { status: 503, headers: { 'Content-Type': 'application/json' } }
          );
        })
        .mockImplementationOnce(async (_url, init) => {
          capturedPayloads.push(String(init?.body));
          capturedKeys.push(new Headers(init?.headers).get('idempotency-key') || '');
          return new Response(
            JSON.stringify({ statusCode: 429, name: 'rate_limit_exceeded', message: 'Slow down' }),
            { status: 429, headers: { 'Content-Type': 'application/json' } }
          );
        })
        .mockImplementationOnce(async (_url, init) => {
          capturedPayloads.push(String(init?.body));
          capturedKeys.push(new Headers(init?.headers).get('idempotency-key') || '');
          return new Response(
            JSON.stringify({
              statusCode: 409,
              name: 'concurrent_idempotent_requests',
              message: 'Request still being processed',
            }),
            { status: 409, headers: { 'Content-Type': 'application/json' } }
          );
        })
        .mockImplementationOnce(async (_url, init) => {
          capturedPayloads.push(String(init?.body));
          capturedKeys.push(new Headers(init?.headers).get('idempotency-key') || '');
          return new Response(JSON.stringify({ id: 're_msg_after_retries_001' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        });

      try {
        // Attempt 1 -> 503 -> retried
        await runEmailOutboxPass({ randomFn: () => 0.5 });
        let row = await prisma.emailOutbox.findUniqueOrThrow({ where: { id: outbox.id } });
        expect(row.status).toBe(EmailOutboxStatus.PENDING);
        expect(row.attempts).toBe(1);
        expect(row.lastErrorCode).toBe('EMAIL_PROVIDER_UNAVAILABLE');
        expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

        // Make immediately due for attempt 2 -> 429 -> retried
        await prisma.emailOutbox.update({
          where: { id: outbox.id },
          data: { nextAttemptAt: new Date(Date.now() - 1000) },
        });
        await runEmailOutboxPass({ randomFn: () => 0.5 });
        row = await prisma.emailOutbox.findUniqueOrThrow({ where: { id: outbox.id } });
        expect(row.status).toBe(EmailOutboxStatus.PENDING);
        expect(row.attempts).toBe(2);
        expect(row.lastErrorCode).toBe('EMAIL_PROVIDER_RATE_LIMITED');

        // Make immediately due for attempt 3 -> 409 concurrent -> retried
        await prisma.emailOutbox.update({
          where: { id: outbox.id },
          data: { nextAttemptAt: new Date(Date.now() - 1000) },
        });
        await runEmailOutboxPass({ randomFn: () => 0.5 });
        row = await prisma.emailOutbox.findUniqueOrThrow({ where: { id: outbox.id } });
        expect(row.status).toBe(EmailOutboxStatus.PENDING);
        expect(row.attempts).toBe(3);
        expect(row.lastErrorCode).toBe('EMAIL_IDEMPOTENCY_CONCURRENT');

        // Make immediately due for attempt 4 -> 200 -> SENT
        await prisma.emailOutbox.update({
          where: { id: outbox.id },
          data: { nextAttemptAt: new Date(Date.now() - 1000) },
        });
        await runEmailOutboxPass({ randomFn: () => 0.5 });
        row = await prisma.emailOutbox.findUniqueOrThrow({ where: { id: outbox.id } });
        expect(row.status).toBe(EmailOutboxStatus.SENT);
        expect(row.attempts).toBe(4);
        expect(row.provider).toBe('resend');
        expect(row.providerMessageId).toBe('re_msg_after_retries_001');
        expect(row.sentAt).toBeInstanceOf(Date);

        // Verify all 4 requests used the identical idempotency key and byte-for-byte identical payload
        expect(fetchSpy).toHaveBeenCalledTimes(4);
        expect(new Set(capturedKeys).size).toBe(1);
        expect(capturedKeys[0]).toBe(`order-confirmation:${order.id}`);
        expect(new Set(capturedPayloads).size).toBe(1);
        expect(capturedPayloads[0]).not.toContain('MUTATED EVENT TITLE AFTER PURCHASE');
        expect(capturedPayloads[0]).not.toContain('MUTATED TIER NAME AFTER PURCHASE');
        expect(capturedPayloads[0]).toContain(originalEvent.title);
        expect(capturedPayloads[0]).toContain(originalTier.name);
      } finally {
        // Restore original event & tier names
        await prisma.event.update({
          where: { id: testEventId },
          data: { title: originalEvent.title },
        });
        await prisma.ticketTier.update({
          where: { id: testTierId },
          data: { name: originalTier.name },
        });
      }
    });

    it('marks 422, 409 payload conflict, missing API key, and exhausted retries as FAILED_PERMANENT without affecting order fulfillment', async () => {
      setEmailServiceTestOptions({ useResendInTest: true });
      const alertSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Case A: 422 permanent recipient rejection
      process.env.RESEND_API_KEY = fakeKey;
      const caseA = await createPendingTestOrder({ quantity: 1 });
      await fulfillPaidOrder(makeSucceededPaymentIntent(caseA.order, caseA.paymentIntentId));
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({ statusCode: 422, name: 'validation_error', message: 'Invalid email' }),
          { status: 422, headers: { 'Content-Type': 'application/json' } }
        )
      );
      await runEmailOutboxPass();
      const rowA = await prisma.emailOutbox.findUniqueOrThrow({
        where: { dedupeKey: `order_confirmation:${caseA.order.id}` },
      });
      expect(rowA.status).toBe(EmailOutboxStatus.FAILED_PERMANENT);
      expect(rowA.attempts).toBe(1);
      expect(rowA.lastErrorCode).toBe('EMAIL_DELIVERY_REJECTED');
      expect(rowA.failedAt).toBeInstanceOf(Date);

      // Case B: 409 payload conflict -> permanent implementation error, keeps original idempotency key
      const caseB = await createPendingTestOrder({ quantity: 1 });
      await fulfillPaidOrder(makeSucceededPaymentIntent(caseB.order, caseB.paymentIntentId));
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            statusCode: 409,
            name: 'invalid_idempotent_request',
            message: 'Different payload used with same idempotency key',
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } }
        )
      );
      await runEmailOutboxPass();
      const rowB = await prisma.emailOutbox.findUniqueOrThrow({
        where: { dedupeKey: `order_confirmation:${caseB.order.id}` },
      });
      expect(rowB.status).toBe(EmailOutboxStatus.FAILED_PERMANENT);
      expect(rowB.lastErrorCode).toBe('EMAIL_IDEMPOTENCY_PAYLOAD_CONFLICT');
      expect(rowB.idempotencyKey).toBe(`order-confirmation:${caseB.order.id}`);

      // Case C: Missing RESEND_API_KEY -> immediate config failure, does not waste 8 attempts
      process.env.RESEND_API_KEY = '';
      const caseC = await createPendingTestOrder({ quantity: 1 });
      await fulfillPaidOrder(makeSucceededPaymentIntent(caseC.order, caseC.paymentIntentId));
      await runEmailOutboxPass();
      const rowC = await prisma.emailOutbox.findUniqueOrThrow({
        where: { dedupeKey: `order_confirmation:${caseC.order.id}` },
      });
      expect(rowC.status).toBe(EmailOutboxStatus.FAILED_PERMANENT);
      expect(rowC.attempts).toBe(1);
      expect(rowC.lastErrorCode).toBe('EMAIL_SERVICE_UNCONFIGURED');

      // Case D: Transient error on final maxAttempt transitions to FAILED_PERMANENT
      process.env.RESEND_API_KEY = fakeKey;
      const caseD = await createPendingTestOrder({ quantity: 1 });
      await fulfillPaidOrder(makeSucceededPaymentIntent(caseD.order, caseD.paymentIntentId));
      await prisma.emailOutbox.update({
        where: { dedupeKey: `order_confirmation:${caseD.order.id}` },
        data: { attempts: EMAIL_OUTBOX_MAX_ATTEMPTS - 1 },
      });
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({ statusCode: 503, name: 'application_error', message: 'Still down' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        )
      );
      await runEmailOutboxPass();
      const rowD = await prisma.emailOutbox.findUniqueOrThrow({
        where: { dedupeKey: `order_confirmation:${caseD.order.id}` },
      });
      expect(rowD.status).toBe(EmailOutboxStatus.FAILED_PERMANENT);
      expect(rowD.attempts).toBe(EMAIL_OUTBOX_MAX_ATTEMPTS);
      expect(rowD.failedAt).toBeInstanceOf(Date);

      // Verify all 4 orders remained COMPLETED with their issued tickets intact
      for (const orderId of [caseA.order.id, caseB.order.id, caseC.order.id, caseD.order.id]) {
        const checkOrder = await prisma.order.findUnique({
          where: { id: orderId },
          include: { tickets: true },
        });
        expect(checkOrder?.status).toBe(OrderStatus.COMPLETED);
        expect(checkOrder?.tickets).toHaveLength(1);
      }

      // Verify alerts were emitted and never leaked orderAccessTokens or API key
      const alertText = alertSpy.mock.calls.flat().map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(' ');
      expect(alertText).toContain('EMAIL_CONFIG_FAILURE');
      expect(alertText).toContain('RESEND_IDEMPOTENCY_PAYLOAD_CONFLICT');
      expect(alertText).toContain('RETRIES_EXHAUSTED');
      expect(alertText).not.toContain(fakeKey);
      expect(alertText).not.toContain(caseA.order.orderAccessToken!);
    });

    it('keeps rendered confirmation URL and complete Resend payload byte-for-byte identical when CLIENT_URL changes after enqueueing', async () => {
      process.env.RESEND_API_KEY = fakeKey;
      process.env.CLIENT_URL = 'https://ORIGIN-A.out-side.vip///';
      setEmailServiceTestOptions({ useResendInTest: true });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { order, paymentIntentId } = await createPendingTestOrder({ quantity: 2 });
      await fulfillPaidOrder(makeSucceededPaymentIntent(order, paymentIntentId));

      const enqueuedRow = await prisma.emailOutbox.findUniqueOrThrow({
        where: { dedupeKey: `order_confirmation:${order.id}` },
      });

      // Verify normalized origin A was snapshotted and bearer token is absent from snapshot
      const snapshotJson = JSON.stringify(enqueuedRow.contentSnapshot);
      expect((enqueuedRow.contentSnapshot as any).clientOrigin).toBe(
        'https://origin-a.out-side.vip'
      );
      expect(snapshotJson).not.toContain(order.orderAccessToken!);
      expect(snapshotJson).not.toContain('orderAccessToken');

      const capturedPayloads: string[] = [];
      const capturedKeys: string[] = [];

      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementationOnce(async (_url, init) => {
          capturedPayloads.push(String(init?.body));
          capturedKeys.push(new Headers(init?.headers).get('idempotency-key') || '');
          return new Response(
            JSON.stringify({
              statusCode: 503,
              name: 'application_error',
              message: `Upstream failure referencing ${order.orderAccessToken}`,
            }),
            { status: 503, headers: { 'Content-Type': 'application/json' } }
          );
        })
        .mockImplementationOnce(async (_url, init) => {
          capturedPayloads.push(String(init?.body));
          capturedKeys.push(new Headers(init?.headers).get('idempotency-key') || '');
          return new Response(JSON.stringify({ id: 're_msg_origin_stable_001' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        });

      // Attempt 1 under CLIENT_URL A -> transient 503 -> scheduled for retry
      await runEmailOutboxPass({ randomFn: () => 0.5 });
      const afterAttempt1 = await prisma.emailOutbox.findUniqueOrThrow({
        where: { id: enqueuedRow.id },
      });
      expect(afterAttempt1.status).toBe(EmailOutboxStatus.PENDING);
      expect(afterAttempt1.attempts).toBe(1);
      expect(afterAttempt1.lastErrorMessage).not.toContain(order.orderAccessToken!);

      // Mutate CLIENT_URL to value B BEFORE retry
      process.env.CLIENT_URL = 'https://origin-b.different-domain.example';
      await prisma.emailOutbox.update({
        where: { id: enqueuedRow.id },
        data: { nextAttemptAt: new Date(Date.now() - 1000) },
      });

      // Attempt 2 under mutated CLIENT_URL B -> succeeds with identical payload using origin A
      await runEmailOutboxPass({ randomFn: () => 0.5 });
      const afterAttempt2 = await prisma.emailOutbox.findUniqueOrThrow({
        where: { id: enqueuedRow.id },
      });
      expect(afterAttempt2.status).toBe(EmailOutboxStatus.SENT);
      expect(afterAttempt2.providerMessageId).toBe('re_msg_origin_stable_001');
      expect(afterAttempt2.attempts).toBe(2);

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(capturedKeys).toEqual([
        `order-confirmation:${order.id}`,
        `order-confirmation:${order.id}`,
      ]);
      // Complete Resend request body (from, to, subject, text, html) must be byte-for-byte identical
      expect(capturedPayloads[1]).toBe(capturedPayloads[0]);

      const expectedUrl = `https://origin-a.out-side.vip/orders/${order.orderNumber}?token=${order.orderAccessToken}`;
      const parsedBody = JSON.parse(capturedPayloads[1]);
      expect(parsedBody.html).toContain(expectedUrl);
      expect(parsedBody.text).toContain(expectedUrl);
      expect(parsedBody.html).not.toContain('origin-b.different-domain.example');
      expect(parsedBody.text).not.toContain('origin-b.different-domain.example');

      // Confirm bearer token never leaked into logs
      const allLogs = [
        ...logSpy.mock.calls,
        ...warnSpy.mock.calls,
        ...errorSpy.mock.calls,
      ]
        .flat()
        .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
        .join(' ');
      expect(allLogs).not.toContain(order.orderAccessToken!);
      expect(allLogs).not.toContain(fakeKey);
    });
  });

  describe('4. Payment Isolation, Unpaid Guards, Preservation Safeguard & End-to-End Ticket/PDF Access', () => {
    it('creates zero outbox rows for failed, unpaid, mismatched, or expired orders', async () => {
      // Failed payment webhook
      const failed = await createPendingTestOrder({ quantity: 1 });
      const failedEvtId = `evt_p101_fail_${nanoid(10)}`;
      createdWebhookEventIds.push(failedEvtId);
      await processStripeWebhookEvent({
        id: failedEvtId,
        type: 'payment_intent.payment_failed',
        data: {
          object: {
            id: failed.paymentIntentId,
            amount: failed.order.totalInCents,
            currency: 'usd',
            metadata: { orderId: failed.order.id },
            last_payment_error: { message: 'Card declined' },
          },
        },
      } as any);

      // Amount mismatch -> throws & rolls back
      const mismatch = await createPendingTestOrder({ quantity: 1 });
      await expect(
        fulfillPaidOrder({
          id: mismatch.paymentIntentId,
          status: 'succeeded',
          amount: mismatch.order.totalInCents - 100,
          currency: 'usd',
          metadata: { orderId: mismatch.order.id },
        } as any)
      ).rejects.toThrow(/Amount mismatch/);

      // Unpaid PaymentIntent status ('processing')
      const processing = await createPendingTestOrder({ quantity: 1 });
      await fulfillPaidOrder({
        id: processing.paymentIntentId,
        status: 'processing',
        amount: processing.order.totalInCents,
        currency: 'usd',
        metadata: { orderId: processing.order.id },
      } as any);

      // Expired order
      const expired = await createPendingTestOrder({
        quantity: 1,
        status: OrderStatus.EXPIRED,
        expired: true,
      });

      const outboxCount = await prisma.emailOutbox.count({
        where: {
          orderId: {
            in: [failed.order.id, mismatch.order.id, processing.order.id, expired.order.id],
          },
        },
      });
      expect(outboxCount).toBe(0);
    });

    it('never issues tickets during email processing and blocks sending for non-COMPLETED orders', async () => {
      const { order } = await createPendingTestOrder({ quantity: 2 });
      vi.spyOn(console, 'error').mockImplementation(() => {});

      // Manually insert a rogue outbox row pointing to a still-PENDING order
      const rogue = await prisma.emailOutbox.create({
        data: {
          dedupeKey: `order_confirmation:${order.id}`,
          type: EmailOutboxType.ORDER_CONFIRMATION,
          status: EmailOutboxStatus.PENDING,
          orderId: order.id,
          recipientEmail: order.customerEmail,
          idempotencyKey: `order-confirmation:${order.id}`,
          templateVersion: 1,
          contentSnapshot: { templateVersion: 1, orderNumber: order.orderNumber } as any,
        },
      });
      createdOutboxIds.push(rogue.id);

      await runEmailOutboxPass();

      const updatedRogue = await prisma.emailOutbox.findUniqueOrThrow({ where: { id: rogue.id } });
      expect(updatedRogue.status).toBe(EmailOutboxStatus.FAILED_PERMANENT);
      expect(updatedRogue.lastErrorCode).toBe('ORDER_NOT_COMPLETED');

      const tickets = await prisma.ticket.findMany({ where: { orderId: order.id } });
      expect(tickets).toHaveLength(0);
      expect(sentOrderConfirmationEmails).toHaveLength(0);
    });

    it('preserves pending EmailOutbox record (SetNull) when an order is deleted instead of silently cascading deletion', async () => {
      const { order, paymentIntentId } = await createPendingTestOrder({ quantity: 1 });
      await fulfillPaidOrder(makeSucceededPaymentIntent(order, paymentIntentId));
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const outbox = await prisma.emailOutbox.findUniqueOrThrow({
        where: { dedupeKey: `order_confirmation:${order.id}` },
      });
      createdOutboxIds.push(outbox.id);

      // Delete the order
      await prisma.financialLedgerEntry.deleteMany({ where: { orderId: order.id } });
      await prisma.order.delete({ where: { id: order.id } });

      // Outbox row must still exist with orderId = null (not silently deleted)
      const preserved = await prisma.emailOutbox.findUnique({ where: { id: outbox.id } });
      expect(preserved).not.toBeNull();
      expect(preserved?.orderId).toBeNull();
      expect(preserved?.status).toBe(EmailOutboxStatus.PENDING);

      // Worker surfaces ORDER_MISSING explicitly instead of crashing or silently losing it
      await runEmailOutboxPass();
      const failed = await prisma.emailOutbox.findUniqueOrThrow({ where: { id: outbox.id } });
      expect(failed.status).toBe(EmailOutboxStatus.FAILED_PERMANENT);
      expect(failed.lastErrorCode).toBe('ORDER_MISSING');
    });

    it('delivers a working secure ticket-access link that unlocks both order details and PDF download while rejecting unauthorized access', async () => {
      const { order, paymentIntentId } = await createPendingTestOrder({ quantity: 2 });
      await fulfillPaidOrder(makeSucceededPaymentIntent(order, paymentIntentId));
      await runEmailOutboxPass();

      const recorded = getLatestOrderConfirmationEmail(order.customerEmail);
      expect(recorded).toBeDefined();

      const parsedUrl = new URL(recorded!.ticketAccessUrl);
      expect(parsedUrl.pathname).toBe(`/orders/${order.orderNumber}`);
      expect(Array.from(parsedUrl.searchParams.keys())).toEqual(['token']);
      const extractedToken = parsedUrl.searchParams.get('token');
      expect(extractedToken).toBe(order.orderAccessToken);

      // Valid token unlocks order lookup
      const orderRes = await request(app).get(
        `/api/orders/${order.orderNumber}?token=${encodeURIComponent(extractedToken!)}`
      );
      expect(orderRes.status).toBe(200);
      expect(orderRes.body.data.order.status).toBe(OrderStatus.COMPLETED);
      expect(orderRes.body.data.order.tickets).toHaveLength(2);
      expect(orderRes.body.data.order.tickets[0].status).toBe(TicketStatus.ISSUED);

      // Valid token unlocks existing PDF ticket download endpoint
      const pdfRes = await request(app).get(
        `/api/orders/${order.orderNumber}/tickets/pdf?token=${encodeURIComponent(extractedToken!)}`
      );
      expect(pdfRes.status).toBe(200);
      expect(pdfRes.headers['content-type']).toContain('application/pdf');

      // Missing and invalid tokens remain strictly blocked
      const noTokenRes = await request(app).get(`/api/orders/${order.orderNumber}`);
      expect(noTokenRes.status).toBe(401);

      const wrongTokenRes = await request(app).get(
        `/api/orders/${order.orderNumber}?token=oat_invalid_wrong_token_00000000`
      );
      expect(wrongTokenRes.status).toBe(403);

      const wrongPdfRes = await request(app).get(
        `/api/orders/${order.orderNumber}/tickets/pdf?token=oat_invalid_wrong_token_00000000`
      );
      expect(wrongPdfRes.status).toBe(403);
    });
  });
});

