/**
 * yokum-magnetic's toy: the site's name in letters that fall when the pointer touches them, and the
 * rose magnet (shown only while a letter is away) that springs them all home on a tap.
 */
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
