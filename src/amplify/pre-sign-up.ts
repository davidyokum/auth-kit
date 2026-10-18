/**
 * `auth-kit/amplify/pre-sign-up`: the preSignUp trigger for the preset's `accountCreation` (ADR 0023).
 *
 * Cognito's own `SignUp` is always off (`AllowAdminCreateUserOnly`): every account is made on the
 * server with `AdminCreateUser`, by an admin's invite or by auth-kit's sign-up route. This trigger is
 * the second check behind that route. An account the sign-up route makes carries the immutable
 * attribute `custom:authkit_origin = signup`, and the trigger refuses one whose address isn't allowed
 * by the site's mode (in `domains` mode, the domain list), so a bug in the route can't create an
 * account the setting forbids. Admin invites don't carry the attribute and always pass: an admin may
 * invite anyone. It has no AWS SDK or CDK imports, so it bundles small.
 *
 * ```ts
 * // amplify/auth/pre-sign-up/handler.ts
 * import { preSignUpForAccountCreation } from 'auth-kit/amplify/pre-sign-up';
 * import { accountCreation } from '../../../site.config';
 * export const handler = preSignUpForAccountCreation({ accountCreation });
 * ```
 */
import {
  type AccountCreationSettings,
  SIGN_UP_ORIGIN_ATTRIBUTE,
  SIGN_UP_ORIGIN_VALUE,
  allowsSelfSignUp,
  mayCreateOwnAccount,
  normalizeAccountCreation,
} from '../shared/account-creation.js';

/** The fields of Cognito's preSignUp event this handler reads and writes. */
export interface PreSignUpTriggerEvent {
  triggerSource: string;
  request: { userAttributes: Record<string, string | undefined> };
  response: { autoConfirmUser?: boolean; autoVerifyEmail?: boolean; autoVerifyPhone?: boolean };
}

export interface PreSignUpAllowlistOptions {
  allowedEmailDomains: readonly string[];
  /** Also allow subdomains (`cs.example.edu` under `example.edu`). Default `false`. */
  allowSubdomains?: boolean;
  /** Message shown when a sign-up is refused. Keep it generic. */
  message?: string;
}

export interface PreSignUpForAccountCreationOptions {
  /** The same setting the preset and the sign-up route use. */
  accountCreation: AccountCreationSettings;
  /** Message Cognito returns when an account is refused. Keep it generic. Default below. */
  message?: string;
}

const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
// The local part: printable ASCII except space, `@`, and the characters that can't appear unquoted.
// Quoted local parts and anything exotic are refused; real institutional addresses don't need them.
const LOCAL_PART_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}$/;

/**
 * True when `email` is a plain address on an allowed domain. Exported for tests and for UI hints.
 * Exactly one `@`, no spaces or control characters, at most 254 characters, and a local part of
 * ordinary characters (no leading, trailing, or doubled dots).
 */
export function isAllowedEmail(email: string, options: PreSignUpAllowlistOptions): boolean {
  if (!isPlainEmail(email)) return false;
  const domain = email.trim().toLowerCase().split('@')[1] ?? '';
  return options.allowedEmailDomains.some((allowed) => {
    const a = allowed.trim().toLowerCase();
    return domain === a || (options.allowSubdomains === true && domain.endsWith(`.${a}`));
  });
}

/** One `@`, an ordinary local part, a domain with a dot, nothing exotic. */
export function isPlainEmail(email: string): boolean {
  if (typeof email !== 'string') return false;
  // Control characters anywhere (even at the ends, where trim() would hide them) mean no.
  // eslint-disable-next-line no-control-regex -- control characters are what's being refused
  if (/[\u0000-\u001F\u007F]/.test(email)) return false;
  const normalized = email.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > 254) return false;
  const parts = normalized.split('@');
  if (parts.length !== 2) return false;
  const [local = '', domain = ''] = parts;
  if (!LOCAL_PART_RE.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  return DOMAIN_RE.test(domain);
}

/** Cognito's message when an account is refused. Generic: it never says why or whether one exists. */
export const PRE_SIGN_UP_REFUSED = 'This email address can’t create an account on this site.';

/**
 * Builds the preSignUp handler for `accountCreation`:
 *
 * - **Cognito's own sign-up** (`PreSignUp_SignUp`) is refused, always. The pool doesn't allow it
 *   (`AllowAdminCreateUserOnly`); this is the second lock.
 * - **Admin-created accounts** (`PreSignUp_AdminCreateUser`): an account marked
 *   `custom:authkit_origin = signup` (the sign-up route's) passes only when the site's mode lets
 *   that address create its own account (`domains`: on the list; `open`: anyone). Unmarked accounts
 *   are admin invites, and pass.
 * - **Federated first sign-ins** (`PreSignUp_ExternalProvider`) are treated as sign-ups: on the list
 *   in `domains` mode, anyone in `open` mode, refused otherwise.
 * - Nobody is auto-confirmed or auto-verified: the first emailed code proves the address.
 */
export function preSignUpForAccountCreation(options: PreSignUpForAccountCreationOptions) {
  const settings = normalizeAccountCreation(options.accountCreation);
  const message = options.message ?? PRE_SIGN_UP_REFUSED;
  const signUpAllowed = (email: string) => allowsSelfSignUp(settings) && isPlainEmail(email) && mayCreateOwnAccount(email.trim().toLowerCase(), settings);

  return <E extends PreSignUpTriggerEvent>(event: E): Promise<E> => {
    const attributes = event.request.userAttributes;
    const email = attributes.email ?? '';
    event.response.autoConfirmUser = false;
    event.response.autoVerifyEmail = false;
    event.response.autoVerifyPhone = false;
    switch (event.triggerSource) {
      case 'PreSignUp_AdminCreateUser':
        if (attributes[SIGN_UP_ORIGIN_ATTRIBUTE] === undefined) return Promise.resolve(event);
        if (attributes[SIGN_UP_ORIGIN_ATTRIBUTE] === SIGN_UP_ORIGIN_VALUE && signUpAllowed(email)) return Promise.resolve(event);
        return Promise.reject(new Error(message));
      case 'PreSignUp_ExternalProvider':
        return signUpAllowed(email) ? Promise.resolve(event) : Promise.reject(new Error(message));
      default:
        // PreSignUp_SignUp, and anything Cognito adds later: refused.
        return Promise.reject(new Error(message));
    }
  };
}

/**
 * @deprecated Removed in 0.1.8 with the preset's `selfSignUp` (ADR 0023): it let Cognito's own
 * `SignUp` create accounts. Throws, explaining the change. Use `preSignUpForAccountCreation`.
 */
export function preSignUpAllowlist(_options: PreSignUpAllowlistOptions): never {
  throw new Error(
    "auth-kit: preSignUpAllowlist was removed in 0.1.8 (ADR 0023), with the preset's selfSignUp: Cognito's own SignUp stays off now. " +
      "Use preSignUpForAccountCreation({ accountCreation: { mode: 'domains', domains: [...] } }), which re-checks the domain list on accounts auth-kit's sign-up route creates.",
  );
}
