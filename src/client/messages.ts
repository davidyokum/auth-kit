/**
 * Plain-language messages for everything Amplify, Cognito, WAF, or the browser can throw during
 * sign-in and account changes, in the approved words (REPORT §4.4, Card Studio v4; `copy.ts`). Rules:
 * - never say whether an account exists (wrong email and wrong password read the same; ADR 0018);
 * - say when to wait (rate limits, WAF) instead of inviting more guesses;
 * - say what to do next, and name the help address when it can't be fixed here.
 */
import { ERRORS } from './copy.js';
import { CODE_LIFETIME_POLICY } from '../shared/policy.js';

/** The placeholders some messages carry. Each has a sensible default when a caller doesn't pass it. */
export interface MessageWords {
  /** "Check it against the newest email from {Site}". */
  siteName?: string;
  /** "That took longer than {N} minutes". Default 3. */
  codeLifetimeMinutes?: number;
  /** "If it keeps happening, email {help}". */
  helpAddress?: string;
}

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

const RATE_LIMITED = ERRORS.rateLimited;

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
export function describeAuthError(error: unknown, context: AuthErrorContext = 'sign-in', words: MessageWords = {}): AuthErrorInfo {
  const name = errorName(error);
  const message = errorMessage(error);
  const wrongEmailCode = ERRORS.wrongEmailCode({ siteName: words.siteName ?? 'this site' });
  const sessionExpired = ERRORS.sessionExpired({ codeLifetimeMinutes: words.codeLifetimeMinutes ?? CODE_LIFETIME_POLICY.defaultMinutes });
  const network = ERRORS.network(words.helpAddress !== undefined ? { helpAddress: words.helpAddress } : undefined);

  switch (name) {
    case 'NotAuthorizedException':
      if (/session.*expired|invalid session/i.test(message)) {
        return info('session-expired', sessionExpired, name);
      }
      if (/attempts exceeded|too many/i.test(message)) return info('rate-limited', RATE_LIMITED, name);
      if (context === 'change-password') return info('bad-credentials', ERRORS.wrongCurrentPassword, name);
      // An emailed code reads exactly like CodeMismatchException below: whichever of the two Cognito
      // gives (a fake challenge for an unknown address included), the screen is the same (ADR 0018).
      if (context === 'code') return info('wrong-code', wrongEmailCode, name);
      if (context === 'totp') return info('wrong-code', ERRORS.wrongTotp, name);
      if (context === 'account' || context === 'passkey-register' || context === 'passkey-remove' || context === 'set-password' || context === 'authenticator-setup') {
        return info('signed-out', 'Your session has ended. Sign in again to make changes.', name);
      }
      // Wrong password, unknown account, an account with no password, a disabled account: one message, so nobody learns which.
      return info('bad-credentials', ERRORS.wrongPassword, name);
    case 'UserNotFoundException':
      return info('bad-credentials', ERRORS.wrongPassword, name);
    case 'CodeMismatchException':
    case 'EnableSoftwareTokenMFAException':
      return info(
        'wrong-code',
        context === 'totp' || context === 'authenticator-setup' ? ERRORS.wrongTotp : context === 'code' ? wrongEmailCode : 'That code didn’t work. Check it and try again.',
        name,
      );
    case 'ExpiredCodeException':
      return info('expired-code', ERRORS.expiredCode, name);
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
        /compromised|breach|pwned/i.test(message) ? ERRORS.breached : 'That password wasn’t accepted. Choose one with at least 15 characters that you haven’t used before.',
        name,
      );
    case 'PasswordResetRequiredException':
      return info('reset-required', 'You need to choose a new password. We can email you a code to do that.', name);
    case 'PasskeyAuthenticationCanceled':
    case 'PasskeyRegistrationCanceled':
    case 'PasskeyOperationAborted':
      return info(
        'passkey-cancelled',
        context === 'passkey-register' ? ERRORS.passkeyCreateFailed : ERRORS.passkeyCancelled,
        name,
      );
    case 'PasskeyNotSupported':
      return info('passkey-unavailable', ERRORS.passkeyUnsupported, name);
    case 'RelyingPartyMismatch':
    case 'WebAuthnRelyingPartyMismatchException':
    case 'WebAuthnOriginNotAllowedException':
      return info('passkey-unavailable', 'Passkeys aren’t set up for this web address yet. Use another way below.', name);
    case 'PasskeyRetrievalFailed':
    case 'PasskeyRegistrationFailed':
    case 'InvalidPasskeyAuthenticationOptions':
    case 'InvalidPasskeyRegistrationOptions':
    case 'WebAuthnChallengeNotFoundException':
    case 'WebAuthnCredentialNotSupportedException':
      return info(
        'passkey-unavailable',
        context === 'passkey-register' ? ERRORS.passkeyCreateFailed : ERRORS.passkeyRejected,
        name,
      );
    case 'PasskeyAlreadyExists':
    case 'WebAuthnCredentialAlreadyExistsException':
      return info('passkey-exists', 'This device already has a passkey for your account.', name);
    case 'WebAuthnNotEnabledException':
    case 'WebAuthnConfigurationMissingException':
    case 'WebAuthnClientMismatchException':
    case 'InvalidPreferredChallenge':
      return info('method-unavailable', 'That way of signing in isn’t turned on for this site. Use another way below.', name);
    case 'UserUnAuthenticatedException':
      return info('signed-out', 'Your session has ended. Sign in again to continue.', name);
    case 'NetworkError':
      return info('network', network, name);
    default:
      break;
  }
  if (error instanceof TypeError || errorName(underlying(error)) === 'TypeError' || errorName(underlying(error)) === 'NetworkError') {
    return info('network', network, name || 'NetworkError');
  }
  return info('unknown', ERRORS.unknown, name || 'Error');
}
