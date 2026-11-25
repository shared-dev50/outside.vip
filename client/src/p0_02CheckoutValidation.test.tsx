import React, { useState } from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TicketTierEditorSection } from './components/events/TicketTierEditorSection';
import { CheckoutDialog } from './components/events/CheckoutDialog';
import { OrderConfirmationPage } from './pages/OrderConfirmationPage';
import {
  calculateDisplayPriceFromGross,
  calculateGrossPriceFromDisplay,
  MIN_PAID_DISPLAY_PRICE_CENTS,
} from './lib/fees';
import {
  FormTicketTier,
  TicketTierFieldErrors,
  createEmptyTicketTier,
  validateTicketTiers,
  buildTicketTierPayload,
} from './lib/ticketCreation';
import { api } from './lib/api';
import { CheckoutSessionResult, Event, TicketTier } from './types';

const stripeMockState = vi.hoisted(() => ({
  confirmCardPayment: vi.fn(),
  getStripePromise: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('@stripe/react-stripe-js', () => ({
  Elements: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="stripe-elements">{children}</div>
  ),
  CardElement: ({ onReady }: { onReady?: () => void }) => {
    const onReadyRef = React.useRef(onReady);
    onReadyRef.current = onReady;
    React.useEffect(() => {
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

vi.mock('qrcode', () => ({
  default: {
    toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,iVBORw0KGgo='),
  },
}));

class MiniEvent {
  type: string;
  bubbles: boolean;
  cancelable: boolean;
  defaultPrevented = false;
  target: any = null;
  currentTarget: any = null;
  constructor(type: string, init?: { bubbles?: boolean; cancelable?: boolean }) {
    this.type = type;
    this.bubbles = init?.bubbles ?? true;
    this.cancelable = init?.cancelable ?? true;
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopPropagation() {}
  stopImmediatePropagation() {}
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
  set textContent(v: string) {
    this.childNodes = [];
    if (v !== '') {
      const txt = new MiniTextNode(String(v), this.ownerDocument);
      txt.parentNode = this;
      this.childNodes.push(txt);
    }
  }
  appendChild(child: MiniNode): MiniNode {
    if (child.nodeType === 11) {
      const fragChildren = [...child.childNodes];
      child.childNodes = [];
      for (const c of fragChildren) this.appendChild(c);
      return child;
    }
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    child.ownerDocument = this.ownerDocument;
    this.childNodes.push(child);
    return child;
  }
  insertBefore(child: MiniNode, ref: MiniNode | null): MiniNode {
    if (!ref) return this.appendChild(child);
    if (child.nodeType === 11) {
      const fragChildren = [...child.childNodes];
      child.childNodes = [];
      for (const c of fragChildren) this.insertBefore(c, ref);
      return child;
    }
    if (child.parentNode) child.parentNode.removeChild(child);
    const idx = this.childNodes.indexOf(ref);
    if (idx === -1) return this.appendChild(child);
    child.parentNode = this;
    child.ownerDocument = this.ownerDocument;
    this.childNodes.splice(idx, 0, child);
    return child;
  }
  removeChild(child: MiniNode): MiniNode {
    const idx = this.childNodes.indexOf(child);
    if (idx >= 0) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }
  addEventListener(type: string, fn: (e: any) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: (e: any) => void) {
    const list = this.listeners.get(type);
    if (!list) return;
    this.listeners.set(type, list.filter((f) => f !== fn));
  }
  dispatchEvent(event: any): boolean {
    if (!event.target) event.target = this;
    let current: MiniNode | null = this;
    while (current) {
      event.currentTarget = current;
      const list = current.listeners.get(event.type);
      if (list) {
        for (const fn of [...list]) fn.call(current, event);
      }
      current = event.bubbles ? current.parentNode : null;
    }
    return !event.defaultPrevented;
  }
}

class MiniTextNode extends MiniNode {
  data: string;
  constructor(text: string, ownerDocument: MiniDocument | null) {
    super(3, '#text', ownerDocument);
    this.data = String(text);
  }
  get nodeValue(): string {
    return this.data;
  }
  set nodeValue(v: string) {
    this.data = String(v);
  }
  get textContent(): string {
    return this.data;
  }
  set textContent(v: string) {
    this.data = String(v);
  }
}

class MiniCommentNode extends MiniNode {
  data: string;
  constructor(text: string, ownerDocument: MiniDocument | null) {
    super(8, '#comment', ownerDocument);
    this.data = String(text);
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
  type = '';
  id = '';
  className = '';
  htmlFor = '';

  constructor(tagName: string, ownerDocument: MiniDocument | null, namespaceURI?: string) {
    super(1, tagName.toUpperCase(), ownerDocument);
    this.tagName = tagName.toUpperCase();
    if (namespaceURI) this.namespaceURI = namespaceURI;
  }
  setAttribute(name: string, value: string) {
    const v = String(value);
    this.attributes.set(name, v);
    if (name === 'id') this.id = v;
    if (name === 'class') this.className = v;
    if (name === 'type') this.type = v;
    if (name === 'disabled') this.disabled = true;
    if (name === 'value') this.value = v;
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
    if (name === 'disabled') this.disabled = false;
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  focus() {}
  blur() {}
  scrollIntoView() {}
  findAll(predicate: (el: MiniElement) => boolean): MiniElement[] {
    const out: MiniElement[] = [];
    for (const child of this.childNodes) {
      if (child instanceof MiniElement) {
        if (predicate(child)) out.push(child);
        out.push(...child.findAll(predicate));
      }
    }
    return out;
  }
  findByTestId(testId: string): MiniElement | undefined {
    return this.findAll((el) => el.getAttribute('data-testid') === testId)[0];
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
  createElementNS(ns: string, tag: string) {
    return new MiniElement(tag, this, ns);
  }
  createTextNode(text: string) {
    return new MiniTextNode(text, this);
  }
  createComment(text: string) {
    return new MiniCommentNode(text, this);
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
  getElementById(id: string) {
    return this.body.findAll((el) => el.id === id)[0] ?? null;
  }
}

async function flushMicrotasks(rounds = 6) {
  for (let i = 0; i < rounds; i++) {
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

describe('Stage 4 P0-02 Frontend Checkout Validation & State Alignment', () => {
  let doc: MiniDocument;
  let container: MiniElement;
  let root: Root | null = null;
  let queryClient: QueryClient;

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    stripeMockState.confirmCardPayment.mockReset();

    doc = new MiniDocument();
    const fakeWindow: any = {
      document: doc,
      navigator: { userAgent: 'vitest' },
      location: { origin: 'http://localhost:5173', href: 'http://localhost:5173', pathname: '/', search: '', hash: '' },
      addEventListener: () => {},
      removeEventListener: () => {},
      getComputedStyle: () => ({ overflow: 'auto' }),
      history: { pushState: () => {}, replaceState: () => {}, state: {} },
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
      Event: MiniEvent,
      MouseEvent: MiniEvent,
      CustomEvent: MiniEvent,
      HTMLInputElement: MiniElement,
      HTMLTextAreaElement: MiniElement,
      HTMLSelectElement: MiniElement,
      HTMLIFrameElement: class MiniIFrameElement {},
      ShadowRoot: class MiniShadowRoot {},
      SVGElement: MiniElement,
    };
    doc.defaultView = fakeWindow;

    (globalThis as any).window = fakeWindow;
    (globalThis as any).document = doc;
    (globalThis as any).Element = MiniElement;
    (globalThis as any).HTMLElement = MiniElement;
    (globalThis as any).HTMLInputElement = MiniElement;
    (globalThis as any).HTMLTextAreaElement = MiniElement;
    (globalThis as any).HTMLSelectElement = MiniElement;
    (globalThis as any).Node = MiniNode;
    (globalThis as any).Event = MiniEvent;
    (globalThis as any).MouseEvent = MiniEvent;
    (globalThis as any).getComputedStyle = fakeWindow.getComputedStyle;
    (globalThis as any).sessionStorage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };

    container = doc.createElement('div');
    doc.body.appendChild(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
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

  describe('1. Organizer Tier Pricing Validation ($1.00 sub-minimum vs $0 free vs $1.30 min paid)', () => {
    const Harness: React.FC<{ onTiersChange: (tiers: FormTicketTier[]) => void; externalErrors?: Record<string, TicketTierFieldErrors> }> = ({
      onTiersChange,
      externalErrors = {},
    }) => {
      const [tiers, setTiers] = useState<FormTicketTier[]>([
        {
          ...createEmptyTicketTier('tier-p002'),
          name: 'General Admission',
          totalCapacity: 50,
        },
      ]);

      const handleUpdate = (tempId: string, field: keyof FormTicketTier, value: any) => {
        setTiers((prev) => {
          const next = prev.map((tier) => {
            if (tier.tempId !== tempId) return tier;
            if (field === 'displayPrice') {
              let calculatedGross: number | '' = '';
              if (value === '' || value === undefined || value === null) {
                calculatedGross = '';
              } else if (Number(value) === 0) {
                calculatedGross = 0;
              } else {
                const displayCents = Math.round(Number(value) * 100);
                calculatedGross =
                  displayCents >= MIN_PAID_DISPLAY_PRICE_CENTS
                    ? calculateGrossPriceFromDisplay(displayCents) / 100
                    : '';
              }
              return { ...tier, displayPrice: value, price: calculatedGross };
            }
            if (field === 'price') {
              let calculatedDisplay: number | '' = '';
              if (value === '' || value === undefined || value === null) {
                calculatedDisplay = '';
              } else if (Number(value) === 0) {
                calculatedDisplay = 0;
              } else {
                calculatedDisplay = calculateDisplayPriceFromGross(Math.round(Number(value) * 100)) / 100;
              }
              return { ...tier, price: value, displayPrice: calculatedDisplay };
            }
            return { ...tier, [field]: value };
          });
          onTiersChange(next);
          return next;
        });
      };

      return (
        <TicketTierEditorSection
          ticketTiers={tiers}
          timezone="America/New_York"
          tierErrors={externalErrors}
          onAddTier={() => {}}
          onRemoveTier={() => {}}
          onUpdateTier={handleUpdate}
        />
      );
    };

    it('displays validation error on $1.00 Display Price and never converts the tier to Free', async () => {
      let currentTiers: FormTicketTier[] = [];
      root = createRoot(container as any);
      await act(async () => {
        root!.render(<Harness onTiersChange={(t) => { currentTiers = t; }} />);
      });

      const numericInputs = container.findAll((el) => el.tagName === 'INPUT');
      // Input order in TicketTierEditorSection: [0]=name, [1]=description, [2]=gross price, [3]=display price
      const displayInput = numericInputs[3];
      expect(displayInput).toBeDefined();

      await act(async () => {
        setReactInputValue(displayInput, '1.00');
      });

      expect(currentTiers[0].displayPrice).toBe(1);
      expect(currentTiers[0].price).toBe(''); // Must NEVER become 0 (Free)
      expect(container.textContent).toContain('at least $1.30');
      expect(container.textContent).not.toContain('Free ($0.00)');

      const validation = validateTicketTiers(currentTiers, { requireAtLeastOne: true });
      expect(validation.isValid).toBe(false);
      expect(validation.tierErrors['tier-p002']?.displayPrice).toContain('$1.30');
    });

    it('preserves $0.00 free tier pricing and accepts $1.30 minimum paid display price', async () => {
      let currentTiers: FormTicketTier[] = [];
      root = createRoot(container as any);
      await act(async () => {
        root!.render(<Harness onTiersChange={(t) => { currentTiers = t; }} />);
      });

      const displayInput = container.findAll((el) => el.tagName === 'INPUT')[3];

      // Test 0 free ticket
      await act(async () => {
        setReactInputValue(displayInput, '0');
      });
      expect(currentTiers[0].price).toBe(0);
      expect(currentTiers[0].displayPrice).toBe(0);
      expect(validateTicketTiers(currentTiers, { requireAtLeastOne: true }).isValid).toBe(true);
      expect(container.textContent).toContain('Free ($0.00)');

      // Test 1.30 minimum paid display price
      await act(async () => {
        setReactInputValue(displayInput, '1.30');
      });
      expect(currentTiers[0].displayPrice).toBe(1.3);
      expect(currentTiers[0].price).toBe(0.01);
      expect(validateTicketTiers(currentTiers, { requireAtLeastOne: true }).isValid).toBe(true);

      const payload = buildTicketTierPayload(currentTiers[0], 'America/New_York', () => null);
      expect(payload.priceInCents).toBe(1);
      expect(payload.displayPriceInCents).toBe(130);
    });
  });

  describe('2. CheckoutDialog PaymentIntent processing vs succeeded card confirmation', () => {
    const sampleTier: TicketTier = {
      id: 'tier-paid-1',
      eventId: 'evt-p002-1',
      name: 'GA Paid',
      priceInCents: 2000,
      displayPriceInCents: 2394,
      currency: 'USD',
      totalCapacity: 50,
      reservedQuantity: 0,
      soldQuantity: 0,
      remainingCapacity: 50,
      minPerOrder: 1,
      maxPerOrder: 10,
      status: 'ACTIVE',
      isHidden: false,
      salesDisabled: false,
      isAvailable: true,
    };

    const sampleEvent = {
      id: 'evt-p002-1',
      slug: 'p002-live',
      title: 'P0-02 Paid Event',
      ticketTiers: [sampleTier],
    } as Event;

    const sampleSession: CheckoutSessionResult = {
      orderNumber: 'OUT-2026-88123',
      orderAccessToken: 'oat_p002_proc',
      status: 'PENDING',
      paymentProvider: 'STRIPE',
      isFreeOrder: false,
      clientSecret: 'pi_p002_proc_secret',
      publishableKey: 'pk_test_123',
      totalInCents: 2394,
      currency: 'USD',
      expiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
    };

    it('keeps form locked without re-enabling Pay button when processing PaymentIntent remains PENDING after 6 polls', async () => {
      vi.useFakeTimers();
      try {
        stripeMockState.confirmCardPayment.mockResolvedValueOnce({
          paymentIntent: { id: 'pi_p002_proc', status: 'processing' },
        });
        vi.spyOn(api.orders, 'getByOrderNumber').mockResolvedValue({
          order: {
            id: 'ord-proc-1',
            orderNumber: 'OUT-2026-88123',
            status: 'PENDING',
            tickets: [],
          } as any,
        });

        root = createRoot(container as any);
        await act(async () => {
          root!.render(
            <MemoryRouter>
              <CheckoutDialog
                isOpen={true}
                onClose={vi.fn()}
                event={sampleEvent}
                selectedItems={[{ tier: sampleTier, quantity: 1 }]}
                attendeeName="Processing User"
                attendeeEmail="proc@outside.vip"
                attendeePhone="+15551234567"
                totalInCents={2394}
                currency="USD"
                paymentSession={sampleSession}
                formatPrice={(cents) => `$${((cents || 0) / 100).toFixed(2)}`}
                onSessionExpired={vi.fn()}
              />
            </MemoryRouter>
          );
        });

        const dialogForm = container.findAll((el) => el.tagName === 'FORM')[0];
        expect(dialogForm).toBeDefined();

        await act(async () => {
          triggerFormSubmit(dialogForm);
        });

        await act(async () => {
          await Promise.resolve();
        });

        expect(container.textContent).not.toContain('Payment successful');
        expect(container.textContent).toContain('Awaiting payment verification');

        // Advance through all 6 polling intervals while order remains PENDING
        for (let i = 0; i < 6; i++) {
          await act(async () => {
            await vi.advanceTimersByTimeAsync(1000);
          });
        }

        expect(container.textContent).not.toContain('Payment successful');
        expect(container.textContent).toContain('View Order Status');
        expect(container.textContent).toContain('Close');

        // Form stays locked and Pay button cannot be resubmitted
        const submitBtns = container.findAll((el) => el.tagName === 'BUTTON' && el.type === 'submit');
        expect(submitBtns.length).toBe(0);
        expect(container.textContent).not.toContain('Pay $23.94');
        const inputs = container.findAll((el) => el.tagName === 'INPUT');
        expect(inputs.every((i) => i.disabled)).toBe(true);

        // Attempting to submit form again must never call confirmCardPayment again
        await act(async () => {
          triggerFormSubmit(dialogForm);
        });
        expect(stripeMockState.confirmCardPayment).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('never displays Payment successful on Stripe status=succeeded until persisted order reaches COMPLETED', async () => {
      vi.useFakeTimers();
      try {
        stripeMockState.confirmCardPayment.mockResolvedValueOnce({
          paymentIntent: { id: 'pi_p002_succ', status: 'succeeded' },
        });
        const getOrderSpy = vi
          .spyOn(api.orders, 'getByOrderNumber')
          .mockResolvedValueOnce({
            order: {
              id: 'ord-succ-1',
              orderNumber: 'OUT-2026-88123',
              status: 'PENDING',
              tickets: [],
            } as any,
          })
          .mockResolvedValueOnce({
            order: {
              id: 'ord-succ-1',
              orderNumber: 'OUT-2026-88123',
              status: 'COMPLETED',
              tickets: [{ id: 'tkt-1' }],
            } as any,
          });

        root = createRoot(container as any);
        await act(async () => {
          root!.render(
            <MemoryRouter>
              <Routes>
                <Route
                  path="*"
                  element={
                    <CheckoutDialog
                      isOpen={true}
                      onClose={vi.fn()}
                      event={sampleEvent}
                      selectedItems={[{ tier: sampleTier, quantity: 1 }]}
                      attendeeName="Confirmed User"
                      attendeeEmail="conf@outside.vip"
                      attendeePhone="+15551234567"
                      totalInCents={2394}
                      currency="USD"
                      paymentSession={sampleSession}
                      formatPrice={(cents) => `$${((cents || 0) / 100).toFixed(2)}`}
                      onSessionExpired={vi.fn()}
                    />
                  }
                />
              </Routes>
            </MemoryRouter>
          );
        });

        const dialogForm = container.findAll((el) => el.tagName === 'FORM')[0];
        await act(async () => {
          triggerFormSubmit(dialogForm);
        });
        await act(async () => {
          await Promise.resolve();
        });

        // First poll returned PENDING -> MUST stay awaiting confirmation, NOT show success
        expect(getOrderSpy).toHaveBeenCalledTimes(1);
        expect(container.textContent).not.toContain('Payment successful');
        expect(container.textContent).toContain('Awaiting payment verification');

        // Second poll after 1s returns COMPLETED -> transitions cleanly to success
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
        expect(getOrderSpy).toHaveBeenCalledTimes(2);
        expect(container.textContent).toContain('Payment successful');
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps form locked in awaiting-confirmation if succeeded PI remains PENDING across all 6 polls, and resets when paymentSession.orderNumber changes', async () => {
      vi.useFakeTimers();
      try {
        stripeMockState.confirmCardPayment.mockResolvedValueOnce({
          paymentIntent: { id: 'pi_p002_pend', status: 'succeeded' },
        });
        vi.spyOn(api.orders, 'getByOrderNumber').mockResolvedValue({
          order: {
            id: 'ord-pend-1',
            orderNumber: 'OUT-2026-88123',
            status: 'PENDING',
            tickets: [],
          } as any,
        });

        let updateSession!: (s: CheckoutSessionResult) => void;
        const DialogSwitchHarness: React.FC = () => {
          const [session, setSession] = useState(sampleSession);
          updateSession = setSession;
          return (
            <MemoryRouter>
              <CheckoutDialog
                isOpen={true}
                onClose={vi.fn()}
                event={sampleEvent}
                selectedItems={[{ tier: sampleTier, quantity: 1 }]}
                attendeeName="Switch User"
                attendeeEmail="switch@outside.vip"
                attendeePhone="+15551234567"
                totalInCents={2394}
                currency="USD"
                paymentSession={session}
                formatPrice={(cents) => `$${((cents || 0) / 100).toFixed(2)}`}
                onSessionExpired={vi.fn()}
              />
            </MemoryRouter>
          );
        };

        root = createRoot(container as any);
        await act(async () => {
          root!.render(<DialogSwitchHarness />);
        });

        const dialogForm = container.findAll((el) => el.tagName === 'FORM')[0];
        await act(async () => {
          triggerFormSubmit(dialogForm);
        });
        await act(async () => {
          await Promise.resolve();
        });
        for (let i = 0; i < 6; i++) {
          await act(async () => {
            await vi.advanceTimersByTimeAsync(1000);
          });
        }

        // Still PENDING after 6 polls -> locked, no success, View Order Status shown
        expect(container.textContent).not.toContain('Payment successful');
        expect(container.textContent).toContain('View Order Status');
        expect(container.findAll((el) => el.tagName === 'BUTTON' && el.type === 'submit').length).toBe(0);

        // Switching to a fresh paymentSession.orderNumber resets form and clears notice cleanly
        await act(async () => {
          updateSession({
            ...sampleSession,
            orderNumber: 'OUT-2026-99999',
            clientSecret: 'pi_p002_fresh_secret',
            expiresAt: new Date(Date.now() + 25 * 60 * 1000).toISOString(),
          });
        });

        expect(container.textContent).toContain('#OUT-2026-99999');
        expect(container.textContent).not.toContain('View Order Status');
        const payButtonsAfterReset = container.findAll(
          (el) => el.tagName === 'BUTTON' && el.type === 'submit'
        );
        expect(payButtonsAfterReset.length).toBe(1);
        expect(payButtonsAfterReset[0].disabled).toBe(false);
        expect(payButtonsAfterReset[0].textContent).toContain('Pay $23.94');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('3. OrderConfirmationPage Exact Cents Formatting & Terminal States', () => {
    const renderConfirmation = async (mockOrder: any) => {
      vi.spyOn(api.orders, 'getByOrderNumber').mockResolvedValue({
        order: mockOrder,
      });

      root = createRoot(container as any);
      await act(async () => {
        root!.render(
          <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={[`/orders/${mockOrder.orderNumber}?token=oat_test`]}>
              <Routes>
                <Route path="/orders/:orderNumber" element={<OrderConfirmationPage />} />
              </Routes>
            </MemoryRouter>
          </QueryClientProvider>
        );
      });
      await flushMicrotasks(8);
    };

    it('formats USD totals with exact cents ($23.94 and $1.30) without rounding to whole dollars', async () => {
      await renderConfirmation({
        id: 'ord-cents-1',
        orderNumber: 'OUT-2026-2394',
        status: 'COMPLETED',
        customerEmail: 'buyer@outside.vip',
        customerName: 'Buyer One',
        totalInCents: 2394,
        currency: 'USD',
        tickets: [],
      });
      expect(container.textContent).toContain('$23.94');
      expect(container.textContent).not.toContain('$24 ');

      await act(async () => {
        root!.unmount();
        root = null;
      });
      queryClient.clear();

      await renderConfirmation({
        id: 'ord-cents-2',
        orderNumber: 'OUT-2026-0130',
        status: 'COMPLETED',
        customerEmail: 'buyer2@outside.vip',
        customerName: 'Buyer Two',
        totalInCents: 130,
        currency: 'USD',
        tickets: [],
      });
      expect(container.textContent).toContain('$1.30');
    });

    it.each([
      { status: 'EXPIRED', expectedHeading: 'Order Expired' },
      { status: 'CANCELLED', expectedHeading: 'Order Cancelled' },
      { status: 'FAILED', expectedHeading: 'Payment Failed' },
    ])(
      'renders non-spinning terminal state for status=$status without Awaiting webhook verification',
      async ({ status, expectedHeading }) => {
        await renderConfirmation({
          id: `ord-${status}`,
          orderNumber: `OUT-2026-${status}`,
          status,
          customerEmail: 'term@outside.vip',
          customerName: 'Terminal Buyer',
          totalInCents: 2394,
          currency: 'USD',
          tickets: [],
          event: { slug: 'some-event', title: 'Some Event' },
        });

        expect(container.textContent).toContain(expectedHeading);
        expect(container.textContent).not.toContain('Awaiting webhook verification');
        const spinners = container.findAll((el) =>
          (el.className || '').includes('animate-spin')
        );
        expect(spinners.length).toBe(0);
      }
    );
  });
});
