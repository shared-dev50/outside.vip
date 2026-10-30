import React, { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { TicketTier } from '../types';
import {
  Calendar,
  MapPin,
  ExternalLink,
  Edit3,
  Globe,
  CheckCircle2,
  AlertCircle,
  X,
  Minus,
  Plus,
} from 'lucide-react';

export const EventPreviewPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();

  const [selectedQuantities, setSelectedQuantities] = useState<Record<string, number>>({});
  const [notification, setNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Fetch organizer event by ID (authenticated, works for unpublished drafts)
  const { data, isLoading, error } = useQuery({
    queryKey: ['organizer-event', id],
    queryFn: () => api.organizer.getEvent(id!),
    enabled: Boolean(id),
  });

  const event = data?.event;

  const publishMutation = useMutation({
    mutationFn: (eventId: string) => api.organizer.publishEvent(eventId),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['organizer-event', id] });
      queryClient.invalidateQueries({ queryKey: ['organizer-dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['organizer-events'] });
      queryClient.invalidateQueries({ queryKey: ['events'] });
      setNotification({
        type: 'success',
        message: res.message || 'Event published to Outside.vip public catalogue!',
      });
    },
    onError: (err: any) => {
      setNotification({
        type: 'error',
        message: err?.message || 'Publishing failed. Please ensure title, venue, artwork, and ticket tiers are valid.',
      });
    },
  });

  const unpublishMutation = useMutation({
    mutationFn: (eventId: string) => api.organizer.unpublishEvent(eventId),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['organizer-event', id] });
      queryClient.invalidateQueries({ queryKey: ['organizer-dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['organizer-events'] });
      queryClient.invalidateQueries({ queryKey: ['events'] });
      setNotification({
        type: 'success',
        message: res.message || 'Event unpublished and reverted to draft status.',
      });
    },
    onError: (err: any) => {
      setNotification({
        type: 'error',
        message: err?.message || 'Failed to unpublish event.',
      });
    },
  });

  const updateQuantity = (tierId: string, delta: number, max: number) => {
    setSelectedQuantities((prev) => {
      const current = prev[tierId] || 0;
      const next = Math.max(0, Math.min(max, current + delta));
      return { ...prev, [tierId]: next };
    });
  };

  const formatPrice = (cents?: number, currency = 'USD') => {
    if (cents === undefined || cents === 0) return 'Free';
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(cents / 100);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-white">
        <div className="bg-[#08090C] text-white py-3 px-4 text-center text-xs font-mono">
          Loading Organizer Preview...
        </div>
        <div className="max-w-7xl mx-auto px-4 py-12 animate-pulse space-y-6">
          <div className="h-6 w-32 bg-gray-200 rounded" />
          <div className="aspect-[16/10] max-w-3xl bg-gray-200 rounded-lg" />
          <div className="h-10 w-2/3 bg-gray-200 rounded" />
        </div>
      </div>
    );
  }

  if (error || !event) {
    return (
      <div className="min-h-screen bg-[#08090C] text-white flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-[#0E1015] border border-white/10 rounded-2xl p-8 text-center space-y-4">
          <AlertCircle className="w-10 h-10 text-rose-400 mx-auto" />
          <h2 className="font-display font-bold text-xl text-white">Event Not Found</h2>
          <p className="text-xs text-gray-400">
            This event draft does not exist or you do not have permission to view it.
          </p>
          <div className="pt-2 flex justify-center gap-3">
            <Link
              to="/organizer"
              className="px-4 py-2 rounded-xl bg-white/10 hover:bg-white/20 text-xs font-mono text-white"
            >
              Back to Dashboard
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const isPublished = event.status === 'PUBLISHED';
  const totalTickets = Object.values(selectedQuantities).reduce((a, b) => a + b, 0);
  const totalInCents = event.ticketTiers.reduce((acc, tier) => {
    const qty = selectedQuantities[tier.id] || 0;
    return acc + qty * tier.priceInCents;
  }, 0);

  const mapSearchUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    `${event.venueName}, ${event.venueAddress}, ${event.city}`
  )}`;

  return (
    <div className="min-h-screen bg-white text-gray-900 pb-24">
      <div className="sticky top-0 z-50 bg-[#08090C] text-white border-b border-white/10 shadow-2xl">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span className={`w-2.5 h-2.5 rounded-full ${isPublished ? 'bg-[#D2FF00] animate-pulse' : 'bg-amber-400'}`} />
              <span className="font-mono text-xs uppercase tracking-wider font-bold text-white">
                {isPublished ? 'Live Published Event' : 'Draft Event Preview'}
              </span>
            </div>
            <span className="text-gray-600 hidden sm:inline">•</span>
            <span className="text-xs text-gray-400 font-mono hidden md:inline">
              {isPublished ? 'Live on Outside.vip Catalogue' : 'Hidden from public attendees'}
            </span>
          </div>

          <div className="flex items-center gap-2 sm:gap-3 w-full sm:w-auto justify-end">
            <Link
              to="/organizer"
              className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-gray-300 hover:text-white text-xs font-mono transition-colors"
            >
              Dashboard
            </Link>

            <Link
              to={`/organizer/events/${event.id}/edit`}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#14171F] hover:bg-[#1C202B] text-gray-200 hover:text-[#D2FF00] border border-white/10 text-xs font-mono transition-colors"
            >
              <Edit3 className="w-3.5 h-3.5" />
              Edit Event
            </Link>

            {isPublished ? (
              <>
                <button
                  type="button"
                  onClick={() => unpublishMutation.mutate(event.id)}
                  disabled={unpublishMutation.isPending}
                  className="px-3 py-1.5 rounded-lg bg-amber-400/10 hover:bg-amber-400/20 text-amber-300 border border-amber-400/30 text-xs font-mono font-semibold uppercase tracking-wider transition-colors disabled:opacity-50"
                >
                  Unpublish
                </button>
                <Link
                  to={`/events/${event.slug}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#D2FF00] hover:bg-[#BEF200] text-black text-xs font-mono font-bold uppercase tracking-wider transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  Public Page
                </Link>
              </>
            ) : (
              <button
                type="button"
                onClick={() => publishMutation.mutate(event.id)}
                disabled={publishMutation.isPending}
                className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-[#D2FF00] hover:bg-[#BEF200] text-black text-xs font-mono font-bold uppercase tracking-wider transition-all duration-200 shadow-[0_0_15px_rgba(210,255,0,0.3)] disabled:opacity-50"
              >
                <Globe className="w-3.5 h-3.5" />
                {publishMutation.isPending ? 'Publishing...' : 'Publish Live Now'}
              </button>
            )}
          </div>
        </div>
      </div>

      {notification && (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mt-4">
          <div
            className={`p-4 rounded-xl border text-xs font-medium flex items-center justify-between gap-3 ${
              notification.type === 'success'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                : 'bg-rose-50 border-rose-200 text-rose-800'
            }`}
          >
            <div className="flex items-center gap-2">
              {notification.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
              ) : (
                <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
              )}
              <span>{notification.message}</span>
            </div>
            <button onClick={() => setNotification(null)} className="text-gray-400 hover:text-black">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-start">
          <div className="lg:col-span-7 space-y-6">
            <div className="relative aspect-[16/10] rounded-xl overflow-hidden bg-gray-100 border border-gray-200 shadow-sm">
              <img
                src={event.coverImageUrl}
                alt={event.title}
                className="w-full h-full object-cover"
                onError={(e) => {
                  e.currentTarget.src =
                    'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=1600&q=85';
                }}
              />
              <div className="absolute top-3 left-3">
                <span className="px-2.5 py-1 rounded bg-black/80 backdrop-blur-md text-[#D2FF00] font-mono font-bold text-[11px] uppercase tracking-wider border border-white/10">
                  {event.category}
                </span>
              </div>
            </div>

            <div className="space-y-2">
              <h1 className="font-display font-extrabold text-2xl sm:text-3xl md:text-4xl text-gray-900 tracking-tight leading-tight">
                {event.title}
              </h1>
              {event.tagline && (
                <p className="text-gray-500 text-base leading-relaxed">
                  {event.tagline}
                </p>
              )}
            </div>

            <div className="p-4 rounded-xl bg-gray-50 border border-gray-200 grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
              <div className="space-y-1">
                <div className="text-gray-400 font-medium flex items-center gap-1.5 uppercase tracking-wider text-[11px]">
                  <Calendar className="w-3.5 h-3.5 text-gray-500" />
                  <span>Date & Schedule</span>
                </div>
                <div className="font-semibold text-gray-900 text-sm">
                  {new Date(event.startAt).toLocaleDateString('en-US', {
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })}
                </div>
                <div className="text-gray-500">
                  {new Date(event.startAt).toLocaleTimeString('en-US', {
                    hour: 'numeric',
                    minute: '2-digit',
                  })}{' '}
                  —{' '}
                  {new Date(event.endAt).toLocaleTimeString('en-US', {
                    hour: 'numeric',
                    minute: '2-digit',
                  })}{' '}
                  ({event.timezone})
                </div>
              </div>

              <div className="space-y-1">
                <div className="text-gray-400 font-medium flex items-center justify-between uppercase tracking-wider text-[11px]">
                  <span className="flex items-center gap-1.5">
                    <MapPin className="w-3.5 h-3.5 text-gray-500" />
                    Venue
                  </span>
                  <a
                    href={mapSearchUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-gray-600 hover:text-black hover:underline flex items-center gap-0.5"
                  >
                    <span>Google Maps</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
                <div className="font-semibold text-gray-900 text-sm truncate">
                  {event.venueName || 'Venue to be announced'}
                </div>
                <div className="text-gray-500 truncate">
                  {event.venueAddress ? `${event.venueAddress}, ` : ''}{event.city}, {event.country}
                </div>
              </div>
            </div>

            <div className="p-4 rounded-xl border border-gray-200 flex items-center justify-between gap-3 text-xs">
              <div className="flex items-center gap-3">
                {event.organizer.avatarUrl ? (
                  <img
                    src={event.organizer.avatarUrl}
                    alt={event.organizer.name}
                    className="w-10 h-10 rounded-full object-cover border border-gray-200"
                  />
                ) : (
                  <div className="w-10 h-10 rounded-full bg-gray-100 border border-gray-200 flex items-center justify-center font-bold text-gray-700">
                    {event.organizer.name.charAt(0)}
                  </div>
                )}
                <div>
                  <span className="text-gray-400 text-[11px] block">Hosted by</span>
                  <span className="font-bold text-gray-900 text-sm">
                    {event.organizer.organizer?.displayName || event.organizer.name}
                  </span>
                  {event.organizer.organizer?.bio && (
                    <p className="text-gray-500 text-xs line-clamp-1 mt-0.5">
                      {event.organizer.organizer.bio}
                    </p>
                  )}
                </div>
              </div>
            </div>

            <div className="space-y-3 pt-2">
              <h2 className="font-bold text-lg text-gray-900">About this event</h2>
              <div className="text-gray-700 text-sm leading-relaxed whitespace-pre-line font-normal">
                {event.description || 'No description provided yet.'}
              </div>
            </div>

            <div className="p-4 rounded-xl bg-gray-50 border border-gray-200 space-y-2 text-xs text-gray-600">
              <div className="font-semibold text-gray-900">Important Information & Door Policy</div>
              <div className="grid grid-cols-2 gap-2 text-xs pt-1">
                <div>
                  Age Policy: <span className="text-gray-900 font-medium">{event.ageRestriction || '18+'}</span>
                </div>
                <div>
                  Dress Code: <span className="text-gray-900 font-medium">{event.dressCode || 'Open'}</span>
                </div>
              </div>
              <p className="text-gray-500 pt-1 border-t border-gray-200 text-[11px]">
                Valid government-issued photo ID required at the door. Passes will be scanned upon arrival.
              </p>
            </div>
          </div>

          <div className="lg:col-span-5 space-y-4">
            <div className="border border-gray-200 rounded-xl p-5 sm:p-6 space-y-5 sticky top-20 bg-white shadow-sm">
              <div className="flex items-center justify-between pb-3 border-b border-gray-100">
                <h2 className="font-bold text-lg text-gray-900">Tickets & Passes</h2>
                <span className="text-xs font-mono text-gray-500">
                  {event.ticketTiers.length} Tier{event.ticketTiers.length !== 1 ? 's' : ''} Configured
                </span>
              </div>

              {event.ticketTiers.length === 0 ? (
                <div className="p-6 text-center text-xs text-gray-500 border border-dashed border-gray-200 rounded-xl space-y-2">
                  <p>No ticket tiers configured for this event yet.</p>
                  <Link
                    to={`/organizer/events/${event.id}/edit`}
                    className="inline-block text-xs font-mono text-black font-semibold underline"
                  >
                    Add Ticket Tiers in Editor →
                  </Link>
                </div>
              ) : (
                <div className="space-y-3">
                  {event.ticketTiers.map((tier: TicketTier) => {
                    const qty = selectedQuantities[tier.id] || 0;
                    return (
                      <div
                        key={tier.id}
                        className={`p-3.5 rounded-xl border transition-colors ${
                          qty > 0 ? 'bg-gray-50 border-gray-900' : 'border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="space-y-0.5 flex-1">
                            <div className="font-semibold text-gray-900 text-sm">
                              {tier.name}
                            </div>
                            {tier.description && (
                              <p className="text-xs text-gray-500 leading-snug">
                                {tier.description}
                              </p>
                            )}
                            <div className="pt-1 flex items-center gap-3 text-xs">
                              <span className="font-semibold text-gray-900">
                                {formatPrice(tier.priceInCents, tier.currency)}
                              </span>
                              <span className="text-[11px] font-mono text-gray-400">
                                Capacity: {tier.totalCapacity}
                              </span>
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5 bg-gray-50 border border-gray-200 rounded-md p-1 shrink-0">
                            <button
                              type="button"
                              onClick={() => updateQuantity(tier.id, -1, tier.maxPerOrder)}
                              disabled={qty === 0}
                              className="w-6 h-6 rounded flex items-center justify-center text-gray-600 hover:text-black hover:bg-gray-200 disabled:opacity-20"
                            >
                              <Minus className="w-3 h-3" />
                            </button>
                            <span className="w-5 text-center text-xs font-bold text-gray-900">
                              {qty}
                            </span>
                            <button
                              type="button"
                              onClick={() => updateQuantity(tier.id, 1, tier.maxPerOrder)}
                              disabled={qty >= tier.maxPerOrder}
                              className="w-6 h-6 rounded flex items-center justify-center text-gray-600 hover:text-black hover:bg-gray-200 disabled:opacity-20"
                            >
                              <Plus className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {totalTickets > 0 && (
                <div className="pt-3 border-t border-gray-100 space-y-3 text-xs">
                  <div className="flex items-center justify-between text-sm font-bold text-gray-900">
                    <span>Selected ({totalTickets} ticket{totalTickets > 1 ? 's' : ''})</span>
                    <span className="text-base">{formatPrice(totalInCents, event.currency)}</span>
                  </div>
                  <div className="p-2.5 rounded-lg bg-gray-100 text-gray-600 text-[11px] text-center font-mono">
                    Attendee Checkout Disabled in Preview Mode
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
