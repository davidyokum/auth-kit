import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

export interface InviteEmail {
  email: string;
  name?: string;
  siteName: string;
  /** Absolute sign-in URL. */
  signInUrl: string;
  expiresAt: Date;
}

/** Sends the branded invite email (Cognito's own invite is suppressed in `emailed-code` mode). */
export interface InviteMailer {
  sendInvite(input: InviteEmail): Promise<void>;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function longDate(date: Date): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' }).format(date);
}

/**
 * The default invite email: where to sign in, that a code is coming, and when the invite expires.
 * It never contains a password or a code, so a forwarded or leaked invite email gives nothing away.
 */
export function renderInviteEmail(input: InviteEmail): RenderedEmail {
  const hello = input.name ? `Hi ${input.name},` : 'Hello,';
  const expires = longDate(input.expiresAt);
  const subject = `You're invited to ${input.siteName}`;
  const text = [
    hello,
    '',
    `You've been invited to ${input.siteName}.`,
    '',
    `Sign in at ${input.signInUrl} with this email address. We'll email you a one-time code; then save a passkey so next time is one tap.`,
    '',
    `This invite expires on ${expires} (UTC). If you weren't expecting it, you can ignore this email.`,
  ].join('\n');
  const url = escapeHtml(input.signInUrl);
  const html = [
    `<p>${escapeHtml(hello)}</p>`,
    `<p>You've been invited to <strong>${escapeHtml(input.siteName)}</strong>.</p>`,
    `<p><a href="${url}">Sign in</a> with this email address. We'll email you a one-time code; then save a passkey so next time is one tap.</p>`,
    `<p>This invite expires on ${escapeHtml(expires)} (UTC). If you weren't expecting it, you can ignore this email.</p>`,
  ].join('\n');
  return { subject, text, html };
}

/** Who an owner-grant alert goes to and what it says. */
export interface OwnerGrantAlert {
  siteName: string;
  /** Every current owner (read live after the grant, so the new owner is included). */
  owners: readonly { sub: string; email: string; name?: string }[];
  grantedTo: { sub: string; email: string; name?: string };
  grantedBy: { sub: string; email?: string };
  /** How the role was granted. */
  via: 'changeRole' | 'invite';
  reason?: string;
  at: Date;
  context?: { ip?: string; userAgent?: string; requestId?: string };
}

/**
 * Tells every owner that someone was made an owner. Granting the owner role requires it: if the alert
 * can't be sent, the grant is undone. Throw to report a failure.
 */
export interface OwnerAlertNotifier {
  ownerGranted(alert: OwnerGrantAlert): Promise<void>;
}

/** The default owner-grant alert: who, whom, when, from where, why, and what to do if it's unexpected. */
export function renderOwnerAlertEmail(alert: OwnerGrantAlert): RenderedEmail {
  const who = alert.grantedBy.email ?? alert.grantedBy.sub;
  const whom = alert.grantedTo.name ? `${alert.grantedTo.name} (${alert.grantedTo.email})` : alert.grantedTo.email;
  const when = `${alert.at.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
  const lines = [
    `${who} made ${whom} an owner of ${alert.siteName}${alert.via === 'invite' ? ' by inviting them as one' : ''}.`,
    '',
    `When: ${when}`,
    ...(alert.reason ? [`Reason given: ${alert.reason}`] : []),
    ...(alert.context?.ip ? [`From: ${alert.context.ip}${alert.context.userAgent ? ` (${alert.context.userAgent})` : ''}`] : []),
    ...(alert.context?.requestId ? [`Request: ${alert.context.requestId}`] : []),
    '',
    'Owners can manage admins, security settings, exports, and delete accounts. Every owner gets this email.',
    `If you didn't expect it, disable both accounts from the People page (or the break-glass path) and check the Activity page.`,
  ];
  return {
    subject: `${alert.siteName}: ${alert.grantedTo.email} is now an owner`,
    text: lines.join('\n'),
    html: lines.map((l) => (l === '' ? '' : `<p>${escapeHtml(l)}</p>`)).filter(Boolean).join('\n'),
  };
}

export interface SesInviteMailerOptions {
  /** A verified SES identity, e.g. `Example Reports <noreply@example.org>`. */
  from: string;
  region?: string;
  client?: SESv2Client;
  configurationSet?: string;
  replyTo?: readonly string[];
  /** Your own invite template. Default `renderInviteEmail`. */
  render?: (input: InviteEmail) => RenderedEmail;
  /** Your own owner-alert template. Default `renderOwnerAlertEmail`. */
  renderOwnerAlert?: (alert: OwnerGrantAlert) => RenderedEmail;
}

/**
 * The site's mailer through SES (SESv2 `SendEmail`): the invite email, and the alert every owner gets
 * when someone is made an owner (one message to all of them, so it's sent to all or to none). The
 * server's role needs `ses:SendEmail` on the identity.
 */
export function createSesInviteMailer(options: SesInviteMailerOptions): InviteMailer & OwnerAlertNotifier {
  if (!options.from) throw new Error('auth-kit: createSesInviteMailer needs a from address.');
  let client = options.client;
  const ses = (): SESv2Client => (client ??= new SESv2Client(options.region ? { region: options.region } : {}));
  const render = options.render ?? renderInviteEmail;
  const renderAlert = options.renderOwnerAlert ?? renderOwnerAlertEmail;
  const send = async (to: string[], email: RenderedEmail) => {
    await ses().send(
      new SendEmailCommand({
        FromEmailAddress: options.from,
        Destination: { ToAddresses: to },
        ...(options.replyTo !== undefined && { ReplyToAddresses: [...options.replyTo] }),
        ...(options.configurationSet !== undefined && { ConfigurationSetName: options.configurationSet }),
        Content: {
          Simple: {
            Subject: { Data: email.subject, Charset: 'UTF-8' },
            Body: { Text: { Data: email.text, Charset: 'UTF-8' }, Html: { Data: email.html, Charset: 'UTF-8' } },
          },
        },
      }),
    );
  };
  return {
    sendInvite: (input) => send([input.email], render(input)),
    async ownerGranted(alert) {
      const to = [...new Set(alert.owners.map((o) => o.email).filter(Boolean))];
      if (to.length === 0) throw new Error('auth-kit: no owner has an email address to alert.');
      await send(to, renderAlert(alert));
    },
  };
}
