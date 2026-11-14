import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { manifestFromTarball, satisfies, tarballUrl, upgradeKit } from '../../src/ops/upgrade.js';

/** A one-file npm tarball (ustar, gzip'd) holding package/package.json. */
function tarball(manifest: object): Uint8Array {
  const body = Buffer.from(JSON.stringify(manifest));
  const header = Buffer.alloc(512);
  header.write('package/package.json', 0, 'utf8');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write('0', 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  let sum = 0;
  for (const b of header) sum += b;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
  return gzipSync(Buffer.concat([header, body, pad, Buffer.alloc(1024)]));
}

const OLD = tarballUrl('0.1.13-alpha.1');
const NEW = tarballUrl('0.1.16-alpha.1');

const MANIFEST = {
  name: 'auth-kit',
  version: '0.1.16-alpha.1',
  license: 'MIT',
  dependencies: { 'aws-jwt-verify': '^5.2.1', '@aws-sdk/client-sesv2': '^3.1152.0' },
  peerDependencies: { next: '^16.0.0' },
  peerDependenciesMeta: { next: { optional: true } },
  engines: { node: '>=22.12' },
  bin: { 'auth-kit': './dist/bin/auth-kit.js' },
};

let dir: string;
const pkg = { name: 'site', dependencies: { 'auth-kit': OLD, next: '16.4.2' } };
const lock = {
  name: 'site',
  lockfileVersion: 3,
  requires: true,
  packages: {
    '': { name: 'site', dependencies: { 'auth-kit': OLD, next: '16.4.2' } },
    'node_modules/auth-kit': { version: '0.1.13-alpha.1', resolved: OLD, integrity: 'sha512-old', license: 'MIT', dependencies: { 'aws-jwt-verify': '^5.2.1' } },
    'node_modules/auth-kit/node_modules/aws-jwt-verify': { version: '5.2.1' },
    'node_modules/@aws-sdk/client-sesv2': { version: '3.1160.0' },
    'node_modules/semver': { version: '7.8.5', resolved: 'https://registry.npmjs.org/semver/-/semver-7.8.5.tgz', integrity: 'sha512-keep' },
  },
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'auth-kit-upgrade-'));
  await writeFile(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  await writeFile(join(dir, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const tgz = tarball(MANIFEST);
const fetchTgz = vi.fn(() => Promise.resolve(new Response(new Uint8Array(tgz).buffer)));

describe('auth-kit upgrade', () => {
  it('changes only the kit’s lines, with the tarball’s real integrity, then checks with Amplify’s npm', async () => {
    const run = vi.fn(() => Promise.resolve({ code: 0, output: 'ok' }));
    const report = await upgradeKit({ cwd: dir, target: '0.1.16-alpha.1', fetch: fetchTgz, run });
    expect(report).toEqual({ from: '0.1.13-alpha.1', to: '0.1.16-alpha.1', changed: true, verified: true });
    const nextPkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    const nextLock = JSON.parse(await readFile(join(dir, 'package-lock.json'), 'utf8'));
    expect(nextPkg.dependencies).toEqual({ 'auth-kit': NEW, next: '16.4.2' });
    expect(nextLock.packages[''].dependencies['auth-kit']).toBe(NEW);
    expect(nextLock.packages['node_modules/auth-kit']).toEqual({
      version: '0.1.16-alpha.1',
      resolved: NEW,
      integrity: `sha512-${createHash('sha512').update(tgz).digest('base64')}`,
      license: 'MIT',
      dependencies: MANIFEST.dependencies,
      peerDependencies: MANIFEST.peerDependencies,
      peerDependenciesMeta: MANIFEST.peerDependenciesMeta,
      engines: MANIFEST.engines,
      // As npm writes it: no leading ./
      bin: { 'auth-kit': 'dist/bin/auth-kit.js' },
    });
    // Every other line as it was.
    expect(nextLock.packages['node_modules/semver']).toEqual(lock.packages['node_modules/semver']);
    expect(Object.keys(nextLock.packages as Record<string, unknown>)).toEqual(Object.keys(lock.packages));
    expect(run).toHaveBeenCalledWith('npx', ['-y', 'npm@10.9.9', 'ci', '--dry-run', '--ignore-scripts', '--no-audit', '--no-fund']);
    // Once before (the lockfile as it was), once after.
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('changes nothing when the lockfile already fails npm ci, and shows npm’s reason, not its usage text', async () => {
    const before = await readFile(join(dir, 'package-lock.json'), 'utf8');
    const output = ['npm error code EUSAGE', 'npm error `npm ci` can only install packages when your package.json and package-lock.json are in sync.', "npm error Invalid: lock file's semver@7.8.5 does not satisfy semver@7.8.6", 'npm error', 'npm error Clean install a project', 'npm error', 'npm error Usage:', 'npm error npm ci'].join('\n');
    const run = vi.fn(() => Promise.resolve({ code: 1, output }));
    const error = (await upgradeKit({ cwd: dir, target: '0.1.16-alpha.1', fetch: fetchTgz, run }).catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/already fails npm 10\.9\.9 ci, before any change/);
    expect(error.message).toMatch(/semver@7\.8\.5 does not satisfy semver@7\.8\.6/);
    expect(error.message).not.toMatch(/Usage:|Clean install/);
    expect(run).toHaveBeenCalledTimes(1);
    expect(await readFile(join(dir, 'package-lock.json'), 'utf8')).toBe(before);
  });

  it('puts both files back when npm ci refuses the result', async () => {
    const before = await readFile(join(dir, 'package-lock.json'), 'utf8');
    const run = vi
      .fn<(c: string, a: readonly string[]) => Promise<{ code: number; output: string }>>()
      .mockResolvedValueOnce({ code: 0, output: '' })
      .mockResolvedValueOnce({ code: 1, output: 'npm error `npm ci` can only install packages when your package.json and package-lock.json are in sync\nnpm error\nnpm error Clean install a project\nnpm error\nnpm error Usage:' });
    await expect(upgradeKit({ cwd: dir, target: '0.1.16-alpha.1', fetch: fetchTgz, run })).rejects.toThrow(/both files are back as they were:\n.*in sync/);
    expect(await readFile(join(dir, 'package-lock.json'), 'utf8')).toBe(before);
    expect(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).dependencies['auth-kit']).toBe(OLD);
  });

  it('changes nothing when the new release needs a dependency the lockfile can’t give', async () => {
    const needsMore = tarball({ ...MANIFEST, dependencies: { 'aws-jwt-verify': '^6.0.0' } });
    const f = vi.fn(() => Promise.resolve(new Response(new Uint8Array(needsMore).buffer))) as unknown as typeof fetch;
    await expect(upgradeKit({ cwd: dir, target: '0.1.16-alpha.1', fetch: f, noVerify: true })).rejects.toThrow(/needs aws-jwt-verify@\^6\.0\.0 \(lockfile has 5\.2\.1\).*Nothing was changed/s);
    expect(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).dependencies['auth-kit']).toBe(OLD);
  });

  it('says so when the release isn’t published, and refuses something that isn’t a version', async () => {
    const missing = vi.fn(() => Promise.resolve(new Response('Not Found', { status: 404 }))) as unknown as typeof fetch;
    await expect(upgradeKit({ cwd: dir, target: '0.1.99-alpha.1', fetch: missing })).rejects.toThrow(/answered 404/);
    await expect(upgradeKit({ cwd: dir, target: 'latest-ish' })).rejects.toThrow(/isn't a release version/);
  });

  it('does nothing when the site is already on that release', async () => {
    const f = vi.fn() as unknown as typeof fetch;
    const report = await upgradeKit({ cwd: dir, target: '0.1.13-alpha.1', fetch: f });
    expect(report.changed).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('the pieces', () => {
  it('reads package.json out of a tarball', () => {
    expect(manifestFromTarball(tgz).version).toBe('0.1.16-alpha.1');
  });

  it('checks caret ranges as npm does for the kit’s own dependencies', () => {
    expect(satisfies('5.2.1', '^5.2.1')).toBe(true);
    expect(satisfies('5.9.0', '^5.2.1')).toBe(true);
    expect(satisfies('6.0.0', '^5.2.1')).toBe(false);
    expect(satisfies('5.2.0', '^5.2.1')).toBe(false);
    expect(satisfies('0.3.4', '^0.3.1')).toBe(true);
    expect(satisfies('0.4.0', '^0.3.1')).toBe(false);
    expect(satisfies('22.12.0', '>=22.12')).toBe(true);
  });
});
