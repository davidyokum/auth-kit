/**
 * Auth-matrix tests (03 §2, Assurance): anonymous, member, and admin against every route, including
 * data routes, plus a second member against every route that takes a record ID.
 *
 * ```ts
 * await assertAuthMatrix({
 *   request: (req) => fetch(req, { redirect: 'manual' }),   // or dispatch to route handlers in-process
 *   baseUrl: 'http://app.localhost:3000',
 *   personas: {
 *     anonymous: {},
 *     member: bearerPersona(memberToken),
 *     otherMember: bearerPersona(otherToken),
 *     admin: bearerPersona(adminToken),
 *   },
 *   params: { id: memberOwnRecordId },
 *   routes: [
 *     { method: 'GET', path: '/api/reports', expect: { anonymous: 401, member: 200, admin: 200 } },
 *     { method: 'GET', path: '/api/reports/:id', expect: { anonymous: 401, member: 200, otherMember: 404, admin: 200 } },
 *     { method: 'POST', path: '/api/admin/invite', expect: { anonymous: 401, member: 403, admin: 200 } },
 *   ],
 * });
 * ```
 */

export const REQUIRED_PERSONAS = ['anonymous', 'member', 'admin'] as const;
/** The persona used for the second-member check on record routes. */
export const SECOND_MEMBER = 'otherMember';

export interface PersonaDefinition {
  /** Headers that carry this persona's session (Authorization or Cookie). Omit for anonymous. */
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
}

export interface MatrixRoute {
  /** Label in failure messages. Default `METHOD path`. */
  name?: string;
  /** Default GET. */
  method?: string;
  /** Path with optional `:param` placeholders, e.g. `/api/reports/:id`. */
  path: string;
  /** Values for this route's placeholders (overrides the matrix-wide `params`). */
  params?: Record<string, string>;
  /** JSON body for non-GET requests. */
  body?: unknown;
  /** Extra headers for this route (merged under the persona's). */
  headers?: Record<string, string>;
  /** Treat as a record route even without placeholders (e.g. `?id=` routes), or opt out. */
  recordRoute?: boolean;
  /** Expected status per persona; an array allows any of several (e.g. `[302, 307]`). */
  expect: Partial<Record<string, number | readonly number[]>>;
  /**
   * The standard answers 404, not 403, to someone who can't see a record. Set this only for a route
   * that deliberately confirms the record exists.
   */
  allowForbiddenForSecondMember?: boolean;
}

export interface AuthMatrixOptions {
  personas: Record<string, PersonaDefinition>;
  routes: readonly MatrixRoute[];
  /** Sends one request and returns the response. Use `redirect: 'manual'` with fetch. */
  request: (request: Request) => Promise<Response>;
  /** Default `http://localhost`. */
  baseUrl?: string;
  /** Placeholder values shared by all routes (the member's own record IDs). */
  params?: Record<string, string>;
}

export interface MatrixCase {
  /** Position of the route in `routes`. */
  routeIndex: number;
  route: string;
  persona: string;
  method: string;
  path: string;
  url: string;
  expected: readonly number[];
}

export interface MatrixResult extends MatrixCase {
  actual: number | null;
  ok: boolean;
  error?: string;
}

const PARAM = /:([A-Za-z_][A-Za-z0-9_]*)/g;

function isRecordRoute(route: MatrixRoute): boolean {
  return route.recordRoute ?? /:[A-Za-z_]/.test(route.path);
}

function fill(path: string, params: Record<string, string>, label: string): string {
  return path.replace(PARAM, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`auth-matrix: no value for ":${name}" in ${label}.`);
    return encodeURIComponent(value);
  });
}

/**
 * Validates the matrix against the standard and expands it into one case per route and persona.
 * Throws if a route skips a required persona, a record route skips the second member, or a record
 * route expects 403 where the standard says 404.
 */
export function authMatrixCases(options: Omit<AuthMatrixOptions, 'request'>): MatrixCase[] {
  const problems: string[] = [];
  const baseUrl = options.baseUrl ?? 'http://localhost';
  const needsSecond = options.routes.some(isRecordRoute);
  for (const p of [...REQUIRED_PERSONAS, ...(needsSecond ? [SECOND_MEMBER] : [])]) {
    if (!options.personas[p]) problems.push(`persona "${p}" is required but not defined.`);
  }

  const cases: MatrixCase[] = [];
  for (const [routeIndex, route] of options.routes.entries()) {
    const method = (route.method ?? 'GET').toUpperCase();
    const label = route.name ?? `${method} ${route.path}`;
    const required = [...REQUIRED_PERSONAS, ...(isRecordRoute(route) ? [SECOND_MEMBER] : [])];
    for (const p of required) {
      if (route.expect[p] === undefined) problems.push(`${label}: no expectation for "${p}".`);
    }
    if (isRecordRoute(route) && !route.allowForbiddenForSecondMember) {
      const second = route.expect[SECOND_MEMBER];
      const list = typeof second === 'number' ? [second] : (second ?? []);
      if (list.includes(403)) {
        problems.push(`${label}: a second member should get 404, not 403, so the route doesn't confirm the record exists.`);
      }
    }
    let path: string;
    try {
      path = fill(route.path, { ...options.params, ...route.params }, label);
    } catch (error) {
      problems.push((error as Error).message);
      continue;
    }
    for (const [persona, expected] of Object.entries(route.expect)) {
      if (expected === undefined) continue;
      if (!options.personas[persona]) {
        problems.push(`${label}: expectation for unknown persona "${persona}".`);
        continue;
      }
      cases.push({
        routeIndex,
        route: label,
        persona,
        method,
        path,
        url: new URL(path, baseUrl).toString(),
        expected: typeof expected === 'number' ? [expected] : [...expected],
      });
    }
  }
  if (problems.length > 0) throw new Error(`auth-matrix is incomplete:\n- ${problems.join('\n- ')}`);
  return cases;
}

async function headersFor(persona: PersonaDefinition | undefined): Promise<Headers> {
  const raw = typeof persona?.headers === 'function' ? await persona.headers() : persona?.headers;
  return new Headers(raw ?? {});
}

/** Runs every case and reports each result. Doesn't throw on mismatches (see `assertAuthMatrix`). */
export async function runAuthMatrix(options: AuthMatrixOptions): Promise<MatrixResult[]> {
  const cases = authMatrixCases(options);
  const results: MatrixResult[] = [];
  for (const c of cases) {
    const route = options.routes[c.routeIndex];
    const headers = await headersFor(options.personas[c.persona]);
    for (const [k, v] of Object.entries(route?.headers ?? {})) if (!headers.has(k)) headers.set(k, v);
    let body: string | undefined;
    if (route?.body !== undefined && c.method !== 'GET' && c.method !== 'HEAD') {
      body = JSON.stringify(route.body);
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    }
    try {
      const response = await options.request(
        new Request(c.url, { method: c.method, headers, ...(body !== undefined && { body }), redirect: 'manual' }),
      );
      results.push({ ...c, actual: response.status, ok: c.expected.includes(response.status) });
    } catch (error) {
      results.push({ ...c, actual: null, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

/** Formats failures as one line each. */
export function formatMatrixFailures(results: readonly MatrixResult[]): string {
  return results
    .filter((r) => !r.ok)
    .map(
      (r) =>
        `x ${r.route} as ${r.persona}: expected ${r.expected.join(' or ')}, got ${r.actual ?? `an error (${r.error ?? 'unknown'})`}`,
    )
    .join('\n');
}

/** Runs the matrix and throws one error listing every mismatch. */
export async function assertAuthMatrix(options: AuthMatrixOptions): Promise<MatrixResult[]> {
  const results = await runAuthMatrix(options);
  const failures = formatMatrixFailures(results);
  if (failures) throw new Error(`auth-matrix: ${results.filter((r) => !r.ok).length} of ${results.length} checks failed\n${failures}`);
  return results;
}

/** A persona that sends `Authorization: Bearer <token>`. */
export function bearerPersona(accessToken: string): PersonaDefinition {
  return { headers: { authorization: `Bearer ${accessToken}` } };
}
