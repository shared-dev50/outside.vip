import React from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Navbar } from './components/layout/Navbar';
import { Footer } from './components/layout/Footer';
import { HomePage } from './pages/HomePage';
import { DiscoverPage } from './pages/DiscoverPage';
import { EventDetailPage } from './pages/EventDetailPage';
import { OrganizerDashboardPage } from './pages/OrganizerDashboardPage';
import { CreateEventPage } from './pages/CreateEventPage';
import { EventPreviewPage } from './pages/EventPreviewPage';
import { ScannerPage } from './pages/ScannerPage';
import { OrderConfirmationPage } from './pages/OrderConfirmationPage';
import { FinanceOrganizationPage } from './pages/FinanceOrganizationPage';

export const App: React.FC = () => {
  const location = useLocation();
  const isHome = location.pathname === '/';
  const isEditorial =
    isHome ||
    location.pathname.startsWith('/events') ||
    location.pathname.startsWith('/organizer');

  return (
    <div
      className={`min-h-screen flex flex-col font-sans selection:bg-stone-900 selection:text-white ${
        isEditorial ? 'bg-[#FAF8F5] text-stone-900' : 'bg-white text-gray-900'
      }`}
    >
      <Navbar />
      <main className={`flex-1 ${isHome ? '-mt-16' : ''}`}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/events" element={<DiscoverPage />} />
          <Route path="/events/:slug" element={<EventDetailPage />} />
          <Route path="/organizer" element={<OrganizerDashboardPage />} />
          <Route path="/organizer/events/new" element={<CreateEventPage />} />
          <Route path="/organizer/events/:id/edit" element={<CreateEventPage />} />
          <Route path="/organizer/events/:id/preview" element={<EventPreviewPage />} />
          <Route path="/organizer/finance" element={<FinanceOrganizationPage />} />
          <Route path="/scanner" element={<ScannerPage />} />
          <Route path="/orders/:orderNumber" element={<OrderConfirmationPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <Footer />
    </div>
  );
};

export default App;
