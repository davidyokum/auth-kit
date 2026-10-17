import type { NextConfig } from 'next';
import { describe, expect, it } from 'vitest';
import { DEV_POLICY, DEV_SIGN_IN_ROUTE, isDevServerPhase, withDevKit } from '../../src/dev/index.js';

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

  it('agrees with the policy on the route', () => {
    expect(DEV_SIGN_IN_ROUTE).toBe('/api/dev/sign-in');
    expect(DEV_POLICY.route).toBe(DEV_SIGN_IN_ROUTE);
  });
});
