import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { extractYouTubeVideoId, normalizeYouTubeUrl } from '../utils/youtube.js';
import { prisma } from '../db/prisma.js';

describe('Event Presentation & Page Configuration Features', () => {
  let organizerToken: string;
  let attendeeToken: string;
  let createdEventId: string;
  let createdEventSlug: string;
  let hiddenEventId: string;
  let hiddenEventSlug: string;
  let protectedEventId: string;
  let protectedEventSlug: string;

  beforeAll(async () => {
    // Authenticate seeded organizer
    const organizerLogin = await request(app).post('/api/auth/login').send({
      email: 'sol@outside.vip',
      password: 'Outside2026!',
    });
    expect(organizerLogin.status).toBe(200);
    organizerToken = organizerLogin.body.data.token;

    // Authenticate seeded attendee
    const attendeeLogin = await request(app).post('/api/auth/login').send({
      email: 'alex@outside.vip',
      password: 'Outside2026!',
    });
    expect(attendeeLogin.status).toBe(200);
    attendeeToken = attendeeLogin.body.data.token;
  });

  afterAll(async () => {
    // Cleanup any test events created during this test suite
    const ids = [createdEventId, hiddenEventId, protectedEventId].filter(Boolean);
    for (const id of ids) {
      try {
        const orders = await prisma.order.findMany({ where: { eventId: id }, select: { id: true } });
        const orderIds = orders.map((o) => o.id);
        if (orderIds.length > 0) {
          await prisma.ticket.deleteMany({ where: { orderId: { in: orderIds } } });
          await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
          await prisma.ticketReservation.deleteMany({ where: { orderId: { in: orderIds } } });
          await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
        }
        await prisma.ticketReservation.deleteMany({ where: { ticketTier: { eventId: id } } });
        await prisma.eventGalleryImage.deleteMany({ where: { eventId: id } });
        await prisma.eventFeature.deleteMany({ where: { eventId: id } });
        await prisma.ticketTier.deleteMany({ where: { eventId: id } });
        await prisma.event.delete({ where: { id } });
      } catch {
        // ignore if already deleted
      }
    }
  });

    // YouTube Extraction & Normalization Unit Tests
    describe('YouTube URL validation and parsing', () => {
    it('should extract 11-char video ID from standard watch URL', () => {
      expect(extractYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
      expect(normalizeYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    });

    it('should extract 11-char video ID from youtu.be short URL', () => {
      expect(extractYouTubeVideoId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
      expect(normalizeYouTubeUrl('https://youtu.be/dQw4w9WgXcQ')).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    });

    it('should extract from shorts and embed URLs', () => {
      expect(extractYouTubeVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
      expect(extractYouTubeVideoId('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
      expect(extractYouTubeVideoId('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    });

    it('should reject invalid or non-YouTube URLs', () => {
      expect(extractYouTubeVideoId('https://vimeo.com/123456789')).toBeNull();
      expect(extractYouTubeVideoId('https://spotify.com/track/12345')).toBeNull();
      expect(extractYouTubeVideoId('not-a-valid-url')).toBeNull();
      expect(extractYouTubeVideoId('https://youtube.com/watch?v=short')).toBeNull(); // Less than 11 chars
      expect(normalizeYouTubeUrl('https://malicious-site.com/video')).toBeNull();
    });
  });

    // Multiple Gallery Images & Event Features Persistence
    describe('Event Gallery Images & Event Features', () => {
    it('POST /api/organizer/events creates an event with gallery images, features, and YouTube video', async () => {
      const payload = {
        title: 'FESTIVAL OF SOUND & VISION 2026',
        tagline: 'Multi-stage audio visual celebration',
        description: 'Immerse in soundscapes, curated culinary experiences, and visual arts.',
        category: 'FESTIVAL',
        coverImageUrl: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?auto=format&fit=crop&w=1600&q=85',
        venueName: 'Sound Arena',
        venueAddress: '100 Harmonic Way',
        city: 'Nairobi',
        country: 'Kenya',
        startAt: new Date(Date.now() + 86400000 * 10).toISOString(),
        endAt: new Date(Date.now() + 86400000 * 10 + 3600000 * 6).toISOString(),
        timezone: 'Africa/Nairobi',
        status: 'DRAFT',
        showOnExplore: true,
        hideGuestCount: false,
        youtubeVideoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        galleryImages: [
          {
            imageUrl: 'https://images.unsplash.com/photo-1501386761578-eac5c94b800a',
            displayOrder: 0,
          },
          {
            imageUrl: 'https://images.unsplash.com/photo-1429962714451-bb934ecdc4ec',
            displayOrder: 1,
          },
        ],
        features: [
          {
            name: 'Kavinsky & The Synth Collective',
            type: 'PERFORMER',
            description: 'Headline electronic synthwave performance',
            imageUrl: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4',
            displayOrder: 0,
          },
          {
            name: 'Acoustic Labs Audio',
            type: 'SPONSOR',
            description: 'Official sound and staging partner',
            imageUrl: 'https://images.unsplash.com/photo-1485579149621-3123dd979885',
            displayOrder: 1,
          },
        ],
        ticketTiers: [
          {
            name: 'General Admission',
            description: 'Full day access',
            priceInCents: 3500,
            currency: 'USD',
            totalCapacity: 500,
            minPerOrder: 1,
            maxPerOrder: 6,
            status: 'ACTIVE',
          },
        ],
      };

      const res = await request(app)
        .post('/api/organizer/events')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      const ev = res.body.data.event;
      expect(ev).toHaveProperty('id');
      createdEventId = ev.id;
      createdEventSlug = ev.slug;

      expect(ev.youtubeVideoId).toBe('dQw4w9WgXcQ');
      expect(ev.youtubeVideoUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
      expect(ev.showOnExplore).toBe(true);
      expect(ev.hideGuestCount).toBe(false);
      expect(ev.galleryImages.length).toBe(2);
      expect(ev.galleryImages[0].imageUrl).toBe('https://images.unsplash.com/photo-1501386761578-eac5c94b800a');
      expect(ev.features.length).toBe(2);
      expect(ev.features[0].name).toBe('Kavinsky & The Synth Collective');
      expect(ev.features[0].type).toBe('PERFORMER');
    });

    it('GET /api/organizer/events/:id returns persisted gallery images and features in displayOrder', async () => {
      const res = await request(app)
        .get(`/api/organizer/events/${createdEventId}`)
        .set('Authorization', `Bearer ${organizerToken}`);

      expect(res.status).toBe(200);
      const ev = res.body.data.event;
      expect(ev.id).toBe(createdEventId);
      expect(ev.galleryImages.length).toBe(2);
      expect(ev.galleryImages[0].displayOrder).toBe(0);
      expect(ev.galleryImages[1].displayOrder).toBe(1);
      expect(ev.features.length).toBe(2);
      expect(ev.features[0].displayOrder).toBe(0);
      expect(ev.features[1].displayOrder).toBe(1);
    });

    it('PUT /api/organizer/events/:id updates and reorders gallery images and features', async () => {
      const updatePayload = {
        galleryImages: [
          {
            imageUrl: 'https://images.unsplash.com/photo-1429962714451-bb934ecdc4ec',
            displayOrder: 0,
          },
          {
            imageUrl: 'https://images.unsplash.com/photo-1501386761578-eac5c94b800a',
            displayOrder: 1,
          },
          {
            imageUrl: 'https://images.unsplash.com/photo-1492684223066-81342ee5ff30',
            displayOrder: 2,
          },
        ],
        features: [
          {
            name: 'Dr. Elena Vance',
            type: 'SPEAKER',
            description: 'Keynote on Spatial Audio Engineering',
            displayOrder: 0,
          },
        ],
        youtubeVideoUrl: 'https://youtu.be/jNQXAC9IVRw',
      };

      const res = await request(app)
        .put(`/api/organizer/events/${createdEventId}`)
        .set('Authorization', `Bearer ${organizerToken}`)
        .send(updatePayload);

      expect(res.status).toBe(200);
      const ev = res.body.data.event;
      expect(ev.galleryImages.length).toBe(3);
      expect(ev.galleryImages[0].imageUrl).toBe('https://images.unsplash.com/photo-1429962714451-bb934ecdc4ec');
      expect(ev.features.length).toBe(1);
      expect(ev.features[0].name).toBe('Dr. Elena Vance');
      expect(ev.features[0].type).toBe('SPEAKER');
      expect(ev.youtubeVideoId).toBe('jNQXAC9IVRw');
    });

    it('organizer cannot modify event owned by another user', async () => {
      // attendee attempts to update event
      const res = await request(app)
        .put(`/api/organizer/events/${createdEventId}`)
        .set('Authorization', `Bearer ${attendeeToken}`)
        .send({ title: 'Hacked Title' });

      expect(res.status).toBe(403);
    });
  });

    // Explore Visibility (showOnExplore)
    describe('Page settings: Explore visibility (showOnExplore)', () => {
    it('creates an event with showOnExplore=false and publishes it', async () => {
      const res = await request(app)
        .post('/api/organizer/events')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          title: 'SECRET PRIVATE CLUB NIGHT',
          tagline: 'Private underground gathering',
          description: 'Access by direct invite link only.',
          category: 'NIGHTLIFE',
          coverImageUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819',
          venueName: 'The Vault',
          venueAddress: 'Secret Alleyway 7',
          city: 'Nairobi',
          country: 'Kenya',
          startAt: new Date(Date.now() + 86400000 * 7).toISOString(),
          endAt: new Date(Date.now() + 86400000 * 7 + 3600000 * 5).toISOString(),
          timezone: 'Africa/Nairobi',
          status: 'DRAFT',
          showOnExplore: false,
          ticketTiers: [
            {
              name: 'Secret Pass',
              priceInCents: 5000,
              currency: 'USD',
              totalCapacity: 50,
              minPerOrder: 1,
              maxPerOrder: 2,
              status: 'ACTIVE',
            },
          ],
        });

      expect(res.status).toBe(201);
      hiddenEventId = res.body.data.event.id;
      hiddenEventSlug = res.body.data.event.slug;

      // Publish the secret event
      const pubRes = await request(app)
        .post(`/api/organizer/events/${hiddenEventId}/publish`)
        .set('Authorization', `Bearer ${organizerToken}`);
      expect(pubRes.status).toBe(200);
      expect(pubRes.body.data.event.status).toBe('PUBLISHED');
      expect(pubRes.body.data.event.showOnExplore).toBe(false);
    });

    it('hidden event does NOT appear in public explore listing /api/events', async () => {
      const res = await request(app).get('/api/events?search=SECRET+PRIVATE');
      expect(res.status).toBe(200);
      const events = res.body.data.events;
      const found = events.some((e: any) => e.id === hiddenEventId);
      expect(found).toBe(false);
    });

    it('hidden event does NOT appear in /api/events/featured', async () => {
      const res = await request(app).get('/api/events/featured');
      expect(res.status).toBe(200);
      const featured = res.body.data.events;
      const found = featured.some((e: any) => e.id === hiddenEventId);
      expect(found).toBe(false);
    });

    it('hidden event IS still directly accessible via /api/events/:slug', async () => {
      const res = await request(app).get(`/api/events/${hiddenEventSlug}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.event.id).toBe(hiddenEventId);
      expect(res.body.data.event.title).toBe('SECRET PRIVATE CLUB NIGHT');
      expect(res.body.data.event.showOnExplore).toBe(false);
    });
  });

    // Guestlist and Attendee-Count Privacy (hideGuestCount)
    describe('Guestlist and attendee-count privacy (hideGuestCount)', () => {
    it('returns calculated guestCount when hideGuestCount is false', async () => {
      // Publish the first event which has hideGuestCount: false
      const pubRes = await request(app)
        .post(`/api/organizer/events/${createdEventId}/publish`)
        .set('Authorization', `Bearer ${organizerToken}`);
      expect(pubRes.status).toBe(200);

      const res = await request(app).get(`/api/events/${createdEventSlug}`);
      expect(res.status).toBe(200);
      expect(res.body.data.event.hideGuestCount).toBe(false);
      expect(typeof res.body.data.event.guestCount).toBe('number');
      // No attendee personal information (emails, names, orders, tokens) is returned
      expect(res.body.data.event).not.toHaveProperty('attendees');
      expect(res.body.data.event).not.toHaveProperty('tickets');
      expect(res.body.data.event).not.toHaveProperty('orders');
    });

    it('returns null guestCount when hideGuestCount is true', async () => {
      // Update the event to hideGuestCount = true
      const updateRes = await request(app)
        .put(`/api/organizer/events/${createdEventId}`)
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({ hideGuestCount: true });
      expect(updateRes.status).toBe(200);
      expect(updateRes.body.data.event.hideGuestCount).toBe(true);

      const res = await request(app).get(`/api/events/${createdEventSlug}`);
      expect(res.status).toBe(200);
      expect(res.body.data.event.hideGuestCount).toBe(true);
      expect(res.body.data.event.guestCount).toBeNull();
    });
  });

    // Password-Protected Events
    describe('Password-protected events enforcement', () => {
    it('creates a password-protected event with bcrypt hash and never leaks hash', async () => {
      const res = await request(app)
        .post('/api/organizer/events')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          title: 'VIP ROOFTOP MASQUERADE 2026',
          tagline: 'Masks mandatory, password required',
          description: 'A classified society gathering with secret performances and vintage champagne.',
          category: 'NIGHTLIFE',
          coverImageUrl: 'https://images.unsplash.com/photo-1516450360452-9312f5e86fc7',
          venueName: 'Penthouse 54',
          venueAddress: 'Private Residence, 54th Floor',
          city: 'Nairobi',
          country: 'Kenya',
          startAt: new Date(Date.now() + 86400000 * 12).toISOString(),
          endAt: new Date(Date.now() + 86400000 * 12 + 3600000 * 4).toISOString(),
          timezone: 'Africa/Nairobi',
          status: 'DRAFT',
          isPasswordProtected: true,
          password: 'VipAccess2026!',
          features: [
            {
              name: 'Secret Mystery DJ',
              type: 'PERFORMER',
              displayOrder: 0,
            },
          ],
          galleryImages: [
            {
              imageUrl: 'https://images.unsplash.com/photo-1516450360452-9312f5e86fc7',
              caption: 'Penthouse View',
              displayOrder: 0,
            },
          ],
          ticketTiers: [
            {
              name: 'Secret VIP Mask Pass',
              priceInCents: 15000,
              currency: 'USD',
              totalCapacity: 30,
              minPerOrder: 1,
              maxPerOrder: 2,
              status: 'ACTIVE',
            },
          ],
        });

      expect(res.status).toBe(201);
      const ev = res.body.data.event;
      protectedEventId = ev.id;
      protectedEventSlug = ev.slug;

      expect(ev.isPasswordProtected).toBe(true);
      // NEVER leak passwordHash
      expect(ev).not.toHaveProperty('passwordHash');

      // Publish the event
      await request(app)
        .post(`/api/organizer/events/${protectedEventId}/publish`)
        .set('Authorization', `Bearer ${organizerToken}`);
    });

    it('unauthenticated GET /api/events/:slug returns teaser locking sensitive details', async () => {
      const res = await request(app).get(`/api/events/${protectedEventSlug}`);
      expect(res.status).toBe(200);
      const ev = res.body.data.event;

      expect(ev.isPasswordProtected).toBe(true);
      expect(ev.isLocked).toBe(true);
      // Public teaser keeps title and city
      expect(ev.title).toBe('VIP ROOFTOP MASQUERADE 2026');
      expect(ev.city).toBe('Nairobi');
      // Sanitizes protected details:
      expect(ev.description).toBeNull();
      expect(ev.venueAddress).toBeNull();
      expect(ev.ticketTiers).toEqual([]);
      expect(ev.features).toEqual([]);
      expect(ev.galleryImages).toEqual([]);
      expect(ev.youtubeVideoId).toBeNull();
      expect(ev).not.toHaveProperty('passwordHash');
    });

    it('POST /api/events/:slug/verify-password rejects invalid password', async () => {
      const res = await request(app)
        .post(`/api/events/${protectedEventSlug}/verify-password`)
        .send({ password: 'WrongPassword123' });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain('Incorrect password');
    });

    it('POST /api/events/:slug/verify-password enforces rate limit after 5 failed attempts (429)', async () => {
      // We already had 1 failure. Let's do 4 more to hit 5, then the 6th should trigger 429
      for (let i = 0; i < 4; i++) {
        await request(app)
          .post(`/api/events/${protectedEventSlug}/verify-password`)
          .send({ password: 'WrongPasswordAgain' });
      }

      // 6th attempt should be blocked by rate limiter
      const blockedRes = await request(app)
        .post(`/api/events/${protectedEventSlug}/verify-password`)
        .send({ password: 'WrongPasswordAgain' });

      expect(blockedRes.status).toBe(429);
      expect(blockedRes.error).toBeDefined();
      expect(blockedRes.body.error.message).toContain('Too many incorrect password attempts');
    });

    it('POST /api/events/:slug/verify-password succeeds with correct password on fresh event', async () => {
      // Create a fresh password-protected event to verify token issuance cleanly
      const freshRes = await request(app)
        .post('/api/organizer/events')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          title: 'EXCLUSIVE GALA 2026',
          category: 'COMMUNITY',
          coverImageUrl: 'https://images.unsplash.com/photo-1516450360452-9312f5e86fc7',
          venueName: 'Grand Ballroom',
          venueAddress: '100 Royalty Boulevard',
          city: 'Nairobi',
          country: 'Kenya',
          startAt: new Date(Date.now() + 86400000 * 15).toISOString(),
          endAt: new Date(Date.now() + 86400000 * 15 + 3600000 * 3).toISOString(),
          timezone: 'Africa/Nairobi',
          status: 'PUBLISHED',
          isPasswordProtected: true,
          password: 'SecretPasscode2026!',
          description: 'This is private description that should be unlocked.',
          ticketTiers: [
            {
              name: 'Gala Seat',
              priceInCents: 10000,
              currency: 'USD',
              totalCapacity: 50,
              minPerOrder: 1,
              maxPerOrder: 2,
              status: 'ACTIVE',
            },
          ],
        });

      const freshEvent = freshRes.body.data.event;
      const freshSlug = freshEvent.slug;

      try {
        const verifyRes = await request(app)
          .post(`/api/events/${freshSlug}/verify-password`)
          .send({ password: 'SecretPasscode2026!' });

        expect(verifyRes.status).toBe(200);
        expect(verifyRes.body.success).toBe(true);
        expect(verifyRes.body.data).toHaveProperty('eventAccessToken');
        const token = verifyRes.body.data.eventAccessToken;

        // Access the event using the eventAccessToken header
        const unlockedRes = await request(app)
          .get(`/api/events/${freshSlug}`)
          .set('x-event-access-token', token);

        expect(unlockedRes.status).toBe(200);
        const unlockedEvent = unlockedRes.body.data.event;
        expect(unlockedEvent.isLocked).toBe(false);
        expect(unlockedEvent.description).toBe('This is private description that should be unlocked.');
        expect(unlockedEvent.venueAddress).toBe('100 Royalty Boulevard');
        expect(unlockedEvent.ticketTiers.length).toBe(1);
        expect(unlockedEvent.ticketTiers[0].name).toBe('Gala Seat');

        // Verify checkout session creation requires eventAccessToken for password protected events
        const tierId = unlockedEvent.ticketTiers[0].id;
        const failedCheckout = await request(app)
          .post('/api/checkout/create-session')
          .send({
            eventId: freshEvent.id,
            items: [{ ticketTierId: tierId, quantity: 1 }],
            customerEmail: 'guest@outside.vip',
            customerName: 'VIP Guest',
          });

        expect(failedCheckout.status).toBe(403);
        expect(failedCheckout.body.error.message).toContain('password protected');

        // With valid eventAccessToken, checkout passes the gate
        const okCheckout = await request(app)
          .post('/api/checkout/create-session')
          .send({
            eventId: freshEvent.id,
            items: [{ ticketTierId: tierId, quantity: 1 }],
            customerEmail: 'guest@outside.vip',
            customerName: 'VIP Guest',
            eventAccessToken: token,
          });

        // Either creates session (201) or fails later in stripe mock if unconfigured, but NOT 403
        expect(okCheckout.status).not.toBe(403);
      } finally {
        try {
          const orders = await prisma.order.findMany({ where: { eventId: freshEvent.id }, select: { id: true } });
          const orderIds = orders.map((o) => o.id);
          if (orderIds.length > 0) {
            await prisma.ticket.deleteMany({ where: { orderId: { in: orderIds } } });
            await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
            await prisma.ticketReservation.deleteMany({ where: { orderId: { in: orderIds } } });
            await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
          }
          await prisma.ticketReservation.deleteMany({ where: { ticketTier: { eventId: freshEvent.id } } });
          await prisma.ticketTier.deleteMany({ where: { eventId: freshEvent.id } });
          await prisma.event.delete({ where: { id: freshEvent.id } });
        } catch {
          // ignore cleanup errors
        }
      }
    });
  });
});
