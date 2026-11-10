import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../app.js';
import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';
import { ticketTierInputSchema } from '../modules/organizer/organizer.schema.js';
import { TicketTierStatus, EventStatus } from '@prisma/client';

describe('Ticket Sales Period and Ticket Validity Controls API', () => {
  const organizerId = 'org-user-sales-validity-111';
  const organizerToken = jwt.sign(
    { userId: organizerId, email: 'organizer@outside.vip', role: 'ORGANIZER' },
    env.JWT_SECRET
  );

  let testEvent: any;
  let unrestrictedTier: any;
  let futureSalesTier: any;
  let activeSalesTier: any;
  let expiredSalesTier: any;

  beforeAll(async () => {
    // Ensure an organizer user exists or create a mock event in DB
    let orgUser = await prisma.user.findUnique({
      where: { id: organizerId },
    });
    if (!orgUser) {
      orgUser = await prisma.user.create({
        data: {
          id: organizerId,
          email: 'org-sales-validity@outside.vip',
          passwordHash: 'dummy-hash',
          name: 'Organizer Sales Validity Tester',
          role: 'ORGANIZER',
        },
      });
    }

    testEvent = await prisma.event.create({
      data: {
        id: `evt-sales-val-${Date.now()}`,
        organizerId: orgUser.id,
        title: 'Sunset Electronic Festival: Nairobi Baobab Edition',
        slug: `sunset-fest-sales-val-${Date.now()}`,
        description: 'Testing sales period and ticket validity',
        category: 'MUSIC',
        timezone: 'Africa/Nairobi',
        startAt: new Date(Date.now() + 7 * 24 * 3600 * 1000), // 7 days from now
        endAt: new Date(Date.now() + 7 * 24 * 3600 * 1000 + 6 * 3600 * 1000),
        status: EventStatus.PUBLISHED,
        venueName: 'Baobab Forest Park',
        venueAddress: '123 Baobab Way, Karen',
        city: 'Nairobi',
        country: 'Kenya',
        coverImageUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819',
      },
    });

    // 1. Unrestricted tier (no sales limits, no validity limits)
    unrestrictedTier = await prisma.ticketTier.create({
      data: {
        eventId: testEvent.id,
        name: 'General Admission - Open Sales',
        priceInCents: 3000,
        currency: 'USD',
        totalCapacity: 500,
        reservedQuantity: 0,
        soldQuantity: 0,
        status: TicketTierStatus.ACTIVE,
      },
    });

    // 2. Future sales tier (salesStartAt in future)
    futureSalesTier = await prisma.ticketTier.create({
      data: {
        eventId: testEvent.id,
        name: 'Presale Tier - Not Yet Open',
        priceInCents: 2000,
        currency: 'USD',
        totalCapacity: 200,
        reservedQuantity: 0,
        soldQuantity: 0,
        status: TicketTierStatus.ACTIVE,
        salesStartAt: new Date(Date.now() + 2 * 24 * 3600 * 1000), // 2 days in future
        salesEndAt: new Date(Date.now() + 4 * 24 * 3600 * 1000),
      },
    });

    // 3. Active sales tier (salesStartAt in past, salesEndAt in future)
    activeSalesTier = await prisma.ticketTier.create({
      data: {
        eventId: testEvent.id,
        name: 'Active Sales Window Tier',
        priceInCents: 2500,
        currency: 'USD',
        totalCapacity: 200,
        reservedQuantity: 0,
        soldQuantity: 0,
        status: TicketTierStatus.ACTIVE,
        salesStartAt: new Date(Date.now() - 1 * 24 * 3600 * 1000), // 1 day ago
        salesEndAt: new Date(Date.now() + 3 * 24 * 3600 * 1000), // 3 days in future
      },
    });

    // 4. Expired sales tier (salesEndAt in past)
    expiredSalesTier = await prisma.ticketTier.create({
      data: {
        eventId: testEvent.id,
        name: 'Early Bird - Sales Concluded',
        priceInCents: 1500,
        currency: 'USD',
        totalCapacity: 100,
        reservedQuantity: 0,
        soldQuantity: 0,
        status: TicketTierStatus.ACTIVE,
        salesStartAt: new Date(Date.now() - 5 * 24 * 3600 * 1000),
        salesEndAt: new Date(Date.now() - 1 * 3600 * 1000), // 1 hour ago
      },
    });
  }, 30000);

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------
  // PART 1: Limit Ticket Sales Period (Purchase & Checkout API)
  // -------------------------------------------------------------
  describe('Part 1: Ticket Sales Period Enforcement at Checkout', () => {
    it('1.1: Rejects checkout when sales period has not started yet (before sales window)', async () => {
      const res = await request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: testEvent.id,
          customerEmail: 'buyer1@example.com',
          customerName: 'Amani Buyer',
          customerPhone: '+254712345678',
          items: [
            {
              ticketTierId: futureSalesTier.id,
              quantity: 1,
            },
          ],
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain(`Sales for '${futureSalesTier.name}' have not started yet`);
    });

    it('1.2: Allows checkout when current time is between salesStartAt and salesEndAt (during sales window)', async () => {
      const res = await request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: testEvent.id,
          customerEmail: 'buyer2@example.com',
          customerName: 'Baraka Buyer',
          customerPhone: '+254712345678',
          items: [
            {
              ticketTierId: activeSalesTier.id,
              quantity: 1,
            },
          ],
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.orderNumber).toBeDefined();
      expect(res.body.data.clientSecret).toBeDefined();
    });

    it('1.3: Rejects checkout when sales period has concluded (after sales window)', async () => {
      const res = await request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: testEvent.id,
          customerEmail: 'buyer3@example.com',
          customerName: 'Chizi Buyer',
          customerPhone: '+254712345678',
          items: [
            {
              ticketTierId: expiredSalesTier.id,
              quantity: 1,
            },
          ],
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain(`Sales for '${expiredSalesTier.name}' have concluded`);
    });

    it('1.4: Allows checkout normally when ticket tier has no sales period configured (unrestricted)', async () => {
      const res = await request(app)
        .post('/api/checkout/create-session')
        .send({
          eventId: testEvent.id,
          customerEmail: 'buyer4@example.com',
          customerName: 'Daudi Buyer',
          customerPhone: '+254712345678',
          items: [
            {
              ticketTierId: unrestrictedTier.id,
              quantity: 2,
            },
          ],
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.orderNumber).toBeDefined();
    });

    it('1.5: Schema validation rejects salesEndAt that is earlier than or equal to salesStartAt', () => {
      const now = new Date();
      const earlier = new Date(now.getTime() - 3600000);

      const invalidTierData = {
        name: 'Invalid Sales Window Tier',
        totalCapacity: 100,
        salesStartAt: now.toISOString(),
        salesEndAt: earlier.toISOString(),
      };

      const result = ticketTierInputSchema.safeParse(invalidTierData);
      expect(result.success).toBe(false);
      if (!result.success) {
        const salesIssue = result.error.issues.find((issue) => issue.path.includes('salesEndAt'));
        expect(salesIssue).toBeDefined();
        expect(salesIssue?.message).toContain('Sales start time must precede sales end time');
      }
    });
  });

  // -------------------------------------------------------------
  // PART 2: Limit Ticket Validity (QR Scanner & Check-in API)
  // -------------------------------------------------------------
  describe('Part 2: Ticket Validity Window Enforcement at Entry Gate', () => {
    const mockOrder = {
      orderNumber: 'OUT-2026-VAL01',
      status: 'COMPLETED',
      customerName: 'Grace Hopper',
      customerEmail: 'grace@example.com',
    };

    it('2.1: Rejects check-in with 400 TICKET_NOT_YET_VALID when scanned before validity window opens', async () => {
      const validityStartAt = new Date(Date.now() + 2 * 3600 * 1000); // 2 hours from now
      const validityEndAt = new Date(Date.now() + 6 * 3600 * 1000);

      const mockTicket = {
        id: 'tkt-future-validity-1',
        ticketToken: 'tkt_sec_future_validity_111',
        eventId: testEvent.id,
        ticketTierId: 'tier-val-1',
        orderId: 'ord-val-1',
        attendeeName: 'Grace Hopper',
        attendeeEmail: 'grace@example.com',
        status: 'ISSUED',
        checkedInAt: null,
        checkedInByUserId: null,
        event: testEvent,
        ticketTier: {
          name: 'Late Entry Pass (After 11 PM)',
          validityStartAt,
          validityEndAt,
        },
        order: mockOrder,
        checkedInByUser: null,
      };

      vi.spyOn(prisma.ticket, 'findUnique').mockResolvedValue(mockTicket as any);
      const logSpy = vi.spyOn(prisma.checkInLog, 'create').mockResolvedValue({} as any);

      const res = await request(app)
        .post('/api/organizer/check-in')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          token: 'tkt_sec_future_validity_111',
          eventId: testEvent.slug,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('TICKET_NOT_YET_VALID');
      expect(res.body.error.message).toContain('not yet valid for entry');
      expect(res.body.data.result).toBe('TICKET_NOT_YET_VALID');
      expect(res.body.data.ticket.validityStartAt).toBeDefined();

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            ticketId: mockTicket.id,
            result: 'TICKET_NOT_YET_VALID',
          }),
        })
      );
    });

    it('2.2: Admits attendee with 200 SUCCESS when scanned within active validity window', async () => {
      const validityStartAt = new Date(Date.now() - 1 * 3600 * 1000); // 1 hour ago
      const validityEndAt = new Date(Date.now() + 3 * 3600 * 1000); // 3 hours in future

      const mockTicket = {
        id: 'tkt-active-validity-2',
        ticketToken: 'tkt_sec_active_validity_222',
        eventId: testEvent.id,
        ticketTierId: 'tier-val-2',
        orderId: 'ord-val-2',
        attendeeName: 'Grace Hopper',
        attendeeEmail: 'grace@example.com',
        status: 'ISSUED',
        checkedInAt: null,
        checkedInByUserId: null,
        event: testEvent,
        ticketTier: {
          name: 'Early Entry Pass (Before 10 PM)',
          validityStartAt,
          validityEndAt,
        },
        order: mockOrder,
        checkedInByUser: null,
      };

      vi.spyOn(prisma.ticket, 'findUnique').mockResolvedValue(mockTicket as any);
      vi.spyOn(prisma.ticket, 'updateMany').mockResolvedValue({ count: 1 });
      const logSpy = vi.spyOn(prisma.checkInLog, 'create').mockResolvedValue({} as any);

      const res = await request(app)
        .post('/api/organizer/check-in')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          token: 'tkt_sec_active_validity_222',
          eventId: testEvent.slug,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.result).toBe('SUCCESS');
      expect(res.body.data.ticket.checkedInAt).toBeDefined();
      expect(res.body.data.ticket.validityStartAt).toBeDefined();
      expect(res.body.data.ticket.validityEndAt).toBeDefined();

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            ticketId: mockTicket.id,
            result: 'SUCCESS',
          }),
        })
      );
    });

    it('2.3: Rejects check-in with 400 TICKET_EXPIRED when scanned after validity window has passed', async () => {
      const validityStartAt = new Date(Date.now() - 4 * 3600 * 1000); // 4 hours ago
      const validityEndAt = new Date(Date.now() - 30 * 60 * 1000); // 30 minutes ago

      const mockTicket = {
        id: 'tkt-expired-validity-3',
        ticketToken: 'tkt_sec_expired_validity_333',
        eventId: testEvent.id,
        ticketTierId: 'tier-val-3',
        orderId: 'ord-val-3',
        attendeeName: 'Grace Hopper',
        attendeeEmail: 'grace@example.com',
        status: 'ISSUED',
        checkedInAt: null,
        checkedInByUserId: null,
        event: testEvent,
        ticketTier: {
          name: 'Afternoon Session Pass',
          validityStartAt,
          validityEndAt,
        },
        order: mockOrder,
        checkedInByUser: null,
      };

      vi.spyOn(prisma.ticket, 'findUnique').mockResolvedValue(mockTicket as any);
      const logSpy = vi.spyOn(prisma.checkInLog, 'create').mockResolvedValue({} as any);

      const res = await request(app)
        .post('/api/organizer/check-in')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          token: 'tkt_sec_expired_validity_333',
          eventId: testEvent.slug,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('TICKET_EXPIRED');
      expect(res.body.error.message).toContain('validity expired');
      expect(res.body.data.result).toBe('TICKET_EXPIRED');
      expect(res.body.data.ticket.validityEndAt).toBeDefined();

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            ticketId: mockTicket.id,
            result: 'TICKET_EXPIRED',
          }),
        })
      );
    });

    it('2.4: Preserves normal check-in behavior for tickets without configured validity window', async () => {
      const mockTicket = {
        id: 'tkt-unrestricted-validity-4',
        ticketToken: 'tkt_sec_unrestricted_444',
        eventId: testEvent.id,
        ticketTierId: 'tier-val-unrestricted',
        orderId: 'ord-val-4',
        attendeeName: 'Grace Hopper',
        attendeeEmail: 'grace@example.com',
        status: 'ISSUED',
        checkedInAt: null,
        checkedInByUserId: null,
        event: testEvent,
        ticketTier: {
          name: 'General Admission - All Day',
          validityStartAt: null,
          validityEndAt: null,
        },
        order: mockOrder,
        checkedInByUser: null,
      };

      vi.spyOn(prisma.ticket, 'findUnique').mockResolvedValue(mockTicket as any);
      vi.spyOn(prisma.ticket, 'updateMany').mockResolvedValue({ count: 1 });
      vi.spyOn(prisma.checkInLog, 'create').mockResolvedValue({} as any);

      const res = await request(app)
        .post('/api/organizer/check-in')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          token: 'tkt_sec_unrestricted_444',
          eventId: testEvent.slug,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.result).toBe('SUCCESS');
      expect(res.body.data.ticket.validityStartAt).toBeNull();
      expect(res.body.data.ticket.validityEndAt).toBeNull();
    });

    it('2.5: Schema validation rejects validityEndAt that is earlier than or equal to validityStartAt', () => {
      const now = new Date();
      const earlier = new Date(now.getTime() - 1800000);

      const invalidTierData = {
        name: 'Invalid Validity Tier',
        totalCapacity: 150,
        validityStartAt: now.toISOString(),
        validityEndAt: earlier.toISOString(),
      };

      const result = ticketTierInputSchema.safeParse(invalidTierData);
      expect(result.success).toBe(false);
      if (!result.success) {
        const validityIssue = result.error.issues.find((issue) => issue.path.includes('validityEndAt'));
        expect(validityIssue).toBeDefined();
        expect(validityIssue?.message).toContain('Ticket validity start time must precede validity end time');
      }
    });
  });

  // -------------------------------------------------------------
  // PART 3: Independence of Sales Period & Ticket Validity
  // -------------------------------------------------------------
  describe('Part 3: Independence of Sales Period and Ticket Validity', () => {
    it('3.1: Already-purchased tickets remain valid for entry even after sales period ends', async () => {
      // Sales period ended 3 days ago, but entry validity is active right now!
      const salesEndAt = new Date(Date.now() - 3 * 24 * 3600 * 1000);
      const validityStartAt = new Date(Date.now() - 1 * 3600 * 1000);
      const validityEndAt = new Date(Date.now() + 4 * 3600 * 1000);

      const mockTicket = {
        id: 'tkt-sales-closed-valid-entry',
        ticketToken: 'tkt_sec_sales_closed_entry_ok',
        eventId: testEvent.id,
        ticketTierId: 'tier-val-closed-sales',
        orderId: 'ord-val-5',
        attendeeName: 'Grace Hopper',
        attendeeEmail: 'grace@example.com',
        status: 'ISSUED',
        checkedInAt: null,
        checkedInByUserId: null,
        event: testEvent,
        ticketTier: {
          name: 'Early Bird Pass (Sales Ended, Event Active)',
          salesEndAt,
          validityStartAt,
          validityEndAt,
        },
        order: {
          orderNumber: 'OUT-2026-VAL05',
          status: 'COMPLETED',
          customerName: 'Grace Hopper',
          customerEmail: 'grace@example.com',
        },
        checkedInByUser: null,
      };

      vi.spyOn(prisma.ticket, 'findUnique').mockResolvedValue(mockTicket as any);
      vi.spyOn(prisma.ticket, 'updateMany').mockResolvedValue({ count: 1 });
      vi.spyOn(prisma.checkInLog, 'create').mockResolvedValue({} as any);

      const res = await request(app)
        .post('/api/organizer/check-in')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          token: 'tkt_sec_sales_closed_entry_ok',
          eventId: testEvent.slug,
        });

      // The ticket MUST NOT be rejected merely because sales closed!
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.result).toBe('SUCCESS');
    });
  });

  // -------------------------------------------------------------
  // PART 4: Public Event Details & Computed Sales Status
  // -------------------------------------------------------------
  describe('Part 4: Public Event Details & Availability Flags', () => {
    it('4.1: Computes isSalesPending, isSalesEnded and isAvailable accurately on public event API', async () => {
      const res = await request(app).get(`/api/events/${testEvent.slug}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const tiers = res.body.data.event.ticketTiers;
      const futureTier = tiers.find((t: any) => t.id === futureSalesTier.id);
      const activeTier = tiers.find((t: any) => t.id === activeSalesTier.id);
      const expiredTier = tiers.find((t: any) => t.id === expiredSalesTier.id);
      const unresTier = tiers.find((t: any) => t.id === unrestrictedTier.id);

      // Future sales
      expect(futureTier).toBeDefined();
      expect(futureTier.isSalesPending).toBe(true);
      expect(futureTier.isSalesEnded).toBe(false);
      expect(futureTier.isAvailable).toBe(false);

      // Active sales
      expect(activeTier).toBeDefined();
      expect(activeTier.isSalesPending).toBe(false);
      expect(activeTier.isSalesEnded).toBe(false);
      expect(activeTier.isAvailable).toBe(true);

      // Expired sales
      expect(expiredTier).toBeDefined();
      expect(expiredTier.isSalesPending).toBe(false);
      expect(expiredTier.isSalesEnded).toBe(true);
      expect(expiredTier.isAvailable).toBe(false);

      // Unrestricted
      expect(unresTier).toBeDefined();
      expect(unresTier.isSalesPending).toBe(false);
      expect(unresTier.isSalesEnded).toBe(false);
      expect(unresTier.isAvailable).toBe(true);
    });
  });

  afterAll(async () => {
    if (testEvent?.id) {
      await prisma.checkInLog.deleteMany({ where: { ticket: { eventId: testEvent.id } } }).catch(() => {});
      await prisma.paymentTransaction.deleteMany({ where: { order: { eventId: testEvent.id } } }).catch(() => {});
      await prisma.ticketReservation.deleteMany({ where: { eventId: testEvent.id } }).catch(() => {});
      await prisma.ticket.deleteMany({ where: { eventId: testEvent.id } }).catch(() => {});
      await prisma.orderItem.deleteMany({ where: { order: { eventId: testEvent.id } } }).catch(() => {});
      await prisma.order.deleteMany({ where: { eventId: testEvent.id } }).catch(() => {});
      await prisma.ticketTier.deleteMany({ where: { eventId: testEvent.id } }).catch(() => {});
      await prisma.event.delete({ where: { id: testEvent.id } }).catch(() => {});
    }
  }, 30000);
});
