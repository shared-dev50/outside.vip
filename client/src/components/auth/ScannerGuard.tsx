import React, { useState } from 'react';
import { useNavigate, Link, Outlet } from 'react-router-dom';
import { RefreshCw, Lock, ShieldCheck, RotateCw } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { EmailVerificationGate } from './EmailVerificationGate';

export interface ScannerGuardProps {
  children?: React.ReactNode;
}


export const ScannerGuard: React.FC<ScannerGuardProps> = ({ children }) => {
  const { user, isLoading } = useAuth();
  const navigate = useNavigate();

  const [inviteToken] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      try {
        const params = new URLSearchParams(window.location.search);
        const paramToken = params.get('invite') || params.get('invitation') || params.get('token');
        if (paramToken) {
          try {
            sessionStorage.setItem('outside_scanner_invite_token', paramToken);
          } catch { }
          return paramToken;
        }
        return sessionStorage.getItem('outside_scanner_invite_token');
      } catch {
        return null;
      }
    }
    return null;
  });

  // 1. Session hydration loading state
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

  // 2. Unauthenticated state
  if (!user) {
    // If an invitation token is available, present the door staff recovery flow
    if (inviteToken) {
      return (
        <div className="min-h-[80vh] bg-[#FAF8F5] text-stone-900 flex items-center justify-center p-4">
          <div className="max-w-md w-full bg-white rounded-2xl p-8 sm:p-10 border border-stone-200/90 shadow-xs text-center space-y-6">
            <div className="w-16 h-16 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center mx-auto border border-amber-200/70">
              <ShieldCheck className="w-8 h-8" />
            </div>

            <div className="space-y-2">
              <span className="px-3 py-1 rounded-full bg-amber-50 text-amber-800 font-mono text-[11px] uppercase tracking-wider font-semibold border border-amber-200/60 inline-block">
                Door Staff Access
              </span>
              <h1 className="font-display font-extrabold text-2xl text-stone-900 tracking-tight">
                Staff Authentication Required
              </h1>
              <p className="text-xs sm:text-sm text-stone-600 leading-relaxed max-w-sm mx-auto font-sans">
                You have a pending or prior door staff invitation. Resume your session using your invitation link or email verification code to scan tickets.
              </p>
            </div>

            <div className="pt-2 space-y-3">
              <button
                type="button"
                onClick={() => navigate(`/staff/invitations/${inviteToken}`)}
                className="w-full inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-stone-900 hover:bg-black text-white font-semibold text-xs sm:text-sm font-mono uppercase tracking-wider transition-all duration-200 shadow-xs"
              >
                <RotateCw className="w-4 h-4" />
                Resume Staff Session
              </button>

              <div className="pt-2 border-t border-stone-100">
                <Link
                  to="/login?redirect=%2Fscanner"
                  className="text-xs font-mono text-stone-500 hover:text-stone-900 transition-colors"
                >
                  Sign in with password (Organizers) →
                </Link>
              </div>
            </div>
          </div>
        </div>
      );
    }

    // Generic unauthenticated visitor without invitation token
    return (
      <div className="min-h-[80vh] bg-[#FAF8F5] text-stone-900 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-2xl p-8 sm:p-10 border border-stone-200/90 shadow-xs text-center space-y-6">
          <div className="w-16 h-16 rounded-2xl bg-stone-100 text-stone-700 flex items-center justify-center mx-auto border border-stone-200">
            <Lock className="w-8 h-8" />
          </div>

          <div className="space-y-2">
            <span className="px-3 py-1 rounded-full bg-stone-100 text-stone-700 font-mono text-[11px] uppercase tracking-wider font-semibold border border-stone-200 inline-block">
              Restricted Area
            </span>
            <h1 className="font-display font-extrabold text-2xl text-stone-900 tracking-tight">
              Scanner Authentication Required
            </h1>
            <p className="text-xs sm:text-sm text-stone-600 leading-relaxed max-w-sm mx-auto font-sans">
              Access to the Outside.vip ticket scanner requires an authorized organizer account or an active event door staff invitation.
            </p>
          </div>

          <div className="pt-2 space-y-3">
            <Link
              to="/login?redirect=%2Fscanner"
              className="w-full inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-stone-900 hover:bg-black text-white font-semibold text-xs sm:text-sm font-mono uppercase tracking-wider transition-all duration-200 shadow-xs"
            >
              Sign In as Organizer
            </Link>

            <p className="text-[11px] text-stone-400 font-mono leading-relaxed pt-2">
              Event door staff: Please click the invitation link received by email to access your assigned scanner.
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
  return children ? <>{children}</> : <Outlet />;
};

export default ScannerGuard;

