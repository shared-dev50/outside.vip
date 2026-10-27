import React, { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { TicketTier, CheckoutSessionResult } from '../types';
import { CheckoutDialog } from '../components/events/CheckoutDialog';
import { calculateCheckoutFeeBreakdown } from '../lib/fees';
import { 
  Calendar, 
  MapPin, 
  Minus, 
  Plus, 
  ArrowLeft,
  ExternalLink,
  Share2,
  Check,
  AlertCircle
} from 'lucide-react';

export const EventDetailPage: React.FC = () => {
  const { slug } = useParams<{ slug: string }>();
  const [selectedQuantities, setSelectedQuantities] = useState<Record<string, number>>({});
  const [attendeeName, setAttendeeName] = useState('');
  const [attendeeEmail, setAttendeeEmail] = useState('');
  const [attendeePhone, setAttendeePhone] = useState('');
  const [isReserving, setIsReserving] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [ticketsError, setTicketsError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [isCheckoutOpen, setIsCheckoutOpen] = useState(false);
  const [paymentSession, setPaymentSession] = useState<CheckoutSessionResult | null>(null);
  const [sessionSnapshotKey, setSessionSnapshotKey] = useState<string | null>(null);

  // Fetch event details by slug
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['event', slug],
    queryFn: () => api.events.bySlug(slug!),
    enabled: Boolean(slug),
  });

  const event = data?.event;

  const updateQuantity = (tierId: string, delta: number, max: number) => {
    if (isReserving) return;
    setSelectedQuantities((prev) => {
      const current = prev[tierId] || 0;
      const next = Math.max(0, Math.min(max, current + delta));
      return { ...prev, [tierId]: next };
    });
    if (ticketsError) setTicketsError(null);
    if (checkoutError) setCheckoutError(null);
  };

  const totalTickets = Object.values(selectedQuantities).reduce((a, b) => a + b, 0);

  const ticketSubtotalInCents = event
    ? event.ticketTiers.reduce((acc, tier) => {
        const qty = selectedQuantities[tier.id] || 0;
        return acc + qty * tier.priceInCents;
      }, 0)
    : 0;

  const checkoutFees = calculateCheckoutFeeBreakdown(ticketSubtotalInCents, totalTickets);
  const totalInCents = checkoutFees.buyerTotalInCents;

  const selectedItems = (event?.ticketTiers || [])
    .filter((tier) => (selectedQuantities[tier.id] || 0) > 0)
    .map((tier) => ({
      tier,
      quantity: selectedQuantities[tier.id],
    }));

  const formatPrice = (cents?: number, currency = 'USD') => {
    if (cents === undefined || cents === 0) return 'Free';
    const hasCents = cents % 100 !== 0;
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: hasCents ? 2 : 0,
      maximumFractionDigits: 2,
    }).format(cents / 100);
  };

  const formatPriceWithCents = (cents?: number, currency = 'USD') => {
    if (cents === undefined || cents === 0) return 'Free';
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(cents / 100);
  };

  const handleShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: event?.title || 'Outside.vip Event',
          text: event?.tagline || `Get tickets for ${event?.title} on Outside.vip`,
          url: window.location.href,
        });
        return;
      } catch {
        // Fallback to clipboard
      }
    }

    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    } catch {
      alert('Event URL: ' + window.location.href);
    }
  };

  const handleProceedToCheckout = async (e: React.FormEvent) => {
    e.preventDefault();
    setCheckoutError(null);

    let hasError = false;

    if (totalTickets === 0) {
      setTicketsError('Please select at least 1 ticket to continue.');
      hasError = true;
    } else {
      setTicketsError(null);
    }

    const trimmedName = attendeeName.trim();
    if (!trimmedName) {
      setNameError('Please enter your full name.');
      hasError = true;
    } else {
      setNameError(null);
    }

    const trimmedEmail = attendeeEmail.trim();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!trimmedEmail) {
      setEmailError('Please enter your email address.');
      hasError = true;
    } else if (!emailRegex.test(trimmedEmail)) {
      setEmailError('Please enter a valid email address.');
      hasError = true;
    } else {
      setEmailError(null);
    }

    if (hasError || !event) {
      return;
    }

    if (isReserving) {
      return;
    }

    // Build snapshot key to check if current selection matches active paymentSession
    const currentSnapshotKey = JSON.stringify({
      items: Object.entries(selectedQuantities)
        .filter(([_, qty]) => qty > 0)
        .sort(([a], [b]) => a.localeCompare(b)),
      name: trimmedName,
      email: trimmedEmail.toLowerCase(),
      phone: attendeePhone.trim(),
    });

    const now = Date.now();
    const isSessionValid =
      paymentSession &&
      sessionSnapshotKey === currentSnapshotKey &&
      new Date(paymentSession.expiresAt).getTime() > now + 15000;

    if (isSessionValid) {
      setIsCheckoutOpen(true);
      return;
    }

    setIsReserving(true);

    try {
      const items = Object.entries(selectedQuantities)
        .filter(([_, qty]) => qty > 0)
        .map(([ticketTierId, quantity]) => ({ ticketTierId, quantity }));

      const res = await api.checkout.createSession({
        eventId: event.id,
        items,
        customerEmail: trimmedEmail,
        customerName: trimmedName,
        customerPhone: attendeePhone.trim() || undefined,
      });

      if (res.clientSecret) {
        setPaymentSession(res);
        setSessionSnapshotKey(currentSnapshotKey);
        setIsCheckoutOpen(true);
      } else {
        throw new Error('Unable to initialize payment session.');
      }
    } catch (err: any) {
      setCheckoutError(err.message || 'Failed to initiate checkout. Please try again.');
    } finally {
      setIsReserving(false);
    }
  };

  const handleUpdateAttendee = (updated: { name: string; email: string; phone: string }) => {
    setAttendeeName(updated.name);
    setAttendeeEmail(updated.email);
    setAttendeePhone(updated.phone);
  };

  const handleCloseCheckout = () => {
    setIsCheckoutOpen(false);
    if (paymentSession && new Date(paymentSession.expiresAt).getTime() <= Date.now()) {
      setPaymentSession(null);
      setSessionSnapshotKey(null);
    }
  };

  const handleSessionExpired = () => {
    setSessionSnapshotKey(null);
  };

  // 1. Loading State
  if (isLoading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6 animate-pulse">
        <div className="h-4 w-24 bg-gray-100 rounded" />
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          <div className="lg:col-span-7 space-y-4">
            <div className="aspect-[16/10] bg-gray-100 rounded-lg" />
            <div className="h-8 w-3/4 bg-gray-100 rounded" />
            <div className="h-4 w-1/2 bg-gray-100 rounded" />
          </div>
          <div className="lg:col-span-5 h-80 bg-gray-100 rounded-lg" />
        </div>
      </div>
    );
  }

  // 2. Error / 404 State
  if (error || !event) {
    return (
      <div className="max-w-lg mx-auto px-4 py-20 text-center space-y-4">
        <h1 className="text-2xl font-bold text-gray-900">Event not found</h1>
        <p className="text-gray-500 text-sm">
          The requested event could not be found or has concluded.
        </p>
        <div className="pt-2 flex items-center justify-center gap-3">
          <Link
            to="/events"
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-gray-900 text-white font-medium text-xs hover:bg-black transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to events
          </Link>
          <button
            onClick={() => refetch()}
            className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 text-xs font-medium"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const mapSearchUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    `${event.venueName}, ${event.venueAddress}, ${event.city}`
  )}`;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8 bg-white">
      {/* Top Back & Share Navigation */}
      <div className="flex items-center justify-between text-xs">
        <Link
          to="/events"
          className="inline-flex items-center gap-1.5 text-gray-500 hover:text-gray-900 transition-colors font-medium"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Discover events</span>
        </Link>

        <button
          onClick={handleShare}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 text-gray-700 hover:text-black hover:bg-gray-50 transition-colors font-medium"
        >
          {copiedLink ? (
            <>
              <Check className="w-3.5 h-3.5 text-green-600" />
              <span className="text-green-700">Link copied</span>
            </>
          ) : (
            <>
              <Share2 className="w-3.5 h-3.5" />
              <span>Share</span>
            </>
          )}
        </button>
      </div>

      {/* Main 2-Column Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-start">
        {/* Left Column: Poster, Title, Date/Venue, Description, Organizer */}
        <div className="lg:col-span-7 space-y-6">
          {/* Prominent Poster / Cover Image */}
          <div className="relative aspect-[16/10] rounded-lg overflow-hidden bg-gray-100 border border-gray-200">
            <img
              src={event.coverImageUrl}
              alt={event.title}
              className="w-full h-full object-cover"
              onError={(e) => {
                e.currentTarget.src =
                  'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=1600&q=85';
              }}
            />
            {event.isSoldOut && (
              <div className="absolute top-3 right-3">
                <span className="px-2.5 py-1 rounded bg-black text-white font-mono font-bold text-xs uppercase">
                  Sold Out
                </span>
              </div>
            )}
          </div>

          {/* Event Title & Tagline */}
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

          {/* Key Details Row: Date, Time & Venue */}
          <div className="p-4 rounded-lg bg-gray-50 border border-gray-200 grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
            {/* Date & Time */}
            <div className="space-y-1">
              <div className="text-gray-400 font-medium flex items-center gap-1.5 uppercase tracking-wider text-[11px]">
                <Calendar className="w-3.5 h-3.5" />
                <span>Date & Time</span>
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
                {new Date(event.startAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} —{' '}
                {new Date(event.endAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} ({event.timezone})
              </div>
            </div>

            {/* Venue Location */}
            <div className="space-y-1">
              <div className="text-gray-400 font-medium flex items-center justify-between uppercase tracking-wider text-[11px]">
                <span className="flex items-center gap-1.5">
                  <MapPin className="w-3.5 h-3.5" />
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
                {event.venueName}
              </div>
              <div className="text-gray-500 truncate">
                {event.venueAddress}, {event.city}
              </div>
            </div>
          </div>

          {/* Organizer Card */}
          <div className="p-4 rounded-lg border border-gray-200 flex items-center justify-between gap-3 text-xs">
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

            {event.organizer.organizer?.websiteUrl && (
              <a
                href={event.organizer.organizer.websiteUrl}
                target="_blank"
                rel="noreferrer"
                className="text-gray-400 hover:text-black p-2 rounded hover:bg-gray-50"
                title="Organizer Website"
              >
                <ExternalLink className="w-4 h-4" />
              </a>
            )}
          </div>

          {/* Description */}
          <div className="space-y-3 pt-2">
            <h2 className="font-bold text-lg text-gray-900">About this event</h2>
            <div className="text-gray-700 text-sm leading-relaxed whitespace-pre-line font-normal">
              {event.description}
            </div>
          </div>

          {/* Admission & Policies */}
          <div className="p-4 rounded-lg bg-gray-50 border border-gray-200 space-y-2 text-xs text-gray-600">
            <div className="font-semibold text-gray-900">Important Information</div>
            <div className="grid grid-cols-2 gap-2 text-xs pt-1">
              <div>Age Policy: <span className="text-gray-900 font-medium">{event.ageRestriction || '18+'}</span></div>
              <div>Dress Code: <span className="text-gray-900 font-medium">{event.dressCode || 'Open'}</span></div>
            </div>
            <p className="text-gray-500 pt-1 border-t border-gray-200 text-[11px]">
              Please have a digital or printed pass ready at the gate. Valid photo ID matching attendee name may be requested.
            </p>
          </div>
        </div>

        {/* Right Column: Ticket Purchase Panel */}
        <div id="tickets-panel" className="lg:col-span-5 space-y-4">
          <div className="border border-gray-200 rounded-lg p-5 sm:p-6 space-y-5 sticky top-20 bg-white">
            <div className="flex items-center justify-between pb-3 border-b border-gray-100">
              <h2 className="font-bold text-lg text-gray-900">Tickets</h2>
              <span className="text-xs text-gray-500">Official passes</span>
            </div>

            {/* Ticket Tier List */}
            <div className="space-y-3">
              {event.ticketTiers.map((tier: TicketTier) => {
                const qty = selectedQuantities[tier.id] || 0;
                const isSoldOut = tier.status === 'SOLD_OUT' || (tier.remainingCapacity !== undefined && tier.remainingCapacity <= 0);

                return (
                  <div
                    key={tier.id}
                    className={`p-3.5 rounded-lg border transition-colors ${
                      qty > 0
                        ? 'bg-gray-50 border-gray-900'
                        : isSoldOut
                        ? 'bg-gray-50/60 border-gray-200 opacity-60'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-0.5 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-gray-900 text-sm">
                            {tier.name}
                          </span>
                          {isSoldOut && (
                            <span className="text-[10px] text-red-600 font-bold uppercase tracking-wider">
                              Sold out
                            </span>
                          )}
                        </div>

                        {tier.description && (
                          <p className="text-xs text-gray-500 leading-snug">
                            {tier.description}
                          </p>
                        )}

                        <div className="pt-1 font-semibold text-gray-900 text-xs">
                          {formatPrice(tier.priceInCents, tier.currency)}
                        </div>
                      </div>

                      {/* Quantity Stepper */}
                      {!isSoldOut ? (
                        <div className="flex items-center gap-1.5 bg-gray-50 border border-gray-200 rounded-md p-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => updateQuantity(tier.id, -1, tier.maxPerOrder)}
                            disabled={qty === 0 || isReserving}
                            className="w-6 h-6 rounded flex items-center justify-center text-gray-600 hover:text-black hover:bg-gray-200 disabled:opacity-20"
                            aria-label={`Decrease ${tier.name}`}
                          >
                            <Minus className="w-3 h-3" />
                          </button>
                          <span className="w-5 text-center text-xs font-bold text-gray-900">
                            {qty}
                          </span>
                          <button
                            type="button"
                            onClick={() => updateQuantity(tier.id, 1, Math.min(tier.maxPerOrder, tier.remainingCapacity || 10))}
                            disabled={isReserving || qty >= (tier.remainingCapacity || tier.maxPerOrder)}
                            className="w-6 h-6 rounded flex items-center justify-center text-gray-600 hover:text-black hover:bg-gray-200 disabled:opacity-20"
                            aria-label={`Increase ${tier.name}`}
                          >
                            <Plus className="w-3 h-3" />
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>

            {ticketsError && (
              <div className="p-2.5 rounded-md bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 shrink-0 text-rose-600" />
                <span>{ticketsError}</span>
              </div>
            )}

            {/* Attendee Details Form & Continue Button */}
            <form onSubmit={handleProceedToCheckout} className="space-y-3 pt-3 border-t border-gray-100 text-xs" noValidate>
              <div className="space-y-2">
                <div>
                  <label htmlFor="attendee-name" className="font-semibold text-gray-900 block text-xs mb-1">
                    Full name
                  </label>
                  <input
                    id="attendee-name"
                    type="text"
                    placeholder="e.g. Jane Doe"
                    value={attendeeName}
                    onChange={(e) => {
                      setAttendeeName(e.target.value);
                      if (nameError) setNameError(null);
                      if (checkoutError) setCheckoutError(null);
                    }}
                    className={`w-full px-3 py-2 rounded-md bg-white border text-gray-900 placeholder-gray-400 text-xs focus:outline-none transition-colors ${
                      nameError
                        ? 'border-rose-400 focus:border-rose-500 bg-rose-50/20'
                        : 'border-gray-300 focus:border-gray-900'
                    }`}
                  />
                  {nameError && (
                    <p className="text-[11px] text-rose-600 font-medium mt-1">{nameError}</p>
                  )}
                </div>

                <div>
                  <label htmlFor="attendee-email" className="font-semibold text-gray-900 block text-xs mb-1">
                    Email address
                  </label>
                  <input
                    id="attendee-email"
                    type="email"
                    placeholder="e.g. jane@example.com"
                    value={attendeeEmail}
                    onChange={(e) => {
                      setAttendeeEmail(e.target.value);
                      if (emailError) setEmailError(null);
                      if (checkoutError) setCheckoutError(null);
                    }}
                    className={`w-full px-3 py-2 rounded-md bg-white border text-gray-900 placeholder-gray-400 text-xs focus:outline-none transition-colors ${
                      emailError
                        ? 'border-rose-400 focus:border-rose-500 bg-rose-50/20'
                        : 'border-gray-300 focus:border-gray-900'
                    }`}
                  />
                  {emailError && (
                    <p className="text-[11px] text-rose-600 font-medium mt-1">{emailError}</p>
                  )}
                </div>
              </div>

              {/* Ticket Fee Breakdown */}
              {totalTickets > 0 && checkoutFees.ticketSubtotalInCents > 0 && (
                <div className="p-3 rounded-lg bg-gray-50 border border-gray-200/80 space-y-2 text-xs">
                  <div className="flex justify-between text-gray-600">
                    <span>
                      Ticket Subtotal ({totalTickets} ticket{totalTickets === 1 ? '' : 's'})
                    </span>
                    <span className="font-semibold text-gray-900 font-mono">
                      {formatPriceWithCents(checkoutFees.ticketSubtotalInCents, event.currency)}
                    </span>
                  </div>
                  <div className="flex justify-between text-gray-600">
                    <span>Platform Fee (10%)</span>
                    <span className="font-semibold text-gray-900 font-mono">
                      {formatPriceWithCents(checkoutFees.platformFeeInCents, event.currency)}
                    </span>
                  </div>
                  <div className="flex justify-between text-gray-600">
                    <span>Service Fee ($0.95 / ticket)</span>
                    <span className="font-semibold text-gray-900 font-mono">
                      {formatPriceWithCents(checkoutFees.serviceFeeInCents, event.currency)}
                    </span>
                  </div>
                  <div className="flex justify-between text-gray-600">
                    <span>Stripe Processing (est. 2.9% + $0.30)</span>
                    <span className="font-semibold text-gray-900 font-mono">
                      {formatPriceWithCents(checkoutFees.processingFeeInCents, event.currency)}
                    </span>
                  </div>
                </div>
              )}

              <div className="pt-2 flex items-center justify-between text-sm font-bold text-gray-900 border-t border-gray-100">
                <span>Total Payable</span>
                <span className="text-base font-mono text-gray-900">
                  {formatPriceWithCents(totalInCents, event.currency)}
                </span>
              </div>

              <button
                type="submit"
                disabled={isReserving}
                className="w-full py-2.5 rounded-md bg-gray-900 hover:bg-black text-white font-semibold text-xs transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {isReserving ? (
                  <>
                    <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    <span>Preparing checkout...</span>
                  </>
                ) : (
                  <span>Continue to payment · {formatPrice(totalInCents, event.currency)}</span>
                )}
              </button>
            </form>

            {checkoutError && (
              <div className="p-3 rounded-md bg-rose-50 border border-rose-200 text-rose-800 text-xs space-y-1">
                <div className="font-semibold">Checkout Unavailable</div>
                <div className="text-[11px] leading-relaxed">{checkoutError}</div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Mobile Sticky Bottom Bar */}
      <div className="fixed bottom-0 left-0 right-0 z-40 lg:hidden p-3 bg-white border-t border-gray-200 shadow-md">
        <div className="flex items-center justify-between gap-4 max-w-md mx-auto">
          <div>
            <div className="text-[10px] text-gray-500">
              {totalTickets > 0 ? `${totalTickets} ticket(s) selected` : 'Price'}
            </div>
            <div className="text-sm font-bold text-gray-900">
              {totalTickets > 0 ? formatPrice(totalInCents, event.currency) : `From ${formatPrice(event.minPriceInCents, event.currency)}`}
            </div>
          </div>

          <button
            type="button"
            onClick={() => {
              const el = document.getElementById('tickets-panel');
              if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }
            }}
            className="px-4 py-2 rounded-md bg-gray-900 text-white font-semibold text-xs hover:bg-black"
          >
            {totalTickets > 0 ? `Continue · ${formatPrice(totalInCents, event.currency)}` : 'Select Tickets'}
          </button>
        </div>
      </div>

      {/* Checkout Dialog Modal */}
      {event && (
        <CheckoutDialog
          isOpen={isCheckoutOpen}
          onClose={handleCloseCheckout}
          event={event}
          selectedItems={selectedItems}
          attendeeName={attendeeName}
          attendeeEmail={attendeeEmail}
          attendeePhone={attendeePhone}
          onUpdateAttendee={handleUpdateAttendee}
          totalInCents={totalInCents}
          currency={event.currency || 'USD'}
          paymentSession={paymentSession}
          formatPrice={formatPrice}
          onSessionExpired={handleSessionExpired}
        />
      )}
    </div>
  );
};
