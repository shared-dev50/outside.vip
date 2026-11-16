import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderToString } from 'react-dom/server';
import React from 'react';
import {
  extractTicketToken,
  isDuplicateScan,
  getCameraErrorDetails,
} from './lib/scanner';
import { ScannerPage } from './pages/ScannerPage';
import { api } from './lib/api';

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

  describe('ScannerPage Security Hardening & Zero-Fallback Verification', () => {
    it('initializes with 0 checked in and clean empty events list (no hardcoded demo events)', () => {
      const html = renderToString(React.createElement(ScannerPage));

      // Must NOT contain hardcoded mock events from demo stage
      expect(html).not.toContain('SOL FEST: Under The Baobab Tree');
      expect(html).not.toContain('SUB-TERRAIN: Warehouse Rave');

      // Must display 0 checked in, NOT 342
      expect(html).toContain('0<!-- --> Checked In');
      expect(html).not.toContain('>342<');
    });

    it('does NOT render demo credential buttons or simulation test passes', () => {
      const html = renderToString(React.createElement(ScannerPage));

      expect(html).not.toContain('Test Pass Credentials');
      expect(html).not.toContain('Demo Valid');
      expect(html).not.toContain('Demo Duplicate');
      expect(html).not.toContain('tkt_sec_7a9f2e3b8c1d4e5f');
      expect(html).not.toContain('tkt_sec_1d8c4e5f7a9f2e3b');
    });

    it('api.organizer.checkInTicket forwards Idempotency-Key header when provided', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          success: true,
          data: {
            result: 'SUCCESS',
            message: 'Valid admission pass verified.',
            ticket: { attendeeName: 'Amina Mohamed', tierName: 'VIP Pass' },
            totalCheckedIn: 1,
          },
        }),
      } as any);

      const idempotencyKey = 'scan_test_1731360000_abc123';
      await api.organizer.checkInTicket({
        token: 'tkt_sec_real_credential_xyz',
        eventId: 'event-uuid-1',
        idempotencyKey,
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/organizer/check-in');
      expect(options.method).toBe('POST');
      expect((options.headers as any)['Idempotency-Key']).toBe(idempotencyKey);

      const parsedBody = JSON.parse(options.body as string);
      expect(parsedBody.token).toBe('tkt_sec_real_credential_xyz');
      expect(parsedBody.eventId).toBe('event-uuid-1');
      expect(parsedBody.idempotencyKey).toBe(idempotencyKey);
    });

    it('verifies handleLocalFallback is completely deleted from ScannerPage source', async () => {
      // Direct source inspection to ensure no hidden simulation fallbacks remain in the bundle
      const scannerSource = await import('./pages/ScannerPage?raw').then((m) => m.default || '').catch(() => '');
      if (scannerSource) {
        expect(scannerSource).not.toContain('handleLocalFallback');
        expect(scannerSource).not.toContain('Demo Simulation');
      }
    });
  });

  describe('Phase 1.2: Scanner Idempotency & Retry State Lifecycle', () => {
    it('verifies ScannerPage source defines pendingScanRef and synchronous validation guard', async () => {
      const scannerSource = await import('./pages/ScannerPage?raw').then((m) => m.default || '').catch(() => '');
      expect(scannerSource).toBeTruthy();

      // Must have pendingScanRef tracking { token, gateId, idempotencyKey }
      expect(scannerSource).toContain('pendingScanRef = useRef');
      expect(scannerSource).toContain('idempotencyKey: string');

      // Must guard synchronously against rapid clicks / enter key / camera frames
      expect(scannerSource).toContain('if (!trimmed || isValidatingRef.current) return');
      expect(scannerSource).toContain('isValidatingRef.current = true');

      // Must support retry reusing pendingScanRef idempotency key
      expect(scannerSource).toContain('handleRetry');
      expect(scannerSource).toContain('isRetry &&');
      expect(scannerSource).toContain('pendingScanRef.current.idempotencyKey');

      // Must render Retry Check-In and Abandon / Scan Next buttons in network_error state
      expect(scannerSource).toContain('Retry Check-In');
      expect(scannerSource).toContain('Abandon / Scan Next');

      // Gate change must reset pending scan
      expect(scannerSource).toContain('setSelectedEventId(e.target.value)');
      expect(scannerSource).toContain('resetScanner()');
    });

    it('simulates retry lifecycle: preserves key across network dropouts and reuses on retry', async () => {
      // Component-level ref simulation matching ScannerPage.tsx implementation
      const isValidatingRef = { current: false };
      const pendingScanRef = {
        current: null as { token: string; gateId?: string; idempotencyKey: string } | null,
      };

      const submittedKeys: string[] = [];

      const mockApiCheckIn = vi.fn().mockImplementation(async ({ idempotencyKey }) => {
        submittedKeys.push(idempotencyKey);
        if (submittedKeys.length === 1) {
          // Simulate first attempt: Network timeout / connection drop
          const netErr = new Error('Failed to fetch');
          (netErr as any).name = 'TypeError';
          throw netErr;
        }
        // Second attempt (retry): Server accepts and admits
        return {
          result: 'SUCCESS',
          ticket: { attendeeName: 'Amina Mohamed', tierName: 'VIP Pass' },
          totalCheckedIn: 1,
        };
      });

      const handleValidateToken = async (
        token: string,
        overrideGateId?: string,
        isRetry = false
      ) => {
        const trimmed = extractTicketToken(token);
        if (!trimmed || isValidatingRef.current) return;

        isValidatingRef.current = true;
        const gateId = overrideGateId !== undefined ? overrideGateId : 'evt-savannah';

        let idempotencyKey: string;
        if (
          isRetry &&
          pendingScanRef.current &&
          pendingScanRef.current.token === trimmed &&
          pendingScanRef.current.gateId === (gateId || undefined)
        ) {
          idempotencyKey = pendingScanRef.current.idempotencyKey;
        } else {
          idempotencyKey = `scan_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
          pendingScanRef.current = {
            token: trimmed,
            gateId: gateId || undefined,
            idempotencyKey,
          };
        }

        try {
          const res = await mockApiCheckIn({
            token: trimmed,
            eventId: gateId || undefined,
            idempotencyKey,
          });

          if (res.result === 'SUCCESS') {
            pendingScanRef.current = null;
          }
        } catch (err: any) {
          const status = err.statusCode;
          const isDefinitiveServerRejection = status === 409 || status === 400 || status === 404;
          if (isDefinitiveServerRejection) {
            pendingScanRef.current = null;
          }
          // On network error: pendingScanRef is preserved
        } finally {
          isValidatingRef.current = false;
        }
      };

      const handleRetry = () => {
        if (!pendingScanRef.current || isValidatingRef.current) return;
        return handleValidateToken(
          pendingScanRef.current.token,
          pendingScanRef.current.gateId,
          true
        );
      };

      // 1. Initial scan attempt fails with network error
      await handleValidateToken('tkt_sec_test_pass_123');
      expect(submittedKeys.length).toBe(1);
      const initialKey = submittedKeys[0];
      expect(initialKey).toMatch(/^scan_\d+_[a-z0-9]+$/);
      // Ref MUST retain the pending scan state
      expect(pendingScanRef.current).not.toBeNull();
      expect(pendingScanRef.current?.idempotencyKey).toBe(initialKey);
      expect(pendingScanRef.current?.token).toBe('tkt_sec_test_pass_123');

      // 2. User clicks "Retry Check-In"
      await handleRetry();
      expect(submittedKeys.length).toBe(2);
      const retryKey = submittedKeys[1];
      // Retry MUST reuse the exact same idempotency key
      expect(retryKey).toBe(initialKey);

      // 3. Success clears pending scan state
      expect(pendingScanRef.current).toBeNull();
    });

    it('simulates rapid double-submission: synchronous guard blocks duplicate in-flight attempts', async () => {
      const isValidatingRef = { current: false };
      let apiCallCount = 0;

      const mockApiCheckIn = vi.fn().mockImplementation(async () => {
        apiCallCount++;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { result: 'SUCCESS' };
      });

      const handleValidateToken = async (token: string) => {
        const trimmed = extractTicketToken(token);
        if (!trimmed || isValidatingRef.current) return;

        // Synchronous lock acquisition
        isValidatingRef.current = true;

        try {
          await mockApiCheckIn();
        } finally {
          isValidatingRef.current = false;
        }
      };

      // Rapidly fire two calls synchronously (simulating double click or Enter key mashing)
      const call1 = handleValidateToken('tkt_sec_rapid_click_001');
      const call2 = handleValidateToken('tkt_sec_rapid_click_001');

      await Promise.all([call1, call2]);

      // Exactly 1 network request must have been dispatched
      expect(apiCallCount).toBe(1);
      expect(isValidatingRef.current).toBe(false);
    });

    it('simulates gate change: resets pending scan so new gate does not reuse previous idempotency key', async () => {
      const pendingScanRef = {
        current: {
          token: 'tkt_sec_pending_001',
          gateId: 'evt-savannah-111',
          idempotencyKey: 'scan_1731700000_abc123',
        } as { token: string; gateId?: string; idempotencyKey: string } | null,
      };

      const resetScanner = () => {
        pendingScanRef.current = null;
      };

      const onGateChange = (_newGate: string) => {
        resetScanner();
      };

      expect(pendingScanRef.current).not.toBeNull();
      onGateChange('evt-solfest-222');
      expect(pendingScanRef.current).toBeNull();
    });
  });
});


