import React, { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { TicketTier } from '../types';
import { 
  Calendar, 
  MapPin, 
  ShieldCheck, 
  Minus, 
  Plus, 
  ArrowLeft,
  CheckCircle2,
  Lock,
  Share2
} from 'lucide-react';

export const EventDetailPage: React.FC = () => {
  const { slug } = useParams<{ slug: string }>();
  const [selectedQuantities, setSelectedQuantities] = useState<Record<string, number>>({});
  const [attendeeName, setAttendeeName] = useState('');
  const [attendeeEmail, setAttendeeEmail] = useState('');
  const [isCheckingOut, setIsCheckingOut] = useState(false);
  const [checkoutSuccessMessage, setCheckoutSuccessMessage] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['event', slug],
    queryFn: () => api.events.bySlug(slug!),
    enabled: Boolean(slug),
  });

  const event = data?.event;

  const updateQuantity = (tierId: string, delta: number, max: number) => {
    setSelectedQuantities((prev) => {
      const current = prev[tierId] || 0;
      const next = Math.max(0, Math.min(max, current + delta));
      return { ...prev, [tierId]: next };
    });
  };

  const totalTickets = Object.values(selectedQuantities).reduce((a, b) => a + b, 0);

  const totalInCents = event
    ? event.ticketTiers.reduce((acc, tier) => {
        const qty = selectedQuantities[tier.id] || 0;
        return acc + qty * tier.priceInCents;
      }, 0)
    : 0;

  const formatPrice = (cents: number, currency = 'USD') => {
    if (cents === 0) return 'Free';
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(cents / 100);
  };

  const handleCheckoutSimulation = (e: React.FormEvent) => {
    e.preventDefault();
    if (totalTickets === 0 || !attendeeEmail || !attendeeName) return;

    setIsCheckingOut(true);
    setTimeout(() => {
      setIsCheckingOut(false);
      setCheckoutSuccessMessage(
        `Reservation confirmed for ${attendeeName}! Stripe Checkout flow initiated for ${totalTickets} ticket(s).`
      );
    }, 1200);
  };

  if (isLoading) {
    return (
      <div className="max-w-6xl mx-auto px-4 py-12 space-y-8 animate-pulse">
        <div className="h-8 w-40 bg-surface-900 rounded-full"></div>
        <div className="h-[420px] bg-surface-900 rounded-3xl"></div>
      </div>
    );
  }

  if (error || !event) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-20 text-center space-y-6">
        <h2 className="text-2xl font-bold text-white">Experience Not Found</h2>
        <p className="text-slate-400">The requested event could not be found or has ended.</p>
        <Link
          to="/"
          className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-brand-neon text-black font-semibold text-sm"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Discovery
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-12">
      {/* Back button */}
      <div>
        <Link
          to="/"
          className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-white transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to all experiences
        </Link>
      </div>

      {/* Main Grid: Details Left, Ticket Selector Right */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-12">
        {/* Left Column: Artwork & Info */}
        <div className="lg:col-span-7 space-y-8">
          <div className="rounded-3xl overflow-hidden border border-surface-800 shadow-2xl relative aspect-[16/10]">
            <img
              src={event.coverImageUrl}
              alt={event.title}
              className="w-full h-full object-cover object-center"
            />
            <div className="absolute top-4 left-4">
              <span className="px-3.5 py-1.5 rounded-full bg-black/70 backdrop-blur-md border border-white/10 text-brand-neon text-xs font-mono uppercase tracking-widest font-bold">
                {event.category}
              </span>
            </div>
          </div>

          <div className="space-y-4">
            <h1 className="font-display font-black text-3xl sm:text-5xl text-white tracking-tight leading-tight">
              {event.title}
            </h1>

            {event.tagline && (
              <p className="text-lg text-slate-300 font-light leading-relaxed">
                {event.tagline}
              </p>
            )}
          </div>

          {/* Organizer row */}
          <div className="flex items-center justify-between p-4 rounded-2xl glass-panel">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-xl bg-surface-800 border border-surface-700 overflow-hidden flex items-center justify-center font-bold text-brand-neon">
                {event.organizer.avatarUrl ? (
                  <img
                    src={event.organizer.avatarUrl}
                    alt={event.organizer.name}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  event.organizer.name.charAt(0)
                )}
              </div>
              <div>
                <span className="text-[11px] font-mono uppercase text-slate-400 block tracking-wider">
                  Hosted by
                </span>
                <span className="font-semibold text-white text-sm">
                  {event.organizer.organizer?.displayName || event.organizer.name}
                </span>
              </div>
            </div>

            <button
              onClick={() => {
                if (navigator.share) {
                  navigator.share({ title: event.title, url: window.location.href });
                } else {
                  navigator.clipboard.writeText(window.location.href);
                  alert('Event link copied to clipboard!');
                }
              }}
              className="p-2.5 rounded-xl bg-surface-850 hover:bg-surface-800 text-slate-300 border border-surface-700 transition-colors"
              title="Share Event"
            >
              <Share2 className="w-4 h-4" />
            </button>
          </div>

          {/* Key details highlights */}
          <div className="grid grid-cols-2 gap-4">
            <div className="p-4 rounded-2xl glass-panel space-y-1">
              <div className="flex items-center gap-2 text-brand-neon text-xs font-mono uppercase tracking-wider">
                <Calendar className="w-4 h-4" />
                Date & Time
              </div>
              <div className="text-sm font-semibold text-white">
                {new Date(event.startAt).toLocaleDateString('en-US', {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })}
              </div>
              <div className="text-xs text-slate-400">
                {new Date(event.startAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })} —{' '}
                {new Date(event.endAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
              </div>
            </div>

            <div className="p-4 rounded-2xl glass-panel space-y-1">
              <div className="flex items-center gap-2 text-brand-neon text-xs font-mono uppercase tracking-wider">
                <MapPin className="w-4 h-4" />
                Venue Location
              </div>
              <div className="text-sm font-semibold text-white truncate">
                {event.venueName}
              </div>
              <div className="text-xs text-slate-400 truncate">
                {event.venueAddress}, {event.city}
              </div>
            </div>
          </div>

          {/* Description */}
          <div className="space-y-4 pt-4 border-t border-surface-800">
            <h3 className="font-display font-bold text-xl text-white">About the Experience</h3>
            <div className="prose prose-invert text-slate-300 text-sm leading-relaxed whitespace-pre-line">
              {event.description}
            </div>
          </div>

          {/* Restrictions and dress code */}
          <div className="p-4 rounded-2xl bg-surface-900 border border-surface-800 space-y-2 text-xs text-slate-400">
            <div className="flex items-center gap-2 text-slate-200 font-semibold">
              <ShieldCheck className="w-4 h-4 text-brand-neon" />
              Event Policies & Entry
            </div>
            <div className="grid grid-cols-2 gap-2 pt-1 font-mono text-[11px]">
              <div>Age Restriction: <span className="text-white">{event.ageRestriction || '18+'}</span></div>
              <div>Dress Code: <span className="text-white">{event.dressCode || 'Unspecified'}</span></div>
            </div>
          </div>
        </div>

        {/* Right Column: Ticket Tiers & Checkout Box */}
        <div className="lg:col-span-5 space-y-6">
          <div className="glass-panel rounded-3xl p-6 sm:p-8 space-y-6 sticky top-28 border-surface-700/80 shadow-2xl">
            <div className="flex items-center justify-between pb-4 border-b border-surface-800">
              <div>
                <h2 className="font-display font-bold text-2xl text-white">Select Tickets</h2>
                <span className="text-xs text-slate-400">Official Outside.vip verified passes</span>
              </div>
              <div className="w-8 h-8 rounded-full bg-brand-neon/10 border border-brand-neon/30 flex items-center justify-center text-brand-neon">
                <Lock className="w-4 h-4" />
              </div>
            </div>

            {/* Tiers List */}
            <div className="space-y-4">
              {event.ticketTiers.map((tier: TicketTier) => {
                const qty = selectedQuantities[tier.id] || 0;
                const isSoldOut = tier.status === 'SOLD_OUT' || (tier.remainingCapacity !== undefined && tier.remainingCapacity <= 0);

                return (
                  <div
                    key={tier.id}
                    className={`p-4 rounded-2xl border transition-all ${
                      qty > 0
                        ? 'bg-surface-850 border-brand-neon/50 shadow-neon-sm'
                        : isSoldOut
                        ? 'bg-surface-950/50 border-surface-850 opacity-60'
                        : 'bg-surface-900 border-surface-800 hover:border-surface-700'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-display font-bold text-white text-base">
                            {tier.name}
                          </span>
                          {isSoldOut && (
                            <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-rose-500/20 text-rose-400 font-bold">
                              Sold Out
                            </span>
                          )}
                        </div>
                        {tier.description && (
                          <p className="text-xs text-slate-400 leading-snug">
                            {tier.description}
                          </p>
                        )}
                        <div className="text-xs font-mono text-brand-neon font-bold pt-1">
                          {formatPrice(tier.priceInCents, tier.currency)}
                        </div>
                      </div>

                      {/* Quantity Stepper */}
                      {!isSoldOut ? (
                        <div className="flex items-center gap-2 bg-surface-950 border border-surface-800 rounded-xl p-1">
                          <button
                            type="button"
                            onClick={() => updateQuantity(tier.id, -1, tier.maxPerOrder)}
                            disabled={qty === 0}
                            className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-400 hover:text-white hover:bg-surface-800 disabled:opacity-30 disabled:hover:bg-transparent"
                          >
                            <Minus className="w-3.5 h-3.5" />
                          </button>
                          <span className="w-6 text-center text-sm font-mono font-bold text-white">
                            {qty}
                          </span>
                          <button
                            type="button"
                            onClick={() => updateQuantity(tier.id, 1, Math.min(tier.maxPerOrder, tier.remainingCapacity || 10))}
                            disabled={qty >= (tier.remainingCapacity || tier.maxPerOrder)}
                            className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-400 hover:text-white hover:bg-surface-800 disabled:opacity-30 disabled:hover:bg-transparent"
                          >
                            <Plus className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <div className="text-xs font-mono text-slate-500 uppercase">
                          Exhausted
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Attendee Form & Order summary */}
            {totalTickets > 0 && (
              <form onSubmit={handleCheckoutSimulation} className="space-y-4 pt-4 border-t border-surface-800">
                <div className="space-y-3">
                  <span className="text-xs font-mono uppercase tracking-wider text-slate-400 font-semibold block">
                    Attendee Information
                  </span>
                  <div>
                    <input
                      type="text"
                      required
                      placeholder="Full Name"
                      value={attendeeName}
                      onChange={(e) => setAttendeeName(e.target.value)}
                      className="w-full px-4 py-3 rounded-xl bg-surface-900 border border-surface-800 text-white placeholder-slate-500 text-sm focus:outline-none focus:border-brand-neon"
                    />
                  </div>
                  <div>
                    <input
                      type="email"
                      required
                      placeholder="Email Address (for ticket delivery)"
                      value={attendeeEmail}
                      onChange={(e) => setAttendeeEmail(e.target.value)}
                      className="w-full px-4 py-3 rounded-xl bg-surface-900 border border-surface-800 text-white placeholder-slate-500 text-sm focus:outline-none focus:border-brand-neon"
                    />
                  </div>
                </div>

                {/* Subtotal */}
                <div className="p-4 rounded-xl bg-surface-900/60 border border-surface-800 space-y-2">
                  <div className="flex items-center justify-between text-xs text-slate-400">
                    <span>{totalTickets} Ticket(s)</span>
                    <span className="font-mono text-white">{formatPrice(totalInCents, event.currency)}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs text-slate-400">
                    <span>Platform & Secure Processing Fee</span>
                    <span className="font-mono text-brand-neon">Waived / Free</span>
                  </div>
                  <div className="pt-2 border-t border-surface-800 flex items-center justify-between text-base font-bold text-white">
                    <span>Total</span>
                    <span className="font-mono text-brand-neon font-display text-xl">
                      {formatPrice(totalInCents, event.currency)}
                    </span>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={isCheckingOut}
                  className="w-full py-4 rounded-full bg-brand-neon hover:bg-brand-neon-hover text-black font-display font-bold text-base transition-all shadow-neon-md hover:scale-[1.01] flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {isCheckingOut ? (
                    <>
                      <div className="w-5 h-5 border-2 border-black border-t-transparent rounded-full animate-spin" />
                      Reserving Inventory...
                    </>
                  ) : (
                    <>
                      <Lock className="w-4 h-4" />
                      Proceed to Checkout ({formatPrice(totalInCents, event.currency)})
                    </>
                  )}
                </button>
              </form>
            )}

            {/* Success state */}
            {checkoutSuccessMessage && (
              <div className="p-4 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs space-y-1">
                <div className="font-semibold flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4" />
                  Order Reservation Created
                </div>
                <div>{checkoutSuccessMessage}</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
