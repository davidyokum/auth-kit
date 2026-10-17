import type { NextConfig } from 'next';
import { describe, expect, it } from 'vitest';
import { DEV_ALIAS, DEV_MATRIX_ALIAS, DEV_POLICY, DEV_SIGN_IN_ROUTE, isDevServerPhase, withDevKit } from '../../src/dev/index.js';

describe('withDevKit (next.config)', () => {
  it('under next dev: .dev.ts routes count, and @/dev points at the on module', () => {
    const config = withDevKit('phase-development-server', { reactStrictMode: true });
    expect(config.reactStrictMode).toBe(true);
    expect(config.pageExtensions).toEqual(['dev.tsx', 'dev.ts', 'dev.jsx', 'dev.js', 'tsx', 'ts', 'jsx', 'js']);
    expect(config.turbopack?.resolveAlias).toEqual({ '@/dev': './lib/dev/on.tsx' });
  });

  it('in every build: no .dev.ts routes, and @/dev points at the off module', () => {
    for (const phase of ['phase-production-build', 'phase-production-server', 'phase-export']) {
      const config = withDevKit(phase, { pageExtensions: ['tsx', 'ts', 'mdx'] });
      expect(config.pageExtensions).toEqual(['tsx', 'ts', 'mdx']);
      expect(config.turbopack?.resolveAlias).toEqual({ '@/dev': './lib/dev/off.tsx' });
    }
    expect(isDevServerPhase('phase-production-build')).toBe(false);
  });

  it('never lets a dev extension through in a build, even if the app listed one', () => {
    expect(withDevKit('phase-production-build', { pageExtensions: ['dev.ts', 'ts'] }).pageExtensions).toEqual(['ts']);
  });

  it('keeps existing aliases and adds a webpack alias for --webpack builds', () => {
    const config = withDevKit('phase-production-build', { turbopack: { resolveAlias: { '@/x': './x.ts' }, root: '.' } }, { alias: '#dev', off: './src/dev-off.tsx' });
    expect(config.turbopack).toEqual({ resolveAlias: { '@/x': './x.ts', '#dev': './src/dev-off.tsx' }, root: '.' });
    const webpack = config.webpack({ resolve: { alias: { react: 'react' } } }, { dir: '/app' });
    expect(webpack.resolve?.alias).toEqual({ react: 'react', '#dev$': '/app/src/dev-off.tsx' });
  });

  it("accepts and returns Next's own NextConfig type", () => {
    const base: NextConfig = { reactStrictMode: true, turbopack: { resolveAlias: { '@/x': './x.ts' } }, webpack: (c: unknown) => c };
    const out: NextConfig = withDevKit('phase-development-server', base);
    expect(out.reactStrictMode).toBe(true);
  });

  it('takes several aliases: the localhost kit and the auth matrix server mode (#9)', () => {
    const dev = withDevKit('phase-development-server', {}, { aliases: [DEV_ALIAS, DEV_MATRIX_ALIAS] });
    expect(dev.turbopack.resolveAlias).toEqual({ '@/dev': './lib/dev/on.tsx', '@/dev-matrix': './lib/dev/matrix.on.ts' });
    const build = withDevKit('phase-production-build', {}, { aliases: [DEV_ALIAS, DEV_MATRIX_ALIAS] });
    expect(build.turbopack.resolveAlias).toEqual({ '@/dev': './lib/dev/off.tsx', '@/dev-matrix': './lib/dev/matrix.off.ts' });
    expect(build.webpack({ resolve: { alias: {} } }, { dir: '/app/' }).resolve?.alias).toEqual({
      '@/dev$': '/app/lib/dev/off.tsx',
      '@/dev-matrix$': '/app/lib/dev/matrix.off.ts',
    });
    const arrayAliases = build.webpack({ resolve: { alias: [] } }, { dir: '/app' }).resolve?.alias;
    expect(arrayAliases).toEqual([
      { name: '@/dev', alias: '/app/lib/dev/off.tsx', onlyModule: true },
      { name: '@/dev-matrix', alias: '/app/lib/dev/matrix.off.ts', onlyModule: true },
    ]);
  });

  it('is harmless to call twice (the nested form older templates used)', () => {
    const nested = withDevKit('phase-development-server', withDevKit('phase-development-server', {}), DEV_MATRIX_ALIAS);
    expect(nested.pageExtensions).toEqual(['dev.tsx', 'dev.ts', 'dev.jsx', 'dev.js', 'tsx', 'ts', 'jsx', 'js']);
    expect(nested.turbopack.resolveAlias).toEqual({ '@/dev': './lib/dev/on.tsx', '@/dev-matrix': './lib/dev/matrix.on.ts' });
  });

  it('refuses alias lists that would ship the wrong module', () => {
    const run = (options: Parameters<typeof withDevKit>[2]) => () => withDevKit('phase-production-build', {}, options);
    expect(run({ aliases: [DEV_ALIAS], alias: '@/x' })).toThrow(/either `aliases` or `alias`/);
    expect(run({ aliases: [] })).toThrow(/at least one alias/);
    expect(run({ aliases: 'x' as never })).toThrow(/must be an array/);
    expect(run({ aliases: [DEV_ALIAS, DEV_ALIAS] })).toThrow(/listed twice/);
    expect(run({ aliases: [{ alias: '', on: './a.ts', off: './b.ts' }] })).toThrow(/import specifier/);
    expect(run({ aliases: [{ alias: '@/x', on: 'lib/on.ts', off: './off.ts' }] })).toThrow(/`on` as a path relative/);
    expect(run({ aliases: [{ alias: '@/x', on: './on.ts', off: '/abs/off.ts' }] })).toThrow(/`off` as a path relative/);
    expect(run({ aliases: [{ alias: '@/x', on: './same.ts', off: './same.ts' }] })).toThrow(/same module/);
  });

  it('agrees with the policy on the route', () => {
    expect(DEV_SIGN_IN_ROUTE).toBe('/api/dev/sign-in');
    expect(DEV_POLICY.route).toBe(DEV_SIGN_IN_ROUTE);
  });
});
