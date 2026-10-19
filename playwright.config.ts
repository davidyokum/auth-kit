/**
 * Screenshot tests for preview mode (ADR 0025): the standalone file (release/auth-kit-preview.js, from
 * `npm run build:preview`) in Chromium. Run them in the Playwright container, as CI does, so the baseline
 * images match pixel for pixel (the tests pin the font; the container pins everything else):
 *
 *   npm run build:preview
 *   docker run --rm --platform linux/amd64 -v "$PWD":/work -v auth-kit-linux-modules:/work/node_modules -w /work \
 *     mcr.microsoft.com/playwright:v1.63.0-noble bash -c 'npm ci --ignore-scripts && npx playwright test'
 *
 * Add `--update-snapshots` to the last command to accept new baselines after a deliberate change.
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'test/screenshots',
  testMatch: '*.spec.ts',
  // Baselines live beside the tests, named only by what they show (one platform: the container's).
  snapshotPathTemplate: '{testDir}/__snapshots__/{testFileName}/{arg}{ext}',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  // In CI a missing baseline fails the run instead of being written.
  updateSnapshots: process.env.CI ? 'none' : 'missing',
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  timeout: 180_000,
  expect: {
    toHaveScreenshot: { animations: 'disabled', caret: 'hide', scale: 'css' },
  },
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'America/New_York',
    colorScheme: 'light',
    reducedMotion: 'reduce',
  },
  projects: [{ name: 'chromium' }],
});
