/**
 * magnetic-dots v1. FROZEN once released (ADR 0020): add v2.ts for any change to what it draws.
 *
 * A hexagonal dot field read as halftone: dot size follows a long, noise-warped wave, so bands of
 * larger dots flow slowly across the page like dunes, and where a second, slower wave crests the
 * dots take the brand color. Dots near the pointer lean toward it on springs and swell a little.
 */
import { mix, rgba } from '../../kernel/v1/color.js';
import { createNoise } from '../../kernel/v1/noise.js';
import { createRng, hashParts } from '../../kernel/v1/prng.js';
import { cardDistance, smoothstep, TAU } from '../../kernel/v1/shape.js';
import { defineVersion } from '../define.js';

const LEVELS = 5;

export const magneticDotsV1 = defineVersion({
  version: 1,
  fps: 30,
  maxPixelRatio: 2,
  stillTime: 12,
  colors: (p) => ({
    page: p.page,
    ink: [0.09, 0.15, 0.22, 0.3, 0.4].map((a) => rgba(p.ink, a)),
    accent: [0.2, 0.32, 0.45, 0.58, 0.72].map((a) => rgba(mix(p.primary, p.secondary, 0.25), a)),
  }),
  create(setup, c) {
    const { width: w, height: h, card } = setup;
    const rng = createRng(hashParts('magnetic-dots', 1, setup.seed));
    const noise = createNoise(rng.fork('noise'));
    const spacing = rng.range(17, 24);
    const rowStep = spacing * 0.8660254;
    const cols = Math.ceil(w / spacing) + 2;
    const rows = Math.ceil(h / rowStep) + 2;
    const n = cols * rows;
    const angle = rng.range(0, TAU);
    const waveX = Math.cos(angle);
    const waveY = Math.sin(angle);
    const wavelength = rng.range(260, 420);
    const waveSpeed = rng.range(0.12, 0.22) * (rng.chance(0.5) ? 1 : -1);
    const warp = rng.range(1.6, 2.6);
    const warpScale = rng.range(0.0016, 0.0028);
    const accentAngle = angle + rng.range(0.9, 2.2);
    const accentX = Math.cos(accentAngle);
    const accentY = Math.sin(accentAngle);
    const accentLength = wavelength * rng.range(1.6, 2.4);
    const accentSpeed = waveSpeed * rng.range(0.3, 0.6);
    const drift = rng.range(0.03, 0.05);
    const reach = Math.max(140, Math.min(220, Math.min(w, h) * 0.22));
    const lean = spacing * 1.15;

    const bx = new Float32Array(n);
    const by = new Float32Array(n);
    const ox = new Float32Array(n);
    const oy = new Float32Array(n);
    const weight = new Float32Array(n);
    const radius = new Float32Array(n);
    const bucket = new Uint8Array(n);
    const order = new Uint32Array(n);
    const counts = new Uint32Array(LEVELS * 2 + 1);
    const starts = new Uint32Array(LEVELS * 2 + 1);

    let k = 0;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const x = (i - 1 + (j % 2 ? 0.5 : 0)) * spacing + rng.range(-0.12, 0.12) * spacing;
        const y = (j - 1) * rowStep + rng.range(-0.12, 0.12) * spacing;
        bx[k] = x;
        by[k] = y;
        weight[k] = 0.35 + 0.65 * smoothstep(0, 1, cardDistance(x, y, card, w, h));
        k++;
      }
    }

    return {
      draw(ctx, frame) {
        ctx.fillStyle = c.page;
        ctx.fillRect(0, 0, w, h);
        const t = frame.t;
        const px = frame.pointer.x;
        const py = frame.pointer.y;
        const strength = frame.pointer.strength;
        const ease = 1 - Math.exp(-frame.dt * 9);
        const reach2 = reach * reach;
        const k1 = TAU / wavelength;
        const k2 = TAU / accentLength;
        const phase1 = t * waveSpeed;
        const phase2 = t * accentSpeed;
        const fz = t * drift;
        counts.fill(0);
        for (let i = 0; i < n; i++) {
          const x = bx[i] as number;
          const y = by[i] as number;
          let tx = 0;
          let ty = 0;
          let pull = 0;
          if (strength > 0.001) {
            const dx = px - x;
            const dy = py - y;
            const d2 = dx * dx + dy * dy;
            if (d2 < reach2) {
              const d = Math.sqrt(d2) + 0.001;
              const f = 1 - d / reach;
              pull = f * f * strength;
              tx = (dx / d) * pull * lean;
              ty = (dy / d) * pull * lean;
            }
          }
          ox[i] = (ox[i] as number) + (tx - (ox[i] as number)) * ease;
          oy[i] = (oy[i] as number) + (ty - (oy[i] as number)) * ease;
          const bend = noise.noise3(x * warpScale, y * warpScale, fz) * warp;
          const wave = 0.5 + 0.5 * Math.sin((x * waveX + y * waveY) * k1 + phase1 + bend);
          const u = smoothstep(0.18, 1, wave);
          const r = (0.4 + 2.5 * u * u) * (weight[i] as number) * (1 + pull * 0.9);
          radius[i] = r;
          if (r < 0.45) {
            bucket[i] = LEVELS * 2;
            continue;
          }
          let level = Math.floor(u * LEVELS + pull * 2);
          if (level > LEVELS - 1) level = LEVELS - 1;
          const crest = Math.sin((x * accentX + y * accentY) * k2 + phase2 + bend * 0.6);
          const b = ((crest > 0.82 && u > 0.35) || pull > 0.3 ? LEVELS : 0) + level;
          bucket[i] = b;
          counts[b] = (counts[b] as number) + 1;
        }
        let acc = 0;
        for (let b = 0; b <= LEVELS * 2; b++) {
          starts[b] = acc;
          acc += counts[b] as number;
        }
        counts.fill(0);
        for (let i = 0; i < n; i++) {
          const b = bucket[i] as number;
          if (b === LEVELS * 2) continue;
          order[(starts[b] as number) + (counts[b] as number)] = i;
          counts[b] = (counts[b] as number) + 1;
        }
        for (let b = 0; b < LEVELS * 2; b++) {
          const count = counts[b] as number;
          if (count === 0) continue;
          ctx.fillStyle = (b < LEVELS ? c.ink[b] : c.accent[b - LEVELS]) as string;
          ctx.beginPath();
          const s = starts[b] as number;
          for (let q = 0; q < count; q++) {
            const i = order[s + q] as number;
            const x = (bx[i] as number) + (ox[i] as number);
            const y = (by[i] as number) + (oy[i] as number);
            const r = radius[i] as number;
            ctx.moveTo(x + r, y);
            ctx.arc(x, y, r, 0, TAU);
          }
          ctx.fill();
        }
      },
      hot: [noise.noise3],
    };
  },
});
