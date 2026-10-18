import React, { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { ArrowRight, RefreshCw, ChevronLeft, ChevronRight } from 'lucide-react';
import { StencilHeadline } from '../components/home/StencilHeadline';
import { PosterCard } from '../components/home/PosterCard';
import { TapeRibbons } from '../components/home/TapeRibbons';

export const HomePage: React.FC = () => {
  // Sync body background with homepage canvas to eliminate any white overscroll bounce
  useEffect(() => {
    const originalBg = document.body.style.backgroundColor;
    document.body.style.backgroundColor = '#FAF8F5';
    return () => {
      document.body.style.backgroundColor = originalBg;
    };
  }, []);

  // Query published events from API
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['homepage-events'],
    queryFn: () =>
      api.events.list({
        limit: 12,
        sortBy: 'date_asc',
      }),
  });

  const allEvents = data?.events || [];

  // Active elevated card index (Card index 1 is elevated by default, mirroring reference Card 2)
  const [elevatedIndex, setElevatedIndex] = useState<number>(1);
  const [currentPage, setCurrentPage] = useState<number>(0);

  // Cards per page for desktop shelf view (4 posters matching the screenshot)
  const CARDS_PER_VIEW = 4;
  const maxPages = Math.ceil(Math.max(1, allEvents.length) / CARDS_PER_VIEW);
  const visibleEvents = allEvents.slice(
    currentPage * CARDS_PER_VIEW,
    (currentPage + 1) * CARDS_PER_VIEW
  );

  return (
    <div className="relative min-h-screen bg-[#FAF8F5] text-stone-900 overflow-x-hidden selection:bg-stone-900 selection:text-white">
      {/* 1. Subtle Background Graphic Elements (Topographic Contours & Dot Grids) */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden select-none" aria-hidden="true">
        {/* Top-Left Topographic Contour Waves */}
        <svg
          className="absolute -top-10 -left-10 w-80 sm:w-96 h-80 sm:h-96 opacity-35 text-[#D8D2C5]"
          viewBox="0 0 400 400"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
        >
          <path d="M-50,100 C80,80 120,220 280,180 C360,160 420,240 450,300" />
          <path d="M-50,130 C90,110 140,240 300,200 C380,180 430,260 460,330" />
          <path d="M-50,160 C100,140 160,260 320,220 C400,200 440,280 470,360" />
          <path d="M-50,190 C110,170 180,280 340,240 C420,220 450,300 480,390" />
          <path d="M-50,220 C120,200 200,300 360,260 C440,240 460,320 490,420" />
        </svg>

        {/* Top-Right Architectural Mesh Lines */}
        <svg
          className="absolute -top-6 -right-10 w-72 sm:w-88 h-72 sm:h-88 opacity-30 text-[#D8D2C5]"
          viewBox="0 0 350 350"
          fill="none"
          stroke="currentColor"
          strokeWidth="0.8"
        >
          <path d="M100,-20 C140,90 220,120 370,160" />
          <path d="M70,-20 C120,110 200,150 370,200" />
          <path d="M40,-20 C100,130 180,180 370,240" />
          <path d="M10,-20 C80,150 160,210 370,280" />
        </svg>

        {/* Upper Left Dot Matrix Grid */}
        <div className="absolute top-12 left-6 sm:left-14 grid grid-cols-4 gap-2 opacity-40 text-stone-400 font-mono text-[9px]">
          {Array.from({ length: 16 }).map((_, i) => (
            <span key={i}>+</span>
          ))}
        </div>

        {/* Upper Right Dot Matrix Grid */}
        <div className="absolute top-16 right-8 sm:right-20 grid grid-cols-4 gap-2.5 opacity-35 text-stone-400 font-mono text-[9px]">
          {Array.from({ length: 16 }).map((_, i) => (
            <span key={i}>+</span>
          ))}
        </div>
      </div>

      {/* Main Content Container */}
      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-20 sm:pt-24 lg:pt-28 pb-6 space-y-8 sm:space-y-12">
        {/* 2. Top Minimal Header: Pill Tag & Stencil Title */}
        <section className="text-center space-y-3 pt-2">
          {/* Subtle Category / Pill Tag */}
          <div className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-[#EFECE5]/80 border border-[#DDD7CB]/70 text-[#7A7165] text-[10px] sm:text-[11px] font-mono uppercase tracking-[0.22em] font-bold shadow-xs">
            <span className="w-1.5 h-1.5 rounded-full bg-[#96846D]" />
            <span>CURATED EVENTS & EXPERIENCES</span>
          </div>

          {/* Monumental Stencil Statement Headline */}
          <StencilHeadline subtitle="FIND SOMETHING WORTH SHOWING UP FOR" />
        </section>

        {/* 3. The Poster Gallery Shelf (The Core Visual Attraction) */}
        <section className="space-y-4">
          {/* Loading Skeleton Shelf */}
          {isLoading && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 pt-6">
              {[1, 2, 3, 4].map((i) => (
                <div
                  key={i}
                  className={`space-y-3 p-3 rounded bg-stone-100/60 animate-pulse ${
                    i === 2 ? '-translate-y-4 shadow-xl bg-stone-200/60' : ''
                  }`}
                >
                  <div className="aspect-[3/4] bg-stone-200 rounded-sm" />
                  <div className="h-4 w-3/4 bg-stone-200 rounded" />
                  <div className="h-3 w-1/2 bg-stone-200 rounded" />
                </div>
              ))}
            </div>
          )}

          {/* Error State */}
          {error && (
            <div className="p-8 rounded-lg bg-[#EFECE5] border border-stone-300 text-center space-y-3 max-w-md mx-auto my-12">
              <p className="text-stone-900 font-bold text-sm">Unable to load event showcase</p>
              <p className="text-xs text-stone-500">{(error as Error).message}</p>
              <button
                onClick={() => refetch()}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-stone-900 text-white text-xs font-mono uppercase tracking-wider font-semibold hover:bg-black"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Retry</span>
              </button>
            </div>
          )}

          {/* Render Curated Poster Cards */}
          {!isLoading && allEvents.length > 0 && (
            <div>
              {/* Desktop & Tablet: 4-Card Gallery Row with Elevating Hero */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 sm:gap-6 lg:gap-7 items-end pt-4 sm:pt-8">
                {visibleEvents.map((event, idx) => {
                  const globalIdx = currentPage * CARDS_PER_VIEW + idx;
                  const isElevated = elevatedIndex === globalIdx;

                  return (
                    <PosterCard
                      key={event.id}
                      event={event}
                      index={idx}
                      isElevated={isElevated}
                      onHover={() => setElevatedIndex(globalIdx)}
                      onLeave={() => {
                        // Reset to default card (index 1) if not hovering
                        // or keep last hovered to preserve organic interaction
                      }}
                    />
                  );
                })}
              </div>

              {/* Architectural Baseline with Tick Marks (Mirroring Reference) */}
              <div className="hidden lg:block w-full border-t border-stone-300/80 mt-4 relative">
                <div className="grid grid-cols-4 w-full">
                  {visibleEvents.map((_, i) => (
                    <div key={i} className="flex justify-start">
                      <div className="border-l border-stone-400 h-2.5" />
                    </div>
                  ))}
                  <div className="absolute right-0 top-0 border-r border-stone-400 h-2.5" />
                </div>
              </div>

              {/* Multi-page controls if catalogue has > 4 events */}
              {allEvents.length > CARDS_PER_VIEW && (
                <div className="flex items-center justify-between pt-4 text-xs font-mono text-stone-500">
                  <div className="flex items-center gap-2">
                    <span>SHOWCASE</span>
                    <span className="text-stone-900 font-bold">
                      {currentPage + 1} / {maxPages}
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => setCurrentPage((p) => Math.max(0, p - 1))}
                      disabled={currentPage === 0}
                      className="p-1.5 rounded border border-stone-300 text-stone-700 hover:text-black hover:border-stone-900 disabled:opacity-30 disabled:pointer-events-none transition-colors"
                      aria-label="Previous showcase page"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => setCurrentPage((p) => Math.min(maxPages - 1, p + 1))}
                      disabled={currentPage >= maxPages - 1}
                      className="p-1.5 rounded border border-stone-300 text-stone-700 hover:text-black hover:border-stone-900 disabled:opacity-30 disabled:pointer-events-none transition-colors"
                      aria-label="Next showcase page"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Empty State */}
          {!isLoading && allEvents.length === 0 && (
            <div className="p-12 text-center text-stone-500 text-xs font-mono uppercase tracking-wider">
              No live public events found in catalogue.
            </div>
          )}
        </section>

        {/* 4. Minimal Explore Link */}
        <section className="text-center pt-2 pb-2">
          <Link
            to="/events"
            className="group inline-flex items-center gap-2 px-6 py-3 rounded-full border border-stone-300/80 bg-white/70 hover:bg-white text-stone-900 text-xs font-mono uppercase tracking-[0.18em] font-bold shadow-xs hover:shadow-md hover:border-stone-900 transition-all duration-300"
          >
            <span>Explore all events ({allEvents.length})</span>
            <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-1 transition-transform" />
          </Link>
        </section>
      </div>

      {/* 5. Angled Crossing Festival Straps / Tape Ribbons (Mirroring Reference) */}
      <TapeRibbons className="mt-4 sm:mt-8" />
    </div>
  );
};
