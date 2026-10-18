/**
 * Backdrop kernel v1: colors. Hex parsing, mixing in OKLab (perceptually even, so a mix of navy and
 * grey doesn't go muddy), CSS strings, and WCAG relative luminance and contrast.
 *
 * FROZEN (see prng.ts and ADR 0020): style versions derive their colors through these functions.
 * Never edit; add `kernel/v2/` instead.
 */

/** sRGB channels, 0-255 (may be fractional until written out). */
export type Rgb = readonly [number, number, number];

/** Parses `#rgb` or `#rrggbb`. Throws on anything else, so a typo in a palette fails loudly. */
export function parseHex(hex: string): Rgb {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m?.[1]) throw new Error(`auth-kit/backdrops: "${hex}" isn't a #rgb or #rrggbb color.`);
  const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

export function toHex(rgb: Rgb): string {
  return `#${rgb.map((c) => Math.round(clamp255(c)).toString(16).padStart(2, '0')).join('')}`;
}

/** `rgba(r, g, b, a)` with integer channels and the alpha rounded to three places. */
export function rgba(color: Rgb | string, alpha = 1): string {
  const [r, g, b] = typeof color === 'string' ? parseHex(color) : color;
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 1000) / 1000;
  return `rgba(${Math.round(clamp255(r))},${Math.round(clamp255(g))},${Math.round(clamp255(b))},${a})`;
}

function toLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function fromLinear(v: number): number {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return clamp255(c * 255);
}

/** OKLab (Björn Ottosson): [L, a, b]. */
export function toOklab(rgb: Rgb): [number, number, number] {
  const r = toLinear(rgb[0]);
  const g = toLinear(rgb[1]);
  const b = toLinear(rgb[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function fromOklab(lab: readonly [number, number, number]): Rgb {
  const l = lab[0] + 0.3963377774 * lab[1] + 0.2158037573 * lab[2];
  const m = lab[0] - 0.1055613458 * lab[1] - 0.0638541728 * lab[2];
  const s = lab[0] - 0.0894841775 * lab[1] - 1.291485548 * lab[2];
  const l3 = l * l * l;
  const m3 = m * m * m;
  const s3 = s * s * s;
  return [
    fromLinear(4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3),
    fromLinear(-1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3),
    fromLinear(-0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3),
  ];
}

/** Mixes two colors in OKLab: `t` 0 is `a`, 1 is `b`. */
export function mix(a: Rgb | string, b: Rgb | string, t: number): Rgb {
  const la = toOklab(typeof a === 'string' ? parseHex(a) : a);
  const lb = toOklab(typeof b === 'string' ? parseHex(b) : b);
  return fromOklab([la[0] + (lb[0] - la[0]) * t, la[1] + (lb[1] - la[1]) * t, la[2] + (lb[2] - la[2]) * t]);
}

/** Scales OKLab chroma (saturation): 0 is grey, 1 unchanged. */
export function saturate(color: Rgb | string, factor: number): Rgb {
  const lab = toOklab(typeof color === 'string' ? parseHex(color) : color);
  return fromOklab([lab[0], lab[1] * factor, lab[2] * factor]);
}

/** Alpha-composites `top` over `bottom` (straight sRGB blending, as a canvas does). */
export function over(top: Rgb | string, alpha: number, bottom: Rgb | string): Rgb {
  const t = typeof top === 'string' ? parseHex(top) : top;
  const b = typeof bottom === 'string' ? parseHex(bottom) : bottom;
  return [b[0] + (t[0] - b[0]) * alpha, b[1] + (t[1] - b[1]) * alpha, b[2] + (t[2] - b[2]) * alpha];
}

/** WCAG 2 relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance(color: Rgb | string): number {
  const [r, g, b] = typeof color === 'string' ? parseHex(color) : color;
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG 2 contrast ratio, 1 to 21. */
export function contrastRatio(a: Rgb | string, b: Rgb | string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
