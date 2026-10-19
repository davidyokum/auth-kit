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
    expect(unknown.reason).toMatch(/couldn’t confirm/i);
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

  it('says the approved words for a wrong password, whatever the cause', () => {
    for (const error of [
      awsError('NotAuthorizedException', 'Incorrect username or password.'),
      awsError('UserNotFoundException', 'User does not exist.'),
      awsError('NotAuthorizedException', 'User is disabled.'),
    ]) {
      expect(describeAuthError(error, 'sign-in').message).toBe('That email address and password don’t match. Try again, or use another way to sign in.');
    }
  });

  it('tells people to wait when rate-limited, including by WAF and by password lockout', () => {
    for (const name of ['ForbiddenException', 'LimitExceededException', 'TooManyRequestsException', 'TooManyFailedAttemptsException']) {
      expect(describeAuthError(awsError(name)).message).toBe('Too many attempts from this network. Wait 5 minutes, then try again.');
    }
    const lockout = describeAuthError(awsError('NotAuthorizedException', 'Password attempts exceeded'));
    expect(lockout.kind).toBe('rate-limited');
    expect(lockout.message).toBe('Too many attempts from this network. Wait 5 minutes, then try again.');
  });

  it('spots an expired sign-in session and names the code lifetime (default 10 minutes)', () => {
    const expired = awsError('NotAuthorizedException', 'Invalid session for the user, session is expired.');
    const info = describeAuthError(expired, 'code');
    expect(info.kind).toBe('session-expired');
    expect(info.message).toBe('That took longer than 10 minutes, so we stopped the sign-in to keep your account safe. Start again.');
    expect(describeAuthError(expired, 'totp', { codeLifetimeMinutes: 10 }).message).toBe(
      'That took longer than 10 minutes, so we stopped the sign-in to keep your account safe. Start again.',
    );
  });

  it('words a wrong emailed code with the site’s name, and a wrong authenticator code with what to do', () => {
    for (const error of [awsError('CodeMismatchException'), awsError('NotAuthorizedException', 'Incorrect username or password.')]) {
      expect(describeAuthError(error, 'code', { siteName: 'Example Reports' }).message).toBe('That code didn’t work. Check it against the newest email from Example Reports.');
      expect(describeAuthError(error, 'code').message).toBe('That code didn’t work. Check it against the newest email from this site.');
    }
    const wrongTotp = 'That code didn’t work. Codes change every 30 seconds, so enter the newest one.';
    expect(describeAuthError(awsError('CodeMismatchException'), 'totp').message).toBe(wrongTotp);
    expect(describeAuthError(awsError('NotAuthorizedException', 'Invalid code'), 'totp').message).toBe(wrongTotp);
    expect(describeAuthError(awsError('EnableSoftwareTokenMFAException'), 'authenticator-setup').message).toBe(wrongTotp);
    expect(describeAuthError(awsError('ExpiredCodeException'), 'code').message).toBe('That code has expired. Ask for a new one.');
  });

  it('words errors for their context', () => {
    expect(describeAuthError(awsError('NotAuthorizedException', 'Incorrect username or password.'), 'change-password').message).toBe("Your current password isn’t right.");
    expect(describeAuthError(awsError('InvalidPasswordException', 'Password is compromised')).message).toBe(
      'This password has appeared in a data breach, so it isn’t safe to use. Choose a different one.',
    );
    expect(describeAuthError(awsError('PasskeyRegistrationCanceled'), 'passkey-register').message).toBe('We couldn’t create your passkey. Try again, or use a password instead.');
    expect(describeAuthError(awsError('PasskeyAuthenticationCanceled'), 'sign-in').message).toBe('We didn’t get a passkey. Try again, or use another way below.');
    expect(describeAuthError(awsError('PasskeyNotSupported'), 'sign-in').message).toBe('This browser can’t use passkeys here. Use another way below.');
  });

  it('treats a failed fetch as a network problem, and names the help address when it has one', () => {
    expect(describeAuthError(new TypeError('Failed to fetch')).kind).toBe('network');
    expect(describeAuthError({ name: 'Unknown', underlyingError: new TypeError('x') }).kind).toBe('network');
    expect(describeAuthError('weird').kind).toBe('unknown');
    expect(describeAuthError(new TypeError('Failed to fetch')).message).toBe('We couldn’t reach the sign-in service. Check your connection and try again.');
    expect(describeAuthError(awsError('NetworkError'), 'sign-in', { helpAddress: 'apps-help@example.org' }).message).toBe(
      'We couldn’t reach the sign-in service. Check your connection and try again. If it keeps happening, email apps-help@example.org.',
    );
  });
});
