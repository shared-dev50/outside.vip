import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  Mail,
  Lock,
  User as UserIcon,
  ArrowRight,
  AlertCircle,
  CheckCircle2,
  ShieldCheck,
  Building2,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

export type AuthViewMode = 'login' | 'register' | 'forgot-password';

interface AuthFormCardProps {
  initialMode?: AuthViewMode;
  badgeText?: string;
  loginTitle?: string;
  loginSubtitle?: string;
  onSuccess?: () => void;
  showReturnLink?: boolean;
}

export const AuthFormCard: React.FC<AuthFormCardProps> = ({
  initialMode = 'login',
  badgeText = 'Outside.Vip Account',
  loginTitle = 'Sign in to your account',
  loginSubtitle = 'Enter your email address and password to access your tickets, orders, and event tools.',
  onSuccess,
  showReturnLink = true,
}) => {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<AuthViewMode>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [organizerDisplayName, setOrganizerDisplayName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoverySent, setRecoverySent] = useState(false);

  useEffect(() => {
    setMode(initialMode);
    setError(null);
    setRecoverySent(false);
  }, [initialMode]);

  const switchMode = (nextMode: AuthViewMode) => {
    setMode(nextMode);
    setError(null);
    setRecoverySent(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (mode === 'forgot-password') {
      if (!email.trim()) {
        setError('Please enter the email address associated with your account.');
        return;
      }
      setRecoverySent(true);
      return;
    }

    setIsSubmitting(true);
    try {
      if (mode === 'login') {
        await login(email.trim(), password);
        if (onSuccess) onSuccess();
      } else if (mode === 'register') {
        if (name.trim().length < 2) {
          setError('Please enter your full name (at least 2 characters).');
          setIsSubmitting(false);
          return;
        }
        if (password.length < 8) {
          setError('Password must be at least 8 characters long.');
          setIsSubmitting(false);
          return;
        }
        await register({
          name: name.trim(),
          email: email.trim(),
          password,
          ...(organizerDisplayName.trim().length >= 2
            ? { organizerDisplayName: organizerDisplayName.trim() }
            : {}),
        });
        if (onSuccess) onSuccess();
      }
    } catch (err: any) {
      setError(
        err?.message ||
          (mode === 'login'
            ? 'Invalid email or password. Please try again.'
            : 'Unable to create account. Please check your details and try again.')
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const headingTitle =
    mode === 'login'
      ? loginTitle
      : mode === 'register'
        ? 'Create your account'
        : 'Reset your password';

  const headingSubtitle =
    mode === 'login'
      ? loginSubtitle
      : mode === 'register'
        ? 'Every account includes attendee ticket access and unlocks organizer event tools once your email is verified.'
        : 'Enter the email address associated with your account to receive password recovery instructions.';

  return (
    <div className="max-w-md w-full rounded-2xl bg-white p-6 sm:p-8 border border-stone-200/90 shadow-[0_8px_30px_rgb(28,25,23,0.06)] text-left">
      <div className="text-center mb-6 space-y-2">
        <div className="w-12 h-12 rounded-2xl bg-[#EFECE5] border border-[#DDD7CB] flex items-center justify-center mx-auto text-stone-800 shadow-2xs">
          <ShieldCheck className="w-6 h-6" />
        </div>
        <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#EFECE5]/80 border border-[#DDD7CB]/70 text-[#7A7165] text-[10px] font-mono uppercase tracking-[0.22em] font-bold">
          <span className="w-1.5 h-1.5 rounded-full bg-[#96846D]" />
          <span>{badgeText}</span>
        </div>
        <h1 className="font-display font-extrabold text-2xl tracking-tight text-stone-900">
          {headingTitle}
        </h1>
        <p className="text-xs text-stone-600 leading-relaxed font-sans">{headingSubtitle}</p>
      </div>

      {error && (
        <div
          role="alert"
          className="mb-4 p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-start gap-2"
        >
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {mode === 'forgot-password' && recoverySent ? (
        <div className="space-y-4">
          <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-start gap-2.5">
            <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-600" />
            <div>
              <p className="font-semibold mb-1">Password recovery instructions requested</p>
              <p className="text-emerald-700 leading-relaxed">
                If an account exists for <strong>{email}</strong>, password recovery instructions will be sent to that address.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => switchMode('login')}
            className="w-full py-2.5 px-4 rounded-xl bg-stone-900 hover:bg-black text-white font-semibold text-xs font-mono uppercase tracking-wider transition-all"
          >
            Back to Sign In
          </button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          {mode === 'register' && (
            <div>
              <label
                htmlFor="auth-name"
                className="block text-[11px] font-mono uppercase tracking-wider text-stone-600 mb-1.5"
              >
                Full Name
              </label>
              <div className="relative">
                <UserIcon className="w-4 h-4 text-stone-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  id="auth-name"
                  name="name"
                  type="text"
                  autoComplete="name"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Enter your full name"
                  className="w-full pl-10 pr-3.5 py-2.5 rounded-xl bg-[#FAF8F5] border border-stone-300 text-sm text-stone-900 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-900 focus:border-stone-900 transition-all"
                />
              </div>
            </div>
          )}

          <div>
            <label
              htmlFor="auth-email"
              className="block text-[11px] font-mono uppercase tracking-wider text-stone-600 mb-1.5"
            >
              Email Address
            </label>
            <div className="relative">
              <Mail className="w-4 h-4 text-stone-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                id="auth-email"
                name="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full pl-10 pr-3.5 py-2.5 rounded-xl bg-[#FAF8F5] border border-stone-300 text-sm text-stone-900 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-900 focus:border-stone-900 transition-all"
              />
            </div>
          </div>

          {mode !== 'forgot-password' && (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label
                  htmlFor="auth-password"
                  className="block text-[11px] font-mono uppercase tracking-wider text-stone-600"
                >
                  Password
                </label>
                {mode === 'login' && (
                  <button
                    type="button"
                    onClick={() => switchMode('forgot-password')}
                    className="text-[11px] font-medium text-stone-500 hover:text-stone-900 transition-colors"
                  >
                    Forgot password?
                  </button>
                )}
              </div>
              <div className="relative">
                <Lock className="w-4 h-4 text-stone-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  id="auth-password"
                  name="password"
                  type="password"
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  required
                  minLength={mode === 'register' ? 8 : 1}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={mode === 'register' ? 'Minimum 8 characters' : 'Enter your password'}
                  className="w-full pl-10 pr-3.5 py-2.5 rounded-xl bg-[#FAF8F5] border border-stone-300 text-sm text-stone-900 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-900 focus:border-stone-900 transition-all"
                />
              </div>
            </div>
          )}

          {mode === 'register' && (
            <div>
              <label
                htmlFor="auth-organizer-name"
                className="block text-[11px] font-mono uppercase tracking-wider text-stone-600 mb-1.5"
              >
                Organizer or Collective Name <span className="text-stone-400">(Optional)</span>
              </label>
              <div className="relative">
                <Building2 className="w-4 h-4 text-stone-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  id="auth-organizer-name"
                  name="organizerDisplayName"
                  type="text"
                  value={organizerDisplayName}
                  onChange={(e) => setOrganizerDisplayName(e.target.value)}
                  placeholder="Optional — you can also set this up later"
                  className="w-full pl-10 pr-3.5 py-2.5 rounded-xl bg-[#FAF8F5] border border-stone-300 text-sm text-stone-900 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-900 focus:border-stone-900 transition-all"
                />
              </div>
            </div>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full py-3 px-4 rounded-xl bg-stone-900 hover:bg-black disabled:opacity-50 text-white font-semibold text-xs font-mono uppercase tracking-wider transition-all duration-200 shadow-xs flex items-center justify-center gap-2"
          >
            <span>
              {isSubmitting
                ? mode === 'login'
                  ? 'Signing in...'
                  : 'Creating account...'
                : mode === 'login'
                  ? 'Sign In'
                  : mode === 'register'
                    ? 'Create Account'
                    : 'Send Recovery Instructions'}
            </span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </form>
      )}

      <div className="mt-6 pt-5 border-t border-stone-200/80 space-y-2.5 text-center text-xs text-stone-600">
        {mode === 'login' && (
          <p>
            Don&apos;t have an account?{' '}
            <button
              type="button"
              onClick={() => switchMode('register')}
              className="font-semibold text-stone-900 hover:underline"
            >
              Create an account
            </button>
          </p>
        )}

        {mode === 'register' && (
          <p>
            Already have an account?{' '}
            <button
              type="button"
              onClick={() => switchMode('login')}
              className="font-semibold text-stone-900 hover:underline"
            >
              Sign in
            </button>
          </p>
        )}

        {mode === 'forgot-password' && !recoverySent && (
          <p>
            Remembered your password?{' '}
            <button
              type="button"
              onClick={() => switchMode('login')}
              className="font-semibold text-stone-900 hover:underline"
            >
              Back to Sign In
            </button>
          </p>
        )}

        {showReturnLink && (
          <div className="pt-1">
            <Link
              to="/"
              className="inline-block text-[11px] font-mono text-stone-500 hover:text-stone-900 transition-colors"
            >
              Return to Public Discovery
            </Link>
          </div>
        )}
      </div>
    </div>
  );
};

