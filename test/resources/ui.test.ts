// @vitest-environment jsdom
/**
 * The "Who has access" panel: what it offers each viewer (the same rules as the server), the
 * last-Manager messages, the admin note, honest failure, the app's noun everywhere, and the
 * add-then-invite flow when an address has no account.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionResult, FormAction } from '../../src/admin/index.js';
import { RESOURCE_FORM_FIELDS as F, type ResourceAccessList, resourceRoleOptions } from '../../src/resources/index.js';
import { ResourceAccessTable, ResourceRoleChip, ResourceRolesSummary, WhoHasAccess } from '../../src/resources/ui.js';
import { TYPES } from './support.js';

afterEach(() => cleanup());

const ok: FormAction = () => Promise.resolve({ ok: true, message: 'Done.' });
const all = { add: ok, changeRole: ok, remove: ok, invite: ok };
const MANAGER = ['view', 'edit', 'manage-access', 'invite'];

function list(over: Partial<Extract<ResourceAccessList, { state: 'ok' }>> = {}): ResourceAccessList {
  return {
    state: 'ok',
    type: 'project',
    id: 'p-1',
    noun: 'project',
    members: [
      { sub: 'm-1', email: 'ann@example.org', name: 'Ann', role: 'manager', label: 'Manager', addedAt: '2026-10-01T00:00:00.000Z', addedByEmail: 'admin@example.org' },
      { sub: 'm-2', email: 'bo@example.org', role: 'contributor', label: 'Contributor', addedAt: '2026-10-02T00:00:00.000Z' },
      { sub: 'm-3', email: 'cy@example.org', role: 'reader', label: 'Reader', addedAt: '2026-10-03T00:00:00.000Z' },
    ],
    managers: 1,
    viewer: { sub: 'm-1', role: 'manager', actions: MANAGER, siteActions: [] },
    roles: resourceRoleOptions(TYPES.get('project')),
    canInvite: true,
    inviteMode: 'emailed-code',
    fetchedAt: '2026-10-17T12:00:00.000Z',
    ...over,
  };
}

const html = (access: ResourceAccessList, extra: Record<string, unknown> = {}) => renderToStaticMarkup(h(WhoHasAccess, { access, actions: all, ...extra }));

describe('WhoHasAccess, for a Manager', () => {
  it('says whose it is in the app’s words, with role chips, the admin note, and the controls', () => {
    const out = html(list());
    expect(out).toContain('Who has access to this project');
    expect(out).toContain('Site admins can also see and edit this project (view-only admins can only see it).');
    expect(out).toMatch(/ak-role-chip ak-role-chip-manager">Manager/);
    expect(out).toContain('3 people');
    expect(out).toContain('Share this project');
    expect(out).toContain('Invite someone new to this project');
    expect(out).toContain('Added 2026-10-01 by admin@example.org');
    // The role picker says what each role can and can't do, in the noun.
    expect(out).toContain('Can: See and edit this project.');
    expect(out).toContain('Can’t: Change who has access to it.');
    // Screens never say "resource" or "record" (form field names, which nobody reads, may).
    expect(out.replace(/<[^>]+>/g, ' ')).not.toMatch(/resource|record/i);
  });

  it('the only Manager can’t remove or demote themselves, and the panel says why', () => {
    render(h(WhoHasAccess, { access: list(), actions: all }));
    const ann = screen.getByText('Ann').closest('li')!;
    expect(within(ann).queryByRole('button', { name: /remove|leave/i })).toBeNull();
    expect(within(ann).queryByRole('button', { name: 'Change role' })).toBeNull();
    expect(within(ann).getByText(/Every project keeps at least one Manager\. Make someone else a Manager first\./)).toBeTruthy();
    const bo = screen.getByText('bo@example.org').closest('li')!;
    expect(within(bo).getByRole('button', { name: 'Remove' })).toBeTruthy();
    expect(within(bo).getByRole('button', { name: 'Change role' })).toBeTruthy();
  });

  it('with two Managers, either may step down', () => {
    const ann = { sub: 'm-1', email: 'ann@example.org', name: 'Ann', role: 'manager' as const, label: 'Manager', addedAt: '2026-10-01T00:00:00.000Z' };
    const di = { sub: 'm-4', email: 'di@example.org', role: 'manager' as const, label: 'Manager', addedAt: '2026-10-04T00:00:00.000Z' };
    render(h(WhoHasAccess, { access: list({ managers: 2, members: [ann, di] }), actions: all }));
    const row = screen.getByText('Ann').closest('li')!;
    expect(within(row).getByRole('button', { name: 'Leave this project' })).toBeTruthy();
  });

  it('hides what it wasn’t given: no invite without canInvite, no add without the action', () => {
    const out = html(list({ canInvite: false }), { actions: { changeRole: ok, remove: ok } });
    expect(out).not.toContain('Invite someone new');
    expect(out).not.toContain('Share this project');
  });
});

describe('WhoHasAccess, for others', () => {
  it('a Reader sees the list, no controls, and can leave', () => {
    render(h(WhoHasAccess, { access: list({ viewer: { sub: 'm-3', role: 'reader', actions: ['view'], siteActions: [] }, canInvite: false }), actions: all }));
    expect(screen.queryByText('Share this project')).toBeNull();
    expect(screen.queryAllByRole('button', { name: 'Change role' })).toEqual([]);
    expect(screen.queryAllByRole('button', { name: 'Remove' })).toEqual([]);
    expect(screen.getByRole('button', { name: 'Leave this project' })).toBeTruthy();
    expect(screen.getByText(/your role:/)).toBeTruthy();
  });

  it('a site admin who manages people may replace the only Manager by naming the new one', async () => {
    render(h(WhoHasAccess, { access: list({ viewer: { sub: 'admin', role: null, actions: MANAGER, siteActions: MANAGER } }), actions: all }));
    const ann = screen.getByText('Ann').closest('li')!;
    expect(within(ann).getByText(/As a site admin, you can name the new Manager in the same step\./)).toBeTruthy();
    // Remove carries the new Manager's address.
    const remove = within(ann).getByRole('button', { name: 'Remove' }).closest('form')!;
    expect(remove.querySelector(`input[name="${F.replaceWithEmail}"]`)).not.toBeNull();
    expect(screen.getByText(/you have no role here; your site role lets you/)).toBeTruthy();
    // Choosing a non-Manager role for Ann asks for the new Manager too.
    const change = within(ann).getByRole('button', { name: 'Change role' }).closest('form')!;
    await userEvent.selectOptions(within(change).getByRole('combobox'), 'reader');
    expect(change.querySelector(`input[name="${F.replaceWithEmail}"]`)).not.toBeNull();
  });

  it('warns when an item has no Manager', () => {
    const out = html(list({ managers: 0, members: [] }));
    expect(out).toContain('This project has no Manager. A site admin can make someone its Manager.');
    expect(out).toContain('Nobody has a role on this project yet.');
  });

  it('a failed load says why; "not found" renders nothing (the page has already 404ed)', () => {
    const out = html({ state: 'unavailable', noun: 'plan', reason: 'Couldn’t load who has access: timed out. This isn’t an empty list.' });
    expect(out).toContain('Who has access to this plan (—)');
    // The type's noun travels with the failure, so the screen never falls back to "item" (register C5).
    expect(out).not.toContain('item');
    expect(out).toContain('role="alert"');
    expect(html({ state: 'not_found' })).toBe('');
  });

  it('uses the noun the page passes', () => {
    expect(html(list(), { noun: 'grant' })).toContain('Who has access to this grant');
  });
});

describe('adding someone without an account turns into an invite', () => {
  it('opens the invite form with their address', async () => {
    const add = vi.fn<FormAction>().mockResolvedValue({
      ok: false,
      code: 'refused',
      guardrail: 'no_account',
      error: 'No account uses that address. Invite them to this project instead.',
      changed: 'nothing',
    } satisfies ActionResult);
    render(h(WhoHasAccess, { access: list(), actions: { ...all, add } }));
    const share = screen.getByRole('form', { name: 'Share this project' });
    await userEvent.type(within(share).getByLabelText(/Email of someone with an account/), 'new@example.com');
    await userEvent.click(within(share).getByRole('button', { name: /^Add new@example.com as Reader$/ }));
    await waitFor(() => expect(add).toHaveBeenCalled());
    const data = add.mock.calls[0]![1];
    expect([data.get(F.type), data.get(F.id), data.get(F.email), data.get(F.role)]).toEqual(['project', 'p-1', 'new@example.com', 'reader']);
    await waitFor(() => expect(screen.getByText('No account uses that address. Invite them to this project instead.')).toBeTruthy());
    const details = screen.getByText('Invite someone new to this project').closest('details')!;
    await waitFor(() => expect(details.open).toBe(true));
    expect(within(details).getByLabelText<HTMLInputElement>('Email').value).toBe('new@example.com');
    expect(within(details).getByRole('button', { name: 'Send invite to new@example.com' })).toBeTruthy();
    expect(within(details).getByText(/The site’s admins are told about every invite\./)).toBeTruthy();
  });

  it('asks to confirm an address outside the usual domains', async () => {
    render(h(WhoHasAccess, { access: list(), actions: all, inviteDomains: ['example.org'] }));
    const details = screen.getByText('Invite someone new to this project').closest('details')!;
    await userEvent.type(within(details).getByLabelText('Email'), 'x@elsewhere.test');
    expect(within(details).getByText(/outside the usual domains \(example.org\)/)).toBeTruthy();
  });
});

describe('explaining resource roles where site roles are chosen', () => {
  it('ResourceRolesSummary: the three roles in the noun, how site roles count, and a link', () => {
    const out = renderToStaticMarkup(h(ResourceRolesSummary, { noun: 'project', href: '/app/projects' }));
    expect(out).toContain('On each project, its Managers choose who has access');
    expect(out).toContain('See and edit this project, choose who has access to it');
    expect(out).toContain('Admin – view only sees every project');
    expect(out).toContain('href="/app/projects"');
    expect(out).toContain('Compare access');
  });

  it('ResourceAccessTable: every site role on every item and every resource role on one', () => {
    const out = renderToStaticMarkup(h(ResourceAccessTable, { noun: 'project' }));
    for (const label of ['Owner', 'Super admin', 'Member', 'Manager', 'Contributor', 'Reader']) expect(out).toContain(`>${label}</th>`);
    expect(out).toContain('Every project (site role)');
    expect(out).toContain('This project');
    expect(out).toContain('Choose who has access');
  });

  it('ResourceRoleChip', () => {
    expect(renderToStaticMarkup(h(ResourceRoleChip, { role: 'reader' }))).toBe('<span class="ak-role-chip ak-role-chip-reader">Reader</span>');
  });
});
