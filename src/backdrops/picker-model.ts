/**
 * The backdrop picker's pure logic: preview frames, comparing choices, lock status, and the upgrade
 * offer when a site's locked style version is older than the newest. No React, no DOM.
 */
import { backdropLockProblems, type BackdropChoice } from './variations.js';
import { backdropStyle, isBackdropStyleId, latestStyleVersion } from './styles/registry.js';

/** The virtual viewports previews are drawn at (then scaled to fit). */
export const PREVIEW_FRAMES = Object.freeze({
  desktop: Object.freeze({ width: 1280, height: 800, label: 'Desktop' }),
  phone: Object.freeze({ width: 390, height: 844, label: 'Phone' }),
});
export type PreviewFrame = keyof typeof PREVIEW_FRAMES;

/** A backdrop as a site stores it (possibly incomplete: an unlocked site may have only a style). */
export interface StoredBackdrop {
  style: string;
  seed?: string | number;
  styleVersion?: number;
  locked?: boolean;
}

export type LockStatus = 'locked' | 'unlocked';

export function lockStatus(stored: StoredBackdrop | null | undefined): LockStatus {
  return backdropLockProblems(stored).length === 0 ? 'locked' : 'unlocked';
}

/** True when two choices draw the same picture (a missing version means the newest). */
export function sameChoice(a: StoredBackdrop | null | undefined, b: StoredBackdrop | null | undefined): boolean {
  if (!a || !b || a.style !== b.style || a.seed === undefined || b.seed === undefined) return false;
  if (String(a.seed) !== String(b.seed)) return false;
  if (!isBackdropStyleId(a.style)) return false;
  const latest = latestStyleVersion(a.style);
  return (a.styleVersion ?? latest) === (b.styleVersion ?? latest);
}

export interface UpgradeOffer {
  /** What the site has now. */
  current: BackdropChoice;
  /** The same style and seed in the newest version. */
  upgrade: BackdropChoice;
}

/** When a locked backdrop's style has a newer version: the same seed, drawn by it. Moving is the site's explicit choice. */
export function upgradeOffer(stored: StoredBackdrop | null | undefined): UpgradeOffer | null {
  if (!stored || lockStatus(stored) !== 'locked' || !isBackdropStyleId(stored.style)) return null;
  const latest = latestStyleVersion(stored.style);
  const version = stored.styleVersion as number;
  if (version >= latest) return null;
  const seed = String(stored.seed);
  return { current: { style: stored.style, seed, styleVersion: version }, upgrade: { style: stored.style, seed, styleVersion: latest } };
}

/** "Contours v1 · k3f9x2ab". */
export function describeChoice(choice: StoredBackdrop): string {
  const label = backdropStyle(choice.style)?.label ?? choice.style;
  const version = choice.styleVersion !== undefined ? ` v${choice.styleVersion}` : '';
  return `${label}${version}${choice.seed !== undefined ? ` · ${String(choice.seed)}` : ''}`;
}
