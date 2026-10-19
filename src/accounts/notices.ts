/**
 * Account-change notices (register A10, decided 2026-10-19: on by default): "A passkey was added to
 * your account" and "Your password was changed", emailed to the account's own address. The third,
 * "Your email address changed", goes to the old address from the email-change action itself
 * (`createSelfServiceActions`, and the People page's admin change).
 *
 * Cognito has no trigger for a new passkey or a changed password (both happen in the browser, with the
 * person's own token), so the screens (`SignIn`, `SignUp`, `MyAccount`) ask this route to send the
 * notice right after the change succeeds, and say "We've emailed you a note about this." only when it
 * answered yes. The route:
 *
 * - answers only same-origin POSTs with a JSON body (`{ "event": "passkey-added" | "password-changed" }`);
 * - needs a signed-in account, and emails only that account's own address (read from Cognito, never
 *   from the request);
 * - checks a passkey notice against the account's passkeys (one created in the last 15 minutes, read
 *   with the person's own token); a check it can't make still sends the notice, since telling the
 *   owner is the safe direction;
 * - is rate-limited per account (`ACCOUNT_CREATION_POLICY.rateLimits.noticePerAccount`).
 *
 * A notice is a courtesy to the account's owner, not a detection control: someone holding the session
 * can skip the request. Server-side changes (an admin's reset, an email change) send their own.
 */
import { CognitoIdentityProviderClient, ListWebAuthnCredentialsCommand } from '@aws-sdk/client-cognito-identity-provider';
import { CognitoAdmin } from '../admin/cognito-admin.js';
import type { EmailSender } from '../admin/mailer.js';
import { type QuotaLimiterOptions, createQuotaLimiter } from '../admin/quota.js';
import { type ServerAuth, accessTokenOf } from '../server/auth.js';
import { AuthUnavailableError, UnauthenticatedError } from '../server/errors.js';
import { type EmailSite, passkeyAddedEmail, passwordChangedEmail } from '../shared/emails.js';
import { ACCOUNT_CREATION_POLICY } from '../shared/policy.js';
import { type AuthTheme, type ThemeFamily, resolveTheme } from '../themes/index.js';
import { type SignInHelpSource, helpAddressOf } from './sign-in-help.js';
import { type RateLimitStore, rateLimitKey } from './stores.js';

import { ACCOUNT_NOTICE_EVENTS, type AccountNoticeEvent } from '../shared/notices.js';

export { ACCOUNT_NOTICE_EVENTS, ACCOUNT_NOTICE_PATH, type AccountNoticeEvent } from '../shared/notices.js';

/** A passkey notice needs a passkey created this recently. */
const PASSKEY_WINDOW_MS = 15 * 60 * 1000;
const MAX_BODY_BYTES = 1024;

export interface AccountNoticeRouteConfig<G extends string = string, C extends string = string> {
  auth: ServerAuth<G, C>;
  siteName: string;
  /** Absolute https sign-in URL (http only on localhost): the "only enter codes at" domain, and the allowed origin. */
  signInUrl: string;
  theme?: AuthTheme | ThemeFamily;
  /** The help address in effect (an address, or `createSignInHelp`). */
  help: SignInHelpSource;
  /** Sends the notice (`createSesInviteMailer`). */
  mailer: EmailSender;
  /** Limits notices per account (`RateLimitTable`). */
  rateLimits: RateLimitStore;
  /** Origins allowed to POST. Default: the sign-in URL's origin. */
  allowedOrigins?: readonly string[];
  cognito?: CognitoIdentityProviderClient;
  quota?: QuotaLimiterOptions;
  now?: () => number;
  onError?: (error: unknown, context: string) => void;
}

export type AccountNoticeBody = { ok: true } | { ok: false; code: string; error: string; retryAfterSeconds?: number };

export interface AccountNoticeRoute {
  /** The route handler: `export const POST = route.POST` in `app/api/auth-kit/account-notice/route.ts`. */
  POST(request: Request): Promise<Response>;
}

/** The account-change notice route (register A10). */
export function createAccountNoticeRoute<G extends string, C extends string>(config: AccountNoticeRouteConfig<G, C>): AccountNoticeRoute {
  if (!config.siteName?.trim()) throw new Error('auth-kit: createAccountNoticeRoute needs a siteName.');
  let signIn: URL;
  try {
    signIn = new URL(config.signInUrl);
  } catch {
    throw new Error('auth-kit: createAccountNoticeRoute needs signInUrl as an absolute URL.');
  }
  if (typeof config.rateLimits?.hit !== 'function') throw new Error('auth-kit: createAccountNoticeRoute needs rateLimits (createDynamoRateLimitStore).');
  if (typeof config.mailer?.sendEmail !== 'function') throw new Error('auth-kit: createAccountNoticeRoute needs a mailer (createSesInviteMailer).');
  const allowedOrigins = new Set(config.allowedOrigins ?? [signIn.origin]);
  const theme = resolveTheme(config.theme);
  const now = config.now ?? Date.now;
  let client = config.cognito;
  let admin: CognitoAdmin | undefined;
  const cognitoClient = () => (client ??= new CognitoIdentityProviderClient({ region: config.auth.pool.region, maxAttempts: 1 }));
  const cognito = () => (admin ??= new CognitoAdmin(cognitoClient(), config.auth.pool.userPoolId, createQuotaLimiter(config.quota ?? {})));
  const report = (error: unknown, context: string) => {
    try {
      config.onError?.(error, context);
    } catch {
      // A broken error hook must not break the route.
    }
  };
  const answer = (status: number, body: AccountNoticeBody) =>
    Response.json(body, { status, headers: { 'cache-control': 'no-store', ...(body.ok === false && body.retryAfterSeconds !== undefined && { 'retry-after': String(body.retryAfterSeconds) }) } });

  /** False only when the passkeys read says no passkey is new; true when it agrees or couldn't be read. */
  async function passkeyIsNew(accessToken: string | undefined): Promise<boolean> {
    if (!accessToken) return true;
    try {
      const out = await cognitoClient().send(new ListWebAuthnCredentialsCommand({ AccessToken: accessToken, MaxResults: 20 }));
      const recent = now() - PASSKEY_WINDOW_MS;
      return (out.Credentials ?? []).some((c) => c.CreatedAt instanceof Date && c.CreatedAt.getTime() >= recent);
    } catch (error) {
      report(error, 'account notice: passkeys read');
      return true;
    }
  }

  return {
    async POST(request) {
      if (request.method !== 'POST') return answer(405, { ok: false, code: 'invalid', error: 'Use POST.' });
      const origin = request.headers.get('origin');
      if (!origin || !allowedOrigins.has(origin)) return answer(403, { ok: false, code: 'origin', error: 'This only works on the site itself.' });
      if (!/^application\/json\b/i.test(request.headers.get('content-type') ?? '')) return answer(415, { ok: false, code: 'invalid', error: 'Send JSON.' });
      let event: AccountNoticeEvent;
      try {
        const text = await request.text();
        if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return answer(413, { ok: false, code: 'invalid', error: 'That request is too large.' });
        const raw = (JSON.parse(text) as { event?: unknown } | null)?.event;
        if (!(ACCOUNT_NOTICE_EVENTS as readonly unknown[]).includes(raw)) throw new Error('event');
        event = raw as AccountNoticeEvent;
      } catch {
        return answer(400, { ok: false, code: 'invalid', error: 'That request is invalid.' });
      }
      let sub: string;
      let accessToken: string | undefined;
      try {
        // The first-credential chooser posts right after the account's first passkey or password.
        const user = await config.auth.requireUser({ allowFirstCredentialEnrollment: true });
        sub = user.sub;
        accessToken = accessTokenOf(user);
      } catch (error) {
        if (error instanceof UnauthenticatedError) return answer(401, { ok: false, code: 'unauthenticated', error: 'Sign in again.' });
        if (error instanceof AuthUnavailableError) return answer(503, { ok: false, code: 'unavailable', error: 'We couldn’t check your sign-in just now.' });
        return answer(403, { ok: false, code: 'forbidden', error: 'Not allowed.' });
      }
      try {
        const limit = await config.rateLimits.hit(rateLimitKey(`notice:${event}`, sub), ACCOUNT_CREATION_POLICY.rateLimits.noticePerAccount, new Date(now()));
        if (!limit.allowed) return answer(429, { ok: false, code: 'rate_limited', error: 'Too many notices just now.', retryAfterSeconds: limit.retryAfterSeconds });
        if (event === 'passkey-added' && !(await passkeyIsNew(accessToken))) return answer(409, { ok: false, code: 'nothing_changed', error: 'No new passkey on this account.' });
        const person = await cognito().findBySub(sub);
        if (!person?.email) return answer(404, { ok: false, code: 'not_found', error: 'This account has no email address.' });
        const site: EmailSite = { siteName: config.siteName, theme, signInUrl: config.signInUrl, helpEmail: await helpAddressOf(config.help) };
        const at = new Date(now());
        const email = event === 'passkey-added' ? passkeyAddedEmail(site, { at }) : passwordChangedEmail(site, { at });
        await config.mailer.sendEmail({ to: [person.email], email, replyTo: [site.helpEmail] });
        return answer(200, { ok: true });
      } catch (error) {
        report(error, `account notice: ${event}`);
        return answer(503, { ok: false, code: 'unavailable', error: 'We couldn’t send the notice just now.' });
      }
    },
  };
}
