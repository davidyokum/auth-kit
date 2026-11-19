import { type FormEvent, type ReactNode, useId, useRef, useState } from 'react';
import { AuthenticatorSetup } from './AuthenticatorSetup.js';
import { tagged, useDriver } from './driver.js';
import { ERRORS, FIRST_VISIT, SIGN_IN, STATUS } from './copy.js';
import { describeAuthError } from './messages.js';
import { Icon } from './icons.js';
import { SIGN_IN_AUTOCOMPLETE, newPasswordProblem } from './ladder.js';
import type { PasswordCheckOptions } from './PasswordForm.js';
import {
  Actions,
  AltLinks,
  Button,
  ErrorSummary,
  Heading,
  type HeadingLevel,
  HiddenUsername,
  PasswordField,
  StatusRegion,
  type StyleProps,
  Text,
  Wait,
  slot,
  useFeedback,
  useFocusOnViewChange,
} from './ui.js';

/** How the person chose to sign in next time. */
export type FirstCredential = 'passkey' | 'password';

export interface ChooseFirstCredentialProps extends StyleProps, PasswordCheckOptions {
  passkeysEnabled: boolean;
  /** The site's name, shown in the authenticator app. */
  issuer: string;
  /**
   * The account's email (for password managers and the authenticator label). With it, a new passkey
   * also sets this browser's passkey hint for the address (register A5a), so the next "Continue" opens
   * the passkey prompt: pass it on a standalone chooser page too.
   */
  accountName?: string;
  /** Called once a passkey is saved (and the hint set), or a password and an authenticator are both set. */
  onDone: (how: FirstCredential) => void;
  headingLevel?: HeadingLevel;
  renderQrCode?: ((otpauthUri: string) => ReactNode) | false;
}

/** Where the chooser is. Exported for the driver (ADR 0025), not from `auth-kit/client`. */
export type FirstCredentialStage = 'choose' | 'create-passkey' | 'create-password' | 'add-totp';
type Stage = FirstCredentialStage;

/**
 * "Choose how you'll sign in next time" (REPORT §3.1 step 4, Card Studio v4; register A1): after the
 * first emailed code from an invite or a sign-up, the person must choose. There's no "Not now": an
 * account left on emailed codes alone would make the backstop the everyday way in.
 *
 * - **Passkey (recommended)**: "Create a passkey", and the browser's own window is the step.
 * - **Password and authenticator app**: "Create a password", then "Add an authenticator app" (the
 *   authenticator isn't optional for a password, ADR 0002).
 *
 * Before passkeys are on (no final domain yet), it goes straight to the password.
 */
export function ChooseFirstCredential(props: ChooseFirstCredentialProps) {
  const { classNames, passkeysEnabled } = props;
  const driver = useDriver();
  const init = driver.initial('choose-first-credential');
  const uid = useId();
  const fb = useFeedback(init?.feedback);
  const [stage, setStage] = useState<Stage>(init?.stage ?? (passkeysEnabled ? 'choose' : 'create-password'));
  const [passkeyFailed, setPasskeyFailed] = useState(init?.passkeyFailed ?? false);
  const [password, setPassword] = useState(init?.password ?? '');
  const level = props.headingLevel ?? 2;
  const rootRef = useRef<HTMLDivElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  // The password the person chose, held until the authenticator's code checks out (ADR 0002, 2026-11-19
  // amendment): saving it first would leave a password without an authenticator if they stopped there,
  // and every page would then send them to authenticator setup.
  // A chooser placed at the authenticator step (preview mode) holds the password it was given.
  const heldPassword = useRef<string | null>(init?.stage === 'add-totp' ? (init.password ?? null) : null);
  const passwordSaved = useRef(false);
  useFocusOnViewChange(rootRef, stage);
  const { set } = fb;

  /**
   * "Create a passkey" (and its Try again): the browser's window opens from the click itself, inside
   * the gesture, so Safari and the phone (hybrid) option keep the user activation WebAuthn needs.
   */
  function createPasskey() {
    if (fb.busy) return;
    setStage('create-passkey');
    setPasskeyFailed(false);
    set({ error: null, field: null, status: null });
    void fb.run(driver.registerPasskey, { context: 'passkey-register' }).then((result) => {
      if (result.ok) {
        set({ status: STATUS.passkeySaved });
        // This browser now has a passkey for the address (register A5a): remember it before moving on.
        const email = props.accountName?.trim();
        void (email ? driver.rememberPasskey(email) : Promise.resolve()).then(() => props.onDone('passkey'));
      } else {
        setPasskeyFailed(true);
      }
    });
  }

  function go(next: Stage) {
    set({ error: null, field: null, status: null });
    setStage(next);
  }

  async function savePassword(event: FormEvent) {
    event.preventDefault();
    if (fb.busy) return;
    const problem = newPasswordProblem(password);
    if (problem) {
      set({ error: problem, field: 'password', status: null });
      passwordRef.current?.focus();
      return;
    }
    set({ busy: true, error: null, field: null, status: STATUS.checkingPassword });
    const breached = await driver.breachedPasswordProblem(password, props.checkBreachedPassword);
    if (breached) {
      set({ busy: false, error: breached, field: 'password', status: null });
      passwordRef.current?.focus();
      return;
    }
    set({ busy: false, status: null });
    // Nothing is saved yet: the password waits for the authenticator's code.
    heldPassword.current = password;
    passwordSaved.current = false;
    setPassword('');
    go('add-totp');
  }

  /**
   * Runs after the authenticator's code checks out and before it's turned on. Safe to repeat: a
   * password already saved isn't saved again. Cognito refusing the password (its own policy, or a
   * breached password) takes the person back to choose another; the checked code is kept, so they
   * aren't asked for one again.
   */
  async function saveHeldPassword(): Promise<void> {
    if (passwordSaved.current) return;
    const held = heldPassword.current;
    if (held === null) throw new Error('auth-kit: no password to save');
    try {
      await driver.setFirstPassword(held);
    } catch (error) {
      const info = describeAuthError(error, 'set-password');
      if (info.kind === 'password-rejected') {
        heldPassword.current = null;
        setStage('create-password');
        set({ error: info.message, field: 'password', status: null, busy: false });
      }
      throw error;
    }
    passwordSaved.current = true;
    heldPassword.current = null;
  }

  let body: ReactNode;
  if (stage === 'add-totp') {
    body = (
      <AuthenticatorSetup
        issuer={props.issuer}
        {...(props.accountName !== undefined && { accountName: props.accountName })}
        headingLevel={level}
        intro={props.renderQrCode === false ? FIRST_VISIT.addTotpThenPasswordNoQr : FIRST_VISIT.addTotpThenPassword}
        beforeTurningOn={saveHeldPassword}
        onDone={() => props.onDone('password')}
        // Nothing is saved until the code checks out, so going back is safe: the password is dropped.
        onCancel={driver.act('back', () => {
          if (passwordSaved.current) return;
          heldPassword.current = null;
          go(passkeysEnabled ? 'choose' : 'create-password');
        })}
        cancelLabel={SIGN_IN.back}
        {...(props.renderQrCode !== undefined && { renderQrCode: props.renderQrCode })}
        classNames={classNames}
      />
    );
  } else if (stage === 'create-password') {
    const passwordId = `${uid}-new-password`;
    const submitPassword = driver.act('submit-new-password', (e: FormEvent) => void savePassword(e));
    body = (
      <form noValidate onSubmit={submitPassword} {...tagged(submitPassword)} aria-busy={fb.busy || undefined} {...slot(classNames, 'form')}>
        <ErrorSummary error={fb.error} fieldId={fb.field === 'password' ? passwordId : undefined} classNames={classNames} />
        <Heading level={level} classNames={classNames}>
          {FIRST_VISIT.createPasswordHeading}
        </Heading>
        <Text classNames={classNames}>{FIRST_VISIT.createPasswordSub}</Text>
        {props.accountName !== undefined ? <HiddenUsername email={props.accountName} /> : null}
        <PasswordField
          id={passwordId}
          label={FIRST_VISIT.newPasswordLabel}
          name="new-password"
          autoComplete={SIGN_IN_AUTOCOMPLETE.newPassword}
          minLength={15}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          invalid={fb.field === 'password'}
          error={fb.field === 'password' ? fb.error : null}
          inputRef={passwordRef}
          classNames={classNames}
        />
        <Actions classNames={classNames}>
          <Button type="submit" disabled={fb.busy} classNames={classNames}>
            {SIGN_IN.continue}
          </Button>
        </Actions>
        {passkeysEnabled ? (
          <AltLinks links={[{ icon: 'fingerprint', label: SIGN_IN.usePasskey, onClick: driver.act('use-passkey', createPasskey), disabled: fb.busy }]} classNames={classNames} />
        ) : null}
        <StatusRegion status={fb.status} classNames={classNames} />
      </form>
    );
  } else if (stage === 'create-passkey') {
    body = (
      <div {...slot(classNames, 'form')}>
        <ErrorSummary error={passkeyFailed ? ERRORS.passkeyCreateFailed : null} classNames={classNames} />
        <Heading level={level} classNames={classNames}>
          {FIRST_VISIT.createPasskeyHeading}
        </Heading>
        <Text classNames={classNames}>{FIRST_VISIT.createPasskeySub}</Text>
        {passkeyFailed ? null : <Wait label={FIRST_VISIT.waitingForDevice} classNames={classNames} />}
        <Actions classNames={classNames}>
          <Button variant="secondary" disabled={fb.busy} classNames={classNames} onClick={driver.act('try-again', createPasskey)}>
            {SIGN_IN.tryAgain}
          </Button>
        </Actions>
        <Text classNames={classNames}>{FIRST_VISIT.passkeyOnPhone}</Text>
        {passkeyFailed ? <Text classNames={classNames}>{FIRST_VISIT.blankWindow}</Text> : null}
        <AltLinks links={[{ icon: 'password', label: SIGN_IN.usePassword, onClick: driver.act('use-password', () => go('create-password')), disabled: fb.busy }]} classNames={classNames} />
        <p {...slot(classNames, 'small')}>{FIRST_VISIT.sharedComputer}</p>
      </div>
    );
  } else {
    body = (
      <div {...slot(classNames, 'form')}>
        <Heading level={level} classNames={classNames}>
          {FIRST_VISIT.chooseHeading}
        </Heading>
        <Text classNames={classNames}>{FIRST_VISIT.chooseSub}</Text>
        <section aria-labelledby={`${uid}-passkey`} data-recommended="" {...slot(classNames, 'choice')}>
          <h2 id={`${uid}-passkey`}>
            <Icon name="fingerprint" />
            {FIRST_VISIT.passkeyOption} <span>{FIRST_VISIT.recommended}</span>
          </h2>
          <p>{FIRST_VISIT.passkeyOptionText}</p>
          <Button classNames={classNames} onClick={driver.act('create-passkey', createPasskey)}>
            {FIRST_VISIT.createPasskey}
          </Button>
        </section>
        <section aria-labelledby={`${uid}-password`} {...slot(classNames, 'choice')}>
          <h2 id={`${uid}-password`}>
            <Icon name="password" />
            {FIRST_VISIT.passwordOption}
          </h2>
          <p>{FIRST_VISIT.passwordOptionText}</p>
          <Button variant="link" classNames={classNames} onClick={driver.act('use-password', () => go('create-password'))}>
            {SIGN_IN.usePassword}
          </Button>
        </section>
        <p {...slot(classNames, 'small')}>{FIRST_VISIT.sharedComputer}</p>
      </div>
    );
  }

  return (
    <div ref={rootRef} data-auth-kit="choose-first-credential" data-auth-kit-view={stage} {...slot(classNames, 'content', props.className)}>
      {body}
    </div>
  );
}
