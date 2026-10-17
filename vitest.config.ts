import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // CDK synthesis in the preset tests takes a few seconds per template.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
