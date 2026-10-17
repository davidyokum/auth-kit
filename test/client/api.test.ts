import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chooseSignInMethod,
  CognitoRequestError,
  completeNewPassword,
  configureAuthClient,
  confirmCode,
  confirmPassword,
  confirmPasswordReset,
  deletePasskey,
  enrollAuthenticator,
  fetchAuthFactors,
  hasAuthenticator,
  isBreachedPassword,
  listPasskeys,
  requestEmailCode,
  requestPasswordReset,
  setFirstPassword,
  signInWithPasskey,
  signInWithPassword,
  signOutEverywhere,
} from '../../src/client/index.js';
import { Amplify, auth, awsError, cognitoUserPoolsTokenProvider, CookieStorage, next, resetAmplifyMocks, SIGNED_IN, TEST_SECRET } from './amplify-mock.js';

vi.mock('aws-amplify', async () => (await import('./amplify-mock.js')).amplifyModule);
vi.mock('aws-amplify/auth', async () => (await import('./amplify-mock.js')).authModule);
vi.mock('aws-amplify/auth/cognito', async () => (await import('./amplify-mock.js')).cognitoModule);
vi.mock('aws-amplify/utils', async () => (await import('./amplify-mock.js')).utilsModule);

beforeEach(() => resetAmplifyMocks());
afterEach(() => vi.unstubAllGlobals());

describe('sign-in calls use USER_AUTH with the right preferred challenge', () => {
  it('passkey first', async () => {
    auth.signIn.mockResolvedValue(SIGNED_IN);
    await expect(signInWithPasskey(' ada@example.org ')).resolves.toEqual({ step: 'done' });
    expect(auth.signIn).toHaveBeenCalledWith({ username: 'ada@example.org', options: { authFlowType: 'USER_AUTH', preferredChallenge: 'WEB_AUTHN' } });
  });

  it('password (plain PASSWORD, so Cognito threat protection can check it), then TOTP', async () => {
    auth.signIn.mockResolvedValue(next({ signInStep: 'CONFIRM_SIGN_IN_WITH_TOTP_CODE' }));
    await expect(signInWithPassword('ada@example.org', 'pw')).resolves.toEqual({ step: 'totp' });
    expect(auth.signIn).toHaveBeenCalledWith({
      username: 'ada@example.org',
      password: 'pw',
      options: { authFlowType: 'USER_AUTH', preferredChallenge: 'PASSWORD' },
    });
    auth.confirmSignIn.mockResolvedValue(SIGNED_IN);
    await expect(confirmCode(' 123 456 ')).resolves.toEqual({ step: 'done' });
    expect(auth.confirmSignIn).toHaveBeenCalledWith({ challengeResponse: '123456' });
  });

  it('emailed code', async () => {
    auth.signIn.mockResolvedValue(next({ signInStep: 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE', codeDeliveryDetails: { destination: 'a***@e***' } }));
    await expect(requestEmailCode('ada@example.org')).resolves.toEqual({ step: 'email-code', destination: 'a***@e***' });
    expect(auth.signIn.mock.calls[0]![0].options.preferredChallenge).toBe('EMAIL_OTP');
  });

  it('ends an existing local session and retries when Amplify says someone is already signed in (step-up)', async () => {
    auth.signIn.mockRejectedValueOnce(awsError('UserAlreadyAuthenticatedException')).mockResolvedValueOnce(SIGNED_IN);
    await expect(signInWithPasskey('ada@example.org')).resolves.toEqual({ step: 'done' });
    expect(auth.signOut).toHaveBeenCalledWith();
    expect(auth.signIn).toHaveBeenCalledTimes(2);
  });

  it('passes other errors through', async () => {
    auth.signIn.mockRejectedValue(awsError('PasskeyAuthenticationCanceled'));
    await expect(signInWithPasskey('ada@example.org')).rejects.toThrow('PasskeyAuthenticationCanceled');
    expect(auth.signOut).not.toHaveBeenCalled();
  });
});

describe('challenge answers', () => {
  it('answers SELECT_CHALLENGE in-session with the chosen method', async () => {
    auth.confirmSignIn.mockResolvedValueOnce(next({ signInStep: 'CONFIRM_SIGN_IN_WITH_PASSWORD' }));
    await expect(chooseSignInMethod('password')).resolves.toEqual({ step: 'password' });
    expect(auth.confirmSignIn).toHaveBeenLastCalledWith({ challengeResponse: 'PASSWORD' });

    auth.confirmSignIn.mockResolvedValueOnce(SIGNED_IN);
    await chooseSignInMethod('passkey');
    expect(auth.confirmSignIn).toHaveBeenLastCalledWith({ challengeResponse: 'WEB_AUTHN' });

    auth.confirmSignIn.mockResolvedValueOnce(next({ signInStep: 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE' }));
    await chooseSignInMethod('email-code');
    expect(auth.confirmSignIn).toHaveBeenLastCalledWith({ challengeResponse: 'EMAIL_OTP' });

    auth.confirmSignIn.mockResolvedValueOnce(next({ signInStep: 'CONFIRM_SIGN_IN_WITH_TOTP_CODE' }));
    await expect(confirmPassword('pw')).resolves.toEqual({ step: 'totp' });
    expect(auth.confirmSignIn).toHaveBeenLastCalledWith({ challengeResponse: 'pw' });
  });

  it('answers NEW_PASSWORD_REQUIRED, then MFA_SETUP', async () => {
    auth.confirmSignIn.mockResolvedValueOnce(next({ signInStep: 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP', totpSetupDetails: { sharedSecret: TEST_SECRET } }));
    await expect(completeNewPassword('a long new password')).resolves.toEqual({ step: 'totp-setup', secret: TEST_SECRET });
    expect(auth.confirmSignIn).toHaveBeenLastCalledWith({ challengeResponse: 'a long new password' });
  });

  it('answers an MFA choice with TOTP by itself (the only MFA the standard uses)', async () => {
    auth.confirmSignIn
      .mockResolvedValueOnce(next({ signInStep: 'CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION', allowedMFATypes: ['EMAIL', 'TOTP'] }))
      .mockResolvedValueOnce(next({ signInStep: 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP', totpSetupDetails: { sharedSecret: TEST_SECRET } }));
    await expect(completeNewPassword('a long new password')).resolves.toEqual({ step: 'totp-setup', secret: TEST_SECRET });
    expect(auth.confirmSignIn).toHaveBeenLastCalledWith({ challengeResponse: 'TOTP' });

    auth.signIn.mockResolvedValueOnce(next({ signInStep: 'CONTINUE_SIGN_IN_WITH_MFA_SELECTION', allowedMFATypes: ['TOTP', 'SMS'] }));
    auth.confirmSignIn.mockResolvedValueOnce(next({ signInStep: 'CONFIRM_SIGN_IN_WITH_TOTP_CODE' }));
    await expect(signInWithPassword('ada@example.org', 'pw')).resolves.toEqual({ step: 'totp' });
  });

  it('reports an MFA choice without TOTP as unsupported', async () => {
    auth.signIn.mockResolvedValueOnce(next({ signInStep: 'CONTINUE_SIGN_IN_WITH_MFA_SELECTION', allowedMFATypes: ['SMS'] }));
    await expect(signInWithPassword('ada@example.org', 'pw')).resolves.toEqual({ step: 'unsupported', signInStep: 'CONTINUE_SIGN_IN_WITH_MFA_SELECTION' });
  });
});

describe('password reset', () => {
  it('sends a code and confirms it', async () => {
    await expect(requestPasswordReset('ada@example.org')).resolves.toEqual({ destination: 'a***@e***' });
    await confirmPasswordReset('ada@example.org', '1234 5678', 'a long new password');
    expect(auth.confirmResetPassword).toHaveBeenCalledWith({ username: 'ada@example.org', confirmationCode: '12345678', newPassword: 'a long new password' });
  });

  it('answers the same for unknown or unverified accounts (no enumeration), but still reports rate limits', async () => {
    for (const name of ['UserNotFoundException', 'InvalidParameterException', 'NotAuthorizedException']) {
      auth.resetPassword.mockRejectedValueOnce(awsError(name));
      await expect(requestPasswordReset('nobody@example.org')).resolves.toEqual({});
    }
    auth.resetPassword.mockRejectedValueOnce(awsError('LimitExceededException'));
    await expect(requestPasswordReset('ada@example.org')).rejects.toThrow('LimitExceededException');
  });
});

describe('authenticator', () => {
  it('sets up, verifies, prefers TOTP, and refreshes tokens', async () => {
    const enrollment = await enrollAuthenticator({ issuer: 'Example Reports', accountName: 'ada@example.org', deviceName: 'Phone' });
    expect(enrollment.secret).toBe(TEST_SECRET);
    expect(enrollment.otpauthUri).toContain('otpauth://totp/Example%20Reports:ada%40example.org');
    await enrollment.verify('123 456');
    expect(auth.verifyTOTPSetup).toHaveBeenCalledWith({ code: '123456', options: { friendlyDeviceName: 'Phone' } });
    expect(auth.updateMFAPreference).toHaveBeenCalledWith({ totp: 'PREFERRED' });
    expect(auth.fetchAuthSession).toHaveBeenCalledWith({ forceRefresh: true });
  });

  it('reads whether TOTP is on', async () => {
    auth.fetchMFAPreference.mockResolvedValueOnce({ enabled: ['TOTP'], preferred: 'TOTP' });
    await expect(hasAuthenticator()).resolves.toBe(true);
    auth.fetchMFAPreference.mockResolvedValueOnce({});
    await expect(hasAuthenticator()).resolves.toBe(false);
  });
});

describe('passkeys', () => {
  it('lists every page of the person’s own passkeys', async () => {
    auth.listWebAuthnCredentials
      .mockResolvedValueOnce({
        credentials: [{ credentialId: 'a', friendlyCredentialName: 'MacBook', createdAt: new Date('2026-10-01T00:00:00Z'), authenticatorAttachment: 'platform', relyingPartyId: 'reports.example.org' }],
        nextToken: 't1',
      })
      .mockResolvedValueOnce({ credentials: [{ credentialId: 'b' }, { credentialId: undefined }] });
    await expect(listPasskeys()).resolves.toEqual([
      { id: 'a', friendlyName: 'MacBook', createdAt: '2026-10-01T00:00:00.000Z', authenticatorAttachment: 'platform', relyingPartyId: 'reports.example.org' },
      { id: 'b' },
    ]);
    expect(auth.listWebAuthnCredentials).toHaveBeenLastCalledWith({ pageSize: 20, nextToken: 't1' });
  });

  it('deletes by credential ID', async () => {
    await deletePasskey('a');
    expect(auth.deleteWebAuthnCredential).toHaveBeenCalledWith({ credentialId: 'a' });
  });
});

describe('direct Cognito calls (what Amplify v6 lacks)', () => {
  function stubFetch(status: number, body: unknown) {
    const fetchMock = vi.fn().mockResolvedValue(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('GetUserAuthFactors with the access token, at the pool’s regional endpoint', async () => {
    const fetchMock = stubFetch(200, { ConfiguredUserAuthFactors: ['PASSWORD', 'WEB_AUTHN'], UserMFASettingList: ['SOFTWARE_TOKEN_MFA'], Username: 'x' });
    await expect(fetchAuthFactors()).resolves.toEqual({ configured: ['PASSWORD', 'WEB_AUTHN'], mfa: ['SOFTWARE_TOKEN_MFA'] });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://cognito-idp.us-east-1.amazonaws.com/');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': 'AWSCognitoIdentityProviderService.GetUserAuthFactors' });
    expect(JSON.parse(String(init.body))).toEqual({ AccessToken: 'test-access-token' });
  });

  it('honors a custom user pool endpoint', async () => {
    Amplify.getConfig.mockReturnValue({ Auth: { Cognito: { userPoolId: 'us-east-1_TestPool1', userPoolEndpoint: 'https://cognito.example.org/' } } });
    const fetchMock = stubFetch(200, {});
    await expect(fetchAuthFactors()).resolves.toEqual({ configured: [], mfa: [] });
    expect(fetchMock.mock.calls[0]![0]).toBe('https://cognito.example.org/');
  });

  it('sets a first password with ChangePassword and no PreviousPassword (Amplify’s updatePassword refuses that), then refreshes', async () => {
    const fetchMock = stubFetch(200, '');
    await setFirstPassword('a long new password');
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers['X-Amz-Target']).toBe('AWSCognitoIdentityProviderService.ChangePassword');
    expect(JSON.parse(String(init.body))).toEqual({ AccessToken: 'test-access-token', ProposedPassword: 'a long new password' });
    expect(auth.fetchAuthSession).toHaveBeenLastCalledWith({ forceRefresh: true });
    expect(auth.updatePassword).not.toHaveBeenCalled();
  });

  it('names Cognito errors like Amplify does', async () => {
    stubFetch(400, { __type: 'com.amazonaws.cognito#InvalidPasswordException', message: 'Password does not conform to policy' });
    await expect(setFirstPassword('a long new password')).rejects.toMatchObject({ name: 'InvalidPasswordException', message: 'Password does not conform to policy' });
    stubFetch(400, { __type: 'NotAuthorizedException', message: 'Access Token has been revoked' });
    await expect(fetchAuthFactors()).rejects.toBeInstanceOf(CognitoRequestError);
    stubFetch(502, '<html>bad gateway</html>');
    await expect(fetchAuthFactors()).rejects.toMatchObject({ name: 'HTTP502' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(fetchAuthFactors()).rejects.toMatchObject({ name: 'NetworkError' });
  });

  it('refuses without a session or without Amplify configured', async () => {
    auth.fetchAuthSession.mockResolvedValueOnce({ tokens: undefined });
    await expect(fetchAuthFactors()).rejects.toMatchObject({ name: 'UserUnAuthenticatedException' });
    Amplify.getConfig.mockReturnValue({});
    await expect(fetchAuthFactors()).rejects.toMatchObject({ name: 'AuthConfigException' });
  });
});

describe('configureAuthClient', () => {
  it('configures ssr cookies that expire with the refresh token, SameSite=Lax', () => {
    const outputs = { version: '1.4', auth: { user_pool_id: 'us-east-1_TestPool1' } };
    configureAuthClient(outputs, { refreshTokenMinutes: 30 * 24 * 60 });
    expect(Amplify.configure).toHaveBeenCalledWith(outputs, { ssr: true });
    const storage = cognitoUserPoolsTokenProvider.setKeyValueStorage.mock.calls[0]![0];
    expect(storage).toBeInstanceOf(CookieStorage);
    expect(storage.options).toEqual({ path: '/', sameSite: 'lax', secure: true, expires: 30 });
  });

  it('passes a cookie domain and refuses a missing lifetime', () => {
    configureAuthClient({}, { refreshTokenMinutes: 24 * 60, cookieDomain: 'example.org' });
    expect(cognitoUserPoolsTokenProvider.setKeyValueStorage.mock.calls[0]![0].options).toMatchObject({ expires: 1, domain: 'example.org' });
    expect(() => configureAuthClient({}, { refreshTokenMinutes: 0 })).toThrow(/refreshTokenMinutes/);
  });
});

describe('sign out everywhere', () => {
  it('is a global sign-out', async () => {
    await signOutEverywhere();
    expect(auth.signOut).toHaveBeenCalledWith({ global: true });
  });
});

describe('isBreachedPassword (Have I Been Pwned range API)', () => {
  const password = 'correct horse battery staple';
  const hash = createHash('sha1').update(password).digest('hex').toUpperCase();

  it('sends only the 5-character hash prefix, asks for padding, and finds the suffix', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(`0018A45C4D1DEF81644B54AB7F969B88D65:1\r\n${hash.slice(5)}:42\r\n`));
    await expect(isBreachedPassword(password, fetcher)).resolves.toBe(true);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`);
    expect(url).not.toContain(hash.slice(5));
    expect(init.headers).toEqual({ 'Add-Padding': 'true' });
  });

  it('ignores padding rows (count 0) and absent suffixes', async () => {
    await expect(isBreachedPassword(password, vi.fn().mockResolvedValue(new Response(`${hash.slice(5)}:0\r\n`)))).resolves.toBe(false);
    await expect(isBreachedPassword(password, vi.fn().mockResolvedValue(new Response('ABC:3\r\n')))).resolves.toBe(false);
  });

  it('throws when the check cannot run', async () => {
    await expect(isBreachedPassword(password, vi.fn().mockResolvedValue(new Response('', { status: 503 })))).rejects.toThrow(/503/);
  });
});
