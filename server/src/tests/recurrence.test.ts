import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { prisma } from '../db/prisma.js';
import { calculateOccurrences, formatOccurrenceSlugSuffix, formatRecurrenceSummary } from '../modules/events/recurrence.service.js';

describe('Recurring Events: Recurrence Calculation Service', () => {
  const baseStart = new Date('2026-11-20T20:00:00Z'); // Friday 20:00 UTC
  const baseEnd = new Date('2026-11-21T02:00:00Z');   // 6 hour duration

  it('calculates daily occurrences correctly with count', () => {
    const occurrences = calculateOccurrences({
      baseStartAt: baseStart,
      baseEndAt: baseEnd,
      timezone: 'UTC',
      rule: {
        frequency: 'DAILY',
        interval: 1,
        count: 4,
      },
    });

    expect(occurrences).toHaveLength(4);
    expect(occurrences[0].occurrenceIndex).toBe(1);
    expect(occurrences[0].startAt.toISOString()).toBe('2026-11-20T20:00:00.000Z');
    expect(occurrences[1].occurrenceIndex).toBe(2);
    expect(occurrences[1].startAt.toISOString()).toBe('2026-11-21T20:00:00.000Z');
    expect(occurrences[2].occurrenceIndex).toBe(3);
    expect(occurrences[2].startAt.toISOString()).toBe('2026-11-22T20:00:00.000Z');
    expect(occurrences[3].occurrenceIndex).toBe(4);
    expect(occurrences[3].startAt.toISOString()).toBe('2026-11-23T20:00:00.000Z');

    // Check duration is always 6 hours
    for (const occ of occurrences) {
      expect(occ.endAt.getTime() - occ.startAt.getTime()).toBe(6 * 60 * 60 * 1000);
    }
  });

  it('calculates daily occurrences with interval 2 and end date', () => {
    const occurrences = calculateOccurrences({
      baseStartAt: baseStart,
      baseEndAt: baseEnd,
      timezone: 'UTC',
      rule: {
        frequency: 'DAILY',
        interval: 2,
        endDate: '2026-11-25T23:59:59Z',
      },
    });

    // 20th, 22nd, 24th
    expect(occurrences).toHaveLength(3);
    expect(occurrences[1].startAt.toISOString()).toBe('2026-11-22T20:00:00.000Z');
    expect(occurrences[2].startAt.toISOString()).toBe('2026-11-24T20:00:00.000Z');
  });

  it('calculates weekly occurrences on specified weekday', () => {
    // 2026-11-20 is a Friday (day 5)
    const occurrences = calculateOccurrences({
      baseStartAt: baseStart,
      baseEndAt: baseEnd,
      timezone: 'UTC',
      rule: {
        frequency: 'WEEKLY',
        interval: 1,
        byWeekday: [5], // Fridays
        count: 3,
      },
    });

    expect(occurrences).toHaveLength(3);
    expect(occurrences[0].startAt.toISOString()).toBe('2026-11-20T20:00:00.000Z');
    expect(occurrences[1].startAt.toISOString()).toBe('2026-11-27T20:00:00.000Z');
    expect(occurrences[2].startAt.toISOString()).toBe('2026-12-04T20:00:00.000Z');
  });

  it('calculates weekly occurrences with bi-weekly interval (every 2 weeks)', () => {
    const occurrences = calculateOccurrences({
      baseStartAt: baseStart,
      baseEndAt: baseEnd,
      timezone: 'UTC',
      rule: {
        frequency: 'WEEKLY',
        interval: 2,
        byWeekday: [5],
        count: 3,
      },
    });

    expect(occurrences).toHaveLength(3);
    expect(occurrences[0].startAt.toISOString()).toBe('2026-11-20T20:00:00.000Z');
    expect(occurrences[1].startAt.toISOString()).toBe('2026-12-04T20:00:00.000Z');
    expect(occurrences[2].startAt.toISOString()).toBe('2026-12-18T20:00:00.000Z');
  });

  it('calculates monthly occurrences maintaining day of month', () => {
    const occurrences = calculateOccurrences({
      baseStartAt: baseStart, // Nov 20
      baseEndAt: baseEnd,
      timezone: 'UTC',
      rule: {
        frequency: 'MONTHLY',
        interval: 1,
        count: 3,
      },
    });

    expect(occurrences).toHaveLength(3);
    expect(occurrences[0].startAt.toISOString()).toBe('2026-11-20T20:00:00.000Z');
    expect(occurrences[1].startAt.toISOString()).toBe('2026-12-20T20:00:00.000Z');
    expect(occurrences[2].startAt.toISOString()).toBe('2027-01-20T20:00:00.000Z');
  });

  it('formats occurrence slug suffix and summary text', () => {
    const suffix = formatOccurrenceSlugSuffix(new Date('2026-11-20T20:00:00Z'), 'UTC');
    expect(suffix).toBe('2026-11-20');

    const summary = formatRecurrenceSummary(
      { frequency: 'WEEKLY', interval: 1, byWeekday: [5], count: 4 },
      baseStart,
      'UTC'
    );
    expect(summary).toContain('Weekly on Fridays');
    expect(summary).toContain('4 occurrences');
  });
});

describe('Recurring Events: End-to-End API Lifecycle', () => {
  let organizerToken: string;
  let createdSeriesId: string;
  let primaryEventId: string;
  let secondEventId: string;

  beforeAll(async () => {
    // Authenticate as seeded organizer (Sol Collective)
    const loginRes = await request(app).post('/api/auth/login').send({
      email: 'sol@outside.vip',
      password: 'Outside2026!',
    });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.success).toBe(true);
    organizerToken = loginRes.body.data.token;
  });

  afterAll(async () => {
    // Cleanup created test events and series
    if (createdSeriesId) {
      await prisma.event.deleteMany({ where: { seriesId: createdSeriesId } });
      await prisma.eventSeries.deleteMany({ where: { id: createdSeriesId } });
    }
  });

  it('POST /api/organizer/events creates a recurring series with occurrences and cloned ticket tiers', async () => {
    const payload = {
      title: 'Sol Sundowner Weekly Acoustic',
      description: 'Sunset acoustic sessions under the Baobab tree.',
      category: 'MUSIC',
      status: 'DRAFT',
      coverImageUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=1600&q=85',
      venueName: 'The Baobab Amphitheatre',
      venueAddress: 'Bofa Beach Road, Kilifi',
      city: 'Kilifi',
      country: 'Kenya',
      startAt: '2026-11-21T18:00:00.000Z',
      endAt: '2026-11-21T23:00:00.000Z',
      timezone: 'Africa/Nairobi',
      ageRestriction: '18+',
      dressCode: 'Coastal Minimal',
      ticketTiers: [
        {
          name: 'General Admission',
          priceInCents: 3000,
          totalCapacity: 150,
          minPerOrder: 1,
          maxPerOrder: 6,
          status: 'ACTIVE',
        },
        {
          name: 'VIP Deck',
          priceInCents: 7500,
          totalCapacity: 50,
          minPerOrder: 1,
          maxPerOrder: 4,
          status: 'ACTIVE',
        },
      ],
      recurrence: {
        frequency: 'WEEKLY',
        interval: 1,
        byWeekday: [6], // Saturdays
        count: 3,
      },
    };

    const res = await request(app)
      .post('/api/organizer/events')
      .set('Authorization', `Bearer ${organizerToken}`)
      .send(payload);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    const data = res.body.data.event;

    expect(data.title).toBe(payload.title);
    expect(data.seriesId).toBeDefined();
    expect(data.occurrenceIndex).toBe(1);
    expect(data.series).toBeDefined();
    expect(data.series.occurrencesCount).toBe(3);
    expect(data.series.occurrences).toHaveLength(3);

    createdSeriesId = data.seriesId;
    primaryEventId = data.id;
    secondEventId = data.series.occurrences[1].id;

    // Verify all 3 events exist in the database with their own ticket tiers
    const seriesEvents = await prisma.event.findMany({
      where: { seriesId: createdSeriesId },
      orderBy: { occurrenceIndex: 'asc' },
      include: { ticketTiers: true },
    });

    expect(seriesEvents).toHaveLength(3);
    expect(seriesEvents[0].occurrenceIndex).toBe(1);
    expect(seriesEvents[1].occurrenceIndex).toBe(2);
    expect(seriesEvents[2].occurrenceIndex).toBe(3);

    // Verify unique slugs per occurrence
    const slugs = seriesEvents.map((e) => e.slug);
    const uniqueSlugs = new Set(slugs);
    expect(uniqueSlugs.size).toBe(3);

    // Verify independent ticket tiers per occurrence
    for (const evt of seriesEvents) {
      expect(evt.ticketTiers).toHaveLength(2);
      expect(evt.ticketTiers[0].soldQuantity).toBe(0);
      expect(evt.ticketTiers[0].totalCapacity).toBe(150);
      expect(evt.ticketTiers[1].totalCapacity).toBe(50);
    }
  });

  it('GET /api/organizer/series/:id returns the series and occurrence list', async () => {
    const res = await request(app)
      .get(`/api/organizer/series/${createdSeriesId}`)
      .set('Authorization', `Bearer ${organizerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const series = res.body.data.series;
    expect(series.id).toBe(createdSeriesId);
    expect(series.occurrences).toHaveLength(3);
    expect(series.occurrences[0].totalCapacity).toBe(200);
  });

  it('PUT /api/organizer/events/:id edits a single occurrence without mutating the rest of the series', async () => {
    const updateRes = await request(app)
      .put(`/api/organizer/events/${secondEventId}`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({
        title: 'Sol Sundowner: Special Guest Edition',
        applyToFuture: false,
      });

    expect(updateRes.status).toBe(200);
    expect(updateRes.body.success).toBe(true);
    expect(updateRes.body.data.event.isCustomized).toBe(true);
    expect(updateRes.body.data.event.title).toBe('Sol Sundowner: Special Guest Edition');

    // Verify occurrence #1 and #3 remained unchanged
    const firstEvent = await prisma.event.findUnique({ where: { id: primaryEventId } });
    expect(firstEvent?.title).toBe('Sol Sundowner Weekly Acoustic');
    expect(firstEvent?.isCustomized).toBe(false);
  });

  it('POST /api/organizer/events/:id/cancel cancels an individual occurrence without cancelling the entire series', async () => {
    const cancelRes = await request(app)
      .post(`/api/organizer/events/${secondEventId}/cancel`)
      .set('Authorization', `Bearer ${organizerToken}`);

    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.success).toBe(true);
    expect(cancelRes.body.data.event.status).toBe('CANCELLED');

    // Verify occurrence #1 is still active
    const firstEvent = await prisma.event.findUnique({ where: { id: primaryEventId } });
    expect(firstEvent?.status).toBe('DRAFT');
  });

  it('POST /api/organizer/events/:id/publish with publishSeries publishes all occurrences in the series', async () => {
    const publishRes = await request(app)
      .post(`/api/organizer/events/${primaryEventId}/publish?publishSeries=true`)
      .set('Authorization', `Bearer ${organizerToken}`);

    expect(publishRes.status).toBe(200);
    expect(publishRes.body.success).toBe(true);

    const firstEvent = await prisma.event.findUnique({ where: { id: primaryEventId } });
    expect(firstEvent?.status).toBe('PUBLISHED');

    // The already-cancelled occurrence #2 remains CANCELLED
    const cancelledEvent = await prisma.event.findUnique({ where: { id: secondEventId } });
    expect(cancelledEvent?.status).toBe('CANCELLED');
  });

  it('GET /api/events/:slug returns the event with upcoming sister occurrences in the series', async () => {
    const firstEvent = await prisma.event.findUnique({ where: { id: primaryEventId } });
    expect(firstEvent).toBeDefined();

    const publicRes = await request(app).get(`/api/events/${firstEvent!.slug}`);
    expect(publicRes.status).toBe(200);
    expect(publicRes.body.success).toBe(true);
    expect(publicRes.body.data.event.series).toBeDefined();
    expect(Array.isArray(publicRes.body.data.event.series.events)).toBe(true);
  });

  it('POST /api/organizer/series/:id/cancel cancels future occurrences in the series preserving history', async () => {
    const seriesCancelRes = await request(app)
      .post(`/api/organizer/series/${createdSeriesId}/cancel`)
      .set('Authorization', `Bearer ${organizerToken}`);

    expect(seriesCancelRes.status).toBe(200);
    expect(seriesCancelRes.body.success).toBe(true);
    expect(seriesCancelRes.body.data.cancelledCount).toBeGreaterThanOrEqual(1);

    const firstEvent = await prisma.event.findUnique({ where: { id: primaryEventId } });
    expect(firstEvent?.status).toBe('CANCELLED');
  });
});
