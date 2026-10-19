/**
 * Everything the renderer needs from the browser, behind one interface, so tests can drive the
 * frame loop, visibility, reduced motion, and the pointer by hand.
 */
import { type SubjectEnvironment, browserSubjectEnvironment } from './subjects.js';
import type { CanvasFactory } from './frame.js';

export interface PointerLike {
  readonly clientX: number;
  readonly clientY: number;
  readonly pointerType: string;
  readonly button: number;
  readonly target: EventTarget | null;
}

export interface PointerHandlers {
  readonly move: (event: PointerLike) => void;
  readonly down: (event: PointerLike) => void;
  readonly up: (event: PointerLike) => void;
  readonly leave: () => void;
}

export type Drawable = CanvasImageSource & { readonly width: number; readonly height: number };

export interface BackdropHost {
  readonly now: () => number;
  readonly requestFrame: (callback: (now: number) => void) => number;
  readonly cancelFrame: (handle: number) => void;
  readonly setTimer: (callback: () => void, ms: number) => number;
  readonly clearTimer: (handle: number) => void;
  readonly devicePixelRatio: () => number;
  readonly reducedMotion: () => boolean;
  readonly onReducedMotionChange: (callback: (reduced: boolean) => void) => () => void;
  readonly documentHidden: () => boolean;
  readonly onVisibilityChange: (callback: () => void) => () => void;
  /** Calls back with false while the element is entirely off-screen. */
  readonly observeVisible: (element: Element, callback: (visible: boolean) => void) => () => void;
  readonly observeSize: (element: Element, callback: () => void) => () => void;
  /** Window-level, passive pointer listeners: the backdrop never sits in the way of a click. */
  readonly onPointer: (handlers: PointerHandlers) => () => void;
  /** Scrolls and window resizes (the card can move relative to the backdrop). */
  readonly onViewportChange: (callback: () => void) => () => void;
  readonly createCanvas: CanvasFactory;
  readonly loadImage: (src: string) => Promise<Drawable>;
  /** The browser asked to save data (`navigator.connection.saveData`). Absent: no. */
  readonly saveData?: () => boolean;
  /** The device reports little memory (`navigator.deviceMemory` of 2 GB or less). Absent: no. */
  readonly lowMemory?: () => boolean;
  /** Where subject rotation keeps this browser's tour (`localStorage`) and draws its chance. Absent: no storage (a tour falls back to the subject of the day). */
  readonly subjectEnvironment?: () => SubjectEnvironment;
}

/** `navigator.deviceMemory` at or below this (GB) draws a still frame. */
export const LOW_MEMORY_GB = 2;

const noop = () => undefined;

/** The real browser. Call only in the browser (an effect, an event handler). */
export function browserHost(): BackdropHost {
  const win = window;
  const doc = document;
  const motionQuery = typeof win.matchMedia === 'function' ? win.matchMedia('(prefers-reduced-motion: reduce)') : null;
  return {
    now: () => win.performance.now(),
    requestFrame: (callback) => win.requestAnimationFrame(callback),
    cancelFrame: (handle) => win.cancelAnimationFrame(handle),
    setTimer: (callback, ms) => win.setTimeout(callback, ms),
    clearTimer: (handle) => win.clearTimeout(handle),
    devicePixelRatio: () => win.devicePixelRatio || 1,
    reducedMotion: () => motionQuery?.matches ?? false,
    onReducedMotionChange(callback) {
      if (!motionQuery) return noop;
      const listener = () => callback(motionQuery.matches);
      motionQuery.addEventListener('change', listener);
      return () => motionQuery.removeEventListener('change', listener);
    },
    documentHidden: () => doc.visibilityState === 'hidden',
    onVisibilityChange(callback) {
      doc.addEventListener('visibilitychange', callback);
      return () => doc.removeEventListener('visibilitychange', callback);
    },
    observeVisible(element, callback) {
      if (typeof IntersectionObserver === 'undefined') return noop;
      const observer = new IntersectionObserver((entries) => {
        const last = entries[entries.length - 1];
        if (last) callback(last.isIntersecting);
      });
      observer.observe(element);
      return () => observer.disconnect();
    },
    observeSize(element, callback) {
      if (typeof ResizeObserver === 'undefined') {
        win.addEventListener('resize', callback);
        return () => win.removeEventListener('resize', callback);
      }
      const observer = new ResizeObserver(() => callback());
      observer.observe(element);
      return () => observer.disconnect();
    },
    onPointer(handlers) {
      const options: AddEventListenerOptions = { passive: true };
      const root = doc.documentElement;
      win.addEventListener('pointermove', handlers.move, options);
      win.addEventListener('pointerdown', handlers.down, options);
      win.addEventListener('pointerup', handlers.up, options);
      win.addEventListener('pointercancel', handlers.up, options);
      root.addEventListener('pointerleave', handlers.leave, options);
      win.addEventListener('blur', handlers.leave);
      return () => {
        win.removeEventListener('pointermove', handlers.move);
        win.removeEventListener('pointerdown', handlers.down);
        win.removeEventListener('pointerup', handlers.up);
        win.removeEventListener('pointercancel', handlers.up);
        root.removeEventListener('pointerleave', handlers.leave);
        win.removeEventListener('blur', handlers.leave);
      };
    },
    onViewportChange(callback) {
      const options: AddEventListenerOptions = { passive: true, capture: true };
      win.addEventListener('resize', callback, options);
      win.addEventListener('scroll', callback, options);
      return () => {
        win.removeEventListener('resize', callback, options);
        win.removeEventListener('scroll', callback, options);
      };
    },
    createCanvas(width, height) {
      const canvas = doc.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      return canvas;
    },
    saveData() {
      const connection = (win.navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
      return connection?.saveData === true;
    },
    lowMemory() {
      const memory = (win.navigator as Navigator & { deviceMemory?: number }).deviceMemory;
      return typeof memory === 'number' && memory <= LOW_MEMORY_GB;
    },
    subjectEnvironment: browserSubjectEnvironment,
    loadImage(src) {
      return new Promise((resolve, reject) => {
        const image = new Image();
        image.decoding = 'async';
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error(`auth-kit/backdrops: couldn't load the image ${src}`));
        image.src = src;
      });
    },
  };
}
