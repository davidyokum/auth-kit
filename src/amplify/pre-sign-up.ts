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

/** True when `email` is on an allowed domain. Exported for tests and for UI hints. */
export function isAllowedEmail(email: string, options: PreSignUpAllowlistOptions): boolean {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  if (at <= 0 || at === normalized.length - 1) return false;
  const domain = normalized.slice(at + 1);
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
