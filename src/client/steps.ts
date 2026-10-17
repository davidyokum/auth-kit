/**
 * Maps Amplify's sign-in steps onto the screens auth-kit shows. Amplify renames Cognito's challenges:
 *
 * | Cognito challenge | Amplify `signInStep` | auth-kit step |
 * |---|---|---|
 * | `SELECT_CHALLENGE` | `CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION` | `choose-method` |
 * | `PASSWORD` / `PASSWORD_SRP` (after choosing) | `CONFIRM_SIGN_IN_WITH_PASSWORD` | `password` |
 * | `EMAIL_OTP` | `CONFIRM_SIGN_IN_WITH_EMAIL_CODE` | `email-code` |
 * | `SOFTWARE_TOKEN_MFA` | `CONFIRM_SIGN_IN_WITH_TOTP_CODE` | `totp` |
 * | `NEW_PASSWORD_REQUIRED` | `CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED` | `new-password` |
 * | `MFA_SETUP` (TOTP) | `CONTINUE_SIGN_IN_WITH_TOTP_SETUP` | `totp-setup` |
 * | `MFA_SETUP` (several) / `SELECT_MFA_TYPE` | `CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION` / `..._MFA_SELECTION` | `select-mfa` (answered with TOTP automatically) |
 * | `WEB_AUTHN` | none: Amplify runs the passkey prompt itself | |
 * | (PasswordResetRequiredException) | `RESET_PASSWORD` | `reset-password` |
 */
import type { SignInOutput } from 'aws-amplify/auth';
import { SIGN_IN_METHODS, type SignInMethod } from './ladder.js';

export type SignInStep =
  | { step: 'done' }
  /** Cognito offered a choice (the preferred method isn't available to this person). */
  | { step: 'choose-method'; methods: SignInMethod[] }
  /** A password chosen from `choose-method`: answer with `confirmPassword`. */
  | { step: 'password' }
  /** An emailed code was sent. `destination` is Cognito's masked address. */
  | { step: 'email-code'; destination?: string }
  | { step: 'totp' }
  /** An admin-created account with a temporary password must choose its own. */
  | { step: 'new-password'; missingAttributes: string[] }
  /** MFA is required and not set up yet (admin pools): add the authenticator, then answer with a code. */
  | { step: 'totp-setup'; secret: string }
  | { step: 'select-mfa'; setup: boolean; totpAllowed: boolean }
  | { step: 'reset-password' }
  /** A step the standard doesn't use (SMS, custom challenges, emailed MFA, sign-up confirmation). */
  | { step: 'unsupported'; signInStep: string };

const CHALLENGE_TO_METHOD: Readonly<Record<string, SignInMethod>> = {
  WEB_AUTHN: 'passkey',
  PASSWORD: 'password',
  PASSWORD_SRP: 'password',
  EMAIL_OTP: 'email-code',
};

/** Orders Cognito's available challenges on the ladder, dropping ones the standard doesn't use. */
export function methodsFromChallenges(challenges: readonly string[] | undefined): SignInMethod[] {
  const offered = new Set((challenges ?? []).map((c) => CHALLENGE_TO_METHOD[c]).filter((m): m is SignInMethod => m !== undefined));
  return SIGN_IN_METHODS.filter((m) => offered.has(m));
}

/** Pure mapping from Amplify's output to an auth-kit step. */
export function toSignInStep(output: SignInOutput): SignInStep {
  if (output.isSignedIn) return { step: 'done' };
  const next = output.nextStep;
  switch (next.signInStep) {
    case 'DONE':
      return { step: 'done' };
    case 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION':
      return { step: 'choose-method', methods: methodsFromChallenges(next.availableChallenges) };
    case 'CONFIRM_SIGN_IN_WITH_PASSWORD':
      return { step: 'password' };
    case 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE':
      return next.codeDeliveryDetails?.destination
        ? { step: 'email-code', destination: next.codeDeliveryDetails.destination }
        : { step: 'email-code' };
    case 'CONFIRM_SIGN_IN_WITH_TOTP_CODE':
      return { step: 'totp' };
    case 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED':
      return { step: 'new-password', missingAttributes: [...(next.missingAttributes ?? [])].map(String) };
    case 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP':
      return { step: 'totp-setup', secret: next.totpSetupDetails.sharedSecret };
    case 'CONTINUE_SIGN_IN_WITH_MFA_SELECTION':
      return { step: 'select-mfa', setup: false, totpAllowed: next.allowedMFATypes?.includes('TOTP') ?? false };
    case 'CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION':
      return { step: 'select-mfa', setup: true, totpAllowed: next.allowedMFATypes?.includes('TOTP') ?? false };
    case 'RESET_PASSWORD':
      return { step: 'reset-password' };
    case 'CONFIRM_SIGN_IN_WITH_SMS_CODE':
    case 'CONFIRM_SIGN_IN_WITH_CUSTOM_CHALLENGE':
    case 'CONTINUE_SIGN_IN_WITH_EMAIL_SETUP':
    case 'CONFIRM_SIGN_UP':
      return { step: 'unsupported', signInStep: next.signInStep };
  }
}
