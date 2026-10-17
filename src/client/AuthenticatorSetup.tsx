import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { type AuthenticatorEnrollment, enrollAuthenticator, fetchAccountEmail } from './api.js';
import { SIGN_IN_AUTOCOMPLETE, normalizeCode } from './ladder.js';
import { describeAuthError } from './messages.js';
import { buildOtpauthUri, formatSetupKey } from './totp.js';
import { Actions, Button, Field, Heading, type HeadingLevel, LiveRegions, type StyleProps, Text, slot, useFeedback } from './ui.js';

export interface AuthenticatorSetupProps extends StyleProps {
  /** The name shown in the authenticator app, usually the site's name. */
  issuer: string;
  /** The account label in the authenticator app. Default: the account's email. */
  accountName?: string;
  /**
   * Sign-in mode (Cognito's MFA_SETUP challenge): the setup key Cognito already issued, and how to
   * answer it. Omit to start a fresh setup for the signed-in person (`setUpTOTP`).
   */
  enrollment?: { secret: string; verify: (code: string) => Promise<void> };
  /** Called once the authenticator is on (tokens are already refreshed in the default mode). */
  onDone?: () => void;
  /** Shows a cancel button. Leave it out where setup is required. */
  onCancel?: () => void;
  cancelLabel?: string;
  heading?: ReactNode;
  /** A sentence under the heading saying why this is needed. */
  intro?: ReactNode;
  headingLevel?: HeadingLevel;
  /**
   * Renders a QR code for the `otpauth://` link (auth-kit ships none, to stay dependency-free):
   * `renderQrCode={(uri) => <QRCodeSVG value={uri} title="Authenticator setup QR code" />}`.
   */
  renderQrCode?: (otpauthUri: string) => ReactNode;
  /** A name for this authenticator in Cognito. */
  deviceName?: string;
}

/**
 * Adds an authenticator (TOTP): a setup link and key (and an optional QR code), then one code to
 * confirm. Used on its own (My account, the enrollment gate, the setup page) and inside sign-in.
 */
export function AuthenticatorSetup(props: AuthenticatorSetupProps) {
  const { classNames, issuer, enrollment, deviceName } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const fb = useFeedback();
  const [account, setAccount] = useState(props.accountName);
  const [started, setStarted] = useState<AuthenticatorEnrollment | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [code, setCode] = useState('');
  // One setup per attempt, even when React runs effects twice in development: a second
  // AssociateSoftwareToken would replace the key on screen.
  const pending = useRef<{ attempt: number; promise: Promise<AuthenticatorEnrollment> } | null>(null);
  const { set } = fb;

  useEffect(() => {
    if (props.accountName !== undefined) {
      setAccount(props.accountName);
      return;
    }
    let active = true;
    fetchAccountEmail().then(
      (email) => {
        if (active && email) setAccount(email);
      },
      () => {
        // The label is a convenience; the setup works without it.
      },
    );
    return () => {
      active = false;
    };
  }, [props.accountName]);

  useEffect(() => {
    if (enrollment) return;
    let active = true;
    if (pending.current?.attempt !== attempt) {
      pending.current = { attempt, promise: enrollAuthenticator({ issuer, ...(deviceName !== undefined && { deviceName }) }) };
    }
    pending.current.promise.then(
      (result) => {
        if (!active) return;
        setStarted(result);
        set({ status: null });
      },
      (error: unknown) => {
        if (!active) return;
        setLoadFailed(true);
        set({ error: describeAuthError(error, 'authenticator-setup').message, status: null });
      },
    );
    return () => {
      active = false;
    };
  }, [attempt, enrollment, issuer, deviceName, set]);

  const secret = enrollment?.secret ?? started?.secret ?? null;
  const verify = enrollment?.verify ?? started?.verify ?? null;
  const uri = secret ? buildOtpauthUri({ secret, issuer, ...(account !== undefined && { accountName: account }) }) : null;

  function retry() {
    setLoadFailed(false);
    set({ error: null, status: 'Preparing your setup key…' });
    setAttempt((n) => n + 1);
  }

  function copy() {
    if (!secret) return;
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (!clipboard) {
      set({ error: "Couldn't copy here. Select the key and copy it instead." });
      return;
    }
    clipboard.writeText(secret.replace(/\s/g, '')).then(
      () => set({ status: 'Setup key copied.', error: null }),
      () => set({ error: "Couldn't copy here. Select the key and copy it instead." }),
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!verify || fb.busy) return;
    const normalized = normalizeCode(code);
    if (!/^\d{6}$/.test(normalized)) {
      set({ error: 'Enter the 6-digit code from your authenticator.', field: 'code', status: null });
      codeRef.current?.focus();
      return;
    }
    const result = await fb.run(() => verify(normalized), { context: 'authenticator-setup', busyStatus: 'Checking the code…' });
    if (result.ok) {
      set({ status: 'Your authenticator is on.' });
      props.onDone?.();
    } else {
      setCode('');
      set({ field: 'code' });
      codeRef.current?.focus();
    }
  }

  return (
    <div ref={rootRef} data-auth-kit="authenticator-setup" {...slot(classNames, 'root', props.className)}>
      <Heading level={props.headingLevel ?? 2} classNames={classNames}>
        {props.heading ?? 'Set up your authenticator'}
      </Heading>
      {props.intro ? <Text classNames={classNames}>{props.intro}</Text> : null}
      <LiveRegions classNames={classNames} errorId={errorId} error={fb.error} status={fb.status ?? (!secret && !loadFailed ? 'Preparing your setup key…' : null)} />
      {loadFailed ? (
        <Actions classNames={classNames}>
          <Button classNames={classNames} onClick={retry}>
            Try again
          </Button>
          {props.onCancel ? (
            <Button variant="link" classNames={classNames} onClick={props.onCancel}>
              {props.cancelLabel ?? 'Cancel'}
            </Button>
          ) : null}
        </Actions>
      ) : null}
      {secret && uri ? (
        <form noValidate onSubmit={(e) => void submit(e)} aria-busy={fb.busy || undefined} {...slot(classNames, 'form')}>
          <ol {...slot(classNames, 'list')}>
            <li {...slot(classNames, 'listItem')}>
              Add {issuer} to your authenticator app or password manager.{' '}
              <a href={uri} {...slot(classNames, 'link')}>
                Open the setup link
              </a>
              {props.renderQrCode ? <> or scan this code: {props.renderQrCode(uri)}</> : null}
              {', or enter this setup key: '}
              <code {...slot(classNames, 'code')}>{formatSetupKey(secret)}</code>{' '}
              <Button variant="secondary" classNames={classNames} onClick={copy}>
                Copy setup key
              </Button>
            </li>
            <li {...slot(classNames, 'listItem')}>Enter the 6-digit code it shows.</li>
          </ol>
          <Field
            label="6-digit code"
            name="one-time-code"
            inputMode="numeric"
            autoComplete={SIGN_IN_AUTOCOMPLETE.oneTimeCode}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            invalid={fb.field === 'code'}
            errorId={errorId}
            inputRef={codeRef}
            classNames={classNames}
          />
          <Actions classNames={classNames}>
            <Button type="submit" disabled={fb.busy} classNames={classNames}>
              {enrollment ? 'Continue' : 'Turn on authenticator'}
            </Button>
            {props.onCancel ? (
              <Button variant="link" classNames={classNames} onClick={props.onCancel}>
                {props.cancelLabel ?? 'Cancel'}
              </Button>
            ) : null}
          </Actions>
        </form>
      ) : null}
    </div>
  );
}
