/**
 * ai-survey-dots v1. FROZEN once released (ADR 0021): add v2.ts for any change to what it draws.
 *
 * A faithful port of the dot field behind the NC GenAI Survey's gate, decline, submitted, and
 * class-code screens (ai-survey-nc app/survey/components/DotField.js, David Yokum's own project), on
 * the survey's off-white page. The port follows the Backdrop Lab's (passwords-flow
 * design/backdrop-lab/styles/ai-survey-dots.js). pulse-dots v1 is the same field on Pulse's white page.
 *
 * A quiet 48 px grid of faint gray dots. Within 120 px of the pointer the dots ease away from it,
 * grow a little, and warm to the accent blue; they glide home when it leaves. Nothing moves on its
 * own, so the field holds still (`settlesAt`) unless the pointer moves it.
 *
 * Source map (ai-survey-nc DotField.js):
 *   L27-41   grid: spacing 48, Math.ceil cols and rows, first dot at spacing / 2
 *   L51-65   influence 120 px; target = home + unit(home - pointer) × (1 - d / 120) × 18
 *   L67-68   position eases 8% of the gap per frame (here the same curve at 60 Hz, scaled by dt)
 *   L70-72   proximity from the HOME position; alpha 0.18 + 0.5p; radius 1.5 + 0.7p
 *   L74-81   color lerps gray 180 to rgb(37, 99, 235) (#2563eb, --color-accent) by proximity
 *   L94-97   pointer leaves: parked at (-1000, -1000), every dot drifts home
 *
 * The page:
 *   survey.module.css L8-11 `.surveyPage` background var(--color-bg-subtle) = #f8f9fa (globals.css L35).
 *   The canvas sat in an absolute, inset-0, pointer-events-none wrapper at full opacity beneath the
 *   content (SurveyShell.js L1137-1139, L1354, L1440; ClassAccessForm.js L13-15).
 *
 * Kit mapping (documented choices):
 * - Family. The surveys are NC OSBM's, so the OSBM palette renders the source exactly. The kit's setup
 *   has no family, so OSBM is recognized by its brand colors (primary, secondary, and ink, copied
 *   below as they were when this version was frozen, so a later brand edit can't redraw it). Any other
 *   light palette keeps the source's page and nudges the dots toward its own colors, as the lab does:
 *   rest gray 35% toward a muted gray (OKLab mist → ink at 0.27, which lands on the lab's UNC and
 *   personal muted grays), hot blue 60% toward the palette's primary (the lab's accent).
 * - Dark pages (relative luminance under 0.3) get the lab's dark treatment: the palette's page, dots
 *   40% toward whichever of ink, glow, and mist contrasts most with it (alpha 0.11), and the accent
 *   55% (OSBM) or 85% toward whichever of secondary and primary contrasts most (gain 0.55).
 * - Pointer. The renderer eases the pointer's presence (`strength`) where the source switched it on
 *   and off, so strength scales the response; at full strength it is the source's exactly.
 * - Seed: spacing (mostly 48), the grid's phase, and a tiny per-dot jitter, as in the lab.
 */
import { contrastRatio, mix, over, relativeLuminance, rgba, type Rgb } from '../../kernel/v1/color.js';
import { createRng, hashParts } from '../../kernel/v1/prng.js';
import { TAU } from '../../kernel/v1/shape.js';
import { defineVersion, type StyleInstance, type StyleSetup } from '../define.js';

type BackdropPalette = StyleSetup['palette'];

/** Source constants (DotField.js). */
const SRC = {
  influence: 120,
  push: 18,
  /** Per 60 Hz frame. */
  ease: 0.08,
  alpha: 0.18,
  alphaGain: 0.5,
  radius: 1.5,
  radiusGain: 0.7,
  rest: [180, 180, 180] as Rgb,
  hot: [37, 99, 235] as Rgb,
} as const;

/** The NC OSBM family's brand colors when this version was frozen (families.ts, v0.1.8). */
const OSBM_BRAND = { primary: '#1e79c8', secondary: '#3892e1', ink: '#092940' } as const;

/** Proximity quantized for the style lookup (within 1/255 per channel of the source). */
const LEVELS = 128;

interface SurveyDotsColors {
  readonly ground: string;
  /** `LEVELS` fill styles, rest (0) to hot (LEVELS - 1). */
  readonly styles: readonly string[];
}

function isOsbm(p: BackdropPalette): boolean {
  return p.primary.toLowerCase() === OSBM_BRAND.primary && p.secondary.toLowerCase() === OSBM_BRAND.secondary && p.ink.toLowerCase() === OSBM_BRAND.ink;
}

function mostContrasting(against: string, options: readonly string[]): string {
  let best = options[0] as string;
  for (const c of options) if (contrastRatio(c, against) > contrastRatio(best, against)) best = c;
  return best;
}

/** The palette mapping. `sourceGround` is the survey's own page. */
function surveyDotsColors(p: BackdropPalette, sourceGround: string): SurveyDotsColors {
  const home = isOsbm(p);
  const dark = relativeLuminance(p.page) < 0.3;
  let ground: string;
  let rest: Rgb;
  let hot: Rgb;
  let restA: number;
  let gainA: number;
  if (!dark) {
    ground = sourceGround;
    rest = home ? SRC.rest : over(mix(p.mist, p.ink, 0.27), 0.35, SRC.rest);
    hot = home ? SRC.hot : over(p.primary, 0.6, SRC.hot);
    restA = SRC.alpha;
    gainA = SRC.alphaGain;
  } else {
    ground = p.page;
    rest = over(mostContrasting(p.page, [p.ink, p.glow, p.mist]), 0.4, SRC.rest);
    hot = over(mostContrasting(p.page, [p.secondary, p.primary]), home ? 0.55 : 0.85, SRC.hot);
    restA = 0.11;
    gainA = 0.55;
  }
  const styles: string[] = [];
  for (let level = 0; level < LEVELS; level++) {
    const t = level / (LEVELS - 1);
    styles.push(rgba(over(hot, t, rest), restA + t * gainA));
  }
  return { ground, styles };
}

/** The dot field. `id` salts the seed. */
function createSurveyDots(id: string, setup: StyleSetup, c: SurveyDotsColors): StyleInstance {
  const { width: w, height: h } = setup;
  const rng = createRng(hashParts(id, 1, setup.seed));
  const spacing = rng.pick([48, 48, 48, 44, 52, 42, 56]);
  const phaseX = 0.5 + (rng.next() - 0.5) * 0.5;
  const phaseY = 0.5 + (rng.next() - 0.5) * 0.5;
  const jitter = rng.pick([0, 0, 1.5, 2.5, 3.5]);
  const seedLayout = (rng.next() * 4294967296) >>> 0;
  // Per-cell hash (the lab's), so every surviving dot keeps its jitter across a resize.
  const cellRand = (col: number, row: number, k: number): number => {
    let hash = (seedLayout ^ Math.imul(col + 0x9e37, 0x85ebca6b) ^ Math.imul(row + 0x632b, 0xc2b2ae35) ^ Math.imul(k + 1, 0x27d4eb2f)) | 0;
    hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d);
    hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b);
    hash ^= hash >>> 16;
    return (hash >>> 0) / 4294967296;
  };

  const ox = spacing * phaseX;
  const oy = spacing * phaseY;
  const cols = Math.max(1, Math.ceil((w - ox) / spacing));
  const rows = Math.max(1, Math.ceil((h - oy) / spacing));
  const n = cols * rows;
  const hx = new Float32Array(n);
  const hy = new Float32Array(n);
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const level = new Uint8Array(n);
  const hotList = new Int32Array(n);
  let i = 0;
  for (let r = 0; r < rows; r++) {
    for (let col = 0; col < cols; col++, i++) {
      const jx = jitter ? (cellRand(col, r, 0) * 2 - 1) * jitter : 0;
      const jy = jitter ? (cellRand(col, r, 1) * 2 - 1) * jitter : 0;
      hx[i] = x[i] = ox + col * spacing + jx;
      hy[i] = y[i] = oy + r * spacing + jy;
    }
  }

  const radius = new Float32Array(LEVELS);
  for (let l = 0; l < LEVELS; l++) radius[l] = SRC.radius + (l / (LEVELS - 1)) * SRC.radiusGain;
  const r0 = radius[0] as number;
  const restStyle = c.styles[0] as string;
  const reach = SRC.influence;
  const reach2 = reach * reach;
  const motion = setup.motion;

  return {
    draw(ctx, frame) {
      let hot = 0;
      if (motion) {
        const px = frame.pointer.x;
        const py = frame.pointer.y;
        const strength = frame.pointer.strength > 0.001 ? frame.pointer.strength : 0;
        const k = 1 - Math.pow(1 - SRC.ease, frame.dt * 60);
        let drift = 0;
        for (let d = 0; d < n; d++) {
          const homeX = hx[d] as number;
          const homeY = hy[d] as number;
          let tx = homeX;
          let ty = homeY;
          let l = 0;
          if (strength > 0) {
            const dx = homeX - px;
            const dy = homeY - py;
            if (dx > -reach && dx < reach && dy > -reach && dy < reach) {
              const d2 = dx * dx + dy * dy;
              if (d2 < reach2 && d2 > 0) {
                const dist = Math.sqrt(d2);
                const prox = (1 - dist / reach) * strength;
                const f = (prox * SRC.push) / dist;
                tx = homeX + dx * f;
                ty = homeY + dy * f;
                l = (prox * (LEVELS - 1) + 0.5) | 0;
              }
            }
          }
          const nx = (x[d] as number) + (tx - (x[d] as number)) * k;
          const ny = (y[d] as number) + (ty - (y[d] as number)) * k;
          x[d] = nx;
          y[d] = ny;
          drift += Math.abs(nx - homeX) + Math.abs(ny - homeY);
          level[d] = l;
          if (l) hotList[hot++] = d;
        }
        // Still gliding home after the pointer left: keep frames coming until the field is at rest.
        if (frame.dt > 0 && drift > 0.05) setup.invalidate(250);
      }
      ctx.fillStyle = c.ground;
      ctx.fillRect(0, 0, w, h);
      // Resting dots share one style: one path, one fill.
      ctx.beginPath();
      for (let d = 0; d < n; d++) {
        if (level[d]) continue;
        const dx = x[d] as number;
        const dy = y[d] as number;
        ctx.moveTo(dx + r0, dy);
        ctx.arc(dx, dy, r0, 0, TAU);
      }
      ctx.fillStyle = restStyle;
      ctx.fill();
      // The few dots inside the pointer's reach, each in its own shade.
      for (let j = 0; j < hot; j++) {
        const d = hotList[j] as number;
        const l = level[d] as number;
        ctx.beginPath();
        ctx.arc(x[d] as number, y[d] as number, radius[l] as number, 0, TAU);
        ctx.fillStyle = c.styles[l] as string;
        ctx.fill();
      }
    },
  };
}

export const aiSurveyDotsV1 = defineVersion({
  version: 1,
  fps: 30,
  maxPixelRatio: 2,
  stillTime: 2,
  settlesAt: 1,
  colors: (p) => surveyDotsColors(p, '#f8f9fa'),
  create: (setup, c) => createSurveyDots('ai-survey-dots', setup, c),
});
