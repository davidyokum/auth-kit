/**
 * A stand-in for the QR code sites draw on "Add an authenticator app" (`renderQrCode`; auth-kit ships no
 * QR encoder). It looks like a QR code (three finder squares, timing lines, modules) but encodes nothing,
 * and says so to screen readers. Deterministic: the same setup link draws the same picture.
 */
import type { ReactNode } from 'react';

const SIZE = 25;

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function finder(x: number, y: number): boolean | null {
  for (const [ox, oy] of [
    [0, 0],
    [SIZE - 7, 0],
    [0, SIZE - 7],
  ] as const) {
    const dx = x - ox;
    const dy = y - oy;
    if (dx >= -1 && dx <= 7 && dy >= -1 && dy <= 7) {
      if (dx < 0 || dy < 0 || dx > 6 || dy > 6) return false;
      const ring = Math.min(dx, dy, 6 - dx, 6 - dy);
      return ring !== 1;
    }
  }
  return null;
}

export function sampleQrCode(uri: string): ReactNode {
  let state = hash(uri) || 1;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  const cells: string[] = [];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const f = finder(x, y);
      const on = f ?? (y === 6 ? x % 2 === 0 : x === 6 ? y % 2 === 0 : random() < 0.5);
      if (on) cells.push(`M${x + 2} ${y + 2}h1v1h-1z`);
    }
  }
  return (
    <svg data-auth-kit-preview-qr="" viewBox={`0 0 ${SIZE + 4} ${SIZE + 4}`} role="img" aria-label="A sample QR code (it encodes nothing)" shapeRendering="crispEdges">
      <rect width={SIZE + 4} height={SIZE + 4} fill="#ffffff" />
      <path d={cells.join('')} fill="#000000" />
    </svg>
  );
}
