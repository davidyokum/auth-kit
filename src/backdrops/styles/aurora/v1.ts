/**
 * aurora v1. FROZEN once released (ADR 0020): add v2.ts for any change to what it draws.
 *
 * Soft curtains of light: a few silk ribbons, each a brighter core with a crisp lower edge and a long
 * fade upward, wander across the page in slow folds and shift between two brand tints, over two slow
 * glows. Computed as a small image (one pixel per 8 CSS pixels) and drawn enlarged, so it's smooth
 * and cheap; a fixed film of grain keeps the gradients from banding.
 */
import { mix, parseHex, type Rgb } from '../../kernel/v1/color.js';
import { createNoise } from '../../kernel/v1/noise.js';
import { createRng, hashParts } from '../../kernel/v1/prng.js';
import { TAU } from '../../kernel/v1/shape.js';
import { defineVersion } from '../define.js';

const STEP = 8;
const LUT_RES = 64;
const LUT_MAX = 4;

export const auroraV1 = defineVersion({
  version: 1,
  fps: 15,
  maxPixelRatio: 1,
  stillTime: 25,
  colors: (p) => ({
    top: mix(p.page, p.mist, 0.7),
    bottom: parseHex(p.page),
    ribbons: [
      [parseHex(p.glow), mix(p.primary, p.glow, 0.45)],
      [mix(p.primary, p.glow, 0.3), mix(p.secondary, p.glow, 0.2)],
      [mix(p.secondary, p.page, 0.25), parseHex(p.glow)],
      [mix(p.ink, p.glow, 0.55), mix(p.primary, p.page, 0.3)],
    ] as [Rgb, Rgb][],
    glow: mix(p.glow, p.page, 0.15),
    grain: parseHex(p.ink),
  }),
  create(setup, c) {
    const { width: w, height: h } = setup;
    const rng = createRng(hashParts('aurora', 1, setup.seed));
    const noise = createNoise(rng.fork('noise'));
    const gw = Math.ceil(w / STEP) + 2;
    const gh = Math.ceil(h / STEP) + 2;
    const field = setup.createLayer(gw, gh, 1);
    const fw = field.canvas.width;
    const fh = field.canvas.height;
    const image = field.ctx.createImageData(fw, fh);
    const data = image.data;

    // Ribbon profile: a broad soft body plus a narrow bright core (the silk sheen).
    const lut = new Float32Array(LUT_RES * LUT_MAX + 2);
    for (let i = 0; i < lut.length; i++) {
      const u = i / LUT_RES;
      lut[i] = Math.min(1, 0.72 * Math.exp(-u * u * 1.4) + 0.5 * Math.exp(-u * u * 9));
    }

    const rowR = new Float32Array(fh);
    const rowG = new Float32Array(fh);
    const rowB = new Float32Array(fh);
    for (let j = 0; j < fh; j++) {
      const t = Math.min(1, Math.max(0, j / (fh - 1)));
      const e = t * t * (3 - 2 * t);
      rowR[j] = c.top[0] + (c.bottom[0] - c.top[0]) * e;
      rowG[j] = c.top[1] + (c.bottom[1] - c.top[1]) * e;
      rowB[j] = c.top[2] + (c.bottom[2] - c.top[2]) * e;
    }

    const shape = rng.fork('ribbons');
    const ribbons = 2 + shape.int(2);
    const yBase = new Float32Array(ribbons);
    const amp = new Float32Array(ribbons);
    const freq = new Float32Array(ribbons);
    const speed = new Float32Array(ribbons);
    const up = new Float32Array(ribbons);
    const down = new Float32Array(ribbons);
    const strength = new Float32Array(ribbons);
    const tilt = new Float32Array(ribbons);
    const colorA = new Float32Array(ribbons * 3);
    const colorB = new Float32Array(ribbons * 3);
    const palette = shape.shuffle([0, 1, 2, 3]);
    const band = shape.range(0.12, 0.3);
    for (let r = 0; r < ribbons; r++) {
      yBase[r] = h * (band + ((1 - band * 2) * (r + shape.range(0.15, 0.85))) / ribbons);
      amp[r] = h * shape.range(0.07, 0.15);
      freq[r] = shape.range(0.45, 1.0) / Math.max(600, w);
      speed[r] = shape.range(0.01, 0.024);
      up[r] = shape.range(110, 230);
      down[r] = shape.range(22, 46);
      strength[r] = shape.range(0.55, 0.85);
      tilt[r] = shape.range(-0.18, 0.18);
      const pair = c.ribbons[palette[r] as number] as [Rgb, Rgb];
      for (let k = 0; k < 3; k++) {
        colorA[r * 3 + k] = pair[0][k] as number;
        colorB[r * 3 + k] = pair[1][k] as number;
      }
    }
    const center = new Float32Array(ribbons * fw);
    const thick = new Float32Array(ribbons * fw);
    const shimmer = new Float32Array(ribbons * fw);
    const cr = new Float32Array(ribbons * fw);
    const cg = new Float32Array(ribbons * fw);
    const cb = new Float32Array(ribbons * fw);

    // Two slow glows behind the curtains.
    const glowX = new Float32Array(2);
    const glowY = new Float32Array(2);
    const glowR = new Float32Array(2);
    const glowPhase = new Float32Array(2);
    for (let g = 0; g < 2; g++) {
      glowX[g] = shape.range(0.1, 0.9) * w;
      glowY[g] = shape.range(0.1, 0.9) * h;
      glowR[g] = shape.range(0.22, 0.38) * Math.max(w, h);
      glowPhase[g] = shape.range(0, TAU);
    }

    // A fixed film of grain over the enlarged image, so gradients don't band.
    const grain = setup.createLayer(w, h, Math.min(setup.pixelRatio, 1));
    const tile = setup.createLayer(128, 128, 1);
    const tileImage = tile.ctx.createImageData(tile.canvas.width, tile.canvas.height);
    const grainRng = rng.fork('grain');
    for (let o = 0; o < tileImage.data.length; o += 4) {
      tileImage.data[o] = c.grain[0];
      tileImage.data[o + 1] = c.grain[1];
      tileImage.data[o + 2] = c.grain[2];
      tileImage.data[o + 3] = Math.round(grainRng.next() * 12);
    }
    tile.ctx.putImageData(tileImage, 0, 0);
    const pattern = grain.ctx.createPattern(tile.canvas, 'repeat');
    if (pattern) {
      grain.ctx.fillStyle = pattern;
      grain.ctx.fillRect(0, 0, w, h);
    }

    return {
      draw(ctx, frame) {
        const t = frame.t;
        for (let r = 0; r < ribbons; r++) {
          const f = freq[r] as number;
          const sp = speed[r] as number;
          for (let i = 0; i < fw; i++) {
            const x = (i - 1) * STEP;
            const k = r * fw + i;
            center[k] = (yBase[r] as number) + (amp[r] as number) * noise.noise2(x * f + r * 17.3, t * sp) + (tilt[r] as number) * (x - w / 2);
            thick[k] = 0.85 + 0.22 * noise.noise2(x * f * 1.7 + 71.1, t * sp * 1.3 + r);
            // Slow folds along the curtain, never finer than the image's resolution can carry.
            shimmer[k] = (0.74 + 0.26 * noise.noise2(x * 0.0032 + r * 13.7, t * 0.025)) * (strength[r] as number);
            const m = 0.5 + 0.5 * noise.noise2(x * 0.0014 + r * 5.1, t * 0.01);
            cr[k] = (colorA[r * 3] as number) + ((colorB[r * 3] as number) - (colorA[r * 3] as number)) * m;
            cg[k] = (colorA[r * 3 + 1] as number) + ((colorB[r * 3 + 1] as number) - (colorA[r * 3 + 1] as number)) * m;
            cb[k] = (colorA[r * 3 + 2] as number) + ((colorB[r * 3 + 2] as number) - (colorA[r * 3 + 2] as number)) * m;
          }
        }
        const g0x = (glowX[0] as number) + Math.sin(t * 0.02 + (glowPhase[0] as number)) * w * 0.08;
        const g0y = (glowY[0] as number) + Math.cos(t * 0.016 + (glowPhase[0] as number)) * h * 0.08;
        const g1x = (glowX[1] as number) + Math.sin(t * 0.018 + (glowPhase[1] as number)) * w * 0.08;
        const g1y = (glowY[1] as number) + Math.cos(t * 0.022 + (glowPhase[1] as number)) * h * 0.08;
        const g0r = 1 / (glowR[0] as number);
        const g1r = 1 / (glowR[1] as number);
        const gr = c.glow[0];
        const gg = c.glow[1];
        const gb = c.glow[2];
        let o = 0;
        for (let j = 0; j < fh; j++) {
          const y = (j - 1) * STEP;
          const br = rowR[j] as number;
          const bg = rowG[j] as number;
          const bb = rowB[j] as number;
          for (let i = 0; i < fw; i++) {
            const x = (i - 1) * STEP;
            let red = br;
            let green = bg;
            let blue = bb;
            const d0x = (x - g0x) * g0r;
            const d0y = (y - g0y) * g0r;
            const d1x = (x - g1x) * g1r;
            const d1y = (y - g1y) * g1r;
            const q0 = Math.max(0, 1 - (d0x * d0x + d0y * d0y));
            const q1 = Math.max(0, 1 - (d1x * d1x + d1y * d1y));
            const glow = 0.42 * (q0 * q0 + q1 * q1);
            red += (gr - red) * glow;
            green += (gg - green) * glow;
            blue += (gb - blue) * glow;
            for (let r = 0; r < ribbons; r++) {
              const k = r * fw + i;
              const d = y - (center[k] as number);
              const th = thick[k] as number;
              const u = d < 0 ? -d / ((up[r] as number) * th) : d / ((down[r] as number) * th);
              if (u >= LUT_MAX) continue;
              const intensity = (lut[(u * LUT_RES) | 0] as number) * (shimmer[k] as number);
              red += ((cr[k] as number) - red) * intensity;
              green += ((cg[k] as number) - green) * intensity;
              blue += ((cb[k] as number) - blue) * intensity;
            }
            data[o] = red;
            data[o + 1] = green;
            data[o + 2] = blue;
            data[o + 3] = 255;
            o += 4;
          }
        }
        field.ctx.putImageData(image, 0, 0);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(field.canvas, -1.5 * STEP, -1.5 * STEP, fw * STEP, fh * STEP);
        ctx.drawImage(grain.canvas, 0, 0, w, h);
      },
      hot: [noise.noise2],
    };
  },
});
