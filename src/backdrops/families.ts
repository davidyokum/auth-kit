/**
 * Each family's colors: the palette backdrops paint with, and the card's few family colors.
 *
 * From the sign-in design report (passwords-flow design/benchmark/REPORT.md §7.1 "The core" and
 * §7.2 "What varies, per family"). The card is the same everywhere: white, heading ink #092940, body
 * #3C434B, focus ring #3892E1. Families change the primary button, the 4px rule, and links.
 *
 * These are brand constants. Changing one changes every site of that family (style versions pin
 * the algorithm, not the brand; ADR 0020), so treat an edit here as a brand decision.
 */
import type { BackdropCardTheme, BackdropFamily, BackdropPalette } from './types.js';

export interface BackdropFamilyColors {
  readonly label: string;
  readonly palette: Readonly<BackdropPalette>;
  readonly card: Readonly<BackdropCardTheme>;
}

const CORE_CARD = { surface: '#ffffff', heading: '#092940', body: '#3c434b', buttonText: '#ffffff', focus: '#3892e1' } as const;

export const BACKDROP_FAMILIES: Readonly<Record<BackdropFamily, BackdropFamilyColors>> = Object.freeze({
  osbm: Object.freeze({
    label: 'NC OSBM',
    // NC navy, NC action blue, and the core focus blue as the lighter brand color.
    palette: Object.freeze({ page: '#f3f4f6', mist: '#e2e7ed', glow: '#a9cbea', primary: '#1e79c8', secondary: '#3892e1', ink: '#092940' }),
    card: Object.freeze({ ...CORE_CARD, link: '#1668b0', button: '#1e79c8', rule: '#092940' }),
  }),
  unc: Object.freeze({
    label: 'UNC-Chapel Hill',
    // UNC navy, Carolina Blue (decorative only on the card), and UNC link blue.
    palette: Object.freeze({ page: '#f3f5f8', mist: '#dde6ef', glow: '#b3d5ee', primary: '#4b9cd3', secondary: '#007fae', ink: '#13294b' }),
    card: Object.freeze({ ...CORE_CARD, link: '#007fae', button: '#13294b', rule: '#4b9cd3' }),
  }),
  personal: Object.freeze({
    label: 'Yokum Lab',
    // Yokum Lab ink and indigo on a warm stone page.
    palette: Object.freeze({ page: '#f5f3ef', mist: '#e6e1d8', glow: '#c0c6df', primary: '#1c326e', secondary: '#5b6aa3', ink: '#1c1917' }),
    card: Object.freeze({ ...CORE_CARD, link: '#1c326e', button: '#1c1917', rule: '#1c326e' }),
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
