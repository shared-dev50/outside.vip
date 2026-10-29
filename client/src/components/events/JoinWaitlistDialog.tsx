import React, { useState } from 'react';
import { X, Clock, Users, CheckCircle2, AlertCircle, ArrowRight } from 'lucide-react';
import { TicketTier, JoinWaitlistResult } from '../../types';
import { api } from '../../lib/api';

export interface JoinWaitlistDialogProps {
  isOpen: boolean;
  onClose: () => void;
  tier: TicketTier;
  eventSlug: string;
  initialName?: string;
  initialEmail?: string;
  initialPhone?: string;
  formatPrice: (cents?: number, currency?: string) => string;
}

export const JoinWaitlistDialog: React.FC<JoinWaitlistDialogProps> = ({
  isOpen,
  onClose,
  tier,
  eventSlug,
  initialName = '',
  initialEmail = '',
  initialPhone = '',
  formatPrice,
}) => {
  const [name, setName] = useState(initialName);
  const [email, setEmail] = useState(initialEmail);
  const [phone, setPhone] = useState(initialPhone);
  const [quantity, setQuantity] = useState(1);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<JoinWaitlistResult | null>(null);

  if (!isOpen) return null;

  const maxAllowed = Math.max(1, tier.maxPerOrder || 6);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();

    if (!trimmedName) {
      setError('Please enter your full name.');
      return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!trimmedEmail || !emailRegex.test(trimmedEmail)) {
      setError('Please enter a valid email address.');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const res = await api.waitlist.join(eventSlug, {
        ticketTierId: tier.id,
        customerName: trimmedName,
        customerEmail: trimmedEmail,
        customerPhone: phone.trim() || undefined,
        quantity,
      });
      setResult(res);
    } catch (err: any) {
      setError(err?.message || 'Failed to join waitlist. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-white rounded-2xl border border-stone-200 shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-stone-100 bg-[#FAF8F5]">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full bg-amber-100 border border-amber-300 flex items-center justify-center text-amber-800">
              <Clock className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-display font-bold text-sm uppercase text-stone-900">
                Join Ticket Waitlist
              </h3>
              <p className="text-xs text-stone-500 font-sans">
                {tier.name} · {formatPrice(tier.priceInCents, tier.currency)}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-stone-400 hover:text-stone-700 hover:bg-stone-100 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          {result ? (
            /* Success confirmation */
            <div className="space-y-5 text-center">
              <div className="w-14 h-14 rounded-full bg-emerald-50 border border-emerald-200 flex items-center justify-center mx-auto text-emerald-600">
                <CheckCircle2 className="w-8 h-8" />
              </div>
              <div className="space-y-1.5">
                <h4 className="font-display font-bold text-lg text-stone-900">
                  You're on the waitlist!
                </h4>
                <p className="text-xs text-stone-600 leading-relaxed font-sans max-w-xs mx-auto">
                  {result.message}
                </p>
              </div>

              <div className="p-4 rounded-xl bg-[#FAF8F5] border border-stone-200 space-y-2 text-left font-mono text-xs">
                <div className="flex items-center justify-between text-stone-600">
                  <span>Queue Position:</span>
                  <span className="font-bold text-stone-900 text-sm">
                    #{result.entry.position}
                  </span>
                </div>
                <div className="flex items-center justify-between text-stone-600">
                  <span>Ticket Tier:</span>
                  <span className="font-bold text-stone-900">{tier.name}</span>
                </div>
                <div className="flex items-center justify-between text-stone-600">
                  <span>Quantity Requested:</span>
                  <span className="font-bold text-stone-900">{result.entry.quantity}</span>
                </div>
                <div className="flex items-center justify-between text-stone-600">
                  <span>Notification Email:</span>
                  <span className="font-bold text-stone-900 truncate max-w-[180px]">
                    {result.entry.customerEmail}
                  </span>
                </div>
              </div>

              <p className="text-[11px] text-stone-500 font-sans leading-relaxed">
                We'll email you a private, time-limited purchase link as soon as tickets become available in FIFO order. Keep an eye on your inbox!
              </p>

              <button
                type="button"
                onClick={onClose}
                className="w-full py-2.5 px-4 rounded-xl bg-stone-900 hover:bg-black text-white font-mono text-xs font-bold uppercase tracking-wider transition-colors"
              >
                Done
              </button>
            </div>
          ) : (
            /* Registration Form */
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="p-3 rounded-xl bg-amber-50/70 border border-amber-200 text-amber-900 text-xs flex items-start gap-2.5">
                <Users className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                <p className="leading-relaxed">
                  This tier is currently sold out. Join our automated queue to receive a private purchase offer as soon as tickets are released.
                </p>
              </div>

              {error && (
                <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}

              <div className="space-y-1">
                <label className="block text-xs font-mono uppercase font-bold text-stone-700">
                  Full Name <span className="text-rose-600">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Alex Kamau"
                  className="w-full px-3 py-2 rounded-lg bg-stone-50 border border-stone-300 text-stone-900 text-xs focus:outline-none focus:border-stone-900"
                />
              </div>

              <div className="space-y-1">
                <label className="block text-xs font-mono uppercase font-bold text-stone-700">
                  Email Address <span className="text-rose-600">*</span>
                </label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="alex@example.com"
                  className="w-full px-3 py-2 rounded-lg bg-stone-50 border border-stone-300 text-stone-900 text-xs focus:outline-none focus:border-stone-900"
                />
                <p className="text-[10px] text-stone-500">
                  We'll send your purchase offer and claim instructions to this address.
                </p>
              </div>

              <div className="space-y-1">
                <label className="block text-xs font-mono uppercase font-bold text-stone-700">
                  Phone Number (optional)
                </label>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+254 700 000 000"
                  className="w-full px-3 py-2 rounded-lg bg-stone-50 border border-stone-300 text-stone-900 text-xs focus:outline-none focus:border-stone-900"
                />
              </div>

              <div className="space-y-1">
                <label className="block text-xs font-mono uppercase font-bold text-stone-700">
                  Desired Ticket Quantity
                </label>
                <div className="flex items-center justify-between p-2.5 rounded-lg border border-stone-300 bg-stone-50">
                  <span className="text-xs text-stone-700 font-sans">
                    Quantity (Max {maxAllowed} per order)
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={quantity <= 1}
                      onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                      className="w-6 h-6 rounded bg-white border border-stone-200 text-stone-700 font-bold flex items-center justify-center hover:bg-stone-100 disabled:opacity-30 cursor-pointer"
                    >
                      -
                    </button>
                    <span className="font-mono font-bold text-xs w-6 text-center text-stone-900">
                      {quantity}
                    </span>
                    <button
                      type="button"
                      disabled={quantity >= maxAllowed}
                      onClick={() => setQuantity((q) => Math.min(maxAllowed, q + 1))}
                      className="w-6 h-6 rounded bg-white border border-stone-200 text-stone-700 font-bold flex items-center justify-center hover:bg-stone-100 disabled:opacity-30 cursor-pointer"
                    >
                      +
                    </button>
                  </div>
                </div>
              </div>

              <div className="pt-2">
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full py-2.5 px-4 rounded-xl bg-stone-900 hover:bg-black text-white font-mono text-xs font-bold uppercase tracking-wider transition-colors flex items-center justify-center gap-2 disabled:opacity-50 cursor-pointer"
                >
                  {isSubmitting ? (
                    'Joining Waitlist...'
                  ) : (
                    <>
                      <span>Join Queue</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </>
                  )}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
