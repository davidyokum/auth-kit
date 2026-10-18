import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { registerPasskey, setFirstPassword } from './api.js';
import { AuthenticatorSetup } from './AuthenticatorSetup.js';
import { ERRORS, FIRST_VISIT, SIGN_IN, STATUS } from './copy.js';
import { Icon } from './icons.js';
import { SIGN_IN_AUTOCOMPLETE, newPasswordProblem } from './ladder.js';
import { type PasswordCheckOptions, breachedPasswordProblem } from './PasswordForm.js';
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
  /** The account's email (for password managers and the authenticator label). */
  accountName?: string;
  /** Called once a passkey is saved, or a password and an authenticator are both set. */
  onDone: (how: FirstCredential) => void;
  headingLevel?: HeadingLevel;
  renderQrCode?: (otpauthUri: string) => ReactNode;
}

type Stage = 'choose' | 'create-passkey' | 'create-password' | 'add-totp';

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
  const uid = useId();
  const fb = useFeedback();
  const [stage, setStage] = useState<Stage>(passkeysEnabled ? 'choose' : 'create-password');
  const [passkeyFailed, setPasskeyFailed] = useState(false);
  const [password, setPassword] = useState('');
  const level = props.headingLevel ?? 2;
  const rootRef = useRef<HTMLDivElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const started = useRef(0);
  useFocusOnViewChange(rootRef, stage);
  const { set } = fb;

  // The passkey screen opens the browser's window as soon as it shows (the window is the step).
  const [passkeyAttempt, setPasskeyAttempt] = useState(0);
  useEffect(() => {
    if (stage !== 'create-passkey' || started.current === passkeyAttempt + 1) return;
    started.current = passkeyAttempt + 1;
    setPasskeyFailed(false);
    void fb.run(registerPasskey, { context: 'passkey-register' }).then((result) => {
      if (result.ok) {
        set({ status: STATUS.passkeySaved });
        props.onDone('passkey');
      } else {
        setPasskeyFailed(true);
      }
    });
    // fb.run and set are stable; onDone is read when the prompt finishes.
  }, [stage, passkeyAttempt]);

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
    const breached = await breachedPasswordProblem(password, props.checkBreachedPassword);
    if (breached) {
      set({ busy: false, error: breached, field: 'password', status: null });
      passwordRef.current?.focus();
      return;
    }
    set({ busy: false, status: null });
    const result = await fb.run(() => setFirstPassword(password), { context: 'set-password', busyStatus: STATUS.saving });
    if (result.ok) {
      setPassword('');
      go('add-totp');
    } else {
      set({ field: 'password' });
    }
  }

  let body: ReactNode;
  if (stage === 'add-totp') {
    body = (
      <AuthenticatorSetup
        issuer={props.issuer}
        {...(props.accountName !== undefined && { accountName: props.accountName })}
        headingLevel={level}
        onDone={() => props.onDone('password')}
        {...(props.renderQrCode && { renderQrCode: props.renderQrCode })}
        classNames={classNames}
      />
    );
  } else if (stage === 'create-password') {
    const passwordId = `${uid}-new-password`;
    body = (
      <form noValidate onSubmit={(e) => void savePassword(e)} aria-busy={fb.busy || undefined} {...slot(classNames, 'form')}>
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
        {passkeysEnabled ? <AltLinks links={[{ icon: 'fingerprint', label: SIGN_IN.usePasskey, onClick: () => go('create-passkey'), disabled: fb.busy }]} classNames={classNames} /> : null}
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
          <Button variant="secondary" disabled={fb.busy} classNames={classNames} onClick={() => setPasskeyAttempt((n) => n + 1)}>
            {SIGN_IN.tryAgain}
          </Button>
        </Actions>
        <Text classNames={classNames}>{FIRST_VISIT.passkeyOnPhone}</Text>
        <AltLinks links={[{ icon: 'password', label: SIGN_IN.usePassword, onClick: () => go('create-password'), disabled: fb.busy }]} classNames={classNames} />
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
          <Button classNames={classNames} onClick={() => go('create-passkey')}>
            {FIRST_VISIT.createPasskey}
          </Button>
        </section>
        <section aria-labelledby={`${uid}-password`} {...slot(classNames, 'choice')}>
          <h2 id={`${uid}-password`}>
            <Icon name="password" />
            {FIRST_VISIT.passwordOption}
          </h2>
          <p>{FIRST_VISIT.passwordOptionText}</p>
          <Button variant="link" classNames={classNames} onClick={() => go('create-password')}>
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
