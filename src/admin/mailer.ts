import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { type EmailBlock, type EmailSite, type RenderedEmail, inviteEmail, renderEmail } from '../shared/emails.js';
import { INVITE_EXPIRY_DAYS, RESOURCE_ROLE_LABEL, type ResourceRole } from '../shared/policy.js';
import { type AuthTheme, type ThemeFamily, helpAddressProblems, senderProblems } from '../themes/index.js';

export type { RenderedEmail } from '../shared/emails.js';

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
  /** The site's family or theme (the email's colors and footer identity line). Default personal. */
  theme?: AuthTheme | ThemeFamily;
  /** The help address in effect: the footer's "Help:" line. */
  helpEmail?: string;
  /** Who sent it: the email names them and replies go to them (REPORT §5.2a). */
  invitedBy?: { name?: string; email?: string };
  /** The role given, as screens label it. Default "Member". */
  roleLabel?: string;
  /** An approved access request (REPORT §5.2j): the inviter is the approver. */
  approved?: boolean;
}

/** Sends the branded invite email (Cognito's own invite is suppressed in `emailed-code` mode). */
export interface InviteMailer {
  sendInvite(input: InviteEmail): Promise<void>;
}

function longDate(date: Date): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' }).format(date);
}

/**
 * The invite email (Card Studio's `mailHTML('invite')`, REPORT §5.2a; the approved request, §5.2j):
 * who invited them and with what role, three steps to accept, and the expiry as a clock time. It
 * never contains a password or a code, so a forwarded or leaked invite gives nothing away.
 */
export function renderInviteEmail(input: InviteEmail): RenderedEmail {
  const item = input.item;
  return inviteEmail(
    { siteName: input.siteName, signInUrl: input.signInUrl, helpEmail: input.helpEmail ?? '', ...(input.theme !== undefined && { theme: input.theme }) },
    {
      email: input.email,
      ...(input.name !== undefined && { name: input.name }),
      expiresAt: input.expiresAt,
      ...(item
        ? { item: { noun: item.noun, ...(item.name !== undefined && { name: item.name }), roleLabel: RESOURCE_ROLE_LABEL[item.role] }, invitedBy: { ...(item.invitedBy !== undefined && { name: item.invitedBy }), ...input.invitedBy } }
        : input.invitedBy !== undefined && { invitedBy: input.invitedBy }),
      ...(input.roleLabel !== undefined && { roleLabel: input.roleLabel }),
      ...(input.approved === true && { approved: true }),
    },
  );
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
  /** A Super admin changed the sign-in help address (ADR 0024): tell the owner. Optional: the setting is refused without it. */
  signInHelpChanged?(alert: SignInHelpChangedAlert): Promise<void>;
}

/** The help address people are sent to changed (or went back to the site's configured one). */
export interface SignInHelpChangedAlert {
  siteName: string;
  owners: readonly { sub: string; email: string; name?: string }[];
  /** Every enabled Super admin (besides the owners), told too: a peer sees a change that isn't theirs. */
  superAdmins?: readonly { sub: string; email: string; name?: string }[];
  changedBy: { sub: string; email?: string };
  /** The address in effect before, and after. */
  from: string;
  to: string;
  /** True when the override was removed (back to the configured address). */
  reverted: boolean;
  reason: string;
  at: Date;
  context?: { ip?: string; userAgent?: string; requestId?: string };
}

/**
 * What an alert needs to look like the site's other emails (register E4a): the family's theme (the
 * footer's identity sentence) and the help address in effect (the "Help:" line).
 */
export interface AlertSite {
  theme?: AuthTheme | ThemeFamily;
  helpEmail: string;
  /** The sign-in page, when the alert links it. */
  signInUrl?: string;
}

/** The owner's alert: who changed where help requests go, from what to what, and why. */
export function renderSignInHelpChangedEmail(alert: SignInHelpChangedAlert, site?: AlertSite): RenderedEmail {
  const who = alert.changedBy.email ?? alert.changedBy.sub;
  return rendered(alert.siteName, site, `${alert.siteName}: the sign-in help address changed`, [
    alert.reverted
      ? `${who} set the sign-in help address for ${alert.siteName} back to the site's configured address, ${alert.to} (it was ${alert.from}).`
      : `${who} changed the sign-in help address for ${alert.siteName} from ${alert.from} to ${alert.to}.`,
    '',
    `When: ${when(alert.at)}`,
    `Reason given: ${alert.reason}`,
    ...contextLines(alert.context),
    '',
    'The help screens and auth emails now tell people to write to that address about their account. Someone who controls it can be asked to reset authenticators and move accounts to new addresses.',
    `If you didn't expect it, sign in and change it back under Settings, then check the Activity page.`,
    '',
    `Sent to the site's owner${(alert.superAdmins?.length ?? 0) > 0 ? ' and every Super admin' : ''}.`,
  ]);
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

/**
 * An alert in the shared layout (register E4a: no letterhead; the footer's identity sentence and the
 * help line, like every other email). Each line is a paragraph; a run of lines without a blank one
 * between them stays one paragraph per line. `link` is written out as a link wherever it appears.
 */
function rendered(siteName: string, site: AlertSite | undefined, subject: string, lines: string[], link?: string): RenderedEmail {
  const blocks: EmailBlock[] = lines
    .filter((l) => l !== '')
    .map((l) => {
      if (link === undefined || !l.includes(link)) return { kind: 'paragraph', parts: [l] };
      const at = l.indexOf(link);
      return { kind: 'paragraph', parts: [l.slice(0, at), { link }, l.slice(at + link.length)].filter((part) => part !== '') };
    });
  const emailSite: EmailSite = { siteName, signInUrl: site?.signInUrl ?? '', helpEmail: site?.helpEmail ?? '', ...(site?.theme !== undefined && { theme: site.theme }) };
  return renderEmail({ site: emailSite, subject, preheader: lines.find((l) => l !== '') ?? subject, blocks });
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
export function renderOwnerInviteWarningEmail(warning: OwnerInviteWarning, site?: AlertSite): RenderedEmail {
  const sent = longDate(warning.invitedAt);
  const expired = longDate(warning.expiredAt);
  const name = warning.siteName;
  let subject: string;
  let lines: string[];
  if (warning.to.kind === 'owner') {
    subject = `Your owner invite to ${name} hasn't been used`;
    lines = [
      warning.owner.name ? `Hi ${warning.owner.name},` : 'Hello,',
      '',
      `You were invited as an owner of ${name} on ${sent} (UTC), and the invite hasn't been used. Invites expire after 7 days (yours on ${expired}), but you're the site's only owner, so yours was left open.`,
      '',
      warning.signInUrl
        ? `Sign in at ${warning.signInUrl} with this email address to keep your owner access.`
        : `Sign in to ${name} with this email address to keep your owner access.`,
      '',
      `Until then, the invite is a live owner account for whoever can sign in with this address. If you weren't expecting it, tell whoever runs ${name}.`,
    ];
  } else {
    const whom = warning.owner.name ? `${warning.owner.name} (${warning.owner.email})` : warning.owner.email;
    subject = `${name}: the owner invite for ${warning.owner.email} hasn't been used`;
    lines = [
      `The owner invite for ${whom} on ${name}, sent ${sent} (UTC), hasn't been used. Invites expire after 7 days (this one on ${expired}), but this is the site's only owner, so the invite-expiry job left it enabled and warned them.`,
      '',
      'Until they sign in, it is a live owner account for whoever controls that inbox.',
      'If the address is wrong, give the owner role to the right person through the break-glass path (the Cognito console): the next run then disables this invite. A site has exactly one owner, and only a signed-in owner can transfer it.',
      '',
      `You get this because you're the fallback contact for ${name}'s owner warnings.`,
    ];
  }
  return rendered(warning.siteName, site, subject, lines, warning.to.kind === 'owner' ? warning.signInUrl : undefined);
}


/** The default Super admin grant alert: who, whom, when, from where, why, and what to do if it's unexpected. */
export function renderSuperadminGrantEmail(alert: SuperadminGrantAlert, site?: AlertSite): RenderedEmail {
  const who = alert.grantedBy.email ?? alert.grantedBy.sub;
  const whom = alert.grantedTo.name ? `${alert.grantedTo.name} (${alert.grantedTo.email})` : alert.grantedTo.email;
  return rendered(alert.siteName, site, `${alert.siteName}: ${alert.grantedTo.email} is now a Super admin`, [
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
export function renderOwnershipTransferEmail(alert: OwnershipTransferAlert, site?: AlertSite): RenderedEmail {
  const from = alert.previousOwner.name ? `${alert.previousOwner.name} (${alert.previousOwner.email})` : alert.previousOwner.email;
  const to = alert.newOwner.name ? `${alert.newOwner.name} (${alert.newOwner.email})` : alert.newOwner.email;
  return rendered(alert.siteName, site, `${alert.siteName}: ${alert.newOwner.email} is now the owner`, [
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
export function renderResourceInviteAlertEmail(alert: ResourceInviteAlert, site?: AlertSite): RenderedEmail {
  const who = alert.invitedBy.email ?? alert.invitedBy.sub;
  const whom = alert.invited.name ? `${alert.invited.name} (${alert.invited.email})` : alert.invited.email;
  // Named by its name, never its ID; without a name, by its noun (the Activity page shows which one).
  const what = alert.item.name ? `the ${alert.item.noun} “${alert.item.name}”` : `a ${alert.item.noun} whose name couldn’t be read`;
  return rendered(alert.siteName, site, `${alert.siteName}: ${who} invited ${alert.invited.email}`, [
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
  /**
   * The sender, on a verified SES identity: the family's display name and the site's reply-able
   * `sign-in@` mailbox, e.g. `"Example Reports (NC OSBM)" <sign-in@reports.example.org>` (`siteSender`
   * from `auth-kit/themes`). Never `noreply@` (register A10, E4a); anything else throws.
   */
  from: string;
  /**
   * The site, so every email it sends looks like the rest (register E4a): its name, family or theme
   * (the footer's identity sentence and the sender's suffix), and the help address in effect (the
   * "Help:" line): a plain address, or `createSignInHelp` from `auth-kit/accounts`.
   */
  site: { siteName: string; theme: AuthTheme | ThemeFamily; help: string | { effective(): Promise<{ address: string }> }; signInUrl?: string };
  region?: string;
  client?: SESv2Client;
  configurationSet?: string;
  replyTo?: readonly string[];
  /** Your own invite template. Default `renderInviteEmail`. */
  render?: (input: InviteEmail) => RenderedEmail;
  /** Your own Super admin grant alert. Default `renderSuperadminGrantEmail`. */
  renderSuperadminGrant?: (alert: SuperadminGrantAlert, site: AlertSite) => RenderedEmail;
  /** Your own ownership transfer alert. Default `renderOwnershipTransferEmail`. */
  renderOwnershipTransfer?: (alert: OwnershipTransferAlert, site: AlertSite) => RenderedEmail;
  /** Your own last-owner warning template. Default `renderOwnerInviteWarningEmail`. */
  renderOwnerInviteWarning?: (warning: OwnerInviteWarning, site: AlertSite) => RenderedEmail;
  /** Your own alert for a Manager's invite to one item. Default `renderResourceInviteAlertEmail`. */
  renderResourceInvite?: (alert: ResourceInviteAlert, site: AlertSite) => RenderedEmail;
  /** Your own alert for a changed sign-in help address. Default `renderSignInHelpChangedEmail`. */
  renderSignInHelpChanged?: (alert: SignInHelpChangedAlert, site: AlertSite) => RenderedEmail;
}

/** Sends an already-rendered email (the account-creation and self-service emails). Throw to report a failure. */
export interface EmailSender {
  sendEmail(message: { to: readonly string[]; email: RenderedEmail; replyTo?: readonly string[] }): Promise<void>;
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
): InviteMailer & Required<OwnerAlertNotifier> & OwnerInviteWarningNotifier & ResourceInviteNotifier & EmailSender {
  if (!options.from) throw new Error('auth-kit: createSesInviteMailer needs a from address.');
  if (!options.site?.siteName?.trim()) throw new Error('auth-kit: createSesInviteMailer needs site: { siteName, theme, help } (register E4a: every email carries the footer).');
  const fromProblems = senderProblems(options.from, { siteName: options.site.siteName, theme: options.site.theme });
  if (fromProblems.length > 0) throw new Error(`auth-kit: createSesInviteMailer from: ${fromProblems.join(' ')}`);
  if (typeof options.site.help === 'string') {
    const helpProblems = helpAddressProblems(options.site.help, { personal: true });
    if (helpProblems.length > 0) throw new Error(`auth-kit: createSesInviteMailer site.help: ${helpProblems.join(' ')}`);
  }
  const siteHelp = options.site.help;
  const alertSite = async (): Promise<AlertSite> => ({
    theme: options.site.theme,
    helpEmail: typeof siteHelp === 'string' ? siteHelp : (await siteHelp.effective().catch(() => null))?.address ?? '',
    ...(options.site.signInUrl !== undefined && { signInUrl: options.site.signInUrl }),
  });
  let client = options.client;
  const ses = (): SESv2Client => (client ??= new SESv2Client(options.region ? { region: options.region } : {}));
  const render = options.render ?? renderInviteEmail;
  const renderGrant = options.renderSuperadminGrant ?? renderSuperadminGrantEmail;
  const renderTransfer = options.renderOwnershipTransfer ?? renderOwnershipTransferEmail;
  const renderWarning = options.renderOwnerInviteWarning ?? renderOwnerInviteWarningEmail;
  const renderResourceInvite = options.renderResourceInvite ?? renderResourceInviteAlertEmail;
  const renderHelpChanged = options.renderSignInHelpChanged ?? renderSignInHelpChangedEmail;
  const send = async (to: readonly string[], email: RenderedEmail, replyTo?: readonly string[]) => {
    // An email's own Reply-To (an invite: the inviter) wins, then the caller's (the help address), then the mailer's.
    const reply = email.replyTo ?? replyTo ?? options.replyTo;
    await ses().send(
      new SendEmailCommand({
        FromEmailAddress: options.from,
        Destination: { ToAddresses: [...to] },
        ...(reply !== undefined && reply.length > 0 && { ReplyToAddresses: [...reply] }),
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
      await send(to, renderGrant(alert, await alertSite()));
    },
    async ownershipTransferred(alert) {
      const to = [...new Set([alert.previousOwner.email, alert.newOwner.email].filter(Boolean))];
      if (to.length < 2) throw new Error('auth-kit: the ownership alert needs both the previous and the new owner’s email address.');
      await send(to, renderTransfer(alert, await alertSite()));
    },
    async ownerInviteUnused(warning) {
      if (!warning.to.email) throw new Error('auth-kit: the owner warning has no address to go to.');
      await send([warning.to.email], renderWarning(warning, await alertSite()));
    },
    async signInHelpChanged(alert) {
      const owners = alert.owners.map((o) => o.email).filter(Boolean);
      if (owners.length === 0) throw new Error('auth-kit: the site has no owner with an email address to alert.');
      const to = [...new Set([...owners, ...(alert.superAdmins ?? []).map((s) => s.email).filter(Boolean)])];
      await send(to, renderHelpChanged(alert, await alertSite()));
    },
    async sendEmail(message) {
      const to = [...new Set(message.to.filter(Boolean))];
      if (to.length === 0) throw new Error('auth-kit: an email needs at least one recipient.');
      await send(to, message.email, message.replyTo);
    },
    async resourceInviteSent(alert) {
      const to = [...new Set(alert.recipients.map((r) => r.email).filter(Boolean))];
      if (to.length === 0) throw new Error('auth-kit: the site has no admin who manages people with an email address to alert.');
      await send(to, renderResourceInvite(alert, await alertSite()));
    },
  };
}
