import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ActionResult, ActivityPage, FormAction, PeopleList, PersonRow } from '../../src/admin/index.js';
import {
  ActionResultMessage,
  ActivityLog,
  allowedPeopleActions,
  InviteForm,
  PeopleTable,
  RoleChangeDialog,
} from '../../src/admin/ui/index.js';

const noop: FormAction = () => Promise.resolve({ ok: true, message: 'done' });
const NOW = '2026-10-17T12:00:00.000Z';

function person(sub: string, email: string, groups: string[], extra: Partial<PersonRow> = {}): PersonRow {
  const top = (['superadmin', 'admin', 'editor', 'viewer'] as const).find((g) => groups.includes(g)) ?? null;
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
  person('o-1', 'olivia@example.org', ['superadmin'], { name: 'Olivia' }),
  person('a-1', 'bob@example.org', ['admin'], { name: 'Bob' }),
  person('e-1', 'alice@example.org', ['editor', 'reviewer']),
  person('i-1', 'dan@example.org', ['editor'], { emailVerified: false, invite: { status: 'pending', expiresAt: '2026-10-20T00:00:00.000Z' } }),
  person('d-1', 'carol@example.org', [], { enabled: false, invite: { status: 'disabled', expiresAt: '2026-06-08T00:00:00.000Z' } }),
];
const list: PeopleList = { state: 'ok', people, fetchedAt: NOW, truncated: false, inviteMode: 'emailed-code' };
const admin = { sub: 'a-1', groups: ['admin'] };
const all = { resend: noop, changeRole: noop, disable: noop, enable: noop, signOutEverywhere: noop, deleteUser: noop };

describe('PeopleTable', () => {
  it('shows a failed load as "—" and the reason, never as zero people', () => {
    const html = renderToStaticMarkup(h(PeopleTable, { people: { state: 'unavailable', reason: 'ListUsers was throttled.' }, viewer: admin, actions: all }));
    expect(html).toContain('People (—)');
    expect(html).toContain('ListUsers was throttled.');
    expect(html).toContain('role="alert"');
    expect(html).not.toMatch(/\b0 people\b/);
  });

  it('lists people with their source, honest gaps, and only the actions the server would allow', () => {
    const html = renderToStaticMarkup(h(PeopleTable, { people: list, viewer: admin, actions: all, stepUpHref: '/sign-in?step-up=1' }));
    expect(html).toContain('snapshot from ListUsers at 2026-10-17 12:00 UTC');
    expect(html).toContain('roles from ListUsersInGroup');
    expect(html).toContain('(you)');
    expect(html).toContain('Owner');
    expect(html).toContain('Invited · expires 2026-10-20');
    expect(html).toContain('not recorded'); // last sign-in: Cognito doesn't record it
    expect(html).toContain('AdminDisableUser');
    expect(html).toContain('within 60 minutes');
    // An admin manages neither the owner nor themselves (beyond signing out).
    const rows = html.split('<tr class="ak-person">').slice(1);
    expect(rows[0]).toContain('No actions for your role');
    expect(rows[1]).not.toContain('Disable');
    expect(rows[2]).toContain('Disable');
    expect(rows[3]).toContain('Revoke invite');
    expect(rows[3]).toContain('Resend invite');
    expect(rows[4]).toContain('Re-enable');
    expect(rows[4]).not.toContain('Delete permanently'); // owners only
  });

  it('offers delete to an owner, with the address to type and a required reason', () => {
    const html = renderToStaticMarkup(h(PeopleTable, { people: list, viewer: { sub: 'o-1', groups: ['superadmin'] }, actions: all }));
    expect(html).toContain('Type carol@example.org to confirm');
    expect(html).toContain('Delete permanently');
  });

  it('decides actions with the same guardrails the server runs', () => {
    expect(allowedPeopleActions(admin, people[0]!, 1)).toEqual([]);
    expect(allowedPeopleActions(admin, people[1]!, 1)).toEqual(['signOutEverywhere']);
    expect(allowedPeopleActions(admin, people[2]!, 1)).toEqual(['changeRole', 'signOutEverywhere', 'disable']);
    expect(allowedPeopleActions({ sub: 'o-1', groups: ['superadmin'] }, people[0]!, 1)).toEqual(['signOutEverywhere']);
    expect(allowedPeopleActions({ sub: 'o-2', groups: ['superadmin'] }, people[0]!, 1)).toEqual(['signOutEverywhere']); // last owner
    expect(allowedPeopleActions({ sub: 'o-2', groups: ['superadmin'] }, people[0]!, 2)).toEqual(['changeRole', 'signOutEverywhere', 'disable']);
    expect(allowedPeopleActions({ sub: 'x', groups: ['editor'] }, people[2]!, 1)).toEqual([]);
  });
});

describe('RoleChangeDialog', () => {
  it('offers only roles below the viewer’s own, requires a reason, and names the calls', () => {
    const html = renderToStaticMarkup(h(RoleChangeDialog, { person: people[2]!, viewer: admin, action: noop }));
    expect(html).toMatch(/<option value="superadmin" disabled="">Owner · owners only<\/option>/);
    expect(html).toMatch(/<option value="admin" disabled="">Admin · owners only<\/option>/);
    expect(html).toMatch(/<option value="viewer" selected="">Viewer<\/option>/);
    expect(html).toContain('name="fromRole" value="editor"');
    expect(html).toMatch(/<textarea name="reason" required="" minLength="3"/i);
    expect(html).toContain('AdminRemoveUserFromGroup (old role)');
    expect(html).toContain('Admin pages check live');
  });

  it('warns an owner that granting the owner role needs a fresh sign-in and alerts every owner', () => {
    const html = renderToStaticMarkup(h(RoleChangeDialog, { person: people[1]!, viewer: { sub: 'o-1', groups: ['superadmin'] }, action: noop }));
    expect(html).toMatch(/<option value="superadmin" selected="">Owner<\/option>/);
    expect(html).toContain('every owner gets an email about it');
  });
});

describe('InviteForm', () => {
  it('offers grantable roles, app roles, and member; explains the calls and the 7-day expiry', () => {
    const html = renderToStaticMarkup(h(InviteForm, { action: noop, viewer: admin, appRoles: ['reviewer'] }));
    const options = [...html.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
    expect(options).toEqual(['editor', 'viewer', 'reviewer', 'member']);
    expect(html).toContain('AdminCreateUser (no password, email unverified, MessageAction SUPPRESS)');
    expect(html).toContain('expires in 7 days');
    expect(html).toContain('Granting a role needs a sign-in in the last few minutes.');
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
