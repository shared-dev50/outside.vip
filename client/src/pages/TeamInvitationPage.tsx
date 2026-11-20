import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom';
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
} from 'lucide-react';
import { api } from '../lib/api';
import { TeamInvitationMetadata, AcceptTeamInvitationResult } from '../types';
import { useOptionalAuth } from '../context/AuthContext';

export const TeamInvitationPage: React.FC = () => {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const auth = useOptionalAuth();
  const user = auth?.user;
  const isAuthLoading = auth?.isLoading ?? false;

  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [invitation, setInvitation] = useState<TeamInvitationMetadata | null>(null);

  // Acceptance state
  const [isAccepting, setIsAccepting] = useState<boolean>(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [isAccountMismatch, setIsAccountMismatch] = useState<boolean>(false);
  const [acceptanceResult, setAcceptanceResult] = useState<AcceptTeamInvitationResult | null>(null);

  // Link copy state
  const [copiedLink, setCopiedLink] = useState<boolean>(false);

  useEffect(() => {
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
  }, [token]);

  const handleAccept = async () => {
    if (!token) return;
    setIsAccepting(true);
    setAcceptError(null);
    setIsAccountMismatch(false);

    try {
      const result = await api.team.acceptInvitation(token);
      setAcceptanceResult(result);
    } catch (err: any) {
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

  // Error / Invalid / Expired State
  if (error || !invitation) {
    const isRevoked = error?.toLowerCase().includes('revoked');
    const isExpired = error?.toLowerCase().includes('expired');

    return (
      <div className="max-w-md mx-auto px-4 py-16 text-center space-y-6">
        <div
          className={`w-14 h-14 rounded-2xl mx-auto flex items-center justify-center border ${
            isRevoked
              ? 'bg-rose-50 text-rose-600 border-rose-200'
              : 'bg-amber-50 text-amber-600 border-amber-200'
          }`}
        >
          <AlertTriangle className="w-7 h-7" />
        </div>

        <div className="space-y-2">
          <h1 className="font-display font-bold text-2xl text-stone-900">
            {isRevoked
              ? 'Invitation Revoked'
              : isExpired
              ? 'Invitation Expired'
              : 'Invitation Unavailable'}
          </h1>
          <p className="text-xs text-stone-600 leading-relaxed max-w-sm mx-auto">
            {error || 'This invitation could not be found or has already been used.'}
          </p>
        </div>

        <div className="pt-2">
          <Link
            to="/events"
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-stone-900 hover:bg-black text-white text-xs font-mono uppercase font-bold tracking-wider transition-colors shadow-xs"
          >
            Explore Events
          </Link>
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
              <Link
                to={`/events/${invitation.eventSlug}`}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-stone-900 hover:bg-black text-white text-xs font-mono uppercase font-bold tracking-wider transition-colors shadow-xs"
              >
                View Public Event
                <ExternalLink className="w-4 h-4" />
              </Link>
            )}
          </div>
        </div>
      ) : !user ? (
        /* Unauthenticated State */
        <div className="bg-white rounded-2xl p-6 border border-stone-200 shadow-sm text-center space-y-4">
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

          <div className="pt-2">
            <Link
              to={`/login?redirect=${encodeURIComponent(location.pathname)}`}
              className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl bg-stone-900 hover:bg-black text-white text-xs font-mono uppercase font-bold tracking-wider transition-colors shadow-xs"
            >
              Sign In / Register
              <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
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

