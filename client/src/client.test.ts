import { describe, it, expect, vi } from 'vitest';
import { api } from './lib/api';

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
    expect(typeof api.auth.me).toBe('function');
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
              checkoutUrl: 'https://checkout.stripe.com/pay/cs_test_123',
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
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/checkout/create-session',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"eventId":"evt-123"'),
      })
    );
    expect(res.checkoutUrl).toContain('checkout.stripe.com');
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
});

