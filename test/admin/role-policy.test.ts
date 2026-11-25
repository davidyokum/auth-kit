import { describe, expect, it } from 'vitest';
import { createMemorySiteSettingsStore } from '../../src/accounts/index.js';
import {
  createDirectoryProfileStore,
  createInviteWelcomeStore,
  createMemoryAuditLog,
  createSiteSettingsRolePolicyStore,
  createUsageLedgerStore,
  resolveEffectiveRoleCapabilities,
  validateRolePolicyDraft,
  type RolePolicyCatalog,
  type StoredRolePolicy,
} from '../../src/admin/index.js';

const CATALOG: RolePolicyCatalog = {
  capabilities: [
    { id: 'tab.home', label: 'Home tab', group: 'tabs', locked: false, plainDescription: 'View Home.', technicalNote: 'GET /' },
    { id: 'tab.projects', label: 'Projects tab', group: 'tabs', locked: false, plainDescription: 'View Projects.', technicalNote: 'GET /projects' },
    { id: 'content.edit', label: 'Edit content', group: 'actions', locked: false, plainDescription: 'Edit site records.', technicalNote: 'POST /api/items' },
    { id: 'people.manage', label: 'Manage people', group: 'admin', locked: true, plainDescription: 'Invite and manage users.', technicalNote: '/admin' },
  ],
  builtInRoles: [
    {
      id: 'owner',
      label: 'Owner',
      summary: 'Single break-glass site owner.',
      kind: 'governance',
      locked: true,
      defaultCapabilities: ['tab.home', 'tab.projects', 'content.edit', 'people.manage'],
    },
    {
      id: 'superadmin',
      label: 'Admin',
      summary: 'Full site administration.',
      kind: 'governance',
      locked: true,
      defaultCapabilities: ['tab.home', 'tab.projects', 'content.edit', 'people.manage'],
    },
    {
      id: 'member',
      label: 'Viewer',
      summary: 'Signed-in read-only access.',
      kind: 'baseline',
      locked: false,
      defaultCapabilities: ['tab.home', 'tab.projects'],
    },
  ],
};

describe('Guarded Staged Role Builder (ADR 0031)', () => {
  it('blocks edits to locked governance roles, locked admin capabilities, zero-tab roles, and deleting assigned custom roles', () => {
    const badGov: StoredRolePolicy = {
      overrides: { superadmin: ['tab.home'] },
      customRoles: [],
    };
    expect(validateRolePolicyDraft(CATALOG, badGov).ok).toBe(false);

    const badAdminCap: StoredRolePolicy = {
      overrides: { member: ['tab.home', 'people.manage'] },
      customRoles: [],
    };
    expect(validateRolePolicyDraft(CATALOG, badAdminCap).ok).toBe(false);

    const zeroTabs: StoredRolePolicy = {
      overrides: { member: ['content.edit'] },
      customRoles: [],
    };
    expect(validateRolePolicyDraft(CATALOG, zeroTabs).ok).toBe(false);

    const deletingAssigned: StoredRolePolicy = {
      overrides: {},
      customRoles: [],
    };
    const res = validateRolePolicyDraft(CATALOG, deletingAssigned, {
      assignedCustomRoleIds: new Set(['reviewer']),
    });
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toMatch(/reviewer/);
  });

  it('persists valid staged overrides and custom roles with audit trail and resolves live capabilities', async () => {
    const settings = createMemorySiteSettingsStore();
    const auditLog = createMemoryAuditLog();
    const store = createSiteSettingsRolePolicyStore({ catalog: CATALOG, settings, auditLog });

    const initial = await store.get();
    expect(initial.version).toBe(0);

    const saved = await store.save({
      draft: {
        overrides: { member: ['tab.home'] },
        customRoles: [
          {
            id: 'reviewer',
            label: 'Reviewer',
            summary: 'Can view Projects and edit content.',
            capabilities: ['tab.projects', 'content.edit'],
            createdAt: '2026-11-25T00:00:00.000Z',
          },
        ],
      },
      expectedVersion: 0,
      reason: 'Add Reviewer role for external collaborators',
      actor: { sub: 'owner-1', email: 'owner@example.org' },
    });

    expect(saved.version).toBe(1);
    expect(auditLog.rows.map((r) => `${r.action}:${r.phase}`)).toEqual([
      'settings.rolePolicy:intent',
      'settings.rolePolicy:result',
    ]);

    const viewerCaps = resolveEffectiveRoleCapabilities(CATALOG, saved.policy, []);
    expect([...viewerCaps]).toEqual(['tab.home']);

    const reviewerCaps = resolveEffectiveRoleCapabilities(CATALOG, saved.policy, ['reviewer']);
    expect([...reviewerCaps].sort()).toEqual(['content.edit', 'tab.projects']);

    const ownerCaps = resolveEffectiveRoleCapabilities(CATALOG, saved.policy, ['owner']);
    expect(ownerCaps.has('people.manage')).toBe(true);
  });
});

describe('SiteSettingsTable Admin Mode stores', () => {
  it('stores audited directory profiles, throttled usage telemetry, and invite welcome notes', async () => {
    const settings = createMemorySiteSettingsStore();
    const auditLog = createMemoryAuditLog();

    const profiles = createDirectoryProfileStore({ settings, auditLog });
    await profiles.setProfile({
      sub: 'user-1',
      email: 'alice@example.org',
      firstName: 'Alice',
      lastName: 'Chen',
      title: 'Policy Analyst',
      actor: { sub: 'owner-1', email: 'owner@example.org' },
    });
    const map = await profiles.getAll();
    expect(map['user-1']).toMatchObject({ firstName: 'Alice', lastName: 'Chen', title: 'Policy Analyst' });

    const usage = createUsageLedgerStore({ settings, throttleMs: 60_000 });
    const t0 = new Date('2026-11-25T10:00:00.000Z');
    const t1 = new Date('2026-11-25T10:00:30.000Z');
    const t2 = new Date('2026-11-25T10:02:00.000Z');
    expect(await usage.recordVisit({ sub: 'user-1', email: 'alice@example.org', path: '/app', now: t0 })).toBe(true);
    expect(await usage.recordVisit({ sub: 'user-1', email: 'alice@example.org', path: '/app', now: t1 })).toBe(false);
    expect(await usage.recordVisit({ sub: 'user-1', email: 'alice@example.org', path: '/app/projects', now: t2 })).toBe(true);
    const ledger = await usage.get();
    expect(ledger.accounts['user-1']?.visits30d).toBe(2);
    expect(ledger.accounts['user-1']?.lastPath).toBe('/app/projects');

    const welcome = createInviteWelcomeStore({ settings, auditLog });
    expect((await welcome.get()).note).toBeNull();
    const updated = await welcome.save({
      note: 'Welcome to the workspace! Use your work email to sign in.',
      expectedVersion: 0,
      actor: { sub: 'owner-1', email: 'owner@example.org' },
    });
    expect(updated.version).toBe(1);
    expect(updated.note).toBe('Welcome to the workspace! Use your work email to sign in.');
  });
});
