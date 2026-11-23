import React, { useState } from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TicketTierEditorSection } from './components/events/TicketTierEditorSection';
import { EventDetailPage } from './pages/EventDetailPage';
import { CreateEventPage } from './pages/CreateEventPage';
import { AuthContext } from './context/AuthContext';
import { api } from './lib/api';
import {
  FormTicketTier,
  TicketTierFieldErrors,
  createEmptyTicketTier,
  mapExistingTicketTierToForm,
  validateTicketTiers,
  buildTicketTierPayload,
  computeVisibleMinDisplayPrice,
} from './lib/ticketCreation';
import { toInputValueInTimezone, toIsoValueInTimezone } from './lib/timezone';
import { Event, TicketTier, User } from './types';

// Minimal in-process DOM harness for real React 18 mounting in Vitest Node environment
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

  focus() {}
  blur() {}

  findAll(predicate: (el: MiniElement) => boolean): MiniElement[] {
    const out: MiniElement[] = [];
    const walk = (node: MiniNode) => {
      if (node instanceof MiniElement) {
        if (predicate(node)) out.push(node);
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
    location: { href: 'http://localhost:5173/', pathname: '/', search: '', hash: '', origin: 'http://localhost:5173' },
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
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    sessionStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
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

describe('Ticket Creation & Additional Settings — Unit & Mounted UI Behavior', () => {
  let doc: MiniDocument;
  let root: Root | null = null;
  let container: MiniElement | null = null;

  beforeEach(() => {
    ({ doc } = setupDomGlobals());
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

  it('1. Helper creates genuinely empty ticket form without default names, prices, or quantities', () => {
    const empty = createEmptyTicketTier('tier-empty');
    expect(empty.name).toBe('');
    expect(empty.description).toBe('');
    expect(empty.price).toBe('');
    expect(empty.displayPrice).toBe('');
    expect(empty.totalCapacity).toBe('');
    expect(empty.minPerOrder).toBe('');
    expect(empty.maxPerOrder).toBe('');
    expect(empty.isHidden).toBe(false);
    expect(empty.salesDisabled).toBe(false);
    expect(empty.hasSalesPeriod).toBe(false);
    expect(empty.hasTicketValidity).toBe(false);
  });

  it('2. Validation catches empty ticket lists and empty required fields without submitting placeholders', () => {
    const emptyListResult = validateTicketTiers([], { requireAtLeastOne: true });
    expect(emptyListResult.isValid).toBe(false);
    expect(emptyListResult.summaryError).toContain('add at least one ticket');

    const blankTier = createEmptyTicketTier('blank-1');
    const blankTierResult = validateTicketTiers([blankTier], { requireAtLeastOne: false });
    expect(blankTierResult.isValid).toBe(false);
    expect(blankTierResult.tierErrors['blank-1'].name).toBe('Ticket name is required.');
    expect(blankTierResult.tierErrors['blank-1'].price).toContain('Price is required');
    expect(blankTierResult.tierErrors['blank-1'].totalCapacity).toBe('Quantity is required.');

    // Free ticket with explicit 0 price is valid
    const freeTier: FormTicketTier = {
      ...createEmptyTicketTier('free-1'),
      name: 'Community Pass',
      price: 0,
      displayPrice: 0,
      totalCapacity: 50,
    };
    const freeResult = validateTicketTiers([freeTier], {
      requireAtLeastOne: true,
      requireVisibleForPublish: true,
    });
    expect(freeResult.isValid).toBe(true);
    const payload = buildTicketTierPayload(freeTier, 'America/New_York', toIsoValueInTimezone);
    expect(payload.name).toBe('Community Pass');
    expect(payload.priceInCents).toBe(0);
    expect(payload.totalCapacity).toBe(50);
    expect(payload.isHidden).toBe(false);
    expect(payload.salesDisabled).toBe(false);
    expect(payload.status).toBe('ACTIVE');

    // Publishing when all tiers are hidden fails validation
    const hiddenOnly: FormTicketTier = {
      ...freeTier,
      isHidden: true,
    };
    const hiddenPublishResult = validateTicketTiers([hiddenOnly], {
      requireAtLeastOne: true,
      requireVisibleForPublish: true,
    });
    expect(hiddenPublishResult.isValid).toBe(false);
    expect(hiddenPublishResult.summaryError).toContain('visible');
  });

  it('3. Editing an existing ticket preserves all saved values, including free price, dates, and legacy HIDDEN/PAUSED states', () => {
    const existingLegacyPaused: TicketTier = {
      id: 'tier-existing-1',
      eventId: 'evt-1',
      name: 'Backstage Access',
      description: 'Includes green room access',
      priceInCents: 0,
      currency: 'USD',
      totalCapacity: 75,
      reservedQuantity: 0,
      soldQuantity: 12,
      minPerOrder: 1,
      maxPerOrder: 4,
      salesStartAt: '2026-12-01T15:00:00.000Z',
      salesEndAt: '2026-12-10T15:00:00.000Z',
      validityStartAt: '2026-12-12T20:00:00.000Z',
      validityEndAt: '2026-12-13T02:00:00.000Z',
      status: 'PAUSED',
      isHidden: false,
      salesDisabled: false, // Legacy DB row before migration
      waitlistEnabled: true,
    };

    const mapped = mapExistingTicketTierToForm(
      existingLegacyPaused,
      'UTC',
      toInputValueInTimezone
    );
    expect(mapped.name).toBe('Backstage Access');
    expect(mapped.description).toBe('Includes green room access');
    expect(mapped.price).toBe(0);
    expect(mapped.displayPrice).toBe(0);
    expect(mapped.totalCapacity).toBe(75);
    expect(mapped.minPerOrder).toBe(1);
    expect(mapped.maxPerOrder).toBe(4);
    expect(mapped.hasSalesPeriod).toBe(true);
    expect(mapped.hasTicketValidity).toBe(true);
    expect(mapped.isHidden).toBe(false);
    expect(mapped.salesDisabled).toBe(true); // Backward-compatible from status: PAUSED
    expect(mapped.waitlistEnabled).toBe(true);
  });

  it('4. computeVisibleMinDisplayPrice ignores hidden tiers and unpriced tiers', () => {
    const hiddenCheap: FormTicketTier = {
      ...createEmptyTicketTier('t1'),
      name: 'Secret Comp',
      price: 5,
      displayPrice: 6.5,
      totalCapacity: 10,
      isHidden: true,
    };
    const publicRegular: FormTicketTier = {
      ...createEmptyTicketTier('t2'),
      name: 'Regular',
      price: 40,
      displayPrice: 46.5,
      totalCapacity: 100,
      isHidden: false,
    };
    const min = computeVisibleMinDisplayPrice([hiddenCheap, publicRegular]);
    expect(min).not.toBeNull();
    expect(min!).toBeGreaterThan(40);
    expect(computeVisibleMinDisplayPrice([createEmptyTicketTier('blank')])).toBeNull();
  });

  it('5. CreateEventPage starts new event creation with 0 tickets and never auto-creates Early Bird / VIP templates', () => {
    const organizerUser: User = {
      id: 'org-1',
      email: 'org@example.com',
      name: 'Test Organizer',
      role: 'ORGANIZER',
      emailVerified: true,
      emailVerifiedAt: new Date().toISOString(),
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const html = renderToStaticMarkup(
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
          <MemoryRouter initialEntries={['/organizer/events/new']}>
            <CreateEventPage />
          </MemoryRouter>
        </AuthContext.Provider>
      </QueryClientProvider>
    );

    expect(html).not.toContain('Early Bird General Admission');
    expect(html).not.toContain('VIP Deck &amp; Lounge');
    expect(html).not.toContain('VIP Deck & Lounge');
    // Sidebar shows Ticket Tiers: 0
    expect(html).toContain('<span>Ticket Tiers:</span><span class="text-stone-900 font-bold">0</span>');
  });

  it('6. Mounted TicketTierEditorSection shows empty state, opens blank form with placeholders on Add Ticket, keeps Additional settings collapsed by default, and toggles Hide/Disable independently without excluded toggles', async () => {
    let latestTiers: FormTicketTier[] = [];
    let setErrorsExternal: (errs: Record<string, TicketTierFieldErrors>) => void = () => {};

    const Harness: React.FC = () => {
      const [tiers, setTiers] = useState<FormTicketTier[]>([]);
      const [errors, setErrors] = useState<Record<string, TicketTierFieldErrors>>({});
      latestTiers = tiers;
      setErrorsExternal = setErrors;

      return (
        <TicketTierEditorSection
          ticketTiers={tiers}
          timezone="America/New_York"
          tierErrors={errors}
          onAddTier={() => setTiers((prev) => [...prev, createEmptyTicketTier(`t-${prev.length + 1}`)])}
          onRemoveTier={(tempId) => setTiers((prev) => prev.filter((t) => t.tempId !== tempId))}
          onUpdateTier={(tempId, field, value) =>
            setTiers((prev) =>
              prev.map((t) => (t.tempId === tempId ? { ...t, [field]: value } : t))
            )
          }
        />
      );
    };

    root = createRoot(container as any);
    await act(async () => {
      root!.render(<Harness />);
    });

    // Empty state shown initially
    expect(container!.findByTestId('empty-tickets-state')).toBeDefined();
    expect(container!.textContent).toContain('No tickets added yet');
    expect(container!.textContent).not.toContain('Early Bird General Admission');
    expect(container!.textContent).not.toContain('VIP Deck & Lounge');

    // Click Add Ticket
    const addBtn = container!.findByTestId('empty-add-ticket-btn')!;
    expect(addBtn).toBeDefined();
    await act(async () => {
      addBtn.click();
    });

    expect(latestTiers.length).toBe(1);
    expect(container!.findByTestId('ticket-tier-card-0')).toBeDefined();

    // Verify inputs start empty with helpful placeholders
    const nameInput = container!.findAll((el) => el.id === 'tier-name-t-1')[0];
    expect(nameInput.value).toBe('');
    expect(nameInput.placeholder).toContain('Early Bird');

    const descInput = container!.findAll((el) => el.id === 'tier-description-t-1')[0];
    expect(descInput.value).toBe('');
    expect(descInput.placeholder).toContain('Includes venue entry');

    // Validate required fields cleanly when empty
    const validation = validateTicketTiers(latestTiers, { requireAtLeastOne: true });
    expect(validation.isValid).toBe(false);
    await act(async () => {
      setErrorsExternal(validation.tierErrors);
    });
    expect(container!.textContent).toContain('Ticket name is required.');
    expect(container!.textContent).toContain('Price is required');
    expect(container!.textContent).toContain('Quantity is required.');

    // Additional settings is collapsed by default
    const additionalToggle = container!.findByTestId('additional-settings-toggle-0')!;
    expect(additionalToggle).toBeDefined();
    expect(additionalToggle.getAttribute('aria-expanded')).toBe('false');
    expect(container!.findByTestId('additional-settings-panel-0')).toBeUndefined();

    // Expand Additional settings
    await act(async () => {
      additionalToggle.click();
    });
    expect(additionalToggle.getAttribute('aria-expanded')).toBe('true');
    const panel = container!.findByTestId('additional-settings-panel-0')!;
    expect(panel).toBeDefined();

    // Verify ONLY Hide ticket and Disable ticket sales switches exist inside Additional settings
    const switchesInsidePanel = panel.findAll((el) => el.getAttribute('role') === 'switch');
    expect(switchesInsidePanel.length).toBe(2);
    expect(switchesInsidePanel.map((el) => el.getAttribute('aria-label'))).toEqual([
      'Hide ticket',
      'Disable ticket sales',
    ]);

    // Explicitly verify NONE of the excluded toggles appear anywhere
    const panelText = panel.textContent.toLowerCase();
    expect(panelText).not.toContain('password');
    expect(panelText).not.toContain('available online');
    expect(panelText).not.toContain('transfer');
    expect(panelText).not.toContain('require approval');

    // Toggle both independently and verify neither clobbers the other
    const hideSwitch = container!.findByTestId('hide-ticket-switch-0')!;
    const disableSwitch = container!.findByTestId('disable-sales-switch-0')!;
    expect(hideSwitch.getAttribute('aria-checked')).toBe('false');
    expect(disableSwitch.getAttribute('aria-checked')).toBe('false');

    await act(async () => {
      hideSwitch.click();
    });
    expect(latestTiers[0].isHidden).toBe(true);
    expect(latestTiers[0].salesDisabled).toBe(false);

    await act(async () => {
      disableSwitch.click();
    });
    expect(latestTiers[0].isHidden).toBe(true);
    expect(latestTiers[0].salesDisabled).toBe(true);

    // Turn off Hide ticket -> Disable ticket sales stays ON
    await act(async () => {
      hideSwitch.click();
    });
    expect(latestTiers[0].isHidden).toBe(false);
    expect(latestTiers[0].salesDisabled).toBe(true);

    // Collapse Additional settings again
    await act(async () => {
      additionalToggle.click();
    });
    expect(additionalToggle.getAttribute('aria-expanded')).toBe('false');
    expect(container!.findByTestId('additional-settings-panel-0')).toBeUndefined();
    expect(additionalToggle.textContent).toContain('Sales disabled');
  });

  it('7. Public EventDetailPage excludes hidden tickets and renders sales-disabled tickets as unavailable without quantity controls or waitlist button', async () => {
    const mockEvent: Event = {
      id: 'evt-public-1',
      slug: 'public-ticket-test',
      organizerId: 'org-1',
      organizer: { id: 'org-1', name: 'Host Org' },
      title: 'Public Visibility Test Event',
      description: 'Testing public ticket controls',
      category: 'MUSIC',
      status: 'PUBLISHED',
      coverImageUrl: 'https://example.com/cover.jpg',
      venueName: 'Main Hall',
      venueAddress: '100 Main St',
      city: 'New York',
      country: 'United States',
      startAt: new Date(Date.now() + 86400000).toISOString(),
      endAt: new Date(Date.now() + 90000000).toISOString(),
      timezone: 'America/New_York',
      ageRestriction: '18+',
      isFeatured: false,
      hasAccess: true,
      isPasswordProtected: false,
      ticketTiers: [
        {
          id: 'tier-active',
          eventId: 'evt-public-1',
          name: 'General Admission',
          priceInCents: 3000,
          displayPriceInCents: 3500,
          currency: 'USD',
          totalCapacity: 100,
          reservedQuantity: 0,
          soldQuantity: 10,
          remainingCapacity: 90,
          minPerOrder: 1,
          maxPerOrder: 6,
          status: 'ACTIVE',
          isHidden: false,
          salesDisabled: false,
          isAvailable: true,
        },
        {
          id: 'tier-disabled',
          eventId: 'evt-public-1',
          name: 'VIP Table Pass',
          priceInCents: 10000,
          displayPriceInCents: 11400,
          currency: 'USD',
          totalCapacity: 20,
          reservedQuantity: 0,
          soldQuantity: 20,
          remainingCapacity: 0,
          minPerOrder: 1,
          maxPerOrder: 4,
          status: 'PAUSED',
          isHidden: false,
          salesDisabled: true,
          isAvailable: false,
          waitlistEnabled: true,
        },
        {
          id: 'tier-hidden',
          eventId: 'evt-public-1',
          name: 'Secret Artist Comp',
          priceInCents: 0,
          displayPriceInCents: 0,
          currency: 'USD',
          totalCapacity: 10,
          reservedQuantity: 0,
          soldQuantity: 0,
          remainingCapacity: 10,
          minPerOrder: 1,
          maxPerOrder: 2,
          status: 'HIDDEN',
          isHidden: true,
          salesDisabled: false,
          isAvailable: false,
        },
      ],
    };

    vi.spyOn(api.events, 'bySlug').mockResolvedValue({ event: mockEvent });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    root = createRoot(container as any);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <AuthContext.Provider
            value={{
              user: null,
              isLoading: false,
              login: vi.fn(),
              verifyEmail: vi.fn(),
              resendVerification: vi.fn(),
              register: vi.fn(),
              logout: vi.fn(),
              refreshUser: vi.fn(),
            }}
          >
            <MemoryRouter initialEntries={['/events/public-ticket-test']}>
              <Routes>
                <Route path="/events/:slug" element={<EventDetailPage />} />
              </Routes>
            </MemoryRouter>
          </AuthContext.Provider>
        </QueryClientProvider>
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    // Active tier is visible with quantity controls
    const activeCard = container!.findByTestId('public-ticket-tier-tier-active');
    expect(activeCard).toBeDefined();
    expect(
      activeCard!.findAll((el) => el.getAttribute('aria-label') === 'Increase General Admission').length
    ).toBe(1);

    // Disabled tier is visible with unavailable state, NO quantity controls, NO Join waitlist
    const disabledCard = container!.findByTestId('public-ticket-tier-tier-disabled');
    expect(disabledCard).toBeDefined();
    expect(disabledCard!.textContent).toContain('Sales unavailable');
    expect(disabledCard!.textContent).toContain('disabled by the organizer');
    expect(
      disabledCard!.findAll((el) => el.getAttribute('aria-label') === 'Increase VIP Table Pass').length
    ).toBe(0);
    expect(disabledCard!.textContent).not.toContain('Join waitlist');

    // Hidden tier is NOT rendered at all
    expect(container!.findByTestId('public-ticket-tier-tier-hidden')).toBeUndefined();
    expect(container!.textContent).not.toContain('Secret Artist Comp');
  });
});

