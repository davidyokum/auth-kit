import {
  AdminGetUserAuthFactorsCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  CognitoIdentityProviderClient,
  GetUserAuthFactorsCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { AuthUnavailableError, UnauthenticatedError } from './errors.js';

/** What Cognito says about how a person can sign in. */
export interface UserAuthFactors {
  /** First factors available to them, e.g. `PASSWORD`, `EMAIL_OTP`, `WEB_AUTHN`. */
  configured: readonly string[];
  /** MFA methods turned on for them, e.g. `SOFTWARE_TOKEN_MFA`. */
  mfa: readonly string[];
}

/** A person's live account state, read from Cognito rather than from their token. */
export interface LiveUserState {
  enabled: boolean;
  status?: string;
  groups: readonly string[];
}

/** The Cognito calls auth-kit/server makes. Swap in a fake for tests. */
export interface CognitoGateway {
  getUserAuthFactors(input: { accessToken: string; username: string }): Promise<UserAuthFactors>;
  getLiveUserState(username: string): Promise<LiveUserState>;
}

export interface CognitoGatewayOptions {
  region: string;
  userPoolId: string;
  /**
   * How to read a person's sign-in factors:
   * - `access-token` (default): `GetUserAuthFactors` with their own token. Needs no IAM permission, and
   *   a revoked session or disabled account fails the check at once. It's a public Cognito API, so it
   *   counts toward the pool's WAF per-IP rule from the server's IP address.
   * - `iam`: `AdminGetUserAuthFactors` with the server's role (needs `cognito-idp:AdminGetUserAuthFactors`).
   *   Not inspected by WAF.
   */
  factorLookup?: 'access-token' | 'iam';
  client?: CognitoIdentityProviderClient;
}

function errorName(error: unknown): string {
  return typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '';
}

/** Cognito's "no" means signed out; anything else means we couldn't check. */
function toAuthError(error: unknown): Error {
  const name = errorName(error);
  if (name === 'NotAuthorizedException') {
    return /disabled/i.test(errorMessage(error))
      ? new UnauthenticatedError('account_disabled', 'This account is disabled.', { cause: error })
      : new UnauthenticatedError('invalid_token', 'Your session has ended. Sign in again.', { cause: error });
  }
  if (name === 'UserNotFoundException') {
    return new UnauthenticatedError('invalid_token', 'Your session has ended. Sign in again.', { cause: error });
  }
  return new AuthUnavailableError("Couldn't reach Cognito to check this account.", { cause: error });
}

/** The real gateway, backed by the AWS SDK. Server code uses the SSR compute role, never access keys. */
export function createCognitoGateway(options: CognitoGatewayOptions): CognitoGateway {
  const client = options.client ?? new CognitoIdentityProviderClient({ region: options.region });
  const factorLookup = options.factorLookup ?? 'access-token';

  return {
    async getUserAuthFactors({ accessToken, username }) {
      try {
        const out =
          factorLookup === 'iam'
            ? await client.send(new AdminGetUserAuthFactorsCommand({ UserPoolId: options.userPoolId, Username: username }))
            : await client.send(new GetUserAuthFactorsCommand({ AccessToken: accessToken }));
        return { configured: out.ConfiguredUserAuthFactors ?? [], mfa: out.UserMFASettingList ?? [] };
      } catch (error) {
        throw toAuthError(error);
      }
    },

    async getLiveUserState(username) {
      try {
        const user = await client.send(new AdminGetUserCommand({ UserPoolId: options.userPoolId, Username: username }));
        const groups: string[] = [];
        let nextToken: string | undefined;
        do {
          const page = await client.send(
            new AdminListGroupsForUserCommand({
              UserPoolId: options.userPoolId,
              Username: username,
              Limit: 60,
              NextToken: nextToken,
            }),
          );
          for (const group of page.Groups ?? []) if (group.GroupName) groups.push(group.GroupName);
          nextToken = page.NextToken;
        } while (nextToken);
        return { enabled: user.Enabled === true, ...(user.UserStatus !== undefined && { status: user.UserStatus }), groups };
      } catch (error) {
        throw toAuthError(error);
      }
    },
  };
}

/**
 * True when the account has neither a passkey nor a password: only emailed codes, the backstop
 * (register A1). The standard requires a first credential before the site lets them in.
 */
export function needsFirstCredential(factors: UserAuthFactors): boolean {
  return !factors.configured.includes('PASSWORD') && !factors.configured.includes('WEB_AUTHN');
}

/**
 * True when the person signs in with a password but has no authenticator (TOTP) yet. The standard
 * requires every password user to have one; Cognito can't require it per method, so the app does.
 */
export function needsTotpEnrollment(factors: UserAuthFactors): boolean {
  const hasPassword = factors.configured.includes('PASSWORD');
  const hasTotp = factors.mfa.includes('SOFTWARE_TOKEN_MFA') || factors.configured.includes('SOFTWARE_TOKEN');
  return hasPassword && !hasTotp;
}
