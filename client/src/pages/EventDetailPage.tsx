import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { TicketTier, CheckoutSessionResult, WaitlistOfferInfo } from '../types';
import { CheckoutDialog } from '../components/events/CheckoutDialog';
import { JoinWaitlistDialog } from '../components/events/JoinWaitlistDialog';
import { calculateCheckoutFeeBreakdown } from '../lib/fees';
import { getYouTubeEmbedUrl } from '../lib/youtube';
import { 
  Calendar, 
  MapPin, 
  Minus, 
  Plus, 
  ArrowLeft,
  ExternalLink,
  Share2,
  Check,
  AlertCircle,
  Lock,
  Eye,
  EyeOff,
  Users,
  Sparkles,
  Image as ImageIcon,
  Clock,
  X
} from 'lucide-react';

export const EventDetailPage: React.FC = () => {
  const { slug } = useParams<{ slug: string }>();
  const [eventAccessToken, setEventAccessToken] = useState<string | null>(() => {
    if (typeof window !== 'undefined' && slug) {
      return sessionStorage.getItem(`outside_event_token_${slug}`);
    }
    return null;
  });
  const [passwordInput, setPasswordInput] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isVerifyingPassword, setIsVerifyingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [activeGalleryModalImage, setActiveGalleryModalImage] = useState<string | null>(null);

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

  const [waitlistModalTier, setWaitlistModalTier] = useState<TicketTier | null>(null);

  const [offerTokenParam] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      const sp = new URLSearchParams(window.location.search);
      return sp.get('offerToken') || sp.get('waitlistToken');
    }
    return null;
  });
  const [offerInfo, setOfferInfo] = useState<WaitlistOfferInfo | null>(null);
  const [offerError, setOfferError] = useState<string | null>(null);
  const [offerSecondsRemaining, setOfferSecondsRemaining] = useState<number | null>(null);
  const [isDecliningOffer, setIsDecliningOffer] = useState(false);
  const [offerDeclinedMessage, setOfferDeclinedMessage] = useState<string | null>(null);

  // Fetch event details by slug (passing eventAccessToken header if authenticated)
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['event', slug, eventAccessToken],
    queryFn: () => api.events.bySlug(slug!, eventAccessToken || undefined),
    enabled: Boolean(slug),
  });

  const event = data?.event;

  useEffect(() => {
    if (!offerTokenParam) return;
    let isMounted = true;
    api.waitlist
      .lookupOffer(offerTokenParam)
      .then((res) => {
        if (!isMounted) return;
        setOfferInfo(res.offer);
        if (res.offer.customerName) setAttendeeName(res.offer.customerName);
        if (res.offer.customerEmail) setAttendeeEmail(res.offer.customerEmail);
        setSelectedQuantities({ [res.offer.ticketTierId]: res.offer.quantity });
        const remaining = Math.max(0, Math.floor((new Date(res.offer.expiresAt).getTime() - Date.now()) / 1000));
        setOfferSecondsRemaining(remaining);
      })
      .catch((err) => {
        if (!isMounted) return;
        setOfferError(err.message || 'Waitlist offer is invalid or has expired.');
      });
    return () => {
      isMounted = false;
    };
  }, [offerTokenParam]);

  useEffect(() => {
    if (offerSecondsRemaining === null || offerSecondsRemaining <= 0) return;
    const timer = setInterval(() => {
      setOfferSecondsRemaining((prev) => {
        if (prev === null || prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [offerSecondsRemaining]);

  const handleDeclineOffer = async () => {
    if (!offerTokenParam || isDecliningOffer) return;
    setIsDecliningOffer(true);
    try {
      const res = await api.waitlist.declineOffer(offerTokenParam);
      setOfferDeclinedMessage(res.message || 'You have declined this waitlist offer. The tickets have been released to the next person.');
      setOfferInfo(null);
      setSelectedQuantities({});
      refetch();
    } catch (err: any) {
      setOfferError(err.message || 'Failed to decline offer.');
    } finally {
      setIsDecliningOffer(false);
    }
  };

  const formatCountdown = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

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

  const handleVerifyPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passwordInput.trim()) {
      setPasswordError('Please enter the event password.');
      return;
    }
    setIsVerifyingPassword(true);
    setPasswordError(null);
    try {
      const res = await api.events.verifyPassword(slug!, passwordInput.trim());
      if (res.eventAccessToken) {
        if (typeof window !== 'undefined') {
          sessionStorage.setItem(`outside_event_token_${slug}`, res.eventAccessToken);
        }
        setEventAccessToken(res.eventAccessToken);
        refetch();
      }
    } catch (err: any) {
      setPasswordError(err.message || 'Incorrect password. Access denied.');
    } finally {
      setIsVerifyingPassword(false);
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

      const isOfferActive = Boolean(offerInfo && (offerSecondsRemaining ?? 0) > 0);

      const res = await api.checkout.createSession({
        eventId: event.id,
        items,
        customerEmail: trimmedEmail,
        customerName: trimmedName,
        customerPhone: attendeePhone.trim() || undefined,
        eventAccessToken: eventAccessToken || undefined,
        offerToken: isOfferActive ? offerInfo!.token : undefined,
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

  if (event.isPasswordProtected && !event.hasAccess) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8 bg-white min-h-[70vh]">
        <div className="flex items-center justify-between text-xs">
          <Link
            to="/events"
            className="inline-flex items-center gap-1.5 text-gray-500 hover:text-gray-900 transition-colors font-medium"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Discover events</span>
          </Link>
        </div>

        <div className="max-w-xl mx-auto space-y-6 pt-4">
          <div className="relative aspect-[16/10] rounded-xl overflow-hidden bg-stone-900 border border-stone-200 shadow-md">
            <img
              src={event.coverImageUrl}
              alt={event.title}
              className="w-full h-full object-cover filter blur-[2px] brightness-75 scale-105"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent flex flex-col justify-end p-6 text-white space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="px-2.5 py-0.5 rounded bg-amber-600 text-white font-mono text-[10px] font-bold uppercase flex items-center gap-1">
                  <Lock className="w-3 h-3" />
                  <span>Private Access</span>
                </span>
                <span className="text-stone-300 font-mono text-xs">
                  {event.city}, {event.country}
                </span>
              </div>
              <h1 className="font-display font-black text-2xl sm:text-3xl uppercase tracking-tight text-white leading-tight">
                {event.title}
              </h1>
              {event.tagline && (
                <p className="text-stone-300 text-xs sm:text-sm line-clamp-2">{event.tagline}</p>
              )}
            </div>
          </div>

          <div className="bg-[#FAF8F5] border border-stone-200 rounded-xl p-6 sm:p-8 space-y-5 text-center shadow-xs">
            <div className="w-12 h-12 rounded-full bg-amber-100 border border-amber-200 text-amber-800 flex items-center justify-center mx-auto shadow-2xs">
              <Lock className="w-6 h-6" />
            </div>

            <div className="space-y-1.5">
              <h2 className="font-display font-black text-xl text-stone-900 uppercase tracking-tight">
                Password Protected Event
              </h2>
              <p className="text-xs text-stone-600 font-sans max-w-md mx-auto">
                This experience is private. Please enter the access password provided by the host to unlock full event details, lineup, and ticket registration.
              </p>
            </div>

            <form onSubmit={handleVerifyPassword} className="space-y-4 max-w-sm mx-auto text-left">
              <div>
                <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
                  Access Password
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    placeholder="Enter password..."
                    value={passwordInput}
                    onChange={(e) => {
                      setPasswordInput(e.target.value);
                      if (passwordError) setPasswordError(null);
                    }}
                    autoFocus
                    className="w-full px-3.5 py-2.5 rounded-lg bg-white border border-stone-300 text-stone-900 placeholder-stone-400 text-sm font-mono focus:outline-none focus:border-stone-900 transition-colors pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-stone-500 hover:text-stone-800 p-1"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {passwordError && (
                <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{passwordError}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={isVerifyingPassword || !passwordInput.trim()}
                className="w-full py-2.5 rounded-lg bg-stone-900 hover:bg-black text-white font-mono text-xs font-bold uppercase tracking-wider transition-colors disabled:opacity-50 flex items-center justify-center gap-2 shadow-2xs"
              >
                {isVerifyingPassword ? (
                  <>
                    <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    <span>Verifying...</span>
                  </>
                ) : (
                  <span>Unlock Event</span>
                )}
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  const mapSearchUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    `${event.venueName}, ${event.venueAddress}, ${event.city}`
  )}`;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8 bg-white">
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

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-start">
        <div className="lg:col-span-7 space-y-6">
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

          <div className={`p-4 rounded-lg bg-gray-50 border border-gray-200 grid grid-cols-1 ${!event.hideGuestCount && typeof event.guestCount === 'number' && event.guestCount > 0 ? 'sm:grid-cols-3' : 'sm:grid-cols-2'} gap-4 text-xs`}>
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

            {!event.hideGuestCount && typeof event.guestCount === 'number' && event.guestCount > 0 && (
              <div className="space-y-1">
                <div className="text-gray-400 font-medium flex items-center gap-1.5 uppercase tracking-wider text-[11px]">
                  <Users className="w-3.5 h-3.5" />
                  <span>Guests Going</span>
                </div>
                <div className="font-semibold text-gray-900 text-sm">
                  {event.guestCount.toLocaleString()} {event.guestCount === 1 ? 'Guest' : 'Guests'}
                </div>
                <div className="text-gray-500">
                  Confirmed attendance
                </div>
              </div>
            )}
          </div>

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

          <div className="space-y-3 pt-2">
            <h2 className="font-bold text-lg text-gray-900">About this event</h2>
            <div className="text-gray-700 text-sm leading-relaxed whitespace-pre-line font-normal">
              {event.description}
            </div>
          </div>

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

          {event.features && event.features.length > 0 && (
            <div className="space-y-4 pt-4 border-t border-gray-100">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-gray-900" />
                <h2 className="font-bold text-lg text-gray-900">Lineup & Features</h2>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {event.features.map((feature, idx) => (
                  <div
                    key={feature.id || feature.name + idx}
                    className="p-3.5 rounded-xl border border-gray-200 bg-gray-50/70 hover:bg-gray-50 transition-colors flex items-start gap-3"
                  >
                    {feature.imageUrl ? (
                      <img
                        src={feature.imageUrl}
                        alt={feature.name}
                        className="w-12 h-12 rounded-full object-cover border border-gray-300 shrink-0"
                      />
                    ) : (
                      <div className="w-12 h-12 rounded-full bg-stone-900 text-white flex items-center justify-center font-display font-bold text-sm shrink-0">
                        {feature.name.charAt(0).toUpperCase()}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-bold text-gray-900 text-sm">{feature.name}</span>
                        <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase bg-white border border-gray-200 text-gray-700">
                          {feature.type}
                        </span>
                      </div>
                      {feature.description && (
                        <p className="text-gray-500 text-xs mt-1 leading-relaxed">{feature.description}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {event.youtubeVideoId && (
            <div className="space-y-3 pt-4 border-t border-gray-100">
              <h2 className="font-bold text-lg text-gray-900">Featured Video</h2>
              <div className="aspect-video rounded-xl overflow-hidden border border-gray-200 bg-black shadow-xs">
                <iframe
                  src={getYouTubeEmbedUrl(event.youtubeVideoId)}
                  title={`${event.title} video`}
                  className="w-full h-full border-0"
                  allow="accelerometer; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                />
              </div>
            </div>
          )}

          {event.galleryImages && event.galleryImages.length > 0 && (
            <div className="space-y-3 pt-4 border-t border-gray-100">
              <div className="flex items-center justify-between">
                <h2 className="font-bold text-lg text-gray-900 flex items-center gap-2">
                  <ImageIcon className="w-4 h-4 text-gray-900" />
                  <span>Event Gallery</span>
                </h2>
                <span className="text-xs font-mono text-gray-500">
                  {event.galleryImages.length} {event.galleryImages.length === 1 ? 'photo' : 'photos'}
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {event.galleryImages.map((img, idx) => (
                  <button
                    key={img.id || img.imageUrl + idx}
                    type="button"
                    onClick={() => setActiveGalleryModalImage(img.imageUrl)}
                    className="group aspect-[4/3] rounded-lg overflow-hidden border border-gray-200 bg-gray-100 relative focus:outline-none focus:ring-2 focus:ring-black cursor-pointer text-left"
                  >
                    <img
                      src={img.imageUrl}
                      alt={`Gallery photo ${idx + 1}`}
                      className="w-full h-full object-cover transition-transform group-hover:scale-105 duration-300"
                    />
                    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div id="tickets-panel" className="lg:col-span-5 space-y-4">
          <div className="border border-gray-200 rounded-lg p-5 sm:p-6 space-y-5 sticky top-20 bg-white">
            <div className="flex items-center justify-between pb-3 border-b border-gray-100">
              <h2 className="font-bold text-lg text-gray-900">Tickets</h2>
              <span className="text-xs text-gray-500">Official passes</span>
            </div>

            {offerInfo && (offerSecondsRemaining ?? 0) > 0 && (
              <div className="p-4 rounded-xl bg-amber-500/10 border-2 border-amber-500 text-stone-900 space-y-3 shadow-xs">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2.5">
                    <Sparkles className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                    <div>
                      <h3 className="font-display font-bold text-sm uppercase text-amber-950">
                        Exclusive Waitlist Ticket Offer
                      </h3>
                      <p className="text-xs text-amber-900 leading-snug">
                        {offerInfo.quantity}x <strong>{offerInfo.tierName}</strong> pass(es) reserved for {offerInfo.customerName}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-600 text-white font-mono text-xs font-bold shrink-0 shadow-2xs">
                    <Clock className="w-3.5 h-3.5" />
                    <span>{formatCountdown(offerSecondsRemaining ?? 0)}</span>
                  </div>
                </div>
                <div className="flex items-center justify-between text-xs text-amber-950 pt-2 border-t border-amber-200">
                  <span>
                    Total: <strong>{formatPrice(offerInfo.totalInCents, offerInfo.currency)}</strong>
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleDeclineOffer}
                      disabled={isDecliningOffer}
                      className="px-3 py-1.5 rounded-lg border border-amber-300 text-amber-900 hover:bg-amber-100 text-xs font-medium transition-colors cursor-pointer"
                    >
                      {isDecliningOffer ? 'Declining...' : 'Decline Offer'}
                    </button>
                    <button
                      type="button"
                      onClick={handleProceedToCheckout}
                      disabled={isReserving}
                      className="px-4 py-1.5 rounded-lg bg-stone-900 hover:bg-black text-white text-xs font-bold transition-colors cursor-pointer"
                    >
                      {isReserving ? 'Reserving...' : 'Claim & Checkout'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {offerTokenParam && ((offerSecondsRemaining !== null && offerSecondsRemaining <= 0) || offerError) && (
              <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-start gap-2.5">
                <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                <div>
                  <div className="font-bold">Waitlist Offer Unavailable</div>
                  <p className="mt-0.5 text-rose-700 leading-relaxed">
                    {offerError || 'Your purchase window has expired. The reserved tickets have been released to the next eligible person in queue.'}
                  </p>
                </div>
              </div>
            )}

            {offerDeclinedMessage && (
              <div className="p-3.5 rounded-xl bg-stone-100 border border-stone-300 text-stone-800 text-xs flex items-start gap-2.5">
                <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                <div>
                  <div className="font-bold">Offer Declined</div>
                  <p className="mt-0.5 text-stone-600 leading-relaxed">{offerDeclinedMessage}</p>
                </div>
              </div>
            )}

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
                        ? tier.waitlistEnabled
                          ? 'bg-amber-50/20 border-amber-200/60'
                          : 'bg-gray-50/60 border-gray-200 opacity-60'
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

                      {!isSoldOut ? (
                        <div className="flex items-center gap-1.5 bg-gray-50 border border-gray-200 rounded-md p-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => updateQuantity(tier.id, -1, tier.maxPerOrder)}
                            disabled={qty === 0 || isReserving}
                            className="w-6 h-6 rounded flex items-center justify-center text-gray-600 hover:text-black hover:bg-gray-200 disabled:opacity-20 cursor-pointer"
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
                            className="w-6 h-6 rounded flex items-center justify-center text-gray-600 hover:text-black hover:bg-gray-200 disabled:opacity-20 cursor-pointer"
                            aria-label={`Increase ${tier.name}`}
                          >
                            <Plus className="w-3 h-3" />
                          </button>
                        </div>
                      ) : tier.waitlistEnabled ? (
                        <button
                          type="button"
                          onClick={() => setWaitlistModalTier(tier)}
                          className="px-3 py-1.5 rounded-lg bg-stone-900 hover:bg-black text-white text-xs font-bold flex items-center gap-1.5 shrink-0 transition-colors shadow-2xs cursor-pointer"
                        >
                          <Clock className="w-3.5 h-3.5 text-amber-400" />
                          <span>Join waitlist</span>
                        </button>
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

      {waitlistModalTier && event && (
        <JoinWaitlistDialog
          isOpen={Boolean(waitlistModalTier)}
          onClose={() => setWaitlistModalTier(null)}
          tier={waitlistModalTier}
          eventSlug={event.slug}
          initialName={attendeeName}
          initialEmail={attendeeEmail}
          initialPhone={attendeePhone}
          formatPrice={formatPrice}
        />
      )}

      {activeGalleryModalImage && (
        <div
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4 backdrop-blur-xs"
          onClick={() => setActiveGalleryModalImage(null)}
        >
          <div className="relative max-w-4xl max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              onClick={() => setActiveGalleryModalImage(null)}
              className="absolute -top-10 right-0 text-white hover:text-stone-300 p-1 cursor-pointer"
            >
              <X className="w-6 h-6" />
            </button>
            <img
              src={activeGalleryModalImage}
              alt="Enlarged gallery photo"
              className="max-h-[85vh] max-w-full rounded-lg object-contain"
            />
          </div>
        </div>
      )}
    </div>
  );
};
