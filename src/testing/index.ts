/**
 * `auth-kit/testing`: helpers for apps' own tests. Node only; never import it from app code.
 * (The matrix's server mode, which the app's dev-only code imports, is `auth-kit/testing/matrix-server`.)
 */
import { amplifyCookieNames } from '../server/tokens.js';
import type { CognitoGateway, LiveUserState, UserAuthFactors } from '../server/cognito.js';
import type { PersonaDefinition } from './matrix.js';

export {
  authMatrixCases,
  runAuthMatrix,
  assertAuthMatrix,
  formatMatrixFailures,
  bearerPersona,
  REQUIRED_PERSONAS,
  SECOND_MEMBER,
  NEW_MEMBER,
  MATRIX_PASSES,
  type MatrixPass,
  type AuthMatrixOptions,
  type MatrixRoute,
  type MatrixCase,
  type MatrixResult,
  type PersonaDefinition,
} from './matrix.js';
export {
  routesFromNextBuild,
  compileAppRoute,
  resolveAppRoute,
  type AppRoute,
  type AppRouteInput,
  type CompiledRoute,
  type RoutesFromNextBuildOptions,
} from './routes.js';
export {
  MATRIX_ENV_FLAG,
  MATRIX_FIXTURE_ENV,
  MATRIX_HANDLER_PASS_VALUE,
  MATRIX_REQUEST_HEADER,
  PROXY_RESPONSE_HEADER,
  PROXY_DENIED,
  PROXY_HANDLER_PASS,
} from '../shared/matrix-protocol.js';
export {
  createTestIssuer,
  tamperToken,
  unsignedToken,
  type TestIssuer,
  type TestIssuerOptions,
  type MintOptions,
} from './issuer.js';
export { AWS_BLOCKED_ENV } from './aws-env.js';
export {
  startMatrixServer,
  matrixFixture,
  FRESH_SIGN_UP_MEMBER,
  matrixServerEnv,
  type StartMatrixServerOptions,
  type MatrixServer,
  type MatrixPersona,
  type MatrixPersonaSpec,
} from './matrix-run.js';
export {
  parseMatrixFixture,
  MATRIX_FIXTURE_VERSION,
  DEFAULT_MATRIX_FACTORS,
  type MatrixFixture,
  type MatrixFixtureUser,
} from './fixture.js';

/**
 * A persona that sends Amplify's `ssr: true` cookies, the way a signed-in browser does.
 * Use `username` = the token's `username` claim.
 */
export function amplifyCookiePersona(input: {
  clientId: string;
  username: string;
  accessToken: string;
  idToken?: string;
}): PersonaDefinition {
  const names = amplifyCookieNames(input.clientId, input.username);
  const pairs = [`${names.lastAuthUser}=${encodeURIComponent(input.username)}`, `${names.accessToken}=${input.accessToken}`];
  if (input.idToken && names.idToken) pairs.push(`${names.idToken}=${input.idToken}`);
  return { headers: { cookie: pairs.join('; ') } };
}

/** A scripted stand-in for Cognito: per-username factors and live state, and a log of calls. */
export interface FakeCognito extends CognitoGateway {
  calls: { method: 'getUserAuthFactors' | 'getLiveUserState'; username: string }[];
  setFactors(username: string, factors: UserAuthFactors | Error): void;
  setLiveState(username: string, state: LiveUserState | Error): void;
}

/**
 * Defaults: everyone has a password and an authenticator, and is enabled with no groups. Script
 * exceptions per username, including thrown errors (to test "couldn't check").
 */
export function createFakeCognito(): FakeCognito {
  const factors = new Map<string, UserAuthFactors | Error>();
  const live = new Map<string, LiveUserState | Error>();
  const calls: FakeCognito['calls'] = [];
  return {
    calls,
    setFactors: (username, value) => void factors.set(username, value),
    setLiveState: (username, value) => void live.set(username, value),
    getUserAuthFactors({ username }) {
      calls.push({ method: 'getUserAuthFactors', username });
      const value = factors.get(username) ?? { configured: ['PASSWORD'], mfa: ['SOFTWARE_TOKEN_MFA'] };
      return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
    },
    getLiveUserState(username) {
      calls.push({ method: 'getLiveUserState', username });
      const value = live.get(username) ?? { enabled: true, groups: [] };
      return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
    },
  };
}
