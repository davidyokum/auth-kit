import { AdminCreateUserCommand, type AdminCreateUserCommandInput } from '@aws-sdk/client-cognito-identity-provider';
import { describe, expect, it } from 'vitest';
import { type AccessRequest, AccessRequestConflictError, createMemoryAccessRequestStore, newRequestId } from '../../src/accounts/index.js';
import {
  DECLINE_REQUESTS_MAX,
  type EmailSender,
  type InviteEmail,
  createMemoryAuditLog,
  createPeopleActions,
  describeActivity,
  renderInviteEmail,
} from '../../src/admin/index.js';
import { amplifyCookieNames, toRequestContext } from '../../src/server/index.js';
import { type AppCapability, type AppGroup, CLIENT_ID, harness } from '../helpers.js';
import { DAY, awsError, fakeUserPool, NOW, type SetupOptions, setup } from '../admin/people-fixture.js';

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

describe('approveRequest: the account’s name is the approver’s, not the requester’s (review L4)', () => {
  const TYPED = 'Jordan Lee (OSBM IT Security — approve today)';

  it('an edited name is what reaches Cognito and the invite; the typed one reaches neither', async () => {
    const t = setupRequests({ actor: ADMIN });
    const request = await t.file({ email: 'jordan@example.org', name: TYPED, reason: 'Approve me' });
    expect(await t.people.approveRequest({ id: request.id, name: '  Jordan Lee  ' })).toMatchObject({ ok: true });
    const [create] = t.pool.inputsOf<AdminCreateUserCommandInput>(AdminCreateUserCommand);
    expect(create!.UserAttributes).toContainEqual({ Name: 'name', Value: 'Jordan Lee' });
    expect(t.pool.users.find((u) => u.email === 'jordan@example.org')).toMatchObject({ name: 'Jordan Lee' });
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({ email: 'jordan@example.org', name: 'Jordan Lee', approved: true });
    expect(JSON.stringify([create, t.sent, t.auditLog.rows])).not.toContain('IT Security');
    expect(t.auditLog.rows.at(-1)).toMatchObject({ outcome: 'ok', after: { name: 'Jordan Lee' } });
  });

  it('with no edit, the typed name is used; an emptied field means no name; over 100 characters is refused', async () => {
    const t = setupRequests({ actor: ADMIN });
    const kept = await t.file({ email: 'sam@example.org', name: 'Sam Lee' });
    await t.people.approveRequest({ id: kept.id });
    expect(t.pool.users.find((u) => u.email === 'sam@example.org')).toMatchObject({ name: 'Sam Lee' });
    expect(t.sent.at(-1)).toMatchObject({ name: 'Sam Lee' });

    const emptied = await t.file({ email: 'dee@example.org', name: TYPED });
    await t.people.approveRequest({ id: emptied.id, name: '   ' });
    expect(t.pool.users.find((u) => u.email === 'dee@example.org')!.name).toBeUndefined();
    expect(t.sent.at(-1)).not.toHaveProperty('name');

    const long = await t.file({ email: 'lee@example.org', name: TYPED });
    const writes = t.pool.writes().length;
    expect(await t.people.approveRequest({ id: long.id, name: 'x'.repeat(101) })).toMatchObject({ ok: false, code: 'invalid', error: 'Name is too long (at most 100 characters).' });
    expect(t.pool.writes()).toHaveLength(writes);
    expect(await t.store.get(long.id, new Date(NOW))).toMatchObject({ status: 'pending' });
  });

  it('the form sends the Name field: what the approver left there is the name', async () => {
    const t = setupRequests({ actor: ADMIN });
    const request = await t.file({ email: 'jordan@example.org', name: TYPED });
    const data = new FormData();
    data.set('id', request.id);
    data.set('role', 'member');
    data.set('name', 'Jordan Lee');
    expect(await t.people.forms.approveRequest(null, data)).toMatchObject({ ok: true });
    expect(t.pool.users.find((u) => u.email === 'jordan@example.org')).toMatchObject({ name: 'Jordan Lee' });
    expect(t.sent[0]).toMatchObject({ name: 'Jordan Lee' });
  });
});

describe('declineRequests: clearing a flood in one go (review M6)', () => {
  const FLOOD = [
    { email: 'a@evil.example', name: 'IT Security: approve now', reason: 'Click https://evil.example/a' },
    { email: 'b@evil.example', name: 'Payroll', reason: 'Wire the funds' },
    { email: 'c@evil.example', name: 'CEO', reason: 'Urgent' },
  ];

  it('declines them all, with one audit entry (intent, then result) listing IDs and addresses, never what they typed', async () => {
    const t = setupRequests({ actor: ADMIN });
    const filed: AccessRequest[] = [];
    for (const r of FLOOD) filed.push(await t.file(r));
    const ids = filed.map((r) => r.id);
    const result = await t.people.declineRequests({ ids, reason: 'A flood of junk requests' });
    expect(result).toMatchObject({ ok: true, message: 'Declined 3 requests. Nobody was told (declining all at once is always silent).' });
    expect(result.declined).toEqual(filed.map((r) => ({ id: r.id, email: r.email })));
    expect(result.skipped).toEqual([]);
    for (const id of ids) expect(await t.store.get(id, new Date(NOW))).toMatchObject({ status: 'declined', settledBy: { sub: 'admin-1' } });
    expect(await t.people.listAccessRequests()).toMatchObject({ state: 'ok', requests: [] });

    expect(t.auditLog.rows.map((r) => [r.phase, r.action])).toEqual([
      ['intent', 'people.declineRequests'],
      ['result', 'people.declineRequests'],
    ]);
    const [intent, done] = t.auditLog.rows;
    expect(done).toMatchObject({ outcome: 'ok', intentId: intent!.id, actor: { sub: 'admin-1' }, before: { status: 'pending' }, reason: 'A flood of junk requests' });
    expect(done!.after).toEqual({ status: 'declined', notified: false, requests: filed.map((r) => ({ id: r.id, email: r.email })) });
    expect(done!.calls).toEqual(['DynamoDB PutItem request: ok', 'DynamoDB PutItem request: ok', 'DynamoDB PutItem request: ok']);
    const logged = auditText(t);
    for (const r of filed) {
      expect(logged).toContain(r.id);
      expect(logged).toContain(r.email);
    }
    for (const r of FLOOD) {
      expect(logged).not.toContain(r.name);
      expect(logged).not.toContain(r.reason);
    }
    expect(t.pool.writes()).toEqual([]);
    expect(t.sent).toEqual([]);

    const line = describeActivity({ event: done!, status: 'ok' });
    expect(line).toMatchObject({ verb: 'declined', target: '3 requests all at once', reason: 'A flood of junk requests', status: 'ok' });
    expect(describeActivity({ event: intent!, status: 'unknown' })).toMatchObject({ verb: 'tried to decline', target: '3 requests all at once' });
  });

  it('never emails the requesters, even where the site sends a note for a single decline', async () => {
    const emails: SentEmail[] = [];
    const mailer = {
      sendInvite: () => Promise.resolve(),
      sendEmail: (message: SentEmail) => {
        emails.push(message);
        return Promise.resolve();
      },
    };
    const t = setupRequests({ actor: ADMIN, config: { notifyOnDecline: true, mailer, emailSender: mailer } });
    const ids: string[] = [];
    for (const r of FLOOD) ids.push((await t.file(r)).id);
    expect(await t.people.declineRequests({ ids })).toMatchObject({ ok: true, message: 'Declined 3 requests. Nobody was told (declining all at once is always silent).' });
    expect(emails).toEqual([]);
    expect(t.auditLog.rows.at(-1)).toMatchObject({ after: { notified: false } });
    expect(t.auditLog.rows.at(-1)!.calls!.join(' ')).not.toContain('SES');
    // A single decline on the same site still tells the person.
    const one = await t.file({ email: 'rita@example.org' });
    await t.people.declineRequest({ id: one.id });
    expect(emails.map((e) => e.to)).toEqual([['rita@example.org']]);
  });

  it(`takes at most ${DECLINE_REQUESTS_MAX} IDs a call, and refuses an empty or malformed list`, async () => {
    expect(DECLINE_REQUESTS_MAX).toBe(100);
    const t = setupRequests({ actor: ADMIN });
    const ids: string[] = [];
    for (let i = 0; i < 101; i++) ids.push((await t.file({ email: `flood${i}@evil.example`, name: `Flood ${i}` }, 1 + i / 1000)).id);
    expect(await t.people.declineRequests({ ids })).toMatchObject({ ok: false, code: 'invalid', error: 'Decline at most 100 requests at a time.', changed: 'nothing' });
    expect(t.auditLog.rows).toEqual([]);
    expect(t.store.all().filter((r) => r.status === 'pending')).toHaveLength(101);
    expect(await t.people.declineRequests({ ids: [] })).toMatchObject({ ok: false, code: 'invalid', error: 'Choose at least one request to decline.' });
    expect(await t.people.declineRequests({ ids: [ids[0]!, 'not-an-id'] })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await t.people.declineRequests({ ids: 'x' } as never)).toMatchObject({ ok: false, code: 'invalid' });
    expect(t.auditLog.rows).toEqual([]);
    // Exactly 100 is fine; a repeated ID is declined once.
    const hundred = await t.people.declineRequests({ ids: [...ids.slice(0, 99), ids[0]!] });
    expect(hundred).toMatchObject({ ok: true, message: 'Declined 99 requests. Nobody was told (declining all at once is always silent).' });
    expect(hundred.declined).toHaveLength(99);
    expect(
      t.store
        .all()
        .filter((r) => r.status === 'pending')
        .map((r) => r.id)
        .sort(),
    ).toEqual([ids[99], ids[100]].sort());
    expect(t.auditLog.rows).toHaveLength(2);
  });

  it('needs people.manage, read live: a token that still says admin isn’t enough once the role is gone', async () => {
    const t = setupRequests({ actor: ADMIN });
    const ids: string[] = [];
    for (const r of FLOOD) ids.push((await t.file(r)).id);
    // Demoted since signing in: the token still carries admin-content-people.
    t.h.cognito.setLiveState('admin-1', { enabled: true, groups: ['admin-content'] });
    expect(await t.people.declineRequests({ ids })).toMatchObject({ ok: false, code: 'forbidden', changed: 'nothing' });
    for (const id of ids) expect(await t.store.get(id, new Date(NOW))).toMatchObject({ status: 'pending' });
    expect(t.auditLog.rows.map((r) => [r.phase, r.action])).toEqual([['refused', 'people.declineRequests']]);

    const viewer = setupRequests({ actor: VIEWER });
    const id = (await viewer.file(RITA)).id;
    expect(await viewer.people.declineRequests({ ids: [id] })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await viewer.store.get(id, new Date(NOW))).toMatchObject({ status: 'pending' });
  });

  it('leaves requests that aren’t pending alone, and says which and why', async () => {
    const t = setupRequests({ actor: ADMIN });
    const approved = await t.file({ email: 'approved@example.org', name: 'Approved' });
    await t.store.settle(approved.id, { status: 'approved', by: { sub: 'super-1' }, now: new Date(NOW - 1000) });
    const declined = await t.file({ email: 'declined@example.org' });
    await t.store.settle(declined.id, { status: 'declined', by: { sub: 'super-1' }, now: new Date(NOW - 1000) });
    const expired = await t.file({ email: 'expired@example.org' }, 31);
    const gone = newRequestId(new Date(NOW - DAY));
    const pending = await t.file({ email: 'pending@evil.example', name: 'Pending', reason: 'Spam' });

    const result = await t.people.declineRequests({ ids: [approved.id, declined.id, expired.id, gone, pending.id] });
    expect(result).toMatchObject({
      ok: true,
      message:
        'Declined 1 request. Nobody was told (declining all at once is always silent). 4 weren’t pending, so they were left alone: 1 already approved, 1 already declined, 1 expired, and 1 no longer there.',
    });
    expect(result.declined).toEqual([{ id: pending.id, email: 'pending@evil.example' }]);
    expect(result.skipped).toEqual([
      { id: approved.id, email: 'approved@example.org', status: 'approved' },
      { id: declined.id, email: 'declined@example.org', status: 'declined' },
      { id: expired.id, email: 'expired@example.org', status: 'expired' },
      { id: gone, status: 'gone' },
    ]);
    // The settled ones keep who settled them and when.
    expect(await t.store.get(approved.id, new Date(NOW))).toMatchObject({ status: 'approved', settledBy: { sub: 'super-1' }, settledAt: new Date(NOW - 1000).toISOString() });
    expect(await t.store.get(declined.id, new Date(NOW))).toMatchObject({ status: 'declined', settledBy: { sub: 'super-1' } });
    expect(await t.store.get(expired.id, new Date(NOW))).toMatchObject({ status: 'expired' });
    expect(await t.store.get(pending.id, new Date(NOW))).toMatchObject({ status: 'declined', settledBy: { sub: 'admin-1' } });
    expect(t.auditLog.rows).toHaveLength(2);
    expect(t.auditLog.rows[1]).toMatchObject({ after: { requests: [{ id: pending.id, email: 'pending@evil.example' }], skipped: result.skipped } });
    expect(t.auditLog.rows[1]!.calls).toEqual(['DynamoDB PutItem request: ok']);
    expect(auditText(t)).not.toContain('Approved"');
    expect(auditText(t)).not.toContain('Spam');
  });

  it('nothing pending among them: stale, and nothing is written', async () => {
    const t = setupRequests({ actor: ADMIN });
    const declined = await t.file({ email: 'declined@example.org' });
    await t.store.settle(declined.id, { status: 'declined', by: { sub: 'super-1' }, now: new Date(NOW - 1000) });
    const result = await t.people.declineRequests({ ids: [declined.id, newRequestId(new Date(NOW))] });
    expect(result).toMatchObject({ ok: false, code: 'stale', error: 'None of those requests is pending any more: 1 already declined and 1 no longer there. Nothing changed.', changed: 'nothing' });
    expect(result.skipped).toHaveLength(2);
    expect(t.auditLog.rows).toEqual([]);
  });

  it('one decided by someone else while it runs is left alone (the store’s conditional write), and the rest are declined', async () => {
    const t = setupRequests({ actor: ADMIN });
    const ids: string[] = [];
    for (const r of FLOOD) ids.push((await t.file(r)).id);
    const settle = t.store.settle.bind(t.store);
    t.store.settle = async (id, input) => {
      if (id === ids[1]) {
        // Another admin approves it between the read and the write.
        await settle(id, { status: 'approved', by: { sub: 'super-1' }, now: input.now });
        return settle(id, input);
      }
      return settle(id, input);
    };
    const result = await t.people.declineRequests({ ids });
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.message).toBe('Declined 2 requests. Nobody was told (declining all at once is always silent). 1 wasn’t pending, so it was left alone: 1 decided by someone else just now.');
    expect(result.skipped).toEqual([{ id: ids[1], email: 'b@evil.example', status: 'changed' }]);
    expect(await t.store.get(ids[1]!, new Date(NOW))).toMatchObject({ status: 'approved', settledBy: { sub: 'super-1' } });
    expect(t.auditLog.rows[1]!.calls).toEqual(['DynamoDB PutItem request: ok', 'DynamoDB PutItem request: failed (AccessRequestConflictError)', 'DynamoDB PutItem request: ok']);
    expect(t.auditLog.rows[1]).toMatchObject({ outcome: 'ok', after: { requests: [{ id: ids[0] }, { id: ids[2] }], skipped: [{ id: ids[1], status: 'changed' }] } });

    // Every one decided meanwhile: stale, not "Declined 0".
    const u = setupRequests({ actor: ADMIN });
    const only = (await u.file(RITA)).id;
    u.store.settle = () => Promise.reject(new AccessRequestConflictError());
    expect(await u.people.declineRequests({ ids: [only] })).toMatchObject({ ok: false, code: 'stale', error: 'None of those requests was declined: 1 decided by someone else just now.' });
  });

  it('a store failure part-way stops the run and says part of it was done; the log shows which calls landed', async () => {
    const t = setupRequests({ actor: ADMIN });
    const ids: string[] = [];
    for (const r of FLOOD) ids.push((await t.file(r)).id);
    const settle = t.store.settle.bind(t.store);
    t.store.settle = (id, input) => (id === ids[1] ? Promise.reject(awsError('ProvisionedThroughputExceededException', 'Throttled.')) : settle(id, input));
    const result = await t.people.declineRequests({ ids });
    expect(result).toMatchObject({ ok: false, code: 'failed', changed: 'partly' });
    expect(!result.ok && result.error).toMatch(/Some of the requests were declined before it stopped/);
    expect((await t.store.get(ids[0]!, new Date(NOW)))!.status).toBe('declined');
    expect((await t.store.get(ids[1]!, new Date(NOW)))!.status).toBe('pending');
    expect((await t.store.get(ids[2]!, new Date(NOW)))!.status).toBe('pending');
    expect(t.auditLog.rows.map((r) => r.phase)).toEqual(['intent', 'result']);
    expect(t.auditLog.rows[1]).toMatchObject({ outcome: 'partial', calls: ['DynamoDB PutItem request: ok', 'DynamoDB PutItem request: failed (ProvisionedThroughputExceededException)'] });
  });

  it('the form adapter reads every id field and the reason', async () => {
    const t = setupRequests({ actor: ADMIN });
    const ids: string[] = [];
    for (const r of FLOOD) ids.push((await t.file(r)).id);
    const data = new FormData();
    for (const id of ids.slice(0, 2)) data.append('id', id);
    data.set('reason', 'Junk');
    expect(await t.people.forms.declineRequests(null, data)).toMatchObject({ ok: true, message: 'Declined 2 requests. Nobody was told (declining all at once is always silent).' });
    expect(t.store.all().filter((r) => r.status === 'pending').map((r) => r.id)).toEqual([ids[2]]);
    expect(t.auditLog.rows[1]).toMatchObject({ reason: 'Junk' });
    expect(await t.people.forms.declineRequests(null, {} as FormData)).toMatchObject({ ok: false, code: 'invalid', error: 'Expected form data.' });
  });

  it('is off without a request store', async () => {
    expect(await setup().people.declineRequests({ ids: [newRequestId(new Date(NOW))] })).toMatchObject({ ok: false, code: 'refused', guardrail: 'not_available' });
  });
});
