import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import tsupConfig from '../../tsup.config.js';

const ROOT = join(import.meta.dirname, '..', '..');
const SKIP = new Set(['node_modules', 'dist', '.git', 'coverage', 'cdk.out']);
const TEXT = /\.(ts|tsx|js|json|md|yml|yaml|snap|txt)$/;

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else if (TEXT.test(name) && name !== 'package-lock.json') out.push(path);
  }
  return out;
}

// Placeholder IDs used in docs and tests. Anything else shaped like a real ID fails the test.
const PLACEHOLDER_POOL_IDS = new Set(['us-east-1_TestPool1', 'us-east-1_OtherPool2', 'us-east-1_AbCdEf123', 'us-east-1_EXAMPLE']);

describe('the public repo holds no secrets or real identifiers', () => {
  const all = files(ROOT);

  it('scans a meaningful number of files', () => {
    expect(all.length).toBeGreaterThan(30);
  });

  it('has no AWS account IDs (12-digit numbers)', () => {
    const hits = all.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/(?<![\d.])\d{12}(?![\d.])/g)].map((m) => `${relative(ROOT, f)}: ${m[0]}`));
    expect(hits).toEqual([]);
  });

  it('has no AWS access keys', () => {
    const hits = all.filter((f) => /\b(AKIA|ASIA)[0-9A-Z]{16}\b/.test(readFileSync(f, 'utf8')));
    expect(hits.map((f) => relative(ROOT, f))).toEqual([]);
  });

  it('has no real-looking Cognito pool IDs', () => {
    const hits = all.flatMap((f) =>
      [...readFileSync(f, 'utf8').matchAll(/\b[a-z]{2}-[a-z]+-\d_[A-Za-z0-9]{6,}\b/g)]
        .map((m) => m[0])
        .filter((id) => !PLACEHOLDER_POOL_IDS.has(id))
        .map((id) => `${relative(ROOT, f)}: ${id}`),
    );
    expect(hits).toEqual([]);
  });

  it('has no Amplify app IDs', () => {
    const hits = all.flatMap((f) =>
      [...readFileSync(f, 'utf8').matchAll(/\bd(?=[a-z0-9]*\d)[a-z0-9]{13}\b/g)].map((m) => `${relative(ROOT, f)}: ${m[0]}`),
    );
    expect(hits).toEqual([]);
  });
});

function importsOf(file: string): string[] {
  const src = readFileSync(join(ROOT, file), 'utf8');
  return [...src.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1] ?? '');
}

describe('module boundaries', () => {
  it('auth-kit/client imports nothing server-side (safe in client components)', () => {
    const files = readdirSync(join(ROOT, 'src/client'))
      .filter((name) => /\.tsx?$/.test(name))
      .map((name) => `src/client/${name}`);
    expect(files.length).toBeGreaterThan(5);
    // Its own files, shared policy, React, Amplify, and safeRedirect (pure; shared with the server).
    const allowed = /^(\.\/|\.\.\/shared\/|\.\.\/server\/redirect\.js$|react$|aws-amplify(\/|$))/;
    for (const file of files) {
      for (const spec of importsOf(file)) expect(spec, `${file} imports ${spec}`).toMatch(allowed);
    }
    expect(importsOf('src/server/redirect.ts')).toEqual([]);
    for (const spec of importsOf('src/shared/not-implemented.ts')) expect(spec).toBe('never');
  });

  it("auth-kit/client is a React client module ('use client')", () => {
    expect(readFileSync(join(ROOT, 'src/client/index.ts'), 'utf8').startsWith("'use client';")).toBe(true);
  });

  it('auth-kit/amplify/pre-sign-up has no imports (small Lambda bundle)', () => {
    expect(importsOf('src/amplify/pre-sign-up.ts')).toEqual([]);
  });

  it('shared policy has no imports', () => {
    expect(importsOf('src/shared/policy.ts')).toEqual([]);
  });
});

describe('package exports', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    version: string;
    exports: Record<string, string | { types: string; import: string }>;
    files: string[];
  };
  const entries = (tsupConfig as { entry: Record<string, string> }).entry;

  it('maps every subpath to a build entry, and every entry to a subpath', () => {
    const subpaths = Object.entries(pkg.exports).filter(([key]) => key !== './package.json');
    for (const [, target] of subpaths) {
      if (typeof target === 'string') throw new Error('expected conditional exports');
      const entry = target.import.replace(/^\.\/dist\//, '').replace(/\.js$/, '');
      expect(entries[entry], `tsup entry for ${target.import}`).toBeDefined();
      expect(target.types).toBe(`./dist/${entry}.d.ts`);
    }
    expect(Object.keys(entries).length).toBe(subpaths.length);
  });

  it('is a pre-release', () => {
    expect(pkg.version).toMatch(/^0\.\d+\.\d+-alpha/);
  });
});
