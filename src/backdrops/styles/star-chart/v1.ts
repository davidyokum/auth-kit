/**
 * star-chart v1. FROZEN once released (ADR 0021): add v2.ts for any change to what it draws.
 *
 * A pen plotter draws a celestial chart plate in the blueprint frame. Order: the sheet frame, a right
 * ascension and declination graticule, and the ecliptic; the faint background stars, brightest first;
 * then one featured constellation plotted star by star (brightest first, each a dot sized by magnitude
 * with its Greek letter); then its stick figure; then a magnitude scale and an all-sky locator; and last,
 * as the crescendo, its name with its meaning: "CYGNUS", "THE SWAN". About 28 to 32 s, then it holds. On a
 * dark page it's an old celestial atlas plate (gold or white ink on deep navy, by seed); on a light page,
 * dark ink on cream.
 *
 * The seed locks the look (paper, ink, pen weight, layout, ornament styles, and plot order); the subject
 * (`setup.subject`, an IAU abbreviation such as `Cyg`) is the host's choice each visit, from the curated
 * forty (the default set) or all 88, else one picked from the seed. Hover for right ascension and
 * declination and the nearest star; tap a star to letter its designation and magnitude; tap elsewhere to
 * stamp a revision cloud. Reduced motion shows the finished plate. Nothing draws under the card.
 *
 * Projection: stereographic, centred on the constellation, right ascension increasing to the left as seen
 * from Earth; equinox J2000. Stars: the Yale Bright Star Catalogue, 5th revised edition (NASA ADC / CDS
 * catalogue V/50). Constellation figures and names: d3-celestial by Olaf Frohn (BSD 3-Clause; the notice
 * is in data.ts and THIRD_PARTY_NOTICES.md). Ported from the Backdrop Lab's star-chart.js (passwords-flow
 * design/backdrop-lab/styles/).
 */
import type { Rng } from '../../kernel/v1/prng.js';
import { createRng, hashParts } from '../../kernel/v1/prng.js';
import { defineVersion, type StyleSetup } from '../define.js';
import {
  addGlyphs,
  baseGlyphs,
  chooseSubject,
  clamp,
  createSheet,
  DEC,
  decNums,
  isDarkPage,
  labelAlong,
  lerp,
  letterSheet,
  letterTitle,
  makeClutter,
  mixHex,
  type PlotView,
  pickRegion,
  type Readout,
  runsOf,
  type SheetApi,
  type SheetBuild,
  type SheetColours,
  type SheetLook,
  strW,
  TAU,
  titleOnly,
} from '../plotter/v1.js';
import { STAR_DATA as D } from './data.js';
import { ALL_CONSTELLATIONS, CURATED_CONSTELLATIONS } from './subjects.js';

const ID = 'star-chart';
const SETS: Readonly<Record<string, readonly string[]>> = { curated: CURATED_CONSTELLATIONS, all: ALL_CONSTELLATIONS };
const R2D = 180 / Math.PI;
const D2R = Math.PI / 180;
const EPS = 23.4393 * D2R;

/* ---------- single-stroke Greek lowercase for Bayer letters (the same 4-wide grid; descenders to 8) ---------- */
const GREEK = 'αβγδεζηθικλμνξοπρστυφχψω';
const GLYPHS = (() => {
  const ell = (cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, n: number) => {
    const o: [number, number][] = [];
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      o.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
    }
    return o;
  };
  const P = (s: string) => s.split(' ').map((p) => p.split(',').map(Number) as [number, number]);
  const table = baseGlyphs();
  addGlyphs(table, {
    α: [P('3.9,2.5 3.2,4.2 2.6,5.4 1.6,6 0.7,5.6 0.4,4.6 0.8,3.3 1.7,2.6 2.6,3 3.2,4.4 3.6,5.6 4.1,6')],
    β: [P('0.6,8 0.6,1.2 1.1,0.4 1.9,0.1 2.7,0.4 3.1,1.3 2.7,2.3 1.6,2.8 2.9,3.3 3.4,4.5 2.9,5.6 1.8,6 0.6,5.4')],
    γ: [P('0.2,2.8 0.9,2.5 1.6,3.5 2.2,5.6 2.2,7.4 1.9,8'), P('3.8,2.5 2.2,5.6')],
    δ: [P('3.2,0.6 2.2,0.1 1.2,0.5 1.4,1.5 2.8,2.7 3.5,4.2 2.9,5.7 1.8,6 0.7,5.5 0.4,4.3 1,3 2.2,2.4')],
    ε: [P('3.4,2.9 2.4,2.5 1.2,2.7 0.9,3.5 1.6,4.1 2.6,4.1'), P('1.6,4.1 0.6,4.6 0.7,5.6 1.8,6 3.3,5.6')],
    ζ: [P('1,0.2 3.4,0.2 1.6,1.8 0.5,3.6 0.6,5.2 1.6,5.9 2.8,6.2 3.2,7 2.6,7.8')],
    η: [P('0.4,2.9 0.8,2.5 1.1,3 1.1,6'), P('1.1,3.4 2,2.6 3,2.6 3.5,3.4 3.5,8')],
    θ: [ell(2, 3.05, 1.55, 2.95, -Math.PI / 2, Math.PI * 1.5, 20), P('0.5,3.1 3.5,3.1')],
    ι: [P('1.6,2.5 1.6,5.4 2.2,6 2.9,5.7')],
    κ: [P('0.8,2.5 0.8,6'), P('3.4,2.5 0.8,4.4'), P('1.7,3.8 3.5,6')],
    λ: [P('0.6,0.2 1.3,0.2 3.6,6'), P('2.1,2.6 0.3,6')],
    μ: [P('0.8,2.5 0.8,8'), P('0.8,4.9 1.3,5.8 2.2,6 3,5.4 3.3,4.2'), P('3.3,2.5 3.3,5.4 3.8,6')],
    ν: [P('0.4,2.6 1.2,2.5 2,6 3.3,4.4 3.7,2.5')],
    ξ: [P('1.2,0.1 3.2,0.1'), P('2.8,0.3 1.4,0.6 1.2,1.7 2.6,2.3 1,2.9 0.7,4.3 1.6,5.5 2.9,6 3.1,6.9 2.5,7.8')],
    ο: [ell(2, 4.25, 1.6, 1.75, -Math.PI / 2, Math.PI * 1.5, 16)],
    π: [P('0.2,2.8 0.9,2.5 3.8,2.5'), P('1.3,2.5 1.1,6'), P('2.9,2.5 2.9,5.6 3.5,6')],
    ρ: [P('0.8,8 0.8,4 1.4,2.8 2.4,2.5 3.3,3.2 3.5,4.4 3,5.6 2,6 0.8,5.4')],
    σ: [P('3.9,2.5 2,2.5 0.8,3 0.4,4.3 1,5.6 2,6 3,5.5 3.3,4.3 2.9,3 2,2.5')],
    τ: [P('0.3,2.9 0.9,2.5 3.8,2.5'), P('2.1,2.5 2,5.4 2.6,6 3.2,5.7')],
    υ: [P('0.4,2.9 0.9,2.5 1.1,3.2 1,4.8 1.6,5.8 2.5,6 3.4,5.2 3.6,3.6 3.2,2.5')],
    φ: [P('2,0.6 2,8'), ell(2, 4.3, 1.7, 1.7, -Math.PI / 2, Math.PI * 1.5, 16)],
    χ: [P('0.3,2.5 0.9,2.6 3.2,7.7 3.8,8'), P('3.7,2.5 0.4,8')],
    ψ: [P('2.1,0.6 2.1,8'), P('0.3,2.6 0.6,4.6 1.3,5.8 2.1,6 2.9,5.8 3.5,4.6 3.8,2.6')],
    ω: [P('1,2.6 0.4,3.6 0.5,5.2 1.1,6 1.8,5.8 2.1,4.4 2.4,5.8 3,6 3.6,5.2 3.7,3.6 3.1,2.6')],
  });
  return table;
})();

/* ---------- the catalogue, decoded once on first use ---------- */
interface Constellation {
  id: string;
  name: string;
  mean: string;
  ra: number;
  de: number;
  polys: string;
  lets: string;
  gen: string;
}
let CAT: { n: number; ra: Float32Array; de: Float32Array; mag: Float32Array; cons: Constellation[] } | null = null;
function catalogue(): NonNullable<typeof CAT> {
  if (CAT) return CAT;
  const s = D.S;
  const n = s.length / 7;
  const ra = new Float32Array(n);
  const de = new Float32Array(n);
  const mag = new Float32Array(n);
  const f = (i: number, k: number) => {
    let v = 0;
    let m = 1;
    for (let j = 0; j < k; j++) {
      v += (DEC[s.charCodeAt(i + j)] as number) * m;
      m *= 90;
    }
    return v;
  };
  for (let i = 0; i < n; i++) {
    const o = i * 7;
    ra[i] = f(o, 3) / 100;
    de[i] = f(o + 3, 3) / 100 - 90;
    mag[i] = (DEC[s.charCodeAt(o + 6)] as number) / 10 - 2;
  }
  const cons = D.C.map((c) => ({ id: c[0], name: c[1], mean: c[2], ra: c[3], de: c[4], polys: c[5], lets: c[6], gen: c[8] }));
  CAT = { n, ra, de, mag, cons };
  return CAT;
}

/** The lab's sky colours: an old atlas plate on a dark page, dark ink on cream on a light one. */
function skyColours(p: StyleSetup['palette'], gold: boolean): SheetColours {
  if (isDarkPage(p)) {
    const paper = mixHex('#0c1734', p.page, 0.25);
    const ink = gold ? '#e4c77f' : '#edf1f8';
    const water = gold ? '#f3dda0' : '#bfd6ff';
    const star = gold ? '#fff4d6' : '#ffffff';
    return { dark: true, paper, ink, ink2: mixHex(ink, paper, 0.14), ink3: mixHex(ink, paper, 0.4), dim: mixHex(ink, paper, 0.12), cons: mixHex(ink, paper, 0.66), hatch: mixHex(ink, paper, 0.55), gridMinor: mixHex(paper, ink, 0.05), gridMajor: mixHex(paper, ink, 0.095), red: '#ff9f80', water, waterPale: mixHex(water, paper, 0.5), star, starPale: mixHex(star, paper, 0.3), tex: 0.1, vig: 0.26 };
  }
  const paper = mixHex(p.page, '#f6ecd2', 0.72);
  const ink = p.ink;
  const water = mixHex(p.primary, ink, 0.25);
  return { dark: false, paper, ink, ink2: mixHex(ink, paper, 0.14), ink3: mixHex(ink, paper, 0.4), dim: mixHex(ink, paper, 0.1), cons: mixHex(p.primary, paper, 0.6), hatch: mixHex(ink, paper, 0.5), gridMinor: mixHex(paper, ink, 0.05), gridMajor: mixHex(paper, ink, 0.1), red: '#b4442a', water, waterPale: mixHex(water, paper, 0.5), star: ink, starPale: mixHex(ink, paper, 0.38), tex: 0.06, vig: 0.08 };
}

interface StarLook extends SheetLook {
  readonly gold: boolean;
  readonly ticks: boolean;
  readonly eclDash: number;
}

function starLook(r: Rng): StarLook {
  const n = () => r.next();
  return { tbLeft: n() < 0.25, gold: n() < 0.6, penW: lerp(0.9, 1.12, n()), gratF: n() < 0.5 ? 1 : 1.4, prefer: n(), legend: true, ticks: n() < 0.5, eclDash: n() < 0.5 ? 0 : 1 };
}

function magText(m: number): string {
  return 'MAG ' + m.toFixed(1);
}

interface VisStar {
  i: number;
  x: number;
  y: number;
  r: number;
  fig: boolean;
  g: number;
  /** The readout's second line and the tap note for this star. */
  read: string;
  note: string;
}
interface Sky {
  nl: { x: number; y: number; w: number; h: number };
  u: number;
  inNL: (x: number, y: number) => boolean;
  invInto: (x: number, y: number, out: Float64Array) => void;
  vis: VisStar[];
}

export const starChartV1 = defineVersion({
  version: 1,
  fps: 30,
  maxPixelRatio: 2,
  stillTime: 40,
  settlesAt: 29,
  colors: (p) => ({ gold: skyColours(p, true), white: skyColours(p, false) }),
  create(setup, colours) {
    const rng = createRng(hashParts(ID, 1, setup.seed));
    const look = starLook(rng.fork('look'));
    const subject = chooseSubject(SETS, 'curated', setup.subject, setup.subjectSet, rng.fork('subject'));
    const cat = catalogue();
    const RA = cat.ra;
    const DE = cat.de;
    const MAG = cat.mag;
    const con = cat.cons.find((c) => c.id === subject.key) as Constellation;
    const plateTxt = 'PLATE ' + (subject.index + 1) + ' OF ' + subject.count;
    const COL = look.gold ? colours.gold : colours.white;
    let SKY: Sky | null = null;
    const radec = new Float64Array(2);
    const hot: unknown[] = [];

    function build(B: SheetBuild<StarLook>): void {
      const { P, G, u, th, cells, TBK } = B;
      const a0 = con.ra * D2R;
      const d0 = con.de * D2R;
      const sd0 = Math.sin(d0);
      const cd0 = Math.cos(d0);
      const proj = (ra: number, de: number): [number, number] | null => {
        const a = ra * D2R - a0;
        const d = de * D2R;
        const cd = Math.cos(d);
        const sd = Math.sin(d);
        const ca = Math.cos(a);
        const cc = sd0 * sd + cd0 * cd * ca;
        if (cc < -0.6) return null;
        const k = 2 / (1 + cc);
        return [-k * cd * Math.sin(a), k * (cd0 * sd - sd0 * cd * ca)];
      };
      const figIdx = new Set<number>();
      const polys = con.polys.split('!').map((s) => decNums(s));
      for (const p of polys) for (const i of p) figIdx.add(i);
      let bx0 = Infinity;
      let by0 = Infinity;
      let bx1 = -Infinity;
      let by1 = -Infinity;
      for (const i of figIdx) {
        const q = proj(RA[i] as number, DE[i] as number);
        if (!q) continue;
        bx0 = Math.min(bx0, q[0]);
        bx1 = Math.max(bx1, q[0]);
        by0 = Math.min(by0, q[1]);
        by1 = Math.max(by1, q[1]);
      }
      const minSpan = 2 * Math.tan((9 * D2R) / 2); // a field of at least about 9 degrees
      let bw = Math.max(bx1 - bx0, minSpan);
      let bh = Math.max(by1 - by0, minSpan * 0.75);
      const mxv = (bx0 + bx1) / 2;
      const myv = (by0 + by1) / 2;
      bw *= 1.32;
      bh *= 1.32;
      const code = 'IAU ' + con.id.toUpperCase() + ' · ' + con.gen.toUpperCase();
      const notes = ['STARS: YALE BRIGHT STAR CATALOGUE, 5TH ED. (NASA ADC / CDS V/50)', 'FIGURES: D3-CELESTIAL © 2015 OLAF FROHN, BSD-3-CLAUSE', 'EPOCH J2000', 'STEREOGRAPHIC, RA INCREASES TO THE LEFT'];
      const R = pickRegion(G, bw, bh, look);
      if (!R) {
        titleOnly(B, con.name.toUpperCase(), con.mean.toUpperCase(), plateTxt, code, notes);
        return;
      }
      const nl = R.nl;
      const k = R.k;
      const cx = nl.x + nl.w / 2;
      const cy = nl.y + nl.h / 2;
      const S2 = (q: [number, number]): [number, number] => [cx + (q[0] - mxv) * k, cy - (q[1] - myv) * k];
      const inNL = (x: number, y: number) => x >= nl.x && x <= nl.x + nl.w && y >= nl.y && y <= nl.y + nl.h;
      const card = G.card;
      const offCard = (x: number, y: number) => !(x > card.x - 4 * u && x < card.x + card.w + 4 * u && y > card.y - 4 * u && y < card.y + card.h + 4 * u);
      function invInto(x: number, y: number, out: Float64Array): void {
        const X = -((x - cx) / k + mxv);
        const Y = -(y - cy) / k + myv;
        const rho = Math.hypot(X, Y);
        if (rho < 1e-9) {
          out[0] = con.ra;
          out[1] = con.de;
          return;
        }
        const c = 2 * Math.atan(rho / 2);
        const sc = Math.sin(c);
        const cc = Math.cos(c);
        const de = Math.asin(cc * sd0 + (Y * sc * cd0) / rho);
        const ra = a0 + Math.atan2(X * sc, rho * cd0 * cc - Y * sd0 * sc);
        out[0] = (((ra * R2D) % 360) + 360) % 360;
        out[1] = de * R2D;
      }
      const inv = (x: number, y: number): [number, number] => {
        const o = new Float64Array(2);
        invInto(x, y, o);
        return [o[0] as number, o[1] as number];
      };
      const CL = makeClutter({ nl, inNL, offCard });
      const vGrat = P.into(P.views[0] as PlotView);
      vGrat.dur = 4.0;
      vGrat.name = 'graticule';
      const vBg = P.view(5.0, 'background stars');
      const vFig = P.view(6.0, 'constellation stars');
      const vLines = P.view(5.0, 'figure');
      const vOrn = P.view(3.6, 'ornaments');
      const vTit = P.view(3.8, 'title');
      // ===== 1. frame, RA/Dec graticule, and the ecliptic
      P.into(vGrat);
      P.rect(nl.x - 3 * u, nl.y - 3 * u, nl.w + 6 * u, nl.h + 6 * u, 'T');
      P.rect(nl.x, nl.y, nl.w, nl.h, 'M');
      const corners = (
        [
          [nl.x, nl.y],
          [nl.x + nl.w, nl.y],
          [nl.x, nl.y + nl.h],
          [nl.x + nl.w, nl.y + nl.h],
          [cx, nl.y],
          [cx, nl.y + nl.h],
          [nl.x, cy],
          [nl.x + nl.w, cy],
        ] as const
      ).map(([x, y]) => inv(x, y));
      const fieldDe = Math.max(...corners.map((c) => Math.abs(c[1] - con.de))) * 2;
      const poleIn = [90, -90].some((pd) => {
        const q = proj(0, pd);
        if (!q) return false;
        const s = S2(q);
        return inNL(s[0], s[1]);
      });
      const deStep = [2.5, 5, 10, 15, 20, 30].find((s) => fieldDe / s <= 6.5 * look.gratF) || 30;
      const raSpan = poleIn ? 360 : Math.min(360, (fieldDe * 1.6) / Math.max(0.15, Math.cos(con.de * D2R)));
      const raStep = [3.75, 7.5, 15, 30, 45, 60, 90].find((s) => raSpan / s <= 7 * look.gratF) || 90;
      const lines: { p: number[]; ra?: number; de?: number }[] = [];
      const raLo = poleIn ? 0 : Math.floor((con.ra - raSpan) / raStep) * raStep;
      const raHi = poleIn ? 360 - raStep / 2 : con.ra + raSpan;
      for (let ra = raLo; ra <= raHi; ra += raStep) {
        const p: number[] = [];
        for (let d = -88; d <= 88; d += 1) {
          const q = proj(ra, d);
          if (q) {
            const s = S2(q);
            p.push(s[0], s[1]);
          } else if (p.length) {
            lines.push({ p: p.slice(), ra });
            p.length = 0;
          }
        }
        if (p.length) lines.push({ p, ra });
      }
      for (let de = -90 + deStep; de < 90; de += deStep) {
        const p: number[] = [];
        for (let r = 0; r <= 360; r += 1.5) {
          const q = proj(r, de);
          if (q) {
            const s = S2(q);
            p.push(s[0], s[1]);
          } else if (p.length >= 4) {
            lines.push({ p: p.slice(), de });
            p.length = 0;
          } else p.length = 0;
        }
        if (p.length >= 4) lines.push({ p, de });
      }
      const lh = th * 0.66;
      const raTxt = (ra0: number) => {
        const ra = ((ra0 % 360) + 360) % 360;
        const h = ra / 15;
        const hh = Math.floor(h + 1e-6);
        const mm = Math.round((h - hh) * 60);
        return hh + 'H' + (mm ? String(mm).padStart(2, '0') + 'M' : '');
      };
      const labSeen = new Set<string>();
      for (const g of lines) {
        for (const r of runsOf(g.p, inNL, 0)) {
          P.add(r, g.de === 0 ? 'T' : 'C');
          for (const [x, y] of [
            [r[0] as number, r[1] as number],
            [r[r.length - 2] as number, r[r.length - 1] as number],
          ] as const) {
            const onL = Math.abs(x - nl.x) < 1;
            const onR = Math.abs(x - nl.x - nl.w) < 1;
            const onT = Math.abs(y - nl.y) < 1;
            const onB = Math.abs(y - nl.y - nl.h) < 1;
            const key = (g.ra !== undefined ? 'r' + g.ra : 'd' + g.de) + (onT ? 't' : onB ? 'b' : onL ? 'l' : 'r');
            if (labSeen.has(key)) continue;
            if (g.ra !== undefined && (onT || onB)) {
              labSeen.add(key);
              P.line(x, y, x, y + (onT ? -3 : 3) * u, 'T');
              P.text(raTxt(g.ra), x, onT ? y - 5 * u : y + 5 * u + lh, lh, 'c', 0, 'X');
            } else if (g.de !== undefined && (onL || onR)) {
              labSeen.add(key);
              P.line(x, y, x + (onL ? -3 : 3) * u, y, 'T');
              P.text((g.de > 0 ? '+' : g.de < 0 ? '-' : '') + Math.abs(g.de) + '°', onL ? x - 5 * u : x + 5 * u, y, lh, 'c', onL ? -Math.PI / 2 : Math.PI / 2, 'X', 'b');
            }
          }
        }
      }
      // The ecliptic where it crosses the field.
      const ecl: number[] = [];
      for (let l = 0; l <= 360; l += 1) {
        const L = l * D2R;
        const de = Math.asin(Math.sin(EPS) * Math.sin(L)) * R2D;
        const ra = Math.atan2(Math.sin(L) * Math.cos(EPS), Math.cos(L)) * R2D;
        const q = proj(ra, de);
        if (q) {
          const s = S2(q);
          ecl.push(s[0], s[1]);
        } else ecl.push(NaN, NaN);
      }
      const eclRuns: number[][] = [];
      {
        let cur: number[] = [];
        for (let i = 0; i < ecl.length; i += 2) {
          const x = ecl[i] as number;
          const y = ecl[i + 1] as number;
          if (x !== x || !inNL(x, y)) {
            if (cur.length >= 4) eclRuns.push(cur);
            cur = [];
          } else cur.push(x, y);
        }
        if (cur.length >= 4) eclRuns.push(cur);
      }
      for (const r of eclRuns) {
        P.dash(r, look.eclDash ? [8 * u, 3 * u] : [10 * u, 2.5 * u, 1.5 * u, 2.5 * u], 'T');
        CL.line(r, 2);
      }
      // ===== star positions in the field
      const vis: VisStar[] = [];
      for (let i = 0; i < cat.n; i++) {
        const fig = figIdx.has(i);
        const m = MAG[i] as number;
        if (!fig && m > 5.5) continue;
        const q = proj(RA[i] as number, DE[i] as number);
        if (!q) continue;
        const s = S2(q);
        if (!inNL(s[0], s[1]) || !offCard(s[0], s[1])) continue;
        const r = fig ? clamp((6.1 - m) * 0.78 * u, 0.9 * u, 7.5 * u) : clamp((5.9 - m) * 0.55 * u, 0.55, 4.4 * u);
        vis.push({ i, x: s[0], y: s[1], r, fig, g: 0, read: magText(m), note: magText(m) });
      }
      // Greek letters belong to this constellation's stars.
      const lets = decNums(con.lets);
      const letOf = new Map<number, number>();
      for (let q = 0; q + 1 < lets.length; q += 2) letOf.set(lets[q] as number, lets[q + 1] as number);
      for (const s of vis) {
        const g = letOf.get(s.i);
        if (g) {
          s.g = g;
          const ch = GREEK[g - 1] as string;
          s.read = ch + ' ' + con.id.toUpperCase() + '  ' + magText(MAG[s.i] as number);
          s.note = ch + ' ' + con.id.toUpperCase() + ' · ' + magText(MAG[s.i] as number);
        }
      }
      const byIdx = new Map(vis.map((s) => [s.i, s]));
      // Stick figure segments, stopping short of the stars.
      const segs: number[][] = [];
      for (const p of polys) {
        for (let q = 1; q < p.length; q++) {
          const A = byIdx.get(p[q - 1] as number);
          const Bs = byIdx.get(p[q] as number);
          if (!A || !Bs) continue;
          const dx = Bs.x - A.x;
          const dy = Bs.y - A.y;
          const L = Math.hypot(dx, dy);
          const ga = A.r + 2.4 * u;
          const gb = Bs.r + 2.4 * u;
          if (L < ga + gb + 2) continue;
          segs.push([A.x + (dx / L) * ga, A.y + (dy / L) * ga, Bs.x - (dx / L) * gb, Bs.y - (dy / L) * gb]);
        }
      }
      for (const s of segs) CL.line(s, 2.5);
      for (const s of vis) CL.disc(s.x, s.y, s.r + 1.2 * u);
      CL.read();
      SKY = { nl, u, inNL, invInto, vis };
      hot.push(inNL, invInto);
      const dot = (s: { x: number; y: number; r: number }, cls: 'z' | 'Z') => {
        if (s.r < 1.15) {
          P.circle(s.x, s.y, Math.max(0.45, s.r), cls);
          return;
        }
        const o: number[] = [];
        const turns = s.r / (0.62 * clamp(u, 0.8, 1.2));
        const n = Math.ceil(turns * 16);
        for (let q = 0; q <= n; q++) {
          const t = q / n;
          const a = t * turns * TAU;
          const rr = s.r * (1 - t);
          o.push(s.x + Math.cos(a) * rr, s.y + Math.sin(a) * rr);
        }
        P.circle(s.x, s.y, s.r, cls);
        P.add(o, cls);
      };
      const byMag = (a: VisStar, b: VisStar) => (MAG[a.i] as number) - (MAG[b.i] as number);
      // ===== 2. background stars, brightest first
      P.into(vBg);
      for (const s of vis.filter((q) => !q.fig).sort(byMag)) dot(s, 'z');
      // ===== 3. the constellation, star by star, brightest first, each with its Greek letter
      P.into(vFig);
      const lh2 = th * 1.05;
      for (const s of vis.filter((q) => q.fig).sort(byMag)) {
        dot(s, 'Z');
        if (s.r > 3.2 * u) P.circle(s.x, s.y, s.r + 1.6 * u, 'T');
        P.snap(s.x, s.y, 1, (s.g ? (GREEK[s.g - 1] as string) + ' ' : '') + con.gen.toUpperCase() + ' · ' + magText(MAG[s.i] as number));
        if (!s.g) continue;
        const ch = GREEK[s.g - 1] as string;
        const w = strW(ch, lh2) + 2;
        const d = s.r + 2.6 * u + lh2 * 0.45;
        let best: { x: number; y: number; c: number } | null = null;
        for (let q = 0; q < 8; q++) {
          const a = -Math.PI / 4 + (q * Math.PI) / 4;
          const x = s.x + Math.cos(a) * d;
          const y = s.y + Math.sin(a) * d * 0.9;
          const c = CL.box(x, y, w, lh2 * 1.2, 0);
          if (!best || c < best.c) best = { x, y, c };
          if (c === 0) break;
        }
        if (best && best.c < 0.35) {
          P.text(ch, best.x, best.y + lh2 * 0.05, lh2, 'c', 0, 'X', 'm');
          CL.mark(best.x - w / 2, best.y - lh2 * 0.6, best.x + w / 2, best.y + lh2 * 0.7);
        }
      }
      // ===== 4. the stick figure
      P.into(vLines);
      for (const s of segs) P.add(s, 'W');
      // Label the ecliptic where the paper is clear.
      P.into(vGrat);
      for (const r of eclRuns) if (labelAlong(P, CL, r, 'ECLIPTIC', th * 0.62, 'X', inNL, u, { tol: 0.03, dev: 3, steps: 15 })) break;
      // ===== 5. magnitude scale, all-sky locator, and the title block's fixed entries
      P.into(vOrn);
      const sec = R.sec;
      const magScale = (x: number, y: number, w: number) => {
        const step = Math.min(w / 6, 18 * u);
        P.text('MAGNITUDES', x, y, th * 0.62, 'l', 0, 'X');
        [0, 1, 2, 3, 4, 5].forEach((m, q) => {
          const r = clamp((6.1 - m) * 0.78 * u, 0.9 * u, 7.5 * u);
          const s = { x: x + step * (q + 0.5), y: y + 8 * u + 7.5 * u, r };
          dot(s, 'Z');
          P.text(String(m), s.x, s.y + 7.5 * u + th * 0.9, th * 0.6, 'c', 0, 'X');
        });
        return 8 * u + 15 * u + th * 1.5;
      };
      const skyInset = (Rr: { x: number; y: number; w: number; h: number }) => {
        const w = Rr.w;
        const h = Math.min(Rr.h - 14 * u, w * 0.5);
        const x0 = Rr.x;
        const y0 = Rr.y;
        const X = (ra: number) => x0 + w * (1 - (((ra % 360) + 360) % 360) / 360);
        const Y = (de: number) => y0 + h * (0.5 - de / 180);
        P.rect(x0, y0, w, h, 'M');
        for (let ra = 90; ra < 360; ra += 90) P.line(X(ra), y0, X(ra), y0 + h, 'C');
        for (const de of [-60, -30, 0, 30, 60]) P.line(x0, Y(de), x0 + w, Y(de), de === 0 ? 'T' : 'C');
        const e: number[] = [];
        for (let l = 0; l <= 360; l += 4) {
          const L = l * D2R;
          const de = Math.asin(Math.sin(EPS) * Math.sin(L)) * R2D;
          const ra = (Math.atan2(Math.sin(L) * Math.cos(EPS), Math.cos(L)) * R2D + 360) % 360;
          if (e.length && Math.abs(X(ra) - (e[e.length - 2] as number)) > w / 2) {
            P.dash(e.slice(), [3 * u, 1.6 * u], 'T');
            e.length = 0;
          }
          e.push(X(ra), Y(de));
        }
        if (e.length >= 4) P.dash(e, [3 * u, 1.6 * u], 'T');
        for (const i of figIdx) {
          const x = X(RA[i] as number);
          const y = Y(DE[i] as number);
          if ((MAG[i] as number) < 3.5) P.circle(x, y, 0.8 * u, 'K');
        }
        const bx = X(con.ra);
        const by = Y(con.de);
        const bb = Math.max(7 * u, w * 0.04);
        P.rect(bx - bb, by - bb * 0.8, bb * 2, bb * 1.6, 'R');
        P.text('24H', x0, y0 + h + 6 * u, th * 0.55, 'l', 0, 'X');
        P.text('12H', x0 + w / 2, y0 + h + 6 * u, th * 0.55, 'c', 0, 'X');
        P.text('0H', x0 + w, y0 + h + 6 * u, th * 0.55, 'r', 0, 'X');
        P.text('THE WHOLE SKY', x0 + w / 2, y0 - 3 * u, th * 0.6, 'c', 0, 'X');
      };
      if (sec) {
        if (sec.h > sec.w * 1.2) {
          const iw = sec.w;
          const ih = iw * 0.5 + 14 * u;
          const msH = 8 * u + 15 * u + th * 1.5;
          const bright = vis
            .filter((q) => q.fig && q.g)
            .sort(byMag)
            .slice(0, 6);
          const rowH = th * 1.55;
          const tbH = bright.length ? th * 1.4 + bright.length * rowH : 0;
          const gap = (sec.h - ih - msH - tbH - 10 * u) / 4;
          const tw = Math.min(sec.w, 108 * u);
          const tx = sec.x + (sec.w - tw) / 2;
          magScale(tx, sec.y + gap, tw);
          if (bright.length) {
            let y = sec.y + gap * 2 + msH;
            P.text('BRIGHTEST STARS', tx, y, th * 0.62, 'l', 0, 'X');
            P.line(tx, y + th * 0.45, tx + tw, y + th * 0.45, 'T');
            y += th * 1.4;
            for (const b of bright) {
              y += rowH;
              P.text(GREEK[b.g - 1] as string, tx + 2 * u, y - rowH * 0.25, th * 0.95, 'l', 0, 'K', 'm');
              P.text(magText(MAG[b.i] as number), tx + tw, y - rowH * 0.25, th * 0.7, 'r', 0, 'X', 'm');
              P.dash([tx + 10 * u, y - rowH * 0.25, tx + tw - strW('MAG 0.0', th * 0.7) - 4 * u, y - rowH * 0.25], [1 * u, 2.2 * u], 'C');
            }
          }
          skyInset({ x: sec.x, y: sec.y + gap * 3 + msH + tbH + 10 * u, w: iw, h: ih });
        } else {
          const iw = Math.min(sec.w * 0.5, (sec.h - 24 * u) * 2, 240 * u);
          skyInset({ x: sec.x, y: sec.y + 10 * u, w: iw, h: sec.h - 10 * u });
          const mw = Math.min(sec.w - iw - 24 * u, 108 * u);
          if (mw > 60 * u) magScale(sec.x + iw + 18 * u + (sec.w - iw - 18 * u - mw) / 2, sec.y + (sec.h - 23 * u - th * 1.5) / 2, mw);
        }
      }
      const fieldW = Math.round(4 * Math.atan(nl.w / (4 * k)) * R2D);
      const fieldH = Math.round(4 * Math.atan(nl.h / (4 * k)) * R2D);
      TBK.notes(P, notes);
      TBK.rev(P);
      TBK.put(P, cells.project, B.siteName || 'UNTITLED', th * 1.9, 3, 'l', 'K');
      TBK.put(P, cells.scale, 'FIELD ' + fieldW + '° × ' + fieldH + '°', th * 1.0, 1, 'l', 'M');
      // ===== 6. crescendo
      P.into(vTit);
      letterTitle(P, G, cells.title, con.name.toUpperCase(), con.mean.toUpperCase(), th, u, plateTxt);
      letterSheet(P, cells.sheet, plateTxt, code, th, u);
    }

    /** Right ascension as 20H 41M 26S. */
    function raInto(out: Readout, ra0: number): void {
      const ra = ((ra0 % 360) + 360) % 360;
      const h = ra / 15;
      let hh = Math.floor(h);
      let mm = Math.floor((h - hh) * 60);
      let ss = Math.round(((h - hh) * 60 - mm) * 60);
      if (ss === 60) {
        ss = 0;
        mm++;
      }
      if (mm === 60) {
        mm = 0;
        hh = (hh + 1) % 24;
      }
      out.int(hh, 1);
      out.str('H ');
      out.int(mm, 2);
      out.str('M ');
      out.int(ss, 2);
      out.code(83);
    }

    /** Declination as +45°16'49". */
    function deInto(out: Readout, de0: number): void {
      out.code(de0 < 0 ? 45 : 43);
      const de = Math.abs(de0);
      let d = Math.floor(de);
      let m = Math.floor((de - d) * 60);
      let q = Math.round(((de - d) * 60 - m) * 60);
      if (q === 60) {
        q = 0;
        m++;
      }
      if (m === 60) {
        m = 0;
        d++;
      }
      out.int(d, 1);
      out.code(176);
      out.int(m, 2);
      out.code(39);
      out.int(q, 2);
      out.code(34);
    }

    function readout(x: number, y: number, out: Readout): boolean {
      const sky = SKY;
      if (sky === null || !sky.inNL(x, y)) return false;
      sky.invInto(x, y, radec);
      out.str('RA ');
      raInto(out, radec[0] as number);
      out.str('   DEC ');
      deInto(out, radec[1] as number);
      out.next();
      let bd = 9 * sky.u;
      let best = -1;
      for (let i = 0; i < sky.vis.length; i++) {
        const s = sky.vis[i] as VisStar;
        const d = Math.hypot(s.x - x, s.y - y);
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      if (best >= 0) out.str((sky.vis[best] as VisStar).read);
      return true;
    }

    function tap(x: number, y: number, t: number, api: SheetApi): boolean {
      const sky = SKY;
      if (sky === null || !sky.inNL(x, y)) return false;
      let bd = 8 * api.G.u;
      let best = -1;
      for (let i = 0; i < sky.vis.length; i++) {
        const s = sky.vis[i] as VisStar;
        const d = Math.hypot(s.x - x, s.y - y);
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      if (best < 0) return false;
      const hit = sky.vis[best] as VisStar;
      if (!api.fresh(hit.i, 0, 0)) return true;
      return api.note(sky.nl, hit.x, hit.y, hit.note, t);
    }

    hot.push(readout, tap, raInto, deInto);
    return createSheet(setup, rng, COL, { id: ID, labels: { title: 'CONSTELLATION', sheet: 'PLATE' }, look, glyphs: GLYPHS, maxSeconds: 28, build, readout, tap, hot });
  },
});
