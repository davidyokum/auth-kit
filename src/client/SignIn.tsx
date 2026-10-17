import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { safeRedirect } from '../server/redirect.js';
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
import { ChooseFirstCredential } from './ChooseFirstCredential.js';
import { type ClientAuthFactors, SIGN_IN_AUTOCOMPLETE, type SignInMethod, afterSignInStep, newPasswordProblem, normalizeCode } from './ladder.js';
import type { AuthErrorContext, AuthErrorInfo, AuthErrorKind } from './messages.js';
import { answerSimulatedCode, decoyPasskeyPrompt, isFirstFactorUnavailable } from './parity.js';
import { type PasswordCheckOptions, breachedPasswordProblem } from './PasswordForm.js';
import type { SignInStep } from './steps.js';
import {
  Actions,
  Button,
  Field,
  Heading,
  type HeadingLevel,
  HiddenUsername,
  LiveRegions,
  type StyleProps,
  Text,
  slot,
  useFeedback,
  useFocusOnViewChange,
} from './ui.js';

export interface SignInProps extends StyleProps, PasswordCheckOptions {
  /** The site's name: "Sign in to {siteName}", and the authenticator's label. */
  siteName: string;
  /** Passkeys switch on once the site's final domain is live (the relying-party ID). */
  passkeysEnabled: boolean;
  /** Offer "Email me a code". Default true; admin pools have no emailed codes. */
  emailCodeEnabled?: boolean;
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
  /** Shown on the authenticator-code step. Default: ask the site's admin. */
  lostAuthenticatorHelp?: ReactNode;
}

type View =
  | { name: 'start' }
  | { name: 'password' }
  | { name: 'challenge-password' }
  /** "Check your email". `simulated`: nothing was sent (no account, or no emailed codes for it); the screen is the same. */
  | { name: 'email-code'; simulated: boolean; sentAt: number }
  | { name: 'totp' }
  | { name: 'new-password' }
  | { name: 'totp-setup'; secret: string }
  | { name: 'reset-request'; required: boolean }
  | { name: 'reset-confirm' }
  | { name: 'finishing' }
  | { name: 'enroll-authenticator' }
  | { name: 'first-credential' }
  | { name: 'offer-passkey' };

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
  return /^[^\s@]+@[^\s@]+$/.test(email.trim());
}

/**
 * The sign-in screen. Passkey first; "Use a password instead" (password, then the authenticator code);
 * "Email me a code instead" as the backstop. Handles every step Cognito can return for the
 * standard's pools, then the after-sign-in steps: authenticator setup for password users, the first
 * credential after an invite, and a one-time "Save a passkey" offer.
 *
 * Until someone proves a factor, every address sees the same screens in the same order, whether it
 * has an account or not and whatever factors that account has (ADR 0018).
 */
export function SignIn(props: SignInProps) {
  const { classNames, passkeysEnabled, siteName } = props;
  const emailCodeEnabled = props.emailCodeEnabled ?? true;
  const level = props.headingLevel ?? 1;
  const rootRef = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const secretRef = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const fb = useFeedback();
  const { set } = fb;
  const [view, setView] = useState<View>(passkeysEnabled ? { name: 'start' } : { name: 'password' });
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

  const go = useCallback((next: View) => {
    setSecretValue('');
    setCodeValue('');
    setView(next);
  }, []);

  const finish = useCallback(() => {
    const target = safeRedirect(props.next, props.defaultNext ?? '/', {
      ...(props.allowedRedirectPrefixes !== undefined && { allowedPrefixes: props.allowedRedirectPrefixes }),
    });
    (props.navigate ?? ((path: string) => window.location.assign(path)))(target);
  }, [props.next, props.defaultNext, props.allowedRedirectPrefixes, props.navigate]);

  /** After Cognito says DONE: decide what else this person needs before entering the site. */
  const afterSignIn = useCallback(async () => {
    go({ name: 'finishing' });
    set({ status: 'Signed in. One moment…', error: null });
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
          set({ error: "This sign-in step isn't available here. Choose another way to sign in." });
          return go(passkeysEnabled ? { name: 'start' } : { name: 'password' });
        case 'password':
          return go({ name: 'challenge-password' });
        case 'email-code':
        case 'email-code-simulated':
          // The typed address, never Cognito's masked one (an unknown address has none to show).
          set({ status: `If ${email.trim()} has an account here, we've emailed it a code. It works for 3 minutes.` });
          setResendReady(false);
          return go({ name: 'email-code', simulated: step.step === 'email-code-simulated', sentAt: Date.now() });
        case 'totp':
          return go({ name: 'totp' });
        case 'new-password':
          if (step.missingAttributes.length > 0) {
            set({ error: "This account is missing details this screen can't collect. Contact the site's admin." });
            return go(passkeysEnabled ? { name: 'start' } : { name: 'password' });
          }
          return go({ name: 'new-password' });
        case 'totp-setup':
          return go({ name: 'totp-setup', secret: step.secret });
        case 'reset-password':
          set({ status: 'You need to choose a new password before signing in. We can email you a code to do that.' });
          return go({ name: 'reset-request', required: true });
        case 'select-mfa':
        case 'unsupported':
          set({ error: "This account needs a sign-in step this site doesn't support. Contact the site's admin." });
          return go(passkeysEnabled ? { name: 'start' } : { name: 'password' });
      }
    },
    [afterSignIn, email, go, passkeysEnabled, set],
  );

  /** Errors that end the attempt send the person back to the start, keeping the email. */
  const onError = useCallback(
    (info: AuthErrorInfo) => {
      if (info.kind === 'session-expired') go(passkeysEnabled ? { name: 'start' } : { name: 'password' });
      else if (info.kind === 'reset-required') go({ name: 'reset-request', required: true });
    },
    [go, passkeysEnabled],
  );

  async function attempt(task: () => Promise<ScreenStep>, context: AuthErrorContext, busyStatus?: string) {
    const failed: { kind?: AuthErrorKind } = {};
    const result = await fb.run(task, {
      context,
      onError: (info) => {
        failed.kind = info.kind;
        onError(info);
      },
      ...(busyStatus !== undefined && { busyStatus }),
    });
    if (result.ok) handleStep(result.value);
    else if (failed.kind === 'bad-credentials') set({ field: 'secret' });
    else if (failed.kind === 'wrong-code' || failed.kind === 'expired-code') set({ field: 'code' });
  }

  function requireEmail(): boolean {
    if (looksLikeEmail(email)) return true;
    set({ error: email.trim() ? 'Enter a valid email address.' : 'Enter your email address.', field: 'email', status: null });
    emailRef.current?.focus();
    return false;
  }

  function requireSecret(message: string): boolean {
    if (secretValue !== '') return true;
    set({ error: message, field: 'secret', status: null });
    secretRef.current?.focus();
    return false;
  }

  function sendEmailCode() {
    if (!requireEmail()) return;
    void attempt(firstFactor('email-code', () => requestEmailCode(email)), 'sign-in', 'Sending a code…');
  }

  function backToStart() {
    set({ error: null, status: null });
    go(passkeysEnabled ? { name: 'start' } : { name: 'password' });
  }

  const emailField = (
    <Field
      label="Email address"
      type="email"
      name="username"
      inputMode="email"
      autoCapitalize="none"
      spellCheck={false}
      autoComplete={SIGN_IN_AUTOCOMPLETE.email}
      value={email}
      onChange={(e) => setEmail(e.target.value)}
      invalid={fb.field === 'email'}
      errorId={errorId}
      inputRef={emailRef}
      classNames={classNames}
    />
  );

  const codeField = (label: string, hint?: string) => (
    <Field
      label={label}
      {...(hint !== undefined && { hint })}
      name="one-time-code"
      inputMode="numeric"
      autoComplete={SIGN_IN_AUTOCOMPLETE.oneTimeCode}
      value={codeValue}
      onChange={(e) => setCodeValue(e.target.value)}
      invalid={fb.field === 'code'}
      errorId={errorId}
      inputRef={secretRef}
      classNames={classNames}
    />
  );

  const title = props.reauth ? 'Confirm it’s you' : `Sign in to ${siteName}`;
  const reauthNote = props.reauth ? <Text classNames={classNames}>For your security, sign in again to continue.</Text> : null;
  const busy = fb.busy;

  function onSubmit(handler: () => void) {
    return (event: FormEvent) => {
      event.preventDefault();
      if (!busy) handler();
    };
  }

  let body: ReactNode;
  switch (view.name) {
    case 'start':
      body = (
        <form noValidate onSubmit={onSubmit(() => requireEmail() && void attempt(firstFactor('passkey', () => signInWithPasskey(email)), 'sign-in', 'Waiting for your passkey…'))} aria-busy={busy || undefined} {...slot(classNames, 'form')}>
          <Heading level={level} classNames={classNames}>
            {title}
          </Heading>
          {reauthNote}
          {emailField}
          <Actions classNames={classNames}>
            <Button type="submit" disabled={busy} classNames={classNames}>
              Sign in with a passkey
            </Button>
          </Actions>
          <Actions classNames={classNames}>
            <Button variant="link" classNames={classNames} disabled={busy} onClick={() => go({ name: 'password' })}>
              Use a password instead
            </Button>
            {emailCodeEnabled ? (
              <Button variant="link" classNames={classNames} disabled={busy} onClick={sendEmailCode}>
                Email me a code instead
              </Button>
            ) : null}
          </Actions>
        </form>
      );
      break;
    case 'password':
      body = (
        <form
          noValidate
          onSubmit={onSubmit(
            () => requireEmail() && requireSecret('Enter your password.') && void attempt(firstFactor('password', () => signInWithPassword(email, secretValue)), 'sign-in', 'Signing in…'),
          )}
          aria-busy={busy || undefined}
          {...slot(classNames, 'form')}
        >
          <Heading level={level} classNames={classNames}>
            {title}
          </Heading>
          {reauthNote}
          {emailField}
          <Field
            label="Password"
            type="password"
            name="current-password"
            autoComplete={SIGN_IN_AUTOCOMPLETE.currentPassword}
            value={secretValue}
            onChange={(e) => setSecretValue(e.target.value)}
            invalid={fb.field === 'secret'}
            errorId={errorId}
            inputRef={secretRef}
            classNames={classNames}
          />
          <Actions classNames={classNames}>
            <Button type="submit" disabled={busy} classNames={classNames}>
              Sign in
            </Button>
            <Button variant="link" classNames={classNames} disabled={busy} onClick={() => go({ name: 'reset-request', required: false })}>
              Forgot your password?
            </Button>
          </Actions>
          <Actions classNames={classNames}>
            {passkeysEnabled ? (
              <Button variant="link" classNames={classNames} disabled={busy} onClick={() => go({ name: 'start' })}>
                Use a passkey instead
              </Button>
            ) : null}
            {emailCodeEnabled ? (
              <Button variant="link" classNames={classNames} disabled={busy} onClick={sendEmailCode}>
                Email me a code instead
              </Button>
            ) : null}
          </Actions>
        </form>
      );
      break;
    case 'challenge-password':
      body = (
        <form noValidate onSubmit={onSubmit(() => requireSecret('Enter your password.') && void attempt(() => confirmPassword(secretValue), 'sign-in', 'Signing in…'))} aria-busy={busy || undefined} {...slot(classNames, 'form')}>
          <Heading level={level} classNames={classNames}>
            Enter your password
          </Heading>
          <HiddenUsername email={email} />
          <Field
            label="Password"
            type="password"
            name="current-password"
            autoComplete={SIGN_IN_AUTOCOMPLETE.currentPassword}
            value={secretValue}
            onChange={(e) => setSecretValue(e.target.value)}
            invalid={fb.field === 'secret'}
            errorId={errorId}
            inputRef={secretRef}
            classNames={classNames}
          />
          <Actions classNames={classNames}>
            <Button type="submit" disabled={busy} classNames={classNames}>
              Sign in
            </Button>
            <Button variant="link" classNames={classNames} disabled={busy} onClick={backToStart}>
              Start over
            </Button>
          </Actions>
        </form>
      );
      break;
    case 'email-code':
      body = (
        <form
          noValidate
          onSubmit={onSubmit(() => {
            if (normalizeCode(codeValue) === '') {
              set({ error: 'Enter the code from the email.', field: 'code', status: null });
              secretRef.current?.focus();
              return;
            }
            const sentAt = view.sentAt;
            void attempt(() => (view.simulated ? answerSimulatedCode(sentAt) : confirmCode(codeValue)), 'code', 'Checking the code…');
          })}
          aria-busy={busy || undefined}
          {...slot(classNames, 'form')}
        >
          <Heading level={level} classNames={classNames}>
            Check your email
          </Heading>
          <Text classNames={classNames}>
            If {email.trim()} has an account here, we&apos;ve emailed it an 8-digit code. It works for 3 minutes.
          </Text>
          <Text classNames={classNames}>
            No email after a minute? Check your spam folder, then send a new code. Accounts with an authenticator app can&apos;t get emailed codes: use your password or passkey instead.
          </Text>
          {codeField('Code')}
          <Actions classNames={classNames}>
            <Button type="submit" disabled={busy} classNames={classNames}>
              Sign in
            </Button>
          </Actions>
          <Actions classNames={classNames}>
            <Button variant="link" classNames={classNames} disabled={busy || !resendReady} onClick={sendEmailCode}>
              Send a new code
            </Button>
            <Button variant="link" classNames={classNames} disabled={busy} onClick={backToStart}>
              Use another way to sign in
            </Button>
          </Actions>
        </form>
      );
      break;
    case 'totp':
      body = (
        <form
          noValidate
          onSubmit={onSubmit(() => {
            if (!/^\d{6}$/.test(normalizeCode(codeValue))) {
              set({ error: 'Enter the 6-digit code from your authenticator.', field: 'code', status: null });
              secretRef.current?.focus();
              return;
            }
            void attempt(() => confirmCode(codeValue), 'totp', 'Checking the code…');
          })}
          aria-busy={busy || undefined}
          {...slot(classNames, 'form')}
        >
          <Heading level={level} classNames={classNames}>
            Enter your authenticator code
          </Heading>
          <Text classNames={classNames}>Open your authenticator app or password manager and enter the 6-digit code for {siteName}.</Text>
          {codeField('6-digit code')}
          <Actions classNames={classNames}>
            <Button type="submit" disabled={busy} classNames={classNames}>
              Sign in
            </Button>
            <Button variant="link" classNames={classNames} disabled={busy} onClick={backToStart}>
              Start over
            </Button>
          </Actions>
          <Text classNames={classNames}>{props.lostAuthenticatorHelp ?? "Lost your authenticator? Ask the site's admin to reset it."}</Text>
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
              set({ error: problem, field: 'secret', status: null });
              secretRef.current?.focus();
              return;
            }
            void (async () => {
              set({ busy: true, error: null, status: 'Checking the password…' });
              const breached = await breachedPasswordProblem(secretValue, props.checkBreachedPassword);
              set({ busy: false, status: null });
              if (breached) {
                set({ error: breached, field: 'secret' });
                secretRef.current?.focus();
                return;
              }
              await attempt(() => completeNewPassword(secretValue), 'set-password', 'Saving…');
            })();
          })}
          aria-busy={busy || undefined}
          {...slot(classNames, 'form')}
        >
          <Heading level={level} classNames={classNames}>
            Choose a new password
          </Heading>
          <Text classNames={classNames}>Your temporary password worked. Now choose your own.</Text>
          <HiddenUsername email={email} />
          <Field
            label="New password"
            hint="At least 15 characters. Your password manager can make one."
            type="password"
            name="new-password"
            autoComplete={SIGN_IN_AUTOCOMPLETE.newPassword}
            minLength={15}
            value={secretValue}
            onChange={(e) => setSecretValue(e.target.value)}
            invalid={fb.field === 'secret'}
            errorId={errorId}
            inputRef={secretRef}
            classNames={classNames}
          />
          <Actions classNames={classNames}>
            <Button type="submit" disabled={busy} classNames={classNames}>
              Save password
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
          onCancel={backToStart}
          cancelLabel="Start over"
          {...(props.renderQrCode && { renderQrCode: props.renderQrCode })}
          classNames={classNames}
        />
      );
      break;
    case 'reset-request':
      body = (
        <form
          noValidate
          onSubmit={onSubmit(() => {
            if (!requireEmail()) return;
            void (async () => {
              const result = await fb.run(() => requestPasswordReset(email), { context: 'reset-password', busyStatus: 'Sending a code…' });
              if (result.ok) {
                go({ name: 'reset-confirm' });
                setResendReady(false);
              }
            })();
          })}
          aria-busy={busy || undefined}
          {...slot(classNames, 'form')}
        >
          <Heading level={level} classNames={classNames}>
            Reset your password
          </Heading>
          <Text classNames={classNames}>
            We&apos;ll email you a code to set a new password. If you use an authenticator app, you&apos;ll still need its code to sign in.
          </Text>
          {emailField}
          <Actions classNames={classNames}>
            <Button type="submit" disabled={busy} classNames={classNames}>
              Email me a reset code
            </Button>
            <Button variant="link" classNames={classNames} disabled={busy} onClick={backToStart}>
              Back to sign in
            </Button>
          </Actions>
        </form>
      );
      break;
    case 'reset-confirm':
      body = (
        <form
          noValidate
          onSubmit={onSubmit(() => {
            if (normalizeCode(codeValue) === '') {
              set({ error: 'Enter the code from the email.', field: 'code', status: null });
              secretRef.current?.focus();
              return;
            }
            const problem = newPasswordProblem(secretValue);
            if (problem) {
              set({ error: problem, field: 'new-password', status: null });
              rootRef.current?.querySelector<HTMLInputElement>('input[name="new-password"]')?.focus();
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
              const result = await fb.run(() => confirmPasswordReset(email, codeValue, secretValue), { context: 'reset-password', busyStatus: 'Saving…' });
              if (result.ok) {
                go({ name: 'password' });
                set({ status: 'Password saved. Sign in with your new password.' });
              }
            })();
          })}
          aria-busy={busy || undefined}
          {...slot(classNames, 'form')}
        >
          <Heading level={level} classNames={classNames}>
            Set a new password
          </Heading>
          <Text classNames={classNames}>
            If an account uses {email.trim()}, we&apos;ve emailed it a code. No code after a few minutes? Check your spam folder, or contact the site&apos;s admin.
          </Text>
          <HiddenUsername email={email} />
          {codeField('Code from the email')}
          <Field
            label="New password"
            hint="At least 15 characters. Your password manager can make one."
            type="password"
            name="new-password"
            autoComplete={SIGN_IN_AUTOCOMPLETE.newPassword}
            minLength={15}
            value={secretValue}
            onChange={(e) => setSecretValue(e.target.value)}
            invalid={fb.field === 'new-password'}
            errorId={errorId}
            classNames={classNames}
          />
          <Actions classNames={classNames}>
            <Button type="submit" disabled={busy} classNames={classNames}>
              Save new password
            </Button>
            <Button
              variant="link"
              classNames={classNames}
              disabled={busy || !resendReady}
              onClick={() =>
                void fb.run(() => requestPasswordReset(email), { context: 'reset-password', busyStatus: 'Sending a code…' }).then((r) => {
                  if (r.ok) {
                    set({ status: 'We sent a new code.' });
                    setResendReady(false);
                  }
                })
              }
            >
              Send a new code
            </Button>
            <Button variant="link" classNames={classNames} disabled={busy} onClick={backToStart}>
              Back to sign in
            </Button>
          </Actions>
        </form>
      );
      break;
    case 'finishing':
      body = (
        <Heading level={level} classNames={classNames}>
          Signing you in…
        </Heading>
      );
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
          onDone={() => void afterSignIn()}
          onSkip={finish}
          {...(props.renderQrCode && { renderQrCode: props.renderQrCode })}
          {...(props.checkBreachedPassword !== undefined && { checkBreachedPassword: props.checkBreachedPassword })}
          classNames={classNames}
        />
      );
      break;
    case 'offer-passkey':
      body = (
        <div {...slot(classNames, 'form')}>
          <Heading level={level} classNames={classNames}>
            Save a passkey?
          </Heading>
          <Text classNames={classNames}>Next time, sign in with Face ID, Touch ID, your device PIN, or your password manager: one step, and it can&apos;t be phished.</Text>
          <Actions classNames={classNames}>
            <Button
              classNames={classNames}
              disabled={busy}
              onClick={() =>
                void fb.run(registerPasskey, { context: 'passkey-register', busyStatus: 'Waiting for your passkey…' }).then((r) => {
                  if (r.ok) {
                    set({ status: 'Passkey saved.' });
                    finish();
                  }
                })
              }
            >
              Save a passkey
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
              Not now
            </Button>
          </Actions>
        </div>
      );
      break;
  }

  return (
    <div ref={rootRef} data-auth-kit="sign-in" data-auth-kit-view={view.name} {...slot(classNames, 'root', props.className)}>
      {body}
      <LiveRegions classNames={classNames} errorId={errorId} error={fb.error} status={fb.status} />
    </div>
  );
}
