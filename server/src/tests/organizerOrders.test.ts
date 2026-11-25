import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Role, AccountStatus, OrderStatus, PaymentProvider } from '@prisma/client';
import { app } from '../app.js';
import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';

describe('Organizer Orders Listing API (GET /api/organizer/orders)', () => {
  const organizerId = 'org-usr-test-111';
  const otherOrganizerId = 'org-usr-test-999';
  const adminId = 'admin-usr-test-000';
  const attendeeId = 'attendee-usr-test-555';

  const signToken = (payload: { userId: string; role: Role; email?: string; emailVerified?: boolean }) => {
    return jwt.sign(
      {
        userId: payload.userId,
        role: payload.role,
        email: payload.email || `${payload.userId}@outside.vip`,
        status: AccountStatus.ACTIVE,
        emailVerified: payload.emailVerified ?? true,
      },
      env.JWT_SECRET,
      { expiresIn: '1h' }
    );
  };

  const organizerToken = signToken({ userId: organizerId, role: Role.ORGANIZER });
  const otherOrganizerToken = signToken({ userId: otherOrganizerId, role: Role.ORGANIZER });
  const adminToken = signToken({ userId: adminId, role: Role.ADMIN });
  const attendeeToken = signToken({ userId: attendeeId, role: Role.ATTENDEE });
  const unverifiedOrganizerToken = signToken({ userId: organizerId, role: Role.ORGANIZER, emailVerified: false });

  const mockOrganizerEvent = {
    id: 'evt-solar-111',
    title: 'Solar Eclipse Rooftop 2026',
    slug: 'solar-eclipse-rooftop-2026',
    organizerId,
    startAt: new Date('2026-08-12T14:00:00Z'),
    endAt: new Date('2026-08-12T22:00:00Z'),
    venueName: 'Skyline Terrace',
    city: 'Nairobi',
    country: 'Kenya',
  };

  const mockOtherOrganizerEvent = {
    id: 'evt-sound-999',
    title: 'Underground Sound Chamber',
    slug: 'underground-sound-chamber',
    organizerId: otherOrganizerId,
    startAt: new Date('2026-09-01T20:00:00Z'),
    endAt: new Date('2026-09-02T04:00:00Z'),
    venueName: 'The Vault',
    city: 'Mombasa',
    country: 'Kenya',
  };

  const mockOrdersList = [
    {
      id: 'ord-101',
      orderNumber: 'OUT-2026-10001',
      status: OrderStatus.COMPLETED,
      customerName: 'Alex Mwangi',
      customerEmail: 'alex@outside.vip',
      customerPhone: '+254711111111',
      totalInCents: 15000,
      currency: 'USD',
      platformFeeInCents: 1500,
      organizerNetInCents: 13500,
      paymentProvider: PaymentProvider.STRIPE,
      paymentReference: 'pi_test_101',
      createdAt: new Date('2026-05-01T10:00:00Z'),
      updatedAt: new Date('2026-05-01T10:05:00Z'),
      eventId: mockOrganizerEvent.id,
      event: mockOrganizerEvent,
      items: [
        {
          id: 'item-101',
          ticketTierId: 'tier-vip-1',
          quantity: 2,
          unitPriceInCents: 7500,
          subtotalInCents: 15000,
          ticketTier: { id: 'tier-vip-1', name: 'VIP Pass' },
        },
      ],
      _count: { tickets: 2 },
    },
    {
      id: 'ord-102',
      orderNumber: 'OUT-2026-10002',
      status: OrderStatus.PENDING,
      customerName: 'Sarah Jenkins',
      customerEmail: 'sarah@example.com',
      customerPhone: '+254722222222',
      totalInCents: 5000,
      currency: 'USD',
      platformFeeInCents: 500,
      organizerNetInCents: 4500,
      paymentProvider: PaymentProvider.STRIPE,
      paymentReference: 'pi_test_102',
      createdAt: new Date('2026-05-02T12:00:00Z'),
      updatedAt: new Date('2026-05-02T12:00:00Z'),
      eventId: mockOrganizerEvent.id,
      event: mockOrganizerEvent,
      items: [
        {
          id: 'item-102',
          ticketTierId: 'tier-ga-1',
          quantity: 1,
          unitPriceInCents: 5000,
          subtotalInCents: 5000,
          ticketTier: { id: 'tier-ga-1', name: 'General Admission' },
        },
      ],
      _count: { tickets: 1 },
    },
    {
      id: 'ord-103',
      orderNumber: 'OUT-2026-10003',
      status: OrderStatus.CANCELLED,
      customerName: 'David Kim',
      customerEmail: 'david@example.com',
      customerPhone: '+254733333333',
      totalInCents: 10000,
      currency: 'USD',
      platformFeeInCents: 1000,
      organizerNetInCents: 9000,
      paymentProvider: PaymentProvider.STRIPE,
      paymentReference: 'pi_test_103',
      createdAt: new Date('2026-05-03T14:00:00Z'),
      updatedAt: new Date('2026-05-03T14:10:00Z'),
      eventId: mockOrganizerEvent.id,
      event: mockOrganizerEvent,
      items: [
        {
          id: 'item-103',
          ticketTierId: 'tier-ga-1',
          quantity: 2,
          unitPriceInCents: 5000,
          subtotalInCents: 10000,
          ticketTier: { id: 'tier-ga-1', name: 'General Admission' },
        },
      ],
      _count: { tickets: 2 },
    },
  ];

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('1. Authentication & Role Authorization', () => {
    it('returns 401 Unauthorized when unauthenticated', async () => {
      const res = await request(app).get('/api/organizer/orders');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('returns 403 Forbidden when accessed with ATTENDEE token', async () => {
      const res = await request(app)
        .get('/api/organizer/orders')
        .set('Authorization', `Bearer ${attendeeToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('returns 403 Forbidden when accessed with unverified email', async () => {
      const res = await request(app)
        .get('/api/organizer/orders')
        .set('Authorization', `Bearer ${unverifiedOrganizerToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });
  });

  describe('2. Organizer Orders Retrieval & Response Structure', () => {
    it('successfully returns paginated orders belonging to the organizer', async () => {
      vi.spyOn(prisma.order, 'count').mockResolvedValue(3);
      vi.spyOn(prisma.order, 'findMany').mockResolvedValue(mockOrdersList as any);

      const res = await request(app)
        .get('/api/organizer/orders')
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.orders).toBeUndefined();
      expect(res.body.pagination).toBeUndefined();

      const data = res.body.data;
      expect(data.orders).toHaveLength(3);
      expect(data.pagination).toEqual({
        page: 1,
        limit: 20,
        total: 3,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      });

      const firstOrder = data.orders[0];
      expect(firstOrder.id).toBe('ord-101');
      expect(firstOrder.orderNumber).toBe('OUT-2026-10001');
      expect(firstOrder.status).toBe('COMPLETED');
      expect(firstOrder.paymentStatus).toBe('PAID');
      expect(firstOrder.customerName).toBe('Alex Mwangi');
      expect(firstOrder.customerEmail).toBe('alex@outside.vip');
      expect(firstOrder.totalInCents).toBe(15000);
      expect(firstOrder.ticketQuantity).toBe(2);
      expect(firstOrder.items).toHaveLength(1);
      expect(firstOrder.items[0]).toEqual({
        id: 'item-101',
        ticketTierId: 'tier-vip-1',
        tierName: 'VIP Pass',
        quantity: 2,
        unitPriceInCents: 7500,
        subtotalInCents: 15000,
      });

      expect(firstOrder.paymentReference).toBeUndefined();
      expect(firstOrder.orderAccessToken).toBeUndefined();
      expect(firstOrder.idempotencyKey).toBeUndefined();
    });

    it('handles empty results cleanly with zero counts', async () => {
      vi.spyOn(prisma.order, 'count').mockResolvedValue(0);
      vi.spyOn(prisma.order, 'findMany').mockResolvedValue([]);

      const res = await request(app)
        .get('/api/organizer/orders')
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.orders).toEqual([]);
      expect(res.body.data.pagination).toEqual({
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
        hasNextPage: false,
        hasPreviousPage: false,
      });
    });
  });

  describe('3. Strict Organizer Data Isolation', () => {
    it('enforces organizerId at the Prisma where clause level', async () => {
      const countSpy = vi.spyOn(prisma.order, 'count').mockResolvedValue(0);
      const findManySpy = vi.spyOn(prisma.order, 'findMany').mockResolvedValue([]);

      await request(app)
        .get('/api/organizer/orders')
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(countSpy).toHaveBeenCalledWith({
        where: {
          AND: expect.arrayContaining([
            { event: { organizerId } },
          ]),
        },
      });

      expect(findManySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: expect.arrayContaining([
              { event: { organizerId } },
            ]),
          },
        })
      );
    });

    it('rejects an organizer attempting to filter by an event owned by another organizer with 403 Forbidden', async () => {
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValue(mockOtherOrganizerEvent as any);

      const res = await request(app)
        .get(`/api/organizer/orders?eventId=${mockOtherOrganizerEvent.id}`)
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain('You do not have permission to view orders for this event');
    });

    it('returns 404 Not Found when filtering by a non-existent eventId', async () => {
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValue(null);

      const res = await request(app)
        .get('/api/organizer/orders?eventId=non-existent-event-id')
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain('Event not found');
    });

    it('allows an organizer to filter by their own eventId (UUID)', async () => {
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValue(mockOrganizerEvent as any);
      const countSpy = vi.spyOn(prisma.order, 'count').mockResolvedValue(1);
      const findManySpy = vi.spyOn(prisma.order, 'findMany').mockResolvedValue([mockOrdersList[0]] as any);

      const res = await request(app)
        .get(`/api/organizer/orders?eventId=${mockOrganizerEvent.id}`)
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(countSpy).toHaveBeenCalledWith({
        where: {
          AND: expect.arrayContaining([
            { event: { organizerId } },
            { eventId: mockOrganizerEvent.id },
          ]),
        },
      });
      expect(findManySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: expect.arrayContaining([
              { event: { organizerId } },
              { eventId: mockOrganizerEvent.id },
            ]),
          },
        })
      );
    });

    it('allows an organizer to filter by their own event slug', async () => {
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValue(mockOrganizerEvent as any);
      vi.spyOn(prisma.order, 'count').mockResolvedValue(1);
      vi.spyOn(prisma.order, 'findMany').mockResolvedValue([mockOrdersList[0]] as any);

      const res = await request(app)
        .get(`/api/organizer/orders?eventId=${mockOrganizerEvent.slug}`)
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(prisma.event.findFirst).toHaveBeenCalledWith({
        where: {
          OR: [{ id: mockOrganizerEvent.slug }, { slug: mockOrganizerEvent.slug }],
        },
        select: { id: true, organizerId: true },
      });
    });
  });

  describe('4. Administrator Platform-Wide Access', () => {
    it('allows admin to list orders across all organizers without organizerId restriction', async () => {
      const countSpy = vi.spyOn(prisma.order, 'count').mockResolvedValue(10);
      const findManySpy = vi.spyOn(prisma.order, 'findMany').mockResolvedValue(mockOrdersList as any);

      const res = await request(app)
        .get('/api/organizer/orders')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(countSpy).toHaveBeenCalledWith({ where: {} });
      expect(findManySpy).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
      expect(res.body.data.orders[0].paymentReference).toBe('pi_test_101');
    });

    it('allows admin to view orders for an event owned by any organizer', async () => {
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValue(mockOtherOrganizerEvent as any);
      const countSpy = vi.spyOn(prisma.order, 'count').mockResolvedValue(1);
      const findManySpy = vi.spyOn(prisma.order, 'findMany').mockResolvedValue([mockOrdersList[0]] as any);

      const res = await request(app)
        .get(`/api/organizer/orders?eventId=${mockOtherOrganizerEvent.id}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(countSpy).toHaveBeenCalledWith({
        where: {
          AND: [{ eventId: mockOtherOrganizerEvent.id }],
        },
      });
    });
  });

  describe('5. Status Filtering & Status Aliases', () => {
    it('filters by single status COMPLETED', async () => {
      const countSpy = vi.spyOn(prisma.order, 'count').mockResolvedValue(1);
      vi.spyOn(prisma.order, 'findMany').mockResolvedValue([mockOrdersList[0]] as any);

      const res = await request(app)
        .get('/api/organizer/orders?status=COMPLETED')
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      expect(countSpy).toHaveBeenCalledWith({
        where: {
          AND: expect.arrayContaining([
            { status: OrderStatus.COMPLETED },
          ]),
        },
      });
    });

    it('maps alias PAID to COMPLETED', async () => {
      const countSpy = vi.spyOn(prisma.order, 'count').mockResolvedValue(1);
      vi.spyOn(prisma.order, 'findMany').mockResolvedValue([mockOrdersList[0]] as any);

      const res = await request(app)
        .get('/api/organizer/orders?status=PAID')
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      expect(countSpy).toHaveBeenCalledWith({
        where: {
          AND: expect.arrayContaining([
            { status: OrderStatus.COMPLETED },
          ]),
        },
      });
    });

    it('supports comma-separated multiple statuses (e.g. PAID,CANCELLED)', async () => {
      const countSpy = vi.spyOn(prisma.order, 'count').mockResolvedValue(2);
      vi.spyOn(prisma.order, 'findMany').mockResolvedValue([mockOrdersList[0], mockOrdersList[2]] as any);

      const res = await request(app)
        .get('/api/organizer/orders?status=PAID,CANCELLED')
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      expect(countSpy).toHaveBeenCalledWith({
        where: {
          AND: expect.arrayContaining([
            { status: { in: [OrderStatus.COMPLETED, OrderStatus.CANCELLED] } },
          ]),
        },
      });
    });

    it('rejects an invalid status with 400 Bad Request', async () => {
      const res = await request(app)
        .get('/api/organizer/orders?status=INVALID_STATUS')
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toBe('Validation failed');
      expect(res.body.error.details[0].message).toContain('Invalid order status');
    });
  });

  describe('6. Search Filtering', () => {
    it('applies case-insensitive partial search across orderNumber, customerName, customerEmail, customerPhone, and event title', async () => {
      const countSpy = vi.spyOn(prisma.order, 'count').mockResolvedValue(1);
      vi.spyOn(prisma.order, 'findMany').mockResolvedValue([mockOrdersList[0]] as any);

      const res = await request(app)
        .get('/api/organizer/orders?search=mWaNg')
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      expect(countSpy).toHaveBeenCalledWith({
        where: {
          AND: expect.arrayContaining([
            { event: { organizerId } },
            {
              OR: [
                { orderNumber: { contains: 'mWaNg', mode: 'insensitive' } },
                { customerName: { contains: 'mWaNg', mode: 'insensitive' } },
                { customerEmail: { contains: 'mWaNg', mode: 'insensitive' } },
                { customerPhone: { contains: 'mWaNg', mode: 'insensitive' } },
                { event: { title: { contains: 'mWaNg', mode: 'insensitive' } } },
              ],
            },
          ]),
        },
      });
    });

    it('matches partial #prefixed order numbers while keeping event owner/team scoping intact', async () => {
      const findManySpy = vi.spyOn(prisma.order, 'findMany').mockResolvedValue([mockOrdersList[0]] as any);
      vi.spyOn(prisma.order, 'count').mockResolvedValue(1);

      const res = await request(app)
        .get('/api/organizer/orders?search=%2310001')
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      expect(findManySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: [
              { event: { organizerId } },
              {
                OR: [
                  { orderNumber: { contains: '#10001', mode: 'insensitive' } },
                  { orderNumber: { contains: '10001', mode: 'insensitive' } },
                  { customerName: { contains: '#10001', mode: 'insensitive' } },
                  { customerEmail: { contains: '#10001', mode: 'insensitive' } },
                  { customerPhone: { contains: '#10001', mode: 'insensitive' } },
                  { event: { title: { contains: '#10001', mode: 'insensitive' } } },
                ],
              },
            ],
          },
        })
      );
    });

    it('rejects unauthorized attendees even when search parameter is supplied', async () => {
      const res = await request(app)
        .get('/api/organizer/orders?search=Solar')
        .set('Authorization', `Bearer ${attendeeToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });
  });

  describe('7. Pagination & Sorting', () => {
    it('applies pagination parameters and calculates hasNextPage / hasPreviousPage', async () => {
      vi.spyOn(prisma.order, 'count').mockResolvedValue(25);
      const findManySpy = vi.spyOn(prisma.order, 'findMany').mockResolvedValue(mockOrdersList as any);

      const res = await request(app)
        .get('/api/organizer/orders?page=2&limit=10')
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      expect(findManySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 10,
          take: 10,
        })
      );
      expect(res.body.data.pagination).toEqual({
        page: 2,
        limit: 10,
        total: 25,
        totalPages: 3,
        hasNextPage: true,
        hasPreviousPage: true,
      });
    });

    it('applies custom sorting options with deterministic secondary tie-breaker', async () => {
      vi.spyOn(prisma.order, 'count').mockResolvedValue(3);
      const findManySpy = vi.spyOn(prisma.order, 'findMany').mockResolvedValue(mockOrdersList as any);

      const res = await request(app)
        .get('/api/organizer/orders?sortBy=totalInCents&sortOrder=asc')
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      expect(findManySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ totalInCents: 'asc' }, { id: 'desc' }],
        })
      );
    });

    it('ensures default sorting applies createdAt desc with id desc tie-breaker', async () => {
      vi.spyOn(prisma.order, 'count').mockResolvedValue(3);
      const findManySpy = vi.spyOn(prisma.order, 'findMany').mockResolvedValue(mockOrdersList as any);

      const res = await request(app)
        .get('/api/organizer/orders')
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      expect(findManySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        })
      );
    });

    it('rejects invalid pagination parameters with 400 Bad Request', async () => {
      const resPageZero = await request(app)
        .get('/api/organizer/orders?page=0')
        .set('Authorization', `Bearer ${organizerToken}`);
      expect(resPageZero.status).toBe(400);

      const resLimitExceeded = await request(app)
        .get('/api/organizer/orders?limit=101')
        .set('Authorization', `Bearer ${organizerToken}`);
      expect(resLimitExceeded.status).toBe(400);

      const resInvalidSortBy = await request(app)
        .get('/api/organizer/orders?sortBy=secretField')
        .set('Authorization', `Bearer ${organizerToken}`);
      expect(resInvalidSortBy.status).toBe(400);

      const resInvalidSortOrder = await request(app)
        .get('/api/organizer/orders?sortOrder=upwards')
        .set('Authorization', `Bearer ${organizerToken}`);
      expect(resInvalidSortOrder.status).toBe(400);
    });
  });

  describe('8. SEC-05: Event Admin Order Access & Data Isolation', () => {
    it('allows ATTENDEE-role Event Admin with canViewOrders: true to retrieve orders for their assigned event', async () => {
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValue(mockOrganizerEvent as any);
      vi.spyOn(prisma.eventTeamMember, 'findUnique').mockResolvedValue({
        id: 'tm-admin-1',
        eventId: mockOrganizerEvent.id,
        userId: attendeeId,
        role: 'ADMIN',
        status: 'ACTIVE',
        permissions: { canViewOrders: true },
      } as any);
      const countSpy = vi.spyOn(prisma.order, 'count').mockResolvedValue(1);
      const findManySpy = vi.spyOn(prisma.order, 'findMany').mockResolvedValue([mockOrdersList[0]] as any);

      const res = await request(app)
        .get(`/api/organizer/orders?eventId=${mockOrganizerEvent.id}`)
        .set('Authorization', `Bearer ${attendeeToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.orders).toHaveLength(1);
      expect(res.body.data.orders[0].id).toBe('ord-101');
      // Must scope strictly by eventId without forcing event.organizerId === attendeeId
      expect(countSpy).toHaveBeenCalledWith({
        where: {
          AND: [{ eventId: mockOrganizerEvent.id }],
        },
      });
      expect(findManySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: [{ eventId: mockOrganizerEvent.id }],
          },
        })
      );
    });

    it('allows ORGANIZER-role Event Admin with canViewOrders: true to retrieve orders for an assigned event owned by another organizer', async () => {
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValue(mockOtherOrganizerEvent as any);
      vi.spyOn(prisma.eventTeamMember, 'findUnique').mockResolvedValue({
        id: 'tm-admin-2',
        eventId: mockOtherOrganizerEvent.id,
        userId: organizerId,
        role: 'ADMIN',
        status: 'ACTIVE',
        permissions: { canViewOrders: true },
      } as any);
      const countSpy = vi.spyOn(prisma.order, 'count').mockResolvedValue(1);
      vi.spyOn(prisma.order, 'findMany').mockResolvedValue([mockOrdersList[0]] as any);

      const res = await request(app)
        .get(`/api/organizer/orders?eventId=${mockOtherOrganizerEvent.id}`)
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(countSpy).toHaveBeenCalledWith({
        where: {
          AND: [{ eventId: mockOtherOrganizerEvent.id }],
        },
      });
    });

    it('rejects Event Admin with canViewOrders: false with 403 Forbidden', async () => {
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValue(mockOrganizerEvent as any);
      vi.spyOn(prisma.eventTeamMember, 'findUnique').mockResolvedValue({
        id: 'tm-admin-no-orders',
        eventId: mockOrganizerEvent.id,
        userId: attendeeId,
        role: 'ADMIN',
        status: 'ACTIVE',
        permissions: { canViewOrders: false, canEditDetails: true },
      } as any);

      const res = await request(app)
        .get(`/api/organizer/orders?eventId=${mockOrganizerEvent.id}`)
        .set('Authorization', `Bearer ${attendeeToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('rejects Event Admin attempting to access orders for an unassigned event with 403 Forbidden', async () => {
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValue(mockOtherOrganizerEvent as any);
      vi.spyOn(prisma.eventTeamMember, 'findUnique').mockResolvedValue(null);

      const res = await request(app)
        .get(`/api/organizer/orders?eventId=${mockOtherOrganizerEvent.id}`)
        .set('Authorization', `Bearer ${attendeeToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('scopes requests without eventId for ATTENDEE-role Event Admin strictly to events where they hold active ADMIN membership with canViewOrders: true', async () => {
      vi.spyOn(prisma.eventTeamMember, 'findMany').mockResolvedValue([
        {
          eventId: mockOrganizerEvent.id,
          role: 'ADMIN',
          permissions: { canViewOrders: true },
        },
        {
          eventId: mockOtherOrganizerEvent.id,
          role: 'ADMIN',
          permissions: { canViewOrders: false },
        },
      ] as any);
      const countSpy = vi.spyOn(prisma.order, 'count').mockResolvedValue(1);
      vi.spyOn(prisma.order, 'findMany').mockResolvedValue([mockOrdersList[0]] as any);

      const res = await request(app)
        .get('/api/organizer/orders')
        .set('Authorization', `Bearer ${attendeeToken}`);

      expect(res.status).toBe(200);
      expect(countSpy).toHaveBeenCalledWith({
        where: {
          AND: [{ eventId: { in: [mockOrganizerEvent.id] } }],
        },
      });
    });
  });
});
