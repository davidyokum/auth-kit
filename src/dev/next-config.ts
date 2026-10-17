/**
 * Keeping the dev kit out of production builds (primer Chapter 8, "Under the hood"):
 *
 * 1. **Route files ending in `.dev.ts` exist only under `next dev`.** In development the page
 *    extensions include `dev.tsx` and `dev.ts`, so `app/api/dev/sign-in/route.dev.ts` is a route;
 *    in a build they don't, so the file isn't a route and nothing imports it.
 * 2. **One module swapped by an alias.** Layouts import the dev-only UI (the persona menu, the
 *    ribbon's sandbox check) from one alias, `@/dev`. Under `next dev` it resolves to
 *    `lib/dev/on.tsx`; in a build, to `lib/dev/off.tsx`, which has the same exports and no dev code.
 * 3. **A test proves it**: `npx auth-kit check-prod-build` after `next build`, and
 *    `npx auth-kit check-dev-route` against `next start`.
 *
 * ```ts
 * // next.config.ts
 * import { withDevKit } from 'auth-kit/dev';
 * export default (phase: string) => withDevKit(phase, { reactStrictMode: true });
 * ```
 */

/** Next's phase name for `next dev` (from `next/constants`, inlined so this module needs no Next import). */
export const PHASE_DEVELOPMENT_SERVER = 'phase-development-server';

export interface DevKitConfigOptions {
  /** The import specifier layouts use. Default `@/dev`. */
  alias?: string;
  /** The module under `next dev`, relative to the project root. Default `./lib/dev/on.tsx`. */
  on?: string;
  /** The module in every build. Default `./lib/dev/off.tsx`. */
  off?: string;
}

/**
 * The parts of a Next config `withDevKit` touches. Next's own `NextConfig` fits it, so
 * `withDevKit(phase, config satisfies NextConfig)` returns a `NextConfig`.
 */
export interface DevKitNextConfig {
  pageExtensions?: string[];
  turbopack?: { resolveAlias?: Record<string, unknown> };
  // Next types this with webpack's own Configuration; auth-kit doesn't depend on webpack.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  webpack?: ((config: any, context: any) => any) | null;
}

/** What `withDevKit` sets, on top of the config it was given. */
export interface DevKitNextConfigResult {
  pageExtensions: string[];
  turbopack: { resolveAlias: Record<string, unknown> };
  webpack: (config: WebpackConfigLike, context: unknown) => WebpackConfigLike;
}

interface WebpackConfigLike {
  resolve?: { alias?: Record<string, unknown> | unknown[] };
  [key: string]: unknown;
}

const DEFAULT_EXTENSIONS = ['tsx', 'ts', 'jsx', 'js'];

/** True when this phase is `next dev`. */
export function isDevServerPhase(phase: string): boolean {
  return phase === PHASE_DEVELOPMENT_SERVER;
}

/**
 * Adds the dev-only page extensions and the `@/dev` alias (Turbopack and webpack) to a Next config.
 * Keep your tsconfig's `paths` pointing `@/dev` at the off module, so type checks see the shape
 * every build uses.
 */
export function withDevKit<C extends object>(
  phase: string,
  config: C & DevKitNextConfig = {} as C & DevKitNextConfig,
  options: DevKitConfigOptions = {},
): C & DevKitNextConfigResult {
  const dev = isDevServerPhase(phase);
  const alias = options.alias ?? '@/dev';
  const target = dev ? (options.on ?? './lib/dev/on.tsx') : (options.off ?? './lib/dev/off.tsx');
  const base = (config.pageExtensions ?? DEFAULT_EXTENSIONS).filter((ext) => !/^dev\./.test(ext));
  const pageExtensions = dev ? [...base.map((ext) => `dev.${ext}`), ...base] : base;
  const userWebpack = config.webpack;
  return {
    ...config,
    pageExtensions,
    turbopack: { ...config.turbopack, resolveAlias: { ...config.turbopack?.resolveAlias, [alias]: target } },
    webpack: (webpackConfig: WebpackConfigLike, context: unknown) => {
      const out = (userWebpack ? userWebpack(webpackConfig, context) : webpackConfig) as WebpackConfigLike;
      const resolved = (context as { dir?: string } | undefined)?.dir;
      const path = resolved ? `${resolved.replace(/\/+$/, '')}/${target.replace(/^\.\//, '')}` : target;
      out.resolve ??= {};
      if (Array.isArray(out.resolve.alias)) out.resolve.alias.push({ name: alias, alias: path, onlyModule: true });
      else out.resolve.alias = { ...out.resolve.alias, [`${alias}$`]: path };
      return out;
    },
  };
}
