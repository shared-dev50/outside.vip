import React, { useEffect, useRef } from 'react';
import {
  X,
  ShieldCheck,
  ArrowUpRight,
  Save,
  RefreshCw,
  AlertCircle,
  Globe,
} from 'lucide-react';
import { StripeConnectCountry, StripeConnectedAccountStatus } from '../../types';

export interface StripeOnboardingGateModalProps {
  isOpen: boolean;
  onClose: () => void;
  accountStatus: StripeConnectedAccountStatus | null;
  supportedCountries: StripeConnectCountry[];
  selectedCountry: string;
  onCountryChange: (countryCode: string) => void;
  onCompleteSetup: () => void;
  onSaveDraft: () => void;
  isStartingSetup: boolean;
  isSavingDraft: boolean;
  errorMessage?: string | null;
  statusNotice?: string | null;
}

const DEFAULT_FALLBACK_COUNTRIES: StripeConnectCountry[] = [
  { code: 'US', name: 'United States' },
  { code: 'CA', name: 'Canada' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'KE', name: 'Kenya' },
  { code: 'NG', name: 'Nigeria' },
  { code: 'ZA', name: 'South Africa' },
];

export const StripeOnboardingGateModal: React.FC<StripeOnboardingGateModalProps> = ({
  isOpen,
  onClose,
  accountStatus,
  supportedCountries,
  selectedCountry,
  onCountryChange,
  onCompleteSetup,
  onSaveDraft,
  isStartingSetup,
  isSavingDraft,
  errorMessage,
  statusNotice,
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const primaryButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  const isBusy = isStartingSetup || isSavingDraft;
  const needsCountrySelection =
    !accountStatus?.connected ||
    accountStatus?.connectionStatus === 'invalid_or_inaccessible';
  const countryOptions =
    supportedCountries.length > 0 ? supportedCountries : DEFAULT_FALLBACK_COUNTRIES;

  useEffect(() => {
    if (!isOpen) return;

    if (typeof document !== 'undefined') {
      previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    }

    const focusTimer = setTimeout(() => {
      primaryButtonRef.current?.focus();
    }, 0);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isBusy) {
        e.preventDefault();
        onClose();
        return;
      }

      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), select:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (!focusable || focusable.length === 0) return;

        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('keydown', handleKeyDown);
    }

    return () => {
      clearTimeout(focusTimer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('keydown', handleKeyDown);
      }
      previouslyFocusedRef.current?.focus?.();
    };
  }, [isOpen, isBusy, onClose]);

  if (!isOpen) return null;

  return (
    <div
      data-testid="stripe-onboarding-gate-backdrop"
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4"
      onClick={() => {
        if (!isBusy) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="stripe-onboarding-gate-title"
        aria-describedby="stripe-onboarding-gate-description"
        data-testid="stripe-onboarding-gate-modal"
        className="w-full max-w-md bg-white rounded-2xl border border-stone-200 shadow-2xl overflow-hidden max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-stone-200/80 bg-[#FAF8F5] shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-amber-100 border border-amber-200/90 flex items-center justify-center text-amber-800 shrink-0">
              <ShieldCheck className="w-4 h-4" />
            </div>
            <div>
              <h3
                id="stripe-onboarding-gate-title"
                className="font-display font-black text-base uppercase tracking-tight text-stone-900"
              >
                Complete Stripe setup
              </h3>
              <p className="text-[11px] font-mono text-stone-500">
                Required before publishing paid events
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isBusy}
            aria-label="Close dialog"
            className="p-1.5 rounded-lg text-stone-400 hover:text-stone-700 hover:bg-stone-200/60 transition-colors disabled:opacity-40"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4 overflow-y-auto">
          <div id="stripe-onboarding-gate-description" className="space-y-2">
            <p className="text-sm font-semibold text-stone-900 font-sans">
              You&apos;re almost ready to publish!
            </p>
            <p className="text-xs text-stone-600 leading-relaxed font-sans">
              To publish your event and receive ticket payments, you need to complete your Stripe
              account setup first.
            </p>
            <p className="text-xs text-stone-600 leading-relaxed font-sans">
              Complete your Stripe setup to continue publishing, or save your event as a draft and
              return later.
            </p>
          </div>

          {statusNotice && (
            <div
              data-testid="stripe-gate-status-notice"
              className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-xs flex items-start gap-2"
            >
              <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <span className="leading-snug font-sans">{statusNotice}</span>
            </div>
          )}

          {errorMessage && (
            <div
              data-testid="stripe-gate-error"
              className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-start gap-2"
            >
              <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
              <span className="leading-snug font-sans">{errorMessage}</span>
            </div>
          )}

          {needsCountrySelection && (
            <div className="p-3.5 rounded-xl bg-[#FAF8F5] border border-stone-200 space-y-1.5">
              <label
                htmlFor="stripe-gate-country-select"
                className="flex items-center gap-1.5 text-[11px] font-mono uppercase font-bold text-stone-700"
              >
                <Globe className="w-3.5 h-3.5 text-stone-500" />
                <span>Payout Country</span>
              </label>
              <select
                id="stripe-gate-country-select"
                value={selectedCountry}
                onChange={(e) => onCountryChange(e.target.value.toUpperCase())}
                disabled={isBusy}
                className="w-full px-3 py-2 rounded-lg bg-white border border-stone-300 text-xs font-mono text-stone-900 focus:outline-none focus:border-stone-900 disabled:bg-stone-100 cursor-pointer"
              >
                {countryOptions.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name} ({c.code})
                  </option>
                ))}
              </select>
            </div>
          )}

          <p className="text-[11px] text-stone-500 font-sans leading-snug">
            Your event and ticket details are saved automatically as a draft before you continue to
            Stripe.
          </p>
        </div>

        <div className="px-6 py-4 border-t border-stone-200/80 bg-[#FAF8F5] flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2.5 shrink-0">
          <button
            type="button"
            data-testid="stripe-gate-save-draft-btn"
            onClick={onSaveDraft}
            disabled={isBusy}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg border border-stone-300 bg-white hover:bg-stone-100 text-stone-900 font-mono text-xs font-semibold transition-colors shadow-2xs disabled:opacity-50"
          >
            {isSavingDraft ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin text-stone-500" />
                <span>Saving Draft...</span>
              </>
            ) : (
              <>
                <Save className="w-3.5 h-3.5 text-stone-500" />
                <span>Save as Draft</span>
              </>
            )}
          </button>

          <button
            ref={primaryButtonRef}
            type="button"
            data-testid="stripe-gate-complete-setup-btn"
            onClick={onCompleteSetup}
            disabled={isBusy}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-stone-900 hover:bg-black text-white font-mono text-xs font-semibold uppercase tracking-wider transition-colors shadow-2xs disabled:opacity-50"
          >
            {isStartingSetup ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                <span>Opening Stripe...</span>
              </>
            ) : (
              <>
                <span>Complete Stripe Setup</span>
                <ArrowUpRight className="w-4 h-4" />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

