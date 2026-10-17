'use client';
/**
 * `auth-kit/admin/ui`: minimal React components for the People and Activity pages. Client
 * components (`'use client'`): render them from a server component and pass the server actions as
 * props. Every button says what Cognito call it makes and when the change takes effect; the server
 * re-checks everything, so these only decide what to offer.
 *
 * Unstyled, semantic HTML with `ak-` class names. Imports nothing server-side.
 */
import { type ReactNode, useActionState, useRef, useState } from 'react';
import {
  type InviteMode,
  MEMBER_ROLE,
  type PeopleAction,
  checkPeopleAction,
  grantableRoles,
  roleRank,
} from '../guardrails.js';
import { OWNER_GRANT_NOTE, describeActivity, lostPasskeyGuidance, peopleActionDetails, roleLabel, type PeopleActionDetail } from '../copy.js';
import { ADMIN_ROLE_RANK, STANDARD_GROUPS, type StandardGroup } from '../../shared/policy.js';
import { PEOPLE_FORM_FIELDS as F, type ActionResult, type ActivityPage, type FormAction, type PeopleList, type PersonRow } from '../types.js';

export interface Viewer {
  sub: string;
  /** Live groups (from `requireCan(…, { live: true })`). */
  groups: readonly string[];
  /** Their capabilities, when the app's map differs from the standard one. */
  capabilities?: readonly string[];
}

// ---- Shared pieces ------------------------------------------------------------------------------

/** The result of an action, said plainly. Failures say whether anything changed. */
export function ActionResultMessage({ result, stepUpHref }: { result: ActionResult | null; stepUpHref?: string }): ReactNode {
  if (!result) return null;
  if (result.ok) {
    return (
      <p className="ak-result ak-result-ok" role="status">
        {result.message}
      </p>
    );
  }
  return (
    <div className="ak-result ak-result-error" role="alert">
      <p>{result.error}</p>
      {result.code === 'step_up_required' && stepUpHref ? (
        <p>
          <a href={stepUpHref}>Sign in again to confirm</a>
        </p>
      ) : null}
      {result.changed !== 'nothing' ? (
        <p className="ak-result-changed">
          {result.changed === 'yes' ? 'The change was made.' : 'Part of the change was made.'} The Activity page shows exactly which calls ran.
        </p>
      ) : null}
    </div>
  );
}

/** What a button does: what the screen says, the Cognito calls, and what lands now versus later. */
export function ActionExplainer({ detail }: { detail: PeopleActionDetail }): ReactNode {
  return (
    <div className="ak-explain">
      <p className="ak-says">{detail.says}</p>
      <dl className="ak-timing">
        <dt>Now</dt>
        <dd>{detail.now}</dd>
        {detail.later ? (
          <>
            <dt>Later</dt>
            <dd>{detail.later}</dd>
          </>
        ) : null}
        <dt>Cognito calls (after the audit log records the intent)</dt>
        <dd>
          <ul className="ak-calls">
            {detail.calls.map((c) => (
              <li key={c}>
                <code>{c}</code>
              </li>
            ))}
          </ul>
        </dd>
      </dl>
    </div>
  );
}

function ActionForm(props: {
  action: FormAction;
  sub: string;
  submitLabel: string;
  children?: ReactNode;
  stepUpHref?: string;
  danger?: boolean;
}): ReactNode {
  const [result, run, pending] = useActionState(props.action, null);
  return (
    <form action={run} className="ak-action-form">
      <input type="hidden" name={F.sub} value={props.sub} />
      {props.children}
      <button type="submit" disabled={pending} className={props.danger ? 'ak-button ak-button-danger' : 'ak-button'}>
        {pending ? 'Working…' : props.submitLabel}
      </button>
      <ActionResultMessage result={result} {...(props.stepUpHref !== undefined && { stepUpHref: props.stepUpHref })} />
    </form>
  );
}

function ReasonField({ required, label }: { required: boolean; label?: string }): ReactNode {
  return (
    <label className="ak-field">
      <span>{label ?? (required ? 'Reason (goes in the audit log)' : 'Reason (optional; goes in the audit log)')}</span>
      <input type="text" name={F.reason} required={required} minLength={required ? 3 : undefined} maxLength={500} autoComplete="off" />
    </label>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toISOString().slice(0, 10);
}

// ---- People table -------------------------------------------------------------------------------

export interface PeopleTableActions {
  resend?: FormAction;
  changeRole?: FormAction;
  disable?: FormAction;
  enable?: FormAction;
  signOutEverywhere?: FormAction;
  deleteUser?: FormAction;
}

export interface PeopleTableProps {
  people: PeopleList;
  viewer: Viewer;
  actions: PeopleTableActions;
  /** Where "Sign in again to confirm" goes when an action needs a recent sign-in. */
  stepUpHref?: string;
  /** The app's own roles (its capability map's groups beyond the standard four). */
  appRoles?: readonly string[];
  /** False for an admin pool (no emailed codes), which changes the lost-passkey guide. Default true. */
  emailCodes?: boolean;
}

function statusText(p: PersonRow): { label: string; note?: string } {
  if (!p.enabled) return { label: 'Disabled', note: p.emailVerified ? 'Re-enabling restores member access only' : 'Invite revoked or expired' };
  switch (p.invite.status) {
    case 'accepted':
      return { label: 'Active' };
    case 'pending':
      return { label: `Invited · expires ${formatDate(p.invite.expiresAt)}`, note: 'Hasn’t signed in yet' };
    case 'expiring-soon':
      return { label: `Invite expiring ${formatDate(p.invite.expiresAt)}`, note: 'Hasn’t signed in yet' };
    case 'expired':
      return { label: 'Invite expired', note: 'Disabled by the next expiry sweep' };
    case 'disabled':
      return { label: 'Disabled' };
  }
}

/** Which actions this viewer may take on this person, as the server will judge them (it re-checks). */
export function allowedPeopleActions(viewer: Viewer, person: PersonRow, ownerCount: number, appRoles: readonly string[] = []): PeopleAction[] {
  const actor = {
    sub: viewer.sub,
    groups: viewer.groups,
    ...(viewer.capabilities !== undefined && { capabilities: new Set(viewer.capabilities) }),
  };
  const target = { sub: person.sub, groups: person.groups, enabled: person.enabled, invite: person.invite.status };
  const candidates: PeopleAction[] = person.enabled
    ? ['changeRole', 'resend', 'signOutEverywhere', 'disable']
    : ['enable', 'delete'];
  return candidates.filter((action) => {
    // changeRole is offered when any role change would pass; the dialog narrows the choice.
    const toRole = action === 'changeRole' ? (grantableRoles(viewer.groups).find((r) => r !== person.adminRole) ?? MEMBER_ROLE) : undefined;
    return checkPeopleAction({
      action,
      actor,
      target,
      knownRoles: appRoles,
      ownerCount,
      ...(toRole !== undefined && { toRole, reason: 'precheck' }),
    }).ok;
  });
}

/** Everyone who can get in, with honest gaps: a failed load says why, and nothing missing shows as zero. */
export function PeopleTable(props: PeopleTableProps): ReactNode {
  if (props.people.state === 'unavailable') {
    return (
      <div className="ak-people ak-unavailable" role="alert">
        <p>
          <strong>People (—)</strong>
        </p>
        <p>{props.people.reason}</p>
      </div>
    );
  }
  const { people, fetchedAt, truncated, inviteMode } = props.people;
  const ownerCount = people.filter((p) => p.adminRole === 'superadmin' && p.enabled).length;
  return (
    <div className="ak-people">
      <p className="ak-source">
        {people.length} {people.length === 1 ? 'person' : 'people'} · snapshot from ListUsers at {fetchedAt.replace('T', ' ').slice(0, 16)} UTC ·
        roles from ListUsersInGroup
        {truncated ? ` · showing the first ${people.length}; the list stops there` : ''}
      </p>
      <table className="ak-table">
        <thead>
          <tr>
            <th scope="col">Person</th>
            <th scope="col">Role</th>
            <th scope="col">Status</th>
            <th scope="col">Last sign-in</th>
            <th scope="col">
              <span className="ak-sr">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {people.map((p) => (
            <PersonRowView key={p.sub} person={p} ownerCount={ownerCount} inviteMode={inviteMode} {...props} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PersonRowView(props: PeopleTableProps & { person: PersonRow; ownerCount: number; inviteMode: InviteMode }): ReactNode {
  const { person: p, viewer } = props;
  const status = statusText(p);
  const appRoles = p.groups.filter((g) => !(STANDARD_GROUPS as readonly string[]).includes(g));
  const allowed = allowedPeopleActions(viewer, p, props.ownerCount, props.appRoles);
  const details = peopleActionDetails(props.inviteMode);
  const stepUp = props.stepUpHref !== undefined ? { stepUpHref: props.stepUpHref } : {};
  const a = props.actions;
  return (
    <tr className="ak-person">
      <td>
        <strong>{p.name ?? p.email}</strong>
        {p.sub === viewer.sub ? <span className="ak-you"> (you)</span> : null}
        {p.name ? <small className="ak-email">{p.email}</small> : null}
      </td>
      <td>
        {p.enabled ? roleLabel(p.adminRole) : <span className="ak-muted">Member only</span>}
        {appRoles.length > 0 ? <small className="ak-app-roles">{appRoles.join(', ')}</small> : null}
      </td>
      <td>
        {status.label}
        {status.note ? <small>{status.note}</small> : null}
      </td>
      <td>
        {p.lastSignInAt ? (
          formatDate(p.lastSignInAt)
        ) : (
          <span className="ak-dash" title="Cognito doesn’t record sign-ins; a sign-in trigger can">
            — <small>not recorded</small>
          </span>
        )}
      </td>
      <td className="ak-actions">
        {allowed.length === 0 ? (
          <span className="ak-muted">No actions for your role</span>
        ) : (
          <details>
            <summary>Manage</summary>
            {allowed.includes('changeRole') && a.changeRole ? (
              <RoleChangeDialog person={p} viewer={viewer} action={a.changeRole} ownerCount={props.ownerCount} {...stepUp} />
            ) : null}
            {allowed.includes('resend') && a.resend ? (
              <section className="ak-action">
                <h4>{details.resend.label}</h4>
                <ActionExplainer detail={details.resend} />
                <ActionForm action={a.resend} sub={p.sub} submitLabel={details.resend.label} {...stepUp} />
              </section>
            ) : null}
            {allowed.includes('signOutEverywhere') && a.signOutEverywhere ? (
              <section className="ak-action">
                <h4>{details.signOutEverywhere.label}</h4>
                <ActionExplainer detail={details.signOutEverywhere} />
                <ActionForm action={a.signOutEverywhere} sub={p.sub} submitLabel={details.signOutEverywhere.label} {...stepUp}>
                  <ReasonField required={false} />
                </ActionForm>
                <LostPasskeyGuide {...(props.emailCodes !== undefined && { emailCodes: props.emailCodes })} />
              </section>
            ) : null}
            {allowed.includes('disable') && a.disable ? (
              <section className="ak-action">
                <h4>{p.invite.status === 'accepted' ? details.disable.label : 'Revoke invite'}</h4>
                <ActionExplainer detail={details.disable} />
                <ActionForm
                  action={a.disable}
                  sub={p.sub}
                  submitLabel={p.invite.status === 'accepted' ? details.disable.label : 'Revoke invite'}
                  danger
                  {...stepUp}
                >
                  <ReasonField required={false} />
                </ActionForm>
              </section>
            ) : null}
            {allowed.includes('enable') && a.enable ? (
              <section className="ak-action">
                <h4>{details.enable.label}</h4>
                <ActionExplainer detail={details.enable} />
                <ActionForm action={a.enable} sub={p.sub} submitLabel={details.enable.label} {...stepUp}>
                  <ReasonField required={false} />
                </ActionForm>
              </section>
            ) : null}
            {allowed.includes('delete') && a.deleteUser ? (
              <section className="ak-action">
                <h4>{details.delete.label}</h4>
                <ActionExplainer detail={details.delete} />
                <ActionForm action={a.deleteUser} sub={p.sub} submitLabel="Delete permanently" danger {...stepUp}>
                  <label className="ak-field">
                    <span>Type {p.email} to confirm</span>
                    <input type="text" name={F.confirmEmail} required autoComplete="off" spellCheck={false} />
                  </label>
                  <ReasonField required />
                  <p className="ak-note">Owners only, after the retention period, with a sign-in in the last few minutes.</p>
                </ActionForm>
              </section>
            ) : null}
          </details>
        )}
      </td>
    </tr>
  );
}

// ---- Role change --------------------------------------------------------------------------------

export interface RoleChangeDialogProps {
  person: PersonRow;
  viewer: Viewer;
  action: FormAction;
  stepUpHref?: string;
  /** Enabled owners, for the "keep an owner" hint. The server re-counts live. */
  ownerCount?: number;
}

/** A dialog that changes someone's admin role, with a required reason. Granting is deliberate. */
export function RoleChangeDialog(props: RoleChangeDialogProps): ReactNode {
  const { person: p, viewer } = props;
  const dialog = useRef<HTMLDialogElement>(null);
  const current: StandardGroup | typeof MEMBER_ROLE = p.adminRole ?? MEMBER_ROLE;
  const choices = [...grantableRoles(viewer.groups).filter((r) => r !== current), ...(current !== MEMBER_ROLE ? [MEMBER_ROLE] : [])];
  const [toRole, setToRole] = useState<string>(choices[0] ?? MEMBER_ROLE);
  const [result, run, pending] = useActionState(props.action, null);
  const detail = peopleActionDetails().changeRole;
  const promotion = roleRank(toRole) > roleRank(p.adminRole);
  const lastOwner = p.adminRole === 'superadmin' && toRole !== 'superadmin' && (props.ownerCount ?? 0) <= 1;
  return (
    <section className="ak-action">
      <button type="button" className="ak-button" onClick={() => dialog.current?.showModal()}>
        {detail.label}
      </button>
      <dialog ref={dialog} className="ak-dialog" aria-labelledby={`ak-role-${p.sub}`}>
        <form action={run}>
          <h3 id={`ak-role-${p.sub}`}>
            Change {p.name ?? p.email}’s role: {roleLabel(current)} → {roleLabel(toRole)}
          </h3>
          <input type="hidden" name={F.sub} value={p.sub} />
          <input type="hidden" name={F.fromRole} value={current} />
          <label className="ak-field">
            <span>New role</span>
            <select name={F.toRole} value={toRole} onChange={(e) => setToRole(e.target.value)}>
              {STANDARD_GROUPS.map((r) => (
                <option key={r} value={r} disabled={!choices.includes(r)}>
                  {roleLabel(r)}
                  {choices.includes(r) ? '' : ADMIN_ROLE_RANK[r] >= ADMIN_ROLE_RANK.admin ? ' · owners only' : r === current ? ' · current' : ''}
                </option>
              ))}
              <option value={MEMBER_ROLE} disabled={!choices.includes(MEMBER_ROLE)}>
                Member (no admin role)
              </option>
            </select>
          </label>
          <label className="ak-field">
            <span>Reason (required; goes in the audit log)</span>
            <textarea name={F.reason} required minLength={3} maxLength={500} rows={2} />
          </label>
          <ActionExplainer detail={detail} />
          {toRole === 'superadmin' ? (
            <p className="ak-note ak-warn">{OWNER_GRANT_NOTE}</p>
          ) : promotion ? (
            <p className="ak-note">Granting a higher role needs a sign-in in the last few minutes.</p>
          ) : null}
          {lastOwner ? <p className="ak-note ak-warn">Each site keeps at least one owner. Add another owner first.</p> : null}
          <div className="ak-dialog-buttons">
            <button type="button" className="ak-button" onClick={() => dialog.current?.close()}>
              Cancel
            </button>
            <button type="submit" className="ak-button ak-button-primary" disabled={pending || choices.length === 0}>
              {pending ? 'Working…' : 'Change role'}
            </button>
          </div>
          <ActionResultMessage result={result} {...(props.stepUpHref !== undefined && { stepUpHref: props.stepUpHref })} />
        </form>
      </dialog>
    </section>
  );
}

// ---- Invite -------------------------------------------------------------------------------------

export interface InviteFormProps {
  action: FormAction;
  viewer: Viewer;
  /** The app's own roles, offered after the admin roles. */
  appRoles?: readonly string[];
  /** Usual invite domains; others get a warning and a confirmation box. */
  inviteDomains?: readonly string[];
  inviteMode?: InviteMode;
  stepUpHref?: string;
}

/** Invite someone: email, role, and (for admins and owners) a reason. The address is shown back before sending. */
export function InviteForm(props: InviteFormProps): ReactNode {
  const roles = [...grantableRoles(props.viewer.groups), ...(props.appRoles ?? []), MEMBER_ROLE];
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<string>(roles.includes('editor') ? 'editor' : (roles[0] ?? MEMBER_ROLE));
  const [result, run, pending] = useActionState(props.action, null);
  const detail = peopleActionDetails(props.inviteMode).invite;
  const domain = email.includes('@') ? email.slice(email.lastIndexOf('@') + 1).toLowerCase() : '';
  const domains = (props.inviteDomains ?? []).map((d) => d.toLowerCase().replace(/^@/, ''));
  const outside = domain !== '' && domains.length > 0 && !domains.includes(domain);
  const needsReason = roleRank(role) >= ADMIN_ROLE_RANK.admin;
  return (
    <form action={run} className="ak-invite">
      <label className="ak-field">
        <span>Email</span>
        <input type="email" name={F.email} required maxLength={254} autoComplete="off" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value.trim())} />
      </label>
      <label className="ak-field">
        <span>Name (optional)</span>
        <input type="text" name={F.name} maxLength={100} autoComplete="off" />
      </label>
      <label className="ak-field">
        <span>Role</span>
        <select name={F.role} value={role} onChange={(e) => setRole(e.target.value)}>
          {roles.map((r) => (
            <option key={r} value={r}>
              {r === MEMBER_ROLE ? 'Member (no admin role)' : roleLabel(r)}
            </option>
          ))}
        </select>
      </label>
      <ReasonField required={needsReason} {...(needsReason && { label: 'Reason (required for admins and owners; goes in the audit log)' })} />
      {outside ? (
        <label className="ak-field ak-warn">
          <input type="checkbox" name={F.confirmOutsideDomain} required />
          <span>
            {email} is outside the usual domains ({domains.join(', ')}). An invite to a mistyped address is a live account for whoever owns that inbox. I’ve checked it.
          </span>
        </label>
      ) : null}
      <ActionExplainer detail={detail} />
      {role === 'superadmin' ? (
        <p className="ak-note ak-warn">{OWNER_GRANT_NOTE}</p>
      ) : roleRank(role) > 0 ? (
        <p className="ak-note">Granting a role needs a sign-in in the last few minutes.</p>
      ) : null}
      <button type="submit" className="ak-button ak-button-primary" disabled={pending}>
        {pending ? 'Sending…' : email ? `Send invite to ${email}` : 'Send invite'}
      </button>
      <ActionResultMessage result={result} {...(props.stepUpHref !== undefined && { stepUpHref: props.stepUpHref })} />
    </form>
  );
}

// ---- Lost passkey -------------------------------------------------------------------------------

/** Why there's no "remove passkey" button, and the guided fix instead. */
export function LostPasskeyGuide({ emailCodes }: { emailCodes?: boolean }): ReactNode {
  const guide = lostPasskeyGuidance(emailCodes !== undefined ? { emailCodes } : {});
  return (
    <details className="ak-lost-passkey">
      <summary>Lost passkey?</summary>
      <p>{guide.why}</p>
      <ol>
        {guide.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
    </details>
  );
}

// ---- Activity -----------------------------------------------------------------------------------

export interface ActivityLogProps {
  page: ActivityPage;
  /** Link to the next (older) page, built from `page.nextCursor`. */
  nextHref?: string;
  /** Display names by sub. Default: the email recorded on the row. */
  names?: Readonly<Record<string, string>>;
}

/** The append-only audit log, newest first. A failed load says why; it never looks like "no activity". */
export function ActivityLog(props: ActivityLogProps): ReactNode {
  if (props.page.state === 'unavailable') {
    return (
      <div className="ak-activity ak-unavailable" role="alert">
        <p>
          <strong>Activity (—)</strong>
        </p>
        <p>{props.page.reason}</p>
      </div>
    );
  }
  const names = props.names ?? {};
  const { entries } = props.page;
  return (
    <div className="ak-activity">
      <p className="ak-note">
        Append-only: nobody can edit or delete entries, owners included. Each change is logged before it’s made, then its result.
      </p>
      {entries.length === 0 ? (
        <p className="ak-muted">No entries match.</p>
      ) : (
        <ol className="ak-log">
          {entries.map((entry) => {
            const line = describeActivity(entry, (sub) => names[sub]);
            return (
              <li key={entry.event.id} className={`ak-log-entry ak-log-${entry.status}`}>
                <time dateTime={entry.event.at}>{entry.event.at.replace('T', ' ').slice(0, 16)} UTC</time>{' '}
                <span>
                  <strong>{line.actor}</strong> {line.verb} {line.target ? <strong>{line.target}</strong> : null}
                  {line.change ? (
                    <>
                      : <code>{line.change}</code>
                    </>
                  ) : null}
                </span>
                {line.reason ? <q className="ak-reason">{line.reason}</q> : null}
                <small className="ak-trail">
                  {line.trail} · {line.status}
                  {line.from ? ` · from ${line.from}` : ''}
                </small>
              </li>
            );
          })}
        </ol>
      )}
      {props.nextHref && props.page.nextCursor ? (
        <p>
          <a href={props.nextHref}>Older entries</a>
        </p>
      ) : null}
    </div>
  );
}
