import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Role, AccountStatus, EventStaffStatus, OrderStatus, TicketStatus, EventStatus } from '@prisma/client';
import { app } from '../app.js';
import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';
import { createSession, SESSION_COOKIE_NAME, SESSION_PREFIX } from '../lib/session.service.js';
import { getRedisClient } from '../lib/redis.js';

describe('Staff Scanner Authorization & Dedicated Scanner Router API', () => {
  const adminId = 'usr-admin-scanner-auth';
  const organizerId = 'usr-organizer-scanner-auth';
  const otherOrganizerId = 'usr-other-org-scanner-auth';
  const staffUserId = 'usr-staff-scanner-auth';
  const attendeeUserId = 'usr-attendee-scanner-auth';

  const eventAssignedId = 'evt-assigned-111';
  const eventUnassignedId = 'evt-unassigned-222';

  const signToken = (payload: { userId: string; role: Role; email?: string }) => {
    return jwt.sign(
      {
        userId: payload.userId,
        role: payload.role,
        email: payload.email || `${payload.userId}@outside.vip`,
        status: AccountStatus.ACTIVE,
        emailVerified: true,
      },
      env.JWT_SECRET,
      { expiresIn: '1h' }
    );
  };

  const adminToken = signToken({ userId: adminId, role: Role.ADMIN });
  const organizerToken = signToken({ userId: organizerId, role: Role.ORGANIZER });
  const staffToken = signToken({ userId: staffUserId, role: Role.ATTENDEE });
  const attendeeToken = signToken({ userId: attendeeUserId, role: Role.ATTENDEE });

  const mockAssignedEvent = {
    id: eventAssignedId,
    title: 'SOL FEST: Baobab Live 2026',
    slug: 'sol-fest-baobab-live-2026',
    organizerId,
    status: EventStatus.PUBLISHED,
    startAt: new Date(Date.now() + 86400000),
    endAt: new Date(Date.now() + 172800000),
    venueName: 'Carnivore Grounds',
    city: 'Nairobi',
    country: 'Kenya',
  };

  const mockUnassignedEvent = {
    id: eventUnassignedId,
    title: 'SAVANNAH CINEMA: Vinyl Night',
    slug: 'savannah-cinema-vinyl-night',
    organizerId: otherOrganizerId,
    status: EventStatus.PUBLISHED,
    startAt: new Date(Date.now() + 86400000),
    endAt: new Date(Date.now() + 172800000),
    venueName: 'Karura Forest Amphitheatre',
    city: 'Nairobi',
    country: 'Kenya',
  };

  const mockAssignedTicket = {
    id: 'tkt-assigned-001',
    ticketToken: 'tkt_sec_solfest_valid_ticket_12345',
    eventId: mockAssignedEvent.id,
    ticketTierId: 'tier-assigned-1',
    orderId: 'ord-assigned-1',
    attendeeName: 'Amina Mohamed',
    attendeeEmail: 'amina@outside.vip',
    status: TicketStatus.ISSUED,
    checkedInAt: null,
    checkedInByUserId: null,
    event: mockAssignedEvent,
    ticketTier: {
      name: 'VIP All-Access',
      validityStartAt: null,
      validityEndAt: null,
    },
    order: {
      orderNumber: 'ORD-SOL-001',
      status: OrderStatus.COMPLETED,
      customerName: 'Amina Mohamed',
      customerEmail: 'amina@outside.vip',
    },
    checkedInByUser: null,
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('1. GET /api/scanner/gates', () => {
    it('returns 401 Unauthorized when request lacks authentication session or token', async () => {
      const res = await request(app).get('/api/scanner/gates');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('returns all published events for ADMIN with role ADMIN', async () => {
      vi.spyOn(prisma.event, 'findMany').mockResolvedValue([
        mockAssignedEvent as any,
        mockUnassignedEvent as any,
      ]);

      const res = await request(app)
        .get('/api/scanner/gates')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.events.length).toBe(2);
      expect(res.body.data.events[0].role).toBe('ADMIN');
      expect(res.body.data.events[1].role).toBe('ADMIN');
    });

    it('returns owned events and staff assigned events for ORGANIZER', async () => {
      vi.spyOn(prisma.event, 'findMany').mockResolvedValue([mockAssignedEvent as any]);
      vi.spyOn(prisma.eventStaff, 'findMany').mockResolvedValue([
        { event: mockUnassignedEvent } as any,
      ]);

      const res = await request(app)
        .get('/api/scanner/gates')
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.events.length).toBe(2);
      expect(res.body.data.events[0].id).toBe(mockAssignedEvent.id);
      expect(res.body.data.events[0].role).toBe('ORGANIZER');
      expect(res.body.data.events[1].id).toBe(mockUnassignedEvent.id);
      expect(res.body.data.events[1].role).toBe('STAFF');
    });

    it('returns only active assigned events for STAFF attendee', async () => {
      vi.spyOn(prisma.eventStaff, 'findMany').mockResolvedValue([
        { event: mockAssignedEvent } as any,
      ]);

      const res = await request(app)
        .get('/api/scanner/gates')
        .set('Authorization', `Bearer ${staffToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.events.length).toBe(1);
      expect(res.body.data.events[0].id).toBe(mockAssignedEvent.id);
      expect(res.body.data.events[0].role).toBe('STAFF');
    });

    it('returns empty list for attendee with no staff assignments', async () => {
      vi.spyOn(prisma.eventStaff, 'findMany').mockResolvedValue([]);

      const res = await request(app)
        .get('/api/scanner/gates')
        .set('Authorization', `Bearer ${attendeeToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.events).toEqual([]);
    });
  });

  describe('2. POST /api/scanner/check-in & Staff Gate Authorization', () => {
    it('successfully admits ticket scanned by active staff member and records scanner attribution', async () => {
      vi.spyOn(prisma.ticket, 'findUnique').mockResolvedValue(mockAssignedTicket as any);
      vi.spyOn(prisma.eventStaff, 'findFirst').mockResolvedValue({ id: 'staff-rel-1' } as any);
      vi.spyOn(prisma.eventStaff, 'findUnique').mockResolvedValue({
        status: EventStaffStatus.ACTIVE,
      } as any);

      const mockTx = {
        $queryRaw: vi.fn().mockResolvedValue([{ status: 'ACTIVE' }]),
        ticket: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        checkInLog: {
          create: vi.fn().mockResolvedValue({}),
        },
      };
      vi.spyOn(prisma, '$transaction').mockImplementation(async (cb: any) => cb(mockTx));
      vi.spyOn(prisma.ticket, 'count').mockResolvedValue(1);

      const res = await request(app)
        .post('/api/scanner/check-in')
        .set('Authorization', `Bearer ${staffToken}`)
        .send({
          token: mockAssignedTicket.ticketToken,
          eventId: mockAssignedEvent.slug,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.result).toBe('SUCCESS');
      expect(res.body.data.ticket.attendeeName).toBe('Amina Mohamed');

      // Verify row lock was executed in tx
      expect(mockTx.$queryRaw).toHaveBeenCalled();

      // Verify ticket update attributed to staff scanner
      expect(mockTx.ticket.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            checkedInByUserId: staffUserId,
            status: 'CHECKED_IN',
          }),
        })
      );

      // Verify audit log attributed to staff scanner
      expect(mockTx.checkInLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            scannedByUserId: staffUserId,
            result: 'SUCCESS',
          }),
        })
      );
    });

    it('rejects staff member attempting to scan ticket for an unassigned event with 403 Forbidden', async () => {
      vi.spyOn(prisma.eventStaff, 'findFirst').mockResolvedValue(null);
      vi.spyOn(prisma.ticket, 'findUnique').mockResolvedValue({
        ...mockAssignedTicket,
        eventId: mockUnassignedEvent.id,
        event: mockUnassignedEvent,
      } as any);
      vi.spyOn(prisma.eventStaff, 'findUnique').mockResolvedValue(null);

      const res = await request(app)
        .post('/api/scanner/check-in')
        .set('Authorization', `Bearer ${staffToken}`)
        .send({
          token: mockAssignedTicket.ticketToken,
          eventId: mockUnassignedEvent.slug,
        });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain('You do not have permission to check in attendees');
    });

    it('rejects check-in with 403 Forbidden when staff assignment has status REVOKED', async () => {
      vi.spyOn(prisma.eventStaff, 'findFirst').mockResolvedValue(null);
      vi.spyOn(prisma.ticket, 'findUnique').mockResolvedValue(mockAssignedTicket as any);
      vi.spyOn(prisma.eventStaff, 'findUnique').mockResolvedValue({
        status: EventStaffStatus.REVOKED,
      } as any);

      const res = await request(app)
        .post('/api/scanner/check-in')
        .set('Authorization', `Bearer ${staffToken}`)
        .send({
          token: mockAssignedTicket.ticketToken,
          eventId: mockAssignedEvent.slug,
        });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('prevents check-in if staff assignment was concurrently revoked during transaction (row-level lock)', async () => {
      vi.spyOn(prisma.eventStaff, 'findFirst').mockResolvedValue({ id: 'staff-rel-1' } as any);
      vi.spyOn(prisma.ticket, 'findUnique').mockResolvedValue(mockAssignedTicket as any);
      vi.spyOn(prisma.eventStaff, 'findUnique').mockResolvedValue({
        status: EventStaffStatus.ACTIVE,
      } as any);

      // Simulates concurrent revocation right as FOR SHARE query executes
      const mockTx = {
        $queryRaw: vi.fn().mockResolvedValue([{ status: 'REVOKED' }]),
        ticket: {
          updateMany: vi.fn(),
        },
        checkInLog: {
          create: vi.fn(),
        },
      };
      vi.spyOn(prisma, '$transaction').mockImplementation(async (cb: any) => cb(mockTx));

      const res = await request(app)
        .post('/api/scanner/check-in')
        .set('Authorization', `Bearer ${staffToken}`)
        .send({
          token: mockAssignedTicket.ticketToken,
          eventId: mockAssignedEvent.slug,
        });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain('revoked or is inactive');
      expect(mockTx.ticket.updateMany).not.toHaveBeenCalled();
    });

    it('allows active staff member to log INVALID_TOKEN to CheckInLog for assigned event gate', async () => {
      vi.spyOn(prisma.eventStaff, 'findFirst').mockResolvedValue({ id: 'staff-rel-1' } as any);
      vi.spyOn(prisma.ticket, 'findUnique').mockResolvedValue(null);
      vi.spyOn(prisma.ticket, 'findFirst').mockResolvedValue(null);
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValue(null);
      vi.spyOn(prisma.eventStaff, 'findFirst').mockResolvedValue({
        eventId: mockAssignedEvent.id,
      } as any);
      const logSpy = vi.spyOn(prisma.checkInLog, 'create').mockResolvedValue({} as any);

      const res = await request(app)
        .post('/api/scanner/check-in')
        .set('Authorization', `Bearer ${staffToken}`)
        .send({
          token: 'tkt_sec_nonexistent_token_99999',
          eventId: mockAssignedEvent.slug,
        });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('INVALID_TOKEN');
      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            eventId: mockAssignedEvent.id,
            scannedByUserId: staffUserId,
            result: 'INVALID_TOKEN',
          }),
        })
      );
    });

    it('does NOT write CheckInLog when active staff member scans nonexistent token against unassigned event gate', async () => {
      vi.spyOn(prisma.eventStaff, 'findFirst').mockResolvedValue(null);
      vi.spyOn(prisma.ticket, 'findUnique').mockResolvedValue(null);
      vi.spyOn(prisma.ticket, 'findFirst').mockResolvedValue(null);
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValue(null);
      const logSpy = vi.spyOn(prisma.checkInLog, 'create');

      const res = await request(app)
        .post('/api/scanner/check-in')
        .set('Authorization', `Bearer ${staffToken}`)
        .send({
          token: 'tkt_sec_nonexistent_token_99999',
          eventId: mockUnassignedEvent.slug,
        });

      // Staff with no access to unassigned event is blocked
      expect(res.status).toBe(403);
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('allows Organizer to check in tickets via /api/scanner/check-in', async () => {
      vi.spyOn(prisma.ticket, 'findUnique').mockResolvedValue(mockAssignedTicket as any);
      vi.spyOn(prisma.ticket, 'updateMany').mockResolvedValue({ count: 1 });
      vi.spyOn(prisma.checkInLog, 'create').mockResolvedValue({} as any);
      vi.spyOn(prisma.ticket, 'count').mockResolvedValue(1);

      const res = await request(app)
        .post('/api/scanner/check-in')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          token: mockAssignedTicket.ticketToken,
          eventId: mockAssignedEvent.slug,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.result).toBe('SUCCESS');
    });
  });

  describe('3. GET /api/scanner/ping & Session Continuity Heartbeat', () => {
    it('returns 401 Unauthorized when request lacks authentication session or token', async () => {
      const res = await request(app).get('/api/scanner/ping');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain('Authentication required');
    });

    it('returns 200 OK with server timestamp and performs zero database queries when authenticated', async () => {
      const findFirstSpy = vi.spyOn(prisma.eventStaff, 'findFirst');

      const beforeTime = Date.now();
      const res = await request(app)
        .get('/api/scanner/ping')
        .set('Authorization', `Bearer ${staffToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(typeof res.body.data.timestamp).toBe('number');
      expect(res.body.data.timestamp).toBeGreaterThanOrEqual(beforeTime);
      expect(res.body.data.timestamp).toBeLessThanOrEqual(Date.now());

      // Heartbeat ping must be lightweight with no unnecessary database queries
      expect(findFirstSpy).not.toHaveBeenCalled();
    });

    it('successfully touches the server session in Redis on authenticated ping', async () => {
      const testUserId = 'usr-ping-touch-session-test';
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue({
        id: testUserId,
        email: 'ping_touch@outside.vip',
        role: Role.ATTENDEE,
        emailVerified: true,
        status: AccountStatus.ACTIVE,
      } as any);

      // Create a real Redis session with past lastActiveAt
      const issued = await createSession({ userId: testUserId });
      const redis = getRedisClient();
      const sessionKey = `${SESSION_PREFIX}${issued.sessionId}`;

      const initialRaw = await redis.get(sessionKey);
      expect(initialRaw).not.toBeNull();
      const initialRecord = JSON.parse(initialRaw!);
      const initialActiveAt = initialRecord.lastActiveAt;

      // Fast forward time slightly
      await new Promise((r) => setTimeout(r, 15));

      const pingRes = await request(app)
        .get('/api/scanner/ping')
        .set('Cookie', `${SESSION_COOKIE_NAME}=${encodeURIComponent(issued.rawCookieValue)}`);

      expect(pingRes.status).toBe(200);
      expect(pingRes.body.success).toBe(true);

      const updatedRaw = await redis.get(sessionKey);
      expect(updatedRaw).not.toBeNull();
      const updatedRecord = JSON.parse(updatedRaw!);
      expect(updatedRecord.lastActiveAt).toBeGreaterThan(initialActiveAt);
    });

    it('preserves absolute 7-day session expiry and cannot be extended indefinitely by ping', async () => {
      const testUserId = 'usr-ping-absolute-expiry-test';
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue({
        id: testUserId,
        email: 'ping_expiry@outside.vip',
        role: Role.ATTENDEE,
        emailVerified: true,
        status: AccountStatus.ACTIVE,
      } as any);

      const issued = await createSession({ userId: testUserId });
      const redis = getRedisClient();
      const sessionKey = `${SESSION_PREFIX}${issued.sessionId}`;

      // Simulate session reaching its absolute expiry limit
      const raw = await redis.get(sessionKey);
      const record = JSON.parse(raw!);
      record.absoluteExpiresAt = Date.now() - 1000; // Expired absolute lifetime
      await redis.setPx(sessionKey, JSON.stringify(record), 60_000);

      const pingRes = await request(app)
        .get('/api/scanner/ping')
        .set('Cookie', `${SESSION_COOKIE_NAME}=${encodeURIComponent(issued.rawCookieValue)}`);

      expect(pingRes.status).toBe(401);

      // The expired session must be purged from Redis
      const postPingRaw = await redis.get(sessionKey);
      expect(postPingRaw).toBeNull();
    });

    it('ensures revoked EventStaff assignment remains blocked on check-in even when session is actively touched by ping', async () => {
      // Staff member has valid session touched by ping
      const pingRes = await request(app)
        .get('/api/scanner/ping')
        .set('Authorization', `Bearer ${staffToken}`);
      expect(pingRes.status).toBe(200);

      // But organizer revoked staff assignment in PostgreSQL
      vi.spyOn(prisma.eventStaff, 'findFirst').mockResolvedValue(null);
      vi.spyOn(prisma.ticket, 'findUnique').mockResolvedValue(mockAssignedTicket as any);
      vi.spyOn(prisma.eventStaff, 'findUnique').mockResolvedValue({
        id: 'staff-revoked-id',
        status: EventStaffStatus.REVOKED,
      } as any);

      const checkInRes = await request(app)
        .post('/api/scanner/check-in')
        .set('Authorization', `Bearer ${staffToken}`)
        .send({
          token: mockAssignedTicket.ticketToken,
          eventId: mockAssignedEvent.slug,
        });

      // Immediate 403 Forbidden even with active session!
      expect(checkInRes.status).toBe(403);
      expect(checkInRes.body.error.message).toContain('You do not have permission');
    });
  });
});


