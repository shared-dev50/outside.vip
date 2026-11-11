import React, { useEffect } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { AuthFormCard, AuthViewMode } from '../components/auth/AuthFormCard';
import { EmailVerificationGate } from '../components/auth/EmailVerificationGate';

export const AuthPage: React.FC = () => {
  const { user, isLoading } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const redirectPath = searchParams.get('redirect') || '/organizer';

  const initialMode: AuthViewMode = location.pathname.startsWith('/register')
    ? 'register'
    : location.pathname.startsWith('/forgot-password')
      ? 'forgot-password'
      : 'login';

  useEffect(() => {
    if (!isLoading && user && user.emailVerified !== false) {
      navigate(redirectPath, { replace: true });
    }
  }, [isLoading, user, redirectPath, navigate]);

  if (isLoading) {
    return (
      <div className="min-h-[80vh] bg-[#FAF8F5] flex items-center justify-center p-4">
        <div className="text-xs font-mono uppercase tracking-wider text-stone-500">
          Loading account...
        </div>
      </div>
    );
  }

  if (user && user.emailVerified === false) {
    return (
      <div className="min-h-screen bg-[#FAF8F5] text-stone-900">
        <EmailVerificationGate
          title="Verify Your Email Address"
          subtitle="Enter the 6-digit single-use verification code sent to your email address to complete account setup."
          onVerified={() => navigate(redirectPath, { replace: true })}
        />
      </div>
    );
  }

  return (
    <div className="min-h-[82vh] bg-[#FAF8F5] text-stone-900 flex items-center justify-center px-4 py-12">
      <AuthFormCard
        initialMode={initialMode}
        onSuccess={() => {
          // Navigation is handled reactively once user state updates
        }}
      />
    </div>
  );
};

export default AuthPage;

