/**
 * Plain-language messages for everything Amplify, Cognito, WAF, or the browser can throw during
 * sign-in and account changes. Rules:
 * - never say whether an account exists (wrong email and wrong password read the same);
 * - say when to wait (rate limits, WAF) instead of inviting more guesses;
 * - say what to do next.
 */

export type AuthErrorKind =
  /** Wrong email/password combination, or an account that can't sign in. Never says which. */
  | 'bad-credentials'
  | 'wrong-code'
  | 'expired-code'
  /** The 3-minute sign-in session ran out: start again. */
  | 'session-expired'
  | 'rate-limited'
  | 'password-rejected'
  | 'passkey-cancelled'
  | 'passkey-unavailable'
  | 'passkey-exists'
  | 'method-unavailable'
  | 'reset-required'
  | 'signed-out'
  | 'network'
  | 'unknown';

export interface AuthErrorInfo {
  kind: AuthErrorKind;
  /** Shown to the person. */
  message: string;
  /** The underlying error name, for logs and tests. */
  name: string;
}

export type AuthErrorContext =
  | 'sign-in'
  | 'code'
  | 'totp'
  | 'change-password'
  | 'set-password'
  | 'reset-password'
  | 'passkey-register'
  | 'passkey-remove'
  | 'authenticator-setup'
  | 'account';

const RATE_LIMITED = 'Too many attempts. Wait a few minutes, then try again.';

function errorName(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'name' in error && typeof error.name === 'string') return error.name;
  return '';
}

function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') return error.message;
  return '';
}

function underlying(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'underlyingError' in error ? error.underlyingError : undefined;
}

function info(kind: AuthErrorKind, message: string, name: string): AuthErrorInfo {
  return { kind, message, name };
}

/** Turns any thrown value into a message for the person. */
export function describeAuthError(error: unknown, context: AuthErrorContext = 'sign-in'): AuthErrorInfo {
  const name = errorName(error);
  const message = errorMessage(error);

  switch (name) {
    case 'NotAuthorizedException':
      if (/session.*expired|invalid session/i.test(message)) {
        return info('session-expired', 'That took longer than 3 minutes, so the sign-in timed out. Start again.', name);
      }
      if (/attempts exceeded|too many/i.test(message)) return info('rate-limited', RATE_LIMITED, name);
      if (context === 'change-password') return info('bad-credentials', "Your current password isn't right.", name);
      if (context === 'code' || context === 'totp') {
        return info('wrong-code', "That code didn't work. Check it and try again, or start over.", name);
      }
      if (context === 'account' || context === 'passkey-register' || context === 'passkey-remove' || context === 'set-password' || context === 'authenticator-setup') {
        return info('signed-out', 'Your session has ended. Sign in again to make changes.', name);
      }
      // Wrong password, unknown account, disabled account: one message, so nobody learns which.
      return info(
        'bad-credentials',
        "That email and password don't match. Try again, or choose another way to sign in. If this keeps happening, contact the site's admin.",
        name,
      );
    case 'UserNotFoundException':
      return info(
        'bad-credentials',
        "That email and password don't match. Try again, or choose another way to sign in. If this keeps happening, contact the site's admin.",
        name,
      );
    case 'CodeMismatchException':
    case 'EnableSoftwareTokenMFAException':
      return info(
        'wrong-code',
        context === 'totp' || context === 'authenticator-setup'
          ? "That code isn't right. Use the current 6-digit code from your authenticator."
          : "That code isn't right. Check it and try again.",
        name,
      );
    case 'ExpiredCodeException':
      return info('expired-code', 'That code has expired. Ask for a new one.', name);
    // AWS WAF's per-IP rate rule answers with ForbiddenException.
    case 'LimitExceededException':
    case 'TooManyRequestsException':
    case 'TooManyFailedAttemptsException':
    case 'ForbiddenException':
      return info('rate-limited', RATE_LIMITED, name);
    case 'InvalidPasswordException':
    case 'PasswordHistoryPolicyViolationException':
      return info(
        'password-rejected',
        /compromised|breach|pwned/i.test(message)
          ? 'That password has appeared in a data breach. Choose a different one; a password manager can make one for you.'
          : "That password wasn't accepted. Use at least 15 characters, and one you haven't used before.",
        name,
      );
    case 'PasswordResetRequiredException':
      return info('reset-required', 'You need to choose a new password. We can email you a code to do that.', name);
    case 'PasskeyAuthenticationCanceled':
    case 'PasskeyRegistrationCanceled':
    case 'PasskeyOperationAborted':
      return info(
        'passkey-cancelled',
        context === 'passkey-register'
          ? "The passkey wasn't saved. Try again when you're ready."
          : 'The passkey prompt closed before signing in. Try again, or choose another way to sign in.',
        name,
      );
    case 'PasskeyNotSupported':
      return info('passkey-unavailable', "This browser can't use passkeys here. Choose another way to sign in.", name);
    case 'RelyingPartyMismatch':
    case 'WebAuthnRelyingPartyMismatchException':
    case 'WebAuthnOriginNotAllowedException':
      return info('passkey-unavailable', "Passkeys aren't set up for this web address yet.", name);
    case 'PasskeyRetrievalFailed':
    case 'PasskeyRegistrationFailed':
    case 'InvalidPasskeyAuthenticationOptions':
    case 'InvalidPasskeyRegistrationOptions':
    case 'WebAuthnChallengeNotFoundException':
    case 'WebAuthnCredentialNotSupportedException':
      return info(
        'passkey-unavailable',
        context === 'passkey-register' ? "The passkey couldn't be saved. Try again." : "That passkey didn't work. Try again, or choose another way to sign in.",
        name,
      );
    case 'PasskeyAlreadyExists':
    case 'WebAuthnCredentialAlreadyExistsException':
      return info('passkey-exists', 'This device already has a passkey for your account.', name);
    case 'WebAuthnNotEnabledException':
    case 'WebAuthnConfigurationMissingException':
    case 'WebAuthnClientMismatchException':
    case 'InvalidPreferredChallenge':
      return info('method-unavailable', "That sign-in method isn't turned on for this site. Choose another way to sign in.", name);
    case 'UserUnAuthenticatedException':
      return info('signed-out', 'Your session has ended. Sign in again to continue.', name);
    case 'NetworkError':
      return info('network', "Couldn't reach the sign-in service. Check your connection and try again.", name);
    default:
      break;
  }
  if (error instanceof TypeError || errorName(underlying(error)) === 'TypeError' || errorName(underlying(error)) === 'NetworkError') {
    return info('network', "Couldn't reach the sign-in service. Check your connection and try again.", name || 'NetworkError');
  }
  return info('unknown', 'Something went wrong. Try again in a moment.', name || 'Error');
}
