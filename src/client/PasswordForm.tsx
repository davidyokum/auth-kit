import { type FormEvent, type ReactNode, useId, useRef, useState } from 'react';
import { type BreachedPasswordCheck, isBreachedPassword } from './breached.js';
import { NEW_PASSWORD_RULES, SIGN_IN_AUTOCOMPLETE, newPasswordProblem } from './ladder.js';
import { ERRORS, MY_ACCOUNT, SHARED, STATUS } from './copy.js';
import type { AuthErrorContext } from './messages.js';
import { Actions, Button, Field, Heading, type HeadingLevel, HiddenUsername, LiveRegions, type StyleProps, Text, slot, useFeedback } from './ui.js';

export interface PasswordCheckOptions {
  /**
   * Checks new passwords against breached passwords before saving. Default: Have I Been Pwned's
   * range API (needs `connect-src https://api.pwnedpasswords.com`). `false` turns it off (Plus-plan
   * pools that rely on Cognito's check). If the check can't run, the password is allowed.
   */
  checkBreachedPassword?: BreachedPasswordCheck | false;
}

/** A message when the password is known to be breached; null when it isn't, or when the check couldn't run. */
export async function breachedPasswordProblem(password: string, check: BreachedPasswordCheck | false | undefined): Promise<string | null> {
  if (check === false) return null;
  try {
    if (await (check ?? isBreachedPassword)(password)) {
      return ERRORS.breached;
    }
  } catch {
    // Can't reach the breach list: let it through. A manager-generated password is the real protection.
  }
  return null;
}

export interface PasswordFormProps extends StyleProps, PasswordCheckOptions {
  heading: ReactNode;
  intro?: ReactNode;
  headingLevel?: HeadingLevel;
  /** Also ask for the current password (changing an existing one). */
  askCurrent?: boolean;
  /** For password managers: saved with the new password. */
  email?: string;
  submitLabel: string;
  context: AuthErrorContext;
  onSubmit(input: { newPassword: string; currentPassword?: string }): Promise<void>;
  onDone?: () => void;
  onCancel?: () => void;
  /** Root `data-auth-kit` name. */
  name?: string;
}

/** A new-password form: at least 15 characters, no composition rules, paste allowed, breach-checked. */
export function PasswordForm(props: PasswordFormProps) {
  const { classNames } = props;
  const errorId = useId();
  const fb = useFeedback();
  const currentRef = useRef<HTMLInputElement>(null);
  const newRef = useRef<HTMLInputElement>(null);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (fb.busy) return;
    if (props.askCurrent && current === '') {
      fb.set({ error: ERRORS.emptyCurrentPassword, field: 'current', status: null });
      currentRef.current?.focus();
      return;
    }
    const problem = newPasswordProblem(next);
    if (problem) {
      fb.set({ error: problem, field: 'new', status: null });
      newRef.current?.focus();
      return;
    }
    fb.set({ busy: true, error: null, field: null, status: STATUS.checkingPassword });
    const breached = await breachedPasswordProblem(next, props.checkBreachedPassword);
    if (breached) {
      fb.set({ busy: false, error: breached, field: 'new', status: null });
      newRef.current?.focus();
      return;
    }
    const result = await fb.run(() => props.onSubmit({ newPassword: next, ...(props.askCurrent && { currentPassword: current }) }), {
      context: props.context,
      busyStatus: STATUS.saving,
    });
    if (result.ok) {
      setCurrent('');
      setNext('');
      fb.set({ status: STATUS.passwordSaved });
      props.onDone?.();
    }
  }

  return (
    <div data-auth-kit={props.name ?? 'password-form'} {...slot(classNames, 'root', props.className)}>
      <Heading level={props.headingLevel ?? 2} classNames={classNames}>
        {props.heading}
      </Heading>
      {props.intro ? <Text classNames={classNames}>{props.intro}</Text> : null}
      <LiveRegions classNames={classNames} errorId={errorId} error={fb.error} status={fb.status} />
      <form noValidate onSubmit={(e) => void submit(e)} aria-busy={fb.busy || undefined} {...slot(classNames, 'form')}>
        {props.email !== undefined ? <HiddenUsername email={props.email} /> : null}
        {props.askCurrent ? (
          <Field
            label={MY_ACCOUNT.currentPasswordLabel}
            type="password"
            name="current-password"
            autoComplete={SIGN_IN_AUTOCOMPLETE.currentPassword}
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            invalid={fb.field === 'current' || (fb.error !== null && fb.field === null && props.context === 'change-password')}
            errorId={errorId}
            inputRef={currentRef}
            classNames={classNames}
          />
        ) : null}
        <Field
          label={MY_ACCOUNT.newPasswordLabel}
          hint={MY_ACCOUNT.newPasswordHint(NEW_PASSWORD_RULES.minLength)}
          type="password"
          name="new-password"
          autoComplete={SIGN_IN_AUTOCOMPLETE.newPassword}
          // A hint for password generators; no maxLength, which would silently truncate a paste.
          minLength={NEW_PASSWORD_RULES.minLength}
          value={next}
          onChange={(e) => setNext(e.target.value)}
          invalid={fb.field === 'new'}
          errorId={errorId}
          inputRef={newRef}
          classNames={classNames}
        />
        <Actions classNames={classNames}>
          <Button type="submit" disabled={fb.busy} classNames={classNames}>
            {props.submitLabel}
          </Button>
          {props.onCancel ? (
            <Button variant="link" classNames={classNames} onClick={props.onCancel}>
              {SHARED.cancel}
            </Button>
          ) : null}
        </Actions>
      </form>
    </div>
  );
}
