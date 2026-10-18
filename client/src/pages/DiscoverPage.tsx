import React, { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { EventCategory } from '../types';
import { Search, X, SlidersHorizontal } from 'lucide-react';
import { EventCard } from '../components/events/EventCard';

const CATEGORIES: { label: string; value?: EventCategory }[] = [
  { label: 'All' },
  { label: 'Music', value: 'MUSIC' },
  { label: 'Nightlife', value: 'NIGHTLIFE' },
  { label: 'Festivals', value: 'FESTIVAL' },
  { label: 'Food & Drink', value: 'FOOD_DRINK' },
  { label: 'Tech & Summits', value: 'TECH' },
  { label: 'Arts & Culture', value: 'ARTS_CULTURE' },
];

export const DiscoverPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();

  // Read state from URL query parameters
  const initialSearch = searchParams.get('search') || '';
  const initialCategory = (searchParams.get('category') as EventCategory) || undefined;
  const initialCity = searchParams.get('city') || '';
  const initialTimeFilter = searchParams.get('time') || 'upcoming';
  const initialSortBy = searchParams.get('sort') || 'date_asc';

  const [searchTerm, setSearchTerm] = useState(initialSearch);
  const [selectedCategory, setSelectedCategory] = useState<EventCategory | undefined>(initialCategory);
  const [selectedCity, setSelectedCity] = useState<string>(initialCity);
  const [timeFilter, setTimeFilter] = useState<string>(initialTimeFilter);
  const [sortBy, setSortBy] = useState<string>(initialSortBy);

  // Sync state with URL params
  useEffect(() => {
    const params = new URLSearchParams();
    if (searchTerm.trim()) params.set('search', searchTerm.trim());
    if (selectedCategory) params.set('category', selectedCategory);
    if (selectedCity) params.set('city', selectedCity);
    if (timeFilter && timeFilter !== 'upcoming') params.set('time', timeFilter);
    if (sortBy && sortBy !== 'date_asc') params.set('sort', sortBy);
    setSearchParams(params, { replace: true });
  }, [searchTerm, selectedCategory, selectedCity, timeFilter, sortBy, setSearchParams]);

  // Query events from API
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['events-discover', searchTerm, selectedCategory, selectedCity, timeFilter, sortBy],
    queryFn: () =>
      api.events.list({
        search: searchTerm.trim() || undefined,
        category: selectedCategory,
        city: selectedCity || undefined,
        timeFilter,
        sortBy,
      }),
  });

  // Query distinct cities
  const { data: citiesData } = useQuery({
    queryKey: ['cities'],
    queryFn: () => api.events.cities(),
  });

  const clearFilters = () => {
    setSearchTerm('');
    setSelectedCategory(undefined);
    setSelectedCity('');
    setTimeFilter('upcoming');
    setSortBy('date_asc');
  };

  const hasActiveFilters = Boolean(
    searchTerm ||
      selectedCategory ||
      selectedCity ||
      (timeFilter && timeFilter !== 'upcoming') ||
      (sortBy && sortBy !== 'date_asc')
  );

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-10 space-y-8 bg-white min-h-[70vh]">
      {/* 1. Header & Search Row */}
      <div className="space-y-4 max-w-3xl">
        <div>
          <h1 className="text-3xl sm:text-4xl font-extrabold text-gray-900 tracking-tight">
            Discover events
          </h1>
          <p className="text-gray-500 text-sm sm:text-base mt-1">
            Browse upcoming concerts, festivals, warehouse sessions, and curated gatherings.
          </p>
        </div>

        {/* Straightforward Search Field */}
        <div className="relative max-w-md pt-1">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search events, venues, cities..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-9 py-2.5 rounded-lg bg-gray-50 border border-gray-200 text-gray-900 placeholder-gray-400 text-sm focus:outline-none focus:border-gray-900 focus:bg-white transition-colors"
          />
          {searchTerm && (
            <button
              onClick={() => setSearchTerm('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700"
              aria-label="Clear search"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* 2. Filter Bar */}
      <div className="space-y-4 border-b border-gray-100 pb-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          {/* Category Tabs */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none text-xs">
            {CATEGORIES.map((cat) => {
              const isSelected = selectedCategory === cat.value;
              return (
                <button
                  key={cat.label}
                  onClick={() => setSelectedCategory(cat.value)}
                  className={`whitespace-nowrap px-3 py-1.5 rounded-full font-medium transition-colors ${
                    isSelected
                      ? 'bg-gray-900 text-white'
                      : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
                  }`}
                >
                  {cat.label}
                </button>
              );
            })}
          </div>

          {/* Understated Dropdowns (City, Time, Sort) */}
          <div className="flex items-center gap-2 text-xs shrink-0">
            {/* City */}
            <select
              value={selectedCity}
              onChange={(e) => setSelectedCity(e.target.value)}
              className="px-2.5 py-1.5 rounded-md bg-white border border-gray-200 text-gray-700 text-xs focus:outline-none focus:border-gray-400 cursor-pointer"
            >
              <option value="">All Destinations</option>
              {citiesData?.cities?.map((city) => (
                <option key={city} value={city}>
                  {city}
                </option>
              ))}
            </select>

            {/* Timeframe */}
            <select
              value={timeFilter}
              onChange={(e) => setTimeFilter(e.target.value)}
              className="px-2.5 py-1.5 rounded-md bg-white border border-gray-200 text-gray-700 text-xs focus:outline-none focus:border-gray-400 cursor-pointer"
            >
              <option value="upcoming">Upcoming</option>
              <option value="this_weekend">This Weekend</option>
              <option value="this_month">This Month</option>
              <option value="all">All Dates</option>
            </select>

            {/* Sort */}
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="px-2.5 py-1.5 rounded-md bg-white border border-gray-200 text-gray-700 text-xs focus:outline-none focus:border-gray-400 cursor-pointer hidden sm:block"
            >
              <option value="date_asc">Soonest</option>
              <option value="date_desc">Latest</option>
              <option value="price_asc">Price: Low to High</option>
              <option value="price_desc">Price: High to Low</option>
            </select>
          </div>
        </div>

        {hasActiveFilters && (
          <div className="flex items-center justify-between text-xs text-gray-500 pt-1">
            <span>
              Showing filtered results{data ? ` (${data.events.length} event${data.events.length === 1 ? '' : 's'})` : ''}
            </span>
            <button
              onClick={clearFilters}
              className="text-gray-900 underline hover:text-black font-medium"
            >
              Clear all filters
            </button>
          </div>
        )}
      </div>

      {/* 3. Loading State */}
      {isLoading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6 sm:gap-8 pt-2">
          {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
            <div key={i} className="animate-pulse space-y-3">
              <div className="aspect-[4/3] bg-gray-100 rounded-md" />
              <div className="space-y-2">
                <div className="h-3 w-20 bg-gray-100 rounded" />
                <div className="h-4 w-3/4 bg-gray-100 rounded" />
                <div className="h-3 w-1/2 bg-gray-100 rounded" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 4. Error State */}
      {error && (
        <div className="p-8 rounded-lg bg-gray-50 border border-gray-200 text-center space-y-3 max-w-md mx-auto my-12">
          <p className="text-gray-900 font-semibold text-base">Unable to load events</p>
          <p className="text-xs text-gray-500">{(error as Error).message}</p>
          <button
            onClick={() => refetch()}
            className="px-4 py-2 rounded-md bg-gray-900 text-white text-xs font-semibold hover:bg-black transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* 5. Events Grid / Empty State */}
      {data && (
        <div>
          {data.events.length === 0 ? (
            <div className="p-12 rounded-lg bg-gray-50 border border-gray-200 text-center space-y-3 my-8 max-w-md mx-auto">
              <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center mx-auto text-gray-500 mb-2">
                <SlidersHorizontal className="w-5 h-5" />
              </div>
              <h3 className="text-base font-bold text-gray-900">No events found</h3>
              <p className="text-gray-500 text-xs">
                No events matched your current search or filter criteria.
              </p>
              <button
                onClick={clearFilters}
                className="mt-2 px-4 py-2 rounded-md bg-gray-900 text-white text-xs font-semibold hover:bg-black transition-colors"
              >
                Reset all filters
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6 sm:gap-8">
              {data.events.map((event) => (
                <EventCard key={event.id} event={event} aspectRatio="4/3" />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
