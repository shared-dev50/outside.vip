import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';

describe('Outside.vip Organizer API & Event Management', () => {
  let organizerToken: string;
  let attendeeToken: string;
  let createdEventId: string;

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

  it('GET /api/organizer/dashboard without token should return 401 Unauthorized', async () => {
    const res = await request(app).get('/api/organizer/dashboard');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('GET /api/organizer/dashboard with attendee token should return 403 Forbidden', async () => {
    const res = await request(app)
      .get('/api/organizer/dashboard')
      .set('Authorization', `Bearer ${attendeeToken}`);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('GET /api/organizer/dashboard with organizer token should return actual metrics', async () => {
    const res = await request(app)
      .get('/api/organizer/dashboard')
      .set('Authorization', `Bearer ${organizerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('totalEvents');
    expect(res.body.data).toHaveProperty('publishedEvents');
    expect(res.body.data).toHaveProperty('draftEvents');
    expect(res.body.data).toHaveProperty('ticketsSold');
    expect(res.body.data).toHaveProperty('grossRevenueInCents');
    expect(res.body.data.totalEvents).toBeGreaterThan(0);
  });

  it('GET /api/organizer/events should return events owned by the organizer', async () => {
    const res = await request(app)
      .get('/api/organizer/events')
      .set('Authorization', `Bearer ${organizerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.events)).toBe(true);
    expect(res.body.data.events.length).toBeGreaterThan(0);

    const first = res.body.data.events[0];
    expect(first).toHaveProperty('id');
    expect(first).toHaveProperty('title');
    expect(first).toHaveProperty('status');
    expect(first).toHaveProperty('ticketsSold');
    expect(first).toHaveProperty('totalCapacity');
  });

  it('POST /api/organizer/events should create a new event draft with ticket tiers', async () => {
    const newEventPayload = {
      title: 'TEST RETRO RAVE 2026',
      tagline: 'Underground electronic session in an abandoned silo',
      description: 'An immersive 12-hour sonic journey featuring modular synth live performances.',
      category: 'NIGHTLIFE',
      coverImageUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=1600&q=85',
      venueName: 'The Concrete Silo',
      venueAddress: 'Factory Road 12',
      city: 'Nairobi',
      country: 'Kenya',
      startAt: new Date(Date.now() + 86400000 * 5).toISOString(),
      endAt: new Date(Date.now() + 86400000 * 5 + 3600000 * 8).toISOString(),
      timezone: 'Africa/Nairobi',
      ageRestriction: '21+',
      dressCode: 'All Black Minimal',
      status: 'DRAFT',
      ticketTiers: [
        {
          name: 'Early Bird Pass',
          description: 'Access before 10 PM',
          priceInCents: 2000,
          currency: 'USD',
          totalCapacity: 100,
          minPerOrder: 1,
          maxPerOrder: 4,
          status: 'ACTIVE',
        },
        {
          name: 'VIP Deck',
          description: 'Includes 1 welcome drink',
          priceInCents: 6000,
          currency: 'USD',
          totalCapacity: 50,
          minPerOrder: 1,
          maxPerOrder: 2,
          status: 'ACTIVE',
        },
      ],
    };

    const res = await request(app)
      .post('/api/organizer/events')
      .set('Authorization', `Bearer ${organizerToken}`)
      .send(newEventPayload);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.event).toHaveProperty('id');
    expect(res.body.data.event.status).toBe('DRAFT');
    expect(res.body.data.event.ticketTiers.length).toBe(2);
    expect(res.body.data.event.slug).toContain('test-retro-rave-2026');

    createdEventId = res.body.data.event.id;
  });

  it('GET /api/organizer/events/:id should return full draft event for editing', async () => {
    const res = await request(app)
      .get(`/api/organizer/events/${createdEventId}`)
      .set('Authorization', `Bearer ${organizerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.event.id).toBe(createdEventId);
    expect(res.body.data.event.title).toBe('TEST RETRO RAVE 2026');
    expect(res.body.data.event.ticketTiers.length).toBe(2);
  });

  it('PUT /api/organizer/events/:id should update event details and tiers', async () => {
    const res = await request(app)
      .put(`/api/organizer/events/${createdEventId}`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({
        title: 'TEST RETRO RAVE 2026 (REVISED)',
        tagline: 'Updated atmospheric description',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.event.title).toBe('TEST RETRO RAVE 2026 (REVISED)');
    expect(res.body.data.event.tagline).toBe('Updated atmospheric description');
  });

  it('POST /api/organizer/events/:id/publish should validate and publish the event', async () => {
    const res = await request(app)
      .post(`/api/organizer/events/${createdEventId}/publish`)
      .set('Authorization', `Bearer ${organizerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.event.status).toBe('PUBLISHED');

    // Verify it is now visible in public event discovery
    const publicList = await request(app).get('/api/events?search=REVISED');
    expect(publicList.status).toBe(200);
    expect(publicList.body.data.events.some((e: any) => e.id === createdEventId)).toBe(true);
  });

  it('POST /api/organizer/events/:id/unpublish should revert event to DRAFT', async () => {
    const res = await request(app)
      .post(`/api/organizer/events/${createdEventId}/unpublish`)
      .set('Authorization', `Bearer ${organizerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.event.status).toBe('DRAFT');

    // Verify it is now HIDDEN from public event discovery
    const publicList = await request(app).get('/api/events?search=REVISED');
    expect(publicList.status).toBe(200);
    expect(publicList.body.data.events.some((e: any) => e.id === createdEventId)).toBe(false);
  });

  it('DELETE /api/organizer/events/:id should remove draft event with no orders', async () => {
    const res = await request(app)
      .delete(`/api/organizer/events/${createdEventId}`)
      .set('Authorization', `Bearer ${organizerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Verify it no longer exists
    const check = await request(app)
      .get(`/api/organizer/events/${createdEventId}`)
      .set('Authorization', `Bearer ${organizerToken}`);
    expect(check.status).toBe(404);
  });
});
