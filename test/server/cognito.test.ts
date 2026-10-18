import type { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { describe, expect, it } from 'vitest';
import {
  AuthUnavailableError,
  UnauthenticatedError,
  createCognitoGateway,
  needsTotpEnrollment,
} from '../../src/server/index.js';

type Sent = { name: string; input: Record<string, unknown> };

/** A stand-in SDK client: records each command and answers from a script. No AWS calls. */
function fakeClient(answer: (sent: Sent) => unknown): { client: CognitoIdentityProviderClient; sent: Sent[] } {
  const sent: Sent[] = [];
  const client = {
    send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      const s = { name: command.constructor.name, input: command.input };
      sent.push(s);
      try {
        return Promise.resolve(answer(s));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  } as unknown as CognitoIdentityProviderClient;
  return { client, sent };
}

function awsError(name: string, message = name): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe('createCognitoGateway', () => {
  it("reads factors with the person's own token by default", async () => {
    const { client, sent } = fakeClient(() => ({ ConfiguredUserAuthFactors: ['PASSWORD'], UserMFASettingList: ['SOFTWARE_TOKEN_MFA'] }));
    const gateway = createCognitoGateway({ region: 'us-east-1', userPoolId: 'us-east-1_TestPool1', client });
    expect(await gateway.getUserAuthFactors({ accessToken: 'AT', username: 'u' })).toEqual({ configured: ['PASSWORD'], mfa: ['SOFTWARE_TOKEN_MFA'] });
    expect(sent).toEqual([{ name: 'GetUserAuthFactorsCommand', input: { AccessToken: 'AT' } }]);
  });

  it('reads factors with IAM when configured', async () => {
    const { client, sent } = fakeClient(() => ({}));
    const gateway = createCognitoGateway({ region: 'us-east-1', userPoolId: 'us-east-1_TestPool1', client, factorLookup: 'iam' });
    expect(await gateway.getUserAuthFactors({ accessToken: 'AT', username: 'u' })).toEqual({ configured: [], mfa: [] });
    expect(sent[0]).toEqual({ name: 'AdminGetUserAuthFactorsCommand', input: { UserPoolId: 'us-east-1_TestPool1', Username: 'u' } });
  });

  it('reads live status and pages through every group', async () => {
    const { client, sent } = fakeClient(({ name, input }) => {
      if (name === 'AdminGetUserCommand') return { Enabled: true, UserStatus: 'CONFIRMED' };
      return input.NextToken
        ? { Groups: [{ GroupName: 'reviewer' }] }
        : { Groups: [{ GroupName: 'admin-content-people' }, {}], NextToken: 'page2' };
    });
    const gateway = createCognitoGateway({ region: 'us-east-1', userPoolId: 'us-east-1_TestPool1', client });
    expect(await gateway.getLiveUserState('u')).toEqual({ enabled: true, status: 'CONFIRMED', groups: ['admin-content-people', 'reviewer'] });
    expect(sent.map((s) => s.name)).toEqual(['AdminGetUserCommand', 'AdminListGroupsForUserCommand', 'AdminListGroupsForUserCommand']);
  });

  it('reports a disabled user as not enabled', async () => {
    const { client } = fakeClient(({ name }) => (name === 'AdminGetUserCommand' ? { Enabled: false } : { Groups: [] }));
    const gateway = createCognitoGateway({ region: 'us-east-1', userPoolId: 'us-east-1_TestPool1', client });
    expect((await gateway.getLiveUserState('u')).enabled).toBe(false);
  });

  it.each([
    [awsError('NotAuthorizedException', 'Access Token has been revoked'), UnauthenticatedError, 'invalid_token'],
    [awsError('NotAuthorizedException', 'User is disabled.'), UnauthenticatedError, 'account_disabled'],
    [awsError('UserNotFoundException'), UnauthenticatedError, 'invalid_token'],
    [awsError('TooManyRequestsException'), AuthUnavailableError, 'auth_unavailable'],
    [awsError('InternalErrorException'), AuthUnavailableError, 'auth_unavailable'],
    [new Error('socket hang up'), AuthUnavailableError, 'auth_unavailable'],
  ])('maps %s', async (error, type, code) => {
    const { client } = fakeClient(() => {
      throw error;
    });
    const gateway = createCognitoGateway({ region: 'us-east-1', userPoolId: 'us-east-1_TestPool1', client });
    const failure = await gateway.getUserAuthFactors({ accessToken: 'AT', username: 'u' }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(type);
    expect((failure as { code: string }).code).toBe(code);
  });
});

describe('needsTotpEnrollment', () => {
  it.each([
    [{ configured: ['PASSWORD'], mfa: [] }, true],
    [{ configured: ['PASSWORD', 'EMAIL_OTP'], mfa: [] }, true],
    [{ configured: ['PASSWORD'], mfa: ['SOFTWARE_TOKEN_MFA'] }, false],
    [{ configured: ['PASSWORD', 'SOFTWARE_TOKEN'], mfa: [] }, false],
    [{ configured: ['WEB_AUTHN'], mfa: [] }, false],
    [{ configured: ['EMAIL_OTP'], mfa: [] }, false],
    [{ configured: [], mfa: [] }, false],
  ])('%j -> %s', (factors, needs) => {
    expect(needsTotpEnrollment(factors)).toBe(needs);
  });
});
