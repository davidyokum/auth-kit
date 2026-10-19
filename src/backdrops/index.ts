/**
 * `auth-kit/backdrops`: the art behind the sign-in card (ADR 0021).
 *
 * The card is the same on every site; a site's identity shows in its family (palette, the footer's
 * identity line) and in a backdrop: a seeded, generative picture behind the card. It's for recognition and delight,
 * not security (a picture you "should recognize" protects nobody; ADR 0021 says why). Framework-free:
 * `renderBackdrop(canvas, options)` draws and animates; `auth-kit/backdrops/react` wraps it.
 *
 * A site stores `{ style, seed, styleVersion, locked: true }`. Every style version is frozen once
 * released, so the same three values draw the same picture on every later auth-kit.
 */
export { renderBackdrop, type BackdropController, type BackdropOptions, type BackdropState, type BackdropStats } from './render.js';
export { drawBackdropStill, normalizeSeed, type BackdropArtOptions, type BackdropStillOptions, type CanvasFactory } from './frame.js';
export {
  backdropVariations,
  defaultBackdrop,
  randomSalt,
  backdropLockProblems,
  type BackdropChoice,
  type BackdropVariation,
  type BackdropVariationsOptions,
  type LockedBackdrop,
} from './variations.js';
export { cardContrast, CARD_EDGE_MINIMUM, type CardContrastReport, type ContrastCheck, type EdgeCheck } from './contrast.js';
export { BACKDROP_FAMILIES, BACKDROP_FAMILY_IDS, backdropPalette, isBackdropFamily, type BackdropFamilyColors } from './families.js';
export { BACKDROP_STYLES, backdropStyle, isBackdropStyleId, latestStyleVersion, offeredStyles, type BackdropStyleId } from './styles/registry.js';
export type { BackdropInteractivity, BackdropStyleModule, StyleVersion } from './styles/define.js';
export { CARD_WIDTH, defaultCardRect } from './card.js';
export { backdropStyles } from './css.js';
export type { BackdropCardTheme, BackdropFamily, BackdropImage, BackdropPalette, BackdropPointer, BackdropRect } from './types.js';
