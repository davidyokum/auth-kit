import type { createServerRunner } from '@aws-amplify/adapter-nextjs';
import type { fetchAuthSession } from 'aws-amplify/auth/server';
import { expect, it } from 'vitest';
import type { AmplifyAdapterRefreshDeps } from '../../src/proxy/index.js';

type RunWithAmplifyServerContext = ReturnType<typeof createServerRunner>['runWithAmplifyServerContext'];

// Compile-time check (npm run typecheck): the real adapter functions fit the loose dependency types,
// so apps can pass them straight to amplifyAdapterRefresh.
function depsFromRealAdapter(run: RunWithAmplifyServerContext, fetch: typeof fetchAuthSession): AmplifyAdapterRefreshDeps {
  return { runWithAmplifyServerContext: run, fetchAuthSession: fetch };
}

it('accepts the Amplify adapter and fetchAuthSession types', () => {
  expect(typeof depsFromRealAdapter).toBe('function');
});
