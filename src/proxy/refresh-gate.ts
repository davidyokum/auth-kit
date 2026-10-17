import { TtlCache } from '../server/cache.js';

/**
 * Limits on the proxy's server-side refreshes.
 *
 * Every refresh is a public Cognito call (`GetTokensFromRefreshToken`, or `InitiateAuth` with
 * `REFRESH_TOKEN_AUTH` in older clients) from the server's own IP address, so it counts toward the
 * pool's WAF per-IP rules (ADR 0004). Unlimited refreshes would let anyone holding one old token make
 * the server spend that budget until WAF blocks the server itself. Limits are per server instance
 * (in memory); WAF's own rules remain the backstop across instances.
 */
export interface RefreshLimits {
  /** Refresh attempts per person (the expired token's `sub`) per window. Default 5. */
  perUser?: number;
  /** Refresh attempts this server instance makes per window, across everyone. Default 300. */
  perInstance?: number;
  /** Window length in seconds. Default 300 (WAF's evaluation window). */
  windowSeconds?: number;
  /** After a failed refresh, that person isn't retried for this long; it doubles per failure in a row. Default 30. */
  failureBackoffSeconds?: number;
  /** The longest pause after repeated failures. Default 900. */
  maxBackoffSeconds?: number;
  /** Milliseconds since the epoch (tests). */
  now?: () => number;
}

export const DEFAULT_REFRESH_LIMITS = Object.freeze({
  perUser: 5,
  perInstance: 300,
  windowSeconds: 300,
  failureBackoffSeconds: 30,
  maxBackoffSeconds: 900,
});

/** What happened to one refresh request. */
export type RefreshOutcome = 'refreshed' | 'failed' | 'joined' | 'throttled' | 'backing-off';

export interface RefreshGate<T> {
  /**
   * Runs `attempt` unless a limit says no. Concurrent calls for the same session (`sessionKey`) share
   * one attempt, so a page's parallel requests cost one Cognito call.
   */
  run(subject: string, sessionKey: string, attempt: () => Promise<T | null>): Promise<{ result: T | null; outcome: RefreshOutcome }>;
}

/** Validates limits and fails loudly at startup on a bad value. */
export function resolveRefreshLimits(limits: RefreshLimits = {}): Required<Omit<RefreshLimits, 'now'>> {
  const resolved: Record<keyof typeof DEFAULT_REFRESH_LIMITS, number> = { ...DEFAULT_REFRESH_LIMITS };
  for (const key of Object.keys(limits)) {
    if (key === 'now') continue;
    if (!(key in DEFAULT_REFRESH_LIMITS)) throw new Error(`auth-kit: unknown refreshLimits option "${key}".`);
    const value = limits[key as keyof typeof DEFAULT_REFRESH_LIMITS];
    if (value === undefined) continue;
    if (!(typeof value === 'number' && Number.isInteger(value) && value > 0)) {
      throw new Error(`auth-kit: refreshLimits.${key} must be a positive whole number.`);
    }
    resolved[key as keyof typeof DEFAULT_REFRESH_LIMITS] = value;
  }
  if (resolved.maxBackoffSeconds < resolved.failureBackoffSeconds) {
    throw new Error('auth-kit: refreshLimits.maxBackoffSeconds must be at least failureBackoffSeconds.');
  }
  return resolved;
}

export function createRefreshGate<T>(limits: RefreshLimits = {}): RefreshGate<T> {
  const cfg = resolveRefreshLimits(limits);
  const now = limits.now ?? Date.now;
  const windowMs = cfg.windowSeconds * 1000;
  const perUser = new TtlCache<string, { count: number }>(10_000, now);
  const failures = new TtlCache<string, { streak: number; until: number }>(10_000, now);
  const inFlight = new Map<string, Promise<T | null>>();
  let instance = { start: -Infinity, count: 0 };

  function recordFailure(subject: string): void {
    const streak = (failures.get(subject)?.streak ?? 0) + 1;
    const pauseMs = Math.min(cfg.failureBackoffSeconds * 2 ** (streak - 1), cfg.maxBackoffSeconds) * 1000;
    // Remember the streak for a while after the pause, so the next failure pauses longer.
    failures.set(subject, { streak, until: now() + pauseMs }, pauseMs + windowMs);
  }

  return {
    async run(subject, sessionKey, attempt) {
      const pending = inFlight.get(sessionKey);
      if (pending) return { result: await pending, outcome: 'joined' };

      const failure = failures.get(subject);
      if (failure && failure.until > now()) return { result: null, outcome: 'backing-off' };

      let window = perUser.get(subject);
      if (!window) {
        window = { count: 0 };
        perUser.set(subject, window, windowMs);
      }
      if (now() - instance.start >= windowMs) instance = { start: now(), count: 0 };
      if (window.count >= cfg.perUser || instance.count >= cfg.perInstance) return { result: null, outcome: 'throttled' };
      window.count += 1;
      instance.count += 1;

      // A null result is a failed refresh (backs off); a thrown error is "couldn't check" (503) and
      // propagates without counting against the person.
      const promise = (async () => {
        const result = await attempt();
        if (result === null) recordFailure(subject);
        else failures.delete(subject);
        return result;
      })();
      inFlight.set(sessionKey, promise);
      try {
        const result = await promise;
        return { result, outcome: result === null ? 'failed' : 'refreshed' };
      } finally {
        inFlight.delete(sessionKey);
      }
    },
  };
}
