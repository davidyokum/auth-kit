/**
 * `npx auth-kit upgrade <version>`: moves a site to another auth-kit release by changing only the
 * kit's own lines: the dependency in `package.json`, and in `package-lock.json` the root's entry and
 * `node_modules/auth-kit` (version, resolved, integrity, and what the new release declares).
 *
 * Why not `npm install <url>`: it re-resolves the whole tree. Twice that broke a site's next Amplify
 * build, because the npm on the Mac wrote a lockfile Amplify's npm refused (a dropped bundled entry,
 * a semver that no longer satisfied a range). Keeping every other line as it was keeps what already
 * built building.
 *
 * Then it checks the result the way Amplify will run it, `npm ci --dry-run` with Amplify's npm
 * (`npx npm@<version>`), and puts both files back if that fails. When the new release needs a
 * dependency the lockfile can't satisfy, it changes nothing and says which, since that one does need
 * a wider `npm install`.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

/** The npm Amplify's build image runs (its Node 22 image, checked 2026-11-09 on a site's build log). */
export const AMPLIFY_NPM_VERSION = '10.9.9';

export const RELEASES = 'https://github.com/davidyokum/auth-kit/releases/download';

export function tarballUrl(version: string): string {
  return `${RELEASES}/v${version}/auth-kit-${version}.tgz`;
}

export interface UpgradeOptions {
  /** The site's root (where package.json and package-lock.json are). */
  cwd: string;
  /** A release version (`0.1.16-alpha.1`) or a tarball URL. */
  target: string;
  /** Default: global fetch. */
  fetch?: typeof fetch;
  /** Runs a command in `cwd`; resolves its exit code and output. Default: none (pass one to verify). */
  run?: (command: string, args: readonly string[]) => Promise<{ code: number; output: string }>;
  /** Default `AMPLIFY_NPM_VERSION`. */
  npmVersion?: string;
  /** Skip `npm ci --dry-run`. */
  noVerify?: boolean;
  log?: (line: string) => void;
}

export interface UpgradeReport {
  from: string | undefined;
  to: string;
  /** False when the version was already the one in use (nothing written). */
  changed: boolean;
  verified: boolean;
}

interface KitManifest {
  name?: string;
  version?: string;
  license?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, unknown>;
  engines?: Record<string, string>;
  bin?: Record<string, string> | string;
}

type LockEntry = Record<string, unknown> & { version?: string };
interface Lockfile {
  lockfileVersion?: number;
  packages?: Record<string, LockEntry & { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>;
}

/** `package/package.json` out of an npm tarball (gzip'd ustar). */
export function manifestFromTarball(tgz: Uint8Array): KitManifest {
  const tar = gunzipSync(tgz);
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
    const size = Number.parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8);
    const path = prefix ? `${prefix}/${name}` : name;
    const body = tar.subarray(offset + 512, offset + 512 + size);
    if (path === 'package/package.json') return JSON.parse(body.toString('utf8')) as KitManifest;
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error('auth-kit upgrade: the tarball has no package/package.json.');
}

/** `^x.y.z` (the only form auth-kit's own dependencies use), `>=x`, an exact version, or `*`. */
export function satisfies(version: string, range: string): boolean {
  const parse = (v: string) => v.split('-')[0]!.split('.').map((n) => Number.parseInt(n, 10));
  const r = range.trim();
  if (r === '*' || r === '') return true;
  const cmp = (a: number[], b: number[]) => {
    for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
    return 0;
  };
  const v = parse(version);
  if (r.startsWith('>=')) return cmp(v, parse(r.slice(2))) >= 0;
  if (r.startsWith('^')) {
    const base = parse(r.slice(1));
    if (cmp(v, base) < 0) return false;
    const major = base[0] ?? 0;
    if (major > 0) return v[0] === major;
    const minor = base[1] ?? 0;
    if (minor > 0) return v[0] === 0 && v[1] === minor;
    return v[0] === 0 && v[1] === 0 && v[2] === base[2];
  }
  return version === r;
}

function versionFromTarget(target: string): { url: string; version: string | undefined } {
  if (/^https?:\/\//.test(target)) return { url: target, version: /auth-kit-([^/]+)\.tgz$/.exec(target)?.[1] };
  const version = target.replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) throw new Error(`auth-kit upgrade: "${target}" isn't a release version (such as 0.1.16-alpha.1) or a tarball URL.`);
  return { url: tarballUrl(version), version };
}

/** As npm writes `bin` into a lockfile: an object, each path without a leading `./`. */
function normalizedBin(bin: Record<string, string> | string): Record<string, string> {
  const entries = typeof bin === 'string' ? [['auth-kit', bin] as const] : Object.entries(bin);
  return Object.fromEntries(entries.map(([name, path]) => [name, path.replace(/^\.\//, '')]));
}

function indentOf(text: string): string {
  return /^\{\n(\s+)"/.exec(text)?.[1] ?? '  ';
}

export async function upgradeKit(options: UpgradeOptions): Promise<UpgradeReport> {
  const log = options.log ?? (() => {});
  const doFetch = options.fetch ?? fetch;
  const { url } = versionFromTarget(options.target);
  const pkgPath = join(options.cwd, 'package.json');
  const lockPath = join(options.cwd, 'package-lock.json');
  const pkgText = await readFile(pkgPath, 'utf8');
  let lockText: string;
  try {
    lockText = await readFile(lockPath, 'utf8');
  } catch {
    throw new Error('auth-kit upgrade: no package-lock.json here. A site deploys with npm ci, so it needs one.');
  }
  const pkg = JSON.parse(pkgText) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const lock = JSON.parse(lockText) as Lockfile;
  const field = pkg.dependencies?.['auth-kit'] !== undefined ? 'dependencies' : pkg.devDependencies?.['auth-kit'] !== undefined ? 'devDependencies' : null;
  if (!field) throw new Error('auth-kit upgrade: package.json has no auth-kit dependency.');
  const kitEntry = lock.packages?.['node_modules/auth-kit'];
  const root = lock.packages?.[''];
  if (!kitEntry || !root) throw new Error('auth-kit upgrade: package-lock.json has no node_modules/auth-kit entry (lockfile version 2 or 3 is needed). Run npm install once first.');
  const from = kitEntry.version;

  if (pkg[field]!['auth-kit'] === url && kitEntry.resolved === url) {
    log(`Already on ${url}. Nothing changed.`);
    return { from, to: from ?? url, changed: false, verified: false };
  }

  log(`Downloading ${url}`);
  const response = await doFetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`auth-kit upgrade: ${url} answered ${response.status}. Is that release published?`);
  const tgz = new Uint8Array(await response.arrayBuffer());
  const integrity = `sha512-${createHash('sha512').update(tgz).digest('base64')}`;
  const manifest = manifestFromTarball(tgz);
  if (manifest.name !== 'auth-kit' || !manifest.version) throw new Error('auth-kit upgrade: that tarball isn’t an auth-kit release.');

  // Every dependency the new release declares must already be in the lockfile at a version it accepts.
  const missing: string[] = [];
  for (const [dep, range] of Object.entries(manifest.dependencies ?? {})) {
    const nested = lock.packages?.[`node_modules/auth-kit/node_modules/${dep}`];
    const top = lock.packages?.[`node_modules/${dep}`];
    const found = nested?.version ?? top?.version;
    if (!found || !satisfies(found, range)) missing.push(`${dep}@${range} (lockfile has ${found ?? 'none'})`);
  }
  if (missing.length > 0) {
    throw new Error(
      `auth-kit upgrade: ${manifest.version} needs ${missing.join(', ')}, which this lockfile can't give without re-resolving more of the tree. Nothing was changed. Run npm install ${url} with npm ${options.npmVersion ?? AMPLIFY_NPM_VERSION} (npx npm@${options.npmVersion ?? AMPLIFY_NPM_VERSION} install …), then review the lockfile's diff.`,
    );
  }

  pkg[field]!['auth-kit'] = url;
  if (root.dependencies?.['auth-kit'] !== undefined) root.dependencies['auth-kit'] = url;
  if (root.devDependencies?.['auth-kit'] !== undefined) root.devDependencies['auth-kit'] = url;
  const next: LockEntry = { ...kitEntry, version: manifest.version, resolved: url, integrity };
  for (const key of ['license', 'dependencies', 'peerDependencies', 'peerDependenciesMeta', 'engines', 'bin'] as const) {
    if (manifest[key] === undefined) delete next[key];
    else if (key === 'bin') next.bin = normalizedBin(manifest.bin!);
    else next[key] = manifest[key];
  }
  lock.packages!['node_modules/auth-kit'] = next;

  await writeFile(pkgPath, `${JSON.stringify(pkg, null, indentOf(pkgText))}\n`);
  await writeFile(lockPath, `${JSON.stringify(lock, null, indentOf(lockText))}\n`);
  log(`package.json and package-lock.json: auth-kit ${from ?? '?'} → ${manifest.version} (only the kit's lines).`);

  if (options.noVerify || !options.run) return { from, to: manifest.version, changed: true, verified: false };
  const npm = options.npmVersion ?? AMPLIFY_NPM_VERSION;
  log(`Checking with Amplify's npm: npx -y npm@${npm} ci --dry-run`);
  const result = await options.run('npx', ['-y', `npm@${npm}`, 'ci', '--dry-run', '--ignore-scripts', '--no-audit', '--no-fund']);
  if (result.code !== 0) {
    await writeFile(pkgPath, pkgText);
    await writeFile(lockPath, lockText);
    const tail = result.output.trim().split('\n').slice(-12).join('\n');
    throw new Error(`auth-kit upgrade: npm ${npm} ci --dry-run refused the result, so both files are back as they were:\n${tail}`);
  }
  log(`npm ${npm} ci --dry-run accepts the lockfile.`);
  return { from, to: manifest.version, changed: true, verified: true };
}
