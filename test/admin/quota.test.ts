import { describe, expect, it } from 'vitest';
import {
  COGNITO_RATE_QUOTAS,
  createQuotaLimiter,
  DEFAULT_QUOTA_BUDGET,
  isThrottlingError,
  isTransientError,
  TokenBucket,
  withBackoff,
} from '../../src/admin/index.js';

/** A clock that only moves when something sleeps, so tests are instant and exact. */
function fakeTime() {
  const t = { now: 0, sleeps: [] as number[] };
  return {
    t,
    now: () => t.now,
    sleep: (ms: number) => {
      t.sleeps.push(ms);
      t.now += ms;
      return Promise.resolve();
    },
  };
}

const throttled = () => Object.assign(new Error('Rate exceeded'), { name: 'TooManyRequestsException', $metadata: { httpStatusCode: 400 } });

describe('error classes', () => {
  it('recognizes throttling by name, status 429, or the SDK flag', () => {
    expect(isThrottlingError(throttled())).toBe(true);
    expect(isThrottlingError(Object.assign(new Error('x'), { name: 'ThrottlingException' }))).toBe(true);
    expect(isThrottlingError({ $metadata: { httpStatusCode: 429 } })).toBe(true);
    expect(isThrottlingError({ $retryable: { throttling: true } })).toBe(true);
    expect(isThrottlingError(Object.assign(new Error('x'), { name: 'LimitExceededException' }))).toBe(false);
    expect(isThrottlingError(Object.assign(new Error('x'), { name: 'UserNotFoundException' }))).toBe(false);
  });

  it('treats 5xx and timeouts as transient', () => {
    expect(isTransientError({ name: 'InternalErrorException' })).toBe(true);
    expect(isTransientError({ $metadata: { httpStatusCode: 503 } })).toBe(true);
    expect(isTransientError({ code: 'ECONNRESET' })).toBe(true);
    expect(isTransientError(throttled())).toBe(false);
  });
});

describe('withBackoff', () => {
  it('retries throttling with capped exponential delays and full jitter', async () => {
    const time = fakeTime();
    let calls = 0;
    const out = await withBackoff(
      () => {
        calls++;
        return calls < 4 ? Promise.reject(throttled()) : Promise.resolve('ok');
      },
      { sleep: time.sleep, random: () => 0.5, baseDelayMs: 100, maxDelayMs: 300 },
    );
    expect(out).toBe('ok');
    expect(calls).toBe(4);
    expect(time.t.sleeps).toEqual([50, 100, 150]); // 0.5 × min(300, 100, 200, 400)
  });

  it('gives up after maxAttempts and rethrows the last error', async () => {
    const time = fakeTime();
    let calls = 0;
    await expect(
      withBackoff(
        () => {
          calls++;
          return Promise.reject(throttled());
        },
        { sleep: time.sleep, maxAttempts: 3 },
      ),
    ).rejects.toMatchObject({ name: 'TooManyRequestsException' });
    expect(calls).toBe(3);
  });

  it('never retries an error that may have run (a write that timed out) by default', async () => {
    let calls = 0;
    await expect(
      withBackoff(() => {
        calls++;
        return Promise.reject(Object.assign(new Error('boom'), { name: 'InternalErrorException' }));
      }),
    ).rejects.toThrow('boom');
    expect(calls).toBe(1);
  });
});

describe('TokenBucket', () => {
  it('allows a burst, then spaces requests at the rate', async () => {
    const time = fakeTime();
    const bucket = new TokenBucket(10, 2, time.now, time.sleep);
    const stamps: number[] = [];
    for (let i = 0; i < 5; i++) {
      await bucket.acquire();
      stamps.push(time.t.now);
    }
    expect(stamps).toEqual([0, 0, 100, 200, 300]);
  });

  it('serves concurrent waiters in order', async () => {
    const time = fakeTime();
    const bucket = new TokenBucket(5, 1, time.now, time.sleep);
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((n) => bucket.acquire().then(() => order.push(n))));
    expect(order).toEqual([1, 2, 3]);
    expect(time.t.now).toBe(400);
  });

  it('refuses a non-positive rate', () => {
    expect(() => new TokenBucket(0)).toThrow(/positive rate/);
  });
});

describe('createQuotaLimiter', () => {
  it('defaults to a fraction of each shared Cognito quota', () => {
    for (const [category, quota] of Object.entries(COGNITO_RATE_QUOTAS)) {
      expect(DEFAULT_QUOTA_BUDGET[category as keyof typeof COGNITO_RATE_QUOTAS]).toBeLessThan(quota);
    }
    expect(COGNITO_RATE_QUOTAS.UserList).toBe(30);
    expect(COGNITO_RATE_QUOTAS.UserUpdate).toBe(25);
  });

  it('paces each category separately and backs off on throttling', async () => {
    const time = fakeTime();
    const limiter = createQuotaLimiter({ budget: { UserList: 2, UserUpdate: 1 }, now: time.now, sleep: time.sleep, random: () => 0 });
    let throttles = 1;
    const results = await Promise.all([
      limiter.run('UserList', () => Promise.resolve('a')),
      limiter.run('UserList', () => Promise.resolve('b')),
      limiter.run('UserUpdate', () => (throttles-- > 0 ? Promise.reject(throttled()) : Promise.resolve('c'))),
    ]);
    expect(results).toEqual(['a', 'b', 'c']);
  });

  it('retries transient failures only for reads', async () => {
    const time = fakeTime();
    const limiter = createQuotaLimiter({ now: time.now, sleep: time.sleep, random: () => 0 });
    const flaky = () => {
      let n = 0;
      return () => (n++ === 0 ? Promise.reject(Object.assign(new Error('x'), { name: 'InternalErrorException' })) : Promise.resolve('ok'));
    };
    await expect(limiter.run('UserList', flaky(), { read: true })).resolves.toBe('ok');
    await expect(limiter.run('UserUpdate', flaky())).rejects.toMatchObject({ name: 'InternalErrorException' });
  });
});
