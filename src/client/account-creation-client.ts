/**
 * The browser side of the sign-up and request routes (`auth-kit/accounts`): posting the form, through
 * AWS WAF's silent challenge when the page loads its JavaScript integration (ADR 0023), and turning
 * the route's answer into words.
 */
import type { AccountCreationBody } from '../shared/account-creation.js';
import { ERRORS } from './copy.js';

/** The silent WAF challenge hook: AWS WAF's integration attaches its token to `fetch` calls it makes. */
interface AwsWafIntegration {
  fetch?: typeof fetch;
}

/**
 * `fetch` through AWS WAF's integration when the page has loaded it (`window.AwsWafIntegration`), so
 * a POST to a challenged route carries the token instead of failing the challenge; plain `fetch`
 * otherwise. A site's own `fetch` (tests, a wrapper) wins.
 */
export function wafAwareFetch(custom?: typeof fetch): typeof fetch {
  if (custom) return custom;
  const waf = typeof window === 'undefined' ? undefined : (window as unknown as { AwsWafIntegration?: AwsWafIntegration }).AwsWafIntegration;
  if (waf && typeof waf.fetch === 'function') return waf.fetch.bind(waf);
  return (input, init) => fetch(input, init);
}

/** What the screen does with the route's answer. */
export type PostOutcome = { ok: true } | { ok: false; body: Extract<AccountCreationBody, { ok: false }> | null; message: string };

/** Posts JSON to one of the routes. A network failure or an unreadable answer reads as "couldn't reach". */
export async function postAccountForm(url: string, payload: Record<string, unknown>, options: { fetch?: typeof fetch; helpAddress?: string } = {}): Promise<PostOutcome> {
  let response: Response;
  try {
    response = await wafAwareFetch(options.fetch)(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'same-origin',
    });
  } catch {
    return { ok: false, body: null, message: ERRORS.network(options.helpAddress !== undefined ? { helpAddress: options.helpAddress } : undefined) };
  }
  let body: AccountCreationBody | null;
  try {
    body = (await response.json()) as AccountCreationBody;
  } catch {
    body = null;
  }
  if (response.ok && body?.ok === true) return { ok: true };
  if (body && body.ok === false && typeof body.error === 'string') return { ok: false, body, message: body.error };
  // A WAF challenge that couldn't be solved, or something between us and the route.
  return { ok: false, body: null, message: response.status === 405 || response.status === 202 ? ERRORS.unknown : ERRORS.network(options.helpAddress !== undefined ? { helpAddress: options.helpAddress } : undefined) };
}

/** Where "Ask for access instead" hands the typed address to the request form (never the URL: no personal data in links). */
export const REQUEST_EMAIL_KEY = 'auth-kit:request-access-email';

export function handOffEmail(email: string): void {
  try {
    window.sessionStorage.setItem(REQUEST_EMAIL_KEY, email);
  } catch {
    // Blocked storage: the request form starts empty.
  }
}

export function takeHandedOffEmail(): string {
  try {
    const value = window.sessionStorage.getItem(REQUEST_EMAIL_KEY) ?? '';
    window.sessionStorage.removeItem(REQUEST_EMAIL_KEY);
    return value;
  } catch {
    return '';
  }
}
