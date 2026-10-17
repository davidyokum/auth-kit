/**
 * Small building blocks shared by the screens. Unstyled: every element carries
 * `data-auth-kit-slot="<slot>"` and the class from `classNames[slot]`, and each component's root
 * carries `data-auth-kit="<component>"` plus `className`.
 */
import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { type AuthErrorContext, describeAuthError } from './messages.js';

export type AuthKitSlot =
  | 'root'
  | 'heading'
  | 'text'
  | 'form'
  | 'field'
  | 'label'
  | 'input'
  | 'hint'
  | 'error'
  | 'status'
  | 'actions'
  | 'button'
  | 'secondaryButton'
  | 'linkButton'
  | 'section'
  | 'list'
  | 'listItem'
  | 'code'
  | 'link'
  | 'content';

export type AuthKitClassNames = Partial<Record<AuthKitSlot, string>>;

export interface StyleProps {
  /** Class for the component's root element. */
  className?: string;
  /** Classes per slot (`button`, `input`, `error`, ...). */
  classNames?: AuthKitClassNames;
}

export type HeadingLevel = 1 | 2 | 3 | 4;

export function slot(classNames: AuthKitClassNames | undefined, name: AuthKitSlot, extra?: string): { 'data-auth-kit-slot': AuthKitSlot; className?: string } {
  const className = [classNames?.[name], extra].filter(Boolean).join(' ');
  return className ? { 'data-auth-kit-slot': name, className } : { 'data-auth-kit-slot': name };
}

export function Heading(props: { level: HeadingLevel; classNames: AuthKitClassNames | undefined; children: ReactNode; id?: string }) {
  const Tag = `h${props.level}` as const;
  return (
    <Tag id={props.id} tabIndex={-1} {...slot(props.classNames, 'heading')}>
      {props.children}
    </Tag>
  );
}

export function Text(props: { classNames: AuthKitClassNames | undefined; children: ReactNode; id?: string }) {
  return (
    <p id={props.id} {...slot(props.classNames, 'text')}>
      {props.children}
    </p>
  );
}

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> {
  label: string;
  hint?: ReactNode;
  /** Marks the field invalid and links it to the component's error message. */
  invalid?: boolean;
  errorId?: string;
  classNames: AuthKitClassNames | undefined;
  inputRef?: Ref<HTMLInputElement>;
}

export function Field({ label, hint, invalid, errorId, classNames, inputRef, id: idProp, ...input }: FieldProps) {
  const autoId = useId();
  const id = idProp ?? autoId;
  const hintId = hint ? `${id}-hint` : undefined;
  const describedBy = [hintId, invalid ? errorId : undefined].filter(Boolean).join(' ');
  return (
    <div {...slot(classNames, 'field')}>
      <label htmlFor={id} {...slot(classNames, 'label')}>
        {label}
      </label>
      {hint ? (
        <p id={hintId} {...slot(classNames, 'hint')}>
          {hint}
        </p>
      ) : null}
      <input
        id={id}
        ref={inputRef}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy || undefined}
        {...slot(classNames, 'input')}
        {...input}
      />
    </div>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'link';

export function Button({
  variant = 'primary',
  classNames,
  type = 'button',
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> & { variant?: ButtonVariant; classNames: AuthKitClassNames | undefined }) {
  const name: AuthKitSlot = variant === 'primary' ? 'button' : variant === 'secondary' ? 'secondaryButton' : 'linkButton';
  return <button type={type} {...slot(classNames, name)} {...props} />;
}

export function Actions(props: { classNames: AuthKitClassNames | undefined; children: ReactNode }) {
  return <div {...slot(props.classNames, 'actions')}>{props.children}</div>;
}

/**
 * Live regions that exist before anything is announced (screen readers ignore regions inserted
 * together with their text): errors are assertive (`role="alert"`), progress is polite (`role="status"`).
 */
export function LiveRegions(props: { classNames: AuthKitClassNames | undefined; errorId: string; error: string | null; status: string | null }) {
  return (
    <>
      <div id={props.errorId} role="alert" {...slot(props.classNames, 'error')}>
        {props.error ?? ''}
      </div>
      <div role="status" {...slot(props.classNames, 'status')}>
        {props.status ?? ''}
      </div>
    </>
  );
}

/** Hidden username for forms without a visible email field, so password managers save the right account. */
export function HiddenUsername(props: { email: string }) {
  return <input type="email" name="username" autoComplete="username" value={props.email} readOnly hidden />;
}

/**
 * Moves focus to the heading of the current view when the view changes (not on first render), so a
 * screen reader announces the new step and keyboard users start at its top.
 */
export function useFocusOnViewChange(rootRef: RefObject<HTMLElement | null>, viewKey: string): void {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    rootRef.current?.querySelector<HTMLElement>('[data-auth-kit-slot="heading"]')?.focus();
  }, [rootRef, viewKey]);
}

/** Focuses the first invalid field (after a validation error). */
export function focusInvalid(rootRef: RefObject<HTMLElement | null>): void {
  rootRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
}

export interface Feedback {
  error: string | null;
  status: string | null;
  /** Which field the error is about, if any. */
  field: string | null;
  busy: boolean;
}

/**
 * Busy, error, and status state for one component. `run` clears the last error, marks the
 * component busy, and turns a thrown error into a plain message.
 */
export function useFeedback() {
  const [state, setState] = useState<Feedback>({ error: null, status: null, field: null, busy: false });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const set = useCallback((patch: Partial<Feedback>) => {
    if (mounted.current) setState((s) => ({ ...s, ...patch }));
  }, []);

  const run = useCallback(
    async <T,>(
      task: () => Promise<T>,
      options: { context: AuthErrorContext; busyStatus?: string; onError?: (kind: ReturnType<typeof describeAuthError>) => void },
    ): Promise<{ ok: true; value: T } | { ok: false }> => {
      set({ busy: true, error: null, field: null, status: options.busyStatus ?? null });
      try {
        const value = await task();
        set(options.busyStatus ? { busy: false, status: null } : { busy: false });
        return { ok: true, value };
      } catch (error) {
        const info = describeAuthError(error, options.context);
        set({ busy: false, error: info.message, status: null });
        options.onError?.(info);
        return { ok: false };
      }
    },
    [set],
  );

  return { ...state, set, run };
}
