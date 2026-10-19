/**
 * Every screen a preview can draw, its states, and how each is drawn (ADR 0025): which real component,
 * held at which of its states, with which sample values. Errors come from the screens' own words: the
 * field checks' (`ERRORS`) and Cognito's, through the same `describeAuthError` the live card uses.
 *
 * The screen and state IDs are the Sign-in Studio's (`{ screen, state }` in its screen table), plus
 * the sign-in card's other views. They're stable: renaming one breaks every host that stores it.
 */
import { ERRORS, SIGN_IN } from '../client/copy.js';
import type { HeldStates } from '../client/driver.js';
import { newPasswordProblem } from '../client/ladder.js';
import { type AuthErrorContext, describeAuthError } from '../client/messages.js';
import { type NormalizedAccountCreation, normalizeAccountCreation, notOnListMessage } from '../shared/account-creation.js';
import { CODE_LIFETIME_POLICY } from '../shared/policy.js';
import type { HelpTopic } from '../client/copy.js';
import type { SignInView } from '../client/SignIn.js';
import { type PreviewSpec, PreviewSpecError, type ResolvedPreviewSpec, resolvePreviewBase } from './spec.js';

/** The real component a screen is drawn with. */
export type PreviewComponent = 'sign-in' | 'sign-up' | 'request-access' | 'signed-out';

/** How one screen and state is drawn. */
export interface PreviewPlacement {
  component: PreviewComponent;
  /** Where each component on the screen starts (the driver's `initial`). */
  held: Partial<HeldStates>;
  /** `SignIn`'s step-up (`reauth`). */
  reauth?: boolean;
  /** The setting a sign-up screen draws with (`domains` or `open`). */
  signUpSetting?: NormalizedAccountCreation;
}

export type PreviewGroup = 'sign-in' | 'first-visit' | 'access' | 'trouble' | 'signed-out';

export interface PreviewState {
  /** `''` for a screen as it first shows. */
  id: string;
  label: string;
  /** An error state (the error summary shows, or the screen's own error). */
  error: boolean;
}

export interface PreviewScreen {
  id: string;
  label: string;
  group: PreviewGroup;
  /** The first is the screen's default (what `state: ''` draws). */
  states: readonly PreviewState[];
  /** The real component that draws it. */
  component: PreviewComponent;
}

interface ScreenDef extends PreviewScreen {
  place(r: ResolvedPreviewSpec, state: string): PreviewPlacement;
}

// ---- Sample values -------------------------------------------------------------------------------

/** The setup key on authenticator screens: RFC 4226's example secret in base32, 32 characters as Cognito issues them. */
export const SAMPLE_SETUP_KEY = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
/** "We sent a new code at 10:42 AM" in every time zone (a local time). */
export const SAMPLE_SENT_AT = new Date(2026, 9, 19, 10, 42).getTime();
const SAMPLE_PASSWORD = 'correct-horse-battery';
const SAMPLE_SHORT_PASSWORD = 'tooshort1';
const SAMPLE_TOTP = '123456';
const SAMPLE_EMAIL_CODE = '12345678';
const SAMPLE_RESET_CODE = '123456';

const named = (name: string, message: string): Error => Object.assign(new Error(message), { name });

/** A service error in the live card's words (`describeAuthError`, the same mapping). */
function says(r: ResolvedPreviewSpec, error: unknown, context: AuthErrorContext): string {
  return describeAuthError(error, context, { siteName: r.siteName, codeLifetimeMinutes: CODE_LIFETIME_POLICY.defaultMinutes, helpAddress: r.help.address }).message;
}

const state = (id: string, label: string, error = false): PreviewState => ({ id, label, error });

function signIn(r: ResolvedPreviewSpec, view: SignInView, extra: Omit<HeldStates['sign-in'], 'view'> = {}, more: Partial<HeldStates> = {}): PreviewPlacement {
  return { component: 'sign-in', held: { 'sign-in': { view, email: r.email, ...extra }, ...more } };
}

function chooser(r: ResolvedPreviewSpec, held: HeldStates['choose-first-credential'], more: Partial<HeldStates> = {}): PreviewPlacement {
  return signIn(r, { name: 'first-credential' }, {}, { 'choose-first-credential': held, ...more });
}

/** Sign-up screens draw with the site's setting when it allows sign-up, else `domains` with the site's domain. */
function signUpSetting(r: ResolvedPreviewSpec): NormalizedAccountCreation {
  const mode = r.accountCreation.mode;
  return mode === 'domains' || mode === 'open' ? r.accountCreation : normalizeAccountCreation({ mode: 'domains', domains: [r.domain] });
}

function signUp(r: ResolvedPreviewSpec, held: HeldStates['sign-up'], extra: Partial<PreviewPlacement> = {}): PreviewPlacement {
  return { component: 'sign-up', held: { 'sign-up': held }, signUpSetting: signUpSetting(r), ...extra };
}

const setupKey: Partial<HeldStates> = { 'authenticator-setup': { secret: SAMPLE_SETUP_KEY } };

// ---- The screens ---------------------------------------------------------------------------------

const HELP_TOPICS: readonly [HelpTopic, string][] = [
  ['passkey', 'Can’t use your passkey'],
  ['password', 'Forgot your password'],
  ['totp', 'Lost your authenticator app'],
  ['code', 'Didn’t get a code'],
  ['email', 'Can’t get into your email'],
  ['else', 'Something else'],
];

const SCREENS: readonly ScreenDef[] = [
  // Sign in
  {
    id: 'email',
    label: 'Sign in',
    group: 'sign-in',
    component: 'sign-in',
    states: [
      state('', 'As it first shows'),
      state('typed', 'Address typed'),
      state('reauth', 'Confirm it’s you (step-up)'),
      state('empty', 'Empty email', true),
      state('invalid', 'Badly formed email', true),
      state('throttled', 'Too many attempts', true),
      state('offline', 'Can’t reach the service', true),
    ],
    place(r, s) {
      switch (s) {
        case 'typed':
          return signIn(r, { name: 'email' });
        case 'reauth':
          return { ...signIn(r, { name: 'email' }), reauth: true };
        case 'empty':
          return signIn(r, { name: 'email' }, { email: '', feedback: { error: ERRORS.emptyEmail, field: 'email' } });
        case 'invalid':
          return signIn(r, { name: 'email' }, { email: r.badEmail, feedback: { error: ERRORS.badEmail(r.emailHint), field: 'email' } });
        case 'throttled':
          return signIn(r, { name: 'email' }, { feedback: { error: says(r, named('TooManyRequestsException', 'Rate exceeded'), 'sign-in') } });
        case 'offline':
          return signIn(r, { name: 'email' }, { feedback: { error: says(r, new TypeError('Failed to fetch'), 'sign-in') } });
        default:
          return signIn(r, { name: 'email' }, { email: '' });
      }
    },
  },
  {
    id: 'choose',
    label: 'How do you want to sign in?',
    group: 'sign-in',
    component: 'sign-in',
    states: [state('', 'The three ways in')],
    place: (r) => signIn(r, { name: 'choose' }),
  },
  {
    id: 'passkey',
    label: 'Use your passkey',
    group: 'sign-in',
    component: 'sign-in',
    states: [state('', 'Waiting for the passkey'), state('cancelled', 'Passkey cancelled', true)],
    place: (r, s) => signIn(r, { name: 'passkey', cancelled: s === 'cancelled', fromHint: r.remembered }),
  },
  {
    id: 'password',
    label: 'Enter your password',
    group: 'sign-in',
    component: 'sign-in',
    states: [state('', 'As it first shows'), state('wrong', 'Wrong password', true)],
    place: (r, s) =>
      s === 'wrong'
        ? signIn(r, { name: 'password', challenge: false }, { secret: SAMPLE_PASSWORD, feedback: { error: says(r, named('NotAuthorizedException', 'Incorrect username or password.'), 'sign-in'), field: 'secret' } })
        : signIn(r, { name: 'password', challenge: false }),
  },
  {
    id: 'totp',
    label: 'Enter your authenticator code',
    group: 'sign-in',
    component: 'sign-in',
    states: [state('', 'As it first shows'), state('wrong', 'Wrong authenticator code', true)],
    place: (r, s) =>
      s === 'wrong'
        ? signIn(r, { name: 'totp' }, { code: SAMPLE_TOTP, feedback: { error: says(r, named('CodeMismatchException', 'Invalid code received for user'), 'totp'), field: 'code' } })
        : signIn(r, { name: 'totp' }),
  },
  {
    id: 'email-code',
    label: 'Check your email',
    group: 'sign-in',
    component: 'sign-in',
    states: [state('', 'Code sent'), state('resent', 'After a resend'), state('wrong', 'Wrong emailed code', true), state('expired', 'Session expired', true)],
    place(r, s) {
      const view = { name: 'email-code', simulated: false, sentAt: SAMPLE_SENT_AT } as const;
      switch (s) {
        case 'resent':
          return signIn(r, { ...view, resentAt: SAMPLE_SENT_AT });
        case 'wrong':
          return signIn(r, view, { code: SAMPLE_EMAIL_CODE, feedback: { error: says(r, named('CodeMismatchException', 'Invalid code received for user'), 'code'), field: 'code' } });
        case 'expired':
          return signIn(r, { ...view, expired: true });
        default:
          return signIn(r, view);
      }
    },
  },
  {
    id: 'new-password',
    label: 'Choose a new password (temporary password)',
    group: 'sign-in',
    component: 'sign-in',
    states: [state('', 'As it first shows')],
    place: (r) => signIn(r, { name: 'new-password' }),
  },
  {
    id: 'mfa-setup',
    label: 'Add an authenticator app (asked during sign-in)',
    group: 'sign-in',
    component: 'sign-in',
    states: [state('', 'Setup key shown')],
    place: (r) => signIn(r, { name: 'totp-setup', secret: SAMPLE_SETUP_KEY }),
  },
  {
    id: 'enroll-authenticator',
    label: 'Add an authenticator app (after a password sign-in)',
    group: 'sign-in',
    component: 'sign-in',
    states: [state('', 'Setup key shown')],
    place: (r) => signIn(r, { name: 'enroll-authenticator' }, {}, setupKey),
  },
  {
    id: 'offer-passkey',
    label: 'Create a passkey on this device?',
    group: 'sign-in',
    component: 'sign-in',
    states: [state('', 'The one-time offer')],
    place: (r) => signIn(r, { name: 'offer-passkey' }),
  },
  {
    id: 'finishing',
    label: 'Signing you in',
    group: 'sign-in',
    component: 'sign-in',
    states: [state('', 'One moment')],
    place: (r) => signIn(r, { name: 'finishing' }, { feedback: { status: SIGN_IN.signedInOneMoment } }),
  },
  {
    id: 'check-failed',
    label: 'Couldn’t check how you sign in',
    group: 'sign-in',
    component: 'sign-in',
    states: [state('', 'Try again', true)],
    place: (r) => signIn(r, { name: 'check-failed' }),
  },
  // First visit
  {
    id: 'first-credential',
    label: 'Choose how you’ll sign in next time',
    group: 'first-visit',
    component: 'sign-in',
    states: [state('', 'The two ways')],
    place: (r) => chooser(r, { stage: 'choose' }),
  },
  {
    id: 'create-passkey',
    label: 'Create a passkey',
    group: 'first-visit',
    component: 'sign-in',
    states: [state('', 'Waiting for the device'), state('failed', 'Couldn’t create a passkey', true)],
    place: (r, s) =>
      s === 'failed'
        ? chooser(r, { stage: 'create-passkey', passkeyFailed: true, feedback: { error: says(r, named('PasskeyRegistrationCanceled', 'Passkey registration has been canceled.'), 'passkey-register') } })
        : chooser(r, { stage: 'create-passkey' }),
  },
  {
    id: 'create-password',
    label: 'Create a password',
    group: 'first-visit',
    component: 'sign-in',
    states: [state('', 'As it first shows'), state('too-short', 'Password too short', true)],
    place: (r, s) =>
      s === 'too-short'
        ? chooser(r, { stage: 'create-password', password: SAMPLE_SHORT_PASSWORD, feedback: { error: newPasswordProblem(SAMPLE_SHORT_PASSWORD), field: 'password' } })
        : chooser(r, { stage: 'create-password' }),
  },
  {
    id: 'totp-setup',
    label: 'Add an authenticator app',
    group: 'first-visit',
    component: 'sign-in',
    states: [state('', 'Setup key shown')],
    place: (r) => chooser(r, { stage: 'add-totp' }, setupKey),
  },
  {
    id: 'done',
    label: 'You’re set up',
    group: 'first-visit',
    component: 'sign-in',
    states: [state('passkey', 'Passkey route'), state('password', 'Password route'), state('new-account', 'New account (sign-up)')],
    place: (r, s) =>
      s === 'new-account' ? signUp(r, { view: { name: 'done', emailed: true }, email: r.email }) : signIn(r, { name: 'done', how: s === 'password' ? 'password' : 'passkey', emailed: true }),
  },
  // Without an account
  {
    id: 'access-help',
    label: 'Need access?',
    group: 'access',
    component: 'sign-in',
    states: [state('', 'Who to ask')],
    place: (r) => signIn(r, { name: 'access-help' }),
  },
  {
    id: 'request-access',
    label: 'Request access',
    group: 'access',
    component: 'request-access',
    states: [state('', 'As it first shows'), state('missing', 'Fields missing', true), state('sent', 'Request sent')],
    place(_r, s) {
      if (s === 'sent') return { component: 'request-access', held: { 'request-access': { sent: true } } };
      if (s === 'missing') {
        return {
          component: 'request-access',
          held: { 'request-access': { problems: [{ message: ERRORS.emptyName, field: 'name' }, { message: ERRORS.emptyEmail, field: 'email' }] } },
        };
      }
      return { component: 'request-access', held: { 'request-access': {} } };
    },
  },
  {
    id: 'sign-up',
    label: 'Create your account',
    group: 'access',
    component: 'sign-up',
    states: [state('', 'As it first shows'), state('not-allowed', 'Address not on the list', true)],
    place(r, s) {
      const setting = signUpSetting(r);
      if (s === 'not-allowed') {
        const outsider = `${r.email.slice(0, r.email.indexOf('@'))}@example.net`;
        return signUp(r, {
          view: { name: 'email', requestAccess: setting.requestsAlso },
          email: outsider,
          feedback: { error: notOnListMessage(r.siteName, setting.domains.length > 0 ? setting.domains : [r.domain], setting.requestsAlso), field: 'email' },
        });
      }
      return signUp(r, { view: { name: 'email' } });
    },
  },
  {
    id: 'sign-up-code',
    label: 'Check your email (sign-up)',
    group: 'access',
    component: 'sign-up',
    states: [state('', 'Code sent')],
    place: (r) => signUp(r, { view: { name: 'code', simulated: false, sentAt: SAMPLE_SENT_AT }, email: r.email }),
  },
  {
    id: 'sign-up-name',
    label: 'Your name',
    group: 'access',
    component: 'sign-up',
    states: [state('', 'As it first shows'), state('missing', 'Name missing', true)],
    place: (r, s) =>
      s === 'missing'
        ? signUp(r, { view: { name: 'name' }, email: r.email, feedback: { error: ERRORS.emptyName, field: 'given' } })
        : signUp(r, { view: { name: 'name' }, email: r.email }),
  },
  // Trouble signing in
  {
    id: 'trouble',
    label: 'Trouble signing in?',
    group: 'trouble',
    component: 'sign-in',
    states: [state('', 'What’s happening?')],
    place: (r) => signIn(r, { name: 'trouble' }),
  },
  {
    id: 'help',
    label: 'Help',
    group: 'trouble',
    component: 'sign-in',
    states: HELP_TOPICS.map(([topic, label]) => state(topic, label)),
    place: (r, s) => signIn(r, { name: 'help', topic: (HELP_TOPICS.find(([t]) => t === s) ?? HELP_TOPICS[0]!)[0] }),
  },
  {
    id: 'reset-code',
    label: 'Reset code',
    group: 'trouble',
    component: 'sign-in',
    states: [state('', 'Code sent')],
    place: (r) => signIn(r, { name: 'reset-code' }),
  },
  {
    id: 'reset-password',
    label: 'Choose a new password',
    group: 'trouble',
    component: 'sign-in',
    states: [state('', 'As it first shows')],
    place: (r) => signIn(r, { name: 'reset-password', code: SAMPLE_RESET_CODE }),
  },
  // Signed out
  {
    id: 'signed-out',
    label: 'You’re signed out everywhere',
    group: 'signed-out',
    component: 'signed-out',
    states: [state('', 'After “Sign out everywhere”')],
    place: () => ({ component: 'signed-out', held: {} }),
  },
];

const BY_ID: ReadonlyMap<string, ScreenDef> = new Map(SCREENS.map((s) => [s.id, s]));

/**
 * State IDs a release has retired, and the state each now draws. Hosts store IDs, so a retired one keeps
 * working. v0.1.10-alpha.1: the name step's two buttons ("Create account", "Finish") became one, Continue
 * (register A6).
 */
const RETIRED_STATES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'sign-up-name': { 'create-account': '', finish: '' },
};

/** Every screen and its states, in flow order (for a host's lists and menus). */
export const PREVIEW_SCREENS: readonly PreviewScreen[] = Object.freeze(
  SCREENS.map((s) => Object.freeze({ id: s.id, label: s.label, group: s.group, component: s.component, states: Object.freeze(s.states.map((st) => Object.freeze({ ...st }))) })),
);

/** The screen and state a spec names, the state resolved (`''` is the first), or why it can't be drawn. */
export function findScreen(screen: string, stateId: string): { screen: ScreenDef; state: string } | { problem: string } {
  const def = BY_ID.get(screen);
  if (!def) return { problem: `there's no screen "${screen}". Screens: ${SCREENS.map((s) => s.id).join(', ')}.` };
  const retired = Object.hasOwn(RETIRED_STATES, screen) ? RETIRED_STATES[screen]! : {};
  const current = Object.hasOwn(retired, stateId) ? retired[stateId]! : stateId;
  const resolved = current === '' ? def.states[0]!.id : current;
  if (!def.states.some((s) => s.id === resolved)) {
    return { problem: `the "${screen}" screen has no state "${stateId}". States: ${def.states.map((s) => (s.id === '' ? "'' (the default)" : s.id)).join(', ')}.` };
  }
  return { screen: def, state: resolved };
}

// ---- Where an action leads ----------------------------------------------------------------------

type Target = { screen: string; state?: string } | null;
const to = (screen: string, s?: string): Target => (s === undefined ? { screen } : { screen, state: s });
const SIGNED_IN = to('@signed-in');
const LINK = to('@link');
const MAIL = to('@mail');

/** The same action on every screen that has it. */
const COMMON: Readonly<Record<string, Target>> = {
  trouble: to('trouble'),
  'change-email': to('email', 'typed'),
  'different-email': to('email', 'typed'),
  'back-to-sign-in': to('email', 'typed'),
  'start-again': to('email', 'typed'),
  back: to('trouble'),
  'email-help': MAIL,
  'request-access': to('request-access'),
  'create-account': to('sign-up'),
  'need-access': to('access-help'),
  'privacy-notice': LINK,
  terms: LINK,
  'open-setup-link': LINK,
  'copy-setup-key': null,
  'continue-to-site': SIGNED_IN,
  'sign-in': to('email'),
  'sign-in-again': to('email'),
  'ask-for-access-instead': to('request-access'),
  'use-password': to('password'),
  'use-passkey': to('passkey'),
  'send-email-code': to('email-code'),
  'resend-code': to('email-code', 'resent'),
  'send-reset-code': to('reset-code'),
  'resend-reset-code': to('reset-code'),
  'forgot-password': to('help', 'password'),
  'lost-authenticator': to('help', 'totp'),
  ...Object.fromEntries(HELP_TOPICS.map(([topic]) => [`help-${topic}`, to('help', topic)])),
};

/** What differs by screen. */
const BY_SCREEN: Readonly<Record<string, Readonly<Record<string, Target | ((r: ResolvedPreviewSpec) => Target)>>>> = {
  email: { continue: (r) => (!r.passkeysEnabled ? to('password') : r.remembered ? to('passkey') : to('choose')) },
  passkey: { 'try-again': to('passkey') },
  password: { 'submit-password': to('totp') },
  totp: { 'submit-totp': SIGNED_IN },
  'email-code': { 'submit-code': SIGNED_IN },
  'new-password': { 'submit-new-password': SIGNED_IN },
  'mfa-setup': { 'submit-authenticator-code': SIGNED_IN },
  'enroll-authenticator': { 'submit-authenticator-code': SIGNED_IN },
  'offer-passkey': { 'create-passkey': SIGNED_IN, 'not-now': SIGNED_IN },
  'check-failed': { 'try-again': SIGNED_IN },
  'first-credential': { 'create-passkey': to('create-passkey'), 'use-password': to('create-password') },
  'create-passkey': { 'try-again': to('create-passkey'), 'use-password': to('create-password') },
  'create-password': { 'submit-new-password': to('totp-setup'), 'use-passkey': to('create-passkey') },
  'totp-setup': { 'submit-authenticator-code': to('done', 'password') },
  'request-access': { 'send-request': to('request-access', 'sent'), 'back-to-sign-in': to('email') },
  // A help screen's "Send a new code" sends one as "Email me a code" does: a first code, not a resend.
  help: { 'resend-code': to('email-code') },
  'sign-up': { continue: to('sign-up-code') },
  'sign-up-code': { 'submit-code': to('sign-up-name'), 'resend-code': to('sign-up-code'), 'different-email': to('sign-up'), 'start-again': to('sign-up') },
  'sign-up-name': { 'submit-name': to('first-credential') },
  'reset-code': { 'submit-reset-code': to('reset-password') },
  'reset-password': { 'submit-new-password': to('totp') },
};

/**
 * Where the live card goes after `action` on a screen, when the request behind it succeeds. A host
 * drives a flow with it (`onAction`'s `info.next`); a request that fails stays on the screen with its
 * error state.
 */
export function nextAfter(r: ResolvedPreviewSpec, screen: string, action: string): Target {
  const own = BY_SCREEN[screen]?.[action];
  if (own !== undefined) return typeof own === 'function' ? own(r) : own;
  return COMMON[action] ?? null;
}

/** Every action name a preview reports, sorted. Stable across releases. */
export const PREVIEW_ACTIONS: readonly string[] = Object.freeze(
  [...new Set([...Object.keys(COMMON), ...Object.values(BY_SCREEN).flatMap((m) => Object.keys(m)), 'submit-name', 'not-now'])].sort(),
);

/**
 * A spec checked against the screen list and filled in: the state resolved (`''` is the screen's first),
 * and every default applied. Throws `PreviewSpecError` for anything a preview can't draw.
 */
export function resolvePreviewSpec(spec: PreviewSpec): ResolvedPreviewSpec {
  const base = resolvePreviewBase(spec);
  const found = findScreen(base.screen, base.state);
  if ('problem' in found) throw new PreviewSpecError(found.problem);
  return { ...base, state: found.state };
}

/** How a resolved spec's screen and state is drawn. */
export function placementOf(r: ResolvedPreviewSpec): PreviewPlacement {
  const found = findScreen(r.screen, r.state);
  if ('problem' in found) throw new PreviewSpecError(found.problem);
  return found.screen.place(r, found.state);
}
