/**
 * yokum-magnetic v1. FROZEN once released (ADR 0021): add v2.ts for any change to what it draws.
 *
 * A faithful port of the Yokum Lab sign-in (David Yokum's own project): iron filings that swirl around
 * the pointer (yokum-lab src/components/login-background.tsx), the site's name in big letters that fall
 * when the pointer touches them and tumble on a floor (physics-stage.tsx, fallable-text.tsx), and the
 * login page's rose magnet button (ReassembleButton) that springs every fallen letter back home. The
 * port follows the Backdrop Lab's (passwords-flow design/backdrop-lab/index.html, `yokum-magnetic`).
 * Constants are the originals (`YK`); the physics runs at the original's 60 Hz with a fixed-step
 * accumulator driven by `dt`.
 *
 * Kit mapping (documented choices):
 * - Family. Yokum Lab is the personal family, so the personal palette renders the original exactly
 *   (cool gray filings [180, 188, 200] on #fdfcfb, the title in [28, 50, 110]). The kit's setup has no
 *   family, so it's recognized by its brand colors (copied below as they were when this version was
 *   frozen). Other light palettes keep the original's logic, as the lab does: filings 14% toward a
 *   slate (ink → mist at 0.4, which lands near the lab's OSBM and UNC slates), the page 60% toward
 *   white, and the title in the ink.
 * - Dark pages (relative luminance under 0.3; the original and the lab have no dark treatment): the
 *   palette's page, filings 45% toward it, and the title in the palette color that contrasts most.
 * - Title. The site's name (`setup.siteName`) in system-ui (the kit loads no web fonts), measured once
 *   with `measureText`. It sits in the band above the card on wide screens and below it on phones, as
 *   in the lab, falling back to the other band when there's no room and leaving the title out when
 *   neither band has room (never under the card). The lab's subtitle (the family's short name) is left
 *   out: the setup has no family. Without a site name the filings and the magnet's place are drawn
 *   with no title.
 * - The exclusion halos the original drew around each login element (padding 8, buffer 26) are one
 *   halo around `setup.card`.
 * - Pointer. The swirl follows the pointer while it's present (`strength` over 0.5) and stays where it
 *   left, as the original's cursor did. The pointer's velocity (which knocks fallen letters about) comes
 *   from its per-frame movement instead of pointer events. Letters fall when the present pointer enters
 *   their box (never from over the card or the magnet).
 * - The magnet is drawn on the canvas where the lab put its button (64 px, 32 px from the bottom-right
 *   corner; on phones 16 px from the right and 90 px from the bottom), moved clear of the card when it
 *   would overlap it, and shown only while a letter is away, with the original's pop-in and pulse. A tap
 *   on it (`tap`) springs every letter home. It isn't a DOM button, so it has no keyboard focus or
 *   pointer cursor; the art is decorative and the card always works.
 * - Nothing moves on its own: the version settles (`settlesAt`) and asks for frames (`invalidate`)
 *   while letters are in the air or springing home.
 */
import { contrastRatio, over, parseHex, relativeLuminance, rgba, type Rgb, toHex } from '../../kernel/v1/color.js';
import { createRng, hashParts } from '../../kernel/v1/prng.js';
import { clamp, TAU } from '../../kernel/v1/shape.js';
import { type Ctx2D, defineVersion, type StyleSetup } from '../define.js';

type BackdropPalette = StyleSetup['palette'];

/** The original's constants (physics-stage.tsx, fallable-text.tsx, login-background.tsx). */
const YK = {
  SPACING: 22,
  CURSOR_RADIUS: 350,
  GRAVITY: 0.22,
  FLOOR_BOUNCE: 0.42,
  FRICTION: 0.86,
  FLOOR_OFFSET: 20,
  COLLISION_RESTITUTION: 0.7,
  SPRING_STIFFNESS: 0.045,
  SPRING_DAMPING: 0.88,
  RETURN_SNAP_DIST: 2,
  RETURN_SNAP_VEL: 0.4,
  CURSOR_RADIUS_PUSH: 24,
  CURSOR_VELOCITY_TRANSFER: 0.18,
  CURSOR_VELOCITY_DECAY: 0.72,
} as const;

/** The Yokum Lab (personal) family's brand colors when this version was frozen (families.ts, v0.1.8). */
const PERSONAL_BRAND = { primary: '#1c326e', secondary: '#4f63ad', ink: '#1c1917' } as const;

/** Filing buckets: influence levels × fade levels (the lab's NB × FB). */
const NB = 7;
const FB = 4;
const BUCKETS = NB * FB;
const NO_BUCKET = 255;
const MAX_LETTERS = 80;

const HOME = 0;
const FALL = 1;
const RETURN = 2;

/** The magnet button (the lab's .vp-magnet): 64 px, rose #E11D48, hover #F43F5E, a white magnet icon. */
const MAGNET_R = 32;
const MAGNET_HIT = MAGNET_R + 6;
const POP_IN = 0.55;
const PULSE = 2.4;
const PULSE_LEVELS = 16;

/** One SVG elliptical arc (circular, unrotated) as canvas arc parameters: cx, cy, start, end, anticlockwise. */
function svgArc(x1: number, y1: number, r: number, large: number, sweep: number, x2: number, y2: number): number[] {
  const hx = (x1 - x2) / 2;
  const hy = (y1 - y2) / 2;
  const sign = large !== sweep ? 1 : -1;
  const coef = sign * Math.sqrt(Math.max(0, (r * r - hx * hx - hy * hy) / (hx * hx + hy * hy)));
  const cx = coef * hy + (x1 + x2) / 2;
  const cy = -coef * hx + (y1 + y2) / 2;
  return [cx, cy, Math.atan2(y1 - cy, x1 - cx), Math.atan2(y2 - cy, x2 - cx), sweep ? 0 : 1];
}

/** The Lucide "magnet" icon (24 × 24, stroke 2), as the lab draws it: its two arcs, precomputed. */
const ICON_ARC_OUTER = new Float64Array(svgArc(8.75, 4.23, 7.79, 0, 1, 19.75, 15.23));
const ICON_ARC_INNER = new Float64Array(svgArc(15.39, 11.64, 2.14, 0, 0, 12.39, 8.64));

function isPersonal(p: BackdropPalette): boolean {
  return p.primary.toLowerCase() === PERSONAL_BRAND.primary && p.secondary.toLowerCase() === PERSONAL_BRAND.secondary && p.ink.toLowerCase() === PERSONAL_BRAND.ink;
}

function mostContrasting(against: string, options: readonly string[]): string {
  let best = options[0] as string;
  for (const c of options) if (contrastRatio(c, against) > contrastRatio(best, against)) best = c;
  return best;
}

/** easeOutBack: close to the lab's cubic-bezier(.34, 1.56, .64, 1), applied per keyframe as CSS does. */
function overshoot(u: number): number {
  const v = u - 1;
  return 1 + 2.70158 * v * v * v + 1.70158 * v * v;
}

export const yokumMagneticV1 = defineVersion({
  version: 1,
  fps: 30,
  maxPixelRatio: 2,
  stillTime: 2,
  settlesAt: 1,
  colors: (p) => {
    const neutral: Rgb = [180, 188, 200];
    const personal = isPersonal(p);
    const dark = relativeLuminance(p.page) < 0.3;
    let filing: Rgb;
    let ground: string;
    let title: string;
    if (!dark) {
      const slate = over(p.mist, 0.4, p.ink);
      filing = personal ? neutral : over(slate, 0.14, neutral);
      ground = personal ? '#fdfcfb' : toHex(over('#ffffff', 0.6, p.page));
      title = personal ? toHex([28, 50, 110]) : p.ink;
    } else {
      filing = over(p.page, 0.45, neutral);
      ground = p.page;
      title = mostContrasting(p.page, [p.ink, p.glow, p.mist, p.primary]);
    }
    const strokes: string[] = [];
    const widths: number[] = [];
    for (let q = 0; q < BUCKETS; q++) {
      const inf = Math.floor(q / FB) / (NB - 1);
      const fade = ((q % FB) + 1) / FB;
      strokes.push(rgba(filing, (0.5 + inf * 0.35) * fade));
      widths.push(1.2 + inf * 1.4);
    }
    const rose = parseHex('#e11d48');
    const rings: string[] = [];
    const shadows: string[] = [];
    for (let l = 0; l < PULSE_LEVELS; l++) {
      const s = l / (PULSE_LEVELS - 1);
      rings.push(rgba(rose, 0.45 * (1 - s)));
      shadows.push(rgba(rose, 0.45 + 0.15 * s));
    }
    return { ground, title, strokes, widths, rings, shadows, magnet: '#e11d48', magnetHover: '#f43f5e', icon: '#ffffff', clear: 'rgba(0,0,0,0)' };
  },
  create(setup, c) {
    const { width: w, height: h, card } = setup;
    const rng = createRng(hashParts('yokum-magnetic', 1, setup.seed));
    const play = rng.fork('physics');
    const motion = setup.motion;
      const pixelRatio = setup.pixelRatio;
    const phone = w < 640;

    // ---- Filings (login-background.tsx): a jittered grid, each with a rest angle and a length.
    const SP = YK.SPACING;
    const cols = Math.floor(w / SP);
    const rows = Math.floor(h / SP);
    const n = cols * rows;
    const fx = new Float32Array(n);
    const fy = new Float32Array(n);
    const fn = new Float64Array(n);
    const fc = new Float64Array(n);
    const fl = new Float32Array(n);
    const ff = new Float32Array(n);
    const ca = new Float32Array(n);
    const sa = new Float32Array(n);
    const bucket = new Uint8Array(n);
    const order = new Uint32Array(n);
    const counts = new Uint32Array(BUCKETS);
    const starts = new Uint32Array(BUCKETS);
    for (let r = 0, i = 0; r < rows; r++) {
      for (let col = 0; col < cols; col++, i++) {
        fx[i] = col * SP + SP / 2 + (rng.next() - 0.5) * 6;
        fy[i] = r * SP + SP / 2 + (rng.next() - 0.5) * 6;
        fn[i] = rng.next() * Math.PI;
        fc[i] = rng.next() * Math.PI;
        fl[i] = 8 + rng.next() * 4;
      }
    }
    // The exclusion halo around the card (the original's: padding 8, buffer 26).
    const exL = card.x - 8;
    const exT = card.y - 8;
    const exR = card.x + card.width + 8;
    const exB = card.y + card.height + 8;
    for (let i = 0; i < n; i++) {
      const x = fx[i] as number;
      const y = fy[i] as number;
      const dx = Math.max(exL - x, 0, x - exR);
      const dy = Math.max(exT - y, 0, y - exB);
      const d = Math.sqrt(dx * dx + dy * dy);
      ff[i] = d === 0 ? 0 : Math.min(1, d / 26);
    }

    function angleDelta(from: number, to: number): number {
      let d = (to - from) % Math.PI;
      if (d > Math.PI / 2) d -= Math.PI;
      if (d < -Math.PI / 2) d += Math.PI;
      return d;
    }

    /** A filing's target angle for the cursor (tangent to it, by influence); `influence` gets the weight. */
    let influence = 0;
    function targetOf(i: number): number {
      const dx = (fx[i] as number) - cursorX;
      const dy = (fy[i] as number) - cursorY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      influence = Math.max(0, 1 - dist / YK.CURSOR_RADIUS);
      const rest = fn[i] as number;
      if (influence <= 0.05) return rest;
      return rest + angleDelta(rest, Math.atan2(dy, dx) + Math.PI / 2) * influence;
    }

    // The cursor starts in the middle, where the original's does; the filings start settled around it.
    let cursorX = w / 2;
    let cursorY = h / 2;
    let cursorVX = 0;
    let cursorVY = 0;
    for (let i = 0; i < n; i++) fc[i] = targetOf(i);

    // ---- The magnet button's place: where the lab put it, else the first spot clear of the card.
    const candidates = phone
      ? [[w - 16 - MAGNET_R, h - 90 - MAGNET_R], [w - 16 - MAGNET_R, h - 16 - MAGNET_R], [w - 16 - MAGNET_R, card.y + card.height + 16 + MAGNET_R], [w - 16 - MAGNET_R, card.y - 16 - MAGNET_R]]
      : [[w - 32 - MAGNET_R, h - 32 - MAGNET_R], [w - 16 - MAGNET_R, h - 16 - MAGNET_R], [card.x + card.width + 16 + MAGNET_R, h - 32 - MAGNET_R], [card.x - 16 - MAGNET_R, h - 32 - MAGNET_R]];
    let magnetX = Number.NaN;
    let magnetY = Number.NaN;
    for (const [x, y] of candidates as [number, number][]) {
      const inside = x - MAGNET_R >= 0 && y - MAGNET_R >= 0 && x + MAGNET_R <= w && y + MAGNET_R <= h;
      const clear = x + MAGNET_R + 8 < card.x || x - MAGNET_R - 8 > card.x + card.width || y + MAGNET_R + 8 < card.y || y - MAGNET_R - 8 > card.y + card.height;
      if (inside && clear) {
        magnetX = x;
        magnetY = y;
        break;
      }
    }

    // ---- Title letters (fallable-text.tsx), laid out around the card and measured once.
    const chars: string[] = [];
    let fs = 0;
    let font = '';
    let base = 0;
    const hx: number[] = [];
    const hy: number[] = [];
    const lw: number[] = [];
    const name = (setup.siteName ?? '').trim();
    if (name !== '') {
      const fontT = (size: number) => `700 ${size}px system-ui, sans-serif`;
      const above = { top: clamp(h * 0.03, 6, 22), bot: card.y - 14 };
      const below = { top: card.y + card.height + 18, bot: h - (phone ? 170 : 110) };
      const bands = phone ? [below, above] : [above, below];
      const band = bands.find((b) => b.bot - b.top >= 60) ?? bands.reduce((a, b) => (b.bot - b.top > a.bot - a.top ? b : a));
      const room = band.bot - band.top;
      let size = Math.min(phone ? 60 : 104, room * 0.62);
      const text = Array.from(name).slice(0, MAX_LETTERS);
      const m = setup.createLayer(8, 8, 1).ctx;
      const measure = (s: string) => m.measureText(s).width;
      if (size >= 10) {
        m.font = fontT(size);
        const width = measure(text.join(''));
        const maxW = w - (phone ? 36 : 120);
        if (width > maxW) size *= maxW / width;
      }
      if (size >= 10) {
        fs = Math.round(size);
        font = fontT(fs);
        m.font = font;
        const metrics = m.measureText('Hg');
        const asc = (metrics.fontBoundingBoxAscent as number | undefined) || fs * 0.92;
        const desc = (metrics.fontBoundingBoxDescent as number | undefined) || fs * 0.24;
        base = (fs + asc - desc) / 2;
        const spacing = -size * 0.012;
        const adv = text.map((_, i) => measure(text.slice(0, i + 1).join('')) - measure(text.slice(0, i).join('')));
        const total = adv.reduce((sum, a, i) => sum + a + (i < text.length - 1 ? spacing : 0), 0);
        const y0 = band.top + (room - size) / 2;
        let x = (w - total) / 2;
        text.forEach((ch, i) => {
          if (ch.trim() !== '') {
            chars.push(ch);
            hx.push(x);
            hy.push(y0);
            lw.push(adv[i] as number);
          }
          x += (adv[i] as number) + spacing;
        });
      }
    }
    const letters = chars.length;
    const lhx = new Float64Array(hx);
    const lhy = new Float64Array(hy);
    const lwid = new Float64Array(lw);
    const lx = new Float64Array(hx);
    const ly = new Float64Array(hy);
    const lvx = new Float64Array(letters);
    const lvy = new Float64Array(letters);
    const lrot = new Float64Array(letters);
    const lvrot = new Float64Array(letters);
    const state = new Uint8Array(letters);
    const resting = new Uint8Array(letters);
    let away = 0;
    let magnetSince = 0;
    let acc = 0;
    let lastPX = 0;
    let lastPY = 0;
    let hadPointer = false;
    // Letters fall only where there's room for the magnet that brings them back.
    const canFall = !Number.isNaN(magnetX);
    const floor = h - YK.FLOOR_OFFSET;
    const step = 1 / 60;

    /** One 60 Hz step of the original's physics; returns how many letters are still moving. */
    function physics(): number {
      if (away === 0) return 0;
      let moving = 0;
      for (let f = 0; f < letters; f++) {
        const s = state[f] as number;
        if (s === HOME) continue;
        if (resting[f] && s !== RETURN) continue;
        if (s === RETURN) {
          const dx = (lhx[f] as number) - (lx[f] as number);
          const dy = (lhy[f] as number) - (ly[f] as number);
          lvx[f] = ((lvx[f] as number) + dx * YK.SPRING_STIFFNESS) * YK.SPRING_DAMPING;
          lvy[f] = ((lvy[f] as number) + dy * YK.SPRING_STIFFNESS) * YK.SPRING_DAMPING;
          lx[f] = (lx[f] as number) + (lvx[f] as number);
          ly[f] = (ly[f] as number) + (lvy[f] as number);
          lrot[f] = (lrot[f] as number) * 0.86;
          if (Math.abs(dx) < YK.RETURN_SNAP_DIST && Math.abs(dy) < YK.RETURN_SNAP_DIST && Math.abs(lvx[f] as number) < YK.RETURN_SNAP_VEL && Math.abs(lvy[f] as number) < YK.RETURN_SNAP_VEL) {
            state[f] = HOME;
            lx[f] = lhx[f] as number;
            ly[f] = lhy[f] as number;
            lrot[f] = 0;
            away--;
          } else moving++;
        } else {
          let rests = 0;
          lvy[f] = (lvy[f] as number) + YK.GRAVITY;
          lx[f] = (lx[f] as number) + (lvx[f] as number);
          ly[f] = (ly[f] as number) + (lvy[f] as number);
          lrot[f] = (lrot[f] as number) + (lvrot[f] as number);
          if ((ly[f] as number) + fs >= floor) {
            ly[f] = floor - fs;
            if (Math.abs(lvy[f] as number) < 1.5) {
              lvy[f] = 0;
              lvx[f] = (lvx[f] as number) * 0.7;
              lvrot[f] = (lvrot[f] as number) * 0.5;
              if (Math.abs(lvx[f] as number) < 0.1) {
                rests = 1;
                lvrot[f] = 0;
              }
            } else {
              lvy[f] = -(lvy[f] as number) * YK.FLOOR_BOUNCE;
              lvx[f] = (lvx[f] as number) * YK.FRICTION;
              lvrot[f] = (lvrot[f] as number) * YK.FRICTION;
            }
          }
          if ((lx[f] as number) < 0) {
            lx[f] = 0;
            lvx[f] = -(lvx[f] as number) * 0.5;
          } else if ((lx[f] as number) + fs > w) {
            lx[f] = w - fs;
            lvx[f] = -(lvx[f] as number) * 0.5;
          }
          resting[f] = rests;
          if (!rests) moving++;
        }
      }
      // Letters knock into each other (equal masses: every letter is the title's size).
      const radius = fs * 0.4;
      for (let a = 0; a < letters; a++) {
        if (state[a] !== FALL) continue;
        for (let b = a + 1; b < letters; b++) {
          if (state[b] !== FALL) continue;
          const dx = (lx[b] as number) - (lx[a] as number);
          const dy = (ly[b] as number) - (ly[a] as number);
          const dist = Math.sqrt(dx * dx + dy * dy);
          const minDist = radius * 2;
          if (dist > 0.001 && dist < minDist) {
            const nx = dx / dist;
            const ny = dy / dist;
            const half = (minDist - dist) / 2;
            lx[a] = (lx[a] as number) - nx * half;
            ly[a] = (ly[a] as number) - ny * half;
            lx[b] = (lx[b] as number) + nx * half;
            ly[b] = (ly[b] as number) + ny * half;
            const rvn = ((lvx[b] as number) - (lvx[a] as number)) * nx + ((lvy[b] as number) - (lvy[a] as number)) * ny;
            if (rvn < 0) {
              const j = (-(1 + YK.COLLISION_RESTITUTION) * rvn) / 2;
              lvx[a] = (lvx[a] as number) - nx * j;
              lvy[a] = (lvy[a] as number) - ny * j;
              lvx[b] = (lvx[b] as number) + nx * j;
              lvy[b] = (lvy[b] as number) + ny * j;
              lvrot[a] = (lvrot[a] as number) + (play.next() - 0.5) * 0.03;
              lvrot[b] = (lvrot[b] as number) + (play.next() - 0.5) * 0.03;
              resting[a] = 0;
              resting[b] = 0;
            }
          }
        }
      }
      // A moving pointer shoves the letters it meets and lends them some of its speed.
      const cs = Math.sqrt(cursorVX * cursorVX + cursorVY * cursorVY);
      if (cs > 0.3) {
        for (let a = 0; a < letters; a++) {
          if (state[a] !== FALL) continue;
          const dx = (lx[a] as number) + fs / 2 - cursorX;
          const dy = (ly[a] as number) + fs / 2 - cursorY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const minDist = radius + YK.CURSOR_RADIUS_PUSH;
          if (dist < minDist && dist > 0.001) {
            const o = minDist - dist;
            lx[a] = (lx[a] as number) + (dx / dist) * o;
            ly[a] = (ly[a] as number) + (dy / dist) * o;
            lvx[a] = (lvx[a] as number) + cursorVX * YK.CURSOR_VELOCITY_TRANSFER;
            lvy[a] = (lvy[a] as number) + cursorVY * YK.CURSOR_VELOCITY_TRANSFER;
            lvrot[a] = (lvrot[a] as number) + (play.next() - 0.5) * 0.04 * Math.min(cs, 20);
            resting[a] = 0;
          }
        }
      }
      cursorVX *= YK.CURSOR_VELOCITY_DECAY;
      cursorVY *= YK.CURSOR_VELOCITY_DECAY;
      return moving;
    }

    function drawFilings(ctx: Ctx2D, k: number): void {
      counts.fill(0);
      for (let i = 0; i < n; i++) {
        const fade = ff[i] as number;
        if (fade === 0) {
          bucket[i] = NO_BUCKET;
          continue;
        }
        const target = targetOf(i);
        const inf = influence;
        if (k) fc[i] = (fc[i] as number) + angleDelta(fc[i] as number, target) * k;
        const half = (fl[i] as number) / 2 + inf * 4;
        ca[i] = Math.cos(fc[i] as number) * half;
        sa[i] = Math.sin(fc[i] as number) * half;
        const q = Math.min(NB - 1, Math.round(inf * (NB - 1))) * FB + Math.max(0, Math.ceil(fade * FB) - 1);
        bucket[i] = q;
        counts[q] = (counts[q] as number) + 1;
      }
      let total = 0;
      for (let q = 0; q < BUCKETS; q++) {
        starts[q] = total;
        total += counts[q] as number;
      }
      counts.fill(0);
      for (let i = 0; i < n; i++) {
        const q = bucket[i] as number;
        if (q === NO_BUCKET) continue;
        order[(starts[q] as number) + (counts[q] as number)] = i;
        counts[q] = (counts[q] as number) + 1;
      }
      ctx.lineCap = 'round';
      for (let q = 0; q < BUCKETS; q++) {
        const count = counts[q] as number;
        if (count === 0) continue;
        ctx.lineWidth = c.widths[q] as number;
        ctx.strokeStyle = c.strokes[q] as string;
        ctx.beginPath();
        const s = starts[q] as number;
        for (let e = 0; e < count; e++) {
          const i = order[s + e] as number;
          const x = fx[i] as number;
          const y = fy[i] as number;
          ctx.moveTo(x - (ca[i] as number), y - (sa[i] as number));
          ctx.lineTo(x + (ca[i] as number), y + (sa[i] as number));
        }
        ctx.stroke();
      }
    }

    function drawMagnet(ctx: Ctx2D, t: number, hover: boolean): void {
      const age = t - magnetSince;
      let scale = 1;
      let turn = 0;
      let alpha = 1;
      let pulse = 0;
      if (age < POP_IN) {
        // magnet-pop-in: 0% scale .4 rotate -30° transparent; 60% 1.15, 8°; 80% .95, -3°; 100% 1, 0°.
        const u = age / POP_IN;
        if (u < 0.6) {
          const e = overshoot(u / 0.6);
          scale = 0.4 + 0.75 * e;
          turn = (-30 + 38 * e) * (Math.PI / 180);
          alpha = clamp(e, 0, 1);
        } else if (u < 0.8) {
          const e = overshoot((u - 0.6) / 0.2);
          scale = 1.15 - 0.2 * e;
          turn = (8 - 11 * e) * (Math.PI / 180);
        } else {
          const e = overshoot((u - 0.8) / 0.2);
          scale = 0.95 + 0.05 * e;
          turn = (-3 + 3 * e) * (Math.PI / 180);
        }
      } else {
        // magnet-pulse: the glow swells and a ring spreads 12 px and fades, every 2.4 s.
        const phase = ((age - POP_IN) % PULSE) / PULSE;
        pulse = 0.5 - 0.5 * Math.cos(phase * TAU);
      }
      if (hover) scale *= 1.1;
      const level = Math.round(pulse * (PULSE_LEVELS - 1));
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(magnetX, magnetY);
      ctx.scale(scale, scale);
      if (pulse > 0.01) {
        ctx.fillStyle = c.rings[level] as string;
        ctx.beginPath();
        ctx.arc(0, 0, MAGNET_R + 12 * pulse, 0, TAU);
        ctx.fill();
      }
      // Canvas shadows ignore the transform: scale them by the backing ratio and the button's scale.
      ctx.shadowColor = c.shadows[level] as string;
      ctx.shadowBlur = (30 + 10 * pulse) * pixelRatio * scale;
      ctx.shadowOffsetY = (10 + 4 * pulse) * pixelRatio * scale;
      ctx.fillStyle = hover ? c.magnetHover : c.magnet;
      ctx.beginPath();
      ctx.arc(0, 0, MAGNET_R, 0, TAU);
      ctx.fill();
      ctx.shadowColor = c.clear;
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      ctx.rotate(turn);
      ctx.scale(28 / 24, 28 / 24);
      ctx.translate(-12, -12);
      ctx.strokeStyle = c.icon;
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(6, 15);
      ctx.lineTo(2, 11);
      ctx.lineTo(8.75, 4.23);
      ctx.arc(ICON_ARC_OUTER[0] as number, ICON_ARC_OUTER[1] as number, 7.79, ICON_ARC_OUTER[2] as number, ICON_ARC_OUTER[3] as number, ICON_ARC_OUTER[4] === 1);
      ctx.lineTo(13, 22);
      ctx.lineTo(9, 18);
      ctx.lineTo(15.39, 11.64);
      ctx.arc(ICON_ARC_INNER[0] as number, ICON_ARC_INNER[1] as number, 2.14, ICON_ARC_INNER[2] as number, ICON_ARC_INNER[3] as number, ICON_ARC_INNER[4] === 1);
      ctx.lineTo(6, 15);
      ctx.moveTo(5, 8);
      ctx.lineTo(9, 12);
      ctx.moveTo(12, 15);
      ctx.lineTo(16, 19);
      ctx.stroke();
      ctx.restore();
    }

    return {
      draw(ctx, frame) {
        const dt = motion ? frame.dt : 0;
        const p = frame.pointer;
        const present = motion && p.strength > 0.5;
        const overMagnet = present && away > 0 && (p.x - magnetX) * (p.x - magnetX) + (p.y - magnetY) * (p.y - magnetY) <= MAGNET_R * MAGNET_R;
        if (present && !overMagnet) {
          // The swirl follows the pointer; its speed (px per 16 ms, blended) knocks fallen letters about.
          if (hadPointer && dt > 0) {
            cursorVX = cursorVX * 0.5 + ((p.x - lastPX) / (dt * 1000)) * 16 * 0.5;
            cursorVY = cursorVY * 0.5 + ((p.y - lastPY) / (dt * 1000)) * 16 * 0.5;
          }
          cursorX = p.x;
          cursorY = p.y;
        }
        hadPointer = present;
        lastPX = p.x;
        lastPY = p.y;
        if (dt > 0) {
          // A letter detaches when the pointer enters its box (never from over the card).
          const overCard = p.x >= card.x && p.x <= card.x + card.width && p.y >= card.y && p.y <= card.y + card.height;
          if (canFall && present && !overMagnet && !overCard) {
            for (let f = 0; f < letters; f++) {
              if (state[f] !== HOME) continue;
              const x0 = lhx[f] as number;
              const y0 = lhy[f] as number;
              if (p.x >= x0 && p.x <= x0 + (lwid[f] as number) && p.y >= y0 && p.y <= y0 + fs) {
                if (away === 0) magnetSince = frame.t;
                state[f] = FALL;
                lx[f] = x0;
                ly[f] = y0;
                lvx[f] = (play.next() - 0.5) * 2;
                lvy[f] = 0.2 + play.next() * 0.4;
                lrot[f] = 0;
                lvrot[f] = (play.next() - 0.5) * 0.08;
                resting[f] = 0;
                away++;
              }
            }
          }
          acc = Math.min(acc + dt, 0.1);
          let moving = 0;
          while (acc >= step) {
            moving = physics();
            acc -= step;
          }
          // Letters in the air or springing home: keep frames coming even once the pointer has gone.
          if (moving > 0) setup.invalidate(500);
        }
        ctx.fillStyle = c.ground;
        ctx.fillRect(0, 0, w, h);
        drawFilings(ctx, dt > 0 ? 1 - Math.pow(1 - 0.18, dt * 60) : 0);
        if (letters > 0) {
          ctx.font = font;
          ctx.fillStyle = c.title;
          ctx.textBaseline = 'alphabetic';
          for (let f = 0; f < letters; f++) {
            if (state[f] === HOME) {
              ctx.fillText(chars[f] as string, lhx[f] as number, (lhy[f] as number) + base);
              continue;
            }
            const half = (lwid[f] as number) / 2;
            ctx.save();
            ctx.translate((lx[f] as number) + half, (ly[f] as number) + fs / 2);
            ctx.rotate(lrot[f] as number);
            ctx.fillText(chars[f] as string, -half, base - fs / 2);
            ctx.restore();
          }
        }
        if (away > 0) drawMagnet(ctx, frame.t, overMagnet);
      },
      tap(x, y) {
        // The magnet: every fallen letter springs home.
        if (away === 0 || (x - magnetX) * (x - magnetX) + (y - magnetY) * (y - magnetY) > MAGNET_HIT * MAGNET_HIT) return;
        for (let f = 0; f < letters; f++) {
          if (state[f] === HOME) continue;
          state[f] = RETURN;
          resting[f] = 0;
          lvx[f] = (lvx[f] as number) * 0.3;
          lvy[f] = -2 - play.next() * 2;
        }
        setup.invalidate(4000);
      },
      hot: [physics, drawFilings, drawMagnet, targetOf, angleDelta],
    };
  },
});
