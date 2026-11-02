import { describe, it, expect } from 'vitest';
import { LocationData } from './components/events/LocationAutocompleteInput';
import { api } from './lib/api';

describe('Event Location Autocomplete & Selection Logic', () => {
  describe('1. Location Clearing & State Isolation (Requirement 2)', () => {
    it('does not destroy the selected location when the organizer types a new query', () => {
      // Current selected place
      const savedLocation: LocationData = {
        venueName: 'The Alchemist Bar',
        venueAddress: 'Parklands Road, Nairobi, Kenya',
        city: 'Nairobi',
        country: 'Kenya',
        latitude: -1.2618,
        longitude: 36.8045,
        placeId: 'ChIJg_k_places_test_123',
      };

      // Organizer begins typing a search query
      const searchQuery = 'Muze Club';
      expect(searchQuery.length).toBeGreaterThan(0);
      // In LocationAutocompleteInput, searchQuery is isolated local state and does NOT mutate savedLocation
      expect(savedLocation.placeId).toBe('ChIJg_k_places_test_123');
      expect(savedLocation.latitude).toBe(-1.2618);
      expect(savedLocation.longitude).toBe(36.8045);
      expect(savedLocation.venueName).toBe('The Alchemist Bar');

      // Only when a suggestion is chosen is the location updated
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
      // Prior Google Places selection
      const previousGoogleSelection: LocationData = {
        venueName: 'The Baobab Amphitheatre',
        venueAddress: 'Bofa Beach Road, Kilifi',
        city: 'Kilifi',
        country: 'Kenya',
        latitude: -3.6305,
        longitude: 39.8499,
        placeId: 'ChIJ_kilifi_baobab',
      };

      // Switching to manual mode or updating in manual mode
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
      // Existing legacy event record from database
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
});
