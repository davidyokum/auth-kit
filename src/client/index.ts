/**
 * `auth-kit/client`: sign-in screens and My account (primer §4-§5, 03 §2 "Sign-in").
 *
 * Phase 1 (0.1.0-alpha) ships the typed interfaces, the autocomplete tokens, and the after-sign-in
 * decision as a tested pure function. The Amplify calls and React components are stubs that throw
 * `NotImplementedError`. Safe to import in client components: no server or Node imports.
 *
 * Order, best first: a passkey (with passkey autofill); then a password plus an authenticator code,
 * both filled by a password manager; then an emailed code as the backstop for joining, recovery,
 * and a device without the manager.
 */
import { NotImplementedError } from '../shared/not-implemented.js';

export { NotImplementedError };

export type SignInMethod = 'passkey' | 'password' | 'email-code';

/** The ladder, best first. */
export const SIGN_IN_METHODS: readonly SignInMethod[] = ['passkey', 'password', 'email-code'];

/**
 * `autocomplete` values so password managers and passkey autofill work. Never block paste.
 * `username webauthn` on the email field also offers saved passkeys there (conditional mediation).
 */
export const SIGN_IN_AUTOCOMPLETE = {
  email: 'username webauthn',
  currentPassword: 'current-password',
  newPassword: 'new-password',
  oneTimeCode: 'one-time-code',
} as const;

/** What Cognito's GetUserAuthFactors reports, as the client sees it. */
export interface ClientAuthFactors {
  configured: readonly string[];
  mfa: readonly string[];
}

export type AfterSignInStep =
  /** A password with no authenticator: only the setup screen until it's done. */
  | 'set-up-authenticator'
  /** No passkey yet (and passkeys are on): offer "Save a passkey" once. */
  | 'offer-passkey'
  /** Signed in only by emailed code with nothing saved (a fresh invite): save a passkey or set a password. */
  | 'choose-first-credential'
  | 'done';

/**
 * Decides what the app shows right after sign-in. The server enforces the same authenticator rule
 * (`requireUser` refuses a password user without TOTP); this keeps the screens in step.
 */
export function afterSignInStep(factors: ClientAuthFactors, options: { passkeysEnabled: boolean }): AfterSignInStep {
  const hasPassword = factors.configured.includes('PASSWORD');
  const hasTotp = factors.mfa.includes('SOFTWARE_TOKEN_MFA') || factors.configured.includes('SOFTWARE_TOKEN');
  const hasPasskey = factors.configured.includes('WEB_AUTHN');
  if (hasPassword && !hasTotp) return 'set-up-authenticator';
  if (!hasPassword && !hasPasskey) return 'choose-first-credential';
  if (options.passkeysEnabled && !hasPasskey) return 'offer-passkey';
  return 'done';
}

// ---- Typed stubs (phase 2) ----------------------------------------------------------------------

export interface SignInResult {
  status: 'signed-in' | 'needs-code' | 'needs-totp' | 'needs-new-password' | 'failed';
  /** Shown to the person; never reveals whether an account exists. */
  message?: string;
}

export interface SignInScreenProps {
  /** Where to go after sign-in (passed through safeRedirect). */
  next?: string;
  passkeysEnabled: boolean;
  /** Ask for the passkey again (step-up). */
  reauth?: boolean;
  siteName: string;
}

export interface PasskeyInfo {
  id: string;
  friendlyName?: string;
  createdAt: string;
  authenticatorAttachment?: 'platform' | 'cross-platform';
}

export interface MyAccountProps {
  passkeysEnabled: boolean;
}

/** TODO(phase-2): USER_AUTH with PREFERRED_CHALLENGE=WEB_AUTHN, including conditional UI (passkey autofill). */
export function signInWithPasskey(_email?: string): Promise<SignInResult> {
  return Promise.reject(new NotImplementedError('signInWithPasskey'));
}

/** TODO(phase-2): USER_AUTH with PASSWORD, then the TOTP challenge. */
export function signInWithPassword(_email: string, _password: string): Promise<SignInResult> {
  return Promise.reject(new NotImplementedError('signInWithPassword'));
}

/** TODO(phase-2): USER_AUTH with PREFERRED_CHALLENGE=EMAIL_OTP (8 digits, valid 3 minutes). */
export function requestEmailCode(_email: string): Promise<SignInResult> {
  return Promise.reject(new NotImplementedError('requestEmailCode'));
}

/** TODO(phase-2): answers the EMAIL_OTP or TOTP challenge. */
export function confirmCode(_code: string): Promise<SignInResult> {
  return Promise.reject(new NotImplementedError('confirmCode'));
}

/** TODO(phase-2): AssociateSoftwareToken + VerifySoftwareToken + SetUserMFAPreference; then force-refresh tokens. */
export function enrollAuthenticator(): Promise<{ secret: string; otpauthUri: string; verify(code: string): Promise<void> }> {
  return Promise.reject(new NotImplementedError('enrollAuthenticator'));
}

/** TODO(phase-2): StartWebAuthnRegistration / CompleteWebAuthnRegistration. */
export function registerPasskey(): Promise<PasskeyInfo> {
  return Promise.reject(new NotImplementedError('registerPasskey'));
}

/** TODO(phase-2): ListWebAuthnCredentials (only the person's own; no admin API exists). */
export function listPasskeys(): Promise<PasskeyInfo[]> {
  return Promise.reject(new NotImplementedError('listPasskeys'));
}

/** TODO(phase-2): DeleteWebAuthnCredential. */
export function deletePasskey(_id: string): Promise<void> {
  return Promise.reject(new NotImplementedError('deletePasskey'));
}

/** TODO(phase-2): ChangePassword with no previous password (first password after an emailed-code invite). */
export function setFirstPassword(_password: string): Promise<void> {
  return Promise.reject(new NotImplementedError('setFirstPassword'));
}

/** TODO(phase-2): signOut({ global: true }), labeled "Sign out everywhere". */
export function signOutEverywhere(): Promise<void> {
  return Promise.reject(new NotImplementedError('signOutEverywhere'));
}

/** TODO(phase-2): the sign-in screen (passkey first, password + TOTP, emailed-code backstop). */
export function SignInScreen(_props: SignInScreenProps): never {
  throw new NotImplementedError('SignInScreen');
}

/** TODO(phase-2): blocks everything but authenticator setup for password users without TOTP. */
export function AuthenticatorEnrollmentGate(_props: { children?: unknown }): never {
  throw new NotImplementedError('AuthenticatorEnrollmentGate');
}

/** TODO(phase-2): My account: passkeys list/remove, authenticator, sign out everywhere. */
export function MyAccount(_props: MyAccountProps): never {
  throw new NotImplementedError('MyAccount');
}
