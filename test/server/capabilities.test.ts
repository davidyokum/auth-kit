import { describe, expect, it } from 'vitest';
import { defineCapabilities, STANDARD_CAPABILITIES, standardCapabilities } from '../../src/server/index.js';

describe('the standard capability map (mirrors the primer model)', () => {
  // primer-src/model.js CAPS, with owner = superadmin.
  const MODEL = {
    viewer: ['content.read'],
    editor: ['content.read', 'content.edit', 'content.publish'],
    admin: ['content.read', 'content.edit', 'content.publish', 'people.manage', 'roles.manage', 'audit.read'],
    superadmin: ['content.read', 'content.edit', 'content.publish', 'people.manage', 'roles.manage', 'audit.read', 'data.export', 'settings.security', 'data.delete'],
  };

  it('matches the model exactly', () => {
    for (const [group, caps] of Object.entries(MODEL)) {
      expect([...STANDARD_CAPABILITIES[group as keyof typeof STANDARD_CAPABILITIES]].sort()).toEqual([...caps].sort());
    }
  });

  it('keeps content and people as separate keys', () => {
    expect(standardCapabilities.can(['editor'], 'people.manage')).toBe(false);
    expect(standardCapabilities.can(['admin'], 'people.manage')).toBe(true);
    expect(standardCapabilities.can(['admin'], 'settings.security')).toBe(false);
    expect(standardCapabilities.can(['admin'], 'data.delete')).toBe(false);
    expect(standardCapabilities.can(['superadmin'], 'data.delete')).toBe(true);
  });

  it('lists the groups that grant a capability', () => {
    expect(standardCapabilities.groupsWith('people.manage')).toEqual(['superadmin', 'admin']);
    expect(standardCapabilities.groupsWith('content.read')).toEqual(['superadmin', 'admin', 'editor', 'viewer']);
  });
});

describe('defineCapabilities', () => {
  const caps = defineCapabilities({ ...STANDARD_CAPABILITIES, reviewer: ['reviews.read', 'reviews.comment'] });

  it('unions capabilities across groups and ignores unknown groups', () => {
    expect([...caps.capabilitiesOf(['viewer', 'reviewer', 'unknown'])].sort()).toEqual(['content.read', 'reviews.comment', 'reviews.read']);
    expect(caps.can(['unknown'], 'content.read')).toBe(false);
    expect(caps.can([], 'content.read')).toBe(false);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(caps)).toBe(true);
    expect(Object.isFrozen(caps.map)).toBe(true);
    expect(Object.isFrozen(caps.map.admin)).toBe(true);
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
    expect(caps.can(['admin'], 'reviews.delete')).toBe(false);
    expect(caps.can(['reviewer'], 'reviews.read')).toBe(true);
  });
});
