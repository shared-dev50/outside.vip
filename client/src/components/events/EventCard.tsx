import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { Event } from '../../types';

interface EventCardProps {
  event: Event;
  aspectRatio?: '16/10' | '4/3' | '3/2';
  priority?: boolean;
}

export const EventCard: React.FC<EventCardProps> = ({
  event,
  aspectRatio = '16/10',
}) => {
  // Calendar date stamp parts matching screenshot reference: e.g. "SUN", "18", "APR 24"
  const getBadgeDate = (dateString: string) => {
    const d = new Date(dateString);
    const weekday = d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
    const day = d.getDate();
    const month = d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase();
    const year = d.getFullYear().toString().slice(-2);
    return { weekday, day, monthYear: `${month} ${year}` };
  };

  const formatPrice = (cents?: number, currency = 'USD') => {
    if (cents === undefined || cents === 0) return 'Free';
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(cents / 100);
  };

  const { weekday, day, monthYear } = getBadgeDate(event.startAt);
  const venueShort = event.venueName ? event.venueName.split(',')[0].trim() : event.city;

  const aspectClass =
    aspectRatio === '4/3'
      ? 'aspect-[4/3]'
      : aspectRatio === '3/2'
      ? 'aspect-[3/2]'
      : 'aspect-[16/10]';

  return (
    <Link
      to={`/events/${event.slug}`}
      className="group flex flex-col justify-between text-left transition-all duration-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-stone-900 rounded-lg p-2.5 sm:p-3 bg-white border border-stone-200/80 hover:border-stone-400 hover:shadow-md"
    >
      <div className="space-y-3.5">
        {/* 1. Landscape Cover Artwork Frame (Matching Reference) */}
        <div
          className={`relative ${aspectClass} w-full overflow-hidden rounded-md bg-stone-900`}
        >
          <img
            src={event.coverImageUrl}
            alt={event.title}
            loading="lazy"
            className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-500 ease-out"
            onError={(e) => {
              e.currentTarget.src =
                'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=1200&q=80';
            }}
          />

          {/* Status Indicator */}
          {event.isSoldOut && (
            <div className="absolute top-2.5 right-2.5 z-10">
              <span className="px-2 py-0.5 rounded bg-black/90 text-white font-mono text-[10px] font-bold uppercase tracking-wider backdrop-blur-xs">
                Sold Out
              </span>
            </div>
          )}

          {/* Subtle inner border */}
          <div className="absolute inset-0 pointer-events-none border border-black/10 rounded-md" />
        </div>

        {/* 2. Calendar Date Stamp Badge (Matching Reference) */}
        <div>
          <div className="inline-flex flex-col items-center justify-center border border-stone-300/90 rounded-sm overflow-hidden bg-white shadow-xs w-11 text-center select-none">
            {/* Weekday Header */}
            <div className="w-full bg-[#EFECE5] text-[#5C5346] font-mono text-[9px] font-bold uppercase py-0.5 border-b border-stone-200/90 tracking-wider">
              {weekday}
            </div>
            {/* Day Number */}
            <div className="font-display font-black text-stone-900 text-base leading-none py-1">
              {day}
            </div>
            {/* Month & Year */}
            <div className="w-full font-mono text-[8px] font-bold text-stone-500 uppercase tracking-tight pb-1">
              {monthYear}
            </div>
          </div>
        </div>

        {/* 3. Bold Event Title & Subtitle */}
        <div className="space-y-1">
          <h2 className="font-display font-black text-lg sm:text-xl text-stone-900 uppercase tracking-tight leading-tight line-clamp-2 group-hover:text-stone-700 transition-colors">
            {event.title}
          </h2>
          <p className="text-xs text-stone-500 font-sans line-clamp-1">
            {event.tagline || event.description || `Presented by Sol Collective`}
          </p>
        </div>

        {/* 4. City & Venue Pills (Matching Reference) */}
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          <span className="inline-block px-2.5 py-0.5 rounded-full border border-stone-300 bg-[#FAF8F5] text-stone-700 text-[10px] font-mono uppercase font-semibold">
            {event.city}
          </span>
          <span className="inline-block px-2.5 py-0.5 rounded-full border border-stone-300 bg-[#FAF8F5] text-stone-700 text-[10px] font-mono uppercase font-semibold truncate max-w-[150px]">
            {venueShort}
          </span>
        </div>
      </div>

      {/* 5. Footer: "Find Tickets →" Button & Admission Price */}
      <div className="pt-4 mt-3 border-t border-stone-200/80 flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-stone-300 bg-white group-hover:bg-stone-900 group-hover:text-white group-hover:border-stone-900 text-stone-900 text-xs font-mono uppercase font-bold tracking-wider transition-all duration-200 shadow-2xs">
          <span>Find Tickets</span>
          <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
        </span>

        <span className="text-xs font-mono font-bold text-stone-600">
          {event.isSoldOut ? 'SOLD OUT' : formatPrice(event.minPriceInCents, event.currency)}
        </span>
      </div>
    </Link>
  );
};

