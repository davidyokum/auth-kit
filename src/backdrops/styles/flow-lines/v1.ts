/**
 * flow-lines v1. FROZEN once released (ADR 0020): add v2.ts for any change to what it draws.
 *
 * Long, fine curves traced through a slowly turning noise field, like iron filings or wind on a
 * map. Most are faint ink; some carry the brand colors; a few broad, pale strokes give depth. Near
 * the pointer the field swirls, so the lines part and bend around it.
 */
import { mix, rgba } from '../../kernel/v1/color.js';
import { createNoise } from '../../kernel/v1/noise.js';
import { createRng, hashParts } from '../../kernel/v1/prng.js';
import { cardDistance, TAU } from '../../kernel/v1/shape.js';
import { defineVersion } from '../define.js';

const GRID = 24;
const STEP = 3.4;
/** Stroke classes: faint ink, ink, brand, brand strong, second brand, broad pale glow. */
const WIDTHS = [0.7, 0.85, 0.8, 1.05, 0.9, 2.6];
const SHARES = [0.34, 0.2, 0.18, 0.08, 0.12, 0.08];

export const flowLinesV1 = defineVersion({
  version: 1,
  fps: 20,
  maxPixelRatio: 2,
  stillTime: 18,
  colors: (p) => ({
    page: p.page,
    strokes: [rgba(p.ink, 0.11), rgba(p.ink, 0.19), rgba(p.primary, 0.22), rgba(p.primary, 0.36), rgba(mix(p.secondary, p.glow, 0.2), 0.32), rgba(p.glow, 0.45)],
  }),
  create(setup, c) {
    const { width: w, height: h, card } = setup;
    const rng = createRng(hashParts('flow-lines', 1, setup.seed));
    const noise = createNoise(rng.fork('noise'));
    const gcols = Math.ceil(w / GRID) + 2;
    const grows = Math.ceil(h / GRID) + 2;
    const vx = new Float32Array(gcols * grows);
    const vy = new Float32Array(gcols * grows);
    const scale = rng.range(0.0009, 0.0019);
    const turns = rng.range(0.55, 1.05);
    const base = rng.range(0, TAU);
    const drift = rng.range(0.025, 0.045);
    const reach = Math.max(150, Math.min(240, Math.min(w, h) * 0.24));

    const count = Math.round(Math.max(140, Math.min(720, (w * h) / 2300)));
    const sx = new Float32Array(count);
    const sy = new Float32Array(count);
    const steps = new Uint8Array(count);
    const classes = new Uint8Array(count);
    const order = new Uint32Array(count);
    const starts = new Uint32Array(WIDTHS.length + 1);
    const pick = rng.fork('lines');
    let placed = 0;
    let guard = 0;
    while (placed < count && guard < count * 40) {
      guard++;
      const x = pick.range(-40, w + 40);
      const y = pick.range(-40, h + 40);
      if (!pick.chance(0.18 + 0.82 * cardDistance(x, y, card, w, h))) continue;
      sx[placed] = x;
      sy[placed] = y;
      steps[placed] = 28 + pick.int(70);
      let r = pick.next();
      let cls = 0;
      while (cls < SHARES.length - 1 && r > (SHARES[cls] as number)) {
        r -= SHARES[cls] as number;
        cls++;
      }
      classes[placed] = cls;
      placed++;
    }
    // Sort by class once, so each frame strokes one path per class.
    let acc = 0;
    for (let cls = 0; cls < WIDTHS.length; cls++) {
      starts[cls] = acc;
      for (let i = 0; i < placed; i++) if (classes[i] === cls) order[acc++] = i;
    }
    starts[WIDTHS.length] = acc;

    return {
      draw(ctx, frame) {
        ctx.fillStyle = c.page;
        ctx.fillRect(0, 0, w, h);
        const z = frame.t * drift;
        for (let j = 0; j < grows; j++) {
          for (let i = 0; i < gcols; i++) {
            const a = noise.noise3((i - 1) * GRID * scale, (j - 1) * GRID * scale, z) * Math.PI * 2 * turns + base;
            vx[j * gcols + i] = Math.cos(a);
            vy[j * gcols + i] = Math.sin(a);
          }
        }
        const px = frame.pointer.x;
        const py = frame.pointer.y;
        const strength = frame.pointer.strength;
        const reach2 = reach * reach;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        for (let cls = 0; cls < WIDTHS.length; cls++) {
          ctx.strokeStyle = c.strokes[cls] as string;
          ctx.lineWidth = WIDTHS[cls] as number;
          ctx.beginPath();
          const end = starts[cls + 1] as number;
          for (let q = starts[cls] as number; q < end; q++) {
            const line = order[q] as number;
            let x = sx[line] as number;
            let y = sy[line] as number;
            ctx.moveTo(x, y);
            const n = steps[line] as number;
            for (let s = 0; s < n; s++) {
              const gx = x / GRID + 1;
              const gy = y / GRID + 1;
              if (gx < 0 || gy < 0 || gx >= gcols - 1 || gy >= grows - 1) break;
              const i0 = Math.floor(gx);
              const j0 = Math.floor(gy);
              const fx = gx - i0;
              const fy = gy - j0;
              const k = j0 * gcols + i0;
              const v00x = vx[k] as number;
              const v10x = vx[k + 1] as number;
              const v01x = vx[k + gcols] as number;
              const v11x = vx[k + gcols + 1] as number;
              const v00y = vy[k] as number;
              const v10y = vy[k + 1] as number;
              const v01y = vy[k + gcols] as number;
              const v11y = vy[k + gcols + 1] as number;
              let dx = (v00x + (v10x - v00x) * fx) * (1 - fy) + (v01x + (v11x - v01x) * fx) * fy;
              let dy = (v00y + (v10y - v00y) * fx) * (1 - fy) + (v01y + (v11y - v01y) * fx) * fy;
              if (strength > 0.001) {
                const rx = x - px;
                const ry = y - py;
                const d2 = rx * rx + ry * ry;
                if (d2 < reach2) {
                  const d = Math.sqrt(d2) + 0.001;
                  const f = 1 - d / reach;
                  const pull = f * f * strength;
                  // Swirl around the pointer, and ease outward so the lines part.
                  dx += ((-ry / d) * 1.4 + (rx / d) * 0.6 - dx) * pull;
                  dy += ((rx / d) * 1.4 + (ry / d) * 0.6 - dy) * pull;
                }
              }
              const len = Math.sqrt(dx * dx + dy * dy) + 0.0001;
              x += (dx / len) * STEP;
              y += (dy / len) * STEP;
              ctx.lineTo(x, y);
            }
          }
          ctx.stroke();
        }
      },
      hot: [noise.noise3],
    };
  },
});
