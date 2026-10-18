import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { INVITE_EXPIRY_DAYS, RESOURCE_ROLE_LABEL, type ResourceRole } from '../shared/policy.js';

export interface InviteEmail {
  email: string;
  name?: string;
  siteName: string;
  /** Absolute sign-in URL. */
  signInUrl: string;
  expiresAt: Date;
  /**
   * A Manager's invite to one item (`auth-kit/resources`): what they were given access to, in the
   * app's words, and who invited them. Absent for the People page's invite.
   */
  item?: { noun: string; name?: string; role: ResourceRole; invitedBy?: string };
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
  const item = input.item;
  const what = item ? `${item.name ? `the ${item.noun} “${item.name}”` : `a ${item.noun}`} as ${RESOURCE_ROLE_LABEL[item.role]}` : undefined;
  const invited = item
    ? `${item.invitedBy ?? 'Someone'} invited you to ${input.siteName}, with access to ${what}.`
    : `You've been invited to ${input.siteName}.`;
  const text = [
    hello,
    '',
    invited,
    '',
    `Sign in at ${input.signInUrl} with this email address. We'll email you a one-time code; then save a passkey so next time is one tap.`,
    '',
    `This invite expires on ${expires} (UTC). If you weren't expecting it, you can ignore this email.`,
  ].join('\n');
  const url = escapeHtml(input.signInUrl);
  const html = [
    `<p>${escapeHtml(hello)}</p>`,
    item ? `<p>${escapeHtml(invited)}</p>` : `<p>You've been invited to <strong>${escapeHtml(input.siteName)}</strong>.</p>`,
    `<p><a href="${url}">Sign in</a> with this email address. We'll email you a one-time code; then save a passkey so next time is one tap.</p>`,
    `<p>This invite expires on ${escapeHtml(expires)} (UTC). If you weren't expecting it, you can ignore this email.</p>`,
  ].join('\n');
  return { subject, text, html };
}

/** A Super admin grant (only the owner grants it): who was granted, by whom, and who's told. */
export interface SuperadminGrantAlert {
  siteName: string;
  /** Who gets the alert: the site's owner (every enabled member of the owner group, read live after the grant). */
  owners: readonly { sub: string; email: string; name?: string }[];
  grantedTo: { sub: string; email: string; name?: string };
  grantedBy: { sub: string; email?: string };
  /** How the role was granted. */
  via: 'changeRole' | 'invite';
  reason?: string;
  at: Date;
  context?: { ip?: string; userAgent?: string; requestId?: string };
}

/** An ownership transfer: the previous owner (now Super admin) and the new owner both get it. */
export interface OwnershipTransferAlert {
  siteName: string;
  /** Who started it and is now Super admin. */
  previousOwner: { sub: string; email: string; name?: string };
  newOwner: { sub: string; email: string; name?: string };
  reason: string;
  at: Date;
  context?: { ip?: string; userAgent?: string; requestId?: string };
}

/**
 * The alerts the owner gets. Granting Super admin and transferring ownership require them: if the
 * alert can't be sent, the change is undone. Throw to report a failure.
 */
export interface OwnerAlertNotifier {
  /** Someone was made Super admin: tell the owner. */
  superadminGranted(alert: SuperadminGrantAlert): Promise<void>;
  /** Ownership moved: tell the previous and the new owner. */
  ownershipTransferred(alert: OwnershipTransferAlert): Promise<void>;
}

function when(at: Date): string {
  return `${at.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

function contextLines(context: SuperadminGrantAlert['context']): string[] {
  return [
    ...(context?.ip ? [`From: ${context.ip}${context.userAgent ? ` (${context.userAgent})` : ''}`] : []),
    ...(context?.requestId ? [`Request: ${context.requestId}`] : []),
  ];
}

function rendered(subject: string, lines: string[]): RenderedEmail {
  return {
    subject,
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
      'If the address is wrong, give the owner role to the right person through the break-glass path (the Cognito console): the next run then disables this invite. A site has exactly one owner, and only a signed-in owner can transfer it.',
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

/** The default Super admin grant alert: who, whom, when, from where, why, and what to do if it's unexpected. */
export function renderSuperadminGrantEmail(alert: SuperadminGrantAlert): RenderedEmail {
  const who = alert.grantedBy.email ?? alert.grantedBy.sub;
  const whom = alert.grantedTo.name ? `${alert.grantedTo.name} (${alert.grantedTo.email})` : alert.grantedTo.email;
  return rendered(`${alert.siteName}: ${alert.grantedTo.email} is now a Super admin`, [
    `${who} made ${whom} a Super admin of ${alert.siteName}${alert.via === 'invite' ? ' by inviting them as one' : ''}.`,
    '',
    `When: ${when(alert.at)}`,
    ...(alert.reason ? [`Reason given: ${alert.reason}`] : []),
    ...contextLines(alert.context),
    '',
    'Super admins can manage people and roles below Super admin, security settings, exports, and deletion. Only the owner can grant it, and the owner gets this email.',
    `If you didn't expect it, disable the new Super admin from the People page (or the break-glass path) and check the Activity page.`,
  ]);
}

/** The default ownership transfer alert, sent to the previous and the new owner. */
export function renderOwnershipTransferEmail(alert: OwnershipTransferAlert): RenderedEmail {
  const from = alert.previousOwner.name ? `${alert.previousOwner.name} (${alert.previousOwner.email})` : alert.previousOwner.email;
  const to = alert.newOwner.name ? `${alert.newOwner.name} (${alert.newOwner.email})` : alert.newOwner.email;
  return rendered(`${alert.siteName}: ${alert.newOwner.email} is now the owner`, [
    `${from} transferred ownership of ${alert.siteName} to ${to}.`,
    '',
    `When: ${when(alert.at)}`,
    `Reason given: ${alert.reason}`,
    ...contextLines(alert.context),
    '',
    `${alert.newOwner.email} is now the site's only owner. ${alert.previousOwner.email} is now a Super admin.`,
    `If you didn't expect it, sign in and check the People and Activity pages, or use the break-glass path.`,
  ]);
}

/**
 * A Manager brought someone new into one item (ADR 0022): an account with no admin role, with access
 * to that item only. The site's admins who manage people are told every time; if this alert can't be
 * sent, the invite is undone.
 */
export interface ResourceInviteAlert {
  siteName: string;
  /** Who gets it: everyone enabled whose group grants `people.manage` (the owner included), read live. */
  recipients: readonly { sub: string; email: string; name?: string }[];
  invited: { sub: string; email: string; name?: string };
  invitedBy: { sub: string; email?: string };
  /** The item, in the app's words. `name` comes from the app's own store, never from the request. */
  item: { type: string; id: string; noun: string; name?: string };
  role: ResourceRole;
  at: Date;
  context?: { ip?: string; userAgent?: string; requestId?: string };
}

/** Sends the alert above. Throw to report a failure (the invite is then undone). */
export interface ResourceInviteNotifier {
  resourceInviteSent(alert: ResourceInviteAlert): Promise<void>;
}

/** The default alert: who invited whom, to what, with which role, and what to do if it's unexpected. */
export function renderResourceInviteAlertEmail(alert: ResourceInviteAlert): RenderedEmail {
  const who = alert.invitedBy.email ?? alert.invitedBy.sub;
  const whom = alert.invited.name ? `${alert.invited.name} (${alert.invited.email})` : alert.invited.email;
  // Named by its name, never its ID; without a name, by its noun (the Activity page shows which one).
  const what = alert.item.name ? `the ${alert.item.noun} “${alert.item.name}”` : `a ${alert.item.noun} whose name couldn’t be read`;
  return rendered(`${alert.siteName}: ${who} invited ${alert.invited.email}`, [
    `${who} invited ${whom} to ${alert.siteName}, as ${RESOURCE_ROLE_LABEL[alert.role]} of ${what}.`,
    '',
    `When: ${when(alert.at)}`,
    ...contextLines(alert.context),
    '',
    `The new account has no admin role: it has access to ${what}, and nothing else on the site. Its invite expires in ${INVITE_EXPIRY_DAYS} days if it isn't used.`,
    `If you didn't expect it, disable the account from the People page and check the Activity page.`,
  ]);
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
  /** Your own Super admin grant alert. Default `renderSuperadminGrantEmail`. */
  renderSuperadminGrant?: (alert: SuperadminGrantAlert) => RenderedEmail;
  /** Your own ownership transfer alert. Default `renderOwnershipTransferEmail`. */
  renderOwnershipTransfer?: (alert: OwnershipTransferAlert) => RenderedEmail;
  /** Your own last-owner warning template. Default `renderOwnerInviteWarningEmail`. */
  renderOwnerInviteWarning?: (warning: OwnerInviteWarning) => RenderedEmail;
  /** Your own alert for a Manager's invite to one item. Default `renderResourceInviteAlertEmail`. */
  renderResourceInvite?: (alert: ResourceInviteAlert) => RenderedEmail;
}

/**
 * The site's mailer through SES (SESv2 `SendEmail`): the invite email, the alert the owner gets when
 * someone is made Super admin, the alert the previous and new owner get when ownership moves, the
 * alert the site's admins get when a Manager invites someone new to one item (each alert is one
 * message to all its recipients, so it's sent to all or to none), and the last-owner warning the
 * invite-expiry sweep sends (one message per recipient). The role needs `ses:SendEmail` on the
 * identity.
 */
export function createSesInviteMailer(
  options: SesInviteMailerOptions,
): InviteMailer & OwnerAlertNotifier & OwnerInviteWarningNotifier & ResourceInviteNotifier {
  if (!options.from) throw new Error('auth-kit: createSesInviteMailer needs a from address.');
  let client = options.client;
  const ses = (): SESv2Client => (client ??= new SESv2Client(options.region ? { region: options.region } : {}));
  const render = options.render ?? renderInviteEmail;
  const renderGrant = options.renderSuperadminGrant ?? renderSuperadminGrantEmail;
  const renderTransfer = options.renderOwnershipTransfer ?? renderOwnershipTransferEmail;
  const renderWarning = options.renderOwnerInviteWarning ?? renderOwnerInviteWarningEmail;
  const renderResourceInvite = options.renderResourceInvite ?? renderResourceInviteAlertEmail;
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
    async superadminGranted(alert) {
      const to = [...new Set(alert.owners.map((o) => o.email).filter(Boolean))];
      if (to.length === 0) throw new Error('auth-kit: the site has no owner with an email address to alert.');
      await send(to, renderGrant(alert));
    },
    async ownershipTransferred(alert) {
      const to = [...new Set([alert.previousOwner.email, alert.newOwner.email].filter(Boolean))];
      if (to.length < 2) throw new Error('auth-kit: the ownership alert needs both the previous and the new owner’s email address.');
      await send(to, renderTransfer(alert));
    },
    async ownerInviteUnused(warning) {
      if (!warning.to.email) throw new Error('auth-kit: the owner warning has no address to go to.');
      await send([warning.to.email], renderWarning(warning));
    },
    async resourceInviteSent(alert) {
      const to = [...new Set(alert.recipients.map((r) => r.email).filter(Boolean))];
      if (to.length === 0) throw new Error('auth-kit: the site has no admin who manages people with an email address to alert.');
      await send(to, renderResourceInvite(alert));
    },
  };
}
