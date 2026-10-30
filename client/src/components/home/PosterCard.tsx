import React from 'react';
import { Link } from 'react-router-dom';
import { Event } from '../../types';

interface PosterCardProps {
  event: Event;
  isElevated?: boolean;
  onHover?: () => void;
  onLeave?: () => void;
  index?: number;
}

export const PosterCard: React.FC<PosterCardProps> = ({
  event,
  isElevated = false,
  onHover,
  onLeave,
  index = 0,
}) => {

  const formatPosterDate = (dateString: string) => {
    const d = new Date(dateString);
    const day = d.getDate().toString().padStart(2, '0');
    const month = d.toLocaleDateString('en-US', { month: 'long' }).toUpperCase();
    const year = d.getFullYear();
    return `${day} ${month} || ${year}`;
  };

  const formatPrice = (cents?: number, currency = 'USD') => {
    if (cents === undefined || cents === 0) return 'Free';
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(cents / 100);
  };

  const venueLabel = event.venueName ? event.venueName.split(',')[0].toUpperCase() : event.city.toUpperCase();

  return (
    <Link
      to={`/events/${event.slug}`}
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      className={`group block text-left transition-all duration-500 ease-out focus:outline-none select-none relative ${isElevated
          ? '-translate-y-3 sm:-translate-y-5 z-20'
          : 'translate-y-0 hover:-translate-y-2 z-10'
        }`}
      style={{
        animationDelay: `${index * 80}ms`,
      }}
    >
      <div
        className={`rounded-sm transition-all duration-500 ease-out p-2.5 sm:p-3 relative ${isElevated
            ? 'bg-[#EAE4D9] border border-[#DDD5C7] shadow-[0_25px_45px_-12px_rgba(40,30,20,0.22)]'
            : 'bg-transparent border border-transparent hover:bg-[#F2ECE1]/60 hover:border-[#E2DAD0]'
          }`}
      >
        <div className="relative aspect-[3/4] w-full overflow-hidden bg-stone-900 border border-stone-800/80 shadow-inner">
          <img
            src={event.coverImageUrl}
            alt={event.title}
            loading="lazy"
            className="w-full h-full object-cover group-hover:scale-[1.04] transition-transform duration-700 ease-out"
            onError={(e) => {
              e.currentTarget.src =
                'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=1200&q=80';
            }}
          />

          {event.isSoldOut && (
            <div className="absolute top-2.5 right-2.5 z-10">
              <span className="px-2 py-0.5 rounded bg-black/90 text-white font-mono text-[10px] font-bold uppercase tracking-wider">
                Sold Out
              </span>
            </div>
          )}

          <div className="absolute inset-0 pointer-events-none border border-black/10" />
        </div>

        <div className="pt-3 pb-3 sm:pb-3.5 space-y-1">
          <div className="font-display font-black text-xs sm:text-sm tracking-wider text-stone-900 uppercase">
            {formatPosterDate(event.startAt)}
          </div>

          <div className="flex items-center justify-between text-[11px] font-mono uppercase tracking-widest text-stone-600 font-bold truncate">
            <span className="truncate max-w-[170px]">{venueLabel}</span>
            <span className="text-[10px] text-stone-500 font-normal">
              {event.isSoldOut ? 'SOLD OUT' : formatPrice(event.minPriceInCents, event.currency)}
            </span>
          </div>
        </div>

        {isElevated && (
          <div className="absolute bottom-1.5 sm:bottom-2 right-2.5 sm:right-3 text-[#96846D] pointer-events-none select-none text-[11px] leading-none">
            ✦
          </div>
        )}
      </div>
    </Link>
  );
};
