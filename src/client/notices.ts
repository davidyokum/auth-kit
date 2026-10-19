/**
 * The browser side of account-change notices (register A10: on by default). After a passkey is added
 * or a password changes, the screens ask the site's notice route (`createAccountNoticeRoute` in
 * `auth-kit/accounts`) to email the account's own address, and say "We've emailed you a note about
 * this." only when it answered yes. Never blocks the flow: a missing route, a refusal, or a slow answer
 * (over 5 seconds) just means no line about an email.
 */
import { ACCOUNT_NOTICE_PATH, type AccountNoticeEvent } from '../shared/notices.js';
import { hrefOr } from './href.js';

/** Notices on (the default; `url` defaults to `/api/auth-kit/account-notice`), or `false` for a site that doesn't send them. */
export type AccountNotices = { url?: string; fetch?: typeof fetch } | false;

/** The checked notice settings, or null when the site turned them off. */
export function resolveNotices(notices: AccountNotices | undefined, label: string): { url: string; fetch?: typeof fetch } | null {
  if (notices === false) return null;
  return { url: hrefOr(`${label} notices.url`, notices?.url, ACCOUNT_NOTICE_PATH), ...(notices?.fetch !== undefined && { fetch: notices.fetch }) };
}

const TIMEOUT_MS = 5000;

/** Asks the notice route to send one. True only when it answered `{ ok: true }`. */
export async function sendAccountNotice(notices: { url: string; fetch?: typeof fetch } | null, event: AccountNoticeEvent): Promise<boolean> {
  if (!notices) return false;
  const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : undefined;
  try {
    const response = await (notices.fetch ?? fetch)(notices.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event }),
      credentials: 'same-origin',
      ...(controller && { signal: controller.signal }),
    });
    if (!response.ok) return false;
    const body = (await response.json().catch(() => null)) as { ok?: unknown } | null;
    return body?.ok === true;
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
