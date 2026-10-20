import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { nanoid } from 'nanoid';
import { app } from '../app.js';
import { prisma } from '../db/prisma.js';
import { EventStatus, OrderStatus, TicketStatus, Role } from '@prisma/client';
import { fulfillPaidOrder } from '../modules/webhooks/webhook.service.js';
import { generateTicketsPdf } from '../modules/orders/ticketPdf.service.js';

describe('Outside.vip Ticket PDF Generation & QR Credential Validation', () => {
  let organizerToken: string;
  let organizerUserId: string;
  let attendeeToken: string;
  let attendeeUserId: string;
  let secondAttendeeToken: string;
  let secondAttendeeUserId: string;

  let event: any;
  let tier: any;
  let testOrder: any;
  let testOrderAccessToken: string;

  beforeAll(async () => {
    // 1. Authenticate seeded organizer
    const organizerLogin = await request(app).post('/api/auth/login').send({
      email: 'sol@outside.vip',
      password: 'Outside2026!',
    });
    expect(organizerLogin.status).toBe(200);
    organizerToken = organizerLogin.body.data.token;
    organizerUserId = organizerLogin.body.data.user.id;

    // 2. Authenticate seeded attendee
    const attendeeLogin = await request(app).post('/api/auth/login').send({
      email: 'alex@outside.vip',
      password: 'Outside2026!',
    });
    expect(attendeeLogin.status).toBe(200);
    attendeeToken = attendeeLogin.body.data.token;
    attendeeUserId = attendeeLogin.body.data.user.id;

    // 3. Create or authenticate second attendee for access control tests
    const secondEmail = 'second-attendee-pdf@outside.vip';
    let secondUser = await prisma.user.findUnique({ where: { email: secondEmail } });
    if (!secondUser) {
      const reg = await request(app).post('/api/auth/register').send({
        email: secondEmail,
        password: 'Outside2026!',
        name: 'Second Attendee',
      });
      secondAttendeeToken = reg.body.data.token;
      secondAttendeeUserId = reg.body.data.user.id;
    } else {
      const log = await request(app).post('/api/auth/login').send({
        email: secondEmail,
        password: 'Outside2026!',
      });
      secondAttendeeToken = log.body.data.token;
      secondAttendeeUserId = log.body.data.user.id;
    }

    // 4. Retrieve published event and active tier
    event = await prisma.event.findFirst({
      where: {
        status: EventStatus.PUBLISHED,
        slug: 'sol-fest-baobab-edition-2026',
      },
      include: {
        ticketTiers: true,
      },
    });
    expect(event).toBeTruthy();
    tier = event.ticketTiers.find((t: any) => t.priceInCents > 0);
    expect(tier).toBeTruthy();

    // 5. Create a clean test order with 2 tickets belonging to attendeeUser
    testOrderAccessToken = `tok_${nanoid(32)}`;
    const orderNumber = `OUT-TEST-${Date.now()}`;
    const paymentIntentId = `pi_test_${nanoid(20)}`;

    testOrder = await prisma.order.create({
      data: {
        orderNumber,
        userId: attendeeUserId,
        eventId: event.id,
        status: OrderStatus.PENDING,
        customerEmail: 'alex@outside.vip',
        customerName: 'Alex Mwangi',
        customerPhone: '+254712345678',
        totalInCents: tier.priceInCents * 2,
        currency: 'USD',
        platformFeeInCents: Math.round(tier.priceInCents * 2 * 0.05),
        organizerNetInCents: tier.priceInCents * 2 - Math.round(tier.priceInCents * 2 * 0.05),
        orderAccessToken: testOrderAccessToken,
        idempotencyKey: `idemp_${nanoid(16)}`,
        paymentReference: paymentIntentId,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        items: {
          create: [
            {
              ticketTierId: tier.id,
              quantity: 2,
              unitPriceInCents: tier.priceInCents,
              subtotalInCents: tier.priceInCents * 2,
            },
          ],
        },
      },
    });
  });

  describe('1. Unpaid Order Protection', () => {
    it('blocks PDF ticket download when order is PENDING (unpaid)', async () => {
      const res = await request(app)
        .get(`/api/orders/${testOrder.orderNumber}/tickets/pdf`)
        .query({ token: testOrderAccessToken });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toMatch(/Tickets are only downloadable for confirmed and paid orders/i);
    });
  });

  describe('2. Payment Fulfillment & Unique Ticket Credentials', () => {
    let issuedTickets: any[];

    it('fulfills order on verified payment and issues unique, unguessable credentials for each ticket', async () => {
      const mockPaymentIntent: any = {
        id: testOrder.paymentReference,
        status: 'succeeded',
        amount: testOrder.totalInCents,
        currency: 'usd',
        metadata: {
          orderId: testOrder.id,
        },
      };

      await fulfillPaidOrder(mockPaymentIntent);

      const refreshedOrder = await prisma.order.findUnique({
        where: { id: testOrder.id },
        include: { tickets: true },
      });

      expect(refreshedOrder?.status).toBe(OrderStatus.COMPLETED);
      expect(refreshedOrder?.tickets.length).toBe(2);
      issuedTickets = refreshedOrder!.tickets;

      // Ensure credentials are cryptographically secure and distinct
      const [tkt1, tkt2] = issuedTickets;
      expect(tkt1.ticketToken).toMatch(/^tkt_sec_[A-Za-z0-9_-]{20,}$/);
      expect(tkt2.ticketToken).toMatch(/^tkt_sec_[A-Za-z0-9_-]{20,}$/);
      expect(tkt1.ticketToken).not.toBe(tkt2.ticketToken);
      expect(tkt1.status).toBe(TicketStatus.ISSUED);
      expect(tkt2.status).toBe(TicketStatus.ISSUED);
    });

    it('preserves idempotency on duplicate webhook delivery without duplicating tickets or tokens', async () => {
      const mockPaymentIntent: any = {
        id: testOrder.paymentReference,
        status: 'succeeded',
        amount: testOrder.totalInCents,
        currency: 'usd',
        metadata: {
          orderId: testOrder.id,
        },
      };

      // Fulfill second time (simulating webhook retry)
      await fulfillPaidOrder(mockPaymentIntent);

      const refreshedOrder = await prisma.order.findUnique({
        where: { id: testOrder.id },
        include: { tickets: true },
      });

      expect(refreshedOrder?.tickets.length).toBe(2);
      const currentTokens = refreshedOrder!.tickets.map((t) => t.ticketToken);
      expect(currentTokens).toContain(issuedTickets[0].ticketToken);
      expect(currentTokens).toContain(issuedTickets[1].ticketToken);
    });
  });

  describe('3. Ticket PDF Generation & Stability', () => {
    it('generates valid binary PDF bundle with %PDF header and correct content-disposition', async () => {
      const res = await request(app)
        .get(`/api/orders/${testOrder.orderNumber}/tickets/pdf`)
        .query({ token: testOrderAccessToken });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toMatch(/attachment; filename="outside-passes-.*\.pdf"/);
      
      const buffer = Buffer.from(res.body);
      // PDF documents always start with %PDF-
      expect(buffer.slice(0, 5).toString('ascii')).toBe('%PDF-');
    });

    it('ensures ticket credentials remain completely stable across repeated downloads', async () => {
      // First download
      await request(app)
        .get(`/api/orders/${testOrder.orderNumber}/tickets/pdf`)
        .query({ token: testOrderAccessToken });

      const ticketsAfterFirst = await prisma.ticket.findMany({
        where: { orderId: testOrder.id },
        orderBy: { createdAt: 'asc' },
      });

      // Second download
      await request(app)
        .get(`/api/orders/${testOrder.orderNumber}/tickets/pdf`)
        .query({ token: testOrderAccessToken });

      const ticketsAfterSecond = await prisma.ticket.findMany({
        where: { orderId: testOrder.id },
        orderBy: { createdAt: 'asc' },
      });

      expect(ticketsAfterFirst[0].ticketToken).toBe(ticketsAfterSecond[0].ticketToken);
      expect(ticketsAfterFirst[1].ticketToken).toBe(ticketsAfterSecond[1].ticketToken);
    });

    it('downloads a single individual ticket PDF by ticket ID', async () => {
      const tickets = await prisma.ticket.findMany({
        where: { orderId: testOrder.id },
      });
      const singleTicket = tickets[0];

      const res = await request(app)
        .get(`/api/orders/${testOrder.orderNumber}/tickets/${singleTicket.id}/pdf`)
        .query({ token: testOrderAccessToken });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toMatch(/attachment; filename="outside-ticket-.*\.pdf"/);

      const buffer = Buffer.from(res.body);
      expect(buffer.slice(0, 5).toString('ascii')).toBe('%PDF-');
    });

    it('directly renders PDF buffer using generateTicketsPdf without exceptions', async () => {
      const fullOrder = await prisma.order.findUnique({
        where: { id: testOrder.id },
        include: {
          event: {
            include: {
              organizer: {
                include: {
                  organizer: true,
                },
              },
            },
          },
          tickets: {
            include: {
              ticketTier: true,
            },
          },
        },
      });

      const pdfBuffer = await generateTicketsPdf(fullOrder as any);
      expect(pdfBuffer).toBeInstanceOf(Buffer);
      expect(pdfBuffer.length).toBeGreaterThan(1000);
      expect(pdfBuffer.slice(0, 5).toString('ascii')).toBe('%PDF-');
    });
  });

  describe('4. Access Control & Authorization', () => {
    it('returns 401 Unauthorized when no authentication or access token is provided', async () => {
      const res = await request(app).get(`/api/orders/${testOrder.orderNumber}/tickets/pdf`);
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('returns 403 Forbidden when an invalid order access token is provided', async () => {
      const res = await request(app)
        .get(`/api/orders/${testOrder.orderNumber}/tickets/pdf`)
        .query({ token: 'wrong_unauthorized_token' });
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('returns 403 Forbidden when another attendee attempts to download tickets without the access token', async () => {
      const res = await request(app)
        .get(`/api/orders/${testOrder.orderNumber}/tickets/pdf`)
        .set('Authorization', `Bearer ${secondAttendeeToken}`);
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('allows the order owner attendee to download tickets with their Bearer token', async () => {
      const res = await request(app)
        .get(`/api/orders/${testOrder.orderNumber}/tickets/pdf`)
        .set('Authorization', `Bearer ${attendeeToken}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
    });

    it('allows the event organizer to download tickets with their Bearer token', async () => {
      const res = await request(app)
        .get(`/api/orders/${testOrder.orderNumber}/tickets/pdf`)
        .set('Authorization', `Bearer ${organizerToken}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
    });
  });

  describe('5. Scanner & Check-in Integration', () => {
    let ticketToScan: any;

    beforeAll(async () => {
      ticketToScan = await prisma.ticket.findFirst({
        where: { orderId: testOrder.id, status: TicketStatus.ISSUED },
      });
      expect(ticketToScan).toBeTruthy();
    });

    it('successfully admits an unredeemed ticket matching the event', async () => {
      const res = await request(app)
        .post('/api/organizer/check-in')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          token: ticketToScan.ticketToken,
          eventId: event.id,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.result).toBe('SUCCESS');
      expect(res.body.data.ticket.attendeeName).toBe('Alex Mwangi');

      // Verify DB record updated
      const updated = await prisma.ticket.findUnique({
        where: { id: ticketToScan.id },
      });
      expect(updated?.status).toBe(TicketStatus.CHECKED_IN);
      expect(updated?.checkedInAt).toBeTruthy();

      // Verify CheckInLog record
      const log = await prisma.checkInLog.findFirst({
        where: { ticketId: ticketToScan.id, result: 'SUCCESS' },
      });
      expect(log).toBeTruthy();
      expect(log?.scannedToken).toBe(ticketToScan.ticketToken);
    });

    it('rejects a duplicate scan for an already checked-in ticket with 409 Conflict', async () => {
      const res = await request(app)
        .post('/api/organizer/check-in')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          token: ticketToScan.ticketToken,
          eventId: event.id,
        });

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.data.result).toBe('ALREADY_CHECKED_IN');
      expect(res.body.data.ticket.checkedInAt).toBeTruthy();

      // Verify duplicate CheckInLog record
      const dupLog = await prisma.checkInLog.findFirst({
        where: { ticketId: ticketToScan.id, result: 'ALREADY_CHECKED_IN' },
      });
      expect(dupLog).toBeTruthy();
    });

    it('rejects an invalid / unknown credential with 404', async () => {
      const res = await request(app)
        .post('/api/organizer/check-in')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          token: 'tkt_sec_invalid_bogus_token_123',
          eventId: event.id,
        });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.data.result).toBe('INVALID_TOKEN');
    });

    it('rejects a ticket scanned at the wrong event gate with 400', async () => {
      const secondTicket = await prisma.ticket.findFirst({
        where: { orderId: testOrder.id, status: TicketStatus.ISSUED },
      });
      expect(secondTicket).toBeTruthy();

      const res = await request(app)
        .post('/api/organizer/check-in')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          token: secondTicket!.ticketToken,
          eventId: 'different-event-uuid-gate-999',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.data.result).toBe('WRONG_EVENT');
    });
  });
});
