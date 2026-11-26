import React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthContext } from '../src/context/AuthContext';
import { Navbar } from '../src/components/layout/Navbar';
import { RequireAuth, RequireRole } from '../src/components/auth/RequireAuth';
import { deriveNavigationState } from '../src/lib/navigation';
import { api } from '../src/lib/api';
import { DEFAULT_ADMIN_PERMISSIONS } from '../src/components/team/AdminPermissionsModal';
import {
  HostAssignedEventItem,
  OrganizerEventItem,
  User,
} from '../src/types';

class MiniEvent {
  type: string;
  key = '';
  bubbles: boolean;
  cancelable: boolean;
  button = 0;
  defaultPrevented = false;
  target: any = null;
  currentTarget: any = null;
  propagationStopped = false;
  constructor(
    type: string,
    init?: { bubbles?: boolean; cancelable?: boolean; button?: number; key?: string }
  ) {
    this.type = type;
    this.bubbles = init?.bubbles ?? true;
    this.cancelable = init?.cancelable ?? true;
    this.button = init?.button ?? 0;
    this.key = init?.key ?? '';
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
  contains(target: MiniNode | null): boolean {
    let cur = target;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentNode;
    }
    return false;
  }
  addEventListener(type: string, fn: (e: any) => void) {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }
  removeEventListener(type: string, fn: (e: any) => void) {
    const arr = this.listeners.get(type);
    if (!arr) return;
    const idx = arr.indexOf(fn);
    if (idx >= 0) arr.splice(idx, 1);
  }
  dispatchEvent(event: MiniEvent): boolean {
    if (!event.target) event.target = this;
    let current: MiniNode | null = this;
    while (current) {
      event.currentTarget = current;
      const arr = current.listeners.get(event.type);
      if (arr) {
        for (const fn of [...arr]) {
          fn(event);
          if (event.propagationStopped) break;
        }
      }
      if (!event.bubbles || event.propagationStopped) break;
      current = current.parentNode;
    }
    return !event.defaultPrevented;
  }
}

class MiniTextNode extends MiniNode {
  nodeValue: string;
  constructor(text: string, ownerDocument: MiniDocument | null) {
    super(3, '#text', ownerDocument);
    this.nodeValue = text;
  }
}

class MiniElement extends MiniNode {
  tagName: string;
  style: Record<string, string> = {};
  private attrs = new Map<string, string>();
  constructor(tagName: string, ownerDocument: MiniDocument | null) {
    super(1, tagName.toUpperCase(), ownerDocument);
    this.tagName = tagName.toUpperCase();
  }
  get id(): string {
    return this.attrs.get('id') ?? '';
  }
  set id(v: string) {
    this.attrs.set('id', String(v));
  }
  get className(): string {
    return this.attrs.get('class') ?? '';
  }
  set className(v: string) {
    this.attrs.set('class', String(v));
  }
  get href(): string {
    return this.attrs.get('href') ?? '';
  }
  set href(v: string) {
    this.attrs.set('href', String(v));
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
  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }
  focus() {
    if (this.ownerDocument) {
      this.ownerDocument.activeElement = this;
    }
  }
  click() {
    this.dispatchEvent(new MiniEvent('click', { bubbles: true, cancelable: true }));
  }
  querySelectorAll(selector: string): MiniElement[] {
    const out: MiniElement[] = [];
    const walk = (node: MiniNode) => {
      for (const child of node.childNodes) {
        if (child instanceof MiniElement) {
          if (matchesSimpleSelector(child, selector)) out.push(child);
          walk(child);
        }
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector: string): MiniElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function matchesSimpleSelector(el: MiniElement, selector: string): boolean {
  const attrMatch = selector.match(/^([a-z0-9_-]*)\[([a-z0-9_-]+)(?:="([^"]*)")?\]$/i);
  if (attrMatch) {
    const [, tag, attr, val] = attrMatch;
    if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
    return val !== undefined ? el.getAttribute(attr) === val : el.hasAttribute(attr);
  }
  return el.tagName.toLowerCase() === selector.toLowerCase();
}

class MiniDocument extends MiniNode {
  body: MiniElement;
  documentElement: MiniElement;
  activeElement: MiniElement | null = null;
  defaultView: any = null;
  title = '';
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
  getElementById(id: string): MiniElement | null {
    return this.body.querySelector(`[id="${id}"]`);
  }
}

function createAuthMock(user: User | null, logoutMock = vi.fn().mockResolvedValue(undefined)) {
  return {
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
    logout: logoutMock,
  };
}

function makeOrganizerEvent(overrides: Partial<OrganizerEventItem> = {}): OrganizerEventItem {
  return {
    id: 'evt-1',
    slug: 'evt-1',
    organizerId: 'org-1',
    title: 'Sample Event',
    description: 'Sample event description',
    category: 'MUSIC',
    status: 'PUBLISHED',
    coverImageUrl: 'https://example.com/cover.jpg',
    venueName: 'Main Hall',
    venueAddress: '100 Main St',
    city: 'Nairobi',
    country: 'Kenya',
    startAt: new Date('2027-01-01T19:00:00.000Z').toISOString(),
    endAt: new Date('2027-01-01T23:00:00.000Z').toISOString(),
    timezone: 'Africa/Nairobi',
    isFeatured: false,
    organizer: {
      id: overrides.organizerId || 'org-1',
      name: 'Olivia Organizer',
      avatarUrl: null,
    },
    isOwner: true,
    accessRole: 'OWNER',
    permissions: null,
    totalCapacity: 100,
    ticketsSold: 10,
    revenueInCents: 10000,
    revenueFormatted: '$100.00',
    ticketTiers: [],
    ...overrides,
  };
}

function makeHostEvent(id = 'evt-host-1'): HostAssignedEventItem {
  return {
    membershipId: `mem-${id}`,
    event: {
      id,
      slug: id,
      title: 'Host Event',
      status: 'PUBLISHED',
      startAt: new Date('2027-01-01T19:00:00.000Z').toISOString(),
      endAt: new Date('2027-01-01T23:00:00.000Z').toISOString(),
      venueName: 'Main Hall',
      city: 'Nairobi',
      coverImageUrl: null,
    },
    hostLink: {
      id: 'link-1',
      name: 'Host Promo',
      status: 'ACTIVE',
      slug: 'host-slug',
      shortUrl: 'https://outside.vip/r/host-slug',
    },
  };
}

const attendeeUser: User = {
  id: 'usr-attendee',
  email: 'attendee@outside.vip',
  name: 'Alex Attendee',
  role: 'ATTENDEE',
  status: 'ACTIVE',
  emailVerified: true,
};

const organizerUser: User = {
  id: 'usr-organizer',
  email: 'organizer@outside.vip',
  name: 'Olivia Organizer',
  role: 'ORGANIZER',
  status: 'ACTIVE',
  emailVerified: true,
};

const platformAdminUser: User = {
  id: 'usr-admin',
  email: 'admin@outside.vip',
  name: 'Ada Admin',
  role: 'ADMIN',
  status: 'ACTIVE',
  emailVerified: true,
};

describe('Role-Based Navigation Reorganization', () => {
  let miniDoc: MiniDocument;
  let container: MiniElement;
  let root: Root | null = null;
  let queryClient: QueryClient;

  const origGlobals = {
    window: (globalThis as any).window,
    document: (globalThis as any).document,
    Element: (globalThis as any).Element,
    HTMLElement: (globalThis as any).HTMLElement,
    HTMLIFrameElement: (globalThis as any).HTMLIFrameElement,
    Node: (globalThis as any).Node,
    Event: (globalThis as any).Event,
    MouseEvent: (globalThis as any).MouseEvent,
    KeyboardEvent: (globalThis as any).KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as any).IS_REACT_ACT_ENVIRONMENT,
  };

  beforeEach(() => {
    miniDoc = new MiniDocument();
    const miniWin: any = {
      document: miniDoc,
      Node: MiniNode,
      Element: MiniElement,
      HTMLElement: MiniElement,
      HTMLIFrameElement: MiniElement,
      Event: MiniEvent,
      MouseEvent: MiniEvent,
      KeyboardEvent: MiniEvent,
      scrollY: 0,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    miniDoc.defaultView = miniWin;
    (globalThis as any).window = miniWin;
    (globalThis as any).document = miniDoc;
    (globalThis as any).Element = MiniElement;
    (globalThis as any).HTMLElement = MiniElement;
    (globalThis as any).HTMLIFrameElement = MiniElement;
    (globalThis as any).Node = MiniNode;
    (globalThis as any).Event = MiniEvent;
    (globalThis as any).MouseEvent = MiniEvent;
    (globalThis as any).KeyboardEvent = MiniEvent;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

    container = miniDoc.createElement('div');
    miniDoc.body.appendChild(container);
    root = createRoot(container as unknown as Element);

    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
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
    queryClient?.clear();
    vi.restoreAllMocks();
    (globalThis as any).window = origGlobals.window;
    (globalThis as any).document = origGlobals.document;
    (globalThis as any).Element = origGlobals.Element;
    (globalThis as any).HTMLElement = origGlobals.HTMLElement;
    (globalThis as any).HTMLIFrameElement = origGlobals.HTMLIFrameElement;
    (globalThis as any).Node = origGlobals.Node;
    (globalThis as any).Event = origGlobals.Event;
    (globalThis as any).MouseEvent = origGlobals.MouseEvent;
    (globalThis as any).KeyboardEvent = origGlobals.KeyboardEvent;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = origGlobals.IS_REACT_ACT_ENVIRONMENT;
  });

  async function mountNavbar(options: {
    user: User | null;
    route?: string;
    logout?: ReturnType<typeof vi.fn>;
    extraContent?: React.ReactNode;
  }) {
    const logoutMock = options.logout ?? vi.fn().mockResolvedValue(undefined);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[options.route ?? '/']}>
            <AuthContext.Provider value={createAuthMock(options.user, logoutMock)}>
              <Navbar />
              {options.extraContent}
            </AuthContext.Provider>
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    // Allow parallel React Query microtasks to settle cleanly
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    return { logoutMock };
  }

  function getAnchorHrefs(): string[] {
    return container.querySelectorAll('a').map((a) => a.getAttribute('href') || '');
  }

  describe('1. Logged-out, Ordinary Attendee, Scanner-only, Host-only & Organizer Matrix', () => {
    it('logged-out visitor sees only Home, Discover, Sign in, and Create Event', () => {
      const orgSpy = vi.spyOn(api.organizer, 'listEvents');
      const hostSpy = vi.spyOn(api.host, 'getEvents');
      const scannerSpy = vi.spyOn(api.scanner, 'getGates');

      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/']}>
            <AuthContext.Provider value={createAuthMock(null)}>
              <Navbar />
            </AuthContext.Provider>
          </MemoryRouter>
        </QueryClientProvider>
      );

      expect(html).toContain('href="/"');
      expect(html).toContain('href="/events"');
      expect(html).toContain('href="/login"');
      expect(html).toContain('href="/organizer/events/new"');
      expect(html).not.toContain('href="/orders"');
      expect(html).not.toContain('href="/teams"');
      expect(html).not.toContain('href="/organizer/finance"');
      expect(html).not.toContain('href="/host"');
      expect(html).not.toContain('href="/scanner"');
      expect(html).not.toContain('Organizer Dashboard');
      expect(orgSpy).not.toHaveBeenCalled();
      expect(hostSpy).not.toHaveBeenCalled();
      expect(scannerSpy).not.toHaveBeenCalled();
    });

    it('ordinary ATTENDEE sees Home, Discover, Create Event and zero organizer/staff/host workspaces (no /orders)', async () => {
      vi.spyOn(api.organizer, 'listEvents').mockResolvedValue({ events: [] });
      vi.spyOn(api.host, 'getEvents').mockResolvedValue([]);
      vi.spyOn(api.scanner, 'getGates').mockResolvedValue({ events: [] });

      await mountNavbar({ user: attendeeUser });

      const hrefs = getAnchorHrefs();
      expect(hrefs).toContain('/');
      expect(hrefs).toContain('/events');
      expect(hrefs).toContain('/organizer/events/new');
      expect(hrefs).not.toContain('/orders');
      expect(hrefs).not.toContain('/teams');
      expect(hrefs).not.toContain('/organizer');
      expect(hrefs).not.toContain('/organizer/finance');
      expect(hrefs).not.toContain('/host');
      expect(hrefs).not.toContain('/scanner');
    });

    it('scanner-only user sees Home, Discover, Door Scanner only and hides Create Event', async () => {
      vi.spyOn(api.organizer, 'listEvents').mockResolvedValue({ events: [] });
      vi.spyOn(api.host, 'getEvents').mockResolvedValue([]);
      vi.spyOn(api.scanner, 'getGates').mockResolvedValue({
        events: [
          {
            id: 'evt-gate-1',
            title: 'Gate Event',
            slug: 'gate-event',
            startAt: new Date().toISOString(),
            endAt: new Date().toISOString(),
            role: 'STAFF',
          },
        ],
      });

      await mountNavbar({ user: attendeeUser });

      const hrefs = getAnchorHrefs();
      expect(hrefs).toContain('/');
      expect(hrefs).toContain('/events');
      expect(hrefs).toContain('/scanner');
      expect(hrefs).not.toContain('/organizer/events/new');
      expect(hrefs).not.toContain('/organizer');
      expect(hrefs).not.toContain('/orders');
      expect(hrefs).not.toContain('/teams');
      expect(hrefs).not.toContain('/organizer/finance');
      expect(hrefs).not.toContain('/host');
    });

    it('host-only user sees Home, Discover, Host Workspace only and hides Create Event & Door Scanner', async () => {
      vi.spyOn(api.organizer, 'listEvents').mockResolvedValue({ events: [] });
      vi.spyOn(api.host, 'getEvents').mockResolvedValue([makeHostEvent()]);
      vi.spyOn(api.scanner, 'getGates').mockResolvedValue({ events: [] });

      await mountNavbar({ user: attendeeUser });

      const hrefs = getAnchorHrefs();
      expect(hrefs).toContain('/');
      expect(hrefs).toContain('/events');
      expect(hrefs).toContain('/host');
      expect(hrefs).not.toContain('/organizer/events/new');
      expect(hrefs).not.toContain('/scanner');
      expect(hrefs).not.toContain('/organizer');
      expect(hrefs).not.toContain('/orders');
      expect(hrefs).not.toContain('/teams');
      expect(hrefs).not.toContain('/organizer/finance');
    });

    it('ORGANIZER without published events sees Dashboard, Orders, Team, Finance & Organisation, Create Event, without Door Scanner or Host Workspace', async () => {
      vi.spyOn(api.organizer, 'listEvents').mockResolvedValue({
        events: [makeOrganizerEvent({ organizerId: organizerUser.id, status: 'DRAFT' })],
      });
      vi.spyOn(api.host, 'getEvents').mockResolvedValue([]);
      vi.spyOn(api.scanner, 'getGates').mockResolvedValue({ events: [] });

      await mountNavbar({ user: organizerUser });

      const hrefs = getAnchorHrefs();
      expect(hrefs).toContain('/organizer');
      expect(hrefs).toContain('/orders');
      expect(hrefs).toContain('/teams');
      expect(hrefs).toContain('/organizer/finance');
      expect(hrefs).toContain('/organizer/events/new');
      expect(hrefs).not.toContain('/scanner');
      expect(hrefs).not.toContain('/host');
      expect(container.textContent).toContain('Finance & Organisation');
    });

    it('ORGANIZER with a PUBLISHED owned event sees Door Scanner as well', async () => {
      vi.spyOn(api.organizer, 'listEvents').mockResolvedValue({
        events: [makeOrganizerEvent({ organizerId: organizerUser.id, status: 'PUBLISHED' })],
      });
      vi.spyOn(api.host, 'getEvents').mockResolvedValue([]);
      vi.spyOn(api.scanner, 'getGates').mockResolvedValue({
        events: [
          {
            id: 'evt-1',
            title: 'Published Event',
            slug: 'published-event',
            startAt: new Date().toISOString(),
            endAt: new Date().toISOString(),
            role: 'ORGANIZER',
          },
        ],
      });

      await mountNavbar({ user: organizerUser });

      const hrefs = getAnchorHrefs();
      expect(hrefs).toContain('/organizer');
      expect(hrefs).toContain('/orders');
      expect(hrefs).toContain('/teams');
      expect(hrefs).toContain('/organizer/finance');
      expect(hrefs).toContain('/scanner');
      expect(hrefs).toContain('/organizer/events/new');
    });
  });

  describe('2. Event-team ADMIN, Platform ADMIN, Multi-role & Fail-Closed Capability Discovery', () => {
    it('Event-team ADMIN respects granular permissions (no Orders without canViewOrders, no Team without canManageTeam, never Finance or implicit Scanner)', async () => {
      // Case A: canEditDetails only -> Organizer Dashboard only
      vi.spyOn(api.organizer, 'listEvents').mockResolvedValue({
        events: [
          makeOrganizerEvent({
            id: 'evt-ea-1',
            organizerId: 'real-owner',
            isOwner: false,
            accessRole: 'ADMIN',
            permissions: { ...DEFAULT_ADMIN_PERMISSIONS, canEditDetails: true },
          }),
        ],
      });
      vi.spyOn(api.host, 'getEvents').mockResolvedValue([]);
      vi.spyOn(api.scanner, 'getGates').mockResolvedValue({ events: [] });

      await mountNavbar({ user: attendeeUser });
      let hrefs = getAnchorHrefs();
      expect(hrefs).toContain('/organizer');
      expect(hrefs).toContain('/organizer/events/new');
      expect(hrefs).not.toContain('/orders');
      expect(hrefs).not.toContain('/teams');
      expect(hrefs).not.toContain('/organizer/finance');
      expect(hrefs).not.toContain('/scanner');
      expect(hrefs).not.toContain('/host');

      // Case B: canViewOrders=true, canManageTeam=false
      const stateWithOrdersOnly = deriveNavigationState(attendeeUser, {
        organizerEventsResolved: true,
        organizerEvents: [
          makeOrganizerEvent({
            id: 'evt-ea-2',
            organizerId: 'real-owner',
            isOwner: false,
            accessRole: 'ADMIN',
            permissions: { ...DEFAULT_ADMIN_PERMISSIONS, canViewOrders: true },
          }),
        ],
        hostEventsResolved: true,
        hostEvents: [],
        scannerGatesResolved: true,
        scannerGates: [],
      });
      expect(stateWithOrdersOnly.destinations.map((d) => d.key)).toEqual(['organizer', 'orders']);
      expect(stateWithOrdersOnly.visibleByKey.finance).toBe(false);
      expect(stateWithOrdersOnly.visibleByKey.scanner).toBe(false);

      // Case C: canViewOrders=true, canManageTeam=true -> still never Finance or Door Scanner
      const stateWithBoth = deriveNavigationState(attendeeUser, {
        organizerEventsResolved: true,
        organizerEvents: [
          makeOrganizerEvent({
            id: 'evt-ea-3',
            organizerId: 'real-owner',
            isOwner: false,
            accessRole: 'ADMIN',
            permissions: {
              ...DEFAULT_ADMIN_PERMISSIONS,
              canViewOrders: true,
              canManageTeam: true,
            },
          }),
        ],
        hostEventsResolved: true,
        hostEvents: [],
        scannerGatesResolved: true,
        scannerGates: [],
      });
      expect(stateWithBoth.destinations.map((d) => d.key)).toEqual(['organizer', 'orders', 'teams']);
      expect(stateWithBoth.visibleByKey.finance).toBe(false);
      expect(stateWithBoth.visibleByKey.scanner).toBe(false);
    });

    it('Platform ADMIN sees all platform workspaces including Door Scanner without redundant organizer/scanner capability queries', async () => {
      const orgSpy = vi.spyOn(api.organizer, 'listEvents');
      const hostSpy = vi.spyOn(api.host, 'getEvents').mockResolvedValue([]);
      const scannerSpy = vi.spyOn(api.scanner, 'getGates');

      await mountNavbar({ user: platformAdminUser });

      const hrefs = getAnchorHrefs();
      expect(hrefs).toContain('/organizer');
      expect(hrefs).toContain('/orders');
      expect(hrefs).toContain('/teams');
      expect(hrefs).toContain('/organizer/finance');
      expect(hrefs).toContain('/scanner');
      expect(hrefs).toContain('/organizer/events/new');
      expect(hrefs).not.toContain('/host');
      expect(orgSpy).not.toHaveBeenCalled();
      expect(scannerSpy).not.toHaveBeenCalled();
      expect(hostSpy).toHaveBeenCalledTimes(1);
    });

    it('combines multiple legitimate roles (Organizer + Host + Scanner) cleanly with zero duplicate destinations', async () => {
      const state = deriveNavigationState(organizerUser, {
        organizerEventsResolved: true,
        organizerEvents: [
          makeOrganizerEvent({ organizerId: organizerUser.id, status: 'PUBLISHED' }),
        ],
        hostEventsResolved: true,
        hostEvents: [makeHostEvent('evt-h1'), makeHostEvent('evt-h2')],
        scannerGatesResolved: true,
        scannerGates: [
          {
            id: 'evt-1',
            title: 'Owned Pub',
            slug: 'owned-pub',
            startAt: new Date().toISOString(),
            endAt: new Date().toISOString(),
            role: 'ORGANIZER',
          },
          {
            id: 'evt-staff',
            title: 'Other Gate',
            slug: 'other-gate',
            startAt: new Date().toISOString(),
            endAt: new Date().toISOString(),
            role: 'STAFF',
          },
        ],
      });

      const keys = state.destinations.map((d) => d.key);
      expect(keys).toEqual(['organizer', 'orders', 'teams', 'finance', 'scanner', 'host']);
      expect(new Set(keys).size).toBe(keys.length);
      expect(state.showCreateEvent).toBe(true);
    });

    it('never exposes unauthorized navigation while capability discovery is unresolved or when API calls error', async () => {
      // Unresolved (pending promises)
      vi.spyOn(api.organizer, 'listEvents').mockReturnValue(new Promise(() => {}));
      vi.spyOn(api.host, 'getEvents').mockReturnValue(new Promise(() => {}));
      vi.spyOn(api.scanner, 'getGates').mockReturnValue(new Promise(() => {}));

      await act(async () => {
        root!.render(
          <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={['/']}>
              <AuthContext.Provider value={createAuthMock(attendeeUser)}>
                <Navbar />
              </AuthContext.Provider>
            </MemoryRouter>
          </QueryClientProvider>
        );
      });

      let hrefs = getAnchorHrefs();
      expect(hrefs).not.toContain('/organizer');
      expect(hrefs).not.toContain('/orders');
      expect(hrefs).not.toContain('/teams');
      expect(hrefs).not.toContain('/organizer/finance');
      expect(hrefs).not.toContain('/host');
      expect(hrefs).not.toContain('/scanner');

      // Failed queries (500 / network outage) must never be interpreted as authorization
      vi.restoreAllMocks();
      queryClient.clear();
      vi.spyOn(api.organizer, 'listEvents').mockRejectedValue(new Error('Network error'));
      vi.spyOn(api.host, 'getEvents').mockRejectedValue(new Error('503 Unavailable'));
      vi.spyOn(api.scanner, 'getGates').mockRejectedValue(new Error('Timeout'));

      await mountNavbar({ user: attendeeUser });
      hrefs = getAnchorHrefs();
      expect(hrefs).not.toContain('/organizer');
      expect(hrefs).not.toContain('/orders');
      expect(hrefs).not.toContain('/teams');
      expect(hrefs).not.toContain('/organizer/finance');
      expect(hrefs).not.toContain('/host');
      expect(hrefs).not.toContain('/scanner');
    });
  });

  describe('3. Profile Dropdown, Compact Desktop More Menu, Mobile Drawer & Dismissal', () => {
    it('profile dropdown contains only user info and Sign out, and dismisses on toggle, outside click, Escape, and route change', async () => {
      vi.spyOn(api.organizer, 'listEvents').mockResolvedValue({
        events: [makeOrganizerEvent({ organizerId: organizerUser.id, status: 'PUBLISHED' })],
      });
      vi.spyOn(api.host, 'getEvents').mockResolvedValue([]);
      vi.spyOn(api.scanner, 'getGates').mockResolvedValue({ events: [] });

      let triggerNavigate!: (to: string) => void;
      const NavHelper = () => {
        const nav = useNavigate();
        triggerNavigate = nav;
        return null;
      };

      const { logoutMock } = await mountNavbar({
        user: organizerUser,
        extraContent: <NavHelper />,
      });

      const accountTrigger = container.querySelector('button[aria-controls="account-dropdown-menu"]')!;
      expect(accountTrigger).not.toBeNull();
      expect(accountTrigger.getAttribute('aria-expanded')).toBe('false');
      expect(container.querySelector('[id="account-dropdown-menu"]')).toBeNull();

      // Open profile dropdown
      await act(async () => {
        accountTrigger.click();
      });
      const menu = container.querySelector('[id="account-dropdown-menu"]')!;
      expect(menu).not.toBeNull();
      expect(accountTrigger.getAttribute('aria-expanded')).toBe('true');
      expect(menu.textContent).toContain(organizerUser.email);
      expect(menu.textContent).toContain('Sign out');
      // No app workspace navigation links inside profile dropdown
      expect(menu.querySelectorAll('a')).toHaveLength(0);

      // Click trigger again closes it
      await act(async () => {
        accountTrigger.click();
      });
      expect(container.querySelector('[id="account-dropdown-menu"]')).toBeNull();

      // Re-open, then click outside closes it
      await act(async () => {
        accountTrigger.click();
      });
      expect(container.querySelector('[id="account-dropdown-menu"]')).not.toBeNull();
      await act(async () => {
        miniDoc.body.dispatchEvent(new MiniEvent('mousedown', { bubbles: true }));
      });
      expect(container.querySelector('[id="account-dropdown-menu"]')).toBeNull();

      // Re-open, then Escape closes it and returns focus to trigger
      await act(async () => {
        accountTrigger.click();
      });
      expect(container.querySelector('[id="account-dropdown-menu"]')).not.toBeNull();
      await act(async () => {
        miniDoc.dispatchEvent(new MiniEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      expect(container.querySelector('[id="account-dropdown-menu"]')).toBeNull();
      expect(miniDoc.activeElement).toBe(accountTrigger);

      // Re-open, then route change closes it
      await act(async () => {
        accountTrigger.click();
      });
      expect(container.querySelector('[id="account-dropdown-menu"]')).not.toBeNull();
      await act(async () => {
        triggerNavigate('/events');
      });
      expect(container.querySelector('[id="account-dropdown-menu"]')).toBeNull();

      // Re-open and click Sign out -> logs out and closes dropdown
      await act(async () => {
        accountTrigger.click();
      });
      const signOutBtn = container
        .querySelector('[id="account-dropdown-menu"]')!
        .querySelector('button[role="menuitem"]')!;
      await act(async () => {
        signOutBtn.click();
      });
      expect(logoutMock).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[id="account-dropdown-menu"]')).toBeNull();
    });

    it('mobile hamburger drawer groups Explore, Workspaces, and Actions cleanly and closes on selection, outside click, and Escape', async () => {
      vi.spyOn(api.organizer, 'listEvents').mockResolvedValue({
        events: [makeOrganizerEvent({ organizerId: organizerUser.id, status: 'PUBLISHED' })],
      });
      vi.spyOn(api.host, 'getEvents').mockResolvedValue([makeHostEvent()]);
      vi.spyOn(api.scanner, 'getGates').mockResolvedValue({ events: [] });

      await mountNavbar({ user: organizerUser });

      const mobileToggle = container.querySelector('button[aria-controls="mobile-navigation-drawer"]')!;
      expect(mobileToggle).not.toBeNull();
      expect(container.querySelector('[id="mobile-navigation-drawer"]')).toBeNull();

      // Open mobile drawer
      await act(async () => {
        mobileToggle.click();
      });
      const drawer = container.querySelector('[id="mobile-navigation-drawer"]')!;
      expect(drawer).not.toBeNull();
      expect(mobileToggle.getAttribute('aria-expanded')).toBe('true');
      expect(drawer.textContent).toContain('Workspaces');
      expect(drawer.textContent).toContain('Host Workspace');

      // Clicking a destination inside mobile drawer closes it
      const hostMobileLink = drawer.querySelector('a[href="/host"]')!;
      await act(async () => {
        hostMobileLink.click();
      });
      expect(container.querySelector('[id="mobile-navigation-drawer"]')).toBeNull();

      // Re-open, then Escape closes it and restores focus
      await act(async () => {
        mobileToggle.click();
      });
      expect(container.querySelector('[id="mobile-navigation-drawer"]')).not.toBeNull();
      await act(async () => {
        miniDoc.dispatchEvent(new MiniEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      expect(container.querySelector('[id="mobile-navigation-drawer"]')).toBeNull();
      expect(miniDoc.activeElement).toBe(mobileToggle);

      // Re-open, then outside click closes drawer
      await act(async () => {
        mobileToggle.click();
      });
      expect(container.querySelector('[id="mobile-navigation-drawer"]')).not.toBeNull();
      await act(async () => {
        miniDoc.body.dispatchEvent(new MiniEvent('mousedown', { bubbles: true }));
      });
      expect(container.querySelector('[id="mobile-navigation-drawer"]')).toBeNull();
    });

    it('preserves existing route protections (RequireAuth and RequireRole)', async () => {
      await act(async () => {
        root!.render(
          <MemoryRouter key="require-auth-test" initialEntries={['/orders']}>
            <AuthContext.Provider value={createAuthMock(null)}>
              <Routes>
                <Route
                  path="/orders"
                  element={
                    <RequireAuth>
                      <div>Orders Secret Content</div>
                    </RequireAuth>
                  }
                />
                <Route path="/login" element={<div>Sign In Redirected</div>} />
              </Routes>
            </AuthContext.Provider>
          </MemoryRouter>
        );
      });
      expect(container.textContent).not.toContain('Orders Secret Content');
      expect(container.textContent).toContain('Sign In Redirected');

      await act(async () => {
        root!.render(
          <MemoryRouter key="require-role-test" initialEntries={['/organizer/finance']}>
            <AuthContext.Provider value={createAuthMock(attendeeUser)}>
              <Routes>
                <Route
                  path="/organizer/finance"
                  element={
                    <RequireRole allowedRoles={['ORGANIZER', 'ADMIN']} redirectTo="/">
                      <div>Finance Secret Content</div>
                    </RequireRole>
                  }
                />
                <Route path="/" element={<div>Public Redirect Target</div>} />
              </Routes>
            </AuthContext.Provider>
          </MemoryRouter>
        );
      });
      expect(container.textContent).not.toContain('Finance Secret Content');
      expect(container.textContent).toContain('Public Redirect Target');
    });

    it('unverified ATTENDEE triggers zero capability API requests and hides workspace links while keeping Create Event visible', async () => {
      const orgSpy = vi.spyOn(api.organizer, 'listEvents');
      const hostSpy = vi.spyOn(api.host, 'getEvents');
      const scannerSpy = vi.spyOn(api.scanner, 'getGates');

      await mountNavbar({ user: { ...attendeeUser, emailVerified: false } });

      const hrefs = getAnchorHrefs();
      expect(hrefs).toContain('/');
      expect(hrefs).toContain('/events');
      expect(hrefs).toContain('/organizer/events/new');
      expect(hrefs).not.toContain('/organizer');
      expect(hrefs).not.toContain('/orders');
      expect(hrefs).not.toContain('/teams');
      expect(hrefs).not.toContain('/organizer/finance');
      expect(hrefs).not.toContain('/scanner');
      expect(hrefs).not.toContain('/host');
      expect(orgSpy).not.toHaveBeenCalled();
      expect(hostSpy).not.toHaveBeenCalled();
      expect(scannerSpy).not.toHaveBeenCalled();
    });

    it('desktop More menu opens for crowded multi-workspace users and dismisses on selection, Escape, and outside click', async () => {
      vi.spyOn(api.organizer, 'listEvents').mockResolvedValue({
        events: [makeOrganizerEvent({ organizerId: organizerUser.id, status: 'PUBLISHED' })],
      });
      vi.spyOn(api.host, 'getEvents').mockResolvedValue([makeHostEvent()]);
      vi.spyOn(api.scanner, 'getGates').mockResolvedValue({ events: [] });

      await mountNavbar({ user: organizerUser });

      const moreTrigger = container.querySelector('button[aria-controls="workspace-more-menu"]')!;
      expect(moreTrigger).not.toBeNull();
      expect(container.querySelector('[id="workspace-more-menu"]')).toBeNull();

      await act(async () => {
        moreTrigger.click();
      });
      const moreMenu = container.querySelector('[id="workspace-more-menu"]')!;
      expect(moreMenu).not.toBeNull();
      expect(moreMenu.textContent).toContain('Host Workspace');

      // Clicking a destination inside More menu closes it
      const hostLink = moreMenu.querySelector('a[href="/host"]')!;
      await act(async () => {
        hostLink.click();
      });
      expect(container.querySelector('[id="workspace-more-menu"]')).toBeNull();

      // Re-open, then Escape closes it and restores focus
      await act(async () => {
        moreTrigger.click();
      });
      expect(container.querySelector('[id="workspace-more-menu"]')).not.toBeNull();
      await act(async () => {
        miniDoc.dispatchEvent(new MiniEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      expect(container.querySelector('[id="workspace-more-menu"]')).toBeNull();
      expect(miniDoc.activeElement).toBe(moreTrigger);
    });
  });
});
