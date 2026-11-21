import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import {
  RefreshCw,
  ShieldCheck,
  Mail,
  KeyRound,
  AlertTriangle,
  Loader2,
  RotateCw,
  ArrowLeft,
  Lock,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { api, setActiveCsrfToken } from '../../lib/api';
import { sanitizeRedirectUrl } from '../../lib/utils';
import { EmailVerificationGate } from './EmailVerificationGate';

export interface ScannerSessionContextValue {
  notifySessionExpired: (email?: string, message?: string) => void;
}

export const ScannerSessionContext = createContext<ScannerSessionContextValue | undefined>(undefined);

export function useScannerSession(): ScannerSessionContextValue | undefined {
  return useContext(ScannerSessionContext);
}

export interface ScannerGuardProps {
  children?: React.ReactNode;
  initialSessionExpired?: boolean;
  initialEmail?: string;
}

function buildSafeScannerRedirect(pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  params.delete('invite');
  params.delete('invitation');
  params.delete('token');
  const cleanSearch = params.toString();
  const candidate = `${pathname || '/scanner'}${cleanSearch ? `?${cleanSearch}` : ''}`;
  return sanitizeRedirectUrl(candidate, '/scanner');
}

export const ScannerGuard: React.FC<ScannerGuardProps> = ({
  children,
  initialSessionExpired = false,
  initialEmail = '',
}) => {
  const {
    user,
    isLoading,
    requestLoginOtp: authRequestLoginOtp,
    verifyLoginOtp: authVerifyLoginOtp,
    clearSessionState,
  } = useAuth();
  const location = useLocation();

  const [sessionExpiredMessage, setSessionExpiredMessage] = useState<string | null>(
    initialSessionExpired
      ? 'Your scanner session expired due to inactivity. Sign in with a 6-digit email code to continue scanning.'
      : null
  );
  const [email, setEmail] = useState<string>(initialEmail);
  const [otpRequested, setOtpRequested] = useState<boolean>(false);
  const [otpCode, setOtpCode] = useState<string>('');
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [otpError, setOtpError] = useState<string | null>(null);
  const [isSendingOtp, setIsSendingOtp] = useState<boolean>(false);
  const [isVerifyingOtp, setIsVerifyingOtp] = useState<boolean>(false);
  const [cooldownSeconds, setCooldownSeconds] = useState<number>(0);

  // Defensively strip any legacy invite/token query parameters from the URL
  // (preserving event/slug params) and purge any legacy sessionStorage token.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      sessionStorage.removeItem('outside_scanner_invite_token');
    } catch {}
    try {
      const url = new URL(window.location.href);
      const hasLegacyParam =
        url.searchParams.has('invite') ||
        url.searchParams.has('invitation') ||
        url.searchParams.has('token');
      if (hasLegacyParam && window.history && typeof window.history.replaceState === 'function') {
        url.searchParams.delete('invite');
        url.searchParams.delete('invitation');
        url.searchParams.delete('token');
        const cleanSearch = url.searchParams.toString();
        const cleanPath = url.pathname + (cleanSearch ? `?${cleanSearch}` : '') + url.hash;
        window.history.replaceState(window.history.state, document.title, cleanPath);
      }
    } catch {}
  }, []);

  // Cooldown countdown timer for OTP resend
  useEffect(() => {
    if (cooldownSeconds <= 0) return;
    const interval = setInterval(() => {
      setCooldownSeconds((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [cooldownSeconds]);

  // Reset transient OTP form state once authenticated
  useEffect(() => {
    if (user) {
      setSessionExpiredMessage(null);
      setOtpRequested(false);
      setOtpCode('');
      setOtpError(null);
      setInfoMessage(null);
    }
  }, [user]);

  const notifySessionExpired = useCallback(
    (lastEmail?: string, message?: string) => {
      setSessionExpiredMessage(
        message ||
          'Your scanner session expired due to inactivity. Sign in with a 6-digit email code to continue scanning.'
      );
      if (lastEmail && lastEmail.trim()) {
        setEmail(lastEmail.trim());
      }
      setOtpRequested(false);
      setOtpCode('');
      setOtpError(null);
      setInfoMessage(null);
      if (clearSessionState) {
        clearSessionState();
      } else {
        setActiveCsrfToken(null);
      }
    },
    [clearSessionState]
  );

  const scannerSessionContextValue = useMemo(
    () => ({ notifySessionExpired }),
    [notifySessionExpired]
  );

  const safeRedirectDestination = buildSafeScannerRedirect(location.pathname, location.search);
  const passwordLoginHref = `/login?redirect=${encodeURIComponent(safeRedirectDestination)}`;

  const handleRequestOtp = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const cleanEmail = email.trim();
    if (!cleanEmail) {
      setOtpError('Please enter your registered email address.');
      return;
    }
    if (isSendingOtp || cooldownSeconds > 0) return;

    setIsSendingOtp(true);
    setOtpError(null);
    try {
      const res = authRequestLoginOtp
        ? await authRequestLoginOtp(cleanEmail)
        : await api.auth.requestLoginOtp({ email: cleanEmail });
      setOtpRequested(true);
      setOtpCode('');
      setInfoMessage(
        res.message ||
          'If this email is associated with an eligible passwordless account, a 6-digit sign-in code has been sent.'
      );
      setCooldownSeconds(res.cooldownSeconds || 60);
    } catch (err: any) {
      if (typeof err?.retryAfter === 'number' && err.retryAfter > 0) {
        setCooldownSeconds(Math.ceil(err.retryAfter));
      }
      setOtpError(
        err?.message ||
          err?.error?.message ||
          'Unable to send sign-in code. Please try again.'
      );
    } finally {
      setIsSendingOtp(false);
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanEmail = email.trim();
    const cleanCode = otpCode.trim().replace(/\D/g, '');
    if (!cleanEmail) {
      setOtpError('Please enter your email address.');
      return;
    }
    if (cleanCode.length !== 6) {
      setOtpError('Please enter the complete 6-digit sign-in code sent to your email.');
      return;
    }
    if (isVerifyingOtp) return;

    setIsVerifyingOtp(true);
    setOtpError(null);
    try {
      if (authVerifyLoginOtp) {
        await authVerifyLoginOtp(cleanEmail, cleanCode);
      } else {
        const res = await api.auth.verifyLoginOtp({ email: cleanEmail, code: cleanCode });
        if (res.csrfToken) {
          setActiveCsrfToken(res.csrfToken);
        }
      }
      setSessionExpiredMessage(null);
      setOtpRequested(false);
      setOtpCode('');
      setInfoMessage(null);
    } catch (err: any) {
      if (typeof err?.retryAfter === 'number' && err.retryAfter > 0) {
        setCooldownSeconds(Math.ceil(err.retryAfter));
      }
      setOtpError(
        err?.message ||
          err?.error?.message ||
          'Invalid or expired sign-in code. Please check the code and try again.'
      );
    } finally {
      setIsVerifyingOtp(false);
    }
  };

  // 1. Session hydration loading state (never flash organizer login or OTP form)
  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#FAF8F5] text-stone-900 flex items-center justify-center p-4 selection:bg-stone-900 selection:text-white">
        <div className="flex items-center gap-2.5 text-xs font-mono uppercase tracking-wider text-stone-500">
          <RefreshCw className="w-4 h-4 animate-spin text-stone-700" />
          <span>Loading scanner session...</span>
        </div>
      </div>
    );
  }

  // 2. Unauthenticated state — direct Door Staff Email-OTP authentication + Organizer password sign-in
  if (!user) {
    return (
      <div className="min-h-[80vh] bg-[#FAF8F5] text-stone-900 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-2xl p-8 sm:p-10 border border-stone-200/90 shadow-xs space-y-6">
          <div className="text-center space-y-3">
            <div
              className={`w-16 h-16 rounded-2xl flex items-center justify-center mx-auto border ${
                sessionExpiredMessage
                  ? 'bg-amber-50 text-amber-600 border-amber-200/70'
                  : 'bg-stone-100 text-stone-800 border-stone-200'
              }`}
            >
              {sessionExpiredMessage ? (
                <KeyRound className="w-8 h-8" />
              ) : (
                <ShieldCheck className="w-8 h-8" />
              )}
            </div>

            <div className="space-y-2">
              <span className="px-3 py-1 rounded-full bg-stone-100 text-stone-700 font-mono text-[11px] uppercase tracking-wider font-semibold border border-stone-200 inline-block">
                Door Staff Access
              </span>
              <h1 className="font-display font-extrabold text-2xl text-stone-900 tracking-tight">
                {sessionExpiredMessage ? 'Scanner Session Expired' : 'Sign In to Door Scanner'}
              </h1>
              <p className="text-xs sm:text-sm text-stone-600 leading-relaxed max-w-sm mx-auto font-sans">
                {sessionExpiredMessage
                  ? sessionExpiredMessage
                  : 'Returning door staff can sign in directly with a 6-digit email verification code. Active event assignments determine gate access.'}
              </p>
            </div>
          </div>

          {sessionExpiredMessage && (
            <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-xs flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
              <span>
                Your event staff assignment is unchanged. Request a fresh 6-digit code below to resume scanning.
              </span>
            </div>
          )}

          {otpError && (
            <div
              role="alert"
              className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-start gap-2"
            >
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{otpError}</span>
            </div>
          )}

          {!otpRequested ? (
            <form onSubmit={handleRequestOtp} className="space-y-4">
              <div className="space-y-1.5 text-left">
                <label
                  htmlFor="scanner-otp-email"
                  className="text-xs font-mono font-semibold uppercase text-stone-700 block"
                >
                  Staff Email Address
                </label>
                <input
                  id="scanner-otp-email"
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="staff@venue.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-4 py-3 rounded-xl bg-stone-50 border border-stone-200 text-stone-900 placeholder-stone-400 text-sm focus:outline-none focus:border-stone-900"
                />
              </div>

              <button
                type="submit"
                disabled={isSendingOtp || cooldownSeconds > 0 || !email.trim()}
                className="w-full inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-stone-900 hover:bg-black text-white font-semibold text-xs sm:text-sm font-mono uppercase tracking-wider transition-all duration-200 shadow-xs disabled:opacity-50"
              >
                {isSendingOtp ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Sending Code...
                  </>
                ) : cooldownSeconds > 0 ? (
                  <>
                    <RotateCw className="w-4 h-4" />
                    Wait {cooldownSeconds}s
                  </>
                ) : (
                  <>
                    <Mail className="w-4 h-4" />
                    Send Sign-In Code
                  </>
                )}
              </button>
            </form>
          ) : (
            <form onSubmit={handleVerifyOtp} className="space-y-4">
              {infoMessage && (
                <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs leading-relaxed">
                  {infoMessage}
                </div>
              )}

              <div className="space-y-1.5 text-left">
                <div className="flex items-center justify-between">
                  <label
                    htmlFor="scanner-otp-code"
                    className="text-xs font-mono font-semibold uppercase text-stone-700 block"
                  >
                    Enter 6-Digit Code
                  </label>
                  <span className="text-[11px] font-mono text-stone-500 truncate max-w-[180px]">
                    {email.trim()}
                  </span>
                </div>
                <input
                  id="scanner-otp-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="123456"
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ''))}
                  className="w-full px-4 py-3 text-center tracking-[0.4em] font-mono text-xl font-bold rounded-xl bg-stone-50 border border-stone-200 text-stone-900 focus:outline-none focus:border-stone-900"
                  autoFocus
                />
                <p className="text-[11px] text-stone-500 font-mono">
                  Code expires in 10 minutes · Maximum 5 attempts
                </p>
              </div>

              <button
                type="submit"
                disabled={isVerifyingOtp || otpCode.length !== 6}
                className="w-full inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-xs sm:text-sm font-mono uppercase tracking-wider transition-colors shadow-xs disabled:opacity-50"
              >
                {isVerifyingOtp ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Verifying...
                  </>
                ) : (
                  <>
                    <KeyRound className="w-4 h-4" />
                    Verify &amp; Open Scanner
                  </>
                )}
              </button>

              <div className="flex items-center justify-between pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setOtpRequested(false);
                    setOtpCode('');
                    setOtpError(null);
                    setInfoMessage(null);
                  }}
                  className="text-xs font-mono text-stone-500 hover:text-stone-900 inline-flex items-center gap-1"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  Change email
                </button>
                <button
                  type="button"
                  onClick={() => handleRequestOtp()}
                  disabled={cooldownSeconds > 0 || isSendingOtp}
                  className="text-xs font-mono text-stone-600 hover:text-stone-900 disabled:opacity-50 inline-flex items-center gap-1.5"
                >
                  <RotateCw className="w-3.5 h-3.5" />
                  {cooldownSeconds > 0 ? `Resend in ${cooldownSeconds}s` : 'Resend code'}
                </button>
              </div>
            </form>
          )}

          <div className="pt-4 border-t border-stone-100 text-center space-y-2">
            <Link
              to={passwordLoginHref}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-stone-100 hover:bg-stone-200 text-stone-800 font-semibold text-xs font-mono uppercase tracking-wider transition-colors"
            >
              <Lock className="w-3.5 h-3.5" />
              Sign In with Password (Organizers &amp; Admins)
            </Link>
            <p className="text-[11px] text-stone-400 font-mono leading-relaxed">
              Password-protected accounts must sign in with their password. New door staff should open their one-time invitation link first.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // 3. Authenticated but unverified email
  if (user.emailVerified === false) {
    return (
      <div className="min-h-screen bg-[#FAF8F5] text-stone-900 flex items-center justify-center p-4 selection:bg-stone-900 selection:text-white">
        <EmailVerificationGate
          title="Verify Your Email to Access Scanner"
          subtitle="Enter the 6-digit verification code sent to your email address to unlock ticket scanning."
        />
      </div>
    );
  }

  // 4. Authenticated & verified
  return (
    <ScannerSessionContext.Provider value={scannerSessionContextValue}>
      {children ? <>{children}</> : <Outlet />}
    </ScannerSessionContext.Provider>
  );
};

export default ScannerGuard;
