import React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Event, TicketTier, CheckoutSessionResult } from './types';

const stripeMockState = vi.hoisted(() => ({
  elementsMountCount: 0,
  cardElementMountCount: 0,
  confirmCardPayment: vi.fn(),
  getStripePromise: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('@stripe/react-stripe-js', () => ({
  Elements: ({ children }: { children: React.ReactNode }) => {
    stripeMockState.elementsMountCount += 1;
    return <div data-testid="stripe-elements">{children}</div>;
  },
  CardElement: ({ onReady }: { onReady?: () => void }) => {
    const onReadyRef = React.useRef(onReady);
    onReadyRef.current = onReady;
    React.useEffect(() => {
      stripeMockState.cardElementMountCount += 1;
      onReadyRef.current?.();
    }, []);
    return <div data-testid="stripe-card-element">CardElement</div>;
  },
  useStripe: () => ({
    confirmCardPayment: stripeMockState.confirmCardPayment,
  }),
  useElements: () => ({
    getElement: () => ({ mockCard: true }),
  }),
}));

vi.mock('./lib/stripe', () => ({
  getStripePromise: stripeMockState.getStripePromise,
}));

import { EventDetailPage } from './pages/EventDetailPage';
import { CheckoutDialog } from './components/events/CheckoutDialog';
import { api, ApiError } from './lib/api';

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

  setAttribute(name: string, value: string) {
    const str = String(value);
    this.attributes.set(name, str);
    if (name === 'disabled') this.disabled = true;
    if (name === 'type') this.type = str;
    if (name === 'value') this.value = str;
    if (name === 'id') this.id = str;
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
  scrollIntoView() {}
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
  head: MiniElement;
  documentElement: MiniElement;
  defaultView: any = null;
  activeElement: any = null;
  visibilityState = 'visible';
  title = '';

  constructor() {
    super(9, '#document', null);
    this.documentElement = new MiniElement('html', this);
    this.head = new MiniElement('head', this);
    this.body = new MiniElement('body', this);
    this.documentElement.appendChild(this.head);
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
      href: 'https://outside.vip/events/community-sunset',
      pathname: '/events/community-sunset',
      search: '',
      hash: '',
    },
    history: {
      state: {},
      replaceState: vi.fn(),
      pushState: vi.fn(),
    },
    navigator: {},
    getComputedStyle: () => ({ overflow: 'auto' }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  doc.defaultView = win;

  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as any).window = win;
  (globalThis as any).document = doc;
  (globalThis as any).sessionStorage = {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  };
  (globalThis as any).Node = MiniNode;
  (globalThis as any).Element = MiniElement;
  (globalThis as any).HTMLElement = MiniElement;
  (globalThis as any).HTMLInputElement = MiniElement;
  (globalThis as any).HTMLTextAreaElement = MiniElement;
  (globalThis as any).HTMLSelectElement = MiniElement;
  (globalThis as any).Event = MiniEvent;
  (globalThis as any).MouseEvent = MiniEvent;
  (globalThis as any).getComputedStyle = win.getComputedStyle;

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

function setReactInputValue(el: MiniElement, nextValue: string) {
  el.value = nextValue;
  const propsKey = Object.keys(el).find((k) => k.startsWith('__reactProps$'));
  const reactProps = propsKey ? (el as any)[propsKey] : null;
  if (reactProps?.onChange) {
    reactProps.onChange({ target: { value: nextValue }, currentTarget: { value: nextValue } });
  }
}

function triggerFormSubmit(formEl: MiniElement) {
  const propsKey = Object.keys(formEl).find((k) => k.startsWith('__reactProps$'));
  const reactProps = propsKey ? (formEl as any)[propsKey] : null;
  const evt = new MiniEvent('submit', { bubbles: true, cancelable: true });
  if (reactProps?.onSubmit) {
    reactProps.onSubmit(evt);
  }
}

const LocationProbe: React.FC<{ onLocationChange: (loc: string) => void }> = ({ onLocationChange }) => {
  const location = useLocation();
  React.useEffect(() => {
    onLocationChange(`${location.pathname}${location.search}`);
  }, [location, onLocationChange]);
  return <div data-testid="location-display">{`${location.pathname}${location.search}`}</div>;
};

describe('Stage 4 P0-01 Frontend Free-Ticket Checkout Behavioral Verification', () => {
  let container: MiniElement;
  let root: Root | null = null;
  let queryClient: QueryClient;

  const freeTier: TicketTier = {
    id: 'tier-free-1',
    eventId: 'evt-free-1',
    name: 'Free RSVP',
    priceInCents: 0,
    currency: 'USD',
    totalCapacity: 100,
    reservedQuantity: 0,
    soldQuantity: 0,
    remainingCapacity: 100,
    minPerOrder: 1,
    maxPerOrder: 5,
    status: 'ACTIVE',
    isAvailable: true,
  };

  const paidTier: TicketTier = {
    id: 'tier-paid-1',
    eventId: 'evt-free-1',
    name: 'Paid VIP',
    priceInCents: 2000,
    currency: 'USD',
    totalCapacity: 50,
    reservedQuantity: 0,
    soldQuantity: 0,
    remainingCapacity: 50,
    minPerOrder: 1,
    maxPerOrder: 5,
    status: 'ACTIVE',
    isAvailable: true,
  };

  function makeEvent(tiers: TicketTier[]): Event {
    return {
      id: 'evt-free-1',
      slug: 'community-sunset',
      organizerId: 'org-1',
      organizer: { id: 'org-1', name: 'Organizer' },
      title: 'Community Sunset Session',
      description: 'Event description',
      category: 'MUSIC',
      status: 'PUBLISHED',
      coverImageUrl: 'https://example.com/cover.jpg',
      venueName: 'Civic Park',
      venueAddress: '100 Main St',
      city: 'Austin',
      country: 'US',
      startAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      endAt: new Date(Date.now() + 30 * 3600 * 1000).toISOString(),
      timezone: 'America/Chicago',
      isFeatured: false,
      ticketTiers: tiers,
      minPriceInCents: Math.min(...tiers.map((t) => t.priceInCents)),
      currency: 'USD',
      hasAccess: true,
    };
  }

  beforeEach(() => {
    const dom = setupMiniDom();
    container = dom.container;
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    stripeMockState.elementsMountCount = 0;
    stripeMockState.cardElementMountCount = 0;
    stripeMockState.confirmCardPayment.mockReset();
    stripeMockState.getStripePromise.mockClear();
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
    delete (globalThis as any).sessionStorage;
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  });

  function fillEventCheckoutDetails(nameVal = 'Jane Doe', emailVal = 'jane@example.com', phoneVal = '+15551234567') {
    const plusBtns = container.findAll(
      (el) => el.tagName === 'BUTTON' && el.getAttribute('aria-label')?.startsWith('Increase ') === true
    );
    expect(plusBtns.length).toBeGreaterThan(0);
    const propsKey = Object.keys(plusBtns[0]).find((k) => k.startsWith('__reactProps$'));
    const reactProps = propsKey ? (plusBtns[0] as any)[propsKey] : null;
    if (reactProps?.onClick) {
      reactProps.onClick(new MiniEvent('click', { bubbles: true }));
    } else {
      plusBtns[0].dispatchEvent(new MiniEvent('click', { bubbles: true }));
    }

    const nameInput = container.findAll((el) => el.id === 'attendee-name')[0];
    const emailInput = container.findAll((el) => el.id === 'attendee-email')[0];
    const phoneInput = container.findAll((el) => el.id === 'attendee-phone')[0];

    setReactInputValue(nameInput, nameVal);
    setReactInputValue(emailInput, emailVal);
    setReactInputValue(phoneInput, phoneVal);
  }

  it('1, 2, 3: free checkout completes without Stripe clientSecret, never mounts CardElement or calls confirmCardPayment, and navigates to order confirmation', async () => {
    const freeEvent = makeEvent([freeTier]);
    vi.spyOn(api.events, 'bySlug').mockResolvedValueOnce({ event: freeEvent });
    const createSessionSpy = vi.spyOn(api.checkout, 'createSession').mockResolvedValueOnce({
      orderNumber: 'OUT-2026-44111',
      orderAccessToken: 'oat_free_token_xyz',
      status: 'COMPLETED',
      paymentProvider: 'FREE',
      isFreeOrder: true,
      clientSecret: null,
      totalInCents: 0,
      currency: 'USD',
      expiresAt: new Date().toISOString(),
    });

    let currentLocation = '';
    root = createRoot(container as any);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/events/community-sunset']}>
            <Routes>
              <Route path="/events/:slug" element={<EventDetailPage />} />
              <Route
                path="/orders/:orderNumber"
                element={<LocationProbe onLocationChange={(loc) => { currentLocation = loc; }} />}
              />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    await flushMicrotasks();

    await act(async () => {
      fillEventCheckoutDetails();
    });
    await flushMicrotasks();

    const submitBtn = container.findAll(
      (el) => el.tagName === 'BUTTON' && el.type === 'submit' && el.textContent.includes('Complete free registration')
    )[0];
    expect(submitBtn).toBeDefined();

    const formEl = container.findAll(
      (el) => el.tagName === 'FORM' && el.findAll((c) => c.id === 'attendee-email').length > 0
    )[0];
    await act(async () => {
      triggerFormSubmit(formEl);
    });
    await flushMicrotasks();

    expect(createSessionSpy).toHaveBeenCalledTimes(1);
    expect(createSessionSpy.mock.calls[0][0].idempotencyKey).toMatch(/^chk_/);
    expect(stripeMockState.elementsMountCount).toBe(0);
    expect(stripeMockState.cardElementMountCount).toBe(0);
    expect(stripeMockState.confirmCardPayment).not.toHaveBeenCalled();
    expect(currentLocation).toBe('/orders/OUT-2026-44111?token=oat_free_token_xyz');
  });

  it('2 (CheckoutDialog standalone): free session passed directly to CheckoutDialog never mounts Stripe Elements or CardElement and navigates cleanly', async () => {
    const freeEvent = makeEvent([freeTier]);
    const freeSession: CheckoutSessionResult = {
      orderNumber: 'OUT-2026-44222',
      orderAccessToken: 'oat_dialog_free',
      status: 'COMPLETED',
      paymentProvider: 'FREE',
      isFreeOrder: true,
      clientSecret: null,
      totalInCents: 0,
      currency: 'USD',
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };

    let currentLocation = '';
    root = createRoot(container as any);
    await act(async () => {
      root!.render(
        <MemoryRouter initialEntries={['/events/community-sunset']}>
          <Routes>
            <Route
              path="/events/:slug"
              element={
                <CheckoutDialog
                  isOpen={true}
                  onClose={vi.fn()}
                  event={freeEvent}
                  selectedItems={[{ tier: freeTier, quantity: 1 }]}
                  attendeeName="Jane Doe"
                  attendeeEmail="jane@example.com"
                  attendeePhone="+15551234567"
                  totalInCents={0}
                  currency="USD"
                  paymentSession={freeSession}
                  formatPrice={(cents) => (!cents ? 'Free' : `$${(cents / 100).toFixed(2)}`)}
                  onSessionExpired={vi.fn()}
                />
              }
            />
            <Route
              path="/orders/:orderNumber"
              element={<LocationProbe onLocationChange={(loc) => { currentLocation = loc; }} />}
            />
          </Routes>
        </MemoryRouter>
      );
    });
    await flushMicrotasks();

    expect(stripeMockState.elementsMountCount).toBe(0);
    expect(stripeMockState.cardElementMountCount).toBe(0);
    expect(stripeMockState.getStripePromise).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Free Registration Confirmed');

    const viewBtn = container.findAll(
      (el) => el.tagName === 'BUTTON' && el.textContent.includes('View & Download Tickets')
    )[0];
    expect(viewBtn).toBeDefined();

    await act(async () => {
      viewBtn.dispatchEvent(new MiniEvent('click', { bubbles: true }));
    });
    await flushMicrotasks();

    expect(stripeMockState.confirmCardPayment).not.toHaveBeenCalled();
    expect(currentLocation).toBe('/orders/OUT-2026-44222?token=oat_dialog_free');
  });

  it('4: paid checkout continues through the existing Stripe Elements + CardElement + confirmCardPayment flow', async () => {
    const paidEvent = makeEvent([paidTier]);
    vi.spyOn(api.events, 'bySlug').mockResolvedValueOnce({ event: paidEvent });
    const createSessionSpy = vi.spyOn(api.checkout, 'createSession').mockResolvedValueOnce({
      orderNumber: 'OUT-2026-55111',
      orderAccessToken: 'oat_paid_token_abc',
      status: 'PENDING',
      paymentProvider: 'STRIPE',
      isFreeOrder: false,
      clientSecret: 'pi_test_paid_secret_999',
      publishableKey: 'pk_test_123',
      totalInCents: 2394,
      currency: 'USD',
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
    stripeMockState.confirmCardPayment.mockResolvedValueOnce({
      paymentIntent: { id: 'pi_test_paid', status: 'succeeded' },
    });
    vi.spyOn(api.orders, 'getByOrderNumber').mockResolvedValueOnce({
      order: {
        id: 'ord-paid-1',
        orderNumber: 'OUT-2026-55111',
        status: 'COMPLETED',
        tickets: [{ id: 'tkt-1' }],
      } as any,
    });

    let currentLocation = '';
    root = createRoot(container as any);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/events/community-sunset']}>
            <Routes>
              <Route path="/events/:slug" element={<EventDetailPage />} />
              <Route
                path="/orders/:orderNumber"
                element={<LocationProbe onLocationChange={(loc) => { currentLocation = loc; }} />}
              />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    await flushMicrotasks();

    await act(async () => {
      fillEventCheckoutDetails();
    });
    await flushMicrotasks();

    const paidSubmitBtn = container.findAll(
      (el) => el.tagName === 'BUTTON' && el.type === 'submit' && el.textContent.includes('Continue to payment')
    )[0];
    expect(paidSubmitBtn).toBeDefined();

    const eventForm = container.findAll(
      (el) => el.tagName === 'FORM' && el.findAll((c) => c.id === 'attendee-email').length > 0
    )[0];
    await act(async () => {
      triggerFormSubmit(eventForm);
    });
    await flushMicrotasks();

    expect(createSessionSpy).toHaveBeenCalledTimes(1);
    expect(stripeMockState.elementsMountCount).toBeGreaterThanOrEqual(1);
    expect(stripeMockState.cardElementMountCount).toBe(1);

    const dialogForm = container.findAll(
      (el) => el.tagName === 'FORM' && el.findAll((c) => c.id === 'card-element-container').length > 0
    )[0];
    expect(dialogForm).toBeDefined();

    await act(async () => {
      triggerFormSubmit(dialogForm);
    });
    await flushMicrotasks(10);

    expect(stripeMockState.confirmCardPayment).toHaveBeenCalledTimes(1);
    expect(stripeMockState.confirmCardPayment.mock.calls[0][0]).toBe('pi_test_paid_secret_999');
    expect(currentLocation).toBe('/orders/OUT-2026-55111?token=oat_paid_token_abc');
  });

  it('5: prevents duplicate free checkout submissions while request is in flight', async () => {
    const freeEvent = makeEvent([freeTier]);
    vi.spyOn(api.events, 'bySlug').mockResolvedValueOnce({ event: freeEvent });

    let resolveRequest!: (val: CheckoutSessionResult) => void;
    const pendingPromise = new Promise<CheckoutSessionResult>((resolve) => {
      resolveRequest = resolve;
    });
    const createSessionSpy = vi.spyOn(api.checkout, 'createSession').mockReturnValueOnce(pendingPromise);

    let currentLocation = '';
    root = createRoot(container as any);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/events/community-sunset']}>
            <Routes>
              <Route path="/events/:slug" element={<EventDetailPage />} />
              <Route
                path="/orders/:orderNumber"
                element={<LocationProbe onLocationChange={(loc) => { currentLocation = loc; }} />}
              />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    await flushMicrotasks();

    await act(async () => {
      fillEventCheckoutDetails();
    });
    await flushMicrotasks();

    const formEl = container.findAll(
      (el) => el.tagName === 'FORM' && el.findAll((c) => c.id === 'attendee-email').length > 0
    )[0];

    await act(async () => {
      // Rapid double submit before first resolves
      triggerFormSubmit(formEl);
      triggerFormSubmit(formEl);
    });

    expect(createSessionSpy).toHaveBeenCalledTimes(1);
    const submitBtnDuringFlight = container.findAll(
      (el) => el.tagName === 'BUTTON' && el.type === 'submit' && el.textContent.includes('Completing registration...')
    )[0];
    expect(submitBtnDuringFlight).toBeDefined();
    expect(submitBtnDuringFlight.disabled).toBe(true);

    await act(async () => {
      resolveRequest({
        orderNumber: 'OUT-2026-66111',
        orderAccessToken: 'oat_single_flight',
        status: 'COMPLETED',
        paymentProvider: 'FREE',
        isFreeOrder: true,
        clientSecret: null,
        totalInCents: 0,
        currency: 'USD',
        expiresAt: new Date().toISOString(),
      });
    });
    await flushMicrotasks();

    expect(currentLocation).toBe('/orders/OUT-2026-66111?token=oat_single_flight');
  });

  it('6a: displays real ApiError (statusCode 429), clears loading state, and rotates idempotencyKey after 4xx rejection', async () => {
    const freeEvent = makeEvent([freeTier]);
    vi.spyOn(api.events, 'bySlug').mockResolvedValueOnce({ event: freeEvent });
    const apiErr = new ApiError(
      'Too many free ticket claims for this event.',
      429,
      undefined,
      undefined,
      'FREE_CHECKOUT_RATE_LIMIT'
    );
    const createSessionSpy = vi
      .spyOn(api.checkout, 'createSession')
      .mockRejectedValueOnce(apiErr)
      .mockResolvedValueOnce({
        orderNumber: 'OUT-2026-77111',
        orderAccessToken: 'oat_retry_success',
        status: 'COMPLETED',
        paymentProvider: 'FREE',
        isFreeOrder: true,
        clientSecret: null,
        totalInCents: 0,
        currency: 'USD',
        expiresAt: new Date().toISOString(),
      });

    let currentLocation = '';
    root = createRoot(container as any);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/events/community-sunset']}>
            <Routes>
              <Route path="/events/:slug" element={<EventDetailPage />} />
              <Route
                path="/orders/:orderNumber"
                element={<LocationProbe onLocationChange={(loc) => { currentLocation = loc; }} />}
              />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    await flushMicrotasks();

    await act(async () => {
      fillEventCheckoutDetails();
    });
    await flushMicrotasks();

    const formEl = container.findAll(
      (el) => el.tagName === 'FORM' && el.findAll((c) => c.id === 'attendee-email').length > 0
    )[0];

    await act(async () => {
      triggerFormSubmit(formEl);
    });
    await flushMicrotasks();

    expect(container.textContent).toContain('Too many free ticket claims for this event.');
    const submitBtnAfterError = container.findAll(
      (el) => el.tagName === 'BUTTON' && el.type === 'submit' && el.textContent.includes('Complete free registration')
    )[0];
    expect(submitBtnAfterError).toBeDefined();
    expect(submitBtnAfterError.disabled).toBe(false);

    // Retry generates a fresh idempotencyKey after the 4xx ApiError rejection and succeeds
    await act(async () => {
      triggerFormSubmit(formEl);
    });
    await flushMicrotasks();

    expect(createSessionSpy).toHaveBeenCalledTimes(2);
    const firstKey = createSessionSpy.mock.calls[0][0].idempotencyKey;
    const secondKey = createSessionSpy.mock.calls[1][0].idempotencyKey;
    expect(firstKey).toMatch(/^chk_/);
    expect(secondKey).toMatch(/^chk_/);
    expect(secondKey).not.toBe(firstKey);
    expect(currentLocation).toBe('/orders/OUT-2026-77111?token=oat_retry_success');
  });

  it('6b: preserves the exact same idempotencyKey across retryable 5xx ApiError or network failure', async () => {
    const freeEvent = makeEvent([freeTier]);
    vi.spyOn(api.events, 'bySlug').mockResolvedValueOnce({ event: freeEvent });
    const transientErr = new ApiError('Temporary service error', 503);
    const createSessionSpy = vi
      .spyOn(api.checkout, 'createSession')
      .mockRejectedValueOnce(transientErr)
      .mockRejectedValueOnce(new Error('Network request failed'))
      .mockResolvedValueOnce({
        orderNumber: 'OUT-2026-77222',
        orderAccessToken: 'oat_transient_retry',
        status: 'COMPLETED',
        paymentProvider: 'FREE',
        isFreeOrder: true,
        clientSecret: null,
        totalInCents: 0,
        currency: 'USD',
        expiresAt: new Date().toISOString(),
      });

    let currentLocation = '';
    root = createRoot(container as any);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/events/community-sunset']}>
            <Routes>
              <Route path="/events/:slug" element={<EventDetailPage />} />
              <Route
                path="/orders/:orderNumber"
                element={<LocationProbe onLocationChange={(loc) => { currentLocation = loc; }} />}
              />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    await flushMicrotasks();

    await act(async () => {
      fillEventCheckoutDetails();
    });
    await flushMicrotasks();

    const formEl = container.findAll(
      (el) => el.tagName === 'FORM' && el.findAll((c) => c.id === 'attendee-email').length > 0
    )[0];

    await act(async () => {
      triggerFormSubmit(formEl);
    });
    await flushMicrotasks();
    await act(async () => {
      triggerFormSubmit(formEl);
    });
    await flushMicrotasks();
    await act(async () => {
      triggerFormSubmit(formEl);
    });
    await flushMicrotasks();

    expect(createSessionSpy).toHaveBeenCalledTimes(3);
    const k1 = createSessionSpy.mock.calls[0][0].idempotencyKey;
    const k2 = createSessionSpy.mock.calls[1][0].idempotencyKey;
    const k3 = createSessionSpy.mock.calls[2][0].idempotencyKey;
    expect(k1).toMatch(/^chk_/);
    expect(k2).toBe(k1);
    expect(k3).toBe(k1);
    expect(currentLocation).toBe('/orders/OUT-2026-77222?token=oat_transient_retry');
  });

  it('7: active paid session preserves existing session/key while expired paid session rotates to a fresh idempotencyKey', async () => {
    const paidEvent = makeEvent([paidTier]);
    vi.spyOn(api.events, 'bySlug').mockResolvedValueOnce({ event: paidEvent });

    let nowMs = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);

    const createSessionSpy = vi
      .spyOn(api.checkout, 'createSession')
      .mockResolvedValueOnce({
        orderNumber: 'OUT-2026-88111',
        orderAccessToken: 'oat_paid_first',
        status: 'PENDING',
        paymentProvider: 'STRIPE',
        isFreeOrder: false,
        clientSecret: 'pi_first_secret',
        publishableKey: 'pk_test_123',
        totalInCents: 2394,
        currency: 'USD',
        expiresAt: new Date(nowMs + 120_000).toISOString(),
      })
      .mockResolvedValueOnce({
        orderNumber: 'OUT-2026-88222',
        orderAccessToken: 'oat_paid_second',
        status: 'PENDING',
        paymentProvider: 'STRIPE',
        isFreeOrder: false,
        clientSecret: 'pi_second_secret',
        publishableKey: 'pk_test_123',
        totalInCents: 2394,
        currency: 'USD',
        expiresAt: new Date(nowMs + 1_800_000).toISOString(),
      });

    root = createRoot(container as any);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/events/community-sunset']}>
            <Routes>
              <Route path="/events/:slug" element={<EventDetailPage />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    await flushMicrotasks();

    await act(async () => {
      fillEventCheckoutDetails();
    });
    await flushMicrotasks();

    const eventForm = container.findAll(
      (el) => el.tagName === 'FORM' && el.findAll((c) => c.id === 'attendee-email').length > 0
    )[0];

    // 1. Initial paid session creation
    await act(async () => {
      triggerFormSubmit(eventForm);
    });
    await flushMicrotasks();
    expect(createSessionSpy).toHaveBeenCalledTimes(1);
    const firstKey = createSessionSpy.mock.calls[0][0].idempotencyKey;

    // Close dialog early while session is still valid (> 15s left) and resubmit:
    // MUST reopen active dialog without creating a new session or rotating key.
    const closeBtn = container.findAll(
      (el) => el.tagName === 'BUTTON' && el.getAttribute('aria-label') === 'Close checkout'
    )[0];
    expect(closeBtn).toBeDefined();
    await act(async () => {
      closeBtn.dispatchEvent(new MiniEvent('click', { bubbles: true }));
    });
    await flushMicrotasks();

    await act(async () => {
      triggerFormSubmit(eventForm);
    });
    await flushMicrotasks();
    expect(createSessionSpy).toHaveBeenCalledTimes(1);

    // Advance past paid session expiry (!isSessionValid & countdown expiry) and close/re-submit
    nowMs += 130_000;
    await act(async () => {
      triggerFormSubmit(eventForm);
    });
    await flushMicrotasks();

    expect(createSessionSpy).toHaveBeenCalledTimes(2);
    const secondKey = createSessionSpy.mock.calls[1][0].idempotencyKey;
    expect(firstKey).toMatch(/^chk_/);
    expect(secondKey).toMatch(/^chk_/);
    expect(secondKey).not.toBe(firstKey);
    expect(container.textContent).toContain('#OUT-2026-88222');
  });

  it('8: CheckoutDialog timer expiry triggers handleSessionExpired, shows expired notice, clears pending key, and rotates key on next submit', async () => {
    const paidEvent = makeEvent([paidTier]);
    vi.spyOn(api.events, 'bySlug').mockResolvedValueOnce({ event: paidEvent });

    let nowMs = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);

    const intervalCallbacks: Array<() => void> = [];
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: any) => {
      intervalCallbacks.push(fn);
      return intervalCallbacks.length as any;
    }) as any);

    const createSessionSpy = vi
      .spyOn(api.checkout, 'createSession')
      .mockResolvedValueOnce({
        orderNumber: 'OUT-2026-99111',
        orderAccessToken: 'oat_timer_1',
        status: 'PENDING',
        paymentProvider: 'STRIPE',
        isFreeOrder: false,
        clientSecret: 'pi_timer_1_secret',
        publishableKey: 'pk_test_123',
        totalInCents: 2394,
        currency: 'USD',
        expiresAt: new Date(nowMs + 20_000).toISOString(),
      })
      .mockResolvedValueOnce({
        orderNumber: 'OUT-2026-99222',
        orderAccessToken: 'oat_timer_2',
        status: 'PENDING',
        paymentProvider: 'STRIPE',
        isFreeOrder: false,
        clientSecret: 'pi_timer_2_secret',
        publishableKey: 'pk_test_123',
        totalInCents: 2394,
        currency: 'USD',
        expiresAt: new Date(nowMs + 1_800_000).toISOString(),
      });

    root = createRoot(container as any);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/events/community-sunset']}>
            <Routes>
              <Route path="/events/:slug" element={<EventDetailPage />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    await flushMicrotasks();

    await act(async () => {
      fillEventCheckoutDetails();
    });
    await flushMicrotasks();

    const eventForm = container.findAll(
      (el) => el.tagName === 'FORM' && el.findAll((c) => c.id === 'attendee-email').length > 0
    )[0];

    await act(async () => {
      triggerFormSubmit(eventForm);
    });
    await flushMicrotasks();

    const firstKey = createSessionSpy.mock.calls[0][0].idempotencyKey;
    expect(intervalCallbacks.length).toBeGreaterThan(0);

    // Trigger CheckoutDialog countdown expiry live -> handleSessionExpired fires while keeping expired dialog visible
    nowMs += 25_000;
    await act(async () => {
      for (const cb of intervalCallbacks) cb();
    });
    await flushMicrotasks();

    expect(container.textContent).toContain('Your ticket reservation hold has expired.');

    const closeExpiredBtn = container.findAll(
      (el) => el.tagName === 'BUTTON' && el.textContent.includes('Close & Select Tickets')
    )[0];
    expect(closeExpiredBtn).toBeDefined();

    await act(async () => {
      closeExpiredBtn.dispatchEvent(new MiniEvent('click', { bubbles: true }));
    });
    await flushMicrotasks();

    // Resubmit after countdown expiry -> must generate a fresh idempotencyKey
    await act(async () => {
      triggerFormSubmit(eventForm);
    });
    await flushMicrotasks();

    expect(createSessionSpy).toHaveBeenCalledTimes(2);
    const secondKey = createSessionSpy.mock.calls[1][0].idempotencyKey;
    expect(firstKey).toMatch(/^chk_/);
    expect(secondKey).toMatch(/^chk_/);
    expect(secondKey).not.toBe(firstKey);
    expect(container.textContent).toContain('#OUT-2026-99222');
  });
});
