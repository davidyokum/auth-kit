import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertProductionBuild, checkProductionBuild, DEV_SIGNIN_MARKER } from '../../src/dev/index.js';

let root: string;
let build: string;

/** A minimal `.next` production build, shaped like Next 16's output. */
async function fixture(files: Record<string, string>) {
  const base: Record<string, string> = {
    BUILD_ID: 'fixture-build',
    'app-path-routes-manifest.json': JSON.stringify({ '/page': '/', '/api/reports/[id]/route': '/api/reports/[id]' }),
    'routes-manifest.json': JSON.stringify({ version: 3, staticRoutes: [{ page: '/', regex: '^/(?:/)?$' }], dynamicRoutes: [{ page: '/api/reports/[id]' }] }),
    'server/app-paths-manifest.json': JSON.stringify({ '/page': 'app/page.js', '/api/reports/[id]/route': 'app/api/reports/[id]/route.js' }),
    'server/app/page.js': 'export default function Page(){return "home"}',
    'server/app/api/reports/[id]/route.js': 'export async function GET(){ return new Response("ok") }',
    // The proxy lists the dev route as public so a build without it answers 404: that string is fine.
    'server/middleware.js': 'const publicRoutes=["/","/api/dev/sign-in"];',
    'static/chunks/app/layout.js': 'console.log("layout")',
    ...files,
  };
  for (const [path, content] of Object.entries(base)) {
    await mkdir(dirname(join(build, path)), { recursive: true });
    await writeFile(join(build, path), content);
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'auth-kit-build-'));
  build = join(root, '.next');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('checkProductionBuild', () => {
  it('passes a clean build', async () => {
    await fixture({});
    const result = await checkProductionBuild({ buildDir: build });
    expect(result).toEqual({ ok: true, findings: [], filesScanned: 8 });
    await expect(assertProductionBuild({ buildDir: build })).resolves.toMatchObject({ ok: true });
  });

  it('fails when the route handler was bundled (marker in a server chunk)', async () => {
    await fixture({ 'server/chunks/ssr/abc123.js': `h.set("x-auth-kit-dev","${DEV_SIGNIN_MARKER}")` });
    const result = await checkProductionBuild({ buildDir: build });
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([{ kind: 'marker', file: join('server', 'chunks', 'ssr', 'abc123.js'), detail: expect.stringMatching(/marker/) }]);
  });

  it('fails when the persona menu reached a client chunk', async () => {
    await fixture({ 'static/chunks/app/layout-1a2b.js': `jsx("span",{"data-auth-kit-dev":"${DEV_SIGNIN_MARKER}"})` });
    expect((await checkProductionBuild({ buildDir: build })).findings.map((f) => f.kind)).toEqual(['marker']);
  });

  it('fails when the dev route is registered (route file and manifests)', async () => {
    await fixture({
      'app-path-routes-manifest.json': JSON.stringify({ '/page': '/', '/api/dev/sign-in/route': '/api/dev/sign-in' }),
      'server/app-paths-manifest.json': JSON.stringify({ '/api/dev/sign-in/route': 'app/api/dev/sign-in/route.js' }),
      'server/app/api/dev/sign-in/route.js': 'export async function POST(){}',
    });
    const kinds = (await checkProductionBuild({ buildDir: build })).findings.map((f) => `${f.kind}:${f.file}`);
    expect(kinds).toEqual([
      `route-file:${join('server', 'app', 'api', 'dev', 'sign-in', 'route.js')}`,
      'route-manifest:app-path-routes-manifest.json',
      'route-manifest:server/app-paths-manifest.json',
    ]);
    await expect(assertProductionBuild({ buildDir: build })).rejects.toThrow(/isn't clean/);
  });

  it('catches a pages-router API route too', async () => {
    await fixture({ 'server/pages/api/dev/sign-in.js': 'module.exports=()=>{}', 'server/pages-manifest.json': JSON.stringify({ '/api/dev/sign-in': 'pages/api/dev/sign-in.js' }) });
    expect((await checkProductionBuild({ buildDir: build })).findings.map((f) => f.kind)).toEqual(['route-file', 'route-manifest']);
  });

  it('ignores next dev output (.next/dev) and the cache', async () => {
    await fixture({
      'dev/server/app/api/dev/sign-in/route.js': `"${DEV_SIGNIN_MARKER}"`,
      'cache/turbopack/x.bin': `${DEV_SIGNIN_MARKER}`,
    });
    expect((await checkProductionBuild({ buildDir: build })).ok).toBe(true);
  });

  it('refuses a directory that is not a production build: no data is not a pass', async () => {
    await mkdir(join(build, 'dev'), { recursive: true });
    expect(await checkProductionBuild({ buildDir: build })).toEqual({
      ok: false,
      filesScanned: 0,
      findings: [{ kind: 'not-a-build', detail: expect.stringMatching(/next build/) }],
    });
    expect((await checkProductionBuild({ buildDir: join(root, 'missing') })).findings[0]?.kind).toBe('not-a-build');
  });

  it('takes a custom route and extra markers', async () => {
    await fixture({ 'server/app/api/devtools/login/route.js': '', 'static/chunks/x.js': 'MY-MARKER' });
    const result = await checkProductionBuild({ buildDir: build, devRoute: '/api/devtools/login/', markers: ['MY-MARKER'] });
    expect(result.findings.map((f) => f.kind)).toEqual(['route-file', 'marker']);
  });
});
