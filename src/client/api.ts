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
  updateUserAttributes,
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
  /**
   * `'browser'` for Simple sign-in's "every visit" (ADR 0029): the token cookies end when the browser
   * quits (no Expires). Pair it with `amplifyAdapterRefresh(deps, { cookies: 'browser' })` in the proxy.
   */
  cookies?: 'browser';
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
      // An explicit undefined (not a missing key) makes CookieStorage write session cookies.
      expires: options.cookies === 'browser' ? undefined : options.refreshTokenMinutes / (24 * 60),
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

/** Where the passkey that signed in lives: on this device, or another (a phone over Bluetooth, a security key). */
export type PasskeyAttachment = 'platform' | 'cross-platform';

let lastAttachment: PasskeyAttachment | null = null;

/**
 * The last passkey sign-in's `authenticatorAttachment`, or `null` when the browser didn't say (or none
 * ran yet). A passkey from another device signs in fine but leaves this one without its own, so the
 * screens offer one here (`afterSignIn`).
 */
export function lastPasskeyAttachment(): PasskeyAttachment | null {
  return lastAttachment;
}

/**
 * Runs `run` while noting the `authenticatorAttachment` of any assertion `navigator.credentials.get`
 * returns. Amplify calls the browser itself and keeps the credential, so this is the only place to
 * see it. Nothing else changes: the same options go in, the same credential comes out, and the
 * original `get` is put back however `run` ends.
 */
async function noteAttachment<T>(run: () => Promise<T>): Promise<T> {
  const creds = typeof navigator === 'undefined' ? undefined : navigator.credentials;
  if (!creds || typeof creds.get !== 'function') return run();
  const own = Object.getOwnPropertyDescriptor(creds, 'get');
  const original = creds.get.bind(creds);
  const watched = (options?: CredentialRequestOptions) =>
    original(options).then((credential) => {
      const attachment = (credential as { authenticatorAttachment?: unknown } | null)?.authenticatorAttachment;
      if (attachment === 'platform' || attachment === 'cross-platform') lastAttachment = attachment;
      return credential;
    });
  try {
    Object.defineProperty(creds, 'get', { value: watched, configurable: true, writable: true });
  } catch {
    return run(); // a browser that won't let it be watched: the attachment stays unknown
  }
  try {
    return await run();
  } finally {
    if (own) Object.defineProperty(creds, 'get', own);
    else Reflect.deleteProperty(creds, 'get');
  }
}

/** Passkey first: Amplify asks Cognito for a challenge for this email, then runs the browser's passkey prompt. */
export function signInWithPasskey(email: string): Promise<SignInStep> {
  lastAttachment = null;
  return noteAttachment(() => startSignIn({ username: email.trim(), options: { authFlowType: 'USER_AUTH', preferredChallenge: 'WEB_AUTHN' } }));
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

/**
 * Saves the person's own name ("Your name" after sign-up): `given_name`, `family_name`, and `name`
 * (what the People page shows). The app client lets people write these, never their email address.
 */
export async function saveName(input: { givenName: string; familyName: string }): Promise<void> {
  const given = input.givenName.trim();
  const family = input.familyName.trim();
  await updateUserAttributes({
    userAttributes: { given_name: given, family_name: family, name: [given, family].filter(Boolean).join(' ') },
  });
  await refreshSession();
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
 *
 * Each `setUpTOTP` replaces the account's pending setup key in Cognito, so a key someone already
 * scanned stops working. `AuthenticatorSetup` keeps its key across reloads and redirects for that
 * reason, and only asks for a new one when the person chooses "Get a new QR code".
 */
export async function enrollAuthenticator(input: { issuer: string; accountName?: string; deviceName?: string }): Promise<AuthenticatorEnrollment> {
  const details = await setUpTOTP();
  const secret = details.sharedSecret;
  return {
    secret,
    otpauthUri: buildOtpauthUri({ secret, issuer: input.issuer, ...(input.accountName !== undefined && { accountName: input.accountName }) }),
    verify: async (code) => {
      await checkAuthenticatorCode(code, input.deviceName);
      await turnOnAuthenticator();
    },
  };
}

/**
 * The first half of turning the authenticator on: `verifyTOTPSetup` ties the pending setup key to the
 * account. Until `turnOnAuthenticator`, sign-in doesn't ask for its codes and emailed codes keep
 * working, so stopping here leaves the account as it was.
 */
export async function checkAuthenticatorCode(code: string, deviceName?: string): Promise<void> {
  await verifyTOTPSetup({
    code: normalizeCode(code),
    ...(deviceName !== undefined && { options: { friendlyDeviceName: deviceName } }),
  });
}

/**
 * The second half: makes the checked authenticator the account's MFA (`updateMFAPreference`, tried
 * twice, since a password saved just before it would otherwise be left without one), then new tokens.
 */
export async function turnOnAuthenticator(): Promise<void> {
  try {
    await updateMFAPreference({ totp: 'PREFERRED' });
  } catch (error) {
    if (errorName(error) === 'NotAuthorizedException' || errorName(error) === 'UserUnAuthenticatedException') throw error;
    await updateMFAPreference({ totp: 'PREFERRED' });
  }
  await refreshSession();
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

/**
 * Saves a passkey for the signed-in person (StartWebAuthnRegistration, the browser prompt,
 * CompleteWebAuthnRegistration), then new tokens, so the server re-reads the account's factors on the
 * next request (a first passkey ends the first-credential step). The passkey is saved even if the
 * refresh fails, so that failure isn't reported: the server doesn't cache an unfinished setup either.
 */
export async function registerPasskey(): Promise<void> {
  await associateWebAuthnCredential();
  try {
    await refreshSession();
  } catch {
    // The passkey is saved. The next page load re-reads the factors (auth-kit/server caches only "nothing to set up").
  }
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

/**
 * The first password for someone who joined by emailed code (ChangePassword with no previous password).
 *
 * On an account without an authenticator, call it only once the authenticator's code has checked
 * (`AuthenticatorSetup`'s `beforeTurningOn`, which `ChooseFirstCredential` and `MyAccount` use): a
 * password without an authenticator sends every page to authenticator setup until one is added.
 */
export async function setFirstPassword(password: string): Promise<void> {
  await changePasswordWithoutPrevious(password);
  await refreshSession();
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await updatePassword({ oldPassword: currentPassword, newPassword });
}
