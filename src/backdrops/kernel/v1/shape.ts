/**
 * Backdrop kernel v1: small numeric helpers and the composition weight around the card.
 *
 * FROZEN (see prng.ts and ADR 0021): never edit; add `kernel/v2/` instead.
 */
import type { BackdropRect } from '../../types.js';

export const TAU = Math.PI * 2;

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Hermite smoothstep: 0 at `edge0`, 1 at `edge1`. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * How far a point is from the card, 0 (touching it) to 1 (out toward the page's edges), measured
 * from the card's edges in half-viewport units. Compositions scale density and strength by it, so
 * the art gathers at the edges and the card sits in calm.
 */
export function cardDistance(x: number, y: number, card: BackdropRect, width: number, height: number): number {
  const cx = card.x + card.width / 2;
  const cy = card.y + card.height / 2;
  const dx = Math.max(0, Math.abs(x - cx) - card.width / 2) / Math.max(1, width / 2);
  const dy = Math.max(0, Math.abs(y - cy) - card.height / 2) / Math.max(1, height / 2);
  return clamp(Math.sqrt(dx * dx + dy * dy) / 0.6, 0, 1);
}
