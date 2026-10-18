import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { type AuthTheme, type ThemeFamily, resolveTheme } from '../themes/index.js';
import { postAccountForm, takeHandedOffEmail } from './account-creation-client.js';
import { type CopyContext, ERRORS, REQUEST, SHARED, SIGN_IN, STATUS } from './copy.js';
import type { SignInHelp } from './SignIn.js';
import { Actions, Button, Card, ErrorSummary, Field, Glyph, Heading, type HeadingLevel, StatusRegion, type StyleProps, Text, slot, useFeedback, useFocusOnViewChange } from './ui.js';

export interface RequestAccessProps extends StyleProps {
  siteName: string;
  theme?: AuthTheme | ThemeFamily;
  help: SignInHelp;
  /** The request route. Default `/api/auth/request-access`. */
  endpoint?: string;
  /** "Back to sign in". Default `/sign-in`. */
  signInHref?: string;
  /** The email field's example. Default: the family's. */
  emailHint?: string;
  /** The privacy notice: "We use this only to decide on your request. Privacy notice" (REPORT §3.1a). */
  privacyNoticeUrl?: string;
  headingLevel?: HeadingLevel;
  navigate?: (path: string) => void;
  /** Inject `fetch` (tests). Default: AWS WAF's integration when the page loaded it, else `fetch`. */
  fetch?: typeof fetch;
}

type Problem = { message: string; field: 'name' | 'email' | 'reason' };

/**
 * "Request access to {Site}" (REPORT §3.1a, Card Studio v4; register D3, ADR 0023): name, email, and
 * an optional reason. "Request sent" is the same for every address: a new one becomes a request on the
 * People page, and one that already has an account gets an email saying so.
 */
export function RequestAccess(props: RequestAccessProps) {
  const { classNames, siteName } = props;
  const theme = useMemo(() => resolveTheme(props.theme), [props.theme]);
  const c: CopyContext = { siteName, theme, codeLifetimeMinutes: 3, helpAddress: props.help.address, ...(props.help.owner !== undefined && { ownerName: props.help.owner }) };
  const hint = props.emailHint?.trim() || theme.emailHint;
  const level = props.headingLevel ?? 1;
  const uid = useId();
  const ids = { name: `${uid}-name`, email: `${uid}-email`, reason: `${uid}-reason` };
  const rootRef = useRef<HTMLDivElement>(null);
  const fb = useFeedback();
  const [sent, setSent] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [reason, setReason] = useState('');
  const [problems, setProblems] = useState<Problem[]>([]);
  useFocusOnViewChange(rootRef, sent ? 'sent' : 'form');
  const navigate = (path: string) => (props.navigate ?? ((p: string) => window.location.assign(p)))(path);

  // "Ask for access instead" on the sign-up screen hands the typed address over (never in the URL).
  useEffect(() => {
    const handed = takeHandedOffEmail();
    if (handed) setEmail((e) => e || handed);
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (fb.busy) return;
    const found: Problem[] = [];
    if (!name.trim()) found.push({ message: ERRORS.emptyName, field: 'name' });
    const typed = email.trim();
    if (!typed) found.push({ message: ERRORS.emptyEmail, field: 'email' });
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(typed)) found.push({ message: ERRORS.badEmail(hint), field: 'email' });
    setProblems(found);
    fb.set({ error: null });
    if (found.length > 0) return;
    fb.set({ busy: true, status: STATUS.sendingRequest });
    const outcome = await postAccountForm(
      props.endpoint ?? '/api/auth/request-access',
      { name: name.trim(), email: typed, ...(reason.trim() && { reason: reason.trim() }) },
      { ...(props.fetch !== undefined && { fetch: props.fetch }), helpAddress: props.help.address },
    );
    fb.set({ busy: false, status: null });
    if (outcome.ok) {
      setSent(true);
      return;
    }
    const field = outcome.body?.field;
    if (field === 'name' || field === 'email' || field === 'reason') setProblems([{ message: outcome.message, field }]);
    else fb.set({ error: outcome.message });
  }

  const errorOf = (field: Problem['field']) => problems.find((p) => p.field === field)?.message ?? null;
  const heading = (text: string) => (
    <Heading level={level} classNames={classNames}>
      {text}
    </Heading>
  );

  return (
    <Card
      name="request-access"
      view={sent ? 'sent' : 'form'}
      theme={theme}
      bottom={sent ? {} : { back: { label: SIGN_IN.backToSignIn, onClick: () => navigate(props.signInHref ?? '/sign-in') } }}
      rootRef={rootRef}
      {...(props.className !== undefined && { className: props.className })}
      classNames={classNames}
    >
      {sent ? (
        <div {...slot(classNames, 'form')}>
          <Glyph classNames={classNames} />
          {heading(REQUEST.sentHeading)}
          <Text classNames={classNames}>{REQUEST.sentSub}</Text>
          <Actions classNames={classNames}>
            <Button classNames={classNames} onClick={() => navigate(props.signInHref ?? '/sign-in')}>
              {SIGN_IN.backToSignIn}
            </Button>
          </Actions>
        </div>
      ) : (
        <form noValidate onSubmit={(e) => void submit(e)} aria-busy={fb.busy || undefined} {...slot(classNames, 'form')}>
          <ErrorSummary error={fb.error} items={problems.map((p) => ({ message: p.message, fieldId: ids[p.field] }))} classNames={classNames} />
          {heading(REQUEST.heading(c))}
          <Text classNames={classNames}>{REQUEST.sub(c)}</Text>
          <Field id={ids.name} label={REQUEST.nameLabel} name="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} invalid={errorOf('name') !== null} error={errorOf('name')} classNames={classNames} />
          <Field
            id={ids.email}
            label={SIGN_IN.emailLabel}
            type="email"
            name="email"
            inputMode="email"
            autoCapitalize="none"
            spellCheck={false}
            autoComplete="email"
            placeholder={hint}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            invalid={errorOf('email') !== null}
            error={errorOf('email')}
            classNames={classNames}
          />
          <div {...slot(classNames, 'field')}>
            <label htmlFor={ids.reason} {...slot(classNames, 'label')}>
              {REQUEST.reasonLabel}
              <span> {REQUEST.optional}</span>
            </label>
            {errorOf('reason') ? (
              <p id={`${ids.reason}-error`} {...slot(classNames, 'fieldError')}>
                <span data-auth-kit-sr="">{SHARED.errorPrefix}</span>
                {errorOf('reason')}
              </p>
            ) : null}
            <textarea
              id={ids.reason}
              name="reason"
              rows={3}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              aria-invalid={errorOf('reason') ? true : undefined}
              aria-describedby={errorOf('reason') ? `${ids.reason}-error` : undefined}
              {...slot(classNames, 'input')}
            />
          </div>
          {props.privacyNoticeUrl ? (
            <p {...slot(classNames, 'small')}>
              {REQUEST.privacy[0]}
              <a href={props.privacyNoticeUrl} {...slot(classNames, 'link')}>
                {REQUEST.privacy[1]}
              </a>
            </p>
          ) : null}
          <Actions classNames={classNames}>
            <Button type="submit" disabled={fb.busy} classNames={classNames}>
              {REQUEST.send}
            </Button>
          </Actions>
        </form>
      )}
      <StatusRegion status={fb.status} classNames={classNames} />
    </Card>
  );
}
