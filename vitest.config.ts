import { defineConfig } from 'vitest/config';
import { AWS_BLOCKED_ENV } from './src/testing/aws-env.js';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // CDK synthesis in the preset tests takes a few seconds per template.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // No AWS from tests: an SDK call that slips past a mock fails at credential lookup
    // (test/package/no-aws.test.ts is the canary).
    env: { ...AWS_BLOCKED_ENV },
  },
});
