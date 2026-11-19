import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthContext } from './context/AuthContext';
import { RequireAuth } from './components/auth/RequireAuth';
import { RequireRole } from './components/auth/RequireRole';
import { User } from './types';
import fs from 'fs';
import path from 'path';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    Navigate: ({ to }: { to: string }) => (
      <div data-testid="redirect-target" data-to={to} />
    ),
  };
});

describe('Stage 3 Implementation 2: Centralized Route Guards', () => {
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

  const mockVerifiedAttendee: User = {
    id: 'usr-attendee-01',
    email: 'attendee@outside.vip',
    name: 'Standard Attendee',
    role: 'ATTENDEE',
    status: 'ACTIVE',
    emailVerified: true,
  };

  const mockUnverifiedAttendee: User = {
    id: 'usr-unverified-01',
    email: 'unverified@outside.vip',
    name: 'Unverified Attendee',
    role: 'ATTENDEE',
    status: 'ACTIVE',
    emailVerified: false,
  };

  const mockVerifiedOrganizer: User = {
    id: 'usr-organizer-01',
    email: 'organizer@outside.vip',
    name: 'Verified Organizer',
    role: 'ORGANIZER',
    status: 'ACTIVE',
    emailVerified: true,
  };

  const mockVerifiedAdmin: User = {
    id: 'usr-admin-01',
    email: 'admin@outside.vip',
    name: 'System Admin',
    role: 'ADMIN',
    status: 'ACTIVE',
    emailVerified: true,
  };

  describe('1. RequireAuth Route Guard', () => {
    it('displays loading state and does NOT redirect while isLoading is true', () => {
      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <AuthContext.Provider value={createMockAuthContext(null, true)}>
            <MemoryRouter initialEntries={['/organizer']}>
              <Routes>
                <Route
                  path="/organizer"
                  element={
                    <RequireAuth>
                      <div>Protected Studio</div>
                    </RequireAuth>
                  }
                />
                <Route path="/login" element={<div>Sign In Screen</div>} />
              </Routes>
            </MemoryRouter>
          </AuthContext.Provider>
        </QueryClientProvider>
      );

      expect(html).toContain('Loading account...');
      expect(html).not.toContain('Protected Studio');
      expect(html).not.toContain('Sign In Screen');
    });

    it('redirects unauthenticated users to /login preserving destination path', () => {
      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <AuthContext.Provider value={createMockAuthContext(null, false)}>
            <MemoryRouter initialEntries={['/organizer']}>
              <Routes>
                <Route
                  path="/organizer"
                  element={
                    <RequireAuth>
                      <div>Protected Studio</div>
                    </RequireAuth>
                  }
                />
              </Routes>
            </MemoryRouter>
          </AuthContext.Provider>
        </QueryClientProvider>
      );

      expect(html).toContain('data-to="/login?redirect=%2Forganizer"');
      expect(html).not.toContain('Protected Studio');
    });

    it('preserves complete pathname, search query parameters, and hash fragment in redirect', () => {
      const requestedPath = '/organizer/events/evt-987/edit?tab=pricing&tier=vip#capacity';

      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <AuthContext.Provider value={createMockAuthContext(null, false)}>
            <MemoryRouter initialEntries={[requestedPath]}>
              <Routes>
                <Route
                  path="/organizer/events/:id/edit"
                  element={
                    <RequireAuth>
                      <div>Edit Event Studio</div>
                    </RequireAuth>
                  }
                />
              </Routes>
            </MemoryRouter>
          </AuthContext.Provider>
        </QueryClientProvider>
      );

      expect(html).toContain(
        'data-to="/login?redirect=%2Forganizer%2Fevents%2Fevt-987%2Fedit%3Ftab%3Dpricing%26tier%3Dvip%23capacity"'
      );
      expect(html).not.toContain('Edit Event Studio');
    });

    it('allows authenticated verified users to access protected content', () => {
      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <AuthContext.Provider value={createMockAuthContext(mockVerifiedOrganizer, false)}>
            <MemoryRouter initialEntries={['/organizer/finance']}>
              <Routes>
                <Route
                  path="/organizer/finance"
                  element={
                    <RequireAuth>
                      <div>Finance Dashboard Content</div>
                    </RequireAuth>
                  }
                />
                <Route path="/login" element={<div>Sign In Screen</div>} />
              </Routes>
            </MemoryRouter>
          </AuthContext.Provider>
        </QueryClientProvider>
      );

      expect(html).toContain('Finance Dashboard Content');
      expect(html).not.toContain('Sign In Screen');
      expect(html).not.toContain('Loading account...');
    });

    it('renders EmailVerificationGate for authenticated unverified users', () => {
      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <AuthContext.Provider value={createMockAuthContext(mockUnverifiedAttendee, false)}>
            <MemoryRouter initialEntries={['/organizer']}>
              <Routes>
                <Route
                  path="/organizer"
                  element={
                    <RequireAuth>
                      <div>Organizer Content</div>
                    </RequireAuth>
                  }
                />
                <Route path="/login" element={<div>Sign In Screen</div>} />
              </Routes>
            </MemoryRouter>
          </AuthContext.Provider>
        </QueryClientProvider>
      );

      expect(html).toContain('Verify Your Email Address');
      expect(html).toContain('Enter the 6-digit single-use verification code');
      expect(html).not.toContain('Organizer Content');
      expect(html).not.toContain('Sign In Screen');
    });

    it('prevents redirect loops and rejects unsafe external destinations', () => {
      // Testing with auth route that would cause redirect loop
      const loopTarget = '/login';

      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <AuthContext.Provider value={createMockAuthContext(null, false)}>
            <MemoryRouter initialEntries={[loopTarget]}>
              <Routes>
                <Route
                  path="/login"
                  element={
                    <RequireAuth>
                      <div>Protected Area</div>
                    </RequireAuth>
                  }
                />
              </Routes>
            </MemoryRouter>
          </AuthContext.Provider>
        </QueryClientProvider>
      );

      // Auth route destination is sanitized to empty string, redirecting to plain /login without loop query
      expect(html).toContain('data-to="/login"');
      expect(html).not.toContain('redirect=');
      expect(html).not.toContain('Protected Area');
    });
  });

  describe('2. RequireRole Guard & Role Invariants', () => {
    it('ORGANIZER can access /teams', () => {
      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <AuthContext.Provider value={createMockAuthContext(mockVerifiedOrganizer, false)}>
            <MemoryRouter initialEntries={['/teams']}>
              <Routes>
                <Route
                  path="/teams"
                  element={
                    <RequireRole allowedRoles={['ORGANIZER', 'ADMIN']}>
                      <div>Scanner Teams Management</div>
                    </RequireRole>
                  }
                />
                <Route path="/organizer" element={<div>Organizer Dashboard</div>} />
              </Routes>
            </MemoryRouter>
          </AuthContext.Provider>
        </QueryClientProvider>
      );

      expect(html).toContain('Scanner Teams Management');
      expect(html).not.toContain('Organizer Dashboard');
    });

    it('ADMIN can access /teams', () => {
      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <AuthContext.Provider value={createMockAuthContext(mockVerifiedAdmin, false)}>
            <MemoryRouter initialEntries={['/teams']}>
              <Routes>
                <Route
                  path="/teams"
                  element={
                    <RequireRole allowedRoles={['ORGANIZER', 'ADMIN']}>
                      <div>Scanner Teams Management</div>
                    </RequireRole>
                  }
                />
                <Route path="/organizer" element={<div>Organizer Dashboard</div>} />
              </Routes>
            </MemoryRouter>
          </AuthContext.Provider>
        </QueryClientProvider>
      );

      expect(html).toContain('Scanner Teams Management');
      expect(html).not.toContain('Organizer Dashboard');
    });

    it('ATTENDEE cannot access /teams and is redirected to /organizer', () => {
      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <AuthContext.Provider value={createMockAuthContext(mockVerifiedAttendee, false)}>
            <MemoryRouter initialEntries={['/teams']}>
              <Routes>
                <Route
                  path="/teams"
                  element={
                    <RequireRole allowedRoles={['ORGANIZER', 'ADMIN']} redirectTo="/organizer">
                      <div>Scanner Teams Management</div>
                    </RequireRole>
                  }
                />
              </Routes>
            </MemoryRouter>
          </AuthContext.Provider>
        </QueryClientProvider>
      );

      expect(html).toContain('data-to="/organizer"');
      expect(html).not.toContain('Scanner Teams Management');
    });

    it('ATTENDEE can access /organizer to create their first event', () => {
      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <AuthContext.Provider value={createMockAuthContext(mockVerifiedAttendee, false)}>
            <MemoryRouter initialEntries={['/organizer']}>
              <Routes>
                <Route
                  path="/organizer"
                  element={
                    <RequireAuth>
                      <div>Organizer Workspace for Attendee</div>
                    </RequireAuth>
                  }
                />
              </Routes>
            </MemoryRouter>
          </AuthContext.Provider>
        </QueryClientProvider>
      );

      expect(html).toContain('Organizer Workspace for Attendee');
    });

    it('ATTENDEE can access /organizer/events/new to start creating an event', () => {
      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <AuthContext.Provider value={createMockAuthContext(mockVerifiedAttendee, false)}>
            <MemoryRouter initialEntries={['/organizer/events/new']}>
              <Routes>
                <Route
                  path="/organizer/events/new"
                  element={
                    <RequireAuth>
                      <div>Create Event Studio for Attendee</div>
                    </RequireAuth>
                  }
                />
              </Routes>
            </MemoryRouter>
          </AuthContext.Provider>
        </QueryClientProvider>
      );

      expect(html).toContain('Create Event Studio for Attendee');
    });
  });

  describe('3. Route Inventory & App.tsx Configuration Audit', () => {
    const appSource = fs.readFileSync(
      path.resolve(__dirname, './App.tsx'),
      'utf-8'
    );

    it('verifies public routes are NOT wrapped with RequireAuth or RequireRole', () => {
      // Public routes: /, /login, /signin, /register, /forgot-password, /events, /events/:slug
      expect(appSource).toMatch(/<Route\s+path="\/"\s+element=\{<HomePage \/>\}/);
      expect(appSource).toMatch(/<Route\s+path="\/login"\s+element=\{<AuthPage \/>\}/);
      expect(appSource).toMatch(/<Route\s+path="\/signin"\s+element=\{<AuthPage \/>\}/);
      expect(appSource).toMatch(/<Route\s+path="\/register"\s+element=\{<AuthPage \/>\}/);
      expect(appSource).toMatch(/<Route\s+path="\/forgot-password"\s+element=\{<AuthPage \/>\}/);
      expect(appSource).toMatch(/<Route\s+path="\/events"\s+element=\{<DiscoverPage \/>\}/);
      expect(appSource).toMatch(/<Route\s+path="\/events\/:slug"\s+element=\{<EventDetailPage \/>\}/);
    });

    it('verifies conditional/specialized routes remain outside generic guards', () => {
      // /scanner protected by dedicated ScannerGuard (not generic RequireAuth/RequireRole)
      expect(appSource).toMatch(/<Route\s+path="\/scanner"\s+element=\{\s*<ScannerGuard>[\s\S]*?<ScannerPage \/>[\s\S]*?<\/ScannerGuard>\s*\}/);
      expect(appSource).not.toMatch(/<Route\s+path="\/scanner"\s+element=\{\s*<RequireAuth>/);
      expect(appSource).not.toMatch(/<Route\s+path="\/scanner"\s+element=\{\s*<RequireRole>/);
      expect(appSource).toMatch(/<Route\s+path="\/staff\/invitations\/:token"\s+element=\{<StaffInvitationPage \/>\}/);
      expect(appSource).toMatch(/<Route\s+path="\/orders\/:orderNumber"\s+element=\{<OrderConfirmationPage \/>\}/);
    });

    it('verifies /teams is protected with RequireRole for ORGANIZER and ADMIN', () => {
      expect(appSource).toMatch(/<Route[\s\S]*?path="\/teams"[\s\S]*?<RequireRole\s+allowedRoles=\{\['ORGANIZER',\s*'ADMIN'\]\}>[\s\S]*?<TeamsPage \/>/);
    });

    it('verifies all organizer routes are protected with RequireAuth', () => {
      expect(appSource).toMatch(/<Route[\s\S]*?path="\/organizer"[\s\S]*?<RequireAuth>[\s\S]*?<OrganizerDashboardPage \/>/);
      expect(appSource).toMatch(/<Route[\s\S]*?path="\/organizer\/events\/new"[\s\S]*?<RequireAuth>[\s\S]*?<CreateEventPage \/>/);
      expect(appSource).toMatch(/<Route[\s\S]*?path="\/organizer\/events\/:id\/edit"[\s\S]*?<RequireAuth>[\s\S]*?<CreateEventPage \/>/);
      expect(appSource).toMatch(/<Route[\s\S]*?path="\/organizer\/events\/:id\/preview"[\s\S]*?<RequireAuth>[\s\S]*?<EventPreviewPage \/>/);
      expect(appSource).toMatch(/<Route[\s\S]*?path="\/organizer\/finance"[\s\S]*?<RequireAuth>[\s\S]*?<FinanceOrganizationPage \/>/);
    });
  });
});
