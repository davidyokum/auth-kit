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
  renderOwnerInviteWarningEmail,
  renderOwnershipTransferEmail,
  renderSuperadminGrantEmail,
  ownerCountWarning,
  RESOURCE_ACCESS_NOTE,
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
  it('says where to sign in and when it expires, escapes HTML, and carries no secret (Card Studio, REPORT §5.2a)', () => {
    const email = renderInviteEmail({ ...invite, invitedBy: { name: 'Jordan <b>', email: 'jordan@example.org' }, roleLabel: 'Admin – view only', helpEmail: 'help@example.org', theme: 'osbm' });
    expect(email.subject).toBe('Jordan <b> invited you to Example & Co');
    expect(email.text).toContain('Jordan <b> gave you access to Example & Co. Your role: Admin – view only.');
    expect(email.text).toContain('1. Go to https://reports.example.org/sign-in?x="1"');
    expect(email.text).toContain('2. Enter this email address: alice@example.org');
    expect(email.text).toContain('This invitation expires on Saturday, October 24 at 8:00 AM Eastern.');
    expect(email.html).toContain('Jordan &lt;b&gt;');
    expect(email.html).toContain('Example &amp; Co');
    expect(email.html).toContain('href="https://reports.example.org/sign-in?x=&quot;1&quot;"');
    expect(email.html).not.toContain('<b>');
    expect(email.text).toContain('This site is managed by the NC Office of State Budget and Management. Help: help@example.org.');
    expect(email.replyTo).toEqual(['jordan@example.org']);
    expect(`${email.text}${email.html}`).not.toMatch(/\{####\}/);
    const plain = renderInviteEmail(invite);
    expect(plain.subject).toBe('You’re invited to Example & Co');
    expect(plain.text).toContain('You’ve been given access to Example & Co. Your role: Member.');
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
      Content: { Simple: { Subject: { Data: 'You’re invited to Example & Co', Charset: 'UTF-8' } } },
    });
    // An email with its own Reply-To (an invite from someone) wins over the mailer's.
    await mailer.sendInvite({ ...invite, invitedBy: { email: 'jordan@example.org' } });
    expect(ses.commandCalls(SendEmailCommand)[1]!.args[0].input.ReplyToAddresses).toEqual(['jordan@example.org']);
    await mailer.sendEmail({ to: ['x@example.org'], email: { subject: 'S', text: 'T', html: 'H' }, replyTo: ['help@example.org'] });
    expect(ses.commandCalls(SendEmailCommand)[2]!.args[0].input).toMatchObject({ Destination: { ToAddresses: ['x@example.org'] }, ReplyToAddresses: ['help@example.org'] });
    await expect(mailer.sendEmail({ to: [], email: { subject: 'S', text: 'T', html: 'H' } })).rejects.toThrow(/recipient/);
    expect(() => createSesInviteMailer({ from: '' })).toThrow(/from/);
  });
});

describe('Super admin grant alert email (the default notifier)', () => {
  const alert = {
    siteName: 'Example Reports',
    owners: [
      { sub: 'o1', email: 'olivia@example.org' },
      { sub: 'o1b', email: 'olivia@example.org' },
    ],
    grantedTo: { sub: 'g', email: 'grace@example.org', name: 'Grace <b>' },
    grantedBy: { sub: 'o1', email: 'olivia@example.org' },
    via: 'changeRole' as const,
    reason: 'Deputy',
    at: new Date('2026-10-17T15:04:00Z'),
    context: { ip: '203.0.113.24', userAgent: 'Safari', requestId: 'req-1' },
  };

  it('says who, whom, when, from where, why, and what to do', () => {
    const email = renderSuperadminGrantEmail(alert);
    expect(email.subject).toBe('Example Reports: grace@example.org is now a Super admin');
    expect(email.text).toContain('olivia@example.org made Grace <b> (grace@example.org) a Super admin of Example Reports.');
    expect(email.text).toContain('When: 2026-10-17 15:04 UTC');
    expect(email.text).toContain('Reason given: Deputy');
    expect(email.text).toContain('From: 203.0.113.24 (Safari)');
    expect(email.text).toMatch(/Only the owner can grant it/);
    expect(email.text).toMatch(/didn't expect it, disable the new Super admin/);
    expect(email.html).toContain('Grace &lt;b&gt;');
    expect(email.html).not.toContain('<b>');
  });

  it('goes to the owner in one SES message, from the site sender', async () => {
    const client = new SESv2Client({ region: 'us-east-1', credentials: { accessKeyId: 'x', secretAccessKey: 'y' } });
    const ses = mockClient(client);
    ses.on(SendEmailCommand).resolves({ MessageId: 'm-1' });
    const mailer = createSesInviteMailer({ from: 'Example <noreply@example.org>', client });
    await mailer.superadminGranted(alert);
    const calls = ses.commandCalls(SendEmailCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toMatchObject({
      FromEmailAddress: 'Example <noreply@example.org>',
      Destination: { ToAddresses: ['olivia@example.org'] },
    });
    await expect(mailer.superadminGranted({ ...alert, owners: [] })).rejects.toThrow(/no owner/);
    ses.on(SendEmailCommand).rejects(Object.assign(new Error('nope'), { name: 'MessageRejected' }));
    await expect(mailer.superadminGranted(alert)).rejects.toMatchObject({ name: 'MessageRejected' });
  });
});

describe('ownership transfer alert email (the default notifier)', () => {
  const alert = {
    siteName: 'Example Reports',
    previousOwner: { sub: 'o1', email: 'olivia@example.org', name: 'Olivia' },
    newOwner: { sub: 'g', email: 'grace@example.org', name: 'Grace' },
    reason: 'Handing the site over',
    at: new Date('2026-10-18T09:30:00Z'),
    context: { ip: '203.0.113.24', userAgent: 'Safari' },
  };

  it('says who handed the site to whom, when, why, and what each now is', () => {
    const email = renderOwnershipTransferEmail(alert);
    expect(email.subject).toBe('Example Reports: grace@example.org is now the owner');
    expect(email.text).toContain('Olivia (olivia@example.org) transferred ownership of Example Reports to Grace (grace@example.org).');
    expect(email.text).toContain('Reason given: Handing the site over');
    expect(email.text).toContain("grace@example.org is now the site's only owner. olivia@example.org is now a Super admin.");
  });

  it('goes to both owners in one message, and refuses without both addresses', async () => {
    const client = new SESv2Client({ region: 'us-east-1', credentials: { accessKeyId: 'x', secretAccessKey: 'y' } });
    const ses = mockClient(client);
    ses.on(SendEmailCommand).resolves({ MessageId: 'm-1' });
    const mailer = createSesInviteMailer({ from: 'Example <noreply@example.org>', client });
    await mailer.ownershipTransferred(alert);
    expect(ses.commandCalls(SendEmailCommand)[0]!.args[0].input.Destination).toEqual({ ToAddresses: ['olivia@example.org', 'grace@example.org'] });
    await expect(mailer.ownershipTransferred({ ...alert, newOwner: { sub: 'g', email: '' } })).rejects.toThrow(/both/);
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
    expect(email.text).toMatch(/give the owner role to the right person through the break-glass path .*: the next run then disables this invite/);
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
    expect(roleLabel('owner')).toBe('Owner');
    expect(roleLabel('superadmin')).toBe('Super admin');
    expect(roleLabel('admin-content')).toBe(`Admin ${String.fromCharCode(0x2013)} content only`);
    expect(roleLabel('member')).toBe('Member');
    expect(roleLabel(null)).toBe('Member');
    expect(roleLabel('reviewer')).toBe('reviewer');
  });

  it('says site roles aren’t item access, in David’s exact words, never "record" or "resource"', () => {
    expect(RESOURCE_ACCESS_NOTE).toBe('These roles are for running the site. Access to individual projects, plans, and other items is managed on each one.');
  });

  it('flags a site without exactly one owner', () => {
    expect(ownerCountWarning(1)).toBeNull();
    expect(ownerCountWarning(0)).toMatch(/no owner.*Cognito console/s);
    expect(ownerCountWarning(2)).toMatch(/2 owners; it should have exactly one/);
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
      before: { adminRole: 'admin-content' },
      after: { adminRole: 'superadmin' },
      reason: 'Runs the newsletter',
      context: { ip: '203.0.113.24', userAgent: 'Safari' },
    };
    const ok: ActivityEntry = { status: 'ok', event: { ...base, phase: 'result', outcome: 'ok', calls: ['AdminRemoveUserFromGroup admin-content: ok', 'AdminAddUserToGroup superadmin: ok'] } };
    expect(describeActivity(ok, (sub) => (sub === 'g' ? 'Grace' : undefined))).toEqual({
      actor: 'bob@example.org',
      verb: 'changed the role of',
      target: 'Grace',
      change: `Admin ${String.fromCharCode(0x2013)} content only → Super admin`,
      reason: 'Runs the newsletter',
      status: 'ok',
      trail: 'intent logged → AdminRemoveUserFromGroup admin-content: ok → AdminAddUserToGroup superadmin: ok → result: ok',
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

describe('sign-in help changed alert (M8: the owner and every Super admin)', () => {
  const alert = {
    siteName: 'Example Reports',
    owners: [{ sub: 'o1', email: 'olivia@example.org' }],
    superAdmins: [
      { sub: 's1', email: 'sam@example.org' },
      { sub: 's2', email: 'olivia@example.org' },
    ],
    changedBy: { sub: 's3', email: 'rogue@example.org' },
    from: 'help@example.org',
    to: 'desk@example.org',
    reverted: false,
    reason: 'New desk',
    at: new Date('2026-10-18T09:30:00Z'),
  };

  it('goes to the owners and every Super admin in one message, each address once, and still refuses with no owner', async () => {
    const client = new SESv2Client({ region: 'us-east-1', credentials: { accessKeyId: 'x', secretAccessKey: 'y' } });
    const ses = mockClient(client);
    ses.on(SendEmailCommand).resolves({ MessageId: 'm-1' });
    const mailer = createSesInviteMailer({ from: 'Example <noreply@example.org>', client });
    await mailer.signInHelpChanged(alert);
    expect(ses.commandCalls(SendEmailCommand)[0]!.args[0].input).toMatchObject({ Destination: { ToAddresses: ['olivia@example.org', 'sam@example.org'] } });
    await expect(mailer.signInHelpChanged({ ...alert, owners: [] })).rejects.toThrow(/no owner/);
  });
});
