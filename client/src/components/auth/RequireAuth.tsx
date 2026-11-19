import React from 'react';
import { useLocation, Navigate, Outlet } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { EmailVerificationGate } from './EmailVerificationGate';
import { sanitizeRedirectUrl } from '../../lib/utils';

export interface RequireAuthProps {
  children?: React.ReactNode;
  requireVerified?: boolean;
}

export const RequireAuth: React.FC<RequireAuthProps> = ({
  children,
  requireVerified = true,
}) => {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#FAF8F5] text-stone-900 flex items-center justify-center p-4 selection:bg-stone-900 selection:text-white">
        <div className="flex items-center gap-2.5 text-xs font-mono uppercase tracking-wider text-stone-500">
          <RefreshCw className="w-4 h-4 animate-spin text-stone-700" />
          <span>Loading account...</span>
        </div>
      </div>
    );
  }


  if (!user) {
    const requestedUrl = `${location.pathname}${location.search}${location.hash}`;
    const safeDestination = sanitizeRedirectUrl(requestedUrl, '');
    const redirectQuery = safeDestination ? `?redirect=${encodeURIComponent(safeDestination)}` : '';
    return <Navigate to={`/login${redirectQuery}`} replace state={{ from: location }} />;
  }

  // 3. Authenticated but unverified email
  if (requireVerified && user.emailVerified === false) {
    return (
      <div className="min-h-screen bg-[#FAF8F5] text-stone-900 flex items-center justify-center p-4 selection:bg-stone-900 selection:text-white">
        <EmailVerificationGate
          title="Verify Your Email Address"
          subtitle="Enter the 6-digit single-use verification code sent to your email address to continue."
        />
      </div>
    );
  }

  // 4. Authenticated & verified
  return children ? <>{children}</> : <Outlet />;
};

export { RequireRole } from './RequireRole';
export default RequireAuth;
