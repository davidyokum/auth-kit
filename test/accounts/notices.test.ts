/**
 * Account-change notices (register A10: on by default): the route the screens post to after a passkey
 * is added or a password changes.
 */
import { ListWebAuthnCredentialsCommand } from '@aws-sdk/client-cognito-identity-provider';
import { describe, expect, it } from 'vitest';
import { ACCOUNT_NOTICE_PATH, createAccountNoticeRoute, createMemoryRateLimitStore } from '../../src/accounts/index.js';
import type { EmailSender } from '../../src/admin/index.js';
import { toRequestContext } from '../../src/server/index.js';
import { type AppCapability, type AppGroup, bearer, harness } from '../helpers.js';
import { fakeUserPool, NOW } from '../admin/people-fixture.js';

const ORIGIN = 'https://reports.example.org';

function setup(options: { signedIn?: boolean } = {}) {
  const pool = fakeUserPool();
  let token: string | null = null;
  const h = harness({ context: () => Promise.resolve(token ? toRequestContext(bearer(token)) : { cookies: { get: () => undefined }, headers: new Headers() }) });
  const sent: Parameters<EmailSender['sendEmail']>[0][] = [];
  const mailer: EmailSender = { sendEmail: (m) => (sent.push(m), Promise.resolve()) };
  pool.add({ sub: 'member-1', email: 'ada@example.org' });
  h.cognito.setLiveState('member-1', { enabled: true, groups: [] });
  if (options.signedIn !== false) token = h.issuer.mintAccessToken({ sub: 'member-1', groups: [], authTime: Math.floor(h.clock.now / 1000) - 30 });
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
  });
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    route.POST(new Request(`${ORIGIN}${ACCOUNT_NOTICE_PATH}`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));
  return { pool, post, sent };
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
});
