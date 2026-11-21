import React, { useState, useEffect, useContext } from 'react';
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom';
import { QueryClientContext } from '@tanstack/react-query';
import {
  Shield,
  Megaphone,
  Mail,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  ExternalLink,
  Copy,
  Check,
  Building2,
  Calendar,
  AlertCircle,
  LogOut,
  ArrowRight,
  Sparkles,
  KeyRound,
  RotateCw,
} from 'lucide-react';
import { api, setActiveCsrfToken } from '../lib/api';
import { TeamInvitationMetadata, AcceptTeamInvitationResult } from '../types';
import { useOptionalAuth } from '../context/AuthContext';

export interface TeamInvitationPageProps {
  initialInvitation?: TeamInvitationMetadata | null;
}

export const TeamInvitationPage: React.FC<TeamInvitationPageProps> = ({
  initialInvitation,
}) => {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const auth = useOptionalAuth();
  const queryClient = useContext(QueryClientContext);
  const user = auth?.user;
  const isAuthLoading = auth?.isLoading ?? false;

  const [isLoading, setIsLoading] = useState<boolean>(initialInvitation === undefined);
  const [error, setError] = useState<string | null>(null);
  const [invitation, setInvitation] = useState<TeamInvitationMetadata | null>(
    initialInvitation ?? null
  );

  // Acceptance state
  const [isAccepting, setIsAccepting] = useState<boolean>(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [isAccountMismatch, setIsAccountMismatch] = useState<boolean>(false);
  const [acceptanceResult, setAcceptanceResult] = useState<AcceptTeamInvitationResult | null>(null);

  // Inline passwordless email-OTP sign-in state (HOST invitations ONLY — existing passwordless accounts)
  const [otpEmail, setOtpEmail] = useState<string>('');
  const [otpRequested, setOtpRequested] = useState<boolean>(false);
  const [otpCode, setOtpCode] = useState<string>('');
  const [otpInfoMessage, setOtpInfoMessage] = useState<string | null>(null);
  const [otpError, setOtpError] = useState<string | null>(null);
  const [isSendingOtp, setIsSendingOtp] = useState<boolean>(false);
  const [isVerifyingOtp, setIsVerifyingOtp] = useState<boolean>(false);
  const [otpCooldownSeconds, setOtpCooldownSeconds] = useState<number>(0);

  // Link copy state
  const [copiedLink, setCopiedLink] = useState<boolean>(false);

  useEffect(() => {
    if (otpCooldownSeconds <= 0) return;
    const timer = setInterval(() => {
      setOtpCooldownSeconds((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [otpCooldownSeconds]);

  useEffect(() => {
    if (initialInvitation !== undefined) return;
    let isMounted = true;

    async function inspectInvitation() {
      if (!token) {
        setError('Missing invitation token.');
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      setError(null);
      try {
        const metadata = await api.team.inspectInvitation(token);
        if (isMounted) {
          setInvitation(metadata);
        }
      } catch (err: any) {
        if (isMounted) {
          const msg =
            err?.message ||
            err?.error?.message ||
            'This invitation link is invalid or could not be loaded.';
          setError(msg);
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    inspectInvitation();
    return () => {
      isMounted = false;
    };
  }, [token, initialInvitation]);

  const handleRequestHostOtp = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const cleanEmail = otpEmail.trim();
    if (!cleanEmail) {
      setOtpError('Please enter your registered email address.');
      return;
    }
    if (isSendingOtp || otpCooldownSeconds > 0) return;

    setIsSendingOtp(true);
    setOtpError(null);
    try {
      const res = auth?.requestLoginOtp
        ? await auth.requestLoginOtp(cleanEmail)
        : await api.auth.requestLoginOtp({ email: cleanEmail });
      setOtpRequested(true);
      setOtpCode('');
      setOtpInfoMessage(
        res.message ||
          'If an eligible passwordless account exists for this email, a 6-digit sign-in code has been sent.'
      );
      setOtpCooldownSeconds(res.cooldownSeconds || 60);
    } catch (err: any) {
      if (typeof err?.retryAfter === 'number' && err.retryAfter > 0) {
        setOtpCooldownSeconds(Math.ceil(err.retryAfter));
      }
      setOtpError(err?.message || 'Unable to send sign-in code. Please try again.');
    } finally {
      setIsSendingOtp(false);
    }
  };

  const handleVerifyHostOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanEmail = otpEmail.trim();
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
      if (auth?.verifyLoginOtp) {
        await auth.verifyLoginOtp(cleanEmail, cleanCode);
      } else {
        const res = await api.auth.verifyLoginOtp({ email: cleanEmail, code: cleanCode });
        if (res.csrfToken) {
          setActiveCsrfToken(res.csrfToken);
        }
        await auth?.refreshUser?.();
      }
      setOtpRequested(false);
      setOtpCode('');
      setOtpInfoMessage(null);
    } catch (err: any) {
      if (typeof err?.retryAfter === 'number' && err.retryAfter > 0) {
        setOtpCooldownSeconds(Math.ceil(err.retryAfter));
      }
      setOtpError(
        err?.message ||
          'Invalid or expired sign-in code. Password-based accounts must sign in with their password.'
      );
    } finally {
      setIsVerifyingOtp(false);
    }
  };

  const handleAccept = async () => {
    if (!token) return;
    setIsAccepting(true);
    setAcceptError(null);
    setIsAccountMismatch(false);

    try {
      const result = await api.team.acceptInvitation(token);
      setAcceptanceResult(result);
      await Promise.all([
        queryClient?.invalidateQueries({ queryKey: ['host-events'] }),
        queryClient?.invalidateQueries({ queryKey: ['host-analytics'] }),
        queryClient?.invalidateQueries({ queryKey: ['organizer-events'] }),
        queryClient?.invalidateQueries({ queryKey: ['organizer-dashboard'] }),
        auth?.refreshUser?.(),
      ]);
    } catch (err: any) {
      const status = err?.statusCode || err?.status;
      if (status === 401) {
        auth?.clearSessionState?.();
        return;
      }
      const msg = err?.message || err?.error?.message || 'Failed to accept invitation.';
      if (
        msg.toLowerCase().includes('match') ||
        msg.toLowerCase().includes('recipient') ||
        msg.toLowerCase().includes('account email')
      ) {
        setIsAccountMismatch(true);
      }
      setAcceptError(msg);
    } finally {
      setIsAccepting(false);
    }
  };

  const handleCopyHostLink = (slug: string) => {
    const origin = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : '';
    const url = origin ? `${origin}/r/${slug}` : `/r/${slug}`;
    navigator.clipboard.writeText(url);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2500);
  };

  const handleSwitchAccount = async () => {
    if (auth?.logout) {
      await auth.logout();
    }
    navigate(`/login?redirect=${encodeURIComponent(location.pathname)}`);
  };

  // Loading state
  if (isLoading || isAuthLoading) {
    return (
      <div className="min-h-[70vh] flex items-center justify-center p-4">
        <div className="flex items-center gap-3 text-xs font-mono uppercase tracking-wider text-stone-500">
          <Loader2 className="w-5 h-5 animate-spin text-stone-900" />
          <span>Inspecting Team Invitation...</span>
        </div>
      </div>
    );
  }

  // Error / Invalid / Expired / Already Accepted State
  if (error || !invitation) {
    const isRevoked = error?.toLowerCase().includes('revoked');
    const isAlreadyAccepted = error?.toLowerCase().includes('already been accepted');
    const isExpired = error?.toLowerCase().includes('expired');

    return (
      <div className="max-w-md mx-auto px-4 py-16 text-center space-y-6">
        <div
          className={`w-14 h-14 rounded-2xl mx-auto flex items-center justify-center border ${
            isAlreadyAccepted
              ? 'bg-emerald-50 text-emerald-600 border-emerald-200'
              : isRevoked
                ? 'bg-rose-50 text-rose-600 border-rose-200'
                : 'bg-amber-50 text-amber-600 border-amber-200'
          }`}
        >
          {isAlreadyAccepted ? (
            <CheckCircle2 className="w-7 h-7" />
          ) : (
            <AlertTriangle className="w-7 h-7" />
          )}
        </div>

        <div className="space-y-2">
          <h1 className="font-display font-bold text-2xl text-stone-900">
            {isAlreadyAccepted
              ? 'Invitation Already Accepted'
              : isRevoked
                ? 'Invitation Revoked'
                : isExpired
                  ? 'Invitation Expired'
                  : 'Invitation Unavailable'}
          </h1>
          <p className="text-xs text-stone-600 leading-relaxed max-w-sm mx-auto">
            {error || 'This invitation could not be found or has already been used.'}
          </p>
        </div>

        <div className="pt-2 flex flex-wrap items-center justify-center gap-3">
          {isAlreadyAccepted ? (
            <>
              <Link
                to="/host"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-stone-900 hover:bg-black text-white text-xs font-mono uppercase font-bold tracking-wider transition-colors shadow-xs"
              >
                Go to Host Workspace
              </Link>
              <Link
                to="/organizer"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl border border-stone-200 bg-white hover:bg-stone-50 text-stone-800 text-xs font-mono uppercase font-bold tracking-wider transition-colors shadow-2xs"
              >
                Organizer Studio
              </Link>
            </>
          ) : (
            <Link
              to="/events"
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-stone-900 hover:bg-black text-white text-xs font-mono uppercase font-bold tracking-wider transition-colors shadow-xs"
            >
              Explore Events
            </Link>
          )}
        </div>
      </div>
    );
  }

  const isHost = invitation.role === 'HOST';

  return (
    <div className="max-w-lg mx-auto px-4 py-12 space-y-8">
      {/* Header Badge & Title */}
      <div className="text-center space-y-3">
        <div
          className={`inline-flex items-center gap-2 px-3.5 py-1 rounded-full text-xs font-mono uppercase tracking-wider font-semibold border ${
            isHost
              ? 'bg-amber-50 text-amber-800 border-amber-300'
              : 'bg-purple-50 text-purple-800 border-purple-200'
          }`}
        >
          {isHost ? (
            <>
              <Megaphone className="w-3.5 h-3.5 text-amber-600" />
              Event Host Invitation
            </>
          ) : (
            <>
              <Shield className="w-3.5 h-3.5 text-purple-600" />
              Event Admin Invitation
            </>
          )}
        </div>

        <h1 className="text-2xl sm:text-3xl font-display font-bold text-stone-900 tracking-tight">
          Join Event Team
        </h1>

        <p className="text-sm text-stone-600 max-w-sm mx-auto">
          You've been invited by <strong className="text-stone-900">{invitation.organizerName}</strong> to join the team for{' '}
          <strong className="text-stone-900">{invitation.eventTitle}</strong> as an {invitation.role}.
        </p>
      </div>

      {/* Event Overview Card */}
      <div className="bg-white rounded-2xl p-6 border border-stone-200 shadow-sm space-y-4">
        <div>
          <span className="text-[10px] font-mono uppercase tracking-wider text-stone-500 font-semibold block mb-1">
            Target Event
          </span>
          <h2 className="text-lg font-display font-bold text-stone-900">
            {invitation.eventTitle}
          </h2>
        </div>

        <div className="space-y-2 pt-2 border-t border-stone-100 text-xs text-stone-600 font-sans">
          <div className="flex items-center gap-2">
            <Building2 className="w-4 h-4 text-stone-400 shrink-0" />
            <span>Organized by {invitation.organizerName}</span>
          </div>
          <div className="flex items-center gap-2">
            <Mail className="w-4 h-4 text-stone-400 shrink-0" />
            <span>Invited recipient: <strong className="font-mono text-stone-800">{invitation.emailMasked}</strong></span>
          </div>
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-stone-400 shrink-0" />
            <span>Expires on: {new Date(invitation.expiresAt).toLocaleDateString()}</span>
          </div>
        </div>
      </div>

      {/* Acceptance Success View */}
      {acceptanceResult ? (
        <div className="bg-white rounded-2xl p-6 border border-emerald-200 bg-emerald-50/20 shadow-sm text-center space-y-5 animate-in fade-in duration-300">
          <div className="w-12 h-12 rounded-2xl bg-emerald-100 text-emerald-800 mx-auto flex items-center justify-center">
            <CheckCircle2 className="w-6 h-6 text-emerald-600" />
          </div>

          <div className="space-y-1">
            <h3 className="font-display font-bold text-stone-900 text-lg">
              Welcome to the Team!
            </h3>
            <p className="text-xs text-stone-600 max-w-sm mx-auto">
              Your membership as an <strong className="text-stone-900">{acceptanceResult.role}</strong> is now active.
            </p>
          </div>

          {/* Host Personal Promotional Link Box */}
          {acceptanceResult.role === 'HOST' && acceptanceResult.hostLink && (
            <div className="p-4 rounded-xl bg-white border border-amber-200 text-left space-y-3 shadow-2xs">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-amber-500" />
                <span className="text-xs font-mono uppercase font-bold text-stone-900">
                  Your Personal Promotional Link
                </span>
              </div>
              <p className="text-[11px] text-stone-500 leading-relaxed">
                Share this personalized link with your network. All incoming visits will be tracked under your profile:
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={
                    typeof window !== 'undefined' && window.location?.origin
                      ? `${window.location.origin}/r/${acceptanceResult.hostLink.slug}`
                      : `/r/${acceptanceResult.hostLink.slug}`
                  }
                  className="w-full bg-stone-50 border border-stone-200 px-3 py-2 rounded-lg text-xs font-mono text-stone-800 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => handleCopyHostLink(acceptanceResult.hostLink!.slug)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-stone-900 hover:bg-black text-white text-xs font-mono uppercase font-semibold transition-colors cursor-pointer shrink-0 shadow-2xs"
                >
                  {copiedLink ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      Copied!
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      Copy
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          <div className="pt-2 flex flex-col sm:flex-row items-center justify-center gap-3">
            {acceptanceResult.role === 'ADMIN' ? (
              <Link
                to="/organizer"
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-stone-900 hover:bg-black text-white text-xs font-mono uppercase font-bold tracking-wider transition-colors shadow-xs"
              >
                Go to Organizer Studio
                <ArrowRight className="w-4 h-4" />
              </Link>
            ) : (
              <>
                <Link
                  to="/host"
                  className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-stone-900 hover:bg-black text-white text-xs font-mono uppercase font-bold tracking-wider transition-colors shadow-xs"
                >
                  Go to Host Workspace
                  <ArrowRight className="w-4 h-4" />
                </Link>
                <Link
                  to={`/events/${invitation.eventSlug}`}
                  className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl border border-stone-200 bg-white hover:bg-stone-50 text-stone-800 text-xs font-mono uppercase font-bold tracking-wider transition-colors shadow-2xs"
                >
                  View Public Event
                  <ExternalLink className="w-4 h-4" />
                </Link>
              </>
            )}
          </div>
        </div>
      ) : !user ? (
        /* Unauthenticated State */
        <div className="bg-white rounded-2xl p-6 border border-stone-200 shadow-sm space-y-6">
          <div className="text-center space-y-3">
            <div className="w-12 h-12 rounded-2xl bg-stone-100 text-stone-600 mx-auto flex items-center justify-center">
              <Mail className="w-6 h-6" />
            </div>

            <div className="space-y-1">
              <h3 className="font-display font-bold text-stone-900 text-base">
                Sign In to Accept Invitation
              </h3>
              <p className="text-xs text-stone-600 max-w-sm mx-auto leading-relaxed">
                To accept, you must sign in or register with your verified Outside.vip account matching{' '}
                <strong className="font-mono text-stone-900">{invitation.emailMasked}</strong>.
              </p>
            </div>

            <div className="pt-1">
              <Link
                to={
                  isHost
                    ? `/login?redirect=${encodeURIComponent(location.pathname)}`
                    : `/login?redirect=${encodeURIComponent(location.pathname)}&requirePassword=1`
                }
                className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl bg-stone-900 hover:bg-black text-white text-xs font-mono uppercase font-bold tracking-wider transition-colors shadow-xs"
              >
                {isHost ? 'Sign In or Create Password Account' : 'Sign In / Register'}
                <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          </div>

          {/* Passwordless Email-Code Sign-In: strictly for HOST invitations & existing passwordless accounts */}
          {isHost && (
            <div className="pt-5 border-t border-stone-200 space-y-4">
              <div className="text-center space-y-1">
                <div className="inline-flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider font-bold text-stone-700">
                  <KeyRound className="w-3.5 h-3.5 text-amber-600" />
                  <span>Already Have a Passwordless Account?</span>
                </div>
                <p className="text-[11px] text-stone-500 max-w-sm mx-auto leading-relaxed">
                  Existing door scanner or passwordless accounts matching{' '}
                  <strong className="font-mono text-stone-800">{invitation.emailMasked}</strong> can sign in with a 6-digit email code below without creating a second account.
                </p>
              </div>

              {otpError && (
                <div
                  role="alert"
                  className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-start gap-2"
                >
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-600" />
                  <span>{otpError}</span>
                </div>
              )}

              {!otpRequested ? (
                <form onSubmit={handleRequestHostOtp} className="space-y-3">
                  <div>
                    <label
                      htmlFor="host-invite-otp-email"
                      className="block text-[11px] font-mono uppercase tracking-wider text-stone-600 mb-1"
                    >
                      Registered Email Address
                    </label>
                    <input
                      id="host-invite-otp-email"
                      type="email"
                      required
                      autoComplete="email"
                      value={otpEmail}
                      onChange={(e) => setOtpEmail(e.target.value)}
                      placeholder="you@example.com"
                      className="w-full px-3.5 py-2.5 rounded-xl bg-stone-50 border border-stone-200 text-sm text-stone-900 placeholder:text-stone-400 focus:outline-none focus:border-stone-900"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={isSendingOtp || otpCooldownSeconds > 0 || !otpEmail.trim()}
                    className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-stone-300 bg-stone-50 hover:bg-stone-100 text-stone-900 font-semibold text-xs font-mono uppercase tracking-wider transition-colors disabled:opacity-50 cursor-pointer"
                  >
                    {isSendingOtp ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        Sending Code...
                      </>
                    ) : otpCooldownSeconds > 0 ? (
                      <>
                        <RotateCw className="w-3.5 h-3.5" />
                        Wait {otpCooldownSeconds}s
                      </>
                    ) : (
                      <>
                        <Mail className="w-3.5 h-3.5" />
                        Send 6-Digit Email Code
                      </>
                    )}
                  </button>
                </form>
              ) : (
                <form onSubmit={handleVerifyHostOtp} className="space-y-3">
                  {otpInfoMessage && (
                    <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs leading-relaxed">
                      {otpInfoMessage}
                    </div>
                  )}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label
                        htmlFor="host-invite-otp-code"
                        className="block text-[11px] font-mono uppercase tracking-wider text-stone-600"
                      >
                        6-Digit Verification Code
                      </label>
                      <button
                        type="button"
                        onClick={() => {
                          setOtpRequested(false);
                          setOtpCode('');
                          setOtpInfoMessage(null);
                          setOtpError(null);
                        }}
                        className="text-[11px] text-stone-500 hover:text-stone-900"
                      >
                        Change email
                      </button>
                    </div>
                    <input
                      id="host-invite-otp-code"
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      required
                      value={otpCode}
                      onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder="123456"
                      className="w-full px-3.5 py-2.5 rounded-xl bg-stone-50 border border-stone-200 text-center font-mono text-lg tracking-[0.35em] text-stone-900 focus:outline-none focus:border-stone-900"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={isVerifyingOtp || otpCode.length !== 6}
                    className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-stone-900 hover:bg-black text-white font-semibold text-xs font-mono uppercase tracking-wider transition-colors disabled:opacity-50 cursor-pointer"
                  >
                    {isVerifyingOtp ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        Verifying Code...
                      </>
                    ) : (
                      <>
                        <Check className="w-3.5 h-3.5" />
                        Verify Code &amp; Continue
                      </>
                    )}
                  </button>
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => handleRequestHostOtp()}
                      disabled={isSendingOtp || otpCooldownSeconds > 0}
                      className="inline-flex items-center gap-1 text-[11px] font-mono text-stone-600 hover:text-stone-900 disabled:opacity-50"
                    >
                      <RotateCw className="w-3 h-3" />
                      {otpCooldownSeconds > 0 ? `Resend in ${otpCooldownSeconds}s` : 'Resend Code'}
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}
        </div>
      ) : user.emailVerified === false ? (
        /* Email Not Verified */
        <div className="bg-white rounded-2xl p-6 border border-amber-200 bg-amber-50/30 shadow-sm text-center space-y-4">
          <div className="w-12 h-12 rounded-2xl bg-amber-100 text-amber-700 mx-auto flex items-center justify-center">
            <AlertCircle className="w-6 h-6" />
          </div>

          <div className="space-y-1">
            <h3 className="font-display font-bold text-stone-900 text-base">
              Email Verification Required
            </h3>
            <p className="text-xs text-stone-600 max-w-sm mx-auto leading-relaxed">
              Your account (<strong className="font-mono text-stone-900">{user.email}</strong>) must have a verified email address before you can accept event team invitations.
            </p>
          </div>

          <div className="pt-2">
            <Link
              to="/organizer"
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-stone-900 hover:bg-black text-white text-xs font-mono uppercase font-bold tracking-wider transition-colors shadow-xs"
            >
              Verify Email in Settings
            </Link>
          </div>
        </div>
      ) : (
        /* Authenticated & Verified */
        <div className="bg-white rounded-2xl p-6 border border-stone-200 shadow-sm space-y-6">
          {/* Account Mismatch Warning */}
          {isAccountMismatch && (
            <div className="p-4 rounded-xl bg-rose-50 border border-rose-200 text-rose-900 text-xs space-y-2">
              <div className="flex items-center gap-2 font-bold font-mono">
                <AlertCircle className="w-4 h-4 text-rose-600" />
                Account Email Mismatch
              </div>
              <p className="leading-relaxed">
                You are currently signed in as <strong className="font-mono">{user.email}</strong>, but this invitation was sent to{' '}
                <strong className="font-mono">{invitation.emailMasked}</strong>.
              </p>
              <div className="pt-1">
                <button
                  type="button"
                  onClick={handleSwitchAccount}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-mono text-[11px] font-bold uppercase transition-colors cursor-pointer"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  Sign Out &amp; Switch Account
                </button>
              </div>
            </div>
          )}

          {acceptError && !isAccountMismatch && (
            <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
              <span>{acceptError}</span>
            </div>
          )}

          <div className="space-y-3">
            <h3 className="font-display font-bold text-base text-stone-900">
              Accept {isHost ? 'Event Host' : 'Event Admin'} Role
            </h3>

            {isHost ? (
              <p className="text-xs text-stone-600 leading-relaxed">
                By accepting, a personal promotional link will be generated for you. You can share this link to drive attendee traffic to <strong>{invitation.eventTitle}</strong>.
              </p>
            ) : (
              <p className="text-xs text-stone-600 leading-relaxed">
                By accepting, you will gain administrative access in Organizer Studio to help manage <strong>{invitation.eventTitle}</strong> based on permissions granted by the organizer.
              </p>
            )}

            <div className="p-3 rounded-xl bg-stone-50 border border-stone-200 text-[11px] font-mono text-stone-600">
              Signed in as: <strong className="text-stone-900">{user.email}</strong>
            </div>
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-stone-100">
            <button
              type="button"
              onClick={handleSwitchAccount}
              className="text-xs font-mono text-stone-500 hover:text-stone-800 transition-colors cursor-pointer"
            >
              Switch Account
            </button>

            <button
              type="button"
              onClick={handleAccept}
              disabled={isAccepting}
              className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl bg-stone-900 hover:bg-black text-white text-xs font-mono uppercase font-bold tracking-wider transition-colors shadow-xs disabled:opacity-50 cursor-pointer"
            >
              {isAccepting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Accepting...
                </>
              ) : (
                <>
                  <Check className="w-4 h-4" />
                  Accept Team Invitation
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

