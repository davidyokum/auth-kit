/**
 * `auth-kit/proxy`: `withAuthProxy()` for Next 16's `proxy.ts` (formerly middleware).
 *
 * - **Default-deny.** Every path is protected except an explicit allowlist of public routes, so a
 *   route someone forgets to list is still protected. The allowlist is validated at startup: a rule
 *   that would make every path public (`'/*'`, an unanchored or catch-all RegExp) throws.
 * - **Verifies tokens** (signature, expiry, issuer, audience, token use), not just that a cookie exists.
 * - **Never the only gate.** Proxies have had bypass bugs (CVE-2025-29927) and don't gate build
 *   assets, so every route handler, server action, and data-loading component still calls
 *   `requireUser()` / `requireCan()`. The proxy passes no identity downstream for routes to trust,
 *   and the auth matrix's "without proxy" pass checks each route's own guard.
 * - **Composes with a nonce CSP.** The `headers` hook adds request headers (Next reads the CSP nonce
 *   from the request) and response headers on every answer; `nonceCspHeaders` is the CSP one.
 *
 * ```ts
 * // proxy.ts
 * import { withAuthProxy } from 'auth-kit/proxy';
 * import { auth } from '@/lib/auth';
 *
 * export const proxy = withAuthProxy({ auth, publicRoutes: ['/', '/about', '/legal/*'] });
 *
 * // A literal: Next reads the matcher at build time and ignores imported values.
 * export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
 * ```
 */
// Fully specified `.js` paths: Next's bundler aliases them like the bare ones, and plain Node ESM
// (which can't resolve `next/server` without an exports map) loads them too.
import { NextResponse, type NextRequest } from 'next/server.js';
import type { ResolvedPoolConfig } from '../server/config.js';
import { toRequestContext } from '../server/context.js';
import { PRIVATE_NO_STORE } from '../server/cookies.js';
import { AuthUnavailableError, type AuthError, UnauthenticatedError, authErrorResponse } from '../server/errors.js';
import { RETURN_PATH_HEADER, signInUrl } from '../server/pages.js';
import { isSafeRedirect, safeRedirect } from '../server/redirect.js';
import type { FoundTokens, TokenSource } from '../server/tokens.js';
import type { AccessTokenClaims } from '../server/verify.js';
import { isLoopbackHostname } from '../shared/loopback.js';
import {
  MATRIX_ENV_FLAG,
  MATRIX_HANDLER_PASS_VALUE,
  MATRIX_REQUEST_HEADER,
  PROXY_DENIED,
  PROXY_HANDLER_PASS,
  PROXY_RESPONSE_HEADER,
} from '../shared/matrix-protocol.js';
import { type RefreshLimits, type RefreshOutcome, createRefreshGate, resolveRefreshLimits } from './refresh-gate.js';

/**
 * A public-route rule: an exact path (`/about`), a prefix ending in `/*` that also matches the prefix
 * itself (`/legal/*`), or a RegExp anchored with `^…$` (`/^\/blog\/[a-z-]+$/`).
 */
export type PublicRoute = string | RegExp;

/** The part of `createServerAuth()`'s result the proxy uses. */
export interface ProxyAuth {
  readonly pool: Readonly<Pick<ResolvedPoolConfig, 'clientId'>>;
  readonly tokenSource: TokenSource;
  /** Must throw `UnauthenticatedError('token_expired')` for a genuine but expired token (auth-kit's does). */
  verifyAccessToken(token: string): Promise<AccessTokenClaims>;
}

/** Fresh tokens from a server-side refresh, plus the Set-Cookie headers that store them. */
export interface RefreshResult {
  accessToken: string;
  setCookies: readonly string[];
}

/** Refreshes an expired session server-side (see `amplifyAdapterRefresh`). Return null when it can't. */
export type RefreshHandler = (request: NextRequest) => Promise<RefreshResult | null>;

/** Headers the app adds to one request, from the `headers` option. */
export interface ProxyHeaders {
  /**
   * Added to the request the page or route sees, on every request the proxy lets through (public or
   * protected). E.g. a Content-Security-Policy with this request's nonce: Next reads the nonce from
   * the request's CSP header while rendering. Can't name the session, client-address, auth-kit, or
   * Next-internal headers (see `RESERVED_REQUEST_HEADERS`).
   */
  request?: HeadersInit;
  /**
   * Set on every response the proxy returns: pass-throughs, sign-in redirects, and refusals alike.
   * Can't name the headers the proxy owns (see `RESERVED_RESPONSE_HEADERS`).
   */
  response?: HeadersInit;
}

/** Called once per request, before the auth decision; its headers apply whatever the decision. */
export type ProxyHeadersHook = (request: NextRequest) => ProxyHeaders | null | undefined | Promise<ProxyHeaders | null | undefined>;

/**
 * Request headers the `headers` hook can't set: the session routes read tokens from, where the
 * request came from (the dev kit's gates read these), auth-kit's own (the recorded return path, the
 * matrix mark), and Next's internals. Names starting with `x-forwarded-`, `x-auth-kit-`,
 * `x-middleware-`, `x-nextjs-`, or `next-` are refused too.
 */
export const RESERVED_REQUEST_HEADERS: readonly string[] = Object.freeze([
  'cookie',
  'authorization',
  'proxy-authorization',
  'host',
  'forwarded',
  'x-real-ip',
  'cf-connecting-ip',
  'true-client-ip',
  'x-client-ip',
  'fastly-client-ip',
  'rsc',
]);

/**
 * Response headers the `headers` hook can't set, because the proxy owns them: session cookies from a
 * refresh, the sign-in redirect, `Cache-Control: private, no-store` on protected responses, the
 * refusal's body headers, and auth-kit's and Next's own (`x-auth-kit-`, `x-middleware-`, `x-nextjs-`).
 */
export const RESERVED_RESPONSE_HEADERS: readonly string[] = Object.freeze([
  'set-cookie',
  'location',
  'cache-control',
  'content-type',
  'content-length',
  'transfer-encoding',
  'www-authenticate',
  'retry-after',
]);

const RESERVED_REQUEST_PREFIXES = ['x-forwarded-', 'x-auth-kit-', 'x-middleware-', 'x-nextjs-', 'next-'];
const RESERVED_RESPONSE_PREFIXES = ['x-auth-kit-', 'x-middleware-', 'x-nextjs-'];

/** The request headers Next reads a CSP nonce from: only ever the app's (the hook's), never the client's. */
const CSP_REQUEST_HEADERS = ['content-security-policy', 'content-security-policy-report-only'];

export interface AuthProxyOptions {
  auth: ProxyAuth;
  /** Paths anyone may load. The sign-in path is always public. */
  publicRoutes?: readonly PublicRoute[];
  /** Default `/sign-in`. A plain path; anything else throws. */
  signInPath?: string;
  /** Paths answered with 401 JSON instead of a sign-in redirect. Default `['/api/*']`. */
  apiRoutes?: readonly PublicRoute[];
  /** Treat `/_next/static/*`, `/_next/image`, and `/favicon.ico` as public. Default `true`. */
  allowNextInternals?: boolean;
  /**
   * Refresh an expired session server-side so it isn't bounced to sign-in hourly. Called only for an
   * Amplify cookie session whose access token is genuine but expired and that has a refresh-token
   * cookie; never for a missing, forged, or foreign token, and never for a bearer token.
   */
  refresh?: RefreshHandler;
  /** Limits on those refreshes, which count toward the pool's WAF per-IP rules. See `RefreshLimits`. */
  refreshLimits?: RefreshLimits;
  /** Called after each refresh decision, for logs and metrics. Never receives tokens. */
  onRefresh?: (event: { outcome: RefreshOutcome; path: string }) => void;
  /** Add `Cache-Control: private, no-store` to protected responses. Default `true`. */
  noStore?: boolean;
  /**
   * Adds headers to each request and response, e.g. a nonce-based Content-Security-Policy
   * (`nonceCspHeaders`). Called once per request; `request` headers reach the page or route on every
   * pass-through, `response` headers go on every response, refusals included. Reserved headers throw.
   */
  headers?: ProxyHeadersHook;
}

interface ExtraHeaders {
  readonly request: readonly (readonly [string, string])[];
  readonly response: readonly (readonly [string, string])[];
}

const NO_EXTRA_HEADERS: ExtraHeaders = Object.freeze({ request: Object.freeze([]), response: Object.freeze([]) });

function isReserved(name: string, names: readonly string[], prefixes: readonly string[]): boolean {
  return names.includes(name) || prefixes.some((prefix) => name.startsWith(prefix));
}

/** Validates what the hook returned. A reserved header is a bug in the app: it throws (the request fails, closed). */
function resolveExtraHeaders(value: unknown): ExtraHeaders {
  if (value === undefined || value === null) return NO_EXTRA_HEADERS;
  if (typeof value !== 'object') throw new Error('auth-kit: withAuthProxy `headers` must return { request?, response? } or nothing.');
  for (const key of Object.keys(value)) {
    if (key !== 'request' && key !== 'response') throw new Error(`auth-kit: withAuthProxy \`headers\` returned an unknown key "${key}" (use request or response).`);
  }
  const { request, response } = value as ProxyHeaders;
  const toList = (init: HeadersInit | undefined, side: 'request' | 'response'): [string, string][] => {
    if (init === undefined) return [];
    const list = [...new Headers(init)];
    for (const [name] of list) {
      const reserved =
        side === 'request'
          ? isReserved(name, RESERVED_REQUEST_HEADERS, RESERVED_REQUEST_PREFIXES)
          : isReserved(name, RESERVED_RESPONSE_HEADERS, RESERVED_RESPONSE_PREFIXES);
      if (reserved) {
        throw new Error(
          `auth-kit: withAuthProxy \`headers\` can't set "${name}" on the ${side}: the proxy and auth-kit's checks depend on it.`,
        );
      }
    }
    return list;
  };
  return { request: toList(request, 'request'), response: toList(response, 'response') };
}

/** A fresh CSP nonce: 128 random bits, base64 (what Next's nonce parser accepts). */
export function newCspNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export interface NonceCspOptions {
  /** Send the policy as `Content-Security-Policy-Report-Only` while you tune it. Default false. */
  reportOnly?: boolean;
  /** Also pass the nonce to pages in this request header, for your own `<Script nonce>`. Default `x-nonce`; `false` for none. */
  nonceHeader?: string | false;
}

/**
 * A `headers` hook for a strict, nonce-based Content-Security-Policy, the standard's defense for
 * Amplify's script-readable token cookies. For each request it makes a fresh nonce, builds the
 * policy with it, puts the policy on the request (Next reads the nonce from it and stamps its own
 * scripts) and on every response, and passes the nonce in `x-nonce`. Pages must render per request
 * (a nonce can't be baked into a static page): call `connection()` in the root layout.
 *
 * ```ts
 * export const proxy = withAuthProxy({
 *   auth,
 *   publicRoutes: ['/'],
 *   headers: nonceCspHeaders((nonce) => `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic'; …`),
 * });
 * ```
 *
 * The policy must use the nonce (`'nonce-<nonce>'`), or this throws: a policy without it doesn't need
 * this hook, and is probably a mistake.
 */
export function nonceCspHeaders(policy: (nonce: string) => string, options: NonceCspOptions = {}): ProxyHeadersHook {
  if (typeof policy !== 'function') throw new Error('auth-kit: nonceCspHeaders needs a function (nonce) => policy.');
  const nonceHeader = options.nonceHeader ?? 'x-nonce';
  if (nonceHeader !== false && (typeof nonceHeader !== 'string' || isReserved(nonceHeader.toLowerCase(), RESERVED_REQUEST_HEADERS, RESERVED_REQUEST_PREFIXES))) {
    throw new Error(`auth-kit: nonceCspHeaders nonceHeader ${JSON.stringify(nonceHeader)} isn't a usable header name.`);
  }
  const responseHeader = options.reportOnly === true ? 'content-security-policy-report-only' : 'content-security-policy';
  return () => {
    const nonce = newCspNonce();
    const csp = policy(nonce);
    if (typeof csp !== 'string' || !csp.includes(`'nonce-${nonce}'`)) {
      throw new Error("auth-kit: nonceCspHeaders' policy must include the nonce as 'nonce-<nonce>' (in script-src).");
    }
    return {
      // Always the enforcing header name on the request: it's the one Next reads first, and the proxy
      // never forwards a client's own CSP request headers.
      request: { 'content-security-policy': csp, ...(nonceHeader !== false && { [nonceHeader]: nonce }) },
      response: { [responseHeader]: csp },
    };
  };
}

const NEXT_INTERNALS: readonly PublicRoute[] = ['/_next/static/*', '/_next/image', '/favicon.ico'];
const SAFE_METHODS = new Set(['GET', 'HEAD']);
const OPTION_KEYS = new Set<string>([
  'auth',
  'publicRoutes',
  'signInPath',
  'apiRoutes',
  'allowNextInternals',
  'refresh',
  'refreshLimits',
  'onRefresh',
  'noStore',
  'headers',
]);

/**
 * Paths no public rule should match. A rule that matches any of them is a catch-all that would turn
 * default-deny off for most of the site, so it's refused.
 */
const CANARY_PATHS = ['/auth-kit-canary', '/auth-kit-canary/x1', '/auth-kit-canary/x1/y2', '/AuthKitCanary9'];

function normalizePath(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.replace(/\/+$/, '') || '/' : path;
}

function compile(routes: readonly PublicRoute[]): (path: string) => boolean {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  const patterns: RegExp[] = [];
  for (const route of routes) {
    if (route instanceof RegExp) patterns.push(route);
    else if (route.endsWith('/*')) prefixes.push(normalizePath(route.slice(0, -2) || '/'));
    else exact.add(normalizePath(route));
  }
  return (rawPath) => {
    const path = normalizePath(rawPath);
    if (exact.has(path)) return true;
    if (prefixes.some((p) => p === '/' || path === p || path.startsWith(`${p}/`))) return true;
    return patterns.some((re) => {
      re.lastIndex = 0;
      return re.test(path);
    });
  };
}

/** Throws with a precise message for a route rule that is malformed or unsafe. */
function validateRoute(route: unknown, list: string, catchAllCheck: boolean): void {
  const label = `${list} entry ${route instanceof RegExp ? String(route) : JSON.stringify(route)}`;
  if (route instanceof RegExp) {
    const { source, flags } = route;
    if (!source.startsWith('^') || !source.endsWith('$') || source.endsWith('\\$')) {
      throw new Error(
        `auth-kit: ${label} must be anchored as /^…$/. An unanchored pattern also matches longer paths (/\\/blog\\// matches /admin/blog/x).`,
      );
    }
    if (/[gym]/.test(flags)) {
      throw new Error(`auth-kit: ${label} can't use the g, y, or m flags (they change what ^ and $ match, or carry state between tests).`);
    }
  } else if (typeof route === 'string') {
    if (!route.startsWith('/')) throw new Error(`auth-kit: ${label} must start with "/".`);
    // eslint-disable-next-line no-control-regex -- control characters are what's being refused
    if (/[\s\u0000-\u001F\u007F?#%\\]/.test(route)) {
      throw new Error(`auth-kit: ${label} must be a plain path: no spaces, control characters, ?, #, %, or backslash.`);
    }
    const body = route.endsWith('/*') ? route.slice(0, -2) : route;
    if (body.includes('*')) throw new Error(`auth-kit: ${label} can use * only as a final "/*".`);
    if (body.split('/').some((segment) => segment === '.' || segment === '..')) {
      throw new Error(`auth-kit: ${label} can't contain "." or ".." segments.`);
    }
    if (catchAllCheck && normalizePath(body || '/') === '/' && route.endsWith('/*')) {
      throw new Error(
        `auth-kit: ${label} makes every path public, which turns default-deny off. List the public paths instead.`,
      );
    }
  } else {
    throw new Error(`auth-kit: ${label} must be a path string or a RegExp.`);
  }
  if (catchAllCheck) {
    const matches = compile([route]);
    const hit = CANARY_PATHS.find((p) => matches(p));
    if (hit !== undefined) {
      throw new Error(
        `auth-kit: ${label} matches "${hit}", so it would make (nearly) every path public and turn default-deny off. ` +
          'Make it specific to the public pages.',
      );
    }
  }
}

/** Fails loudly at startup: a misconfigured proxy must not boot. */
function validateProxyOptions(options: AuthProxyOptions): void {
  if (typeof options !== 'object' || options === null) throw new Error('auth-kit: withAuthProxy needs an options object.');
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) throw new Error(`auth-kit: withAuthProxy has no option "${key}".`);
  }
  const { auth } = options;
  if (
    typeof auth !== 'object' ||
    auth === null ||
    typeof auth.verifyAccessToken !== 'function' ||
    typeof auth.tokenSource !== 'function' ||
    typeof auth.pool?.clientId !== 'string' ||
    auth.pool.clientId === ''
  ) {
    throw new Error('auth-kit: withAuthProxy needs `auth` from createServerAuth().');
  }
  for (const [list, catchAllCheck] of [
    ['publicRoutes', true],
    ['apiRoutes', false],
  ] as const) {
    const routes = options[list];
    if (routes === undefined) continue;
    if (!Array.isArray(routes)) throw new Error(`auth-kit: ${list} must be an array.`);
    for (const route of routes as unknown[]) validateRoute(route, list, catchAllCheck);
  }
  if (options.signInPath !== undefined) {
    const path = options.signInPath;
    if (typeof path !== 'string' || !isSafeRedirect(path) || /[?#]/.test(path) || safeRedirect(path) !== path) {
      throw new Error(`auth-kit: signInPath ${JSON.stringify(path)} must be a plain same-site path such as "/sign-in".`);
    }
  }
  for (const key of ['allowNextInternals', 'noStore'] as const) {
    if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new Error(`auth-kit: ${key} must be true or false.`);
  }
  for (const key of ['refresh', 'onRefresh', 'headers'] as const) {
    if (options[key] !== undefined && typeof options[key] !== 'function') throw new Error(`auth-kit: ${key} must be a function.`);
  }
  if (options.refreshLimits !== undefined) resolveRefreshLimits(options.refreshLimits);
}

function decodeOnce(path: string): string | null {
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}

/**
 * Public only if both the raw and the decoded path match, and the path has no encoded slash or
 * backslash. Anything ambiguous is treated as protected (fail closed).
 */
function makePublicCheck(routes: readonly PublicRoute[]): (pathname: string) => boolean {
  const matches = compile(routes);
  return (pathname) => {
    if (/%2f|%5c/i.test(pathname) || pathname.includes('\\')) return false;
    const decoded = decodeOnce(pathname);
    return decoded !== null && matches(pathname) && matches(decoded);
  };
}

function toNextResponse(response: Response): NextResponse {
  return new NextResponse(response.body, { status: response.status, headers: response.headers });
}

function mergeCookieHeader(existing: string | null, setCookies: readonly string[]): string {
  const jar = new Map<string, string>();
  for (const part of (existing ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  for (const header of setCookies) {
    const pair = header.split(';', 1)[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const expired = /;\s*max-age=0\b/i.test(header) || /;\s*expires=thu, 01 jan 1970/i.test(header);
    if (expired || value === '') jar.delete(name);
    else jar.set(name, value);
  }
  return [...jar].map(([n, v]) => `${n}=${v}`).join('; ');
}

/** The payload of a JWT whose signature has already been verified. */
function verifiedPayload(token: string): Record<string, unknown> | null {
  const body = token.split('.')[1];
  if (!body) return null;
  try {
    const json = new TextDecoder().decode(Uint8Array.from(atob(body.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));
    const payload: unknown = JSON.parse(json);
    return typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The matrix's "without proxy" pass. `process.env.NODE_ENV` is written out literally so Next's
 * production build replaces it with "production" and drops this branch entirely.
 */
function isMatrixHandlerPass(request: NextRequest): boolean {
  if (request.headers.get(MATRIX_REQUEST_HEADER) !== MATRIX_HANDLER_PASS_VALUE) return false;
  if (typeof process === 'undefined' || process.env.NODE_ENV === 'production') return false;
  return process.env[MATRIX_ENV_FLAG] === '1' && isLoopbackHostname(request.nextUrl.hostname);
}

type TokenState =
  | { kind: 'valid' }
  | { kind: 'expired'; error: UnauthenticatedError }
  | { kind: 'invalid'; error: UnauthenticatedError };

/** Builds the proxy function. Export it as `proxy` (or default) from `proxy.ts`. */
export function withAuthProxy(options: AuthProxyOptions): (request: NextRequest) => Promise<NextResponse> {
  validateProxyOptions(options);
  const signInPath = options.signInPath ?? '/sign-in';
  const isPublic = makePublicCheck([
    ...(options.allowNextInternals === false ? [] : NEXT_INTERNALS),
    signInPath,
    ...(options.publicRoutes ?? []),
  ]);
  const isApiRoute = compile(options.apiRoutes ?? ['/api/*']);
  const noStore = options.noStore ?? true;
  const { auth, refresh, onRefresh } = options;
  const gate = refresh ? createRefreshGate<RefreshResult>(options.refreshLimits) : null;

  /**
   * The request headers routes see: the app's extra headers (the `headers` hook), then the recorded
   * return path (never the client's) and refreshed cookies. A client's own CSP request headers are
   * dropped, so the nonce Next reads only ever comes from the app.
   */
  function forwardedHeaders(request: NextRequest, extra: ExtraHeaders, refreshed?: RefreshResult): Headers {
    const headers = new Headers(request.headers);
    for (const name of CSP_REQUEST_HEADERS) headers.delete(name);
    for (const [name, value] of extra.request) headers.set(name, value);
    headers.set(RETURN_PATH_HEADER, safeRedirect(`${request.nextUrl.pathname}${request.nextUrl.search}`, '/'));
    if (refreshed) headers.set('cookie', mergeCookieHeader(request.headers.get('cookie'), refreshed.setCookies));
    return headers;
  }

  function pass(
    request: NextRequest,
    extra: ExtraHeaders,
    opts: { protectedRoute: boolean; handlerPass: boolean; refreshed?: RefreshResult },
  ): NextResponse {
    const response = NextResponse.next({ request: { headers: forwardedHeaders(request, extra, opts.refreshed) } });
    if (opts.refreshed) for (const cookie of opts.refreshed.setCookies) response.headers.append('set-cookie', cookie);
    if (opts.protectedRoute && noStore) response.headers.set('Cache-Control', PRIVATE_NO_STORE);
    if (opts.handlerPass) response.headers.set(PROXY_RESPONSE_HEADER, PROXY_HANDLER_PASS);
    return response;
  }

  function wantsJson(request: NextRequest): boolean {
    return isApiRoute(request.nextUrl.pathname) || !SAFE_METHODS.has(request.method.toUpperCase());
  }

  function deny(request: NextRequest, error: AuthError): NextResponse {
    let response: NextResponse;
    if (error instanceof AuthUnavailableError || wantsJson(request)) {
      response = toNextResponse(authErrorResponse(error));
    } else {
      const target = signInUrl(`${request.nextUrl.pathname}${request.nextUrl.search}`, { signInPath });
      response = NextResponse.redirect(new URL(target, request.url), 307);
      response.headers.set('Cache-Control', PRIVATE_NO_STORE);
    }
    response.headers.set(PROXY_RESPONSE_HEADER, PROXY_DENIED);
    return response;
  }

  async function check(token: string | undefined): Promise<TokenState> {
    if (!token) return { kind: 'invalid', error: new UnauthenticatedError() };
    try {
      await auth.verifyAccessToken(token);
      return { kind: 'valid' };
    } catch (error) {
      if (!(error instanceof UnauthenticatedError)) throw error;
      return error.code === 'token_expired' ? { kind: 'expired', error } : { kind: 'invalid', error };
    }
  }

  /**
   * Refreshes only an Amplify cookie session whose access token is genuine (verified signature, this
   * pool and client) but expired, and that carries a refresh-token cookie; within `refreshLimits`.
   */
  async function tryRefresh(request: NextRequest, found: FoundTokens): Promise<RefreshResult | null> {
    if (!gate || !refresh || found.source !== 'amplify-cookies' || !found.accessToken || !found.refreshToken) return null;
    const claims = verifiedPayload(found.accessToken);
    if (typeof claims?.sub !== 'string' || typeof claims.jti !== 'string') return null;
    // The session key includes the refresh token, so only requests holding the same refresh token
    // share an in-flight refresh (and its new cookies).
    const sessionKey = `${claims.sub}\n${claims.jti}\n${found.refreshToken}`;
    const { result, outcome } = await gate.run(claims.sub, sessionKey, async () => {
      const refreshed = await refresh(request);
      if (!refreshed) return null;
      return (await check(refreshed.accessToken)).kind === 'valid' ? refreshed : null;
    });
    onRefresh?.({ outcome, path: request.nextUrl.pathname });
    return result;
  }

  async function decide(request: NextRequest, extra: ExtraHeaders): Promise<NextResponse> {
    const handlerPass = isMatrixHandlerPass(request);
    if (isPublic(request.nextUrl.pathname)) return pass(request, extra, { protectedRoute: false, handlerPass });
    if (handlerPass) return pass(request, extra, { protectedRoute: true, handlerPass });
    try {
      const found = await auth.tokenSource(toRequestContext(request));
      const state = await check(found.accessToken);
      if (state.kind === 'valid') return pass(request, extra, { protectedRoute: true, handlerPass: false });
      if (state.kind === 'expired') {
        const refreshed = await tryRefresh(request, found);
        if (refreshed) return pass(request, extra, { protectedRoute: true, handlerPass: false, refreshed });
      }
      return deny(request, state.error);
    } catch (error) {
      if (error instanceof UnauthenticatedError) return deny(request, error);
      return deny(
        request,
        error instanceof AuthUnavailableError ? error : new AuthUnavailableError(undefined, { cause: error }),
      );
    }
  }

  return async function proxy(request: NextRequest): Promise<NextResponse> {
    // Outside the auth decision's try block: a hook that throws (or names a reserved header) fails
    // the request instead of being mistaken for "couldn't check".
    const extra = options.headers ? resolveExtraHeaders(await options.headers(request)) : NO_EXTRA_HEADERS;
    const response = await decide(request, extra);
    for (const [name, value] of extra.response) response.headers.set(name, value);
    return response;
  };
}

/**
 * The dependencies `amplifyAdapterRefresh` needs from `@aws-amplify/adapter-nextjs` and
 * `aws-amplify/auth/server`, typed loosely so auth-kit doesn't pin their versions.
 */
export interface AmplifyAdapterRefreshDeps {
  runWithAmplifyServerContext: <T>(input: {
    nextServerContext: { request: NextRequest; response: NextResponse };
    operation: (contextSpec: never) => T | Promise<T>;
  }) => Promise<T>;
  fetchAuthSession: (contextSpec: never) => Promise<{ tokens?: { accessToken?: { toString(): string } } | undefined }>;
}

/**
 * A refresh handler that uses the Amplify Next adapter: with a request/response context,
 * `fetchAuthSession` exchanges the refresh-token cookie for new tokens and writes the cookies to the
 * response. The new access token is verified again by the proxy before the request goes through.
 * Create the adapter's runner with `amplifyCookieRuntimeOptions` so those cookies are Secure.
 *
 * ```ts
 * import { fetchAuthSession } from 'aws-amplify/auth/server';
 * import { runWithAmplifyServerContext } from '@/lib/amplify-server';
 * export const proxy = withAuthProxy({ auth, refresh: amplifyAdapterRefresh({ runWithAmplifyServerContext, fetchAuthSession }) });
 * ```
 */
export function amplifyAdapterRefresh(deps: AmplifyAdapterRefreshDeps): RefreshHandler {
  return async (request) => {
    const response = NextResponse.next();
    let token: string | undefined;
    try {
      token = await deps.runWithAmplifyServerContext({
        nextServerContext: { request, response },
        operation: async (contextSpec) => (await deps.fetchAuthSession(contextSpec)).tokens?.accessToken?.toString(),
      });
    } catch {
      // A failed refresh means "sign in again", the same as no refresh token at all.
      return null;
    }
    if (typeof token !== 'string' || token === '') return null;
    return { accessToken: token, setCookies: response.headers.getSetCookie() };
  };
}

export { RETURN_PATH_HEADER };
export { DEFAULT_REFRESH_LIMITS, type RefreshLimits, type RefreshOutcome } from './refresh-gate.js';
export {
  MATRIX_ENV_FLAG,
  MATRIX_HANDLER_PASS_VALUE,
  MATRIX_REQUEST_HEADER,
  PROXY_RESPONSE_HEADER,
} from '../shared/matrix-protocol.js';
