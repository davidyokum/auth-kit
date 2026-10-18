/**
 * stained-glass v1. FROZEN once released (ADR 0021): add v2.ts for any change to what it draws.
 *
 * Soft Voronoi glass: relaxed cells (two rounds of Lloyd's algorithm) inset from light leading, with
 * rounded corners, a top-left sheen and a thin bevel. Cell colors follow a slow noise field across
 * the whole page. The cell under the pointer lights up; a wide, faint
 * band of light crosses the glass every minute or so.
 */
import { mix, parseHex, rgba, toHex } from '../../kernel/v1/color.js';
import { createNoise } from '../../kernel/v1/noise.js';
import { createRng, hashParts } from '../../kernel/v1/prng.js';
import { clamp } from '../../kernel/v1/shape.js';
import { type Ctx2D, defineVersion } from '../define.js';

type Pt = [number, number];

/** Clips a convex polygon to the half-plane closer to `a` than to `b` (Sutherland-Hodgman). */
function clipCloser(poly: Pt[], ax: number, ay: number, bx: number, by: number): Pt[] {
  const nx = bx - ax;
  const ny = by - ay;
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  const side = (p: Pt) => (p[0] - mx) * nx + (p[1] - my) * ny;
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i] as Pt;
    const q = poly[(i + 1) % poly.length] as Pt;
    const sp = side(p);
    const sq = side(q);
    if (sp <= 0) out.push(p);
    if ((sp <= 0) !== (sq <= 0)) {
      const t = sp / (sp - sq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

function cellsFor(xs: number[], ys: number[], bounds: [number, number, number, number], reach: number): Pt[][] {
  const [x0, y0, x1, y1] = bounds;
  return xs.map((sx, i) => {
    const sy = ys[i] as number;
    let poly: Pt[] = [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ];
    for (let j = 0; j < xs.length && poly.length > 2; j++) {
      if (j === i) continue;
      const ox = xs[j] as number;
      const oy = ys[j] as number;
      if (Math.abs(ox - sx) > reach || Math.abs(oy - sy) > reach) continue;
      poly = clipCloser(poly, sx, sy, ox, oy);
    }
    return poly;
  });
}

function centroid(poly: Pt[]): Pt {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i] as Pt;
    const q = poly[(i + 1) % poly.length] as Pt;
    const cross = p[0] * q[1] - q[0] * p[1];
    a += cross;
    cx += (p[0] + q[0]) * cross;
    cy += (p[1] + q[1]) * cross;
  }
  if (Math.abs(a) < 1e-6) return poly[0] ?? [0, 0];
  return [cx / (3 * a), cy / (3 * a)];
}

/** Insets a convex polygon by `d`: each edge moves inward and neighbors are re-intersected. */
function inset(poly: Pt[], d: number): Pt[] | null {
  const pts = poly.filter((p, i) => {
    const q = poly[(i + 1) % poly.length] as Pt;
    return Math.hypot(q[0] - p[0], q[1] - p[1]) > 0.75;
  });
  if (pts.length < 3) return null;
  // Orientation: positive area means clockwise on a y-down canvas.
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i] as Pt;
    const q = pts[(i + 1) % pts.length] as Pt;
    area += p[0] * q[1] - q[0] * p[1];
  }
  const sign = area > 0 ? 1 : -1;
  const lines = pts.map((p, i) => {
    const q = pts[(i + 1) % pts.length] as Pt;
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const nx = (-(q[1] - p[1]) / len) * sign;
    const ny = ((q[0] - p[0]) / len) * sign;
    return { px: p[0] - nx * d, py: p[1] - ny * d, dx: q[0] - p[0], dy: q[1] - p[1] };
  });
  const out: Pt[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l1 = lines[(i + lines.length - 1) % lines.length] as (typeof lines)[number];
    const l2 = lines[i] as (typeof lines)[number];
    const den = l1.dx * l2.dy - l1.dy * l2.dx;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((l2.px - l1.px) * l2.dy - (l2.py - l1.py) * l2.dx) / den;
    out.push([l1.px + l1.dx * t, l1.py + l1.dy * t]);
  }
  if (out.length < 3) return null;
  let check = 0;
  for (let i = 0; i < out.length; i++) {
    const p = out[i] as Pt;
    const q = out[(i + 1) % out.length] as Pt;
    check += p[0] * q[1] - q[0] * p[1];
  }
  return check * area > 0 && Math.abs(check) > 40 ? out : null;
}

export const stainedGlassV1 = defineVersion({
  version: 1,
  fps: 15,
  maxPixelRatio: 2,
  stillTime: 15,
  colors: (p) => ({
    lead: toHex(mix(p.page, '#ffffff', 0.7)),
    ramp: [toHex(mix(p.mist, p.page, 0.4)), toHex(mix(p.glow, p.page, 0.45)), toHex(mix(p.secondary, p.page, 0.62)), toHex(mix(p.primary, p.page, 0.55)), toHex(mix(mix(p.primary, p.ink, 0.35), p.page, 0.68))],
    page: p.page,
    sheen: rgba('#ffffff', 0.38),
    shade: rgba(p.ink, 0.04),
    bevel: rgba('#ffffff', 0.6),
    lit: toHex(mix(p.glow, '#ffffff', 0.35)),
    rim: rgba(p.primary, 0.5),
    jewel: toHex(mix(p.primary, p.page, 0.42)),
  }),
  create(setup, c) {
    const { width: w, height: h } = setup;
    const rng = createRng(hashParts('stained-glass', 1, setup.seed));
    const noise = createNoise(rng.fork('noise'));
    const size = rng.range(115, 175) * clamp(Math.min(w, h) / 900, 0.75, 1.15);
    const gap = rng.range(4, 7);
    const roundness = rng.range(8, 16);
    const bounds: [number, number, number, number] = [-size, -size, w + size, h + size];

    let xs: number[] = [];
    let ys: number[] = [];
    const place = rng.fork('sites');
    for (let y = -size; y < h + size; y += size) {
      for (let x = -size; x < w + size; x += size) {
        xs.push(x + place.range(0, size));
        ys.push(y + place.range(0, size));
      }
    }
    for (let round = 0; round < 2; round++) {
      const cells = cellsFor(xs, ys, bounds, size * 3);
      const next = cells.map((cell, i) => (cell.length > 2 ? centroid(cell) : ([xs[i], ys[i]] as Pt)));
      xs = next.map((p) => p[0]);
      ys = next.map((p) => p[1]);
    }
    const cells = cellsFor(xs, ys, [-8, -8, w + 8, h + 8], size * 3);

    // Rounded, inset cells: per corner, the two tangent points and the corner itself.
    const shapes: { pts: Float32Array; color: string; box: [number, number, number, number] }[] = [];
    const siteX: number[] = [];
    const siteY: number[] = [];
    const ramp = c.ramp.map((hex) => parseHex(hex));
    const jewels = rng.fork('jewels');
    const offX = rng.range(-300, 300);
    const offY = rng.range(-300, 300);
    const tint = rng.range(0.0009, 0.0018);
    cells.forEach((cell, i) => {
      if (cell.length < 3) return;
      const poly = inset(cell, gap / 2);
      if (!poly) return;
      const m = poly.length;
      const pts = new Float32Array(m * 6);
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let k = 0; k < m; k++) {
        const u = poly[(k + m - 1) % m] as Pt;
        const v = poly[k] as Pt;
        const n = poly[(k + 1) % m] as Pt;
        const lu = Math.hypot(u[0] - v[0], u[1] - v[1]);
        const ln = Math.hypot(n[0] - v[0], n[1] - v[1]);
        const fu = Math.min(0.5, roundness / Math.max(lu, 0.001));
        const fn = Math.min(0.5, roundness / Math.max(ln, 0.001));
        pts[k * 6] = v[0] + (u[0] - v[0]) * fu;
        pts[k * 6 + 1] = v[1] + (u[1] - v[1]) * fu;
        pts[k * 6 + 2] = v[0];
        pts[k * 6 + 3] = v[1];
        pts[k * 6 + 4] = v[0] + (n[0] - v[0]) * fn;
        pts[k * 6 + 5] = v[1] + (n[1] - v[1]) * fn;
        minX = Math.min(minX, v[0]);
        minY = Math.min(minY, v[1]);
        maxX = Math.max(maxX, v[0]);
        maxY = Math.max(maxY, v[1]);
      }
      const sx = xs[i] as number;
      const sy = ys[i] as number;
      const field = 0.5 + 0.5 * noise.fbm2(sx * tint + offX, sy * tint + offY, 2);
      const t = clamp(field * 1.05 - 0.05, 0, 0.999) * (ramp.length - 1);
      const lo = Math.floor(t);
      let color = mix(ramp[lo] as never, ramp[lo + 1] as never, t - lo);
      // Now and then a jewel: a richer pane among the pale ones.
      if (jewels.chance(0.05)) color = parseHex(c.jewel);
      shapes.push({ pts, color: toHex(color), box: [minX, minY, maxX, maxY] });
      siteX.push(sx);
      siteY.push(sy);
    });

    function trace(ctx: Ctx2D, pts: Float32Array): void {
      const m = pts.length / 6;
      ctx.beginPath();
      ctx.moveTo(pts[4] as number, pts[5] as number);
      for (let k = 1; k <= m; k++) {
        const o = (k % m) * 6;
        ctx.lineTo(pts[o] as number, pts[o + 1] as number);
        ctx.quadraticCurveTo(pts[o + 2] as number, pts[o + 3] as number, pts[o + 4] as number, pts[o + 5] as number);
      }
      ctx.closePath();
    }

    const glass = setup.createLayer(w, h);
    const gc = glass.ctx;
    gc.fillStyle = c.lead;
    gc.fillRect(0, 0, w, h);
    for (const shape of shapes) {
      trace(gc, shape.pts);
      gc.fillStyle = shape.color;
      gc.fill();
      const [x0, y0, x1, y1] = shape.box;
      const sheen = gc.createLinearGradient(x0, y0, x1, y1);
      sheen.addColorStop(0, c.sheen);
      sheen.addColorStop(0.55, rgba('#ffffff', 0));
      sheen.addColorStop(1, c.shade);
      gc.fillStyle = sheen;
      gc.fill();
      gc.strokeStyle = c.bevel;
      gc.lineWidth = 1;
      gc.stroke();
    }

    // The band of light, painted once into a strip and drawn rotated.
    const band = setup.createLayer(256, 4, 1);
    const bandGradient = band.ctx.createLinearGradient(0, 0, 256, 0);
    bandGradient.addColorStop(0, rgba('#ffffff', 0));
    bandGradient.addColorStop(0.5, rgba('#ffffff', 0.2));
    bandGradient.addColorStop(1, rgba('#ffffff', 0));
    band.ctx.fillStyle = bandGradient;
    band.ctx.fillRect(0, 0, 256, 4);
    const sweepAngle = rng.range(0.35, 0.75) * (rng.chance(0.5) ? 1 : -1);
    const sweepPeriod = rng.range(110, 160);
    const sweepWidth = Math.max(w, h) * 0.35;
    const diagonal = Math.hypot(w, h);

    const count = shapes.length;
    const glow = new Float32Array(count);
    const shapePts = shapes.map((s) => s.pts);

    return {
      draw(ctx, frame) {
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        ctx.drawImage(glass.canvas, 0, 0, w, h);
        let nearest = -1;
        const strength = frame.pointer.strength;
        if (strength > 0.02) {
          let best = Infinity;
          for (let i = 0; i < count; i++) {
            const dx = (siteX[i] as number) - frame.pointer.x;
            const dy = (siteY[i] as number) - frame.pointer.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < best) {
              best = d2;
              nearest = i;
            }
          }
        }
        const ease = 1 - Math.exp(-frame.dt * 6);
        ctx.fillStyle = c.lit;
        ctx.strokeStyle = c.rim;
        ctx.lineWidth = 1.5;
        for (let i = 0; i < count; i++) {
          const target = i === nearest ? strength : 0;
          const g = (glow[i] as number) + (target - (glow[i] as number)) * ease;
          glow[i] = g;
          if (g < 0.01) continue;
          trace(ctx, shapePts[i] as Float32Array);
          ctx.globalAlpha = g * 0.7;
          ctx.fill();
          ctx.globalAlpha = g;
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        const travel = ((frame.t / sweepPeriod) % 1) * (diagonal + sweepWidth * 2) - sweepWidth - diagonal / 2;
        ctx.save();
        ctx.translate(w / 2, h / 2);
        ctx.rotate(sweepAngle);
        ctx.drawImage(band.canvas, travel - sweepWidth / 2, -diagonal / 2, sweepWidth, diagonal);
        ctx.restore();
      },
      hot: [trace],
    };
  },
});

// Exposed for tests: the geometry helpers are pure.
export const __geometry = { clipCloser, centroid, inset };
