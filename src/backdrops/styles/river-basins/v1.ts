/**
 * river-basins v1. FROZEN once released (ADR 0021): add v2.ts for any change to what it draws.
 *
 * A pen plotter draws one of North Carolina's 17 major river basins as a hydrology sheet: blue-line rivers
 * on the family's paper, in the blueprint frame. Order: the sheet frame and graticule; the basin's divide
 * in one steady stroke (the land beyond it lightly hatched for some seeds); the main stem; tributaries
 * filling in by order, largest first, each one drawn from its mouth upstream so the network grows like a
 * tree; the reservoirs and lakes; a faint state line with the neighbouring states, a north arrow, scale
 * bar, and an NC inset with the basin shaded; and last, the crescendo: "CAPE FEAR RIVER BASIN", where it
 * drains, then its area in square miles computed from the geometry. About 30 to 34 s, then it holds.
 *
 * The seed locks the look (paper, ink, pen weight, layout, ornament styles, and plot order); the subject
 * (`setup.subject`, a basin's name) is the host's choice each visit, else one picked from the seed. Hover
 * for latitude and longitude and the river under the crosshair; tap a river or lake to letter its name;
 * tap elsewhere to stamp a revision cloud. Reduced motion shows the finished sheet. Nothing draws under
 * the card.
 *
 * Basins: the 17 basins are defined in G.S. 143-215.8B(f) (as amended by S.L. 2021-158) as the North
 * Carolina portion of listed USGS cataloging units (USGS Watershed Boundary Dataset HUC-8, public domain).
 * Rivers, creeks, and lakes © OpenStreetMap contributors (ODbL 1.0). State outline, U.S. Census Bureau.
 * Details in data.ts. Ported from the Backdrop Lab's river-basins.js (passwords-flow
 * design/backdrop-lab/styles/).
 */
import type { Rng } from '../../kernel/v1/prng.js';
import { createRng, hashParts } from '../../kernel/v1/prng.js';
import { defineVersion } from '../define.js';
import {
  baseGlyphs,
  chooseSubject,
  createSheet,
  decLine,
  distToLine,
  drawGraticule,
  drawInset,
  fillRings,
  inRings,
  labelAlong,
  lerp,
  letterSheet,
  letterTitle,
  makeClutter,
  makeMap,
  maskIndex,
  Plot,
  type PlotView,
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
import { BASIN_DATA as D } from './data.js';
import { BASIN_KEYS } from './subjects.js';

const ID = 'river-basins';
const SETS: Readonly<Record<string, readonly string[]>> = { all: BASIN_KEYS };
const GLYPHS = baseGlyphs();
const CHAR_N = 78;
const CHAR_S = 83;
const CHAR_E = 69;
const CHAR_W = 87;

/** Labels for the neighbouring states and the ocean, at fixed longitudes and latitudes, in priority order. */
const STATES: readonly (readonly [string, number, number])[] = [
  ['VIRGINIA', -79.2, 36.78],
  ['VIRGINIA', -77.2, 36.72],
  ['VIRGINIA', -81.0, 36.72],
  ['VIRGINIA', -76.4, 36.7],
  ['TENNESSEE', -83.1, 36.25],
  ['TENNESSEE', -83.9, 35.75],
  ['TENNESSEE', -82.1, 36.45],
  ['SOUTH CAROLINA', -80.6, 34.62],
  ['SOUTH CAROLINA', -79.1, 34.15],
  ['SOUTH CAROLINA', -81.8, 34.95],
  ['SOUTH CAROLINA', -82.7, 34.9],
  ['GEORGIA', -83.8, 34.88],
  ['ATLANTIC OCEAN', -75.25, 35.55],
  ['ATLANTIC OCEAN', -76.6, 34.35],
  ['ATLANTIC OCEAN', -77.7, 33.72],
  ['ATLANTIC OCEAN', -75.5, 36.25],
  ['ATLANTIC OCEAN', -75.8, 34.95],
];

function rings(s: string): Float64Array[] {
  return s ? s.split('!').map(decLine) : [];
}

interface BasinLook extends SheetLook {
  readonly na: number;
  readonly sb: number;
  readonly hatchA: number;
  readonly outHatch: boolean;
  readonly hatchSp: number;
}

function basinLook(r: Rng): BasinLook {
  const n = () => r.next();
  return { tbLeft: n() < 0.25, na: Math.floor(n() * 3), sb: Math.floor(n() * 2), penW: lerp(0.9, 1.15, n()), hatchA: lerp(-0.9, 0.9, n()), gratF: n() < 0.5 ? 1 : 1.5, legend: n() < 0.8, prefer: n(), outHatch: n() < 0.55, hatchSp: lerp(5.5, 7.5, n()) };
}

interface TapRiver {
  p: number[];
  key: number;
  upper: string;
}
interface TapLake {
  rings: number[][];
  key: number;
  upper: string;
}
interface BasinMap {
  M: SheetMap;
  u: number;
  sRings: number[][];
  title: string;
  rivers: TapRiver[];
  lakes: TapLake[];
}

export const riverBasinsV1 = defineVersion({
  version: 1,
  fps: 30,
  maxPixelRatio: 2,
  stillTime: 40,
  settlesAt: 34,
  colors: (p) => sheetColours(p),
  create(setup, COL) {
    const rng = createRng(hashParts(ID, 1, setup.seed));
    const look = basinLook(rng.fork('look'));
    const subject = chooseSubject(SETS, 'all', setup.subject, setup.subjectSet, rng.fork('subject'));
    const bi = D.B.findIndex((b) => b.id === subject.key);
    const sheetTxt = 'SHEET ' + (subject.index + 1) + ' OF ' + subject.count;
    let MAP: BasinMap | null = null;
    const ll = new Float64Array(2);
    const hot: unknown[] = [];

    function build(B: SheetBuild<BasinLook>): void {
      const { P, G, u, th, cells, TBK } = B;
      const b = D.B[bi] as (typeof D.B)[number];
      const outline = rings(b.o);
      let bx0 = Infinity;
      let by0 = Infinity;
      let bx1 = -Infinity;
      let by1 = -Infinity;
      for (const r of outline) {
        for (let i = 0; i < r.length; i += 2) {
          const x = r[i] as number;
          const y = r[i + 1] as number;
          if (x < bx0) bx0 = x;
          if (x > bx1) bx1 = x;
          if (y < by0) by0 = y;
          if (y > by1) by1 = y;
        }
      }
      const titleSub = [b.f, thousands(b.a) + ' SQ MI IN NORTH CAROLINA'];
      const code = b.h + ' HUC-8 UNIT' + (b.h > 1 ? 'S' : '');
      const notes = ['WATER FEATURES © OPENSTREETMAP CONTRIBUTORS', 'BASINS: USGS WATERSHED BOUNDARY DATASET, HUC-8 PER G.S. 143-215.8B', 'BOUNDARIES: U.S. CENSUS BUREAU', 'NC STATE PLANE, NAD83'];
      const M = makeMap(G, [bx0, by0, bx1, by1], look, [D.O[0] as number, D.O[1] as number], D.U);
      if (!M) {
        titleOnly(B, b.t, titleSub, sheetTxt, code, notes);
        return;
      }
      const nl = M.nl;
      const scr = M.scr;
      const inNL = M.inNL;
      const offCard = M.offCard;
      const sRings = outline.map(scr);
      // Masks over the neatline: inside the basin, and inside North Carolina.
      const mW = Math.max(1, Math.ceil(nl.w));
      const mH = Math.max(1, Math.ceil(nl.h));
      const basinMask = new Uint8Array(mW * mH);
      const ncMask = new Uint8Array(mW * mH);
      const ncRings = rings(D.NC).map(scr);
      fillRings(nl, ncRings, (i) => {
        ncMask[i] = 1;
      });
      fillRings(nl, sRings, (i) => {
        basinMask[i] = 1;
      });
      const inBasin = (x: number, y: number) => {
        const o = maskIndex(nl, x, y);
        return o >= 0 && basinMask[o] === 1;
      };
      const inNC = (x: number, y: number) => {
        const o = maskIndex(nl, x, y);
        return o >= 0 && ncMask[o] === 1;
      };
      const map: BasinMap = { M, u, sRings, title: b.t, rivers: [], lakes: [] };
      MAP = map;
      hot.push(M.inNL, M.toLLInto);
      const CL = makeClutter(M);
      const nameKeys = new Map<string, number>();
      const nameKey = (name: string) => {
        let k = nameKeys.get(name);
        if (k === undefined) {
          k = nameKeys.size;
          nameKeys.set(name, k);
        }
        return k;
      };

      const vGrat = P.into(P.views[0] as PlotView);
      vGrat.dur = 3.0;
      vGrat.name = 'graticule';
      const vOut = P.view(4.4, 'divide');
      const vMain = P.view(3.6, 'main stem');
      const vT1 = P.view(4.6, 'tributaries 1');
      const vT2 = P.view(3.6, 'tributaries 2');
      const vT3 = P.view(2.6, 'tributaries 3');
      const vLk = P.view(3.0, 'reservoirs');
      const vCtx = P.view(4.2, 'context');
      const vTit = P.view(3.8, 'title');
      // ===== frame and graticule
      P.into(vGrat);
      drawGraticule(P, M, look, th, u);
      // ===== 1. the divide, in one steady stroke; then (some seeds) light hatching on the land beyond it
      P.into(vOut);
      for (const [, i] of sRings.map((r, i) => [Math.abs(ringArea(r)), i] as const).sort((a, c) => c[0] - a[0])) {
        P.add(sRings[i], 'O');
        CL.line(sRings[i] as number[], 3);
      }
      // ===== 2-4. main stem, tributaries by order (each from its mouth upstream), reservoirs and lakes.
      // Names are placed first, against the divide, main stem, first-order rivers, and lakes; finer streams
      // are then cut around them, and each name is lettered right after its own river.
      const rivs = b.r.map(([ni, lv, enc]) => ({ name: D.N[ni] as string, lv, parts: rings(enc).map(scr) }));
      const lakes = b.l.map(([ni, enc]) => ({ name: D.LN[ni] as string, rings: rings(enc).map(scr), area: 0 }));
      for (const rv of rivs) if (rv.lv === 0) for (const p of rv.parts) CL.line(p, 3.5);
      for (const L of lakes) {
        L.area = 0;
        for (const r of L.rings) {
          L.area += Math.abs(ringArea(r));
          CL.line(r, 2);
        }
      }
      CL.read();
      const labP = [0, 1, 2, 3, 4].map(() => new Plot(u, GLYPHS));
      const lakeP = new Plot(u, GLYPHS);
      const boxes: [number, number, number, number][] = [];
      const byLen = (r: (typeof rivs)[number]) => r.parts.reduce((a, p) => a + polyLen(p), 0);
      const keepL = (x: number, y: number) => inNL(x, y) && offCard(x, y);
      const tryLabel = (r: (typeof rivs)[number], h: number, loose?: boolean) => {
        const longest = r.parts.slice().sort((a, c) => polyLen(c) - polyLen(a))[0];
        if (!longest) return false;
        const Pq = labP[Math.min(4, r.lv)] as Plot;
        const s0 = (Pq.views[0] as PlotView).s;
        const before = s0.length;
        if (!labelAlong(Pq, CL, longest, r.name, h, 'W', keepL, u, loose ? { tol: 0.06, dev: 11, chord: 0.66, steps: 41 } : { tol: 0.03, dev: 7, chord: 0.72, steps: 25 })) return false;
        let x0 = Infinity;
        let y0 = Infinity;
        let x1 = -Infinity;
        let y1 = -Infinity;
        for (const st of s0.slice(before)) {
          for (let i = 0; i < st.p.length; i += 2) {
            x0 = Math.min(x0, st.p[i] as number);
            x1 = Math.max(x1, st.p[i] as number);
            y0 = Math.min(y0, st.p[i + 1] as number);
            y1 = Math.max(y1, st.p[i + 1] as number);
          }
        }
        boxes.push([x0 - 2 * u, y0 - 2 * u, x1 + 2 * u, y1 + 2 * u]);
        return true;
      };
      const done = new Set<string>();
      let named = 0;
      for (const r of rivs.filter((q) => q.lv === 0).sort((a, c) => byLen(c) - byLen(a))) {
        if (!done.has(r.name) && (tryLabel(r, th * 0.9, true) || tryLabel(r, th * 0.78, true))) done.add(r.name);
      }
      // First-order rivers join the clutter only now, so they give way to the main stem's name.
      const mainBoxes = boxes.slice();
      for (const rv of rivs) if (rv.lv === 1) for (const p of rv.parts) CL.line(p, 2.4);
      CL.read();
      for (const q of mainBoxes) CL.mark(q[0], q[1], q[2], q[3]);
      for (const { r } of rivs
        .filter((q) => q.lv === 1 || q.lv === 2)
        .map((r) => ({ r, L: byLen(r) * (r.lv === 1 ? 1 : 0.6) }))
        .sort((a, c) => c.L - a.L)) {
        if (named >= 5) break;
        if (done.has(r.name) || byLen(r) < 70 * u) continue;
        if (tryLabel(r, th * 0.74)) {
          done.add(r.name);
          named++;
        }
      }
      for (const L of lakes
        .slice()
        .sort((a, c) => c.area - a.area)
        .slice(0, 3)) {
        if (L.area < 400 * u * u) continue;
        const nm = L.name.toUpperCase();
        const h = th * 0.72;
        const w = strW(nm, h) + 4;
        let ax = 0;
        let ay = 0;
        let n = 0;
        let best: { x: number; y: number; d: number } | null = null;
        for (const r of L.rings) {
          for (let i = 0; i < r.length; i += 2) {
            ax += r[i] as number;
            ay += r[i + 1] as number;
            n++;
          }
        }
        ax /= n;
        ay /= n;
        for (let gy = -6; gy <= 6; gy++) {
          for (let gx = -6; gx <= 6; gx++) {
            const x = ax + gx * 7 * u;
            const y = ay + gy * 6 * u;
            if (CL.box(x, y, w, h * 1.2, 0) > 0.03) continue;
            const d = Math.hypot(x - ax, y - ay);
            if (!best || d < best.d) best = { x, y, d };
          }
        }
        if (best && best.d < 50 * u) {
          lakeP.text(nm, best.x, best.y, h, 'c', 0, 'W', 'm');
          CL.mark(best.x - w / 2, best.y - h * 0.65, best.x + w / 2, best.y + h * 0.65);
          boxes.push([best.x - w / 2 - 2 * u, best.y - h, best.x + w / 2 + 2 * u, best.y + h]);
        }
      }
      const clear = (x: number, y: number) => {
        for (const q of boxes) if (x > q[0] && x < q[2] && y > q[1] && y < q[3]) return false;
        return true;
      };
      const clearMain = (x: number, y: number) => {
        for (const q of mainBoxes) if (x > q[0] && x < q[2] && y > q[1] && y < q[3]) return false;
        return true;
      };
      const cls = ['V', 'W', 'Y', 'w', 'w'] as const;
      const views = [vMain, vT1, vT2, vT3, vT3];
      for (let lv = 0; lv <= 4; lv++) {
        P.into(views[lv] as PlotView);
        for (const rv of rivs) {
          if (rv.lv !== lv) continue;
          const keep = lv === 0 ? inNL : lv === 1 ? (x: number, y: number) => inNL(x, y) && clearMain(x, y) : (x: number, y: number) => inNL(x, y) && clear(x, y);
          for (const p of rv.parts) {
            for (const run of runsOf(p, keep, 2 * u)) P.add(run, cls[lv] as (typeof cls)[number]);
            map.rivers.push({ p, key: nameKey(rv.name), upper: rv.name.toUpperCase() });
          }
        }
        for (const st of ((labP[lv] as Plot).views[0] as PlotView).s) P.add(st.p, st.c);
      }
      P.into(vLk);
      for (const L of lakes) {
        for (const r of L.rings) for (const run of runsOf(r, inNL, 3 * u)) P.add(run, 'W');
        const tmp = new Plot(u, GLYPHS);
        tmp.hatch(L.rings, 0, 3 * u, 'w');
        for (const st of (tmp.views[0] as PlotView).s) for (const run of runsOf(st.p, (x, y) => inNL(x, y) && clear(x, y), 2 * u)) P.add(run, 'w');
        map.lakes.push({ rings: L.rings, key: 100000 + nameKey(L.name), upper: L.name.toUpperCase() });
      }
      for (const st of (lakeP.views[0] as PlotView).s) P.add(st.p, st.c);
      // ===== 5. context: the state line and neighbours, ornaments, inset with the basin shaded
      P.into(vCtx);
      for (const r of ncRings) {
        for (const run of runsOf(r, (x, y) => inNL(x, y) && !inBasin(x, y), 3 * u)) {
          P.dash(run, [9 * u, 2.5 * u, 1.4 * u, 2.5 * u], 'P');
          CL.line(run, 1.5);
        }
      }
      const used = new Set<string>();
      const stateLabs: [number, number, number, number][] = [];
      for (const [nm, lo, la] of STATES) {
        if (used.has(nm)) continue;
        const q = M.fromLL(lo, la);
        const h = th * (nm === 'ATLANTIC OCEAN' ? 0.95 : 0.85);
        const w = strW(nm, h) + 4;
        if (!inNL(q[0] - w / 2, q[1]) || !inNL(q[0] + w / 2, q[1]) || inNC(q[0], q[1]) || CL.box(q[0], q[1], w, h * 1.2, 0) > 0.03) continue;
        P.text(nm, q[0], q[1], h, 'c', 0, nm === 'ATLANTIC OCEAN' ? 'W' : 'P', 'm');
        CL.mark(q[0] - w / 2, q[1] - h, q[0] + w / 2, q[1] + h);
        used.add(nm);
        stateLabs.push([q[0], q[1], w / 2 + 3 * u, h * 0.9]);
      }
      // The land beyond the divide, lightly hatched for some seeds, with gaps around the names (into the divide view).
      if (look.outHatch) {
        P.into(vOut);
        const box = [[nl.x, nl.y, nl.x + nl.w, nl.y, nl.x + nl.w, nl.y + nl.h, nl.x, nl.y + nl.h]];
        const tmp = new Plot(u, GLYPHS);
        tmp.hatch(box, Math.PI / 4 + look.hatchA * 0.2, look.hatchSp * u, 'H');
        const keep = (x: number, y: number) => {
          if (inBasin(x, y) || !offCard(x, y)) return false;
          for (const g of stateLabs) if (Math.abs(x - g[0]) < g[2] && Math.abs(y - g[1]) < g[3]) return false;
          return true;
        };
        for (const s of (tmp.views[0] as PlotView).s) for (const run of runsOf(s.p, keep, 2 * u)) P.add(run, 'H');
        P.into(vCtx);
      }
      const items = (
        [
          ['V', 'MAIN STEM'],
          ['W', 'TRIBUTARY'],
          ['L', 'RESERVOIR OR LAKE'],
          ['O', 'BASIN DIVIDE'],
          ['P', 'STATE LINE'],
        ] as const
      ).filter((it) => it[0] !== 'L' || lakes.length);
      const row = 12.5 * u;
      const legend = {
        w: 28 * u + Math.max(...items.map((it) => strW(it[1], th * 0.7))),
        h: items.length * row,
        draw(x: number, y: number) {
          items.forEach(([kind, t], i) => {
            const yy = y + (i + 0.5) * row;
            const x0 = x + 2 * u;
            if (kind === 'L') {
              const rg = [x0, yy - 3 * u, x0 + 18 * u, yy - 3 * u, x0 + 18 * u, yy + 3 * u, x0, yy + 3 * u];
              P.poly(rg.slice(), 'W', true);
              P.hatch([rg], 0, 2 * u, 'w');
            } else if (kind === 'P') P.dash([x0, yy, x0 + 18 * u, yy], [6 * u, 2 * u, 1.2 * u, 2 * u], 'P');
            else P.add([x0, yy + 1.5 * u, x0 + 6 * u, yy - 1.5 * u, x0 + 12 * u, yy + 1.5 * u, x0 + 18 * u, yy - 1.5 * u], kind);
            P.text(t, x0 + 24 * u, yy, th * 0.7, 'l', 0, 'X', 'm');
          });
        },
      };
      const others: Float64Array[] = [];
      D.B.forEach((o, i) => {
        if (i !== bi) for (const r of rings(o.i)) others.push(r);
      });
      placeOrnaments(P, M, look, th, u, legend, (R) => drawInset(P, R, rings(D.NCI), others, rings(b.i), look, th, u, 'THE 17 BASINS OF NORTH CAROLINA'));
      TBK.notes(P, notes);
      TBK.rev(P);
      TBK.put(P, cells.project, B.siteName || 'UNTITLED', th * 1.9, 3, 'l', 'K');
      TBK.put(P, cells.scale, '1:' + thousands(M.ratio), th * 1.1, 1, 'l', 'M');
      // ===== 6. crescendo
      P.into(vTit);
      letterTitle(P, G, cells.title, b.t, titleSub, th, u, sheetTxt);
      letterSheet(P, cells.sheet, sheetTxt, code, th, u);
    }

    function readout(x: number, y: number, out: Readout): boolean {
      const m = MAP;
      if (m === null || !m.M.inNL(x, y)) return false;
      m.M.toLLInto(x, y, ll);
      out.dms(ll[1] as number, CHAR_N, CHAR_S);
      out.str('  ');
      out.dms(ll[0] as number, CHAR_E, CHAR_W);
      out.next();
      let bd = 6 * m.u;
      let name = '';
      for (let r = 0; r < m.rivers.length; r++) {
        const rv = m.rivers[r] as TapRiver;
        const d = distToLine(rv.p, x, y);
        if (d < bd) {
          bd = d;
          name = rv.upper;
        }
      }
      if (name.length === 0) {
        for (let i = 0; i < m.lakes.length; i++) {
          const L = m.lakes[i] as TapLake;
          if (inRings(x, y, L.rings)) {
            name = L.upper;
            break;
          }
        }
      }
      if (name.length === 0 && inRings(x, y, m.sRings)) name = m.title;
      out.str(name);
      return true;
    }

    function tap(x: number, y: number, t: number, api: SheetApi): boolean {
      const m = MAP;
      if (m === null || !m.M.inNL(x, y)) return false;
      let bd = 7 * api.G.u;
      let key = -1;
      let name = '';
      for (let r = 0; r < m.rivers.length; r++) {
        const rv = m.rivers[r] as TapRiver;
        const d = distToLine(rv.p, x, y);
        if (d < bd) {
          bd = d;
          key = rv.key;
          name = rv.upper;
        }
      }
      if (key < 0) {
        for (let i = 0; i < m.lakes.length; i++) {
          const L = m.lakes[i] as TapLake;
          if (inRings(x, y, L.rings)) {
            key = L.key;
            name = L.upper;
            break;
          }
        }
      }
      if (key < 0) return false;
      if (!api.fresh(key, Math.round(x / 60), Math.round(y / 60))) return true;
      return api.note(m.M.nl, x, y, name, t);
    }

    hot.push(readout, tap);
    return createSheet(setup, rng, COL, { id: ID, labels: { title: 'BASIN' }, look, glyphs: GLYPHS, maxSeconds: 33, build, readout, tap, hot });
  },
});
