import {
  type CapabilityOf,
  type GroupOf,
  type ServerAuth,
  type ServerAuthOptions,
  createServerAuth,
  defineCapabilities,
  STANDARD_CAPABILITIES,
} from '../src/server/index.js';
import { createFakeCognito, createTestIssuer, type FakeCognito, type TestIssuer } from '../src/testing/index.js';

/** Placeholders only: this repo is public and holds no real pool or client IDs. */
export const POOL_ID = 'us-east-1_TestPool1';
export const CLIENT_ID = 'testclient0000000000000000';
export const OTHER_POOL_ID = 'us-east-1_OtherPool2';
export const OTHER_CLIENT_ID = 'otherclient000000000000000';

export const capabilities = defineCapabilities({
  ...STANDARD_CAPABILITIES,
  reviewer: ['reviews.read', 'reviews.comment'],
});

export type AppGroup = GroupOf<typeof capabilities>;
export type AppCapability = CapabilityOf<typeof capabilities>;

export interface Harness {
  issuer: TestIssuer;
  cognito: FakeCognito;
  clock: { now: number };
  jwksFetches: string[];
  auth: ServerAuth<AppGroup, AppCapability>;
}

/**
 * A server auth bound to a local test issuer. The JWKS fetcher serves the issuer's keys (as Cognito's
 * endpoint would) and records each fetch, so no test ever reaches the network.
 */
export function harness(overrides: Partial<ServerAuthOptions<AppGroup, AppCapability>> = {}): Harness {
  // aws-jwt-verify checks expiry against the real clock, so tokens are minted in real time. The
  // injected clock drives auth-kit's own logic (step-up age, cache lifetimes) and can move freely.
  const clock = { now: Date.now() };
  const issuer = createTestIssuer({ userPoolId: POOL_ID, clientId: CLIENT_ID });
  const cognito = createFakeCognito();
  const jwksFetches: string[] = [];
  const auth = createServerAuth({
    userPoolId: POOL_ID,
    clientId: CLIENT_ID,
    capabilities,
    jwks: issuer.jwks,
    jwksFetcher: (uri) => {
      jwksFetches.push(uri);
      return Promise.resolve(issuer.jwks);
    },
    cognito,
    now: () => clock.now,
    context: () => Promise.reject(new Error('tests must pass { request }')),
    ...overrides,
  });
  return { issuer, cognito, clock, jwksFetches, auth };
}

/** A Request carrying a bearer token. */
export function bearer(token: string, url = 'https://app.example.org/api/x'): Request {
  return new Request(url, { headers: { authorization: `Bearer ${token}` } });
}
