import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { nanoid } from 'nanoid';
import { EventCategory, EventStatus, OrderStatus, PaymentProvider, Role, TicketStatus } from '@prisma/client';
import { app } from '../app.js';
import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';
import { getRedisClient } from '../lib/redis.js';
import { createSession } from '../lib/session.service.js';

describe('Organizer Check-In & Scanner Validation API', () => {
  const organizerId = 'org-user-uuid-111';
  const otherOrganizerId = 'org-user-uuid-999';

  const organizerToken = jwt.sign(
    { userId: organizerId, email: 'organizer@outside.vip', role: 'ORGANIZER', emailVerified: true },
    env.JWT_SECRET
  );

  const attendeeToken = jwt.sign(
    { userId: 'attendee-uuid-555', email: 'attendee@outside.vip', role: 'ATTENDEE', emailVerified: true },
    env.JWT_SECRET
  );

  const adminToken = jwt.sign(
    { userId: 'admin-uuid-000', email: 'admin@outside.vip', role: 'ADMIN', emailVerified: true },
    env.JWT_SECRET
  );

  const mockEventSavannah = {
    id: 'evt-savannah-111',
    title: 'SAVANNAH CINEMA: African Classic Film & Vinyl',
    slug: 'savannah-cinema-vinyl-under-stars',
    organizerId,
  };

  const mockEventSolFest = {
    id: 'evt-solfest-222',
    title: 'SOL FEST: Under The Baobab Tree',
    slug: 'sol-fest-baobab-edition-2026',
    organizerId,
  };

  const mockTicketSavannah = {
    id: 'tkt-savannah-001',
    ticketToken: 'tkt_sec_9kTftYU2E7CA5k2CIdOZxd56',
    eventId: mockEventSavannah.id,
    ticketTierId: 'tier-sav-1',
    orderId: 'ord-sav-1',
    attendeeName: 'Kipchoge Keino',
    attendeeEmail: 'kipchoge@example.com',
    status: 'ISSUED',
    checkedInAt: null,
    checkedInByUserId: null,
    event: mockEventSavannah,
    ticketTier: { name: 'Sunset Lawn Pass' },
    order: {
      orderNumber: 'OUT-2026-SAV01',
      status: 'COMPLETED',
      customerName: 'Kipchoge Keino',
      customerEmail: 'kipchoge@example.com',
    },
    checkedInByUser: null,
  };

  const mockTicketSolFest = {
    id: 'tkt-solfest-002',
    ticketToken: 'tkt_sec_5WaHB1t7AVsxXFVsWeB7MikM',
    eventId: mockEventSolFest.id,
    ticketTierId: 'tier-sol-1',
    orderId: 'ord-sol-1',
    attendeeName: 'Wangari Maathai',
    attendeeEmail: 'wangari@example.com',
    status: 'ISSUED',
    checkedInAt: null,
    checkedInByUserId: null,
    event: mockEventSolFest,
    ticketTier: { name: 'VIP Baobab Terrace' },
    order: {
      orderNumber: 'OUT-2026-SOL02',
      status: 'COMPLETED',
      customerName: 'Wangari Maathai',
      customerEmail: 'wangari@example.com',
    },
    checkedInByUser: null,
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockTransactionalAdmission(
    ticketRecord: any,
    options?: {
      concurrentSingleAdmit?: boolean;
      checkInLogCreateSpy?: ReturnType<typeof vi.fn>;
    }
  ) {
    let claimed = false;
    const ticketUpdateSpy = vi.fn().mockResolvedValue({ ...ticketRecord, status: 'CHECKED_IN' });
    const checkInLogCreateSpy = options?.checkInLogCreateSpy ?? vi.fn().mockResolvedValue({});
    const countSpy = vi.spyOn(prisma.ticket, 'count').mockResolvedValue(1);

    const txSpy = vi.spyOn(prisma, '$transaction').mockImplementation(async (cb: any) => {
      const txStatus =
        options?.concurrentSingleAdmit && claimed ? 'CHECKED_IN' : ticketRecord.status;
      if (options?.concurrentSingleAdmit && !claimed && txStatus === 'ISSUED') {
        claimed = true;
      }

      const txMock: any = {
        $queryRaw: vi
          .fn()
          .mockResolvedValueOnce([
            {
              status: ticketRecord.order?.status ?? 'COMPLETED',
              eventStatus: ticketRecord.event?.status ?? 'PUBLISHED',
            },
          ])
          .mockResolvedValueOnce([
            {
              id: ticketRecord.id,
              status: txStatus,
              checkedInAt:
                txStatus === 'CHECKED_IN' ? new Date() : ticketRecord.checkedInAt ?? null,
              checkedInByUserId:
                txStatus === 'CHECKED_IN' ? organizerId : ticketRecord.checkedInByUserId ?? null,
            },
          ]),
        checkInLog: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: checkInLogCreateSpy,
        },
        ticket: {
          update: ticketUpdateSpy,
        },
      };
      return cb(txMock);
    });

    return { txSpy, ticketUpdateSpy, checkInLogCreateSpy, countSpy };
  }

  describe('Real PostgreSQL Transactional Admission, Concurrency & Refund/Cancellation Enforcement', () => {
    const pgUserIds: string[] = [];
    const pgEventIds: string[] = [];
    const pgOrderIds: string[] = [];

    let pgSessionCookie = '';
    let pgCsrf = '';
    let pgOrgUser: any;

    beforeAll(async () => {
      const suffix = nanoid(8);
      pgOrgUser = await prisma.user.create({
        data: {
          email: `scanner_pg_${suffix}@outside.vip`,
          name: `Scanner PG Org ${suffix}`,
          role: Role.ORGANIZER,
          emailVerified: true,
        },
      });
      pgUserIds.push(pgOrgUser.id);

      const session = await createSession({
        userId: pgOrgUser.id,
        ipAddress: '127.0.0.1',
        userAgent: 'ScannerPGVitest',
      });
      pgSessionCookie = `__Host-outside_sid=${session.rawCookieValue}`;
      pgCsrf = session.csrfToken;
    });

    afterAll(async () => {
      if (pgOrderIds.length > 0) {
        await prisma.checkInLog.deleteMany({
          where: { ticket: { orderId: { in: pgOrderIds } } },
        });
        await prisma.ticket.deleteMany({
          where: { orderId: { in: pgOrderIds } },
        });
        await prisma.orderItem.deleteMany({
          where: { orderId: { in: pgOrderIds } },
        });
        await prisma.order.deleteMany({
          where: { id: { in: pgOrderIds } },
        });
      }
      if (pgEventIds.length > 0) {
        await prisma.ticketTier.deleteMany({
          where: { eventId: { in: pgEventIds } },
        });
        await prisma.event.deleteMany({
          where: { id: { in: pgEventIds } },
        });
      }
      if (pgUserIds.length > 0) {
        await prisma.user.deleteMany({
          where: { id: { in: pgUserIds } },
        });
      }
    });

    it('serializes 20 concurrent requests via PostgreSQL FOR UPDATE (admits exactly 1) and denies REFUND_PENDING, REFUNDED, and CANCELLED events in real PostgreSQL', async () => {
      const suffix = nanoid(8);
      const evt = await prisma.event.create({
        data: {
          slug: `scanner-pg-evt-${suffix}`.toLowerCase(),
          organizerId: pgOrgUser.id,
          title: `Scanner PG Event ${suffix}`,
          description: 'Real PG concurrency check-in event',
          category: EventCategory.MUSIC,
          status: EventStatus.PUBLISHED,
          coverImageUrl: 'https://example.com/scanner-pg.jpg',
          venueName: 'PG Arena',
          venueAddress: '100 DB Way',
          city: 'Nairobi',
          country: 'US',
          startAt: new Date(Date.now() - 3_600_000),
          endAt: new Date(Date.now() + 7_200_000),
          timezone: 'UTC',
        },
      });
      pgEventIds.push(evt.id);

      const tier = await prisma.ticketTier.create({
        data: {
          eventId: evt.id,
          name: 'GA PG',
          priceInCents: 2000,
          currency: 'USD',
          totalCapacity: 50,
          soldQuantity: 3,
        },
      });

      const order = await prisma.order.create({
        data: {
          orderNumber: `OUT-SCANPG-${suffix}`,
          eventId: evt.id,
          status: OrderStatus.COMPLETED,
          customerEmail: `scanpg_${suffix}@example.com`,
          customerName: 'Scanner PG Buyer',
          totalInCents: 2379,
          currency: 'USD',
          platformFeeInCents: 295,
          organizerNetInCents: 2000,
          idempotencyKey: `idem_scanpg_${suffix}`,
          paymentProvider: PaymentProvider.STRIPE,
          paymentReference: `pi_scanpg_${suffix}`,
          expiresAt: new Date(Date.now() + 3_600_000),
          items: {
            create: {
              ticketTierId: tier.id,
              quantity: 3,
              unitPriceInCents: 2000,
              subtotalInCents: 6000,
            },
          },
        },
      });
      pgOrderIds.push(order.id);

      const [tRace, tPendingRefund, tRefunded] = await Promise.all([
        prisma.ticket.create({
          data: {
            ticketToken: `tkt_sec_race_${suffix}`,
            orderId: order.id,
            eventId: evt.id,
            ticketTierId: tier.id,
            attendeeName: 'Race Attendee',
            attendeeEmail: 'race@example.com',
            status: TicketStatus.ISSUED,
          },
        }),
        prisma.ticket.create({
          data: {
            ticketToken: `tkt_sec_rpend_${suffix}`,
            orderId: order.id,
            eventId: evt.id,
            ticketTierId: tier.id,
            attendeeName: 'Pending Refund Attendee',
            attendeeEmail: 'rpend@example.com',
            status: TicketStatus.REFUND_PENDING,
          },
        }),
        prisma.ticket.create({
          data: {
            ticketToken: `tkt_sec_rref_${suffix}`,
            orderId: order.id,
            eventId: evt.id,
            ticketTierId: tier.id,
            attendeeName: 'Refunded Attendee',
            attendeeEmail: 'rref@example.com',
            status: TicketStatus.REFUNDED,
          },
        }),
      ]);

      // 1. 20 real concurrent check-ins against PostgreSQL FOR UPDATE row lock
      const raceResponses = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          request(app)
            .post('/api/organizer/check-in')
            .set('Cookie', pgSessionCookie)
            .set('x-csrf-token', pgCsrf)
            .set('Idempotency-Key', `pg_race_${suffix}_${i}`)
            .send({ token: tRace.ticketToken, eventId: evt.id })
        )
      );

      const wins = raceResponses.filter((r) => r.status === 200);
      const dupes = raceResponses.filter((r) => r.status === 409);
      expect(wins).toHaveLength(1);
      expect(wins[0].body.data.result).toBe('SUCCESS');
      expect(dupes).toHaveLength(19);
      for (const d of dupes) {
        expect(d.body.error.code).toBe('ALREADY_CHECKED_IN');
      }

      // 2. Denies REFUND_PENDING and REFUNDED tickets with explicit distinct CheckInResult codes
      const pendingRes = await request(app)
        .post('/api/organizer/check-in')
        .set('Cookie', pgSessionCookie)
        .set('x-csrf-token', pgCsrf)
        .send({ token: tPendingRefund.ticketToken, eventId: evt.id });
      expect(pendingRes.status).toBe(400);
      expect(pendingRes.body.error.code).toBe('REFUND_PENDING_TICKET');
      expect(pendingRes.body.data.result).toBe('REFUND_PENDING_TICKET');

      const refundedRes = await request(app)
        .post('/api/organizer/check-in')
        .set('Cookie', pgSessionCookie)
        .set('x-csrf-token', pgCsrf)
        .send({ token: tRefunded.ticketToken, eventId: evt.id });
      expect(refundedRes.status).toBe(400);
      expect(refundedRes.body.error.code).toBe('REFUNDED_TICKET');
      expect(refundedRes.body.data.result).toBe('REFUNDED_TICKET');

      // 3. Denies CANCELLED event ticket with EVENT_CANCELLED in real PG
      const tCancelledEvt = await prisma.ticket.create({
        data: {
          ticketToken: `tkt_sec_cevt_${suffix}`,
          orderId: order.id,
          eventId: evt.id,
          ticketTierId: tier.id,
          attendeeName: 'Cancelled Event Attendee',
          attendeeEmail: 'cevt@example.com',
          status: TicketStatus.ISSUED,
        },
      });
      await prisma.event.update({
        where: { id: evt.id },
        data: { status: EventStatus.CANCELLED, cancelledAt: new Date(), cancelledByUserId: pgOrgUser.id },
      });

      const cancelledEvtRes = await request(app)
        .post('/api/organizer/check-in')
        .set('Cookie', pgSessionCookie)
        .set('x-csrf-token', pgCsrf)
        .send({ token: tCancelledEvt.ticketToken, eventId: evt.id });
      expect(cancelledEvtRes.status).toBe(400);
      expect(cancelledEvtRes.body.error.code).toBe('EVENT_CANCELLED');
      expect(cancelledEvtRes.body.data.result).toBe('EVENT_CANCELLED');
    });
  });

  describe('Event Selection & Gate Mismatch', () => {
    it('returns 400 WRONG_EVENT with complete diagnostic data when Savannah ticket is scanned at Sol Fest gate', async () => {
      vi.spyOn(prisma.ticket, 'findUnique').mockResolvedValue(mockTicketSavannah as any);
      const logSpy = vi.spyOn(prisma.checkInLog, 'create').mockResolvedValue({} as any);

      const res = await request(app)
        .post('/api/organizer/check-in')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          token: 'tkt_sec_9kTftYU2E7CA5k2CIdOZxd56',
          eventId: 'sol-fest-baobab-edition-2026',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe('WRONG_EVENT');
      expect(res.body.error.message).toContain('Ticket belongs to "SAVANNAH CINEMA: African Classic Film & Vinyl"');
      expect(res.body.data.result).toBe('WRONG_EVENT');
      expect(res.body.data.ticket.eventTitle).toBe('SAVANNAH CINEMA: African Classic Film & Vinyl');
      expect(res.body.data.ticket.eventSlug).toBe('savannah-cinema-vinyl-under-stars');
      expect(res.body.data.ticket.attendeeName).toBe('Kipchoge Keino');
      expect(res.body.data.ticket.tierName).toBe('Sunset Lawn Pass');

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            ticketId: mockTicketSavannah.id,
            result: 'WRONG_EVENT',
          }),
        })
      );
    });

    it('returns 400 WRONG_EVENT when Sol Fest ticket is scanned at Sub-Terrain gate', async () => {
      vi.spyOn(prisma.ticket, 'findUnique').mockResolvedValue(mockTicketSolFest as any);
      vi.spyOn(prisma.checkInLog, 'create').mockResolvedValue({} as any);

      const res = await request(app)
        .post('/api/organizer/check-in')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          token: 'tkt_sec_5WaHB1t7AVsxXFVsWeB7MikM',
          eventId: 'sub-terrain-industrial-warehouse-004',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('WRONG_EVENT');
      expect(res.body.error.message).toContain('Ticket belongs to "SOL FEST: Under The Baobab Tree"');
      expect(res.body.data.ticket.eventTitle).toBe('SOL FEST: Under The Baobab Tree');
    });

    it('successfully admits ticket when scanned at the correct matching gate slug', async () => {
      vi.spyOn(prisma.ticket, 'findUnique').mockResolvedValue(mockTicketSavannah as any);
      mockTransactionalAdmission(mockTicketSavannah);

      const res = await request(app)
        .post('/api/organizer/check-in')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          token: 'tkt_sec_9kTftYU2E7CA5k2CIdOZxd56',
          eventId: 'savannah-cinema-vinyl-under-stars',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.result).toBe('SUCCESS');
      expect(res.body.data.ticket.attendeeName).toBe('Kipchoge Keino');
      expect(res.body.data.ticket.tierName).toBe('Sunset Lawn Pass');
      expect(res.body.data.ticket.eventTitle).toBe('SAVANNAH CINEMA: African Classic Film & Vinyl');
    });

    it('successfully admits ticket when gate is empty or "all" (auto-detect gate)', async () => {
      vi.spyOn(prisma.ticket, 'findUnique').mockResolvedValue(mockTicketSolFest as any);
      mockTransactionalAdmission(mockTicketSolFest);

      const res = await request(app)
        .post('/api/organizer/check-in')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          token: 'tkt_sec_5WaHB1t7AVsxXFVsWeB7MikM',
          eventId: '',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.result).toBe('SUCCESS');
      expect(res.body.data.ticket.attendeeName).toBe('Wangari Maathai');
    });
  });

  describe('Token Matching & Fallback Resolution', () => {
    it('finds ticket when entered without tkt_sec_ prefix', async () => {
      vi.spyOn(prisma.ticket, 'findUnique')
        .mockResolvedValueOnce(null) // first try: raw token
        .mockResolvedValueOnce(mockTicketSavannah as any); // second try: prefixed
      mockTransactionalAdmission(mockTicketSavannah);

      const res = await request(app)
        .post('/api/organizer/check-in')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          token: '9kTftYU2E7CA5k2CIdOZxd56',
          eventId: 'savannah-cinema-vinyl-under-stars',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.result).toBe('SUCCESS');
    });

    it('finds ticket via case-insensitive fallback when entered with uppercase mistake', async () => {
      vi.spyOn(prisma.ticket, 'findUnique').mockResolvedValue(null);
      vi.spyOn(prisma.ticket, 'findFirst').mockResolvedValue(mockTicketSolFest as any);
      mockTransactionalAdmission(mockTicketSolFest);

      const res = await request(app)
        .post('/api/organizer/check-in')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          token: 'TKT_SEC_5WAHB1T7AVSXXFVSWEB7MIKM',
          eventId: 'sol-fest-baobab-edition-2026',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.result).toBe('SUCCESS');
    });

    it('returns 404 INVALID_TOKEN with structured error when credential does not exist', async () => {
      vi.spyOn(prisma.ticket, 'findUnique').mockResolvedValue(null);
      vi.spyOn(prisma.ticket, 'findFirst').mockResolvedValue(null);
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValue(null);
      vi.spyOn(prisma.checkInLog, 'create').mockResolvedValue({} as any);

      const res = await request(app)
        .post('/api/organizer/check-in')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          token: 'tkt_sec_nonexistent_credential_xyz',
          eventId: 'sol-fest-baobab-edition-2026',
        });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_TOKEN');
      expect(res.body.data.result).toBe('INVALID_TOKEN');
    });
  });

  describe('Eligibility, Status & Duplicate Protection', () => {
    it('returns 409 ALREADY_CHECKED_IN when ticket was previously checked in', async () => {
      const alreadyCheckedTicket = {
        ...mockTicketSavannah,
        status: 'CHECKED_IN',
        checkedInAt: new Date('2026-10-20T17:00:00Z'),
        checkedInByUser: { name: 'Gate Staff 1', email: 'gate1@outside.vip' },
      };

      vi.spyOn(prisma.ticket, 'findUnique').mockResolvedValue(alreadyCheckedTicket as any);
      vi.spyOn(prisma.checkInLog, 'create').mockResolvedValue({} as any);

      const res = await request(app)
        .post('/api/organizer/check-in')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          token: 'tkt_sec_9kTftYU2E7CA5k2CIdOZxd56',
          eventId: 'savannah-cinema-vinyl-under-stars',
        });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ALREADY_CHECKED_IN');
      expect(res.body.data.result).toBe('ALREADY_CHECKED_IN');
      expect(res.body.data.ticket.attendeeName).toBe('Kipchoge Keino');
    });

    it('returns 400 CANCELLED_TICKET when ticket has been cancelled', async () => {
      const cancelledTicket = {
        ...mockTicketSavannah,
        status: 'CANCELLED',
      };

      vi.spyOn(prisma.ticket, 'findUnique').mockResolvedValue(cancelledTicket as any);
      vi.spyOn(prisma.checkInLog, 'create').mockResolvedValue({} as any);

      const res = await request(app)
        .post('/api/organizer/check-in')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          token: 'tkt_sec_9kTftYU2E7CA5k2CIdOZxd56',
          eventId: 'savannah-cinema-vinyl-under-stars',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('CANCELLED_TICKET');
    });

    it('returns 400 CANCELLED_TICKET when parent order has been refunded', async () => {
      const refundedOrderTicket = {
        ...mockTicketSavannah,
        order: {
          ...mockTicketSavannah.order,
          status: 'REFUNDED',
        },
      };

      vi.spyOn(prisma.ticket, 'findUnique').mockResolvedValue(refundedOrderTicket as any);
      vi.spyOn(prisma.checkInLog, 'create').mockResolvedValue({} as any);

      const res = await request(app)
        .post('/api/organizer/check-in')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          token: 'tkt_sec_9kTftYU2E7CA5k2CIdOZxd56',
          eventId: 'savannah-cinema-vinyl-under-stars',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('CANCELLED_TICKET');
      expect(res.body.error.message).toContain('cancelled or refunded');
    });

    it('returns 400 UNPAID_ORDER when ticket order is not completed', async () => {
      const unpaidTicket = {
        ...mockTicketSavannah,
        order: {
          ...mockTicketSavannah.order,
          status: 'PENDING',
        },
      };

      vi.spyOn(prisma.ticket, 'findUnique').mockResolvedValue(unpaidTicket as any);

      const res = await request(app)
        .post('/api/organizer/check-in')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          token: 'tkt_sec_9kTftYU2E7CA5k2CIdOZxd56',
          eventId: 'savannah-cinema-vinyl-under-stars',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('UNPAID_ORDER');
    });

    it('returns 403 Forbidden when organizer attempts to check in ticket for an event they do not own', async () => {
      const foreignEventTicket = {
        ...mockTicketSavannah,
        event: {
          ...mockEventSavannah,
          organizerId: otherOrganizerId,
        },
      };

      vi.spyOn(prisma.ticket, 'findUnique').mockResolvedValue(foreignEventTicket as any);

      const res = await request(app)
        .post('/api/organizer/check-in')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          token: 'tkt_sec_9kTftYU2E7CA5k2CIdOZxd56',
          eventId: 'savannah-cinema-vinyl-under-stars',
        });

      expect(res.status).toBe(403);
      expect(res.body.error.statusCode).toBe(403);
    });
  });

  describe('Foreign Event Audit-Log Pollution Protection', () => {
    it('does NOT write CheckInLog when scanning a nonexistent token against an event the organizer does not own', async () => {
      vi.spyOn(prisma.ticket, 'findUnique').mockResolvedValue(null);
      vi.spyOn(prisma.ticket, 'findFirst').mockResolvedValue(null);
      const eventFindFirstSpy = vi.spyOn(prisma.event, 'findFirst').mockResolvedValue(null);
      const logSpy = vi.spyOn(prisma.checkInLog, 'create');

      const res = await request(app)
        .post('/api/organizer/check-in')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          token: 'tkt_sec_nonexistent_xyz123',
          eventId: 'foreign-organizer-event-slug',
        });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_TOKEN');
      expect(res.body.data.result).toBe('INVALID_TOKEN');
      expect(logSpy).not.toHaveBeenCalled();
      expect(eventFindFirstSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.arrayContaining([
              { organizerId: organizerId },
            ]),
          }),
        })
      );
    });

    it('DOES write INVALID_TOKEN to CheckInLog when scanning a nonexistent token against an event the organizer DOES own', async () => {
      vi.spyOn(prisma.ticket, 'findUnique').mockResolvedValue(null);
      vi.spyOn(prisma.ticket, 'findFirst').mockResolvedValue(null);
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValue({ id: mockEventSavannah.id } as any);
      const logSpy = vi.spyOn(prisma.checkInLog, 'create').mockResolvedValue({} as any);

      const res = await request(app)
        .post('/api/organizer/check-in')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          token: 'tkt_sec_nonexistent_xyz123',
          eventId: mockEventSavannah.slug,
        });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_TOKEN');
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            eventId: mockEventSavannah.id,
            scannedToken: 'tkt_sec_nonexistent_xyz123',
            scannedByUserId: organizerId,
            result: 'INVALID_TOKEN',
          }),
        })
      );
    });

    it('does NOT leak foreign event existence information when token is invalid', async () => {
      vi.spyOn(prisma.ticket, 'findUnique').mockResolvedValue(null);
      vi.spyOn(prisma.ticket, 'findFirst').mockResolvedValue(null);
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValue(null);

      const res = await request(app)
        .post('/api/organizer/check-in')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          token: 'tkt_sec_unknown_credential',
          eventId: 'nonexistent-or-foreign-event',
        });

      expect(res.status).toBe(404);
      expect(res.body.error.message).toBe('Invalid ticket token. No ticket found with this credential.');
    });

    it('allows Admin to log INVALID_TOKEN against any event gate', async () => {
      vi.spyOn(prisma.ticket, 'findUnique').mockResolvedValue(null);
      vi.spyOn(prisma.ticket, 'findFirst').mockResolvedValue(null);
      const eventFindFirstSpy = vi.spyOn(prisma.event, 'findFirst').mockResolvedValue({ id: 'evt-any-999' } as any);
      const logSpy = vi.spyOn(prisma.checkInLog, 'create').mockResolvedValue({} as any);

      const res = await request(app)
        .post('/api/organizer/check-in')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          token: 'tkt_sec_nonexistent_xyz123',
          eventId: 'evt-any-999',
        });

      expect(res.status).toBe(404);
      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            eventId: 'evt-any-999',
            result: 'INVALID_TOKEN',
            scannedByUserId: 'admin-uuid-000',
          }),
        })
      );
      expect(eventFindFirstSpy).toHaveBeenCalledWith({
        where: {
          AND: [
            { OR: [{ id: 'evt-any-999' }, { slug: 'evt-any-999' }] },
          ],
        },
        select: { id: true },
      });
    });
  });

  describe('Authorization & Scanner Role Preservation', () => {
    it('returns 401 Unauthorized when request lacks authentication session or token', async () => {
      const res = await request(app)
        .post('/api/organizer/check-in')
        .send({
          token: 'tkt_sec_9kTftYU2E7CA5k2CIdOZxd56',
          eventId: mockEventSavannah.id,
        });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('returns 403 Forbidden when an ATTENDEE attempts to check in tickets', async () => {
      vi.spyOn(prisma.eventStaff, 'findFirst').mockResolvedValueOnce(null);
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValueOnce(null);
      const res = await request(app)
        .post('/api/organizer/check-in')
        .set('Authorization', `Bearer ${attendeeToken}`)
        .send({
          token: 'tkt_sec_9kTftYU2E7CA5k2CIdOZxd56',
          eventId: mockEventSavannah.id,
        });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain('You do not have permission to check in attendees');
    });

    it('allows Admin to check in tickets for any event', async () => {
      const foreignEventTicket = {
        ...mockTicketSavannah,
        event: {
          ...mockEventSavannah,
          organizerId: otherOrganizerId,
        },
      };

      vi.spyOn(prisma.ticket, 'findUnique').mockResolvedValue(foreignEventTicket as any);
      mockTransactionalAdmission(foreignEventTicket);

      const res = await request(app)
        .post('/api/organizer/check-in')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          token: 'tkt_sec_9kTftYU2E7CA5k2CIdOZxd56',
          eventId: mockEventSavannah.id,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.result).toBe('SUCCESS');
    });
  });

  describe('Safe Check-In Retry Idempotency & Concurrency', () => {
    it('returns cached 200 response and avoids duplicate DB mutation when identical idempotency key is submitted', async () => {
      const idemKey = `idem_${Date.now()}_test_cached`;

      vi.spyOn(prisma.ticket, 'findUnique')
        .mockResolvedValueOnce(mockTicketSavannah as any)
        .mockResolvedValueOnce({ ...mockTicketSavannah, status: 'CHECKED_IN' } as any);
      const { ticketUpdateSpy: updateSpy, checkInLogCreateSpy: logSpy } =
        mockTransactionalAdmission(mockTicketSavannah);

      const res1 = await request(app)
        .post('/api/organizer/check-in')
        .set('Authorization', `Bearer ${organizerToken}`)
        .set('Idempotency-Key', idemKey)
        .send({
          token: 'tkt_sec_9kTftYU2E7CA5k2CIdOZxd56',
          eventId: mockEventSavannah.id,
        });

      expect(res1.status).toBe(200);
      expect(res1.body.success).toBe(true);
      expect(res1.body.data.result).toBe('SUCCESS');
      expect(updateSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledTimes(1);

      const res2 = await request(app)
        .post('/api/organizer/check-in')
        .set('Authorization', `Bearer ${organizerToken}`)
        .set('Idempotency-Key', idemKey)
        .send({
          token: 'tkt_sec_9kTftYU2E7CA5k2CIdOZxd56',
          eventId: mockEventSavannah.id,
        });

      expect(res2.status).toBe(200);
      expect(res2.body.success).toBe(true);
      expect(res2.body.data.result).toBe('SUCCESS');
      expect(res2.body.data.ticket.attendeeName).toBe(res1.body.data.ticket.attendeeName);
      expect(updateSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledTimes(1);
    });

    it('returns 400 IDEMPOTENCY_KEY_MISMATCH when same idempotency key is reused with a different ticket token', async () => {
      const idemKey = `idem_${Date.now()}_test_mismatch`;

      vi.spyOn(prisma.ticket, 'findUnique').mockResolvedValue(mockTicketSavannah as any);
      mockTransactionalAdmission(mockTicketSavannah);

      const res1 = await request(app)
        .post('/api/organizer/check-in')
        .set('Authorization', `Bearer ${organizerToken}`)
        .set('Idempotency-Key', idemKey)
        .send({
          token: 'tkt_sec_9kTftYU2E7CA5k2CIdOZxd56',
          eventId: mockEventSavannah.id,
        });
      expect(res1.status).toBe(200);

      const res2 = await request(app)
        .post('/api/organizer/check-in')
        .set('Authorization', `Bearer ${organizerToken}`)
        .set('Idempotency-Key', idemKey)
        .send({
          token: 'tkt_sec_different_token_abc',
          eventId: mockEventSavannah.id,
        });

      expect(res2.status).toBe(400);
      expect(res2.body.error.code).toBe('IDEMPOTENCY_KEY_MISMATCH');
      expect(res2.body.error.message).toContain('Idempotency key was previously used with a different ticket');
    });

    it('returns 409 ALREADY_CHECKED_IN when different idempotency key is used on an already checked-in ticket', async () => {
      const alreadyCheckedTicket = {
        ...mockTicketSavannah,
        status: 'CHECKED_IN',
        checkedInAt: new Date('2026-10-20T17:00:00Z'),
        checkedInByUser: { name: 'Gate Staff 1', email: 'gate1@outside.vip' },
      };

      vi.spyOn(prisma.ticket, 'findUnique').mockResolvedValue(alreadyCheckedTicket as any);
      vi.spyOn(prisma.checkInLog, 'create').mockResolvedValue({} as any);

      const res = await request(app)
        .post('/api/organizer/check-in')
        .set('Authorization', `Bearer ${organizerToken}`)
        .set('Idempotency-Key', `idem_fresh_${Date.now()}`)
        .send({
          token: 'tkt_sec_9kTftYU2E7CA5k2CIdOZxd56',
          eventId: mockEventSavannah.id,
        });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ALREADY_CHECKED_IN');
      expect(res.body.data.result).toBe('ALREADY_CHECKED_IN');
    });

    it('concurrency: 20 simultaneous requests for the same ticket admit exactly 1 attendee', async () => {
      vi.spyOn(prisma.ticket, 'findUnique').mockResolvedValue(mockTicketSavannah as any);
      mockTransactionalAdmission(mockTicketSavannah, { concurrentSingleAdmit: true });

      const requests = Array.from({ length: 20 }, (_, i) =>
        request(app)
          .post('/api/organizer/check-in')
          .set('Authorization', `Bearer ${organizerToken}`)
          .set('Idempotency-Key', `concurrent_${Date.now()}_${i}`)
          .send({
            token: 'tkt_sec_9kTftYU2E7CA5k2CIdOZxd56',
            eventId: mockEventSavannah.id,
          })
      );

      const results = await Promise.all(requests);

      const successes = results.filter((r) => r.status === 200);
      const rejections = results.filter((r) => r.status === 409 || r.status === 400);

      expect(successes.length).toBe(1);
      expect(successes[0].body.data.result).toBe('SUCCESS');
      expect(rejections.length).toBe(19);
      for (const rej of rejections) {
        expect(rej.body.error.code).toBe('ALREADY_CHECKED_IN');
      }
    });

    it('returns 400 IDEMPOTENCY_KEY_CONFLICT when Idempotency-Key header and body.idempotencyKey mismatch', async () => {
      const res = await request(app)
        .post('/api/organizer/check-in')
        .set('Authorization', `Bearer ${organizerToken}`)
        .set('Idempotency-Key', 'idem_header_key_1111')
        .send({
          token: 'tkt_sec_9kTftYU2E7CA5k2CIdOZxd56',
          eventId: mockEventSavannah.id,
          idempotencyKey: 'idem_body_key_2222',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
      expect(res.body.error.message).toContain('Conflicting idempotency keys provided');
    });

    it('returns 400 IDEMPOTENCY_KEY_CONFLICT when Idempotency-Key and X-Idempotency-Key headers mismatch', async () => {
      const res = await request(app)
        .post('/api/organizer/check-in')
        .set('Authorization', `Bearer ${organizerToken}`)
        .set('Idempotency-Key', 'idem_key_standard_1111')
        .set('X-Idempotency-Key', 'idem_key_alternate_2222')
        .send({
          token: 'tkt_sec_9kTftYU2E7CA5k2CIdOZxd56',
          eventId: mockEventSavannah.id,
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    });

    it('returns 400 INVALID_IDEMPOTENCY_KEY for empty, whitespace-only, too short, or invalid-character keys', async () => {
      // Empty string key in header
      const resEmpty = await request(app)
        .post('/api/organizer/check-in')
        .set('Authorization', `Bearer ${organizerToken}`)
        .set('Idempotency-Key', '   ')
        .send({
          token: 'tkt_sec_9kTftYU2E7CA5k2CIdOZxd56',
          eventId: mockEventSavannah.id,
        });
      expect(resEmpty.status).toBe(400);
      expect(resEmpty.body.error.code).toBe('INVALID_IDEMPOTENCY_KEY');

      // Too short key (< 8 characters)
      const resShort = await request(app)
        .post('/api/organizer/check-in')
        .set('Authorization', `Bearer ${organizerToken}`)
        .set('Idempotency-Key', 'tiny')
        .send({
          token: 'tkt_sec_9kTftYU2E7CA5k2CIdOZxd56',
          eventId: mockEventSavannah.id,
        });
      expect(resShort.status).toBe(400);
      expect(resShort.body.error.code).toBe('INVALID_IDEMPOTENCY_KEY');
      expect(resShort.body.error.message).toContain('between 8 and 128 characters');

      // Invalid characters (e.g. spaces, dollar signs, slashes)
      const resInvalidChar = await request(app)
        .post('/api/organizer/check-in')
        .set('Authorization', `Bearer ${organizerToken}`)
        .set('Idempotency-Key', 'key with invalid spaces and $ymbols!')
        .send({
          token: 'tkt_sec_9kTftYU2E7CA5k2CIdOZxd56',
          eventId: mockEventSavannah.id,
        });
      expect(resInvalidChar.status).toBe(400);
      expect(resInvalidChar.body.error.code).toBe('INVALID_IDEMPOTENCY_KEY');
      expect(resInvalidChar.body.error.message).toContain('invalid characters');
    });

    it('returns 400 IDEMPOTENCY_KEY_MISMATCH when same key was used without gate but retried with specific gate', async () => {
      const idemKey = `idem_gate_mismatch_${Date.now()}`;

      vi.spyOn(prisma.ticket, 'findUnique').mockResolvedValue(mockTicketSavannah as any);
      mockTransactionalAdmission(mockTicketSavannah);

      // Attempt 1: Auto-detect / all gates (empty eventId)
      const res1 = await request(app)
        .post('/api/organizer/check-in')
        .set('Authorization', `Bearer ${organizerToken}`)
        .set('Idempotency-Key', idemKey)
        .send({
          token: 'tkt_sec_9kTftYU2E7CA5k2CIdOZxd56',
          eventId: '',
        });
      expect(res1.status).toBe(200);

      // Attempt 2: Reusing the same key with a specific gate
      const res2 = await request(app)
        .post('/api/organizer/check-in')
        .set('Authorization', `Bearer ${organizerToken}`)
        .set('Idempotency-Key', idemKey)
        .send({
          token: 'tkt_sec_9kTftYU2E7CA5k2CIdOZxd56',
          eventId: mockEventSavannah.id,
        });

      expect(res2.status).toBe(400);
      expect(res2.body.error.code).toBe('IDEMPOTENCY_KEY_MISMATCH');
      expect(res2.body.error.message).toContain('Idempotency key was previously used with a different ticket or event');
    });

    it('returns cached 200 response when retry submits case-insensitive or prefix-insensitive token variant with same key', async () => {
      const idemKey = `idem_case_insens_${Date.now()}`;

      vi.spyOn(prisma.ticket, 'findUnique').mockResolvedValue(mockTicketSavannah as any);
      mockTransactionalAdmission(mockTicketSavannah);

      // First call with standard token
      const res1 = await request(app)
        .post('/api/organizer/check-in')
        .set('Authorization', `Bearer ${organizerToken}`)
        .set('Idempotency-Key', idemKey)
        .send({
          token: 'tkt_sec_9kTftYU2E7CA5k2CIdOZxd56',
          eventId: mockEventSavannah.id,
        });
      expect(res1.status).toBe(200);

      // Retry with UPPERCASE version of the same token
      const res2 = await request(app)
        .post('/api/organizer/check-in')
        .set('Authorization', `Bearer ${organizerToken}`)
        .set('Idempotency-Key', idemKey)
        .send({
          token: 'TKT_SEC_9KTFTYU2E7CA5K2CIDOZXD56',
          eventId: mockEventSavannah.id,
        });
      expect(res2.status).toBe(200);
      expect(res2.body.data.result).toBe('SUCCESS');
      expect(res2.body.data.ticket.attendeeName).toBe(mockTicketSavannah.attendeeName);

      // Retry without tkt_sec_ prefix
      const res3 = await request(app)
        .post('/api/organizer/check-in')
        .set('Authorization', `Bearer ${organizerToken}`)
        .set('Idempotency-Key', idemKey)
        .send({
          token: '9kTftYU2E7CA5k2CIdOZxd56',
          eventId: mockEventSavannah.id,
        });
      expect(res3.status).toBe(200);
      expect(res3.body.data.result).toBe('SUCCESS');
    });

    it('recovers committed check-in from PostgreSQL CheckInLog when Redis lease was lost and returns 200 SUCCESS', async () => {
      const idemKey = `idem_lost_lease_${Date.now()}`;
      const checkedInTime = new Date('2026-11-16T12:00:00Z');

      const committedTicket = {
        ...mockTicketSavannah,
        status: 'CHECKED_IN',
        checkedInAt: checkedInTime,
        checkedInByUserId: organizerId,
      };

      vi.spyOn(prisma.ticket, 'findUnique').mockResolvedValue(committedTicket as any);
      vi.spyOn(prisma.ticket, 'count').mockResolvedValue(1);

      // Mock CheckInLog.findFirst finding the committed success log with note containing idempotencyKey
      vi.spyOn(prisma.checkInLog, 'findFirst').mockResolvedValue({
        id: 'log-committed-1',
        ticketId: committedTicket.id,
        scannedByUserId: organizerId,
        result: 'SUCCESS',
        notes: `idem:${idemKey}`,
        createdAt: checkedInTime,
      } as any);

      // Mock updateMany to assert it is never called on recovery
      const updateSpy = vi.spyOn(prisma.ticket, 'updateMany');

      const res = await request(app)
        .post('/api/organizer/check-in')
        .set('Authorization', `Bearer ${organizerToken}`)
        .set('Idempotency-Key', idemKey)
        .send({
          token: 'tkt_sec_9kTftYU2E7CA5k2CIdOZxd56',
          eventId: mockEventSavannah.id,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.result).toBe('SUCCESS');
      expect(res.body.data.ticket.attendeeName).toBe(committedTicket.attendeeName);
      expect(updateSpy).not.toHaveBeenCalled();

      // Verify that Redis is now populated with the completed response
      const redis = getRedisClient();
      const cached = await redis.get(`checkin_idem:${organizerId}:${idemKey}`);
      expect(cached).not.toBeNull();
      const parsed = JSON.parse(cached!);
      expect(parsed.status).toBe('COMPLETED');
      expect(parsed.responseStatus).toBe(200);
      expect(parsed.responseBody.data.result).toBe('SUCCESS');
    });
  });

  describe('Redis Store Adapter Idempotency Fencing & Lock Scripting', () => {
    it('delLockIfMatches deletes key only when lockId matches, no-op if stale lockId', async () => {
      const redis = getRedisClient();
      const testKey = `test_fencing_del_${Date.now()}`;
      const validLockId = 'owner-lock-uuid-111';
      const staleLockId = 'stale-lock-uuid-999';

      await redis.setNxPx(testKey, JSON.stringify({ lockId: validLockId, status: 'PENDING' }), 5000);

      // Stale lock deletion attempt must fail and preserve key
      const staleResult = await redis.delLockIfMatches(testKey, staleLockId);
      expect(staleResult).toBe(false);
      const afterStale = await redis.get(testKey);
      expect(afterStale).not.toBeNull();

      // Matching lock deletion attempt must succeed and delete key
      const matchResult = await redis.delLockIfMatches(testKey, validLockId);
      expect(matchResult).toBe(true);
      const afterMatch = await redis.get(testKey);
      expect(afterMatch).toBeNull();
    });

    it('completeIdempotencyLock overwrites pending lock only when lockId matches, fails if stale lockId', async () => {
      const redis = getRedisClient();
      const testKey = `test_fencing_complete_${Date.now()}`;
      const validLockId = 'owner-lock-uuid-222';
      const staleLockId = 'stale-lock-uuid-888';

      await redis.setNxPx(testKey, JSON.stringify({ lockId: validLockId, status: 'PENDING' }), 5000);

      const completedJson = JSON.stringify({ status: 'COMPLETED', responseStatus: 200 });

      // Stale lock completion attempt must fail
      const staleResult = await redis.completeIdempotencyLock(testKey, staleLockId, completedJson, 10000);
      expect(staleResult).toBe(false);
      const afterStale = await redis.get(testKey);
      expect(JSON.parse(afterStale!).status).toBe('PENDING');

      // Valid lock completion attempt must succeed and set status to COMPLETED
      const matchResult = await redis.completeIdempotencyLock(testKey, validLockId, completedJson, 10000);
      expect(matchResult).toBe(true);
      const afterMatch = await redis.get(testKey);
      expect(JSON.parse(afterMatch!).status).toBe('COMPLETED');
    });

    it('extendLockIfMatches extends TTL only when lockId matches, fails if stale lockId', async () => {
      const redis = getRedisClient();
      const testKey = `test_fencing_extend_${Date.now()}`;
      const validLockId = 'owner-lock-uuid-333';
      const staleLockId = 'stale-lock-uuid-777';

      await redis.setNxPx(testKey, JSON.stringify({ lockId: validLockId, status: 'PENDING' }), 5000);

      const staleExtend = await redis.extendLockIfMatches(testKey, staleLockId, 10000);
      expect(staleExtend).toBe(false);

      const validExtend = await redis.extendLockIfMatches(testKey, validLockId, 10000);
      expect(validExtend).toBe(true);
    });
  });
});
