import React, { useState, useEffect } from 'react';
import { ShieldCheck, Mail, RefreshCw, AlertCircle, CheckCircle2, Sparkles, LogOut } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../lib/api';

interface EmailVerificationGateProps {
  title?: string;
  subtitle?: string;
  onVerified?: () => void;
}

export const EmailVerificationGate: React.FC<EmailVerificationGateProps> = ({
  title = 'Verify Your Email to Host Events',
  subtitle = 'Enter the 6-digit single-use verification code sent to your email address to unlock event creation and organizer tools.',
  onVerified,
}) => {
  const { user, verifyEmail, resendVerification, logout } = useAuth();
  const [code, setCode] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => {
      setCooldown((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = code.trim();
    if (!/^\d{6}$/.test(cleaned)) {
      setError('Please enter a valid 6-digit verification code.');
      return;
    }

    setIsVerifying(true);
    setError(null);
    setInfoMessage(null);
    try {
      await verifyEmail(cleaned);
      if (onVerified) {
        onVerified();
      }
    } catch (err: any) {
      setError(err?.message || 'Verification failed. Please check the code and try again.');
    } finally {
      setIsVerifying(false);
    }
  };

  const handleResend = async () => {
    if (cooldown > 0 || isResending) return;
    setIsResending(true);
    setError(null);
    setInfoMessage(null);
    try {
      const res = await resendVerification();
      setInfoMessage(res.message || 'A new 6-digit verification code has been sent.');
      setCooldown(res.cooldownSeconds || 60);
    } catch (err: any) {
      setError(err?.message || 'Unable to resend code right now. Please wait and try again.');
    } finally {
      setIsResending(false);
    }
  };

  return (
    <div className="min-h-[80vh] flex items-center justify-center px-4 py-16 bg-[#FAF8F5] text-stone-900">
      <div className="max-w-md w-full rounded-2xl bg-white p-8 border border-stone-200/90 shadow-[0_8px_30px_rgb(28,25,23,0.06)] text-center">
        <div className="w-14 h-14 rounded-2xl bg-[#EFECE5] border border-[#DDD7CB] flex items-center justify-center mx-auto mb-5 text-stone-800 shadow-2xs">
          <ShieldCheck className="w-7 h-7" />
        </div>
        <h1 className="font-display text-2xl font-extrabold tracking-tight text-stone-900 mb-2">
          {title}
        </h1>
        <p className="text-xs text-stone-600 leading-relaxed mb-6">{subtitle}</p>

        {user?.email && (
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-[#FAF8F5] border border-stone-200 text-xs text-stone-700 font-medium mb-6">
            <Mail className="w-3.5 h-3.5 text-stone-500" />
            <span>{user.email}</span>
          </div>
        )}

        {error && (
          <div className="mb-4 p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-start gap-2 text-left">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {infoMessage && (
          <div className="mb-4 p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs flex items-start gap-2 text-left">
            <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{infoMessage}</span>
          </div>
        )}

        <form onSubmit={handleVerify} className="space-y-4">
          <div>
            <label
              htmlFor="verification-code-input"
              className="block text-[11px] font-mono uppercase tracking-wider text-stone-500 mb-2"
            >
              6-Digit Verification Code
            </label>
            <input
              id="verification-code-input"
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="123456"
              className="w-full px-4 py-3.5 rounded-xl bg-[#FAF8F5] border border-stone-300 text-stone-900 text-center font-mono text-2xl tracking-[0.35em] focus:outline-none focus:ring-2 focus:ring-stone-900 focus:border-stone-900"
              required
            />
          </div>

          <button
            type="submit"
            disabled={isVerifying || code.length !== 6}
            className="w-full py-3 rounded-xl bg-stone-900 hover:bg-black disabled:opacity-50 text-white font-semibold text-xs font-mono uppercase tracking-wider transition-all shadow-xs"
          >
            {isVerifying ? 'Verifying...' : 'Verify Email & Continue'}
          </button>
        </form>

        <div className="mt-5 pt-5 border-t border-stone-200 flex items-center justify-between text-xs text-stone-500">
          <span>Code expires in 10 minutes</span>
          <button
            type="button"
            onClick={handleResend}
            disabled={cooldown > 0 || isResending}
            className="inline-flex items-center gap-1.5 text-stone-900 font-semibold hover:underline disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isResending ? 'animate-spin' : ''}`} />
            {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend Code'}
          </button>
        </div>

        <div className="mt-4 pt-3 border-t border-stone-100 flex justify-center">
          <button
            type="button"
            onClick={logout}
            className="inline-flex items-center gap-1.5 text-[11px] text-stone-500 hover:text-stone-900 transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Sign out or use a different email</span>
          </button>
        </div>
      </div>
    </div>
  );
};

interface OrganizerWorkspaceBannerProps {
  onCreated?: () => void;
}

export const OrganizerWorkspaceSetupBanner: React.FC<OrganizerWorkspaceBannerProps> = ({
  onCreated,
}) => {
  const { user, refreshUser } = useAuth();
  const [displayName, setDisplayName] = useState(user?.name || '');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user || !user.emailVerified || user.organizer) {
    return null;
  }

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!displayName.trim() || displayName.trim().length < 2) {
      setError('Please enter an organizer or collective display name (at least 2 characters).');
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      await api.organizer.upsertWorkspace({ displayName: displayName.trim() });
      await refreshUser();
      if (onCreated) onCreated();
    } catch (err: any) {
      setError(err?.message || 'Failed to save organizer workspace.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="mb-6 p-5 rounded-2xl bg-white border border-stone-200/90 shadow-2xs flex flex-col md:flex-row md:items-center justify-between gap-4">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-[#EFECE5] border border-[#DDD7CB] flex items-center justify-center shrink-0 text-stone-800">
          <Sparkles className="w-5 h-5" />
        </div>
        <div>
          <h3 className="text-sm font-bold text-stone-900">Set Up Your Organizer Profile</h3>
          <p className="text-xs text-stone-600">
            Choose a public organizer or collective name for your events (you can still buy attendee tickets anytime).
          </p>
          {error && <p className="text-xs text-rose-600 mt-1">{error}</p>}
        </div>
      </div>
      <form onSubmit={handleCreate} className="flex items-center gap-2">
        <input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Collective or Organizer Name"
          className="px-3.5 py-2 rounded-xl bg-[#FAF8F5] border border-stone-300 text-sm text-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-900"
        />
        <button
          type="submit"
          disabled={isSaving}
          className="px-4 py-2 rounded-xl bg-stone-900 hover:bg-black text-white text-xs font-semibold whitespace-nowrap transition-all disabled:opacity-50"
        >
          {isSaving ? 'Saving...' : 'Save Workspace'}
        </button>
      </form>
    </div>
  );
};
