/**
 * Plotter core v1: the pen-plotter sheet that county-survey, river-basins, and star-chart draw with. It
 * isn't a style and isn't registered: the frozen hashes of the style versions that use it cover it.
 *
 * FROZEN once released, like `kernel/v1` (ADR 0021): three released style versions draw with it, so a
 * change in what it draws would redraw every site that locked one of them. Never edit it, not even to
 * tidy. Any change in what it draws needs a `plotter/v2.ts` beside it, and new style versions point at
 * that.
 *
 * Ported from the Backdrop Lab's "Plotter core" (passwords-flow `design/backdrop-lab/styles/`, pasted
 * into county-survey.js, river-basins.js, and star-chart.js; adapted from blueprint.js): paper and ink
 * from the palette, single-stroke technical lettering, timed views of polylines, the pen carriage, the
 * title block, the crosshair with its readout, revision clouds and name notes on a tap, and the map-sheet
 * helpers (the NC State Plane projection, the map region beside the card, the graticule, north arrow,
 * scale bar, and locator inset).
 *
 * What differs from the lab, so a frame is the same in Node tests, on an OffscreenCanvas, and in any
 * browser: masks and the label-clutter raster are computed in software, never read back from a canvas;
 * the readout is lettered in the plotter's own hand, never a font; everything random comes from the
 * kernel's generator; the plot is a function of the animation time (the lab's speed control is gone);
 * and the per-frame path allocates nothing (taps write into buffers made when the sheet is created).
 */
import { over, relativeLuminance, rgba, toHex } from '../../kernel/v1/color.js';
import { createNoise } from '../../kernel/v1/noise.js';
import type { Rng } from '../../kernel/v1/prng.js';
import { clamp, lerp, TAU } from '../../kernel/v1/shape.js';
import type { Ctx2D, FrameInput, Layer, StyleInstance, StyleSetup } from '../define.js';

type BackdropPalette = StyleSetup['palette'];

export { clamp, lerp, TAU };

/* ---------------------------------------------------------------------------------------------- */
/* Colours                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

/** Mixes two `#rrggbb` colours in sRGB (as the lab does), `t` 0 is `a`, 1 is `b`. */
export function mixHex(a: string, b: string, t: number): string {
  return toHex(over(b, t, a));
}

/** The paper and pens of one sheet. */
export interface SheetColours {
  readonly dark: boolean;
  readonly paper: string;
  readonly ink: string;
  readonly ink2: string;
  readonly ink3: string;
  readonly dim: string;
  readonly cons: string;
  readonly hatch: string;
  readonly gridMinor: string;
  readonly gridMajor: string;
  readonly red: string;
  readonly water: string;
  readonly waterPale: string;
  readonly star?: string;
  readonly starPale?: string;
  /** Paper texture strength, 0-1. */
  readonly tex: number;
  /** Vignette strength at the sheet's corners, 0-1. */
  readonly vig: number;
}

/** A dark page (relative luminance under 0.3) gets the lab's dark treatment. */
export function isDarkPage(palette: BackdropPalette): boolean {
  return relativeLuminance(palette.page) < 0.3;
}

/** The blueprint sheet's colours (the lab's `colours`, mapped onto the kit palette), plus a water pen. */
export function sheetColours(p: BackdropPalette): SheetColours {
  if (isDarkPage(p)) {
    const paper = mixHex(p.page, p.primary, 0.34);
    const white = '#f4f9ff';
    const water = '#9ee3ff';
    return {
      dark: true,
      paper,
      ink: mixHex(white, paper, 0.03),
      ink2: mixHex(white, paper, 0.14),
      ink3: mixHex(white, paper, 0.34),
      dim: mixHex('#cdebff', paper, 0.12),
      cons: mixHex('#9cd2ff', paper, 0.55),
      hatch: mixHex(white, paper, 0.5),
      gridMinor: mixHex(paper, white, 0.055),
      gridMajor: mixHex(paper, white, 0.11),
      red: '#ffcb6b',
      water,
      waterPale: mixHex(water, paper, 0.55),
      tex: 0.11,
      vig: 0.22,
    };
  }
  const paper = mixHex(p.page, p.mist, 0.3);
  const ink = mixHex(p.ink, p.primary, 0.38);
  const water = mixHex('#0e7fc0', ink, 0.25);
  return {
    dark: false,
    paper,
    ink,
    ink2: mixHex(ink, paper, 0.14),
    ink3: mixHex(ink, paper, 0.38),
    dim: mixHex(p.primary, paper, 0.05),
    cons: mixHex(p.primary, paper, 0.62),
    hatch: mixHex(ink, paper, 0.5),
    gridMinor: mixHex(paper, p.primary, 0.075),
    gridMajor: mixHex(paper, p.primary, 0.14),
    red: '#c2462e',
    water,
    waterPale: mixHex(water, paper, 0.55),
    tex: 0.05,
    vig: 0.07,
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* Single-stroke technical lettering (4 x 6 grid, y down, baseline at 6)                          */
/* ---------------------------------------------------------------------------------------------- */

/** A glyph: polylines in grid units, each `[x0, y0, x1, y1, ...]`. */
export type Glyph = readonly Float64Array[];
export type GlyphTable = ReadonlyMap<number, Glyph>;

const FONT: Readonly<Record<string, string>> = {
  '0': '10 30 41 45 36 16 05 01 10', '1': '11 20 26|16 36', '2': '01 10 30 41 42 06 46', '3': '01 10 30 41 42 33 23|33 44 45 36 16 05',
  '4': '44 04 30 36', '5': '40 00 02 32 43 45 36 16 05', '6': '41 30 10 01 05 16 36 45 43 32 12 03', '7': '00 40 41 26',
  '8': '10 30 41 42 33 13 04 05 16 36 45 44 33|13 02 01 10', '9': '42 33 13 02 01 10 30 41 45 36 16 05',
  A: '06 20 46|13 33', B: '06 00 30 41 42 33 03|33 44 45 36 06', C: '41 30 10 01 05 16 36 45', D: '00 30 41 45 36 06 00',
  E: '40 00 06 46|03 33', F: '40 00 06|03 33', G: '41 30 10 01 05 16 36 45 43 23', H: '00 06|40 46|03 43', I: '10 30|20 26|16 36',
  J: '40 45 36 16 05 04', K: '00 06|40 04|13 46', L: '00 06 46', M: '06 00 23 40 46', N: '06 00 46 40', O: '10 30 41 45 36 16 05 01 10',
  P: '06 00 30 41 42 33 03', Q: '10 30 41 45 36 16 05 01 10|24 46', R: '06 00 30 41 42 33 03|23 46', S: '41 30 10 01 02 13 33 44 45 36 16 05',
  T: '00 40|20 26', U: '00 05 16 36 45 40', V: '00 26 40', W: '00 16 23 36 40', X: '00 46|40 06', Y: '00 23 40|23 26', Z: '00 40 06 46',
  '.': '25 26', ',': '25 16', '-': '13 33', '+': '13 33|22 24', '/': '06 40', ':': '12 13|25 26', '=': '12 32|14 34', ';': '12 13|25 16',
  '°': '10 20 21 11 10', "'": '20 21', '"': '10 11|30 31', '%': '00 01|46 45|06 40', '(': '30 21 25 36', ')': '10 21 25 16',
  '&': '46 11 10 20 31 32 04 05 16 26 44', '#': '10 16|30 36|02 42|04 44', '!': '20 24|25 26', '?': '01 10 30 41 42 23 24|25 26',
  '×': '12 34|32 14', '±': '02 42|20 24|06 46', 'Ø': '10 30 41 45 36 16 05 01 10|06 40', _: '06 46',
};

function ringGlyph(cx: number, cy: number, r: number, a0: number, a1: number, n: number): Float64Array {
  const o = new Float64Array((n + 1) * 2);
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    o[2 * i] = cx + Math.cos(a) * r;
    o[2 * i + 1] = cy + Math.sin(a) * r;
  }
  return o;
}

/** The plotter's alphabet: capitals, figures, punctuation, a middle dot, and a copyright sign. */
export function baseGlyphs(): Map<number, Glyph> {
  const table = new Map<number, Glyph>();
  for (const [ch, spec] of Object.entries(FONT)) {
    const lines = spec.split('|').map((s) => Float64Array.from(s.trim().split(/\s+/).flatMap((q) => [Number(q[0]), Number(q[1])])));
    table.set(ch.charCodeAt(0), lines);
  }
  table.set('·'.charCodeAt(0), [ringGlyph(2, 3, 0.42, 0, TAU, 8)]);
  table.set('©'.charCodeAt(0), [ringGlyph(2, 3, 2.3, 0, TAU, 20), ringGlyph(2, 3, 1.05, -0.8, -5.45, 12)]);
  return table;
}

/** Adds glyphs (each a list of polylines of `[x, y]` grid points) for a character and its capital. */
export function addGlyphs(table: Map<number, Glyph>, glyphs: Readonly<Record<string, readonly (readonly (readonly [number, number])[])[]>>): void {
  for (const [ch, lines] of Object.entries(glyphs)) {
    const glyph = lines.map((line) => Float64Array.from(line.flatMap((pt) => [pt[0], pt[1]])));
    table.set(ch.charCodeAt(0), glyph);
    table.set(ch.toUpperCase().charCodeAt(0), glyph);
  }
}

/** Width of `n` characters lettered `h` tall. */
export function textW(n: number, h: number): number {
  return n ? (n * 5.4 * h) / 6 - (1.4 * h) / 6 : 0;
}

/** Width of a string lettered `h` tall. */
export function strW(s: string, h: number): number {
  return textW(s.length, h);
}

/** Letters one glyph straight onto a context's current path (origin at the glyph cell's top left). */
function glyphPath(x: Ctx2D, g: Glyph, gx: number, oy: number, un: number, px: number, py: number, ca: number, sa: number): void {
  for (let k = 0; k < g.length; k++) {
    const pl = g[k] as Float64Array;
    for (let j = 0; j < pl.length; j += 2) {
      const lx = gx + (pl[j] as number) * un;
      const ly = oy + (pl[j + 1] as number) * un;
      const X = px + lx * ca - ly * sa;
      const Y = py + lx * sa + ly * ca;
      if (j) x.lineTo(X, Y);
      else x.moveTo(X, Y);
    }
  }
}

/** Letters a string onto the current path (the lab's `strokeTextNow`): baseline at `py`. */
export function strokeTextNow(x: Ctx2D, glyphs: GlyphTable, str: string, px: number, py: number, h: number, al: 'l' | 'c' | 'r', ang = 0): void {
  const s = str.toUpperCase();
  const un = h / 6;
  const adv = 5.4 * un;
  const tw = strW(s, h);
  const ox = al === 'l' ? 0 : al === 'r' ? -tw : -tw / 2;
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  for (let i = 0; i < s.length; i++) {
    const g = glyphs.get(s.charCodeAt(i));
    if (g) glyphPath(x, g, ox + i * adv, -6 * un, un, px, py, ca, sa);
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* The plot builder: timed views of polylines, kept in drawing order                              */
/* ---------------------------------------------------------------------------------------------- */

/** A pen: one letter per line weight and colour (see `PENS`). */
export type Pen = 'C' | 'O' | 'M' | 'T' | 'H' | 'D' | 'X' | 'K' | 'V' | 'W' | 'Y' | 'w' | 'S' | 'P' | 'R' | 'Z' | 'z';
const PENS = 'COMTHDXKVWYwSPRZz';

export interface PlotStroke {
  p: number[];
  c: Pen;
}
export interface PlotView {
  dur: number;
  name: string;
  s: PlotStroke[];
}
export interface PlotSnap {
  x: number;
  y: number;
  t: number;
  lab: string;
  v: number;
  at: number;
}
export type Align = 'l' | 'c' | 'r';
export type VAlign = 'b' | 'm' | 't';

export class Plot {
  readonly views: PlotView[] = [];
  readonly snaps: PlotSnap[] = [];
  cur: PlotView;
  th = 0;
  constructor(
    readonly u: number,
    readonly glyphs: GlyphTable,
  ) {
    this.cur = this.view(1);
  }
  view(dur?: number, name?: string): PlotView {
    this.cur = { dur: dur || 1, name: name || '', s: [] };
    this.views.push(this.cur);
    return this.cur;
  }
  add(p: number[] | null | undefined, c: Pen): void {
    if (p && p.length >= 4) this.cur.s.push({ p, c });
  }
  line(a: number, b: number, c2: number, d: number, c: Pen): void {
    this.add([a, b, c2, d], c);
  }
  poly(p: number[], c: Pen, closed?: boolean): void {
    this.add(closed ? p.concat([p[0] as number, p[1] as number]) : p, c);
  }
  rect(x: number, y: number, w: number, h: number, c: Pen): void {
    this.add([x, y, x + w, y, x + w, y + h, x, y + h, x, y], c);
  }
  snap(x: number, y: number, t: number, lab: string): void {
    if (this.snaps.length < 400) this.snaps.push({ x, y, t: t || 0, lab: lab || '', v: this.views.indexOf(this.cur), at: 0 });
  }
  into(v: PlotView): PlotView {
    this.cur = v;
    return v;
  }
  arcPts(cx: number, cy: number, r: number, a0: number, a1: number): number[] {
    const n = clamp(Math.ceil((Math.abs(a1 - a0) * r) / (2.4 * this.u)), 6, 200);
    const o: number[] = [];
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      o.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    return o;
  }
  circle(cx: number, cy: number, r: number, c: Pen): void {
    this.add(this.arcPts(cx, cy, r, -Math.PI / 2, Math.PI * 1.5), c);
  }
  arc(cx: number, cy: number, r: number, a0: number, a1: number, c: Pen): void {
    this.add(this.arcPts(cx, cy, r, a0, a1), c);
  }
  dash(p: ArrayLike<number>, pat: readonly number[], c: Pen): void {
    let pi = 0;
    let rem = pat[0] as number;
    let on = true;
    let cur: number[] | null = [p[0] as number, p[1] as number];
    for (let i = 2; i < p.length; i += 2) {
      let x0 = p[i - 2] as number;
      let y0 = p[i - 1] as number;
      const x1 = p[i] as number;
      const y1 = p[i + 1] as number;
      let L = Math.hypot(x1 - x0, y1 - y0);
      const ux = (x1 - x0) / (L || 1);
      const uy = (y1 - y0) / (L || 1);
      while (L > rem) {
        x0 += ux * rem;
        y0 += uy * rem;
        L -= rem;
        if (on) {
          (cur as number[]).push(x0, y0);
          this.add(cur, c);
          cur = null;
        } else cur = [x0, y0];
        on = !on;
        pi = (pi + 1) % pat.length;
        rem = pat[pi] as number;
      }
      rem -= L;
      if (on) (cur as number[]).push(x1, y1);
    }
    if (on && cur && cur.length >= 4) this.add(cur, c);
  }
  hatch(rings: readonly ArrayLike<number>[], ang: number, sp: number, c: Pen): void {
    const ca = Math.cos(-ang);
    const sa = Math.sin(-ang);
    const cb = Math.cos(ang);
    const sb = Math.sin(ang);
    const R = rings.map((r) => {
      const o: number[] = [];
      for (let i = 0; i < r.length; i += 2) o.push((r[i] as number) * ca - (r[i + 1] as number) * sa, (r[i] as number) * sa + (r[i + 1] as number) * ca);
      return o;
    });
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const r of R) {
      for (let i = 1; i < r.length; i += 2) {
        if ((r[i] as number) < y0) y0 = r[i] as number;
        if ((r[i] as number) > y1) y1 = r[i] as number;
      }
    }
    let flip = false;
    const xs: number[] = [];
    for (let y = Math.ceil(y0 / sp) * sp + 0.013; y < y1; y += sp) {
      xs.length = 0;
      for (const r of R) {
        const n = r.length / 2;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          const ax = r[2 * i] as number;
          const ay = r[2 * i + 1] as number;
          const bx = r[2 * j] as number;
          const by = r[2 * j + 1] as number;
          if ((ay <= y && by > y) || (by <= y && ay > y)) xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
        }
      }
      xs.sort((a, b) => a - b);
      const segs: number[] = [];
      for (let k = 0; k + 1 < xs.length; k += 2) if ((xs[k + 1] as number) - (xs[k] as number) > 0.6) segs.push(xs[k] as number, xs[k + 1] as number);
      if (flip) {
        for (let k = segs.length - 2; k >= 0; k -= 2) {
          const a = segs[k + 1] as number;
          const b = segs[k] as number;
          this.add([a * cb - y * sb, a * sb + y * cb, b * cb - y * sb, b * sb + y * cb], c);
        }
      } else {
        for (let k = 0; k < segs.length; k += 2) {
          const a = segs[k] as number;
          const b = segs[k + 1] as number;
          this.add([a * cb - y * sb, a * sb + y * cb, b * cb - y * sb, b * sb + y * cb], c);
        }
      }
      flip = !flip;
    }
  }
  text(str: string, x: number, y: number, h: number, al?: Align, ang?: number, c?: Pen, va?: VAlign): number {
    const s = str.toUpperCase();
    const un = h / 6;
    const adv = 5.4 * un;
    const tw = strW(s, h);
    const ox = al === 'l' ? 0 : al === 'r' ? -tw : -tw / 2;
    const oy = va === 'm' ? -3 * un : va === 't' ? 0 : -6 * un;
    const ca = Math.cos(ang || 0);
    const sa = Math.sin(ang || 0);
    for (let i = 0; i < s.length; i++) {
      const g = this.glyphs.get(s.charCodeAt(i));
      if (!g) continue;
      const gx = ox + i * adv;
      for (const pl of g) {
        const pts: number[] = [];
        for (let j = 0; j < pl.length; j += 2) {
          const lx = gx + (pl[j] as number) * un;
          const ly = oy + (pl[j + 1] as number) * un;
          pts.push(x + lx * ca - ly * sa, y + lx * sa + ly * ca);
        }
        this.add(pts, c || 'X');
      }
    }
    return tw;
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* Polyline utilities                                                                              */
/* ---------------------------------------------------------------------------------------------- */

export type Keep = (x: number, y: number) => boolean;

export function inPoly(x: number, y: number, p: ArrayLike<number>): boolean {
  let c = false;
  const n = p.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = p[2 * i] as number;
    const yi = p[2 * i + 1] as number;
    const xj = p[2 * j] as number;
    const yj = p[2 * j + 1] as number;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

export function inRings(x: number, y: number, rings: readonly ArrayLike<number>[]): boolean {
  let c = false;
  for (let k = 0; k < rings.length; k++) if (inPoly(x, y, rings[k] as ArrayLike<number>)) c = !c;
  return c;
}

/** The distance from a point to a segment. Allocation-free. */
export function segDist(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy || 1;
  const t = clamp(((x - ax) * dx + (y - ay) * dy) / l2, 0, 1);
  return Math.hypot(ax + dx * t - x, ay + dy * t - y);
}

/** The distance from a point to a polyline. Allocation-free. */
export function distToLine(p: ArrayLike<number>, x: number, y: number): number {
  let best = Infinity;
  for (let i = 2; i < p.length; i += 2) {
    const d = segDist(x, y, p[i - 2] as number, p[i - 1] as number, p[i] as number, p[i + 1] as number);
    if (d < best) best = d;
  }
  return best;
}

export function chaikin(p: number[], closed?: boolean): number[] {
  if (p.length < 8) return p;
  const n = p.length;
  const o: number[] = closed ? [] : [p[0] as number, p[1] as number];
  for (let i = 0; i + 3 < n; i += 2) {
    const x0 = p[i] as number;
    const y0 = p[i + 1] as number;
    const x1 = p[i + 2] as number;
    const y1 = p[i + 3] as number;
    o.push(x0 * 0.75 + x1 * 0.25, y0 * 0.75 + y1 * 0.25, x0 * 0.25 + x1 * 0.75, y0 * 0.25 + y1 * 0.75);
  }
  if (closed) o.push(o[0] as number, o[1] as number);
  else o.push(p[n - 2] as number, p[n - 1] as number);
  return o;
}

export function polyLen(p: ArrayLike<number>): number {
  let L = 0;
  for (let i = 2; i < p.length; i += 2) L += Math.hypot((p[i] as number) - (p[i - 2] as number), (p[i + 1] as number) - (p[i - 1] as number));
  return L;
}

export function ringArea(p: ArrayLike<number>): number {
  let a = 0;
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += (p[2 * i] as number) * (p[2 * j + 1] as number) - (p[2 * j] as number) * (p[2 * i + 1] as number);
  }
  return a / 2;
}

/** Offsets a polyline sideways by `d` (positive: left of travel in screen space). */
export function offsetLine(p: ArrayLike<number>, d: number): number[] {
  const o: number[] = [];
  for (let i = 0; i < p.length; i += 2) {
    const i0 = Math.max(0, i - 2);
    const i1 = Math.min(p.length - 2, i + 2);
    const dx = (p[i1] as number) - (p[i0] as number);
    const dy = (p[i1 + 1] as number) - (p[i0 + 1] as number);
    const L = Math.hypot(dx, dy) || 1;
    o.push((p[i] as number) + (dy / L) * d, (p[i + 1] as number) - (dx / L) * d);
  }
  return o;
}

/** Splits a polyline into runs where `keep(x, y)` holds; crossings refined by bisection. */
export function runsOf(p: ArrayLike<number>, keep: Keep, step = 0): number[][] {
  const out: number[][] = [];
  let cur: number[] | null = null;
  const refine = (ax: number, ay: number, bx: number, by: number, ka: boolean): [number, number] => {
    let lo = 0;
    let hi = 1;
    for (let k = 0; k < 7; k++) {
      const m = (lo + hi) / 2;
      if (keep(ax + (bx - ax) * m, ay + (by - ay) * m) === ka) lo = m;
      else hi = m;
    }
    const m = ka ? lo : hi;
    return [ax + (bx - ax) * m, ay + (by - ay) * m];
  };
  let px = p[0] as number;
  let py = p[1] as number;
  let pk = keep(px, py);
  if (pk) cur = [px, py];
  for (let i = 2; i < p.length; i += 2) {
    const x = p[i] as number;
    const y = p[i + 1] as number;
    // Densify long segments, so a short excursion is still caught.
    const L = Math.hypot(x - px, y - py);
    const n = step > 0 ? Math.max(1, Math.ceil(L / step)) : 1;
    for (let s = 1; s <= n; s++) {
      const qx = px + ((x - px) * s) / n;
      const qy = py + ((y - py) * s) / n;
      const qk = keep(qx, qy);
      const ax = px + ((x - px) * (s - 1)) / n;
      const ay = py + ((y - py) * (s - 1)) / n;
      if (qk !== pk) {
        const e = refine(ax, ay, qx, qy, pk);
        if (pk) {
          (cur as number[]).push(e[0], e[1]);
          if ((cur as number[]).length >= 4) out.push(cur as number[]);
          cur = null;
        } else cur = [e[0], e[1]];
        pk = qk;
      }
      if (qk && s === n) (cur as number[]).push(qx, qy);
    }
    px = x;
    py = y;
  }
  if (cur && cur.length >= 4) out.push(cur);
  return out;
}

/** Marching-squares isolines over a value grid (NaN: no data), chained into polylines. */
export function isolines(val: Float32Array, nx: number, ny: number, x0: number, y0: number, cs: number, level: number): number[][] {
  const W1 = nx + 1;
  const nH = nx * (ny + 1);
  const nE = nH + W1 * ny;
  const n1 = new Int32Array(nE).fill(-1);
  const n2 = new Int32Array(nE).fill(-1);
  const link = (a: number, b: number): void => {
    if ((n1[a] as number) < 0) n1[a] = b;
    else n2[a] = b;
    if ((n1[b] as number) < 0) n1[b] = a;
    else n2[b] = a;
  };
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = val[j * W1 + i] as number;
      const b = val[j * W1 + i + 1] as number;
      const c = val[(j + 1) * W1 + i + 1] as number;
      const d = val[(j + 1) * W1 + i] as number;
      if (a !== a || b !== b || c !== c || d !== d) continue;
      const k = (a > level ? 8 : 0) | (b > level ? 4 : 0) | (c > level ? 2 : 0) | (d > level ? 1 : 0);
      if (k === 0 || k === 15) continue;
      const T = j * nx + i;
      const Bt = (j + 1) * nx + i;
      const L = nH + j * W1 + i;
      const R = nH + j * W1 + i + 1;
      switch (k) {
        case 1:
        case 14:
          link(L, Bt);
          break;
        case 2:
        case 13:
          link(Bt, R);
          break;
        case 3:
        case 12:
          link(L, R);
          break;
        case 4:
        case 11:
          link(T, R);
          break;
        case 6:
        case 9:
          link(T, Bt);
          break;
        case 7:
        case 8:
          link(L, T);
          break;
        case 5:
          if ((a + b + c + d) / 4 > level) {
            link(L, T);
            link(R, Bt);
          } else {
            link(T, R);
            link(Bt, L);
          }
          break;
        case 10:
          if ((a + b + c + d) / 4 > level) {
            link(T, R);
            link(Bt, L);
          } else {
            link(L, T);
            link(R, Bt);
          }
          break;
        default:
          break;
      }
    }
  }
  const pt = (e: number, o: number[]): void => {
    let i: number;
    let j: number;
    let v0: number;
    let v1: number;
    const hz = e < nH;
    if (hz) {
      j = Math.floor(e / nx);
      i = e % nx;
      v0 = val[j * W1 + i] as number;
      v1 = val[j * W1 + i + 1] as number;
    } else {
      const e2 = e - nH;
      j = Math.floor(e2 / W1);
      i = e2 % W1;
      v0 = val[j * W1 + i] as number;
      v1 = val[(j + 1) * W1 + i] as number;
    }
    const t = v1 !== v0 ? clamp((level - v0) / (v1 - v0), 0, 1) : 0.5;
    o.push(hz ? x0 + (i + t) * cs : x0 + i * cs, hz ? y0 + j * cs : y0 + (j + t) * cs);
  };
  const seen = new Uint8Array(nE);
  const out: number[][] = [];
  const walk = (s: number): number[] => {
    const o: number[] = [];
    let prev = -1;
    let cur = s;
    while (cur >= 0 && !seen[cur]) {
      seen[cur] = 1;
      pt(cur, o);
      const nx2 = n1[cur] !== prev ? (n1[cur] as number) : (n2[cur] as number);
      prev = cur;
      cur = nx2;
    }
    if (cur === s) pt(s, o);
    return o;
  };
  for (let e = 0; e < nE; e++) if (!seen[e] && (n1[e] as number) >= 0 && (n2[e] as number) < 0) out.push(walk(e));
  for (let e = 0; e < nE; e++) if (!seen[e] && (n1[e] as number) >= 0) out.push(walk(e));
  return out;
}

/* ---------------------------------------------------------------------------------------------- */
/* Compact geometry strings: zigzag base-45 varints over a 90-character alphabet                  */
/* ---------------------------------------------------------------------------------------------- */

/** Character code to digit (-1: not in the alphabet, skipped). The alphabet is 35-126 without ' and \. */
export const DEC = new Int8Array(128).fill(-1);
{
  let k = 0;
  for (let c = 35; c < 127; c++) {
    if (c === 39 || c === 92) continue;
    DEC[c] = k++;
  }
}

function digit(s: string, i: number): number {
  const c = s.charCodeAt(i);
  return c < 128 ? (DEC[c] as number) : -1;
}

/** Decodes one polyline string to `[x, y, ...]` in data units (the first point absolute, then deltas). */
export function decLine(s: string): Float64Array {
  const vals: number[] = [];
  let acc = 0;
  let mul = 1;
  for (let i = 0; i < s.length; i++) {
    const d = digit(s, i);
    if (d < 0) continue;
    if (d >= 45) {
      acc += (d - 45) * mul;
      mul *= 45;
    } else {
      acc += d * mul;
      vals.push(acc & 1 ? -(acc + 1) / 2 : acc / 2);
      acc = 0;
      mul = 1;
    }
  }
  const o = new Float64Array(vals.length);
  let x = 0;
  let y = 0;
  for (let i = 0; i + 1 < vals.length; i += 2) {
    x += vals[i] as number;
    y += vals[i + 1] as number;
    o[i] = x;
    o[i + 1] = y;
  }
  return o;
}

/** Decodes a string of unsigned varints. */
export function decNums(s: string): number[] {
  const vals: number[] = [];
  let acc = 0;
  let mul = 1;
  for (let i = 0; i < s.length; i++) {
    const d = digit(s, i);
    if (d < 0) continue;
    if (d >= 45) {
      acc += (d - 45) * mul;
      mul *= 45;
    } else {
      acc += d * mul;
      vals.push(acc);
      acc = 0;
      mul = 1;
    }
  }
  return vals;
}

/** An integer with thousands separators ("9,162"), as the lab's `toLocaleString('en-US')` gave. */
export function thousands(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/* ---------------------------------------------------------------------------------------------- */
/* Title-block text fitting                                                                        */
/* ---------------------------------------------------------------------------------------------- */

function wrapLines(str: string, h: number, maxW: number, maxLines: number): string[] | null {
  const words = str.toUpperCase().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (strW(t, h) <= maxW || !cur) cur = t;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.length <= maxLines ? lines : null;
}

export function fitText(str: string, h0: number, maxW: number, maxLines: number): { h: number; lines: string[] } {
  let h = h0;
  for (let i = 0; i < 40; i++) {
    const l = wrapLines(str, h, maxW, maxLines);
    if (l && l.every((s) => strW(s, h) <= maxW)) return { h, lines: l };
    h *= 0.93;
  }
  return { h, lines: [str.toUpperCase()] };
}

/* ---------------------------------------------------------------------------------------------- */
/* The readout: two lines of lettering written without allocating                                 */
/* ---------------------------------------------------------------------------------------------- */

const READOUT_MAX = 96;

/** The crosshair's two lines, written each frame into fixed buffers of character codes. */
export class Readout {
  readonly a = new Uint16Array(READOUT_MAX);
  readonly b = new Uint16Array(READOUT_MAX);
  na = 0;
  nb = 0;
  second = false;
  clear(): void {
    this.na = 0;
    this.nb = 0;
    this.second = false;
  }
  /** Starts the second line. */
  next(): void {
    this.second = true;
  }
  code(c: number): void {
    if (this.second) {
      if (this.nb < READOUT_MAX) this.b[this.nb++] = c;
    } else if (this.na < READOUT_MAX) this.a[this.na++] = c;
  }
  str(s: string): void {
    for (let i = 0; i < s.length; i++) this.code(s.charCodeAt(i));
  }
  /** A non-negative integer, zero-padded to `width` digits. */
  int(n: number, width: number): void {
    let v = Math.floor(Math.abs(n));
    let p = 1;
    let k = 1;
    while (p * 10 <= v || k < width) {
      p *= 10;
      k++;
    }
    for (; p >= 1; p /= 10) {
      const d = Math.floor(v / p);
      this.code(48 + (d % 10));
      v -= d * p;
    }
  }
  /** A number with `decimals` places (the lab's `toFixed`). */
  fixed(v: number, decimals: number): void {
    let scale = 1;
    for (let i = 0; i < decimals; i++) scale *= 10;
    const n = Math.round(Math.abs(v) * scale);
    if (v < 0 && n > 0) this.code(45);
    this.int(Math.floor(n / scale), 1);
    if (decimals > 0) {
      this.code(46);
      this.int(n % scale, decimals);
    }
  }
  /** Degrees, minutes, and seconds, then the hemisphere letter: 35°46'12"N. */
  dms(v: number, pos: number, neg: number): void {
    const s = v < 0 ? neg : pos;
    const a = Math.abs(v);
    let d = Math.floor(a);
    let mm = Math.floor((a - d) * 60);
    let ss = Math.round(((a - d) * 60 - mm) * 60);
    if (ss === 60) {
      ss = 0;
      mm++;
    }
    if (mm === 60) {
      mm = 0;
      d++;
    }
    this.int(d, 1);
    this.code(176);
    this.int(mm, 2);
    this.code(39);
    this.int(ss, 2);
    this.code(34);
    this.code(s);
  }
}

/** The readout's methods, for the allocation check (they run every frame the crosshair shows). */
const READOUT_HOT: readonly unknown[] = Object.getOwnPropertyNames(Readout.prototype)
  .filter((name) => name !== 'constructor')
  .map((name) => Object.getOwnPropertyDescriptor(Readout.prototype, name)?.value as unknown);

/* ---------------------------------------------------------------------------------------------- */
/* Ink slots: tap notes and revision clouds, written into buffers made at create                  */
/* ---------------------------------------------------------------------------------------------- */

interface InkSlot {
  readonly pts: Float64Array;
  readonly cum: Float64Array;
  readonly starts: Int32Array;
  readonly base: Float64Array;
  n: number;
  s: number;
  total: number;
  t0: number;
  fadeAt: number;
  used: boolean;
  /** A finished note, drawn into the ink layer (so it costs nothing per frame). */
  baked: boolean;
}

const NEVER = 1e12;

function makeSlot(points: number, strokes: number): InkSlot {
  return { pts: new Float64Array(points * 2), cum: new Float64Array(points), starts: new Int32Array(strokes), base: new Float64Array(strokes), n: 0, s: 0, total: 0, t0: 0, fadeAt: NEVER, used: false, baked: false };
}

function slotReset(sl: InkSlot, t0: number): void {
  sl.n = 0;
  sl.s = 0;
  sl.total = 0;
  sl.t0 = t0;
  sl.fadeAt = NEVER;
  sl.used = true;
  sl.baked = false;
}

/** Closes the stroke in progress: the next one starts after it (each stroke counts at least 0.3 px). */
function slotClose(sl: InkSlot): void {
  if (sl.s === 0) return;
  const k = sl.s - 1;
  const i0 = sl.starts[k] as number;
  const L = sl.n > i0 ? (sl.cum[sl.n - 1] as number) : 0;
  sl.total = (sl.base[k] as number) + Math.max(L, 0.3);
}

function slotBegin(sl: InkSlot): boolean {
  if (sl.s >= sl.starts.length || sl.n >= sl.cum.length) return false;
  slotClose(sl);
  sl.starts[sl.s] = sl.n;
  sl.base[sl.s] = sl.total;
  sl.s++;
  return true;
}

function slotPt(sl: InkSlot, x: number, y: number): void {
  if (sl.n >= sl.cum.length || sl.s === 0) return;
  const i = sl.n;
  if (i > (sl.starts[sl.s - 1] as number)) sl.cum[i] = (sl.cum[i - 1] as number) + Math.hypot(x - (sl.pts[2 * i - 2] as number), y - (sl.pts[2 * i - 1] as number));
  else sl.cum[i] = 0;
  sl.pts[2 * i] = x;
  sl.pts[2 * i + 1] = y;
  sl.n = i + 1;
}

function slotGlyph(sl: InkSlot, g: Glyph, gx: number, oy: number, un: number, px: number, py: number, ca: number, sa: number): void {
  for (let k = 0; k < g.length; k++) {
    const pl = g[k] as Float64Array;
    if (!slotBegin(sl)) return;
    for (let j = 0; j < pl.length; j += 2) {
      const lx = gx + (pl[j] as number) * un;
      const ly = oy + (pl[j + 1] as number) * un;
      slotPt(sl, px + lx * ca - ly * sa, py + lx * sa + ly * ca);
    }
  }
}

/** The number of decimal digits in a non-negative integer. */
function digitCount(n: number): number {
  let k = 1;
  for (let p = 10; p <= n; p *= 10) k++;
  return k;
}

/* ---------------------------------------------------------------------------------------------- */
/* The sheet                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TitleStrip extends Rect {
  vertical: boolean;
  compact?: boolean;
  pos?: 'top' | 'bottom' | 'side';
  side?: 'left' | 'right';
}

export type RegionKey = 'L' | 'R' | 'T' | 'B';

export interface SheetGeom {
  u: number;
  b: number;
  C: Rect;
  A: Rect;
  TB: TitleStrip;
  card: Rect;
  th: number;
  lab: number;
  wide: boolean;
  regions: Record<RegionKey, Rect>;
  W: number;
  H: number;
}

export type CellKey = 'notes' | 'rev' | 'project' | 'title' | 'scale' | 'revno' | 'sheet';
export interface Cell extends Rect {
  pad: number;
}
export type Cells = Partial<Record<CellKey, Cell>>;

/** What a seed fixes about a sheet's look (the core reads these; styles add their own). */
export interface SheetLook {
  readonly tbLeft: boolean;
  readonly penW: number;
  readonly prefer: number;
  readonly gratF: number;
  readonly legend: boolean;
  /** North arrow style, 0-2. */
  readonly na?: number;
  /** Scale bar style, 0-1 (0 adds kilometres). */
  readonly sb?: number;
  readonly hatchA?: number;
}

/** Title-block lettering a style calls at the right point in its plot order. */
export interface TitleKit {
  put(P: Plot, cell: Cell | undefined, str: string, h0: number, maxLines: number, align?: 'l' | 'c', c?: Pen, top?: number): number | null;
  notes(P: Plot, list: readonly string[]): void;
  rev(P: Plot): void;
}

export interface SheetBuild<L extends SheetLook> {
  readonly P: Plot;
  readonly G: SheetGeom;
  readonly u: number;
  readonly th: number;
  readonly cells: Cells;
  readonly TBK: TitleKit;
  readonly COL: SheetColours;
  readonly look: L;
  readonly W: number;
  readonly H: number;
  readonly siteName: string | undefined;
  readonly glyphs: GlyphTable;
}

/** What a style's tap and readout hooks can ask of the sheet. */
export interface SheetApi {
  readonly G: SheetGeom;
  /** Letters a name beside a tapped feature, with a short leader, in the reviewer's red pen (always true). */
  note(N: Rect, x: number, y: number, name: string, t: number): boolean;
  inCard(x: number, y: number, m: number): boolean;
  /** Records a tapped feature (three numbers that identify it); false if it was already recorded. */
  fresh(a: number, b: number, c: number): boolean;
}

export interface SheetSpec<L extends SheetLook> {
  /** The style's ID (for build failures). */
  readonly id: string;
  /** Title-block cell labels that differ from the defaults (e.g. `title: 'COUNTY'`). */
  readonly labels?: Partial<Record<CellKey, string>>;
  readonly look: L;
  readonly glyphs: GlyphTable;
  /** The longest the plot may take (seconds): a longer timeline is compressed to fit. */
  readonly maxSeconds: number;
  build(B: SheetBuild<L>): void;
  /** The crosshair's lines at (x, y), written into `out`; false: plain sheet coordinates. Allocation-free. */
  readout?(x: number, y: number, out: Readout): boolean;
  /** A tap on the sheet; true if it lettered a feature (else a revision cloud is stamped). Allocation-free. */
  tap?(x: number, y: number, t: number, api: SheetApi): boolean;
  /** The style's own per-frame helpers, for the allocation check. */
  readonly hot?: readonly unknown[];
}

/** Builds that threw (the sheet still shows what was plotted before the error). For tests; at most 20. */
export const buildFailures: { style: string; error: unknown }[] = [];

const LABELS: Readonly<Record<CellKey, string>> = { notes: 'NOTES', rev: 'REVISIONS', project: 'PROJECT', title: 'TITLE', scale: 'SCALE', revno: 'REV', sheet: 'SHEET' };
const NOTE_SLOTS = 12;
const CLOUD_SLOTS = 8;
const DIR_X = new Float64Array([1, -1, 1, -1]);
const DIR_Y = new Float64Array([1, 1, -1, -1]);
const NOTE_DX = new Float64Array([1, -1, 1, -1]);
const NOTE_DY = new Float64Array([-1, -1, 1, 1]);
const SEEN = 64;

/**
 * Creates a sheet: lays it out beside the card, builds the plot (`spec.build`), and returns the style
 * instance that plots it over time, hosts the crosshair, and answers taps.
 */
export function createSheet<L extends SheetLook>(setup: StyleSetup, rng: Rng, COL: SheetColours, spec: SheetSpec<L>): StyleInstance {
  const W = setup.width;
  const H = setup.height;
  const look = spec.look;
  const glyphs = spec.glyphs;
  const motion = setup.motion;
  const cardIn = setup.card;
  const noise = createNoise(rng.fork('paper-noise'));
  const paperRng = rng.fork('paper');
  const tapRng = rng.fork('taps');

  /* ---------- layout from the card (the lab's geom) ---------- */
  function geom(): SheetGeom {
    const u = clamp(Math.sqrt(W * H) / 1012, 0.52, 1.25);
    const b = Math.round(10 + 8 * u);
    const cr: Rect = { x: cardIn.x, y: cardIn.y, w: cardIn.width, h: cardIn.height };
    const m = 16 * u;
    const C: Rect = { x: cr.x - m, y: cr.y - m, w: cr.w + 2 * m, h: cr.h + 2 * m };
    const th = clamp(8.6 * u, 6.4, 11);
    const lab = 15 * u;
    const R = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w: Math.max(0, w), h: Math.max(0, h) });
    const hits = (r: Rect, pad: number) => r.x < cr.x + cr.w + pad && r.x + r.w > cr.x - pad && r.y < cr.y + cr.h + pad && r.y + r.h > cr.y - pad;
    const regionsFor = (A: Rect, TB: TitleStrip | null): Record<RegionKey, Rect> => {
      let T = R(A.x, A.y, A.w, C.y - A.y);
      let Bt = R(A.x, C.y + C.h, A.w, A.y + A.h - (C.y + C.h));
      if (TB && !TB.vertical) {
        const gap = 5 * u;
        if (TB.y + TB.h <= cr.y) {
          const y0 = Math.max(A.y, TB.y + TB.h + gap);
          T = R(A.x, y0, A.w, C.y - y0);
        } else Bt = R(A.x, C.y + C.h, A.w, Math.min(A.y + A.h, TB.y - gap) - (C.y + C.h));
      }
      return { L: R(A.x, A.y, C.x - A.x, A.h), R: R(C.x + C.w, A.y, A.x + A.w - (C.x + C.w), A.h), T, B: Bt };
    };
    // How tall a neatline the roomiest region could hold (0 if none is usable).
    const room = (rg: Record<RegionKey, Rect>) => {
      let best = 0;
      for (const k of ['L', 'R', 'T', 'B'] as const) {
        const r = rg[k];
        if (r.w >= 90) best = Math.max(best, Math.min(r.h, r.w * 1.6) - 2 * lab);
      }
      return best;
    };
    let A: Rect | null = null;
    let TB: TitleStrip | null = null;
    if (W >= 640 && W / H > 1.05) {
      const ts = clamp(W * 0.12, 118, 176);
      for (const left of look.tbLeft ? [true, false] : [false, true]) {
        const t: TitleStrip = { x: left ? b : W - b - ts, y: b, w: ts, h: H - 2 * b, vertical: true };
        if (!hits(t, 6)) {
          TB = t;
          A = { x: left ? b + ts : b, y: b, w: W - 2 * b - ts, h: H - 2 * b };
          break;
        }
      }
    }
    if (!TB || !A) {
      // Phone-shaped stages: the top ~50 px is the status-bar safe area.
      const safe = W < 520 && H > W * 1.4 ? 50 : 0;
      const top0 = Math.max(b, safe);
      const area: Rect = { x: b, y: top0, w: W - 2 * b, h: H - b - top0 };
      A = area;
      const tm = 6;
      const tbh = clamp(112 * u, 72, 132);
      const full: TitleStrip[] = [];
      const comp: TitleStrip[] = [];
      if (cr.y - tm - top0 >= tbh) full.push({ x: b, y: top0, w: W - 2 * b, h: tbh, vertical: false, pos: 'top' });
      if (H - b - (cr.y + cr.h + tm) >= tbh) full.push({ x: b, y: H - b - tbh, w: W - 2 * b, h: tbh, vertical: false, pos: 'bottom' });
      // Compact strips may reach into the sheet margin when the band is thin (never into the safe area).
      const chMax = clamp(th * 4.4, 24, 46);
      const t0 = Math.max(3, safe);
      const ct = cr.y - 4 - t0;
      const cb = H - 3 - (cr.y + cr.h + 4);
      if (ct >= 12) {
        const ch = Math.min(chMax, ct);
        comp.push({ x: b, y: Math.max(t0, Math.min(top0, cr.y - 4 - ch)), w: W - 2 * b, h: ch, vertical: false, compact: true, pos: 'top' });
      }
      if (cb >= 12) {
        const ch = Math.min(chMax, cb);
        comp.push({ x: b, y: Math.min(H - 3 - ch, Math.max(H - b - ch, cr.y + cr.h + 4)), w: W - 2 * b, h: ch, vertical: false, compact: true, pos: 'bottom' });
      }
      const MIN = 40;
      const cap = (t: TitleStrip) => room(regionsFor(area, t));
      TB =
        full.find((t) => cap(t) >= MIN) ??
        comp
          .slice()
          .sort((x, y) => cap(y) - cap(x))
          .find((t) => cap(t) >= MIN) ??
        full[0] ??
        comp.sort((x, y) => y.h - x.h)[0] ??
        null;
      if (!TB) {
        // The card fills the stage top to bottom: letter the title up the wider side gutter.
        const gl = cr.x - 5;
        const gr = W - (cr.x + cr.w) - 5;
        const right = gr >= gl;
        const gw = Math.max(4, Math.min(right ? gr : gl, 22));
        TB = { x: right ? cr.x + cr.w + 3 : Math.max(2, cr.x - 3 - gw), y: t0, w: gw, h: H - 3 - t0, vertical: false, compact: true, side: right ? 'right' : 'left', pos: 'side' };
      }
    }
    return { u, b, C, A, TB, card: cr, th, lab, wide: TB.vertical, regions: regionsFor(A, TB), W, H };
  }

  function titleLayout(G: SheetGeom): Cells {
    const T = G.TB;
    const u = G.u;
    const c: Cells = {};
    if (T.compact) {
      c.title = { x: T.x, y: T.y, w: T.w, h: T.h, pad: Math.max(2, Math.min(4 * u, T.h * 0.14)) };
      return c;
    }
    const pad = Math.max(3, 4 * u);
    if (T.vertical) {
      let y = T.y;
      const row = (k: CellKey, f: number) => {
        const h = k === 'sheet' ? T.y + T.h - y : T.h * f;
        c[k] = { x: T.x, y, w: T.w, h, pad };
        y += h;
      };
      row('notes', 0.25);
      row('rev', 0.07);
      row('project', 0.13);
      row('title', 0.3);
      row('scale', 0.09);
      row('sheet', 0);
      const sc = c.scale as Cell;
      c.scale = { x: sc.x, y: sc.y, w: sc.w * 0.62, h: sc.h, pad };
      c.revno = { x: sc.x + sc.w * 0.62, y: sc.y, w: sc.w * 0.38, h: sc.h, pad };
    } else {
      const h1 = T.h * 0.27;
      const h2 = T.h * 0.47;
      const h3 = T.h - h1 - h2;
      const w = T.w;
      c.project = { x: T.x, y: T.y, w: w * 0.62, h: h1, pad };
      c.sheet = { x: T.x + w * 0.62, y: T.y, w: w * 0.38, h: h1, pad };
      c.title = { x: T.x, y: T.y + h1, w: w * 0.62, h: h2, pad };
      c.scale = { x: T.x + w * 0.62, y: T.y + h1, w: w * 0.22, h: h2, pad };
      c.revno = { x: T.x + w * 0.84, y: T.y + h1, w: w * 0.16, h: h2, pad };
      c.notes = { x: T.x, y: T.y + h1 + h2, w, h: h3, pad };
    }
    return c;
  }

  const G = geom();
  const cells = titleLayout(G);
  const u = G.u;
  const card = G.card;

  /* ---------- pens ---------- */
  const penW = new Float64Array(PENS.length);
  const penC: string[] = [];
  {
    const k = clamp(u, 0.8, 1.15);
    const w = look.penW || 1;
    const spec2: Record<Pen, [number, string]> = {
      C: [0.55 * k, COL.cons],
      O: [1.5 * k * w, COL.ink],
      M: [1.0 * k * w, COL.ink2],
      T: [0.7 * k, COL.ink3],
      H: [0.5 * k, COL.hatch],
      D: [0.6 * k, COL.dim],
      X: [0.78 * k, COL.dim],
      K: [1.25 * k * w, COL.ink],
      V: [1.9 * k * w, COL.water],
      W: [1.0 * k * w, COL.water],
      Y: [0.72 * k, COL.water],
      w: [0.6 * k, COL.waterPale],
      S: [0.9 * k, COL.water],
      P: [0.55 * k, COL.ink3],
      R: [1.2 * k, COL.red],
      Z: [0.95 * k, COL.star ?? COL.ink],
      z: [0.6 * k, COL.starPale ?? COL.ink3],
    };
    for (let i = 0; i < PENS.length; i++) {
      const [pw, pc] = spec2[PENS[i] as Pen];
      penW[i] = pw;
      penC.push(pc);
    }
  }
  const PEN_R = PENS.indexOf('R');

  function clipCard(x: Ctx2D): void {
    x.beginPath();
    x.rect(0, 0, W, H);
    x.rect(card.x - 3, card.y - 3, card.w + 6, card.h + 6);
    x.clip('evenodd');
  }

  /* ---------- the paper (drawn once) ---------- */
  const bg: Layer = setup.createLayer(W, H);
  {
    const x = bg.ctx;
    x.fillStyle = COL.paper;
    x.fillRect(0, 0, W, H);
    const tw = Math.ceil(W / 3);
    const tH = Math.ceil(H / 3);
    const tex = setup.createLayer(tw, tH, 1);
    const img = tex.ctx.createImageData(tex.canvas.width, tex.canvas.height);
    const d = img.data;
    const iw = tex.canvas.width;
    const ih = tex.canvas.height;
    for (let j = 0; j < ih; j++) {
      for (let i = 0; i < iw; i++) {
        const v = noise.noise2(i * 0.035, j * 0.035) * 0.55 + noise.noise2(i * 0.13 + 40, j * 0.13) * 0.3 + (paperRng.next() - 0.5) * 0.5;
        const o = (j * iw + i) * 4;
        const a = Math.min(1, Math.abs(v)) * COL.tex * 255;
        const c2 = v > 0 ? 255 : 0;
        d[o] = c2;
        d[o + 1] = c2;
        d[o + 2] = c2;
        d[o + 3] = a;
      }
    }
    tex.ctx.putImageData(img, 0, 0);
    x.imageSmoothingEnabled = true;
    x.drawImage(tex.canvas, 0, 0, W, H);
    const vg = x.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.hypot(W, H) * 0.62);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, rgba('#000000', COL.vig));
    x.fillStyle = vg;
    x.fillRect(0, 0, W, H);
    const fx = Math.round(W * (0.5 + (paperRng.next() - 0.5) * 0.04)) + 0.5;
    const fy = Math.round(H * (0.5 + (paperRng.next() - 0.5) * 0.06)) + 0.5;
    const fa = COL.dark ? 0.08 : 0.035;
    x.lineWidth = 1;
    x.strokeStyle = rgba('#ffffff', fa * 1.4);
    x.beginPath();
    x.moveTo(fx, 0);
    x.lineTo(fx, H);
    x.moveTo(0, fy);
    x.lineTo(W, fy);
    x.stroke();
    x.strokeStyle = rgba('#000000', fa);
    x.beginPath();
    x.moveTo(fx + 1, 0);
    x.lineTo(fx + 1, H);
    x.moveTo(0, fy + 1);
    x.lineTo(W, fy + 1);
    x.stroke();
    // The grid, kept off the card.
    const A = G.A;
    const gs = Math.max(6, Math.round(12 * u * 2) / 2);
    x.save();
    x.beginPath();
    x.rect(0, 0, W, H);
    x.rect(card.x - 2, card.y - 2, card.w + 4, card.h + 4);
    x.clip('evenodd');
    for (const major of [false, true]) {
      x.strokeStyle = major ? COL.gridMajor : COL.gridMinor;
      x.lineWidth = major ? 0.7 : 0.5;
      x.beginPath();
      for (let i = 0, xx = A.x; xx <= A.x + A.w + 0.1; xx += gs, i++) {
        if ((i % 5 === 0) === major) {
          x.moveTo(Math.round(xx) + 0.25, A.y);
          x.lineTo(Math.round(xx) + 0.25, A.y + A.h);
        }
      }
      for (let i = 0, yy = A.y + A.h; yy >= A.y - 0.1; yy -= gs, i++) {
        if ((i % 5 === 0) === major) {
          x.moveTo(A.x, Math.round(yy) + 0.25);
          x.lineTo(A.x + A.w, Math.round(yy) + 0.25);
        }
      }
      x.stroke();
    }
    x.restore();
    const b = G.b;
    const o = Math.max(4, b - 11 * u);
    const lw = clamp(u, 0.8, 1.15);
    x.lineCap = 'round';
    x.lineJoin = 'round';
    x.strokeStyle = COL.ink3;
    x.lineWidth = 0.6 * lw;
    x.strokeRect(o, o, W - 2 * o, H - 2 * o);
    x.strokeStyle = COL.ink;
    x.lineWidth = 1.4 * lw;
    x.strokeRect(b, b, W - 2 * b, H - 2 * b);
    x.strokeStyle = COL.ink3;
    x.lineWidth = 0.7 * lw;
    x.beginPath();
    const zh = Math.min(6 * u, (b - o) * 0.62);
    const nzx = Math.max(2, Math.round(W / 220));
    const nzy = Math.max(2, Math.round(H / 200));
    for (let i = 1; i < nzx; i++) {
      const xx = o + ((W - 2 * o) * i) / nzx;
      x.moveTo(xx, o);
      x.lineTo(xx, b);
      x.moveTo(xx, H - o);
      x.lineTo(xx, H - b);
    }
    for (let i = 1; i < nzy; i++) {
      const yy = o + ((H - 2 * o) * i) / nzy;
      x.moveTo(o, yy);
      x.lineTo(b, yy);
      x.moveTo(W - o, yy);
      x.lineTo(W - b, yy);
    }
    for (let i = 0; i < nzx; i++) {
      const xx = o + ((W - 2 * o) * (i + 0.5)) / nzx;
      const lab = String(nzx - i);
      strokeTextNow(x, glyphs, lab, xx, (o + b) / 2 + zh / 2, zh, 'c');
      strokeTextNow(x, glyphs, lab, xx, H - (o + b) / 2 + zh / 2, zh, 'c');
    }
    for (let i = 0; i < nzy; i++) {
      const yy = o + ((H - 2 * o) * (i + 0.5)) / nzy;
      const lab = String.fromCharCode(65 + i);
      strokeTextNow(x, glyphs, lab, (o + b) / 2, yy + zh / 2, zh, 'c');
      strokeTextNow(x, glyphs, lab, W - (o + b) / 2, yy + zh / 2, zh, 'c');
    }
    x.stroke();
    const T = G.TB;
    x.fillStyle = COL.paper;
    x.globalAlpha = T.compact ? 1 : 0.55;
    x.fillRect(T.x, T.y, T.w, T.h);
    x.globalAlpha = 1;
    x.strokeStyle = COL.ink;
    x.lineWidth = 1.2 * lw;
    x.strokeRect(T.x, T.y, T.w, T.h);
    x.strokeStyle = COL.ink3;
    x.lineWidth = 0.7 * lw;
    x.beginPath();
    const lab = G.th * 0.62;
    if (!T.compact) {
      for (const key of Object.keys(cells) as CellKey[]) {
        const cc = cells[key] as Cell;
        x.rect(cc.x, cc.y, cc.w, cc.h);
        strokeTextNow(x, glyphs, spec.labels?.[key] ?? LABELS[key], cc.x + cc.pad, cc.y + cc.pad + lab, lab, 'l');
      }
    } else if (T.w > 10 && T.h > 10) x.rect(T.x + 1.5, T.y + 1.5, T.w - 3, T.h - 3);
    if (cells.rev) {
      const cc = cells.rev;
      const yy = cc.y + cc.pad + lab + 3 * u;
      x.moveTo(cc.x, yy);
      x.lineTo(cc.x + cc.w, yy);
      x.moveTo(cc.x + cc.pad + 7 * u, yy);
      x.lineTo(cc.x + cc.pad + 7 * u, cc.y + cc.h);
    }
    x.stroke();
  }

  /* ---------- title-block lettering the style calls in its plot order ---------- */
  const TBK: TitleKit = {
    put(P, cell, str, h0, maxLines, align, c, top) {
      if (!cell) return null;
      const lab = G.th * 0.62;
      const p = cell.pad;
      const t0 = top || cell.y + p + lab + 3 * u;
      const avH = cell.y + cell.h - p - t0;
      const maxW = cell.w - 2 * p;
      const f = fitText(str, Math.min(h0, avH / (maxLines * 1.45)), maxW, maxLines);
      const lh = f.h * 1.45;
      let y = t0 + f.h;
      for (const line of f.lines) {
        P.text(line, align === 'c' ? cell.x + cell.w / 2 : cell.x + p, y, f.h, align || 'l', 0, c || 'K');
        y += lh;
      }
      return y - lh + f.h * 0.45;
    },
    notes(P, list) {
      const c = cells.notes;
      if (!c) {
        const o = Math.max(4, G.b - 11 * u);
        const gl = Math.min(G.b, card.x - 1.5) - o;
        const gr = W - o - Math.max(W - G.b, card.x + card.w + 1.5);
        const left = G.TB.side === 'right' ? true : G.TB.side === 'left' ? false : gl >= gr;
        const gw = left ? gl : gr;
        if (gw < 4.5) return;
        const h = Math.min(gw - 1.2, G.th * 0.62);
        const x = left ? o + gl / 2 : W - o - gr / 2;
        const f = fitText(list.join('  ·  '), h, H - 2 * G.b - 8, 1);
        P.text(f.lines[0] as string, x, H / 2, f.h, 'c', left ? -Math.PI / 2 : Math.PI / 2, 'X', 'm');
        return;
      }
      const lab = G.th * 0.62;
      const p = c.pad;
      const nh = Math.min(G.th * (G.TB.vertical ? 0.74 : 0.62), c.h * 0.22);
      const maxW = c.w - 2 * p;
      let y = c.y + p + lab + 4 * u + nh;
      if (!G.TB.vertical) {
        // One or two running lines.
        const f = fitText(list.join('  ·  '), nh, maxW, 2);
        for (const line of f.lines) {
          if (y > c.y + c.h - p + 1) return;
          P.text(line, c.x + p, y, f.h, 'l', 0, 'X');
          y += f.h * 1.6;
        }
        return;
      }
      for (const n of list) {
        const f = fitText(n, nh, maxW, 3);
        for (const line of f.lines) {
          if (y > c.y + c.h - p) return;
          P.text(line, c.x + p, y, f.h, 'l', 0, 'X');
          y += f.h * 1.6;
        }
        y += nh * 0.35;
      }
    },
    rev(P) {
      const c = cells.rev;
      if (!c) return;
      const lab = G.th * 0.62;
      const p = c.pad;
      const rh = G.th * 0.72;
      const y = c.y + p + lab + 7 * u + rh;
      if (y < c.y + c.h - p) {
        P.text('0', c.x + p + 3 * u, y, rh, 'c', 0, 'X');
        const s = 'ISSUED FOR REVIEW';
        P.text(s, c.x + p + 10 * u, y, Math.min(rh, (c.w - 2 * p - 12 * u) / strW(s, 1)), 'l', 0, 'X');
      }
    },
  };

  /* ---------- the plot: built once, flattened into a timeline ---------- */
  const P = new Plot(u, glyphs);
  P.th = G.th;
  try {
    spec.build({ P, G, u, th: G.th, cells, TBK, COL, look, W, H, siteName: setup.siteName, glyphs });
  } catch (error) {
    if (buildFailures.length < 20) buildFailures.push({ style: spec.id, error });
  }
  let nPts = 0;
  let nStrokes = 0;
  for (const v of P.views) {
    nStrokes += v.s.length;
    for (const s of v.s) nPts += s.p.length / 2;
  }
  const PP = new Float64Array(nPts * 2);
  const PC = new Float64Array(nPts);
  const sA = new Int32Array(nStrokes);
  const sB = new Int32Array(nStrokes);
  const sLen = new Float64Array(nStrokes);
  const sSpd = new Float64Array(nStrokes);
  const sT0 = new Float64Array(nStrokes);
  const sT1 = new Float64Array(nStrokes);
  const sCls = new Uint8Array(nStrokes);
  const viewT0: number[] = [];
  let total = 0;
  {
    // Each view's pen speed is set so the view takes about its duration.
    let T = 0;
    let px: number | null = null;
    let py = 0;
    let k = 0;
    let q = 0;
    for (const v of P.views) {
      viewT0.push(T);
      if (!v.s.length) continue;
      let L = 0;
      let tr = 0;
      let qx = px;
      let qy = py;
      for (const s of v.s) {
        const p = s.p;
        L += Math.max(polyLen(p), 0.3);
        if (qx !== null) tr += Math.hypot((p[0] as number) - qx, (p[1] as number) - qy);
        qx = p[p.length - 2] as number;
        qy = p[p.length - 1] as number;
      }
      const work = L + tr * 0.3;
      const minSpd = 70 * u;
      const dur = Math.min(v.dur, work / minSpd);
      const spd = work / Math.max(0.05, dur);
      viewT0[viewT0.length - 1] = T;
      for (const s of v.s) {
        const p = s.p;
        const n = p.length / 2;
        sA[k] = q;
        let l = 0;
        for (let i = 0; i < n; i++) {
          if (i) l += Math.hypot((p[2 * i] as number) - (p[2 * i - 2] as number), (p[2 * i + 1] as number) - (p[2 * i - 1] as number));
          PP[2 * q] = p[2 * i] as number;
          PP[2 * q + 1] = p[2 * i + 1] as number;
          PC[q] = l;
          q++;
        }
        sB[k] = q;
        const travel = px === null ? 0 : Math.hypot((p[0] as number) - px, (p[1] as number) - py);
        sLen[k] = Math.max(l, 0.3);
        sSpd[k] = spd;
        sT0[k] = T + (travel * 0.3) / spd;
        sT1[k] = (sT0[k] as number) + (sLen[k] as number) / spd;
        sCls[k] = Math.max(0, PENS.indexOf(s.c));
        T = sT1[k] as number;
        px = p[p.length - 2] as number;
        py = p[p.length - 1] as number;
        k++;
      }
    }
    total = T;
    // A timeline longer than the style allows is compressed to fit (so it settles when it says it does).
    if (total > spec.maxSeconds) {
      const f = spec.maxSeconds / total;
      for (let i = 0; i < nStrokes; i++) {
        sT0[i] = (sT0[i] as number) * f;
        sT1[i] = (sT1[i] as number) * f;
        sSpd[i] = (sSpd[i] as number) / f;
      }
      for (let i = 0; i < viewT0.length; i++) viewT0[i] = (viewT0[i] as number) * f;
      total = spec.maxSeconds;
    }
  }
  const nSnaps = P.snaps.length;
  const snX = new Float64Array(nSnaps);
  const snY = new Float64Array(nSnaps);
  const snT = new Uint8Array(nSnaps);
  const snAt = new Float64Array(nSnaps);
  const snLab: string[] = [];
  P.snaps.forEach((sn, i) => {
    snX[i] = sn.x;
    snY[i] = sn.y;
    snT[i] = sn.t ? 1 : 0;
    snAt[i] = viewT0[sn.v] ?? 0;
    snLab.push(sn.lab.toUpperCase());
  });

  /* ---------- the ink layer, plotted progressively ---------- */
  const ink: Layer = setup.createLayer(W, H);
  const inkx = ink.ctx;
  inkx.lineCap = 'round';
  inkx.lineJoin = 'round';
  inkx.save();
  clipCard(inkx);
  let V = 0;
  let kIdx = 0;
  let penX = nStrokes ? (PP[0] as number) : W / 2;
  let penY = nStrokes ? (PP[1] as number) : H / 2;
  let penDown = false;

  function setPen(x: Ctx2D, c: number): void {
    x.lineWidth = penW[c] as number;
    x.strokeStyle = penC[c] as string;
  }

  /** Adds the part of a polyline between lengths d0 and d1 to the current path (points i0 to i1). */
  function pathPart(x: Ctx2D, pts: Float64Array, cum: Float64Array, i0: number, i1: number, d0: number, d1: number): void {
    const n = i1 - i0;
    if (n < 2) return;
    let i = 1;
    while (i < n - 1 && (cum[i0 + i] as number) < d0) i++;
    let c0 = cum[i0 + i - 1] as number;
    let L = (cum[i0 + i] as number) - c0;
    let t = L > 0 ? clamp((d0 - c0) / L, 0, 1) : 0;
    let a = 2 * (i0 + i - 1);
    x.moveTo((pts[a] as number) + ((pts[a + 2] as number) - (pts[a] as number)) * t, (pts[a + 1] as number) + ((pts[a + 3] as number) - (pts[a + 1] as number)) * t);
    while (i < n - 1 && (cum[i0 + i] as number) <= d1) {
      x.lineTo(pts[2 * (i0 + i)] as number, pts[2 * (i0 + i) + 1] as number);
      i++;
    }
    c0 = cum[i0 + i - 1] as number;
    L = (cum[i0 + i] as number) - c0;
    t = L > 0 ? clamp((d1 - c0) / L, 0, 1) : 1;
    a = 2 * (i0 + i - 1);
    x.lineTo((pts[a] as number) + ((pts[a + 2] as number) - (pts[a] as number)) * t, (pts[a + 1] as number) + ((pts[a + 3] as number) - (pts[a + 1] as number)) * t);
  }

  /** Plots everything between the plotted time and `nv` into the ink layer, and moves the pen. */
  function advance(nv: number): void {
    let cl = -1;
    let open = false;
    while (kIdx < nStrokes) {
      const t0 = sT0[kIdx] as number;
      if (t0 >= nv) break;
      const spd = sSpd[kIdx] as number;
      const d0 = Math.max(0, (V - t0) * spd);
      const d1 = Math.min(sLen[kIdx] as number, (nv - t0) * spd);
      if (d1 > d0) {
        if (sCls[kIdx] !== cl) {
          if (open) inkx.stroke();
          cl = sCls[kIdx] as number;
          setPen(inkx, cl);
          inkx.beginPath();
          open = true;
        }
        pathPart(inkx, PP, PC, sA[kIdx] as number, sB[kIdx] as number, d0, d1);
      }
      if (nv >= (sT1[kIdx] as number)) kIdx++;
      else break;
    }
    if (open) inkx.stroke();
    V = nv;
    if (kIdx < nStrokes) {
      const s0 = sT0[kIdx] as number;
      if (V < s0) {
        const a = sA[kIdx] as number;
        let ex = PP[2 * a] as number;
        let ey = PP[2 * a + 1] as number;
        let pt0 = 0;
        if (kIdx > 0) {
          const e = (sB[kIdx - 1] as number) - 1;
          ex = PP[2 * e] as number;
          ey = PP[2 * e + 1] as number;
          pt0 = sT1[kIdx - 1] as number;
        }
        const t = s0 > pt0 ? (V - pt0) / (s0 - pt0) : 1;
        penX = lerp(ex, PP[2 * a] as number, t);
        penY = lerp(ey, PP[2 * a + 1] as number, t);
        penDown = false;
      } else {
        const a = sA[kIdx] as number;
        const n = (sB[kIdx] as number) - a;
        const d = (V - s0) * (sSpd[kIdx] as number);
        let i = 1;
        while (i < n - 1 && (PC[a + i] as number) < d) i++;
        const c0 = PC[a + i - 1] as number;
        const L = (PC[a + i] as number) - c0;
        const t = L > 0 ? clamp((d - c0) / L, 0, 1) : 1;
        const b = 2 * (a + i - 1);
        penX = (PP[b] as number) + ((PP[b + 2] as number) - (PP[b] as number)) * t;
        penY = (PP[b + 1] as number) + ((PP[b + 3] as number) - (PP[b + 1] as number)) * t;
        penDown = true;
      }
    } else penDown = false;
  }

  function resetInk(): void {
    inkx.clearRect(0, 0, W, H);
    V = 0;
    kIdx = 0;
    for (let i = 0; i < notes.length; i++) (notes[i] as InkSlot).baked = false;
  }

  /* ---------- notes and revision clouds ---------- */
  const notes: InkSlot[] = [];
  for (let i = 0; i < NOTE_SLOTS; i++) notes.push(makeSlot(900, 220));
  let noteNext = 0;
  const clouds: InkSlot[] = [];
  for (let i = 0; i < CLOUD_SLOTS; i++) clouds.push(makeSlot(420, 40));
  let cloudNext = 0;
  let revCount = 0;
  const seenKeys = new Float64Array(SEEN * 3).fill(NaN);
  let seenNext = 0;
  const kk = clamp(u, 0.8, 1.15);
  const cloudW01 = 1.35 * kk;
  const cloudW2 = 0.9 * kk;

  function slotText(sl: InkSlot, s: string, x: number, y: number, h: number, al: number, va: number): void {
    const un = h / 6;
    const adv = 5.4 * un;
    const tw = textW(s.length, h);
    const ox = al < 0 ? 0 : al > 0 ? -tw : -tw / 2;
    const oy = va === 0 ? -3 * un : -6 * un;
    for (let i = 0; i < s.length; i++) {
      const g = glyphs.get(s.charCodeAt(i));
      if (g !== undefined) slotGlyph(sl, g, ox + i * adv, oy, un, x, y, 1, 0);
    }
  }

  function slotDigits(sl: InkSlot, n: number, x: number, y: number, h: number): void {
    const un = h / 6;
    const adv = 5.4 * un;
    const nd = digitCount(n);
    const ox = -textW(nd, h) / 2;
    let p = 1;
    for (let i = 1; i < nd; i++) p *= 10;
    let v = n;
    for (let i = 0; i < nd; i++) {
      const dgt = Math.floor(v / p);
      v -= dgt * p;
      p /= 10;
      const g = glyphs.get(48 + (dgt % 10));
      if (g !== undefined) slotGlyph(sl, g, ox + i * adv, -3 * un, un, x, y, 1, 0);
    }
  }

  function slotCircle(sl: InkSlot, cx: number, cy: number, r: number): void {
    const n = clamp(Math.ceil((TAU * r) / (2.4 * u)), 6, 200);
    if (!slotBegin(sl)) return;
    for (let i = 0; i <= n; i++) {
      const a = -Math.PI / 2 + (TAU * i) / n;
      slotPt(sl, cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
  }

  function slotLine(sl: InkSlot, x0: number, y0: number, x1: number, y1: number): void {
    if (!slotBegin(sl)) return;
    slotPt(sl, x0, y0);
    slotPt(sl, x1, y1);
  }

  function inCard(x: number, y: number, m: number): boolean {
    return x > card.x - m && x < card.x + card.w + m && y > card.y - m && y < card.y + card.h + m;
  }

  /** A tapped feature's name, lettered beside it with a short leader (the lab's tapNote). */
  function note(N: Rect, x: number, y: number, name: string, t: number): boolean {
    const h = G.th * 0.82;
    const w = textW(name.length, h);
    for (let q = 0; q < 4; q++) {
      const dx = NOTE_DX[q] as number;
      const dy = NOTE_DY[q] as number;
      const ex = x + dx * 16 * u;
      const ey = y + dy * 14 * u;
      const tx0 = dx > 0 ? ex : ex - w - 4 * u;
      if (tx0 < N.x + 2 || tx0 + w + 4 * u > N.x + N.w - 2 || ey - h < N.y + 2 || ey + 2 > N.y + N.h) continue;
      if (inCard(tx0, ey, 6) || inCard(tx0 + w, ey, 6) || inCard(tx0, ey - h, 6) || inCard(tx0 + w, ey - h, 6)) continue;
      const sl = notes[noteNext] as InkSlot;
      noteNext = (noteNext + 1) % NOTE_SLOTS;
      slotReset(sl, t);
      slotCircle(sl, x, y, 1.6 * u);
      slotLine(sl, x, y, ex, ey);
      slotLine(sl, ex, ey, ex + dx * (w + 4 * u), ey);
      slotText(sl, name, dx > 0 ? ex + 2 * u : ex - 2 * u - w, ey - 2 * u, h, -1, 1);
      slotClose(sl);
      return true;
    }
    return true;
  }

  function fresh(a: number, b: number, c: number): boolean {
    for (let i = 0; i < SEEN; i++) if (seenKeys[3 * i] === a && seenKeys[3 * i + 1] === b && seenKeys[3 * i + 2] === c) return false;
    seenKeys[3 * seenNext] = a;
    seenKeys[3 * seenNext + 1] = b;
    seenKeys[3 * seenNext + 2] = c;
    seenNext = (seenNext + 1) % SEEN;
    return true;
  }

  /** A revision cloud: a scalloped ring with a numbered delta, kept off the card. */
  function stamp(x0: number, y0: number, t: number): void {
    const rx = (34 + tapRng.next() * 20) * u;
    const ry = rx * (0.6 + tapRng.next() * 0.22);
    const C = card;
    const mg = 14 * u;
    const ex = rx + mg;
    const ey = ry + mg;
    let x = x0;
    let y = y0;
    if (x > C.x - ex && x < C.x + C.w + ex && y > C.y - ey && y < C.y + C.h + ey) {
      const dl = x - (C.x - ex);
      const dr = C.x + C.w + ex - x;
      const dt = y - (C.y - ey);
      const db = C.y + C.h + ey - y;
      const m = Math.min(dl, dr, dt, db);
      if (m === dl) x = C.x - ex;
      else if (m === dr) x = C.x + C.w + ex;
      else if (m === dt) y = C.y - ey;
      else y = C.y + C.h + ey;
    }
    x = clamp(x, G.b + rx + 4 * u, W - G.b - rx - 20 * u);
    y = clamp(y, G.b + ry + 20 * u, H - G.b - ry - 4 * u);
    const per = TAU * Math.sqrt((rx * rx + ry * ry) / 2);
    const n = Math.max(9, Math.round(per / (15 * u)));
    const rot = tapRng.next() * TAU;
    const sl = clouds[cloudNext] as InkSlot;
    const slotIndex = cloudNext;
    cloudNext = (cloudNext + 1) % CLOUD_SLOTS;
    slotReset(sl, t);
    slotBegin(sl);
    for (let i = 0; i < n; i++) {
      const a0 = rot + (i / n) * TAU;
      const a1 = rot + ((i + 1) / n) * TAU;
      const px0 = x + Math.cos(a0) * rx;
      const py0 = y + Math.sin(a0) * ry;
      const px1 = x + Math.cos(a1) * rx;
      const py1 = y + Math.sin(a1) * ry;
      const mx = (px0 + px1) / 2;
      const my = (py0 + py1) / 2;
      const nl = Math.hypot(mx - x, my - y) || 1;
      const nx = (mx - x) / nl;
      const ny = (my - y) / nl;
      const ch = Math.hypot(px1 - px0, py1 - py0);
      for (let k = i ? 1 : 0; k <= 8; k++) {
        const f = k / 8;
        const bb = Math.sin(f * Math.PI) * ch * 0.38;
        slotPt(sl, px0 + (px1 - px0) * f + nx * bb, py0 + (py1 - py0) * f + ny * bb);
      }
    }
    revCount++;
    const tx = x + rx * 0.82 + 10 * u;
    const ty = y - ry * 0.9 - 6 * u;
    const ts = 15 * u;
    if (slotBegin(sl)) {
      slotPt(sl, tx, ty - ts * 0.58);
      slotPt(sl, tx + ts / 2, ty + ts * 0.29);
      slotPt(sl, tx - ts / 2, ty + ts * 0.29);
      slotPt(sl, tx, ty - ts * 0.58);
    }
    slotDigits(sl, revCount, tx, ty + ts * 0.08, ts * 0.42);
    slotClose(sl);
    // At most five clouds stay; older ones fade out.
    let live = 0;
    for (let k = 0; k < CLOUD_SLOTS; k++) {
      const c = clouds[(slotIndex - k + CLOUD_SLOTS) % CLOUD_SLOTS] as InkSlot;
      if (!c.used || c.fadeAt < NEVER) continue;
      live++;
      if (live > 5) c.fadeAt = t;
    }
  }

  function drawSlot(x: Ctx2D, sl: InkSlot, lim: number, w01: number, w2: number): void {
    for (let k = 0; k < sl.s; k++) {
      const b0 = sl.base[k] as number;
      if (b0 >= lim) break;
      const i0 = sl.starts[k] as number;
      const i1 = k + 1 < sl.s ? (sl.starts[k + 1] as number) : sl.n;
      if (i1 - i0 < 2) continue;
      x.lineWidth = k < 2 ? w01 : w2;
      x.beginPath();
      pathPart(x, sl.pts, sl.cum, i0, i1, 0, Math.min(sl.cum[i1 - 1] as number, lim - b0));
      x.stroke();
    }
  }

  /** Draws finished notes into the ink layer once, so they cost nothing afterwards. */
  function bakeNotes(t: number): void {
    const w = penW[PEN_R] as number;
    for (let i = 0; i < NOTE_SLOTS; i++) {
      const sl = notes[i] as InkSlot;
      if (!sl.used || sl.baked || t < sl.t0) continue;
      if (motion && (t - sl.t0) * 260 * u < sl.total) continue;
      inkx.strokeStyle = penC[PEN_R] as string;
      drawSlot(inkx, sl, sl.total, w, w);
      sl.baked = true;
    }
  }

  /** Notes still being lettered (kept off the card). */
  function drawNotes(x: Ctx2D, t: number): void {
    const w = penW[PEN_R] as number;
    let open = false;
    for (let i = 0; i < NOTE_SLOTS; i++) {
      const sl = notes[i] as InkSlot;
      if (!sl.used || sl.baked || t < sl.t0) continue;
      if (!open) {
        x.save();
        clipCard(x);
        x.lineCap = 'round';
        x.lineJoin = 'round';
        x.strokeStyle = penC[PEN_R] as string;
        open = true;
      }
      drawSlot(x, sl, (t - sl.t0) * 260 * u, w, w);
    }
    if (open) x.restore();
  }

  function drawClouds(x: Ctx2D, t: number): void {
    x.lineCap = 'round';
    x.lineJoin = 'round';
    x.strokeStyle = COL.red;
    for (let i = 0; i < CLOUD_SLOTS; i++) {
      const sl = clouds[i] as InkSlot;
      if (!sl.used || t < sl.t0) continue;
      const a = sl.fadeAt < NEVER ? 1 - (t - sl.fadeAt) / 1.2 : 1;
      if (a <= 0) {
        sl.used = false;
        continue;
      }
      x.globalAlpha = a > 1 ? 1 : a;
      drawSlot(x, sl, clamp((t - sl.t0) / 1.3, 0, 1) * sl.total, cloudW01, cloudW2);
    }
    x.globalAlpha = 1;
  }

  /* ---------- the crosshair and readout ---------- */
  const readout = new Readout();
  const boxFill = rgba(COL.paper, 0.92);
  const penShadow = rgba('#000000', COL.dark ? 0.22 : 0.08);
  const penBody = rgba(COL.paper, 0.75);
  const penGuide = rgba(COL.ink3, 0.35);
  const fs = Math.round(clamp(10.5 * u, 9, 12));
  const rh = fs * 0.68;
  let crossA = 0;
  let snap = -1;

  function findSnap(px: number, py: number): void {
    snap = -1;
    let best = 13 * u;
    for (let i = 0; i < nSnaps; i++) {
      if ((snAt[i] as number) > V) continue;
      const d = Math.hypot((snX[i] as number) - px, (snY[i] as number) - py);
      if (d < best) {
        best = d;
        snap = i;
      }
    }
  }

  /** Letters character codes left to right with the baseline at y. */
  function strokeCodes(x: Ctx2D, codes: Uint16Array, n: number, px: number, py: number, h: number): void {
    const un = h / 6;
    const adv = 5.4 * un;
    for (let i = 0; i < n; i++) {
      const g = glyphs.get(codes[i] as number);
      if (g !== undefined) glyphPath(x, g, i * adv, -6 * un, un, px, py, 1, 0);
    }
  }

  function strokeString(x: Ctx2D, s: string, px: number, py: number, h: number): void {
    const un = h / 6;
    const adv = 5.4 * un;
    for (let i = 0; i < s.length; i++) {
      const g = glyphs.get(s.charCodeAt(i));
      if (g !== undefined) glyphPath(x, g, i * adv, -6 * un, un, px, py, 1, 0);
    }
  }

  function drawCross(x: Ctx2D, pxIn: number, pyIn: number): void {
    findSnap(pxIn, pyIn);
    const sx = snap >= 0 ? (snX[snap] as number) : pxIn;
    const sy = snap >= 0 ? (snY[snap] as number) : pyIn;
    readout.clear();
    if (spec.readout === undefined || !spec.readout(sx, sy, readout)) {
      readout.clear();
      const k = 0.25 / u;
      readout.str('X ');
      readout.fixed((sx - G.A.x) * k, 2);
      readout.str('   Y ');
      readout.fixed((G.A.y + G.A.h - sy) * k, 2);
    }
    const A = G.A;
    const cx = Math.round(sx) + 0.5;
    const cy = Math.round(sy) + 0.5;
    const g = 7 * u;
    x.save();
    clipCard(x);
    x.globalAlpha = crossA * 0.55;
    x.strokeStyle = COL.dim;
    x.lineWidth = 0.75;
    x.beginPath();
    x.moveTo(A.x, cy);
    x.lineTo(cx - g, cy);
    x.moveTo(cx + g, cy);
    x.lineTo(A.x + A.w, cy);
    x.moveTo(cx, A.y);
    x.lineTo(cx, cy - g);
    x.moveTo(cx, cy + g);
    x.lineTo(cx, A.y + A.h);
    x.stroke();
    x.globalAlpha = crossA;
    x.lineWidth = 1;
    x.strokeRect(cx - 3.5 * u, cy - 3.5 * u, 7 * u, 7 * u);
    x.fillStyle = COL.dim;
    const b = G.b;
    const tk = 4 * u;
    x.beginPath();
    x.moveTo(cx, b + tk);
    x.lineTo(cx - tk * 0.7, b);
    x.lineTo(cx + tk * 0.7, b);
    x.moveTo(b + tk, cy);
    x.lineTo(b, cy - tk * 0.7);
    x.lineTo(b, cy + tk * 0.7);
    x.fill();
    if (snap >= 0) {
      x.strokeStyle = COL.red;
      x.lineWidth = 1.4;
      x.beginPath();
      if (snT[snap]) {
        x.moveTo(cx + 6 * u, cy);
        x.arc(cx, cy, 6 * u, 0, TAU);
      } else x.rect(cx - 5.5 * u, cy - 5.5 * u, 11 * u, 11 * u);
      x.stroke();
    }
    const snapLab = snap >= 0 ? (snLab[snap] as string) : '';
    const n2 = snapLab.length > 0 ? snapLab.length : readout.nb;
    const tw = Math.max(textW(readout.na, rh), textW(n2, rh)) + 12;
    const bh = n2 > 0 ? fs * 2 + 14 : fs + 10;
    let bx = 0;
    let by = 0;
    let placed = false;
    for (let q = 0; q < 4 && !placed; q++) {
      const dx = DIR_X[q] as number;
      const dy = DIR_Y[q] as number;
      bx = dx > 0 ? cx + 14 : cx - 14 - tw;
      by = dy > 0 ? cy + 14 : cy - 14 - bh;
      if (bx < 2 || by < 2 || bx + tw > W - 2 || by + bh > H - 2) continue;
      if (bx < card.x + card.w + 6 && bx + tw > card.x - 6 && by < card.y + card.h + 6 && by + bh > card.y - 6) continue;
      placed = true;
    }
    if (placed) {
      x.fillStyle = boxFill;
      x.fillRect(bx, by, tw, bh);
      x.strokeStyle = COL.dim;
      x.lineWidth = 0.8;
      x.strokeRect(bx + 0.5, by + 0.5, tw - 1, bh - 1);
      x.lineCap = 'round';
      x.lineJoin = 'round';
      x.lineWidth = 1;
      x.strokeStyle = COL.ink;
      x.beginPath();
      strokeCodes(x, readout.a, readout.na, bx + 6, by + 5 + rh, rh);
      x.stroke();
      if (n2 > 0) {
        x.strokeStyle = COL.red;
        x.beginPath();
        if (snapLab.length > 0) strokeString(x, snapLab, bx + 6, by + fs + 9 + rh, rh);
        else strokeCodes(x, readout.b, readout.nb, bx + 6, by + fs + 9 + rh, rh);
        x.stroke();
      }
    }
    x.restore();
    x.globalAlpha = 1;
  }

  function drawPen(x: Ctx2D, a: number): void {
    const lift = penDown ? 0 : 1;
    x.globalAlpha = a;
    x.fillStyle = penShadow;
    x.beginPath();
    x.arc(penX + (2 + lift * 2.5) * u, penY + (3 + lift * 3.5) * u, 6 * u, 0, TAU);
    x.fill();
    x.fillStyle = penBody;
    x.strokeStyle = COL.ink2;
    x.lineWidth = 1;
    x.beginPath();
    x.arc(penX - lift * u, penY - lift * 1.5 * u, (4.6 + lift * 0.6) * u, 0, TAU);
    x.fill();
    x.stroke();
    x.fillStyle = COL.ink;
    x.beginPath();
    x.arc(penX - lift * u, penY - lift * 1.5 * u, (penDown ? 1.5 : 1) * u, 0, TAU);
    x.fill();
    x.globalAlpha = a * 0.5;
    x.strokeStyle = penGuide;
    x.lineWidth = 0.6;
    x.beginPath();
    const gx = Math.round(penX) + 0.5;
    x.moveTo(gx - 6 * u, G.b);
    x.lineTo(gx - 6 * u, H - G.b);
    x.moveTo(gx + 6 * u, G.b);
    x.lineTo(gx + 6 * u, H - G.b);
    x.stroke();
    x.globalAlpha = 1;
  }

  /** The revision number in the title block, once the sheet is done (red after a cloud). */
  function drawRev(x: Ctx2D): void {
    const c = cells.revno;
    if (c === undefined || V < total * 0.98) return;
    const h = Math.min(G.th * 1.4, c.h * 0.42);
    x.strokeStyle = revCount ? COL.red : COL.ink;
    x.lineWidth = 1.05 * kk;
    x.lineCap = 'round';
    x.lineJoin = 'round';
    x.beginPath();
    const un = h / 6;
    const adv = 5.4 * un;
    const nd = digitCount(revCount);
    let p = 1;
    for (let i = 1; i < nd; i++) p *= 10;
    let v = revCount;
    for (let i = 0; i < nd; i++) {
      const dgt = Math.floor(v / p);
      v -= dgt * p;
      p /= 10;
      const g = glyphs.get(48 + (dgt % 10));
      if (g !== undefined) glyphPath(x, g, i * adv, -6 * un, un, c.x + c.pad, c.y + c.h - c.pad, 1, 0);
    }
    x.stroke();
  }

  const api: SheetApi = { G, note, inCard, fresh };

  return {
    draw(ctx, frame: FrameInput) {
      const t = frame.t;
      const target = motion ? Math.min(Math.max(t, 0), total) : total;
      if (target < V) resetInk();
      if (target > V || (target === 0 && V === 0)) advance(target);
      ctx.save();
      ctx.globalAlpha = 1;
      bakeNotes(t);
      ctx.drawImage(bg.canvas, 0, 0, W, H);
      ctx.drawImage(ink.canvas, 0, 0, W, H);
      drawNotes(ctx, t);
      drawClouds(ctx, t);
      drawRev(ctx);
      if (motion) {
        const fadeIn = clamp(t / 0.5, 0, 1);
        const pa = V < total ? fadeIn : fadeIn * clamp(1 - (t - total) / 0.8, 0, 1);
        if (pa > 0.01 && nStrokes > 0) drawPen(ctx, pa);
        const p = frame.pointer;
        const want = p.strength > 0 && !inCard(p.x, p.y, 2) ? p.strength : 0;
        crossA += (want - crossA) * Math.min(1, frame.dt * 8);
        if (want > crossA && frame.dt === 0) crossA = want;
        if (crossA > 0.01) drawCross(ctx, p.x, p.y);
      }
      ctx.restore();
    },
    tap(x, y, t) {
      if (inCard(x, y, 0) || x <= G.b || y <= G.b || x >= W - G.b || y >= H - G.b) return;
      if (spec.tap !== undefined && spec.tap(x, y, t, api)) return;
      stamp(x, y, t);
    },
    hot: [
      advance,
      pathPart,
      setPen,
      resetInk,
      bakeNotes,
      drawNotes,
      drawClouds,
      drawSlot,
      drawCross,
      drawPen,
      drawRev,
      findSnap,
      strokeCodes,
      strokeString,
      glyphPath,
      inCard,
      note,
      fresh,
      stamp,
      slotText,
      slotDigits,
      slotCircle,
      slotLine,
      slotReset,
      slotClose,
      slotBegin,
      slotPt,
      slotGlyph,
      digitCount,
      ...READOUT_HOT,
      inPoly,
      inRings,
      segDist,
      distToLine,
      ...(spec.hot ?? []),
    ],
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* Map-sheet helpers (county-survey and river-basins; star-chart uses some)                       */
/* ---------------------------------------------------------------------------------------------- */

/** NC State Plane (EPSG:32119 without the false easting): Lambert conformal conic on GRS80. */
export const LC = (() => {
  const a = 6378137;
  const f = 1 / 298.257222101;
  const e2 = f * (2 - f);
  const e = Math.sqrt(e2);
  const r = Math.PI / 180;
  const p1 = (36 + 10 / 60) * r;
  const p2 = (34 + 20 / 60) * r;
  const p0 = (33 + 45 / 60) * r;
  const l0 = -79 * r;
  const m = (p: number) => Math.cos(p) / Math.sqrt(1 - e2 * Math.sin(p) * Math.sin(p));
  const t = (p: number) => {
    const s = Math.sin(p);
    return Math.tan(Math.PI / 4 - p / 2) / Math.pow((1 - e * s) / (1 + e * s), e / 2);
  };
  const n = (Math.log(m(p1)) - Math.log(m(p2))) / (Math.log(t(p1)) - Math.log(t(p2)));
  const F = m(p1) / (n * Math.pow(t(p1), n));
  const R0 = a * F * Math.pow(t(p0), n);
  function invInto(x: number, y: number, out: Float64Array): void {
    const rr = Math.hypot(x, R0 - y);
    const th = Math.atan2(x, R0 - y);
    const tt = Math.pow(rr / (a * F), 1 / n);
    let p = Math.PI / 2 - 2 * Math.atan(tt);
    for (let i = 0; i < 6; i++) {
      const s = Math.sin(p);
      p = Math.PI / 2 - 2 * Math.atan(tt * Math.pow((1 - e * s) / (1 + e * s), e / 2));
    }
    out[0] = (th / n + l0) / r;
    out[1] = p / r;
  }
  return {
    fwd(lon: number, lat: number): [number, number] {
      const rr = a * F * Math.pow(t(lat * r), n);
      const th = n * (lon * r - l0);
      return [rr * Math.sin(th), R0 - rr * Math.cos(th)];
    },
    inv(x: number, y: number): [number, number] {
      const o = new Float64Array(2);
      invInto(x, y, o);
      return [o[0] as number, o[1] as number];
    },
    invInto,
    k(lat: number): number {
      const p = lat * r;
      return (n * a * F * Math.pow(t(p), n)) / (a * m(p));
    },
    conv(lon: number): number {
      return n * (lon * r - l0);
    },
  };
})();

export interface RegionPick {
  key: RegionKey;
  nl: Rect;
  k: number;
  score: number;
  sec: Rect | null;
}

/**
 * Chooses the region beside the card that shows a `bw` x `bh` subject largest: the neatline, the scale,
 * and the free region on the opposite side for ornaments. Null when no band can hold it (the subject is
 * then left out rather than drawn under the card).
 */
export function pickRegion(G: SheetGeom, bw0: number, bh0: number, look: SheetLook): RegionPick | null {
  const u = G.u;
  const lab = 15 * u;
  const pad = (G.wide ? 10 : 5) * u;
  const RG = G.regions;
  let best: RegionPick | null = null;
  const bw = Math.max(1e-9, bw0);
  const bh = Math.max(1e-9, bh0);
  for (const key of ['L', 'R', 'T', 'B'] as const) {
    const R = RG[key];
    if (R.w < 90 || R.h - 2 * lab < 40) continue;
    const nl = { x: R.x + lab, y: R.y + lab, w: R.w - 2 * lab, h: R.h - 2 * lab };
    const k = Math.min((nl.w - 2 * pad) / bw, (nl.h - 2 * pad) / bh);
    const score = k * (1 + ((key === 'L' || key === 'T') === look.prefer < 0.5 ? 0.04 : 0));
    if (!best || score > best.score) best = { key, nl, k, score, sec: null };
  }
  if (!best) return null;
  const opp = ({ L: 'R', R: 'L', T: 'B', B: 'T' } as const)[best.key];
  const R2 = RG[opp];
  best.sec = R2.w > 110 * u && R2.h > 90 * u ? { x: R2.x + 14 * u, y: R2.y + 14 * u, w: R2.w - 28 * u, h: R2.h - 28 * u } : null;
  return best;
}

/** A map on the sheet: data units (O = origin in metres, U = metres per unit) to screen, and back. */
export interface SheetMap {
  key: RegionKey;
  nl: Rect;
  k: number;
  cx: number;
  cy: number;
  mx: number;
  my: number;
  O: readonly [number, number];
  U: number;
  readonly SX: (vx: number) => number;
  readonly SY: (vy: number) => number;
  readonly scr: (a: ArrayLike<number>) => number[];
  readonly inNL: (x: number, y: number) => boolean;
  readonly offCard: (x: number, y: number) => boolean;
  readonly toLL: (x: number, y: number) => [number, number];
  /** Allocation-free `toLL`: writes [lon, lat] into `out`. */
  readonly toLLInto: (x: number, y: number, out: Float64Array) => void;
  readonly fromLL: (lon: number, lat: number) => [number, number];
  gamma: number;
  groundPerPx: number;
  ratio: number;
  sec: Rect | null;
}

/** Fits a data-unit bbox into the roomiest region beside the card. */
export function makeMap(G: SheetGeom, bb: readonly [number, number, number, number], look: SheetLook, O: readonly [number, number], U: number): SheetMap | null {
  const u = G.u;
  const best = pickRegion(G, bb[2] - bb[0], bb[3] - bb[1], look);
  if (!best) return null;
  const nl = best.nl;
  const k = best.k;
  const cx = (bb[0] + bb[2]) / 2;
  const cy = (bb[1] + bb[3]) / 2;
  const mx = nl.x + nl.w / 2;
  const my = nl.y + nl.h / 2;
  const card = G.card;
  const mid = LC.inv(O[0] + cx * U, O[1] + cy * U);
  const gamma = LC.conv(mid[0]);
  const groundPerPx = U / k / LC.k(mid[1]);
  const rf = groundPerPx / 0.00026458;
  const mag = Math.pow(10, Math.floor(Math.log10(rf)) - 1);
  return {
    key: best.key,
    nl,
    k,
    cx,
    cy,
    mx,
    my,
    O,
    U,
    SX: (vx) => mx + (vx - cx) * k,
    SY: (vy) => my - (vy - cy) * k,
    scr(a) {
      const o = new Array<number>(a.length);
      for (let i = 0; i < a.length; i += 2) {
        o[i] = mx + ((a[i] as number) - cx) * k;
        o[i + 1] = my - ((a[i + 1] as number) - cy) * k;
      }
      return o;
    },
    inNL(x, y) {
      return x >= nl.x && x <= nl.x + nl.w && y >= nl.y && y <= nl.y + nl.h;
    },
    offCard(x, y) {
      return !(x > card.x - 4 * u && x < card.x + card.w + 4 * u && y > card.y - 4 * u && y < card.y + card.h + 4 * u);
    },
    toLL: (x, y) => LC.inv(O[0] + (cx + (x - mx) / k) * U, O[1] + (cy - (y - my) / k) * U),
    toLLInto(x, y, out) {
      LC.invInto(O[0] + (cx + (x - mx) / k) * U, O[1] + (cy - (y - my) / k) * U, out);
    },
    fromLL(lon, lat) {
      const p = LC.fwd(lon, lat);
      return [mx + ((p[0] - O[0]) / U - cx) * k, my - ((p[1] - O[1]) / U - cy) * k];
    },
    gamma,
    groundPerPx,
    ratio: Math.round(rf / mag) * mag,
    sec: best.sec,
  };
}

/** A double neatline and a lat/long graticule with degree labels outside the frame. */
export function drawGraticule(P: Plot, M: SheetMap, look: SheetLook, th: number, u: number): void {
  const nl = M.nl;
  const inNL = (x: number, y: number) => M.inNL(x, y);
  P.rect(nl.x - 3 * u, nl.y - 3 * u, nl.w + 6 * u, nl.h + 6 * u, 'T');
  P.rect(nl.x, nl.y, nl.w, nl.h, 'M');
  const cs = (
    [
      [nl.x, nl.y],
      [nl.x + nl.w, nl.y],
      [nl.x, nl.y + nl.h],
      [nl.x + nl.w, nl.y + nl.h],
    ] as const
  ).map(([x, y]) => M.toLL(x, y));
  const lo0 = Math.min(...cs.map((c) => c[0]));
  const lo1 = Math.max(...cs.map((c) => c[0]));
  const la0 = Math.min(...cs.map((c) => c[1]));
  const la1 = Math.max(...cs.map((c) => c[1]));
  const span = Math.max(lo1 - lo0, (la1 - la0) * 1.25);
  const steps = [5, 10, 15, 20, 30, 60, 120].map((m) => m / 60);
  let gs = steps[steps.length - 1] as number;
  for (const s of steps) {
    if (span / s <= 5.5 * (look.gratF || 1)) {
      gs = s;
      break;
    }
  }
  const gl: { p: number[]; lon?: number; lat?: number }[] = [];
  for (let lon = Math.ceil(lo0 / gs) * gs; lon < lo1; lon += gs) {
    const p: number[] = [];
    for (let i = 0; i <= 40; i++) {
      const q = M.fromLL(lon, la0 - 0.05 + ((la1 - la0 + 0.1) * i) / 40);
      p.push(q[0], q[1]);
    }
    gl.push({ p, lon });
  }
  for (let lat = Math.ceil(la0 / gs) * gs; lat < la1; lat += gs) {
    const p: number[] = [];
    for (let i = 0; i <= 60; i++) {
      const q = M.fromLL(lo0 - 0.05 + ((lo1 - lo0 + 0.1) * i) / 60, lat);
      p.push(q[0], q[1]);
    }
    gl.push({ p, lat });
  }
  const lh = th * 0.66;
  const fmt = (v0: number, pos: string, neg: string) => {
    const s = v0 < 0 ? neg : pos;
    const v = Math.abs(v0) + 1e-9;
    const d = Math.floor(v);
    const m = Math.round((v - d) * 60);
    return d + '°' + (m ? String(m).padStart(2, '0') + "'" : '') + s;
  };
  for (const g of gl) {
    for (const r of runsOf(g.p, inNL, 0)) {
      P.add(r, 'C');
      for (const [x, y] of [
        [r[0] as number, r[1] as number],
        [r[r.length - 2] as number, r[r.length - 1] as number],
      ] as const) {
        const onL = Math.abs(x - nl.x) < 1;
        const onR = Math.abs(x - nl.x - nl.w) < 1;
        const onT = Math.abs(y - nl.y) < 1;
        const onB = Math.abs(y - nl.y - nl.h) < 1;
        const txt = g.lon !== undefined ? fmt(g.lon, 'E', 'W') : fmt(g.lat as number, 'N', 'S');
        if (g.lon !== undefined && (onT || onB)) {
          P.line(x, y, x, y + (onT ? -3 : 3) * u, 'T');
          P.text(txt, x, onT ? y - 5 * u : y + 5 * u + lh, lh, 'c', 0, 'X');
        }
        if (g.lat !== undefined && (onL || onR)) {
          P.line(x, y, x + (onL ? -3 : 3) * u, y, 'T');
          P.text(txt, onL ? x - 5 * u : x + 5 * u, y, lh, 'c', onL ? -Math.PI / 2 : Math.PI / 2, 'X', 'b');
        }
      }
    }
  }
}

/** Where labels may go: a software raster of everything already drawn inside the neatline. */
export interface Clutter {
  /** Rasterizes a polyline `w` wide (seen by `at` after the next `read`). */
  line(p: ArrayLike<number>, w: number): void;
  disc(x: number, y: number, r: number): void;
  /** Takes what has been drawn so far as the reference `at` and `box` read. */
  read(): void;
  at(x: number, y: number): number;
  /** Marks a rectangle taken, at once. */
  mark(x0: number, y0: number, x1: number, y1: number): void;
  /** How cluttered a (rotated) box is: 0 clear, more for drawn pixels; 3 per sample off the map or on the card. */
  box(x: number, y: number, w: number, h: number, a: number): number;
  markRot(x: number, y: number, w: number, h: number, a: number): void;
}

/**
 * The lab drew into a canvas and read its alpha back (above 40 of 255 counted as taken). This is the
 * same idea computed in software: a pixel is taken when a stroke covers about a sixth of it, which is
 * when its centre is within half the width plus 0.34 px of the line.
 */
export function makeClutter(M: { nl: Rect; inNL(x: number, y: number): boolean; offCard(x: number, y: number): boolean }): Clutter {
  const nl = M.nl;
  const mW = Math.max(1, Math.ceil(nl.w));
  const mH = Math.max(1, Math.ceil(nl.h));
  const drawn = new Uint8Array(mW * mH);
  const ref = new Uint8Array(mW * mH);
  const segment = (ax: number, ay: number, bx: number, by: number, r: number) => {
    const i0 = Math.max(0, Math.floor(Math.min(ax, bx) - r - nl.x));
    const i1 = Math.min(mW - 1, Math.ceil(Math.max(ax, bx) + r - nl.x));
    const j0 = Math.max(0, Math.floor(Math.min(ay, by) - r - nl.y));
    const j1 = Math.min(mH - 1, Math.ceil(Math.max(ay, by) + r - nl.y));
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const r2 = r * r;
    for (let j = j0; j <= j1; j++) {
      const py = nl.y + j + 0.5;
      for (let i = i0; i <= i1; i++) {
        const px = nl.x + i + 0.5;
        const t = l2 > 0 ? clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1) : 0;
        const ex = ax + dx * t - px;
        const ey = ay + dy * t - py;
        if (ex * ex + ey * ey <= r2) drawn[j * mW + i] = 1;
      }
    }
  };
  const at = (x: number, y: number) => {
    const i = Math.floor(x - nl.x);
    const j = Math.floor(y - nl.y);
    if (i < 0 || j < 0 || i >= mW || j >= mH) return 1;
    return ref[j * mW + i] as number;
  };
  const C: Clutter = {
    line(p, w) {
      const r = w / 2 + 0.34;
      for (let i = 2; i < p.length; i += 2) segment(p[i - 2] as number, p[i - 1] as number, p[i] as number, p[i + 1] as number, r);
    },
    disc(x, y, r) {
      segment(x, y, x, y, r + 0.34);
    },
    read() {
      ref.set(drawn);
    },
    at,
    mark(x0, y0, x1, y1) {
      const i0 = Math.max(0, Math.floor(x0 - nl.x));
      const i1 = Math.min(mW - 1, Math.ceil(x1 - nl.x));
      const j0 = Math.max(0, Math.floor(y0 - nl.y));
      const j1 = Math.min(mH - 1, Math.ceil(y1 - nl.y));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          drawn[j * mW + i] = 1;
          ref[j * mW + i] = 1;
        }
      }
    },
    box(x, y, w, h, a) {
      const ca = Math.cos(a || 0);
      const sa = Math.sin(a || 0);
      let n = 0;
      let hit = 0;
      for (let ty = -h / 2; ty <= h / 2 + 0.01; ty += Math.max(1.5, h / 4)) {
        for (let tx = -w / 2; tx <= w / 2 + 0.01; tx += 2) {
          n++;
          const qx = x + tx * ca - ty * sa;
          const qy = y + tx * sa + ty * ca;
          if (!M.offCard(qx, qy) || !M.inNL(qx, qy)) hit += 3;
          else hit += at(qx, qy);
        }
      }
      return hit / Math.max(1, n);
    },
    markRot(x, y, w, h, a) {
      const ca = Math.abs(Math.cos(a || 0));
      const sa = Math.abs(Math.sin(a || 0));
      const hw = (w * ca + h * sa) / 2;
      const hh = (w * sa + h * ca) / 2;
      C.mark(x - hw, y - hh, x + hw, y + hh);
    },
  };
  return C;
}

/**
 * Fills rings (even-odd, sampled at pixel centres) into a mask over the neatline: `set(index)` for each
 * covered pixel. The lab filled them on a canvas and read the colours back.
 */
export function fillRings(nl: Rect, rings: readonly ArrayLike<number>[], set: (index: number) => void): void {
  const mW = Math.max(1, Math.ceil(nl.w));
  const mH = Math.max(1, Math.ceil(nl.h));
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const r of rings) {
    for (let i = 1; i < r.length; i += 2) {
      if ((r[i] as number) < y0) y0 = r[i] as number;
      if ((r[i] as number) > y1) y1 = r[i] as number;
    }
  }
  const j0 = Math.max(0, Math.floor(y0 - nl.y - 0.5));
  const j1 = Math.min(mH - 1, Math.ceil(y1 - nl.y));
  const xs: number[] = [];
  for (let j = j0; j <= j1; j++) {
    const y = nl.y + j + 0.5;
    xs.length = 0;
    for (const r of rings) {
      const n = r.length / 2;
      for (let i = 0, k = n - 1; i < n; k = i++) {
        const ay = r[2 * k + 1] as number;
        const by = r[2 * i + 1] as number;
        if (ay > y !== by > y) {
          const ax = r[2 * k] as number;
          const bx = r[2 * i] as number;
          xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
        }
      }
    }
    xs.sort((a, b) => a - b);
    for (let q = 0; q + 1 < xs.length; q += 2) {
      const i0 = Math.max(0, Math.ceil((xs[q] as number) - nl.x - 0.5));
      const i1 = Math.min(mW - 1, Math.ceil((xs[q + 1] as number) - nl.x - 0.5) - 1);
      for (let i = i0; i <= i1; i++) set(j * mW + i);
    }
  }
}

/** A pixel index in a neatline mask for a screen point, or -1 outside it. */
export function maskIndex(nl: Rect, x: number, y: number): number {
  const mW = Math.max(1, Math.ceil(nl.w));
  const mH = Math.max(1, Math.ceil(nl.h));
  const i = Math.floor(x - nl.x);
  const j = Math.floor(y - nl.y);
  return i < 0 || j < 0 || i >= mW || j >= mH ? -1 : j * mW + i;
}

export interface AlongOptions {
  tol?: number;
  dev?: number;
  chord?: number;
  steps?: number;
}

/** Letters a name along a fairly straight stretch of a polyline, beside it, where the paper is clear. */
export function labelAlong(P: Plot, CL: Clutter, p: ArrayLike<number>, name: string, h: number, cls: Pen, keepFn: Keep | null, u: number, opt: AlongOptions = {}): boolean {
  const tol = opt.tol || 0.04;
  const devMax = (opt.dev || 4) * u;
  const chord = opt.chord || 0.85;
  const steps = opt.steps || 11;
  const nm = name.toUpperCase();
  const w = strW(nm, h) + 4 * u;
  const cum = [0];
  for (let i = 2; i < p.length; i += 2) cum.push((cum[cum.length - 1] as number) + Math.hypot((p[i] as number) - (p[i - 2] as number), (p[i + 1] as number) - (p[i - 1] as number)));
  const tot = cum[cum.length - 1] as number;
  if (tot < w * 1.15) return false;
  for (let st = 0; st < steps; st++) {
    const f = 0.5 + (st % 2 ? 1 : -1) * Math.ceil(st / 2) * (0.9 / steps);
    const s0 = tot * f - w / 2;
    const s1 = s0 + w;
    if (s0 < 0 || s1 > tot) continue;
    let i0 = 0;
    while (i0 < cum.length - 1 && (cum[i0] as number) < s0) i0++;
    let i1 = i0;
    while (i1 < cum.length - 1 && (cum[i1] as number) < s1) i1++;
    const ax = p[2 * i0] as number;
    const ay = p[2 * i0 + 1] as number;
    const bx = p[2 * i1] as number;
    const by = p[2 * i1 + 1] as number;
    const L = Math.hypot(bx - ax, by - ay);
    if (L < w * chord) continue;
    let dev = 0;
    for (let i = i0; i <= i1; i++) dev = Math.max(dev, Math.abs((bx - ax) * ((p[2 * i + 1] as number) - ay) - (by - ay) * ((p[2 * i] as number) - ax)) / L);
    if (dev > devMax) continue;
    let a = Math.atan2(by - ay, bx - ax);
    if (a > Math.PI / 2) a -= Math.PI;
    if (a < -Math.PI / 2) a += Math.PI;
    for (const side of [1, -1]) {
      const off = 3.4 * u + h / 2 + dev * 0.6;
      const nx = Math.sin(a) * side;
      const ny = -Math.cos(a) * side;
      const x = (ax + bx) / 2 + nx * off;
      const y = (ay + by) / 2 + ny * off;
      if (CL.box(x, y, w, h * 1.1, a) > tol) continue;
      let ok = true;
      if (keepFn) for (const t of [-0.5, 0, 0.5]) if (!keepFn(x + Math.cos(a) * w * t, y + Math.sin(a) * w * t)) ok = false;
      if (!ok) continue;
      P.text(nm, x, y, h, 'c', a, cls, 'm');
      CL.markRot(x, y, w, h * 1.1, a);
      return true;
    }
  }
  return false;
}

/** A north arrow pointing to true north (it leans with the projection's convergence). */
export function drawNorth(P: Plot, M: SheetMap, x: number, y: number, s: number, look: SheetLook, th: number, u: number): void {
  const g = M.gamma;
  const ux = -Math.sin(g);
  const uy = -Math.cos(g);
  const vx = -uy;
  const vy = ux;
  const tip = [x + ux * s, y + uy * s] as const;
  const tail = [x - ux * s * 0.55, y - uy * s * 0.55] as const;
  if (look.na === 0) {
    const l = [x - vx * s * 0.32 - ux * s * 0.5, y - vy * s * 0.32 - uy * s * 0.5] as const;
    const r = [x + vx * s * 0.32 - ux * s * 0.5, y + vy * s * 0.32 - uy * s * 0.5] as const;
    P.poly([tip[0], tip[1], r[0], r[1], x, y, l[0], l[1]], 'O', true);
    P.hatch([[tip[0], tip[1], x, y, l[0], l[1]]], g + Math.PI / 4, 1.3 * u, 'H');
    P.circle(x, y, s * 0.62, 'T');
  } else if (look.na === 1) {
    P.circle(x, y, s * 0.72, 'M');
    P.circle(x, y, s * 0.6, 'T');
    for (let q = 0; q < 8; q++) {
      const a = Math.atan2(uy, ux) + (q * Math.PI) / 4;
      const L = q % 2 ? s * 0.55 : s * (q === 0 ? 1.05 : 0.85);
      const w2 = s * 0.12;
      const ax = Math.cos(a);
      const ay = Math.sin(a);
      const bx2 = -ay;
      const by2 = ax;
      const pts = [x + ax * L, y + ay * L, x + bx2 * w2, y + by2 * w2, x, y, x - bx2 * w2, y - by2 * w2, x + ax * L, y + ay * L];
      P.add(pts, q === 0 ? 'O' : 'M');
      if (q % 2 === 0) P.hatch([pts.slice(0, 6)], a + 0.6, 1.2 * u, 'H');
    }
  } else {
    P.line(tail[0], tail[1], tip[0], tip[1], 'O');
    P.add([tip[0] - vx * s * 0.2 - ux * s * 0.32, tip[1] - vy * s * 0.2 - uy * s * 0.32, tip[0], tip[1], tip[0] + vx * s * 0.2 - ux * s * 0.32, tip[1] + vy * s * 0.2 - uy * s * 0.32], 'O');
    P.line(x - vx * s * 0.25, y - vy * s * 0.25, x + vx * s * 0.25, y + vy * s * 0.25, 'T');
    P.line(x, y, x, y - s * 0.8, 'T');
    P.text('GN', x + 2 * u, y - s * 0.8, th * 0.55, 'l', 0, 'X', 'm');
  }
  P.text('N', tip[0] + ux * th * 1.1, tip[1] + uy * th * 1.1, th * 1.15, 'c', 0, 'K', 'm');
  P.snap(x, y, 1, 'TRUE NORTH ' + (g >= 0 ? '-' : '+') + Math.abs((g * 180) / Math.PI).toFixed(1) + '° FROM GRID NORTH');
}

/** A true scale bar in miles (and kilometres for one of the seeded styles); returns its height. */
export function drawScale(P: Plot, M: SheetMap, x: number, y: number, maxW: number, look: SheetLook, th: number, u: number): number {
  const gpp = M.groundPerPx;
  const mi = 1609.344;
  let L = 1;
  for (const o of [1, 2, 4, 5, 10, 15, 20, 25, 50, 100]) if ((o * mi) / gpp <= maxW) L = o;
  const wpx = (L * mi) / gpp;
  const n = L === 1 ? 4 : L % 4 === 0 ? 4 : L % 5 === 0 ? 5 : L % 2 === 0 ? 4 : 3;
  const h = 3 * u;
  const fh = th * 0.62;
  for (let i = 0; i < n; i++) {
    const x0 = x + (wpx * i) / n;
    const rg = [x0, y - h, x0 + wpx / n, y - h, x0 + wpx / n, y, x0, y];
    P.poly(rg.slice(), 'T', true);
    if (i % 2 === 0) P.hatch([rg], Math.PI / 4, 1.1 * u, 'H');
  }
  P.text('0', x, y - h - 2.4 * u, fh, 'c', 0, 'X');
  P.text(String(L), x + wpx, y - h - 2.4 * u, fh, 'c', 0, 'X');
  P.text('MILES', x + wpx + 4 * u, y - 0.2 * u, fh, 'l', 0, 'X');
  if (look.sb === 0) {
    let K = 1;
    for (const o of [1, 2, 4, 5, 10, 20, 25, 50, 100, 200]) if ((o * 1000) / gpp <= maxW) K = o;
    const wk = (K * 1000) / gpp;
    const y2 = y + 3.5 * u;
    P.line(x, y2, x + wk, y2, 'T');
    for (let i = 0; i <= 4; i++) P.line(x + (wk * i) / 4, y2, x + (wk * i) / 4, y2 + (i % 4 === 0 ? 3 : 1.8) * u, 'T');
    P.text('0', x, y2 + 3 * u + fh * 1.2, fh, 'c', 0, 'X');
    P.text(String(K), x + wk, y2 + 3 * u + fh * 1.2, fh, 'c', 0, 'X');
    P.text('KILOMETRES', x + wk + 4 * u, y2 + 3 * u + fh * 1.2, fh, 'l', 0, 'X');
    return y2 + 3 * u + fh * 1.4 - y + h;
  }
  return h + fh;
}

/** A locator inset: the state outline (data-unit rings) with the subject hatched in. */
export function drawInset(P: Plot, R: Rect, outline: readonly ArrayLike<number>[], others: readonly ArrayLike<number>[], target: readonly ArrayLike<number>[], look: SheetLook, th: number, u: number, label: string): void {
  let ix0 = Infinity;
  let iy0 = Infinity;
  let ix1 = -Infinity;
  let iy1 = -Infinity;
  for (const r of outline) {
    for (let i = 0; i < r.length; i += 2) {
      ix0 = Math.min(ix0, r[i] as number);
      ix1 = Math.max(ix1, r[i] as number);
      iy0 = Math.min(iy0, r[i + 1] as number);
      iy1 = Math.max(iy1, r[i + 1] as number);
    }
  }
  const f = Math.min((R.w - 10 * u) / (ix1 - ix0), (R.h - 18 * u) / (iy1 - iy0));
  const mw = (ix1 - ix0) * f;
  const mh = (iy1 - iy0) * f;
  const ox = R.x + (R.w - mw) / 2;
  const oy = R.y + 5 * u;
  const T = (a: ArrayLike<number>) => {
    const o: number[] = [];
    for (let i = 0; i < a.length; i += 2) o.push(ox + ((a[i] as number) - ix0) * f, oy + (iy1 - (a[i + 1] as number)) * f);
    return o;
  };
  P.rect(R.x, R.y, R.w, mh + 18 * u, 'T');
  for (const r of others) P.add(T(r), 'H');
  for (const r of outline) P.add(T(r), 'M');
  const cr = target.map(T);
  for (const r of cr) P.add(r, 'O');
  P.hatch(cr, (look.hatchA || 0) + 0.8, 0.9 * u, 'M');
  P.text(label, R.x + R.w / 2, oy + mh + 9 * u, th * 0.58, 'c', 0, 'X');
}

export interface Legend {
  w: number;
  h: number;
  draw(x: number, y: number): void;
}

/** Lays out the north arrow, scale bar, an optional legend, and the inset in the free region opposite the map. */
export function placeOrnaments(P: Plot, M: SheetMap, look: SheetLook, th: number, u: number, legend: Legend | null, inset: (R: Rect) => void): void {
  const sec = M.sec;
  const insetH = (w: number) => w * 0.4 + 16 * u;
  if (sec) {
    if (sec.h > sec.w * 1.2) {
      const naS = clamp(sec.w * 0.13, 14 * u, 26 * u);
      const blocks: { h: number; f: (y: number) => void }[] = [];
      blocks.push({ h: naS * 2.7 + th, f: (y) => drawNorth(P, M, sec.x + sec.w / 2, y + naS * 1.15 + th * 1.2, naS, look, th, u) });
      const sbW = Math.min(sec.w - 52 * u, 150 * u);
      const sbH = (look.sb === 0 ? 22 : 10) * u + th;
      blocks.push({ h: sbH, f: (y) => void drawScale(P, M, sec.x + (sec.w - sbW - 30 * u) / 2, y + th * 0.9 + 3 * u, sbW, look, th, u) });
      const iw = sec.w;
      const ih = insetH(iw);
      const room = sec.h - blocks.reduce((a, b) => a + b.h, 0) - ih;
      if (legend && (look.legend || room > legend.h * 2.5) && room > legend.h + 30 * u) blocks.push({ h: legend.h, f: (y) => legend.draw(sec.x + (sec.w - legend.w) / 2, y) });
      blocks.push({ h: ih, f: (y) => inset({ x: sec.x, y, w: iw, h: ih }) });
      const gap = Math.max(8 * u, (sec.h - blocks.reduce((a, b) => a + b.h, 0)) / (blocks.length + 0.5));
      let y = sec.y + gap * 0.5;
      for (const b of blocks) {
        b.f(y);
        y += b.h + gap;
      }
    } else {
      // A wide strip above or below the card: one evenly spaced row.
      const iw = Math.min(sec.w * 0.42, (sec.h - 18 * u) * 2.5 + 10 * u, 250 * u);
      const ih = Math.min(sec.h, insetH(iw));
      const naS = Math.min(16 * u, sec.h * 0.2);
      const sbW = Math.min(110 * u, sec.w * 0.22);
      const sbH = (look.sb === 0 ? 22 : 10) * u + th;
      const blocks: { w: number; h: number; f: (x: number, y: number) => void }[] = [{ w: iw, h: ih, f: (x, y) => inset({ x, y, w: iw, h: ih }) }];
      if (legend && sec.h > legend.h + 10 * u) blocks.push({ w: legend.w, h: legend.h, f: (x, y) => legend.draw(x, y) });
      blocks.push({ w: sbW + 46 * u, h: sbH, f: (x, y) => void drawScale(P, M, x, y + th * 0.9 + 3 * u, sbW, look, th, u) });
      blocks.push({ w: naS * 2.4, h: naS * 2.7 + th, f: (x, y) => drawNorth(P, M, x + naS * 1.2, y + naS * 1.15 + th * 1.2, naS, look, th, u) });
      while (blocks.reduce((a, b) => a + b.w, 0) + (blocks.length - 1) * 12 * u > sec.w && blocks.length > 3) blocks.splice(1, 1);
      const gap = (sec.w - blocks.reduce((a, b) => a + b.w, 0)) / (blocks.length - 1 || 1);
      let x = sec.x;
      for (const b of blocks) {
        b.f(x, sec.y + (sec.h - b.h) / 2);
        x += b.w + gap;
      }
    }
  } else if (M.nl.h >= 150 * u && M.nl.w >= 170 * u) {
    const nl = M.nl;
    drawNorth(P, M, nl.x + nl.w - 18 * u, nl.y + 26 * u, 13 * u, look, th, u);
    drawScale(P, M, nl.x + 10 * u, nl.y + nl.h - 14 * u, Math.min(110 * u, nl.w * 0.4), look, th, u);
  }
}

/** The crescendo in the title cell: a big name over a smaller line or two. */
export function letterTitle(P: Plot, G: SheetGeom, cell: Cell | undefined, name: string, sub: string | readonly string[], th: number, u: number, sheetTxt: string): void {
  if (!cell) return;
  if (G.TB.compact && G.TB.side) {
    // A narrow strip up the side gutter: the name and the sheet, rotated, on one line.
    const T = G.TB;
    const tail = sheetTxt ? '  ·  ' + sheetTxt.toUpperCase() : '';
    const nm = name.toUpperCase();
    const n1 = nm.length + tail.length;
    const h = Math.max(3.5, Math.min(T.w - 3, th * 1.6, (T.h - 16) / Math.max(1, n1 * 0.9 - 0.23)));
    const right = T.side === 'right';
    const x = T.x + T.w / 2;
    const ang = right ? Math.PI / 2 : -Math.PI / 2;
    const y0 = right ? T.y + 8 : T.y + T.h - 8;
    const dir = right ? 1 : -1;
    P.text(nm, x, y0, h, 'l', ang, 'K', 'm');
    if (tail) P.text(tail, x, y0 + dir * nm.length * 0.9 * h, h, 'l', ang, 'M', 'm');
    return;
  }
  const subs = typeof sub === 'string' ? [sub] : sub;
  if (G.TB.compact) {
    // One strip: the name, then the sheet on the same line, then (room permitting) the line under it.
    const p0 = cell.pad;
    const maxW = cell.w - 2 * p0;
    const avH = cell.h - 2 * p0;
    const tail = sheetTxt ? '  ·  ' + sheetTxt.toUpperCase() : '';
    const joined = subs.filter(Boolean).join('  ·  ');
    const two = joined !== '' && avH >= 19;
    const nm = name.toUpperCase();
    const n1 = nm.length + tail.length;
    const h1 = Math.max(4, Math.min(avH * (two ? 0.56 : 0.86), th * 2.2, maxW / Math.max(1, n1 * 0.9 - 0.23)));
    const h2 = two ? Math.min(avH * 0.27, th * 0.95, maxW / Math.max(1, joined.length * 0.9 - 0.23)) : 0;
    const blockH = h1 + (two ? h1 * 0.42 + h2 : 0);
    const y1 = cell.y + p0 + (avH - blockH) / 2 + h1;
    const x0 = cell.x + p0;
    P.text(nm, x0, y1, h1, 'l', 0, 'K');
    if (tail) P.text(tail, x0 + nm.length * 0.9 * h1, y1, h1, 'l', 0, 'M');
    if (two) P.text(joined, x0, y1 + h1 * 0.42 + h2, h2, 'l', 0, 'M');
    return;
  }
  const lab2 = th * 0.62;
  const p0 = cell.pad;
  const top = cell.y + p0 + lab2 + 4 * u;
  const maxW = cell.w - 2 * p0;
  const avH = cell.h - (top - cell.y) - p0;
  const vert = G.TB.vertical;
  const subH = Math.min(th * (vert ? 0.92 : 0.78), avH * 0.2);
  const subF = subs.map((s) => fitText(s, subH, maxW, vert ? 3 : 1));
  const subBlock = subF.reduce((a, f) => a + f.lines.length * f.h * 1.5 + f.h * 0.3, 0);
  const nameF = fitText(name, Math.min(th * 3.4, (avH - subBlock - 4 * u) / (vert ? 2.9 : 1.3)), maxW, vert ? 3 : 1);
  let y = top + nameF.h;
  nameF.lines.forEach((line, i) => {
    if (i) y += nameF.h * 1.38;
    P.text(line, cell.x + p0, y, nameF.h, 'l', 0, 'K');
  });
  y += 2.5 * u;
  for (const f of subF) {
    for (const line of f.lines) {
      y += f.h * 1.5;
      P.text(line, cell.x + p0, y, f.h, 'l', 0, 'M');
    }
    y += f.h * 0.3;
  }
}

/** "SHEET 12 OF 100" in the sheet cell, with a code under it where there's room. */
export function letterSheet(P: Plot, cell: Cell | undefined, sheetTxt: string, code: string, th: number, u: number): void {
  if (!cell) return;
  const lab2 = th * 0.62;
  const p0 = cell.pad;
  const big = Math.min(th * 1.6, (cell.w - 2 * p0) / strW(sheetTxt, 1), (cell.h - lab2 - 3 * p0) * 0.42);
  P.text(sheetTxt, cell.x + p0, cell.y + p0 + lab2 + 4 * u + big, big, 'l', 0, 'K');
  if (code && cell.h > big * 2.4 + lab2 + 3 * p0) P.text(code, cell.x + p0, cell.y + cell.h - p0, th * 0.7, 'l', 0, 'X');
}

/** No band can hold the subject: the sheet still letters its notes and the crescendo. */
export function titleOnly<L extends SheetLook>(B: SheetBuild<L>, name: string, sub: string | readonly string[], sheetTxt: string, code: string, notes: readonly string[]): void {
  const { P, G, th, u, cells, TBK } = B;
  const v0 = P.into(P.views[0] as PlotView);
  v0.dur = 2.2;
  v0.name = 'title block';
  TBK.notes(P, notes);
  TBK.rev(P);
  TBK.put(P, cells.project, B.siteName || 'UNTITLED', th * 1.9, 3, 'l', 'K');
  P.view(3.8, 'title');
  letterTitle(P, G, cells.title, name, sub, th, u, sheetTxt);
  letterSheet(P, cells.sheet, sheetTxt, code, th, u);
}

/** The subject a visit shows: the host's choice if it's a known key, else one picked from the seed. */
export function chooseSubject(sets: Readonly<Record<string, readonly string[]>>, defaultSet: string, subject: string | undefined, subjectSet: string | undefined, rng: Rng): { key: string; index: number; count: number } {
  const setName = subjectSet !== undefined && sets[subjectSet] ? subjectSet : defaultSet;
  const set = sets[setName] as readonly string[];
  if (subject !== undefined) {
    const i = set.indexOf(subject);
    if (i >= 0) return { key: subject, index: i, count: set.length };
    // A key from another set (a constellation outside the curated forty): numbered in its own set.
    for (const other of Object.values(sets)) {
      const j = other.indexOf(subject);
      if (j >= 0) return { key: subject, index: j, count: other.length };
    }
  }
  const i = rng.int(set.length);
  return { key: set[i] as string, index: i, count: set.length };
}
