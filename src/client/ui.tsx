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
import { type AuthTheme, themeCssVariables } from '../themes/index.js';
import { Icon, type IconName } from './icons.js';
import { type AuthErrorContext, type MessageWords, describeAuthError } from './messages.js';
import { CONTACT, type Rich, SHARED, SIGN_IN } from './copy.js';

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
  | 'content'
  | 'card'
  | 'bottom'
  | 'below'
  | 'summary'
  | 'fieldError'
  | 'note'
  | 'wait'
  | 'alts'
  | 'who'
  | 'contact'
  | 'steps'
  | 'access'
  | 'footer'
  | 'choice'
  | 'small'
  | 'showButton'
  | 'glyph'
  | 'inputWrap'
  | 'monogram';

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
  /** The error again, next to the field (REPORT §3.7: by the field and in the summary). */
  error?: string | null;
  /** "(optional)" after the label. */
  optional?: boolean;
  classNames: AuthKitClassNames | undefined;
  inputRef?: Ref<HTMLInputElement>;
  /** Something after the input on the same row (the password's Show button). */
  after?: ReactNode;
  /**
   * An icon inside the field, hidden from screen readers (the label says what it is). Email fields get
   * the envelope by default (register A9); `false` leaves it out.
   */
  icon?: IconName | false;
}

export function Field({ label, hint, invalid, errorId, error, optional, classNames, inputRef, after, icon, id: idProp, ...input }: FieldProps) {
  const autoId = useId();
  const id = idProp ?? autoId;
  const hintId = hint ? `${id}-hint` : undefined;
  const inlineId = invalid && error ? `${id}-error` : undefined;
  const describedBy = [hintId, inlineId, invalid ? errorId : undefined].filter(Boolean).join(' ');
  const iconName = icon === false ? undefined : (icon ?? (input.type === 'email' ? 'mail' : undefined));
  const field = (
    <input
      id={id}
      ref={inputRef}
      aria-invalid={invalid ? true : undefined}
      aria-describedby={describedBy || undefined}
      data-auth-kit-has-icon={iconName ? '' : undefined}
      {...slot(classNames, 'input')}
      {...input}
    />
  );
  return (
    <div {...slot(classNames, 'field')}>
      <label htmlFor={id} {...slot(classNames, 'label')}>
        {label}
        {optional ? <span> {SHARED.optional}</span> : null}
      </label>
      {hint ? (
        <p id={hintId} {...slot(classNames, 'hint')}>
          {hint}
        </p>
      ) : null}
      {inlineId ? (
        <p id={inlineId} {...slot(classNames, 'fieldError')}>
          <span data-auth-kit-sr="">{SHARED.errorPrefix}</span>
          {error}
        </p>
      ) : null}
      {iconName ? (
        <span {...slot(classNames, 'inputWrap')}>
          <Icon name={iconName} />
          {field}
        </span>
      ) : (
        field
      )}
      {after}
    </div>
  );
}

/** A password field with Show/Hide (REPORT §3.3). Paste is never blocked; the value isn't announced. */
export function PasswordField(props: Omit<FieldProps, 'type' | 'after'>) {
  const [shown, setShown] = useState(false);
  const autoId = useId();
  const id = props.id ?? autoId;
  return (
    <Field
      {...props}
      id={id}
      type={shown ? 'text' : 'password'}
      autoCapitalize="none"
      spellCheck={false}
      after={
        <button type="button" aria-controls={id} aria-pressed={shown} onClick={() => setShown((v) => !v)} {...slot(props.classNames, 'showButton')}>
          {shown ? SIGN_IN.hide : SIGN_IN.show}
          <span data-auth-kit-sr="">{SHARED.passwordSr}</span>
        </button>
      }
    />
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

/**
 * The error summary at the top of the card (REPORT §3.7): it takes focus when it appears, says what to
 * do, and links to the field. Neutral messages (a passkey prompt that closed) use `Note` instead.
 */
export function ErrorSummary(props: {
  error: string | null;
  fieldId?: string | undefined;
  /** Several problems at once (a form with two empty fields), each linking to its field. */
  items?: readonly { message: string; fieldId?: string }[];
  classNames: AuthKitClassNames | undefined;
  id?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const items = props.items ?? [];
  const key = props.error ?? items.map((i) => i.message).join('|');
  useEffect(() => {
    if (key) ref.current?.focus();
  }, [key]);
  const link = (message: string, fieldId: string) => (
    <a
      href={`#${fieldId}`}
      onClick={(e) => {
        e.preventDefault();
        document.getElementById(fieldId)?.focus();
      }}
      {...slot(props.classNames, 'link')}
    >
      {message}
    </a>
  );
  if (items.length > 0) {
    return (
      <div ref={ref} id={props.id} role="alert" tabIndex={-1} {...slot(props.classNames, 'summary')}>
        <Icon name="alert" />
        <ul>
          {items.map((i) => (
            <li key={i.message}>{i.fieldId ? link(i.message, i.fieldId) : i.message}</li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <div ref={ref} id={props.id} role="alert" tabIndex={-1} hidden={!props.error} {...slot(props.classNames, 'summary')}>
      {props.error ? (
        <>
          <Icon name="alert" />
          {props.fieldId ? (
            <a
              href={`#${props.fieldId}`}
              onClick={(e) => {
                e.preventDefault();
                document.getElementById(props.fieldId!)?.focus();
              }}
              {...slot(props.classNames, 'link')}
            >
              {props.error}
            </a>
          ) : (
            <p>{props.error}</p>
          )}
        </>
      ) : null}
    </div>
  );
}

/** A neutral status (no red): read out politely. */
export function Note(props: { children: ReactNode; icon?: IconName; classNames: AuthKitClassNames | undefined }) {
  return (
    <div role="status" {...slot(props.classNames, 'note')}>
      <Icon name={props.icon ?? 'info'} />
      <p>{props.children}</p>
    </div>
  );
}

/** "Waiting for your passkey…": the step is the browser's own window, so there's no final button. */
export function Wait(props: { label: string; classNames: AuthKitClassNames | undefined }) {
  return (
    <div role="status" aria-live="polite" {...slot(props.classNames, 'wait')}>
      <Icon name="fingerprint" />
      <span>{props.label}</span>
    </div>
  );
}

export interface AltLink {
  icon: IconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

/** The other ways in, as a short list of link buttons with icons. */
export function AltLinks(props: { links: readonly AltLink[]; classNames: AuthKitClassNames | undefined }) {
  if (props.links.length === 0) return null;
  return (
    <ul {...slot(props.classNames, 'alts')}>
      {props.links.map((l) => (
        <li key={l.label}>
          <button type="button" disabled={l.disabled} onClick={l.onClick} {...slot(props.classNames, 'linkButton')}>
            <Icon name={l.icon} />
            <span>{l.label}</span>
            <Icon name="chevron" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** "Signing in as {email} · Change" / "for {email} · Change". */
export function Who(props: { lead: string; email: string; onChange: () => void; disabled?: boolean; classNames: AuthKitClassNames | undefined }) {
  return (
    <p {...slot(props.classNames, 'who')}>
      {props.lead} <strong>{props.email}</strong> <span aria-hidden="true">·</span>{' '}
      <button type="button" disabled={props.disabled} onClick={props.onChange} {...slot(props.classNames, 'linkButton')}>
        {SIGN_IN.change}
        <span data-auth-kit-sr="">{SHARED.changeEmailSr}</span>
      </button>
    </p>
  );
}

/** A numbered list of steps; `{ strong }` parts are the words of the link or button to choose. */
export function Steps(props: { steps: readonly Rich[]; classNames: AuthKitClassNames | undefined }) {
  return (
    <ol {...slot(props.classNames, 'steps')}>
      {props.steps.map((step, i) => (
        <li key={i}>{step.map((part, j) => (typeof part === 'string' ? <span key={j}>{part}</span> : <strong key={j}>{part.strong}</strong>))}</li>
      ))}
    </ol>
  );
}

/** The help screens' contact box: who to write to, who looks after the site, and "Never send a password or code." */
export function ContactBox(props: { lead: string; address: string; lines: readonly string[]; classNames: AuthKitClassNames | undefined }) {
  return (
    <div {...slot(props.classNames, 'contact')}>
      <p>
        <strong>{props.lead}</strong> {CONTACT.email}{' '}
        <a href={`mailto:${props.address}`} {...slot(props.classNames, 'link')}>
          {props.address}
        </a>
        .
      </p>
      {props.lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
}

export interface CardBottom {
  /** The card's account-creation line (the email step only). */
  access?: ReactNode;
  /** "Trouble signing in?", inside the card (`troubleLink: 'inside'`). */
  trouble?: (() => void) | null;
  /** A back link ("Back to sign in", "Back"). */
  back?: { label: string; onClick: () => void } | null;
  /** Anything else for the foot (sign-up's "Already have an account? Sign in"). */
  extra?: ReactNode;
}

/** The site's initials for the Monogram card style: the first letters of its first two words ("Example Reports" → "ER"), skipping small words. */
export function monogramOf(siteName: string): string {
  const words = siteName.split(/\s+/).filter((w) => w && !/^(of|the|and|for|to|a|an|&)$/i.test(w));
  const letters = words.length >= 2 ? words[0]![0]! + words[1]![0]! : (words[0] ?? siteName ?? '?')[0] ?? '?';
  return letters.toUpperCase();
}

/**
 * The card: one solid surface on the backdrop, themed (the family's colors and the 3:1 edge as CSS
 * custom properties, `themeCssVariables`), marked `data-backdrop-card` so a backdrop keeps its focal
 * points clear of it. Its foot carries the account-creation line, "Trouble signing in?", and the
 * family's identity line (E4: identity in the footer, nothing above the heading but the Monogram
 * style's badge, no colored line on top). `troubleBelow` puts "Trouble signing in?" under the card
 * instead. The theme's `cardStyle` (register E5) is on the root as `data-auth-kit-style`.
 */
export function Card(props: {
  name: string;
  view?: string;
  theme: AuthTheme;
  /** The site's name: the Monogram style's badge. */
  siteName?: string;
  bottom?: CardBottom;
  troubleBelow?: (() => void) | null;
  rootRef?: Ref<HTMLDivElement>;
  className?: string;
  classNames: AuthKitClassNames | undefined;
  children: ReactNode;
}) {
  const b = props.bottom ?? {};
  const footer = props.theme.footer;
  const hasBottom = Boolean(b.access || b.trouble || b.back || b.extra || footer);
  const style = props.theme.cardStyle;
  return (
    <div
      ref={props.rootRef}
      data-auth-kit={props.name}
      data-auth-kit-view={props.view}
      data-auth-kit-family={props.theme.family}
      data-auth-kit-style={style}
      style={style === 'plain' ? themeCssVariables(props.theme) : undefined}
      {...slot(props.classNames, 'root', props.className)}
    >
      <div data-backdrop-card="" style={themeCssVariables(props.theme)} {...slot(props.classNames, 'card')}>
        {style === 'monogram' && props.siteName ? (
          <div aria-hidden="true" {...slot(props.classNames, 'monogram')}>
            {monogramOf(props.siteName)}
          </div>
        ) : null}
        {props.children}
        {hasBottom ? (
          <div {...slot(props.classNames, 'bottom')}>
            {b.access}
            {b.trouble ? (
              <button type="button" onClick={b.trouble} {...slot(props.classNames, 'linkButton')}>
                <Icon name="help" />
                {SIGN_IN.trouble}
              </button>
            ) : null}
            {b.back ? (
              <button type="button" onClick={b.back.onClick} {...slot(props.classNames, 'linkButton')}>
                <Icon name="back" />
                {b.back.label}
              </button>
            ) : null}
            {b.extra}
            {footer ? <p {...slot(props.classNames, 'footer')}>{footer}</p> : null}
          </div>
        ) : null}
      </div>
      {props.troubleBelow ? (
        <p {...slot(props.classNames, 'below')}>
          <button type="button" onClick={props.troubleBelow} {...slot(props.classNames, 'linkButton')}>
            <Icon name="help" />
            {SIGN_IN.trouble}
          </button>
        </p>
      ) : null}
    </div>
  );
}

/** A large check mark above a "done" heading. */
export function Glyph(props: { classNames: AuthKitClassNames | undefined }) {
  return (
    <div aria-hidden="true" {...slot(props.classNames, 'glyph')}>
      <Icon name="check" />
    </div>
  );
}

/** A polite live region for progress ("Sending a code…"). Errors go in the `ErrorSummary`. */
export function StatusRegion(props: { status: string | null; classNames: AuthKitClassNames | undefined }) {
  return (
    <div role="status" {...slot(props.classNames, 'status')}>
      {props.status ?? ''}
    </div>
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
      options: { context: AuthErrorContext; busyStatus?: string; words?: MessageWords; onError?: (kind: ReturnType<typeof describeAuthError>) => void },
    ): Promise<{ ok: true; value: T } | { ok: false }> => {
      set({ busy: true, error: null, field: null, status: options.busyStatus ?? null });
      try {
        const value = await task();
        set(options.busyStatus ? { busy: false, status: null } : { busy: false });
        return { ok: true, value };
      } catch (error) {
        const info = describeAuthError(error, options.context, options.words);
        set({ busy: false, error: info.message, status: null });
        options.onError?.(info);
        return { ok: false };
      }
    },
    [set],
  );

  return { ...state, set, run };
}
