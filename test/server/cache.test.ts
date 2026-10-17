import { describe, expect, it } from 'vitest';
import { TtlCache } from '../../src/server/index.js';

describe('TtlCache', () => {
  it('expires entries after their lifetime', () => {
    const clock = { now: 0 };
    const cache = new TtlCache<string, number>(10, () => clock.now);
    cache.set('a', 1, 1000);
    expect(cache.get('a')).toBe(1);
    clock.now = 1000;
    expect(cache.get('a')).toBeUndefined();
  });

  it.each([Number.NaN, Infinity, -Infinity, 0, -5])('stores nothing for a lifetime of %s (never "forever") (L1)', (ttl) => {
    const clock = { now: 0 };
    const cache = new TtlCache<string, number>(10, () => clock.now);
    cache.set('a', 1, ttl);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('a bad lifetime also clears an older entry for the key, so a stale answer is not kept', () => {
    const cache = new TtlCache<string, number>(10, () => 0);
    cache.set('a', 1, 1000);
    cache.set('a', 2, Number.NaN);
    expect(cache.get('a')).toBeUndefined();
  });

  it('drops the oldest entries past its size cap', () => {
    const cache = new TtlCache<string, number>(2, () => 0);
    cache.set('a', 1, 1000);
    cache.set('b', 2, 1000);
    cache.set('c', 3, 1000);
    expect([cache.get('a'), cache.get('b'), cache.get('c')]).toEqual([undefined, 2, 3]);
  });
});
