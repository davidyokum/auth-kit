/**
 * Mocks for `aws-amplify`, `aws-amplify/auth`, `aws-amplify/auth/cognito`, and `aws-amplify/utils`.
 * No test reaches AWS. In a test file:
 *
 *   vi.mock('aws-amplify/auth', async () => (await import('./amplify-mock.js')).authModule);
 */
import { type Mock, vi } from 'vitest';

// Loosely typed on purpose: tests feed these Amplify-shaped values and read their calls back.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = Mock<(...args: any[]) => any>;

export const auth: Record<
  | 'signIn' | 'confirmSignIn' | 'signOut' | 'getCurrentUser' | 'fetchAuthSession' | 'resetPassword' | 'confirmResetPassword'
  | 'associateWebAuthnCredential' | 'listWebAuthnCredentials' | 'deleteWebAuthnCredential' | 'setUpTOTP' | 'verifyTOTPSetup'
  | 'updateMFAPreference' | 'fetchMFAPreference' | 'fetchUserAttributes' | 'updatePassword' | 'updateUserAttributes',
  AnyMock
> = {
  signIn: vi.fn(),
  confirmSignIn: vi.fn(),
  signOut: vi.fn(),
  getCurrentUser: vi.fn(),
  fetchAuthSession: vi.fn(),
  resetPassword: vi.fn(),
  confirmResetPassword: vi.fn(),
  associateWebAuthnCredential: vi.fn(),
  listWebAuthnCredentials: vi.fn(),
  deleteWebAuthnCredential: vi.fn(),
  setUpTOTP: vi.fn(),
  verifyTOTPSetup: vi.fn(),
  updateMFAPreference: vi.fn(),
  fetchMFAPreference: vi.fn(),
  fetchUserAttributes: vi.fn(),
  updatePassword: vi.fn(),
  updateUserAttributes: vi.fn(),
};

export const authModule: typeof auth = auth;

export const Amplify: { configure: AnyMock; getConfig: AnyMock } = {
  configure: vi.fn(),
  getConfig: vi.fn(),
};

export const amplifyModule: { Amplify: typeof Amplify } = { Amplify };

export const cognitoUserPoolsTokenProvider: { setKeyValueStorage: AnyMock } = { setKeyValueStorage: vi.fn() };

export const cognitoModule: { cognitoUserPoolsTokenProvider: typeof cognitoUserPoolsTokenProvider } = { cognitoUserPoolsTokenProvider };

export class CookieStorage {
  constructor(readonly options: Record<string, unknown>) {}
}

export const utilsModule = { CookieStorage };

/** An error shaped like Amplify's service errors (name = the Cognito exception). */
export function awsError(name: string, message: string = name): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

export const SIGNED_IN = { isSignedIn: true, nextStep: { signInStep: 'DONE' } } as const;

export function next(nextStep: Record<string, unknown>) {
  return { isSignedIn: false, nextStep };
}

export const TEST_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

/** Puts every mock back to a signed-out, happy-path default. */
export function resetAmplifyMocks(): void {
  for (const fn of Object.values(auth)) fn.mockReset();
  Amplify.configure.mockReset();
  Amplify.getConfig.mockReset();
  cognitoUserPoolsTokenProvider.setKeyValueStorage.mockReset();
  Amplify.getConfig.mockReturnValue({ Auth: { Cognito: { userPoolId: 'us-east-1_TestPool1', userPoolClientId: 'testclient0000000000000000' } } });
  auth.signOut.mockResolvedValue(undefined);
  auth.getCurrentUser.mockResolvedValue({ userId: 'user-1', username: 'user-1', signInDetails: { loginId: 'ada@example.org' } });
  auth.fetchAuthSession.mockResolvedValue({ tokens: { accessToken: { toString: () => 'test-access-token' } } });
  auth.fetchUserAttributes.mockResolvedValue({ email: 'ada@example.org' });
  auth.setUpTOTP.mockResolvedValue({ sharedSecret: TEST_SECRET, getSetupUri: () => new URL('otpauth://totp/x') });
  auth.verifyTOTPSetup.mockResolvedValue(undefined);
  auth.updateMFAPreference.mockResolvedValue(undefined);
  auth.associateWebAuthnCredential.mockResolvedValue(undefined);
  auth.deleteWebAuthnCredential.mockResolvedValue(undefined);
  auth.listWebAuthnCredentials.mockResolvedValue({ credentials: [] });
  auth.fetchMFAPreference.mockResolvedValue({});
  auth.updatePassword.mockResolvedValue(undefined);
  auth.updateUserAttributes.mockResolvedValue({});
  auth.confirmResetPassword.mockResolvedValue(undefined);
  auth.resetPassword.mockResolvedValue({
    isPasswordReset: false,
    nextStep: { resetPasswordStep: 'CONFIRM_RESET_PASSWORD_WITH_CODE', codeDeliveryDetails: { destination: 'a***@e***' } },
  });
}
