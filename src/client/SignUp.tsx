import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { safeRedirect } from '../server/redirect.js';
import { type AccountCreationSettings, domainsInWords, mayCreateOwnAccount, normalizeAccountCreation, notOnListMessage } from '../shared/account-creation.js';
import { codeLifetimeMinutes as checkedLifetime } from '../shared/policy.js';
import { type AuthTheme, type ThemeFamily, resolveTheme } from '../themes/index.js';
import { handOffEmail, postAccountForm } from './account-creation-client.js';
import { confirmCode, fetchAuthFactors, requestEmailCode, saveName } from './api.js';
import { AuthenticatorSetup } from './AuthenticatorSetup.js';
import { type AccountNotices, resolveNotices, sendAccountNotice } from './notices.js';
import { ChooseFirstCredential } from './ChooseFirstCredential.js';
import { type CopyContext, ERRORS, FIRST_VISIT, SIGN_IN, SIGN_UP, STATUS } from './copy.js';
import { checkedHref, hrefOr } from './href.js';
import { type ClientAuthFactors, SIGN_IN_AUTOCOMPLETE, needsAuthenticator, normalizeCode } from './ladder.js';
import type { AuthErrorKind, MessageWords } from './messages.js';
import { answerSimulatedCode, isFirstFactorRefusal, isFirstFactorUnavailable } from './parity.js';
import type { PasswordCheckOptions } from './PasswordForm.js';
import type { SignInHelp } from './SignIn.js';
import type { SignInStep } from './steps.js';
import {
  Actions,
  AltLinks,
  Button,
  Card,
  ErrorSummary,
  Field,
  Glyph,
  Heading,
  type HeadingLevel,
  Note,
  StatusRegion,
  type StyleProps,
  Text,
  slot,
  useFeedback,
  useFocusOnViewChange,
} from './ui.js';

export interface SignUpProps extends StyleProps, PasswordCheckOptions {
  siteName: string;
  /** The site's family or theme. Default personal. */
  theme?: AuthTheme | ThemeFamily;
  /** The help route (the help address in effect, and the owner's name). */
  help: SignInHelp;
  /** The site's setting: `domains` or `open` (the screen refuses to render for the others). */
  accountCreation: AccountCreationSettings;
  /** The privacy notice, linked from the sign-up screen (register D4). Required: a same-site path or an http(s) URL (anything else throws). */
  privacyNoticeUrl: string;
  /** The site's terms, when it has them (open sign-up: "you agree to the terms and privacy notice"). A path or an http(s) URL. */
  termsUrl?: string;
  passkeysEnabled: boolean;
  /** The same value as the preset's (register A7). Default 10. */
  codeLifetimeMinutes?: number;
  /** The email field's example. Default: the family's, or `name@example.com` on open sign-up. */
  emailHint?: string;
  /** The line under the email field in `domains` mode. Default: "Use an email address ending in nc.gov". */
  domainHint?: string;
  /** The sign-up route. Default `/api/auth/sign-up`. */
  endpoint?: string;
  /** Where "Sign in" and "Ask for access instead" go. Defaults `/sign-in` and `/request-access`. Paths or http(s) URLs. */
  signInHref?: string;
  requestAccessHref?: string;
  /** Show "Protected against automated sign-ups." (open sign-up). Default false. */
  botNote?: boolean;
  /** The "Your name" button (Card Studio vote): "Create account" (default) or "Finish". */
  nameButton?: 'create' | 'finish';
  /** Account-change notices (register A10: on by default; see `SignIn`'s `notices`). `false` for a site that doesn't send them. */
  notices?: AccountNotices;
  next?: string | null;
  defaultNext?: string;
  allowedRedirectPrefixes?: readonly string[];
  navigate?: (path: string) => void;
  loadFactors?: () => Promise<ClientAuthFactors>;
  headingLevel?: HeadingLevel;
  renderQrCode?: (otpauthUri: string) => ReactNode;
  /** Inject `fetch` (tests). Default: AWS WAF's integration when the page loaded it, else `fetch`. */
  fetch?: typeof fetch;
}

type View =
  | { name: 'email'; requestAccess?: boolean }
  | { name: 'code'; simulated: boolean; sentAt: number; resentAt?: number; expired?: boolean }
  | { name: 'name' }
  | { name: 'choose' }
  | { name: 'enroll-authenticator' }
  | { name: 'done'; emailed: boolean }
  | { name: 'finishing' };

/**
 * "Create your account" (REPORT §3.1b–c, Card Studio v4; register D1–D4, ADR 0023): the self-invite.
 * The server makes the account (or emails an address that already has one, with the same answer);
 * then the invite's path: an emailed code ("Verify"), "Your name", the required "Choose how you'll
 * sign in next time", and "You're set up", as a Member.
 */
export function SignUp(props: SignUpProps) {
  const { classNames, siteName } = props;
  const theme = useMemo(() => resolveTheme(props.theme), [props.theme]);
  const settings = useMemo(() => normalizeAccountCreation(props.accountCreation, 'SignUp accountCreation'), [props.accountCreation]);
  const notices = useMemo(() => resolveNotices(props.notices, 'SignUp'), [props.notices]);
  const lifetime = checkedLifetime(props.codeLifetimeMinutes, 'SignUp codeLifetimeMinutes');
  const open = settings.mode === 'open';
  const c: CopyContext = { siteName, theme, codeLifetimeMinutes: lifetime, helpAddress: props.help.address, ...(props.help.owner !== undefined && { ownerName: props.help.owner }), publicSite: settings.mode === 'open' };
  const words: MessageWords = { siteName, codeLifetimeMinutes: lifetime, helpAddress: props.help.address };
  const level = props.headingLevel ?? 1;
  const hint = props.emailHint?.trim() || (open ? 'name@example.com' : theme.emailHint);
  const uid = useId();
  const ids = { email: `${uid}-email`, code: `${uid}-code`, given: `${uid}-given`, family: `${uid}-family` };
  const rootRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLInputElement>(null);
  const fb = useFeedback();
  const { set } = fb;
  const [view, setView] = useState<View>({ name: 'email' });
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [given, setGiven] = useState('');
  const [family, setFamily] = useState('');
  const [resendReady, setResendReady] = useState(true);
  useFocusOnViewChange(rootRef, view.name);

  useEffect(() => {
    if (resendReady) return;
    const timer = setTimeout(() => setResendReady(true), 30_000);
    return () => clearTimeout(timer);
  }, [resendReady]);

  const finish = useCallback(() => {
    const target = safeRedirect(props.next, props.defaultNext ?? '/', { ...(props.allowedRedirectPrefixes !== undefined && { allowedPrefixes: props.allowedRedirectPrefixes }) });
    (props.navigate ?? ((path: string) => window.location.assign(path)))(target);
  }, [props.next, props.defaultNext, props.allowedRedirectPrefixes, props.navigate]);
  const navigate = (path: string) => (props.navigate ?? ((p: string) => window.location.assign(p)))(path);

  if (settings.mode !== 'domains' && settings.mode !== 'open') {
    throw new Error(`auth-kit: SignUp needs accountCreation mode 'domains' or 'open' (this site is '${settings.mode}').`);
  }
  const signInHref = hrefOr('signInHref', props.signInHref, '/sign-in');
  const requestAccessHref = hrefOr('requestAccessHref', props.requestAccessHref, '/request-access');
  const privacyNoticeUrl = checkedHref('privacyNoticeUrl', props.privacyNoticeUrl, '/privacy');
  const termsUrl = props.termsUrl ? checkedHref('termsUrl', props.termsUrl, '/terms') : undefined;

  const domainList = domainsInWords(settings.domains);
  const notOnList = notOnListMessage(siteName, settings.domains, settings.requestsAlso);

  function go(next: View, keepError = false) {
    setCode('');
    if (!keepError) set({ error: null, field: null });
    setView(next);
  }

  /** The emailed-code sign-in, as an invite's: a real code, or the same screen with nothing sent. */
  async function sendCode(): Promise<boolean> {
    const result = await fb.run(
      async () => {
        let step: SignInStep;
        try {
          step = await requestEmailCode(email);
        } catch (error) {
          // A disabled account (an expired invite included), or one whose password must be reset: an
          // unknown address gets a challenge here, so these read as "check your email" too (ADR 0018).
          if (isFirstFactorRefusal(error)) return 'simulated';
          throw error;
        }
        // Anything but a real code challenge reads as "check your email" with nothing sent (ADR 0018).
        return !isFirstFactorUnavailable('email-code', step) && step.step === 'email-code' ? 'sent' : 'simulated';
      },
      { context: 'sign-in', words, busyStatus: STATUS.sendingCode },
    );
    if (!result.ok) return false;
    setResendReady(false);
    go({ name: 'code', simulated: result.value !== 'sent', sentAt: Date.now() });
    return true;
  }

  async function submitEmail(event: FormEvent) {
    event.preventDefault();
    if (fb.busy) return;
    const typed = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(typed)) {
      set({ error: typed ? ERRORS.badEmail(hint) : ERRORS.emptyEmail, field: 'email', status: null });
      fieldRef.current?.focus();
      return;
    }
    // The list is public: saying an address isn't on it tells nobody who has an account.
    if (!mayCreateOwnAccount(typed.toLowerCase(), settings)) {
      set({ error: notOnList, field: 'email', status: null });
      setView({ name: 'email', requestAccess: settings.requestsAlso });
      return;
    }
    set({ busy: true, error: null, field: null, status: STATUS.sendingCode });
    const outcome = await postAccountForm(props.endpoint ?? '/api/auth/sign-up', { email: typed }, { ...(props.fetch !== undefined && { fetch: props.fetch }), helpAddress: props.help.address });
    set({ busy: false, status: null });
    if (!outcome.ok) {
      const field = outcome.body?.field === 'email' ? 'email' : null;
      set({ error: outcome.message, field });
      setView({ name: 'email', requestAccess: outcome.body?.code === 'not_on_list' && outcome.body.requestAccess === true });
      return;
    }
    await sendCode();
  }

  async function submitCode(event: FormEvent) {
    event.preventDefault();
    if (fb.busy || view.name !== 'code') return;
    if (!/^\d{8}$/.test(normalizeCode(code))) {
      set({ error: ERRORS.codeTooShort, field: 'code', status: null });
      fieldRef.current?.focus();
      return;
    }
    const sentAt = view.resentAt ?? view.sentAt;
    const failed: { kind?: AuthErrorKind } = {};
    const result = await fb.run(() => (view.simulated ? answerSimulatedCode(sentAt, { lifetimeMs: lifetime * 60_000 }) : confirmCode(code)), {
      context: 'code',
      words,
      busyStatus: STATUS.checkingCode,
      onError: (info) => {
        failed.kind = info.kind;
      },
    });
    if (!result.ok) {
      if (failed.kind === 'session-expired') setView({ ...view, expired: true });
      else set({ field: 'code' });
      return;
    }
    if (result.value.step !== 'done') {
      // A code that led somewhere else (an account with other factors): the sign-in page handles it.
      set({ error: `${siteName} needs another step to sign you in. Use the sign-in page.` });
      return;
    }
    go({ name: 'finishing' });
    let factors: ClientAuthFactors | null = null;
    try {
      factors = await (props.loadFactors ?? fetchAuthFactors)();
    } catch {
      // The server enforces the rules on every request; carry on with the new account's steps.
    }
    // An account that already had a way in signed in as usual (the email explained it).
    if (factors && (factors.configured.includes('PASSWORD') || factors.configured.includes('WEB_AUTHN'))) {
      if (needsAuthenticator(factors)) return go({ name: 'enroll-authenticator' });
      return finish();
    }
    go({ name: 'name' });
  }

  async function submitName(event: FormEvent) {
    event.preventDefault();
    if (fb.busy) return;
    if (!given.trim() && !family.trim()) {
      set({ error: ERRORS.emptyName, field: 'given', status: null });
      fieldRef.current?.focus();
      return;
    }
    const result = await fb.run(() => saveName({ givenName: given, familyName: family }), { context: 'account', words, busyStatus: STATUS.saving });
    if (result.ok) go({ name: 'choose' });
  }

  const busy = fb.busy;
  const heading = (text: ReactNode) => (
    <Heading level={level} classNames={classNames}>
      {text}
    </Heading>
  );
  const fieldId = fb.field === 'email' ? ids.email : fb.field === 'code' ? ids.code : fb.field === 'given' ? ids.given : undefined;
  const summary = <ErrorSummary error={fb.error} fieldId={fieldId} classNames={classNames} />;
  const signInLink = (
    <p {...slot(classNames, 'access')}>
      {SIGN_UP.alreadyHaveAccount}{' '}
      <a href={signInHref} {...slot(classNames, 'link')}>
        {SIGN_UP.signIn}
      </a>
    </p>
  );
  const link = (href: string, text: string) => (
    <a href={href} {...slot(classNames, 'link')}>
      {text}
    </a>
  );

  let body: ReactNode;
  let extra: ReactNode = null;
  switch (view.name) {
    case 'email': {
      extra = signInLink;
      const terms = open && termsUrl ? SIGN_UP.termsOpen(c) : null;
      const privacy = SIGN_UP.privacyDomains(c);
      body = (
        <form noValidate onSubmit={(e) => void submitEmail(e)} aria-busy={busy || undefined} {...slot(classNames, 'form')}>
          {summary}
          {heading(SIGN_UP.heading)}
          {open ? <Text classNames={classNames}>{SIGN_UP.openSub}</Text> : null}
          <Field
            id={ids.email}
            label={SIGN_IN.emailLabel}
            type="email"
            name="email"
            inputMode="email"
            autoCapitalize="none"
            spellCheck={false}
            autoComplete="email"
            placeholder={hint}
            {...(!open && { hint: props.domainHint ?? SIGN_UP.domainHint(domainList) })}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            invalid={fb.field === 'email'}
            error={fb.field === 'email' ? fb.error : null}
            inputRef={fieldRef}
            classNames={classNames}
          />
          {view.requestAccess ? (
            <p {...slot(classNames, 'text')}>
              <Button
                variant="link"
                classNames={classNames}
                onClick={() => {
                  handOffEmail(email.trim());
                  navigate(requestAccessHref);
                }}
              >
                {SIGN_UP.askForAccessInstead}
              </Button>
            </p>
          ) : null}
          <p {...slot(classNames, 'small')}>
            {terms && termsUrl ? (
              <>
                {terms[0]}
                {link(termsUrl, terms[1])}
                {terms[2]}
                {link(privacyNoticeUrl, terms[3])}
                {terms[4]}
              </>
            ) : (
              <>
                {link(privacyNoticeUrl, privacy[0])}
                {privacy[1]}
              </>
            )}
          </p>
          <Actions classNames={classNames}>
            <Button type="submit" disabled={busy} classNames={classNames}>
              {SIGN_IN.continue}
            </Button>
          </Actions>
          {open && props.botNote ? <p {...slot(classNames, 'small')}>{SIGN_UP.botNote}</p> : null}
        </form>
      );
      break;
    }
    case 'code':
      body = view.expired ? (
        <div {...slot(classNames, 'form')}>
          <ErrorSummary error={ERRORS.sessionExpired(c)} classNames={classNames} />
          {heading(SIGN_UP.codeHeading)}
          <Actions classNames={classNames}>
            <Button classNames={classNames} onClick={() => go({ name: 'email' })}>
              {SIGN_IN.startAgain}
            </Button>
          </Actions>
        </div>
      ) : (
        <form noValidate onSubmit={(e) => void submitCode(e)} aria-busy={busy || undefined} {...slot(classNames, 'form')}>
          {summary}
          {heading(SIGN_UP.codeHeading)}
          <Text classNames={classNames}>{SIGN_UP.codeSub(c, email.trim())}</Text>
          <Text classNames={classNames}>{SIGN_UP.codeExisting}</Text>
          {view.resentAt !== undefined ? (
            <Note icon="mail" classNames={classNames}>
              {SIGN_IN.codeResent(new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date(view.resentAt)))}
            </Note>
          ) : null}
          <Field
            id={ids.code}
            label={SIGN_IN.codeLabel}
            name="one-time-code"
            inputMode="numeric"
            autoComplete={SIGN_IN_AUTOCOMPLETE.oneTimeCode}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            invalid={fb.field === 'code'}
            error={fb.field === 'code' ? fb.error : null}
            inputRef={fieldRef}
            classNames={classNames}
          />
          <Actions classNames={classNames}>
            <Button type="submit" disabled={busy} classNames={classNames}>
              {SIGN_UP.codeSubmit}
            </Button>
          </Actions>
          <AltLinks
            links={[
              {
                icon: 'refresh',
                label: SIGN_IN.sendNewCode,
                disabled: busy || !resendReady,
                onClick: () =>
                  void sendCode().then((ok) => {
                    if (ok) setView((v) => (v.name === 'code' ? { ...v, resentAt: Date.now() } : v));
                  }),
              },
              { icon: 'back', label: SIGN_IN.differentEmail, onClick: () => go({ name: 'email' }), disabled: busy },
            ]}
            classNames={classNames}
          />
          <Text classNames={classNames}>{SIGN_UP.codeHelp}</Text>
        </form>
      );
      break;
    case 'name':
      body = (
        <form noValidate onSubmit={(e) => void submitName(e)} aria-busy={busy || undefined} {...slot(classNames, 'form')}>
          {summary}
          {heading(SIGN_UP.nameHeading)}
          <Text classNames={classNames}>{SIGN_UP.nameSub(c)}</Text>
          <Field
            id={ids.given}
            label={SIGN_UP.firstName}
            name="given-name"
            autoComplete="given-name"
            value={given}
            onChange={(e) => setGiven(e.target.value)}
            invalid={fb.field === 'given'}
            error={fb.field === 'given' ? fb.error : null}
            inputRef={fieldRef}
            classNames={classNames}
          />
          <Field id={ids.family} label={SIGN_UP.lastName} name="family-name" autoComplete="family-name" value={family} onChange={(e) => setFamily(e.target.value)} classNames={classNames} />
          <Actions classNames={classNames}>
            <Button type="submit" disabled={busy} classNames={classNames}>
              {props.nameButton === 'finish' ? SIGN_UP.finish : SIGN_UP.createAccount}
            </Button>
          </Actions>
        </form>
      );
      break;
    case 'choose':
      body = (
        <ChooseFirstCredential
          passkeysEnabled={props.passkeysEnabled}
          issuer={siteName}
          accountName={email.trim()}
          headingLevel={level}
          onDone={(how) => {
            // ChooseFirstCredential has already set the passkey hint for accountName (register A5a; L9).
            void sendAccountNotice(notices, how === 'password' ? 'password-changed' : 'passkey-added').then((emailed) => go({ name: 'done', emailed }));
          }}
          {...(props.renderQrCode && { renderQrCode: props.renderQrCode })}
          {...(props.checkBreachedPassword !== undefined && { checkBreachedPassword: props.checkBreachedPassword })}
          classNames={classNames}
        />
      );
      break;
    case 'enroll-authenticator':
      body = <AuthenticatorSetup issuer={siteName} accountName={email.trim()} headingLevel={level} onDone={finish} {...(props.renderQrCode && { renderQrCode: props.renderQrCode })} classNames={classNames} />;
      break;
    case 'done':
      body = (
        <div {...slot(classNames, 'form')}>
          <Glyph classNames={classNames} />
          {heading(FIRST_VISIT.doneHeading)}
          <Text classNames={classNames}>{SIGN_UP.doneSub(c)}</Text>
          {view.name === 'done' && view.emailed ? <Text classNames={classNames}>{SIGN_UP.doneEmailed}</Text> : null}
          <Actions classNames={classNames}>
            <Button classNames={classNames} onClick={finish}>
              {FIRST_VISIT.continueTo(c)}
            </Button>
          </Actions>
        </div>
      );
      break;
    case 'finishing':
      body = heading(SIGN_IN.finishing);
      break;
  }

  return (
    <Card name="sign-up" view={view.name} theme={theme} siteName={siteName} bottom={{ extra }} rootRef={rootRef} {...(props.className !== undefined && { className: props.className })} classNames={classNames}>
      {body}
      <StatusRegion status={fb.status} classNames={classNames} />
    </Card>
  );
}
