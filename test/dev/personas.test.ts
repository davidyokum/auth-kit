import { describe, expect, it } from 'vitest';
import {
  defaultPersonas,
  parsePersonas,
  personaCredentialsFromEnv,
  personaEmail,
  personaEnvNames,
  personaForEmail,
  personaLabel,
} from '../../src/dev/index.js';

const primer = [
  { key: 'superadmin', email: 'superadmin@orchard.test', groups: ['superadmin'] },
  { key: 'admin', email: 'admin@orchard.test', groups: ['admin'] },
  { key: 'editor', email: 'editor@orchard.test', groups: ['editor'] },
  { key: 'viewer', email: 'viewer@orchard.test', groups: ['viewer'] },
  { key: 'member', email: 'member@orchard.test', groups: [] },
];

describe('personas.json', () => {
  it("accepts the primer's file as written", () => {
    expect(parsePersonas(primer)).toEqual(primer);
  });

  it('defaults to one persona per admin role plus a member with no group, all on .test, plus app roles', () => {
    expect(defaultPersonas().map((p) => [p.key, p.email, p.groups])).toEqual([
      ['superadmin', 'superadmin@personas.test', ['superadmin']],
      ['admin', 'admin@personas.test', ['admin']],
      ['editor', 'editor@personas.test', ['editor']],
      ['viewer', 'viewer@personas.test', ['viewer']],
      ['member', 'member@personas.test', []],
    ]);
    const withRoles = defaultPersonas({ domain: 'orchard.test', appRoles: ['reviewer'] });
    expect(withRoles.at(-1)).toEqual({ key: 'reviewer', email: 'reviewer@orchard.test', groups: ['reviewer'] });
    expect(parsePersonas(withRoles, { appRoles: ['reviewer'] })).toHaveLength(6);
    expect(personaEmail('editor')).toBe('editor@personas.test');
    expect(() => defaultPersonas({ domain: 'example.com' })).toThrow(/\.test/);
  });

  it('allows a second member (the auth matrix needs one) and labels, attributes', () => {
    const personas = parsePersonas([
      ...primer,
      { key: 'member-2', email: 'Member2@Orchard.test', groups: [], label: 'Second member', attributes: { name: 'Member Two' } },
    ]);
    expect(personas.at(-1)).toEqual({ key: 'member-2', email: 'member2@orchard.test', groups: [], label: 'Second member', attributes: { name: 'Member Two' } });
  });

  it.each([
    ['a real-looking address', primer.map((p, i) => (i === 0 ? { ...p, email: 'owner@example.com' } : p)), /\.test/],
    ['a bare .test TLD address', primer.map((p, i) => (i === 0 ? { ...p, email: 'owner@test' } : p)), /\.test/],
    ['a missing admin role', primer.slice(1), /no persona has the "superadmin" role/],
    ['no member', primer.slice(0, 4), /no member persona/],
    ['duplicate keys', [...primer, { key: 'admin', email: 'admin2@orchard.test', groups: ['admin'] }], /second persona with key "admin"/],
    ['duplicate emails', [...primer, { key: 'admin-2', email: 'ADMIN@orchard.test', groups: ['admin'] }], /duplicate email/],
    ['two admin roles on one persona', primer.map((p, i) => (i === 2 ? { ...p, groups: ['editor', 'admin'] } : p)), /2 admin roles/],
    ['a bad key', primer.map((p, i) => (i === 4 ? { ...p, key: 'Member One' } : p)), /\.key must be/],
    ['groups that are not a list', primer.map((p, i) => (i === 4 ? { ...p, groups: 'admin' } : p)), /\.groups must be a list/],
    ['an unknown field (a password)', primer.map((p, i) => (i === 4 ? { ...p, password: 'hunter2hunter2hunter2' } : p)), /unknown field "password"/],
    ['an attribute auth-kit sets', primer.map((p, i) => (i === 4 ? { ...p, attributes: { email_verified: 'false' } } : p)), /can't set "email_verified"/],
    ['not an array', {}, /array/],
  ])('refuses %s', (_label, input, message) => {
    expect(() => parsePersonas(input)).toThrow(message);
  });

  it('with appRoles, refuses unknown groups and app roles nobody has', () => {
    expect(() => parsePersonas([...primer, { key: 'x', email: 'x@orchard.test', groups: ['reviewr'] }], { appRoles: ['reviewer'] })).toThrow(
      /"reviewr" isn't an admin role or one of the app roles/,
    );
    expect(() => parsePersonas(primer, { appRoles: ['reviewer'] })).toThrow(/no persona has the app role "reviewer"/);
  });

  it('names env vars, labels, and lookups', () => {
    expect(personaEnvNames('member-2')).toEqual({ password: 'PERSONA_PASSWORD_MEMBER_2', totpSecret: 'PERSONA_TOTP_MEMBER_2' });
    expect(personaLabel({ key: 'member-2' })).toBe('Member 2');
    expect(personaLabel({ key: 'editor', label: 'Copy editor' })).toBe('Copy editor');
    expect(personaCredentialsFromEnv({ key: 'editor' }, { PERSONA_PASSWORD_EDITOR: 'p'.repeat(20), PERSONA_TOTP_EDITOR: 'JBSWY3DP' })).toEqual({
      password: 'p'.repeat(20),
      totpSecret: 'JBSWY3DP',
    });
    expect(personaCredentialsFromEnv({ key: 'editor' }, {})).toBeUndefined();
    expect(personaForEmail(parsePersonas(primer), ' Editor@Orchard.test ')?.key).toBe('editor');
    expect(personaForEmail(parsePersonas(primer), 'someone@example.org')).toBeUndefined();
  });
});
