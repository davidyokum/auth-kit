import { AdminCreateUserCommand, type AdminCreateUserCommandInput } from '@aws-sdk/client-cognito-identity-provider';
import { describe, expect, it } from 'vitest';
import {
  type AccountCreationBody,
  type AccountCreationRoutesConfig,
  type AccountCreationSettings,
  type RateLimitStore,
  createAccountCreationRoutes,
  createMemoryAccessRequestStore,
  createMemoryRateLimitStore,
  forwardedForClientIp,
  notOnListMessage,
} from '../../src/accounts/index.js';
import { type AuditEvent, type AuditLogStore, type EmailSender, createMemoryAuditLog } from '../../src/admin/index.js';
import { awsError, fakeUserPool, NOW } from '../admin/people-fixture.js';

const SITE = 'Budget Reports';
const ORIGIN = 'https://reports.example.org';
const SIGN_IN_URL = `${ORIGIN}/sign-in`;
const HELP = 'help@example.org';
const FLOOR = 800;

type SentEmail = Parameters<EmailSender['sendEmail']>[0];

interface RoutesOptions {
  accountCreation?: AccountCreationSettings;
  theme?: AccountCreationRoutesConfig['theme'];
  rateLimitRules?: AccountCreationRoutesConfig['rateLimitRules'];
  rateLimits?: RateLimitStore;
  /** Pass the request store (default true). */
  requests?: boolean;
  /** How long each audit append and each email take on the fake clock. */
  auditMs?: number;
  mailMs?: number;
  background?: AccountCreationRoutesConfig['background'];
  /** Emails wait for this before they "send". */
  mailGate?: Promise<void>;
  clientIp?: AccountCreationRoutesConfig['clientIp'];
  requireWafToken?: boolean;
  /** Lookups by email throw this (an unexpected failure inside the handler). */
  lookupThrows?: Error;
}

/**
 * The routes over the fake pool, in-memory stores, a recording mailer, and a fake clock that only
 * moves when something "takes time": the recorded sleep, an audit append, or an email.
 */
function setupRoutes(options: RoutesOptions = {}) {
  const clock = { t: NOW };
  const pool = fakeUserPool();
  const memory = createMemoryAuditLog({ now: () => clock.t });
  const auditLog: AuditLogStore & { readonly rows: readonly AuditEvent[]; failNextAppends(n: number): void } = {
    append(e) {
      clock.t += options.auditMs ?? 0;
      return memory.append(e);
    },
    list: (q) => memory.list(q),
    listActivity: (q) => memory.listActivity(q),
    failNextAppends: (n) => memory.failNextAppends(n),
    get rows() {
      return memory.rows;
    },
  };
  const requests = createMemoryAccessRequestStore();
  const emails: SentEmail[] = [];
  const mailFailures: Error[] = [];
  const mailer: EmailSender = {
    async sendEmail(message) {
      clock.t += options.mailMs ?? 0;
      if (options.mailGate) await options.mailGate;
      const failure = mailFailures.shift();
      if (failure) throw failure;
      emails.push(message);
    },
  };
  const sleeps: number[] = [];
  const errors: { error: unknown; context: string }[] = [];
  const routes = createAccountCreationRoutes({
    accountCreation: options.accountCreation ?? { mode: 'open' },
    siteName: SITE,
    signInUrl: SIGN_IN_URL,
    ...(options.theme !== undefined && { theme: options.theme }),
    help: HELP,
    pool: { userPoolId: 'us-east-1_TestPool1' },
    auditLog,
    mailer,
    rateLimits: options.rateLimits ?? createMemoryRateLimitStore(),
    ...(options.requests !== false && { requests }),
    ...(options.rateLimitRules !== undefined && { rateLimitRules: options.rateLimitRules }),
    ...(options.background !== undefined && { background: options.background }),
    clientIp: options.clientIp ?? forwardedForClientIp(),
    ...(options.requireWafToken !== undefined && { requireWafToken: options.requireWafToken }),
    cognito: pool.client,
    now: () => clock.t,
    sleep: (ms) => {
      sleeps.push(ms);
      clock.t += ms;
      return Promise.resolve();
    },
    onError: (error, context) => void errors.push({ error, context }),
  });
  return {
    routes,
    pool,
    auditLog,
    requests,
    emails,
    sleeps,
    errors,
    clock,
    failMail: (e: Error = awsError('MessageRejected', 'Email address is not verified.')) => void mailFailures.push(e),
  };
}

const BASE_HEADERS = {
  origin: ORIGIN,
  'content-type': 'application/json',
  // The last entry is the one Amplify Hosting's CloudFront appended: the client.
  'x-forwarded-for': '10.9.9.9, 203.0.113.7',
  'user-agent': 'Test Browser',
  'x-request-id': 'req-1',
  // The browser solved AWS WAF's challenge (required in open mode).
  cookie: 'theme=dark; aws-waf-token=test-token',
};

/** A browser's POST to one of the routes; `headers` replaces the defaults (null drops one). */
function post(route: 'sign-up' | 'request-access', body: unknown, headers: Record<string, string | null> = {}): Request {
  const merged = Object.entries({ ...BASE_HEADERS, ...headers }).filter((entry): entry is [string, string] => entry[1] !== null);
  return new Request(`${ORIGIN}/api/auth/${route}`, {
    method: 'POST',
    headers: Object.fromEntries(merged),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function json(response: Response): Promise<AccountCreationBody> {
  return (await response.json()) as AccountCreationBody;
}

const createInputs = (t: ReturnType<typeof setupRoutes>) => t.pool.inputsOf<AdminCreateUserCommandInput>(AdminCreateUserCommand);

describe('sign-up: a self-invite', () => {
  it.each([
    ['open', { mode: 'open' }],
    ['domains', { mode: 'domains', domains: ['example.org'] }],
  ] as const)('%s mode: a new address gets a no-password, unverified, groupless account, logged as the sign-up actor', async (_mode, accountCreation) => {
    const t = setupRoutes({ accountCreation });
    const response = await t.routes.signUp(post('sign-up', { email: '  New.Person@Example.org ' }));
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ ok: true });

    const creates = createInputs(t);
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({ Username: 'new.person@example.org', MessageAction: 'SUPPRESS' });
    expect(creates[0]!.TemporaryPassword).toBeUndefined();
    expect(creates[0]!.UserAttributes).toEqual([
      { Name: 'email', Value: 'new.person@example.org' },
      { Name: 'custom:authkit_origin', Value: 'signup' },
    ]);
    // No group: a sign-up is a Member.
    expect(t.pool.writes()).toEqual(['AdminCreateUserCommand']);
    expect(t.pool.users[0]).toMatchObject({ email: 'new.person@example.org', emailVerified: false, origin: 'signup' });
    expect(t.emails).toEqual([]);

    const [intent, result] = t.auditLog.rows;
    expect(t.auditLog.rows).toHaveLength(2);
    expect(intent).toMatchObject({
      phase: 'intent',
      actor: { sub: 'system:sign-up' },
      action: 'accounts.signUp',
      target: { email: 'new.person@example.org' },
      calls: ['AdminCreateUser'],
      requestId: 'req-1',
      context: { ip: '203.0.113.7', userAgent: 'Test Browser' },
    });
    expect(result).toMatchObject({
      phase: 'result',
      outcome: 'ok',
      actor: { sub: 'system:sign-up' },
      action: 'accounts.signUp',
      target: { sub: t.pool.users[0]!.sub, email: 'new.person@example.org' },
      after: { email: 'new.person@example.org', origin: 'signup', status: 'unverified', role: 'member' },
      calls: ['AdminCreateUser: ok'],
    });
  });

  it('an address with an account gets the same answer, no account, and one "you already have an account" email', async () => {
    const t = setupRoutes();
    t.pool.add({ sub: 'u-1', email: 'existing@example.org' });
    const fresh = await t.routes.signUp(post('sign-up', { email: 'fresh@example.org' }));
    const existing = await t.routes.signUp(post('sign-up', { email: 'existing@example.org' }));
    expect(existing.status).toBe(fresh.status);
    expect(await existing.text()).toBe(await fresh.text());

    expect(createInputs(t).map((c) => c.Username)).toEqual(['fresh@example.org']);
    expect(t.emails).toHaveLength(1);
    const [sent] = t.emails;
    expect(sent!.to).toEqual(['existing@example.org']);
    expect(sent!.replyTo).toEqual([HELP]);
    expect(sent!.email.subject).toBe(`You already have a ${SITE} account`);
    expect(sent!.email.text).toContain(`tried to create a ${SITE} account with this address`);
    expect(sent!.email.text).toContain(SIGN_IN_URL);
    expect(sent!.email.text).toContain(`Help: ${HELP}.`);
    // Only the new address's sign-up is logged.
    expect(t.auditLog.rows.map((r) => r.target?.email)).toEqual(['fresh@example.org', 'fresh@example.org']);
  });

  it('an address that signed up and never used its code counts as new: no second account, no email', async () => {
    const t = setupRoutes();
    t.pool.add({ sub: 'u-2', email: 'pending@example.org', origin: 'signup', emailVerified: false });
    expect(await t.routes.handleSignUp({ email: 'pending@example.org' })).toEqual({ status: 200, body: { ok: true } });
    expect(t.pool.writes()).toEqual([]);
    expect(t.emails).toEqual([]);
    expect(t.auditLog.rows).toEqual([]);

    // An admin's invite nobody used is a real account: it gets the existing-account email.
    t.pool.add({ sub: 'u-3', email: 'invited@example.org', emailVerified: false });
    expect(await t.routes.handleSignUp({ email: 'invited@example.org' })).toEqual({ status: 200, body: { ok: true } });
    expect(t.emails.map((e) => e.to)).toEqual([['invited@example.org']]);
  });

  it('answers a new address and one with an account identically, and both take at least the floor', async () => {
    // The new address spends 200 ms on its two audit rows; the existing one 300 ms on its email.
    const t = setupRoutes({ auditMs: 100, mailMs: 300 });
    t.pool.add({ sub: 'u-1', email: 'existing@example.org' });
    const answers: { status: number; text: string; cache: string | null; elapsed: number; slept: number[] }[] = [];
    for (const email of ['new@example.org', 'existing@example.org']) {
      const started = t.clock.t;
      const before = t.sleeps.length;
      const response = await t.routes.signUp(post('sign-up', { email }));
      answers.push({ status: response.status, text: await response.text(), cache: response.headers.get('cache-control'), elapsed: t.clock.t - started, slept: t.sleeps.slice(before) });
    }
    const [fresh, existing] = answers;
    expect(fresh).toMatchObject({ status: 200, text: '{"ok":true}', cache: 'no-store' });
    expect(existing!.status).toBe(fresh!.status);
    expect(existing!.text).toBe(fresh!.text);
    expect(existing!.cache).toBe(fresh!.cache);
    // Each waited out the rest of the floor, so both took exactly as long.
    expect(fresh!.slept).toEqual([FLOOR - 200]);
    expect(existing!.slept).toEqual([FLOOR - 300]);
    expect(fresh!.elapsed).toBe(FLOOR);
    expect(existing!.elapsed).toBe(FLOOR);
    expect(t.pool.users.map((u) => u.email)).toEqual(['existing@example.org', 'new@example.org']);
    expect(t.emails).toHaveLength(1);
  });

  it('the floor never shortens a slow answer, and the handlers without HTTP are floored too (L11)', async () => {
    const t = setupRoutes({ mailMs: 1200 });
    t.pool.add({ sub: 'u-1', email: 'existing@example.org' });
    const started = t.clock.t;
    expect((await t.routes.signUp(post('sign-up', { email: 'existing@example.org' }))).status).toBe(200);
    expect(t.sleeps).toEqual([]);
    expect(t.clock.t - started).toBe(1200);

    const handlerStarted = t.clock.t;
    expect(await t.routes.handleSignUp({ email: 'another@example.org' })).toEqual({ status: 200, body: { ok: true } });
    expect(t.clock.t - handlerStarted).toBe(FLOOR);
    const requestStarted = t.clock.t;
    expect((await t.routes.handleSignUp({ email: '' })).status).toBe(400);
    expect(t.clock.t - requestStarted).toBe(FLOOR);
  });

  it('every answer takes the floor: each refusal, an early HTTP refusal, and an unexpected error (M5)', async () => {
    const t = setupRoutes({ accountCreation: { mode: 'domains', domains: ['nc.gov'], requestsAlso: true }, rateLimitRules: { signUpPerAddress: { limit: 1, windowMinutes: 60 } } });
    const timed = async (request: Request) => {
      const started = t.clock.t;
      const response = await t.routes.signUp(request);
      return { status: response.status, elapsed: t.clock.t - started };
    };
    expect(await timed(new Request(`${ORIGIN}/api/auth/sign-up`, { method: 'GET', headers: { origin: ORIGIN } }))).toEqual({ status: 405, elapsed: FLOOR });
    expect(await timed(post('sign-up', { email: 'a@nc.gov' }, { origin: 'https://evil.example' }))).toEqual({ status: 403, elapsed: FLOOR });
    expect(await timed(post('sign-up', { email: 'a@nc.gov' }, { 'content-type': 'text/plain' }))).toEqual({ status: 415, elapsed: FLOOR });
    expect(await timed(post('sign-up', '{'))).toEqual({ status: 400, elapsed: FLOOR });
    expect(await timed(post('sign-up', { email: 'not-an-address' }))).toEqual({ status: 400, elapsed: FLOOR });
    expect(await timed(post('sign-up', { email: 'a@example.org' }))).toEqual({ status: 403, elapsed: FLOOR });
    expect(await timed(post('sign-up', { email: 'b@nc.gov' }))).toEqual({ status: 200, elapsed: FLOOR });
    expect(await timed(post('sign-up', { email: 'b@nc.gov' }))).toEqual({ status: 429, elapsed: FLOOR });

    // A handler that throws is a 503 in the same time, and the error hook hears of it.
    const broken = setupRoutes();
    broken.pool.mock.rejectsOnce(new TypeError('unexpected'));
    const started = broken.clock.t;
    const response = await broken.routes.signUp(post('sign-up', { email: 'c@example.org' }));
    expect(response.status).toBe(503);
    expect(broken.clock.t - started).toBe(FLOOR);
  });

  it('domains mode: the list decides on a label boundary, in words generated from the list', async () => {
    const t = setupRoutes({ accountCreation: { mode: 'domains', domains: ['nc.gov'] } });
    expect(await t.routes.handleSignUp({ email: 'a@osbm.nc.gov' })).toEqual({ status: 200, body: { ok: true } });
    expect(notOnListMessage(SITE, ['nc.gov'], false)).toBe(`${SITE} accounts are for nc.gov addresses. Use one of those, or ask the person who runs it to add you.`);
    // A bare top-level domain gets its dot.
    expect(notOnListMessage(SITE, ['unc.edu', 'edu'], false)).toBe(`${SITE} accounts are for unc.edu or .edu addresses. Use one of those, or ask the person who runs it to add you.`);
    for (const email of ['a@evilnc.gov', 'a@gmail.example']) {
      expect(await t.routes.handleSignUp({ email })).toEqual({
        status: 403,
        body: { ok: false, code: 'not_on_list', field: 'email', error: notOnListMessage(SITE, ['nc.gov'], false), requestAccess: false },
      });
    }
    expect(createInputs(t).map((c) => c.Username)).toEqual(['a@osbm.nc.gov']);

    const withRequests = setupRoutes({ accountCreation: { mode: 'domains', domains: ['nc.gov'], requestsAlso: true } });
    expect(notOnListMessage(SITE, ['nc.gov'], true)).toBe(`${SITE} accounts are for nc.gov addresses. Use one of those, or ask for access.`);
    expect(await withRequests.routes.handleSignUp({ email: 'a@evilnc.gov' })).toEqual({
      status: 403,
      body: { ok: false, code: 'not_on_list', field: 'email', error: notOnListMessage(SITE, ['nc.gov'], true), requestAccess: true },
    });
  });

  it('modes: invite has no routes, request takes no sign-ups, and domains without requestsAlso takes no requests', async () => {
    expect(() => setupRoutes({ accountCreation: { mode: 'invite' } })).toThrow("accountCreation mode 'invite' has no sign-up or request routes");
    expect(() => setupRoutes({ accountCreation: { mode: 'request' }, requests: false })).toThrow(/takes access requests: pass requests/);

    const request = setupRoutes({ accountCreation: { mode: 'request' } });
    const signUp = await request.routes.signUp(post('sign-up', { email: 'a@example.org' }));
    expect(signUp.status).toBe(404);
    expect(await json(signUp)).toEqual({ ok: false, code: 'not_available', error: `${SITE} doesn’t take sign-ups.` });

    const domains = setupRoutes({ accountCreation: { mode: 'domains', domains: ['example.org'] } });
    const asked = await domains.routes.requestAccess(post('request-access', { email: 'a@example.org', name: 'Ann' }));
    expect(asked.status).toBe(404);
    expect(await json(asked)).toEqual({ ok: false, code: 'not_available', error: `${SITE} doesn’t take access requests.` });
    expect(request.pool.writes()).toEqual([]);
    expect(domains.requests.all()).toEqual([]);
  });
});

describe('rate limits', () => {
  it('per address: over the limit is a 429 with Retry-After, whatever the case of the address', async () => {
    const t = setupRoutes({ rateLimitRules: { signUpPerAddress: { limit: 2, windowMinutes: 60 } } });
    for (let i = 0; i < 2; i++) expect((await t.routes.signUp(post('sign-up', { email: 'ann@example.org' }))).status).toBe(200);
    const limited = await t.routes.signUp(post('sign-up', { email: 'ANN@example.org' }));
    expect(limited.status).toBe(429);
    const body = await json(limited);
    // Two answers of 800 ms each into a window that started at NOW: 3598.4 seconds left.
    expect(body).toEqual({ ok: false, code: 'rate_limited', error: 'Too many attempts. Wait 60 minutes, then try again.', retryAfterSeconds: 3599 });
    expect(limited.headers.get('retry-after')).toBe('3599');
    expect(limited.headers.get('cache-control')).toBe('no-store');
    // Another address from the same IP still goes through.
    expect((await t.routes.signUp(post('sign-up', { email: 'bea@example.org' }))).status).toBe(200);
    expect(createInputs(t).map((c) => c.Username)).toEqual(['ann@example.org', 'bea@example.org']);
  });

  it('per IP: the client is the last X-Forwarded-For entry (the proxy’s); entries the client writes can’t dodge the limit (M1)', async () => {
    const t = setupRoutes({ rateLimitRules: { signUpPerIp: { limit: 2, windowMinutes: 60 } } });
    // The sender rotates the part of the header it controls; CloudFront appends the real address.
    const from = (forged: string) => ({ 'x-forwarded-for': `${forged}, 198.51.100.9` });
    expect((await t.routes.signUp(post('sign-up', { email: 'a@example.org' }, from('1.1.1.1')))).status).toBe(200);
    expect((await t.routes.signUp(post('sign-up', { email: 'b@example.org' }, from('2.2.2.2, 3.3.3.3')))).status).toBe(200);
    const limited = await t.routes.signUp(post('sign-up', { email: 'c@example.org' }, from('4.4.4.4')));
    expect(limited.status).toBe(429);
    expect(await json(limited)).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(limited.headers.get('retry-after')).toMatch(/^\d+$/);
    // Another client is counted separately.
    expect((await t.routes.signUp(post('sign-up', { email: 'c@example.org' }, { 'x-forwarded-for': '198.51.100.10' }))).status).toBe(200);
    expect(createInputs(t).map((c) => c.Username)).toEqual(['a@example.org', 'b@example.org', 'c@example.org']);
    // The audit row records the proxy-appended address, not the forged one.
    expect(t.auditLog.rows.filter((r) => r.phase === 'intent').map((r) => r.context?.ip)).toEqual(['198.51.100.9', '198.51.100.9', '198.51.100.10']);
  });

  it('forwardedForClientIp: the nth entry from the right, and anything that isn’t an address reads as unknown', () => {
    const req = (xff: string | null) => new Request(ORIGIN, { headers: xff === null ? {} : { 'x-forwarded-for': xff } });
    const last = forwardedForClientIp();
    expect(last(req('198.51.100.9'))).toBe('198.51.100.9');
    expect(last(req('6.6.6.6, 198.51.100.9'))).toBe('198.51.100.9');
    expect(last(req('6.6.6.6, 2001:DB8::1'))).toBe('2001:db8::1');
    expect(last(req('6.6.6.6, ::ffff:198.51.100.9'))).toBe('::ffff:198.51.100.9');
    expect(last(req(null))).toBeUndefined();
    expect(last(req('198.51.100.9, <script>'))).toBeUndefined();
    expect(last(req('198.51.100.9, ' + 'a'.repeat(5000)))).toBeUndefined();
    expect(forwardedForClientIp({ trustedProxies: 2 })(req('6.6.6.6, 198.51.100.9, 10.0.0.1'))).toBe('198.51.100.9');
    expect(forwardedForClientIp({ trustedProxies: 2 })(req('10.0.0.1'))).toBeUndefined();
    expect(() => forwardedForClientIp({ trustedProxies: 0 })).toThrow(/trustedProxies/);
  });

  it('clientIp is required: the routes refuse to start without a decision about proxies', () => {
    const base = { accountCreation: { mode: 'open' as const }, siteName: SITE, signInUrl: SIGN_IN_URL, help: HELP, pool: { userPoolId: 'us-east-1_TestPool1' }, auditLog: createMemoryAuditLog(), mailer: { sendEmail: () => Promise.resolve() }, rateLimits: createMemoryRateLimitStore() };
    expect(() => createAccountCreationRoutes(base as unknown as AccountCreationRoutesConfig)).toThrow(/needs clientIp.*forwardedForClientIp/);
  });

  it('per address: plus-addressing and Gmail’s dots reach one inbox, so they share one limit (M4)', async () => {
    const t = setupRoutes({ rateLimitRules: { signUpPerAddress: { limit: 2, windowMinutes: 60 } } });
    expect((await t.routes.signUp(post('sign-up', { email: 'victim+1@example.org' }, { 'x-forwarded-for': '198.51.100.1' }))).status).toBe(200);
    expect((await t.routes.signUp(post('sign-up', { email: 'Victim+2@example.org' }, { 'x-forwarded-for': '198.51.100.2' }))).status).toBe(200);
    expect((await t.routes.signUp(post('sign-up', { email: 'victim@example.org' }, { 'x-forwarded-for': '198.51.100.3' }))).status).toBe(429);
    const g = setupRoutes({ rateLimitRules: { signUpPerAddress: { limit: 1, windowMinutes: 60 } } });
    expect((await g.routes.signUp(post('sign-up', { email: 'jane.doe@gmail.com' }))).status).toBe(200);
    expect((await g.routes.signUp(post('sign-up', { email: 'janedoe+x@googlemail.com' }, { 'x-forwarded-for': '198.51.100.4' }))).status).toBe(429);
    // The accounts themselves keep the addresses as typed.
    expect(createInputs(t).map((c) => c.Username)).toEqual(['victim+1@example.org', 'victim+2@example.org']);
  });

  it('the site-wide breaker: past the hourly limit every address gets the same 503, decided before any lookup (M4)', async () => {
    const t = setupRoutes({ rateLimitRules: { signUpSite: { limit: 2, windowMinutes: 60 } } });
    t.pool.add({ sub: 'u-1', email: 'existing@example.org' });
    expect((await t.routes.signUp(post('sign-up', { email: 'a@example.org' }, { 'x-forwarded-for': '198.51.100.1' }))).status).toBe(200);
    expect((await t.routes.signUp(post('sign-up', { email: 'b@example.org' }, { 'x-forwarded-for': '198.51.100.2' }))).status).toBe(200);
    const lookupsBefore = t.pool.mock.calls().length;
    const answers = [];
    for (const [email, ip] of [['c@example.org', '198.51.100.3'], ['existing@example.org', '198.51.100.4']] as const) {
      const response = await t.routes.signUp(post('sign-up', { email }, { 'x-forwarded-for': ip }));
      const { retryAfterSeconds, ...body } = (await response.json()) as { retryAfterSeconds?: number };
      answers.push({ status: response.status, body, retry: response.headers.get('retry-after') === String(retryAfterSeconds) });
    }
    // The same answer (the seconds left only differ by the clock between the two requests).
    expect(answers[0]).toEqual(answers[1]);
    expect(answers[0]).toEqual({ status: 503, body: { ok: false, code: 'unavailable', error: 'Sign-ups are paused for a while. Try again later.' }, retry: true });
    expect(t.pool.mock.calls().length).toBe(lookupsBefore);
    expect(t.errors.map((e) => e.context)).toContain('sign-up: site-wide limit');
  });

  it('a counter store that fails is a 503, never a pass (fail closed)', async () => {
    const t = setupRoutes({ rateLimits: { hit: () => Promise.reject(new Error('DynamoDB unavailable')) } });
    const response = await t.routes.signUp(post('sign-up', { email: 'a@example.org' }));
    expect(response.status).toBe(503);
    expect(await json(response)).toEqual({ ok: false, code: 'unavailable', error: 'We couldn’t check this request just now. Try again in a few minutes.' });
    expect(t.pool.mock.calls()).toHaveLength(0);
    expect(t.errors.map((e) => e.context)).toEqual(['sign-up: rate limit']);

    const r = setupRoutes({ accountCreation: { mode: 'request' }, rateLimits: { hit: () => Promise.reject(new Error('DynamoDB unavailable')) } });
    expect(await r.routes.handleRequestAccess({ email: 'a@example.org', name: 'Ann' })).toMatchObject({ status: 503, body: { code: 'unavailable' } });
    expect(r.requests.all()).toEqual([]);
  });
});

describe('input', () => {
  it('an empty address, then a malformed one, with the theme’s example address', async () => {
    const t = setupRoutes();
    const empty = { status: 400, body: { ok: false, code: 'invalid', field: 'email', error: 'Enter your email address' } };
    expect(await t.routes.handleSignUp({ email: '' })).toEqual(empty);
    expect(await t.routes.handleSignUp({ email: '   ' })).toEqual(empty);
    expect(await t.routes.handleSignUp({})).toEqual(empty);
    expect(await t.routes.handleSignUp('not an object')).toEqual(empty);
    for (const email of ['name@', 'not-an-address', 'a b@example.org']) {
      expect(await t.routes.handleSignUp({ email })).toEqual({ status: 400, body: { ok: false, code: 'invalid', field: 'email', error: 'Enter an email address like name@example.com' } });
    }
    const osbm = setupRoutes({ theme: 'osbm' });
    expect(await osbm.routes.handleSignUp({ email: 'name@' })).toEqual({ status: 400, body: { ok: false, code: 'invalid', field: 'email', error: 'Enter an email address like name@osbm.nc.gov' } });
    expect(t.pool.mock.calls()).toHaveLength(0);
  });
});

describe('HTTP guards', () => {
  it('only same-origin POSTs with a small JSON body get as far as the handler', async () => {
    const t = setupRoutes();
    const cases: [Request, number, Partial<Extract<AccountCreationBody, { ok: false }>>][] = [
      [post('sign-up', { email: 'a@example.org' }, { origin: null }), 403, { code: 'origin', error: 'This form only works on the site itself.' }],
      [post('sign-up', { email: 'a@example.org' }, { origin: 'https://reports.example.org.evil.example' }), 403, { code: 'origin' }],
      [post('sign-up', { email: 'a@example.org' }, { origin: 'http://reports.example.org' }), 403, { code: 'origin' }],
      [new Request(`${ORIGIN}/api/auth/sign-up`, { method: 'GET', headers: { origin: ORIGIN } }), 405, { code: 'invalid', error: 'Use POST.' }],
      [post('sign-up', { email: 'a@example.org' }, { 'content-type': 'text/plain' }), 415, { code: 'invalid', error: 'Send the form as JSON.' }],
      [post('sign-up', { email: 'a@example.org' }, { 'content-type': null }), 415, { code: 'invalid' }],
      [post('sign-up', { email: 'a@example.org', padding: 'x'.repeat(4100) }), 413, { code: 'invalid', error: 'That request is too large.' }],
      [post('sign-up', { email: 'a@example.org' }, { 'content-length': '5000' }), 413, { code: 'invalid', error: 'That request is too large.' }],
      // Under 4096 characters, over 4096 bytes: the limit is on bytes.
      [post('sign-up', { email: 'a@example.org', padding: '€'.repeat(2000) }), 413, { code: 'invalid', error: 'That request is too large.' }],
      [post('sign-up', '{"email":'), 400, { code: 'invalid', error: 'That request is invalid.' }],
    ];
    for (const [request, status, body] of cases) {
      const response = await t.routes.signUp(request);
      expect(response.status, `${request.method} ${status}`).toBe(status);
      expect(await json(response)).toMatchObject({ ok: false, ...body });
      expect(response.headers.get('cache-control')).toBe('no-store');
      if (status === 405) expect(response.headers.get('allow')).toBe('POST');
    }
    expect(t.pool.mock.calls()).toHaveLength(0);
    expect(t.auditLog.rows).toEqual([]);

    const answered = await t.routes.signUp(post('sign-up', { email: 'a@example.org' }));
    expect(answered.status).toBe(200);
    expect(answered.headers.get('cache-control')).toBe('no-store');
    expect(answered.headers.get('content-type')).toMatch(/^application\/json/);
  });

  it('the request-access route has the same guards', async () => {
    const t = setupRoutes({ accountCreation: { mode: 'request' } });
    expect((await t.routes.requestAccess(post('request-access', { email: 'a@example.org', name: 'Ann' }, { origin: null }))).status).toBe(403);
    expect((await t.routes.requestAccess(post('request-access', '{'))).status).toBe(400);
    expect(t.requests.all()).toEqual([]);
  });
});

describe('failures', () => {
  it('a lookup that fails is a 503, and nothing is created', async () => {
    const t = setupRoutes();
    t.pool.failOn('ListUsersCommand', awsError('NotAuthorizedException', 'Not authorized.'));
    expect(await t.routes.handleSignUp({ email: 'a@example.org' })).toEqual({
      status: 503,
      body: { ok: false, code: 'unavailable', error: 'We couldn’t create your account just now. Try again in a few minutes.' },
    });
    expect(t.pool.writes()).toEqual([]);
    expect(t.auditLog.rows).toEqual([]);
    expect(t.errors.map((e) => e.context)).toEqual(['sign-up: lookup']);
  });

  it('an AdminCreateUser that fails is a 503, nothing stays created, and the result row says it failed', async () => {
    const t = setupRoutes();
    t.pool.failOn('AdminCreateUserCommand', awsError('InternalErrorException', 'Internal error'));
    expect(await t.routes.handleSignUp({ email: 'a@example.org' })).toMatchObject({ status: 503, body: { ok: false, code: 'unavailable' } });
    expect(t.pool.users).toEqual([]);
    expect(t.auditLog.rows.map((r) => [r.phase, r.outcome])).toEqual([
      ['intent', undefined],
      ['result', 'failed'],
    ]);
    expect(t.auditLog.rows[1]!.calls).toEqual(['AdminCreateUser: failed (InternalErrorException)']);
    expect(t.errors).toHaveLength(1);
    expect(t.errors[0]!.context).toMatch(/^sign-up: /);
  });

  it('an audit intent row that can’t be written is a 503, and no account is created', async () => {
    const t = setupRoutes();
    t.auditLog.failNextAppends(1);
    expect(await t.routes.handleSignUp({ email: 'a@example.org' })).toMatchObject({ status: 503, body: { ok: false, code: 'unavailable' } });
    expect(createInputs(t)).toEqual([]);
    expect(t.pool.users).toEqual([]);
    expect(t.errors.map((e) => e.context)).toEqual(['sign-up: the audit intent row']);
  });

  it('an existing-account email that fails still answers 200 (the same answer), and the error hook hears of it', async () => {
    const t = setupRoutes();
    t.pool.add({ sub: 'u-1', email: 'existing@example.org' });
    t.failMail();
    const response = await t.routes.signUp(post('sign-up', { email: 'existing@example.org' }));
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ ok: true });
    expect(t.errors.map((e) => e.context)).toEqual(['sign-up: the existing-account email']);
    expect((t.errors[0]!.error as Error).name).toBe('MessageRejected');
  });

  it('an account created a moment ago by another request (UsernameExistsException) is the same answer', async () => {
    const t = setupRoutes();
    t.pool.failOn('AdminCreateUserCommand', awsError('UsernameExistsException', 'An account with the given email already exists.'));
    expect(await t.routes.handleSignUp({ email: 'a@example.org' })).toEqual({ status: 200, body: { ok: true } });
    expect(t.errors).toEqual([]);
  });
});

describe('request access', () => {
  it('files a request with the name and reason, and creates no account', async () => {
    const t = setupRoutes({ accountCreation: { mode: 'request' } });
    const response = await t.routes.requestAccess(post('request-access', { email: ' Rita@Example.org', name: '  Rita Example ', reason: 'Quarterly budget reports' }));
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ ok: true });
    expect(t.requests.all()).toEqual([
      expect.objectContaining({ email: 'rita@example.org', name: 'Rita Example', reason: 'Quarterly budget reports', status: 'pending', createdAt: new Date(NOW).toISOString() }),
    ]);
    expect(t.pool.writes()).toEqual([]);
    expect(t.emails).toEqual([]);
  });

  it('an address with an account gets the existing-account email in the request wording, and no request is filed', async () => {
    const t = setupRoutes({ accountCreation: { mode: 'request' } });
    t.pool.add({ sub: 'u-1', email: 'existing@example.org' });
    const fresh = await t.routes.requestAccess(post('request-access', { email: 'fresh@example.org', name: 'Fay' }));
    const existing = await t.routes.requestAccess(post('request-access', { email: 'existing@example.org', name: 'Eve', reason: 'Reports' }));
    expect(existing.status).toBe(fresh.status);
    expect(await existing.text()).toBe(await fresh.text());
    expect(t.requests.all().map((r) => r.email)).toEqual(['fresh@example.org']);
    expect(t.emails).toHaveLength(1);
    expect(t.emails[0]!.to).toEqual(['existing@example.org']);
    expect(t.emails[0]!.replyTo).toEqual([HELP]);
    expect(t.emails[0]!.email.subject).toBe(`You already have a ${SITE} account`);
    expect(t.emails[0]!.email.text).toContain(`asked for access to ${SITE} with this address`);
    expect(t.emails[0]!.email.text).not.toContain('tried to create');
  });

  it('a second request for an address already waiting files nothing new, with the same answer', async () => {
    const t = setupRoutes({ accountCreation: { mode: 'domains', domains: ['nc.gov'], requestsAlso: true } });
    expect(await t.routes.handleRequestAccess({ email: 'ann@example.org', name: 'Ann' })).toEqual({ status: 200, body: { ok: true } });
    expect(await t.routes.handleRequestAccess({ email: 'ann@example.org', name: 'Ann again', reason: 'Still waiting' })).toEqual({ status: 200, body: { ok: true } });
    expect(t.requests.all()).toEqual([expect.objectContaining({ email: 'ann@example.org', name: 'Ann' })]);
    expect(t.requests.all()[0]!.reason).toBeUndefined();
  });

  it('needs a name; the reason is at most 500 characters; the address is checked like sign-up’s', async () => {
    const t = setupRoutes({ accountCreation: { mode: 'request' } });
    expect(await t.routes.handleRequestAccess({ email: 'a@example.org' })).toEqual({ status: 400, body: { ok: false, code: 'invalid', field: 'name', error: 'Enter your name' } });
    expect(await t.routes.handleRequestAccess({ email: 'a@example.org', name: '   ' })).toMatchObject({ status: 400, body: { field: 'name', error: 'Enter your name' } });
    expect(await t.routes.handleRequestAccess({ email: 'a@example.org', name: 'Ann', reason: 'r'.repeat(501) })).toEqual({
      status: 400,
      body: { ok: false, code: 'invalid', field: 'reason', error: 'Reason is too long (at most 500 characters).' },
    });
    expect(await t.routes.handleRequestAccess({ email: 'a@example.org', name: 'n'.repeat(101) })).toMatchObject({ status: 400, body: { field: 'name' } });
    expect(await t.routes.handleRequestAccess({ email: 'a@', name: 'Ann' })).toEqual({
      status: 400,
      body: { ok: false, code: 'invalid', field: 'email', error: 'Enter an email address like name@example.com' },
    });
    expect(await t.routes.handleRequestAccess({ email: 'a@example.org', name: 'Ann', reason: 'r'.repeat(500) })).toEqual({ status: 200, body: { ok: true } });
    expect(t.requests.all()).toHaveLength(1);
  });

  it('per address: over the limit is a 429', async () => {
    const t = setupRoutes({ accountCreation: { mode: 'request' }, rateLimitRules: { requestPerAddress: { limit: 1, windowMinutes: 24 * 60 } } });
    expect((await t.routes.requestAccess(post('request-access', { email: 'ann@example.org', name: 'Ann' }))).status).toBe(200);
    const limited = await t.routes.requestAccess(post('request-access', { email: 'ann@example.org', name: 'Ann' }));
    expect(limited.status).toBe(429);
    const body = await json(limited);
    expect(body).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(limited.headers.get('retry-after')).toBe(String(body.ok === false && body.retryAfterSeconds));
  });

  it('a request store that fails is a 503', async () => {
    const t = setupRoutes({ accountCreation: { mode: 'request' } });
    t.requests.create = () => Promise.reject(new Error('DynamoDB unavailable'));
    expect(await t.routes.handleRequestAccess({ email: 'a@example.org', name: 'Ann' })).toEqual({
      status: 503,
      body: { ok: false, code: 'unavailable', error: 'We couldn’t send your request just now. Try again in a few minutes.' },
    });
    expect(t.errors.map((e) => e.context)).toEqual(['request: store']);
  });
});

describe('the existing-account email off the response path', () => {
  it('hands it to the platform (background) so a slow SES call can’t slow the answer', async () => {
    const tasks: Promise<unknown>[] = [];
    let release!: () => void;
    const mailGate = new Promise<void>((resolve) => (release = resolve));
    const t = setupRoutes({ background: (task) => void tasks.push(task), mailGate });
    t.pool.add({ sub: 'existing-1', email: 'sam@example.org' });
    // The answer comes back while the email is still on its way.
    expect(await t.routes.handleSignUp({ email: 'sam@example.org' })).toEqual({ status: 200, body: { ok: true } });
    expect(t.emails).toEqual([]);
    expect(tasks).toHaveLength(1);
    release();
    await Promise.all(tasks);
    expect(t.emails.map((e) => e.email.subject)).toEqual([`You already have a ${SITE} account`]);
  });
});

describe('open sign-up needs the WAF challenge (M4)', () => {
  it('without an aws-waf-token cookie every address gets the same 503 and nothing is looked up or created', async () => {
    const t = setupRoutes();
    t.pool.add({ sub: 'u-1', email: 'existing@example.org' });
    const answers = [];
    for (const email of ['new@example.org', 'existing@example.org']) {
      const response = await t.routes.signUp(post('sign-up', { email }, { cookie: 'theme=dark' }));
      answers.push({ status: response.status, body: await response.text() });
    }
    expect(answers[0]).toEqual(answers[1]);
    expect(answers[0]!.status).toBe(503);
    expect(t.pool.mock.calls()).toHaveLength(0);
    expect(t.errors.map((e) => e.context)).toEqual(['sign-up: WAF token', 'sign-up: WAF token']);
    // A cookie that merely contains the name doesn't count.
    expect((await t.routes.signUp(post('sign-up', { email: 'new@example.org' }, { cookie: 'not-aws-waf-token=x' }))).status).toBe(503);
  });

  it('domains mode doesn’t need it, and requireWafToken: false turns it off (local development)', async () => {
    const domains = setupRoutes({ accountCreation: { mode: 'domains', domains: ['example.org'] } });
    expect((await domains.routes.signUp(post('sign-up', { email: 'a@example.org' }, { cookie: null }))).status).toBe(200);
    const local = setupRoutes({ requireWafToken: false });
    expect((await local.routes.signUp(post('sign-up', { email: 'a@example.org' }, { cookie: null }))).status).toBe(200);
  });
});

describe('what the audit row keeps from the request (L2)', () => {
  it('a request ID longer than 128 characters or with spaces is replaced; the user agent loses control characters and stops at 256', async () => {
    const t = setupRoutes();
    await t.routes.signUp(post('sign-up', { email: 'a@example.org' }, { 'x-request-id': 'x'.repeat(16_000), 'user-agent': `Evil\u0007Agent ${'y'.repeat(1000)}` }));
    await t.routes.signUp(post('sign-up', { email: 'b@example.org' }, { 'x-request-id': 'has spaces in it' }));
    await t.routes.signUp(post('sign-up', { email: 'c@example.org' }, { 'x-request-id': 'Root=1-67891233-abcdef012345678912345678' }));
    const intents = t.auditLog.rows.filter((r) => r.phase === 'intent');
    expect(intents[0]!.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(intents[0]!.context?.userAgent).toHaveLength(256);
    expect(intents[0]!.context?.userAgent).toMatch(/^EvilAgent y+$/);
    expect(intents[1]!.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(intents[2]!.requestId).toBe('Root=1-67891233-abcdef012345678912345678');
  });
});

describe('the request queue cap (M5)', () => {
  it('past the daily site-wide limit every address gets the same 503, and nothing is filed', async () => {
    const t = setupRoutes({ accountCreation: { mode: 'request' }, rateLimitRules: { requestSite: { limit: 2, windowMinutes: 24 * 60 } } });
    t.pool.add({ sub: 'u-1', email: 'existing@example.org' });
    for (const [i, email] of ['a@example.org', 'b@example.org'].entries()) {
      expect((await t.routes.requestAccess(post('request-access', { email, name: 'N' }, { 'x-forwarded-for': `198.51.100.${i + 1}` }))).status).toBe(200);
    }
    const answers = [];
    for (const [email, ip] of [['c@example.org', '198.51.100.3'], ['existing@example.org', '198.51.100.4']] as const) {
      const response = await t.routes.requestAccess(post('request-access', { email, name: 'N' }, { 'x-forwarded-for': ip }));
      const { retryAfterSeconds: _seconds, ...body } = (await response.json()) as { retryAfterSeconds?: number };
      answers.push({ status: response.status, body });
    }
    expect(answers[0]).toEqual(answers[1]);
    expect(answers[0]).toEqual({ status: 503, body: { ok: false, code: 'unavailable', error: 'Requests are paused for a while. Try again later.' } });
    expect(t.requests.all().map((r) => r.email)).toEqual(['a@example.org', 'b@example.org']);
    expect(t.emails).toHaveLength(0);
  });
});
