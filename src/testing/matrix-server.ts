/**
 * `auth-kit/testing/matrix-server`: the auth matrix's server mode (ADR 0016). **Dev only.**
 *
 * The auth matrix runs every route as every persona against the real app under `next dev`, in CI,
 * where there's no AWS. Under `AUTH_KIT_MATRIX=1` with a fixture from `startMatrixServer`, this
 * module hands the app what it needs to swap in, and nothing else changes: the same proxy, guards,
 * capability map, pages, and route handlers run.
 *
 * - `serverAuth`: spread into `createServerAuth`. The test issuer's public keys instead of the
 *   pool's (tokens the test minted verify, with every claim still checked; real tokens don't, and
 *   nothing is fetched from the pool's JWKS endpoint), and a scripted Cognito that answers the authenticator check and `{ live: true }` re-reads per person,
 *   refusing a disabled account and a revoked session the way Cognito does.
 * - `peopleCognito`, `mailer`, `auditLog`: for `createPeopleActions`. The People list reads the
 *   fixture; every change is refused; no email is sent; the audit log is in memory.
 * - `shared(key, create)`: the app's own in-memory stores, one per server process.
 *
 * **Keep it out of builds.** Import it only from a module behind a `withDevKit` alias (`@/dev-matrix`
 * → `lib/dev/matrix.on.ts` under `next dev`, `matrix.off.ts` returning `null` in every build). It also
 * returns `null` unless `NODE_ENV` is `development` (written literally, so `next build` compiles the
 * rest away) and `AUTH_KIT_MATRIX=1`, and it carries a marker `auth-kit check-prod-build` looks for.
 *
 * **Per bundle.** Next bundles the proxy, each page, and each route separately, each with its own
 * copy of auth-kit, and auth-kit recognizes its errors with `instanceof`. So the overrides are built
 * once per bundle (a scripted Cognito shared across bundles would throw an `UnauthenticatedError`
 * another bundle doesn't recognize: a 500 instead of a 401), and only plain data is shared across
 * bundles, on `globalThis`. The audit log's errors are re-thrown as this bundle's classes.
 */
import type { CognitoIdentityProviderClient, UserType } from '@aws-sdk/client-cognito-identity-provider';
import { AuditEventInvalidError, type AuditLogStore, AuditRowExistsError, createMemoryAuditLog } from '../admin/audit.js';
import type { InviteMailer, OwnerAlertNotifier, OwnerInviteWarningNotifier } from '../admin/mailer.js';
import { MATRIX_SERVER_MARKER } from '../dev/marker.js';
import type { CognitoGateway, LiveUserState, UserAuthFactors } from '../server/cognito.js';
import { UnauthenticatedError } from '../server/errors.js';
import type { JwksLike } from '../server/jwks.js';
import { MATRIX_ENV_FLAG, MATRIX_FIXTURE_ENV } from '../shared/matrix-protocol.js';
import { DEFAULT_MATRIX_FACTORS, type MatrixFixture, type MatrixFixtureUser, parseMatrixFixture } from './fixture.js';

export { MATRIX_ENV_FLAG, MATRIX_FIXTURE_ENV } from '../shared/matrix-protocol.js';
export { MATRIX_SERVER_MARKER } from '../dev/marker.js';
export type { MatrixFixture, MatrixFixtureUser } from './fixture.js';

/** What the app swaps in while the matrix runs. */
export interface MatrixServerOverrides {
  /**
   * Spread into `createServerAuth({ ...pool, capabilities, ...overrides.serverAuth })`: the test
   * issuer's keys, a key fetcher that serves only those (a token with an unknown key ID is a 401,
   * never a request to the real pool's JWKS endpoint), and the scripted Cognito.
   */
  readonly serverAuth: {
    readonly jwks: JwksLike;
    readonly jwksFetcher: (uri: string) => Promise<JwksLike>;
    readonly cognito: CognitoGateway;
  };
  /** `createPeopleActions({ cognito })`: lists the fixture's people and their live groups; refuses every change. */
  readonly peopleCognito: CognitoIdentityProviderClient;
  /** `createPeopleActions({ mailer })` (it also serves as `ownerAlerts`): refuses to send anything. */
  readonly mailer: InviteMailer & OwnerAlertNotifier & OwnerInviteWarningNotifier;
  /** `createPeopleActions({ auditLog })` and the Activity page: in memory, one log per server process. */
  readonly auditLog: AuditLogStore;
  /** The fixture's people. */
  readonly users: readonly MatrixFixtureUser[];
  /**
   * The app's own in-memory data (records the matrix creates through the API and reads on a page),
   * one per server process and key. Store plain data here, never objects that throw auth-kit errors.
   */
  shared<T>(key: string, create: () => T): T;
  /** auth-kit's matrix marker: `auth-kit check-prod-build` fails a build that contains it. */
  readonly marker: string;
}

const SHARED_KEY = Symbol.for('auth-kit.matrix-server.shared.v1');
const SHARED_NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,99}$/;
const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');

/** One store per server process, across every bundle. Plain data only (see the module comment). */
function processStore(): Map<string, unknown> {
  const holder = globalThis as { [SHARED_KEY]?: Map<string, unknown> };
  return (holder[SHARED_KEY] ??= new Map<string, unknown>());
}

function matrixModeOn(): boolean {
  // `process.env.NODE_ENV` is written literally: a production build replaces it with "production"
  // and drops everything after this line.
  if (typeof process === 'undefined' || process.env.NODE_ENV !== 'development') return false;
  return process.env[MATRIX_ENV_FLAG] === '1';
}

const ENDED = 'Your session has ended. Sign in again.';

/**
 * Answers the way the real gateway does: `GetUserAuthFactors` with the person's own token fails for a
 * disabled account (401 `account_disabled`) and a revoked session (401 `invalid_token`); `AdminGetUser`
 * reports the live status and groups. A person the fixture doesn't know is a mistake in the test,
 * so it fails loudly (a 500 naming them) rather than passing as signed out.
 */
function scriptedGateway(users: ReadonlyMap<string, MatrixFixtureUser>): CognitoGateway {
  const find = (username: string): MatrixFixtureUser => {
    const user = users.get(username);
    if (!user) throw new Error(`auth-kit matrix: no person "${username}" in the fixture. Mint tokens only for the fixture's people.`);
    return user;
  };
  return Object.freeze({
    getUserAuthFactors({ username }: { accessToken: string; username: string }): Promise<UserAuthFactors> {
      try {
        const user = find(username);
        if (user.enabled === false) throw new UnauthenticatedError('account_disabled', 'This account is disabled.');
        if (user.sessionRevoked === true) throw new UnauthenticatedError('invalid_token', ENDED);
        return Promise.resolve(user.factors ?? DEFAULT_MATRIX_FACTORS);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    getLiveUserState(username: string): Promise<LiveUserState> {
      try {
        const user = find(username);
        return Promise.resolve({ enabled: user.enabled !== false, status: user.status ?? 'CONFIRMED', groups: [...(user.liveGroups ?? user.groups)] });
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });
}

/** A read-only stand-in for the Cognito client the People actions use. */
function readOnlyPeopleClient(users: readonly MatrixFixtureUser[]): CognitoIdentityProviderClient {
  const groupsOf = (u: MatrixFixtureUser) => u.liveGroups ?? u.groups;
  const toUserType = (u: MatrixFixtureUser): UserType => ({
    Username: u.username,
    Attributes: [
      { Name: 'sub', Value: u.sub },
      { Name: 'email', Value: u.email ?? `${u.username}@matrix.test` },
      { Name: 'email_verified', Value: 'true' },
    ],
    Enabled: u.enabled !== false,
    UserStatus: (u.status ?? 'CONFIRMED') as UserType['UserStatus'],
    UserCreateDate: CREATED_AT,
    UserLastModifiedDate: CREATED_AT,
  });
  const client = {
    send(command: { constructor: { name: string }; input?: Record<string, unknown> }): Promise<unknown> {
      const input = command.input ?? {};
      switch (command.constructor.name) {
        case 'ListUsersCommand': {
          let list = users;
          if (input.Filter !== undefined) {
            const filter = typeof input.Filter === 'string' ? /^(sub|email|username) = "([^"\\]*)"$/.exec(input.Filter) : null;
            if (!filter) return Promise.reject(new Error(`auth-kit matrix: ListUsers filter ${JSON.stringify(input.Filter)} isn't one the matrix answers`));
            const [, field, value] = filter;
            list = users.filter((u) => (field === 'sub' ? u.sub : field === 'email' ? (u.email ?? `${u.username}@matrix.test`) : u.username) === value);
          }
          return Promise.resolve({ Users: list.map(toUserType) });
        }
        case 'ListUsersInGroupCommand':
          return Promise.resolve({ Users: users.filter((u) => groupsOf(u).includes(String(input.GroupName))).map(toUserType) });
        case 'AdminListGroupsForUserCommand': {
          const user = users.find((u) => u.username === input.Username);
          return Promise.resolve({ Groups: (user ? groupsOf(user) : []).map((GroupName) => ({ GroupName })) });
        }
        case 'AdminGetUserCommand': {
          const user = users.find((u) => u.username === input.Username);
          if (!user) return Promise.reject(Object.assign(new Error('User does not exist.'), { name: 'UserNotFoundException' }));
          const { Attributes, ...rest } = toUserType(user);
          return Promise.resolve({ ...rest, UserAttributes: Attributes });
        }
        default:
          return Promise.reject(new Error(`auth-kit matrix: the matrix server changes no accounts (${command.constructor.name} refused).`));
      }
    },
    destroy(): void {},
  };
  return client as unknown as CognitoIdentityProviderClient;
}

/** This bundle's view of the process's audit log: the same rows, this bundle's error classes. */
function bundleAuditLog(shared: AuditLogStore): AuditLogStore {
  const local = (error: unknown): never => {
    if (error instanceof AuditRowExistsError || error instanceof AuditEventInvalidError) throw error;
    const name = (error as { name?: unknown } | null)?.name;
    const message = error instanceof Error ? error.message : String(error);
    if (name === 'AuditRowExistsError') throw new AuditRowExistsError(message);
    if (name === 'AuditEventInvalidError') {
      const copy = new AuditEventInvalidError('');
      copy.message = message;
      throw copy;
    }
    throw error;
  };
  return Object.freeze({
    append: (event: Parameters<AuditLogStore['append']>[0]) => shared.append(event).catch(local),
    list: (query?: Parameters<AuditLogStore['list']>[0]) => shared.list(query).catch(local),
    listActivity: (query?: Parameters<AuditLogStore['listActivity']>[0]) => shared.listActivity(query).catch(local),
  });
}

function build(fixture: MatrixFixture): MatrixServerOverrides {
  const store = processStore();
  const shared = <T>(key: string, create: () => T): T => {
    if (typeof key !== 'string' || !SHARED_NAME.test(key)) throw new Error(`auth-kit matrix: shared store key ${JSON.stringify(key)} isn't a plain name.`);
    if (!store.has(key)) store.set(key, create());
    return store.get(key) as T;
  };
  const refuse = (what: string) => (): Promise<never> => Promise.reject(new Error(`auth-kit matrix: the matrix server sends no email (${what} refused).`));
  return Object.freeze({
    serverAuth: Object.freeze({
      jwks: fixture.jwks,
      jwksFetcher: () => Promise.resolve(fixture.jwks),
      cognito: scriptedGateway(new Map(fixture.users.map((u) => [u.username, u]))),
    }),
    peopleCognito: readOnlyPeopleClient(fixture.users),
    mailer: Object.freeze({
      sendInvite: refuse('invite'),
      superadminGranted: refuse('Super admin alert'),
      ownershipTransferred: refuse('ownership alert'),
      ownerInviteUnused: refuse('owner warning'),
    }),
    auditLog: bundleAuditLog(shared('auth-kit:audit-log', () => createMemoryAuditLog())),
    users: Object.freeze([...fixture.users]),
    shared,
    marker: MATRIX_SERVER_MARKER,
  });
}

let local: MatrixServerOverrides | undefined;

/**
 * The matrix's overrides, or `null` when the matrix isn't running: always outside `next dev`, and
 * under `next dev` without `AUTH_KIT_MATRIX=1`. With the flag but no valid fixture it throws: it
 * refuses to guess (and to fall back to AWS).
 *
 * ```ts
 * // lib/dev/matrix.on.ts (what @/dev-matrix means under next dev)
 * export { matrixServerOverrides as matrixOverrides } from 'auth-kit/testing/matrix-server';
 * // lib/dev/matrix.off.ts (what it means in every build)
 * import type { MatrixServerOverrides } from 'auth-kit/testing/matrix-server';
 * export function matrixOverrides(): MatrixServerOverrides | null { return null; }
 * // lib/auth.ts
 * export const auth = createServerAuth({ ...poolConfigFromAmplifyOutputs(outputs), capabilities, ...matrixOverrides()?.serverAuth });
 * ```
 */
export function matrixServerOverrides(): MatrixServerOverrides | null {
  if (!matrixModeOn()) return null;
  const raw = process.env[MATRIX_FIXTURE_ENV];
  if (raw === undefined || raw.trim() === '') {
    throw new Error(`auth-kit: ${MATRIX_ENV_FLAG}=1 needs ${MATRIX_FIXTURE_ENV} (startMatrixServer sets it). Refusing to guess.`);
  }
  return (local ??= build(parseMatrixFixture(raw, MATRIX_FIXTURE_ENV)));
}

// On the function itself, so any bundle that includes this module keeps the marker, even where a
// production build has compiled the function's body away.
matrixServerOverrides.marker = MATRIX_SERVER_MARKER;
