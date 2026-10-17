import type { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { amplifyAdapterRefresh, RETURN_PATH_HEADER, withAuthProxy, type ProxyAuth } from '../../src/proxy/index.js';
import { AuthUnavailableError } from '../../src/server/index.js';
import { amplifyCookiePersona, createTestIssuer, tamperToken } from '../../src/testing/index.js';
import { CLIENT_ID, OTHER_CLIENT_ID, OTHER_POOL_ID, harness } from '../helpers.js';

const ORIGIN = 'https://app.example.org';

function request(path: string, init: { method?: string; headers?: Record<string, string> } = {}): NextRequest {
  return new NextRequest(new URL(path, ORIGIN), {
    method: init.method ?? 'GET',
    headers: init.headers ?? {},
  });
}

function setup(options: Partial<Parameters<typeof withAuthProxy>[0]> = {}) {
  const h = harness();
  const proxy = withAuthProxy({ auth: h.auth, publicRoutes: ['/', '/about', '/legal/*', /^\/blog\/[a-z-]+$/], ...options });
  return { ...h, proxy };
}

const isPassThrough = (res: NextResponse) => res.headers.get('x-middleware-next') === '1';

/** Amplify cookies for a session whose access token has expired, with a refresh-token cookie unless told otherwise. */
function expiredSession(
  h: ReturnType<typeof harness>,
  o: { sub?: string; accessToken?: string; refreshToken?: string | null } = {},
): string {
  const sub = o.sub ?? 'u1';
  const base = `CognitoIdentityServiceProvider.${CLIENT_ID}`;
  const accessToken = o.accessToken ?? h.issuer.mintAccessToken({ sub, expiresIn: -10 });
  const pairs = [`${base}.LastAuthUser=${sub}`, `${base}.${sub}.accessToken=${accessToken}`];
  if (o.refreshToken !== null) pairs.push(`${base}.${sub}.refreshToken=${o.refreshToken ?? 'rt-1'}`);
  return pairs.join('; ');
}

describe('public routes', () => {
  it.each(['/', '/about', '/about/', '/legal', '/legal/terms', '/legal/a/b', '/blog/hello-world', '/sign-in', '/_next/static/chunk.js', '/_next/image', '/favicon.ico'])(
    '%s passes without a session',
    async (path) => {
      const { proxy } = setup();
      const res = await proxy(request(path));
      expect(isPassThrough(res)).toBe(true);
      // The return path is recorded on public routes too, so a client can never supply its own.
      expect(res.headers.get('x-middleware-request-' + RETURN_PATH_HEADER)).toBe(path);
      expect(res.headers.get('cache-control')).toBeNull();
    },
  );

  it.each(['/aboutx', '/legalese', '/blog/Hello', '/blog/a/b', '/dashboard', '/api/reports', '/sign-in-extra'])(
    '%s is protected (default-deny)',
    async (path) => {
      const { proxy } = setup();
      const res = await proxy(request(path));
      expect(isPassThrough(res)).toBe(false);
    },
  );

  it('treats encoded slashes and backslashes as protected, never public', async () => {
    const { proxy } = setup();
    for (const path of ['/legal/..%2Fadmin', '/legal%2F..%2Fadmin', '/legal/%5C..%5Cadmin']) {
      expect(isPassThrough(await proxy(request(path)))).toBe(false);
    }
  });

  it('can stop treating Next internals as public', async () => {
    const { proxy } = setup({ allowNextInternals: false });
    expect(isPassThrough(await proxy(request('/_next/static/chunk.js')))).toBe(false);
  });

  it('rejects a public route that does not start with a slash', () => {
    const h = harness();
    expect(() => withAuthProxy({ auth: h.auth, publicRoutes: ['about'] })).toThrow(/must start with/);
  });
});

describe('allowlist validation at startup (M3)', () => {
  const build = (publicRoutes: unknown[]) => () => withAuthProxy({ auth: harness().auth, publicRoutes: publicRoutes as never });

  it("refuses '/*', which would make every path public", () => {
    expect(build(['/*'])).toThrow(/makes every path public/);
  });

  it('refuses an unanchored RegExp (it matches longer paths: /admin/blog/x)', () => {
    expect(build([/\/blog\//])).toThrow(/must be anchored/);
    expect(build([/^\/blog\//])).toThrow(/must be anchored/);
    expect(build([/\/blog\/[a-z-]+$/])).toThrow(/must be anchored/);
  });

  it('refuses an anchored RegExp that still matches (nearly) everything', () => {
    for (const re of [/^.*$/, /^\/.*$/, /^\/[a-z0-9-]+$/i, /^\/(?!admin).*$/]) expect(build([re])).toThrow(/default-deny off/);
  });

  it('refuses stateful or multiline RegExp flags', () => {
    expect(build([/^\/blog$/g])).toThrow(/g, y, or m/);
    expect(build([/^\/blog$/m])).toThrow(/g, y, or m/);
  });

  it.each([
    ['about', /must start with/],
    ['/legal/*/x', /only as a final/],
    ['/a*', /only as a final/],
    ['/about?x=1', /plain path/],
    ['/a b', /plain path/],
    ['/%61dmin', /plain path/],
    ['/legal/../admin', /"\." or "\.\." segments/],
  ])('refuses the malformed path %s', (route, message) => {
    expect(build([route])).toThrow(message);
  });

  it('refuses a rule that is neither a string nor a RegExp', () => {
    expect(build([42])).toThrow(/path string or a RegExp/);
  });

  it('accepts the documented shapes', () => {
    expect(build(['/', '/about', '/legal/*', /^\/blog\/[a-z-]+$/, /^\/docs\/[a-z-]+$/i])).not.toThrow();
  });

  it('fails loudly on other misconfigurations', () => {
    const h = harness();
    expect(() => withAuthProxy({ auth: h.auth, publicRoute: ['/'] } as never)).toThrow(/no option "publicRoute"/);
    expect(() => withAuthProxy({ auth: {} as never })).toThrow(/needs `auth`/);
    expect(() => withAuthProxy({ auth: h.auth, signInPath: 'https://evil.example/login' })).toThrow(/signInPath/);
    expect(() => withAuthProxy({ auth: h.auth, signInPath: '/login?x=1' })).toThrow(/signInPath/);
    expect(() => withAuthProxy({ auth: h.auth, apiRoutes: [/\/api\//] })).toThrow(/must be anchored/);
    expect(() => withAuthProxy({ auth: h.auth, noStore: 'yes' as never })).toThrow(/noStore/);
    // apiRoutes may cover everything: an API-only app answers 401 JSON everywhere.
    expect(() => withAuthProxy({ auth: h.auth, apiRoutes: ['/*'] })).not.toThrow();
  });
});

describe('public routes and the return-path header (L5)', () => {
  it('overwrites a client-supplied x-auth-kit-path on public routes', async () => {
    const { proxy } = setup();
    const res = await proxy(request('/about?x=1', { headers: { [RETURN_PATH_HEADER]: '/evil-choice' } }));
    expect(isPassThrough(res)).toBe(true);
    expect(res.headers.get('x-middleware-request-' + RETURN_PATH_HEADER)).toBe('/about?x=1');
  });
});

describe('protected routes without a valid session', () => {
  it('redirects a page request to sign-in with a safe return path', async () => {
    const { proxy } = setup();
    const res = await proxy(request('/reports/42?tab=notes'));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location') ?? '');
    expect(location.origin).toBe(ORIGIN);
    expect(location.pathname).toBe('/sign-in');
    expect(location.searchParams.get('next')).toBe('/reports/42?tab=notes');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('builds the sign-in redirect from the request URL, never from a spoofed Host header', async () => {
    const { proxy } = setup();
    const raw = new Request('https://app.example.org/reports/1', { headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' } });
    const res = await proxy(new NextRequest(raw));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location') ?? '');
    expect(location.host).toBe('app.example.org');
    expect(location.searchParams.get('next')).toBe('/reports/1');
    expect(res.headers.get('x-auth-kit-proxy')).toBe('denied');
  });

  it('honors a custom sign-in path', async () => {
    const { proxy } = setup({ signInPath: '/login' });
    expect(isPassThrough(await proxy(request('/login')))).toBe(true);
    expect(new URL((await proxy(request('/x'))).headers.get('location') ?? '').pathname).toBe('/login');
  });

  it('answers API routes with 401 JSON', async () => {
    const { proxy } = setup();
    const res = await proxy(request('/api/reports'));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(await res.json()).toMatchObject({ error: 'unauthenticated' });
  });

  it('answers non-GET page requests (forms, server actions) with 401 JSON instead of a redirect', async () => {
    const { proxy } = setup();
    const res = await proxy(request('/reports/42', { method: 'POST' }));
    expect(res.status).toBe(401);
  });

  it('refuses a forged token (it verifies, not just checks for a cookie)', async () => {
    const { proxy, issuer } = setup();
    const forged = tamperToken(issuer.mintAccessToken({ groups: [] }), { 'cognito:groups': ['superadmin'] });
    const res = await proxy(request('/api/admin', { headers: { authorization: `Bearer ${forged}` } }));
    expect(res.status).toBe(401);
  });

  it('refuses a cookie that merely exists', async () => {
    const { proxy } = setup();
    const persona = amplifyCookiePersona({ clientId: CLIENT_ID, username: 'u', accessToken: 'anything' });
    const res = await proxy(request('/dashboard', { headers: persona.headers as Record<string, string> }));
    expect(res.status).toBe(307);
  });

  it('answers 503 when the session cannot be checked, rather than pretending it is signed out', async () => {
    const auth: ProxyAuth = {
      pool: { clientId: CLIENT_ID },
      tokenSource: () => ({ accessToken: 'x' }),
      verifyAccessToken: () => Promise.reject(new AuthUnavailableError()),
    };
    const res = await withAuthProxy({ auth })(request('/dashboard'));
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
  });

  it('answers 503 for an unexpected error, never a pass', async () => {
    const auth: ProxyAuth = {
      pool: { clientId: CLIENT_ID },
      tokenSource: () => Promise.reject(new Error('boom')),
      verifyAccessToken: () => Promise.resolve({} as never),
    };
    const res = await withAuthProxy({ auth })(request('/dashboard'));
    expect(res.status).toBe(503);
  });
});

describe('protected routes with a valid session', () => {
  it('passes a valid Amplify cookie session through, records the path, and marks it no-store', async () => {
    const { proxy, issuer } = setup();
    const persona = amplifyCookiePersona({ clientId: CLIENT_ID, username: 'u1', accessToken: issuer.mintAccessToken({ sub: 'u1' }) });
    const res = await proxy(request('/reports/42?x=1', { headers: persona.headers as Record<string, string> }));
    expect(isPassThrough(res)).toBe(true);
    expect(res.headers.get('x-middleware-request-' + RETURN_PATH_HEADER)).toBe('/reports/42?x=1');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('passes a valid bearer token on an API route', async () => {
    const { proxy, issuer } = setup();
    const res = await proxy(request('/api/reports', { headers: { authorization: `Bearer ${issuer.mintAccessToken()}` } }));
    expect(isPassThrough(res)).toBe(true);
  });

  it('overwrites a client-supplied return-path header', async () => {
    const { proxy, issuer } = setup();
    const res = await proxy(
      request('/reports', { headers: { authorization: `Bearer ${issuer.mintAccessToken()}`, [RETURN_PATH_HEADER]: '//evil.example' } }),
    );
    expect(res.headers.get('x-middleware-request-' + RETURN_PATH_HEADER)).toBe('/reports');
  });

  it('can leave Cache-Control alone', async () => {
    const { proxy, issuer } = setup({ noStore: false });
    const res = await proxy(request('/reports', { headers: { authorization: `Bearer ${issuer.mintAccessToken()}` } }));
    expect(res.headers.get('cache-control')).toBeNull();
  });
});

describe('server-side refresh', () => {
  it('refreshes an expired session, forwards the new cookies, and lets the request through', async () => {
    const h = harness();
    const fresh = h.issuer.mintAccessToken({ sub: 'u1' });
    const name = `CognitoIdentityServiceProvider.${CLIENT_ID}.u1.accessToken`;
    const proxy = withAuthProxy({
      auth: h.auth,
      refresh: () => Promise.resolve({ accessToken: fresh, setCookies: [`${name}=${fresh}; Path=/; Secure; SameSite=Lax`] }),
    });
    const res = await proxy(request('/dashboard', { headers: { cookie: expiredSession(h) } }));
    expect(isPassThrough(res)).toBe(true);
    expect(res.headers.getSetCookie().join('\n')).toContain(fresh);
    expect(res.headers.get('x-middleware-request-cookie')).toContain(`${name}=${fresh}`);
  });

  it('denies when the refreshed token does not verify', async () => {
    const h = harness();
    const proxy = withAuthProxy({ auth: h.auth, refresh: () => Promise.resolve({ accessToken: 'garbage', setCookies: [] }) });
    expect((await proxy(request('/dashboard', { headers: { cookie: expiredSession(h) } }))).status).toBe(307);
  });

  it('denies when there is nothing to refresh', async () => {
    const h = harness();
    const proxy = withAuthProxy({ auth: h.auth, refresh: () => Promise.resolve(null) });
    const res = await proxy(request('/api/x', { headers: { cookie: expiredSession(h) } }));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'token_expired' });
  });
});

describe('server-side refresh is attempted only for a genuine expired session (M1)', () => {
  function counting(h: ReturnType<typeof harness>, extra: Partial<Parameters<typeof withAuthProxy>[0]> = {}) {
    const calls: string[] = [];
    const fresh = h.issuer.mintAccessToken({ sub: 'u1' });
    const proxy = withAuthProxy({
      auth: h.auth,
      refresh: (req) => {
        calls.push(req.nextUrl.pathname);
        return Promise.resolve({ accessToken: fresh, setCookies: [] });
      },
      ...extra,
    });
    return { calls, proxy };
  }

  it('never refreshes an anonymous request', async () => {
    const h = harness();
    const { calls, proxy } = counting(h);
    expect((await proxy(request('/api/x'))).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('never refreshes a forged token, even with a refresh cookie', async () => {
    const h = harness();
    const { calls, proxy } = counting(h);
    const forged = tamperToken(h.issuer.mintAccessToken({ sub: 'u1', expiresIn: -10 }), { 'cognito:groups': ['superadmin'] });
    const res = await proxy(request('/api/x', { headers: { cookie: expiredSession(h, { accessToken: forged }) } }));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'invalid_token' });
    expect(calls).toEqual([]);
  });

  it("never refreshes another pool's or another app client's expired token", async () => {
    const h = harness();
    const { calls, proxy } = counting(h);
    const foreignPool = createTestIssuer({ userPoolId: OTHER_POOL_ID, clientId: CLIENT_ID }).mintAccessToken({ sub: 'u1', expiresIn: -10 });
    const otherClient = h.issuer.mintAccessToken({ sub: 'u1', expiresIn: -10, claims: { client_id: OTHER_CLIENT_ID } });
    const idToken = h.issuer.mintIdToken({ sub: 'u1', expiresIn: -10 });
    for (const accessToken of [foreignPool, otherClient, idToken]) {
      expect((await proxy(request('/api/x', { headers: { cookie: expiredSession(h, { accessToken }) } }))).status).toBe(401);
    }
    expect(calls).toEqual([]);
  });

  it('never refreshes without a refresh-token cookie', async () => {
    const h = harness();
    const { calls, proxy } = counting(h);
    expect((await proxy(request('/api/x', { headers: { cookie: expiredSession(h, { refreshToken: null }) } }))).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('never refreshes a bearer token', async () => {
    const h = harness();
    const { calls, proxy } = counting(h);
    const expired = h.issuer.mintAccessToken({ sub: 'u1', expiresIn: -10 });
    const res = await proxy(request('/api/x', { headers: { authorization: `Bearer ${expired}`, cookie: expiredSession(h) } }));
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('shares one refresh among concurrent requests from the same session', async () => {
    const h = harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const calls: number[] = [];
    const fresh = h.issuer.mintAccessToken({ sub: 'u1' });
    const proxy = withAuthProxy({
      auth: h.auth,
      refresh: async () => {
        calls.push(1);
        await gate;
        return { accessToken: fresh, setCookies: ['a=b; Path=/; Secure'] };
      },
    });
    const cookie = expiredSession(h);
    const pending = [1, 2, 3, 4, 5].map(() => proxy(request('/dashboard', { headers: { cookie } })));
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    const results = await Promise.all(pending);
    expect(calls).toHaveLength(1);
    expect(results.every((r) => isPassThrough(r) && r.headers.getSetCookie().includes('a=b; Path=/; Secure'))).toBe(true);
  });

  it('limits refreshes per person, so one old token cannot spend the WAF budget', async () => {
    const h = harness();
    const outcomes: string[] = [];
    const { calls, proxy } = counting(h, { refreshLimits: { perUser: 2 }, onRefresh: (e) => outcomes.push(e.outcome) });
    // Each request is a separate session (new jti), as an attacker replaying many old tokens would send.
    for (let i = 0; i < 5; i++) await proxy(request('/api/x', { headers: { cookie: expiredSession(h, { refreshToken: `rt-${i}` }) } }));
    expect(calls).toHaveLength(2);
    expect(outcomes).toEqual(['refreshed', 'refreshed', 'throttled', 'throttled', 'throttled']);
  });

  it('limits refreshes per server instance across everyone', async () => {
    const h = harness();
    const { calls, proxy } = counting(h, { refreshLimits: { perInstance: 3 } });
    for (let i = 0; i < 6; i++) {
      await proxy(request('/api/x', { headers: { cookie: expiredSession(h, { sub: `person-${i}` }) } }));
    }
    expect(calls).toHaveLength(3);
  });

  it('backs off after a failed refresh, doubling the pause, and recovers', async () => {
    const h = harness();
    const clock = { now: 1_000_000 };
    const outcomes: string[] = [];
    let succeed = false;
    const fresh = h.issuer.mintAccessToken({ sub: 'u1' });
    const proxy = withAuthProxy({
      auth: h.auth,
      refreshLimits: { perUser: 100, failureBackoffSeconds: 30, now: () => clock.now },
      onRefresh: (e) => outcomes.push(e.outcome),
      refresh: () => Promise.resolve(succeed ? { accessToken: fresh, setCookies: [] } : null),
    });
    const send = () => proxy(request('/api/x', { headers: { cookie: expiredSession(h) } }));
    await send(); // fails: 30 s pause
    await send(); // paused
    clock.now += 31_000;
    await send(); // fails again: 60 s pause
    clock.now += 31_000;
    await send(); // still paused
    clock.now += 30_000;
    succeed = true;
    expect(isPassThrough(await send())).toBe(true);
    expect(outcomes).toEqual(['failed', 'backing-off', 'failed', 'backing-off', 'refreshed']);
  });

  it('answers 503 (not a pass, not a back-off) when the refreshed token cannot be checked', async () => {
    const h = harness();
    const auth: ProxyAuth = {
      ...h.auth,
      pool: h.auth.pool,
      tokenSource: h.auth.tokenSource,
      verifyAccessToken: (token) =>
        token === 'unverifiable' ? Promise.reject(new AuthUnavailableError()) : h.auth.verifyAccessToken(token),
    };
    const proxy = withAuthProxy({ auth, refresh: () => Promise.resolve({ accessToken: 'unverifiable', setCookies: [] }) });
    expect((await proxy(request('/api/x', { headers: { cookie: expiredSession(h) } }))).status).toBe(503);
  });

  it('validates refreshLimits at startup', () => {
    const h = harness();
    expect(() => withAuthProxy({ auth: h.auth, refreshLimits: { perUser: 0 } })).toThrow(/positive whole number/);
    expect(() => withAuthProxy({ auth: h.auth, refreshLimits: { perUsr: 3 } as never })).toThrow(/unknown refreshLimits option/);
  });
});

describe('amplifyAdapterRefresh', () => {
  it('runs fetchAuthSession in a request/response context and returns the cookies it set', async () => {
    const refresh = amplifyAdapterRefresh({
      runWithAmplifyServerContext: async ({ nextServerContext, operation }) => {
        nextServerContext.response.cookies.set('CognitoIdentityServiceProvider.c.u.accessToken', 'new-token');
        return operation(undefined as never);
      },
      fetchAuthSession: () => Promise.resolve({ tokens: { accessToken: { toString: () => 'new-token' } } }),
    });
    const result = await refresh(request('/dashboard'));
    expect(result?.accessToken).toBe('new-token');
    expect(result?.setCookies.join('\n')).toContain('accessToken=new-token');
  });

  it('returns null when the adapter has no tokens or throws', async () => {
    const none = amplifyAdapterRefresh({
      runWithAmplifyServerContext: ({ operation }) => Promise.resolve(operation(undefined as never)),
      fetchAuthSession: () => Promise.resolve({}),
    });
    expect(await none(request('/x'))).toBeNull();
    const throws = amplifyAdapterRefresh({
      runWithAmplifyServerContext: () => Promise.reject(new Error('refresh failed')),
      fetchAuthSession: () => Promise.resolve({}),
    });
    expect(await throws(request('/x'))).toBeNull();
  });
});
