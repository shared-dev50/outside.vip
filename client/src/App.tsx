import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Navbar } from './components/layout/Navbar';
import { Footer } from './components/layout/Footer';
import { HomePage } from './pages/HomePage';
import { EventDetailPage } from './pages/EventDetailPage';
import { OrganizerDashboardPage } from './pages/OrganizerDashboardPage';
import { CreateEventPage } from './pages/CreateEventPage';
import { ScannerPage } from './pages/ScannerPage';
import { OrderConfirmationPage } from './pages/OrderConfirmationPage';

export const App: React.FC = () => {
  return (
    <div className="min-h-screen flex flex-col bg-[#08090C] text-slate-100 font-sans selection:bg-brand-neon selection:text-black">
      <Navbar />
      <main className="flex-1">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/events/:slug" element={<EventDetailPage />} />
          <Route path="/organizer" element={<OrganizerDashboardPage />} />
          <Route path="/organizer/events/new" element={<CreateEventPage />} />
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
