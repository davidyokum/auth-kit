/**
 * Locked backdrops must draw the same picture on every later auth-kit (ADR 0021). Each released
 * style version, and the kernel it draws with, has a frozen hash in frozen.json: what it asks the
 * canvas to draw for a fixed seed, palette, and script of frames (scenes.ts). A changed hash means a
 * released version changed: put the change in a new version instead.
 *
 * Adding a version: run `AUTH_KIT_FREEZE_NEW=1 npx vitest run test/backdrops/frozen.test.ts` once.
 * It records hashes for versions that have none, and never rewrites an existing one.
 */
import './preload.js';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastRatio, mix, parseHex, rgba, saturate, toOklab } from '../../src/backdrops/kernel/v1/color.js';
import { createNoise } from '../../src/backdrops/kernel/v1/noise.js';
import { createRng, hashParts, hashString, seedString } from '../../src/backdrops/kernel/v1/prng.js';
import { cardDistance, smoothstep } from '../../src/backdrops/kernel/v1/shape.js';
import { buildSetup, layerFactory, resolveArt } from '../../src/backdrops/frame.js';
import { RecordingCanvas, recordingCanvasFactory, resetCanvasIds } from './recording-canvas.js';
import { allStyleVersions, frozenHash, TEST_PALETTE } from './scenes.js';

const FILE = join(import.meta.dirname, 'frozen.json');

/** The kernel's outputs over a fixed battery of inputs. */
function kernelV1Hash(): string {
  const out: string[] = [];
  for (const s of ['', 'a', 'Example Site', 'k3f9x2ab', 'ünïcödé']) out.push(String(hashString(s)), seedString(hashString(s)));
  out.push(String(hashParts('variation', 'salt', 'aurora', 3)));
  const rng = createRng(hashString('kernel'));
  for (let i = 0; i < 64; i++) out.push(rng.next().toFixed(12));
  for (let i = 0; i < 16; i++) out.push(rng.normal().toFixed(9), String(rng.int(1000)), rng.range(-5, 5).toFixed(9));
  out.push(rng.shuffle([1, 2, 3, 4, 5, 6, 7, 8]).join(','));
  const fork = rng.fork('x');
  out.push(fork.next().toFixed(12));
  const noise = createNoise(createRng(hashString('noise')));
  for (let i = 0; i < 64; i++) {
    const x = i * 0.37 - 7;
    const y = i * 0.53 + 3;
    out.push(noise.noise2(x, y).toFixed(9), noise.noise3(x, y, i * 0.11).toFixed(9), noise.fbm2(x, y, 3).toFixed(9), noise.fbm3(x, y, 0.5, 4).toFixed(9));
  }
  out.push(rgba('#1e79c8', 0.33), rgba(mix('#092940', '#f3f4f6', 0.4), 0.5), String(saturate('#4b9cd3', 0.5)), String(toOklab(parseHex('#13294b'))), contrastRatio('#1e79c8', '#ffffff').toFixed(6));
  out.push(smoothstep(0, 1, 0.3).toFixed(9), cardDistance(10, 20, { x: 100, y: 100, width: 200, height: 300 }, 800, 600).toFixed(9));
  return createHash('sha256').update(out.join('|')).digest('hex');
}

/**
 * The plotter core (styles/plotter/v1.ts) through the three styles that draw with it, at desktop size: the
 * 360 × 240 scenes leave no room for a map, so this pins the map, labelling, and lettering paths too.
 */
function plotterV1Hash(): string {
  const out: string[] = [];
  const subjects: [string, string][] = [
    ['county-survey', 'Dare'],
    ['county-survey', 'Buncombe'],
    ['river-basins', 'Cape Fear'],
    ['star-chart', 'Cyg'],
  ];
  for (const [style, subject] of subjects) {
    resetCanvasIds();
    const art = resolveArt({ style: style as never, seed: 'frozen-seed', styleVersion: 1, palette: TEST_PALETTE });
    const instance = art.version.create(
      buildSetup({ art, width: 1280, height: 800, pixelRatio: 1, card: { x: 420, y: 140, width: 440, height: 520 }, motion: true, createLayer: layerFactory(recordingCanvasFactory(), 1), subject, siteName: 'Example Site' }),
    );
    const ctx = new RecordingCanvas(1280, 800).getContext('2d');
    const draw = (t: number, x: number, y: number, strength: number) => instance.draw(ctx as unknown as CanvasRenderingContext2D, { t, dt: 1 / 30, pointer: { x, y, strength } });
    const t0 = art.version.stillTime;
    draw(t0, -1e6, -1e6, 0);
    for (let i = 1; i <= 3; i++) draw(t0 + 1 + i / 30, 1060, 380, 1);
    for (let i = 1; i <= 3; i++) draw(t0 + 1.2 + i / 30, 220, 420, 1);
    instance.tap?.(1060, 380, t0 + 1.3);
    instance.tap?.(220, 420, t0 + 1.3);
    instance.tap?.(640, 740, t0 + 1.4);
    draw(t0 + 3, 640, 740, 0.6);
    out.push(ctx.digest());
  }
  return createHash('sha256').update(out.join('|')).digest('hex');
}

async function actualHashes(): Promise<Record<string, string>> {
  const out: Record<string, string> = { 'kernel@1': kernelV1Hash(), 'plotter@1': plotterV1Hash() };
  for (const { style, version } of allStyleVersions()) out[`${style}@${version}`] = await frozenHash(style, version);
  return out;
}

describe('frozen style versions', () => {
  it('every released version draws exactly what it drew when it was frozen', async () => {
    const frozen = JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, string>;
    const actual = await actualHashes();
    if (process.env.AUTH_KIT_FREEZE_NEW === '1') {
      const added = Object.keys(actual).filter((k) => frozen[k] === undefined);
      for (const key of added) frozen[key] = actual[key] as string;
      const sorted = Object.fromEntries(Object.entries(frozen).sort(([a], [b]) => (a < b ? -1 : 1)));
      writeFileSync(FILE, `${JSON.stringify(sorted, null, 2)}\n`);
    }
    for (const [key, hash] of Object.entries(actual)) {
      expect(frozen[key], `${key} has no frozen hash. If it's new, run AUTH_KIT_FREEZE_NEW=1 npx vitest run test/backdrops/frozen.test.ts`).toBeDefined();
      expect(hash, `${key} changed what it draws. Released versions are frozen (ADR 0021): add a new version instead.`).toBe(frozen[key]);
    }
  });

  it('no frozen version has been removed (sites may have locked it)', async () => {
    const frozen = JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, string>;
    const actual = await actualHashes();
    for (const key of Object.keys(frozen)) expect(actual[key], `${key} is frozen but no longer registered`).toBeDefined();
  });

  it('the hash covers the drawing: another seed or version script differs', async () => {
    const a = await frozenHash('contours', 1);
    const b = await frozenHash('contours', 1);
    expect(a).toBe(b);
    expect(await frozenHash('ripples', 1)).not.toBe(a);
  });
});
