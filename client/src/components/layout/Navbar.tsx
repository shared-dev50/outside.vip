import React, { useState, useEffect, useRef, useContext } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { QueryClientContext } from '@tanstack/react-query';
import { useAuth } from '../../context/AuthContext';
import {
  Plus,
  Menu,
  X,
  LogOut,
  ChevronDown,
  User as UserIcon,
} from 'lucide-react';
import {
  deriveNavigationState,
  NavigationCapabilitiesInput,
  NavigationState,
  WorkspaceKey,
} from '../../lib/navigation';
import { useNavigationCapabilities } from '../../hooks/useNavigationCapabilities';
import { User } from '../../types';

export interface NavbarProps {
  initialCapabilities?: NavigationCapabilitiesInput;
}

const NavbarContent: React.FC<{
  user: User | null;
  logout: () => Promise<void>;
  navigation: NavigationState;
}> = ({ user, logout, navigation }) => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [showAccountMenu, setShowAccountMenu] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);

  const navigate = useNavigate();
  const location = useLocation();

  const headerRef = useRef<HTMLElement | null>(null);
  const accountMenuRef = useRef<HTMLDivElement | null>(null);
  const accountTriggerRef = useRef<HTMLButtonElement | null>(null);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);
  const moreTriggerRef = useRef<HTMLButtonElement | null>(null);
  const mobileToggleRef = useRef<HTMLButtonElement | null>(null);

  const isHome = location.pathname === '/';
  const isDiscover = location.pathname.startsWith('/events');
  const isFinance = location.pathname.startsWith('/organizer/finance');
  const isOrganizerDashboard =
    location.pathname === '/organizer' ||
    (location.pathname.startsWith('/organizer/') && !isFinance);
  const isHost = location.pathname.startsWith('/host');
  const isOrder = location.pathname === '/orders' || location.pathname.startsWith('/orders/');
  const isTeam = location.pathname.startsWith('/teams');
  const isScanner = location.pathname.startsWith('/scanner');

  const isAuthPage =
    location.pathname.startsWith('/login') ||
    location.pathname.startsWith('/signin') ||
    location.pathname.startsWith('/register') ||
    location.pathname.startsWith('/forgot-password') ||
    location.pathname.startsWith('/reset-password');

  const isWorkspaceActive = (key: WorkspaceKey): boolean => {
    switch (key) {
      case 'organizer':
        return isOrganizerDashboard;
      case 'orders':
        return isOrder;
      case 'teams':
        return isTeam;
      case 'finance':
        return isFinance;
      case 'scanner':
        return isScanner;
      case 'host':
        return isHost;
    }
  };

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 16);
    };

    handleScroll();
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Close all open menus on route navigation
  useEffect(() => {
    setShowAccountMenu(false);
    setShowMoreMenu(false);
    setMobileMenuOpen(false);
  }, [location.pathname, location.search]);

  // Dismiss menus on outside pointer interaction or Escape key
  useEffect(() => {
    if (!showAccountMenu && !showMoreMenu && !mobileMenuOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;

      if (showAccountMenu && accountMenuRef.current && !accountMenuRef.current.contains(target)) {
        setShowAccountMenu(false);
      }
      if (showMoreMenu && moreMenuRef.current && !moreMenuRef.current.contains(target)) {
        setShowMoreMenu(false);
      }
      if (mobileMenuOpen && headerRef.current && !headerRef.current.contains(target)) {
        setMobileMenuOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;

      if (showAccountMenu) {
        setShowAccountMenu(false);
        accountTriggerRef.current?.focus();
      }
      if (showMoreMenu) {
        setShowMoreMenu(false);
        moreTriggerRef.current?.focus();
      }
      if (mobileMenuOpen) {
        setMobileMenuOpen(false);
        mobileToggleRef.current?.focus();
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [showAccountMenu, showMoreMenu, mobileMenuOpen]);

  const handleSignOut = () => {
    try {
      sessionStorage.removeItem('outside_scanner_invite_token');
    } catch {}
    logout();
    setShowAccountMenu(false);
    setShowMoreMenu(false);
    setMobileMenuOpen(false);
    navigate('/');
  };

  const headerClass = isHome
    ? isScrolled
      ? 'bg-[#FAF8F5]/90 backdrop-blur-md border-b border-stone-200/80 shadow-xs'
      : 'bg-transparent border-b border-transparent'
    : isDiscover || isOrganizerDashboard || isFinance || isHost || isAuthPage
      ? 'bg-[#FAF8F5]/95 backdrop-blur-md border-b border-stone-200/80 shadow-2xs'
      : 'bg-white/95 backdrop-blur-md border-b border-gray-200';

  const { destinations, visibleByKey, showCreateEvent } = navigation;
  const hasCompactOverflow = destinations.length >= 3;

  const navLinkClass = (active: boolean) =>
    `transition-colors py-1 whitespace-nowrap ${
      active
        ? 'text-stone-900 font-bold border-b-2 border-stone-900'
        : 'text-stone-500 hover:text-stone-900 font-medium'
    }`;

  // Breakpoint visibility for crowded multi-workspace navbars so Home & Discover
  // remain anchored on the left and nothing overlaps at tablet/laptop widths.
  const desktopInlineVisibilityClass = (key: WorkspaceKey): string => {
    if (!hasCompactOverflow) {
      return 'inline-block';
    }
    switch (key) {
      case 'organizer':
      case 'orders':
        return 'hidden md:inline-block';
      case 'teams':
      case 'scanner':
        return 'hidden lg:inline-block';
      case 'finance':
        return 'hidden xl:inline-block';
      case 'host':
        return 'hidden 2xl:inline-block';
    }
  };

  const desktopDropdownVisibilityClass = (key: WorkspaceKey): string => {
    switch (key) {
      case 'organizer':
      case 'orders':
        return 'md:hidden';
      case 'teams':
      case 'scanner':
        return 'lg:hidden';
      case 'finance':
        return 'xl:hidden';
      case 'host':
        return '2xl:hidden';
    }
  };

  const renderDesktopWorkspaceLink = (
    key: WorkspaceKey,
    responsiveClass: string,
    dropdownItem: boolean
  ) => {
    if (!visibleByKey[key]) return null;
    const active = isWorkspaceActive(key);
    const linkClass = dropdownItem
      ? `w-full text-left px-3 py-1.5 rounded hover:bg-stone-50 block font-medium whitespace-nowrap ${
          active ? 'text-stone-900 bg-stone-100/80 font-semibold' : 'text-stone-700'
        } ${responsiveClass}`
      : `${navLinkClass(active)} ${responsiveClass}`;
    const onClick = dropdownItem ? () => setShowMoreMenu(false) : undefined;
    const roleProp = dropdownItem ? ('menuitem' as const) : undefined;

    switch (key) {
      case 'organizer':
        return (
          <Link key={key} to="/organizer" className={linkClass} onClick={onClick} role={roleProp}>
            Organizer Dashboard
          </Link>
        );
      case 'orders':
        return (
          <Link key={key} to="/orders" className={linkClass} onClick={onClick} role={roleProp}>
            Orders
          </Link>
        );
      case 'teams':
        return (
          <Link key={key} to="/teams" className={linkClass} onClick={onClick} role={roleProp}>
            Team
          </Link>
        );
      case 'finance':
        return (
          <Link
            key={key}
            to="/organizer/finance"
            className={linkClass}
            onClick={onClick}
            role={roleProp}
          >
            Finance &amp; Organisation
          </Link>
        );
      case 'scanner':
        return (
          <Link key={key} to="/scanner" className={linkClass} onClick={onClick} role={roleProp}>
            Door Scanner
          </Link>
        );
      case 'host':
        return (
          <Link key={key} to="/host" className={linkClass} onClick={onClick} role={roleProp}>
            Host Workspace
          </Link>
        );
    }
  };

  const renderMobileWorkspaceLink = (key: WorkspaceKey) => {
    if (!visibleByKey[key]) return null;
    const active = isWorkspaceActive(key);
    const mobileClass = `block py-1.5 ${
      active ? 'text-stone-900 font-bold' : 'text-stone-600 hover:text-stone-900'
    }`;

    switch (key) {
      case 'organizer':
        return (
          <Link
            key={key}
            to="/organizer"
            onClick={() => setMobileMenuOpen(false)}
            className={mobileClass}
          >
            Organizer Dashboard
          </Link>
        );
      case 'orders':
        return (
          <Link
            key={key}
            to="/orders"
            onClick={() => setMobileMenuOpen(false)}
            className={mobileClass}
          >
            Orders
          </Link>
        );
      case 'teams':
        return (
          <Link
            key={key}
            to="/teams"
            onClick={() => setMobileMenuOpen(false)}
            className={mobileClass}
          >
            Team
          </Link>
        );
      case 'finance':
        return (
          <Link
            key={key}
            to="/organizer/finance"
            onClick={() => setMobileMenuOpen(false)}
            className={mobileClass}
          >
            Finance &amp; Organisation
          </Link>
        );
      case 'scanner':
        return (
          <Link
            key={key}
            to="/scanner"
            onClick={() => setMobileMenuOpen(false)}
            className={mobileClass}
          >
            Door Scanner
          </Link>
        );
      case 'host':
        return (
          <Link
            key={key}
            to="/host"
            onClick={() => setMobileMenuOpen(false)}
            className={mobileClass}
          >
            Host Workspace
          </Link>
        );
    }
  };

  const hasMoreAtXl = visibleByKey.host && hasCompactOverflow;

  return (
    <header
      ref={headerRef}
      className={`sticky top-0 z-50 w-full transition-all duration-300 ease-out ${headerClass}`}
    >
      <div className="max-w-7xl xl:max-w-[1536px] mx-auto px-4 sm:px-6 lg:px-8 xl:px-10 h-16 flex items-center justify-between gap-4">
        <div className="flex items-center gap-8 min-w-0">
          <Link
            to="/"
            className="flex items-center gap-1.5 group focus:outline-none focus-visible:ring-2 focus-visible:ring-stone-900 rounded shrink-0"
          >
            <span className="font-display font-black text-lg tracking-tight text-stone-900 group-hover:opacity-85 transition-opacity">
              out-side<span className="text-stone-400 font-normal font-black">.Vip</span>
            </span>
          </Link>

          <nav
            className="hidden sm:flex items-center gap-5 lg:gap-6 text-sm"
            aria-label="Primary navigation"
          >
            <Link to="/" className={navLinkClass(isHome)}>
              Home
            </Link>
            <Link to="/events" className={navLinkClass(isDiscover)}>
              Discover
            </Link>

            {destinations.map((dest) =>
              renderDesktopWorkspaceLink(dest.key, desktopInlineVisibilityClass(dest.key), false)
            )}

            {hasCompactOverflow && (
              <div
                ref={moreMenuRef}
                className={`relative ${hasMoreAtXl ? '2xl:hidden' : 'xl:hidden'}`}
              >
                <button
                  ref={moreTriggerRef}
                  type="button"
                  onClick={() => {
                    setShowAccountMenu(false);
                    setShowMoreMenu((prev) => !prev);
                  }}
                  aria-expanded={showMoreMenu}
                  aria-haspopup="menu"
                  aria-controls="workspace-more-menu"
                  className="inline-flex items-center gap-1 py-1 text-stone-600 hover:text-stone-900 font-medium whitespace-nowrap focus:outline-none focus-visible:ring-2 focus-visible:ring-stone-900 rounded"
                >
                  <span>More</span>
                  <ChevronDown
                    className={`w-3.5 h-3.5 transition-transform ${
                      showMoreMenu ? 'rotate-180' : ''
                    }`}
                  />
                </button>

                {showMoreMenu && (
                  <div
                    id="workspace-more-menu"
                    role="menu"
                    aria-label="Additional workspaces"
                    className="absolute left-0 mt-2 w-56 rounded-lg bg-white border border-stone-200 p-1.5 shadow-lg z-50 text-xs space-y-0.5 animate-in fade-in zoom-in-95"
                  >
                    {destinations.map((dest) =>
                      renderDesktopWorkspaceLink(
                        dest.key,
                        desktopDropdownVisibilityClass(dest.key),
                        true
                      )
                    )}
                  </div>
                )}
              </div>
            )}
          </nav>
        </div>

        <div className="hidden sm:flex items-center gap-3 shrink-0">
          {showCreateEvent && (
            <Link
              to="/organizer/events/new"
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-stone-900 hover:bg-black text-white text-xs font-semibold transition-colors shadow-xs whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Create Event</span>
            </Link>
          )}

          {user ? (
            <div ref={accountMenuRef} className="relative">
              <button
                ref={accountTriggerRef}
                type="button"
                onClick={() => {
                  setShowMoreMenu(false);
                  setShowAccountMenu((prev) => !prev);
                }}
                className="flex items-center gap-2 p-1.5 rounded-lg hover:bg-stone-200/50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-stone-900"
                aria-expanded={showAccountMenu}
                aria-haspopup="menu"
                aria-controls="account-dropdown-menu"
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
                <div
                  id="account-dropdown-menu"
                  role="menu"
                  aria-label="Account menu"
                  className="absolute right-0 mt-2 w-56 rounded-lg bg-white border border-stone-200 p-1.5 shadow-lg z-50 text-xs space-y-1 animate-in fade-in zoom-in-95"
                >
                  <div className="px-3 py-1.5 text-stone-500 border-b border-stone-100 text-[11px]">
                    Signed in as
                    <strong className="text-stone-900 block truncate">{user.name}</strong>
                    <span className="text-stone-500 block truncate">{user.email}</span>
                  </div>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={handleSignOut}
                    className="w-full text-left px-3 py-1.5 rounded hover:bg-stone-50 text-rose-600 flex items-center gap-1.5 font-medium"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    Sign out
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <Link
                to="/login"
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-stone-700 hover:text-black px-3 py-1.5 rounded-lg hover:bg-stone-200/50 transition-colors whitespace-nowrap"
              >
                <UserIcon className="w-3.5 h-3.5 text-stone-500" />
                <span>Sign in</span>
              </Link>
            </div>
          )}
        </div>

        <div className="flex sm:hidden items-center gap-2">
          <button
            ref={mobileToggleRef}
            type="button"
            onClick={() => setMobileMenuOpen((prev) => !prev)}
            className="p-1.5 text-stone-700 hover:text-black rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-stone-900"
            aria-label="Toggle navigation menu"
            aria-expanded={mobileMenuOpen}
            aria-controls="mobile-navigation-drawer"
          >
            {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {mobileMenuOpen && (
        <div
          id="mobile-navigation-drawer"
          aria-label="Mobile navigation"
          className={`sm:hidden border-b px-4 py-3 space-y-3 transition-colors ${
            isHome ? 'bg-[#FAF8F5] border-stone-200' : 'bg-white border-gray-200'
          }`}
        >
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
              className={`block py-1.5 ${
                isDiscover ? 'text-stone-900 font-bold' : 'text-stone-600'
              }`}
            >
              Discover
            </Link>
          </div>

          {destinations.length > 0 && (
            <div className="pt-2 border-t border-stone-200/60 space-y-1 text-sm font-medium">
              <div className="text-[10px] font-mono uppercase tracking-wider text-stone-400 pb-0.5">
                Workspaces
              </div>
              {destinations.map((dest) => renderMobileWorkspaceLink(dest.key))}
            </div>
          )}

          <div className="pt-2 border-t border-stone-200/60 flex items-center justify-between gap-3">
            {showCreateEvent ? (
              <Link
                to="/organizer/events/new"
                onClick={() => setMobileMenuOpen(false)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-stone-900 text-white text-xs font-semibold"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Create Event</span>
              </Link>
            ) : (
              <span className="text-[11px] text-stone-500 truncate">
                {user ? user.email : ''}
              </span>
            )}

            {user ? (
              <button
                type="button"
                onClick={handleSignOut}
                className="text-xs text-rose-600 hover:underline font-medium shrink-0"
              >
                Sign out ({user.name})
              </button>
            ) : (
              <div className="flex items-center gap-3">
                <Link
                  to="/login"
                  onClick={() => setMobileMenuOpen(false)}
                  className="text-xs text-stone-800 font-semibold hover:underline"
                >
                  Sign in
                </Link>
                <span className="text-stone-300">•</span>
                <Link
                  to="/register"
                  onClick={() => setMobileMenuOpen(false)}
                  className="text-xs text-stone-600 font-medium hover:underline"
                >
                  Create account
                </Link>
              </div>
            )}
          </div>
        </div>
      )}
    </header>
  );
};

const NavbarWithQuery: React.FC<{
  user: User | null;
  logout: () => Promise<void>;
  initialCapabilities?: NavigationCapabilitiesInput;
}> = ({ user, logout, initialCapabilities }) => {
  const navigation = useNavigationCapabilities(user, initialCapabilities);
  return <NavbarContent user={user} logout={logout} navigation={navigation} />;
};

const NavbarStatic: React.FC<{
  user: User | null;
  logout: () => Promise<void>;
  initialCapabilities?: NavigationCapabilitiesInput;
}> = ({ user, logout, initialCapabilities }) => {
  const navigation = deriveNavigationState(user, initialCapabilities);
  return <NavbarContent user={user} logout={logout} navigation={navigation} />;
};

export const Navbar: React.FC<NavbarProps> = ({ initialCapabilities }) => {
  const { user, logout } = useAuth();
  const queryClient = useContext(QueryClientContext);

  if (queryClient) {
    return (
      <NavbarWithQuery
        user={user}
        logout={logout}
        initialCapabilities={initialCapabilities}
      />
    );
  }

  return (
    <NavbarStatic
      user={user}
      logout={logout}
      initialCapabilities={initialCapabilities}
    />
  );
};
