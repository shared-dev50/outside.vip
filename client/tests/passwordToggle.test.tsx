import React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PasswordInput } from '../src/components/common/PasswordInput';
import { AuthContext } from '../src/context/AuthContext';
import { AuthFormCard } from '../src/components/auth/AuthFormCard';
import { ResetPasswordPage } from '../src/pages/ResetPasswordPage';
import { api } from '../src/lib/api';

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
    this.childNodes = [];
    if (val && this.ownerDocument) {
      this.appendChild(new MiniTextNode(String(val), this.ownerDocument));
    }
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
  click() {
    this.dispatchEvent(new MiniEvent('click', { bubbles: true, cancelable: true }));
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

async function flushMicrotasks(ticks = 6) {
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

describe('PasswordInput Show/Hide Toggle & Form Integration', () => {
  let root: Root | null = null;
  let container: MiniElement;
  let mockAuthValue: any;

  beforeEach(() => {
    vi.restoreAllMocks();
    const dom = setupMiniDom();
    container = dom.container;
    root = createRoot(container as unknown as Element);

    mockAuthValue = {
      user: null,
      isLoading: false,
      login: vi.fn().mockResolvedValue(undefined),
      requestLoginOtp: vi.fn().mockResolvedValue({ message: 'Sent', cooldownSeconds: 60 }),
      verifyLoginOtp: vi.fn().mockResolvedValue(undefined),
      clearSessionState: vi.fn(),
      register: vi.fn().mockResolvedValue(undefined),
      verifyEmail: vi.fn().mockResolvedValue(undefined),
      resendVerification: vi.fn().mockResolvedValue(undefined),
      refreshUser: vi.fn().mockResolvedValue(null),
      logout: vi.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root!.unmount();
      });
      root = null;
    }
    vi.restoreAllMocks();
  });

  it('1. PasswordInput starts masked, toggles visibility with accessible labels, preserves value & autocomplete, and does not submit forms', async () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());

    const Harness: React.FC = () => {
      const [val, setVal] = React.useState('Secret123!');
      return (
        <form onSubmit={onSubmit}>
          <PasswordInput
            id="test-password"
            name="password"
            autoComplete="current-password"
            value={val}
            onChange={(e) => setVal(e.target.value)}
            className="w-full px-3.5 py-2.5"
          />
          <button type="submit">Submit</button>
        </form>
      );
    };

    await act(async () => {
      root!.render(<Harness />);
    });

    const input = container.findAll((el) => el.tagName === 'INPUT' && el.id === 'test-password')[0];
    const toggleBtn = container.findAll(
      (el) => el.tagName === 'BUTTON' && el.getAttribute('aria-label') === 'Show password'
    )[0];

    expect(input).toBeDefined();
    expect(input.getAttribute('type')).toBe('password');
    expect(input.getAttribute('autoComplete')).toBe('current-password');
    expect(toggleBtn).toBeDefined();
    expect(toggleBtn.getAttribute('type')).toBe('button');
    expect(toggleBtn.getAttribute('aria-pressed')).toBe('false');

    // Reveal password
    await act(async () => {
      toggleBtn.click();
    });

    expect(input.getAttribute('type')).toBe('text');
    expect(toggleBtn.getAttribute('aria-label')).toBe('Hide password');
    expect(toggleBtn.getAttribute('aria-pressed')).toBe('true');
    expect(onSubmit).not.toHaveBeenCalled();

    // Hide password again
    await act(async () => {
      toggleBtn.click();
    });

    expect(input.getAttribute('type')).toBe('password');
    expect(toggleBtn.getAttribute('aria-label')).toBe('Show password');
    expect(toggleBtn.getAttribute('aria-pressed')).toBe('false');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('2. AuthFormCard (login & register) toggles visibility cleanly without submitting and preserves validation & submission', async () => {
    await act(async () => {
      root!.render(
        <MemoryRouter initialEntries={['/register']}>
          <AuthContext.Provider value={mockAuthValue}>
            <AuthFormCard initialMode="register" />
          </AuthContext.Provider>
        </MemoryRouter>
      );
    });

    const nameInput = container.findAll((el) => el.tagName === 'INPUT' && el.id === 'auth-name')[0];
    const emailInput = container.findAll((el) => el.tagName === 'INPUT' && el.id === 'auth-email')[0];
    const passwordInput = container.findAll(
      (el) => el.tagName === 'INPUT' && el.id === 'auth-password'
    )[0];
    const toggleBtn = container.findAll(
      (el) => el.tagName === 'BUTTON' && el.getAttribute('aria-label') === 'Show password'
    )[0];
    const form = container.findAll((el) => el.tagName === 'FORM')[0];

    expect(passwordInput.getAttribute('type')).toBe('password');
    expect(toggleBtn.getAttribute('type')).toBe('button');

    await act(async () => {
      changeInput(nameInput, 'Toggle Tester');
      changeInput(emailInput, 'toggle@outside.vip');
      changeInput(passwordInput, 'weakonly');
      toggleBtn.click();
    });

    // Revealed, not submitted
    expect(passwordInput.getAttribute('type')).toBe('text');
    expect(toggleBtn.getAttribute('aria-label')).toBe('Hide password');
    expect(mockAuthValue.register).not.toHaveBeenCalled();

    // Existing validation still blocks weak password
    await act(async () => {
      submitForm(form);
    });
    expect(container.textContent).toContain('Password must include at least one uppercase letter');
    expect(mockAuthValue.register).not.toHaveBeenCalled();

    // Valid submission works regardless of toggle state
    await act(async () => {
      changeInput(passwordInput, 'StrongToggle2026!');
    });
    await act(async () => {
      submitForm(form);
    });
    await flushMicrotasks();

    expect(mockAuthValue.register).toHaveBeenCalledWith({
      name: 'Toggle Tester',
      email: 'toggle@outside.vip',
      password: 'StrongToggle2026!',
    });
  });

  it('3. ResetPasswordPage toggles New Password and Confirm New Password independently without submitting', async () => {
    vi.spyOn(api.auth, 'validateResetToken').mockResolvedValue({
      valid: true,
      expiresInMinutes: 30,
    });
    const resetSpy = vi.spyOn(api.auth, 'resetPassword').mockResolvedValue({
      message: 'Your password has been reset successfully.',
    });

    await act(async () => {
      root!.render(
        <MemoryRouter initialEntries={['/reset-password?token=reset_tok_toggle_999']}>
          <AuthContext.Provider value={mockAuthValue}>
            <Routes>
              <Route path="/reset-password" element={<ResetPasswordPage />} />
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
    const toggles = container.findAll(
      (el) => el.tagName === 'BUTTON' && el.getAttribute('aria-label') === 'Show password'
    );
    const form = container.findAll((el) => el.tagName === 'FORM')[0];

    expect(toggles).toHaveLength(2);
    const [newToggle, confirmToggle] = toggles;

    expect(newPwdInput.getAttribute('type')).toBe('password');
    expect(confirmPwdInput.getAttribute('type')).toBe('password');

    // Toggle first field only: second must remain masked
    await act(async () => {
      newToggle.click();
    });
    expect(newPwdInput.getAttribute('type')).toBe('text');
    expect(newToggle.getAttribute('aria-label')).toBe('Hide password');
    expect(confirmPwdInput.getAttribute('type')).toBe('password');
    expect(confirmToggle.getAttribute('aria-label')).toBe('Show password');
    expect(resetSpy).not.toHaveBeenCalled();

    // Toggle second field on, then mask first field: independent states preserved
    await act(async () => {
      confirmToggle.click();
      newToggle.click();
    });
    expect(newPwdInput.getAttribute('type')).toBe('password');
    expect(newToggle.getAttribute('aria-label')).toBe('Show password');
    expect(confirmPwdInput.getAttribute('type')).toBe('text');
    expect(confirmToggle.getAttribute('aria-label')).toBe('Hide password');
    expect(resetSpy).not.toHaveBeenCalled();

    // Existing submission works
    await act(async () => {
      changeInput(newPwdInput, 'StrongReset2026!');
      changeInput(confirmPwdInput, 'StrongReset2026!');
    });
    await act(async () => {
      submitForm(form);
    });
    await flushMicrotasks();

    expect(resetSpy).toHaveBeenCalledWith({
      token: 'reset_tok_toggle_999',
      newPassword: 'StrongReset2026!',
      confirmPassword: 'StrongReset2026!',
    });
  });
});
