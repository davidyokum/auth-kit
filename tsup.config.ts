import { defineConfig } from 'tsup';

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
});
