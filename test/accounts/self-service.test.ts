import { AdminUpdateUserAttributesCommand, type AdminUpdateUserAttributesCommandInput } from '@aws-sdk/client-cognito-identity-provider';
import { describe, expect, it } from 'vitest';
import {
  type AccountCreationSettings,
  type RateLimitStore,
  type SelfServiceConfig,
  createMemoryRateLimitStore,
  createSelfServiceActions,
  notOnListMessage,
} from '../../src/accounts/index.js';
import { type AuditEvent, type AuditLogStore, type EmailSender, createMemoryAuditLog } from '../../src/admin/index.js';
import { toRequestContext } from '../../src/server/index.js';
import { maskEmail } from '../../src/shared/emails.js';
import { type AppCapability, type AppGroup, bearer, harness } from '../helpers.js';
import { awsError, fakeUserPool, NOW, PENDING_EMAIL_CODE } from '../admin/people-fixture.js';

const SITE = 'Budget Reports';
const HELP = 'help@example.org';
const MEMBER = { sub: 'member-1', groups: [] as string[] };

type SentEmail = Parameters<EmailSender['sendEmail']>[0];

interface Actor {
  sub: string;
  groups: string[];
  /** Groups Cognito has now, when they differ from the token's. */
  liveGroups?: string[];
  authTimeAgoSeconds?: number;
}

interface SelfOptions {
  accountCreation?: AccountCreationSettings;
  actor?: Actor;
  rateLimits?: RateLimitStore;
  removeResourceMemberships?: SelfServiceConfig['removeResourceMemberships'];
  itemsNote?: string;
  timeline?: string[];
}

/**
 * Real server auth (the local test issuer; a bearer token in a request the context returns, as the
 * People fixture does), the fake pool, an in-memory audit log, and a recording mailer, all writing to
 * one timeline.
 */
function setupSelf(options: SelfOptions = {}) {
  const timeline = options.timeline ?? [];
  const pool = fakeUserPool({ timeline });
  let token: string | null = null;
  const h = harness({ context: () => Promise.resolve(token ? toRequestContext(bearer(token)) : { cookies: { get: () => undefined }, headers: new Headers() }) });
  const clock = { t: NOW };
  const memory = createMemoryAuditLog({ now: () => clock.t });
  const auditLog: AuditLogStore & { readonly rows: readonly AuditEvent[] } = {
    async append(e) {
      const row = await memory.append(e);
      timeline.push(`audit:${row.phase}`);
      return row;
    },
    list: (q) => memory.list(q),
    listActivity: (q) => memory.listActivity(q),
    get rows() {
      return memory.rows;
    },
  };
  const emails: SentEmail[] = [];
  const mailFailures: Error[] = [];
  const mailer: EmailSender = {
    sendEmail(message) {
      timeline.push('mail:sendEmail');
      const failure = mailFailures.shift();
      if (failure) return Promise.reject(failure);
      emails.push(message);
      return Promise.resolve();
    },
  };
  const errors: string[] = [];
  const waits: number[] = [];

  const signIn = (actor: Actor) => {
    if (!pool.get(actor.sub)) pool.add({ sub: actor.sub, email: `${actor.sub}@example.org` }, ...(actor.liveGroups ?? actor.groups));
    h.cognito.setLiveState(actor.sub, { enabled: true, groups: actor.liveGroups ?? actor.groups });
    const nowSec = Math.floor(h.clock.now / 1000);
    token = h.issuer.mintAccessToken({ sub: actor.sub, groups: actor.groups, authTime: nowSec - (actor.authTimeAgoSeconds ?? 30) });
  };
  signIn(options.actor ?? MEMBER);

  const actions = createSelfServiceActions<AppGroup, AppCapability>({
    auth: h.auth,
    auditLog,
    accountCreation: options.accountCreation ?? { mode: 'open' },
    siteName: SITE,
    signInUrl: 'https://reports.example.org/sign-in',
    help: HELP,
    mailer,
    cognito: pool.client,
    quota: { random: () => 0 },
    requestContext: () => Promise.resolve({ ip: '203.0.113.24', userAgent: 'Test Browser', requestId: 'req-test' }),
    now: () => clock.t,
    onError: (_e, where) => void errors.push(where),
    rateLimits: options.rateLimits ?? createMemoryRateLimitStore(),
    sleep: (ms) => {
      waits.push(ms);
      clock.t += ms;
      return Promise.resolve();
    },
    ...(options.removeResourceMemberships !== undefined && { removeResourceMemberships: options.removeResourceMemberships }),
    ...(options.itemsNote !== undefined && { itemsNote: options.itemsNote }),
  });
  return {
    h,
    pool,
    actions,
    auditLog,
    emails,
    errors,
    timeline,
    clock,
    waits,
    failMail: (e: Error = awsError('MessageRejected', 'Email address is not verified.')) => void mailFailures.push(e),
    actAs: signIn,
  };
}

const sentMessage = (email: string) => `We’ve emailed a code to ${email}. Enter it to finish. Your email address changes only after you do.`;
const updates = (t: ReturnType<typeof setupSelf>) => t.pool.inputsOf<AdminUpdateUserAttributesCommandInput>(AdminUpdateUserAttributesCommand);

describe('self-service is for sign-up sites only', () => {
  it.each([
    ['invite', { mode: 'invite' }],
    ['request', { mode: 'request' }],
  ] as const)('%s sites refuse all three actions, and change nothing', async (_mode, accountCreation) => {
    const t = setupSelf({ accountCreation });
    expect(t.actions.enabled).toBe(false);
    const refused = { ok: false, code: 'refused', guardrail: 'not_available', error: `On ${SITE}, the people who run the site change accounts. Ask them.` };
    expect(await t.actions.deleteMyAccount({ confirmEmail: 'member-1@example.org' })).toMatchObject(refused);
    expect(await t.actions.requestEmailChange({ newEmail: 'new@example.org' })).toMatchObject(refused);
    expect(await t.actions.confirmEmailChange({ code: PENDING_EMAIL_CODE })).toMatchObject(refused);
    expect(t.pool.mock.calls()).toHaveLength(0);
    expect(t.auditLog.rows).toEqual([]);
  });

  it('open and domains sites offer them', () => {
    expect(setupSelf({ accountCreation: { mode: 'open' } }).actions.enabled).toBe(true);
    expect(setupSelf({ accountCreation: { mode: 'domains', domains: ['example.org'] } }).actions.enabled).toBe(true);
  });
});

describe('delete my account', () => {
  it('needs a sign-in in the last 5 minutes', async () => {
    const t = setupSelf({ actor: { ...MEMBER, authTimeAgoSeconds: 6 * 60 } });
    expect(await t.actions.deleteMyAccount({ confirmEmail: 'member-1@example.org' })).toMatchObject({ ok: false, code: 'step_up_required', maxAgeSeconds: 300 });
    expect(t.pool.writes()).toEqual([]);
    expect(t.pool.get('member-1')).toBeDefined();
    expect(t.auditLog.rows).toEqual([]);
  });

  it('never deletes the owner: the live groups decide, not the token', async () => {
    const t = setupSelf({ actor: { sub: 'owner-1', groups: [], liveGroups: ['owner'] } });
    expect(await t.actions.deleteMyAccount({ confirmEmail: 'owner-1@example.org' })).toMatchObject({
      ok: false,
      code: 'refused',
      guardrail: 'owner',
      error: `You’re the owner of ${SITE}, so your account can’t be deleted. Transfer ownership first.`,
    });
    expect(t.pool.writes()).toEqual([]);
    expect(t.pool.get('owner-1')).toBeDefined();
    expect(t.emails).toEqual([]);
    expect(t.auditLog.rows).toEqual([]);
  });

  it('needs the address typed out', async () => {
    const t = setupSelf();
    for (const confirmEmail of ['', 'member-2@example.org', 'member-1@example.com', 'member-1', undefined, 42]) {
      expect(await t.actions.deleteMyAccount({ confirmEmail })).toMatchObject({ ok: false, code: 'invalid', error: 'Type your email address exactly as it is to confirm.' });
    }
    expect(t.pool.writes()).toEqual([]);
    expect(t.pool.get('member-1')).toBeDefined();
    expect(t.auditLog.rows).toEqual([]);
  });

  it('removes item access, signs out everywhere, deletes the account, emails the address, and logs it as the person', async () => {
    const timeline: string[] = [];
    const removed: unknown[] = [];
    const t = setupSelf({
      timeline,
      itemsNote: 'Projects you created stay with the team.',
      removeResourceMemberships: (person) => {
        timeline.push('resources:remove');
        removed.push(person);
        return Promise.resolve({ removed: 2 });
      },
    });
    const result = await t.actions.deleteMyAccount({ confirmEmail: 'member-1@example.org' });
    expect(result).toEqual({
      ok: true,
      message: `Your ${SITE} account is deleted, and you’re signed out everywhere. Projects you created stay with the team.`,
      auditId: expect.any(String) as string,
    });
    expect(removed).toEqual([{ sub: 'member-1', username: 'member-1', email: 'member-1@example.org' }]);
    expect(t.pool.get('member-1')).toBeUndefined();
    expect(timeline.filter((x) => !x.startsWith('cognito:List'))).toEqual([
      'audit:intent',
      'resources:remove',
      'cognito:AdminUserGlobalSignOut',
      'cognito:AdminDeleteUser',
      'mail:sendEmail',
      'audit:result',
    ]);

    expect(t.emails).toHaveLength(1);
    const [sent] = t.emails;
    expect(sent!.to).toEqual(['member-1@example.org']);
    expect(sent!.replyTo).toEqual([HELP]);
    expect(sent!.email.subject).toBe(`Your ${SITE} account was deleted`);
    expect(sent!.email.text).toContain(`Your ${SITE} account for member-1@example.org was deleted on`);
    expect(sent!.email.text).toContain('at your request');
    expect(sent!.email.text).toContain('Projects you created stay with the team.');
    expect(sent!.email.text).toContain('create a new account');

    const [intent, row] = t.auditLog.rows;
    expect(t.auditLog.rows).toHaveLength(2);
    expect(intent).toMatchObject({
      phase: 'intent',
      action: 'account.delete',
      actor: { sub: 'member-1', email: 'member-1@example.org' },
      target: { sub: 'member-1', email: 'member-1@example.org' },
      before: { email: 'member-1@example.org', groups: [] },
      calls: ['Remove item access', 'AdminUserGlobalSignOut', 'AdminDeleteUser', 'SES SendEmail'],
      requestId: 'req-test',
      context: { ip: '203.0.113.24', userAgent: 'Test Browser' },
    });
    expect(row).toMatchObject({
      phase: 'result',
      outcome: 'ok',
      action: 'account.delete',
      actor: { sub: 'member-1' },
      after: { deleted: true, resourceMemberships: { removed: 2 } },
      calls: ['Remove item access: ok', 'AdminUserGlobalSignOut: ok', 'AdminDeleteUser: ok', 'SES SendEmail: ok'],
    });
    expect(result.ok && result.auditId).toBe(row!.id);
  });

  it('an email that fails after the account is gone still reports the deletion', async () => {
    const t = setupSelf();
    t.failMail();
    expect(await t.actions.deleteMyAccount({ confirmEmail: 'member-1@example.org' })).toMatchObject({ ok: true });
    expect(t.pool.get('member-1')).toBeUndefined();
    expect(t.emails).toEqual([]);
    expect(t.errors).toEqual(['delete: the account-deleted email']);
    expect(t.auditLog.rows.at(-1)).toMatchObject({ phase: 'result', outcome: 'ok', calls: ['AdminUserGlobalSignOut: ok', 'AdminDeleteUser: ok', 'SES SendEmail: failed (MessageRejected)'] });
  });
});

describe('change my email address', () => {
  it('asking for the change needs a sign-in in the last 5 minutes', async () => {
    const t = setupSelf({ actor: { ...MEMBER, authTimeAgoSeconds: 6 * 60 } });
    expect(await t.actions.requestEmailChange({ newEmail: 'new@example.org' })).toMatchObject({ ok: false, code: 'step_up_required' });
    expect(t.pool.writes()).toEqual([]);
    expect(t.auditLog.rows).toEqual([]);
  });

  it('refuses the same address, a malformed one, and (on domains sites) one off the list', async () => {
    const t = setupSelf();
    expect(await t.actions.requestEmailChange({ newEmail: ' Member-1@Example.org ' })).toMatchObject({ ok: false, code: 'invalid', error: 'That’s already your email address.' });
    expect(await t.actions.requestEmailChange({ newEmail: 'new@' })).toMatchObject({ ok: false, code: 'invalid', error: 'Enter an email address like name@example.com' });

    const d = setupSelf({ accountCreation: { mode: 'domains', domains: ['example.org'] } });
    expect(await d.actions.requestEmailChange({ newEmail: 'member@elsewhere.example' })).toMatchObject({
      ok: false,
      code: 'refused',
      guardrail: 'domain',
      error: notOnListMessage(SITE, ['example.org'], false),
    });
    expect(await d.actions.requestEmailChange({ newEmail: 'member@evilexample.org' })).toMatchObject({ ok: false, guardrail: 'domain' });
    expect([...t.pool.writes(), ...d.pool.writes()]).toEqual([]);
    // A subdomain is on the list.
    expect(await d.actions.requestEmailChange({ newEmail: 'member@reports.example.org' })).toMatchObject({ ok: true });
  });

  it('an address another account uses gets the same answer, and nothing else', async () => {
    const t = setupSelf();
    t.pool.add({ sub: 'other-1', email: 'taken@example.org' });
    const taken = await t.actions.requestEmailChange({ newEmail: 'taken@example.org' });
    expect(taken).toEqual({ ok: true, message: sentMessage('taken@example.org') });
    expect(updates(t)).toEqual([]);
    expect(t.auditLog.rows).toEqual([]);
    expect(t.pool.get('member-1')!.pendingEmail).toBeUndefined();

    // A free address's answer has the same shape, so the screen can't tell them apart.
    const free = await t.actions.requestEmailChange({ newEmail: 'free@example.org' });
    expect(free).toEqual({ ok: true, message: sentMessage('free@example.org') });
    expect(Object.keys(free).sort()).toEqual(Object.keys(taken).sort());
  });

  it('answers no faster for an address another account uses than for a free one (the response-time floor)', async () => {
    const t = setupSelf();
    t.pool.add({ sub: 'other-1', email: 'taken@example.org' });
    const start = t.clock.t;
    await t.actions.requestEmailChange({ newEmail: 'taken@example.org' });
    expect(t.clock.t - start).toBeGreaterThanOrEqual(800);
    const again = t.clock.t;
    await t.actions.requestEmailChange({ newEmail: 'free@example.org' });
    expect(t.clock.t - again).toBeGreaterThanOrEqual(800);
    expect(t.waits.every((w) => w > 0)).toBe(true);
  });

  it('sets the new address as pending (the old one stays in effect), logged', async () => {
    const t = setupSelf();
    expect(await t.actions.requestEmailChange({ newEmail: 'New@Example.org' })).toMatchObject({ ok: true, message: sentMessage('new@example.org') });
    expect(updates(t)).toEqual([{ UserPoolId: 'us-east-1_TestPool1', Username: 'member-1', UserAttributes: [{ Name: 'email', Value: 'new@example.org' }] }]);
    expect(t.pool.get('member-1')).toMatchObject({ email: 'member-1@example.org', pendingEmail: 'new@example.org' });
    expect(t.emails).toEqual([]);
    const [intent, row] = t.auditLog.rows;
    expect(intent).toMatchObject({
      phase: 'intent',
      action: 'account.requestEmailChange',
      actor: { sub: 'member-1', email: 'member-1@example.org' },
      target: { sub: 'member-1', email: 'member-1@example.org' },
      before: { email: 'member-1@example.org' },
      after: { email: 'member-1@example.org', pendingEmail: 'new@example.org' },
    });
    expect(row).toMatchObject({ phase: 'result', outcome: 'ok', action: 'account.requestEmailChange', calls: ['AdminUpdateUserAttributes email (pending until verified): ok'] });
  });

  it('per account: past the limit is refused before Cognito is asked', async () => {
    const t = setupSelf({ rateLimits: createMemoryRateLimitStore() });
    for (let i = 1; i <= 5; i++) expect(await t.actions.requestEmailChange({ newEmail: `new-${i}@example.org` })).toMatchObject({ ok: true });
    expect(await t.actions.requestEmailChange({ newEmail: 'new-6@example.org' })).toMatchObject({
      ok: false,
      code: 'refused',
      guardrail: 'rate_limited',
      error: 'Too many attempts. Wait 60 minutes, then try again.',
    });
    expect(updates(t)).toHaveLength(5);

    const failing = setupSelf({ rateLimits: { hit: () => Promise.reject(new Error('DynamoDB unavailable')) } });
    expect(await failing.actions.requestEmailChange({ newEmail: 'new@example.org' })).toMatchObject({ ok: false, code: 'unavailable' });
    expect(updates(failing)).toEqual([]);
    expect(failing.errors).toEqual(['email change: rate limit']);
  });

  it('per new address: many accounts can’t flood one inbox with codes, plus-tags included (L3)', async () => {
    const shared = createMemoryRateLimitStore();
    for (let i = 1; i <= 5; i++) {
      const t = setupSelf({ rateLimits: shared, actor: { sub: `member-${i}`, groups: [] } });
      expect(await t.actions.requestEmailChange({ newEmail: `victim+${i}@example.org` })).toMatchObject({ ok: true });
    }
    const sixth = setupSelf({ rateLimits: shared, actor: { sub: 'member-6', groups: [] } });
    expect(await sixth.actions.requestEmailChange({ newEmail: 'Victim@example.org' })).toMatchObject({ ok: false, code: 'refused', guardrail: 'rate_limited' });
    expect(updates(sixth)).toEqual([]);
    // Another address is still fine for that account.
    expect(await sixth.actions.requestEmailChange({ newEmail: 'someone-else@example.org' })).toMatchObject({ ok: true });
  });

  it('confirming: a wrong code, or no pending change, reads the same', async () => {
    const t = setupSelf();
    const didnt = { ok: false, code: 'invalid', error: `That code didn’t work. Check it against the newest email from ${SITE}.` };
    expect(await t.actions.confirmEmailChange({ code: PENDING_EMAIL_CODE })).toMatchObject(didnt);
    await t.actions.requestEmailChange({ newEmail: 'new@example.org' });
    expect(await t.actions.confirmEmailChange({ code: '654321' })).toMatchObject(didnt);
    expect(await t.actions.confirmEmailChange({ code: 'abc' })).toMatchObject({ ok: false, code: 'invalid', error: 'Enter the code from the email' });
    expect(t.pool.get('member-1')!.email).toBe('member-1@example.org');
    expect(t.emails).toEqual([]);
  });

  it('confirming with the code makes it the address, tells the old one (masked), and logs before and after', async () => {
    const t = setupSelf();
    await t.actions.requestEmailChange({ newEmail: 'new.address@example.org' });
    // Confirming needs no fresh sign-in: the code is the proof.
    t.actAs({ ...MEMBER, authTimeAgoSeconds: 3600 });
    const result = await t.actions.confirmEmailChange({ code: ` ${PENDING_EMAIL_CODE.slice(0, 3)}-${PENDING_EMAIL_CODE.slice(3)} ` });
    expect(result).toMatchObject({ ok: true, message: 'Your email address is now new.address@example.org. Sign in with it from now on.' });
    expect(t.pool.get('member-1')).toMatchObject({ email: 'new.address@example.org', emailVerified: true });
    expect(t.pool.get('member-1')!.pendingEmail).toBeUndefined();

    expect(t.emails).toHaveLength(1);
    const [sent] = t.emails;
    expect(sent!.to).toEqual(['member-1@example.org']);
    expect(sent!.replyTo).toEqual([HELP]);
    expect(sent!.email.subject).toBe(`The email address for your ${SITE} account changed`);
    expect(sent!.email.text).toContain(maskEmail('new.address@example.org'));
    expect(sent!.email.text).not.toContain('new.address@example.org');
    expect(sent!.email.text).toContain('You made the change.');

    const rows = t.auditLog.rows.filter((r) => r.action === 'account.changeEmail');
    expect(rows.map((r) => r.phase)).toEqual(['intent', 'result']);
    expect(rows[0]).toMatchObject({ actor: { sub: 'member-1', email: 'member-1@example.org' }, target: { sub: 'member-1', email: 'member-1@example.org' }, before: { email: 'member-1@example.org' } });
    expect(rows[1]).toMatchObject({
      outcome: 'ok',
      target: { sub: 'member-1', email: 'new.address@example.org' },
      before: { email: 'member-1@example.org' },
      after: { email: 'new.address@example.org' },
      calls: ['VerifyUserAttribute email: ok', 'SES SendEmail (to the old address): ok'],
    });
  });
});
