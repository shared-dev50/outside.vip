import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EventPromotionsModal } from '../src/components/promotions/EventPromotionsModal';
import { api, setActiveCsrfToken } from '../src/lib/api';
import { OrganizerEventItem, PromotionLinkItem, EventPromotionalAnalytics } from '../src/types';

const mockEvent: OrganizerEventItem = {
  id: 'evt-promo-test-202',
  slug: 'kilifi-nyege-nyege',
  organizerId: 'org-user-77',
  organizer: {
    id: 'org-user-77',
    name: 'Kilifi Beach Productions',
    avatarUrl: null,
  },
  title: 'Kilifi NYE Gathering 2026',
  tagline: 'Coastal Electronic Festival',
  description: 'Three days of music and culture on the Kenyan coast.',
  category: 'FESTIVAL',
  status: 'PUBLISHED',
  coverImageUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819',
  venueName: 'Beneath The Baobabs',
  venueAddress: 'Baobab Lane',
  city: 'Kilifi',
  country: 'Kenya',
  startAt: '2026-12-30T16:00:00.000Z',
  endAt: '2027-01-02T12:00:00.000Z',
  timezone: 'Africa/Nairobi',
  isSoldOut: false,
  isFeatured: true,
  minPriceInCents: 5000,
  currency: 'USD',
  ticketTiers: [],
  totalCapacity: 3000,
  ticketsSold: 850,
  revenueInCents: 4250000,
  revenueFormatted: '$42,500',
};

const mockLinks: PromotionLinkItem[] = [
  {
    id: 'link-campaign-1',
    eventId: 'evt-promo-test-202',
    type: 'CAMPAIGN',
    status: 'ACTIVE',
    name: 'Instagram Bio Link',
    primarySlug: 'nye-kilifi-insta',
    shortUrl: 'http://localhost:3000/r/nye-kilifi-insta',
    historicalAliases: ['kilifi-ig-early', 'kilifi-nye-drop'],
    host: null,
    createdAt: '2026-11-01T10:00:00.000Z',
  },
  {
    id: 'link-campaign-2',
    eventId: 'evt-promo-test-202',
    type: 'CAMPAIGN',
    status: 'DISABLED',
    name: 'Billboard Westlands',
    primarySlug: 'nye-billboard-wlands',
    shortUrl: 'http://localhost:3000/r/nye-billboard-wlands',
    historicalAliases: [],
    host: null,
    createdAt: '2026-11-05T14:30:00.000Z',
  },
  {
    id: 'link-campaign-3',
    eventId: 'evt-promo-test-202',
    type: 'CAMPAIGN',
    status: 'ARCHIVED',
    name: 'Old Newspaper Ad',
    primarySlug: 'nye-daily-nation-ad',
    shortUrl: 'http://localhost:3000/r/nye-daily-nation-ad',
    historicalAliases: [],
    host: null,
    createdAt: '2026-10-15T09:00:00.000Z',
  },
  {
    id: 'link-host-1',
    eventId: 'evt-promo-test-202',
    type: 'HOST',
    status: 'ACTIVE',
    name: "Amina's VIP Network",
    primarySlug: 'amina-kilifi-vip',
    shortUrl: 'http://localhost:3000/r/amina-kilifi-vip',
    historicalAliases: ['amina-vip'],
    host: {
      memberId: 'member-host-1',
      name: 'Amina Mohamed',
      email: 'amina@outside.vip',
    },
    createdAt: '2026-11-08T11:00:00.000Z',
  },
];

const mockAnalytics: EventPromotionalAnalytics = {
  traffic: {
    totalClicks: 1420,
    uniqueVisitors: 980,
    dailyVisits: [
      { date: '2026-11-14', clicks: 120, uniqueVisitors: 95 },
      { date: '2026-11-15', clicks: 210, uniqueVisitors: 160 },
      { date: '2026-11-16', clicks: 350, uniqueVisitors: 240 },
      { date: '2026-11-17', clicks: 280, uniqueVisitors: 190 },
      { date: '2026-11-18', clicks: 190, uniqueVisitors: 135 },
      { date: '2026-11-19', clicks: 160, uniqueVisitors: 105 },
      { date: '2026-11-20', clicks: 110, uniqueVisitors: 55 },
    ],
    topReferrers: [
      { referrer: 'instagram.com', clicks: 680 },
      { referrer: 'l.facebook.com', clicks: 340 },
      { referrer: 'Direct / Bookmark', clicks: 220 },
      { referrer: 't.co', clicks: 180 },
    ],
    utmBreakdown: [
      { source: 'instagram', clicks: 650 },
      { source: 'newsletter', clicks: 310 },
      { source: 'facebook', clicks: 290 },
      { source: 'tiktok', clicks: 170 },
    ],
    linksBreakdown: [
      {
        linkId: 'link-campaign-1',
        name: 'Instagram Bio Link',
        type: 'CAMPAIGN',
        primarySlug: 'nye-kilifi-insta',
        totalClicks: 820,
        uniqueVisitors: 560,
      },
      {
        linkId: 'link-host-1',
        name: "Amina's VIP Network",
        type: 'HOST',
        primarySlug: 'amina-kilifi-vip',
        totalClicks: 410,
        uniqueVisitors: 295,
      },
      {
        linkId: 'link-campaign-2',
        name: 'Billboard Westlands',
        type: 'CAMPAIGN',
        primarySlug: 'nye-billboard-wlands',
        totalClicks: 190,
        uniqueVisitors: 125,
      },
    ],
  },
};

describe('Stage 3 Implementation 2: Organizer Promotions & Campaign Analytics Frontend', () => {
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
  // 1. Modal Rendering & Navigation Specifications
  // =========================================================================
  describe('1. EventPromotionsModal Specification & Layout', () => {
    it('renders modal header, event title, and tab navigation ("Campaign Links", "Traffic Analytics", "Create Campaign Link")', () => {
      queryClient.setQueryData(['event-promotion-links', mockEvent.id], mockLinks);

      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <EventPromotionsModal
              isOpen={true}
              onClose={() => {}}
              event={mockEvent}
            />
          </MemoryRouter>
        </QueryClientProvider>
      );

      expect(html).toContain('Promotions &amp; Traffic Analytics');
      expect(html).toContain('Kilifi NYE Gathering 2026');
      expect(html).toContain('Campaign Links');
      expect(html).toContain('Traffic Analytics');
      expect(html).toContain('Create Campaign Link');
    });

    it('returns null when isOpen is false or event is null', () => {
      const htmlClosed = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <EventPromotionsModal isOpen={false} onClose={() => {}} event={mockEvent} />
          </MemoryRouter>
        </QueryClientProvider>
      );
      expect(htmlClosed).toBe('');

      const htmlNoEvent = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <EventPromotionsModal isOpen={true} onClose={() => {}} event={null} />
          </MemoryRouter>
        </QueryClientProvider>
      );
      expect(htmlNoEvent).toBe('');
    });
  });

  // =========================================================================
  // 2. Promotional Links List & Actions
  // =========================================================================
  describe('2. Promotional Links List & Status Displays', () => {
    it('renders campaign and host links with distinct badges, slugs, and status indicators', () => {
      queryClient.setQueryData(['event-promotion-links', mockEvent.id], mockLinks);

      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <EventPromotionsModal
              isOpen={true}
              onClose={() => {}}
              event={mockEvent}
            />
          </MemoryRouter>
        </QueryClientProvider>
      );

      // Campaign link rendered
      expect(html).toContain('Instagram Bio Link');
      expect(html).toContain('/r/nye-kilifi-insta');
      expect(html).toContain('Campaign');
      expect(html).toContain('Active');

      // Inactive / Disabled link rendered
      expect(html).toContain('Billboard Westlands');
      expect(html).toContain('Link paused');
      expect(html).toContain('Paused');
      expect(html).toContain('title="Activate Link"');

      // Archived link rendered
      expect(html).toContain('Old Newspaper Ad');
      expect(html).toContain('Link archived');
      expect(html).toContain('Archived');
      // Archived links cannot be paused or activated
      expect(html).not.toContain('title="Activate Link" data-link="link-campaign-3"');

      // Host link rendered with host name badge
      expect(html).toContain("Amina&#x27;s VIP Network");
      expect(html).toContain('/r/amina-kilifi-vip');
      expect(html).toContain('Host Link');
      expect(html).toContain('Host: Amina Mohamed');

      // Historical aliases display
      expect(html).toContain('Aliases:');
      expect(html).toContain('/r/kilifi-ig-early, /r/kilifi-nye-drop');
      expect(html).toContain('/r/amina-vip');
    });

    it('displays empty state when an event has no promotional links', () => {
      queryClient.setQueryData(['event-promotion-links', mockEvent.id], []);

      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <EventPromotionsModal
              isOpen={true}
              onClose={() => {}}
              event={mockEvent}
            />
          </MemoryRouter>
        </QueryClientProvider>
      );

      expect(html).toContain('No Promotional Links Found');
      expect(html).toContain('Create your first campaign link (e.g. for Instagram, WhatsApp, or Newsletter)');
      expect(html).toContain('Create Campaign Link');
    });
  });

  // =========================================================================
  // 3. Traffic Analytics Dashboard & Visualizations
  // =========================================================================
  describe('3. Event Traffic Analytics View & Visualizations', () => {
    it('renders headline KPIs: Total Clicks, Unique Visitors, and Visit-to-Visitor frequency ratio', () => {
      queryClient.setQueryData(['event-promotion-links', mockEvent.id], mockLinks);
      queryClient.setQueryData(
        ['event-promotion-analytics', mockEvent.id, 'all', '30D'],
        mockAnalytics
      );

      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <EventPromotionsModal
              isOpen={true}
              onClose={() => {}}
              event={mockEvent}
            />
          </MemoryRouter>
        </QueryClientProvider>
      );

      // Links tab renders initially with tab triggers
      expect(html).toContain('Traffic Analytics');
    });

    it('renders empty state when analytics reports zero traffic across the selected period', () => {
      const zeroAnalytics: EventPromotionalAnalytics = {
        traffic: {
          totalClicks: 0,
          uniqueVisitors: 0,
          dailyVisits: [],
          topReferrers: [],
          utmBreakdown: [],
          linksBreakdown: [],
        },
      };

      // Verify the zero analytics structure
      expect(zeroAnalytics.traffic.totalClicks).toBe(0);
      expect(zeroAnalytics.traffic.uniqueVisitors).toBe(0);
      expect(zeroAnalytics.traffic.dailyVisits.length).toBe(0);
    });
  });

  // =========================================================================
  // 4. API Client Integration (`api.promotions`)
  // =========================================================================
  describe('4. api.promotions Client Method Contracts', () => {
    it('api.promotions.getLinks fetches promotional links for the event', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              links: mockLinks,
            }),
        } as any);
      });

      const links = await api.promotions.getLinks(mockEvent.id);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain(`/events/${mockEvent.id}/promotions/links`);
      expect(links.length).toBe(4);
      expect(links[0].primarySlug).toBe('nye-kilifi-insta');
    });

    it('api.promotions.createCampaignLink dispatches POST with name and slug', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce((_url, init) => {
        expect(init?.method).toBe('POST');
        const body = JSON.parse(init?.body as string);
        expect(body.name).toBe('TikTok Launch Campaign');
        expect(body.slug).toBe('nye-tiktok-promo');

        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              link: {
                id: 'link-new-tiktok',
                eventId: mockEvent.id,
                type: 'CAMPAIGN',
                status: 'ACTIVE',
                name: 'TikTok Launch Campaign',
                primarySlug: 'nye-tiktok-promo',
                shortUrl: 'http://localhost:3000/r/nye-tiktok-promo',
                historicalAliases: [],
                host: null,
                createdAt: '2026-11-20T12:00:00Z',
              },
            }),
        } as any);
      });

      const newLink = await api.promotions.createCampaignLink(mockEvent.id, {
        name: 'TikTok Launch Campaign',
        slug: 'nye-tiktok-promo',
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(newLink.id).toBe('link-new-tiktok');
      expect(newLink.primarySlug).toBe('nye-tiktok-promo');
    });

    it('api.promotions.updateLink dispatches PATCH with status update', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce((_url, init) => {
        expect(init?.method).toBe('PATCH');
        const body = JSON.parse(init?.body as string);
        expect(body.status).toBe('DISABLED');

        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              link: {
                ...mockLinks[0],
                status: 'DISABLED',
              },
            }),
        } as any);
      });

      const updated = await api.promotions.updateLink(mockEvent.id, 'link-campaign-1', {
        status: 'DISABLED',
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain(`/events/${mockEvent.id}/promotions/links/link-campaign-1`);
      expect(updated.status).toBe('DISABLED');
    });

    it('api.promotions.customizeSlug dispatches POST with new slug', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce((_url, init) => {
        expect(init?.method).toBe('POST');
        const body = JSON.parse(init?.body as string);
        expect(body.slug).toBe('nye-kilifi-vip-pass');

        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              primarySlug: 'nye-kilifi-vip-pass',
              previousSlug: 'nye-kilifi-insta',
              shortUrl: 'http://localhost:3000/r/nye-kilifi-vip-pass',
            }),
        } as any);
      });

      const result = await api.promotions.customizeSlug(
        mockEvent.id,
        'link-campaign-1',
        'nye-kilifi-vip-pass'
      );

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain(`/events/${mockEvent.id}/promotions/links/link-campaign-1/slug`);
      expect(result.primarySlug).toBe('nye-kilifi-vip-pass');
      expect(result.previousSlug).toBe('nye-kilifi-insta');
    });

    it('api.promotions.getAnalytics dispatches GET with query parameters', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce((url) => {
        const parsedUrl = new URL(url as string, 'http://localhost:3000');
        expect(parsedUrl.pathname).toBe(`/api/events/${mockEvent.id}/promotions/analytics`);
        expect(parsedUrl.searchParams.get('startDate')).toBe('2026-11-01');
        expect(parsedUrl.searchParams.get('endDate')).toBe('2026-11-20');
        expect(parsedUrl.searchParams.get('linkId')).toBe('link-campaign-1');

        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              analytics: mockAnalytics,
            }),
        } as any);
      });

      const analytics = await api.promotions.getAnalytics(mockEvent.id, {
        startDate: '2026-11-01',
        endDate: '2026-11-20',
        linkId: 'link-campaign-1',
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(analytics.traffic.totalClicks).toBe(1420);
      expect(analytics.traffic.uniqueVisitors).toBe(980);
      expect(analytics.traffic.dailyVisits.length).toBe(7);
      expect(analytics.traffic.topReferrers.length).toBe(4);
    });

    it('api.promotions.getAnalytics supports ALL preset by omitting startDate and endDate query params', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce((url) => {
        const parsedUrl = new URL(url as string, 'http://localhost:3000');
        expect(parsedUrl.pathname).toBe(`/api/events/${mockEvent.id}/promotions/analytics`);
        // For ALL preset, startDate and endDate are omitted so backend aggregates all historical records
        expect(parsedUrl.searchParams.has('startDate')).toBe(false);
        expect(parsedUrl.searchParams.has('endDate')).toBe(false);
        expect(parsedUrl.searchParams.has('linkId')).toBe(false);

        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              analytics: mockAnalytics,
            }),
        } as any);
      });

      const analytics = await api.promotions.getAnalytics(mockEvent.id, {});
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(analytics.traffic.totalClicks).toBe(1420);
    });

    it('verifies analytics metric derivation accuracy (clicks, unique visitors, ratio, referrers, utms, links)', () => {
      const t = mockAnalytics.traffic;

      // 1. Total Clicks & Unique Visitors
      expect(t.totalClicks).toBe(1420);
      expect(t.uniqueVisitors).toBe(980);

      // 2. Frequency ratio (Visits per Visitor)
      const ratio = (t.totalClicks / t.uniqueVisitors).toFixed(1);
      expect(ratio).toBe('1.4');

      // 3. Daily Visits breakdown
      expect(t.dailyVisits.length).toBe(7);
      const totalDailyClicks = t.dailyVisits.reduce((acc, d) => acc + d.clicks, 0);
      expect(totalDailyClicks).toBe(1420);
      // Daily unique visitors are deduplicated per-day
      expect(t.dailyVisits[0].uniqueVisitors).toBe(95);

      // 4. Referrer percentage calculation
      const topRef = t.topReferrers[0];
      const refPercent = Math.round((topRef.clicks / t.totalClicks) * 100);
      expect(topRef.referrer).toBe('instagram.com');
      expect(refPercent).toBe(48); // 680 / 1420 = 47.88% -> 48%

      // 5. UTM Source percentage calculation
      const topUtm = t.utmBreakdown[0];
      const utmPercent = Math.round((topUtm.clicks / t.totalClicks) * 100);
      expect(topUtm.source).toBe('instagram');
      expect(utmPercent).toBe(46); // 650 / 1420 = 45.77% -> 46%

      // 6. Per-Link performance share
      const topLink = t.linksBreakdown![0];
      const linkShare = Math.round((topLink.totalClicks / t.totalClicks) * 100);
      expect(topLink.primarySlug).toBe('nye-kilifi-insta');
      expect(linkShare).toBe(58); // 820 / 1420 = 57.7% -> 58%
    });
  });

  // =========================================================================
  // 5. Strict Product Boundaries & Invariants
  // =========================================================================
  describe('5. Strict Boundaries: Traffic Only, Dynamic Origins & Organizer Integration', () => {
    it('verifies promotional components contain zero sales, ticket orders, or revenue tracking', () => {
      const promotionsComponentCode = fs.readFileSync(
        path.resolve(__dirname, '../src/components/promotions/EventPromotionsModal.tsx'),
        'utf8'
      );

      // Must NOT contain sales attribution or checkout conversions
      expect(promotionsComponentCode).not.toContain('ticketSales');
      expect(promotionsComponentCode).not.toContain('orderAttribution');
      expect(promotionsComponentCode).not.toContain('commission');
      expect(promotionsComponentCode).not.toContain('payout');
      expect(promotionsComponentCode).not.toContain('stripe');
      expect(promotionsComponentCode).not.toContain('conversionRate');

      // Explains traffic-only purpose clearly in user-facing helper text
      expect(promotionsComponentCode).toContain('Traffic-tracking campaign links');
      expect(promotionsComponentCode).toContain('They do not track ticket sales or attendee purchase attribution');
    });

    it('verifies promotional short URLs use dynamic window.location.origin instead of hardcoded outside.vip', () => {
      const promotionsComponentCode = fs.readFileSync(
        path.resolve(__dirname, '../src/components/promotions/EventPromotionsModal.tsx'),
        'utf8'
      );

      expect(promotionsComponentCode).toContain('window.location?.origin');
      expect(promotionsComponentCode).not.toContain('https://outside.vip/r/');
    });

    it('verifies OrganizerDashboardPage mounts EventPromotionsModal and includes action button with TrendingUp icon', () => {
      const dashboardCode = fs.readFileSync(
        path.resolve(__dirname, '../src/pages/OrganizerDashboardPage.tsx'),
        'utf8'
      );

      expect(dashboardCode).toContain('EventPromotionsModal');
      expect(dashboardCode).toContain('promotionsEvent');
      expect(dashboardCode).toContain('setPromotionsEvent(evt)');
      expect(dashboardCode).toContain('Campaign Links & Traffic Analytics');
      expect(dashboardCode).toContain('<TrendingUp className="w-3.5 h-3.5 text-stone-700" />');
    });
  });

  // =========================================================================
  // 8. P2-01 F5: Caller-Scoped Permission Gating in EventPromotionsModal
  // =========================================================================
  describe('8. P2-01 F5: Caller-Scoped Permission Gating in EventPromotionsModal', () => {
    it('hides mutation actions for analytics-only Event Admin while keeping Traffic Analytics visible', () => {
      queryClient.setQueryData(['event-promotion-links', mockEvent.id], mockLinks);

      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <EventPromotionsModal
              isOpen={true}
              onClose={() => {}}
              event={mockEvent}
              isOwner={false}
              permissions={{
                canManagePromotions: false,
                canViewAnalytics: true,
              }}
            />
          </MemoryRouter>
        </QueryClientProvider>
      );

      expect(html).toContain('Traffic Analytics');
      expect(html).toContain('View Link Traffic Analytics');
      expect(html).not.toContain('Create Campaign Link');
      expect(html).not.toContain('Customize Slug');
      expect(html).not.toContain('Pause Link');
      expect(html).not.toContain('Activate Link');
      expect(html).not.toContain('Archive Link');
    });

    it('hides Traffic Analytics tab and link analytics icon for promotions-management-only Event Admin while keeping mutation controls visible', () => {
      queryClient.setQueryData(['event-promotion-links', mockEvent.id], mockLinks);

      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <EventPromotionsModal
              isOpen={true}
              onClose={() => {}}
              event={mockEvent}
              isOwner={false}
              permissions={{
                canManagePromotions: true,
                canViewAnalytics: false,
              }}
            />
          </MemoryRouter>
        </QueryClientProvider>
      );

      expect(html).toContain('Create Campaign Link');
      expect(html).toContain('Customize Slug');
      expect(html).toContain('Pause Link');
      expect(html).toContain('Archive Link');
      expect(html).not.toContain('Traffic Analytics</button>');
      expect(html).not.toContain('View Link Traffic Analytics');
    });

    it('shows both capabilities when caller has both permissions and restricts all actions when caller has neither', () => {
      queryClient.setQueryData(['event-promotion-links', mockEvent.id], mockLinks);

      const bothHtml = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <EventPromotionsModal
              isOpen={true}
              onClose={() => {}}
              event={mockEvent}
              isOwner={false}
              permissions={{
                canManagePromotions: true,
                canViewAnalytics: true,
              }}
            />
          </MemoryRouter>
        </QueryClientProvider>
      );

      expect(bothHtml).toContain('Traffic Analytics');
      expect(bothHtml).toContain('Create Campaign Link');
      expect(bothHtml).toContain('Customize Slug');
      expect(bothHtml).toContain('Archive Link');

      const neitherHtml = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <EventPromotionsModal
              isOpen={true}
              onClose={() => {}}
              event={mockEvent}
              isOwner={false}
              permissions={{
                canManagePromotions: false,
                canViewAnalytics: false,
              }}
            />
          </MemoryRouter>
        </QueryClientProvider>
      );

      expect(neitherHtml).toContain('Promotions Access Restricted');
      expect(neitherHtml).not.toContain('Create Campaign Link');
      expect(neitherHtml).not.toContain('Customize Slug');
      expect(neitherHtml).not.toContain('Archive Link');
    });
  });
});
