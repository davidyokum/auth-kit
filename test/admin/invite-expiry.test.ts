/**
 * The scheduled invite-expiry sweep's Lambda handler (src/admin/invite-expiry-handler.ts): its
 * environment, its one log line, and when a run counts as failed. Cognito is the fake pool; the audit
 * log is in memory. The deployed resources are checked in invite-expiry-cdk.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { createInviteExpirySweep, createMemoryAuditLog, inviteExpirySweepPolicy, INVITE_EXPIRY_COGNITO_ACTIONS, type SweepResult } from '../../src/admin/index.js';
import { INVITE_EXPIRY_ENV, createInviteExpiryHandler, inviteExpiryConfig } from '../../src/admin/invite-expiry-handler.js';
import { DAY, NOW, fakeUserPool } from './people-fixture.js';

const ENV = {
  [INVITE_EXPIRY_ENV.userPoolId]: 'us-east-1_TestPool1',
  [INVITE_EXPIRY_ENV.auditTable]: 'site-data-AuditLogTable-EXAMPLE',
  [INVITE_EXPIRY_ENV.inviteMode]: 'emailed-code',
  [INVITE_EXPIRY_ENV.maxPeople]: '5000',
};

function seedInvites(pool: ReturnType<typeof fakeUserPool>) {
  pool.add({ sub: 'old', email: 'old@example.org', emailVerified: false, createdAt: new Date(NOW - 8 * DAY) }, 'editor');
  pool.add({ sub: 'new', email: 'new@example.org', emailVerified: false, createdAt: new Date(NOW - 2 * DAY) }, 'viewer');
  pool.add({ sub: 'used', email: 'used@example.org', emailVerified: true, createdAt: new Date(NOW - 30 * DAY) }, 'admin');
}

describe('the environment', () => {
  it('reads the pool, table, invite mode, and limit the construct sets', () => {
    expect(inviteExpiryConfig(ENV)).toEqual({ userPoolId: 'us-east-1_TestPool1', auditTable: 'site-data-AuditLogTable-EXAMPLE', inviteMode: 'emailed-code', maxPeople: 5000 });
    expect(inviteExpiryConfig({ ...ENV, [INVITE_EXPIRY_ENV.inviteMode]: undefined, [INVITE_EXPIRY_ENV.maxPeople]: undefined })).toEqual({
      userPoolId: 'us-east-1_TestPool1',
      auditTable: 'site-data-AuditLogTable-EXAMPLE',
      inviteMode: 'emailed-code',
    });
  });

  it('names every problem at once instead of guessing', () => {
    expect(() =>
      inviteExpiryConfig({
        [INVITE_EXPIRY_ENV.userPoolId]: 'not-a-pool',
        [INVITE_EXPIRY_ENV.inviteMode]: 'magic-link',
        [INVITE_EXPIRY_ENV.maxPeople]: '0',
      }),
    ).toThrow(/AUTH_KIT_USER_POOL_ID.*AUTH_KIT_AUDIT_TABLE.*AUTH_KIT_INVITE_MODE.*AUTH_KIT_MAX_PEOPLE/);
  });

  it('a bad environment fails the invocation (so the alarm sees it), not the import', async () => {
    const handler = createInviteExpiryHandler({ env: {}, log: () => {} });
    await expect(handler()).rejects.toThrow(/AUTH_KIT_USER_POOL_ID/);
  });
});

describe('a run', () => {
  function handlerWith(result: SweepResult) {
    const lines: string[] = [];
    const createSweep = vi.fn(() => () => Promise.resolve(result));
    return { handler: createInviteExpiryHandler({ env: ENV, createSweep, log: (l) => lines.push(l) }), lines, createSweep };
  }

  it('logs one JSON line of counts and subs, never addresses, and builds the sweep once', async () => {
    const { handler, lines, createSweep } = handlerWith({ disabled: ['old'], failed: [], checked: 3, truncated: false });
    expect(await handler()).toEqual({ event: 'auth-kit.invite-expiry', disabled: ['old'], failed: [], checked: 3, truncated: false });
    await handler();
    expect(createSweep).toHaveBeenCalledTimes(1);
    expect(createSweep.mock.calls[0]).toEqual([expect.objectContaining({ userPoolId: 'us-east-1_TestPool1', inviteMode: 'emailed-code', maxPeople: 5000 })]);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: 'auth-kit.invite-expiry', checked: 3, disabled: ['old'] });
    expect(lines[0]).not.toMatch(/@/);
  });

  it('fails (after logging) when a due invite couldn’t be disabled', async () => {
    const { handler, lines } = handlerWith({ disabled: [], failed: [{ sub: 'old', error: 'Cognito is busy' }], checked: 3, truncated: false });
    await expect(handler()).rejects.toThrow(/1 due invite\(s\) couldn't be disabled/);
    expect(JSON.parse(lines[0]!)).toMatchObject({ failed: [{ sub: 'old' }] });
  });

  it('fails when the pool outgrew maxPeople, because the rest went unchecked', async () => {
    const { handler } = handlerWith({ disabled: [], failed: [], checked: 5000, truncated: true });
    await expect(handler()).rejects.toThrow(/more than 5000 accounts.*raise maxPeople/);
  });

  it('end to end: disables the expired invite as system:invite-expiry, intent then result', async () => {
    const timeline: string[] = [];
    const pool = fakeUserPool({ timeline });
    seedInvites(pool);
    const log = createMemoryAuditLog({ now: () => NOW });
    const handler = createInviteExpiryHandler({
      env: ENV,
      // The handler's own options, with the fake pool and the memory log swapped in.
      createSweep: (options) => createInviteExpirySweep({ ...options, auditLog: log, cognito: pool.client, now: () => NOW, sleep: () => Promise.resolve() }),
      log: () => {},
    });
    expect(await handler()).toMatchObject({ disabled: ['old'], failed: [], checked: 3 });
    expect(pool.get('old')).toMatchObject({ enabled: false });
    expect([...pool.get('old')!.groups]).toEqual([]);
    expect(pool.get('new')!.enabled).toBe(true);
    expect(pool.get('used')!.enabled).toBe(true);
    expect(log.rows.map((r) => [r.phase, r.action, r.actor.sub, r.actor.kind])).toEqual([
      ['intent', 'people.expireInvite', 'system:invite-expiry', 'system'],
      ['result', 'people.expireInvite', 'system:invite-expiry', 'system'],
    ]);
    expect(log.rows[1]).toMatchObject({ outcome: 'ok', reason: 'Invite unused for 7 days' });
    // The calls it made are exactly the ones its role allows (inviteExpirySweepPolicy, the construct).
    const calls = new Set(timeline.filter((t) => t.startsWith('cognito:')).map((t) => `cognito-idp:${t.slice('cognito:'.length).split(' ')[0]}`));
    expect([...calls].sort()).toEqual([...INVITE_EXPIRY_COGNITO_ACTIONS].sort());
  });
});

describe('inviteExpirySweepPolicy (plain JSON, for roles defined outside CDK)', () => {
  it('allows the four Cognito calls on one pool and PutItem on the audit table, nothing else', () => {
    const policy = inviteExpirySweepPolicy({
      userPoolArn: 'arn:aws:cognito-idp:us-east-1:111:userpool/us-east-1_TestPool1',
      auditTableArn: 'arn:aws:dynamodb:us-east-1:111:table/audit',
    });
    expect(policy.Statement).toEqual([
      { Sid: 'InviteExpiryCognito', Effect: 'Allow', Action: [...INVITE_EXPIRY_COGNITO_ACTIONS], Resource: 'arn:aws:cognito-idp:us-east-1:111:userpool/us-east-1_TestPool1' },
      { Sid: 'InviteExpiryAudit', Effect: 'Allow', Action: ['dynamodb:PutItem'], Resource: 'arn:aws:dynamodb:us-east-1:111:table/audit' },
    ]);
    expect(INVITE_EXPIRY_COGNITO_ACTIONS).toEqual([
      'cognito-idp:ListUsers',
      'cognito-idp:AdminListGroupsForUser',
      'cognito-idp:AdminDisableUser',
      'cognito-idp:AdminRemoveUserFromGroup',
    ]);
  });
});
