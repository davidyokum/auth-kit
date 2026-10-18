/**
 * watercolor v1. FROZEN once released (ADR 0021): add v2.ts for any change to what it draws.
 *
 * Painterly, all in code: each bloom is a polygon deformed by recursive midpoint displacement, then
 * laid down as thirty-odd translucent glazes, each deformed again (Tyler Hobbs's technique), with a
 * mottled pigment, a darker pigment edge and lifted "salt" speckles, multiplied onto grained paper.
 * The whole painting is made twice, the second a little wetter and wider, and the two cross-fade over
 * about three minutes: a very slow bleed. Everything is painted once, when it's created; a
 * frame is two image copies.
 */
import { mix, parseHex, rgba, type Rgb, saturate, toHex } from '../../kernel/v1/color.js';
import { createNoise } from '../../kernel/v1/noise.js';
import { createRng, hashParts, type Rng } from '../../kernel/v1/prng.js';
import { cardDistance, TAU } from '../../kernel/v1/shape.js';
import { type Ctx2D, defineVersion, type Layer } from '../define.js';

const GLAZES = 30;
const BLOOM_SCALE = 0.5;

interface Poly {
  xs: number[];
  ys: number[];
  vs: number[];
}

/** One round of midpoint displacement per depth: every edge gains a displaced midpoint. */
function deform(poly: Poly, depth: number, spread: number, rng: Rng): Poly {
  let { xs, ys, vs } = poly;
  for (let d = 0; d < depth; d++) {
    const nx: number[] = [];
    const ny: number[] = [];
    const nv: number[] = [];
    for (let i = 0; i < xs.length; i++) {
      const j = (i + 1) % xs.length;
      const ax = xs[i] as number;
      const ay = ys[i] as number;
      const bx = xs[j] as number;
      const by = ys[j] as number;
      const len = Math.hypot(bx - ax, by - ay);
      const v = ((vs[i] as number) + (vs[j] as number)) / 2;
      nx.push(ax, (ax + bx) / 2 + rng.normal() * len * v * spread);
      ny.push(ay, (ay + by) / 2 + rng.normal() * len * v * spread);
      nv.push(vs[i] as number, v * rng.range(0.55, 1));
    }
    xs = nx;
    ys = ny;
    vs = nv;
  }
  return { xs, ys, vs };
}

function tracePoly(ctx: Ctx2D, poly: Poly): void {
  ctx.beginPath();
  ctx.moveTo(poly.xs[0] as number, poly.ys[0] as number);
  for (let i = 1; i < poly.xs.length; i++) ctx.lineTo(poly.xs[i] as number, poly.ys[i] as number);
  ctx.closePath();
}

interface Bloom {
  x: number;
  y: number;
  r: number;
  pigment: number;
  strength: number;
}

export const watercolorV1 = defineVersion({
  version: 1,
  fps: 6,
  maxPixelRatio: 1.25,
  stillTime: 30,
  colors: (p) => ({
    paper: toHex(mix(p.page, p.mist, 0.18)),
    grain: p.ink,
    // Lightened toward the page, then given back some chroma, so washes stay clear rather than grey.
    pigments: [
      toHex(saturate(mix(p.glow, p.page, 0.1), 1.2)),
      toHex(saturate(mix(p.primary, p.page, 0.5), 1.25)),
      toHex(saturate(mix(p.secondary, p.page, 0.45), 1.2)),
      toHex(saturate(mix(mix(p.primary, p.ink, 0.25), p.page, 0.6), 1.3)),
      toHex(saturate(mix(p.glow, p.secondary, 0.35), 1.15)),
      toHex(saturate(mix(mix(p.glow, p.primary, 0.3), p.page, 0.3), 1.2)),
    ],
  }),
  create(setup, c) {
    const { width: w, height: h, card } = setup;
    const rng = createRng(hashParts('watercolor', 1, setup.seed));
    const noise = createNoise(rng.fork('noise'));
    const big = Math.max(w, h);
    const grain = parseHex(c.grain);

    // ---- Paper: a warm ground, broad mottling (not tiled), fine speckle, a few fibers, a soft vignette.
    const paper = setup.createLayer(w, h);
    const pc = paper.ctx;
    pc.fillStyle = c.paper;
    pc.fillRect(0, 0, w, h);
    const mottle = setup.createLayer(Math.ceil(w / 8) + 1, Math.ceil(h / 8) + 1, 1);
    const mottleImage = mottle.ctx.createImageData(mottle.canvas.width, mottle.canvas.height);
    for (let j = 0; j < mottle.canvas.height; j++) {
      for (let i = 0; i < mottle.canvas.width; i++) {
        const v = noise.fbm2(i * 0.06, j * 0.06, 3);
        const o = (j * mottle.canvas.width + i) * 4;
        mottleImage.data[o] = grain[0];
        mottleImage.data[o + 1] = grain[1];
        mottleImage.data[o + 2] = grain[2];
        mottleImage.data[o + 3] = Math.round(Math.max(0, v + 0.15) * 7);
      }
    }
    mottle.ctx.putImageData(mottleImage, 0, 0);
    pc.imageSmoothingEnabled = true;
    pc.drawImage(mottle.canvas, -4, -4, mottle.canvas.width * 8, mottle.canvas.height * 8);
    const tileSize = 256;
    const tile = setup.createLayer(tileSize, tileSize, 1);
    const tileImage = tile.ctx.createImageData(tile.canvas.width, tile.canvas.height);
    const grainRng = rng.fork('grain');
    for (let o = 0; o < tileImage.data.length; o += 4) {
      const r = grainRng.next();
      tileImage.data[o] = grain[0];
      tileImage.data[o + 1] = grain[1];
      tileImage.data[o + 2] = grain[2];
      tileImage.data[o + 3] = Math.round((0.012 + (r > 0.55 ? (r - 0.55) * 0.07 : 0) + (r > 0.985 ? 0.05 : 0)) * 255);
    }
    tile.ctx.putImageData(tileImage, 0, 0);
    const pattern = pc.createPattern(tile.canvas, 'repeat');
    if (pattern) {
      pc.fillStyle = pattern;
      pc.fillRect(0, 0, w, h);
    }
    const fiberRng = rng.fork('fibers');
    pc.strokeStyle = rgba(c.grain, 0.03);
    pc.lineWidth = 0.6;
    pc.beginPath();
    const fibers = Math.round((w * h) / 14000);
    for (let i = 0; i < fibers; i++) {
      const x = fiberRng.range(0, w);
      const y = fiberRng.range(0, h);
      const a = fiberRng.range(0, TAU);
      const l = fiberRng.range(4, 12);
      pc.moveTo(x, y);
      pc.quadraticCurveTo(x + Math.cos(a + 0.6) * l * 0.5, y + Math.sin(a + 0.6) * l * 0.5, x + Math.cos(a) * l, y + Math.sin(a) * l);
    }
    pc.stroke();
    const vignette = pc.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.4, w / 2, h / 2, big * 0.78);
    vignette.addColorStop(0, rgba(c.grain, 0));
    vignette.addColorStop(1, rgba(c.grain, 0.045));
    pc.fillStyle = vignette;
    pc.fillRect(0, 0, w, h);

    // ---- Composition: where the blooms go, kept off the card.
    const comp = rng.fork('composition');
    const layout = comp.pick(['corners', 'ring', 'drift'] as const);
    const palette = comp.shuffle([0, 1, 2, 3, 4, 5]).slice(0, 3);
    const blooms: Bloom[] = [];
    const cx = card.x + card.width / 2;
    const cy = card.y + card.height / 2;
    const add = (x: number, y: number, r: number, pigmentSlot: number) => {
      let bx = x;
      let by = y;
      for (let tries = 0; tries < 8 && cardDistance(bx, by, card, w, h) < 0.15; tries++) {
        bx += (bx - cx) * 0.25 + (bx === cx ? r * 0.3 : 0);
        by += (by - cy) * 0.25;
      }
      blooms.push({ x: bx, y: by, r, pigment: palette[pigmentSlot % palette.length] as number, strength: comp.range(0.75, 1.1) });
    };
    if (layout === 'corners') {
      const flip = comp.chance(0.5);
      const corners: [number, number][] = flip
        ? [
            [comp.range(0.02, 0.14) * w, comp.range(0.04, 0.18) * h],
            [comp.range(0.86, 0.98) * w, comp.range(0.82, 0.96) * h],
          ]
        : [
            [comp.range(0.86, 0.98) * w, comp.range(0.04, 0.18) * h],
            [comp.range(0.02, 0.14) * w, comp.range(0.82, 0.96) * h],
          ];
      corners.forEach(([x, y], i) => {
        add(x, y, big * comp.range(0.19, 0.25), i);
        const satellites = 1 + comp.int(2);
        for (let s = 0; s < satellites; s++) {
          const a = comp.range(0, TAU);
          const d = big * comp.range(0.12, 0.19);
          add(x + Math.cos(a) * d, y + Math.sin(a) * d, big * comp.range(0.07, 0.12), i + 1 + s);
        }
      });
    } else if (layout === 'ring') {
      const count = 5 + comp.int(3);
      const start = comp.range(0, TAU);
      for (let i = 0; i < count; i++) {
        const a = start + (i / count) * TAU + comp.range(-0.25, 0.25);
        add(w / 2 + Math.cos(a) * w * comp.range(0.38, 0.48), h / 2 + Math.sin(a) * h * comp.range(0.36, 0.48), big * comp.range(0.09, 0.15), i);
      }
    } else {
      const angle = comp.range(-0.9, 0.9) + (comp.chance(0.5) ? Math.PI / 2 : 0);
      const count = 5 + comp.int(3);
      for (let i = 0; i < count; i++) {
        const along = (i / (count - 1) - 0.5) * 1.3 * big;
        const off = comp.range(-0.12, 0.12) * big;
        add(w / 2 + Math.cos(angle) * along - Math.sin(angle) * off, h / 2 + Math.sin(angle) * along + Math.cos(angle) * off, big * comp.range(0.09, 0.16), i);
      }
    }

    // ---- Paint every bloom into one layer, twice: dry (A), then wetter and wider (B).
    const pigments = c.pigments.map((hex) => parseHex(hex));
    const bases: Poly[] = blooms.map((bloom, i) => {
      const shape = rng.fork(`bloom-${i}-shape`);
      const base: Poly = { xs: [], ys: [], vs: [] };
      const n0 = 10;
      for (let k = 0; k < n0; k++) {
        const a = (k / n0) * TAU;
        const r = bloom.r * shape.range(0.75, 1.1);
        base.xs.push(bloom.x + Math.cos(a) * r);
        base.ys.push(bloom.y + Math.sin(a) * r * shape.range(0.8, 1.05));
        base.vs.push(shape.range(0.25, 1.1));
      }
      return deform(base, 2, 0.5, shape);
    });

    function paint(wet: boolean): Layer {
      const layer = setup.createLayer(w, h, Math.min(1, setup.pixelRatio) * BLOOM_SCALE);
      blooms.forEach((bloom, i) => {
        const stream = rng.fork(`bloom-${i}-${wet ? 'wet' : 'dry'}`);
        const color: Rgb = pigments[bloom.pigment] as Rgb;
        let base = bases[i] as Poly;
        if (wet) {
          base = { xs: base.xs.map((x) => bloom.x + (x - bloom.x) * 1.07), ys: base.ys.map((y) => bloom.y + (y - bloom.y) * 1.07), vs: base.vs };
          base = deform(base, 1, 0.2, stream);
        }
        // Each bloom builds up its coverage alone, in black, then takes its pigment in one step:
        // thirty faint glazes in color would drift in hue through 8-bit rounding.
        const reach = bloom.r * 1.8;
        const own = setup.createLayer(reach * 2, reach * 2, Math.min(1, setup.pixelRatio) * BLOOM_SCALE);
        const bc = own.ctx;
        bc.translate(reach - bloom.x, reach - bloom.y);
        const glaze = rgba('#000000', 0.045 * bloom.strength);
        bc.fillStyle = glaze;
        for (let g = 0; g < GLAZES; g++) {
          tracePoly(bc, deform(base, 3, 0.48, stream));
          bc.fill();
          if (g % 10 === 9) {
            // Mottle the pigment: lift soft spots so the wash isn't flat.
            bc.globalCompositeOperation = 'destination-out';
            for (let m = 0; m < 24; m++) {
              const a = stream.range(0, TAU);
              const d = Math.sqrt(stream.next()) * bloom.r;
              bc.fillStyle = rgba('#000000', stream.range(0.02, 0.06));
              bc.beginPath();
              bc.arc(bloom.x + Math.cos(a) * d, bloom.y + Math.sin(a) * d, stream.range(6, bloom.r * 0.22), 0, TAU);
              bc.fill();
            }
            bc.globalCompositeOperation = 'source-over';
            bc.fillStyle = glaze;
          }
        }
        // The pigment edge: pigment gathers where a wash dries.
        bc.strokeStyle = rgba('#000000', 0.07 * bloom.strength);
        bc.lineWidth = 1.2;
        for (let e = 0; e < 2; e++) {
          tracePoly(bc, deform(base, 3, 0.3, stream));
          bc.stroke();
        }
        // Salt: lifted speckles.
        bc.globalCompositeOperation = 'destination-out';
        const salt = Math.round(bloom.r * 0.25);
        for (let k = 0; k < salt; k++) {
          const a = stream.range(0, TAU);
          const d = Math.sqrt(stream.next()) * bloom.r * 0.85;
          bc.fillStyle = rgba('#000000', stream.range(0.1, 0.32));
          bc.beginPath();
          bc.arc(bloom.x + Math.cos(a) * d, bloom.y + Math.sin(a) * d, stream.range(0.6, 2.2), 0, TAU);
          bc.fill();
        }
        // The pigment, everywhere the coverage is.
        bc.setTransform(1, 0, 0, 1, 0, 0);
        bc.globalCompositeOperation = 'source-in';
        bc.fillStyle = rgba(color, 1);
        bc.fillRect(0, 0, own.canvas.width, own.canvas.height);
        layer.ctx.drawImage(own.canvas, bloom.x - reach, bloom.y - reach, reach * 2, reach * 2);
      });
      return layer;
    }

    // Each state: paper with its blooms multiplied on, flattened once.
    function flatten(blooms: Layer): Layer {
      const state = setup.createLayer(w, h);
      state.ctx.drawImage(paper.canvas, 0, 0, w, h);
      state.ctx.globalCompositeOperation = 'multiply';
      state.ctx.imageSmoothingEnabled = true;
      state.ctx.drawImage(blooms.canvas, 0, 0, w, h);
      state.ctx.globalCompositeOperation = 'source-over';
      return state;
    }
    const dry = flatten(paint(false));
    const wet = flatten(paint(true));
    const period = comp.range(140, 200);
    const phase = comp.range(0, TAU);

    return {
      draw(ctx, frame) {
        const p = 0.5 - 0.5 * Math.cos((frame.t / period) * TAU + phase);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        ctx.drawImage(dry.canvas, 0, 0, w, h);
        ctx.globalAlpha = p;
        ctx.drawImage(wet.canvas, 0, 0, w, h);
        ctx.globalAlpha = 1;
      },
    };
  },
});
