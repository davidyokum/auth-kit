import { defineConfig } from 'tsup';

/**
 * The Lambda bundles `auth-kit/admin/cdk` deploys (`npm run build` runs this after the main build).
 * Self-contained: every dependency, the AWS SDK clients included, is bundled, so a function runs
 * exactly the code in the release tarball (ADR 0012), not whatever SDK the Lambda runtime ships.
 * Unminified, so a stack trace in the function's log stays readable without a source map.
 */
export default defineConfig({
  entry: {
    'lambda/invite-expiry/index': 'src/admin/invite-expiry-handler.ts',
    'lambda/unverified-sweep/index': 'src/accounts/unverified-sweep-handler.ts',
    'lambda/access-request-digest/index': 'src/accounts/digest-handler.ts',
  },
  outDir: 'dist',
  format: ['esm'],
  outExtension: () => ({ js: '.mjs' }),
  target: 'node22',
  platform: 'node',
  noExternal: [/.*/],
  splitting: false,
  treeshake: true,
  minify: false,
  sourcemap: false,
  dts: false,
  // The main build cleans dist/; this one only adds to it.
  clean: false,
  // Some bundled CommonJS dependencies call require() for Node built-ins; ESM has no require.
  banner: { js: "import { createRequire as __authKitCreateRequire } from 'node:module';\nconst require = __authKitCreateRequire(import.meta.url);" },
});
