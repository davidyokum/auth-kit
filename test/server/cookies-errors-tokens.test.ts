import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AuthUnavailableError,
  ForbiddenError,
  FirstCredentialRequiredError,
  MfaEnrollmentRequiredError,
  NotFoundError,
  StepUpRequiredError,
  UnauthenticatedError,
  amplifyCookieNames,
  amplifyCookieRuntimeOptions,
  amplifyCookieTokens,
  applyNoStore,
  assertSameOrigin,
  authErrorResponse,
  bearerToken,
  encodeCookieName,
  firstTokenSource,
  isSameOriginRequest,
  poolConfigFromAmplifyOutputs,
  secureCookieOptions,
  serializeCookie,
  signInUrl,
  toRequestContext,
  withAuthErrors,
  parseCookieHeader,
} from '../../src/server/index.js';
import { RequestCookies } from 'next/dist/compiled/@edge-runtime/cookies/index.js';

describe('cookie helpers', () => {
  it('defaults to httpOnly, Secure, SameSite=Lax, path /', () => {
    expect(secureCookieOptions()).toEqual({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
    expect(secureCookieOptions({ maxAge: 60, sameSite: 'strict' })).toMatchObject({ httpOnly: true, sameSite: 'strict', maxAge: 60 });
  });

  it('refuses SameSite=None without Secure', () => {
    expect(() => secureCookieOptions({ sameSite: 'none', secure: false })).toThrow(/must be Secure/);
    expect(() => serializeCookie('a', 'b', { sameSite: 'none' })).toThrow(/must be Secure/);
  });

  it('serializes Set-Cookie headers and rejects unsafe names and values', () => {
    expect(serializeCookie('flash', 'saved', secureCookieOptions({ maxAge: 30 }))).toBe('flash=saved; Max-Age=30; Path=/; HttpOnly; Secure; SameSite=Lax');
    expect(() => serializeCookie('bad name', 'x')).toThrow(/cookie name/);
    expect(() => serializeCookie('n', 'a;b')).toThrow(/encoding/);
    expect(() => serializeCookie('n', 'a b')).toThrow(/encoding/);
  });

  it('makes server-written Amplify cookies Secure, SameSite=Lax, and no longer-lived than the refresh token (M2)', () => {
    expect(amplifyCookieRuntimeOptions({ refreshTokenMinutes: 1440 })).toEqual({ cookies: { sameSite: 'lax', secure: true, maxAge: 86400 } });
    expect(amplifyCookieRuntimeOptions({ refreshTokenMinutes: 60, domain: 'example.org' }).cookies).toMatchObject({ secure: true, domain: 'example.org' });
  });

  it('drops Secure only for a declared http://localhost development origin', () => {
    for (const origin of ['http://localhost:3000', 'http://app.localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
      expect(amplifyCookieRuntimeOptions({ refreshTokenMinutes: 60, localDevOrigin: origin }).cookies.secure).toBe(false);
    }
    for (const origin of ['https://localhost:3000', 'http://app.example.org', 'http://localhost.evil.example', 'http://localhost:3000/', 'localhost']) {
      expect(() => amplifyCookieRuntimeOptions({ refreshTokenMinutes: 60, localDevOrigin: origin })).toThrow(/localDevOrigin/);
    }
  });

  it('refuses a nonsensical refresh-token lifetime', () => {
    for (const minutes of [0, -1, Number.NaN, Infinity]) {
      expect(() => amplifyCookieRuntimeOptions({ refreshTokenMinutes: minutes })).toThrow(/positive refreshTokenMinutes/);
    }
  });

  it('sets Cache-Control: private, no-store', () => {
    expect(applyNoStore(new Headers()).get('cache-control')).toBe('private, no-store');
  });
});

describe('origin checks for state-changing route handlers', () => {
  const req = (method: string, headers: Record<string, string>) => ({ method, url: 'https://app.example.org/api/x', headers: new Headers(headers) });
  it.each([
    ['GET with any origin', req('GET', { origin: 'https://evil.example' }), true],
    ['POST same origin', req('POST', { origin: 'https://app.example.org' }), true],
    ['POST cross origin', req('POST', { origin: 'https://evil.example' }), false],
    ['POST other scheme', req('POST', { origin: 'http://app.example.org' }), false],
    ['POST null origin', req('POST', { origin: 'null' }), false],
    ['POST no origin, same-origin fetch metadata', req('POST', { 'sec-fetch-site': 'same-origin' }), true],
    ['POST no origin, cross-site fetch metadata', req('POST', { 'sec-fetch-site': 'cross-site' }), false],
    ['POST no headers at all', req('POST', {}), false],
    ['DELETE cross origin', req('DELETE', { origin: 'https://evil.example' }), false],
    ['POST spoofed X-Forwarded-Host', req('POST', { origin: 'https://evil.example', 'x-forwarded-host': 'evil.example' }), false],
  ])('%s', (_label, request, ok) => {
    expect(isSameOriginRequest(request)).toBe(ok);
  });

  it('compares with a configured expectedOrigin instead of the rebuilt request URL (L7)', () => {
    // Behind a CDN the app may see http:// while the browser sends Origin: https://.
    const behindCdn = { method: 'POST', url: 'http://app.example.org/api/x', headers: new Headers({ origin: 'https://app.example.org' }) };
    expect(isSameOriginRequest(behindCdn)).toBe(false);
    expect(isSameOriginRequest(behindCdn, { expectedOrigin: 'https://app.example.org' })).toBe(true);
    const http = { ...behindCdn, headers: new Headers({ origin: 'http://app.example.org' }) };
    expect(isSameOriginRequest(http, { expectedOrigin: 'https://app.example.org' })).toBe(false);
    const evil = { ...behindCdn, headers: new Headers({ origin: 'https://evil.example' }) };
    expect(isSameOriginRequest(evil, { expectedOrigin: 'https://app.example.org' })).toBe(false);
  });

  it('throws on a malformed expectedOrigin or allowedOrigins entry instead of silently refusing everything', () => {
    const request = req('POST', { origin: 'https://app.example.org' });
    for (const bad of ['https://app.example.org/', 'app.example.org', 'https://app.example.org/path', 'https://APP.example.org']) {
      expect(() => isSameOriginRequest(request, { expectedOrigin: bad })).toThrow(/must be an origin/);
      expect(() => isSameOriginRequest(request, { allowedOrigins: [bad] })).toThrow(/must be an origin/);
    }
  });

  it('accepts explicitly allowed origins and throws 403 otherwise', () => {
    const request = req('POST', { origin: 'https://admin.example.org' });
    expect(isSameOriginRequest(request, { allowedOrigins: ['https://admin.example.org'] })).toBe(true);
    expect(() => assertSameOrigin(request)).toThrow(ForbiddenError);
  });
});

describe('the origin check under next dev, which rewrites request.url to localhost (#8)', () => {
  afterEach(() => vi.unstubAllEnvs());
  // What Next 16.4's `next dev --hostname 127.0.0.1` hands a route handler: request.url says
  // localhost whatever the browser asked for; Host and Origin say what it actually used.
  const devRequest = (host: string, origin: string | null, url = `http://localhost:${host.split(':').pop()}/api/tickets`) => ({
    method: 'POST',
    url,
    headers: new Headers({ host, ...(origin !== null && { origin }) }),
  });

  it.each([
    ['127.0.0.1 (the matrix server)', '127.0.0.1:3210', 'http://127.0.0.1:3210'],
    ['one *.localhost name per app (the localhost guide)', 'app.localhost:3000', 'http://app.localhost:3000'],
    ['plain localhost', 'localhost:3000', 'http://localhost:3000'],
    ['IPv6 loopback', '[::1]:3000', 'http://[::1]:3000'],
  ])('accepts a POST from the page itself on %s', (_label, host, origin) => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(isSameOriginRequest(devRequest(host, origin))).toBe(true);
    expect(() => assertSameOrigin(devRequest(host, origin))).not.toThrow();
  });

  it('still refuses other origins, ports, and schemes', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(isSameOriginRequest(devRequest('app.localhost:3000', 'https://evil.example'))).toBe(false);
    expect(isSameOriginRequest(devRequest('app.localhost:3000', 'http://other.localhost:3000'))).toBe(false);
    expect(isSameOriginRequest(devRequest('app.localhost:3000', 'http://app.localhost:3001'))).toBe(false);
    expect(isSameOriginRequest(devRequest('app.localhost:3000', 'https://app.localhost:3000'))).toBe(false);
    expect(isSameOriginRequest(devRequest('app.localhost:3000', 'null'))).toBe(false);
    expect(isSameOriginRequest(devRequest('app.localhost:3000', null))).toBe(false);
  });

  it('refuses DNS rebinding: a non-loopback Host never counts, even when Origin matches it', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(isSameOriginRequest(devRequest('attacker.example:3000', 'http://attacker.example:3000'))).toBe(false);
    expect(isSameOriginRequest(devRequest('localhost.attacker.example:3000', 'http://localhost.attacker.example:3000'))).toBe(false);
    expect(isSameOriginRequest(devRequest('127.0.0.1.attacker.example:3000', 'http://127.0.0.1.attacker.example:3000'))).toBe(false);
  });

  it('refuses a Host that smuggles user info, a path, or a second host', () => {
    vi.stubEnv('NODE_ENV', 'development');
    for (const host of ['attacker.example@app.localhost:3000', 'app.localhost:3000/x', 'app.localhost:3000 evil', 'app.localhost:3000,evil.example']) {
      const origin = `http://${host}`;
      expect(isSameOriginRequest(devRequest(host, origin, 'http://localhost:3000/api/x')), host).toBe(false);
    }
  });

  it('applies only when request.url itself is loopback', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(isSameOriginRequest(devRequest('app.localhost:3000', 'http://app.localhost:3000', 'https://app.example.org/api/x'))).toBe(false);
  });

  it('never applies outside development: production and test builds keep the strict request.url fallback', () => {
    for (const env of ['production', 'test']) {
      vi.stubEnv('NODE_ENV', env);
      expect(isSameOriginRequest(devRequest('127.0.0.1:3210', 'http://127.0.0.1:3210')), env).toBe(false);
      expect(isSameOriginRequest(devRequest('localhost:3210', 'http://localhost:3210')), env).toBe(true); // request.url's own origin
    }
  });

  it('a configured expectedOrigin wins: only it (and allowedOrigins) count, in development too', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const request = devRequest('127.0.0.1:3210', 'http://127.0.0.1:3210');
    expect(isSameOriginRequest(request, { expectedOrigin: 'http://app.localhost:3000' })).toBe(false);
    expect(isSameOriginRequest(request, { expectedOrigin: 'http://127.0.0.1:3210' })).toBe(true);
    expect(isSameOriginRequest(devRequest('app.localhost:3000', 'http://app.localhost:3000'), { expectedOrigin: 'http://app.localhost:3000' })).toBe(true);
  });
});

describe('error responses (401 / 403 / 404 / 503 conventions)', () => {
  it.each([
    [new UnauthenticatedError(), 401, 'unauthenticated', 'Bearer'],
    [new UnauthenticatedError('invalid_token'), 401, 'invalid_token', 'Bearer error="invalid_token"'],
    [new UnauthenticatedError('token_expired'), 401, 'token_expired', 'Bearer error="invalid_token", error_description="The access token expired"'],
    [new ForbiddenError(), 403, 'forbidden', null],
    [new MfaEnrollmentRequiredError(), 403, 'mfa_enrollment_required', null],
    [new FirstCredentialRequiredError(), 403, 'first_credential_required', null],
    [new NotFoundError(), 404, 'not_found', null],
    [new AuthUnavailableError(), 503, 'auth_unavailable', null],
  ])('%s', async (error, status, code, wwwAuthenticate) => {
    const res = authErrorResponse(error);
    expect(res.status).toBe(status);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('www-authenticate')).toBe(wwwAuthenticate);
    expect(await res.json()).toMatchObject({ error: code });
  });

  it('answers step-up with RFC 9470 insufficient_user_authentication and max_age', async () => {
    const res = authErrorResponse(new StepUpRequiredError(300));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('insufficient_user_authentication');
    expect(res.headers.get('www-authenticate')).toContain('max_age=300');
    expect(await res.json()).toMatchObject({ error: 'step_up_required', maxAgeSeconds: 300 });
  });

  it('withAuthErrors converts auth errors and rethrows anything else', async () => {
    const forbidden = withAuthErrors(() => Promise.reject(new ForbiddenError()));
    expect((await forbidden()).status).toBe(403);
    const ok = withAuthErrors(() => new Response('ok'));
    expect(await (await ok()).text()).toBe('ok');
    const boom = withAuthErrors(() => Promise.reject(new Error('boom')));
    await expect(boom()).rejects.toThrow('boom');
  });

  it('builds sign-in URLs with a safe return path', () => {
    expect(signInUrl('/reports/1?x=2')).toBe('/sign-in?next=%2Freports%2F1%3Fx%3D2');
    expect(signInUrl('//evil.example')).toBe('/sign-in?next=%2F');
    expect(signInUrl('/a', { reauth: true, signInPath: '/login' })).toBe('/login?next=%2Fa&reauth=1');
    expect(signInUrl('/a', { signInPath: 'https://evil.example' })).toBe('/sign-in?next=%2Fa');
  });
});

describe('token sources', () => {
  it("encodes cookie names the way js-cookie (and Amplify's adapter) do", () => {
    expect(encodeCookieName('CognitoIdentityServiceProvider.abc.user@example.org.accessToken')).toBe(
      'CognitoIdentityServiceProvider.abc.user%40example.org.accessToken',
    );
    expect(encodeCookieName('a+b#c$d&e^f`g|h')).toBe('a+b#c$d&e^f`g|h');
    expect(amplifyCookieNames('client1', 'u-1')).toEqual({
      lastAuthUser: 'CognitoIdentityServiceProvider.client1.LastAuthUser',
      accessToken: 'CognitoIdentityServiceProvider.client1.u-1.accessToken',
      idToken: 'CognitoIdentityServiceProvider.client1.u-1.idToken',
      refreshToken: 'CognitoIdentityServiceProvider.client1.u-1.refreshToken',
    });
  });

  it("reads Amplify's cookies for the right client only", async () => {
    const ctx = toRequestContext(
      new Request('https://x.example', {
        headers: {
          cookie:
            'CognitoIdentityServiceProvider.mine.LastAuthUser=u1; CognitoIdentityServiceProvider.mine.u1.accessToken=AT; CognitoIdentityServiceProvider.mine.u1.idToken=IT; CognitoIdentityServiceProvider.other.LastAuthUser=u2; CognitoIdentityServiceProvider.other.u2.accessToken=OTHER',
        },
      }),
    );
    expect(await amplifyCookieTokens('mine')(ctx)).toEqual({ accessToken: 'AT', idToken: 'IT', source: 'amplify-cookies' });
    expect(await amplifyCookieTokens('nobody')(ctx)).toEqual({});
  });

  it('reports the refresh-token cookie so the proxy can tell whether a refresh is possible', async () => {
    const ctx = toRequestContext(
      new Request('https://x.example', {
        headers: { cookie: 'CognitoIdentityServiceProvider.c.LastAuthUser=u; CognitoIdentityServiceProvider.c.u.accessToken=AT; CognitoIdentityServiceProvider.c.u.refreshToken=RT' },
      }),
    );
    expect(await amplifyCookieTokens('c')(ctx)).toEqual({ accessToken: 'AT', refreshToken: 'RT', source: 'amplify-cookies' });
  });

  it('reads a well-formed bearer header only', async () => {
    const read = (value: string) => bearerToken()(toRequestContext(new Request('https://x.example', { headers: { authorization: value } })));
    expect(await read('Bearer abc.def.ghi')).toEqual({ accessToken: 'abc.def.ghi', source: 'bearer' });
    expect(await read('bearer abc.def.ghi')).toEqual({ accessToken: 'abc.def.ghi', source: 'bearer' });
    expect(await read('Basic dXNlcjpwYXNz')).toEqual({});
    expect(await read('Bearer two tokens')).toEqual({});
  });

  it('takes the first source that finds a token', async () => {
    const source = firstTokenSource(() => ({}), () => ({ accessToken: 'second' }), () => ({ accessToken: 'third' }));
    expect(await source(toRequestContext(new Request('https://x.example')))).toEqual({ accessToken: 'second' });
  });

  it('reads the pool config from amplify_outputs.json and fails closed without it', () => {
    expect(poolConfigFromAmplifyOutputs({ auth: { user_pool_id: 'us-east-1_TestPool1', user_pool_client_id: 'c' } })).toEqual({
      userPoolId: 'us-east-1_TestPool1',
      clientId: 'c',
    });
    expect(() => poolConfigFromAmplifyOutputs({})).toThrow(/no auth/);
  });
});

describe("cookie parsing matches Next's RequestCookies (L2)", () => {
  const C = String.fromCharCode;
  it.each([
    ['last duplicate wins', 'a=1; a=2'],
    ['duplicates with other cookies between', 'LastAuthUser=victim; x=1; LastAuthUser=attacker'],
    ['no space after the semicolon', 'a=1;b=2;a=3'],
    ['several spaces', 'a=1;   b=2'],
    ['a pair without =', 'flag; a=1'],
    ['percent-encoded values', 'u=user%40example.org; v=%7Bx%7D'],
    ['an undecodable value keeps the earlier one', 'a=1; a=%E0%A4%A'],
    ['empty pairs', ';; a=1 ;'],
    ['= inside the value', 'a=b=c'],
    ['a tab before the name', `a=1;${C(9)}b=2`],
  ])('%s', (_label, header) => {
    const ours = toRequestContext(new Request('https://x.example', { headers: { cookie: header } })).cookies;
    const next = new RequestCookies(new Headers({ cookie: header }));
    const names = new Set([...header.split(/; */).map((p) => p.split('=')[0] ?? ''), ...next.getAll().map((c) => c.name)]);
    for (const name of names) expect(ours.get(name)?.value, name).toBe(next.get(name)?.value);
  });

  it('so the proxy and a handler given a plain Request read the same session', async () => {
    const cookie = 'CognitoIdentityServiceProvider.c.LastAuthUser=victim; CognitoIdentityServiceProvider.c.LastAuthUser=attacker; CognitoIdentityServiceProvider.c.victim.accessToken=V; CognitoIdentityServiceProvider.c.attacker.accessToken=A';
    const plain = await amplifyCookieTokens('c')(toRequestContext(new Request('https://x.example', { headers: { cookie } })));
    const viaNext = await amplifyCookieTokens('c')({ cookies: new RequestCookies(new Headers({ cookie })), headers: new Headers() });
    expect(plain).toEqual(viaNext);
    expect(plain.accessToken).toBe('A');
  });

  it('parseCookieHeader handles a missing header', () => {
    expect(parseCookieHeader(null).get('a')).toBeUndefined();
  });
});
