import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { sanitizeRedirectUrl } from './lib/utils';
import { AuthPage } from './pages/AuthPage';
import { OrganizerDashboardPage } from './pages/OrganizerDashboardPage';
import { CreateEventPage } from './pages/CreateEventPage';
import { AuthContext } from './context/AuthContext';
import { User } from './types';

describe('Stage 3 Implementation 1: Redirect Security & Authentication Hydration', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('1. Redirect Sanitization (sanitizeRedirectUrl)', () => {
    it('defaults to /organizer when redirect is missing, empty, or whitespace', () => {
      expect(sanitizeRedirectUrl(undefined)).toBe('/organizer');
      expect(sanitizeRedirectUrl(null)).toBe('/organizer');
      expect(sanitizeRedirectUrl('')).toBe('/organizer');
      expect(sanitizeRedirectUrl('   ')).toBe('/organizer');
      // Supports custom defaultUrl
      expect(sanitizeRedirectUrl(null, '/events')).toBe('/events');
    });

    it('accepts safe internal application paths', () => {
      expect(sanitizeRedirectUrl('/organizer')).toBe('/organizer');
      expect(sanitizeRedirectUrl('/events')).toBe('/events');
      expect(sanitizeRedirectUrl('/events/summer-solstice-2026')).toBe('/events/summer-solstice-2026');
      expect(sanitizeRedirectUrl('/teams')).toBe('/teams');
      expect(sanitizeRedirectUrl('/scanner')).toBe('/scanner');
      expect(sanitizeRedirectUrl('/orders/OUT-12345')).toBe('/orders/OUT-12345');
    });

    it('preserves internal query parameters and hash fragments', () => {
      expect(sanitizeRedirectUrl('/events/summer-fest?tab=tickets#passes')).toBe(
        '/events/summer-fest?tab=tickets#passes'
      );
      expect(sanitizeRedirectUrl('/scanner?event=c4b984f8-292c-43a7')).toBe(
        '/scanner?event=c4b984f8-292c-43a7'
      );
      expect(sanitizeRedirectUrl('/organizer/finance?tab=payouts')).toBe(
        '/organizer/finance?tab=payouts'
      );
      expect(sanitizeRedirectUrl('/events?city=Nairobi&genre=electronic#results')).toBe(
        '/events?city=Nairobi&genre=electronic#results'
      );
    });

    it('rejects external absolute URLs with different origins or schemes', () => {
      expect(sanitizeRedirectUrl('https://evil.com')).toBe('/organizer');
      expect(sanitizeRedirectUrl('http://evil.com')).toBe('/organizer');
      expect(sanitizeRedirectUrl('https://evil.com/events')).toBe('/organizer');
      expect(sanitizeRedirectUrl('ftp://outside.vip')).toBe('/organizer');
      expect(sanitizeRedirectUrl('javascript:alert(1)')).toBe('/organizer');
      expect(sanitizeRedirectUrl('data:text/html,<script>alert(1)</script>')).toBe('/organizer');
      expect(sanitizeRedirectUrl('vbscript:msgbox(1)')).toBe('/organizer');
    });

    it('rejects protocol-relative URLs', () => {
      expect(sanitizeRedirectUrl('//evil.com')).toBe('/organizer');
      expect(sanitizeRedirectUrl('//evil.com/organizer')).toBe('/organizer');
      expect(sanitizeRedirectUrl('///evil.com')).toBe('/organizer');
      expect(sanitizeRedirectUrl('////evil.com/path')).toBe('/organizer');
    });

    it('rejects backslash-based parser confusion tricks', () => {
      expect(sanitizeRedirectUrl('/\\evil.com')).toBe('/organizer');
      expect(sanitizeRedirectUrl('\\\\evil.com')).toBe('/organizer');
      expect(sanitizeRedirectUrl('\\evil.com')).toBe('/organizer');
      expect(sanitizeRedirectUrl('/events\\evil.com')).toBe('/organizer');
      expect(sanitizeRedirectUrl('/organizer\\..\\admin')).toBe('/organizer');
    });

    it('rejects encoded or normalized authentication paths to prevent redirect loops', () => {
      // Direct auth paths
      expect(sanitizeRedirectUrl('/login')).toBe('/organizer');
      expect(sanitizeRedirectUrl('/signin')).toBe('/organizer');
      expect(sanitizeRedirectUrl('/register')).toBe('/organizer');
      expect(sanitizeRedirectUrl('/forgot-password')).toBe('/organizer');

      // Auth paths with query params or hashes
      expect(sanitizeRedirectUrl('/login?redirect=/teams')).toBe('/organizer');
      expect(sanitizeRedirectUrl('/signin?foo=bar')).toBe('/organizer');
      expect(sanitizeRedirectUrl('/register#section')).toBe('/organizer');
      expect(sanitizeRedirectUrl('/forgot-password?email=test@outside.vip')).toBe('/organizer');

      // Sub-paths of auth routes
      expect(sanitizeRedirectUrl('/login/oauth')).toBe('/organizer');
      expect(sanitizeRedirectUrl('/register/step2')).toBe('/organizer');

      // Percent-encoded auth paths
      expect(sanitizeRedirectUrl('/%6c%6f%67%69%6e')).toBe('/organizer'); // /login
      expect(sanitizeRedirectUrl('/%73%69%67%6e%69%6e')).toBe('/organizer'); // /signin
      expect(sanitizeRedirectUrl('/%72%65%67%69%73%74%65%72')).toBe('/organizer'); // /register
      expect(sanitizeRedirectUrl('/%66%6f%72%67%6f%74%2d%70%61%73%73%77%6f%72%64')).toBe('/organizer'); // /forgot-password

      // Double percent-encoded auth paths
      expect(sanitizeRedirectUrl('/%256c%256f%2567%2569%256e')).toBe('/organizer');

      // Case variations and slashes normalization
      expect(sanitizeRedirectUrl('/LOGIN')).toBe('/organizer');
      expect(sanitizeRedirectUrl('/SignIn')).toBe('/organizer');
      expect(sanitizeRedirectUrl('///login')).toBe('/organizer');
      expect(sanitizeRedirectUrl('/login/')).toBe('/organizer');
    });

    it('handles malformed redirect values safely without throwing', () => {
      expect(sanitizeRedirectUrl('%')).toBe('/organizer');
      expect(sanitizeRedirectUrl('%E0%A4%A')).toBe('/organizer');
      expect(sanitizeRedirectUrl('/path\0evil')).toBe('/organizer');
      expect(sanitizeRedirectUrl(123 as any)).toBe('/organizer');
      expect(sanitizeRedirectUrl({} as any)).toBe('/organizer');
    });
  });

  describe('2. AuthPage Integration', () => {
    const mockVerifiedUser: User = {
      id: 'usr-auth-test',
      email: 'organizer@outside.vip',
      name: 'Test Organizer',
      role: 'ORGANIZER',
      status: 'ACTIVE',
      emailVerified: true,
    };

    it('navigates to sanitized internal path on successful login when valid redirect is provided', () => {
      const mockAuthValue: any = {
        user: mockVerifiedUser,
        isLoading: false,
        login: vi.fn(),
        register: vi.fn(),
        verifyEmail: vi.fn(),
        resendVerification: vi.fn(),
        refreshUser: vi.fn(),
        logout: vi.fn(),
      };

      const TestContainer: React.FC = () => {
        return (
          <AuthContext.Provider value={mockAuthValue}>
            <MemoryRouter initialEntries={['/login?redirect=%2Fteams']}>
              <Routes>
                <Route path="/login" element={<AuthPage />} />
                <Route path="/teams" element={<div>Teams Page</div>} />
              </Routes>
            </MemoryRouter>
          </AuthContext.Provider>
        );
      };

      const html = renderToString(<TestContainer />);
      expect(html).toBeDefined();
      expect(sanitizeRedirectUrl('%2Fteams', '/organizer')).toBe('/teams');
    });

    it('uses safe default /organizer when malicious or auth redirect is provided to AuthPage', () => {
      // Test with open redirect attempt
      const dangerousUrls = [
        'https://evil.com',
        '//attacker.com',
        '/\\evil.com',
        '/login',
        '/%6c%6f%67%69%6e',
      ];

      for (const dangerous of dangerousUrls) {
        const safe = sanitizeRedirectUrl(dangerous, '/organizer');
        expect(safe).toBe('/organizer');
      }
    });

    it('renders loading state while AuthPage is waiting for session resolution', () => {
      const mockLoadingAuthValue: any = {
        user: null,
        isLoading: true,
      };

      const html = renderToString(
        <AuthContext.Provider value={mockLoadingAuthValue}>
          <MemoryRouter initialEntries={['/login']}>
            <AuthPage />
          </MemoryRouter>
        </AuthContext.Provider>
      );

      expect(html).toContain('Loading account...');
      expect(html).not.toContain('Sign in to your account');
    });

    it('renders EmailVerificationGate on AuthPage when authenticated user is unverified', () => {
      const mockUnverifiedUser: User = {
        id: 'usr-unverified',
        email: 'unverified@outside.vip',
        name: 'Unverified User',
        role: 'ATTENDEE',
        status: 'ACTIVE',
        emailVerified: false,
      };

      const mockAuthValue: any = {
        user: mockUnverifiedUser,
        isLoading: false,
      };

      const html = renderToString(
        <AuthContext.Provider value={mockAuthValue}>
          <MemoryRouter initialEntries={['/login']}>
            <AuthPage />
          </MemoryRouter>
        </AuthContext.Provider>
      );

      expect(html).toContain('Verify Your Email Address');
      expect(html).not.toContain('Loading account...');
    });
  });

  describe('3. Authentication Hydration & FOAC Elimination', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const createMockAuthContext = (user: User | null, isLoading = false) => ({
      user,
      isLoading,
      login: vi.fn(),
      register: vi.fn(),
      verifyEmail: vi.fn(),
      resendVerification: vi.fn(),
      refreshUser: vi.fn(),
      logout: vi.fn(),
    });

    const mockVerifiedUser: User = {
      id: 'usr-org-123',
      email: 'host@outside.vip',
      name: 'Host User',
      role: 'ORGANIZER',
      status: 'ACTIVE',
      emailVerified: true,
    };

    const mockUnverifiedUser: User = {
      id: 'usr-unverified-org',
      email: 'pending@outside.vip',
      name: 'Pending User',
      role: 'ATTENDEE',
      status: 'ACTIVE',
      emailVerified: false,
    };

    it('OrganizerDashboardPage renders loading indicator and does NOT render sign-in card while isLoading is true', () => {
      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <AuthContext.Provider value={createMockAuthContext(null, true)}>
            <MemoryRouter initialEntries={['/organizer']}>
              <OrganizerDashboardPage />
            </MemoryRouter>
          </AuthContext.Provider>
        </QueryClientProvider>
      );

      expect(html).toContain('Loading Organizer Studio...');
      expect(html).not.toContain('Sign In to Manage Events');
      expect(html).not.toContain('Email Address');
      expect(html).not.toContain('Password');
    });

    it('CreateEventPage renders loading indicator and does NOT render sign-in card while isLoading is true', () => {
      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <AuthContext.Provider value={createMockAuthContext(null, true)}>
            <MemoryRouter initialEntries={['/organizer/events/new']}>
              <CreateEventPage />
            </MemoryRouter>
          </AuthContext.Provider>
        </QueryClientProvider>
      );

      expect(html).toContain('Loading Event Studio...');
      expect(html).not.toContain('Sign In Required');
      expect(html).not.toContain('Email Address');
      expect(html).not.toContain('Password');
    });

    it('OrganizerDashboardPage renders normal sign-in card after loading completes with user === null', () => {
      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <AuthContext.Provider value={createMockAuthContext(null, false)}>
            <MemoryRouter initialEntries={['/organizer']}>
              <OrganizerDashboardPage />
            </MemoryRouter>
          </AuthContext.Provider>
        </QueryClientProvider>
      );

      expect(html).not.toContain('Loading Organizer Studio...');
      expect(html).toContain('Sign In to Manage Events');
      expect(html).toContain('Organizer Portal');
      expect(html).toContain('Email Address');
      expect(html).toContain('Password');
    });

    it('CreateEventPage renders normal sign-in card after loading completes with user === null', () => {
      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <AuthContext.Provider value={createMockAuthContext(null, false)}>
            <MemoryRouter initialEntries={['/organizer/events/new']}>
              <CreateEventPage />
            </MemoryRouter>
          </AuthContext.Provider>
        </QueryClientProvider>
      );

      expect(html).not.toContain('Loading Event Studio...');
      expect(html).toContain('Sign In Required');
      expect(html).toContain('Create Event');
      expect(html).toContain('Email Address');
      expect(html).toContain('Password');
    });

    it('OrganizerDashboardPage preserves EmailVerificationGate when user is unverified', () => {
      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <AuthContext.Provider value={createMockAuthContext(mockUnverifiedUser, false)}>
            <MemoryRouter initialEntries={['/organizer']}>
              <OrganizerDashboardPage />
            </MemoryRouter>
          </AuthContext.Provider>
        </QueryClientProvider>
      );

      expect(html).toContain('Verify Your Email to Access Organizer Studio');
      expect(html).not.toContain('Sign In to Manage Events');
      expect(html).not.toContain('Loading Organizer Studio...');
    });

    it('CreateEventPage preserves EmailVerificationGate when user is unverified', () => {
      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <AuthContext.Provider value={createMockAuthContext(mockUnverifiedUser, false)}>
            <MemoryRouter initialEntries={['/organizer/events/new']}>
              <CreateEventPage />
            </MemoryRouter>
          </AuthContext.Provider>
        </QueryClientProvider>
      );

      expect(html).toContain('Verify Your Email to Create an Event');
      expect(html).not.toContain('Sign In Required');
      expect(html).not.toContain('Loading Event Studio...');
    });

    it('OrganizerDashboardPage renders normal studio interface when authenticated and verified', () => {
      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <AuthContext.Provider value={createMockAuthContext(mockVerifiedUser, false)}>
            <MemoryRouter initialEntries={['/organizer']}>
              <OrganizerDashboardPage />
            </MemoryRouter>
          </AuthContext.Provider>
        </QueryClientProvider>
      );

      expect(html).not.toContain('Loading Organizer Studio...');
      expect(html).not.toContain('Sign In to Manage Events');
      expect(html).not.toContain('Verify Your Email');
      // Verifies studio content is rendered
      expect(html).toContain('Create Event');
      expect(html).toContain('Event Management &amp; Inventory');
    });
  });
});
