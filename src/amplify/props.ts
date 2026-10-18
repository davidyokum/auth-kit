import type { defineAuth } from '@aws-amplify/backend';
import { SIGN_UP_ORIGIN_ATTRIBUTE, allowsSelfSignUp } from '../shared/account-creation.js';
import { type AuthStandardOptions, AuthStandardConfigError, normalizeOptions } from './options.js';

/** The props `defineAuth` accepts, taken from the installed `@aws-amplify/backend`. */
export type DefineAuthProps = Parameters<typeof defineAuth>[0];

/** Pass-throughs for `defineAuth` settings the standard doesn't decide. */
export interface StandardAuthExtras {
  /**
   * Lambda triggers: `{ preSignUp }` (required in `accountCreation` mode `domains`: built with
   * `preSignUpForAccountCreation`), `{ customMessage }` (auth-kit/amplify/custom-message), or your own.
   */
  triggers?: DefineAuthProps['triggers'];
  /** IAM grants from the pool to functions, e.g. `allow.resource(fn).to(['listUsers'])`. */
  access?: DefineAuthProps['access'];
  /** Extra user attributes (email is always required). */
  userAttributes?: DefineAuthProps['userAttributes'];
  /** Resource name hint. */
  name?: string;
}

/**
 * Builds the props for `defineAuth` so a pool meets the standard.
 *
 * Call it from `amplify/auth/resource.ts` and hand the result to `defineAuth` there:
 *
 * ```ts
 * export const auth = defineAuth(standardAuthProps(authOptions));
 * ```
 *
 * The package can't call `defineAuth` for you: Amplify checks that the function calling `defineAuth`
 * lives in `amplify/auth/resource.ts` and fails synthesis otherwise.
 *
 * Some settings can't be expressed through `defineAuth` (deletion protection, token lifetimes, the
 * password policy, passkey factor configuration, MFA required alongside passkeys, the SES domain
 * identity, the WAF web ACL, tags). `applyAuthStandard` sets those in `amplify/backend.ts`.
 */
export function standardAuthProps(options: AuthStandardOptions, extras: StandardAuthExtras = {}): DefineAuthProps {
  const o = normalizeOptions(options);

  const email = {
    // The emailed code is the backstop for joining, recovery, and a device without the password
    // manager. Admin pools take no emailed codes: Cognito can't require MFA where they're allowed.
    otpLogin: !o.adminPool,
    verificationEmailStyle: 'CODE' as const,
    ...(o.email.verification?.subject !== undefined && { verificationEmailSubject: o.email.verification.subject }),
    ...(o.email.verification?.body !== undefined && { verificationEmailBody: o.email.verification.body }),
    ...(o.email.invitation !== undefined && {
      userInvitation: {
        ...(o.email.invitation.subject !== undefined && { emailSubject: o.email.invitation.subject }),
        ...(o.email.invitation.body !== undefined && { emailBody: o.email.invitation.body }),
      },
    }),
  };

  // Sign-up sites mark the accounts their sign-up route makes, once, at creation (ADR 0023): the
  // unverified-account sweep deletes only those, the preSignUp trigger re-checks only those, and the
  // code email can say "your code to create an account". Immutable, so nobody can mark or unmark one later.
  const signUpSite = allowsSelfSignUp(o.accountCreation);
  if (extras.userAttributes && Object.hasOwn(extras.userAttributes, SIGN_UP_ORIGIN_ATTRIBUTE)) {
    throw new AuthStandardConfigError(`userAttributes may not define ${SIGN_UP_ORIGIN_ATTRIBUTE}: auth-kit owns it.`);
  }
  const userAttributes: DefineAuthProps['userAttributes'] | undefined = signUpSite
    ? { ...extras.userAttributes, [SIGN_UP_ORIGIN_ATTRIBUTE]: { dataType: 'String', mutable: false, minLen: 1, maxLen: 16 } }
    : extras.userAttributes;

  const props: DefineAuthProps = {
    ...(extras.name !== undefined && { name: extras.name }),
    loginWith: {
      email,
      ...(o.passkeys && {
        // The sandbox relying-party ID is swapped in by applyAuthStandard at synth time.
        webAuthn: { relyingPartyId: o.passkeys.relyingPartyId, userVerification: 'required' as const },
      }),
    },
    // Cognito sets MFA once per pool. Everyday pools keep it OPTIONAL with TOTP as the only method,
    // and the app requires TOTP of every password user (auth-kit/server's requireUser).
    // Admin pools need MFA ON, but defineAuth rejects passkeys combined with mode REQUIRED (it doesn't
    // model FactorConfiguration), so applyAuthStandard sets MfaConfiguration ON on the L1 resource.
    multifactor:
      o.adminPool && !o.passkeys ? { mode: 'REQUIRED', totp: true } : { mode: 'OPTIONAL', totp: true },
    // Admin pools recover through an admin only (Cognito's admin_only); everyday pools by email.
    accountRecovery: o.adminPool ? 'NONE' : 'EMAIL_ONLY',
    groups: o.groups,
    senders: {
      email: {
        fromEmail: o.email.fromAddress,
        fromName: o.email.fromName,
        ...(o.email.replyTo !== undefined && { replyTo: o.email.replyTo }),
      },
    },
    ...(userAttributes !== undefined && { userAttributes }),
    ...(extras.triggers !== undefined && { triggers: extras.triggers }),
    ...(extras.access !== undefined && { access: extras.access }),
  };
  return props;
}
