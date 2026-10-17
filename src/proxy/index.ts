/**
 * `auth-kit/proxy`: `withAuthProxy()` for Next 16's `proxy.ts` (formerly middleware).
 *
 * - **Default-deny.** Every path is protected except an explicit allowlist of public routes, so a
 *   route someone forgets to list is still protected.
 * - **Verifies tokens** (signature, expiry, issuer, audience, token use), not just that a cookie exists.
 * - **Never the only gate.** Proxies have had bypass bugs (CVE-2025-29927) and don't gate build
 *   assets, so every route handler, server action, and data-loading component still calls
 *   `requireUser()` / `requireCan()`. The proxy passes no identity downstream for routes to trust.
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
import { safeRedirect } from '../server/redirect.js';
import type { TokenSource } from '../server/tokens.js';
import type { AccessTokenClaims } from '../server/verify.js';

/** A public-route rule: an exact path, a prefix ending in `/*` (matches the prefix itself too), or a RegExp. */
export type PublicRoute = string | RegExp;

/** The part of `createServerAuth()`'s result the proxy uses. */
export interface ProxyAuth {
  readonly pool: Readonly<Pick<ResolvedPoolConfig, 'clientId'>>;
  readonly tokenSource: TokenSource;
  verifyAccessToken(token: string): Promise<AccessTokenClaims>;
}

/** Fresh tokens from a server-side refresh, plus the Set-Cookie headers that store them. */
export interface RefreshResult {
  accessToken: string;
  setCookies: readonly string[];
}

/** Refreshes an expired session server-side (see `amplifyAdapterRefresh`). Return null when it can't. */
export type RefreshHandler = (request: NextRequest) => Promise<RefreshResult | null>;

export interface AuthProxyOptions {
  auth: ProxyAuth;
  /** Paths anyone may load. The sign-in path is always public. */
  publicRoutes?: readonly PublicRoute[];
  /** Default `/sign-in`. */
  signInPath?: string;
  /** Paths answered with 401 JSON instead of a sign-in redirect. Default `['/api/*']`. */
  apiRoutes?: readonly PublicRoute[];
  /** Treat `/_next/static/*`, `/_next/image`, and `/favicon.ico` as public. Default `true`. */
  allowNextInternals?: boolean;
  /** Refresh an expired session server-side so it isn't bounced to sign-in hourly. */
  refresh?: RefreshHandler;
  /** Add `Cache-Control: private, no-store` to protected responses. Default `true`. */
  noStore?: boolean;
}

const NEXT_INTERNALS: readonly PublicRoute[] = ['/_next/static/*', '/_next/image', '/favicon.ico'];
const SAFE_METHODS = new Set(['GET', 'HEAD']);

function normalizePath(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.replace(/\/+$/, '') || '/' : path;
}

function compile(routes: readonly PublicRoute[]): (path: string) => boolean {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  const patterns: RegExp[] = [];
  for (const route of routes) {
    if (route instanceof RegExp) {
      patterns.push(route);
    } else if (route.endsWith('/*')) {
      prefixes.push(normalizePath(route.slice(0, -2) || '/'));
    } else {
      if (!route.startsWith('/')) throw new Error(`auth-kit: public route "${route}" must start with "/".`);
      exact.add(normalizePath(route));
    }
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

/** Builds the proxy function. Export it as `proxy` (or default) from `proxy.ts`. */
export function withAuthProxy(options: AuthProxyOptions): (request: NextRequest) => Promise<NextResponse> {
  const signInPath = safeRedirect(options.signInPath ?? '/sign-in', '/sign-in').split('?')[0] ?? '/sign-in';
  const isPublic = makePublicCheck([
    ...(options.allowNextInternals === false ? [] : NEXT_INTERNALS),
    signInPath,
    ...(options.publicRoutes ?? []),
  ]);
  const isApiRoute = compile(options.apiRoutes ?? ['/api/*']);
  const noStore = options.noStore ?? true;
  const { auth } = options;

  /** Pass through, recording the requested path for sign-in return links and refreshing cookies. */
  function allow(request: NextRequest, refreshed?: RefreshResult): NextResponse {
    const headers = new Headers(request.headers);
    headers.set(RETURN_PATH_HEADER, safeRedirect(`${request.nextUrl.pathname}${request.nextUrl.search}`, '/'));
    if (refreshed) headers.set('cookie', mergeCookieHeader(request.headers.get('cookie'), refreshed.setCookies));
    const response = NextResponse.next({ request: { headers } });
    if (refreshed) for (const cookie of refreshed.setCookies) response.headers.append('set-cookie', cookie);
    if (noStore) response.headers.set('Cache-Control', PRIVATE_NO_STORE);
    return response;
  }

  function wantsJson(request: NextRequest): boolean {
    return isApiRoute(request.nextUrl.pathname) || !SAFE_METHODS.has(request.method.toUpperCase());
  }

  function deny(request: NextRequest, error: AuthError): NextResponse {
    if (error instanceof AuthUnavailableError || wantsJson(request)) {
      return toNextResponse(authErrorResponse(error));
    }
    const target = signInUrl(`${request.nextUrl.pathname}${request.nextUrl.search}`, { signInPath });
    const response = NextResponse.redirect(new URL(target, request.url), 307);
    response.headers.set('Cache-Control', PRIVATE_NO_STORE);
    return response;
  }

  async function verifies(token: string | undefined): Promise<boolean> {
    if (!token) return false;
    try {
      await auth.verifyAccessToken(token);
      return true;
    } catch (error) {
      if (error instanceof UnauthenticatedError) return false;
      throw error;
    }
  }

  return async function proxy(request: NextRequest): Promise<NextResponse> {
    if (isPublic(request.nextUrl.pathname)) return NextResponse.next();
    try {
      const found = await auth.tokenSource(toRequestContext(request));
      if (await verifies(found.accessToken)) return allow(request);
      if (options.refresh) {
        const refreshed = await options.refresh(request);
        if (refreshed && (await verifies(refreshed.accessToken))) return allow(request, refreshed);
      }
      return deny(request, new UnauthenticatedError());
    } catch (error) {
      if (error instanceof UnauthenticatedError) return deny(request, error);
      return deny(
        request,
        error instanceof AuthUnavailableError ? error : new AuthUnavailableError(undefined, { cause: error }),
      );
    }
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
