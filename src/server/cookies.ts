/**
 * Cookie and request-origin helpers.
 *
 * **The honest tradeoff with Amplify.** The standard client is Amplify with `ssr: true`, which keeps
 * tokens in cookies that page scripts can read (not httpOnly): Amplify's own browser code reads them
 * to call Cognito. Amplify's fully httpOnly mode (`createAuthRouteHandlers`) is still marked
 * experimental, needs managed login, and turns off Amplify's client-side APIs. So for the tokens
 * themselves, auth-kit:
 * - keeps them out of localStorage (cookies only, via `ssr: true`);
 * - makes the token cookies the **server** writes (the proxy's refresh, through the adapter) Secure,
 *   SameSite=Lax, and no longer-lived than the refresh token (`amplifyCookieRuntimeOptions`). Secure
 *   is set explicitly: the adapter adds it itself only in its experimental httpOnly mode, and
 *   otherwise relies on an internal default in `aws-amplify/adapter-core`;
 * - leaves the cookies the **browser** writes (sign-in and client-side refreshes) to Amplify's client
 *   `CookieStorage`: Secure and SameSite=Lax by default, but a 365-day lifetime unless the app passes
 *   its own (`configureAuthClient` in `auth-kit/client` does);
 * - relies on a strict Content-Security-Policy as the main defense against injected scripts, because
 *   any script running in the page can read those cookies.
 *
 * Cookies the app sets itself (preferences, flash messages, anything sensitive) use
 * `secureCookieOptions`: httpOnly, Secure, SameSite=Lax.
 */
import { isPlainHttpLoopbackOrigin } from '../shared/loopback.js';
import { ForbiddenError } from './errors.js';
import type { HeaderReader } from './tokens.js';

export interface CookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'lax' | 'strict' | 'none';
  path?: string;
  domain?: string;
  /** Seconds. */
  maxAge?: number;
  expires?: Date;
}

export const SECURE_COOKIE_DEFAULTS = Object.freeze({
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
} as const satisfies CookieOptions);

/**
 * Options for a cookie the app sets: httpOnly, Secure, SameSite=Lax, path `/`, plus overrides.
 * SameSite=None is refused unless Secure is on.
 */
export function secureCookieOptions(overrides: CookieOptions = {}): CookieOptions {
  const options: CookieOptions = { ...SECURE_COOKIE_DEFAULTS, ...overrides };
  if (options.sameSite === 'none' && options.secure !== true) {
    throw new Error('auth-kit: SameSite=None cookies must be Secure.');
  }
  return options;
}

const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// RFC 6265 cookie-octet: printable ASCII except space, DQUOTE, comma, semicolon, and backslash.
const COOKIE_VALUE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;

/** Serializes a Set-Cookie header value (RFC 6265), for code that can't use Next's cookies API. */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  if (!COOKIE_NAME.test(name)) throw new Error(`auth-kit: invalid cookie name "${name}".`);
  if (!COOKIE_VALUE.test(value)) throw new Error('auth-kit: cookie value has characters that need encoding.');
  const parts = [`${name}=${value}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.domain) parts.push(`Domain=${options.domain}`);
  parts.push(`Path=${options.path ?? '/'}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (options.sameSite) parts.push(`SameSite=${options.sameSite[0]!.toUpperCase()}${options.sameSite.slice(1)}`);
  if (options.sameSite === 'none' && !options.secure) throw new Error('auth-kit: SameSite=None cookies must be Secure.');
  return parts.join('; ');
}

export interface AmplifyCookieRuntimeInput {
  /** The app client's refresh-token lifetime (the preset's `refreshTokenMinutes`). */
  refreshTokenMinutes: number;
  domain?: string;
  /**
   * Local development over plain http only, e.g. `http://app.localhost:3000`: the token cookies then
   * omit Secure, for browsers that won't store Secure cookies from an http page. Must be an `http:`
   * origin on a loopback host; anything else throws. Leave it unset everywhere else.
   */
  localDevOrigin?: string;
}

/**
 * Runtime options for the Next adapter's `createServerRunner`, so the token cookies the server writes
 * are Secure, SameSite=Lax, and expire with the refresh token instead of outliving it.
 *
 * ```ts
 * createServerRunner({
 *   config: outputs,
 *   runtimeOptions: amplifyCookieRuntimeOptions({
 *     refreshTokenMinutes: 43200,
 *     localDevOrigin: process.env.NODE_ENV === 'development' ? 'http://app.localhost:3000' : undefined,
 *   }),
 * });
 * ```
 *
 * `secure` isn't in the adapter's published option type, but the adapter passes every cookie option
 * through to Set-Cookie (auth-kit's tests run the real adapter to prove it).
 */
export function amplifyCookieRuntimeOptions(input: AmplifyCookieRuntimeInput) {
  if (!(input.refreshTokenMinutes > 0) || !Number.isFinite(input.refreshTokenMinutes)) {
    throw new Error('auth-kit: amplifyCookieRuntimeOptions needs a positive refreshTokenMinutes.');
  }
  if (input.localDevOrigin !== undefined && !isPlainHttpLoopbackOrigin(input.localDevOrigin)) {
    throw new Error(
      `auth-kit: localDevOrigin "${input.localDevOrigin}" isn't an http:// origin on localhost. ` +
        'Token cookies are Secure everywhere else; leave localDevOrigin unset outside local development.',
    );
  }
  return {
    cookies: {
      sameSite: 'lax' as const,
      secure: input.localDevOrigin === undefined,
      maxAge: Math.floor(input.refreshTokenMinutes * 60),
      ...(input.domain !== undefined && { domain: input.domain }),
    },
  };
}

/** `Cache-Control` for every private or admin response: rendered per request, never cached. */
export const PRIVATE_NO_STORE = 'private, no-store';

/** Adds `Cache-Control: private, no-store` to a Headers object (or a Response's headers). */
export function applyNoStore(headers: Headers): Headers {
  headers.set('Cache-Control', PRIVATE_NO_STORE);
  return headers;
}

export interface OriginCheckRequest {
  method: string;
  url: string;
  headers: HeaderReader;
}

export interface OriginCheckOptions {
  /**
   * The site's public origin, e.g. `https://reports.example.org`. When set, `Origin` is compared with
   * this instead of the origin rebuilt from `request.url`, whose scheme can differ from the browser's
   * behind a CDN (whether Amplify Hosting's CloudFront → compute hop does is a verify-on-first-deploy
   * item). Set it in production from configuration, never from request headers.
   */
  expectedOrigin?: string;
  /** Extra origins allowed to send state-changing requests, e.g. `https://admin.example.org`. */
  allowedOrigins?: readonly string[];
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** An exact origin (`scheme://host[:port]`, no path or trailing slash), or a thrown configuration error. */
function assertOrigin(value: string, label: string): string {
  let url: URL | null = null;
  try {
    url = new URL(value);
  } catch {
    // reported below
  }
  if (!url || url.origin === 'null' || url.origin !== value) {
    throw new Error(`auth-kit: ${label} "${value}" must be an origin like https://app.example.org (no path or trailing slash).`);
  }
  return value;
}

/**
 * True when a state-changing request comes from the app's own origin. Route handlers that change
 * data call this (server actions get Next's built-in origin check).
 *
 * - Safe methods (GET, HEAD, OPTIONS) pass. They must not change data.
 * - Otherwise the `Origin` header must equal the site's origin (`expectedOrigin`, else the origin of
 *   `request.url`) or an allowed origin. Scheme, host, and port all count.
 * - With no `Origin`, `Sec-Fetch-Site: same-origin` passes; anything else fails closed.
 * `X-Forwarded-Host` and `X-Forwarded-Proto` are never trusted. A malformed `expectedOrigin` or
 * `allowedOrigins` entry throws, so a typo fails loudly instead of refusing every request.
 */
export function isSameOriginRequest(request: OriginCheckRequest, options: OriginCheckOptions = {}): boolean {
  const extra = (options.allowedOrigins ?? []).map((o) => assertOrigin(o, 'allowedOrigins entry'));
  const expected = options.expectedOrigin === undefined ? undefined : assertOrigin(options.expectedOrigin, 'expectedOrigin');
  if (SAFE_METHODS.has(request.method.toUpperCase())) return true;
  let own: string;
  if (expected !== undefined) {
    own = expected;
  } else {
    try {
      own = new URL(request.url).origin;
    } catch {
      return false;
    }
  }
  const allowed = new Set([own, ...extra]);
  const origin = request.headers.get('origin');
  if (origin !== null) return origin !== 'null' && allowed.has(origin);
  return request.headers.get('sec-fetch-site') === 'same-origin';
}

/** Throws a 403 (`origin_mismatch`) unless `isSameOriginRequest` passes. */
export function assertSameOrigin(request: OriginCheckRequest, options: OriginCheckOptions = {}): void {
  if (!isSameOriginRequest(request, options)) {
    throw new ForbiddenError('This request did not come from this site.', 'origin_mismatch');
  }
}
