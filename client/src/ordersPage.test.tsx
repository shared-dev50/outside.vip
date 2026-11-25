import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthContext } from './context/AuthContext';
import { OrdersPage } from './pages/OrdersPage';
import { api } from './lib/api';
import { OrderRefundSummary, OrganizerOrderItem, RefundQuotePreview, User } from './types';

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
    HTMLIFrameElement: class {},
    ShadowRoot: class {},
    SVGElement: MiniElement,
    Event: MiniEvent,
    MouseEvent: MiniEvent,
    CustomEvent: MiniEvent,
    location: { origin: 'https://outside.vip', href: 'https://outside.vip/', pathname: '/orders', search: '', hash: '' },
    history: { state: {}, replaceState: vi.fn(), pushState: vi.fn() },
    navigator: { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } },
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

  const container = doc.createElement('div');
  doc.body.appendChild(container);
  return { container };
}

async function flushMicrotasks(ticks = 8) {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe('Organizer Orders Page Redesign & P0-03 Order Details Integration', () => {
  let container: MiniElement;
  let root: Root | null = null;
  let queryClient: QueryClient;

  const organizerUser: User = {
    id: 'org-1',
    email: 'sol@outside.vip',
    name: 'Sol Events',
    role: 'ORGANIZER',
    status: 'ACTIVE',
    emailVerified: true,
  };

  const sampleOrder: OrganizerOrderItem = {
    id: 'ord-10378',
    orderNumber: 'OUT-2026-10378',
    status: 'COMPLETED',
    paymentStatus: 'PAID',
    customerName: 'Amina Hassan',
    customerEmail: 'amina@example.com',
    customerPhone: '+254712345678',
    totalInCents: 11245,
    refundedAmountInCents: 5622,
    pendingRefundAmountInCents: 0,
    canManageRefunds: true,
    currency: 'USD',
    platformFeeInCents: 1000,
    organizerNetInCents: 9000,
    paymentProvider: 'STRIPE',
    createdAt: '2026-11-20T14:30:00Z',
    updatedAt: '2026-11-20T14:35:00Z',
    eventId: 'evt-1',
    event: {
      id: 'evt-1',
      organizerId: 'org-1',
      title: 'Nairobi Sundowner Sessions',
      slug: 'nairobi-sundowner',
      startAt: '2026-12-10T17:00:00Z',
      endAt: '2026-12-10T23:00:00Z',
      venueName: 'The Alchemist',
      city: 'Nairobi',
      country: 'Kenya',
    },
    items: [
      {
        id: 'item-1',
        ticketTierId: 'tier-vip',
        tierName: 'VIP Pass',
        quantity: 2,
        unitPriceInCents: 5000,
        subtotalInCents: 10000,
      },
    ],
    ticketQuantity: 2,
    ticketsCount: 2,
  };

  const sampleSummary: OrderRefundSummary = {
    order: {
      id: 'ord-10378',
      orderNumber: 'OUT-2026-10378',
      status: 'COMPLETED',
      currency: 'USD',
      totalInCents: 11245,
      refundedAmountInCents: 5622,
      pendingRefundAmountInCents: 0,
      remainingRefundableInCents: 5623,
      platformFeeInCents: 1000,
      organizerNetInCents: 9000,
      paymentProvider: 'STRIPE',
      isFreeOrder: false,
      customerName: 'Amina Hassan',
      customerEmail: 'amina@example.com',
      eventId: 'evt-1',
      eventTitle: 'Nairobi Sundowner Sessions',
    },
    capabilities: {
      initiatorRole: 'ORGANIZER',
      canOverrideCheckedIn: false,
      canShiftFeeToPlatform: false,
    },
    tickets: [
      {
        id: 'tkt-refunded-1',
        ticketCode: 'AAAA1111',
        ticketTierId: 'tier-vip',
        tierName: 'VIP Pass',
        status: 'REFUNDED',
        attendeeName: 'Amina Hassan',
        attendeeEmail: 'amina@example.com',
        checkedInAt: null,
        refundedAt: '2026-11-21T09:00:00Z',
        cancelledAt: null,
        cancellationReason: null,
        allocatedGrossInCents: 5000,
        allocatedPlatformFeeInCents: 500,
        allocatedServiceFeeInCents: 95,
        allocatedProcessingFeeInCents: 27,
        allocatedBuyerTotalInCents: 5622,
        activeRefundLock: false,
        refundEligibleForOrganizer: false,
        refundEligibleForAdmin: false,
      },
      {
        id: 'tkt-issued-2',
        ticketCode: 'BBBB2222',
        ticketTierId: 'tier-vip',
        tierName: 'VIP Pass',
        status: 'ISSUED',
        attendeeName: 'Amina Hassan',
        attendeeEmail: 'amina@example.com',
        checkedInAt: null,
        refundedAt: null,
        cancelledAt: null,
        cancellationReason: null,
        allocatedGrossInCents: 5000,
        allocatedPlatformFeeInCents: 500,
        allocatedServiceFeeInCents: 95,
        allocatedProcessingFeeInCents: 28,
        allocatedBuyerTotalInCents: 5623,
        activeRefundLock: false,
        refundEligibleForOrganizer: true,
        refundEligibleForAdmin: true,
      },
    ],
    refunds: [
      {
        id: 'ref-1',
        status: 'SUCCEEDED',
        refundKind: 'ORGANIZER_TICKET_REFUND',
        initiatorRole: 'ORGANIZER',
        feeBearer: 'ORGANIZER',
        refundStripeProcessingFee: false,
        amountInCents: 5622,
        ticketSubtotalInCents: 5000,
        platformFeeReversedInCents: 500,
        serviceFeeReversedInCents: 95,
        processingFeeInCents: 0,
        organizerDebitInCents: 4527,
        platformExpenseInCents: 0,
        restoreInventory: true,
        inventoryRestoredCount: 1,
        currency: 'USD',
        reason: 'Guest schedule conflict',
        stripeRefundId: 're_test_1',
        requiresManualResolution: false,
        lastErrorCode: null,
        lastErrorMessage: null,
        ticketIds: ['tkt-refunded-1'],
        createdAt: '2026-11-21T08:55:00Z',
        succeededAt: '2026-11-21T09:00:00Z',
        failedAt: null,
        cancelledAt: null,
      },
    ],
  };

  const createMockAuth = (user: User | null) => ({
    user,
    token: user ? 'cookie-session' : null,
    isAuthenticated: Boolean(user),
    isLoading: false,
    login: vi.fn(),
    register: vi.fn(),
    refreshUser: vi.fn(),
    logout: vi.fn(),
    clearSessionState: vi.fn(),
    updateUser: vi.fn(),
    verifyEmail: vi.fn(),
    resendVerification: vi.fn(),
    completePasswordlessLogin: vi.fn(),
  });

  beforeEach(() => {
    ({ container } = setupMiniDom());
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    vi.restoreAllMocks();
    vi.spyOn(api.organizer, 'listEvents').mockResolvedValue({ events: [] });
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

  const renderOrdersPage = async (user: User = organizerUser) => {
    root = createRoot(container as any);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/orders']}>
            <AuthContext.Provider value={createMockAuth(user)}>
              <OrdersPage />
            </AuthContext.Provider>
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    await flushMicrotasks();
  };

  it('renders the 7-column organizer table without customer columns and opens OrderDetailsModal leading into P0-03 refund flow', async () => {
    vi.spyOn(api.organizer, 'getOrders').mockResolvedValueOnce({
      orders: [sampleOrder],
      pagination: {
        page: 1,
        limit: 12,
        total: 1,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    });
    const getRefundsSpy = vi
      .spyOn(api.organizer, 'getOrderRefunds')
      .mockResolvedValue(sampleSummary);
    const previewSpy = vi.spyOn(api.organizer, 'previewOrderRefund').mockResolvedValue({
      orderId: sampleOrder.id,
      orderNumber: sampleOrder.orderNumber,
      currency: 'USD',
      isFreeCancellation: false,
      initiatorRole: 'ORGANIZER',
      checkedInOverrideApplied: false,
      buyerRefundAmountInCents: 5595,
      ticketSubtotalInCents: 5000,
      platformFeeReversedInCents: 500,
      serviceFeeReversedInCents: 95,
      stripeProcessingFeeInCents: 0,
      refundStripeProcessingFee: false,
      feeBearer: 'ORGANIZER',
      organizerDebitInCents: 4527,
      platformExpenseInCents: 0,
      remainingOrderRefundableAfterInCents: 28,
      restoreInventory: true,
      selectedTicketIds: ['tkt-issued-2'],
      lineItems: [],
    } as RefundQuotePreview);

    await renderOrdersPage();

    const headers = container.findAll((el) => el.tagName === 'TH').map((el) => el.textContent.trim());
    expect(headers).toEqual(['Order', 'Date', 'Event', 'Tickets', 'Total', 'Status', 'Actions']);

    const tbodyText = container.findAll((el) => el.tagName === 'TBODY')[0]?.textContent || '';
    expect(tbodyText).toContain('#OUT-2026-10378');
    expect(tbodyText).toContain('Nairobi Sundowner Sessions');
    expect(tbodyText).toContain('112.45 USD');
    expect(tbodyText).not.toContain('Amina Hassan');
    expect(tbodyText).not.toContain('amina@example.com');
    expect(tbodyText).not.toContain('+254712345678');

    const viewButton = container
      .findAll((el) => el.tagName === 'BUTTON')
      .find((b) => b.textContent.includes('View Order'));
    expect(viewButton).toBeDefined();

    await act(async () => {
      viewButton!.dispatchEvent(new MiniEvent('click'));
    });
    await flushMicrotasks();

    expect(getRefundsSpy).toHaveBeenCalledWith('ord-10378');

    const dialog = container.findAll((el) => el.getAttribute('role') === 'dialog')[0];
    expect(dialog).toBeDefined();
    expect(dialog.textContent).toContain('Order #OUT-2026-10378');
    expect(dialog.textContent).toContain('Amina Hassan');
    expect(dialog.textContent).toContain('amina@example.com');
    expect(dialog.textContent).toContain('+254712345678');
    expect(dialog.textContent).toContain('Eligible for Refund');
    expect(dialog.textContent).toContain('Guest schedule conflict');
    expect(dialog.textContent).toContain('Refund Tickets');

    const refundTicketsBtn = dialog
      .findAll((el) => el.tagName === 'BUTTON')
      .find((b) => b.textContent.includes('Refund Tickets'));
    expect(refundTicketsBtn).toBeDefined();

    await act(async () => {
      refundTicketsBtn!.dispatchEvent(new MiniEvent('click'));
    });
    await flushMicrotasks();

    const refundDialog = container.findAll((el) => el.getAttribute('role') === 'dialog')[0];
    expect(refundDialog.textContent).toContain('Manage Refunds · Order #OUT-2026-10378');
    expect(refundDialog.textContent).toContain('Select Individual Tickets');
    expect(previewSpy).not.toHaveBeenCalled();
  });

  it('respects Event Team non-owner restrictions (canManageRefunds=false) without calling refund APIs and explains why', async () => {
    const teamAdminOrder: OrganizerOrderItem = {
      ...sampleOrder,
      id: 'ord-team-only',
      canManageRefunds: false,
    };

    vi.spyOn(api.organizer, 'getOrders').mockResolvedValueOnce({
      orders: [teamAdminOrder],
      pagination: {
        page: 1,
        limit: 12,
        total: 1,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    });
    const getRefundsSpy = vi.spyOn(api.organizer, 'getOrderRefunds');

    await renderOrdersPage();

    const actionButtons = container.findAll((el) => el.tagName === 'BUTTON');
    expect(actionButtons.some((b) => b.textContent.includes('Manage Refund'))).toBe(false);

    const viewBtn = actionButtons.find((b) => b.textContent.includes('View Order'));
    await act(async () => {
      viewBtn!.dispatchEvent(new MiniEvent('click'));
    });
    await flushMicrotasks();

    expect(getRefundsSpy).not.toHaveBeenCalled();
    const dialog = container.findAll((el) => el.getAttribute('role') === 'dialog')[0];
    expect(dialog.textContent).toContain(
      'Refund actions and individual ticket allocations are restricted to the event owner or platform administrators.'
    );
    expect(
      dialog.findAll((el) => el.tagName === 'BUTTON').some((b) => b.textContent.includes('Refund Tickets'))
    ).toBe(false);
  });

  it('explains checked-in ticket refund restriction and hides Refund Tickets for organizers when no eligible tickets remain', async () => {
    vi.spyOn(api.organizer, 'getOrders').mockResolvedValueOnce({
      orders: [{ ...sampleOrder, refundedAmountInCents: 0 }],
      pagination: {
        page: 1,
        limit: 12,
        total: 1,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    });
    vi.spyOn(api.organizer, 'getOrderRefunds').mockResolvedValue({
      ...sampleSummary,
      tickets: [
        {
          ...sampleSummary.tickets[1],
          status: 'CHECKED_IN',
          checkedInAt: '2026-12-10T18:05:00Z',
          refundEligibleForOrganizer: false,
          refundEligibleForAdmin: true,
        },
      ],
      refunds: [],
    });

    await renderOrdersPage();

    const viewBtn = container
      .findAll((el) => el.tagName === 'BUTTON')
      .find((b) => b.textContent.includes('View Order'));
    await act(async () => {
      viewBtn!.dispatchEvent(new MiniEvent('click'));
    });
    await flushMicrotasks();

    const dialog = container.findAll((el) => el.getAttribute('role') === 'dialog')[0];
    expect(dialog.textContent).toContain('Checked-in tickets cannot be refunded by organizers.');
    expect(
      dialog.findAll((el) => el.tagName === 'BUTTON').some((b) => b.textContent.includes('Refund Tickets'))
    ).toBe(false);
  });

  it('renders clean empty, pagination, and 403 error states', async () => {
    vi.spyOn(api.organizer, 'getOrders').mockRejectedValueOnce(
      Object.assign(new Error('Forbidden'), { statusCode: 403 })
    );
    await renderOrdersPage();
    expect(container.textContent).toContain('Organizer Order Access Required');

    await act(async () => {
      root!.unmount();
    });
    queryClient.clear();

    vi.spyOn(api.organizer, 'getOrders').mockResolvedValueOnce({
      orders: [],
      pagination: {
        page: 1,
        limit: 12,
        total: 0,
        totalPages: 0,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    });
    await renderOrdersPage();
    expect(container.textContent).toContain('No orders yet');
  });

  it('debounces search input keystrokes, resets pagination to page 1, and triggers filtered getOrders call', async () => {
    const getOrdersSpy = vi
      .spyOn(api.organizer, 'getOrders')
      .mockResolvedValue({
        orders: [sampleOrder],
        pagination: {
          page: 1,
          limit: 12,
          total: 24,
          totalPages: 2,
          hasNextPage: true,
          hasPreviousPage: false,
        },
      });

    await renderOrdersPage();
    expect(getOrdersSpy).toHaveBeenCalledTimes(1);

    // Advance to page 2 first
    const nextBtn = container
      .findAll((el) => el.tagName === 'BUTTON')
      .find((b) => b.textContent.includes('Next'));
    expect(nextBtn).toBeDefined();
    await act(async () => {
      nextBtn!.dispatchEvent(new MiniEvent('click'));
    });
    await flushMicrotasks();
    expect(getOrdersSpy).toHaveBeenCalledTimes(2);
    expect(getOrdersSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 2, search: undefined })
    );

    const searchInput = container.findAll(
      (el) => el.tagName === 'INPUT' && el.getAttribute('aria-label') === 'Search orders'
    )[0];
    expect(searchInput).toBeDefined();

    // Update search input directly via React onChange props on internal fiber or input value+change event
    const reactPropsKey = Object.keys(searchInput).find((k) => k.startsWith('__reactProps$'));
    expect(reactPropsKey).toBeDefined();

    await act(async () => {
      (searchInput as any)[reactPropsKey!].onChange({ target: { value: 'sun' } });
    });
    await act(async () => {
      (searchInput as any)[reactPropsKey!].onChange({ target: { value: 'sundowner' } });
    });

    // Must NOT trigger an immediate fetch per keystroke
    expect(getOrdersSpy).toHaveBeenCalledTimes(2);

    // Wait past 300ms debounce window
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    await flushMicrotasks();

    expect(getOrdersSpy).toHaveBeenCalledTimes(3);
    expect(getOrdersSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, search: 'sundowner' })
    );
  });
});
