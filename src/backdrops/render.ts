/**
 * `renderBackdrop`: draws a style behind the card and keeps it cheap.
 *
 * The rules, enforced here rather than left to each style:
 * - **Reduced motion** (the OS setting, or `reducedMotion: true`): one still frame, no animation,
 *   no pointer response. It redraws only when the size changes.
 * - **Nothing runs when nobody can see it**: the loop stops while the tab is hidden or the canvas is
 *   entirely off-screen (IntersectionObserver), and stops for good on `destroy()`.
 * - **Capped**: at most 30 frames per second (each style sets its own, often less), backing pixels
 *   per CSS pixel at most 2 (soft styles 1-1.5), and at most a 4K canvas.
 * - **Never in the way**: pointer listeners are window-level and passive, so the canvas keeps
 *   `pointer-events: none` and a click on the card is the card's alone. Taps on controls or on the
 *   card never reach a style.
 * - **The card stays solid**: the scrim (scrim.ts) is drawn over every frame.
 * - **Decorative**: the canvas is the caller's; `<Backdrop>` marks it `aria-hidden`.
 */
import { buildSetup, type BackdropArtOptions, layerFactory, NO_POINTER, type ResolvedArt, resolveArt } from './frame.js';
import { type BackdropHost, browserHost, type PointerLike } from './host.js';
import { defaultCardRect, drawScrim, paintScrim, SCRIM } from './scrim.js';
import type { Ctx2D, Layer, StyleInstance } from './styles/define.js';
import type { BackdropPointer, BackdropRect } from './types.js';

export interface BackdropOptions extends BackdropArtOptions {
  /** Respond to the pointer (and taps) where the style does. Default true. */
  interactive?: boolean;
  /** `'auto'` (default) follows the OS setting; `true` always draws a still frame. */
  reducedMotion?: boolean | 'auto';
  /** Where the card sits: an element (tracked as it moves and resizes), a rectangle in CSS pixels, or the default (centered, 440px wide). */
  card?: BackdropRect | Element | null;
  /** A lower frame-rate cap than the style's (never higher than 30). */
  maxFps?: number;
  /** Cap on backing pixels per CSS pixel. Default 2. */
  maxPixelRatio?: number;
  /** An exact backing ratio instead (e.g. a scaled-down preview: devicePixelRatio × scale). */
  pixelRatio?: number;
  /** Called once, after the first frame is drawn. */
  onReady?: () => void;
}

export type BackdropState = 'running' | 'still' | 'paused' | 'hidden' | 'offscreen' | 'waiting' | 'unsupported' | 'destroyed';

export interface BackdropStats {
  style: string;
  styleVersion: number;
  frames: number;
  /** Moving average of the time to draw one frame (art + scrim), in milliseconds. */
  averageFrameMs: number;
  maxFrameMs: number;
  lastFrameMs: number;
  /** Frames drawn in the last second. */
  fps: number;
  width: number;
  height: number;
  pixelRatio: number;
}

export interface BackdropController {
  readonly state: BackdropState;
  /** Stops animating (the last frame stays). */
  pause(): void;
  resume(): void;
  /** Changes options in place (a new style or seed redraws at once). */
  update(options: Partial<BackdropOptions>): void;
  stats(): BackdropStats;
  /** Stops everything and removes every listener. */
  destroy(): void;
}

const MAX_BACKING_PIXELS = 3840 * 2160;
const IDLE_MS = 5000;
const RESIZE_DEBOUNCE_MS = 150;
const SVG_NS = 'http://www.w3.org/2000/svg';
/** Taps on these (or on the card) never reach a style. */
const CONTROLS = 'a,button,input,select,textarea,label,summary,[role="button"],[role="link"],[contenteditable],[data-backdrop-card]';

function isCanvas(target: HTMLCanvasElement | SVGElement): target is HTMLCanvasElement {
  return typeof (target as HTMLCanvasElement).getContext === 'function';
}

function isElement(value: unknown): value is Element {
  return typeof value === 'object' && value !== null && typeof (value as Element).getBoundingClientRect === 'function';
}

const ART_KEYS = ['style', 'seed', 'styleVersion', 'family', 'palette', 'image'] as const;

/** Draws a backdrop into a canvas (animated) or an SVG element (a still frame as an image). */
export function renderBackdrop(target: HTMLCanvasElement | SVGElement, options: BackdropOptions): BackdropController {
  return createBackdropRenderer(target, options, browserHost());
}

/** `renderBackdrop` with the browser behind an interface (tests drive it by hand). */
export function createBackdropRenderer(target: HTMLCanvasElement | SVGElement, initial: BackdropOptions, host: BackdropHost): BackdropController {
  let options: BackdropOptions = { ...initial };
  let art: ResolvedArt = resolveArt(options);
  const svg = !isCanvas(target);
  const canvas = svg ? null : (target as HTMLCanvasElement);
  let svgImage: SVGImageElement | null = null;

  let ctx: Ctx2D | null = null;
  let surface: HTMLCanvasElement | OffscreenCanvas | null = null;
  let width = 0;
  let height = 0;
  let ratio = 1;
  let instance: StyleInstance | null = null;
  let scrimLayer: Layer | null = null;
  let card: BackdropRect = { x: 0, y: 0, width: 0, height: 0 };

  let destroyed = false;
  let unsupported = false;
  let userPaused = false;
  let hidden = host.documentHidden();
  let offscreen = false;
  let reduced = resolveReduced();
  let animTime = art.version.stillTime;
  let lastTick: number | null = null;
  let lastDraw: number | null = null;
  let frameHandle: number | null = null;
  let invalidUntil = 0;
  let resizeTimer: number | null = null;
  let ready = false;

  const pointer: { x: number; y: number; strength: number } = { x: NO_POINTER.x, y: NO_POINTER.y, strength: 0 };
  const raw = { x: 0, y: 0, inside: false, lastMove: -Infinity };

  const stats = { frames: 0, average: 0, max: 0, last: 0, windowStart: 0, windowFrames: 0, fps: 0 };

  let stopPointer: () => void = () => undefined;
  let stopCard: () => void = () => undefined;
  const stops: (() => void)[] = [];

  function resolveReduced(): boolean {
    const setting = options.reducedMotion ?? 'auto';
    return setting === 'auto' ? host.reducedMotion() : setting;
  }

  function measure(): { w: number; h: number } {
    const el = target as HTMLElement;
    let w = el.clientWidth;
    let h = el.clientHeight;
    if (!(w > 0 && h > 0)) {
      const rect = target.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
    }
    return { w, h };
  }

  function computeRatio(): number {
    let r = options.pixelRatio ?? Math.min(host.devicePixelRatio() || 1, options.maxPixelRatio ?? 2, art.version.maxPixelRatio);
    r = Math.min(4, Math.max(0.1, r));
    if (width * height * r * r > MAX_BACKING_PIXELS) r = Math.sqrt(MAX_BACKING_PIXELS / (width * height));
    return r;
  }

  function cardRect(): BackdropRect {
    const value = options.card;
    if (isElement(value)) {
      const outer = target.getBoundingClientRect();
      const inner = value.getBoundingClientRect();
      if (!(inner.width > 0 && inner.height > 0 && outer.width > 0 && outer.height > 0)) return defaultCardRect(width, height);
      const sx = width / outer.width;
      const sy = height / outer.height;
      return { x: (inner.left - outer.left) * sx, y: (inner.top - outer.top) * sy, width: inner.width * sx, height: inner.height * sy };
    }
    return value ?? defaultCardRect(width, height);
  }

  function invalidate(durationMs = 0): void {
    if (destroyed) return;
    if (durationMs > 0 && !reduced && !svg) invalidUntil = Math.max(invalidUntil, host.now() + durationMs);
    if (animating()) schedule();
    else draw(0);
  }

  /** (Re)creates the style instance, the canvas size, and the scrim. False until the target has a size. */
  function build(): boolean {
    const size = measure();
    if (!(size.w >= 1 && size.h >= 1)) return false;
    width = size.w;
    height = size.h;
    ratio = computeRatio();
    const bw = Math.max(1, Math.round(width * ratio));
    const bh = Math.max(1, Math.round(height * ratio));
    const createLayer = layerFactory(host.createCanvas, ratio);
    card = cardRect();
    instance?.destroy?.();
    instance = art.version.create(
      buildSetup({
        art,
        width,
        height,
        pixelRatio: ratio,
        card,
        motion: !reduced && !svg,
        createLayer,
        ...(options.image !== undefined && { image: options.image }),
        loadImage: host.loadImage,
        invalidate,
      }),
    );
    scrimLayer = createLayer(width, height, SCRIM.layerScale);
    paintScrim(scrimLayer, card, art.palette.page);
    surface = canvas ?? host.createCanvas(bw, bh);
    if (surface.width !== bw) surface.width = bw;
    if (surface.height !== bh) surface.height = bh;
    ctx = surface.getContext('2d', { alpha: false }) as Ctx2D | null;
    if (!ctx) unsupported = true;
    return !!ctx;
  }

  function draw(dt: number): void {
    if (!instance || !ctx || !scrimLayer || destroyed) return;
    const start = host.now();
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const motion = !reduced && !svg;
    instance.draw(ctx, { t: motion ? animTime : art.version.stillTime, dt, pointer: motion ? (pointer as BackdropPointer) : NO_POINTER });
    drawScrim(ctx, scrimLayer);
    const end = host.now();
    const cost = end - start;
    stats.frames++;
    stats.last = cost;
    stats.max = Math.max(stats.max, cost);
    stats.average = stats.frames === 1 ? cost : stats.average * 0.95 + cost * 0.05;
    if (end - stats.windowStart >= 1000) {
      stats.fps = stats.windowFrames;
      stats.windowFrames = 0;
      stats.windowStart = end;
    }
    stats.windowFrames++;
    if (svg) publishSvg();
    if (!ready) {
      ready = true;
      options.onReady?.();
    }
  }

  function publishSvg(): void {
    const el = target as SVGElement;
    const source = surface as HTMLCanvasElement | null;
    if (!source || typeof source.toDataURL !== 'function') return;
    if (!svgImage) {
      svgImage = el.ownerDocument.createElementNS(SVG_NS, 'image');
      svgImage.setAttribute('x', '0');
      svgImage.setAttribute('y', '0');
      svgImage.setAttribute('width', '100%');
      svgImage.setAttribute('height', '100%');
      svgImage.setAttribute('preserveAspectRatio', 'none');
      svgImage.setAttribute('aria-hidden', 'true');
      el.appendChild(svgImage);
    }
    svgImage.setAttribute('href', source.toDataURL('image/png'));
  }

  function animating(): boolean {
    if (destroyed || unsupported || userPaused || hidden || offscreen || reduced || svg || !instance) return false;
    return art.version.fps > 0 || host.now() < invalidUntil;
  }

  function fpsCap(): number {
    const styleFps = art.version.fps > 0 ? art.version.fps : 30;
    return Math.max(1, Math.min(30, styleFps, options.maxFps ?? 30));
  }

  function updatePointer(dt: number, now: number): void {
    const active = raw.inside && now - raw.lastMove < IDLE_MS;
    if (active && pointer.strength < 0.01) {
      pointer.x = raw.x;
      pointer.y = raw.y;
    } else {
      const follow = 1 - Math.exp(-dt * 12);
      pointer.x += (raw.x - pointer.x) * follow;
      pointer.y += (raw.y - pointer.y) * follow;
    }
    pointer.strength += ((active ? 1 : 0) - pointer.strength) * (1 - Math.exp(-dt * (active ? 5 : 2.2)));
    if (!active && pointer.strength < 0.002) pointer.strength = 0;
  }

  function tick(now: number): void {
    frameHandle = null;
    if (!animating()) {
      lastTick = null;
      lastDraw = null;
      return;
    }
    const interval = 1000 / fpsCap();
    if (lastDraw !== null && now - lastDraw < interval - 1.5) {
      schedule();
      return;
    }
    const dt = lastTick === null ? 1 / fpsCap() : Math.min(0.1, (now - lastTick) / 1000);
    lastTick = now;
    lastDraw = now;
    animTime += dt;
    updatePointer(dt, now);
    draw(dt);
    schedule();
  }

  function schedule(): void {
    if (frameHandle === null && animating()) frameHandle = host.requestFrame(tick);
  }

  function stopLoop(): void {
    if (frameHandle !== null) host.cancelFrame(frameHandle);
    frameHandle = null;
    lastTick = null;
    lastDraw = null;
  }

  function refresh(): void {
    if (destroyed) return;
    if (animating()) schedule();
    else stopLoop();
  }

  function rebuildAndDraw(): void {
    if (build()) draw(0);
    refresh();
  }

  // ---- The pointer: window-level and passive; positions mapped into the canvas's CSS pixels.
  function toLocal(event: PointerLike): { x: number; y: number; inside: boolean } {
    const rect = target.getBoundingClientRect();
    const x = rect.width > 0 ? ((event.clientX - rect.left) * width) / rect.width : -1;
    const y = rect.height > 0 ? ((event.clientY - rect.top) * height) / rect.height : -1;
    return { x, y, inside: x >= 0 && y >= 0 && x <= width && y <= height };
  }

  function onMove(event: PointerLike): void {
    const p = toLocal(event);
    raw.x = p.x;
    raw.y = p.y;
    raw.inside = p.inside;
    raw.lastMove = host.now();
  }

  function onDown(event: PointerLike): void {
    onMove(event);
    if (!instance?.tap || reduced || svg || destroyed || !raw.inside) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const element = event.target as Element | null;
    if (element && typeof element.closest === 'function' && element.closest(CONTROLS)) return;
    if (raw.x >= card.x && raw.x <= card.x + card.width && raw.y >= card.y && raw.y <= card.y + card.height) return;
    instance.tap(raw.x, raw.y, animTime);
    refresh();
  }

  function onUp(event: PointerLike): void {
    if (event.pointerType === 'touch') raw.inside = false;
  }

  function bindPointer(): void {
    stopPointer();
    stopPointer = () => undefined;
    if ((options.interactive ?? true) && art.module.interactivity !== 'none' && !svg) {
      stopPointer = host.onPointer({ move: onMove, down: onDown, up: onUp, leave: () => (raw.inside = false) });
    }
  }

  function onCardMove(): void {
    if (destroyed || !scrimLayer) return;
    const next = cardRect();
    if (Math.abs(next.x - card.x) + Math.abs(next.y - card.y) + Math.abs(next.width - card.width) + Math.abs(next.height - card.height) < 1) return;
    card = next;
    paintScrim(scrimLayer, card, art.palette.page);
    if (!animating()) draw(0);
  }

  function bindCard(): void {
    stopCard();
    stopCard = () => undefined;
    const value = options.card;
    if (isElement(value)) {
      const a = host.observeSize(value, onCardMove);
      const b = host.onViewportChange(onCardMove);
      stopCard = () => {
        a();
        b();
      };
    }
  }

  function onResize(): void {
    if (destroyed) return;
    if (!instance) {
      rebuildAndDraw();
      return;
    }
    if (resizeTimer !== null) host.clearTimer(resizeTimer);
    resizeTimer = host.setTimer(() => {
      resizeTimer = null;
      const size = measure();
      if (Math.abs(size.w - width) < 0.5 && Math.abs(size.h - height) < 0.5) {
        onCardMove();
        return;
      }
      rebuildAndDraw();
    }, RESIZE_DEBOUNCE_MS);
  }

  stops.push(
    host.onVisibilityChange(() => {
      hidden = host.documentHidden();
      refresh();
    }),
    host.observeVisible(target, (visible) => {
      offscreen = !visible;
      refresh();
    }),
    host.observeSize(target, onResize),
    host.onReducedMotionChange(() => {
      const next = resolveReduced();
      if (next === reduced) return;
      reduced = next;
      rebuildAndDraw();
    }),
  );
  bindPointer();
  bindCard();
  rebuildAndDraw();

  return {
    get state(): BackdropState {
      if (destroyed) return 'destroyed';
      if (unsupported) return 'unsupported';
      if (!instance) return 'waiting';
      if (reduced || svg || (art.version.fps === 0 && !animating())) return 'still';
      if (userPaused) return 'paused';
      if (hidden) return 'hidden';
      if (offscreen) return 'offscreen';
      return 'running';
    },
    pause() {
      userPaused = true;
      refresh();
    },
    resume() {
      userPaused = false;
      refresh();
    },
    update(partial) {
      if (destroyed) return;
      const previous = options;
      options = { ...options, ...partial };
      const changed = (key: keyof BackdropOptions) => JSON.stringify(previous[key] ?? null) !== JSON.stringify(options[key] ?? null);
      const artChanged = ART_KEYS.some(changed);
      if (artChanged) {
        art = resolveArt(options);
        if (changed('style') || changed('styleVersion')) animTime = art.version.stillTime;
      }
      if (changed('reducedMotion')) reduced = resolveReduced();
      if (previous.card !== options.card) bindCard();
      if (artChanged || changed('interactive')) bindPointer();
      if (artChanged || changed('reducedMotion') || changed('pixelRatio') || changed('maxPixelRatio') || previous.card !== options.card) rebuildAndDraw();
      else refresh();
    },
    stats() {
      return {
        style: art.module.id,
        styleVersion: art.version.version,
        frames: stats.frames,
        averageFrameMs: stats.average,
        maxFrameMs: stats.max,
        lastFrameMs: stats.last,
        fps: stats.fps,
        width,
        height,
        pixelRatio: ratio,
      };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopLoop();
      if (resizeTimer !== null) host.clearTimer(resizeTimer);
      for (const stop of stops) stop();
      stopPointer();
      stopCard();
      instance?.destroy?.();
      instance = null;
      svgImage?.remove();
      svgImage = null;
    },
  };
}
