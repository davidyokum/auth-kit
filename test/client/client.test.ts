import { describe, expect, it } from 'vitest';
import {
  afterSignInStep,
  buildOtpauthUri,
  canRemovePasskey,
  describeAuthError,
  formatSetupKey,
  methodsFromChallenges,
  needsAuthenticator,
  newPasswordProblem,
  normalizeCode,
  SIGN_IN_AUTOCOMPLETE,
  SIGN_IN_METHODS,
  toSignInStep,
} from '../../src/client/index.js';
import { needsTotpEnrollment } from '../../src/server/index.js';
import { awsError, next, SIGNED_IN, TEST_SECRET } from './amplify-mock.js';

describe('sign-in ladder and autocomplete', () => {
  it('orders methods best first', () => {
    expect(SIGN_IN_METHODS).toEqual(['passkey', 'password', 'email-code']);
  });

  it('marks fields so password managers work', () => {
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
    [{ configured: ['PASSWORD', 'WEB_AUTHN'], mfa: ['SOFTWARE_TOKEN_MFA'] }, on, 'done'],
  ] as const)('%j (%j) -> %s', (factors, options, step) => {
    expect(afterSignInStep(factors, options)).toBe(step);
  });
});

describe('the authenticator rule matches the server', () => {
  const configured = [[], ['PASSWORD'], ['EMAIL_OTP'], ['WEB_AUTHN'], ['PASSWORD', 'WEB_AUTHN'], ['PASSWORD', 'EMAIL_OTP'], ['SOFTWARE_TOKEN']];
  const mfa = [[], ['SOFTWARE_TOKEN_MFA'], ['SMS_MFA']];
  it('needsAuthenticator agrees with auth-kit/server needsTotpEnrollment for every combination', () => {
    for (const c of configured) {
      for (const m of mfa) {
        expect(needsAuthenticator({ configured: c, mfa: m }), `${c.join('+')} / ${m.join('+')}`).toBe(needsTotpEnrollment({ configured: c, mfa: m }));
      }
    }
  });
});

describe('canRemovePasskey (never the last way in)', () => {
  it('allows removing one of several passkeys, even with unknown factors', () => {
    expect(canRemovePasskey({ passkeyCount: 2, factors: null })).toEqual({ allowed: true });
  });

  it('allows removing the last passkey when a password or a usable emailed code remains', () => {
    expect(canRemovePasskey({ passkeyCount: 1, factors: { configured: ['WEB_AUTHN', 'PASSWORD'], mfa: ['SOFTWARE_TOKEN_MFA'] } }).allowed).toBe(true);
    expect(canRemovePasskey({ passkeyCount: 1, factors: { configured: ['WEB_AUTHN', 'EMAIL_OTP'], mfa: [] } }).allowed).toBe(true);
  });

  it('refuses when the passkey is the only way in (an authenticator turns emailed codes off)', () => {
    const only = canRemovePasskey({ passkeyCount: 1, factors: { configured: ['WEB_AUTHN'], mfa: [] } });
    expect(only.allowed).toBe(false);
    expect(only.reason).toMatch(/only way to sign in/);
    expect(canRemovePasskey({ passkeyCount: 1, factors: { configured: ['WEB_AUTHN', 'EMAIL_OTP'], mfa: ['SOFTWARE_TOKEN_MFA'] } }).allowed).toBe(false);
  });

  it('fails closed on the last passkey when factors are unknown', () => {
    const unknown = canRemovePasskey({ passkeyCount: 1, factors: null });
    expect(unknown.allowed).toBe(false);
    expect(unknown.reason).toMatch(/couldn't confirm/i);
  });
});

describe('new passwords: length only, no composition rules', () => {
  it('requires at least 15 characters and at most 256', () => {
    expect(newPasswordProblem('')).toMatch(/Enter a new password/);
    expect(newPasswordProblem('a'.repeat(14))).toMatch(/at least 15/);
    expect(newPasswordProblem('a'.repeat(15))).toBeNull();
    expect(newPasswordProblem('a'.repeat(257))).toMatch(/at most 256/);
  });

  it('accepts all-lowercase, spaces, and emoji (counted as characters)', () => {
    expect(newPasswordProblem('correct horse battery staple')).toBeNull();
    const emoji = String.fromCodePoint(0x1f511);
    expect(newPasswordProblem(emoji.repeat(15))).toBeNull();
    expect(newPasswordProblem(emoji.repeat(14))).toMatch(/at least 15/);
  });

  it('normalizes pasted codes', () => {
    expect(normalizeCode(' 123 456 ')).toBe('123456');
    expect(normalizeCode('1234-5678')).toBe('12345678');
  });
});

describe('authenticator setup link', () => {
  it('encodes the issuer and account and names the issuer twice, as authenticators expect', () => {
    const uri = buildOtpauthUri({ secret: TEST_SECRET, issuer: 'Example Reports', accountName: 'ada@example.org' });
    expect(uri).toBe(`otpauth://totp/Example%20Reports:ada%40example.org?secret=${TEST_SECRET}&issuer=Example%20Reports`);
    const parsed = new URL(uri);
    expect(parsed.searchParams.get('issuer')).toBe('Example Reports');
    expect(parsed.searchParams.get('secret')).toBe(TEST_SECRET);
  });

  it('keeps hostile characters out of the label and query', () => {
    const uri = buildOtpauthUri({ secret: TEST_SECRET, issuer: 'A&B:C#D', accountName: 'x?y@example.org' });
    const parsed = new URL(uri);
    expect(parsed.searchParams.get('issuer')).toBe('A&BC#D');
    expect([...parsed.searchParams.keys()]).toEqual(['secret', 'issuer']);
    expect(decodeURIComponent(parsed.pathname)).toBe('/A&BC#D:x?y@example.org');
  });

  it('groups the setup key in fours', () => {
    expect(formatSetupKey('ABCDEFGHIJ')).toBe('ABCD EFGH IJ');
  });
});

describe('toSignInStep: every step Amplify can return', () => {
  it.each([
    [SIGNED_IN, { step: 'done' }],
    [next({ signInStep: 'DONE' }), { step: 'done' }],
    [
      next({ signInStep: 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION', availableChallenges: ['EMAIL_OTP', 'SMS_OTP', 'PASSWORD_SRP', 'PASSWORD', 'WEB_AUTHN'] }),
      { step: 'choose-method', methods: ['passkey', 'password', 'email-code'] },
    ],
    [next({ signInStep: 'CONFIRM_SIGN_IN_WITH_PASSWORD' }), { step: 'password' }],
    [next({ signInStep: 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE', codeDeliveryDetails: { destination: 'a***@e***' } }), { step: 'email-code', destination: 'a***@e***' }],
    [next({ signInStep: 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE' }), { step: 'email-code' }],
    [next({ signInStep: 'CONFIRM_SIGN_IN_WITH_TOTP_CODE' }), { step: 'totp' }],
    [next({ signInStep: 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED' }), { step: 'new-password', missingAttributes: [] }],
    [next({ signInStep: 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED', missingAttributes: ['name'] }), { step: 'new-password', missingAttributes: ['name'] }],
    [next({ signInStep: 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP', totpSetupDetails: { sharedSecret: TEST_SECRET } }), { step: 'totp-setup', secret: TEST_SECRET }],
    [next({ signInStep: 'CONTINUE_SIGN_IN_WITH_MFA_SELECTION', allowedMFATypes: ['TOTP', 'SMS'] }), { step: 'select-mfa', setup: false, totpAllowed: true }],
    [next({ signInStep: 'CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION', allowedMFATypes: ['EMAIL'] }), { step: 'select-mfa', setup: true, totpAllowed: false }],
    [next({ signInStep: 'RESET_PASSWORD' }), { step: 'reset-password' }],
    [next({ signInStep: 'CONFIRM_SIGN_IN_WITH_SMS_CODE' }), { step: 'unsupported', signInStep: 'CONFIRM_SIGN_IN_WITH_SMS_CODE' }],
    [next({ signInStep: 'CONFIRM_SIGN_IN_WITH_CUSTOM_CHALLENGE' }), { step: 'unsupported', signInStep: 'CONFIRM_SIGN_IN_WITH_CUSTOM_CHALLENGE' }],
    [next({ signInStep: 'CONTINUE_SIGN_IN_WITH_EMAIL_SETUP' }), { step: 'unsupported', signInStep: 'CONTINUE_SIGN_IN_WITH_EMAIL_SETUP' }],
    [next({ signInStep: 'CONFIRM_SIGN_UP' }), { step: 'unsupported', signInStep: 'CONFIRM_SIGN_UP' }],
  ])('%j', (output, expected) => {
    expect(toSignInStep(output as never)).toEqual(expected);
  });

  it('drops challenges the standard does not use', () => {
    expect(methodsFromChallenges(['SMS_OTP'])).toEqual([]);
    expect(methodsFromChallenges(undefined)).toEqual([]);
  });
});

describe('describeAuthError', () => {
  it('reads a wrong password and an unknown account the same (no user enumeration)', () => {
    const wrong = describeAuthError(awsError('NotAuthorizedException', 'Incorrect username or password.'));
    const unknown = describeAuthError(awsError('UserNotFoundException', 'User does not exist.'));
    const disabled = describeAuthError(awsError('NotAuthorizedException', 'User is disabled.'));
    expect(wrong.message).toBe(unknown.message);
    expect(wrong.message).toBe(disabled.message);
    expect(wrong.kind).toBe('bad-credentials');
    expect(wrong.message).not.toMatch(/exist|disabled|no account/i);
  });

  it.each([
    ['LimitExceededException', 'rate-limited'],
    ['TooManyRequestsException', 'rate-limited'],
    ['TooManyFailedAttemptsException', 'rate-limited'],
    ['ForbiddenException', 'rate-limited'],
    ['CodeMismatchException', 'wrong-code'],
    ['EnableSoftwareTokenMFAException', 'wrong-code'],
    ['ExpiredCodeException', 'expired-code'],
    ['InvalidPasswordException', 'password-rejected'],
    ['PasswordResetRequiredException', 'reset-required'],
    ['PasskeyAuthenticationCanceled', 'passkey-cancelled'],
    ['PasskeyRegistrationCanceled', 'passkey-cancelled'],
    ['PasskeyNotSupported', 'passkey-unavailable'],
    ['RelyingPartyMismatch', 'passkey-unavailable'],
    ['PasskeyRetrievalFailed', 'passkey-unavailable'],
    ['PasskeyAlreadyExists', 'passkey-exists'],
    ['WebAuthnNotEnabledException', 'method-unavailable'],
    ['InvalidPreferredChallenge', 'method-unavailable'],
    ['UserUnAuthenticatedException', 'signed-out'],
    ['NetworkError', 'network'],
    ['SomethingNew', 'unknown'],
  ])('%s -> %s', (name, kind) => {
    const result = describeAuthError(awsError(name));
    expect(result.kind).toBe(kind);
    expect(result.name).toBe(name);
    expect(result.message.length).toBeGreaterThan(10);
  });

  it('tells people to wait when rate-limited, including by WAF and by password lockout', () => {
    expect(describeAuthError(awsError('ForbiddenException')).message).toMatch(/Wait a few minutes/);
    expect(describeAuthError(awsError('NotAuthorizedException', 'Password attempts exceeded')).kind).toBe('rate-limited');
  });

  it('spots an expired 3-minute sign-in session', () => {
    const info = describeAuthError(awsError('NotAuthorizedException', 'Invalid session for the user, session is expired.'), 'code');
    expect(info.kind).toBe('session-expired');
    expect(info.message).toMatch(/3 minutes/);
  });

  it('words errors for their context', () => {
    expect(describeAuthError(awsError('NotAuthorizedException', 'Incorrect username or password.'), 'change-password').message).toBe("Your current password isn't right.");
    expect(describeAuthError(awsError('CodeMismatchException'), 'totp').message).toMatch(/authenticator/);
    expect(describeAuthError(awsError('InvalidPasswordException', 'Password is compromised')).message).toMatch(/data breach/);
    expect(describeAuthError(awsError('PasskeyRegistrationCanceled'), 'passkey-register').message).toMatch(/wasn't saved/);
  });

  it('treats a failed fetch as a network problem', () => {
    expect(describeAuthError(new TypeError('Failed to fetch')).kind).toBe('network');
    expect(describeAuthError({ name: 'Unknown', underlyingError: new TypeError('x') }).kind).toBe('network');
    expect(describeAuthError('weird').kind).toBe('unknown');
  });
});
