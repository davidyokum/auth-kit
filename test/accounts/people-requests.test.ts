import { AdminCreateUserCommand, type AdminCreateUserCommandInput } from '@aws-sdk/client-cognito-identity-provider';
import { describe, expect, it } from 'vitest';
import { type AccessRequest, createMemoryAccessRequestStore, newRequestId } from '../../src/accounts/index.js';
import { type EmailSender, type InviteEmail, createMemoryAuditLog, createPeopleActions, renderInviteEmail } from '../../src/admin/index.js';
import { amplifyCookieNames, toRequestContext } from '../../src/server/index.js';
import { type AppCapability, type AppGroup, CLIENT_ID, harness } from '../helpers.js';
import { DAY, fakeUserPool, NOW, type SetupOptions, setup } from '../admin/people-fixture.js';

const HELP = 'help@example.org';
const ADMIN = { sub: 'admin-1', groups: ['admin-content-people'] };
const VIEWER = { sub: 'view-1', groups: ['admin-view'] };
const RITA = { email: 'rita@example.org', name: 'Rita Example', reason: 'Quarterly budget reports for the county office' };

type SentEmail = Parameters<EmailSender['sendEmail']>[0];

/** People actions over the fixture, with a request queue, the help address, and the OSBM family. */
function setupRequests(options: SetupOptions = {}) {
  const store = createMemoryAccessRequestStore();
  const t = setup({ ...options, config: { accessRequests: store, help: HELP, theme: 'osbm', ...options.config } });
  const file = async (input: { email: string; name?: string; reason?: string }, daysAgo = 1): Promise<AccessRequest> =>
    (await store.create({ ...input, now: new Date(NOW - daysAgo * DAY) })).request;
  return { ...t, store, file };
}

const auditText = (t: ReturnType<typeof setupRequests>) => JSON.stringify(t.auditLog.rows);

describe('listAccessRequests', () => {
  it('is off without a request store', async () => {
    expect(await setup().people.listAccessRequests()).toEqual({ state: 'off' });
  });

  it('needs people.manage: a view-only admin gets the reason, not an empty list', async () => {
    const t = setupRequests({ actor: VIEWER });
    await t.file(RITA);
    expect(await t.people.listAccessRequests()).toEqual({ state: 'unavailable', reason: "You don't have permission to do that." });
  });

  it('lists pending requests newest first, with the name and reason as typed', async () => {
    const t = setupRequests({ actor: ADMIN });
    const older = await t.file(RITA, 3);
    const newer = await t.file({ email: 'sam@example.org', name: 'Sam Lee' }, 1);
    const decided = await t.file({ email: 'dee@example.org', name: 'Dee' }, 2);
    await t.store.settle(decided.id, { status: 'declined', by: { sub: 'admin-1' }, now: new Date(NOW) });
    const list = await t.people.listAccessRequests();
    expect(list).toEqual({
      state: 'ok',
      truncated: false,
      fetchedAt: new Date(NOW).toISOString(),
      requests: [
        { id: newer.id, email: 'sam@example.org', name: 'Sam Lee', createdAt: newer.createdAt, expiresAt: newer.expiresAt },
        { id: older.id, email: RITA.email, name: RITA.name, reason: RITA.reason, createdAt: older.createdAt, expiresAt: older.expiresAt },
      ],
    });
  });

  it('a store that can’t be read is "couldn’t load", never zero requests', async () => {
    const t = setupRequests({ actor: ADMIN });
    t.store.list = () => Promise.reject(new Error('DynamoDB unavailable'));
    const list = await t.people.listAccessRequests();
    expect(list.state).toBe('unavailable');
    expect(list.state === 'unavailable' && list.reason).toMatch(/^Couldn't load requests: .*This isn't a count of zero\.$/);
  });
});

describe('approveRequest', () => {
  it('sends the ordinary invite as Member with the approved wording, and closes the request', async () => {
    const t = setupRequests({ actor: ADMIN });
    const request = await t.file(RITA);
    const result = await t.people.approveRequest({ id: request.id });
    expect(result).toMatchObject({ ok: true, subject: { email: RITA.email } });
    expect(result.ok && result.message).toMatch(/^Approved\. Invite sent to rita@example\.org\./);

    const [create] = t.pool.inputsOf<AdminCreateUserCommandInput>(AdminCreateUserCommand);
    expect(create).toMatchObject({ Username: RITA.email, MessageAction: 'SUPPRESS' });
    expect(create!.TemporaryPassword).toBeUndefined();
    const rita = t.pool.users.find((u) => u.email === RITA.email)!;
    expect(rita).toMatchObject({ name: RITA.name, emailVerified: false });
    expect([...rita.groups]).toEqual([]); // Member: no group
    expect(t.pool.writes()).toEqual(['AdminCreateUserCommand']);

    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({ email: RITA.email, name: RITA.name, approved: true, roleLabel: 'Member', theme: 'osbm', helpEmail: HELP, siteName: 'Example Reports' });
    expect(t.sent[0]).toHaveProperty('invitedBy');
    expect(renderInviteEmail(t.sent[0]!).subject).toMatch(/approved your request for Example Reports$/);

    // It leaves the pending list, marked approved by the admin.
    expect(await t.store.get(request.id, new Date(NOW))).toMatchObject({ status: 'approved', settledBy: { sub: 'admin-1' } });
    expect(await t.people.listAccessRequests()).toMatchObject({ state: 'ok', requests: [] });
  });

  it('logs it as people.approveRequest; the account’s name is in the invite row, the typed reason never is', async () => {
    const t = setupRequests({ actor: ADMIN });
    const request = await t.file(RITA);
    await t.people.approveRequest({ id: request.id });
    expect(t.auditLog.rows.map((r) => [r.phase, r.action])).toEqual([
      ['intent', 'people.approveRequest'],
      ['result', 'people.approveRequest'],
    ]);
    expect(t.auditLog.rows[0]).toMatchObject({ actor: { sub: 'admin-1' }, target: { email: RITA.email }, after: { email: RITA.email, name: RITA.name, role: 'member', request: 'approved' } });
    expect(t.auditLog.rows[1]).toMatchObject({ outcome: 'ok', after: { name: RITA.name, request: 'approved' }, calls: ['AdminCreateUser: ok', 'SES SendEmail: ok'] });
    expect(auditText(t)).not.toContain(RITA.reason);
    // The approver's own reason, when given, is theirs to log.
    const second = await t.file({ email: 'sam@example.org', name: 'Sam', reason: 'Typed by Sam' });
    await t.people.approveRequest({ id: second.id, reason: 'Budget office staff' });
    expect(auditText(t)).toContain('Budget office staff');
    expect(auditText(t)).not.toContain('Typed by Sam');
  });

  it('an expired request is stale; an unknown one is not found; a malformed ID is invalid', async () => {
    const t = setupRequests({ actor: ADMIN });
    const expired = await t.file(RITA, 31);
    expect(await t.people.approveRequest({ id: expired.id })).toMatchObject({ ok: false, code: 'stale', error: 'That request expired after 30 days with no answer.' });
    expect(await t.people.approveRequest({ id: newRequestId(new Date(NOW)) })).toMatchObject({ ok: false, code: 'not_found' });
    expect(await t.people.approveRequest({ id: 'not-an-id' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(t.pool.writes()).toEqual([]);
    expect(t.sent).toEqual([]);
    expect(t.auditLog.rows).toEqual([]);
  });

  it('when the address already has an account, sends nothing, closes the request, and says so', async () => {
    const t = setupRequests({ actor: ADMIN });
    const request = await t.file(RITA);
    t.pool.add({ sub: 'rita-1', email: RITA.email });
    expect(await t.people.approveRequest({ id: request.id })).toMatchObject({
      ok: false,
      code: 'refused',
      guardrail: 'exists',
      error: 'rita@example.org already has an account, so no invite was sent. The request is closed.',
    });
    expect(t.pool.writes()).toEqual([]);
    expect(t.sent).toEqual([]);
    expect(await t.store.get(request.id, new Date(NOW))).toMatchObject({ status: 'approved' });
    expect(await t.people.listAccessRequests()).toMatchObject({ state: 'ok', requests: [] });
  });

  it('needs people.manage', async () => {
    const t = setupRequests({ actor: VIEWER });
    const request = await t.file(RITA);
    expect(await t.people.approveRequest({ id: request.id })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(t.pool.writes()).toEqual([]);
    expect(await t.store.get(request.id, new Date(NOW))).toMatchObject({ status: 'pending' });
  });

  it('names the approver in the invite when the session carries their ID token (Amplify cookies)', async () => {
    const pool = fakeUserPool();
    const store = createMemoryAccessRequestStore();
    let cookie = '';
    const h = harness({ context: () => Promise.resolve(toRequestContext(new Request('https://reports.example.org/admin/people', { headers: { cookie } }))) });
    h.cognito.setLiveState('jordan-1', { enabled: true, groups: ['admin-content-people'] });
    const names = amplifyCookieNames(CLIENT_ID, 'jordan-1');
    const nowSec = Math.floor(h.clock.now / 1000);
    const access = h.issuer.mintAccessToken({ sub: 'jordan-1', groups: ['admin-content-people'], authTime: nowSec - 30 });
    const id = h.issuer.mintIdToken({ sub: 'jordan-1', email: 'jordan@example.org', name: 'Jordan Lee' });
    cookie = `${names.lastAuthUser}=jordan-1; ${names.accessToken!}=${access}; ${names.idToken!}=${id}`;
    const sent: InviteEmail[] = [];
    const people = createPeopleActions<AppGroup, AppCapability>({
      auth: h.auth,
      auditLog: createMemoryAuditLog({ now: () => NOW }),
      mailer: {
        sendInvite: (input) => {
          sent.push(input);
          return Promise.resolve();
        },
      },
      siteName: 'Example Reports',
      signInUrl: 'https://reports.example.org/sign-in',
      cognito: pool.client,
      accessRequests: store,
      help: HELP,
      now: () => NOW,
      sleep: () => Promise.resolve(),
      requestContext: () => Promise.resolve({ requestId: 'req-test' }),
    });
    const { request } = await store.create({ ...RITA, now: new Date(NOW - DAY) });
    expect(await people.approveRequest({ id: request.id })).toMatchObject({ ok: true });
    expect(sent[0]).toMatchObject({ approved: true, invitedBy: { name: 'Jordan Lee', email: 'jordan@example.org' } });
    const email = renderInviteEmail(sent[0]!);
    expect(email.subject).toBe('Jordan Lee approved your request for Example Reports');
    expect(email.replyTo).toEqual(['jordan@example.org']);
  });
});

describe('declineRequest', () => {
  it('is silent by default, and the log has the address but not the typed name or reason', async () => {
    const t = setupRequests({ actor: ADMIN });
    const request = await t.file(RITA);
    expect(await t.people.declineRequest({ id: request.id })).toMatchObject({ ok: true, message: 'Declined. rita@example.org wasn’t told (declining is silent on this site).' });
    expect(t.sent).toEqual([]);
    expect(t.pool.writes()).toEqual([]);
    expect(await t.store.get(request.id, new Date(NOW))).toMatchObject({ status: 'declined', settledBy: { sub: 'admin-1' } });
    expect(t.auditLog.rows.map((r) => [r.phase, r.action])).toEqual([
      ['intent', 'people.declineRequest'],
      ['result', 'people.declineRequest'],
    ]);
    expect(t.auditLog.rows[1]).toMatchObject({ outcome: 'ok', target: { email: RITA.email }, before: { status: 'pending' }, after: { status: 'declined' } });
    expect(auditText(t)).toContain(RITA.email);
    expect(auditText(t)).not.toContain(RITA.name);
    expect(auditText(t)).not.toContain(RITA.reason);
  });

  it('with notifyOnDecline and a mailer that sends email, the note goes to the address', async () => {
    const emails: SentEmail[] = [];
    // The SES mailer is both: it sends invites and already-rendered emails.
    const mailer = {
      sendInvite: () => Promise.resolve(),
      sendEmail: (message: SentEmail) => {
        emails.push(message);
        return Promise.resolve();
      },
    };
    const t = setupRequests({ actor: ADMIN, config: { notifyOnDecline: true, mailer } });
    const request = await t.file(RITA);
    const note = 'Accounts here are for budget office staff.';
    expect(await t.people.declineRequest({ id: request.id, note })).toMatchObject({ ok: true, message: 'Declined. rita@example.org was told.' });
    expect(emails).toHaveLength(1);
    const [sent] = emails;
    expect(sent!.to).toEqual([RITA.email]);
    expect(sent!.replyTo).toEqual([HELP]);
    expect(sent!.email.subject).toBe('Your request for Example Reports');
    expect(sent!.email.text).toContain('Your request wasn’t approved');
    expect(sent!.email.text).toContain(`They added: “${note}”`);
    expect(sent!.email.text).toContain(`This site is managed by the NC Office of State Budget and Management. Help: ${HELP}.`);
    expect(t.auditLog.rows.at(-1)).toMatchObject({ outcome: 'ok', after: { status: 'declined', notified: true }, calls: ['DynamoDB PutItem request: ok', 'SES SendEmail: ok'] });
    expect(auditText(t)).not.toContain(RITA.name);
    expect(auditText(t)).not.toContain(RITA.reason);
  });

  it('with notifyOnDecline and nothing to send email with, it’s refused and the request stays', async () => {
    const t = setupRequests({ actor: ADMIN, config: { notifyOnDecline: true } });
    const request = await t.file(RITA);
    expect(await t.people.declineRequest({ id: request.id })).toMatchObject({ ok: false, code: 'refused', guardrail: 'mailer_unavailable' });
    expect(await t.store.get(request.id, new Date(NOW))).toMatchObject({ status: 'pending' });
    expect(t.auditLog.rows).toEqual([]);
  });

  it('a request already decided is stale', async () => {
    const t = setupRequests({ actor: ADMIN });
    const request = await t.file(RITA);
    expect(await t.people.declineRequest({ id: request.id })).toMatchObject({ ok: true });
    expect(await t.people.declineRequest({ id: request.id })).toMatchObject({ ok: false, code: 'stale', error: 'That request was already declined.' });
    expect(await t.people.approveRequest({ id: request.id })).toMatchObject({ ok: false, code: 'stale', error: 'That request was already declined.' });
    expect(t.pool.writes()).toEqual([]);
    expect(t.auditLog.rows).toHaveLength(2);
  });
});
