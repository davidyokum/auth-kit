/**
 * constellation v1. FROZEN once released (ADR 0020): add v2.ts for any change to what it draws.
 *
 * Points spread by best-candidate sampling (even, never gridded), thinner near the card, each
 * drifting on its own slow orbit. Faint links join near neighbors, fading with distance; a few
 * brighter stars carry a halo; a soft nebula sits behind. Near the pointer, points brighten and
 * reach for it with links in the brand color.
 */
import { mix, rgba } from '../../kernel/v1/color.js';
import { createNoise } from '../../kernel/v1/noise.js';
import { createRng, hashParts } from '../../kernel/v1/prng.js';
import { cardDistance, TAU } from '../../kernel/v1/shape.js';
import { type Ctx2D, defineVersion } from '../define.js';

const LINK_LEVELS = 4;
const POINTER_LEVELS = 3;

function grown(buffer: Float32Array<ArrayBuffer>): Float32Array<ArrayBuffer> {
  const next = new Float32Array(buffer.length * 2);
  next.set(buffer);
  return next;
}

export const constellationV1 = defineVersion({
  version: 1,
  fps: 30,
  maxPixelRatio: 2,
  stillTime: 20,
  colors: (p) => ({
    page: p.page,
    links: [0.06, 0.1, 0.15, 0.22].map((a) => rgba(p.ink, a)),
    reach: [0.16, 0.3, 0.48].map((a) => rgba(p.primary, a)),
    dot: rgba(p.ink, 0.42),
    bright: rgba(mix(p.primary, p.secondary, 0.2), 0.85),
    halo: p.glow,
    nebula: mix(p.glow, p.page, 0.25),
    nebula2: mix(p.mist, p.secondary, 0.12),
  }),
  create(setup, c) {
    const { width: w, height: h, card } = setup;
    const rng = createRng(hashParts('constellation', 1, setup.seed));
    const noise = createNoise(rng.fork('noise'));
    const n = Math.round(Math.max(36, Math.min(130, (w * h) / 14500)));
    const ax = new Float32Array(n);
    const ay = new Float32Array(n);
    const rx = new Float32Array(n);
    const ry = new Float32Array(n);
    const wx = new Float32Array(n);
    const wy = new Float32Array(n);
    const phx = new Float32Array(n);
    const phy = new Float32Array(n);
    const size = new Float32Array(n);
    const weight = new Float32Array(n);
    const star = new Uint8Array(n);
    const px = new Float32Array(n);
    const py = new Float32Array(n);
    const near = new Float32Array(n);

    // Best-candidate sampling, scored down near the card.
    const sample = rng.fork('points');
    for (let i = 0; i < n; i++) {
      let bestX = 0;
      let bestY = 0;
      let bestScore = -1;
      for (let k = 0; k < 12; k++) {
        const x = sample.range(-20, w + 20);
        const y = sample.range(-20, h + 20);
        let nearest = Infinity;
        for (let j = 0; j < i; j++) {
          const dx = (ax[j] as number) - x;
          const dy = (ay[j] as number) - y;
          nearest = Math.min(nearest, dx * dx + dy * dy);
        }
        const score = Math.sqrt(nearest) * (0.3 + 0.7 * cardDistance(x, y, card, w, h));
        if (score > bestScore) {
          bestScore = score;
          bestX = x;
          bestY = y;
        }
      }
      ax[i] = bestX;
      ay[i] = bestY;
      rx[i] = sample.range(6, 24);
      ry[i] = sample.range(6, 24);
      wx[i] = sample.range(0.04, 0.14) * (sample.chance(0.5) ? 1 : -1);
      wy[i] = sample.range(0.04, 0.14) * (sample.chance(0.5) ? 1 : -1);
      phx[i] = sample.range(0, TAU);
      phy[i] = sample.range(0, TAU);
      star[i] = sample.chance(0.12) ? 1 : 0;
      size[i] = star[i] ? sample.range(2, 3) : sample.range(0.9, 1.7);
      weight[i] = 0.35 + 0.65 * cardDistance(bestX, bestY, card, w, h);
    }
    const linkDist = Math.max(110, Math.min(190, Math.sqrt((w * h) / n) * 1.45));
    const reach = Math.max(150, Math.min(230, Math.min(w, h) * 0.25));

    // The nebula: a small image drawn enlarged.
    const nw = Math.ceil(w / 16) + 1;
    const nh = Math.ceil(h / 16) + 1;
    const nebula = setup.createLayer(nw, nh, 1);
    const nebulaImage = nebula.ctx.createImageData(nebula.canvas.width, nebula.canvas.height);
    const offX = rng.range(-200, 200);
    const offY = rng.range(-200, 200);
    for (let j = 0; j < nebula.canvas.height; j++) {
      for (let i = 0; i < nebula.canvas.width; i++) {
        const v = noise.fbm2(i * 0.045 + offX, j * 0.045 + offY, 3);
        const v2 = noise.fbm2(i * 0.03 - offY, j * 0.03 + offX, 2);
        const a = Math.max(0, v) * 0.7;
        const b = Math.max(0, v2) * 0.5;
        const o = (j * nebula.canvas.width + i) * 4;
        const total = Math.min(1, a + b);
        const mixT = a + b > 0 ? b / (a + b) : 0;
        nebulaImage.data[o] = c.nebula[0] + (c.nebula2[0] - c.nebula[0]) * mixT;
        nebulaImage.data[o + 1] = c.nebula[1] + (c.nebula2[1] - c.nebula[1]) * mixT;
        nebulaImage.data[o + 2] = c.nebula[2] + (c.nebula2[2] - c.nebula[2]) * mixT;
        nebulaImage.data[o + 3] = Math.round(total * 255);
      }
    }
    nebula.ctx.putImageData(nebulaImage, 0, 0);

    // A star's halo, painted once.
    const halo = setup.createLayer(40, 40);
    const haloGradient = halo.ctx.createRadialGradient(20, 20, 0, 20, 20, 20);
    haloGradient.addColorStop(0, rgba(c.halo, 0.75));
    haloGradient.addColorStop(0.35, rgba(c.halo, 0.25));
    haloGradient.addColorStop(1, rgba(c.halo, 0));
    halo.ctx.fillStyle = haloGradient;
    halo.ctx.fillRect(0, 0, 40, 40);

    const buffers: Float32Array<ArrayBuffer>[] = [];
    const counts = new Uint32Array(LINK_LEVELS + POINTER_LEVELS);
    for (let b = 0; b < LINK_LEVELS + POINTER_LEVELS; b++) buffers.push(new Float32Array(n * 16));

    function push(b: number, x1: number, y1: number, x2: number, y2: number): void {
      let buffer = buffers[b] as Float32Array<ArrayBuffer>;
      const at = counts[b] as number;
      if (at + 4 > buffer.length) {
        buffer = grown(buffer);
        buffers[b] = buffer;
      }
      buffer[at] = x1;
      buffer[at + 1] = y1;
      buffer[at + 2] = x2;
      buffer[at + 3] = y2;
      counts[b] = at + 4;
    }

    function strokeBucket(ctx: Ctx2D, b: number): void {
      const count = counts[b] as number;
      if (count === 0) return;
      const buffer = buffers[b] as Float32Array;
      ctx.beginPath();
      for (let s = 0; s < count; s += 4) {
        ctx.moveTo(buffer[s] as number, buffer[s + 1] as number);
        ctx.lineTo(buffer[s + 2] as number, buffer[s + 3] as number);
      }
      ctx.stroke();
    }

    return {
      draw(ctx, frame) {
        const t = frame.t;
        ctx.globalAlpha = 1;
        ctx.fillStyle = c.page;
        ctx.fillRect(0, 0, w, h);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(nebula.canvas, -8, -8, nebula.canvas.width * 16, nebula.canvas.height * 16);
        const pX = frame.pointer.x;
        const pY = frame.pointer.y;
        const strength = frame.pointer.strength;
        const reach2 = reach * reach;
        counts.fill(0);
        for (let i = 0; i < n; i++) {
          const x = (ax[i] as number) + (rx[i] as number) * Math.sin(t * (wx[i] as number) + (phx[i] as number));
          const y = (ay[i] as number) + (ry[i] as number) * Math.cos(t * (wy[i] as number) + (phy[i] as number));
          px[i] = x;
          py[i] = y;
          let f = 0;
          if (strength > 0.01) {
            const dx = pX - x;
            const dy = pY - y;
            const d2 = dx * dx + dy * dy;
            if (d2 < reach2) {
              f = (1 - Math.sqrt(d2) / reach) * strength;
              let level = Math.floor(f * POINTER_LEVELS);
              if (level > POINTER_LEVELS - 1) level = POINTER_LEVELS - 1;
              push(LINK_LEVELS + level, x, y, pX, pY);
            }
          }
          near[i] = f;
        }
        const link2 = linkDist * linkDist;
        for (let i = 0; i < n; i++) {
          const xi = px[i] as number;
          const yi = py[i] as number;
          const wi = weight[i] as number;
          for (let j = i + 1; j < n; j++) {
            const dx = (px[j] as number) - xi;
            const dy = (py[j] as number) - yi;
            const d2 = dx * dx + dy * dy;
            if (d2 >= link2) continue;
            const closeness = 1 - Math.sqrt(d2) / linkDist;
            const wj = weight[j] as number;
            let level = Math.floor(closeness * closeness * LINK_LEVELS * (wi < wj ? wi : wj) * 1.6);
            if (level < 0) continue;
            if (level > LINK_LEVELS - 1) level = LINK_LEVELS - 1;
            push(level, xi, yi, px[j] as number, py[j] as number);
          }
        }
        ctx.lineWidth = 0.8;
        for (let b = 0; b < LINK_LEVELS; b++) {
          ctx.strokeStyle = c.links[b] as string;
          strokeBucket(ctx, b);
        }
        ctx.lineWidth = 1;
        for (let b = 0; b < POINTER_LEVELS; b++) {
          ctx.strokeStyle = c.reach[b] as string;
          strokeBucket(ctx, LINK_LEVELS + b);
        }
        for (let i = 0; i < n; i++) {
          if (star[i] === 1) ctx.drawImage(halo.canvas, (px[i] as number) - 20, (py[i] as number) - 20, 40, 40);
        }
        ctx.fillStyle = c.dot;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          if (star[i] === 1 || (near[i] as number) > 0.25) continue;
          const r = (size[i] as number) * (0.6 + 0.4 * (weight[i] as number));
          ctx.moveTo((px[i] as number) + r, py[i] as number);
          ctx.arc(px[i] as number, py[i] as number, r, 0, TAU);
        }
        ctx.fill();
        ctx.fillStyle = c.bright;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          if (star[i] !== 1 && (near[i] as number) <= 0.25) continue;
          const r = (size[i] as number) * (1 + (near[i] as number) * 0.6);
          ctx.moveTo((px[i] as number) + r, py[i] as number);
          ctx.arc(px[i] as number, py[i] as number, r, 0, TAU);
        }
        ctx.fill();
      },
      hot: [push, strokeBucket],
    };
  },
});
