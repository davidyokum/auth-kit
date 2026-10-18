import { readFile, writeFile } from 'node:fs/promises';
import { defineConfig } from 'tsup';

// Entries that are React client modules. Rollup's tree-shaking pass drops module-level directives,
// so `'use client'` is put back after the build.
const CLIENT_ENTRIES = ['client/index', 'dev/menu', 'admin/ui', 'backdrops/react', 'backdrops/picker', 'resources/ui'];

async function restoreUseClient(): Promise<void> {
  for (const entry of CLIENT_ENTRIES) {
    const file = `dist/${entry}.js`;
    const code = await readFile(file, 'utf8');
    if (code.startsWith("'use client';")) continue;
    await writeFile(file, `'use client';\n${code}`);
  }
}

// One entry per public subpath. Dependencies and peer dependencies (including
// subpaths such as `next/server` and `aws-cdk-lib/aws-cognito`) stay external.
export default defineConfig({
  entry: {
    'amplify/index': 'src/amplify/index.ts',
    'amplify/pre-sign-up': 'src/amplify/pre-sign-up.ts',
    'amplify/custom-message': 'src/amplify/custom-message.ts',
    'server/index': 'src/server/index.ts',
    'proxy/index': 'src/proxy/index.ts',
    'testing/index': 'src/testing/index.ts',
    'testing/matrix-server': 'src/testing/matrix-server.ts',
    'client/index': 'src/client/index.ts',
    'admin/index': 'src/admin/index.ts',
    'admin/ui': 'src/admin/ui/index.tsx',
    'admin/cdk': 'src/admin/cdk.ts',
    'accounts/index': 'src/accounts/index.ts',
    'resources/index': 'src/resources/index.ts',
    'resources/ui': 'src/resources/ui.tsx',
    'dev/index': 'src/dev/index.ts',
    'dev/menu': 'src/dev/menu.tsx',
    'ribbon/index': 'src/dev/ribbon.tsx',
    'backdrops/index': 'src/backdrops/index.ts',
    'backdrops/react': 'src/backdrops/react.tsx',
    // Dev only: carries the backdrop picker marker that check-prod-build looks for.
    'backdrops/picker': 'src/backdrops/picker.tsx',
    'themes/index': 'src/themes/index.ts',
    // The `auth-kit` command (not a subpath).
    'bin/auth-kit': 'src/dev/bin.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  // tsup's declaration build sets `baseUrl`, which TypeScript 6 deprecates.
  dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
  // No source maps in the package: they'd embed all of src/ (the tarball check refuses .map files).
  // The build is unminified ESM, so stack traces stay readable without them.
  sourcemap: false,
  clean: true,
  splitting: true,
  treeshake: true,
  onSuccess: restoreUseClient,
});
