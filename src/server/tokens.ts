/**
 * Where tokens come from on a request.
 *
 * Amplify's `ssr: true` client keeps tokens in cookies named
 * `CognitoIdentityServiceProvider.<clientId>.LastAuthUser` (the username) and
 * `CognitoIdentityServiceProvider.<clientId>.<username>.accessToken` (and `.idToken`, `.refreshToken`).
 * Names are encoded the way js-cookie encodes them, which the Next adapter mirrors.
 */

/** The minimum auth-kit needs from Next's `cookies()`, `NextRequest.cookies`, or a test double. */
export interface CookieReader {
  get(name: string): { value: string } | undefined;
}

/** The minimum auth-kit needs from `headers()` or `Request.headers`. */
export interface HeaderReader {
  get(name: string): string | null;
}

export interface RequestContext {
  cookies: CookieReader;
  headers: HeaderReader;
}

export interface FoundTokens {
  accessToken?: string;
  idToken?: string;
  /**
   * The refresh token from Amplify's cookies. The proxy reads it only to decide whether a server-side
   * refresh is possible and to group concurrent refreshes of one session; auth-kit never logs it or
   * sends it anywhere (the Amplify adapter reads its own copy of the cookie).
   */
  refreshToken?: string;
  /** Where the tokens were found. Only `amplify-cookies` sessions are refreshed server-side. */
  source?: 'amplify-cookies' | 'bearer';
}

export type TokenSource = (context: RequestContext) => FoundTokens | Promise<FoundTokens>;

export const AMPLIFY_COOKIE_PREFIX = 'CognitoIdentityServiceProvider';

/** js-cookie's name encoding (the Next adapter uses the same rule). */
export function encodeCookieName(name: string): string {
  return encodeURIComponent(name).replace(/%(2[346B]|5E|60|7C)/g, decodeURIComponent);
}

/** The cookie names Amplify uses for one app client and username. */
export function amplifyCookieNames(clientId: string, username?: string) {
  const base = `${AMPLIFY_COOKIE_PREFIX}.${clientId}`;
  return {
    lastAuthUser: encodeCookieName(`${base}.LastAuthUser`),
    ...(username !== undefined && {
      accessToken: encodeCookieName(`${base}.${username}.accessToken`),
      idToken: encodeCookieName(`${base}.${username}.idToken`),
      refreshToken: encodeCookieName(`${base}.${username}.refreshToken`),
    }),
  };
}

function cookieValue(cookies: CookieReader, name: string): string | undefined {
  const raw = cookies.get(name)?.value;
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Reads the access and ID tokens Amplify's `ssr: true` client stores in cookies. */
export function amplifyCookieTokens(clientId: string): TokenSource {
  return ({ cookies }) => {
    const username = cookieValue(cookies, amplifyCookieNames(clientId).lastAuthUser);
    if (!username) return {};
    const names = amplifyCookieNames(clientId, username);
    const accessToken = names.accessToken ? cookieValue(cookies, names.accessToken) : undefined;
    const idToken = names.idToken ? cookieValue(cookies, names.idToken) : undefined;
    const refreshToken = names.refreshToken ? cookieValue(cookies, names.refreshToken) : undefined;
    if (!accessToken) return {};
    return {
      accessToken,
      ...(idToken !== undefined && { idToken }),
      ...(refreshToken !== undefined && { refreshToken }),
      source: 'amplify-cookies',
    };
  };
}

/** Reads `Authorization: Bearer <access token>` (APIs called from scripts or other services). */
export function bearerToken(): TokenSource {
  return ({ headers }) => {
    const header = headers.get('authorization');
    if (!header) return {};
    const match = /^Bearer\s+([A-Za-z0-9\-_.]+)\s*$/i.exec(header);
    return match?.[1] ? { accessToken: match[1], source: 'bearer' } : {};
  };
}

/** Tries each source in order and returns the first that finds an access token. */
export function firstTokenSource(...sources: TokenSource[]): TokenSource {
  return async (context) => {
    for (const source of sources) {
      const found = await source(context);
      if (found.accessToken) return found;
    }
    return {};
  };
}

/** The default: a bearer header if present, otherwise Amplify's cookies. */
export function defaultTokenSource(clientId: string): TokenSource {
  return firstTokenSource(bearerToken(), amplifyCookieTokens(clientId));
}
