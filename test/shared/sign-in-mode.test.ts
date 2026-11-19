import { describe, expect, it } from 'vitest';
import {
  FULL_SIGN_IN,
  SIGN_IN_MODE_LABEL,
  SignInConfigError,
  isSimple,
  maxStayDays,
  normalizeSignIn,
  signInSession,
  stayRefreshTokenMinutes,
  staysForBrowserOnly,
  stayWords,
} from '../../src/shared/sign-in-mode.js';

describe('sign-in modes (ADR 0029)', () => {
  it('names each mode the way setup, Studio, the README, and the sites log do', () => {
    expect(SIGN_IN_MODE_LABEL).toEqual({ full: 'Full: code, passkey, password', simple: 'Simple: code only' });
  });

  it('defaults to Full, and Simple to 30 days (capped at the tier’s ceiling)', () => {
    expect(normalizeSignIn(undefined)).toBe(FULL_SIGN_IN);
    expect(normalizeSignIn({ mode: 'full' })).toEqual({ mode: 'full', stay: null });
    expect(normalizeSignIn({ mode: 'simple' })).toEqual({ mode: 'simple', stay: 30 });
    expect(normalizeSignIn({ mode: 'simple' }, 3)).toEqual({ mode: 'simple', stay: 1 });
    expect(normalizeSignIn({ mode: 'simple', stay: 'browser' })).toEqual({ mode: 'simple', stay: 'browser' });
    expect(normalizeSignIn({ mode: 'simple', stay: 7 })).toEqual({ mode: 'simple', stay: 7 });
    expect(Object.isFrozen(normalizeSignIn({ mode: 'simple', stay: 7 }))).toBe(true);
  });

  it('refuses what it can’t use, saying what would work', () => {
    const cases: [unknown, number, RegExp][] = [
      [null, 2, /must be \{ mode: 'full' \} or \{ mode: 'simple', stay \}/],
      ['simple', 2, /must be/],
      [{ mode: 'code' }, 2, /mode must be 'full' or 'simple', not "code"/],
      [{ mode: 'full', stay: 30 }, 2, /stay is for Simple sign-in only/],
      [{ mode: 'simple', stay: 0 }, 2, /a whole number of days from 1 to 30, not 0/],
      [{ mode: 'simple', stay: 31 }, 2, /from 1 to 30, not 31/],
      [{ mode: 'simple', stay: 2.5 }, 2, /not 2.5/],
      [{ mode: 'simple', stay: '30' }, 2, /not "30"/],
      [{ mode: 'simple', stay: 7 }, 3, /'browser' or 1 \(Tier 3 sign-ins last at most a day\), not 7/],
    ];
    for (const [input, tier, message] of cases) {
      expect(() => normalizeSignIn(input as never, tier as 2 | 3)).toThrow(SignInConfigError);
      expect(() => normalizeSignIn(input as never, tier as 2 | 3)).toThrow(message);
    }
  });

  it('maps a stay to the refresh token, the cookies, and the words', () => {
    expect(maxStayDays(2)).toBe(30);
    expect(maxStayDays(3)).toBe(1);
    expect(stayRefreshTokenMinutes('browser')).toBe(720);
    expect(stayRefreshTokenMinutes(7)).toBe(7 * 1440);
    expect(staysForBrowserOnly(normalizeSignIn({ mode: 'simple', stay: 'browser' }))).toBe(true);
    expect(staysForBrowserOnly(normalizeSignIn({ mode: 'simple', stay: 1 }))).toBe(false);
    expect(staysForBrowserOnly(FULL_SIGN_IN)).toBe(false);
    expect(isSimple(normalizeSignIn({ mode: 'simple' }))).toBe(true);
    expect([stayWords('browser'), stayWords(1), stayWords(30)]).toEqual(['until you quit your browser', 'for 1 day', 'for 30 days']);
  });

  it('signInSession: the one lifetime the preset, the server, and the browser all use', () => {
    expect(signInSession(undefined)).toEqual({ refreshTokenMinutes: 43200, browserOnly: false });
    expect(signInSession(undefined, 3)).toEqual({ refreshTokenMinutes: 1440, browserOnly: false });
    expect(signInSession({ mode: 'full' }, 2, 1440)).toEqual({ refreshTokenMinutes: 1440, browserOnly: false });
    expect(signInSession({ mode: 'simple' })).toEqual({ refreshTokenMinutes: 43200, browserOnly: false });
    expect(signInSession({ mode: 'simple', stay: 7 })).toEqual({ refreshTokenMinutes: 10080, browserOnly: false });
    expect(signInSession({ mode: 'simple', stay: 'browser' })).toEqual({ refreshTokenMinutes: 720, browserOnly: true });
  });
});
