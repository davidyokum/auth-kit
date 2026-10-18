/**
 * The auth emails' words and layout (REPORT §5, Card Studio's `mailHTML`; ADR 0024), shared by the
 * app's SES mailer (`auth-kit/admin`) and Cognito's custom message trigger
 * (`auth-kit/amplify/custom-message`). Pure: no AWS, no React.
 *
 * Every email follows the same rules (REPORT §5.1):
 * - a written preheader, so inbox previews never show a code;
 * - no code in the subject or preheader; codes first, in large monospace type, spaced with CSS so a
 *   copy gives clean digits;
 * - the same phishing-safe line; links only in invites and alerts, written out in full;
 * - multipart (HTML and the same words as text), `lang="en"`, layout tables marked presentational,
 *   a text wordmark, and colors that survive dark mode;
 * - no letterhead: the footer repeats the card's identity sentence, then the help line ("This site is
 *   managed by the NC Office of State Budget and Management. Help: {help address}."; personal sites:
 *   the help line alone). David, 2026-10-18: emails match the card (ADR 0024).
 */
import { type AuthTheme, type ThemeFamily, resolveTheme } from '../themes/index.js';

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
  /** The hidden first line inbox previews show. */
  preheader?: string;
  /** Who replies go to, when this email has its own (an invite: the inviter). */
  replyTo?: readonly string[];
}

/** What every email needs to know about the site. */
export interface EmailSite {
  siteName: string;
  /** The site's family, or its theme (with any site overrides). Default personal. */
  theme?: AuthTheme | ThemeFamily;
  /** The site's address, e.g. `https://reports.example.org/sign-in`: its host is the "only enter codes at" domain. */
  signInUrl: string;
  /** The help mailbox in effect (the theme's, a site's, or a Super admin's override): the footer's "Help:" line. */
  helpEmail: string;
  /** IANA time zone for dates and times. Default `America/New_York`. */
  timeZone?: string;
  /** How that zone is named after a time. Default `Eastern`. */
  timeZoneLabel?: string;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** The host people should type the code into: the sign-in URL's host. */
export function siteDomain(site: EmailSite): string {
  try {
    return new URL(site.signInUrl).host;
  } catch {
    return site.signInUrl;
  }
}

/** "Friday, October 23 at 5:00 PM Eastern" (REPORT §4.1: clock times, weekday and date). */
export function clockDateTime(date: Date, site: Pick<EmailSite, 'timeZone' | 'timeZoneLabel'> = {}): string {
  const timeZone = site.timeZone ?? 'America/New_York';
  const label = site.timeZoneLabel ?? (timeZone === 'America/New_York' ? 'Eastern' : timeZone);
  const day = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone }).format(date);
  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone }).format(date);
  return `${day} at ${time} ${label}`;
}

/** "Friday, October 23" (a date without the time). */
export function clockDate(date: Date, site: Pick<EmailSite, 'timeZone'> = {}): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: site.timeZone ?? 'America/New_York' }).format(date);
}

/** "n•••@example.com": enough to recognize, not enough to read. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '•••';
  return `${email[0]}•••${email.slice(at)}`;
}

// ---- Layout ---------------------------------------------------------------------------------------

/** One block of an email body. Text is plain; `strong` parts are bold in HTML and plain in text. */
export type EmailBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; parts: readonly (string | { strong: string } | { link: string })[] }
  | { kind: 'code'; code: string }
  | { kind: 'steps'; title?: string; items: readonly (readonly (string | { strong: string } | { link: string })[])[] }
  | { kind: 'list'; items: readonly string[] }
  | { kind: 'safe'; domain: string; siteName: string }
  | { kind: 'small'; text: string };

const p = (...parts: (string | { strong: string } | { link: string })[]): EmailBlock => ({ kind: 'paragraph', parts });
const strong = (text: string) => ({ strong: text });
const link = (url: string) => ({ link: url });

/** The phishing-safe line, the same in every email (Card Studio). */
export function safeLine(domain: string, siteName: string): string {
  return `Only enter codes at ${domain}. ${siteName} will never ask you for a password or code by phone, email, or text.`;
}

function partText(part: string | { strong: string } | { link: string }): string {
  return typeof part === 'string' ? part : 'strong' in part ? part.strong : part.link;
}

function partHtml(part: string | { strong: string } | { link: string }, linkColor: string): string {
  if (typeof part === 'string') return escapeHtml(part);
  if ('strong' in part) return `<strong>${escapeHtml(part.strong)}</strong>`;
  const url = escapeHtml(part.link);
  return `<a href="${url}" style="color:${linkColor};text-decoration:underline">${url}</a>`;
}

interface LayoutInput {
  site: EmailSite;
  subject: string;
  preheader: string;
  blocks: readonly EmailBlock[];
  /** A code email (the code comes first). */
  code?: boolean;
  replyTo?: readonly string[];
}

/**
 * The footer (Card Studio v4): the card's identity sentence, then "Help: {help address}." Personal
 * sites have no identity sentence, so their footer is the help line alone.
 */
export function footerLine(site: EmailSite): string {
  const theme = resolveTheme(site.theme);
  return [...(theme.footer ? [`${theme.footer}.`] : []), ...(site.helpEmail ? [`Help: ${site.helpEmail}.`] : [])].join(' ');
}

/** Renders the blocks into the shared layout: HTML (presentational tables, a text wordmark) and text. */
export function renderEmail(input: LayoutInput): RenderedEmail {
  const theme = resolveTheme(input.site.theme);
  const { ink, text: body, muted, link: linkColor } = theme.colors;
  const footer = footerLine(input.site);

  const textLines: string[] = [];
  for (const block of input.blocks) {
    switch (block.kind) {
      case 'heading':
        textLines.push(block.text, '');
        break;
      case 'paragraph':
        textLines.push(block.parts.map(partText).join(''), '');
        break;
      case 'code':
        textLines.push(block.code, '');
        break;
      case 'steps':
        if (block.title) textLines.push(block.title);
        block.items.forEach((item, i) => textLines.push(`${i + 1}. ${item.map(partText).join('')}`));
        textLines.push('');
        break;
      case 'list':
        for (const item of block.items) textLines.push(`- ${item}`);
        textLines.push('');
        break;
      case 'safe':
        textLines.push(safeLine(block.domain, block.siteName), '');
        break;
      case 'small':
        textLines.push(block.text, '');
        break;
    }
  }
  if (footer) textLines.push(footer);

  const html: string[] = [];
  for (const block of input.blocks) {
    switch (block.kind) {
      case 'heading':
        html.push(`<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:${ink}">${escapeHtml(block.text)}</h1>`);
        break;
      case 'paragraph':
        html.push(`<p style="margin:0 0 16px">${block.parts.map((part) => partHtml(part, linkColor)).join('')}</p>`);
        break;
      case 'code': {
        const spoken = block.code.split('').join(' ');
        html.push(
          `<p aria-label="Code ${escapeHtml(spoken)}" style="margin:0 0 16px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:32px;font-weight:700;letter-spacing:0.18em;color:${ink}">${escapeHtml(block.code)}</p>`,
        );
        break;
      }
      case 'steps':
        if (block.title) html.push(`<p style="margin:0 0 8px"><strong>${escapeHtml(block.title)}</strong></p>`);
        html.push(`<ol style="margin:0 0 16px;padding-left:22px">${block.items.map((item) => `<li style="margin:0 0 6px">${item.map((part) => partHtml(part, linkColor)).join('')}</li>`).join('')}</ol>`);
        break;
      case 'list':
        html.push(`<ul style="margin:0 0 16px;padding-left:22px">${block.items.map((item) => `<li style="margin:0 0 6px">${escapeHtml(item)}</li>`).join('')}</ul>`);
        break;
      case 'safe':
        html.push(
          `<p style="margin:0 0 16px">Only enter codes at <strong>${escapeHtml(block.domain)}</strong>. ${escapeHtml(block.siteName)} will never ask you for a password or code by phone, email, or text.</p>`,
        );
        break;
      case 'small':
        html.push(`<p style="margin:0 0 16px;font-size:14px;color:${muted}">${escapeHtml(block.text)}</p>`);
        break;
    }
  }
  const page = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    '<meta name="supported-color-schemes" content="light dark">',
    `<title>${escapeHtml(input.subject)}</title>`,
    '</head>',
    `<body style="margin:0;padding:0;background:#f5f6f8;color:${body};font-family:-apple-system,'Segoe UI','Source Sans 3',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5">`,
    // The preheader: what inbox previews show, written on purpose so a code never appears there.
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(input.preheader)}</div>`,
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f6f8">',
    '<tr><td align="center" style="padding:24px 12px">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border:1px solid #d9dde3;border-radius:8px">',
    '<tr><td style="padding:28px 28px 8px">',
    `<p style="margin:0 0 20px;font-size:15px;font-weight:700;color:${ink}">${escapeHtml(input.site.siteName)}</p>`,
    ...html,
    '</td></tr>',
    ...(footer
      ? [`<tr><td style="padding:0 28px 24px"><p style="margin:16px 0 0;padding-top:16px;border-top:1px solid #e3e6ea;font-size:13px;color:${muted}">${escapeHtml(footer)}</p></td></tr>`]
      : []),
    '</table>',
    '</td></tr>',
    '</table>',
    '</body>',
    '</html>',
  ].join('\n');
  return {
    subject: input.subject,
    preheader: input.preheader,
    text: textLines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    html: page,
    ...(input.replyTo !== undefined && input.replyTo.length > 0 && { replyTo: input.replyTo }),
  };
}

// ---- Code emails (Cognito sends these, through the custom message trigger) ----------------------

/** Cognito's code placeholder, which a custom message must contain. */
export const COGNITO_CODE_PLACEHOLDER = '{####}';

/** "Your {Site} sign-in code" (REPORT §5.2b). */
export function signInCodeEmail(site: EmailSite, input: { code: string; codeLifetimeMinutes: number }): RenderedEmail {
  const domain = siteDomain(site);
  const life = `${input.codeLifetimeMinutes} minutes`;
  return renderEmail({
    site,
    code: true,
    subject: `Your ${site.siteName} sign-in code`,
    preheader: `It works for ${life}. Only enter it at ${domain}.`,
    blocks: [
      { kind: 'heading', text: 'Your sign-in code' },
      { kind: 'code', code: input.code },
      p(`It works for ${life}. Enter it on the ${site.siteName} page where you asked for it.`),
      { kind: 'safe', domain, siteName: site.siteName },
      p('Didn’t ask for a code? You can ignore this email. Someone may have typed your address by mistake. If it keeps happening, reply and tell us.'),
    ],
  });
}

/** "Your {Site} code": the first code for an account the sign-up route made (Card Studio, REPORT §5.2h). */
export function signUpCodeEmail(site: EmailSite, input: { code: string; codeLifetimeMinutes: number }): RenderedEmail {
  const domain = siteDomain(site);
  const life = `${input.codeLifetimeMinutes} minutes`;
  return renderEmail({
    site,
    code: true,
    subject: `Your ${site.siteName} code`,
    preheader: `It works for ${life}. Only enter it at ${domain}.`,
    blocks: [
      { kind: 'heading', text: 'Your code to create an account' },
      { kind: 'code', code: input.code },
      p(`It works for ${life}. Enter it on the ${site.siteName} page where you asked for it. No account is created until you use this code.`),
      { kind: 'safe', domain, siteName: site.siteName },
      p('Didn’t ask for a code? You can ignore this email. Someone may have typed your address by mistake.'),
    ],
  });
}

/** "Reset your {Site} password" (REPORT §5.2c). Cognito's reset code lasts an hour. */
export function passwordResetEmail(site: EmailSite, input: { code: string }): RenderedEmail {
  const domain = siteDomain(site);
  return renderEmail({
    site,
    code: true,
    subject: `Reset your ${site.siteName} password`,
    preheader: 'Use the code inside within 1 hour. Didn’t ask? Ignore this.',
    blocks: [
      { kind: 'heading', text: 'Reset your password' },
      p(`Use this code to choose a new password for ${site.siteName}:`),
      { kind: 'code', code: input.code },
      p('After you choose a new password, you’ll still enter your authenticator code to sign in.'),
      { kind: 'safe', domain, siteName: site.siteName },
      p('Didn’t ask to reset your password? Ignore this email. Your password won’t change. If you get several of these, reply and tell us.'),
    ],
  });
}

/** "Confirm your new {Site} email address": the code to the new address before a change (REPORT §5.2l). */
export function confirmNewEmailEmail(site: EmailSite, input: { code: string }): RenderedEmail {
  const domain = siteDomain(site);
  return renderEmail({
    site,
    code: true,
    subject: `Confirm your new ${site.siteName} email address`,
    preheader: `Your email address changes only after you enter it. Only enter it at ${domain}.`,
    blocks: [
      { kind: 'heading', text: 'Confirm your new email address' },
      { kind: 'code', code: input.code },
      p(`Enter it on the ${site.siteName} page where you asked to change your email address. Your email address changes only after you enter this code.`),
      { kind: 'safe', domain, siteName: site.siteName },
      p('Didn’t ask to change your email address? You can ignore this email. Nothing changes without the code.'),
    ],
  });
}

// ---- App-sent emails (SES) ------------------------------------------------------------------------

export interface InviteEmailContent {
  email: string;
  name?: string;
  expiresAt: Date;
  /** Who sent it, as the email names them (their name, else their address). */
  invitedBy?: { name?: string; email?: string };
  /** The role given, as screens label it ("Member", "Admin – view only", …). */
  roleLabel?: string;
  /** A Manager's invite to one item: what, in the app's words, and with which role label. */
  item?: { noun: string; name?: string; roleLabel: string };
  /** A request that was approved (REPORT §5.2j): the approver replaces the inviter. */
  approved?: boolean;
}

function inviterName(by: InviteEmailContent['invitedBy']): string | undefined {
  return by?.name?.trim() || by?.email?.trim() || undefined;
}

/** The invite (Card Studio's `mailHTML('invite')`, REPORT §5.2a), and the approved request (§5.2j). */
export function inviteEmail(site: EmailSite, input: InviteEmailContent): RenderedEmail {
  const who = inviterName(input.invitedBy);
  const url = site.signInUrl;
  const subject = input.approved
    ? `${who ?? 'Someone'} approved your request for ${site.siteName}`
    : who
      ? `${who} invited you to ${site.siteName}`
      : `You’re invited to ${site.siteName}`;
  const role = input.roleLabel ?? 'Member';
  const first = input.approved
    ? p(`${who ?? 'Someone'} approved your request and gave you access as `, strong(role), '.')
    : input.item
      ? p(`${who ?? 'Someone'} added you to `, strong(input.item.name ? `the ${input.item.noun} “${input.item.name}”` : `a ${input.item.noun}`), ` as ${input.item.roleLabel}.`)
      : who
        ? p(`${who} gave you access to ${site.siteName}. Your role: `, strong(role), '.')
        : p(`You’ve been given access to ${site.siteName}. Your role: `, strong(role), '.');
  const replyTo = input.invitedBy?.email ? [input.invitedBy.email] : undefined;
  return renderEmail({
    site,
    subject,
    preheader: `Accept by ${clockDate(input.expiresAt, site)}. No password needed.`,
    ...(replyTo !== undefined && { replyTo }),
    blocks: [
      { kind: 'heading', text: `You’re invited to ${site.siteName}` },
      first,
      {
        kind: 'steps',
        title: 'To accept',
        items: [
          ['Go to ', link(url)],
          ['Enter this email address: ', strong(input.email)],
          ['Choose ', strong('Email me a code instead'), '. We’ll email you an 8-digit code. Enter it, then set up a passkey so signing in next time takes a second.'],
        ],
      },
      p(`This invitation expires on ${clockDateTime(input.expiresAt, site)}.`),
      p(`Weren’t expecting this? You can ignore it, or reply to let ${who ?? `the person who runs ${site.siteName}`} know. ${site.siteName} will never ask for a password or code by phone, email, or text.`),
    ],
  });
}

/**
 * "You already have a {Site} account" (Card Studio's `mailHTML('exists')`, REPORT §5.2g): sent
 * instead of a sign-up code or a request when the address already has an account. The screen the
 * person saw is the same either way.
 */
export function existingAccountEmail(site: EmailSite, input: { email: string; via: 'sign-up' | 'request' }): RenderedEmail {
  const domain = siteDomain(site);
  const signUp = input.via === 'sign-up';
  return renderEmail({
    site,
    subject: `You already have a ${site.siteName} account`,
    preheader: 'Sign in with this address instead.',
    blocks: [
      { kind: 'heading', text: 'You already have an account' },
      p(
        signUp
          ? `Someone, probably you, tried to create a ${site.siteName} account with this address. There’s already an account for it, so there’s nothing new to create.`
          : `Someone, probably you, asked for access to ${site.siteName} with this address. There’s already an account for it, so there’s nothing to ask for.`,
      ),
      p('To get in, go to ', link(site.signInUrl), ' and sign in with ', strong(input.email), '.'),
      { kind: 'safe', domain, siteName: site.siteName },
      p(signUp ? 'Didn’t try to create an account? You can ignore this email. Your account hasn’t changed.' : 'Didn’t ask for access? You can ignore this email. Your account hasn’t changed.'),
    ],
  });
}

/** "Your request for {Site}": an optional note when a request is declined (REPORT §5.2k). */
export function requestDeclinedEmail(site: EmailSite, input: { requestedAt: Date; note?: string }): RenderedEmail {
  const note = input.note?.trim();
  return renderEmail({
    site,
    subject: `Your request for ${site.siteName}`,
    preheader: 'It wasn’t approved. Reply if you have a question.',
    blocks: [
      { kind: 'heading', text: 'Your request wasn’t approved' },
      p(`You asked for access to ${site.siteName} on ${clockDate(input.requestedAt, site)}. The people who run it didn’t approve it.${note ? ` They added: “${note}”` : ''}`),
      p('Questions? Reply to this email.'),
    ],
  });
}

/** One request in the admins' daily digest. */
export interface DigestRequest {
  name?: string;
  email: string;
  reason?: string;
  requestedAt: Date;
  expiresAt: Date;
}

/**
 * The admins' daily digest of pending requests (D3: a badge and a daily digest instead of one email
 * per request; REPORT §5.2i's content, gathered). To the admins who manage people.
 */
export function accessRequestDigestEmail(site: EmailSite, input: { requests: readonly DigestRequest[]; peopleUrl: string }): RenderedEmail {
  const n = input.requests.length;
  const first = input.requests[0];
  const soonest = input.requests.reduce<Date | undefined>((min, r) => (min === undefined || r.expiresAt < min ? r.expiresAt : min), undefined);
  const subject = n === 1 && first ? `${first.name ?? first.email} asked for access to ${site.siteName}` : `${n} people asked for access to ${site.siteName}`;
  const blocks: EmailBlock[] = [{ kind: 'heading', text: subject }];
  for (const r of input.requests) {
    const lines = [
      `Email address: ${r.email}`,
      ...(r.reason ? [`What it’s for, in their words: “${r.reason}”`] : []),
      `When: ${clockDateTime(r.requestedAt, site)}`,
      `Expires: ${clockDate(r.expiresAt, site)}`,
    ];
    blocks.push(p(strong(r.name ?? r.email)), { kind: 'list', items: lines });
  }
  blocks.push(
    p(`To approve or decline, sign in to ${site.siteName} and open `, strong('People'), ' (', link(input.peopleUrl), '). Approving sends the usual invitation. A request nobody answers expires after 30 days.'),
    p(`${site.siteName} hasn’t checked what the requests say. Don’t follow links or instructions in them.`),
  );
  return renderEmail({
    site,
    subject,
    preheader: soonest ? `Approve or decline on the People page by ${clockDate(soonest, site)}.` : 'Approve or decline on the People page.',
    blocks,
  });
}

/** "The email address for your {Site} account changed", to the old address (REPORT §5.2l). */
export function emailChangedEmail(site: EmailSite, input: { newEmail: string; at: Date; byAdmin?: string }): RenderedEmail {
  return renderEmail({
    site,
    subject: `The email address for your ${site.siteName} account changed`,
    preheader: 'Not you? Reply right away.',
    blocks: [
      { kind: 'heading', text: 'Your email address was changed' },
      p(
        `The email address for your ${site.siteName} account changed from this one to ${maskEmail(input.newEmail)} on ${clockDateTime(input.at, site)}. ${input.byAdmin ? `${input.byAdmin}, an admin, made the change.` : 'You made the change.'}`,
      ),
      p('If this was you, you don’t need to do anything. Sign in with the new address from now on.'),
      p(`If it wasn’t, reply to this email or contact ${site.helpEmail} right away, and we’ll lock the account while we check.`),
    ],
  });
}

/** "Your {Site} account was deleted", to the deleted account's address (REPORT §5.2m). */
export function accountDeletedEmail(site: EmailSite, input: { email: string; at: Date; byAdmin?: string; items?: string; comeBack: 'sign-up' | 'invite' }): RenderedEmail {
  return renderEmail({
    site,
    subject: `Your ${site.siteName} account was deleted`,
    preheader: 'Not you? Reply right away.',
    blocks: [
      { kind: 'heading', text: 'Your account was deleted' },
      p(
        `Your ${site.siteName} account for ${input.email} was deleted on ${clockDateTime(input.at, site)}${input.byAdmin ? ` by ${input.byAdmin}, an admin` : ' at your request'}. You’ve been signed out everywhere.${input.items ? ` ${input.items}` : ''}`,
      ),
      p(`If this was you, you don’t need to do anything. To come back later, ${input.comeBack === 'sign-up' ? 'create a new account' : 'ask for a new invitation'}.`),
      p(`If it wasn’t, reply to this email or contact ${site.helpEmail} right away.`),
    ],
  });
}
