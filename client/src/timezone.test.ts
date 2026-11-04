import { describe, it, expect } from 'vitest';
import {
  toIsoValueInTimezone,
  toInputValueInTimezone,
  formatTimezoneDisplay,
  DEFAULT_US_TIMEZONE,
} from './lib/timezone';

describe('Timezone & Daylight Saving Time Conversion Utilities', () => {
  describe('toIsoValueInTimezone', () => {
    it('accurately converts New York EDT (UTC-4) during summer daylight saving time', () => {
      // June in New York is Daylight Saving Time (EDT = UTC-4)
      const localInput = '2026-06-15T19:30';
      const iso = toIsoValueInTimezone(localInput, 'America/New_York');
      expect(iso).toBe('2026-06-15T23:30:00.000Z');
    });

    it('accurately converts New York EST (UTC-5) during winter standard time', () => {
      // December in New York is Standard Time (EST = UTC-5)
      const localInput = '2026-12-15T19:30';
      const iso = toIsoValueInTimezone(localInput, 'America/New_York');
      expect(iso).toBe('2026-12-16T00:30:00.000Z');
    });

    it('accurately converts Nairobi (UTC+3) which does not observe DST', () => {
      const localInput = '2026-06-15T20:00';
      const iso = toIsoValueInTimezone(localInput, 'Africa/Nairobi');
      expect(iso).toBe('2026-06-15T17:00:00.000Z');
    });

    it('accurately converts London BST (UTC+1) in summer and GMT (UTC+0) in winter', () => {
      // July = BST (UTC+1)
      const summerIso = toIsoValueInTimezone('2026-07-01T14:00', 'Europe/London');
      expect(summerIso).toBe('2026-07-01T13:00:00.000Z');

      // January = GMT (UTC+0)
      const winterIso = toIsoValueInTimezone('2026-01-15T14:00', 'Europe/London');
      expect(winterIso).toBe('2026-01-15T14:00:00.000Z');
    });

    it('returns null when input is empty or invalid', () => {
      expect(toIsoValueInTimezone('', 'America/New_York')).toBeNull();
      expect(toIsoValueInTimezone('   ', 'America/New_York')).toBeNull();
      expect(toIsoValueInTimezone(null, 'America/New_York')).toBeNull();
      expect(toIsoValueInTimezone('invalid', 'America/New_York')).toBeNull();
    });
  });

  describe('toInputValueInTimezone', () => {
    it('formats a UTC ISO string back to local datetime-local format in target timezone', () => {
      const utcIso = '2026-06-15T23:30:00.000Z';
      const inputValue = toInputValueInTimezone(utcIso, 'America/New_York');
      expect(inputValue).toBe('2026-06-15T19:30');
    });

    it('correctly handles standard time in winter for New York', () => {
      const utcIso = '2026-12-16T00:30:00.000Z';
      const inputValue = toInputValueInTimezone(utcIso, 'America/New_York');
      expect(inputValue).toBe('2026-12-15T19:30');
    });

    it('returns empty string on null, undefined, or invalid date', () => {
      expect(toInputValueInTimezone(null, 'America/New_York')).toBe('');
      expect(toInputValueInTimezone(undefined, 'America/New_York')).toBe('');
      expect(toInputValueInTimezone('invalid-date', 'America/New_York')).toBe('');
    });
  });

  describe('Round-trip symmetry across timezone conversions', () => {
    const timezones = ['America/New_York', 'America/Los_Angeles', 'Europe/London', 'Africa/Nairobi'];
    const testCases = [
      '2026-03-15T10:00', // around US spring forward
      '2026-07-20T21:45', // summer
      '2026-11-05T01:30', // around fall back
      '2026-12-31T23:59', // year end
    ];

    for (const tz of timezones) {
      for (const localStr of testCases) {
        it(`preserves round-trip consistency for ${localStr} in ${tz}`, () => {
          const iso = toIsoValueInTimezone(localStr, tz);
          expect(iso).not.toBeNull();
          const back = toInputValueInTimezone(iso, tz);
          expect(back).toBe(localStr);
        });
      }
    }
  });

  describe('formatTimezoneDisplay', () => {
    it('formats timezone label with group, IANA identifier and dynamic offset', () => {
      const formatted = formatTimezoneDisplay('America/New_York');
      expect(formatted).toContain('America/New_York');
      expect(formatted).toContain('Eastern Time');
      expect(formatted).toMatch(/GMT[-+]\d+/);
    });

    it('falls back to default timezone if unrecognized', () => {
      expect(DEFAULT_US_TIMEZONE).toBe('America/New_York');
    });
  });
});
