import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from './context/AuthContext';
import { Navbar } from './components/layout/Navbar';
import { AuthPage } from './pages/AuthPage';
import { AuthFormCard } from './components/auth/AuthFormCard';
import { OrganizerDashboardPage } from './pages/OrganizerDashboardPage';
import { CreateEventPage } from './pages/CreateEventPage';

const FORBIDDEN_DEMO_STRINGS = [
  'Demo Sign In',
  'Sol Collective & Sound',
  'Sol Collective &amp; Sound',
  'Alex Mwangi',
  'Outside Admin',
  'Organizer Profile',
  'Attendee Profile',
  'Admin Profile',
  'Sign in as Sol Collective',
  'Organizer Demo',
  'quickLoginAs',
];

describe('Production Authentication UI & Removal of Demo Sign-In', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as any).localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, val: string) => store.set(key, val),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
    };
  });

  it('1. Renders standard email/password Sign In flow with registration and password recovery links and zero demo options', () => {
    const html = renderToString(
      <MemoryRouter initialEntries={['/login']}>
        <AuthProvider>
          <AuthFormCard initialMode="login" />
        </AuthProvider>
      </MemoryRouter>
    );

    expect(html).toContain('Sign in to your account');
    expect(html).toContain('Email Address');
    expect(html).toContain('Password');
    expect(html).toContain('Forgot password?');
    expect(html).toContain('Create an account');
    expect(html).toContain('Sign In');

    for (const forbidden of FORBIDDEN_DEMO_STRINGS) {
      expect(html).not.toContain(forbidden);
    }
  });

  it('2. Renders standard Create Account (registration) flow without demo options', () => {
    const html = renderToString(
      <MemoryRouter initialEntries={['/register']}>
        <AuthProvider>
          <AuthFormCard initialMode="register" />
        </AuthProvider>
      </MemoryRouter>
    );

    expect(html).toContain('Create your account');
    expect(html).toContain('Full Name');
    expect(html).toContain('Email Address');
    expect(html).toContain('Password');
    expect(html).toContain('Create Account');
    expect(html).toContain('Sign in');

    for (const forbidden of FORBIDDEN_DEMO_STRINGS) {
      expect(html).not.toContain(forbidden);
    }
  });

  it('3. Renders standard Password Recovery flow without demo options', () => {
    const html = renderToString(
      <MemoryRouter initialEntries={['/forgot-password']}>
        <AuthProvider>
          <AuthFormCard initialMode="forgot-password" />
        </AuthProvider>
      </MemoryRouter>
    );

    expect(html).toContain('Reset your password');
    expect(html).toContain('Email Address');
    expect(html).toContain('Send Recovery Instructions');
    expect(html).toContain('Back to Sign In');

    for (const forbidden of FORBIDDEN_DEMO_STRINGS) {
      expect(html).not.toContain(forbidden);
    }
  });

  it('4. Renders Navbar without any Demo Sign In dropdown or profile shortcuts', () => {
    const html = renderToString(
      <MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <Navbar />
        </AuthProvider>
      </MemoryRouter>
    );

    expect(html).toContain('Sign in');
    expect(html).toContain('href="/login"');
    expect(html).toContain('Create Event');

    for (const forbidden of FORBIDDEN_DEMO_STRINGS) {
      expect(html).not.toContain(forbidden);
    }
  });

  it('5. Renders standard email/password authentication on unauthenticated OrganizerDashboardPage and CreateEventPage', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const dashboardHtml = renderToString(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/organizer']}>
          <AuthProvider>
            <OrganizerDashboardPage />
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );

    expect(dashboardHtml).toContain('Sign In to Manage Events');
    expect(dashboardHtml).toContain('Email Address');
    expect(dashboardHtml).toContain('Password');
    expect(dashboardHtml).toContain('Forgot password?');
    expect(dashboardHtml).toContain('Create an account');

    for (const forbidden of FORBIDDEN_DEMO_STRINGS) {
      expect(dashboardHtml).not.toContain(forbidden);
    }

    const createEventHtml = renderToString(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/organizer/events/new']}>
          <AuthProvider>
            <Routes>
              <Route path="/organizer/events/new" element={<CreateEventPage />} />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );

    expect(createEventHtml).toContain('Sign In Required');
    expect(createEventHtml).toContain('Email Address');
    expect(createEventHtml).toContain('Password');

    for (const forbidden of FORBIDDEN_DEMO_STRINGS) {
      expect(createEventHtml).not.toContain(forbidden);
    }
  });

  it('6. Confirms AuthPage, Navbar, AuthContext, OrganizerDashboardPage, and CreateEventPage source files contain no demo login shortcuts', () => {
    const filesToCheck = [
      'context/AuthContext.tsx',
      'components/layout/Navbar.tsx',
      'components/auth/AuthFormCard.tsx',
      'pages/AuthPage.tsx',
      'pages/OrganizerDashboardPage.tsx',
      'pages/CreateEventPage.tsx',
    ];

    for (const relativeFile of filesToCheck) {
      const fullPath = path.resolve(__dirname, relativeFile);
      const source = fs.readFileSync(fullPath, 'utf8');
      for (const forbidden of FORBIDDEN_DEMO_STRINGS) {
        expect(source).not.toContain(forbidden);
      }
      expect(source).not.toContain('Outside2026!');
    }

    expect(typeof AuthPage).toBe('function');

    // Verify neither AuthContext.tsx nor lib/api.ts stores credentials/tokens in localStorage or sessionStorage
    const authContextSrc = fs.readFileSync(path.resolve(__dirname, 'context/AuthContext.tsx'), 'utf8');
    const apiSrc = fs.readFileSync(path.resolve(__dirname, 'lib/api.ts'), 'utf8');
    expect(authContextSrc).not.toContain('localStorage');
    expect(authContextSrc).not.toContain('sessionStorage');
    expect(authContextSrc).not.toContain('outside_token');
    expect(apiSrc).not.toContain('localStorage');
    expect(apiSrc).not.toContain('sessionStorage');
    expect(apiSrc).not.toContain('outside_token');
    expect(apiSrc).not.toContain('Authorization');
  });
});

