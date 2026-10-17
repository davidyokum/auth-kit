/**
 * The production-build check (03 §2: "a CI test fails if a production build contains it").
 *
 * Run after `next build`. It fails if the build output contains the dev sign-in marker (the route
 * handler or the persona menu was bundled) or registers the dev route in any route manifest or
 * route file. It skips `.next/cache` and `.next/dev` (where Next 16 keeps `next dev` output), and it
 * refuses a directory that isn't a production build, because "no build" isn't "no dev code".
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { DEV_SIGN_IN_ROUTE, DEV_SIGNIN_MARKER } from './marker.js';

export interface ProductionBuildCheckOptions {
  /** The build output, e.g. `.next`. */
  buildDir: string;
  /** Default `/api/dev/sign-in`. */
  devRoute?: string;
  /** Strings that must not appear. Default: the dev sign-in marker. */
  markers?: readonly string[];
  /** Top-level directories to skip. Default `['cache', 'dev']`. */
  skip?: readonly string[];
}

export type ProductionBuildFindingKind = 'not-a-build' | 'marker' | 'route-file' | 'route-manifest';

export interface ProductionBuildFinding {
  kind: ProductionBuildFindingKind;
  /** Relative to the build directory. */
  file?: string;
  detail: string;
}

export interface ProductionBuildCheckResult {
  ok: boolean;
  findings: ProductionBuildFinding[];
  filesScanned: number;
}

const MANIFESTS = [
  'app-path-routes-manifest.json',
  'routes-manifest.json',
  'prerender-manifest.json',
  'server/app-paths-manifest.json',
  'server/pages-manifest.json',
  'server/middleware-manifest.json',
];

async function walk(dir: string, skip: ReadonlySet<string>, root: string, out: string[]): Promise<void> {
  const entries = (await readdir(dir, { withFileTypes: true })).sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (dir === root && skip.has(entry.name)) continue;
      await walk(path, skip, root, out);
    } else if (entry.isFile()) out.push(path);
  }
}

function routeStrings(route: string): string[] {
  return [route, `${route}/route`];
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      collectStrings(v, out);
    }
  }
}

/** Scans a production build for the dev sign-in code and route. Never throws on findings; read `ok`. */
export async function checkProductionBuild(options: ProductionBuildCheckOptions): Promise<ProductionBuildCheckResult> {
  const root = options.buildDir;
  const route = (options.devRoute ?? DEV_SIGN_IN_ROUTE).replace(/\/+$/, '');
  const markers = (options.markers ?? [DEV_SIGNIN_MARKER]).filter(Boolean).map((m) => Buffer.from(m));
  const skip = new Set(options.skip ?? ['cache', 'dev']);
  const findings: ProductionBuildFinding[] = [];

  try {
    if (!(await stat(root)).isDirectory()) throw new Error('not a directory');
    await stat(join(root, 'BUILD_ID'));
  } catch {
    return {
      ok: false,
      filesScanned: 0,
      findings: [{ kind: 'not-a-build', detail: `${root} isn't a production build (no BUILD_ID). Run \`next build\` first.` }],
    };
  }

  const files: string[] = [];
  await walk(root, skip, root, files);
  const routeFileEnds = [`${sep}app${route.split('/').join(sep)}${sep}route.js`, `${sep}pages${route.split('/').join(sep)}.js`];

  for (const file of files) {
    const rel = relative(root, file);
    if (routeFileEnds.some((end) => file.endsWith(end))) {
      findings.push({ kind: 'route-file', file: rel, detail: `the build has a route file for ${route}` });
    }
    const bytes = await readFile(file);
    for (const marker of markers) {
      if (bytes.includes(marker)) findings.push({ kind: 'marker', file: rel, detail: 'contains the dev sign-in marker (the route handler or persona menu was bundled)' });
    }
  }

  for (const manifest of MANIFESTS) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(root, manifest), 'utf8'));
    } catch {
      continue;
    }
    const strings: string[] = [];
    collectStrings(parsed, strings);
    const wanted = routeStrings(route);
    if (strings.some((s) => wanted.includes(s))) {
      findings.push({ kind: 'route-manifest', file: manifest, detail: `registers the route ${route}` });
    }
  }

  return { ok: findings.length === 0, findings, filesScanned: files.length };
}

/** Throws with every finding unless the build is clean. */
export async function assertProductionBuild(options: ProductionBuildCheckOptions): Promise<ProductionBuildCheckResult> {
  const result = await checkProductionBuild(options);
  if (!result.ok) {
    throw new Error(
      `auth-kit: the production build isn't clean:\n${result.findings.map((f) => `- ${f.file ? `${f.file}: ` : ''}${f.detail}`).join('\n')}`,
    );
  }
  return result;
}
