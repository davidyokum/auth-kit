/**
 * Shared scenes for the backdrop tests: a style version drawn into a recording canvas through the
 * same setup the renderer builds, frame by frame, with a scripted pointer and tap.
 */
import './preload.js';
import { buildSetup, layerFactory, resolveArt } from '../../src/backdrops/frame.js';
import type { FrameInput, StyleInstance } from '../../src/backdrops/styles/define.js';
import { STYLE_MODULES } from '../../src/backdrops/styles/registry.js';
import type { BackdropPalette, BackdropRect } from '../../src/backdrops/types.js';
import { RecordingCanvas, type RecordingContext, recordingCanvasFactory, resetCanvasIds } from './recording-canvas.js';

/** A fixed palette, so frozen hashes catch algorithm drift and not brand changes (ADR 0021). */
export const TEST_PALETTE: BackdropPalette = {
  page: '#f2f3f5',
  mist: '#e0e4ea',
  glow: '#a8c8e8',
  primary: '#2a6fb5',
  secondary: '#4a90d0',
  ink: '#10243a',
};

export interface SceneOptions {
  style: string;
  version: number;
  seed?: string;
  width?: number;
  height?: number;
  card?: BackdropRect;
  pixelRatio?: number;
  palette?: Partial<BackdropPalette>;
  family?: 'osbm' | 'unc' | 'personal';
  /** The site's name, for styles that letter it. Default `Example Site`; `null` leaves it out. */
  siteName?: string | null;
}

export interface Scene {
  canvas: RecordingCanvas;
  ctx: RecordingContext;
  instance: StyleInstance;
  stillTime: number;
  draw(frame: FrameInput): void;
}

/** A painted-style image source: a recorded canvas stands in for the image. */
function fakeLoadImage(src: string): Promise<RecordingCanvas & { width: number; height: number }> {
  const canvas = new RecordingCanvas(src.includes('placeholder') ? 8 : 64, src.includes('placeholder') ? 4 : 32);
  canvas.getContext('2d').fillRect(0, 0, 1, 1);
  return Promise.resolve(canvas);
}

export function createScene(options: SceneOptions): Scene {
  resetCanvasIds();
  const width = options.width ?? 360;
  const height = options.height ?? 240;
  const ratio = options.pixelRatio ?? 1;
  const art = resolveArt({
    style: options.style as never,
    seed: options.seed ?? 'frozen-seed',
    styleVersion: options.version,
    ...(options.family ? { family: options.family } : {}),
    palette: options.palette ?? (options.family ? {} : TEST_PALETTE),
    ...(options.style === 'painted' ? { image: { src: 'https://example.org/painting.jpg', placeholder: 'data:placeholder', focus: { x: 0.3, y: 0.6 } } } : {}),
  });
  const canvas = new RecordingCanvas(Math.round(width * ratio), Math.round(height * ratio));
  const ctx = canvas.getContext('2d');
  const createLayer = layerFactory(recordingCanvasFactory(), Math.min(ratio, art.version.maxPixelRatio));
  const instance = art.version.create(
    buildSetup({
      art,
      width,
      height,
      pixelRatio: Math.min(ratio, art.version.maxPixelRatio),
      card: options.card ?? { x: width * 0.35, y: height * 0.2, width: width * 0.3, height: height * 0.6 },
      motion: true,
      createLayer,
      ...(options.style === 'painted' ? { image: { src: 'https://example.org/painting.jpg', placeholder: 'data:placeholder', focus: { x: 0.3, y: 0.6 } } } : {}),
      loadImage: fakeLoadImage as never,
      ...(options.siteName !== null && { siteName: options.siteName ?? 'Example Site' }),
    }),
  );
  return {
    canvas,
    ctx,
    instance,
    stillTime: art.version.stillTime,
    draw(frame) {
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      instance.draw(ctx as unknown as CanvasRenderingContext2D, frame);
    },
  };
}

/** Every registered style version: `{ style, version }`. */
export function allStyleVersions(): { style: string; version: number }[] {
  return STYLE_MODULES.flatMap((m) => m.versions.map((v) => ({ style: m.id, version: v.version })));
}

/**
 * The frozen reference for one style version: a still frame, three frames with the pointer near,
 * a tap, and one more frame, all recorded into one hash.
 */
export async function frozenHash(style: string, version: number): Promise<string> {
  const scene = createScene({ style, version });
  await Promise.resolve();
  await Promise.resolve();
  const t0 = scene.stillTime;
  scene.draw({ t: t0, dt: 0, pointer: { x: -1e6, y: -1e6, strength: 0 } });
  for (let i = 1; i <= 3; i++) scene.draw({ t: t0 + 1 + i / 30, dt: 1 / 30, pointer: { x: 70, y: 60, strength: 1 } });
  scene.instance.tap?.(40, 200, t0 + 1.2);
  scene.draw({ t: t0 + 2.5, dt: 1 / 30, pointer: { x: 290, y: 190, strength: 0.6 } });
  return scene.ctx.digest();
}
