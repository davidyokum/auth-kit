/**
 * `cardContrast`: proves a family's card is readable and the backdrop is muted where the card sits.
 *
 * The card is opaque, so the backdrop never shows through its text. What's checked:
 * - the card's own pairs against WCAG 2.2 AA: heading, body, and link text on the card (4.5:1),
 *   button text on the button (4.5:1), and the focus ring against the card (3:1, non-text);
 * - the scrim: the worst case of any palette color drawn at full strength under the card, after the
 *   scrim covers it with the page color at `SCRIM.alpha`, against the page itself. Kept at or under
 *   1.2:1, the backdrop is a faint tint there, never a pattern competing with the card.
 */
import { contrastRatio, over, toHex } from './kernel/v1/color.js';
import { BACKDROP_FAMILIES } from './families.js';
import { SCRIM } from './scrim.js';
import type { BackdropCardTheme, BackdropFamily, BackdropPalette } from './types.js';

export interface ContrastCheck {
  id: 'heading' | 'body' | 'link' | 'button' | 'focus';
  label: string;
  foreground: string;
  background: string;
  ratio: number;
  minimum: number;
  pass: boolean;
}

export interface ScrimCheck {
  /** Page-color coverage under the card. */
  alpha: number;
  /** The palette color that shows most under the card, and what it becomes there. */
  worstColor: string;
  worstComposite: string;
  /** Its contrast with the page. */
  ratio: number;
  maximum: number;
  pass: boolean;
}

export interface CardContrastReport {
  family: BackdropFamily | null;
  ok: boolean;
  checks: ContrastCheck[];
  scrim: ScrimCheck;
}

/** The muted limit: what's left of the art under the card, against the page. */
export const SCRIM_MAX_RATIO = 1.2;

function check(id: ContrastCheck['id'], label: string, foreground: string, background: string, minimum: number): ContrastCheck {
  const ratio = contrastRatio(foreground, background);
  return { id, label, foreground, background, ratio: Math.round(ratio * 100) / 100, minimum, pass: ratio >= minimum };
}

export function cardContrast(family: BackdropFamily | { palette: BackdropPalette; card: BackdropCardTheme }): CardContrastReport {
  const colors = typeof family === 'string' ? BACKDROP_FAMILIES[family] : family;
  if (!colors) throw new Error(`auth-kit/backdrops: family "${String(family)}" isn't osbm, unc, or personal.`);
  const { palette, card } = colors;
  const checks = [
    check('heading', 'Heading on the card', card.heading, card.surface, 4.5),
    check('body', 'Body text on the card', card.body, card.surface, 4.5),
    check('link', 'Links on the card', card.link, card.surface, 4.5),
    check('button', 'Button text on the button', card.buttonText, card.button, 4.5),
    check('focus', 'Focus ring against the card', card.focus, card.surface, 3),
  ];
  let worst = { color: palette.ink, composite: palette.page, ratio: 1 };
  for (const color of [palette.ink, palette.primary, palette.secondary, palette.glow, palette.mist]) {
    const composite = toHex(over(palette.page, SCRIM.alpha, color));
    const ratio = contrastRatio(composite, palette.page);
    if (ratio > worst.ratio) worst = { color, composite, ratio };
  }
  const scrim: ScrimCheck = {
    alpha: SCRIM.alpha,
    worstColor: worst.color,
    worstComposite: worst.composite,
    ratio: Math.round(worst.ratio * 1000) / 1000,
    maximum: SCRIM_MAX_RATIO,
    pass: worst.ratio <= SCRIM_MAX_RATIO,
  };
  return { family: typeof family === 'string' ? family : null, ok: checks.every((c) => c.pass) && scrim.pass, checks, scrim };
}
