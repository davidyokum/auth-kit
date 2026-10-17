import { describe, expect, it } from 'vitest';
import {
  AuthUnavailableError,
  ForbiddenError,
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
} from '../../src/server/index.js';

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

  it('keeps Amplify cookies SameSite=Lax and no longer-lived than the refresh token', () => {
    expect(amplifyCookieRuntimeOptions({ refreshTokenMinutes: 1440 })).toEqual({ cookies: { sameSite: 'lax', maxAge: 86400 } });
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

  it('accepts explicitly allowed origins and throws 403 otherwise', () => {
    const request = req('POST', { origin: 'https://admin.example.org' });
    expect(isSameOriginRequest(request, { allowedOrigins: ['https://admin.example.org'] })).toBe(true);
    expect(() => assertSameOrigin(request)).toThrow(ForbiddenError);
  });
});

describe('error responses (401 / 403 / 404 / 503 conventions)', () => {
  it.each([
    [new UnauthenticatedError(), 401, 'unauthenticated', 'Bearer'],
    [new UnauthenticatedError('invalid_token'), 401, 'invalid_token', 'Bearer error="invalid_token"'],
    [new ForbiddenError(), 403, 'forbidden', null],
    [new MfaEnrollmentRequiredError(), 403, 'mfa_enrollment_required', null],
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
