import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { PosterCard } from './components/home/PosterCard';
import { Event } from './types';

describe('Homepage PosterCard UI & Event Title Component', () => {
  const mockBaseEvent: Event = {
    id: 'evt-home-001',
    slug: 'savannah-cinema-vinyl-edition',
    organizerId: 'org-001',
    organizer: {
      id: 'org-001',
      name: 'Sol Collective',
      avatarUrl: null,
    },
    title: 'Savannah Cinema: African Classic Film & Vinyl',
    tagline: 'Under the Stars in Nairobi',
    description: 'An open air acoustic cinema showcase.',
    category: 'ARTS_CULTURE',
    status: 'PUBLISHED',
    coverImageUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819',
    venueName: 'Baobab Forest Park, Karen Road',
    venueAddress: '123 Karen Road',
    city: 'Nairobi',
    country: 'Kenya',
    startAt: '2026-11-20T18:00:00.000Z',
    endAt: '2026-11-20T23:00:00.000Z',
    timezone: 'Africa/Nairobi',
    isSoldOut: false,
    isFeatured: true,
    minPriceInCents: 2500,
    currency: 'USD',
    ticketTiers: [],
  };

  it('1. Renders the event title prominently directly below the event image', () => {
    const html = renderToString(
      <MemoryRouter>
        <PosterCard event={mockBaseEvent} />
      </MemoryRouter>
    );

    // Event title must be present and rendered
    expect(html).toContain('Savannah Cinema: African Classic Film &amp; Vinyl');
    expect(html).toContain('title="Savannah Cinema: African Classic Film &amp; Vinyl"');

    // Title element has prominent typography
    expect(html).toContain('font-display');
    expect(html).toContain('font-black');
    expect(html).toContain('uppercase');

    // Appears before the date in DOM order (directly below image)
    const titleIndex = html.indexOf('Savannah Cinema: African Classic Film &amp; Vinyl');
    const dateIndex = html.indexOf('20 NOVEMBER || 2026');
    expect(titleIndex).toBeGreaterThan(-1);
    expect(dateIndex).toBeGreaterThan(-1);
    expect(titleIndex).toBeLessThan(dateIndex);
  });

  it('2. Gracefully handles very long event titles with line-clamp-2 and break-words', () => {
    const longTitle =
      'Outside Festival 2026: The International Electronic Music and Contemporary Visual Arts Gathering of East Africa';
    const longTitleEvent: Event = {
      ...mockBaseEvent,
      title: longTitle,
    };

    const html = renderToString(
      <MemoryRouter>
        <PosterCard event={longTitleEvent} />
      </MemoryRouter>
    );

    expect(html).toContain(longTitle);
    expect(html).toContain('line-clamp-2');
    expect(html).toContain('break-words');
  });

  it('3. Renders consistently for elevated/featured cards without breaking layout or elevation mark', () => {
    const html = renderToString(
      <MemoryRouter>
        <PosterCard event={mockBaseEvent} isElevated={true} />
      </MemoryRouter>
    );

    expect(html).toContain('Savannah Cinema: African Classic Film &amp; Vinyl');
    // Elevated sparkle element
    expect(html).toContain('✦');
    // Elevation translation class
    expect(html).toContain('-translate-y-3');
  });

  it('4. Correctly displays sold out badge and label', () => {
    const soldOutEvent: Event = {
      ...mockBaseEvent,
      isSoldOut: true,
    };

    const html = renderToString(
      <MemoryRouter>
        <PosterCard event={soldOutEvent} />
      </MemoryRouter>
    );

    expect(html).toContain('Sold Out');
    expect(html).toContain('SOLD OUT');
  });

  it('5. Falls back to city when venueName is empty or null', () => {
    const noVenueEvent: Event = {
      ...mockBaseEvent,
      venueName: '',
      city: 'Nairobi',
    };

    const html = renderToString(
      <MemoryRouter>
        <PosterCard event={noVenueEvent} />
      </MemoryRouter>
    );

    expect(html).toContain('NAIROBI');
  });
});
