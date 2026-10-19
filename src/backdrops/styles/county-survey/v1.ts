/**
 * county-survey v1. FROZEN once released (ADR 0021): add v2.ts for any change to what it draws.
 *
 * A pen plotter surveys one of North Carolina's 100 counties on a blueprint sheet, building up in order:
 * the sheet frame and a faint lat/long graticule; neighbouring counties as pale dashed outlines; the
 * county's real outline in one steady stroke; its major lakes and rivers; the interstates and US highways
 * that cross it, as double lines with lettered shields; contours in mountain counties (from a 1 km USGS
 * elevation grid) or a stippled water edge along sound and ocean shorelines; a star for the county seat;
 * a north arrow (true north, so it leans with the projection's convergence), a true scale bar, and an NC
 * locator inset; and last, as the crescendo, the title block: the county's name, the year it was formed,
 * and its seat, then "Sheet N of 100". About 28 to 34 s, then it holds.
 *
 * The seed locks the look (paper, ink, pen weight, layout, ornament styles, and plot order); the subject
 * (`setup.subject`, a county's name) is the host's choice each visit, else one picked from the seed. Hover
 * for a crosshair with live latitude and longitude and the county or lake under it; tap a lake or river
 * to letter its name; tap elsewhere to stamp a revision cloud. Reduced motion shows the finished sheet.
 * Nothing is drawn under the card.
 *
 * Ported from the Backdrop Lab's county-survey.js (passwords-flow design/backdrop-lab/styles/). Data and
 * its sources: data.ts (Census, TIGER/Line, USGS 3DEP and GNIS, NCpedia; lakes and rivers © OpenStreetMap
 * contributors, ODbL 1.0).
 */
import type { Rng } from '../../kernel/v1/prng.js';
import { createRng, hashParts } from '../../kernel/v1/prng.js';
import { defineVersion } from '../define.js';
import {
  distToLine,
  baseGlyphs,
  chaikin,
  chooseSubject,
  clamp,
  createSheet,
  DEC,
  decLine,
  drawGraticule,
  drawInset,
  fillRings,
  inRings,
  isolines,
  labelAlong,
  lerp,
  letterSheet,
  letterTitle,
  makeClutter,
  makeMap,
  maskIndex,
  offsetLine,
  Plot,
  placeOrnaments,
  polyLen,
  type Readout,
  ringArea,
  runsOf,
  type SheetApi,
  type SheetBuild,
  sheetColours,
  type SheetLook,
  type SheetMap,
  strW,
  thousands,
  titleOnly,
} from '../plotter/v1.js';
import { COUNTY_DATA as D, type CountyInfo } from './data.js';
import { COUNTY_KEYS } from './subjects.js';

const ID = 'county-survey';
const SETS: Readonly<Record<string, readonly string[]>> = { all: COUNTY_KEYS };
const GLYPHS = baseGlyphs();
const STNAME: Readonly<Record<string, string>> = { VA: 'VIRGINIA', SC: 'SOUTH CAROLINA', TN: 'TENNESSEE', GA: 'GEORGIA' };
const CHAR_N = 78;
const CHAR_S = 83;
const CHAR_E = 69;
const CHAR_W = 87;

/* ---------- lazily decoded geometry (only what the county on show needs) ---------- */
let ARCS: string[] | null = null;
let ARCUSE: Uint8Array | null = null;
const arcCache = new Map<number, Float64Array>();
let ROADS: string[] | null = null;
let RIVERS: string[] | null = null;
let LAKES: string[] | null = null;
let DEMV: Float32Array | null = null;

function arcStrings(): string[] {
  ARCS ??= D.A.split(' ');
  return ARCS;
}
function arc(i: number): Float64Array {
  let a = arcCache.get(i);
  if (!a) {
    a = decLine(arcStrings()[i] as string);
    arcCache.set(i, a);
  }
  return a;
}
/** How many county rings use each arc (1: a state or shore edge). */
function arcUse(): Uint8Array {
  if (ARCUSE) return ARCUSE;
  const use = new Uint8Array(arcStrings().length);
  for (const c of D.C) for (const part of c[2]) for (const r of part) for (const a of r) use[a >= 0 ? a : ~a] = (use[a >= 0 ? a : ~a] as number) + 1;
  ARCUSE = use;
  return use;
}
function ringOf(ids: readonly number[]): Float64Array {
  let n = 0;
  const segs = ids.map((i) => {
    const a = arc(i >= 0 ? i : ~i);
    n += a.length / 2;
    return [a, i < 0] as const;
  });
  const o = new Float64Array(n * 2);
  let k = 0;
  segs.forEach(([a, rev], si) => {
    const m = a.length / 2;
    for (let j = si ? 1 : 0; j < m; j++) {
      const q = rev ? m - 1 - j : j;
      o[k++] = a[2 * q] as number;
      o[k++] = a[2 * q + 1] as number;
    }
  });
  return o.subarray(0, k);
}
function countyRings(ci: number): Float64Array[] {
  const out: Float64Array[] = [];
  for (const part of (D.C[ci] as (typeof D.C)[number])[2]) for (const r of part) out.push(ringOf(r));
  return out;
}
function road(i: number): Float64Array {
  ROADS ??= D.R.split(' ');
  return decLine(ROADS[i] as string);
}
function river(i: number): Float64Array {
  RIVERS ??= D.V.split(' ');
  return decLine(RIVERS[i] as string);
}
function lake(i: number): Float64Array[] {
  LAKES ??= D.L.split(' ');
  return (LAKES[i] as string).split('!').map(decLine);
}
/** The elevation grid in metres (NaN: no data). */
function dem(): Float32Array {
  if (DEMV) return DEMV;
  const g = D.DEM;
  const n = g.nx * g.ny;
  const v = new Float32Array(n);
  const s = g.d;
  let k = 0;
  for (let i = 0; i < s.length && k < n; i++) {
    const c = s.charCodeAt(i);
    if (c === 33) continue;
    if (c === 32) {
      const run = (DEC[s.charCodeAt(++i)] as number) + 1;
      for (let j = 0; j < run && k < n; j++) v[k++] = NaN;
    } else v[k++] = g.lo + (DEC[c] as number) * g.st;
  }
  DEMV = v;
  return v;
}
function countyLabel(ci: number): string {
  const c = D.C[ci] as (typeof D.C)[number];
  return c[1] === 'NC' ? c[0].toUpperCase() : (c[4] ?? c[0]).toUpperCase().replace(/ COUNTY$/, ' CO.');
}
function countyIndex(name: string): number {
  return D.C.findIndex((c) => c[1] === 'NC' && c[0] === name);
}

/* ---------- interstate and US-route shields in a unit box (x right, y down, centre 0,0, height 2) ---------- */
const SHIELD_I = (() => {
  const o: number[] = [];
  const top = (x: number) => -0.78 - 0.16 * Math.sin(Math.PI * (x + 1));
  for (let i = 0; i <= 10; i++) {
    const x = -1 + i / 5;
    o.push(x * 0.95, top(x));
  }
  for (let i = 0; i <= 14; i++) {
    const a = i / 14;
    o.push(0.95 - 0.95 * Math.pow(a, 1.6), -0.6 + 1.6 * Math.sin((a * Math.PI) / 2));
  }
  for (let i = 14; i >= 0; i--) {
    const a = i / 14;
    o.push(-(0.95 - 0.95 * Math.pow(a, 1.6)), -0.6 + 1.6 * Math.sin((a * Math.PI) / 2));
  }
  o.push(o[0] as number, o[1] as number);
  return o;
})();
const SHIELD_U = (() => {
  const o = [-0.62, -1, 0.62, -1];
  o.push(0.72, -0.86, 0.9, -0.82, 0.86, -0.4);
  for (let i = 0; i <= 12; i++) {
    const a = ((i / 12) * Math.PI) / 2;
    o.push(0.86 * Math.cos(a), -0.4 + 1.38 * Math.sin(a));
  }
  for (let i = 12; i >= 0; i--) {
    const a = ((i / 12) * Math.PI) / 2;
    o.push(-0.86 * Math.cos(a), -0.4 + 1.38 * Math.sin(a));
  }
  o.push(-0.86, -0.4, -0.9, -0.82, -0.72, -0.86, -0.62, -1);
  return o;
})();

interface CountyLook extends SheetLook {
  readonly na: number;
  readonly sb: number;
  readonly nbDash: number;
  readonly hatchA: number;
  readonly stip: number;
}

function countyLook(r: Rng): CountyLook {
  const n = () => r.next();
  return { tbLeft: n() < 0.25, na: Math.floor(n() * 3), sb: Math.floor(n() * 2), nbDash: n() < 0.6 ? 0 : 1, penW: lerp(0.9, 1.15, n()), hatchA: lerp(-0.9, 0.9, n()), stip: lerp(0.8, 1.25, n()), gratF: n() < 0.5 ? 1 : 1.5, legend: n() < 0.75, prefer: n() };
}

interface TapLake {
  li: number;
  rings: number[][];
  upper: string;
}
interface TapRiver {
  key: number;
  p: number[];
  upper: string;
}
interface CountyMap {
  M: SheetMap;
  ci: number;
  nbAt(x: number, y: number): number;
  inLake(x: number, y: number): boolean;
  lakeName(x: number, y: number): string;
  /** The readout's name for a county, by its index in the data. */
  labels: string[];
  lakes: TapLake[];
  rivers: TapRiver[];
}

export const countySurveyV1 = defineVersion({
  version: 1,
  fps: 30,
  maxPixelRatio: 2,
  stillTime: 40,
  settlesAt: 35,
  colors: (p) => sheetColours(p),
  create(setup, COL) {
    const rng = createRng(hashParts(ID, 1, setup.seed));
    const look = countyLook(rng.fork('look'));
    const subject = chooseSubject(SETS, 'all', setup.subject, setup.subjectSet, rng.fork('subject'));
    const ci = countyIndex(subject.key);
    const sheetTxt = 'SHEET ' + (subject.index + 1) + ' OF ' + subject.count;
    let MAP: CountyMap | null = null;
    const ll = new Float64Array(2);
    const hot: unknown[] = [];

    function build(B: SheetBuild<CountyLook>): void {
      const { P, G, u, th, cells, TBK } = B;
      const info = D.I[String(ci)] as CountyInfo;
      const C = D.C[ci] as (typeof D.C)[number];
      const rings = countyRings(ci);
      let bx0 = Infinity;
      let by0 = Infinity;
      let bx1 = -Infinity;
      let by1 = -Infinity;
      for (const r of rings) {
        for (let i = 0; i < r.length; i += 2) {
          const x = r[i] as number;
          const y = r[i + 1] as number;
          if (x < bx0) bx0 = x;
          if (x > bx1) bx1 = x;
          if (y < by0) by0 = y;
          if (y > by1) by1 = y;
        }
      }
      const titleName = C[0].toUpperCase() + ' COUNTY';
      const titleSub = (info.f ? 'FORMED ' + info.f + ' · ' : '') + 'SEAT: ' + info.s.toUpperCase();
      const baseNotes = ['WATER FEATURES © OPENSTREETMAP CONTRIBUTORS', 'BOUNDARIES: U.S. CENSUS BUREAU', 'ROADS: CENSUS TIGER/LINE'];
      const M = makeMap(G, [bx0, by0, bx1, by1], look, [D.O[0] as number, D.O[1] as number], D.U);
      if (!M) {
        titleOnly(B, titleName, titleSub, sheetTxt, 'FIPS ' + C[3], baseNotes);
        return;
      }
      const nl = M.nl;
      const k = M.k;
      const SX = M.SX;
      const SY = M.SY;
      const scr = (a: ArrayLike<number>) => M.scr(a);
      const inNL = (x: number, y: number) => M.inNL(x, y);
      const offCard = (x: number, y: number) => M.offCard(x, y);
      const sRings = rings.map(scr);
      // ---- masks over the neatline: this county, the neighbour under each pixel, and lakes
      const nbr = info.nb.filter((j) => j !== ci);
      const mW = Math.max(1, Math.ceil(nl.w));
      const mH = Math.max(1, Math.ceil(nl.h));
      const nbq = new Int16Array(mW * mH).fill(-1);
      const cty = new Uint8Array(mW * mH);
      const lk = new Uint8Array(mW * mH);
      nbr.forEach((j, q) =>
        fillRings(nl, countyRings(j).map(scr), (i) => {
          nbq[i] = q;
        }),
      );
      fillRings(nl, sRings, (i) => {
        cty[i] = 1;
        nbq[i] = -1;
      });
      const lakeS = info.lk.map((li) => ({ li, rings: lake(li).map(scr), name: D.LN[li] as string }));
      for (const L of lakeS) {
        fillRings(nl, L.rings, (i) => {
          lk[i] = 1;
        });
      }
      function inC(x: number, y: number): boolean {
        const o = maskIndex(nl, x, y);
        return o >= 0 && cty[o] === 1;
      }
      function onLand(x: number, y: number): boolean {
        const o = maskIndex(nl, x, y);
        return o >= 0 && (cty[o] === 1 || (nbq[o] as number) >= 0);
      }
      function inLake(x: number, y: number): boolean {
        const o = maskIndex(nl, x, y);
        return o >= 0 && lk[o] === 1;
      }
      function nbAt(x: number, y: number): number {
        const o = maskIndex(nl, x, y);
        if (o < 0) return -1;
        if (cty[o] === 1) return ci;
        const q = nbq[o] as number;
        return q >= 0 ? (nbr[q] as number) : -1;
      }
      const lakeUpper = lakeS.map((L) => ({ li: L.li, rings: L.rings, upper: L.name.toUpperCase() }));
      function lakeName(x: number, y: number): string {
        for (let i = 0; i < lakeUpper.length; i++) {
          const L = lakeUpper[i] as TapLake;
          if (inRings(x, y, L.rings)) return L.upper;
        }
        return '';
      }
      const labels: string[] = [];
      labels[ci] = C[0].toUpperCase() + ' COUNTY';
      for (const j of nbr) {
        const cj = D.C[j] as (typeof D.C)[number];
        labels[j] = cj[1] === 'NC' ? countyLabel(j) + ' COUNTY' : countyLabel(j) + ', ' + cj[1];
      }
      const map: CountyMap = { M, ci, nbAt, inLake, lakeName, labels, lakes: [], rivers: [] };
      MAP = map;
      hot.push(maskIndex, nbAt, inLake, lakeName, M.inNL, M.toLLInto);
      const CL = makeClutter(M);

      // Views in plot order; later phases drop strokes back into the right one.
      const vGrat = P.into(P.views[0] as (typeof P.views)[number]);
      vGrat.dur = 3.2;
      vGrat.name = 'graticule';
      const vNb = P.view(3.2, 'neighbours');
      const vOut = P.view(4.2, 'outline');
      const vWat = P.view(4.2, 'water');
      const vRd = P.view(4.2, 'roads');
      const vTer = P.view(5.2, 'terrain');
      const vSeat = P.view(1.6, 'seat');
      const vOrn = P.view(4.4, 'ornaments');
      const vTit = P.view(3.8, 'title');

      // ===== 1. frame and graticule
      P.into(vGrat);
      drawGraticule(P, M, look, th, u);
      // ===== 2. neighbouring counties, pale and dashed, with their names at the deepest visible point
      P.into(vNb);
      const own = new Set<number>();
      for (const part of C[2]) for (const r of part) for (const a of r) own.add(a >= 0 ? a : ~a);
      const seen = new Set<number>();
      const dpat = look.nbDash ? [7 * u, 2.2 * u, 1.2 * u, 2.2 * u] : [4.2 * u, 2.6 * u];
      for (const j of nbr) {
        for (const part of (D.C[j] as (typeof D.C)[number])[2]) {
          for (const r of part) {
            for (const a0 of r) {
              const a = a0 >= 0 ? a0 : ~a0;
              if (own.has(a) || seen.has(a)) continue;
              seen.add(a);
              for (const run of runsOf(scr(arc(a)), inNL, 4 * u)) {
                P.dash(run, dpat, 'P');
                CL.line(run, 1.5);
              }
            }
          }
        }
      }
      {
        const st = 3;
        const gw = Math.ceil(mW / st);
        const gh = Math.ceil(mH / st);
        const id = new Int16Array(gw * gh);
        const dist = new Float32Array(gw * gh);
        for (let j = 0; j < gh; j++) {
          for (let i = 0; i < gw; i++) {
            const x = nl.x + i * st + 1;
            const y = nl.y + j * st + 1;
            id[j * gw + i] = offCard(x, y) ? nbAt(x, y) : -2;
          }
        }
        for (let j = 0; j < gh; j++) {
          for (let i = 0; i < gw; i++) {
            const q = j * gw + i;
            const v = id[q];
            if (i === 0 || j === 0 || i === gw - 1 || j === gh - 1 || id[q - 1] !== v || id[q - gw] !== v) {
              dist[q] = 0;
              continue;
            }
            dist[q] = Math.min((dist[q - 1] as number) + 1, (dist[q - gw] as number) + 1, (dist[q - gw - 1] as number) + 1.4, (dist[q - gw + 1] as number) + 1.4);
          }
        }
        for (let j = gh - 2; j > 0; j--) {
          for (let i = gw - 2; i > 0; i--) {
            const q = j * gw + i;
            const v = id[q];
            if (id[q + 1] !== v || id[q + gw] !== v) dist[q] = 0;
            else dist[q] = Math.min(dist[q] as number, (dist[q + 1] as number) + 1, (dist[q + gw] as number) + 1, (dist[q + gw + 1] as number) + 1.4, (dist[q + gw - 1] as number) + 1.4);
          }
        }
        const bestP = new Map<number, [number, number]>();
        for (let q = 0; q < id.length; q++) {
          const v = id[q] as number;
          if (v < 0 || v === ci) continue;
          const cur = bestP.get(v);
          if (!cur || (dist[q] as number) > cur[0]) bestP.set(v, [dist[q] as number, q]);
        }
        const nh = th * 0.72;
        for (const j of [...bestP.keys()].sort((a, b) => a - b)) {
          const [d, q] = bestP.get(j) as [number, number];
          const x = nl.x + (q % gw) * st + 1;
          const y = nl.y + Math.floor(q / gw) * st + 1;
          const st2 = (D.C[j] as (typeof D.C)[number])[1];
          const lines = st2 === 'NC' ? [countyLabel(j)] : [countyLabel(j), STNAME[st2] ?? st2];
          const w = Math.max(...lines.map((s) => strW(s, nh)));
          if (d * st < Math.max(w / 2, nh * 1.6) * 0.75) continue;
          lines.forEach((s, li) => P.text(s, x, y + (li - (lines.length - 1) / 2) * nh * 1.7, nh, 'c', 0, 'P', 'm'));
          CL.mark(x - w / 2, y - nh * lines.length, x + w / 2, y + nh * lines.length);
        }
      }
      // ===== 3. the outline in one steady stroke
      P.into(vOut);
      for (const [, i] of sRings.map((r, i) => [Math.abs(ringArea(r)), i] as const).sort((a, b) => b[0] - a[0])) {
        P.add(sRings[i], 'O');
        CL.line(sRings[i] as number[], 3);
      }
      // ===== 4. lakes and rivers (linework now, names later)
      P.into(vWat);
      let bigLake: { L: (typeof lakeS)[number]; a: number } | null = null;
      for (const L of lakeS) {
        for (const r of L.rings) {
          for (const run of runsOf(r, inC, 3 * u)) {
            P.add(run, 'W');
            CL.line(run, 2);
          }
          for (const run of runsOf(r, (x, y) => !inC(x, y) && inNL(x, y), 3 * u)) {
            P.add(run, 'w');
            CL.line(run, 1.5);
          }
        }
        const tmp = new Plot(u, GLYPHS);
        tmp.hatch(L.rings, 0, 3.4 * u, 'w');
        let inside = 0;
        for (const s of (tmp.views[0] as (typeof tmp.views)[number]).s) {
          for (const run of runsOf(s.p, inC, 2 * u)) {
            P.add(run, 'w');
            inside += polyLen(run);
          }
        }
        map.lakes.push({ li: L.li, rings: L.rings, upper: L.name.toUpperCase() });
        if (!bigLake || inside > bigLake.a) bigLake = { L, a: inside };
      }
      const rivS: { p: number[]; name: string; len: number }[] = [];
      for (const ri of info.rv) {
        const p = scr(river(ri));
        const ni = D.VN[ri] as number;
        const nm = D.VNames[ni] as string;
        for (const run of runsOf(p, inC, 3 * u)) {
          P.add(run, 'W');
          CL.line(run, 3);
          rivS.push({ p: run, name: nm, len: polyLen(run) });
        }
        for (const run of runsOf(p, (x, y) => !inC(x, y) && inNL(x, y), 3 * u)) {
          P.add(run, 'w');
          CL.line(run, 1.5);
        }
        map.rivers.push({ key: 1000 + ni, p, upper: nm.toUpperCase() });
      }
      // ---- roads: runs per route, drawn later with gaps under the shields
      const roadRuns: { sm: number[]; tag: string; isI: boolean; out?: boolean }[] = [];
      const routes = new Map<string, { runs: number[][]; isI: boolean; L: number }>();
      for (const ri of info.rd) {
        const p = scr(road(ri));
        const tag = D.RM[ri] as string;
        const isI = tag[0] === 'I';
        for (const run of runsOf(p, inC, 2.5 * u)) {
          const sm = chaikin(run);
          roadRuns.push({ sm, tag, isI });
          let rt = routes.get(tag);
          if (!rt) {
            rt = { runs: [], isI, L: 0 };
            routes.set(tag, rt);
          }
          rt.runs.push(sm);
          rt.L += polyLen(run);
        }
        for (const run of runsOf(p, (x, y) => !inC(x, y) && inNL(x, y), 3 * u)) roadRuns.push({ sm: run, tag, isI, out: true });
      }
      const sx = SX(info.sx);
      const sy = SY(info.sy);
      const sr = 5.2 * u;
      CL.disc(sx, sy, sr * 1.7);
      CL.read();

      // ===== labels, phase 1: the seat's name and the shields (roads not yet in the clutter)
      const seatName = info.s.toUpperCase();
      const seatH = th * 1.0;
      const seatW = strW(seatName, seatH);
      let seatLab: { c: number; xl: number; yc: number } | null = null;
      {
        const d = sr * 2.0;
        const cand: [number, number, 'l' | 'r' | 'c'][] = [
          [d, 0, 'l'],
          [-d, 0, 'r'],
          [d * 0.8, -d * 0.9, 'l'],
          [-d * 0.8, -d * 0.9, 'r'],
          [d * 0.8, d * 0.9, 'l'],
          [-d * 0.8, d * 0.9, 'r'],
          [0, -d * 1.1, 'c'],
          [0, d * 1.1, 'c'],
        ];
        let bestS: { c: number; xl: number; yc: number } | null = null;
        for (const [dx, dy, al] of cand) {
          const xl = al === 'l' ? sx + dx : al === 'r' ? sx + dx - seatW : sx - seatW / 2;
          const xc = xl + seatW / 2;
          const yc = sy + dy;
          let rc = 0;
          for (const rr of roadRuns) {
            if (rr.out) continue;
            const p = rr.sm;
            for (let i = 0; i < p.length; i += 2) {
              if (Math.abs((p[i] as number) - xc) < seatW / 2 + 2 && Math.abs((p[i + 1] as number) - yc) < seatH * 0.7) {
                rc++;
                break;
              }
            }
          }
          const c = CL.box(xc, yc, seatW + 4, seatH * 1.3, 0) + rc * 0.08;
          if (!bestS || c < bestS.c) bestS = { c, xl, yc };
          if (c < 0.01) break;
        }
        if (bestS && bestS.c < 0.6) {
          seatLab = bestS;
          CL.mark(bestS.xl - 2, bestS.yc - seatH * 0.65, bestS.xl + seatW + 2, bestS.yc + seatH * 0.65);
        }
      }
      const shields: { x: number; y: number; s: number; tag: string; isI: boolean }[] = [];
      const distToRuns = (x: number, y: number, skip: string) => {
        let d = Infinity;
        for (const rr of roadRuns) {
          if (rr.tag === skip || rr.out) continue;
          const p = rr.sm;
          for (let i = 0; i < p.length; i += 2) {
            const q = Math.hypot((p[i] as number) - x, (p[i + 1] as number) - y);
            if (q < d) d = q;
          }
        }
        return d;
      };
      const routeTags = [...routes.keys()].sort((a, b) => (a[0] === b[0] ? (routes.get(b) as { L: number }).L - (routes.get(a) as { L: number }).L : a[0] === 'I' ? -1 : 1)).slice(0, 8);
      for (const tag of routeTags) {
        const R = routes.get(tag) as { runs: number[][]; isI: boolean; L: number };
        const s = 7.2 * u * (R.isI ? 1.06 : 1);
        let bestQ: { x: number; y: number; score: number } | null = null;
        for (const p of R.runs) {
          const cum = [0];
          for (let i = 2; i < p.length; i += 2) cum.push((cum[cum.length - 1] as number) + Math.hypot((p[i] as number) - (p[i - 2] as number), (p[i + 1] as number) - (p[i - 1] as number)));
          const tot = cum[cum.length - 1] as number;
          if (tot < s * 3) continue;
          for (let f = 0.12; f <= 0.88; f += 0.08) {
            let i = 0;
            while (i < cum.length - 1 && (cum[i] as number) < tot * f) i++;
            const x = p[2 * i] as number;
            const y = p[2 * i + 1] as number;
            if (!inC(x, y)) continue;
            let ok = true;
            for (const [dx, dy] of [
              [-1, -1],
              [1, -1],
              [-1, 1],
              [1, 1],
            ] as const) {
              if (!inC(x + dx * s, y + dy * s) || !offCard(x + dx * s, y + dy * s)) ok = false;
            }
            if (!ok) continue;
            let near = Infinity;
            for (const sh of shields) near = Math.min(near, Math.hypot(sh.x - x, sh.y - y));
            if (near < s * 4) continue;
            const cl = CL.box(x, y, s * 2.1, s * 2.1, 0);
            const dr = Math.min(distToRuns(x, y, tag), s * 4);
            const score = cl * 4 - dr / s - Math.abs(f - 0.5) * 0.6 + (Math.hypot(x - sx, y - sy) < s * 4 ? 2 : 0);
            if (!bestQ || score < bestQ.score) bestQ = { x, y, score };
          }
        }
        if (bestQ && bestQ.score < 0.5) {
          shields.push({ x: bestQ.x, y: bestQ.y, s, tag, isI: R.isI });
          CL.mark(bestQ.x - s * 1.05, bestQ.y - s * 1.05, bestQ.x + s * 1.05, bestQ.y + s * 1.05);
        }
      }
      const notShield = (x: number, y: number) => {
        for (const sh of shields) if (Math.abs(x - sh.x) < sh.s * 1.02 && Math.abs(y - sh.y) < sh.s * 1.08) return false;
        return true;
      };
      // ===== 5. interstates and US highways: double lines, gaps under the shields
      P.into(vRd);
      for (const rr of roadRuns) {
        if (rr.out) {
          if (rr.sm.length >= 4) P.add(rr.sm, 'P');
          continue;
        }
        const hw = (rr.isI ? 1.6 : 1.2) * u;
        for (const side of [hw, -hw]) for (const run of runsOf(offsetLine(rr.sm, side), notShield, 1.5 * u)) P.add(run, rr.isI ? 'M' : 'T');
        CL.line(rr.sm, hw * 2 + 2);
      }
      for (const sh of shields) {
        const { x, y, s, isI } = sh;
        const num = sh.tag.slice(1);
        const shape = isI ? SHIELD_I : SHIELD_U;
        const pts: number[] = [];
        for (let q = 0; q < shape.length; q += 2) pts.push(x + (shape[q] as number) * s, y + (shape[q + 1] as number) * s);
        P.add(pts, 'O');
        if (isI) P.line(x - 0.93 * s, y - 0.42 * s, x + 0.93 * s, y - 0.42 * s, 'M');
        P.text(num, x, y + (isI ? 0.28 : 0.12) * s, Math.min(s * (isI ? 0.74 : 0.82), (s * 1.45) / Math.max(1, strW(num, 1))), 'c', 0, 'K', 'm');
      }
      CL.read();
      for (const sh of shields) CL.mark(sh.x - sh.s * 1.05, sh.y - sh.s * 1.05, sh.x + sh.s * 1.05, sh.y + sh.s * 1.05);
      if (seatLab) CL.mark(seatLab.xl - 2, seatLab.yc - seatH * 0.65, seatLab.xl + seatW + 2, seatLab.yc + seatH * 0.65);

      // ===== labels, phase 2: lake and river names (back into the water view)
      P.into(vWat);
      if (bigLake && bigLake.a > 50 * u) {
        const L = bigLake.L;
        const nm = L.name.toUpperCase();
        const h = th * 0.8;
        const w = strW(nm, h) + 4;
        let bestL: { x: number; y: number; score: number } | null = null;
        let ax = 0;
        let ay = 0;
        let n = 0;
        for (const r of L.rings) {
          for (let i = 0; i < r.length; i += 2) {
            if (!inC(r[i] as number, r[i + 1] as number)) continue;
            ax += r[i] as number;
            ay += r[i + 1] as number;
            n++;
          }
        }
        if (n) {
          ax /= n;
          ay /= n;
          for (let gy = -6; gy <= 6; gy++) {
            for (let gx = -6; gx <= 6; gx++) {
              const x = ax + gx * 7 * u;
              const y = ay + gy * 6 * u;
              if (!inC(x - w / 2, y) || !inC(x + w / 2, y)) continue;
              const inside = inLake(x, y) && inLake(x - w / 2, y) && inLake(x + w / 2, y);
              const c = inside ? CL.box(x, y, w, h * 1.2, 0) * 0.5 : CL.box(x, y, w, h * 1.3, 0);
              const score = c * 6 + Math.hypot(x - ax, y - ay) / (40 * u);
              if (c < 0.08 && (!bestL || score < bestL.score)) bestL = { x, y, score };
            }
          }
        }
        if (bestL) {
          P.text(nm, bestL.x, bestL.y, h, 'c', 0, 'W', 'm');
          CL.mark(bestL.x - w / 2, bestL.y - h * 0.65, bestL.x + w / 2, bestL.y + h * 0.65);
        }
      }
      rivS.sort((a, b) => b.len - a.len);
      const doneNames = new Set<string>();
      let nRiv = 0;
      for (const rv of rivS) {
        if (nRiv >= 2 || doneNames.has(rv.name)) continue;
        if (labelAlong(P, CL, rv.p, rv.name, th * 0.74, 'W', inC, u)) {
          doneNames.add(rv.name);
          nRiv++;
        }
      }

      // ===== 6. terrain (mountain counties) or the shoreline (coastal counties)
      P.into(vTer);
      let contourIv = 0;
      if (info.m) {
        const g = D.DEM;
        const Vd = dem();
        const cs = g.cs;
        const i0 = Math.max(0, Math.floor((bx0 - g.x0) / cs) - 1);
        const i1 = Math.min(g.nx - 1, Math.ceil((bx1 - g.x0) / cs) + 1);
        const j0 = Math.max(0, Math.floor((g.y1 - by1) / cs) - 1);
        const j1 = Math.min(g.ny - 1, Math.ceil((g.y1 - by0) / cs) + 1);
        const nx = i1 - i0;
        const ny = j1 - j0;
        const val = new Float32Array((nx + 1) * (ny + 1));
        let lo = Infinity;
        let hi = -Infinity;
        for (let j = 0; j <= ny; j++) {
          for (let i = 0; i <= nx; i++) {
            const v = (Vd[(j0 + j) * g.nx + i0 + i] as number) * 3.28084;
            val[j * (nx + 1) + i] = v;
            const x = SX(g.x0 + (i0 + i + 0.5) * cs);
            const y = SY(g.y1 - (j0 + j + 0.5) * cs);
            if (v === v && inC(x, y)) {
              if (v < lo) lo = v;
              if (v > hi) hi = v;
            }
          }
        }
        if (hi > lo) {
          let iv = 500;
          for (const c of [100, 200, 250, 400, 500]) {
            if ((hi - lo) / c <= 15) {
              iv = c;
              break;
            }
          }
          const idx = iv === 250 || iv === 400 ? 2000 : iv * 5;
          const x0s = SX(g.x0 + (i0 + 0.5) * cs);
          const y0s = SY(g.y1 - (j0 + 0.5) * cs);
          const css = cs * k;
          const keep = (x: number, y: number) => inC(x, y) && !inLake(x, y) && offCard(x, y) && CL.at(x, y) === 0;
          for (let lev = Math.ceil(lo / iv) * iv; lev < hi; lev += iv) {
            const isIdx = lev % idx === 0;
            for (const raw of isolines(val, nx, ny, x0s, y0s, css, lev)) {
              const line = chaikin(chaikin(raw));
              if (line.length < 8) continue;
              let labAt: { x: number; y: number; a: number; t: string; w: number } | null = null;
              if (isIdx && polyLen(line) > 70 * u) {
                for (const f of [0.3, 0.6, 0.45, 0.75, 0.15, 0.9]) {
                  const i = 2 * Math.floor(f * (line.length / 2 - 3)) + 2;
                  const x = line[i] as number;
                  const y = line[i + 1] as number;
                  if (!inC(x, y)) continue;
                  let a = Math.atan2((line[i + 3] as number) - (line[i - 1] as number), (line[i + 2] as number) - (line[i - 2] as number));
                  if (a > Math.PI / 2) a -= Math.PI;
                  if (a < -Math.PI / 2) a += Math.PI;
                  const t = String(lev);
                  const w = strW(t, th * 0.62) + 3 * u;
                  if (CL.box(x, y, w, th * 0.8, a) > 0.02) continue;
                  labAt = { x, y, a, t, w };
                  break;
                }
              }
              const la = labAt;
              const kp = la ? (x: number, y: number) => keep(x, y) && Math.hypot(x - la.x, y - la.y) > la.w / 2 : keep;
              for (const run of runsOf(line, kp, 0)) P.add(run, isIdx ? 'T' : 'H');
              if (la) {
                P.text(la.t, la.x, la.y, th * 0.62, 'c', la.a, 'X', 'm');
                CL.markRot(la.x, la.y, la.w, th * 0.8, la.a);
              }
            }
          }
          contourIv = iv;
        }
      } else if (info.c) {
        const wl: [string, number, number][] = D.WL.map((w) => [w[0], SX(w[1]), SY(w[2])]);
        if (info.oc) wl.push(['ATLANTIC OCEAN', SX(info.oc[0] as number), SY(info.oc[1] as number)]);
        for (const [nm, x0, y0] of wl) {
          const h = th * (nm === 'ATLANTIC OCEAN' ? 1.0 : 0.8);
          const w = strW(nm, h) + 4;
          let bestW: { x: number; y: number; d: number } | null = null;
          for (let gy = -3; gy <= 3; gy++) {
            for (let gx = -3; gx <= 3; gx++) {
              const x = x0 + gx * 10 * u;
              const y = y0 + gy * 8 * u;
              let wet = 0;
              for (const f of [-0.5, -0.25, 0, 0.25, 0.5]) {
                const qx = x + f * w;
                for (const dy of [-h * 0.6, 0, h * 0.6]) if (inNL(qx, y + dy) && !onLand(qx, y + dy) && offCard(qx, y + dy)) wet++;
              }
              if (wet < 15 || CL.box(x, y, w, h * 1.2, 0) > 0.02) continue;
              const d = Math.hypot(gx, gy);
              if (!bestW || d < bestW.d) bestW = { x, y, d };
            }
          }
          if (bestW) {
            P.text(nm, bestW.x, bestW.y, h, 'c', 0, 'W', 'm');
            CL.mark(bestW.x - w / 2 - 4, bestW.y - h, bestW.x + w / 2 + 4, bestW.y + h);
          }
        }
        const use = arcUse();
        const rr = createRng(hashParts(ID, 1, setup.seed, 'stipple', C[0]));
        const rows = [1.8, 3.6, 5.8, 8.4, 11.6, 15.5].map((d) => d * u * look.stip);
        const sp0 = 2.2 * u;
        for (const part of C[2]) {
          for (const r of part) {
            for (const a0 of r) {
              const a = a0 >= 0 ? a0 : ~a0;
              if (use[a] !== 1) continue;
              for (const run of runsOf(scr(arc(a)), inNL, 3 * u)) {
                const sm = chaikin(run);
                rows.forEach((d, ri) => {
                  const sp = sp0 * Math.pow(1.45, ri);
                  const o1 = offsetLine(sm, d);
                  const o2 = offsetLine(sm, -d);
                  let wet = 0;
                  for (const f of [0.25, 0.5, 0.75]) {
                    const i = 2 * Math.floor(f * (sm.length / 2 - 1));
                    if (!onLand(o1[i] as number, o1[i + 1] as number)) wet++;
                    if (!onLand(o2[i] as number, o2[i + 1] as number)) wet--;
                  }
                  const o = wet >= 0 ? o1 : o2;
                  let acc = rr.next() * sp;
                  for (let i = 2; i < o.length; i += 2) {
                    const ddx = (o[i] as number) - (o[i - 2] as number);
                    const ddy = (o[i + 1] as number) - (o[i - 1] as number);
                    const sl = Math.hypot(ddx, ddy);
                    while (acc < sl) {
                      const t = acc / sl;
                      const x = (o[i - 2] as number) + ddx * t + (rr.next() - 0.5) * 1.6 * u;
                      const y = (o[i - 1] as number) + ddy * t + (rr.next() - 0.5) * 1.6 * u;
                      if (inNL(x, y) && !onLand(x, y) && !onLand(x, y - 1.2 * u) && offCard(x, y) && CL.at(x, y) === 0) P.add([x, y, x + 0.35 * u, y + 0.25 * u], 'S');
                      acc += sp * (0.75 + rr.next() * 0.5);
                    }
                    acc -= sl;
                  }
                });
              }
            }
          }
        }
      }
      // ===== 7. the county seat
      P.into(vSeat);
      const star: number[] = [];
      for (let i = 0; i <= 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const r = i % 2 ? sr * 0.42 : sr;
        star.push(sx + Math.cos(a) * r, sy + Math.sin(a) * r);
      }
      P.add(star, 'O');
      P.hatch([star.slice(0, -2)], look.hatchA, 1.1 * u, 'M');
      P.circle(sx, sy, sr * 1.5, 'T');
      P.snap(sx, sy, 1, 'COUNTY SEAT: ' + seatName);
      if (seatLab) P.text(seatName, seatLab.xl, seatLab.yc, seatH, 'l', 0, 'K', 'm');
      // ===== 8. north arrow, scale bar, legend, inset, and the title block's fixed entries
      P.into(vOrn);
      const tags = [...routes.keys()];
      const items: ('I' | 'U' | 'S' | 'C' | 'K')[] = [];
      if (tags.some((t) => t[0] === 'I')) items.push('I');
      if (tags.some((t) => t[0] === 'U')) items.push('U');
      items.push('S', 'C');
      if (info.m && contourIv) items.push('K');
      const LBL = { I: 'INTERSTATE', U: 'U.S. HIGHWAY', S: 'COUNTY SEAT', C: 'COUNTY LINE', K: 'CONTOUR ' + contourIv + ' FT' };
      const row = 12.5 * u;
      const legend = {
        w: 28 * u + Math.max(...items.map((it) => strW(LBL[it], th * 0.7))),
        h: items.length * row,
        draw(x: number, y: number) {
          const h = th * 0.7;
          items.forEach((it, i) => {
            const yy = y + (i + 0.5) * row;
            const x0 = x + 2 * u;
            if (it === 'I' || it === 'U') {
              const hw = (it === 'I' ? 1.6 : 1.2) * u;
              P.add(offsetLine([x0, yy, x0 + 18 * u, yy], hw), it === 'I' ? 'M' : 'T');
              P.add(offsetLine([x0, yy, x0 + 18 * u, yy], -hw), it === 'I' ? 'M' : 'T');
              P.text(it === 'I' ? 'INTERSTATE' : 'U.S. HIGHWAY', x0 + 24 * u, yy, h, 'l', 0, 'X', 'm');
            } else if (it === 'S') {
              const s2: number[] = [];
              for (let q = 0; q <= 10; q++) {
                const a = -Math.PI / 2 + (q * Math.PI) / 5;
                const r = q % 2 ? 1.6 * u : 3.8 * u;
                s2.push(x0 + 9 * u + Math.cos(a) * r, yy + Math.sin(a) * r);
              }
              P.add(s2, 'O');
              P.text('COUNTY SEAT', x0 + 24 * u, yy, h, 'l', 0, 'X', 'm');
            } else if (it === 'C') {
              P.dash([x0, yy, x0 + 18 * u, yy], dpat, 'P');
              P.text('COUNTY LINE', x0 + 24 * u, yy, h, 'l', 0, 'X', 'm');
            } else {
              P.add([x0, yy + 2 * u, x0 + 6 * u, yy - 1 * u, x0 + 12 * u, yy + 1 * u, x0 + 18 * u, yy - 2 * u], 'T');
              P.text('CONTOUR ' + contourIv + ' FT', x0 + 24 * u, yy, h, 'l', 0, 'X', 'm');
            }
          });
        },
      };
      placeOrnaments(P, M, look, th, u, legend, (R) => drawInset(P, R, [decLine(D.NC)].concat(D.NCI.map(decLine)), [], rings, look, th, u, 'LOCATION IN NORTH CAROLINA'));
      TBK.notes(P, baseNotes.concat(info.m && contourIv ? ['CONTOURS ' + contourIv + ' FT FROM USGS 3DEP'] : []).concat(['NC STATE PLANE, NAD83']));
      TBK.rev(P);
      TBK.put(P, cells.project, B.siteName || 'UNTITLED', th * 1.9, 3, 'l', 'K');
      TBK.put(P, cells.scale, '1:' + thousands(M.ratio), th * 1.1, 1, 'l', 'M');
      // ===== 9. crescendo: the title block
      P.into(vTit);
      letterTitle(P, G, cells.title, titleName, titleSub, th, u, sheetTxt);
      letterSheet(P, cells.sheet, sheetTxt, 'FIPS ' + C[3], th, u);
    }

    function readout(x: number, y: number, out: Readout): boolean {
      const m = MAP;
      if (m === null || !m.M.inNL(x, y)) return false;
      m.M.toLLInto(x, y, ll);
      out.dms(ll[1] as number, CHAR_N, CHAR_S);
      out.str('  ');
      out.dms(ll[0] as number, CHAR_E, CHAR_W);
      out.next();
      if (m.inLake(x, y)) {
        const nm = m.lakeName(x, y);
        if (nm.length > 0) {
          out.str(nm);
          return true;
        }
      }
      const id = m.nbAt(x, y);
      if (id >= 0) out.str(m.labels[id] ?? '');
      return true;
    }

    function tap(x: number, y: number, t: number, api: SheetApi): boolean {
      const m = MAP;
      if (m === null || !m.M.inNL(x, y)) return false;
      const u = api.G.u;
      let key = -1;
      let name = '';
      for (let i = 0; i < m.lakes.length; i++) {
        const L = m.lakes[i] as TapLake;
        if (inRings(x, y, L.rings)) {
          key = L.li;
          name = L.upper;
          break;
        }
      }
      if (key < 0) {
        let bd = 7 * u;
        for (let r = 0; r < m.rivers.length; r++) {
          const rv = m.rivers[r] as TapRiver;
          const d = distToLine(rv.p, x, y);
          if (d < bd) {
            bd = d;
            key = rv.key;
            name = rv.upper;
          }
        }
      }
      if (key < 0) return false;
      if (!api.fresh(key, Math.round(x / 60), Math.round(y / 60))) return true;
      return api.note(m.M.nl, x, y, name, t);
    }

    hot.push(readout, tap, distToLine, clamp);
    return createSheet(setup, rng, COL, { id: ID, labels: { title: 'COUNTY' }, look, glyphs: GLYPHS, maxSeconds: 34, build, readout, tap, hot });
  },
});
