/**
 * The same screens for every address (ADR 0018). Before someone proves a factor, what the sign-in
 * screens show must not depend on whether the address has an account, or on which first factors that
 * account has: Cognito's answer to a first-factor request does depend on both, so the screens never
 * show it directly.
 *
 * - Cognito answers a request for a factor the account can't use with `SELECT_CHALLENGE` and the
 *   account's own factors. Under `PreventUserExistenceErrors` an unknown address gets "a random
 *   selection from the challenge types allowed for the user pool" instead (AWS docs). So an invited
 *   account (emailed code only) and an unknown address can get different lists for the same request.
 * - Some accounts are refused outright where an unknown address gets a challenge: a disabled account
 *   (an invite the 7-day sweep expired is disabled too) gets `NotAuthorizedException` ("User is
 *   disabled."), and an account whose password must be reset gets `PasswordResetRequiredException`
 *   (which Amplify turns into the `RESET_PASSWORD` step).
 * - The screens therefore treat "this factor isn't available" exactly like the outcome an unknown
 *   address gets for that factor: a passkey prompt that finds nothing, a password that doesn't match,
 *   or "check your email" with nothing sent. `isFirstFactorUnavailable` (an answer) and
 *   `isFirstFactorRefusal` (an error) decide; `decoyPasskeyPrompt` and `answerSimulatedCode` produce
 *   the outcomes.
 *
 * This removes the difference from the screens only. Cognito's responses are still visible to anyone
 * who reads the browser's network panel or calls the API directly; only AWS can change those, and the
 * WAF sign-in rule limits how fast anyone can ask.
 */
import type { SignInMethod } from './ladder.js';
import { describeAuthError } from './messages.js';
import type { SignInStep } from './steps.js';

/**
 * True when Cognito's answer to a first-factor request means "this account can't use that factor"
 * (or there's no account): a choice of other methods, another factor's challenge, or a password that
 * must be reset before anything else (`RESET_PASSWORD`, an account that exists). Anything else is the
 * requested factor's own path (its challenge, or the steps after it was proven).
 */
export function isFirstFactorUnavailable(method: SignInMethod, step: SignInStep): boolean {
  switch (step.step) {
    case 'choose-method':
    case 'reset-password':
      return true;
    case 'password':
      return method !== 'password';
    case 'email-code':
      return method !== 'email-code';
    // The requested factor's own path: its challenge, or what follows once it was proven.
    case 'done':
    case 'totp':
    case 'totp-setup':
    case 'select-mfa':
    case 'new-password':
    case 'unsupported':
      return false;
  }
}

function nameOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '';
}

/**
 * True when a first-factor request was refused because of the account, where an unknown address
 * would have got a challenge: a disabled account (an expired invite included; `NotAuthorizedException`
 * "User is disabled."), an account whose password must be reset (`PasswordResetRequiredException`),
 * or Cognito's "no such account" and "can't sign in" answers. The screens treat these as "that factor
 * isn't available" (ADR 0018). A throttle ("attempts exceeded", "too many") or an expired sign-in
 * session isn't one: those keep their own messages.
 */
export function isFirstFactorRefusal(error: unknown): boolean {
  switch (nameOf(error)) {
    case 'PasswordResetRequiredException':
      return true;
    case 'NotAuthorizedException':
    case 'UserNotFoundException':
      // describeAuthError tells a throttle and an expired session apart from "can't sign in".
      return describeAuthError(error, 'sign-in').kind === 'bad-credentials';
    default:
      return false;
  }
}

/** An error named the way Amplify names its own, so `describeAuthError` words both paths the same. */
function named(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

/** The pool's passkey settings, so the decoy prompt asks the browser what Cognito's challenge asks. */
export interface PasskeyPromptOptions {
  /**
   * The pool's relying-party ID (`passkeys.relyingPartyId` in `auth-kit/amplify`, or the sandbox's).
   * Default: none, so the browser uses the page's own domain.
   */
  relyingPartyId?: string;
  /** How long the browser's passkey window stays open, in milliseconds. Default 180000 (3 minutes). */
  timeoutMs?: number;
}

/** The decoy's window timeout when the site doesn't give the pool's. */
export const DECOY_PASSKEY_TIMEOUT_MS = 180_000;

/**
 * A passkey prompt that can't succeed, for an account with no passkey: what an unknown address gets
 * from Cognito (a challenge listing decoy credential IDs), made in the browser. It asks for random
 * credential IDs, so no passkey matches, and it always rejects, with the same errors Amplify's own
 * prompt raises: `PasskeyAuthenticationCanceled` when closed, `PasskeyNotSupported` where passkeys
 * can't run, `PasskeyOperationAborted`, `RelyingPartyMismatch`. Pass the pool's relying-party ID and
 * timeout (`options`) so the browser's window looks and behaves like the real one.
 */
export async function decoyPasskeyPrompt(options: PasskeyPromptOptions = {}): Promise<never> {
  // The same support check as Amplify's `getIsPasskeySupported`, so an unsupported browser fails the same way.
  const supported =
    typeof window !== 'undefined' &&
    window.isSecureContext === true &&
    typeof navigator !== 'undefined' &&
    'credentials' in navigator &&
    typeof window.PublicKeyCredential === 'function';
  if (!supported) throw named('PasskeyNotSupported', 'Passkeys may not be supported on this device.');
  try {
    await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(32),
        allowCredentials: [
          { type: 'public-key', id: randomBytes(32) },
          { type: 'public-key', id: randomBytes(32) },
        ],
        userVerification: 'required',
        timeout: options.timeoutMs ?? DECOY_PASSKEY_TIMEOUT_MS,
        ...(options.relyingPartyId !== undefined && { rpId: options.relyingPartyId }),
      },
    });
  } catch (error) {
    // DOMException names (NotAllowedError, …). Read by duck typing: not every runtime makes DOMException an Error.
    const name = typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '';
    if (name === 'NotAllowedError') throw named('PasskeyAuthenticationCanceled', 'Passkey authentication has been canceled.');
    if (name === 'AbortError') throw named('PasskeyOperationAborted', 'Passkey operation has been aborted.');
    if (name === 'SecurityError') throw named('RelyingPartyMismatch', 'The relying party ID does not match the current domain.');
    throw named('Unknown', 'An unknown error has occurred.');
  }
  // A random credential ID matches no passkey. A browser that returned something anyway signed no one in.
  throw named('PasskeyAuthenticationCanceled', 'Passkey authentication has been canceled.');
}

/** Cognito's default sign-in session (and so an emailed code's lifetime): 3 minutes (`AuthSessionValidity`). */
export const SIGN_IN_SESSION_MS = 3 * 60 * 1000;

/**
 * Answers a code typed on "Check your email" when no code was sent (the address has no account, or
 * can't use emailed codes): after a round trip's delay, the error Cognito gives a wrong code
 * (`CodeMismatchException`), or once the sign-in session would have ended (`lifetimeMs`, the site's
 * code lifetime; default 3 minutes), the expired-session error. Never contacts Cognito: there's no
 * sign-in session to answer.
 */
export async function answerSimulatedCode(
  sentAt: number,
  options: { now?: () => number; sleep?: (ms: number) => Promise<void>; lifetimeMs?: number } = {},
): Promise<never> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  await sleep(250 + Math.floor(Math.random() * 500));
  if ((options.now ?? Date.now)() - sentAt > (options.lifetimeMs ?? SIGN_IN_SESSION_MS)) {
    throw named('NotAuthorizedException', 'Invalid session for the user, session is expired.');
  }
  throw named('CodeMismatchException', 'Invalid code received for user');
}
