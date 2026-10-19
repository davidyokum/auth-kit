/**
 * `auth-kit/amplify/custom-message`: Cognito's custom message trigger, so the code emails Cognito
 * sends use the standard's words and layout (REPORT §5.2; ADR 0024), in the site's family theme:
 *
 * - an emailed sign-in code: "Your {Site} sign-in code" (§5.2b), or, for the first code to an account
 *   auth-kit's sign-up route made (marked `custom:authkit_origin = signup`, address not yet
 *   verified), "Your {Site} code" / "Your code to create an account" (Card Studio, §5.2h);
 * - a password reset code: "Reset your {Site} password" (§5.2c);
 * - the code to a new address before an email change: "Confirm your new {Site} email address" (§5.2l).
 *
 * **It's also a security control, so every pool must have it** (the preset fails synthesis without
 * it). Cognito lets a signed-in person change their own email with its public API
 * (`UpdateUserAttributes`, then `VerifyUserAttribute`), which would skip the site's recent-sign-in
 * check, its domain list, its audit log, and its notice to the old address. Both steps need this
 * trigger to send the code (`CustomMessage_UpdateUserAttribute`, and `CustomMessage_VerifyUserAttribute`
 * for a resent code), and Cognito fails the call when the trigger throws. So the handler refuses both
 * unless the call came from the admin API, which only the site's server makes (`callerContext.clientId`
 * is `CLIENT_ID_NOT_APPLICABLE` for Admin* calls): an email change happens only through auth-kit's
 * server route (`createSelfServiceActions`) or an admin (ADR 0023).
 *
 * Use the handler as is, or wrap your own wording with `withAuthKitCustomMessage(handler)`, which runs
 * the same refusal first. Either way, give the function `CUSTOM_MESSAGE_GATE_ENV` as its environment:
 * the preset finds the trigger's function at synthesis and fails unless it carries that marker, so a
 * site can't wire some other function and lose the refusal unnoticed.
 *
 * Each says how long the code works from the same `codeLifetimeMinutes` the preset gives the pool.
 * Cognito's temporary-password invite (the admin pool) keeps the pool's own template. No AWS SDK
 * imports, so it bundles small.
 *
 * ```ts
 * // amplify/auth/custom-message/handler.ts
 * import { customMessageHandler } from 'auth-kit/amplify/custom-message';
 * export const handler = customMessageHandler({ siteName: 'Example Reports', theme: 'osbm', signInUrl: 'https://reports.example.org/sign-in', helpEmail: 'help@example.org' });
 * ```
 *
 * Which trigger source Cognito uses for an emailed sign-in code (`CustomMessage_Authentication`) is
 * from AWS's documentation; confirm on the first sandbox deploy (ADR 0024).
 */
import { SIGN_UP_ORIGIN_ATTRIBUTE, SIGN_UP_ORIGIN_VALUE } from '../shared/account-creation.js';
import { COGNITO_CODE_PLACEHOLDER, type EmailSite, type RenderedEmail, confirmNewEmailEmail, passwordResetEmail, signInCodeEmail, signUpCodeEmail } from '../shared/emails.js';
import { codeLifetimeMinutes } from '../shared/policy.js';
import { type AuthTheme, type ThemeFamily, helpAddressProblems, resolveTheme } from '../themes/index.js';

/** The fields of Cognito's custom message event this handler reads and writes. */
export interface CustomMessageTriggerEvent {
  triggerSource: string;
  /** Who made the call. Cognito sends `clientId` as `CLIENT_ID_NOT_APPLICABLE` for the admin API. */
  callerContext?: { clientId?: string; awsSdkVersion?: string };
  request: {
    userAttributes: Record<string, string | undefined>;
    codeParameter?: string;
    usernameParameter?: string | null;
  };
  response: { smsMessage?: string | null; emailMessage?: string | null; emailSubject?: string | null };
}

export interface CustomMessageOptions extends Omit<EmailSite, 'theme'> {
  theme: AuthTheme | ThemeFamily;
  /** The pool's code lifetime (the preset's `codeLifetimeMinutes`). Default 10 (register A7). */
  codeLifetimeMinutes?: number;
}

/**
 * The `callerContext.clientId` Cognito sends when the admin API (`AdminUpdateUserAttributes`, …) made
 * the call, rather than an app client. Confirm the literal on the first sandbox deploy (ADR 0023).
 */
export const ADMIN_API_CLIENT_ID = 'CLIENT_ID_NOT_APPLICABLE';

/** The trigger sources that send a code to confirm a changed attribute (the new email address). */
export const ATTRIBUTE_CHANGE_SOURCES: readonly string[] = Object.freeze(['CustomMessage_UpdateUserAttribute', 'CustomMessage_VerifyUserAttribute']);

/** Thrown (and so returned to the caller by Cognito, failing the call) for an attribute change through Cognito's public API. */
export const SELF_SERVICE_ATTRIBUTE_CHANGE_REFUSED =
  'auth-kit: change your email address on the site (My account), not through Cognito directly. This call was refused and no code was sent.';

/** True when this event came from the admin API, which only the site's server can call. */
export function isAdminApiCall(event: Pick<CustomMessageTriggerEvent, 'callerContext'>): boolean {
  return event.callerContext?.clientId === ADMIN_API_CLIENT_ID;
}

/**
 * The environment the custom message function must carry (`defineFunction({ environment })`): the
 * preset checks for it at synthesis, as the sign that the function is `customMessageHandler` or
 * `withAuthKitCustomMessage`. Set it only on a function built with one of them.
 */
export const CUSTOM_MESSAGE_GATE_ENV: Readonly<{ AUTH_KIT_CUSTOM_MESSAGE_GATE: 'v1' }> = Object.freeze({ AUTH_KIT_CUSTOM_MESSAGE_GATE: 'v1' });

/**
 * The refusal on its own: throws (so Cognito fails the call and sends no code) for an attribute
 * change made through Cognito's public API; returns for everything else.
 */
export function refusePublicAttributeChange(event: Pick<CustomMessageTriggerEvent, 'triggerSource' | 'callerContext'>): void {
  if (ATTRIBUTE_CHANGE_SOURCES.includes(event.triggerSource) && !isAdminApiCall(event)) throw new Error(SELF_SERVICE_ATTRIBUTE_CHANGE_REFUSED);
}

/**
 * A site's own custom message handler with auth-kit's refusal in front: an email change through
 * Cognito's public API is refused before your code runs; every other event reaches it unchanged.
 *
 * ```ts
 * export const handler = withAuthKitCustomMessage(async (event) => { …your wording…; return event; });
 * ```
 */
export function withAuthKitCustomMessage<E extends CustomMessageTriggerEvent>(handler: (event: E) => E | Promise<E>): (event: E) => Promise<E> {
  if (typeof handler !== 'function') throw new Error('auth-kit: withAuthKitCustomMessage needs your handler function.');
  return async (event: E) => {
    refusePublicAttributeChange(event);
    return handler(event);
  };
}

/** Which email a trigger source gets, given the account's attributes. */
export type CustomMessageKind = 'sign-in-code' | 'sign-up-code' | 'password-reset' | 'confirm-new-email' | null;

/** The email for this event, or null to leave Cognito's own (the admin pool's temporary password, SMS). */
export function customMessageKind(event: Pick<CustomMessageTriggerEvent, 'triggerSource' | 'request'>): CustomMessageKind {
  const attributes = event.request.userAttributes;
  switch (event.triggerSource) {
    case 'CustomMessage_Authentication':
      return attributes[SIGN_UP_ORIGIN_ATTRIBUTE] === SIGN_UP_ORIGIN_VALUE && attributes.email_verified !== 'true' ? 'sign-up-code' : 'sign-in-code';
    case 'CustomMessage_ForgotPassword':
      return 'password-reset';
    case 'CustomMessage_UpdateUserAttribute':
    case 'CustomMessage_VerifyUserAttribute':
      return 'confirm-new-email';
    default:
      return null;
  }
}

/**
 * Builds the handler. Checks its options once, at load: a misconfigured trigger fails the deploy's
 * first invocation loudly instead of sending a half-filled email.
 */
export function customMessageHandler(options: CustomMessageOptions) {
  if (!options.siteName?.trim()) throw new Error('auth-kit: customMessageHandler needs a siteName.');
  try {
    new URL(options.signInUrl);
  } catch {
    throw new Error('auth-kit: customMessageHandler needs signInUrl as an absolute URL.');
  }
  const helpProblems = helpAddressProblems(options.helpEmail);
  if (helpProblems.length > 0) throw new Error(`auth-kit: customMessageHandler helpEmail: ${helpProblems.join(' ')}`);
  const minutes = codeLifetimeMinutes(options.codeLifetimeMinutes);
  const site: EmailSite = { ...options, theme: resolveTheme(options.theme) };

  return <E extends CustomMessageTriggerEvent>(event: E): Promise<E> => {
    // An email change through Cognito's public API: refuse it, so Cognito fails the call and sends no
    // code (ADR 0023). The site's server route uses AdminUpdateUserAttributes, which passes.
    try {
      refusePublicAttributeChange(event);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(SELF_SERVICE_ATTRIBUTE_CHANGE_REFUSED));
    }
    const kind = customMessageKind(event);
    if (kind === null) return Promise.resolve(event);
    // Cognito replaces the placeholder with the code; the message must contain it.
    const code = event.request.codeParameter ?? COGNITO_CODE_PLACEHOLDER;
    let email: RenderedEmail;
    switch (kind) {
      case 'sign-up-code':
        email = signUpCodeEmail(site, { code, codeLifetimeMinutes: minutes });
        break;
      case 'sign-in-code':
        email = signInCodeEmail(site, { code, codeLifetimeMinutes: minutes });
        break;
      case 'password-reset':
        email = passwordResetEmail(site, { code });
        break;
      case 'confirm-new-email':
        email = confirmNewEmailEmail(site, { code });
        break;
    }
    event.response.emailSubject = email.subject;
    event.response.emailMessage = email.html;
    return Promise.resolve(event);
  };
}
