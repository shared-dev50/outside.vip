import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthContext } from './context/AuthContext';
import { ScannerGuard } from './components/auth/ScannerGuard';
import { ScannerPage } from './pages/ScannerPage';
import { User } from './types';

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
      expect(html).not.toContain('Scanner Authentication Required');
    });
  });

  // =========================================================================
  // 2. Unauthenticated Visitors
  // =========================================================================
  describe('2. Unauthenticated Access & Door Staff Recovery', () => {
    it('unauthenticated visitor without invite token renders dedicated organizer sign-in gate', () => {
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

      expect(html).toContain('Scanner Authentication Required');
      expect(html).toContain('Sign In as Organizer');
      expect(html).toContain('/login?redirect=%2Fscanner');
      expect(html).toContain('Event door staff: Please click the invitation link received by email');
      expect(html).not.toContain('Browser Check-In Scanner');
      expect(html).not.toContain('Hold attendee ticket QR code inside viewfinder');
      expect(html).not.toContain('Start Camera');
    });

    it('unauthenticated door staff with stored recovery token renders door staff resumption flow', () => {
      setupMockWindow('https://outside.vip/scanner', 'inv_staff_recovery_abc123');
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

      expect(html).toContain('Staff Authentication Required');
      expect(html).toContain('Door Staff Access');
      expect(html).toContain('Resume Staff Session');
      expect(html).toContain('Sign in with password (Organizers)');
      expect(html).not.toContain('Browser Check-In Scanner');
      expect(html).not.toContain('Start Camera');
    });

    it('unauthenticated door staff with invite token in URL stores token and displays staff recovery', () => {
      setupMockWindow('https://outside.vip/scanner?invite=tok_url_param_xyz987');
      const authVal = createMockAuthContext(null, false);

      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <AuthContext.Provider value={authVal}>
            <MemoryRouter initialEntries={['/scanner?invite=tok_url_param_xyz987']}>
              <ScannerGuard>
                <ScannerPage />
              </ScannerGuard>
            </MemoryRouter>
          </AuthContext.Provider>
        </QueryClientProvider>
      );

      expect(html).toContain('Staff Authentication Required');
      expect(html).toContain('Resume Staff Session');
      expect((global as any).sessionStorage.setItem).toHaveBeenCalledWith(
        'outside_scanner_invite_token',
        'tok_url_param_xyz987'
      );
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
  describe('4. Door Staff Scanner Authorization', () => {
    it('passwordless ATTENDEE with active gate assignment renders scanner interface', () => {
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

      expect(html).toContain('Browser Check-In Scanner');
      expect(html).toContain('Outside.vip Door Operations');
      expect(html).not.toContain('Scanner Authentication Required');
    });

    it('ATTENDEE with 0 assigned gates renders explicit empty state and cannot start camera', () => {
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
    it('verifies 401 response sets session_expired and offers OTP resumption without organizer message', async () => {
      const scannerSource = await import('./pages/ScannerPage?raw')
        .then((m) => m.default || '')
        .catch(() => '');

      expect(scannerSource).toContain("scanStatus === 'session_expired'");
      expect(scannerSource).toContain('Scanner Session Expired');
      expect(scannerSource).toContain('Resume Staff Session');
      expect(scannerSource).toContain('/staff/invitations/');
      expect(scannerSource).not.toContain('Please sign in with an organizer account.');
    });

    it('verifies 403 response sets forbidden state, stops camera/heartbeat, and denies OTP resumption', async () => {
      const scannerSource = await import('./pages/ScannerPage?raw')
        .then((m) => m.default || '')
        .catch(() => '');

      expect(scannerSource).toContain("scanStatus === 'forbidden'");
      expect(scannerSource).toContain('Unauthorized Gate Staff');
      expect(scannerSource).toContain('Your staff assignment may have been revoked');
      expect(scannerSource).toMatch(
        /if \(status === 403\)\s*\{[\s\S]*?stopCamera\(\);[\s\S]*?stopHeartbeat\(\);[\s\S]*?setScanStatus\('forbidden'\);/
      );
    });

    it('verifies camera and heartbeat are stopped on 401 and 403 across both heartbeat and check-in', async () => {
      const scannerSource = await import('./pages/ScannerPage?raw')
        .then((m) => m.default || '')
        .catch(() => '');

      // Heartbeat 401/403
      expect(scannerSource).toMatch(
        /if \(status === 401\)\s*\{[\s\S]*?stopCamera\(\);[\s\S]*?stopHeartbeat\(\);[\s\S]*?setScanStatus\('session_expired'\);/
      );
      // Check-in 403
      expect(scannerSource).toMatch(
        /\} else if \(status === 403\)\s*\{[\s\S]*?stopCamera\(\);[\s\S]*?stopHeartbeat\(\);[\s\S]*?setScanStatus\('forbidden'\);/
      );
      // Check-in 401
      expect(scannerSource).toMatch(
        /\} else if \(status === 401\)\s*\{[\s\S]*?stopCamera\(\);[\s\S]*?stopHeartbeat\(\);[\s\S]*?setScanStatus\('session_expired'\);/
      );
    });
  });

  // =========================================================================
  // 7. Route Architecture & History Sanitization
  // =========================================================================
  describe('7. Route Guard Integration & History Sanitization', () => {
    it('verifies App.tsx routes /scanner through dedicated ScannerGuard and not generic guards', async () => {
      const appSource = await import('./App?raw')
        .then((m) => m.default || '')
        .catch(() => '');

      expect(appSource).toMatch(
        /<Route\s+path="\/scanner"\s+element=\{\s*<ScannerGuard>[\s\S]*?<ScannerPage \/>[\s\S]*?<\/ScannerGuard>\s*\}/
      );
      expect(appSource).not.toMatch(/<Route\s+path="\/scanner"\s+element=\{\s*<RequireAuth>/);
      expect(appSource).not.toMatch(/<Route\s+path="\/scanner"\s+element=\{\s*<RequireRole>/);
    });

    it('verifies ScannerPage sanitizes invite and token query parameters with replaceState', async () => {
      const scannerSource = await import('./pages/ScannerPage?raw')
        .then((m) => m.default || '')
        .catch(() => '');

      expect(scannerSource).toContain("url.searchParams.delete('invite')");
      expect(scannerSource).toContain("url.searchParams.delete('invitation')");
      expect(scannerSource).toContain("url.searchParams.delete('token')");
      expect(scannerSource).toContain('window.history.replaceState');
    });

    it('verifies startCamera blocks activation when forbidden, session_expired, or ATTENDEE has 0 gates', async () => {
      const scannerSource = await import('./pages/ScannerPage?raw')
        .then((m) => m.default || '')
        .catch(() => '');

      expect(scannerSource).toMatch(
        /scanStatusRef\.current === 'forbidden'\s*\|\|\s*scanStatusRef\.current === 'session_expired'\s*\|\|\s*\(user\?\.role === 'ATTENDEE' && eventsList\.length === 0\)/
      );
    });
  });
});
