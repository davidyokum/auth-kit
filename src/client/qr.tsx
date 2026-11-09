/**
 * The QR code on "Add an authenticator app": the `otpauth://` setup link, drawn as an inline SVG of
 * dark squares (no raw HTML, no image request, nothing a strict CSP has to allow). The encoder is
 * vendored (src/client/vendor/qrcode-generator.js, MIT) and loaded on first use, in its own chunk, so
 * only this screen pays for it. Until it loads, the square holds its place, so nothing jumps.
 *
 * Sites can still pass `renderQrCode` to draw their own; this is what every site gets without one.
 */
import { useEffect, useState } from 'react';

interface Matrix {
  size: number;
  path: string;
}

async function encode(value: string): Promise<Matrix> {
  const { qrcode } = await import('./vendor/qrcode-generator.js');
  const qr = qrcode(0, 'M');
  qr.addData(value, 'Byte');
  qr.make();
  const size = qr.getModuleCount();
  let path = '';
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) if (qr.isDark(row, col)) path += `M${col} ${row}h1v1h-1z`;
  }
  return { size, path };
}

/** The quiet zone around the code, in modules (the standard asks for 4; 2 reads reliably on screens). */
const MARGIN = 2;

export function QrCode({ value, label, size = 176 }: { value: string; label: string; size?: number }) {
  const [matrix, setMatrix] = useState<Matrix | null>(null);
  useEffect(() => {
    let live = true;
    encode(value).then(
      (m) => live && setMatrix(m),
      () => live && setMatrix(null),
    );
    return () => {
      live = false;
    };
  }, [value]);
  const box = (matrix?.size ?? 21) + MARGIN * 2;
  return (
    <svg
      data-auth-kit-qr=""
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`${-MARGIN} ${-MARGIN} ${box} ${box}`}
      shapeRendering="crispEdges"
      style={{ display: 'block', background: '#ffffff', borderRadius: 6 }}
    >
      {matrix ? <path d={matrix.path} fill="#000000" /> : null}
    </svg>
  );
}
