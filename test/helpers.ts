import { NextRequest, type NextResponse } from 'next/server';
import {
  type CapabilityOf,
  type GroupOf,
  type ServerAuth,
  type ServerAuthOptions,
  authErrorResponse,
  createServerAuth,
  defineCapabilities,
  isAuthError,
  STANDARD_CAPABILITIES,
} from '../src/server/index.js';
import { createFakeCognito, createTestIssuer, type FakeCognito, type TestIssuer } from '../src/testing/index.js';

/** Placeholders only: this repo is public and holds no real pool or client IDs. */
export const POOL_ID = 'us-east-1_TestPool1';
export const CLIENT_ID = 'testclient0000000000000000';
export const OTHER_POOL_ID = 'us-east-1_OtherPool2';
export const OTHER_CLIENT_ID = 'otherclient000000000000000';

export const capabilities = defineCapabilities({
  ...STANDARD_CAPABILITIES,
  reviewer: ['reviews.read', 'reviews.comment'],
});

export type AppGroup = GroupOf<typeof capabilities>;
export type AppCapability = CapabilityOf<typeof capabilities>;

export interface Harness {
  issuer: TestIssuer;
  cognito: FakeCognito;
  clock: { now: number };
  jwksFetches: string[];
  auth: ServerAuth<AppGroup, AppCapability>;
}

/**
 * A server auth bound to a local test issuer. The JWKS fetcher serves the issuer's keys (as Cognito's
 * endpoint would) and records each fetch, so no test ever reaches the network.
 */
export function harness(overrides: Partial<ServerAuthOptions<AppGroup, AppCapability>> = {}): Harness {
  // aws-jwt-verify checks expiry against the real clock, so tokens are minted in real time. The
  // injected clock drives auth-kit's own logic (step-up age, cache lifetimes) and can move freely.
  const clock = { now: Date.now() };
  const issuer = createTestIssuer({ userPoolId: POOL_ID, clientId: CLIENT_ID });
  const cognito = createFakeCognito();
  const jwksFetches: string[] = [];
  const auth = createServerAuth({
    userPoolId: POOL_ID,
    clientId: CLIENT_ID,
    capabilities,
    jwks: issuer.jwks,
    jwksFetcher: (uri) => {
      jwksFetches.push(uri);
      return Promise.resolve(issuer.jwks);
    },
    cognito,
    now: () => clock.now,
    context: () => Promise.reject(new Error('tests must pass { request }')),
    ...overrides,
  });
  return { issuer, cognito, clock, jwksFetches, auth };
}

/** A Request carrying a bearer token. */
export function bearer(token: string, url = 'https://app.example.org/api/x'): Request {
  return new Request(url, { headers: { authorization: `Bearer ${token}` } });
}

export type RouteHandler = (req: Request, params: Record<string, string>) => Promise<Response>;

/**
 * A tiny in-process stand-in for Next's request pipeline: the proxy runs first; when it passes the
 * request on, its rewritten request headers reach the route (as Next applies
 * `x-middleware-override-headers`), and its own response headers are copied onto the route's response
 * (as Next does). `handlers` dispatches straight to the routes with no proxy at all.
 */
export function miniNext(input: {
  proxy: (request: NextRequest) => Promise<NextResponse>;
  routes: Record<string, RouteHandler>;
}): { request: (req: Request) => Promise<Response>; handlers: (req: Request) => Promise<Response> } {
  async function dispatch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    for (const [key, handler] of Object.entries(input.routes)) {
      const [method, pattern] = key.split(' ') as [string, string];
      if (method !== req.method) continue;
      const names: string[] = [];
      const re = new RegExp(`^${pattern.replace(/:([a-z]+)/g, (_, n: string) => (names.push(n), '([^/]+)'))}$`);
      const m = re.exec(url.pathname);
      if (!m) continue;
      try {
        return await handler(req, Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1] ?? '')])));
      } catch (error) {
        if (isAuthError(error)) return authErrorResponse(error);
        throw error;
      }
    }
    return new Response('not found', { status: 404 });
  }

  async function request(req: Request): Promise<Response> {
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer();
    const build = (headers: Headers) => ({ method: req.method, headers, ...(body !== undefined && { body }) });
    const passed = await input.proxy(new NextRequest(req.url, build(new Headers(req.headers))));
    if (passed.headers.get('x-middleware-next') !== '1') return passed;
    let headers = new Headers(req.headers);
    const override = passed.headers.get('x-middleware-override-headers');
    if (override !== null) {
      headers = new Headers();
      for (const name of override.split(',').filter(Boolean)) {
        const value = passed.headers.get(`x-middleware-request-${name}`);
        if (value !== null) headers.set(name, value);
      }
    }
    const response = await dispatch(new Request(req.url, build(headers)));
    const out = new Response(response.body, { status: response.status, headers: response.headers });
    passed.headers.forEach((value, name) => {
      if (!name.startsWith('x-middleware-') && name !== 'set-cookie') out.headers.set(name, value);
    });
    for (const cookie of passed.headers.getSetCookie()) out.headers.append('set-cookie', cookie);
    return out;
  }

  return { request, handlers: dispatch };
}
