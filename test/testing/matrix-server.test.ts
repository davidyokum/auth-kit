/**
 * The auth matrix's server mode (#9, ADR 0016): inert unless the matrix asked for it, and while it
 * runs, the app's own createServerAuth and createPeopleActions answer from the fixture, with no AWS.
 */
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UnauthenticatedError, createServerAuth, toRequestContext, type RequestContext } from '../../src/server/index.js';
import { MATRIX_FIXTURE_ENV, createTestIssuer, matrixFixture, parseMatrixFixture, type MatrixFixture } from '../../src/testing/index.js';
import type * as MatrixServerNamespace from '../../src/testing/matrix-server.js';
import { CLIENT_ID, POOL_ID, capabilities } from '../helpers.js';

type MatrixServerModule = typeof MatrixServerNamespace;

const SHARED = Symbol.for('auth-kit.matrix-server.shared.v1');

/**
 * A fresh copy of auth-kit, as each Next bundle gets (its own modules, its own error classes): the matrix
 * server mode, and the server and admin entries the app's lib/auth.ts and lib/admin.ts import beside it
 * in the same bundle. The matrix server mode's sign is module-private (L7), so the app's
 * createServerAuth must come from the same bundle as its matrixOverrides(), as it does in Next.
 */
async function freshBundle(): Promise<MatrixServerModule & { server: typeof import('../../src/server/index.js'); admin: typeof import('../../src/admin/index.js') }> {
  vi.resetModules();
  const matrix = await import('../../src/testing/matrix-server.js');
  const server = await import('../../src/server/index.js');
  const admin = await import('../../src/admin/index.js');
  return { ...matrix, server, admin };
}

const PERSONAS = {
  member: {},
  admin: { groups: ['admin-content-people'] },
  owner: { groups: ['owner'] },
  noAuthenticator: { factors: { configured: ['PASSWORD'], mfa: [] } },
  demotedAdmin: { groups: ['admin-content-people'], liveGroups: [] },
  disabledAdmin: { groups: ['admin-content-people'], enabled: false },
  revokedSession: { groups: ['admin-content'], sessionRevoked: true },
};

function matrixEnv(fixture: MatrixFixture | string | undefined, nodeEnv = 'development', flag = '1') {
  vi.stubEnv('NODE_ENV', nodeEnv);
  vi.stubEnv('AUTH_KIT_MATRIX', flag);
  vi.stubEnv(MATRIX_FIXTURE_ENV, typeof fixture === 'string' || fixture === undefined ? (fixture ?? '') : JSON.stringify(fixture));
}

function setup() {
  const issuer = createTestIssuer({ userPoolId: POOL_ID, clientId: CLIENT_ID });
  return { issuer, ...matrixFixture({ issuer, personas: PERSONAS }) };
}

afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as Record<symbol, unknown>)[SHARED];
});

describe('matrixServerOverrides is inert unless the matrix runs', () => {
  it('returns null in production and test builds, even with the flag and a fixture', async () => {
    const { fixture } = setup();
    for (const env of ['production', 'test']) {
      matrixEnv(fixture, env);
      expect((await freshBundle()).matrixServerOverrides(), env).toBeNull();
    }
  });

  it('returns null under next dev without AUTH_KIT_MATRIX=1', async () => {
    for (const flag of ['', '0', 'true', 'yes']) {
      matrixEnv(setup().fixture, 'development', flag);
      expect((await freshBundle()).matrixServerOverrides(), flag).toBeNull();
    }
  });

  it('refuses to guess with the flag but no fixture (and never falls back to AWS)', async () => {
    matrixEnv(undefined);
    await expect(freshBundle().then((m) => m.matrixServerOverrides())).rejects.toThrow(/AUTH_KIT_MATRIX=1 needs AUTH_KIT_MATRIX_FIXTURE.*Refusing to guess/);
  });

  it('carries the marker check-prod-build looks for, on the function itself', async () => {
    const m = await freshBundle();
    expect(m.matrixServerOverrides.marker).toBe(m.MATRIX_SERVER_MARKER);
    matrixEnv(setup().fixture);
    expect(m.matrixServerOverrides()?.marker).toBe(m.MATRIX_SERVER_MARKER);
  });
});

describe('the fixture', () => {
  const valid = () => JSON.parse(JSON.stringify(setup().fixture)) as Record<string, unknown> & MatrixFixture;

  it('round-trips through the environment', () => {
    const { fixture } = setup();
    expect(parseMatrixFixture(JSON.stringify(fixture))).toEqual(fixture);
  });

  it.each([
    ['empty', '', /is empty/],
    ['not JSON', '{', /isn't JSON/],
    ['not an object', '[]', /must be an object/],
  ])('refuses %s', (_label, raw, message) => {
    expect(() => parseMatrixFixture(raw)).toThrow(message);
  });

  it('lists every problem with a malformed fixture', () => {
    const fixture = valid();
    fixture.version = 2 as never;
    fixture.users.push({ ...fixture.users[0]!, groups: 'admin-content-people' as never, extra: 1 } as never);
    fixture.users.push({ username: '', sub: '', groups: [], enabled: 'no', factors: { configured: [] } } as never);
    const error = (() => {
      try {
        parseMatrixFixture(JSON.stringify(fixture), 'AUTH_KIT_MATRIX_FIXTURE');
      } catch (e) {
        return (e as Error).message;
      }
      return '';
    })();
    expect(error).toMatch(/AUTH_KIT_MATRIX_FIXTURE is invalid/);
    for (const part of [/version must be 1/, /unknown field "extra"/, /username ".*" is repeated/, /sub ".*" is repeated/, /groups must be an array/, /username must be a non-empty/, /enabled must be true or false/, /factors must be/]) {
      expect(error).toMatch(part);
    }
  });

  it('refuses keys that are missing or private: a fixture travels through the environment', () => {
    const noKeys = valid();
    noKeys.jwks = { keys: [] };
    expect(() => parseMatrixFixture(JSON.stringify(noKeys))).toThrow(/jwks.keys must be a non-empty array/);
    const privateKey = valid();
    privateKey.jwks = { keys: [{ ...privateKey.jwks.keys[0], d: 'secret' }] };
    expect(() => parseMatrixFixture(JSON.stringify(privateKey))).toThrow(/private key material/);
  });
});

describe('while the matrix runs, the app’s own auth answers from the fixture', () => {
  async function appAuth() {
    const s = setup();
    matrixEnv(s.fixture);
    const bundle = await freshBundle();
    const overrides = bundle.matrixServerOverrides()!;
    let context: RequestContext = toRequestContext(new Request('http://127.0.0.1:3210/'));
    const auth = bundle.server.createServerAuth({ userPoolId: POOL_ID, clientId: CLIENT_ID, capabilities, ...overrides.serverAuth, context: () => Promise.resolve(context) });
    const as = (name: keyof typeof PERSONAS) => {
      context = toRequestContext(new NextRequest('http://127.0.0.1:3210/app', { headers: s.personas[name].cookie.headers as HeadersInit }));
    };
    return { ...s, overrides, auth, as, bundle };
  }

  it('verifies the test issuer’s tokens (cookies as a browser sends them) and refuses any other key', async () => {
    const { auth, as, personas } = await appAuth();
    as('member');
    await expect(auth.requireUser()).resolves.toMatchObject({ sub: personas.member.sub, groups: [] });
    as('admin');
    expect((await auth.requireCan('people.manage')).groups).toEqual(['admin-content-people']);
  });

  it('refuses a token signed by any other key as 401, without fetching the real pool’s keys', async () => {
    const s = setup();
    matrixEnv(s.fixture);
    const bundle = await freshBundle();
    const overrides = bundle.matrixServerOverrides()!;
    const fetched: string[] = [];
    const jwksFetcher = (uri: string) => (fetched.push(uri), overrides.serverAuth.jwksFetcher(uri));
    const auth = bundle.server.createServerAuth({ userPoolId: POOL_ID, clientId: CLIENT_ID, capabilities, ...overrides.serverAuth, jwksFetcher, context: () => Promise.reject(new Error('pass a request')) });
    const stranger = createTestIssuer({ userPoolId: POOL_ID, clientId: CLIENT_ID }).mintAccessToken({ sub: s.personas.member.sub, username: s.personas.member.username });
    const request = new Request('http://127.0.0.1/', { headers: { authorization: `Bearer ${stranger}` } });
    await expect(auth.requireUser({ request })).rejects.toMatchObject({ code: 'invalid_token', status: 401 });
    // The fixture's fetcher answered the key lookup: nothing went to cognito-idp.
    expect(fetched).toEqual([expect.stringMatching(/\/\.well-known\/jwks\.json$/)]);
    expect(await overrides.serverAuth.jwksFetcher('https://cognito-idp.us-east-1.amazonaws.com/x/.well-known/jwks.json')).toEqual(s.fixture.jwks);
  });

  it('answers the authenticator rule, disabled accounts, revoked sessions, and live demotions as Cognito does', async () => {
    const { auth, as, bundle } = await appAuth();
    as('noAuthenticator');
    await expect(auth.requireUser()).rejects.toBeInstanceOf(bundle.server.MfaEnrollmentRequiredError);
    await expect(auth.requireUser({ allowMfaEnrollment: true })).resolves.toBeTruthy();
    as('disabledAdmin');
    await expect(auth.requireUser()).rejects.toMatchObject({ code: 'account_disabled', status: 401 });
    as('revokedSession');
    await expect(auth.requireUser()).rejects.toMatchObject({ code: 'invalid_token', status: 401 });
    as('demotedAdmin');
    await expect(auth.requireCan('people.manage')).resolves.toBeTruthy(); // the token still says admin
    await expect(auth.requireCan('people.manage', { live: true })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('throws errors this bundle recognizes (the cross-bundle instanceof pitfall)', async () => {
    const { overrides, personas } = await appAuth();
    const disabled = personas.disabledAdmin;
    const error = await overrides.serverAuth.cognito.getUserAuthFactors({ accessToken: 'x', username: disabled.username }).catch((e: unknown) => e);
    const { UnauthenticatedError: BundleError } = await import('../../src/server/errors.js');
    expect(error).toBeInstanceOf(BundleError);
    // ...and not the class of an earlier module instance (what a gateway memoized on globalThis would throw).
    expect(error).not.toBeInstanceOf(UnauthenticatedError);
  });

  it('its sign is module-private: a createServerAuth from another module copy refuses it (L7)', async () => {
    const s = setup();
    matrixEnv(s.fixture);
    const overrides = (await freshBundle()).matrixServerOverrides()!;
    // This file's own createServerAuth is another copy of auth-kit than the bundle that made the sign.
    expect(() => createServerAuth({ userPoolId: POOL_ID, clientId: CLIENT_ID, capabilities, ...overrides.serverAuth, requireFirstCredential: false })).toThrow(/matrixServerMode comes only from matrixOverrides/);
  });

  it('fails loudly for a person the fixture doesn’t know', async () => {
    const { overrides } = await appAuth();
    await expect(overrides.serverAuth.cognito.getUserAuthFactors({ accessToken: 'x', username: 'stranger' })).rejects.toThrow(/no person "stranger"/);
    await expect(overrides.serverAuth.cognito.getLiveUserState('stranger')).rejects.toThrow(/no person "stranger"/);
  });
});

describe('the People page and audit log while the matrix runs', () => {
  async function adminArea() {
    const s = setup();
    matrixEnv(s.fixture);
    const bundle = await freshBundle();
    const overrides = bundle.matrixServerOverrides()!;
    const context = toRequestContext(new NextRequest('http://127.0.0.1:3210/admin/people', { headers: s.personas.owner.cookie.headers as HeadersInit }));
    const auth = bundle.server.createServerAuth({ userPoolId: POOL_ID, clientId: CLIENT_ID, capabilities, ...overrides.serverAuth, context: () => Promise.resolve(context) });
    const people = bundle.admin.createPeopleActions({
      auth,
      auditLog: overrides.auditLog,
      mailer: overrides.mailer,
      siteName: 'Example Reports',
      signInUrl: 'http://127.0.0.1:3210/sign-in',
      cognito: overrides.peopleCognito,
      requestContext: () => Promise.resolve({ ip: '127.0.0.1', userAgent: 'matrix', requestId: 'r1' }),
      sleep: () => Promise.resolve(),
      quota: { random: () => 0 },
    });
    return { ...s, overrides, people };
  }

  it('lists the fixture’s people with their live groups', async () => {
    const { people, personas } = await adminArea();
    const list = await people.listPeople();
    if (list.state !== 'ok') throw new Error(list.reason);
    const bySub = new Map(list.people.map((p) => [p.sub, p]));
    expect(bySub.size).toBe(Object.keys(PERSONAS).length);
    expect(bySub.get(personas.owner.sub)).toMatchObject({ email: 'owner@matrix.test' });
    expect(JSON.stringify(bySub.get(personas.demotedAdmin.sub))).not.toMatch(/"admin-content-people"/);
  });

  it('changes no accounts and sends no email: a write is refused and nothing is reported as changed', async () => {
    const { people, personas } = await adminArea();
    const result = await people.disable({ sub: personas.member.sub });
    expect(result).toMatchObject({ ok: false, changed: 'nothing' });
    const invite = await people.invite({ email: 'new@example.org', role: 'member' });
    expect(invite.ok).toBe(false);
    const send = overrides_send(await adminArea());
    await expect(send('AdminDeleteUserCommand')).rejects.toThrow(/changes no accounts/);
  });

  it('shares the audit log across bundles, with each bundle’s own error classes', async () => {
    const first = await adminArea();
    await first.people.disable({ sub: first.personas.member.sub });
    const rowsSeenByFirst = (await first.overrides.auditLog.list()).events.length;
    expect(rowsSeenByFirst).toBeGreaterThan(0);
    // Another bundle (a fresh module copy) in the same process sees the same rows.
    const second = (await freshBundle()).matrixServerOverrides()!;
    expect((await second.auditLog.list()).events.length).toBe(rowsSeenByFirst);
    // An append that fails in the shared store surfaces as the calling bundle's class.
    const { AuditEventInvalidError } = await import('../../src/admin/audit.js');
    const failure = await second.auditLog.append({ action: 'NOT VALID' } as never).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AuditEventInvalidError);
  });

  it('keeps the app’s own stores per process, by key', async () => {
    const { overrides } = await adminArea();
    const tickets = overrides.shared('tickets', () => ({ rows: [] as string[] }));
    tickets.rows.push('t1');
    const again = (await freshBundle()).matrixServerOverrides()!;
    expect(again.shared('tickets', () => ({ rows: [] as string[] })).rows).toEqual(['t1']);
    expect(() => overrides.shared('../etc', () => 1)).toThrow(/plain name/);
  });
});

/** Sends a raw command class by name through the read-only people client. */
function overrides_send(area: { overrides: { peopleCognito: unknown } }) {
  const client = area.overrides.peopleCognito as { send: (command: unknown) => Promise<unknown> };
  return (name: string) => {
    const Command = { [name]: class {} }[name]!;
    return client.send(Object.assign(new Command(), { input: { Username: 'x' } }));
  };
}

describe('resource roles while the matrix runs', () => {
  it('one membership store per process, shared by every bundle, whose conflicts any bundle recognizes', async () => {
    const s = setup();
    matrixEnv(s.fixture);
    const firstBundle = await freshBundle();
    const first = firstBundle.matrixServerOverrides()!;
    const { defineResourceTypes } = await import('../../src/resources/index.js');
    const types = defineResourceTypes({ project: { noun: 'project' } });
    const context = toRequestContext(new NextRequest('http://127.0.0.1:3210/app', { headers: s.personas.member.cookie.headers as HeadersInit }));
    const auth = firstBundle.server.createServerAuth({ userPoolId: POOL_ID, clientId: CLIENT_ID, capabilities, ...first.serverAuth, resources: { types, store: first.resources }, context: () => Promise.resolve(context) });
    const ref = { type: 'project', id: 'p-1' };
    const meta = { ...ref, version: 1, managers: 1, createdAt: 'x', createdBy: 'x', updatedAt: 'x', updatedBy: 'x' };
    await first.resources.commit(ref, { expectedVersion: null, meta, put: [{ ...ref, sub: s.personas.member.sub, role: 'manager', addedBy: 'x', addedAt: 'x' }] });
    expect((await auth.requireResourceRole('project', 'p-1', 'manage-access')).role).toBe('manager');
    // Another bundle sees the same memberships; its conflict error is matched by name.
    const second = (await freshBundle()).matrixServerOverrides()!;
    expect((await second.resources.getMembership(ref, s.personas.member.sub))?.role).toBe('manager');
    const conflict = await second.resources.commit(ref, { expectedVersion: null, meta, put: [] }).catch((e: unknown) => e);
    const { isResourceConflict } = await import('../../src/resources/index.js');
    expect(isResourceConflict(conflict)).toBe(true);
  });
});
