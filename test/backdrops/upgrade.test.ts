/**
 * When a later auth-kit adds a version of a style a site has locked, the site keeps its version and
 * the picker offers the newer one explicitly (ADR 0021). Simulated here by giving aurora a version 2.
 */
import { describe, expect, it, vi } from 'vitest';
import type * as Registry from '../../src/backdrops/styles/registry.js';

vi.mock('../../src/backdrops/styles/registry.js', async (importOriginal) => {
  const real = await importOriginal<typeof Registry>();
  const aurora = real.backdropStyle('aurora')!;
  const withV2 = { ...aurora, versions: [aurora.versions[0]!, { ...aurora.versions[0]!, version: 2 }] };
  return {
    ...real,
    backdropStyle: (id: string) => (id === 'aurora' ? withV2 : real.backdropStyle(id)),
    latestStyleVersion: (id: Registry.BackdropStyleId) => (id === 'aurora' ? 2 : real.latestStyleVersion(id)),
  };
});

const { upgradeOffer, lockStatus } = await import('../../src/backdrops/picker-model.js');

describe('upgrade offers', () => {
  it('offers the same seed in the newest version, leaving the locked one as it is', () => {
    const stored = { style: 'aurora', seed: 'k3f9x2ab', styleVersion: 1, locked: true };
    expect(lockStatus(stored)).toBe('locked');
    expect(upgradeOffer(stored)).toEqual({
      current: { style: 'aurora', seed: 'k3f9x2ab', styleVersion: 1 },
      upgrade: { style: 'aurora', seed: 'k3f9x2ab', styleVersion: 2 },
    });
    expect(upgradeOffer({ ...stored, styleVersion: 2 })).toBeNull();
    expect(upgradeOffer({ style: 'contours', seed: 'x', styleVersion: 1, locked: true })).toBeNull();
  });
});
