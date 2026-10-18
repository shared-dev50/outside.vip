import React, { useState, useEffect } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { 
  Plus, 
  Menu, 
  X, 
  LogOut,
  User as UserIcon
} from 'lucide-react';

export const Navbar: React.FC = () => {
  const { user, logout, quickLoginAs } = useAuth();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [showAccountMenu, setShowAccountMenu] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const isHome = location.pathname === '/';
  const isDiscover = location.pathname.startsWith('/events');

  // Track window scroll on the homepage to transition from transparent to subtle opaque
  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 16);
    };

    handleScroll();
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Determine navbar appearance based on route and scroll position
  const headerClass = isHome
    ? isScrolled
      ? 'bg-[#FAF8F5]/90 backdrop-blur-md border-b border-stone-200/80 shadow-xs'
      : 'bg-transparent border-b border-transparent'
    : 'bg-white/95 backdrop-blur-md border-b border-gray-200';

  return (
    <header className={`sticky top-0 z-50 w-full transition-all duration-300 ease-out ${headerClass}`}>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
        {/* Left: Brand Wordmark & Nav Links */}
        <div className="flex items-center gap-8">
          <Link to="/" className="flex items-center gap-1.5 group focus:outline-none focus-visible:ring-2 focus-visible:ring-stone-900 rounded">
            <span className="font-display font-black text-lg tracking-tight text-stone-900 group-hover:opacity-85 transition-opacity">
              outside<span className="text-stone-400 font-normal">.vip</span>
            </span>
          </Link>

          <nav className="hidden sm:flex items-center gap-6 text-sm">
            <Link
              to="/"
              className={`transition-colors py-1 ${
                isHome
                  ? 'text-stone-900 font-bold border-b-2 border-stone-900'
                  : 'text-stone-500 hover:text-stone-900 font-medium'
              }`}
            >
              Home
            </Link>
            <Link
              to="/events"
              className={`transition-colors py-1 ${
                isDiscover
                  ? 'text-stone-900 font-bold border-b-2 border-stone-900'
                  : 'text-stone-500 hover:text-stone-900 font-medium'
              }`}
            >
              Discover
            </Link>
          </nav>
        </div>

        {/* Right: Create Event & Account Actions */}
        <div className="hidden sm:flex items-center gap-3">
          <Link
            to="/organizer/events/new"
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-stone-900 hover:bg-black text-white text-xs font-semibold transition-colors shadow-xs"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Create Event</span>
          </Link>

          {user ? (
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowAccountMenu(!showAccountMenu)}
                className="flex items-center gap-2 p-1.5 rounded-lg hover:bg-stone-200/50 transition-colors"
                aria-expanded={showAccountMenu}
                aria-haspopup="true"
              >
                {user.avatarUrl ? (
                  <img
                    src={user.avatarUrl}
                    alt={user.name}
                    className="w-7 h-7 rounded-full object-cover border border-stone-200"
                  />
                ) : (
                  <div className="w-7 h-7 rounded-full bg-stone-200 border border-stone-300 flex items-center justify-center text-xs font-bold text-stone-700">
                    {user.name.charAt(0)}
                  </div>
                )}
                <span className="text-xs font-medium text-stone-800 max-w-[120px] truncate">
                  {user.name}
                </span>
              </button>

              {showAccountMenu && (
                <div className="absolute right-0 mt-2 w-52 rounded-lg bg-white border border-stone-200 p-1.5 shadow-lg z-50 text-xs space-y-0.5 animate-in fade-in zoom-in-95">
                  <div className="px-3 py-1.5 text-stone-500 border-b border-stone-100 text-[11px]">
                    Signed in as <strong className="text-stone-900 block truncate">{user.email}</strong>
                  </div>
                  <Link
                    to="/organizer"
                    onClick={() => setShowAccountMenu(false)}
                    className="w-full text-left px-3 py-1.5 rounded hover:bg-stone-50 text-stone-700 block font-medium"
                  >
                    Organizer Dashboard
                  </Link>
                  <Link
                    to="/scanner"
                    onClick={() => setShowAccountMenu(false)}
                    className="w-full text-left px-3 py-1.5 rounded hover:bg-stone-50 text-stone-700 block font-medium"
                  >
                    Door Scanner
                  </Link>
                  <button
                    onClick={() => {
                      logout();
                      setShowAccountMenu(false);
                      navigate('/');
                    }}
                    className="w-full text-left px-3 py-1.5 rounded hover:bg-stone-50 text-rose-600 flex items-center gap-1.5 pt-1 border-t border-stone-100"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    Sign out
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowAccountMenu(!showAccountMenu)}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-stone-700 hover:text-black px-3 py-1.5 rounded-lg hover:bg-stone-200/50 transition-colors"
                aria-expanded={showAccountMenu}
                aria-haspopup="true"
              >
                <UserIcon className="w-3.5 h-3.5 text-stone-500" />
                <span>Sign in</span>
              </button>

              {showAccountMenu && (
                <div className="absolute right-0 mt-2 w-52 rounded-lg bg-white border border-stone-200 p-1.5 shadow-lg z-50 text-xs space-y-1 animate-in fade-in zoom-in-95">
                  <div className="px-2.5 py-1 text-[11px] font-medium text-stone-400 border-b border-stone-100 uppercase tracking-wider">
                    Demo Sign In
                  </div>
                  <button
                    onClick={async () => {
                      await quickLoginAs('organizer');
                      setShowAccountMenu(false);
                      navigate('/organizer');
                    }}
                    className="w-full text-left px-2.5 py-1.5 rounded hover:bg-stone-50 text-stone-700 block"
                  >
                    <div className="font-semibold text-stone-900">Organizer Profile</div>
                    <div className="text-[10px] text-stone-500">Sol Collective & Sound</div>
                  </button>
                  <button
                    onClick={async () => {
                      await quickLoginAs('attendee');
                      setShowAccountMenu(false);
                    }}
                    className="w-full text-left px-2.5 py-1.5 rounded hover:bg-stone-50 text-stone-700 block"
                  >
                    <div className="font-semibold text-stone-900">Attendee Profile</div>
                    <div className="text-[10px] text-stone-500">Alex Mwangi</div>
                  </button>
                  <div className="pt-1 border-t border-stone-100">
                    <Link
                      to="/scanner"
                      onClick={() => setShowAccountMenu(false)}
                      className="w-full text-left px-2.5 py-1 text-stone-500 hover:text-stone-900 text-[11px] block"
                    >
                      Door Scanner
                    </Link>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Mobile Hamburger Toggle */}
        <div className="flex sm:hidden items-center gap-2">
          <button
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="p-1.5 text-stone-700 hover:text-black rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-stone-900"
            aria-label="Toggle navigation menu"
            aria-expanded={mobileMenuOpen}
          >
            {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {/* Mobile Menu Drawer */}
      {mobileMenuOpen && (
        <div className={`sm:hidden border-b px-4 py-3 space-y-3 transition-colors ${
          isHome ? 'bg-[#FAF8F5] border-stone-200' : 'bg-white border-gray-200'
        }`}>
          <div className="space-y-1 text-sm font-medium">
            <Link
              to="/"
              onClick={() => setMobileMenuOpen(false)}
              className={`block py-1.5 ${isHome ? 'text-stone-900 font-bold' : 'text-stone-600'}`}
            >
              Home
            </Link>
            <Link
              to="/events"
              onClick={() => setMobileMenuOpen(false)}
              className={`block py-1.5 ${isDiscover ? 'text-stone-900 font-bold' : 'text-stone-600'}`}
            >
              Discover
            </Link>
            <Link
              to="/organizer"
              onClick={() => setMobileMenuOpen(false)}
              className="block text-stone-600 hover:text-stone-900 py-1.5"
            >
              Organizer Portal
            </Link>
            <Link
              to="/scanner"
              onClick={() => setMobileMenuOpen(false)}
              className="block text-stone-600 hover:text-stone-900 py-1.5"
            >
              Door Scanner
            </Link>
          </div>

          <div className="pt-2 border-t border-stone-200/60 flex items-center justify-between">
            <Link
              to="/organizer/events/new"
              onClick={() => setMobileMenuOpen(false)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-stone-900 text-white text-xs font-semibold"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Create Event</span>
            </Link>

            {user ? (
              <button
                onClick={() => {
                  logout();
                  setMobileMenuOpen(false);
                }}
                className="text-xs text-rose-600 hover:underline"
              >
                Sign out ({user.name})
              </button>
            ) : (
              <button
                onClick={async () => {
                  await quickLoginAs('organizer');
                  setMobileMenuOpen(false);
                }}
                className="text-xs text-stone-700 font-semibold hover:underline"
              >
                Sign in (Demo)
              </button>
            )}
          </div>
        </div>
      )}
    </header>
  );
};
