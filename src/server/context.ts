import type { CookieReader, HeaderReader, RequestContext } from './tokens.js';

/** Anything auth-kit can read a request from: a NextRequest, a plain Request, or a RequestContext. */
export type RequestInput = RequestContext | Request | { headers: HeaderReader; cookies?: CookieReader };

function parseCookieHeader(header: string | null): CookieReader {
  const jar = new Map<string, string>();
  if (header) {
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      const name = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      // The first occurrence wins, matching how browsers order more specific cookies first.
      if (name && !jar.has(name)) jar.set(name, value);
    }
  }
  return { get: (name) => (jar.has(name) ? { value: jar.get(name)! } : undefined) };
}

function hasCookieReader(value: unknown): value is { cookies: CookieReader } {
  if (typeof value !== 'object' || value === null || !('cookies' in value)) return false;
  const cookies = (value as { cookies: unknown }).cookies;
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
  let mod: typeof import('next/headers');
  try {
    mod = await import('next/headers');
  } catch (error) {
    throw new Error('auth-kit: no request was passed and next/headers is unavailable. Pass { request }.', {
      cause: error,
    });
  }
  const [cookies, headers] = await Promise.all([mod.cookies(), mod.headers()]);
  return { cookies, headers };
}
