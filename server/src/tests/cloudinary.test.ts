import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import {
  validateImageBuffer,
  generateSignedUploadParams,
  deleteCloudinaryAsset,
  isCloudinaryConfigured,
  CLOUDINARY_FOLDER,
  cloudinary,
} from '../lib/cloudinary.js';

describe('Cloudinary Integration & Event Image Flow', () => {
  let organizerToken: string;
  let attendeeToken: string;

  beforeAll(async () => {
    // 1. Authenticate seeded organizer
    const organizerLogin = await request(app).post('/api/auth/login').send({
      email: 'sol@outside.vip',
      password: 'Outside2026!',
    });
    expect(organizerLogin.status).toBe(200);
    organizerToken = organizerLogin.body.data.token;

    // 2. Authenticate seeded attendee
    const attendeeLogin = await request(app).post('/api/auth/login').send({
      email: 'alex@outside.vip',
      password: 'Outside2026!',
    });
    expect(attendeeLogin.status).toBe(200);
    attendeeToken = attendeeLogin.body.data.token;
  });

  describe('1. Buffer and Magic Bytes Validation', () => {
    it('validates authentic JPEG header (FF D8 FF)', () => {
      const validJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
      const res = validateImageBuffer(validJpeg);
      expect(res.isValid).toBe(true);
      expect(res.mimeType).toBe('image/jpeg');
    });

    it('validates authentic PNG header (89 50 4E 47 0D 0A 1A 0A)', () => {
      const validPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
      const res = validateImageBuffer(validPng);
      expect(res.isValid).toBe(true);
      expect(res.mimeType).toBe('image/png');
    });

    it('validates authentic WebP header (RIFF....WEBP)', () => {
      const validWebp = Buffer.alloc(16);
      validWebp.write('RIFF', 0, 'ascii');
      validWebp.writeUInt32LE(12, 4);
      validWebp.write('WEBP', 8, 'ascii');
      const res = validateImageBuffer(validWebp);
      expect(res.isValid).toBe(true);
      expect(res.mimeType).toBe('image/webp');
    });

    it('rejects spoofed or unpermitted files (e.g., text file or script)', () => {
      const fakeText = Buffer.from('console.log("hello world");');
      const res = validateImageBuffer(fakeText);
      expect(res.isValid).toBe(false);
      expect(res.error).toContain('Invalid image format');
    });

    it('rejects files larger than 5MB', () => {
      // 5MB + 1 byte
      const oversized = Buffer.alloc(5 * 1024 * 1024 + 1);
      oversized[0] = 0xff;
      oversized[1] = 0xd8;
      oversized[2] = 0xff;
      const res = validateImageBuffer(oversized);
      expect(res.isValid).toBe(false);
      expect(res.error).toContain('exceeds maximum allowed size of 5 MB');
    });
  });

  describe('2. Endpoint Authorization & Signature Generation', () => {
    it('POST /api/organizer/upload/sign without token returns 401', async () => {
      const res = await request(app).post('/api/organizer/upload/sign');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('POST /api/organizer/upload/sign with attendee token returns 403', async () => {
      const res = await request(app)
        .post('/api/organizer/upload/sign')
        .set('Authorization', `Bearer ${attendeeToken}`);
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('POST /api/organizer/upload without token returns 401', async () => {
      const res = await request(app).post('/api/organizer/upload');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('POST /api/organizer/upload with attendee token returns 403', async () => {
      const res = await request(app)
        .post('/api/organizer/upload')
        .set('Authorization', `Bearer ${attendeeToken}`);
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('POST /api/organizer/upload with disallowed MIME type returns 400', async () => {
      const res = await request(app)
        .post('/api/organizer/upload')
        .set('Authorization', `Bearer ${organizerToken}`)
        .attach('image', Buffer.from('fake script content'), 'script.js');
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe('3. Event Creation: Cloudinary URLs & Base64 Rejection', () => {
    it('rejects event creation when coverImageUrl is a raw Base64 data URL', async () => {
      const payload = {
        title: 'Event With Disallowed Base64',
        category: 'MUSIC',
        coverImageUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP...',
        venueName: 'Club Mirage',
        venueAddress: 'Kenyatta Ave 14',
        city: 'Nairobi',
        country: 'Kenya',
        startAt: new Date(Date.now() + 86400000 * 2).toISOString(),
        endAt: new Date(Date.now() + 86400000 * 2 + 3600000 * 4).toISOString(),
        ticketTiers: [
          {
            name: 'Standard Entry',
            priceInCents: 1500,
            totalCapacity: 100,
          },
        ],
      };

      const res = await request(app)
        .post('/api/organizer/events')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send(payload);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toBe('Validation failed');
      expect(
        res.body.error.details.some(
          (d: any) => d.field === 'coverImageUrl' && d.message.includes('Base64 image data is not permitted')
        )
      ).toBe(true);
    });

    it('successfully creates an event with a Cloudinary HTTPS URL and coverImagePublicId', async () => {
      const payload = {
        title: 'Afro-House Rooftop Showcase',
        tagline: 'Deep melodic sounds at sunset',
        description: 'Curated rooftop electronic gathering.',
        category: 'MUSIC',
        coverImageUrl: 'https://res.cloudinary.com/outside-vip/image/upload/v1729000000/outside-vip/event-covers/sample-cover.jpg',
        coverImagePublicId: 'outside-vip/event-covers/sample-cover',
        venueName: 'The Sky Deck',
        venueAddress: 'Westlands Square',
        city: 'Nairobi',
        country: 'Kenya',
        startAt: new Date(Date.now() + 86400000 * 4).toISOString(),
        endAt: new Date(Date.now() + 86400000 * 4 + 3600000 * 6).toISOString(),
        ticketTiers: [
          {
            name: 'General Admission',
            priceInCents: 2500,
            totalCapacity: 150,
          },
        ],
      };

      const res = await request(app)
        .post('/api/organizer/events')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.event.coverImageUrl).toBe(payload.coverImageUrl);
      expect(res.body.data.event.coverImagePublicId).toBe(payload.coverImagePublicId);
      expect(res.body.data.event.thumbnailUrl).toContain('c_fill,g_auto,w_600,h_400');
    });

    it('successfully creates an event with an Unsplash preset URL (null coverImagePublicId)', async () => {
      const presetUrl = 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?auto=format&fit=crop&w=1600&q=85';
      const payload = {
        title: 'Sunset Sounds Kilifi',
        category: 'FESTIVAL',
        coverImageUrl: presetUrl,
        coverImagePublicId: null,
        venueName: 'Bofa Beach',
        venueAddress: 'Bofa Road',
        city: 'Kilifi',
        country: 'Kenya',
        startAt: new Date(Date.now() + 86400000 * 10).toISOString(),
        endAt: new Date(Date.now() + 86400000 * 10 + 3600000 * 8).toISOString(),
        ticketTiers: [
          {
            name: 'Weekend Pass',
            priceInCents: 5000,
            totalCapacity: 200,
          },
        ],
      };

      const res = await request(app)
        .post('/api/organizer/events')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.event.coverImageUrl).toBe(presetUrl);
      expect(res.body.data.event.coverImagePublicId).toBeNull();
    });
  });

  describe('4. Safe Deletion and Replacement Safeguards', () => {
    it('refuses to delete assets outside the dedicated outside-vip/event-covers folder', async () => {
      // If someone attempted to delete an asset from another folder
      const result = await deleteCloudinaryAsset('unauthorized-folder/other-user-photo');
      expect(result).toBe(false);
    });

    it('refuses to delete empty, preset, or non-Cloudinary asset ids', async () => {
      expect(await deleteCloudinaryAsset(null)).toBe(false);
      expect(await deleteCloudinaryAsset(undefined)).toBe(false);
      expect(await deleteCloudinaryAsset('')).toBe(false);
      expect(await deleteCloudinaryAsset('https://images.unsplash.com/...')).toBe(false);
    });
  });
});
