import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';
import {
  verifyAndNormalizeLocation,
  getAutocompleteSuggestions,
  getPlaceDetails,
  isGooglePlacesConfigured,
} from '../modules/places/places.service.js';
import { inferTimezoneFromLocation } from '../utils/timezone.js';

describe('Google Places API & Location Selection Module', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init?: any) => {
      const urlStr = String(url);
      if (urlStr.includes('places.googleapis.com')) {
        if (urlStr.includes('places:autocomplete')) {
          return new Response(
            JSON.stringify({
              suggestions: [
                {
                  placePrediction: {
                    placeId: 'ChIJg_k_places_test_123',
                    text: { text: 'The Alchemist, Parklands Road, Nairobi, Kenya' },
                    structuredFormat: {
                      mainText: { text: 'The Alchemist' },
                      secondaryText: { text: 'Parklands Road, Nairobi, Kenya' },
                    },
                  },
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (urlStr.includes('places/')) {
          const isRooftop = urlStr.includes('rooftop');
          return new Response(
            JSON.stringify({
              displayName: { text: isRooftop ? 'K1 Klub House Rooftop' : 'The Alchemist Bar' },
              formattedAddress: isRooftop ? 'Ojijo Road, Parklands' : 'Parklands Road, Westlands, Nairobi, Kenya',
              location: isRooftop ? { latitude: -1.2655, longitude: 36.8122 } : { latitude: -1.2618, longitude: 36.8045 },
              addressComponents: [
                { longText: 'Nairobi', types: ['locality'] },
                { longText: 'Kenya', shortText: 'KE', types: ['country'] },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
      }
      return originalFetch(url, init);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('1. Places Service & Verification', () => {
    it('returns configured=false when no API key is set', () => {
      const savedKey = env.GOOGLE_PLACES_API_KEY;
      const savedMapsKey = env.GOOGLE_MAPS_API_KEY;
      try {
        (env as any).GOOGLE_PLACES_API_KEY = '';
        (env as any).GOOGLE_MAPS_API_KEY = '';
        expect(isGooglePlacesConfigured()).toBe(false);
      } finally {
        (env as any).GOOGLE_PLACES_API_KEY = savedKey;
        (env as any).GOOGLE_MAPS_API_KEY = savedMapsKey;
      }
    });

    it('enforces null placeId, latitude, and longitude in manual mode (clearing stale coordinates)', async () => {
      const normalized = await verifyAndNormalizeLocation({
        venueName: 'K1 Klub House',
        venueAddress: 'Ochola Road, Parklands',
        city: 'Nairobi',
        country: 'Kenya',
        // Stale coordinates from a previous selection
        latitude: -1.2618,
        longitude: 36.8045,
        placeId: null, // manual mode
      });

      expect(normalized.venueName).toBe('K1 Klub House');
      expect(normalized.venueAddress).toBe('Ochola Road, Parklands');
      expect(normalized.city).toBe('Nairobi');
      expect(normalized.country).toBe('Kenya');
      expect(normalized.placeId).toBeNull();
      expect(normalized.latitude).toBeNull();
      expect(normalized.longitude).toBeNull();
    });

    it('applies US defaults in manual mode when country is not explicitly provided', async () => {
      const normalized = await verifyAndNormalizeLocation({
        venueName: 'The Brooklyn Mirage',
        venueAddress: '1020 Grand St',
        city: 'Brooklyn, NY',
        placeId: null,
      });

      expect(normalized.venueName).toBe('The Brooklyn Mirage');
      expect(normalized.city).toBe('Brooklyn, NY');
      expect(normalized.country).toBe('United States');
      expect(normalized.placeId).toBeNull();
      expect(normalized.latitude).toBeNull();
      expect(normalized.longitude).toBeNull();
    });

    it('validates coordinate bounds when placeId is provided without Google API configured', async () => {
      const savedKey = env.GOOGLE_PLACES_API_KEY;
      const savedMapsKey = env.GOOGLE_MAPS_API_KEY;
      (env as any).GOOGLE_PLACES_API_KEY = '';
      (env as any).GOOGLE_MAPS_API_KEY = '';

      try {
        // Valid coordinates
        const valid = await verifyAndNormalizeLocation({
          venueName: 'The Alchemist',
          venueAddress: 'Parklands Rd',
          city: 'Nairobi',
          country: 'Kenya',
          latitude: -1.2618,
          longitude: 36.8045,
          placeId: 'ChIJg_k_places_test_123',
        });
        expect(valid.placeId).toBe('ChIJg_k_places_test_123');
        expect(valid.latitude).toBe(-1.2618);
        expect(valid.longitude).toBe(36.8045);

        // Invalid latitude (> 90)
        await expect(
          verifyAndNormalizeLocation({
            venueName: 'Invalid Lat',
            latitude: 95.0,
            longitude: 36.0,
            placeId: 'ChIJ_invalid_lat',
          })
        ).rejects.toThrow('Latitude must be a valid number between -90 and 90');

        // Invalid longitude (> 180)
        await expect(
          verifyAndNormalizeLocation({
            venueName: 'Invalid Lng',
            latitude: -1.0,
            longitude: 195.0,
            placeId: 'ChIJ_invalid_lng',
          })
        ).rejects.toThrow('Longitude must be a valid number between -180 and 180');
      } finally {
        (env as any).GOOGLE_PLACES_API_KEY = savedKey;
        (env as any).GOOGLE_MAPS_API_KEY = savedMapsKey;
      }
    });

    it('handles autocomplete gracefully when unconfigured', async () => {
      const savedKey = env.GOOGLE_PLACES_API_KEY;
      const savedMapsKey = env.GOOGLE_MAPS_API_KEY;
      (env as any).GOOGLE_PLACES_API_KEY = '';
      (env as any).GOOGLE_MAPS_API_KEY = '';

      try {
        const result = await getAutocompleteSuggestions({
          input: 'Alchemist',
        });
        expect(result.configured).toBe(false);
        expect(result.suggestions).toEqual([]);
      } finally {
        (env as any).GOOGLE_PLACES_API_KEY = savedKey;
        (env as any).GOOGLE_MAPS_API_KEY = savedMapsKey;
      }
    });
  });

  describe('2. HTTP Endpoints (/api/places)', () => {
    it('GET /api/places/status returns configured status and defaultCountryCode', async () => {
      const res = await request(app).get('/api/places/status');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('configured');
      expect(res.body.data).toHaveProperty('defaultCountryCode');
      expect(res.body.data.defaultCountryCode).toBe('US');
    });

    it('GET /api/places/autocomplete returns suggestions payload structure', async () => {
      const res = await request(app).get('/api/places/autocomplete?input=Nairobi');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data.suggestions)).toBe(true);
    });

    it('GET /api/places/details/:placeId returns 400 for empty or invalid place ID', async () => {
      const res = await request(app).get('/api/places/details/%20');
      expect(res.status).toBe(400);
    });
  });

  describe('3. Event Creation & Series Recurrence Consistency', () => {
    let organizerToken: string;
    let organizerId: string;

    beforeEach(async () => {
      // Find or create seeded organizer
      const organizer = await prisma.user.findFirst({
        where: { role: 'ORGANIZER' },
      });
      if (organizer) {
        organizerId = organizer.id;
      }

      // Login as organizer to get token
      const loginRes = await request(app).post('/api/auth/login').send({
        email: 'sol@outside.vip',
        password: 'Outside2026!',
      });
      organizerToken = loginRes.body.data.token;
      organizerId = loginRes.body.data.user.id;
    });

    it('persists manual location with null coordinates and null placeId', async () => {
      const payload = {
        title: 'Manual Location Experience',
        tagline: 'An intimate sunset session',
        description: 'Testing manual location creation without coordinates',
        category: 'MUSIC',
        coverImageUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=1600&q=85',
        venueName: 'Secret Beach Garden',
        venueAddress: 'Bofa Road, North Coast',
        city: 'Kilifi',
        country: 'Kenya',
        // Manual mode: null coordinates and placeId
        placeId: null,
        latitude: null,
        longitude: null,
        startAt: '2026-12-10T18:00:00.000Z',
        endAt: '2026-12-11T02:00:00.000Z',
        timezone: 'Africa/Nairobi',
        status: 'DRAFT',
        ticketTiers: [
          {
            name: 'General Admission',
            priceInCents: 2000,
            currency: 'USD',
            totalCapacity: 100,
            minPerOrder: 1,
            maxPerOrder: 5,
          },
        ],
      };

      const res = await request(app)
        .post('/api/organizer/events')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send(payload);

      expect(res.status).toBe(201);
      const created = res.body.data.event;
      expect(created.venueName).toBe('Secret Beach Garden');
      expect(created.venueAddress).toBe('Bofa Road, North Coast');
      expect(created.city).toBe('Kilifi');
      expect(created.country).toBe('Kenya');
      expect(created.placeId).toBeNull();
      expect(created.latitude).toBeNull();
      expect(created.longitude).toBeNull();

      // Clean up
      await prisma.ticketTier.deleteMany({ where: { eventId: created.id } });
      await prisma.event.delete({ where: { id: created.id } });
    });

    it('persists verified placeId and coordinates for single events', async () => {
      const payload = {
        title: 'Verified Location Experience',
        tagline: 'Sound deck on the rooftop',
        description: 'Testing Google verified location coordinates persistence',
        category: 'NIGHTLIFE',
        coverImageUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=1600&q=85',
        venueName: 'The Alchemist Bar',
        venueAddress: 'Parklands Road, Westlands, Nairobi',
        city: 'Nairobi',
        country: 'Kenya',
        placeId: 'ChIJW8p7k30wLxgRNtW_test_alchemist',
        latitude: -1.2618,
        longitude: 36.8045,
        startAt: '2026-12-15T20:00:00.000Z',
        endAt: '2026-12-16T04:00:00.000Z',
        timezone: 'Africa/Nairobi',
        status: 'DRAFT',
        ticketTiers: [
          {
            name: 'Entry',
            priceInCents: 3000,
            currency: 'USD',
            totalCapacity: 150,
            minPerOrder: 1,
            maxPerOrder: 4,
          },
        ],
      };

      const res = await request(app)
        .post('/api/organizer/events')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send(payload);

      expect(res.status).toBe(201);
      const created = res.body.data.event;
      expect(created.placeId).toBe('ChIJW8p7k30wLxgRNtW_test_alchemist');
      expect(created.latitude).toBe(-1.2618);
      expect(created.longitude).toBe(36.8045);

      // Clean up
      await prisma.ticketTier.deleteMany({ where: { eventId: created.id } });
      await prisma.event.delete({ where: { id: created.id } });
    });

    it('ensures recurring event series and all individual occurrences handle location data consistently', async () => {
      const payload = {
        title: 'Weekly Sunset Sessions',
        tagline: 'Every Friday rooftop vibes',
        description: 'Series testing location consistency across occurrences',
        category: 'MUSIC',
        coverImageUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=1600&q=85',
        venueName: 'K1 Klub House Rooftop',
        venueAddress: 'Ojijo Road, Parklands',
        city: 'Nairobi',
        country: 'Kenya',
        placeId: 'ChIJK1_klub_rooftop_series_test',
        latitude: -1.2655,
        longitude: 36.8122,
        startAt: '2026-12-04T18:00:00.000Z',
        endAt: '2026-12-05T02:00:00.000Z',
        timezone: 'Africa/Nairobi',
        status: 'DRAFT',
        recurrence: {
          frequency: 'WEEKLY',
          interval: 1,
          byWeekday: [5], // Friday
          count: 3,
        },
        ticketTiers: [
          {
            name: 'Regular Admission',
            priceInCents: 2500,
            currency: 'USD',
            totalCapacity: 80,
            minPerOrder: 1,
            maxPerOrder: 6,
          },
        ],
      };

      const res = await request(app)
        .post('/api/organizer/events')
        .set('Authorization', `Bearer ${organizerToken}`)
        .send(payload);

      expect(res.status).toBe(201);
      const event = res.body.data.event;
      const series = event.series;

      expect(event.placeId).toBe('ChIJK1_klub_rooftop_series_test');
      expect(event.latitude).toBe(-1.2655);
      expect(event.longitude).toBe(36.8122);

      // Verify all occurrences in database have the identical location data
      const allOccurrences = await prisma.event.findMany({
        where: { seriesId: series.id },
      });

      expect(allOccurrences.length).toBe(3);
      for (const occ of allOccurrences) {
        expect(occ.venueName).toBe('K1 Klub House Rooftop');
        expect(occ.venueAddress).toBe('Ojijo Road, Parklands');
        expect(occ.city).toBe('Nairobi');
        expect(occ.placeId).toBe('ChIJK1_klub_rooftop_series_test');
        expect(occ.latitude).toBe(-1.2655);
        expect(occ.longitude).toBe(36.8122);
      }

      // Clean up series and events
      await prisma.ticketTier.deleteMany({ where: { event: { seriesId: series.id } } });
      await prisma.event.deleteMany({ where: { seriesId: series.id } });
      await prisma.eventSeries.delete({ where: { id: series.id } });
    });

    it('preserves backward compatibility: allows updating legacy events without placeId', async () => {
      // Create a legacy event directly in DB without placeId or coordinates
      const legacy = await prisma.event.create({
        data: {
          slug: `legacy-event-test-${Date.now()}`,
          organizerId,
          title: 'Legacy Event Without Place ID',
          description: 'Created before Google Places autocomplete feature',
          coverImageUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=1600&q=85',
          venueName: 'Old Historic Hall',
          venueAddress: 'Kenyatta Avenue',
          city: 'Nairobi',
          country: 'Kenya',
          latitude: null,
          longitude: null,
          placeId: null,
          startAt: new Date('2026-12-20T19:00:00Z'),
          endAt: new Date('2026-12-21T02:00:00Z'),
          timezone: 'Africa/Nairobi',
          status: 'DRAFT',
        },
      });

      // Update title or description without touching placeId
      const updateRes = await request(app)
        .patch(`/api/organizer/events/${legacy.id}`)
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({
          title: 'Updated Legacy Event Title',
          venueName: 'Renamed Historic Hall',
          // Note: placeId is undefined here; must NOT be forced to reselect!
        });

      expect(updateRes.status).toBe(200);
      const updated = updateRes.body.data.event;
      expect(updated.title).toBe('Updated Legacy Event Title');
      expect(updated.venueName).toBe('Renamed Historic Hall');
      expect(updated.placeId).toBeNull();
      expect(updated.latitude).toBeNull();
      expect(updated.longitude).toBeNull();

      // Clean up
      await prisma.event.delete({ where: { id: legacy.id } });
    });
  });

  describe('4. Timezone Resolution & Location Inference', () => {
    it('infers standard IANA timezone correctly from coordinates or US state', () => {
      // US States
      expect(inferTimezoneFromLocation({ stateCode: 'NY' })).toBe('America/New_York');
      expect(inferTimezoneFromLocation({ stateCode: 'CA' })).toBe('America/Los_Angeles');
      expect(inferTimezoneFromLocation({ stateCode: 'IL' })).toBe('America/Chicago');
      expect(inferTimezoneFromLocation({ stateCode: 'CO' })).toBe('America/Denver');
      expect(inferTimezoneFromLocation({ stateCode: 'AZ' })).toBe('America/Phoenix');
      expect(inferTimezoneFromLocation({ stateCode: 'HI' })).toBe('Pacific/Honolulu');
      expect(inferTimezoneFromLocation({ stateCode: 'AK' })).toBe('America/Anchorage');

      // East Africa / Kenya
      expect(inferTimezoneFromLocation({ country: 'Kenya' })).toBe('Africa/Nairobi');
      expect(inferTimezoneFromLocation({ countryCode: 'KE' })).toBe('Africa/Nairobi');

      // US Coordinates
      expect(inferTimezoneFromLocation({ latitude: 40.7128, longitude: -74.006 })).toBe('America/New_York');
      expect(inferTimezoneFromLocation({ latitude: 34.0522, longitude: -118.2437 })).toBe('America/Los_Angeles');
    });
  });
});
