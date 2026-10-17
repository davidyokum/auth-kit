/**
 * `personas.json`: the only list of test accounts (primer Chapter 8, "Under the hood").
 *
 * ```json
 * [
 *   { "key": "superadmin", "email": "superadmin@orchard.test", "groups": ["superadmin"] },
 *   { "key": "admin",      "email": "admin@orchard.test",      "groups": ["admin"] },
 *   { "key": "editor",     "email": "editor@orchard.test",     "groups": ["editor"] },
 *   { "key": "viewer",     "email": "viewer@orchard.test",     "groups": ["viewer"] },
 *   { "key": "member",     "email": "member@orchard.test",     "groups": [] },
 *   { "key": "reviewer",   "email": "reviewer@orchard.test",   "groups": ["reviewer"] }
 * ]
 * ```
 *
 * Passwords and authenticator secrets never go in this file. They live in the git-ignored
 * `.env.local` as `PERSONA_PASSWORD_<KEY>` and `PERSONA_TOTP_<KEY>`, written by the seed script.
 */
import { DEV_POLICY, STANDARD_GROUPS } from '../shared/policy.js';

export type PersonaRole = (typeof DEV_POLICY.personaRoles)[number];

export interface Persona {
  /** A short id (`editor`, `member-2`, `reviewer`). Names the env vars and the menu entry. */
  key: string;
  /** Ends in `.test` (a reserved TLD that never delivers mail). Also the sign-in name. */
  email: string;
  /** Cognito groups: at most one admin role, plus app roles. Empty means a member with no group. */
  groups: string[];
  /** The menu and ribbon label, shown with "(test)". Default: from the key ("Member 2"). */
  label?: string;
  /** Extra user attributes, for pools that require them (e.g. `{ "name": "Editor Test" }`). */
  attributes?: Record<string, string>;
}

export interface ParsePersonasOptions {
  /**
   * The app's roles (the preset's `appRoles`). When given, every group must be an admin role or one
   * of these, and every app role needs a persona. When omitted, any other group counts as an app role.
   */
  appRoles?: readonly string[];
}

const KEY_RE = /^[a-z][a-z0-9-]{0,31}$/;
const TEST_EMAIL_RE = /^[^\s@]+@([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+test$/;
const GROUP_RE = /^[\w+=,.@-]{1,128}$/;
const RESERVED_ATTRIBUTES = new Set(['email', 'email_verified', 'sub', 'phone_number_verified']);

/** `role@personas.test` (or another `.test` domain). */
export function personaEmail(role: string, domain: string = DEV_POLICY.personaEmailDomain): string {
  return `${role}@${domain}`;
}

/** The primer's five personas (one per admin role and a member with no group), plus one per app role. */
export function defaultPersonas(options: { domain?: string; appRoles?: readonly string[] } = {}): Persona[] {
  const domain = options.domain ?? DEV_POLICY.personaEmailDomain;
  if (!domain.endsWith('.test')) throw new Error(`auth-kit: persona domain "${domain}" must end in ".test".`);
  const standard = DEV_POLICY.personaRoles.map((role) => ({
    key: role,
    email: personaEmail(role, domain),
    groups: role === 'member' ? [] : [role],
  }));
  const app = (options.appRoles ?? []).map((role) => ({ key: role, email: personaEmail(role, domain), groups: [role] }));
  return [...standard, ...app];
}

/**
 * Validates `personas.json` and returns the personas. Refuses: a missing admin role or member, an
 * address that doesn't end in `.test`, duplicate keys or addresses, more than one admin role on one
 * persona, and (with `appRoles`) unknown groups or an app role nobody has.
 */
export function parsePersonas(input: unknown, options: ParsePersonasOptions = {}): Persona[] {
  if (!Array.isArray(input)) throw new Error('auth-kit: personas.json must be an array of personas.');
  const standard = STANDARD_GROUPS as readonly string[];
  const appRoles = options.appRoles;
  const problems: string[] = [];
  const keys = new Set<string>();
  const emails = new Set<string>();
  const personas: Persona[] = [];

  for (const [i, raw] of input.entries()) {
    const where = `personas[${i}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      problems.push(`${where} isn't an object.`);
      continue;
    }
    const p = raw as Record<string, unknown>;
    for (const field of Object.keys(p)) {
      if (!['key', 'email', 'groups', 'label', 'attributes'].includes(field)) problems.push(`${where}: unknown field "${field}".`);
    }
    const key = typeof p.key === 'string' ? p.key : '';
    if (!KEY_RE.test(key)) problems.push(`${where}.key must be lowercase letters, digits, and hyphens (e.g. "editor").`);
    else if (keys.has(key)) problems.push(`${where}: a second persona with key "${key}".`);
    else keys.add(key);

    const email = typeof p.email === 'string' ? p.email.trim().toLowerCase() : '';
    if (!TEST_EMAIL_RE.test(email)) problems.push(`${where}.email must be an address on a ".test" domain.`);
    else if (emails.has(email)) problems.push(`${where}: duplicate email ${email}.`);
    else emails.add(email);

    let groups: string[] = [];
    if (!Array.isArray(p.groups) || p.groups.some((g) => typeof g !== 'string' || !GROUP_RE.test(g))) {
      problems.push(`${where}.groups must be a list of group names ([] for a member with no group).`);
    } else {
      groups = p.groups as string[];
      if (new Set(groups).size !== groups.length) problems.push(`${where}.groups lists a group twice.`);
      const adminRoles = groups.filter((g) => standard.includes(g));
      if (adminRoles.length > 1) problems.push(`${where} has ${adminRoles.length} admin roles; give each role its own persona.`);
      if (appRoles) {
        for (const g of groups) {
          if (!standard.includes(g) && !appRoles.includes(g)) problems.push(`${where}: "${g}" isn't an admin role or one of the app roles.`);
        }
      }
    }

    if (p.label !== undefined && (typeof p.label !== 'string' || !p.label.trim())) problems.push(`${where}.label must be text.`);

    let attributes: Record<string, string> | undefined;
    if (p.attributes !== undefined) {
      if (!p.attributes || typeof p.attributes !== 'object' || Array.isArray(p.attributes)) {
        problems.push(`${where}.attributes must be an object of attribute names to text.`);
      } else {
        attributes = {};
        for (const [name, value] of Object.entries(p.attributes as Record<string, unknown>)) {
          if (typeof value !== 'string') problems.push(`${where}.attributes.${name} must be text.`);
          else if (RESERVED_ATTRIBUTES.has(name)) problems.push(`${where}.attributes can't set "${name}"; auth-kit sets it.`);
          else attributes[name] = value;
        }
      }
    }

    personas.push({
      key,
      email,
      groups,
      ...(typeof p.label === 'string' && { label: p.label.trim() }),
      ...(attributes !== undefined && { attributes }),
    });
  }

  for (const role of standard) {
    if (!personas.some((p) => p.groups.includes(role))) problems.push(`no persona has the "${role}" role.`);
  }
  if (!personas.some((p) => p.groups.length === 0)) problems.push('no member persona (a persona with no groups).');
  for (const role of appRoles ?? []) {
    if (!personas.some((p) => p.groups.includes(role))) problems.push(`no persona has the app role "${role}".`);
  }

  if (problems.length > 0) throw new Error(`auth-kit: personas.json is invalid:\n- ${problems.join('\n- ')}`);
  return personas;
}

/** "Editor", "Member 2": the persona's label, or one made from its key. Shown with "(test)". */
export function personaLabel(persona: Pick<Persona, 'key' | 'label'>): string {
  if (persona.label) return persona.label;
  return persona.key
    .split('-')
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(' ');
}

/** The `.env.local` names for one persona's password and authenticator secret. */
export function personaEnvNames(key: string): { password: string; totpSecret: string } {
  const suffix = key.toUpperCase().replace(/-/g, '_');
  return { password: `PERSONA_PASSWORD_${suffix}`, totpSecret: `PERSONA_TOTP_${suffix}` };
}

export interface PersonaCredentials {
  password: string;
  /** The authenticator (TOTP) secret, base32, as Cognito issued it. */
  totpSecret?: string;
}

/** Reads a persona's password and authenticator secret from the environment (Next loads `.env.local`). */
export function personaCredentialsFromEnv(
  persona: Pick<Persona, 'key'>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): PersonaCredentials | undefined {
  const names = personaEnvNames(persona.key);
  const password = env[names.password];
  if (!password) return undefined;
  const totpSecret = env[names.totpSecret];
  return { password, ...(totpSecret ? { totpSecret } : {}) };
}

/** The persona with this address, if any. */
export function personaForEmail(personas: readonly Persona[], email: string | null | undefined): Persona | undefined {
  if (!email) return undefined;
  const e = email.trim().toLowerCase();
  return personas.find((p) => p.email === e);
}
