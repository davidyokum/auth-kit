/**
 * The one list of backdrop styles. Adding a style is a folder under `styles/` plus one line here;
 * removing one from offer is `retired: true` on its module (never delete a style a site may have
 * locked; ADR 0021). Order is the picker's order.
 */
import { aurora } from './aurora/index.js';
import { constellation } from './constellation/index.js';
import { contours } from './contours/index.js';
import { countySurvey } from './county-survey/index.js';
import type { BackdropStyleModule, StyleVersion } from './define.js';
import { flowLines } from './flow-lines/index.js';
import { magneticDots } from './magnetic-dots/index.js';
import { painted } from './painted/index.js';
import { ripples } from './ripples/index.js';
import { stainedGlass } from './stained-glass/index.js';
import { watercolor } from './watercolor/index.js';

export const STYLE_MODULES = [magneticDots, contours, flowLines, watercolor, aurora, stainedGlass, constellation, ripples, countySurvey, painted] as const;

/** Every style ID, including retired ones and `painted`. */
export type BackdropStyleId = (typeof STYLE_MODULES)[number]['id'];

const BY_ID: ReadonlyMap<string, BackdropStyleModule> = new Map(STYLE_MODULES.map((m) => [m.id, m]));
if (BY_ID.size !== STYLE_MODULES.length) throw new Error('auth-kit/backdrops: two styles share an ID.');

/** Every style ID, in the picker's order. */
export const BACKDROP_STYLES: readonly BackdropStyleId[] = Object.freeze(STYLE_MODULES.map((m) => m.id));

export function isBackdropStyleId(value: unknown): value is BackdropStyleId {
  return typeof value === 'string' && BY_ID.has(value);
}

/** A style's module (ID, label, description, interactivity, versions), or undefined. */
export function backdropStyle(id: string): BackdropStyleModule | undefined {
  return BY_ID.get(id);
}

/** The newest version of a style. */
export function latestStyleVersion(id: BackdropStyleId): number {
  const module = BY_ID.get(id);
  if (!module) throw new Error(unknownStyle(id));
  return module.versions.length;
}

/** Styles the picker, variations, and defaults offer: generated from a seed, and not retired. */
export function offeredStyles(): BackdropStyleId[] {
  return STYLE_MODULES.filter((m) => m.generative && !(m as BackdropStyleModule).retired).map((m) => m.id);
}

function unknownStyle(id: string): string {
  return `auth-kit/backdrops: there's no style "${id}". Styles: ${BACKDROP_STYLES.join(', ')}.`;
}

/**
 * The renderer for a style and version. Without a version: the newest (for exploring). A locked
 * site always passes its version; if that version doesn't exist, this throws rather than drawing
 * something else.
 */
export function resolveStyleVersion(id: string, version?: number): { module: BackdropStyleModule; version: StyleVersion } {
  const module = BY_ID.get(id);
  if (!module) throw new Error(unknownStyle(id));
  if (version === undefined) return { module, version: module.versions[module.versions.length - 1] as StyleVersion };
  const found = module.versions[version - 1];
  if (!Number.isInteger(version) || !found) {
    throw new Error(`auth-kit/backdrops: style "${id}" has no version ${String(version)} (this auth-kit has versions 1-${module.versions.length}). A locked backdrop needs the auth-kit release that has its version, or later.`);
  }
  return { module, version: found };
}
