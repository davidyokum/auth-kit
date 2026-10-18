/**
 * The contract every backdrop style implements. A style is one folder under `styles/` with an
 * `index.ts` (its module: ID, label, interactivity, versions) and one file per released version
 * (`v1.ts`, `v2.ts`, ...). Register the module in `registry.ts` and it's everywhere: types,
 * variations, the picker, the React component, and the frozen-hash test.
 *
 * Versions are frozen once released (ADR 0020): a site locks `{ style, seed, styleVersion }`, so a
 * released version must keep drawing exactly what it drew. To change a style's look, add a version.
 * To stop offering a style, mark it `retired` (locked sites keep rendering); never delete it.
 */
import type { BackdropImage, BackdropPalette, BackdropPointer, BackdropRect } from '../types.js';

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** An offscreen drawing surface, sized in CSS pixels and drawn at `scale` backing pixels per CSS pixel. */
export interface Layer {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly ctx: Ctx2D;
  /** CSS pixels. */
  readonly width: number;
  readonly height: number;
  /** Backing pixels per CSS pixel. The context is already scaled: draw in CSS pixels. */
  readonly scale: number;
}

/** What a style version gets once, when it's created (and again after a resize). */
export interface StyleSetup {
  /** The site's seed. A version hashes it with its own ID and version number before use. */
  readonly seed: string;
  /** CSS pixels. */
  readonly width: number;
  readonly height: number;
  /** Where the card sits. Compositions keep the busiest parts away from it. */
  readonly card: BackdropRect;
  readonly palette: BackdropPalette;
  /** The main canvas's backing pixels per CSS pixel. */
  readonly pixelRatio: number;
  /** False under reduced motion (and for stills): show end states, never fades. */
  readonly motion: boolean;
  /** An offscreen layer. `scale` defaults to `pixelRatio`. Allocate in `create`, never per frame. */
  createLayer(width: number, height: number, scale?: number): Layer;
  /** `painted` only. */
  readonly image?: BackdropImage;
  /** Loads an image (browser: an `Image`). Absent where images can't load (tests). */
  readonly loadImage?: (src: string) => Promise<CanvasImageSource & { readonly width: number; readonly height: number }>;
  /** Asks for a redraw (a static style whose image arrived), animating for `durationMs` if motion is allowed. */
  invalidate(durationMs?: number): void;
}

export interface FrameInput {
  /** Seconds of animation so far (paused time doesn't count). */
  readonly t: number;
  /** Seconds since the previous frame, capped. */
  readonly dt: number;
  readonly pointer: BackdropPointer;
}

/** A created style: draws frames. Everything it needs per frame is allocated in `create`. */
export interface StyleInstance {
  /** Paints the whole canvas (the canvas is opaque: paint the page first). In CSS pixels. */
  readonly draw: (ctx: Ctx2D, frame: FrameInput) => void;
  /** A tap or click on the backdrop (outside the card and any control), in CSS pixels. */
  readonly tap?: (x: number, y: number, t: number) => void;
  /** Helpers `draw` calls every frame, listed so the allocation check (tests) reads them too. */
  readonly hot?: readonly unknown[];
  readonly destroy?: () => void;
}

/** One released version of a style, type-erased for the registry (see `defineVersion`). */
export interface StyleVersion {
  readonly version: number;
  /** Frames per second while animating, at most 30. 0: static (drawn on start, resize, and invalidate). */
  readonly fps: number;
  /** A cap on backing pixels per CSS pixel: soft styles gain nothing from 2x and cost 4x the fill. */
  readonly maxPixelRatio: number;
  /** The animation time shown as the still frame (reduced motion, SVG targets, previews). */
  readonly stillTime: number;
  /** The palette mapping: the colors this version paints with, derived from the family palette. */
  colors(palette: BackdropPalette): unknown;
  create(setup: StyleSetup): StyleInstance;
}

export interface StyleVersionSpec<C> {
  readonly version: number;
  readonly fps: number;
  readonly maxPixelRatio: number;
  readonly stillTime: number;
  colors(palette: BackdropPalette): C;
  create(setup: StyleSetup, colors: C): StyleInstance;
}

/** Declares one version: its palette mapping feeds its renderer. */
export function defineVersion<C>(spec: StyleVersionSpec<C>): StyleVersion {
  if (!Number.isInteger(spec.version) || spec.version < 1) throw new Error(`auth-kit/backdrops: style version ${spec.version} must be a positive integer.`);
  if (!(spec.fps >= 0 && spec.fps <= 30)) throw new Error(`auth-kit/backdrops: fps ${spec.fps} must be between 0 and 30.`);
  return Object.freeze({
    version: spec.version,
    fps: spec.fps,
    maxPixelRatio: spec.maxPixelRatio,
    stillTime: spec.stillTime,
    colors: (palette: BackdropPalette) => spec.colors(palette),
    create: (setup: StyleSetup) => spec.create(setup, spec.colors(setup.palette)),
  });
}

export type BackdropInteractivity = 'pointer' | 'tap' | 'none';

export interface BackdropStyleModule<Id extends string = string> {
  readonly id: Id;
  /** For people: "Magnetic dots". */
  readonly label: string;
  /** One sentence for the picker. */
  readonly description: string;
  /** What the pointer does: leans/glows/links (`pointer`), rings on a tap (`tap`), or nothing. */
  readonly interactivity: BackdropInteractivity;
  /** Generated from a seed alone, so it's offered in variations and defaults. `painted` isn't. */
  readonly generative: boolean;
  /** No longer offered (picker, variations, defaults), but still renders for sites that locked it. */
  readonly retired?: boolean;
  /** Every released version, oldest first. Never remove one. */
  readonly versions: readonly StyleVersion[];
}

/** Declares a style module (checks its versions are 1, 2, 3, ... in order). */
export function defineStyle<const Id extends string>(module: BackdropStyleModule<Id>): BackdropStyleModule<Id> {
  if (!/^[a-z][a-z0-9-]*$/.test(module.id)) throw new Error(`auth-kit/backdrops: style ID "${module.id}" must be lowercase words joined by hyphens.`);
  if (module.versions.length === 0) throw new Error(`auth-kit/backdrops: style "${module.id}" has no versions.`);
  module.versions.forEach((v, i) => {
    if (v.version !== i + 1) throw new Error(`auth-kit/backdrops: style "${module.id}" lists version ${v.version} where ${i + 1} belongs.`);
  });
  return Object.freeze({ ...module, versions: Object.freeze([...module.versions]) });
}
