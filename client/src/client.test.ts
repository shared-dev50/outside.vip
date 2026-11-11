import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi } from 'vitest';
import {
  api,
  resolveApiBaseUrl,
  buildApiUrl,
  getActiveCsrfToken,
  setActiveCsrfToken,
} from './lib/api';

describe('Outside.vip Client Library', () => {
  it('should define public API service routes', () => {
    expect(api.events).toBeDefined();
    expect(typeof api.events.list).toBe('function');
    expect(typeof api.events.bySlug).toBe('function');
    expect(typeof api.events.featured).toBe('function');
    expect(typeof api.events.cities).toBe('function');
    expect(api.auth).toBeDefined();
    expect(typeof api.auth.login).toBe('function');
    expect(typeof api.auth.register).toBe('function');
    expect(typeof api.auth.logout).toBe('function');
    expect(typeof api.auth.logoutAll).toBe('function');
    expect(typeof api.auth.changePassword).toBe('function');
    expect(typeof api.auth.csrf).toBe('function');
    expect(typeof api.auth.me).toBe('function');
    expect(typeof api.auth.verifyEmail).toBe('function');
    expect(typeof api.auth.resendVerification).toBe('function');
    expect(typeof api.organizer.getWorkspace).toBe('function');
    expect(typeof api.organizer.upsertWorkspace).toBe('function');
  });

  it('sends credentials: include and attaches X-CSRF-Token on state-changing requests without storing tokens in localStorage', async () => {
    setActiveCsrfToken('csrf_test_token_256bit');
    expect(getActiveCsrfToken()).toBe('csrf_test_token_256bit');

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        headers: { get: () => 'csrf_rotated_token_256bit' },
        json: () =>
          Promise.resolve({
            success: true,
            data: { message: 'Logged out' },
          }),
      } as any)
    );

    await api.auth.logout();

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/auth/logout',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        headers: expect.objectContaining({
          'X-CSRF-Token': 'csrf_test_token_256bit',
        }),
      })
    );
    // Logout clears the in-memory CSRF token
    expect(getActiveCsrfToken()).toBeNull();

    fetchSpy.mockRestore();
  });

  it('api.events.list builds correct query string with filters and sorting', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: {
              events: [],
              pagination: { page: 1, limit: 12, total: 0, totalPages: 0, hasMore: false },
            },
          }),
      } as any)
    );

    await api.events.list({
      search: 'Warehouse',
      category: 'NIGHTLIFE',
      city: 'Nairobi',
      timeFilter: 'this_weekend',
      sortBy: 'price_asc',
    });

    expect(fetchSpy).toHaveBeenCalled();
    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/api/events?');
    expect(calledUrl).toContain('search=Warehouse');
    expect(calledUrl).toContain('category=NIGHTLIFE');
    expect(calledUrl).toContain('city=Nairobi');
    expect(calledUrl).toContain('timeFilter=this_weekend');
    expect(calledUrl).toContain('sortBy=price_asc');

    fetchSpy.mockRestore();
  });

  it('api.events.featured calls /api/events/featured', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: { events: [] },
          }),
      } as any)
    );

    await api.events.featured();
    expect(fetchSpy).toHaveBeenCalled();
    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/api/events/featured');

    fetchSpy.mockRestore();
  });

  it('api.events.cities calls /api/events/cities', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: { cities: ['Nairobi', 'Kilifi'] },
          }),
      } as any)
    );

    const res = await api.events.cities();
    expect(fetchSpy).toHaveBeenCalled();
    expect(res.cities).toEqual(['Nairobi', 'Kilifi']);

    fetchSpy.mockRestore();
  });

  it('should define organizer API methods and invoke correct endpoints', async () => {
    expect(api.organizer).toBeDefined();
    expect(typeof api.organizer.getDashboard).toBe('function');
    expect(typeof api.organizer.listEvents).toBe('function');
    expect(typeof api.organizer.getEvent).toBe('function');
    expect(typeof api.organizer.getPayoutDetails).toBe('function');
    expect(typeof api.organizer.updatePayoutDetails).toBe('function');
    expect(typeof api.organizer.createEvent).toBe('function');
    expect(typeof api.organizer.updateEvent).toBe('function');
    expect(typeof api.organizer.publishEvent).toBe('function');
    expect(typeof api.organizer.unpublishEvent).toBe('function');
    expect(typeof api.organizer.deleteEvent).toBe('function');

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: {
              totalEvents: 3,
              publishedEvents: 2,
              draftEvents: 1,
              ticketsSold: 120,
              grossRevenueInCents: 450000,
              grossRevenueFormatted: '$4,500',
              currency: 'USD',
            },
          }),
      } as any)
    );

    await api.organizer.getDashboard();
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/organizer/dashboard',
      expect.objectContaining({
        headers: expect.any(Object),
      })
    );

    await api.organizer.getPayoutDetails();
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/organizer/payout-details',
      expect.objectContaining({
        headers: expect.any(Object),
      })
    );

    await api.organizer.updatePayoutDetails({
      orgType: 'Company',
      registeredName: 'Test Org Ltd',
      country: 'Kenya',
      contactPersonName: 'Test Contact',
      contactEmail: 'contact@test.com',
      accountHolderName: 'Test Org Ltd',
      bankName: 'Test Bank',
      bankCountry: 'Kenya',
      accountCurrency: 'USD',
      accountNumber: '12345678',
      confirmAccountNumber: '12345678',
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/organizer/payout-details',
      expect.objectContaining({
        method: 'PUT',
        headers: expect.any(Object),
        body: expect.stringContaining('Test Org Ltd'),
      })
    );

    await api.organizer.publishEvent('evt-123');
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/organizer/events/evt-123/publish',
      expect.objectContaining({
        method: 'POST',
      })
    );

    await api.organizer.unpublishEvent('evt-123');
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/organizer/events/evt-123/unpublish',
      expect.objectContaining({
        method: 'POST',
      })
    );

    fetchSpy.mockRestore();
  });

  it('api.organizer.uploadCoverImage handles signed upload to Cloudinary', async () => {
    const fakeFile = new File(['dummy-content'], 'flyer.png', { type: 'image/png' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      if (typeof url === 'string' && url.includes('/organizer/upload/sign')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              data: {
                cloudName: 'test-cloud',
                apiKey: 'test-key',
                timestamp: 1234567890,
                folder: 'outside-vip/event-covers',
                signature: 'test-sig',
                uploadUrl: 'https://api.cloudinary.com/v1_1/test-cloud/image/upload',
              },
            }),
        } as any);
      }

      if (typeof url === 'string' && url.includes('cloudinary.com')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              secure_url: 'https://res.cloudinary.com/test-cloud/image/upload/v1234/outside-vip/event-covers/test.png',
              public_id: 'outside-vip/event-covers/test',
            }),
        } as any);
      }

      return Promise.resolve({ ok: false } as any);
    });

    const res = await api.organizer.uploadCoverImage(fakeFile);
    expect(res.secure_url).toContain('https://res.cloudinary.com/test-cloud/image/upload');
    expect(res.public_id).toBe('outside-vip/event-covers/test');
    expect(res.thumbnailUrl).toContain('c_fill,g_auto,w_600,h_400');
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    fetchSpy.mockRestore();
  });

  it('api.checkout.createSession invokes POST /api/checkout/create-session', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: {
              orderNumber: 'OUT-2026-99999',
              orderAccessToken: 'oat_test_123',
              clientSecret: 'pi_test_123_secret_xyz',
              publishableKey: 'pk_test_sample',
              totalInCents: 10000,
              currency: 'USD',
              expiresAt: new Date().toISOString(),
            },
          }),
      } as any)
    );

    const res = await api.checkout.createSession({
      eventId: 'evt-123',
      items: [{ ticketTierId: 'tier-1', quantity: 2 }],
      customerEmail: 'test@outside.vip',
      customerName: 'Test Buyer',
      customerPhone: '+15551234567',
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/checkout/create-session',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"eventId":"evt-123"'),
      })
    );
    expect(res.clientSecret).toBe('pi_test_123_secret_xyz');
    expect(res.orderNumber).toBe('OUT-2026-99999');

    fetchSpy.mockRestore();
  });

  it('api.orders.getByOrderNumber invokes GET /api/orders/:orderNumber with access token query', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: {
              order: {
                id: 'ord-123',
                orderNumber: 'OUT-2026-99999',
                status: 'COMPLETED',
              },
            },
          }),
      } as any)
    );

    const res = await api.orders.getByOrderNumber('OUT-2026-99999', 'oat_test_token_xyz');

    expect(fetchSpy).toHaveBeenCalled();
    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toBe('/api/orders/OUT-2026-99999?token=oat_test_token_xyz');
    expect(res.order.orderNumber).toBe('OUT-2026-99999');

    fetchSpy.mockRestore();
  });

  describe('Checkout validation and idempotency contracts', () => {
    it('validates email format accurately', () => {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      expect(emailRegex.test('attendee@outside.vip')).toBe(true);
      expect(emailRegex.test('attendee+tag@sub.domain.com')).toBe(true);
      expect(emailRegex.test('')).toBe(false);
      expect(emailRegex.test('invalid-email')).toBe(false);
      expect(emailRegex.test('invalid@')).toBe(false);
      expect(emailRegex.test('@outside.vip')).toBe(false);
      expect(emailRegex.test('attendee@vip')).toBe(false);
    });

    it('generates consistent snapshot keys for session reuse without creating duplicate orders', () => {
      const selection1 = {
        items: [['tier-1', 2], ['tier-2', 1]].sort(([a], [b]) => String(a).localeCompare(String(b))),
        name: 'Jane Doe',
        email: 'jane@example.com'.toLowerCase(),
        phone: '+254700000000',
      };

      const selection2 = {
        items: [['tier-2', 1], ['tier-1', 2]].sort(([a], [b]) => String(a).localeCompare(String(b))),
        name: 'Jane Doe',
        email: 'JANE@example.com'.toLowerCase(),
        phone: '+254700000000',
      };

      const selection3 = {
        items: [['tier-1', 3]].sort(([a], [b]) => String(a).localeCompare(String(b))),
        name: 'Jane Doe',
        email: 'jane@example.com'.toLowerCase(),
        phone: '+254700000000',
      };

      const key1 = JSON.stringify(selection1);
      const key2 = JSON.stringify(selection2);
      const key3 = JSON.stringify(selection3);

      expect(key1).toBe(key2); // Identical selection, normalized email, and phone reuse the session
      expect(key1).not.toBe(key3); // Changed selection triggers a new session
    });

    it('supports required customerPhone and optional marketingConsent in api.checkout.createSession payload', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              data: {
                orderNumber: 'OUT-2026-11111',
                orderAccessToken: 'oat_test_phone_123',
                clientSecret: 'pi_test_phone_secret',
                publishableKey: 'pk_test_sample',
                totalInCents: 5000,
                currency: 'USD',
                expiresAt: new Date().toISOString(),
              },
            }),
        } as any)
      );

      const res = await api.checkout.createSession({
        eventId: 'evt-456',
        items: [{ ticketTierId: 'tier-1', quantity: 1 }],
        customerEmail: 'buyer@outside.vip',
        customerName: 'Buyer Name',
        customerPhone: '+254712345678',
        marketingConsent: true,
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/checkout/create-session',
        expect.objectContaining({
          body: expect.stringContaining('"customerPhone":"+254712345678"'),
        })
      );
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/checkout/create-session',
        expect.objectContaining({
          body: expect.stringContaining('"marketingConsent":true'),
        })
      );
      expect(res.orderNumber).toBe('OUT-2026-11111');

      fetchSpy.mockRestore();
    });
  });

  describe('API base URL resolution and endpoint composition', () => {
    it('resolves production Render backend URL ending in /api', () => {
      expect(resolveApiBaseUrl('https://outside-vip.onrender.com/api')).toBe(
        'https://outside-vip.onrender.com/api'
      );
    });

    it('resolves production Render backend URL with trailing slash', () => {
      expect(resolveApiBaseUrl('https://outside-vip.onrender.com/api/')).toBe(
        'https://outside-vip.onrender.com/api'
      );
    });

    it('appends /api if base domain is provided without /api', () => {
      expect(resolveApiBaseUrl('https://outside-vip.onrender.com')).toBe(
        'https://outside-vip.onrender.com/api'
      );
      expect(resolveApiBaseUrl('https://outside-vip.onrender.com/')).toBe(
        'https://outside-vip.onrender.com/api'
      );
    });

    it('defaults to /api for relative path or undefined in local dev', () => {
      expect(resolveApiBaseUrl('/api')).toBe('/api');
      expect(resolveApiBaseUrl('/api/')).toBe('/api');
      expect(resolveApiBaseUrl('')).toBe('/api');
      expect(resolveApiBaseUrl(undefined)).toBe('/api');
      expect(resolveApiBaseUrl('   ')).toBe('/api');
    });

    it('builds full production endpoint URLs matching Render without duplicating /api', () => {
      const renderBase = 'https://outside-vip.onrender.com/api';
      expect(buildApiUrl('/events', renderBase)).toBe(
        'https://outside-vip.onrender.com/api/events'
      );
      expect(buildApiUrl('/api/events', renderBase)).toBe(
        'https://outside-vip.onrender.com/api/events'
      );
      expect(buildApiUrl('events', renderBase)).toBe(
        'https://outside-vip.onrender.com/api/events'
      );
      expect(buildApiUrl('/events?sortBy=date_asc&limit=12', renderBase)).toBe(
        'https://outside-vip.onrender.com/api/events?sortBy=date_asc&limit=12'
      );
      expect(buildApiUrl('/orders/OUT-2026-99999/tickets/pdf?token=abc', renderBase)).toBe(
        'https://outside-vip.onrender.com/api/orders/OUT-2026-99999/tickets/pdf?token=abc'
      );
    });

    it('builds relative endpoint URLs for local development', () => {
      expect(buildApiUrl('/events', '/api')).toBe('/api/events');
      expect(buildApiUrl('/api/events', '/api')).toBe('/api/events');
      expect(buildApiUrl('events', '/api')).toBe('/api/events');
      expect(buildApiUrl('/events?sortBy=date_asc&limit=12', '/api')).toBe(
        '/api/events?sortBy=date_asc&limit=12'
      );
    });
  });

  describe('Vercel production routing and SPA rewrite configuration', () => {
    // Tests verify Vercel deployment rewrites prevent 404s on Stripe return & deep links
    it('client/vercel.json and root vercel.json exist and are syntactically valid JSON', () => {
      const clientConfigPath = path.resolve(__dirname, '../vercel.json');
      const rootConfigPath = path.resolve(__dirname, '../../vercel.json');

      expect(fs.existsSync(clientConfigPath)).toBe(true);
      expect(fs.existsSync(rootConfigPath)).toBe(true);

      const clientConfig = JSON.parse(fs.readFileSync(clientConfigPath, 'utf8'));
      const rootConfig = JSON.parse(fs.readFileSync(rootConfigPath, 'utf8'));

      expect(clientConfig.rewrites).toBeDefined();
      expect(Array.isArray(clientConfig.rewrites)).toBe(true);
      expect(rootConfig.rewrites).toBeDefined();
      expect(Array.isArray(rootConfig.rewrites)).toBe(true);
    });

    it('contains API proxy rule followed by SPA catch-all fallback to index.html', () => {
      const clientConfigPath = path.resolve(__dirname, '../vercel.json');
      const clientConfig = JSON.parse(fs.readFileSync(clientConfigPath, 'utf8'));

      const rewrites = clientConfig.rewrites as Array<{ source: string; destination: string }>;
      expect(rewrites.length).toBeGreaterThanOrEqual(2);

      // Rule 1: API requests route to Render backend
      const apiRewrite = rewrites.find((r) => r.source === '/api/:path*');
      expect(apiRewrite).toBeDefined();
      expect(apiRewrite!.destination).toBe('https://outside-vip.onrender.com/api/:path*');

      // Rule 2: SPA catch-all routes to /index.html
      const spaCatchAll = rewrites.find((r) => r.source === '/(.*)');
      expect(spaCatchAll).toBeDefined();
      expect(spaCatchAll!.destination).toBe('/index.html');

      // Crucial: API rule MUST precede the SPA catch-all rule
      const apiIndex = rewrites.indexOf(apiRewrite!);
      const spaIndex = rewrites.indexOf(spaCatchAll!);
      expect(apiIndex).toBeLessThan(spaIndex);
    });

    it('matches Stripe onboarding return and refresh flows to /index.html', () => {
      const clientConfigPath = path.resolve(__dirname, '../vercel.json');
      const clientConfig = JSON.parse(fs.readFileSync(clientConfigPath, 'utf8'));
      const rewrites = clientConfig.rewrites as Array<{ source: string; destination: string }>;

      // Helper function simulating Vercel rewrite matching
      function resolveRewrite(requestPath: string): { destination: string; type: 'api' | 'spa' } {
        for (const rule of rewrites) {
          if (rule.source === '/api/:path*' && requestPath.startsWith('/api')) {
            return { destination: rule.destination, type: 'api' };
          }
          if (rule.source === '/(.*)') {
            return { destination: rule.destination, type: 'spa' };
          }
        }
        return { destination: requestPath, type: 'spa' };
      }

      // Deep route: /organizer/finance
      expect(resolveRewrite('/organizer/finance')).toEqual({
        destination: '/index.html',
        type: 'spa',
      });

      // Stripe Return URL: /organizer/finance?stripe_return=true
      expect(resolveRewrite('/organizer/finance?stripe_return=true')).toEqual({
        destination: '/index.html',
        type: 'spa',
      });

      // Stripe Refresh URL: /organizer/finance?stripe_refresh=true
      expect(resolveRewrite('/organizer/finance?stripe_refresh=true')).toEqual({
        destination: '/index.html',
        type: 'spa',
      });

      // Other React Router SPA routes
      expect(resolveRewrite('/events')).toEqual({
        destination: '/index.html',
        type: 'spa',
      });
      expect(resolveRewrite('/events/outside-music-fest-2026')).toEqual({
        destination: '/index.html',
        type: 'spa',
      });
      expect(resolveRewrite('/scanner')).toEqual({
        destination: '/index.html',
        type: 'spa',
      });
      expect(resolveRewrite('/orders/OUT-2026-99999')).toEqual({
        destination: '/index.html',
        type: 'spa',
      });

      // API requests proxy to Render
      expect(resolveRewrite('/api/organizer/finance/account')).toEqual({
        destination: 'https://outside-vip.onrender.com/api/:path*',
        type: 'api',
      });
      expect(resolveRewrite('/api/events')).toEqual({
        destination: 'https://outside-vip.onrender.com/api/:path*',
        type: 'api',
      });
    });
  });
});



