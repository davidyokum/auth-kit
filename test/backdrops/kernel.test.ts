import './preload.js';
import { describe, expect, it } from 'vitest';
import { contrastRatio, fromOklab, mix, over, parseHex, relativeLuminance, rgba, toHex, toOklab } from '../../src/backdrops/kernel/v1/color.js';
import { createNoise } from '../../src/backdrops/kernel/v1/noise.js';
import { createRng, hashParts, hashString, seedString } from '../../src/backdrops/kernel/v1/prng.js';
import { cardDistance, clamp, smoothstep } from '../../src/backdrops/kernel/v1/shape.js';

describe('kernel v1: hashing and the generator', () => {
  it('hashes strings to stable 53-bit integers', () => {
    expect(hashString('Example Site')).toBe(hashString('Example Site'));
    expect(hashString('Example Site')).not.toBe(hashString('Example site'));
    expect(Number.isSafeInteger(hashString('x'))).toBe(true);
    expect(hashParts('a', 1)).not.toBe(hashParts('a1'));
  });

  it('makes 8-character base-36 seeds', () => {
    for (const s of ['', 'a', 'Example Site']) expect(seedString(hashString(s))).toMatch(/^[0-9a-z]{8}$/);
  });

  it('repeats exactly for a seed, and differs between seeds', () => {
    const a = createRng(42);
    const b = createRng(42);
    const c = createRng(43);
    const seqA = Array.from({ length: 20 }, () => a.next());
    expect(Array.from({ length: 20 }, () => b.next())).toEqual(seqA);
    expect(Array.from({ length: 20 }, () => c.next())).not.toEqual(seqA);
    for (const v of seqA) expect(v >= 0 && v < 1).toBe(true);
  });

  it('draws uniformly enough, and normals with mean 0 and deviation 1', () => {
    const rng = createRng(7);
    const buckets = new Array(10).fill(0) as number[];
    let sum = 0;
    let sq = 0;
    for (let i = 0; i < 20000; i++) {
      buckets[Math.floor(rng.next() * 10)]! += 1;
      const n = rng.normal();
      sum += n;
      sq += n * n;
    }
    for (const b of buckets) expect(Math.abs(b - 2000)).toBeLessThan(200);
    expect(Math.abs(sum / 20000)).toBeLessThan(0.05);
    expect(Math.abs(Math.sqrt(sq / 20000) - 1)).toBeLessThan(0.05);
  });

  it('forks independent streams, picks, and shuffles (a permutation)', () => {
    const rng = createRng(9);
    const f1 = rng.fork('one').next();
    const f2 = rng.fork('one').next();
    expect(f1).not.toBe(f2);
    expect(rng.shuffle([1, 2, 3, 4, 5]).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(() => rng.pick([])).toThrow(/empty/);
  });
});

describe('kernel v1: noise', () => {
  it('stays within [-1, 1], is smooth, and repeats for a seed', () => {
    const n = createNoise(createRng(1));
    const m = createNoise(createRng(1));
    let max = 0;
    for (let i = 0; i < 5000; i++) {
      const x = i * 0.137;
      const y = i * 0.071;
      const v2 = n.noise2(x, y);
      const v3 = n.noise3(x, y, i * 0.05);
      max = Math.max(max, Math.abs(v2), Math.abs(v3));
      expect(m.noise2(x, y)).toBe(v2);
    }
    expect(max).toBeLessThanOrEqual(1.0001);
    expect(max).toBeGreaterThan(0.6);
    expect(Math.abs(n.noise2(1, 1) - n.noise2(1.001, 1))).toBeLessThan(0.01);
    expect(Math.abs(n.fbm3(0.3, 0.2, 0.1, 4))).toBeLessThanOrEqual(1);
  });

  it('differs between seeds', () => {
    expect(createNoise(createRng(1)).noise2(3.3, 4.4)).not.toBe(createNoise(createRng(2)).noise2(3.3, 4.4));
  });
});

describe('kernel v1: color', () => {
  it('parses, writes, and refuses bad colors', () => {
    expect(parseHex('#1E79C8')).toEqual([30, 121, 200]);
    expect(parseHex('#fff')).toEqual([255, 255, 255]);
    expect(toHex([30, 121, 200])).toBe('#1e79c8');
    expect(rgba('#1e79c8', 0.5)).toBe('rgba(30,121,200,0.5)');
    expect(() => parseHex('blue')).toThrow(/isn't a #rgb/);
  });

  it('mixes in OKLab with exact endpoints, and round-trips OKLab', () => {
    expect(toHex(mix('#092940', '#f3f4f6', 0))).toBe('#092940');
    expect(toHex(mix('#092940', '#f3f4f6', 1))).toBe('#f3f4f6');
    expect(toHex(fromOklab(toOklab(parseHex('#4b9cd3'))))).toBe('#4b9cd3');
    expect(toHex(over('#000000', 0.5, '#ffffff'))).toBe('#808080');
  });

  it('computes WCAG luminance and contrast', () => {
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 6);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 6);
    // The design report's figures (REPORT.md §7.2).
    expect(contrastRatio('#ffffff', '#1e79c8')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#3892e1', '#ffffff')).toBeGreaterThanOrEqual(3);
  });
});

describe('kernel v1: shape', () => {
  it('clamps, eases, and measures distance from the card', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(smoothstep(0, 1, 0.5)).toBe(0.5);
    const card = { x: 400, y: 200, width: 400, height: 400 };
    expect(cardDistance(600, 400, card, 1200, 800)).toBe(0);
    expect(cardDistance(0, 0, card, 1200, 800)).toBeGreaterThan(0.9);
  });
});
