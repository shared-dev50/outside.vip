import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventCoverImage, DEFAULT_COVER_FALLBACK } from '../src/components/events/EventCoverImage';
import { EventCard } from '../src/components/events/EventCard';
import { PosterCard } from '../src/components/home/PosterCard';
import { ImageCropModal } from '../src/components/events/ImageCropModal';
import { PRESET_COVERS } from '../src/pages/CreateEventPage';
import { Event } from '../src/types';

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
  dispatchEvent(event: any): boolean {
    if (!event.target) event.target = this;
    let cur: MiniNode | null = this;
    while (cur) {
      event.currentTarget = cur;
      const listeners = cur.listeners.get(event.type) ?? [];
      for (const fn of [...listeners]) {
        fn.call(cur, event);
      }
      if (!event.bubbles || event.propagationStopped) break;
      cur = cur.parentNode;
    }
    return !event.defaultPrevented;
  }
}

class MiniTextNode extends MiniNode {
  data: string;
  constructor(text: string, doc: MiniDocument) {
    super(3, '#text', doc);
    this.data = text;
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
  naturalWidth = 0;
  naturalHeight = 0;
  complete = false;
  width = 300;
  height = 200;
  clientWidth = 600;
  clientHeight = 400;

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
  get src(): string {
    return this.attributes.get('src') ?? '';
  }
  set src(val: string) {
    this.attributes.set('src', String(val));
  }
  get id(): string {
    return this.attributes.get('id') ?? '';
  }
  set id(val: string) {
    this.attributes.set('id', val);
  }
  toBlob(callback: (blob: Blob | null) => void, mimeType?: string) {
    callback(new Blob(['cropped-image-data'], { type: mimeType || 'image/webp' }));
  }
  getContext() {
    return {
      save: vi.fn(),
      restore: vi.fn(),
      scale: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      drawImage: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'high',
      fillStyle: '#000',
      strokeStyle: '#fff',
      lineWidth: 1,
    };
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
    return { top: 0, left: 0, bottom: 0, right: 0, width: 600, height: 400 };
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
  createdCanvases: MiniElement[] = [];
  constructor() {
    super(9, '#document', null);
    this.documentElement = new MiniElement('html', this);
    this.body = new MiniElement('body', this);
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
  }
  createElement(tag: string) {
    const el = new MiniElement(tag, this);
    if (tag.toLowerCase() === 'canvas') {
      this.createdCanvases.push(el);
    }
    return el;
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
  const createdImages: any[] = [];

  class MockImage {
    src = '';
    naturalWidth = 1080;
    naturalHeight = 1350;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      createdImages.push(this);
    }
  }

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
    Image: MockImage,
    URL: {
      createObjectURL: vi.fn(() => 'blob:mock-cover-preview'),
      revokeObjectURL: vi.fn(),
    },
    location: { origin: 'https://outside.vip', href: 'https://outside.vip/', pathname: '/', search: '', hash: '' },
    history: { state: {}, replaceState: vi.fn(), pushState: vi.fn() },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  doc.defaultView = win;
  return { doc, win, createdImages };
}

const baseEvent: Event = {
  id: 'evt-portrait-1',
  slug: 'late-night-poster-session',
  organizerId: 'org-1',
  organizer: { id: 'org-1', name: 'Collective Studio', avatarUrl: null },
  title: 'Late Night Poster Session',
  tagline: 'Architectural sound & print showcase',
  description: 'Curated electronic music and poster art.',
  category: 'ARTS_CULTURE',
  status: 'PUBLISHED',
  coverImageUrl: 'https://res.cloudinary.com/demo/image/upload/v1/poster-4x5.webp',
  venueName: 'Studio 9',
  venueAddress: '9 Foundry Ln',
  city: 'Nairobi',
  country: 'Kenya',
  startAt: '2026-12-10T19:00:00.000Z',
  endAt: '2026-12-11T01:00:00.000Z',
  timezone: 'Africa/Nairobi',
  isSoldOut: false,
  isFeatured: true,
  minPriceInCents: 2000,
  currency: 'USD',
  ticketTiers: [],
};

describe('Portrait-First Artwork Architecture', () => {
  const originalGlobals: Record<string, any> = {};
  let doc: MiniDocument;
  let createdImages: any[];
  let container: MiniElement;
  let root: Root;

  beforeEach(() => {
    const dom = setupMiniDom();
    doc = dom.doc;
    createdImages = dom.createdImages;
    const keys = [
      'window',
      'document',
      'Node',
      'Element',
      'HTMLElement',
      'HTMLInputElement',
      'HTMLTextAreaElement',
      'HTMLSelectElement',
      'HTMLIFrameElement',
      'ShadowRoot',
      'SVGElement',
      'Event',
      'MouseEvent',
      'CustomEvent',
      'Image',
      'IS_REACT_ACT_ENVIRONMENT',
    ];
    for (const k of keys) {
      originalGlobals[k] = (globalThis as any)[k];
    }
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    (globalThis as any).window = dom.win;
    (globalThis as any).document = doc;
    (globalThis as any).Node = dom.win.Node;
    (globalThis as any).Element = dom.win.Element;
    (globalThis as any).HTMLElement = dom.win.HTMLElement;
    (globalThis as any).HTMLInputElement = dom.win.HTMLInputElement;
    (globalThis as any).HTMLTextAreaElement = dom.win.HTMLTextAreaElement;
    (globalThis as any).HTMLSelectElement = dom.win.HTMLSelectElement;
    (globalThis as any).HTMLIFrameElement = dom.win.HTMLIFrameElement;
    (globalThis as any).ShadowRoot = dom.win.ShadowRoot;
    (globalThis as any).SVGElement = dom.win.SVGElement;
    (globalThis as any).Event = dom.win.Event;
    (globalThis as any).MouseEvent = dom.win.MouseEvent;
    (globalThis as any).CustomEvent = dom.win.CustomEvent;
    (globalThis as any).Image = dom.win.Image;
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-cover-preview');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    container = doc.createElement('div');
    doc.body.appendChild(container);
    root = createRoot(container as any);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    vi.restoreAllMocks();
    for (const [k, v] of Object.entries(originalGlobals)) {
      if (v === undefined) {
        delete (globalThis as any)[k];
      } else {
        (globalThis as any)[k] = v;
      }
    }
  });

  it('Home PosterCard and Discover EventCard consistently use 4:5 cards, preserve landscape/square/other-portrait artwork uncropped, and render no blurred side fillers', () => {
    act(() => {
      root.render(
        <MemoryRouter>
          <div>
            <div id="home-wrap">
              <PosterCard event={baseEvent} />
            </div>
            <div id="discover-wrap">
              <EventCard event={baseEvent} />
            </div>
          </div>
        </MemoryRouter>
      );
    });

    const homeWrap = container.findAll((el) => el.id === 'home-wrap')[0];
    const discoverWrap = container.findAll((el) => el.id === 'discover-wrap')[0];
    const homeImg = homeWrap.findAll((el) => el.tagName === 'IMG')[0];
    const discoverImg = discoverWrap.findAll((el) => el.tagName === 'IMG')[0];
    const homeFrame = homeImg.parentNode as MiniElement;
    const discoverFrame = discoverImg.parentNode as MiniElement;

    // Both Home and Discover use 4:5 portrait cards (not old 3:4 or 16:10)
    expect(homeFrame.className).toContain('aspect-[4/5]');
    expect(homeFrame.className).not.toContain('aspect-[3/4]');
    expect(discoverFrame.className).toContain('aspect-[4/5]');
    expect(discoverFrame.className).not.toContain('aspect-[16/10]');

    // 4:5 portrait fills edge-to-edge with object-cover and NO ambient background layer
    act(() => {
      homeImg.naturalWidth = 1080;
      homeImg.naturalHeight = 1350;
      homeImg.dispatchEvent(new MiniEvent('load', { bubbles: false }));

      discoverImg.naturalWidth = 1080;
      discoverImg.naturalHeight = 1350;
      discoverImg.dispatchEvent(new MiniEvent('load', { bubbles: false }));
    });
    expect(homeWrap.findAll((el) => el.tagName === 'IMG')).toHaveLength(1);
    expect(discoverWrap.findAll((el) => el.tagName === 'IMG')).toHaveLength(1);
    expect(homeImg.className).toContain('object-cover');
    expect(discoverImg.className).toContain('object-cover');

    // Close portrait ratio (3:4) stays uncropped via object-contain without ambient clutter
    act(() => {
      homeImg.naturalWidth = 1200;
      homeImg.naturalHeight = 1600;
      homeImg.dispatchEvent(new MiniEvent('load', { bubbles: false }));

      discoverImg.naturalWidth = 1200;
      discoverImg.naturalHeight = 1600;
      discoverImg.dispatchEvent(new MiniEvent('load', { bubbles: false }));
    });
    expect(homeImg.className).toContain('object-contain');
    expect(discoverImg.className).toContain('object-contain');
    expect(homeWrap.findAll((el) => el.tagName === 'IMG')).toHaveLength(1);
    expect(discoverWrap.findAll((el) => el.tagName === 'IMG')).toHaveLength(1);

    // Significantly mismatched landscape artwork gets subtle blurred/darkened ambient backdrop
    // clipped to 4:5 while foreground remains uncropped object-contain and single-source cached
    act(() => {
      homeImg.naturalWidth = 1920;
      homeImg.naturalHeight = 1080;
      homeImg.dispatchEvent(new MiniEvent('load', { bubbles: false }));

      discoverImg.naturalWidth = 1920;
      discoverImg.naturalHeight = 1080;
      discoverImg.dispatchEvent(new MiniEvent('load', { bubbles: false }));
    });
    const homeImgsLandscape = homeWrap.findAll((el) => el.tagName === 'IMG');
    const discoverImgsLandscape = discoverWrap.findAll((el) => el.tagName === 'IMG');
    expect(homeImgsLandscape).toHaveLength(2);
    expect(discoverImgsLandscape).toHaveLength(2);
    const homeBg = homeImgsLandscape.find((el) => el.getAttribute('aria-hidden') === 'true');
    const discoverBg = discoverImgsLandscape.find((el) => el.getAttribute('aria-hidden') === 'true');
    expect(homeBg?.src).toBe(baseEvent.coverImageUrl);
    expect(homeBg?.className).toContain('blur-xl');
    expect(homeBg?.className).toContain('brightness-50');
    expect(discoverBg?.src).toBe(baseEvent.coverImageUrl);
    expect(discoverBg?.className).toContain('blur-xl');
    expect(discoverBg?.className).toContain('brightness-50');
    expect(homeImg.className).toContain('object-contain');
    expect(discoverImg.className).toContain('object-contain');

    // Square (1:1) and narrow tall vertical (2:3) also use object-contain + ambient backdrop consistently
    act(() => {
      homeImg.naturalWidth = 1000;
      homeImg.naturalHeight = 1000;
      homeImg.dispatchEvent(new MiniEvent('load', { bubbles: false }));

      discoverImg.naturalWidth = 1000;
      discoverImg.naturalHeight = 1500;
      discoverImg.dispatchEvent(new MiniEvent('load', { bubbles: false }));
    });
    expect(homeImg.className).toContain('object-contain');
    expect(discoverImg.className).toContain('object-contain');
    expect(homeWrap.findAll((el) => el.tagName === 'IMG')).toHaveLength(2);
    expect(discoverWrap.findAll((el) => el.tagName === 'IMG')).toHaveLength(2);

    // Fallback handling preserved
    act(() => {
      discoverImg.dispatchEvent(new MiniEvent('error', { bubbles: false }));
    });
    expect(discoverImg.src).toBe(DEFAULT_COVER_FALLBACK);
  });

  it('EventCoverImage natural mode preserves portrait, landscape, and square ratios with a single image and zero blurred side fillers', () => {
    act(() => {
      root.render(
        <EventCoverImage
          src={baseEvent.coverImageUrl}
          alt={baseEvent.title}
          mode="natural"
          containerClassName="rounded-lg border border-gray-200 bg-stone-100"
        />
      );
    });

    const wrapper = container.childNodes[0] as MiniElement;
    const img = container.findAll((el) => el.tagName === 'IMG')[0];

    // Portrait 2:3 sets exact natural aspect ratio and proportional maxWidth
    act(() => {
      img.naturalWidth = 1200;
      img.naturalHeight = 1800;
      img.dispatchEvent(new MiniEvent('load', { bubbles: false }));
    });
    expect(container.findAll((el) => el.tagName === 'IMG')).toHaveLength(1);
    expect(wrapper.style.aspectRatio).toBe('1200 / 1800');
    expect(wrapper.style.maxWidth).toContain('min(100%,');
    expect(wrapper.className).not.toContain('aspect-[16/10]');
    expect(wrapper.className).not.toContain('aspect-[4/5]');

    // Landscape 16:9 sets natural landscape ratio cleanly across full column width
    act(() => {
      img.naturalWidth = 1920;
      img.naturalHeight = 1080;
      img.dispatchEvent(new MiniEvent('load', { bubbles: false }));
    });
    expect(container.findAll((el) => el.tagName === 'IMG')).toHaveLength(1);
    expect(wrapper.style.aspectRatio).toBe('1920 / 1080');
    expect(wrapper.style.maxWidth).toBe('');

    // Square 1:1 preserves 1:1 natural aspect ratio
    act(() => {
      img.naturalWidth = 1200;
      img.naturalHeight = 1200;
      img.dispatchEvent(new MiniEvent('load', { bubbles: false }));
    });
    expect(container.findAll((el) => el.tagName === 'IMG')).toHaveLength(1);
    expect(wrapper.style.aspectRatio).toBe('1200 / 1200');
  });

  it('EventCoverImage fixed mode preserves existing compact dashboard and locked teaser layout behaviour', () => {
    act(() => {
      root.render(
        <EventCoverImage
          src={baseEvent.coverImageUrl}
          alt={baseEvent.title}
          mode="fixed"
          containerClassName="w-14 h-14 rounded-xl bg-stone-900"
        />
      );
    });

    const wrapper = container.childNodes[0] as MiniElement;
    const img = container.findAll((el) => el.tagName === 'IMG')[0];

    act(() => {
      img.naturalWidth = 1080;
      img.naturalHeight = 1350;
      img.dispatchEvent(new MiniEvent('load', { bubbles: false }));
    });

    expect(wrapper.className).toContain('w-14 h-14');
    expect(img.className).toContain('object-contain');
    expect(container.findAll((el) => el.tagName === 'IMG')).toHaveLength(2);
  });

  it('ImageCropModal initializes cover crops with 4:5 regardless of image orientation, preserves manual switching, and exports actual 4:5 crop on confirm', async () => {
    const landscapeFile = new File(['mock-bytes'], 'landscape-cover.webp', { type: 'image/webp' });
    const onConfirm = vi.fn();

    act(() => {
      root.render(
        <ImageCropModal
          isOpen={true}
          file={landscapeFile}
          mode="cover"
          onCancel={vi.fn()}
          onConfirm={onConfirm}
        />
      );
    });

    expect(container.textContent).toContain('4:5 Recommended');

    // Before confirmation, onConfirm has not been silently called
    expect(onConfirm).not.toHaveBeenCalled();

    // Simulate landscape image load -> 4:5 MUST remain actively selected (never overridden to 16:10)
    act(() => {
      const loadedImg = createdImages[createdImages.length - 1];
      loadedImg.naturalWidth = 1920;
      loadedImg.naturalHeight = 1080;
      loadedImg.onload?.();
    });

    const ratioButtons = container.findAll((el) => el.tagName === 'BUTTON' && el.hasAttribute('aria-pressed'));
    const presetLabels = ratioButtons.map((b) => b.textContent.trim());
    expect(ratioButtons).toHaveLength(8);
    expect(presetLabels.some((t) => t.startsWith('4:5') && t.includes('Rec'))).toBe(true);
    expect(presetLabels).toEqual(
      expect.arrayContaining(['3:4', '2:3', '1:1', '16:9', '4:3', '16:10 Flyer', 'Original'])
    );

    const recommended4x5Btn = ratioButtons.find((b) => b.textContent.trim().startsWith('4:5'));
    expect(recommended4x5Btn?.getAttribute('aria-pressed')).toBe('true');

    // Organizer can manually select every other ratio and return to 4:5
    for (const btn of ratioButtons) {
      act(() => {
        btn.click();
      });
      expect(btn.getAttribute('aria-pressed')).toBe('true');
    }

    act(() => {
      recommended4x5Btn?.click();
    });
    expect(recommended4x5Btn?.getAttribute('aria-pressed')).toBe('true');

    // Confirming crop exports an actual 4:5 portrait image file from landscape source
    const confirmBtn = container.findAll((el) => el.tagName === 'BUTTON' && el.textContent.includes('Confirm Crop & Upload'))[0];
    expect(confirmBtn).toBeDefined();

    await act(async () => {
      confirmBtn.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onConfirm).toHaveBeenCalledTimes(1);
    const exportedCanvas = doc.createdCanvases[doc.createdCanvases.length - 1];
    expect(exportedCanvas.height).toBeGreaterThan(exportedCanvas.width);
    expect(exportedCanvas.width / exportedCanvas.height).toBeCloseTo(4 / 5, 2);

    // Also confirm portrait upload keeps 4:5 actively selected on open without override
    const portraitFile = new File(['mock-portrait'], 'portrait-cover.webp', { type: 'image/webp' });
    act(() => {
      root.render(
        <ImageCropModal
          isOpen={true}
          file={portraitFile}
          mode="cover"
          onCancel={vi.fn()}
          onConfirm={onConfirm}
        />
      );
    });

    act(() => {
      const loadedImg = createdImages[createdImages.length - 1];
      loadedImg.naturalWidth = 1200;
      loadedImg.naturalHeight = 1600;
      loadedImg.onload?.();
    });

    const buttonsAfterPortrait = container.findAll((el) => el.tagName === 'BUTTON' && el.hasAttribute('aria-pressed'));
    const btn4x5AfterPortrait = buttonsAfterPortrait.find((b) => b.textContent.trim().startsWith('4:5'));
    expect(btn4x5AfterPortrait?.getAttribute('aria-pressed')).toBe('true');
  });

  it('Built-in CreateEventPage PRESET_COVERS provide 4 portrait 4:5 artwork URLs', () => {
    expect(PRESET_COVERS).toHaveLength(4);
    for (const preset of PRESET_COVERS) {
      expect(preset.name.trim().length).toBeGreaterThan(0);
      expect(preset.url).toContain('images.unsplash.com/photo-');
      expect(preset.url).toContain('w=1200&h=1500');
    }
  });
});
