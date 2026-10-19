/**
 * Where the card sits. Styles use it to keep their focal points (ripple sources, bloom centers)
 * where they can be seen, and the renderer uses it to keep taps on the card from reaching a style.
 *
 * The backdrop is never faded, vignetted, or scrimmed around the card: it stays fully present, and
 * the card carries its own contrast (a solid surface, a crisp border, a soft shadow; `cardContrast`).
 */
import type { BackdropRect } from './types.js';

/** The card's width, as `SignIn` draws it (register E5: 380px; the `--ak-card-width` default). */
export const CARD_WIDTH = 380;

/** The card's default place when none is given: centered, 380px wide (less on phones), up to 560px tall. */
export function defaultCardRect(width: number, height: number): BackdropRect {
  const w = Math.min(CARD_WIDTH, Math.max(0, width - 32));
  const h = Math.min(560, Math.max(0, height - 64));
  return { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h };
}
