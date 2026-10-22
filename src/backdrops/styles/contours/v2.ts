/**
 * contours v2. FROZEN once released (ADR 0021): add v3.ts for any change to what it draws.
 *
 * v1's topographic map, made smooth and alive (ADR 0026). v1 drew 6 frames a second, so the lines
 * stepped; v2 draws at the display's rate (up to 60) and a hill rises gently under the pointer, the
 * contours ringing around it, and settles back when the pointer leaves.
 *
 * Smooth for little work: the noise terrain is sampled as keyframes every `KEY_SECONDS` and each
 * frame blends the two around it, so a frame costs a blend, the tints, and the marching squares, not
 * three octaves of noise per sample. The next keyframe is computed a few rows per frame, ahead of
 * need. The picture at any `t` depends on `t` alone (stills and the frozen hash stay exact).
 */
import { mix, parseHex, rgba } from '../../kernel/v1/color.js';
import { createNoise } from '../../kernel/v1/noise.js';
import { createRng, hashParts } from '../../kernel/v1/prng.js';
import { defineVersion } from '../define.js';

const CELL = 11;
const RANGE = 0.82;
/** Seconds between terrain keyframes. The drift is slow enough that a linear blend is invisible. */
const KEY_SECONDS = 0.5;
/** The pointer's hill: its height (in field units; the terrain spans about ±0.82) and its radius (CSS px). */
const LIFT = 0.55;
const LIFT_SIGMA = 130;

/** Doubles a segment buffer. Rare (the first frames size it), so it's not on the per-frame path. */
function grown(buffer: Float32Array<ArrayBuffer>): Float32Array<ArrayBuffer> {
  const next = new Float32Array(buffer.length * 2);
  next.set(buffer);
  return next;
}

export const contoursV2 = defineVersion({
  version: 2,
  fps: 60,
  maxPixelRatio: 2,
  stillTime: 40,
  colors: (p) => ({
    page: p.page,
    line: rgba(p.ink, 0.18),
    index: rgba(mix(p.primary, p.ink, 0.15), 0.42),
    low: mix(p.page, p.mist, 0.75),
    high: mix(p.page, p.glow, 0.62),
  }),
  create(setup, c) {
    const { width: w, height: h } = setup;
    const rng = createRng(hashParts('contours', 2, setup.seed));
    const noise = createNoise(rng.fork('noise'));
    const cols = Math.ceil(w / CELL) + 2;
    const rows = Math.ceil(h / CELL) + 2;
    const field = new Float32Array(cols * rows);
    // Three keyframe slots: the two the current frame blends, and the next one, filled ahead.
    const slots = [new Float32Array(cols * rows), new Float32Array(cols * rows), new Float32Array(cols * rows)];
    const slotKey = [-1, -1, -1];
    /** Rows of the prefetched keyframe computed so far (rows means done). */
    const slotRows = [0, 0, 0];
    const levels = 10 + rng.int(7);
    const step = (RANGE * 2) / levels;
    const scale = rng.range(0.0011, 0.002);
    const stretch = rng.range(0.7, 1.35);
    const offX = rng.range(-500, 500);
    const offY = rng.range(-500, 500);
    const drift = rng.range(0.004, 0.008);
    const indexEvery = 5;
    const indexPhase = rng.int(indexEvery);

    // Terrace tints: one color per band, low (mist) to high (glow), alternating light and lighter.
    const low = c.low;
    const high = c.high;
    const pageRgb = parseHex(c.page);
    const lut = new Uint8ClampedArray((levels + 2) * 3);
    for (let b = 0; b < levels + 2; b++) {
      const t = b / (levels + 1);
      const base = mix(low, high, t);
      const tone = b % 2 === 0 ? 1 : 0.55;
      lut[b * 3] = pageRgb[0] + (base[0] - pageRgb[0]) * tone;
      lut[b * 3 + 1] = pageRgb[1] + (base[1] - pageRgb[1]) * tone;
      lut[b * 3 + 2] = pageRgb[2] + (base[2] - pageRgb[2]) * tone;
    }
    // Terraces at twice the field's resolution (bilinear between samples), so band edges stay soft.
    const tint = setup.createLayer(cols * 2, rows * 2, 1);
    const image = tint.ctx.createImageData(tint.canvas.width, tint.canvas.height);
    const pixels = image.data;
    const tintW = tint.canvas.width;
    const tintH = tint.canvas.height;

    // Segment buffers (x1, y1, x2, y2), grown by doubling if a frame ever needs more.
    let lines = new Float32Array(cols * rows * 4);
    let indexes = new Float32Array(cols * rows * 2);
    let lineCount = 0;
    let indexCount = 0;

    function push(isIndex: boolean, x1: number, y1: number, x2: number, y2: number): void {
      if (isIndex) {
        if (indexCount + 4 > indexes.length) indexes = grown(indexes);
        indexes[indexCount] = x1;
        indexes[indexCount + 1] = y1;
        indexes[indexCount + 2] = x2;
        indexes[indexCount + 3] = y2;
        indexCount += 4;
      } else {
        if (lineCount + 4 > lines.length) lines = grown(lines);
        lines[lineCount] = x1;
        lines[lineCount + 1] = y1;
        lines[lineCount + 2] = x2;
        lines[lineCount + 3] = y2;
        lineCount += 4;
      }
    }

    function march(): void {
      lineCount = 0;
      indexCount = 0;
      for (let j = 0; j < rows - 1; j++) {
        const y0 = (j - 1) * CELL;
        for (let i = 0; i < cols - 1; i++) {
          const x0 = (i - 1) * CELL;
          const a = field[j * cols + i] as number;
          const b = field[j * cols + i + 1] as number;
          const cc = field[(j + 1) * cols + i + 1] as number;
          const d = field[(j + 1) * cols + i] as number;
          const lo = Math.min(a, b, cc, d);
          const hi = Math.max(a, b, cc, d);
          let k = Math.ceil((lo + RANGE) / step);
          const kEnd = Math.floor((hi + RANGE) / step);
          if (k < 1) k = 1;
          for (; k <= kEnd && k < levels; k++) {
            const lv = k * step - RANGE;
            const code = (a > lv ? 8 : 0) | (b > lv ? 4 : 0) | (cc > lv ? 2 : 0) | (d > lv ? 1 : 0);
            if (code === 0 || code === 15) continue;
            const isIndex = (k + indexPhase) % indexEvery === 0;
            // Edge crossings: top (a-b), right (b-c), bottom (d-c), left (a-d).
            const tx = x0 + ((lv - a) / (b - a)) * CELL;
            const ry = y0 + ((lv - b) / (cc - b)) * CELL;
            const bx = x0 + ((lv - d) / (cc - d)) * CELL;
            const ly = y0 + ((lv - a) / (d - a)) * CELL;
            const x1 = x0 + CELL;
            const y1 = y0 + CELL;
            switch (code) {
              case 1:
              case 14:
                push(isIndex, x0, ly, bx, y1);
                break;
              case 2:
              case 13:
                push(isIndex, bx, y1, x1, ry);
                break;
              case 3:
              case 12:
                push(isIndex, x0, ly, x1, ry);
                break;
              case 4:
              case 11:
                push(isIndex, tx, y0, x1, ry);
                break;
              case 6:
              case 9:
                push(isIndex, tx, y0, bx, y1);
                break;
              case 7:
              case 8:
                push(isIndex, x0, ly, tx, y0);
                break;
              case 5:
                push(isIndex, x0, ly, tx, y0);
                push(isIndex, bx, y1, x1, ry);
                break;
              case 10:
                push(isIndex, tx, y0, x1, ry);
                push(isIndex, x0, ly, bx, y1);
                break;
              default:
                break;
            }
          }
        }
      }
    }

    /** Samples the terrain's rows [from, to) at keyframe `k` into `out`. */
    function sample(out: Float32Array, k: number, from: number, to: number): void {
      const z = k * KEY_SECONDS * drift;
      for (let j = from; j < to; j++) {
        const y = (j - 1) * CELL;
        for (let i = 0; i < cols; i++) {
          const x = (i - 1) * CELL;
          out[j * cols + i] = noise.fbm3(x * scale * stretch + offX, y * scale + offY, z, 3) * 1.25;
        }
      }
    }

    /** Keyframes k, k + 1, and k + 2 always land in different slots, so the blended pair is never evicted. */
    function slotFor(k: number): number {
      const s = ((k % 3) + 3) % 3;
      if (slotKey[s] !== k) {
        slotKey[s] = k;
        slotRows[s] = 0;
      }
      return s;
    }

    /** Computes up to `count` more rows of keyframe `k` (all of them by default) and returns its slot. */
    function fill(k: number, count = rows): number {
      const s = slotFor(k);
      const from = slotRows[s] as number;
      if (from < rows) {
        const to = Math.min(rows, from + count);
        sample(slots[s] as Float32Array, k, from, to);
        slotRows[s] = to;
      }
      return s;
    }

    /** Raises a soft hill under the pointer (the renderer eases `strength` in and out). */
    function lift(px: number, py: number, strength: number): void {
      if (!(strength > 0.001)) return;
      const reach = LIFT_SIGMA * 3;
      const i0 = Math.max(0, Math.floor((px - reach) / CELL) + 1);
      const i1 = Math.min(cols - 1, Math.ceil((px + reach) / CELL) + 1);
      const j0 = Math.max(0, Math.floor((py - reach) / CELL) + 1);
      const j1 = Math.min(rows - 1, Math.ceil((py + reach) / CELL) + 1);
      const inv = 1 / (2 * LIFT_SIGMA * LIFT_SIGMA);
      const height = LIFT * strength;
      for (let j = j0; j <= j1; j++) {
        const dy = (j - 1) * CELL - py;
        for (let i = i0; i <= i1; i++) {
          const dx = (i - 1) * CELL - px;
          field[j * cols + i] = (field[j * cols + i] as number) + height * Math.exp(-(dx * dx + dy * dy) * inv);
        }
      }
    }

    function stroke(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, buffer: Float32Array, count: number): void {
      ctx.beginPath();
      for (let s = 0; s < count; s += 4) {
        ctx.moveTo(buffer[s] as number, buffer[s + 1] as number);
        ctx.lineTo(buffer[s + 2] as number, buffer[s + 3] as number);
      }
      ctx.stroke();
    }

    return {
      draw(ctx, frame) {
        const at = frame.t / KEY_SECONDS;
        const key = Math.floor(at);
        const u = at - key;
        const fa = slots[fill(key)] as Float32Array;
        const fb = slots[fill(key + 1)] as Float32Array;
        // Fill the keyframe after next ahead of need: enough rows per frame to finish in about half a segment.
        const rowsPerFrame = Math.ceil(rows * Math.max(frame.dt, 1 / 60) * (2 / KEY_SECONDS)) + 1;
        fill(key + 2, rowsPerFrame);
        for (let k = 0; k < field.length; k++) field[k] = (fa[k] as number) + ((fb[k] as number) - (fa[k] as number)) * u;
        lift(frame.pointer.x, frame.pointer.y, frame.pointer.strength);
        // Terraces: two tint pixels per field sample each way, interpolated.
        let o = 0;
        for (let j = 0; j < tintH; j++) {
          const fy = j * 0.5;
          let j0 = fy | 0;
          if (j0 > rows - 2) j0 = rows - 2;
          const ty = fy - j0;
          for (let i = 0; i < tintW; i++) {
            const fx = i * 0.5;
            let i0 = fx | 0;
            if (i0 > cols - 2) i0 = cols - 2;
            const tx = fx - i0;
            const k = j0 * cols + i0;
            const top = (field[k] as number) + ((field[k + 1] as number) - (field[k] as number)) * tx;
            const bottom = (field[k + cols] as number) + ((field[k + cols + 1] as number) - (field[k + cols] as number)) * tx;
            const v = top + (bottom - top) * ty;
            const pos = (v + RANGE) / step + 1;
            let band = Math.floor(pos);
            if (band < 0) band = 0;
            if (band > levels) band = levels;
            // Blend into the next band over the last fifth, so terrace edges are soft, not stepped.
            let blend = (pos - band - 0.8) * 5;
            blend = blend < 0 ? 0 : blend > 1 ? 1 : blend;
            const b0 = band * 3;
            const b1 = b0 + 3;
            pixels[o] = (lut[b0] as number) + ((lut[b1] as number) - (lut[b0] as number)) * blend;
            pixels[o + 1] = (lut[b0 + 1] as number) + ((lut[b1 + 1] as number) - (lut[b0 + 1] as number)) * blend;
            pixels[o + 2] = (lut[b0 + 2] as number) + ((lut[b1 + 2] as number) - (lut[b0 + 2] as number)) * blend;
            pixels[o + 3] = 255;
            o += 4;
          }
        }
        tint.ctx.putImageData(image, 0, 0);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(tint.canvas, -1.25 * CELL, -1.25 * CELL, (tintW * CELL) / 2, (tintH * CELL) / 2);
        march();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = c.line;
        ctx.lineWidth = 0.85;
        stroke(ctx, lines, lineCount);
        ctx.strokeStyle = c.index;
        ctx.lineWidth = 1.3;
        stroke(ctx, indexes, indexCount);
      },
      hot: [march, push, stroke, sample, slotFor, fill, lift, noise.fbm3, noise.noise3],
    };
  },
});
