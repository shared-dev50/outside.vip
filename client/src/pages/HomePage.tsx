import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { EventCategory } from '../types';
import { 
  Calendar, 
  MapPin, 
  Search, 
  Sparkles, 
  Ticket, 
  SlidersHorizontal,
  Flame,
  ArrowRight
} from 'lucide-react';

const CATEGORIES: { label: string; value?: EventCategory }[] = [
  { label: 'All Experiences' },
  { label: 'Festivals', value: 'FESTIVAL' },
  { label: 'Nightlife & Raves', value: 'NIGHTLIFE' },
  { label: 'Live Music', value: 'MUSIC' },
  { label: 'Tech & Summits', value: 'TECH' },
  { label: 'Food & Drink', value: 'FOOD_DRINK' },
];

export const HomePage: React.FC = () => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<EventCategory | undefined>(undefined);
  const [selectedCity, setSelectedCity] = useState<string>('');
  const [timeFilter, setTimeFilter] = useState<string>('upcoming');

  // Fetch public events
  const { data, isLoading, error } = useQuery({
    queryKey: ['events', searchTerm, selectedCategory, selectedCity, timeFilter],
    queryFn: () =>
      api.events.list({
        search: searchTerm || undefined,
        category: selectedCategory,
        city: selectedCity || undefined,
        timeFilter,
      }),
  });

  // Fetch featured events for Hero spotlight
  const { data: featuredData } = useQuery({
    queryKey: ['featured-events'],
    queryFn: () => api.events.featured(),
  });

  const featuredEvent = featuredData?.events?.[0];

  const formatEventDate = (dateString: string) => {
    const d = new Date(dateString);
    return d.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const formatPrice = (cents?: number, currency = 'USD') => {
    if (cents === undefined || cents === 0) return 'Free';
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(cents / 100);
  };

  return (
    <div className="space-y-16 pb-20">
      {/* Editorial Hero Spotlight */}
      {featuredEvent && (
        <section className="relative rounded-3xl overflow-hidden border border-surface-800 shadow-2xl mx-4 sm:mx-6 lg:mx-8 mt-6">
          <div className="absolute inset-0 z-0">
            <img
              src={featuredEvent.coverImageUrl}
              alt={featuredEvent.title}
              className="w-full h-full object-cover object-center filter brightness-[0.45] scale-105 transform hover:scale-100 transition-transform duration-1000"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-surface-950 via-surface-950/60 to-transparent"></div>
            <div className="absolute inset-0 bg-gradient-to-r from-surface-950 via-surface-950/40 to-transparent"></div>
          </div>

          <div className="relative z-10 p-8 sm:p-14 lg:p-20 max-w-4xl space-y-6">
            <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-brand-neon/10 border border-brand-neon/30 text-brand-neon text-xs font-mono uppercase tracking-widest font-bold">
              <Flame className="w-3.5 h-3.5" />
              Featured Headliner
            </div>

            <h1 className="font-display font-black text-3xl sm:text-5xl lg:text-6xl text-white tracking-tight leading-[1.08]">
              {featuredEvent.title}
            </h1>

            {featuredEvent.tagline && (
              <p className="text-lg sm:text-xl text-slate-300 font-light leading-relaxed max-w-2xl">
                {featuredEvent.tagline}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-6 text-sm text-slate-300 font-medium">
              <div className="flex items-center gap-2">
                <Calendar className="w-4 h-4 text-brand-neon" />
                <span>{formatEventDate(featuredEvent.startAt)}</span>
              </div>
              <div className="flex items-center gap-2">
                <MapPin className="w-4 h-4 text-brand-neon" />
                <span>{featuredEvent.venueName}, {featuredEvent.city}</span>
              </div>
              <div className="flex items-center gap-2">
                <Ticket className="w-4 h-4 text-brand-neon" />
                <span>Tickets from <strong className="text-white">{formatPrice(featuredEvent.minPriceInCents, featuredEvent.currency)}</strong></span>
              </div>
            </div>

            <div className="pt-4 flex flex-wrap items-center gap-4">
              <Link
                to={`/events/${featuredEvent.slug}`}
                className="inline-flex items-center gap-3 px-8 py-4 rounded-full bg-brand-neon hover:bg-brand-neon-hover text-black font-display font-bold text-base transition-all shadow-neon-md hover:shadow-neon-lg hover:scale-[1.02]"
              >
                Get Tickets
                <ArrowRight className="w-5 h-5" />
              </Link>
              <Link
                to={`/events/${featuredEvent.slug}`}
                className="inline-flex items-center gap-2 px-6 py-4 rounded-full bg-surface-900/80 hover:bg-surface-800 text-white font-medium text-sm border border-surface-700 transition-all"
              >
                View Experience Details
              </Link>
            </div>
          </div>
        </section>
      )}

      {/* Discovery & Search Section */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-8">
        <div className="flex flex-col md:flex-row items-start md:items-end justify-between gap-4">
          <div>
            <div className="text-xs uppercase font-mono tracking-widest text-brand-neon font-semibold mb-2 flex items-center gap-2">
              <Sparkles className="w-3.5 h-3.5" />
              Curated Calendar
            </div>
            <h2 className="text-3xl sm:text-4xl font-display font-bold text-white tracking-tight">
              Upcoming Experiences
            </h2>
          </div>

          {/* Timeframe filters */}
          <div className="flex items-center bg-surface-900 border border-surface-800 p-1 rounded-full text-xs font-medium">
            {(['upcoming', 'this_weekend', 'this_month', 'all'] as const).map((filter) => (
              <button
                key={filter}
                onClick={() => setTimeFilter(filter)}
                className={`px-4 py-1.5 rounded-full capitalize transition-all ${
                  timeFilter === filter
                    ? 'bg-brand-neon text-black font-semibold shadow-sm'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                {filter.replace('_', ' ')}
              </button>
            ))}
          </div>
        </div>

        {/* Filter controls bar */}
        <div className="flex flex-col sm:flex-row items-center gap-4">
          {/* Search box */}
          <div className="relative flex-1 w-full">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              placeholder="Search experiences, artists, venues, or cities..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-11 pr-4 py-3.5 rounded-2xl bg-surface-900 border border-surface-800 text-white placeholder-slate-500 focus:outline-none focus:border-brand-neon transition-colors text-sm"
            />
          </div>

          {/* City selector */}
          <div className="w-full sm:w-56">
            <select
              value={selectedCity}
              onChange={(e) => setSelectedCity(e.target.value)}
              className="w-full px-4 py-3.5 rounded-2xl bg-surface-900 border border-surface-800 text-slate-200 text-sm focus:outline-none focus:border-brand-neon cursor-pointer"
            >
              <option value="">All Destinations</option>
              <option value="Kilifi">Kilifi (Coast)</option>
              <option value="Nairobi">Nairobi</option>
            </select>
          </div>
        </div>

        {/* Category Pills */}
        <div className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-none">
          {CATEGORIES.map((cat) => {
            const isSelected = selectedCategory === cat.value;
            return (
              <button
                key={cat.label}
                onClick={() => setSelectedCategory(cat.value)}
                className={`whitespace-nowrap px-5 py-2.5 rounded-full text-xs font-semibold transition-all ${
                  isSelected
                    ? 'bg-white text-black font-bold shadow-md'
                    : 'bg-surface-900 hover:bg-surface-850 text-slate-300 border border-surface-800'
                }`}
              >
                {cat.label}
              </button>
            );
          })}
        </div>

        {/* Loading state */}
        {isLoading && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-8 pt-4">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div
                key={i}
                className="h-96 rounded-3xl bg-surface-900 border border-surface-800 animate-pulse"
              />
            ))}
          </div>
        )}

        {/* Error state */}
        {error && (
          <div className="p-8 rounded-3xl bg-rose-500/10 border border-rose-500/20 text-center space-y-3">
            <p className="text-rose-400 font-medium">Failed to load experiences</p>
            <p className="text-xs text-slate-400">{(error as Error).message}</p>
          </div>
        )}

        {/* Event Cards Grid */}
        {data && (
          <div>
            {data.events.length === 0 ? (
              <div className="p-16 rounded-3xl glass-panel text-center space-y-4 my-8">
                <SlidersHorizontal className="w-10 h-10 text-slate-500 mx-auto" />
                <h3 className="text-xl font-bold text-white">No experiences found</h3>
                <p className="text-slate-400 text-sm max-w-sm mx-auto">
                  Try adjusting your search criteria, category filters, or select "All Experiences".
                </p>
                <button
                  onClick={() => {
                    setSearchTerm('');
                    setSelectedCategory(undefined);
                    setSelectedCity('');
                    setTimeFilter('upcoming');
                  }}
                  className="px-6 py-2.5 rounded-full bg-surface-800 hover:bg-surface-700 text-brand-neon text-xs font-mono font-bold uppercase transition-colors"
                >
                  Clear All Filters
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-8">
                {data.events.map((event) => (
                  <Link
                    key={event.id}
                    to={`/events/${event.slug}`}
                    className="group glass-panel rounded-3xl overflow-hidden glass-panel-hover flex flex-col"
                  >
                    {/* Event image */}
                    <div className="relative aspect-[16/10] overflow-hidden">
                      <img
                        src={event.coverImageUrl}
                        alt={event.title}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-surface-950 via-transparent to-transparent opacity-80" />

                      {/* Category Tag */}
                      <div className="absolute top-4 left-4">
                        <span className="px-3 py-1 rounded-full bg-black/60 backdrop-blur-md border border-white/10 text-white text-[11px] font-mono uppercase tracking-wider font-semibold">
                          {event.category}
                        </span>
                      </div>

                      {/* City badge */}
                      <div className="absolute top-4 right-4">
                        <span className="px-3 py-1 rounded-full bg-brand-neon text-black text-[11px] font-mono uppercase tracking-wider font-bold shadow-neon-sm">
                          {event.city}
                        </span>
                      </div>

                      {/* Status indicator */}
                      {event.isSoldOut && (
                        <div className="absolute bottom-4 left-4">
                          <span className="px-3 py-1 rounded-full bg-rose-500/90 text-white text-xs font-bold uppercase tracking-wider">
                            Sold Out
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Event content */}
                    <div className="p-6 flex-1 flex flex-col justify-between space-y-4">
                      <div className="space-y-2">
                        <div className="text-xs font-mono text-brand-neon uppercase font-semibold flex items-center gap-1.5">
                          <Calendar className="w-3.5 h-3.5" />
                          {formatEventDate(event.startAt)}
                        </div>

                        <h3 className="font-display font-bold text-xl text-white group-hover:text-brand-neon transition-colors line-clamp-2">
                          {event.title}
                        </h3>

                        <p className="text-slate-400 text-xs line-clamp-2 leading-relaxed">
                          {event.tagline || event.description}
                        </p>
                      </div>

                      <div className="pt-4 border-t border-surface-800/80 flex items-center justify-between text-xs text-slate-400">
                        <div className="flex items-center gap-1.5 truncate max-w-[60%]">
                          <MapPin className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                          <span className="truncate">{event.venueName}</span>
                        </div>

                        <div className="text-right">
                          <span className="text-[10px] uppercase text-slate-500 block font-mono">
                            Admission
                          </span>
                          <span className="font-display font-bold text-sm text-white">
                            {event.isSoldOut ? 'Sold Out' : `From ${formatPrice(event.minPriceInCents, event.currency)}`}
                          </span>
                        </div>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
};
