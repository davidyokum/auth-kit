/**
 * `auth-kit/amplify/pre-sign-up`: the one sanctioned exception to admin-create-only.
 *
 * A preSignUp Lambda that lets people register themselves only with an email address on an allowed
 * domain (for example, faculty on a `.edu` domain). It has no AWS SDK or CDK imports, so it bundles
 * small. Use it with the preset's `selfSignUp` option:
 *
 * ```ts
 * // amplify/auth/pre-sign-up/handler.ts
 * import { preSignUpAllowlist } from 'auth-kit/amplify/pre-sign-up';
 * export const handler = preSignUpAllowlist({ allowedEmailDomains: ['example.edu'] });
 * ```
 */

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
  if (!DOMAIN_RE.test(domain)) return false;
  return options.allowedEmailDomains.some((allowed) => {
    const a = allowed.trim().toLowerCase();
    return domain === a || (options.allowSubdomains === true && domain.endsWith(`.${a}`));
  });
}

/**
 * Builds the preSignUp handler.
 *
 * - Self sign-ups (`PreSignUp_SignUp`) and federated first sign-ins (`PreSignUp_ExternalProvider`)
 *   must use an allowed domain.
 * - Admin-created users (`PreSignUp_AdminCreateUser`) always pass: invites are the normal path.
 * - Nobody is auto-confirmed or auto-verified; the emailed code proves the person owns the address.
 *
 * With self sign-up on, Cognito's `SignUp` answers `UsernameExistsException` for an address that
 * already has an account (`PreventUserExistenceErrors` doesn't cover `SignUp`), so anyone can test
 * whether an allowed-domain address is registered. The README lists this with the exception.
 */
export function preSignUpAllowlist(options: PreSignUpAllowlistOptions) {
  if (options.allowedEmailDomains.length === 0) {
    throw new Error('auth-kit: preSignUpAllowlist needs at least one allowed domain.');
  }
  for (const d of options.allowedEmailDomains) {
    if (!DOMAIN_RE.test(d.trim().toLowerCase())) throw new Error(`auth-kit: "${d}" isn't a valid domain.`);
  }
  const message = options.message ?? 'Sign-up is limited to approved email domains.';

  return <E extends PreSignUpTriggerEvent>(event: E): Promise<E> => {
    if (event.triggerSource === 'PreSignUp_AdminCreateUser') return Promise.resolve(event);
    const email = event.request.userAttributes.email ?? '';
    if (!isAllowedEmail(email, options)) return Promise.reject(new Error(message));
    event.response.autoConfirmUser = false;
    event.response.autoVerifyEmail = false;
    event.response.autoVerifyPhone = false;
    return Promise.resolve(event);
  };
}
