/**
 * What a preview draws (ADR 0025): a declarative spec, checked and filled in with sample data. Pure:
 * no React, no DOM.
 */
import { ACCOUNT_CREATION_MODES, type AccountCreationMode, type AccountCreationSettings, normalizeAccountCreation, type NormalizedAccountCreation } from '../shared/account-creation.js';
import { BACKDROP_FAMILIES } from '../backdrops/families.js';
import { type AuthTheme, CARD_STYLES, type CardEdge, type CardStyle, THEME_FAMILIES, type ThemeFamily, authTheme } from '../themes/index.js';
import type { HeadingLevel } from '../client/ui.js';

/** The page the card sits on. auth-kit's card is light either way (ADR 0021); `dark` is a page in dark mode. */
export type PreviewTheme = 'light' | 'dark';

/** `phone` draws the card as on a 375px-wide phone with 16px margins (a 343px card, the phone padding). */
export type PreviewDevice = 'desktop' | 'phone';

/** What a control was, when a preview reports it (`onAction`). */
export interface PreviewActionInfo {
  /** The screen and state the card is held at. */
  screen: string;
  state: string;
  /**
   * Where the live card goes when this action succeeds: a screen and state, or a place outside the
   * card: `@signed-in` (into the site), `@link` (another page: privacy notice, terms, the setup link),
   * `@mail` (the person's mail app). Null when the card stays where it is (Copy).
   */
  next: { screen: string; state?: string } | null;
  /** The control's words, as a screen reader hears them. */
  label: string;
  /** What's typed in the card's fields, by field name. Password fields are left out. */
  values: Record<string, string>;
}

/** Reports a control. `name` is stable across releases (`PREVIEW_ACTIONS`); `info` says where the live card would go. */
export type PreviewActionHandler = (name: string, info: PreviewActionInfo) => void;

export interface PreviewSpec {
  /** Which screen (`PREVIEW_SCREENS`). Default `email`. */
  screen?: string;
  /** Which of its states; `''` or absent is the screen's first state. */
  state?: string;
  /** The family: colors, the footer line, the email hint, the help route. Default `personal`. */
  family?: ThemeFamily;
  /** The page the card sits on. Default `light`. */
  theme?: PreviewTheme;
  /** The card's style (register E5). Default `quiet`. */
  cardStyle?: CardStyle;
  /** The card's edge. Default `defined` (3:1 on every backdrop color). */
  cardEdge?: CardEdge;
  /** How the site creates accounts: a mode, or the whole setting. Default `invite`. Sign-up screens use `domains` unless this is `open`. */
  accountCreation?: AccountCreationMode | AccountCreationSettings;
  /** The invite-only line: a "Need access?" link (default) or the plain sentence. */
  inviteLine?: 'sentence' | 'link';
  /** This browser remembers a passkey for the address (register A5a): Continue opens the passkey prompt. Default false. */
  remembered?: boolean;
  /** The site. Defaults: `Example Reports`, `example.org` (the address domain of the sample person and of `domains` sign-up). */
  site?: { name?: string; domain?: string };
  /** The help route. Defaults: the family's help mailbox (or `help@{domain}`), and `Jordan Lee` in families that name owners. */
  help?: { address?: string; owner?: string };
  /** The person on the screens: the address typed (default `ada@{domain}`), and a badly formed one for the `invalid` state. */
  sampleUser?: { email?: string; badEmail?: string };
  /** Default `desktop`. */
  device?: PreviewDevice;
  /** The email field's example address. Default: the family's. */
  emailHint?: string;
  /** Passkeys on (the site's final domain is live). Default true. */
  passkeysEnabled?: boolean;
  /** "Email me a code instead" offered. Default true. */
  emailCodeEnabled?: boolean;
  /** "Trouble signing in?" inside the card (default) or below it. */
  troubleLink?: 'inside' | 'below';
  /** Draw a stand-in QR code on "Add an authenticator app", as sites that pass `renderQrCode` show. Default true. */
  qrCode?: boolean;
  /** Open sign-up's "Protected against automated sign-ups." Default true. */
  botNote?: boolean;
  /** Paint the page color behind the card (the stage). Default false: the host's page shows through. */
  ground?: boolean;
  /** The stage's font. Default: the system UI font. Sites set their own; the card inherits it. */
  font?: string;
  /** Default 1. */
  headingLevel?: HeadingLevel;
  /** Called for every click or submit on the card; nothing else happens (ADR 0025). */
  onAction?: PreviewActionHandler;
  /**
   * Called if a screen reaches an effect the preview refuses (a sign-in request, storage, a form post,
   * the clipboard, navigation). It never should, since every control reports through `onAction` first;
   * tests watch it.
   */
  onEffect?: (name: string) => void;
}

/** A spec with every default filled in and every value checked. */
export interface ResolvedPreviewSpec {
  screen: string;
  state: string;
  family: ThemeFamily;
  theme: PreviewTheme;
  cardStyle: CardStyle;
  cardEdge: CardEdge;
  authTheme: AuthTheme;
  accountCreation: NormalizedAccountCreation;
  inviteLine: 'sentence' | 'link';
  remembered: boolean;
  siteName: string;
  domain: string;
  help: { address: string; owner?: string };
  email: string;
  badEmail: string;
  device: PreviewDevice;
  emailHint: string;
  passkeysEnabled: boolean;
  emailCodeEnabled: boolean;
  troubleLink: 'inside' | 'below';
  qrCode: boolean;
  botNote: boolean;
  ground: boolean;
  font: string;
  headingLevel: HeadingLevel;
  /** The page color behind the card: the family's page (light), or its ink (dark). */
  groundColor: string;
}

/** The card's width on each device, in CSS pixels. */
export const PREVIEW_CARD_WIDTH: Readonly<Record<PreviewDevice, number>> = Object.freeze({ desktop: 380, phone: 343 });

export const PREVIEW_DEFAULTS = Object.freeze({
  siteName: 'Example Reports',
  domain: 'example.org',
  owner: 'Jordan Lee',
  font: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
});

/** Thrown for a spec the preview can't draw: an unknown screen, state, family, or value. */
export class PreviewSpecError extends Error {
  constructor(message: string) {
    super(`auth-kit/preview: ${message}`);
    this.name = 'PreviewSpecError';
  }
}

function oneOf<T extends string>(label: string, value: unknown, allowed: readonly T[], fallback: T): T {
  if (value === undefined) return fallback;
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  throw new PreviewSpecError(`${label} must be one of ${allowed.join(', ')} (got ${JSON.stringify(value)}).`);
}

function bool(label: string, value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  throw new PreviewSpecError(`${label} must be true or false.`);
}

function text(label: string, value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  throw new PreviewSpecError(`${label} must be non-empty text.`);
}

const DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Checks a spec and fills in the defaults (the screen and state are checked against the screen list by
 * the caller, which owns it). Throws `PreviewSpecError` for anything it can't draw.
 */
export function resolvePreviewBase(spec: PreviewSpec): ResolvedPreviewSpec {
  if (spec === null || typeof spec !== 'object') throw new PreviewSpecError('the spec must be an object.');
  const family = oneOf('family', spec.family, THEME_FAMILIES, 'personal');
  const theme = oneOf('theme', spec.theme, ['light', 'dark'] as const, 'light');
  const cardStyle = oneOf('cardStyle', spec.cardStyle, CARD_STYLES, 'quiet');
  const cardEdge = oneOf('cardEdge', spec.cardEdge, ['defined', 'soft'] as const, 'defined');
  const device = oneOf('device', spec.device, ['desktop', 'phone'] as const, 'desktop');
  const inviteLine = oneOf('inviteLine', spec.inviteLine, ['sentence', 'link'] as const, 'link');
  const troubleLink = oneOf('troubleLink', spec.troubleLink, ['inside', 'below'] as const, 'inside');
  const headingLevel = spec.headingLevel === undefined ? 1 : ([1, 2, 3, 4] as const).find((l) => l === spec.headingLevel);
  if (headingLevel === undefined) throw new PreviewSpecError('headingLevel must be 1, 2, 3, or 4.');

  const siteName = text('site.name', spec.site?.name, PREVIEW_DEFAULTS.siteName);
  const domain = text('site.domain', spec.site?.domain, PREVIEW_DEFAULTS.domain).toLowerCase();
  if (!DOMAIN.test(domain)) throw new PreviewSpecError(`site.domain "${domain}" isn't a domain like example.org.`);

  let accountCreation: NormalizedAccountCreation;
  const ac = spec.accountCreation;
  try {
    if (ac === undefined) accountCreation = normalizeAccountCreation(undefined, 'accountCreation');
    else if (typeof ac === 'string') {
      if (!(ACCOUNT_CREATION_MODES as readonly string[]).includes(ac)) throw new PreviewSpecError(`accountCreation must be one of ${ACCOUNT_CREATION_MODES.join(', ')}, or a setting.`);
      accountCreation = normalizeAccountCreation(ac === 'domains' ? { mode: 'domains', domains: [domain] } : { mode: ac }, 'accountCreation');
    } else accountCreation = normalizeAccountCreation(ac, 'accountCreation');
  } catch (error) {
    if (error instanceof PreviewSpecError) throw error;
    throw new PreviewSpecError((error as Error).message.replace(/^auth-kit: /, ''));
  }

  const emailHint = spec.emailHint === undefined ? undefined : text('emailHint', spec.emailHint, '');
  if (emailHint !== undefined && !EMAIL.test(emailHint)) throw new PreviewSpecError('emailHint must be an example address like name@example.org.');
  let t: AuthTheme;
  try {
    t = authTheme(family, { cardStyle, cardEdge, ...(emailHint !== undefined && { emailHint }) });
  } catch (error) {
    throw new PreviewSpecError((error as Error).message.replace(/^auth-kit\/themes: /, ''));
  }

  const email = text('sampleUser.email', spec.sampleUser?.email, `ada@${domain}`);
  if (!EMAIL.test(email)) throw new PreviewSpecError(`sampleUser.email "${email}" isn't an email address.`);
  const badEmail = text('sampleUser.badEmail', spec.sampleUser?.badEmail, email.slice(0, email.lastIndexOf('.')));
  const helpAddress = text('help.address', spec.help?.address, t.help.address ?? `help@${domain}`);
  if (!EMAIL.test(helpAddress)) throw new PreviewSpecError(`help.address "${helpAddress}" isn't an email address.`);
  const owner = spec.help?.owner === undefined ? (t.help.named ? PREVIEW_DEFAULTS.owner : undefined) : text('help.owner', spec.help.owner, '');

  const palette = BACKDROP_FAMILIES[family].palette;
  return {
    screen: typeof spec.screen === 'string' && spec.screen !== '' ? spec.screen : 'email',
    state: typeof spec.state === 'string' ? spec.state : '',
    family,
    theme,
    cardStyle,
    cardEdge,
    authTheme: t,
    accountCreation,
    inviteLine,
    remembered: bool('remembered', spec.remembered, false),
    siteName,
    domain,
    help: { address: helpAddress, ...(owner !== undefined && { owner }) },
    email,
    badEmail,
    device,
    emailHint: t.emailHint,
    passkeysEnabled: bool('passkeysEnabled', spec.passkeysEnabled, true),
    emailCodeEnabled: bool('emailCodeEnabled', spec.emailCodeEnabled, true),
    troubleLink,
    qrCode: bool('qrCode', spec.qrCode, true),
    botNote: bool('botNote', spec.botNote, true),
    ground: bool('ground', spec.ground, false),
    font: spec.font === undefined ? PREVIEW_DEFAULTS.font : text('font', spec.font, PREVIEW_DEFAULTS.font),
    headingLevel,
    groundColor: theme === 'dark' ? palette.ink : palette.page,
  };
}
