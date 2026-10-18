import { AdminCreateUserCommand, type AdminCreateUserCommandInput } from '@aws-sdk/client-cognito-identity-provider';
import { describe, expect, it } from 'vitest';
import { createInviteExpirySweep, createMemoryAuditLog, createPeopleActions, PEOPLE_FORM_FIELDS } from '../../src/admin/index.js';
import { OWNER_GROUP } from '../../src/shared/policy.js';
import { awsError, DAY, fakeUserPool, NOW, setup } from './people-fixture.js';

const OWNER = { sub: 'owner-1', groups: ['owner'] };
const ADMIN = { sub: 'admin-1', groups: ['admin-content-people'] };
const EDITOR = { sub: 'editor-1', groups: ['admin-content'] };
const SUPER = { sub: 'super-1', groups: ['superadmin'] };
const MEMBER = { sub: 'member-1', groups: [] as string[] };

/** The audit intent comes before every Cognito write, and the result after the last one. */
function expectAuditedWrites(timeline: string[]) {
  const firstWrite = timeline.findIndex((t) => /^cognito:Admin(?!ListGroups)|^mail:/.test(t));
  const lastWrite = timeline.length - 1 - [...timeline].reverse().findIndex((t) => /^cognito:Admin(?!ListGroups)|^mail:/.test(t));
  const intent = timeline.indexOf('audit:intent');
  const result = timeline.lastIndexOf('audit:result');
  expect(intent).toBeGreaterThanOrEqual(0);
  expect(intent).toBeLessThan(firstWrite);
  expect(result).toBeGreaterThan(lastWrite);
}

describe('listPeople', () => {
  it('joins a paginated ListUsers snapshot with ListUsersInGroup, without per-person reads', async () => {
    const t = setup({ actor: ADMIN, pool: { pageSize: 2 } });
    t.pool.add({ sub: 'v-1', email: 'vera@example.org', name: 'Vera' }, 'admin-view', 'reviewer');
    t.pool.add({ sub: 'e-1', email: 'eli@example.org' }, 'admin-content');
    t.pool.add({ sub: 'i-1', email: 'ivy@example.org', emailVerified: false, createdAt: new Date(NOW - 6 * DAY) }, 'admin-view');
    t.pool.add({ sub: 'm-1', email: 'mo@example.org', enabled: false });
    const list = await t.people.listPeople();
    if (list.state !== 'ok') throw new Error(list.reason);
    expect(list.people.map((p) => p.sub)).toEqual(['admin-1', 'e-1', 'i-1', 'v-1', 'm-1']);
    expect(list.people.find((p) => p.sub === 'v-1')).toMatchObject({ adminRole: 'admin-view', groups: ['admin-view', 'reviewer'], name: 'Vera' });
    expect(list.people.find((p) => p.sub === 'i-1')!.invite).toEqual({ status: 'expiring-soon', expiresAt: new Date(NOW + DAY).toISOString() });
    expect(list.people.find((p) => p.sub === 'v-1')!.lastSignInAt).toBeUndefined();
    expect(list).toMatchObject({ truncated: false, inviteMode: 'emailed-code', fetchedAt: new Date(NOW).toISOString() });
    const calls = t.timeline.filter((x) => x.startsWith('cognito:'));
    expect(calls.filter((c) => c === 'cognito:ListUsers')).toHaveLength(3); // 5 people, 2 a page
    expect(calls).not.toContain('cognito:AdminListGroupsForUser');
    expect(calls).not.toContain('cognito:AdminGetUser');
  });

  it('says it stopped at maxPeople instead of implying everyone', async () => {
    const t = setup({ actor: ADMIN, config: { maxPeople: 2 } });
    t.pool.add({ sub: 'a', email: 'a@example.org' });
    t.pool.add({ sub: 'b', email: 'b@example.org' });
    const list = await t.people.listPeople();
    expect(list).toMatchObject({ state: 'ok', truncated: true });
  });

  it('fails honestly: a throttled or forbidden list is "—" and a reason, never zero people', async () => {
    const t = setup({ actor: ADMIN });
    t.pool.failOn('ListUsersCommand', awsError('TooManyRequestsException'), 10);
    const throttled = await t.people.listPeople();
    expect(throttled.state).toBe('unavailable');
    expect(throttled.state === 'unavailable' && throttled.reason).toMatch(/quota.*isn't a count of zero/s);

    const m = setup({ actor: MEMBER });
    expect(await m.people.listPeople()).toEqual({ state: 'unavailable', reason: "You don't have permission to do that." });
  });

  it('lets view-only and content-only admins see the list (they change nothing)', async () => {
    for (const actor of [{ sub: 'view-1', groups: ['admin-view'] }, EDITOR]) {
      const t = setup({ actor });
      t.pool.add({ sub: 'v-1', email: 'v@example.org' }, 'admin-view');
      expect(await t.people.listPeople()).toMatchObject({ state: 'ok' });
      expect(await t.people.disable({ sub: 'v-1' })).toMatchObject({ ok: false, code: 'forbidden' });
    }
  });
});

describe('invite', () => {
  it('creates a no-password, unverified account, adds the role, emails it, and logs it around the calls', async () => {
    const t = setup({ actor: ADMIN });
    const result = await t.people.invite({ email: '  Alice@Example.org ', role: 'admin-content', name: 'Alice' });
    expect(result).toMatchObject({ ok: true, subject: { email: 'alice@example.org' } });
    const [create] = t.pool.inputsOf<AdminCreateUserCommandInput>(AdminCreateUserCommand);
    expect(create).toMatchObject({ Username: 'alice@example.org', MessageAction: 'SUPPRESS', DesiredDeliveryMediums: ['EMAIL'] });
    expect(create!.TemporaryPassword).toBeUndefined();
    expect(create!.UserAttributes).toEqual([
      { Name: 'email', Value: 'alice@example.org' },
      { Name: 'name', Value: 'Alice' },
    ]);
    const alice = t.pool.users.find((u) => u.email === 'alice@example.org')!;
    expect(alice).toMatchObject({ emailVerified: false, status: 'CONFIRMED' });
    expect([...alice.groups]).toEqual(['admin-content']);
    expect(t.sent[0]).toMatchObject({ email: 'alice@example.org', siteName: 'Example Reports', expiresAt: new Date(NOW + 7 * DAY) });
    expect(t.timeline.filter((x) => !x.startsWith('cognito:List') && x !== 'cognito:AdminListGroupsForUser')).toEqual([
      'audit:intent',
      'cognito:AdminCreateUser',
      'cognito:AdminAddUserToGroup',
      'mail:sendInvite',
      'audit:result',
    ]);
    const [intent, row] = t.auditLog.rows;
    expect(intent).toMatchObject({ phase: 'intent', action: 'people.invite', target: { email: 'alice@example.org' }, context: { ip: '203.0.113.24' } });
    expect(row).toMatchObject({
      phase: 'result',
      outcome: 'ok',
      target: { sub: alice.sub, email: 'alice@example.org' },
      after: { role: 'admin-content', invitedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 7 * DAY).toISOString() },
      calls: ['AdminCreateUser: ok', 'AdminAddUserToGroup admin-content: ok', 'SES SendEmail: ok'],
      requestId: 'req-test',
    });
    expect(t.changes).toHaveLength(1);
  });

  it('a role grant needs a recent sign-in; nothing is written without one', async () => {
    const t = setup({ actor: { ...ADMIN, authTimeAgoSeconds: 3600 } });
    expect(await t.people.invite({ email: 'a@example.org', role: 'admin-content' })).toMatchObject({ ok: false, code: 'step_up_required', maxAgeSeconds: 300 });
    expect(t.pool.writes()).toEqual([]);
    expect(t.auditLog.rows).toEqual([]);
    // A member invite grants nothing, so it doesn't need one.
    expect(await t.people.invite({ email: 'b@example.org', role: 'member' })).toMatchObject({ ok: true });
  });

  it('admins grant only below their own level; refusals are logged and change nothing', async () => {
    const t = setup({ actor: ADMIN });
    for (const role of ['admin-content-people', 'superadmin']) {
      expect(await t.people.invite({ email: `${role}@example.org`, role, reason: 'needed' })).toMatchObject({ ok: false, code: 'refused', guardrail: 'rank' });
    }
    expect(t.pool.writes()).toEqual([]);
    expect(t.auditLog.rows.map((r) => r.phase)).toEqual(['refused', 'refused']);
    expect(t.auditLog.rows[0]).toMatchObject({ action: 'people.invite', error: expect.stringMatching(/^rank: /) as string });
  });

  it('refuses unknown role spellings, duplicates, and admin invites without a reason', async () => {
    const t = setup({ actor: OWNER });
    for (const role of ['Admin', 'Owner', ' admin-content', 'root', 'admin', 'editor', 'viewer']) {
      expect(await t.people.invite({ email: 'x@example.org', role })).toMatchObject({ ok: false, code: 'invalid' });
    }
    // The owner role is never granted by invite, not even by the owner: logged, nothing created.
    expect(await t.people.invite({ email: 'co-owner@example.org', role: 'owner', reason: 'Co-founder' })).toMatchObject({
      ok: false,
      code: 'refused',
      guardrail: 'owner_transfer',
    });
    expect(t.pool.writes()).toEqual([]);
    expect(t.auditLog.rows.at(-1)).toMatchObject({ phase: 'refused', error: expect.stringMatching(/^owner_transfer: /) as string });
    t.pool.add({ sub: 'x-1', email: 'taken@example.org' });
    expect(await t.people.invite({ email: 'taken@example.org', role: 'admin-view' })).toMatchObject({
      ok: false,
      code: 'refused',
      guardrail: 'exists',
      error: 'That address already has an account. Resend never resets an existing account.',
    });
    expect(await t.people.invite({ email: 'new@example.org', role: 'admin-content-people' })).toMatchObject({ ok: false, guardrail: 'reason_required' });
    expect(await t.people.invite({ email: 'new@example.org', role: 'admin-content-people', reason: 'Runs the newsletter' })).toMatchObject({ ok: true });
    expect(await t.people.invite({ email: 'rev@example.org', role: 'reviewer' })).toMatchObject({ ok: true });
  });

  it('asks before inviting outside the usual domains', async () => {
    const t = setup({ actor: ADMIN, config: { inviteDomains: ['example.org'] } });
    expect(await t.people.invite({ email: 'alice@exmaple.org', role: 'admin-view' })).toMatchObject({ ok: false, guardrail: 'domain' });
    expect(t.pool.writes()).toEqual([]);
    expect(await t.people.invite({ email: 'alice@exmaple.org', role: 'admin-view', confirmOutsideDomain: true })).toMatchObject({ ok: true });
  });

  it('rolls back a half-made invite when the role can’t be added', async () => {
    const t = setup({ actor: ADMIN });
    t.pool.failOn('AdminAddUserToGroupCommand', awsError('ResourceNotFoundException', 'Group not found'));
    const result = await t.people.invite({ email: 'a@example.org', role: 'admin-content' });
    expect(result).toMatchObject({ ok: false, code: 'failed', changed: 'nothing' });
    expect(t.pool.users.find((u) => u.email === 'a@example.org')).toBeUndefined();
    expect(t.sent).toEqual([]);
    expect(t.auditLog.rows.at(-1)).toMatchObject({
      outcome: 'failed',
      calls: ['AdminCreateUser: ok', 'AdminAddUserToGroup admin-content: failed (ResourceNotFoundException)', 'AdminDeleteUser (rollback): ok'],
    });
  });

  it('says plainly when the account exists but the email didn’t send', async () => {
    const t = setup({ actor: ADMIN });
    t.failMail();
    const result = await t.people.invite({ email: 'a@example.org', role: 'admin-content' });
    expect(result).toMatchObject({ ok: false, code: 'failed', changed: 'partly' });
    expect(result.ok === false && result.error).toMatch(/created as Admin . content only, but the invite email didn't send.*Resend/);
    expect(t.auditLog.rows.at(-1)).toMatchObject({ outcome: 'partial' });
    expect(t.changes).toHaveLength(1); // a partial change still alerts
  });

  it('refuses to leave a password-holding account behind in a pool without emailed codes', async () => {
    const t = setup({ actor: ADMIN, pool: { passwordless: false } });
    const result = await t.people.invite({ email: 'a@example.org', role: 'admin-view' });
    expect(result).toMatchObject({ ok: false, code: 'failed', changed: 'nothing' });
    expect(result.ok === false && result.error).toMatch(/temporary-password/);
    expect(t.pool.users.find((u) => u.email === 'a@example.org')).toBeUndefined();
  });

  it('changes nothing when the audit intent can’t be written', async () => {
    const t = setup({ actor: ADMIN });
    t.auditLog.failNextAppends(1);
    expect(await t.people.invite({ email: 'a@example.org', role: 'admin-view' })).toMatchObject({ ok: false, code: 'audit_unavailable', changed: 'nothing' });
    expect(t.pool.writes()).toEqual([]);
    expect(t.sent).toEqual([]);
    expect(t.errors).toContain('audit: intent write failed');
  });

  it('reports a change whose result row couldn’t be written as done-but-unrecorded', async () => {
    const t = setup({ actor: ADMIN });
    t.pool.add({ sub: 'v-1', email: 'v@example.org' }, 'admin-view');
    // Intent lands; the three result attempts fail.
    const original = t.auditLog.append.bind(t.auditLog);
    let calls = 0;
    t.auditLog.append = (e) => (++calls > 1 ? Promise.reject(new Error('DynamoDB down')) : original(e));
    const result = await t.people.signOutEverywhere({ sub: 'v-1' });
    expect(result).toMatchObject({ ok: false, code: 'audit_incomplete', changed: 'yes' });
    expect(result.ok === false && result.error).toMatch(/signed out everywhere.*outcome not recorded/s);
    expect(calls).toBe(4);
  });

  it('temporary-password mode lets Cognito send the one-time password, and resends with RESEND', async () => {
    const t = setup({ actor: ADMIN, pool: { passwordless: false }, config: { inviteMode: 'temporary-password', mailer: undefined } });
    expect(await t.people.invite({ email: 'a@example.org', role: 'admin-content' })).toMatchObject({ ok: true });
    const [create] = t.pool.inputsOf<AdminCreateUserCommandInput>(AdminCreateUserCommand);
    expect(create!.MessageAction).toBeUndefined();
    expect(create!.TemporaryPassword).toBeUndefined();
    const a = t.pool.users.find((u) => u.email === 'a@example.org')!;
    expect(a.status).toBe('FORCE_CHANGE_PASSWORD');
    expect(await t.people.resend({ sub: a.sub })).toMatchObject({ ok: true });
    expect(t.pool.inputsOf<AdminCreateUserCommandInput>(AdminCreateUserCommand)[1]).toMatchObject({ MessageAction: 'RESEND', Username: a.username });
    a.status = 'CONFIRMED';
    expect(await t.people.resend({ sub: a.sub })).toMatchObject({ ok: false, guardrail: 'state' });
  });

  it('requires a mailer in emailed-code mode and an https sign-in URL', () => {
    const t = setup();
    const base = { auth: t.h.auth, auditLog: createMemoryAuditLog(), siteName: 'X', signInUrl: 'https://x.example.org/sign-in' };
    expect(() => createPeopleActions(base)).toThrow(/mailer/);
    expect(() => createPeopleActions({ ...base, inviteMode: 'temporary-password', signInUrl: 'http://x.example.org' })).toThrow(/https/);
    expect(() => createPeopleActions({ ...base, inviteMode: 'temporary-password', signInUrl: 'http://app.localhost:3000/sign-in' })).not.toThrow();
  });
});

describe('resend', () => {
  it('emails an unused invite again and touches nothing in Cognito', async () => {
    const t = setup({ actor: ADMIN });
    t.pool.add({ sub: 'i-1', email: 'ivy@example.org', emailVerified: false, createdAt: new Date(NOW - 2 * DAY) }, 'admin-view');
    expect(await t.people.resend({ sub: 'i-1' })).toMatchObject({ ok: true, message: expect.stringMatching(/Nothing about their account changed/) as string });
    expect(t.pool.writes()).toEqual([]);
    expect(t.sent[0]!.expiresAt).toEqual(new Date(NOW + 5 * DAY)); // the expiry never moves
    expectAuditedWrites(t.timeline);
  });

  it('never resends to an active account (the re-invite that reset an admin’s sign-in)', async () => {
    const t = setup({ actor: OWNER });
    t.pool.add({ sub: 'a-2', email: 'grace@example.org' }, 'admin-content-people');
    expect(await t.people.resend({ sub: 'a-2' })).toMatchObject({
      ok: false,
      guardrail: 'state',
      error: 'Resend is only for invites nobody has used. It never changes an active account.',
    });
    expect(t.sent).toEqual([]);
  });
});

describe('changeRole', () => {
  it('removes the old role before adding the new one, records the reason, before and after', async () => {
    const t = setup({ actor: ADMIN });
    t.pool.add({ sub: 'v-1', email: 'v@example.org' }, 'admin-view', 'reviewer');
    expect(await t.people.changeRole({ sub: 'v-1', toRole: 'admin-content', fromRole: 'admin-view', reason: 'Took over the newsletter' })).toMatchObject({
      ok: true,
      message: expect.stringMatching(/now Admin . content only\. Takes effect at their next refresh, within 60 minutes/) as string,
    });
    expect(t.pool.writes()).toEqual(['AdminRemoveUserFromGroupCommand', 'AdminAddUserToGroupCommand']);
    expect([...t.pool.get('v-1')!.groups].sort()).toEqual(['admin-content', 'reviewer']);
    expect(t.auditLog.rows.at(-1)).toMatchObject({
      outcome: 'ok',
      reason: 'Took over the newsletter',
      before: { adminRole: 'admin-view', groups: ['admin-view', 'reviewer'] },
      after: { adminRole: 'admin-content', groups: ['admin-content', 'reviewer'] },
    });
    expectAuditedWrites(t.timeline);
  });

  it('promotions need a recent sign-in; demotions don’t', async () => {
    const t = setup({ actor: { ...ADMIN, authTimeAgoSeconds: 900 } });
    t.pool.add({ sub: 'v-1', email: 'v@example.org' }, 'admin-view');
    t.pool.add({ sub: 'e-1', email: 'e@example.org' }, 'admin-content');
    expect(await t.people.changeRole({ sub: 'v-1', toRole: 'admin-content', reason: 'promote' })).toMatchObject({ code: 'step_up_required' });
    expect(await t.people.changeRole({ sub: 'e-1', toRole: 'admin-view', reason: 'demote' })).toMatchObject({ ok: true });
  });

  it('enforces rank, self, reason, and the last owner, and logs each refusal', async () => {
    const t = setup({ actor: ADMIN });
    t.pool.add({ sub: 'a-2', email: 'grace@example.org' }, 'admin-content-people');
    t.pool.add({ sub: 'e-1', email: 'e@example.org' }, 'admin-content');
    expect(await t.people.changeRole({ sub: 'a-2', toRole: 'admin-view', reason: 'demote' })).toMatchObject({ guardrail: 'rank' });
    expect(await t.people.changeRole({ sub: 'e-1', toRole: 'admin-content-people', reason: 'promote' })).toMatchObject({ guardrail: 'rank' });
    expect(await t.people.changeRole({ sub: 'admin-1', toRole: 'admin-content', reason: 'me' })).toMatchObject({ guardrail: 'self' });
    expect(await t.people.changeRole({ sub: 'e-1', toRole: 'admin-view', reason: '' })).toMatchObject({ guardrail: 'reason_required' });
    expect(t.pool.writes()).toEqual([]);
    expect(t.auditLog.rows.every((r) => r.phase === 'refused')).toBe(true);
    expect(t.auditLog.rows).toHaveLength(4);

  });

  it('nobody demotes the owner, and nobody grants the owner role', async () => {
    const s = setup({ actor: SUPER });
    s.pool.add({ sub: 'owner-1', email: 'owner-1@example.org' }, 'owner');
    s.pool.add({ sub: 'a-2', email: 'grace@example.org' }, 'admin-content-people');
    expect(await s.people.changeRole({ sub: 'owner-1', toRole: 'admin-view', reason: 'take over' })).toMatchObject({ guardrail: 'last_owner' });
    expect(await s.people.changeRole({ sub: 'a-2', toRole: 'owner', reason: 'take over' })).toMatchObject({ guardrail: 'owner_transfer' });

    const o = setup({ actor: OWNER });
    o.pool.add({ sub: 'a-2', email: 'grace@example.org' }, 'admin-content-people');
    expect(await o.people.changeRole({ sub: 'a-2', toRole: 'owner', reason: 'co-owner' })).toMatchObject({ guardrail: 'owner_transfer' });
    for (const x of [s, o]) expect(x.pool.writes()).toEqual([]);
  });

  it('an owner may demote an extra owner only while the live count says there are two or more', async () => {
    const o = setup({ actor: OWNER });
    o.pool.add({ sub: 'owner-2', email: 'priya@example.org' }, 'owner');
    o.pool.get('owner-1')!.groups.delete('owner'); // Cognito now says only owner-2 is an owner
    expect(await o.people.changeRole({ sub: 'owner-2', toRole: 'superadmin', fromRole: 'owner', reason: 'one owner' })).toMatchObject({
      guardrail: 'last_owner',
    });
    o.pool.get('owner-1')!.groups.add('owner');
    expect(await o.people.changeRole({ sub: 'owner-2', toRole: 'superadmin', fromRole: 'owner', reason: 'one owner' })).toMatchObject({ ok: true });
    expect([...o.pool.get('owner-2')!.groups]).toEqual(['superadmin']);
  });

  it('fails closed when the owner count can’t be read', async () => {
    const t = setup({ actor: OWNER });
    t.pool.add({ sub: 'owner-2', email: 'priya@example.org' }, 'owner');
    t.pool.failOn('ListUsersInGroupCommand', awsError('AccessDeniedException'), 1);
    expect(await t.people.changeRole({ sub: 'owner-2', toRole: 'superadmin', reason: 'one owner' })).toMatchObject({ guardrail: 'owner_count_unknown' });
    expect(t.pool.writes()).toEqual([]);
  });

  it('refuses stale pages, no-op changes, and unknown role names', async () => {
    const t = setup({ actor: OWNER });
    t.pool.add({ sub: 'e-1', email: 'e@example.org' }, 'admin-content');
    expect(await t.people.changeRole({ sub: 'e-1', toRole: 'admin-view', fromRole: 'admin-content-people', reason: 'x y z' })).toMatchObject({ code: 'stale' });
    expect(await t.people.changeRole({ sub: 'e-1', toRole: 'admin-content', reason: 'x y z' })).toMatchObject({ guardrail: 'state' });
    for (const toRole of ['Owner', 'superAdmin', 'reviewer', ' admin']) {
      expect(await t.people.changeRole({ sub: 'e-1', toRole: toRole as never, reason: 'x y z' })).toMatchObject({ code: 'invalid' });
    }
    expect(await t.people.changeRole({ sub: 'e-1', toRole: 'member', reason: 'left the team' })).toMatchObject({ ok: true });
    expect([...t.pool.get('e-1')!.groups]).toEqual([]);
  });

  it('a failure halfway leaves less access, never more, and says so', async () => {
    const t = setup({ actor: OWNER });
    t.pool.add({ sub: 'e-1', email: 'e@example.org' }, 'admin-content');
    t.pool.failOn('AdminAddUserToGroupCommand', awsError('InternalErrorException'));
    const result = await t.people.changeRole({ sub: 'e-1', toRole: 'admin-content-people', reason: 'promote' });
    expect(result).toMatchObject({ ok: false, code: 'failed', changed: 'partly' });
    expect([...t.pool.get('e-1')!.groups]).toEqual([]);
    expect(t.auditLog.rows.at(-1)).toMatchObject({ outcome: 'partial' });
  });
});

describe('Super admin grants: only the owner, with a fresh sign-in and an alert to the owner', () => {
  function withOwnerAndAdmin(actor: { sub: string; groups: string[]; authTimeAgoSeconds?: number } = OWNER) {
    const t = setup({ actor });
    t.pool.add({ sub: 'a-2', email: 'grace@example.org', name: 'Grace' }, 'admin-content-people');
    return t;
  }

  it('is refused without a recent sign-in, before anything changes', async () => {
    const t = withOwnerAndAdmin({ ...OWNER, authTimeAgoSeconds: 900 });
    expect(await t.people.changeRole({ sub: 'a-2', toRole: 'superadmin', reason: 'Deputy' })).toMatchObject({
      ok: false,
      code: 'step_up_required',
      maxAgeSeconds: 300,
    });
    expect(t.pool.writes()).toEqual([]);
    expect(t.grantAlerts).toEqual([]);
    expect(t.auditLog.rows).toEqual([]);
  });

  it('with a fresh sign-in: grants, alerts the owner, and records the alert', async () => {
    const t = withOwnerAndAdmin();
    t.pool.add({ sub: 'owner-x', email: 'gone@example.org', enabled: false }, 'owner');
    const result = await t.people.changeRole({ sub: 'a-2', toRole: 'superadmin', fromRole: 'admin-content-people', reason: 'Deputy' });
    expect(result).toMatchObject({ ok: true, message: expect.stringMatching(/now Super admin\..*The owner was alerted\./) as string });
    expect([...t.pool.get('a-2')!.groups]).toEqual(['superadmin']);
    expect(t.grantAlerts).toHaveLength(1);
    const alert = t.grantAlerts[0]!;
    expect(alert.owners.map((o) => o.email)).toEqual(['owner-1@example.org']);
    expect(alert).toMatchObject({
      siteName: 'Example Reports',
      via: 'changeRole',
      reason: 'Deputy',
      grantedTo: { sub: 'a-2', email: 'grace@example.org', name: 'Grace' },
      grantedBy: { sub: 'owner-1' },
      context: { ip: '203.0.113.24', requestId: 'req-test' },
    });
    expect(t.timeline.filter((x) => x.startsWith('audit:') || x.startsWith('mail:') || /Admin(Add|Remove)/.test(x))).toEqual([
      'audit:intent',
      'cognito:AdminRemoveUserFromGroup',
      'cognito:AdminAddUserToGroup',
      'mail:superadminGranted',
      'audit:result',
    ]);
    const row = t.auditLog.rows.at(-1)!;
    expect(row).toMatchObject({ outcome: 'ok', after: { adminRole: 'superadmin', ownerAlert: { sentTo: ['owner-1@example.org'] } } });
    expect(row.calls).toContain('Super admin alert (to the owner): ok');
    expect(t.changes).toHaveLength(1);
  });

  it('undoes the grant when the alert can’t be sent', async () => {
    const t = withOwnerAndAdmin();
    t.failOwnerAlert();
    const result = await t.people.changeRole({ sub: 'a-2', toRole: 'superadmin', reason: 'Deputy' });
    expect(result).toMatchObject({ ok: false, code: 'failed', changed: 'nothing', error: expect.stringMatching(/Super admin grant was undone/) as string });
    expect([...t.pool.get('a-2')!.groups]).toEqual(['admin-content-people']);
    expect(t.auditLog.rows.at(-1)).toMatchObject({
      outcome: 'failed',
      calls: [
        'AdminRemoveUserFromGroup admin-content-people: ok',
        'AdminAddUserToGroup superadmin: ok',
        'Super admin alert (to the owner): failed (MessageRejected)',
        'AdminRemoveUserFromGroup superadmin (rollback): ok',
        'AdminAddUserToGroup admin-content-people (rollback): ok',
      ],
    });
  });

  it('says so when undoing the grant fails too', async () => {
    const t = withOwnerAndAdmin();
    t.failOwnerAlert();
    t.pool.failOnCall('AdminRemoveUserFromGroupCommand', 2, awsError('AccessDeniedException')); // the rollback's removal
    const result = await t.people.changeRole({ sub: 'a-2', toRole: 'superadmin', reason: 'Deputy' });
    expect(result).toMatchObject({ ok: false, code: 'failed', changed: 'partly', error: expect.stringMatching(/undoing the Super admin grant failed too/) as string });
    expect(t.auditLog.rows.at(-1)).toMatchObject({ outcome: 'partial' });
  });

  it('is refused when no owner alert is configured', async () => {
    const t = setup({ actor: OWNER, pool: { passwordless: false }, config: { inviteMode: 'temporary-password', mailer: undefined } });
    t.pool.add({ sub: 'a-2', email: 'grace@example.org' }, 'admin-content-people');
    expect(await t.people.changeRole({ sub: 'a-2', toRole: 'superadmin', reason: 'Deputy' })).toMatchObject({
      ok: false,
      code: 'refused',
      guardrail: 'owner_alert_unavailable',
    });
    expect(t.pool.writes()).toEqual([]);
    expect(t.auditLog.rows).toMatchObject([{ phase: 'refused', error: expect.stringMatching(/^owner_alert_unavailable/) as string }]);

    const alerts: string[] = [];
    const u = setup({
      actor: OWNER,
      pool: { passwordless: false },
      config: { inviteMode: 'temporary-password', mailer: undefined, ownerAlerts: { superadminGranted: (a) => (alerts.push(a.grantedTo.email), Promise.resolve()) } },
    });
    u.pool.add({ sub: 'a-2', email: 'grace@example.org' }, 'admin-content-people');
    expect(await u.people.changeRole({ sub: 'a-2', toRole: 'superadmin', reason: 'Deputy' })).toMatchObject({ ok: true });
    expect(alerts).toEqual(['grace@example.org']);
  });

  it('Super admins and people admins can’t grant Super admin', async () => {
    for (const actor of [SUPER, ADMIN]) {
      const t = setup({ actor });
      t.pool.add({ sub: 'e-1', email: 'e@example.org' }, 'admin-content');
      expect(await t.people.changeRole({ sub: 'e-1', toRole: 'superadmin', reason: 'promote' })).toMatchObject({ guardrail: 'rank' });
      expect(await t.people.invite({ email: 'super@example.org', role: 'superadmin', reason: 'promote' })).toMatchObject({ guardrail: 'rank' });
      expect(t.grantAlerts).toEqual([]);
      expect(t.pool.writes()).toEqual([]);
    }
  });

  it('inviting someone as Super admin alerts the owner before the invite goes out, and is undone if it can’t', async () => {
    const t = setup({ actor: OWNER });
    expect(await t.people.invite({ email: 'deputy@example.org', role: 'superadmin', reason: 'Deputy' })).toMatchObject({ ok: true });
    expect(t.grantAlerts[0]).toMatchObject({ via: 'invite', grantedTo: { email: 'deputy@example.org' } });
    expect(t.timeline.filter((x) => x.startsWith('mail:'))).toEqual(['mail:superadminGranted', 'mail:sendInvite']);

    t.failOwnerAlert();
    const result = await t.people.invite({ email: 'other@example.org', role: 'superadmin', reason: 'Deputy' });
    expect(result).toMatchObject({ ok: false, changed: 'nothing', error: expect.stringMatching(/Super admin grant was undone/) as string });
    expect(t.pool.users.find((u) => u.email === 'other@example.org')).toBeUndefined();
    expect(t.sent.map((m) => m.email)).toEqual(['deputy@example.org']);

    const stale = setup({ actor: { ...OWNER, authTimeAgoSeconds: 900 } });
    expect(await stale.people.invite({ email: 'x@example.org', role: 'superadmin', reason: 'Deputy' })).toMatchObject({ code: 'step_up_required' });
  });
});

describe('transfer ownership', () => {
  /** Every group change, in order: [command, username, group]. */
  const groupWrites = (pool: ReturnType<typeof fakeUserPool>) =>
    pool.mock
      .calls()
      .map((c) => c.args[0] as { constructor: { name: string }; input: { Username?: string; GroupName?: string } })
      .filter((c) => /UserToGroup|UserFromGroup/.test(c.constructor.name))
      .map((c) => [c.constructor.name.replace(/Command$/, ''), c.input.Username, c.input.GroupName]);

  function withSuccessor(actor: { sub: string; groups: string[]; authTimeAgoSeconds?: number } = OWNER) {
    const t = setup({ actor });
    t.pool.add({ sub: 's-2', email: 'grace@example.org', name: 'Grace' }, 'superadmin', 'reviewer');
    return t;
  }
  const transfer = (t: ReturnType<typeof setup>, extra: Record<string, unknown> = {}) =>
    t.people.transferOwnership({ sub: 's-2', reason: 'Handing the site over', confirmEmail: 'Grace@Example.org', ...extra });

  it('adds the new owner before removing the old one, makes the old owner Super admin, emails both, and logs it', async () => {
    const t = withSuccessor();
    const result = await transfer(t);
    expect(result).toMatchObject({ ok: true, message: expect.stringMatching(/Grace is now the owner, and you're a Super admin\. You were both emailed\./) as string });
    expect([...t.pool.get('s-2')!.groups].sort()).toEqual(['owner', 'reviewer']);
    expect([...t.pool.get('owner-1')!.groups]).toEqual(['superadmin']);
    // Never zero owners: the new owner is added first, the previous owner removed last.
    expect(groupWrites(t.pool)).toEqual([
      ['AdminAddUserToGroup', 's-2', 'owner'],
      ['AdminRemoveUserFromGroup', 's-2', 'superadmin'],
      ['AdminAddUserToGroup', 'owner-1', 'superadmin'],
      ['AdminRemoveUserFromGroup', 'owner-1', 'owner'],
    ]);
    expect(t.transferAlerts).toEqual([
      expect.objectContaining({
        siteName: 'Example Reports',
        previousOwner: { sub: 'owner-1', email: 'owner-1@example.org' },
        newOwner: { sub: 's-2', email: 'grace@example.org', name: 'Grace' },
        reason: 'Handing the site over',
      }),
    ]);
    expectAuditedWrites(t.timeline);
    expect(t.auditLog.rows.at(-1)).toMatchObject({
      action: 'people.transferOwnership',
      outcome: 'ok',
      target: { sub: 's-2', email: 'grace@example.org' },
      reason: 'Handing the site over',
      before: { adminRole: 'superadmin', owner: { sub: 'owner-1' } },
      after: { adminRole: 'owner', groups: ['owner', 'reviewer'], previousOwner: { sub: 'owner-1', adminRole: 'superadmin' } },
      calls: [
        'AdminAddUserToGroup owner (new owner): ok',
        'AdminRemoveUserFromGroup superadmin (new owner): ok',
        'AdminAddUserToGroup superadmin (previous owner): ok',
        'AdminRemoveUserFromGroup owner (previous owner): ok',
        'Ownership alert (previous and new owner): ok',
      ],
    });
    expect(t.changes).toHaveLength(1);
  });

  it('can hand the site to a member with no admin role', async () => {
    const t = setup({ actor: OWNER });
    t.pool.add({ sub: 'm-2', email: 'mo@example.org' });
    expect(await t.people.transferOwnership({ sub: 'm-2', reason: 'New director', confirmEmail: 'mo@example.org' })).toMatchObject({ ok: true });
    expect([...t.pool.get('m-2')!.groups]).toEqual(['owner']);
  });

  it('is the owner’s alone: a Super admin is refused and the attempt logged', async () => {
    const t = setup({ actor: SUPER });
    t.pool.add({ sub: 's-2', email: 'grace@example.org' }, 'admin-content-people');
    expect(await transfer(t)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(t.pool.writes()).toEqual([]);
    expect(t.auditLog.rows).toMatchObject([{ phase: 'refused', action: 'people.transferOwnership', actor: { sub: 'super-1' } }]);
  });

  it('needs a reason, their address typed out, someone who has signed in, and a recent sign-in', async () => {
    const t = withSuccessor();
    expect(await transfer(t, { reason: '' })).toMatchObject({ guardrail: 'reason_required' });
    expect(await transfer(t, { confirmEmail: 'someone@example.org' })).toMatchObject({ guardrail: 'confirm' });
    expect(await t.people.transferOwnership({ sub: 'owner-1', reason: 'x y z', confirmEmail: 'owner-1@example.org' })).toMatchObject({ guardrail: 'self' });
    t.pool.add({ sub: 'i-1', email: 'ivy@example.org', emailVerified: false, createdAt: new Date(NOW - DAY) }, 'superadmin');
    expect(await t.people.transferOwnership({ sub: 'i-1', reason: 'x y z', confirmEmail: 'ivy@example.org' })).toMatchObject({
      guardrail: 'state',
      error: expect.stringMatching(/signed in/) as string,
    });
    t.pool.add({ sub: 'd-1', email: 'dee@example.org', enabled: false });
    expect(await t.people.transferOwnership({ sub: 'd-1', reason: 'x y z', confirmEmail: 'dee@example.org' })).toMatchObject({ guardrail: 'state' });
    expect(t.pool.writes()).toEqual([]);

    const stale = withSuccessor({ ...OWNER, authTimeAgoSeconds: 900 });
    expect(await transfer(stale)).toMatchObject({ code: 'step_up_required' });
    expect(stale.pool.writes()).toEqual([]);
  });

  it('is refused when no ownership alert is configured', async () => {
    const t = setup({ actor: OWNER, pool: { passwordless: false }, config: { inviteMode: 'temporary-password', mailer: undefined } });
    t.pool.add({ sub: 's-2', email: 'grace@example.org' }, 'superadmin');
    expect(await transfer(t)).toMatchObject({ guardrail: 'owner_alert_unavailable' });
    expect(t.pool.writes()).toEqual([]);
  });

  it('undoes the transfer, previous owner first, when the alert can’t be sent', async () => {
    const t = withSuccessor();
    t.failOwnerAlert();
    const result = await transfer(t);
    expect(result).toMatchObject({ ok: false, code: 'failed', changed: 'nothing', error: expect.stringMatching(/ownership transfer was undone/) as string });
    expect([...t.pool.get('owner-1')!.groups]).toEqual(['owner']);
    expect([...t.pool.get('s-2')!.groups].sort()).toEqual(['reviewer', 'superadmin']);
    expect(groupWrites(t.pool).slice(4)).toEqual([
      ['AdminAddUserToGroup', 'owner-1', 'owner'],
      ['AdminRemoveUserFromGroup', 'owner-1', 'superadmin'],
      ['AdminAddUserToGroup', 's-2', 'superadmin'],
      ['AdminRemoveUserFromGroup', 's-2', 'owner'],
    ]);
  });

  it('a failure partway can leave two owners, never none, and says so', async () => {
    const t = withSuccessor();
    t.pool.failOnCall('AdminRemoveUserFromGroupCommand', 2, awsError('InternalErrorException')); // removing the previous owner
    const result = await transfer(t);
    expect(result).toMatchObject({ ok: false, code: 'failed', changed: 'partly', error: expect.stringMatching(/two owners, never none/) as string });
    const owners = t.pool.users.filter((u) => u.groups.has('owner')).map((u) => u.sub).sort();
    expect(owners).toEqual(['owner-1', 's-2']);
    expect(t.transferAlerts).toEqual([]);
  });
});

describe('disable, enable, sign out', () => {
  it('disables first, then removes admin roles and resource memberships, keeping app roles', async () => {
    const removed: string[] = [];
    const t = setup({ actor: ADMIN, config: { removeResourceMemberships: (p) => (removed.push(p.sub), Promise.resolve({ reviews: 2 })) } });
    t.pool.add({ sub: 'e-1', email: 'e@example.org' }, 'admin-content', 'admin-view', 'reviewer');
    expect(await t.people.disable({ sub: 'e-1', reason: 'Left the comms team' })).toMatchObject({ ok: true });
    expect(t.pool.writes()).toEqual(['AdminDisableUserCommand', 'AdminRemoveUserFromGroupCommand', 'AdminRemoveUserFromGroupCommand']);
    expect(t.pool.get('e-1')).toMatchObject({ enabled: false });
    expect([...t.pool.get('e-1')!.groups]).toEqual(['reviewer']);
    expect(removed).toEqual(['e-1']);
    expect(t.auditLog.rows.at(-1)).toMatchObject({ after: { enabled: false, groups: ['reviewer'], resourceMemberships: { reviews: 2 } } });
    expect(t.auditLog.rows.at(-1)?.calls).toContain('App: remove item memberships: ok');
    expectAuditedWrites(t.timeline);
  });

  it('still accepts the old hook name, removeRecordMemberships, for one release', async () => {
    const removed: string[] = [];
    const t = setup({ actor: ADMIN, config: { removeRecordMemberships: (p) => (removed.push(p.sub), Promise.resolve({ reviews: 1 })) } });
    t.pool.add({ sub: 'e-2', email: 'e2@example.org' }, 'reviewer');
    expect(await t.people.disable({ sub: 'e-2' })).toMatchObject({ ok: true });
    expect(removed).toEqual(['e-2']);
    expect(t.auditLog.rows.at(-1)).toMatchObject({ after: { resourceMemberships: { reviews: 1 } } });
  });

  it('refuses two different membership hooks at startup (the old and the new name)', () => {
    const one = () => Promise.resolve(1);
    const two = () => Promise.resolve(2);
    expect(() => setup({ actor: ADMIN, config: { removeResourceMemberships: one, removeRecordMemberships: two } })).toThrow(/removeResourceMemberships only/);
  });

  it('a disable that stops sign-in but fails cleanup is partial, and says sign-in stopped', async () => {
    const t = setup({ actor: ADMIN });
    t.pool.add({ sub: 'e-1', email: 'e@example.org' }, 'admin-content');
    t.pool.failOn('AdminRemoveUserFromGroupCommand', awsError('InternalErrorException'));
    const result = await t.people.disable({ sub: 'e-1' });
    expect(result).toMatchObject({ ok: false, changed: 'partly' });
    expect(result.ok === false && result.error).toMatch(/is disabled \(sign-in and refresh stop now\)/);
  });

  it('nobody disables themselves, the owner, or an already disabled account', async () => {
    const t = setup({ actor: OWNER });
    expect(await t.people.disable({ sub: 'owner-1' })).toMatchObject({ guardrail: 'self' });
    t.pool.add({ sub: 'x', email: 'x@example.org', enabled: false });
    expect(await t.people.disable({ sub: 'x' })).toMatchObject({ guardrail: 'state' });

    const s = setup({ actor: SUPER });
    s.pool.add({ sub: 'owner-1', email: 'owner-1@example.org' }, 'owner');
    expect(await s.people.disable({ sub: 'owner-1' })).toMatchObject({ guardrail: 'last_owner', error: expect.stringMatching(/transfer ownership first/) as string });
    expect(s.pool.writes()).toEqual([]);
  });

  it('revoking an unused invite says so', async () => {
    const t = setup({ actor: ADMIN });
    t.pool.add({ sub: 'i-1', email: 'ivy@example.org', emailVerified: false, createdAt: new Date(NOW - DAY) }, 'admin-view');
    expect(await t.people.disable({ sub: 'i-1' })).toMatchObject({ ok: true, message: expect.stringMatching(/invite for ivy@example.org is revoked/) as string });
  });

  it('re-enables only disabled accounts, and never an expired invite the sweep would undo', async () => {
    const t = setup({ actor: ADMIN });
    t.pool.add({ sub: 'c-1', email: 'carol@example.org', enabled: false });
    t.pool.add({ sub: 'v-1', email: 'v@example.org' });
    t.pool.add({ sub: 's-1', email: 'sam@example.org', enabled: false, emailVerified: false, createdAt: new Date(NOW - 9 * DAY) });
    expect(await t.people.enable({ sub: 'c-1' })).toMatchObject({ ok: true, message: expect.stringMatching(/member only/) as string });
    expect(await t.people.enable({ sub: 'v-1' })).toMatchObject({ guardrail: 'state' });
    expect(await t.people.enable({ sub: 's-1' })).toMatchObject({ guardrail: 'state', error: expect.stringMatching(/expired unused/) as string });
  });

  it('signs out everywhere (yourself included), audited', async () => {
    const t = setup({ actor: ADMIN });
    expect(await t.people.signOutEverywhere({ sub: 'admin-1' })).toMatchObject({ ok: true });
    expect(t.pool.writes()).toEqual(['AdminUserGlobalSignOutCommand']);
    expectAuditedWrites(t.timeline);
  });
});

describe('deleteUser', () => {
  it('is the owner’s and Super admins’ only: a people admin is refused, and the attempt is logged', async () => {
    const t = setup({ actor: ADMIN });
    t.pool.add({ sub: 'x', email: 'x@example.org', enabled: false });
    expect(await t.people.deleteUser({ sub: 'x', reason: 'cleanup', confirmEmail: 'x@example.org' })).toMatchObject({ code: 'forbidden' });
    expect(t.pool.writes()).toEqual([]);
    expect(t.auditLog.rows).toMatchObject([{ phase: 'refused', action: 'people.delete', actor: { sub: 'admin-1' } }]);
  });

  it('needs the account disabled, the retention period over, the address typed, and a recent sign-in', async () => {
    const t = setup({ actor: OWNER });
    t.pool.add({ sub: 'e-1', email: 'eve@example.org' }, 'admin-content');
    const del = () => t.people.deleteUser({ sub: 'e-1', reason: 'Moved agencies', confirmEmail: 'Eve@Example.org' });
    expect(await del()).toMatchObject({ guardrail: 'state', error: 'Disable first. Deleting comes after the retention period.' });

    t.clock.t = NOW - 10 * DAY;
    expect(await t.people.disable({ sub: 'e-1' })).toMatchObject({ ok: true });
    t.clock.t = NOW;
    expect(await del()).toMatchObject({ guardrail: 'retention', error: expect.stringMatching(/disabled on 2026-10-07.*from 2027-01-05/) as string });
    expect(await t.people.deleteUser({ sub: 'e-1', reason: 'Moved agencies', confirmEmail: 'someone@example.org' })).toMatchObject({ guardrail: 'confirm' });

    t.clock.t = NOW + 81 * DAY;
    expect(await del()).toMatchObject({ ok: true });
    expect(t.pool.get('e-1')).toBeUndefined();
    expect(t.auditLog.rows.at(-1)).toMatchObject({ action: 'people.delete', outcome: 'ok', before: { email: 'eve@example.org' }, after: { deleted: true } });
  });

  it('refuses when the disable isn’t in the log, and when the sign-in is stale', async () => {
    const t = setup({ actor: OWNER });
    t.pool.add({ sub: 'x', email: 'x@example.org', enabled: false });
    expect(await t.people.deleteUser({ sub: 'x', reason: 'cleanup', confirmEmail: 'x@example.org' })).toMatchObject({ guardrail: 'retention_unknown' });

    const s = setup({ actor: { ...OWNER, authTimeAgoSeconds: 3600 }, config: { deleteRetentionDays: 0 } });
    s.pool.add({ sub: 'x', email: 'x@example.org', enabled: false });
    expect(await s.people.deleteUser({ sub: 'x', reason: 'cleanup', confirmEmail: 'x@example.org' })).toMatchObject({ code: 'step_up_required' });
    expect(s.pool.writes()).toEqual([]);
  });

  it('a never-used invite has nothing to retain', async () => {
    const t = setup({ actor: OWNER });
    t.pool.add({ sub: 'i-1', email: 'typo@example.org', enabled: false, emailVerified: false, createdAt: new Date(NOW - 9 * DAY) });
    expect(await t.people.deleteUser({ sub: 'i-1', reason: 'Mistyped address', confirmEmail: 'typo@example.org' })).toMatchObject({ ok: true });
  });
});

describe('invite expiry sweep', () => {
  function seedInvites(pool: ReturnType<typeof fakeUserPool>) {
    pool.add({ sub: 'old', email: 'old@example.org', emailVerified: false, createdAt: new Date(NOW - 8 * DAY) }, 'admin-content');
    pool.add({ sub: 'new', email: 'new@example.org', emailVerified: false, createdAt: new Date(NOW - 2 * DAY) }, 'admin-view');
    pool.add({ sub: 'used', email: 'used@example.org', emailVerified: true, createdAt: new Date(NOW - 30 * DAY) }, 'admin-view');
    pool.add({ sub: 'gone', email: 'gone@example.org', emailVerified: false, enabled: false, createdAt: new Date(NOW - 30 * DAY) });
  }

  it('as an admin: disables only expired, unaccepted invites, and removes their roles', async () => {
    const t = setup({ actor: ADMIN });
    seedInvites(t.pool);
    const result = await t.people.expireStaleInvites();
    expect(result).toMatchObject({ disabled: ['old'], failed: [], truncated: false });
    expect(t.pool.get('old')).toMatchObject({ enabled: false });
    expect([...t.pool.get('old')!.groups]).toEqual([]);
    expect(t.pool.get('new')!.enabled).toBe(true);
    expect(t.auditLog.rows.at(-1)).toMatchObject({ action: 'people.expireInvite', actor: { sub: 'admin-1' }, outcome: 'ok', reason: 'Invite unused for 7 days' });
  });

  it('as a scheduled job: logs as the system actor', async () => {
    const pool = fakeUserPool();
    seedInvites(pool);
    const log = createMemoryAuditLog({ now: () => NOW });
    const sweep = createInviteExpirySweep({ userPoolId: 'us-east-1_TestPool1', auditLog: log, cognito: pool.client, now: () => NOW, sleep: () => Promise.resolve() });
    expect(await sweep()).toMatchObject({ disabled: ['old'], checked: 4 });
    expect(log.rows.map((r) => [r.phase, r.actor])).toEqual([
      ['intent', { sub: 'system:invite-expiry', kind: 'system' }],
      ['result', { sub: 'system:invite-expiry', kind: 'system' }],
    ]);
  });

  it('as an admin: never disables the last owner, warns them through the mailer, and says so', async () => {
    const t = setup({ actor: ADMIN });
    t.pool.add({ sub: 'o-1', email: 'olivia@example.org', emailVerified: false, createdAt: new Date(NOW - 8 * DAY) }, OWNER_GROUP);
    t.pool.add({ sub: 'old', email: 'old@example.org', emailVerified: false, createdAt: new Date(NOW - 8 * DAY) }, 'admin-content');
    const result = await t.people.expireStaleInvites();
    expect(result).toMatchObject({ disabled: ['old'], failed: [], skipped: [{ sub: 'o-1', reason: 'last-owner', warned: ['owner'], problems: [] }] });
    expect(t.pool.get('o-1')).toMatchObject({ enabled: true });
    expect([...t.pool.get('o-1')!.groups]).toEqual([OWNER_GROUP]);
    expect(t.ownerWarnings).toEqual([
      expect.objectContaining({ siteName: 'Example Reports', signInUrl: 'https://reports.example.org/sign-in', to: { email: 'olivia@example.org', kind: 'owner' } }),
    ]);
    const row = t.auditLog.rows.find((r) => r.target?.sub === 'o-1')!;
    expect(row).toMatchObject({ phase: 'refused', action: 'people.expireInvite', actor: { sub: 'admin-1' } });
    expect(row.error).toMatch(/^last_owner: skipped: last owner/);
  });

  it('skips an invite whose intent can’t be logged', async () => {
    const pool = fakeUserPool();
    seedInvites(pool);
    const log = createMemoryAuditLog();
    log.failNextAppends(1);
    const sweep = createInviteExpirySweep({ userPoolId: 'us-east-1_TestPool1', auditLog: log, cognito: pool.client, now: () => NOW });
    expect(await sweep()).toMatchObject({ disabled: [], failed: [{ sub: 'old' }] });
    expect(pool.get('old')!.enabled).toBe(true);
  });
});

describe('Activity', () => {
  it('needs audit.read, and shows each change once', async () => {
    const t = setup({ actor: OWNER });
    t.pool.add({ sub: 'v-1', email: 'v@example.org' }, 'admin-view');
    await t.people.signOutEverywhere({ sub: 'v-1' });
    await t.people.disable({ sub: 'owner-1' });
    const page = await t.people.listActivity({ limit: 10 });
    expect(page.state === 'ok' && page.entries.map((e) => [e.event.action, e.status])).toEqual([
      ['people.disable', 'refused'],
      ['people.signOutEverywhere', 'ok'],
    ]);
    expect(await t.people.listActivity({ cursor: 'forged!' })).toMatchObject({ state: 'unavailable', reason: 'that page link is invalid.' });

    // Every admin role reads the log, view-only included; a member doesn't.
    t.actAs({ sub: 'view-1', groups: ['admin-view'] });
    expect(await t.people.listActivity()).toMatchObject({ state: 'ok' });
    t.actAs(MEMBER);
    expect(await t.people.listActivity()).toEqual({ state: 'unavailable', reason: "You don't have permission to do that." });
  });
});

describe('who may act, and untrusted input', () => {
  it('signed out, disabled, or unreachable never acts', async () => {
    const t = setup({ actor: ADMIN });
    t.pool.add({ sub: 'v-1', email: 'v@example.org' }, 'admin-view');
    t.signOut();
    expect(await t.people.disable({ sub: 'v-1' })).toMatchObject({ code: 'unauthenticated' });

    const d = setup({ actor: { ...ADMIN, enabled: false } });
    d.pool.add({ sub: 'v-1', email: 'v@example.org' }, 'admin-view');
    expect(await d.people.disable({ sub: 'v-1' })).toMatchObject({ code: 'unauthenticated', error: 'This account is disabled.' });

    const u = setup({ actor: ADMIN });
    u.h.cognito.setLiveState('admin-1', new (await import('../../src/server/index.js')).AuthUnavailableError());
    expect(await u.people.disable({ sub: 'v-1' })).toMatchObject({ code: 'unavailable' });
    for (const x of [t, d, u]) expect(x.pool.writes()).toEqual([]);
  });

  it('a demoted admin stops at once: groups are re-read live, not taken from the token', async () => {
    const t = setup({ actor: ADMIN });
    t.pool.add({ sub: 'v-1', email: 'v@example.org' }, 'admin-view');
    t.h.cognito.setLiveState('admin-1', { enabled: true, groups: ['admin-content'] });
    expect(await t.people.disable({ sub: 'v-1' })).toMatchObject({ code: 'forbidden' });
  });

  it.each([
    [{ sub: 'abc" OR "x' }, 'invalid'],
    [{ sub: 42 }, 'invalid'],
    [{ sub: 'v-1', reason: 'x'.repeat(501) }, 'invalid'],
    ['not an object', 'invalid'],
    [{ sub: 'nobody' }, 'not_found'],
  ])('rejects %j', async (input, code) => {
    const t = setup({ actor: ADMIN });
    t.pool.add({ sub: 'v-1', email: 'v@example.org' }, 'admin-view');
    expect(await t.people.disable(input as never)).toMatchObject({ ok: false, code });
    expect(t.pool.writes()).toEqual([]);
  });

  it('rejects malformed invite emails', async () => {
    const t = setup({ actor: ADMIN });
    for (const email of ['', 'no-at-sign', 'a@b', 'a"b@example.org', 'a@example.org\nBcc: x@evil.test']) {
      expect(await t.people.invite({ email, role: 'admin-view' })).toMatchObject({ ok: false, code: 'invalid' });
    }
  });
});

describe('FormData adapters', () => {
  it('read the shared field names', async () => {
    const t = setup({ actor: ADMIN });
    const data = new FormData();
    data.set(PEOPLE_FORM_FIELDS.email, 'form@example.org');
    data.set(PEOPLE_FORM_FIELDS.role, 'admin-view');
    expect(await t.people.forms.invite(null, data)).toMatchObject({ ok: true });
    const role = new FormData();
    const v = t.pool.users.find((u) => u.email === 'form@example.org')!;
    role.set(PEOPLE_FORM_FIELDS.sub, v.sub);
    role.set(PEOPLE_FORM_FIELDS.toRole, 'admin-content');
    role.set(PEOPLE_FORM_FIELDS.fromRole, 'admin-view');
    role.set(PEOPLE_FORM_FIELDS.reason, 'promoted');
    expect(await t.people.forms.changeRole(null, role)).toMatchObject({ ok: true });
    expect(await t.people.forms.disable(null, { sub: v.sub } as never)).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('reads Transfer ownership’s fields', async () => {
    const t = setup({ actor: OWNER });
    t.pool.add({ sub: 's-2', email: 'grace@example.org' }, 'superadmin');
    const data = new FormData();
    data.set(PEOPLE_FORM_FIELDS.sub, 's-2');
    data.set(PEOPLE_FORM_FIELDS.reason, 'Handing over');
    data.set(PEOPLE_FORM_FIELDS.confirmEmail, 'grace@example.org');
    expect(await t.people.forms.transferOwnership(null, data)).toMatchObject({ ok: true });
    expect(await t.people.forms.transferOwnership(null, { sub: 's-2' } as never)).toMatchObject({ ok: false, code: 'invalid' });
  });
});
