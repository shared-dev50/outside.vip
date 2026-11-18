import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  ShieldCheck,
  Mail,
  KeyRound,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  ArrowRight,
  Calendar,
  MapPin,
  Building2,
  Lock,
  RotateCw,
  QrCode,
} from 'lucide-react';
import { api, StaffInvitationMetadataResponse, setActiveCsrfToken } from '../lib/api';
import { useAuth } from '../context/AuthContext';

export const StaffInvitationPage: React.FC = () => {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { user, refreshUser, logout } = useAuth();

  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<StaffInvitationMetadataResponse | null>(null);

  // OTP flow state
  const [otpRequested, setOtpRequested] = useState<boolean>(false);
  const [otpCode, setOtpCode] = useState<string>('');
  const [isSendingOtp, setIsSendingOtp] = useState<boolean>(false);
  const [isVerifyingOtp, setIsVerifyingOtp] = useState<boolean>(false);
  const [isAcceptingSession, setIsAcceptingSession] = useState<boolean>(false);
  const [cooldownSeconds, setCooldownSeconds] = useState<number>(0);
  const [otpError, setOtpError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Cooldown countdown
  useEffect(() => {
    if (cooldownSeconds <= 0) return;
    const interval = setInterval(() => {
      setCooldownSeconds((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [cooldownSeconds]);

  useEffect(() => {
    let isMounted = true;
    async function loadMetadata() {
      if (!token) {
        setError('Missing invitation token.');
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      setError(null);
      try {
        const res = await api.staffInvitation.getMetadata(token);
        if (isMounted) {
          setMetadata(res);
          // If invitation is confirmed expired, revoked, or assignment is inactive, clear recovery token
          if (
            res.invitation.status === 'EXPIRED' ||
            res.invitation.status === 'REVOKED' ||
            res.invitation.isAssignmentActive === false
          ) {
            try {
              sessionStorage.removeItem('outside_scanner_invite_token');
            } catch {}
          }
        }
      } catch (err: any) {
        if (isMounted) {
          const status = err?.statusCode || err?.status;
          if (status === 404 || status === 410 || status === 403) {
            try {
              sessionStorage.removeItem('outside_scanner_invite_token');
            } catch {}
          }
          setError(
            err?.message ||
              err?.error?.message ||
              'This invitation link is invalid or could not be loaded.'
          );
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    loadMetadata();
    return () => {
      isMounted = false;
    };
  }, [token]);

  const handleRequestOtp = async () => {
    if (!token || isSendingOtp || cooldownSeconds > 0) return;
    setIsSendingOtp(true);
    setOtpError(null);
    try {
      const res = await api.staffInvitation.requestOtp(token);
      setOtpRequested(true);
      setCooldownSeconds(res.cooldownSeconds || 60);
    } catch (err: any) {
      setOtpError(
        err?.message ||
          err?.error?.message ||
          'Failed to send verification code. Please try again.'
      );
    } finally {
      setIsSendingOtp(false);
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !otpCode.trim() || isVerifyingOtp) return;

    const cleanCode = otpCode.trim().replace(/\D/g, '');
    if (cleanCode.length !== 6) {
      setOtpError('Please enter the complete 6-digit code sent to your email.');
      return;
    }

    setIsVerifyingOtp(true);
    setOtpError(null);
    try {
      const res = await api.staffInvitation.verifyOtp(token, cleanCode);
      if (res.csrfToken) {
        setActiveCsrfToken(res.csrfToken);
      }
      await refreshUser();
      // Recovery succeeded: clear the recovery token from sessionStorage
      try {
        sessionStorage.removeItem('outside_scanner_invite_token');
      } catch {}
      setSuccessMessage('Verification successful! Initializing your scanner session...');
      setTimeout(() => {
        const targetGate = metadata?.event.slug || metadata?.event.id || '';
        navigate(`/scanner${targetGate ? `?event=${targetGate}` : ''}`);
      }, 1200);
    } catch (err: any) {
      setOtpError(
        err?.message ||
          err?.error?.message ||
          'Invalid or expired verification code. Please check and try again.'
      );
    } finally {
      setIsVerifyingOtp(false);
    }
  };

  const handleAcceptWithSession = async () => {
    if (!token || isAcceptingSession) return;
    setIsAcceptingSession(true);
    setError(null);
    try {
      await api.staffInvitation.acceptWithSession(token);
      await refreshUser();
      // Acceptance succeeded: clear the recovery token from sessionStorage
      try {
        sessionStorage.removeItem('outside_scanner_invite_token');
      } catch {}
      setSuccessMessage('Staff invitation accepted! Redirecting to scanner...');
      setTimeout(() => {
        const targetGate = metadata?.event.slug || metadata?.event.id || '';
        navigate(`/scanner${targetGate ? `?event=${targetGate}` : ''}`);
      }, 1200);
    } catch (err: any) {
      setError(
        err?.message ||
          err?.error?.message ||
          'Failed to accept invitation. Please ensure your session matches the invitation email.'
      );
    } finally {
      setIsAcceptingSession(false);
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-[70vh] flex flex-col items-center justify-center px-4">
        <Loader2 className="w-10 h-10 text-stone-900 animate-spin mb-4" />
        <p className="text-sm font-mono text-stone-600">Verifying scanner invitation...</p>
      </div>
    );
  }

  if (error || !metadata) {
    return (
      <div className="max-w-md mx-auto px-4 py-16 text-center space-y-6">
        <div className="w-16 h-16 rounded-full bg-rose-50 text-rose-600 mx-auto flex items-center justify-center border border-rose-200">
          <AlertTriangle className="w-8 h-8" />
        </div>
        <div>
          <h1 className="text-2xl font-display font-bold text-stone-900">
            Invitation Unavailable
          </h1>
          <p className="text-sm text-stone-600 mt-2 leading-relaxed">
            {error || 'This invitation link could not be loaded or is invalid.'}
          </p>
        </div>
        <div className="pt-2">
          <Link
            to="/events"
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-stone-900 text-white font-medium text-xs uppercase tracking-wider hover:bg-black transition-colors"
          >
            Explore Events
          </Link>
        </div>
      </div>
    );
  }

  const { invitation, event } = metadata;

  // Format dates
  const formattedDates = (() => {
    try {
      const start = new Date(event.startAt);
      const end = new Date(event.endAt);
      return `${start.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })} · ${start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} - ${end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
    } catch {
      return '';
    }
  })();

  return (
    <div className="max-w-lg mx-auto px-4 py-12 space-y-8">
      {/* Header Badge */}
      <div className="text-center space-y-3">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-mono uppercase tracking-wider font-semibold">
          <ShieldCheck className="w-3.5 h-3.5" />
          Official Door Staff Invitation
        </div>
        <h1 className="text-2xl sm:text-3xl font-display font-bold text-stone-900 tracking-tight">
          Join Event Scanner Staff
        </h1>
        <p className="text-sm text-stone-600 max-w-sm mx-auto">
          You've been authorized by <strong className="text-stone-900">{event.organizerName}</strong> to verify tickets at the gate.
        </p>
      </div>

      {/* Event Overview Card */}
      <div className="bg-white rounded-2xl p-6 border border-stone-200 shadow-sm space-y-4">
        <div>
          <span className="text-[10px] font-mono uppercase tracking-wider text-stone-500 font-semibold block mb-1">
            Assigned Event
          </span>
          <h2 className="text-lg font-display font-bold text-stone-900">{event.title}</h2>
        </div>

        <div className="space-y-2 pt-2 border-t border-stone-100 text-xs text-stone-600 font-sans">
          {formattedDates && (
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-stone-400 shrink-0" />
              <span>{formattedDates}</span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <MapPin className="w-4 h-4 text-stone-400 shrink-0" />
            <span>
              {event.venueName ? `${event.venueName}, ` : ''}
              {event.city}, {event.country}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Building2 className="w-4 h-4 text-stone-400 shrink-0" />
            <span>Organized by {event.organizerName}</span>
          </div>
        </div>
      </div>

      {/* Success Notification */}
      {successMessage && (
        <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm flex items-center gap-3">
          <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 animate-bounce" />
          <p className="font-medium">{successMessage}</p>
        </div>
      )}

      {/* Status: Expired */}
      {invitation.status === 'EXPIRED' && (
        <div className="bg-white rounded-2xl p-6 border border-amber-200 bg-amber-50/30 shadow-sm text-center space-y-4">
          <div className="w-12 h-12 rounded-full bg-amber-50 text-amber-600 mx-auto flex items-center justify-center border border-amber-200">
            <AlertTriangle className="w-6 h-6" />
          </div>
          <div>
            <h3 className="font-display font-bold text-stone-900 text-base">Invitation Expired</h3>
            <p className="text-xs text-stone-600 mt-1">
              This invitation link has expired. Please ask the event organizer to send a fresh invitation.
            </p>
          </div>
        </div>
      )}

      {/* Status: Revoked or Assignment Revoked */}
      {(invitation.status === 'REVOKED' || invitation.isAssignmentActive === false) && (
        <div className="bg-white rounded-2xl p-6 border border-rose-200 bg-rose-50/30 shadow-sm text-center space-y-4">
          <div className="w-12 h-12 rounded-full bg-rose-50 text-rose-600 mx-auto flex items-center justify-center border border-rose-200">
            <AlertTriangle className="w-6 h-6" />
          </div>
          <div>
            <h3 className="font-display font-bold text-stone-900 text-base">
              {invitation.isAssignmentActive === false ? 'Staff Assignment Revoked' : 'Invitation Revoked'}
            </h3>
            <p className="text-xs text-stone-600 mt-1">
              Your staff assignment for this event has been revoked by the event organizer.
            </p>
          </div>
        </div>
      )}

      {/* Account Mismatch: Visitor authenticated with a different email */}
      {user && !invitation.isCurrentAccount && (
        <div className="bg-white rounded-2xl p-6 sm:p-8 border border-amber-200 bg-amber-50/20 shadow-sm space-y-5">
          <div className="flex items-start gap-3">
            <div className="p-2.5 rounded-xl bg-amber-100 text-amber-800 shrink-0">
              <AlertTriangle className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-display font-bold text-stone-900 text-base">
                Account Mismatch Detected
              </h3>
              <p className="text-xs text-stone-600 mt-1 leading-relaxed">
                You are currently signed in as <strong>{user.email}</strong>, but this door staff invitation is assigned to <strong>{invitation.maskedEmail}</strong>.
              </p>
              <p className="text-xs text-stone-600 mt-1.5">
                To access the scanner for this event, please switch to the invited account.
              </p>
            </div>
          </div>

          <div className="pt-2 flex flex-col sm:flex-row gap-2">
            <button
              type="button"
              onClick={async () => {
                try {
                  sessionStorage.removeItem('outside_scanner_invite_token');
                } catch {}
                await logout();
                window.location.reload();
              }}
              className="py-2.5 px-4 rounded-xl bg-stone-900 hover:bg-black text-white font-semibold text-xs uppercase tracking-wider transition-colors inline-flex items-center justify-center gap-2 shadow-sm"
            >
              Sign Out to Switch Accounts
            </button>
            <Link
              to="/events"
              className="py-2.5 px-4 rounded-xl bg-stone-100 hover:bg-stone-200 text-stone-700 font-semibold text-xs uppercase tracking-wider transition-colors inline-flex items-center justify-center"
            >
              Browse Events
            </Link>
          </div>
        </div>
      )}

      {/* Status: Already Accepted & Matching Current Account */}
      {invitation.status === 'ACCEPTED' && invitation.isCurrentAccount && invitation.isAssignmentActive !== false && (
        <div className="bg-white rounded-2xl p-6 sm:p-8 border border-emerald-200 bg-emerald-50/20 shadow-sm text-center space-y-5">
          <div className="w-14 h-14 rounded-full bg-emerald-100 text-emerald-700 mx-auto flex items-center justify-center border border-emerald-300">
            <CheckCircle2 className="w-7 h-7" />
          </div>
          <div>
            <h3 className="font-display font-bold text-stone-900 text-lg">
              Staff Access Active
            </h3>
            <p className="text-xs text-stone-600 mt-1.5 max-w-sm mx-auto">
              You are registered and verified as scanner staff for <strong>{event.title}</strong>.
            </p>
          </div>
          <div className="pt-2">
            <button
              type="button"
              onClick={() => navigate(`/scanner?event=${event.slug || event.id}`)}
              className="w-full sm:w-auto px-6 py-3 rounded-xl bg-stone-900 hover:bg-black text-white font-semibold text-xs uppercase tracking-wider transition-colors inline-flex items-center justify-center gap-2 shadow-sm"
            >
              <QrCode className="w-4 h-4" />
              Open Scanner Viewfinder
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Action Case 1: Existing Account with Password Required */}
      {invitation.requiresLogin && (
        <div className="bg-white rounded-2xl p-6 sm:p-8 border border-stone-200 shadow-sm space-y-5">
          <div className="flex items-start gap-3">
            <div className="p-2.5 rounded-xl bg-stone-100 text-stone-800 shrink-0">
              <Lock className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-display font-bold text-stone-900 text-base">
                Existing Account Detected
              </h3>
              <p className="text-xs text-stone-600 mt-1 leading-relaxed">
                An Outside.vip account exists for <strong>{invitation.maskedEmail}</strong> with a password set. To preserve security, please log in with your password to access the scanner.
              </p>
            </div>
          </div>

          <div className="pt-2">
            <Link
              to={`/login?redirect=${encodeURIComponent(`/staff/invitations/${token}`)}`}
              className="w-full py-3 px-4 rounded-xl bg-stone-900 hover:bg-black text-white font-semibold text-xs uppercase tracking-wider transition-colors inline-flex items-center justify-center gap-2 shadow-sm"
            >
              Log In with Password
              <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </div>
      )}

      {/* Action Case 2: Visitor Authenticated with Matching Session on PENDING Invitation */}
      {invitation.status === 'PENDING' && invitation.isCurrentAccount && (
        <div className="bg-white rounded-2xl p-6 sm:p-8 border border-stone-200 shadow-sm space-y-5">
          <div className="flex items-start gap-3">
            <div className="p-2.5 rounded-xl bg-emerald-50 text-emerald-700 shrink-0 border border-emerald-200">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-display font-bold text-stone-900 text-base">
                Ready to Activate
              </h3>
              <p className="text-xs text-stone-600 mt-1 leading-relaxed">
                You are currently signed in as <strong>{user?.email}</strong>. Click below to accept the assignment and activate scanning permissions.
              </p>
            </div>
          </div>

          <div className="pt-2">
            <button
              type="button"
              onClick={handleAcceptWithSession}
              disabled={isAcceptingSession}
              className="w-full py-3 px-4 rounded-xl bg-stone-900 hover:bg-black text-white font-semibold text-xs uppercase tracking-wider transition-colors inline-flex items-center justify-center gap-2 shadow-sm disabled:opacity-50"
            >
              {isAcceptingSession ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Activating Access...
                </>
              ) : (
                <>
                  Accept & Open Scanner
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {/* Action Case 3: Passwordless OTP Flow (Initial Acceptance or Returning Staff Resumption) */}
      {!invitation.hasPassword &&
        !user &&
        (invitation.status === 'PENDING' || (invitation.status === 'ACCEPTED' && invitation.isAssignmentActive !== false)) && (
          <div className="bg-white rounded-2xl p-6 sm:p-8 border border-stone-200 shadow-sm space-y-6">
            <div>
              <span className="text-[10px] font-mono uppercase tracking-wider text-stone-500 font-semibold block mb-1">
                {invitation.status === 'ACCEPTED' ? 'Staff Session Resumption' : 'Step 1 · Passwordless Verification'}
              </span>
              <h3 className="font-display font-bold text-stone-900 text-lg">
                {invitation.status === 'ACCEPTED' ? 'Resume Scanner Session' : 'Verify Email Address'}
              </h3>
              <p className="text-xs text-stone-600 mt-1 leading-relaxed">
                {invitation.status === 'ACCEPTED'
                  ? `Welcome back! We'll send a 6-digit confirmation code to ${invitation.maskedEmail} to reactivate your scanner session on this device. No password required.`
                  : `We'll send a 6-digit confirmation code to ${invitation.maskedEmail} to grant access to the scanner. No password required.`}
              </p>
            </div>

            {otpError && (
              <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>{otpError}</span>
              </div>
            )}

            {!otpRequested ? (
              <button
                type="button"
                onClick={handleRequestOtp}
                disabled={isSendingOtp}
                className="w-full py-3 px-4 rounded-xl bg-stone-900 hover:bg-black text-white font-semibold text-xs uppercase tracking-wider transition-colors inline-flex items-center justify-center gap-2 shadow-sm disabled:opacity-50"
              >
                {isSendingOtp ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Sending Code...
                  </>
                ) : (
                  <>
                    <Mail className="w-4 h-4" />
                    Send Verification Code
                  </>
                )}
              </button>
            ) : (
              <form onSubmit={handleVerifyOtp} className="space-y-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-mono font-semibold uppercase text-stone-700 block">
                    Enter 6-Digit Code
                  </label>
                  <input
                    type="text"
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
                  className="w-full py-3 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-xs uppercase tracking-wider transition-colors inline-flex items-center justify-center gap-2 shadow-sm disabled:opacity-50"
                >
                  {isVerifyingOtp ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Verifying...
                    </>
                  ) : (
                    <>
                      <KeyRound className="w-4 h-4" />
                      Verify & Launch Scanner
                    </>
                  )}
                </button>

                <div className="text-center pt-2">
                  <button
                    type="button"
                    onClick={handleRequestOtp}
                    disabled={cooldownSeconds > 0 || isSendingOtp}
                    className="text-xs font-mono text-stone-600 hover:text-stone-900 disabled:opacity-50 inline-flex items-center gap-1.5"
                  >
                    <RotateCw className="w-3.5 h-3.5" />
                    {cooldownSeconds > 0
                      ? `Resend code in ${cooldownSeconds}s`
                      : 'Resend verification code'}
                  </button>
                </div>
              </form>
            )}
          </div>
        )}
    </div>
  );
};

