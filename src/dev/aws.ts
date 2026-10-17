/**
 * Which pool, region, and AWS credentials the dev kit uses. Nothing here guesses an account: the
 * caller names a profile (or exports credentials on purpose), and the pool's ARN says which account
 * it lives in before anything is written.
 */
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { type AmplifyOutputsAuth, resolvePoolConfig } from '../server/config.js';

export interface DevPoolConfig {
  userPoolId: string;
  clientId: string;
  region: string;
}

export interface DevPoolInput {
  /** `amplify_outputs.json` (its `auth` block). */
  outputs?: AmplifyOutputsAuth;
  userPoolId?: string;
  clientId?: string;
  /** Must match the pool ID's region when given. */
  region?: string;
}

/** The pool, client, and region, from explicit values or `amplify_outputs.json`. Refuses a region mismatch. */
export function devPoolConfig(input: DevPoolInput): DevPoolConfig {
  const userPoolId = input.userPoolId ?? input.outputs?.auth?.user_pool_id;
  const clientId = input.clientId ?? input.outputs?.auth?.user_pool_client_id;
  if (!userPoolId || !clientId) {
    throw new Error('auth-kit: no user pool. Pass amplify_outputs.json (run `npx ampx sandbox` first) or a pool and client ID.');
  }
  const resolved = resolvePoolConfig({ userPoolId, clientId });
  const region = input.region ?? input.outputs?.auth?.aws_region ?? resolved.region;
  if (region !== resolved.region) {
    throw new Error(`auth-kit: pool ${userPoolId} is in ${resolved.region}, but the region given is ${region}.`);
  }
  return { userPoolId, clientId, region };
}

export interface CredentialChoice {
  /** The named profile, when one is used. */
  profile?: string;
  /** How the credentials were chosen, for logs (never the credentials themselves). */
  source: string;
}

/**
 * Refuses to fall back to whatever default credentials happen to be around. Accepts an explicit
 * profile, `AWS_PROFILE`, or credentials exported in the environment on purpose.
 */
export function chooseCredentials(
  profile: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): CredentialChoice {
  if (profile) return { profile, source: `profile "${profile}"` };
  if (env.AWS_PROFILE) return { profile: env.AWS_PROFILE, source: `profile "${env.AWS_PROFILE}" (AWS_PROFILE)` };
  if (env.AWS_ACCESS_KEY_ID) return { source: 'credentials exported in the environment (AWS_ACCESS_KEY_ID)' };
  throw new Error(
    "auth-kit: won't guess which AWS account to use. Pass --profile <name> (or set AWS_PROFILE) for the account that holds your sandbox.",
  );
}

/** A Cognito client for the dev kit. */
export function createDevCognitoClient(input: { region: string; profile?: string }): CognitoIdentityProviderClient {
  return new CognitoIdentityProviderClient({ region: input.region, ...(input.profile !== undefined && { profile: input.profile }) });
}

/** The account ID in an ARN (`arn:aws:cognito-idp:<region>:<account>:userpool/<id>`). */
export function accountFromArn(arn: string | undefined): string | undefined {
  const account = arn?.split(':')[4];
  return account && /^\d{12}$/.test(account) ? account : undefined;
}
