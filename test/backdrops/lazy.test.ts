/**
 * Each style's drawing code loads on first use (a chunk of its own): the module's metadata is
 * available at once; `create` waits for `load()`; a mismatch between the module and the file fails.
 */
import { describe, expect, it } from 'vitest';
import { defineVersion, lazyVersion } from '../../src/backdrops/styles/define.js';
import { STYLE_MODULES, loadBackdropStyle } from '../../src/backdrops/styles/registry.js';

const real = defineVersion({ version: 1, fps: 12, maxPixelRatio: 2, stillTime: 5, colors: () => null, create: () => ({ draw: () => undefined }) });

describe('lazyVersion', () => {
  it('knows its metadata at once, and draws only once loaded', async () => {
    const lazy = lazyVersion({ version: 1, fps: 12, maxPixelRatio: 2, stillTime: 5 }, () => Promise.resolve(real));
    expect([lazy.loaded, lazy.fps, lazy.stillTime]).toEqual([false, 12, 5]);
    expect(() => lazy.colors({} as never)).toThrow(/isn't loaded yet/);
    await lazy.load();
    expect(lazy.loaded).toBe(true);
    expect(() => lazy.create({} as never)).not.toThrow();
  });

  it('fails when the module’s metadata and the file disagree, and can try again after a failed load', async () => {
    await expect(lazyVersion({ version: 1, fps: 30, maxPixelRatio: 2, stillTime: 5 }, () => Promise.resolve(real)).load()).rejects.toThrow(/fps is 12 in its file but 30/);
    let attempts = 0;
    const flaky = lazyVersion({ version: 1, fps: 12, maxPixelRatio: 2, stillTime: 5 }, () => (++attempts === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(real)));
    await expect(flaky.load()).rejects.toThrow(/offline/);
    await flaky.load();
    expect([flaky.loaded, attempts]).toEqual([true, 2]);
  });

  it('every registered style loads, and its module’s metadata matches its file', async () => {
    for (const m of STYLE_MODULES) {
      for (const v of m.versions) {
        const { version } = await loadBackdropStyle(m.id, v.version);
        expect(version.loaded, m.id).toBe(true);
      }
    }
  });
});
