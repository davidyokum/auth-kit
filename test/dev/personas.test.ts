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
  { key: 'owner', email: 'owner@orchard.test', groups: ['owner'] },
  { key: 'superadmin', email: 'superadmin@orchard.test', groups: ['superadmin'] },
  { key: 'admin-content-people', email: 'admin-content-people@orchard.test', groups: ['admin-content-people'] },
  { key: 'admin-content', email: 'admin-content@orchard.test', groups: ['admin-content'] },
  { key: 'admin-view', email: 'admin-view@orchard.test', groups: ['admin-view'] },
  { key: 'member', email: 'member@orchard.test', groups: [] },
];
const MEMBER = 5;

describe('personas.json', () => {
  it('accepts the documented file as written', () => {
    expect(parsePersonas(primer)).toEqual(primer);
  });

  it('defaults to one persona per admin role (one owner) plus a member with no group, all on .test, plus app roles', () => {
    expect(defaultPersonas().map((p) => [p.key, p.email, p.groups])).toEqual([
      ['owner', 'owner@personas.test', ['owner']],
      ['superadmin', 'superadmin@personas.test', ['superadmin']],
      ['admin-content-people', 'admin-content-people@personas.test', ['admin-content-people']],
      ['admin-content', 'admin-content@personas.test', ['admin-content']],
      ['admin-view', 'admin-view@personas.test', ['admin-view']],
      ['member', 'member@personas.test', []],
    ]);
    const withRoles = defaultPersonas({ domain: 'orchard.test', appRoles: ['reviewer'] });
    expect(withRoles.at(-1)).toEqual({ key: 'reviewer', email: 'reviewer@orchard.test', groups: ['reviewer'] });
    expect(parsePersonas(withRoles, { appRoles: ['reviewer'] })).toHaveLength(7);
    expect(personaEmail('admin-content')).toBe('admin-content@personas.test');
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
    ['a missing owner', primer.slice(1), /no persona has the "owner" role/],
    ['a missing admin role', primer.filter((p) => p.key !== 'admin-view'), /no persona has the "admin-view" role/],
    ['two owners (a site has exactly one)', [...primer, { key: 'owner-2', email: 'owner-2@orchard.test', groups: ['owner'] }], /2 personas have the "owner" role/],
    ['a retired group name', [...primer, { key: 'editor', email: 'editor@orchard.test', groups: ['editor'] }], /"editor" is a retired admin role; it's "admin-content" now/],
    ['no member', primer.slice(0, MEMBER), /no member persona/],
    ['duplicate keys', [...primer, { key: 'admin-view', email: 'view2@orchard.test', groups: ['admin-view'] }], /second persona with key "admin-view"/],
    ['duplicate emails', [...primer, { key: 'view-2', email: 'ADMIN-VIEW@orchard.test', groups: ['admin-view'] }], /duplicate email/],
    ['two admin roles on one persona', primer.map((p, i) => (i === 3 ? { ...p, groups: ['admin-content', 'admin-view'] } : p)), /2 admin roles/],
    ['a bad key', primer.map((p, i) => (i === MEMBER ? { ...p, key: 'Member One' } : p)), /\.key must be/],
    ['groups that are not a list', primer.map((p, i) => (i === MEMBER ? { ...p, groups: 'admin-view' } : p)), /\.groups must be a list/],
    ['an unknown field (a password)', primer.map((p, i) => (i === MEMBER ? { ...p, password: 'hunter2hunter2hunter2' } : p)), /unknown field "password"/],
    ['an attribute auth-kit sets', primer.map((p, i) => (i === MEMBER ? { ...p, attributes: { email_verified: 'false' } } : p)), /can't set "email_verified"/],
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
    expect(personaLabel({ key: 'admin-content', label: 'Copy editor' })).toBe('Copy editor');
    expect(personaEnvNames('admin-content-people')).toEqual({
      password: 'PERSONA_PASSWORD_ADMIN_CONTENT_PEOPLE',
      totpSecret: 'PERSONA_TOTP_ADMIN_CONTENT_PEOPLE',
    });
    expect(
      personaCredentialsFromEnv({ key: 'admin-content' }, { PERSONA_PASSWORD_ADMIN_CONTENT: 'p'.repeat(20), PERSONA_TOTP_ADMIN_CONTENT: 'JBSWY3DP' }),
    ).toEqual({
      password: 'p'.repeat(20),
      totpSecret: 'JBSWY3DP',
    });
    expect(personaCredentialsFromEnv({ key: 'admin-content' }, {})).toBeUndefined();
    expect(personaForEmail(parsePersonas(primer), ' Admin-Content@Orchard.test ')?.key).toBe('admin-content');
    expect(personaForEmail(parsePersonas(primer), 'someone@example.org')).toBeUndefined();
  });
});
