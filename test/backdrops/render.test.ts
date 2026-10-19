/**
 * The renderer's rules, driven by hand through a fake browser: reduced motion draws one still frame;
 * nothing runs while hidden or off-screen; frames are capped; the pointer is passive and taps on the
 * card or a control never reach a style; resizing rebuilds once; SVG targets get a still image.
 */
import './preload.js';
import { describe, expect, it } from 'vitest';
import type { BackdropHost, PointerHandlers, PointerLike } from '../../src/backdrops/host.js';
import { createBackdropRenderer } from '../../src/backdrops/render.js';
import { RecordingCanvas, recordingCanvasFactory, resetCanvasIds } from './recording-canvas.js';

class FakeCanvasElement extends RecordingCanvas {
  constructor(
    public clientWidth: number,
    public clientHeight: number,
    public left = 0,
    public top = 0,
  ) {
    super();
  }
  getBoundingClientRect() {
    return { left: this.left, top: this.top, width: this.clientWidth, height: this.clientHeight, right: this.left + this.clientWidth, bottom: this.top + this.clientHeight, x: this.left, y: this.top };
  }
}

class FakeHost implements BackdropHost {
  time = 0;
  dpr = 2;
  reduced = false;
  hidden = false;
  frames = new Map<number, (now: number) => void>();
  timers = new Map<number, { at: number; fn: () => void }>();
  next = 1;
  visibility: (() => void)[] = [];
  motion: ((r: boolean) => void)[] = [];
  visible: ((v: boolean) => void)[] = [];
  sizes: (() => void)[] = [];
  viewport: (() => void)[] = [];
  pointer: PointerHandlers | null = null;
  pointerSubscriptions = 0;
  created: RecordingCanvas[] = [];
  createCanvas = recordingCanvasFactory(this.created);

  now = () => this.time;
  requestFrame = (fn: (now: number) => void) => {
    const id = this.next++;
    this.frames.set(id, fn);
    return id;
  };
  cancelFrame = (id: number) => void this.frames.delete(id);
  setTimer = (fn: () => void, ms: number) => {
    const id = this.next++;
    this.timers.set(id, { at: this.time + ms, fn });
    return id;
  };
  clearTimer = (id: number) => void this.timers.delete(id);
  devicePixelRatio = () => this.dpr;
  reducedMotion = () => this.reduced;
  onReducedMotionChange = (fn: (r: boolean) => void) => this.subscribe(this.motion, fn);
  documentHidden = () => this.hidden;
  onVisibilityChange = (fn: () => void) => this.subscribe(this.visibility, fn);
  observeVisible = (_el: Element, fn: (v: boolean) => void) => this.subscribe(this.visible, fn);
  observeSize = (_el: Element, fn: () => void) => this.subscribe(this.sizes, fn);
  onViewportChange = (fn: () => void) => this.subscribe(this.viewport, fn);
  onPointer = (handlers: PointerHandlers) => {
    this.pointer = handlers;
    this.pointerSubscriptions++;
    return () => {
      this.pointer = null;
      this.pointerSubscriptions--;
    };
  };
  loadImage = () => Promise.reject(new Error('no images in tests'));

  subscribe<T>(list: T[], fn: T): () => void {
    list.push(fn);
    return () => {
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    };
  }

  /** Advances time in display-refresh steps, running due frames and timers. */
  advance(ms: number, step = 1000 / 60): void {
    const end = this.time + ms;
    while (this.time + step <= end + 1e-9) {
      this.time += step;
      for (const [id, timer] of [...this.timers]) {
        if (timer.at <= this.time) {
          this.timers.delete(id);
          timer.fn();
        }
      }
      const due = [...this.frames];
      this.frames.clear();
      for (const [, fn] of due) fn(this.time);
    }
  }

  get pendingFrames(): number {
    return this.frames.size;
  }
}

function event(x: number, y: number, extra: Partial<PointerLike> = {}): PointerLike {
  return { clientX: x, clientY: y, pointerType: 'mouse', button: 0, target: null, ...extra };
}

function setup(options: Record<string, unknown> = {}, host = new FakeHost()) {
  const canvas = new FakeCanvasElement(800, 500);
  const controller = createBackdropRenderer(canvas as unknown as HTMLCanvasElement, { style: 'constellation', seed: 'render', family: 'unc', ...options } as never, host);
  return { canvas, controller, host };
}

describe('renderBackdrop', () => {
  it('draws the first frame at once, sized to the canvas at the capped pixel ratio, then animates', () => {
    const { canvas, controller, host } = setup();
    expect(controller.state).toBe('running');
    expect(controller.stats().frames).toBe(1);
    expect(canvas.width).toBe(1600);
    expect(canvas.height).toBe(1000);
    host.advance(1000);
    const s = controller.stats();
    // Constellation draws at most 24 frames a second.
    expect(s.frames).toBeGreaterThanOrEqual(22);
    expect(s.frames).toBeLessThanOrEqual(26);
    controller.destroy();
  });

  it('caps the frame rate at the style’s own (contours: 6 per second) and at maxFps', () => {
    const contours = setup({ style: 'contours' });
    contours.host.advance(2000);
    expect(contours.controller.stats().frames).toBeLessThanOrEqual(1 + 13);
    expect(contours.controller.stats().frames).toBeGreaterThanOrEqual(1 + 10);
    const capped = setup({ maxFps: 10 });
    capped.host.advance(1000);
    expect(capped.controller.stats().frames).toBeLessThanOrEqual(12);
  });

  it('caps the pixel ratio (2 by default, the style’s cap, maxPixelRatio, a 4K canvas)', () => {
    const host = new FakeHost();
    host.dpr = 3;
    expect(setup({}, host).canvas.width).toBe(1600);
    expect(setup({ style: 'aurora' }, host).canvas.width).toBe(800);
    expect(setup({ maxPixelRatio: 1.5 }, host).canvas.width).toBe(1200);
    expect(setup({ pixelRatio: 0.5 }, host).canvas.width).toBe(400);
    const huge = new FakeCanvasElement(5000, 3000);
    createBackdropRenderer(huge as unknown as HTMLCanvasElement, { style: 'ripples', seed: 'x' }, host);
    expect(huge.width * huge.height).toBeLessThanOrEqual(3840 * 2160 + 10000);
  });

  it('under reduced motion draws one still frame and schedules nothing, and ignores the pointer', () => {
    const host = new FakeHost();
    host.reduced = true;
    const { controller } = setup({}, host);
    expect(controller.state).toBe('still');
    expect(host.pendingFrames).toBe(0);
    host.pointer?.move(event(100, 100));
    host.advance(2000);
    expect(controller.stats().frames).toBe(1);
  });

  it('switches to a still frame when the OS setting changes, and back', () => {
    const { controller, host } = setup();
    host.reduced = true;
    for (const fn of host.motion) fn(true);
    const frames = controller.stats().frames;
    host.advance(1000);
    expect(controller.stats().frames).toBe(frames);
    expect(controller.state).toBe('still');
    host.reduced = false;
    for (const fn of host.motion) fn(false);
    host.advance(500);
    expect(controller.stats().frames).toBeGreaterThan(frames + 5);
  });

  it('reducedMotion: true forces a still frame even when the OS allows motion', () => {
    const { controller, host } = setup({ reducedMotion: true });
    host.advance(1000);
    expect(controller.stats().frames).toBe(1);
  });

  it('stops while the tab is hidden and while the canvas is off-screen, and resumes', () => {
    const { controller, host } = setup();
    host.advance(200);
    host.hidden = true;
    for (const fn of host.visibility) fn();
    expect(controller.state).toBe('hidden');
    expect(host.pendingFrames).toBe(0);
    const frames = controller.stats().frames;
    host.advance(1000);
    expect(controller.stats().frames).toBe(frames);
    host.hidden = false;
    for (const fn of host.visibility) fn();
    host.advance(200);
    expect(controller.stats().frames).toBeGreaterThan(frames);

    for (const fn of host.visible) fn(false);
    expect(controller.state).toBe('offscreen');
    expect(host.pendingFrames).toBe(0);
    const offFrames = controller.stats().frames;
    host.advance(1000);
    expect(controller.stats().frames).toBe(offFrames);
    for (const fn of host.visible) fn(true);
    host.advance(200);
    expect(controller.stats().frames).toBeGreaterThan(offFrames);
  });

  it('pause and resume', () => {
    const { controller, host } = setup();
    controller.pause();
    expect(controller.state).toBe('paused');
    const frames = controller.stats().frames;
    host.advance(1000);
    expect(controller.stats().frames).toBe(frames);
    controller.resume();
    host.advance(300);
    expect(controller.stats().frames).toBeGreaterThan(frames);
  });

  it('listens to the pointer only for interactive styles, and lets go on destroy', () => {
    const host = new FakeHost();
    setup({ style: 'aurora' }, host);
    expect(host.pointerSubscriptions).toBe(0);
    setup({ interactive: false }, host);
    expect(host.pointerSubscriptions).toBe(0);
    const { controller } = setup({}, host);
    expect(host.pointerSubscriptions).toBe(1);
    controller.destroy();
    expect(host.pointerSubscriptions).toBe(0);
    expect(host.visibility.length + host.visible.length + host.sizes.length + host.motion.length).toBe(4 * 2);
  });

  it('destroy stops everything and removes every listener', () => {
    const host = new FakeHost();
    const { controller } = setup({ card: { x: 0, y: 0, width: 10, height: 10 } }, host);
    controller.destroy();
    expect(controller.state).toBe('destroyed');
    expect(host.pendingFrames).toBe(0);
    expect(host.visibility.length + host.visible.length + host.sizes.length + host.motion.length + host.viewport.length).toBe(0);
    controller.destroy();
  });

  /** Ripples with a card, optionally displayed at half size; returns what the canvas drew. */
  function tapRun(tap?: PointerLike, halfSize = false): string {
    resetCanvasIds();
    const host = new FakeHost();
    const canvas = new FakeCanvasElement(800, 500);
    if (halfSize) canvas.getBoundingClientRect = () => ({ left: 100, top: 50, width: 400, height: 250, right: 500, bottom: 300, x: 100, y: 50 });
    createBackdropRenderer(canvas as unknown as HTMLCanvasElement, { style: 'ripples', seed: 'taps', card: { x: 300, y: 100, width: 200, height: 300 } }, host);
    host.advance(100);
    if (tap) host.pointer!.down(tap);
    host.advance(400);
    return canvas.contentHash();
  }

  it('passes taps on open backdrop to the style, never taps on the card or a control', () => {
    const untouched = tapRun();
    const control = { closest: (sel: string) => (sel.includes('button') ? {} : null) };
    expect(tapRun(event(400, 200))).toBe(untouched);
    expect(tapRun(event(50, 50, { target: control as unknown as EventTarget }))).toBe(untouched);
    expect(tapRun(event(50, 50, { button: 2 }))).toBe(untouched);
    expect(tapRun(event(50, 50))).not.toBe(untouched);
  });

  it('maps the pointer through CSS transforms (a scaled preview)', () => {
    const untouched = tapRun(undefined, true);
    // Displayed at half size from (100, 50): client (300, 150) is layout (400, 200), on the card.
    expect(tapRun(event(300, 150), true)).toBe(untouched);
    // Client (125, 75) is layout (50, 50), open water.
    expect(tapRun(event(125, 75), true)).not.toBe(untouched);
  });

  it('rebuilds once after a burst of resizes (debounced), and redraws at the new size', () => {
    const { canvas, controller, host } = setup();
    canvas.clientWidth = 900;
    for (let i = 0; i < 5; i++) {
      for (const fn of host.sizes) fn();
      host.advance(20);
    }
    expect(canvas.width).toBe(1600);
    host.advance(200);
    expect(canvas.width).toBe(1800);
    expect(controller.stats().width).toBe(900);
  });

  it('follows a card element (its place keeps focal points visible and taps off the art; nothing fades around it)', () => {
    const host = new FakeHost();
    const card = { getBoundingClientRect: () => ({ left: 300, top: 100, width: 200, height: 300 }) };
    const { controller } = setup({ card }, host);
    expect(host.viewport.length).toBe(1);
    controller.update({ card: null });
    expect(host.viewport.length).toBe(0);
  });

  it('update() redraws in place for a new style or seed, and throws on an unknown style', () => {
    const { controller } = setup();
    const frames = controller.stats().frames;
    controller.update({ seed: 'another' });
    expect(controller.stats().frames).toBe(frames + 1);
    controller.update({ style: 'ripples' });
    expect(controller.stats().style).toBe('ripples');
    expect(() => controller.update({ style: 'nope' as never })).toThrow(/no style "nope"/);
  });

  it('refuses a style version this auth-kit doesn’t have, instead of drawing something else', () => {
    expect(() => setup({ style: 'aurora', styleVersion: 99 })).toThrow(/has no version 99/);
  });

  it('waits for a size, and is "unsupported" (not an exception) without a 2D canvas', () => {
    const host = new FakeHost();
    const empty = new FakeCanvasElement(0, 0);
    const waiting = createBackdropRenderer(empty as unknown as HTMLCanvasElement, { style: 'ripples', seed: 'x' }, host);
    expect(waiting.state).toBe('waiting');
    empty.clientWidth = 300;
    empty.clientHeight = 200;
    for (const fn of host.sizes) fn();
    expect(waiting.state).toBe('running');

    const broken = new FakeCanvasElement(300, 200);
    broken.getContext = (() => null) as never;
    const unsupported = createBackdropRenderer(broken as unknown as HTMLCanvasElement, { style: 'ripples', seed: 'x' }, host);
    expect(unsupported.state).toBe('unsupported');
  });

  it('draws a still image into an SVG target', () => {
    const host = new FakeHost();
    const attributes: Record<string, string> = {};
    const image = { setAttribute: (k: string, v: string) => (attributes[k] = v), remove: () => (attributes.removed = 'yes') };
    const children: unknown[] = [];
    const svg = {
      clientWidth: 400,
      clientHeight: 300,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }),
      ownerDocument: { createElementNS: (_ns: string, name: string) => (name === 'image' ? image : null) },
      appendChild: (child: unknown) => children.push(child),
    };
    const controller = createBackdropRenderer(svg as unknown as SVGElement, { style: 'contours', seed: 'svg' }, host);
    expect(controller.state).toBe('still');
    expect(children).toEqual([image]);
    expect(attributes.href).toMatch(/^data:image\/png/);
    expect(attributes['aria-hidden']).toBe('true');
    host.advance(1000);
    expect(controller.stats().frames).toBe(1);
    controller.destroy();
    expect(attributes.removed).toBe('yes');
  });

  it('calls onReady once, after the first frame', () => {
    let ready = 0;
    const { host } = setup({ onReady: () => ready++ });
    host.advance(500);
    expect(ready).toBe(1);
  });
});

describe('register E6: a still frame on slow devices, and rest when there is nothing to show', () => {
  it('draws the still frame when the browser asks to save data or the device has little memory', () => {
    for (const [flag, reason] of [
      ['saveData', 'save-data'],
      ['lowMemory', 'low-memory'],
    ] as const) {
      const host = new FakeHost();
      Object.assign(host, { [flag]: () => true });
      const { controller } = setup({}, host);
      expect(controller.state).toBe('still');
      expect(controller.stats().stillReason).toBe(reason);
      host.advance(1000);
      expect(controller.stats().frames).toBe(1);
      expect(host.pendingFrames).toBe(0);
    }
    // A site may opt out.
    const host = new FakeHost();
    Object.assign(host, { saveData: () => true });
    expect(setup({ stillOnSlowDevices: false }, host).controller.state).toBe('running');
  });

  it('goes still when frames keep costing more than the budget', () => {
    const host = new FakeHost();
    const realNow = host.now;
    // A clock that moves 1 ms on every read: each frame "costs" at least that, over a 0.5 ms budget.
    let reads = 0;
    host.now = () => realNow() + ++reads;
    const { controller } = setup({ frameBudgetMs: 0.5 }, host);
    host.advance(3000);
    expect(controller.stats().stillReason).toBe('slow-frames');
    expect(controller.state).toBe('still');
    const frames = controller.stats().frames;
    host.advance(1000);
    expect(controller.stats().frames).toBe(frames);
  });

  it('a style that settles stops its loop there, and wakes for the pointer and taps', () => {
    const { controller, host } = setup({ style: 'pulse-dots', seed: 'settle' });
    host.advance(2000);
    expect(controller.state).toBe('still');
    expect(host.pendingFrames).toBe(0);
    const frames = controller.stats().frames;
    host.pointer!.move(event(100, 100));
    expect(host.pendingFrames).toBe(1);
    host.advance(500);
    expect(controller.stats().frames).toBeGreaterThan(frames);
    // Once the pointer has gone and eased away, it rests again.
    host.pointer!.leave();
    host.advance(8000);
    expect(host.pendingFrames).toBe(0);
  });
});

describe('register E3: subjects rotate per visit; the seed locks the look; the site name reaches the style', () => {
  it('picks this visit’s subject (fixed, or the day’s without storage) and hands it to the style', () => {
    const fixed = setup({ style: 'county-survey', seed: 'sheet', subject: { rotation: 'fixed', key: 'Dare' } });
    expect(fixed.controller.stats().subject).toMatchObject({ key: 'Dare', set: 'all', of: 100, rotation: 'fixed' });
    const day = setup({ style: 'river-basins', seed: 'sheet', subject: { rotation: 'day' } });
    expect(day.controller.stats().subject).toMatchObject({ set: 'all', of: 17, rotation: 'day' });
    // A style without subjects has none, and refuses subject options.
    expect(setup().controller.stats().subject).toBeNull();
    expect(() => setup({ subject: { rotation: 'day' } })).toThrow(/no subjects/);
    expect(() => setup({ style: 'star-chart', seed: 'x', subject: { set: 'zodiac' } })).toThrow(/no subject set "zodiac"/);
  });

  it('loads each style on first use: waiting until its code arrives, then drawing', async () => {
    const { controller } = setup({ style: 'star-chart', seed: 'lazy', subject: { rotation: 'fixed', key: 'Cyg' } });
    // Preloaded in tests, so it draws at once; the lazy path is in lazy.test.ts.
    expect(controller.stats().frames).toBe(1);
    await Promise.resolve();
  });
});
