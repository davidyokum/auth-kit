/**
 * Cookie and request-origin helpers.
 *
 * **The honest tradeoff with Amplify.** The standard client is Amplify with `ssr: true`, which keeps
 * tokens in cookies that page scripts can read (not httpOnly): Amplify's own browser code reads them
 * to call Cognito. Amplify's fully httpOnly mode (`createAuthRouteHandlers`) is still marked
 * experimental, needs managed login, and turns off Amplify's client-side APIs. So for the tokens
 * themselves, auth-kit:
 * - keeps them out of localStorage (cookies only, via `ssr: true`);
 * - sets `SameSite=Lax` and a lifetime no longer than the refresh token
 *   (`amplifyCookieRuntimeOptions`); Secure is set by the adapter on HTTPS;
 * - relies on a strict Content-Security-Policy as the main defense against injected scripts, because
 *   any script running in the page can read those cookies.
 *
 * Cookies the app sets itself (preferences, flash messages, anything sensitive) use
 * `secureCookieOptions`: httpOnly, Secure, SameSite=Lax.
 */
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

/**
 * Runtime options for the Next adapter's `createServerRunner`, so Amplify's token cookies are
 * SameSite=Lax and expire with the refresh token instead of outliving it.
 *
 * ```ts
 * createServerRunner({ config: outputs, runtimeOptions: amplifyCookieRuntimeOptions({ refreshTokenMinutes: 43200 }) });
 * ```
 */
export function amplifyCookieRuntimeOptions(input: { refreshTokenMinutes: number; domain?: string }) {
  return {
    cookies: {
      sameSite: 'lax' as const,
      maxAge: input.refreshTokenMinutes * 60,
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
  /** Extra origins allowed to send state-changing requests, e.g. `https://admin.example.org`. */
  allowedOrigins?: readonly string[];
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * True when a state-changing request comes from the app's own origin. Route handlers that change
 * data call this (server actions get Next's built-in origin check).
 *
 * - Safe methods (GET, HEAD, OPTIONS) pass. They must not change data.
 * - Otherwise the `Origin` header must equal the request's origin or an allowed origin.
 * - With no `Origin`, `Sec-Fetch-Site: same-origin` passes; anything else fails closed.
 * `X-Forwarded-Host` is never trusted.
 */
export function isSameOriginRequest(request: OriginCheckRequest, options: OriginCheckOptions = {}): boolean {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return true;
  let own: string;
  try {
    own = new URL(request.url).origin;
  } catch {
    return false;
  }
  const allowed = new Set([own, ...(options.allowedOrigins ?? [])]);
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
