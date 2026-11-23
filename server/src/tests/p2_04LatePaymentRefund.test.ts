import crypto from 'crypto';
import request from 'supertest';
import Stripe from 'stripe';
import { nanoid } from 'nanoid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EmailOutboxStatus,
  EmailOutboxType,
  EventStatus,
  LedgerBalanceType,
  LedgerEntryType,
  OrderRefundStatus,
  OrderStatus,
  PaymentProvider,
  PaymentStatus,
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
  resetEmailServiceTestOptions,
  sentLatePaymentRefundEmails,
  sentOrderConfirmationEmails,
} from '../lib/email.service.js';
import {
  runEmailOutboxPass,
} from '../modules/notifications/emailOutbox.service.js';
import {
  stopEmailOutboxWorker as stopEmailWorkerLifecycle,
} from '../modules/notifications/emailOutboxWorker.js';
import {
  fulfillPaidOrder,
  processStripeWebhookEvent,
} from '../modules/webhooks/webhook.service.js';
import { releaseExpiredReservations } from '../modules/checkout/checkout.service.js';
import { processWaitlistForTier, hashOfferToken } from '../modules/waitlist/waitlist.service.js';
import {
  claimPendingOrderRefundBatch,
  ORDER_REFUND_MAX_ATTEMPTS,
  reapExpiredExhaustedRefundLeases,
  resolveManualOrderRefund,
  runOrderRefundPass,
} from '../modules/refunds/orderRefund.service.js';
import {
  isOrderRefundWorkerRunning,
  startOrderRefundWorker,
  stopOrderRefundWorker,
} from '../modules/refunds/orderRefundWorker.js';
import { stopWaitlistBackgroundWorker } from '../modules/waitlist/waitlistWorker.js';

describe('P2-04 Late Payment Protection & Automatic Stripe Refund (Real PostgreSQL)', () => {
  const runId = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const createdOrganizerIds: string[] = [];
  const createdEventIds: string[] = [];
  const createdOrderIds: string[] = [];
  const createdWebhookEventIds: string[] = [];

  let defaultOrganizer: any;
  let adminActor: any;

  async function createOrganizerAndEvent(opts?: {
    suffix?: string;
    status?: EventStatus;
    endAt?: Date;
  }) {
    const suffix = opts?.suffix || nanoid(6);
    const organizer = await prisma.user.create({
      data: {
        email: `p204_lp_org_${suffix}_${runId}@outside.vip`,
        name: `P204 Org ${suffix}`,
        role: Role.ORGANIZER,
        emailVerified: true,
      },
    });
    createdOrganizerIds.push(organizer.id);

    const event = await prisma.event.create({
      data: {
        organizerId: organizer.id,
        title: `P204 LatePay Event ${suffix}`,
        description: 'Late payment refund test event',
        coverImageUrl: 'https://example.com/p204-lp.jpg',
        venueName: 'Skyline Hall',
        venueAddress: '500 Nairobi Way',
        city: 'Nairobi',
        country: 'Kenya',
        slug: `p204-lp-${suffix}-${runId}`.toLowerCase(),
        category: 'MUSIC',
        status: opts?.status ?? EventStatus.PUBLISHED,
        startAt: new Date(Date.now() - 3600_000),
        endAt: opts?.endAt ?? new Date(Date.now() + 7 * 86400_000),
        timezone: 'Africa/Nairobi',
      },
    });
    createdEventIds.push(event.id);
    return { organizer, event };
  }

  async function createTier(opts: {
    eventId: string;
    name?: string;
    priceInCents?: number;
    totalCapacity?: number;
    reservedQuantity?: number;
    soldQuantity?: number;
    status?: TicketTierStatus;
    isHidden?: boolean;
    salesDisabled?: boolean;
    waitlistEnabled?: boolean;
    salesStartAt?: Date | null;
    salesEndAt?: Date | null;
  }) {
    return prisma.ticketTier.create({
      data: {
        eventId: opts.eventId,
        name: opts.name || `Tier ${nanoid(4)}`,
        priceInCents: opts.priceInCents ?? 2500,
        currency: 'USD',
        totalCapacity: opts.totalCapacity ?? 10,
        reservedQuantity: opts.reservedQuantity ?? 0,
        soldQuantity: opts.soldQuantity ?? 0,
        minPerOrder: 1,
        maxPerOrder: 10,
        status: opts.status ?? TicketTierStatus.ACTIVE,
        isHidden: opts.isHidden ?? false,
        salesDisabled: opts.salesDisabled ?? false,
        waitlistEnabled: opts.waitlistEnabled ?? false,
        salesStartAt: opts.salesStartAt ?? null,
        salesEndAt: opts.salesEndAt ?? null,
      },
    });
  }

  async function createOrderFixture(opts: {
    eventId: string;
    tierId: string;
    quantity: number;
    status: OrderStatus;
    reservationStatus?: ReservationStatus;
    withReservations?: boolean;
    expiresAt?: Date;
    paymentReference?: string;
    unitPriceInCents?: number;
  }) {
    const unitPrice = opts.unitPriceInCents ?? 2500;
    const organizerNet = unitPrice * opts.quantity;
    const totalInCents = organizerNet + 200; // includes $2.00 fees
    const piId = opts.paymentReference || `pi_p204_${nanoid(16)}`;
    const exp = opts.expiresAt ?? new Date(Date.now() - 10 * 60_000);

    const order = await prisma.order.create({
      data: {
        orderNumber: `LP-${nanoid(8).toUpperCase()}`,
        eventId: opts.eventId,
        status: opts.status,
        customerEmail: `buyer_${nanoid(6)}@outside.vip`,
        customerName: 'Late Buyer',
        totalInCents,
        platformFeeInCents: 200,
        organizerNetInCents: organizerNet,
        currency: 'USD',
        idempotencyKey: `idem_${nanoid(18)}`,
        orderAccessToken: `oat_${nanoid(24)}`,
        paymentReference: piId,
        expiresAt: exp,
        items: {
          create: {
            ticketTierId: opts.tierId,
            quantity: opts.quantity,
            unitPriceInCents: unitPrice,
            subtotalInCents: organizerNet,
          },
        },
        ...(opts.withReservations === false
          ? {}
          : {
              reservations: {
                create: {
                  ticketTierId: opts.tierId,
                  quantity: opts.quantity,
                  expiresAt: exp,
                  status:
                    opts.reservationStatus ??
                    (opts.status === OrderStatus.PENDING
                      ? ReservationStatus.ACTIVE
                      : ReservationStatus.RELEASED),
                },
              },
            }),
      },
    });
    createdOrderIds.push(order.id);
    return { order, paymentIntentId: piId };
  }

  function makePiSucceededEvent(orderId: string, paymentIntentId: string, amount: number, eventId?: string): Stripe.Event {
    const evtId = eventId || `evt_pi_${nanoid(16)}`;
    createdWebhookEventIds.push(evtId);
    return {
      id: evtId,
      object: 'event',
      api_version: '2024-12-18.acacia',
      created: Math.floor(Date.now() / 1000),
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: paymentIntentId,
          object: 'payment_intent',
          status: 'succeeded',
          amount,
          currency: 'usd',
          latest_charge: `ch_${nanoid(14)}`,
          metadata: { orderId },
        } as any,
      },
    } as any;
  }

  beforeAll(async () => {
    await stopWaitlistBackgroundWorker(0);
    await stopEmailWorkerLifecycle(0);
    await stopOrderRefundWorker(0);

    const setup = await createOrganizerAndEvent({ suffix: 'default' });
    defaultOrganizer = setup.organizer;

    adminActor = await prisma.user.create({
      data: {
        email: `p204_lp_admin_${runId}@outside.vip`,
        name: 'P204 Admin Reviewer',
        role: Role.ADMIN,
        emailVerified: true,
      },
    });
    createdOrganizerIds.push(adminActor.id);
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    resetEmailServiceTestOptions();
    sentOrderConfirmationEmails.length = 0;
    sentLatePaymentRefundEmails.length = 0;
    await stopWaitlistBackgroundWorker(0);
    await stopEmailWorkerLifecycle(0);
    await stopOrderRefundWorker(0);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await stopWaitlistBackgroundWorker(0);
    await stopEmailWorkerLifecycle(0);
    await stopOrderRefundWorker(0);

    // Isolate queue-polling tests so unconsumed PENDING rows from prior tests
    // in this suite never spill into subsequent worker pass assertions.
    if (createdOrderIds.length > 0) {
      await prisma.emailOutbox.deleteMany({
        where: { orderId: { in: createdOrderIds } },
      });
      await prisma.orderRefund.deleteMany({
        where: { orderId: { in: createdOrderIds } },
      });
    }
  });

  afterAll(async () => {
    await stopWaitlistBackgroundWorker(0);
    await stopEmailWorkerLifecycle(0);
    await stopOrderRefundWorker(0);

    if (createdWebhookEventIds.length > 0) {
      await prisma.processedWebhookEvent.deleteMany({
        where: { eventId: { in: createdWebhookEventIds } },
      });
    }
    if (createdOrderIds.length > 0) {
      await prisma.orderRefund.deleteMany({ where: { orderId: { in: createdOrderIds } } });
      await prisma.emailOutbox.deleteMany({ where: { orderId: { in: createdOrderIds } } });
      await prisma.financialLedgerEntry.deleteMany({ where: { orderId: { in: createdOrderIds } } });
      await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
    }
    if (createdEventIds.length > 0) {
      await prisma.event.deleteMany({ where: { id: { in: createdEventIds } } });
    }
    if (createdOrganizerIds.length > 0) {
      await prisma.adminAuditLog.deleteMany({
        where: { actorUserId: { in: createdOrganizerIds } },
      });
      await prisma.organizerBalance.deleteMany({
        where: { userId: { in: createdOrganizerIds } },
      });
      await prisma.user.deleteMany({ where: { id: { in: createdOrganizerIds } } });
    }
  });

  describe('1. Eligibility Decision Rules (Rules 2A - 2F)', () => {
    it('1. fulfills normal PENDING order with active reservations unchanged', async () => {
      const { organizer, event } = await createOrganizerAndEvent({ suffix: 'rule-a' });
      const tier = await createTier({
        eventId: event.id,
        totalCapacity: 5,
        reservedQuantity: 2,
        soldQuantity: 1,
      });
      const { order, paymentIntentId } = await createOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        quantity: 2,
        status: OrderStatus.PENDING,
        reservationStatus: ReservationStatus.ACTIVE,
        expiresAt: new Date(Date.now() + 15 * 60_000),
      });

      await processStripeWebhookEvent(makePiSucceededEvent(order.id, paymentIntentId, order.totalInCents));
      await runEmailOutboxPass();

      const updatedOrder = await prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        include: { tickets: true, reservations: true, refunds: true },
      });
      const updatedTier = await prisma.ticketTier.findUniqueOrThrow({ where: { id: tier.id } });
      const balance = await prisma.organizerBalance.findUnique({ where: { userId: organizer.id } });

      expect(updatedOrder.status).toBe(OrderStatus.COMPLETED);
      expect(updatedOrder.tickets).toHaveLength(2);
      expect(updatedOrder.reservations[0].status).toBe(ReservationStatus.CONFIRMED);
      expect(updatedOrder.refunds).toHaveLength(0);
      expect(updatedTier.reservedQuantity).toBe(0);
      expect(updatedTier.soldQuantity).toBe(3);
      expect(balance?.pendingBalanceInCents).toBe(order.organizerNetInCents);
      expect(sentOrderConfirmationEmails.some((e) => e.orderNumber === order.orderNumber)).toBe(true);
    });

    it('2. fulfills EXPIRED order with released reservations when capacity remains genuinely unallocated', async () => {
      const { organizer, event } = await createOrganizerAndEvent({ suffix: 'rule-b' });
      const tier = await createTier({
        eventId: event.id,
        totalCapacity: 5,
        reservedQuantity: 1,
        soldQuantity: 2, // 2 left unallocated
      });
      const { order, paymentIntentId } = await createOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        quantity: 2,
        status: OrderStatus.EXPIRED,
        reservationStatus: ReservationStatus.RELEASED,
      });

      await processStripeWebhookEvent(makePiSucceededEvent(order.id, paymentIntentId, order.totalInCents));

      const updatedOrder = await prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        include: { tickets: true, refunds: true },
      });
      const updatedTier = await prisma.ticketTier.findUniqueOrThrow({ where: { id: tier.id } });
      const balance = await prisma.organizerBalance.findUnique({ where: { userId: organizer.id } });

      expect(updatedOrder.status).toBe(OrderStatus.COMPLETED);
      expect(updatedOrder.tickets).toHaveLength(2);
      expect(updatedOrder.refunds).toHaveLength(0);
      // Increment soldQuantity without decrementing unrelated reservedQuantity
      expect(updatedTier.soldQuantity).toBe(4);
      expect(updatedTier.reservedQuantity).toBe(1);
      expect(balance?.pendingBalanceInCents).toBe(order.organizerNetInCents);
    });

    it('3. creates one full refund and issues zero tickets when EXPIRED order capacity was reallocated', async () => {
      const { organizer, event } = await createOrganizerAndEvent({ suffix: 'rule-c' });
      const tier = await createTier({
        eventId: event.id,
        totalCapacity: 3,
        reservedQuantity: 1,
        soldQuantity: 2, // 0 unallocated capacity remaining
      });
      const { order, paymentIntentId } = await createOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        quantity: 2,
        status: OrderStatus.EXPIRED,
        reservationStatus: ReservationStatus.RELEASED,
      });

      await processStripeWebhookEvent(makePiSucceededEvent(order.id, paymentIntentId, order.totalInCents));

      const orderAfter = await prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        include: { tickets: true, refunds: true, transactions: true },
      });
      const tierAfter = await prisma.ticketTier.findUniqueOrThrow({ where: { id: tier.id } });
      const balance = await prisma.organizerBalance.findUnique({ where: { userId: organizer.id } });
      const ledgerCount = await prisma.financialLedgerEntry.count({ where: { orderId: order.id } });
      const confirmEmailCount = await prisma.emailOutbox.count({
        where: { orderId: order.id, type: EmailOutboxType.ORDER_CONFIRMATION },
      });

      expect(orderAfter.status).toBe(OrderStatus.EXPIRED); // remains EXPIRED until Stripe confirms refund
      expect(orderAfter.tickets).toHaveLength(0);
      expect(tierAfter.soldQuantity).toBe(2);
      expect(tierAfter.reservedQuantity).toBe(1);
      expect(balance).toBeNull();
      expect(ledgerCount).toBe(0);
      expect(confirmEmailCount).toBe(0);
      expect(orderAfter.transactions.some((t) => t.status === PaymentStatus.SUCCEEDED && t.providerTransactionId === paymentIntentId)).toBe(true);
      expect(orderAfter.refunds).toHaveLength(1);
      expect(orderAfter.refunds[0].status).toBe(OrderRefundStatus.PENDING);
      expect(orderAfter.refunds[0].amountInCents).toBe(order.totalInCents);
      expect(orderAfter.refunds[0].reason).toBe('LATE_PAYMENT_CAPACITY_REALLOCATED');
    });

    it('4. queues an automatic refund for a CANCELLED order', async () => {
      const { event } = await createOrganizerAndEvent({ suffix: 'rule-d-cancel' });
      const tier = await createTier({ eventId: event.id, totalCapacity: 10 });
      const { order, paymentIntentId } = await createOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        quantity: 1,
        status: OrderStatus.CANCELLED,
        reservationStatus: ReservationStatus.RELEASED,
      });

      await processStripeWebhookEvent(makePiSucceededEvent(order.id, paymentIntentId, order.totalInCents));

      const refund = await prisma.orderRefund.findUniqueOrThrow({
        where: { stripePaymentIntentId: paymentIntentId },
      });
      const updatedOrder = await prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        include: { tickets: true },
      });
      expect(refund.status).toBe(OrderRefundStatus.PENDING);
      expect(refund.reason).toBe('ORDER_CANCELLED_LATE_PAYMENT');
      expect(updatedOrder.status).toBe(OrderStatus.CANCELLED);
      expect(updatedOrder.tickets).toHaveLength(0);
    });

    it('5. queues an automatic refund when event is closed/cancelled/ended or tier sales window has closed', async () => {
      const { event: closedEvent } = await createOrganizerAndEvent({
        suffix: 'rule-d-ended',
        endAt: new Date(Date.now() - 60_000),
      });
      const endedTier = await createTier({ eventId: closedEvent.id, totalCapacity: 10 });
      const expiredOnEnded = await createOrderFixture({
        eventId: closedEvent.id,
        tierId: endedTier.id,
        quantity: 1,
        status: OrderStatus.EXPIRED,
        reservationStatus: ReservationStatus.RELEASED,
      });

      await processStripeWebhookEvent(
        makePiSucceededEvent(expiredOnEnded.order.id, expiredOnEnded.paymentIntentId, expiredOnEnded.order.totalInCents)
      );
      const refundEnded = await prisma.orderRefund.findUniqueOrThrow({
        where: { stripePaymentIntentId: expiredOnEnded.paymentIntentId },
      });
      expect(refundEnded.reason).toBe('EVENT_OR_SALES_CLOSED');

      const { event: openEvent } = await createOrganizerAndEvent({ suffix: 'rule-d-salesend' });
      const closedSalesTier = await createTier({
        eventId: openEvent.id,
        totalCapacity: 10,
        reservedQuantity: 1,
        salesEndAt: new Date(Date.now() - 60_000),
      });
      const pendingClosedWindow = await createOrderFixture({
        eventId: openEvent.id,
        tierId: closedSalesTier.id,
        quantity: 1,
        status: OrderStatus.PENDING,
        reservationStatus: ReservationStatus.ACTIVE,
        expiresAt: new Date(Date.now() + 10 * 60_000),
      });

      await processStripeWebhookEvent(
        makePiSucceededEvent(
          pendingClosedWindow.order.id,
          pendingClosedWindow.paymentIntentId,
          pendingClosedWindow.order.totalInCents
        )
      );
      const refundClosedWindow = await prisma.orderRefund.findUniqueOrThrow({
        where: { stripePaymentIntentId: pendingClosedWindow.paymentIntentId },
      });
      const refreshedTier = await prisma.ticketTier.findUniqueOrThrow({ where: { id: closedSalesTier.id } });
      expect(refundClosedWindow.reason).toBe('EVENT_OR_SALES_CLOSED');
      expect(refreshedTier.reservedQuantity).toBe(0); // released hold from rejected pending order
    });

    it('6. expired waitlist offer does not overwrite reallocated waitlist/buyer capacity', async () => {
      const { event } = await createOrganizerAndEvent({ suffix: 'rule-e-wl' });
      const tier = await createTier({
        eventId: event.id,
        totalCapacity: 1,
        reservedQuantity: 1,
        soldQuantity: 0,
        waitlistEnabled: true,
      });

      const entry1 = await prisma.ticketWaitlistEntry.create({
        data: {
          eventId: event.id,
          ticketTierId: tier.id,
          customerName: 'Waitlist First',
          customerEmail: `wl1_${nanoid(5)}@outside.vip`,
          quantity: 1,
          status: WaitlistEntryStatus.OFFERED,
        },
      });
      const { order: offerOrder, paymentIntentId } = await createOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        quantity: 1,
        status: OrderStatus.PENDING,
        reservationStatus: ReservationStatus.ACTIVE,
        expiresAt: new Date(Date.now() - 60_000),
      });
      const expiredOffer = await prisma.ticketWaitlistOffer.create({
        data: {
          entryId: entry1.id,
          eventId: event.id,
          ticketTierId: tier.id,
          quantity: 1,
          status: WaitlistOfferStatus.PENDING,
          tokenHash: hashOfferToken(`tok_${nanoid(12)}`),
          expiresAt: new Date(Date.now() - 60_000),
          orderId: offerOrder.id,
        },
      });

      // Another waitlist entrant joins before expiry sweep runs
      const entry2 = await prisma.ticketWaitlistEntry.create({
        data: {
          eventId: event.id,
          ticketTierId: tier.id,
          customerName: 'Waitlist Second',
          customerEmail: `wl2_${nanoid(5)}@outside.vip`,
          quantity: 1,
          status: WaitlistEntryStatus.WAITING,
        },
      });

      // Expiry releases order1's hold and advances capacity to entry2
      await releaseExpiredReservations();
      await processWaitlistForTier(tier.id);

      const entry2After = await prisma.ticketWaitlistEntry.findUniqueOrThrow({ where: { id: entry2.id } });
      expect(entry2After.status).toBe(WaitlistEntryStatus.OFFERED);

      // Late payment arrives for offerOrder after entry2 took the 1 available seat
      await processStripeWebhookEvent(
        makePiSucceededEvent(offerOrder.id, paymentIntentId, offerOrder.totalInCents)
      );

      const refund = await prisma.orderRefund.findUniqueOrThrow({
        where: { stripePaymentIntentId: paymentIntentId },
      });
      const offerAfter = await prisma.ticketWaitlistOffer.findUniqueOrThrow({ where: { id: expiredOffer.id } });
      const tierAfter = await prisma.ticketTier.findUniqueOrThrow({ where: { id: tier.id } });
      expect(offerAfter.status).toBe(WaitlistOfferStatus.EXPIRED);
      expect(refund.reason).toBe('LATE_PAYMENT_CAPACITY_REALLOCATED');
      expect(tierAfter.soldQuantity).toBe(0);
      expect(tierAfter.reservedQuantity).toBe(1); // entry2's offer hold preserved
    });

    it('also prevents orders controller lookup from fulfilling an EXPIRED order', async () => {
      const { event } = await createOrganizerAndEvent({ suffix: 'orders-reconcile' });
      const tier = await createTier({ eventId: event.id, totalCapacity: 5, soldQuantity: 5 });
      const { order, paymentIntentId } = await createOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        quantity: 1,
        status: OrderStatus.EXPIRED,
        reservationStatus: ReservationStatus.RELEASED,
      });

      const retrieveSpy = vi.spyOn(stripe.paymentIntents, 'retrieve').mockResolvedValue({
        id: paymentIntentId,
        status: 'succeeded',
        amount: order.totalInCents,
        currency: 'usd',
      } as any);

      const res = await request(app)
        .get(`/api/orders/${order.orderNumber}`)
        .query({ token: order.orderAccessToken });

      expect(res.status).toBe(200);
      expect(res.body.data.order.status).toBe('EXPIRED');
      expect(res.body.data.order.tickets).toHaveLength(0);
      expect(retrieveSpy).not.toHaveBeenCalled();
    });
  });

  describe('2. Webhook Idempotency, Reconciliation & Concurrency', () => {
    it('7 & 8. handles duplicate same-eventId webhooks and distinct eventIds for the same PaymentIntent', async () => {
      const { event } = await createOrganizerAndEvent({ suffix: 'dup-evt' });
      const tier = await createTier({ eventId: event.id, totalCapacity: 1, soldQuantity: 1 });
      const { order, paymentIntentId } = await createOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        quantity: 1,
        status: OrderStatus.EXPIRED,
        reservationStatus: ReservationStatus.RELEASED,
      });

      const evt1 = makePiSucceededEvent(order.id, paymentIntentId, order.totalInCents, `evt_same_${nanoid(10)}`);
      const r1 = await processStripeWebhookEvent(evt1);
      const r1Dup = await processStripeWebhookEvent(evt1);
      const evt2 = makePiSucceededEvent(order.id, paymentIntentId, order.totalInCents, `evt_distinct_${nanoid(10)}`);
      const r2 = await processStripeWebhookEvent(evt2);

      expect(r1.duplicate).toBeUndefined();
      expect(r1Dup.duplicate).toBe(true);
      expect(r2.handled).toBe(true);

      const refunds = await prisma.orderRefund.findMany({ where: { orderId: order.id } });
      expect(refunds).toHaveLength(1);
    });

    it('9. serializes concurrent webhook delivery and fulfillPaidOrder reconciliation under PostgreSQL locks', async () => {
      const { event } = await createOrganizerAndEvent({ suffix: 'conc-wh' });
      const tier = await createTier({ eventId: event.id, totalCapacity: 1, soldQuantity: 1 });
      const { order, paymentIntentId } = await createOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        quantity: 1,
        status: OrderStatus.EXPIRED,
        reservationStatus: ReservationStatus.RELEASED,
      });

      // Deterministic barrier holding Order lock before firing concurrent callers
      let releaseBarrier!: () => void;
      const barrierReleased = new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });
      let lockAcquired!: () => void;
      const lockHeld = new Promise<void>((resolve) => {
        lockAcquired = resolve;
      });

      const holderPromise = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${order.id} FOR UPDATE`;
        lockAcquired();
        await barrierReleased;
      });

      await lockHeld;

      const evtA = makePiSucceededEvent(order.id, paymentIntentId, order.totalInCents, `evt_conc_a_${nanoid(10)}`);
      const pWebhook = processStripeWebhookEvent(evtA);
      const pReconcile = fulfillPaidOrder(evtA.data.object as Stripe.PaymentIntent);

      releaseBarrier();
      await Promise.all([holderPromise, pWebhook, pReconcile]);

      const refunds = await prisma.orderRefund.findMany({
        where: { stripePaymentIntentId: paymentIntentId },
      });
      expect(refunds).toHaveLength(1);
    });

    it('10. ensures competing refund workers claim and refund a single OrderRefund once via FOR UPDATE SKIP LOCKED', async () => {
      const { event } = await createOrganizerAndEvent({ suffix: 'conc-workers' });
      const tier = await createTier({ eventId: event.id, totalCapacity: 1, soldQuantity: 1 });
      const { order, paymentIntentId } = await createOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        quantity: 1,
        status: OrderStatus.EXPIRED,
        reservationStatus: ReservationStatus.RELEASED,
      });

      await processStripeWebhookEvent(makePiSucceededEvent(order.id, paymentIntentId, order.totalInCents));

      vi.spyOn(stripe.refunds, 'list').mockResolvedValue({ data: [], has_more: false } as any);
      const createSpy = vi.spyOn(stripe.refunds, 'create').mockResolvedValue({
        id: `re_conc_${nanoid(12)}`,
        object: 'refund',
        amount: order.totalInCents,
        currency: 'usd',
        status: 'succeeded',
      } as any);

      // First worker holds SKIP LOCKED transaction open momentarily while second claims
      let releaseClaimGate!: () => void;
      const claimGate = new Promise<void>((resolve) => {
        releaseClaimGate = resolve;
      });
      let worker1Claimed!: () => void;
      const worker1ClaimedPromise = new Promise<void>((resolve) => {
        worker1Claimed = resolve;
      });

      const refundRow = await prisma.orderRefund.findUniqueOrThrow({
        where: { stripePaymentIntentId: paymentIntentId },
      });

      const tx1 = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT id FROM "OrderRefund" WHERE id = ${refundRow.id} FOR UPDATE SKIP LOCKED
        `;
        worker1Claimed();
        await claimGate;
      });

      await worker1ClaimedPromise;
      const claimWhileLocked = await claimPendingOrderRefundBatch({ workerId: 'worker-B' });
      expect(claimWhileLocked.claimed.some((r) => r.id === refundRow.id)).toBe(false);

      releaseClaimGate();
      await tx1;

      const [pass1, pass2] = await Promise.all([
        runOrderRefundPass({ workerId: 'worker-A' }),
        runOrderRefundPass({ workerId: 'worker-B' }),
      ]);

      expect(pass1.succeeded + pass2.succeeded).toBe(1);
      const callsForThisPi = createSpy.mock.calls.filter(
        (call) => call[0]?.payment_intent === paymentIntentId
      );
      expect(callsForThisPi).toHaveLength(1);
      expect(createSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('3. Stripe Refund Execution, Retries, Crash Recovery & Notifications', () => {
    it('11. completes successful Stripe refund, marks Order REFUNDED, updates PaymentTransaction, and queues one confirmation email', async () => {
      const { event } = await createOrganizerAndEvent({ suffix: 'refund-ok' });
      const tier = await createTier({ eventId: event.id, totalCapacity: 2, soldQuantity: 2 });
      const { order, paymentIntentId } = await createOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        quantity: 2,
        status: OrderStatus.EXPIRED,
        reservationStatus: ReservationStatus.RELEASED,
      });

      await processStripeWebhookEvent(makePiSucceededEvent(order.id, paymentIntentId, order.totalInCents));

      const mockRefundId = `re_ok_${nanoid(12)}`;
      vi.spyOn(stripe.refunds, 'list').mockResolvedValueOnce({ data: [], has_more: false } as any);
      vi.spyOn(stripe.refunds, 'create').mockResolvedValueOnce({
        id: mockRefundId,
        object: 'refund',
        amount: order.totalInCents,
        currency: 'usd',
        status: 'succeeded',
      } as any);

      const pass = await runOrderRefundPass({ workerId: 'w-ok' });
      expect(pass.succeeded).toBe(1);

      await runEmailOutboxPass();

      const updatedOrder = await prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        include: { transactions: true },
      });
      const updatedRefund = await prisma.orderRefund.findUniqueOrThrow({
        where: { stripePaymentIntentId: paymentIntentId },
      });
      expect(updatedOrder.status).toBe(OrderStatus.REFUNDED);
      expect(updatedOrder.transactions.find((t) => t.providerTransactionId === paymentIntentId)?.status).toBe(
        PaymentStatus.REFUNDED
      );
      expect(updatedRefund.status).toBe(OrderRefundStatus.SUCCEEDED);
      expect(updatedRefund.stripeRefundId).toBe(mockRefundId);
      expect(updatedRefund.lockedBy).toBeNull();
      expect(updatedRefund.succeededAt).toBeInstanceOf(Date);

      const refundEmails = sentLatePaymentRefundEmails.filter(
        (m) => m.orderNumber === order.orderNumber
      );
      expect(refundEmails).toHaveLength(1);
      expect(refundEmails[0].kind).toBe('CONFIRMED');
      expect(refundEmails[0].text).toContain(mockRefundId);
    });

    it('12 & 18. persists STRIPE_PENDING without sending success email, then settles once on webhook confirmation despite duplicates', async () => {
      const { event } = await createOrganizerAndEvent({ suffix: 'stripe-pending' });
      const tier = await createTier({ eventId: event.id, totalCapacity: 1, soldQuantity: 1 });
      const { order, paymentIntentId } = await createOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        quantity: 1,
        status: OrderStatus.EXPIRED,
        reservationStatus: ReservationStatus.RELEASED,
      });

      await processStripeWebhookEvent(makePiSucceededEvent(order.id, paymentIntentId, order.totalInCents));

      const pendingRefundId = `re_pend_${nanoid(12)}`;
      vi.spyOn(stripe.refunds, 'list').mockResolvedValueOnce({ data: [], has_more: false } as any);
      vi.spyOn(stripe.refunds, 'create').mockResolvedValueOnce({
        id: pendingRefundId,
        object: 'refund',
        amount: order.totalInCents,
        currency: 'usd',
        status: 'pending',
      } as any);

      const pass = await runOrderRefundPass({ workerId: 'w-pending' });
      expect(pass.stripePending).toBe(1);
      await runEmailOutboxPass();

      const midOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      const midRefund = await prisma.orderRefund.findUniqueOrThrow({
        where: { stripePaymentIntentId: paymentIntentId },
      });
      expect(midOrder.status).toBe(OrderStatus.EXPIRED);
      expect(midRefund.status).toBe(OrderRefundStatus.STRIPE_PENDING);
      expect(midRefund.stripeRefundId).toBe(pendingRefundId);
      expect(sentLatePaymentRefundEmails.filter((m) => m.orderNumber === order.orderNumber)).toHaveLength(0);

      // Webhook confirms succeeded (delivered twice with different eventIds)
      const evtUpd1: Stripe.Event = {
        id: `evt_ref_upd1_${nanoid(12)}`,
        type: 'refund.updated',
        data: {
          object: {
            id: pendingRefundId,
            payment_intent: paymentIntentId,
            amount: order.totalInCents,
            currency: 'usd',
            status: 'succeeded',
            metadata: { orderId: order.id, orderRefundId: midRefund.id },
          } as any,
        },
      } as any;
      const evtChRefDup: Stripe.Event = {
        id: `evt_ch_refdup_${nanoid(12)}`,
        type: 'charge.refunded',
        data: {
          object: {
            id: `ch_${nanoid(12)}`,
            payment_intent: paymentIntentId,
            amount_refunded: order.totalInCents,
            currency: 'usd',
            metadata: { orderId: order.id },
            refunds: {
              data: [
                {
                  id: pendingRefundId,
                  amount: order.totalInCents,
                  currency: 'usd',
                  status: 'succeeded',
                  metadata: { orderRefundId: midRefund.id },
                },
              ],
            },
          } as any,
        },
      } as any;
      createdWebhookEventIds.push(evtUpd1.id, evtChRefDup.id);

      await processStripeWebhookEvent(evtUpd1);
      await processStripeWebhookEvent(evtChRefDup);
      await runEmailOutboxPass();

      const finalOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      const finalRefund = await prisma.orderRefund.findUniqueOrThrow({ where: { id: midRefund.id } });
      expect(finalOrder.status).toBe(OrderStatus.REFUNDED);
      expect(finalRefund.status).toBe(OrderRefundStatus.SUCCEEDED);
      expect(
        sentLatePaymentRefundEmails.filter((m) => m.orderNumber === order.orderNumber && m.kind === 'CONFIRMED')
      ).toHaveLength(1);
    });

    it('13. retries retryable Stripe errors with exact same idempotencyKey and succeeds upon recovery', async () => {
      const { event } = await createOrganizerAndEvent({ suffix: 'retry-stripe' });
      const tier = await createTier({ eventId: event.id, totalCapacity: 1, soldQuantity: 1 });
      const { order, paymentIntentId } = await createOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        quantity: 1,
        status: OrderStatus.EXPIRED,
        reservationStatus: ReservationStatus.RELEASED,
      });

      await processStripeWebhookEvent(makePiSucceededEvent(order.id, paymentIntentId, order.totalInCents));

      vi.spyOn(stripe.refunds, 'list').mockResolvedValue({ data: [], has_more: false } as any);
      const rateLimitErr: any = new Error('Rate limit exceeded');
      rateLimitErr.type = 'StripeRateLimitError';
      rateLimitErr.statusCode = 429;

      const createSpy = vi
        .spyOn(stripe.refunds, 'create')
        .mockRejectedValueOnce(rateLimitErr)
        .mockResolvedValueOnce({
          id: `re_retry_ok_${nanoid(12)}`,
          amount: order.totalInCents,
          currency: 'usd',
          status: 'succeeded',
        } as any);

      const pass1 = await runOrderRefundPass({ workerId: 'w-retry-1', randomFn: () => 0.5 });
      expect(pass1.retried).toBe(1);

      const afterRetry = await prisma.orderRefund.findUniqueOrThrow({
        where: { stripePaymentIntentId: paymentIntentId },
      });
      expect(afterRetry.status).toBe(OrderRefundStatus.PENDING);
      expect(afterRetry.attempts).toBe(1);
      expect(afterRetry.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

      // Fast-forward eligibility window
      await prisma.orderRefund.update({
        where: { id: afterRetry.id },
        data: { nextAttemptAt: new Date(Date.now() - 1000) },
      });

      const pass2 = await runOrderRefundPass({ workerId: 'w-retry-2' });
      expect(pass2.succeeded).toBe(1);
      expect(createSpy).toHaveBeenCalledTimes(2);
      expect(createSpy.mock.calls[0][1]?.idempotencyKey).toBe(afterRetry.idempotencyKey);
      expect(createSpy.mock.calls[1][1]?.idempotencyKey).toBe(afterRetry.idempotencyKey);
    });

    it('14 & 15. escalates permanent Stripe failures, exhausted attempts, and expired leases to MANUAL_REVIEW_REQUIRED', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { event } = await createOrganizerAndEvent({ suffix: 'perm-manual' });
      const tier = await createTier({ eventId: event.id, totalCapacity: 2, soldQuantity: 2 });

      // A. Permanent error
      const caseA = await createOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        quantity: 1,
        status: OrderStatus.EXPIRED,
        reservationStatus: ReservationStatus.RELEASED,
      });
      await processStripeWebhookEvent(makePiSucceededEvent(caseA.order.id, caseA.paymentIntentId, caseA.order.totalInCents));

      vi.spyOn(stripe.refunds, 'list').mockResolvedValueOnce({ data: [], has_more: false } as any);
      const invalidErr: any = new Error('Insufficient funds in Stripe account for sk_test_secretLeakCheck123');
      invalidErr.type = 'StripeInvalidRequestError';
      invalidErr.code = 'insufficient_funds';
      invalidErr.statusCode = 400;
      vi.spyOn(stripe.refunds, 'create').mockRejectedValueOnce(invalidErr);

      const passA = await runOrderRefundPass({ workerId: 'w-perm' });
      expect(passA.manualReview).toBe(1);
      await runEmailOutboxPass();

      const refundA = await prisma.orderRefund.findUniqueOrThrow({
        where: { stripePaymentIntentId: caseA.paymentIntentId },
      });
      expect(refundA.status).toBe(OrderRefundStatus.MANUAL_REVIEW_REQUIRED);
      expect(refundA.requiresManualResolution).toBe(true);
      expect(refundA.lastErrorMessage).not.toContain('sk_test_secretLeakCheck123');

      const manualEmail = sentLatePaymentRefundEmails.find(
        (m) => m.orderNumber === caseA.order.orderNumber
      );
      expect(manualEmail?.kind).toBe('MANUAL_REVIEW');
      expect(manualEmail?.subject).not.toMatch(/refund is confirmed/i);
      expect(errorSpy.mock.calls.some((args) => String(args[0]).includes('[OrderRefund][CRITICAL]'))).toBe(true);

      // B. Exhausted lease reaping
      const caseB = await createOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        quantity: 1,
        status: OrderStatus.EXPIRED,
        reservationStatus: ReservationStatus.RELEASED,
      });
      await processStripeWebhookEvent(makePiSucceededEvent(caseB.order.id, caseB.paymentIntentId, caseB.order.totalInCents));
      await prisma.orderRefund.update({
        where: { stripePaymentIntentId: caseB.paymentIntentId },
        data: {
          status: OrderRefundStatus.PROCESSING,
          attempts: ORDER_REFUND_MAX_ATTEMPTS,
          lockedBy: 'crashed-worker',
          lockedUntil: new Date(Date.now() - 60_000),
        },
      });

      const reaped = await reapExpiredExhaustedRefundLeases();
      expect(reaped).toBeGreaterThanOrEqual(1);
      const refundB = await prisma.orderRefund.findUniqueOrThrow({
        where: { stripePaymentIntentId: caseB.paymentIntentId },
      });
      expect(refundB.status).toBe(OrderRefundStatus.MANUAL_REVIEW_REQUIRED);
      expect(refundB.requiresManualResolution).toBe(true);
      expect(refundB.lockedBy).toBeNull();
    });

    it('16. recovers from crash after Stripe refund creation without issuing a second refund', async () => {
      const { event } = await createOrganizerAndEvent({ suffix: 'crash-rec' });
      const tier = await createTier({ eventId: event.id, totalCapacity: 1, soldQuantity: 1 });
      const { order, paymentIntentId } = await createOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        quantity: 1,
        status: OrderStatus.EXPIRED,
        reservationStatus: ReservationStatus.RELEASED,
      });

      await processStripeWebhookEvent(makePiSucceededEvent(order.id, paymentIntentId, order.totalInCents));
      const refundRow = await prisma.orderRefund.findUniqueOrThrow({
        where: { stripePaymentIntentId: paymentIntentId },
      });

      // Simulate worker 1 created refund on Stripe, then crashed before DB commit (expired PROCESSING lease, stripeRefundId still null)
      await prisma.orderRefund.update({
        where: { id: refundRow.id },
        data: {
          status: OrderRefundStatus.PROCESSING,
          attempts: 1,
          lockedBy: 'dead-worker-1',
          lockedUntil: new Date(Date.now() - 30_000),
          stripeRefundId: null,
        },
      });

      const existingStripeRefundId = `re_crashed_recovered_${nanoid(10)}`;
      vi.spyOn(stripe.refunds, 'list').mockResolvedValueOnce({
        data: [
          {
            id: existingStripeRefundId,
            object: 'refund',
            amount: order.totalInCents,
            currency: 'usd',
            status: 'succeeded',
            metadata: { orderRefundId: refundRow.id },
          },
        ],
        has_more: false,
      } as any);
      const createSpy = vi.spyOn(stripe.refunds, 'create');

      const pass = await runOrderRefundPass({ workerId: 'recovery-worker-2' });
      expect(pass.succeeded).toBe(1);
      expect(createSpy).not.toHaveBeenCalled();

      const recovered = await prisma.orderRefund.findUniqueOrThrow({ where: { id: refundRow.id } });
      const recoveredOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(recovered.status).toBe(OrderRefundStatus.SUCCEEDED);
      expect(recovered.stripeRefundId).toBe(existingStripeRefundId);
      expect(recoveredOrder.status).toBe(OrderStatus.REFUNDED);
    });

    it('17. escalates partial or multiple pre-existing refunds across paginated Stripe results to MANUAL_REVIEW_REQUIRED', async () => {
      const { event } = await createOrganizerAndEvent({ suffix: 'partial-multi' });
      const tier = await createTier({ eventId: event.id, totalCapacity: 2, soldQuantity: 2 });

      // Partial existing refund
      const casePartial = await createOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        quantity: 1,
        status: OrderStatus.EXPIRED,
        reservationStatus: ReservationStatus.RELEASED,
      });
      await processStripeWebhookEvent(
        makePiSucceededEvent(casePartial.order.id, casePartial.paymentIntentId, casePartial.order.totalInCents)
      );

      vi.spyOn(stripe.refunds, 'list').mockResolvedValueOnce({
        data: [
          {
            id: `re_partial_${nanoid(10)}`,
            amount: 500, // less than full totalInCents
            currency: 'usd',
            status: 'succeeded',
          },
        ],
        has_more: false,
      } as any);
      const createSpy = vi.spyOn(stripe.refunds, 'create');

      const passPartial = await runOrderRefundPass({ workerId: 'w-partial' });
      expect(passPartial.manualReview).toBe(1);
      expect(createSpy).not.toHaveBeenCalled();

      // Multiple paginated refunds totaling expected amount -> still escalate instead of guessing
      const caseMulti = await createOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        quantity: 1,
        status: OrderStatus.EXPIRED,
        reservationStatus: ReservationStatus.RELEASED,
      });
      await processStripeWebhookEvent(
        makePiSucceededEvent(caseMulti.order.id, caseMulti.paymentIntentId, caseMulti.order.totalInCents)
      );

      const page1Id = `re_page1_${nanoid(8)}`;
      vi.spyOn(stripe.refunds, 'list')
        .mockResolvedValueOnce({
          data: [{ id: page1Id, amount: 1500, currency: 'usd', status: 'succeeded' }],
          has_more: true,
        } as any)
        .mockResolvedValueOnce({
          data: [
            {
              id: `re_page2_${nanoid(8)}`,
              amount: caseMulti.order.totalInCents - 1500,
              currency: 'usd',
              status: 'succeeded',
            },
          ],
          has_more: false,
        } as any);

      const passMulti = await runOrderRefundPass({ workerId: 'w-multi' });
      expect(passMulti.manualReview).toBe(1);
      expect(createSpy).not.toHaveBeenCalled();

      const multiRefundRow = await prisma.orderRefund.findUniqueOrThrow({
        where: { stripePaymentIntentId: caseMulti.paymentIntentId },
      });
      expect(multiRefundRow.lastErrorCode).toBe('STRIPE_MULTIPLE_EXISTING_REFUNDS');
    });
  });

  describe('4. Financial Ledger Safety, Settlement Preservation & Manual Resolution Audit', () => {
    it('19. late-payment refund never credits or debits organizer balances even after charge.refunded arrives', async () => {
      const { organizer, event } = await createOrganizerAndEvent({ suffix: 'ledger-zero' });
      await prisma.organizerBalance.create({
        data: {
          userId: organizer.id,
          availableBalanceInCents: 1000,
          pendingBalanceInCents: 500,
          transferredBalanceInCents: 0,
        },
      });
      const tier = await createTier({ eventId: event.id, totalCapacity: 1, soldQuantity: 1 });
      const { order, paymentIntentId } = await createOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        quantity: 1,
        status: OrderStatus.EXPIRED,
        reservationStatus: ReservationStatus.RELEASED,
      });

      await processStripeWebhookEvent(makePiSucceededEvent(order.id, paymentIntentId, order.totalInCents));

      const refundId = `re_ledger_safe_${nanoid(10)}`;
      vi.spyOn(stripe.refunds, 'list').mockResolvedValueOnce({ data: [], has_more: false } as any);
      vi.spyOn(stripe.refunds, 'create').mockResolvedValueOnce({
        id: refundId,
        amount: order.totalInCents,
        currency: 'usd',
        status: 'succeeded',
      } as any);
      await runOrderRefundPass({ workerId: 'w-ledger' });

      // Simulate subsequent charge.updated + charge.refunded webhooks arriving from Stripe
      const chUpdatedEvt: Stripe.Event = {
        id: `evt_ch_late_upd_${nanoid(10)}`,
        type: 'charge.updated',
        data: {
          object: {
            id: `ch_late_${nanoid(10)}`,
            payment_intent: paymentIntentId,
            currency: 'usd',
            status: 'succeeded',
            metadata: { orderId: order.id },
            balance_transaction: {
              id: `txn_${nanoid(10)}`,
              status: 'available',
              available_on: Math.floor(Date.now() / 1000) - 60,
              fee: 99,
            } as any,
          } as any,
        },
      } as any;
      const chRefundedEvt: Stripe.Event = {
        id: `evt_ch_late_ref_${nanoid(10)}`,
        type: 'charge.refunded',
        data: {
          object: {
            id: `ch_late_${nanoid(10)}`,
            payment_intent: paymentIntentId,
            amount_refunded: order.totalInCents,
            currency: 'usd',
            metadata: { orderId: order.id },
            refunds: { data: [{ id: refundId, amount: order.totalInCents, currency: 'usd', status: 'succeeded' }] },
          } as any,
        },
      } as any;
      createdWebhookEventIds.push(chUpdatedEvt.id, chRefundedEvt.id);

      await processStripeWebhookEvent(chUpdatedEvt);
      await processStripeWebhookEvent(chRefundedEvt);

      const bal = await prisma.organizerBalance.findUniqueOrThrow({ where: { userId: organizer.id } });
      const ledgerEntries = await prisma.financialLedgerEntry.findMany({ where: { orderId: order.id } });
      expect(bal.availableBalanceInCents).toBe(1000);
      expect(bal.pendingBalanceInCents).toBe(500);
      expect(ledgerEntries).toHaveLength(0);
    });

    it('20. preserves legitimate refund ledger deductions for completed sales based on sale/ledger evidence even if order status is REFUNDED', async () => {
      const { organizer, event } = await createOrganizerAndEvent({ suffix: 'legit-sale-ref' });
      const tier = await createTier({
        eventId: event.id,
        totalCapacity: 5,
        reservedQuantity: 1,
      });
      const { order, paymentIntentId } = await createOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        quantity: 1,
        status: OrderStatus.PENDING,
        reservationStatus: ReservationStatus.ACTIVE,
        expiresAt: new Date(Date.now() + 15 * 60_000),
      });

      await processStripeWebhookEvent(makePiSucceededEvent(order.id, paymentIntentId, order.totalInCents));
      // Simulate order marked REFUNDED (e.g. external refund status sync) while sale ledger history exists
      await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.REFUNDED } });

      const chRefundedEvt: Stripe.Event = {
        id: `evt_legit_ref_${nanoid(12)}`,
        type: 'charge.refunded',
        data: {
          object: {
            id: `ch_legit_${nanoid(12)}`,
            payment_intent: paymentIntentId,
            amount_refunded: order.totalInCents,
            currency: 'usd',
            metadata: { orderId: order.id },
            refunds: { data: [{ id: `re_legit_${nanoid(10)}` }] },
          } as any,
        },
      } as any;
      createdWebhookEventIds.push(chRefundedEvt.id);

      await processStripeWebhookEvent(chRefundedEvt);

      const bal = await prisma.organizerBalance.findUniqueOrThrow({ where: { userId: organizer.id } });
      const refundLedger = await prisma.financialLedgerEntry.findFirst({
        where: { orderId: order.id, type: LedgerEntryType.REFUND_PENDING },
      });
      expect(refundLedger).toBeTruthy();
      expect(bal.pendingBalanceInCents).toBe(0);
    });

    it('21. preserves eventual settlement when charge.updated arrives BEFORE payment_intent.succeeded', async () => {
      const { organizer, event } = await createOrganizerAndEvent({ suffix: 'out-of-order-settle' });
      const tier = await createTier({ eventId: event.id, totalCapacity: 5, reservedQuantity: 2 });
      const { order, paymentIntentId } = await createOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        quantity: 2,
        status: OrderStatus.PENDING,
        reservationStatus: ReservationStatus.ACTIVE,
        expiresAt: new Date(Date.now() + 15 * 60_000),
      });

      // Step 1: charge.updated(available) arrives FIRST while order is still PENDING
      const chargeId = `ch_ooo_${nanoid(12)}`;
      const earlyChargeEvt: Stripe.Event = {
        id: `evt_ooo_ch_${nanoid(12)}`,
        type: 'charge.updated',
        data: {
          object: {
            id: chargeId,
            payment_intent: paymentIntentId,
            currency: 'usd',
            status: 'succeeded',
            metadata: { orderId: order.id },
            balance_transaction: {
              id: `txn_ooo_${nanoid(12)}`,
              status: 'available',
              available_on: Math.floor(Date.now() / 1000) - 60,
              fee: 150,
            } as any,
          } as any,
        },
      } as any;
      createdWebhookEventIds.push(earlyChargeEvt.id);

      await processStripeWebhookEvent(earlyChargeEvt);

      // Must NOT credit organizer before payment_intent.succeeded validates & fulfills order
      const balMid = await prisma.organizerBalance.findUnique({ where: { userId: organizer.id } });
      expect(balMid).toBeNull();

      // Step 2: payment_intent.succeeded arrives -> fulfills AND immediately settles into AVAILABLE
      await processStripeWebhookEvent(
        makePiSucceededEvent(order.id, paymentIntentId, order.totalInCents)
      );

      const balFinal = await prisma.organizerBalance.findUniqueOrThrow({
        where: { userId: organizer.id },
      });
      const clearedEntry = await prisma.financialLedgerEntry.findFirst({
        where: { orderId: order.id, type: LedgerEntryType.TICKET_SALE_CLEARED },
      });
      expect(balFinal.pendingBalanceInCents).toBe(0);
      expect(balFinal.availableBalanceInCents).toBe(order.organizerNetInCents);
      expect(clearedEntry?.balanceType).toBe(LedgerBalanceType.AVAILABLE);
    });

    it('22. manual resolution requires action evidence, transitions Order & OrderRefund, and writes AdminAuditLog', async () => {
      const { event } = await createOrganizerAndEvent({ suffix: 'manual-audit' });
      const tier = await createTier({ eventId: event.id, totalCapacity: 1, soldQuantity: 1 });
      const { order, paymentIntentId } = await createOrderFixture({
        eventId: event.id,
        tierId: tier.id,
        quantity: 1,
        status: OrderStatus.EXPIRED,
        reservationStatus: ReservationStatus.RELEASED,
      });

      // Anomalous amount mismatch on webhook -> MANUAL_REVIEW_REQUIRED
      await processStripeWebhookEvent(
        makePiSucceededEvent(order.id, paymentIntentId, order.totalInCents - 100)
      );

      const pendingManual = await prisma.orderRefund.findUniqueOrThrow({
        where: { stripePaymentIntentId: paymentIntentId },
      });
      expect(pendingManual.status).toBe(OrderRefundStatus.MANUAL_REVIEW_REQUIRED);
      expect(pendingManual.requiresManualResolution).toBe(true);

      const resolved = await resolveManualOrderRefund({
        orderRefundId: pendingManual.id,
        actorUserId: adminActor.id,
        actorEmail: adminActor.email,
        action: 'REFUNDED_MANUALLY',
        stripeRefundId: `re_manual_${nanoid(10)}`,
        notes: 'Issued verified partial-match refund directly in Stripe Dashboard',
      });

      const refreshedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      const audit = await prisma.adminAuditLog.findFirst({
        where: {
          targetType: 'OrderRefund',
          targetId: pendingManual.id,
          action: 'ORDER_REFUND_MANUALLY_RESOLVED',
        },
      });

      expect(resolved.status).toBe(OrderRefundStatus.MANUALLY_RESOLVED);
      expect(resolved.requiresManualResolution).toBe(false);
      expect(resolved.resolvedByEmail).toBe(adminActor.email);
      expect(refreshedOrder.status).toBe(OrderStatus.REFUNDED);
      expect(audit).toBeTruthy();
      expect((audit?.metadata as any)?.resolutionAction).toBe('REFUNDED_MANUALLY');
    });

    it('23. supports OrderRefundWorker start/stop lifecycle cleanly alongside existing EmailOutbox confirmation behavior', async () => {
      startOrderRefundWorker(60_000);
      expect(isOrderRefundWorkerRunning()).toBe(true);
      await stopOrderRefundWorker(2_000);
      expect(isOrderRefundWorkerRunning()).toBe(false);
    });
  });
});
