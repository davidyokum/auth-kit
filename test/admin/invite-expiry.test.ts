/**
 * The scheduled invite-expiry sweep's Lambda handler (src/admin/invite-expiry-handler.ts): its
 * environment, its one log line, and when a run counts as failed. Cognito is the fake pool; the audit
 * log is in memory. The deployed resources are checked in invite-expiry-cdk.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createInviteExpirySweep,
  createMemoryAuditLog,
  inviteExpirySweepPolicy,
  INVITE_EXPIRY_COGNITO_ACTIONS,
  type SweepResult,
  type SweepSkip,
} from '../../src/admin/index.js';
import { INVITE_EXPIRY_ENV, createInviteExpiryHandler, inviteExpiryConfig, redactAddresses } from '../../src/admin/invite-expiry-handler.js';
import { OWNER_GROUP } from '../../src/shared/policy.js';
import { DAY, NOW, fakeUserPool } from './people-fixture.js';

const ENV = {
  [INVITE_EXPIRY_ENV.userPoolId]: 'us-east-1_TestPool1',
  [INVITE_EXPIRY_ENV.auditTable]: 'site-data-AuditLogTable-EXAMPLE',
  [INVITE_EXPIRY_ENV.inviteMode]: 'emailed-code',
  [INVITE_EXPIRY_ENV.maxPeople]: '5000',
};

const WARNING_ENV = {
  [INVITE_EXPIRY_ENV.siteName]: 'Example Reports',
  [INVITE_EXPIRY_ENV.mailFrom]: 'Example Reports <noreply@example.org>',
  [INVITE_EXPIRY_ENV.signInUrl]: 'https://reports.example.org/sign-in',
  [INVITE_EXPIRY_ENV.ownerWarningFallback]: 'ops@example.org',
};

function seedInvites(pool: ReturnType<typeof fakeUserPool>) {
  pool.add({ sub: 'old', email: 'old@example.org', emailVerified: false, createdAt: new Date(NOW - 8 * DAY) }, 'admin-content');
  pool.add({ sub: 'new', email: 'new@example.org', emailVerified: false, createdAt: new Date(NOW - 2 * DAY) }, 'admin-view');
  pool.add({ sub: 'used', email: 'used@example.org', emailVerified: true, createdAt: new Date(NOW - 30 * DAY) }, 'admin-content-people');
}

const skip = (over: Partial<SweepSkip> = {}): SweepSkip => ({ sub: 'owner', reason: 'last-owner', warningDue: true, warned: ['owner'], problems: [], ...over });

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

  it('reads the run interval and the last-owner warning settings', () => {
    expect(inviteExpiryConfig({ ...ENV, ...WARNING_ENV, [INVITE_EXPIRY_ENV.runEveryMinutes]: '60', [INVITE_EXPIRY_ENV.mailConfigurationSet]: 'auth' })).toMatchObject({
      runEveryMinutes: 60,
      ownerWarnings: {
        siteName: 'Example Reports',
        from: 'Example Reports <noreply@example.org>',
        signInUrl: 'https://reports.example.org/sign-in',
        fallbackEmail: 'ops@example.org',
        configurationSet: 'auth',
      },
    });
    expect(inviteExpiryConfig(ENV)).not.toHaveProperty('ownerWarnings');
  });

  it('refuses half-configured warnings rather than send something odd', () => {
    expect(() =>
      inviteExpiryConfig({
        ...ENV,
        [INVITE_EXPIRY_ENV.mailFrom]: 'not a sender',
        [INVITE_EXPIRY_ENV.signInUrl]: 'http://reports.example.org/sign-in',
        [INVITE_EXPIRY_ENV.ownerWarningFallback]: 'ops',
        [INVITE_EXPIRY_ENV.runEveryMinutes]: '0',
      }),
    ).toThrow(/AUTH_KIT_RUN_EVERY_MINUTES.*AUTH_KIT_SITE_NAME is required.*AUTH_KIT_MAIL_FROM.*AUTH_KIT_SIGN_IN_URL.*AUTH_KIT_OWNER_WARNING_FALLBACK/);
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
    const { handler, lines, createSweep } = handlerWith({ disabled: ['old'], failed: [], skipped: [], checked: 3, truncated: false });
    expect(await handler()).toEqual({ event: 'auth-kit.invite-expiry', disabled: ['old'], failed: [], skipped: [], checked: 3, truncated: false });
    await handler();
    expect(createSweep).toHaveBeenCalledTimes(1);
    expect(createSweep.mock.calls[0]).toEqual([expect.objectContaining({ userPoolId: 'us-east-1_TestPool1', inviteMode: 'emailed-code', maxPeople: 5000 })]);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: 'auth-kit.invite-expiry', checked: 3, disabled: ['old'] });
    expect(lines[0]).not.toMatch(/@/);
  });

  it('fails (after logging) when a due invite couldn’t be disabled', async () => {
    const { handler, lines } = handlerWith({ disabled: [], failed: [{ sub: 'old', error: 'Cognito is busy' }], skipped: [], checked: 3, truncated: false });
    await expect(handler()).rejects.toThrow(/1 due invite\(s\) couldn't be disabled/);
    expect(JSON.parse(lines[0]!)).toMatchObject({ failed: [{ sub: 'old' }] });
  });

  it('fails when the pool outgrew maxPeople, because the rest went unchecked', async () => {
    const { handler } = handlerWith({ disabled: [], failed: [], skipped: [], checked: 5000, truncated: true });
    await expect(handler()).rejects.toThrow(/more than 5000 accounts.*raise maxPeople/);
  });

  it('a last owner skipped and warned is not a failure', async () => {
    const { handler, lines } = handlerWith({ disabled: [], failed: [], skipped: [skip()], checked: 3, truncated: false });
    expect(await handler()).toMatchObject({ skipped: [{ sub: 'owner', reason: 'last-owner', warned: ['owner'] }] });
    expect(JSON.parse(lines[0]!)).toMatchObject({ skipped: [{ sub: 'owner', reason: 'last-owner' }] });
  });

  it('between daily warnings, a skip alone is not a failure either', async () => {
    const { handler } = handlerWith({ disabled: [], failed: [], skipped: [skip({ warningDue: false, warned: [] })], checked: 3, truncated: false });
    await expect(handler()).resolves.toMatchObject({ skipped: [{ warningDue: false }] });
  });

  it('fails when the last owner was skipped but nobody could be warned, and never logs the address an error quotes', async () => {
    const ses = "Couldn't warn the owner: Email address is not verified. The following identities failed the check in region US-EAST-1: owner@example.org";
    const { handler, lines } = handlerWith({ disabled: [], failed: [], skipped: [skip({ warned: [], problems: [ses] })], checked: 3, truncated: false });
    const error = await handler().catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/last owner's invite was left open \(never disabled\), but: Couldn't warn the owner/);
    expect((error as Error).message).not.toMatch(/@/);
    expect(lines[0]).not.toMatch(/@/);
    expect(JSON.parse(lines[0]!).skipped[0].problems[0]).toContain('[address]');
    expect(redactAddresses('to "Olivia" <olivia@example.org>, ops@example.org.')).toBe('to "Olivia" <[address]>, [address]');
  });

  it('builds the sweep with the run interval and an SES warning notifier from the environment', async () => {
    const createSweep = vi.fn(() => () => Promise.resolve({ disabled: [], failed: [], skipped: [], checked: 0, truncated: false } as SweepResult));
    const handler = createInviteExpiryHandler({ env: { ...ENV, ...WARNING_ENV, [INVITE_EXPIRY_ENV.runEveryMinutes]: '60' }, createSweep, log: () => {} });
    await handler();
    const options = (createSweep.mock.calls[0] as unknown as [{ runEveryMinutes?: number; ownerWarnings?: Record<string, unknown> }])[0];
    expect(options.runEveryMinutes).toBe(60);
    expect(options.ownerWarnings).toMatchObject({
      siteName: 'Example Reports',
      signInUrl: 'https://reports.example.org/sign-in',
      fallbackEmail: 'ops@example.org',
      notifier: { ownerInviteUnused: expect.any(Function) },
    });
  });

  it('end to end: disables the expired invite as system:invite-expiry, intent then result', async () => {
    const timeline: string[] = [];
    const pool = fakeUserPool({ timeline });
    seedInvites(pool);
    // An expired owner invite beside an owner who signed in: disabled, which needs the owner count.
    pool.add({ sub: 'owner-new', email: 'owner-new@example.org', emailVerified: false, createdAt: new Date(NOW - 9 * DAY) }, OWNER_GROUP);
    pool.add({ sub: 'owner-used', email: 'owner-used@example.org', emailVerified: true, createdAt: new Date(NOW - 90 * DAY) }, OWNER_GROUP);
    const log = createMemoryAuditLog({ now: () => NOW });
    const handler = createInviteExpiryHandler({
      env: ENV,
      // The handler's own options, with the fake pool and the memory log swapped in.
      createSweep: (options) => createInviteExpirySweep({ ...options, auditLog: log, cognito: pool.client, now: () => NOW, sleep: () => Promise.resolve() }),
      log: () => {},
    });
    expect(await handler()).toMatchObject({ disabled: ['old', 'owner-new'], failed: [], skipped: [], checked: 5 });
    expect(pool.get('old')).toMatchObject({ enabled: false });
    expect([...pool.get('old')!.groups]).toEqual([]);
    expect(pool.get('owner-new')).toMatchObject({ enabled: false });
    expect([...pool.get('owner-new')!.groups]).toEqual([]);
    expect(pool.get('new')!.enabled).toBe(true);
    expect(pool.get('used')!.enabled).toBe(true);
    expect(pool.get('owner-used')!.enabled).toBe(true);
    expect(log.rows.map((r) => [r.phase, r.action, r.actor.sub, r.actor.kind])).toEqual([
      ['intent', 'people.expireInvite', 'system:invite-expiry', 'system'],
      ['result', 'people.expireInvite', 'system:invite-expiry', 'system'],
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
  it('allows the five Cognito calls on one pool and PutItem on the audit table, nothing else', () => {
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
      'cognito-idp:ListUsersInGroup',
      'cognito-idp:AdminDisableUser',
      'cognito-idp:AdminRemoveUserFromGroup',
    ]);
  });

  it('adds ses:SendEmail on the given identity for the last-owner warning', () => {
    const policy = inviteExpirySweepPolicy({
      userPoolArn: 'arn:aws:cognito-idp:us-east-1:111:userpool/us-east-1_TestPool1',
      auditTableArn: 'arn:aws:dynamodb:us-east-1:111:table/audit',
      sesResourceArns: ['arn:aws:ses:us-east-1:111:identity/example.org'],
    });
    expect(policy.Statement.at(-1)).toEqual({
      Sid: 'InviteExpiryOwnerWarning',
      Effect: 'Allow',
      Action: ['ses:SendEmail'],
      Resource: ['arn:aws:ses:us-east-1:111:identity/example.org'],
    });
  });
});
