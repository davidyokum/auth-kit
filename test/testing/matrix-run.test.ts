/**
 * `startMatrixServer` and `matrixFixture` (#9): mint persona sessions, start the app's dev server
 * with the matrix flag and fixture and AWS unreachable, and stop everything it started. A small Node
 * HTTP server stands in for `next dev` here; the real thing is exercised by the e2e test.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServerAuth, defaultTokenSource, toRequestContext } from '../../src/server/index.js';
import {
  AWS_BLOCKED_ENV,
  MATRIX_FIXTURE_ENV,
  amplifyCookiePersona,
  createTestIssuer,
  matrixFixture,
  matrixServerEnv,
  parseMatrixFixture,
  startMatrixServer,
  type MatrixServer,
} from '../../src/testing/index.js';
import { CLIENT_ID, POOL_ID, capabilities } from '../helpers.js';

const POOL = { userPoolId: POOL_ID, clientId: CLIENT_ID };

/**
 * A stand-in for `next dev`: answers every request with the environment it was started with, and
 * starts a worker of its own (as next dev does) whose pid it reports, so stop() can be checked.
 */
function fakeNext(port: number, mode: 'serve' | 'exit' | 'hang' = 'serve'): readonly [string, ...string[]] {
  const script = `
    const { createServer } = require('node:http');
    const { spawn } = require('node:child_process');
    if (${JSON.stringify(mode)} === 'exit') { console.error('fake next: failing on purpose'); process.exit(3); }
    if (${JSON.stringify(mode)} === 'hang') { console.log('fake next: never listens'); setInterval(() => {}, 1000); }
    else {
      const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      createServer((req, res) => {
        const env = {};
        for (const [k, v] of Object.entries(process.env)) if (/^(AWS_|AUTH_KIT_|ALLOW_DEV_SIGNIN|NEXT_TELEMETRY|NODE_ENV|VITEST|FOO)/.test(k)) env[k] = v;
        res.writeHead(req.url === '/private' ? 307 : 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ url: req.url, cookie: req.headers.cookie ?? null, workerPid: worker.pid, env }));
      }).listen(${port}, '127.0.0.1', () => console.log('fake next ready'));
    }`;
  return [process.execPath, '-e', script];
}

const running: MatrixServer<string>[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(running.splice(0).map((s) => s.stop()));
});

async function start(options: Partial<Parameters<typeof startMatrixServer>[0]> = {}) {
  const server = await startMatrixServer({
    pool: POOL,
    personas: { member: {}, admin: { groups: ['admin-content-people'] }, noAuthenticator: { factors: { configured: ['PASSWORD'], mfa: [] } } },
    command: (port) => fakeNext(port),
    readyTimeoutMs: 20_000,
    ...options,
  });
  running.push(server);
  return server;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('matrixFixture', () => {
  const issuer = createTestIssuer(POOL);

  it('mints each persona a session the app verifies, as Amplify cookies and as a bearer token', async () => {
    const { personas, fixture } = matrixFixture({ issuer, personas: { member: {}, editor: { groups: ['admin-content'], email: 'ed@example.org' } } });
    const auth = createServerAuth({ ...POOL, capabilities, jwks: fixture.jwks, jwksFetcher: () => Promise.resolve(fixture.jwks), cognito: { getUserAuthFactors: () => Promise.resolve({ configured: ['WEB_AUTHN'], mfa: [] }), getLiveUserState: () => Promise.reject(new Error('unused')) } });
    for (const persona of Object.values(personas)) {
      for (const definition of [persona.cookie, persona.bearer]) {
        const user = await auth.requireUser({ request: new Request('http://127.0.0.1/', { headers: definition.headers as HeadersInit }) });
        expect(user).toMatchObject({ sub: persona.sub, username: persona.sub, groups: persona.groups });
      }
    }
    // The cookie persona is exactly what amplifyCookiePersona sends, and the server reads it.
    expect(personas.member.cookie).toEqual(
      amplifyCookiePersona({ clientId: CLIENT_ID, username: personas.member.username, accessToken: personas.member.accessToken, idToken: personas.member.idToken }),
    );
    const found = await defaultTokenSource(CLIENT_ID)(toRequestContext(new Request('http://x/', { headers: personas.editor.cookie.headers as HeadersInit })));
    expect(found).toMatchObject({ source: 'amplify-cookies', accessToken: personas.editor.accessToken, idToken: personas.editor.idToken });
    expect(personas.editor.email).toBe('ed@example.org');
  });

  it('describes each persona to the scripted Cognito, and nothing private travels in the fixture', () => {
    const { fixture, personas } = matrixFixture({
      issuer,
      personas: { demoted: { groups: ['admin-content-people'], liveGroups: [] }, off: { enabled: false }, out: { sessionRevoked: true, sub: 'fixed-sub' } },
    });
    expect(parseMatrixFixture(JSON.stringify(fixture))).toEqual(fixture);
    expect(fixture.users).toEqual([
      { username: personas.demoted.sub, sub: personas.demoted.sub, email: 'demoted@matrix.test', groups: ['admin-content-people'], liveGroups: [] },
      { username: personas.off.sub, sub: personas.off.sub, email: 'off@matrix.test', groups: [], enabled: false },
      { username: 'fixed-sub', sub: 'fixed-sub', email: 'out@matrix.test', groups: [], sessionRevoked: true },
    ]);
    expect(JSON.stringify(fixture)).not.toMatch(/"d":|PRIVATE/);
  });

  it('refuses a persona named anonymous (always included) or not a plain identifier', () => {
    expect(() => matrixFixture({ issuer, personas: { anonymous: {} } })).toThrow(/other than "anonymous"/);
    expect(() => matrixFixture({ issuer, personas: { 'two words': {} } })).toThrow(/plain identifier/);
  });
});

describe('matrixServerEnv', () => {
  const { fixture } = matrixFixture({ issuer: createTestIssuer(POOL), personas: { member: {} } });

  it("drops the parent's AWS settings, NODE_ENV, and the test runner's variables", () => {
    const env = matrixServerEnv(
      { PATH: '/usr/bin', AWS_PROFILE: 'personal', AWS_ACCESS_KEY_ID: 'parent-key-not-real', NODE_ENV: 'test', VITEST_WORKER_ID: '1', TEST: 'true', HOME: '/home/x' },
      {},
      fixture,
    );
    expect(env).toMatchObject({ PATH: '/usr/bin', HOME: '/home/x', ...AWS_BLOCKED_ENV, AUTH_KIT_MATRIX: '1', ALLOW_DEV_SIGNIN: '0', NEXT_TELEMETRY_DISABLED: '1' });
    for (const gone of ['NODE_ENV', 'VITEST_WORKER_ID', 'TEST']) expect(env[gone], gone).toBeUndefined();
    expect(parseMatrixFixture(env[MATRIX_FIXTURE_ENV])).toEqual(fixture);
  });

  it('passes the caller’s variables, but the flag, the fixture, the dev sign-in switch, and the AWS block always win', () => {
    const env = matrixServerEnv({}, { SITE_DEV_ORIGIN: 'http://127.0.0.1:3210', AUTH_KIT_MATRIX: '0', ALLOW_DEV_SIGNIN: '1', AWS_PROFILE: 'personal', NODE_ENV: 'production', [MATRIX_FIXTURE_ENV]: '{}' }, fixture);
    expect(env).toMatchObject({ SITE_DEV_ORIGIN: 'http://127.0.0.1:3210', AUTH_KIT_MATRIX: '1', ALLOW_DEV_SIGNIN: '0', AWS_PROFILE: AWS_BLOCKED_ENV.AWS_PROFILE });
    expect(env.NODE_ENV).toBeUndefined();
    expect(parseMatrixFixture(env[MATRIX_FIXTURE_ENV])).toEqual(fixture);
  });
});

describe('startMatrixServer', () => {
  it('starts the server on loopback with the matrix flag, the fixture, and no way to AWS', async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'parent-key-not-real');
    vi.stubEnv('AWS_PROFILE', 'personal');
    const server = await start({ env: { FOO: 'bar' } });
    expect(server.baseUrl).toBe(`http://127.0.0.1:${server.port}`);
    const seen = (await (await fetch(`${server.baseUrl}/app`)).json()) as { env: Record<string, string> };
    expect(seen.env).toMatchObject({ AUTH_KIT_MATRIX: '1', ALLOW_DEV_SIGNIN: '0', FOO: 'bar', ...AWS_BLOCKED_ENV });
    expect(seen.env.NODE_ENV).toBeUndefined();
    expect(Object.keys(seen.env).filter((k) => k.startsWith('VITEST'))).toEqual([]);
    expect(parseMatrixFixture(seen.env[MATRIX_FIXTURE_ENV])).toEqual(server.fixture);
    expect(server.log()).toContain('fake next ready');
  });

  it('hands back cookie personas for assertAuthMatrix, anonymous included', async () => {
    const server = await start();
    expect(Object.keys(server.cookiePersonas).sort()).toEqual(['admin', 'anonymous', 'member', 'noAuthenticator']);
    expect(server.cookiePersonas.anonymous).toEqual({});
    const seen = (await (await fetch(`${server.baseUrl}/`, { headers: server.cookiePersonas.admin!.headers as HeadersInit })).json()) as { cookie: string };
    expect(seen.cookie).toContain(server.personas.admin!.accessToken);
    expect(server.clientId).toBe(CLIENT_ID);
    expect(server.issuer.clientId).toBe(CLIENT_ID);
  });

  it('stops the server and the workers it started', async () => {
    const server = await start();
    const { workerPid } = (await (await fetch(server.baseUrl)).json()) as { workerPid: number };
    expect(alive(workerPid)).toBe(true);
    await server.stop();
    await expect(fetch(server.baseUrl)).rejects.toThrow();
    await vi.waitFor(() => expect(alive(workerPid)).toBe(false), { timeout: 5000 });
    await server.stop(); // twice is fine
  });

  it('counts a redirect as ready (a private home page sends anonymous visitors to sign-in)', async () => {
    const server = await start({ readyPath: '/private' });
    expect((await fetch(`${server.baseUrl}/private`, { redirect: 'manual' })).status).toBe(307);
  });

  it('reads the pool from amplify_outputs.json in the app root, and says so when it’s missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'auth-kit-matrix-'));
    try {
      await expect(startMatrixServer({ cwd: dir, personas: { member: {} }, command: (p) => fakeNext(p) })).rejects.toThrow(/needs .*amplify_outputs\.json/);
      await writeFile(join(dir, 'amplify_outputs.json'), JSON.stringify({ auth: { user_pool_id: POOL_ID, user_pool_client_id: CLIENT_ID } }));
      const server = await start({ cwd: dir, pool: undefined });
      expect(server.issuer.userPoolId).toBe(POOL_ID);
      await writeFile(join(dir, 'amplify_outputs.json'), JSON.stringify({ auth: {} }));
      await expect(startMatrixServer({ cwd: dir, personas: { member: {} }, command: (p) => fakeNext(p) })).rejects.toThrow(/has no auth.user_pool_id/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails with the server’s output when it exits before it’s ready', async () => {
    await expect(start({ command: (port) => fakeNext(port, 'exit') })).rejects.toThrow(/exited \(3\) before it was ready[\s\S]*failing on purpose/);
  });

  it('gives up after the timeout and stops what it started', async () => {
    await expect(start({ command: (port) => fakeNext(port, 'hang'), readyTimeoutMs: 1500 })).rejects.toThrow(/wasn't ready within 2s[\s\S]*never listens/);
  });

  it('says why when the command can’t start', async () => {
    await expect(start({ command: () => ['/nonexistent/auth-kit/next'] })).rejects.toThrow(/couldn't start the matrix server|exited/);
  });
});
