import { AdminInitiateAuthCommand, DescribeUserPoolCommand } from '@aws-sdk/client-cognito-identity-provider';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type BindCheck,
  clearSandboxCheckCache,
  createDevKit,
  DEV_SIGNIN_MARKER,
  DEV_SIGNIN_MARKER_HEADER,
  type DevKitOptions,
  type DevPersonaList,
  defaultPersonas,
  parseCookieHeader,
  parseEnvFile,
  readAmplifySession,
  resetPersonaAuthState,
  seedPersonas,
} from '../../src/dev/index.js';
import { amplifyCookieTokens } from '../../src/server/tokens.js';
import { CLIENT_ID, POOL_ID } from '../helpers.js';
import { ACCOUNT, createFakeCognito, type FakeCognito } from './fake-cognito.js';

const personas = defaultPersonas({ domain: 'orchard.test' });
const outputs = { auth: { user_pool_id: POOL_ID, user_pool_client_id: CLIENT_ID, aws_region: 'us-east-1' } };
const ORIGIN = 'http://app.localhost:3000';
const URL_ = `${ORIGIN}/api/dev/sign-in`;

let fake: FakeCognito;
let env: Map<string, string>;
let logs: string[];

async function seeded() {
  fake = createFakeCognito();
  const dir = await mkdtemp(join(tmpdir(), 'auth-kit-route-'));
  await seedPersonas({ client: fake.client, userPoolId: POOL_ID, clientId: CLIENT_ID, personas, cwd: dir, gitIgnore: () => Promise.resolve('ignored'), now: fake.now, sleep: fake.sleep });
  env = parseEnvFile(await readFile(join(dir, '.env.local'), 'utf8'));
  await rm(dir, { recursive: true, force: true });
  fake.clock.now += 60_000; // later than the seed's codes
  fake.mock.resetHistory();
}

function kit(extra: Partial<DevKitOptions> = {}) {
  return createDevKit({
    outputs,
    personas,
    client: fake.client,
    expectedAccountId: ACCOUNT,
    credentials: (p) => {
      const n = p.key.toUpperCase().replace(/-/g, '_');
      const password = env.get(`PERSONA_PASSWORD_${n}`);
      const totpSecret = env.get(`PERSONA_TOTP_${n}`);
      return password ? { password, ...(totpSecret ? { totpSecret } : {}) } : undefined;
    },
    checkBinding: () => Promise.resolve<BindCheck>({ ok: true, detail: 'listening on 127.0.0.1:3000 only' }),
    log: (m) => logs.push(m),
    now: fake.now,
    sleep: fake.sleep,
    ...extra,
  });
}

function post(body: unknown, headers: Record<string, string> = {}, url = URL_) {
  const host = new URL(url).host;
  return new Request(url, {
    method: 'POST',
    headers: { host, origin: new URL(url).origin, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function cookieHeaderFrom(res: Response, existing = ''): string {
  const jar = parseCookieHeader(existing);
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const eq = pair!.indexOf('=');
    const name = pair!.slice(0, eq);
    const value = pair!.slice(eq + 1);
    if (/max-age=0/i.test(c)) jar.delete(name);
    else jar.set(name, value);
  }
  return [...jar].map(([n, v]) => `${n}=${v}`).join('; ');
}

beforeEach(async () => {
  logs = [];
  clearSandboxCheckCache();
  resetPersonaAuthState();
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('ALLOW_DEV_SIGNIN', '1');
  await seeded();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('"Sign in as…" signs a persona in for real', () => {
  it('sets the same cookies Amplify writes, which auth-kit/server then reads', async () => {
    const res = await kit().route.POST(post({ persona: 'admin-content' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, persona: 'admin-content', label: 'Admin Content' });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get(DEV_SIGNIN_MARKER_HEADER)).toBe(DEV_SIGNIN_MARKER);

    const editor = fake.userByEmail('admin-content@orchard.test')!;
    const cookies = res.headers.getSetCookie();
    const prefix = `CognitoIdentityServiceProvider.${CLIENT_ID}`;
    expect(cookies.map((c) => c.split('=')[0])).toEqual([
      `${prefix}.LastAuthUser`,
      `${prefix}.${editor.sub}.accessToken`,
      `${prefix}.${editor.sub}.idToken`,
      `${prefix}.${editor.sub}.refreshToken`,
      `${prefix}.${editor.sub}.clockDrift`,
      `${prefix}.${editor.sub}.signInDetails`,
    ]);
    for (const c of cookies) {
      expect(c).toMatch(/; Path=\/; SameSite=Lax$/);
      expect(c).toMatch(/Max-Age=2592000/);
      expect(c).not.toMatch(/HttpOnly|Secure/);
    }
    expect(cookies.find((c) => c.includes('signInDetails'))).toContain('{%22loginId%22:%22admin-content@orchard.test%22%2C%22authFlowType%22:%22USER_AUTH%22}');

    // The server's own token source finds the persona's real access token in those cookies.
    const header = cookieHeaderFrom(res);
    const jar = parseCookieHeader(header);
    const found = await amplifyCookieTokens(CLIENT_ID)({ cookies: { get: (n) => (jar.has(n) ? { value: jar.get(n)! } : undefined) }, headers: new Headers() });
    expect(found.source).toBe('amplify-cookies');
    expect(JSON.parse(Buffer.from(found.accessToken!.split('.')[1]!, 'base64url').toString())).toMatchObject({ username: editor.sub, 'cognito:groups': ['admin-content'] });
  });

  it('answers the authenticator challenge (personas are password + TOTP users)', async () => {
    await kit().route.POST(post({ persona: 'admin-view' }));
    const init = fake.mock.commandCalls(AdminInitiateAuthCommand);
    expect(init).toHaveLength(1);
    expect(init[0]!.args[0].input).toMatchObject({ AuthFlow: 'ADMIN_USER_PASSWORD_AUTH', ClientId: CLIENT_ID, UserPoolId: POOL_ID });
  });

  it('a second click in the same 30 seconds waits for the next code instead of reusing one', async () => {
    const k = kit();
    const start = fake.clock.now;
    expect((await k.route.POST(post({ persona: 'admin-content-people' }))).status).toBe(200);
    expect((await k.route.POST(post({ persona: 'admin-content-people' }))).status).toBe(200);
    expect(fake.clock.now).toBeGreaterThan(start);
  });

  it('switching persona expires the previous persona’s cookies', async () => {
    const k = kit();
    const first = await k.route.POST(post({ persona: 'admin-content' }));
    const jarAfterFirst = cookieHeaderFrom(first);
    const second = await k.route.POST(post({ persona: 'admin-view' }, { cookie: jarAfterFirst }));
    const header = cookieHeaderFrom(second, jarAfterFirst);
    const session = readAmplifySession(CLIENT_ID, header);
    expect(session.username).toBe(fake.userByEmail('admin-view@orchard.test')!.sub);
    expect(header).not.toContain(fake.userByEmail('admin-content@orchard.test')!.sub);
  });

  it('GET lists personas and the current one, never credentials', async () => {
    const k = kit();
    const signedIn = cookieHeaderFrom(await k.route.POST(post({ persona: 'member' })));
    const res = await k.route.GET(new Request(URL_, { headers: { host: 'app.localhost:3000', cookie: signedIn } }));
    const body = (await res.json()) as DevPersonaList;
    expect(body.current).toBe('member');
    expect(body.pool).toBe(POOL_ID);
    expect(body.personas.map((p) => p.key)).toEqual(['owner', 'superadmin', 'admin-content-people', 'admin-content', 'admin-view', 'member']);
    const text = JSON.stringify(body);
    for (const [k2, v] of env) if (k2.startsWith('PERSONA_')) expect(text).not.toContain(v);
  });

  it('DELETE signs out: revokes the refresh token and expires every cookie', async () => {
    const k = kit();
    const signedIn = cookieHeaderFrom(await k.route.POST(post({ persona: 'admin-content-people' })));
    const res = await k.route.DELETE(new Request(URL_, { method: 'DELETE', headers: { host: 'app.localhost:3000', origin: ORIGIN, cookie: signedIn } }));
    expect(res.status).toBe(200);
    expect(fake.revoked).toHaveLength(1);
    expect(cookieHeaderFrom(res, signedIn)).toBe('');
  });

  it('works on 127.0.0.1 and [::1] too', async () => {
    expect((await kit().route.POST(post({ persona: 'admin-content' }, {}, 'http://127.0.0.1:3000/api/dev/sign-in'))).status).toBe(200);
    expect((await kit().route.POST(post({ persona: 'admin-view' }, {}, 'http://[::1]:3000/api/dev/sign-in'))).status).toBe(200);
  });

  it('sets Secure cookies on https', async () => {
    const res = await kit().route.POST(post({ persona: 'admin-content' }, {}, 'https://app.localhost:3443/api/dev/sign-in'));
    expect(res.headers.getSetCookie().every((c) => c.includes('; Secure'))).toBe(true);
  });
});

describe('every refusal is a plain 404', () => {
  const expect404 = async (res: Response) => {
    expect(res.status).toBe(404);
    expect(res.headers.get(DEV_SIGNIN_MARKER_HEADER)).toBeNull();
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await res.text()).toBe('Not found');
  };

  it('fails each request gate silently, without calling AWS', async () => {
    const k = kit();
    const cases: [string, () => void, Request][] = [
      ['production', () => vi.stubEnv('NODE_ENV', 'production'), post({ persona: 'admin-content-people' })],
      ['no flag', () => vi.stubEnv('ALLOW_DEV_SIGNIN', ''), post({ persona: 'admin-content-people' })],
      ['flag "true"', () => vi.stubEnv('ALLOW_DEV_SIGNIN', 'true'), post({ persona: 'admin-content-people' })],
      ['a deployed host', () => {}, post({ persona: 'admin-content-people' }, {}, 'https://orchard.example/api/dev/sign-in')],
      ['localhost.evil.com', () => {}, post({ persona: 'admin-content-people' }, {}, 'http://localhost.evil.com/api/dev/sign-in')],
      ['Host forged to localhost', () => {}, post({ persona: 'admin-content-people' }, { host: 'localhost:3000' }, 'http://192.168.1.23:3000/api/dev/sign-in')],
      ['a tunnel', () => {}, post({ persona: 'admin-content-people' }, { 'x-forwarded-host': 'abc.ngrok.app', 'x-forwarded-for': '203.0.113.7' })],
      ['a LAN client named by Next', () => {}, post({ persona: 'admin-content-people' }, { 'x-forwarded-for': '192.168.1.40' })],
      ['PUT', () => {}, new Request(URL_, { method: 'PUT', headers: { host: 'app.localhost:3000', origin: ORIGIN } })],
    ];
    for (const [label, setup, request] of cases) {
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('ALLOW_DEV_SIGNIN', '1');
      setup();
      await expect404(await k.route.POST(request));
      expect(fake.mock.calls(), label).toHaveLength(0);
    }
    expect(logs).toEqual([]);
  });

  it('refuses a cross-site POST or DELETE (login CSRF), and a non-JSON POST', async () => {
    const k = kit();
    await expect404(await k.route.POST(post({ persona: 'admin-content-people' }, { origin: 'https://evil.example' })));
    await expect404(await k.route.POST(post({ persona: 'admin-content-people' }, { origin: 'null' })));
    await expect404(await k.route.POST(post({ persona: 'admin-content-people' }, { origin: 'http://localhost:3000' }))); // another local app
    const noOrigin = post({ persona: 'admin-content-people' });
    noOrigin.headers.delete('origin');
    await expect404(await k.route.POST(noOrigin));
    noOrigin.headers.set('sec-fetch-site', 'cross-site');
    await expect404(await k.route.POST(noOrigin));
    await expect404(await k.route.POST(post({ persona: 'admin-content-people' }, { 'content-type': 'text/plain' })));
    await expect404(await k.route.DELETE(new Request(URL_, { method: 'DELETE', headers: { host: 'app.localhost:3000', origin: 'https://evil.example' } })));
    expect(fake.mock.calls()).toHaveLength(0);
    expect(logs.length).toBe(7);
  });

  it('accepts Sec-Fetch-Site: same-origin when a browser sends no Origin', async () => {
    const r = post({ persona: 'admin-content-people' }, { 'sec-fetch-site': 'same-origin' });
    r.headers.delete('origin');
    expect((await kit().route.POST(r)).status).toBe(200);
  });

  it('refuses when the dev server is reachable from other computers, and says why in the log', async () => {
    const k = kit({ checkBinding: () => Promise.resolve({ ok: false, reason: 'the dev server listens on 0.0.0.0:3000, which other computers can reach.' }) });
    await expect404(await k.route.POST(post({ persona: 'admin-content-people' })));
    await expect404(await k.route.GET(new Request(URL_, { headers: { host: 'app.localhost:3000' } })));
    expect(logs[0]).toMatch(/0\.0\.0\.0:3000/);
    expect(fake.mock.calls()).toHaveLength(0);
  });

  it('refuses a pool that is not a sandbox, and caches the check', async () => {
    fake.options.tags = { Environment: 'main' };
    const k = kit();
    await expect404(await k.route.POST(post({ persona: 'admin-content-people' })));
    await expect404(await k.route.GET(new Request(URL_, { headers: { host: 'app.localhost:3000' } })));
    expect(fake.mock.commandCalls(DescribeUserPoolCommand)).toHaveLength(1);
    expect(fake.mock.commandCalls(AdminInitiateAuthCommand)).toHaveLength(0);
    expect(logs[0]).toMatch(/isn't tagged Environment=sandbox/);
  });

  it('refuses a sandbox in the wrong account', async () => {
    const k = kit({ expectedAccountId: ['9999', '9999', '9999'].join('') });
    await expect404(await k.route.POST(post({ persona: 'admin-content-people' })));
    expect(logs[0]).toMatch(/not the expected/);
  });

  it('caches a passing sandbox check across requests', async () => {
    const k = kit();
    await k.route.POST(post({ persona: 'admin-content' }));
    await k.route.POST(post({ persona: 'admin-view' }));
    await k.route.GET(new Request(URL_, { headers: { host: 'app.localhost:3000' } }));
    expect(fake.mock.commandCalls(DescribeUserPoolCommand)).toHaveLength(1);
  });

  it('refuses an unknown persona or one with no password, with a fix in the log', async () => {
    const k = kit();
    await expect404(await k.route.POST(post({ persona: 'root' })));
    await expect404(await k.route.POST(post({ nope: true })));
    env.delete('PERSONA_PASSWORD_ADMIN_VIEW');
    await expect404(await k.route.POST(post({ persona: 'admin-view' })));
    expect(logs.at(-1)).toMatch(/no password for "admin-view".*seed-personas/);
  });
});

describe('failures after every gate passed', () => {
  it('reports a wrong password with a fix, never the password', async () => {
    const password = env.get('PERSONA_PASSWORD_ADMIN_CONTENT')!;
    fake.userByEmail('admin-content@orchard.test')!.password = 'something-else-entirely-123';
    const res = await kit().route.POST(post({ persona: 'admin-content' }));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe('wrong_password');
    expect(body.detail).toMatch(/seed-personas/);
    expect(JSON.stringify(body) + logs.join('\n')).not.toContain(password);
  });

  it('explains a client without the sandbox-only admin flow', async () => {
    fake.options.adminFlow = false;
    const res = await kit().route.POST(post({ persona: 'admin-content' }));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe('flow_not_enabled');
  });

  it('redacts a secret even if an error message repeats it', async () => {
    const password = env.get('PERSONA_PASSWORD_ADMIN_CONTENT_PEOPLE')!;
    fake.mock.on(AdminInitiateAuthCommand).rejects(Object.assign(new Error(`weird failure mentioning ${password}`), { name: 'InternalErrorException' }));
    const res = await kit().route.POST(post({ persona: 'admin-content-people' }));
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain('[redacted]');
    expect(text + logs.join('\n')).not.toContain(password);
  });
});

describe('the ribbon facts', () => {
  it('names the pool, confirms the sandbox, and names the persona', async () => {
    const k = kit();
    const signedIn = cookieHeaderFrom(await k.route.POST(post({ persona: 'admin-content' })));
    expect(await k.ribbon(signedIn)).toEqual({ environment: 'local', poolId: POOL_ID, persona: 'Admin Content', poolIsSandbox: true });
    const jar = parseCookieHeader(signedIn);
    expect(await k.ribbon({ get: (n) => (jar.has(n) ? { value: jar.get(n)! } : undefined) })).toMatchObject({ persona: 'Admin Content' });
    expect(await k.ribbon(null)).toEqual({ environment: 'local', poolId: POOL_ID, poolIsSandbox: true });
  });

  it('says honestly when the pool is not a sandbox, or could not be checked', async () => {
    fake.options.tags = { Environment: 'main' };
    expect(await kit().ribbon(null)).toMatchObject({ poolIsSandbox: false });
    clearSandboxCheckCache();
    fake.mock.on(DescribeUserPoolCommand).rejects(Object.assign(new Error('Could not load credentials from any providers'), { name: 'CredentialsProviderError' }));
    expect(await kit().ribbon(null)).toMatchObject({ poolIsSandbox: null, poolCheckError: expect.stringMatching(/CredentialsProviderError/) });
  });
});
