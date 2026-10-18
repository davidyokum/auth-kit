/**
 * ripples v1. FROZEN once released (ADR 0021): add v2.ts for any change to what it draws.
 *
 * A still pond: a few sources away from the card send out packets of fine concentric rings that
 * widen and fade, sometimes seen at an angle (the rings flatten into ellipses). The rings are a
 * pure function of time, so nothing accumulates. A tap on the water starts a brighter ripple there.
 */
import { mix, rgba, toHex } from '../../kernel/v1/color.js';
import { createRng, hashParts } from '../../kernel/v1/prng.js';
import { cardDistance, TAU } from '../../kernel/v1/shape.js';
import { type Ctx2D, defineVersion } from '../define.js';

const LEVELS = 5;
const PACKET = [1, 0.55, 0.28];
const TAPS = 8;
const TAP_LIFE = 8;
const CAPACITY = 1200;

export const ripplesV1 = defineVersion({
  version: 1,
  fps: 24,
  maxPixelRatio: 2,
  stillTime: 23,
  colors: (p) => ({
    top: toHex(mix(p.page, p.mist, 0.55)),
    bottom: p.page,
    light: rgba(p.glow, 0.5),
    ink: [0.06, 0.1, 0.16, 0.23, 0.32].map((a) => rgba(p.ink, a)),
    accent: [0.1, 0.17, 0.26, 0.37, 0.52].map((a) => rgba(mix(p.primary, p.secondary, 0.3), a)),
  }),
  create(setup, c) {
    const { width: w, height: h, card } = setup;
    const rng = createRng(hashParts('ripples', 1, setup.seed));
    const squash = rng.pick([1, 0.86, 0.72]);
    const sources = 3 + rng.int(2);
    const sx = new Float32Array(sources);
    const sy = new Float32Array(sources);
    const period = new Float32Array(sources);
    const speed = new Float32Array(sources);
    const phase = new Float32Array(sources);
    const strength = new Float32Array(sources);
    const gap = new Float32Array(sources);
    const accent = new Uint8Array(sources);
    const place = rng.fork('sources');
    for (let s = 0; s < sources; s++) {
      let x = 0;
      let y = 0;
      for (let tries = 0; tries < 30; tries++) {
        x = place.range(0.04, 0.96) * w;
        y = place.range(0.06, 0.94) * h;
        if (cardDistance(x, y, card, w, h) > 0.3) break;
      }
      sx[s] = x;
      sy[s] = y;
      period[s] = place.range(11, 17);
      speed[s] = place.range(9, 14);
      phase[s] = place.range(0, 20);
      strength[s] = place.range(0.6, 1);
      gap[s] = place.range(8, 13);
      accent[s] = s === 0 || place.chance(0.3) ? 1 : 0;
    }
    const rMax = Math.max(w, h) * 0.4;

    // Still water: a gentle gradient and a soft light over each source.
    const water = setup.createLayer(w, h);
    const wc = water.ctx;
    const fall = wc.createLinearGradient(0, 0, 0, h);
    fall.addColorStop(0, c.top);
    fall.addColorStop(1, c.bottom);
    wc.fillStyle = fall;
    wc.fillRect(0, 0, w, h);
    for (let s = 0; s < sources; s++) {
      const r = rMax * 0.35;
      const light = wc.createRadialGradient(sx[s] as number, sy[s] as number, 0, sx[s] as number, sy[s] as number, r);
      light.addColorStop(0, c.light);
      light.addColorStop(1, rgba('#ffffff', 0));
      wc.fillStyle = light;
      wc.save();
      wc.translate(sx[s] as number, sy[s] as number);
      wc.scale(1, squash);
      wc.translate(-(sx[s] as number), -(sy[s] as number));
      wc.fillRect((sx[s] as number) - r, (sy[s] as number) - r, r * 2, r * 2);
      wc.restore();
    }

    const tapX = new Float32Array(TAPS);
    const tapY = new Float32Array(TAPS);
    const tapT = new Float32Array(TAPS).fill(-1000);
    let tapNext = 0;
    const ringX = new Float32Array(CAPACITY);
    const ringY = new Float32Array(CAPACITY);
    const ringR = new Float32Array(CAPACITY);
    const ringB = new Uint8Array(CAPACITY);
    const counts = new Uint32Array(LEVELS * 2);
    let rings = 0;

    function ring(x: number, y: number, r: number, alpha: number, isAccent: boolean): void {
      if (rings >= CAPACITY || alpha < 0.05 || r < 1) return;
      let level = Math.floor(alpha * LEVELS * 1.1);
      if (level > LEVELS - 1) level = LEVELS - 1;
      ringX[rings] = x;
      ringY[rings] = y;
      ringR[rings] = r;
      ringB[rings] = (isAccent ? LEVELS : 0) + level;
      rings++;
    }

    function strokeLevel(ctx: Ctx2D, b: number): void {
      ctx.beginPath();
      for (let i = 0; i < rings; i++) {
        if (ringB[i] !== b) continue;
        const r = ringR[i] as number;
        ctx.moveTo((ringX[i] as number) + r, ringY[i] as number);
        ctx.ellipse(ringX[i] as number, ringY[i] as number, r, r * squash, 0, 0, TAU);
      }
      ctx.stroke();
    }

    return {
      draw(ctx, frame) {
        const t = frame.t;
        ctx.globalAlpha = 1;
        ctx.drawImage(water.canvas, 0, 0, w, h);
        rings = 0;
        counts.fill(0);
        for (let s = 0; s < sources; s++) {
          const p = period[s] as number;
          const v = speed[s] as number;
          const base = (t + (phase[s] as number)) % p;
          for (let k = 0; k < 40; k++) {
            const r = v * (base + k * p);
            if (r > rMax) break;
            const fade = 1 - r / rMax;
            const grow = r < 36 ? r / 36 : 1;
            const a = (strength[s] as number) * fade * fade * grow * grow * (3 - 2 * grow);
            for (let m = 0; m < 3; m++) ring(sx[s] as number, sy[s] as number, r - m * (gap[s] as number), a * (PACKET[m] as number), accent[s] === 1);
          }
        }
        for (let i = 0; i < TAPS; i++) {
          const age = t - (tapT[i] as number);
          if (age < 0 || age > TAP_LIFE) continue;
          const r = 8 + 40 * age;
          const fade = 1 - age / TAP_LIFE;
          for (let m = 0; m < 3; m++) ring(tapX[i] as number, tapY[i] as number, r - m * 11, fade * fade * 1.1 * (PACKET[m] as number), true);
        }
        for (let i = 0; i < rings; i++) counts[ringB[i] as number] = (counts[ringB[i] as number] as number) + 1;
        ctx.lineWidth = 1.15;
        for (let b = 0; b < LEVELS * 2; b++) {
          if (counts[b] === 0) continue;
          ctx.strokeStyle = (b < LEVELS ? c.ink[b] : c.accent[b - LEVELS]) as string;
          strokeLevel(ctx, b);
        }
      },
      tap(x, y, t) {
        tapX[tapNext] = x;
        tapY[tapNext] = y;
        tapT[tapNext] = t;
        tapNext = (tapNext + 1) % TAPS;
      },
      hot: [ring, strokeLevel],
    };
  },
});
