import React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthContext } from '../src/context/AuthContext';
import { ThemeProvider, useTheme } from '../src/context/ThemeContext';
import { Navbar } from '../src/components/layout/Navbar';
import {
  THEME_STORAGE_KEY,
  applyThemeToDocument,
  parseThemePreference,
  resolveTheme,
} from '../src/lib/theme';
import { User } from '../src/types';

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

function matchesSimpleSelector(el: MiniElement, selector: string): boolean {
  const attrMatch = selector.match(/^([a-z0-9_-]*)\[([a-z0-9_-]+)(?:="([^"]*)")?\]$/i);
  if (attrMatch) {
    const [, tag, attr, val] = attrMatch;
    if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
    return val !== undefined ? el.getAttribute(attr) === val : el.hasAttribute(attr);
  }
  return el.tagName.toLowerCase() === selector.toLowerCase();
}

class MiniClassList {
  private el: MiniElement;
  constructor(el: MiniElement) {
    this.el = el;
  }
  private list(): string[] {
    return this.el.className
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  contains(token: string): boolean {
    return this.list().includes(token);
  }
  add(...tokens: string[]) {
    const next = new Set(this.list());
    tokens.forEach((t) => next.add(t));
    this.el.className = Array.from(next).join(' ');
  }
  remove(...tokens: string[]) {
    const next = this.list().filter((t) => !tokens.includes(t));
    this.el.className = next.join(' ');
  }
  toggle(token: string, force?: boolean): boolean {
    const shouldHave = force !== undefined ? force : !this.contains(token);
    if (shouldHave) {
      this.add(token);
    } else {
      this.remove(token);
    }
    return shouldHave;
  }
}

class MiniElement extends MiniNode {
  tagName: string;
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  classList: MiniClassList;
  private attrs = new Map<string, string>();

  constructor(tagName: string, ownerDocument: MiniDocument | null) {
    super(1, tagName.toUpperCase(), ownerDocument);
    this.tagName = tagName.toUpperCase();
    this.classList = new MiniClassList(this);
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

class MiniDocument extends MiniNode {
  head: MiniElement;
  body: MiniElement;
  documentElement: MiniElement;
  activeElement: MiniElement | null = null;
  defaultView: any = null;
  title = '';

  constructor() {
    super(9, '#document', null);
    this.ownerDocument = this;
    this.documentElement = new MiniElement('html', this);
    this.head = new MiniElement('head', this);
    this.body = new MiniElement('body', this);
    const meta = new MiniElement('meta', this);
    meta.setAttribute('name', 'theme-color');
    meta.setAttribute('content', '#FAF8F5');
    this.head.appendChild(meta);
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
    return new MiniTextNode(text, this);
  }
  createDocumentFragment() {
    return new MiniNode(11, '#document-fragment', this);
  }
  getElementById(id: string): MiniElement | null {
    return this.body.querySelector(`[id="${id}"]`);
  }
  querySelector(selector: string): MiniElement | null {
    return this.documentElement.querySelector(selector);
  }
}

function createMemoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
    removeItem(key: string) {
      map.delete(key);
    },
    clear() {
      map.clear();
    },
  };
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

const sampleAttendee: User = {
  id: 'user-attendee-1',
  name: 'Alex Attendee',
  email: 'alex@outside.vip',
  role: 'ATTENDEE',
  emailVerified: true,
  avatarUrl: null,
};

const ThemeInspector: React.FC = () => {
  const { preference, resolvedTheme, setTheme } = useTheme();
  return (
    <div>
      <span id="theme-pref">{preference}</span>
      <span id="theme-resolved">{resolvedTheme}</span>
      <button id="btn-set-light" type="button" onClick={() => setTheme('light')}>
        Light
      </button>
      <button id="btn-set-dark" type="button" onClick={() => setTheme('dark')}>
        Dark
      </button>
      <button id="btn-set-system" type="button" onClick={() => setTheme('system')}>
        System
      </button>
    </div>
  );
};

describe('Application Theme System (Light / Dark / System)', () => {
  let miniDoc: MiniDocument;
  let container: MiniElement;
  let root: Root | null = null;
  let queryClient: QueryClient;
  let storage: ReturnType<typeof createMemoryStorage>;
  let systemMatchesDark = false;
  let mediaListeners: Set<(event: { matches: boolean }) => void>;

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

  function emitSystemThemeChange(dark: boolean) {
    systemMatchesDark = dark;
    for (const listener of [...mediaListeners]) {
      listener({ matches: dark });
    }
  }

  beforeEach(() => {
    miniDoc = new MiniDocument();
    storage = createMemoryStorage();
    systemMatchesDark = false;
    mediaListeners = new Set();

    const miniWin: any = {
      document: miniDoc,
      localStorage: storage,
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
      matchMedia: vi.fn().mockImplementation((query: string) => ({
        matches: query === '(prefers-color-scheme: dark)' ? systemMatchesDark : false,
        media: query,
        addEventListener: (_type: string, fn: (e: { matches: boolean }) => void) => {
          mediaListeners.add(fn);
        },
        removeEventListener: (_type: string, fn: (e: { matches: boolean }) => void) => {
          mediaListeners.delete(fn);
        },
      })),
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

  afterEach(() => {
    if (root) {
      act(() => {
        root!.unmount();
      });
      root = null;
    }
    queryClient.clear();
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

  it('normalizes invalid stored values to system and resolves light/dark accurately', () => {
    expect(parseThemePreference(null)).toBe('system');
    expect(parseThemePreference('sepia')).toBe('system');
    expect(parseThemePreference('light')).toBe('light');
    expect(parseThemePreference('dark')).toBe('dark');
    expect(parseThemePreference('system')).toBe('system');

    expect(resolveTheme('light', 'dark')).toBe('light');
    expect(resolveTheme('dark', 'light')).toBe('dark');
    expect(resolveTheme('system', 'dark')).toBe('dark');
    expect(resolveTheme('system', 'light')).toBe('light');

    applyThemeToDocument('dark', miniDoc as unknown as Document);
    expect(miniDoc.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(miniDoc.documentElement.classList.contains('dark')).toBe(true);
    expect(miniDoc.documentElement.style.colorScheme).toBe('dark');
    expect(miniDoc.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
      '#0D0E12'
    );

    applyThemeToDocument('light', miniDoc as unknown as Document);
    expect(miniDoc.documentElement.getAttribute('data-theme')).toBe('light');
    expect(miniDoc.documentElement.classList.contains('dark')).toBe(false);
    expect(miniDoc.documentElement.style.colorScheme).toBe('light');
    expect(miniDoc.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
      '#FAF8F5'
    );
  });

  it('defaults to system preference without saved storage and follows OS color scheme initially', () => {
    systemMatchesDark = true;

    act(() => {
      root!.render(
        <ThemeProvider>
          <ThemeInspector />
        </ThemeProvider>
      );
    });

    expect(miniDoc.getElementById('theme-pref')?.textContent).toBe('system');
    expect(miniDoc.getElementById('theme-resolved')?.textContent).toBe('dark');
    expect(miniDoc.documentElement.classList.contains('dark')).toBe(true);
    expect(miniDoc.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(storage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it('tracks live OS prefers-color-scheme changes only when system is selected and stops when explicit light/dark is chosen', () => {
    systemMatchesDark = false;

    act(() => {
      root!.render(
        <ThemeProvider>
          <ThemeInspector />
        </ThemeProvider>
      );
    });

    expect(miniDoc.getElementById('theme-pref')?.textContent).toBe('system');
    expect(miniDoc.getElementById('theme-resolved')?.textContent).toBe('light');
    expect(mediaListeners.size).toBe(1);

    act(() => {
      emitSystemThemeChange(true);
    });

    expect(miniDoc.getElementById('theme-resolved')?.textContent).toBe('dark');
    expect(miniDoc.documentElement.classList.contains('dark')).toBe(true);

    // Choose explicit Light: must ignore future OS changes & detach listener
    act(() => {
      miniDoc.getElementById('btn-set-light')!.click();
    });

    expect(miniDoc.getElementById('theme-pref')?.textContent).toBe('light');
    expect(miniDoc.getElementById('theme-resolved')?.textContent).toBe('light');
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(mediaListeners.size).toBe(0);

    act(() => {
      emitSystemThemeChange(true);
    });

    expect(miniDoc.getElementById('theme-resolved')?.textContent).toBe('light');
    expect(miniDoc.documentElement.classList.contains('dark')).toBe(false);

    // Switch back to System: picks up current OS dark state & re-subscribes
    act(() => {
      miniDoc.getElementById('btn-set-system')!.click();
    });

    expect(miniDoc.getElementById('theme-pref')?.textContent).toBe('system');
    expect(miniDoc.getElementById('theme-resolved')?.textContent).toBe('dark');
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('system');
    expect(mediaListeners.size).toBe(1);
  });

  it('persists explicit selection across remounts', () => {
    act(() => {
      root!.render(
        <ThemeProvider>
          <ThemeInspector />
        </ThemeProvider>
      );
    });

    act(() => {
      miniDoc.getElementById('btn-set-dark')!.click();
    });

    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(miniDoc.documentElement.classList.contains('dark')).toBe(true);

    // Simulate reload by unmounting root & mounting a fresh ThemeProvider
    act(() => {
      root!.unmount();
    });

    const freshContainer = miniDoc.createElement('div');
    miniDoc.body.appendChild(freshContainer);
    root = createRoot(freshContainer as unknown as Element);

    act(() => {
      root!.render(
        <ThemeProvider>
          <ThemeInspector />
        </ThemeProvider>
      );
    });

    expect(miniDoc.getElementById('theme-pref')?.textContent).toBe('dark');
    expect(miniDoc.getElementById('theme-resolved')?.textContent).toBe('dark');
    expect(miniDoc.documentElement.classList.contains('dark')).toBe(true);
  });

  it('renders desktop theme selector beside profile control with Light/Dark/System options, dismissal, and keeps profile menu limited to identity + Sign out', () => {
    const authValue = createAuthMock(sampleAttendee);

    const RouteNavigator: React.FC = () => {
      const navigate = useNavigate();
      return (
        <button id="test-nav-events" type="button" onClick={() => navigate('/events')}>
          Go Events
        </button>
      );
    };

    act(() => {
      root!.render(
        <ThemeProvider>
          <QueryClientProvider client={queryClient}>
            <AuthContext.Provider value={authValue}>
              <MemoryRouter initialEntries={['/']}>
                <Navbar />
                <Routes>
                  <Route path="*" element={<RouteNavigator />} />
                </Routes>
              </MemoryRouter>
            </AuthContext.Provider>
          </QueryClientProvider>
        </ThemeProvider>
      );
    });

    const themeTrigger = miniDoc.body.querySelector('button[aria-controls="theme-dropdown-menu"]');
    expect(themeTrigger).not.toBeNull();
    expect(themeTrigger!.getAttribute('aria-expanded')).toBe('false');

    // Open desktop theme menu
    act(() => {
      themeTrigger!.click();
    });
    expect(themeTrigger!.getAttribute('aria-expanded')).toBe('true');

    const themeMenu = miniDoc.getElementById('theme-dropdown-menu');
    expect(themeMenu).not.toBeNull();

    const radioOptions = themeMenu!.querySelectorAll('button[role="menuitemradio"]');
    expect(radioOptions.map((o) => o.textContent.trim())).toEqual(['Light', 'Dark', 'System']);
    expect(radioOptions[2].getAttribute('aria-checked')).toBe('true');

    // Selecting Dark updates theme & closes menu immediately
    act(() => {
      radioOptions[1].click();
    });
    expect(miniDoc.getElementById('theme-dropdown-menu')).toBeNull();
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(miniDoc.documentElement.classList.contains('dark')).toBe(true);

    // Reopen and verify Escape closes menu and restores focus
    act(() => {
      themeTrigger!.click();
    });
    expect(miniDoc.getElementById('theme-dropdown-menu')).not.toBeNull();

    act(() => {
      miniDoc.dispatchEvent(new MiniEvent('keydown', { key: 'Escape' }));
    });
    expect(miniDoc.getElementById('theme-dropdown-menu')).toBeNull();
    expect(miniDoc.activeElement).toBe(themeTrigger);

    // Reopen and verify outside pointer interaction closes menu
    act(() => {
      themeTrigger!.click();
    });
    expect(miniDoc.getElementById('theme-dropdown-menu')).not.toBeNull();

    act(() => {
      miniDoc.body.dispatchEvent(new MiniEvent('mousedown', { bubbles: true }));
    });
    expect(miniDoc.getElementById('theme-dropdown-menu')).toBeNull();

    // Reopen and verify route navigation closes menu
    act(() => {
      themeTrigger!.click();
    });
    expect(miniDoc.getElementById('theme-dropdown-menu')).not.toBeNull();

    act(() => {
      miniDoc.getElementById('test-nav-events')!.click();
    });
    expect(miniDoc.getElementById('theme-dropdown-menu')).toBeNull();

    // Verify profile dropdown contains ONLY user identity + Sign out (no theme options)
    const accountTrigger = miniDoc.body.querySelector('button[aria-controls="account-dropdown-menu"]');
    expect(accountTrigger).not.toBeNull();
    act(() => {
      accountTrigger!.click();
    });
    const accountMenu = miniDoc.getElementById('account-dropdown-menu');
    expect(accountMenu).not.toBeNull();
    expect(accountMenu!.textContent).toContain('Signed in as');
    expect(accountMenu!.textContent).toContain(sampleAttendee.name);
    expect(accountMenu!.textContent).toContain(sampleAttendee.email);
    expect(accountMenu!.textContent).toContain('Sign out');
    expect(accountMenu!.textContent).not.toContain('System');
    expect(accountMenu!.textContent).not.toContain('Light');
    expect(accountMenu!.textContent).not.toContain('Dark');
  });

  it('provides Light/Dark/System selector inside the mobile hamburger drawer without altering navigation structure', () => {
    const authValue = createAuthMock(sampleAttendee);

    act(() => {
      root!.render(
        <ThemeProvider>
          <QueryClientProvider client={queryClient}>
            <AuthContext.Provider value={authValue}>
              <MemoryRouter initialEntries={['/events']}>
                <Navbar />
              </MemoryRouter>
            </AuthContext.Provider>
          </QueryClientProvider>
        </ThemeProvider>
      );
    });

    const mobileToggle = miniDoc.body.querySelector(
      'button[aria-controls="mobile-navigation-drawer"]'
    );
    expect(mobileToggle).not.toBeNull();

    act(() => {
      mobileToggle!.click();
    });

    const mobileDrawer = miniDoc.getElementById('mobile-navigation-drawer');
    expect(mobileDrawer).not.toBeNull();
    expect(mobileDrawer!.textContent).toContain('Home');
    expect(mobileDrawer!.textContent).toContain('Discover');
    expect(mobileDrawer!.textContent).toContain('Appearance');
    expect(mobileDrawer!.textContent).toContain('Sign out');

    const group = mobileDrawer!.querySelector('div[aria-label="Appearance"]');
    expect(group).not.toBeNull();

    const mobileButtons = group!.querySelectorAll('button');
    expect(mobileButtons.map((b) => b.textContent.trim())).toEqual(['Light', 'Dark', 'System']);
    expect(mobileButtons[2].getAttribute('aria-pressed')).toBe('true');

    // Switch to Dark from mobile drawer
    act(() => {
      mobileButtons[1].click();
    });
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(miniDoc.documentElement.classList.contains('dark')).toBe(true);
    expect(mobileButtons[1].getAttribute('aria-pressed')).toBe('true');
    expect(mobileButtons[2].getAttribute('aria-pressed')).toBe('false');

    // Switch to Light from mobile drawer
    act(() => {
      mobileButtons[0].click();
    });
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(miniDoc.documentElement.classList.contains('dark')).toBe(false);
    expect(mobileButtons[0].getAttribute('aria-pressed')).toBe('true');
  });
});
