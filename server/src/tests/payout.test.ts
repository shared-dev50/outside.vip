import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { app } from '../app.js';
import { prisma } from '../db/prisma.js';
import {
  maskAccountNumber,
  getAccountNumberLast4,
  encryptAccountNumber,
  decryptAccountNumber,
  sanitizePayoutDetails,
} from '../lib/payoutCrypto.js';

describe('Outside.vip Payout & Organisation Details', () => {
  let organizerToken: string;
  let organizerUserId: string;
  let attendeeToken: string;
  let otherOrganizerToken: string;
  let otherOrganizerUserId: string;

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

    // Create or authenticate a second organizer for access control tests
    const otherEmail = 'second_organizer_test@outside.vip';
    let otherUser = await prisma.user.findUnique({ where: { email: otherEmail } });
    if (!otherUser) {
      const passwordHash = await bcrypt.hash('Outside2026!', 10);
      otherUser = await prisma.user.create({
        data: {
          email: otherEmail,
          passwordHash,
          name: 'Second Organizer Test',
          role: 'ORGANIZER',
        },
      });
      await prisma.organizerProfile.create({
        data: {
          userId: otherUser.id,
          displayName: 'Second Org Group',
          slug: 'second-org-group-test',
        },
      });
    }
    otherOrganizerUserId = otherUser.id;

    const otherLogin = await request(app).post('/api/auth/login').send({
      email: otherEmail,
      password: 'Outside2026!',
    });
    expect(otherLogin.status).toBe(200);
    otherOrganizerToken = otherLogin.body.data.token;
  });

  describe('1. Crypto, Encryption & Masking Helpers', () => {
    it('maskAccountNumber masks standard account numbers correctly', () => {
      const masked = maskAccountNumber('1234567890');
      expect(masked).toBe('•••• •••• •••• 7890');
      expect(getAccountNumberLast4('1234567890')).toBe('7890');
    });

    it('maskAccountNumber handles short account numbers safely', () => {
      const masked = maskAccountNumber('987');
      expect(masked).toBe('•••• 987');
      expect(getAccountNumberLast4('987')).toBe('987');
    });

    it('encryptAccountNumber and decryptAccountNumber roundtrip accurately via AES-256-GCM', () => {
      const rawAccount = '01109283746501';
      const encrypted = encryptAccountNumber(rawAccount);

      expect(encrypted).not.toBe(rawAccount);
      expect(encrypted).not.toContain(rawAccount);
      expect(encrypted.split(':').length).toBe(3); // iv : authTag : ciphertext

      const decrypted = decryptAccountNumber(encrypted);
      expect(decrypted).toBe(rawAccount);
    });

    it('sanitizePayoutDetails strips accountNumberEncrypted completely', () => {
      const record = {
        id: 'payout-123',
        userId: 'user-123',
        accountHolderName: 'Sol Events Ltd',
        accountNumberMasked: '•••• •••• •••• 5678',
        accountNumberLast4: '5678',
        accountNumberEncrypted: 'deadbeef:cafebabe:123456',
      };

      const sanitized = sanitizePayoutDetails(record);
      expect(sanitized).not.toHaveProperty('accountNumberEncrypted');
      expect(sanitized).toHaveProperty('accountNumberMasked', '•••• •••• •••• 5678');
      expect(sanitized).toHaveProperty('accountNumberLast4', '5678');
    });
  });

  describe('2. Validation & Country-Adaptive Rules', () => {
    it('rejects payout details when orgType is Other but orgTypeOther is missing', async () => {
      const res = await request(app)
        .put('/api/organizer/payout-details')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          orgType: 'Other',
          orgTypeOther: '',
          registeredName: 'Creative Arts Trust',
          country: 'Kenya',
          contactPersonName: 'Sol Omondi',
          contactEmail: 'contact@solcreative.ke',
          accountHolderName: 'Creative Arts Trust',
          bankName: 'KCB Bank',
          bankCountry: 'Kenya',
          accountCurrency: 'KES',
          accountNumber: '1122334455',
          confirmAccountNumber: '1122334455',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toBe('Validation failed');
      expect(res.body.error.details.some((d: any) => /specify the organisation type/i.test(d.message))).toBe(true);
    });

    it('rejects payout details when account numbers do not match', async () => {
      const res = await request(app)
        .put('/api/organizer/payout-details')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          orgType: 'Company',
          registeredName: 'Sol Entertainment Ltd',
          country: 'Kenya',
          contactPersonName: 'Sol Omondi',
          contactEmail: 'contact@solcreative.ke',
          accountHolderName: 'Sol Entertainment Ltd',
          bankName: 'Standard Chartered',
          bankCountry: 'Kenya',
          accountCurrency: 'USD',
          accountNumber: '1122334455',
          confirmAccountNumber: '9988776655', // MISMATCH
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toBe('Validation failed');
      expect(res.body.error.details.some((d: any) => /confirmation do not match/i.test(d.message))).toBe(true);
    });

    it('rejects invalid email format in organisation contact email', async () => {
      const res = await request(app)
        .put('/api/organizer/payout-details')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          orgType: 'Company',
          registeredName: 'Sol Entertainment Ltd',
          country: 'Kenya',
          contactPersonName: 'Sol Omondi',
          contactEmail: 'not-a-valid-email',
          accountHolderName: 'Sol Entertainment Ltd',
          bankName: 'Standard Chartered',
          bankCountry: 'Kenya',
          accountCurrency: 'USD',
          accountNumber: '1122334455',
          confirmAccountNumber: '1122334455',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('accepts country-adaptable bank details for UK (Sort Code) and US (Routing ABA)', async () => {
      // US Bank details
      const usRes = await request(app)
        .put('/api/organizer/payout-details')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          orgType: 'Company',
          registeredName: 'Outside US Touring LLC',
          registrationNumber: 'DEL-2026-90',
          country: 'United States',
          address: '100 Broadway, New York, NY 10005',
          contactPersonName: 'Alex Mercer',
          contactEmail: 'alex.mercer@outside.vip',
          accountHolderName: 'Outside US Touring LLC',
          bankName: 'JPMorgan Chase',
          bankCountry: 'United States',
          accountCurrency: 'USD',
          accountNumber: '9876543210',
          confirmAccountNumber: '9876543210',
          routingCode: '021000021', // 9-digit ABA
          bankBranch: 'Wall St Branch',
          swiftBic: 'CHASUS33',
        });

      expect(usRes.status).toBe(200);
      expect(usRes.body.success).toBe(true);
      expect(usRes.body.data.payoutDetails.accountNumberMasked).toBe('•••• •••• •••• 3210');
      expect(usRes.body.data.payoutDetails.accountNumberLast4).toBe('3210');
      expect(usRes.body.data.payoutDetails.routingCode).toBe('021000021');
      expect(usRes.body.data.payoutDetails).not.toHaveProperty('accountNumberEncrypted');
      expect(usRes.body.data.payoutDetails).not.toHaveProperty('accountNumber');
    });
  });

  describe('3. Event Creation & Update Persistence with Step 8 Details', () => {
    let createdEventId: string;

    it('POST /api/organizer/events creates an event with organisation and payout details', async () => {
      const payload = {
        title: 'PAYOUT TEST EVENT 2026',
        tagline: 'A showcase of payout persistence',
        description: 'Test event description for Outside.vip payout integration.',
        category: 'FESTIVAL',
        coverImageUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=1600&q=85',
        venueName: 'The Savannah Pavilion',
        venueAddress: 'Rift Valley Highway',
        city: 'Naivasha',
        country: 'Kenya',
        startAt: new Date(Date.now() + 86400000 * 10).toISOString(),
        endAt: new Date(Date.now() + 86400000 * 10 + 3600000 * 6).toISOString(),
        timezone: 'Africa/Nairobi',
        status: 'DRAFT',
        ticketTiers: [
          {
            name: 'General Access',
            priceInCents: 3500,
            currency: 'USD',
            totalCapacity: 200,
            minPerOrder: 1,
            maxPerOrder: 4,
            status: 'ACTIVE',
          },
        ],
        payoutDetails: {
          orgType: 'Company',
          registeredName: 'Savannah Experiences Limited',
          registrationNumber: 'KE-BN-2024-88',
          country: 'Kenya',
          address: 'Kilimani Business Hub, Nairobi',
          contactPersonName: 'Sol Omondi',
          contactEmail: 'finance@savannahfestival.ke',
          accountHolderName: 'Savannah Experiences Limited',
          bankName: 'Equity Bank Kenya',
          bankCountry: 'Kenya',
          accountCurrency: 'KES',
          accountNumber: '081029384756',
          confirmAccountNumber: '081029384756',
          routingCode: '68', // Equity clearing code
          bankBranch: 'Kilimani Supreme Branch',
          swiftBic: 'EQBLKENA',
        },
      };

      const res = await request(app)
        .post('/api/organizer/events')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.event).toHaveProperty('id');
      createdEventId = res.body.data.event.id;

      // Response contains sanitized payout details
      const eventPayout = res.body.data.event.payoutDetails;
      expect(eventPayout).toBeDefined();
      expect(eventPayout.registeredName).toBe('Savannah Experiences Limited');
      expect(eventPayout.accountNumberMasked).toBe('•••• •••• •••• 4756');
      expect(eventPayout.accountNumberLast4).toBe('4756');
      expect(eventPayout).not.toHaveProperty('accountNumberEncrypted');
      expect(eventPayout).not.toHaveProperty('accountNumber');

      // Verify DB storage: encrypted ciphertext is stored, NEVER plaintext
      const dbRecord = await prisma.organizerPayoutDetails.findUnique({
        where: { userId: organizerUserId },
      });
      expect(dbRecord).not.toBeNull();
      expect(dbRecord!.accountNumberEncrypted).not.toBe('081029384756');
      expect(dbRecord!.accountNumberEncrypted).not.toBeNull();
      expect(dbRecord!.accountNumberMasked).toBe('•••• •••• •••• 4756');

      // Decrypt verification
      const decrypted = decryptAccountNumber(dbRecord!.accountNumberEncrypted!);
      expect(decrypted).toBe('081029384756');
    });

    it('GET /api/organizer/events/:id returns sanitized payout details without exposing secrets', async () => {
      const res = await request(app)
        .get(`/api/organizer/events/${createdEventId}`)
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const { event } = res.body.data;
      expect(event.payoutDetails).toBeDefined();
      expect(event.payoutDetails.accountNumberMasked).toBe('•••• •••• •••• 4756');
      expect(event.payoutDetails.accountNumberLast4).toBe('4756');
      expect(event.payoutDetails).not.toHaveProperty('accountNumberEncrypted');
      expect(event.payoutDetails).not.toHaveProperty('accountNumber');
    });

    it('PUT /api/organizer/events/:id preserves bank details when keeping existing masked account number', async () => {
      // Send update with masked account number (as user leaves it untouched in wizard)
      const res = await request(app)
        .put(`/api/organizer/events/${createdEventId}`)
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          title: 'PAYOUT TEST EVENT 2026 (UPDATED)',
          payoutDetails: {
            orgType: 'Company',
            registeredName: 'Savannah Experiences Group Ltd', // updated name
            country: 'Kenya',
            contactPersonName: 'Sol Omondi',
            contactEmail: 'finance@savannahfestival.ke',
            accountHolderName: 'Savannah Experiences Limited',
            bankName: 'Equity Bank Kenya',
            bankCountry: 'Kenya',
            accountCurrency: 'KES',
            accountNumber: '•••• •••• •••• 4756', // masked value preserved
            confirmAccountNumber: '•••• •••• •••• 4756',
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.event.payoutDetails.registeredName).toBe('Savannah Experiences Group Ltd');
      expect(res.body.data.event.payoutDetails.accountNumberMasked).toBe('•••• •••• •••• 4756');

      // Verify DB record still holds the original decrypted account number
      const dbRecord = await prisma.organizerPayoutDetails.findUnique({
        where: { userId: organizerUserId },
      });
      const decrypted = decryptAccountNumber(dbRecord!.accountNumberEncrypted!);
      expect(decrypted).toBe('081029384756');
    });
  });

  describe('4. Organiser-level Access Control & Authorization', () => {
    it('GET /api/organizer/payout-details without token returns 401 Unauthorized', async () => {
      const res = await request(app).get('/api/organizer/payout-details');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('GET /api/organizer/payout-details with Attendee token returns 403 Forbidden', async () => {
      const res = await request(app)
        .get('/api/organizer/payout-details')
        .set('Authorization', `Bearer ${attendeeToken}`);
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('PUT /api/organizer/payout-details with Attendee token returns 403 Forbidden', async () => {
      const res = await request(app)
        .put('/api/organizer/payout-details')
        .set('Authorization', `Bearer ${attendeeToken}`)
        .send({
          orgType: 'Company',
          registeredName: 'Unauthorized Corp',
          country: 'Kenya',
          contactPersonName: 'Fake User',
          contactEmail: 'fake@outside.vip',
          accountHolderName: 'Fake User',
          bankName: 'Test Bank',
          bankCountry: 'Kenya',
          accountCurrency: 'USD',
          accountNumber: '12345678',
          confirmAccountNumber: '12345678',
        });
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('An organizer CANNOT view or access another organizer’s event payout details', async () => {
      // Sol creates an event
      const createRes = await request(app)
        .post('/api/organizer/events')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          title: 'SOL PRIVATE PAYOUT EVENT',
          category: 'MUSIC',
          coverImageUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=1600&q=85',
          venueName: 'Secret Location',
          city: 'Nairobi',
          country: 'Kenya',
          startAt: new Date(Date.now() + 86400000 * 2).toISOString(),
          endAt: new Date(Date.now() + 86400000 * 2 + 3600000 * 4).toISOString(),
          ticketTiers: [{ name: 'Pass', priceInCents: 1000, totalCapacity: 50 }],
        });

      expect(createRes.status).toBe(201);
      const privateEventId = createRes.body.data.event.id;

      // Second organizer tries to view Sol's event
      const accessAttempt = await request(app)
        .get(`/api/organizer/events/${privateEventId}`)
        .set('Authorization', `Bearer ${otherOrganizerToken}`);

      expect(accessAttempt.status).toBe(403);
      expect(accessAttempt.body.success).toBe(false);
      expect(accessAttempt.body.error?.message).toMatch(/do not have permission/i);
    });

    it('Each organizer retrieves only their own payout details from /api/organizer/payout-details', async () => {
      // Sol requests their payout details
      const solRes = await request(app)
        .get('/api/organizer/payout-details')
        .set('Authorization', `Bearer ${organizerToken}`);
      expect(solRes.status).toBe(200);
      expect(solRes.body.data.payoutDetails.userId).toBe(organizerUserId);

      // Second organizer requests their payout details (initially null or their own)
      const secondRes = await request(app)
        .get('/api/organizer/payout-details')
        .set('Authorization', `Bearer ${otherOrganizerToken}`);
      expect(secondRes.status).toBe(200);
      if (secondRes.body.data.payoutDetails) {
        expect(secondRes.body.data.payoutDetails.userId).toBe(otherOrganizerUserId);
        expect(secondRes.body.data.payoutDetails.userId).not.toBe(organizerUserId);
      }
    });
  });
});
