import { describe, expect, it } from 'vitest';
import {
  afterSignInStep,
  deletePasskey,
  enrollAuthenticator,
  listPasskeys,
  MyAccount,
  NotImplementedError,
  registerPasskey,
  requestEmailCode,
  SIGN_IN_AUTOCOMPLETE,
  SIGN_IN_METHODS,
  signInWithPasskey,
  signInWithPassword,
  signOutEverywhere,
  SignInScreen,
} from '../../src/client/index.js';

describe('sign-in ladder and autocomplete', () => {
  it('orders methods best first', () => {
    expect(SIGN_IN_METHODS).toEqual(['passkey', 'password', 'email-code']);
  });

  it('marks fields so password managers and passkey autofill work', () => {
    expect(SIGN_IN_AUTOCOMPLETE).toEqual({
      email: 'username webauthn',
      currentPassword: 'current-password',
      newPassword: 'new-password',
      oneTimeCode: 'one-time-code',
    });
  });
});

describe('afterSignInStep', () => {
  const on = { passkeysEnabled: true };
  const off = { passkeysEnabled: false };
  it.each([
    [{ configured: ['PASSWORD'], mfa: [] }, on, 'set-up-authenticator'],
    [{ configured: ['PASSWORD', 'WEB_AUTHN'], mfa: [] }, on, 'set-up-authenticator'],
    [{ configured: ['PASSWORD'], mfa: ['SOFTWARE_TOKEN_MFA'] }, on, 'offer-passkey'],
    [{ configured: ['PASSWORD'], mfa: ['SOFTWARE_TOKEN_MFA'] }, off, 'done'],
    [{ configured: ['EMAIL_OTP'], mfa: [] }, on, 'choose-first-credential'],
    [{ configured: ['EMAIL_OTP'], mfa: [] }, off, 'choose-first-credential'],
    [{ configured: ['WEB_AUTHN', 'EMAIL_OTP'], mfa: [] }, on, 'done'],
  ] as const)('%j (%j) -> %s', (factors, options, step) => {
    expect(afterSignInStep(factors, options)).toBe(step);
  });
});

describe('phase-2 stubs', () => {
  it('reject or throw NotImplementedError', async () => {
    for (const call of [
      () => signInWithPasskey(),
      () => signInWithPassword('a@example.org', 'x'),
      () => requestEmailCode('a@example.org'),
      () => enrollAuthenticator(),
      () => registerPasskey(),
      () => listPasskeys(),
      () => deletePasskey('id'),
      () => signOutEverywhere(),
    ]) {
      await expect(call()).rejects.toThrow(NotImplementedError);
    }
    expect(() => SignInScreen({ passkeysEnabled: true, siteName: 'X' })).toThrow(NotImplementedError);
    expect(() => MyAccount({ passkeysEnabled: true })).toThrow(NotImplementedError);
  });
});
