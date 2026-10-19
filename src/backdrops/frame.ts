/**
 * The pieces every way of drawing a backdrop shares: resolving options to a style version and a
 * palette, building a style's setup, offscreen layers, and drawing a single still frame (for
 * previews, SVG targets, server-side images, and tests).
 */
import { backdropPalette, isBackdropFamily } from './families.js';
import { defaultCardRect } from './card.js';
import type { Ctx2D, Layer, StyleInstance, StyleSetup, StyleVersion } from './styles/define.js';
import { type BackdropStyleId, resolveStyleVersion } from './styles/registry.js';
import type { BackdropStyleModule } from './styles/define.js';
import type { BackdropFamily, BackdropImage, BackdropPalette, BackdropPointer, BackdropRect } from './types.js';

/** What to draw. */
export interface BackdropArtOptions {
  style: BackdropStyleId;
  /** Any string (or number); the same seed always draws the same art for a style version. */
  seed: string | number;
  /** The style version a site locked. Default: the newest (fine for exploring, never for a locked site). */
  styleVersion?: number;
  /** The family whose palette to paint with. Default `personal`. */
  family?: BackdropFamily;
  /** Palette overrides (each `#rrggbb`), on top of the family's palette. */
  palette?: Partial<BackdropPalette>;
  /** `painted` only: the image. */
  image?: BackdropImage;
}

export type CanvasFactory = (width: number, height: number) => HTMLCanvasElement | OffscreenCanvas;

export interface ResolvedArt {
  module: BackdropStyleModule;
  version: StyleVersion;
  seed: string;
  palette: BackdropPalette;
}

const HEX = /^#[0-9a-f]{6}$/i;

/** Normalizes a seed: a non-empty string of at most 128 characters, or a finite number. */
export function normalizeSeed(seed: string | number): string {
  if (typeof seed === 'number') {
    if (!Number.isFinite(seed)) throw new Error('auth-kit/backdrops: a numeric seed must be finite.');
    return String(seed);
  }
  if (typeof seed !== 'string' || seed.trim() === '' || seed.length > 128) throw new Error('auth-kit/backdrops: the seed must be a non-empty string (at most 128 characters) or a number.');
  return seed.trim();
}

export function resolveArt(options: BackdropArtOptions): ResolvedArt {
  const { module, version } = resolveStyleVersion(options.style, options.styleVersion);
  const family = options.family ?? 'personal';
  if (!isBackdropFamily(family)) throw new Error(`auth-kit/backdrops: family "${String(family)}" isn't osbm, unc, or personal.`);
  const palette = backdropPalette(family, options.palette ?? {});
  for (const [key, value] of Object.entries(palette)) {
    if (typeof value !== 'string' || !HEX.test(value)) throw new Error(`auth-kit/backdrops: palette.${key} must be #rrggbb, not "${String(value)}".`);
  }
  return { module, version, seed: normalizeSeed(options.seed), palette };
}

/** An offscreen-layer factory: layers are sized in CSS pixels, with their context pre-scaled. */
export function layerFactory(createCanvas: CanvasFactory, defaultScale: number): (width: number, height: number, scale?: number) => Layer {
  return (width, height, scale = defaultScale) => {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    const bw = Math.max(1, Math.round(w * scale));
    const bh = Math.max(1, Math.round(h * scale));
    const canvas = createCanvas(bw, bh);
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('auth-kit/backdrops: this environment has no 2D canvas.');
    ctx.setTransform(bw / w, 0, 0, bh / h, 0, 0);
    return { canvas, ctx, width: w, height: h, scale };
  };
}

export interface SetupInput {
  art: ResolvedArt;
  width: number;
  height: number;
  pixelRatio: number;
  card: BackdropRect;
  motion: boolean;
  image?: BackdropImage;
  createLayer: (width: number, height: number, scale?: number) => Layer;
  loadImage?: StyleSetup['loadImage'];
  invalidate?: (durationMs?: number) => void;
  subject?: string;
  subjectSet?: string;
  siteName?: string;
}

export function buildSetup(input: SetupInput): StyleSetup {
  return {
    seed: input.art.seed,
    width: input.width,
    height: input.height,
    card: input.card,
    palette: input.art.palette,
    pixelRatio: input.pixelRatio,
    motion: input.motion,
    createLayer: input.createLayer,
    ...(input.image !== undefined && { image: input.image }),
    ...(input.loadImage !== undefined && { loadImage: input.loadImage }),
    invalidate: input.invalidate ?? (() => undefined),
    ...(input.subject !== undefined && { subject: input.subject }),
    ...(input.subjectSet !== undefined && { subjectSet: input.subjectSet }),
    ...(input.siteName !== undefined && { siteName: input.siteName }),
  };
}

export const NO_POINTER: BackdropPointer = Object.freeze({ x: -1e6, y: -1e6, strength: 0 });

export interface BackdropStillOptions extends BackdropArtOptions {
  /** CSS pixels. */
  width: number;
  height: number;
  /** Backing pixels per CSS pixel of `ctx`'s canvas. Default 1. */
  pixelRatio?: number;
  /** Where the card sits. Default: centered, 440px wide. */
  card?: BackdropRect;
  /** Animation time. Default: the style version's still time. */
  t?: number;
  /** Makes offscreen canvases (browser: `document.createElement('canvas')`; Node: a canvas package). */
  createCanvas: CanvasFactory;
}

/**
 * Draws one still frame into `ctx` (whose canvas is `width × pixelRatio` by `height × pixelRatio`):
 * the art at the style's still time.
 */
export function drawBackdropStill(ctx: Ctx2D, options: BackdropStillOptions): void {
  const art = resolveArt(options);
  const ratio = options.pixelRatio ?? 1;
  const card = options.card ?? defaultCardRect(options.width, options.height);
  const createLayer = layerFactory(options.createCanvas, Math.min(ratio, art.version.maxPixelRatio));
  const instance: StyleInstance = art.version.create(
    buildSetup({
      art,
      width: options.width,
      height: options.height,
      pixelRatio: Math.min(ratio, art.version.maxPixelRatio),
      card,
      motion: false,
      createLayer,
      ...(options.image !== undefined && { image: options.image }),
    }),
  );
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  instance.draw(ctx, { t: options.t ?? art.version.stillTime, dt: 0, pointer: NO_POINTER });
  instance.destroy?.();
}
