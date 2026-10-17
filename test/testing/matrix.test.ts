import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { withAuthProxy } from '../../src/proxy/index.js';
import { assertSameOrigin, isAuthError, authErrorResponse, withAuthErrors } from '../../src/server/index.js';
import {
  amplifyCookiePersona,
  assertAuthMatrix,
  authMatrixCases,
  bearerPersona,
  runAuthMatrix,
  type MatrixRoute,
} from '../../src/testing/index.js';
import { CLIENT_ID, harness } from '../helpers.js';

/**
 * A tiny app built the way the standard says: a default-deny proxy in front, and every route
 * checking for itself (requireCan, requireRecordAccess, origin check).
 */
function buildApp() {
  const h = harness();
  const { auth, issuer, cognito } = h;
  const reports = new Map([
    ['r-member', { id: 'r-member', ownerSub: 'member-1' }],
    ['r-other', { id: 'r-other', ownerSub: 'member-2' }],
  ]);
  const routes: Record<string, (req: Request, params: Record<string, string>) => Promise<Response>> = {
    'GET /api/reports': withAuthErrors(async (req) => {
      const user = await auth.requireUser({ request: req });
      // Lists are filtered on the server, in the query.
      return Response.json([...reports.values()].filter((r) => r.ownerSub === user.sub || auth.can(user, 'audit.read')));
    }),
    'GET /api/reports/:id': withAuthErrors(async (req, params) => {
      const user = await auth.requireUser({ request: req });
      const report = auth.requireRecordAccess(user, reports.get(params.id ?? ''), {
        owner: (r) => r.ownerSub,
        coveredBy: 'audit.read',
      });
      return Response.json(report);
    }),
    'POST /api/admin/invite': withAuthErrors(async (req) => {
      assertSameOrigin({ method: req.method, url: req.url, headers: req.headers });
      await auth.requireCan('people.manage', { request: req, live: true });
      return Response.json({ ok: true });
    }),
    'GET /api/public/status': () => Promise.resolve(Response.json({ ok: true })),
  };
  const proxy = withAuthProxy({ auth, publicRoutes: ['/api/public/*'] });

  async function request(req: Request): Promise<Response> {
    const passed = await proxy(new NextRequest(req));
    if (passed.headers.get('x-middleware-next') !== '1') return passed;
    const url = new URL(req.url);
    for (const [key, handler] of Object.entries(routes)) {
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

  const member = issuer.mintAccessToken({ sub: 'member-1', groups: [] });
  const otherMember = issuer.mintAccessToken({ sub: 'member-2', groups: [] });
  const admin = issuer.mintAccessToken({ sub: 'admin-1', groups: ['admin'] });
  cognito.setLiveState('admin-1', { enabled: true, groups: ['admin'] });
  return { request, member, otherMember, admin, issuer };
}

const ROUTES: MatrixRoute[] = [
  { method: 'GET', path: '/api/reports', expect: { anonymous: 401, member: 200, otherMember: 200, admin: 200 } },
  { method: 'GET', path: '/api/reports/:id', expect: { anonymous: 401, member: 200, otherMember: 404, admin: 200 } },
  {
    method: 'POST',
    path: '/api/admin/invite',
    headers: { origin: 'https://app.example.org' },
    body: { email: 'new@example.org' },
    expect: { anonymous: 401, member: 403, otherMember: 403, admin: 200 },
  },
  { method: 'GET', path: '/api/public/status', expect: { anonymous: 200, member: 200, admin: 200 } },
];

describe('assertAuthMatrix against an app built to the standard', () => {
  it('passes with bearer personas', async () => {
    const app = buildApp();
    const results = await assertAuthMatrix({
      request: app.request,
      baseUrl: 'https://app.example.org',
      params: { id: 'r-member' },
      personas: {
        anonymous: {},
        member: bearerPersona(app.member),
        otherMember: bearerPersona(app.otherMember),
        admin: bearerPersona(app.admin),
      },
      routes: ROUTES,
    });
    expect(results).toHaveLength(15);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("passes with Amplify cookie personas (the browser's view)", async () => {
    const app = buildApp();
    const cookie = (sub: string, token: string) => amplifyCookiePersona({ clientId: CLIENT_ID, username: sub, accessToken: token });
    await expect(
      assertAuthMatrix({
        request: app.request,
        baseUrl: 'https://app.example.org',
        params: { id: 'r-member' },
        personas: {
          anonymous: {},
          member: cookie('member-1', app.member),
          otherMember: cookie('member-2', app.otherMember),
          admin: cookie('admin-1', app.admin),
        },
        routes: ROUTES,
      }),
    ).resolves.toBeTruthy();
  });

  it('reports every mismatch in one error (an IDOR bug is caught)', async () => {
    const app = buildApp();
    const leaky = async (req: Request) => {
      // Simulate a route that forgot the record check: every signed-in person gets every report.
      if (new URL(req.url).pathname.startsWith('/api/reports/') && req.headers.get('authorization')) return new Response('{}', { status: 200 });
      return app.request(req);
    };
    const error = await assertAuthMatrix({
      request: leaky,
      baseUrl: 'https://app.example.org',
      params: { id: 'r-member' },
      personas: {
        anonymous: {},
        member: bearerPersona(app.member),
        otherMember: bearerPersona(app.otherMember),
        admin: bearerPersona(app.admin),
      },
      routes: ROUTES,
    }).catch((e: unknown) => e as Error);
    expect((error as Error).message).toContain('1 of 15 checks failed');
    expect((error as Error).message).toContain('x GET /api/reports/:id as otherMember: expected 404, got 200');
  });

  it('records request errors instead of crashing', async () => {
    const results = await runAuthMatrix({
      request: () => Promise.reject(new Error('connection refused')),
      personas: { anonymous: {}, member: {}, admin: {} },
      routes: [{ path: '/x', expect: { anonymous: 401, member: 200, admin: 200 } }],
    });
    expect(results.every((r) => !r.ok && r.actual === null && r.error === 'connection refused')).toBe(true);
  });
});

describe('authMatrixCases: completeness rules', () => {
  const personas = { anonymous: {}, member: {}, admin: {}, otherMember: {} };

  it('requires anonymous, member, and admin on every route', () => {
    expect(() => authMatrixCases({ personas, routes: [{ path: '/api/x', expect: { anonymous: 401, member: 200 } }] })).toThrow(
      /no expectation for "admin"/,
    );
  });

  it('requires a second member on every route that takes a record ID', () => {
    expect(() =>
      authMatrixCases({ personas, params: { id: '1' }, routes: [{ path: '/api/x/:id', expect: { anonymous: 401, member: 200, admin: 200 } }] }),
    ).toThrow(/no expectation for "otherMember"/);
    expect(() =>
      authMatrixCases({
        personas,
        routes: [{ path: '/api/x', recordRoute: true, expect: { anonymous: 401, member: 200, admin: 200 } }],
      }),
    ).toThrow(/otherMember/);
  });

  it('requires the second-member persona to be defined when record routes exist', () => {
    expect(() =>
      authMatrixCases({
        personas: { anonymous: {}, member: {}, admin: {} },
        params: { id: '1' },
        routes: [{ path: '/api/x/:id', expect: { anonymous: 401, member: 200, admin: 200, otherMember: 404 } }],
      }),
    ).toThrow(/persona "otherMember" is required/);
  });

  it('insists on 404, not 403, for a second member unless the route opts out', () => {
    const route = { path: '/api/x/:id', expect: { anonymous: 401, member: 200, admin: 200, otherMember: 403 } };
    expect(() => authMatrixCases({ personas, params: { id: '1' }, routes: [route] })).toThrow(/404, not 403/);
    expect(authMatrixCases({ personas, params: { id: '1' }, routes: [{ ...route, allowForbiddenForSecondMember: true }] })).toHaveLength(4);
  });

  it('flags missing params and unknown personas', () => {
    expect(() =>
      authMatrixCases({ personas, routes: [{ path: '/api/x/:id', expect: { anonymous: 401, member: 200, admin: 200, otherMember: 404 } }] }),
    ).toThrow(/no value for ":id"/);
    expect(() =>
      authMatrixCases({ personas, routes: [{ path: '/api/x', expect: { anonymous: 401, member: 200, admin: 200, ghost: 200 } }] }),
    ).toThrow(/unknown persona "ghost"/);
  });

  it('expands cases with encoded params and multiple allowed statuses', () => {
    const cases = authMatrixCases({
      personas,
      baseUrl: 'https://app.example.org',
      params: { id: 'a b/c' },
      routes: [{ path: '/r/:id', expect: { anonymous: [302, 307], member: 200, admin: 200, otherMember: 404 } }],
    });
    expect(cases[0]).toMatchObject({ url: 'https://app.example.org/r/a%20b%2Fc', expected: [302, 307] });
  });
});
