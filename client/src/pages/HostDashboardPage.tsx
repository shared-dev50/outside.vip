import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { api } from '../lib/api';
import {
  HostAssignedEventItem,
  DailyTrafficItem,
} from '../types';
import {
  TrendingUp,
  Users,
  MousePointerClick,
  Globe,
  Calendar,
  MapPin,
  ExternalLink,
  Copy,
  Check,
  Edit3,
  Sparkles,
  AlertCircle,
  CheckCircle2,
  RotateCw,
  X,
  Shield,
} from 'lucide-react';

export interface HostDashboardPageProps {
  initialEvents?: HostAssignedEventItem[];
  initialError?: string | null;
}

export const HostDashboardPage: React.FC<HostDashboardPageProps> = ({
  initialEvents,
  initialError,
}) => {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  // Background theming
  useEffect(() => {
    const originalBg = document.body.style.backgroundColor;
    document.body.style.backgroundColor = '#FAF8F5';
    return () => {
      document.body.style.backgroundColor = originalBg;
    };
  }, []);

  // State
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [isCustomizingSlug, setIsCustomizingSlug] = useState(false);
  const [customSlugInput, setCustomSlugInput] = useState('');
  const [slugError, setSlugError] = useState<string | null>(null);
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);
  const [notification, setNotification] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  const showNotification = (type: 'success' | 'error', message: string) => {
    setNotification({ type, message });
    setTimeout(() => setNotification(null), 4000);
  };

  // Query: Host Assigned Events
  const {
    data: assignedEventsData,
    isLoading: rawIsLoadingEvents,
    isFetching: isFetchingEvents,
    error: eventsError,
    refetch: refetchEvents,
  } = useQuery({
    queryKey: ['host-events'],
    queryFn: () => api.host.getEvents(),
    enabled: initialEvents === undefined && initialError === undefined,
  });

  const assignedEvents = initialEvents !== undefined ? initialEvents : (assignedEventsData || []);
  const isLoadingEvents = initialEvents !== undefined || initialError !== undefined ? false : rawIsLoadingEvents;
  const isEventsError = Boolean(initialError) || Boolean(eventsError);
  const eventsErrorMessage =
    initialError ||
    (eventsError instanceof Error ? eventsError.message : 'Please check your connection or sign in again.');

  // Determine currently active event
  const activeEventItem: HostAssignedEventItem | null =
    assignedEvents.find((item) => item.event.id === selectedEventId) ||
    assignedEvents[0] ||
    null;

  const activeEvent = activeEventItem?.event || null;
  const activeHostLink = activeEventItem?.hostLink || null;

  // Query: Host Private Analytics for active event
  const {
    data: analyticsData,
    isLoading: isLoadingAnalytics,
    isFetching: isFetchingAnalytics,
    error: analyticsError,
    refetch: refetchAnalytics,
  } = useQuery({
    queryKey: ['host-analytics', activeEvent?.id],
    queryFn: () => api.host.getAnalytics(activeEvent!.id),
    enabled: Boolean(activeEvent?.id),
  });

  // Verify that analyticsData matches the currently active host link to prevent stale data leaking during event switches
  const isAnalyticsForCurrentEvent = Boolean(
    !activeHostLink || (analyticsData?.link && analyticsData.link.id === activeHostLink.id)
  );
  const isActuallyLoadingAnalytics =
    isLoadingAnalytics || (Boolean(activeEvent?.id) && !isAnalyticsForCurrentEvent);
  const traffic = !isActuallyLoadingAnalytics ? analyticsData?.traffic : null;

  // Mutation: Customize Slug
  const customizeSlugMutation = useMutation({
    mutationFn: ({ eventId, slug }: { eventId: string; slug: string }) =>
      api.host.customizeSlug(eventId, slug),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['host-events'] });
      queryClient.invalidateQueries({ queryKey: ['host-analytics', activeEvent?.id] });
      setIsCustomizingSlug(false);
      setCustomSlugInput('');
      setSlugError(null);
      showNotification(
        'success',
        result.unchanged
          ? 'Primary slug is already set to this value.'
          : `Slug updated to /r/${result.primarySlug}. Previous slugs remain active as aliases!`
      );
    },
    onError: (err: any) => {
      const msg = err?.message || 'Failed to customize slug. Please choose a different slug.';
      setSlugError(msg);
    },
  });

  // Copy helper with dynamic origin
  const handleCopyLink = (slug: string) => {
    const origin =
      typeof window !== 'undefined' && window.location?.origin
        ? window.location.origin
        : '';
    const fullUrl = origin ? `${origin}/r/${slug}` : `/r/${slug}`;

    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(fullUrl);
    }
    setCopiedSlug(slug);
    setTimeout(() => setCopiedSlug(null), 2000);
  };

  const handleSlugSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeEvent) return;

    const clean = customSlugInput.trim().toLowerCase();
    if (!clean) {
      setSlugError('Slug cannot be empty');
      return;
    }
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(clean) || clean.length < 2 || clean.length > 64) {
      setSlugError('Slug must be 2-64 lowercase letters, numbers, and single hyphens.');
      return;
    }

    customizeSlugMutation.mutate({
      eventId: activeEvent.id,
      slug: clean,
    });
  };

  return (
    <div className="min-h-screen bg-[#FAF8F5] pb-24 selection:bg-stone-900 selection:text-white">
      {/* Top Banner & Header */}
      <div className="border-b border-stone-200/80 bg-white shadow-2xs">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-10">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-mono uppercase font-bold tracking-wider bg-amber-50 text-amber-800 border border-amber-300 shadow-2xs">
                  <Shield className="w-3 h-3 text-amber-600" />
                  Event Host Workspace
                </span>
                <span className="text-stone-300">·</span>
                <span className="text-xs font-mono text-stone-500">
                  {user?.name || user?.email}
                </span>
              </div>
              <h1 className="font-display font-black text-2xl sm:text-3xl text-stone-900 tracking-tight">
                Host Portal &amp; Private Traffic
              </h1>
              <p className="text-xs text-stone-500 max-w-xl font-sans">
                Manage your personal promotional link, track discovery traffic, and measure your promotional reach.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  refetchEvents();
                  if (activeEvent?.id) refetchAnalytics();
                }}
                disabled={isFetchingEvents || isFetchingAnalytics}
                className="p-2.5 rounded-xl border border-stone-200 bg-white hover:bg-stone-50 text-stone-600 hover:text-stone-900 transition-colors shadow-2xs cursor-pointer"
                title="Refresh Events and Analytics"
              >
                <RotateCw
                  className={`w-4 h-4 ${
                    isFetchingEvents || isFetchingAnalytics ? 'animate-spin text-stone-900' : ''
                  }`}
                />
              </button>

              <Link
                to="/events"
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl border border-stone-200 bg-white hover:bg-stone-50 text-stone-700 text-xs font-mono uppercase font-semibold tracking-wider transition-colors shadow-2xs"
              >
                <Globe className="w-3.5 h-3.5 text-stone-500" />
                <span>Explore Events</span>
              </Link>
            </div>
          </div>
        </div>
      </div>

      {/* Notification Toast */}
      {notification && (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-4">
          <div
            className={`px-4 py-3 rounded-xl text-xs font-mono flex items-center justify-between border shadow-2xs ${
              notification.type === 'success'
                ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                : 'bg-rose-50 text-rose-800 border-rose-200'
            }`}
          >
            <div className="flex items-center gap-2">
              {notification.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              ) : (
                <AlertCircle className="w-4 h-4 text-rose-600" />
              )}
              <span>{notification.message}</span>
            </div>
            <button
              type="button"
              onClick={() => setNotification(null)}
              className="text-stone-500 hover:text-stone-800 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-6 sm:pt-8">
        {/* Loading State */}
        {isLoadingEvents ? (
          <div className="bg-white rounded-2xl border border-stone-200/90 p-16 text-center space-y-3 shadow-xs">
            <RotateCw className="w-6 h-6 animate-spin text-stone-800 mx-auto" />
            <div className="text-xs font-mono text-stone-500 uppercase tracking-wider">
              Loading your host assignments...
            </div>
          </div>
        ) : isEventsError ? (
          /* Error State */
          <div className="bg-white rounded-2xl border border-rose-200 p-12 text-center space-y-4 shadow-xs">
            <div className="w-12 h-12 rounded-2xl bg-rose-50 border border-rose-200 text-rose-600 flex items-center justify-center mx-auto">
              <AlertCircle className="w-6 h-6" />
            </div>
            <div className="space-y-1">
              <h3 className="font-display font-bold text-base text-stone-900">
                Unable to Load Host Assignments
              </h3>
              <p className="text-xs text-stone-500 max-w-sm mx-auto font-sans">
                {eventsErrorMessage}
              </p>
            </div>
            <button
              type="button"
              onClick={() => refetchEvents()}
              className="px-4 py-2 rounded-xl bg-stone-900 hover:bg-black text-white text-xs font-mono uppercase font-bold tracking-wider shadow-xs"
            >
              Retry
            </button>
          </div>
        ) : assignedEvents.length === 0 ? (
          /* Empty State: No Assigned Events */
          <div className="bg-white rounded-2xl border border-stone-200/90 p-12 sm:p-16 text-center space-y-5 max-w-xl mx-auto shadow-xs">
            <div className="w-14 h-14 rounded-2xl bg-[#EFECE5] border border-[#DDD7CB] flex items-center justify-center mx-auto text-amber-700 shadow-2xs">
              <Sparkles className="w-7 h-7" />
            </div>
            <div className="space-y-2">
              <h3 className="font-display font-bold text-lg text-stone-900">
                No Assigned Host Experiences
              </h3>
              <p className="text-xs text-stone-600 leading-relaxed font-sans max-w-md mx-auto">
                You do not have any active Event Host assignments right now. When an event organizer invites you to host an experience, your personal promotional link and private traffic analytics will appear here.
              </p>
            </div>
            <div className="pt-2 flex items-center justify-center gap-3">
              <Link
                to="/events"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-stone-900 hover:bg-black text-white font-semibold text-xs font-mono uppercase tracking-wider transition-all duration-200 shadow-xs"
              >
                <Globe className="w-4 h-4" />
                Discover Public Events
              </Link>
            </div>
          </div>
        ) : (
          /* Active Host Workspace with Events */
          <div className="space-y-6">
            {/* Event Selector (if assigned to multiple events) */}
            {assignedEvents.length > 1 && (
              <div className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-none">
                <span className="text-[11px] font-mono text-stone-500 uppercase font-semibold shrink-0 pr-1">
                  Assigned Events ({assignedEvents.length}):
                </span>
                {assignedEvents.map((item) => (
                  <button
                    key={item.event.id}
                    type="button"
                    onClick={() => setSelectedEventId(item.event.id)}
                    className={`px-3.5 py-1.5 rounded-xl text-xs font-mono font-medium transition-all shrink-0 cursor-pointer shadow-2xs ${
                      activeEvent?.id === item.event.id
                        ? 'bg-stone-900 text-white font-bold'
                        : 'bg-white hover:bg-stone-100 text-stone-700 border border-stone-200'
                    }`}
                  >
                    {item.event.title}
                  </button>
                ))}
              </div>
            )}

            {/* Event Overview Card */}
            {activeEvent && (
              <div className="bg-white rounded-2xl border border-stone-200/90 overflow-hidden shadow-xs">
                <div className="p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-5 border-b border-stone-100">
                  <div className="flex items-center gap-4 min-w-0">
                    <div className="w-16 h-16 rounded-xl overflow-hidden bg-stone-100 border border-stone-200 shrink-0 relative shadow-2xs">
                      <img
                        src={
                          activeEvent.coverImageUrl ||
                          'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=400&q=80'
                        }
                        alt={activeEvent.title}
                        className="w-full h-full object-cover"
                        onError={(e) => {
                          e.currentTarget.src =
                            'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=400&q=80';
                        }}
                      />
                    </div>
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-mono uppercase font-bold bg-amber-50 text-amber-800 border border-amber-300">
                          Active Host
                        </span>
                        <span className="text-stone-300">·</span>
                        <span className="text-[11px] font-mono text-stone-400">
                          /{activeEvent.slug}
                        </span>
                      </div>
                      <h2 className="font-display font-bold text-lg text-stone-900 truncate">
                        {activeEvent.title}
                      </h2>
                      <div className="flex flex-wrap items-center gap-3 text-xs text-stone-500 font-sans">
                        <span className="flex items-center gap-1 font-mono text-[11px]">
                          <Calendar className="w-3.5 h-3.5 text-stone-400" />
                          {new Date(activeEvent.startAt).toLocaleDateString('en-US', {
                            weekday: 'short',
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric',
                          })}
                        </span>
                        <span>•</span>
                        <span className="flex items-center gap-1 font-mono text-[11px]">
                          <MapPin className="w-3.5 h-3.5 text-stone-400" />
                          {activeEvent.venueName ? `${activeEvent.venueName}, ` : ''}{activeEvent.city}
                        </span>
                      </div>
                    </div>
                  </div>

                  <Link
                    to={`/events/${activeEvent.slug}`}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl border border-stone-200 bg-stone-50 hover:bg-stone-100 text-stone-700 text-xs font-mono uppercase font-semibold tracking-wider transition-colors shadow-2xs shrink-0"
                    title="View public event page"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    <span>View Event</span>
                  </Link>
                </div>

                {/* Personal Promotional Link Section */}
                <div className="p-6 bg-[#FAF8F5]/60 border-b border-stone-200/80 space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div>
                      <h3 className="font-display font-bold text-sm text-stone-900 flex items-center gap-2">
                        <span>Your Personal Promotional Link</span>
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                      </h3>
                      <p className="text-xs text-stone-500 font-sans mt-0.5">
                        Share this link with your audience across WhatsApp, Instagram, or social media. All clicks are privately logged.
                      </p>
                    </div>

                    {activeHostLink?.status === 'ACTIVE' && (
                      <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-mono uppercase font-bold bg-emerald-50 text-emerald-800 border border-emerald-300 shrink-0">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                        Link Active
                      </span>
                    )}
                    {activeHostLink?.status === 'DISABLED' && (
                      <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-mono uppercase font-bold bg-stone-100 text-stone-600 border border-stone-200 shrink-0">
                        <span className="w-1.5 h-1.5 rounded-full bg-stone-400" />
                        Paused by Organizer
                      </span>
                    )}
                    {activeHostLink?.status === 'ARCHIVED' && (
                      <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-mono uppercase font-bold bg-rose-50 text-rose-700 border border-rose-200 shrink-0">
                        Archived
                      </span>
                    )}
                  </div>

                  {activeHostLink ? (
                    <div className="space-y-2">
                      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                        {/* Short Link Display */}
                        <div className="flex-1 flex items-center justify-between px-3.5 py-2.5 rounded-xl bg-white border border-stone-200/90 shadow-2xs font-mono text-xs">
                          <span className="text-stone-900 font-bold truncate">
                            {(() => {
                              const origin =
                                typeof window !== 'undefined' && window.location?.origin
                                  ? window.location.origin
                                  : '';
                              return origin
                                ? `${origin}/r/${activeHostLink.slug}`
                                : `/r/${activeHostLink.slug}`;
                            })()}
                          </span>
                          <span className="text-[10px] text-stone-400 uppercase font-semibold shrink-0 pl-2">
                            /r/{activeHostLink.slug}
                          </span>
                        </div>

                        {/* Copy Button */}
                        <button
                          type="button"
                          onClick={() => handleCopyLink(activeHostLink.slug)}
                          className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl bg-stone-900 hover:bg-black text-white text-xs font-mono uppercase font-bold tracking-wider transition-colors shadow-xs cursor-pointer shrink-0"
                          title="Copy Full Promotional Link"
                        >
                          {copiedSlug === activeHostLink.slug ? (
                            <>
                              <Check className="w-3.5 h-3.5 text-emerald-400" />
                              <span>Copied!</span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-3.5 h-3.5" />
                              <span>Copy Link</span>
                            </>
                          )}
                        </button>

                        {/* Customize Slug Button */}
                        <button
                          type="button"
                          onClick={() => {
                            setCustomSlugInput(activeHostLink.slug);
                            setSlugError(null);
                            setIsCustomizingSlug(true);
                          }}
                          className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl border border-stone-200 bg-white hover:bg-stone-50 text-stone-700 hover:text-stone-900 text-xs font-mono uppercase font-semibold tracking-wider transition-colors shadow-2xs cursor-pointer shrink-0"
                          title="Customize your promotional slug"
                        >
                          <Edit3 className="w-3.5 h-3.5 text-stone-500" />
                          <span>Customize Slug</span>
                        </button>
                      </div>

                      <div className="flex items-center justify-between text-[11px] font-mono text-stone-500 pt-0.5">
                        <span>
                          {activeHostLink.status === 'ACTIVE'
                            ? 'Ready to share: all clicks route directly to the event page.'
                            : activeHostLink.status === 'DISABLED'
                            ? 'This link is currently paused by the organizer.'
                            : 'This link has been archived.'}
                        </span>
                        <span className="text-stone-400">
                          Historical aliases permanently preserved
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className="p-4 rounded-xl bg-amber-50/60 border border-amber-200 text-xs text-amber-800 font-mono">
                      No active promotional link assigned to your membership yet. Please contact the event organizer.
                    </div>
                  )}
                </div>

                {/* Private Traffic Analytics Section */}
                <div className="p-6 space-y-6">
                  {/* Privacy Banner */}
                  <div className="p-3.5 rounded-xl bg-amber-50/50 border border-amber-200/80 text-xs text-amber-900 flex items-start gap-2.5">
                    <Shield className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                    <div className="space-y-0.5">
                      <span className="font-semibold block">Private Host Traffic Analytics</span>
                      <span className="text-[11px] text-amber-800 leading-relaxed block">
                        These metrics represent traffic generated exclusively by your personal promotional link. Organizer campaign traffic, ticket sales, attendee names, and financials are strictly confidential.
                      </span>
                    </div>
                  </div>

                  {/* Analytics States */}
                  {isActuallyLoadingAnalytics ? (
                    <div className="py-16 text-center text-stone-500 font-mono text-xs flex items-center justify-center gap-2">
                      <RotateCw className="w-4 h-4 animate-spin text-stone-700" />
                      <span>Loading private traffic analytics...</span>
                    </div>
                  ) : analyticsError ? (
                    <div className="py-12 text-center space-y-2 bg-stone-50 rounded-xl border border-stone-200">
                      <AlertCircle className="w-5 h-5 text-rose-600 mx-auto" />
                      <p className="text-xs text-stone-600 font-mono">
                        {analyticsError instanceof Error ? analyticsError.message : 'Failed to load traffic metrics.'}
                      </p>
                      <button
                        type="button"
                        onClick={() => refetchAnalytics()}
                        className="text-xs font-mono font-bold text-stone-900 underline"
                      >
                        Try Again
                      </button>
                    </div>
                  ) : !traffic || (traffic.totalClicks === 0 && traffic.uniqueVisitors === 0) ? (
                    /* Zero Traffic Empty State */
                    <div className="py-12 text-center space-y-3 bg-stone-50/60 rounded-xl border border-stone-200">
                      <div className="w-10 h-10 rounded-xl bg-white border border-stone-200 text-stone-400 flex items-center justify-center mx-auto shadow-2xs">
                        <TrendingUp className="w-5 h-5" />
                      </div>
                      <h4 className="font-display font-bold text-stone-900 text-sm">
                        No Traffic Recorded Yet
                      </h4>
                      <p className="text-xs text-stone-500 max-w-sm mx-auto font-sans leading-relaxed">
                        Share your promotional link on your channels to start discovering your audience. When visitors click your link, private traffic metrics will update automatically.
                      </p>
                    </div>
                  ) : (
                    /* Traffic Analytics Content */
                    <div className="space-y-6">
                      {/* KPI Cards */}
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                        {/* Total Clicks */}
                        <div className="p-4 rounded-xl bg-white border border-stone-200 shadow-2xs space-y-1">
                          <div className="flex items-center justify-between text-stone-500 text-[11px] font-mono uppercase font-semibold">
                            <span>Total Clicks</span>
                            <MousePointerClick className="w-4 h-4 text-stone-400" />
                          </div>
                          <div className="text-2xl font-display font-bold text-stone-900">
                            {traffic.totalClicks.toLocaleString()}
                          </div>
                          <span className="text-[10px] text-stone-400 font-mono block">
                            Direct visits through your link
                          </span>
                        </div>

                        {/* Unique Visitors */}
                        <div className="p-4 rounded-xl bg-white border border-stone-200 shadow-2xs space-y-1">
                          <div className="flex items-center justify-between text-stone-500 text-[11px] font-mono uppercase font-semibold">
                            <span>Unique Visitors</span>
                            <Users className="w-4 h-4 text-amber-500" />
                          </div>
                          <div className="text-2xl font-display font-bold text-stone-900">
                            {traffic.uniqueVisitors.toLocaleString()}
                          </div>
                          <span className="text-[10px] text-stone-400 font-mono block">
                            Deduplicated unique visitors
                          </span>
                        </div>

                        {/* Visits per Visitor */}
                        <div className="p-4 rounded-xl bg-white border border-stone-200 shadow-2xs space-y-1">
                          <div className="flex items-center justify-between text-stone-500 text-[11px] font-mono uppercase font-semibold">
                            <span>Visits per Visitor</span>
                            <TrendingUp className="w-4 h-4 text-stone-400" />
                          </div>
                          <div className="text-2xl font-display font-bold text-stone-900">
                            {traffic.uniqueVisitors > 0
                              ? (traffic.totalClicks / traffic.uniqueVisitors).toFixed(1)
                              : '0.0'}
                          </div>
                          <span className="text-[10px] text-stone-400 font-mono block">
                            Repeat visitor frequency
                          </span>
                        </div>
                      </div>

                      {/* Daily Discovery Trend */}
                      <div className="p-5 rounded-xl bg-white border border-stone-200 shadow-2xs space-y-4">
                        <div className="flex items-center justify-between">
                          <div>
                            <h5 className="font-display font-bold text-sm text-stone-900">
                              Daily Discovery Activity
                            </h5>
                            <p className="text-[11px] text-stone-500 font-mono">
                              Unique visitors vs clicks over time
                            </p>
                          </div>
                          <div className="flex items-center gap-3 text-[10px] font-mono uppercase">
                            <div className="flex items-center gap-1.5">
                              <span className="w-3 h-3 rounded-xs bg-stone-900" />
                              <span className="text-stone-600">Clicks</span>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <span className="w-3 h-3 rounded-xs bg-amber-400" />
                              <span className="text-stone-600">Unique Visitors</span>
                            </div>
                          </div>
                        </div>

                        {traffic.dailyVisits.length === 0 ? (
                          <div className="py-8 text-center text-xs font-mono text-stone-400">
                            No daily activity recorded.
                          </div>
                        ) : (
                          <div className="space-y-2 pt-2">
                            {(() => {
                              const maxClicks = Math.max(
                                ...traffic.dailyVisits.map((d) => d.clicks),
                                1
                              );
                              return (
                                <div className="flex items-end gap-2 h-44 border-b border-stone-100 pb-2 px-1 overflow-x-auto">
                                  {traffic.dailyVisits.map((d: DailyTrafficItem) => {
                                    const clickPercent = Math.min(
                                      100,
                                      Math.round((d.clicks / maxClicks) * 100)
                                    );
                                    const visitorPercent = Math.min(
                                      100,
                                      Math.round((d.uniqueVisitors / maxClicks) * 100)
                                    );
                                    const formattedDate = new Date(d.date).toLocaleDateString(
                                      'en-US',
                                      {
                                        month: 'short',
                                        day: 'numeric',
                                        timeZone: 'UTC',
                                      }
                                    );

                                    return (
                                      <div
                                        key={d.date}
                                        className="flex-1 min-w-[36px] flex flex-col items-center gap-1.5 h-full justify-end group relative"
                                      >
                                        {/* Hover Tooltip */}
                                        <div className="absolute -top-12 z-20 hidden group-hover:flex flex-col items-center pointer-events-none">
                                          <div className="bg-stone-900 text-white text-[10px] font-mono px-2 py-1 rounded shadow-lg whitespace-nowrap">
                                            <span>{formattedDate}</span>: {d.clicks} clicks · {d.uniqueVisitors} visitors
                                          </div>
                                          <div className="w-2 h-2 bg-stone-900 rotate-45 -mt-1" />
                                        </div>

                                        {/* Dual Bars */}
                                        <div className="w-full flex items-end justify-center gap-1 h-32">
                                          <div
                                            className="w-2.5 bg-stone-900 rounded-t-sm transition-all group-hover:bg-black"
                                            style={{ height: `${Math.max(4, clickPercent)}%` }}
                                            title={`${d.clicks} clicks`}
                                          />
                                          <div
                                            className="w-2.5 bg-amber-400 rounded-t-sm transition-all group-hover:bg-amber-500"
                                            style={{ height: `${Math.max(4, visitorPercent)}%` }}
                                            title={`${d.uniqueVisitors} unique visitors`}
                                          />
                                        </div>

                                        {/* Date Label */}
                                        <span className="text-[9px] font-mono text-stone-500 truncate max-w-full">
                                          {formattedDate}
                                        </span>
                                      </div>
                                    );
                                  })}
                                </div>
                              );
                            })()}
                          </div>
                        )}
                      </div>

                      {/* Top Traffic Referrers */}
                      <div className="p-5 rounded-xl bg-white border border-stone-200 shadow-2xs space-y-3">
                        <div className="flex items-center gap-2">
                          <Globe className="w-4 h-4 text-stone-600" />
                          <h6 className="font-display font-bold text-xs text-stone-900">
                            Top Traffic Channels &amp; Referrers
                          </h6>
                        </div>
                        {traffic.topReferrers.length === 0 ? (
                          <p className="text-xs text-stone-400 font-mono py-2">
                            No external referrers captured.
                          </p>
                        ) : (
                          <div className="space-y-2">
                            {traffic.topReferrers.map((ref) => {
                              const percent =
                                traffic.totalClicks > 0
                                  ? Math.round((ref.clicks / traffic.totalClicks) * 100)
                                  : 0;
                              return (
                                <div key={ref.referrer} className="space-y-1">
                                  <div className="flex items-center justify-between text-xs font-mono">
                                    <span className="text-stone-800 truncate max-w-[240px]">
                                      {ref.referrer}
                                    </span>
                                    <span className="text-stone-500 font-bold">
                                      {ref.clicks} <span className="font-normal text-stone-400">({percent}%)</span>
                                    </span>
                                  </div>
                                  <div className="h-1.5 w-full bg-stone-100 rounded-full overflow-hidden">
                                    <div
                                      className="h-full bg-stone-800 rounded-full"
                                      style={{ width: `${percent}%` }}
                                    />
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* =========================================================================
          CUSTOMIZE SLUG MODAL
         ========================================================================= */}
      {isCustomizingSlug && activeEvent && activeHostLink && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="max-w-md w-full bg-white rounded-2xl border border-stone-200 p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-stone-100 pb-3">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-stone-900 text-white flex items-center justify-center">
                  <Edit3 className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="font-display font-bold text-sm text-stone-900">
                    Customize Personal Slug
                  </h3>
                  <span className="text-[10px] font-mono text-stone-500">
                    {activeEvent.title}
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setIsCustomizingSlug(false);
                  setSlugError(null);
                }}
                className="p-1 rounded-lg text-stone-400 hover:text-stone-700 hover:bg-stone-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSlugSubmit} className="space-y-4">
              <div className="space-y-1">
                <span className="text-[11px] font-mono text-stone-500 block">
                  Current Primary Slug:
                </span>
                <span className="text-xs font-mono font-bold text-stone-800 bg-stone-100 px-2 py-0.5 rounded">
                  /r/{activeHostLink.slug}
                </span>
              </div>

              {/* Permanent Alias Guarantee */}
              <div className="p-3 rounded-xl bg-amber-50/60 border border-amber-200 text-xs text-amber-900 flex items-start gap-2">
                <Sparkles className="w-3.5 h-3.5 text-amber-600 shrink-0 mt-0.5" />
                <p className="text-[11px] text-amber-800 leading-relaxed font-sans">
                  <strong>Alias Guarantee:</strong> Your previous slug (<strong>/r/{activeHostLink.slug}</strong>) will permanently remain active and continue routing to this event. Existing social media posts or QR codes will not break.
                </p>
              </div>

              <div className="space-y-1.5">
                <label className="text-[11px] font-mono text-stone-600 uppercase font-semibold block">
                  New Primary Slug *
                </label>
                <div className="relative">
                  <span className="text-xs font-mono text-stone-400 absolute left-3 top-1/2 -translate-y-1/2">
                    /r/
                  </span>
                  <input
                    type="text"
                    required
                    value={customSlugInput}
                    onChange={(e) => {
                      setCustomSlugInput(e.target.value);
                      setSlugError(null);
                    }}
                    placeholder="my-custom-vip-slug"
                    className="w-full pl-9 pr-3 py-2 rounded-xl border border-stone-200 text-xs font-mono text-stone-900 placeholder:text-stone-400 focus:outline-none focus:border-stone-900 shadow-2xs"
                  />
                </div>
                {slugError && (
                  <p className="text-[11px] font-mono text-rose-600 flex items-center gap-1">
                    <AlertCircle className="w-3 h-3 shrink-0" />
                    <span>{slugError}</span>
                  </p>
                )}
                <span className="text-[10px] text-stone-400 font-mono block">
                  Must be 2-64 lowercase letters, numbers, and single hyphens.
                </span>
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setIsCustomizingSlug(false);
                    setSlugError(null);
                  }}
                  disabled={customizeSlugMutation.isPending}
                  className="px-4 py-2 rounded-xl border border-stone-200 text-xs font-mono text-stone-600 hover:text-stone-900 hover:bg-stone-50 transition-colors shadow-2xs cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={customizeSlugMutation.isPending}
                  className="px-4 py-2 rounded-xl bg-stone-900 hover:bg-black text-white font-semibold text-xs font-mono uppercase tracking-wider transition-colors shadow-xs disabled:opacity-50 cursor-pointer"
                >
                  {customizeSlugMutation.isPending ? 'Saving Slug...' : 'Save Primary Slug'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
