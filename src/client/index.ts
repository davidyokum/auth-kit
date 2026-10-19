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
export { isFirstFactorUnavailable, isFirstFactorRefusal, decoyPasskeyPrompt, answerSimulatedCode, SIGN_IN_SESSION_MS, DECOY_PASSKEY_TIMEOUT_MS, type PasskeyPromptOptions } from './parity.js';
export { describeAuthError, type AuthErrorInfo, type AuthErrorKind, type AuthErrorContext, type MessageWords } from './messages.js';
// Every screen's words (REPORT §4, Card Studio v4), for sites building their own screens and for tests.
export {
  SIGN_IN,
  ACCESS_LINE,
  FIRST_VISIT,
  TROUBLE,
  ACCESS_HELP,
  SIGN_UP,
  REQUEST,
  SIGNED_OUT,
  SELF_SERVICE,
  MY_ACCOUNT,
  CONTACT,
  SHARED,
  STATUS,
  ERRORS,
  helpScreen,
  contactLines,
  team,
  Team,
  plain,
  type CopyContext,
  type HelpTopic,
  type HelpScreen,
  type Rich,
} from './copy.js';
export { Icon, ICON_NAMES, type IconName } from './icons.js';
export { wafAwareFetch, postAccountForm, type PostOutcome } from './account-creation-client.js';
// The families as themes (auth-kit/themes), for the screens' `theme` prop.
export { authTheme, CARD_STYLES, FAMILY_THEMES, resolveTheme, type AuthTheme, type AuthThemeOverrides, type CardStyle, type ThemeFamily } from '../themes/index.js';
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
  saveName,
  type AuthClientOptions,
  type AuthenticatorEnrollment,
  type PasskeyInfo,
} from './api.js';
export { SignIn, type SignInProps, type SignInHelp } from './SignIn.js';
export { SignUp, type SignUpProps } from './SignUp.js';
export { RequestAccess, type RequestAccessProps } from './RequestAccess.js';
export { SignedOutEverywhere, type SignedOutEverywhereProps } from './SignedOutEverywhere.js';
export { ChooseFirstCredential, type ChooseFirstCredentialProps, type FirstCredential } from './ChooseFirstCredential.js';
export { AuthenticatorSetup, type AuthenticatorSetupProps } from './AuthenticatorSetup.js';
export { TOTPEnrollmentGate, type TOTPEnrollmentGateProps } from './TOTPEnrollmentGate.js';
export { MyAccount, type MyAccountProps, type MyAccountSelfService, type SelfServiceResult } from './MyAccount.js';
export { Card as AuthCard, monogramOf, type CardBottom as AuthCardBottom } from './ui.js';
export { PasswordForm, breachedPasswordProblem, type PasswordFormProps, type PasswordCheckOptions } from './PasswordForm.js';
export { authKitStyles } from './styles.js';
export { sendAccountNotice, type AccountNotices } from './notices.js';
// The passkey hint (register A5a): for sites building their own screens. ChooseFirstCredential, SignIn,
// SignUp, and MyAccount already set and clear it.
export { rememberPasskey, forgetPasskey, hasPasskeyHint, passkeyHintSkipped, PASSKEY_HINT_SKIPS } from './passkey-hint.js';
export { ACCOUNT_NOTICE_PATH, ACCOUNT_NOTICE_EVENTS, type AccountNoticeEvent } from '../shared/notices.js';
export type { AuthKitClassNames, AuthKitSlot, StyleProps, HeadingLevel } from './ui.js';
