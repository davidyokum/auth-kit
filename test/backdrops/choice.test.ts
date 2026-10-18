/**
 * Choosing and locking a backdrop, and the card's contrast guarantee.
 */
import { describe, expect, it } from 'vitest';
import {
  BACKDROP_FAMILIES,
  BACKDROP_STYLES,
  backdropLockProblems,
  backdropPalette,
  backdropVariations,
  cardContrast,
  defaultBackdrop,
  defaultCardRect,
  drawBackdropStill,
  offeredStyles,
  randomSalt,
  SCRIM,
  scrimAlpha,
  scrimFeather,
} from '../../src/backdrops/index.js';
import { describeChoice, lockStatus, sameChoice, upgradeOffer } from '../../src/backdrops/picker-model.js';
import { RecordingCanvas, recordingCanvasFactory } from './recording-canvas.js';

describe('backdropVariations', () => {
  it('gives nine seeds, the same for the same salt and different for another', () => {
    const a = backdropVariations({ family: 'osbm', salt: 'one' });
    expect(a).toHaveLength(9);
    expect(backdropVariations({ family: 'osbm', salt: 'one' })).toEqual(a);
    const b = backdropVariations({ family: 'osbm', salt: 'two' });
    expect(b.map((v) => v.seed)).not.toEqual(a.map((v) => v.seed));
    for (const v of a) {
      expect(v.seed).toMatch(/^[0-9a-z]{8}$/);
      expect(v.family).toBe('osbm');
      expect(v.styleVersion).toBe(1);
    }
  });

  it('mixes every offered style before repeating one; never painted', () => {
    const styles = backdropVariations({ family: 'unc', salt: 'mix' }).map((v) => v.style);
    expect(new Set(styles.slice(0, 8)).size).toBe(8);
    expect(styles).not.toContain('painted');
    expect(new Set(styles)).toEqual(new Set(offeredStyles()));
  });

  it('can hold one style; seeds don’t depend on the family (so a family preview keeps the layouts)', () => {
    const osbm = backdropVariations({ family: 'osbm', salt: 's', style: 'aurora' });
    expect(osbm.every((v) => v.style === 'aurora')).toBe(true);
    expect(backdropVariations({ family: 'personal', salt: 's', style: 'aurora' }).map((v) => v.seed)).toEqual(osbm.map((v) => v.seed));
    expect(() => backdropVariations({ family: 'osbm', salt: 's', style: 'painted' })).toThrow(/needs an image/);
    expect(() => backdropVariations({ family: 'osbm', salt: 's', count: 0 })).toThrow(/count/);
  });

  it('randomSalt makes distinct seed-shaped salts', () => {
    const salts = new Set(Array.from({ length: 50 }, () => randomSalt()));
    expect(salts.size).toBe(50);
    for (const s of salts) expect(s).toMatch(/^[0-9a-z]{8}$/);
  });
});

describe('defaultBackdrop', () => {
  it('proposes an offered style and a seed from the name, the same every time', () => {
    const a = defaultBackdrop('Example Site');
    expect(defaultBackdrop('  Example Site ')).toEqual(a);
    expect(offeredStyles()).toContain(a.style);
    expect(a.seed).toMatch(/^[0-9a-z]{8}$/);
    expect(defaultBackdrop('Budget Explorer')).not.toEqual(a);
    expect(() => defaultBackdrop('  ')).toThrow(/needs the site/);
  });

  it('spreads names across styles', () => {
    const styles = new Set(Array.from({ length: 60 }, (_, i) => defaultBackdrop(`Site ${i}`).style));
    expect(styles.size).toBeGreaterThanOrEqual(6);
  });
});

describe('backdropLockProblems', () => {
  it('accepts a complete lock this auth-kit can draw', () => {
    expect(backdropLockProblems({ style: 'contours', seed: 'k3f9x2ab', styleVersion: 1, locked: true })).toEqual([]);
    expect(backdropLockProblems({ style: 'contours', seed: 12345, styleVersion: 1, locked: true })).toEqual([]);
  });

  it('names everything missing or wrong', () => {
    expect(backdropLockProblems(null)[0]).toMatch(/no backdrop is chosen/);
    expect(backdropLockProblems({ style: 'contours' }).join('; ')).toMatch(/seed is missing.*styleVersion is missing.*locked isn’t true/);
    expect(backdropLockProblems({ style: 'nope', seed: 'x', styleVersion: 1, locked: true })[0]).toMatch(/isn't a backdrop style/);
    expect(backdropLockProblems({ style: 'aurora', seed: 'x', styleVersion: 7, locked: true })[0]).toMatch(/doesn't exist for "aurora"/);
    expect(backdropLockProblems({ style: 'aurora', seed: 'x', styleVersion: 1, locked: false })).toEqual(['locked isn’t true']);
    expect(backdropLockProblems('aurora')[0]).toMatch(/must be an object/);
  });
});

describe('cardContrast', () => {
  it.each(Object.keys(BACKDROP_FAMILIES) as ('osbm' | 'unc' | 'personal')[])('%s: the card meets WCAG AA and the backdrop is muted under it', (family) => {
    const report = cardContrast(family);
    expect(report.ok, JSON.stringify(report, null, 2)).toBe(true);
    expect(report.checks.map((c) => c.id)).toEqual(['heading', 'body', 'link', 'button', 'focus']);
    expect(report.scrim.ratio).toBeLessThanOrEqual(1.2);
  });

  it('fails a family whose button text is unreadable', () => {
    const colors = BACKDROP_FAMILIES.unc;
    const report = cardContrast({ palette: colors.palette, card: { ...colors.card, button: '#a9cbea' } });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.id === 'button')?.pass).toBe(false);
  });
});

describe('the scrim', () => {
  const card = { x: 400, y: 150, width: 440, height: 520 };
  it('covers the card and its margin at SCRIM.alpha, and fades to nothing', () => {
    const feather = scrimFeather(1240, 820);
    for (const [x, y] of [
      [400, 150],
      [620, 410],
      [840, 670],
      [390, 140],
    ] as const) {
      expect(scrimAlpha(x, y, card, feather)).toBe(SCRIM.alpha);
    }
    expect(scrimAlpha(0, 0, card, feather)).toBe(0);
    const near = scrimAlpha(400 - SCRIM.margin - 10, 400, card, feather);
    const far = scrimAlpha(400 - SCRIM.margin - 60, 400, card, feather);
    expect(near).toBeGreaterThan(far);
    expect(far).toBeGreaterThan(0);
  });

  it('has a sensible default card: centered, 440px, narrower on phones', () => {
    expect(defaultCardRect(1440, 900)).toEqual({ x: 500, y: 170, width: 440, height: 560 });
    expect(defaultCardRect(390, 844).width).toBe(358);
  });
});

describe('drawBackdropStill', () => {
  it('draws a still frame with the scrim into any 2D context', () => {
    const canvas = new RecordingCanvas(640, 400);
    const ctx = canvas.getContext('2d');
    drawBackdropStill(ctx as unknown as CanvasRenderingContext2D, { style: 'aurora', seed: 'still', family: 'unc', width: 320, height: 200, pixelRatio: 2, createCanvas: recordingCanvasFactory() });
    expect(ctx.counts.images).toBeGreaterThanOrEqual(2);
    const again = new RecordingCanvas(640, 400);
    drawBackdropStill(again.getContext('2d') as unknown as CanvasRenderingContext2D, { style: 'aurora', seed: 'still', family: 'unc', width: 320, height: 200, pixelRatio: 2, createCanvas: recordingCanvasFactory(), scrim: false });
    expect(again.getContext('2d').counts.images).toBe(ctx.counts.images - 1);
  });

  it('refuses bad seeds, families, and palettes', () => {
    const base = { style: 'aurora' as const, width: 10, height: 10, createCanvas: recordingCanvasFactory() };
    const ctx = new RecordingCanvas().getContext('2d') as unknown as CanvasRenderingContext2D;
    expect(() => drawBackdropStill(ctx, { ...base, seed: '' })).toThrow(/seed/);
    expect(() => drawBackdropStill(ctx, { ...base, seed: 'x', family: 'acme' as never })).toThrow(/family/);
    expect(() => drawBackdropStill(ctx, { ...base, seed: 'x', palette: { page: 'white' } })).toThrow(/palette.page/);
  });
});

describe('families', () => {
  it('pins the brand colors from the design report (a change here is a brand decision)', () => {
    expect(BACKDROP_FAMILIES.osbm.card).toMatchObject({ heading: '#092940', body: '#3c434b', link: '#1668b0', button: '#1e79c8', focus: '#3892e1', rule: '#092940' });
    expect(BACKDROP_FAMILIES.unc.card).toMatchObject({ link: '#007fae', button: '#13294b', rule: '#4b9cd3' });
    expect(BACKDROP_FAMILIES.personal.card).toMatchObject({ link: '#1c326e', button: '#1c1917', rule: '#1c326e' });
    expect(backdropPalette('osbm')).toMatchObject({ page: '#f3f4f6', primary: '#1e79c8', ink: '#092940' });
    expect(backdropPalette('unc')).toMatchObject({ primary: '#4b9cd3', secondary: '#007fae', ink: '#13294b' });
    expect(backdropPalette('personal')).toMatchObject({ primary: '#1c326e', ink: '#1c1917' });
    expect(backdropPalette('osbm', { page: '#ffffff' }).page).toBe('#ffffff');
  });

  it('lists the styles', () => {
    expect(BACKDROP_STYLES).toContain('painted');
    expect(offeredStyles()).toHaveLength(8);
  });
});

describe('picker model', () => {
  it('compares choices, reads lock status, and describes a choice', () => {
    expect(sameChoice({ style: 'aurora', seed: 'a', styleVersion: 1 }, { style: 'aurora', seed: 'a' })).toBe(true);
    expect(sameChoice({ style: 'aurora', seed: 'a' }, { style: 'aurora', seed: 'b' })).toBe(false);
    expect(sameChoice(null, { style: 'aurora', seed: 'a' })).toBe(false);
    expect(lockStatus({ style: 'aurora', seed: 'a', styleVersion: 1, locked: true })).toBe('locked');
    expect(lockStatus({ style: 'aurora' })).toBe('unlocked');
    expect(lockStatus(null)).toBe('unlocked');
    expect(describeChoice({ style: 'flow-lines', seed: 'k3f9', styleVersion: 1 })).toBe('Flow lines v1 · k3f9');
  });

  it('offers no upgrade while every locked version is the newest', () => {
    expect(upgradeOffer({ style: 'aurora', seed: 'a', styleVersion: 1, locked: true })).toBeNull();
    expect(upgradeOffer({ style: 'aurora', seed: 'a' })).toBeNull();
  });
});
