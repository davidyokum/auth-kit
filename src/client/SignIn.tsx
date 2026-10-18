import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { safeRedirect } from '../server/redirect.js';
import { type AccountCreationSettings, normalizeAccountCreation } from '../shared/account-creation.js';
import { codeLifetimeMinutes as checkedLifetime } from '../shared/policy.js';
import { type AuthTheme, type ThemeFamily, resolveTheme } from '../themes/index.js';
import {
  completeNewPassword,
  confirmCode,
  confirmPassword,
  confirmPasswordReset,
  currentUser,
  fetchAuthFactors,
  registerPasskey,
  requestEmailCode,
  requestPasswordReset,
  signInWithPasskey,
  signInWithPassword,
} from './api.js';
import { AuthenticatorSetup } from './AuthenticatorSetup.js';
import { ChooseFirstCredential, type FirstCredential } from './ChooseFirstCredential.js';
import { ACCESS_HELP, ACCESS_LINE, type CopyContext, ERRORS, FIRST_VISIT, type HelpTopic, SIGN_IN, TROUBLE, contactLines, helpScreen } from './copy.js';
import { Icon } from './icons.js';
import { type ClientAuthFactors, SIGN_IN_AUTOCOMPLETE, type SignInMethod, afterSignInStep, newPasswordProblem, normalizeCode } from './ladder.js';
import type { AuthErrorContext, AuthErrorInfo, AuthErrorKind, MessageWords } from './messages.js';
import { answerSimulatedCode, decoyPasskeyPrompt, isFirstFactorUnavailable } from './parity.js';
import { type PasswordCheckOptions, breachedPasswordProblem } from './PasswordForm.js';
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
  /** Offer "Email me a code instead". Default true; admin pools have no emailed codes. */
  emailCodeEnabled?: boolean;
  /** How the site creates accounts (the card's line; register D1). Default invite only. */
  accountCreation?: AccountCreationSettings;
  /** The invite-only line: a "Need access?" link to who to ask (default), or the plain sentence. */
  inviteLine?: 'sentence' | 'link';
  /** "Trouble signing in?" inside the card (default) or just below it (register E5, Proposed). */
  troubleLink?: 'inside' | 'below';
  /** How long an emailed code works, in minutes: the same value as the preset's (register A7). Default 3. */
  codeLifetimeMinutes?: number;
  /** Where "Create an account" goes. Default `/sign-up`. */
  signUpHref?: string;
  /** Where "Need access? Request it." goes. Default `/request-access`. */
  requestAccessHref?: string;
  /**
   * The site emails security notices (a passkey added, a password changed; REPORT §5.2f), so the
   * screens may say "We've emailed you a note about this." Default false: auth-kit doesn't send them yet.
   */
  securityNotices?: boolean;
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

type View =
  | { name: 'email' }
  | { name: 'passkey'; cancelled: boolean }
  | { name: 'password'; challenge: boolean }
  /** "Check your email". `simulated`: nothing was sent (no account, or no emailed codes for it); the screen is the same. */
  | { name: 'email-code'; simulated: boolean; sentAt: number; resentAt?: number; expired?: boolean }
  | { name: 'totp' }
  | { name: 'new-password' }
  | { name: 'totp-setup'; secret: string }
  | { name: 'reset-code' }
  | { name: 'reset-password'; code: string }
  | { name: 'finishing' }
  | { name: 'enroll-authenticator' }
  | { name: 'first-credential' }
  | { name: 'done'; how: FirstCredential }
  | { name: 'offer-passkey' }
  | { name: 'trouble' }
  /** `askEmail`: the address wasn't typed when the screen opened, so its action asks for it (and keeps asking while it's typed). */
  | { name: 'help'; topic: HelpTopic; askEmail?: boolean }
  | { name: 'access-help' };

const RESEND_COOLDOWN_MS = 30_000;
const OFFER_KEY = 'auth-kit:passkey-offer-dismissed:';

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
 * when Cognito says this account can't use that factor (or offers a choice of others), the screens get
 * what an unknown address gets: a passkey prompt that finds nothing, a password that doesn't match, or
 * "check your email" with nothing sent. Cognito's list of the account's other factors is never shown.
 */
function firstFactor(method: SignInMethod, request: () => Promise<SignInStep>): () => Promise<ScreenStep> {
  return async () => {
    const step = await request();
    if (!isFirstFactorUnavailable(method, step)) return step;
    switch (method) {
      case 'passkey':
        return decoyPasskeyPrompt();
      case 'password':
        throw passwordRefused();
      case 'email-code':
        return { step: 'email-code-simulated' };
    }
  };
}

function offerDismissed(userId: string | undefined): boolean {
  if (!userId) return false;
  try {
    return window.localStorage.getItem(OFFER_KEY + userId) === '1';
  } catch {
    return false;
  }
}

function dismissOffer(userId: string | undefined): void {
  if (!userId) return;
  try {
    window.localStorage.setItem(OFFER_KEY + userId, '1');
  } catch {
    // Private mode or blocked storage: the offer may show again next time.
  }
}

function looksLikeEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function clockTime(at: number): string {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date(at));
}

/** The views that carry "Trouble signing in?" (Card Studio: every sign-in screen, not setup or help). */
const TROUBLE_VIEWS = new Set<View['name']>(['email', 'passkey', 'password', 'totp', 'email-code', 'reset-code', 'reset-password']);

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
  const theme = useMemo(() => resolveTheme(props.theme), [props.theme]);
  const lifetime = checkedLifetime(props.codeLifetimeMinutes, 'SignIn codeLifetimeMinutes');
  const accountCreation = useMemo(() => normalizeAccountCreation(props.accountCreation, 'SignIn accountCreation'), [props.accountCreation]);
  const c: CopyContext = {
    siteName,
    theme,
    codeLifetimeMinutes: lifetime,
    helpAddress: props.help.address,
    ...(props.help.owner !== undefined && { ownerName: props.help.owner }),
  };
  const words: MessageWords = { siteName, codeLifetimeMinutes: lifetime, helpAddress: props.help.address };
  const emailCodeEnabled = props.emailCodeEnabled ?? true;
  const level = props.headingLevel ?? 1;
  const hint = props.emailHint?.trim() || theme.emailHint;
  const uid = useId();
  const ids = { email: `${uid}-email`, password: `${uid}-password`, code: `${uid}-code`, newPassword: `${uid}-new-password` };
  const rootRef = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const secretRef = useRef<HTMLInputElement>(null);
  const fb = useFeedback();
  const { set } = fb;
  const [view, setView] = useState<View>({ name: 'email' });
  const [email, setEmail] = useState('');
  const [secretValue, setSecretValue] = useState('');
  const [codeValue, setCodeValue] = useState('');
  const [resendReady, setResendReady] = useState(true);
  const userIdRef = useRef<string | undefined>(undefined);
  useFocusOnViewChange(rootRef, view.name);

  // Step-up: prefill the email of whoever is signed in on this device.
  useEffect(() => {
    if (!props.reauth) return;
    let active = true;
    void currentUser().then((user) => {
      const loginId = user?.loginId;
      if (active && loginId) setEmail((e) => e || loginId);
    });
    return () => {
      active = false;
    };
  }, [props.reauth]);

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
    (props.navigate ?? ((path: string) => window.location.assign(path)))(target);
  }, [props.next, props.defaultNext, props.allowedRedirectPrefixes, props.navigate]);

  /** After Cognito says DONE: decide what else this person needs before entering the site. */
  const afterSignIn = useCallback(async () => {
    go({ name: 'finishing' });
    set({ status: SIGN_IN.signedInOneMoment, error: null });
    userIdRef.current = (await currentUser())?.userId;
    let factors: ClientAuthFactors | null = null;
    try {
      factors = await (props.loadFactors ?? fetchAuthFactors)();
    } catch {
      // The server enforces the authenticator rule on every request, so continuing is safe.
    }
    if (!factors) return finish();
    switch (afterSignInStep(factors, { passkeysEnabled })) {
      case 'set-up-authenticator':
        set({ status: null });
        return go({ name: 'enroll-authenticator' });
      case 'choose-first-credential':
        set({ status: null });
        return go({ name: 'first-credential' });
      case 'offer-passkey':
        if (props.reauth || offerDismissed(userIdRef.current)) return finish();
        set({ status: null });
        return go({ name: 'offer-passkey' });
      case 'done':
        return finish();
    }
  }, [finish, go, passkeysEnabled, props.loadFactors, props.reauth, set]);

  /** Shows the screen for the step Cognito returned. */
  const handleStep = useCallback(
    (step: ScreenStep) => {
      switch (step.step) {
        case 'done':
          return void afterSignIn();
        case 'choose-method':
          // Never shown: a first-factor request maps it to that factor's own outcome (firstFactor).
          set({ error: 'That way of signing in isn’t available here. Use another way below.' });
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
          set({ status: 'You need to choose a new password before signing in. We can email you a code to do that.' });
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

  function startPasskey() {
    go({ name: 'passkey', cancelled: false });
    void attempt(firstFactor('passkey', () => signInWithPasskey(email)), 'sign-in').then((kind) => {
      // A closed window, or no passkey here (indistinguishable): a calm note, not an error.
      if (kind === 'passkey-cancelled') {
        set({ error: null, field: null });
        setView({ name: 'passkey', cancelled: true });
      }
    });
  }

  function sendEmailCode() {
    if (!requireEmail()) return;
    void attempt(firstFactor('email-code', () => requestEmailCode(email)), 'sign-in', 'Sending a code…');
  }

  function resendEmailCode() {
    if (!requireEmail()) return;
    void (async () => {
      const kind = await attempt(firstFactor('email-code', () => requestEmailCode(email)), 'sign-in', 'Sending a code…');
      if (kind === null) setView((v) => (v.name === 'email-code' ? { ...v, resentAt: Date.now() } : v));
    })();
  }

  function sendResetCode() {
    if (!requireEmail()) return;
    void (async () => {
      const result = await fb.run(() => requestPasswordReset(email), { context: 'reset-password', words, busyStatus: 'Sending a code…' });
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

  function onSubmit(handler: () => void) {
    return (event: FormEvent) => {
      event.preventDefault();
      if (!busy) handler();
    };
  }

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

  const passwordAlt: AltLink = { icon: 'password', label: SIGN_IN.usePassword, onClick: () => (requireEmail() ? go({ name: 'password', challenge: false }) : undefined), disabled: busy };
  const passkeyAlt: AltLink = { icon: 'fingerprint', label: SIGN_IN.usePasskey, onClick: () => requireEmail() && startPasskey(), disabled: busy };
  const codeAlt: AltLink = { icon: 'mail', label: SIGN_IN.emailCode, onClick: sendEmailCode, disabled: busy };

  function accessLine(): ReactNode {
    const line = (children: ReactNode) => <p {...slot(classNames, 'access')}>{children}</p>;
    switch (accountCreation.mode) {
      case 'request':
        return line(
          <a href={props.requestAccessHref ?? '/request-access'} {...slot(classNames, 'link')}>
            {ACCESS_LINE.request}
          </a>,
        );
      case 'domains':
      case 'open':
        return line(
          <>
            {ACCESS_LINE.newHere}{' '}
            <a href={props.signUpHref ?? '/sign-up'} {...slot(classNames, 'link')}>
              {ACCESS_LINE.createAccount}
            </a>
          </>,
        );
      case 'invite':
        return (props.inviteLine ?? 'link') === 'link'
          ? line(
              <>
                {ACCESS_LINE.inviteOnly(c)}{' '}
                <button type="button" onClick={() => go({ name: 'access-help' })} {...slot(classNames, 'linkButton')}>
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
      bottom.notice = true;
      body = (
        <form noValidate onSubmit={onSubmit(() => requireEmail() && (passkeysEnabled ? startPasskey() : go({ name: 'password', challenge: false })))} aria-busy={busy || undefined} {...slot(classNames, 'form')}>
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
    case 'passkey':
      body = (
        <div {...slot(classNames, 'form')}>
          {summary}
          {heading(SIGN_IN.passkeyHeading)}
          <Text classNames={classNames}>{SIGN_IN.passkeySub}</Text>
          <Who lead={SIGN_IN.signingInAs} email={email.trim()} onChange={backToEmail} disabled={busy} classNames={classNames} />
          {view.cancelled ? <Note classNames={classNames}>{ERRORS.passkeyCancelled}</Note> : fb.error ? null : <Wait label={SIGN_IN.waitingForPasskey} classNames={classNames} />}
          <Actions classNames={classNames}>
            <Button variant="secondary" disabled={busy} classNames={classNames} onClick={startPasskey}>
              {SIGN_IN.tryAgain}
            </Button>
          </Actions>
          <Text classNames={classNames}>{SIGN_IN.passkeyOnPhone}</Text>
          <AltLinks links={[passwordAlt, ...(emailCodeEnabled ? [codeAlt] : [])]} classNames={classNames} />
        </div>
      );
      break;
    case 'password':
      body = (
        <form
          noValidate
          onSubmit={onSubmit(() => {
            if (!requireEmail()) return;
            if (secretValue === '') {
              set({ error: ERRORS.emptyPassword, field: 'secret', status: null });
              secretRef.current?.focus();
              return;
            }
            void attempt(view.challenge ? () => confirmPassword(secretValue) : firstFactor('password', () => signInWithPassword(email, secretValue)), 'sign-in', 'Signing in…');
          })}
          aria-busy={busy || undefined}
          {...slot(classNames, 'form')}
        >
          {summary}
          {heading(SIGN_IN.passwordHeading)}
          <Who lead={SIGN_IN.passwordFor} email={email.trim()} onChange={backToEmail} disabled={busy} classNames={classNames} />
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
            <Button variant="link" classNames={classNames} disabled={busy} onClick={() => go({ name: 'help', topic: 'password' })}>
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
          onSubmit={onSubmit(() => {
            if (!/^\d{6}$/.test(normalizeCode(codeValue))) {
              set({ error: ERRORS.totpTooShort, field: 'code', status: null });
              secretRef.current?.focus();
              return;
            }
            void attempt(() => confirmCode(codeValue), 'totp', 'Checking the code…');
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
            <Button variant="link" classNames={classNames} disabled={busy} onClick={() => go({ name: 'help', topic: 'totp' })}>
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
            <Button classNames={classNames} onClick={backToEmail}>
              {SIGN_IN.startAgain}
            </Button>
          </Actions>
        </div>
      ) : (
        <form
          noValidate
          onSubmit={onSubmit(() => {
            if (!/^\d{8}$/.test(normalizeCode(codeValue))) {
              set({ error: ERRORS.codeTooShort, field: 'code', status: null });
              secretRef.current?.focus();
              return;
            }
            const sentAt = view.resentAt ?? view.sentAt;
            void attempt(() => (view.simulated ? answerSimulatedCode(sentAt, { lifetimeMs: lifetime * 60_000 }) : confirmCode(codeValue)), 'code', 'Checking the code…');
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
              { icon: 'refresh', label: SIGN_IN.sendNewCode, onClick: resendEmailCode, disabled: busy || !resendReady },
              { icon: 'back', label: SIGN_IN.differentEmail, onClick: backToEmail, disabled: busy },
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
          onSubmit={onSubmit(() => {
            const problem = newPasswordProblem(secretValue);
            if (problem) {
              set({ error: problem, field: 'new-password', status: null });
              rootRef.current?.querySelector<HTMLInputElement>(`#${CSS.escape(ids.newPassword)}`)?.focus();
              return;
            }
            void (async () => {
              set({ busy: true, error: null, status: 'Checking the password…' });
              const breached = await breachedPasswordProblem(secretValue, props.checkBreachedPassword);
              set({ busy: false, status: null });
              if (breached) {
                set({ error: breached, field: 'new-password' });
                return;
              }
              await attempt(() => completeNewPassword(secretValue), 'set-password', 'Saving…');
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
          intro="This account needs an authenticator app. Add it now to finish signing in."
          headingLevel={level}
          enrollment={{
            secret: view.secret,
            verify: async (code) => {
              const step = await confirmCode(code);
              handleStep(step);
            },
          }}
          onCancel={backToEmail}
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
          onSubmit={onSubmit(() => {
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
              { icon: 'refresh', label: SIGN_IN.sendNewCode, onClick: sendResetCode, disabled: busy || !resendReady },
              { icon: 'back', label: SIGN_IN.differentEmail, onClick: backToEmail, disabled: busy },
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
          onSubmit={onSubmit(() => {
            const problem = newPasswordProblem(secretValue);
            if (problem) {
              set({ error: problem, field: 'new-password', status: null });
              return;
            }
            const password = secretValue;
            void (async () => {
              set({ busy: true, error: null, status: 'Checking the password…' });
              const breached = await breachedPasswordProblem(password, props.checkBreachedPassword);
              set({ busy: false, status: null });
              if (breached) {
                set({ error: breached, field: 'new-password' });
                return;
              }
              const failed: { kind?: AuthErrorKind } = {};
              const result = await fb.run(() => confirmPasswordReset(email, view.code, password), {
                context: 'reset-password',
                words,
                busyStatus: 'Saving…',
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
              // The new password signs them straight in; the authenticator code comes next, as usual.
              await attempt(firstFactor('password', () => signInWithPassword(email, password)), 'sign-in', 'Signing in…');
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
    case 'enroll-authenticator':
      body = (
        <AuthenticatorSetup
          issuer={siteName}
          accountName={email.trim()}
          intro="You sign in with a password, so this site also asks for a code from an authenticator app. It only takes a minute."
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
          onDone={(how) => go({ name: 'done', how })}
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
            {props.securityNotices ? ` ${FIRST_VISIT.emailedNote}` : ''}
          </Text>
          <Actions classNames={classNames}>
            <Button classNames={classNames} onClick={finish}>
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
              onClick={() =>
                void fb.run(registerPasskey, { context: 'passkey-register', words, busyStatus: FIRST_VISIT.waitingForDevice }).then((r) => {
                  if (r.ok) {
                    set({ status: 'Passkey saved.' });
                    finish();
                  }
                })
              }
            >
              {FIRST_VISIT.createPasskey}
            </Button>
            <Button
              variant="link"
              classNames={classNames}
              disabled={busy}
              onClick={() => {
                dismissOffer(userIdRef.current);
                finish();
              }}
            >
              {SIGN_IN.notNow}
            </Button>
          </Actions>
        </div>
      );
      break;
    case 'trouble':
      bottom.back = { label: SIGN_IN.backToSignIn, onClick: backToEmail };
      body = (
        <div {...slot(classNames, 'form')}>
          {heading(TROUBLE.heading)}
          <Text classNames={classNames}>{TROUBLE.sub}</Text>
          <ul {...slot(classNames, 'list')}>
            {TROUBLE.rows.map(([topic, label]) => (
              <li key={topic} {...slot(classNames, 'listItem')}>
                <button type="button" onClick={() => go({ name: 'help', topic, askEmail: !looksLikeEmail(email) })} {...slot(classNames, 'secondaryButton')}>
                  <span>{label}</span>
                  <Icon name="chevron" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      );
      break;
    case 'help': {
      bottom.back = { label: SIGN_IN.back, onClick: () => go({ name: 'trouble' }) };
      const screen = helpScreen(view.topic, c, { securityNotices: props.securityNotices === true });
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
        <form noValidate onSubmit={onSubmit(runAction)} aria-busy={busy || undefined} {...slot(classNames, 'form')}>
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
      bottom.back = { label: SIGN_IN.backToSignIn, onClick: backToEmail };
      const named = c.theme.help.named && c.ownerName ? ` ${c.ownerName} looks after ${siteName}.` : '';
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
              Email{' '}
              <a href={`mailto:${props.help.address}`} {...slot(classNames, 'link')}>
                {props.help.address}
              </a>
              .{named}
            </p>
            <p>Never send a password or code.</p>
          </div>
        </div>
      );
      break;
    }
  }

  const troubleHere = TROUBLE_VIEWS.has(view.name);
  const openTrouble = () => go({ name: 'trouble' });
  if (troubleHere && (props.troubleLink ?? 'inside') === 'inside') bottom.trouble = openTrouble;
  return (
    <Card
      name="sign-in"
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
