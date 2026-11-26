import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthContext } from '../src/context/AuthContext';
import { AuthPage } from '../src/pages/AuthPage';
import { TeamInvitationPage } from '../src/pages/TeamInvitationPage';
import { TeamsPage } from '../src/pages/TeamsPage';
import { HostDashboardPage } from '../src/pages/HostDashboardPage';
import { OrganizerDashboardPage } from '../src/pages/OrganizerDashboardPage';
import { Navbar } from '../src/components/layout/Navbar';
import { RequireAuth } from '../src/components/auth/RequireAuth';
import {
  HostAssignedEventItem,
  OrganizerEventItem,
  TeamInvitationMetadata,
  User,
} from '../src/types';
import { DEFAULT_ADMIN_PERMISSIONS } from '../src/components/team/AdminPermissionsModal';

describe('Authentication Stage 4: Cross-Role Navigation, Unified OTP Login & Dashboard Permissions', () => {
  let queryClient: QueryClient;

  const baseAttendeeUser: User = {
    id: 'usr-multi-01',
    email: 'multi@outside.vip',
    name: 'Amani Multi',
    role: 'ATTENDEE',
    status: 'ACTIVE',
    emailVerified: true,
  };

  const createMockAuth = (user: User | null, overrides?: Partial<any>) => ({
    user,
    isLoading: false,
    login: vi.fn(),
    requestLoginOtp: vi.fn(),
    verifyLoginOtp: vi.fn(),
    clearSessionState: vi.fn(),
    register: vi.fn(),
    verifyEmail: vi.fn(),
    resendVerification: vi.fn(),
    refreshUser: vi.fn(),
    logout: vi.fn(),
    ...overrides,
  });

  const makeEvent = (overrides: Partial<OrganizerEventItem>): OrganizerEventItem => ({
    id: 'evt-default',
    slug: 'default-event',
    title: 'Default Event',
    description: 'Event description',
    category: 'MUSIC',
    startAt: '2026-12-10T18:00:00Z',
    endAt: '2026-12-10T23:00:00Z',
    timezone: 'Africa/Nairobi',
    venueName: 'Carnivore Grounds',
    venueAddress: 'Langata Road, Nairobi',
    city: 'Nairobi',
    country: 'Kenya',
    coverImageUrl: 'https://example.com/cover.jpg',
    status: 'PUBLISHED',
    organizerId: 'usr-other-owner',
    organizer: {
      id: 'usr-other-owner',
      name: 'Owner Name',
    },
    isFeatured: false,
    ticketTiers: [],
    totalCapacity: 200,
    ticketsSold: 50,
    revenueInCents: 250000,
    revenueFormatted: '$2,500.00',
    ...overrides,
  });

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Group A: Unified Passwordless OTP Login & Host vs Admin Invitation Policy
  // =========================================================================
  describe('A. Unified Login & Host vs Admin Invitation Onboarding', () => {
    it('renders password login by default with a clear option for passwordless email-code login', () => {
      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/login?redirect=%2Fhost']}>
            <AuthContext.Provider value={createMockAuth(null)}>
              <AuthPage />
            </AuthContext.Provider>
          </MemoryRouter>
        </QueryClientProvider>
      );

      expect(html).toContain('Sign in to your account');
      expect(html).toContain('Password');
      expect(html).toContain('Sign in with email code');
      expect(html).toContain('Passwordless host or door staff?');
    });

    it('opens directly in passwordless email-code OTP mode when /login?mode=otp is requested', () => {
      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/login?mode=otp&redirect=%2Fhost']}>
            <AuthContext.Provider value={createMockAuth(null)}>
              <AuthPage />
            </AuthContext.Provider>
          </MemoryRouter>
        </QueryClientProvider>
      );

      expect(html).toContain('Sign in with email code');
      expect(html).toContain('Send 6-Digit Sign-In Code');
      expect(html).toContain('Accounts with a password must sign in with their password');
      expect(html).toContain('Sign in with password');
      expect(html).not.toContain('id="auth-password"');
    });

    it('TeamInvitationPage exposes inline passwordless email-code sign-in for unauthenticated HOST invitations', () => {
      const hostInvite: TeamInvitationMetadata = {
        id: 'inv-host-1',
        eventId: 'evt-c',
        eventTitle: 'Nairobi Night Market',
        eventSlug: 'nairobi-night-market',
        organizerName: 'Sol Collective',
        role: 'HOST',
        emailMasked: 's***r@outside.vip',
        status: 'PENDING',
        expiresAt: '2026-12-30T12:00:00Z',
      };

      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/team/invitations/raw-host-token']}>
            <AuthContext.Provider value={createMockAuth(null)}>
              <Routes>
                <Route
                  path="/team/invitations/:token"
                  element={<TeamInvitationPage initialInvitation={hostInvite} />}
                />
              </Routes>
            </AuthContext.Provider>
          </MemoryRouter>
        </QueryClientProvider>
      );

      expect(html).toContain('Event Host Invitation');
      expect(html).toContain('Sign In or Create Password Account');
      expect(html).toContain('Already Have a Passwordless Account?');
      expect(html).toContain('Send 6-Digit Email Code');
      expect(html).toContain('without creating a second account');
    });

    it('TeamInvitationPage strictly withholds email-code OTP sign-in for Event ADMIN invitations (password-based onboarding only)', () => {
      const adminInvite: TeamInvitationMetadata = {
        id: 'inv-admin-1',
        eventId: 'evt-b',
        eventTitle: 'Rift Valley Gala',
        eventSlug: 'rift-valley-gala',
        organizerName: 'Sol Collective',
        role: 'ADMIN',
        emailMasked: 'a***n@outside.vip',
        status: 'PENDING',
        expiresAt: '2026-12-30T12:00:00Z',
      };

      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/team/invitations/raw-admin-token']}>
            <AuthContext.Provider value={createMockAuth(null)}>
              <Routes>
                <Route
                  path="/team/invitations/:token"
                  element={<TeamInvitationPage initialInvitation={adminInvite} />}
                />
              </Routes>
            </AuthContext.Provider>
          </MemoryRouter>
        </QueryClientProvider>
      );

      expect(html).toContain('Event Admin Invitation');
      expect(html).toContain('Sign In / Register');
      expect(html).not.toContain('Already Have a Passwordless Account?');
      expect(html).not.toContain('Send 6-Digit Email Code');
      expect(html).not.toContain('host-invite-otp-email');
    });
  });

  // =========================================================================
  // Group C: Cross-Role Navigation, Event-Scoped /teams & Navbar Links
  // =========================================================================
  describe('C. Cross-Role Navigation & Event-Scoped /teams Authorization', () => {
    it('allows an ATTENDEE-role Event Admin with canManageTeam: true to manage teams in TeamsPage', () => {
      const adminManagedEvent = makeEvent({
        id: 'evt-admin-team',
        title: 'Admin Managed Summit',
        organizerId: 'usr-real-owner',
        isOwner: false,
        accessRole: 'ADMIN',
        permissions: {
          ...DEFAULT_ADMIN_PERMISSIONS,
          canManageTeam: true,
        },
      });

      queryClient.setQueryData(['event-team', adminManagedEvent.id], {
        members: [],
        invitations: [],
      });
      queryClient.setQueryData(['event-staff', adminManagedEvent.id], {
        staff: [],
        invitations: [],
        isRestricted: true,
      });

      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/teams']}>
            <AuthContext.Provider value={createMockAuth(baseAttendeeUser)}>
              <TeamsPage initialEvents={[adminManagedEvent]} />
            </AuthContext.Provider>
          </MemoryRouter>
        </QueryClientProvider>
      );

      expect(html).toContain('Admin Managed Summit');
      expect(html).toContain('Event Team &amp; Hosts');
      expect(html).not.toContain('No Team Management Access');
    });

    it('denies team management workspace in TeamsPage to ordinary attendees, Hosts, and Event Admins lacking canManageTeam', () => {
      const adminWithoutTeamPerm = makeEvent({
        id: 'evt-no-team-perm',
        title: 'View Only Event',
        organizerId: 'usr-real-owner',
        isOwner: false,
        accessRole: 'ADMIN',
        permissions: {
          ...DEFAULT_ADMIN_PERMISSIONS,
          canEditDetails: true,
          canManageTeam: false,
        },
      });

      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/teams']}>
            <AuthContext.Provider value={createMockAuth(baseAttendeeUser)}>
              <TeamsPage initialEvents={[adminWithoutTeamPerm]} />
            </AuthContext.Provider>
          </MemoryRouter>
        </QueryClientProvider>
      );

      expect(html).toContain('No Team Management Access');
      expect(html).not.toContain('View Only Event');
    });

    it('renders absolute Navbar links (/orders, /teams) cleanly from nested routes without obsolete /atendees link', () => {
      const organizerUser: User = {
        ...baseAttendeeUser,
        id: 'usr-org-navbar',
        role: 'ORGANIZER',
      };
      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/organizer/finance']}>
            <AuthContext.Provider value={createMockAuth(organizerUser)}>
              <Navbar />
            </AuthContext.Provider>
          </MemoryRouter>
        </QueryClientProvider>
      );

      expect(html).toContain('href="/orders"');
      expect(html).toContain('href="/teams"');
      expect(html).not.toContain('href="/atendees"');
      expect(html).not.toContain('href="/organizer/orders"');
      expect(html).not.toContain('href="/organizer/atendees"');
    });

    it('blocks unauthenticated access to /orders via RequireAuth', () => {
      const ordersHtml = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/orders']}>
            <AuthContext.Provider value={createMockAuth(null)}>
              <Routes>
                <Route
                  path="/orders"
                  element={
                    <RequireAuth>
                      <div>Protected Orders Table</div>
                    </RequireAuth>
                  }
                />
                <Route path="/login" element={<div>Login Page</div>} />
              </Routes>
            </AuthContext.Provider>
          </MemoryRouter>
        </QueryClientProvider>
      );

      expect(ordersHtml).not.toContain('Protected Orders Table');
    });
  });

  // =========================================================================
  // Group D: Cache Isolation & Revocation Recovery
  // =========================================================================
  describe('D. Cache Isolation, 401 Recovery & Host Revocation State', () => {
    it('AuthPage suppresses OTP mode when ?requirePassword=1 is set (Event Admin onboarding link)', () => {
      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/login?mode=otp&requirePassword=1&redirect=%2Fteam%2Finvitations%2Ftok']}>
            <AuthContext.Provider value={createMockAuth(null)}>
              <AuthPage />
            </AuthContext.Provider>
          </MemoryRouter>
        </QueryClientProvider>
      );

      expect(html).toContain('Sign in to your account');
      expect(html).toContain('id="auth-password"');
      expect(html).not.toContain('Send 6-Digit Sign-In Code');
      expect(html).not.toContain('Sign in with email code');
    });

    it('HostDashboardPage displays Host Access Revoked (not infinite loading) when analytics returns 403', () => {
      const assignedHostEvents: HostAssignedEventItem[] = [
        {
          membershipId: 'mem-host-revoked',
          event: {
            id: 'evt-host-revoked',
            slug: 'sunset-sessions',
            title: 'Sunset Sessions',
            status: 'PUBLISHED',
            startAt: '2026-12-20T17:00:00Z',
            endAt: '2026-12-20T23:00:00Z',
            venueName: 'Kilifi Creek',
            city: 'Kilifi',
            coverImageUrl: 'https://example.com/sunset.jpg',
          },
          hostLink: {
            id: 'link-revoked-1',
            name: 'Amani Link',
            status: 'ACTIVE',
            slug: 'amani-sunset',
            shortUrl: '/r/amani-sunset',
          },
        },
      ];

      const forbiddenErr = Object.assign(
        new Error('Active Event Host membership required to view Host analytics.'),
        { statusCode: 403 }
      );

      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/host']}>
            <AuthContext.Provider value={createMockAuth(baseAttendeeUser)}>
              <HostDashboardPage
                initialEvents={assignedHostEvents}
                initialAnalyticsError={forbiddenErr}
              />
            </AuthContext.Provider>
          </MemoryRouter>
        </QueryClientProvider>
      );

      expect(html).toContain('Host Access Revoked');
      expect(html).toContain('no longer active');
      expect(html).not.toContain('Loading private traffic analytics...');
    });
  });

  // =========================================================================
  // Group F: Organizer Dashboard Per-Event Permissions & Role Distinction
  // =========================================================================
  describe('F. Organizer Dashboard Event-Scoped Permissions & Banner Guard', () => {
    it('renders only permitted controls for an Event Admin, masks restricted revenue, and suppresses OrganizerWorkspaceSetupBanner', () => {
      const adminOnlyEvent = makeEvent({
        id: 'evt-admin-b',
        slug: 'admin-event-b',
        title: 'Admin Assigned Gala',
        status: 'DRAFT',
        ticketsSold: 0,
        revenueInCents: 0,
        revenueFormatted: '$0.00',
        organizerId: 'usr-owner-x',
        isOwner: false,
        accessRole: 'ADMIN',
        permissions: {
          ...DEFAULT_ADMIN_PERMISSIONS,
          canEditDetails: true,
          canManageTickets: false,
          canViewOrders: false,
          canManageTeam: false,
          canManagePromotions: false,
          canViewAnalytics: false,
          canDeleteEvent: false,
        },
      });

      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/organizer']}>
            <AuthContext.Provider value={createMockAuth(baseAttendeeUser)}>
              <OrganizerDashboardPage
                initialUser={baseAttendeeUser}
                initialIsLoading={false}
                initialEvents={[adminOnlyEvent]}
                initialStats={{
                  totalEvents: 0,
                  publishedEvents: 0,
                  draftEvents: 0,
                  ticketsSold: 0,
                  grossRevenueInCents: 0,
                  grossRevenueFormatted: '$0.00',
                  currency: 'USD',
                }}
              />
            </AuthContext.Provider>
          </MemoryRouter>
        </QueryClientProvider>
      );

      // Event Admin badge & permitted Edit action visible (details-only admin sees Edit Event Details)
      expect(html).toContain('Admin Assigned Gala');
      expect(html).toContain('Event Admin');
      expect(html).toContain('title="Edit Event Details"');
      expect(html).toContain('Assigned Events');

      // Unpermitted / owner-only controls MUST NOT appear
      expect(html).not.toContain('title="Manage Event Team &amp; Hosts"');
      expect(html).not.toContain('title="Campaign Links &amp; Traffic Analytics"');
      expect(html).not.toContain('title="View Event Waitlist"');
      expect(html).not.toContain('title="Publish event to Outside.vip"');
      expect(html).not.toContain('title="Delete Draft Event"');

      // Must NOT prompt an Event Admin to create an organizer profile
      expect(html).not.toContain('Set Up Your Organizer Profile');
    });

    it('distinguishes Owner vs Event Admin rows for a dual-role user and shows owner controls only on owned events', () => {
      const dualUser: User = {
        ...baseAttendeeUser,
        role: 'ORGANIZER',
        organizer: {
          id: 'org-1',
          displayName: 'Amani Productions',
          slug: 'amani-productions',
        },
      };

      const ownedDraft = makeEvent({
        id: 'evt-owned-a',
        slug: 'owned-event-a',
        title: 'Owned Rooftop Draft',
        status: 'DRAFT',
        ticketsSold: 0,
        revenueInCents: 0,
        revenueFormatted: '$0.00',
        organizerId: dualUser.id,
        isOwner: true,
        accessRole: 'OWNER',
        permissions: null,
      });

      const administeredPublished = makeEvent({
        id: 'evt-admin-b',
        slug: 'admin-event-b',
        title: 'Partner Festival',
        status: 'PUBLISHED',
        ticketsSold: 25,
        organizerId: 'usr-other-org',
        isOwner: false,
        accessRole: 'ADMIN',
        permissions: {
          ...DEFAULT_ADMIN_PERMISSIONS,
          canManageTeam: true,
          canViewAnalytics: true,
        },
      });

      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/organizer']}>
            <AuthContext.Provider value={createMockAuth(dualUser)}>
              <OrganizerDashboardPage
                initialUser={dualUser}
                initialIsLoading={false}
                initialEvents={[ownedDraft, administeredPublished]}
                initialStats={{
                  totalEvents: 1,
                  publishedEvents: 0,
                  draftEvents: 1,
                  ticketsSold: 0,
                  grossRevenueInCents: 0,
                  grossRevenueFormatted: '$0.00',
                  currency: 'USD',
                }}
              />
            </AuthContext.Provider>
          </MemoryRouter>
        </QueryClientProvider>
      );

      expect(html).toContain('Owned Rooftop Draft');
      expect(html).toContain('Partner Festival');
      expect(html).toContain('>Owner<');
      expect(html).toContain('>Event Admin<');
      // Owner controls present for Owned Rooftop Draft
      expect(html).toContain('title="View Event Waitlist"');
      expect(html).toContain('title="Publish event to Outside.vip"');
      expect(html).toContain('title="Delete Draft Event"');
      // Unpublish must NOT appear because the only PUBLISHED event is an Event Admin row
      expect(html).not.toContain('title="Unpublish event (hide from discovery)"');

      // S4R-06: Mixed-role KPIs must reflect combined owned + assigned scope, never owned-only totals
      expect(html).toContain('1 owned · 1 admin');
      expect(html).toContain('Across owned &amp; assigned events');
      expect(html).toContain('Permitted events only (some restricted)');
      // Revenue for Event B (canViewOrders: false) must NOT be aggregated into top KPI ($0.00 owned only, not $2,500.00!)
      expect(html).not.toContain('$2,500.00');
    });

    it('S4R-06: Owner-only dashboard uses owner stats directly and displays Completed transactions subtitle', () => {
      const ownerUser: User = {
        ...baseAttendeeUser,
        role: 'ORGANIZER',
        organizer: { id: 'org-owner', displayName: 'Owner Collective', slug: 'owner-collective' },
      };
      const ownedEvent = makeEvent({
        id: 'evt-owned-only',
        title: 'Solo Owner Fest',
        status: 'PUBLISHED',
        organizerId: ownerUser.id,
        isOwner: true,
        accessRole: 'OWNER',
        permissions: null,
        ticketsSold: 42,
        revenueInCents: 420000,
        revenueFormatted: '$4,200.00',
      });

      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/organizer']}>
            <AuthContext.Provider value={createMockAuth(ownerUser)}>
              <OrganizerDashboardPage
                initialUser={ownerUser}
                initialIsLoading={false}
                initialEvents={[ownedEvent]}
                initialStats={{
                  totalEvents: 1,
                  publishedEvents: 1,
                  draftEvents: 0,
                  ticketsSold: 42,
                  grossRevenueInCents: 420000,
                  grossRevenueFormatted: '$4,200.00',
                  currency: 'USD',
                }}
              />
            </AuthContext.Provider>
          </MemoryRouter>
        </QueryClientProvider>
      );

      expect(html).toContain('$4,200.00');
      expect(html).toContain('Completed transactions');
      expect(html).toContain('Across all lifecycles');
      expect(html).not.toContain('Permitted events only');
    });

    it('S4R-06: Mixed-role dashboard aggregates owned + permitted Event Admin revenue when canViewOrders is true and excludes restricted events when false', () => {
      const mixedUser: User = {
        ...baseAttendeeUser,
        role: 'ORGANIZER',
        organizer: { id: 'org-mix', displayName: 'Mixed Co', slug: 'mixed-co' },
      };

      const ownedEvent = makeEvent({
        id: 'evt-mix-owned',
        title: 'Owned Gala',
        status: 'PUBLISHED',
        organizerId: mixedUser.id,
        isOwner: true,
        accessRole: 'OWNER',
        permissions: null,
        ticketsSold: 10,
        revenueInCents: 100000,
        revenueFormatted: '$1,000.00',
      });

      const permittedAdminEvent = makeEvent({
        id: 'evt-mix-admin-ok',
        title: 'Permitted Partner Event',
        status: 'PUBLISHED',
        organizerId: 'usr-partner-1',
        isOwner: false,
        accessRole: 'ADMIN',
        permissions: { ...DEFAULT_ADMIN_PERMISSIONS, canViewOrders: true },
        ticketsSold: 15,
        revenueInCents: 50000,
        revenueFormatted: '$500.00',
      });

      const restrictedAdminEvent = makeEvent({
        id: 'evt-mix-admin-restricted',
        title: 'Restricted Partner Event',
        status: 'DRAFT',
        organizerId: 'usr-partner-2',
        isOwner: false,
        accessRole: 'ADMIN',
        permissions: { ...DEFAULT_ADMIN_PERMISSIONS, canViewOrders: false },
        ticketsSold: 5,
        // Even if a malicious/stale payload had non-zero cents, client must never aggregate it
        revenueInCents: 999900,
        revenueFormatted: '$9,999.00',
      });

      // Case 1: Owned + Permitted Admin + Restricted Admin
      const htmlWithRestricted = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/organizer']}>
            <AuthContext.Provider value={createMockAuth(mixedUser)}>
              <OrganizerDashboardPage
                initialUser={mixedUser}
                initialIsLoading={false}
                initialEvents={[ownedEvent, permittedAdminEvent, restrictedAdminEvent]}
                initialStats={{
                  totalEvents: 1,
                  publishedEvents: 1,
                  draftEvents: 0,
                  ticketsSold: 10,
                  grossRevenueInCents: 100000,
                  grossRevenueFormatted: '$1,000.00',
                  currency: 'USD',
                }}
              />
            </AuthContext.Provider>
          </MemoryRouter>
        </QueryClientProvider>
      );

      expect(htmlWithRestricted).toContain('1 owned · 2 admin');
      expect(htmlWithRestricted).toContain('$1,500.00');
      expect(htmlWithRestricted).toContain('Permitted events only (some restricted)');
      expect(htmlWithRestricted).not.toContain('$9,999.00');
      expect(htmlWithRestricted).not.toContain('$11,499.00');

      // Case 2: Owned + Permitted Admin only (all events financially visible)
      const htmlAllPermitted = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/organizer']}>
            <AuthContext.Provider value={createMockAuth(mixedUser)}>
              <OrganizerDashboardPage
                initialUser={mixedUser}
                initialIsLoading={false}
                initialEvents={[ownedEvent, permittedAdminEvent]}
                initialStats={{
                  totalEvents: 1,
                  publishedEvents: 1,
                  draftEvents: 0,
                  ticketsSold: 10,
                  grossRevenueInCents: 100000,
                  grossRevenueFormatted: '$1,000.00',
                  currency: 'USD',
                }}
              />
            </AuthContext.Provider>
          </MemoryRouter>
        </QueryClientProvider>
      );

      expect(htmlAllPermitted).toContain('1 owned · 1 admin');
      expect(htmlAllPermitted).toContain('$1,500.00');
      expect(htmlAllPermitted).toContain('Owned &amp; permitted admin events');
    });
  });
});
