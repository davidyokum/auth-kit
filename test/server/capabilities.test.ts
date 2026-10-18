import { describe, expect, it } from 'vitest';
import {
  ADMIN_ROLE_LABEL,
  defineCapabilities,
  ROLE_DESCRIPTIONS,
  ROLE_MATRIX,
  ROLE_MATRIX_CAPABILITIES,
  STANDARD_CAPABILITIES,
  STANDARD_GROUPS,
  standardCapabilities,
} from '../../src/server/index.js';

const DASH = String.fromCharCode(0x2013);

describe('the standard capability map (ADR 0020)', () => {
  // The decision of 2026-10-18, written out: each role holds everything below it.
  const DECIDED = {
    'admin-view': ['content.read', 'people.read', 'audit.read'],
    'admin-content': ['content.read', 'people.read', 'audit.read', 'content.edit', 'content.publish'],
    'admin-content-people': ['content.read', 'people.read', 'audit.read', 'content.edit', 'content.publish', 'people.manage', 'roles.manage'],
    superadmin: [
      'content.read',
      'people.read',
      'audit.read',
      'content.edit',
      'content.publish',
      'people.manage',
      'roles.manage',
      'settings.security',
      'data.export',
      'data.delete',
    ],
    owner: [
      'content.read',
      'people.read',
      'audit.read',
      'content.edit',
      'content.publish',
      'people.manage',
      'roles.manage',
      'settings.security',
      'data.export',
      'data.delete',
      'owner.private',
      'owner.transfer',
    ],
  };

  it('matches the decision exactly', () => {
    expect(Object.keys(STANDARD_CAPABILITIES)).toEqual([...STANDARD_GROUPS]);
    for (const [group, caps] of Object.entries(DECIDED)) {
      expect([...STANDARD_CAPABILITIES[group as keyof typeof STANDARD_CAPABILITIES]].sort()).toEqual([...caps].sort());
    }
  });

  it('is a ladder: each role includes everything below it', () => {
    for (let i = 0; i < STANDARD_GROUPS.length - 1; i++) {
      const higher = new Set<string>(STANDARD_CAPABILITIES[STANDARD_GROUPS[i]!]);
      for (const cap of STANDARD_CAPABILITIES[STANDARD_GROUPS[i + 1]!]) expect(higher.has(cap)).toBe(true);
    }
  });

  it('keeps content and people as separate keys, and owner-only powers to the owner', () => {
    expect(standardCapabilities.can(['admin-content'], 'people.manage')).toBe(false);
    expect(standardCapabilities.can(['admin-content-people'], 'people.manage')).toBe(true);
    expect(standardCapabilities.can(['admin-content-people'], 'settings.security')).toBe(false);
    expect(standardCapabilities.can(['admin-content-people'], 'data.delete')).toBe(false);
    expect(standardCapabilities.can(['superadmin'], 'data.delete')).toBe(true);
    expect(standardCapabilities.can(['superadmin'], 'owner.private')).toBe(false);
    expect(standardCapabilities.groupsWith('owner.private')).toEqual(['owner']);
    expect(standardCapabilities.groupsWith('owner.transfer')).toEqual(['owner']);
  });

  it('lets every admin role see the admin area, and no admin role below people admins change people', () => {
    expect(standardCapabilities.groupsWith('audit.read')).toEqual([...STANDARD_GROUPS]);
    expect(standardCapabilities.groupsWith('people.read')).toEqual([...STANDARD_GROUPS]);
    expect(standardCapabilities.groupsWith('people.manage')).toEqual(['owner', 'superadmin', 'admin-content-people']);
    expect(standardCapabilities.groupsWith('content.edit')).toEqual(['owner', 'superadmin', 'admin-content-people', 'admin-content']);
  });
});

describe('labels, descriptions, and the role matrix', () => {
  it('uses the exact labels, with an en dash', () => {
    expect(ADMIN_ROLE_LABEL).toEqual({
      owner: 'Owner',
      superadmin: 'Super admin',
      'admin-content-people': `Admin ${DASH} content & people`,
      'admin-content': `Admin ${DASH} content only`,
      'admin-view': `Admin ${DASH} view only`,
    });
  });

  it('describes every role, Member included, in one line each of can and can’t', () => {
    for (const role of [...STANDARD_GROUPS, 'member'] as const) {
      const d = ROLE_DESCRIPTIONS[role];
      expect(d.can.length).toBeGreaterThan(10);
      expect(d.cannot.length).toBeGreaterThan(5);
      expect(d.can + d.cannot).not.toMatch(/\n|record/i);
    }
  });

  it('has a row per role, highest first, then Member, and the decided columns', () => {
    expect(ROLE_MATRIX.rows.map((r) => r.role)).toEqual([...STANDARD_GROUPS, 'member']);
    expect(ROLE_MATRIX.rows.at(-1)!.label).toBe('Member');
    expect(ROLE_MATRIX.columns).toEqual(['View everything', 'Edit any content', 'Manage people', 'Security, exports, deletion', 'Owner-only pages']);
  });

  it('says yes exactly where the capability map does', () => {
    const yes = (role: string) => ROLE_MATRIX.columns.filter((c) => ROLE_MATRIX.rows.find((r) => r.role === role)!.cells[c].allowed);
    expect(yes('owner')).toEqual([...ROLE_MATRIX.columns]);
    expect(yes('superadmin')).toEqual(['View everything', 'Edit any content', 'Manage people', 'Security, exports, deletion']);
    expect(yes('admin-content-people')).toEqual(['View everything', 'Edit any content', 'Manage people']);
    expect(yes('admin-content')).toEqual(['View everything', 'Edit any content']);
    expect(yes('admin-view')).toEqual(['View everything']);
    expect(yes('member')).toEqual([]);
    for (const row of ROLE_MATRIX.rows) {
      if (row.role === 'member') continue;
      const held = new Set<string>(STANDARD_CAPABILITIES[row.role]);
      for (const c of ROLE_MATRIX.columns) expect(row.cells[c].allowed).toBe(ROLE_MATRIX_CAPABILITIES[c].every((cap) => held.has(cap)));
    }
  });

  it('qualifies "Manage people" by level', () => {
    const note = (role: string) => ROLE_MATRIX.rows.find((r) => r.role === role)!.cells['Manage people'].note;
    expect(note('superadmin')).toBe('Roles below Super admin');
    expect(note('admin-content-people')).toBe('Roles below their own');
    expect(Object.isFrozen(ROLE_MATRIX.rows[0])).toBe(true);
  });
});

describe('defineCapabilities', () => {
  const caps = defineCapabilities({ ...STANDARD_CAPABILITIES, reviewer: ['reviews.read', 'reviews.comment'] });

  it('unions capabilities across groups and ignores unknown groups', () => {
    expect([...caps.capabilitiesOf(['admin-view', 'reviewer', 'unknown'])].sort()).toEqual([
      'audit.read',
      'content.read',
      'people.read',
      'reviews.comment',
      'reviews.read',
    ]);
    expect(caps.can(['unknown'], 'content.read')).toBe(false);
    expect(caps.can(['admin'], 'content.read')).toBe(false); // a retired name grants nothing
    expect(caps.can([], 'content.read')).toBe(false);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(caps)).toBe(true);
    expect(Object.isFrozen(caps.map)).toBe(true);
    expect(Object.isFrozen(caps.map['admin-content-people'])).toBe(true);
  });

  it('rejects misnamed capabilities', () => {
    expect(() => defineCapabilities({ admin: ['manage'] })).toThrow(/dotted/);
    expect(() => defineCapabilities({ admin: ['People.Manage'] })).toThrow(/dotted/);
    expect(() => defineCapabilities({ admin: ['people manage'] })).toThrow(/dotted/);
  });

  it('rejects a capability that is a group name (check capabilities, not roles)', () => {
    expect(() => defineCapabilities({ 'team.lead': ['content.read'], admin: ['team.lead'] })).toThrow(/group name/);
  });

  it('rejects an empty map', () => {
    expect(() => defineCapabilities({})).toThrow(/at least one group/);
  });

  it('type-checks capability names', () => {
    // @ts-expect-error: not a capability in this map
    expect(caps.can(['admin-content-people'], 'reviews.delete')).toBe(false);
    expect(caps.can(['reviewer'], 'reviews.read')).toBe(true);
  });
});
