/**
 * The plotter styles (county-survey, river-basins, star-chart): every subject key builds a sheet at
 * desktop and phone sizes without an error, the plot is finished by the version's `settlesAt`, the host's
 * subject choice is honoured (and an unknown one falls back to the seed), and the readout and taps work.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildSetup, layerFactory, resolveArt } from '../../src/backdrops/frame.js';
import type { StyleSetup } from '../../src/backdrops/styles/define.js';
import { buildFailures } from '../../src/backdrops/styles/plotter/v1.js';
import { backdropStyle } from '../../src/backdrops/styles/registry.js';
import { RecordingCanvas, RecordingContext, recordingCanvasFactory, resetCanvasIds } from './recording-canvas.js';

const PLOTTERS = ['county-survey', 'river-basins', 'star-chart'] as const;
const NONE = { x: -1e6, y: -1e6, strength: 0 };
const DESKTOP = { width: 1280, height: 800, card: { x: 420, y: 140, width: 440, height: 520 } };
const PHONE = { width: 390, height: 844, card: { x: 16, y: 104, width: 358, height: 620 } };

interface Size {
  width: number;
  height: number;
  card: { x: number; y: number; width: number; height: number };
}

function sheet(style: string, size: Size, extra: Partial<Pick<StyleSetup, 'subject' | 'subjectSet' | 'siteName'>> & { seed?: string; motion?: boolean } = {}) {
  resetCanvasIds();
  const art = resolveArt({ style: style as never, seed: extra.seed ?? 'plotter' });
  const instance = art.version.create(
    buildSetup({
      art,
      width: size.width,
      height: size.height,
      pixelRatio: 1,
      card: size.card,
      motion: extra.motion ?? true,
      createLayer: layerFactory(recordingCanvasFactory(), 1),
      ...(extra.subject !== undefined && { subject: extra.subject }),
      ...(extra.subjectSet !== undefined && { subjectSet: extra.subjectSet }),
      ...(extra.siteName !== undefined && { siteName: extra.siteName }),
    }),
  );
  const ctx = new RecordingCanvas(size.width, size.height).getContext('2d');
  return {
    instance,
    version: art.version,
    ctx,
    frame(t: number, pointer = NONE, dt = 1 / 30) {
      instance.draw(ctx as unknown as CanvasRenderingContext2D, { t, dt, pointer });
      return ctx.digest();
    },
  };
}

function keysOf(style: string): { set: string; keys: readonly string[] }[] {
  const subjects = backdropStyle(style)?.subjects;
  if (!subjects) throw new Error(`${style} has no subjects`);
  return Object.entries(subjects.sets).map(([set, keys]) => ({ set, keys }));
}

afterEach(() => {
  RecordingContext.countOnly = false;
  buildFailures.length = 0;
});

describe.each(PLOTTERS)('%s', (style) => {
  it('declares its subjects, with stable keys and labels', () => {
    const module = backdropStyle(style);
    expect(module?.subjects?.noun.length).toBeGreaterThan(3);
    expect(module?.interactivity).toBe('pointer');
    const version = module?.versions[0];
    expect(version?.settlesAt).toBeGreaterThan(20);
    expect(version?.settlesAt).toBeLessThanOrEqual(version?.stillTime ?? 0);
    for (const { keys } of keysOf(style)) for (const key of keys) expect(module?.subjects?.label?.(key).length).toBeGreaterThan(1);
  });

  it('builds every subject at desktop size, finished by settlesAt', () => {
    const seen = new Set<string>();
    for (const { set, keys } of keysOf(style)) {
      for (const key of keys) {
        if (seen.has(key)) continue;
        seen.add(key);
        const settled = sheet(style, DESKTOP, { subject: key, subjectSet: set });
        const a = settled.frame(settled.version.settlesAt ?? 0, NONE, 0);
        const later = sheet(style, DESKTOP, { subject: key, subjectSet: set });
        const b = later.frame(later.version.stillTime, NONE, 0);
        expect(a, `${style} ${key} is still plotting at settlesAt`).toBe(b);
      }
    }
    expect(buildFailures.map((f) => `${f.style}: ${String(f.error)}`)).toEqual([]);
  });

  it('builds at phone size and in a small preview without an error', () => {
    RecordingContext.countOnly = true;
    for (const { set, keys } of keysOf(style)) {
      for (const key of keys.slice(0, 12)) {
        sheet(style, PHONE, { subject: key, subjectSet: set }).frame(40);
        sheet(style, { width: 360, height: 240, card: { x: 126, y: 48, width: 108, height: 144 } }, { subject: key, subjectSet: set }).frame(40);
      }
    }
    expect(buildFailures.map((f) => `${f.style}: ${String(f.error)}`)).toEqual([]);
  });

  it("shows the host's subject, and picks one from the seed when it's absent or unknown", () => {
    const [first] = keysOf(style);
    const keys = first?.keys ?? [];
    const pick = (subject: string | undefined, seed = 'plotter') => sheet(style, DESKTOP, { seed, ...(subject !== undefined && { subject }) }).frame(40);
    expect(pick(keys[0])).not.toBe(pick(keys[1]));
    expect(pick('No such place')).toBe(pick(undefined));
    expect(pick(undefined, 'one')).toBe(pick(undefined, 'one'));
    const seeds = new Set(['a', 'b', 'c', 'd', 'e', 'f'].map((s) => pick(undefined, s)));
    expect(seeds.size).toBeGreaterThan(1);
  });

  it('letters the site name in the title block when given one', () => {
    const plain = sheet(style, DESKTOP, { subject: keysOf(style)[0]?.keys[0] as string }).frame(40);
    const named = sheet(style, DESKTOP, { subject: keysOf(style)[0]?.keys[0] as string, siteName: 'Example Site' }).frame(40);
    expect(named).not.toBe(plain);
  });

  it('draws the finished sheet at once without motion, and the same sheet at any time', () => {
    const a = sheet(style, DESKTOP, { motion: false }).frame(0);
    const b = sheet(style, DESKTOP, { motion: false }).frame(40);
    const c = sheet(style, DESKTOP, { motion: true }).frame(40, NONE, 0);
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it('answers the pointer with a crosshair and taps with ink, never under the card', () => {
    const s = sheet(style, DESKTOP);
    const plain = sheet(style, DESKTOP);
    for (let i = 0; i < 4; i++) {
      s.frame(40 + i / 30, { x: 200, y: 400, strength: 1 });
      plain.frame(40 + i / 30, NONE);
    }
    expect(s.ctx.digest()).not.toBe(plain.ctx.digest());
    // A tap on the card does nothing; one beside it stamps or letters something.
    const onCard = sheet(style, DESKTOP);
    const offCard = sheet(style, DESKTOP);
    const none = sheet(style, DESKTOP);
    onCard.instance.tap?.(600, 400, 40);
    offCard.instance.tap?.(200, 700, 40);
    expect(onCard.frame(41)).toBe(none.frame(41));
    expect(offCard.frame(41)).not.toBe(none.ctx.digest());
  });
});
