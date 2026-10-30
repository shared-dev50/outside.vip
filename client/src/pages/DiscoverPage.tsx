import React, { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { EventCategory } from '../types';
import { Search, X, ChevronDown, ChevronLeft, ChevronRight, SlidersHorizontal, RefreshCw } from 'lucide-react';
import { EventCard } from '../components/events/EventCard';

interface FilterTab {
  id: string;
  label: string;
  type: 'all' | 'time' | 'category';
  timeValue?: string;
  categoryValue?: EventCategory;
}

const FILTER_TABS: FilterTab[] = [
  { id: 'all', label: 'All', type: 'all' },
  { id: 'today', label: 'Today', type: 'time', timeValue: 'today' },
  { id: 'this_weekend', label: 'This Weekend', type: 'time', timeValue: 'this_weekend' },
  { id: 'this_month', label: 'This Month', type: 'time', timeValue: 'this_month' },
  { id: 'music', label: 'Concerts & Music', type: 'category', categoryValue: 'MUSIC' },
  { id: 'festivals', label: 'Festivals', type: 'category', categoryValue: 'FESTIVAL' },
  { id: 'nightlife', label: 'Nightlife', type: 'category', categoryValue: 'NIGHTLIFE' },
  { id: 'food_drink', label: 'Food & Drink', type: 'category', categoryValue: 'FOOD_DRINK' },
  { id: 'arts_culture', label: 'Arts & Culture', type: 'category', categoryValue: 'ARTS_CULTURE' },
  { id: 'tech', label: 'Tech & Summits', type: 'category', categoryValue: 'TECH' },
];

export const DiscoverPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();

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
  const [currentPage, setCurrentPage] = useState<number>(0);

  const CARDS_PER_PAGE = 8;

  useEffect(() => {
    const params = new URLSearchParams();
    if (searchTerm.trim()) params.set('search', searchTerm.trim());
    if (selectedCategory) params.set('category', selectedCategory);
    if (selectedCity) params.set('city', selectedCity);
    if (timeFilter && timeFilter !== 'upcoming') params.set('time', timeFilter);
    if (sortBy && sortBy !== 'date_asc') params.set('sort', sortBy);
    setSearchParams(params, { replace: true });
    setCurrentPage(0);
  }, [searchTerm, selectedCategory, selectedCity, timeFilter, sortBy, setSearchParams]);

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
    setCurrentPage(0);
  };

  const hasActiveFilters = Boolean(
    searchTerm ||
      selectedCategory ||
      selectedCity ||
      (timeFilter && timeFilter !== 'upcoming') ||
      (sortBy && sortBy !== 'date_asc')
  );

  const getHeadlinePrefix = () => {
    if (selectedCategory === 'MUSIC') return 'BROWSING CONCERTS IN';
    if (selectedCategory === 'FESTIVAL') return 'BROWSING FESTIVALS IN';
    if (selectedCategory === 'NIGHTLIFE') return 'BROWSING NIGHTLIFE IN';
    if (selectedCategory === 'FOOD_DRINK') return 'BROWSING FOOD & DRINK IN';
    if (selectedCategory === 'ARTS_CULTURE') return 'BROWSING ARTS & CULTURE IN';
    if (selectedCategory === 'TECH') return 'BROWSING TECH & SUMMITS IN';
    return 'BROWSING EVENTS IN';
  };

  const allEvents = data?.events || [];
  const totalPages = Math.ceil(Math.max(1, allEvents.length) / CARDS_PER_PAGE);
  const pagedEvents = allEvents.slice(
    currentPage * CARDS_PER_PAGE,
    (currentPage + 1) * CARDS_PER_PAGE
  );

  const getActiveTabId = () => {
    if (selectedCategory) {
      const match = FILTER_TABS.find((t) => t.categoryValue === selectedCategory);
      if (match) return match.id;
    }
    if (timeFilter && timeFilter !== 'upcoming' && timeFilter !== 'all') {
      const match = FILTER_TABS.find((t) => t.timeValue === timeFilter);
      if (match) return match.id;
    }
    return 'all';
  };

  const activeTabId = getActiveTabId();

  const handleTabClick = (tab: FilterTab) => {
    if (tab.type === 'all') {
      setSelectedCategory(undefined);
      setTimeFilter('all');
    } else if (tab.type === 'time') {
      setSelectedCategory(undefined);
      setTimeFilter(tab.timeValue || 'all');
    } else if (tab.type === 'category') {
      setSelectedCategory(tab.categoryValue);
      setTimeFilter('all');
    }
  };

  return (
    <div className="min-h-screen bg-[#FAF8F5] text-stone-900 pb-20 selection:bg-stone-900 selection:text-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-8 sm:pt-12 space-y-7">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 pb-2">
          <div className="flex flex-wrap items-center gap-3 sm:gap-4">
            <h1 className="font-display font-black text-3xl sm:text-5xl lg:text-6xl uppercase tracking-tight text-stone-900 leading-none">
              {getHeadlinePrefix()}
            </h1>

            <div className="relative inline-block">
              <select
                value={selectedCity}
                onChange={(e) => setSelectedCity(e.target.value)}
                className="appearance-none font-sans text-sm sm:text-base font-semibold text-stone-900 bg-white border border-stone-300 rounded-lg pl-4 pr-10 py-2 sm:py-2.5 shadow-2xs hover:border-stone-900 focus:outline-none focus:border-stone-900 transition-colors cursor-pointer"
                aria-label="Filter events by city"
              >
                <option value="">All Destinations</option>
                {citiesData?.cities?.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <ChevronDown className="absolute right-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-500 pointer-events-none" />
            </div>
          </div>

          <div className="flex items-center gap-3 w-full lg:w-auto">
            <div className="relative flex-1 lg:w-64">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400" />
              <input
                type="text"
                placeholder="Search events, venues..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-9 pr-8 py-2 rounded-lg bg-white border border-stone-300 text-stone-900 placeholder-stone-400 text-xs font-mono focus:outline-none focus:border-stone-900 transition-colors shadow-2xs"
              />
              {searchTerm && (
                <button
                  onClick={() => setSearchTerm('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-700"
                  aria-label="Clear search input"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="px-3 py-2 rounded-lg bg-white border border-stone-300 text-stone-800 text-xs font-mono focus:outline-none focus:border-stone-900 cursor-pointer shadow-2xs shrink-0"
              aria-label="Sort events"
            >
              <option value="date_asc">Soonest</option>
              <option value="date_desc">Latest</option>
              <option value="price_asc">Price: Low to High</option>
              <option value="price_desc">Price: High to Low</option>
            </select>
          </div>
        </div>

        <div className="border-b border-stone-200/90">
          <div className="flex items-center gap-6 sm:gap-8 overflow-x-auto scrollbar-none pb-0 text-sm">
            {FILTER_TABS.map((tab) => {
              const isActive = activeTabId === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => handleTabClick(tab)}
                  className={`whitespace-nowrap pb-3.5 transition-all relative font-sans text-xs sm:text-sm ${
                    isActive
                      ? 'text-stone-900 font-bold'
                      : 'text-stone-500 hover:text-stone-900 font-medium'
                  }`}
                >
                  {tab.label}
                  {isActive && (
                    <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-stone-900 rounded-full" />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {hasActiveFilters && (
          <div className="flex items-center justify-between text-xs font-mono text-stone-600 pt-1">
            <span>
              Showing filtered results{data ? ` (${allEvents.length} experience${allEvents.length === 1 ? '' : 's'})` : ''}
            </span>
            <button
              onClick={clearFilters}
              className="text-stone-900 underline hover:text-black font-bold uppercase tracking-wider text-[11px]"
            >
              Reset Filters
            </button>
          </div>
        )}

        {isLoading && (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6 pt-2">
            {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
              <div key={i} className="animate-pulse space-y-3 bg-white p-3 rounded-lg border border-stone-200">
                <div className="aspect-[16/10] bg-stone-200 rounded-md" />
                <div className="w-11 h-12 bg-stone-200 rounded-sm" />
                <div className="h-4 w-3/4 bg-stone-200 rounded" />
                <div className="h-3 w-1/2 bg-stone-200 rounded" />
                <div className="h-8 w-full bg-stone-200 rounded mt-2" />
              </div>
            ))}
          </div>
        )}

        {error && (
          <div className="p-8 rounded-lg bg-white border border-stone-300 text-center space-y-3 max-w-md mx-auto my-12 shadow-xs">
            <p className="text-stone-900 font-bold text-sm">Unable to load event catalogue</p>
            <p className="text-xs text-stone-500">{(error as Error).message}</p>
            <button
              onClick={() => refetch()}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-stone-900 text-white text-xs font-mono uppercase tracking-wider font-semibold hover:bg-black transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Retry</span>
            </button>
          </div>
        )}

        {!isLoading && !error && (
          <div>
            {allEvents.length === 0 ? (
              <div className="p-12 rounded-lg bg-white border border-stone-200 text-center space-y-3 my-8 max-w-md mx-auto shadow-xs">
                <div className="w-10 h-10 rounded-full bg-stone-100 flex items-center justify-center mx-auto text-stone-500 mb-2">
                  <SlidersHorizontal className="w-5 h-5" />
                </div>
                <h3 className="text-base font-bold text-stone-900">No events found</h3>
                <p className="text-stone-500 text-xs">
                  No experiences matched your current destination or filter parameters.
                </p>
                <button
                  onClick={clearFilters}
                  className="mt-2 px-4 py-2 rounded-md bg-stone-900 text-white text-xs font-mono uppercase tracking-wider font-semibold hover:bg-black transition-colors"
                >
                  Reset all filters
                </button>
              </div>
            ) : (
              <div className="space-y-8">
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-5 sm:gap-6">
                  {pagedEvents.map((event) => (
                    <EventCard key={event.id} event={event} aspectRatio="16/10" />
                  ))}
                </div>

                <div className="flex items-center justify-between pt-6 border-t border-stone-200/90">
                  <div className="flex items-center gap-2">
                    {Array.from({ length: totalPages }).map((_, idx) => (
                      <button
                        key={idx}
                        onClick={() => setCurrentPage(idx)}
                        className={`rounded-full transition-all ${
                          currentPage === idx
                            ? 'w-2.5 h-2.5 bg-stone-900'
                            : 'w-2 h-2 bg-stone-300 hover:bg-stone-500'
                        }`}
                        aria-label={`Go to page ${idx + 1}`}
                      />
                    ))}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setCurrentPage((p) => Math.max(0, p - 1))}
                      disabled={currentPage === 0}
                      className="w-9 h-9 rounded-full border border-stone-300 flex items-center justify-center text-stone-700 hover:border-stone-900 hover:text-black disabled:opacity-30 disabled:pointer-events-none transition-colors shadow-2xs"
                      aria-label="Previous page"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => setCurrentPage((p) => Math.min(totalPages - 1, p + 1))}
                      disabled={currentPage >= totalPages - 1}
                      className="w-9 h-9 rounded-full border border-stone-300 flex items-center justify-center text-stone-700 hover:border-stone-900 hover:text-black disabled:opacity-30 disabled:pointer-events-none transition-colors shadow-2xs"
                      aria-label="Next page"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

