/**
 * How a site lets people get an account (register D1–D4, ADR 0023). Pure: no AWS, no React, no Node,
 * so the preset, the server routes, the scheduled jobs, and the sign-in screens all read the same
 * rules from here.
 *
 * Four modes, one per site:
 * - `invite` (the default): an admin invites, or a Manager invites someone to one item.
 * - `request`: anyone can ask (name, email, what for); an admin approves (the ordinary invite) or
 *   declines. No account exists until a request is approved.
 * - `domains`: addresses on the site's domain list create their own account. Everyone else gets
 *   Request access (`requestsAlso`), or the invite-only line.
 * - `open`: anyone with an email address creates their own account.
 *
 * Every self-made account takes the invite's path: the server creates it with no password and no
 * group, the first emailed code verifies the address, and the person then chooses a passkey or a
 * password plus authenticator. Cognito's own `SignUp` stays off (`AllowAdminCreateUserOnly`).
 */

export const ACCOUNT_CREATION_MODES = ['invite', 'request', 'domains', 'open'] as const;
export type AccountCreationMode = (typeof ACCOUNT_CREATION_MODES)[number];

/** The per-site setting (`accountCreation` in the preset, the routes, and the screens). */
export interface AccountCreationSettings {
  mode: AccountCreationMode;
  /**
   * `domains` mode only: the email domains that may create their own account, e.g. `['nc.gov']` or
   * `['unc.edu', 'edu']`. An entry matches the domain itself and every subdomain (`nc.gov` takes
   * `osbm.nc.gov`); a bare top-level domain (`edu`) takes every address under it.
   */
  domains?: readonly string[];
  /** `domains` mode only: addresses not on the list get Request access. Default `false` (the invite-only line). */
  requestsAlso?: boolean;
}

export interface NormalizedAccountCreation {
  mode: AccountCreationMode;
  /** Lowercase, without a leading `@` or `.`; empty outside `domains` mode. */
  domains: readonly string[];
  requestsAlso: boolean;
}

/** The default: invite only. */
export const INVITE_ONLY: NormalizedAccountCreation = Object.freeze({ mode: 'invite', domains: Object.freeze([]), requestsAlso: false });

/** Thrown when an `accountCreation` setting can't be used. */
export class AccountCreationConfigError extends Error {
  constructor(message: string) {
    super(`auth-kit: ${message}`);
    this.name = 'AccountCreationConfigError';
  }
}

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A domain-list entry, normalized, or a reason it can't be one. */
function normalizeDomain(raw: unknown, label: string): string {
  if (typeof raw !== 'string') throw new AccountCreationConfigError(`${label} entries must be text.`);
  const domain = raw.trim().toLowerCase().replace(/^[@.]/, '');
  if (domain.length === 0 || domain.length > 253) throw new AccountCreationConfigError(`${label} entry "${raw}" isn't a domain.`);
  if (!domain.split('.').every((part) => LABEL_RE.test(part))) {
    throw new AccountCreationConfigError(`${label} entry "${raw}" isn't a domain (letters, digits, and hyphens between dots).`);
  }
  return domain;
}

/**
 * Checks the setting and fills in its defaults. Omitted means invite only. Throws
 * `AccountCreationConfigError`, naming the problem, on anything it can't use: an unknown mode, a
 * domain list outside `domains` mode (it would do nothing, which reads like a mistake), an empty list
 * in `domains` mode, or a malformed domain.
 */
export function normalizeAccountCreation(input: AccountCreationSettings | undefined, label = 'accountCreation'): NormalizedAccountCreation {
  if (input === undefined) return INVITE_ONLY;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new AccountCreationConfigError(`${label} must be an object: { mode: 'invite' | 'request' | 'domains' | 'open', domains?, requestsAlso? }.`);
  }
  const raw = input as AccountCreationSettings & Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (key !== 'mode' && key !== 'domains' && key !== 'requestsAlso') throw new AccountCreationConfigError(`${label} has no option "${key}".`);
  }
  const mode = raw.mode;
  if (!(ACCOUNT_CREATION_MODES as readonly unknown[]).includes(mode)) {
    throw new AccountCreationConfigError(`${label}.mode must be 'invite', 'request', 'domains', or 'open' (got ${JSON.stringify(mode)}).`);
  }
  if (raw.requestsAlso !== undefined && typeof raw.requestsAlso !== 'boolean') throw new AccountCreationConfigError(`${label}.requestsAlso must be true or false.`);
  if (mode !== 'domains') {
    if (raw.domains !== undefined) throw new AccountCreationConfigError(`${label}.domains applies only to mode 'domains'.`);
    if (raw.requestsAlso !== undefined) throw new AccountCreationConfigError(`${label}.requestsAlso applies only to mode 'domains' (mode 'request' takes requests from everyone).`);
    return Object.freeze({ mode, domains: Object.freeze([]), requestsAlso: false });
  }
  if (!Array.isArray(raw.domains) || raw.domains.length === 0) {
    throw new AccountCreationConfigError(`${label}.domains must list at least one domain in mode 'domains'.`);
  }
  const domains = [...new Set(raw.domains.map((d: unknown) => normalizeDomain(d, `${label}.domains`)))];
  return Object.freeze({ mode, domains: Object.freeze(domains), requestsAlso: raw.requestsAlso === true });
}

/** The domain part of an address, lowercase, or '' when there's no `@`. */
export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return at < 0 ? '' : email.slice(at + 1).trim().toLowerCase();
}

/**
 * True when the address is on the list: its domain is an entry, or a subdomain of one (on a label
 * boundary: `nc.gov` takes `osbm.nc.gov` but not `evilnc.gov`).
 */
export function emailDomainAllowed(email: string, domains: readonly string[]): boolean {
  const domain = emailDomain(email);
  if (domain === '') return false;
  return domains.some((entry) => domain === entry || domain.endsWith(`.${entry}`));
}

/** True when people can create their own account (`domains` or `open`). */
export function allowsSelfSignUp(settings: NormalizedAccountCreation): boolean {
  return settings.mode === 'domains' || settings.mode === 'open';
}

/** True when the site takes access requests (`request`, or `domains` with `requestsAlso`). */
export function takesAccessRequests(settings: NormalizedAccountCreation): boolean {
  return settings.mode === 'request' || (settings.mode === 'domains' && settings.requestsAlso);
}

/** May this address create its own account here? (`domains` checks the list; `open` takes anyone.) */
export function mayCreateOwnAccount(email: string, settings: NormalizedAccountCreation): boolean {
  if (settings.mode === 'open') return true;
  if (settings.mode === 'domains') return emailDomainAllowed(email, settings.domains);
  return false;
}

/** A list in words with the Oxford comma: "a", "a or b", "a, b, or c" (register P8). */
export function listInWords(items: readonly string[], conjunction: 'and' | 'or' = 'or'): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} ${conjunction} ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, ${conjunction} ${items[items.length - 1]}`;
}

/** The domain list as people read it: `nc.gov`, and a bare top-level domain as `.edu`. */
export function domainsInWords(domains: readonly string[]): string {
  return listInWords(domains.map((d) => (d.includes('.') ? d : `.${d}`)));
}

/**
 * The words for an address outside the list (Card Studio's sign-up error, from the list): "Example
 * Reports accounts are for nc.gov addresses. Use one of those, or ask for access." The list is public,
 * so this says nothing about who has an account.
 */
export function notOnListMessage(siteName: string, domains: readonly string[], requestsAlso: boolean): string {
  return `${siteName} accounts are for ${domainsInWords(domains)} addresses. Use one of those${requestsAlso ? ', or ask for access' : ', or ask the person who runs it to add you'}.`;
}

/** The custom attribute a sign-up account carries, set once by the server (immutable). */
export const SIGN_UP_ORIGIN_ATTRIBUTE = 'custom:authkit_origin';
/** Its value on accounts the sign-up route created. Admin invites don't carry the attribute. */
export const SIGN_UP_ORIGIN_VALUE = 'signup';

/** What the sign-up and request routes answer, as JSON (`auth-kit/accounts`). The same `{ ok: true }` for every address that gets that far. */
export type AccountCreationBody =
  | { ok: true }
  | {
      ok: false;
      code: 'invalid' | 'not_on_list' | 'not_available' | 'rate_limited' | 'origin' | 'unavailable';
      error: string;
      /** The field the error is about. */
      field?: 'email' | 'name' | 'reason';
      /** `not_on_list`: the site takes requests from addresses not on the list (offer "Ask for access instead"). */
      requestAccess?: boolean;
      retryAfterSeconds?: number;
    };
