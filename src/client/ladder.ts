/**
 * The sign-in ladder and the rules that decide which screen comes next. Pure: no Amplify, no React.
 */
import { PASSWORD_POLICY } from '../shared/policy.js';
import { ERRORS } from './copy.js';

export type SignInMethod = 'passkey' | 'password' | 'email-code';

/** The ladder, best first. */
export const SIGN_IN_METHODS: readonly SignInMethod[] = ['passkey', 'password', 'email-code'];

/**
 * `autocomplete` values so password managers work. Never block paste.
 *
 * `username webauthn` is the standard's token for the email field. With Cognito it lets a password
 * manager fill the email, but it can't surface saved passkeys in the autofill list: that needs a
 * WebAuthn challenge before the email is known, and Cognito only issues one for a named user (ADR
 * 0008).
 */
export const SIGN_IN_AUTOCOMPLETE = {
  email: 'username webauthn',
  currentPassword: 'current-password',
  newPassword: 'new-password',
  oneTimeCode: 'one-time-code',
} as const;

/** New passwords: at least 15 characters, no composition rules (NIST SP 800-63B-4). Cognito's ceiling is 256. */
export const NEW_PASSWORD_RULES = { minLength: PASSWORD_POLICY.minimumLength, maxLength: 256 } as const;

/** What Cognito's GetUserAuthFactors reports, as the client sees it. */
export interface ClientAuthFactors {
  /** First factors, e.g. `PASSWORD`, `EMAIL_OTP`, `WEB_AUTHN`. */
  configured: readonly string[];
  /** MFA methods turned on, e.g. `SOFTWARE_TOKEN_MFA`. */
  mfa: readonly string[];
}

function hasTotp(factors: ClientAuthFactors): boolean {
  return factors.mfa.includes('SOFTWARE_TOKEN_MFA') || factors.configured.includes('SOFTWARE_TOKEN');
}

/**
 * True when the person signs in with a password but has no authenticator yet. The same rule as
 * `needsTotpEnrollment` in `auth-kit/server` (a test keeps them in step); the server enforces it,
 * this keeps the screens in step.
 */
export function needsAuthenticator(factors: ClientAuthFactors): boolean {
  return factors.configured.includes('PASSWORD') && !hasTotp(factors);
}

export type AfterSignInStep =
  /** A password with no authenticator: only the setup screen until it's done. */
  | 'set-up-authenticator'
  /** No passkey yet (and passkeys are on): offer "Save a passkey" once. */
  | 'offer-passkey'
  /** Signed in only by emailed code with nothing saved (a fresh invite): save a passkey or set a password. */
  | 'choose-first-credential'
  | 'done';

/** Decides what the app shows right after sign-in. */
export function afterSignInStep(factors: ClientAuthFactors, options: { passkeysEnabled: boolean }): AfterSignInStep {
  const hasPassword = factors.configured.includes('PASSWORD');
  const hasPasskey = factors.configured.includes('WEB_AUTHN');
  if (needsAuthenticator(factors)) return 'set-up-authenticator';
  if (!hasPassword && !hasPasskey) return 'choose-first-credential';
  if (options.passkeysEnabled && !hasPasskey) return 'offer-passkey';
  return 'done';
}

export interface RemovalCheck {
  allowed: boolean;
  /** Why not, in words for the person. */
  reason?: string;
}

/**
 * Guards "Remove passkey" so nobody deletes their last way in. Other ways in: another passkey, a
 * password, or an emailed code (which Cognito stops offering once someone turns on an authenticator).
 * Unknown factors (`null`) fail closed when it's the last passkey.
 */
export function canRemovePasskey(input: { passkeyCount: number; factors: ClientAuthFactors | null }): RemovalCheck {
  if (input.passkeyCount > 1) return { allowed: true };
  const { factors } = input;
  if (!factors) {
    return { allowed: false, reason: ERRORS.passkeyRemovalUnconfirmed };
  }
  if (factors.configured.includes('PASSWORD')) return { allowed: true };
  if (factors.configured.includes('EMAIL_OTP') && !hasTotp(factors)) return { allowed: true };
  return { allowed: false, reason: 'This passkey is your only way to sign in. Add another passkey or set a password first.' };
}

/** Checks a new password against the standard: length only, no composition rules. Returns a message or null. */
export function newPasswordProblem(password: string): string | null {
  const length = [...password].length;
  if (length === 0) return 'Enter a new password';
  if (length < NEW_PASSWORD_RULES.minLength) return `Choose a password with at least ${NEW_PASSWORD_RULES.minLength} characters`;
  if (length > NEW_PASSWORD_RULES.maxLength) return `Choose a password with at most ${NEW_PASSWORD_RULES.maxLength} characters`;
  return null;
}

/** Normalizes a typed or pasted code: drops spaces and dashes. */
export function normalizeCode(code: string): string {
  return code.replace(/[\s-]/g, '');
}
