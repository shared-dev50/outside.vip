import React from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Navbar } from './components/layout/Navbar';
import { Footer } from './components/layout/Footer';
import { HomePage } from './pages/HomePage';
import { DiscoverPage } from './pages/DiscoverPage';
import { EventDetailPage } from './pages/EventDetailPage';
import { OrdersPage } from './pages/OrdersPage';
import { TeamsPage } from './pages/TeamsPage';
import { AtendeePage } from './pages/AtendeePage';
import { OrganizerDashboardPage } from './pages/OrganizerDashboardPage';
import { CreateEventPage } from './pages/CreateEventPage';
import { EventPreviewPage } from './pages/EventPreviewPage';
import { ScannerPage } from './pages/ScannerPage';
import { OrderConfirmationPage } from './pages/OrderConfirmationPage';
import { FinanceOrganizationPage } from './pages/FinanceOrganizationPage';
import { AuthPage } from './pages/AuthPage';
import { StaffInvitationPage } from './pages/StaffInvitationPage';
import { RequireAuth, RequireRole } from './components/auth/RequireAuth';
import { ScannerGuard } from './components/auth/ScannerGuard';

export const App: React.FC = () => {
  const location = useLocation();
  const isHome = location.pathname === '/';
  const isEditorial =
    isHome ||
    location.pathname.startsWith('/events') ||
    location.pathname.startsWith('/organizer') ||
    location.pathname.startsWith('/orders') ||
    location.pathname.startsWith('/attendees') ||
    location.pathname.startsWith('/team');
    location.pathname.startsWith('/login') ||
    location.pathname.startsWith('/signin') ||
    location.pathname.startsWith('/register') ||
    location.pathname.startsWith('/forgot-password');
    location.pathname.startsWith('/teams') ||
    location.pathname.startsWith('/staff/invitations');

  return (
    <div
      className={`min-h-screen flex flex-col font-sans selection:bg-stone-900 selection:text-white ${
        isEditorial ? 'bg-[#FAF8F5] text-stone-900' : 'bg-white text-gray-900'
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
          <Route path="/events" element={<DiscoverPage />} />
          <Route path="/events/:slug" element={<EventDetailPage />} />

          {/* Conditional & Specialized Access Routes (outside generic guards) */}
          <Route path="/teams" element={<TeamsPage />} />
          <Route path="/orders" element={<OrdersPage />} />
          <Route path="/atendees" element={<AtendeePage />} />
          <Route path="/staff/invitations/:token" element={<StaffInvitationPage />} />
          <Route
            path="/scanner"
            element={
              <ScannerGuard>
                <ScannerPage />
              </ScannerGuard>
            }
          />
          <Route path="/orders/:orderNumber" element={<OrderConfirmationPage />} />

          {/* Role-Restricted Route (/teams requires ORGANIZER or ADMIN) */}
          <Route
            path="/teams"
            element={
              <RequireRole allowedRoles={['ORGANIZER', 'ADMIN']}>
                <TeamsPage />
              </RequireRole>
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
