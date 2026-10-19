import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { api } from '../lib/api';
import { OrganizerEventItem } from '../types';
import {
  Plus,
  Calendar,
  Ticket,
  TrendingUp,
  Eye,
  Edit3,
  Trash2,
  Radio,
  Clock,
  MapPin,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  ShieldCheck,
  Search,
  RefreshCw,
  X,
  Sparkles,
} from 'lucide-react';

export const OrganizerDashboardPage: React.FC = () => {
  const { user, quickLoginAs } = useAuth();
  const queryClient = useQueryClient();

  // Sync body background with page theme to prevent bounce discoloration
  useEffect(() => {
    const originalBg = document.body.style.backgroundColor;
    document.body.style.backgroundColor = '#FAF8F5';
    return () => {
      document.body.style.backgroundColor = originalBg;
    };
  }, []);

  const [filterStatus, setFilterStatus] = useState<'ALL' | 'PUBLISHED' | 'DRAFT'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [notification, setNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [eventToDelete, setEventToDelete] = useState<OrganizerEventItem | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const showNotification = (type: 'success' | 'error', message: string) => {
    setNotification({ type, message });
    setTimeout(() => setNotification(null), 4000);
  };

  // 1. Fetch Dashboard Stats
  const {
    data: stats,
    isLoading: isLoadingStats,
    refetch: refetchStats,
  } = useQuery({
    queryKey: ['organizer-dashboard'],
    queryFn: () => api.organizer.getDashboard(),
    enabled: Boolean(user && (user.role === 'ORGANIZER' || user.role === 'ADMIN')),
  });

  // 2. Fetch Organizer Events
  const {
    data: eventsData,
    isLoading: isLoadingEvents,
    refetch: refetchEvents,
  } = useQuery({
    queryKey: ['organizer-events'],
    queryFn: () => api.organizer.listEvents(),
    enabled: Boolean(user && (user.role === 'ORGANIZER' || user.role === 'ADMIN')),
  });

  // Mutations for publish & unpublish
  const publishMutation = useMutation({
    mutationFn: (eventId: string) => api.organizer.publishEvent(eventId),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['organizer-dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['organizer-events'] });
      queryClient.invalidateQueries({ queryKey: ['events'] });
      showNotification('success', data.message || 'Event published to Outside.vip discovery!');
    },
    onError: (err: any) => {
      showNotification('error', err?.message || 'Failed to publish event. Ensure all required fields and ticket tiers are valid.');
    },
  });

  const unpublishMutation = useMutation({
    mutationFn: (eventId: string) => api.organizer.unpublishEvent(eventId),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['organizer-dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['organizer-events'] });
      queryClient.invalidateQueries({ queryKey: ['events'] });
      showNotification('success', data.message || 'Event reverted to draft status.');
    },
    onError: (err: any) => {
      showNotification('error', err?.message || 'Failed to unpublish event.');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (eventId: string) => api.organizer.deleteEvent(eventId),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['organizer-dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['organizer-events'] });
      setEventToDelete(null);
      setIsDeleting(false);
      showNotification('success', data.message || 'Event deleted successfully.');
    },
    onError: (err: any) => {
      setIsDeleting(false);
      showNotification('error', err?.message || 'Failed to delete event. Events with sold tickets cannot be deleted.');
    },
  });

  const handleDeleteConfirm = () => {
    if (!eventToDelete) return;
    setIsDeleting(true);
    deleteMutation.mutate(eventToDelete.id);
  };

  // Auth gate if user is not logged in or not an organizer
  if (!user || (user.role !== 'ORGANIZER' && user.role !== 'ADMIN')) {
    return (
      <div className="min-h-screen bg-[#FAF8F5] text-stone-900 flex items-center justify-center p-4 selection:bg-stone-900 selection:text-white">
        <div className="max-w-md w-full bg-white border border-stone-200/90 rounded-2xl p-8 space-y-6 text-center shadow-xs">
          <div className="w-14 h-14 rounded-2xl bg-[#EFECE5] border border-[#DDD7CB] flex items-center justify-center mx-auto text-stone-800 shadow-2xs">
            <ShieldCheck className="w-7 h-7" />
          </div>
          <div className="space-y-2">
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#EFECE5]/80 border border-[#DDD7CB]/70 text-[#7A7165] text-[10px] font-mono uppercase tracking-[0.22em] font-bold">
              <span className="w-1.5 h-1.5 rounded-full bg-[#96846D]" />
              <span>Organizer Portal</span>
            </div>
            <h1 className="font-display font-extrabold text-2xl tracking-tight text-stone-900">
              Organizer Access Required
            </h1>
            <p className="text-xs text-stone-600 leading-relaxed font-sans">
              Sign in with an organizer account to access your command center, create events, and configure ticket tiers.
            </p>
          </div>

          <div className="space-y-3 pt-2">
            <button
              onClick={async () => {
                await quickLoginAs('organizer');
                refetchStats();
                refetchEvents();
              }}
              className="w-full py-3 px-4 rounded-xl bg-stone-900 hover:bg-black text-white font-semibold text-xs font-mono uppercase tracking-wider transition-all duration-200 shadow-xs flex items-center justify-center gap-2"
            >
              <Sparkles className="w-4 h-4 text-stone-300" />
              Sign in as Sol Collective (Organizer Demo)
            </button>
            <Link
              to="/"
              className="block w-full py-2.5 px-4 rounded-xl border border-stone-200 hover:border-stone-300 hover:bg-stone-50 text-xs font-mono text-stone-600 hover:text-stone-900 transition-colors"
            >
              Return to Public Discovery
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const rawEvents = eventsData?.events || [];
  const filteredEvents = rawEvents.filter((evt) => {
    if (filterStatus === 'PUBLISHED' && evt.status !== 'PUBLISHED') return false;
    if (filterStatus === 'DRAFT' && evt.status !== 'DRAFT') return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchTitle = evt.title.toLowerCase().includes(q);
      const matchCity = evt.city.toLowerCase().includes(q);
      const matchVenue = evt.venueName.toLowerCase().includes(q);
      return matchTitle || matchCity || matchVenue;
    }
    return true;
  });

  return (
    <div className="relative min-h-screen bg-[#FAF8F5] text-stone-900 selection:bg-stone-900 selection:text-white overflow-x-hidden">
      {/* Subtle Background Graphic Contours (matching Outside.vip visual language) */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden select-none" aria-hidden="true">
        {/* Top-Left Topographic Contour Waves */}
        <svg
          className="absolute -top-10 -left-10 w-80 sm:w-96 h-80 sm:h-96 opacity-25 text-[#D8D2C5]"
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
          className="absolute -top-6 -right-10 w-72 sm:w-88 h-72 sm:h-88 opacity-20 text-[#D8D2C5]"
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
        <div className="absolute top-10 left-6 sm:left-12 grid grid-cols-4 gap-2 opacity-30 text-stone-400 font-mono text-[9px]">
          {Array.from({ length: 16 }).map((_, i) => (
            <span key={i}>+</span>
          ))}
        </div>
      </div>

      {/* Top Banner Notifications */}
      {notification && (
        <div className="fixed top-20 right-4 z-50 max-w-md animate-in slide-in-from-top-2">
          <div
            className={`p-4 rounded-xl border text-xs font-medium flex items-center gap-3 shadow-xl backdrop-blur-md ${
              notification.type === 'success'
                ? 'bg-white/95 border-emerald-300 text-stone-900'
                : 'bg-white/95 border-rose-300 text-stone-900'
            }`}
          >
            {notification.type === 'success' ? (
              <CheckCircle2 className="w-5 h-5 shrink-0 text-emerald-600" />
            ) : (
              <AlertCircle className="w-5 h-5 shrink-0 text-rose-600" />
            )}
            <div className="flex-1 text-stone-800">{notification.message}</div>
            <button
              onClick={() => setNotification(null)}
              className="text-stone-400 hover:text-stone-700"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Main Wide Container */}
      <div className="relative z-10 max-w-[1536px] mx-auto px-4 sm:px-6 lg:px-8 xl:px-10 py-8 sm:py-10 space-y-8">
        {/* Top Header Bar */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-6 border-b border-stone-200/90">
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#EFECE5]/80 border border-[#DDD7CB]/70 text-[#7A7165] text-[10px] sm:text-[11px] font-mono uppercase tracking-[0.22em] font-bold shadow-xs">
                <span className="w-1.5 h-1.5 rounded-full bg-[#96846D]" />
                <span>Organizer Workspace</span>
                <span className="text-stone-400">•</span>
                <span className="text-stone-600 font-medium">
                  {user.organizer?.displayName || user.name}
                </span>
              </div>
            </div>
            <h1 className="font-display font-extrabold text-2xl sm:text-3xl lg:text-4xl text-stone-900 tracking-tight">
              Event Management & Inventory
            </h1>
            <p className="text-xs sm:text-sm text-stone-600 mt-1 max-w-2xl font-sans">
              Create and manage event drafts, configure multi-tier ticket capacity, and monitor live sales performance across Kenya.
            </p>
          </div>

          <div className="flex items-center gap-3 w-full sm:w-auto">
            <button
              onClick={() => {
                refetchStats();
                refetchEvents();
              }}
              className="p-2.5 rounded-xl bg-white hover:bg-stone-100 text-stone-600 hover:text-stone-900 border border-stone-200/90 shadow-2xs transition-colors"
              title="Refresh data"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
            <Link
              to="/organizer/events/new"
              className="flex-1 sm:flex-none inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-stone-900 hover:bg-black text-white font-semibold text-xs sm:text-sm font-mono uppercase tracking-wider transition-all duration-200 shadow-xs hover:shadow-sm"
            >
              <Plus className="w-4 h-4" />
              Create Event
            </Link>
          </div>
        </div>

        {/* Real Summary Metrics Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3.5 sm:gap-4">
          {/* 1. Total Events */}
          <div className="p-4 sm:p-5 rounded-2xl bg-white border border-stone-200/90 shadow-xs hover:border-stone-300 transition-colors space-y-2">
            <div className="flex items-center justify-between text-stone-500">
              <span className="text-[10px] sm:text-[11px] font-mono uppercase tracking-wider font-semibold">
                Total Events
              </span>
              <Calendar className="w-4 h-4 text-stone-400" />
            </div>
            <div className="font-display font-black text-2xl sm:text-3xl text-stone-900">
              {isLoadingStats ? '—' : stats?.totalEvents ?? 0}
            </div>
            <div className="text-[11px] font-mono text-stone-400">
              Across all lifecycles
            </div>
          </div>

          {/* 2. Published */}
          <div className="p-4 sm:p-5 rounded-2xl bg-white border border-stone-200/90 shadow-xs hover:border-stone-300 transition-colors space-y-2">
            <div className="flex items-center justify-between text-stone-500">
              <span className="text-[10px] sm:text-[11px] font-mono uppercase tracking-wider font-semibold">
                Live Published
              </span>
              <Radio className="w-4 h-4 text-emerald-600" />
            </div>
            <div className="font-display font-black text-2xl sm:text-3xl text-emerald-800">
              {isLoadingStats ? '—' : stats?.publishedEvents ?? 0}
            </div>
            <div className="text-[11px] font-mono text-stone-400">
              Visible on discovery
            </div>
          </div>

          {/* 3. Drafts */}
          <div className="p-4 sm:p-5 rounded-2xl bg-white border border-stone-200/90 shadow-xs hover:border-stone-300 transition-colors space-y-2">
            <div className="flex items-center justify-between text-stone-500">
              <span className="text-[10px] sm:text-[11px] font-mono uppercase tracking-wider font-semibold">
                Drafts
              </span>
              <Clock className="w-4 h-4 text-amber-600" />
            </div>
            <div className="font-display font-black text-2xl sm:text-3xl text-amber-800">
              {isLoadingStats ? '—' : stats?.draftEvents ?? 0}
            </div>
            <div className="text-[11px] font-mono text-stone-400">
              Unpublished workflows
            </div>
          </div>

          {/* 4. Tickets Sold */}
          <div className="p-4 sm:p-5 rounded-2xl bg-white border border-stone-200/90 shadow-xs hover:border-stone-300 transition-colors space-y-2">
            <div className="flex items-center justify-between text-stone-500">
              <span className="text-[10px] sm:text-[11px] font-mono uppercase tracking-wider font-semibold">
                Tickets Sold
              </span>
              <Ticket className="w-4 h-4 text-stone-400" />
            </div>
            <div className="font-display font-black text-2xl sm:text-3xl text-stone-900">
              {isLoadingStats ? '—' : (stats?.ticketsSold ?? 0).toLocaleString()}
            </div>
            <div className="text-[11px] font-mono text-stone-400">
              Actual database sales
            </div>
          </div>

          {/* 5. Revenue */}
          <div className="col-span-2 sm:col-span-3 lg:col-span-1 p-4 sm:p-5 rounded-2xl bg-white border border-stone-200/90 shadow-xs hover:border-stone-300 transition-colors space-y-2">
            <div className="flex items-center justify-between text-stone-500">
              <span className="text-[10px] sm:text-[11px] font-mono uppercase tracking-wider font-semibold">
                Recorded Revenue
              </span>
              <TrendingUp className="w-4 h-4 text-emerald-600" />
            </div>
            <div className="font-display font-black text-2xl sm:text-3xl text-stone-900 truncate">
              {isLoadingStats ? '—' : stats?.grossRevenueFormatted ?? '$0'}
            </div>
            <div className="text-[11px] font-mono text-stone-400">
              Completed transactions
            </div>
          </div>
        </div>

        {/* Filter and Search Bar */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 pt-2">
          {/* Status Tabs */}
          <div className="flex items-center p-1 rounded-xl bg-[#EFECE5]/80 border border-[#DDD7CB]/80 text-xs font-mono shadow-2xs">
            <button
              onClick={() => setFilterStatus('ALL')}
              className={`px-3.5 py-1.5 rounded-lg transition-all font-semibold ${
                filterStatus === 'ALL'
                  ? 'bg-white text-stone-900 shadow-xs border border-stone-200/80 font-bold'
                  : 'text-stone-600 hover:text-stone-900'
              }`}
            >
              All ({rawEvents.length})
            </button>
            <button
              onClick={() => setFilterStatus('PUBLISHED')}
              className={`px-3.5 py-1.5 rounded-lg transition-all flex items-center gap-1.5 font-semibold ${
                filterStatus === 'PUBLISHED'
                  ? 'bg-white text-emerald-800 shadow-xs border border-emerald-200/80 font-bold'
                  : 'text-stone-600 hover:text-stone-900'
              }`}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-600" />
              Published ({rawEvents.filter((e) => e.status === 'PUBLISHED').length})
            </button>
            <button
              onClick={() => setFilterStatus('DRAFT')}
              className={`px-3.5 py-1.5 rounded-lg transition-all flex items-center gap-1.5 font-semibold ${
                filterStatus === 'DRAFT'
                  ? 'bg-white text-amber-800 shadow-xs border border-amber-200/80 font-bold'
                  : 'text-stone-600 hover:text-stone-900'
              }`}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
              Drafts ({rawEvents.filter((e) => e.status === 'DRAFT').length})
            </button>
          </div>

          {/* Search box */}
          <div className="relative w-full sm:w-80">
            <Search className="w-4 h-4 text-stone-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Filter by title, venue, or city..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-4 py-2 rounded-xl bg-white border border-stone-200 text-xs text-stone-900 placeholder-stone-400 focus:outline-none focus:border-stone-900 focus:ring-1 focus:ring-stone-900 transition-colors font-sans shadow-2xs"
            />
          </div>
        </div>

        {/* Events Table Container (Expanded Desktop Width & Fluid Responsiveness) */}
        <div className="bg-white rounded-2xl border border-stone-200/90 overflow-hidden shadow-xs">
          {isLoadingEvents ? (
            <div className="p-16 text-center space-y-3">
              <RefreshCw className="w-6 h-6 animate-spin text-stone-800 mx-auto" />
              <div className="text-xs font-mono text-stone-500 uppercase tracking-wider">
                Loading your experiences...
              </div>
            </div>
          ) : filteredEvents.length === 0 ? (
            /* Empty State */
            <div className="p-12 sm:p-16 text-center space-y-5 max-w-lg mx-auto">
              <div className="w-14 h-14 rounded-2xl bg-[#EFECE5] border border-[#DDD7CB] flex items-center justify-center mx-auto text-stone-700 shadow-2xs">
                <Sparkles className="w-7 h-7" />
              </div>
              <div className="space-y-1.5">
                <h3 className="font-display font-bold text-lg text-stone-900">
                  {rawEvents.length === 0
                    ? 'No events created yet'
                    : 'No matching events found'}
                </h3>
                <p className="text-xs text-stone-600 leading-relaxed font-sans">
                  {rawEvents.length === 0
                    ? 'Begin by creating your first event draft. You can configure multiple ticket tiers, set capacity, and preview the experience before publishing.'
                    : 'Try clearing your search query or switching the status filter.'}
                </p>
              </div>
              {rawEvents.length === 0 ? (
                <Link
                  to="/organizer/events/new"
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-stone-900 hover:bg-black text-white font-semibold text-xs font-mono uppercase tracking-wider transition-all duration-200 shadow-xs"
                >
                  <Plus className="w-4 h-4" />
                  Create First Event Draft
                </Link>
              ) : (
                <button
                  onClick={() => {
                    setFilterStatus('ALL');
                    setSearchQuery('');
                  }}
                  className="px-4 py-2 rounded-xl border border-stone-200 text-xs font-mono text-stone-600 hover:text-stone-900 hover:bg-stone-50 shadow-2xs transition-colors"
                >
                  Reset Filters
                </button>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto min-w-full overscroll-x-contain">
              <table className="w-full text-left text-xs border-collapse min-w-[1020px] lg:min-w-full">
                <thead className="bg-[#FAF8F5]/80 text-stone-500 font-mono uppercase tracking-wider border-b border-stone-200/90 text-[11px] font-bold select-none">
                  <tr>
                    <th className="px-6 py-4 w-[28%] min-w-[280px]">Event</th>
                    <th className="px-6 py-4 w-[22%] min-w-[210px]">Schedule &amp; Location</th>
                    <th className="px-6 py-4 w-[12%] min-w-[120px]">Status</th>
                    <th className="px-6 py-4 w-[16%] min-w-[160px]">Tickets Sold</th>
                    <th className="px-6 py-4 w-[10%] min-w-[110px]">Revenue</th>
                    <th className="px-6 py-4 w-[12%] min-w-[170px] text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {filteredEvents.map((evt) => {
                    const isPublished = evt.status === 'PUBLISHED';
                    const sold = evt.ticketsSold || 0;
                    const capacity = evt.totalCapacity || 1;
                    const percent = Math.min(100, Math.round((sold / capacity) * 100));

                    return (
                      <tr
                        key={evt.id}
                        className="hover:bg-stone-50/70 transition-colors group"
                      >
                        {/* Event Thumbnail & Title */}
                        <td className="px-6 py-4.5 align-middle">
                          <div className="flex items-center gap-3.5">
                            <div className="w-14 h-14 rounded-xl overflow-hidden bg-stone-100 border border-stone-200/80 shrink-0 relative shadow-2xs">
                              <img
                                src={evt.coverImageUrl}
                                alt={evt.title}
                                className="w-full h-full object-cover"
                                onError={(e) => {
                                  e.currentTarget.src =
                                    'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=400&q=80';
                                }}
                              />
                            </div>
                            <div className="space-y-1 min-w-0">
                              <div className="font-bold text-stone-900 text-sm truncate max-w-sm xl:max-w-md group-hover:text-stone-700 transition-colors">
                                {evt.title}
                              </div>
                              <div className="flex items-center gap-2 text-[11px] font-mono text-stone-400">
                                <span className="px-2 py-0.5 rounded-full bg-[#EFECE5] border border-[#DDD7CB]/70 text-[#7A7165] font-semibold text-[10px] uppercase tracking-wider">
                                  {evt.category}
                                </span>
                                <span>•</span>
                                <span className="truncate max-w-[200px]">
                                  /{evt.slug}
                                </span>
                              </div>
                            </div>
                          </div>
                        </td>

                        {/* Date & Location */}
                        <td className="px-6 py-4.5 align-middle text-stone-700">
                          <div className="space-y-1">
                            <div className="font-semibold text-stone-900 flex items-center gap-1.5 whitespace-nowrap">
                              <Calendar className="w-3.5 h-3.5 text-stone-400 shrink-0" />
                              {new Date(evt.startAt).toLocaleDateString('en-US', {
                                weekday: 'short',
                                month: 'short',
                                day: 'numeric',
                                year: 'numeric',
                              })}
                            </div>
                            <div className="text-[11px] text-stone-500 flex items-center gap-1.5 truncate max-w-[240px]">
                              <MapPin className="w-3.5 h-3.5 text-stone-400 shrink-0" />
                              <span className="truncate">
                                {evt.venueName ? `${evt.venueName}, ` : ''}{evt.city}
                              </span>
                            </div>
                          </div>
                        </td>

                        {/* Status Badge */}
                        <td className="px-6 py-4.5 align-middle">
                          {isPublished ? (
                            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-mono uppercase tracking-wider font-bold bg-emerald-50 text-emerald-800 border border-emerald-300/80 shadow-2xs">
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-600" />
                              Published
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-mono uppercase tracking-wider font-bold bg-amber-50 text-amber-800 border border-amber-300/80 shadow-2xs">
                              <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                              Draft
                            </span>
                          )}
                        </td>

                        {/* Inventory / Tickets Sold */}
                        <td className="px-6 py-4.5 align-middle">
                          <div className="space-y-1.5 max-w-[180px]">
                            <div className="flex justify-between font-mono text-[11px]">
                              <span className="text-stone-900 font-bold">
                                {sold} sold
                              </span>
                              <span className="text-stone-400 font-normal">
                                / {capacity}
                              </span>
                            </div>
                            <div className="w-full h-1.5 rounded-full bg-stone-100 border border-stone-200/60 overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all ${
                                  percent >= 100
                                    ? 'bg-rose-500'
                                    : percent > 75
                                    ? 'bg-amber-500'
                                    : 'bg-stone-900'
                                }`}
                                style={{ width: `${percent}%` }}
                              />
                            </div>
                          </div>
                        </td>

                        {/* Real Revenue */}
                        <td className="px-6 py-4.5 align-middle font-mono font-bold text-sm text-stone-900 whitespace-nowrap">
                          {evt.revenueFormatted || '$0'}
                        </td>

                        {/* Actions */}
                        <td className="px-6 py-4.5 align-middle text-right">
                          <div className="flex items-center justify-end gap-1.5 whitespace-nowrap">
                            {/* Preview Mode */}
                            <Link
                              to={`/organizer/events/${evt.id}/preview`}
                              className="p-2 rounded-lg bg-stone-100/80 hover:bg-stone-200/80 text-stone-600 hover:text-stone-900 border border-stone-200/90 transition-colors shadow-2xs"
                              title="Preview Event (Organizer Mode)"
                            >
                              <Eye className="w-3.5 h-3.5" />
                            </Link>

                            {/* Edit Event */}
                            <Link
                              to={`/organizer/events/${evt.id}/edit`}
                              className="p-2 rounded-lg bg-stone-100/80 hover:bg-stone-200/80 text-stone-600 hover:text-stone-900 border border-stone-200/90 transition-colors shadow-2xs"
                              title="Edit Event & Ticket Tiers"
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                            </Link>

                            {/* Publish / Unpublish Action Button */}
                            {isPublished ? (
                              <button
                                onClick={() => unpublishMutation.mutate(evt.id)}
                                disabled={unpublishMutation.isPending}
                                className="px-3 py-1.5 rounded-lg bg-white hover:bg-stone-100 text-stone-700 hover:text-stone-900 border border-stone-300 text-[11px] font-mono uppercase font-semibold tracking-wider transition-colors shadow-2xs disabled:opacity-50"
                                title="Unpublish event (hide from discovery)"
                              >
                                Unpublish
                              </button>
                            ) : (
                              <button
                                onClick={() => publishMutation.mutate(evt.id)}
                                disabled={publishMutation.isPending}
                                className="px-3 py-1.5 rounded-lg bg-stone-900 hover:bg-black text-white text-[11px] font-mono uppercase font-semibold tracking-wider transition-colors shadow-2xs disabled:opacity-50"
                                title="Publish event to Outside.vip"
                              >
                                Publish
                              </button>
                            )}

                            {/* View Live (if published) */}
                            {isPublished && (
                              <Link
                                to={`/events/${evt.slug}`}
                                className="p-2 rounded-lg bg-stone-100/80 hover:bg-stone-200/80 text-stone-600 hover:text-stone-900 border border-stone-200/90 transition-colors shadow-2xs"
                                title="View Live Public Event"
                              >
                                <ExternalLink className="w-3.5 h-3.5" />
                              </Link>
                            )}

                            {/* Delete Draft (only if draft and 0 sold) */}
                            {!isPublished && sold === 0 && (
                              <button
                                onClick={() => setEventToDelete(evt)}
                                className="p-2 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 hover:text-rose-900 border border-rose-200 transition-colors shadow-2xs"
                                title="Delete Draft Event"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Confirmation Modal for Delete */}
      {eventToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-stone-950/40 backdrop-blur-sm animate-in fade-in">
          <div className="max-w-md w-full bg-white border border-stone-200/90 rounded-2xl p-6 space-y-4 shadow-2xl">
            <div className="flex items-center gap-3 text-rose-600">
              <div className="w-10 h-10 rounded-xl bg-rose-50 border border-rose-200 flex items-center justify-center">
                <Trash2 className="w-5 h-5 text-rose-600" />
              </div>
              <div>
                <h3 className="font-display font-bold text-base text-stone-900">
                  Delete Draft Event?
                </h3>
                <span className="text-[11px] font-mono text-stone-500">
                  This action cannot be undone.
                </span>
              </div>
            </div>

            <p className="text-xs text-stone-600 leading-relaxed font-sans">
              Are you sure you want to permanently delete{' '}
              <strong className="text-stone-900">"{eventToDelete.title}"</strong> and all its associated draft ticket tiers?
            </p>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setEventToDelete(null)}
                disabled={isDeleting}
                className="px-4 py-2 rounded-xl border border-stone-200 text-xs font-mono text-stone-600 hover:text-stone-900 hover:bg-stone-50 transition-colors shadow-2xs"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeleteConfirm}
                disabled={isDeleting}
                className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-semibold text-xs font-mono uppercase tracking-wider transition-colors shadow-xs disabled:opacity-50"
              >
                {isDeleting ? 'Deleting...' : 'Confirm Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
