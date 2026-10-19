/**
 * Every style: deterministic from its seed, distinct across seeds and families, and cheap per frame
 * (a budget of canvas work, a time budget for the JavaScript, and no allocation on the per-frame path).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { BACKDROP_FAMILY_IDS } from '../../src/backdrops/families.js';
import { STYLE_MODULES } from '../../src/backdrops/styles/registry.js';
import { nullContext, RecordingContext } from './recording-canvas.js';
import { createScene } from './scenes.js';

const LATEST = STYLE_MODULES.map((m) => ({ style: m.id, version: m.versions.length, module: m }));
const NONE = { x: -1e6, y: -1e6, strength: 0 };

/** Upper bounds on one frame's canvas work at 1440 × 900 (about 1.5× what each style does today). */
const BUDGET: Record<string, { calls: number; segments: number }> = {
  'magnetic-dots': { calls: 4500, segments: 4500 },
  contours: { calls: 18000, segments: 18000 },
  'flow-lines': { calls: 38000, segments: 38000 },
  watercolor: { calls: 12, segments: 0 },
  aurora: { calls: 10, segments: 0 },
  'stained-glass': { calls: 120, segments: 120 },
  constellation: { calls: 1500, segments: 1500 },
  ripples: { calls: 2600, segments: 2600 },
  painted: { calls: 12, segments: 0 },
};

afterEach(() => {
  RecordingContext.countOnly = false;
});

describe.each(LATEST)('$style', ({ style, version, module }) => {
  it('draws the same frames for the same seed, and different ones for another seed or family', () => {
    const draw = (seed: string, family?: 'osbm' | 'unc' | 'personal') => {
      const scene = createScene({ style, version, seed, ...(family && { family }) });
      scene.draw({ t: scene.stillTime, dt: 0, pointer: NONE });
      return scene.ctx.digest();
    };
    expect(draw('alpha')).toBe(draw('alpha'));
    if (module.generative) {
      expect(draw('alpha')).not.toBe(draw('beta'));
      const byFamily = new Set(BACKDROP_FAMILY_IDS.map((f) => draw('alpha', f)));
      expect(byFamily.size).toBe(BACKDROP_FAMILY_IDS.length);
    }
  });

  it('animates (or, if static, stays put) and responds to the pointer where it says it does', () => {
    // A drawing that settles (a plotted sheet) is compared while it's still being drawn.
    const settles = module.versions[version - 1]!.settlesAt;
    const t0 = settles !== undefined ? settles * 0.25 : undefined;
    const still = createScene({ style, version, seed: 'motion' });
    still.draw({ t: t0 ?? still.stillTime, dt: 0, pointer: NONE });
    const a = still.ctx.digest();
    const later = createScene({ style, version, seed: 'motion' });
    later.draw({ t: (t0 ?? later.stillTime) + 4, dt: 0, pointer: NONE });
    if (version > 0 && module.versions[version - 1]!.fps > 0) expect(later.ctx.digest()).not.toBe(a);
    if (module.interactivity === 'pointer') {
      const away = createScene({ style, version, seed: 'pointer' });
      const near = createScene({ style, version, seed: 'pointer' });
      for (let i = 1; i <= 5; i++) {
        away.draw({ t: 10 + i / 30, dt: 1 / 30, pointer: NONE });
        near.draw({ t: 10 + i / 30, dt: 1 / 30, pointer: { x: 60, y: 60, strength: 1 } });
      }
      expect(near.ctx.digest()).not.toBe(away.ctx.digest());
    }
    if (module.interactivity === 'tap') {
      const plain = createScene({ style, version, seed: 'tap' });
      const tapped = createScene({ style, version, seed: 'tap' });
      tapped.instance.tap?.(40, 40, 10);
      plain.draw({ t: 10.5, dt: 1 / 30, pointer: NONE });
      tapped.draw({ t: 10.5, dt: 1 / 30, pointer: NONE });
      expect(tapped.ctx.digest()).not.toBe(plain.ctx.digest());
    }
  });

  it('keeps a frame within its canvas-work budget at 1440 × 900', () => {
    const scene = createScene({ style, version, seed: 'budget', width: 1440, height: 900, card: { x: 500, y: 200, width: 440, height: 500 } });
    RecordingContext.countOnly = true;
    for (let i = 0; i < 3; i++) scene.draw({ t: 5 + i / 30, dt: 1 / 30, pointer: { x: 300, y: 300, strength: 1 } });
    scene.ctx.resetCounts();
    scene.draw({ t: 5.2, dt: 1 / 30, pointer: { x: 300, y: 300, strength: 1 } });
    const budget = BUDGET[style];
    expect(budget, `add ${style} to BUDGET`).toBeDefined();
    expect(scene.ctx.counts.calls).toBeLessThanOrEqual(budget!.calls);
    expect(scene.ctx.counts.segments).toBeLessThanOrEqual(budget!.segments);
  });

  it('spends little JavaScript time per frame at 1440 × 900', () => {
    const scene = createScene({ style, version, seed: 'timing', width: 1440, height: 900, card: { x: 500, y: 200, width: 440, height: 500 } });
    const ctx = nullContext();
    const frame = (t: number) => scene.instance.draw(ctx, { t, dt: 1 / 30, pointer: { x: 300 + t, y: 300, strength: 1 } });
    for (let i = 0; i < 10; i++) frame(5 + i / 30);
    // The median of five batches, so one busy moment on a shared CI machine doesn't decide it.
    const batches = Array.from({ length: 5 }, (_, b) => {
      const start = performance.now();
      for (let i = 0; i < 10; i++) frame(6 + b + i / 30);
      return (performance.now() - start) / 10;
    }).sort((x, y) => x - y);
    // Generous; the browser numbers (art plus raster) are in the README.
    expect(batches[2]).toBeLessThan(10);
  });

  it('allocates nothing on the per-frame path (draw, tap, and the helpers it lists)', () => {
    const scene = createScene({ style, version, seed: 'alloc' });
    const fns = [scene.instance.draw, scene.instance.tap, ...(scene.instance.hot ?? [])].filter((f): f is (...args: never[]) => unknown => typeof f === 'function');
    const forbidden: [RegExp, string][] = [
      [/\bnew\s+[A-Za-z_$]/, 'new'],
      [/=>/, 'a closure'],
      [/\.(map|filter|forEach|reduce|slice|concat|flatMap|splice|join|split|toFixed)\(/, 'an allocating array or string method'],
      [/`/, 'a template string'],
      [/\.\.\./, 'a spread'],
      [/[=(,:]\s*\[/, 'an array literal'],
      [/(^|[=(,:]|return)\s*\{\s*[\w$'"]+\s*:/m, 'an object literal'],
      [/\bcreate(Linear|Radial|Conic)Gradient\b|\bcreatePattern\b|\bcreateImageData\b|\bgetImageData\b|\bJSON\./, 'a per-frame canvas object'],
    ];
    for (const fn of fns) {
      const source = fn.toString();
      const body = source.slice(source.indexOf('{'));
      for (const [pattern, what] of forbidden) expect(pattern.test(body), `${style}: ${fn.name || 'draw'} has ${what}:\n${body.slice(0, 200)}`).toBe(false);
    }
  });
});

describe('the registry', () => {
  it('lists unique IDs, versions in order, labels, and frame rates within 30', () => {
    const ids = STYLE_MODULES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['magnetic-dots', 'contours', 'flow-lines', 'watercolor', 'aurora', 'stained-glass', 'constellation', 'ripples', 'painted']);
    for (const m of STYLE_MODULES) {
      expect(m.label.length).toBeGreaterThan(2);
      m.versions.forEach((v, i) => {
        expect(v.version).toBe(i + 1);
        expect(v.fps).toBeLessThanOrEqual(30);
        expect(v.maxPixelRatio).toBeLessThanOrEqual(2);
      });
    }
  });
});
