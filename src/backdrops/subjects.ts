/**
 * Subject rotation (register E3; ADR 0021): a style that shows one subject at a time (County Survey's
 * 100 counties, River Basins' 17 basins, Star Chart's constellations) may show a different one each
 * visit, while the site's seed keeps locking the look (paper, ink, layout, ornaments, plot order).
 *
 * - `tour` (the default): every subject once, in an order shuffled for this browser, before any
 *   repeats. The order and the position live in this browser's `localStorage` only; where storage is
 *   blocked, the tour falls back to the subject of the day.
 * - `random`: any subject, each visit.
 * - `day`: one subject per calendar day (UTC), the same for everyone, varied by the seed.
 * - `fixed`: always `key` (a review, or a site that wants one).
 *
 * The subject is never stored server-side, and never part of a site's lock: it's a per-visit choice
 * in the browser. Re-creating the backdrop on the same page (a resize, a theme change) keeps the
 * subject it picked.
 */
import { hashParts } from './kernel/v1/prng.js';
import type { BackdropStyleModule } from './styles/define.js';

export type SubjectRotation = 'tour' | 'random' | 'day' | 'fixed';

export interface BackdropSubjectOptions {
  /** Default `tour`. */
  rotation?: SubjectRotation;
  /** `fixed`: the subject's key (County Survey `'Dare'`, River Basins `'Cape Fear'`, Star Chart `'Cyg'`). */
  key?: string;
  /** Which of the style's sets to rotate through (Star Chart: `'curated'`, the default 40, or `'all'` 88). */
  set?: string;
}

export interface PickedSubject {
  key: string;
  set: string;
  /** 1-based position in the set ("Sheet 7 of 100"). */
  index: number;
  of: number;
  rotation: SubjectRotation;
  /** `tour` couldn't use storage, so this is the subject of the day. */
  fallback?: true;
}

/** What the picker reads from the browser. Tests and servers pass their own. */
export interface SubjectEnvironment {
  /** `localStorage`, or null where it's blocked or absent. */
  storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** A number in [0, 1); not seeded on purpose (a tour is per browser, not per seed). */
  random: () => number;
  now: () => number;
}

const ROTATIONS: readonly SubjectRotation[] = ['tour', 'random', 'day', 'fixed'];
const DAY_MS = 86_400_000;
/** Same page, same subject: a re-created backdrop (resize, theme) keeps what this page picked. */
const PICKED = new Map<string, PickedSubject>();

/** The browser's environment, safely: storage that throws on access counts as none. */
export function browserSubjectEnvironment(): SubjectEnvironment {
  let storage: SubjectEnvironment['storage'];
  try {
    storage = typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    storage = null;
  }
  return { storage, random: Math.random, now: Date.now };
}

/** Checks the options against the style; throws on a rotation, set, or key the style doesn't have. */
export function subjectOptionProblems(module: BackdropStyleModule, options: BackdropSubjectOptions | undefined): string[] {
  if (options === undefined) return [];
  const problems: string[] = [];
  if (!module.subjects) return [`style "${module.id}" has no subjects to rotate`];
  if (options.rotation !== undefined && !ROTATIONS.includes(options.rotation)) problems.push(`subject.rotation must be ${ROTATIONS.join(', ')}`);
  const set = options.set ?? module.subjects.defaultSet;
  const keys = module.subjects.sets[set];
  if (!keys) problems.push(`style "${module.id}" has no subject set "${set}" (sets: ${Object.keys(module.subjects.sets).join(', ')})`);
  if ((options.rotation ?? 'tour') === 'fixed' && !options.key) problems.push('subject.rotation "fixed" needs subject.key');
  if (options.key !== undefined && keys && !keys.includes(options.key) && !Object.values(module.subjects.sets).some((k) => k.includes(options.key!))) {
    problems.push(`style "${module.id}" has no subject "${options.key}"`);
  }
  return problems;
}

/**
 * This visit's subject for a style that has subjects (undefined for one that doesn't). Throws on
 * options the style can't honor.
 */
export function pickSubject(module: BackdropStyleModule, seed: string, options: BackdropSubjectOptions = {}, env: SubjectEnvironment = browserSubjectEnvironment()): PickedSubject | undefined {
  const subjects = module.subjects;
  if (!subjects) {
    if (options.rotation !== undefined || options.key !== undefined || options.set !== undefined) throw new Error(`auth-kit/backdrops: style "${module.id}" has no subjects to rotate.`);
    return undefined;
  }
  const problems = subjectOptionProblems(module, options);
  if (problems.length > 0) throw new Error(`auth-kit/backdrops: ${problems.join('; ')}.`);
  const rotation = options.rotation ?? 'tour';
  const set = options.set ?? subjects.defaultSet;
  const keys = subjects.sets[set]!;
  const at = (i: number, extra: Partial<PickedSubject> = {}): PickedSubject => ({ key: keys[i]!, set, index: i + 1, of: keys.length, rotation, ...extra });
  if (rotation === 'fixed') {
    const i = keys.indexOf(options.key!);
    return i >= 0 ? at(i) : { key: options.key!, set, index: 1, of: keys.length, rotation };
  }
  const day = () => Number(hashParts('subject-of-the-day', module.id, set, seed, Math.floor(env.now() / DAY_MS)) % keys.length);
  if (rotation === 'day') return at(day());
  const pageKey = `${module.id}|${set}|${seed}|${rotation}`;
  const seen = PICKED.get(pageKey);
  if (seen) return seen;
  let picked: PickedSubject;
  if (rotation === 'random') picked = at(Math.floor(env.random() * keys.length) % keys.length);
  else {
    const step = tourStep(module.id, set, seed, keys.length, env);
    picked = step === null ? at(day(), { fallback: true }) : at(step);
  }
  PICKED.set(pageKey, picked);
  return picked;
}

interface TourState {
  order: number[];
  pos: number;
}

/** Advances this browser's tour by one and returns the subject's index; null when storage can't hold it. */
function tourStep(id: string, set: string, seed: string, n: number, env: SubjectEnvironment): number | null {
  if (!env.storage) return null;
  const storageKey = `auth-kit:backdrop-tour:${id}:${set}:${seed}`;
  try {
    let state: TourState | null = null;
    const raw = env.storage.getItem(storageKey);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<TourState>;
      if (Array.isArray(parsed.order) && parsed.order.length === n && typeof parsed.pos === 'number' && new Set(parsed.order).size === n && parsed.order.every((x) => Number.isInteger(x) && x >= 0 && x < n)) {
        state = { order: parsed.order, pos: parsed.pos };
      }
    }
    if (!state || state.pos >= n || state.pos < 0) {
      // A new lap: a fresh shuffle (Fisher-Yates), not the seed's: the tour is per browser.
      const order = Array.from({ length: n }, (_, i) => i);
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(env.random() * (i + 1));
        [order[i], order[j]] = [order[j]!, order[i]!];
      }
      state = { order, pos: 0 };
    }
    const i = state.order[state.pos]!;
    env.storage.setItem(storageKey, JSON.stringify({ order: state.order, pos: state.pos + 1 }));
    return i;
  } catch {
    return null;
  }
}

/** Forgets what this page picked (tests). */
export function resetPickedSubjects(): void {
  PICKED.clear();
}
