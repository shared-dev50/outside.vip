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
});
