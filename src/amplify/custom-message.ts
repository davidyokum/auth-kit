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
  request: {
    userAttributes: Record<string, string | undefined>;
    codeParameter?: string;
    usernameParameter?: string | null;
  };
  response: { smsMessage?: string | null; emailMessage?: string | null; emailSubject?: string | null };
}

export interface CustomMessageOptions extends Omit<EmailSite, 'theme'> {
  theme: AuthTheme | ThemeFamily;
  /** The pool's code lifetime (the preset's `codeLifetimeMinutes`). Default 3. */
  codeLifetimeMinutes?: number;
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
