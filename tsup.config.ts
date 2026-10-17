import { readFile, writeFile } from 'node:fs/promises';
import { defineConfig } from 'tsup';

// Entries that are React client modules. Rollup's tree-shaking pass drops module-level directives,
// so `'use client'` is put back after the build (and the source map shifted by that one line).
const CLIENT_ENTRIES = ['client/index', 'dev/menu'];

async function restoreUseClient(): Promise<void> {
  for (const entry of CLIENT_ENTRIES) {
    const file = `dist/${entry}.js`;
    const code = await readFile(file, 'utf8');
    if (code.startsWith("'use client';")) continue;
    await writeFile(file, `'use client';\n${code}`);
    const map = JSON.parse(await readFile(`${file}.map`, 'utf8')) as { mappings: string };
    map.mappings = `;${map.mappings}`;
    await writeFile(`${file}.map`, JSON.stringify(map));
  }
}

// One entry per public subpath. Dependencies and peer dependencies (including
// subpaths such as `next/server` and `aws-cdk-lib/aws-cognito`) stay external.
export default defineConfig({
  entry: {
    'amplify/index': 'src/amplify/index.ts',
    'amplify/pre-sign-up': 'src/amplify/pre-sign-up.ts',
    'server/index': 'src/server/index.ts',
    'proxy/index': 'src/proxy/index.ts',
    'testing/index': 'src/testing/index.ts',
    'client/index': 'src/client/index.ts',
    'admin/index': 'src/admin/index.ts',
    'dev/index': 'src/dev/index.ts',
    'dev/menu': 'src/dev/menu.tsx',
    'ribbon/index': 'src/dev/ribbon.tsx',
    // The `auth-kit` command (not a subpath).
    'bin/auth-kit': 'src/dev/bin.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  // tsup's declaration build sets `baseUrl`, which TypeScript 6 deprecates.
  dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
  sourcemap: true,
  clean: true,
  splitting: true,
  treeshake: true,
  onSuccess: restoreUseClient,
});
