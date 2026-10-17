'use client';
/**
 * `auth-kit/client`: the sign-in screens and My account (primer §4-§5, 03 §2 "Sign-in"), for Next.js
 * App Router client components, on Amplify JS v6 (`aws-amplify/auth`).
 *
 * Order, best first: a passkey; then a password plus an authenticator code, both filled by a
 * password manager; then an emailed code as the backstop for joining, recovery, and a device without
 * the manager.
 *
 * Everything here runs in the browser: Amplify's auth calls go from the browser to Cognito, and
 * passkeys need the browser's WebAuthn prompt. The server side stays in `auth-kit/server`, which
 * enforces the same rules on every request (`requireUser` refuses a password user without an
 * authenticator; page guards send them to the setup page). This module imports nothing server-side
 * except `safeRedirect` and `isAuthUnavailableError`, pure functions with no imports.
 */
export {
  SIGN_IN_METHODS,
  SIGN_IN_AUTOCOMPLETE,
  NEW_PASSWORD_RULES,
  afterSignInStep,
  needsAuthenticator,
  canRemovePasskey,
  newPasswordProblem,
  normalizeCode,
  type SignInMethod,
  type ClientAuthFactors,
  type AfterSignInStep,
  type RemovalCheck,
} from './ladder.js';
export { toSignInStep, methodsFromChallenges, type SignInStep } from './steps.js';
// The same screens for every address (ADR 0018), for sites building their own sign-in screens.
export { isFirstFactorUnavailable, decoyPasskeyPrompt, answerSimulatedCode, SIGN_IN_SESSION_MS } from './parity.js';
export { describeAuthError, type AuthErrorInfo, type AuthErrorKind, type AuthErrorContext } from './messages.js';
export { buildOtpauthUri, formatSetupKey } from './totp.js';
export { isBreachedPassword, PWNED_PASSWORDS_RANGE_URL, type BreachedPasswordCheck } from './breached.js';
export { CognitoRequestError } from './cognito.js';
// For error.tsx: tells auth-kit's "couldn't check" (503) apart from other server errors, in
// production builds too (by digest). A pure function with no imports.
export { isAuthUnavailableError, AUTH_UNAVAILABLE_DIGEST } from '../shared/unavailable.js';
export {
  configureAuthClient,
  settle,
  signInWithPasskey,
  signInWithPassword,
  requestEmailCode,
  chooseSignInMethod,
  confirmPassword,
  confirmCode,
  completeNewPassword,
  requestPasswordReset,
  confirmPasswordReset,
  refreshSession,
  signOutEverywhere,
  currentUser,
  fetchAccountEmail,
  fetchAuthFactors,
  enrollAuthenticator,
  hasAuthenticator,
  registerPasskey,
  listPasskeys,
  deletePasskey,
  setFirstPassword,
  changePassword,
  type AuthClientOptions,
  type AuthenticatorEnrollment,
  type PasskeyInfo,
} from './api.js';
export { SignIn, type SignInProps } from './SignIn.js';
export { ChooseFirstCredential, type ChooseFirstCredentialProps } from './ChooseFirstCredential.js';
export { AuthenticatorSetup, type AuthenticatorSetupProps } from './AuthenticatorSetup.js';
export { TOTPEnrollmentGate, type TOTPEnrollmentGateProps } from './TOTPEnrollmentGate.js';
export { MyAccount, type MyAccountProps } from './MyAccount.js';
export { PasswordForm, breachedPasswordProblem, type PasswordFormProps, type PasswordCheckOptions } from './PasswordForm.js';
export { authKitStyles } from './styles.js';
export type { AuthKitClassNames, AuthKitSlot, StyleProps, HeadingLevel } from './ui.js';
