import { type ReactNode, useEffect, useId, useState } from 'react';
import { fetchAuthFactors } from './api.js';
import { AuthenticatorSetup } from './AuthenticatorSetup.js';
import { type ClientAuthFactors, needsAuthenticator } from './ladder.js';
import { describeAuthError } from './messages.js';
import { Actions, Button, type HeadingLevel, LiveRegions, type StyleProps, slot } from './ui.js';

export interface TOTPEnrollmentGateProps extends StyleProps {
  /** The site's name, shown in the authenticator app. */
  issuer: string;
  children?: ReactNode;
  /** Shown while checking. Default: a short "Checking your account…" status. */
  fallback?: ReactNode;
  /**
   * Reads the person's factors. Default: Cognito `GetUserAuthFactors` from the browser. Pass a server
   * action instead to route the check through the server.
   */
  loadFactors?: () => Promise<ClientAuthFactors>;
  /** After setup (tokens are already refreshed): e.g. `router.refresh()` so server components re-check. */
  onEnrolled?: () => void;
  headingLevel?: HeadingLevel;
  renderQrCode?: (otpauthUri: string) => ReactNode;
}

type GateState = { kind: 'checking' } | { kind: 'open' } | { kind: 'enroll' } | { kind: 'error'; message: string };

/**
 * Shows only authenticator setup to a password user who hasn't set one up; everyone else sees the
 * children. It keeps the screens in step with the server, which enforces the same rule:
 * `requireUser()` refuses that person (403 `mfa_enrollment_required`) and page guards send them to
 * `/account/authenticator`. If the check can't run, the children stay hidden (fail closed) and the
 * reason is shown with a retry.
 */
export function TOTPEnrollmentGate(props: TOTPEnrollmentGateProps) {
  const { classNames } = props;
  const errorId = useId();
  const [state, setState] = useState<GateState>({ kind: 'checking' });
  const [attempt, setAttempt] = useState(0);
  const loadFactors = props.loadFactors ?? fetchAuthFactors;

  useEffect(() => {
    let active = true;
    loadFactors().then(
      (factors) => {
        if (active) setState(needsAuthenticator(factors) ? { kind: 'enroll' } : { kind: 'open' });
      },
      (error: unknown) => {
        if (active) setState({ kind: 'error', message: `We couldn't check your sign-in settings. ${describeAuthError(error, 'account').message}` });
      },
    );
    return () => {
      active = false;
    };
    // Runs once per attempt: an inline loadFactors (a new function each render) mustn't re-run it.
  }, [attempt]);

  if (state.kind === 'open') return <>{props.children}</>;
  if (state.kind === 'checking') {
    return (
      props.fallback ?? (
        <div data-auth-kit="totp-gate" {...slot(classNames, 'root', props.className)}>
          <LiveRegions classNames={classNames} errorId={errorId} error={null} status="Checking your account…" />
        </div>
      )
    );
  }
  if (state.kind === 'error') {
    return (
      <div data-auth-kit="totp-gate" {...slot(classNames, 'root', props.className)}>
        <LiveRegions classNames={classNames} errorId={errorId} error={state.message} status={null} />
        <Actions classNames={classNames}>
          <Button
            classNames={classNames}
            onClick={() => {
              setState({ kind: 'checking' });
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </Button>
        </Actions>
      </div>
    );
  }
  return (
    <div data-auth-kit="totp-gate" {...slot(classNames, 'root', props.className)}>
      <AuthenticatorSetup
        issuer={props.issuer}
        intro={`You sign in with a password, so ${props.issuer} also needs a code from an authenticator app. Set it up to continue.`}
        headingLevel={props.headingLevel ?? 2}
        onDone={() => {
          setState({ kind: 'open' });
          props.onEnrolled?.();
        }}
        {...(props.renderQrCode && { renderQrCode: props.renderQrCode })}
        classNames={classNames}
      />
    </div>
  );
}
