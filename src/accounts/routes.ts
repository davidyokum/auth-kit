/**
 * The sign-up and request-access routes (register D1–D3, ADR 0023): route handlers a site mounts at
 * `app/api/auth/sign-up/route.ts` and `app/api/auth/request-access/route.ts`.
 *
 * **Sign-up is a self-invite.** Cognito's own `SignUp` stays off; this route does what an admin's
 * invite does, on the server: it checks the address (and, in `domains` mode, the domain list),
 * rate-limits per address and per IP, and either creates the account with invite-core's
 * `createInvitedAccount` (no password, no group, marked `custom:authkit_origin = signup`) or, when
 * the address already has an account, emails it "you already have an account". Either way the answer
 * is the same, and takes at least `minimumResponseMs`. The browser then runs the invite's emailed-code
 * sign-in, and the required "Choose how you'll sign in next time". An account whose address is never
 * verified is deleted after 24 hours (`UnverifiedAccountSweep`).
 *
 * **Request access** files a request (name, email, an optional reason) in the app's DynamoDB, never
 * as a Cognito user, or emails an address that already has an account. The same answer every time.
 *
 * Both answer only same-origin POSTs with a JSON body, and sit behind the optional WAF rules
 * (`accountCreationWafRules`): a silent challenge and a per-IP limit.
 */
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { InputError, emailOf, record, text } from '../admin/action-kit.js';
import { type AuditLogStore, runAudited } from '../admin/audit.js';
import { ACCOUNT_AUDIT_ACTIONS, SIGN_UP_ACTOR } from '../admin/audit-actions.js';
import { describeAwsError } from '../admin/aws-errors.js';
import { CognitoAdmin } from '../admin/cognito-admin.js';
import { createInvitedAccount } from '../admin/invite-core.js';
import type { EmailSender } from '../admin/mailer.js';
import { type QuotaLimiterOptions, type Sleep, createQuotaLimiter, realSleep } from '../admin/quota.js';
import {
  type AccountCreationBody,
  type AccountCreationSettings,
  type NormalizedAccountCreation,
  SIGN_UP_ORIGIN_VALUE,
  allowsSelfSignUp,
  mayCreateOwnAccount,
  notOnListMessage,
  normalizeAccountCreation,
  takesAccessRequests,
} from '../shared/account-creation.js';
import { existingAccountEmail } from '../shared/emails.js';
import { ACCOUNT_CREATION_POLICY, type RateLimitRule } from '../shared/policy.js';
import { type AuthTheme, type ThemeFamily, resolveTheme } from '../themes/index.js';
import { type SignInHelpSource, helpAddressOf } from './sign-in-help.js';
import { type AccessRequestStore, type RateLimitStore, rateLimitKey } from './stores.js';

export interface AccountCreationRoutesConfig {
  /** The same setting the preset uses. */
  accountCreation: AccountCreationSettings;
  siteName: string;
  /** Absolute https sign-in URL (http only on localhost): the emails link to it, and its origin is the allowed one. */
  signInUrl: string;
  /** The site's family or theme (emails, the email hint in messages). Default personal. */
  theme?: AuthTheme | ThemeFamily;
  /** The help address in effect: an address, or `createSignInHelp` (a Super admin's override). Required. */
  help: SignInHelpSource;
  /** The pool accounts are made in. */
  pool: { userPoolId: string; region?: string };
  auditLog: AuditLogStore;
  /** Sends "you already have an account" (`createSesInviteMailer` is one). */
  mailer: EmailSender;
  /** Per-address and per-IP counters (`createDynamoRateLimitStore` on `RateLimitTable`). */
  rateLimits: RateLimitStore;
  /** The request queue (`createDynamoAccessRequestStore` on `AccessRequestTable`). Required where the site takes requests. */
  requests?: AccessRequestStore;
  /** Origins allowed to POST. Default: the sign-in URL's origin. */
  allowedOrigins?: readonly string[];
  /**
   * The client's IP for the per-IP limit. Default: the first `X-Forwarded-For` entry, else
   * `X-Real-IP`. A client can forge those, so the WAF rule (which sees the real address) is the
   * per-IP limit that can't be dodged; this one is the second layer.
   */
  clientIp?: (request: Request) => string | undefined;
  /** Every answer takes at least this long. Default 800 ms (`ACCOUNT_CREATION_POLICY`). */
  minimumResponseMs?: number;
  /** Override the limits (`ACCOUNT_CREATION_POLICY.rateLimits`). */
  rateLimitRules?: Partial<Record<'signUpPerAddress' | 'signUpPerIp' | 'requestPerAddress' | 'requestPerIp', RateLimitRule>>;
  /** Inject a Cognito client (tests). */
  cognito?: CognitoIdentityProviderClient;
  quota?: QuotaLimiterOptions;
  now?: () => number;
  sleep?: Sleep;
  /**
   * Hand the existing-account email to the platform to finish after the answer (`after` from
   * `next/server`, or a Lambda's `waitUntil`), so a slow SES call can't make an address with an account
   * answer later than a new one. Without it, the email is sent before answering, inside the
   * response-time floor (which covers SES's usual speed).
   */
  background?: (task: Promise<unknown>) => void;
  /** Failures the routes don't show (an email that couldn't be sent to an existing account, a store that failed). */
  onError?: (error: unknown, context: string) => void;
}

export type { AccountCreationBody };

export interface AccountCreationResult {
  status: 200 | 400 | 403 | 404 | 405 | 413 | 415 | 429 | 503;
  body: AccountCreationBody;
}

export interface RequestFacts {
  ip?: string;
  userAgent?: string;
  requestId?: string;
}

export interface AccountCreationRoutes {
  /** `POST` handler for the sign-up route. */
  signUp(request: Request): Promise<Response>;
  /** `POST` handler for the request-access route. */
  requestAccess(request: Request): Promise<Response>;
  /** The same logic without HTTP (tests, or a server action), with no response-time floor. */
  handleSignUp(input: unknown, facts?: RequestFacts): Promise<AccountCreationResult>;
  handleRequestAccess(input: unknown, facts?: RequestFacts): Promise<AccountCreationResult>;
  readonly settings: NormalizedAccountCreation;
}

const MAX_BODY_BYTES = 4096;

function defaultClientIp(request: Request): string | undefined {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || request.headers.get('x-real-ip')?.trim() || undefined;
}

const ok = (): AccountCreationResult => ({ status: 200, body: { ok: true } });
const refuse = (status: AccountCreationResult['status'], body: Extract<AccountCreationBody, { ok: false }>): AccountCreationResult => ({ status, body });

export { notOnListMessage };

function waitMessage(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `Too many attempts. Wait ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}, then try again.`;
}

export function createAccountCreationRoutes(config: AccountCreationRoutesConfig): AccountCreationRoutes {
  const settings = normalizeAccountCreation(config.accountCreation);
  if (!config.siteName?.trim()) throw new Error('auth-kit: createAccountCreationRoutes needs a siteName.');
  if (settings.mode === 'invite') throw new Error("auth-kit: accountCreation mode 'invite' has no sign-up or request routes.");
  if (takesAccessRequests(settings) && !config.requests) throw new Error('auth-kit: this site takes access requests: pass requests (createDynamoAccessRequestStore).');
  if (typeof config.help !== 'string' && typeof config.help?.effective !== 'function') throw new Error('auth-kit: createAccountCreationRoutes needs help (the help address, or createSignInHelp).');
  let signInUrl: URL;
  try {
    signInUrl = new URL(config.signInUrl);
  } catch {
    throw new Error('auth-kit: signInUrl must be an absolute URL.');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(signInUrl.hostname) || signInUrl.hostname.endsWith('.localhost');
  if (signInUrl.protocol !== 'https:' && !(signInUrl.protocol === 'http:' && local)) throw new Error('auth-kit: signInUrl must use https (http only on localhost).');
  const allowedOrigins = new Set(config.allowedOrigins ?? [signInUrl.origin]);
  const theme = resolveTheme(config.theme);
  const now = config.now ?? Date.now;
  const sleep = config.sleep ?? realSleep;
  const floor = config.minimumResponseMs ?? ACCOUNT_CREATION_POLICY.minimumResponseMs;
  const rules = { ...ACCOUNT_CREATION_POLICY.rateLimits, ...config.rateLimitRules };
  const region = config.pool.region ?? config.pool.userPoolId.split('_')[0];
  let client = config.cognito;
  let admin: CognitoAdmin | undefined;
  const cognito = () =>
    (admin ??= new CognitoAdmin((client ??= new CognitoIdentityProviderClient({ region, maxAttempts: 1 })), config.pool.userPoolId, createQuotaLimiter({ ...(config.sleep !== undefined && { sleep: config.sleep }), ...config.quota }), {
      signUpOrigin: allowsSelfSignUp(settings),
    }));
  const report = (error: unknown, context: string) => {
    try {
      config.onError?.(error, context);
    } catch {
      // A broken error hook must not break a route.
    }
  };
  const site = async () => ({ siteName: config.siteName, theme, signInUrl: signInUrl.toString(), helpEmail: await helpAddressOf(config.help) });

  function badEmail(raw: unknown): Extract<AccountCreationBody, { ok: false }> {
    const empty = typeof raw !== 'string' || raw.trim() === '';
    return { ok: false, code: 'invalid', field: 'email', error: empty ? 'Enter your email address' : `Enter an email address like ${theme.emailHint}` };
  }

  /** Both limits; the first that's over wins. A store that can't count is a refusal (fail closed). */
  async function limited(route: 'sign-up' | 'request', email: string, ip: string | undefined): Promise<AccountCreationResult | null> {
    const at = new Date(now());
    const perAddress = route === 'sign-up' ? rules.signUpPerAddress : rules.requestPerAddress;
    const perIp = route === 'sign-up' ? rules.signUpPerIp : rules.requestPerIp;
    try {
      const checks = [config.rateLimits.hit(rateLimitKey(`${route}:address`, email), perAddress, at)];
      if (ip) checks.push(config.rateLimits.hit(rateLimitKey(`${route}:ip`, ip), perIp, at));
      const results = await Promise.all(checks);
      const over = results.find((r) => !r.allowed);
      if (over) return refuse(429, { ok: false, code: 'rate_limited', error: waitMessage(over.retryAfterSeconds), retryAfterSeconds: over.retryAfterSeconds });
      return null;
    } catch (error) {
      report(error, `${route}: rate limit`);
      return refuse(503, { ok: false, code: 'unavailable', error: 'We couldn’t check this request just now. Try again in a few minutes.' });
    }
  }

  async function tellExisting(email: string, via: 'sign-up' | 'request'): Promise<void> {
    const task = (async () => {
      try {
        const s = await site();
        await config.mailer.sendEmail({ to: [email], email: existingAccountEmail(s, { email, via }), replyTo: [s.helpEmail] });
      } catch (error) {
        // The answer is the same either way (D3); the failure goes to the site's error hook.
        report(error, `${via}: the existing-account email`);
      }
    })();
    if (config.background) config.background(task);
    else await task;
  }

  async function handleSignUp(input: unknown, facts: RequestFacts = {}): Promise<AccountCreationResult> {
    if (!allowsSelfSignUp(settings)) return refuse(404, { ok: false, code: 'not_available', error: `${config.siteName} doesn’t take sign-ups.` });
    let email: string;
    let raw: Record<string, unknown> = {};
    try {
      raw = record(input);
      email = emailOf(raw.email);
    } catch {
      return refuse(400, badEmail(raw.email));
    }
    if (!mayCreateOwnAccount(email, settings)) {
      // The list is public, so saying an address isn't on it tells nobody who has an account.
      return refuse(403, { ok: false, code: 'not_on_list', field: 'email', error: notOnListMessage(config.siteName, settings.domains, settings.requestsAlso), requestAccess: settings.requestsAlso });
    }
    const limit = await limited('sign-up', email, facts.ip);
    if (limit) return limit;

    let existing;
    try {
      existing = await cognito().findByEmail(email);
    } catch (error) {
      report(error, 'sign-up: lookup');
      return refuse(503, { ok: false, code: 'unavailable', error: 'We couldn’t create your account just now. Try again in a few minutes.' });
    }
    if (existing) {
      // An address that asked before and never used its code counts as new: its next code is a fresh one.
      const unusedSignUp = existing.origin === SIGN_UP_ORIGIN_VALUE && !existing.emailVerified && existing.enabled;
      if (!unusedSignUp) await tellExisting(email, 'sign-up');
      return ok();
    }

    const run = await runAudited(
      config.auditLog,
      {
        intent: {
          actor: SIGN_UP_ACTOR,
          action: ACCOUNT_AUDIT_ACTIONS.signUp,
          target: { email },
          before: null,
          after: { email, origin: SIGN_UP_ORIGIN_VALUE, status: 'unverified', role: 'member' },
          calls: ['AdminCreateUser'],
          ...(facts.requestId !== undefined && { requestId: facts.requestId }),
          ...((facts.ip ?? facts.userAgent) !== undefined && {
            context: { ...(facts.ip !== undefined && { ip: facts.ip }), ...(facts.userAgent !== undefined && { userAgent: facts.userAgent }) },
          }),
        },
        run: async (steps) => {
          // The invite's account step: no password, no email_verified, no group (Member), and the sign-up mark.
          const created = await createInvitedAccount(steps, cognito(), { email, mode: 'emailed-code', origin: SIGN_UP_ORIGIN_VALUE });
          return { value: created, target: { sub: created.sub, email }, after: { email, origin: SIGN_UP_ORIGIN_VALUE, status: 'unverified', role: 'member', createdAt: created.createdAt.toISOString() } };
        },
      },
      config.sleep ? { sleep: config.sleep } : {},
    );
    if (run.kind === 'done') return ok();
    if (run.kind === 'failed' && (run.error as { name?: string }).name === 'UsernameExistsException') {
      // Created a moment ago by another request: the same answer.
      return ok();
    }
    report(run.error, run.kind === 'not-started' ? 'sign-up: the audit intent row' : `sign-up: ${describeAwsError(run.error)}`);
    return refuse(503, { ok: false, code: 'unavailable', error: 'We couldn’t create your account just now. Try again in a few minutes.' });
  }

  async function handleRequestAccess(input: unknown, facts: RequestFacts = {}): Promise<AccountCreationResult> {
    if (!takesAccessRequests(settings) || !config.requests) return refuse(404, { ok: false, code: 'not_available', error: `${config.siteName} doesn’t take access requests.` });
    let raw: Record<string, unknown>;
    let name: string | undefined, reason: string | undefined;
    try {
      raw = record(input);
      name = text(raw.name, 'Name', ACCOUNT_CREATION_POLICY.nameMaxLength);
      reason = text(raw.reason, 'Reason', ACCOUNT_CREATION_POLICY.reasonMaxLength);
    } catch (error) {
      const field = error instanceof InputError && /^Reason/.test(error.message) ? 'reason' : 'name';
      return refuse(400, { ok: false, code: 'invalid', field, error: error instanceof InputError ? error.message : 'That request is invalid.' });
    }
    if (!name) return refuse(400, { ok: false, code: 'invalid', field: 'name', error: 'Enter your name' });
    let email: string;
    try {
      email = emailOf(raw.email);
    } catch {
      return refuse(400, badEmail(raw.email));
    }
    const limit = await limited('request', email, facts.ip);
    if (limit) return limit;

    let existing;
    try {
      existing = await cognito().findByEmail(email);
    } catch (error) {
      report(error, 'request: lookup');
      return refuse(503, { ok: false, code: 'unavailable', error: 'We couldn’t send your request just now. Try again in a few minutes.' });
    }
    if (existing) {
      await tellExisting(email, 'request');
      return ok();
    }
    try {
      await config.requests.create({ email, name, ...(reason !== undefined && { reason }), now: new Date(now()) });
    } catch (error) {
      report(error, 'request: store');
      return refuse(503, { ok: false, code: 'unavailable', error: 'We couldn’t send your request just now. Try again in a few minutes.' });
    }
    return ok();
  }

  async function serve(request: Request, handle: (input: unknown, facts: RequestFacts) => Promise<AccountCreationResult>): Promise<Response> {
    const started = now();
    const respond = async (result: AccountCreationResult): Promise<Response> => {
      // The floor applies to every answer past the origin check, so a new address and one with an account (an email instead of an account) take as long.
      const wait = floor - (now() - started);
      if (wait > 0) await sleep(wait);
      return Response.json(result.body, { status: result.status, headers: { 'cache-control': 'no-store', ...(result.status === 429 && result.body.ok === false && result.body.retryAfterSeconds !== undefined && { 'retry-after': String(result.body.retryAfterSeconds) }) } });
    };
    if (request.method !== 'POST') return Response.json({ ok: false, code: 'invalid', error: 'Use POST.' }, { status: 405, headers: { allow: 'POST', 'cache-control': 'no-store' } });
    const origin = request.headers.get('origin');
    if (!origin || !allowedOrigins.has(origin)) return Response.json({ ok: false, code: 'origin', error: 'This form only works on the site itself.' }, { status: 403, headers: { 'cache-control': 'no-store' } });
    if (!/^application\/json\b/i.test(request.headers.get('content-type') ?? '')) return respond(refuse(415, { ok: false, code: 'invalid', error: 'Send the form as JSON.' }));
    const declared = Number(request.headers.get('content-length') ?? '0');
    if (declared > MAX_BODY_BYTES) return respond(refuse(413, { ok: false, code: 'invalid', error: 'That request is too large.' }));
    let input: unknown;
    try {
      const body = await request.text();
      // Bytes, not UTF-16 code units: a body of multi-byte characters is up to three times its length.
      if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) return respond(refuse(413, { ok: false, code: 'invalid', error: 'That request is too large.' }));
      input = JSON.parse(body);
    } catch {
      return respond(refuse(400, { ok: false, code: 'invalid', error: 'That request is invalid.' }));
    }
    const ip = (config.clientIp ?? defaultClientIp)(request);
    const userAgent = request.headers.get('user-agent') ?? undefined;
    const requestId = request.headers.get('x-amzn-trace-id') ?? request.headers.get('x-request-id') ?? globalThis.crypto.randomUUID();
    return respond(await handle(input, { ...(ip !== undefined && { ip }), ...(userAgent !== undefined && { userAgent }), requestId }));
  }

  return {
    settings,
    signUp: (request) => serve(request, handleSignUp),
    requestAccess: (request) => serve(request, handleRequestAccess),
    handleSignUp,
    handleRequestAccess,
  };
}
