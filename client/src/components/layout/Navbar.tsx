import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { 
  Sparkles, 
  PlusCircle, 
  QrCode, 
  LayoutDashboard, 
  LogOut, 
  Menu, 
  X,
  Compass
} from 'lucide-react';

export const Navbar: React.FC = () => {
  const { user, logout, quickLoginAs } = useAuth();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [showDemoMenu, setShowDemoMenu] = useState(false);
  const navigate = useNavigate();

  return (
    <header className="sticky top-0 z-50 w-full border-b border-surface-800/80 bg-surface-950/80 backdrop-blur-xl">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-20 flex items-center justify-between">
        {/* Brand Logo */}
        <Link to="/" className="flex items-center gap-3 group">
          <div className="w-10 h-10 rounded-xl bg-brand-neon flex items-center justify-center font-display font-black text-black text-xl tracking-tighter shadow-neon-sm group-hover:scale-105 transition-transform">
            ⚡
          </div>
          <div className="flex flex-col">
            <span className="font-display font-black tracking-tight text-xl text-white flex items-center gap-1.5">
              OUTSIDE<span className="text-brand-neon">.VIP</span>
            </span>
            <span className="text-[10px] uppercase tracking-widest text-slate-400 font-mono -mt-1">
              Live Experiences
            </span>
          </div>
        </Link>

        {/* Desktop Nav Links */}
        <nav className="hidden md:flex items-center gap-8">
          <Link
            to="/"
            className="flex items-center gap-2 text-sm font-medium text-slate-300 hover:text-white transition-colors"
          >
            <Compass className="w-4 h-4 text-brand-neon" />
            Explore
          </Link>

          <Link
            to="/organizer"
            className="flex items-center gap-2 text-sm font-medium text-slate-300 hover:text-white transition-colors"
          >
            <LayoutDashboard className="w-4 h-4 text-slate-400" />
            Organizer Portal
          </Link>

          <Link
            to="/scanner"
            className="flex items-center gap-2 text-sm font-medium text-slate-300 hover:text-white transition-colors"
          >
            <QrCode className="w-4 h-4 text-slate-400" />
            Check-In Scanner
          </Link>
        </nav>

        {/* Action Buttons & Auth */}
        <div className="hidden md:flex items-center gap-4">
          <Link
            to="/organizer/events/new"
            className="flex items-center gap-2 px-4 py-2 rounded-full bg-surface-850 hover:bg-surface-800 text-slate-200 border border-surface-700 hover:border-slate-500 text-sm font-semibold transition-all shadow-sm"
          >
            <PlusCircle className="w-4 h-4 text-brand-neon" />
            Create Event
          </Link>

          {user ? (
            <div className="flex items-center gap-3 pl-2 border-l border-surface-800">
              <div className="flex items-center gap-2">
                {user.avatarUrl ? (
                  <img
                    src={user.avatarUrl}
                    alt={user.name}
                    className="w-8 h-8 rounded-full border border-surface-700 object-cover"
                  />
                ) : (
                  <div className="w-8 h-8 rounded-full bg-surface-800 border border-surface-700 flex items-center justify-center text-xs font-bold text-brand-neon">
                    {user.name.charAt(0)}
                  </div>
                )}
                <div className="flex flex-col text-left">
                  <span className="text-xs font-semibold text-slate-200 leading-tight">
                    {user.name}
                  </span>
                  <span className="text-[10px] text-brand-neon uppercase font-mono">
                    {user.role}
                  </span>
                </div>
              </div>

              <button
                onClick={() => {
                  logout();
                  navigate('/');
                }}
                title="Log Out"
                className="p-2 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-surface-850 transition-colors"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <div className="relative">
              <button
                onClick={() => setShowDemoMenu(!showDemoMenu)}
                className="flex items-center gap-2 px-4 py-2 rounded-full bg-brand-neon text-black font-semibold text-sm hover:bg-brand-neon-hover transition-all shadow-neon-sm"
              >
                <Sparkles className="w-4 h-4" />
                Sign In / Demo
              </button>

              {showDemoMenu && (
                <div className="absolute right-0 mt-2 w-64 rounded-2xl glass-panel p-2 shadow-2xl z-50 animate-in fade-in zoom-in-95">
                  <div className="px-3 py-2 text-[11px] font-mono uppercase tracking-wider text-slate-400 border-b border-surface-800">
                    Quick Demo Profiles
                  </div>
                  <button
                    onClick={async () => {
                      await quickLoginAs('organizer');
                      setShowDemoMenu(false);
                      navigate('/organizer');
                    }}
                    className="w-full text-left px-3 py-2.5 rounded-xl hover:bg-surface-800 flex items-center gap-2.5 text-xs text-slate-200 transition-colors"
                  >
                    <div className="w-6 h-6 rounded-md bg-purple-500/20 text-purple-400 flex items-center justify-center text-xs font-bold">
                      O
                    </div>
                    <div>
                      <div className="font-semibold text-white">Sol Collective</div>
                      <div className="text-[10px] text-slate-400">Event Organizer</div>
                    </div>
                  </button>

                  <button
                    onClick={async () => {
                      await quickLoginAs('attendee');
                      setShowDemoMenu(false);
                    }}
                    className="w-full text-left px-3 py-2.5 rounded-xl hover:bg-surface-800 flex items-center gap-2.5 text-xs text-slate-200 transition-colors"
                  >
                    <div className="w-6 h-6 rounded-md bg-emerald-500/20 text-emerald-400 flex items-center justify-center text-xs font-bold">
                      A
                    </div>
                    <div>
                      <div className="font-semibold text-white">Alex Mwangi</div>
                      <div className="text-[10px] text-slate-400">Ticket Holder</div>
                    </div>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Mobile menu button */}
        <button
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          className="md:hidden p-2 text-slate-400 hover:text-white"
        >
          {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
        </button>
      </div>

      {/* Mobile Menu */}
      {mobileMenuOpen && (
        <div className="md:hidden border-b border-surface-800 bg-surface-950 p-4 space-y-3">
          <Link
            to="/"
            onClick={() => setMobileMenuOpen(false)}
            className="block px-3 py-2 rounded-lg text-base font-medium text-slate-200 hover:bg-surface-850"
          >
            Explore Events
          </Link>
          <Link
            to="/organizer"
            onClick={() => setMobileMenuOpen(false)}
            className="block px-3 py-2 rounded-lg text-base font-medium text-slate-200 hover:bg-surface-850"
          >
            Organizer Dashboard
          </Link>
          <Link
            to="/organizer/events/new"
            onClick={() => setMobileMenuOpen(false)}
            className="block px-3 py-2 rounded-lg text-base font-medium text-brand-neon hover:bg-surface-850"
          >
            Create Event
          </Link>
          <Link
            to="/scanner"
            onClick={() => setMobileMenuOpen(false)}
            className="block px-3 py-2 rounded-lg text-base font-medium text-slate-200 hover:bg-surface-850"
          >
            Check-In Scanner
          </Link>
          {user ? (
            <button
              onClick={() => {
                logout();
                setMobileMenuOpen(false);
              }}
              className="w-full text-left px-3 py-2 rounded-lg text-base font-medium text-rose-400 hover:bg-surface-850"
            >
              Sign Out ({user.name})
            </button>
          ) : (
            <button
              onClick={async () => {
                await quickLoginAs('organizer');
                setMobileMenuOpen(false);
              }}
              className="w-full text-center py-2.5 rounded-xl bg-brand-neon text-black font-semibold text-sm"
            >
              Demo Sign In
            </button>
          )}
        </div>
      )}
    </header>
  );
};
