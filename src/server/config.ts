/** The pool and app client an app's tokens must come from. */
export interface PoolConfig {
  /** e.g. `us-east-1_AbCdEf123` (placeholder). */
  userPoolId: string;
  /** The app's own client. Tokens issued to any other client are rejected. */
  clientId: string;
  /**
   * The sign-in mode the deployed pool was built for (ADR 0029), read from `amplify_outputs.json` by
   * `poolConfigFromAmplifyOutputs`: a Simple pool has MFA off, every other kit pool has it on or
   * optional. `createServerAuth` refuses a `signIn` setting that doesn't match it.
   */
  poolSignInMode?: 'full' | 'simple';
}

export interface ResolvedPoolConfig extends PoolConfig {
  region: string;
  issuer: string;
}

const POOL_ID_RE = /^([a-z]{2}(?:-[a-z]+)+-\d+)_[0-9A-Za-z]+$/;
const CLIENT_ID_RE = /^[\w+]{1,128}$/;

export function resolvePoolConfig(config: PoolConfig): ResolvedPoolConfig {
  const match = POOL_ID_RE.exec(config.userPoolId ?? '');
  if (!match?.[1]) {
    throw new Error(`auth-kit: userPoolId "${config.userPoolId}" isn't a Cognito user pool ID (region_id).`);
  }
  if (!CLIENT_ID_RE.test(config.clientId ?? '')) {
    throw new Error('auth-kit: clientId is required and must be a Cognito app client ID.');
  }
  const region = match[1];
  return {
    userPoolId: config.userPoolId,
    clientId: config.clientId,
    region,
    issuer: `https://cognito-idp.${region}.amazonaws.com/${config.userPoolId}`,
  };
}

/** The `auth` block of `amplify_outputs.json`, as far as auth-kit needs it. */
export interface AmplifyOutputsAuth {
  auth?: { user_pool_id?: string; user_pool_client_id?: string; aws_region?: string; mfa_configuration?: string };
}

/**
 * The sign-in mode a kit pool was built for, from `amplify_outputs.json`'s `mfa_configuration`: the
 * preset turns MFA off only on Simple pools (ADR 0029), so `NONE` is Simple, `OPTIONAL` or `REQUIRED`
 * is Full, and anything else (an older outputs file) is unknown.
 */
export function poolSignInModeFromAmplifyOutputs(outputs: AmplifyOutputsAuth): 'full' | 'simple' | undefined {
  const mfa = outputs.auth?.mfa_configuration;
  if (mfa === 'NONE') return 'simple';
  if (mfa === 'OPTIONAL' || mfa === 'REQUIRED') return 'full';
  return undefined;
}

/** Reads the pool and client from `amplify_outputs.json`. */
export function poolConfigFromAmplifyOutputs(outputs: AmplifyOutputsAuth): PoolConfig {
  const userPoolId = outputs.auth?.user_pool_id;
  const clientId = outputs.auth?.user_pool_client_id;
  if (!userPoolId || !clientId) {
    // Fail closed: a missing auth config must never mean "no auth".
    throw new Error('auth-kit: amplify_outputs.json has no auth.user_pool_id / auth.user_pool_client_id.');
  }
  const poolSignInMode = poolSignInModeFromAmplifyOutputs(outputs);
  return { userPoolId, clientId, ...(poolSignInMode !== undefined && { poolSignInMode }) };
}
