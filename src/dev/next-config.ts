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

/** One import specifier that means a dev-only module under `next dev` and a harmless one in builds. */
export interface DevKitAlias {
  /** The import specifier code that ships uses, e.g. `@/dev`. */
  alias: string;
  /** The module under `next dev`, relative to the project root, e.g. `./lib/dev/on.tsx`. */
  on: string;
  /** The module in every build (same exports, no dev code), e.g. `./lib/dev/off.tsx`. */
  off: string;
}

/** The localhost kit's alias: the ribbon's dev parts and the "Sign in as…" menu. */
export const DEV_ALIAS: Readonly<DevKitAlias> = Object.freeze({ alias: '@/dev', on: './lib/dev/on.tsx', off: './lib/dev/off.tsx' });

/** The auth matrix's server mode (`auth-kit/testing/matrix-server`; ADR 0016). */
export const DEV_MATRIX_ALIAS: Readonly<DevKitAlias> = Object.freeze({
  alias: '@/dev-matrix',
  on: './lib/dev/matrix.on.ts',
  off: './lib/dev/matrix.off.ts',
});

export interface DevKitConfigOptions {
  /** The import specifier layouts use. Default `@/dev`. */
  alias?: string;
  /** The module under `next dev`, relative to the project root. Default `./lib/dev/on.tsx`. */
  on?: string;
  /** The module in every build. Default `./lib/dev/off.tsx`. */
  off?: string;
  /**
   * Several aliases at once, instead of `alias`/`on`/`off`:
   * `{ aliases: [DEV_ALIAS, DEV_MATRIX_ALIAS] }` for the localhost kit plus the auth matrix's server
   * mode. Each one resolves to its `on` module under `next dev` and its `off` module in every build.
   */
  aliases?: readonly DevKitAlias[];
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

/** The aliases to set, checked: a typo here would quietly ship the wrong module. */
function resolveAliases(options: DevKitConfigOptions): DevKitAlias[] {
  if (options.aliases !== undefined && (options.alias !== undefined || options.on !== undefined || options.off !== undefined)) {
    throw new Error('auth-kit: withDevKit takes either `aliases` or `alias`/`on`/`off`, not both.');
  }
  if (options.aliases !== undefined && !Array.isArray(options.aliases)) throw new Error('auth-kit: withDevKit `aliases` must be an array.');
  const list: readonly DevKitAlias[] = options.aliases ?? [
    { alias: options.alias ?? DEV_ALIAS.alias, on: options.on ?? DEV_ALIAS.on, off: options.off ?? DEV_ALIAS.off },
  ];
  if (list.length === 0) throw new Error('auth-kit: withDevKit `aliases` must list at least one alias.');
  const seen = new Set<string>();
  for (const entry of list) {
    const label = JSON.stringify(entry);
    if (typeof (entry as Partial<DevKitAlias> | null)?.alias !== 'string' || entry.alias.trim() === '' || /\s/.test(entry.alias)) throw new Error(`auth-kit: withDevKit alias ${label} needs an import specifier.`);
    if (seen.has(entry.alias)) throw new Error(`auth-kit: withDevKit alias "${entry.alias}" is listed twice.`);
    seen.add(entry.alias);
    for (const key of ['on', 'off'] as const) {
      const path = entry[key];
      if (typeof path !== 'string' || !/^\.\.?\//.test(path)) {
        throw new Error(`auth-kit: withDevKit alias "${entry.alias}" needs \`${key}\` as a path relative to the project root (./lib/dev/…).`);
      }
    }
    if (entry.on === entry.off) throw new Error(`auth-kit: withDevKit alias "${entry.alias}" points on and off at the same module.`);
  }
  return list.map((entry) => ({ alias: entry.alias, on: entry.on, off: entry.off }));
}

/**
 * Adds the dev-only page extensions and the aliases (`@/dev` by default; Turbopack and webpack) to a
 * Next config. Keep your tsconfig's `paths` pointing each alias at its off module, so type checks see
 * the shape every build uses. Calling it again on its own result is harmless.
 */
export function withDevKit<C extends object>(
  phase: string,
  config: C & DevKitNextConfig = {} as C & DevKitNextConfig,
  options: DevKitConfigOptions = {},
): C & DevKitNextConfigResult {
  const dev = isDevServerPhase(phase);
  const aliases = resolveAliases(options).map((entry) => ({ alias: entry.alias, target: dev ? entry.on : entry.off }));
  const base = (config.pageExtensions ?? DEFAULT_EXTENSIONS).filter((ext) => !/^dev\./.test(ext));
  const pageExtensions = dev ? [...base.map((ext) => `dev.${ext}`), ...base] : base;
  const userWebpack = config.webpack;
  return {
    ...config,
    pageExtensions,
    turbopack: {
      ...config.turbopack,
      resolveAlias: { ...config.turbopack?.resolveAlias, ...Object.fromEntries(aliases.map(({ alias, target }) => [alias, target])) },
    },
    webpack: (webpackConfig: WebpackConfigLike, context: unknown) => {
      const out = (userWebpack ? userWebpack(webpackConfig, context) : webpackConfig) as WebpackConfigLike;
      const resolved = (context as { dir?: string } | undefined)?.dir;
      out.resolve ??= {};
      for (const { alias, target } of aliases) {
        const path = resolved ? `${resolved.replace(/\/+$/, '')}/${target.replace(/^\.\//, '')}` : target;
        if (Array.isArray(out.resolve.alias)) out.resolve.alias.push({ name: alias, alias: path, onlyModule: true });
        else out.resolve.alias = { ...out.resolve.alias, [`${alias}$`]: path };
      }
      return out;
    },
  };
}
