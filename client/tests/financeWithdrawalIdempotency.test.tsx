import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthContext } from '../src/context/AuthContext';
import { FinanceOrganizationPage } from '../src/pages/FinanceOrganizationPage';
import { api } from '../src/lib/api';
import { User } from '../src/types';

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
      href: 'https://outside.vip/organizer/finance',
      pathname: '/organizer/finance',
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

  const container = doc.createElement('div');
  doc.body.appendChild(container);
  return { doc, win, container };
}

async function flushMicrotasks(ticks = 8) {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe('FinanceOrganizationPage Mounted Withdrawal Idempotency & Double-Submit Guard', () => {
  let container: MiniElement;
  let root: Root | null = null;
  let queryClient: QueryClient;

  const organizerUser: User = {
    id: 'usr-org-fin-1',
    email: 'org-fin@outside.vip',
    name: 'Finance Organizer',
    role: 'ORGANIZER',
    status: 'ACTIVE',
    emailVerified: true,
  };

  const connectedReadyStatus = {
    connected: true,
    connectionStatus: 'connected' as const,
    stripeAccountId: 'acct_ready_fin_1',
    country: 'US',
    defaultCurrency: 'USD',
    detailsSubmitted: true,
    chargesEnabled: true,
    payoutsEnabled: true,
    sellTickets: { enabled: true, status: 'enabled' as const, message: 'Enabled' },
    transferBalance: { enabled: true, status: 'enabled' as const, message: 'Enabled' },
    requirements: {
      currentlyDue: [],
      eventuallyDue: [],
      pastDue: [],
      pendingVerification: [],
      disabledReason: null,
    },
    externalAccounts: [
      {
        id: 'ba_fin_1',
        bankName: 'Chase',
        accountHolderName: 'Finance Organizer',
        last4: '4242',
        routingNumber: '••••0025',
        currency: 'usd',
        isDefault: true,
        status: 'verified',
      },
    ],
    payoutSchedule: { interval: 'daily', delayDays: 2 },
    supportedCountries: [{ code: 'US', name: 'United States' }],
    supportedCurrencies: ['USD'],
    defaultCountry: 'US',
  };

  beforeEach(() => {
    const dom = setupMiniDom();
    container = dom.container;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    vi.spyOn(api.finance, 'getSupportedCountries').mockResolvedValue({
      countries: [{ code: 'US', name: 'United States' }],
      defaultCountry: 'US',
    });
    vi.spyOn(api.finance, 'getStatus').mockResolvedValue(connectedReadyStatus as any);
    vi.spyOn(api.finance, 'getBalance').mockResolvedValue({
      availableInCents: 10000,
      pendingInCents: 0,
      transferredInCents: 0,
      recoverableInCents: 0,
      lifetimeEarningsInCents: 10000,
      currency: 'USD',
      available: [{ amount: 10000, currency: 'usd' }],
      pending: [{ amount: 0, currency: 'usd' }],
    } as any);
    vi.spyOn(api.finance, 'getTransfers').mockResolvedValue({
      total: 0,
      page: 1,
      limit: 20,
      totalPages: 0,
      transfers: [],
    });
    vi.spyOn(api.finance, 'getPayouts').mockResolvedValue({ payouts: [] } as any);
    vi.spyOn(api.finance, 'getDisputes').mockResolvedValue({ disputes: [] } as any);
    vi.spyOn(api.finance, 'getLedger').mockResolvedValue({
      total: 0,
      page: 1,
      limit: 20,
      totalPages: 0,
      entries: [],
    });
    vi.spyOn(api.organizer, 'getPayoutDetails').mockResolvedValue({ payoutDetails: null });
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

  function findButtonByText(text: string): MiniElement | undefined {
    return container
      .findAll((el) => el.tagName === 'BUTTON' && el.textContent.includes(text))
      .find(Boolean);
  }

  it('retains idempotencyKey on HTTP 202 and 5xx retries, rotates on amount change and terminal failure, and blocks duplicate submissions', async () => {
    const withdrawSpy = vi.spyOn(api.finance, 'withdraw');

    root = createRoot(container as any);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/organizer/finance']}>
            <AuthContext.Provider
              value={{
                user: organizerUser,
                token: 'tok-fin',
                isLoading: false,
                login: vi.fn(),
                signup: vi.fn(),
                logout: vi.fn(),
                refreshUser: vi.fn(),
                clearSessionState: vi.fn(),
              } as any}
            >
              <FinanceOrganizationPage />
            </AuthContext.Provider>
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    await flushMicrotasks();

    // Open withdrawal modal via primary button (defaults amount to $100.00)
    const openBtn = findButtonByText('Request Withdrawal');
    expect(openBtn).toBeDefined();
    await act(async () => {
      openBtn!.dispatchEvent(new MiniEvent('click', { bubbles: true }));
    });
    await flushMicrotasks();

    const findWithdrawForm = () =>
      container.findAll(
        (el) =>
          el.tagName === 'FORM' &&
          (el.textContent.includes('Confirm Withdrawal') || el.textContent.includes('Transferring...'))
      )[0];

    expect(findWithdrawForm()).toBeDefined();

    // 1. Ambiguous HTTP 202 pending response retains the exact same idempotencyKey
    withdrawSpy.mockResolvedValueOnce({
      transferId: 'trf_202',
      transferNumber: 'TRF-202',
      stripeTransferId: null,
      amountInCents: 10000,
      reversedAmountInCents: 0,
      currency: 'USD',
      status: 'PENDING',
      reconciliationRequired: true,
      retryable: true,
      message: 'Awaiting Stripe confirmation.',
      sourceType: 'MANUAL_ORGANIZER_REQUEST',
      remainingAvailableInCents: 0,
      transferredInCents: 0,
      createdAt: new Date().toISOString(),
    });

    await act(async () => {
      findWithdrawForm().dispatchEvent(new MiniEvent('submit', { bubbles: true }));
    });
    await flushMicrotasks();

    expect(withdrawSpy).toHaveBeenCalledTimes(1);
    const keyAfterOpen = withdrawSpy.mock.calls[0][0].idempotencyKey;
    expect(keyAfterOpen).toMatch(/^wd_/);
    // Modal stays open for safe retry
    expect(findWithdrawForm()).toBeDefined();

    // 2. Network / 5xx failure on retry ALSO retains the exact same idempotencyKey
    withdrawSpy.mockRejectedValueOnce(
      Object.assign(new Error('Upstream Stripe timeout'), { statusCode: 503, code: 'SERVICE_UNAVAILABLE' })
    );

    await act(async () => {
      findWithdrawForm().dispatchEvent(new MiniEvent('submit', { bubbles: true }));
    });
    await flushMicrotasks();

    expect(withdrawSpy).toHaveBeenCalledTimes(2);
    expect(withdrawSpy.mock.calls[1][0].idempotencyKey).toBe(keyAfterOpen);

    // 3. Changing amount via preset button ($25) MUST rotate idempotencyKey
    const preset25Btn = findButtonByText('$25');
    expect(preset25Btn).toBeDefined();
    await act(async () => {
      preset25Btn!.dispatchEvent(new MiniEvent('click', { bubbles: true }));
    });
    await flushMicrotasks();

    // Confirmed terminal failure rotates idempotencyKey AFTER rejecting
    withdrawSpy.mockRejectedValueOnce(
      Object.assign(new Error('Account restricted'), { statusCode: 400, code: 'TRANSFER_EXECUTION_FAILED' })
    );
    await act(async () => {
      findWithdrawForm().dispatchEvent(new MiniEvent('submit', { bubbles: true }));
    });
    await flushMicrotasks();

    expect(withdrawSpy).toHaveBeenCalledTimes(3);
    const keyFor25 = withdrawSpy.mock.calls[2][0].idempotencyKey;
    expect(withdrawSpy.mock.calls[2][0].amountInCents).toBe(2500);
    expect(keyFor25).not.toBe(keyAfterOpen);

    // 4. Next submit after terminal failure MUST have rotated to a third distinct key,
    // AND double-submitting while in-flight MUST only invoke api.finance.withdraw once!
    let resolveInFlight!: (val: any) => void;
    withdrawSpy.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveInFlight = resolve;
        })
    );

    await act(async () => {
      findWithdrawForm().dispatchEvent(new MiniEvent('submit', { bubbles: true }));
    });
    // Second rapid submit while promise is unresolved
    await act(async () => {
      findWithdrawForm().dispatchEvent(new MiniEvent('submit', { bubbles: true }));
    });
    expect(withdrawSpy).toHaveBeenCalledTimes(4);
    const keyAfterTerminalFailure = withdrawSpy.mock.calls[3][0].idempotencyKey;
    expect(keyAfterTerminalFailure).not.toBe(keyFor25);

    await act(async () => {
      resolveInFlight({
        transferId: 'trf_ok_4',
        transferNumber: 'TRF-OK-4',
        stripeTransferId: 'tr_ok_4',
        amountInCents: 2500,
        reversedAmountInCents: 0,
        currency: 'USD',
        status: 'SUCCEEDED',
        reconciliationRequired: false,
        sourceType: 'MANUAL_ORGANIZER_REQUEST',
        remainingAvailableInCents: 7500,
        transferredInCents: 2500,
        createdAt: new Date().toISOString(),
      });
    });
    await flushMicrotasks();

    // 5. After SUCCEEDED: modal is closed (prevents re-submitting completed intent), and reopening creates a new key
    expect(findWithdrawForm()).toBeUndefined();

    const reopenBtn = findButtonByText('Request Withdrawal');
    await act(async () => {
      reopenBtn!.dispatchEvent(new MiniEvent('click', { bubbles: true }));
    });
    await flushMicrotasks();

    withdrawSpy.mockResolvedValueOnce({
      transferId: 'trf_ok_5',
      transferNumber: 'TRF-OK-5',
      stripeTransferId: 'tr_ok_5',
      amountInCents: 10000,
      reversedAmountInCents: 0,
      currency: 'USD',
      status: 'SUCCEEDED',
      reconciliationRequired: false,
      sourceType: 'MANUAL_ORGANIZER_REQUEST',
      remainingAvailableInCents: 0,
      transferredInCents: 10000,
      createdAt: new Date().toISOString(),
    });
    await act(async () => {
      findWithdrawForm().dispatchEvent(new MiniEvent('submit', { bubbles: true }));
    });
    await flushMicrotasks();

    expect(withdrawSpy).toHaveBeenCalledTimes(5);
    expect(withdrawSpy.mock.calls[4][0].idempotencyKey).not.toBe(keyAfterTerminalFailure);
  });
});
