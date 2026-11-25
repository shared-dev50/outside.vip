import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthContext } from '../src/context/AuthContext';
import { AuthFormCard } from '../src/components/auth/AuthFormCard';
import { ResetPasswordPage } from '../src/pages/ResetPasswordPage';
import { api, ApiError } from '../src/lib/api';

class MiniEvent {
  type: string;
  bubbles: boolean;
  cancelable: boolean;
  button = 0;
  defaultPrevented = false;
  target: any = null;
  currentTarget: any = null;
  propagationStopped = false;
  constructor(type: string, init?: { bubbles?: boolean; cancelable?: boolean; button?: number }) {
    this.type = type;
    this.bubbles = init?.bubbles ?? true;
    this.cancelable = init?.cancelable ?? true;
    this.button = init?.button ?? 0;
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
    location: { origin: 'https://outside.vip', href: 'https://outside.vip/', pathname: '/', search: '', hash: '' },
    history: { state: {}, replaceState: vi.fn(), pushState: vi.fn() },
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
  (globalThis as any).Node = MiniNode;
  (globalThis as any).Element = MiniElement;
  (globalThis as any).HTMLElement = MiniElement;
  (globalThis as any).HTMLInputElement = MiniElement;
  (globalThis as any).HTMLTextAreaElement = MiniElement;
  (globalThis as any).HTMLSelectElement = MiniElement;
  (globalThis as any).HTMLIFrameElement = win.HTMLIFrameElement;
  (globalThis as any).ShadowRoot = win.ShadowRoot;
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

function changeInput(el: MiniElement, nextValue: string) {
  el.value = nextValue;
  const propsKey = Object.keys(el).find((k) => k.startsWith('__reactProps$'));
  const reactProps = propsKey ? (el as any)[propsKey] : null;
  if (reactProps?.onChange) {
    reactProps.onChange({ target: { value: nextValue }, currentTarget: { value: nextValue } });
  }
}

function submitForm(formEl: MiniElement) {
  const propsKey = Object.keys(formEl).find((k) => k.startsWith('__reactProps$'));
  const reactProps = propsKey ? (formEl as any)[propsKey] : null;
  const evt = new MiniEvent('submit', { bubbles: true, cancelable: true });
  if (reactProps?.onSubmit) {
    reactProps.onSubmit(evt);
  }
}

describe('Forgot Password & Reset Password Frontend Flows', () => {
  let container: MiniElement;
  let root: Root | null = null;

  beforeEach(() => {
    vi.restoreAllMocks();
    const dom = setupMiniDom();
    container = dom.container;
    root = createRoot(container as unknown as Element);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = null;
    }
    vi.restoreAllMocks();
  });

  const mockAuthValue: any = {
    user: null,
    isLoading: false,
    login: vi.fn(),
    register: vi.fn(),
    verifyEmail: vi.fn(),
    resendVerification: vi.fn(),
    refreshUser: vi.fn(),
    logout: vi.fn(),
    clearSessionState: vi.fn(),
  };

  it('1. Submits forgot-password request via API and shows non-enumerating confirmation and Back to Sign In action', async () => {
    const forgotSpy = vi.spyOn(api.auth, 'forgotPassword').mockResolvedValue({
      message: 'If an account with that email address exists, we have sent password reset instructions.',
      expiresInMinutes: 30,
    });

    await act(async () => {
      root!.render(
        <MemoryRouter initialEntries={['/login']}>
          <AuthContext.Provider value={mockAuthValue}>
            <AuthFormCard initialMode="login" />
          </AuthContext.Provider>
        </MemoryRouter>
      );
    });

    const forgotBtn = container.findAll(
      (el) => el.tagName === 'BUTTON' && el.textContent.includes('Forgot password?')
    )[0];
    expect(forgotBtn).toBeDefined();

    await act(async () => {
      forgotBtn.dispatchEvent(new MiniEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('Reset your password');

    const emailInput = container.findAll(
      (el) => el.tagName === 'INPUT' && el.id === 'auth-email'
    )[0];
    const form = container.findAll((el) => el.tagName === 'FORM')[0];

    await act(async () => {
      changeInput(emailInput, 'user.does.not.exist@outside.vip');
    });

    await act(async () => {
      submitForm(form);
    });
    await flushMicrotasks();

    expect(forgotSpy).toHaveBeenCalledWith({ email: 'user.does.not.exist@outside.vip' });
    expect(container.textContent).toContain('Password recovery instructions requested');
    expect(container.textContent).toContain(
      'If an account with that email address exists, we have sent password reset instructions.'
    );
    expect(container.textContent).not.toContain('user.does.not.exist@outside.vip');

    const backBtn = container.findAll(
      (el) => el.tagName === 'BUTTON' && el.textContent.includes('Back to Sign In')
    )[0];
    expect(backBtn).toBeDefined();

    await act(async () => {
      backBtn.dispatchEvent(new MiniEvent('click', { bubbles: true }));
    });
    expect(container.textContent).toContain('Sign in to your account');
  });

  it('2. Validates password length and confirmation mismatch on ResetPasswordPage before calling API', async () => {
    vi.spyOn(api.auth, 'validateResetToken').mockResolvedValue({
      valid: true,
      expiresInMinutes: 30,
    });
    const resetSpy = vi.spyOn(api.auth, 'resetPassword');

    await act(async () => {
      root!.render(
        <MemoryRouter initialEntries={['/reset-password?token=valid_token_abcdef_123456']}>
          <AuthContext.Provider value={mockAuthValue}>
            <Routes>
              <Route path="/reset-password" element={<ResetPasswordPage />} />
            </Routes>
          </AuthContext.Provider>
        </MemoryRouter>
      );
    });
    await flushMicrotasks();

    expect(container.textContent).toContain('Choose a new password');

    const newPwdInput = container.findAll(
      (el) => el.tagName === 'INPUT' && el.id === 'reset-new-password'
    )[0];
    const confirmPwdInput = container.findAll(
      (el) => el.tagName === 'INPUT' && el.id === 'reset-confirm-password'
    )[0];
    const form = container.findAll((el) => el.tagName === 'FORM')[0];

    // Short password
    await act(async () => {
      changeInput(newPwdInput, 'short');
      changeInput(confirmPwdInput, 'short');
    });
    await act(async () => {
      submitForm(form);
    });
    expect(container.textContent).toContain('Password must be at least 8 characters long.');
    expect(resetSpy).not.toHaveBeenCalled();

    // Mismatch confirmation
    await act(async () => {
      changeInput(newPwdInput, 'StrongPassword2026!');
      changeInput(confirmPwdInput, 'DifferentPassword2026!');
    });
    await act(async () => {
      submitForm(form);
    });
    expect(container.textContent).toContain('Passwords do not match.');
    expect(resetSpy).not.toHaveBeenCalled();
  });

  it('3. Completes password reset, clears stale session state, and navigates cleanly back to /login', async () => {
    vi.spyOn(api.auth, 'validateResetToken').mockResolvedValue({
      valid: true,
      expiresInMinutes: 30,
    });
    const resetSpy = vi.spyOn(api.auth, 'resetPassword').mockResolvedValue({
      message: 'Your password has been reset successfully. Please sign in with your new password.',
    });

    await act(async () => {
      root!.render(
        <MemoryRouter initialEntries={['/reset-password?token=reset_tok_valid_999999']}>
          <AuthContext.Provider value={mockAuthValue}>
            <Routes>
              <Route path="/reset-password" element={<ResetPasswordPage />} />
              <Route path="/login" element={<div>Login Route Target</div>} />
            </Routes>
          </AuthContext.Provider>
        </MemoryRouter>
      );
    });
    await flushMicrotasks();

    const newPwdInput = container.findAll(
      (el) => el.tagName === 'INPUT' && el.id === 'reset-new-password'
    )[0];
    const confirmPwdInput = container.findAll(
      (el) => el.tagName === 'INPUT' && el.id === 'reset-confirm-password'
    )[0];
    const form = container.findAll((el) => el.tagName === 'FORM')[0];

    await act(async () => {
      changeInput(newPwdInput, 'ValidResetPass2026!');
      changeInput(confirmPwdInput, 'ValidResetPass2026!');
    });
    await act(async () => {
      submitForm(form);
    });
    await flushMicrotasks();

    expect(resetSpy).toHaveBeenCalledWith({
      token: 'reset_tok_valid_999999',
      newPassword: 'ValidResetPass2026!',
      confirmPassword: 'ValidResetPass2026!',
    });
    expect(mockAuthValue.clearSessionState).toHaveBeenCalled();
    expect(container.textContent).toContain('Password reset complete');
    expect(container.textContent).toContain('Back to Sign In');

    const loginLink = container.findAll(
      (el) => el.tagName === 'A' && el.textContent.includes('Back to Sign In')
    )[0];
    expect(loginLink.getAttribute('href')).toBe('/login');

    await act(async () => {
      loginLink.dispatchEvent(new MiniEvent('click', { bubbles: true, cancelable: true }));
    });
    await flushMicrotasks();
    expect(container.textContent).toContain('Login Route Target');
  });

  it('4. Renders missing, expired, and invalid token states with links to /forgot-password and /login', async () => {
    // Missing token case
    await act(async () => {
      root!.render(
        <MemoryRouter initialEntries={['/reset-password']}>
          <AuthContext.Provider value={mockAuthValue}>
            <Routes>
              <Route path="/reset-password" element={<ResetPasswordPage />} />
            </Routes>
          </AuthContext.Provider>
        </MemoryRouter>
      );
    });
    await flushMicrotasks();

    expect(container.textContent).toContain('Invalid reset link');
    expect(container.textContent).toContain('Request New Reset Link');

    // Expired token case
    vi.spyOn(api.auth, 'validateResetToken').mockRejectedValueOnce(
      new ApiError(
        'This password reset link has expired. Please request a new one.',
        400,
        undefined,
        null,
        'RESET_TOKEN_EXPIRED'
      )
    );

    await act(async () => {
      root!.render(
        <MemoryRouter key="expired-route" initialEntries={['/reset-password?token=expired_token_12345']}>
          <AuthContext.Provider value={mockAuthValue}>
            <Routes>
              <Route path="/reset-password" element={<ResetPasswordPage />} />
            </Routes>
          </AuthContext.Provider>
        </MemoryRouter>
      );
    });
    await flushMicrotasks();

    expect(container.textContent).toContain('Reset link expired');
    expect(container.textContent).toContain(
      'This password reset link has expired. Please request a new one.'
    );
    const requestNewLink = container.findAll(
      (el) => el.tagName === 'A' && el.textContent.includes('Request New Reset Link')
    )[0];
    expect(requestNewLink.getAttribute('href')).toBe('/forgot-password');

    const backToLoginLink = container.findAll(
      (el) => el.tagName === 'A' && el.textContent.includes('Back to Sign In')
    )[0];
    expect(backToLoginLink.getAttribute('href')).toBe('/login');
  });
});
