/**
 * Choosing a backdrop: nine variations to pick from, a default from the site's name, and the lock
 * check a site's build runs (ADR 0021).
 *
 * The site's name only ever proposes a default. Once chosen, a site stores the literal choice,
 * `{ style, seed, styleVersion, locked: true }`, so renaming the site, adding styles, or upgrading
 * auth-kit never changes its backdrop.
 */
import { BACKDROP_FAMILY_IDS, isBackdropFamily } from './families.js';
import { normalizeSeed } from './frame.js';
import { createRng, hashParts, seedString } from './kernel/v1/prng.js';
import { type BackdropStyleId, backdropStyle, isBackdropStyleId, latestStyleVersion, offeredStyles } from './styles/registry.js';
import type { BackdropFamily } from './types.js';

/** What a site stores: a style, a literal seed, and the style version that drew it. */
export interface BackdropChoice {
  style: BackdropStyleId;
  seed: string;
  styleVersion: number;
}

export interface BackdropVariation extends BackdropChoice {
  family: BackdropFamily;
}

export interface BackdropVariationsOptions {
  /** One style, or undefined to mix every offered style. */
  style?: BackdropStyleId;
  family: BackdropFamily;
  /** Default 9 (a 3 × 3 grid). */
  count?: number;
  /** The same salt always gives the same variations; "Shuffle" is a new salt (`randomSalt()`). */
  salt: string | number;
}

/**
 * `count` variations (newest style versions). Mixed: every offered style appears before any repeats,
 * in an order the salt shuffles.
 */
export function backdropVariations(options: BackdropVariationsOptions): BackdropVariation[] {
  const count = options.count ?? 9;
  if (!Number.isInteger(count) || count < 1 || count > 64) throw new Error('auth-kit/backdrops: count must be an integer from 1 to 64.');
  if (!isBackdropFamily(options.family)) throw new Error(`auth-kit/backdrops: family must be one of ${BACKDROP_FAMILY_IDS.join(', ')}.`);
  const salt = normalizeSeed(options.salt);
  let styles: BackdropStyleId[];
  if (options.style !== undefined) {
    if (!isBackdropStyleId(options.style)) throw new Error(`auth-kit/backdrops: there's no style "${String(options.style)}".`);
    if (!backdropStyle(options.style)?.generative) throw new Error(`auth-kit/backdrops: "${options.style}" needs an image, so it has no seeded variations.`);
    styles = [options.style];
  } else {
    styles = createRng(hashParts('variations-order', salt)).shuffle(offeredStyles());
  }
  const out: BackdropVariation[] = [];
  for (let i = 0; i < count; i++) {
    const style = styles[i % styles.length] as BackdropStyleId;
    out.push({ style, seed: seedString(hashParts('variation', salt, style, i)), styleVersion: latestStyleVersion(style), family: options.family });
  }
  return out;
}

/** A fresh random salt (for "Shuffle"). */
export function randomSalt(): string {
  const bytes = new Uint32Array(2);
  const crypto = (globalThis as { crypto?: { getRandomValues?: (a: Uint32Array) => Uint32Array } }).crypto;
  if (crypto?.getRandomValues) crypto.getRandomValues(bytes);
  else {
    bytes[0] = Math.floor(Math.random() * 4294967296);
    bytes[1] = Math.floor(Math.random() * 4294967296);
  }
  return seedString((bytes[0] as number) * 2097152 + ((bytes[1] as number) >>> 11));
}

/**
 * The backdrop a site's name proposes, before anyone has chosen one: an offered style and a seed,
 * both from the name's hash. Only a proposal: it changes if the name or the offered styles change,
 * which is why a site locks its choice (`npm run backdrop:lock` in the template writes this one).
 */
export function defaultBackdrop(siteName: string): BackdropChoice {
  const name = siteName.trim();
  if (name === '') throw new Error('auth-kit/backdrops: defaultBackdrop needs the site’s name.');
  const offered = offeredStyles();
  const style = offered[hashParts('backdrop-style', name) % offered.length] as BackdropStyleId;
  return { style, seed: seedString(hashParts('backdrop-seed', name)), styleVersion: latestStyleVersion(style) };
}

/** A locked backdrop, as a site stores it. */
export interface LockedBackdrop extends BackdropChoice {
  locked: true;
}

/**
 * Why a stored backdrop isn't locked (empty: it is, and this auth-kit can draw it exactly). A site's
 * production build fails on any of these (site-auth-kit-template's next.config.ts).
 */
export function backdropLockProblems(value: unknown): string[] {
  if (value === null || value === undefined) return ['no backdrop is chosen: the site name only proposes one'];
  if (typeof value !== 'object') return ['backdrop must be an object: { style, seed, styleVersion, locked: true }'];
  const v = value as Record<string, unknown>;
  const problems: string[] = [];
  if (!isBackdropStyleId(v.style)) problems.push(`style "${String(v.style)}" isn't a backdrop style`);
  if (v.seed === undefined || v.seed === null || v.seed === '') problems.push('seed is missing: the name-derived default isn’t stored');
  else {
    try {
      normalizeSeed(v.seed as string | number);
    } catch (error) {
      problems.push((error as Error).message.replace(/^auth-kit\/backdrops: /, ''));
    }
  }
  if (v.styleVersion === undefined) problems.push('styleVersion is missing: without it an auth-kit upgrade could redraw the backdrop');
  else if (isBackdropStyleId(v.style)) {
    const versions = backdropStyle(v.style)?.versions.length ?? 0;
    if (!Number.isInteger(v.styleVersion) || (v.styleVersion as number) < 1 || (v.styleVersion as number) > versions) {
      problems.push(`styleVersion ${JSON.stringify(v.styleVersion)} doesn't exist for "${v.style}" in this auth-kit (it has 1-${versions})`);
    }
  }
  if (v.locked !== true) problems.push('locked isn’t true');
  return problems;
}
