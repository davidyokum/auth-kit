import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { mockClient } from 'aws-sdk-client-mock';
import { describe, expect, it } from 'vitest';
import {
  auditLogAppPolicy,
  auditLogResourcePolicy,
  createSesInviteMailer,
  describeActivity,
  describeAwsError,
  lostPasskeyGuidance,
  peopleAdminPolicy,
  renderInviteEmail,
  renderOwnerAlertEmail,
  renderOwnerInviteWarningEmail,
  roleLabel,
  type ActivityEntry,
} from '../../src/admin/index.js';

const invite = {
  email: 'alice@example.org',
  name: 'Alice <script>',
  siteName: 'Example & Co',
  signInUrl: 'https://reports.example.org/sign-in?x="1"',
  expiresAt: new Date('2026-10-24T12:00:00Z'),
};

describe('invite email', () => {
  it('says where to sign in and when it expires, escapes HTML, and carries no secret', () => {
    const email = renderInviteEmail(invite);
    expect(email.subject).toBe("You're invited to Example & Co");
    expect(email.text).toContain('Sign in at https://reports.example.org/sign-in?x="1"');
    expect(email.text).toContain('expires on October 24, 2026 (UTC)');
    expect(email.html).toContain('Alice &lt;script&gt;');
    expect(email.html).toContain('Example &amp; Co');
    expect(email.html).toContain('href="https://reports.example.org/sign-in?x=&quot;1&quot;"');
    expect(email.html).not.toContain('<script>');
    expect(`${email.text}${email.html}`).not.toMatch(/password|\{####\}/i);
  });

  it('sends through SESv2 from the verified identity', async () => {
    const client = new SESv2Client({ region: 'us-east-1', credentials: { accessKeyId: 'x', secretAccessKey: 'y' } });
    const ses = mockClient(client);
    ses.on(SendEmailCommand).resolves({ MessageId: 'm-1' });
    const mailer = createSesInviteMailer({ from: 'Example <noreply@example.org>', client, configurationSet: 'auth', replyTo: ['help@example.org'] });
    await mailer.sendInvite(invite);
    const input = ses.commandCalls(SendEmailCommand)[0]!.args[0].input;
    expect(input).toMatchObject({
      FromEmailAddress: 'Example <noreply@example.org>',
      Destination: { ToAddresses: ['alice@example.org'] },
      ConfigurationSetName: 'auth',
      ReplyToAddresses: ['help@example.org'],
      Content: { Simple: { Subject: { Data: "You're invited to Example & Co", Charset: 'UTF-8' } } },
    });
    expect(() => createSesInviteMailer({ from: '' })).toThrow(/from/);
  });
});

describe('owner-grant alert email (the default notifier)', () => {
  const alert = {
    siteName: 'Example Reports',
    owners: [
      { sub: 'o1', email: 'olivia@example.org' },
      { sub: 'o2', email: 'priya@example.org' },
      { sub: 'o2b', email: 'priya@example.org' },
      { sub: 'g', email: 'grace@example.org', name: 'Grace <b>' },
    ],
    grantedTo: { sub: 'g', email: 'grace@example.org', name: 'Grace <b>' },
    grantedBy: { sub: 'o1', email: 'olivia@example.org' },
    via: 'changeRole' as const,
    reason: 'Second owner',
    at: new Date('2026-10-17T15:04:00Z'),
    context: { ip: '203.0.113.24', userAgent: 'Safari', requestId: 'req-1' },
  };

  it('says who, whom, when, from where, why, and what to do', () => {
    const email = renderOwnerAlertEmail(alert);
    expect(email.subject).toBe('Example Reports: grace@example.org is now an owner');
    expect(email.text).toContain('olivia@example.org made Grace <b> (grace@example.org) an owner of Example Reports.');
    expect(email.text).toContain('When: 2026-10-17 15:04 UTC');
    expect(email.text).toContain('Reason given: Second owner');
    expect(email.text).toContain('From: 203.0.113.24 (Safari)');
    expect(email.text).toMatch(/didn't expect it, disable both accounts/);
    expect(email.html).toContain('Grace &lt;b&gt;');
    expect(email.html).not.toContain('<b>');
  });

  it('goes to every owner in one SES message, from the site sender', async () => {
    const client = new SESv2Client({ region: 'us-east-1', credentials: { accessKeyId: 'x', secretAccessKey: 'y' } });
    const ses = mockClient(client);
    ses.on(SendEmailCommand).resolves({ MessageId: 'm-1' });
    const mailer = createSesInviteMailer({ from: 'Example <noreply@example.org>', client });
    await mailer.ownerGranted(alert);
    const calls = ses.commandCalls(SendEmailCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toMatchObject({
      FromEmailAddress: 'Example <noreply@example.org>',
      Destination: { ToAddresses: ['olivia@example.org', 'priya@example.org', 'grace@example.org'] },
    });
    await expect(mailer.ownerGranted({ ...alert, owners: [] })).rejects.toThrow(/no owner/);
    ses.on(SendEmailCommand).rejects(Object.assign(new Error('nope'), { name: 'MessageRejected' }));
    await expect(mailer.ownerGranted(alert)).rejects.toMatchObject({ name: 'MessageRejected' });
  });
});

describe('last-owner warning email (the sweep leaves the only owner’s unused invite open)', () => {
  const warning = {
    siteName: 'Example & Co',
    owner: { sub: 'o1', email: 'olivia@example.org', name: 'Olivia <b>' },
    to: { email: 'olivia@example.org', kind: 'owner' as const },
    invitedAt: new Date('2026-10-10T12:00:00Z'),
    expiredAt: new Date('2026-10-17T12:00:00Z'),
    signInUrl: 'https://reports.example.org/sign-in?x="1"&$&',
    at: new Date('2026-10-17T13:00:00Z'),
  };

  it('tells the owner why the invite is still open and where to sign in, escaping HTML', () => {
    const email = renderOwnerInviteWarningEmail(warning);
    expect(email.subject).toBe("Your owner invite to Example & Co hasn't been used");
    expect(email.text).toContain('Hi Olivia <b>,');
    expect(email.text).toContain('invited as an owner of Example & Co on October 10, 2026 (UTC)');
    expect(email.text).toContain("you're the site's only owner, so yours was left open");
    expect(email.text).toContain('Sign in at https://reports.example.org/sign-in?x="1"&$& with this email address');
    expect(email.html).toContain('<a href="https://reports.example.org/sign-in?x=&quot;1&quot;&amp;$&amp;">');
    expect(email.html).toContain('Olivia &lt;b&gt;');
    expect(email.html).not.toContain('<b>');
    expect(`${email.text}${email.html}`).not.toMatch(/password|code:/i);
    const { signInUrl: _signInUrl, ...withoutUrl } = warning;
    expect(renderOwnerInviteWarningEmail(withoutUrl).text).toContain('Sign in to Example & Co with this email address');
  });

  it('tells the fallback address whose invite it is and how to resolve it', () => {
    const email = renderOwnerInviteWarningEmail({ ...warning, to: { email: 'ops@example.org', kind: 'fallback' } });
    expect(email.subject).toBe("Example & Co: the owner invite for olivia@example.org hasn't been used");
    expect(email.text).toContain('The owner invite for Olivia <b> (olivia@example.org) on Example & Co');
    expect(email.text).toMatch(/make someone else an owner: the next run then disables this invite/);
    expect(email.html).not.toContain('<a ');
  });

  it('goes through SESv2, one message per recipient', async () => {
    const client = new SESv2Client({ region: 'us-east-1', credentials: { accessKeyId: 'x', secretAccessKey: 'y' } });
    const ses = mockClient(client);
    ses.on(SendEmailCommand).resolves({ MessageId: 'm-1' });
    const mailer = createSesInviteMailer({ from: 'Example <noreply@example.org>', client });
    await mailer.ownerInviteUnused(warning);
    await mailer.ownerInviteUnused({ ...warning, to: { email: 'ops@example.org', kind: 'fallback' } });
    expect(ses.commandCalls(SendEmailCommand).map((c) => c.args[0].input.Destination)).toEqual([
      { ToAddresses: ['olivia@example.org'] },
      { ToAddresses: ['ops@example.org'] },
    ]);
    await expect(mailer.ownerInviteUnused({ ...warning, to: { email: '', kind: 'owner' } })).rejects.toThrow(/no address/);
  });
});

describe('IAM policies', () => {
  // A placeholder: this repo is public, and the hygiene test refuses anything shaped like an account ID.
  const arn = 'arn:aws:dynamodb:us-east-1:111:table/audit';
  it('the app gets PutItem and Query only', () => {
    const policy = auditLogAppPolicy(arn);
    expect(policy.Statement.flatMap((s) => s.Action).sort()).toEqual(['dynamodb:PutItem', 'dynamodb:Query']);
    expect(policy.Statement.find((s) => s.Sid === 'AuditLogQuery')!.Resource).toEqual([arn, `${arn}/index/*`]);
  });

  it('the resource policy denies edits to everyone, and deletion outside sandboxes', () => {
    const kept = auditLogResourcePolicy();
    expect(kept.Statement.every((s) => s.Effect === 'Deny' && s.Principal === '*')).toBe(true);
    expect(kept.Statement.flatMap((s) => s.Action)).toEqual(expect.arrayContaining(['dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:BatchWriteItem', 'dynamodb:DeleteTable']));
    expect(auditLogResourcePolicy({ denyDeleteTable: false }).Statement.flatMap((s) => s.Action)).not.toContain('dynamodb:DeleteTable');
  });

  it('the People page role: Cognito reads and writes on one pool, delete optional, SES and audit when given', () => {
    const pool = 'arn:aws:cognito-idp:us-east-1:111:userpool/us-east-1_TestPool1';
    const full = peopleAdminPolicy({ userPoolArn: pool, auditTableArn: arn, sesResourceArns: ['arn:aws:ses:us-east-1:111:identity/example.org'] });
    const actions = full.Statement.flatMap((s) => s.Action);
    expect(actions).toEqual(expect.arrayContaining(['cognito-idp:ListUsers', 'cognito-idp:AdminCreateUser', 'cognito-idp:AdminDeleteUser', 'ses:SendEmail', 'dynamodb:PutItem']));
    expect(actions).not.toContain('cognito-idp:AdminSetUserPassword');
    expect(peopleAdminPolicy({ userPoolArn: pool, allowDelete: false }).Statement.flatMap((s) => s.Action)).not.toContain('cognito-idp:AdminDeleteUser');
  });
});

describe('copy', () => {
  it('names roles the way screens do', () => {
    expect(roleLabel('superadmin')).toBe('Owner');
    expect(roleLabel('member')).toBe('Member');
    expect(roleLabel(null)).toBe('Member');
    expect(roleLabel('reviewer')).toBe('reviewer');
  });

  it('guides a lost passkey through the person’s own account, and differs for an admin pool', () => {
    const everyday = lostPasskeyGuidance();
    expect(everyday.why).toMatch(/No admin call lists or deletes/);
    expect(everyday.calls).toEqual(['AdminUserGlobalSignOut']);
    expect(everyday.steps.join(' ')).toMatch(/emailed code.*My account.*delete and invite again/s);
    expect(lostPasskeyGuidance({ emailCodes: false }).steps.join(' ')).toMatch(/no emailed codes/);
  });

  it('words Activity entries plainly, including attempts and unrecorded outcomes', () => {
    const base = {
      id: 'r1',
      at: '2026-10-17T10:00:00.000Z',
      startedAt: '2026-10-17T10:00:00.000Z',
      actor: { sub: 'b', email: 'bob@example.org' },
      action: 'people.changeRole',
      target: { sub: 'g', email: 'grace@example.org' },
      before: { adminRole: 'editor' },
      after: { adminRole: 'admin' },
      reason: 'Runs the newsletter',
      context: { ip: '203.0.113.24', userAgent: 'Safari' },
    };
    const ok: ActivityEntry = { status: 'ok', event: { ...base, phase: 'result', outcome: 'ok', calls: ['AdminRemoveUserFromGroup editor: ok', 'AdminAddUserToGroup admin: ok'] } };
    expect(describeActivity(ok, (sub) => (sub === 'g' ? 'Grace' : undefined))).toEqual({
      actor: 'bob@example.org',
      verb: 'changed the role of',
      target: 'Grace',
      change: 'Editor → Admin',
      reason: 'Runs the newsletter',
      status: 'ok',
      trail: 'intent logged → AdminRemoveUserFromGroup editor: ok → AdminAddUserToGroup admin: ok → result: ok',
      from: '203.0.113.24 · Safari',
    });
    expect(describeActivity({ status: 'refused', event: { ...base, phase: 'refused', error: 'self: Nobody can change their own role.' } })).toMatchObject({
      verb: 'tried to change the role of',
      status: 'refused: self: Nobody can change their own role.',
      trail: 'refused, no change made',
    });
    expect(describeActivity({ status: 'unknown', event: { ...base, phase: 'intent' } }).status).toMatch(/outcome not recorded/);
    expect(describeActivity({ status: 'ok', event: { ...base, phase: 'result', actor: { sub: 'system:invite-expiry', kind: 'system' } } }).actor).toBe('Scheduled job');
  });

  it('explains AWS errors without leaking internals', () => {
    expect(describeAwsError({ name: 'TooManyRequestsException' })).toMatch(/shared by every app/);
    expect(describeAwsError({ name: 'AccessDeniedException' })).toMatch(/IAM policy/);
    expect(describeAwsError(new Error('secret stack detail'))).toBe("AWS couldn't complete the call (Error).");
  });
});
