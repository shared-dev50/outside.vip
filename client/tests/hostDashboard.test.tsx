import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HostDashboardPage } from '../src/pages/HostDashboardPage';
import { api, setActiveCsrfToken } from '../src/lib/api';
import { HostAssignedEventItem, HostPromotionalAnalytics } from '../src/types';

// Mock AuthContext
vi.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 'host-user-99',
      name: 'Amina Mohamed',
      email: 'amina@outside.vip',
      emailVerified: true,
      role: 'USER',
    },
    isLoading: false,
    logout: vi.fn(),
  }),
}));

const mockHostAssignedEvents: HostAssignedEventItem[] = [
  {
    membershipId: 'mem-host-1',
    event: {
      id: 'evt-kilifi-2026',
      slug: 'kilifi-nye-gathering',
      title: 'Kilifi NYE Gathering 2026',
      status: 'PUBLISHED',
      startAt: '2026-12-30T16:00:00.000Z',
      endAt: '2027-01-02T12:00:00.000Z',
      venueName: 'Beneath The Baobabs',
      city: 'Kilifi',
      coverImageUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819',
    },
    hostLink: {
      id: 'link-host-amina-1',
      name: "Amina's VIP Network",
      status: 'ACTIVE',
      slug: 'amina-kilifi-vip',
      shortUrl: '/r/amina-kilifi-vip',
    },
  },
  {
    membershipId: 'mem-host-2',
    event: {
      id: 'evt-nairobi-fest',
      slug: 'sol-fest-nairobi',
      title: 'Sol Fest Nairobi 2026',
      status: 'PUBLISHED',
      startAt: '2026-11-20T18:00:00.000Z',
      endAt: '2026-11-21T06:00:00.000Z',
      venueName: 'Uhuru Gardens',
      city: 'Nairobi',
      coverImageUrl: 'https://images.unsplash.com/photo-1492684223066-81342ee5ff30',
    },
    hostLink: {
      id: 'link-host-amina-2',
      name: 'Amina Sol Fest Guestlist',
      status: 'DISABLED',
      slug: 'amina-sol-fest',
      shortUrl: '/r/amina-sol-fest',
    },
  },
];

const mockHostAnalytics: HostPromotionalAnalytics = {
  link: {
    id: 'link-host-amina-1',
    name: "Amina's VIP Network",
    primarySlug: 'amina-kilifi-vip',
    shortUrl: '/r/amina-kilifi-vip',
    status: 'ACTIVE',
  },
  traffic: {
    totalClicks: 450,
    uniqueVisitors: 310,
    dailyVisits: [
      { date: '2026-11-14', clicks: 45, uniqueVisitors: 30 },
      { date: '2026-11-15', clicks: 80, uniqueVisitors: 65 },
      { date: '2026-11-16', clicks: 120, uniqueVisitors: 85 },
      { date: '2026-11-17', clicks: 95, uniqueVisitors: 60 },
      { date: '2026-11-18', clicks: 60, uniqueVisitors: 40 },
      { date: '2026-11-19', clicks: 30, uniqueVisitors: 20 },
      { date: '2026-11-20', clicks: 20, uniqueVisitors: 10 },
    ],
    topReferrers: [
      { referrer: 'instagram.com', clicks: 260 },
      { referrer: 'whatsapp', clicks: 120 },
      { referrer: 'Direct / None', clicks: 70 },
    ],
  },
};

describe('Stage 3 Implementation 3: Host Dashboard, Personal Promotional Links & Private Analytics', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    setActiveCsrfToken('mock-csrf-token');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Host Dashboard Layout & Assigned Events
  // =========================================================================
  describe('1. Host Dashboard Layout & Assigned Events', () => {
    it('renders host portal header, user identity, and assigned events', () => {
      queryClient.setQueryData(['host-events'], mockHostAssignedEvents);
      queryClient.setQueryData(
        ['host-analytics', mockHostAssignedEvents[0].event.id],
        mockHostAnalytics
      );

      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <HostDashboardPage />
          </MemoryRouter>
        </QueryClientProvider>
      );

      expect(html).toContain('Event Host Workspace');
      expect(html).toContain('Amina Mohamed');
      expect(html).toContain('Host Portal &amp; Private Traffic');
      expect(html).toContain('Kilifi NYE Gathering 2026');
      expect(html).toContain('/kilifi-nye-gathering');
      expect(html).toContain('Active Host');
      expect(html).toContain('Assigned Events (<!-- -->2<!-- -->)');
    });

    it('renders empty state when host has zero assigned events', () => {
      queryClient.setQueryData(['host-events'], []);

      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <HostDashboardPage />
          </MemoryRouter>
        </QueryClientProvider>
      );

      expect(html).toContain('No Assigned Host Experiences');
      expect(html).toContain('You do not have any active Event Host assignments right now');
      expect(html).toContain('Discover Public Events');
    });

    it('renders error state when api.host.getEvents fails', () => {
      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <HostDashboardPage initialError="Network error loading host assignments" />
          </MemoryRouter>
        </QueryClientProvider>
      );

      expect(html).toContain('Unable to Load Host Assignments');
      expect(html).toContain('Network error loading host assignments');
      expect(html).toContain('Retry');
    });
  });

  // =========================================================================
  // 2. Personal Promotional Link & Slug Customization
  // =========================================================================
  describe('2. Personal Promotional Link Display & Controls', () => {
    it('renders personal short link /r/{slug}, dynamic origin, copy button, and active status', () => {
      queryClient.setQueryData(['host-events'], mockHostAssignedEvents);
      queryClient.setQueryData(
        ['host-analytics', mockHostAssignedEvents[0].event.id],
        mockHostAnalytics
      );

      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <HostDashboardPage />
          </MemoryRouter>
        </QueryClientProvider>
      );

      expect(html).toContain('Your Personal Promotional Link');
      expect(html).toContain('/r/amina-kilifi-vip');
      expect(html).toContain('Link Active');
      expect(html).toContain('Copy Link');
      expect(html).toContain('Customize Slug');
      expect(html).toContain('Historical aliases permanently preserved');
    });

    it('renders disabled/paused status when host link is DISABLED by organizer', () => {
      // Switch active event to Sol Fest where hostLink status is 'DISABLED'
      queryClient.setQueryData(['host-events'], [mockHostAssignedEvents[1]]);

      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <HostDashboardPage />
          </MemoryRouter>
        </QueryClientProvider>
      );

      expect(html).toContain('Sol Fest Nairobi 2026');
      expect(html).toContain('/r/amina-sol-fest');
      expect(html).toContain('Paused by Organizer');
      expect(html).toContain('This link is currently paused by the organizer.');
    });

    it('renders archived status when host link is ARCHIVED', () => {
      const archivedAssignedEvent: HostAssignedEventItem = {
        membershipId: 'mem-host-archived',
        event: {
          id: 'evt-archived-1',
          slug: 'past-event-2025',
          title: 'Past Sunset Sessions 2025',
          status: 'ARCHIVED',
          startAt: '2025-11-20T18:00:00.000Z',
          endAt: '2025-11-21T06:00:00.000Z',
          venueName: 'Diani Reef',
          city: 'Diani',
          coverImageUrl: null,
        },
        hostLink: {
          id: 'link-archived-1',
          name: 'Old Host Link',
          status: 'ARCHIVED',
          slug: 'amina-past-sunset',
          shortUrl: '/r/amina-past-sunset',
        },
      };

      queryClient.setQueryData(['host-events'], [archivedAssignedEvent]);

      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <HostDashboardPage />
          </MemoryRouter>
        </QueryClientProvider>
      );

      expect(html).toContain('Past Sunset Sessions 2025');
      expect(html).toContain('Archived');
      expect(html).toContain('This link has been archived.');
    });
  });

  // =========================================================================
  // 3. Private Host Traffic Analytics
  // =========================================================================
  describe('3. Private Host Traffic Analytics Display & Invariants', () => {
    it('renders headline KPIs: Total Clicks, Unique Visitors, and Visits per Visitor frequency ratio', () => {
      queryClient.setQueryData(['host-events'], mockHostAssignedEvents);
      queryClient.setQueryData(
        ['host-analytics', mockHostAssignedEvents[0].event.id],
        mockHostAnalytics
      );

      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <HostDashboardPage />
          </MemoryRouter>
        </QueryClientProvider>
      );

      // Privacy banner
      expect(html).toContain('Private Host Traffic Analytics');
      expect(html).toContain('These metrics represent traffic generated exclusively by your personal promotional link.');

      // KPI numbers
      expect(html).toContain('450'); // total clicks
      expect(html).toContain('310'); // unique visitors
      // Frequency ratio: 450 / 310 = 1.45 -> 1.5
      expect(html).toContain('1.5');
      expect(html).toContain('Repeat visitor frequency');

      // Daily discovery trend
      expect(html).toContain('Daily Discovery Activity');
      expect(html).toContain('Unique visitors vs clicks over time');

      // Top referrers
      expect(html).toContain('Top Traffic Channels &amp; Referrers');
      expect(html).toContain('instagram.com');
      expect(html).toContain('whatsapp');
      expect(html).toContain('Direct / None');
    });

    it('renders empty analytics state when the host link has 0 clicks and 0 visitors', () => {
      queryClient.setQueryData(['host-events'], mockHostAssignedEvents);
      queryClient.setQueryData(
        ['host-analytics', mockHostAssignedEvents[0].event.id],
        {
          link: mockHostAssignedEvents[0].hostLink!,
          traffic: {
            totalClicks: 0,
            uniqueVisitors: 0,
            dailyVisits: [],
            topReferrers: [],
          },
        }
      );

      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <HostDashboardPage />
          </MemoryRouter>
        </QueryClientProvider>
      );

      expect(html).toContain('No Traffic Recorded Yet');
      expect(html).toContain('Share your promotional link on your channels to start discovering your audience');
    });

    it('does not leak stale traffic analytics when active event link does not match cached analytics', () => {
      // Event 2 is active (hostLink: link-host-amina-2)
      queryClient.setQueryData(['host-events'], [mockHostAssignedEvents[1]]);
      // Cache analytics for Event 2, but simulate mismatched/stale data belonging to link-host-amina-1
      queryClient.setQueryData(
        ['host-analytics', mockHostAssignedEvents[1].event.id],
        mockHostAnalytics // belongs to link-host-amina-1 with 450 clicks
      );

      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <HostDashboardPage />
          </MemoryRouter>
        </QueryClientProvider>
      );

      // Stale traffic data (450 clicks, 310 visitors) must NOT be rendered
      expect(html).not.toContain('450');
      expect(html).not.toContain('Repeat visitor frequency');
      // Instead, loading indicator is safely rendered
      expect(html).toContain('Loading private traffic analytics...');
    });
  });

  // =========================================================================
  // 4. API Client Integration (`api.host`)
  // =========================================================================
  describe('4. api.host Client Method Verification', () => {
    it('api.host.getEvents dispatches GET to /api/host/events', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce((url) => {
        expect(url as string).toContain('/host/events');
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              events: mockHostAssignedEvents,
            }),
        } as any);
      });

      const events = await api.host.getEvents();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(events.length).toBe(2);
      expect(events[0].membershipId).toBe('mem-host-1');
      expect(events[0].hostLink?.slug).toBe('amina-kilifi-vip');
    });

    it('api.host.getAnalytics dispatches GET to /api/host/events/:eventId/analytics', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce((url) => {
        expect(url as string).toContain(`/host/events/${mockHostAssignedEvents[0].event.id}/analytics`);
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              ...mockHostAnalytics,
            }),
        } as any);
      });

      const analytics = await api.host.getAnalytics(mockHostAssignedEvents[0].event.id);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(analytics.traffic.totalClicks).toBe(450);
      expect(analytics.traffic.uniqueVisitors).toBe(310);
      expect(analytics.traffic.topReferrers.length).toBe(3);
    });

    it('api.host.customizeSlug dispatches PATCH to /api/host/events/:eventId/slug with { slug }', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce((url, init) => {
        expect(url as string).toContain(`/host/events/${mockHostAssignedEvents[0].event.id}/slug`);
        expect(init?.method).toBe('PATCH');
        const body = JSON.parse(init?.body as string);
        expect(body.slug).toBe('amina-exclusive-nye');

        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              primarySlug: 'amina-exclusive-nye',
              previousSlug: 'amina-kilifi-vip',
              shortUrl: '/r/amina-exclusive-nye',
            }),
        } as any);
      });

      const result = await api.host.customizeSlug(
        mockHostAssignedEvents[0].event.id,
        'amina-exclusive-nye'
      );

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(result.primarySlug).toBe('amina-exclusive-nye');
      expect(result.previousSlug).toBe('amina-kilifi-vip');
    });

    it('api.host handles 401/403 unauthorized or revoked host responses cleanly', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => {
        return Promise.resolve({
          ok: false,
          status: 403,
          json: () =>
            Promise.resolve({
              success: false,
              message: 'Active Event Host membership required to view Host analytics.',
            }),
        } as any);
      });

      await expect(
        api.host.getAnalytics('evt-unauthorized')
      ).rejects.toThrow('Active Event Host membership required');
    });
  });

  // =========================================================================
  // 5. Strict Privacy, Scope Restrictions & Dual-Role Support
  // =========================================================================
  describe('5. Strict Privacy Invariants & Dual-Role Support', () => {
    it('verifies HostDashboardPage source code contains zero financial or ticket sales concepts', () => {
      const hostComponentCode = fs.readFileSync(
        path.resolve(__dirname, '../src/pages/HostDashboardPage.tsx'),
        'utf8'
      );

      // Absolutely NO ticket sales or revenue
      expect(hostComponentCode).not.toContain('ticketSales');
      expect(hostComponentCode).not.toContain('revenue');
      expect(hostComponentCode).not.toContain('orderAttribution');
      expect(hostComponentCode).not.toContain('commission');
      expect(hostComponentCode).not.toContain('payout');
      expect(hostComponentCode).not.toContain('stripe');
      expect(hostComponentCode).not.toContain('grossRevenue');
      expect(hostComponentCode).not.toContain('attendeeEmail');

      // Explains private host scope clearly
      expect(hostComponentCode).toContain('Private Host Traffic Analytics');
      expect(hostComponentCode).toContain('These metrics represent traffic generated exclusively by your personal promotional link');
    });

    it('verifies Navbar includes Host Workspace link alongside Organizer Dashboard for dual-role users', () => {
      const navbarCode = fs.readFileSync(
        path.resolve(__dirname, '../src/components/layout/Navbar.tsx'),
        'utf8'
      );

      expect(navbarCode).toContain('Organizer Dashboard');
      expect(navbarCode).toContain('Host Workspace');
      expect(navbarCode).toContain('to="/host"');
      expect(navbarCode).toContain('to="/organizer"');
    });

    it('verifies App.tsx routes /host protected with RequireAuth', () => {
      const appCode = fs.readFileSync(path.resolve(__dirname, '../src/App.tsx'), 'utf8');

      expect(appCode).toContain('path="/host"');
      expect(appCode).toContain('HostDashboardPage');
      expect(appCode).toContain('RequireAuth');
    });
  });
});
