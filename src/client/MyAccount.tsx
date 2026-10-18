import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
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
import { SELF_SERVICE } from './copy.js';
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
  /** Where "Sign out everywhere" goes afterwards. Default `/sign-in`. */
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
  /** Where "Sign in again to confirm" goes when an action needs a recent sign-in: `signInUrl('/account', { reauth: true })`. */
  stepUpHref?: string;
  /** Where a deleted account goes afterwards. Default `/`. */
  deletedPath?: string;
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
  const kind = passkey.authenticatorAttachment === 'platform' ? 'On a device' : passkey.authenticatorAttachment === 'cross-platform' ? 'Security key or phone' : null;
  const added = passkey.createdAt ? `added ${new Date(passkey.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}` : null;
  return [kind, added].filter(Boolean).join(', ');
}

/**
 * My account: the account's email, passkeys (list, add, remove), the authenticator (set up or
 * replace), the password (change, or set one), and "Sign out everywhere". Removing the last way in
 * is refused.
 */
export function MyAccount(props: MyAccountProps) {
  const { classNames, passkeysEnabled } = props;
  const level = props.headingLevel ?? 1;
  const sub = nextLevel(level);
  const errorId = useId();
  const fb = useFeedback();
  const loadFactors = props.loadFactors ?? fetchAuthFactors;
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
    const result = await fb.run(registerPasskey, { context: 'passkey-register', busyStatus: 'Waiting for your passkey…' });
    if (result.ok) {
      fb.set({ status: 'Passkey saved.' });
      reloadPasskeys();
      reloadFactors();
    }
  }

  async function removePasskey(passkey: PasskeyInfo) {
    const result = await fb.run(() => deletePasskey(passkey.id), { context: 'passkey-remove', busyStatus: 'Removing the passkey…' });
    setConfirmingRemoval(null);
    focusPasskeysHeading();
    if (result.ok) {
      fb.set({ status: 'Passkey removed.' });
      reloadPasskeys();
      reloadFactors();
    }
  }

  async function signOutAll() {
    const result = await fb.run(signOutEverywhere, { context: 'account', busyStatus: 'Signing out everywhere…' });
    if (result.ok) (props.navigate ?? ((path: string) => window.location.assign(path)))(props.signedOutPath ?? '/sign-in');
  }

  function unavailable(message: string, retry: () => void) {
    return (
      <>
        <Text classNames={classNames}>Couldn&apos;t load this. {message}</Text>
        <Actions classNames={classNames}>
          <Button variant="secondary" classNames={classNames} onClick={retry}>
            Try again
          </Button>
        </Actions>
      </>
    );
  }

  let passkeySection: ReactNode = null;
  if (passkeysEnabled) {
    let list: ReactNode;
    if (passkeys.state === 'loading') list = <Text classNames={classNames}>Loading your passkeys…</Text>;
    else if (passkeys.state === 'failed') list = unavailable(passkeys.message, reloadPasskeys);
    else if (passkeys.value.length === 0) list = <Text classNames={classNames}>No passkeys yet.</Text>;
    else {
      const count = passkeys.value.length;
      list = (
        <ul {...slot(classNames, 'list')}>
          {passkeys.value.map((passkey) => {
            const name = passkey.friendlyName ?? 'Passkey';
            const check = canRemovePasskey({ passkeyCount: count, factors: factorValue });
            const confirming = confirmingRemoval === passkey.id;
            return (
              <li key={passkey.id} {...slot(classNames, 'listItem')}>
                <span>{name}</span> {describePasskey(passkey) ? <span>({describePasskey(passkey)})</span> : null}{' '}
                {confirming ? (
                  <span role="group" aria-label={`Remove ${name}?`}>
                    <span>Remove {name}? You won&apos;t be able to sign in with it.</span>{' '}
                    <Button variant="secondary" classNames={classNames} disabled={fb.busy} autoFocus onClick={() => void removePasskey(passkey)}>
                      Remove passkey
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
                      Keep it
                    </Button>
                  </span>
                ) : (
                  <Button
                    variant="link"
                    classNames={classNames}
                    disabled={fb.busy}
                    aria-label={`Remove ${name}`}
                    onClick={() => {
                      if (!check.allowed) {
                        fb.set({ error: check.reason ?? "This passkey can't be removed right now.", status: null });
                        return;
                      }
                      fb.set({ error: null });
                      setConfirmingRemoval(passkey.id);
                    }}
                  >
                    Remove
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
          Passkeys
        </Heading>
        <Text classNames={classNames}>Sign in with Face ID, Touch ID, your device PIN, or your password manager. Nobody else can see or remove these.</Text>
        {list}
        <Actions classNames={classNames}>
          <Button classNames={classNames} disabled={fb.busy} onClick={() => void addPasskey()}>
            Add a passkey
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
        heading={editing === 'authenticator-after-password' ? 'Now add your authenticator' : totp.state === 'ready' && totp.value ? 'Replace your authenticator' : 'Set up your authenticator'}
        {...(editing === 'authenticator-after-password' && {
          intro: 'You sign in with a password now, so this site also asks for a code from an authenticator app.',
        })}
        headingLevel={nextLevel(sub)}
        onDone={() => {
          setEditing(null);
          fb.set({ status: 'Your authenticator is on.' });
          reloadTotp();
          reloadFactors();
        }}
        {...(editing === 'authenticator' && { onCancel: () => setEditing(null) })}
        {...(props.renderQrCode && { renderQrCode: props.renderQrCode })}
        classNames={classNames}
      />
    );
  } else if (totp.state === 'loading') {
    authenticatorBody = <Text classNames={classNames}>Loading…</Text>;
  } else if (totp.state === 'failed') {
    authenticatorBody = unavailable(totp.message, reloadTotp);
  } else {
    authenticatorBody = (
      <>
        <Text classNames={classNames}>
          {totp.value
            ? 'On. Sign-in with your password also asks for a 6-digit code from it.'
            : hasPassword
              ? 'Off. You sign in with a password, so set one up now.'
              : 'Off. You only need one if you sign in with a password.'}
        </Text>
        <Actions classNames={classNames}>
          <Button variant={totp.value ? 'secondary' : 'primary'} classNames={classNames} disabled={fb.busy} onClick={() => setEditing('authenticator')}>
            {totp.value ? 'Replace authenticator' : 'Set up authenticator'}
          </Button>
        </Actions>
      </>
    );
  }

  let passwordBody: ReactNode;
  if (factors.state === 'loading') passwordBody = <Text classNames={classNames}>Loading…</Text>;
  else if (factors.state === 'failed') passwordBody = unavailable(factors.message, reloadFactors);
  else if (editing === 'password') {
    passwordBody = hasPassword ? (
      <PasswordForm
        name="change-password"
        heading="Change your password"
        headingLevel={nextLevel(sub)}
        askCurrent
        {...(emailValue !== undefined && { email: emailValue })}
        submitLabel="Change password"
        context="change-password"
        onSubmit={({ currentPassword, newPassword }) => changePassword(currentPassword ?? '', newPassword)}
        onDone={() => {
          setEditing(null);
          fb.set({ status: 'Password changed.' });
        }}
        onCancel={() => setEditing(null)}
        {...(props.checkBreachedPassword !== undefined && { checkBreachedPassword: props.checkBreachedPassword })}
        classNames={classNames}
      />
    ) : (
      <PasswordForm
        name="set-password"
        heading="Set a password"
        intro="After this you'll add an authenticator app: sign-in with a password always asks for its code too."
        headingLevel={nextLevel(sub)}
        {...(emailValue !== undefined && { email: emailValue })}
        submitLabel="Save password"
        context="set-password"
        onSubmit={({ newPassword }) => setFirstPassword(newPassword)}
        onDone={() => {
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
        <Text classNames={classNames}>{hasPassword ? 'You have a password.' : "You don't have a password. You don't need one if you use a passkey."}</Text>
        <Actions classNames={classNames}>
          <Button variant="secondary" classNames={classNames} disabled={fb.busy || editing !== null} onClick={() => setEditing('password')}>
            {hasPassword ? 'Change password' : 'Set a password'}
          </Button>
        </Actions>
      </>
    );
  }

  return (
    <div ref={rootRef} data-auth-kit="my-account" {...slot(classNames, 'root', props.className)}>
      <Heading level={level} classNames={classNames}>
        My account
      </Heading>
      <LiveRegions classNames={classNames} errorId={errorId} error={fb.error} status={fb.status} />
      <section aria-labelledby={`${errorId}-email`} {...slot(classNames, 'section')}>
        <Heading level={sub} classNames={classNames} id={`${errorId}-email`}>
          Email
        </Heading>
        {email.state === 'loading' ? (
          <Text classNames={classNames}>Loading…</Text>
        ) : email.state === 'failed' ? (
          unavailable(email.message, reloadEmail)
        ) : (
          <Text classNames={classNames}>{email.value ?? 'No email address on this account.'}</Text>
        )}
        {props.selfService ? (
          <EmailChange selfService={props.selfService} level={nextLevel(sub)} classNames={classNames} {...(props.stepUpHref !== undefined && { stepUpHref: props.stepUpHref })} onChanged={reloadEmail} />
        ) : (
          <Text classNames={classNames}>{SELF_SERVICE.askAdmin}</Text>
        )}
      </section>
      {passkeySection}
      <section aria-labelledby={`${errorId}-authenticator`} {...slot(classNames, 'section')}>
        <Heading level={sub} classNames={classNames} id={`${errorId}-authenticator`}>
          Authenticator app
        </Heading>
        {authenticatorBody}
      </section>
      <section aria-labelledby={`${errorId}-password`} {...slot(classNames, 'section')}>
        <Heading level={sub} classNames={classNames} id={`${errorId}-password`}>
          <Icon name="password" />
          Password
        </Heading>
        {passwordBody}
      </section>
      <section aria-labelledby={`${errorId}-signout`} {...slot(classNames, 'section')}>
        <Heading level={sub} classNames={classNames} id={`${errorId}-signout`}>
          Sign out everywhere
        </Heading>
        <Text classNames={classNames}>Ends your sessions on every device, including this one. Pages already open elsewhere can keep working for up to an hour.</Text>
        <Actions classNames={classNames}>
          <Button variant="secondary" classNames={classNames} disabled={fb.busy} onClick={() => void signOutAll()}>
            Sign out everywhere
          </Button>
        </Actions>
      </section>
      {props.selfService ? (
        <DeleteAccount
          selfService={props.selfService}
          email={emailValue}
          siteName={props.siteName ?? 'this site'}
          level={sub}
          classNames={classNames}
          {...(props.itemsNote !== undefined && { itemsNote: props.itemsNote })}
          {...(props.stepUpHref !== undefined && { stepUpHref: props.stepUpHref })}
          onDeleted={() => (props.navigate ?? ((path: string) => window.location.assign(path)))(props.deletedPath ?? '/')}
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
      r = { ok: false, code: 'unavailable', error: 'We couldn’t reach the site just now. Try again in a moment.' };
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
  siteName: string;
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
        {open ? SELF_SERVICE.deleteConfirmHeading({ siteName: props.siteName }) : SELF_SERVICE.deleteHeading}
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
              .catch((): ActionResult => ({ ok: false, code: 'unavailable', error: 'We couldn’t reach the site just now. Try again in a moment.' }))
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
