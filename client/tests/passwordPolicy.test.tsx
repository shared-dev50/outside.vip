import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthContext } from '../src/context/AuthContext';
import { AuthFormCard } from '../src/components/auth/AuthFormCard';
import { ResetPasswordPage } from '../src/pages/ResetPasswordPage';
import { api } from '../src/lib/api';
import {
  PASSWORD_ACCEPTED_SPECIAL_CHARS,
  evaluatePasswordPolicy,
} from '../src/lib/passwordPolicy';

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

describe('Frontend Password Policy Validation & Hints', () => {
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

  it('1. Frontend passwordPolicy evaluates all 4 requirements and accepted special characters identically', () => {
    expect(evaluatePasswordPolicy('Ab1!efgh').valid).toBe(true);
    expect(evaluatePasswordPolicy('short').firstError).toBe(
      'Password must be at least 8 characters long.'
    );
    expect(evaluatePasswordPolicy('lowercase1!').firstError).toContain('uppercase letter');
    expect(evaluatePasswordPolicy('NoDigitsHere!').firstError).toContain('one number');
    expect(evaluatePasswordPolicy('NoSpecial123').firstError).toContain('special character');

    for (const sym of PASSWORD_ACCEPTED_SPECIAL_CHARS) {
      expect(evaluatePasswordPolicy(`Strong1${sym}`).valid).toBe(true);
    }
  });

  it('2. Registration shows password requirements upfront, blocks weak passwords, and accepts compliant passwords', async () => {
    await act(async () => {
      root!.render(
        <MemoryRouter initialEntries={['/register']}>
          <AuthContext.Provider value={mockAuthValue}>
            <AuthFormCard initialMode="register" />
          </AuthContext.Provider>
        </MemoryRouter>
      );
    });

    // Requirements hint displayed before submitting
    expect(container.textContent).toContain('Password requirements');
    expect(container.textContent).toContain('At least 8 characters');
    expect(container.textContent).toContain('At least 1 uppercase letter (A-Z)');
    expect(container.textContent).toContain('At least 1 number (0-9)');
    expect(container.textContent).toContain('At least 1 special character');

    const nameInput = container.findAll((el) => el.tagName === 'INPUT' && el.id === 'auth-name')[0];
    const emailInput = container.findAll((el) => el.tagName === 'INPUT' && el.id === 'auth-email')[0];
    const passwordInput = container.findAll(
      (el) => el.tagName === 'INPUT' && el.id === 'auth-password'
    )[0];
    const form = container.findAll((el) => el.tagName === 'FORM')[0];

    await act(async () => {
      changeInput(nameInput, 'Alex Policy');
      changeInput(emailInput, 'alex@outside.vip');
    });

    const invalidCases = [
      { value: 'Ab1!', expected: 'at least 8 characters' },
      { value: 'alllowercase1!', expected: 'uppercase letter' },
      { value: 'NoNumberHere!', expected: 'one number' },
      { value: 'NoSpecial123', expected: 'special character' },
    ];

    for (const c of invalidCases) {
      await act(async () => {
        changeInput(passwordInput, c.value);
      });
      await act(async () => {
        submitForm(form);
      });
      expect(container.textContent.toLowerCase()).toContain(c.expected);
      expect(mockAuthValue.register).not.toHaveBeenCalled();
    }

    await act(async () => {
      changeInput(passwordInput, 'CompliantPass1!');
    });
    await act(async () => {
      submitForm(form);
    });
    await flushMicrotasks();

    expect(mockAuthValue.register).toHaveBeenCalledWith({
      name: 'Alex Policy',
      email: 'alex@outside.vip',
      password: 'CompliantPass1!',
    });
  });

  it('3. Login does NOT show composition checklist or reject existing users with legacy passwords', async () => {
    await act(async () => {
      root!.render(
        <MemoryRouter initialEntries={['/login']}>
          <AuthContext.Provider value={mockAuthValue}>
            <AuthFormCard initialMode="login" />
          </AuthContext.Provider>
        </MemoryRouter>
      );
    });

    expect(container.textContent).not.toContain('Password requirements');

    const emailInput = container.findAll((el) => el.tagName === 'INPUT' && el.id === 'auth-email')[0];
    const passwordInput = container.findAll(
      (el) => el.tagName === 'INPUT' && el.id === 'auth-password'
    )[0];
    const form = container.findAll((el) => el.tagName === 'FORM')[0];

    expect(passwordInput.getAttribute('minLength')).toBe('1');

    await act(async () => {
      changeInput(emailInput, 'legacy@outside.vip');
      changeInput(passwordInput, 'legacy');
    });
    await act(async () => {
      submitForm(form);
    });
    await flushMicrotasks();

    expect(mockAuthValue.login).toHaveBeenCalledWith('legacy@outside.vip', 'legacy');
  });

  it('4. ResetPasswordPage shows requirements upfront and rejects missing uppercase/number/special/length before submit', async () => {
    vi.spyOn(api.auth, 'validateResetToken').mockResolvedValue({
      valid: true,
      expiresInMinutes: 30,
    });
    const resetSpy = vi.spyOn(api.auth, 'resetPassword').mockResolvedValue({
      message: 'Your password has been reset successfully.',
    });

    await act(async () => {
      root!.render(
        <MemoryRouter initialEntries={['/reset-password?token=reset_tok_valid_12345']}>
          <AuthContext.Provider value={mockAuthValue}>
            <Routes>
              <Route path="/reset-password" element={<ResetPasswordPage />} />
            </Routes>
          </AuthContext.Provider>
        </MemoryRouter>
      );
    });
    await flushMicrotasks();

    expect(container.textContent).toContain('Password requirements');
    expect(container.textContent).toContain('At least 8 characters');
    expect(container.textContent).toContain('At least 1 uppercase letter (A-Z)');
    expect(container.textContent).toContain('At least 1 number (0-9)');
    expect(container.textContent).toContain('At least 1 special character');

    const newPwdInput = container.findAll(
      (el) => el.tagName === 'INPUT' && el.id === 'reset-new-password'
    )[0];
    const confirmPwdInput = container.findAll(
      (el) => el.tagName === 'INPUT' && el.id === 'reset-confirm-password'
    )[0];
    const form = container.findAll((el) => el.tagName === 'FORM')[0];

    const invalidResets = [
      { value: 'Ab1!', expected: 'at least 8 characters' },
      { value: 'alllowercase1!', expected: 'uppercase letter' },
      { value: 'NoNumberPass!', expected: 'one number' },
      { value: 'NoSpecial123', expected: 'special character' },
    ];

    for (const c of invalidResets) {
      await act(async () => {
        changeInput(newPwdInput, c.value);
        changeInput(confirmPwdInput, c.value);
      });
      await act(async () => {
        submitForm(form);
      });
      expect(container.textContent.toLowerCase()).toContain(c.expected);
      expect(resetSpy).not.toHaveBeenCalled();
    }

    await act(async () => {
      changeInput(newPwdInput, 'StrongReset2026!');
      changeInput(confirmPwdInput, 'StrongReset2026!');
    });
    await act(async () => {
      submitForm(form);
    });
    await flushMicrotasks();

    expect(resetSpy).toHaveBeenCalledWith({
      token: 'reset_tok_valid_12345',
      newPassword: 'StrongReset2026!',
      confirmPassword: 'StrongReset2026!',
    });
  });
});
