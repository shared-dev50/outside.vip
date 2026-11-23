import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CreateEventPage } from './pages/CreateEventPage';
import { StripeOnboardingGateModal } from './components/events/StripeOnboardingGateModal';
import { AuthContext } from './context/AuthContext';
import { api, ApiError } from './lib/api';
import {
  isStripeReadyForPaidPublishing,
  hasVisiblePaidTicketTier,
  isStripeOnboardingIncompleteError,
  buildEventEditStripeUrls,
} from './lib/stripeOnboardingGate';
import { Event, StripeConnectedAccountStatus, User } from './types';

// Minimal in-process DOM harness enabling real React 18 mounting & event dispatch in Vitest Node env
class MiniEvent {
  type: string;
  key?: string;
  shiftKey?: boolean;
  bubbles: boolean;
  cancelable: boolean;
  defaultPrevented = false;
  target: any = null;
  currentTarget: any = null;
  propagationStopped = false;
  constructor(
    type: string,
    init?: { bubbles?: boolean; cancelable?: boolean; key?: string; shiftKey?: boolean }
  ) {
    this.type = type;
    this.key = init?.key;
    this.shiftKey = init?.shiftKey;
    this.bubbles = init?.bubbles ?? true;
    this.cancelable = init?.cancelable ?? true;
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopPropagation() {
    this.propagationStopped = true;
  }
}

class MiniNode {
  nodeType: number;
  parentNode: MiniElement | null = null;
  childNodes: MiniNode[] = [];
  ownerDocument: MiniDocument;
  constructor(nodeType: number, ownerDocument: MiniDocument) {
    this.nodeType = nodeType;
    this.ownerDocument = ownerDocument;
  }
  get firstChild() {
    return this.childNodes[0] || null;
  }
  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] || null;
  }
  get nextSibling(): MiniNode | null {
    if (!this.parentNode) return null;
    const idx = this.parentNode.childNodes.indexOf(this);
    return idx >= 0 && idx < this.parentNode.childNodes.length - 1
      ? this.parentNode.childNodes[idx + 1]
      : null;
  }
  appendChild(child: MiniNode) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this as unknown as MiniElement;
    this.childNodes.push(child);
    return child;
  }
  insertBefore(child: MiniNode, ref: MiniNode | null) {
    if (!ref) return this.appendChild(child);
    if (child.parentNode) child.parentNode.removeChild(child);
    const idx = this.childNodes.indexOf(ref);
    child.parentNode = this as unknown as MiniElement;
    if (idx === -1) this.childNodes.push(child);
    else this.childNodes.splice(idx, 0, child);
    return child;
  }
  removeChild(child: MiniNode) {
    const idx = this.childNodes.indexOf(child);
    if (idx !== -1) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }
  contains(other: MiniNode | null): boolean {
    if (!other) return false;
    if (other === this) return true;
    return this.childNodes.some((c) => c.contains(other));
  }
  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(val: string) {
    this.childNodes = [];
    if (val) {
      this.appendChild(new MiniText(String(val), this.ownerDocument));
    }
  }
}

class MiniText extends MiniNode {
  data: string;
  constructor(text: string, ownerDocument: MiniDocument) {
    super(3, ownerDocument);
    this.data = text;
  }
  get nodeValue() {
    return this.data;
  }
  set nodeValue(val: string) {
    this.data = String(val ?? '');
  }
  get textContent() {
    return this.data;
  }
  set textContent(val: string) {
    this.data = String(val ?? '');
  }
}

class MiniElement extends MiniNode {
  tagName: string;
  namespaceURI: string;
  attributes = new Map<string, string>();
  listeners = new Map<string, Set<(e: any) => void>>();
  style: Record<string, string> = {};
  value = '';
  checked = false;
  disabled = false;
  type = '';
  id = '';
  name = '';
  placeholder = '';

  constructor(tagName: string, ownerDocument: MiniDocument, ns = 'http://www.w3.org/1999/xhtml') {
    super(1, ownerDocument);
    this.tagName = tagName.toUpperCase();
    this.namespaceURI = ns;
  }

  get nodeName() {
    return this.tagName;
  }

  get options() {
    return this.findAll((el) => el.tagName === 'OPTION');
  }

  selected = false;
  defaultSelected = false;

  get className() {
    return this.attributes.get('class') || '';
  }

  set className(val: string) {
    this.attributes.set('class', String(val || ''));
  }

  setAttribute(name: string, value: string) {
    const strVal = String(value);
    this.attributes.set(name, strVal);
    if (name === 'id') this.id = strVal;
    if (name === 'type') this.type = strVal;
    if (name === 'name') this.name = strVal;
    if (name === 'value') this.value = strVal;
    if (name === 'placeholder') this.placeholder = strVal;
    if (name === 'disabled') this.disabled = true;
  }

  getAttribute(name: string): string | null {
    if (name === 'value') return this.value;
    if (name === 'placeholder') return this.placeholder || this.attributes.get('placeholder') || null;
    return this.attributes.has(name) ? this.attributes.get(name)! : null;
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
    if (name === 'disabled') this.disabled = false;
  }

  hasAttribute(name: string) {
    return this.attributes.has(name);
  }

  addEventListener(type: string, fn: (e: any) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }

  removeEventListener(type: string, fn: (e: any) => void) {
    this.listeners.get(type)?.delete(fn);
  }

  dispatchEvent(evt: MiniEvent) {
    evt.target = this;
    let curr: any = this;
    while (curr) {
      evt.currentTarget = curr;
      const set = curr.listeners?.get(evt.type);
      if (set) {
        for (const fn of Array.from(set) as Array<(e: any) => void>) {
          fn(evt);
        }
      }
      if (!evt.bubbles || evt.propagationStopped) break;
      curr = curr.parentNode || (curr === this.ownerDocument.body ? this.ownerDocument : null);
    }
    return !evt.defaultPrevented;
  }

  click() {
    if (this.disabled) return;
    this.dispatchEvent(new MiniEvent('click', { bubbles: true, cancelable: true }));
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  blur() {}

  querySelectorAll() {
    return this.findAll((el) => el.tagName === 'BUTTON' || el.tagName === 'SELECT');
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

  findByTestId(testId: string): MiniElement | undefined {
    return this.findAll((el) => el.getAttribute('data-testid') === testId)[0];
  }
}

class MiniDocument {
  nodeType = 9;
  defaultView: any = null;
  activeElement: any = null;
  visibilityState = 'visible';
  documentElement: MiniElement;
  head: MiniElement;
  body: MiniElement;
  listeners = new Map<string, Set<(e: any) => void>>();

  constructor() {
    this.documentElement = new MiniElement('html', this);
    this.head = new MiniElement('head', this);
    this.body = new MiniElement('body', this);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
  }

  createElement(tag: string) {
    return new MiniElement(tag, this);
  }
  createElementNS(ns: string, tag: string) {
    return new MiniElement(tag, this, ns);
  }
  createTextNode(text: string) {
    return new MiniText(text, this);
  }
  createComment(text: string) {
    return new MiniText(text, this);
  }
  addEventListener(type: string, fn: (e: any) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (e: any) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  dispatchEvent(evt: MiniEvent) {
    const set = this.listeners.get(evt.type);
    if (set) {
      for (const fn of Array.from(set)) fn(evt);
    }
    return !evt.defaultPrevented;
  }
  getElementById(id: string) {
    return this.body.findAll((el) => el.id === id)[0] || null;
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
}

function setupDomGlobals() {
  const doc = new MiniDocument();
  const win: any = {
    document: doc,
    location: {
      href: 'https://outside.vip/organizer/events/evt-paid-1/edit',
      pathname: '/organizer/events/evt-paid-1/edit',
      search: '',
      hash: '',
      origin: 'https://outside.vip',
    },
    navigator: { userAgent: 'vitest' },
    history: { pushState() {}, replaceState() {} },
    addEventListener() {},
    removeEventListener() {},
    scrollTo() {},
    requestAnimationFrame: (cb: any) => setTimeout(cb, 0),
    cancelAnimationFrame: (id: any) => clearTimeout(id),
    HTMLElement: MiniElement,
    HTMLIFrameElement: class MockIFrame extends MiniElement {},
    SVGElement: MiniElement,
    Element: MiniElement,
    Node: MiniNode,
    Event: MiniEvent,
    MouseEvent: MiniEvent,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  };
  doc.defaultView = win;
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as any).window = win;
  (globalThis as any).document = doc;
  (globalThis as any).HTMLElement = MiniElement;
  (globalThis as any).HTMLIFrameElement = win.HTMLIFrameElement;
  (globalThis as any).SVGElement = MiniElement;
  (globalThis as any).Element = MiniElement;
  (globalThis as any).Node = MiniNode;
  (globalThis as any).Event = MiniEvent;
  (globalThis as any).localStorage = win.localStorage;
  (globalThis as any).sessionStorage = win.sessionStorage;
  return { doc, win };
}

const organizerUser: User = {
  id: 'org-stripe-1',
  email: 'organizer@outside.vip',
  name: 'Stripe Gate Organizer',
  role: 'ORGANIZER',
  emailVerified: true,
  emailVerifiedAt: new Date().toISOString(),
};

const readyStripeStatus: StripeConnectedAccountStatus = {
  connected: true,
  stripeAccountId: 'acct_ready_123',
  connectionStatus: 'connected',
  detailsSubmitted: true,
  chargesEnabled: true,
  payoutsEnabled: true,
  sellTickets: { enabled: true, status: 'enabled', message: 'Ready' },
  transferBalance: { enabled: true, status: 'enabled', message: 'Ready' },
  requirements: {
    currentlyDue: [],
    eventuallyDue: [],
    pastDue: [],
    disabledReason: null,
    pendingVerification: [],
    rawCurrentlyDue: [],
  },
  payoutSchedule: null,
  externalAccounts: [],
  defaultCurrency: 'usd',
  country: 'US',
};

const incompleteStripeStatus: StripeConnectedAccountStatus = {
  connected: false,
  stripeAccountId: null,
  connectionStatus: 'not_connected',
  detailsSubmitted: false,
  chargesEnabled: false,
  payoutsEnabled: false,
  sellTickets: { enabled: false, status: 'action_required', message: 'Connect Stripe' },
  transferBalance: { enabled: false, status: 'action_required', message: 'Connect Stripe' },
  requirements: {
    currentlyDue: [],
    eventuallyDue: [],
    pastDue: [],
    disabledReason: null,
    pendingVerification: [],
    rawCurrentlyDue: [],
  },
  payoutSchedule: null,
  externalAccounts: [],
  defaultCurrency: 'usd',
  country: null,
};

function makeDraftEvent(overrides?: Partial<Event>): Event {
  return {
    id: 'evt-paid-1',
    slug: 'sunset-sessions',
    organizerId: organizerUser.id,
    organizer: { id: organizerUser.id, name: organizerUser.name },
    title: 'Sunset Sessions Nairobi',
    description: 'Open-air music showcase',
    category: 'MUSIC',
    status: 'DRAFT',
    coverImageUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819',
    venueName: 'Baobab Park',
    venueAddress: '123 Forest Rd',
    city: 'Nairobi',
    country: 'Kenya',
    startAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    endAt: new Date(Date.now() + 7 * 24 * 3600 * 1000 + 5 * 3600 * 1000).toISOString(),
    timezone: 'America/New_York',
    ageRestriction: '18+',
    isFeatured: false,
    ticketTiers: [
      {
        id: 'tier-paid-1',
        eventId: 'evt-paid-1',
        name: 'General Admission',
        description: 'Main floor entry',
        priceInCents: 3500,
        currency: 'USD',
        totalCapacity: 200,
        reservedQuantity: 0,
        soldQuantity: 0,
        minPerOrder: 1,
        maxPerOrder: 6,
        status: 'ACTIVE',
        isHidden: false,
        salesDisabled: false,
      },
    ],
    ...overrides,
  };
}

describe('Stripe Onboarding Gate — Publish Flow UX Refinement', () => {
  let doc: MiniDocument;
  let win: any;
  let root: Root | null = null;
  let container: MiniElement | null = null;

  beforeEach(() => {
    ({ doc, win } = setupDomGlobals());
    container = doc.createElement('div');
    doc.body.appendChild(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = null;
    }
    vi.restoreAllMocks();
  });

  async function mountEditPage(initialEntry: string) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    root = createRoot(container as any);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <AuthContext.Provider
            value={{
              user: organizerUser,
              isLoading: false,
              login: vi.fn(),
              verifyEmail: vi.fn(),
              resendVerification: vi.fn(),
              register: vi.fn(),
              logout: vi.fn(),
              refreshUser: vi.fn(),
            }}
          >
            <MemoryRouter initialEntries={[initialEntry]}>
              <Routes>
                <Route path="/organizer/events/:id/edit" element={<CreateEventPage />} />
                <Route path="/organizer/events/new" element={<CreateEventPage />} />
              </Routes>
            </MemoryRouter>
          </AuthContext.Provider>
        </QueryClientProvider>
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
  }

  it('1. Helper functions accurately evaluate Stripe readiness, paid tiers, error codes, and return URLs', () => {
    expect(isStripeReadyForPaidPublishing(readyStripeStatus)).toBe(true);
    expect(isStripeReadyForPaidPublishing(incompleteStripeStatus)).toBe(false);
    expect(
      isStripeReadyForPaidPublishing({
        ...readyStripeStatus,
        transferBalance: { enabled: false, status: 'action_required', message: 'Pending' },
      })
    ).toBe(false);

    expect(
      hasVisiblePaidTicketTier([{ isHidden: false, price: 25, totalCapacity: 100 }])
    ).toBe(true);
    expect(
      hasVisiblePaidTicketTier([{ isHidden: true, price: 25, totalCapacity: 100 }])
    ).toBe(false);
    expect(
      hasVisiblePaidTicketTier([{ isHidden: false, price: 0, totalCapacity: 100 }])
    ).toBe(false);

    expect(
      isStripeOnboardingIncompleteError(new ApiError('Incomplete', 400, undefined, undefined, 'STRIPE_ONBOARDING_INCOMPLETE'))
    ).toBe(true);
    expect(isStripeOnboardingIncompleteError(new Error('Other'))).toBe(false);

    expect(buildEventEditStripeUrls('https://outside.vip/', 'evt-123')).toEqual({
      returnUrl: 'https://outside.vip/organizer/events/evt-123/edit?stripe_return=true',
      refreshUrl: 'https://outside.vip/organizer/events/evt-123/edit?stripe_refresh=true',
    });
  });

  it('2. Publish succeeds normally when Stripe requirements are satisfied (no modal shown)', async () => {
    const draft = makeDraftEvent();
    vi.spyOn(api.organizer, 'getEvent').mockResolvedValue({ event: draft });
    const getStatusSpy = vi.spyOn(api.finance, 'getStatus').mockResolvedValue(readyStripeStatus);
    const updateSpy = vi
      .spyOn(api.organizer, 'updateEvent')
      .mockResolvedValue({ event: { ...draft, status: 'PUBLISHED' } });
    const publishSpy = vi.spyOn(api.organizer, 'publishEvent').mockResolvedValue({
      event: { ...draft, status: 'PUBLISHED' },
      message: 'Published',
    });

    await mountEditPage('/organizer/events/evt-paid-1/edit');

    const publishBtn = container!.findByTestId('header-publish-btn')!;
    expect(publishBtn).toBeDefined();

    await act(async () => {
      publishBtn.click();
      await new Promise((r) => setTimeout(r, 30));
    });

    expect(getStatusSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0][1].status).toBe('PUBLISHED');
    expect(container!.findByTestId('stripe-onboarding-gate-modal')).toBeUndefined();
    expect(publishSpy).not.toHaveBeenCalled(); // already returned PUBLISHED
    expect(container!.textContent).toContain('Event published live');
  });

  it('3. Incomplete Stripe onboarding opens the modal instead of top-of-page error and does NOT auto-redirect or publish', async () => {
    const draft = makeDraftEvent();
    vi.spyOn(api.organizer, 'getEvent').mockResolvedValue({ event: draft });
    vi.spyOn(api.finance, 'getStatus').mockResolvedValue(incompleteStripeStatus);
    vi.spyOn(api.finance, 'getSupportedCountries').mockResolvedValue({
      countries: [
        { code: 'US', name: 'United States' },
        { code: 'KE', name: 'Kenya' },
      ],
      defaultCountry: 'US',
    });
    const updateSpy = vi.spyOn(api.organizer, 'updateEvent');
    const createLinkSpy = vi.spyOn(api.finance, 'createOnboardingLink');

    const initialHref = win.location.href;
    await mountEditPage('/organizer/events/evt-paid-1/edit');

    const publishBtn = container!.findByTestId('header-publish-btn')!;
    await act(async () => {
      publishBtn.click();
      await new Promise((r) => setTimeout(r, 30));
    });

    const modal = container!.findByTestId('stripe-onboarding-gate-modal');
    expect(modal).toBeDefined();
    expect(modal!.textContent).toContain('Complete Stripe setup');
    expect(modal!.textContent).toContain("You're almost ready to publish!");
    expect(modal!.textContent).toContain('Complete Stripe Setup');
    expect(modal!.textContent).toContain('Save as Draft');

    // No automatic redirect, no publish request, no top-of-page raw error
    expect(win.location.href).toBe(initialHref);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(createLinkSpy).not.toHaveBeenCalled();
    expect(container!.textContent).not.toContain('Cannot publish paid event until Stripe onboarding is complete');
  });

  it('4. Complete Stripe Setup saves the event as DRAFT first, calls existing createOnboardingLink with event edit return/refresh URLs, and redirects', async () => {
    const draft = makeDraftEvent();
    vi.spyOn(api.organizer, 'getEvent').mockResolvedValue({ event: draft });
    vi.spyOn(api.finance, 'getStatus').mockResolvedValue(incompleteStripeStatus);
    vi.spyOn(api.finance, 'getSupportedCountries').mockResolvedValue({
      countries: [{ code: 'US', name: 'United States' }],
      defaultCountry: 'US',
    });
    const updateSpy = vi
      .spyOn(api.organizer, 'updateEvent')
      .mockResolvedValue({ event: { ...draft, status: 'DRAFT' } });
    const createLinkSpy = vi.spyOn(api.finance, 'createOnboardingLink').mockResolvedValue({
      url: 'https://connect.stripe.com/setup/e/acct_test_999',
      stripeAccountId: 'acct_test_999',
    });

    await mountEditPage('/organizer/events/evt-paid-1/edit');

    await act(async () => {
      container!.findByTestId('header-publish-btn')!.click();
      await new Promise((r) => setTimeout(r, 30));
    });

    const completeBtn = container!.findByTestId('stripe-gate-complete-setup-btn')!;
    expect(completeBtn).toBeDefined();

    await act(async () => {
      completeBtn.click();
      await new Promise((r) => setTimeout(r, 30));
    });

    // Preserved as DRAFT (never PUBLISHED) before redirecting
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0][0]).toBe('evt-paid-1');
    expect(updateSpy.mock.calls[0][1].status).toBe('DRAFT');

    // Uses existing onboarding link API with event edit return/refresh URLs
    expect(createLinkSpy).toHaveBeenCalledTimes(1);
    expect(createLinkSpy).toHaveBeenCalledWith({
      returnUrl: 'https://outside.vip/organizer/events/evt-paid-1/edit?stripe_return=true',
      refreshUrl: 'https://outside.vip/organizer/events/evt-paid-1/edit?stripe_refresh=true',
      country: 'US',
    });
    expect(win.location.href).toBe('https://connect.stripe.com/setup/e/acct_test_999');
  });

  it('5. Save as Draft in the modal preserves entered information, closes the dialog, shows feedback, and does NOT publish', async () => {
    const draft = makeDraftEvent();
    vi.spyOn(api.organizer, 'getEvent').mockResolvedValue({ event: draft });
    vi.spyOn(api.finance, 'getStatus').mockResolvedValue(incompleteStripeStatus);
    vi.spyOn(api.finance, 'getSupportedCountries').mockResolvedValue({
      countries: [{ code: 'US', name: 'United States' }],
      defaultCountry: 'US',
    });
    const updateSpy = vi
      .spyOn(api.organizer, 'updateEvent')
      .mockResolvedValue({ event: { ...draft, status: 'DRAFT' } });
    const publishSpy = vi.spyOn(api.organizer, 'publishEvent');

    await mountEditPage('/organizer/events/evt-paid-1/edit');

    await act(async () => {
      container!.findByTestId('header-publish-btn')!.click();
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(container!.findByTestId('stripe-onboarding-gate-modal')).toBeDefined();

    await act(async () => {
      container!.findByTestId('stripe-gate-save-draft-btn')!.click();
      await new Promise((r) => setTimeout(r, 30));
    });

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0][1].status).toBe('DRAFT');
    expect(publishSpy).not.toHaveBeenCalled();
    expect(container!.findByTestId('stripe-onboarding-gate-modal')).toBeUndefined();
    expect(container!.textContent).toContain('Event draft saved');
  });

  it('6. Returning from Stripe (?stripe_return=true) performs a genuine live readiness recheck and NEVER assumes completion', async () => {
    const draft = makeDraftEvent();
    vi.spyOn(api.organizer, 'getEvent').mockResolvedValue({ event: draft });
    vi.spyOn(api.finance, 'getSupportedCountries').mockResolvedValue({
      countries: [{ code: 'US', name: 'United States' }],
      defaultCountry: 'US',
    });
    const getStatusSpy = vi.spyOn(api.finance, 'getStatus').mockResolvedValue({
      ...incompleteStripeStatus,
      connected: true,
      stripeAccountId: 'acct_partial_1',
      connectionStatus: 'connected',
      detailsSubmitted: false,
    });
    const publishSpy = vi.spyOn(api.organizer, 'publishEvent');

    await mountEditPage('/organizer/events/evt-paid-1/edit?stripe_return=true');

    // Genuine live readiness recheck executed
    expect(getStatusSpy).toHaveBeenCalledTimes(1);
    // Did NOT auto-publish and re-opened modal because onboarding is still incomplete
    expect(publishSpy).not.toHaveBeenCalled();
    const modal = container!.findByTestId('stripe-onboarding-gate-modal');
    expect(modal).toBeDefined();
    expect(container!.findByTestId('stripe-gate-status-notice')!.textContent).toContain(
      'not complete yet'
    );
  });

  it('7. Returning from Stripe (?stripe_return=true) when genuinely ready shows ready confirmation without accidental auto-publishing', async () => {
    const draft = makeDraftEvent();
    vi.spyOn(api.organizer, 'getEvent').mockResolvedValue({ event: draft });
    const getStatusSpy = vi.spyOn(api.finance, 'getStatus').mockResolvedValue(readyStripeStatus);
    const updateSpy = vi.spyOn(api.organizer, 'updateEvent');
    const publishSpy = vi.spyOn(api.organizer, 'publishEvent');

    await mountEditPage('/organizer/events/evt-paid-1/edit?stripe_return=true');

    expect(getStatusSpy).toHaveBeenCalledTimes(1);
    expect(container!.findByTestId('stripe-onboarding-gate-modal')).toBeUndefined();
    expect(container!.textContent).toContain('Stripe setup complete!');
    // Must not accidentally auto-publish before organizer clicks Publish Live
    expect(updateSpy).not.toHaveBeenCalled();
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('8. Backend STRIPE_ONBOARDING_INCOMPLETE fallback opens the modal cleanly instead of top-of-page error', async () => {
    const draft = makeDraftEvent();
    vi.spyOn(api.organizer, 'getEvent').mockResolvedValue({ event: draft });
    // Simulate preflight status read failure falling back to authoritative backend check
    vi.spyOn(api.finance, 'getStatus')
      .mockRejectedValueOnce(new Error('Temporary read timeout'))
      .mockResolvedValueOnce(incompleteStripeStatus);
    vi.spyOn(api.finance, 'getSupportedCountries').mockResolvedValue({
      countries: [{ code: 'US', name: 'United States' }],
      defaultCountry: 'US',
    });
    vi.spyOn(api.organizer, 'updateEvent').mockRejectedValue(
      new ApiError(
        'Cannot publish paid event until Stripe onboarding is complete.',
        400,
        undefined,
        undefined,
        'STRIPE_ONBOARDING_INCOMPLETE'
      )
    );

    await mountEditPage('/organizer/events/evt-paid-1/edit');

    await act(async () => {
      container!.findByTestId('header-publish-btn')!.click();
      await new Promise((r) => setTimeout(r, 30));
    });

    expect(container!.findByTestId('stripe-onboarding-gate-modal')).toBeDefined();
    expect(container!.textContent).not.toContain('Cannot publish paid event until Stripe onboarding is complete.');
  });

  it('9. Free events ($0 tickets) publish normally without invoking Stripe readiness checks or opening the modal', async () => {
    const freeDraft = makeDraftEvent({
      ticketTiers: [
        {
          id: 'tier-free-1',
          eventId: 'evt-paid-1',
          name: 'Free RSVP',
          priceInCents: 0,
          currency: 'USD',
          totalCapacity: 100,
          reservedQuantity: 0,
          soldQuantity: 0,
          minPerOrder: 1,
          maxPerOrder: 4,
          status: 'ACTIVE',
          isHidden: false,
          salesDisabled: false,
        },
      ],
    });
    vi.spyOn(api.organizer, 'getEvent').mockResolvedValue({ event: freeDraft });
    const getStatusSpy = vi.spyOn(api.finance, 'getStatus');
    const updateSpy = vi
      .spyOn(api.organizer, 'updateEvent')
      .mockResolvedValue({ event: { ...freeDraft, status: 'PUBLISHED' } });

    await mountEditPage('/organizer/events/evt-paid-1/edit');

    await act(async () => {
      container!.findByTestId('header-publish-btn')!.click();
      await new Promise((r) => setTimeout(r, 30));
    });

    expect(getStatusSpy).not.toHaveBeenCalled();
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0][1].status).toBe('PUBLISHED');
    expect(container!.findByTestId('stripe-onboarding-gate-modal')).toBeUndefined();
  });

  it('10. Modal keyboard accessibility: Escape closes dialog when idle and is ignored while redirecting', async () => {
    const onClose = vi.fn();
    root = createRoot(container as any);
    await act(async () => {
      root!.render(
        <StripeOnboardingGateModal
          isOpen={true}
          onClose={onClose}
          accountStatus={incompleteStripeStatus}
          supportedCountries={[{ code: 'US', name: 'United States' }]}
          selectedCountry="US"
          onCountryChange={vi.fn()}
          onCompleteSetup={vi.fn()}
          onSaveDraft={vi.fn()}
          isStartingSetup={false}
          isSavingDraft={false}
        />
      );
    });

    await act(async () => {
      doc.dispatchEvent(new MiniEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    // When busy starting setup, Escape must not close the dialog prematurely
    onClose.mockClear();
    await act(async () => {
      root!.render(
        <StripeOnboardingGateModal
          isOpen={true}
          onClose={onClose}
          accountStatus={incompleteStripeStatus}
          supportedCountries={[{ code: 'US', name: 'United States' }]}
          selectedCountry="US"
          onCountryChange={vi.fn()}
          onCompleteSetup={vi.fn()}
          onSaveDraft={vi.fn()}
          isStartingSetup={true}
          isSavingDraft={false}
        />
      );
    });
    await act(async () => {
      doc.dispatchEvent(new MiniEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});
