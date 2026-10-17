import { type ReactNode, useId, useRef, useState } from 'react';
import { registerPasskey, setFirstPassword } from './api.js';
import { AuthenticatorSetup } from './AuthenticatorSetup.js';
import { type PasswordCheckOptions, PasswordForm } from './PasswordForm.js';
import { Actions, Button, Heading, type HeadingLevel, LiveRegions, type StyleProps, Text, slot, useFeedback, useFocusOnViewChange } from './ui.js';

export interface ChooseFirstCredentialProps extends StyleProps, PasswordCheckOptions {
  passkeysEnabled: boolean;
  /** The site's name, shown in the authenticator app. */
  issuer: string;
  /** The account's email (for password managers and the authenticator label). */
  accountName?: string;
  /** Called when a passkey is saved, or a password and authenticator are both set. */
  onDone: () => void;
  /** Shows "Not now". The person keeps signing in with emailed codes until they choose. */
  onSkip?: () => void;
  headingLevel?: HeadingLevel;
  renderQrCode?: (otpauthUri: string) => ReactNode;
}

type Stage = 'choose' | 'password' | 'authenticator';

/**
 * First sign-in after an invite (the emailed code already proved the address): "Save a passkey" in
 * one click, or "Set a password" followed by the authenticator, which isn't optional.
 */
export function ChooseFirstCredential(props: ChooseFirstCredentialProps) {
  const { classNames, passkeysEnabled } = props;
  const errorId = useId();
  const fb = useFeedback();
  const [stage, setStage] = useState<Stage>(passkeysEnabled ? 'choose' : 'password');
  const level = props.headingLevel ?? 2;
  const rootRef = useRef<HTMLDivElement>(null);
  useFocusOnViewChange(rootRef, stage);

  async function savePasskey() {
    const result = await fb.run(registerPasskey, { context: 'passkey-register', busyStatus: 'Waiting for your passkey…' });
    if (result.ok) {
      fb.set({ status: 'Passkey saved.' });
      props.onDone();
    }
  }

  let body: ReactNode;
  if (stage === 'authenticator') {
    body = (
      <AuthenticatorSetup
        issuer={props.issuer}
        {...(props.accountName !== undefined && { accountName: props.accountName })}
        intro="You'll sign in with a password, so this site also asks for a code from an authenticator app. It only takes a minute."
        headingLevel={level}
        onDone={props.onDone}
        {...(props.renderQrCode && { renderQrCode: props.renderQrCode })}
        classNames={classNames}
      />
    );
  } else if (stage === 'password') {
    body = (
      <>
        <PasswordForm
          heading="Set a password"
          intro="Next you'll add an authenticator app, so sign-in takes your password and a 6-digit code."
          headingLevel={level}
          {...(props.accountName !== undefined && { email: props.accountName })}
          submitLabel="Save password"
          context="set-password"
          onSubmit={({ newPassword }) => setFirstPassword(newPassword)}
          onDone={() => setStage('authenticator')}
          {...(passkeysEnabled && { onCancel: () => setStage('choose') })}
          {...(props.checkBreachedPassword !== undefined && { checkBreachedPassword: props.checkBreachedPassword })}
          classNames={classNames}
        />
        {props.onSkip && !passkeysEnabled ? (
          <Actions classNames={classNames}>
            <Button variant="link" classNames={classNames} onClick={props.onSkip}>
              Not now
            </Button>
          </Actions>
        ) : null}
      </>
    );
  } else {
    body = (
      <>
        <Heading level={level} classNames={classNames}>
          Finish setting up your account
        </Heading>
        <Text classNames={classNames}>Choose how you&apos;ll sign in next time, so you don&apos;t need an emailed code.</Text>
        <LiveRegions classNames={classNames} errorId={errorId} error={fb.error} status={fb.status} />
        <Actions classNames={classNames}>
          <Button classNames={classNames} disabled={fb.busy} onClick={() => void savePasskey()}>
            Save a passkey
          </Button>
          <Button variant="secondary" classNames={classNames} disabled={fb.busy} onClick={() => setStage('password')}>
            Set a password instead
          </Button>
          {props.onSkip ? (
            <Button variant="link" classNames={classNames} disabled={fb.busy} onClick={props.onSkip}>
              Not now
            </Button>
          ) : null}
        </Actions>
        <Text classNames={classNames}>A passkey signs you in with Face ID, Touch ID, your device PIN, or your password manager.</Text>
      </>
    );
  }

  return (
    <div ref={rootRef} data-auth-kit="choose-first-credential" {...slot(classNames, 'root', props.className)}>
      {body}
    </div>
  );
}
