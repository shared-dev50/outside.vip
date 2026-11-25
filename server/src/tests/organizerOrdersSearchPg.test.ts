import request from 'supertest';
import jwt from 'jsonwebtoken';
import { nanoid } from 'nanoid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountStatus, EventStatus, OrderStatus, PaymentProvider, Role } from '@prisma/client';
import { app } from '../app.js';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';

describe('Organizer Orders Real PostgreSQL Search & Isolation', () => {
  const runId = `${Date.now()}_${nanoid(6)}`;
  const createdUserIds: string[] = [];
  const createdEventIds: string[] = [];
  const createdOrderIds: string[] = [];

  let orgAToken = '';
  let orgBToken = '';
  let adminToken = '';
  let orderAId = '';
  let orderBId = '';

  const signToken = (user: { id: string; email: string; role: Role }) =>
    jwt.sign(
      {
        userId: user.id,
        email: user.email,
        role: user.role,
        status: AccountStatus.ACTIVE,
        emailVerified: true,
      },
      env.JWT_SECRET,
      { expiresIn: '1h' }
    );

  beforeAll(async () => {
    const orgA = await prisma.user.create({
      data: {
        email: `orders_srch_a_${runId}@outside.vip`,
        name: 'Search Org Alpha',
        role: Role.ORGANIZER,
        status: AccountStatus.ACTIVE,
        emailVerified: true,
      },
    });
    const orgB = await prisma.user.create({
      data: {
        email: `orders_srch_b_${runId}@outside.vip`,
        name: 'Search Org Beta',
        role: Role.ORGANIZER,
        status: AccountStatus.ACTIVE,
        emailVerified: true,
      },
    });
    const admin = await prisma.user.create({
      data: {
        email: `orders_srch_admin_${runId}@outside.vip`,
        name: 'Search Admin',
        role: Role.ADMIN,
        status: AccountStatus.ACTIVE,
        emailVerified: true,
      },
    });
    createdUserIds.push(orgA.id, orgB.id, admin.id);

    orgAToken = signToken(orgA);
    orgBToken = signToken(orgB);
    adminToken = signToken(admin);

    const eventA = await prisma.event.create({
      data: {
        organizerId: orgA.id,
        title: `Sundowner Kilifi Sessions ${runId}`,
        description: 'Search PG test event A',
        coverImageUrl: 'https://example.com/a.jpg',
        venueName: 'Creek Deck',
        venueAddress: '1 Creek Road',
        city: 'Kilifi',
        country: 'Kenya',
        slug: `srch-a-${runId}`.toLowerCase(),
        category: 'MUSIC',
        status: EventStatus.PUBLISHED,
        startAt: new Date(Date.now() + 86400_000),
        endAt: new Date(Date.now() + 2 * 86400_000),
        timezone: 'Africa/Nairobi',
      },
    });

    const eventB = await prisma.event.create({
      data: {
        organizerId: orgB.id,
        title: `Kilifi Rooftop Afterhours ${runId}`,
        description: 'Search PG test event B',
        coverImageUrl: 'https://example.com/b.jpg',
        venueName: 'Skyline',
        venueAddress: '2 High St',
        city: 'Nairobi',
        country: 'Kenya',
        slug: `srch-b-${runId}`.toLowerCase(),
        category: 'NIGHTLIFE',
        status: EventStatus.PUBLISHED,
        startAt: new Date(Date.now() + 86400_000),
        endAt: new Date(Date.now() + 2 * 86400_000),
        timezone: 'Africa/Nairobi',
      },
    });
    createdEventIds.push(eventA.id, eventB.id);

    const orderA = await prisma.order.create({
      data: {
        orderNumber: `OUT-SRCH-A-${runId.slice(-6).toUpperCase()}`,
        eventId: eventA.id,
        status: OrderStatus.COMPLETED,
        customerName: 'Zainab Wanjiku',
        customerEmail: `zainab.buyer.${runId}@example.com`,
        customerPhone: '+254700111222',
        totalInCents: 5000,
        currency: 'USD',
        platformFeeInCents: 500,
        organizerNetInCents: 4500,
        idempotencyKey: `idem_srch_a_${runId}`,
        paymentProvider: PaymentProvider.STRIPE,
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });

    const orderB = await prisma.order.create({
      data: {
        orderNumber: `OUT-SRCH-B-${runId.slice(-6).toUpperCase()}`,
        eventId: eventB.id,
        status: OrderStatus.COMPLETED,
        customerName: 'Zainab Muthoni',
        customerEmail: `zainab.other.${runId}@example.com`,
        customerPhone: '+254700333444',
        totalInCents: 7500,
        currency: 'USD',
        platformFeeInCents: 750,
        organizerNetInCents: 6750,
        idempotencyKey: `idem_srch_b_${runId}`,
        paymentProvider: PaymentProvider.STRIPE,
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    createdOrderIds.push(orderA.id, orderB.id);
    orderAId = orderA.id;
    orderBId = orderB.id;
  }, 20_000);

  afterAll(async () => {
    if (createdOrderIds.length > 0) {
      await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
    }
    if (createdEventIds.length > 0) {
      await prisma.event.deleteMany({ where: { id: { in: createdEventIds } } });
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
  });

  it('matches case-insensitive partial substrings across orderNumber, customerName, customerEmail, and event title in PostgreSQL', async () => {
    const tokenSuffix = runId.slice(-6);

    // 1. Order number (partial, mixed-case, with leading #)
    const byOrderNum = await request(app)
      .get(`/api/organizer/orders?search=${encodeURIComponent(`#srch-a-${tokenSuffix.toLowerCase()}`)}`)
      .set('Authorization', `Bearer ${orgAToken}`);
    expect(byOrderNum.status).toBe(200);
    expect(byOrderNum.body.data.orders.map((o: any) => o.id)).toEqual([orderAId]);

    // 2. Customer name (partial, mixed-case)
    const byName = await request(app)
      .get('/api/organizer/orders?search=wAnJiK')
      .set('Authorization', `Bearer ${orgAToken}`);
    expect(byName.status).toBe(200);
    expect(byName.body.data.orders.map((o: any) => o.id)).toEqual([orderAId]);

    // 3. Customer email (partial, uppercase)
    const byEmail = await request(app)
      .get(`/api/organizer/orders?search=${encodeURIComponent(`BUYER.${runId.toUpperCase()}`)}`)
      .set('Authorization', `Bearer ${orgAToken}`);
    expect(byEmail.status).toBe(200);
    expect(byEmail.body.data.orders.map((o: any) => o.id)).toEqual([orderAId]);

    // 4. Event name (partial, lowercase)
    const byEvent = await request(app)
      .get('/api/organizer/orders?search=sundowner')
      .set('Authorization', `Bearer ${orgAToken}`);
    expect(byEvent.status).toBe(200);
    expect(byEvent.body.data.orders.map((o: any) => o.id)).toEqual([orderAId]);
  });

  it('strictly isolates shared search terms by organizer ownership while letting platform ADMIN search across events', async () => {
    // Both orders share "Zainab" and event city/word "Kilifi"
    const orgARes = await request(app)
      .get('/api/organizer/orders?search=kilifi')
      .set('Authorization', `Bearer ${orgAToken}`);
    expect(orgARes.status).toBe(200);
    expect(orgARes.body.data.orders.map((o: any) => o.id)).toEqual([orderAId]);

    const orgBRes = await request(app)
      .get('/api/organizer/orders?search=zainab')
      .set('Authorization', `Bearer ${orgBToken}`);
    expect(orgBRes.status).toBe(200);
    expect(orgBRes.body.data.orders.map((o: any) => o.id)).toEqual([orderBId]);

    const adminRes = await request(app)
      .get(`/api/organizer/orders?search=${encodeURIComponent(runId)}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(adminRes.status).toBe(200);
    const adminIds = adminRes.body.data.orders.map((o: any) => o.id);
    expect(adminIds).toContain(orderAId);
    expect(adminIds).toContain(orderBId);
  });
});
