import React from 'react';
import { Link } from 'react-router-dom';

export const Footer: React.FC = () => {
  return (
    <footer className="border-t border-surface-800 bg-surface-950 mt-24">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-12 mb-12">
          {/* Brand info */}
          <div className="md:col-span-2 space-y-4">
            <Link to="/" className="flex items-center gap-2">
              <span className="font-display font-black tracking-tight text-2xl text-white">
                OUTSIDE<span className="text-brand-neon">.VIP</span>
              </span>
            </Link>
            <p className="text-slate-400 text-sm max-w-sm leading-relaxed">
              The high-velocity event discovery & ticketing platform for subcultures, electronic sounds, festivals, and forward-thinking gatherings.
            </p>
            <div className="flex items-center gap-2 pt-2 text-xs font-mono text-slate-500">
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
              All systems operational · Stripe Checkout & QR Engine Active
            </div>
          </div>

          {/* Platform Links */}
          <div className="space-y-3">
            <h4 className="text-xs uppercase font-mono tracking-widest text-slate-300 font-semibold">
              Platform
            </h4>
            <ul className="space-y-2 text-sm text-slate-400">
              <li>
                <Link to="/" className="hover:text-brand-neon transition-colors">
                  Explore Events
                </Link>
              </li>
              <li>
                <Link to="/organizer" className="hover:text-brand-neon transition-colors">
                  Organizer Dashboard
                </Link>
              </li>
              <li>
                <Link to="/organizer/events/new" className="hover:text-brand-neon transition-colors">
                  Create Event
                </Link>
              </li>
              <li>
                <Link to="/scanner" className="hover:text-brand-neon transition-colors">
                  Browser Scanner
                </Link>
              </li>
            </ul>
          </div>

          {/* Curated Cities */}
          <div className="space-y-3">
            <h4 className="text-xs uppercase font-mono tracking-widest text-slate-300 font-semibold">
              Destinations
            </h4>
            <ul className="space-y-2 text-sm text-slate-400">
              <li className="flex items-center justify-between">
                <span>Kilifi / Coastal</span>
                <span className="text-xs font-mono text-brand-neon">Festival Hub</span>
              </li>
              <li className="flex items-center justify-between">
                <span>Nairobi</span>
                <span className="text-xs font-mono text-slate-500">Underground</span>
              </li>
              <li className="flex items-center justify-between">
                <span>Lagos</span>
                <span className="text-xs font-mono text-slate-500">Coming Soon</span>
              </li>
              <li className="flex items-center justify-between">
                <span>Cape Town</span>
                <span className="text-xs font-mono text-slate-500">Coming Soon</span>
              </li>
            </ul>
          </div>
        </div>

        <div className="pt-8 border-t border-surface-850 flex flex-col md:flex-row items-center justify-between text-xs text-slate-500 gap-4">
          <div>
            © {new Date().getFullYear()} Outside.vip. All rights reserved. Built for exceptional live experiences.
          </div>
          <div className="flex items-center gap-6">
            <span className="hover:text-slate-400 cursor-pointer">Terms of Service</span>
            <span className="hover:text-slate-400 cursor-pointer">Privacy Policy</span>
            <span className="hover:text-slate-400 cursor-pointer">Security & Scanners</span>
          </div>
        </div>
      </div>
    </footer>
  );
};
