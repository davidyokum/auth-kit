/**
 * yokum-magnetic's toy: the site's name in letters that fall when the pointer touches them, and the
 * rose magnet (shown only while a letter is away) that springs them all home on a tap.
 */
import './preload.js';
import { describe, expect, it } from 'vitest';
import type { FrameInput } from '../../src/backdrops/styles/define.js';
import { nullContext } from './recording-canvas.js';
import { createScene } from './scenes.js';

const NONE = { x: -1e6, y: -1e6, strength: 0 };
const W = 1440;
const H = 900;
const CARD = { x: 500, y: 300, width: 440, height: 500 };

/** A null context that notes each frame's letters (drawn home or loose) and whether the magnet showed. */
function watcher() {
  const ctx = nullContext() as unknown as Record<string, unknown>;
  const frame = { home: 0, loose: 0, magnet: false, depth: 0, fills: [] as { x: number; y: number }[] };
  ctx.save = () => void frame.depth++;
  ctx.restore = () => void frame.depth--;
  ctx.fillText = (_: string, x: number, y: number) => {
    if (frame.depth > 0) frame.loose++;
    else frame.home++;
    frame.fills.push({ x, y });
  };
  ctx.arc = () => {
    if (ctx.fillStyle === '#e11d48' || ctx.fillStyle === '#f43f5e') frame.magnet = true;
  };
  const reset = () => Object.assign(frame, { home: 0, loose: 0, magnet: false, depth: 0, fills: [] });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, frame, reset };
}

describe('yokum-magnetic', () => {
  it('letters the site name above the card on a wide screen, and falls apart where the pointer touches it', () => {
    const scene = createScene({ style: 'yokum-magnetic', version: 1, seed: 'toy', width: W, height: H, card: CARD, siteName: 'Example Site' });
    const w = watcher();
    const draw = (f: FrameInput) => {
      w.reset();
      scene.instance.draw(w.ctx, f);
    };
    draw({ t: 2, dt: 0, pointer: NONE });
    expect(w.frame.home).toBe(11); // "Example Site" without the space
    expect(w.frame.magnet).toBe(false);
    const ys = w.frame.fills.map((p) => p.y);
    for (const y of ys) expect(y).toBeLessThan(CARD.y);
    const first = w.frame.fills[0]!;
    // Brush across the first letter.
    let t = 3;
    for (let i = 0; i < 10; i++) draw({ t: (t += 1 / 30), dt: 1 / 30, pointer: { x: first.x + 4 + i, y: first.y - 20, strength: 1 } });
    expect(w.frame.loose).toBeGreaterThan(0);
    expect(w.frame.magnet).toBe(true);
    // The pointer leaves; the letter lands and stays down.
    for (let i = 0; i < 300; i++) draw({ t: (t += 1 / 30), dt: 1 / 30, pointer: NONE });
    expect(w.frame.loose).toBeGreaterThan(0);
    // A tap beside the magnet does nothing; a tap on it brings everything home.
    scene.instance.tap?.(W / 2, H - 40, t);
    for (let i = 0; i < 30; i++) draw({ t: (t += 1 / 30), dt: 1 / 30, pointer: NONE });
    expect(w.frame.loose).toBeGreaterThan(0);
    scene.instance.tap?.(W - 64, H - 64, t);
    for (let i = 0; i < 300; i++) draw({ t: (t += 1 / 30), dt: 1 / 30, pointer: NONE });
    expect(w.frame.loose).toBe(0);
    expect(w.frame.home).toBe(11);
    expect(w.frame.magnet).toBe(false);
  });

  it('puts the title below the card on a phone, never under it, and leaves it out with no site name', () => {
    const card = { x: 16, y: 104, width: 358, height: 420 };
    const phone = createScene({ style: 'yokum-magnetic', version: 1, seed: 'toy', width: 390, height: 844, card, siteName: 'Example Site' });
    const w = watcher();
    phone.instance.draw(w.ctx, { t: 2, dt: 0, pointer: NONE });
    expect(w.frame.home).toBe(11);
    for (const p of w.frame.fills) expect(p.y).toBeGreaterThan(card.y + card.height);
    // A taller card leaves no room below: the title moves above it rather than under it.
    const tall = { x: 16, y: 104, width: 358, height: 520 };
    const crowded = createScene({ style: 'yokum-magnetic', version: 1, seed: 'toy', width: 390, height: 844, card: tall, siteName: 'Example Site' });
    const above = watcher();
    crowded.instance.draw(above.ctx, { t: 2, dt: 0, pointer: NONE });
    expect(above.frame.home).toBe(11);
    for (const p of above.frame.fills) expect(p.y).toBeLessThan(tall.y);
    const none = createScene({ style: 'yokum-magnetic', version: 1, seed: 'toy', width: W, height: H, card: CARD, siteName: null });
    const quiet = watcher();
    none.instance.draw(quiet.ctx, { t: 2, dt: 0, pointer: NONE });
    expect(quiet.frame.home + quiet.frame.loose).toBe(0);
  });

  it('v2: on a phone the name sits above the card, at one size and place however tall the card grows (0.1.19)', () => {
    // The scene leaves 24 px + the version's nameRoom (64) above the card on a phone.
    const top = 24 + 64;
    const boxes = [451, 512, 560, 677].map((height) => {
      const card = { x: 16, y: top, width: 361, height };
      const scene = createScene({ style: 'yokum-magnetic', version: 2, seed: 'toy', width: 393, height: 659, card, siteName: 'Yokum Academy' });
      expect(scene.instance.siteNameShown?.()).toBe(true);
      const box = scene.instance.siteNameBox?.();
      expect(box).not.toBeNull();
      // Above the card, never under it.
      expect(box!.y + box!.height).toBeLessThanOrEqual(card.y - 8);
      return box!;
    });
    for (const box of boxes) expect(box).toEqual(boxes[0]);
    // A big enough size to read as the site's name, and inside the screen.
    expect(boxes[0]!.height).toBeGreaterThanOrEqual(36);
    expect(boxes[0]!.x).toBeGreaterThanOrEqual(0);
    expect(boxes[0]!.x + boxes[0]!.width).toBeLessThanOrEqual(393);
    // v1, the same cards: under the card, shrinking as it grows, and gone once there's no room.
    const v1 = [451, 600, 677].map((height) => {
      const scene = createScene({ style: 'yokum-magnetic', version: 1, seed: 'toy', width: 393, height: 852, card: { x: 16, y: 24, width: 361, height }, siteName: 'Yokum Academy' });
      return scene.instance.siteNameBox?.()?.height ?? 0;
    });
    expect(v1[0]).toBeGreaterThan(v1[1]!);
    expect(v1[1]).toBeGreaterThan(0);
    expect(v1[2]).toBe(0);
  });

  it('v2: on a phone with no room above the card (a scene that leaves none), the name goes below it, as in v1', () => {
    const card = { x: 16, y: 24, width: 361, height: 420 };
    const scene = createScene({ style: 'yokum-magnetic', version: 2, seed: 'toy', width: 393, height: 852, card, siteName: 'Yokum Academy' });
    const box = scene.instance.siteNameBox?.();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(card.y + card.height + 8);
  });

  it('v2 draws v1 on a wide screen 733 px or taller: the same letters in the same places, and the same filings', () => {
    const one = createScene({ style: 'yokum-magnetic', version: 1, seed: 'toy', width: W, height: H, card: CARD, siteName: 'Example Site' });
    const two = createScene({ style: 'yokum-magnetic', version: 2, seed: 'toy', width: W, height: H, card: CARD, siteName: 'Example Site' });
    const a = watcher();
    const b = watcher();
    one.instance.draw(a.ctx, { t: 2, dt: 0, pointer: NONE });
    two.instance.draw(b.ctx, { t: 2, dt: 0, pointer: NONE });
    expect(b.frame.fills).toEqual(a.frame.fills);
    expect(two.instance.siteNameBox?.()).toEqual(one.instance.siteNameBox?.());
  });

  it('v2: on a wide screen the name stays put when a tall card grows the page past a short window (v1 moved it)', () => {
    // A 1366 × 657 window: the scene leaves 56 + 64 px above the card; later screens grow the page down.
    const card = (height: number) => ({ x: 463, y: 120, width: 440, height });
    const boxes = (version: number) =>
      [657, 760, 900].map((h) => createScene({ style: 'yokum-magnetic', version, seed: 'toy', width: 1366, height: h, card: card(h - 200), siteName: 'Example Reports' }).instance.siteNameBox?.());
    const two = boxes(2);
    for (const box of two) {
      expect(box).not.toBeNull();
      expect(box).toEqual(two[0]);
      expect(box!.y + box!.height).toBeLessThanOrEqual(120 - 8);
    }
    const one = boxes(1);
    expect(one[1]).not.toEqual(one[0]);
  });

  it('v2: a long name wraps to two lines above the card, at one size and place, inside a small phone', () => {
    const name = 'Office of Regional Budget and Planning Partners';
    const one = (width: number, height: number) => {
      const card = { x: 16, y: 24 + 64, width: width - 32, height };
      const scene = createScene({ style: 'yokum-magnetic', version: 2, seed: 'toy', width, height: 568, card, siteName: name });
      const w = watcher();
      scene.instance.draw(w.ctx, { t: 2, dt: 0, pointer: NONE });
      return { box: scene.instance.siteNameBox?.() ?? null, rows: new Set(w.frame.fills.map((p) => Math.round(p.y))).size, card, letters: w.frame.home };
    };
    const runs = [420, 520, 620].map((h) => one(320, h));
    for (const run of runs) {
      expect(run.box).not.toBeNull();
      expect(run.box).toEqual(runs[0]!.box);
      expect(run.rows).toBe(2);
      expect(run.letters).toBe(name.replace(/ /g, '').length);
      expect(run.box!.y).toBeGreaterThanOrEqual(0);
      expect(run.box!.y + run.box!.height).toBeLessThanOrEqual(run.card.y - 8);
      expect(run.box!.x).toBeGreaterThanOrEqual(0);
      expect(run.box!.x + run.box!.width).toBeLessThanOrEqual(320);
    }
    // Bigger letters on two lines than the one line v1 would fit across a 320 px phone.
    const v1 = createScene({ style: 'yokum-magnetic', version: 1, seed: 'toy', width: 320, height: 568, card: { x: 16, y: 24, width: 288, height: 300 }, siteName: name });
    const v1Size = v1.instance.siteNameBox?.()?.height ?? 0;
    expect(runs[0]!.box!.height / 2).toBeGreaterThan(v1Size);
    // A short name stays on one line.
    const short = createScene({ style: 'yokum-magnetic', version: 2, seed: 'toy', width: 320, height: 568, card: { x: 16, y: 88, width: 288, height: 420 }, siteName: 'Example Reports' });
    const w = watcher();
    short.instance.draw(w.ctx, { t: 2, dt: 0, pointer: NONE });
    expect(new Set(w.frame.fills.map((p) => Math.round(p.y))).size).toBe(1);
  });

  it('v2: a name too long to letter is left out whole, never cut short', () => {
    const card = { x: 16, y: 88, width: 361, height: 451 };
    const long = createScene({ style: 'yokum-magnetic', version: 2, seed: 'toy', width: 393, height: 852, card, siteName: 'An Example Site '.repeat(6) });
    expect(long.instance.siteNameShown?.()).toBe(false);
    expect(long.instance.siteNameBox?.()).toBeNull();
  });

  it('draws the settled still under reduced motion: letters home whatever the pointer does', () => {
    const scene = createScene({ style: 'yokum-magnetic', version: 1, seed: 'toy', width: W, height: H, card: CARD });
    const w = watcher();
    scene.instance.draw(w.ctx, { t: 2, dt: 0, pointer: NONE });
    const first = w.frame.fills[0]!;
    // dt 0 (a still) never knocks a letter loose.
    for (let i = 0; i < 5; i++) {
      w.reset();
      scene.instance.draw(w.ctx, { t: 2, dt: 0, pointer: { x: first.x + 4, y: first.y - 20, strength: 1 } });
    }
    expect(w.frame.loose).toBe(0);
  });
});
