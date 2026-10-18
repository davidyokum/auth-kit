/**
 * Register rule C5: code and docs say "resource"; screens use the app's noun ("project", "plan") and
 * the item's name, and never show an item's ID. This walks every kind of access change, refusal,
 * failure, email, and Activity line, collects every string a person can read, and checks each one.
 */
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  type ActionResult,
  type AuditEvent,
  createMemoryAuditLog,
  type DescribeActivityOptions,
  describeActivity,
  renderInviteEmail,
  renderResourceInviteAlertEmail,
} from '../../src/admin/index.js';
import { ActivityLog } from '../../src/admin/ui/index.js';
import { createMemoryResourceStore } from '../../src/resources/index.js';
import { AuthUnavailableError } from '../../src/server/index.js';
import { setup as peopleSetup } from '../admin/people-fixture.js';
import { bearer, harness } from '../helpers.js';
import { TYPES, emailOf, resourceSetup } from './support.js';

const P = { type: 'project', id: 'p-1' };
const Q = { type: 'plan', id: 'q-1' };

/** Every string a person reads in an action result. */
const said = (r: ActionResult) => (r.ok ? r.message : r.error);

/** Every string the Activity page shows for every row in the log. */
async function activityText(log: { listActivity: (q?: { limit?: number }) => Promise<{ entries: Parameters<typeof describeActivity>[0][] }> }, items?: DescribeActivityOptions['items']): Promise<string[]> {
  const page = await log.listActivity({ limit: 200 });
  return page.entries.flatMap((entry) => {
    const line = describeActivity(entry, () => undefined, items ? { items } : {});
    return [line.actor, line.verb, line.target, line.change ?? '', line.status];
  });
}

function expectReadable(texts: readonly string[], ids: readonly string[]): void {
  for (const text of texts) {
    for (const id of ids) expect(text, `"${text}" shows the ID ${id}`).not.toContain(id);
    expect(text, `"${text}" names an item by its key`).not.toMatch(/\b(project|plan):/);
    // The nouns of the code ("recorded", a verb, is fine).
    expect(text, `"${text}" says "resource" or "record"`).not.toMatch(/\bresources?\b|\brecords?\b/i);
  }
}

describe('screens name items by noun and name, never by ID', () => {
  it('every result, refusal, failure, email, and Activity line of a full run', async () => {
    const t = resourceSetup();
    await t.seed('project', 'p-1', { 'm-1': 'manager', 'm-2': 'reader' });
    await t.seed('plan', 'q-1', { 'm-1': 'manager' });
    const texts: string[] = [];
    t.signIn('member');
    texts.push(said(await t.actions.add({ ...P, email: emailOf('m-3'), role: 'contributor' })));
    texts.push(said(await t.actions.add({ ...P, email: 'nobody@example.org', role: 'reader' })));
    texts.push(said(await t.actions.add({ ...P, email: emailOf('m-2'), role: 'reader' })));
    texts.push(said(await t.actions.changeRole({ ...P, sub: 'm-3', toRole: 'reader', fromRole: 'contributor' })));
    texts.push(said(await t.actions.changeRole({ ...P, sub: 'm-1', toRole: 'reader' })));
    texts.push(said(await t.actions.remove({ ...P, sub: 'm-1' })));
    texts.push(said(await t.actions.invite({ ...P, email: 'new@example.com', role: 'reader' })));
    t.failures.alert.push(Object.assign(new Error('down'), { name: 'ServiceUnavailable' }));
    texts.push(said(await t.actions.invite({ ...P, email: 'other@example.com', role: 'reader' })));
    texts.push(said(await t.actions.invite({ ...Q, email: 'plan@example.com', role: 'reader' })));
    // Someone else changes the project's access between this change's read and its write.
    const commit = t.store.commit.bind(t.store);
    let once = true;
    t.store.commit = async (ref, change) => {
      if (once) {
        once = false;
        const current = await t.store.getAccess(P);
        await commit(P, { expectedVersion: current.meta!.version, meta: { ...current.meta!, version: current.meta!.version + 1 }, put: [] });
      }
      return commit(ref, change);
    };
    texts.push(said(await t.actions.remove({ ...P, sub: 'm-3' })));
    t.signIn('member2');
    texts.push(said(await t.actions.remove({ ...P, sub: 'm-3' })));
    texts.push(said(await t.actions.remove({ ...P, sub: 'm-2' })));
    t.signIn('owner');
    const created = await t.actions.create({ type: 'project', run: ({ id }) => (t.itemNames.set(`project:${id}`, 'Bridges 2028'), Promise.resolve(id)) });
    texts.push(said(created));
    texts.push(said(await t.actions.deleteResourceAccess(P)));
    texts.push((await t.actions.removeResourceMemberships({ sub: 'm-1' })).message);
    for (const email of [...t.invites.map(renderInviteEmail), ...t.alerts.map(renderResourceInviteAlertEmail)]) texts.push(email.subject, email.text, email.html);
    texts.push(...(await activityText(t.auditLog)));

    const ids = ['p-1', 'q-1', ...(created.ok ? [created.id] : [])];
    expectReadable(texts, ids);
    // ...and the words are the app's: its nouns and its items' names.
    const all = texts.join('\n');
    expect(all).toContain('the project “Roads 2027”');
    expect(all).toContain('the plan “Q3 plan”');
    expect(all).toContain('the project “Bridges 2028”');
    expect(all).toContain('Who has access to this project changed since the page loaded');
    expect(all).toContain('Every project keeps at least one Manager');
  });

  it('without a name (the app’s store can’t say), item screens say “this project” and the Activity page “a project”', async () => {
    const t = resourceSetup({ config: { resourceName: () => Promise.reject(new Error('store down')) } });
    await t.seed('project', 'p-1', { 'm-1': 'manager' });
    t.signIn('member');
    const result = await t.actions.add({ ...P, email: emailOf('m-2'), role: 'reader' });
    expect(said(result)).toBe('m-2@example.org now has access to this project as Reader.');
    const removed = await t.actions.removeResourceMemberships({ sub: 'm-1' });
    expect(removed.message).toBe('Their roles on 1 project were removed. A project has no Manager now: a site admin who manages people can make someone its Manager.');
    const lines = await activityText(t.auditLog);
    expect(lines).toContain('m-2@example.org, on a project');
    expectReadable([said(result), removed.message, ...lines], ['p-1']);
    expect(t.errors).toContain('resources: resourceName');
  });

  it('the Activity page uses the app’s current names when it has them, and never an ID for rows written without one', async () => {
    const log = createMemoryAuditLog();
    const actor = { sub: 'admin-1', email: 'admin@example.org' };
    // An app's own change naming a project by its key, and an access change written before names were recorded.
    await log.append({ actor, action: 'projects.update', target: { recordId: 'project:6f1c2a7e-0000-4000-8000-00000000abcd' }, before: { name: 'Old' }, after: { name: 'New' } });
    await log.append({ actor, action: 'resources.add', target: { sub: 'm-2', email: 'm-2@example.org', recordId: 'grant-application:ga-7' }, before: { resourceRole: null }, after: { resourceRole: 'reader' } });
    await log.append({ actor: { sub: 'no-email-sub' }, action: 'resources.delete', target: { recordId: 'thing' } });
    const withoutNames = await activityText(log);
    expect(withoutNames).toContain('a project');
    expect(withoutNames).toContain('m-2@example.org, on a grant application');
    expect(withoutNames).toContain('an item');
    expect(withoutNames).toContain('an account with no email on file');
    const named = await activityText(log, (recordId) => (recordId.startsWith('project:') ? { noun: 'project', name: 'Roads 2027' } : undefined));
    expect(named).toContain('the project “Roads 2027”');
    const ids = ['6f1c2a7e-0000-4000-8000-00000000abcd', 'ga-7', 'no-email-sub'];
    expectReadable([...withoutNames, ...named], ids);
    // The component takes the names as a plain map (it's a client component).
    const html = renderToStaticMarkup(
      h(ActivityLog, { page: { state: 'ok', ...(await log.listActivity()) }, items: { 'project:6f1c2a7e-0000-4000-8000-00000000abcd': { noun: 'project', name: 'Roads 2027' } } }),
    );
    expect(html).toContain('the project “Roads 2027”');
    for (const id of ids) expect(html).not.toContain(id);
  });

  it('the People page’s disable result names the projects whose roles were removed', async () => {
    const r = resourceSetup();
    await r.seed('project', 'p-1', { 'm-1': 'manager' });
    const t = peopleSetup({ actor: { sub: 'admin-1', groups: ['admin-content-people'] }, config: { removeResourceMemberships: (p) => r.actions.removeResourceMemberships(p) } });
    t.pool.add({ sub: 'm-1', email: 'm-1@example.org' });
    const result = await t.people.disable({ sub: 'm-1', reason: 'Left' });
    expect(result).toMatchObject({ ok: true, message: expect.stringContaining('Their roles on 1 project were removed. The project “Roads 2027” has no Manager now') });
    expectReadable([said(result)], ['p-1']);
  });

  it('“couldn’t check” names the noun, not the item', async () => {
    const store = createMemoryResourceStore();
    const hx = harness({ resources: { types: TYPES, store } });
    hx.cognito.setLiveState('m-1', { enabled: true, groups: [] });
    const request = bearer(hx.issuer.mintAccessToken({ sub: 'm-1', groups: [], authTime: Math.floor(hx.clock.now / 1000) - 30 }));
    store.failNext('read', 2);
    await expect(hx.auth.requireResourceRole('project', 'p-1', 'view', { request })).rejects.toEqual(expect.objectContaining({ message: 'Access to this project couldn’t be checked right now. Please try again.' }));
    const listed = await hx.auth.listMyResources('plan', { request }).catch((e: unknown) => e);
    expect(listed).toBeInstanceOf(AuthUnavailableError);
    expect((listed as Error).message).toBe('Your plans couldn’t be listed right now. Please try again.');
  });

  it('keeps the item’s noun and name on every access row, so later screens needn’t ask', async () => {
    const t = resourceSetup();
    await t.seed('project', 'p-1', { 'm-1': 'manager' });
    t.signIn('member');
    await t.actions.add({ ...P, email: emailOf('m-2'), role: 'reader' });
    await t.actions.remove({ ...P, sub: 'm-1' });
    const rows: readonly AuditEvent[] = t.auditLog.rows;
    for (const row of rows) expect((row.after as { item?: unknown }).item, `${row.phase} ${row.action}`).toEqual({ noun: 'project', name: 'Roads 2027' });
  });
});
