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
 * - the help route: the role-based help mailbox (required, never a person's own address, and no
 *   default ships), whether screens name the site's owner or say "the {Site} team", how the team
 *   confirms it's you, where to go for the email account, device, or app itself (the IT desk), and
 *   the OSBM Teams check;
 * - an optional authorized-use line (OSBM; off by default while register A10 is open).
 *
 * Pure: no React, no AWS. The client, the server's mailer, and the custom message trigger all read it.
 */
import { BACKDROP_FAMILIES } from '../backdrops/families.js';
import { contrastRatio, over, toHex } from '../backdrops/kernel/v1/color.js';
import type { BackdropFamily, BackdropPalette } from '../backdrops/types.js';

export type ThemeFamily = BackdropFamily;

/** The card's edge (register E5, Proposed; ADR 0021's 3:1 edge rule). */
export type CardEdge = 'defined' | 'soft';

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
   * The family's role-based help mailbox: one per family, never per site and never a person's own
   * address. It's also the Reply-To on auth emails and the "Help:" line in their footer. Required, and
   * no default ships: set it with `authTheme(family, { helpAddress })` (a site may override it, and a
   * Super admin may override that without a deploy; `auth-kit/accounts`' sign-in help setting).
   */
  address: string | null;
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
   * The footer identity line (E4), the same words on the card and at the foot of every email (David,
   * 2026-10-18: emails match the card, with no letterhead). Null on personal sites, which never name a person.
   */
  footer: string | null;
  /** The email field's example address (E2). A site may set its own (A9). */
  emailHint: string;
  /** The help route (REPORT §7.2, Card Studio v4; ADR 0024). */
  help: Readonly<ThemeHelp>;
  /** The family's authorized-use line, when it has one. Shown only with `showAuthorizedUse`. */
  authorizedUseLine: string | null;
  /** Show the authorized-use line on the sign-in card. Default false (register A10 is still Proposed). */
  showAuthorizedUse: boolean;
  /** `defined` (default): a line in the family ink that reaches 3:1 on every backdrop color. `soft`: a hairline. */
  cardEdge: CardEdge;
}

/** What a site may change about its family's theme. */
export interface AuthThemeOverrides extends Partial<Pick<AuthTheme, 'emailHint' | 'showAuthorizedUse' | 'cardEdge'>> {
  /** The help mailbox (required before a deploy; `helpAddressProblems` says why one can't be used). */
  helpAddress?: string;
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
  showAuthorizedUse: false,
  cardEdge: 'defined' as const,
});

/** The three families, exactly as REPORT §7.2 and the register (E1, E2, E4) set them. Brand constants. */
export const FAMILY_THEMES: Readonly<Record<ThemeFamily, Readonly<AuthTheme>>> = Object.freeze({
  osbm: Object.freeze({
    ...base('osbm'),
    label: 'NC OSBM',
    organization: 'NC Office of State Budget and Management',
    senderSuffix: 'NC OSBM',
    footer: 'This site is managed by the NC Office of State Budget and Management',
    emailHint: 'name@osbm.nc.gov',
    help: Object.freeze({ address: null, named: true, verify: 'on Teams or by phone', itDesk: 'your agency’s IT help desk', devDesk: 'your agency’s IT help desk', teamsCheck: true }),
    authorizedUseLine: 'This is a State of North Carolina system for authorized use.',
  }),
  unc: Object.freeze({
    ...base('unc'),
    label: 'UNC',
    organization: 'UNC-Chapel Hill',
    senderSuffix: 'UNC',
    footer: 'This site is managed by UNC-Chapel Hill',
    emailHint: 'name@unc.edu',
    help: Object.freeze({ address: null, named: true, verify: 'by phone or in person', itDesk: 'the UNC IT help desk', devDesk: 'the UNC IT help desk', teamsCheck: false }),
    authorizedUseLine: null,
  }),
  personal: Object.freeze({
    ...base('personal'),
    label: 'Personal',
    organization: null,
    senderSuffix: null,
    footer: null,
    emailHint: 'name@example.com',
    help: Object.freeze({
      address: null,
      named: false,
      verify: 'by email',
      itDesk: 'your email provider, or your IT help desk if your organization runs your email',
      devDesk: 'the device maker’s support',
      teamsCheck: false,
    }),
    authorizedUseLine: null,
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
    if (!['emailHint', 'showAuthorizedUse', 'cardEdge', 'helpAddress', 'helpNamed'].includes(key)) throw new Error(`auth-kit/themes: "${key}" can't be overridden per site.`);
  }
  if (overrides.cardEdge !== undefined && overrides.cardEdge !== 'defined' && overrides.cardEdge !== 'soft') {
    throw new Error(`auth-kit/themes: cardEdge must be 'defined' or 'soft'.`);
  }
  if (overrides.showAuthorizedUse !== undefined && typeof overrides.showAuthorizedUse !== 'boolean') {
    throw new Error('auth-kit/themes: showAuthorizedUse must be true or false.');
  }
  if (overrides.helpNamed !== undefined && typeof overrides.helpNamed !== 'boolean') throw new Error('auth-kit/themes: helpNamed must be true or false.');
  let helpAddress: string | undefined;
  if (overrides.helpAddress !== undefined) {
    helpAddress = overrides.helpAddress.trim().toLowerCase();
    const problems = helpAddressProblems(helpAddress);
    if (problems.length > 0) throw new Error(`auth-kit/themes: helpAddress: ${problems.join(' ')}`);
  }
  const hint = overrides.emailHint?.trim();
  if (overrides.emailHint !== undefined && (!hint || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(hint))) {
    throw new Error(`auth-kit/themes: emailHint must be an example address like name@example.org.`);
  }
  const familyTheme = FAMILY_THEMES[family];
  const help = Object.freeze({
    ...familyTheme.help,
    ...(helpAddress !== undefined && { address: helpAddress }),
    ...(overrides.helpNamed !== undefined && { named: overrides.helpNamed }),
  });
  return Object.freeze({
    ...familyTheme,
    help,
    ...(hint !== undefined && { emailHint: hint }),
    ...(overrides.showAuthorizedUse !== undefined && { showAuthorizedUse: overrides.showAuthorizedUse }),
    ...(overrides.cardEdge !== undefined && { cardEdge: overrides.cardEdge }),
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
 * Why an address can't be the site's help mailbox, or `[]` when it can. Refused: nothing at all, a
 * malformed address, a placeholder (`replace-me`, `placeholder`, `changeme`, `todo`, or a reserved
 * test domain such as `.invalid` or `.test`), and an address with an obvious person's name
 * (`first.last@…`, unless either part is a role word like `help`): the help mailbox is role-based, so it outlives whoever answers it.
 */
export function helpAddressProblems(address: string | null | undefined): string[] {
  const value = (address ?? '').trim().toLowerCase();
  if (value === '') return ['The site needs a help address: a role-based mailbox, like apps-help@your-agency.gov, on the help screens and as the Reply-To on auth emails.'];
  if (!/^[^\s@<>"(),;:]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(value)) return [`"${address}" isn't an email address.`];
  const [local = '', domain = ''] = value.split('@');
  const tld = domain.slice(domain.lastIndexOf('.') + 1);
  if (PLACEHOLDER_MARKERS.test(value) || RESERVED_TLDS.includes(tld)) return [`"${address}" is a placeholder: set the site's real help mailbox.`];
  const personal = PERSONAL_LOCAL_PART.exec(local);
  if (personal && !ROLE_WORDS.has(personal[1]!) && !ROLE_WORDS.has(personal[2]!)) return [`"${address}" looks like a person's own address. Use a role-based mailbox (apps-help@…, help@…) that outlives whoever answers it.`];
  return [];
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

/** The theme's card edge color. */
export function cardEdgeColor(theme: AuthTheme): string {
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
  const round = (n: number) => Math.round(n * 100) / 100;
  const against = (Object.keys(theme.palette) as (keyof BackdropPalette)[]).map((name) => {
    const value = theme.palette[name];
    const line = contrastRatio(color, value);
    const surface = contrastRatio(theme.colors.surface, value);
    return { name, value, line: round(line), surface: round(surface), pass: Math.max(line, surface) >= CARD_EDGE_CONTRAST };
  });
  return { edge: theme.cardEdge, color, against, pass: against.every((a) => a.pass), required: theme.cardEdge === 'defined' };
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
  };
}
