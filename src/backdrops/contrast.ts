/**
 * `cardContrast`: proves a family's card is readable and stands apart from its backdrop.
 *
 * The backdrop is never faded around the card (David's direction: a scrim or vignette looks odd); the
 * card carries its own contrast instead. It's opaque, so the art never shows through its text, and it
 * has a crisp 1px border and a soft shadow. What's checked:
 * - the card's own pairs against WCAG 2.2 AA: heading, body, and link text on the card (4.5:1),
 *   button text on the button (4.5:1), and the focus ring against the card (3:1, non-text);
 * - the card's edge against every color its family's backdrops paint with (page, mist, glow, primary,
 *   secondary, ink): the border or the surface must reach 3:1 against each (WCAG 1.4.11, non-text),
 *   so the card's outline is clear wherever it lands on the art.
 */
import { contrastRatio } from './kernel/v1/color.js';
import { BACKDROP_FAMILIES } from './families.js';
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

export interface EdgeCheck {
  /** The backdrop color the card's edge sits on. */
  color: keyof BackdropPalette;
  value: string;
  /** The border's contrast with it, and the surface's; the edge shows if either reaches the minimum. */
  border: number;
  surface: number;
  minimum: number;
  pass: boolean;
}

export interface CardContrastReport {
  family: BackdropFamily | null;
  ok: boolean;
  checks: ContrastCheck[];
  edge: EdgeCheck[];
}

/** The card's edge against any backdrop color: WCAG 1.4.11's 3:1 for the boundary of a component. */
export const CARD_EDGE_MINIMUM = 3;

const round = (n: number) => Math.round(n * 100) / 100;

function check(id: ContrastCheck['id'], label: string, foreground: string, background: string, minimum: number): ContrastCheck {
  const ratio = contrastRatio(foreground, background);
  return { id, label, foreground, background, ratio: round(ratio), minimum, pass: ratio >= minimum };
}

export function cardContrast(family: BackdropFamily | { palette: BackdropPalette; card: BackdropCardTheme }): CardContrastReport {
  const colors = typeof family === 'string' ? BACKDROP_FAMILIES[family] : family;
  if (!colors) throw new Error(`auth-kit/backdrops: family ${JSON.stringify(family)} isn't osbm, unc, or personal.`);
  const { palette, card } = colors;
  const checks = [
    check('heading', 'Heading on the card', card.heading, card.surface, 4.5),
    check('body', 'Body text on the card', card.body, card.surface, 4.5),
    check('link', 'Links on the card', card.link, card.surface, 4.5),
    check('button', 'Button text on the button', card.buttonText, card.button, 4.5),
    check('focus', 'Focus ring against the card', card.focus, card.surface, 3),
  ];
  const edge = (Object.keys(palette) as (keyof BackdropPalette)[]).map((key): EdgeCheck => {
    const border = contrastRatio(card.border, palette[key]);
    const surface = contrastRatio(card.surface, palette[key]);
    return { color: key, value: palette[key], border: round(border), surface: round(surface), minimum: CARD_EDGE_MINIMUM, pass: Math.max(border, surface) >= CARD_EDGE_MINIMUM };
  });
  return { family: typeof family === 'string' ? family : null, ok: checks.every((c) => c.pass) && edge.every((e) => e.pass), checks, edge };
}
