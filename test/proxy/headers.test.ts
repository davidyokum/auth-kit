/**
 * The proxy's `headers` hook (#11): headers the app adds to each request (for the page or route) and
 * each response (for the browser), e.g. a nonce-based Content-Security-Policy, without handing the
 * proxy a header-only copy of the request.
 */
import { NextRequest, type NextResponse } from 'next/server';
import { describe, expect, it, vi } from 'vitest';
import {
  RESERVED_REQUEST_HEADERS,
  RESERVED_RESPONSE_HEADERS,
  newCspNonce,
  nonceCspHeaders,
  withAuthProxy,
  type ProxyHeadersHook,
} from '../../src/proxy/index.js';
import { AuthUnavailableError, withAuthErrors } from '../../src/server/index.js';
import { amplifyCookiePersona } from '../../src/testing/index.js';
import { CLIENT_ID, harness, miniNext } from '../helpers.js';

const ORIGIN = 'https://app.example.org';
const isPassThrough = (res: NextResponse) => res.headers.get('x-middleware-next') === '1';
/** What the page or route sees for a request header the proxy forwarded. */
const forwarded = (res: NextResponse, name: string) => res.headers.get(`x-middleware-request-${name}`);

function request(path: string, headers: Record<string, string> = {}, method = 'GET'): NextRequest {
  return new NextRequest(new URL(path, ORIGIN), { method, headers });
}

function setup(headers: ProxyHeadersHook, extra: Partial<Parameters<typeof withAuthProxy>[0]> = {}) {
  const h = harness();
  const proxy = withAuthProxy({ auth: h.auth, publicRoutes: ['/', '/about'], headers, ...extra });
  const session = (sub = 'u1') => {
    const accessToken = h.issuer.mintAccessToken({ sub, username: sub });
    return new Headers(amplifyCookiePersona({ clientId: CLIENT_ID, username: sub, accessToken }).headers as HeadersInit).get('cookie')!;
  };
  return { ...h, proxy, session };
}

describe('withAuthProxy headers hook', () => {
  const hook: ProxyHeadersHook = () => ({
    request: { 'content-security-policy': "script-src 'nonce-abc'", 'x-nonce': 'abc' },
    response: { 'content-security-policy': "script-src 'nonce-abc'", 'x-frame-options': 'DENY' },
  });

  it('adds request headers to every pass-through, public and protected', async () => {
    const { proxy, session } = setup(hook);
    for (const res of [await proxy(request('/')), await proxy(request('/dashboard', { cookie: session() }))]) {
      expect(isPassThrough(res)).toBe(true);
      expect(forwarded(res, 'content-security-policy')).toBe("script-src 'nonce-abc'");
      expect(forwarded(res, 'x-nonce')).toBe('abc');
    }
  });

  it('sets response headers on every response: pass-throughs, sign-in redirects, 401s, and 503s', async () => {
    const h = harness();
    const unavailable = { ...h.auth, verifyAccessToken: () => Promise.reject(new AuthUnavailableError()) };
    const proxy = withAuthProxy({ auth: h.auth, publicRoutes: ['/'], headers: hook });
    const down = withAuthProxy({ auth: unavailable, publicRoutes: ['/'], headers: hook });
    const responses = {
      public: await proxy(request('/')),
      redirect: await proxy(request('/dashboard')),
      api401: await proxy(request('/api/reports')),
      unavailable503: await down(request('/dashboard', { authorization: 'Bearer x.y.z' })),
    };
    expect(responses.redirect.status).toBe(307);
    expect(responses.api401.status).toBe(401);
    expect(responses.unavailable503.status).toBe(503);
    for (const [label, res] of Object.entries(responses)) {
      expect(res.headers.get('content-security-policy'), label).toBe("script-src 'nonce-abc'");
      expect(res.headers.get('x-frame-options'), label).toBe('DENY');
    }
    // The proxy's own headers are untouched.
    expect(responses.redirect.headers.get('location')).toMatch(/\/sign-in\?next=%2Fdashboard$/);
    expect(responses.redirect.headers.get('cache-control')).toBe('private, no-store');
    expect(responses.api401.headers.get('content-type')).toMatch(/application\/json/);
  });

  it('calls the hook once per request, with the request, before the auth decision', async () => {
    const seen = vi.fn<ProxyHeadersHook>(() => undefined);
    const { proxy } = setup(seen);
    await proxy(request('/dashboard?tab=1'));
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0]![0].nextUrl.pathname).toBe('/dashboard');
  });

  it('accepts an async hook, and a hook that adds nothing', async () => {
    const { proxy } = setup(async () => {
      await Promise.resolve();
      return { response: { 'x-async': '1' } };
    });
    expect((await proxy(request('/'))).headers.get('x-async')).toBe('1');
    const quiet = setup(() => undefined).proxy;
    expect(isPassThrough(await quiet(request('/')))).toBe(true);
  });

  it('overwrites a header of the same name the client sent', async () => {
    const { proxy } = setup(hook);
    expect(forwarded(await proxy(request('/', { 'x-nonce': 'attacker' })), 'x-nonce')).toBe('abc');
  });

  it("never forwards a client's own CSP request headers (Next would read its nonce from them)", async () => {
    const { proxy } = setup(() => undefined);
    const res = await proxy(
      request('/', { 'content-security-policy': "script-src 'nonce-attacker'", 'content-security-policy-report-only': "script-src 'nonce-attacker'" }),
    );
    expect(isPassThrough(res)).toBe(true);
    expect(forwarded(res, 'content-security-policy')).toBeNull();
    expect(forwarded(res, 'content-security-policy-report-only')).toBeNull();
    // Without a hook at all, too.
    const plain = withAuthProxy({ auth: harness().auth, publicRoutes: ['/'] });
    expect(forwarded(await plain(request('/', { 'content-security-policy': "script-src 'nonce-attacker'" })), 'content-security-policy')).toBeNull();
  });

  it.each([...RESERVED_REQUEST_HEADERS, 'x-forwarded-for', 'x-forwarded-host', 'x-auth-kit-path', 'x-auth-kit-matrix', 'x-middleware-next', 'next-action', 'next-router-state-tree'])(
    "refuses to set the reserved request header %s (the request fails; it isn't mistaken for 'couldn't check')",
    async (name) => {
      const { proxy } = setup(() => ({ request: { [name]: 'x' } }));
      await expect(proxy(request('/'))).rejects.toThrow(new RegExp(`can't set "${name}" on the request`));
    },
  );

  it.each([...RESERVED_RESPONSE_HEADERS, 'x-auth-kit-proxy', 'x-middleware-rewrite'])('refuses to set the reserved response header %s', async (name) => {
    const { proxy } = setup(() => ({ response: { [name]: 'x' } }));
    await expect(proxy(request('/'))).rejects.toThrow(new RegExp(`can't set "${name}" on the response`));
  });

  it('matches reserved names case-insensitively', async () => {
    const { proxy } = setup(() => ({ request: { Cookie: 'a=b' } }));
    await expect(proxy(request('/'))).rejects.toThrow(/can't set "cookie"/);
  });

  it('refuses a malformed result, and lets a throwing hook fail the request', async () => {
    await expect(setup(() => 'nope' as never).proxy(request('/'))).rejects.toThrow(/must return/);
    await expect(setup(() => ({ requests: {} }) as never).proxy(request('/'))).rejects.toThrow(/unknown key "requests"/);
    await expect(setup(() => ({ request: { 'x-bad': 'line\nbreak' } })).proxy(request('/'))).rejects.toThrow();
    await expect(
      setup(() => {
        throw new Error('hook broke');
      }).proxy(request('/dashboard')),
    ).rejects.toThrow('hook broke');
  });

  it('is validated at startup', () => {
    expect(() => withAuthProxy({ auth: harness().auth, headers: 'csp' as never })).toThrow(/headers must be a function/);
  });

  it('reaches a real route: the route sees the request headers, the browser the response headers', async () => {
    const { proxy, auth, session } = setup(hook);
    const app = miniNext({
      proxy,
      routes: {
        'GET /api/me': withAuthErrors(async (req: Request) => {
          const user = await auth.requireUser({ request: req });
          return Response.json({ sub: user.sub, nonce: req.headers.get('x-nonce') });
        }),
      },
    });
    const res = await app.request(new Request(`${ORIGIN}/api/me`, { headers: { cookie: session('u7') } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sub: 'u7', nonce: 'abc' });
    expect(res.headers.get('content-security-policy')).toBe("script-src 'nonce-abc'");
  });
});

describe('nonceCspHeaders', () => {
  const policy = (nonce: string) => `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic'; object-src 'none'`;

  it('makes a fresh 128-bit base64 nonce per request, on the request (for Next), in x-nonce, and on the response', async () => {
    const { proxy, session } = setup(nonceCspHeaders(policy));
    const a = await proxy(request('/'));
    const b = await proxy(request('/dashboard', { cookie: session() }));
    const nonceA = forwarded(a, 'x-nonce')!;
    const nonceB = forwarded(b, 'x-nonce')!;
    expect(nonceA).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(nonceA).not.toBe(nonceB);
    expect(forwarded(a, 'content-security-policy')).toBe(policy(nonceA));
    expect(a.headers.get('content-security-policy')).toBe(policy(nonceA));
    expect(b.headers.get('content-security-policy')).toBe(policy(nonceB));
  });

  it('matches the nonce shape Next reads from the request CSP header', () => {
    for (let i = 0; i < 50; i++) expect(`'nonce-${newCspNonce()}'`).toMatch(/^'nonce-([A-Za-z0-9+/_-]+={0,2})'$/);
  });

  it('puts the policy on refusals too', async () => {
    const { proxy } = setup(nonceCspHeaders(policy));
    const res = await proxy(request('/api/reports'));
    expect(res.status).toBe(401);
    expect(res.headers.get('content-security-policy')).toMatch(/'nonce-[A-Za-z0-9+/]{22}=='/);
  });

  it('report-only mode: the response header is report-only; the request keeps the header Next reads first', async () => {
    const { proxy } = setup(nonceCspHeaders(policy, { reportOnly: true }));
    const res = await proxy(request('/'));
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(res.headers.get('content-security-policy-report-only')).toBe(policy(forwarded(res, 'x-nonce')!));
    expect(forwarded(res, 'content-security-policy')).toBe(policy(forwarded(res, 'x-nonce')!));
  });

  it('can name the nonce header, or leave it out', async () => {
    const named = await setup(nonceCspHeaders(policy, { nonceHeader: 'x-csp-nonce' })).proxy(request('/'));
    expect(forwarded(named, 'x-csp-nonce')).toMatch(/==$/);
    expect(forwarded(named, 'x-nonce')).toBeNull();
    const none = await setup(nonceCspHeaders(policy, { nonceHeader: false })).proxy(request('/'));
    expect(forwarded(none, 'x-nonce')).toBeNull();
    expect(() => nonceCspHeaders(policy, { nonceHeader: 'cookie' })).toThrow(/usable header name/);
    expect(() => nonceCspHeaders(policy, { nonceHeader: 'x-auth-kit-nonce' })).toThrow(/usable header name/);
  });

  it("refuses a policy that doesn't use the nonce", async () => {
    const { proxy } = setup(nonceCspHeaders(() => "default-src 'self'"));
    await expect(proxy(request('/'))).rejects.toThrow(/must include the nonce/);
    expect(() => nonceCspHeaders('nope' as never)).toThrow(/needs a function/);
  });
});
