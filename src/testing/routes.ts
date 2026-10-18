import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A route the app serves. `path` uses Next's segment syntax (`/api/reports/[id]`, `/docs/[...slug]`,
 * `/opt/[[...rest]]`) or the matrix's (`/api/reports/:id`). `method` narrows coverage to one method
 * (route handlers can export several); without it, a row with any method covers the route.
 */
export interface AppRoute {
  path: string;
  method?: string;
  /** `page` (page.tsx) or `route` (route.ts), from the build manifest. */
  kind?: 'page' | 'route';
}

/** A route as a string (`/api/reports/[id]`, or `POST /api/admin/invite`) or an object. */
export type AppRouteInput = string | AppRoute;

type Segment =
  | { kind: 'static'; value: string }
  | { kind: 'dynamic' }
  | { kind: 'catchAll' }
  | { kind: 'optionalCatchAll' };

/** Rank used to pick the most specific match, segment by segment (Next's order). */
const RANK: Record<Segment['kind'], number> = { static: 3, dynamic: 2, catchAll: 1, optionalCatchAll: 0 };

export interface CompiledRoute {
  /** The route as declared, for messages. */
  label: string;
  /** Canonical pattern, e.g. `/api/reports/[]`. */
  key: string;
  method?: string;
  segments: Segment[];
}

const METHOD_PREFIX = /^([A-Za-z]+)\s+(\/.*)$/;

function parseSegments(path: string): Segment[] {
  const clean = path.split(/[?#]/, 1)[0] ?? '';
  return clean
    .split('/')
    .filter(Boolean)
    .map((raw): Segment => {
      if (/^\[\[\.\.\.[^\]]+\]\]$/.test(raw)) return { kind: 'optionalCatchAll' };
      if (/^\[\.\.\.[^\]]+\]$/.test(raw) || /^:[A-Za-z_][A-Za-z0-9_]*\*$/.test(raw)) return { kind: 'catchAll' };
      if (/^\[[^\]]+\]$/.test(raw) || /^:[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) return { kind: 'dynamic' };
      return { kind: 'static', value: raw };
    });
}

function keyOf(segments: Segment[]): string {
  const parts = segments.map((s) =>
    s.kind === 'static' ? s.value : s.kind === 'dynamic' ? '[]' : s.kind === 'catchAll' ? '[...]' : '[[...]]',
  );
  return `/${parts.join('/')}`;
}

/** Parses an app route declaration. Throws on anything that isn't a path. */
export function compileAppRoute(input: AppRouteInput): CompiledRoute {
  let path: string;
  let method: string | undefined;
  if (typeof input === 'string') {
    const m = METHOD_PREFIX.exec(input.trim());
    path = m?.[2] ?? input.trim();
    method = m?.[1]?.toUpperCase();
  } else {
    path = input.path;
    method = input.method?.toUpperCase();
  }
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new Error(`auth-matrix: app route ${JSON.stringify(input)} must be a path starting with "/".`);
  }
  const segments = parseSegments(path);
  return { label: typeof input === 'string' ? input : `${method ? `${method} ` : ''}${path}`, key: keyOf(segments), segments, ...(method !== undefined && { method }) };
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The rank vector of `route` matching the concrete `segments`, or null when it doesn't match. */
function matchRank(route: Segment[], concrete: readonly string[]): number[] | null {
  const rank: number[] = [];
  let i = 0;
  for (const [index, seg] of route.entries()) {
    if (seg.kind === 'catchAll' || seg.kind === 'optionalCatchAll') {
      // Catch-alls are always last in Next routes.
      if (index !== route.length - 1) return null;
      const rest = concrete.length - i;
      if (seg.kind === 'catchAll' && rest < 1) return null;
      rank.push(RANK[seg.kind]);
      return rank;
    }
    const part = concrete[i];
    if (part === undefined) return null;
    if (seg.kind === 'static' && safeDecode(part) !== seg.value) return null;
    rank.push(RANK[seg.kind]);
    i += 1;
  }
  return i === concrete.length ? rank : null;
}

function compareRanks(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The app route a concrete URL path resolves to (most specific first, the way Next routes), or
 * undefined when none does.
 */
export function resolveAppRoute(routes: readonly CompiledRoute[], urlPath: string): CompiledRoute | undefined {
  const concrete = (urlPath.split(/[?#]/, 1)[0] ?? '').split('/').filter(Boolean);
  let best: { route: CompiledRoute; rank: number[] } | undefined;
  for (const route of routes) {
    const rank = matchRank(route.segments, concrete);
    if (rank && (!best || compareRanks(rank, best.rank) > 0)) best = { route, rank };
  }
  return best?.route;
}

/** Next's own internal routes, never part of an app's matrix. */
const NEXT_INTERNAL_ROUTES = new Set(['/_not-found', '/_global-error', '/_app', '/_document', '/_error', '/404', '/500']);

export interface RoutesFromNextBuildOptions {
  /** Paths to leave out, each with a reason in code review (e.g. a metadata route like `/favicon.ico`). */
  exclude?: readonly (string | RegExp)[];
  /**
   * The page the server's page guards send an account with only emailed codes to (`firstCredentialPath`
   * in `auth-kit/server`, default `/account/sign-in-method`). The build must have it, or every new
   * invitee lands on a 404 after their first code. `false` only when the server turns the rule off
   * (`requireFirstCredential: false`).
   */
  firstCredentialPath?: string | false;
}

/** Where the page guards send an account with only emailed codes, unless the site says otherwise. */
export const DEFAULT_FIRST_CREDENTIAL_PATH = '/account/sign-in-method';

/**
 * Every route in a Next build (`next build` must have run): the App Router's pages and route
 * handlers from `app-path-routes-manifest.json`, plus any Pages Router pages. Next's internal routes
 * (`/_not-found`, `/_global-error`, `/404`, …) are left out. Pass the result as the matrix's
 * `appRoutes` so a route without a matrix row fails the test.
 */
export function routesFromNextBuild(distDir = '.next', options: RoutesFromNextBuildOptions = {}): AppRoute[] {
  const appManifest = join(distDir, 'app-path-routes-manifest.json');
  const pagesManifest = join(distDir, 'server', 'pages-manifest.json');
  if (!existsSync(appManifest) && !existsSync(pagesManifest)) {
    throw new Error(`auth-matrix: no Next build manifest in ${distDir}. Run \`next build\` before the matrix.`);
  }
  const found = new Map<string, AppRoute>();
  if (existsSync(appManifest)) {
    const entries = JSON.parse(readFileSync(appManifest, 'utf8')) as Record<string, string>;
    for (const [source, path] of Object.entries(entries)) {
      const kind = source.endsWith('/route') ? 'route' : 'page';
      found.set(path, { path, kind });
    }
  }
  if (existsSync(pagesManifest)) {
    const entries = JSON.parse(readFileSync(pagesManifest, 'utf8')) as Record<string, string>;
    for (const path of Object.keys(entries)) {
      if (!found.has(path)) found.set(path, { path, kind: path.startsWith('/api/') ? 'route' : 'page' });
    }
  }
  const chooser = options.firstCredentialPath === undefined ? DEFAULT_FIRST_CREDENTIAL_PATH : options.firstCredentialPath;
  if (chooser !== false && found.get(chooser)?.kind !== 'page') {
    throw new Error(
      `auth-matrix: the build has no page at ${chooser}, where the server's page guards send an account with only emailed codes (403 first_credential_required) ` +
        '— every new invitee would land on a 404 after their first code. Add the page (pages.requireUser({ allowFirstCredentialEnrollment: true }) and ChooseFirstCredential), ' +
        'pass firstCredentialPath if it lives elsewhere, or firstCredentialPath: false only if the server turns the rule off (requireFirstCredential: false).',
    );
  }
  const excluded = (path: string) =>
    NEXT_INTERNAL_ROUTES.has(path) ||
    (options.exclude ?? []).some((rule) => (typeof rule === 'string' ? rule === path : (rule.lastIndex = 0, rule.test(path))));
  return [...found.values()].filter((r) => !excluded(r.path)).sort((a, b) => a.path.localeCompare(b.path));
}
