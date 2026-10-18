/**
 * End to end against real Next.js (AUTH_KIT_E2E=1, after `npm run build`; CI runs it). The fixture
 * app in test/e2e/app is wired the way the README says. This proves, on Next's own bundles:
 *
 * - #9  the auth matrix's server mode: `startMatrixServer` runs `next dev` with the fixture, the
 *       app's own createServerAuth and createPeopleActions answer from it in every bundle, and the
 *       whole matrix passes with and without the proxy; a production build doesn't contain it.
 * - #7  TOTPEnrollmentGate around a layout's children no longer turns a nested 404 into a 200.
 * - #8  a POST from the page's own origin passes the origin check under `next dev`, whose
 *       request.url says localhost.
 * - #11 the proxy's headers hook: Next stamps its scripts with the CSP nonce from the hook.
 * - #10 in a production build, error.jsx can still tell auth-kit's "couldn't check" apart.
 * - ADR 0014 the proxy never steps aside in a production build, whatever the environment says.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkProductionBuild } from '../../src/dev/index.js';
import {
  AWS_BLOCKED_ENV,
  MATRIX_REQUEST_HEADER,
  PROXY_RESPONSE_HEADER,
  assertAuthMatrix,
  routesFromNextBuild,
  startMatrixServer,
  type MatrixRoute,
  type MatrixServer,
} from '../../src/testing/index.js';

const enabled = process.env.AUTH_KIT_E2E === '1';
const ROOT = join(import.meta.dirname, '..', '..');
const APP = join(import.meta.dirname, 'app');
const NEXT = join(ROOT, 'node_modules', '.bin', 'next');
const POOL = { userPoolId: 'us-east-1_TestPool1', clientId: 'testclient0000000000000000' };

const PERSONAS = {
  member: {},
  otherMember: {},
  admin: { groups: ['admin-content-people'] },
  noAuthenticator: { factors: { configured: ['PASSWORD'], mfa: [] } },
  demotedAdmin: { groups: ['admin-content-people'], liveGroups: [] },
  disabledAdmin: { groups: ['admin-content-people'], enabled: false },
  revokedSession: { groups: ['admin-content'], sessionRevoked: true },
};
type Name = keyof typeof PERSONAS | 'anonymous';
type Expect = Record<Name, number>;

/** Next's own environment for its CLI: never the test runner's NODE_ENV, never a way to AWS. */
function nextEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'NODE_ENV' && !k.startsWith('VITEST') && !/^AWS_/.test(k)) env[k] = v;
  // Next's types make NODE_ENV required; it's left out on purpose (the CLI sets it).
  return { ...env, NEXT_TELEMETRY_DISABLED: '1', ...AWS_BLOCKED_ENV, ...extra } as unknown as NodeJS.ProcessEnv;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

describe.runIf(enabled)('auth-kit on real Next.js', () => {
  let server: MatrixServer<keyof typeof PERSONAS>;
  let recordId = '';

  const send = (path: string, init: RequestInit & { as?: keyof typeof PERSONAS } = {}) => {
    const headers = new Headers(init.headers);
    if (init.as) headers.set('cookie', new Headers(server.cookiePersonas[init.as].headers as HeadersInit).get('cookie')!);
    return fetch(new URL(path, server.baseUrl), { ...init, headers, redirect: 'manual' });
  };

  beforeAll(async () => {
    const build = spawnSync(NEXT, ['build'], { cwd: APP, env: nextEnv(), encoding: 'utf8' });
    if (build.status !== 0) throw new Error(`next build failed:\n${build.stdout}\n${build.stderr}`);
    server = await startMatrixServer({
      cwd: APP,
      pool: POOL,
      personas: PERSONAS,
      command: (port) => [NEXT, 'dev', '--hostname', '127.0.0.1', '--port', String(port)],
    });
    // The member files a record through the API from the page's own origin (exercises #8).
    const created = await send('/api/records', {
      as: 'member',
      method: 'POST',
      headers: { origin: server.baseUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Member’s own record' }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    recordId = ((await created.json()) as { id: string }).id;
  }, 400_000);

  afterAll(async () => {
    await server?.stop();
  });

  it('#9: a production build of the app has no matrix server code (the alias kept it out)', async () => {
    const result = await checkProductionBuild({ buildDir: join(APP, '.next') });
    expect(result.findings).toEqual([]);
    expect(result.filesScanned).toBeGreaterThan(50);
  });

  it('#9: every route answers every persona as the standard requires, with and without the proxy', async () => {
    const SIGNED_IN_PAGE: Expect = {
      anonymous: 307, member: 200, otherMember: 200, admin: 200,
      noAuthenticator: 307, demotedAdmin: 200, disabledAdmin: 307, revokedSession: 307,
    };
    const PUBLIC: Expect = { ...SIGNED_IN_PAGE, anonymous: 200, noAuthenticator: 200, disabledAdmin: 200, revokedSession: 200 };
    const RECORD_PAGE: Expect = { ...SIGNED_IN_PAGE, otherMember: 404 };
    const ADMIN_PAGE: Expect = { ...SIGNED_IN_PAGE, member: 404, otherMember: 404, demotedAdmin: 404 };
    const API: Expect = { anonymous: 401, member: 200, otherMember: 200, admin: 200, noAuthenticator: 403, demotedAdmin: 200, disabledAdmin: 401, revokedSession: 401 };
    const routes: MatrixRoute[] = [
      { path: '/', expect: PUBLIC },
      { path: '/sign-in', expect: PUBLIC },
      { path: '/unavailable', expect: PUBLIC },
      { path: '/records', expect: SIGNED_IN_PAGE },
      { path: '/records/:id', expect: RECORD_PAGE },
      { path: '/admin', expect: ADMIN_PAGE },
      { path: '/api/records', expect: API },
      {
        method: 'POST',
        path: '/api/records',
        headers: { origin: server.baseUrl },
        body: { title: 'From the matrix' },
        expect: Object.fromEntries(Object.entries(API).map(([k, v]) => [k, v === 200 ? 201 : v])),
      },
      { path: '/api/records/:id', expect: { ...API, otherMember: 404 } },
    ];
    await assertAuthMatrix({
      request: (req) => fetch(req, { redirect: 'manual' }),
      baseUrl: server.baseUrl,
      appRoutes: routesFromNextBuild(join(APP, '.next')).filter((r) => !r.path.startsWith('/_')),
      personas: server.cookiePersonas,
      params: { id: recordId },
      routes,
    });
  }, 400_000);

  it('#9: the admin page lists the fixture’s people (the read-only People client, in its own bundle)', async () => {
    const page = await send('/admin', { as: 'admin' });
    expect(page.status).toBe(200);
    expect(await page.text()).toMatch(new RegExp(`${Object.keys(PERSONAS).length}(<!-- -->)? people`));
  });

  it('#7: the gate around the records layout keeps the nested page’s 404 for someone else’s record', async () => {
    expect((await send(`/records/${recordId}`, { as: 'otherMember' })).status).toBe(404);
    const own = await send(`/records/${recordId}`, { as: 'member' });
    expect(own.status).toBe(200);
    const html = await own.text();
    // Rendered on the server, inside the gate's content slot, hidden until the browser check passes.
    expect(html).toMatch(/data-auth-kit-slot="content" hidden="">[\s\S]*Member’s own record/);
  });

  it('#8: the origin check passes the page’s own origin under next dev and refuses others', async () => {
    const post = (origin: string) =>
      send('/api/records', { as: 'member', method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' });
    expect((await post(server.baseUrl)).status).toBe(201);
    expect((await post(`http://localhost:${server.port}`)).status).toBe(201); // request.url's own origin
    const evil = await post('https://evil.example');
    expect(evil.status).toBe(403);
    expect(((await evil.json()) as { error: string }).error).toBe('origin_mismatch');
  });

  it('#11: Next stamps its scripts with the nonce from the proxy’s headers hook', async () => {
    const page = await send('/');
    const csp = page.headers.get('content-security-policy') ?? '';
    const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)?.[1];
    expect(nonce).toBeDefined();
    const html = await page.text();
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag).toContain(`nonce="${nonce}"`);
    // A fresh nonce per request, on refusals too.
    const again = await send('/records');
    expect(again.status).toBe(307);
    expect(again.headers.get('content-security-policy')).toMatch(/'nonce-/);
    expect(again.headers.get('content-security-policy')).not.toContain(nonce!);
  });

  describe('a production server (next start)', () => {
    let prod: ReturnType<typeof spawn> | undefined;
    let base = '';

    beforeAll(async () => {
      const port = await freePort();
      base = `http://127.0.0.1:${port}`;
      // The matrix flag and a fixture are set on purpose: a production build must ignore both.
      prod = spawn(NEXT, ['start', '--hostname', '127.0.0.1', '--port', String(port)], {
        cwd: APP,
        env: nextEnv({ AUTH_KIT_MATRIX: '1', AUTH_KIT_MATRIX_FIXTURE: JSON.stringify(server.fixture) }),
        stdio: 'ignore',
        detached: true,
      });
      const deadline = Date.now() + 60_000;
      for (;;) {
        try {
          if ((await fetch(base, { redirect: 'manual' })).status < 500) break;
        } catch {
          // not yet
        }
        if (Date.now() > deadline) throw new Error('next start wasn’t ready');
        await new Promise((r) => setTimeout(r, 250));
      }
    }, 120_000);

    afterAll(() => {
      if (prod?.pid) {
        try {
          process.kill(-prod.pid, 'SIGTERM');
        } catch {
          // gone
        }
      }
    });

    it('#10: the error boundary gets auth-kit’s digest in production, and nothing else of the error', async () => {
      const page = await fetch(`${base}/unavailable?fail=1`);
      expect(page.status).toBe(500);
      const html = await page.text();
      // Production Next renders error boundaries in the browser from the RSC payload: the error
      // reaches error.jsx as { digest } only, and isAuthUnavailableError reads that digest.
      expect(html).toMatch(/E\{\\"digest\\":\\"AUTH_KIT_AUTH_UNAVAILABLE;[0-9a-f]{16}\\"\}/);
      expect(html).not.toContain('Sign-in status is temporarily unavailable'); // the message stays on the server
      expect(html).not.toContain('AuthUnavailableError'); // and so does the name
    });

    it('ADR 0014: the proxy never steps aside in a production build, whatever the environment says', async () => {
      // Anonymous on purpose: a request with a token would make this server fetch the (placeholder)
      // pool's keys from Cognito, and tests never reach AWS.
      const marked = await fetch(`${base}/records`, { redirect: 'manual', headers: { [MATRIX_REQUEST_HEADER]: 'handlers' } });
      expect(marked.status).toBe(307);
      expect(marked.headers.get(PROXY_RESPONSE_HEADER)).toBe('denied');
      const api = await fetch(`${base}/api/records`, { headers: { [MATRIX_REQUEST_HEADER]: 'handlers' } });
      expect(api.status).toBe(401);
      expect(api.headers.get(PROXY_RESPONSE_HEADER)).toBe('denied');
    });
  });
});
