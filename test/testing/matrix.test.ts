import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withAuthProxy } from '../../src/proxy/index.js';
import { assertSameOrigin, withAuthErrors } from '../../src/server/index.js';
import {
  amplifyCookiePersona,
  assertAuthMatrix,
  authMatrixCases,
  bearerPersona,
  resolveAppRoute,
  compileAppRoute,
  routesFromNextBuild,
  runAuthMatrix,
  type AuthMatrixOptions,
  type MatrixRoute,
  NEW_MEMBER,
  CODE_ONLY_MEMBER,
  EMAILED_CODE_ONLY_MEMBER,
  FRESH_SIGN_UP_MEMBER,
} from '../../src/testing/index.js';
import { CLIENT_ID, harness, miniNext, type RouteHandler } from '../helpers.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * A tiny app built the way the standard says: a default-deny proxy in front, and every route
 * checking for itself (requireCan, requireRecordAccess, origin check). `extraRoutes` adds the broken
 * routes the review's probes describe.
 */
function buildApp(extraRoutes: Record<string, RouteHandler> = {}) {
  const h = harness();
  const { auth, issuer, cognito } = h;
  const reports = new Map([
    ['r-member', { id: 'r-member', ownerSub: 'member-1' }],
    ['r-other', { id: 'r-other', ownerSub: 'member-2' }],
  ]);
  const routes: Record<string, RouteHandler> = {
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
    ...extraRoutes,
  };
  const proxy = withAuthProxy({ auth, publicRoutes: ['/api/public/*'] });
  const next = miniNext({ proxy, routes });

  const member = issuer.mintAccessToken({ sub: 'member-1', groups: [] });
  const otherMember = issuer.mintAccessToken({ sub: 'member-2', groups: [] });
  const admin = issuer.mintAccessToken({ sub: 'admin-1', groups: ['admin-content-people'] });
  cognito.setLiveState('admin-1', { enabled: true, groups: ['admin-content-people'] });
  // An invitee who closed the tab before choosing a passkey or a password (required by default, N3).
  cognito.setFactors('code-only-1', { configured: ['EMAIL_OTP'], mfa: [] });
  const codeOnly = issuer.mintAccessToken({ sub: 'code-only-1', groups: [] });
  return { ...next, member, otherMember, admin, codeOnly, issuer, cognito, auth };
}

const APP_ROUTES = ['/api/reports', '/api/reports/[id]', 'POST /api/admin/invite', '/api/public/status'];

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

function options(app: ReturnType<typeof buildApp>, overrides: Partial<AuthMatrixOptions> = {}): AuthMatrixOptions {
  return {
    request: app.request,
    handlerRequest: app.handlers,
    baseUrl: 'https://app.example.org',
    appRoutes: APP_ROUTES,
    params: { id: 'r-member' },
    personas: {
      anonymous: {},
      member: bearerPersona(app.member),
      otherMember: bearerPersona(app.otherMember),
      admin: bearerPersona(app.admin),
      [CODE_ONLY_MEMBER]: bearerPersona(app.codeOnly),
    },
    routes: ROUTES,
    ...overrides,
  };
}

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected the matrix to fail');
}

describe('assertAuthMatrix against an app built to the standard', () => {
  it('passes with bearer personas, with and without the proxy', async () => {
    const app = buildApp();
    const results = await assertAuthMatrix(options(app));
    // Five personas (the emailed-code-only account included) on four routes, twice, less otherMember on the two that don't take an ID.
    expect(results).toHaveLength(38);
    expect(results.filter((r) => r.pass === 'without-proxy')).toHaveLength(19);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("passes with Amplify cookie personas (the browser's view)", async () => {
    const app = buildApp();
    const cookie = (sub: string, token: string) => amplifyCookiePersona({ clientId: CLIENT_ID, username: sub, accessToken: token });
    await expect(
      assertAuthMatrix(
        options(app, {
          personas: {
            anonymous: {},
            member: cookie('member-1', app.member),
            otherMember: cookie('member-2', app.otherMember),
            admin: cookie('admin-1', app.admin),
            codeOnlyMember: cookie('code-only-1', app.codeOnly),
          },
        }),
      ),
    ).resolves.toBeTruthy();
  });

  it('reports every mismatch in one error (an IDOR bug is caught in both passes)', async () => {
    const app = buildApp();
    const leaky = (inner: (req: Request) => Promise<Response>) => async (req: Request) => {
      // Simulate a route that forgot the record check: every signed-in person gets every report.
      if (new URL(req.url).pathname.startsWith('/api/reports/') && req.headers.get('authorization')) return new Response('{}', { status: 200 });
      return inner(req);
    };
    const message = await failure(assertAuthMatrix(options(app, { request: leaky(app.request), handlerRequest: leaky(app.handlers) })));
    expect(message).toContain('4 of 38 checks failed');
    expect(message).toContain('x GET /api/reports/:id as otherMember (with-proxy): expected 404, got 200');
    expect(message).toContain('x GET /api/reports/:id as otherMember (without-proxy): expected 404, got 200');
    // The emailed-code-only account is let in by the same bug.
    expect(message).toContain('x GET /api/reports/:id as codeOnlyMember (with-proxy): expected 403, got 200');
  });

  it('records request errors instead of crashing', async () => {
    const results = await runAuthMatrix({
      request: () => Promise.reject(new Error('connection refused')),
      appRoutes: ['/x'],
      personas: { anonymous: {}, member: {}, admin: {} },
      routes: [{ path: '/x', expect: { anonymous: 401, member: 200, admin: 200 } }],
      requireFirstCredential: false,
    });
    expect(results).toHaveLength(6);
    expect(results.every((r) => !r.ok && r.actual === null && r.error === 'connection refused')).toBe(true);
  });
});

describe('the review probes (H1): routes that pass only because of the proxy', () => {
  it('fails a route with no server check of its own, even though the proxy answers 401', async () => {
    // The handler forgot requireUser(): the proxy supplies the 401, the handler the 200s.
    const app = buildApp({ 'GET /api/secret': () => Promise.resolve(Response.json({ secret: true })) });
    const message = await failure(
      assertAuthMatrix(
        options(app, {
          appRoutes: [...APP_ROUTES, '/api/secret'],
          routes: [...ROUTES, { path: '/api/secret', expect: { anonymous: 401, member: 200, admin: 200 } }],
        }),
      ),
    );
    expect(message).toContain('3 of 46 checks failed');
    expect(message).toContain('x GET /api/secret as anonymous (without-proxy): expected 401, got 200');
    // No requireUser, so no first-credential check either: the emailed-code-only account gets in.
    expect(message).toContain('x GET /api/secret as codeOnlyMember (with-proxy): expected 403, got 200');
  });

  it('refuses a mistyped record route that 404s for everyone', () => {
    const app = buildApp();
    const typo: MatrixRoute = { path: '/api/reprots/:id', expect: { anonymous: 401, member: 404, otherMember: 404, admin: 404 } };
    expect(() => authMatrixCases(options(app, { routes: [...ROUTES, typo] }))).toThrow(/no persona is expected to succeed/);
    expect(() => authMatrixCases(options(app, { routes: [...ROUTES, typo] }))).toThrow(/is not one of the app's routes/);
  });

  it('refuses a mistyped route even when it expects someone to succeed', () => {
    const app = buildApp();
    const typo: MatrixRoute = { path: '/api/reprots', expect: { anonymous: 401, member: 200, admin: 200 } };
    expect(() => authMatrixCases(options(app, { routes: [...ROUTES, typo] }))).toThrow(
      "GET /api/reprots: /api/reprots is not one of the app's routes",
    );
  });

  it('fails when an app route has no row (coverage against the route manifest)', () => {
    const app = buildApp();
    expect(() => authMatrixCases(options(app, { appRoutes: [...APP_ROUTES, '/api/admin/people'] }))).toThrow(
      '/api/admin/people: the app serves this route but the matrix has no row for it.',
    );
  });

  it('requires a row per method when the app route names one', () => {
    const app = buildApp();
    expect(() => authMatrixCases(options(app, { appRoutes: [...APP_ROUTES, 'DELETE /api/reports/[id]'] }))).toThrow(
      'DELETE /api/reports/[id]: the app serves this route but the matrix has no row',
    );
  });

  it('refuses an empty route list', () => {
    const app = buildApp();
    expect(() => authMatrixCases(options(app, { appRoutes: [] }))).toThrow(/appRoutes is empty/);
  });

  it('allows a row asserting a path does not exist, and only that', () => {
    const app = buildApp();
    const gone: MatrixRoute = { path: '/api/debug', exists: false, expect: { anonymous: 404, member: 404, admin: 404 } };
    expect(authMatrixCases(options(app, { routes: [...ROUTES, gone] })).filter((c) => c.path === '/api/debug')).toHaveLength(8);
    expect(() => authMatrixCases(options(app, { routes: [...ROUTES, { ...gone, path: '/api/reports' }] }))).toThrow(
      /exists: false, but the app serves \/api\/reports/,
    );
    expect(() =>
      authMatrixCases(options(app, { routes: [...ROUTES, { ...gone, expect: { anonymous: 401, member: 404, admin: 404 } }] })),
    ).toThrow(/must expect 404 for every persona/);
  });
});

describe('the without-proxy pass against a running server (handler-pass header)', () => {
  const localOptions = (app: ReturnType<typeof buildApp>): AuthMatrixOptions => {
    const { handlerRequest: _skip, ...rest } = options(app, {
      baseUrl: 'http://app.localhost:3000',
      routes: ROUTES.map((r) => (r.headers?.origin ? { ...r, headers: { origin: 'http://app.localhost:3000' } } : r)),
    });
    return rest;
  };

  it('passes when the proxy steps aside (development, AUTH_KIT_MATRIX=1, localhost)', async () => {
    vi.stubEnv('AUTH_KIT_MATRIX', '1');
    const app = buildApp();
    const results = await assertAuthMatrix(localOptions(app));
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('fails every without-proxy case, explaining why, when the flag is missing', async () => {
    const app = buildApp();
    const results = await runAuthMatrix(localOptions(app));
    const without = results.filter((r) => r.pass === 'without-proxy');
    expect(without.every((r) => !r.ok)).toBe(true);
    expect(without.find((r) => r.persona === 'anonymous' && r.path === '/api/reports')?.error).toMatch(/the proxy answered/);
    expect(without.find((r) => r.persona === 'member' && r.path === '/api/reports')?.error).toMatch(/didn't confirm it stepped aside/);
    expect(results.filter((r) => r.pass === 'with-proxy').every((r) => r.ok)).toBe(true);
  });

  it('is never honored in a production build, even with the flag', async () => {
    vi.stubEnv('AUTH_KIT_MATRIX', '1');
    vi.stubEnv('NODE_ENV', 'production');
    const app = buildApp();
    const results = await runAuthMatrix(localOptions(app));
    expect(results.filter((r) => r.pass === 'without-proxy').every((r) => !r.ok)).toBe(true);
  });

  it('is never honored for a non-localhost host, even with the flag', async () => {
    vi.stubEnv('AUTH_KIT_MATRIX', '1');
    const app = buildApp();
    const { handlerRequest: _skip, ...rest } = options(app);
    const results = await runAuthMatrix(rest);
    expect(results.filter((r) => r.pass === 'without-proxy').every((r) => !r.ok)).toBe(true);
  });

  it('fails when handlerRequest still goes through the proxy', async () => {
    const app = buildApp();
    const results = await runAuthMatrix(options(app, { handlerRequest: app.request }));
    const anonymous = results.find((r) => r.pass === 'without-proxy' && r.persona === 'anonymous' && r.path === '/api/reports');
    expect(anonymous?.ok).toBe(false);
    expect(anonymous?.error).toMatch(/the proxy answered/);
  });
});

describe('expectWithoutProxy', () => {
  it('overrides the expectation for the without-proxy pass only', () => {
    const app = buildApp();
    const cases = authMatrixCases(
      options(app, {
        routes: ROUTES.map((r, i) => (i === 0 ? { ...r, expectWithoutProxy: { anonymous: [401, 403] } } : r)),
      }),
    );
    const anonymous = cases.filter((c) => c.routeIndex === 0 && c.persona === 'anonymous');
    expect(anonymous.map((c) => [c.pass, c.expected])).toEqual([
      ['with-proxy', [401]],
      ['without-proxy', [401, 403]],
    ]);
  });

  it('is held to the same rules', () => {
    const app = buildApp();
    expect(() =>
      authMatrixCases(options(app, { routes: ROUTES.map((r, i) => (i === 1 ? { ...r, expectWithoutProxy: { otherMember: 403 } } : r)) })),
    ).toThrow(/expectWithoutProxy gives a second member 403/);
    expect(() =>
      authMatrixCases(options(app, { routes: ROUTES.map((r, i) => (i === 0 ? { ...r, expectWithoutProxy: { ghost: 200 } } : r)) })),
    ).toThrow(/expectWithoutProxy names "ghost"/);
  });
});

describe('authMatrixCases: completeness rules', () => {
  const personas = { anonymous: {}, member: {}, admin: {}, otherMember: {}, codeOnlyMember: {} };
  const appRoutes = ['/api/x', '/api/x/[id]', '/r/[id]'];

  it('requires anonymous, member, and admin on every route', () => {
    expect(() => authMatrixCases({ personas, appRoutes, routes: [{ path: '/api/x', expect: { anonymous: 401, member: 200 } }] })).toThrow(
      /no expectation for "admin"/,
    );
  });

  it('requires a second member on every route that takes a record ID', () => {
    expect(() =>
      authMatrixCases({ personas, appRoutes, params: { id: '1' }, routes: [{ path: '/api/x/:id', expect: { anonymous: 401, member: 200, admin: 200 } }] }),
    ).toThrow(/no expectation for "otherMember"/);
    expect(() =>
      authMatrixCases({
        personas,
        appRoutes,
        routes: [{ path: '/api/x', itemRoute: true, expect: { anonymous: 401, member: 200, admin: 200 } }],
      }),
    ).toThrow(/otherMember/);
  });

  it('requires the second-member persona to be defined when record routes exist', () => {
    expect(() =>
      authMatrixCases({
        personas: { anonymous: {}, member: {}, admin: {}, codeOnlyMember: {} },
        appRoutes,
        params: { id: '1' },
        routes: [{ path: '/api/x/:id', expect: { anonymous: 401, member: 200, admin: 200, otherMember: 404 } }],
      }),
    ).toThrow(/persona "otherMember" is required/);
  });

  it('insists on 404, not 403, for a second member unless the route opts out', () => {
    const route = { path: '/api/x/:id', expect: { anonymous: 401, member: 200, admin: 200, otherMember: 403 } };
    expect(() => authMatrixCases({ personas, appRoutes: ['/api/x/[id]'], params: { id: '1' }, routes: [route] })).toThrow(/404, not 403|says 404/);
    expect(
      authMatrixCases({ personas, appRoutes: ['/api/x/[id]'], params: { id: '1' }, routes: [{ ...route, allowForbiddenForSecondMember: true }] }),
    ).toHaveLength(10);
  });

  it('requires the emailed-code-only persona on every site whose server enforces the first credential (N3)', () => {
    const route = { path: '/api/x', expect: { anonymous: 401, member: 200, admin: 200 } };
    const without = { anonymous: {}, member: {}, admin: {} };
    expect(() => authMatrixCases({ personas: without, appRoutes: ['/api/x'], routes: [route] })).toThrow(/persona "codeOnlyMember" is required.*invitees start that way/s);
    // Only a server that turns the rule off may leave it out.
    expect(authMatrixCases({ personas: without, appRoutes: ['/api/x'], routes: [route], requireFirstCredential: false })).toHaveLength(6);
    // With it, every route runs as it too: 403 where a signed-in person is needed.
    const cases = authMatrixCases({ personas: { ...without, codeOnlyMember: {} }, appRoutes: ['/api/x'], routes: [route] });
    expect(cases.filter((c) => c.persona === 'codeOnlyMember').map((c) => c.expected)).toEqual([[403], [403]]);
  });

  it('flags missing params and unknown personas', () => {
    expect(() =>
      authMatrixCases({ personas, appRoutes, routes: [{ path: '/api/x/:id', expect: { anonymous: 401, member: 200, admin: 200, otherMember: 404 } }] }),
    ).toThrow(/no value for ":id"/);
    expect(() =>
      authMatrixCases({ personas, appRoutes: ['/api/x'], routes: [{ path: '/api/x', expect: { anonymous: 401, member: 200, admin: 200, ghost: 200 } }] }),
    ).toThrow(/unknown persona "ghost"/);
  });

  it('expands cases with encoded params and multiple allowed statuses', () => {
    const cases = authMatrixCases({
      personas,
      appRoutes: ['/r/[id]'],
      baseUrl: 'https://app.example.org',
      params: { id: 'a b/c' },
      routes: [{ path: '/r/:id', expect: { anonymous: [302, 307], member: 200, admin: 200, otherMember: 404 } }],
    });
    expect(cases[0]).toMatchObject({ url: 'https://app.example.org/r/a%20b%2Fc', expected: [302, 307], pass: 'with-proxy' });
  });
});

describe('app route matching', () => {
  const routes = ['/', '/api/reports', '/api/reports/new', '/api/reports/[id]', '/docs/[...slug]', '/opt/[[...rest]]', '/api/x/:id'].map(
    compileAppRoute,
  );
  it.each([
    ['/', '/'],
    ['/api/reports/', '/api/reports'],
    ['/api/reports?x=1', '/api/reports'],
    ['/api/reports/new', '/api/reports/new'],
    ['/api/reports/r-1', '/api/reports/[id]'],
    ['/api/reports/a%2Fb', '/api/reports/[id]'],
    ['/docs/a/b/c', '/docs/[...slug]'],
    ['/opt', '/opt/[[...rest]]'],
    ['/opt/a/b', '/opt/[[...rest]]'],
    ['/api/x/7', '/api/x/:id'],
  ])('%s resolves to %s', (path, label) => {
    expect(resolveAppRoute(routes, path)?.label).toBe(label);
  });

  it.each(['/docs', '/api/reports/1/2', '/nope', '/api'])('%s resolves to nothing', (path) => {
    expect(resolveAppRoute(routes, path)).toBeUndefined();
  });

  it('refuses a route that is not a path', () => {
    expect(() => compileAppRoute('api/x')).toThrow(/must be a path/);
  });
});

describe('routesFromNextBuild', () => {
  function fakeBuild(app: Record<string, string> | null, pages: Record<string, string> | null): string {
    const dir = mkdtempSync(join(tmpdir(), 'auth-kit-next-'));
    mkdirSync(join(dir, 'server'), { recursive: true });
    if (app) writeFileSync(join(dir, 'app-path-routes-manifest.json'), JSON.stringify(app));
    if (pages) writeFileSync(join(dir, 'server', 'pages-manifest.json'), JSON.stringify(pages));
    return dir;
  }

  it("reads Next's manifests (format checked against a real next build) and drops internal routes", () => {
    const dir = fakeBuild(
      {
        '/_not-found/page': '/_not-found',
        '/_global-error/page': '/_global-error',
        '/api/reports/[id]/route': '/api/reports/[id]',
        '/api/reports/route': '/api/reports',
        '/(marketing)/about/page': '/about',
        '/docs/[...slug]/page': '/docs/[...slug]',
        '/page': '/',
        '/favicon.ico/route': '/favicon.ico',
      },
      { '/404': 'pages/404.html', '/500': 'pages/500.html', '/legacy': 'pages/legacy.js' },
    );
    expect(routesFromNextBuild(dir, { exclude: ['/favicon.ico'], firstCredentialPath: false })).toEqual([
      { path: '/', kind: 'page' },
      { path: '/about', kind: 'page' },
      { path: '/api/reports', kind: 'route' },
      { path: '/api/reports/[id]', kind: 'route' },
      { path: '/docs/[...slug]', kind: 'page' },
      { path: '/legacy', kind: 'page' },
    ]);
  });

  it('fails loudly when there is no build', () => {
    expect(() => routesFromNextBuild(fakeBuild(null, null))).toThrow(/Run `next build`/);
  });

  it('fails when the first-credential chooser page is missing, so new invitees can’t land on a 404 (N3)', () => {
    const without = fakeBuild({ '/page': '/', '/records/page': '/records' }, null);
    expect(() => routesFromNextBuild(without)).toThrow(/no page at \/account\/sign-in-method.*allowFirstCredentialEnrollment/s);
    const withPage = fakeBuild({ '/page': '/', '/account/sign-in-method/page': '/account/sign-in-method' }, null);
    expect(routesFromNextBuild(withPage).map((r) => r.path)).toContain('/account/sign-in-method');
    // A chooser elsewhere, and only a route handler (not a page) at the path, which doesn't count.
    const elsewhere = fakeBuild({ '/welcome/choose/page': '/welcome/choose', '/account/sign-in-method/route': '/account/sign-in-method' }, null);
    expect(() => routesFromNextBuild(elsewhere)).toThrow(/no page at \/account\/sign-in-method/);
    expect(routesFromNextBuild(elsewhere, { firstCredentialPath: '/welcome/choose' }).map((r) => r.path)).toContain('/welcome/choose');
    expect(routesFromNextBuild(without, { firstCredentialPath: false })).toHaveLength(2);
  });
});

describe('a freshly signed-up Member (sign-up sites, ADR 0023)', () => {
  /**
   * A member whose account the sign-up route made a moment ago and who chose a passkey (no role), and
   * an account with only emailed codes (closed before choosing).
   */
  function withFreshMember(extraRoutes: Record<string, RouteHandler> = {}) {
    const app = buildApp(extraRoutes);
    app.cognito.setFactors('fresh-1', { configured: [...FRESH_SIGN_UP_MEMBER.factors!.configured], mfa: [] });
    app.cognito.setFactors('code-only-1', { configured: [...EMAILED_CODE_ONLY_MEMBER.factors!.configured], mfa: [] });
    const codeOnly = app.issuer.mintAccessToken({ sub: 'code-only-1', groups: [] });
    return { app, fresh: app.issuer.mintAccessToken({ sub: 'fresh-1', groups: [...FRESH_SIGN_UP_MEMBER.groups!] }), codeOnly };
  }
  const signUpPersonas = (app: ReturnType<typeof buildApp>, fresh: string, codeOnly: string) => ({ ...options(app).personas, [NEW_MEMBER]: bearerPersona(fresh), [CODE_ONLY_MEMBER]: bearerPersona(codeOnly) });

  it('is required on a sign-up site, with the emailed-code-only account', () => {
    const app = buildApp();
    expect(() => authMatrixCases(options(app, { signUpSite: true }))).toThrow(/persona "newMember" is required on a sign-up site/);
    const { codeOnlyMember: _dropped, ...withoutCodeOnly } = options(app).personas;
    expect(() => authMatrixCases(options(app, { signUpSite: true, personas: withoutCodeOnly }))).toThrow(/persona "codeOnlyMember" is required/);
  });

  it("runs against every route, held to a member's expectations (another member's on item routes)", async () => {
    const { app, fresh, codeOnly } = withFreshMember();
    const opts = options(app, { signUpSite: true, personas: signUpPersonas(app, fresh, codeOnly) });
    const cases = authMatrixCases(opts).filter((c) => c.persona === NEW_MEMBER);
    // Every route, twice (with and without the proxy).
    expect(cases).toHaveLength(ROUTES.length * 2);
    expect(cases.find((c) => c.path === '/api/reports/r-member')?.expected).toEqual([404]);
    expect(cases.find((c) => c.method === 'POST')?.expected).toEqual([403]);
    await assertAuthMatrix(opts);
  });

  it('catches a route that trusts "signed in" more than it should', async () => {
    const { app, fresh, codeOnly } = withFreshMember({
      // A route that lets anyone without a role through (it meant "anyone who's been invited").
      'GET /api/reports': async () => Promise.resolve(Response.json(['every report'])),
    });
    const routes: MatrixRoute[] = ROUTES.map((r) => (r.path === '/api/reports' ? { ...r, expect: { anonymous: 401, member: 403, otherMember: 403, admin: 200 } } : r));
    const message = await failure(assertAuthMatrix(options(app, { signUpSite: true, routes, personas: signUpPersonas(app, fresh, codeOnly) })));
    expect(message).toContain('as newMember');
  });

  it('refuses a row that lets it do more than a member', () => {
    const { app, fresh, codeOnly } = withFreshMember();
    const routes: MatrixRoute[] = ROUTES.map((r) => (r.method === 'POST' ? { ...r, expect: { ...r.expect, [NEW_MEMBER]: 200 } } : r));
    expect(() => authMatrixCases(options(app, { signUpSite: true, routes, personas: signUpPersonas(app, fresh, codeOnly) }))).toThrow(
      /expects "newMember" to succeed where "member" can't/,
    );
  });

  it('describes the personas to the scripted Cognito: the finished sign-up has a passkey; the other only emailed codes', () => {
    expect(FRESH_SIGN_UP_MEMBER).toEqual({ groups: [], factors: { configured: ['EMAIL_OTP', 'WEB_AUTHN'], mfa: [] } });
    expect(EMAILED_CODE_ONLY_MEMBER).toEqual({ groups: [], factors: { configured: ['EMAIL_OTP'], mfa: [] } });
  });
});

describe('an account with only emailed codes (M2: the first credential is enforced on the server)', () => {
  function withCodeOnly(extraRoutes: Record<string, RouteHandler> = {}) {
    const app = buildApp(extraRoutes);
    app.cognito.setFactors('code-only-1', { configured: ['EMAIL_OTP'], mfa: [] });
    return { app, codeOnly: app.issuer.mintAccessToken({ sub: 'code-only-1', groups: [] }) };
  }

  it('is expected to get 403 wherever a signed-in person is needed, and what anyone gets on public routes', async () => {
    const { app, codeOnly } = withCodeOnly();
    const opts = options(app, { personas: { ...options(app).personas, [CODE_ONLY_MEMBER]: bearerPersona(codeOnly) } });
    const cases = authMatrixCases(opts).filter((c) => c.persona === CODE_ONLY_MEMBER && c.pass === 'with-proxy');
    expect(Object.fromEntries(cases.map((c) => [`${c.method} ${c.path}`, c.expected]))).toEqual({
      'GET /api/reports': [403],
      'GET /api/reports/r-member': [403],
      'POST /api/admin/invite': [403],
      'GET /api/public/status': [200],
    });
    // And the app really does refuse it (requireUser: 403 first_credential_required).
    await assertAuthMatrix(opts);
  });

  it('may reach the chooser when its row says so, and the matrix catches a route that lets it in elsewhere', async () => {
    const chooser: RouteHandler = withAuthErrors(async (req) => {
      const { app } = holder;
      await app.auth.requireUser({ request: req, allowFirstCredentialEnrollment: true });
      return Response.json({ choose: true });
    });
    const holder = {} as { app: ReturnType<typeof buildApp> };
    const leaky: RouteHandler = withAuthErrors(async (req) => {
      // Meant only for the chooser, copied to a real page.
      await holder.app.auth.requireUser({ request: req, allowFirstCredentialEnrollment: true });
      return Response.json(['every report']);
    });
    const { app, codeOnly } = withCodeOnly({ 'GET /api/account/sign-in-method': chooser, 'GET /api/reports': leaky });
    holder.app = app;
    const routes: MatrixRoute[] = [
      ...ROUTES,
      { method: 'GET', path: '/api/account/sign-in-method', expect: { anonymous: 401, member: 200, admin: 200, [CODE_ONLY_MEMBER]: 200 } },
    ];
    const opts = options(app, { routes, appRoutes: [...APP_ROUTES, '/api/account/sign-in-method'], personas: { ...options(app).personas, [CODE_ONLY_MEMBER]: bearerPersona(codeOnly) } });
    const message = await failure(assertAuthMatrix(opts));
    expect(message).toContain('as codeOnlyMember');
    expect(message).toContain('/api/reports');
    expect(message).not.toContain('/api/account/sign-in-method as codeOnlyMember');
  });

  it('refuses a row that lets it do more than a member', () => {
    const { app, codeOnly } = withCodeOnly();
    const routes: MatrixRoute[] = ROUTES.map((r) => (r.method === 'POST' ? { ...r, expect: { ...r.expect, [CODE_ONLY_MEMBER]: 200 } } : r));
    expect(() => authMatrixCases(options(app, { routes, personas: { ...options(app).personas, [CODE_ONLY_MEMBER]: bearerPersona(codeOnly) } }))).toThrow(
      /expects "codeOnlyMember" to succeed where "member" can't/,
    );
  });
});
