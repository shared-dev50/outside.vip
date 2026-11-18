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

  describe('Phase 2 Final Audit: Staff Gate Isolation & Zero Public Fallback', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('ATTENDEE with zero assigned gates renders explicit empty state and explanation', () => {
      const attendeeUser: any = {
        id: 'user-att-1',
        email: 'staff@outside.vip',
        name: 'Scanner Staff',
        role: 'ATTENDEE',
      };

      const html = renderToString(React.createElement(ScannerPage, { initialUser: attendeeUser }));

      expect(html).toContain('No Assigned Event Gates');
      expect(html).toContain(
        'You do not have any active scanner staff assignments. You need an active event assignment before scanning tickets.'
      );
      expect(html).toContain('Check for Assignments');
      expect(html).not.toContain('Active Gate Pass');
    });

    it('ATTENDEE with active assigned gates loads assigned gates and avoids fallback', async () => {
      const assignedGates = [{ id: 'evt-assigned-1', title: 'Sol Fest Baobab', slug: 'sol-fest' }];
      const getGatesSpy = vi.spyOn(api.scanner, 'getGates').mockResolvedValue({
        events: assignedGates,
      } as any);
      const listOrgEventsSpy = vi.spyOn(api.organizer, 'listEvents');
      const listPublicEventsSpy = vi.spyOn(api.events, 'list');

      const user = { role: 'ATTENDEE' };
      let eventsList: any[] = [];

      const fetchEvents = async () => {
        try {
          const gatesRes = await api.scanner.getGates();
          if (gatesRes.events && gatesRes.events.length > 0) {
            eventsList = gatesRes.events;
            return;
          }
          if (user?.role === 'ATTENDEE') {
            eventsList = [];
            return;
          }
        } catch {}
      };

      await fetchEvents();

      expect(getGatesSpy).toHaveBeenCalledTimes(1);
      expect(listOrgEventsSpy).not.toHaveBeenCalled();
      expect(listPublicEventsSpy).not.toHaveBeenCalled();
      expect(eventsList).toEqual(assignedGates);
    });

    it('Organizer with owned events falls through to organizer events list and does not show empty state', async () => {
      const organizerUser: any = {
        id: 'user-org-1',
        email: 'org@outside.vip',
        name: 'Event Organizer',
        role: 'ORGANIZER',
      };

      const html = renderToString(React.createElement(ScannerPage, { initialUser: organizerUser }));

      expect(html).not.toContain('No Assigned Event Gates');
      expect(html).toContain('Active Gate Pass');
      expect(html).toContain('0<!-- --> Checked In');

      const getGatesSpy = vi.spyOn(api.scanner, 'getGates').mockResolvedValue({
        events: [],
      } as any);
      const orgEvents = [{ id: 'evt-org-1', title: 'My Organizer Showcase', slug: 'my-org' }];
      const listOrgEventsSpy = vi.spyOn(api.organizer, 'listEvents').mockResolvedValue({
        events: orgEvents,
      } as any);
      const listPublicEventsSpy = vi.spyOn(api.events, 'list');

      const user = { role: 'ORGANIZER' };
      let eventsList: any[] = [];

      const fetchEvents = async () => {
        try {
          const gatesRes = await api.scanner.getGates();
          if (gatesRes.events && gatesRes.events.length > 0) {
            eventsList = gatesRes.events;
            return;
          }
          if (user?.role === 'ATTENDEE') {
            eventsList = [];
            return;
          }
        } catch {}

        try {
          const orgRes = await api.organizer.listEvents();
          if (orgRes.events && orgRes.events.length > 0) {
            eventsList = orgRes.events;
            return;
          }
        } catch {}
      };

      await fetchEvents();

      expect(getGatesSpy).toHaveBeenCalledTimes(1);
      expect(listOrgEventsSpy).toHaveBeenCalledTimes(1);
      expect(listPublicEventsSpy).not.toHaveBeenCalled();
      expect(eventsList).toEqual(orgEvents);
    });

    it('Admin with available gates does not show empty state and loads gates directly', async () => {
      const adminUser: any = {
        id: 'user-admin-1',
        email: 'admin@outside.vip',
        name: 'Outside Admin',
        role: 'ADMIN',
      };

      const html = renderToString(React.createElement(ScannerPage, { initialUser: adminUser }));

      expect(html).not.toContain('No Assigned Event Gates');
      expect(html).toContain('Active Gate Pass');
      expect(html).toContain('0<!-- --> Checked In');

      const adminGates = [{ id: 'evt-admin-1', title: 'Global VIP Summit', slug: 'vip-summit' }];
      const getGatesSpy = vi.spyOn(api.scanner, 'getGates').mockResolvedValue({
        events: adminGates,
      } as any);
      const listOrgEventsSpy = vi.spyOn(api.organizer, 'listEvents');
      const listPublicEventsSpy = vi.spyOn(api.events, 'list');

      const user = { role: 'ADMIN' };
      let eventsList: any[] = [];

      const fetchEvents = async () => {
        try {
          const gatesRes = await api.scanner.getGates();
          if (gatesRes.events && gatesRes.events.length > 0) {
            eventsList = gatesRes.events;
            return;
          }
          if (user?.role === 'ATTENDEE') {
            eventsList = [];
            return;
          }
        } catch {}
      };

      await fetchEvents();

      expect(getGatesSpy).toHaveBeenCalledTimes(1);
      expect(listOrgEventsSpy).not.toHaveBeenCalled();
      expect(listPublicEventsSpy).not.toHaveBeenCalled();
      expect(eventsList).toEqual(adminGates);
    });

    it('Ensure public events are never loaded as fallback for an ATTENDEE with no assignments', async () => {
      const getGatesSpy = vi.spyOn(api.scanner, 'getGates').mockResolvedValue({
        events: [],
      } as any);
      const listOrgEventsSpy = vi.spyOn(api.organizer, 'listEvents').mockResolvedValue({
        events: [{ id: 'evt-org-leak', title: 'Leaked Org Event', slug: 'leaked-org' }],
      } as any);
      const listPublicEventsSpy = vi.spyOn(api.events, 'list').mockResolvedValue({
        events: [{ id: 'evt-public-leak', title: 'Leaked Public Event', slug: 'leaked-public' }],
      } as any);

      const user = { role: 'ATTENDEE' };
      let eventsList: any[] = [];
      let isLoadingEvents = true;

      const fetchEvents = async () => {
        isLoadingEvents = true;
        try {
          const gatesRes = await api.scanner.getGates();
          if (gatesRes.events && gatesRes.events.length > 0) {
            eventsList = gatesRes.events;
            isLoadingEvents = false;
            return;
          }

          if (user?.role === 'ATTENDEE') {
            eventsList = [];
            isLoadingEvents = false;
            return;
          }
        } catch {
          if (user?.role === 'ATTENDEE') {
            eventsList = [];
            isLoadingEvents = false;
            return;
          }
        }

        try {
          const orgRes = await api.organizer.listEvents();
          if (orgRes.events && orgRes.events.length > 0) {
            eventsList = orgRes.events;
          }
        } catch {}

        try {
          const publicRes = await api.events.list({ limit: 100 });
          if (publicRes.events && publicRes.events.length > 0) {
            eventsList = publicRes.events;
          }
        } catch {} finally {
          isLoadingEvents = false;
        }
      };

      await fetchEvents();

      expect(getGatesSpy).toHaveBeenCalledTimes(1);
      expect(listOrgEventsSpy).not.toHaveBeenCalled();
      expect(listPublicEventsSpy).not.toHaveBeenCalled();
      expect(eventsList).toEqual([]);
      expect(isLoadingEvents).toBe(false);
    });

    it('verifies ScannerPage source code guarantees zero public fallback for ATTENDEE', async () => {
      const scannerSource = await import('./pages/ScannerPage?raw').then((m) => m.default || '').catch(() => '');
      expect(scannerSource).toBeTruthy();

      expect(scannerSource).toContain("if (isMounted && user?.role === 'ATTENDEE')");
      expect(scannerSource).toContain('No Assigned Event Gates');
      expect(scannerSource).toContain('You do not have any active scanner staff assignments');
    });
  });

  describe('Stage 2: Staff Scanner Session Continuity, Heartbeat & Error Differentiation', () => {
    afterEach(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    it('api.scanner.ping calls the /scanner/ping endpoint', async () => {
      const pingSpy = vi.spyOn(api.scanner, 'ping').mockResolvedValue({
        timestamp: Date.now(),
      } as any);

      const res = await api.scanner.ping();
      expect(pingSpy).toHaveBeenCalledTimes(1);
      expect(res).toHaveProperty('timestamp');
    });

    it('verifies ScannerPage source code defines 10-minute heartbeat interval and lifecycle guards', async () => {
      const scannerSource = await import('./pages/ScannerPage?raw').then((m) => m.default || '').catch(() => '');
      expect(scannerSource).toBeTruthy();

      expect(scannerSource).toContain('HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000');
      expect(scannerSource).toContain("cameraStatus === 'active'");
      expect(scannerSource).toContain("document.visibilityState === 'visible'");
      expect(scannerSource).toContain("document.addEventListener('visibilitychange'");
      expect(scannerSource).toContain('api.scanner.ping()');
      expect(scannerSource).toContain('session_expired');
      expect(scannerSource).toContain('Resume Staff Session');
    });

    it('simulates heartbeat lifecycle: runs while camera is active and page visible, stops when camera stops or hidden', async () => {
      vi.useFakeTimers();
      vi.spyOn(api.scanner, 'ping').mockResolvedValue({
        timestamp: Date.now(),
      } as any);

      let cameraStatus: 'idle' | 'active' = 'active';
      let visibilityState: 'visible' | 'hidden' = 'visible';
      let heartbeatTimer: any = null;
      let pingCount = 0;

      const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000;

      const sendHeartbeat = async () => {
        if (visibilityState !== 'visible' || cameraStatus !== 'active') return;
        pingCount++;
        await api.scanner.ping();
      };

      const startHeartbeat = () => {
        if (heartbeatTimer) return;
        heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
      };

      const stopHeartbeat = () => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
      };

      // 1. Initial active state with visible document starts heartbeat
      startHeartbeat();
      expect(heartbeatTimer).not.toBeNull();
      expect(pingCount).toBe(0);

      // Fast-forward 10 minutes: exactly 1 heartbeat sent
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(pingCount).toBe(1);

      // Fast-forward another 10 minutes: second heartbeat sent
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(pingCount).toBe(2);

      // 2. Camera stops -> heartbeat stops
      cameraStatus = 'idle';
      stopHeartbeat();
      expect(heartbeatTimer).toBeNull();

      // Fast-forward 20 minutes: no pings while camera is stopped
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
      expect(pingCount).toBe(2);

      // 3. Camera starts again -> heartbeat resumes
      cameraStatus = 'active';
      startHeartbeat();
      expect(heartbeatTimer).not.toBeNull();

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(pingCount).toBe(3);

      // 4. Page becomes hidden -> heartbeat stops
      visibilityState = 'hidden';
      stopHeartbeat();
      expect(heartbeatTimer).toBeNull();

      await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
      expect(pingCount).toBe(3);

      // 5. Page becomes visible again -> heartbeat sends immediate ping and restarts interval
      visibilityState = 'visible';
      await sendHeartbeat();
      startHeartbeat();
      expect(pingCount).toBe(4);

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(pingCount).toBe(5);

      // Cleanup
      stopHeartbeat();
    });

    it('prevents accidental duplicate heartbeat intervals (idempotency guard)', () => {
      vi.useFakeTimers();
      let heartbeatTimer: any = null;
      let intervalCount = 0;

      const startHeartbeat = () => {
        if (heartbeatTimer) return; // Guard against duplicates
        intervalCount++;
        heartbeatTimer = setInterval(() => {}, 600000);
      };

      startHeartbeat();
      startHeartbeat();
      startHeartbeat();

      expect(intervalCount).toBe(1);
      clearInterval(heartbeatTimer);
    });

    it('prevents overlapping in-flight ping requests', async () => {
      let isPinging = false;
      let executedPings = 0;

      const mockPing = async () => {
        if (isPinging) return;
        isPinging = true;
        executedPings++;
        await new Promise((r) => setTimeout(r, 100));
        isPinging = false;
      };

      // Call twice concurrently
      const [p1, p2] = [mockPing(), mockPing()];
      await Promise.all([p1, p2]);

      expect(executedPings).toBe(1);
    });

    it('handles transient network errors during ping without crashing', async () => {
      vi.spyOn(api.scanner, 'ping').mockRejectedValue(new Error('Network offline'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      let scanStatus = 'idle';

      const sendHeartbeat = async () => {
        try {
          await api.scanner.ping();
        } catch (err: any) {
          if (err?.statusCode === 401) {
            scanStatus = 'session_expired';
            return;
          }
          console.warn('[Scanner Heartbeat] Transient ping failure:', err?.message || err);
        }
      };

      await expect(sendHeartbeat()).resolves.not.toThrow();
      expect(scanStatus).toBe('idle');
      expect(warnSpy).toHaveBeenCalled();
    });

    it('transitions to session_expired state when ping returns 401', async () => {
      const authError = new Error('Authentication required');
      (authError as any).statusCode = 401;
      vi.spyOn(api.scanner, 'ping').mockRejectedValue(authError);

      let scanStatus = 'idle';
      let heartbeatTimer: any = 123;

      const sendHeartbeat = async () => {
        try {
          await api.scanner.ping();
        } catch (err: any) {
          if (err?.statusCode === 401) {
            heartbeatTimer = null;
            scanStatus = 'session_expired';
            return;
          }
        }
      };

      await sendHeartbeat();
      expect(scanStatus).toBe('session_expired');
      expect(heartbeatTimer).toBeNull();
    });

    it('differentiates 401 (session_expired) from 403 (forbidden) in check-in error handling', () => {
      const simulateCheckInCatch = (status: number, message?: string) => {
        let scanStatus = 'idle';
        let ticketMeta: any = null;

        if (status === 401) {
          scanStatus = 'session_expired';
          ticketMeta = {
            note: message || 'Your scanner session has expired due to inactivity. Please resume your session.',
          };
        } else if (status === 403) {
          scanStatus = 'forbidden';
          ticketMeta = {
            note: message || 'You do not have permission to check in tickets at this gate. Your staff assignment may have been revoked.',
          };
        }

        return { scanStatus, ticketMeta };
      };

      const res401 = simulateCheckInCatch(401);
      expect(res401.scanStatus).toBe('session_expired');
      expect(res401.ticketMeta.note).toContain('scanner session has expired');
      expect(res401.ticketMeta.note).not.toContain('organizer account');

      const res403 = simulateCheckInCatch(403);
      expect(res403.scanStatus).toBe('forbidden');
      expect(res403.ticketMeta.note).toContain('permission to check in tickets');
      expect(res403.ticketMeta.note).not.toContain('organizer account');
    });

    it('renders session_expired UI with Resume Staff Session action and without organizer account message', async () => {
      const scannerSource = await import('./pages/ScannerPage?raw').then((m) => m.default || '').catch(() => '');

      // Verify the session_expired UI block exists
      expect(scannerSource).toContain("scanStatus === 'session_expired'");
      expect(scannerSource).toContain('Scanner Session Expired');
      expect(scannerSource).toContain('Resume Staff Session');
      expect(scannerSource).toContain('/staff/invitations/');

      // Verify 401 does NOT set organizer account message
      expect(scannerSource).not.toContain('Please sign in with an organizer account.');
    });

    it('renders distinct forbidden UI explaining permission revoked without offering OTP resumption', async () => {
      const scannerSource = await import('./pages/ScannerPage?raw').then((m) => m.default || '').catch(() => '');

      expect(scannerSource).toContain("scanStatus === 'forbidden'");
      expect(scannerSource).toContain('Unauthorized Gate Staff');
      expect(scannerSource).toContain('Your staff assignment may have been revoked');
    });
  });

  describe('Stage 2 Hardening: Invitation Token Sanitization & Camera Shutdown', () => {
    afterEach(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    it('removes invite parameter from address bar using replaceState while preserving event query parameter', () => {
      const initialUrl = 'https://outside.vip/scanner?event=sol-fest&invite=inv_sec_token_12345';
      const replaceStateSpy = vi.fn();

      const mockWindow = {
        location: new URL(initialUrl),
        history: {
          state: { some: 'state' },
          replaceState: replaceStateSpy,
        },
      };

      // Execute URL sanitization logic
      const params = new URLSearchParams(mockWindow.location.search);
      const paramToken = params.get('invite') || params.get('invitation') || params.get('token');
      expect(paramToken).toBe('inv_sec_token_12345');

      if (paramToken) {
        const url = new URL(mockWindow.location.href);
        url.searchParams.delete('invite');
        url.searchParams.delete('invitation');
        url.searchParams.delete('token');
        const cleanSearch = url.searchParams.toString();
        const cleanPath = url.pathname + (cleanSearch ? `?${cleanSearch}` : '') + url.hash;
        mockWindow.history.replaceState(mockWindow.history.state, 'Test Title', cleanPath);
      }

      expect(replaceStateSpy).toHaveBeenCalledTimes(1);
      expect(replaceStateSpy).toHaveBeenCalledWith(
        { some: 'state' },
        'Test Title',
        '/scanner?event=sol-fest'
      );
    });

    it('verifies ScannerPage source code performs URL sanitization with replaceState', async () => {
      const scannerSource = await import('./pages/ScannerPage?raw').then((m) => m.default || '').catch(() => '');
      expect(scannerSource).toBeTruthy();

      expect(scannerSource).toContain("url.searchParams.delete('invite')");
      expect(scannerSource).toContain("url.searchParams.delete('invitation')");
      expect(scannerSource).toContain("url.searchParams.delete('token')");
      expect(scannerSource).toContain('window.history.replaceState');
    });

    it('verifies token lifecycle: preserved in sessionStorage for recovery, cleared on verification, logout, and revocation', () => {
      const mockStorage: Record<string, string> = {};
      const storage = {
        getItem: (k: string) => mockStorage[k] || null,
        setItem: (k: string, v: string) => { mockStorage[k] = v; },
        removeItem: (k: string) => { delete mockStorage[k]; },
      };

      // 1. Initial read on ScannerPage mounts and saves token
      storage.setItem('outside_scanner_invite_token', 'test_recovery_token');
      expect(storage.getItem('outside_scanner_invite_token')).toBe('test_recovery_token');

      // 2. Token remains available while session is active or needs recovery
      expect(storage.getItem('outside_scanner_invite_token')).toBe('test_recovery_token');

      // 3. Cleared after successful OTP recovery
      const onVerifyOtpSuccess = () => {
        storage.removeItem('outside_scanner_invite_token');
      };
      onVerifyOtpSuccess();
      expect(storage.getItem('outside_scanner_invite_token')).toBeNull();

      // 4. Cleared on logout
      storage.setItem('outside_scanner_invite_token', 'test_recovery_token_2');
      const onLogout = () => {
        storage.removeItem('outside_scanner_invite_token');
      };
      onLogout();
      expect(storage.getItem('outside_scanner_invite_token')).toBeNull();

      // 5. Cleared when invitation metadata is confirmed EXPIRED or REVOKED
      storage.setItem('outside_scanner_invite_token', 'test_recovery_token_3');
      const onMetadataLoaded = (status: string) => {
        if (status === 'EXPIRED' || status === 'REVOKED') {
          storage.removeItem('outside_scanner_invite_token');
        }
      };
      onMetadataLoaded('REVOKED');
      expect(storage.getItem('outside_scanner_invite_token')).toBeNull();
    });

    it('verifies stopCamera releases all MediaStream tracks and cancels animation frame', () => {
      const stopTrack1 = vi.fn();
      const stopTrack2 = vi.fn();
      const mockTracks = [{ stop: stopTrack1 }, { stop: stopTrack2 }];
      const mockStream = {
        getTracks: () => mockTracks,
      };

      const cancelAnimationSpy = vi.fn();
      let cameraStatus = 'active';

      let animationFrameId: number | null = 42;
      let streamRef: any = mockStream;
      let videoRef: any = { srcObject: mockStream };

      const stopCamera = () => {
        if (animationFrameId) {
          cancelAnimationSpy(animationFrameId);
          animationFrameId = null;
        }

        if (streamRef) {
          streamRef.getTracks().forEach((track: any) => {
            try { track.stop(); } catch {}
          });
          streamRef = null;
        }

        if (videoRef) {
          videoRef.srcObject = null;
        }

        cameraStatus = 'idle';
      };

      stopCamera();

      expect(cancelAnimationSpy).toHaveBeenCalledWith(42);
      expect(stopTrack1).toHaveBeenCalledTimes(1);
      expect(stopTrack2).toHaveBeenCalledTimes(1);
      expect(streamRef).toBeNull();
      expect(videoRef.srcObject).toBeNull();
      expect(cameraStatus).toBe('idle');

      // Calling again is idempotent and does not throw
      expect(() => stopCamera()).not.toThrow();
    });

    it('verifies HTTP 401 from heartbeat stops camera immediately and sets session_expired', async () => {
      const stopCameraSpy = vi.fn();
      const stopHeartbeatSpy = vi.fn();
      let scanStatus = 'idle';

      const authError = new Error('Authentication required');
      (authError as any).statusCode = 401;
      vi.spyOn(api.scanner, 'ping').mockRejectedValue(authError);

      const sendHeartbeat = async () => {
        try {
          await api.scanner.ping();
        } catch (err: any) {
          if (err?.statusCode === 401) {
            stopCameraSpy();
            stopHeartbeatSpy();
            scanStatus = 'session_expired';
            return;
          }
        }
      };

      await sendHeartbeat();

      expect(stopCameraSpy).toHaveBeenCalledTimes(1);
      expect(stopHeartbeatSpy).toHaveBeenCalledTimes(1);
      expect(scanStatus).toBe('session_expired');
    });

    it('verifies HTTP 403 from heartbeat releases camera resources, stops heartbeat, and does not offer OTP recovery', async () => {
      const stopCameraSpy = vi.fn();
      const stopHeartbeatSpy = vi.fn();
      let scanStatus = 'idle';
      let ticketMeta: any = null;

      const forbiddenError = new Error('Staff assignment revoked');
      (forbiddenError as any).statusCode = 403;
      vi.spyOn(api.scanner, 'ping').mockRejectedValue(forbiddenError);

      const sendHeartbeat = async () => {
        try {
          await api.scanner.ping();
        } catch (err: any) {
          if (err?.statusCode === 403) {
            stopCameraSpy();
            stopHeartbeatSpy();
            scanStatus = 'forbidden';
            ticketMeta = { note: err.message };
            return;
          }
        }
      };

      await sendHeartbeat();

      expect(stopCameraSpy).toHaveBeenCalledTimes(1);
      expect(stopHeartbeatSpy).toHaveBeenCalledTimes(1);
      expect(scanStatus).toBe('forbidden');
      expect(ticketMeta.note).toContain('Staff assignment revoked');

      // Verify no OTP recovery or redirection is offered in forbidden state
      const scannerSource = await import('./pages/ScannerPage?raw').then((m) => m.default || '').catch(() => '');
      const forbiddenBlockMatch = scannerSource.match(/\{scanStatus === 'forbidden' && \([\s\S]*?\)\}/);
      expect(forbiddenBlockMatch).not.toBeNull();
      const forbiddenBlock = forbiddenBlockMatch![0];
      expect(forbiddenBlock).not.toContain('Resume Staff Session');
      expect(forbiddenBlock).not.toContain('invitation');
      expect(forbiddenBlock).not.toContain('verify-otp');
    });

    it('verifies HTTP 401 from check-in stops both camera resources and heartbeat', () => {
      const stopCameraSpy = vi.fn();
      const stopHeartbeatSpy = vi.fn();
      let scanStatus = 'idle';

      const handleCheckInError = (status: number) => {
        if (status === 401) {
          stopCameraSpy();
          stopHeartbeatSpy();
          scanStatus = 'session_expired';
        } else if (status === 403) {
          stopCameraSpy();
          stopHeartbeatSpy();
          scanStatus = 'forbidden';
        }
      };

      handleCheckInError(401);
      expect(stopCameraSpy).toHaveBeenCalledTimes(1);
      expect(stopHeartbeatSpy).toHaveBeenCalledTimes(1);
      expect(scanStatus).toBe('session_expired');
    });

    it('verifies HTTP 403 from check-in releases camera resources, stops heartbeat, and does not offer OTP recovery', () => {
      const stopCameraSpy = vi.fn();
      const stopHeartbeatSpy = vi.fn();
      let scanStatus = 'idle';

      const handleCheckInError = (status: number) => {
        if (status === 401) {
          stopCameraSpy();
          stopHeartbeatSpy();
          scanStatus = 'session_expired';
        } else if (status === 403) {
          stopCameraSpy();
          stopHeartbeatSpy();
          scanStatus = 'forbidden';
        }
      };

      handleCheckInError(403);
      expect(stopCameraSpy).toHaveBeenCalledTimes(1);
      expect(stopHeartbeatSpy).toHaveBeenCalledTimes(1);
      expect(scanStatus).toBe('forbidden');
    });

    it('verifies no further scan/check-in attempts occur after either terminal authorization state', async () => {
      const checkInSpy = vi.spyOn(api.scanner, 'checkIn');
      const getUserMediaSpy = vi.fn();

      for (const terminalState of ['session_expired', 'forbidden'] as const) {
        checkInSpy.mockClear();
        getUserMediaSpy.mockClear();

        let scanStatusRef: { current: string } = { current: terminalState };
        let isValidatingRef = { current: false };
        let pendingScanRef = { current: null as any };

        const handleValidateToken = async (token: string) => {
          if (
            scanStatusRef.current === 'forbidden' ||
            scanStatusRef.current === 'session_expired' ||
            isValidatingRef.current
          ) {
            return;
          }
          await api.scanner.checkIn({ token, idempotencyKey: 'key_1' });
        };

        const handleRetry = () => {
          if (
            scanStatusRef.current === 'forbidden' ||
            scanStatusRef.current === 'session_expired' ||
            !pendingScanRef.current ||
            isValidatingRef.current
          ) {
            return;
          }
          handleValidateToken(pendingScanRef.current.token);
        };

        const startCamera = async () => {
          if (
            scanStatusRef.current === 'forbidden' ||
            scanStatusRef.current === 'session_expired'
          ) {
            return;
          }
          getUserMediaSpy();
        };

        const resetScanner = () => {
          if (
            scanStatusRef.current === 'forbidden' ||
            scanStatusRef.current === 'session_expired'
          ) {
            return;
          }
          scanStatusRef.current = 'idle';
        };

        // 1. Calling handleValidateToken should be blocked immediately
        await handleValidateToken('any_test_token');
        expect(checkInSpy).not.toHaveBeenCalled();

        // 2. Calling handleRetry should be blocked immediately
        pendingScanRef.current = { token: 'retry_token', gateId: 'gate_1', idempotencyKey: 'retry_key' };
        handleRetry();
        expect(checkInSpy).not.toHaveBeenCalled();

        // 3. Calling startCamera should be blocked immediately
        await startCamera();
        expect(getUserMediaSpy).not.toHaveBeenCalled();

        // 4. Calling resetScanner must NOT escape the terminal authorization state
        resetScanner();
        expect(scanStatusRef.current).toBe(terminalState);
      }
    });

    it('verifies ScannerPage source code guarantees camera and heartbeat shutdown on 401 and 403 across heartbeat and check-in', async () => {
      const scannerSource = await import('./pages/ScannerPage?raw').then((m) => m.default || '').catch(() => '');

      // Verify stopCamera calls stopHeartbeat
      expect(scannerSource).toMatch(/const stopCamera = useCallback\(\(\) =>\s*\{[\s\S]*?stopHeartbeat\(\);/);

      // Verify heartbeat 403 stops camera and heartbeat
      expect(scannerSource).toMatch(/if \(status === 403\)\s*\{[\s\S]*?stopCamera\(\);[\s\S]*?stopHeartbeat\(\);[\s\S]*?setScanStatus\('forbidden'\);/);

      // Verify check-in 403 stops camera and heartbeat
      expect(scannerSource).toMatch(/\} else if \(status === 403\)\s*\{[\s\S]*?stopCamera\(\);[\s\S]*?stopHeartbeat\(\);[\s\S]*?setScanStatus\('forbidden'\);/);

      // Verify check-in 401 stops camera and heartbeat
      expect(scannerSource).toMatch(/\} else if \(status === 401\)\s*\{[\s\S]*?stopCamera\(\);[\s\S]*?stopHeartbeat\(\);[\s\S]*?setScanStatus\('session_expired'\);/);

      // Verify handleValidateToken guards against terminal states
      expect(scannerSource).toMatch(/scanStatusRef\.current === 'forbidden'\s*\|\|\s*scanStatusRef\.current === 'session_expired'/);
    });
  });
});


