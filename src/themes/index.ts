/**
 * `auth-kit/themes`: the three families (OSBM, UNC, personal) as themes (register E1, E2, E4, A9;
 * ADR 0024). One core, so colleagues never relearn it; a family changes only a few things, and each
 * lives here once for the sign-in card, the emails, and the help screens:
 *
 * - accent colors (the primary button, links, and the card's edge, computed to reach 3:1);
 * - the sender's display name ("{Site} (NC OSBM)");
 * - the footer identity line ("This site is managed by the NC Office of State Budget and
 *   Management"; personal sites name nobody), on the card and at the foot of every email;
 * - the email field's example address (a site may set its own, A9);
 * - the sender's address: always a reply-able `sign-in@` mailbox, never `noreply@` (register A10); the
 *   personal family's is `sign-in@yokum.app` (register F11);
 * - the help route: the role-based help mailbox (required; a person's own address only when a site
 *   acknowledges it, register E4c; the personal family's default is `help@yokum.app`, F11; OSBM and UNC
 *   ship none until their role mailboxes exist), whether screens name the site's owner or say "the
 *   {Site} team", how the team confirms it's you, where to go for the email account, device, or app
 *   itself (the IT desk), and the OSBM Teams check;
 * - the card's style (register E5: Quiet by default; Monogram, Frosted, Plain, and Porcelain per site)
 *   and its edge.
 *
 * Register A10 dropped the OSBM "authorized use" line and MyNCID-like colours; a reserved "Sign in
 * with NCID" slot is in the backlog (only if state single sign-on happens), so nothing here hooks it.
 *
 * Pure: no React, no AWS. The client, the server's mailer, and the custom message trigger all read it.
 */
import { BACKDROP_FAMILIES } from '../backdrops/families.js';
import { contrastRatio, over, parseHex, toHex } from '../backdrops/kernel/v1/color.js';
import type { BackdropFamily, BackdropPalette } from '../backdrops/types.js';

export type ThemeFamily = BackdropFamily;

/** The card's edge (register E5: `defined`, a line that reaches 3:1, by default; ADR 0021's edge rule). */
export type CardEdge = 'defined' | 'soft';

/**
 * The card's style (register E5, decided 2026-10-19; Card Studio's directions, `design/shared/sign-in-card.js`):
 * - `quiet` (default): a white card, the defined edge, a soft shadow, generous spacing, no accent line;
 * - `monogram`: Quiet plus the site's initials as a small badge above the heading, warmer neutrals, rounder corners;
 * - `frosted`: a translucent, blurred panel (solid where the browser can't blur);
 * - `plain`: no card: the form sits in a soft, readable column the backdrop fades into (the one
 *   exception to E4's no-fade rule, kept for some sites; it has no edge);
 * - `porcelain`: a luminous sheet: the edge, layered soft shadows with a faint glow in the family
 *   colour, 20px corners, rounder controls, and the other ways in on a tinted well.
 */
export type CardStyle = 'quiet' | 'monogram' | 'frosted' | 'plain' | 'porcelain';

export const CARD_STYLES: readonly CardStyle[] = Object.freeze(['quiet', 'monogram', 'frosted', 'plain', 'porcelain']);

/** The colors the card, its controls, and the emails use. Every value is `#rrggbb`. */
export interface ThemeColors {
  /** The card's solid surface. */
  surface: string;
  /** Headings and field text. */
  ink: string;
  /** Body text. */
  text: string;
  /** Hints, the footer, small print. */
  muted: string;
  /** Links and link-style buttons. */
  link: string;
  /** The primary button's fill, and its text. */
  button: string;
  buttonText: string;
  /** The keyboard focus ring (3:1 on the card). */
  focus: string;
  /** Field errors and the error summary. */
  error: string;
  /** Field borders and outline buttons (3:1 on the card). */
  fieldBorder: string;
  /**
   * The family accent for icons: the passkey fingerprint (register E4d) and the password-field glyph.
   * The primary button's color, which reaches 3:1 on the card (WCAG 1.4.11).
   */
  accent: string;
}

/**
 * Who helps, and with what (David, 2026-10-18). The site helps only with the person's account on
 * this site (a password reset, resetting the authenticator on their account, moving the account to a
 * new address after confirming it's them); for their email account, device, or authenticator app
 * itself, the screens point to `itDesk`.
 */
export interface ThemeHelp {
  /**
   * The help mailbox: role-based by default (the family's, or the site's own, e.g. Project Portal →
   * `portal@osbm.nc.gov`), and a person's own address only when the site acknowledges it
   * (`authTheme(family, { helpAddress: { address, personal: true } })`, register E4c). It's also the
   * Reply-To on auth emails and the "Help:" line in their footer. The personal family's default is
   * `help@yokum.app` (register F11); OSBM and UNC ship none, so a site sets its own (a Super admin may
   * override it without a deploy; `auth-kit/accounts`' sign-in help setting).
   */
  address: string | null;
  /** The address is a person's own, acknowledged by the site (register E4c). */
  personal: boolean;
  /** Name the site's owner ("Jordan Lee looks after Example Reports"), or say "the {Site} team". */
  named: boolean;
  /** How the team confirms it's you before resetting anything: "on Teams or by phone". */
  verify: string;
  /** Who helps with the email account or the authenticator app itself: "your agency’s IT help desk". */
  itDesk: string;
  /** Who helps when the device or browser itself isn't working (the passkey help): "the device maker’s support" on personal sites. */
  devDesk: string;
  /** Offer "Not sure an email is really from us? Ask {owner} on Teams." (OSBM). */
  teamsCheck: boolean;
  /**
   * The family's own email domains (subdomains included): where a Super admin may point the help
   * address without a deploy, besides the configured address's domain (`createSignInHelp`). Empty on
   * personal sites, whose override stays on the configured address's domain.
   */
  domains: readonly string[];
}

export interface AuthTheme {
  family: ThemeFamily;
  /** The family's short name, e.g. `NC OSBM`. */
  label: string;
  /** Who runs the family's sites; null for personal sites. */
  organization: string | null;
  colors: Readonly<ThemeColors>;
  /** The backdrop palette the card's edge is measured against (`auth-kit/backdrops`). */
  palette: Readonly<BackdropPalette>;
  /** In the sender's display name: "{Site} (NC OSBM)". Null: just "{Site}". */
  senderSuffix: string | null;
  /**
   * The family's sender address, when it has a shared one: `sign-in@yokum.app` for personal sites
   * (register F11). Null: each site sends from its own `sign-in@` mailbox (register A10).
   */
  senderAddress: string | null;
  /**
   * The footer identity line (E4), the same words on the card and at the foot of every email (David,
   * 2026-10-18: emails match the card, with no letterhead). Null on personal sites, which never name a person.
   */
  footer: string | null;
  /** The email field's example address (E2). A site may set its own (A9). */
  emailHint: string;
  /** The help route (REPORT §7.2, Card Studio v4; ADR 0024). */
  help: Readonly<ThemeHelp>;
  /** `defined` (default): a line in the family ink that reaches 3:1 on every backdrop color. `soft`: a hairline. */
  cardEdge: CardEdge;
  /** The card's style (register E5). Default `quiet`. */
  cardStyle: CardStyle;
}

/** What a site may change about its family's theme. */
export interface AuthThemeOverrides extends Partial<Pick<AuthTheme, 'emailHint' | 'cardEdge' | 'cardStyle'>> {
  /**
   * The help mailbox (required before a deploy; `helpSettingProblems` says why one can't be used): a
   * role-based address, or `{ address, personal: true }` for a site that deliberately names one person.
   */
  helpAddress?: HelpAddressSetting;
  /** Override whether screens name the owner: a public site in a named family says "the {Site} team". */
  helpNamed?: boolean;
}

const CORE = { surface: '#ffffff', text: '#3c434b', muted: '#56606b', error: '#b42318', fieldBorder: '#6b7480' } as const;

function colorsOf(family: ThemeFamily): ThemeColors {
  const card = BACKDROP_FAMILIES[family].card;
  return {
    surface: CORE.surface,
    ink: card.heading,
    text: card.body,
    muted: family === 'personal' ? '#5e5852' : CORE.muted,
    link: card.link,
    button: card.button,
    buttonText: card.buttonText,
    focus: card.focus,
    error: CORE.error,
    fieldBorder: family === 'personal' ? '#78716c' : CORE.fieldBorder,
    accent: card.button,
  };
}

const base = (family: ThemeFamily) => ({
  family,
  colors: Object.freeze(colorsOf(family)),
  palette: BACKDROP_FAMILIES[family].palette,
  cardEdge: 'defined' as const,
  cardStyle: 'quiet' as const,
});

/** The three families, exactly as REPORT §7.2 and the register (E1, E2, E4) set them. Brand constants. */
export const FAMILY_THEMES: Readonly<Record<ThemeFamily, Readonly<AuthTheme>>> = Object.freeze({
  osbm: Object.freeze({
    ...base('osbm'),
    label: 'NC OSBM',
    organization: 'NC Office of State Budget and Management',
    senderSuffix: 'NC OSBM',
    senderAddress: null,
    footer: 'This site is managed by the NC Office of State Budget and Management',
    emailHint: 'name@osbm.nc.gov',
    help: Object.freeze({ address: null, personal: false, named: true, verify: 'on Teams or by phone', itDesk: 'your agency’s IT help desk', devDesk: 'your agency’s IT help desk', teamsCheck: true, domains: Object.freeze(['nc.gov']) }),
  }),
  unc: Object.freeze({
    ...base('unc'),
    label: 'UNC',
    organization: 'UNC-Chapel Hill',
    senderSuffix: 'UNC',
    senderAddress: null,
    footer: 'This site is managed by UNC-Chapel Hill',
    emailHint: 'name@unc.edu',
    help: Object.freeze({ address: null, personal: false, named: true, verify: 'by phone or in person', itDesk: 'the UNC IT help desk', devDesk: 'the UNC IT help desk', teamsCheck: false, domains: Object.freeze(['unc.edu']) }),
  }),
  personal: Object.freeze({
    ...base('personal'),
    label: 'Personal',
    organization: null,
    senderSuffix: null,
    // Register F11 (2026-10-19): the personal family lives on yokum.app.
    senderAddress: 'sign-in@yokum.app',
    footer: null,
    emailHint: 'name@example.com',
    help: Object.freeze({
      address: 'help@yokum.app',
      personal: false,
      named: false,
      verify: 'by email',
      itDesk: 'your email provider, or your IT help desk if your organization runs your email',
      devDesk: 'the device maker’s support',
      teamsCheck: false,
      domains: Object.freeze(['yokum.app']),
    }),
  }),
});

export const THEME_FAMILIES = Object.freeze(Object.keys(FAMILY_THEMES) as ThemeFamily[]);

export function isThemeFamily(value: unknown): value is ThemeFamily {
  return typeof value === 'string' && Object.hasOwn(FAMILY_THEMES, value);
}

/**
 * A family's theme with a site's overrides (each checked). Throws on an unknown family or override.
 *
 * ```ts
 * const theme = authTheme('osbm', { emailHint: 'name@nc.gov' }); // a site used across agencies (A9)
 * ```
 */
export function authTheme(family: ThemeFamily, overrides: AuthThemeOverrides = {}): AuthTheme {
  if (!isThemeFamily(family)) throw new Error(`auth-kit/themes: family "${String(family)}" isn't one of ${THEME_FAMILIES.join(', ')}.`);
  for (const key of Object.keys(overrides)) {
    if (key === 'showAuthorizedUse') throw new Error('auth-kit/themes: the authorized-use line was dropped (register A10, 2026-10-19); remove showAuthorizedUse.');
    if (!['emailHint', 'cardEdge', 'cardStyle', 'helpAddress', 'helpNamed'].includes(key)) throw new Error(`auth-kit/themes: "${key}" can't be overridden per site.`);
  }
  if (overrides.cardEdge !== undefined && overrides.cardEdge !== 'defined' && overrides.cardEdge !== 'soft') {
    throw new Error(`auth-kit/themes: cardEdge must be 'defined' or 'soft'.`);
  }
  if (overrides.cardStyle !== undefined && !CARD_STYLES.includes(overrides.cardStyle)) {
    throw new Error(`auth-kit/themes: cardStyle must be one of ${CARD_STYLES.join(', ')}.`);
  }
  if (overrides.helpNamed !== undefined && typeof overrides.helpNamed !== 'boolean') throw new Error('auth-kit/themes: helpNamed must be true or false.');
  let siteHelp: { address: string; personal: boolean } | undefined;
  if (overrides.helpAddress !== undefined) {
    const problems = helpSettingProblems(overrides.helpAddress);
    if (problems.length > 0) throw new Error(`auth-kit/themes: helpAddress: ${problems.join(' ')}`);
    siteHelp = readHelpSetting(overrides.helpAddress);
  }
  const hint = overrides.emailHint?.trim();
  if (overrides.emailHint !== undefined && (!hint || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(hint))) {
    throw new Error(`auth-kit/themes: emailHint must be an example address like name@example.org.`);
  }
  const familyTheme = FAMILY_THEMES[family];
  const help = Object.freeze({
    ...familyTheme.help,
    ...(siteHelp !== undefined && { address: siteHelp.address, personal: siteHelp.personal }),
    ...(overrides.helpNamed !== undefined && { named: overrides.helpNamed }),
  });
  return Object.freeze({
    ...familyTheme,
    help,
    ...(hint !== undefined && { emailHint: hint }),
    ...(overrides.cardEdge !== undefined && { cardEdge: overrides.cardEdge }),
    ...(overrides.cardStyle !== undefined && { cardStyle: overrides.cardStyle }),
  });
}

// ---- The help address ---------------------------------------------------------------------------

/** What a site writes until it has a real help mailbox. `helpAddressProblems` refuses it. */
export const HELP_ADDRESS_PLACEHOLDER = 'apps-help@replace-me.invalid';

const PLACEHOLDER_MARKERS = /replace[-_]?me|placeholder|change[-_]?me|\btodo\b|your[-_.]?(help|domain|address|email)|xxx/i;
const RESERVED_TLDS = ['invalid', 'test', 'localhost', 'example'];
const PERSONAL_LOCAL_PART = /^([a-z]+)\.([a-z]+)$/;
const ROLE_WORDS = new Set(['help', 'helpdesk', 'support', 'apps', 'app', 'admin', 'admins', 'info', 'team', 'desk', 'service', 'services', 'it', 'sign', 'signin', 'access', 'accounts', 'web', 'office', 'contact']);

/**
 * A site's help address (register E4c): a role-based mailbox by default (`'portal@osbm.nc.gov'`), or a
 * person's own address that the site acknowledges on purpose, never by default:
 * `{ address: 'jordan.lee@example.org', personal: true }` (a site that deliberately signals it's one
 * person).
 */
export type HelpAddressSetting = string | { readonly address: string; readonly personal: true };

/** A help address setting, split into the address and whether a person's own address was acknowledged. */
export function readHelpSetting(setting: HelpAddressSetting | null | undefined): { address: string; personal: boolean } {
  if (setting !== null && typeof setting === 'object') {
    if (setting.personal !== true) throw new Error('auth-kit: a help address object acknowledges a person’s own address: { address, personal: true }.');
    return { address: typeof setting.address === 'string' ? setting.address.trim().toLowerCase() : '', personal: true };
  }
  return { address: typeof setting === 'string' ? setting.trim().toLowerCase() : '', personal: false };
}

/**
 * Why an address can't be the site's help mailbox, or `[]` when it can. Refused: nothing at all, a
 * malformed address, a placeholder (`replace-me`, `placeholder`, `changeme`, `todo`, or a reserved
 * test domain such as `.invalid` or `.test`), and an address with an obvious person's name
 * (`first.last@…`, unless either part is a role word like `help`): the help mailbox is role-based, so
 * it outlives whoever answers it. A person's own address passes only when the site acknowledges it
 * (`{ personal: true }`, register E4c).
 */
export function helpAddressProblems(address: string | null | undefined, options: { personal?: boolean } = {}): string[] {
  const value = (address ?? '').trim().toLowerCase();
  if (value === '') return ['The site needs a help address: a role-based mailbox, like apps-help@your-agency.gov, on the help screens and as the Reply-To on auth emails.'];
  if (!/^[^\s@<>"(),;:]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(value)) return [`"${address}" isn't an email address.`];
  // A plain mailbox name: letters, digits, dots, plus, hyphen, underscore. Nothing that changes what a
  // mailto: link does (`?subject=…`, `#`, `%`-escapes, `/`), and no empty parts between dots.
  if (!/^[a-z0-9_+-]+(?:\.[a-z0-9_+-]+)*@/.test(value)) return [`"${address}" isn't a plain mailbox: use letters, digits, dots, hyphens, underscores, or plus signs before the @.`];
  const [local = '', domain = ''] = value.split('@');
  const tld = domain.slice(domain.lastIndexOf('.') + 1);
  if (PLACEHOLDER_MARKERS.test(value) || RESERVED_TLDS.includes(tld)) return [`"${address}" is a placeholder: set the site's real help mailbox.`];
  const personal = PERSONAL_LOCAL_PART.exec(local);
  if (personal && options.personal !== true && !ROLE_WORDS.has(personal[1]!) && !ROLE_WORDS.has(personal[2]!)) {
    return [
      `"${address}" looks like a person's own address. Use a role-based mailbox (apps-help@…, help@…) that outlives whoever answers it, or, if the site deliberately names one person, acknowledge it: { address: '${value}', personal: true }.`,
    ];
  }
  return [];
}

/** `helpAddressProblems` for a setting (a role-based address, or an acknowledged person's own). */
export function helpSettingProblems(setting: HelpAddressSetting | null | undefined): string[] {
  let read: { address: string; personal: boolean };
  try {
    read = readHelpSetting(setting);
  } catch (error) {
    return [(error as Error).message.replace(/^auth-kit: /, '')];
  }
  return helpAddressProblems(read.address, { personal: read.personal });
}

// ---- The sender (register A10, E4a) -------------------------------------------------------------

/** Every auth-kit sender is a reply-able `sign-in@` mailbox (register A10), never `noreply@`. */
export const SENDER_LOCAL_PART = 'sign-in';

const NO_REPLY = /^(no-?reply|do-?not-?reply|donotreply|no_reply|bounce|mailer-daemon)$/i;

/**
 * Why an address can't send auth-kit's email, or `[]`: it must be `sign-in@{the site's domain}`, and,
 * given the site's family, the family's own sender where it has one (`theme.senderAddress`: the personal
 * family sends from `sign-in@yokum.app`, register F11).
 */
export function senderAddressProblems(address: string | null | undefined, theme?: AuthTheme | ThemeFamily): string[] {
  const value = (address ?? '').trim();
  if (!/^[^\s@<>"]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(value)) return [`"${address ?? ''}" isn't a sender address like sign-in@example.org.`];
  const local = value.slice(0, value.lastIndexOf('@'));
  if (NO_REPLY.test(local)) return [`"${value}" can't be replied to. Send from a reply-able ${SENDER_LOCAL_PART}@ mailbox (register A10), never noreply@.`];
  if (local.toLowerCase() !== SENDER_LOCAL_PART) return [`"${value}" isn't the site's ${SENDER_LOCAL_PART}@ mailbox. Auth email comes from ${SENDER_LOCAL_PART}@${value.slice(value.lastIndexOf('@') + 1)} (register A10).`];
  if (theme !== undefined) {
    const t = resolveTheme(theme);
    if (t.senderAddress !== null && value.toLowerCase() !== t.senderAddress.toLowerCase()) {
      return [`"${value}" isn't the ${t.label} family's sender. ${t.label} sites send from ${t.senderAddress} (register F11).`];
    }
  }
  return [];
}

// ---- Non-ASCII display names (RFC 2047) ------------------------------------------------------------
// SES (and Cognito, which sends through it) takes a display name with characters outside ASCII only as
// MIME encoded-words, `=?UTF-8?B?…?=` (RFC 2047). So the kit writes such a name encoded wherever a sender
// goes to SES, and compares names decoded and NFC-normalized, whichever form a site wrote.

const NON_ASCII = /[^\x20-\x7e]/;
/** An encoded-word is at most 75 characters: `=?UTF-8?B?` + base64 + `?=` leaves 63, so 45 bytes. */
const ENCODED_WORD_BYTES = 45;

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * A display name as SES needs it: unchanged when it's printable ASCII, otherwise RFC 2047 encoded-words
 * (`=?UTF-8?B?…?=`, each at most 75 characters, never splitting a character). Never quote the result.
 */
export function encodeSenderName(name: string): string {
  if (!NON_ASCII.test(name)) return name;
  const encoder = new TextEncoder();
  const words: string[] = [];
  let chunk: number[] = [];
  for (const char of name.normalize('NFC')) {
    const bytes = encoder.encode(char);
    if (chunk.length + bytes.length > ENCODED_WORD_BYTES) {
      words.push(`=?UTF-8?B?${base64(Uint8Array.from(chunk))}?=`);
      chunk = [];
    }
    chunk.push(...bytes);
  }
  if (chunk.length > 0) words.push(`=?UTF-8?B?${base64(Uint8Array.from(chunk))}?=`);
  return words.join(' ');
}

const ENCODED_WORD = /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g;

function decodeWord(charset: string, encoding: string, text: string): string | null {
  try {
    let bytes: Uint8Array;
    if (encoding.toUpperCase() === 'B') {
      const binary = atob(text);
      bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    } else {
      const out: number[] = [];
      for (let i = 0; i < text.length; i++) {
        const c = text[i]!;
        if (c === '_') out.push(0x20);
        else if (c === '=' && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) {
          out.push(parseInt(text.slice(i + 1, i + 3), 16));
          i += 2;
        } else out.push(c.charCodeAt(0));
      }
      bytes = Uint8Array.from(out);
    }
    return new TextDecoder(charset.split('*')[0]!.toLowerCase(), { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * A display name with its RFC 2047 encoded-words decoded (B or Q, any charset the platform knows;
 * whitespace between two encoded-words dropped, RFC 2047 §6.2), NFC-normalized. A word that can't be
 * decoded stays as written.
 */
export function decodeSenderName(name: string): string {
  if (!name.includes('=?')) return name.normalize('NFC');
  let out = '';
  let last = 0;
  let previousWasWord = false;
  for (const m of name.matchAll(ENCODED_WORD)) {
    const between = name.slice(last, m.index);
    const decoded = decodeWord(m[1]!, m[2]!, m[3]!);
    out += previousWasWord && decoded !== null && /^\s*$/.test(between) ? '' : between;
    out += decoded ?? m[0];
    previousWasWord = decoded !== null;
    last = m.index + m[0].length;
  }
  return (out + name.slice(last)).normalize('NFC');
}

/**
 * Why a display name isn't the family's sender name ("{Site} (NC OSBM)", "{Site} (UNC)", "{Site}"), or
 * `[]`. The name may be written plainly or as RFC 2047 encoded-words; both sides are compared decoded
 * and NFC-normalized, so "Café Reports" matches however it's spelled.
 */
export function senderNameProblems(name: string, theme: AuthTheme | ThemeFamily, siteName?: string): string[] {
  const t = resolveTheme(theme);
  const value = decodeSenderName(name.trim()).trim();
  if (siteName !== undefined) {
    const expected = senderDisplayName(siteName.trim(), t).normalize('NFC');
    return value === expected ? [] : [`The sender's name is "${expected}" (register E4a), not "${value}".`];
  }
  const suffixes = Object.values(FAMILY_THEMES).map((f) => f.senderSuffix).filter((s): s is string => s !== null);
  if (t.senderSuffix) {
    return value.endsWith(` (${t.senderSuffix})`) && value.length > t.senderSuffix.length + 3 ? [] : [`The sender's name ends "(${t.senderSuffix})" on ${t.label} sites: "{Site} (${t.senderSuffix})" (register E4a), not "${value}".`];
  }
  return suffixes.some((s) => value.endsWith(`(${s})`)) || value === '' ? [`A personal site's sender name is just the site's name (register E4a), not "${value}".`] : [];
}

/**
 * `Name <address>` as SES takes it: a name with characters outside ASCII as RFC 2047 encoded-words
 * (`encodeSenderName`; SES refuses it otherwise), and an ASCII name quoted when it has a character that
 * needs it (`(`, `,`, `.`...). An already-encoded name is decoded first, so it's never encoded twice.
 */
export function formatSenderAddress(name: string, address: string): string {
  const plain = decodeSenderName(name);
  if (NON_ASCII.test(plain)) return `${encodeSenderName(plain.replace(/[\r\n]/g, ''))} <${address}>`;
  return /[()<>[\]:;@\\,."]/.test(plain) ? `"${plain.replace(/["\\]/g, '')}" <${address}>` : `${plain} <${address}>`;
}

/** A sender as SES's `FromEmailAddress` takes it (`formatSenderAddress` of its name and address), or the bare address. */
export function sesSender(from: string): string {
  const { name, address } = parseSender(from);
  return name === '' ? address : formatSenderAddress(name, address);
}

/** The name and address in a sender (`"Name" <a@b>`, `Name <a@b>`, or `a@b`). */
export function parseSender(from: string): { name: string; address: string } {
  const m = /^\s*(?:"([^"]*)"|([^<]*?))\s*<([^<>\s]+)>\s*$/.exec(from);
  if (m) return { name: (m[1] ?? m[2] ?? '').trim(), address: m[3]! };
  return { name: '', address: from.trim() };
}

/**
 * Why a full sender can't send a site's auth email, or `[]`: the family's display name and the
 * reply-able `sign-in@` address, e.g. `"Example Reports (NC OSBM)" <sign-in@reports.example.org>`.
 */
export function senderProblems(from: string, site: { siteName: string; theme: AuthTheme | ThemeFamily }): string[] {
  if (/[\r\n]/.test(from)) return ['A sender has no line breaks.'];
  const { name, address } = parseSender(from);
  return [...senderAddressProblems(address, site.theme), ...senderNameProblems(name, site.theme, site.siteName)];
}

/** The site's sender: `"{Site} (NC OSBM)" <sign-in@…>` (checked; throws on a bad address, or one that isn't the family's own). */
export function siteSender(siteName: string, theme: AuthTheme | ThemeFamily, address: string): string {
  const problems = senderAddressProblems(address, theme);
  if (problems.length > 0) throw new Error(`auth-kit: ${problems.join(' ')}`);
  return formatSenderAddress(senderDisplayName(siteName, theme), address.trim());
}

/** A theme from either a theme or a family name (the screens' `theme` prop takes both). Default personal. */
export function resolveTheme(theme: AuthTheme | ThemeFamily | undefined): AuthTheme {
  if (theme === undefined) return FAMILY_THEMES.personal;
  return typeof theme === 'string' ? authTheme(theme) : theme;
}

/** The sender's display name: "{Site} (NC OSBM)", "{Site} (UNC)", or "{Site}" (REPORT §5.1). */
export function senderDisplayName(siteName: string, theme: AuthTheme | ThemeFamily): string {
  const t = resolveTheme(theme);
  return t.senderSuffix ? `${siteName} (${t.senderSuffix})` : siteName;
}

// ---- The card's edge (register E5, ADR 0021) ---------------------------------------------------

/** WCAG 1.4.11: a component's boundary reaches 3:1 against what it sits on. */
export const CARD_EDGE_CONTRAST = 3;
/** The search aims a hair above 3:1, so rounding never lands a line just under it (Card Studio's margin). */
const EDGE_TARGET = 3.05;

/**
 * The lightest line in the family ink that, against every color the family's backdrops paint with,
 * reaches 3:1, either by itself or with the card's surface (white against the darker brand colors):
 * one line that works on every backdrop. Card Studio's `definedEdge()`: mix the ink toward white,
 * starting at 70% white and stepping darker by 1.4% until every backdrop color passes.
 */
export function definedCardEdge(input: { palette: BackdropPalette; ink: string; surface?: string }): string {
  const surface = input.surface ?? '#ffffff';
  const p = input.palette;
  const colors = [p.page, p.mist, p.glow, p.primary, p.secondary, p.ink];
  for (let i = 0; i <= 50; i++) {
    const t = 0.7 - i * 0.014;
    const line = toHex(over('#ffffff', t, input.ink));
    if (colors.every((c) => Math.max(contrastRatio(line, c), contrastRatio(surface, c)) >= EDGE_TARGET)) return line;
  }
  return toHex(over('#ffffff', 0, input.ink));
}

/** The soft hairline the card directions were drawn with: 16% ink. It doesn't promise 3:1. */
export function softCardEdge(input: { ink: string }): string {
  return toHex(over('#ffffff', 0.84, input.ink));
}

/** The theme's card edge color (transparent for the Plain style, which has no card). */
export function cardEdgeColor(theme: AuthTheme): string {
  if (theme.cardStyle === 'plain') return 'transparent';
  return theme.cardEdge === 'soft' ? softCardEdge({ ink: theme.colors.ink }) : definedCardEdge({ palette: theme.palette, ink: theme.colors.ink, surface: theme.colors.surface });
}

export interface CardEdgeCheck {
  edge: CardEdge;
  color: string;
  /** Per backdrop color: the line's contrast, the surface's, and whether the edge shows (either reaches 3:1). */
  against: { name: keyof BackdropPalette; value: string; line: number; surface: number; pass: boolean }[];
  /** True when every backdrop color passes. A `soft` edge isn't required to (it's informational). */
  pass: boolean;
  required: boolean;
}

/** Checks the theme's edge against every backdrop color (WCAG 1.4.11). Only `defined` is required to pass. */
export function checkCardEdge(theme: AuthTheme): CardEdgeCheck {
  const color = cardEdgeColor(theme);
  // Plain has no card and so no edge to check (the one exception to E4, register E5).
  if (theme.cardStyle === 'plain') return { edge: theme.cardEdge, color, against: [], pass: true, required: false };
  const round = (n: number) => Math.round(n * 100) / 100;
  const against = (Object.keys(theme.palette) as (keyof BackdropPalette)[]).map((name) => {
    const value = theme.palette[name];
    const line = contrastRatio(color, value);
    const surface = contrastRatio(theme.colors.surface, value);
    return { name, value, line: round(line), surface: round(surface), pass: Math.max(line, surface) >= CARD_EDGE_CONTRAST };
  });
  return { edge: theme.cardEdge, color, against, pass: against.every((a) => a.pass), required: theme.cardEdge === 'defined' };
}

// ---- The card's styles (register E5; Card Studio's tokens(), light theme) ------------------------

/** The few family colors only the styles use (Card Studio's FAM: tint, the gradient's end, the monogram). */
const STYLE_BRAND: Readonly<Record<ThemeFamily, { tint: string; button2: string; mono: string; monoInk: string }>> = Object.freeze({
  osbm: { tint: '#dce9f5', button2: '#196ab1', mono: '#092940', monoInk: '#ffffff' },
  unc: { tint: '#dcebf6', button2: '#0d1f3a', mono: '#4b9cd3', monoInk: '#13294b' },
  personal: { tint: '#e7e3dd', button2: '#0c0a09', mono: '#1c326e', monoInk: '#ffffff' },
});

/** `a` moved toward `b` by `t` (Card Studio's mixHex). */
const mixHex = (a: string, b: string, t: number) => toHex(over(b, t, a));
const rgbaHex = (hex: string, a: number) => {
  const [r, g, b] = parseHex(hex);
  return `rgba(${r},${g},${b},${a})`;
};

/**
 * The style's CSS custom properties (Card Studio's `tokens(dir, …)` for the light theme): the card's
 * fill, corners, shadow, spacing, the quiet fills (status, well), and the button's fill. The edge
 * stays `--ak-edge` (the defined 3:1 line by default; none on Plain).
 */
export function cardStyleVariables(theme: AuthTheme): Record<`--ak-${string}`, string> {
  const ink = theme.colors.ink;
  const brand = STYLE_BRAND[theme.family];
  const sh = (a: number) => rgbaHex(ink, a);
  const W = '#ffffff';
  const v: Record<`--ak-${string}`, string> = {
    '--ak-ground': theme.palette.page,
    '--ak-card-bg': theme.colors.surface,
    '--ak-card-solid': theme.colors.surface,
    '--ak-card-radius': '12px',
    '--ak-control-radius': '8px',
    '--ak-card-padding': '36px 32px 24px',
    '--ak-card-padding-phone': '28px 22px 20px',
    '--ak-card-shadow': `0 1px 2px ${sh(0.05)}, 0 16px 36px -16px ${sh(0.22)}`,
    '--ak-hair': mixHex(ink, W, 0.9),
    // The choice screen's rows (Card Studio's --c-opt-bd): the card's own light border, a hairline on the see-through styles.
    '--ak-option-border': mixHex(ink, W, 0.84),
    '--ak-status': sh(0.045),
    '--ak-well': 'transparent',
    '--ak-button-bg': theme.colors.button,
    '--ak-button-shadow': 'none',
    '--ak-mono': brand.mono,
    '--ak-mono-ink': brand.monoInk,
  };
  switch (theme.cardStyle) {
    case 'quiet':
      break;
    case 'monogram':
      Object.assign(v, {
        '--ak-card-bg': '#fffefc',
        '--ak-card-solid': '#fffefc',
        '--ak-surface': '#fffefc',
        '--ak-hair': '#ebe6de',
        '--ak-option-border': '#e2dcd2',
        '--ak-text': '#3f3933',
        '--ak-muted': '#625a51',
        '--ak-field-border': '#7d746a',
        '--ak-status': 'rgba(120,90,50,0.06)',
        '--ak-card-radius': '16px',
        '--ak-control-radius': '10px',
        '--ak-card-shadow': '0 1px 2px rgba(70,50,30,.06), 0 18px 40px -18px rgba(70,50,30,.26)',
      });
      break;
    case 'frosted':
      Object.assign(v, {
        '--ak-card-bg': 'rgba(255,255,255,0.66)',
        '--ak-card-solid': toHex(over(W, 0.66, theme.palette.page)),
        '--ak-hair': sh(0.12),
        '--ak-option-border': sh(0.12),
        '--ak-status': 'rgba(255,255,255,0.62)',
        '--ak-muted': mixHex(theme.colors.muted, ink, 0.25),
        '--ak-card-radius': '18px',
        '--ak-control-radius': '10px',
        '--ak-card-shadow': `0 0 0 1px ${sh(0.14)}, 0 26px 60px -26px ${sh(0.42)}`,
      });
      break;
    case 'plain':
      Object.assign(v, {
        '--ak-card-bg': 'transparent',
        '--ak-card-solid': theme.palette.page,
        '--ak-card-shadow': 'none',
        // A length, not a bare 0: the choice rows' corners are calc(card radius − 2px), floored at 10px.
        '--ak-card-radius': '0px',
        '--ak-option-border': mixHex(ink, W, 0.9),
        '--ak-status': sh(0.05),
      });
      break;
    case 'porcelain': {
      const [r, g, b] = parseHex(theme.colors.button);
      Object.assign(v, {
        '--ak-hair': sh(0.08),
        '--ak-option-border': sh(0.08),
        '--ak-field-border': mixHex(ink, W, 0.48),
        '--ak-well': mixHex(brand.tint, W, 0.45),
        '--ak-status': mixHex(brand.tint, W, 0.4),
        '--ak-card-radius': '20px',
        '--ak-control-radius': '12px',
        '--ak-card-padding': '40px 34px 26px',
        '--ak-card-padding-phone': '30px 22px 22px',
        '--ak-card-shadow': `0 0 0 1px ${sh(0.07)}, 0 1px 2px ${sh(0.05)}, 0 8px 20px -10px ${sh(0.12)}, 0 34px 70px -32px rgba(${r},${g},${b},.34)`,
        '--ak-button-bg': `linear-gradient(180deg, ${theme.colors.button}, ${brand.button2})`,
        '--ak-button-shadow': `0 1px 0 rgba(255,255,255,.14) inset, 0 8px 18px -10px rgba(${r},${g},${b},.7)`,
      });
      break;
    }
  }
  return v;
}

/**
 * CSS custom properties for the card (`authKitStyles` reads them, with fallbacks): set them on the
 * card element, or let `SignIn` do it (`theme` prop).
 */
export function themeCssVariables(theme: AuthTheme): Record<`--ak-${string}`, string> {
  const c = theme.colors;
  return {
    '--ak-surface': c.surface,
    '--ak-ink': c.ink,
    '--ak-text': c.text,
    '--ak-muted': c.muted,
    '--ak-link': c.link,
    '--ak-button': c.button,
    '--ak-button-text': c.buttonText,
    '--ak-focus': c.focus,
    '--ak-error': c.error,
    '--ak-field-border': c.fieldBorder,
    '--ak-accent': c.accent,
    '--ak-edge': cardEdgeColor(theme),
    ...cardStyleVariables(theme),
  };
}
