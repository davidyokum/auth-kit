/**
 * A 2D canvas that draws nothing and records everything: every call and property write, with numbers
 * rounded to 0.01 px, folded into a SHA-256 hash. Same calls, same hash, on any machine, which a
 * pixel hash can't promise (anti-aliasing differs between Skia builds). That makes it the frozen
 * reference for a style version: what it asks the canvas to draw.
 *
 * It also counts work per frame (calls, path segments, fills, strokes, image copies), for budgets.
 */
import { createHash, type Hash } from 'node:crypto';

let nextId = 0;

export interface WorkCounts {
  calls: number;
  segments: number;
  fills: number;
  strokes: number;
  images: number;
  pixelsPut: number;
}

const SEGMENT_METHODS = new Set(['moveTo', 'lineTo', 'arc', 'ellipse', 'quadraticCurveTo', 'bezierCurveTo', 'rect', 'arcTo']);

function round(value: unknown): string {
  if (typeof value === 'number') return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : String(value);
  if (value instanceof RecordingCanvas) return `canvas#${value.id}:${value.contentHash()}`;
  if (value && typeof value === 'object' && 'describe' in value && typeof value.describe === 'function') return (value as { describe(): string }).describe();
  if (value && typeof value === 'object' && 'data' in value && 'width' in value) {
    const image = value as { width: number; height: number; data: Uint8ClampedArray };
    return `image(${image.width}x${image.height}:${createHash('sha256').update(image.data).digest('hex').slice(0, 16)})`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

class RecordingGradient {
  private readonly stops: string[] = [];
  constructor(private readonly spec: string) {}
  addColorStop(offset: number, color: string): void {
    this.stops.push(`${round(offset)}:${color}`);
  }
  describe(): string {
    return `gradient(${this.spec}|${this.stops.join(',')})`;
  }
}

export class RecordingContext {
  /** Counting only (no hashing): for timing a frame without the recorder's own cost dominating. */
  static countOnly = false;
  private hash: Hash = createHash('sha256');
  counts: WorkCounts = { calls: 0, segments: 0, fills: 0, strokes: 0, images: 0, pixelsPut: 0 };
  private readonly props: Record<string, unknown> = {
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    lineCap: 'butt',
    lineJoin: 'miter',
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'low',
  };

  constructor(readonly canvas: RecordingCanvas) {
    return new Proxy(this, {
      get: (target, key, receiver) => {
        if (typeof key === 'string' && key in target.props) return target.props[key];
        return Reflect.get(target, key, receiver) as unknown;
      },
      set: (target, key, value) => {
        if (typeof key === 'string' && !(key in target)) {
          target.props[key] = value;
          target.record(`${key}=`, [value]);
          return true;
        }
        return Reflect.set(target, key, value);
      },
    });
  }

  record(method: string, args: readonly unknown[]): void {
    this.counts.calls++;
    if (SEGMENT_METHODS.has(method)) this.counts.segments++;
    if (method === 'fill' || method === 'fillRect') this.counts.fills++;
    if (method === 'stroke') this.counts.strokes++;
    if (method === 'drawImage') this.counts.images++;
    if (RecordingContext.countOnly) return;
    this.hash.update(`${method}(${args.map(round).join(',')});`);
  }

  digest(): string {
    return this.hash.copy().digest('hex');
  }

  resetCounts(): void {
    this.counts = { calls: 0, segments: 0, fills: 0, strokes: 0, images: 0, pixelsPut: 0 };
  }

  // Path and drawing calls: recorded verbatim.
  beginPath(): void { this.record('beginPath', []); }
  closePath(): void { this.record('closePath', []); }
  moveTo(...a: number[]): void { this.record('moveTo', a); }
  lineTo(...a: number[]): void { this.record('lineTo', a); }
  arc(...a: unknown[]): void { this.record('arc', a); }
  arcTo(...a: number[]): void { this.record('arcTo', a); }
  ellipse(...a: unknown[]): void { this.record('ellipse', a); }
  quadraticCurveTo(...a: number[]): void { this.record('quadraticCurveTo', a); }
  bezierCurveTo(...a: number[]): void { this.record('bezierCurveTo', a); }
  rect(...a: number[]): void { this.record('rect', a); }
  fill(...a: unknown[]): void { this.record('fill', a); }
  stroke(...a: unknown[]): void { this.record('stroke', a); }
  clip(...a: unknown[]): void { this.record('clip', a); }
  fillRect(...a: number[]): void { this.record('fillRect', a); }
  clearRect(...a: number[]): void { this.record('clearRect', a); }
  strokeRect(...a: number[]): void { this.record('strokeRect', a); }
  save(): void { this.record('save', []); }
  restore(): void { this.record('restore', []); }
  translate(...a: number[]): void { this.record('translate', a); }
  rotate(...a: number[]): void { this.record('rotate', a); }
  scale(...a: number[]): void { this.record('scale', a); }
  setTransform(...a: number[]): void { this.record('setTransform', a); }
  drawImage(...a: unknown[]): void { this.record('drawImage', a); }
  createImageData(width: number, height: number): { width: number; height: number; data: Uint8ClampedArray } {
    this.record('createImageData', [width, height]);
    return { width, height, data: new Uint8ClampedArray(width * height * 4) };
  }
  putImageData(image: { width: number; height: number; data: Uint8ClampedArray }, ...a: number[]): void {
    this.counts.pixelsPut += image.width * image.height;
    this.record('putImageData', [image, ...a]);
  }
  createLinearGradient(...a: number[]): RecordingGradient {
    this.record('createLinearGradient', a);
    return new RecordingGradient(`linear:${a.map(round).join(',')}`);
  }
  createRadialGradient(...a: number[]): RecordingGradient {
    this.record('createRadialGradient', a);
    return new RecordingGradient(`radial:${a.map(round).join(',')}`);
  }
  createPattern(image: unknown, repetition: string): { describe(): string } {
    this.record('createPattern', [image, repetition]);
    const description = `pattern(${round(image)}|${repetition})`;
    return { describe: () => description };
  }
}

export class RecordingCanvas {
  readonly id = nextId++;
  private context: RecordingContext | null = null;
  constructor(
    public width = 300,
    public height = 150,
  ) {}
  getContext(_type: '2d', _options?: unknown): RecordingContext {
    this.context ??= new RecordingContext(this);
    return this.context;
  }
  /** What has been drawn on this canvas so far. */
  contentHash(): string {
    return this.context ? this.context.digest().slice(0, 16) : 'blank';
  }
  toDataURL(): string {
    return `data:image/png;base64,RECORDED-${this.contentHash()}`;
  }
}

/** A canvas factory for drawBackdropStill and renderers: every canvas records. */
export function recordingCanvasFactory(created: RecordingCanvas[] = []) {
  return (width: number, height: number) => {
    const canvas = new RecordingCanvas(width, height);
    created.push(canvas);
    return canvas as unknown as HTMLCanvasElement;
  };
}

/** Restarts canvas numbering, so a test's hashes don't depend on what ran before it. */
export function resetCanvasIds(): void {
  nextId = 0;
}

/** A context that does nothing at all (plain methods, no proxy): for timing a style's own JavaScript. */
export function nullContext(): CanvasRenderingContext2D {
  const noop = () => undefined;
  const ctx: Record<string, unknown> = {
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    lineCap: 'butt',
    lineJoin: 'miter',
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'low',
  };
  for (const name of ['beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'arcTo', 'ellipse', 'quadraticCurveTo', 'bezierCurveTo', 'rect', 'fill', 'stroke', 'clip', 'fillRect', 'clearRect', 'strokeRect', 'save', 'restore', 'translate', 'rotate', 'scale', 'setTransform', 'drawImage', 'putImageData']) {
    ctx[name] = noop;
  }
  return ctx as unknown as CanvasRenderingContext2D;
}
