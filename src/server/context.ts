import type * as NextHeaders from 'next/headers.js';
import type { CookieReader, HeaderReader, RequestContext } from './tokens.js';

/** Anything auth-kit can read a request from: a NextRequest, a plain Request, or a RequestContext. */
export type RequestInput = RequestContext | Request | { headers: HeaderReader; cookies?: CookieReader };

/**
 * Parses a Cookie header exactly the way Next's `RequestCookies` does (`@edge-runtime/cookies`), so
 * every layer reads the same session: the proxy and route handlers use Next's parser through
 * `NextRequest.cookies` and `cookies()`, and a plain `Request` comes through here.
 *
 * - Pairs are split on `;` followed by any spaces; names aren't otherwise trimmed.
 * - A pair without `=` is the name with the value `true`.
 * - Values are percent-decoded once; a pair whose value can't be decoded is skipped.
 * - When a name repeats, the **last** occurrence wins.
 *
 * Duplicates happen legitimately (Amplify cookies left at another path) and adversarially (a sibling
 * subdomain setting `Domain=<parent>` cookies). Refusing them would lock people out over a stale
 * cookie, so auth-kit agrees with Next instead, and sites on custom domains must not share a parent
 * domain with apps they don't trust (see the README).
 */
export function parseCookieHeader(header: string | null): CookieReader {
  const jar = new Map<string, string>();
  if (header) {
    for (const pair of header.split(/; */)) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      if (eq === -1) {
        jar.set(pair, 'true');
        continue;
      }
      try {
        jar.set(pair.slice(0, eq), decodeURIComponent(pair.slice(eq + 1)));
      } catch {
        // Undecodable value: skipped, as Next does.
      }
    }
  }
  return { get: (name) => (jar.has(name) ? { value: jar.get(name)! } : undefined) };
}

function hasCookieReader(value: unknown): value is { cookies: CookieReader } {
  if (typeof value !== 'object' || value === null || !('cookies' in value)) return false;
  const cookies = value.cookies;
  return typeof cookies === 'object' && cookies !== null && typeof (cookies as { get?: unknown }).get === 'function';
}

/** Normalizes any supported request shape into a RequestContext. */
export function toRequestContext(input: RequestInput): RequestContext {
  if (hasCookieReader(input)) return { cookies: input.cookies, headers: input.headers };
  return { cookies: parseCookieHeader(input.headers.get('cookie')), headers: input.headers };
}

/**
 * The current request's cookies and headers inside Next.js (route handlers, server actions, server
 * components). Loaded lazily so auth-kit/server also works outside Next when a request is passed.
 */
export async function nextHeadersContext(): Promise<RequestContext> {
  let mod: typeof NextHeaders;
  try {
    mod = await import('next/headers.js');
  } catch (error) {
    throw new Error('auth-kit: no request was passed and next/headers is unavailable. Pass { request }.', {
      cause: error,
    });
  }
  const [cookies, headers] = await Promise.all([mod.cookies(), mod.headers()]);
  return { cookies, headers };
}
