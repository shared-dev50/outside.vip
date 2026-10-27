import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Elements, CardElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { X, ShieldCheck, Clock, AlertCircle, Lock, CheckCircle2 } from 'lucide-react';
import { Event, TicketTier, CheckoutSessionResult } from '../../types';
import { getStripePromise } from '../../lib/stripe';
import { api } from '../../lib/api';
import { calculateCheckoutFeeBreakdown } from '../../lib/fees';

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

  const [name, setName] = useState(attendeeName);
  const [email, setEmail] = useState(attendeeEmail);
  const [phone, setPhone] = useState(attendeePhone || '');

  // Step state: 'idle' | 'processing' | 'success'
  const [paymentStep, setPaymentStep] = useState<'idle' | 'processing' | 'success'>('idle');
  const [cardError, setCardError] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [secondsRemaining, setSecondsRemaining] = useState<number>(() => {
    const diff = Math.floor((new Date(paymentSession.expiresAt).getTime() - Date.now()) / 1000);
    return Math.max(0, diff);
  });

  const dialogFees = calculateCheckoutFeeBreakdown(
    selectedItems.map(({ tier, quantity }) => ({
      priceInCents: tier.priceInCents,
      quantity,
    }))
  );

  const isBusy = paymentStep === 'processing' || paymentStep === 'success';

  // Notify parent of busy state to prevent closing during in-flight payments
  useEffect(() => {
    onBusyChange?.(isBusy);
  }, [isBusy, onBusyChange]);

  // Keep local state in sync if parent props change
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

  // Reservation hold countdown timer
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

    if (!stripe || !elements || isBusy || isExpired) {
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

    // 1. Immediately disable button and display animated spinner alongside "Processing payment…"
    setPaymentStep('processing');
    setErrorMessage(null);

    try {
      const result = await stripe.confirmCardPayment(paymentSession.clientSecret, {
        payment_method: {
          card: cardElement,
          billing_details: {
            name: currentName,
            email: currentEmail,
            phone: currentPhone || undefined,
          },
        },
      });

      // 3. If Stripe returns an error, stop spinner, display inline error message, and re-enable Pay
      if (result.error) {
        setErrorMessage(
          result.error.message || 'Payment attempt was declined. Please verify your card details and try again.'
        );
        setPaymentStep('idle');
        return;
      }

      // 4. On successful payment confirmation, show brief success state with check icon and
      // "Payment successful — preparing your tickets…" while the existing order-confirmation flow completes.
      if (
        result.paymentIntent &&
        (result.paymentIntent.status === 'succeeded' || result.paymentIntent.status === 'processing')
      ) {
        setPaymentStep('success');

        // 5 & 6. Complete existing order confirmation flow:
        // Poll order status to confirm ticket issuance with backend reconciliation
        const maxAttempts = 6;
        const pollIntervalMs = 1000;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          try {
            const orderRes = await api.orders.getByOrderNumber(
              paymentSession.orderNumber,
              paymentSession.orderAccessToken
            );

            if (
              orderRes?.order?.status === 'COMPLETED' ||
              (orderRes?.order?.tickets && orderRes.order.tickets.length > 0)
            ) {
              break;
            }
          } catch {
            // Keep polling through transient errors
          }

          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }

        // Navigate to the established order confirmation page
        navigate(
          `/orders/${paymentSession.orderNumber}?token=${encodeURIComponent(paymentSession.orderAccessToken)}`
        );
      } else {
        setErrorMessage('Unexpected payment response. Please check your order status or try again.');
        setPaymentStep('idle');
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'An unexpected error occurred while processing your card payment.');
      setPaymentStep('idle');
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Modal Header: Fixed at top */}
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

      {/* Modal Scrollable Body: Single dedicated vertical scroll container */}
      <div
        className="px-5 sm:px-6 py-4 sm:py-5 overflow-y-auto flex-1 min-h-0 space-y-4 bg-[#FAF8F5]/40 overscroll-contain"
        style={{ WebkitOverflowScrolling: 'touch' }}
      >
        {/* Reservation Hold Countdown Banner */}
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

        {/* Compact Order Summary Card */}
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

          {/* Fee breakdown details */}
          {dialogFees.ticketSubtotalInCents > 0 && (
            <div className="pt-3 border-t border-gray-100 space-y-1.5 text-xs text-gray-500">
              <div className="flex justify-between">
                <span>Platform fee (10%)</span>
                <span className="text-gray-700 font-medium font-mono">
                  {formatPrice(dialogFees.platformFeeInCents, currency)}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Service fee ($0.95 / ticket)</span>
                <span className="text-gray-700 font-medium font-mono">
                  {formatPrice(dialogFees.serviceFeeInCents, currency)}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Stripe processing (est. 2.9% + $0.30)</span>
                <span className="text-gray-700 font-medium font-mono">
                  {formatPrice(dialogFees.processingFeeInCents, currency)}
                </span>
              </div>
            </div>
          )}

          <div className="pt-3 border-t border-gray-200 flex items-center justify-between text-sm font-bold text-gray-900">
            <span>Total Payable</span>
            <span className="text-base text-gray-900 font-mono">
              {formatPrice(paymentSession.totalInCents || dialogFees.buyerTotalInCents || totalInCents, currency)}
            </span>
          </div>
        </div>

        {/* Payment Form & Attendee Details */}
        <form onSubmit={handlePayment} className={`space-y-4 ${isExpired ? 'opacity-40 pointer-events-none' : ''}`}>
          {/* Attendee Details Card */}
          <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3 shadow-xs">
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
                  disabled={isBusy}
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
                  disabled={isBusy}
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
                Phone Number <span className="text-gray-400 font-normal">(Optional — for mobile ticket delivery)</span>
              </label>
              <input
                id="dialog-attendee-phone"
                type="tel"
                value={phone}
                disabled={isBusy}
                onChange={(e) => {
                  const val = e.target.value;
                  setPhone(val);
                  onUpdateAttendee?.({ name, email, phone: val });
                }}
                placeholder="e.g. +254 700 000 000"
                className="w-full px-3 py-2 rounded-lg bg-gray-50/60 border border-gray-200 text-gray-900 text-xs focus:bg-white focus:outline-none focus:border-gray-900 transition-colors disabled:opacity-60"
              />
            </div>
          </div>

          {/* CardElement Card: Embedded secure Stripe card entry */}
          <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-2.5 shadow-xs">
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
              } ${isBusy ? 'opacity-60 pointer-events-none' : ''}`}
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
                    disabled: isBusy,
                    style: {
                      base: {
                        fontSize: '13px',
                        color: '#111827',
                        fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
                        '::placeholder': {
                          color: '#9ca3af',
                        },
                        iconColor: '#374151',
                      },
                      invalid: {
                        color: '#e11d48',
                        iconColor: '#e11d48',
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

          {/* Declined or Validation Error Alert */}
          {errorMessage && (
            <div className="p-3.5 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-start gap-2.5 animate-in fade-in">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-600" />
              <div className="space-y-0.5">
                <span className="font-semibold block">Payment Declined</span>
                <span className="text-[11px] leading-relaxed block">{errorMessage}</span>
              </div>
            </div>
          )}

          {/* Pay Button & Cancel */}
          <div className="space-y-2 pt-1">
            <button
              type="submit"
              disabled={!stripe || !elements || !isReady || isBusy || isExpired}
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

            <button
              type="button"
              onClick={onClose}
              disabled={isBusy}
              className="w-full py-2 text-center text-xs text-gray-500 hover:text-gray-900 transition-colors disabled:opacity-30 disabled:pointer-events-none"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>

      {/* Modal Footer Security Badge: Fixed at bottom */}
      <div className="px-5 sm:px-6 py-2.5 sm:py-3 border-t border-gray-100 bg-white flex items-center justify-center gap-1.5 text-[11px] text-gray-400 shrink-0">
        <ShieldCheck className="w-3.5 h-3.5 text-gray-400 shrink-0" />
        <span>End-to-end 256-bit encrypted card checkout via Stripe</span>
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
      </div>
    </div>
  );
};
