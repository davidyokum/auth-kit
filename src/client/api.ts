/**
 * The Amplify v6 calls behind the screens, as plain async functions. Each sign-in call returns the
 * next `SignInStep`; account calls resolve or throw (pass errors to `describeAuthError`).
 *
 * Every sign-in uses `USER_AUTH` (the only flow the standard's app client allows; Amplify's default,
 * SRP, would fail) with a preferred challenge. Passwords use `PASSWORD`, not `PASSWORD_SRP`, so
 * Cognito's compromised-credentials check (Plus plan) can see them; they still travel only over TLS.
 */
import { Amplify } from 'aws-amplify';
import {
  associateWebAuthnCredential,
  confirmResetPassword,
  confirmSignIn,
  deleteWebAuthnCredential,
  fetchAuthSession,
  fetchMFAPreference,
  fetchUserAttributes,
  getCurrentUser,
  listWebAuthnCredentials,
  resetPassword,
  setUpTOTP,
  signIn,
  signOut,
  updateMFAPreference,
  updatePassword,
  verifyTOTPSetup,
  type SignInInput,
  type SignInOutput,
} from 'aws-amplify/auth';
import { cognitoUserPoolsTokenProvider } from 'aws-amplify/auth/cognito';
import { CookieStorage } from 'aws-amplify/utils';
import { changePasswordWithoutPrevious } from './cognito.js';
import { normalizeCode, type SignInMethod } from './ladder.js';
import { type SignInStep, toSignInStep } from './steps.js';
import { buildOtpauthUri } from './totp.js';

export { fetchAuthFactors } from './cognito.js';

function errorName(error: unknown): string {
  return typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '';
}

// ---- Setup --------------------------------------------------------------------------------------

export interface AuthClientOptions {
  /** The app client's refresh-token lifetime. Token cookies expire with it instead of Amplify's default 365 days. */
  refreshTokenMinutes: number;
  /** Share the cookies across subdomains (rare). Must match the server's `amplifyCookieRuntimeOptions`. */
  cookieDomain?: string;
}

/**
 * Configures Amplify the way the standard expects: `ssr: true` (tokens in cookies, readable by the
 * server), SameSite=Lax, Secure on HTTPS, and a cookie lifetime no longer than the refresh token.
 * Amplify's own `ssr: true` storage keeps browser-written cookies for 365 days.
 *
 * ```tsx
 * // app/amplify-client.tsx
 * 'use client';
 * import outputs from '@/amplify_outputs.json';
 * import { configureAuthClient } from 'auth-kit/client';
 * configureAuthClient(outputs, { refreshTokenMinutes: 30 * 24 * 60 });
 * export function AmplifyClient() { return null; }
 * ```
 */
export function configureAuthClient(outputs: Parameters<typeof Amplify.configure>[0], options: AuthClientOptions): void {
  if (!Number.isFinite(options.refreshTokenMinutes) || options.refreshTokenMinutes <= 0) {
    throw new Error('auth-kit: configureAuthClient needs refreshTokenMinutes (the app client refresh-token lifetime).');
  }
  Amplify.configure(outputs, { ssr: true });
  const secure = typeof window === 'undefined' ? true : window.location.protocol === 'https:';
  cognitoUserPoolsTokenProvider.setKeyValueStorage(
    new CookieStorage({
      path: '/',
      sameSite: 'lax',
      secure,
      expires: options.refreshTokenMinutes / (24 * 60),
      ...(options.cookieDomain !== undefined && { domain: options.cookieDomain }),
    }),
  );
}

// ---- Sign-in ------------------------------------------------------------------------------------

/**
 * Resolves steps auth-kit answers by itself: an MFA choice is answered with TOTP (the standard's only
 * MFA method). Anything else is returned for a screen.
 */
export async function settle(output: SignInOutput): Promise<SignInStep> {
  let step = toSignInStep(output);
  for (let i = 0; i < 2 && step.step === 'select-mfa'; i++) {
    if (!step.totpAllowed) {
      return { step: 'unsupported', signInStep: step.setup ? 'CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION' : 'CONTINUE_SIGN_IN_WITH_MFA_SELECTION' };
    }
    step = toSignInStep(await confirmSignIn({ challengeResponse: 'TOTP' }));
  }
  return step;
}

async function startSignIn(input: SignInInput): Promise<SignInStep> {
  let output: SignInOutput;
  try {
    output = await signIn(input);
  } catch (error) {
    if (errorName(error) !== 'UserAlreadyAuthenticatedException') throw error;
    // A session already exists on this device (a step-up, or switching accounts). Amplify refuses to
    // start another, so end this one here (not everywhere) and sign in fresh, which also renews auth_time.
    await signOut();
    output = await signIn(input);
  }
  return settle(output);
}

/** Passkey first: Amplify asks Cognito for a challenge for this email, then runs the browser's passkey prompt. */
export function signInWithPasskey(email: string): Promise<SignInStep> {
  return startSignIn({ username: email.trim(), options: { authFlowType: 'USER_AUTH', preferredChallenge: 'WEB_AUTHN' } });
}

/** Password, then (if the person has one) the authenticator code. */
export function signInWithPassword(email: string, password: string): Promise<SignInStep> {
  return startSignIn({ username: email.trim(), password, options: { authFlowType: 'USER_AUTH', preferredChallenge: 'PASSWORD' } });
}

/** The backstop: emails an 8-digit code, valid for the 3-minute sign-in session. */
export function requestEmailCode(email: string): Promise<SignInStep> {
  return startSignIn({ username: email.trim(), options: { authFlowType: 'USER_AUTH', preferredChallenge: 'EMAIL_OTP' } });
}

const METHOD_TO_CHALLENGE: Readonly<Record<SignInMethod, string>> = {
  passkey: 'WEB_AUTHN',
  password: 'PASSWORD',
  'email-code': 'EMAIL_OTP',
};

/**
 * Answers Cognito's `SELECT_CHALLENGE` (a `choose-method` step) within the same sign-in session.
 * `SignIn` never shows that list: it names the account's own factors, which an unknown address doesn't
 * get, so showing it tells people who has an account (ADR 0018; see `isFirstFactorUnavailable`).
 */
export async function chooseSignInMethod(method: SignInMethod): Promise<SignInStep> {
  return settle(await confirmSignIn({ challengeResponse: METHOD_TO_CHALLENGE[method] }));
}

/** Answers a `password` step (a password chosen from `choose-method`). */
export async function confirmPassword(password: string): Promise<SignInStep> {
  return settle(await confirmSignIn({ challengeResponse: password }));
}

/** Answers an `email-code`, `totp`, or `totp-setup` step. Spaces and dashes are ignored. */
export async function confirmCode(code: string): Promise<SignInStep> {
  return settle(await confirmSignIn({ challengeResponse: normalizeCode(code) }));
}

/** Answers a `new-password` step (an admin-created account replacing its temporary password). */
export async function completeNewPassword(password: string): Promise<SignInStep> {
  return settle(await confirmSignIn({ challengeResponse: password }));
}

// ---- Password reset -----------------------------------------------------------------------------

/**
 * Emails a reset code. Errors that would reveal whether an account exists (no such user, no verified
 * address, an account that can't reset) resolve the same as success; rate limits still throw.
 */
export async function requestPasswordReset(email: string): Promise<{ destination?: string }> {
  try {
    const out = await resetPassword({ username: email.trim() });
    const destination = out.nextStep.codeDeliveryDetails.destination;
    return destination ? { destination } : {};
  } catch (error) {
    if (['UserNotFoundException', 'InvalidParameterException', 'NotAuthorizedException'].includes(errorName(error))) return {};
    throw error;
  }
}

export async function confirmPasswordReset(email: string, code: string, newPassword: string): Promise<void> {
  await confirmResetPassword({ username: email.trim(), confirmationCode: normalizeCode(code), newPassword });
}

// ---- Session ------------------------------------------------------------------------------------

/** New tokens now, so the server sees a fresh token (and re-checks factors) after an account change. */
export async function refreshSession(): Promise<void> {
  await fetchAuthSession({ forceRefresh: true });
}

/** "Sign out everywhere": revokes every refresh token. Tokens already issued work until they expire (up to an hour). */
export async function signOutEverywhere(): Promise<void> {
  await signOut({ global: true });
}

/** The signed-in person on this device, or null. */
export async function currentUser(): Promise<{ userId: string; loginId?: string } | null> {
  try {
    const user = await getCurrentUser();
    const loginId = user.signInDetails?.loginId;
    return loginId ? { userId: user.userId, loginId } : { userId: user.userId };
  } catch {
    return null;
  }
}

/** The account's email address. */
export async function fetchAccountEmail(): Promise<string | undefined> {
  return (await fetchUserAttributes()).email;
}

// ---- Authenticator (TOTP) -----------------------------------------------------------------------

export interface AuthenticatorEnrollment {
  /** The setup key, for typing by hand. */
  secret: string;
  /** `otpauth://` link for authenticator apps and password managers. */
  otpauthUri: string;
  /** Checks a code, turns the authenticator on as the preferred MFA, and refreshes tokens. */
  verify: (code: string) => Promise<void>;
}

/**
 * Starts (or replaces) the authenticator: `setUpTOTP`, then `verify` runs `verifyTOTPSetup`,
 * `updateMFAPreference({ totp: 'PREFERRED' })`, and a token refresh.
 */
export async function enrollAuthenticator(input: { issuer: string; accountName?: string; deviceName?: string }): Promise<AuthenticatorEnrollment> {
  const details = await setUpTOTP();
  const secret = details.sharedSecret;
  return {
    secret,
    otpauthUri: buildOtpauthUri({ secret, issuer: input.issuer, ...(input.accountName !== undefined && { accountName: input.accountName }) }),
    verify: async (code) => {
      await verifyTOTPSetup({
        code: normalizeCode(code),
        ...(input.deviceName !== undefined && { options: { friendlyDeviceName: input.deviceName } }),
      });
      await updateMFAPreference({ totp: 'PREFERRED' });
      await refreshSession();
    },
  };
}

/** True when the authenticator is turned on (Amplify `fetchMFAPreference`). */
export async function hasAuthenticator(): Promise<boolean> {
  const preference = await fetchMFAPreference();
  return preference.enabled?.includes('TOTP') ?? false;
}

// ---- Passkeys -----------------------------------------------------------------------------------

export interface PasskeyInfo {
  id: string;
  /** Cognito's name for it (it names passkeys itself; Amplify takes no name). */
  friendlyName?: string;
  /** ISO 8601. */
  createdAt?: string;
  /** `platform` (built into a device) or `cross-platform` (a security key or phone). */
  authenticatorAttachment?: string;
  relyingPartyId?: string;
}

/** Saves a passkey for the signed-in person (StartWebAuthnRegistration, the browser prompt, CompleteWebAuthnRegistration). */
export async function registerPasskey(): Promise<void> {
  await associateWebAuthnCredential();
}

/** The signed-in person's own passkeys, every page. No admin API can list someone else's. */
export async function listPasskeys(): Promise<PasskeyInfo[]> {
  const out: PasskeyInfo[] = [];
  let nextToken: string | undefined;
  do {
    const page = await listWebAuthnCredentials(nextToken ? { pageSize: 20, nextToken } : { pageSize: 20 });
    for (const c of page.credentials) {
      if (!c.credentialId) continue;
      out.push({
        id: c.credentialId,
        ...(c.friendlyCredentialName && { friendlyName: c.friendlyCredentialName }),
        ...(c.createdAt && { createdAt: c.createdAt.toISOString() }),
        ...(c.authenticatorAttachment && { authenticatorAttachment: c.authenticatorAttachment }),
        ...(c.relyingPartyId && { relyingPartyId: c.relyingPartyId }),
      });
    }
    nextToken = page.nextToken;
  } while (nextToken);
  return out;
}

export async function deletePasskey(id: string): Promise<void> {
  await deleteWebAuthnCredential({ credentialId: id });
}

// ---- Passwords ----------------------------------------------------------------------------------

/** The first password for someone who joined by emailed code (ChangePassword with no previous password). */
export async function setFirstPassword(password: string): Promise<void> {
  await changePasswordWithoutPrevious(password);
  await refreshSession();
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await updatePassword({ oldPassword: currentPassword, newPassword });
}
