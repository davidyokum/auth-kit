/**
 * The access actions (ADR 0022) over real server auth, the fake user pool, the in-memory store, and
 * the in-memory audit log: who may change access, the last-Manager rule, a Manager's invite and its
 * alert, creating and deleting an item's access, the People page's disable hook, and the audit rows
 * every change writes (intent → change → result).
 */
import { describe, expect, it } from 'vitest';
import { describeActivity } from '../../src/admin/index.js';
import { RESOURCE_FORM_FIELDS as F } from '../../src/resources/index.js';
import { setup as peopleSetup } from '../admin/people-fixture.js';
import { PEOPLE, TYPES, emailOf, resourceSetup } from './support.js';

const P = { type: 'project', id: 'p-1' };
const audited = (t: ReturnType<typeof resourceSetup>) => t.auditLog.rows.map((r) => `${r.phase}:${r.action}`);
const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
};

describe('who has access (listAccess)', () => {
  it('lists Managers first, then by email, with the viewer’s role, actions, and the role picker in the type’s words', async () => {
    const t = resourceSetup();
    await t.seed('project', 'p-1', { 'm-2': 'reader', 'm-1': 'manager', 'm-3': 'contributor' });
    t.signIn('member');
    const list = await t.actions.listAccess(P);
    if (list.state !== 'ok') throw new Error(list.state);
    expect(list.members.map((m) => [m.sub, m.label])).toEqual([
      ['m-1', 'Manager'],
      ['m-3', 'Contributor'],
      ['m-2', 'Reader'],
    ]);
    expect(list).toMatchObject({ noun: 'project', managers: 1, canInvite: true, inviteMode: 'emailed-code', viewer: { sub: 'm-1', role: 'manager', siteActions: [] } });
    expect(list.viewer.actions.sort()).toEqual(['edit', 'invite', 'manage-access', 'view']);
    expect(list.roles.map((r) => r.can)[2]).toBe('See this project.');
  });

  it('a site admin with no role sees it, with what their site role allows; a stranger gets "not found"', async () => {
    const t = resourceSetup();
    await t.seed('project', 'p-1', { 'm-1': 'manager' });
    t.signIn('adminView');
    expect(await t.actions.listAccess(P)).toMatchObject({ state: 'ok', canInvite: false, viewer: { role: null, actions: ['view'], siteActions: ['view'] } });
    t.signIn('member2');
    expect(await t.actions.listAccess(P)).toEqual({ state: 'not_found' });
    expect(await t.actions.listAccess({ type: 'project', id: 'a#b' })).toEqual({ state: 'not_found' });
  });

  it('a failed read says why, never an empty list', async () => {
    const t = resourceSetup();
    await t.seed('project', 'p-1', { 'm-1': 'manager' });
    t.signIn('member');
    // The viewer's own access can't be checked.
    t.store.failNext('read', 1);
    expect(await t.actions.listAccess(P)).toMatchObject({ state: 'unavailable', reason: expect.stringMatching(/couldn’t be checked/i) });
    // The viewer's access is fine, but the list can't be read.
    t.store.getAccess = () => Promise.reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
    expect(await t.actions.listAccess(P)).toMatchObject({ state: 'unavailable', reason: expect.stringMatching(/This isn’t an empty list\.$/) });
    expect(t.errors).toContain('resources: listAccess');
  });

  it('says invites aren’t available when the site has no mailer and alert', async () => {
    const t = resourceSetup({ noMail: true });
    await t.seed('project', 'p-1', { 'm-1': 'manager' });
    t.signIn('member');
    expect(await t.actions.listAccess(P)).toMatchObject({ state: 'ok', canInvite: false });
  });
});

describe('add', () => {
  it('a Manager gives an existing account a role: intent, one transaction, result, with the person and the item named', async () => {
    const t = resourceSetup();
    await t.seed('project', 'p-1', { 'm-1': 'manager' });
    t.signIn('member');
    const result = await t.actions.add({ ...P, email: emailOf('m-2'), role: 'contributor' });
    expect(result).toMatchObject({ ok: true, message: 'm-2@example.org now has access to this project as Contributor.' });
    expect(await t.roleOf('project', 'p-1', 'm-2')).toBe('contributor');
    expect(await t.store.getMembership(P, 'm-2')).toMatchObject({ email: 'm-2@example.org', addedBy: 'm-1' });
    expect((await t.store.getAccess(P)).meta).toMatchObject({ version: 2, managers: 1, updatedBy: 'm-1' });
    expect(audited(t)).toEqual(['intent:resources.add', 'result:resources.add']);
    expect(t.auditLog.rows[1]).toMatchObject({
      outcome: 'ok',
      actor: { sub: 'm-1' },
      target: { sub: 'm-2', email: 'm-2@example.org', recordId: 'project:p-1' },
      before: { resource: 'project:p-1', resourceRole: null },
      after: { resource: 'project:p-1', resourceRole: 'contributor' },
      calls: ['TransactWriteItems resource access: ok'],
      context: { ip: '203.0.113.24' },
    });
    const writes = t.timeline.filter((e) => e.startsWith('audit:') || e === 'store:commit');
    expect(writes).toEqual(['audit:intent', 'store:commit', 'audit:result']);
    expect(t.changes.map((c) => c.action)).toEqual(['resources.add']);
  });

  it.each(['adminPeople', 'superadmin', 'owner'] as const)('%s, with no role on it, may add (their site role manages access everywhere)', async (who) => {
    const t = resourceSetup();
    await t.seed('project', 'p-1', { 'm-1': 'manager' });
    t.signIn(who);
    expect(await t.actions.add({ ...P, email: emailOf('m-2'), role: 'reader' })).toMatchObject({ ok: true });
  });

  it.each(['adminContent', 'adminView'] as const)('%s can see it but not change who has access: forbidden, and the attempt is logged', async (who) => {
    const t = resourceSetup();
    await t.seed('project', 'p-1', { 'm-1': 'manager' });
    t.signIn(who);
    expect(await t.actions.add({ ...P, email: emailOf('m-2'), role: 'reader' })).toMatchObject({ ok: false, code: 'forbidden', changed: 'nothing' });
    expect(audited(t)).toEqual(['refused:resources.add']);
    expect(t.auditLog.rows[0]?.error).toMatch(/^capability: Only this project’s Managers/);
    expect(await t.roleOf('project', 'p-1', 'm-2')).toBeNull();
  });

  it('a Contributor is forbidden; someone with no access gets "not found", and nothing is logged for them', async () => {
    const t = resourceSetup();
    await t.seed('project', 'p-1', { 'm-1': 'manager', 'm-2': 'contributor' });
    t.signIn('member2');
    expect(await t.actions.add({ ...P, email: emailOf('m-3'), role: 'reader' })).toMatchObject({ code: 'forbidden' });
    t.signIn('member3');
    expect(await t.actions.add({ ...P, email: emailOf('m-3'), role: 'manager' })).toMatchObject({ code: 'not_found', error: 'Not found.' });
    expect(audited(t)).toEqual(['refused:resources.add']);
  });

  it('a demoted admin loses the site floor at once (the acting person is read live)', async () => {
    const t = resourceSetup({ liveGroups: { 'acp-1': [] } });
    await t.seed('project', 'p-1', { 'm-1': 'manager' });
    t.signIn('adminPeople');
    expect(await t.actions.add({ ...P, email: emailOf('m-2'), role: 'reader' })).toMatchObject({ code: 'not_found' });
  });

  it('an address with no account: says to invite them instead', async () => {
    const t = resourceSetup();
    await t.seed('project', 'p-1', { 'm-1': 'manager' });
    t.signIn('member');
    expect(await t.actions.add({ ...P, email: 'new@example.org', role: 'reader' })).toEqual({
      ok: false,
      code: 'refused',
      guardrail: 'no_account',
      error: 'No account uses that address. Invite them to this project instead.',
      changed: 'nothing',
    });
  });

  it('refuses a disabled account, someone who already has a role, and malformed input', async () => {
    const t = resourceSetup();
    await t.seed('project', 'p-1', { 'm-1': 'manager', 'm-2': 'reader' });
    t.pool.get('m-3')!.enabled = false;
    t.signIn('member');
    expect(await t.actions.add({ ...P, email: emailOf('m-3'), role: 'reader' })).toMatchObject({ code: 'refused', guardrail: 'disabled' });
    expect(await t.actions.add({ ...P, email: emailOf('m-2'), role: 'manager' })).toMatchObject({ code: 'refused', guardrail: 'already_member', error: expect.stringMatching(/as Reader\. Change their role instead/) });
    expect(await t.actions.add({ ...P, email: 'not-an-email', role: 'reader' })).toMatchObject({ code: 'invalid' });
    expect(await t.actions.add({ ...P, email: emailOf('m-3'), role: 'owner' as never })).toMatchObject({ code: 'invalid' });
    expect(await t.actions.add({ type: 'ticket', id: 'p-1', email: emailOf('m-3'), role: 'reader' })).toMatchObject({ code: 'invalid' });
  });

  it('changes nothing when the audit log can’t take the intent', async () => {
    const t = resourceSetup();
    await t.seed('project', 'p-1', { 'm-1': 'manager' });
    t.signIn('member');
    t.auditLog.failNextAppends(1);
    expect(await t.actions.add({ ...P, email: emailOf('m-2'), role: 'reader' })).toMatchObject({ code: 'audit_unavailable', changed: 'nothing' });
    expect(await t.roleOf('project', 'p-1', 'm-2')).toBeNull();
  });
});

describe('grant (add or change, for APIs)', () => {
  it('is a no-op when the role is already right, and a role change when it isn’t', async () => {
    const t = resourceSetup();
    await t.seed('project', 'p-1', { 'm-1': 'manager', 'm-2': 'contributor' });
    t.signIn('member');
    expect(await t.actions.grant({ ...P, email: emailOf('m-2'), role: 'contributor' })).toEqual({ ok: true, message: 'm-2@example.org is already Contributor. Nothing changed.' });
    expect(audited(t)).toEqual([]);
    expect(await t.actions.grant({ ...P, email: emailOf('m-2'), role: 'reader' })).toMatchObject({ ok: true });
    expect(audited(t)).toEqual(['intent:resources.changeRole', 'result:resources.changeRole']);
    expect(await t.actions.grant({ ...P, email: emailOf('m-3'), role: 'reader' })).toMatchObject({ ok: true });
    expect(await t.roleOf('project', 'p-1', 'm-3')).toBe('reader');
  });
});

describe('change a role, and the last Manager', () => {
  it('a Manager promotes a Reader; the access record counts Managers', async () => {
    const t = resourceSetup();
    await t.seed('project', 'p-1', { 'm-1': 'manager', 'm-2': 'reader' });
    t.signIn('member');
    expect(await t.actions.changeRole({ ...P, sub: 'm-2', toRole: 'manager', fromRole: 'reader' })).toMatchObject({ ok: true, message: 'm-2@example.org is now Manager of this project.' });
    expect((await t.store.getAccess(P)).meta?.managers).toBe(2);
    expect(t.auditLog.rows.at(-1)).toMatchObject({ before: { resourceRole: 'reader' }, after: { resourceRole: 'manager' }, target: { sub: 'm-2' } });
    expect((await t.store.getMembership(P, 'm-2'))).toMatchObject({ updatedBy: 'm-1', addedBy: PEOPLE.adminPeople.sub });
  });

  it('refuses a stale page, the same role, and someone without a role', async () => {
    const t = resourceSetup();
    await t.seed('project', 'p-1', { 'm-1': 'manager', 'm-2': 'reader' });
    t.signIn('member');
    expect(await t.actions.changeRole({ ...P, sub: 'm-2', toRole: 'manager', fromRole: 'contributor' })).toMatchObject({ code: 'stale', error: expect.stringMatching(/changed to Reader since this page loaded/) });
    expect(await t.actions.changeRole({ ...P, sub: 'm-2', toRole: 'reader' })).toMatchObject({ code: 'refused', guardrail: 'state' });
    expect(await t.actions.changeRole({ ...P, sub: 'm-3', toRole: 'reader' })).toMatchObject({ code: 'not_found' });
  });

  it('the only Manager can’t demote themselves; with two, either may step down', async () => {
    const t = resourceSetup();
    await t.seed('project', 'p-1', { 'm-1': 'manager', 'm-2': 'reader' });
    t.signIn('member');
    expect(await t.actions.changeRole({ ...P, sub: 'm-1', toRole: 'contributor' })).toMatchObject({
      code: 'refused',
      guardrail: 'last_manager',
      error: 'Every project keeps at least one Manager. Make someone else a Manager first.',
    });
    expect(audited(t)).toEqual(['refused:resources.changeRole']);
    await t.actions.changeRole({ ...P, sub: 'm-2', toRole: 'manager' });
    expect(await t.actions.changeRole({ ...P, sub: 'm-1', toRole: 'contributor' })).toMatchObject({ ok: true });
    expect((await t.store.getAccess(P)).meta?.managers).toBe(1);
  });

  it('a site admin replaces the last Manager in one step: the new Manager is added (or promoted) in the same transaction', async () => {
    const t = resourceSetup();
    await t.seed('project', 'p-1', { 'm-1': 'manager', 'm-2': 'reader' });
    t.signIn('adminPeople');
    expect(await t.actions.changeRole({ ...P, sub: 'm-1', toRole: 'reader' })).toMatchObject({ guardrail: 'last_manager', error: expect.stringMatching(/site admins only/) });
    const result = await t.actions.changeRole({ ...P, sub: 'm-1', toRole: 'reader', replaceWithEmail: emailOf('m-3') });
    expect(result).toMatchObject({ ok: true, message: 'm-1@example.org is now Reader of this project. m-3@example.org is now a Manager.' });
    expect([await t.roleOf('project', 'p-1', 'm-1'), await t.roleOf('project', 'p-1', 'm-3')]).toEqual(['reader', 'manager']);
    expect(t.auditLog.rows.at(-1)).toMatchObject({ after: { resourceRole: 'reader', newManager: { sub: 'm-3', email: 'm-3@example.org', before: null } } });
    expect(t.timeline.filter((e) => e === 'store:commit')).toHaveLength(1);
    // An existing member can be the replacement too (promoted).
    expect(await t.actions.remove({ ...P, sub: 'm-3', replaceWithEmail: emailOf('m-2') })).toMatchObject({ ok: true });
    expect(await t.roleOf('project', 'p-1', 'm-2')).toBe('manager');
  });

  it('a Manager can’t use the replacement shortcut; they promote someone first', async () => {
    const t = resourceSetup();
    await t.seed('project', 'p-1', { 'm-1': 'manager', 'm-2': 'reader' });
    t.signIn('member');
    expect(await t.actions.remove({ ...P, sub: 'm-1', replaceWithEmail: emailOf('m-2') })).toMatchObject({ code: 'refused', guardrail: 'last_manager' });
    expect(await t.roleOf('project', 'p-1', 'm-1')).toBe('manager');
  });

  it('two people changing access at once: the second is refused as stale and changes nothing (never zero Managers)', async () => {
    const t = resourceSetup();
    await t.seed('project', 'p-1', { 'm-1': 'manager', 'm-2': 'manager' });
    t.signIn('member');
    // While m-1 steps down, m-2 steps down too (committed between m-1's read and m-1's write).
    const m2StepsDown = async () => {
      const current = await t.store.getAccess(P);
      const m2 = current.members.find((m) => m.sub === 'm-2')!;
      await t.store.commit(P, { expectedVersion: current.meta!.version, meta: { ...current.meta!, version: current.meta!.version + 1, managers: 1 }, put: [{ ...m2, role: 'reader' }] });
    };
    const commit = t.store.commit;
    let once = true;
    t.store.commit = async (ref, change) => {
      if (once) {
        once = false;
        await m2StepsDown();
      }
      return commit(ref, change);
    };
    const result = await t.actions.changeRole({ ...P, sub: 'm-1', toRole: 'reader' });
    expect(result).toMatchObject({ ok: false, code: 'stale', error: expect.stringMatching(/changed since the page loaded/) });
    expect(t.auditLog.rows.at(-1)).toMatchObject({ phase: 'result', outcome: 'failed' });
    expect([await t.roleOf('project', 'p-1', 'm-1'), await t.roleOf('project', 'p-1', 'm-2')]).toEqual(['manager', 'reader']);
  });
});

describe('remove and leave', () => {
  it('a Manager removes someone; anyone with a role may leave; the last Manager may not', async () => {
    const t = resourceSetup();
    await t.seed('project', 'p-1', { 'm-1': 'manager', 'm-2': 'contributor', 'm-3': 'reader' });
    t.signIn('member');
    expect(await t.actions.remove({ ...P, sub: 'm-3' })).toMatchObject({ ok: true, message: 'm-3@example.org no longer has access to this project.' });
    expect(await t.actions.remove({ ...P, sub: 'm-1' })).toMatchObject({ code: 'refused', guardrail: 'last_manager' });
    t.signIn('member2');
    expect(await t.actions.remove({ ...P, sub: 'm-2' })).toMatchObject({ ok: true, message: 'You no longer have a role on this project.' });
    expect(t.auditLog.rows.at(-1)).toMatchObject({ after: { resourceRole: null, left: true }, before: { resourceRole: 'contributor' } });
    expect((await t.store.getAccess(P)).members.map((m) => m.sub)).toEqual(['m-1']);
  });

  it('a Reader can’t remove anyone else (forbidden, logged)', async () => {
    const t = resourceSetup();
    await t.seed('project', 'p-1', { 'm-1': 'manager', 'm-2': 'reader', 'm-3': 'reader' });
    t.signIn('member2');
    expect(await t.actions.remove({ ...P, sub: 'm-3' })).toMatchObject({ code: 'forbidden' });
    expect(audited(t)).toEqual(['refused:resources.remove']);
    expect(await t.roleOf('project', 'p-1', 'm-3')).toBe('reader');
  });
});

describe('a Manager invites someone new to one item', () => {
  it('creates the account with no admin role, adds the membership, alerts the site’s admins, then sends the invite', async () => {
    const t = resourceSetup({ config: { resourceName: () => Promise.resolve('Q3 plan') } });
    await t.seed('project', 'p-1', { 'm-1': 'manager' });
    t.pool.get('super-1')!.enabled = false;
    t.signIn('member');
    const result = await t.actions.invite({ ...P, email: 'new@example.com', name: 'Nia', role: 'contributor' });
    expect(result).toMatchObject({ ok: true, message: expect.stringMatching(/^Invite sent to new@example.com, with access to this project as Contributor and nothing else\. The site’s admins were told\./) });
    // Cognito: the account only. No group: Member level.
    expect(t.pool.writes()).toEqual(['AdminCreateUserCommand']);
    const created = t.pool.users.find((u) => u.email === 'new@example.com')!;
    expect([...created.groups]).toEqual([]);
    expect(await t.roleOf('project', 'p-1', created.sub)).toBe('contributor');
    // The alert: every enabled member of a group that manages people (the disabled Super admin isn't told).
    expect(t.alerts).toHaveLength(1);
    expect(t.alerts[0]).toMatchObject({
      siteName: 'Example Reports',
      invited: { sub: created.sub, email: 'new@example.com', name: 'Nia' },
      invitedBy: { sub: 'm-1', email: 'm-1@example.org' },
      item: { type: 'project', id: 'p-1', noun: 'project', name: 'Q3 plan' },
      role: 'contributor',
    });
    expect(t.alerts[0]!.recipients.map((r) => r.sub).sort()).toEqual(['acp-1', 'owner-1']);
    expect(t.invites[0]).toMatchObject({ email: 'new@example.com', name: 'Nia', item: { noun: 'project', name: 'Q3 plan', role: 'contributor', invitedBy: 'm-1@example.org' } });
    // Order: the intent first, then the account, the membership, the alert, the email, the result.
    const order = t.timeline.filter((e) => /^(audit:|store:commit|mail:|cognito:AdminCreateUser)/.test(e));
    expect(order).toEqual(['audit:intent', 'cognito:AdminCreateUser', 'store:commit', 'mail:resourceInviteSent', 'mail:sendInvite', 'audit:result']);
    expect(t.auditLog.rows.at(-1)).toMatchObject({
      action: 'resources.invite',
      outcome: 'ok',
      target: { sub: created.sub, email: 'new@example.com', recordId: 'project:p-1' },
      after: { role: 'member', resourceRole: 'contributor', status: 'invited', inviteAlert: { sentTo: expect.arrayContaining(['owner-1@example.org', 'acp-1@example.org']) } },
    });
  });

  it.each([
    ['alert', 'the site’s admins couldn’t be alerted'],
    ['invite', 'the invite email didn’t send'],
  ] as const)('if the %s fails, the invite is undone: no account, no membership', async (which, words) => {
    const t = resourceSetup();
    await t.seed('project', 'p-1', { 'm-1': 'manager' });
    t.signIn('member');
    t.failures[which].push(Object.assign(new Error('SES is down'), { name: 'ServiceUnavailable' }));
    const result = await t.actions.invite({ ...P, email: 'new@example.com', role: 'reader' });
    expect(result).toMatchObject({ ok: false, code: 'failed', changed: 'nothing', error: expect.stringContaining(`The invite was undone because ${words}`) });
    expect(t.pool.users.some((u) => u.email === 'new@example.com')).toBe(false);
    expect(t.pool.writes()).toEqual(['AdminCreateUserCommand', 'AdminDeleteUserCommand']);
    expect((await t.store.getAccess(P)).members.map((m) => m.sub)).toEqual(['m-1']);
    expect(t.auditLog.rows.at(-1)).toMatchObject({ phase: 'result', outcome: 'failed' });
    if (which === 'alert') expect(t.invites).toEqual([]);
  });

  it('refuses before changing anything: no notifier, an existing account, an unusual domain unconfirmed, nobody to alert', async () => {
    const quiet = resourceSetup({ noMail: true });
    await quiet.seed('project', 'p-1', { 'm-1': 'manager' });
    quiet.signIn('member');
    expect(await quiet.actions.invite({ ...P, email: 'new@example.com', role: 'reader' })).toMatchObject({ code: 'refused', guardrail: 'invite_unavailable' });

    const t = resourceSetup({ config: { inviteDomains: ['example.com'] } });
    await t.seed('project', 'p-1', { 'm-1': 'manager' });
    t.signIn('member');
    expect(await t.actions.invite({ ...P, email: emailOf('m-2'), role: 'reader', confirmOutsideDomain: true })).toMatchObject({
      code: 'refused',
      guardrail: 'exists',
      error: 'That address already has an account. Add them to this project instead.',
    });
    expect(await t.actions.invite({ ...P, email: 'new@elsewhere.test', role: 'reader' })).toMatchObject({ code: 'refused', guardrail: 'domain' });
    expect(await t.actions.invite({ ...P, email: 'new@elsewhere.test', role: 'reader', confirmOutsideDomain: true })).toMatchObject({ ok: true });

    const nobody = resourceSetup({ config: { inviteAlertRecipients: () => Promise.resolve([]) } });
    await nobody.seed('project', 'p-1', { 'm-1': 'manager' });
    nobody.signIn('member');
    expect(await nobody.actions.invite({ ...P, email: 'new@example.com', role: 'reader' })).toMatchObject({ code: 'refused', guardrail: 'alert_unavailable' });
    expect(nobody.pool.writes()).toEqual([]);
  });

  it('only Managers (and admins who manage people) invite; a type can take invites away from Managers', async () => {
    const t = resourceSetup();
    await t.seed('project', 'p-1', { 'm-1': 'manager', 'm-2': 'contributor' });
    await t.seed('plan', 'q-1', { 'm-1': 'manager' });
    t.signIn('member2');
    expect(await t.actions.invite({ ...P, email: 'new@example.com', role: 'reader' })).toMatchObject({ code: 'forbidden' });
    t.signIn('member');
    expect(await t.actions.invite({ type: 'plan', id: 'q-1', email: 'new@example.com', role: 'reader' })).toMatchObject({ code: 'forbidden' });
    t.signIn('adminPeople');
    expect(await t.actions.invite({ type: 'plan', id: 'q-1', email: 'new@example.com', role: 'reader' })).toMatchObject({ ok: true });
  });
});

describe('create an item with its first Manager', () => {
  it('an admin who manages access creates it, naming the Manager; the app’s item is created inside the same audited change', async () => {
    const t = resourceSetup();
    t.signIn('adminPeople');
    const made: string[] = [];
    const result = await t.actions.create({ type: 'project', managerEmail: emailOf('m-1'), run: ({ id, manager }) => (made.push(`${id}:${manager.sub}`), Promise.resolve({ name: 'Roads' })) });
    if (!result.ok) throw new Error(result.error);
    expect(result).toMatchObject({ value: { name: 'Roads' }, message: 'Created, with m-1@example.org as its Manager.' });
    expect(made).toEqual([`${result.id}:m-1`]);
    expect(await t.roleOf('project', result.id, 'm-1')).toBe('manager');
    expect((await t.store.getAccess({ type: 'project', id: result.id })).meta).toMatchObject({ version: 1, managers: 1, createdBy: 'acp-1' });
    expect(t.auditLog.rows.at(-1)).toMatchObject({
      action: 'resources.create',
      outcome: 'ok',
      target: { sub: 'm-1', recordId: `project:${result.id}` },
      calls: ['TransactWriteItems resource access (access record and first Manager): ok', 'App: create the item: ok'],
    });
  });

  it('defaults the Manager to the person creating it', async () => {
    const t = resourceSetup();
    t.signIn('owner');
    const result = await t.actions.create({ type: 'project', id: 'roads-2027' });
    expect(result).toMatchObject({ ok: true, id: 'roads-2027', message: expect.stringMatching(/^Created\. You’re its Manager/) });
    expect(await t.roleOf('project', 'roads-2027', 'owner-1')).toBe('manager');
  });

  it.each(['member', 'adminContent', 'adminView'] as const)('%s can’t create a project (admins create them by default)', async (who) => {
    const t = resourceSetup();
    t.signIn(who);
    expect(await t.actions.create({ type: 'project' })).toMatchObject({ ok: false, code: 'forbidden', error: 'Site admins create projects on this site and choose who manages each one.' });
    expect(t.store.size).toBe(0);
  });

  it('self-service: a member creates an idea and becomes its Manager, and can’t hand it to someone else at creation', async () => {
    const t = resourceSetup();
    t.signIn('member');
    const mine = await t.actions.create({ type: 'idea' });
    if (!mine.ok) throw new Error(mine.error);
    expect(await t.roleOf('idea', mine.id, 'm-1')).toBe('manager');
    expect(await t.actions.create({ type: 'idea', managerEmail: emailOf('m-2') })).toMatchObject({ code: 'refused', guardrail: 'self_only' });
  });

  it('if the app can’t create its item, the access is removed again', async () => {
    const t = resourceSetup();
    t.signIn('owner');
    const result = await t.actions.create({ type: 'project', id: 'x-1', run: () => Promise.reject(new Error('disk full')) });
    expect(result).toMatchObject({ ok: false, code: 'failed', changed: 'nothing' });
    expect(t.store.size).toBe(0);
    expect(t.auditLog.rows.at(-1)?.calls).toEqual([
      'TransactWriteItems resource access (access record and first Manager): ok',
      'App: create the item: failed (Error)',
      'TransactWriteItems resource access (remove) (rollback): ok',
    ]);
  });

  it('refuses an ID in use, a Manager with no account, and a demoted admin', async () => {
    const t = resourceSetup({ liveGroups: { 'acp-1': [] } });
    await t.seed('project', 'p-1', { 'm-1': 'manager' });
    t.signIn('owner');
    expect(await t.actions.create({ type: 'project', id: 'p-1' })).toMatchObject({ code: 'refused', guardrail: 'exists' });
    expect(await t.actions.create({ type: 'project', managerEmail: 'nobody@example.org' })).toMatchObject({ code: 'refused', guardrail: 'no_account' });
    t.signIn('adminPeople');
    expect(await t.actions.create({ type: 'project' })).toMatchObject({ code: 'forbidden' });
  });
});

describe('delete an item’s access', () => {
  it('its Managers remove everyone (in chunks under DynamoDB’s transaction limit), logged as one change', async () => {
    const t = resourceSetup();
    await t.seed('project', 'p-1', { 'm-1': 'manager' });
    // 150 more members, added straight to the store in batches.
    for (let batch = 0; batch < 2; batch++) {
      const current = await t.store.getAccess(P);
      const put = Array.from({ length: 75 }, (_, i) => ({ ...P, sub: `x-${batch}-${i}`, role: 'reader' as const, addedBy: 'm-1', addedAt: '2026-10-01T00:00:00.000Z' }));
      await t.store.commit(P, { expectedVersion: current.meta!.version, meta: { ...current.meta!, version: current.meta!.version + 1 }, put });
    }
    t.signIn('member');
    expect(await t.actions.deleteResourceAccess(P)).toMatchObject({ ok: true, message: 'Nobody has access to this project any more (151 removed).' });
    expect(t.store.size).toBe(0);
    expect(t.auditLog.rows.at(-1)).toMatchObject({
      action: 'resources.delete',
      before: { members: 151, managers: 1 },
      calls: ['TransactWriteItems resource access (1 of 2): ok', 'TransactWriteItems resource access (2 of 2): ok'],
    });
  });

  it('needs manage-access by default, or the action the app names', async () => {
    const t = resourceSetup();
    await t.seed('project', 'p-1', { 'm-1': 'manager', 'm-2': 'contributor' });
    t.signIn('member2');
    expect(await t.actions.deleteResourceAccess(P)).toMatchObject({ code: 'forbidden' });
    expect(await t.actions.deleteResourceAccess(P, { need: 'edit' })).toMatchObject({ ok: true });
    await expect(t.actions.deleteResourceAccess(P, { need: 'archive' })).rejects.toThrow(/isn't an action/);
  });
});

describe('the People page’s disable hook (removeResourceMemberships)', () => {
  it('removes every membership the person has, and lists items left without a Manager', async () => {
    const t = resourceSetup();
    await t.seed('project', 'p-1', { 'm-1': 'manager', 'm-2': 'reader' });
    await t.seed('project', 'p-2', { 'm-1': 'contributor', 'm-3': 'manager' });
    await t.seed('plan', 'q-1', { 'm-1': 'reader' });
    const result = await t.actions.removeResourceMemberships({ sub: 'm-1' });
    expect(result).toEqual({
      removed: [
        { type: 'plan', id: 'q-1', role: 'reader' },
        { type: 'project', id: 'p-1', role: 'manager' },
        { type: 'project', id: 'p-2', role: 'contributor' },
      ],
      leftWithoutManager: [{ type: 'project', id: 'p-1' }],
      truncated: false,
    });
    expect(t.store.memberships.map((m) => `${m.id}:${m.sub}`)).toEqual(['p-1:m-2', 'p-2:m-3']);
    expect((await t.store.getAccess(P)).meta?.managers).toBe(0);
  });

  it('throws, after trying every one, when some can’t be removed (the disable is then "partly done")', async () => {
    const t = resourceSetup();
    await t.seed('project', 'p-1', { 'm-1': 'manager' });
    await t.seed('project', 'p-2', { 'm-1': 'manager' });
    t.store.failNext('commit', 1, Object.assign(new Error('boom'), { name: 'InternalServerError' }));
    await expect(t.actions.removeResourceMemberships({ sub: 'm-1' })).rejects.toThrow(/removed 1 of their item memberships; 1 couldn’t be removed/);
  });

  it('plugs into createPeopleActions: disabling someone removes their item access, recorded in the disable row', async () => {
    const r = resourceSetup();
    await r.seed('project', 'p-1', { 'm-1': 'manager', 'm-2': 'reader' });
    const t = peopleSetup({ actor: { sub: 'admin-1', groups: ['admin-content-people'] }, config: { removeResourceMemberships: r.actions.removeResourceMemberships } });
    t.pool.add({ sub: 'm-1', email: 'm-1@example.org' });
    expect(await t.people.disable({ sub: 'm-1', reason: 'Left' })).toMatchObject({ ok: true });
    expect(t.auditLog.rows.at(-1)).toMatchObject({
      after: { enabled: false, resourceMemberships: { removed: [{ type: 'project', id: 'p-1', role: 'manager' }], leftWithoutManager: [{ type: 'project', id: 'p-1' }] } },
    });
    expect(await r.roleOf('project', 'p-1', 'm-1')).toBeNull();
  });
});

describe('FormData adapters', () => {
  it('add, change, remove, and invite take the panel’s fields', async () => {
    const t = resourceSetup();
    await t.seed('project', 'p-1', { 'm-1': 'manager' });
    t.signIn('member');
    const item = { [F.type]: 'project', [F.id]: 'p-1' };
    expect(await t.actions.forms.add(null, form({ ...item, [F.email]: emailOf('m-2'), [F.role]: 'reader' }))).toMatchObject({ ok: true });
    expect(await t.actions.forms.changeRole(null, form({ ...item, [F.sub]: 'm-2', [F.toRole]: 'contributor', [F.fromRole]: 'reader' }))).toMatchObject({ ok: true });
    expect(await t.actions.forms.invite(null, form({ ...item, [F.email]: 'new@example.com', [F.role]: 'reader' }))).toMatchObject({ ok: true });
    expect(await t.actions.forms.remove(null, form({ ...item, [F.sub]: 'm-2' }))).toMatchObject({ ok: true });
    expect(await t.actions.forms.add(null, {} as FormData)).toMatchObject({ code: 'invalid' });
  });
});

describe('the Activity page describes access changes in plain words', () => {
  it('names the person and the item', async () => {
    const t = resourceSetup();
    await t.seed('project', 'p-1', { 'm-1': 'manager' });
    t.signIn('member');
    await t.actions.add({ ...P, email: emailOf('m-2'), role: 'contributor' });
    await t.actions.remove({ ...P, sub: 'm-1' });
    const page = await t.auditLog.listActivity();
    const lines = page.entries.map((e) => describeActivity(e));
    expect(lines[0]).toMatchObject({ verb: 'tried to remove the access of', target: 'm-1@example.org · project:p-1', status: expect.stringMatching(/^refused: last_manager/) });
    expect(lines[1]).toMatchObject({ verb: 'gave access to', target: 'm-2@example.org · project:p-1', change: 'no access → Contributor', status: 'ok' });
  });
});

describe('createResourceActions', () => {
  it('needs a server auth with resources, a site name, and an https sign-in URL', async () => {
    const { createResourceActions } = await import('../../src/resources/index.js');
    const t = resourceSetup();
    const { harness } = await import('../helpers.js');
    const base = { auditLog: t.auditLog, siteName: 'X', signInUrl: 'https://x.example.org/sign-in' };
    expect(() => createResourceActions({ ...base, auth: harness().auth })).toThrow(/created with resources/);
    expect(() => createResourceActions({ ...base, auth: t.h.auth, siteName: '' })).toThrow(/siteName/);
    expect(() => createResourceActions({ ...base, auth: t.h.auth, signInUrl: 'http://x.example.org/sign-in' })).toThrow(/https/);
    expect(TYPES.names).toContain('project');
  });
});
