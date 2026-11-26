import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Elements, CardElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { X, ShieldCheck, Clock, AlertCircle, Lock, CheckCircle2 } from 'lucide-react';
import { Event, TicketTier, CheckoutSessionResult } from '../../types';
import { getStripePromise } from '../../lib/stripe';
import { api } from '../../lib/api';
import { calculateCheckoutFeeBreakdown } from '../../lib/fees';
import { validateAndNormalizePhone } from '../../lib/phone';
import { useOptionalTheme } from '../../context/ThemeContext';

export interface CheckoutDialogProps {
  isOpen: boolean;
  onClose: () => void;
  event: Event;
  selectedItems: Array<{ tier: TicketTier; quantity: number }>;
  attendeeName: string;
  attendeeEmail: string;
  attendeePhone?: string;
  onUpdateAttendee?: (details: { name: string; email: string; phone: string }) => void;
  totalInCents: number;
  currency?: string;
  paymentSession: CheckoutSessionResult | null;
  formatPrice: (cents?: number, currency?: string) => string;
  onSessionExpired: () => void;
}

interface PaymentContentProps {
  onClose: () => void;
  event: Event;
  selectedItems: Array<{ tier: TicketTier; quantity: number }>;
  attendeeName: string;
  attendeeEmail: string;
  attendeePhone?: string;
  onUpdateAttendee?: (details: { name: string; email: string; phone: string }) => void;
  totalInCents: number;
  currency?: string;
  paymentSession: CheckoutSessionResult;
  formatPrice: (cents?: number, currency?: string) => string;
  onSessionExpired: () => void;
  onBusyChange?: (busy: boolean) => void;
}

const PaymentContent: React.FC<PaymentContentProps> = ({
  onClose,
  event,
  selectedItems,
  attendeeName,
  attendeeEmail,
  attendeePhone,
  onUpdateAttendee,
  totalInCents,
  currency,
  paymentSession,
  formatPrice,
  onSessionExpired,
  onBusyChange,
}) => {
  const stripe = useStripe();
  const elements = useElements();
  const navigate = useNavigate();
  const themeContext = useOptionalTheme();
  const isDarkTheme = themeContext?.resolvedTheme === 'dark';

  const [name, setName] = useState(attendeeName);
  const [email, setEmail] = useState(attendeeEmail);
  const [phone, setPhone] = useState(attendeePhone || '');

  const [paymentStep, setPaymentStep] = useState<
    'idle' | 'processing' | 'awaiting_confirmation' | 'pending_timeout' | 'success'
  >('idle');
  const [cardError, setCardError] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [processingNotice, setProcessingNotice] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [secondsRemaining, setSecondsRemaining] = useState<number>(() => {
    const diff = Math.floor((new Date(paymentSession.expiresAt).getTime() - Date.now()) / 1000);
    return Math.max(0, diff);
  });

  const isMountedRef = useRef(true);
  const activeOrderNumberRef = useRef(paymentSession.orderNumber);
  const attemptTokenRef = useRef(0);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPollTimer = () => {
    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      attemptTokenRef.current += 1;
      clearPollTimer();
    };
  }, []);

  useEffect(() => {
    activeOrderNumberRef.current = paymentSession.orderNumber;
    attemptTokenRef.current += 1;
    clearPollTimer();
    setPaymentStep('idle');
    setErrorMessage(null);
    setProcessingNotice(null);
    setCardError(null);
    const diff = Math.floor((new Date(paymentSession.expiresAt).getTime() - Date.now()) / 1000);
    setSecondsRemaining(Math.max(0, diff));
  }, [paymentSession.orderNumber, paymentSession.expiresAt]);

  const dialogFees = calculateCheckoutFeeBreakdown(
    selectedItems.map(({ tier, quantity }) => ({
      priceInCents: tier.priceInCents,
      quantity,
    }))
  );

  // Actively submitting or waiting for response/navigation locks modal close;
  // pending_timeout locks the form against duplicate payment while letting the buyer close or inspect status.
  const isBusy =
    paymentStep === 'processing' ||
    paymentStep === 'awaiting_confirmation' ||
    paymentStep === 'success';
  const isFormLocked = isBusy || paymentStep === 'pending_timeout' || secondsRemaining <= 0;

  useEffect(() => {
    onBusyChange?.(isBusy);
  }, [isBusy, onBusyChange]);

  useEffect(() => {
    setName(attendeeName);
  }, [attendeeName]);

  useEffect(() => {
    setEmail(attendeeEmail);
  }, [attendeeEmail]);

  useEffect(() => {
    if (attendeePhone !== undefined) {
      setPhone(attendeePhone);
    }
  }, [attendeePhone]);

  useEffect(() => {
    const timer = setInterval(() => {
      const diff = Math.floor((new Date(paymentSession.expiresAt).getTime() - Date.now()) / 1000);
      const remaining = Math.max(0, diff);
      setSecondsRemaining(remaining);
      if (remaining === 0) {
        onSessionExpired();
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [paymentSession.expiresAt, onSessionExpired]);

  const isExpired = secondsRemaining <= 0;

  const formatCountdown = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  };

  const handlePayment = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!stripe || !elements || isFormLocked) {
      return;
    }

    const cardElement = elements.getElement(CardElement);
    if (!cardElement) {
      setErrorMessage('Card entry component could not be loaded. Please refresh the page.');
      return;
    }

    const currentName = name.trim() || attendeeName;
    const currentEmail = email.trim() || attendeeEmail;
    const currentPhone = phone.trim();

    if (!currentName) {
      setErrorMessage('Please provide attendee full name.');
      return;
    }

    if (!currentEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(currentEmail)) {
      setErrorMessage('Please provide a valid attendee email address.');
      return;
    }

    const phoneCheck = validateAndNormalizePhone(currentPhone);
    if (!currentPhone || !phoneCheck.isValid) {
      setErrorMessage(
        phoneCheck.error || 'Please provide a valid phone number (e.g. +1 555-123-4567 or +254 712 345678).'
      );
      return;
    }

    if (!paymentSession.clientSecret) {
      setErrorMessage('Payment session is missing a Stripe client secret. Please refresh and try again.');
      return;
    }

    const sessionOrderNumber = paymentSession.orderNumber;
    const sessionAccessToken = paymentSession.orderAccessToken;
    const runToken = ++attemptTokenRef.current;
    const isStaleAttempt = () =>
      !isMountedRef.current ||
      attemptTokenRef.current !== runToken ||
      activeOrderNumberRef.current !== sessionOrderNumber;

    setPaymentStep('processing');
    setErrorMessage(null);
    setProcessingNotice(null);

    try {
      const result = await stripe.confirmCardPayment(paymentSession.clientSecret, {
        payment_method: {
          card: cardElement,
          billing_details: {
            name: currentName,
            email: currentEmail,
            phone: phoneCheck.normalized || currentPhone,
          },
        },
      });

      if (isStaleAttempt()) return;

      if (result.error) {
        setErrorMessage(
          result.error.message || 'Payment attempt was declined. Please verify your card details and try again.'
        );
        setPaymentStep('idle');
        return;
      }

      const orderStatusUrl = `/orders/${sessionOrderNumber}?token=${encodeURIComponent(
        sessionAccessToken
      )}`;

      if (
        result.paymentIntent?.status === 'succeeded' ||
        result.paymentIntent?.status === 'processing'
      ) {
        const isStripeSucceeded = result.paymentIntent.status === 'succeeded';
        // Never mark a payment as succeeded until server-persisted order state confirms COMPLETED.
        setPaymentStep('awaiting_confirmation');
        setProcessingNotice(
          isStripeSucceeded
            ? 'Payment authorized — awaiting server confirmation before issuing your tickets.'
            : 'Your payment is processing with Stripe. Tickets will be issued once payment verification completes.'
        );

        const maxAttempts = 6;
        const pollIntervalMs = 1000;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          if (isStaleAttempt()) return;

          try {
            const orderRes = await api.orders.getByOrderNumber(
              sessionOrderNumber,
              sessionAccessToken
            );
            if (isStaleAttempt()) return;

            const resolvedOrderStatus: string | null = orderRes?.order?.status || null;
            if (resolvedOrderStatus === 'COMPLETED') {
              setPaymentStep('success');
              setProcessingNotice(null);
              navigate(orderStatusUrl);
              return;
            }

            if (
              resolvedOrderStatus === 'CANCELLED' ||
              resolvedOrderStatus === 'EXPIRED' ||
              resolvedOrderStatus === 'FAILED'
            ) {
              setPaymentStep('idle');
              setProcessingNotice(null);
              setErrorMessage(
                'Your payment session did not complete. Please review your order status or start a new checkout.'
              );
              return;
            }
          } catch {
            if (isStaleAttempt()) return;
            // Continue polling through transient lookup errors
          }

          if (attempt < maxAttempts - 1) {
            await new Promise<void>((resolve) => {
              clearPollTimer();
              pollTimerRef.current = setTimeout(() => {
                pollTimerRef.current = null;
                resolve();
              }, pollIntervalMs);
            });
            if (isStaleAttempt()) return;
          }
        }

        // All 6 polls expired while the order remains PENDING: keep the form locked against duplicate submission.
        setPaymentStep('pending_timeout');
        setProcessingNotice(
          'Your payment is still pending confirmation with our server. Do not resubmit payment — view your order page for live status or close this dialog.'
        );
      } else if (result.paymentIntent?.status === 'canceled') {
        setErrorMessage(
          'This payment session was canceled. Please close this dialog and start a new checkout to try again.'
        );
        setPaymentStep('idle');
      } else {
        setErrorMessage('Unexpected payment response. Please check your order status or try again.');
        setPaymentStep('idle');
      }
    } catch (err: any) {
      if (isStaleAttempt()) return;
      setErrorMessage(err.message || 'An unexpected error occurred while processing your card payment.');
      setPaymentStep('idle');
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-5 sm:px-6 py-3.5 sm:py-4 border-b border-gray-100 flex items-center justify-between bg-white shrink-0">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <h2 id="checkout-dialog-title" className="font-display font-bold text-lg text-gray-900 tracking-tight">
              Checkout
            </h2>
            <span className="font-mono text-[11px] font-semibold text-gray-400 bg-gray-50 border border-gray-200 px-1.5 py-0.5 rounded">
              #{paymentSession.orderNumber}
            </span>
          </div>
          <p className="text-xs text-gray-500 truncate max-w-xs sm:max-w-sm">{event.title}</p>
        </div>

        <button
          type="button"
          onClick={onClose}
          disabled={isBusy}
          aria-label="Close checkout"
          className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-30 disabled:pointer-events-none"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <div
        className="px-5 sm:px-6 py-4 sm:py-5 overflow-y-auto flex-1 min-h-0 space-y-4 bg-[#FAF8F5]/40 overscroll-contain"
        style={{ WebkitOverflowScrolling: 'touch' }}
      >
        <div
          className={`p-3 rounded-lg border text-xs flex items-center justify-between gap-2 ${
            isExpired
              ? 'bg-rose-50 border-rose-200 text-rose-800'
              : secondsRemaining < 180
              ? 'bg-amber-50 border-amber-200 text-amber-800'
              : 'bg-emerald-50 border-emerald-200 text-emerald-800'
          }`}
        >
          <div className="flex items-center gap-1.5 font-medium">
            <Clock className="w-3.5 h-3.5 shrink-0" />
            <span>
              {isExpired ? 'Reservation hold expired' : `Tickets reserved for ${formatCountdown(secondsRemaining)}`}
            </span>
          </div>
          <span className="text-[11px] opacity-80">Guaranteed inventory hold</span>
        </div>

        {isExpired && (
          <div className="p-3.5 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 text-xs space-y-2">
            <p className="font-medium">Your ticket reservation hold has expired.</p>
            <p className="text-[11px] text-rose-700">
              To prevent double-booking, the reserved capacity was returned to the event pool. Please close this dialog and select tickets again.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-md bg-rose-600 text-white font-semibold text-xs hover:bg-rose-700 transition-colors"
            >
              Close & Select Tickets
            </button>
          </div>
        )}

        <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3 shadow-xs">
          <div className="text-[11px] uppercase tracking-wider font-semibold text-gray-400">
            Order Summary
          </div>

          <div className="space-y-2 divide-y divide-gray-100 text-xs">
            {selectedItems.map(({ tier, quantity }) => (
              <div key={tier.id} className="pt-2 first:pt-0 flex items-start justify-between gap-2">
                <div className="space-y-0.5">
                  <div className="font-semibold text-gray-900">
                    {quantity} × {tier.name}
                  </div>
                  <div className="text-gray-400 text-[11px]">
                    {formatPrice(tier.priceInCents, tier.currency)} each
                  </div>
                </div>
                <div className="font-semibold text-gray-900 font-mono">
                  {formatPrice(tier.priceInCents * quantity, tier.currency)}
                </div>
              </div>
            ))}
          </div>

          <div className="pt-3 border-t border-gray-100 space-y-2 text-xs">
            <div className="flex justify-between text-gray-600">
              <span>Ticket price</span>
              <span className="font-semibold text-gray-900 font-mono">
                {dialogFees.ticketSubtotalInCents === 0
                  ? 'Free'
                  : formatPrice(dialogFees.ticketSubtotalInCents, currency)}
              </span>
            </div>

            {dialogFees.customerServiceFeeInCents > 0 && (
              <div className="flex justify-between text-gray-600">
                <span>Service fee</span>
                <span className="font-semibold text-gray-900 font-mono">
                  {formatPrice(dialogFees.customerServiceFeeInCents, currency)}
                </span>
              </div>
            )}

            <div className="pt-2 border-t border-gray-200 flex items-center justify-between text-sm font-bold text-gray-900">
              <span>Total</span>
              <span className="text-base text-gray-900 font-mono">
                {formatPrice(paymentSession.totalInCents || dialogFees.buyerTotalInCents || totalInCents, currency)}
              </span>
            </div>
          </div>
        </div>

        <form
          onSubmit={handlePayment}
          className={`space-y-4 ${isExpired || paymentStep === 'pending_timeout' ? 'opacity-90' : ''}`}
        >
          <div
            className={`bg-white border border-gray-200 rounded-xl p-4 space-y-3 shadow-xs ${
              isExpired || paymentStep === 'pending_timeout' ? 'opacity-50 pointer-events-none' : ''
            }`}
          >
            <div className="flex items-center justify-between">
              <div className="text-[11px] uppercase tracking-wider font-semibold text-gray-400">
                Attendee Details
              </div>
              <span className="text-[10px] text-gray-400">Prefilled from event page</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <label htmlFor="dialog-attendee-name" className="text-[11px] font-medium text-gray-700 block">
                  Full Name
                </label>
                <input
                  id="dialog-attendee-name"
                  type="text"
                  value={name}
                  disabled={isFormLocked}
                  onChange={(e) => {
                    const val = e.target.value;
                    setName(val);
                    onUpdateAttendee?.({ name: val, email, phone });
                  }}
                  placeholder="Full name"
                  required
                  className="w-full px-3 py-2 rounded-lg bg-gray-50/60 border border-gray-200 text-gray-900 text-xs focus:bg-white focus:outline-none focus:border-gray-900 transition-colors disabled:opacity-60"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="dialog-attendee-email" className="text-[11px] font-medium text-gray-700 block">
                  Email Address
                </label>
                <input
                  id="dialog-attendee-email"
                  type="email"
                  value={email}
                  disabled={isFormLocked}
                  onChange={(e) => {
                    const val = e.target.value;
                    setEmail(val);
                    onUpdateAttendee?.({ name, email: val, phone });
                  }}
                  placeholder="Email address"
                  required
                  className="w-full px-3 py-2 rounded-lg bg-gray-50/60 border border-gray-200 text-gray-900 text-xs focus:bg-white focus:outline-none focus:border-gray-900 transition-colors disabled:opacity-60"
                />
              </div>
            </div>

            <div className="space-y-1">
              <label htmlFor="dialog-attendee-phone" className="text-[11px] font-medium text-gray-700 block">
                Phone Number <span className="text-rose-500 font-bold">*</span>
              </label>
              <input
                id="dialog-attendee-phone"
                type="tel"
                value={phone}
                disabled={isFormLocked}
                onChange={(e) => {
                  const val = e.target.value;
                  setPhone(val);
                  onUpdateAttendee?.({ name, email, phone: val });
                }}
                placeholder="e.g. +1 (555) 000-0000 or +254 712 345678"
                required
                className="w-full px-3 py-2 rounded-lg bg-gray-50/60 border border-gray-200 text-gray-900 text-xs focus:bg-white focus:outline-none focus:border-gray-900 transition-colors disabled:opacity-60"
              />
            </div>
          </div>

          <div
            className={`bg-white border border-gray-200 rounded-xl p-4 space-y-2.5 shadow-xs ${
              isExpired || paymentStep === 'pending_timeout' ? 'opacity-50 pointer-events-none' : ''
            }`}
          >
            <div className="flex items-center justify-between">
              <label htmlFor="card-element-container" className="text-[11px] uppercase tracking-wider font-semibold text-gray-500 block">
                Card Details
              </label>
              <div className="flex items-center gap-1.5 text-[11px] text-gray-400 font-medium">
                <Lock className="w-3 h-3 text-emerald-600" />
                <span>256-bit Encrypted</span>
              </div>
            </div>

            <div
              id="card-element-container"
              className={`p-3.5 rounded-lg border bg-white transition-all min-h-[46px] relative ${
                cardError
                  ? 'border-rose-400 ring-1 ring-rose-400'
                  : 'border-gray-200 focus-within:border-gray-900 focus-within:ring-1 focus-within:ring-gray-900'
              } ${isFormLocked ? 'opacity-60 pointer-events-none' : ''}`}
            >
              {!isReady && (
                <div className="absolute inset-x-3.5 inset-y-2.5 flex items-center justify-between text-gray-300 animate-pulse pointer-events-none">
                  <div className="h-4 bg-gray-200/80 rounded w-48" />
                  <div className="h-4 bg-gray-200/80 rounded w-16" />
                </div>
              )}

              <div className={`transition-opacity duration-150 ${isReady ? 'opacity-100' : 'opacity-0'}`}>
                <CardElement
                  onChange={(e) => {
                    if (e.error) {
                      setCardError(e.error.message);
                    } else {
                      setCardError(null);
                    }
                  }}
                  onReady={() => setIsReady(true)}
                  options={{
                    disabled: isFormLocked,
                    style: {
                      base: {
                        fontSize: '13px',
                        color: isDarkTheme ? '#F3F1EC' : '#111827',
                        fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
                        '::placeholder': {
                          color: isDarkTheme ? '#6F7687' : '#9ca3af',
                        },
                        iconColor: isDarkTheme ? '#D1D5DB' : '#374151',
                      },
                      invalid: {
                        color: isDarkTheme ? '#FDA4AF' : '#e11d48',
                        iconColor: isDarkTheme ? '#FDA4AF' : '#e11d48',
                      },
                    },
                    hidePostalCode: false,
                  }}
                />
              </div>
            </div>

            {cardError && (
              <div className="flex items-center gap-1.5 text-[11px] text-rose-600 font-medium pt-0.5">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                <span>{cardError}</span>
              </div>
            )}
          </div>

          {processingNotice && (
            <div
              role="status"
              className="p-3.5 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-xs flex items-start gap-2.5 animate-in fade-in"
            >
              <Clock className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
              <div className="space-y-1.5">
                <span className="font-semibold block">Payment Processing</span>
                <span className="text-[11px] leading-relaxed block">{processingNotice}</span>
              </div>
            </div>
          )}

          {errorMessage && (
            <div className="p-3.5 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-start gap-2.5 animate-in fade-in">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-600" />
              <div className="space-y-0.5">
                <span className="font-semibold block">Payment Declined</span>
                <span className="text-[11px] leading-relaxed block">{errorMessage}</span>
              </div>
            </div>
          )}

          <div className="space-y-2 pt-1">
            {paymentStep === 'pending_timeout' ? (
              <button
                type="button"
                onClick={() =>
                  navigate(
                    `/orders/${paymentSession.orderNumber}?token=${encodeURIComponent(
                      paymentSession.orderAccessToken
                    )}`
                  )
                }
                className="w-full py-3 rounded-lg font-semibold text-xs transition-all flex items-center justify-center gap-2 shadow-sm min-h-[42px] bg-amber-900 hover:bg-amber-950 text-white"
              >
                <span>View Order Status</span>
              </button>
            ) : (
              <button
                type="submit"
                disabled={!stripe || !elements || !isReady || isFormLocked}
                className={`w-full py-3 rounded-lg font-semibold text-xs transition-all flex items-center justify-center gap-2 shadow-sm min-h-[42px] ${
                  paymentStep === 'success'
                    ? 'bg-emerald-600 text-white cursor-default disabled:opacity-100'
                    : 'bg-gray-900 hover:bg-black text-white disabled:opacity-50'
                }`}
              >
                {paymentStep === 'processing' ? (
                  <>
                    <div
                      className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin motion-reduce:animate-none shrink-0"
                      aria-hidden="true"
                    />
                    <span aria-live="polite">Processing payment…</span>
                  </>
                ) : paymentStep === 'awaiting_confirmation' ? (
                  <>
                    <div
                      className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin motion-reduce:animate-none shrink-0"
                      aria-hidden="true"
                    />
                    <span aria-live="polite">Awaiting payment verification…</span>
                  </>
                ) : paymentStep === 'success' ? (
                  <>
                    <CheckCircle2 className="w-4 h-4 text-white shrink-0" aria-hidden="true" />
                    <span aria-live="polite">Payment successful — preparing your tickets…</span>
                  </>
                ) : !isReady ? (
                  <span>Securing Card Form...</span>
                ) : (
                  <span>Pay {formatPrice(paymentSession.totalInCents || dialogFees.buyerTotalInCents || totalInCents, currency)}</span>
                )}
              </button>
            )}

            <button
              type="button"
              onClick={onClose}
              disabled={isBusy}
              className="w-full py-2 text-center text-xs text-gray-500 hover:text-gray-900 transition-colors disabled:opacity-30 disabled:pointer-events-none"
            >
              {paymentStep === 'pending_timeout' ? 'Close' : 'Cancel'}
            </button>
          </div>
        </form>
      </div>

      <div className="px-5 sm:px-6 py-2.5 sm:py-3 border-t border-gray-100 bg-white flex items-center justify-center gap-1.5 text-[11px] text-gray-400 shrink-0">
        <ShieldCheck className="w-3.5 h-3.5 text-gray-400 shrink-0" />
        <span>End-to-end 256-bit encrypted card checkout via Stripe</span>
      </div>
    </div>
  );
};

const FreeCheckoutContent: React.FC<PaymentContentProps> = ({
  onClose,
  event,
  selectedItems,
  attendeeName,
  attendeeEmail,
  totalInCents,
  currency,
  paymentSession,
  formatPrice,
  onBusyChange,
}) => {
  const navigate = useNavigate();
  const [isNavigating, setIsNavigating] = useState(false);

  const handleContinue = () => {
    if (isNavigating) return;
    setIsNavigating(true);
    onBusyChange?.(true);
    navigate(
      `/orders/${paymentSession.orderNumber}?token=${encodeURIComponent(paymentSession.orderAccessToken)}`
    );
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-5 sm:px-6 py-3.5 sm:py-4 border-b border-gray-100 flex items-center justify-between bg-white shrink-0">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <h2 id="checkout-dialog-title" className="font-display font-bold text-lg text-gray-900 tracking-tight">
              Free Registration Confirmed
            </h2>
            <span className="font-mono text-[11px] font-semibold text-gray-400 bg-gray-50 border border-gray-200 px-1.5 py-0.5 rounded">
              #{paymentSession.orderNumber}
            </span>
          </div>
          <p className="text-xs text-gray-500 truncate max-w-xs sm:max-w-sm">{event.title}</p>
        </div>

        <button
          type="button"
          onClick={onClose}
          disabled={isNavigating}
          aria-label="Close checkout"
          className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-30 disabled:pointer-events-none"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="px-5 sm:px-6 py-4 sm:py-5 overflow-y-auto flex-1 min-h-0 space-y-4 bg-[#FAF8F5]/40">
        <div className="p-3 rounded-lg border bg-emerald-50 border-emerald-200 text-emerald-800 text-xs flex items-center gap-2 font-medium">
          <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600" />
          <span>No payment required. Your free tickets are confirmed and ready.</span>
        </div>

        <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3 shadow-xs">
          <div className="text-[11px] uppercase tracking-wider font-semibold text-gray-400">
            Order Summary
          </div>
          <div className="space-y-2 divide-y divide-gray-100 text-xs">
            {selectedItems.map(({ tier, quantity }) => (
              <div key={tier.id} className="pt-2 first:pt-0 flex items-start justify-between gap-2">
                <div className="space-y-0.5">
                  <div className="font-semibold text-gray-900">
                    {quantity} × {tier.name}
                  </div>
                  <div className="text-gray-400 text-[11px]">Free</div>
                </div>
                <div className="font-semibold text-gray-900 font-mono">Free</div>
              </div>
            ))}
          </div>
          <div className="pt-2 border-t border-gray-200 flex items-center justify-between text-sm font-bold text-gray-900">
            <span>Total</span>
            <span className="text-base text-gray-900 font-mono">
              {formatPrice(paymentSession.totalInCents ?? totalInCents, currency)}
            </span>
          </div>
        </div>

        <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-1 text-xs shadow-xs">
          <div className="text-[11px] uppercase tracking-wider font-semibold text-gray-400">
            Attendee
          </div>
          <div className="font-semibold text-gray-900">{attendeeName}</div>
          <div className="text-gray-600">{attendeeEmail}</div>
        </div>

        <div className="space-y-2 pt-1">
          <button
            type="button"
            onClick={handleContinue}
            disabled={isNavigating}
            className="w-full py-3 rounded-lg font-semibold text-xs transition-all flex items-center justify-center gap-2 shadow-sm min-h-[42px] bg-gray-900 hover:bg-black text-white disabled:opacity-50"
          >
            <span>{isNavigating ? 'Opening tickets...' : 'View & Download Tickets'}</span>
          </button>

          <button
            type="button"
            onClick={onClose}
            disabled={isNavigating}
            className="w-full py-2 text-center text-xs text-gray-500 hover:text-gray-900 transition-colors disabled:opacity-30 disabled:pointer-events-none"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export const CheckoutDialog: React.FC<CheckoutDialogProps> = ({
  isOpen,
  onClose,
  event,
  selectedItems,
  attendeeName,
  attendeeEmail,
  attendeePhone,
  onUpdateAttendee,
  totalInCents,
  currency,
  paymentSession,
  formatPrice,
  onSessionExpired,
}) => {
  const [isBusy, setIsBusy] = useState(false);

  // Prevent background scrolling while modal is open
  useEffect(() => {
    if (isOpen) {
      const originalStyle = window.getComputedStyle(document.body).overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = originalStyle;
      };
    }
  }, [isOpen]);

  // Close on Escape key (unless payment is in progress)
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isBusy) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose, isBusy]);

  if (!isOpen || !paymentSession) {
    return null;
  }

  const isFreeSession =
    paymentSession.isFreeOrder === true ||
    paymentSession.paymentProvider === 'FREE' ||
    (paymentSession.totalInCents === 0 && !paymentSession.clientSecret);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="checkout-dialog-title"
      className="fixed inset-0 z-50 overflow-y-auto overscroll-none p-3 sm:p-4 md:p-6 flex min-h-full items-center justify-center bg-black/60 backdrop-blur-xs animate-in fade-in duration-200"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isBusy) {
          onClose();
        }
      }}
    >
      <div
        className="w-full max-w-lg bg-white rounded-2xl border border-gray-200/80 shadow-2xl flex flex-col max-h-[calc(100dvh-1.5rem)] sm:max-h-[min(90vh,90dvh)] min-h-0 overflow-hidden my-auto animate-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {isFreeSession ? (
          <FreeCheckoutContent
            onClose={onClose}
            event={event}
            selectedItems={selectedItems}
            attendeeName={attendeeName}
            attendeeEmail={attendeeEmail}
            attendeePhone={attendeePhone}
            onUpdateAttendee={onUpdateAttendee}
            totalInCents={totalInCents}
            currency={currency}
            paymentSession={paymentSession}
            formatPrice={formatPrice}
            onSessionExpired={onSessionExpired}
            onBusyChange={setIsBusy}
          />
        ) : (
          <Elements stripe={getStripePromise(paymentSession.publishableKey)}>
            <PaymentContent
              onClose={onClose}
              event={event}
              selectedItems={selectedItems}
              attendeeName={attendeeName}
              attendeeEmail={attendeeEmail}
              attendeePhone={attendeePhone}
              onUpdateAttendee={onUpdateAttendee}
              totalInCents={totalInCents}
              currency={currency}
              paymentSession={paymentSession}
              formatPrice={formatPrice}
              onSessionExpired={onSessionExpired}
              onBusyChange={setIsBusy}
            />
          </Elements>
        )}
      </div>
    </div>
  );
};
