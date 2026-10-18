import React, { useState } from 'react';
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
      <div className="min-h-screen bg-[#08090C] text-white flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-[#0E1015] border border-white/10 rounded-2xl p-8 space-y-6 text-center shadow-2xl">
          <div className="w-16 h-16 rounded-2xl bg-[#D2FF00]/10 border border-[#D2FF00]/20 flex items-center justify-center mx-auto text-[#D2FF00]">
            <ShieldCheck className="w-8 h-8" />
          </div>
          <div className="space-y-2">
            <div className="text-xs font-mono uppercase tracking-widest text-[#D2FF00] font-semibold">
              Organizer Portal
            </div>
            <h1 className="font-display font-bold text-2xl tracking-tight text-white">
              Organizer Access Required
            </h1>
            <p className="text-xs text-gray-400 leading-relaxed">
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
              className="w-full py-3 px-4 rounded-xl bg-[#D2FF00] hover:bg-[#BEF200] text-black font-semibold text-sm transition-all duration-200 shadow-[0_0_20px_rgba(210,255,0,0.25)] flex items-center justify-center gap-2"
            >
              <Sparkles className="w-4 h-4 text-black" />
              Sign in as Sol Collective (Organizer Demo)
            </button>
            <Link
              to="/"
              className="block w-full py-2.5 px-4 rounded-xl border border-white/10 hover:border-white/20 text-xs font-mono text-gray-400 hover:text-white transition-colors"
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
    <div className="min-h-screen bg-[#08090C] text-gray-100 selection:bg-[#D2FF00] selection:text-black">
      {/* Top Banner Notifications */}
      {notification && (
        <div className="fixed top-20 right-4 z-50 max-w-md animate-in slide-in-from-top-2">
          <div
            className={`p-4 rounded-xl border text-xs font-medium flex items-center gap-3 shadow-2xl backdrop-blur-md ${
              notification.type === 'success'
                ? 'bg-[#0E1015]/95 border-[#D2FF00]/40 text-[#D2FF00]'
                : 'bg-[#0E1015]/95 border-rose-500/40 text-rose-300'
            }`}
          >
            {notification.type === 'success' ? (
              <CheckCircle2 className="w-5 h-5 shrink-0 text-[#D2FF00]" />
            ) : (
              <AlertCircle className="w-5 h-5 shrink-0 text-rose-400" />
            )}
            <div className="flex-1 text-white">{notification.message}</div>
            <button
              onClick={() => setNotification(null)}
              className="text-gray-400 hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Main Container */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12 space-y-8">
        {/* Top Header Bar */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-6 border-b border-white/10">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="w-2 h-2 rounded-full bg-[#D2FF00] animate-pulse" />
              <span className="text-[11px] font-mono uppercase tracking-widest text-[#D2FF00] font-bold">
                Organizer Workspace
              </span>
              <span className="text-gray-600">•</span>
              <span className="text-xs text-gray-400 font-mono">
                {user.organizer?.displayName || user.name}
              </span>
            </div>
            <h1 className="font-display font-extrabold text-2xl sm:text-3xl text-white tracking-tight">
              Event Management & Inventory
            </h1>
            <p className="text-xs sm:text-sm text-gray-400 mt-1 max-w-2xl">
              Create and manage event drafts, configure multi-tier ticket capacity, and monitor live sales performance across Kenya.
            </p>
          </div>

          <div className="flex items-center gap-3 w-full sm:w-auto">
            <button
              onClick={() => {
                refetchStats();
                refetchEvents();
              }}
              className="p-2.5 rounded-xl bg-[#14171F] hover:bg-[#1C202B] text-gray-300 hover:text-white border border-white/10 transition-colors"
              title="Refresh data"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
            <Link
              to="/organizer/events/new"
              className="flex-1 sm:flex-none inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-[#D2FF00] hover:bg-[#BEF200] text-black font-semibold text-xs sm:text-sm transition-all duration-200 shadow-[0_0_20px_rgba(210,255,0,0.2)]"
            >
              <Plus className="w-4 h-4" />
              Create Event
            </Link>
          </div>
        </div>

        {/* Real Summary Metrics Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 sm:gap-4">
          {/* 1. Total Events */}
          <div className="p-4 sm:p-5 rounded-2xl bg-[#0E1015] border border-white/10 space-y-2">
            <div className="flex items-center justify-between text-gray-400">
              <span className="text-[10px] sm:text-[11px] font-mono uppercase tracking-wider">
                Total Events
              </span>
              <Calendar className="w-4 h-4 text-gray-500" />
            </div>
            <div className="font-display font-bold text-2xl sm:text-3xl text-white">
              {isLoadingStats ? '—' : stats?.totalEvents ?? 0}
            </div>
            <div className="text-[11px] font-mono text-gray-500">
              Across all lifecycles
            </div>
          </div>

          {/* 2. Published */}
          <div className="p-4 sm:p-5 rounded-2xl bg-[#0E1015] border border-white/10 space-y-2">
            <div className="flex items-center justify-between text-gray-400">
              <span className="text-[10px] sm:text-[11px] font-mono uppercase tracking-wider">
                Live Published
              </span>
              <Radio className="w-4 h-4 text-[#D2FF00]" />
            </div>
            <div className="font-display font-bold text-2xl sm:text-3xl text-[#D2FF00]">
              {isLoadingStats ? '—' : stats?.publishedEvents ?? 0}
            </div>
            <div className="text-[11px] font-mono text-gray-500">
              Visible on discovery
            </div>
          </div>

          {/* 3. Drafts */}
          <div className="p-4 sm:p-5 rounded-2xl bg-[#0E1015] border border-white/10 space-y-2">
            <div className="flex items-center justify-between text-gray-400">
              <span className="text-[10px] sm:text-[11px] font-mono uppercase tracking-wider">
                Drafts
              </span>
              <Clock className="w-4 h-4 text-amber-400" />
            </div>
            <div className="font-display font-bold text-2xl sm:text-3xl text-amber-300">
              {isLoadingStats ? '—' : stats?.draftEvents ?? 0}
            </div>
            <div className="text-[11px] font-mono text-gray-500">
              Unpublished workflows
            </div>
          </div>

          {/* 4. Tickets Sold */}
          <div className="p-4 sm:p-5 rounded-2xl bg-[#0E1015] border border-white/10 space-y-2">
            <div className="flex items-center justify-between text-gray-400">
              <span className="text-[10px] sm:text-[11px] font-mono uppercase tracking-wider">
                Tickets Sold
              </span>
              <Ticket className="w-4 h-4 text-cyan-400" />
            </div>
            <div className="font-display font-bold text-2xl sm:text-3xl text-cyan-300">
              {isLoadingStats ? '—' : (stats?.ticketsSold ?? 0).toLocaleString()}
            </div>
            <div className="text-[11px] font-mono text-gray-500">
              Actual database sales
            </div>
          </div>

          {/* 5. Revenue */}
          <div className="col-span-2 lg:col-span-1 p-4 sm:p-5 rounded-2xl bg-[#0E1015] border border-white/10 space-y-2">
            <div className="flex items-center justify-between text-gray-400">
              <span className="text-[10px] sm:text-[11px] font-mono uppercase tracking-wider">
                Recorded Revenue
              </span>
              <TrendingUp className="w-4 h-4 text-emerald-400" />
            </div>
            <div className="font-display font-bold text-2xl sm:text-3xl text-emerald-400 truncate">
              {isLoadingStats ? '—' : stats?.grossRevenueFormatted ?? '$0'}
            </div>
            <div className="text-[11px] font-mono text-gray-500">
              Completed transactions
            </div>
          </div>
        </div>

        {/* Filter and Search Bar */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 pt-2">
          {/* Status Tabs */}
          <div className="flex items-center p-1 rounded-xl bg-[#0E1015] border border-white/10 text-xs font-mono">
            <button
              onClick={() => setFilterStatus('ALL')}
              className={`px-3.5 py-1.5 rounded-lg transition-colors ${
                filterStatus === 'ALL'
                  ? 'bg-white/10 text-white font-bold'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              All ({rawEvents.length})
            </button>
            <button
              onClick={() => setFilterStatus('PUBLISHED')}
              className={`px-3.5 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 ${
                filterStatus === 'PUBLISHED'
                  ? 'bg-[#D2FF00]/10 text-[#D2FF00] font-bold border border-[#D2FF00]/20'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-[#D2FF00]" />
              Published ({rawEvents.filter((e) => e.status === 'PUBLISHED').length})
            </button>
            <button
              onClick={() => setFilterStatus('DRAFT')}
              className={`px-3.5 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 ${
                filterStatus === 'DRAFT'
                  ? 'bg-amber-400/10 text-amber-300 font-bold border border-amber-400/20'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
              Drafts ({rawEvents.filter((e) => e.status === 'DRAFT').length})
            </button>
          </div>

          {/* Search box */}
          <div className="relative w-full sm:w-72">
            <Search className="w-4 h-4 text-gray-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Filter by title or city..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-4 py-2 rounded-xl bg-[#0E1015] border border-white/10 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-[#D2FF00] transition-colors font-sans"
            />
          </div>
        </div>

        {/* Events Table / Card List */}
        <div className="bg-[#0E1015] rounded-2xl border border-white/10 overflow-hidden shadow-2xl">
          {isLoadingEvents ? (
            <div className="p-12 text-center space-y-3">
              <RefreshCw className="w-6 h-6 animate-spin text-[#D2FF00] mx-auto" />
              <div className="text-xs font-mono text-gray-400 uppercase tracking-wider">
                Loading your experiences...
              </div>
            </div>
          ) : filteredEvents.length === 0 ? (
            /* Empty State */
            <div className="p-12 sm:p-16 text-center space-y-5 max-w-lg mx-auto">
              <div className="w-16 h-16 rounded-2xl bg-[#14171F] border border-white/10 flex items-center justify-center mx-auto text-[#D2FF00]">
                <Sparkles className="w-8 h-8" />
              </div>
              <div className="space-y-1.5">
                <h3 className="font-display font-bold text-lg text-white">
                  {rawEvents.length === 0
                    ? 'No events created yet'
                    : 'No matching events found'}
                </h3>
                <p className="text-xs text-gray-400 leading-relaxed">
                  {rawEvents.length === 0
                    ? 'Begin by creating your first event draft. You can configure multiple ticket tiers, set capacity, and preview the experience before publishing.'
                    : 'Try clearing your search query or switching the status filter.'}
                </p>
              </div>
              {rawEvents.length === 0 ? (
                <Link
                  to="/organizer/events/new"
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#D2FF00] hover:bg-[#BEF200] text-black font-semibold text-xs font-mono uppercase tracking-wider transition-all duration-200"
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
                  className="px-4 py-2 rounded-xl border border-white/10 text-xs font-mono text-gray-400 hover:text-white"
                >
                  Reset Filters
                </button>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-[#14171F] text-gray-400 font-mono uppercase tracking-wider border-b border-white/10 text-[11px]">
                  <tr>
                    <th className="px-5 py-3.5">Event</th>
                    <th className="px-5 py-3.5">Schedule & Location</th>
                    <th className="px-5 py-3.5">Status</th>
                    <th className="px-5 py-3.5">Tickets Sold</th>
                    <th className="px-5 py-3.5">Recorded Revenue</th>
                    <th className="px-5 py-3.5 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {filteredEvents.map((evt) => {
                    const isPublished = evt.status === 'PUBLISHED';
                    const sold = evt.ticketsSold || 0;
                    const capacity = evt.totalCapacity || 1;
                    const percent = Math.min(100, Math.round((sold / capacity) * 100));

                    return (
                      <tr
                        key={evt.id}
                        className="hover:bg-white/[0.02] transition-colors group"
                      >
                        {/* Event Thumbnail & Title */}
                        <td className="px-5 py-4">
                          <div className="flex items-center gap-3.5">
                            <div className="w-14 h-14 rounded-xl overflow-hidden bg-[#14171F] border border-white/10 shrink-0 relative">
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
                              <div className="font-semibold text-white text-sm truncate max-w-xs sm:max-w-sm group-hover:text-[#D2FF00] transition-colors">
                                {evt.title}
                              </div>
                              <div className="flex items-center gap-2 text-[11px] font-mono text-gray-400">
                                <span className="px-1.5 py-0.5 rounded bg-white/5 border border-white/5 text-gray-300">
                                  {evt.category}
                                </span>
                                <span>•</span>
                                <span className="truncate max-w-[150px]">
                                  /{evt.slug}
                                </span>
                              </div>
                            </div>
                          </div>
                        </td>

                        {/* Date & Location */}
                        <td className="px-5 py-4 text-gray-300">
                          <div className="space-y-1">
                            <div className="font-medium text-white flex items-center gap-1.5">
                              <Calendar className="w-3.5 h-3.5 text-gray-500" />
                              {new Date(evt.startAt).toLocaleDateString('en-US', {
                                weekday: 'short',
                                month: 'short',
                                day: 'numeric',
                                year: 'numeric',
                              })}
                            </div>
                            <div className="text-[11px] text-gray-400 flex items-center gap-1.5">
                              <MapPin className="w-3.5 h-3.5 text-gray-500" />
                              <span className="truncate max-w-[180px]">
                                {evt.venueName ? `${evt.venueName}, ` : ''}{evt.city}
                              </span>
                            </div>
                          </div>
                        </td>

                        {/* Status Badge */}
                        <td className="px-5 py-4">
                          {isPublished ? (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-mono uppercase tracking-wider font-bold bg-[#D2FF00]/10 text-[#D2FF00] border border-[#D2FF00]/30 shadow-[0_0_10px_rgba(210,255,0,0.15)]">
                              <span className="w-1.5 h-1.5 rounded-full bg-[#D2FF00] animate-pulse" />
                              Published
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-mono uppercase tracking-wider font-bold bg-amber-400/10 text-amber-300 border border-amber-400/30">
                              <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                              Draft
                            </span>
                          )}
                        </td>

                        {/* Inventory / Tickets Sold */}
                        <td className="px-5 py-4">
                          <div className="space-y-1.5 w-36 sm:w-44">
                            <div className="flex justify-between font-mono text-[11px]">
                              <span className="text-white font-semibold">
                                {sold} sold
                              </span>
                              <span className="text-gray-500">
                                / {capacity}
                              </span>
                            </div>
                            <div className="w-full h-1.5 rounded-full bg-white/10 overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all ${
                                  percent >= 100
                                    ? 'bg-rose-500'
                                    : percent > 75
                                    ? 'bg-[#D2FF00]'
                                    : 'bg-cyan-400'
                                }`}
                                style={{ width: `${percent}%` }}
                              />
                            </div>
                          </div>
                        </td>

                        {/* Real Revenue */}
                        <td className="px-5 py-4 font-mono font-bold text-sm text-emerald-400">
                          {evt.revenueFormatted || '$0'}
                        </td>

                        {/* Actions */}
                        <td className="px-5 py-4 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            {/* Preview Mode */}
                            <Link
                              to={`/organizer/events/${evt.id}/preview`}
                              className="p-2 rounded-lg bg-[#14171F] hover:bg-[#1C202B] text-gray-300 hover:text-white border border-white/10 transition-colors"
                              title="Preview Event (Organizer Mode)"
                            >
                              <Eye className="w-3.5 h-3.5" />
                            </Link>

                            {/* Edit Event */}
                            <Link
                              to={`/organizer/events/${evt.id}/edit`}
                              className="p-2 rounded-lg bg-[#14171F] hover:bg-[#1C202B] text-gray-300 hover:text-[#D2FF00] border border-white/10 transition-colors"
                              title="Edit Event & Ticket Tiers"
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                            </Link>

                            {/* Publish / Unpublish Action Button */}
                            {isPublished ? (
                              <button
                                onClick={() => unpublishMutation.mutate(evt.id)}
                                disabled={unpublishMutation.isPending}
                                className="px-2.5 py-1.5 rounded-lg bg-amber-400/10 hover:bg-amber-400/20 text-amber-300 border border-amber-400/20 text-[11px] font-mono uppercase font-semibold transition-colors disabled:opacity-50"
                                title="Unpublish event (hide from discovery)"
                              >
                                Unpublish
                              </button>
                            ) : (
                              <button
                                onClick={() => publishMutation.mutate(evt.id)}
                                disabled={publishMutation.isPending}
                                className="px-2.5 py-1.5 rounded-lg bg-[#D2FF00]/10 hover:bg-[#D2FF00]/20 text-[#D2FF00] border border-[#D2FF00]/30 text-[11px] font-mono uppercase font-semibold transition-colors disabled:opacity-50"
                                title="Publish event to Outside.vip"
                              >
                                Publish
                              </button>
                            )}

                            {/* View Live (if published) */}
                            {isPublished && (
                              <Link
                                to={`/events/${evt.slug}`}
                                className="p-2 rounded-lg bg-[#14171F] hover:bg-[#1C202B] text-gray-300 hover:text-[#D2FF00] border border-white/10 transition-colors"
                                title="View Live Public Event"
                              >
                                <ExternalLink className="w-3.5 h-3.5" />
                              </Link>
                            )}

                            {/* Delete Draft (only if draft and 0 sold) */}
                            {!isPublished && sold === 0 && (
                              <button
                                onClick={() => setEventToDelete(evt)}
                                className="p-2 rounded-lg bg-[#14171F] hover:bg-rose-950/40 text-gray-400 hover:text-rose-400 border border-white/10 transition-colors"
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
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in">
          <div className="max-w-md w-full bg-[#0E1015] border border-white/10 rounded-2xl p-6 space-y-4 shadow-2xl">
            <div className="flex items-center gap-3 text-rose-400">
              <div className="w-10 h-10 rounded-xl bg-rose-500/10 border border-rose-500/20 flex items-center justify-center">
                <Trash2 className="w-5 h-5 text-rose-400" />
              </div>
              <div>
                <h3 className="font-display font-bold text-base text-white">
                  Delete Draft Event?
                </h3>
                <span className="text-[11px] font-mono text-gray-400">
                  This action cannot be undone.
                </span>
              </div>
            </div>

            <p className="text-xs text-gray-300 leading-relaxed">
              Are you sure you want to permanently delete{' '}
              <strong className="text-white">"{eventToDelete.title}"</strong> and all its associated draft ticket tiers?
            </p>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setEventToDelete(null)}
                disabled={isDeleting}
                className="px-4 py-2 rounded-xl border border-white/10 text-xs font-mono text-gray-400 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeleteConfirm}
                disabled={isDeleting}
                className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-semibold text-xs font-mono uppercase tracking-wider transition-colors disabled:opacity-50"
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
