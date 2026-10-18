import { describe, expect, it } from 'vitest';
import {
  checkPeopleAction,
  grantableRoles,
  grantCeiling,
  highestAdminRole,
  inviteExpiresAt,
  inviteStatus,
  isKnownRole,
  PEOPLE_ACTION_COPY,
  PEOPLE_ACTIONS,
  peopleActionDetails,
  roleLabel,
  roleOptions,
  roleRank,
  type GuardrailInput,
} from '../../src/admin/index.js';

const person = (sub: string, ...groups: string[]) => ({ sub, groups });
const owner = person('owner-1', 'owner');
const superadmin = person('super-1', 'superadmin');
const peopleAdmin = person('acp-1', 'admin-content-people');
const contentAdmin = person('ac-1', 'admin-content');
const viewAdmin = person('av-1', 'admin-view');
const member = person('member-1');

function check(input: Partial<GuardrailInput> & Pick<GuardrailInput, 'action' | 'actor'>) {
  return checkPeopleAction(input);
}

describe('role ranks', () => {
  it('ranks the ladder owner > superadmin > admin-content-people > admin-content > admin-view, and ignores app roles', () => {
    expect(['admin-view', 'admin-content', 'admin-content-people', 'superadmin', 'owner'].map(roleRank)).toEqual([1, 2, 3, 4, 5]);
    expect(highestAdminRole(['reviewer', 'admin-content', 'admin-view'])).toBe('admin-content');
    expect(highestAdminRole(['reviewer'])).toBeNull();
  });

  it('grants only roles below your own, and nobody can grant owner', () => {
    expect(grantableRoles(['owner'])).toEqual(['superadmin', 'admin-content-people', 'admin-content', 'admin-view']);
    expect(grantableRoles(['superadmin'])).toEqual(['admin-content-people', 'admin-content', 'admin-view']);
    expect(grantableRoles(['admin-content-people'])).toEqual(['admin-content', 'admin-view']);
    expect(grantableRoles(['admin-content'])).toEqual(['admin-view']);
    expect(grantableRoles(['admin-view'])).toEqual([]);
    expect(grantableRoles(['reviewer'])).toEqual([]);
    expect(grantCeiling([])).toBe(0);
  });

  it('labels roles exactly as screens show them', () => {
    expect(['owner', 'superadmin', 'admin-content-people', 'admin-content', 'admin-view', 'member', null].map(roleLabel)).toEqual([
      'Owner',
      'Super admin',
      'Admin ' + String.fromCharCode(0x2013) + ' content & people',
      'Admin ' + String.fromCharCode(0x2013) + ' content only',
      'Admin ' + String.fromCharCode(0x2013) + ' view only',
      'Member',
      'Member',
    ]);
  });
});

describe('capabilities per action', () => {
  it('needs people.manage to invite, roles.manage to change roles, data.delete to delete', () => {
    expect(check({ action: 'invite', actor: contentAdmin, toRole: 'admin-view' })).toMatchObject({ ok: false, code: 'capability' });
    expect(check({ action: 'invite', actor: viewAdmin, toRole: 'member' })).toMatchObject({ ok: false, code: 'capability' });
    expect(check({ action: 'invite', actor: peopleAdmin, toRole: 'admin-view' })).toMatchObject({ ok: true });
    expect(check({ action: 'delete', actor: peopleAdmin, target: { ...contentAdmin, enabled: false }, reason: 'left' })).toMatchObject({
      ok: false,
      code: 'capability',
      reason: 'Only the owner and Super admins can delete accounts.',
    });
    expect(check({ action: 'delete', actor: superadmin, target: { ...contentAdmin, enabled: false } })).toMatchObject({ ok: true });
    expect(check({ action: 'delete', actor: owner, target: { ...contentAdmin, enabled: false } })).toMatchObject({ ok: true });
  });

  it('view-only and content-only admins change nothing about people', () => {
    for (const actor of [viewAdmin, contentAdmin]) {
      for (const action of ['disable', 'enable', 'signOutEverywhere', 'resend'] as const) {
        expect(check({ action, actor, target: member })).toMatchObject({ ok: false, code: 'capability' });
      }
      expect(check({ action: 'changeRole', actor, target: member, toRole: 'admin-view', reason: 'x y z' })).toMatchObject({ ok: false, code: 'capability' });
    }
  });

  it('honors an app capability map passed with the actor', () => {
    const contentOnly = { ...peopleAdmin, capabilities: new Set(['content.edit']) };
    expect(check({ action: 'disable', actor: contentOnly, target: contentAdmin })).toMatchObject({ ok: false, code: 'capability' });
  });
});

describe('nobody acts on themselves', () => {
  it.each(['changeRole', 'disable', 'delete'] as const)('%s on yourself is refused', (action) => {
    // People admins can't delete anyone, so only the owner and Super admins reach the self check for delete.
    for (const actor of action === 'delete' ? [owner, superadmin] : [owner, superadmin, peopleAdmin]) {
      expect(check({ action, actor, target: actor, toRole: 'admin-view', reason: 'testing', ownerCount: 5 })).toMatchObject({ ok: false, code: 'self' });
    }
  });

  it('signing yourself out everywhere is fine', () => {
    expect(check({ action: 'signOutEverywhere', actor: peopleAdmin, target: peopleAdmin })).toEqual({ ok: true, requiresRecentSignIn: false });
  });
});

describe('grant and act only below your own level', () => {
  it('Admin – content & people grants content and view roles, not their own or above', () => {
    expect(check({ action: 'invite', actor: peopleAdmin, toRole: 'admin-content' })).toMatchObject({ ok: true });
    expect(check({ action: 'invite', actor: peopleAdmin, toRole: 'admin-content-people' })).toMatchObject({ ok: false, code: 'rank' });
    expect(check({ action: 'invite', actor: peopleAdmin, toRole: 'superadmin' })).toMatchObject({
      ok: false,
      code: 'rank',
      reason: 'Only the owner can grant Super admin.',
    });
  });

  it('only the owner grants Super admin', () => {
    expect(check({ action: 'invite', actor: superadmin, toRole: 'superadmin' })).toMatchObject({ ok: false, code: 'rank', reason: 'Only the owner can grant Super admin.' });
    expect(check({ action: 'changeRole', actor: superadmin, target: peopleAdmin, toRole: 'superadmin', reason: 'promote' })).toMatchObject({
      ok: false,
      code: 'rank',
    });
    expect(check({ action: 'invite', actor: owner, toRole: 'superadmin', reason: 'deputy' })).toEqual({ ok: true, requiresRecentSignIn: true });
    expect(check({ action: 'changeRole', actor: owner, target: peopleAdmin, toRole: 'superadmin', reason: 'deputy' })).toEqual({
      ok: true,
      requiresRecentSignIn: true,
    });
  });

  it('Super admins manage every role below Super admin, but not other Super admins', () => {
    const otherSuper = person('super-2', 'superadmin');
    expect(check({ action: 'changeRole', actor: superadmin, target: peopleAdmin, toRole: 'admin-view', reason: 'step back' })).toMatchObject({ ok: true });
    expect(check({ action: 'invite', actor: superadmin, toRole: 'admin-content-people', reason: 'new lead' })).toMatchObject({ ok: true });
    for (const action of ['disable', 'enable', 'signOutEverywhere', 'resend'] as const) {
      expect(check({ action, actor: superadmin, target: otherSuper })).toMatchObject({ ok: false, code: 'rank' });
    }
    expect(check({ action: 'changeRole', actor: superadmin, target: otherSuper, toRole: 'admin-view', reason: 'demote' })).toMatchObject({ ok: false, code: 'rank' });
    // The owner manages Super admins.
    expect(check({ action: 'disable', actor: owner, target: otherSuper })).toMatchObject({ ok: true });
    expect(check({ action: 'changeRole', actor: owner, target: otherSuper, toRole: 'admin-view', reason: 'demote' })).toMatchObject({ ok: true });
  });

  it('people admins cannot act on their peers or above', () => {
    const otherPeopleAdmin = person('acp-2', 'admin-content-people');
    for (const action of ['disable', 'enable', 'signOutEverywhere', 'resend'] as const) {
      expect(check({ action, actor: peopleAdmin, target: otherPeopleAdmin })).toMatchObject({ ok: false, code: 'rank' });
      expect(check({ action, actor: peopleAdmin, target: superadmin })).toMatchObject({ ok: false, code: 'rank' });
    }
  });

  it('people admins manage content and view admins and plain members, and grant app roles', () => {
    expect(check({ action: 'disable', actor: peopleAdmin, target: contentAdmin })).toMatchObject({ ok: true });
    expect(check({ action: 'changeRole', actor: peopleAdmin, target: person('m', 'reviewer'), toRole: 'admin-view', reason: 'joined' })).toMatchObject({ ok: true });
    expect(check({ action: 'invite', actor: peopleAdmin, toRole: 'reviewer', knownRoles: ['reviewer'] })).toEqual({ ok: true, requiresRecentSignIn: false });
  });

  it('refuses removing a role above your level via fromRole', () => {
    expect(
      check({ action: 'changeRole', actor: peopleAdmin, target: contentAdmin, toRole: 'admin-view', fromRole: 'superadmin', reason: 'x y z' }),
    ).toMatchObject({ ok: false, code: 'rank' });
  });
});

describe('the owner role moves only by Transfer ownership', () => {
  it('is never granted by invite or role change, not even by the owner', () => {
    for (const actor of [owner, superadmin, peopleAdmin]) {
      expect(check({ action: 'invite', actor, toRole: 'owner', reason: 'co-owner' })).toMatchObject({ ok: false, code: 'owner_transfer' });
      expect(check({ action: 'changeRole', actor, target: contentAdmin, toRole: 'owner', reason: 'co-owner' })).toMatchObject({
        ok: false,
        code: 'owner_transfer',
      });
    }
  });

  it('nobody disables, deletes, or demotes the owner', () => {
    for (const actor of [superadmin, peopleAdmin]) {
      expect(check({ action: 'disable', actor, target: owner })).toMatchObject({ ok: false, code: 'last_owner' });
      expect(check({ action: 'delete', actor: superadmin, target: owner })).toMatchObject({ ok: false, code: 'last_owner' });
      expect(check({ action: 'changeRole', actor, target: owner, toRole: 'admin-view', reason: 'demote', ownerCount: 1 })).toMatchObject({
        ok: false,
        code: 'last_owner',
      });
    }
    for (const action of ['enable', 'signOutEverywhere', 'resend'] as const) {
      expect(check({ action, actor: superadmin, target: owner })).toMatchObject({ ok: false, code: 'rank' });
    }
  });

  it('an owner may demote an extra owner while more than one remains (repairing the site), never the last', () => {
    const extra = person('owner-2', 'owner');
    expect(check({ action: 'changeRole', actor: owner, target: extra, toRole: 'superadmin', fromRole: 'owner', reason: 'one owner', ownerCount: 2 })).toMatchObject({ ok: true });
    expect(check({ action: 'changeRole', actor: owner, target: extra, toRole: 'superadmin', reason: 'one owner', ownerCount: 1 })).toMatchObject({
      ok: false,
      code: 'last_owner',
    });
    expect(check({ action: 'changeRole', actor: owner, target: extra, toRole: 'superadmin', reason: 'one owner' })).toMatchObject({
      ok: false,
      code: 'owner_count_unknown',
    });
    // Disabling or deleting an owner always waits for the demotion.
    expect(check({ action: 'disable', actor: owner, target: extra, ownerCount: 3 })).toMatchObject({ ok: false, code: 'last_owner' });
  });

  it('a disabled account still in the owner group is out of everyone else’s reach', () => {
    expect(check({ action: 'enable', actor: superadmin, target: { ...owner, enabled: false } })).toMatchObject({ ok: false, code: 'rank' });
  });
});

describe('transfer ownership', () => {
  const accepted = (p: { sub: string; groups: string[] }) => ({ ...p, enabled: true, invite: 'accepted' as const });

  it('is the owner’s alone, with a reason and a recent sign-in', () => {
    expect(check({ action: 'transferOwnership', actor: owner, target: accepted(superadmin), reason: 'handing over' })).toEqual({
      ok: true,
      requiresRecentSignIn: true,
    });
    expect(check({ action: 'transferOwnership', actor: owner, target: accepted(member), reason: 'handing over' })).toMatchObject({ ok: true });
    expect(check({ action: 'transferOwnership', actor: superadmin, target: accepted(peopleAdmin), reason: 'take it' })).toMatchObject({
      ok: false,
      code: 'capability',
      reason: 'Only the owner can transfer ownership.',
    });
    expect(check({ action: 'transferOwnership', actor: owner, target: accepted(superadmin) })).toMatchObject({ ok: false, code: 'reason_required' });
  });

  it('needs the owner group itself, whatever an app map grants', () => {
    const imposter = { ...superadmin, capabilities: new Set(['owner.transfer']) };
    expect(check({ action: 'transferOwnership', actor: imposter, target: accepted(peopleAdmin), reason: 'take it' })).toMatchObject({
      ok: false,
      code: 'capability',
    });
  });

  it('goes only to an enabled account that has signed in, never to yourself or another owner', () => {
    expect(check({ action: 'transferOwnership', actor: owner, target: accepted(owner), reason: 'x y z' })).toMatchObject({ ok: false, code: 'self' });
    expect(check({ action: 'transferOwnership', actor: owner, target: accepted(person('owner-2', 'owner')), reason: 'x y z' })).toMatchObject({
      ok: false,
      code: 'state',
    });
    expect(check({ action: 'transferOwnership', actor: owner, target: { ...superadmin, enabled: false }, reason: 'x y z' })).toMatchObject({
      ok: false,
      code: 'state',
    });
    for (const invite of ['pending', 'expiring-soon', 'expired'] as const) {
      expect(check({ action: 'transferOwnership', actor: owner, target: { ...superadmin, enabled: true, invite }, reason: 'x y z' })).toMatchObject({
        ok: false,
        code: 'state',
      });
    }
  });
});

describe('reasons and step-up', () => {
  it('every role change records a reason', () => {
    expect(check({ action: 'changeRole', actor: peopleAdmin, target: viewAdmin, toRole: 'admin-content' })).toMatchObject({ ok: false, code: 'reason_required' });
    expect(check({ action: 'changeRole', actor: peopleAdmin, target: viewAdmin, toRole: 'admin-content', reason: '  ' })).toMatchObject({
      ok: false,
      code: 'reason_required',
    });
  });

  it('a promotion needs a recent sign-in; a demotion or app role does not', () => {
    expect(check({ action: 'changeRole', actor: peopleAdmin, target: viewAdmin, toRole: 'admin-content', reason: 'promoted' })).toEqual({
      ok: true,
      requiresRecentSignIn: true,
    });
    expect(check({ action: 'changeRole', actor: peopleAdmin, target: contentAdmin, toRole: 'admin-view', reason: 'demoted' })).toEqual({
      ok: true,
      requiresRecentSignIn: false,
    });
    expect(check({ action: 'invite', actor: peopleAdmin, toRole: 'admin-content' })).toEqual({ ok: true, requiresRecentSignIn: true });
  });
});

describe('role picker options', () => {
  it('offers every role but Owner, marks what you can’t grant, and says why', () => {
    const options = roleOptions(['superadmin'], 'admin-view');
    expect(options.map((o) => o.role)).toEqual(['superadmin', 'admin-content-people', 'admin-content', 'admin-view', 'member']);
    expect(options.map((o) => o.available)).toEqual([false, true, true, false, true]);
    expect(options[0]!.reason).toBe('Only the owner can grant Super admin.');
    expect(options[3]).toMatchObject({ current: true, reason: 'Their current role.' });
    for (const o of options) {
      expect(o.can).toBeTruthy();
      expect(o.cannot).toBeTruthy();
    }
  });

  it('gives people admins content and view roles plus Member; for an invite nothing is current', () => {
    const options = roleOptions(['admin-content-people']);
    expect(options.filter((o) => o.available).map((o) => o.role)).toEqual(['admin-content', 'admin-view', 'member']);
    expect(options.find((o) => o.role === 'admin-content-people')!.reason).toMatch(/below your own \(Admin . content & people\)/);
    expect(options.some((o) => o.current)).toBe(false);
  });

  it('gives the owner Super admin and below', () => {
    expect(roleOptions(['owner'], 'member').filter((o) => o.available).map((o) => o.role)).toEqual([
      'superadmin',
      'admin-content-people',
      'admin-content',
      'admin-view',
    ]);
  });
});

describe('input validation', () => {
  it('needs a target, a role where relevant, and a known action', () => {
    expect(check({ action: 'disable', actor: peopleAdmin })).toMatchObject({ ok: false, code: 'invalid' });
    expect(check({ action: 'transferOwnership', actor: owner, reason: 'x y z' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(check({ action: 'invite', actor: peopleAdmin })).toMatchObject({ ok: false, code: 'invalid' });
    expect(check({ action: 'explode' as never, actor: owner })).toMatchObject({ ok: false, code: 'invalid' });
  });
});

describe('invite status', () => {
  const day = 24 * 60 * 60 * 1000;
  const now = new Date('2026-10-17T12:00:00Z');
  const created = (daysAgo: number) => new Date(now.getTime() - daysAgo * day);
  it.each([
    [{ createdAt: created(1), emailVerified: false, enabled: true }, 'pending'],
    [{ createdAt: created(5.5), emailVerified: false, enabled: true }, 'expiring-soon'],
    [{ createdAt: created(7), emailVerified: false, enabled: true }, 'expired'],
    [{ createdAt: created(30), emailVerified: true, enabled: true }, 'accepted'],
    [{ createdAt: created(1), emailVerified: false, enabled: false }, 'disabled'],
  ])('%j -> %s', (user, status) => {
    expect(inviteStatus(user, now)).toBe(status);
  });
});

describe('every action has on-screen copy and named Cognito calls', () => {
  it.each(['emailed-code', 'temporary-password'] as const)('%s mode', (mode) => {
    const details = peopleActionDetails(mode);
    for (const action of PEOPLE_ACTIONS) {
      expect(PEOPLE_ACTION_COPY[action]).toBeTruthy();
      expect(details[action].says).toBeTruthy();
      expect(details[action].calls.length).toBeGreaterThan(0);
      expect(details[action].now).toBeTruthy();
    }
    expect(details.changeRole.later).toMatch(/60 minutes/);
  });
});

describe('role names are matched exactly (security review)', () => {
  it.each(['Owner', 'Superadmin', 'super-admin', ' superadmin', 'superadmin ', 'ADMIN-VIEW', 'admin', 'editor', 'viewer', 'root', '', 'admin-view\n'])(
    'refuses %j as a role',
    (role) => {
      expect(check({ action: 'invite', actor: owner, toRole: role })).toMatchObject({ ok: false, code: 'invalid' });
      expect(check({ action: 'changeRole', actor: owner, target: viewAdmin, toRole: role, reason: 'because' })).toMatchObject({ ok: false, code: 'invalid' });
    },
  );

  it('refuses unknown fromRole spellings too', () => {
    expect(
      check({ action: 'changeRole', actor: owner, target: contentAdmin, toRole: 'admin-view', fromRole: 'Admin-content', reason: 'x y z' }),
    ).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('accepts app roles only when the app names them', () => {
    expect(check({ action: 'invite', actor: peopleAdmin, toRole: 'reviewer' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(check({ action: 'invite', actor: peopleAdmin, toRole: 'Reviewer', knownRoles: ['reviewer'] })).toMatchObject({ ok: false, code: 'invalid' });
    expect(check({ action: 'invite', actor: peopleAdmin, toRole: 'member' })).toEqual({ ok: true, requiresRecentSignIn: false });
  });

  it('refuses non-string roles and malformed people', () => {
    expect(check({ action: 'invite', actor: owner, toRole: 4 as never })).toMatchObject({ ok: false, code: 'invalid' });
    expect(check({ action: 'invite', actor: owner, toRole: ['admin-view'] as never })).toMatchObject({ ok: false, code: 'invalid' });
    expect(check({ action: 'disable', actor: { sub: 'o', groups: 'owner' as never }, target: contentAdmin })).toMatchObject({ ok: false, code: 'invalid' });
    expect(check({ action: 'disable', actor: owner, target: { sub: '', groups: [] } })).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('gives near-miss and retired group names no rank and no power', () => {
    expect(isKnownRole('owner')).toBe(true);
    expect(isKnownRole('Owner')).toBe(false);
    for (const retired of ['admin', 'editor', 'viewer']) {
      expect(isKnownRole(retired)).toBe(false);
      expect(roleRank(retired)).toBe(0);
    }
    expect(highestAdminRole(['Owner', 'SUPERADMIN', ' superadmin', 'admin'])).toBeNull();
    expect(grantableRoles(['Owner'])).toEqual([]);
    expect(check({ action: 'disable', actor: person('x', 'admin'), target: member })).toMatchObject({ ok: false, code: 'capability' });
  });
});

describe('owner counts fail closed (security review)', () => {
  const extra = person('owner-2', 'owner');
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 1.5, '3' as never, null as never])('treats %j as unknown', (ownerCount) => {
    expect(check({ action: 'changeRole', actor: owner, target: extra, toRole: 'superadmin', reason: 'one owner', ownerCount })).toMatchObject({
      ok: false,
      code: 'owner_count_unknown',
    });
  });

  it('zero is a number, and still no demotion', () => {
    expect(check({ action: 'changeRole', actor: owner, target: extra, toRole: 'superadmin', reason: 'one owner', ownerCount: 0 })).toMatchObject({
      ok: false,
      code: 'last_owner',
    });
  });
});

describe('target state', () => {
  const t = (extra: object) => ({ ...viewAdmin, ...extra });
  it('resend only for an unused invite', () => {
    expect(check({ action: 'resend', actor: peopleAdmin, target: t({ invite: 'pending' }) })).toMatchObject({ ok: true });
    expect(check({ action: 'resend', actor: peopleAdmin, target: t({ invite: 'expiring-soon' }) })).toMatchObject({ ok: true });
    for (const invite of ['accepted', 'expired', 'disabled']) {
      expect(check({ action: 'resend', actor: peopleAdmin, target: t({ invite }) })).toMatchObject({ ok: false, code: 'state' });
    }
    expect(check({ action: 'resend', actor: peopleAdmin, target: t({ invite: 'accepted' }) })).toMatchObject({
      reason: 'Resend is only for invites nobody has used. It never changes an active account.',
    });
  });

  it('enable only a disabled account; disable only an enabled one; delete only after disabling', () => {
    expect(check({ action: 'enable', actor: peopleAdmin, target: t({ enabled: true }) })).toMatchObject({ ok: false, code: 'state' });
    expect(check({ action: 'enable', actor: peopleAdmin, target: t({ enabled: false }) })).toMatchObject({ ok: true });
    expect(check({ action: 'disable', actor: peopleAdmin, target: t({ enabled: false }) })).toMatchObject({ ok: false, code: 'state' });
    expect(check({ action: 'delete', actor: superadmin, target: t({ enabled: true }) })).toMatchObject({ ok: false, code: 'state' });
    expect(check({ action: 'delete', actor: superadmin, target: t({ enabled: false }) })).toMatchObject({ ok: true });
  });
});

describe('invite status by mode', () => {
  const now = new Date('2026-10-17T12:00:00Z');
  const created = new Date('2026-10-15T12:00:00Z');
  it('temporary-password: accepted once the one-time password is used, whatever email_verified says', () => {
    const mode = 'temporary-password' as const;
    expect(inviteStatus({ createdAt: created, emailVerified: false, enabled: true, status: 'FORCE_CHANGE_PASSWORD' }, now, { mode })).toBe('pending');
    expect(inviteStatus({ createdAt: created, emailVerified: false, enabled: true, status: 'CONFIRMED' }, now, { mode })).toBe('accepted');
  });

  it('emailed-code: an unused password means not accepted, even with a verified email', () => {
    expect(inviteStatus({ createdAt: created, emailVerified: true, enabled: true, status: 'FORCE_CHANGE_PASSWORD' }, now)).toBe('pending');
    expect(inviteStatus({ createdAt: created, emailVerified: true, enabled: true, status: 'CONFIRMED' }, now)).toBe('accepted');
  });

  it('an unreadable creation date never keeps an unused invite alive', () => {
    expect(inviteStatus({ createdAt: new Date(Number.NaN), emailVerified: false, enabled: true }, now)).toBe('expired');
  });

  it('expires 7 days after creation', () => {
    expect(inviteExpiresAt(created).toISOString()).toBe('2026-10-22T12:00:00.000Z');
  });
});
