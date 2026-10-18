/**
 * Resource roles as pure rules (ADR 0022): the vocabulary, the combining rule written out by hand
 * (every site role × every resource role × every action), type validation, and the guardrails.
 * The expectations here are literal, not built from the constants under test.
 */
import { describe, expect, it } from 'vitest';
import {
  checkAccessChange,
  createPermission,
  decideResourceAccess,
  defineResourceTypes,
  equivalentRole,
  isResourceId,
  isResourceType,
  neededActions,
  RESOURCE_ACCESS_MATRIX,
  RESOURCE_ACTIONS,
  RESOURCE_POLICY,
  RESOURCE_ROLE_DESCRIPTIONS,
  RESOURCE_ROLE_LABEL,
  RESOURCE_ROLE_RANK,
  RESOURCE_ROLES,
  RESOURCE_SITE_FLOOR,
  resourceAccessCopy,
  resourceRoleDescriptions,
  resourceRoleOptions,
} from '../../src/resources/index.js';
import { STANDARD_CAPABILITIES } from '../../src/server/index.js';
import { TYPES } from './support.js';

const SITE_ROLES = ['owner', 'superadmin', 'admin-content-people', 'admin-content', 'admin-view', 'member'] as const;
type SiteRoleName = (typeof SITE_ROLES)[number];
const ROLES = ['manager', 'contributor', 'reader', null] as const;
type Action = 'view' | 'edit' | 'manage-access' | 'invite';

/** What each site role may do on every item (ADR 0022's floor), written out. */
const FLOOR: Record<SiteRoleName, Action[]> = {
  owner: ['view', 'edit', 'manage-access', 'invite'],
  superadmin: ['view', 'edit', 'manage-access', 'invite'],
  'admin-content-people': ['view', 'edit', 'manage-access', 'invite'],
  'admin-content': ['view', 'edit'],
  'admin-view': ['view'],
  member: [],
};

/** What each resource role may do on its item, written out. */
const ROLE: Record<'manager' | 'contributor' | 'reader', Action[]> = {
  manager: ['view', 'edit', 'manage-access', 'invite'],
  contributor: ['view', 'edit'],
  reader: ['view'],
};

const capabilitiesOf = (role: SiteRoleName): readonly string[] => (role === 'member' ? [] : STANDARD_CAPABILITIES[role]);

describe('vocabulary', () => {
  it('names the three roles, highest first, with their labels and ranks', () => {
    expect(RESOURCE_ROLES).toEqual(['manager', 'contributor', 'reader']);
    expect(RESOURCE_ROLE_LABEL).toEqual({ manager: 'Manager', contributor: 'Contributor', reader: 'Reader' });
    expect(RESOURCE_ROLE_RANK.manager).toBeGreaterThan(RESOURCE_ROLE_RANK.contributor);
    expect(RESOURCE_ROLE_RANK.contributor).toBeGreaterThan(RESOURCE_ROLE_RANK.reader);
    expect(RESOURCE_ACTIONS).toEqual(['view', 'edit', 'manage-access', 'invite']);
  });

  it('says what each role can and can’t do in the app’s own noun, and never "resource" or "record"', () => {
    const project = resourceRoleDescriptions('project');
    expect(project.manager.can).toMatch(/this project/);
    expect(project.manager.cannot).toMatch(/every project keeps at least one/);
    expect(project.contributor).toEqual({ can: 'See and edit this project.', cannot: 'Change who has access to it.' });
    expect(project.reader).toEqual({ can: 'See this project.', cannot: 'Edit it or change who has access to it.' });
    expect(RESOURCE_ROLE_DESCRIPTIONS.reader.can).toBe('See this item.');
    const words = JSON.stringify([project, RESOURCE_ROLE_DESCRIPTIONS, resourceAccessCopy('project')]);
    expect(words).not.toMatch(/resource|record/i);
  });

  it('defaults to admins creating items and members seeing only their own', () => {
    expect(RESOURCE_POLICY).toMatchObject({ selfServiceCreate: false, sharedDirectory: false, minimumManagers: 1 });
    expect(RESOURCE_SITE_FLOOR).toEqual({ view: 'content.read', edit: 'content.edit', 'manage-access': 'people.manage', invite: 'people.manage' });
  });

  it('screens use the noun: "Who has access to this project", "Share this plan"', () => {
    expect(resourceAccessCopy('project').heading).toBe('Who has access to this project');
    expect(resourceAccessCopy('plan').share).toBe('Share this plan');
    expect(resourceAccessCopy('project').adminNote).toBe('Site admins can also see and edit this project (view-only admins can only see it).');
    expect(resourceAccessCopy('grant', 'grants').yours).toMatch(/^Grants you have a role on/);
  });
});

describe('the combining rule: site role on every item, or the resource role on this one', () => {
  const project = TYPES.get('project');
  const cases = SITE_ROLES.flatMap((site) => ROLES.flatMap((role) => RESOURCE_ACTIONS.map((action) => ({ site, role, action }))));

  it('covers every site role × resource role × action (6 × 4 × 4)', () => {
    expect(cases).toHaveLength(96);
  });

  it.each(cases)('$site with role $role: $action', ({ site, role, action }) => {
    const decision = decideResourceAccess(project, { capabilities: capabilitiesOf(site), role });
    const expected = FLOOR[site].includes(action) || (role !== null && ROLE[role].includes(action));
    expect(decision.actions.has(action)).toBe(expected);
    expect(decision.viaSite.has(action)).toBe(FLOOR[site].includes(action));
    expect(decision.viaRole.has(action)).toBe(role !== null && ROLE[role].includes(action));
  });

  it('the published comparison says the same as the hand-written table', () => {
    for (const row of RESOURCE_ACCESS_MATRIX.rows) {
      const want = row.kind === 'site' ? FLOOR[row.role as SiteRoleName] : ROLE[row.role as 'manager' | 'contributor' | 'reader'];
      for (const action of RESOURCE_ACTIONS) expect(row.actions[action], `${row.label} ${action}`).toBe(want.includes(action));
    }
    expect(RESOURCE_ACCESS_MATRIX.rows.map((r) => r.label)).toEqual([
      'Owner',
      'Super admin',
      `Admin ${String.fromCharCode(0x2013)} content & people`,
      `Admin ${String.fromCharCode(0x2013)} content only`,
      `Admin ${String.fromCharCode(0x2013)} view only`,
      'Member',
      'Manager',
      'Contributor',
      'Reader',
    ]);
  });

  it('a shared directory lets everyone signed in see, never edit', () => {
    const idea = TYPES.get('idea');
    const member = decideResourceAccess(idea, { capabilities: [], role: null });
    expect([...member.actions]).toEqual(['view']);
    expect([...member.viaSite]).toEqual(['view']);
  });

  it('a type’s own action takes the floor it was given (`comment` shares view’s)', () => {
    const plan = TYPES.get('plan');
    expect(plan.allActions).toEqual(['view', 'edit', 'manage-access', 'invite', 'comment']);
    expect(decideResourceAccess(plan, { capabilities: STANDARD_CAPABILITIES['admin-view'], role: null }).actions.has('comment')).toBe(true);
    expect(decideResourceAccess(plan, { capabilities: [], role: 'reader' }).actions.has('comment')).toBe(true);
    expect(decideResourceAccess(plan, { capabilities: [], role: 'manager' }).actions.has('invite')).toBe(false);
    // Site admins who manage people still invite on every plan: that's the floor, not the role.
    expect(decideResourceAccess(plan, { capabilities: STANDARD_CAPABILITIES['admin-content-people'], role: null }).actions.has('invite')).toBe(true);
  });

  it('a custom action defaults to edit’s floor, or to none', () => {
    const types = defineResourceTypes({
      doc: { noun: 'doc', actions: { contributor: ['view', 'edit', 'approve'], manager: ['view', 'edit', 'approve', 'manage-access', 'invite', 'archive'] }, customActionFloor: { archive: 'none' } },
    });
    const doc = types.get('doc');
    expect(decideResourceAccess(doc, { capabilities: STANDARD_CAPABILITIES['admin-content'], role: null }).actions.has('approve')).toBe(true);
    expect(decideResourceAccess(doc, { capabilities: STANDARD_CAPABILITIES['admin-view'], role: null }).actions.has('approve')).toBe(false);
    expect(decideResourceAccess(doc, { capabilities: STANDARD_CAPABILITIES.owner, role: null }).actions.has('archive')).toBe(false);
    expect(decideResourceAccess(doc, { capabilities: [], role: 'manager' }).actions.has('archive')).toBe(true);
  });
});

describe('what a check needs', () => {
  const project = TYPES.get('project');

  it('a minimum role needs every action that role has, so an admin whose floor covers them passes', () => {
    expect(neededActions(project, 'contributor')).toEqual(['view', 'edit']);
    expect(neededActions(project, 'manager')).toEqual(['view', 'edit', 'manage-access', 'invite']);
    expect(neededActions(project, 'edit')).toEqual(['edit']);
    const contentAdmin = decideResourceAccess(project, { capabilities: STANDARD_CAPABILITIES['admin-content'], role: null });
    expect(neededActions(project, 'contributor').every((a) => contentAdmin.actions.has(a))).toBe(true);
    expect(neededActions(project, 'manager').every((a) => contentAdmin.actions.has(a))).toBe(false);
    expect(equivalentRole(project, contentAdmin.actions)).toBe('contributor');
    expect(equivalentRole(project, new Set())).toBeNull();
  });

  it('throws for an action or role the type doesn’t know (a programming mistake, not a 404)', () => {
    expect(() => neededActions(project, 'comment')).toThrow(/isn't a role or an action of resource type "project"/);
    expect(() => neededActions(project, 'owner')).toThrow();
    expect(neededActions(TYPES.get('plan'), 'comment')).toEqual(['comment']);
  });
});

describe('who creates items', () => {
  const project = TYPES.get('project');
  const idea = TYPES.get('idea');

  it.each(SITE_ROLES)('%s', (site) => {
    const result = createPermission(project, capabilitiesOf(site));
    if (FLOOR[site].includes('manage-access')) expect(result).toEqual({ allowed: true, manager: 'anyone' });
    else expect(result).toMatchObject({ allowed: false, reason: 'Site admins create projects on this site and choose who manages each one.' });
  });

  it('self-service: any signed-in person creates one and manages it; admins still choose the Manager', () => {
    expect(createPermission(idea, [])).toEqual({ allowed: true, manager: 'self' });
    expect(createPermission(idea, STANDARD_CAPABILITIES['admin-content'])).toEqual({ allowed: true, manager: 'self' });
    expect(createPermission(idea, STANDARD_CAPABILITIES.owner)).toEqual({ allowed: true, manager: 'anyone' });
  });
});

describe('declaring types', () => {
  it('fills in the defaults', () => {
    const project = TYPES.get('project');
    expect(project).toMatchObject({ type: 'project', noun: 'project', nounPlural: 'projects', selfServiceCreate: false, sharedDirectory: false });
    expect(project.actions).toEqual({ manager: ['view', 'edit', 'manage-access', 'invite'], contributor: ['view', 'edit'], reader: ['view'] });
    expect(TYPES.names).toEqual(['project', 'idea', 'plan']);
    expect(() => TYPES.get('ticket')).toThrow(/isn't declared/);
    expect(resourceRoleOptions(project).map((o) => [o.role, o.label])).toEqual([
      ['manager', 'Manager'],
      ['contributor', 'Contributor'],
      ['reader', 'Reader'],
    ]);
  });

  it.each([
    [{ x: { noun: 'x', actions: { reader: ['edit'] } } }, /Reader must be able to view/],
    [{ x: { noun: 'x', actions: { reader: ['view', 'edit'], contributor: ['view'] } } }, /Contributor must hold everything Reader holds/],
    [{ x: { noun: 'x', actions: { manager: ['view', 'edit', 'invite'] } } }, /Manager must keep manage-access/],
    [{ x: { noun: 'x', actions: { contributor: ['view', 'edit', 'manage-access'] } } }, /manage-access is for Managers only/],
    [{ x: { noun: 'x', actions: { contributor: ['view', 'edit', 'invite'] } } }, /invite is for Managers only/],
    [{ x: { noun: 'x', actions: { owner: ['view'] } } }, /unknown role "owner"/],
    [{ x: { noun: 'x', actions: { reader: ['view', 'Not An Action'] } } }, /isn't an action name/],
    [{ x: { noun: '' } }, /noun must be a short word/],
    [{ 'Bad Name': { noun: 'x' } }, /the name must be lowercase/],
    [{ x: { noun: 'x', selfServiceCreate: 'yes' } }, /selfServiceCreate must be true or false/],
    [{ x: { noun: 'x', colour: 'blue' } }, /unknown option "colour"/],
    [{ x: { noun: 'x', customActionFloor: { comment: 'view' } } }, /names "comment", which no role has/],
  ])('refuses %j', (map, message) => {
    expect(() => defineResourceTypes(map as never)).toThrow(message);
  });

  it('lets a type narrow roles within the rules (Contributors who only see; Managers who can’t invite)', () => {
    const narrow = defineResourceTypes({ x: { noun: 'x', actions: { contributor: ['view'], manager: ['view', 'edit', 'manage-access'] } } }).get('x');
    expect(narrow.actions).toEqual({ manager: ['view', 'edit', 'manage-access'], contributor: ['view'], reader: ['view'] });
  });

  it('needs at least one type', () => {
    expect(() => defineResourceTypes({})).toThrow(/at least one/);
  });

  it('checks names and IDs before they reach a key', () => {
    expect(isResourceType('grant-application')).toBe(true);
    expect(isResourceType('Project')).toBe(false);
    expect(isResourceId('0f8b5e2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b')).toBe(true);
    expect(isResourceId('2026:q3.plan_1')).toBe(true);
    for (const bad of ['', 'a#b', 'a/b', 'a b', '-starts-with-dash', 'x'.repeat(129), 7]) expect(isResourceId(bad), String(bad)).toBe(false);
  });
});

describe('guardrails on access changes', () => {
  const manager = { sub: 'mgr', actions: ['view', 'edit', 'manage-access', 'invite'], siteActions: [] };
  const contributor = { sub: 'c', actions: ['view', 'edit'], siteActions: [] };
  const siteAdmin = { sub: 'admin', actions: ['view', 'edit', 'manage-access', 'invite'], siteActions: ['view', 'edit', 'manage-access', 'invite'] };
  const contentAdmin = { sub: 'content', actions: ['view', 'edit'], siteActions: ['view', 'edit'] };

  it('adding, changing, and removing someone else need manage-access', () => {
    expect(checkAccessChange({ change: 'add', actor: manager, target: { sub: 'n', role: null }, toRole: 'reader', managers: 1 })).toEqual({ ok: true });
    for (const actor of [contributor, contentAdmin]) {
      expect(checkAccessChange({ change: 'add', actor, target: { sub: 'n', role: null }, toRole: 'reader', managers: 1, noun: 'project' })).toEqual({
        ok: false,
        code: 'not_allowed',
        reason: 'Only this project’s Managers (and site admins who manage people) can change who has access to it.',
      });
      expect(checkAccessChange({ change: 'remove', actor, target: { sub: 'r', role: 'reader' }, managers: 1 })).toMatchObject({ code: 'not_allowed' });
    }
  });

  it('inviting needs invite; anyone may leave', () => {
    expect(checkAccessChange({ change: 'invite', actor: manager, toRole: 'contributor', managers: 1 })).toEqual({ ok: true });
    expect(checkAccessChange({ change: 'invite', actor: contributor, toRole: 'reader', managers: 1 })).toMatchObject({ code: 'not_allowed' });
    expect(checkAccessChange({ change: 'remove', actor: contributor, target: { sub: 'c', role: 'contributor' }, managers: 1 })).toEqual({ ok: true });
  });

  it('refuses the obvious mistakes', () => {
    expect(checkAccessChange({ change: 'add', actor: manager, target: { sub: 'r', role: 'reader' }, toRole: 'reader', managers: 1 })).toMatchObject({ code: 'already_member' });
    expect(checkAccessChange({ change: 'changeRole', actor: manager, target: { sub: 'r', role: 'reader' }, toRole: 'reader', managers: 1 })).toMatchObject({ code: 'state' });
    expect(checkAccessChange({ change: 'changeRole', actor: manager, target: { sub: 'n', role: null }, toRole: 'reader', managers: 1 })).toMatchObject({ code: 'not_member' });
    expect(checkAccessChange({ change: 'add', actor: manager, target: { sub: 'n', role: null }, toRole: 'owner' as never, managers: 1 })).toMatchObject({ code: 'state' });
  });

  it('every item keeps at least one Manager: the last one can’t leave, be removed, or be demoted', () => {
    const last = { sub: 'mgr', role: 'manager' as const };
    expect(checkAccessChange({ change: 'remove', actor: manager, target: last, managers: 1, noun: 'project' })).toEqual({
      ok: false,
      code: 'last_manager',
      reason: 'Every project keeps at least one Manager. Make someone else a Manager first.',
    });
    expect(checkAccessChange({ change: 'changeRole', actor: manager, target: last, toRole: 'contributor', managers: 1 })).toMatchObject({ code: 'last_manager' });
    // With a second Manager, either may step down.
    expect(checkAccessChange({ change: 'remove', actor: manager, target: last, managers: 2 })).toEqual({ ok: true });
    expect(checkAccessChange({ change: 'changeRole', actor: manager, target: last, toRole: 'reader', managers: 2 })).toEqual({ ok: true });
  });

  it('a site admin who manages access may replace the last Manager, naming the new one in the same step', () => {
    const last = { sub: 'mgr', role: 'manager' as const };
    expect(checkAccessChange({ change: 'remove', actor: siteAdmin, target: last, managers: 1 })).toMatchObject({
      code: 'last_manager',
      reason: expect.stringMatching(/name the new Manager in the same step \(site admins only\)/),
    });
    expect(checkAccessChange({ change: 'remove', actor: siteAdmin, target: last, managers: 1, replacement: { sub: 'new' } })).toEqual({ ok: true });
    expect(checkAccessChange({ change: 'changeRole', actor: siteAdmin, target: last, toRole: 'reader', managers: 1, replacement: { sub: 'new' } })).toEqual({ ok: true });
    // A Manager (not a site admin) can't use the shortcut; nor can anyone name the same person.
    expect(checkAccessChange({ change: 'remove', actor: manager, target: last, managers: 1, replacement: { sub: 'new' } })).toMatchObject({ code: 'last_manager' });
    expect(checkAccessChange({ change: 'remove', actor: siteAdmin, target: last, managers: 1, replacement: { sub: 'mgr' } })).toMatchObject({ code: 'replacement_invalid' });
    // And it's only for the last Manager.
    expect(checkAccessChange({ change: 'remove', actor: siteAdmin, target: { sub: 'r', role: 'reader' }, managers: 1, replacement: { sub: 'new' } })).toMatchObject({
      code: 'replacement_invalid',
    });
  });
});
