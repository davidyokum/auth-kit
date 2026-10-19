import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { safeRedirect } from '../server/redirect.js';
import { type AccountCreationSettings, domainsInWords, normalizeAccountCreation } from '../shared/account-creation.js';
import { codeLifetimeMinutes as checkedLifetime } from '../shared/policy.js';
import { type AuthTheme, type ThemeFamily, resolveTheme } from '../themes/index.js';
import { AuthenticatorSetup } from './AuthenticatorSetup.js';
import { tagged, useDriver } from './driver.js';
import { type AccountNotices, resolveNotices } from './notices.js';
import type { AccountNoticeEvent } from '../shared/notices.js';
import { ChooseFirstCredential, type FirstCredential } from './ChooseFirstCredential.js';
import { ACCESS_HELP, ACCESS_LINE, CONTACT, type CopyContext, ERRORS, FIRST_VISIT, type HelpTopic, SIGN_IN, STATUS, TROUBLE, contactLines, helpScreen } from './copy.js';
import { hrefOr } from './href.js';
import { Icon } from './icons.js';
import { type ClientAuthFactors, SIGN_IN_AUTOCOMPLETE, type SignInMethod, afterSignInStep, newPasswordProblem, normalizeCode } from './ladder.js';
import type { AuthErrorContext, AuthErrorInfo, AuthErrorKind, MessageWords } from './messages.js';
import { type PasskeyPromptOptions, answerSimulatedCode, isFirstFactorRefusal, isFirstFactorUnavailable } from './parity.js';
import type { PasswordCheckOptions } from './PasswordForm.js';
import type { SignInStep } from './steps.js';
import {
  Actions,
  AltLinks,
  type AltLink,
  Button,
  Card,
  type CardBottom,
  ContactBox,
  ErrorSummary,
  Field,
  Glyph,
  Heading,
  type HeadingLevel,
  HiddenUsername,
  Note,
  PasswordField,
  StatusRegion,
  Steps,
  type StyleProps,
  Text,
  Wait,
  Who,
  slot,
  useFeedback,
  useFocusOnViewChange,
} from './ui.js';

/** The help route on the screens: the help mailbox in effect, and who looks after the site. */
export interface SignInHelp {
  /**
   * The help address in effect: the family's mailbox, the site's override, or a Super admin's
   * (read on the server, `createSignInHelp(…).effective()` from `auth-kit/accounts`). Required.
   */
  address: string;
  /** The person who looks after the site ("Jordan Lee looks after Example Reports"), named only in families that name owners. */
  owner?: string;
}

export interface SignInProps extends StyleProps, PasswordCheckOptions {
  /** The site's name: "Sign in to {siteName}", and the authenticator's label. */
  siteName: string;
  /** The site's family, or its theme (`authTheme`): colors, the card edge, the footer identity line, the email hint, the help route. Default personal. */
  theme?: AuthTheme | ThemeFamily;
  /** The help route: the help address in effect, and the owner's name. Required (ADR 0024). */
  help: SignInHelp;
  /** Passkeys switch on once the site's final domain is live (the relying-party ID). */
  passkeysEnabled: boolean;
  /**
   * The pool's passkey settings: its relying-party ID (`passkeys.relyingPartyId` in `auth-kit/amplify`,
   * or the sandbox's) and the passkey window's timeout in milliseconds. An address without a passkey
   * gets a passkey window that finds nothing (ADR 0018); with these, that window asks the browser what
   * Cognito's would, so it looks and times out the same. Defaults: the page's own domain, and 180000.
   *
   * ```tsx
   * <SignIn passkey={{ relyingPartyId: 'reports.example.org' }} … />
   * ```
   */
  passkey?: PasskeyPromptOptions;
  /** Offer "Email me a code instead". Default true; admin pools have no emailed codes. */
  emailCodeEnabled?: boolean;
  /** How the site creates accounts (the card's line; register D1). Default invite only. */
  accountCreation?: AccountCreationSettings;
  /** The invite-only line: a "Need access?" link to who to ask (default), or the plain sentence. */
  inviteLine?: 'sentence' | 'link';
  /** "Trouble signing in?" inside the card (the default, register E5) or just below it. */
  troubleLink?: 'inside' | 'below';
  /** How long an emailed code works, in minutes: the same value as the preset's (register A7). Default 10. */
  codeLifetimeMinutes?: number;
  /** Where "Create an account" goes. Default `/sign-up`. A same-site path or an http(s) URL (anything else throws). */
  signUpHref?: string;
  /** Where "Need access? Request it." goes. Default `/request-access`. A same-site path or an http(s) URL (anything else throws). */
  requestAccessHref?: string;
  /**
   * Account-change notices (register A10: on by default): after the first passkey or password, or a
   * password reset, `SignIn` asks the site's notice route (`createAccountNoticeRoute`, mounted at
   * `/api/auth-kit/account-notice` unless `url` says otherwise) to email the account, and says "We've
   * emailed you a note about this." only when it did. `false` for a site that doesn't send them.
   * `{ mounted: true }` once the site has mounted the route: only then does "Forgot your password?"
   * promise "We'll email you a note when your password changes." ahead of time.
   */
  notices?: AccountNotices;
  /** The `next` search parameter. Goes through `safeRedirect` (same-site paths only). */
  next?: string | null;
  /** Where to go when `next` is missing or unsafe. Default `/`. */
  defaultNext?: string;
  /** Restrict `next` to these path prefixes. */
  allowedRedirectPrefixes?: readonly string[];
  /** Step-up: the server asked for a fresh sign-in (`?reauth=1`). */
  reauth?: boolean;
  /** Default: a full page load (`window.location.assign`), so the server sees the new cookies. */
  navigate?: (path: string) => void;
  /** Reads factors after sign-in. Default: Cognito `GetUserAuthFactors` from the browser. */
  loadFactors?: () => Promise<ClientAuthFactors>;
  /** Default 1: the sign-in screen is usually the page. */
  headingLevel?: HeadingLevel;
  renderQrCode?: (otpauthUri: string) => ReactNode;
  /**
   * The email field's example address (A9): defaults to the family's (`name@osbm.nc.gov`), and a site
   * may set its own (`name@nc.gov`). A hint inside the field, under the "Email address" label.
   */
  emailHint?: string;
}

/**
 * Where the card is (its state machine's states). Exported for the driver (ADR 0025), not from
 * `auth-kit/client`: a preview holds the card at one of these.
 */
export type SignInView =
  | { name: 'email' }
  /** `fromHint`: this browser's passkey hint opened the prompt straight from the email step (register A5a). */
  | { name: 'passkey'; cancelled: boolean; fromHint?: boolean }
  /** "How do you want to sign in?" (register A5a): Continue with no passkey hint for the address. */
  | { name: 'choose' }
  | { name: 'password'; challenge: boolean }
  /** "Check your email". `simulated`: nothing was sent (no account, or no emailed codes for it); the screen is the same. */
  | { name: 'email-code'; simulated: boolean; sentAt: number; resentAt?: number; expired?: boolean }
  | { name: 'totp' }
  | { name: 'new-password' }
  | { name: 'totp-setup'; secret: string }
  | { name: 'reset-code' }
  | { name: 'reset-password'; code: string }
  | { name: 'finishing' }
  /** Signed in, but the account's ways in couldn't be read: "Try again", never into the site unchecked. */
  | { name: 'check-failed' }
  | { name: 'enroll-authenticator' }
  | { name: 'first-credential' }
  | { name: 'done'; how: FirstCredential; emailed: boolean }
  | { name: 'offer-passkey' }
  | { name: 'trouble' }
  /** `askEmail`: the address wasn't typed when the screen opened, so its action asks for it (and keeps asking while it's typed). */
  | { name: 'help'; topic: HelpTopic; askEmail?: boolean }
  | { name: 'access-help' };

type View = SignInView;

const RESEND_COOLDOWN_MS = 30_000;

/** A step for the screens: Cognito's, or "check your email" when nothing was sent. */
type ScreenStep = SignInStep | { step: 'email-code-simulated' };

/** What an unknown address gets for a password: Cognito's own words under PreventUserExistenceErrors. */
function passwordRefused(): Error {
  const error = new Error('Incorrect username or password.');
  error.name = 'NotAuthorizedException';
  return error;
}

/**
 * Starts a sign-in with one first factor and keeps the screens the same for every address (ADR 0018):
 * when Cognito says this account can't use that factor (offers a choice of others, or asks for a
 * password reset), or refuses the account (disabled, an expired invite included), the screens get
 * what an unknown address gets: a passkey prompt that finds nothing, a password that doesn't match, or
 * "check your email" with nothing sent. Cognito's list of the account's other factors is never shown.
 */
function firstFactor(
  method: SignInMethod,
  request: () => Promise<SignInStep>,
  decoyPasskeyPrompt: (options?: PasskeyPromptOptions) => Promise<never>,
  passkey: PasskeyPromptOptions = {},
): () => Promise<ScreenStep> {
  const unavailable = async (): Promise<ScreenStep> => {
    switch (method) {
      case 'passkey':
        return decoyPasskeyPrompt(passkey);
      case 'password':
        throw passwordRefused();
      case 'email-code':
        return { step: 'email-code-simulated' };
    }
  };
  return async () => {
    let step: SignInStep;
    try {
      step = await request();
    } catch (error) {
      // A throttle, an expired session, or the network keep their own messages.
      if (!isFirstFactorRefusal(error)) throw error;
      return unavailable();
    }
    return isFirstFactorUnavailable(method, step) ? unavailable() : step;
  };
}

function looksLikeEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function clockTime(at: number): string {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date(at));
}

/** The help screens' one button, as an action's name (ADR 0025). */
const HELP_ACTION = { 'email-code': 'send-email-code', 'reset-code': 'send-reset-code', 'resend-code': 'resend-code' } as const;

/** The views that carry "Trouble signing in?" (Card Studio: every sign-in screen, not setup or help). */
const TROUBLE_VIEWS = new Set<View['name']>(['email', 'choose', 'passkey', 'password', 'totp', 'email-code', 'reset-code', 'reset-password']);

/**
 * The sign-in card (REPORT §3, Card Studio v4; ADR 0024). Email first: "Continue" opens the passkey
 * prompt (or, before passkeys are on, the password screen). "Use a password instead" (the password,
 * then the authenticator code) and "Email me a code instead" (the backstop) are always offered.
 * Then the steps after sign-in: the authenticator for password users, the required "Choose how
 * you'll sign in next time" after an invite or a sign-up, and a one-time "Create a passkey on this
 * device?". "Trouble signing in?" opens the triage list and its six help screens.
 *
 * Until someone proves a factor, every address sees the same screens in the same order, whether it
 * has an account or not and whatever factors that account has (ADR 0018).
 *
 * Buttons (register A6): **Continue** on the email and password steps (an authenticator code always
 * follows a password, ADR 0002) and the steps between; **Sign in** on the authenticator-code and
 * emailed-code steps, which finish; the passkey step has none (the browser's window finishes it).
 */
export function SignIn(props: SignInProps) {
  const { classNames, passkeysEnabled, siteName } = props;
  // The live driver unless a preview holds the card (ADR 0025): every effect below goes through it.
  const driver = useDriver();
  const init = driver.initial('sign-in');
  const theme = useMemo(() => resolveTheme(props.theme), [props.theme]);
  const lifetime = checkedLifetime(props.codeLifetimeMinutes, 'SignIn codeLifetimeMinutes');
  const accountCreation = useMemo(() => normalizeAccountCreation(props.accountCreation, 'SignIn accountCreation'), [props.accountCreation]);
  const c: CopyContext = {
    siteName,
    theme,
    codeLifetimeMinutes: lifetime,
    helpAddress: props.help.address,
    ...(props.help.owner !== undefined && { ownerName: props.help.owner }),
    // Open sign-up sites are public: "the {Site} team", never a person, and no Teams check (E4c).
    publicSite: accountCreation.mode === 'open',
  };
  const words: MessageWords = { siteName, codeLifetimeMinutes: lifetime, helpAddress: props.help.address };
  const emailCodeEnabled = props.emailCodeEnabled ?? true;
  const level = props.headingLevel ?? 1;
  const hint = props.emailHint?.trim() || theme.emailHint;
  // Checked before anything renders: a bad one is the site's misconfiguration, never a visitor's input.
  const signUpHref = hrefOr('signUpHref', props.signUpHref, '/sign-up');
  const requestAccessHref = hrefOr('requestAccessHref', props.requestAccessHref, '/request-access');
  const passkeyOptions = props.passkey;
  /** The first factor last asked for: a passkey sign-in sets this browser's passkey hint (register A5a). */
  const methodRef = useRef<'passkey' | 'password' | 'email-code' | null>(null);
  const notices = useMemo(() => resolveNotices(props.notices, 'SignIn'), [props.notices]);
  const pendingNotice = useRef<AccountNoticeEvent | null>(null);
  const uid = useId();
  const ids = { email: `${uid}-email`, password: `${uid}-password`, code: `${uid}-code`, newPassword: `${uid}-new-password` };
  const rootRef = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const secretRef = useRef<HTMLInputElement>(null);
  const fb = useFeedback(init?.feedback);
  const { set } = fb;
  const [view, setView] = useState<View>(init?.view ?? { name: 'email' });
  const [email, setEmail] = useState(init?.email ?? '');
  const [secretValue, setSecretValue] = useState(init?.secret ?? '');
  const [codeValue, setCodeValue] = useState(init?.code ?? '');
  const [resendReady, setResendReady] = useState(init?.resendReady ?? true);
  const userIdRef = useRef<string | undefined>(undefined);
  useFocusOnViewChange(rootRef, view.name);

  // Step-up: prefill the email of whoever is signed in on this device.
  useEffect(() => {
    if (!props.reauth) return;
    let active = true;
    void driver.currentUser().then((user) => {
      const loginId = user?.loginId;
      if (active && loginId) setEmail((e) => e || loginId);
    });
    return () => {
      active = false;
    };
  }, [props.reauth, driver]);

  // "Send a new code" waits a little between sends (each one emails the person and counts toward WAF limits).
  useEffect(() => {
    if (resendReady) return;
    const timer = setTimeout(() => setResendReady(true), RESEND_COOLDOWN_MS);
    return () => clearTimeout(timer);
  }, [resendReady]);

  const go = useCallback(
    (next: View, keep: { error?: boolean } = {}) => {
      setSecretValue('');
      setCodeValue('');
      if (!keep.error) set({ error: null, field: null });
      setView(next);
    },
    [set],
  );

  const finish = useCallback(() => {
    const target = safeRedirect(props.next, props.defaultNext ?? '/', {
      ...(props.allowedRedirectPrefixes !== undefined && { allowedPrefixes: props.allowedRedirectPrefixes }),
    });
    (props.navigate ?? driver.navigate)(target);
  }, [props.next, props.defaultNext, props.allowedRedirectPrefixes, props.navigate, driver]);

  /**
   * After Cognito says DONE: decide what else this person needs before entering the site. Never in
   * without reading the account's factors: one that still owes its first credential (a fresh invite
   * or sign-up) must choose it first (ADR 0024), so a failed read offers "Try again" instead.
   */
  const afterSignIn = useCallback(async () => {
    go({ name: 'finishing' });
    set({ status: SIGN_IN.signedInOneMoment, error: null });
    userIdRef.current = (await driver.currentUser())?.userId;
    if (methodRef.current === 'passkey') await driver.rememberPasskey(email);
    if (pendingNotice.current) {
      const event = pendingNotice.current;
      pendingNotice.current = null;
      await driver.sendAccountNotice(notices, event);
    }
    let factors: ClientAuthFactors | null | undefined;
    try {
      factors = await (props.loadFactors ?? driver.fetchAuthFactors)();
    } catch {
      factors = null;
    }
    if (!factors) {
      // The server refuses an account with no password and no passkey too (first_credential_required).
      set({ status: null });
      return go({ name: 'check-failed' });
    }
    switch (afterSignInStep(factors, { passkeysEnabled })) {
      case 'set-up-authenticator':
        set({ status: null });
        return go({ name: 'enroll-authenticator' });
      case 'choose-first-credential':
        set({ status: null });
        return go({ name: 'first-credential' });
      case 'offer-passkey':
        if (props.reauth || driver.passkeyOfferDismissed(userIdRef.current)) return finish();
        set({ status: null });
        return go({ name: 'offer-passkey' });
      case 'done':
        return finish();
    }
  }, [email, finish, go, notices, passkeysEnabled, props.loadFactors, props.reauth, set, driver]);

  /** Shows the screen for the step Cognito returned. */
  const handleStep = useCallback(
    (step: ScreenStep) => {
      switch (step.step) {
        case 'done':
          return void afterSignIn();
        case 'choose-method':
          // Never shown: a first-factor request maps it to that factor's own outcome (firstFactor).
          set({ error: ERRORS.methodUnavailable });
          return go({ name: 'email' }, { error: true });
        case 'password':
          return go({ name: 'password', challenge: true });
        case 'email-code':
        case 'email-code-simulated':
          setResendReady(false);
          set({ status: null });
          return go({ name: 'email-code', simulated: step.step === 'email-code-simulated', sentAt: Date.now() });
        case 'totp':
          return go({ name: 'totp' });
        case 'new-password':
          if (step.missingAttributes.length > 0) {
            set({ error: `This account is missing details this screen can’t collect. Email ${props.help.address}.` });
            return go({ name: 'email' }, { error: true });
          }
          return go({ name: 'new-password' });
        case 'totp-setup':
          return go({ name: 'totp-setup', secret: step.secret });
        case 'reset-password':
          // Never from a first-factor request: firstFactor reads it as "not available" (ADR 0018), so a
          // stranger can't tell such an account from no account. "Forgot your password?" is the route.
          return go({ name: 'help', topic: 'password' });
        case 'select-mfa':
        case 'unsupported':
          set({ error: `This account needs a sign-in step this site doesn’t support. Email ${props.help.address}.` });
          return go({ name: 'email' }, { error: true });
      }
    },
    [afterSignIn, go, props.help.address, set],
  );

  async function attempt(task: () => Promise<ScreenStep>, context: AuthErrorContext, busyStatus?: string): Promise<AuthErrorKind | null> {
    const failed: { kind?: AuthErrorKind } = {};
    const result = await fb.run(task, {
      context,
      words,
      onError: (info: AuthErrorInfo) => {
        failed.kind = info.kind;
      },
      ...(busyStatus !== undefined && { busyStatus }),
    });
    if (result.ok) {
      handleStep(result.value);
      return null;
    }
    switch (failed.kind) {
      case 'session-expired':
        // The sign-in session ran out: the code screen says so and offers to start again.
        if (view.name === 'email-code') setView({ ...view, expired: true });
        else go({ name: 'email' }, { error: true });
        break;
      case 'reset-required':
        go({ name: 'help', topic: 'password' }, { error: true });
        break;
      case 'bad-credentials':
        set({ field: 'secret' });
        break;
      case 'wrong-code':
      case 'expired-code':
        set({ field: 'code' });
        break;
      case 'method-unavailable':
      case 'network':
      case 'passkey-cancelled':
      case 'passkey-exists':
      case 'passkey-unavailable':
      case 'password-rejected':
      case 'rate-limited':
      case 'signed-out':
      case 'unknown':
      case undefined:
        // The summary says it; the screen stays.
        break;
    }
    return failed.kind ?? 'unknown';
  }

  function requireEmail(): boolean {
    if (looksLikeEmail(email)) return true;
    set({ error: email.trim() ? ERRORS.badEmail(hint) : ERRORS.emptyEmail, field: 'email', status: null });
    if (view.name !== 'email' && view.name !== 'help') go({ name: 'email' }, { error: true });
    emailRef.current?.focus();
    return false;
  }

  function startPasskey(fromHint = false) {
    methodRef.current = 'passkey';
    go({ name: 'passkey', cancelled: false, fromHint });
    void attempt(firstFactor('passkey', () => driver.signInWithPasskey(email), driver.decoyPasskeyPrompt, passkeyOptions), 'sign-in').then((kind) => {
      // A closed window, or no passkey here (indistinguishable): a calm note, not an error.
      if (kind === 'passkey-cancelled') {
        set({ error: null, field: null });
        setView({ name: 'passkey', cancelled: true, fromHint });
      }
    });
  }

  /**
   * Continue on the email step (register A5a): the passkey prompt only when this browser remembers a
   * passkey sign-in for the address; otherwise "How do you want to sign in?". The hint never leaves
   * the browser, so the server sees the same requests for every address until the person chooses.
   */
  function continueFromEmail() {
    if (!requireEmail()) return;
    if (!passkeysEnabled) return go({ name: 'password', challenge: false });
    const typed = email;
    void driver.hasPasskeyHint(typed).then((hinted) => {
      if (hinted) startPasskey(true);
      else go({ name: 'choose' });
    });
  }

  function sendEmailCode() {
    if (!requireEmail()) return;
    methodRef.current = 'email-code';
    void attempt(firstFactor('email-code', () => driver.requestEmailCode(email), driver.decoyPasskeyPrompt), 'sign-in', STATUS.sendingCode);
  }

  function resendEmailCode() {
    if (!requireEmail()) return;
    void (async () => {
      const kind = await attempt(firstFactor('email-code', () => driver.requestEmailCode(email), driver.decoyPasskeyPrompt), 'sign-in', STATUS.sendingCode);
      if (kind === null) setView((v) => (v.name === 'email-code' ? { ...v, resentAt: Date.now() } : v));
    })();
  }

  function sendResetCode() {
    if (!requireEmail()) return;
    void (async () => {
      const result = await fb.run(() => driver.requestPasswordReset(email), { context: 'reset-password', words, busyStatus: STATUS.sendingCode });
      if (result.ok) {
        setResendReady(false);
        go({ name: 'reset-code' });
      }
    })();
  }

  function backToEmail() {
    set({ error: null, status: null, field: null });
    go({ name: 'email' });
  }

  const busy = fb.busy;
  const title = props.reauth ? SIGN_IN.reauthHeading : SIGN_IN.heading(c);
  const reauthNote = props.reauth ? <Text classNames={classNames}>{SIGN_IN.reauthNote}</Text> : null;
  const summaryField = fb.field === 'email' ? ids.email : fb.field === 'secret' ? ids.password : fb.field === 'code' ? ids.code : fb.field === 'new-password' ? ids.newPassword : undefined;
  const summary = <ErrorSummary error={fb.error} fieldId={summaryField} classNames={classNames} />;
  const heading = (text: ReactNode) => (
    <Heading level={level} classNames={classNames}>
      {text}
    </Heading>
  );

  /**
   * A form's submit, named for the driver (ADR 0025): the props for the `<form>`. A form with nothing to
   * submit (a help screen without a button) gets no name.
   */
  function onSubmit(name: string | null, handler: () => void) {
    const run = (event: FormEvent) => {
      event.preventDefault();
      if (!busy) handler();
    };
    const submit = name === null ? run : driver.act(name, run);
    return { onSubmit: submit, ...tagged(submit) };
  }
  /** A control's handler, named for the driver: itself when live, a report in preview. */
  const act = <A extends unknown[]>(name: string, handler: (...args: A) => void) => driver.act(name, handler);
  const changeEmail = act('change-email', backToEmail);

  const emailField = (
    <Field
      id={ids.email}
      label={SIGN_IN.emailLabel}
      type="email"
      name="username"
      inputMode="email"
      autoCapitalize="none"
      spellCheck={false}
      autoComplete={SIGN_IN_AUTOCOMPLETE.email}
      placeholder={hint}
      value={email}
      onChange={(e) => setEmail(e.target.value)}
      invalid={fb.field === 'email'}
      error={fb.field === 'email' ? fb.error : null}
      inputRef={emailRef}
      classNames={classNames}
    />
  );

  const codeField = (label: string) => (
    <Field
      id={ids.code}
      label={label}
      name="one-time-code"
      inputMode="numeric"
      autoComplete={SIGN_IN_AUTOCOMPLETE.oneTimeCode}
      value={codeValue}
      onChange={(e) => setCodeValue(e.target.value)}
      invalid={fb.field === 'code'}
      error={fb.field === 'code' ? fb.error : null}
      inputRef={secretRef}
      classNames={classNames}
    />
  );

  const usePassword = () => (requireEmail() ? go({ name: 'password', challenge: false }) : undefined);
  const usePasskey = () => requireEmail() && startPasskey();
  const alt = (name: string, icon: AltLink['icon'], label: string, handler: () => void): AltLink => ({ icon, label, onClick: act(name, handler), disabled: busy });
  const passwordAlt = alt('use-password', 'password', SIGN_IN.usePassword, usePassword);
  const passkeyAlt = alt('use-passkey', 'fingerprint', SIGN_IN.usePasskey, usePasskey);
  const codeAlt = alt('send-email-code', 'mail', SIGN_IN.emailCode, sendEmailCode);
  /** Another way in, from the prompt the hint opened: twice in a row forgets the hint (register A5a). */
  const skipped = (name: string, icon: AltLink['icon'], label: string, handler: () => void): AltLink =>
    alt(name, icon, label, () => {
      void driver.passkeyHintSkipped(email);
      handler();
    });

  function accessLine(): ReactNode {
    const line = (children: ReactNode) => <p {...slot(classNames, 'access')}>{children}</p>;
    const requestAccessLink = driver.act('request-access');
    const signUpLink = driver.act('create-account');
    const needAccess = act('need-access', () => go({ name: 'access-help' }));
    switch (accountCreation.mode) {
      case 'request':
        return line(
          <>
            {ACCESS_LINE.newTo(c)}{' '}
            <a href={requestAccessHref} onClick={requestAccessLink} {...tagged(requestAccessLink)} {...slot(classNames, 'link')}>
              {ACCESS_LINE.requestAccess}
            </a>
          </>,
        );
      case 'domains':
      case 'open':
        return line(
          <>
            {ACCESS_LINE.newTo(c)}{' '}
            <a href={signUpHref} onClick={signUpLink} {...tagged(signUpLink)} {...slot(classNames, 'link')}>
              {ACCESS_LINE.createAccount}
            </a>
            {accountCreation.mode === 'domains' ? ACCESS_LINE.withDomains(domainsInWords(accountCreation.domains)) : null}
          </>,
        );
      case 'invite':
        return (props.inviteLine ?? 'link') === 'link'
          ? line(
              <>
                {ACCESS_LINE.inviteOnly(c)}{' '}
                <button type="button" onClick={needAccess} {...tagged(needAccess)} {...slot(classNames, 'linkButton')}>
                  {ACCESS_LINE.needAccess}
                </button>
              </>,
            )
          : line(`${ACCESS_LINE.inviteOnly(c)} ${ACCESS_LINE.askToBeAdded}`);
    }
  }

  let body: ReactNode;
  const bottom: CardBottom = {};
  switch (view.name) {
    case 'email':
      bottom.access = props.reauth ? undefined : accessLine();
      body = (
        <form noValidate {...onSubmit('continue', continueFromEmail)} aria-busy={busy || undefined} {...slot(classNames, 'form')}>
          {summary}
          {heading(title)}
          {reauthNote}
          {emailField}
          <Actions classNames={classNames}>
            <Button type="submit" disabled={busy} classNames={classNames}>
              {SIGN_IN.continue}
            </Button>
          </Actions>
          <AltLinks links={[...(passkeysEnabled ? [passwordAlt] : []), ...(emailCodeEnabled ? [codeAlt] : [])]} classNames={classNames} />
        </form>
      );
      break;
    case 'choose': {
      const wayPasskey = act('use-passkey', () => startPasskey());
      const wayPassword = act('use-password', () => go({ name: 'password', challenge: false }));
      const wayCode = act('send-email-code', sendEmailCode);
      body = (
        <div {...slot(classNames, 'form')}>
          {summary}
          {heading(SIGN_IN.chooseHeading)}
          <Who lead={SIGN_IN.passwordFor} email={email.trim()} onChange={changeEmail} disabled={busy} classNames={classNames} />
          {/* Card Studio's .c-ways: one full-width row per way in, the passkey first, tinted and "(recommended)". */}
          <ul {...slot(classNames, 'ways')}>
            <li {...slot(classNames, 'listItem')}>
              <button type="button" disabled={busy} onClick={wayPasskey} {...tagged(wayPasskey)} data-auth-kit-choice="passkey" data-auth-kit-recommended="" {...slot(classNames, 'way')}>
                <Icon name="fingerprint" />
                <span {...slot(classNames, 'wayText')}>
                  <span {...slot(classNames, 'wayLabel')}>
                    {SIGN_IN.choosePasskey} <span data-auth-kit-recommended-label="">{SIGN_IN.chooseRecommended}</span>
                  </span>{' '}
                  <span {...slot(classNames, 'wayDescription')}>{SIGN_IN.choosePasskeySub}</span>
                </span>
                <Icon name="chevron" />
              </button>
            </li>
            <li {...slot(classNames, 'listItem')}>
              <button type="button" disabled={busy} onClick={wayPassword} {...tagged(wayPassword)} data-auth-kit-choice="password" {...slot(classNames, 'way')}>
                <Icon name="password" />
                <span {...slot(classNames, 'wayText')}>
                  <span {...slot(classNames, 'wayLabel')}>{SIGN_IN.choosePassword}</span>
                </span>
                <Icon name="chevron" />
              </button>
            </li>
            {emailCodeEnabled ? (
              <li {...slot(classNames, 'listItem')}>
                <button type="button" disabled={busy} onClick={wayCode} {...tagged(wayCode)} data-auth-kit-choice="email-code" {...slot(classNames, 'way')}>
                  <Icon name="mail" />
                  <span {...slot(classNames, 'wayText')}>
                    <span {...slot(classNames, 'wayLabel')}>{SIGN_IN.chooseCode}</span>
                  </span>
                  <Icon name="chevron" />
                </button>
              </li>
            ) : null}
          </ul>
        </div>
      );
      break;
    }
    case 'passkey':
      body = (
        <div {...slot(classNames, 'form')}>
          {summary}
          {heading(SIGN_IN.passkeyHeading)}
          <Text classNames={classNames}>{SIGN_IN.passkeySub}</Text>
          <Who lead={SIGN_IN.signingInAs} email={email.trim()} onChange={changeEmail} disabled={busy} classNames={classNames} />
          {view.cancelled ? <Note classNames={classNames}>{ERRORS.passkeyCancelled}</Note> : fb.error ? null : <Wait label={SIGN_IN.waitingForPasskey} classNames={classNames} />}
          <Actions classNames={classNames}>
            <Button variant="secondary" disabled={busy} classNames={classNames} onClick={act('try-again', () => startPasskey(view.fromHint === true))}>
              {SIGN_IN.tryAgain}
            </Button>
          </Actions>
          <Text classNames={classNames}>{SIGN_IN.passkeyOnPhone}</Text>
          <AltLinks
            links={
              view.fromHint
                ? [skipped('use-password', 'password', SIGN_IN.usePassword, usePassword), ...(emailCodeEnabled ? [skipped('send-email-code', 'mail', SIGN_IN.emailCode, sendEmailCode)] : [])]
                : [passwordAlt, ...(emailCodeEnabled ? [codeAlt] : [])]
            }
            classNames={classNames}
          />
        </div>
      );
      break;
    case 'password':
      body = (
        <form
          noValidate
          {...onSubmit('submit-password', () => {
            if (!requireEmail()) return;
            if (secretValue === '') {
              set({ error: ERRORS.emptyPassword, field: 'secret', status: null });
              secretRef.current?.focus();
              return;
            }
            if (!view.challenge) methodRef.current = 'password';
            void attempt(
              view.challenge ? () => driver.confirmPassword(secretValue) : firstFactor('password', () => driver.signInWithPassword(email, secretValue), driver.decoyPasskeyPrompt),
              'sign-in',
              STATUS.signingIn,
            );
          })}
          aria-busy={busy || undefined}
          {...slot(classNames, 'form')}
        >
          {summary}
          {heading(SIGN_IN.passwordHeading)}
          <Who lead={SIGN_IN.passwordFor} email={email.trim()} onChange={changeEmail} disabled={busy} classNames={classNames} />
          <HiddenUsername email={email.trim()} />
          <PasswordField
            id={ids.password}
            label={SIGN_IN.passwordLabel}
            name="current-password"
            autoComplete={SIGN_IN_AUTOCOMPLETE.currentPassword}
            value={secretValue}
            onChange={(e) => setSecretValue(e.target.value)}
            invalid={fb.field === 'secret'}
            error={fb.field === 'secret' ? fb.error : null}
            inputRef={secretRef}
            classNames={classNames}
          />
          <p {...slot(classNames, 'text')}>
            <Button variant="link" classNames={classNames} disabled={busy} onClick={act('forgot-password', () => go({ name: 'help', topic: 'password' }))}>
              {SIGN_IN.forgotPassword}
            </Button>
          </p>
          <Actions classNames={classNames}>
            <Button type="submit" disabled={busy} classNames={classNames}>
              {SIGN_IN.continue}
            </Button>
          </Actions>
          <AltLinks links={[...(passkeysEnabled ? [passkeyAlt] : []), ...(emailCodeEnabled ? [codeAlt] : [])]} classNames={classNames} />
        </form>
      );
      break;
    case 'totp':
      body = (
        <form
          noValidate
          {...onSubmit('submit-totp', () => {
            if (!/^\d{6}$/.test(normalizeCode(codeValue))) {
              set({ error: ERRORS.totpTooShort, field: 'code', status: null });
              secretRef.current?.focus();
              return;
            }
            void attempt(() => driver.confirmCode(codeValue), 'totp', STATUS.checkingCode);
          })}
          aria-busy={busy || undefined}
          {...slot(classNames, 'form')}
        >
          {summary}
          {heading(SIGN_IN.totpHeading)}
          <Text classNames={classNames}>{SIGN_IN.totpSub(c)}</Text>
          {codeField(SIGN_IN.totpLabel)}
          <Actions classNames={classNames}>
            <Button type="submit" disabled={busy} classNames={classNames}>
              {SIGN_IN.signIn}
            </Button>
          </Actions>
          <p {...slot(classNames, 'text')}>
            <Button variant="link" classNames={classNames} disabled={busy} onClick={act('lost-authenticator', () => go({ name: 'help', topic: 'totp' }))}>
              {SIGN_IN.lostAuthenticator}
            </Button>
          </p>
        </form>
      );
      break;
    case 'email-code':
      body = view.expired ? (
        <div {...slot(classNames, 'form')}>
          <ErrorSummary error={ERRORS.sessionExpired(c)} classNames={classNames} />
          {heading(SIGN_IN.codeHeading)}
          <Text classNames={classNames}>{SIGN_IN.codeSub(c, email.trim())}</Text>
          <Actions classNames={classNames}>
            <Button classNames={classNames} onClick={act('start-again', backToEmail)}>
              {SIGN_IN.startAgain}
            </Button>
          </Actions>
        </div>
      ) : (
        <form
          noValidate
          {...onSubmit('submit-code', () => {
            if (!/^\d{8}$/.test(normalizeCode(codeValue))) {
              set({ error: ERRORS.codeTooShort, field: 'code', status: null });
              secretRef.current?.focus();
              return;
            }
            const sentAt = view.resentAt ?? view.sentAt;
            void attempt(() => (view.simulated ? answerSimulatedCode(sentAt, { lifetimeMs: lifetime * 60_000 }) : driver.confirmCode(codeValue)), 'code', STATUS.checkingCode);
          })}
          aria-busy={busy || undefined}
          {...slot(classNames, 'form')}
        >
          {summary}
          {heading(SIGN_IN.codeHeading)}
          {/* The typed address, never Cognito's masked one (an unknown address has none to show). */}
          <Text classNames={classNames}>{SIGN_IN.codeSub(c, email.trim())}</Text>
          {view.resentAt !== undefined ? (
            <Note icon="mail" classNames={classNames}>
              {SIGN_IN.codeResent(clockTime(view.resentAt))}
            </Note>
          ) : null}
          {codeField(SIGN_IN.codeLabel)}
          <Actions classNames={classNames}>
            <Button type="submit" disabled={busy} classNames={classNames}>
              {SIGN_IN.signIn}
            </Button>
          </Actions>
          <AltLinks
            links={[
              { icon: 'refresh', label: SIGN_IN.sendNewCode, onClick: act('resend-code', resendEmailCode), disabled: busy || !resendReady },
              { icon: 'back', label: SIGN_IN.differentEmail, onClick: act('different-email', backToEmail), disabled: busy },
            ]}
            classNames={classNames}
          />
          <Text classNames={classNames}>{SIGN_IN.codeHelp}</Text>
        </form>
      );
      break;
    case 'new-password':
      body = (
        <form
          noValidate
          {...onSubmit('submit-new-password', () => {
            const problem = newPasswordProblem(secretValue);
            if (problem) {
              set({ error: problem, field: 'new-password', status: null });
              secretRef.current?.focus();
              return;
            }
            void (async () => {
              set({ busy: true, error: null, status: STATUS.checkingPassword });
              const breached = await driver.breachedPasswordProblem(secretValue, props.checkBreachedPassword);
              set({ busy: false, status: null });
              if (breached) {
                set({ error: breached, field: 'new-password' });
                return;
              }
              await attempt(() => driver.completeNewPassword(secretValue), 'set-password', STATUS.saving);
            })();
          })}
          aria-busy={busy || undefined}
          {...slot(classNames, 'form')}
        >
          {summary}
          {heading(SIGN_IN.newPasswordHeading)}
          <Text classNames={classNames}>{SIGN_IN.newPasswordIntro}</Text>
          <HiddenUsername email={email.trim()} />
          <PasswordField
            id={ids.newPassword}
            label={FIRST_VISIT.newPasswordLabel}
            hint={FIRST_VISIT.createPasswordSub}
            name="new-password"
            autoComplete={SIGN_IN_AUTOCOMPLETE.newPassword}
            minLength={15}
            value={secretValue}
            onChange={(e) => setSecretValue(e.target.value)}
            invalid={fb.field === 'new-password'}
            error={fb.field === 'new-password' ? fb.error : null}
            inputRef={secretRef}
            classNames={classNames}
          />
          <Actions classNames={classNames}>
            <Button type="submit" disabled={busy} classNames={classNames}>
              {SIGN_IN.continue}
            </Button>
          </Actions>
        </form>
      );
      break;
    case 'totp-setup':
      body = (
        <AuthenticatorSetup
          issuer={siteName}
          accountName={email.trim()}
          intro={FIRST_VISIT.addTotpRequired}
          headingLevel={level}
          enrollment={{
            secret: view.secret,
            verify: async (code) => {
              const step = await driver.confirmCode(code);
              handleStep(step);
            },
          }}
          onCancel={act('start-again', backToEmail)}
          cancelLabel={SIGN_IN.startAgain}
          {...(props.renderQrCode && { renderQrCode: props.renderQrCode })}
          classNames={classNames}
        />
      );
      break;
    case 'reset-code':
      body = (
        <form
          noValidate
          {...onSubmit('submit-reset-code', () => {
            const code = normalizeCode(codeValue);
            if (code === '') {
              set({ error: ERRORS.resetCodeEmpty, field: 'code', status: null });
              secretRef.current?.focus();
              return;
            }
            go({ name: 'reset-password', code });
          })}
          aria-busy={busy || undefined}
          {...slot(classNames, 'form')}
        >
          {summary}
          {heading(SIGN_IN.resetCodeHeading)}
          <Text classNames={classNames}>{SIGN_IN.resetCodeSub(email.trim())}</Text>
          {codeField(SIGN_IN.resetCodeLabel)}
          <Actions classNames={classNames}>
            <Button type="submit" disabled={busy} classNames={classNames}>
              {SIGN_IN.continue}
            </Button>
          </Actions>
          <AltLinks
            links={[
              { icon: 'refresh', label: SIGN_IN.sendNewCode, onClick: act('resend-reset-code', sendResetCode), disabled: busy || !resendReady },
              { icon: 'back', label: SIGN_IN.differentEmail, onClick: act('different-email', backToEmail), disabled: busy },
            ]}
            classNames={classNames}
          />
        </form>
      );
      break;
    case 'reset-password':
      body = (
        <form
          noValidate
          {...onSubmit('submit-new-password', () => {
            const problem = newPasswordProblem(secretValue);
            if (problem) {
              set({ error: problem, field: 'new-password', status: null });
              return;
            }
            const password = secretValue;
            void (async () => {
              set({ busy: true, error: null, status: STATUS.checkingPassword });
              const breached = await driver.breachedPasswordProblem(password, props.checkBreachedPassword);
              set({ busy: false, status: null });
              if (breached) {
                set({ error: breached, field: 'new-password' });
                return;
              }
              const failed: { kind?: AuthErrorKind } = {};
              const result = await fb.run(() => driver.confirmPasswordReset(email, view.code, password), {
                context: 'reset-password',
                words,
                busyStatus: STATUS.saving,
                onError: (info) => {
                  failed.kind = info.kind;
                },
              });
              if (!result.ok) {
                // A wrong or old code: back to the code, with the message.
                if (failed.kind === 'wrong-code' || failed.kind === 'expired-code') {
                  go({ name: 'reset-code' }, { error: true });
                  set({ field: 'code' });
                }
                return;
              }
              // The new password signs them straight in; the authenticator code comes next, as usual. Once
              // they're in, the account gets the "password changed" notice (register A10).
              pendingNotice.current = 'password-changed';
              await attempt(firstFactor('password', () => driver.signInWithPassword(email, password), driver.decoyPasskeyPrompt), 'sign-in', STATUS.signingIn);
            })();
          })}
          aria-busy={busy || undefined}
          {...slot(classNames, 'form')}
        >
          {summary}
          {heading(SIGN_IN.newPasswordHeading)}
          <Text classNames={classNames}>{FIRST_VISIT.createPasswordSub}</Text>
          <HiddenUsername email={email.trim()} />
          <PasswordField
            id={ids.newPassword}
            label={FIRST_VISIT.newPasswordLabel}
            name="new-password"
            autoComplete={SIGN_IN_AUTOCOMPLETE.newPassword}
            minLength={15}
            value={secretValue}
            onChange={(e) => setSecretValue(e.target.value)}
            invalid={fb.field === 'new-password'}
            error={fb.field === 'new-password' ? fb.error : null}
            inputRef={secretRef}
            classNames={classNames}
          />
          <Actions classNames={classNames}>
            <Button type="submit" disabled={busy} classNames={classNames}>
              {SIGN_IN.continue}
            </Button>
          </Actions>
          <Text classNames={classNames}>{SIGN_IN.resetAfter}</Text>
        </form>
      );
      break;
    case 'finishing':
      body = heading(SIGN_IN.finishing);
      break;
    case 'check-failed':
      body = (
        <div {...slot(classNames, 'form')}>
          {heading(title)}
          <Note classNames={classNames}>{SIGN_IN.checkFailed(c)}</Note>
          <Actions classNames={classNames}>
            <Button classNames={classNames} disabled={busy} onClick={act('try-again', () => void afterSignIn())}>
              {SIGN_IN.tryAgain}
            </Button>
          </Actions>
        </div>
      );
      break;
    case 'enroll-authenticator':
      body = (
        <AuthenticatorSetup
          issuer={siteName}
          accountName={email.trim()}
          intro={FIRST_VISIT.addTotpAfterPassword}
          headingLevel={level}
          onDone={() => void afterSignIn()}
          {...(props.renderQrCode && { renderQrCode: props.renderQrCode })}
          classNames={classNames}
        />
      );
      break;
    case 'first-credential':
      body = (
        <ChooseFirstCredential
          passkeysEnabled={passkeysEnabled}
          issuer={siteName}
          accountName={email.trim()}
          headingLevel={level}
          onDone={(how) => {
            // ChooseFirstCredential has already set the passkey hint for accountName (register A5a).
            void driver.sendAccountNotice(notices, how === 'password' ? 'password-changed' : 'passkey-added').then((emailed) => go({ name: 'done', how, emailed }));
          }}
          {...(props.renderQrCode && { renderQrCode: props.renderQrCode })}
          {...(props.checkBreachedPassword !== undefined && { checkBreachedPassword: props.checkBreachedPassword })}
          classNames={classNames}
        />
      );
      break;
    case 'done':
      body = (
        <div {...slot(classNames, 'form')}>
          <Glyph classNames={classNames} />
          {heading(FIRST_VISIT.doneHeading)}
          <Text classNames={classNames}>
            {view.how === 'password' ? FIRST_VISIT.donePassword : FIRST_VISIT.donePasskey(c)}
            {view.emailed ? ` ${FIRST_VISIT.emailedNote}` : ''}
          </Text>
          <Actions classNames={classNames}>
            <Button classNames={classNames} onClick={act('continue-to-site', finish)}>
              {FIRST_VISIT.continueTo(c)}
            </Button>
          </Actions>
        </div>
      );
      break;
    case 'offer-passkey':
      body = (
        <div {...slot(classNames, 'form')}>
          {summary}
          {heading(SIGN_IN.offerPasskeyHeading)}
          <Text classNames={classNames}>{SIGN_IN.offerPasskeySub}</Text>
          <Actions classNames={classNames}>
            <Button
              classNames={classNames}
              disabled={busy}
              onClick={act('create-passkey', () =>
                void fb.run(driver.registerPasskey, { context: 'passkey-register', words, busyStatus: FIRST_VISIT.waitingForDevice }).then(async (r) => {
                  if (r.ok) {
                    set({ status: STATUS.passkeySaved });
                    await driver.rememberPasskey(email);
                    await driver.sendAccountNotice(notices, 'passkey-added');
                    finish();
                  }
                }),
              )}
            >
              {FIRST_VISIT.createPasskey}
            </Button>
            <Button
              variant="link"
              classNames={classNames}
              disabled={busy}
              onClick={act('not-now', () => {
                driver.dismissPasskeyOffer(userIdRef.current);
                finish();
              })}
            >
              {SIGN_IN.notNow}
            </Button>
          </Actions>
        </div>
      );
      break;
    case 'trouble':
      bottom.back = { label: SIGN_IN.backToSignIn, onClick: act('back-to-sign-in', backToEmail) };
      body = (
        <div {...slot(classNames, 'form')}>
          {heading(TROUBLE.heading)}
          <Text classNames={classNames}>{TROUBLE.sub}</Text>
          <ul {...slot(classNames, 'list')}>
            {TROUBLE.rows.map(([topic, label]) => {
              const open = act(`help-${topic}`, () => go({ name: 'help', topic, askEmail: !looksLikeEmail(email) }));
              return (
                <li key={topic} {...slot(classNames, 'listItem')}>
                  <button type="button" onClick={open} {...tagged(open)} {...slot(classNames, 'secondaryButton')}>
                    <span>{label}</span>
                    <Icon name="chevron" />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      );
      break;
    case 'help': {
      bottom.back = { label: SIGN_IN.back, onClick: act('back', () => go({ name: 'trouble' })) };
      // The promise ahead of time only where the site says it mounted the notice route (L5; ADR 0024).
      const screen = helpScreen(view.topic, c, { securityNotices: notices?.mounted === true });
      const contact = contactLines(c, { teams: screen.teams === true });
      const action = screen.button;
      const runAction = () => {
        if (!action) return;
        if (action.action === 'reset-code') sendResetCode();
        else sendEmailCode();
      };
      // The button needs the address: ask for it here when it wasn't typed yet. Decided when the screen
      // opens, not from what's typed now, or the field would vanish as soon as the text looked like an address.
      const needsEmail = action !== undefined && view.askEmail === true && (action.action !== 'email-code' || emailCodeEnabled);
      body = (
        <form noValidate {...onSubmit(action ? HELP_ACTION[action.action] : null, runAction)} aria-busy={busy || undefined} {...slot(classNames, 'form')}>
          {summary}
          {heading(screen.heading)}
          {screen.intro ? <Text classNames={classNames}>{screen.intro}</Text> : null}
          {screen.steps ? <Steps steps={screen.steps} classNames={classNames} /> : null}
          {screen.after ? <Text classNames={classNames}>{screen.after}</Text> : null}
          {action && (action.action === 'reset-code' || emailCodeEnabled) ? (
            <>
              {needsEmail ? emailField : null}
              <Actions classNames={classNames}>
                <Button type="submit" disabled={busy || (action.action === 'resend-code' && !resendReady)} classNames={classNames}>
                  {action.label}
                </Button>
              </Actions>
            </>
          ) : null}
          <ContactBox lead={contact.lead} address={contact.address} lines={contact.lines} classNames={classNames} />
        </form>
      );
      break;
    }
    case 'access-help': {
      bottom.back = { label: SIGN_IN.backToSignIn, onClick: act('back-to-sign-in', backToEmail) };
      const named = CONTACT.looksAfter(c);
      const mail = driver.act('email-help');
      body = (
        <div {...slot(classNames, 'form')}>
          {heading(ACCESS_HELP.heading(c))}
          <Text classNames={classNames}>{ACCESS_HELP.sub(c)}</Text>
          <Text classNames={classNames}>{ACCESS_HELP.alreadyInvited(c)}</Text>
          <div {...slot(classNames, 'contact')}>
            <p>
              <strong>{ACCESS_HELP.askLead}</strong>
            </p>
            <p>
              {CONTACT.email}{' '}
              <a href={`mailto:${props.help.address}`} onClick={mail} {...tagged(mail)} {...slot(classNames, 'link')}>
                {props.help.address}
              </a>
              .{named ? ` ${named}` : ''}
            </p>
            <p>{CONTACT.neverSend}</p>
          </div>
        </div>
      );
      break;
    }
  }

  const troubleHere = TROUBLE_VIEWS.has(view.name);
  const openTrouble = act('trouble', () => go({ name: 'trouble' }));
  if (troubleHere && (props.troubleLink ?? 'inside') === 'inside') bottom.trouble = openTrouble;
  return (
    <Card
      name="sign-in"
      siteName={siteName}
      view={view.name}
      theme={theme}
      bottom={bottom}
      troubleBelow={troubleHere && props.troubleLink === 'below' ? openTrouble : null}
      rootRef={rootRef}
      {...(props.className !== undefined && { className: props.className })}
      classNames={classNames}
    >
      {body}
      <StatusRegion classNames={classNames} status={fb.status} />
    </Card>
  );
}
