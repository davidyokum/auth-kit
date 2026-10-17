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
  /**
   * The page's own server guard already checked this person in this render (`pages.requireUser()`
   * refuses a password user without an authenticator). The children then show from the first paint,
   * the browser re-checks, and the gate switches to setup only if that re-check says so; if the
   * re-check can't run, the server's answer stands and the children stay. Default `false`: the
   * children stay hidden until the browser check passes, and a failed check keeps them hidden.
   */
  serverChecked?: boolean;
  /** Shown while checking (not with `serverChecked`). Default: a short "Checking your account…" status. */
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
 * children. It's the screens' mirror of a rule the server enforces: `requireUser()` refuses that
 * person (403 `mfa_enrollment_required`) and page guards send them to `/account/authenticator`.
 *
 * **It never masks the server's answer.** The children are always rendered, on the server and in
 * the browser, inside a wrapper that is `hidden` until the check passes. So everything under the
 * gate runs during server rendering: a page below it that calls `notFound()` or `redirect()` still
 * produces its 404 or redirect. (An earlier version rendered only a spinner on the server, which,
 * wrapped around a layout's children, turned a nested page's 404 into a 200.)
 *
 * **It isn't a security boundary.** React sends a client component's children to the browser
 * whatever it renders, so the content is in the page either way; the server guard is what protects
 * it. Put the gate inside a page, after that page's own guard, around client UI that should follow
 * the rule on screen (`<MyAccount>`), with `serverChecked`. Don't wrap a layout's `children` with
 * it: the layout's `await pages.requireUser()` already enforces the rule for every page below.
 *
 * Without `serverChecked`, if the check can't run, the children stay hidden and the reason is shown
 * with a retry. After setup in the gate, the children are mounted afresh, so they read the new state.
 */
export function TOTPEnrollmentGate(props: TOTPEnrollmentGateProps) {
  const { classNames } = props;
  const serverChecked = props.serverChecked === true;
  const errorId = useId();
  const [state, setState] = useState<GateState>(serverChecked ? { kind: 'open' } : { kind: 'checking' });
  const [attempt, setAttempt] = useState(0);
  // Bumped after setup, so the children remount and read the person's new state.
  const [generation, setGeneration] = useState(0);
  const loadFactors = props.loadFactors ?? fetchAuthFactors;

  useEffect(() => {
    let active = true;
    loadFactors().then(
      (factors) => {
        if (active) setState(needsAuthenticator(factors) ? { kind: 'enroll' } : { kind: 'open' });
      },
      (error: unknown) => {
        // After a server check, a browser re-check that can't run changes nothing: the server's answer
        // for this render stands, and the next request is checked again on the server.
        if (active && !serverChecked) {
          setState({ kind: 'error', message: `We couldn't check your sign-in settings. ${describeAuthError(error, 'account').message}` });
        }
      },
    );
    return () => {
      active = false;
    };
    // Runs once per attempt: an inline loadFactors (a new function each render) mustn't re-run it.
  }, [attempt]);

  return (
    <div data-auth-kit="totp-gate" data-auth-kit-state={state.kind} {...slot(classNames, 'root', props.className)}>
      {state.kind === 'checking'
        ? (props.fallback ?? <LiveRegions classNames={classNames} errorId={errorId} error={null} status="Checking your account…" />)
        : null}
      {state.kind === 'error' ? (
        <>
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
        </>
      ) : null}
      {state.kind === 'enroll' ? (
        <AuthenticatorSetup
          issuer={props.issuer}
          intro={`You sign in with a password, so ${props.issuer} also needs a code from an authenticator app. Set it up to continue.`}
          headingLevel={props.headingLevel ?? 2}
          onDone={() => {
            setGeneration((n) => n + 1);
            setState({ kind: 'open' });
            props.onEnrolled?.();
          }}
          {...(props.renderQrCode && { renderQrCode: props.renderQrCode })}
          classNames={classNames}
        />
      ) : null}
      {/* Always rendered (see above); `hidden` is an attribute, so a strict CSP can't undo it. */}
      <div key={generation} {...slot(classNames, 'content')} hidden={state.kind !== 'open'}>
        {props.children}
      </div>
    </div>
  );
}
