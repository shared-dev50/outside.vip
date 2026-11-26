import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  KeyRound,
  Lock,
  ShieldCheck,
} from 'lucide-react';
import { api } from '../lib/api';
import { useOptionalAuth } from '../context/AuthContext';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  evaluatePasswordPolicy,
} from '../lib/passwordPolicy';
import { PasswordRequirementsChecklist } from '../components/auth/PasswordRequirementsChecklist';
import { PasswordInput } from '../components/common/PasswordInput';

type TokenState = 'loading' | 'valid' | 'invalid' | 'success' | 'transient-error';

export const ResetPasswordPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const auth = useOptionalAuth();
  const rawToken = searchParams.get('token')?.trim() || '';

  const [tokenState, setTokenState] = useState<TokenState>(rawToken ? 'loading' : 'invalid');
  const [tokenErrorCode, setTokenErrorCode] = useState<string | null>(
    rawToken ? null : 'MISSING_RESET_TOKEN'
  );
  const [tokenStatusMessage, setTokenStatusMessage] = useState<string>(
    rawToken
      ? ''
      : 'This password reset link is missing a valid token. Please request a new password reset email.'
  );

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string>(
    'Your password has been reset successfully. Please sign in with your new password.'
  );

  useEffect(() => {
    let isMounted = true;

    if (!rawToken) {
      setTokenState('invalid');
      setTokenErrorCode('MISSING_RESET_TOKEN');
      setTokenStatusMessage(
        'This password reset link is missing a valid token. Please request a new password reset email.'
      );
      return;
    }

    setTokenState('loading');
    setFormError(null);

    api.auth
      .validateResetToken({ token: rawToken })
      .then(() => {
        if (!isMounted) return;
        setTokenState('valid');
        setTokenErrorCode(null);
        setTokenStatusMessage('');
      })
      .catch((err: any) => {
        if (!isMounted) return;
        const statusCode = err?.statusCode;
        const code = err?.code || null;
        setTokenErrorCode(code);
        setTokenStatusMessage(
          err?.message ||
            'This password reset link is invalid or has expired. Please request a new one.'
        );
        if (statusCode === 400 || statusCode === 403 || statusCode === 404) {
          setTokenState('invalid');
        } else {
          setTokenState('transient-error');
        }
      });

    return () => {
      isMounted = false;
    };
  }, [rawToken]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const passwordEvaluation = evaluatePasswordPolicy(newPassword);
    if (!passwordEvaluation.valid) {
      setFormError(
        passwordEvaluation.firstError || 'Password does not meet security requirements.'
      );
      return;
    }

    if (newPassword.length > PASSWORD_MAX_LENGTH) {
      setFormError(`Password must be at most ${PASSWORD_MAX_LENGTH} characters long.`);
      return;
    }

    if (newPassword !== confirmPassword) {
      setFormError('Passwords do not match.');
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await api.auth.resetPassword({
        token: rawToken,
        newPassword,
        confirmPassword,
      });
      auth?.clearSessionState?.();
      setSuccessMessage(
        result.message ||
          'Your password has been reset successfully. Please sign in with your new password.'
      );
      setTokenState('success');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err: any) {
      const code = err?.code;
      if (
        code === 'INVALID_RESET_TOKEN' ||
        code === 'RESET_TOKEN_EXPIRED' ||
        code === 'RESET_TOKEN_USED'
      ) {
        setTokenErrorCode(code);
        setTokenStatusMessage(
          err?.message ||
            'This password reset link is invalid or has expired. Please request a new one.'
        );
        setTokenState('invalid');
        return;
      }

      setFormError(
        err?.message || 'Unable to reset your password right now. Please try again.'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const invalidTitle =
    tokenErrorCode === 'RESET_TOKEN_EXPIRED'
      ? 'Reset link expired'
      : tokenErrorCode === 'RESET_TOKEN_USED'
        ? 'Reset link already used'
        : 'Invalid reset link';

  return (
    <div className="min-h-[82vh] bg-[#FAF8F5] text-stone-900 flex items-center justify-center px-4 py-12">
      <div className="max-w-md w-full rounded-2xl bg-white p-6 sm:p-8 border border-stone-200/90 shadow-[0_8px_30px_rgb(28,25,23,0.06)] text-left">
        <div className="text-center mb-6 space-y-2">
          <div className="w-12 h-12 rounded-2xl bg-[#EFECE5] border border-[#DDD7CB] flex items-center justify-center mx-auto text-stone-800 shadow-2xs">
            {tokenState === 'success' ? (
              <CheckCircle2 className="w-6 h-6 text-emerald-700" />
            ) : tokenState === 'invalid' || tokenState === 'transient-error' ? (
              <KeyRound className="w-6 h-6 text-rose-700" />
            ) : (
              <ShieldCheck className="w-6 h-6" />
            )}
          </div>
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#EFECE5]/80 border border-[#DDD7CB]/70 text-[#7A7165] text-[10px] font-mono uppercase tracking-[0.22em] font-bold">
            <span className="w-1.5 h-1.5 rounded-full bg-[#96846D]" />
            <span>Outside.Vip Account</span>
          </div>
          <h1 className="font-display font-extrabold text-2xl tracking-tight text-stone-900">
            {tokenState === 'success'
              ? 'Password reset complete'
              : tokenState === 'invalid'
                ? invalidTitle
                : 'Choose a new password'}
          </h1>
          <p className="text-xs text-stone-600 leading-relaxed font-sans">
            {tokenState === 'success'
              ? 'Your account credentials have been updated and previous active sessions were signed out.'
              : tokenState === 'invalid'
                ? 'For your security, password reset links are single-use and valid for 30 minutes.'
                : 'Enter a new password for your Outside.vip account below.'}
          </p>
        </div>

        {tokenState === 'loading' && (
          <div className="py-8 text-center">
            <div className="text-xs font-mono uppercase tracking-wider text-stone-500">
              Verifying reset link...
            </div>
          </div>
        )}

        {tokenState === 'transient-error' && (
          <div className="space-y-4">
            <div
              role="alert"
              className="p-4 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-start gap-2.5"
            >
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{tokenStatusMessage}</span>
            </div>
            <Link
              to="/forgot-password"
              className="w-full py-2.5 px-4 rounded-xl bg-stone-900 hover:bg-black text-white font-semibold text-xs font-mono uppercase tracking-wider transition-all flex items-center justify-center gap-2"
            >
              <span>Request New Reset Link</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        )}

        {tokenState === 'invalid' && (
          <div className="space-y-4">
            <div
              role="alert"
              className="p-4 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-start gap-2.5"
            >
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{tokenStatusMessage}</span>
            </div>
            <Link
              to="/forgot-password"
              className="w-full py-2.5 px-4 rounded-xl bg-stone-900 hover:bg-black text-white font-semibold text-xs font-mono uppercase tracking-wider transition-all flex items-center justify-center gap-2"
            >
              <span>Request New Reset Link</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        )}

        {tokenState === 'success' && (
          <div className="space-y-4">
            <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-start gap-2.5">
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-600" />
              <p className="leading-relaxed">{successMessage}</p>
            </div>
            <Link
              to="/login"
              className="w-full py-3 px-4 rounded-xl bg-stone-900 hover:bg-black text-white font-semibold text-xs font-mono uppercase tracking-wider transition-all flex items-center justify-center gap-2"
            >
              <span>Back to Sign In</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        )}

        {tokenState === 'valid' && (
          <>
            {formError && (
              <div
                role="alert"
                className="mb-4 p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-start gap-2"
              >
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{formError}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label
                  htmlFor="reset-new-password"
                  className="block text-[11px] font-mono uppercase tracking-wider text-stone-600 mb-1.5"
                >
                  New Password
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-stone-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none z-10" />
                  <PasswordInput
                    id="reset-new-password"
                    name="newPassword"
                    autoComplete="new-password"
                    required
                    minLength={PASSWORD_MIN_LENGTH}
                    maxLength={PASSWORD_MAX_LENGTH}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="At least 8 chars, A-Z, 0-9 & symbol"
                    className="w-full pl-10 pr-11 py-2.5 rounded-xl bg-[#FAF8F5] border border-stone-300 text-sm text-stone-900 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-900 focus:border-stone-900 transition-all"
                  />
                </div>
                <PasswordRequirementsChecklist password={newPassword} />
              </div>

              <div>
                <label
                  htmlFor="reset-confirm-password"
                  className="block text-[11px] font-mono uppercase tracking-wider text-stone-600 mb-1.5"
                >
                  Confirm New Password
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-stone-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none z-10" />
                  <PasswordInput
                    id="reset-confirm-password"
                    name="confirmPassword"
                    autoComplete="new-password"
                    required
                    minLength={PASSWORD_MIN_LENGTH}
                    maxLength={PASSWORD_MAX_LENGTH}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Re-enter your new password"
                    className="w-full pl-10 pr-11 py-2.5 rounded-xl bg-[#FAF8F5] border border-stone-300 text-sm text-stone-900 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-900 focus:border-stone-900 transition-all"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full py-3 px-4 rounded-xl bg-stone-900 hover:bg-black disabled:opacity-50 text-white font-semibold text-xs font-mono uppercase tracking-wider transition-all duration-200 shadow-xs flex items-center justify-center gap-2"
              >
                <span>{isSubmitting ? 'Resetting password...' : 'Reset Password'}</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </form>
          </>
        )}

        <div className="mt-6 pt-5 border-t border-stone-200/80 text-center text-xs text-stone-600 space-y-2">
          {tokenState !== 'success' && (
            <p>
              Remembered your password?{' '}
              <Link to="/login" className="font-semibold text-stone-900 hover:underline">
                Back to Sign In
              </Link>
            </p>
          )}
          <div className="pt-1">
            <Link
              to="/"
              className="inline-block text-[11px] font-mono text-stone-500 hover:text-stone-900 transition-colors"
            >
              Return to Public Discovery
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ResetPasswordPage;
