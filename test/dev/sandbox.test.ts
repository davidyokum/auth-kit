import { DescribeUserPoolCommand } from '@aws-sdk/client-cognito-identity-provider';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  assertSandboxInspection,
  assertSandboxPool,
  cachedSandboxCheck,
  clearSandboxCheckCache,
  inspectUserPool,
  NotASandboxPoolError,
  type PoolInspection,
  sandboxProblems,
} from '../../src/dev/index.js';
import { POOL_ID } from '../helpers.js';
import { ACCOUNT, awsError, createFakeCognito, OTHER_ACCOUNT } from './fake-cognito.js';

const sandbox: PoolInspection = {
  userPoolId: POOL_ID,
  accountId: ACCOUNT,
  tags: { Environment: 'sandbox', 'amplify:deployment-type': 'sandbox' },
  deletionProtection: 'INACTIVE',
  estimatedUsers: 5,
};

beforeEach(() => {
  clearSandboxCheckCache();
});

describe('assertSandboxPool (tags only)', () => {
  it('passes only a pool tagged Environment=sandbox', () => {
    expect(() => assertSandboxPool('p', { Environment: 'sandbox' })).not.toThrow();
    expect(() => assertSandboxPool('p', { Environment: 'main' })).toThrow(NotASandboxPoolError);
    expect(() => assertSandboxPool('p', { Environment: 'branch-sandbox' })).toThrow(NotASandboxPoolError);
    expect(() => assertSandboxPool('p', {})).toThrow(NotASandboxPoolError);
    expect(() => assertSandboxPool('p', undefined)).toThrow(NotASandboxPoolError);
  });
});

describe('sandboxProblems: refusing anything that looks deployed', () => {
  it('passes a sandbox', () => {
    expect(sandboxProblems(sandbox, { expectedAccountId: ACCOUNT })).toEqual([]);
  });

  it.each([
    ['no Environment tag', { ...sandbox, tags: {} }, /isn't tagged Environment=sandbox \(Environment=missing\)/],
    ['a production tag', { ...sandbox, tags: { Environment: 'production' } }, /Environment=production/],
    ['a branch named sandbox', { ...sandbox, tags: { Environment: 'branch-sandbox' } }, /Environment=branch-sandbox/],
    ['an Amplify branch deployment', { ...sandbox, tags: { Environment: 'sandbox', 'amplify:deployment-type': 'branch' } }, /deployed it as a branch/],
    ['an Amplify branch name', { ...sandbox, tags: { Environment: 'sandbox', 'amplify:branch-name': 'main' } }, /branch "main"/],
    ['deletion protection', { ...sandbox, deletionProtection: 'ACTIVE' }, /deletion protection is on/],
    ['many users', { ...sandbox, estimatedUsers: 1200 }, /about 1200 users/],
  ])('refuses %s', (_label, inspection, message) => {
    expect(sandboxProblems(inspection).join('; ')).toMatch(message);
    expect(() => assertSandboxInspection(inspection)).toThrow(NotASandboxPoolError);
  });

  it('asserts the account from the ARN', () => {
    expect(sandboxProblems(sandbox, { expectedAccountId: OTHER_ACCOUNT })).toEqual([`it's in AWS account ${ACCOUNT}, not the expected ${OTHER_ACCOUNT}`]);
    const { accountId: _accountId, ...noAccount } = sandbox;
    expect(sandboxProblems(noAccount, { expectedAccountId: ACCOUNT })).toEqual(["its ARN doesn't name an account to check"]);
  });

  it('lists every problem at once', () => {
    const e = (() => {
      try {
        assertSandboxInspection({ ...sandbox, tags: { Environment: 'main', 'amplify:deployment-type': 'branch' }, deletionProtection: 'ACTIVE' });
      } catch (error) {
        return error as NotASandboxPoolError;
      }
      throw new Error('expected a refusal');
    })();
    expect(e.problems).toHaveLength(3);
    expect(e.message).toMatch(/npx ampx sandbox/);
  });
});

describe('inspectUserPool and the cached check', () => {
  it('reads tags, account, protection, users, and MFA from DescribeUserPool', async () => {
    const fake = createFakeCognito();
    expect(await inspectUserPool(fake.client, POOL_ID)).toEqual({
      userPoolId: POOL_ID,
      arn: `arn:aws:cognito-idp:us-east-1:${ACCOUNT}:userpool/${POOL_ID}`,
      accountId: ACCOUNT,
      tags: fake.options.tags,
      deletionProtection: 'INACTIVE',
      estimatedUsers: 0,
      mfaConfiguration: 'OPTIONAL',
    });
  });

  it('calls DescribeUserPool once per TTL, and rechecks a failure sooner', async () => {
    const fake = createFakeCognito();
    const check = cachedSandboxCheck({ getClient: () => fake.client, userPoolId: POOL_ID, now: fake.now, okTtlMs: 60_000 });
    expect((await Promise.all([check(), check(), check()])).every((r) => r.ok)).toBe(true);
    expect(fake.mock.commandCalls(DescribeUserPoolCommand)).toHaveLength(1);
    fake.clock.now += 61_000;
    await check();
    expect(fake.mock.commandCalls(DescribeUserPoolCommand)).toHaveLength(2);

    clearSandboxCheckCache();
    fake.options.tags = { Environment: 'main' };
    const failing = await check();
    expect(failing.ok).toBe(false);
    fake.options.tags = { Environment: 'sandbox' };
    fake.clock.now += 16_000;
    expect((await check()).ok).toBe(true);
  });

  it('turns an AWS error into a failed check, never a pass or a throw', async () => {
    const fake = createFakeCognito();
    fake.mock.on(DescribeUserPoolCommand).rejects(awsError('ExpiredTokenException', 'The security token included in the request is expired'));
    const result = await cachedSandboxCheck({ getClient: () => fake.client, userPoolId: POOL_ID })();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems[0]).toMatch(/couldn't read the pool's tags \(ExpiredTokenException/);
  });

  it('turns missing credentials into a failed check', async () => {
    const result = await cachedSandboxCheck({
      getClient: () => {
        throw new Error("auth-kit: won't guess which AWS account to use.");
      },
      userPoolId: POOL_ID,
    })();
    expect(result.ok).toBe(false);
  });
});
