import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { type AuthenticatorEnrollment, enrollAuthenticator, fetchAccountEmail } from './api.js';
import { ERRORS, FIRST_VISIT, SHARED, SIGN_IN, STATUS } from './copy.js';
import { Icon } from './icons.js';
import { SIGN_IN_AUTOCOMPLETE, normalizeCode } from './ladder.js';
import { describeAuthError } from './messages.js';
import { buildOtpauthUri, formatSetupKey } from './totp.js';
import { Actions, Button, ErrorSummary, Field, Heading, type HeadingLevel, StatusRegion, type StyleProps, Text, slot, useFeedback } from './ui.js';

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
  /** Default "Add an authenticator app". */
  heading?: ReactNode;
  /** The line under the heading. Default: Card Studio's (with a QR code) or the setup-key wording (without one). */
  intro?: ReactNode;
  /** The button. Default "Continue". */
  submitLabel?: string;
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
 * "Add an authenticator app" (Card Studio v4): a QR code when the site renders one, the setup key as
 * text with Copy (WCAG 3.3.8), a same-device setup link, then one 6-digit code. Used inside sign-in,
 * by the enrollment gate, and under My account.
 */
export function AuthenticatorSetup(props: AuthenticatorSetupProps) {
  const { classNames, issuer, enrollment, deviceName } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const uid = useId();
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
    set({ error: null, status: STATUS.preparingSetupKey });
    setAttempt((n) => n + 1);
  }

  function copy() {
    if (!secret) return;
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (!clipboard) {
      set({ error: FIRST_VISIT.copyFailed });
      return;
    }
    clipboard.writeText(secret.replace(/\s/g, '')).then(
      () => set({ status: FIRST_VISIT.copied, error: null }),
      () => set({ error: FIRST_VISIT.copyFailed }),
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!verify || fb.busy) return;
    const normalized = normalizeCode(code);
    if (!/^\d{6}$/.test(normalized)) {
      set({ error: ERRORS.totpTooShort, field: 'code', status: null });
      codeRef.current?.focus();
      return;
    }
    const result = await fb.run(() => verify(normalized), { context: 'authenticator-setup', busyStatus: STATUS.checkingCode });
    if (result.ok) {
      set({ status: STATUS.authenticatorOn });
      props.onDone?.();
    } else {
      setCode('');
      set({ field: 'code' });
      codeRef.current?.focus();
    }
  }

  const qr = props.renderQrCode && uri ? props.renderQrCode(uri) : null;
  const codeId = `${uid}-code`;
  return (
    <div ref={rootRef} data-auth-kit="authenticator-setup" {...slot(classNames, 'root', props.className)}>
      <ErrorSummary error={fb.error} fieldId={fb.field === 'code' ? codeId : undefined} classNames={classNames} />
      <Heading level={props.headingLevel ?? 2} classNames={classNames}>
        {props.heading ?? FIRST_VISIT.addTotpHeading}
      </Heading>
      <Text classNames={classNames}>{props.intro ?? (props.renderQrCode ? FIRST_VISIT.addTotpSub : FIRST_VISIT.addTotpSubNoQr)}</Text>
      <StatusRegion classNames={classNames} status={fb.status ?? (!secret && !loadFailed ? STATUS.preparingSetupKey : null)} />
      {loadFailed ? (
        <Actions classNames={classNames}>
          <Button classNames={classNames} onClick={retry}>
            {SIGN_IN.tryAgain}
          </Button>
          {props.onCancel ? (
            <Button variant="link" classNames={classNames} onClick={props.onCancel}>
              {props.cancelLabel ?? SHARED.cancel}
            </Button>
          ) : null}
        </Actions>
      ) : null}
      {secret && uri ? (
        <form noValidate onSubmit={(e) => void submit(e)} aria-busy={fb.busy || undefined} {...slot(classNames, 'form')}>
          {qr ? <div {...slot(classNames, 'content')}>{qr}</div> : null}
          {qr ? <Text classNames={classNames}>{FIRST_VISIT.cantScan}</Text> : null}
          <p {...slot(classNames, 'text')}>
            <code aria-label={FIRST_VISIT.setupKeyLabel} {...slot(classNames, 'code')}>
              {formatSetupKey(secret)}
            </code>{' '}
            <Button variant="secondary" classNames={classNames} onClick={copy}>
              <Icon name="copy" />
              {FIRST_VISIT.copy}
              <span data-auth-kit-sr="">{SHARED.setupKeySr}</span>
            </Button>
          </p>
          <p {...slot(classNames, 'small')}>
            <a href={uri} {...slot(classNames, 'link')}>
              {FIRST_VISIT.openSetupLink}
            </a>
          </p>
          <Field
            id={codeId}
            label={SIGN_IN.totpLabel}
            name="one-time-code"
            inputMode="numeric"
            autoComplete={SIGN_IN_AUTOCOMPLETE.oneTimeCode}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            invalid={fb.field === 'code'}
            error={fb.field === 'code' ? fb.error : null}
            inputRef={codeRef}
            classNames={classNames}
          />
          <Actions classNames={classNames}>
            <Button type="submit" disabled={fb.busy} classNames={classNames}>
              {props.submitLabel ?? SIGN_IN.continue}
            </Button>
            {props.onCancel ? (
              <Button variant="link" classNames={classNames} onClick={props.onCancel}>
                {props.cancelLabel ?? SHARED.cancel}
              </Button>
            ) : null}
          </Actions>
        </form>
      ) : null}
    </div>
  );
}
