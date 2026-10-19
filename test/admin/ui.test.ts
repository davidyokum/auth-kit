import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ActionResult, ActivityPage, FormAction, PeopleList, PersonRow } from '../../src/admin/index.js';
import { OWNER_CHOICE_LABEL, RESOURCE_ACCESS_NOTE, roleLabel } from '../../src/admin/index.js';
import {
  ActionResultMessage,
  ActivityLog,
  allowedPeopleActions,
  CompareRoles,
  InviteForm,
  PeopleTable,
  RoleChangeDialog,
  RoleMatrixTable,
  TransferOwnershipDialog,
} from '../../src/admin/ui/index.js';

const noop: FormAction = () => Promise.resolve({ ok: true, message: 'done' });
const NOW = '2026-10-17T12:00:00.000Z';
const DASH = String.fromCharCode(0x2013);

function person(sub: string, email: string, groups: string[], extra: Partial<PersonRow> = {}): PersonRow {
  const top = (['owner', 'superadmin', 'admin-content-people', 'admin-content', 'admin-view'] as const).find((g) => groups.includes(g)) ?? null;
  return {
    sub,
    username: sub,
    email,
    enabled: true,
    emailVerified: true,
    status: 'CONFIRMED',
    groups,
    adminRole: top,
    createdAt: '2026-06-01T00:00:00.000Z',
    invite: { status: 'accepted', expiresAt: '2026-06-08T00:00:00.000Z' },
    ...extra,
  };
}

const people: PersonRow[] = [
  person('o-1', 'olivia@example.org', ['owner'], { name: 'Olivia' }),
  person('s-1', 'sam@example.org', ['superadmin'], { name: 'Sam' }),
  person('a-1', 'bob@example.org', ['admin-content-people'], { name: 'Bob' }),
  person('e-1', 'alice@example.org', ['admin-content', 'reviewer']),
  person('i-1', 'dan@example.org', ['admin-content'], { emailVerified: false, invite: { status: 'pending', expiresAt: '2026-10-20T00:00:00.000Z' } }),
  person('d-1', 'carol@example.org', [], { enabled: false, invite: { status: 'disabled', expiresAt: '2026-06-08T00:00:00.000Z' } }),
];
const [OLIVIA, SAM, BOB, ALICE, DAN] = people as [PersonRow, PersonRow, PersonRow, PersonRow, PersonRow];
const list: PeopleList = { state: 'ok', people, fetchedAt: NOW, truncated: false, inviteMode: 'emailed-code' };
const owner = { sub: 'o-1', groups: ['owner'] };
const superadmin = { sub: 's-1', groups: ['superadmin'] };
const admin = { sub: 'a-1', groups: ['admin-content-people'] };
const all = { resend: noop, changeRole: noop, transferOwnership: noop, disable: noop, enable: noop, signOutEverywhere: noop, deleteUser: noop };

/** The radio inputs a picker renders: value, checked, disabled. */
function radios(html: string) {
  return [...html.matchAll(/<input type="radio"([^>]*)\/>/g)].map((m) => {
    const attrs = m[1]!;
    return {
      name: /name="([^"]+)"/.exec(attrs)?.[1],
      value: /value="([^"]+)"/.exec(attrs)?.[1],
      checked: attrs.includes('checked=""'),
      disabled: attrs.includes('disabled=""'),
    };
  });
}

describe('PeopleTable', () => {
  it('shows a failed load as "—" and the reason, never as zero people', () => {
    const html = renderToStaticMarkup(h(PeopleTable, { people: { state: 'unavailable', reason: 'ListUsers was throttled.' }, viewer: admin, actions: all }));
    expect(html).toContain('People (—)');
    expect(html).toContain('ListUsers was throttled.');
    expect(html).toContain('role="alert"');
    expect(html).not.toMatch(/\b0 people\b/);
  });

  it('lists people with their source, honest gaps, and only the actions the server would allow', () => {
    const html = renderToStaticMarkup(h(PeopleTable, { people: list, viewer: admin, actions: all, stepUpHref: '/sign-in?reauth=1' }));
    expect(html).toContain('snapshot from ListUsers at 2026-10-17 12:00 UTC');
    expect(html).toContain('roles from ListUsersInGroup');
    expect(html).toContain('(you)');
    expect(html).toContain('Owner');
    expect(html).toContain('Super admin');
    expect(html).toContain(`Admin ${DASH} content only`);
    expect(html).toContain('Invited · expires 2026-10-20');
    expect(html).toContain('not tracked'); // last sign-in: Cognito doesn't keep it
    expect(html).toContain('AdminDisableUser');
    expect(html).toContain('within 60 minutes');
    expect(html).not.toContain('ak-owner-count'); // exactly one owner: nothing to flag
    // A people admin manages neither the owner, a Super admin, nor themselves (beyond signing out).
    const rows = html.split('<tr class="ak-person">').slice(1);
    expect(rows[0]).toContain('No actions for your role');
    expect(rows[1]).toContain('No actions for your role');
    expect(rows[2]).not.toContain('Disable');
    expect(rows[3]).toContain('Disable');
    expect(rows[4]).toContain('Revoke invite');
    expect(rows[4]).toContain('Resend invite');
    expect(rows[5]).toContain('Re-enable');
    expect(rows[5]).not.toContain('Delete permanently'); // the owner and Super admins only
  });

  it('offers delete to the owner and Super admins, with the address to type and a required reason', () => {
    for (const viewer of [owner, superadmin]) {
      const html = renderToStaticMarkup(h(PeopleTable, { people: list, viewer, actions: all }));
      expect(html).toContain('Type carol@example.org to confirm');
      expect(html).toContain('Delete permanently');
    }
  });

  it('flags a site with no owner, or more than one', () => {
    const none = renderToStaticMarkup(h(PeopleTable, { people: { ...list, people: people.slice(1) }, viewer: superadmin, actions: all }));
    expect(none).toMatch(/class="ak-note ak-warn ak-owner-count" role="alert">This site has no owner\./);
    const two = renderToStaticMarkup(
      h(PeopleTable, { people: { ...list, people: [...people, person('o-2', 'priya@example.org', ['owner'])] }, viewer: owner, actions: all }),
    );
    expect(two).toContain('This site has 2 owners; it should have exactly one.');
    const disabledExtra = renderToStaticMarkup(
      h(PeopleTable, { people: { ...list, people: [...people, person('o-2', 'priya@example.org', ['owner'], { enabled: false })] }, viewer: owner, actions: all }),
    );
    expect(disabledExtra).not.toContain('ak-owner-count'); // a disabled account isn't an owner
    const cut = renderToStaticMarkup(h(PeopleTable, { people: { ...list, people: people.slice(1), truncated: true }, viewer: owner, actions: all }));
    expect(cut).toContain('The list stopped at 5 people, so the owner count may be incomplete.');
  });

  it('decides actions with the same guardrails the server runs', () => {
    expect(allowedPeopleActions(admin, OLIVIA, 1)).toEqual([]);
    expect(allowedPeopleActions(admin, SAM, 1)).toEqual([]);
    expect(allowedPeopleActions(admin, BOB, 1)).toEqual(['signOutEverywhere']);
    expect(allowedPeopleActions(admin, ALICE, 1)).toEqual(['changeRole', 'signOutEverywhere', 'disable']);
    expect(allowedPeopleActions(superadmin, OLIVIA, 1)).toEqual([]);
    expect(allowedPeopleActions(superadmin, { ...SAM, sub: 's-2' }, 1)).toEqual([]); // not another Super admin
    expect(allowedPeopleActions(owner, OLIVIA, 1)).toEqual(['signOutEverywhere']);
    expect(allowedPeopleActions(owner, SAM, 1)).toEqual(['changeRole', 'transferOwnership', 'signOutEverywhere', 'disable']);
    expect(allowedPeopleActions(owner, DAN, 1)).toEqual(['changeRole', 'resend', 'signOutEverywhere', 'disable']); // not signed in: no transfer
    expect(allowedPeopleActions(owner, person('o-2', 'p@example.org', ['owner']), 2)).toEqual(['changeRole']); // demote the extra owner
    expect(allowedPeopleActions(owner, person('o-2', 'p@example.org', ['owner']), 1)).toEqual([]);
    expect(allowedPeopleActions({ sub: 'x', groups: ['admin-content'] }, ALICE, 1)).toEqual([]);
    expect(allowedPeopleActions({ sub: 'x', groups: ['admin-view'] }, ALICE, 1)).toEqual([]);
  });
});

describe('RoleChangeDialog', () => {
  it('shows every role with can and can’t, disables what the viewer can’t grant with the reason, and requires a reason', () => {
    const html = renderToStaticMarkup(h(RoleChangeDialog, { person: ALICE, viewer: admin, action: noop }));
    expect(radios(html)).toEqual([
      { name: 'toRole', value: 'superadmin', checked: false, disabled: true },
      { name: 'toRole', value: 'admin-content-people', checked: false, disabled: true },
      { name: 'toRole', value: 'admin-content', checked: false, disabled: true },
      { name: 'toRole', value: 'admin-view', checked: true, disabled: false },
      { name: 'toRole', value: 'member', checked: false, disabled: false },
    ]);
    expect(html).not.toContain('value="owner"');
    expect(html).toContain('Only the owner can grant Super admin.');
    expect(html).toContain(`You grant only roles below your own (Admin ${DASH} content &amp; people).`);
    expect(html).toContain('Their current role.');
    expect(html).toContain('Can: See everything in the admin area and all content, including the audit log.');
    expect(html).toContain('Can’t: Change anything.');
    expect(html).toContain('name="fromRole" value="admin-content"');
    expect(html).toMatch(/<textarea name="reason" required="" minLength="3"/i);
    expect(html).toContain('AdminRemoveUserFromGroup (old role)');
    expect(html).toContain('Admin pages check live');
    // The owner is shown apart, and only the owner sees Transfer ownership.
    expect(html).toContain('Owner (only one): not a choice here.');
    expect(html).not.toContain('Transfer ownership…');
    // Compare roles is one click away, and the note says site roles aren't item access.
    expect(html).toMatch(/<details class="ak-compare-roles"><summary>Compare roles<\/summary>/);
    expect(html).toContain(RESOURCE_ACCESS_NOTE);
    // Screens never say "record" or "resource" (class names may: they're code).
    expect(html.replace(/<[^>]+>/g, ' ')).not.toMatch(/\brecords?\b|record access|resource/i);
  });

  it('lets the owner grant Super admin (with the alert note) and offers Transfer ownership…', () => {
    const html = renderToStaticMarkup(h(RoleChangeDialog, { person: BOB, viewer: owner, action: noop, transferAction: noop }));
    expect(radios(html)[0]).toEqual({ name: 'toRole', value: 'superadmin', checked: true, disabled: false });
    expect(html).toContain('the owner gets an email about it');
    expect(html).toContain('Transfer ownership…');
    expect(html).toContain('Transfer ownership to Bob');
    expect(html).toContain('Type bob@example.org to confirm');
    expect(html).toContain('name="confirmEmail"');
    expect(html).toContain('AdminRemoveUserFromGroup owner (you)');
    // Without the action, no button.
    expect(renderToStaticMarkup(h(RoleChangeDialog, { person: BOB, viewer: owner, action: noop }))).not.toContain('Transfer ownership…');
  });

  it('tells the owner why ownership can’t go to someone who hasn’t signed in', () => {
    const html = renderToStaticMarkup(h(RoleChangeDialog, { person: DAN, viewer: owner, action: noop, transferAction: noop }));
    expect(html).not.toContain('Transfer ownership…');
    expect(html).toContain('Transfer ownership: Ownership can go only to someone who has signed in.');
  });

  it('links the note when given a resource-access link, and renders that section under it', () => {
    const html = renderToStaticMarkup(
      h(RoleChangeDialog, { person: ALICE, viewer: admin, action: noop, resourceAccessHref: '/admin/access', resourceAccess: h('p', null, 'Item access panel') }),
    );
    expect(html).toContain(
      '<p class="ak-note">These roles are for running the site. <a href="/admin/access">Access to individual projects, plans, and other items is managed on each one.</a></p><p>Item access panel</p>',
    );
  });
});

describe('TransferOwnershipDialog', () => {
  it('asks for their address and a reason, and says what happens', () => {
    const html = renderToStaticMarkup(h(TransferOwnershipDialog, { person: SAM, action: noop }));
    expect(html).toContain('Transfer ownership…');
    expect(html).toContain('A site has exactly one owner.');
    expect(html).toContain('Type sam@example.org to confirm');
    expect(html).toMatch(/<textarea name="reason" required=""/);
  });
});

describe('Compare roles', () => {
  it('renders the matrix: every role, Member last, the decided columns', () => {
    const html = renderToStaticMarkup(h(RoleMatrixTable));
    for (const col of ['View everything', 'Edit any content', 'Manage people', 'Security, exports, deletion', 'Owner-only pages']) expect(html).toContain(col);
    const rows = [...html.matchAll(/<th scope="row">([^<]+)<\/th>/g)].map((m) => m[1]);
    expect(rows).toEqual([
      'Owner (only one)',
      'Super admin',
      `Admin ${DASH} content &amp; people`,
      `Admin ${DASH} content only`,
      `Admin ${DASH} view only`,
      'Member',
    ]);
    expect(html).toContain('Roles below their own');
    expect(renderToStaticMarkup(h(CompareRoles))).toContain('<summary>Compare roles</summary>');
  });

  it('says "Owner (only one)" where roles are chosen or compared, and plain "Owner" where it names someone (register C1)', () => {
    expect(OWNER_CHOICE_LABEL).toBe('Owner (only one)');
    expect(roleLabel('owner')).toBe('Owner');
    expect(RESOURCE_ACCESS_NOTE).toBeTruthy();
  });
});

describe('InviteForm', () => {
  it('offers grantable roles, app roles, and member (the default); explains the calls and the 7-day expiry', () => {
    const html = renderToStaticMarkup(h(InviteForm, { action: noop, viewer: admin, appRoles: ['reviewer'] }));
    expect(radios(html).map((r) => [r.value, r.disabled])).toEqual([
      ['superadmin', true],
      ['admin-content-people', true],
      ['admin-content', false],
      ['admin-view', false],
      ['reviewer', false],
      ['member', false],
    ]);
    expect(radios(html).find((r) => r.checked)?.value).toBe('member');
    expect(radios(html).every((r) => r.name === 'role')).toBe(true);
    expect(html).toContain('To make someone the owner, invite them first');
    expect(html).toContain(RESOURCE_ACCESS_NOTE);
    expect(html).toContain('AdminCreateUser (no password, email unverified, MessageAction SUPPRESS)');
    expect(html).toContain('expires in 7 days');
  });

  it('describes the admin pool’s one-time password instead', () => {
    const html = renderToStaticMarkup(h(InviteForm, { action: noop, viewer: admin, inviteMode: 'temporary-password' }));
    expect(html).toContain('one-time password');
    expect(html).not.toContain('SUPPRESS');
  });
});

describe('ActionResultMessage', () => {
  it('says what changed on failure, and links to step-up', () => {
    const partial: ActionResult = { ok: false, code: 'failed', error: 'The email didn’t send.', changed: 'partly' };
    expect(renderToStaticMarkup(h(ActionResultMessage, { result: partial }))).toContain('Part of the change was made.');
    const stepUp: ActionResult = { ok: false, code: 'step_up_required', error: 'Please sign in again.', changed: 'nothing', maxAgeSeconds: 300 };
    expect(renderToStaticMarkup(h(ActionResultMessage, { result: stepUp, stepUpHref: '/sign-in?step-up=1' }))).toContain('href="/sign-in?step-up=1"');
  });
});

describe('ActivityLog', () => {
  it('renders entries in plain words and says when it couldn’t load', () => {
    const page: ActivityPage = {
      state: 'ok',
      nextCursor: 'abc',
      entries: [
        {
          status: 'ok',
          event: {
            id: 'r1',
            at: NOW,
            startedAt: NOW,
            phase: 'result',
            outcome: 'ok',
            actor: { sub: 'a-1', email: 'bob@example.org' },
            action: 'people.disable',
            target: { sub: 'e-1', email: 'alice@example.org' },
            before: { enabled: true },
            after: { enabled: false },
            reason: 'Left the team',
            calls: ['AdminDisableUser: ok'],
          },
        },
      ],
    };
    const html = renderToStaticMarkup(h(ActivityLog, { page, nextHref: '?cursor=abc', names: { 'a-1': 'Bob' } }));
    expect(html).toContain('<strong>Bob</strong> disabled <strong>alice@example.org</strong>');
    expect(html).toContain('enabled → disabled');
    expect(html).toContain('intent logged → AdminDisableUser: ok → result: ok');
    expect(html).toContain('Append-only');
    expect(html).toContain('href="?cursor=abc"');
    const down = renderToStaticMarkup(h(ActivityLog, { page: { state: 'unavailable', reason: 'DynamoDB was unreachable.' } }));
    expect(down).toContain('Activity (—)');
    expect(down).toContain('DynamoDB was unreachable.');
  });
});

describe('module boundary', () => {
  it('auth-kit/admin/ui reaches nothing server-side (no AWS SDK, Node built-ins, or server auth)', () => {
    const root = resolve(import.meta.dirname, '../../src');
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/^\s*(import|export)\s+(type\s+)?[^'"]*?from\s+['"]([^'"]+)['"]/gm)) {
        const typeOnly = m[2] !== undefined;
        const spec = m[3]!;
        if (spec.startsWith('.')) {
          if (typeOnly) continue;
          const base = join(dirname(file), spec).replace(/\.js$/, '');
          const candidates = [`${base}.ts`, `${base}.tsx`];
          const next = candidates.find((c) => {
            try {
              readFileSync(c);
              return true;
            } catch {
              return false;
            }
          });
          if (!next) throw new Error(`unresolved ${spec} from ${file}`);
          visit(next);
        } else if (!typeOnly) {
          expect(spec, `${file} imports ${spec}`).toMatch(/^react$/);
        }
      }
    };
    visit(join(root, 'admin/ui/index.tsx'));
    const files = [...seen].map((f) => f.slice(root.length + 1)).sort();
    expect(files).not.toContain('admin/people.ts');
    expect(files).not.toContain('admin/audit.ts');
    expect(files.some((f) => f.startsWith('server/') && f !== 'server/capabilities.ts')).toBe(false);
    expect(readFileSync(join(root, 'admin/ui/index.tsx'), 'utf8').startsWith("'use client';")).toBe(true);
  });
});
