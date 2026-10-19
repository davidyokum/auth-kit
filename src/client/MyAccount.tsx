import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  type PasskeyInfo,
  changePassword,
  deletePasskey,
  fetchAccountEmail,
  fetchAuthFactors,
  hasAuthenticator,
  listPasskeys,
  registerPasskey,
  setFirstPassword,
  signOutEverywhere,
} from './api.js';
import { refreshSession } from './api.js';
import { AuthenticatorSetup } from './AuthenticatorSetup.js';
import { MY_ACCOUNT, SELF_SERVICE, SIGN_IN, STATUS } from './copy.js';
import { type AccountNotices, resolveNotices, sendAccountNotice } from './notices.js';
import { forgetPasskey, rememberPasskey } from './passkey-hint.js';
import { checkedHref, hrefOr } from './href.js';
import { Icon } from './icons.js';
import { type ClientAuthFactors, canRemovePasskey } from './ladder.js';
import { describeAuthError } from './messages.js';
import { type PasswordCheckOptions, PasswordForm } from './PasswordForm.js';
import { Actions, Button, Field, Heading, type HeadingLevel, LiveRegions, type StyleProps, Text, slot, useFeedback } from './ui.js';

/** What a self-service server action answers (`ActionResult` from `auth-kit/admin` fits). */
export type SelfServiceResult = { ok: true; message: string } | { ok: false; code: string; error: string };
type ActionResult = SelfServiceResult;

/**
 * A member's own account actions on sign-up sites (register D4): the server actions from
 * `createSelfServiceActions` in `auth-kit/accounts`, passed through the site's own `'use server'` file.
 */
export interface MyAccountSelfService {
  requestEmailChange(input: { newEmail: string }): Promise<ActionResult>;
  confirmEmailChange(input: { code: string }): Promise<ActionResult>;
  deleteMyAccount(input: { confirmEmail: string }): Promise<ActionResult>;
}

export interface MyAccountProps extends StyleProps, PasswordCheckOptions {
  passkeysEnabled: boolean;
  /** The site's name, shown in the authenticator app. */
  issuer: string;
  /** Where "Sign out everywhere" goes afterwards. Default `/sign-in`. A same-site path or an http(s) URL (anything else throws). */
  signedOutPath?: string;
  /** Default: a full page load (`window.location.assign`). */
  navigate?: (path: string) => void;
  /** Reads the person's factors. Default: Cognito `GetUserAuthFactors` from the browser. */
  loadFactors?: () => Promise<ClientAuthFactors>;
  /** Heading level for the page heading; sections use the next level. Default 1. */
  headingLevel?: HeadingLevel;
  renderQrCode?: (otpauthUri: string) => ReactNode;
  /**
   * Sign-up sites (register D4): members change their own email address and delete their own
   * account. Without it, the email is read-only ("ask the site's admin") and there's no delete.
   */
  selfService?: MyAccountSelfService;
  /** The site's name, for "Delete your {Site} account?". */
  siteName?: string;
  /** What happens to a deleted person's items on this site, in one sentence (REPORT §3.1e). */
  itemsNote?: string;
  /** Where "Sign in again to confirm" goes when an action needs a recent sign-in: `signInUrl('/account', { reauth: true })`. A path or an http(s) URL. */
  stepUpHref?: string;
  /** Where a deleted account goes afterwards. Default `/`. A same-site path or an http(s) URL. */
  deletedPath?: string;
  /** Account-change notices (register A10: on by default; see `SignIn`'s `notices`). `false` for a site that doesn't send them. */
  notices?: AccountNotices;
}

/** A value that loads, with the failure kept and explained instead of shown as "none". */
type Loaded<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'failed'; message: string };

function useLoaded<T>(load: () => Promise<T>, context: Parameters<typeof describeAuthError>[1]): [Loaded<T>, () => void] {
  const [value, setValue] = useState<Loaded<T>>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setValue({ state: 'loading' });
    load().then(
      (v) => {
        if (active) setValue({ state: 'ready', value: v });
      },
      (error: unknown) => {
        if (active) setValue({ state: 'failed', message: describeAuthError(error, context).message });
      },
    );
    return () => {
      active = false;
    };
    // Re-runs only on reload(); `load` is read fresh each attempt.
  }, [attempt]);
  return [value, useCallback(() => setAttempt((n) => n + 1), [])];
}

function nextLevel(level: HeadingLevel): HeadingLevel {
  return Math.min(level + 1, 4) as HeadingLevel;
}

function describePasskey(passkey: PasskeyInfo): string {
  const kind = passkey.authenticatorAttachment === 'platform' ? MY_ACCOUNT.onDevice : passkey.authenticatorAttachment === 'cross-platform' ? MY_ACCOUNT.securityKeyOrPhone : null;
  const added = passkey.createdAt ? MY_ACCOUNT.added(new Date(passkey.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' })) : null;
  return [kind, added].filter(Boolean).join(', ');
}

/**
 * My account: the account's email, passkeys (list, add, remove), the authenticator (set up or
 * replace), the password (change, or set one), and "Sign out everywhere". Removing the last way in
 * is refused.
 */
export function MyAccount(props: MyAccountProps) {
  const { classNames, passkeysEnabled } = props;
  // Checked before anything renders: each ends up in an href or window.location.assign.
  const signedOutPath = hrefOr('signedOutPath', props.signedOutPath, '/sign-in');
  const deletedPath = hrefOr('deletedPath', props.deletedPath, '/');
  const stepUpHref = props.stepUpHref !== undefined ? checkedHref('stepUpHref', props.stepUpHref, '/sign-in?reauth=1') : undefined;
  const level = props.headingLevel ?? 1;
  const sub = nextLevel(level);
  const errorId = useId();
  const fb = useFeedback();
  const loadFactors = props.loadFactors ?? fetchAuthFactors;
  const notices = useMemo(() => resolveNotices(props.notices, 'MyAccount'), [props.notices]);
  const [email, reloadEmail] = useLoaded(fetchAccountEmail, 'account');
  const [factors, reloadFactors] = useLoaded(loadFactors, 'account');
  const [passkeys, reloadPasskeys] = useLoaded(() => (passkeysEnabled ? listPasskeys() : Promise.resolve([])), 'account');
  const [totp, reloadTotp] = useLoaded(hasAuthenticator, 'account');
  const [confirmingRemoval, setConfirmingRemoval] = useState<string | null>(null);
  const [editing, setEditing] = useState<'authenticator' | 'password' | 'authenticator-after-password' | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const lastEditing = useRef<typeof editing>(null);

  // Opening or closing an editor removes the button that had focus: move focus to the editor's
  // heading, and back to the section's heading when it closes.
  useEffect(() => {
    const previous = lastEditing.current;
    lastEditing.current = editing;
    if (previous === editing) return;
    const root = rootRef.current;
    if (!root) return;
    if (editing) {
      root
        .querySelector<HTMLElement>(
          ['authenticator-setup', 'change-password', 'set-password'].map((name) => `[data-auth-kit="${name}"] [data-auth-kit-slot="heading"]`).join(', '),
        )
        ?.focus();
    } else if (previous) {
      document.getElementById(`${errorId}-${previous === 'password' ? 'password' : 'authenticator'}`)?.focus();
    }
  }, [editing, errorId]);

  function focusPasskeysHeading() {
    document.getElementById(`${errorId}-passkeys`)?.focus();
  }

  const emailValue = email.state === 'ready' ? email.value : undefined;
  const factorValue = factors.state === 'ready' ? factors.value : null;
  const hasPassword = factorValue?.configured.includes('PASSWORD') ?? false;

  async function addPasskey() {
    const result = await fb.run(registerPasskey, { context: 'passkey-register', busyStatus: STATUS.waitingForPasskey });
    if (result.ok) {
      fb.set({ status: STATUS.passkeySaved });
      // This browser now has a passkey for the account: Continue opens the prompt next time (register A5a).
      if (emailValue !== undefined) await rememberPasskey(emailValue);
      if (await sendAccountNotice(notices, 'passkey-added')) fb.set({ status: STATUS.passkeySavedEmailed });
      reloadPasskeys();
      reloadFactors();
    }
  }

  async function removePasskey(passkey: PasskeyInfo) {
    const result = await fb.run(() => deletePasskey(passkey.id), { context: 'passkey-remove', busyStatus: STATUS.removingPasskey });
    setConfirmingRemoval(null);
    focusPasskeysHeading();
    if (result.ok) {
      fb.set({ status: STATUS.passkeyRemoved });
      // The account's last passkey is gone: this browser stops opening the prompt first (register A5a).
      if (emailValue !== undefined && passkeys.state === 'ready' && passkeys.value.length <= 1) await forgetPasskey(emailValue);
      reloadPasskeys();
      reloadFactors();
    }
  }

  async function signOutAll() {
    const result = await fb.run(signOutEverywhere, { context: 'account', busyStatus: STATUS.signingOutEverywhere });
    if (result.ok) (props.navigate ?? ((path: string) => window.location.assign(path)))(signedOutPath);
  }

  function unavailable(message: string, retry: () => void) {
    return (
      <>
        <Text classNames={classNames}>{MY_ACCOUNT.couldntLoad(message)}</Text>
        <Actions classNames={classNames}>
          <Button variant="secondary" classNames={classNames} onClick={retry}>
            {SIGN_IN.tryAgain}
          </Button>
        </Actions>
      </>
    );
  }

  let passkeySection: ReactNode = null;
  if (passkeysEnabled) {
    let list: ReactNode;
    if (passkeys.state === 'loading') list = <Text classNames={classNames}>{MY_ACCOUNT.loadingPasskeys}</Text>;
    else if (passkeys.state === 'failed') list = unavailable(passkeys.message, reloadPasskeys);
    else if (passkeys.value.length === 0) list = <Text classNames={classNames}>{MY_ACCOUNT.noPasskeys}</Text>;
    else {
      const count = passkeys.value.length;
      list = (
        <ul {...slot(classNames, 'list')}>
          {passkeys.value.map((passkey) => {
            const name = passkey.friendlyName ?? MY_ACCOUNT.passkeyName;
            const check = canRemovePasskey({ passkeyCount: count, factors: factorValue });
            const confirming = confirmingRemoval === passkey.id;
            return (
              <li key={passkey.id} {...slot(classNames, 'listItem')}>
                <span>{name}</span> {describePasskey(passkey) ? <span>({describePasskey(passkey)})</span> : null}{' '}
                {confirming ? (
                  <span role="group" aria-label={MY_ACCOUNT.removeQuestion(name)}>
                    <span>{MY_ACCOUNT.removeConfirm(name)}</span>{' '}
                    <Button variant="secondary" classNames={classNames} disabled={fb.busy} autoFocus onClick={() => void removePasskey(passkey)}>
                      {MY_ACCOUNT.removePasskey}
                    </Button>{' '}
                    <Button
                      variant="link"
                      classNames={classNames}
                      disabled={fb.busy}
                      onClick={() => {
                        setConfirmingRemoval(null);
                        focusPasskeysHeading();
                      }}
                    >
                      {MY_ACCOUNT.keepIt}
                    </Button>
                  </span>
                ) : (
                  <Button
                    variant="link"
                    classNames={classNames}
                    disabled={fb.busy}
                    aria-label={MY_ACCOUNT.removeLabel(name)}
                    onClick={() => {
                      if (!check.allowed) {
                        fb.set({ error: check.reason ?? MY_ACCOUNT.cantRemove, status: null });
                        return;
                      }
                      fb.set({ error: null });
                      setConfirmingRemoval(passkey.id);
                    }}
                  >
                    {MY_ACCOUNT.remove}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      );
    }
    passkeySection = (
      <section aria-labelledby={`${errorId}-passkeys`} {...slot(classNames, 'section')}>
        <Heading level={sub} classNames={classNames} id={`${errorId}-passkeys`}>
          <Icon name="fingerprint" />
          {MY_ACCOUNT.passkeysHeading}
        </Heading>
        <Text classNames={classNames}>{MY_ACCOUNT.passkeysIntro}</Text>
        {list}
        <Actions classNames={classNames}>
          <Button classNames={classNames} disabled={fb.busy} onClick={() => void addPasskey()}>
            {MY_ACCOUNT.addPasskey}
          </Button>
        </Actions>
      </section>
    );
  }

  let authenticatorBody: ReactNode;
  if (editing === 'authenticator' || editing === 'authenticator-after-password') {
    authenticatorBody = (
      <AuthenticatorSetup
        issuer={props.issuer}
        {...(emailValue !== undefined && { accountName: emailValue })}
        heading={editing === 'authenticator-after-password' ? MY_ACCOUNT.nowAddHeading : totp.state === 'ready' && totp.value ? MY_ACCOUNT.replaceHeading : MY_ACCOUNT.setUpHeading}
        {...(editing === 'authenticator-after-password' && {
          intro: MY_ACCOUNT.nowAddIntro,
        })}
        headingLevel={nextLevel(sub)}
        onDone={() => {
          setEditing(null);
          fb.set({ status: STATUS.authenticatorOn });
          reloadTotp();
          reloadFactors();
        }}
        {...(editing === 'authenticator' && { onCancel: () => setEditing(null) })}
        {...(props.renderQrCode && { renderQrCode: props.renderQrCode })}
        classNames={classNames}
      />
    );
  } else if (totp.state === 'loading') {
    authenticatorBody = <Text classNames={classNames}>{MY_ACCOUNT.loading}</Text>;
  } else if (totp.state === 'failed') {
    authenticatorBody = unavailable(totp.message, reloadTotp);
  } else {
    authenticatorBody = (
      <>
        <Text classNames={classNames}>
          {totp.value ? MY_ACCOUNT.totpOn : hasPassword ? MY_ACCOUNT.totpOffNeeded : MY_ACCOUNT.totpOff}
        </Text>
        <Actions classNames={classNames}>
          <Button variant={totp.value ? 'secondary' : 'primary'} classNames={classNames} disabled={fb.busy} onClick={() => setEditing('authenticator')}>
            {totp.value ? MY_ACCOUNT.replace : MY_ACCOUNT.setUp}
          </Button>
        </Actions>
      </>
    );
  }

  let passwordBody: ReactNode;
  if (factors.state === 'loading') passwordBody = <Text classNames={classNames}>{MY_ACCOUNT.loading}</Text>;
  else if (factors.state === 'failed') passwordBody = unavailable(factors.message, reloadFactors);
  else if (editing === 'password') {
    passwordBody = hasPassword ? (
      <PasswordForm
        name="change-password"
        heading={MY_ACCOUNT.changePasswordHeading}
        headingLevel={nextLevel(sub)}
        askCurrent
        {...(emailValue !== undefined && { email: emailValue })}
        submitLabel={MY_ACCOUNT.changePassword}
        context="change-password"
        onSubmit={({ currentPassword, newPassword }) => changePassword(currentPassword ?? '', newPassword)}
        onDone={() => {
          setEditing(null);
          fb.set({ status: STATUS.passwordChanged });
          void sendAccountNotice(notices, 'password-changed').then((emailed) => {
            if (emailed) fb.set({ status: STATUS.passwordChangedEmailed });
          });
        }}
        onCancel={() => setEditing(null)}
        {...(props.checkBreachedPassword !== undefined && { checkBreachedPassword: props.checkBreachedPassword })}
        classNames={classNames}
      />
    ) : (
      <PasswordForm
        name="set-password"
        heading={MY_ACCOUNT.setPassword}
        intro={MY_ACCOUNT.setPasswordIntro}
        headingLevel={nextLevel(sub)}
        {...(emailValue !== undefined && { email: emailValue })}
        submitLabel={MY_ACCOUNT.savePassword}
        context="set-password"
        onSubmit={({ newPassword }) => setFirstPassword(newPassword)}
        onDone={() => {
          void sendAccountNotice(notices, 'password-changed');
          reloadFactors();
          reloadTotp();
          // The standard requires the authenticator of every password user; go straight to it.
          setEditing(totp.state === 'ready' && totp.value ? null : 'authenticator-after-password');
        }}
        onCancel={() => setEditing(null)}
        {...(props.checkBreachedPassword !== undefined && { checkBreachedPassword: props.checkBreachedPassword })}
        classNames={classNames}
      />
    );
  } else {
    passwordBody = (
      <>
        <Text classNames={classNames}>{hasPassword ? MY_ACCOUNT.hasPassword : MY_ACCOUNT.noPassword}</Text>
        <Actions classNames={classNames}>
          <Button variant="secondary" classNames={classNames} disabled={fb.busy || editing !== null} onClick={() => setEditing('password')}>
            {hasPassword ? MY_ACCOUNT.changePassword : MY_ACCOUNT.setPassword}
          </Button>
        </Actions>
      </>
    );
  }

  return (
    <div ref={rootRef} data-auth-kit="my-account" {...slot(classNames, 'root', props.className)}>
      <Heading level={level} classNames={classNames}>
        {MY_ACCOUNT.heading}
      </Heading>
      <LiveRegions classNames={classNames} errorId={errorId} error={fb.error} status={fb.status} />
      <section aria-labelledby={`${errorId}-email`} {...slot(classNames, 'section')}>
        <Heading level={sub} classNames={classNames} id={`${errorId}-email`}>
          {MY_ACCOUNT.emailHeading}
        </Heading>
        {email.state === 'loading' ? (
          <Text classNames={classNames}>{MY_ACCOUNT.loading}</Text>
        ) : email.state === 'failed' ? (
          unavailable(email.message, reloadEmail)
        ) : (
          <Text classNames={classNames}>{email.value ?? MY_ACCOUNT.noEmail}</Text>
        )}
        {props.selfService ? (
          <EmailChange selfService={props.selfService} level={nextLevel(sub)} classNames={classNames} {...(stepUpHref !== undefined && { stepUpHref })} onChanged={reloadEmail} />
        ) : (
          <Text classNames={classNames}>{SELF_SERVICE.askAdmin}</Text>
        )}
      </section>
      {passkeySection}
      <section aria-labelledby={`${errorId}-authenticator`} {...slot(classNames, 'section')}>
        <Heading level={sub} classNames={classNames} id={`${errorId}-authenticator`}>
          {MY_ACCOUNT.authenticatorHeading}
        </Heading>
        {authenticatorBody}
      </section>
      <section aria-labelledby={`${errorId}-password`} {...slot(classNames, 'section')}>
        <Heading level={sub} classNames={classNames} id={`${errorId}-password`}>
          <Icon name="password" />
          {MY_ACCOUNT.passwordHeading}
        </Heading>
        {passwordBody}
      </section>
      <section aria-labelledby={`${errorId}-signout`} {...slot(classNames, 'section')}>
        <Heading level={sub} classNames={classNames} id={`${errorId}-signout`}>
          {MY_ACCOUNT.signOutHeading}
        </Heading>
        <Text classNames={classNames}>{MY_ACCOUNT.signOutIntro}</Text>
        <Actions classNames={classNames}>
          <Button variant="secondary" classNames={classNames} disabled={fb.busy} onClick={() => void signOutAll()}>
            {MY_ACCOUNT.signOut}
          </Button>
        </Actions>
      </section>
      {props.selfService ? (
        <DeleteAccount
          selfService={props.selfService}
          email={emailValue}
          {...(props.siteName !== undefined && { siteName: props.siteName })}
          level={sub}
          classNames={classNames}
          {...(props.itemsNote !== undefined && { itemsNote: props.itemsNote })}
          {...(stepUpHref !== undefined && { stepUpHref })}
          onDeleted={() => (props.navigate ?? ((path: string) => window.location.assign(path)))(deletedPath)}
        />
      ) : null}
    </div>
  );
}

/** An action's result, said plainly; "Sign in again to confirm" when it needs a recent sign-in. */
function ResultLine(props: { result: ActionResult | null; stepUpHref?: string; classNames: StyleProps['classNames'] }) {
  if (!props.result) return null;
  if (props.result.ok) {
    return (
      <p role="status" {...slot(props.classNames, 'status')}>
        {props.result.message}
      </p>
    );
  }
  return (
    <div role="alert" {...slot(props.classNames, 'error')}>
      <p>{props.result.error}</p>
      {props.result.code === 'step_up_required' && props.stepUpHref ? (
        <p>
          <a href={props.stepUpHref} {...slot(props.classNames, 'link')}>
            {SELF_SERVICE.signInAgain}
          </a>
        </p>
      ) : null}
    </div>
  );
}

/** "Change your email address": a code to the new address, then the change (D4; verified before it takes effect). */
function EmailChange(props: { selfService: MyAccountSelfService; level: HeadingLevel; stepUpHref?: string; onChanged: () => void; classNames: StyleProps['classNames'] }) {
  const { classNames } = props;
  const [stage, setStage] = useState<'closed' | 'address' | 'code'>('closed');
  const [newEmail, setNewEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);

  async function run(task: () => Promise<ActionResult>, onOk: () => void) {
    setBusy(true);
    let r: ActionResult;
    try {
      r = await task();
    } catch {
      r = { ok: false, code: 'unavailable', error: MY_ACCOUNT.unreachable };
    }
    setBusy(false);
    setResult(r);
    if (r.ok) onOk();
  }

  if (stage === 'closed') {
    return (
      <>
        <ResultLine result={result} classNames={classNames} {...(props.stepUpHref !== undefined && { stepUpHref: props.stepUpHref })} />
        <Actions classNames={classNames}>
          <Button variant="secondary" classNames={classNames} onClick={() => (setResult(null), setStage('address'))}>
            {SELF_SERVICE.changeEmail}
          </Button>
        </Actions>
      </>
    );
  }
  return (
    <div data-auth-kit="change-email" {...slot(classNames, 'section')}>
      <Heading level={props.level} classNames={classNames}>
        {SELF_SERVICE.changeEmailHeading}
      </Heading>
      <Text classNames={classNames}>{SELF_SERVICE.changeEmailSub}</Text>
      <ResultLine result={result} classNames={classNames} {...(props.stepUpHref !== undefined && { stepUpHref: props.stepUpHref })} />
      {stage === 'address' ? (
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) void run(() => props.selfService.requestEmailChange({ newEmail: newEmail.trim() }), () => setStage('code'));
          }}
          {...slot(classNames, 'form')}
        >
          <Field label={SELF_SERVICE.newEmailLabel} type="email" name="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} value={newEmail} onChange={(e) => setNewEmail(e.target.value)} classNames={classNames} />
          <Actions classNames={classNames}>
            <Button type="submit" disabled={busy} classNames={classNames}>
              {SELF_SERVICE.sendCode}
            </Button>
            <Button variant="link" classNames={classNames} onClick={() => (setResult(null), setStage('closed'))}>
              {SELF_SERVICE.cancel}
            </Button>
          </Actions>
        </form>
      ) : (
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy)
              void run(
                () => props.selfService.confirmEmailChange({ code: code.trim() }),
                () => {
                  setStage('closed');
                  setCode('');
                  setNewEmail('');
                  // New tokens carry the new address.
                  void refreshSession().catch(() => undefined).then(props.onChanged);
                },
              );
          }}
          {...slot(classNames, 'form')}
        >
          <Field label={SELF_SERVICE.codeLabel} name="one-time-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} classNames={classNames} />
          <Actions classNames={classNames}>
            <Button type="submit" disabled={busy} classNames={classNames}>
              {SELF_SERVICE.confirm}
            </Button>
            <Button variant="link" classNames={classNames} onClick={() => (setResult(null), setStage('closed'))}>
              {SELF_SERVICE.cancel}
            </Button>
          </Actions>
        </form>
      )}
    </div>
  );
}

/** "Delete your {Site} account?" (REPORT §3.1e): a recent sign-in and the address typed out; never the owner (the server refuses). */
function DeleteAccount(props: {
  selfService: MyAccountSelfService;
  email: string | undefined;
  siteName?: string;
  itemsNote?: string;
  level: HeadingLevel;
  stepUpHref?: string;
  onDeleted: () => void;
  classNames: StyleProps['classNames'];
}) {
  const { classNames } = props;
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  return (
    <section data-auth-kit="delete-account" {...slot(classNames, 'section')}>
      <Heading level={props.level} classNames={classNames}>
        {open ? SELF_SERVICE.deleteConfirmHeading(props.siteName !== undefined ? { siteName: props.siteName } : {}) : SELF_SERVICE.deleteHeading}
      </Heading>
      {open ? (
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (busy) return;
            setBusy(true);
            void props.selfService
              .deleteMyAccount({ confirmEmail: typed.trim() })
              .catch((): ActionResult => ({ ok: false, code: 'unavailable', error: MY_ACCOUNT.unreachable }))
              .then((r) => {
                setBusy(false);
                setResult(r);
                if (r.ok) props.onDeleted();
              });
          }}
          {...slot(classNames, 'form')}
        >
          <Text classNames={classNames}>
            {SELF_SERVICE.deleteConfirmSub}
            {props.itemsNote ? ` ${props.itemsNote}` : ''}
          </Text>
          <Field
            label={SELF_SERVICE.deleteConfirmLabel}
            type="email"
            name="confirm-email"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            {...(props.email !== undefined && { placeholder: props.email })}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            classNames={classNames}
          />
          <ResultLine result={result} classNames={classNames} {...(props.stepUpHref !== undefined && { stepUpHref: props.stepUpHref })} />
          <Actions classNames={classNames}>
            <Button type="submit" disabled={busy || typed.trim() === ''} classNames={classNames} data-danger="">
              {SELF_SERVICE.deleteButton}
            </Button>
            <Button variant="link" classNames={classNames} onClick={() => (setOpen(false), setResult(null), setTyped(''))}>
              {SELF_SERVICE.keep}
            </Button>
          </Actions>
        </form>
      ) : (
        <>
          <Text classNames={classNames}>{SELF_SERVICE.deleteIntro}</Text>
          <Actions classNames={classNames}>
            <Button variant="secondary" classNames={classNames} onClick={() => setOpen(true)}>
              {SELF_SERVICE.deleteButton}
            </Button>
          </Actions>
        </>
      )}
    </section>
  );
}
