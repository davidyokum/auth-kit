import { type CognitoQuotaCategory, DEFAULT_QUOTA_BUDGET } from './policy.js';

export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function errorName(error: unknown): string {
  return typeof error === 'object' && error !== null && 'name' in error ? String((error).name) : '';
}

function httpStatus(error: unknown): number | undefined {
  const meta = typeof error === 'object' && error !== null ? (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata : undefined;
  return typeof meta?.httpStatusCode === 'number' ? meta.httpStatusCode : undefined;
}

const THROTTLING = new Set([
  'TooManyRequestsException',
  'ThrottlingException',
  'Throttling',
  'ThrottledException',
  'RequestLimitExceeded',
  'ProvisionedThroughputExceededException',
  'TooManyRequests',
]);

/** A throttling error: the request was turned away before it ran, so retrying is always safe. */
export function isThrottlingError(error: unknown): boolean {
  if (THROTTLING.has(errorName(error))) return true;
  if (httpStatus(error) === 429) return true;
  const retryable = typeof error === 'object' && error !== null ? (error as { $retryable?: { throttling?: unknown } }).$retryable : undefined;
  return retryable?.throttling === true;
}

const TRANSIENT = new Set(['InternalErrorException', 'InternalServerError', 'ServiceUnavailable', 'TimeoutError', 'RequestTimeout', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE']);

/**
 * A transient failure: the request may or may not have run. Only reads retry these; a write that
 * timed out might have happened, and retrying it could report a false failure.
 */
export function isTransientError(error: unknown): boolean {
  if (TRANSIENT.has(errorName(error))) return true;
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  if (typeof code === 'string' && TRANSIENT.has(code)) return true;
  const status = httpStatus(error);
  return status !== undefined && status >= 500;
}

export interface BackoffOptions {
  /** Total attempts, including the first. Default 5. */
  maxAttempts?: number;
  /** Default 100 ms. */
  baseDelayMs?: number;
  /** Default 5000 ms. */
  maxDelayMs?: number;
  /** Which errors to retry. Default: throttling only. */
  retryable?: (error: unknown) => boolean;
  sleep?: Sleep;
  /** [0, 1). Default Math.random. */
  random?: () => number;
}

/**
 * Retries `fn` with exponential backoff and full jitter (delay = random × min(max, base × 2^n)),
 * the pattern AWS recommends for throttled APIs. Rethrows the last error.
 */
export async function withBackoff<T>(fn: (attempt: number) => Promise<T>, options: BackoffOptions = {}): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 5);
  const base = options.baseDelayMs ?? 100;
  const cap = options.maxDelayMs ?? 5000;
  const retryable = options.retryable ?? isThrottlingError;
  const sleep = options.sleep ?? realSleep;
  const random = options.random ?? Math.random;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= maxAttempts || !retryable(error)) throw error;
      await sleep(Math.floor(random() * Math.min(cap, base * 2 ** (attempt - 1))));
    }
  }
}

/**
 * A token bucket: at most `ratePerSecond` requests a second on average, bursts up to `burst`.
 * Waiters are served in order.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number = Math.max(1, ratePerSecond),
    private readonly now: () => number = Date.now,
    private readonly sleep: Sleep = realSleep,
  ) {
    if (!(ratePerSecond > 0)) throw new Error('auth-kit: a token bucket needs a positive rate.');
    this.tokens = this.burst;
    this.last = now();
  }

  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.ratePerSecond);
    this.last = t;
  }

  /** Resolves when a request may go. */
  acquire(): Promise<void> {
    const take = async (): Promise<void> => {
      for (;;) {
        this.refill();
        if (this.tokens >= 1) {
          this.tokens -= 1;
          return;
        }
        await this.sleep(Math.max(1, Math.ceil(((1 - this.tokens) / this.ratePerSecond) * 1000)));
      }
    };
    const turn = this.tail.then(take);
    this.tail = turn.catch(() => undefined);
    return turn;
  }
}

export interface QuotaLimiterOptions {
  /** Requests per second per category for this server instance. Default `DEFAULT_QUOTA_BUDGET`. */
  budget?: Partial<Record<CognitoQuotaCategory, number>>;
  now?: () => number;
  sleep?: Sleep;
  random?: () => number;
  /** Attempts per call when throttled. Default 5. */
  maxAttempts?: number;
}

/** Spends each Cognito call against its quota category, and backs off when Cognito says slow down. */
export interface QuotaLimiter {
  /**
   * Runs `fn` once a token for `category` is free. Throttling errors are always retried; `read: true`
   * also retries transient failures (a read can't double-apply).
   */
  run<T>(category: CognitoQuotaCategory, fn: () => Promise<T>, options?: { read?: boolean }): Promise<T>;
}

export function createQuotaLimiter(options: QuotaLimiterOptions = {}): QuotaLimiter {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? realSleep;
  const buckets = new Map<CognitoQuotaCategory, TokenBucket>();
  const bucket = (category: CognitoQuotaCategory): TokenBucket => {
    let b = buckets.get(category);
    if (!b) {
      b = new TokenBucket(options.budget?.[category] ?? DEFAULT_QUOTA_BUDGET[category], undefined, now, sleep);
      buckets.set(category, b);
    }
    return b;
  };
  return {
    run(category, fn, runOptions = {}) {
      return withBackoff(
        async () => {
          await bucket(category).acquire();
          return fn();
        },
        {
          sleep,
          ...(options.random !== undefined && { random: options.random }),
          ...(options.maxAttempts !== undefined && { maxAttempts: options.maxAttempts }),
          retryable: runOptions.read === true ? (e) => isThrottlingError(e) || isTransientError(e) : isThrottlingError,
        },
      );
    },
  };
}
