import React, { useEffect } from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthProvider, useAuth } from '../src/context/AuthContext';
import { HomePage } from '../src/pages/HomePage';
import { api, setActiveCsrfToken } from '../src/lib/api';
import { Event, User } from '../src/types';

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
  get textContent(): string {
    if (this.nodeType === 3) return (this as any).nodeValue ?? '';
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(val: string) {
    this.childNodes = [];
    if (val) this.appendChild(new MiniTextNode(String(val), this.ownerDocument));
  }
  appendChild(child: MiniNode): MiniNode {
    if (child.parentNode) child.parentNode.removeChild(child);
    if (child.nodeType === 11) {
      for (const grand of [...child.childNodes]) this.appendChild(grand);
      return child;
    }
    child.parentNode = this;
    child.ownerDocument = this.ownerDocument;
    this.childNodes.push(child);
    return child;
  }
  insertBefore(newChild: MiniNode, refChild: MiniNode | null): MiniNode {
    if (!refChild) return this.appendChild(newChild);
    if (newChild.nodeType === 11) {
      for (const grand of [...newChild.childNodes]) this.insertBefore(grand, refChild);
      return newChild;
    }
    if (newChild.parentNode) newChild.parentNode.removeChild(newChild);
    const idx = this.childNodes.indexOf(refChild);
    if (idx === -1) return this.appendChild(newChild);
    newChild.parentNode = this;
    newChild.ownerDocument = this.ownerDocument;
    this.childNodes.splice(idx, 0, newChild);
    return newChild;
  }
  removeChild(child: MiniNode): MiniNode {
    const idx = this.childNodes.indexOf(child);
    if (idx >= 0) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }
  addEventListener() {}
  removeEventListener() {}
}

class MiniTextNode extends MiniNode {
  nodeValue: string;
  constructor(text: string, ownerDocument: MiniDocument | null) {
    super(3, '#text', ownerDocument);
    this.nodeValue = text;
  }
}

class MiniClassList {
  private set = new Set<string>();
  add(...tokens: string[]) {
    tokens.forEach((t) => this.set.add(t));
  }
  remove(...tokens: string[]) {
    tokens.forEach((t) => this.set.delete(t));
  }
  contains(token: string) {
    return this.set.has(token);
  }
}

class MiniElement extends MiniNode {
  tagName: string;
  style: Record<string, string> = {};
  classList = new MiniClassList();
  private attrs = new Map<string, string>();
  constructor(tagName: string, ownerDocument: MiniDocument | null) {
    super(1, tagName.toUpperCase(), ownerDocument);
    this.tagName = tagName.toUpperCase();
  }
  get className(): string {
    return this.attrs.get('class') ?? '';
  }
  set className(v: string) {
    this.attrs.set('class', String(v));
  }
  setAttribute(name: string, value: string) {
    this.attrs.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  removeAttribute(name: string) {
    this.attrs.delete(name);
  }
  findAll(predicate: (el: MiniElement) => boolean): MiniElement[] {
    const out: MiniElement[] = [];
    const walk = (node: MiniNode) => {
      if (node instanceof MiniElement && predicate(node)) out.push(node);
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
  constructor() {
    super(9, '#document', null);
    this.ownerDocument = this;
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
    return new MiniTextNode(text, this);
  }
  createDocumentFragment() {
    return new MiniNode(11, '#document-fragment', this);
  }
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(ticks = 8) {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function makeSampleEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: 'evt-1',
    slug: 'color-fest',
    organizerId: 'org-1',
    organizer: {
      id: 'org-1',
      name: 'Outside Organizer',
      avatarUrl: null,
      organizer: null,
    },
    title: 'Color Fest',
    tagline: 'A colorful outdoor experience',
    description: 'Music and art under the stars',
    category: 'FESTIVAL',
    status: 'PUBLISHED',
    coverImageUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819',
    venueName: 'Sphere',
    venueAddress: '255 Sands Ave',
    city: 'Las Vegas',
    country: 'United States',
    startAt: '2026-12-14T07:00:00.000Z',
    endAt: '2026-12-14T17:30:00.000Z',
    timezone: 'America/Los_Angeles',
    isFeatured: false,
    ticketTiers: [],
    minPriceInCents: 2499,
    currency: 'USD',
    isSoldOut: false,
    ...overrides,
  };
}

const userA: User = {
  id: 'user-a-1',
  email: 'organizer.a@outside.vip',
  name: 'Organizer A',
  role: 'ORGANIZER',
  emailVerified: true,
  avatarUrl: null,
};

const userB: User = {
  id: 'user-b-2',
  email: 'organizer.b@outside.vip',
  name: 'Organizer B',
  role: 'ORGANIZER',
  emailVerified: true,
  avatarUrl: null,
};

describe('Public Event Query Preservation & Auth Cache Scoping', () => {
  let doc: MiniDocument;
  let container: MiniElement;
  let root: Root | null = null;
  let queryClient: QueryClient;

  const origGlobals = {
    window: (globalThis as any).window,
    document: (globalThis as any).document,
    Node: (globalThis as any).Node,
    Element: (globalThis as any).Element,
    HTMLElement: (globalThis as any).HTMLElement,
    HTMLIFrameElement: (globalThis as any).HTMLIFrameElement,
    SVGElement: (globalThis as any).SVGElement,
    Event: (globalThis as any).Event,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as any).IS_REACT_ACT_ENVIRONMENT,
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    setActiveCsrfToken(null);

    doc = new MiniDocument();
    const win: any = {
      document: doc,
      Node: MiniNode,
      Element: MiniElement,
      HTMLElement: MiniElement,
      HTMLIFrameElement: MiniElement,
      SVGElement: MiniElement,
      Event: MiniEvent,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    doc.defaultView = win;

    (globalThis as any).window = win;
    (globalThis as any).document = doc;
    (globalThis as any).Node = MiniNode;
    (globalThis as any).Element = MiniElement;
    (globalThis as any).HTMLElement = MiniElement;
    (globalThis as any).HTMLIFrameElement = MiniElement;
    (globalThis as any).SVGElement = MiniElement;
    (globalThis as any).Event = MiniEvent;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

    container = doc.createElement('div');
    doc.body.appendChild(container);
    root = createRoot(container as unknown as Element);

    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          refetchOnWindowFocus: false,
          staleTime: 1000 * 60 * 2,
          retry: false,
        },
      },
    });
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

    (globalThis as any).window = origGlobals.window;
    (globalThis as any).document = origGlobals.document;
    (globalThis as any).Node = origGlobals.Node;
    (globalThis as any).Element = origGlobals.Element;
    (globalThis as any).HTMLElement = origGlobals.HTMLElement;
    (globalThis as any).HTMLIFrameElement = origGlobals.HTMLIFrameElement;
    (globalThis as any).SVGElement = origGlobals.SVGElement;
    (globalThis as any).Event = origGlobals.Event;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = origGlobals.IS_REACT_ACT_ENVIRONMENT;
  });

  it('1. Reproduces original race: renders event cards when /api/auth/me returns 401 BEFORE /api/events resolves 200', async () => {
    const authDeferred = createDeferred<{ user: User; csrfToken: string }>();
    const eventsDeferred = createDeferred<{
      events: Event[];
      pagination: { page: number; limit: number; total: number; totalPages: number; hasMore: boolean };
    }>();

    vi.spyOn(api.auth, 'me').mockReturnValue(authDeferred.promise);
    const listSpy = vi.spyOn(api.events, 'list').mockReturnValue(eventsDeferred.promise);

    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/']}>
            <AuthProvider>
              <HomePage />
            </AuthProvider>
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    await flushMicrotasks();

    // Initially loading skeletons are visible while both requests are in flight
    expect(container.findAll((el) => el.className.includes('animate-pulse')).length).toBeGreaterThan(0);

    // /api/auth/me returns 401 first (logged-out visitor)
    await act(async () => {
      authDeferred.reject(Object.assign(new Error('Authentication required'), { statusCode: 401 }));
    });
    await flushMicrotasks();

    // /api/events subsequently resolves with HTTP 200 and valid events
    const sampleEvents = [
      makeSampleEvent({ id: 'evt-1', slug: 'color-fest', title: 'Color Fest' }),
      makeSampleEvent({ id: 'evt-2', slug: 'end-year-party', title: 'END YEAR PARTY', venueName: 'Two Rivers Mall', city: 'Nairobi' }),
    ];
    await act(async () => {
      eventsDeferred.resolve({
        events: sampleEvents,
        pagination: { page: 1, limit: 12, total: 2, totalPages: 1, hasMore: false },
      });
    });
    await flushMicrotasks();

    // Skeletons must disappear and event cards must render cleanly
    expect(container.findAll((el) => el.className.includes('animate-pulse')).length).toBe(0);
    expect(container.textContent).toContain('Color Fest');
    expect(container.textContent).toContain('END YEAR PARTY');
    expect(container.textContent).toContain('View all events (2)');
    expect(queryClient.getQueryData(['homepage-events'])).toBeDefined();
    expect(listSpy).toHaveBeenCalledTimes(1);
  });

  it('2. Preserves rendered homepage events and cache when /api/events resolves 200 BEFORE /api/auth/me returns 401', async () => {
    const authDeferred = createDeferred<{ user: User; csrfToken: string }>();
    const eventsDeferred = createDeferred<{
      events: Event[];
      pagination: { page: number; limit: number; total: number; totalPages: number; hasMore: boolean };
    }>();

    vi.spyOn(api.auth, 'me').mockReturnValue(authDeferred.promise);
    const listSpy = vi.spyOn(api.events, 'list').mockReturnValue(eventsDeferred.promise);

    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/']}>
            <AuthProvider>
              <HomePage />
            </AuthProvider>
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    await flushMicrotasks();

    // Events finish first
    await act(async () => {
      eventsDeferred.resolve({
        events: [makeSampleEvent({ id: 'evt-fast', slug: 'fast-fest', title: 'Fast Fest' })],
        pagination: { page: 1, limit: 12, total: 1, totalPages: 1, hasMore: false },
      });
    });
    await flushMicrotasks();

    expect(container.textContent).toContain('Fast Fest');

    // Auth /me returns 401 afterward — must NOT wipe cached homepage events
    await act(async () => {
      authDeferred.reject(Object.assign(new Error('Unauthorized'), { statusCode: 401 }));
    });
    await flushMicrotasks();

    expect(container.findAll((el) => el.className.includes('animate-pulse')).length).toBe(0);
    expect(container.textContent).toContain('Fast Fest');
    expect(queryClient.getQueryData(['homepage-events'])).toBeDefined();
    expect(listSpy).toHaveBeenCalledTimes(1);
  });

  it('3. Preserves public homepage query cleanly when initial /api/auth/me resolves as an authenticated user', async () => {
    const authDeferred = createDeferred<{ user: User; csrfToken: string }>();
    const eventsDeferred = createDeferred<{
      events: Event[];
      pagination: { page: number; limit: number; total: number; totalPages: number; hasMore: boolean };
    }>();

    vi.spyOn(api.auth, 'me').mockReturnValue(authDeferred.promise);
    vi.spyOn(api.events, 'list').mockReturnValue(eventsDeferred.promise);

    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/']}>
            <AuthProvider>
              <HomePage />
            </AuthProvider>
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    await flushMicrotasks();

    await act(async () => {
      authDeferred.resolve({ user: userA, csrfToken: 'csrf-auth-init' });
    });
    await flushMicrotasks();

    await act(async () => {
      eventsDeferred.resolve({
        events: [makeSampleEvent({ id: 'evt-auth', slug: 'auth-fest', title: 'Authenticated Fest' })],
        pagination: { page: 1, limit: 12, total: 1, totalPages: 1, hasMore: false },
      });
    });
    await flushMicrotasks();

    expect(container.findAll((el) => el.className.includes('animate-pulse')).length).toBe(0);
    expect(container.textContent).toContain('Authenticated Fest');
    expect(queryClient.getQueryData(['homepage-events'])).toBeDefined();
  });

  it('4. Renders visible error state (and NOT skeletons or empty-catalogue message) when /api/events fails', async () => {
    vi.spyOn(api.auth, 'me').mockRejectedValue(Object.assign(new Error('Unauthorized'), { statusCode: 401 }));
    vi.spyOn(api.events, 'list').mockRejectedValue(new Error('Database temporarily unavailable'));

    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/']}>
            <AuthProvider>
              <HomePage />
            </AuthProvider>
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    await flushMicrotasks();

    expect(container.findAll((el) => el.className.includes('animate-pulse')).length).toBe(0);
    expect(container.textContent).toContain('Unable to load event showcase');
    expect(container.textContent).toContain('Database temporarily unavailable');
    expect(container.textContent).not.toContain('No live public events found in catalogue.');
  });

  it('5. Logout purges all private, sensitive, and password-protected queries while preserving verified public queries', async () => {
    vi.spyOn(api.auth, 'me').mockResolvedValueOnce({ user: userA, csrfToken: 'csrf-a' });
    vi.spyOn(api.auth, 'logout').mockResolvedValueOnce({ message: 'Signed out' });

    const authRef: { current: ReturnType<typeof useAuth> | null } = { current: null };
    const Probe: React.FC = () => {
      const auth = useAuth();
      useEffect(() => {
        authRef.current = auth;
      });
      return null;
    };

    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <Probe />
          </AuthProvider>
        </QueryClientProvider>
      );
    });
    await flushMicrotasks();

    // Seed verified public queries
    queryClient.setQueryData(['homepage-events'], { events: [makeSampleEvent()] });
    queryClient.setQueryData(['events-discover', '', undefined, '', 'upcoming', 'date_asc', 1], {
      events: [makeSampleEvent()],
    });
    queryClient.setQueryData(['cities'], { cities: ['Nairobi', 'Las Vegas'] });
    queryClient.setQueryData(['event', 'color-fest', null], {
      event: { id: 'evt-1', slug: 'color-fest', status: 'PUBLISHED', isPasswordProtected: false },
    });

    // Seed private / authenticated / sensitive / password-protected / unknown queries
    const privateKeys: unknown[][] = [
      ['organizer-dashboard'],
      ['organizer-events'],
      ['organizer-event', 'evt-1'],
      ['organizer-waitlist', 'evt-1'],
      ['organizer-orders', '', '', 'ALL', 'newest', 1],
      ['organizer-events-for-orders-filter'],
      ['order-refund-summary', 'ord-1'],
      ['order', 'ORD-123', 'secret-token'],
      ['event-team', 'evt-1'],
      ['event-staff', 'evt-1'],
      ['event-promotion-links', 'evt-1'],
      ['event-promotion-analytics', 'evt-1', 'all', '30d', '', ''],
      ['host-events'],
      ['host-analytics', 'evt-1'],
      ['scanner-gates'],
      ['finance-account-status'],
      ['event', 'vip-secret', 'access-token-xyz'],
      ['unknown-future-private-query'],
    ];

    for (const key of privateKeys) {
      queryClient.setQueryData(key, { secret: true });
    }
    queryClient.setQueryData(['event', 'vip-secret', null], {
      event: { id: 'evt-vip', slug: 'vip-secret', status: 'PUBLISHED', isPasswordProtected: true, hasAccess: true },
    });
    queryClient.setQueryData(['event', 'draft-preview', null], {
      event: { id: 'evt-draft', slug: 'draft-preview', status: 'DRAFT', isPasswordProtected: false },
    });

    await act(async () => {
      await authRef.current!.logout();
    });

    // All private, sensitive, event-detail (including published, password-protected, token-unlocked, draft), and unknown keys MUST be gone
    for (const key of privateKeys) {
      expect(queryClient.getQueryData(key), `Expected private key ${JSON.stringify(key)} to be cleared`).toBeUndefined();
    }
    expect(queryClient.getQueryData(['event', 'color-fest', null])).toBeUndefined();
    expect(queryClient.getQueryData(['event', 'vip-secret', null])).toBeUndefined();
    expect(queryClient.getQueryData(['event', 'draft-preview', null])).toBeUndefined();

    // Strictly public catalogue queries MUST remain intact
    expect(queryClient.getQueryData(['homepage-events'])).toBeDefined();
    expect(
      queryClient.getQueryData(['events-discover', '', undefined, '', 'upcoming', 'date_asc', 1])
    ).toBeDefined();
    expect(queryClient.getQueryData(['cities'])).toBeDefined();
  });

  it('6. Switching authenticated users clears previous user private data and all [event, ...] queries (including in-flight owner fetches) without clearing public homepage, Discover, and city queries', async () => {
    vi.spyOn(api.auth, 'me').mockResolvedValueOnce({ user: userA, csrfToken: 'csrf-a' });
    vi.spyOn(api.auth, 'login').mockResolvedValueOnce({ user: userB, csrfToken: 'csrf-b' });
    vi.spyOn(api.auth, 'verifyLoginOtp').mockResolvedValueOnce({ user: userA, csrfToken: 'csrf-a2' });

    const authRef: { current: ReturnType<typeof useAuth> | null } = { current: null };
    const Probe: React.FC = () => {
      const auth = useAuth();
      useEffect(() => {
        authRef.current = auth;
      });
      return null;
    };

    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <Probe />
          </AuthProvider>
        </QueryClientProvider>
      );
    });
    await flushMicrotasks();

    // Strictly public catalogue queries + User A private & event-detail queries cached
    queryClient.setQueryData(['homepage-events'], { events: [makeSampleEvent()] });
    queryClient.setQueryData(['events-discover', '', undefined, '', 'upcoming', 'date_asc', 1], {
      events: [makeSampleEvent()],
    });
    queryClient.setQueryData(['cities'], { cities: ['Nairobi'] });
    queryClient.setQueryData(['organizer-events'], { events: [{ id: 'secret-user-a' }] });
    queryClient.setQueryData(['organizer-orders', '', '', 'ALL', 'newest', 1], { orders: [{ id: 'ord-a' }] });
    queryClient.setQueryData(['scanner-gates'], { events: [{ id: 'gate-a' }] });
    queryClient.setQueryData(['event', 'owner-vip-event', null], {
      event: makeSampleEvent({
        id: 'evt-vip',
        slug: 'owner-vip-event',
        isPasswordProtected: true,
        hasAccess: true,
      }),
    });
    queryClient.setQueryData(['event', 'color-fest', null], {
      event: makeSampleEvent({ id: 'evt-pub', slug: 'color-fest', isPasswordProtected: false }),
    });

    // Also start an IN-FLIGHT ['event', 'inflight-vip', null] query as User A (data is still undefined)
    const inflightVip = createDeferred<{ event: Event }>();
    const inflightPromise = queryClient
      .fetchQuery({
        queryKey: ['event', 'inflight-vip', null],
        queryFn: () => inflightVip.promise,
      })
      .catch(() => undefined);

    // Switch User A -> User B via login() while the owner fetch is still in flight
    await act(async () => {
      await authRef.current!.login(userB.email, 'ValidPass1!');
    });

    // Resolve the stale in-flight owner response after switching to User B
    await act(async () => {
      inflightVip.resolve({
        event: makeSampleEvent({
          id: 'evt-inflight-vip',
          slug: 'inflight-vip',
          isPasswordProtected: true,
          hasAccess: true,
        }),
      });
      await inflightPromise;
    });
    await flushMicrotasks();

    expect(authRef.current?.user?.id).toBe(userB.id);
    expect(queryClient.getQueryData(['organizer-events'])).toBeUndefined();
    expect(queryClient.getQueryData(['organizer-orders', '', '', 'ALL', 'newest', 1])).toBeUndefined();
    expect(queryClient.getQueryData(['scanner-gates'])).toBeUndefined();
    expect(queryClient.getQueryData(['event', 'owner-vip-event', null])).toBeUndefined();
    expect(queryClient.getQueryData(['event', 'color-fest', null])).toBeUndefined();
    expect(queryClient.getQueryData(['event', 'inflight-vip', null])).toBeUndefined();
    expect(queryClient.getQueryData(['homepage-events'])).toBeDefined();
    expect(
      queryClient.getQueryData(['events-discover', '', undefined, '', 'upcoming', 'date_asc', 1])
    ).toBeDefined();
    expect(queryClient.getQueryData(['cities'])).toBeDefined();

    // Populate User B private data + event detail, then switch User B -> User A via verifyLoginOtp()
    queryClient.setQueryData(['host-events'], [{ membershipId: 'host-b' }]);
    queryClient.setQueryData(['event', 'user-b-vip', null], {
      event: makeSampleEvent({ slug: 'user-b-vip', isPasswordProtected: true, hasAccess: true }),
    });
    await act(async () => {
      await authRef.current!.verifyLoginOtp!(userA.email, '123456');
    });

    expect(authRef.current?.user?.id).toBe(userA.id);
    expect(queryClient.getQueryData(['host-events'])).toBeUndefined();
    expect(queryClient.getQueryData(['event', 'user-b-vip', null])).toBeUndefined();
    expect(queryClient.getQueryData(['homepage-events'])).toBeDefined();
    expect(queryClient.getQueryData(['cities'])).toBeDefined();

    // Populate User A private data + event detail, then switch via refreshUser() returning User B
    queryClient.setQueryData(['organizer-dashboard'], { totalRevenueInCents: 99999 });
    queryClient.setQueryData(['event', 'user-a-vip', null], {
      event: makeSampleEvent({ slug: 'user-a-vip', isPasswordProtected: true, hasAccess: true }),
    });
    vi.spyOn(api.auth, 'me').mockResolvedValueOnce({ user: userB, csrfToken: 'csrf-b2' });
    await act(async () => {
      await authRef.current!.refreshUser();
    });

    expect(authRef.current?.user?.id).toBe(userB.id);
    expect(queryClient.getQueryData(['organizer-dashboard'])).toBeUndefined();
    expect(queryClient.getQueryData(['event', 'user-a-vip', null])).toBeUndefined();
    expect(queryClient.getQueryData(['homepage-events'])).toBeDefined();
    expect(queryClient.getQueryData(['cities'])).toBeDefined();
  });
});
