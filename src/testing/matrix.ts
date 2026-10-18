/**
 * Auth-matrix tests (03 §2, Assurance): anonymous, member, and admin against every route, including
 * data routes, plus a second member against every route that takes a record ID.
 *
 * Each case runs twice:
 * - **with proxy**: the request goes through the whole app, as a browser's would;
 * - **without proxy**: the request reaches the route handler with `withAuthProxy` stepped aside, so a
 *   route that relies on the proxy for its 401 (no `requireUser()` of its own) fails. Against a
 *   running server, the proxy steps aside only for requests marked by the matrix, and only outside
 *   production builds, with `AUTH_KIT_MATRIX=1`, on a localhost URL (`src/shared/matrix-protocol.ts`).
 *   In-process tests can pass `handlerRequest` instead.
 *
 * It also checks coverage: `appRoutes` lists every route the app serves (`routesFromNextBuild()` after
 * `next build`), and the matrix fails on an app route with no row and on a row that matches no app
 * route (a mistyped path). And every row must expect at least one persona to succeed, so a path that
 * 404s for everyone can't pass by accident.
 *
 * ```ts
 * await assertAuthMatrix({
 *   request: (req) => fetch(req, { redirect: 'manual' }),
 *   baseUrl: 'http://app.localhost:3000',          // the dev server, started with AUTH_KIT_MATRIX=1
 *   appRoutes: routesFromNextBuild('.next'),
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
 *
 * What it can't see: server actions (POSTs to a page with a `Next-Action` header) aren't routes in
 * the build manifest, so they need rows of their own; and it checks responses, so a route that
 * answers correctly for these personas but leaks to some other one is beyond it.
 */
import {
  MATRIX_HANDLER_PASS_VALUE,
  MATRIX_REQUEST_HEADER,
  PROXY_DENIED,
  PROXY_HANDLER_PASS,
  PROXY_RESPONSE_HEADER,
} from '../shared/matrix-protocol.js';
import { type AppRouteInput, type CompiledRoute, compileAppRoute, resolveAppRoute } from './routes.js';

export const REQUIRED_PERSONAS = ['anonymous', 'member', 'admin'] as const;
/** The persona used for the second-member check on record routes. */
export const SECOND_MEMBER = 'otherMember';
/**
 * A freshly signed-up Member (register D4, ADR 0023): an account the sign-up route made a moment ago,
 * signed in by its first emailed code, with no role, no item access, and no passkey or password yet.
 * On a sign-up site (`signUpSite: true`) it runs against every route, and it may never get further
 * than `member`: no check may treat "signed in" as "trusted".
 */
export const NEW_MEMBER = 'newMember';
/**
 * An account with only emailed codes (no passkey or password yet: closed before "Choose how you'll
 * sign in next time"). The server refuses it on every route that needs a signed-in person (403
 * `first_credential_required`, register A1), so unless a row says otherwise (the chooser page), it's
 * expected to get what an anonymous visitor gets where that's a success or a redirect, and 403
 * everywhere else. Required on every site whose server enforces the first credential (the default,
 * `requireFirstCredential`): invitees start this way on invite-only sites too.
 */
export const CODE_ONLY_MEMBER = 'codeOnlyMember';

export type MatrixPass = 'with-proxy' | 'without-proxy';
export const MATRIX_PASSES: readonly MatrixPass[] = ['with-proxy', 'without-proxy'];

export interface PersonaDefinition {
  /** Headers that carry this persona's session (Authorization or Cookie). Omit for anonymous. */
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
}

type Expectations = Partial<Record<string, number | readonly number[]>>;

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
  expect: Expectations;
  /**
   * Expected statuses when the route answers on its own, with the proxy stepped aside. Defaults to
   * `expect`, persona by persona. Set it only where the route's own answer legitimately differs from
   * the proxy's (say why in a comment): it's the one place a route can be declared proxy-only.
   */
  expectWithoutProxy?: Expectations;
  /**
   * The standard answers 404, not 403, to someone who can't see a record. Set this only for a route
   * that deliberately confirms the record exists.
   */
  allowForbiddenForSecondMember?: boolean;
  /** `false` for a row asserting that a path does NOT exist: every persona must expect 404. */
  exists?: boolean;
}

export interface AuthMatrixOptions {
  personas: Record<string, PersonaDefinition>;
  routes: readonly MatrixRoute[];
  /**
   * Every route the app serves: `routesFromNextBuild('.next')` after `next build`, or a list kept by
   * hand (`'/api/reports/[id]'`, `'POST /api/admin/invite'`). Required: an app route with no row, or
   * a row with no app route, fails the matrix.
   */
  appRoutes: readonly AppRouteInput[];
  /** Sends one request through the whole app and returns the response. Use `redirect: 'manual'` with fetch. */
  request: (request: Request) => Promise<Response>;
  /**
   * Sends one request straight to the route handlers, skipping the proxy (in-process tests). Default:
   * `request`, with the matrix's handler-pass header, which `withAuthProxy` honors only outside
   * production, with `AUTH_KIT_MATRIX=1`, on a localhost URL; every response must then carry
   * `x-auth-kit-proxy: handler-pass` to prove the proxy stepped aside. With no proxy at all, pass
   * `handlerRequest: request`.
   */
  handlerRequest?: (request: Request) => Promise<Response>;
  /** Default `http://localhost`. */
  baseUrl?: string;
  /** Placeholder values shared by all routes (the member's own record IDs). */
  params?: Record<string, string>;
  /**
   * The site lets people create their own account (`accountCreation` mode `domains` or `open`): the
   * `newMember` persona is required, and every route runs as it too, expecting what a member gets
   * unless the row says otherwise; a row that lets it succeed where a member can't is refused.
   */
  signUpSite?: boolean;
  /**
   * The server enforces the first credential (`createServerAuth`'s `requireFirstCredential`, on by
   * default): the `codeOnlyMember` persona is required and runs against every route. Pass `false`
   * only when the server turns the rule off.
   */
  requireFirstCredential?: boolean;
}

/** What an emailed-code-only account gets on a route by default: an anonymous visitor's success or redirect, else 403. */
function codeOnlyDefault(expect: Expectations): number | readonly number[] | undefined {
  const anonymous = expect.anonymous;
  if (anonymous === undefined) return undefined;
  return asList(anonymous).some((s) => s < 400) ? anonymous : 403;
}

export interface MatrixCase {
  /** Position of the route in `routes`. */
  routeIndex: number;
  route: string;
  persona: string;
  pass: MatrixPass;
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

const asList = (value: number | readonly number[] | undefined): readonly number[] =>
  value === undefined ? [] : typeof value === 'number' ? [value] : value;

/**
 * Validates the matrix against the standard and expands it into one case per route, persona, and
 * pass. Throws, listing every problem, if a route skips a required persona, a record route skips the
 * second member or expects 403 where the standard says 404, a row expects nobody to succeed, a row
 * matches none of `appRoutes`, or an app route has no row.
 */
export function authMatrixCases(options: Omit<AuthMatrixOptions, 'request' | 'handlerRequest'>): MatrixCase[] {
  const problems: string[] = [];
  const baseUrl = options.baseUrl ?? 'http://localhost';
  const needsSecond = options.routes.some(isRecordRoute);
  const newMember = options.signUpSite === true || options.personas[NEW_MEMBER] !== undefined;
  const firstCredentialEnforced = options.requireFirstCredential !== false;
  const codeOnly = options.signUpSite === true || firstCredentialEnforced || options.personas[CODE_ONLY_MEMBER] !== undefined;
  const required = [
    ...REQUIRED_PERSONAS,
    ...(needsSecond ? [SECOND_MEMBER] : []),
    ...(options.signUpSite === true ? [NEW_MEMBER] : []),
    ...(options.signUpSite === true || firstCredentialEnforced ? [CODE_ONLY_MEMBER] : []),
  ];
  for (const p of required) {
    if (!options.personas[p]) {
      problems.push(
        p === NEW_MEMBER
          ? `persona "${NEW_MEMBER}" is required on a sign-up site: a freshly signed-up Member (FRESH_SIGN_UP_MEMBER) must run against every route.`
          : p === CODE_ONLY_MEMBER
            ? `persona "${CODE_ONLY_MEMBER}" is required: the server refuses an account with only emailed codes everywhere but the chooser (requireFirstCredential), and invitees start that way, so EMAILED_CODE_ONLY_MEMBER must run against every route (pass requireFirstCredential: false only if the server turns the rule off).`
            : `persona "${p}" is required but not defined.`,
      );
    }
  }

  let appRoutes: CompiledRoute[] = [];
  if (!Array.isArray(options.appRoutes) || options.appRoutes.length === 0) {
    problems.push('appRoutes is empty: pass routesFromNextBuild(".next") (or the app\'s route list) so uncovered routes fail.');
  } else {
    try {
      appRoutes = options.appRoutes.map(compileAppRoute);
    } catch (error) {
      problems.push((error as Error).message);
    }
  }
  const covered = new Set<CompiledRoute>();

  const cases: MatrixCase[] = [];
  for (const [routeIndex, route] of options.routes.entries()) {
    const method = (route.method ?? 'GET').toUpperCase();
    const label = route.name ?? `${method} ${route.path}`;
    const required = [...REQUIRED_PERSONAS, ...(isRecordRoute(route) ? [SECOND_MEMBER] : [])];
    for (const p of required) {
      if (route.expect[p] === undefined) problems.push(`${label}: no expectation for "${p}".`);
    }
    if (isRecordRoute(route) && !route.allowForbiddenForSecondMember) {
      for (const [field, expectations] of [
        ['expect', route.expect],
        ['expectWithoutProxy', route.expectWithoutProxy],
      ] as const) {
        if (asList(expectations?.[SECOND_MEMBER]).includes(403)) {
          problems.push(
            `${label}: ${field} gives a second member 403; the standard says 404, so the route doesn't confirm the record exists.`,
          );
        }
      }
    }
    for (const persona of Object.keys(route.expectWithoutProxy ?? {})) {
      if (route.expect[persona] === undefined) {
        problems.push(`${label}: expectWithoutProxy names "${persona}", which has no expectation in expect.`);
      }
    }
    // A freshly signed-up Member is held to a member's expectations, row by row, and never beyond them.
    // On a route that takes an item's ID it's someone else's item, so it's held to the second member's.
    const peer = isRecordRoute(route) && route.expect[SECOND_MEMBER] !== undefined ? SECOND_MEMBER : 'member';
    let expect: Expectations = newMember && route.expect[NEW_MEMBER] === undefined && route.expect[peer] !== undefined ? { ...route.expect, [NEW_MEMBER]: route.expect[peer] } : route.expect;
    if (newMember && route.expect[NEW_MEMBER] !== undefined) {
      const memberSucceeds = asList(route.expect[peer]).some((s) => s < 400);
      const newMemberSucceeds = asList(route.expect[NEW_MEMBER]).some((s) => s < 400);
      if (newMemberSucceeds && !memberSucceeds) {
        problems.push(`${label}: expects "${NEW_MEMBER}" to succeed where "${peer}" can't. A freshly signed-up account gets no more than a member: nothing may treat "signed in" as trusted.`);
      }
    }
    // An account with only emailed codes is refused wherever a signed-in person is needed (M2).
    if (codeOnly) {
      if (route.expect[CODE_ONLY_MEMBER] === undefined) {
        const fallback = route.exists === false ? 404 : codeOnlyDefault(route.expect);
        if (fallback !== undefined) expect = { ...expect, [CODE_ONLY_MEMBER]: fallback };
      } else if (asList(route.expect[CODE_ONLY_MEMBER]).some((s) => s >= 200 && s < 300) && !asList(route.expect.member).some((s) => s < 400)) {
        // A redirect (to the chooser) isn't getting in; a 2xx where a member gets nothing is.
        problems.push(`${label}: expects "${CODE_ONLY_MEMBER}" to succeed where "member" can't. An account with only emailed codes gets no more than a member.`);
      }
    }
    const statuses = Object.values(expect).flatMap((v) => [...asList(v)]);
    if (route.exists === false) {
      if (statuses.some((s) => s !== 404)) problems.push(`${label}: exists: false rows must expect 404 for every persona.`);
    } else if (!statuses.some((s) => s < 400)) {
      problems.push(
        `${label}: no persona is expected to succeed (every expectation is 4xx/5xx), so a mistyped or missing route would pass. ` +
          'Fix the path, or set exists: false for a row asserting the path does not exist.',
      );
    }

    let path: string;
    try {
      path = fill(route.path, { ...options.params, ...route.params }, label);
    } catch (error) {
      problems.push((error as Error).message);
      continue;
    }
    if (appRoutes.length > 0) {
      const target = resolveAppRoute(appRoutes, path);
      if (route.exists === false) {
        if (target) problems.push(`${label}: exists: false, but the app serves ${target.label}.`);
      } else if (!target) {
        problems.push(`${label}: ${path} is not one of the app's routes (appRoutes). Is the path mistyped, or was the route removed?`);
      } else {
        // A method-specific app route is covered only by a row with that method.
        for (const candidate of appRoutes) {
          if (candidate.key === target.key && (candidate.method === undefined || candidate.method === method)) covered.add(candidate);
        }
      }
    }

    for (const [persona, expected] of Object.entries(expect)) {
      if (expected === undefined) continue;
      if (!options.personas[persona]) {
        problems.push(`${label}: expectation for unknown persona "${persona}".`);
        continue;
      }
      for (const pass of MATRIX_PASSES) {
        const value =
          pass === 'without-proxy'
            ? (route.expectWithoutProxy?.[persona] ?? (persona === NEW_MEMBER && route.expect[NEW_MEMBER] === undefined ? route.expectWithoutProxy?.[peer] : undefined) ?? expected)
            : expected;
        cases.push({
          routeIndex,
          route: label,
          persona,
          pass,
          method,
          path,
          url: new URL(path, baseUrl).toString(),
          expected: [...asList(value)],
        });
      }
    }
  }
  for (const r of appRoutes) {
    if (!covered.has(r)) problems.push(`${r.label}: the app serves this route but the matrix has no row for it.`);
  }
  if (problems.length > 0) throw new Error(`auth-matrix is incomplete:\n- ${problems.join('\n- ')}`);
  return cases;
}

async function headersFor(persona: PersonaDefinition | undefined): Promise<Headers> {
  const raw = typeof persona?.headers === 'function' ? await persona.headers() : persona?.headers;
  return new Headers(raw ?? {});
}

const PROXY_ANSWERED =
  'the proxy answered (x-auth-kit-proxy: denied), so the route\'s own check never ran. Start the server with ' +
  'AUTH_KIT_MATRIX=1 in development and use a localhost baseUrl, or pass handlerRequest.';
const PROXY_NOT_CONFIRMED =
  "the proxy didn't confirm it stepped aside (no x-auth-kit-proxy: handler-pass). Start the server with AUTH_KIT_MATRIX=1 " +
  'in development and use a localhost baseUrl; with no auth-kit proxy at all, pass handlerRequest: request.';

/** Runs every case and reports each result. Doesn't throw on mismatches (see `assertAuthMatrix`). */
export async function runAuthMatrix(options: AuthMatrixOptions): Promise<MatrixResult[]> {
  const cases = authMatrixCases(options);
  const results: MatrixResult[] = [];
  for (const c of cases) {
    const route = options.routes[c.routeIndex];
    const headers = await headersFor(options.personas[c.persona]);
    for (const [k, v] of Object.entries(route?.headers ?? {})) if (!headers.has(k)) headers.set(k, v);
    const withoutProxy = c.pass === 'without-proxy';
    if (withoutProxy) headers.set(MATRIX_REQUEST_HEADER, MATRIX_HANDLER_PASS_VALUE);
    let body: string | undefined;
    if (route?.body !== undefined && c.method !== 'GET' && c.method !== 'HEAD') {
      body = JSON.stringify(route.body);
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    }
    const send = withoutProxy ? (options.handlerRequest ?? options.request) : options.request;
    try {
      const response = await send(
        new Request(c.url, { method: c.method, headers, ...(body !== undefined && { body }), redirect: 'manual' }),
      );
      let error: string | undefined;
      if (withoutProxy) {
        const marker = response.headers.get(PROXY_RESPONSE_HEADER);
        if (marker === PROXY_DENIED) error = PROXY_ANSWERED;
        else if (!options.handlerRequest && marker !== PROXY_HANDLER_PASS) error = PROXY_NOT_CONFIRMED;
      }
      results.push({
        ...c,
        actual: response.status,
        ok: error === undefined && c.expected.includes(response.status),
        ...(error !== undefined && { error }),
      });
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
    .map((r) => {
      const where = `x ${r.route} as ${r.persona} (${r.pass})`;
      if (r.actual === null) return `${where}: expected ${r.expected.join(' or ')}, got an error (${r.error ?? 'unknown'})`;
      return `${where}: expected ${r.expected.join(' or ')}, got ${r.actual}${r.error ? `; ${r.error}` : ''}`;
    })
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
