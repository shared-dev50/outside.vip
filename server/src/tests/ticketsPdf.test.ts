import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';
import { nanoid } from 'nanoid';
import { app } from '../app.js';
import { prisma } from '../db/prisma.js';
import { EventStatus, OrderStatus, TicketStatus, Role } from '@prisma/client';
import { fulfillPaidOrder } from '../modules/webhooks/webhook.service.js';
import {
  generateTicketsPdf,
  fetchImageBuffer,
  toPdfOptimizedImageUrl,
  isSafeRemoteImageUrl,
  isPdfCompatibleImageBuffer,
  ensurePdfCompatibleImageBuffer,
} from '../modules/orders/ticketPdf.service.js';

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
    // Authenticate seeded organizer
    const organizerLogin = await request(app).post('/api/auth/login').send({
      email: 'sol@outside.vip',
      password: 'Outside2026!',
    });
    expect(organizerLogin.status).toBe(200);
    organizerToken = organizerLogin.body.data.token;
    organizerUserId = organizerLogin.body.data.user.id;

    // Authenticate seeded attendee
    const attendeeLogin = await request(app).post('/api/auth/login').send({
      email: 'alex@outside.vip',
      password: 'Outside2026!',
    });
    expect(attendeeLogin.status).toBe(200);
    attendeeToken = attendeeLogin.body.data.token;
    attendeeUserId = attendeeLogin.body.data.user.id;

    // Create or authenticate second attendee for access control tests
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

    // Retrieve published event and active tier
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

    // Create a clean test order with 2 tickets belonging to attendeeUser
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
  }, 30000);

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

  describe('6. Cover Image Handling (Cloudinary, Seeded, Missing, and Failed Fetch)', () => {
    // 1x1 WebP base64 image (standard Cloudinary-uploaded crop output)
    const sampleWebpBase64 = 'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAQAcJaQAA3AA/v3AgAA=';
    const sampleWebpBuffer = Buffer.from(sampleWebpBase64, 'base64');

    // 1x1 PNG base64 image
    const samplePngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const samplePngBuffer = Buffer.from(samplePngBase64, 'base64');

    describe('SSRF & URL Security Validation', () => {
      it('rejects loopback, localhost, and metadata service IP addresses', () => {
        expect(isSafeRemoteImageUrl('http://localhost:4000/cover.jpg')).toBe(false);
        expect(isSafeRemoteImageUrl('http://127.0.0.1:8080/internal.png')).toBe(false);
        expect(isSafeRemoteImageUrl('http://169.254.169.254/latest/meta-data')).toBe(false);
        expect(isSafeRemoteImageUrl('http://10.0.0.1/private.jpg')).toBe(false);
        expect(isSafeRemoteImageUrl('http://192.168.1.100/router.png')).toBe(false);
        expect(isSafeRemoteImageUrl('http://172.16.5.1/internal.jpg')).toBe(false);
        expect(isSafeRemoteImageUrl('file:///etc/passwd')).toBe(false);
        expect(isSafeRemoteImageUrl('javascript:alert(1)')).toBe(false);
        expect(isSafeRemoteImageUrl('')).toBe(false);
        expect(isSafeRemoteImageUrl(null)).toBe(false);
      });

      it('permits secure public HTTPS URLs', () => {
        expect(isSafeRemoteImageUrl('https://res.cloudinary.com/outside-vip/image/upload/v1/event.webp')).toBe(true);
        expect(isSafeRemoteImageUrl('https://images.unsplash.com/photo-1470225620780-dba8ba36b745')).toBe(true);
      });
    });

    describe('Cloudinary URL Format Transformation', () => {
      it('transforms Cloudinary .webp URL to request JPEG delivery (f_jpg,q_auto)', () => {
        const raw = 'https://res.cloudinary.com/outside-vip/image/upload/v1729000000/outside-vip/event-covers/sample.webp';
        const transformed = toPdfOptimizedImageUrl(raw);
        expect(transformed).toBe(
          'https://res.cloudinary.com/outside-vip/image/upload/f_jpg,q_auto/v1729000000/outside-vip/event-covers/sample.jpg'
        );
      });

      it('replaces f_auto with f_jpg in existing Cloudinary transformation paths', () => {
        const raw = 'https://res.cloudinary.com/outside-vip/image/upload/c_fill,g_auto,w_600,h_400,q_auto,f_auto/v1/cover.webp';
        const transformed = toPdfOptimizedImageUrl(raw);
        expect(transformed).toBe(
          'https://res.cloudinary.com/outside-vip/image/upload/c_fill,g_auto,w_600,h_400,q_auto,f_jpg/v1/cover.jpg'
        );
      });

      it('leaves non-Cloudinary URLs unmodified', () => {
        const unsplash = 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?auto=format&fit=crop&w=1600&q=85';
        expect(toPdfOptimizedImageUrl(unsplash)).toBe(unsplash);
      });
    });

    describe('Image Buffer Format Detection & Transcoding', () => {
      it('detects JPEG and PNG as PDF-compatible formats', () => {
        expect(isPdfCompatibleImageBuffer(samplePngBuffer)).toBe(true);
        const dummyJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
        expect(isPdfCompatibleImageBuffer(dummyJpeg)).toBe(true);
      });

      it('identifies WebP as non-compatible with raw PDFKit and transcodes to JPEG', async () => {
        expect(isPdfCompatibleImageBuffer(sampleWebpBuffer)).toBe(false);
        const transcoded = await ensurePdfCompatibleImageBuffer(sampleWebpBuffer);
        expect(transcoded).toBeTruthy();
        expect(isPdfCompatibleImageBuffer(transcoded!)).toBe(true);
      });
    });

    describe('PDF Generation Scenarios', () => {
      let baseOrderData: any;

      beforeAll(async () => {
        baseOrderData = await prisma.order.findUnique({
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
      });

      it('renders ticket PDF with a seeded/local event cover image', async () => {
        const seededOrder = {
          ...baseOrderData,
          event: {
            ...baseOrderData.event,
            coverImageUrl: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?auto=format&fit=crop&w=1600&q=85',
          },
        };

        const pdfBuffer = await generateTicketsPdf(seededOrder as any);
        expect(pdfBuffer).toBeInstanceOf(Buffer);
        expect(pdfBuffer.length).toBeGreaterThan(1000);
        expect(pdfBuffer.slice(0, 5).toString('ascii')).toBe('%PDF-');
      });

      it('renders ticket PDF with a Cloudinary-hosted event cover image (WebP transformed/transcoded to JPEG)', async () => {
        const originalFetch = globalThis.fetch;
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (url: any) => {
          if (typeof url === 'string' && url.includes('cloudinary.com')) {
            return {
              ok: true,
              headers: new Headers({ 'content-type': 'image/webp' }),
              arrayBuffer: async () =>
                sampleWebpBuffer.buffer.slice(
                  sampleWebpBuffer.byteOffset,
                  sampleWebpBuffer.byteOffset + sampleWebpBuffer.byteLength
                ),
            } as any;
          }
          return originalFetch(url);
        });

        const cloudinaryOrder = {
          ...baseOrderData,
          event: {
            ...baseOrderData.event,
            coverImageUrl: 'https://res.cloudinary.com/outside-vip/image/upload/v1729000000/outside-vip/event-covers/sample.webp',
          },
        };

        const pdfBuffer = await generateTicketsPdf(cloudinaryOrder as any);
        expect(pdfBuffer).toBeInstanceOf(Buffer);
        expect(pdfBuffer.length).toBeGreaterThan(1000);
        expect(pdfBuffer.slice(0, 5).toString('ascii')).toBe('%PDF-');
        fetchSpy.mockRestore();
      });

      it('renders ticket PDF gracefully when an event has no cover image (null/empty)', async () => {
        const noCoverOrder = {
          ...baseOrderData,
          event: {
            ...baseOrderData.event,
            coverImageUrl: null,
          },
        };

        const pdfBuffer = await generateTicketsPdf(noCoverOrder as any);
        expect(pdfBuffer).toBeInstanceOf(Buffer);
        expect(pdfBuffer.length).toBeGreaterThan(1000);
        expect(pdfBuffer.slice(0, 5).toString('ascii')).toBe('%PDF-');
      });

      it('handles failed or inaccessible remote image fetch gracefully without breaking the PDF', async () => {
        const failedBuffer = await fetchImageBuffer('https://example.com/non-existent-ticket-cover-404.jpg', 1500);
        expect(failedBuffer).toBeNull();

        const failedCoverOrder = {
          ...baseOrderData,
          event: {
            ...baseOrderData.event,
            coverImageUrl: 'https://example.com/non-existent-ticket-cover-404.jpg',
          },
        };

        const pdfBuffer = await generateTicketsPdf(failedCoverOrder as any);
        expect(pdfBuffer).toBeInstanceOf(Buffer);
        expect(pdfBuffer.length).toBeGreaterThan(1000);
        expect(pdfBuffer.slice(0, 5).toString('ascii')).toBe('%PDF-');
      });
    });
  });
});
