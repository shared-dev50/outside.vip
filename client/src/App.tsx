import React from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Navbar } from './components/layout/Navbar';
import { Footer } from './components/layout/Footer';
import { HomePage } from './pages/HomePage';
import { DiscoverPage } from './pages/DiscoverPage';
import { EventDetailPage } from './pages/EventDetailPage';
import { OrdersPage } from './pages/OrdersPage';
import { TeamsPage } from './pages/TeamsPage';
import { OrganizerDashboardPage } from './pages/OrganizerDashboardPage';
import { CreateEventPage } from './pages/CreateEventPage';
import { EventPreviewPage } from './pages/EventPreviewPage';
import { ScannerPage } from './pages/ScannerPage';
import { OrderConfirmationPage } from './pages/OrderConfirmationPage';
import { FinanceOrganizationPage } from './pages/FinanceOrganizationPage';
import { AuthPage } from './pages/AuthPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { StaffInvitationPage } from './pages/StaffInvitationPage';
import { TeamInvitationPage } from './pages/TeamInvitationPage';
import { HostDashboardPage } from './pages/HostDashboardPage';
import { RequireAuth } from './components/auth/RequireAuth';
import { ScannerGuard } from './components/auth/ScannerGuard';

export const App: React.FC = () => {
  const location = useLocation();
  const isHome = location.pathname === '/';
  const isEditorial =
    isHome ||
    location.pathname.startsWith('/events') ||
    location.pathname.startsWith('/organizer') ||
    location.pathname.startsWith('/host') ||
    location.pathname.startsWith('/orders') ||
    location.pathname.startsWith('/team') ||
    location.pathname.startsWith('/login') ||
    location.pathname.startsWith('/signin') ||
    location.pathname.startsWith('/register') ||
    location.pathname.startsWith('/forgot-password') ||
    location.pathname.startsWith('/reset-password') ||
    location.pathname.startsWith('/teams') ||
    location.pathname.startsWith('/staff/invitations');

  return (
    <div
      className={`min-h-screen flex flex-col font-sans selection:bg-stone-900 selection:text-white dark:selection:bg-[#F3F1EC] dark:selection:text-[#0D0E12] ${
        isEditorial
          ? 'bg-[#FAF8F5] dark:bg-[#0D0E12] text-stone-900 dark:text-[#F3F1EC]'
          : 'bg-white dark:bg-[#0D0E12] text-gray-900 dark:text-[#F3F1EC]'
      }`}
    >
      <Navbar />
      <main className={`flex-1 ${isHome ? '-mt-16' : ''}`}>
        <Routes>
          {/* Public Catalogue & Authentication Routes */}
          <Route path="/" element={<HomePage />} />
          <Route path="/login" element={<AuthPage />} />
          <Route path="/signin" element={<AuthPage />} />
          <Route path="/register" element={<AuthPage />} />
          <Route path="/forgot-password" element={<AuthPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/events" element={<DiscoverPage />} />
          <Route path="/events/:slug" element={<EventDetailPage />} />

          {/* Authenticated Orders */}
          <Route
            path="/orders"
            element={
              <RequireAuth>
                <OrdersPage />
              </RequireAuth>
            }
          />
          <Route path="/staff/invitations/:token" element={<StaffInvitationPage />} />
          <Route path="/team/invitations/:token" element={<TeamInvitationPage />} />
          <Route
            path="/scanner"
            element={
              <ScannerGuard>
                <ScannerPage />
              </ScannerGuard>
            }
          />
          <Route path="/orders/:orderNumber" element={<OrderConfirmationPage />} />

          {/* Event-Scoped Team Workspace (Owners, Platform Admins, and Event Admins with canManageTeam) */}
          <Route
            path="/teams"
            element={
              <RequireAuth>
                <TeamsPage />
              </RequireAuth>
            }
          />

          {/* Authenticated Host Workspace */}
          <Route
            path="/host"
            element={
              <RequireAuth>
                <HostDashboardPage />
              </RequireAuth>
            }
          />

          {/* Authenticated Organizer & Management Routes */}
          <Route
            path="/organizer"
            element={
              <RequireAuth>
                <OrganizerDashboardPage />
              </RequireAuth>
            }
          />
          <Route
            path="/organizer/events/new"
            element={
              <RequireAuth>
                <CreateEventPage />
              </RequireAuth>
            }
          />
          <Route
            path="/organizer/events/:id/edit"
            element={
              <RequireAuth>
                <CreateEventPage />
              </RequireAuth>
            }
          />
          <Route
            path="/organizer/events/:id/preview"
            element={
              <RequireAuth>
                <EventPreviewPage />
              </RequireAuth>
            }
          />
          <Route
            path="/organizer/finance"
            element={
              <RequireAuth>
                <FinanceOrganizationPage />
              </RequireAuth>
            }
          />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <Footer />
    </div>
  );
};

export default App;
