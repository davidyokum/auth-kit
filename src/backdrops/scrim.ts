/**
 * The scrim: a soft halo of the page color around the card, drawn over every style's art, so the
 * backdrop is muted where the card sits and the card reads as solid ground. It's part of the card's
 * contract, not of a style, so it applies to every style and version alike (ADR 0020).
 *
 * The alpha is a pure function of position (a rounded rectangle's signed distance, eased), so the
 * guarantee is testable: inside the card and a margin around it the page color covers the art at
 * `SCRIM.alpha`, and `cardContrast` proves what that leaves visible.
 */
import { parseHex } from './kernel/v1/color.js';
import type { Ctx2D, Layer } from './styles/define.js';
import type { BackdropRect } from './types.js';

export const SCRIM = Object.freeze({
  /** Page-color coverage over the card and its margin. */
  alpha: 0.94,
  /** The margin beyond the card's edges that's fully covered, in CSS pixels. */
  margin: 20,
  /** Corner radius of the covered shape. */
  radius: 18,
  /** How far the fade-out reaches beyond the margin: this fraction of the shorter viewport side... */
  featherFraction: 0.15,
  /** ...kept within these bounds (CSS pixels). */
  featherMin: 64,
  featherMax: 160,
  /** The layer is computed at this fraction of CSS resolution and drawn enlarged (it's smooth). */
  layerScale: 0.25,
});

/** The fade distance for a viewport. */
export function scrimFeather(width: number, height: number): number {
  return Math.min(SCRIM.featherMax, Math.max(SCRIM.featherMin, Math.min(width, height) * SCRIM.featherFraction));
}

/** The scrim's alpha at a point: `SCRIM.alpha` over the card and margin, easing to 0 over `feather`. */
export function scrimAlpha(x: number, y: number, card: BackdropRect, feather: number): number {
  const r = SCRIM.radius;
  const hx = card.width / 2 + SCRIM.margin - r;
  const hy = card.height / 2 + SCRIM.margin - r;
  const qx = Math.abs(x - (card.x + card.width / 2)) - hx;
  const qy = Math.abs(y - (card.y + card.height / 2)) - hy;
  const ox = qx > 0 ? qx : 0;
  const oy = qy > 0 ? qy : 0;
  const distance = Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - r;
  if (distance <= 0) return SCRIM.alpha;
  if (distance >= feather) return 0;
  const s = 1 - distance / feather;
  return SCRIM.alpha * s * s * (3 - 2 * s);
}

/** The card's default place when none is given: centered, 440px wide (less on phones), up to 560px tall. */
export function defaultCardRect(width: number, height: number): BackdropRect {
  const w = Math.min(440, Math.max(0, width - 32));
  const h = Math.min(560, Math.max(0, height - 64));
  return { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h };
}

/** Paints the scrim into `layer` (sized like the backdrop, at `SCRIM.layerScale`). Call when the card moves. */
export function paintScrim(layer: Layer, card: BackdropRect, page: string): void {
  // putImageData writes backing pixels and ignores the context's scale.
  const cols = layer.canvas.width;
  const rows = layer.canvas.height;
  const image = layer.ctx.createImageData(cols, rows);
  const data = image.data;
  const [r, g, b] = parseHex(page);
  const feather = scrimFeather(layer.width, layer.height);
  const sx = layer.width / cols;
  const sy = layer.height / rows;
  let o = 0;
  for (let j = 0; j < rows; j++) {
    const y = (j + 0.5) * sy;
    for (let i = 0; i < cols; i++) {
      const a = scrimAlpha((i + 0.5) * sx, y, card, feather);
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = Math.round(a * 255);
      o += 4;
    }
  }
  layer.ctx.putImageData(image, 0, 0);
}

/** Draws the painted scrim layer over the art. */
export function drawScrim(ctx: Ctx2D, layer: Layer): void {
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(layer.canvas, 0, 0, layer.width, layer.height);
}
