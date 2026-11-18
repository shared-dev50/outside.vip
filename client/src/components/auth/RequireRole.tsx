import React from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { Role } from '../../types';
import { useAuth } from '../../context/AuthContext';
import { RequireAuth } from './RequireAuth';

export interface RequireRoleProps {
  children?: React.ReactNode;
  allowedRoles: Role[];
  redirectTo?: string;
  requireVerified?: boolean;
}

const RoleCheck: React.FC<{
  allowedRoles: Role[];
  redirectTo: string;
  children?: React.ReactNode;
}> = ({ allowedRoles, redirectTo, children }) => {
  const { user } = useAuth();

  if (!user || !allowedRoles.includes(user.role)) {
    return <Navigate to={redirectTo} replace />;
  }

  return children ? <>{children}</> : <Outlet />;
};

export const RequireRole: React.FC<RequireRoleProps> = ({
  children,
  allowedRoles,
  redirectTo = '/organizer',
  requireVerified = true,
}) => {
  return (
    <RequireAuth requireVerified={requireVerified}>
      <RoleCheck allowedRoles={allowedRoles} redirectTo={redirectTo}>
        {children}
      </RoleCheck>
    </RequireAuth>
  );
};

export default RequireRole;

