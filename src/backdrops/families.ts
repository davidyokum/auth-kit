/**
 * Each family's colors: the palette backdrops paint with, and the card's few family colors.
 *
 * From the sign-in design report (passwords-flow design/benchmark/REPORT.md §7.1 "The core" and
 * §7.2 "What varies, per family"). The card is the same everywhere: white, heading ink #092940, body
 * #3C434B, focus ring #2881CD, a 1px border and a soft shadow (the backdrop is never faded around
 * it). Families change the primary button, links, and the border's tint (there's no colored line on top
 * of the card; register E4).
 *
 * v0.1.10-alpha.1 deepened two of them, keeping each hue (the Sign-in Studio found them short off pure
 * white): the focus ring was #3892E1 (2.997:1 on Plain's column, down to 2.71:1 on its tinted boxes, 2.85:1
 * on Porcelain's well), and UNC's links were #007FAE (4.48:1 on Monogram, 4.14:1 on Plain's column, 3.77:1
 * on its tinted boxes). Both now clear every surface of every card style, light page or dark, with room to
 * spare: the ring at least 3.35:1, UNC's links at least 4.74:1 (`test/screenshots` measures them).
 * #007FAE stays in UNC's backdrop palette, where it's art, not text.
 *
 * These are brand constants. Changing one changes every site of that family (style versions pin
 * the algorithm, not the brand; ADR 0021), so treat an edit here as a brand decision.
 */
import type { BackdropCardTheme, BackdropFamily, BackdropPalette } from './types.js';

export interface BackdropFamilyColors {
  readonly label: string;
  readonly palette: Readonly<BackdropPalette>;
  readonly card: Readonly<BackdropCardTheme>;
}

const CORE_CARD = { surface: '#ffffff', heading: '#092940', body: '#3c434b', buttonText: '#ffffff', focus: '#2881cd' } as const;

export const BACKDROP_FAMILIES: Readonly<Record<BackdropFamily, BackdropFamilyColors>> = Object.freeze({
  osbm: Object.freeze({
    label: 'NC OSBM',
    // NC navy, NC action blue, and the core focus blue as the lighter brand color.
    palette: Object.freeze({ page: '#f3f4f6', mist: '#e2e7ed', glow: '#a9cbea', primary: '#1e79c8', secondary: '#3892e1', ink: '#092940' }),
    card: Object.freeze({ ...CORE_CARD, link: '#1668b0', button: '#1e79c8', rule: '#092940', border: '#4a5f73' }),
  }),
  unc: Object.freeze({
    label: 'UNC-Chapel Hill',
    // UNC navy, Carolina Blue (decorative only on the card), and UNC link blue (#007fae; the card's links are a deeper #006d9b).
    palette: Object.freeze({ page: '#f3f5f8', mist: '#dde6ef', glow: '#b3d5ee', primary: '#4b9cd3', secondary: '#007fae', ink: '#13294b' }),
    card: Object.freeze({ ...CORE_CARD, link: '#006d9b', button: '#13294b', rule: '#4b9cd3', border: '#2c4266' }),
  }),
  personal: Object.freeze({
    label: 'Personal',
    // Ink and indigo on a warm stone page (the personal family; register F11).
    palette: Object.freeze({ page: '#f5f3ef', mist: '#e7e1d6', glow: '#b6c1e8', primary: '#1c326e', secondary: '#4f63ad', ink: '#1c1917' }),
    card: Object.freeze({ ...CORE_CARD, link: '#1c326e', button: '#1c1917', rule: '#1c326e', border: '#57514c' }),
  }),
});

export const BACKDROP_FAMILY_IDS = Object.freeze(Object.keys(BACKDROP_FAMILIES) as BackdropFamily[]);

export function isBackdropFamily(value: unknown): value is BackdropFamily {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(BACKDROP_FAMILIES, value);
}

/** A family's palette, with any overrides applied (each must be `#rrggbb`). */
export function backdropPalette(family: BackdropFamily, overrides: Partial<BackdropPalette> = {}): BackdropPalette {
  if (!isBackdropFamily(family)) throw new Error(`auth-kit/backdrops: family "${String(family)}" isn't one of ${BACKDROP_FAMILY_IDS.join(', ')}.`);
  return { ...BACKDROP_FAMILIES[family].palette, ...overrides };
}
