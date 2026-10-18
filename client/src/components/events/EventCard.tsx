import React from 'react';
import { Link } from 'react-router-dom';
import { Event } from '../../types';

interface EventCardProps {
  event: Event;
  aspectRatio?: '4/3' | '16/10' | '3/2';
  priority?: boolean;
}

export const EventCard: React.FC<EventCardProps> = ({
  event,
  aspectRatio = '4/3',
}) => {
  const formatEventDate = (dateString: string) => {
    const d = new Date(dateString);
    const weekday = d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
    const month = d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase();
    const day = d.getDate();
    return `${weekday}, ${month} ${day}`;
  };

  const formatPrice = (cents?: number, currency = 'USD') => {
    if (cents === undefined || cents === 0) return 'Free';
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(cents / 100);
  };

  const aspectClass =
    aspectRatio === '16/10'
      ? 'aspect-[16/10]'
      : aspectRatio === '3/2'
      ? 'aspect-[3/2]'
      : 'aspect-[4/3]';

  return (
    <Link
      to={`/events/${event.slug}`}
      className="group block bg-white text-left transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 rounded-md"
    >
      {/* 1. Poster Artwork Container */}
      <div
        className={`relative ${aspectClass} w-full overflow-hidden rounded-md bg-gray-100 mb-3`}
      >
        <img
          src={event.coverImageUrl}
          alt={event.title}
          loading="lazy"
          className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-300 ease-out"
          onError={(e) => {
            // Graceful fallback for broken image URLs
            const target = e.currentTarget;
            target.src =
              'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=1200&q=80';
          }}
        />

        {/* Sold Out badge */}
        {event.isSoldOut && (
          <div className="absolute top-2.5 right-2.5">
            <span className="px-2 py-0.5 rounded bg-black/85 text-white text-[10px] font-mono font-semibold uppercase tracking-wider backdrop-blur-sm">
              Sold out
            </span>
          </div>
        )}
      </div>

      {/* 2. Structured Information Hierarchy */}
      <div className="space-y-1">
        {/* Date */}
        <div className="text-[11px] font-mono uppercase tracking-wider text-gray-500 font-medium">
          {formatEventDate(event.startAt)}
        </div>

        {/* Title */}
        <h3 className="font-bold text-gray-900 text-base sm:text-[17px] leading-snug line-clamp-2 group-hover:text-gray-600 transition-colors">
          {event.title}
        </h3>

        {/* Venue and City */}
        <div className="text-xs text-gray-500 truncate">
          {event.venueName}, {event.city}
        </div>

        {/* Starting Price */}
        <div className="text-xs text-gray-900 font-medium pt-0.5">
          {event.isSoldOut
            ? 'Sold out'
            : `From ${formatPrice(event.minPriceInCents, event.currency)}`}
        </div>
      </div>
    </Link>
  );
};
