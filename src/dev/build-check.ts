/**
 * The production-build check (03 §2: "a CI test fails if a production build contains it").
 *
 * Run after `next build`. It fails if the build output contains the dev sign-in marker (the route
 * handler or the persona menu was bundled) or the auth matrix's server-mode marker
 * (`auth-kit/testing/matrix-server` was bundled) or the backdrop picker's marker
 * (`auth-kit/backdrops/picker` was bundled) or preview mode's marker (`auth-kit/preview` was
 * bundled; ADR 0025), or registers the dev route in any route manifest
 * or route file. It skips `.next/cache` and `.next/dev` (where Next 16 keeps `next dev` output), and it
 * refuses a directory that isn't a production build, because "no build" isn't "no dev code".
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { BACKDROP_PICKER_MARKER, DEV_SIGN_IN_ROUTE, DEV_SIGNIN_MARKER, MATRIX_SERVER_MARKER, PREVIEW_MARKER } from './marker.js';

export interface ProductionBuildCheckOptions {
  /** The build output, e.g. `.next`. */
  buildDir: string;
  /** Default `/api/dev/sign-in`. */
  devRoute?: string;
  /** Strings that must not appear. Default: the dev sign-in, matrix server-mode, backdrop picker, and preview markers. */
  markers?: readonly string[];
  /** Top-level directories to skip. Default `['cache', 'dev']`. */
  skip?: readonly string[];
  /**
   * Content that only signed-in people may see (`protectedPhrases`): none of it may appear in the
   * build's public files (`static/`, served to anyone who has a file's address, signed in or not).
   */
  protected?: readonly ProtectedSource[];
}

/** One source of protected content: a label for findings (a file's path) and the phrases from it. */
export interface ProtectedSource {
  label: string;
  phrases: readonly string[];
}

export type ProductionBuildFindingKind = 'not-a-build' | 'marker' | 'route-file' | 'route-manifest' | 'protected-content';

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

/** What each built-in marker means when a build contains it. */
const MARKER_MEANING: Readonly<Record<string, string>> = {
  [DEV_SIGNIN_MARKER]: 'contains the dev sign-in marker (the route handler or persona menu was bundled)',
  [MATRIX_SERVER_MARKER]: "contains the auth matrix's server-mode marker (auth-kit/testing/matrix-server was bundled; import it only through a withDevKit alias)",
  [BACKDROP_PICKER_MARKER]: 'contains the backdrop picker marker (auth-kit/backdrops/picker was bundled; import it only from a dev-only page such as page.dev.tsx)',
  [PREVIEW_MARKER]: "contains preview mode's marker (auth-kit/preview was bundled; it draws sample screens for design tools and screenshots, never a site's sign-in)",
};

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
  const markers = (options.markers ?? [DEV_SIGNIN_MARKER, MATRIX_SERVER_MARKER, BACKDROP_PICKER_MARKER, PREVIEW_MARKER]).filter(Boolean).map((m) => ({ text: m, bytes: Buffer.from(m) }));
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

  const protectedNeedles = (options.protected ?? []).map((source) => ({ label: source.label, needles: source.phrases.flatMap(encodings).map((n) => Buffer.from(n)) }));
  for (const file of files) {
    const rel = relative(root, file);
    if (routeFileEnds.some((end) => file.endsWith(end))) {
      findings.push({ kind: 'route-file', file: rel, detail: `the build has a route file for ${route}` });
    }
    const bytes = await readFile(file);
    for (const marker of markers) {
      if (bytes.includes(marker.bytes)) findings.push({ kind: 'marker', file: rel, detail: MARKER_MEANING[marker.text] ?? `contains the marker "${marker.text}"` });
    }
    // Public files only: the server's own bundles may hold protected content, and serve it after a check.
    if (rel.split(sep)[0] === 'static') {
      for (const source of protectedNeedles) {
        const hits = source.needles.filter((n) => bytes.includes(n)).length;
        // Never the phrase itself: the finding goes to CI logs.
        if (hits > 0) findings.push({ kind: 'protected-content', file: rel, detail: `holds ${hits} protected phrase${hits === 1 ? '' : 's'} from ${source.label} (a public file: anyone with its address can download it, signed in or not)` });
      }
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

/** A phrase as it may sit in a bundle: as written, JSON-escaped, and with non-ASCII as `\\uXXXX`. */
function encodings(phrase: string): string[] {
  const json = JSON.stringify(phrase).slice(1, -1);
  const ascii = json.replace(/[\u0080-\uffff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return [...new Set([phrase, json, ascii])];
}

/** Below this, a phrase is too common to mean a leak (a word, a short label). */
export const MIN_PROTECTED_PHRASE = 12;

/**
 * The protected phrases in a file's text, by its kind: a `.txt` file is one phrase per line (any
 * length from 4 characters: names, say); `.json`, every string value; code (`.ts`, `.js`, …), every
 * string literal; anything else (Markdown, CSV, YAML), every line. Shorter than
 * `MIN_PROTECTED_PHRASE` is dropped outside `.txt`.
 */
export function protectedPhrases(path: string, text: string): string[] {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  const out = new Set<string>();
  const keep = (value: string, min = MIN_PROTECTED_PHRASE) => {
    const v = value.trim();
    if (v.length >= min) out.add(v);
  };
  if (ext === '.txt') {
    for (const line of text.split(/\r?\n/)) if (!line.trim().startsWith('#')) keep(line, 4);
  } else if (ext === '.json') {
    const walkJson = (value: unknown): void => {
      if (typeof value === 'string') keep(value);
      else if (Array.isArray(value)) value.forEach(walkJson);
      else if (value && typeof value === 'object') Object.values(value).forEach(walkJson);
    };
    walkJson(JSON.parse(text));
  } else if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'].includes(ext)) {
    for (const m of text.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\$]|\\.)*)`/g)) keep(m[1] ?? m[2] ?? m[3] ?? '');
  } else {
    for (const line of text.split(/\r?\n/)) keep(line.replace(/^[#>*\-\s|]+/, ''));
  }
  return [...out];
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
