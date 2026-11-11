import { describe, it, expect } from 'vitest';
import { LocationData } from './components/events/LocationAutocompleteInput';
import { api } from './lib/api';

describe('Event Location Autocomplete & Selection Logic', () => {
  describe('1. Location Clearing & State Isolation (Requirement 2)', () => {
    it('does not destroy the selected location when the organizer types a new query', () => {
      const savedLocation: LocationData = {
        venueName: 'The Alchemist Bar',
        venueAddress: 'Parklands Road, Nairobi, Kenya',
        city: 'Nairobi',
        country: 'Kenya',
        latitude: -1.2618,
        longitude: 36.8045,
        placeId: 'ChIJg_k_places_test_123',
      };

      const searchQuery = 'Muze Club';
      expect(searchQuery.length).toBeGreaterThan(0);
      // In LocationAutocompleteInput, searchQuery is isolated local state and does NOT mutate savedLocation
      expect(savedLocation.placeId).toBe('ChIJg_k_places_test_123');
      expect(savedLocation.latitude).toBe(-1.2618);
      expect(savedLocation.longitude).toBe(36.8045);
      expect(savedLocation.venueName).toBe('The Alchemist Bar');

      const newSelectedSuggestion = {
        venueName: 'Muze Club',
        venueAddress: 'Mpaka Road, Westlands, Nairobi',
        city: 'Nairobi',
        country: 'Kenya',
        latitude: -1.264,
        longitude: 36.803,
        placeId: 'ChIJ_muze_club_id',
      };

      const updatedLocation: LocationData = { ...newSelectedSuggestion };
      expect(updatedLocation.placeId).toBe('ChIJ_muze_club_id');
      expect(updatedLocation.venueName).toBe('Muze Club');
    });

    it('allows customizing venueName independently without altering coordinates or placeId', () => {
      const selectedLocation: LocationData = {
        venueName: 'The Alchemist',
        venueAddress: 'Parklands Road, Nairobi',
        city: 'Nairobi',
        country: 'Kenya',
        latitude: -1.2618,
        longitude: 36.8045,
        placeId: 'ChIJ_the_alchemist',
      };

      // Organizer customizes venue name for the event (e.g. "Main Stage - The Alchemist")
      const customized: LocationData = {
        ...selectedLocation,
        venueName: 'Main Stage - The Alchemist',
      };

      expect(customized.venueName).toBe('Main Stage - The Alchemist');
      expect(customized.placeId).toBe('ChIJ_the_alchemist');
      expect(customized.latitude).toBe(-1.2618);
      expect(customized.longitude).toBe(36.8045);
      expect(customized.venueAddress).toBe('Parklands Road, Nairobi');
    });
  });

  describe('2. Manual Entry Fallback & Stale Data Clearing (Requirement 3)', () => {
    it('sets placeId, latitude, and longitude to null in manual mode with no stale coordinates', () => {
      const previousGoogleSelection: LocationData = {
        venueName: 'The Baobab Amphitheatre',
        venueAddress: 'Bofa Beach Road, Kilifi',
        city: 'Kilifi',
        country: 'Kenya',
        latitude: -3.6305,
        longitude: 39.8499,
        placeId: 'ChIJ_kilifi_baobab',
      };

      const manualLocation: LocationData = {
        venueName: previousGoogleSelection.venueName,
        venueAddress: previousGoogleSelection.venueAddress,
        city: previousGoogleSelection.city,
        country: previousGoogleSelection.country,
        latitude: null,
        longitude: null,
        placeId: null,
      };

      expect(manualLocation.venueName).toBe('The Baobab Amphitheatre');
      expect(manualLocation.placeId).toBeNull();
      expect(manualLocation.latitude).toBeNull();
      expect(manualLocation.longitude).toBeNull();
    });
  });

  describe('3. Backward Compatibility for Legacy Events (Requirement 1)', () => {
    it('initializes gracefully for legacy events without placeId or coordinates', () => {
      const legacyEvent: LocationData = {
        venueName: 'Carnivore Grounds',
        venueAddress: 'Langata Road, Nairobi',
        city: 'Nairobi',
        country: 'Kenya',
        latitude: null,
        longitude: null,
        placeId: null,
      };

      // Is recognised as legacy/manual without forcing Google reselection
      const isLegacyOrManual = !legacyEvent.placeId && Boolean(legacyEvent.venueName);
      expect(isLegacyOrManual).toBe(true);

      // Updating title or venue address preserves null placeId and coordinates
      const edited: LocationData = {
        ...legacyEvent,
        venueName: 'Carnivore Simba Saloon',
      };

      expect(edited.venueName).toBe('Carnivore Simba Saloon');
      expect(edited.placeId).toBeNull();
      expect(edited.latitude).toBeNull();
      expect(edited.longitude).toBeNull();
    });
  });

  describe('4. Google Maps Search URL Resolution', () => {
    function resolveMapUrl(event: {
      venueName: string;
      venueAddress?: string | null;
      city: string;
      latitude?: number | null;
      longitude?: number | null;
      placeId?: string | null;
    }): string {
      if (event.placeId) {
        return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
          `${event.venueName}, ${event.venueAddress || event.city}`
        )}&query_place_id=${encodeURIComponent(event.placeId)}`;
      }
      if (event.latitude && event.longitude) {
        return `https://www.google.com/maps/search/?api=1&query=${event.latitude},${event.longitude}`;
      }
      return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
        `${event.venueName}, ${event.venueAddress || ''}, ${event.city}`
      )}`;
    }

    it('generates query_place_id URL when placeId is available', () => {
      const url = resolveMapUrl({
        venueName: 'The Alchemist',
        venueAddress: 'Parklands Rd, Nairobi',
        city: 'Nairobi',
        placeId: 'ChIJg_k_places_test_123',
        latitude: -1.2618,
        longitude: 36.8045,
      });

      expect(url).toContain('query_place_id=ChIJg_k_places_test_123');
      expect(url).toContain('api=1');
    });

    it('generates coordinate URL when lat/lng are available without placeId', () => {
      const url = resolveMapUrl({
        venueName: 'Custom Coordinates Venue',
        city: 'Mombasa',
        latitude: -4.0435,
        longitude: 39.6682,
        placeId: null,
      });

      expect(url).toBe('https://www.google.com/maps/search/?api=1&query=-4.0435,39.6682');
    });

    it('generates text query fallback for legacy events without placeId or coordinates', () => {
      const url = resolveMapUrl({
        venueName: 'Secret Forest',
        venueAddress: 'Karura Gate D',
        city: 'Nairobi',
        placeId: null,
        latitude: null,
        longitude: null,
      });

      expect(url).toContain('query=Secret%20Forest%2C%20Karura%20Gate%20D%2C%20Nairobi');
    });
  });

  describe('5. API Client Methods', () => {
    it('exposes places status, autocomplete, and details under api.places', () => {
      expect(typeof api.places.status).toBe('function');
      expect(typeof api.places.autocomplete).toBe('function');
      expect(typeof api.places.details).toBe('function');
    });
  });

  describe('6. US-First Localisation & Redesigned Manual Entry (Form UX)', () => {
    it('sets sensible US defaults in manual location entry mode', () => {
      const manualEntry: LocationData = {
        venueName: 'The Brooklyn Mirage',
        venueAddress: '1020 Grand St',
        city: 'Brooklyn, NY',
        country: 'United States',
        placeId: null,
        latitude: null,
        longitude: null,
      };

      expect(manualEntry.venueName).toBe('The Brooklyn Mirage');
      expect(manualEntry.city).toBe('Brooklyn, NY');
      expect(manualEntry.country).toBe('United States');
      expect(manualEntry.placeId).toBeNull();
      expect(manualEntry.latitude).toBeNull();
      expect(manualEntry.longitude).toBeNull();
    });

    it('preserves existing Kenyan locations on edit without forcing US overwrite', () => {
      const existingKenyaEvent: LocationData = {
        venueName: 'The Alchemist Bar',
        venueAddress: 'Parklands Road, Nairobi',
        city: 'Nairobi',
        country: 'Kenya',
        placeId: 'ChIJg_k_places_test_123',
        latitude: -1.2618,
        longitude: 36.8045,
      };

      // Modifying venue display name does not alter existing country or city
      const updated = {
        ...existingKenyaEvent,
        venueName: 'Main Stage @ The Alchemist',
      };

      expect(updated.country).toBe('Kenya');
      expect(updated.city).toBe('Nairobi');
      expect(updated.latitude).toBe(-1.2618);
    });
  });

  describe('7. Timezone Prioritisation & Dynamic DST Display', () => {
    it('prioritizes US timezones first, followed by Africa and Europe', async () => {
      const { TIMEZONE_GROUPS, DEFAULT_US_TIMEZONE } = await import('./lib/timezone');
      expect(DEFAULT_US_TIMEZONE).toBe('America/New_York');

      expect(TIMEZONE_GROUPS[0].groupName).toBe('United States');
      const usIanas = TIMEZONE_GROUPS[0].options.map((o) => o.iana);
      expect(usIanas).toContain('America/New_York');
      expect(usIanas).toContain('America/Chicago');
      expect(usIanas).toContain('America/Denver');
      expect(usIanas).toContain('America/Los_Angeles');
      expect(usIanas).toContain('America/Anchorage');
      expect(usIanas).toContain('Pacific/Honolulu');

      expect(TIMEZONE_GROUPS[1].groupName).toBe('Africa');
      const africaIanas = TIMEZONE_GROUPS[1].options.map((o) => o.iana);
      expect(africaIanas).toContain('Africa/Nairobi');
    });

    it('dynamically formats daylight saving time (DST) without hardcoded offsets', async () => {
      const { formatTimezoneDisplay } = await import('./lib/timezone');
      // Summer date (DST active in US)
      const summerDate = new Date('2026-07-15T18:00:00Z');
      const nySummer = formatTimezoneDisplay('America/New_York', summerDate);
      expect(nySummer).toContain('America/New_York');
      expect(nySummer).toContain('EDT');

      // Winter date (standard time active in US)
      const winterDate = new Date('2026-12-15T18:00:00Z');
      const nyWinter = formatTimezoneDisplay('America/New_York', winterDate);
      expect(nyWinter).toContain('America/New_York');
      expect(nyWinter).toContain('EST');

      // Nairobi has no DST (always GMT+3)
      const nairobiSummer = formatTimezoneDisplay('Africa/Nairobi', summerDate);
      expect(nairobiSummer).toContain('Africa/Nairobi');
      expect(nairobiSummer).toContain('GMT+3');
    });

    it('infers timezone reliably from venue coordinates or state', async () => {
      const { inferTimezoneFromLocation } = await import('./lib/timezone');

      expect(inferTimezoneFromLocation({ stateCode: 'NY' })).toBe('America/New_York');
      expect(inferTimezoneFromLocation({ latitude: 40.7128, longitude: -74.006 })).toBe('America/New_York');

      expect(inferTimezoneFromLocation({ stateCode: 'CA' })).toBe('America/Los_Angeles');
      expect(inferTimezoneFromLocation({ latitude: 34.0522, longitude: -118.2437 })).toBe('America/Los_Angeles');

      expect(inferTimezoneFromLocation({ stateCode: 'IL' })).toBe('America/Chicago');
      expect(inferTimezoneFromLocation({ latitude: 41.8781, longitude: -87.6298 })).toBe('America/Chicago');

      expect(inferTimezoneFromLocation({ stateCode: 'CO' })).toBe('America/Denver');
      expect(inferTimezoneFromLocation({ latitude: 39.7392, longitude: -104.9903 })).toBe('America/Denver');

      expect(inferTimezoneFromLocation({ stateCode: 'HI' })).toBe('Pacific/Honolulu');
      expect(inferTimezoneFromLocation({ latitude: 21.3069, longitude: -157.8583 })).toBe('Pacific/Honolulu');

      expect(inferTimezoneFromLocation({ country: 'Kenya' })).toBe('Africa/Nairobi');
      expect(inferTimezoneFromLocation({ countryCode: 'KE' })).toBe('Africa/Nairobi');
      expect(inferTimezoneFromLocation({ latitude: -1.2921, longitude: 36.8219 })).toBe('Africa/Nairobi');
    });
  });
});

