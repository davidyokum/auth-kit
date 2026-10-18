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

/**
 * The site's last owner hasn't used their invite (ADR 0019): the invite-expiry sweep left it enabled,
 * because a site keeps at least one owner, and warns the owner and, in a separate message, an
 * optional fallback address.
 */
export interface OwnerInviteWarning {
  siteName: string;
  /** The owner whose invite is unused. */
  owner: { sub: string; email: string; name?: string };
  /** Who this message goes to: the owner, or the configured fallback address (an operator). */
  to: { email: string; kind: 'owner' | 'fallback' };
  /** When the invite was sent (the account's creation). */
  invitedAt: Date;
  /** When its 7 days ran out. */
  expiredAt: Date;
  /** Absolute sign-in URL, when the sender knows it. */
  signInUrl?: string;
  at: Date;
}

/** Sends the last-owner warning, one message per recipient. Throw to report a failure. */
export interface OwnerInviteWarningNotifier {
  ownerInviteUnused(warning: OwnerInviteWarning): Promise<void>;
}

/**
 * The default last-owner warning. The owner's copy says why the invite is still open and where to
 * sign in; the fallback copy says whose invite it is and how to resolve it.
 */
export function renderOwnerInviteWarningEmail(warning: OwnerInviteWarning): RenderedEmail {
  const sent = longDate(warning.invitedAt);
  const expired = longDate(warning.expiredAt);
  const site = warning.siteName;
  let subject: string;
  let lines: string[];
  if (warning.to.kind === 'owner') {
    subject = `Your owner invite to ${site} hasn't been used`;
    lines = [
      warning.owner.name ? `Hi ${warning.owner.name},` : 'Hello,',
      '',
      `You were invited as an owner of ${site} on ${sent} (UTC), and the invite hasn't been used. Invites expire after 7 days (yours on ${expired}), but you're the site's only owner, so yours was left open.`,
      '',
      warning.signInUrl
        ? `Sign in at ${warning.signInUrl} with this email address to keep your owner access.`
        : `Sign in to ${site} with this email address to keep your owner access.`,
      '',
      `Until then, the invite is a live owner account for whoever can sign in with this address. If you weren't expecting it, tell whoever runs ${site}.`,
    ];
  } else {
    const whom = warning.owner.name ? `${warning.owner.name} (${warning.owner.email})` : warning.owner.email;
    subject = `${site}: the owner invite for ${warning.owner.email} hasn't been used`;
    lines = [
      `The owner invite for ${whom} on ${site}, sent ${sent} (UTC), hasn't been used. Invites expire after 7 days (this one on ${expired}), but this is the site's only owner, so the invite-expiry job left it enabled and warned them.`,
      '',
      'Until they sign in, it is a live owner account for whoever controls that inbox.',
      'If the address is wrong, or they no longer need it, make someone else an owner: the next run then disables this invite.',
      '',
      `You get this because you're the fallback contact for ${site}'s owner warnings.`,
    ];
  }
  const url = warning.signInUrl !== undefined ? escapeHtml(warning.signInUrl) : undefined;
  const html = lines
    .filter((l) => l !== '')
    .map((l) => {
      const escaped = escapeHtml(l);
      // A function replacement, so a `$` in the URL is never read as a replacement pattern.
      return url !== undefined && warning.to.kind === 'owner' ? `<p>${escaped.replace(url, () => `<a href="${url}">${url}</a>`)}</p>` : `<p>${escaped}</p>`;
    })
    .join('\n');
  return { subject, text: lines.join('\n'), html };
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
  /** Your own last-owner warning template. Default `renderOwnerInviteWarningEmail`. */
  renderOwnerInviteWarning?: (warning: OwnerInviteWarning) => RenderedEmail;
}

/**
 * The site's mailer through SES (SESv2 `SendEmail`): the invite email, the alert every owner gets
 * when someone is made an owner (one message to all of them, so it's sent to all or to none), and the
 * last-owner warning the invite-expiry sweep sends (one message per recipient). The role needs
 * `ses:SendEmail` on the identity.
 */
export function createSesInviteMailer(options: SesInviteMailerOptions): InviteMailer & OwnerAlertNotifier & OwnerInviteWarningNotifier {
  if (!options.from) throw new Error('auth-kit: createSesInviteMailer needs a from address.');
  let client = options.client;
  const ses = (): SESv2Client => (client ??= new SESv2Client(options.region ? { region: options.region } : {}));
  const render = options.render ?? renderInviteEmail;
  const renderAlert = options.renderOwnerAlert ?? renderOwnerAlertEmail;
  const renderWarning = options.renderOwnerInviteWarning ?? renderOwnerInviteWarningEmail;
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
    async ownerInviteUnused(warning) {
      if (!warning.to.email) throw new Error('auth-kit: the owner warning has no address to go to.');
      await send([warning.to.email], renderWarning(warning));
    },
  };
}
