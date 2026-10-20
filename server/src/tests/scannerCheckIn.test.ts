import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../app.js';
import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';

describe('Organizer Check-In & Scanner Validation API', () => {
  const organizerId = 'org-user-uuid-111';
  const otherOrganizerId = 'org-user-uuid-999';

  const organizerToken = jwt.sign(
    { userId: organizerId, email: 'organizer@outside.vip', role: 'ORGANIZER' },
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
      vi.spyOn(prisma.ticket, 'updateMany').mockResolvedValue({ count: 1 });
      vi.spyOn(prisma.ticket, 'count').mockResolvedValue(1);
      vi.spyOn(prisma.checkInLog, 'create').mockResolvedValue({} as any);

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
      vi.spyOn(prisma.ticket, 'updateMany').mockResolvedValue({ count: 1 });
      vi.spyOn(prisma.ticket, 'count').mockResolvedValue(1);
      vi.spyOn(prisma.checkInLog, 'create').mockResolvedValue({} as any);

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
      vi.spyOn(prisma.ticket, 'updateMany').mockResolvedValue({ count: 1 });
      vi.spyOn(prisma.ticket, 'count').mockResolvedValue(1);
      vi.spyOn(prisma.checkInLog, 'create').mockResolvedValue({} as any);

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
      vi.spyOn(prisma.ticket, 'updateMany').mockResolvedValue({ count: 1 });
      vi.spyOn(prisma.ticket, 'count').mockResolvedValue(1);
      vi.spyOn(prisma.checkInLog, 'create').mockResolvedValue({} as any);

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
});
