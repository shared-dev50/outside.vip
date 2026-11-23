import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AccountStatus,
  EventStatus,
  OrderStatus,
  ReservationStatus,
  Role,
  TicketTierStatus,
  WaitlistEntryStatus,
  WaitlistOfferStatus,
} from '@prisma/client';
import { app } from '../app.js';
import { prisma } from '../db/prisma.js';
import { stripe } from '../lib/stripe.js';
import { releaseExpiredReservations } from '../modules/checkout/checkout.service.js';
import {
  hashOfferToken,
  processWaitlistForTier,
  sweepExpiredOffers,
} from '../modules/waitlist/waitlist.service.js';
import { resetSentWaitlistEmails, sentWaitlistEmails } from '../modules/waitlist/waitlistEmail.service.js';
import {
  isWaitlistBackgroundWorkerRunning,
  runWaitlistMaintenancePass,
  startWaitlistBackgroundWorker,
  stopWaitlistBackgroundWorker,
} from '../modules/waitlist/waitlistWorker.js';
import { fulfillPaidOrder } from '../modules/webhooks/webhook.service.js';
import { ensureOrganizerWorkspaceForUser } from '../modules/organizer/organizer.controller.js';

describe('P2-04 Coordinated Reservation Expiry, Waitlist Concurrency & Worker Hardening (Real PostgreSQL)', () => {
  const runId = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const createdUserIds: string[] = [];
  const createdEventIds: string[] = [];

  let organizerUser: any;
  let publishedEvent: any;

  async function createTestEvent(opts: {
    suffix: string;
    status?: EventStatus;
    endAt?: Date;
  }) {
    const evt = await prisma.event.create({
      data: {
        organizerId: organizerUser.id,
        title: `P204 Event ${opts.suffix} ${runId}`,
        description: 'PostgreSQL concurrency test event',
        coverImageUrl: 'https://example.com/p204.jpg',
        venueName: 'Test Venue',
        venueAddress: '100 Test Way',
        city: 'Nairobi',
        country: 'Kenya',
        slug: `p204-${opts.suffix}-${runId}`.toLowerCase(),
        category: 'MUSIC',
        status: opts.status ?? EventStatus.PUBLISHED,
        startAt: new Date(Date.now() - 3600_000),
        endAt: opts.endAt ?? new Date(Date.now() + 7 * 86400_000),
        timezone: 'Africa/Nairobi',
      },
    });
    createdEventIds.push(evt.id);
    return evt;
  }

  async function createTestTier(opts: {
    eventId: string;
    name: string;
    totalCapacity: number;
    reservedQuantity?: number;
    soldQuantity?: number;
    waitlistEnabled?: boolean;
    status?: TicketTierStatus;
    isHidden?: boolean;
    salesDisabled?: boolean;
    salesEndAt?: Date | null;
  }) {
    return prisma.ticketTier.create({
      data: {
        eventId: opts.eventId,
        name: opts.name,
        priceInCents: 2500,
        currency: 'USD',
        totalCapacity: opts.totalCapacity,
        reservedQuantity: opts.reservedQuantity ?? 0,
        soldQuantity: opts.soldQuantity ?? 0,
        minPerOrder: 1,
        maxPerOrder: 10,
        status: opts.status ?? TicketTierStatus.ACTIVE,
        isHidden: opts.isHidden ?? false,
        salesDisabled: opts.salesDisabled ?? false,
        waitlistEnabled: opts.waitlistEnabled ?? false,
        salesEndAt: opts.salesEndAt ?? null,
      },
    });
  }

  async function createExpiredPendingOrder(opts: {
    eventId: string;
    suffix: string;
    items: Array<{ ticketTierId: string; quantity: number }>;
    orderStatus?: OrderStatus;
    reservationStatus?: ReservationStatus;
    expiresAt?: Date;
    paymentReference?: string | null;
  }) {
    const exp = opts.expiresAt ?? new Date(Date.now() - 10 * 60_000);
    const totalQty = opts.items.reduce((acc, i) => acc + i.quantity, 0);
    return prisma.order.create({
      data: {
        orderNumber: `P204-${opts.suffix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`.slice(0, 32),
        eventId: opts.eventId,
        status: opts.orderStatus ?? OrderStatus.PENDING,
        customerEmail: `buyer_${opts.suffix}_${runId}@outside.vip`,
        customerName: `Buyer ${opts.suffix}`,
        totalInCents: totalQty * 2500,
        currency: 'USD',
        idempotencyKey: `p204_idem_${opts.suffix}_${Date.now()}_${Math.random()}`,
        orderAccessToken: `oat_p204_${opts.suffix}_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
        paymentReference: opts.paymentReference ?? null,
        expiresAt: exp,
        items: {
          create: opts.items.map((i) => ({
            ticketTierId: i.ticketTierId,
            quantity: i.quantity,
            unitPriceInCents: 2500,
            subtotalInCents: i.quantity * 2500,
          })),
        },
        reservations: {
          create: opts.items.map((i) => ({
            ticketTierId: i.ticketTierId,
            quantity: i.quantity,
            expiresAt: exp,
            status: opts.reservationStatus ?? ReservationStatus.ACTIVE,
          })),
        },
      },
      include: { reservations: true },
    });
  }

  beforeAll(async () => {
    const passwordHash = await bcrypt.hash('StrongPass#2026!', 10);
    organizerUser = await prisma.user.create({
      data: {
        email: `p204_org_${runId}@outside.vip`,
        name: 'P204 Organizer',
        passwordHash,
        role: Role.ORGANIZER,
        status: AccountStatus.ACTIVE,
        emailVerified: true,
        emailVerifiedAt: new Date(),
      },
    });
    createdUserIds.push(organizerUser.id);
    await ensureOrganizerWorkspaceForUser(organizerUser.id, organizerUser.name);

    publishedEvent = await createTestEvent({ suffix: 'main' });
  });

  beforeEach(async () => {
    resetSentWaitlistEmails();
    vi.restoreAllMocks();
    // Drain any pre-existing expired rows left by earlier test suites in shared DB
    await releaseExpiredReservations();
    await sweepExpiredOffers();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await stopWaitlistBackgroundWorker(200);
  });

  afterAll(async () => {
    await stopWaitlistBackgroundWorker(200);

    if (createdEventIds.length > 0) {
      const orders = await prisma.order.findMany({
        where: { eventId: { in: createdEventIds } },
        select: { id: true },
      });
      const oids = orders.map((o) => o.id);
      if (oids.length > 0) {
        await prisma.emailOutbox.deleteMany({ where: { orderId: { in: oids } } });
        await prisma.financialLedgerEntry.deleteMany({ where: { orderId: { in: oids } } });
        await prisma.paymentTransaction.deleteMany({ where: { orderId: { in: oids } } });
        await prisma.ticket.deleteMany({ where: { orderId: { in: oids } } });
        await prisma.orderItem.deleteMany({ where: { orderId: { in: oids } } });
        await prisma.ticketReservation.deleteMany({ where: { orderId: { in: oids } } });
        await prisma.ticketWaitlistOffer.deleteMany({ where: { orderId: { in: oids } } });
        await prisma.order.deleteMany({ where: { id: { in: oids } } });
      }
      await prisma.ticketWaitlistOffer.deleteMany({ where: { eventId: { in: createdEventIds } } });
      await prisma.ticketWaitlistEntry.deleteMany({ where: { eventId: { in: createdEventIds } } });
      await prisma.ticketReservation.deleteMany({ where: { ticketTier: { eventId: { in: createdEventIds } } } });
      await prisma.ticketTier.deleteMany({ where: { eventId: { in: createdEventIds } } });
      await prisma.event.deleteMany({ where: { id: { in: createdEventIds } } });
    }

    if (createdUserIds.length > 0) {
      await prisma.organizerBalance.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.organizerProfile.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
  });

  // ==========================================================
  // 1. Reservation Expiry Concurrency, Batching & Safety
  // ==========================================================
  describe('1. Atomic Reservation Expiry (PostgreSQL SKIP LOCKED & Transactions)', () => {
    it('releases an expired reservation exactly once across concurrent calls without double-decrementing capacity', async () => {
      const tier = await createTestTier({
        eventId: publishedEvent.id,
        name: `Concurrent Expiry Tier ${runId}`,
        totalCapacity: 10,
        reservedQuantity: 4,
      });

      const order = await createExpiredPendingOrder({
        eventId: publishedEvent.id,
        suffix: 'conc_exp',
        items: [{ ticketTierId: tier.id, quantity: 4 }],
      });

      const [r1, r2, r3] = await Promise.all([
        releaseExpiredReservations(),
        releaseExpiredReservations(),
        releaseExpiredReservations(),
      ]);

      expect(r1 + r2 + r3).toBeGreaterThanOrEqual(1);

      const tierAfter = await prisma.ticketTier.findUniqueOrThrow({ where: { id: tier.id } });
      expect(tierAfter.reservedQuantity).toBe(0);

      const orderAfter = await prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        include: { reservations: true },
      });
      expect(orderAfter.status).toBe(OrderStatus.EXPIRED);
      expect(orderAfter.reservations[0].status).toBe(ReservationStatus.RELEASED);
    });

    it('processes multiple expired orders for one tier and multi-tier orders deterministically without negative reservedQuantity', async () => {
      const tierA = await createTestTier({
        eventId: publishedEvent.id,
        name: `Multi Tier A ${runId}`,
        totalCapacity: 20,
        reservedQuantity: 5,
      });
      const tierB = await createTestTier({
        eventId: publishedEvent.id,
        name: `Multi Tier B ${runId}`,
        totalCapacity: 20,
        reservedQuantity: 2, // Intentionally lower than 3 to verify 0 clamp safety
      });

      await createExpiredPendingOrder({
        eventId: publishedEvent.id,
        suffix: 'multi_1',
        items: [{ ticketTierId: tierA.id, quantity: 2 }],
      });
      await createExpiredPendingOrder({
        eventId: publishedEvent.id,
        suffix: 'multi_2',
        items: [
          { ticketTierId: tierA.id, quantity: 3 },
          { ticketTierId: tierB.id, quantity: 3 },
        ],
      });

      const released = await releaseExpiredReservations();
      expect(released).toBeGreaterThanOrEqual(3);

      const [afterA, afterB] = await Promise.all([
        prisma.ticketTier.findUniqueOrThrow({ where: { id: tierA.id } }),
        prisma.ticketTier.findUniqueOrThrow({ where: { id: tierB.id } }),
      ]);
      expect(afterA.reservedQuantity).toBe(0);
      expect(afterB.reservedQuantity).toBe(0);
    });

    it('never expires COMPLETED orders or overwrites CONFIRMED reservations', async () => {
      const tier = await createTestTier({
        eventId: publishedEvent.id,
        name: `Completed Guard Tier ${runId}`,
        totalCapacity: 10,
        reservedQuantity: 2,
        soldQuantity: 3,
      });

      // Completed order with stale timestamps must remain untouched
      const completedOrder = await createExpiredPendingOrder({
        eventId: publishedEvent.id,
        suffix: 'completed_safe',
        items: [{ ticketTierId: tier.id, quantity: 3 }],
        orderStatus: OrderStatus.COMPLETED,
        reservationStatus: ReservationStatus.CONFIRMED,
      });

      // Edge case: PENDING order whose reservation was already CONFIRMED must also stay CONFIRMED
      const confirmedResOrder = await createExpiredPendingOrder({
        eventId: publishedEvent.id,
        suffix: 'confirmed_res_safe',
        items: [{ ticketTierId: tier.id, quantity: 2 }],
        orderStatus: OrderStatus.PENDING,
        reservationStatus: ReservationStatus.CONFIRMED,
      });

      await releaseExpiredReservations();

      const tierAfter = await prisma.ticketTier.findUniqueOrThrow({ where: { id: tier.id } });
      expect(tierAfter.reservedQuantity).toBe(2);

      const checkCompleted = await prisma.order.findUniqueOrThrow({
        where: { id: completedOrder.id },
        include: { reservations: true },
      });
      expect(checkCompleted.status).toBe(OrderStatus.COMPLETED);
      expect(checkCompleted.reservations[0].status).toBe(ReservationStatus.CONFIRMED);

      const checkConfRes = await prisma.order.findUniqueOrThrow({
        where: { id: confirmedResOrder.id },
        include: { reservations: true },
      });
      expect(checkConfRes.reservations[0].status).toBe(ReservationStatus.CONFIRMED);
    });

    it('rolls back all tier, reservation, order, and linked offer changes atomically when a mid-batch failure occurs', async () => {
      const tier = await createTestTier({
        eventId: publishedEvent.id,
        name: `Rollback Tier ${runId}`,
        totalCapacity: 10,
        reservedQuantity: 2,
      });

      const entry = await prisma.ticketWaitlistEntry.create({
        data: {
          eventId: publishedEvent.id,
          ticketTierId: tier.id,
          customerName: 'Rollback Waiter',
          customerEmail: `rollback_wait_${runId}@outside.vip`,
          quantity: 2,
          status: WaitlistEntryStatus.OFFERED,
        },
      });

      const order = await createExpiredPendingOrder({
        eventId: publishedEvent.id,
        suffix: 'midbatch_fail',
        items: [{ ticketTierId: tier.id, quantity: 2 }],
      });

      const offer = await prisma.ticketWaitlistOffer.create({
        data: {
          entryId: entry.id,
          eventId: publishedEvent.id,
          ticketTierId: tier.id,
          quantity: 2,
          status: WaitlistOfferStatus.PENDING,
          tokenHash: hashOfferToken(`wlot_rollback_${runId}`),
          expiresAt: new Date(Date.now() - 60_000),
          orderId: order.id,
        },
      });

      // Simulate mid-transaction DB failure when expiring linked orders
      const originalTx = prisma.$transaction.bind(prisma);
      vi.spyOn(prisma, '$transaction').mockImplementationOnce(async (fn: any, opts?: any) => {
        return originalTx(async (tx: any) => {
          const origOrderUpdateMany = tx.order.updateMany.bind(tx.order);
          tx.order.updateMany = async () => {
            throw new Error('Simulated PostgreSQL mid-batch write failure');
          };
          try {
            return await fn(tx);
          } finally {
            tx.order.updateMany = origOrderUpdateMany;
          }
        }, opts);
      });

      await expect(releaseExpiredReservations()).rejects.toThrow(/Simulated PostgreSQL mid-batch/);

      // All records must remain completely rolled back
      const tierAfter = await prisma.ticketTier.findUniqueOrThrow({ where: { id: tier.id } });
      expect(tierAfter.reservedQuantity).toBe(2);

      const orderAfter = await prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        include: { reservations: true },
      });
      expect(orderAfter.status).toBe(OrderStatus.PENDING);
      expect(orderAfter.reservations[0].status).toBe(ReservationStatus.ACTIVE);

      const offerAfter = await prisma.ticketWaitlistOffer.findUniqueOrThrow({
        where: { id: offer.id },
      });
      expect(offerAfter.status).toBe(WaitlistOfferStatus.PENDING);

      const entryAfter = await prisma.ticketWaitlistEntry.findUniqueOrThrow({
        where: { id: entry.id },
      });
      expect(entryAfter.status).toBe(WaitlistEntryStatus.OFFERED);
    });

    it('drains more expired orders than the batch size across multiple sequential batches in a single call', async () => {
      const tier = await createTestTier({
        eventId: publishedEvent.id,
        name: `Batch Drain Tier ${runId}`,
        totalCapacity: 25,
        reservedQuantity: 5,
      });

      const orderIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        const o = await createExpiredPendingOrder({
          eventId: publishedEvent.id,
          suffix: `batch_${i}`,
          items: [{ ticketTierId: tier.id, quantity: 1 }],
        });
        orderIds.push(o.id);
      }

      // 5 expired orders with batchSize=2 -> requires 3 sequential batches in one call
      const totalReleased = await releaseExpiredReservations({ batchSize: 2 });
      expect(totalReleased).toBeGreaterThanOrEqual(5);

      const tierAfter = await prisma.ticketTier.findUniqueOrThrow({ where: { id: tier.id } });
      expect(tierAfter.reservedQuantity).toBe(0);

      const ordersAfter = await prisma.order.findMany({
        where: { id: { in: orderIds } },
      });
      expect(ordersAfter.every((o) => o.status === OrderStatus.EXPIRED)).toBe(true);
    });
  });

  // ==========================================================
  // 2. Payment Fulfillment vs Expiry Race Safety
  // ==========================================================
  describe('2. Payment Concurrency vs Reservation Expiry', () => {
    it('serializes concurrent fulfillPaidOrder and releaseExpiredReservations without corrupting reservation, order, or tier counts', async () => {
      const tier = await createTestTier({
        eventId: publishedEvent.id,
        name: `Pay Race Tier ${runId}`,
        totalCapacity: 10,
        reservedQuantity: 2,
        soldQuantity: 0,
      });

      const piId = `pi_p204_race_${runId}`;
      const order = await createExpiredPendingOrder({
        eventId: publishedEvent.id,
        suffix: 'pay_race',
        items: [{ ticketTierId: tier.id, quantity: 2 }],
        expiresAt: new Date(Date.now() - 2000),
        paymentReference: piId,
      });

      const paymentIntent = {
        id: piId,
        status: 'succeeded',
        amount: order.totalInCents,
        currency: 'usd',
        metadata: { orderId: order.id, orderNumber: order.orderNumber },
      } as any;

      await Promise.all([fulfillPaidOrder(paymentIntent), releaseExpiredReservations()]);

      const tierAfter = await prisma.ticketTier.findUniqueOrThrow({ where: { id: tier.id } });
      const orderAfter = await prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        include: { reservations: true, tickets: true },
      });

      // Regardless of which lock acquired Order first, invariants hold strictly:
      // Payment succeeded -> order COMPLETED, 2 tickets issued, soldQuantity=2, reservedQuantity=0 (never -2!)
      expect(orderAfter.status).toBe(OrderStatus.COMPLETED);
      expect(orderAfter.tickets.length).toBe(2);
      expect(tierAfter.soldQuantity).toBe(2);
      expect(tierAfter.reservedQuantity).toBe(0);

      // Subsequent expiry sweep must not touch the payment-completed order
      await releaseExpiredReservations();
      const tierSecond = await prisma.ticketTier.findUniqueOrThrow({ where: { id: tier.id } });
      const resAfter = await prisma.ticketReservation.findUniqueOrThrow({
        where: { id: order.reservations[0].id },
      });
      expect(tierSecond.reservedQuantity).toBe(0);
      expect(resAfter.status).toBe(ReservationStatus.CONFIRMED);
    });
  });

  // ==========================================================
  // 3. Waitlist Capacity Allocation Concurrency & Eligibility
  // ==========================================================
  describe('3. Waitlist Allocation Locking & Eligibility Rules', () => {
    it('prevents duplicate offers and oversubscription under 5 concurrent processWaitlistForTier calls while enforcing FIFO head-of-line fairness', async () => {
      const tier = await createTestTier({
        eventId: publishedEvent.id,
        name: `Concurrent WL Tier ${runId}`,
        totalCapacity: 3,
        reservedQuantity: 0,
        soldQuantity: 0,
        waitlistEnabled: true,
      });

      // Entry 1 requests 2 tickets, Entry 2 requests 2 tickets (only 1 remaining -> must hold FIFO line, NOT skip to Entry 3!)
      // Wait: Entry 3 requests 1 ticket; FIFO head-of-line stops at Entry 2 so total allocated = 2, remaining = 1.
      const baseTime = Date.now() - 10_000;
      const e1 = await prisma.ticketWaitlistEntry.create({
        data: {
          eventId: publishedEvent.id,
          ticketTierId: tier.id,
          customerName: 'FIFO First',
          customerEmail: `fifo1_${runId}@outside.vip`,
          quantity: 2,
          status: WaitlistEntryStatus.WAITING,
          createdAt: new Date(baseTime),
        },
      });
      const e2 = await prisma.ticketWaitlistEntry.create({
        data: {
          eventId: publishedEvent.id,
          ticketTierId: tier.id,
          customerName: 'FIFO Second Blocked',
          customerEmail: `fifo2_${runId}@outside.vip`,
          quantity: 2,
          status: WaitlistEntryStatus.WAITING,
          createdAt: new Date(baseTime + 1000),
        },
      });
      const e3 = await prisma.ticketWaitlistEntry.create({
        data: {
          eventId: publishedEvent.id,
          ticketTierId: tier.id,
          customerName: 'FIFO Third Waiting',
          customerEmail: `fifo3_${runId}@outside.vip`,
          quantity: 1,
          status: WaitlistEntryStatus.WAITING,
          createdAt: new Date(baseTime + 2000),
        },
      });

      const results = await Promise.all([
        processWaitlistForTier(tier.id),
        processWaitlistForTier(tier.id),
        processWaitlistForTier(tier.id),
        processWaitlistForTier(tier.id),
        processWaitlistForTier(tier.id),
      ]);

      const totalOffersCreated = results.reduce((sum, r) => sum + r.offersCreated, 0);
      expect(totalOffersCreated).toBe(1);

      const offersInDb = await prisma.ticketWaitlistOffer.findMany({
        where: { ticketTierId: tier.id },
      });
      expect(offersInDb.length).toBe(1);
      expect(offersInDb[0].entryId).toBe(e1.id);

      const tierAfter = await prisma.ticketTier.findUniqueOrThrow({ where: { id: tier.id } });
      expect(tierAfter.reservedQuantity).toBe(2);

      const entriesAfter = await prisma.ticketWaitlistEntry.findMany({
        where: { id: { in: [e1.id, e2.id, e3.id] } },
      });
      const statusById = new Map(entriesAfter.map((e) => [e.id, e.status]));
      expect(statusById.get(e1.id)).toBe(WaitlistEntryStatus.OFFERED);
      expect(statusById.get(e2.id)).toBe(WaitlistEntryStatus.WAITING);
      expect(statusById.get(e3.id)).toBe(WaitlistEntryStatus.WAITING);
    });

    it('excludes hidden, sales-disabled, unpublished, cancelled, ended events, and salesEndAt-elapsed tiers', async () => {
      const pastDate = new Date(Date.now() - 3600_000);

      const hiddenTier = await createTestTier({
        eventId: publishedEvent.id,
        name: `Hidden WL ${runId}`,
        totalCapacity: 5,
        waitlistEnabled: true,
        isHidden: true,
      });
      const disabledTier = await createTestTier({
        eventId: publishedEvent.id,
        name: `Disabled WL ${runId}`,
        totalCapacity: 5,
        waitlistEnabled: true,
        salesDisabled: true,
      });
      const salesEndedTier = await createTestTier({
        eventId: publishedEvent.id,
        name: `SalesEnded WL ${runId}`,
        totalCapacity: 5,
        waitlistEnabled: true,
        salesEndAt: pastDate,
      });

      const draftEvent = await createTestEvent({ suffix: 'draft', status: EventStatus.DRAFT });
      const draftTier = await createTestTier({
        eventId: draftEvent.id,
        name: `Draft Event WL ${runId}`,
        totalCapacity: 5,
        waitlistEnabled: true,
      });

      const cancelledEvent = await createTestEvent({
        suffix: 'cancelled',
        status: EventStatus.CANCELLED,
      });
      const cancelledTier = await createTestTier({
        eventId: cancelledEvent.id,
        name: `Cancelled Event WL ${runId}`,
        totalCapacity: 5,
        waitlistEnabled: true,
      });

      const endedEvent = await createTestEvent({ suffix: 'ended', endAt: pastDate });
      const endedTier = await createTestTier({
        eventId: endedEvent.id,
        name: `Ended Event WL ${runId}`,
        totalCapacity: 5,
        waitlistEnabled: true,
      });

      const ineligibleCases = [
        { eventId: publishedEvent.id, tierId: hiddenTier.id, key: 'hidden' },
        { eventId: publishedEvent.id, tierId: disabledTier.id, key: 'disabled' },
        { eventId: publishedEvent.id, tierId: salesEndedTier.id, key: 'salesEnded' },
        { eventId: draftEvent.id, tierId: draftTier.id, key: 'draft' },
        { eventId: cancelledEvent.id, tierId: cancelledTier.id, key: 'cancelled' },
        { eventId: endedEvent.id, tierId: endedTier.id, key: 'ended' },
      ];

      for (const c of ineligibleCases) {
        await prisma.ticketWaitlistEntry.create({
          data: {
            eventId: c.eventId,
            ticketTierId: c.tierId,
            customerName: `Waiter ${c.key}`,
            customerEmail: `wl_${c.key}_${runId}@outside.vip`,
            quantity: 1,
            status: WaitlistEntryStatus.WAITING,
          },
        });
        const res = await processWaitlistForTier(c.tierId);
        expect(res.offersCreated).toBe(0);
      }
    });
  });

  // ==========================================================
  // 4. Offer Expiry Sweeps & Checkout Linking Concurrency
  // ==========================================================
  describe('4. Expired Waitlist Offers & Active Checkout Race Protection', () => {
    it('expires unlinked offers only once across concurrent sweeps and advances FIFO queue post-commit', async () => {
      const tier = await createTestTier({
        eventId: publishedEvent.id,
        name: `Offer Sweep Concurrency ${runId}`,
        totalCapacity: 2,
        reservedQuantity: 2,
        waitlistEnabled: true,
      });

      const firstEntry = await prisma.ticketWaitlistEntry.create({
        data: {
          eventId: publishedEvent.id,
          ticketTierId: tier.id,
          customerName: 'Expired First',
          customerEmail: `sweep_first_${runId}@outside.vip`,
          quantity: 2,
          status: WaitlistEntryStatus.OFFERED,
        },
      });
      const nextEntry = await prisma.ticketWaitlistEntry.create({
        data: {
          eventId: publishedEvent.id,
          ticketTierId: tier.id,
          customerName: 'Next Waiting',
          customerEmail: `sweep_next_${runId}@outside.vip`,
          quantity: 2,
          status: WaitlistEntryStatus.WAITING,
        },
      });

      const expiredOffer = await prisma.ticketWaitlistOffer.create({
        data: {
          entryId: firstEntry.id,
          eventId: publishedEvent.id,
          ticketTierId: tier.id,
          quantity: 2,
          status: WaitlistOfferStatus.PENDING,
          tokenHash: hashOfferToken(`wlot_sweep_conc_${runId}`),
          expiresAt: new Date(Date.now() - 120_000),
          orderId: null,
        },
      });

      const [s1, s2, s3] = await Promise.all([
        sweepExpiredOffers(),
        sweepExpiredOffers(),
        sweepExpiredOffers(),
      ]);

      expect(s1.expiredOffersCount + s2.expiredOffersCount + s3.expiredOffersCount).toBe(1);

      const expiredOfferAfter = await prisma.ticketWaitlistOffer.findUniqueOrThrow({
        where: { id: expiredOffer.id },
      });
      expect(expiredOfferAfter.status).toBe(WaitlistOfferStatus.EXPIRED);

      // Freed 2 tickets were cleanly re-allocated exactly once to nextEntry!
      const tierAfter = await prisma.ticketTier.findUniqueOrThrow({ where: { id: tier.id } });
      expect(tierAfter.reservedQuantity).toBe(2);

      const nextOffers = await prisma.ticketWaitlistOffer.findMany({
        where: { entryId: nextEntry.id },
      });
      expect(nextOffers.length).toBe(1);
      expect(nextOffers[0].status).toBe(WaitlistOfferStatus.PENDING);
    });

    it('never expires an offer linked to an active checkout or an offer becoming linked during sweep execution', async () => {
      const tier = await createTestTier({
        eventId: publishedEvent.id,
        name: `Offer Link Race ${runId}`,
        totalCapacity: 2,
        reservedQuantity: 2,
        waitlistEnabled: true,
      });

      const entry = await prisma.ticketWaitlistEntry.create({
        data: {
          eventId: publishedEvent.id,
          ticketTierId: tier.id,
          customerName: 'Offer Racing Checkout',
          customerEmail: `offer_link_race_${runId}@outside.vip`,
          quantity: 2,
          status: WaitlistEntryStatus.OFFERED,
        },
      });

      const rawToken = `wlot_race_link_${runId}`;
      const offer = await prisma.ticketWaitlistOffer.create({
        data: {
          entryId: entry.id,
          eventId: publishedEvent.id,
          ticketTierId: tier.id,
          quantity: 2,
          status: WaitlistOfferStatus.PENDING,
          // Expires slightly in past to allow sweep eligibility if unlinked, while checkout validates > now:
          // Here we first hold lock via concurrent checkout with valid expiry, then also test linked expired offer.
          tokenHash: hashOfferToken(rawToken),
          expiresAt: new Date(Date.now() + 30_000),
          orderId: null,
        },
      });

      // Mock Stripe PaymentIntent so checkout finishes cleanly
      vi.spyOn(stripe.paymentIntents, 'create').mockResolvedValueOnce({
        id: `pi_wl_race_${runId}`,
        client_secret: `pi_wl_race_${runId}_secret`,
      } as any);

      // Step A: Backdate offer just after checkout starts? Actually test concurrent transaction locking:
      // Force offer expiresAt < now while checkout has verified pre-tx and is acquiring FOR UPDATE lock.
      // First verify linked order protection directly:
      const linkedOrder = await prisma.order.create({
        data: {
          orderNumber: `P204-LINK-${runId}`.slice(0, 32),
          eventId: publishedEvent.id,
          status: OrderStatus.PENDING,
          customerEmail: entry.customerEmail,
          customerName: entry.customerName,
          totalInCents: 5000,
          currency: 'USD',
          idempotencyKey: `p204_wl_link_idem_${runId}`,
          expiresAt: new Date(Date.now() + 25 * 60_000),
          reservations: {
            create: [
              {
                ticketTierId: tier.id,
                quantity: 2,
                expiresAt: new Date(Date.now() + 25 * 60_000),
                status: ReservationStatus.ACTIVE,
              },
            ],
          },
        },
      });

      await prisma.ticketWaitlistOffer.update({
        where: { id: offer.id },
        data: {
          orderId: linkedOrder.id,
          expiresAt: new Date(Date.now() - 60_000),
        },
      });

      const sweepLinked = await sweepExpiredOffers();
      expect(sweepLinked.expiredOffersCount).toBe(0);

      const offerStillPending = await prisma.ticketWaitlistOffer.findUniqueOrThrow({
        where: { id: offer.id },
      });
      expect(offerStillPending.status).toBe(WaitlistOfferStatus.PENDING);

      const tierStillHeld = await prisma.ticketTier.findUniqueOrThrow({
        where: { id: tier.id },
      });
      expect(tierStillHeld.reservedQuantity).toBe(2);
    });

    it('protects unlinked offer claimed concurrently by checkout before sweep commits (SKIP LOCKED)', async () => {
      const tier = await createTestTier({
        eventId: publishedEvent.id,
        name: `Offer SkipLocked ${runId}`,
        totalCapacity: 2,
        reservedQuantity: 2,
        waitlistEnabled: true,
      });

      const entry = await prisma.ticketWaitlistEntry.create({
        data: {
          eventId: publishedEvent.id,
          ticketTierId: tier.id,
          customerName: 'SkipLocked Buyer',
          customerEmail: `skiplocked_${runId}@outside.vip`,
          quantity: 2,
          status: WaitlistEntryStatus.OFFERED,
        },
      });

      const rawToken = `wlot_skiplock_${runId}`;
      const offer = await prisma.ticketWaitlistOffer.create({
        data: {
          entryId: entry.id,
          eventId: publishedEvent.id,
          ticketTierId: tier.id,
          quantity: 2,
          status: WaitlistOfferStatus.PENDING,
          tokenHash: hashOfferToken(rawToken),
          expiresAt: new Date(Date.now() - 10_000), // Eligible for sweep if unlocked
          orderId: null,
        },
      });

      // Hold FOR UPDATE lock on the offer row inside a live PG tx (simulating checkout linking orderId)
      let releaseCheckoutLock!: () => void;
      let notifyLocked!: () => void;
      const lockedPromise = new Promise<void>((resolve) => {
        notifyLocked = resolve;
      });
      const holdPromise = new Promise<void>((resolve) => {
        releaseCheckoutLock = resolve;
      });

      const checkoutTxPromise = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT id FROM "TicketWaitlistOffer" WHERE id = ${offer.id} FOR UPDATE
        `;
        notifyLocked();
        await holdPromise;

        const linkedOrder = await tx.order.create({
          data: {
            orderNumber: `P204-SL-${runId}`.slice(0, 32),
            eventId: publishedEvent.id,
            status: OrderStatus.PENDING,
            customerEmail: entry.customerEmail,
            customerName: entry.customerName,
            totalInCents: 5000,
            currency: 'USD',
            idempotencyKey: `p204_sl_idem_${runId}`,
            expiresAt: new Date(Date.now() + 30 * 60_000),
          },
        });
        await tx.ticketWaitlistOffer.update({
          where: { id: offer.id },
          data: { orderId: linkedOrder.id },
        });
      });

      await lockedPromise;

      // While checkout holds the lock, sweepExpiredOffers uses FOR UPDATE SKIP LOCKED and skips it immediately!
      const sweepDuringLock = await sweepExpiredOffers();
      expect(sweepDuringLock.expiredOffersCount).toBe(0);

      releaseCheckoutLock();
      await checkoutTxPromise;

      // After checkout commits orderId link, sweep still must not expire it
      const sweepAfterLink = await sweepExpiredOffers();
      expect(sweepAfterLink.expiredOffersCount).toBe(0);

      const finalOffer = await prisma.ticketWaitlistOffer.findUniqueOrThrow({ where: { id: offer.id } });
      expect(finalOffer.status).toBe(WaitlistOfferStatus.PENDING);
      expect(finalOffer.orderId).not.toBeNull();

      const finalTier = await prisma.ticketTier.findUniqueOrThrow({ where: { id: tier.id } });
      expect(finalTier.reservedQuantity).toBe(2);
    });
  });

  // ==========================================================
  // 5. Worker Lifecycle & Maintenance Endpoint Auth
  // ==========================================================
  describe('5. Background Worker Lifecycle & Maintenance Endpoint Credentials', () => {
    it('drains in-flight maintenance pass on shutdown, cleans startup timers, and continues running after pass failures', async () => {
      const tier = await createTestTier({
        eventId: publishedEvent.id,
        name: `Worker Recovery Tier ${runId}`,
        totalCapacity: 10,
        reservedQuantity: 1,
      });
      await createExpiredPendingOrder({
        eventId: publishedEvent.id,
        suffix: 'worker_recover',
        items: [{ ticketTierId: tier.id, quantity: 1 }],
      });

      // Simulate transient DB failure on the first transaction inside pass
      vi.spyOn(prisma, '$transaction').mockRejectedValueOnce(new Error('Transient DB blip'));

      const failedPassResult = await runWaitlistMaintenancePass();
      expect(failedPassResult.releasedReservations).toBe(0);

      // Future passes must not remain permanently locked by the earlier error
      vi.restoreAllMocks();
      const recoveredResult = await runWaitlistMaintenancePass();
      expect(recoveredResult.releasedReservations).toBeGreaterThanOrEqual(1);

      const tierAfterRecover = await prisma.ticketTier.findUniqueOrThrow({ where: { id: tier.id } });
      expect(tierAfterRecover.reservedQuantity).toBe(0);

      // Start worker with long timers, hold an in-flight pass inside real $transaction, and ensure stop awaits drain
      let releaseSlowPass!: () => void;
      const slowGate = new Promise<void>((resolve) => {
        releaseSlowPass = resolve;
      });
      let notifyPassEntered!: () => void;
      const enteredPromise = new Promise<void>((resolve) => {
        notifyPassEntered = resolve;
      });

      const origTx = prisma.$transaction.bind(prisma);
      vi.spyOn(prisma, '$transaction').mockImplementationOnce(async (fn: any, opts?: any) => {
        notifyPassEntered();
        await slowGate;
        return origTx(fn, opts);
      });

      startWaitlistBackgroundWorker(60_000, 60_000);
      expect(isWaitlistBackgroundWorkerRunning()).toBe(true);

      const inFlightPass = runWaitlistMaintenancePass();
      await enteredPromise;

      let shutdownResolved = false;
      const shutdownPromise = stopWaitlistBackgroundWorker(2000).then(() => {
        shutdownResolved = true;
      });

      // Shutdown must wait while pass is active
      await new Promise((r) => setTimeout(r, 30));
      expect(shutdownResolved).toBe(false);
      expect(isWaitlistBackgroundWorkerRunning()).toBe(false);

      // Release slow pass -> shutdown drains cleanly
      releaseSlowPass();
      await Promise.all([inFlightPass, shutdownPromise]);
      expect(shutdownResolved).toBe(true);
    });

    it('fails closed on both maintenance endpoints when secrets are unset and accepts valid CRON_SECRET / MAINTENANCE_KEY', async () => {
      const prevCron = process.env.CRON_SECRET;
      const prevMaint = process.env.MAINTENANCE_KEY;

      try {
        delete process.env.CRON_SECRET;
        delete process.env.MAINTENANCE_KEY;

        // Unconfigured secrets -> 503 fail closed (never public access)
        const unconfiguredWaitlist = await request(app).post('/api/waitlist/maintenance');
        expect(unconfiguredWaitlist.status).toBe(503);
        expect(unconfiguredWaitlist.body.error.code).toBe('MAINTENANCE_SECRET_NOT_CONFIGURED');

        const unconfiguredCleanup = await request(app).post('/api/checkout/cleanup-reservations');
        expect(unconfiguredCleanup.status).toBe(503);
        expect(unconfiguredCleanup.body.error.code).toBe('MAINTENANCE_SECRET_NOT_CONFIGURED');

        // Configure CRON_SECRET -> reject missing/wrong tokens, allow valid Bearer and custom header
        process.env.CRON_SECRET = 'p204_cron_secret_value';

        const missingAuth = await request(app).post('/api/checkout/cleanup-reservations');
        expect(missingAuth.status).toBe(401);

        const wrongAuth = await request(app)
          .post('/api/checkout/cleanup-reservations')
          .set('Authorization', 'Bearer wrong');
        expect(wrongAuth.status).toBe(401);

        const validCleanup = await request(app)
          .post('/api/checkout/cleanup-reservations')
          .set('Authorization', 'Bearer p204_cron_secret_value');
        expect(validCleanup.status).toBe(200);
        expect(validCleanup.body.success).toBe(true);

        const validWaitlistHeader = await request(app)
          .post('/api/waitlist/maintenance')
          .set('x-cron-secret', 'p204_cron_secret_value');
        expect(validWaitlistHeader.status).toBe(200);

        // Configure MAINTENANCE_KEY fallback when CRON_SECRET unset
        delete process.env.CRON_SECRET;
        process.env.MAINTENANCE_KEY = 'p204_maint_key_value';

        const validMaintKey = await request(app)
          .post('/api/checkout/cleanup-reservations')
          .set('x-maintenance-key', 'p204_maint_key_value');
        expect(validMaintKey.status).toBe(200);
      } finally {
        if (prevCron === undefined) delete process.env.CRON_SECRET;
        else process.env.CRON_SECRET = prevCron;
        if (prevMaint === undefined) delete process.env.MAINTENANCE_KEY;
        else process.env.MAINTENANCE_KEY = prevMaint;
      }
    });
  });
});
