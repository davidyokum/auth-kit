import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import type { AuthenticatorEnrollment } from './api.js';
import { ERRORS, FIRST_VISIT, SHARED, SIGN_IN, STATUS } from './copy.js';
import { tagged, useDriver } from './driver.js';
import { Icon } from './icons.js';
import { QrCode } from './qr.js';
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
  /**
   * Default mode only: runs after the code checks out (`verifyTOTPSetup`) and before the authenticator is
   * turned on (`updateMFAPreference`). `ChooseFirstCredential` and `MyAccount` save the person's first
   * password here, so an abandoned setup never leaves a password without an authenticator (which would
   * send every page to authenticator setup). If it throws, the authenticator stays off and the error
   * shows; the next try runs it again without asking for another code, so it must be safe to repeat.
   */
  beforeTurningOn?: () => Promise<void>;
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
   * The QR code for the `otpauth://` link. Omit it for auth-kit's own (an inline SVG, its encoder
   * loaded on first use; ADR 0027); pass a function to draw your own, or `false` for none.
   */
  renderQrCode?: ((otpauthUri: string) => ReactNode) | false;
  /** A name for this authenticator in Cognito. */
  deviceName?: string;
}

/**
 * "Add an authenticator app" (Card Studio v4): a QR code (auth-kit's own unless the site draws one or
 * turns it off), the setup key as text with Copy (WCAG 3.3.8), a setup link on touch devices (where an
 * app can take it; on a computer it opens nothing), then one 6-digit code. Used inside sign-in,
 * by the enrollment gate, and under My account.
 *
 * In the default mode the setup key is kept for this tab (`authenticator-progress.ts`): a reload, a
 * redirect, or another screen's setup shows the same key, because a new `setUpTOTP` would silently
 * break an entry the person already scanned. "Get a new QR code" is the only way to replace it.
 */
export function AuthenticatorSetup(props: AuthenticatorSetupProps) {
  const { classNames, issuer, enrollment, deviceName } = props;
  const driver = useDriver();
  const init = driver.initial('authenticator-setup');
  const rootRef = useRef<HTMLDivElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const uid = useId();
  const fb = useFeedback(init?.feedback);
  const [account, setAccount] = useState(props.accountName);
  // A held setup (preview mode) shows its key at once, as if `setUpTOTP` had answered; its code is never checked.
  const [started, setStarted] = useState<AuthenticatorEnrollment | null>(() =>
    init && !enrollment ? { secret: init.secret, otpauthUri: buildOtpauthUri({ secret: init.secret, issuer }), verify: () => new Promise<void>(() => undefined) } : null,
  );
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [code, setCode] = useState(init?.code ?? '');
  // The code checked out, but the authenticator isn't on yet (default mode): the next step needs no code.
  const [checked, setChecked] = useState(false);
  const checkedRef = useRef(false);
  // The account's `sub`, the key the setup in progress is kept under (null: unknown, so kept for this page only).
  const userRef = useRef<string | null>(null);
  const issuedRef = useRef(0);
  // "Get a new QR code" asks Cognito for a new key; every other start reuses the kept one.
  const freshRef = useRef(false);
  // One setup per attempt, even when React runs effects twice in development: a second
  // AssociateSoftwareToken would replace the key on screen.
  const pending = useRef<{ attempt: number; promise: Promise<{ enrollment: AuthenticatorEnrollment; checked: boolean }> } | null>(null);
  const { set } = fb;

  useEffect(() => {
    if (props.accountName !== undefined) {
      setAccount(props.accountName);
      return;
    }
    if (driver.held) return;
    let active = true;
    driver.fetchAccountEmail().then(
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
  }, [props.accountName, driver]);

  /** The kept setup for this account, or a new one from Cognito (kept at once). */
  async function startOrResume(fresh: boolean): Promise<{ enrollment: AuthenticatorEnrollment; checked: boolean }> {
    const who = await driver.currentUser().catch(() => null);
    const userId = who?.userId ?? null;
    userRef.current = userId;
    if (userId !== null) {
      if (fresh) driver.clearAuthenticatorProgress(userId);
      const kept = fresh ? null : driver.readAuthenticatorProgress(userId);
      if (kept) {
        issuedRef.current = kept.issuedAt;
        return { enrollment: { secret: kept.secret, otpauthUri: buildOtpauthUri({ secret: kept.secret, issuer }), verify: () => Promise.reject(new Error('unused')) }, checked: kept.checked };
      }
    }
    const started = await driver.enrollAuthenticator({ issuer, ...(deviceName !== undefined && { deviceName }) });
    issuedRef.current = Date.now();
    if (userId !== null) driver.saveAuthenticatorProgress(userId, { secret: started.secret, checked: false, issuedAt: issuedRef.current });
    return { enrollment: started, checked: false };
  }

  useEffect(() => {
    // A held setup already shows its key: no AssociateSoftwareToken.
    if (enrollment || driver.held) return;
    let active = true;
    if (pending.current?.attempt !== attempt) {
      const fresh = freshRef.current;
      freshRef.current = false;
      pending.current = { attempt, promise: startOrResume(fresh) };
    }
    pending.current.promise.then(
      (result) => {
        if (!active) return;
        setStarted(result.enrollment);
        checkedRef.current = result.checked;
        setChecked(result.checked);
        set({ status: null });
        // A code that already checked out, with the authenticator still off: finish it now.
        if (result.checked) void finishNow();
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
  }, [attempt, enrollment, issuer, deviceName, set, driver]);

  const secret = enrollment?.secret ?? started?.secret ?? null;
  const uri = secret ? buildOtpauthUri({ secret, issuer, ...(account !== undefined && { accountName: account }) }) : null;
  const canVerify = enrollment !== undefined || started !== null;

  function retry() {
    setLoadFailed(false);
    set({ error: null, status: STATUS.preparingSetupKey });
    setAttempt((n) => n + 1);
  }

  /** "Get a new QR code": the only way the default mode replaces a key it already showed. */
  function newKey() {
    if (fb.busy) return;
    freshRef.current = true;
    setStarted(null);
    setCode('');
    setLoadFailed(false);
    set({ error: null, field: null, status: STATUS.preparingSetupKey });
    setAttempt((n) => n + 1);
  }

  function copy() {
    if (!secret) return;
    driver.writeClipboard(secret.replace(/\s/g, '')).then(
      () => set({ status: FIRST_VISIT.copied, error: null }),
      () => set({ error: FIRST_VISIT.copyFailed }),
    );
  }

  /**
   * The default mode, in the order that never strands the account: check the code (the key is tied to
   * the account, nothing else changes), then the caller's step (a held first password), then turn the
   * authenticator on. Each finished step is remembered, so a retry picks up where it stopped.
   */
  async function finish(normalized: string | null): Promise<void> {
    const userId = userRef.current;
    if (!checkedRef.current) {
      if (normalized === null) throw new Error('auth-kit: no code to check');
      await driver.checkAuthenticatorCode(normalized, deviceName);
      checkedRef.current = true;
      setChecked(true);
      if (userId !== null && secret) driver.saveAuthenticatorProgress(userId, { secret, checked: true, issuedAt: issuedRef.current || Date.now() });
    }
    await props.beforeTurningOn?.();
    await driver.turnOnAuthenticator();
    if (userId !== null) driver.clearAuthenticatorProgress(userId);
  }

  async function finishNow() {
    const result = await fb.run(() => finish(null), { context: 'authenticator-setup', busyStatus: FIRST_VISIT.finishingSetup });
    if (result.ok) {
      set({ status: STATUS.authenticatorOn });
      props.onDone?.();
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canVerify || fb.busy) return;
    const normalized = normalizeCode(code);
    if (!/^\d{6}$/.test(normalized)) {
      set({ error: ERRORS.totpTooShort, field: 'code', status: null });
      codeRef.current?.focus();
      return;
    }
    const result = await fb.run(() => (enrollment ? enrollment.verify(normalized) : started && driver.held ? started.verify(normalized) : finish(normalized)), {
      context: 'authenticator-setup',
      busyStatus: STATUS.checkingCode,
    });
    if (result.ok) {
      set({ status: STATUS.authenticatorOn });
      props.onDone?.();
    } else if (!checkedRef.current) {
      setCode('');
      set({ field: 'code' });
      codeRef.current?.focus();
    }
  }

  const showQr = props.renderQrCode !== false;
  const qr = !showQr || !uri ? null : props.renderQrCode ? props.renderQrCode(uri) : <QrCode value={uri} label={FIRST_VISIT.qrLabel} />;
  // The setup link opens an authenticator app only where one can take it (a phone or tablet). Decided
  // after the first paint, so the server's HTML and the browser's agree.
  const [touch, setTouch] = useState(false);
  useEffect(() => setTouch(driver.isTouchDevice()), [driver]);
  const codeId = `${uid}-code`;
  const retryNow = driver.act('try-again', retry);
  const copyNow = driver.act('copy-setup-key', copy);
  const submitNow = driver.act('submit-authenticator-code', (e: FormEvent) => void submit(e));
  const openLink = driver.act('open-setup-link');
  const newKeyNow = driver.act('new-setup-key', newKey);
  const finishAgain = driver.act('try-again', () => void finishNow());
  return (
    <div ref={rootRef} data-auth-kit="authenticator-setup" {...slot(classNames, 'root', props.className)}>
      <ErrorSummary error={fb.error} fieldId={fb.field === 'code' ? codeId : undefined} classNames={classNames} />
      <Heading level={props.headingLevel ?? 2} classNames={classNames}>
        {props.heading ?? FIRST_VISIT.addTotpHeading}
      </Heading>
      <Text classNames={classNames}>{props.intro ?? (showQr ? FIRST_VISIT.addTotpSub : FIRST_VISIT.addTotpSubNoQr)}</Text>
      <p {...slot(classNames, 'small')} data-auth-kit-totp-replaces-email="">{FIRST_VISIT.totpReplacesEmail}</p>
      <StatusRegion classNames={classNames} status={fb.status ?? (!secret && !loadFailed ? STATUS.preparingSetupKey : null)} />
      {loadFailed ? (
        <Actions classNames={classNames}>
          <Button classNames={classNames} onClick={retryNow}>
            {SIGN_IN.tryAgain}
          </Button>
          {props.onCancel ? (
            <Button variant="link" classNames={classNames} onClick={props.onCancel}>
              {props.cancelLabel ?? SHARED.cancel}
            </Button>
          ) : null}
        </Actions>
      ) : null}
      {checked && !enrollment ? (
        // The code checked out; turning the authenticator on (or the caller's step) didn't finish.
        <div {...slot(classNames, 'form')} data-auth-kit-totp-checked="">
          <Text classNames={classNames}>{FIRST_VISIT.codeChecked}</Text>
          {fb.error && !fb.busy ? (
            <Actions classNames={classNames}>
              <Button classNames={classNames} onClick={finishAgain}>
                {SIGN_IN.tryAgain}
              </Button>
              {props.onCancel ? (
                <Button variant="link" classNames={classNames} onClick={props.onCancel}>
                  {props.cancelLabel ?? SHARED.cancel}
                </Button>
              ) : null}
            </Actions>
          ) : null}
        </div>
      ) : secret && uri ? (
        <form noValidate onSubmit={submitNow} {...tagged(submitNow)} aria-busy={fb.busy || undefined} {...slot(classNames, 'form')}>
          {qr ? <div {...slot(classNames, 'content')}>{qr}</div> : null}
          {qr ? <Text classNames={classNames}>{FIRST_VISIT.cantScan}</Text> : null}
          <p {...slot(classNames, 'text')}>
            <code aria-label={FIRST_VISIT.setupKeyLabel} {...slot(classNames, 'code')}>
              {formatSetupKey(secret)}
            </code>{' '}
            <Button variant="secondary" classNames={classNames} onClick={copyNow}>
              <Icon name="copy" />
              {FIRST_VISIT.copy}
              <span data-auth-kit-sr="">{SHARED.setupKeySr}</span>
            </Button>
          </p>
          {touch ? (
            <p {...slot(classNames, 'small')}>
              <a href={uri} onClick={openLink} {...tagged(openLink)} {...slot(classNames, 'link')}>
                {FIRST_VISIT.openSetupLink}
              </a>
            </p>
          ) : null}
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
          {enrollment ? null : (
            // Replacing the key breaks any entry already scanned from it, so it's a choice, never a side effect.
            <p {...slot(classNames, 'small')}>
              {FIRST_VISIT.newSetupKeyLead}{' '}
              <Button variant="link" classNames={classNames} disabled={fb.busy} onClick={newKeyNow}>
                {showQr ? FIRST_VISIT.newQrCode : FIRST_VISIT.newSetupKey}
              </Button>
            </p>
          )}
        </form>
      ) : null}
    </div>
  );
}
