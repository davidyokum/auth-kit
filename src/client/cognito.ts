/**
 * Two Cognito calls Amplify v6 doesn't offer, made the way Amplify makes its own: a JSON POST to the
 * pool's regional endpoint, authorized by the person's access token (no AWS credentials involved).
 *
 * - `GetUserAuthFactors`: which first factors and MFA a person has. Amplify has no wrapper.
 * - `ChangePassword` without `PreviousPassword`: Cognito allows it for someone who has no password
 *   yet (a fresh emailed-code invite), but Amplify's `updatePassword` refuses an empty old password.
 */
import { Amplify } from 'aws-amplify';
import { fetchAuthSession } from 'aws-amplify/auth';
import type { ClientAuthFactors } from './ladder.js';

/** A Cognito error, named like Amplify's service errors so `describeAuthError` reads both alike. */
export class CognitoRequestError extends Error {
  constructor(name: string, message: string) {
    super(message || name);
    this.name = name;
  }
}

function endpoint(): string {
  const cognito = Amplify.getConfig().Auth?.Cognito;
  const userPoolId = cognito?.userPoolId;
  if (!userPoolId) {
    throw new CognitoRequestError('AuthConfigException', 'auth-kit: Amplify is not configured. Call configureAuthClient(outputs, ...) first.');
  }
  if (cognito.userPoolEndpoint) return cognito.userPoolEndpoint;
  const region = userPoolId.split('_')[0];
  return `https://cognito-idp.${region}.amazonaws.com/`;
}

async function accessToken(): Promise<string> {
  const { tokens } = await fetchAuthSession();
  const token = tokens?.accessToken?.toString();
  if (!token) throw new CognitoRequestError('UserUnAuthenticatedException', 'Not signed in.');
  return token;
}

async function call(operation: 'GetUserAuthFactors' | 'ChangePassword', body: Record<string, string>): Promise<Record<string, unknown>> {
  const url = endpoint();
  const AccessToken = await accessToken();
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': `AWSCognitoIdentityProviderService.${operation}`,
      },
      body: JSON.stringify({ AccessToken, ...body }),
      cache: 'no-store',
    });
  } catch (error) {
    throw new CognitoRequestError('NetworkError', error instanceof Error ? error.message : 'Network error');
  }
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // A non-JSON body (a proxy's error page) still fails below on the status.
  }
  if (!response.ok) {
    const type = typeof json.__type === 'string' ? json.__type : `HTTP${response.status}`;
    const message = typeof json.message === 'string' ? json.message : typeof json.Message === 'string' ? json.Message : '';
    throw new CognitoRequestError(type.split('#').pop() ?? type, message);
  }
  return json;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** The signed-in person's sign-in factors (Cognito `GetUserAuthFactors`). */
export async function fetchAuthFactors(): Promise<ClientAuthFactors> {
  const out = await call('GetUserAuthFactors', {});
  return { configured: strings(out.ConfiguredUserAuthFactors), mfa: strings(out.UserMFASettingList) };
}

/** `ChangePassword` with no previous password: the first password for someone who joined by emailed code. */
export async function changePasswordWithoutPrevious(newPassword: string): Promise<void> {
  await call('ChangePassword', { ProposedPassword: newPassword });
}
