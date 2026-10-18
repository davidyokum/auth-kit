/**
 * The invite-expiry sweep never disables a site's last owner (ADR 0019): it skips them, logs the skip
 * as a refusal ("skipped: last owner"), and warns the owner and an optional fallback address. An
 * owner count it can't read is a skip too (fail closed), reported as a failure. Cognito is the fake
 * pool; the audit log is in memory; the notifier records what it was asked to send.
 */
import { AdminDisableUserCommand, AdminRemoveUserFromGroupCommand } from '@aws-sdk/client-cognito-identity-provider';
import { describe, expect, it } from 'vitest';
import {
  createInviteExpirySweep,
  createMemoryAuditLog,
  describeActivity,
  type InviteExpirySweepOptions,
  type OwnerInviteWarning,
  type OwnerInviteWarningNotifier,
} from '../../src/admin/index.js';
import { lastOwnerWarningDue } from '../../src/admin/sweep.js';
import { awsError, DAY, fakeUserPool, NOW } from './people-fixture.js';

const MINUTE = 60 * 1000;
const SITE = { siteName: 'Example Reports', signInUrl: 'https://reports.example.org/sign-in' };

function recordingNotifier() {
  const sent: OwnerInviteWarning[] = [];
  const failures: Partial<Record<'owner' | 'fallback', Error>> = {};
  const notifier: OwnerInviteWarningNotifier = {
    ownerInviteUnused(warning) {
      const failure = failures[warning.to.kind];
      if (failure) return Promise.reject(failure);
      sent.push(warning);
      return Promise.resolve();
    },
  };
  return { sent, failures, notifier };
}

function world(options: { fallbackEmail?: string; warnings?: boolean; runEveryMinutes?: number } = {}) {
  const pool = fakeUserPool();
  const clock = { t: NOW };
  const log = createMemoryAuditLog({ now: () => clock.t });
  const mail = recordingNotifier();
  const sweepOptions: InviteExpirySweepOptions = {
    userPoolId: 'us-east-1_TestPool1',
    auditLog: log,
    cognito: pool.client,
    now: () => clock.t,
    sleep: () => Promise.resolve(),
    // Many runs in a row would otherwise spin on the real-time quota buckets (sleep is stubbed).
    quota: { budget: { UserList: 10_000, UserResourceRead: 10_000, UserUpdate: 10_000 } },
    ...(options.warnings !== false && {
      ownerWarnings: { notifier: mail.notifier, ...SITE, ...(options.fallbackEmail !== undefined && { fallbackEmail: options.fallbackEmail }) },
    }),
    ...(options.runEveryMinutes !== undefined && { runEveryMinutes: options.runEveryMinutes }),
  };
  const sweep = createInviteExpirySweep(sweepOptions);
  const disabledUsernames = () => pool.inputsOf(AdminDisableUserCommand).map((i) => i.Username);
  return { pool, clock, log, mail, sweep, disabledUsernames };
}

/** An owner who never signed in, invited `days` ago. */
const unusedOwner = (sub: string, days = 8) => ({ sub, email: `${sub}@example.org`, emailVerified: false, createdAt: new Date(NOW - days * DAY) });
/** An owner who has signed in. */
const activeOwner = (sub: string) => ({ sub, email: `${sub}@example.org`, emailVerified: true, createdAt: new Date(NOW - 90 * DAY) });

describe('the sole owner, who never signed in', () => {
  it('is not disabled and keeps the owner role; the skip is logged and the owner and fallback are warned', async () => {
    const w = world({ fallbackEmail: 'ops@example.org' });
    w.pool.add({ ...unusedOwner('owner'), name: 'Olivia' }, 'superadmin');
    w.pool.add({ sub: 'old', email: 'old@example.org', emailVerified: false, createdAt: new Date(NOW - 8 * DAY) }, 'editor');

    const result = await w.sweep();

    // Non-owner invites keep expiring in the same run.
    expect(result).toMatchObject({ disabled: ['old'], failed: [], checked: 2 });
    expect(result.skipped).toEqual([{ sub: 'owner', reason: 'last-owner', warningDue: true, warned: ['owner', 'fallback'], problems: [] }]);
    expect(w.pool.get('owner')).toMatchObject({ enabled: true });
    expect([...w.pool.get('owner')!.groups]).toEqual(['superadmin']);
    expect(w.disabledUsernames()).toEqual(['old']);
    expect(w.pool.inputsOf(AdminRemoveUserFromGroupCommand).map((i) => i.Username)).toEqual(['old']);

    const skipRow = w.log.rows.find((r) => r.target?.sub === 'owner')!;
    expect(skipRow).toMatchObject({
      phase: 'refused',
      action: 'people.expireInvite',
      actor: { sub: 'system:invite-expiry', kind: 'system' },
      target: { sub: 'owner', email: 'owner@example.org' },
      before: { adminRole: 'superadmin', enabled: true, invite: 'expired', groups: ['superadmin'] },
      reason: 'Invite unused for 7 days',
      calls: ['Warning to the owner: ok', 'Warning to the fallback address: ok'],
    });
    expect(skipRow.error).toMatch(/^last_owner: skipped: last owner\./);
    expect(w.log.rows.filter((r) => r.target?.sub === 'owner')).toHaveLength(1);

    // The Activity page words it as a refusal by the scheduled job.
    const page = await w.log.listActivity({ targetSub: 'owner' });
    expect(page.entries.map((e) => e.status)).toEqual(['refused']);
    const line = describeActivity(page.entries[0]!);
    expect(line).toMatchObject({ actor: 'Scheduled job', verb: 'tried to disable the unused invite for', target: 'owner@example.org' });
    expect(line.status).toMatch(/^refused: last_owner: skipped: last owner/);

    expect(w.mail.sent.map((m) => [m.to.kind, m.to.email])).toEqual([
      ['owner', 'owner@example.org'],
      ['fallback', 'ops@example.org'],
    ]);
    expect(w.mail.sent[0]).toMatchObject({
      siteName: 'Example Reports',
      signInUrl: 'https://reports.example.org/sign-in',
      owner: { sub: 'owner', email: 'owner@example.org', name: 'Olivia' },
      invitedAt: new Date(NOW - 8 * DAY),
      expiredAt: new Date(NOW - DAY),
      at: new Date(NOW),
    });
  });

  it('another owner who is disabled doesn’t count', async () => {
    const w = world();
    w.pool.add(unusedOwner('owner'), 'superadmin');
    w.pool.add({ ...activeOwner('former'), enabled: false }, 'superadmin');
    const result = await w.sweep();
    expect(result.skipped.map((s) => s.sub)).toEqual(['owner']);
    expect(w.disabledUsernames()).toEqual([]);
  });

  it('an app role or a lower admin role beside an owner doesn’t count as an owner', async () => {
    const w = world();
    w.pool.add(unusedOwner('owner'), 'superadmin', 'reviewer');
    w.pool.add(activeOwner('admin'), 'admin');
    const result = await w.sweep();
    expect(result.skipped.map((s) => s.sub)).toEqual(['owner']);
    expect([...w.pool.get('owner')!.groups].sort()).toEqual(['reviewer', 'superadmin']);
  });
});

describe('more than one owner', () => {
  it('two owners, one never signed in: the unused one is disabled and loses the owner role, with no warning', async () => {
    const w = world({ fallbackEmail: 'ops@example.org' });
    w.pool.add(activeOwner('olivia'), 'superadmin');
    w.pool.add(unusedOwner('newbie'), 'superadmin');
    const result = await w.sweep();
    expect(result).toMatchObject({ disabled: ['newbie'], failed: [], skipped: [] });
    expect(w.pool.get('newbie')).toMatchObject({ enabled: false });
    expect([...w.pool.get('newbie')!.groups]).toEqual([]);
    expect(w.pool.get('olivia')).toMatchObject({ enabled: true });
    expect(w.mail.sent).toEqual([]);
    expect(w.log.rows.map((r) => r.phase)).toEqual(['intent', 'result']);
  });

  it('two owners who both never signed in: one is disabled and the other kept, so the site is never left with none', async () => {
    const w = world();
    w.pool.add(unusedOwner('first', 9), 'superadmin');
    w.pool.add(unusedOwner('second', 8), 'superadmin');
    const result = await w.sweep();
    expect(result.disabled).toEqual(['first']);
    expect(result.skipped.map((s) => s.sub)).toEqual(['second']);
    expect(w.pool.users.filter((u) => u.enabled && u.groups.has('superadmin')).map((u) => u.sub)).toEqual(['second']);
  });

  it('a disable that failed still counts as gone: the next owner is kept rather than risk zero', async () => {
    const w = world();
    w.pool.add(unusedOwner('first', 9), 'superadmin');
    w.pool.add(unusedOwner('second', 8), 'superadmin');
    w.pool.failOn('AdminDisableUserCommand', awsError('NotAuthorizedException', 'denied'));
    const result = await w.sweep();
    expect(result.failed.map((f) => f.sub)).toEqual(['first']);
    expect(result.skipped.map((s) => s.sub)).toEqual(['second']);
    expect(w.disabledUsernames()).toEqual(['first']);
  });
});

describe('failing closed', () => {
  it('the owner count can’t be read: the owner is skipped, not disabled, and the run reports a failure', async () => {
    const w = world();
    w.pool.add(activeOwner('olivia'), 'superadmin');
    w.pool.add(unusedOwner('newbie'), 'superadmin');
    w.pool.add({ sub: 'old', email: 'old@example.org', emailVerified: false, createdAt: new Date(NOW - 8 * DAY) }, 'viewer');
    w.pool.failOn('ListUsersInGroupCommand', awsError('AccessDeniedException', 'not authorized to perform ListUsersInGroup'));
    const result = await w.sweep();
    expect(result.failed).toEqual([{ sub: 'newbie', error: expect.stringMatching(/^Couldn't confirm another owner exists, so this owner's invite wasn't disabled\./) }]);
    expect(result.skipped).toEqual([]);
    expect(result.disabled).toEqual(['old']);
    expect(w.pool.get('newbie')).toMatchObject({ enabled: true });
    expect([...w.pool.get('newbie')!.groups]).toEqual(['superadmin']);
    expect(w.disabledUsernames()).toEqual(['old']);
    expect(w.mail.sent).toEqual([]); // not known to be the last owner, so no warning
    const row = w.log.rows.find((r) => r.target?.sub === 'newbie')!;
    expect(row).toMatchObject({ phase: 'refused', action: 'people.expireInvite' });
    expect(row.error).toMatch(/^owner_count_unknown: /);
  });

  it('their roles can’t be read: not disabled (they could be the last owner), reported as a failure', async () => {
    const w = world();
    w.pool.add(unusedOwner('owner'), 'superadmin');
    w.pool.failOn('AdminListGroupsForUserCommand', awsError('AccessDeniedException', 'not authorized'));
    const result = await w.sweep();
    expect(result.failed).toEqual([{ sub: 'owner', error: expect.stringMatching(/couldn't rule out that they're the site's last owner; not disabled/) }]);
    expect(w.pool.get('owner')).toMatchObject({ enabled: true });
    expect(w.disabledUsernames()).toEqual([]);
  });

  it('a warning that can’t be sent is a problem to report, never a reason to disable; the fallback still goes out', async () => {
    const w = world({ fallbackEmail: 'ops@example.org' });
    w.pool.add(unusedOwner('owner'), 'superadmin');
    w.mail.failures.owner = awsError('MessageRejected', 'Email address is not verified.');
    const result = await w.sweep();
    expect(result.skipped).toEqual([
      { sub: 'owner', reason: 'last-owner', warningDue: true, warned: ['fallback'], problems: [expect.stringMatching(/^Couldn't warn the owner: /)] },
    ]);
    expect(w.pool.get('owner')).toMatchObject({ enabled: true });
    expect(w.log.rows[0]!.calls).toEqual(['Warning to the owner: failed (MessageRejected)', 'Warning to the fallback address: ok']);
  });

  it('with no warning configured, the owner is still skipped, and the run says nobody was told', async () => {
    const w = world({ warnings: false });
    w.pool.add(unusedOwner('owner'), 'superadmin');
    const result = await w.sweep();
    expect(result.skipped).toEqual([
      { sub: 'owner', reason: 'last-owner', warningDue: true, warned: [], problems: ['No owner warning is configured (ownerWarnings), so nobody was told.'] },
    ]);
    expect(w.pool.get('owner')).toMatchObject({ enabled: true });
    expect(w.log.rows).toHaveLength(1);
  });

  it('with the audit log down, the owner is still skipped and warned, and the run says the skip wasn’t logged', async () => {
    const w = world();
    w.pool.add(unusedOwner('owner'), 'superadmin');
    w.log.failNextAppends(1);
    const result = await w.sweep();
    expect(result.skipped).toEqual([
      { sub: 'owner', reason: 'last-owner', warningDue: true, warned: ['owner'], problems: [expect.stringMatching(/^Couldn't log the skip: /)] },
    ]);
    expect(w.pool.get('owner')).toMatchObject({ enabled: true });
  });
});

describe('how often the last owner is warned', () => {
  it('on a schedule: the first run after the invite expired, then once a day; the runs between only skip', async () => {
    const w = world({ runEveryMinutes: 60 });
    // Expired 10 minutes before the first run.
    w.pool.add({ ...unusedOwner('owner'), createdAt: new Date(NOW - 7 * DAY - 10 * MINUTE) }, 'superadmin');

    expect((await w.sweep()).skipped[0]).toMatchObject({ warningDue: true, warned: ['owner'] });
    for (let hour = 1; hour < 24; hour++) {
      w.clock.t = NOW + hour * 60 * MINUTE;
      expect((await w.sweep()).skipped[0], `hour ${hour}`).toMatchObject({ warningDue: false, warned: [], problems: [] });
    }
    w.clock.t = NOW + DAY;
    expect((await w.sweep()).skipped[0]).toMatchObject({ warningDue: true, warned: ['owner'] });

    expect(w.mail.sent).toHaveLength(2);
    expect(w.log.rows.filter((r) => r.phase === 'refused')).toHaveLength(2);
    expect(w.pool.get('owner')).toMatchObject({ enabled: true });
    expect(w.disabledUsernames()).toEqual([]);
  });

  it('lastOwnerWarningDue: every run without a window or with a daily one; one run a day otherwise', () => {
    const createdAt = new Date(NOW - 8 * DAY); // expired exactly a day before NOW
    expect(lastOwnerWarningDue(createdAt, NOW + 5 * 60 * MINUTE, undefined)).toBe(true);
    expect(lastOwnerWarningDue(createdAt, NOW + 5 * 60 * MINUTE, DAY)).toBe(true);
    expect(lastOwnerWarningDue(createdAt, NOW + 59 * MINUTE, 60 * MINUTE)).toBe(true);
    expect(lastOwnerWarningDue(createdAt, NOW + 60 * MINUTE, 60 * MINUTE)).toBe(false);
    expect(lastOwnerWarningDue(createdAt, NOW + 9 * MINUTE, 10 * MINUTE)).toBe(true);
    expect(lastOwnerWarningDue(createdAt, NOW + 10 * MINUTE, 10 * MINUTE)).toBe(false);
    // An unreadable creation date is still warned once a day (at midnight UTC), never every run.
    const midnight = Date.parse('2026-10-18T00:00:00.000Z');
    expect(lastOwnerWarningDue(new Date(Number.NaN), midnight + 5 * MINUTE, 60 * MINUTE)).toBe(true);
    expect(lastOwnerWarningDue(new Date(Number.NaN), midnight + 65 * MINUTE, 60 * MINUTE)).toBe(false);
  });

  it('refuses a run interval that isn’t a whole number of minutes', () => {
    expect(() => createInviteExpirySweep({ userPoolId: 'us-east-1_TestPool1', auditLog: createMemoryAuditLog(), runEveryMinutes: 0 })).toThrow(/runEveryMinutes/);
  });
});
