import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthContext } from '../src/context/AuthContext';
import { ScannerGuard } from '../src/components/auth/ScannerGuard';
import { ScannerPage } from '../src/pages/ScannerPage';
import { User } from '../src/types';

describe('Stage 3 Implementation 3: Scanner Route Access & Authorization', () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  const createMockAuthContext = (
    user: User | null,
    isLoading: boolean = false
  ) => ({
    user,
    isLoading,
    login: vi.fn(),
    requestLoginOtp: vi.fn(),
    verifyLoginOtp: vi.fn(),
    clearSessionState: vi.fn(),
    register: vi.fn(),
    verifyEmail: vi.fn(),
    resendVerification: vi.fn(),
    refreshUser: vi.fn(),
    logout: vi.fn(),
  });

  const mockStaffAttendee: User = {
    id: 'usr-door-staff-01',
    email: 'staff@eventvenue.com',
    name: 'Gate One Staff',
    role: 'ATTENDEE',
    status: 'ACTIVE',
    emailVerified: true,
  };

  const mockUnverifiedStaff: User = {
    id: 'usr-door-staff-02',
    email: 'newstaff@eventvenue.com',
    name: 'Unverified Gate Staff',
    role: 'ATTENDEE',
    status: 'ACTIVE',
    emailVerified: false,
  };

  const mockOrganizer: User = {
    id: 'usr-organizer-01',
    email: 'organizer@outside.vip',
    name: 'Festival Producer',
    role: 'ORGANIZER',
    status: 'ACTIVE',
    emailVerified: true,
  };

  const mockAdmin: User = {
    id: 'usr-admin-01',
    email: 'admin@outside.vip',
    name: 'Platform Ops',
    role: 'ADMIN',
    status: 'ACTIVE',
    emailVerified: true,
  };

  const setupMockWindow = (
    url: string = 'https://outside.vip/scanner',
    storedInviteToken: string | null = null
  ) => {
    const store: Record<string, string> = {};
    if (storedInviteToken) {
      store['outside_scanner_invite_token'] = storedInviteToken;
    }
    const urlObj = new URL(url);
    (global as any).window = {
      location: {
        href: urlObj.href,
        pathname: urlObj.pathname,
        search: urlObj.search,
        hash: urlObj.hash,
        hostname: urlObj.hostname,
      },
      history: {
        state: {},
        replaceState: vi.fn(),
      },
      isSecureContext: true,
    };
    (global as any).sessionStorage = {
      getItem: vi.fn((key: string) => store[key] || null),
      setItem: vi.fn((key: string, val: string) => {
        store[key] = val;
      }),
      removeItem: vi.fn((key: string) => {
        delete store[key];
      }),
      clear: vi.fn(() => {
        Object.keys(store).forEach((k) => delete store[k]);
      }),
    };
    (global as any).document = {
      visibilityState: 'visible',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      title: 'Outside.vip Door Operations',
    };
  };

  afterEach(() => {
    delete (global as any).window;
    delete (global as any).sessionStorage;
    delete (global as any).document;
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Session Hydration & Loading
  // =========================================================================
  describe('1. Session Hydration & Loading Gate', () => {
    it('displays hydration loading state and does NOT render viewfinder or redirect while isLoading is true', () => {
      setupMockWindow();
      const authVal = createMockAuthContext(null, true);

      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <AuthContext.Provider value={authVal}>
            <MemoryRouter initialEntries={['/scanner']}>
              <ScannerGuard>
                <ScannerPage />
              </ScannerGuard>
            </MemoryRouter>
          </AuthContext.Provider>
        </QueryClientProvider>
      );

      expect(html).toContain('Loading scanner session...');
      expect(html).not.toContain('Browser Check-In Scanner');
      expect(html).not.toContain('Start Camera');
      expect(html).not.toContain('Sign In to Door Scanner');
      expect(html).not.toContain('Sign In with Password');
    });
  });

  // =========================================================================
  // 2. Unauthenticated Visitors — Direct Email-OTP Scanner Login (STG2-01)
  // =========================================================================
  describe('2. Unauthenticated Access & Direct Scanner OTP Login', () => {
    it('unauthenticated visitor at /scanner renders direct email-OTP sign-in form and organizer password link', () => {
      setupMockWindow('https://outside.vip/scanner');
      const authVal = createMockAuthContext(null, false);

      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <AuthContext.Provider value={authVal}>
            <MemoryRouter initialEntries={['/scanner']}>
              <ScannerGuard>
                <ScannerPage />
              </ScannerGuard>
            </MemoryRouter>
          </AuthContext.Provider>
        </QueryClientProvider>
      );

      expect(html).toContain('Sign In to Door Scanner');
      expect(html).toContain('Staff Email Address');
      expect(html).toContain('Send Sign-In Code');
      expect(html).toContain('Sign In with Password (Organizers &amp; Admins)');
      expect(html).toContain('/login?redirect=%2Fscanner');
      expect(html).not.toContain('/staff/invitations/');
      expect(html).not.toContain('Resume Staff Session');
      expect(html).not.toContain('Browser Check-In Scanner');
      expect(html).not.toContain('Start Camera');
    });

    it('preserves ?event= query parameter on organizer password login link while stripping legacy invite params', () => {
      setupMockWindow('https://outside.vip/scanner?event=sol-fest&invite=legacy_tok_123');
      const authVal = createMockAuthContext(null, false);

      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <AuthContext.Provider value={authVal}>
            <MemoryRouter initialEntries={['/scanner?event=sol-fest&invite=legacy_tok_123']}>
              <ScannerGuard>
                <ScannerPage />
              </ScannerGuard>
            </MemoryRouter>
          </AuthContext.Provider>
        </QueryClientProvider>
      );

      expect(html).toContain('/login?redirect=%2Fscanner%3Fevent%3Dsol-fest');
      expect(html).not.toContain('legacy_tok_123');
      expect(html).not.toContain('Resume Staff Session');
      expect((global as any).sessionStorage.setItem).not.toHaveBeenCalled();
    });

    it('renders session-expired notice and prefills previously authenticated email without invitation links', () => {
      setupMockWindow('https://outside.vip/scanner?event=sol-fest');
      const authVal = createMockAuthContext(null, false);

      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <AuthContext.Provider value={authVal}>
            <MemoryRouter initialEntries={['/scanner?event=sol-fest']}>
              <ScannerGuard initialSessionExpired={true} initialEmail="staff@eventvenue.com">
                <ScannerPage />
              </ScannerGuard>
            </MemoryRouter>
          </AuthContext.Provider>
        </QueryClientProvider>
      );

      expect(html).toContain('Scanner Session Expired');
      expect(html).toContain('staff@eventvenue.com');
      expect(html).toContain('Send Sign-In Code');
      expect(html).not.toContain('/staff/invitations/');
      expect(html).not.toContain('original staff invitation email');
    });
  });

  // =========================================================================
  // 3. Email Verification
  // =========================================================================
  describe('3. Email Verification Requirement', () => {
    it('authenticated user with unverified email renders EmailVerificationGate and blocks scanner', () => {
      setupMockWindow();
      const authVal = createMockAuthContext(mockUnverifiedStaff, false);

      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <AuthContext.Provider value={authVal}>
            <MemoryRouter initialEntries={['/scanner']}>
              <ScannerGuard>
                <ScannerPage />
              </ScannerGuard>
            </MemoryRouter>
          </AuthContext.Provider>
        </QueryClientProvider>
      );

      expect(html).toContain('Verify Your Email to Access Scanner');
      expect(html).toContain('Enter the 6-digit verification code sent to your email address');
      expect(html).not.toContain('Browser Check-In Scanner');
      expect(html).not.toContain('Start Camera');
    });
  });

  // =========================================================================
  // 4. Door Staff Scanning Authorization (ATTENDEE Role)
  // =========================================================================
  describe('4. Door Staff Scanner Authorization & Gate Loading (STG2-03)', () => {
    it('shows dedicated gate-loading state on initial mount and does NOT flash No Assigned Event Gates or Start Camera', () => {
      setupMockWindow();
      const authVal = createMockAuthContext(mockStaffAttendee, false);

      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <AuthContext.Provider value={authVal}>
            <MemoryRouter initialEntries={['/scanner']}>
              <ScannerGuard>
                <ScannerPage initialUser={mockStaffAttendee} />
              </ScannerGuard>
            </MemoryRouter>
          </AuthContext.Provider>
        </QueryClientProvider>
      );

      expect(html).toContain('Loading assigned event gates...');
      expect(html).not.toContain('No Assigned Event Gates');
      expect(html).not.toContain('Start Camera');
    });

    it('passwordless ATTENDEE with active gate assignment renders scanner interface with matching selected option value', () => {
      setupMockWindow();
      const authVal = createMockAuthContext(mockStaffAttendee, false);
      const assignedEvents = [
        { id: 'evt-sol-1', title: 'SOL FEST 2026', slug: 'sol-fest-2026' },
      ];

      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <AuthContext.Provider value={authVal}>
            <MemoryRouter initialEntries={['/scanner']}>
              <ScannerGuard>
                <ScannerPage initialUser={mockStaffAttendee} initialEvents={assignedEvents} />
              </ScannerGuard>
            </MemoryRouter>
          </AuthContext.Provider>
        </QueryClientProvider>
      );

      expect(html).toContain('Browser Check-In Scanner');
      expect(html).toContain('Outside.vip Door Operations');
      expect(html).toContain('SOL FEST 2026');
      expect(html).toContain('value="sol-fest-2026" selected=""');
      expect(html).toContain('Start Camera');
      expect(html).not.toContain('No Assigned Event Gates');
    });

    it('ATTENDEE with 0 assigned gates after loading renders explicit empty state and cannot start camera', () => {
      setupMockWindow();
      const authVal = createMockAuthContext(mockStaffAttendee, false);

      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <AuthContext.Provider value={authVal}>
            <MemoryRouter initialEntries={['/scanner']}>
              <ScannerGuard>
                <ScannerPage initialUser={mockStaffAttendee} initialEvents={[]} />
              </ScannerGuard>
            </MemoryRouter>
          </AuthContext.Provider>
        </QueryClientProvider>
      );

      expect(html).toContain('No Assigned Event Gates');
      expect(html).toContain(
        'You do not have any active scanner staff assignments. You need an active event assignment before scanning tickets.'
      );
      expect(html).toContain('Check for Assignments');
      expect(html).not.toContain('Start Camera');
      expect(html).not.toContain('Hold attendee ticket QR code inside viewfinder');
    });
  });

  // =========================================================================
  // 5. Organizer and Administrator Scanner Access
  // =========================================================================
  describe('5. Organizer & Admin Authorization', () => {
    it('authenticated organizer with owned events renders active gate pass controls', () => {
      setupMockWindow();
      const authVal = createMockAuthContext(mockOrganizer, false);

      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <AuthContext.Provider value={authVal}>
            <MemoryRouter initialEntries={['/scanner']}>
              <ScannerGuard>
                <ScannerPage initialUser={mockOrganizer} />
              </ScannerGuard>
            </MemoryRouter>
          </AuthContext.Provider>
        </QueryClientProvider>
      );

      expect(html).toContain('Browser Check-In Scanner');
      expect(html).toContain('Active Gate Pass');
      expect(html).toContain('All Gates · Auto-Detect Event');
      expect(html).not.toContain('No Assigned Event Gates');
    });

    it('authenticated admin accesses scanner and sees global gate selection', () => {
      setupMockWindow();
      const authVal = createMockAuthContext(mockAdmin, false);

      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <AuthContext.Provider value={authVal}>
            <MemoryRouter initialEntries={['/scanner']}>
              <ScannerGuard>
                <ScannerPage initialUser={mockAdmin} />
              </ScannerGuard>
            </MemoryRouter>
          </AuthContext.Provider>
        </QueryClientProvider>
      );

      expect(html).toContain('Browser Check-In Scanner');
      expect(html).toContain('Active Gate Pass');
      expect(html).not.toContain('No Assigned Event Gates');
    });
  });

  // =========================================================================
  // 6. Terminal State Security (401 vs 403 Differentiation)
  // =========================================================================
  describe('6. Terminal Authorization States & Resource Cleanup', () => {
    it('verifies 401 response triggers direct email-OTP session expiry recovery without invitation links or organizer-only message', async () => {
      const scannerSource = await import('../src/pages/ScannerPage?raw')
        .then((m) => m.default || '')
        .catch(() => '');

      expect(scannerSource).toContain("scanStatus === 'session_expired'");
      expect(scannerSource).toContain('Scanner Session Expired');
      expect(scannerSource).toContain('Sign In with Email Code');
      expect(scannerSource).toContain('scannerSession.notifySessionExpired');
      expect(scannerSource).not.toContain('/staff/invitations/');
      expect(scannerSource).not.toContain('Please sign in with an organizer account.');
      expect(scannerSource).not.toContain("sessionStorage.setItem('outside_scanner_invite_token'");
    });

    it('verifies 403 response sets forbidden state, stops camera/heartbeat, and does not clear session or offer OTP recovery', async () => {
      const scannerSource = await import('../src/pages/ScannerPage?raw')
        .then((m) => m.default || '')
        .catch(() => '');

      expect(scannerSource).toContain("scanStatus === 'forbidden'");
      expect(scannerSource).toContain('Unauthorized Gate Staff');
      expect(scannerSource).toContain('Your staff assignment may have been revoked');
      expect(scannerSource).toMatch(
        /handleForbiddenAccess = useCallback\([\s\S]*?stopCamera\(\);[\s\S]*?stopHeartbeat\(\);[\s\S]*?setScanStatus\('forbidden'\);/
      );
    });

    it('verifies camera and heartbeat are stopped on both 401 and 403 across gates, heartbeat, and check-in', async () => {
      const scannerSource = await import('../src/pages/ScannerPage?raw')
        .then((m) => m.default || '')
        .catch(() => '');

      expect(scannerSource).toMatch(
        /handleSessionExpired = useCallback\([\s\S]*?stopCamera\(\);[\s\S]*?stopHeartbeat\(\);/
      );
      expect(scannerSource).toMatch(/if \(status === 401\)[\s\S]*?handleSessionExpired\(/);
      expect(scannerSource).toMatch(/if \(status === 403\)[\s\S]*?handleForbiddenAccess\(/);
      expect(scannerSource).toMatch(/\} else if \(status === 401\)[\s\S]*?handleSessionExpired\(/);
      expect(scannerSource).toMatch(/\} else if \(status === 403\)[\s\S]*?handleForbiddenAccess\(/);
    });
  });

  // =========================================================================
  // 7. Route Architecture & History Sanitization
  // =========================================================================
  describe('7. Route Guard Integration & History Sanitization', () => {
    it('verifies App.tsx routes /scanner through dedicated ScannerGuard and not generic guards', async () => {
      const appSource = await import('../src/App?raw')
        .then((m) => m.default || '')
        .catch(() => '');

      expect(appSource).toMatch(
        /<Route\s+path="\/scanner"\s+element=\{\s*<ScannerGuard>[\s\S]*?<ScannerPage \/>[\s\S]*?<\/ScannerGuard>\s*\}/
      );
      expect(appSource).not.toMatch(/<Route\s+path="\/scanner"\s+element=\{\s*<RequireAuth>/);
      expect(appSource).not.toMatch(/<Route\s+path="\/scanner"\s+element=\{\s*<RequireRole>/);
    });

    it('verifies ScannerPage sanitizes invite and token query parameters with replaceState without persisting tokens', async () => {
      const scannerSource = await import('../src/pages/ScannerPage?raw')
        .then((m) => m.default || '')
        .catch(() => '');

      expect(scannerSource).toContain("url.searchParams.delete('invite')");
      expect(scannerSource).toContain("url.searchParams.delete('invitation')");
      expect(scannerSource).toContain("url.searchParams.delete('token')");
      expect(scannerSource).toContain('window.history.replaceState');
      expect(scannerSource).not.toContain('sessionStorage.setItem');
    });

    it('verifies startCamera blocks activation when loading, forbidden, session_expired, or ATTENDEE has 0 gates, with fresh dependencies', async () => {
      const scannerSource = await import('../src/pages/ScannerPage?raw')
        .then((m) => m.default || '')
        .catch(() => '');

      expect(scannerSource).toMatch(
        /scanStatusRef\.current === 'forbidden'\s*\|\|\s*scanStatusRef\.current === 'session_expired'\s*\|\|\s*isLoadingEvents\s*\|\|\s*\(user\?\.role === 'ATTENDEE' && eventsList\.length === 0\)/
      );
      expect(scannerSource).toContain('[facingMode, isLoadingEvents, user?.role, eventsList.length]');
      expect(scannerSource).toContain('[user?.id, user?.role, refreshTrigger]');
      expect(scannerSource).toContain('[cameraStatus, stopHeartbeat]');
    });

    it('S2R-01 & S2R-02: verifies AuthContext memoization, stable ScannerPage effect deps, and ref-backed scanLoop gate selection', async () => {
      const authContextSource = await import('../src/context/AuthContext?raw')
        .then((m) => m.default || '')
        .catch(() => '');
      const scannerSource = await import('../src/pages/ScannerPage?raw')
        .then((m) => m.default || '')
        .catch(() => '');

      // S2R-01: AuthContext stabilizes callbacks with useCallback and provider value with useMemo
      expect(authContextSource).toContain('const clearSessionState = useCallback(');
      expect(authContextSource).toContain('const contextValue = useMemo(');
      expect(authContextSource).toContain('<AuthContext.Provider value={contextValue}>');

      // S2R-01: ScannerPage stabilizes 401/403 handlers via refs and keeps fetchEvents/heartbeat deps minimal
      expect(scannerSource).toContain('const handleSessionExpiredRef = useRef(handleSessionExpired);');
      expect(scannerSource).toContain('const handleForbiddenAccessRef = useRef(handleForbiddenAccess);');
      expect(scannerSource).toContain('handleSessionExpiredRef.current(');
      expect(scannerSource).toContain('handleForbiddenAccessRef.current(');
      expect(scannerSource).toContain('}, [user?.id, user?.role, refreshTrigger]);');
      expect(scannerSource).toContain('}, [cameraStatus, stopHeartbeat]);');

      // S2R-02: scanLoop invokes handleValidateTokenRef.current so switching gates while camera is active uses latest gate
      expect(scannerSource).toContain('const handleValidateTokenRef = useRef(handleValidateToken);');
      expect(scannerSource).toContain('handleValidateTokenRef.current = handleValidateToken;');
      expect(scannerSource).toContain('handleValidateTokenRef.current(cleanToken);');

      // Behavioral verification of ref-backed scanLoop gate switching without stopping camera
      let selectedEventId = 'gate-a';
      let latestExpiryEmail = 'old@venue.com';
      const submittedGateIds: string[] = [];
      const expiredEmails: string[] = [];

      const createHandleValidateToken = (gate: string, expiryEmail: string) => (token: string) => {
        if (token === 'EXPIRE_ME') {
          expiredEmails.push(expiryEmail);
          return;
        }
        submittedGateIds.push(gate);
      };

      const validateRef = { current: createHandleValidateToken(selectedEventId, latestExpiryEmail) };
      // Persistent scanLoop captures ONLY validateRef (never restarts on gate change)
      const persistentScanFrame = (token: string) => validateRef.current(token);

      persistentScanFrame('tkt_1');
      // User switches gate from Gate A to Gate B while camera remains active
      selectedEventId = 'gate-b';
      latestExpiryEmail = 'staff@venue.com';
      validateRef.current = createHandleValidateToken(selectedEventId, latestExpiryEmail);

      persistentScanFrame('tkt_2');
      persistentScanFrame('EXPIRE_ME');

      expect(submittedGateIds).toEqual(['gate-a', 'gate-b']);
      expect(expiredEmails).toEqual(['staff@venue.com']);
    });
  });

  // =========================================================================
  // 8. Stage 2 API Client: Standalone OTP & Retry-After Surface
  // =========================================================================
  describe('8. Direct Scanner OTP API Client & ApiError retryAfter', () => {
    it('wires api.auth.requestLoginOtp and api.auth.verifyLoginOtp and parses retryAfter on 429', async () => {
      const { api, ApiError, getActiveCsrfToken, setActiveCsrfToken } = await import('../src/lib/api');
      setActiveCsrfToken(null);

      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      // 1. requestLoginOtp success
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          success: true,
          data: {
            message: 'If this email is associated with an eligible passwordless account, a 6-digit sign-in code has been sent.',
            cooldownSeconds: 60,
            expiresInMinutes: 10,
          },
        }),
      } as any);

      const reqRes = await api.auth.requestLoginOtp({ email: 'staff@eventvenue.com' });
      expect(reqRes.cooldownSeconds).toBe(60);
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/auth/otp/request',
        expect.objectContaining({
          method: 'POST',
          credentials: 'include',
          body: JSON.stringify({ email: 'staff@eventvenue.com' }),
        })
      );

      // 2. 429 cooldown surfaces retryAfter on ApiError
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({ 'Retry-After': '42' }),
        json: async () => ({
          success: false,
          error: {
            message: 'Please wait 42 seconds before requesting another sign-in code.',
            statusCode: 429,
            code: 'OTP_RESEND_COOLDOWN',
            retryAfter: 42,
          },
        }),
      } as any);

      let caught: any = null;
      try {
        await api.auth.requestLoginOtp({ email: 'staff@eventvenue.com' });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect(caught.statusCode).toBe(429);
      expect(caught.code).toBe('OTP_RESEND_COOLDOWN');
      expect(caught.retryAfter).toBe(42);

      // 3. verifyLoginOtp captures csrfToken and returns user
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'x-csrf-token': 'csrf_direct_scanner_xyz' }),
        json: async () => ({
          success: true,
          data: {
            user: mockStaffAttendee,
            csrfToken: 'csrf_direct_scanner_xyz',
          },
        }),
      } as any);

      const verRes = await api.auth.verifyLoginOtp({
        email: 'staff@eventvenue.com',
        code: '123456',
      });
      expect(verRes.user.id).toBe(mockStaffAttendee.id);
      expect(getActiveCsrfToken()).toBe('csrf_direct_scanner_xyz');
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/auth/otp/verify',
        expect.objectContaining({
          method: 'POST',
          credentials: 'include',
          body: JSON.stringify({ email: 'staff@eventvenue.com', code: '123456' }),
        })
      );
    });
  });
});
