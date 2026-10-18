/**
 * Account creation's scheduled jobs (ADR 0023): the unverified-account sweep and the access-request
 * digest, their logic over the fake Cognito pool and the in-memory stores, and their Lambda handlers'
 * environment, log line, and failure rules. The deployed resources are in cdk.test.ts. No AWS.
 */
import { AdminDeleteUserCommand, AdminGetUserCommand, AdminListGroupsForUserCommand, ListUsersCommand, ListUsersInGroupCommand } from '@aws-sdk/client-cognito-identity-provider';
import { describe, expect, it, vi } from 'vitest';
import { ACCESS_REQUEST_DIGEST_ENV, UNVERIFIED_SWEEP_ENV } from '../../src/accounts/jobs-env.js';
import { PEOPLE_MANAGER_GROUPS, createAccessRequestDigest, type AccessRequestDigestOptions, type AccessRequestDigestResult } from '../../src/accounts/digest.js';
import { accessRequestDigestConfig, createAccessRequestDigestHandler } from '../../src/accounts/digest-handler.js';
import { createSignInHelp } from '../../src/accounts/sign-in-help.js';
import { SITE_SETTING } from '../../src/accounts/schema.js';
import { type AccessRequestStore, createMemoryAccessRequestStore, createMemorySiteSettingsStore } from '../../src/accounts/stores.js';
import { createUnverifiedAccountSweep, unverifiedSignUpDue, type UnverifiedSweepResult } from '../../src/accounts/unverified-sweep.js';
import { createUnverifiedSweepHandler, unverifiedSweepConfig } from '../../src/accounts/unverified-sweep-handler.js';
import { createMemoryAuditLog, type EmailSender } from '../../src/admin/index.js';
import { UNVERIFIED_SWEEP_COGNITO_ACTIONS } from '../../src/admin/iam.js';
import type { CognitoPerson } from '../../src/admin/cognito-admin.js';
import { clockDate, clockDateTime, type RenderedEmail } from '../../src/shared/emails.js';
import { OWNER_GROUP } from '../../src/shared/policy.js';
import { DAY, NOW, awsError, fakeUserPool } from '../admin/people-fixture.js';

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
const POOL_ID = 'us-east-1_TestPool1';
const noSleep = () => Promise.resolve();

// ---- The unverified-account sweep -----------------------------------------------------------------

/** Every kind of account the sweep must tell apart, in pool order. */
function seedAccounts(pool: ReturnType<typeof fakeUserPool>) {
  const signUp = { origin: 'signup', emailVerified: false };
  pool.add({ sub: 'stray', email: 'stray@example.com', ...signUp, createdAt: new Date(NOW - 25 * HOUR) });
  pool.add({ sub: 'exactly-24h', email: 'edge@example.com', ...signUp, createdAt: new Date(NOW - 24 * HOUR) });
  pool.add({ sub: 'young', email: 'young@example.com', ...signUp, createdAt: new Date(NOW - 23 * HOUR) });
  // Admin invites carry no mark: never this sweep's, at any age (the invite-expiry sweep disables them).
  pool.add({ sub: 'invite-old', email: 'invite-old@example.org', emailVerified: false, createdAt: new Date(NOW - 100 * DAY) });
  pool.add({ sub: 'invite-role', email: 'invite-role@example.org', emailVerified: false, createdAt: new Date(NOW - 30 * DAY) }, 'admin-view');
  pool.add({ sub: 'verified', email: 'verified@example.com', origin: 'signup', emailVerified: true, createdAt: new Date(NOW - 10 * DAY) });
  // A sign-up account someone gave a role: the owner above all must stay.
  pool.add({ sub: 'owner', email: 'owner@example.org', ...signUp, createdAt: new Date(NOW - 10 * DAY) }, OWNER_GROUP);
  pool.add({ sub: 'given-role', email: 'role@example.com', ...signUp, createdAt: new Date(NOW - 2 * DAY) }, 'editors');
  pool.add({ sub: 'disabled', email: 'disabled@example.com', ...signUp, enabled: false, createdAt: new Date(NOW - 3 * DAY) });
}

function sweepSetup(options: { olderThanHours?: number; maxPeople?: number; maxDeletesPerRun?: number } = {}) {
  const timeline: string[] = [];
  const pool = fakeUserPool({ timeline });
  const log = createMemoryAuditLog({ now: () => NOW });
  const sweep = createUnverifiedAccountSweep({
    userPoolId: POOL_ID,
    auditLog: log,
    cognito: pool.client,
    now: () => NOW,
    sleep: noSleep,
    quota: { random: () => 0 },
    ...options,
  });
  return { pool, log, sweep, timeline };
}

const usernames = (inputs: { Username?: string }[]) => inputs.map((i) => i.Username);

describe('createUnverifiedAccountSweep', () => {
  it('deletes only sign-up accounts still unverified 24 hours after they were made', async () => {
    const { pool, sweep } = sweepSetup();
    seedAccounts(pool);
    const result = await sweep();
    // The disabled account isn't even listed: the sweep asks Cognito for enabled accounts only.
    expect(result).toEqual({
      deleted: ['stray', 'exactly-24h'],
      skipped: [
        { sub: 'owner', reason: 'has-role' },
        { sub: 'given-role', reason: 'has-role' },
      ],
      failed: [],
      checked: 8,
      truncated: false,
      deferred: false,
    });
    for (const input of pool.inputsOf(ListUsersCommand)) expect((input as { Filter?: string }).Filter).toBe('status = "Enabled"');
    expect(pool.get('stray')).toBeUndefined();
    expect(pool.get('exactly-24h')).toBeUndefined();
    for (const sub of ['young', 'invite-old', 'invite-role', 'verified', 'owner', 'given-role', 'disabled']) expect(pool.get(sub), sub).toBeDefined();
    expect([...pool.get('owner')!.groups]).toEqual([OWNER_GROUP]);
    expect(pool.get('disabled')!.enabled).toBe(false);
    expect(usernames(pool.inputsOf(AdminDeleteUserCommand))).toEqual(['stray', 'exactly-24h']);
    // Nothing else changed: no disable, no group change.
    expect(pool.writes()).toEqual(['AdminDeleteUserCommand', 'AdminDeleteUserCommand']);
  });

  it('re-reads each due account just before deleting it: one verified, disabled, or changed since the listing stays (L1)', async () => {
    const { pool, sweep } = sweepSetup();
    pool.add({ sub: 'verified-meanwhile', email: 'a@example.com', origin: 'signup', emailVerified: false, createdAt: new Date(NOW - 25 * HOUR) });
    pool.add({ sub: 'disabled-meanwhile', email: 'b@example.com', origin: 'signup', emailVerified: false, createdAt: new Date(NOW - 25 * HOUR) });
    pool.add({ sub: 'touched-meanwhile', email: 'c@example.com', origin: 'signup', emailVerified: false, createdAt: new Date(NOW - 25 * HOUR) });
    pool.add({ sub: 'gone-meanwhile', email: 'd@example.com', origin: 'signup', emailVerified: false, createdAt: new Date(NOW - 25 * HOUR) });
    pool.add({ sub: 'still-due', email: 'e@example.com', origin: 'signup', emailVerified: false, createdAt: new Date(NOW - 25 * HOUR) });
    // Between the listing and the delete: a first code entered, an admin's disable, a passkey saved (a modification), a delete.
    const meanwhile: Record<string, () => void> = {
      'verified-meanwhile': () => void (pool.get('verified-meanwhile')!.emailVerified = true),
      'disabled-meanwhile': () => void (pool.get('disabled-meanwhile')!.enabled = false),
      'touched-meanwhile': () => void (pool.get('touched-meanwhile')!.modifiedAt = new Date(NOW - MIN)),
      'gone-meanwhile': () => void pool.users.splice(pool.users.findIndex((u) => u.sub === 'gone-meanwhile'), 1),
    };
    pool.mock.on(AdminListGroupsForUserCommand).callsFake((input: { Username: string }) => {
      meanwhile[input.Username]?.();
      return { Groups: [] };
    });
    const result = await sweep();
    expect(result.deleted).toEqual(['still-due']);
    expect(result.skipped).toEqual([
      { sub: 'verified-meanwhile', reason: 'changed' },
      { sub: 'disabled-meanwhile', reason: 'changed' },
      { sub: 'touched-meanwhile', reason: 'changed' },
      { sub: 'gone-meanwhile', reason: 'gone' },
    ]);
    expect(usernames(pool.inputsOf(AdminDeleteUserCommand))).toEqual(['still-due']);
  });

  it('pages past 5,000 accounts without stopping, and defers past maxDeletesPerRun (M4)', async () => {
    const { pool, sweep } = sweepSetup({ maxDeletesPerRun: 3 });
    for (let i = 0; i < 6000; i++) pool.add({ sub: `member-${i}`, email: `m${i}@example.org`, emailVerified: true, createdAt: new Date(NOW - 100 * DAY) });
    for (let i = 0; i < 5; i++) pool.add({ sub: `late-stray-${i}`, email: `late${i}@example.com`, origin: 'signup', emailVerified: false, createdAt: new Date(NOW - 25 * HOUR) });
    const result = await sweep();
    expect(result.deleted).toEqual(['late-stray-0', 'late-stray-1', 'late-stray-2']);
    expect(result.deferred).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.checked).toBe(6004);
    // The next run carries on.
    const next = await sweep();
    expect(next.deleted).toEqual(['late-stray-3', 'late-stray-4']);
    expect(next.deferred).toBe(false);
  });

  it('reads the sign-up mark, and only the due, enabled accounts’ roles', async () => {
    const { pool, sweep, timeline } = sweepSetup();
    seedAccounts(pool);
    await sweep();
    for (const input of pool.inputsOf(ListUsersCommand)) expect(input.AttributesToGet).toContain('custom:authkit_origin');
    expect(usernames(pool.inputsOf(AdminListGroupsForUserCommand))).toEqual(['stray', 'exactly-24h', 'owner', 'given-role']);
    // Re-read just before each delete, and only then.
    expect(usernames(pool.inputsOf(AdminGetUserCommand))).toEqual(['stray', 'exactly-24h']);
    // The calls it made are exactly the ones its role allows (the construct, UNVERIFIED_SWEEP_COGNITO_ACTIONS).
    const calls = new Set(timeline.filter((t) => t.startsWith('cognito:')).map((t) => `cognito-idp:${t.slice('cognito:'.length)}`));
    expect([...calls].sort()).toEqual([...UNVERIFIED_SWEEP_COGNITO_ACTIONS].sort());
  });

  it('writes an intent and a result row for each deletion, as system:unverified-sweep', async () => {
    const { pool, log, sweep } = sweepSetup();
    seedAccounts(pool);
    await sweep();
    expect(log.rows.map((r) => [r.phase, r.action, r.actor.sub, r.actor.kind, r.target?.sub])).toEqual([
      ['intent', 'accounts.deleteUnverified', 'system:unverified-sweep', 'system', 'stray'],
      ['result', 'accounts.deleteUnverified', 'system:unverified-sweep', 'system', 'stray'],
      ['intent', 'accounts.deleteUnverified', 'system:unverified-sweep', 'system', 'exactly-24h'],
      ['result', 'accounts.deleteUnverified', 'system:unverified-sweep', 'system', 'exactly-24h'],
    ]);
    const [intent, result] = log.rows;
    expect(intent).toMatchObject({
      target: { sub: 'stray', email: 'stray@example.com' },
      before: { email: 'stray@example.com', origin: 'signup', status: 'unverified', createdAt: new Date(NOW - 25 * HOUR).toISOString() },
      after: null,
      reason: 'Address never verified within 24 hours of signing up',
      calls: ['AdminDeleteUser'],
    });
    expect(result).toMatchObject({ outcome: 'ok', intentId: intent!.id, calls: ['AdminDeleteUser: ok'] });
    // One run, one request ID.
    expect(new Set(log.rows.map((r) => r.requestId)).size).toBe(1);
    expect(log.rows[0]!.requestId).toEqual(expect.any(String));
  });

  it('an account whose roles can’t be read is reported in failed and not deleted', async () => {
    const { pool, log, sweep } = sweepSetup();
    pool.add({ sub: 'stray', email: 'stray@example.com', origin: 'signup', emailVerified: false, createdAt: new Date(NOW - 2 * DAY) });
    pool.add({ sub: 'stray-2', email: 'stray2@example.com', origin: 'signup', emailVerified: false, createdAt: new Date(NOW - 2 * DAY) });
    pool.failOnCall('AdminListGroupsForUserCommand', 1, awsError('AccessDeniedException'));
    const result = await sweep();
    expect(result.deleted).toEqual(['stray-2']);
    expect(result.failed).toEqual([{ sub: 'stray', error: expect.stringMatching(/^Couldn't read its roles, so it wasn't deleted: /) }]);
    expect(pool.get('stray')).toBeDefined();
    expect(log.rows.filter((r) => r.target?.sub === 'stray')).toEqual([]);
  });

  it('a failed AdminDeleteUser lands in failed, with a failed result row, and the run goes on', async () => {
    const { pool, log, sweep } = sweepSetup();
    pool.add({ sub: 'stray', email: 'stray@example.com', origin: 'signup', emailVerified: false, createdAt: new Date(NOW - 2 * DAY) });
    pool.add({ sub: 'stray-2', email: 'stray2@example.com', origin: 'signup', emailVerified: false, createdAt: new Date(NOW - 2 * DAY) });
    pool.failOn('AdminDeleteUserCommand', awsError('InternalErrorException', 'Cognito broke'));
    const result = await sweep();
    expect(result.deleted).toEqual(['stray-2']);
    expect(result.failed).toEqual([{ sub: 'stray', error: expect.any(String) }]);
    expect(pool.get('stray')).toBeDefined();
    const strayResult = log.rows.find((r) => r.target?.sub === 'stray' && r.phase === 'result')!;
    expect(strayResult).toMatchObject({ outcome: 'failed', calls: ['AdminDeleteUser: failed (InternalErrorException)'] });
    expect(strayResult.error).toContain('InternalErrorException');
  });

  it("when the audit row can't be written, nothing is deleted for that account", async () => {
    const { pool, log, sweep } = sweepSetup();
    pool.add({ sub: 'stray', email: 'stray@example.com', origin: 'signup', emailVerified: false, createdAt: new Date(NOW - 2 * DAY) });
    log.failNextAppends(1);
    const result = await sweep();
    expect(result.deleted).toEqual([]);
    expect(result.failed).toEqual([{ sub: 'stray', error: expect.stringMatching(/^The audit row couldn't be written, so it wasn't deleted/) }]);
    expect(pool.inputsOf(AdminDeleteUserCommand)).toEqual([]);
    expect(pool.get('stray')).toBeDefined();
  });

  it('reports a pool larger than maxPeople as truncated, and checks only that many', async () => {
    const { pool, sweep } = sweepSetup({ maxPeople: 2 });
    for (const sub of ['a', 'b', 'c']) pool.add({ sub, email: `${sub}@example.com`, origin: 'signup', emailVerified: false, createdAt: new Date(NOW - 2 * DAY) });
    const result = await sweep();
    expect(result).toMatchObject({ checked: 2, truncated: true, deleted: ['a', 'b'] });
    expect(pool.get('c')).toBeDefined();
  });

  it('waits longer when told to, and refuses a wait under an hour or a pool ID that isn’t one', async () => {
    const { pool, sweep } = sweepSetup({ olderThanHours: 48 });
    seedAccounts(pool);
    expect((await sweep()).deleted).toEqual([]);
    const auditLog = createMemoryAuditLog();
    expect(() => createUnverifiedAccountSweep({ userPoolId: 'not-a-pool', auditLog })).toThrow(/isn't a Cognito user pool ID/);
    expect(() => createUnverifiedAccountSweep({ userPoolId: POOL_ID, auditLog, olderThanHours: 0.5 })).toThrow(/olderThanHours/);
    expect(() => createUnverifiedAccountSweep({ userPoolId: POOL_ID, auditLog, olderThanHours: Number.NaN })).toThrow(/olderThanHours/);
  });

  it('unverifiedSignUpDue: the mark, unverified, old enough, and a readable creation date', () => {
    const person: CognitoPerson = {
      username: 'u',
      sub: 'u',
      email: 'u@example.com',
      emailVerified: false,
      enabled: true,
      status: 'CONFIRMED',
      createdAt: new Date(NOW - 24 * HOUR),
      origin: 'signup',
    };
    expect(unverifiedSignUpDue(person, NOW)).toBe(true);
    expect(unverifiedSignUpDue({ ...person, createdAt: new Date(NOW - 24 * HOUR + 1) }, NOW)).toBe(false);
    expect(unverifiedSignUpDue({ ...person, emailVerified: true }, NOW)).toBe(false);
    expect(unverifiedSignUpDue({ ...person, origin: 'invite' }, NOW)).toBe(false);
    const { origin: _origin, ...unmarked } = person;
    expect(unverifiedSignUpDue(unmarked, NOW)).toBe(false);
    expect(unverifiedSignUpDue({ ...person, createdAt: new Date(Number.NaN) }, NOW)).toBe(false);
    expect(unverifiedSignUpDue(person, NOW, 25)).toBe(false);
  });
});

describe('the unverified-sweep handler', () => {
  const ENV = {
    [UNVERIFIED_SWEEP_ENV.userPoolId]: POOL_ID,
    [UNVERIFIED_SWEEP_ENV.auditTable]: 'site-data-AuditLogTable-EXAMPLE',
    [UNVERIFIED_SWEEP_ENV.maxPeople]: '5000',
    [UNVERIFIED_SWEEP_ENV.olderThanHours]: '24',
  };

  it('the environment the construct sets', () => {
    expect(UNVERIFIED_SWEEP_ENV).toEqual({
      userPoolId: 'AUTH_KIT_USER_POOL_ID',
      auditTable: 'AUTH_KIT_AUDIT_TABLE',
      maxPeople: 'AUTH_KIT_MAX_PEOPLE',
      olderThanHours: 'AUTH_KIT_UNVERIFIED_HOURS',
    });
    expect(unverifiedSweepConfig(ENV)).toEqual({ userPoolId: POOL_ID, auditTable: 'site-data-AuditLogTable-EXAMPLE', maxPeople: 5000, olderThanHours: 24 });
    expect(unverifiedSweepConfig({ ...ENV, AUTH_KIT_MAX_PEOPLE: undefined, AUTH_KIT_UNVERIFIED_HOURS: '' })).toEqual({ userPoolId: POOL_ID, auditTable: 'site-data-AuditLogTable-EXAMPLE' });
  });

  it('names every problem with the environment at once', () => {
    expect(() =>
      unverifiedSweepConfig({ AUTH_KIT_USER_POOL_ID: 'not-a-pool', AUTH_KIT_AUDIT_TABLE: 'x', AUTH_KIT_MAX_PEOPLE: '0', AUTH_KIT_UNVERIFIED_HOURS: '1.5' }),
    ).toThrow(/^auth-kit unverified-account sweep: AUTH_KIT_USER_POOL_ID .*; AUTH_KIT_AUDIT_TABLE .*; AUTH_KIT_MAX_PEOPLE .*; AUTH_KIT_UNVERIFIED_HOURS /);
    expect(() => unverifiedSweepConfig({ ...ENV, AUTH_KIT_UNVERIFIED_HOURS: 'soon' })).toThrow(/AUTH_KIT_UNVERIFIED_HOURS must be a whole number of at least 1/);
  });

  it('refuses the placeholder help address in the environment', () => {
    expect(() =>
      accessRequestDigestConfig({
        AUTH_KIT_USER_POOL_ID: 'us-east-1_TestPool1',
        AUTH_KIT_REQUEST_TABLE: 'requests',
        AUTH_KIT_SITE_NAME: 'Example Reports',
        AUTH_KIT_FAMILY: 'osbm',
        AUTH_KIT_SIGN_IN_URL: 'https://reports.example.org/sign-in',
        AUTH_KIT_PEOPLE_URL: 'https://reports.example.org/admin/people',
        AUTH_KIT_HELP_EMAIL: 'apps-help@replace-me.invalid',
        AUTH_KIT_MAIL_FROM: 'Example Reports <sign-in@example.org>',
      }),
    ).toThrow(/AUTH_KIT_HELP_EMAIL must be the help mailbox \(.*placeholder/);
  });

  it('a bad environment fails the invocation (so the alarm sees it), not the import', async () => {
    const handler = createUnverifiedSweepHandler({ env: {}, log: () => {} });
    await expect(handler()).rejects.toThrow(/AUTH_KIT_USER_POOL_ID/);
  });

  function handlerWith(result: UnverifiedSweepResult) {
    const lines: string[] = [];
    const createSweep = vi.fn(() => () => Promise.resolve(result));
    return { handler: createUnverifiedSweepHandler({ env: ENV, createSweep, log: (l) => lines.push(l) }), lines, createSweep };
  }

  it('logs one JSON line of subs and counts, builds the sweep once, and passes on the settings', async () => {
    const { handler, lines, createSweep } = handlerWith({ deleted: ['stray'], skipped: [{ sub: 'owner', reason: 'has-role' }], failed: [], checked: 9, truncated: false });
    expect(await handler()).toEqual({ event: 'auth-kit.unverified-sweep', deleted: ['stray'], skipped: [{ sub: 'owner', reason: 'has-role' }], failed: [], checked: 9, truncated: false });
    await handler();
    expect(createSweep).toHaveBeenCalledTimes(1);
    expect(createSweep.mock.calls[0]).toEqual([expect.objectContaining({ userPoolId: POOL_ID, maxPeople: 5000, olderThanHours: 24, auditLog: expect.any(Object) })]);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ event: 'auth-kit.unverified-sweep', deleted: ['stray'], skipped: [{ sub: 'owner', reason: 'has-role' }], failed: [], checked: 9, truncated: false });
    expect(lines[0]).not.toMatch(/@/);
  });

  it('throws (after logging) when a due account couldn’t be deleted, and never logs an address an error quotes', async () => {
    const { handler, lines } = handlerWith({
      deleted: [],
      skipped: [],
      failed: [{ sub: 'stray', error: 'Cognito refused stray@example.com: try again' }],
      checked: 3,
      truncated: false,
    });
    const error = (await handler().catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/1 due account\(s\) couldn't be deleted/);
    expect(error.message).not.toMatch(/@/);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/@/);
    expect(JSON.parse(lines[0]!).failed).toEqual([{ sub: 'stray', error: 'Cognito refused [address]: try again' }]);
  });

  it('throws when the pool outgrew maxPeople (the rest went unchecked), naming both problems at once', async () => {
    await expect(handlerWith({ deleted: [], skipped: [], failed: [], checked: 5000, truncated: true, deferred: false }).handler()).rejects.toThrow(/more than 5000 enabled accounts.*raise maxPeople/);
    await expect(handlerWith({ deleted: [], skipped: [], failed: [{ sub: 'a', error: 'x' }], checked: 5000, truncated: true, deferred: false }).handler()).rejects.toThrow(
      /couldn't be deleted; the pool has more than 5000/,
    );
  });

  it('a run that reached maxDeletesPerRun (deferred) is not a failure: the next run carries on', async () => {
    await expect(handlerWith({ deleted: ['a'], skipped: [], failed: [], checked: 10, truncated: false, deferred: true }).handler()).resolves.toMatchObject({ deferred: true });
  });

  it('skips alone are not a failure', async () => {
    const { handler } = handlerWith({ deleted: [], skipped: [{ sub: 'owner', reason: 'has-role' }, { sub: 'd', reason: 'disabled' }], failed: [], checked: 2, truncated: false });
    await expect(handler()).resolves.toMatchObject({ skipped: [{ reason: 'has-role' }, { reason: 'disabled' }] });
  });

  it('end to end: the handler’s own options, with the fake pool and a memory log swapped in', async () => {
    const pool = fakeUserPool();
    seedAccounts(pool);
    const log = createMemoryAuditLog({ now: () => NOW });
    const lines: string[] = [];
    const handler = createUnverifiedSweepHandler({
      env: ENV,
      createSweep: (options) => createUnverifiedAccountSweep({ ...options, auditLog: log, cognito: pool.client, now: () => NOW, sleep: noSleep }),
      log: (l) => lines.push(l),
    });
    expect(await handler()).toMatchObject({ deleted: ['stray', 'exactly-24h'], failed: [], checked: 8, truncated: false, deferred: false });
    expect(log.rows).toHaveLength(4);
    expect(lines[0]).not.toMatch(/@/);
  });
});

// ---- The access-request digest --------------------------------------------------------------------

const SITE = { siteName: 'Example Reports', signInUrl: 'https://reports.example.org/sign-in' };
const PEOPLE_URL = 'https://reports.example.org/admin/people';
const ADMIN = { sub: 'admin-1', email: 'admin@example.org' };

/** People in every kind of group: only enabled members with an address, of the groups that manage people, get the digest. */
function seedAdmins(pool: ReturnType<typeof fakeUserPool>) {
  pool.add({ sub: 'owner-1', email: 'owner@example.org' }, OWNER_GROUP);
  pool.add({ sub: 'super-1', email: 'super@example.org' }, 'superadmin');
  pool.add({ sub: 'both-1', email: 'both@example.org' }, 'superadmin', 'admin-content-people');
  pool.add({ sub: 'acp-1', email: 'acp@example.org' }, 'admin-content-people');
  pool.add({ sub: 'acp-off', email: 'acp-off@example.org', enabled: false }, 'admin-content-people');
  pool.add({ sub: 'no-address', email: '' }, 'superadmin');
  pool.add({ sub: 'content-1', email: 'content@example.org' }, 'admin-content');
  pool.add({ sub: 'view-1', email: 'view@example.org' }, 'admin-view');
  pool.add({ sub: 'editor-1', email: 'editor@example.org' }, 'editors');
  pool.add({ sub: 'member-1', email: 'member@example.org' });
}

function recordingMailer() {
  const sent: { to: readonly string[]; email: RenderedEmail; replyTo?: readonly string[] }[] = [];
  const mailer: EmailSender = {
    sendEmail(message) {
      sent.push(message);
      return Promise.resolve();
    },
  };
  return { mailer, sent };
}

function digestSetup(over: Partial<AccessRequestDigestOptions> = {}) {
  const pool = fakeUserPool();
  const store = createMemoryAccessRequestStore();
  const calls: string[] = [];
  // The store, with its calls recorded in order.
  const requests: AccessRequestStore = {
    create: (input) => store.create(input),
    get: (id, now) => store.get(id, now),
    settle: (id, input) => store.settle(id, input),
    list: (now, options) => {
      calls.push('list');
      return store.list(now, options);
    },
    purge: (now) => {
      calls.push('purge');
      return store.purge(now);
    },
  };
  const { mailer, sent } = recordingMailer();
  const run = () =>
    createAccessRequestDigest({
      requests,
      userPoolId: POOL_ID,
      mailer,
      site: { ...SITE, help: 'help@example.org' },
      peopleUrl: PEOPLE_URL,
      cognito: pool.client,
      now: () => NOW,
      sleep: noSleep,
      quota: { random: () => 0 },
      ...over,
    })();
  return { pool, store, calls, sent, run };
}

describe('createAccessRequestDigest', () => {
  it('goes to the groups that manage people: the owner, Super admins, Admin – content & people', () => {
    expect(PEOPLE_MANAGER_GROUPS).toEqual(['owner', 'superadmin', 'admin-content-people']);
  });

  it('purges first, then emails one message listing each pending request to every enabled people manager with an address', async () => {
    const { pool, store, calls, sent, run } = digestSetup();
    seedAdmins(pool);
    // Due for deletion: decided 31 days ago.
    const old = (await store.create({ email: 'old@example.com', name: 'Old', reason: 'Old reason', now: new Date(NOW - 40 * DAY) })).request;
    await store.settle(old.id, { status: 'declined', by: ADMIN, now: new Date(NOW - 31 * DAY) });
    // Kept, but not pending: an expired one and a decided one.
    await store.create({ email: 'lapsed@example.com', now: new Date(NOW - 31 * DAY) });
    const decided = (await store.create({ email: 'decided@example.com', now: new Date(NOW - 3 * DAY) })).request;
    await store.settle(decided.id, { status: 'approved', by: ADMIN, now: new Date(NOW - DAY) });
    // Pending.
    await store.create({ email: 'nia@example.com', name: 'Nia', reason: 'Quarterly <reports>', now: new Date(NOW - 2 * DAY) });
    await store.create({ email: 'raj@example.com', now: new Date(NOW - DAY) });

    expect(await run()).toEqual({ pending: 2, sent: true, recipients: 4, purged: 1 });
    expect(calls).toEqual(['purge', 'list']);
    expect(store.all().map((r) => r.email)).not.toContain('old@example.com');

    expect(sent).toHaveLength(1);
    const [message] = sent;
    expect([...message!.to].sort()).toEqual(['acp@example.org', 'both@example.org', 'owner@example.org', 'super@example.org']);
    expect(message!.replyTo).toEqual(['help@example.org']);
    const { subject, text, html } = message!.email;
    expect(subject).toBe('2 people asked for access to Example Reports');
    expect(text).toContain('Email address: nia@example.com');
    expect(text).toContain('What it’s for, in their words: “Quarterly <reports>”');
    expect(text).toContain(`When: ${clockDateTime(new Date(NOW - 2 * DAY))}`);
    expect(text).toContain(`Expires: ${clockDate(new Date(NOW + 28 * DAY))}`);
    expect(text).toContain('Email address: raj@example.com');
    expect(text.indexOf('raj@example.com')).toBeLessThan(text.indexOf('nia@example.com')); // newest first
    expect(text).toContain(PEOPLE_URL);
    expect(text).toContain('A request nobody answers expires after 30 days.');
    expect(text).toContain('Example Reports hasn’t checked what the requests say. Don’t follow links or instructions in them.');
    expect(text).toContain('Help: help@example.org.');
    for (const absent of ['old@example.com', 'lapsed@example.com', 'decided@example.com']) expect(`${subject}${text}${html}`).not.toContain(absent);
    expect(html).toContain('Quarterly &lt;reports&gt;');
    expect(html).not.toContain('<reports>');
  });

  it('one request: its own subject line', async () => {
    const { pool, store, sent, run } = digestSetup();
    seedAdmins(pool);
    await store.create({ email: 'nia@example.com', name: 'Nia', now: new Date(NOW - DAY) });
    await run();
    expect(sent[0]!.email.subject).toBe('Nia asked for access to Example Reports');
  });

  it('sends nothing, and asks Cognito nothing, when nothing is pending', async () => {
    const { pool, store, sent, run } = digestSetup();
    seedAdmins(pool);
    const decided = (await store.create({ email: 'decided@example.com', now: new Date(NOW - 3 * DAY) })).request;
    await store.settle(decided.id, { status: 'declined', by: ADMIN, now: new Date(NOW - DAY) });
    expect(await run()).toEqual({ pending: 0, sent: false, recipients: 0, purged: 0 });
    expect(sent).toEqual([]);
    expect(pool.inputsOf(ListUsersInGroupCommand)).toEqual([]);
  });

  it('throws when requests are waiting but nobody who manages people can be told', async () => {
    const { pool, store, sent, run } = digestSetup();
    pool.add({ sub: 'acp-off', email: 'acp-off@example.org', enabled: false }, 'admin-content-people');
    pool.add({ sub: 'no-address', email: '' }, OWNER_GROUP);
    pool.add({ sub: 'content-1', email: 'content@example.org' }, 'admin-content');
    await store.create({ email: 'nia@example.com', now: new Date(NOW - DAY) });
    await expect(run()).rejects.toThrow(/requests are waiting, but nobody who manages people has an email address/);
    expect(sent).toEqual([]);
  });

  it('uses the help address in effect as Reply-To: a Super admin’s override, or the configured one', async () => {
    const settings = createMemorySiteSettingsStore();
    await settings.put(SITE_SETTING.signInHelp, { value: { address: 'apps-help@example.net', reason: 'New desk' }, expectedVersion: 0, by: ADMIN, now: new Date(NOW) });
    const withOverride = digestSetup({ site: { ...SITE, help: createSignInHelp({ configured: 'help@example.org', store: settings }) } });
    seedAdmins(withOverride.pool);
    await withOverride.store.create({ email: 'nia@example.com', now: new Date(NOW - DAY) });
    await withOverride.run();
    expect(withOverride.sent[0]!.replyTo).toEqual(['apps-help@example.net']);
    expect(withOverride.sent[0]!.email.text).toContain('Help: apps-help@example.net.');

    // No override: the configured address.
    const plain = digestSetup({ site: { ...SITE, help: createSignInHelp({ configured: 'help@example.org', store: createMemorySiteSettingsStore() }) } });
    seedAdmins(plain.pool);
    await plain.store.create({ email: 'nia@example.com', now: new Date(NOW - DAY) });
    await plain.run();
    expect(plain.sent[0]!.replyTo).toEqual(['help@example.org']);
  });

  it('takes the app’s own recipient groups, and refuses none or a pool ID that isn’t one', async () => {
    const { pool, store, sent, run } = digestSetup({ recipientGroups: ['editors'] });
    seedAdmins(pool);
    await store.create({ email: 'nia@example.com', now: new Date(NOW - DAY) });
    expect(await run()).toMatchObject({ sent: true, recipients: 1 });
    expect(sent[0]!.to).toEqual(['editor@example.org']);
    const base = { requests: createMemoryAccessRequestStore(), mailer: recordingMailer().mailer, site: { ...SITE, help: 'help@example.org' }, peopleUrl: PEOPLE_URL };
    expect(() => createAccessRequestDigest({ ...base, userPoolId: POOL_ID, recipientGroups: [] })).toThrow(/at least one recipient group/);
    expect(() => createAccessRequestDigest({ ...base, userPoolId: 'not-a-pool' })).toThrow(/isn't a Cognito user pool ID/);
  });
});

describe('the access-request digest handler', () => {
  const ENV = {
    [ACCESS_REQUEST_DIGEST_ENV.userPoolId]: POOL_ID,
    [ACCESS_REQUEST_DIGEST_ENV.requestTable]: 'site-data-AccessRequestTable-EXAMPLE',
    [ACCESS_REQUEST_DIGEST_ENV.siteName]: 'Example Reports',
    [ACCESS_REQUEST_DIGEST_ENV.family]: 'unc',
    [ACCESS_REQUEST_DIGEST_ENV.signInUrl]: 'https://reports.example.org/sign-in',
    [ACCESS_REQUEST_DIGEST_ENV.peopleUrl]: PEOPLE_URL,
    [ACCESS_REQUEST_DIGEST_ENV.helpEmail]: 'help@example.org',
    [ACCESS_REQUEST_DIGEST_ENV.mailFrom]: 'Example Reports (UNC) <sign-in@example.org>',
  };

  it('the environment the construct sets', () => {
    expect(ACCESS_REQUEST_DIGEST_ENV).toEqual({
      userPoolId: 'AUTH_KIT_USER_POOL_ID',
      requestTable: 'AUTH_KIT_REQUEST_TABLE',
      settingsTable: 'AUTH_KIT_SETTINGS_TABLE',
      siteName: 'AUTH_KIT_SITE_NAME',
      family: 'AUTH_KIT_FAMILY',
      signInUrl: 'AUTH_KIT_SIGN_IN_URL',
      peopleUrl: 'AUTH_KIT_PEOPLE_URL',
      helpEmail: 'AUTH_KIT_HELP_EMAIL',
      mailFrom: 'AUTH_KIT_MAIL_FROM',
      mailConfigurationSet: 'AUTH_KIT_MAIL_CONFIGURATION_SET',
      recipientGroups: 'AUTH_KIT_RECIPIENT_GROUPS',
    });
    expect(accessRequestDigestConfig(ENV)).toEqual({
      userPoolId: POOL_ID,
      requestTable: 'site-data-AccessRequestTable-EXAMPLE',
      siteName: 'Example Reports',
      family: 'unc',
      signInUrl: 'https://reports.example.org/sign-in',
      peopleUrl: PEOPLE_URL,
      helpEmail: 'help@example.org',
      mailFrom: 'Example Reports (UNC) <sign-in@example.org>',
    });
    expect(
      accessRequestDigestConfig({
        ...ENV,
        AUTH_KIT_FAMILY: undefined,
        AUTH_KIT_SETTINGS_TABLE: 'site-data-SiteSettingsTable-EXAMPLE',
        AUTH_KIT_MAIL_CONFIGURATION_SET: 'auth',
        AUTH_KIT_RECIPIENT_GROUPS: ' owner, editors ,, ',
        AUTH_KIT_SITE_NAME: '  Example Reports  ',
      }),
    ).toMatchObject({ family: 'personal', settingsTable: 'site-data-SiteSettingsTable-EXAMPLE', mailConfigurationSet: 'auth', recipientGroups: ['owner', 'editors'], siteName: 'Example Reports' });
    expect(accessRequestDigestConfig({ ...ENV, AUTH_KIT_RECIPIENT_GROUPS: ' , ' })).not.toHaveProperty('recipientGroups');
  });

  it('names every problem with the environment at once', () => {
    expect(() =>
      accessRequestDigestConfig({
        AUTH_KIT_USER_POOL_ID: 'not-a-pool',
        AUTH_KIT_REQUEST_TABLE: 'x',
        AUTH_KIT_SETTINGS_TABLE: 'bad table',
        AUTH_KIT_SITE_NAME: ' ',
        AUTH_KIT_FAMILY: 'acme',
        AUTH_KIT_SIGN_IN_URL: 'http://reports.example.org/sign-in',
        AUTH_KIT_HELP_EMAIL: 'help',
        AUTH_KIT_MAIL_FROM: 'Example Reports',
      }),
    ).toThrow(
      /^auth-kit access-request digest: AUTH_KIT_USER_POOL_ID .*; AUTH_KIT_REQUEST_TABLE .*; AUTH_KIT_SETTINGS_TABLE .*; AUTH_KIT_SITE_NAME is required; AUTH_KIT_FAMILY must be osbm, unc, or personal; AUTH_KIT_SIGN_IN_URL must be an https URL; AUTH_KIT_PEOPLE_URL must be an https URL; AUTH_KIT_HELP_EMAIL .*; AUTH_KIT_MAIL_FROM /,
    );
    expect(() => accessRequestDigestConfig({ ...ENV, AUTH_KIT_MAIL_FROM: 'Example <a@example.org>\r\nBcc: x@example.org' })).toThrow(/AUTH_KIT_MAIL_FROM must be a sender address/);
  });

  it('a bad environment fails the invocation, not the import', async () => {
    const handler = createAccessRequestDigestHandler({ env: {}, log: () => {} });
    await expect(handler()).rejects.toThrow(/AUTH_KIT_USER_POOL_ID/);
  });

  function handlerWith(env: Record<string, string | undefined>, result: Promise<AccessRequestDigestResult> = Promise.resolve({ pending: 2, sent: true, recipients: 3, purged: 1 })) {
    const lines: string[] = [];
    const createDigest = vi.fn((_options: AccessRequestDigestOptions) => () => result);
    return { handler: createAccessRequestDigestHandler({ env, createDigest, log: (l) => lines.push(l) }), lines, createDigest };
  }

  it('builds the digest once from the environment, and logs one line of counts', async () => {
    const { handler, lines, createDigest } = handlerWith({ ...ENV, AUTH_KIT_RECIPIENT_GROUPS: 'owner,editors' });
    expect(await handler()).toEqual({ event: 'auth-kit.access-request-digest', pending: 2, sent: true, recipients: 3, purged: 1 });
    await handler();
    expect(createDigest).toHaveBeenCalledTimes(1);
    const options = createDigest.mock.calls[0]![0];
    expect(options).toMatchObject({
      userPoolId: POOL_ID,
      peopleUrl: PEOPLE_URL,
      recipientGroups: ['owner', 'editors'],
      site: { siteName: 'Example Reports', theme: 'unc', signInUrl: 'https://reports.example.org/sign-in', help: 'help@example.org' },
    });
    expect(options.requests).toEqual(expect.objectContaining({ purge: expect.any(Function), list: expect.any(Function) }));
    expect(options.mailer).toEqual(expect.objectContaining({ sendEmail: expect.any(Function) }));
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ event: 'auth-kit.access-request-digest', pending: 2, sent: true, recipients: 3, purged: 1 });
    expect(lines[0]).not.toMatch(/@/);
  });

  it('with a settings table, the help address comes from createSignInHelp over it (configured as the fallback)', async () => {
    const { handler, createDigest } = handlerWith({ ...ENV, AUTH_KIT_SETTINGS_TABLE: 'site-data-SiteSettingsTable-EXAMPLE' });
    await handler();
    const help = createDigest.mock.calls[0]![0].site.help;
    expect(typeof help).toBe('object');
    expect(help).toMatchObject({ configured: 'help@example.org', effective: expect.any(Function), store: expect.objectContaining({ get: expect.any(Function) }) });
  });

  it('a failed run throws, so the alarm fires', async () => {
    const { handler, lines } = handlerWith(ENV, Promise.reject(new Error('SES refused')));
    await expect(handler()).rejects.toThrow('SES refused');
    expect(lines).toEqual([]);
  });

  it('end to end: the handler’s own options, with the fake pool, a memory queue, and a recording mailer swapped in', async () => {
    const pool = fakeUserPool();
    seedAdmins(pool);
    const store = createMemoryAccessRequestStore();
    await store.create({ email: 'nia@example.com', name: 'Nia', now: new Date(NOW - DAY) });
    const { mailer, sent } = recordingMailer();
    const handler = createAccessRequestDigestHandler({
      env: ENV,
      createDigest: (options) => createAccessRequestDigest({ ...options, requests: store, mailer, cognito: pool.client, now: () => NOW, sleep: noSleep }),
      log: () => {},
    });
    expect(await handler()).toEqual({ event: 'auth-kit.access-request-digest', pending: 1, sent: true, recipients: 4, purged: 0 });
    expect(sent[0]!.replyTo).toEqual(['help@example.org']);
    expect(sent[0]!.email.subject).toBe('Nia asked for access to Example Reports');
    expect(sent[0]!.email.text).toContain(PEOPLE_URL);
  });
});
