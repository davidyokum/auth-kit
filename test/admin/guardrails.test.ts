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
  roleRank,
  type GuardrailInput,
} from '../../src/admin/index.js';

const person = (sub: string, ...groups: string[]) => ({ sub, groups });
const owner = person('owner-1', 'superadmin');
const admin = person('admin-1', 'admin');
const editor = person('editor-1', 'editor');

function check(input: Partial<GuardrailInput> & Pick<GuardrailInput, 'action' | 'actor'>) {
  return checkPeopleAction(input);
}

describe('role ranks', () => {
  it('finds the highest admin role and ignores app roles', () => {
    expect(highestAdminRole(['reviewer', 'editor', 'viewer'])).toBe('editor');
    expect(highestAdminRole(['reviewer'])).toBeNull();
  });

  it('lets owners grant every role and others only roles below their own', () => {
    expect(grantableRoles(['superadmin'])).toEqual(['superadmin', 'admin', 'editor', 'viewer']);
    expect(grantableRoles(['admin'])).toEqual(['editor', 'viewer']);
    expect(grantableRoles(['editor'])).toEqual(['viewer']);
    expect(grantableRoles(['reviewer'])).toEqual([]);
    expect(grantCeiling([])).toBe(0);
  });
});

describe('capabilities per action', () => {
  it('needs people.manage to invite, roles.manage to change roles, data.delete to delete', () => {
    expect(check({ action: 'invite', actor: editor, toRole: 'viewer' })).toMatchObject({ ok: false, code: 'capability' });
    expect(check({ action: 'invite', actor: admin, toRole: 'viewer' })).toMatchObject({ ok: true });
    expect(check({ action: 'delete', actor: admin, target: editor, reason: 'left' })).toMatchObject({
      ok: false,
      code: 'capability',
      reason: 'Only owners can delete accounts.',
    });
    expect(check({ action: 'delete', actor: owner, target: editor })).toMatchObject({ ok: true });
  });

  it('honors an app capability map passed with the actor', () => {
    const contentOnlyAdmin = { ...admin, capabilities: new Set(['content.edit']) };
    expect(check({ action: 'disable', actor: contentOnlyAdmin, target: editor })).toMatchObject({ ok: false, code: 'capability' });
  });
});

describe('nobody acts on themselves', () => {
  it.each(['changeRole', 'disable', 'delete'] as const)('%s on yourself is refused', (action) => {
    expect(check({ action, actor: owner, target: owner, toRole: 'admin', reason: 'testing', ownerCount: 5 })).toMatchObject({
      ok: false,
      code: 'self',
    });
  });

  it('signing yourself out everywhere is fine', () => {
    expect(check({ action: 'signOutEverywhere', actor: admin, target: admin })).toEqual({ ok: true, requiresRecentSignIn: false });
  });
});

describe('grant and act only below your own level', () => {
  it('admins can grant editor and viewer but not admin or owner', () => {
    expect(check({ action: 'invite', actor: admin, toRole: 'editor' })).toMatchObject({ ok: true });
    expect(check({ action: 'invite', actor: admin, toRole: 'admin' })).toMatchObject({ ok: false, code: 'rank' });
    expect(check({ action: 'invite', actor: admin, toRole: 'superadmin' })).toMatchObject({ ok: false, code: 'rank' });
  });

  it('admins cannot act on other admins or owners', () => {
    const otherAdmin = person('admin-2', 'admin');
    for (const action of ['disable', 'enable', 'signOutEverywhere', 'resend'] as const) {
      expect(check({ action, actor: admin, target: otherAdmin })).toMatchObject({ ok: false, code: 'rank' });
      expect(check({ action, actor: admin, target: owner, ownerCount: 2 })).toMatchObject({ ok: false, code: 'rank' });
    }
    expect(check({ action: 'changeRole', actor: admin, target: otherAdmin, toRole: 'viewer', reason: 'demote' })).toMatchObject({
      ok: false,
      code: 'rank',
    });
  });

  it('admins can manage editors, viewers, and plain members, and grant app roles', () => {
    expect(check({ action: 'disable', actor: admin, target: editor })).toMatchObject({ ok: true });
    expect(check({ action: 'changeRole', actor: admin, target: person('m', 'reviewer'), toRole: 'viewer', reason: 'joined' })).toMatchObject({ ok: true });
    expect(check({ action: 'invite', actor: admin, toRole: 'reviewer', knownRoles: ['reviewer'] })).toMatchObject({
      ok: true,
      requiresRecentSignIn: false,
    });
  });

  it('owners may make owners', () => {
    expect(check({ action: 'changeRole', actor: owner, target: admin, toRole: 'superadmin', reason: 'second owner' })).toMatchObject({
      ok: true,
      requiresRecentSignIn: true,
    });
  });

  it('refuses removing a role above your level via fromRole', () => {
    expect(check({ action: 'changeRole', actor: admin, target: editor, toRole: 'viewer', fromRole: 'admin', reason: 'x y z' })).toMatchObject({
      ok: false,
      code: 'rank',
    });
  });
});

describe('the last owner', () => {
  const otherOwner = person('owner-2', 'superadmin');
  it.each([
    ['disable', {}],
    ['delete', {}],
    ['changeRole', { toRole: 'admin', reason: 'stepping back' }],
  ] as const)('cannot be removed by %s when they are the only one', (action, extra) => {
    expect(check({ action, actor: owner, target: otherOwner, ownerCount: 1, ...extra })).toMatchObject({ ok: false, code: 'last_owner' });
    expect(check({ action, actor: owner, target: otherOwner, ownerCount: 2, ...extra })).toMatchObject({ ok: true });
  });

  it('treats an unknown owner count as a no', () => {
    expect(check({ action: 'disable', actor: owner, target: otherOwner })).toMatchObject({ ok: false, code: 'owner_count_unknown' });
  });

  it('allows owner-to-owner role edits that keep them an owner', () => {
    expect(check({ action: 'changeRole', actor: owner, target: otherOwner, toRole: 'superadmin', reason: 'no-op', ownerCount: 1 })).toMatchObject({
      ok: true,
    });
  });
});

describe('reasons and step-up', () => {
  it('every role change records a reason', () => {
    expect(check({ action: 'changeRole', actor: admin, target: person('v', 'viewer'), toRole: 'editor' })).toMatchObject({
      ok: false,
      code: 'reason_required',
    });
    expect(check({ action: 'changeRole', actor: admin, target: person('v', 'viewer'), toRole: 'editor', reason: '  ' })).toMatchObject({
      ok: false,
      code: 'reason_required',
    });
  });

  it('a promotion needs a recent sign-in; a demotion or app role does not', () => {
    const viewer = person('v', 'viewer');
    expect(check({ action: 'changeRole', actor: admin, target: viewer, toRole: 'editor', reason: 'promoted' })).toEqual({ ok: true, requiresRecentSignIn: true });
    expect(check({ action: 'changeRole', actor: admin, target: editor, toRole: 'viewer', reason: 'demoted' })).toEqual({ ok: true, requiresRecentSignIn: false });
    expect(check({ action: 'invite', actor: admin, toRole: 'editor' })).toEqual({ ok: true, requiresRecentSignIn: true });
  });
});

describe('input validation', () => {
  it('needs a target, a role where relevant, and a known action', () => {
    expect(check({ action: 'disable', actor: admin })).toMatchObject({ ok: false, code: 'invalid' });
    expect(check({ action: 'invite', actor: admin })).toMatchObject({ ok: false, code: 'invalid' });
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
  it.each(['Admin', ' admin', 'admin ', 'ADMIN', 'superAdmin', 'owner', 'Owner', 'root', '', 'editor\n'])('refuses %j as a role', (role) => {
    expect(check({ action: 'invite', actor: owner, toRole: role })).toMatchObject({ ok: false, code: 'invalid' });
    expect(
      check({ action: 'changeRole', actor: owner, target: person('t', 'viewer'), toRole: role, reason: 'because' }),
    ).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('refuses unknown fromRole spellings too', () => {
    expect(check({ action: 'changeRole', actor: owner, target: editor, toRole: 'viewer', fromRole: 'Editor', reason: 'x y z' })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
  });

  it('accepts app roles only when the app names them', () => {
    expect(check({ action: 'invite', actor: admin, toRole: 'reviewer' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(check({ action: 'invite', actor: admin, toRole: 'Reviewer', knownRoles: ['reviewer'] })).toMatchObject({ ok: false, code: 'invalid' });
    expect(check({ action: 'invite', actor: admin, toRole: 'member' })).toMatchObject({ ok: true, requiresRecentSignIn: false });
  });

  it('refuses non-string roles and malformed people', () => {
    expect(check({ action: 'invite', actor: owner, toRole: 4 as never })).toMatchObject({ ok: false, code: 'invalid' });
    expect(check({ action: 'invite', actor: owner, toRole: ['admin'] as never })).toMatchObject({ ok: false, code: 'invalid' });
    expect(check({ action: 'disable', actor: { sub: 'o', groups: 'superadmin' as never }, target: editor })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    expect(check({ action: 'disable', actor: owner, target: { sub: '', groups: [] } })).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('gives near-miss group names no rank and no power', () => {
    expect(isKnownRole('superadmin')).toBe(true);
    expect(isKnownRole('Superadmin')).toBe(false);
    expect(roleRank('Admin')).toBe(0);
    expect(highestAdminRole(['Admin', 'SUPERADMIN', ' superadmin'])).toBeNull();
    expect(grantableRoles(['Superadmin'])).toEqual([]);
    expect(check({ action: 'disable', actor: person('x', 'Admin'), target: editor })).toMatchObject({ ok: false, code: 'capability' });
  });
});

describe('owner counts fail closed (security review)', () => {
  const otherOwner = person('owner-2', 'superadmin');
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 1.5, '3' as never, null as never])(
    'treats %j as unknown',
    (ownerCount) => {
      for (const extra of [{ action: 'disable' }, { action: 'delete' }, { action: 'changeRole', toRole: 'admin', reason: 'stepping back' }] as const) {
        expect(check({ actor: owner, target: otherOwner, ownerCount, ...extra })).toMatchObject({ ok: false, code: 'owner_count_unknown' });
      }
    },
  );

  it('zero is a number, and still the last owner', () => {
    expect(check({ action: 'disable', actor: owner, target: otherOwner, ownerCount: 0 })).toMatchObject({ ok: false, code: 'last_owner' });
  });

  it('a disabled owner is no longer counted as one', () => {
    expect(check({ action: 'delete', actor: owner, target: { ...otherOwner, enabled: false } })).toMatchObject({ ok: true });
  });
});

describe('target state', () => {
  const t = (extra: object) => ({ ...person('t', 'viewer'), ...extra });
  it('resend only for an unused invite', () => {
    expect(check({ action: 'resend', actor: admin, target: t({ invite: 'pending' }) })).toMatchObject({ ok: true });
    expect(check({ action: 'resend', actor: admin, target: t({ invite: 'expiring-soon' }) })).toMatchObject({ ok: true });
    for (const invite of ['accepted', 'expired', 'disabled']) {
      expect(check({ action: 'resend', actor: admin, target: t({ invite }) })).toMatchObject({ ok: false, code: 'state' });
    }
    expect(check({ action: 'resend', actor: admin, target: t({ invite: 'accepted' }) })).toMatchObject({
      reason: 'Resend is only for invites nobody has used. It never changes an active account.',
    });
  });

  it('enable only a disabled account; disable only an enabled one; delete only after disabling', () => {
    expect(check({ action: 'enable', actor: admin, target: t({ enabled: true }) })).toMatchObject({ ok: false, code: 'state' });
    expect(check({ action: 'enable', actor: admin, target: t({ enabled: false }) })).toMatchObject({ ok: true });
    expect(check({ action: 'disable', actor: admin, target: t({ enabled: false }) })).toMatchObject({ ok: false, code: 'state' });
    expect(check({ action: 'delete', actor: owner, target: t({ enabled: true }) })).toMatchObject({ ok: false, code: 'state' });
    expect(check({ action: 'delete', actor: owner, target: t({ enabled: false }) })).toMatchObject({ ok: true });
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
