/**
 * Checks on the built package, run in CI after `npm run build` (AUTH_KIT_DIST_TESTS=1), so a stale
 * local `dist` never decides a test run.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEV_SIGNIN_MARKER, MATRIX_SERVER_MARKER } from '../../src/dev/marker.js';
import { AWS_BLOCKED_ENV } from '../../src/testing/aws-env.js';

const DIST = join(import.meta.dirname, '..', '..', 'dist');
const enabled = process.env.AUTH_KIT_DIST_TESTS === '1';

/** Every file an entry loads through relative imports (its chunks), including itself. */
function graph(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const code = readFileSync(entry, 'utf8');
  for (const m of code.matchAll(/(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]|import\s*['"](\.[^'"]+)['"]/g)) {
    graph(resolve(dirname(entry), m[1] ?? m[2] ?? ''), seen);
  }
  return seen;
}

describe.runIf(enabled)('the built package', () => {
  it('exists', () => {
    expect(existsSync(join(DIST, 'dev', 'index.js'))).toBe(true);
  });

  it('auth-kit/ribbon (which ships) loads no file containing the dev sign-in marker', () => {
    const files = graph(join(DIST, 'ribbon', 'index.js'));
    expect(files.size).toBeGreaterThan(1);
    for (const file of files) expect(readFileSync(file, 'utf8').includes(DEV_SIGNIN_MARKER), file).toBe(false);
  });

  it('no subpath that ships loads a file with either dev marker (sign-in, matrix server mode)', () => {
    for (const entry of ['server/index.js', 'proxy/index.js', 'client/index.js', 'admin/index.js', 'admin/ui.js', 'admin/cdk.js', 'amplify/index.js', 'amplify/pre-sign-up.js', 'ribbon/index.js']) {
      for (const file of graph(join(DIST, entry))) {
        const code = readFileSync(file, 'utf8');
        expect(code.includes(DEV_SIGNIN_MARKER) || code.includes(MATRIX_SERVER_MARKER), `${entry} → ${file}`).toBe(false);
      }
    }
  });

  it('auth-kit/testing/matrix-server carries its marker, so check-prod-build finds a leak', () => {
    const files = [...graph(join(DIST, 'testing', 'matrix-server.js'))];
    expect(files.some((f) => readFileSync(f, 'utf8').includes(MATRIX_SERVER_MARKER))).toBe(true);
  });

  it('auth-kit/dev and auth-kit/dev/menu do carry the marker, so the build check can find them', () => {
    for (const entry of ['dev/index.js', 'dev/menu.js']) {
      const files = [...graph(join(DIST, entry))];
      expect(files.some((f) => readFileSync(f, 'utf8').includes(DEV_SIGNIN_MARKER)), entry).toBe(true);
    }
  });

  it("the persona menu is a client component ('use client' first)", () => {
    expect(readFileSync(join(DIST, 'dev', 'menu.js'), 'utf8')).toMatch(/^['"]use client['"];/);
  });

  it('next.config.ts can load auth-kit/dev (Next compiles it to CommonJS and requires it)', () => {
    const loaded = createRequire(import.meta.url)('auth-kit/dev') as { withDevKit?: unknown };
    expect(typeof loaded.withDevKit).toBe('function');
  });

  it('the auth-kit command starts with a shebang', () => {
    expect(readFileSync(join(DIST, 'bin', 'auth-kit.js'), 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
  });
});

describe.runIf(enabled)('the invite-expiry function bundle (auth-kit/admin/cdk deploys it)', () => {
  const bundle = join(DIST, 'lambda', 'invite-expiry', 'index.mjs');
  const code = () => readFileSync(bundle, 'utf8');

  /** Runs the bundle's handler in a fresh Node with AWS unreachable, and returns what it threw. */
  function invoke(env: Record<string, string>): string {
    const script = `const m = await import(${JSON.stringify(bundle)}); try { await m.handler(); console.log('resolved'); } catch (e) { console.log(e.name + ': ' + e.message); }`;
    return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      // Next's types make NODE_ENV required in ProcessEnv; this child has none on purpose.
      env: { PATH: process.env.PATH ?? '', ...AWS_BLOCKED_ENV, ...env } as unknown as NodeJS.ProcessEnv,
      encoding: 'utf8',
    }).trim();
  }

  it('is self-contained: it imports only Node built-ins', () => {
    const specifiers = [...code().matchAll(/^import\s[^'"]*?from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]!);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const s of specifiers) expect(s.startsWith('node:') || builtinModules.includes(s), s).toBe(true);
  });

  it('carries no dev code', () => {
    expect(code().includes(DEV_SIGNIN_MARKER) || code().includes(MATRIX_SERVER_MARKER)).toBe(false);
  });

  it('refuses to run without its configuration', () => {
    expect(invoke({})).toMatch(/AUTH_KIT_USER_POOL_ID must be a user pool ID/);
  });

  it('with its configuration, gets as far as AWS credentials (none here), so every module it needs loaded', () => {
    expect(invoke({ AUTH_KIT_USER_POOL_ID: 'us-east-1_TestPool1', AUTH_KIT_AUDIT_TABLE: 'audit-table' })).toMatch(/^CredentialsProviderError/);
  });
});
