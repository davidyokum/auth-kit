import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import tsupConfig from '../../tsup.config.js';

const ROOT = join(import.meta.dirname, '..', '..');
const SKIP = new Set(['node_modules', 'dist', '.git', 'coverage', 'cdk.out', '.next']);
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
    expect(importsOf('src/shared/unavailable.ts')).toEqual([]);
    for (const spec of importsOf('src/shared/not-implemented.ts')) expect(spec).toBe('never');
  });

  it("auth-kit/client is a React client module ('use client')", () => {
    expect(readFileSync(join(ROOT, 'src/client/index.ts'), 'utf8').startsWith("'use client';")).toBe(true);
  });

  it('auth-kit/amplify/pre-sign-up imports only the pure account-creation rules (small Lambda bundle)', () => {
    expect(importsOf('src/amplify/pre-sign-up.ts')).toEqual(['../shared/account-creation.js']);
    expect(importsOf('src/shared/account-creation.ts')).toEqual([]);
  });

  it('auth-kit/amplify/custom-message imports no AWS SDK, CDK, or React (small Lambda bundle)', () => {
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const spec of importsOf(file)) {
        expect(spec, `${file} imports ${spec}`).toMatch(/^\.\.?\//);
        walk(join(dirname(file), spec).replace(/\.js$/, '.ts'));
      }
    };
    walk('src/amplify/custom-message.ts');
    expect(seen.size).toBeGreaterThan(3);
  });

  it('auth-kit/backdrops is framework-free: the core imports only its own files', () => {
    const walk = (dir: string): string[] =>
      readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : /\.tsx?$/.test(e.name) ? [`${dir}/${e.name}`] : []));
    const core = walk('src/backdrops').filter((f) => !/\/(react|picker)\.tsx$/.test(f));
    expect(core.length).toBeGreaterThan(20);
    for (const file of core) for (const spec of importsOf(file)) expect(spec, `${file} imports ${spec}`).toMatch(/^\.\.?\//);
    // The React component adds React; the dev-only picker adds the marker module.
    for (const spec of importsOf('src/backdrops/react.tsx')) expect(spec).toMatch(/^(\.\/|react$)/);
    for (const spec of importsOf('src/backdrops/picker.tsx')) expect(spec).toMatch(/^(\.\/|react$|\.\.\/dev\/marker\.js$)/);
    // Style versions draw only through the frozen kernel and the style contract.
    for (const file of core.filter((f) => /\/styles\/[^/]+\/v\d+\.ts$/.test(f))) {
      for (const spec of importsOf(file)) expect(spec, `${file} imports ${spec}`).toMatch(/^(\.\.\/\.\.\/kernel\/v\d+\/|\.\.\/define\.js$)/);
    }
  });

  it("auth-kit/backdrops/react and the picker are React client modules ('use client')", () => {
    for (const file of ['src/backdrops/react.tsx', 'src/backdrops/picker.tsx']) expect(readFileSync(join(ROOT, file), 'utf8').startsWith("'use client';"), file).toBe(true);
  });

  it('shared policy has no imports', () => {
    expect(importsOf('src/shared/policy.ts')).toEqual([]);
  });

  it('auth-kit/resources/ui imports nothing server-side (safe in client components)', () => {
    // The panel, and the pure modules it reads: the rules, the plain types, the key layout.
    const allowed = /^(\.\/(policy|types)\.js$|\.\.\/shared\/policy\.js$|\.\.\/admin\/types\.js$|\.\.\/admin\/ui\/index\.js$|react$)/;
    for (const spec of importsOf('src/resources/ui.tsx')) expect(spec, `ui.tsx imports ${spec}`).toMatch(allowed);
    for (const spec of importsOf('src/resources/policy.ts')) expect(spec).toBe('../shared/policy.js');
    expect(importsOf('src/resources/schema.ts')).toEqual([]);
    for (const spec of importsOf('src/resources/types.ts')) expect(spec).toMatch(/^(\.\.\/admin\/guardrails\.js|\.\.\/shared\/policy\.js|\.\/policy\.js)$/);
    expect(readFileSync(join(ROOT, 'src/resources/ui.tsx'), 'utf8').startsWith("'use client';")).toBe(true);
  });
});

describe('package exports', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    version: string;
    exports: Record<string, string | { types: string; import: string }>;
    files: string[];
  };
  // `bin/*` entries build the `auth-kit` command, not a subpath.
  const entries = Object.fromEntries(
    Object.entries((tsupConfig as { entry: Record<string, string> }).entry).filter(([name]) => !name.startsWith('bin/')),
  );

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
