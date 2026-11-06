import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { prisma } from '../db/prisma.js';
import { EventStatus, TicketTierStatus } from '@prisma/client';

describe('Today Event Filter Timezone & Midnight Regression Suite', () => {
  const organizerId = 'org-today-filter-tester';
  const createdEventIds: string[] = [];

  // Helper to create test events
  async function createTestEvent(params: {
    title: string;
    startAt: Date;
    endAt: Date;
    timezone: string;
    city?: string;
  }) {
    const unique = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const event = await prisma.event.create({
      data: {
        id: `evt-today-${unique}`,
        organizerId,
        title: params.title,
        slug: `slug-today-${unique}`,
        description: 'Test event for timezone today filter',
        category: 'MUSIC',
        timezone: params.timezone,
        startAt: params.startAt,
        endAt: params.endAt,
        status: EventStatus.PUBLISHED,
        showOnExplore: true,
        venueName: 'Test Venue',
        venueAddress: '123 Test Street',
        city: params.city || 'Nairobi',
        country: 'Kenya',
        coverImageUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819',
      },
    });

    createdEventIds.push(event.id);

    await prisma.ticketTier.create({
      data: {
        eventId: event.id,
        name: 'General Admission',
        priceInCents: 2000,
        currency: 'USD',
        totalCapacity: 100,
        reservedQuantity: 0,
        soldQuantity: 0,
        status: TicketTierStatus.ACTIVE,
      },
    });

    return event;
  }

  beforeAll(async () => {
    let org = await prisma.user.findUnique({ where: { id: organizerId } });
    if (!org) {
      await prisma.user.create({
        data: {
          id: organizerId,
          email: 'org-today-test@outside.vip',
          passwordHash: 'dummy',
          name: 'Today Filter Tester',
          role: 'ORGANIZER',
        },
      });
    }
  }, 30000);

  afterAll(async () => {
    if (createdEventIds.length > 0) {
      await prisma.ticketTier.deleteMany({ where: { eventId: { in: createdEventIds } } }).catch(() => {});
      await prisma.event.deleteMany({ where: { id: { in: createdEventIds } } }).catch(() => {});
    }
  }, 30000);

  // --------------------------------------------------------------------------
  // Test 1: Event shortly after midnight in Nairobi (00:03 AM on Nov 7)
  // --------------------------------------------------------------------------
  it('1. Event shortly after midnight in Nairobi does not appear on Nov 6, but appears on Nov 7', async () => {
    // 00:03 AM to 10:03 AM on Nov 7 in Nairobi (UTC+3) => 21:03 on Nov 6 to 07:03 on Nov 7 UTC
    const event = await createTestEvent({
      title: 'Post-Midnight Nairobi Concert',
      startAt: new Date('2026-11-06T21:03:00.000Z'),
      endAt: new Date('2026-11-07T07:03:00.000Z'),
      timezone: 'Africa/Nairobi',
    });

    // Case A: Nov 6 at 23:59:00 Nairobi time (20:59 UTC) -> Must NOT appear
    const resNov6 = await request(app)
      .get('/api/events?timeFilter=today&sortBy=date_asc')
      .set('x-simulated-now', '2026-11-06T20:59:00.000Z');
    expect(resNov6.status).toBe(200);
    const inNov6 = resNov6.body.data.events.some((e: any) => e.id === event.id);
    expect(inNov6).toBe(false);

    // Case B: Nov 7 at 00:00:01 Nairobi time (21:00:01 UTC) -> MUST appear
    const resNov7Midnight = await request(app)
      .get('/api/events?timeFilter=today&sortBy=date_asc')
      .set('x-simulated-now', '2026-11-06T21:00:01.000Z');
    expect(resNov7Midnight.status).toBe(200);
    const inNov7Midnight = resNov7Midnight.body.data.events.some((e: any) => e.id === event.id);
    expect(inNov7Midnight).toBe(true);

    // Case C: Nov 7 at 00:03:00 Nairobi time (21:03:00 UTC) -> MUST appear
    const resNov7Start = await request(app)
      .get('/api/events?timeFilter=today&sortBy=date_asc')
      .set('x-simulated-now', '2026-11-06T21:03:00.000Z');
    expect(resNov7Start.status).toBe(200);
    const inNov7Start = resNov7Start.body.data.events.some((e: any) => e.id === event.id);
    expect(inNov7Start).toBe(true);

    // Case D: Nov 8 at 00:00:01 Nairobi time (21:00:01 Nov 7 UTC) -> Must NOT appear
    const resNov8 = await request(app)
      .get('/api/events?timeFilter=today&sortBy=date_asc')
      .set('x-simulated-now', '2026-11-07T21:00:01.000Z');
    expect(resNov8.status).toBe(200);
    const inNov8 = resNov8.body.data.events.some((e: any) => e.id === event.id);
    expect(inNov8).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Test 2: Event shortly before midnight in Nairobi (21:00 to 23:55 on Nov 6)
  // --------------------------------------------------------------------------
  it('2. Event shortly before midnight in Nairobi appears on Nov 6, but does not appear on Nov 7', async () => {
    // 21:00 to 23:55 on Nov 6 in Nairobi => 18:00 to 20:55 UTC on Nov 6
    const event = await createTestEvent({
      title: 'Late Evening Nairobi Showcase',
      startAt: new Date('2026-11-06T18:00:00.000Z'),
      endAt: new Date('2026-11-06T20:55:00.000Z'),
      timezone: 'Africa/Nairobi',
    });

    // Case A: Nov 6 at 22:00 Nairobi (19:00 UTC) -> MUST appear
    const resNov6 = await request(app)
      .get('/api/events?timeFilter=today&sortBy=date_asc')
      .set('x-simulated-now', '2026-11-06T19:00:00.000Z');
    expect(resNov6.status).toBe(200);
    const inNov6 = resNov6.body.data.events.some((e: any) => e.id === event.id);
    expect(inNov6).toBe(true);

    // Case B: Nov 7 at 00:00:01 Nairobi (21:00:01 UTC) -> Must NOT appear
    const resNov7 = await request(app)
      .get('/api/events?timeFilter=today&sortBy=date_asc')
      .set('x-simulated-now', '2026-11-06T21:00:01.000Z');
    expect(resNov7.status).toBe(200);
    const inNov7 = resNov7.body.data.events.some((e: any) => e.id === event.id);
    expect(inNov7).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Test 3: Events spanning midnight in Nairobi (22:00 Nov 6 to 04:00 Nov 7)
  // --------------------------------------------------------------------------
  it('3. Event spanning midnight appears under both overlapping local calendar days', async () => {
    // 22:00 Nov 6 to 04:00 Nov 7 in Nairobi => 19:00 Nov 6 to 01:00 Nov 7 UTC
    const event = await createTestEvent({
      title: 'Midnight Crossing Warehouse Party',
      startAt: new Date('2026-11-06T19:00:00.000Z'),
      endAt: new Date('2026-11-07T01:00:00.000Z'),
      timezone: 'Africa/Nairobi',
    });

    // Case A: During Friday night (Nov 6 at 23:00 Nairobi / 20:00 UTC) -> MUST appear
    const resFriday = await request(app)
      .get('/api/events?timeFilter=today&sortBy=date_asc')
      .set('x-simulated-now', '2026-11-06T20:00:00.000Z');
    expect(resFriday.status).toBe(200);
    expect(resFriday.body.data.events.some((e: any) => e.id === event.id)).toBe(true);

    // Case B: During Saturday early morning (Nov 7 at 02:00 Nairobi / 23:00 Nov 6 UTC) -> MUST appear
    const resSaturday = await request(app)
      .get('/api/events?timeFilter=today&sortBy=date_asc')
      .set('x-simulated-now', '2026-11-06T23:00:00.000Z');
    expect(resSaturday.status).toBe(200);
    expect(resSaturday.body.data.events.some((e: any) => e.id === event.id)).toBe(true);

    // Case C: After event ended (Nov 7 at 12:00 Nairobi / 09:00 UTC) -> Still Nov 7 local day, should overlap Nov 7!
    const resSaturdayAfternoon = await request(app)
      .get('/api/events?timeFilter=today&sortBy=date_asc')
      .set('x-simulated-now', '2026-11-07T09:00:00.000Z');
    expect(resSaturdayAfternoon.status).toBe(200);
    expect(resSaturdayAfternoon.body.data.events.some((e: any) => e.id === event.id)).toBe(true);

    // Case D: Next calendar day (Nov 8 at 10:00 Nairobi / 07:00 UTC) -> Must NOT appear
    const resSunday = await request(app)
      .get('/api/events?timeFilter=today&sortBy=date_asc')
      .set('x-simulated-now', '2026-11-08T07:00:00.000Z');
    expect(resSunday.status).toBe(200);
    expect(resSunday.body.data.events.some((e: any) => e.id === event.id)).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Test 4: Events in DST-observing timezone (America/New_York)
  // --------------------------------------------------------------------------
  it('4. Correctly handles DST transition in America/New_York on Nov 1, 2026', async () => {
    // Nov 1, 2026 is US fall-back DST transition (2:00 AM EDT -> 1:00 AM EST)
    // Event: 01:30 EDT to 04:30 EST on Nov 1 => 05:30 UTC to 09:30 UTC
    const event = await createTestEvent({
      title: 'New York Fall Back Nightclub Session',
      startAt: new Date('2026-11-01T05:30:00.000Z'),
      endAt: new Date('2026-11-01T09:30:00.000Z'),
      timezone: 'America/New_York',
      city: 'New York',
    });

    // Case A: Oct 31 at 20:00 EDT (00:00 Nov 1 UTC) -> Must NOT appear
    const resOct31 = await request(app)
      .get('/api/events?timeFilter=today&sortBy=date_asc')
      .set('x-simulated-now', '2026-11-01T00:00:00.000Z');
    expect(resOct31.status).toBe(200);
    expect(resOct31.body.data.events.some((e: any) => e.id === event.id)).toBe(false);

    // Case B: Nov 1 at 12:00 EST (17:00 UTC) -> MUST appear
    const resNov1 = await request(app)
      .get('/api/events?timeFilter=today&sortBy=date_asc')
      .set('x-simulated-now', '2026-11-01T17:00:00.000Z');
    expect(resNov1.status).toBe(200);
    expect(resNov1.body.data.events.some((e: any) => e.id === event.id)).toBe(true);

    // Case C: Nov 2 at 12:00 EST (17:00 UTC) -> Must NOT appear
    const resNov2 = await request(app)
      .get('/api/events?timeFilter=today&sortBy=date_asc')
      .set('x-simulated-now', '2026-11-02T17:00:00.000Z');
    expect(resNov2.status).toBe(200);
    expect(resNov2.body.data.events.some((e: any) => e.id === event.id)).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Test 5: Events whose UTC date differs from local calendar date (America/Los_Angeles)
  // --------------------------------------------------------------------------
  it('5. Event whose UTC date differs from local date classifies by authoritative local date', async () => {
    // Event is Friday Nov 6 from 19:00 to 23:00 PST in America/Los_Angeles (UTC-8)
    // In UTC, this is Saturday Nov 7 from 03:00 to 07:00 UTC!
    const event = await createTestEvent({
      title: 'Los Angeles Friday Night Live',
      startAt: new Date('2026-11-07T03:00:00.000Z'),
      endAt: new Date('2026-11-07T07:00:00.000Z'),
      timezone: 'America/Los_Angeles',
      city: 'Los Angeles',
    });

    // Case A: When it is Friday 20:00 PST in Los Angeles (Nov 7 04:00 UTC) -> MUST appear in today!
    const resFridayLA = await request(app)
      .get('/api/events?timeFilter=today&sortBy=date_asc')
      .set('x-simulated-now', '2026-11-07T04:00:00.000Z');
    expect(resFridayLA.status).toBe(200);
    expect(resFridayLA.body.data.events.some((e: any) => e.id === event.id)).toBe(true);

    // Case B: When it is Saturday 20:00 PST in Los Angeles (Nov 8 04:00 UTC) -> Must NOT appear in today!
    const resSaturdayLA = await request(app)
      .get('/api/events?timeFilter=today&sortBy=date_asc')
      .set('x-simulated-now', '2026-11-08T04:00:00.000Z');
    expect(resSaturdayLA.status).toBe(200);
    expect(resSaturdayLA.body.data.events.some((e: any) => e.id === event.id)).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Test 6: Invalid timezone fallback to UTC
  // --------------------------------------------------------------------------
  it('6. Event with invalid timezone safely falls back to UTC without throwing error', async () => {
    // Event with invalid timezone: starts Nov 10 at 12:00 UTC, ends Nov 10 at 16:00 UTC
    const event = await createTestEvent({
      title: 'Unknown Timezone Fallback Event',
      startAt: new Date('2026-11-10T12:00:00.000Z'),
      endAt: new Date('2026-11-10T16:00:00.000Z'),
      timezone: 'Invalid/NonExistent_Zone',
    });

    // On Nov 10 14:00 UTC -> Evaluates safely as UTC today
    const resNov10 = await request(app)
      .get('/api/events?timeFilter=today&sortBy=date_asc')
      .set('x-simulated-now', '2026-11-10T14:00:00.000Z');
    expect(resNov10.status).toBe(200);
    expect(resNov10.body.data.events.some((e: any) => e.id === event.id)).toBe(true);

    // On Nov 11 14:00 UTC -> Does not match
    const resNov11 = await request(app)
      .get('/api/events?timeFilter=today&sortBy=date_asc')
      .set('x-simulated-now', '2026-11-11T14:00:00.000Z');
    expect(resNov11.status).toBe(200);
    expect(resNov11.body.data.events.some((e: any) => e.id === event.id)).toBe(false);
  });
});
