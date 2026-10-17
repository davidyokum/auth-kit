/**
 * The auth matrix's fixture: the test issuer's public keys and what a scripted Cognito says about
 * each test person. `startMatrixServer` writes it into the dev server's environment
 * (`AUTH_KIT_MATRIX_FIXTURE`); `matrixServerOverrides` reads it there. No Node-only imports: the
 * reader runs inside the app's server bundles under `next dev`.
 */
import type { UserAuthFactors } from '../server/cognito.js';
import type { JwksLike } from '../server/jwks.js';

/** The fixture's format. A mismatched pair of auth-kit versions fails loudly instead of guessing. */
export const MATRIX_FIXTURE_VERSION = 1;

/** What seeded personas have: a password and an authenticator. */
export const DEFAULT_MATRIX_FACTORS: UserAuthFactors = Object.freeze({
  configured: Object.freeze(['PASSWORD']),
  mfa: Object.freeze(['SOFTWARE_TOKEN_MFA']),
});

/** One test person, as the scripted Cognito describes them. */
export interface MatrixFixtureUser {
  /** The token's `username` (a UUID in email-as-username pools). */
  username: string;
  sub: string;
  email?: string;
  /** Groups in their access token. */
  groups: readonly string[];
  /** Groups Cognito reports now, when they differ from the token (a demoted admin). Default: `groups`. */
  liveGroups?: readonly string[];
  /** `false` for an account disabled after its token was issued. Default `true`. */
  enabled?: boolean;
  /** `true` after "sign out everywhere": Cognito refuses the token's session. Default `false`. */
  sessionRevoked?: boolean;
  /** Their sign-in factors. Default: a password and an authenticator. */
  factors?: UserAuthFactors;
  /** Cognito's account status. Default `CONFIRMED`. */
  status?: string;
}

export interface MatrixFixture {
  version: typeof MATRIX_FIXTURE_VERSION;
  /** The test issuer's public keys: tokens it signs verify, real Cognito tokens don't. */
  jwks: JwksLike;
  users: MatrixFixtureUser[];
}

const USER_KEYS = new Set(['username', 'sub', 'email', 'groups', 'liveGroups', 'enabled', 'sessionRevoked', 'factors', 'status']);
// Private RSA/EC/OKP members: a fixture travels through the environment, so it must never hold a signing key.
const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string');
const isFactors = (value: unknown): value is UserAuthFactors =>
  typeof value === 'object' && value !== null && isStringArray((value as Record<string, unknown>).configured) && isStringArray((value as Record<string, unknown>).mfa);

/** Throws with every problem at once, naming the variable it came from. */
export function parseMatrixFixture(raw: string | undefined, source = 'the matrix fixture'): MatrixFixture {
  if (typeof raw !== 'string' || raw.trim() === '') throw new Error(`auth-kit: ${source} is empty.`);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`auth-kit: ${source} isn't JSON.`);
  }
  const problems: string[] = [];
  const fixture = value as Partial<MatrixFixture> | null;
  if (typeof fixture !== 'object' || fixture === null || Array.isArray(fixture)) {
    throw new Error(`auth-kit: ${source} must be an object { version, jwks, users }.`);
  }
  if (fixture.version !== MATRIX_FIXTURE_VERSION) {
    problems.push(`version must be ${MATRIX_FIXTURE_VERSION} (got ${JSON.stringify(fixture.version)}); start the server with the same auth-kit version`);
  }
  const keys = (fixture.jwks as { keys?: unknown } | undefined)?.keys;
  if (!Array.isArray(keys) || keys.length === 0) {
    problems.push('jwks.keys must be a non-empty array (the test issuer’s public keys)');
  } else {
    keys.forEach((key: unknown, i) => {
      if (typeof key !== 'object' || key === null || typeof (key as { kty?: unknown }).kty !== 'string') problems.push(`jwks.keys[${i}] isn't a JWK`);
      else if (PRIVATE_JWK_MEMBERS.some((m) => m in key)) problems.push(`jwks.keys[${i}] holds private key material; pass public keys only`);
    });
  }
  if (!Array.isArray(fixture.users)) {
    problems.push('users must be an array');
  } else {
    const usernames = new Set<string>();
    const subs = new Set<string>();
    fixture.users.forEach((user: unknown, i) => {
      const at = `users[${i}]`;
      if (typeof user !== 'object' || user === null) return void problems.push(`${at} isn't an object`);
      const u = user as Record<string, unknown>;
      for (const key of Object.keys(u)) if (!USER_KEYS.has(key)) problems.push(`${at} has an unknown field "${key}"`);
      if (typeof u.username !== 'string' || u.username === '') problems.push(`${at}.username must be a non-empty string`);
      else if (usernames.has(u.username)) problems.push(`${at}.username "${u.username}" is repeated`);
      else usernames.add(u.username);
      if (typeof u.sub !== 'string' || u.sub === '') problems.push(`${at}.sub must be a non-empty string`);
      else if (subs.has(u.sub)) problems.push(`${at}.sub "${u.sub}" is repeated`);
      else subs.add(u.sub);
      if (!isStringArray(u.groups)) problems.push(`${at}.groups must be an array of group names`);
      if (u.liveGroups !== undefined && !isStringArray(u.liveGroups)) problems.push(`${at}.liveGroups must be an array of group names`);
      for (const key of ['enabled', 'sessionRevoked'] as const) {
        if (u[key] !== undefined && typeof u[key] !== 'boolean') problems.push(`${at}.${key} must be true or false`);
      }
      for (const key of ['email', 'status'] as const) {
        if (u[key] !== undefined && typeof u[key] !== 'string') problems.push(`${at}.${key} must be a string`);
      }
      if (u.factors !== undefined && !isFactors(u.factors)) problems.push(`${at}.factors must be { configured: string[], mfa: string[] }`);
    });
  }
  if (problems.length > 0) throw new Error(`auth-kit: ${source} is invalid:\n- ${problems.join('\n- ')}`);
  return fixture as MatrixFixture;
}
