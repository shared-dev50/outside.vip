import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  extractTicketToken,
  isDuplicateScan,
  getCameraErrorDetails,
} from './lib/scanner';

describe('Outside.vip Organizer Scanner Utilities', () => {
  describe('extractTicketToken', () => {
    it('returns raw token directly when plain token is provided', () => {
      expect(extractTicketToken('tkt_sec_7a9f2e3b8c1d4e5f')).toBe('tkt_sec_7a9f2e3b8c1d4e5f');
    });

    it('trims leading and trailing whitespace', () => {
      expect(extractTicketToken('   tkt_sec_7a9f2e3b8c1d4e5f   ')).toBe('tkt_sec_7a9f2e3b8c1d4e5f');
    });

    it('extracts token from URL with token query parameter', () => {
      const url = 'https://outside.vip/orders/OUT-2026-89412/tickets?token=tkt_sec_7a9f2e3b8c1d4e5f';
      expect(extractTicketToken(url)).toBe('tkt_sec_7a9f2e3b8c1d4e5f');
    });

    it('extracts token from URL with t query parameter', () => {
      const url = 'https://outside-vip.vercel.app/scanner?t=tkt_sec_1d8c4e5f7a9f2e3b';
      expect(extractTicketToken(url)).toBe('tkt_sec_1d8c4e5f7a9f2e3b');
    });

    it('extracts token from URL pathname ending in ticket token', () => {
      const url = 'https://outside.vip/api/tickets/tkt_sec_7a9f2e3b8c1d4e5f';
      expect(extractTicketToken(url)).toBe('tkt_sec_7a9f2e3b8c1d4e5f');
    });

    it('extracts token from JSON payload', () => {
      const json = JSON.stringify({ token: 'tkt_sec_7a9f2e3b8c1d4e5f', eventId: 'evt-1' });
      expect(extractTicketToken(json)).toBe('tkt_sec_7a9f2e3b8c1d4e5f');
    });

    it('handles empty or blank inputs gracefully', () => {
      expect(extractTicketToken('')).toBe('');
      expect(extractTicketToken('   ')).toBe('');
    });
  });

  describe('isDuplicateScan', () => {
    it('returns false when there is no prior scan', () => {
      expect(isDuplicateScan('tkt_sec_123', null)).toBe(false);
    });

    it('returns false when current token differs from prior scan', () => {
      const lastScanned = { token: 'tkt_sec_111', timestamp: Date.now() };
      expect(isDuplicateScan('tkt_sec_222', lastScanned)).toBe(false);
    });

    it('returns true when same token is scanned within cooldown window', () => {
      const now = Date.now();
      const lastScanned = { token: 'tkt_sec_123', timestamp: now - 1000 };
      expect(isDuplicateScan('tkt_sec_123', lastScanned, 3000)).toBe(true);
    });

    it('returns false when same token is scanned after cooldown window', () => {
      const now = Date.now();
      const lastScanned = { token: 'tkt_sec_123', timestamp: now - 4000 };
      expect(isDuplicateScan('tkt_sec_123', lastScanned, 3000)).toBe(false);
    });
  });

  describe('getCameraErrorDetails', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('identifies NotAllowedError as permission_denied', () => {
      const err = new Error('Permission dismissed');
      err.name = 'NotAllowedError';

      const details = getCameraErrorDetails(err);
      expect(details.type).toBe('permission_denied');
      expect(details.message).toContain('Camera permission was denied');
    });

    it('identifies NotFoundError as not_found', () => {
      const err = new Error('Requested device not found');
      err.name = 'NotFoundError';

      const details = getCameraErrorDetails(err);
      expect(details.type).toBe('not_found');
      expect(details.message).toContain('No camera hardware');
    });

    it('identifies NotReadableError as in_use', () => {
      const err = new Error('Could not start video source');
      err.name = 'NotReadableError';

      const details = getCameraErrorDetails(err);
      expect(details.type).toBe('in_use');
      expect(details.message).toContain('currently occupied');
    });

    it('identifies OverconstrainedError as not_found', () => {
      const err = new Error('Constraint could not be satisfied');
      err.name = 'OverconstrainedError';

      const details = getCameraErrorDetails(err);
      expect(details.type).toBe('not_found');
      expect(details.message).toContain('No camera was found matching');
    });

    it('handles unexpected generic errors with fallback', () => {
      const err = new Error('Something went wrong with camera stream');
      const details = getCameraErrorDetails(err);

      expect(details.type).toBe('unknown');
      expect(details.message).toBe('Something went wrong with camera stream');
    });
  });
});
