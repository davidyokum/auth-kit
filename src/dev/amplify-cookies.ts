/**
 * The cookies Amplify's own sign-in writes (`ssr: true`), so a persona signed in by the dev route is
 * indistinguishable from one who typed a password: the same names, values, and attributes that
 * `auth-kit/server` reads and Amplify's browser and server code refresh.
 *
 * Names follow Amplify's token store: `CognitoIdentityServiceProvider.<clientId>.LastAuthUser` holds
 * the username, and `…<clientId>.<username>.{accessToken,idToken,refreshToken,clockDrift,signInDetails}`
 * hold the session. Values are encoded the way js-cookie (Amplify's cookie library) encodes them.
 */
import { type CookieOptions, serializeCookie } from '../server/cookies.js';
import { AMPLIFY_COOKIE_PREFIX, type CookieReader, encodeCookieName } from '../server/tokens.js';
import type { PersonaTokens } from './exchange.js';
import { decodeJwtPayload } from './jwt.js';

/** js-cookie's value encoding, which Amplify's `CookieStorage` uses. */
export function encodeCookieValue(value: string): string {
  return encodeURIComponent(value).replace(/%(2[346BF]|3[AC-F]|40|5[BDE]|60|7[BCD])/g, decodeURIComponent);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Cookie name → raw value, from a `Cookie` header. */
export function parseCookieHeader(header: string | null | undefined): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (name && !jar.has(name)) jar.set(name, part.slice(eq + 1).trim());
  }
  return jar;
}

export interface AmplifySessionCookieOptions {
  clientId: string;
  tokens: PersonaTokens;
  /** The sign-in name, stored in `signInDetails` as Amplify does. */
  email: string;
  /** Set on HTTPS. On http://localhost the cookies are not Secure, so every browser keeps them. */
  secure: boolean;
  /** Cookie lifetime: no longer than the refresh token's. */
  maxAgeSeconds: number;
  now?: number;
}

/** The Set-Cookie headers for a signed-in persona, and the cookie names they set. */
export function amplifySessionCookies(options: AmplifySessionCookieOptions): { names: Set<string>; headers: string[] } {
  const base = `${AMPLIFY_COOKIE_PREFIX}.${options.clientId}`;
  const user = `${base}.${options.tokens.username}`;
  const iat = decodeJwtPayload(options.tokens.accessToken)?.iat;
  const now = options.now ?? Date.now();
  const clockDrift = typeof iat === 'number' && iat > 0 ? iat * 1000 - now : 0;
  const entries: [string, string][] = [
    [`${base}.LastAuthUser`, options.tokens.username],
    [`${user}.accessToken`, options.tokens.accessToken],
    ...(options.tokens.idToken !== undefined ? ([[`${user}.idToken`, options.tokens.idToken]] as [string, string][]) : []),
    ...(options.tokens.refreshToken !== undefined ? ([[`${user}.refreshToken`, options.tokens.refreshToken]] as [string, string][]) : []),
    [`${user}.clockDrift`, String(clockDrift)],
    [`${user}.signInDetails`, JSON.stringify({ loginId: options.email, authFlowType: 'USER_AUTH' })],
  ];
  const cookie: CookieOptions = { path: '/', sameSite: 'lax', secure: options.secure, maxAge: options.maxAgeSeconds };
  const names = new Set<string>();
  const headers = entries.map(([name, value]) => {
    const encoded = encodeCookieName(name);
    names.add(encoded);
    return serializeCookie(encoded, encodeCookieValue(value), cookie);
  });
  return { names, headers };
}

/** Set-Cookie headers that expire every Amplify cookie for this client in the request, except `keep`. */
export function expireAmplifyCookies(
  clientId: string,
  cookieHeader: string | null | undefined,
  options: { keep?: ReadonlySet<string>; secure: boolean },
): string[] {
  const prefix = `${AMPLIFY_COOKIE_PREFIX}.${clientId}.`;
  const out: string[] = [];
  for (const name of parseCookieHeader(cookieHeader).keys()) {
    if (options.keep?.has(name) || !safeDecode(name).startsWith(prefix)) continue;
    try {
      out.push(serializeCookie(name, '', { path: '/', sameSite: 'lax', secure: options.secure, maxAge: 0 }));
    } catch {
      // A name serializeCookie can't write isn't one Amplify wrote.
    }
  }
  return out;
}

export interface AmplifySession {
  username?: string;
  accessToken?: string;
  idToken?: string;
  refreshToken?: string;
}

/**
 * The session Amplify's cookies hold for this client (unverified; for display and sign-out only).
 * Takes a `Cookie` header or a cookie reader such as Next's `cookies()`.
 */
export function readAmplifySession(clientId: string, cookies: string | null | undefined | CookieReader): AmplifySession {
  const read: (name: string) => string | undefined =
    cookies !== null && typeof cookies === 'object'
      ? (name) => cookies.get(name)?.value
      : ((jar) => (name: string) => jar.get(name))(parseCookieHeader(cookies));
  const get = (name: string) => {
    const raw = read(encodeCookieName(name));
    return raw === undefined || raw === '' ? undefined : safeDecode(raw);
  };
  const base = `${AMPLIFY_COOKIE_PREFIX}.${clientId}`;
  const username = get(`${base}.LastAuthUser`);
  if (!username) return {};
  const accessToken = get(`${base}.${username}.accessToken`);
  const idToken = get(`${base}.${username}.idToken`);
  const refreshToken = get(`${base}.${username}.refreshToken`);
  return {
    username,
    ...(accessToken !== undefined && { accessToken }),
    ...(idToken !== undefined && { idToken }),
    ...(refreshToken !== undefined && { refreshToken }),
  };
}
