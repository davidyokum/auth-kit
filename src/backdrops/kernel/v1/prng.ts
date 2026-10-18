/**
 * Backdrop kernel v1: string hashing and a seeded random number generator.
 *
 * FROZEN. Every style version that imports this file draws from its exact output, and sites lock a
 * style version (ADR 0020), so a change here would redraw every locked site. Never edit it, not
 * even to tidy: add `kernel/v2/` beside it and point new style versions at that. The frozen-hash
 * test (test/backdrops/frozen.test.ts) fails if any output changes.
 *
 * Pure integer arithmetic (Math.imul, shifts), so the output is the same on every JavaScript engine.
 */

/** cyrb53: a fast, well-mixed 53-bit hash of a string (public domain, bryc). */
export function hashString(input: string, salt = 0): number {
  let h1 = 0xdeadbeef ^ salt;
  let h2 = 0x41c6ce57 ^ salt;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** One hash for several parts, joined with a separator no seed or style ID contains. */
export function hashParts(...parts: readonly (string | number)[]): number {
  return hashString(parts.join('\u001f'));
}

const SEED_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** A short seed string (8 base-36 characters) from a 53-bit hash, e.g. `k3f9x2ab`. */
export function seedString(hash: number): string {
  let n = Math.floor(Math.abs(hash));
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += SEED_ALPHABET[n % 36];
    n = Math.floor(n / 36);
  }
  return out;
}

export interface Rng {
  /** A number in [0, 1). */
  next(): number;
  /** A number in [min, max). */
  range(min: number, max: number): number;
  /** An integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  /** True with probability `p`. */
  chance(p: number): boolean;
  /** A standard normal sample (mean 0, deviation 1). */
  normal(): number;
  /** One item, chosen uniformly. */
  pick<T>(items: readonly T[]): T;
  /** Shuffles in place (Fisher-Yates) and returns the same array. */
  shuffle<T>(items: T[]): T[];
  /** An independent stream for one purpose, so adding draws in one place never shifts another. */
  fork(label: string): Rng;
}

/** sfc32 (PractRand-tested, public domain), seeded from a 53-bit hash. */
export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  let b = Math.floor(seed / 4294967296) >>> 0;
  let c = 0x9e3779b9;
  let d = (0x243f6a88 ^ a) >>> 0;
  let spare = 0;
  let hasSpare = false;

  function next(): number {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  // Warm up: the first outputs of a fresh state are correlated with the seed.
  for (let i = 0; i < 15; i++) next();

  const rng: Rng = {
    next,
    range: (min, max) => min + (max - min) * next(),
    int: (maxExclusive) => Math.floor(next() * maxExclusive),
    chance: (p) => next() < p,
    normal() {
      if (hasSpare) {
        hasSpare = false;
        return spare;
      }
      let u: number;
      let v: number;
      let s: number;
      do {
        u = next() * 2 - 1;
        v = next() * 2 - 1;
        s = u * u + v * v;
      } while (s >= 1 || s === 0);
      const m = Math.sqrt((-2 * Math.log(s)) / s);
      spare = v * m;
      hasSpare = true;
      return u * m;
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new Error('auth-kit/backdrops: pick from an empty list.');
      return items[Math.floor(next() * items.length)] as T;
    },
    shuffle<T>(items: T[]): T[] {
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const tmp = items[i] as T;
        items[i] = items[j] as T;
        items[j] = tmp;
      }
      return items;
    },
    fork: (label) => createRng(hashString(label, Math.floor(next() * 4294967296))),
  };
  return rng;
}
