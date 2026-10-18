/**
 * Public types for `auth-kit/backdrops`. Style IDs come from the registry (styles/registry.ts), so
 * adding a style there adds it here.
 */

/** Who runs a site. Matches site-auth-kit-template's `site.config.ts` `family`. */
export type BackdropFamily = 'osbm' | 'unc' | 'personal';

/** The colors a style paints with. Every value is `#rrggbb`. */
export interface BackdropPalette {
  /** The page: the backdrop's ground color. */
  page: string;
  /** A light neutral a step darker than the page (paper shadows, quiet fills). */
  mist: string;
  /** A light tint of the brand color (highlights, glows). */
  glow: string;
  /** The brand's main color. */
  primary: string;
  /** A second brand color, for variety. */
  secondary: string;
  /** The deepest brand color (navy or ink). */
  ink: string;
}

/** The card's own colors (identical cards; only these vary by family). For `cardContrast`. */
export interface BackdropCardTheme {
  /** The card's surface. Solid: the backdrop never shows through it. */
  surface: string;
  /** The card's crisp 1px border, which sets it apart from any backdrop (with a soft shadow). */
  border: string;
  /** Headings. */
  heading: string;
  /** Body text. */
  body: string;
  /** Links and link-style buttons. */
  link: string;
  /** The primary button's fill. */
  button: string;
  /** The primary button's text. */
  buttonText: string;
  /** The keyboard focus ring. */
  focus: string;
  /** The 4px rule across the top of the card. Decorative: never text. */
  rule: string;
}

/** A rectangle in CSS pixels, relative to the backdrop's top-left corner. */
export interface BackdropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The pointer, as styles see it: eased position and presence. */
export interface BackdropPointer {
  /** Eased position in CSS pixels. Meaningful while `strength` > 0. */
  x: number;
  y: number;
  /** 0 (away) to 1 (present and moving), eased in and out. */
  strength: number;
}

/** What `painted` draws: one image, cover-fitted, with an optional blur-up placeholder. */
export interface BackdropImage {
  /** The image URL (it must be allowed by the page's `img-src`). Decorative: there's no alt text. */
  src: string;
  /** A tiny version (a data: URL of a ~16px-wide image) drawn enlarged, so it reads as a blur, until `src` loads. */
  placeholder?: string;
  /** Focal point, 0-1 on each axis, kept in view when cropping. Default the center. */
  focus?: { x: number; y: number };
}
