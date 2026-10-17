import { describe, expect, it } from 'vitest';
import {
  checkPeopleAction,
  createDynamoAuditLog,
  createPeopleActions,
  grantableRoles,
  grantCeiling,
  highestAdminRole,
  inviteStatus,
  NotImplementedError,
  PEOPLE_ACTION_COPY,
  PEOPLE_ACTIONS,
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
    expect(check({ action: 'invite', actor: admin, toRole: 'reviewer' })).toMatchObject({ ok: true, requiresRecentSignIn: false });
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

describe('phase-2 stubs', () => {
  it('throw NotImplementedError and every action has on-screen copy', () => {
    expect(() => createDynamoAuditLog({ tableName: 't' })).toThrow(NotImplementedError);
    expect(() => createPeopleActions({} as never)).toThrow(NotImplementedError);
    for (const action of PEOPLE_ACTIONS) expect(PEOPLE_ACTION_COPY[action]).toBeTruthy();
  });
});
