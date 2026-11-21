import React, { useEffect } from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthContext, AuthProvider, useAuth } from './context/AuthContext';
import { HostDashboardPage } from './pages/HostDashboardPage';
import { TeamsPage } from './pages/TeamsPage';
import { OrganizerDashboardPage } from './pages/OrganizerDashboardPage';
import { FinanceOrganizationPage } from './pages/FinanceOrganizationPage';
import { OrdersPage } from './pages/OrdersPage';
import { TeamInvitationPage } from './pages/TeamInvitationPage';
import { EventTeamModal } from './components/team/EventTeamModal';
import { EventPromotionsModal } from './components/promotions/EventPromotionsModal';
import { api, getActiveCsrfToken, setActiveCsrfToken } from './lib/api';
import {
  HostAssignedEventItem,
  OrganizerEventItem,
  TeamInvitationMetadata,
  User,
} from './types';

/**
 * Minimal in-process DOM harness enabling real React 18 `createRoot` mounting,
 * `useEffect` execution, `@tanstack/react-query` async queries/mutations, and
 * bubbling event dispatch (`click`) in Vitest Node environment without jsdom.
 */
class MiniEvent {
  type: string;
  bubbles: boolean;
  cancelable: boolean;
  defaultPrevented = false;
  target: any = null;
  currentTarget: any = null;
  propagationStopped = false;
  constructor(type: string, init?: { bubbles?: boolean; cancelable?: boolean }) {
    this.type = type;
    this.bubbles = init?.bubbles ?? true;
    this.cancelable = init?.cancelable ?? true;
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopPropagation() {
    this.propagationStopped = true;
  }
  stopImmediatePropagation() {
    this.propagationStopped = true;
  }
}

class MiniNode {
  nodeType: number;
  nodeName: string;
  ownerDocument: MiniDocument | null = null;
  parentNode: MiniNode | null = null;
  childNodes: MiniNode[] = [];
  private listeners = new Map<string, Array<(e: any) => void>>();

  constructor(nodeType: number, nodeName: string, ownerDocument: MiniDocument | null) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.ownerDocument = ownerDocument;
  }

  get firstChild(): MiniNode | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): MiniNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  get nextSibling(): MiniNode | null {
    if (!this.parentNode) return null;
    const idx = this.parentNode.childNodes.indexOf(this);
    return idx >= 0 ? this.parentNode.childNodes[idx + 1] ?? null : null;
  }
  get previousSibling(): MiniNode | null {
    if (!this.parentNode) return null;
    const idx = this.parentNode.childNodes.indexOf(this);
    return idx > 0 ? this.parentNode.childNodes[idx - 1] ?? null : null;
  }
  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(val: string) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (val && this.ownerDocument) {
      this.appendChild(this.ownerDocument.createTextNode(val));
    }
  }

  appendChild(child: MiniNode): MiniNode {
    if (child.nodeType === 11) {
      const items = [...child.childNodes];
      for (const item of items) this.appendChild(item);
      return child;
    }
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore(newNode: MiniNode, refNode: MiniNode | null): MiniNode {
    if (!refNode) return this.appendChild(newNode);
    if (newNode.parentNode) newNode.parentNode.removeChild(newNode);
    const idx = this.childNodes.indexOf(refNode);
    if (idx < 0) return this.appendChild(newNode);
    newNode.parentNode = this;
    this.childNodes.splice(idx, 0, newNode);
    return newNode;
  }

  removeChild(child: MiniNode): MiniNode {
    const idx = this.childNodes.indexOf(child);
    if (idx >= 0) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  contains(other: MiniNode | null): boolean {
    let cur = other;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentNode;
    }
    return false;
  }

  addEventListener(type: string, fn: (e: any) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, fn: (e: any) => void) {
    const list = this.listeners.get(type);
    if (!list) return;
    const idx = list.indexOf(fn);
    if (idx >= 0) list.splice(idx, 1);
  }

  dispatchEvent(evt: MiniEvent): boolean {
    evt.target = evt.target ?? this;
    let current: MiniNode | null = this;
    while (current && !evt.propagationStopped) {
      evt.currentTarget = current;
      const list = [...(current.listeners.get(evt.type) ?? [])];
      for (const fn of list) {
        fn.call(current, evt);
      }
      if (!evt.bubbles) break;
      current = current.parentNode;
    }
    return !evt.defaultPrevented;
  }
}

class MiniTextNode extends MiniNode {
  data: string;
  constructor(data: string, doc: MiniDocument) {
    super(3, '#text', doc);
    this.data = data;
  }
  get nodeValue(): string {
    return this.data;
  }
  set nodeValue(val: string) {
    this.data = String(val ?? '');
  }
  get textContent(): string {
    return this.data;
  }
  set textContent(val: string) {
    this.data = String(val ?? '');
  }
}

class MiniCommentNode extends MiniNode {
  data: string;
  constructor(data: string, doc: MiniDocument) {
    super(8, '#comment', doc);
    this.data = data;
  }
  get textContent(): string {
    return '';
  }
}

class MiniElement extends MiniNode {
  tagName: string;
  namespaceURI = 'http://www.w3.org/1999/xhtml';
  attributes = new Map<string, string>();
  style: Record<string, string> = {};
  value = '';
  checked = false;
  disabled = false;
  selected = false;
  type = '';

  get options(): MiniElement[] {
    return this.findAll((el) => el.tagName === 'OPTION');
  }

  constructor(tag: string, doc: MiniDocument) {
    super(1, tag.toUpperCase(), doc);
    this.tagName = tag.toUpperCase();
  }

  get className(): string {
    return this.attributes.get('class') ?? '';
  }
  set className(val: string) {
    this.attributes.set('class', val);
  }
  get id(): string {
    return this.attributes.get('id') ?? '';
  }
  set id(val: string) {
    this.attributes.set('id', val);
  }
  get innerHTML(): string {
    return this.textContent;
  }
  set innerHTML(val: string) {
    this.textContent = val;
  }

  setAttribute(name: string, value: string) {
    const str = String(value);
    this.attributes.set(name, str);
    if (name === 'disabled') this.disabled = true;
    if (name === 'type') this.type = str;
    if (name === 'value') this.value = str;
  }
  getAttribute(name: string): string | null {
    return this.attributes.has(name) ? this.attributes.get(name)! : null;
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
    if (name === 'disabled') this.disabled = false;
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  focus() {}
  blur() {}
  getBoundingClientRect() {
    return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 };
  }

  findAll(predicate: (el: MiniElement) => boolean): MiniElement[] {
    const out: MiniElement[] = [];
    const walk = (node: MiniNode) => {
      if (node instanceof MiniElement && predicate(node)) {
        out.push(node);
      }
      for (const child of node.childNodes) walk(child);
    };
    walk(this);
    return out;
  }
}

class MiniDocument extends MiniNode {
  body: MiniElement;
  documentElement: MiniElement;
  defaultView: any = null;
  activeElement: any = null;
  visibilityState = 'visible';

  constructor() {
    super(9, '#document', null);
    this.documentElement = new MiniElement('html', this);
    this.body = new MiniElement('body', this);
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
  }

  createElement(tag: string) {
    return new MiniElement(tag, this);
  }
  createElementNS(_ns: string, tag: string) {
    return new MiniElement(tag, this);
  }
  createTextNode(text: string) {
    return new MiniTextNode(String(text), this);
  }
  createComment(text: string) {
    return new MiniCommentNode(String(text), this);
  }
  createDocumentFragment() {
    return new MiniNode(11, '#document-fragment', this);
  }
  querySelectorAll() {
    return [];
  }
  querySelector() {
    return null;
  }
}

function setupMiniDom() {
  const doc = new MiniDocument();
  const win: any = {
    document: doc,
    Node: MiniNode,
    Element: MiniElement,
    HTMLElement: MiniElement,
    HTMLInputElement: MiniElement,
    HTMLTextAreaElement: MiniElement,
    HTMLSelectElement: MiniElement,
    HTMLIFrameElement: class MiniIFrameElement {},
    ShadowRoot: class MiniShadowRoot {},
    SVGElement: MiniElement,
    Event: MiniEvent,
    MouseEvent: MiniEvent,
    CustomEvent: MiniEvent,
    location: {
      origin: 'https://outside.vip',
      href: 'https://outside.vip/',
      pathname: '/',
      search: '',
      hash: '',
    },
    history: {
      state: {},
      replaceState: vi.fn(),
      pushState: vi.fn(),
    },
    navigator: {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    open: vi.fn(),
  };
  doc.defaultView = win;

  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as any).window = win;
  (globalThis as any).document = doc;
  (globalThis as any).Node = MiniNode;
  (globalThis as any).Element = MiniElement;
  (globalThis as any).HTMLElement = MiniElement;
  (globalThis as any).HTMLInputElement = MiniElement;
  (globalThis as any).HTMLTextAreaElement = MiniElement;
  (globalThis as any).HTMLSelectElement = MiniElement;
  (globalThis as any).Event = MiniEvent;
  (globalThis as any).MouseEvent = MiniEvent;
  Object.defineProperty(globalThis, 'navigator', {
    value: win.navigator,
    configurable: true,
    writable: true,
  });

  const container = doc.createElement('div');
  doc.body.appendChild(container);
  return { doc, win, container };
}

async function flushMicrotasks(ticks = 6) {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe('S4R-04 & S4R-05: Genuine Mounted React Behavioral Verification (AuthProvider, 401/403 Recovery, Modals & Host Acceptance)', () => {
  let container: MiniElement;
  let root: Root | null = null;
  let queryClient: QueryClient;

  const userA: User = {
    id: 'usr-a-001',
    email: 'usera@outside.vip',
    name: 'User Alpha',
    role: 'ORGANIZER',
    status: 'ACTIVE',
    emailVerified: true,
  };

  const userB: User = {
    id: 'usr-b-002',
    email: 'userb@outside.vip',
    name: 'User Beta',
    role: 'ATTENDEE',
    status: 'ACTIVE',
    emailVerified: true,
  };

  const sampleEvent: OrganizerEventItem = {
    id: 'evt-mounted-1',
    slug: 'mounted-fest',
    title: 'Mounted Security Fest',
    description: 'Mounted test event',
    category: 'MUSIC',
    startAt: '2026-12-10T18:00:00Z',
    endAt: '2026-12-10T23:00:00Z',
    timezone: 'Africa/Nairobi',
    venueName: 'Nairobi Arena',
    venueAddress: '100 Arena Way',
    city: 'Nairobi',
    country: 'Kenya',
    coverImageUrl: 'https://example.com/cover.jpg',
    status: 'DRAFT',
    organizerId: userA.id,
    organizer: { id: userA.id, name: userA.name },
    isFeatured: false,
    ticketTiers: [],
    isOwner: true,
    accessRole: 'OWNER',
    permissions: null,
    totalCapacity: 100,
    ticketsSold: 0,
    revenueInCents: 0,
    revenueFormatted: '$0.00',
  };

  const createMockAuth = (user: User | null, overrides?: Partial<any>) => ({
    user,
    isLoading: false,
    login: vi.fn(),
    requestLoginOtp: vi.fn(),
    verifyLoginOtp: vi.fn(),
    clearSessionState: vi.fn(),
    register: vi.fn(),
    verifyEmail: vi.fn(),
    resendVerification: vi.fn(),
    refreshUser: vi.fn().mockResolvedValue(user),
    logout: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  });

  beforeEach(() => {
    const dom = setupMiniDom();
    container = dom.container;
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    setActiveCsrfToken(null);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = null;
    }
    queryClient.clear();
    vi.restoreAllMocks();
    delete (globalThis as any).window;
    delete (globalThis as any).document;
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  });

  it('AuthProvider clears React Query cache on account switch (login & verifyLoginOtp), logout, and refreshUser() failure or user-ID change', async () => {
    vi.spyOn(api.auth, 'me').mockResolvedValueOnce({ user: userA, csrfToken: 'csrf-a' });
    vi.spyOn(api.auth, 'login').mockResolvedValueOnce({ user: userB, csrfToken: 'csrf-b' });
    vi.spyOn(api.auth, 'verifyLoginOtp').mockResolvedValueOnce({ user: userA, csrfToken: 'csrf-a2' });
    vi.spyOn(api.auth, 'logout').mockResolvedValueOnce({ message: 'Signed out' });

    const authRef: { current: ReturnType<typeof useAuth> | null } = { current: null };
    const AuthProbe: React.FC = () => {
      const auth = useAuth();
      useEffect(() => {
        authRef.current = auth;
      });
      return <div data-user={auth.user?.id ?? 'none'}>{auth.user?.email ?? 'anonymous'}</div>;
    };

    root = createRoot(container as any);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <AuthProbe />
          </AuthProvider>
        </QueryClientProvider>
      );
    });
    await flushMicrotasks();

    // Hydrated as User A
    expect(authRef.current?.user?.id).toBe(userA.id);
    expect(getActiveCsrfToken()).toBe('csrf-a');

    // Populate React Query cache with User A private data
    queryClient.setQueryData(['organizer-events'], { events: [{ id: 'user-a-secret-evt' }] });
    queryClient.setQueryData(['host-events'], [{ membershipId: 'user-a-host' }]);
    expect(queryClient.getQueryData(['organizer-events'])).toBeDefined();

    // 1. Switch to User B via login() -> MUST wipe User A's cached queries immediately
    await act(async () => {
      await authRef.current!.login(userB.email, 'Password123!');
    });
    expect(authRef.current?.user?.id).toBe(userB.id);
    expect(getActiveCsrfToken()).toBe('csrf-b');
    expect(queryClient.getQueryData(['organizer-events'])).toBeUndefined();
    expect(queryClient.getQueryData(['host-events'])).toBeUndefined();

    // 2. Populate User B cache, then switch via verifyLoginOtp() -> MUST wipe User B cache
    queryClient.setQueryData(['host-events'], [{ membershipId: 'user-b-host' }]);
    await act(async () => {
      await authRef.current!.verifyLoginOtp!(userA.email, '123456');
    });
    expect(authRef.current?.user?.id).toBe(userA.id);
    expect(queryClient.getQueryData(['host-events'])).toBeUndefined();

    // 3. Populate User A cache, then simulate refreshUser() returning a DIFFERENT user -> MUST wipe cache
    queryClient.setQueryData(['organizer-events'], { events: [{ id: 'stale-a' }] });
    vi.spyOn(api.auth, 'me').mockResolvedValueOnce({ user: userB, csrfToken: 'csrf-b2' });
    await act(async () => {
      await authRef.current!.refreshUser();
    });
    expect(authRef.current?.user?.id).toBe(userB.id);
    expect(queryClient.getQueryData(['organizer-events'])).toBeUndefined();

    // 4. Populate cache, then simulate refreshUser() failing (401 expired session) -> MUST clear user, CSRF & QueryClient!
    queryClient.setQueryData(['host-events'], [{ membershipId: 'stale-b' }]);
    vi.spyOn(api.auth, 'me').mockRejectedValueOnce(Object.assign(new Error('Unauthorized'), { statusCode: 401 }));
    await act(async () => {
      const res = await authRef.current!.refreshUser();
      expect(res).toBeNull();
    });
    expect(authRef.current?.user).toBeNull();
    expect(getActiveCsrfToken()).toBeNull();
    expect(queryClient.getQueryData(['host-events'])).toBeUndefined();

    // 5. Logout also clears QueryClient
    queryClient.setQueryData(['organizer-dashboard'], { totalEvents: 5 });
    await act(async () => {
      await authRef.current!.logout();
    });
    expect(queryClient.getQueryData(['organizer-dashboard'])).toBeUndefined();
  });

  it('HostDashboardPage preserves session & invalidates host-events on 403 revocation, and clears session strictly on 401', async () => {
    const assignedEvents: HostAssignedEventItem[] = [
      {
        membershipId: 'mem-revoked-1',
        event: {
          id: 'evt-host-revoked',
          slug: 'sunset-session',
          title: 'Sunset Session',
          status: 'PUBLISHED',
          startAt: '2026-12-20T18:00:00Z',
          endAt: '2026-12-20T23:00:00Z',
          venueName: 'Kilifi Creek',
          city: 'Kilifi',
          coverImageUrl: 'https://example.com/sunset.jpg',
        },
        hostLink: {
          id: 'link-1',
          name: 'Host Link',
          status: 'ACTIVE',
          slug: 'sunset-host',
          shortUrl: '/r/sunset-host',
        },
      },
    ];

    const clearSessionSpy = vi.fn();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    vi.spyOn(api.host, 'getEvents').mockResolvedValue(assignedEvents);
    vi.spyOn(api.host, 'getAnalytics').mockRejectedValue(
      Object.assign(new Error('Active Event Host membership required'), { statusCode: 403 })
    );

    root = createRoot(container as any);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/host']}>
            <AuthContext.Provider value={createMockAuth(userB, { clearSessionState: clearSessionSpy })}>
              <HostDashboardPage />
            </AuthContext.Provider>
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    await flushMicrotasks(10);

    // 403 MUST NOT clear the valid session, MUST invalidate host-events, and MUST render Host Access Revoked
    expect(clearSessionSpy).not.toHaveBeenCalled();
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['host-events'] });
    expect(container.textContent).toContain('Host Access Revoked');
    expect(container.textContent).not.toContain('Loading private traffic analytics...');

    // Now test 401 session expiry on HostDashboardPage
    await act(async () => {
      root!.unmount();
    });
    queryClient.clear();
    clearSessionSpy.mockClear();
    vi.spyOn(api.host, 'getEvents').mockRejectedValueOnce(
      Object.assign(new Error('Session expired'), { statusCode: 401 })
    );

    root = createRoot(container as any);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/host']}>
            <AuthContext.Provider value={createMockAuth(userB, { clearSessionState: clearSessionSpy })}>
              <HostDashboardPage />
            </AuthContext.Provider>
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    await flushMicrotasks(8);

    expect(clearSessionSpy).toHaveBeenCalledTimes(1);
  });

  it('TeamsPage, OrdersPage, FinanceOrganizationPage, EventTeamModal, and EventPromotionsModal clear session on 401 and preserve session on 403', async () => {
    const clearSpy = vi.fn();

    // 1. TeamsPage: 401 clears session
    vi.spyOn(api.organizer, 'listEvents').mockRejectedValueOnce(
      Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    );
    root = createRoot(container as any);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/teams']}>
            <AuthContext.Provider value={createMockAuth(userA, { clearSessionState: clearSpy })}>
              <TeamsPage />
            </AuthContext.Provider>
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    await flushMicrotasks();
    expect(clearSpy).toHaveBeenCalledTimes(1);

    // 2. OrdersPage: 403 does NOT clear session; 401 DOES clear session
    clearSpy.mockClear();
    await act(async () => {
      root!.unmount();
    });
    queryClient.clear();
    vi.spyOn(api.organizer, 'getOrders').mockRejectedValueOnce(
      Object.assign(new Error('Forbidden'), { statusCode: 403 })
    );
    root = createRoot(container as any);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/orders']}>
            <AuthContext.Provider value={createMockAuth(userB, { clearSessionState: clearSpy })}>
              <OrdersPage />
            </AuthContext.Provider>
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    await flushMicrotasks();
    expect(clearSpy).not.toHaveBeenCalled();

    await act(async () => {
      root!.unmount();
    });
    queryClient.clear();
    vi.spyOn(api.organizer, 'getOrders').mockRejectedValueOnce(
      Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    );
    root = createRoot(container as any);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/orders']}>
            <AuthContext.Provider value={createMockAuth(userB, { clearSessionState: clearSpy })}>
              <OrdersPage />
            </AuthContext.Provider>
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    await flushMicrotasks();
    expect(clearSpy).toHaveBeenCalledTimes(1);

    // 3. FinanceOrganizationPage: 401 clears session
    clearSpy.mockClear();
    await act(async () => {
      root!.unmount();
    });
    vi.spyOn(api.finance, 'getSupportedCountries').mockResolvedValueOnce({
      countries: [],
      defaultCountry: 'US',
    });
    vi.spyOn(api.finance, 'getStatus').mockRejectedValueOnce(
      Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    );
    root = createRoot(container as any);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/organizer/finance']}>
            <AuthContext.Provider value={createMockAuth(userA, { clearSessionState: clearSpy })}>
              <FinanceOrganizationPage />
            </AuthContext.Provider>
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    await flushMicrotasks();
    expect(clearSpy).toHaveBeenCalledTimes(1);

    // 4. EventTeamModal: 401 on team query clears session, while 403 on staff query preserves session
    clearSpy.mockClear();
    await act(async () => {
      root!.unmount();
    });
    queryClient.clear();
    vi.spyOn(api.team, 'getTeam').mockResolvedValueOnce({ members: [], invitations: [] });
    vi.spyOn(api.staff, 'getTeam').mockRejectedValueOnce(
      Object.assign(new Error('Forbidden'), { statusCode: 403 })
    );
    root = createRoot(container as any);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <AuthContext.Provider value={createMockAuth(userA, { clearSessionState: clearSpy })}>
              <EventTeamModal event={sampleEvent} isOpen={true} />
            </AuthContext.Provider>
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    await flushMicrotasks();
    expect(clearSpy).not.toHaveBeenCalled();

    await act(async () => {
      root!.unmount();
    });
    queryClient.clear();
    vi.spyOn(api.team, 'getTeam').mockRejectedValueOnce(
      Object.assign(new Error('Session expired'), { statusCode: 401 })
    );
    vi.spyOn(api.staff, 'getTeam').mockResolvedValueOnce({ staff: [], invitations: [] });
    root = createRoot(container as any);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <AuthContext.Provider value={createMockAuth(userA, { clearSessionState: clearSpy })}>
              <EventTeamModal event={sampleEvent} isOpen={true} />
            </AuthContext.Provider>
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    await flushMicrotasks();
    expect(clearSpy).toHaveBeenCalledTimes(1);

    // 5. EventPromotionsModal: 401 clears session
    clearSpy.mockClear();
    await act(async () => {
      root!.unmount();
    });
    queryClient.clear();
    vi.spyOn(api.promotions, 'getLinks').mockRejectedValueOnce(
      Object.assign(new Error('Session expired'), { statusCode: 401 })
    );
    root = createRoot(container as any);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <AuthContext.Provider value={createMockAuth(userA, { clearSessionState: clearSpy })}>
              <EventPromotionsModal event={sampleEvent} isOpen={true} onClose={vi.fn()} />
            </AuthContext.Provider>
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    await flushMicrotasks();
    expect(clearSpy).toHaveBeenCalledTimes(1);

    // 6. OrganizerDashboardPage: 401 on publish mutation clears session
    clearSpy.mockClear();
    await act(async () => {
      root!.unmount();
    });
    queryClient.clear();
    vi.spyOn(api.organizer, 'publishEvent').mockRejectedValueOnce(
      Object.assign(new Error('Session expired'), { statusCode: 401 })
    );
    root = createRoot(container as any);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/organizer']}>
            <AuthContext.Provider value={createMockAuth(userA, { clearSessionState: clearSpy })}>
              <OrganizerDashboardPage
                initialUser={userA}
                initialIsLoading={false}
                initialEvents={[sampleEvent]}
                initialStats={{
                  totalEvents: 1,
                  publishedEvents: 0,
                  draftEvents: 1,
                  ticketsSold: 0,
                  grossRevenueInCents: 0,
                  grossRevenueFormatted: '$0.00',
                  currency: 'USD',
                }}
              />
            </AuthContext.Provider>
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    await flushMicrotasks();

    const publishBtn = container.findAll(
      (el) => el.tagName === 'BUTTON' && el.textContent.trim() === 'Publish'
    )[0];
    expect(publishBtn).toBeDefined();

    await act(async () => {
      publishBtn.dispatchEvent(new MiniEvent('click', { bubbles: true }));
    });
    await flushMicrotasks();
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });

  it('TeamInvitationPage Host acceptance invalidates host-events, host-analytics, organizer-events, and organizer-dashboard, refreshes auth, and preserves the personal promotional link confirmation view', async () => {
    const hostInvite: TeamInvitationMetadata = {
      id: 'inv-host-mounted',
      eventId: 'evt-mounted-host',
      eventTitle: 'Kilifi Sunrise Festival',
      eventSlug: 'kilifi-sunrise',
      organizerName: 'Sol Collective',
      role: 'HOST',
      emailMasked: 'u***b@outside.vip',
      status: 'PENDING',
      expiresAt: '2026-12-30T12:00:00Z',
    };

    const refreshUserSpy = vi.fn().mockResolvedValue(userB);
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    vi.spyOn(api.team, 'acceptInvitation').mockResolvedValueOnce({
      memberId: 'mem-new-host',
      eventId: hostInvite.eventId,
      role: 'HOST',
      status: 'ACTIVE',
      hostLink: {
        id: 'link-new-1',
        slug: 'beta-kilifi-sunrise',
        name: 'User Beta Personal Link',
      },
    });

    root = createRoot(container as any);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/team/invitations/host-tok-123']}>
            <AuthContext.Provider value={createMockAuth(userB, { refreshUser: refreshUserSpy })}>
              <Routes>
                <Route
                  path="/team/invitations/:token"
                  element={<TeamInvitationPage initialInvitation={hostInvite} />}
                />
                <Route path="/host" element={<div>Navigated Away To Host</div>} />
              </Routes>
            </AuthContext.Provider>
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    await flushMicrotasks();

    const acceptBtn = container.findAll(
      (el) => el.tagName === 'BUTTON' && el.textContent.includes('Accept Team Invitation')
    )[0];
    expect(acceptBtn).toBeDefined();

    await act(async () => {
      acceptBtn.dispatchEvent(new MiniEvent('click', { bubbles: true }));
    });
    await flushMicrotasks();

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['host-events'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['host-analytics'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['organizer-events'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['organizer-dashboard'] });
    expect(refreshUserSpy).toHaveBeenCalledTimes(1);

    // Must preserve confirmation view with personal promotional link and CTA (NOT immediately navigate away)
    expect(container.textContent).toContain('Welcome to the Team!');
    expect(container.textContent).toContain('Your Personal Promotional Link');
    expect(container.textContent).toContain('Go to Host Workspace');
    expect(container.textContent).not.toContain('Navigated Away To Host');
  });
});
