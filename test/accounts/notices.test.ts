/**
 * Account-change notices (register A10: on by default): the route the screens post to after a passkey
 * is added or a password changes.
 */
import { GetUserAuthFactorsCommand, ListWebAuthnCredentialsCommand } from '@aws-sdk/client-cognito-identity-provider';
import { describe, expect, it } from 'vitest';
import { ACCOUNT_NOTICE_PATH, createAccountNoticeRoute, createMemoryRateLimitStore } from '../../src/accounts/index.js';
import type { EmailSender } from '../../src/admin/index.js';
import { toRequestContext } from '../../src/server/index.js';
import { type AppCapability, type AppGroup, bearer, harness } from '../helpers.js';
import { fakeUserPool, NOW } from '../admin/people-fixture.js';

const ORIGIN = 'https://reports.example.org';

function setup(options: { signedIn?: boolean; factors?: { configured: string[]; mfa: string[] } } = {}) {
  const pool = fakeUserPool();
  // The route's own factors read (a password notice needs a password on the account): a password by default.
  pool.mock.on(GetUserAuthFactorsCommand).resolves({ ConfiguredUserAuthFactors: ['PASSWORD'] as never });
  let token: string | null = null;
  const h = harness({ context: () => Promise.resolve(token ? toRequestContext(bearer(token)) : { cookies: { get: () => undefined }, headers: new Headers() }) });
  const sent: Parameters<EmailSender['sendEmail']>[0][] = [];
  const mailer: EmailSender = { sendEmail: (m) => (sent.push(m), Promise.resolve()) };
  pool.add({ sub: 'member-1', email: 'ada@example.org' });
  h.cognito.setLiveState('member-1', { enabled: true, groups: [] });
  // What the server's own guard reads (the enrollment rules).
  if (options.factors) h.cognito.setFactors('member-1', options.factors);
  if (options.signedIn !== false) token = h.issuer.mintAccessToken({ sub: 'member-1', groups: [], authTime: Math.floor(h.clock.now / 1000) - 30 });
  const errors: string[] = [];
  const route = createAccountNoticeRoute<AppGroup, AppCapability>({
    auth: h.auth,
    siteName: 'Example Reports',
    signInUrl: `${ORIGIN}/sign-in`,
    theme: 'osbm',
    help: 'apps-help@example.org',
    mailer,
    rateLimits: createMemoryRateLimitStore(),
    cognito: pool.client,
    quota: { random: () => 0 },
    now: () => NOW,
    onError: (_error, context) => void errors.push(context),
  });
  const post = (body: unknown, headers: Record<string, string | null> = {}) => {
    const all: Record<string, string> = {};
    for (const [k, v] of Object.entries({ origin: ORIGIN, 'content-type': 'application/json', ...headers })) if (v !== null) all[k] = v;
    return route.POST(new Request(`${ORIGIN}${ACCOUNT_NOTICE_PATH}`, { method: 'POST', headers: all, body: typeof body === 'string' ? body : JSON.stringify(body) }));
  };
  return { pool, post, sent, errors };
}

describe('the account-change notice route (register A10)', () => {
  it('emails the account’s own address that its password changed, in the shared layout', async () => {
    const t = setup();
    const res = await t.post({ event: 'password-changed' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.to).toEqual(['ada@example.org']);
    expect(t.sent[0]!.email.subject).toBe('The password for your Example Reports account changed');
    expect(t.sent[0]!.email.text).toContain('This site is managed by the NC Office of State Budget and Management. Help: apps-help@example.org.');
    expect(t.sent[0]!.replyTo).toEqual(['apps-help@example.org']);
  });

  it('sends a passkey notice only when the account has a new passkey (or the check can’t be made)', async () => {
    const t = setup();
    t.pool.mock.on(ListWebAuthnCredentialsCommand).resolves({ Credentials: [{ CredentialId: 'c', CreatedAt: new Date(NOW - 60 * 60 * 1000) } as never] });
    expect((await t.post({ event: 'passkey-added' })).status).toBe(409);
    t.pool.mock.on(ListWebAuthnCredentialsCommand).resolves({ Credentials: [{ CredentialId: 'c', CreatedAt: new Date(NOW - 60 * 1000) } as never] });
    expect((await t.post({ event: 'passkey-added' })).status).toBe(200);
    t.pool.mock.on(ListWebAuthnCredentialsCommand).rejects(new Error('timed out'));
    expect((await t.post({ event: 'passkey-added' })).status).toBe(200);
    expect(t.sent.map((m) => m.email.subject)).toEqual(['A passkey was added to your Example Reports account', 'A passkey was added to your Example Reports account']);
  });

  it('refuses another origin, a non-JSON body, an unknown event, and nobody signed in', async () => {
    const t = setup();
    expect((await t.post({ event: 'password-changed' }, { origin: 'https://evil.example.net' })).status).toBe(403);
    expect((await t.post({ event: 'password-changed' }, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await t.post({ event: 'email-changed' })).status).toBe(400);
    const out = setup({ signedIn: false });
    expect((await out.post({ event: 'password-changed' })).status).toBe(401);
    expect([...t.sent, ...out.sent]).toEqual([]);
  });

  it('is rate-limited per account', async () => {
    const t = setup();
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await t.post({ event: 'password-changed' })).status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(6);
    expect(statuses.at(-1)).toBe(429);
  });

  it('answers a password user who hasn’t set up the authenticator yet: My account posts before that step (L3)', async () => {
    // A passkey-only member who just added a password under My account: PASSWORD, no TOTP yet. The
    // server's enrollment rule would refuse them elsewhere (403); this route only emails their own address.
    const t = setup({ factors: { configured: ['WEB_AUTHN', 'PASSWORD'], mfa: [] } });
    const res = await t.post({ event: 'password-changed' });
    expect(res.status).toBe(200);
    expect(t.sent.map((m) => m.to)).toEqual([['ada@example.org']]);
    // And an account with only emailed codes (the first-credential chooser) is still answered.
    const invitee = setup({ factors: { configured: ['EMAIL_OTP'], mfa: [] } });
    expect((await invitee.post({ event: 'password-changed' })).status).toBe(200);
  });

  it('sends a password notice only to an account that has a password (or when the check can’t be made) (L2)', async () => {
    const t = setup();
    t.pool.mock.on(GetUserAuthFactorsCommand).resolves({ ConfiguredUserAuthFactors: ['WEB_AUTHN', 'EMAIL_OTP'] as never });
    const none = await t.post({ event: 'password-changed' });
    expect(none.status).toBe(409);
    expect(await none.json()).toEqual({ ok: false, code: 'nothing_changed', error: 'This account has no password.' });
    expect(t.sent).toEqual([]);
    t.pool.mock.on(GetUserAuthFactorsCommand).resolves({ ConfiguredUserAuthFactors: ['WEB_AUTHN', 'PASSWORD'] as never });
    expect((await t.post({ event: 'password-changed' })).status).toBe(200);
    // Telling the owner is the safe direction: a read that fails still sends, and is reported.
    t.pool.mock.on(GetUserAuthFactorsCommand).rejects(new Error('timed out'));
    expect((await t.post({ event: 'password-changed' })).status).toBe(200);
    expect(t.errors).toContain('account notice: factors read');
    expect(t.sent).toHaveLength(2);
  });

  it('refuses a missing Origin and a body over 1 KB, declared or not, before it reads the session', async () => {
    const t = setup();
    expect((await t.post({ event: 'password-changed' }, { origin: null })).status).toBe(403);
    const big = JSON.stringify({ event: 'password-changed', pad: 'x'.repeat(2000) });
    expect((await t.post(big, { 'content-length': String(big.length) })).status).toBe(413);
    // No declared length (or a false one): the bytes are counted after the read.
    expect((await t.post(big, { 'content-length': '10' })).status).toBe(413);
    expect(t.sent).toEqual([]);
  });
});
