/**
 * How people sign in to a site (ADR 0029). Pure: no AWS, no React, no Node, so the preset, the
 * screens, the cookies, the emails, and the starter template's setup all read the same rules from here.
 *
 * Two modes, one per site:
 * - `full` (the default): "Full: code, passkey, password". A passkey, a password plus an
 *   authenticator, or an emailed code; a new account chooses a passkey or a password after its first code.
 * - `simple`: "Simple: code only". An emailed code every time, and nothing else: no passkeys, no
 *   passwords, no authenticators. An emailed code is the only way in (the pool lists PASSWORD because Cognito requires it, but nobody can set one). The site picks how long a
 *   sign-in lasts on one device (`stay`): until the browser quits, or a whole number of days.
 *
 * A Simple site moves to Full by changing this setting and deploying: the pool keeps every account,
 * the emailed code keeps working, and each person's next sign-in then asks for a passkey or a
 * password (Full's required first credential). The reverse isn't offered: an account with an
 * authenticator can't receive emailed codes, so it would be locked out.
 */
import { type AuthTier, SESSION_POLICY } from './policy.js';

export const SIGN_IN_MODES = ['full', 'simple'] as const;
export type SignInMode = (typeof SIGN_IN_MODES)[number];

/** How each mode is named wherever the mode is named (setup, Studio, README, sites log). */
export const SIGN_IN_MODE_LABEL: Readonly<Record<SignInMode, string>> = Object.freeze({
  full: 'Full: code, passkey, password',
  simple: 'Simple: code only',
});

/**
 * How long a Simple sign-in lasts on one device, counted from the sign-in (not from the last visit):
 * `'browser'` (until the browser quits, with a 12-hour ceiling), or a whole number of days.
 */
export type SimpleStay = 'browser' | number;

/** The per-site setting (`signIn` in the preset, the screens, and the template's `site.config.ts`). */
export type SignInSettings = { mode: 'full' } | { mode: 'simple'; stay?: SimpleStay };

export interface NormalizedSignIn {
  mode: SignInMode;
  /** Simple only; null on Full. */
  stay: SimpleStay | null;
}

export const FULL_SIGN_IN: NormalizedSignIn = Object.freeze({ mode: 'full', stay: null });

export const SIMPLE_STAY_POLICY = Object.freeze({
  /** The setup default (David, 2026-11-19). */
  defaultDays: 30,
  minDays: 1,
  /** "Every visit": the refresh token's ceiling behind a cookie that ends when the browser quits. */
  browserCeilingMinutes: 12 * 60,
});

/** Thrown when a `signIn` setting can't be used. */
export class SignInConfigError extends Error {
  constructor(message: string) {
    super(`auth-kit: ${message}`);
    this.name = 'SignInConfigError';
  }
}

/** The most days a Simple sign-in may last on this tier: the tier's refresh-token ceiling (30 days on Tier 2, 1 on Tier 3). */
export function maxStayDays(tier: AuthTier): number {
  return Math.floor(SESSION_POLICY.refreshTokenMinutesMax[tier] / (24 * 60));
}

/**
 * Checks a `signIn` setting and fills in its default. `undefined` is Full. Throws `SignInConfigError`
 * for anything else that isn't a valid setting; a Simple `stay` beyond the tier's ceiling is refused.
 */
export function normalizeSignIn(input: SignInSettings | undefined, tier: AuthTier = 2, label = 'signIn'): NormalizedSignIn {
  if (input === undefined) return FULL_SIGN_IN;
  if (typeof input !== 'object' || input === null) throw new SignInConfigError(`${label} must be { mode: 'full' } or { mode: 'simple', stay }.`);
  const mode = (input as { mode?: unknown }).mode;
  if (mode === 'full') {
    if ((input as { stay?: unknown }).stay !== undefined) throw new SignInConfigError(`${label}.stay is for Simple sign-in only; Full sessions follow the tier.`);
    return FULL_SIGN_IN;
  }
  if (mode !== 'simple') throw new SignInConfigError(`${label}.mode must be 'full' or 'simple', not ${JSON.stringify(mode)}.`);
  const raw = (input as { stay?: unknown }).stay;
  const stay = raw === undefined ? Math.min(SIMPLE_STAY_POLICY.defaultDays, maxStayDays(tier)) : raw;
  if (stay === 'browser') return Object.freeze({ mode: 'simple', stay: 'browser' });
  const max = maxStayDays(tier);
  if (typeof stay !== 'number' || !Number.isInteger(stay) || stay < SIMPLE_STAY_POLICY.minDays || stay > max) {
    const allowed = max === SIMPLE_STAY_POLICY.minDays ? `${max} (Tier ${tier} sign-ins last at most a day)` : `a whole number of days from ${SIMPLE_STAY_POLICY.minDays} to ${max}`;
    throw new SignInConfigError(`${label}.stay must be 'browser' or ${allowed}, not ${JSON.stringify(stay)}.`);
  }
  return Object.freeze({ mode: 'simple', stay });
}

/** True for a Simple site: an emailed code is the only way in. */
export function isSimple(signIn: NormalizedSignIn): boolean {
  return signIn.mode === 'simple';
}

/** The refresh-token lifetime a Simple `stay` needs, in minutes. */
export function stayRefreshTokenMinutes(stay: SimpleStay): number {
  return stay === 'browser' ? SIMPLE_STAY_POLICY.browserCeilingMinutes : stay * 24 * 60;
}

/** True when the token cookies should end with the browser (`stay: 'browser'`): no Max-Age, no Expires. */
export function staysForBrowserOnly(signIn: NormalizedSignIn): boolean {
  return signIn.mode === 'simple' && signIn.stay === 'browser';
}

/** "for 30 days", "for 1 day", or "until you quit your browser": after "You stay signed in on this device …". */
export function stayWords(stay: SimpleStay): string {
  if (stay === 'browser') return 'until you quit your browser';
  return `for ${stay} ${stay === 1 ? 'day' : 'days'}`;
}

/**
 * How long a sign-in lasts, for the three places that must agree: the preset's app client, the
 * server's cookie options (`amplifyCookieRuntimeOptions`), and the browser's (`configureAuthClient`).
 * On Full, the tier's ceiling (or the preset's `refreshTokenMinutes`); on Simple, the `stay`.
 * `browserOnly`: the token cookies end when the browser quits (`stay: 'browser'`), so pass
 * `cookies: 'browser'` to `configureAuthClient` and `amplifyAdapterRefresh`.
 *
 * ```ts
 * const session = signInSession(site.signIn, 2); // { refreshTokenMinutes: 43200, browserOnly: false }
 * ```
 */
export function signInSession(input: SignInSettings | undefined, tier: AuthTier = 2, fullRefreshTokenMinutes?: number): { refreshTokenMinutes: number; browserOnly: boolean } {
  const signIn = normalizeSignIn(input, tier);
  if (signIn.stay !== null) return { refreshTokenMinutes: stayRefreshTokenMinutes(signIn.stay), browserOnly: signIn.stay === 'browser' };
  return { refreshTokenMinutes: fullRefreshTokenMinutes ?? SESSION_POLICY.refreshTokenMinutesMax[tier], browserOnly: false };
}

