/**
 * The proxy's refresh path through the real `@aws-amplify/adapter-nextjs` and `aws-amplify`, with the
 * network stubbed: the adapter's JWKS download (node `https`, from its own `aws-jwt-verify`) is served
 * from the test issuer, and Cognito's API (global `fetch`) answers from a script. Anything else
 * fails the test, so nothing leaves the machine.
 */
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import { createServerRunner } from '@aws-amplify/adapter-nextjs';
import { fetchAuthSession } from 'aws-amplify/auth/server';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { amplifyAdapterRefresh, withAuthProxy } from '../../src/proxy/index.js';
import { amplifyCookieRuntimeOptions } from '../../src/server/index.js';
import { tamperToken } from '../../src/testing/index.js';
import { CLIENT_ID, POOL_ID, harness } from '../helpers.js';

const JWKS_URL = `https://cognito-idp.us-east-1.amazonaws.com/${POOL_ID}/.well-known/jwks.json`;
const COGNITO_URL = 'https://cognito-idp.us-east-1.amazonaws.com/';
const BASE = `CognitoIdentityServiceProvider.${CLIENT_ID}`;

const originalRequest = https.request;
let h: ReturnType<typeof harness>;
let cognitoCalls: { target: string | null; body: unknown }[];

beforeEach(() => {
  h = harness();
  cognitoCalls = [];
  (https as { request: unknown }).request = (uri: unknown, _options: unknown, callback: (res: unknown) => void) => {
    if (String(uri) !== JWKS_URL) throw new Error(`test tried to reach ${String(uri)}`);
    const req = Object.assign(new EventEmitter(), {
      end() {
        const res = Object.assign(new PassThrough(), { statusCode: 200, headers: { 'content-type': 'application/json' } });
        callback(res);
        res.end(JSON.stringify(h.issuer.jwks));
      },
      destroy() {},
    });
    return req;
  };
  syncBuiltinESMExports();
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== COGNITO_URL) throw new Error(`test tried to reach ${url}`);
    const headers = new Headers(init?.headers);
    cognitoCalls.push({ target: headers.get('x-amz-target'), body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') });
    return Promise.resolve(new Response(
      JSON.stringify({
        AuthenticationResult: {
          AccessToken: h.issuer.mintAccessToken({ sub: 'u1' }),
          IdToken: h.issuer.mintIdToken({ sub: 'u1' }),
          ExpiresIn: 3600,
          TokenType: 'Bearer',
        },
      }),
      { headers: { 'content-type': 'application/x-amz-json-1.1' } },
    ));
  });
});

afterEach(() => {
  (https as { request: unknown }).request = originalRequest;
  syncBuiltinESMExports();
  vi.unstubAllGlobals();
});

function runner(runtimeOptions: ReturnType<typeof amplifyCookieRuntimeOptions>) {
  return createServerRunner({
    config: { version: '1.4', auth: { aws_region: 'us-east-1', user_pool_id: POOL_ID, user_pool_client_id: CLIENT_ID } },
    runtimeOptions,
  });
}

function sessionCookie(accessToken: string, refreshToken: string | null = 'rt-1'): string {
  return [`${BASE}.LastAuthUser=u1`, `${BASE}.u1.accessToken=${accessToken}`, ...(refreshToken ? [`${BASE}.u1.refreshToken=${refreshToken}`] : [])].join('; ');
}

function proxyWith(runtimeOptions: ReturnType<typeof amplifyCookieRuntimeOptions>) {
  const { runWithAmplifyServerContext } = runner(runtimeOptions);
  return withAuthProxy({ auth: h.auth, refresh: amplifyAdapterRefresh({ runWithAmplifyServerContext, fetchAuthSession }) });
}

const tokenCookies = (setCookies: string[]) => setCookies.filter((c) => /\.(accessToken|idToken|refreshToken|LastAuthUser)=/.test(c));

describe('cookies the server writes during a refresh (M2)', () => {
  it('are Secure, SameSite=Lax, and expire with the refresh token', async () => {
    const proxy = proxyWith(amplifyCookieRuntimeOptions({ refreshTokenMinutes: 1440 }));
    const expired = h.issuer.mintAccessToken({ sub: 'u1', expiresIn: -60 });
    const res = await proxy(new NextRequest('https://app.example.org/dashboard', { headers: { cookie: sessionCookie(expired) } }));
    expect(res.headers.get('x-middleware-next')).toBe('1');
    const cookies = tokenCookies(res.headers.getSetCookie());
    expect(cookies).toHaveLength(4);
    for (const cookie of cookies) {
      expect(cookie).toMatch(/; Secure(;|$)/);
      expect(cookie).toMatch(/; SameSite=lax/i);
      expect(cookie).toMatch(/; Max-Age=86400/);
    }
  });

  it('omit Secure only for a declared http://localhost development origin', async () => {
    const proxy = proxyWith(amplifyCookieRuntimeOptions({ refreshTokenMinutes: 60, localDevOrigin: 'http://app.localhost:3000' }));
    const expired = h.issuer.mintAccessToken({ sub: 'u1', expiresIn: -60 });
    const res = await proxy(new NextRequest('http://app.localhost:3000/dashboard', { headers: { cookie: sessionCookie(expired) } }));
    const cookies = tokenCookies(res.headers.getSetCookie());
    expect(cookies.length).toBeGreaterThan(0);
    for (const cookie of cookies) expect(cookie).not.toMatch(/Secure/);
  });
});

describe('Cognito calls from the proxy (M1)', () => {
  it('refreshes a genuine expired session with exactly one GetTokensFromRefreshToken call', async () => {
    const proxy = proxyWith(amplifyCookieRuntimeOptions({ refreshTokenMinutes: 1440 }));
    const expired = h.issuer.mintAccessToken({ sub: 'u1', expiresIn: -60 });
    await proxy(new NextRequest('https://app.example.org/dashboard', { headers: { cookie: sessionCookie(expired) } }));
    expect(cognitoCalls).toEqual([
      { target: 'AWSCognitoIdentityProviderService.GetTokensFromRefreshToken', body: { ClientId: CLIENT_ID, RefreshToken: 'rt-1' } },
    ]);
  });

  it('makes no Cognito call for anonymous, forged, valid, or refresh-cookie-less requests', async () => {
    const proxy = proxyWith(amplifyCookieRuntimeOptions({ refreshTokenMinutes: 1440 }));
    const forged = tamperToken(h.issuer.mintAccessToken({ sub: 'u1', expiresIn: -60 }), { 'cognito:groups': ['owner'] });
    const valid = h.issuer.mintAccessToken({ sub: 'u1' });
    const expired = h.issuer.mintAccessToken({ sub: 'u1', expiresIn: -60 });
    const send = (cookie?: string) =>
      proxy(new NextRequest('https://app.example.org/api/x', { headers: cookie ? { cookie } : {} }));
    expect((await send()).status).toBe(401);
    expect((await send(`${BASE}.LastAuthUser=u1; ${BASE}.u1.refreshToken=rt-1`)).status).toBe(401);
    expect((await send(sessionCookie(forged))).status).toBe(401);
    expect((await send(sessionCookie(expired, null))).status).toBe(401);
    expect((await send(sessionCookie(valid))).headers.get('x-middleware-next')).toBe('1');
    expect(cognitoCalls).toEqual([]);
  });
});
