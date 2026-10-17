import { NextRequest, NextResponse } from 'next/server';
import { describe, expect, it } from 'vitest';
import { amplifyAdapterRefresh, RETURN_PATH_HEADER, withAuthProxy, type ProxyAuth } from '../../src/proxy/index.js';
import { AuthUnavailableError } from '../../src/server/index.js';
import { amplifyCookiePersona, tamperToken } from '../../src/testing/index.js';
import { CLIENT_ID, harness } from '../helpers.js';

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

describe('public routes', () => {
  it.each(['/', '/about', '/about/', '/legal', '/legal/terms', '/legal/a/b', '/blog/hello-world', '/sign-in', '/_next/static/chunk.js', '/_next/image', '/favicon.ico'])(
    '%s passes without a session',
    async (path) => {
      const { proxy } = setup();
      const res = await proxy(request(path));
      expect(isPassThrough(res)).toBe(true);
      expect(res.headers.get('x-middleware-request-' + RETURN_PATH_HEADER)).toBeNull();
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
    const expired = amplifyCookiePersona({ clientId: CLIENT_ID, username: 'u1', accessToken: h.issuer.mintAccessToken({ sub: 'u1', expiresIn: -10 }) });
    const res = await proxy(request('/dashboard', { headers: expired.headers as Record<string, string> }));
    expect(isPassThrough(res)).toBe(true);
    expect(res.headers.getSetCookie().join('\n')).toContain(fresh);
    expect(res.headers.get('x-middleware-request-cookie')).toContain(`${name}=${fresh}`);
  });

  it('denies when the refreshed token does not verify', async () => {
    const h = harness();
    const proxy = withAuthProxy({ auth: h.auth, refresh: () => Promise.resolve({ accessToken: 'garbage', setCookies: [] }) });
    expect((await proxy(request('/dashboard'))).status).toBe(307);
  });

  it('denies when there is nothing to refresh', async () => {
    const h = harness();
    const proxy = withAuthProxy({ auth: h.auth, refresh: () => Promise.resolve(null) });
    expect((await proxy(request('/api/x'))).status).toBe(401);
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
