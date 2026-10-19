import React from 'react';
import { Link } from 'react-router-dom';

export const Footer: React.FC = () => {
  return (
    <footer className="border-t border-stone-200/80 bg-[#FAF9F6] text-stone-600">
      <div className="max-w-7xl xl:max-w-[1536px] mx-auto px-4 sm:px-6 lg:px-8 xl:px-10 py-12 sm:py-16">
        {/* Main Footer Grid: Editorial Brand Area & Structured Navigation */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-16 items-start">
          {/* Brand Area (Spans 6 cols on desktop) */}
          <div className="lg:col-span-7 space-y-4">
            <Link
              to="/"
              className="inline-block group focus:outline-none focus-visible:ring-2 focus-visible:ring-stone-900 rounded"
              aria-label="Outside.vip homepage"
            >
              <span className="font-display font-black text-2xl tracking-tight text-stone-900 group-hover:opacity-85 transition-opacity">
                outside<span className="text-stone-400 font-normal">.vip</span>
              </span>
            </Link>

            <div className="space-y-1.5 max-w-md">
              <p className="font-display font-bold text-lg sm:text-xl text-stone-900 tracking-tight leading-snug">
                There&apos;s a world out there.
              </p>
              <p className="text-xs sm:text-sm text-stone-500 leading-relaxed">
                Find something worth showing up for.
              </p>
            </div>
          </div>

          {/* Navigation Area (Spans 5 cols on desktop, 2 distinct groups) */}
          <div className="lg:col-span-5 grid grid-cols-2 gap-8 sm:gap-10">
            {/* Group 1: Explore */}
            <div className="space-y-3">
              <h2 className="font-mono text-[11px] uppercase tracking-[0.2em] font-bold text-stone-400">
                Explore
              </h2>
              <ul className="space-y-2.5 text-xs sm:text-sm font-medium">
                <li>
                  <Link
                    to="/events"
                    className="text-stone-600 hover:text-stone-900 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-stone-900 rounded-sm"
                  >
                    Discover Events
                  </Link>
                </li>
              </ul>
            </div>

            {/* Group 2: For Organizers */}
            <div className="space-y-3">
              <h2 className="font-mono text-[11px] uppercase tracking-[0.2em] font-bold text-stone-400">
                For Organizers
              </h2>
              <ul className="space-y-2.5 text-xs sm:text-sm font-medium">
                <li>
                  <Link
                    to="/organizer"
                    className="text-stone-600 hover:text-stone-900 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-stone-900 rounded-sm"
                  >
                    Organizer Portal
                  </Link>
                </li>
                <li>
                  <Link
                    to="/organizer/events/new"
                    className="text-stone-600 hover:text-stone-900 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-stone-900 rounded-sm"
                  >
                    Create an Event
                  </Link>
                </li>
              </ul>
            </div>
          </div>
        </div>

        {/* Bottom Bar: Copyright & Subtle Brand Sign-Off */}
        <div className="mt-12 sm:mt-16 pt-6 border-t border-stone-200/60 flex flex-col sm:flex-row items-center justify-between gap-3 text-[11px] font-mono text-stone-400">
          <div>
            &copy; 2026 Outside.vip
          </div>
          <div>
            Made for going out there.
          </div>
        </div>
      </div>
    </footer>
  );
};
