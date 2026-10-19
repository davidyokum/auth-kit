'use client';
/**
 * `auth-kit/admin/ui`: minimal React components for the People and Activity pages. Client
 * components (`'use client'`): render them from a server component and pass the server actions as
 * props. Every button says what Cognito call it makes and when the change takes effect; the server
 * re-checks everything, so these only decide what to offer.
 *
 * Unstyled, semantic HTML with `ak-` class names. Imports nothing server-side.
 */
import { type ReactNode, type RefObject, useActionState, useId, useRef, useState } from 'react';
import {
  type InviteMode,
  MEMBER_ROLE,
  OWNER_GROUP,
  type PeopleAction,
  type RoleOption,
  checkPeopleAction,
  grantableRoles,
  roleOptions,
  roleRank,
} from '../guardrails.js';
import {
  OWNER_ROLE_NOTE,
  RESOURCE_ACCESS_NOTE,
  SUPERADMIN_GRANT_NOTE,
  TRANSFER_OWNERSHIP_NOTE,
  describeActivity,
  type ActivityItem,
  lostPasskeyGuidance,
  ownerCountWarning,
  peopleActionDetails,
  roleLabel,
  type PeopleActionDetail,
} from '../copy.js';
import { ADMIN_ROLE_RANK, OWNER_CHOICE_LABEL, ROLE_MATRIX, STANDARD_GROUPS, type SiteRole } from '../../shared/policy.js';
import {
  PEOPLE_FORM_FIELDS as F,
  PENDING_REQUESTS_SHOWN,
  type AccessRequestList,
  type AccessRequestRow,
  type ActionResult,
  type ActivityPage,
  type FormAction,
  type PeopleList,
  type PersonRow,
} from '../types.js';

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
        <dt>Cognito calls (after the intent is in the audit log)</dt>
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
  /** The owner's Transfer ownership, offered from the role picker. */
  transferOwnership?: FormAction;
  disable?: FormAction;
  enable?: FormAction;
  signOutEverywhere?: FormAction;
  deleteUser?: FormAction;
}

export interface PeopleTableProps {
  people: PeopleList;
  viewer: Viewer;
  actions: PeopleTableActions;
  /**
   * Where "Sign in again to confirm" goes when an action needs a recent sign-in. Build it with
   * `signInUrl('/admin/people', { reauth: true })` (auth-kit/server), so the sign-in screen says it's
   * a step-up and comes back here: `/sign-in?next=%2Fadmin%2Fpeople&reauth=1`.
   */
  stepUpHref?: string;
  /** The app's own roles (its capability map's groups beyond the standard roles). */
  appRoles?: readonly string[];
  /** False for an admin pool (no emailed codes), which changes the lost-passkey guide. Default true. */
  emailCodes?: boolean;
  /** Links the note under the role picker to where item access is explained (resource roles: the items' list). */
  resourceAccessHref?: string;
  /** Shown under that note: `ResourceRolesSummary` from `auth-kit/resources/ui`, or the site's own section. */
  resourceAccess?: ReactNode;
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
    ? ['changeRole', 'transferOwnership', 'resend', 'signOutEverywhere', 'disable']
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
      ...(toRole !== undefined && { toRole }),
      ...((action === 'changeRole' || action === 'transferOwnership') && { reason: 'precheck' }),
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
  const ownerCount = people.filter((p) => p.groups.includes(OWNER_GROUP) && p.enabled).length;
  const ownerWarning = ownerCountWarning(ownerCount);
  return (
    <div className="ak-people">
      {ownerWarning ? (
        <p className="ak-note ak-warn ak-owner-count" role="alert">
          {truncated ? `The list stopped at ${people.length} people, so the owner count may be incomplete. ` : ''}
          {ownerWarning}
        </p>
      ) : null}
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
          <span className="ak-dash" title="Cognito doesn’t keep a last sign-in; a sign-in trigger can">
            — <small>not tracked</small>
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
              <RoleChangeDialog
                person={p}
                viewer={viewer}
                action={a.changeRole}
                ownerCount={props.ownerCount}
                {...(allowed.includes('transferOwnership') && a.transferOwnership && { transferAction: a.transferOwnership })}
                {...(props.resourceAccessHref !== undefined && { resourceAccessHref: props.resourceAccessHref })}
                {...(props.resourceAccess !== undefined && { resourceAccess: props.resourceAccess })}
                {...stepUp}
              />
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
                  <p className="ak-note">The owner and Super admins only, after the retention period, with a sign-in in the last few minutes.</p>
                </ActionForm>
              </section>
            ) : null}
          </details>
        )}
      </td>
    </tr>
  );
}

// ---- Roles: the picker, the comparison, and the resource-access note ------------------------------

/** "Compare roles": every role's powers side by side (`ROLE_MATRIX`), one click away. */
export function RoleMatrixTable({ caption }: { caption?: string }): ReactNode {
  return (
    <table className="ak-table ak-role-matrix">
      <caption>{caption ?? 'What each role can do. Each role includes everything below it.'}</caption>
      <thead>
        <tr>
          <th scope="col">Role</th>
          {ROLE_MATRIX.columns.map((c) => (
            <th scope="col" key={c}>
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {ROLE_MATRIX.rows.map((row) => (
          <tr key={row.role}>
            <th scope="row">{row.role === OWNER_GROUP ? OWNER_CHOICE_LABEL : row.label}</th>
            {ROLE_MATRIX.columns.map((c) => {
              const cell = row.cells[c];
              return (
                <td key={c} className={cell.allowed ? 'ak-yes' : 'ak-no'}>
                  {cell.allowed ? 'Yes' : 'No'}
                  {cell.note ? <small> · {cell.note}</small> : null}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A collapsed "Compare roles" with the matrix inside. */
export function CompareRoles(): ReactNode {
  return (
    <details className="ak-compare-roles">
      <summary>Compare roles</summary>
      <RoleMatrixTable />
    </details>
  );
}

export interface ResourceAccessNoteProps {
  /** Links the note's second sentence to where item access is explained (resource roles). */
  href?: string;
  /** Rendered under the note: the site's resource-access section, when it has one. */
  children?: ReactNode;
}

/**
 * Site roles aren't resource access: the note under every role picker, exactly as written in
 * `RESOURCE_ACCESS_NOTE`. With `href`, its second sentence links there (the words stay the same).
 */
export function ResourceAccessNote({ href, children }: ResourceAccessNoteProps): ReactNode {
  const split = RESOURCE_ACCESS_NOTE.indexOf('. ') + 2;
  const first = RESOURCE_ACCESS_NOTE.slice(0, split);
  const second = RESOURCE_ACCESS_NOTE.slice(split);
  return (
    <div className="ak-resource-access">
      <p className="ak-note">
        {href ? (
          <>
            {first}
            <a href={href}>{second}</a>
          </>
        ) : (
          RESOURCE_ACCESS_NOTE
        )}
      </p>
      {children}
    </div>
  );
}

/** One choice in a picker: a role option, or one of the app's own roles. */
export type RolePickerOption = Omit<RoleOption, 'role'> & { role: string };

export interface RolePickerProps {
  /** The form field: `role` (invite) or `toRole` (role change). */
  name: string;
  options: readonly RolePickerOption[];
  value: string;
  onChange: (role: string) => void;
  legend?: string;
  /** What the owner line offers: the owner's "Transfer ownership…", or why it isn't available. */
  ownerAction?: ReactNode;
  resourceAccessHref?: string;
  resourceAccess?: ReactNode;
}

/**
 * The role picker: each role with what it can and can't do, unavailable ones disabled with the
 * reason, the owner shown apart (it moves only by Transfer ownership), "Compare roles" one click
 * away, and the resource-access note at the bottom.
 */
export function RolePicker(props: RolePickerProps): ReactNode {
  const id = useId();
  return (
    <fieldset className="ak-role-picker">
      <legend>{props.legend ?? 'Role'}</legend>
      <ul className="ak-role-options">
        {props.options.map((o) => {
          const reasonId = `${id}-${o.role}-why`;
          return (
            <li key={o.role} className={o.available ? 'ak-role-option' : 'ak-role-option ak-role-unavailable'}>
              <label>
                <input
                  type="radio"
                  name={props.name}
                  value={o.role}
                  checked={props.value === o.role}
                  disabled={!o.available}
                  onChange={() => props.onChange(o.role)}
                  {...(o.reason !== undefined && { 'aria-describedby': reasonId })}
                />
                <span className="ak-role-label">{o.label}</span>
                <small className="ak-role-can">Can: {o.can}</small>
                <small className="ak-role-cannot">Can’t: {o.cannot}</small>
                {o.reason ? (
                  <small className="ak-role-reason" id={reasonId}>
                    {o.reason}
                  </small>
                ) : null}
              </label>
            </li>
          );
        })}
      </ul>
      <div className="ak-role-owner">
        <p className="ak-note">{OWNER_ROLE_NOTE}</p>
        {props.ownerAction}
      </div>
      <CompareRoles />
      <ResourceAccessNote {...(props.resourceAccessHref !== undefined && { href: props.resourceAccessHref })}>{props.resourceAccess}</ResourceAccessNote>
    </fieldset>
  );
}

function appRoleOption(role: string): RolePickerOption {
  return {
    role,
    label: role,
    can: 'This site’s own role: what it allows is set in the site’s capability map.',
    cannot: 'Open the admin area, unless the site’s map says so.',
    available: true,
    current: false,
  };
}

// ---- Role change --------------------------------------------------------------------------------

export interface RoleChangeDialogProps {
  person: PersonRow;
  viewer: Viewer;
  action: FormAction;
  /** Where "Sign in again to confirm" goes: `signInUrl('/admin/people', { reauth: true })`. */
  stepUpHref?: string;
  /** Enabled owners, for the hints. The server re-counts live. */
  ownerCount?: number;
  /** The owner's Transfer ownership for this person, offered on the owner line. */
  transferAction?: FormAction;
  resourceAccessHref?: string;
  resourceAccess?: ReactNode;
}

/** A dialog that changes someone's admin role, with a required reason. Granting is deliberate. */
export function RoleChangeDialog(props: RoleChangeDialogProps): ReactNode {
  const { person: p, viewer } = props;
  const dialog = useRef<HTMLDialogElement>(null);
  const transferDialog = useRef<HTMLDialogElement>(null);
  const isOwner = p.groups.includes(OWNER_GROUP);
  const current: SiteRole = isOwner ? OWNER_GROUP : (p.adminRole ?? MEMBER_ROLE);
  const options = roleOptions(viewer.groups, isOwner ? undefined : current);
  const first = options.find((o) => o.available)?.role;
  const [toRole, setToRole] = useState<string>(first ?? MEMBER_ROLE);
  const [result, run, pending] = useActionState(props.action, null);
  const detail = peopleActionDetails().changeRole;
  const promotion = roleRank(toRole) > roleRank(current);
  const viewerIsOwner = viewer.groups.includes(OWNER_GROUP);
  const transferCheck = viewerIsOwner
    ? checkPeopleAction({
        action: 'transferOwnership',
        actor: { sub: viewer.sub, groups: viewer.groups, ...(viewer.capabilities !== undefined && { capabilities: new Set(viewer.capabilities) }) },
        target: { sub: p.sub, groups: p.groups, enabled: p.enabled, invite: p.invite.status },
        reason: 'precheck',
      })
    : null;
  const ownerAction = !viewerIsOwner ? null : transferCheck?.ok && props.transferAction ? (
    <button
      type="button"
      className="ak-button"
      onClick={() => {
        dialog.current?.close();
        transferDialog.current?.showModal();
      }}
    >
      Transfer ownership…
    </button>
  ) : transferCheck && !transferCheck.ok ? (
    <p className="ak-note ak-muted">Transfer ownership: {transferCheck.reason}</p>
  ) : null;
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
          {isOwner ? (
            <p className="ak-note ak-warn">
              {(props.ownerCount ?? 0) > 1
                ? `This site has ${props.ownerCount} owners; it should have one. Changing this owner’s role brings it back toward one.`
                : 'This is the site’s owner. The owner’s role changes only by Transfer ownership.'}
            </p>
          ) : null}
          <RolePicker
            name={F.toRole}
            legend="New role"
            options={options}
            value={toRole}
            onChange={setToRole}
            ownerAction={ownerAction}
            {...(props.resourceAccessHref !== undefined && { resourceAccessHref: props.resourceAccessHref })}
            {...(props.resourceAccess !== undefined && { resourceAccess: props.resourceAccess })}
          />
          <label className="ak-field">
            <span>Reason (required; goes in the audit log)</span>
            <textarea name={F.reason} required minLength={3} maxLength={500} rows={2} />
          </label>
          <ActionExplainer detail={detail} />
          {toRole === 'superadmin' ? (
            <p className="ak-note ak-warn">{SUPERADMIN_GRANT_NOTE}</p>
          ) : promotion ? (
            <p className="ak-note">Granting a higher role needs a sign-in in the last few minutes.</p>
          ) : null}
          <div className="ak-dialog-buttons">
            <button type="button" className="ak-button" onClick={() => dialog.current?.close()}>
              Cancel
            </button>
            <button type="submit" className="ak-button ak-button-primary" disabled={pending || first === undefined}>
              {pending ? 'Working…' : 'Change role'}
            </button>
          </div>
          <ActionResultMessage result={result} {...(props.stepUpHref !== undefined && { stepUpHref: props.stepUpHref })} />
        </form>
      </dialog>
      {transferCheck?.ok && props.transferAction ? (
        <TransferOwnershipForm
          dialogRef={transferDialog}
          person={p}
          action={props.transferAction}
          {...(props.stepUpHref !== undefined && { stepUpHref: props.stepUpHref })}
        />
      ) : null}
    </section>
  );
}

// ---- Transfer ownership -------------------------------------------------------------------------

export interface TransferOwnershipDialogProps {
  /** Who becomes the owner. */
  person: PersonRow;
  action: FormAction;
  /** Where "Sign in again to confirm" goes: `signInUrl('/admin/people', { reauth: true })`. */
  stepUpHref?: string;
}

function TransferOwnershipForm(props: TransferOwnershipDialogProps & { dialogRef: RefObject<HTMLDialogElement | null> }): ReactNode {
  const { person: p } = props;
  const [result, run, pending] = useActionState(props.action, null);
  const detail = peopleActionDetails().transferOwnership;
  return (
    <dialog ref={props.dialogRef} className="ak-dialog" aria-labelledby={`ak-transfer-${p.sub}`}>
      <form action={run}>
        <h3 id={`ak-transfer-${p.sub}`}>Transfer ownership to {p.name ?? p.email}</h3>
        <input type="hidden" name={F.sub} value={p.sub} />
        <p className="ak-note ak-warn">{TRANSFER_OWNERSHIP_NOTE}</p>
        <label className="ak-field">
          <span>Type {p.email} to confirm</span>
          <input type="text" name={F.confirmEmail} required autoComplete="off" spellCheck={false} />
        </label>
        <label className="ak-field">
          <span>Reason (required; goes in the audit log)</span>
          <textarea name={F.reason} required minLength={3} maxLength={500} rows={2} />
        </label>
        <ActionExplainer detail={detail} />
        <div className="ak-dialog-buttons">
          <button type="button" className="ak-button" onClick={() => props.dialogRef.current?.close()}>
            Cancel
          </button>
          <button type="submit" className="ak-button ak-button-danger" disabled={pending}>
            {pending ? 'Working…' : 'Transfer ownership'}
          </button>
        </div>
        <ActionResultMessage result={result} {...(props.stepUpHref !== undefined && { stepUpHref: props.stepUpHref })} />
      </form>
    </dialog>
  );
}

/**
 * The owner's "Transfer ownership…": they become the owner, you become Super admin, both of you are
 * emailed. Needs their address typed out, a reason, and a recent sign-in; the server re-checks all of
 * it (owner only, to an enabled account that has signed in).
 */
export function TransferOwnershipDialog(props: TransferOwnershipDialogProps): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <section className="ak-action">
      <button type="button" className="ak-button" onClick={() => dialog.current?.showModal()}>
        Transfer ownership…
      </button>
      <TransferOwnershipForm dialogRef={dialog} {...props} />
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
  /** Where "Sign in again to confirm" goes: `signInUrl('/admin/people', { reauth: true })`. */
  stepUpHref?: string;
  /** Links the note under the role picker to where item access is explained. */
  resourceAccessHref?: string;
  /** Shown under that note: the site's resource-access section, when it has one. */
  resourceAccess?: ReactNode;
}

/**
 * Invite someone: email, role, and (for Admin – content & people and Super admin) a reason. The
 * address is shown back before sending. Member is the default: the least access.
 */
export function InviteForm(props: InviteFormProps): ReactNode {
  const standard = roleOptions(props.viewer.groups);
  const member = standard.filter((o) => o.role === MEMBER_ROLE);
  const options: RolePickerOption[] = [...standard.filter((o) => o.role !== MEMBER_ROLE), ...(props.appRoles ?? []).map(appRoleOption), ...member];
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<string>(MEMBER_ROLE);
  const [result, run, pending] = useActionState(props.action, null);
  const detail = peopleActionDetails(props.inviteMode).invite;
  const domain = email.includes('@') ? email.slice(email.lastIndexOf('@') + 1).toLowerCase() : '';
  const domains = (props.inviteDomains ?? []).map((d) => d.toLowerCase().replace(/^@/, ''));
  const outside = domain !== '' && domains.length > 0 && !domains.includes(domain);
  const needsReason = roleRank(role) >= ADMIN_ROLE_RANK['admin-content-people'];
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
      <RolePicker
        name={F.role}
        options={options}
        value={role}
        onChange={setRole}
        ownerAction={<p className="ak-note ak-muted">To make someone the owner, invite them first; once they’ve signed in, the owner can transfer ownership to them.</p>}
        {...(props.resourceAccessHref !== undefined && { resourceAccessHref: props.resourceAccessHref })}
        {...(props.resourceAccess !== undefined && { resourceAccess: props.resourceAccess })}
      />
      <ReasonField required={needsReason} {...(needsReason && { label: `Reason (required for ${roleLabel(role)}; goes in the audit log)` })} />
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
        <p className="ak-note ak-warn">{SUPERADMIN_GRANT_NOTE}</p>
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
  /**
   * Items' current nouns and names by `target.recordId` (`project:abc`), from the app's own store.
   * Default: what the row recorded. Items are never shown by their ID.
   */
  items?: Readonly<Record<string, ActivityItem>>;
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
  const items = props.items ?? {};
  const { entries } = props.page;
  return (
    <div className="ak-activity">
      <p className="ak-note">
        Append-only: nobody can edit or delete entries, the owner included. Each change is logged before it’s made, then its result.
      </p>
      {entries.length === 0 ? (
        <p className="ak-muted">No entries match.</p>
      ) : (
        <ol className="ak-log">
          {entries.map((entry) => {
            const line = describeActivity(entry, (sub) => names[sub], { items: (recordId) => items[recordId] });
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

// ---- Access requests (ADR 0023) -----------------------------------------------------------------

/**
 * The People page's badge: how many requests wait. "—" (with the reason) when they couldn't be read,
 * never zero; nothing at all when there are none or the site takes no requests.
 */
export function PendingRequestsBadge({ list }: { list: AccessRequestList }): ReactNode {
  if (list.state === 'off') return null;
  if (list.state === 'unavailable') {
    return (
      <span className="ak-badge ak-badge-unknown" title={list.reason}>
        —<span className="ak-sr"> (pending requests couldn’t be read: {list.reason})</span>
      </span>
    );
  }
  const n = list.requests.length;
  if (n === 0) return null;
  return (
    <span className="ak-badge" aria-label={`${n}${list.truncated ? ' or more' : ''} pending ${n === 1 ? 'request' : 'requests'}`}>
      {n}
      {list.truncated ? '+' : ''}
    </span>
  );
}

export interface PeoplePageTabsProps {
  /** The People list (`PeopleTable`, `InviteForm`). */
  people: ReactNode;
  /** The "Pending requests" tab's content (`PendingRequestsTable`). Leave out where the site takes no requests. */
  requests?: ReactNode;
  /** For the tab's badge. */
  requestList?: AccessRequestList;
}

/** People and "Pending requests", as two tabs (WAI-ARIA tabs pattern). */
export function PeoplePageTabs(props: PeoplePageTabsProps): ReactNode {
  const id = useId();
  const [tab, setTab] = useState<'people' | 'requests'>('people');
  if (!props.requests) return <div className="ak-people-page">{props.people}</div>;
  const tabs = [
    { key: 'people' as const, label: 'People' },
    { key: 'requests' as const, label: 'Pending requests' },
  ];
  return (
    <div className="ak-people-page">
      <div role="tablist" aria-label="People" className="ak-tabs">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            id={`${id}-${t.key}-tab`}
            aria-controls={`${id}-${t.key}-panel`}
            aria-selected={tab === t.key}
            tabIndex={tab === t.key ? 0 : -1}
            className="ak-tab"
            onClick={() => setTab(t.key)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') setTab(tab === 'people' ? 'requests' : 'people');
            }}
          >
            {t.label} {t.key === 'requests' && props.requestList ? <PendingRequestsBadge list={props.requestList} /> : null}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${id}-people-panel`} aria-labelledby={`${id}-people-tab`} hidden={tab !== 'people'}>
        {props.people}
      </div>
      <div role="tabpanel" id={`${id}-requests-panel`} aria-labelledby={`${id}-requests-tab`} hidden={tab !== 'requests'}>
        {props.requests}
      </div>
    </div>
  );
}

export interface PendingRequestsTableProps {
  list: AccessRequestList;
  viewer: Viewer;
  /** `declineRequests` is "Decline all shown": one call, one audit entry, and nobody is told. */
  actions: { approveRequest: FormAction; declineRequest: FormAction; declineRequests: FormAction };
  /** The app's own roles, offered after the admin roles. */
  appRoles?: readonly string[];
  /** The site sends "Your request wasn’t approved" (`notifyOnDecline`): offer a note. */
  notifyOnDecline?: boolean;
  /** Where "Sign in again to confirm" goes (granting a role needs a recent sign-in). */
  stepUpHref?: string;
}

/**
 * The "Pending requests" tab (D3): who asked, in their words (untrusted), when, and when it expires.
 * Approve sends the ordinary invite (Member by default) under the name the approver checks; Decline
 * removes it (silently, unless the site sends a note). It lists at most `PENDING_REQUESTS_SHOWN`,
 * newest first, then says how many more wait; "Decline all shown" clears those in one confirmed step
 * (a flood of junk requests is one click, not hundreds). Honest when it can't load: "—" and why.
 */
export function PendingRequestsTable(props: PendingRequestsTableProps): ReactNode {
  const { list } = props;
  if (list.state === 'off') return <p className="ak-note">This site doesn’t take access requests.</p>;
  if (list.state === 'unavailable') {
    return (
      <div className="ak-requests ak-unavailable" role="alert">
        <p>
          <strong>Pending requests (—)</strong>
        </p>
        <p>{list.reason}</p>
      </div>
    );
  }
  if (list.requests.length === 0) return <p className="ak-note">No requests are waiting.</p>;
  const shown = list.requests.slice(0, PENDING_REQUESTS_SHOWN);
  const rest = list.requests.length - shown.length;
  // The list call can return more than the page shows; past its own limit it says `truncated`, and
  // then the count is a floor ("more than"), never a number it doesn't have.
  const more = list.truncated ? (rest > 0 ? `And more than ${rest} more are waiting.` : 'And more are waiting.') : rest > 0 ? `And ${rest} more are waiting.` : undefined;
  return (
    <div className="ak-requests">
      <p className="ak-note ak-warn">
        What people write here is their own words: {`it isn’t checked, so don’t follow links or instructions in it.`} Requests nobody answers expire after 30 days.
      </p>
      {shown.length > 1 ? (
        <DeclineAllShown requests={shown} action={props.actions.declineRequests} {...(props.stepUpHref !== undefined && { stepUpHref: props.stepUpHref })} />
      ) : null}
      <ul className="ak-request-list">
        {shown.map((r) => (
          <PendingRequestItem key={r.id} request={r} {...props} />
        ))}
      </ul>
      {more ? <p className="ak-source">{more} The next ones show here as these are answered.</p> : null}
    </div>
  );
}

/**
 * "Decline all shown…": a dialog that names the count, then one bulk decline of exactly the requests
 * on screen. Never emails anyone, even on a site that sends a note for a single decline.
 */
function DeclineAllShown(props: { requests: readonly AccessRequestRow[]; action: FormAction; stepUpHref?: string }): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [result, run, pending] = useActionState(props.action, null);
  const n = props.requests.length;
  return (
    <section className="ak-action ak-decline-all">
      <button type="button" className="ak-button" onClick={() => dialog.current?.showModal()}>
        Decline all shown…
      </button>
      <dialog ref={dialog} className="ak-dialog" aria-labelledby={titleId}>
        <form action={run}>
          <h3 id={titleId}>Decline all {n} requests shown?</h3>
          {props.requests.map((r) => (
            <input key={r.id} type="hidden" name="id" value={r.id} />
          ))}
          <p className="ak-note ak-warn">
            Nobody is told, even on a site that sends a note when it declines one request: a flood of requests can carry anyone’s address, and the site won’t mail them
            all. The requests leave the queue, and anyone who still wants in can ask again.
          </p>
          <ReasonField required={false} />
          <div className="ak-dialog-buttons">
            <button type="button" className="ak-button" onClick={() => dialog.current?.close()}>
              Cancel
            </button>
            <button type="submit" className="ak-button ak-button-danger" disabled={pending}>
              {pending ? 'Working…' : `Yes, decline ${n} requests`}
            </button>
          </div>
          <ActionResultMessage result={result} {...(props.stepUpHref !== undefined && { stepUpHref: props.stepUpHref })} />
        </form>
      </dialog>
    </section>
  );
}

function PendingRequestItem(props: PendingRequestsTableProps & { request: AccessRequestRow }): ReactNode {
  const r = props.request;
  const [role, setRole] = useState<string>(MEMBER_ROLE);
  const [approveResult, approve, approving] = useActionState(props.actions.approveRequest, null);
  const [declineResult, decline, declining] = useActionState(props.actions.declineRequest, null);
  const options = [MEMBER_ROLE, ...grantableRoles(props.viewer.groups), ...(props.appRoles ?? [])];
  const needsReason = roleRank(role) >= ADMIN_ROLE_RANK['admin-content-people'];
  const stepUp = props.stepUpHref !== undefined ? { stepUpHref: props.stepUpHref } : {};
  return (
    <li className="ak-request">
      <p>
        <strong>{r.email}</strong>
      </p>
      {r.reason ? <blockquote className="ak-request-reason">“{r.reason}”</blockquote> : null}
      <p className="ak-muted">
        Asked {formatDate(r.createdAt)} · expires {formatDate(r.expiresAt)}
      </p>
      <form action={approve} className="ak-action-form">
        <input type="hidden" name="id" value={r.id} />
        {/* The typed name is the requester's words: shown as theirs, and the account gets the name the approver checks. */}
        {r.name ? <p className="ak-request-name">They wrote: “{r.name}”</p> : null}
        <label className="ak-field">
          <span>Name on the account (optional; check it before you approve)</span>
          <input type="text" name={F.name} maxLength={100} autoComplete="off" defaultValue={r.name ?? ''} />
        </label>
        <label className="ak-field">
          <span>Role</span>
          <select name={F.role} value={role} onChange={(e) => setRole(e.target.value)}>
            {options.map((o) => (
              <option key={o} value={o}>
                {roleLabel(o)}
              </option>
            ))}
          </select>
        </label>
        {needsReason ? <ReasonField required label={`Reason (required for ${roleLabel(role)}; goes in the audit log)`} /> : null}
        <button type="submit" className="ak-button ak-button-primary" disabled={approving || declining}>
          {approving ? 'Working…' : `Approve: invite ${r.email}`}
        </button>
        <ActionResultMessage result={approveResult} {...stepUp} />
      </form>
      <form action={decline} className="ak-action-form">
        <input type="hidden" name="id" value={r.id} />
        {props.notifyOnDecline ? (
          <label className="ak-field">
            <span>Note to {r.email} (optional)</span>
            <input type="text" name="note" maxLength={500} autoComplete="off" />
          </label>
        ) : null}
        <button type="submit" className="ak-button" disabled={approving || declining}>
          {declining ? 'Working…' : props.notifyOnDecline ? 'Decline and tell them' : 'Decline (they aren’t told)'}
        </button>
        <ActionResultMessage result={declineResult} {...stepUp} />
      </form>
    </li>
  );
}

// ---- Settings: sign-in help (ADR 0024) -----------------------------------------------------------

/** What `createSignInHelpActions(…).get()` returns (`auth-kit/accounts`). */
export type SignInHelpSettingsView =
  | {
      state: 'ok';
      configured: string;
      override: { address: string; personal?: true; updatedAt: string; updatedBy: { sub: string; email?: string }; reason?: string } | null;
      effective: { address: string; source: 'override' | 'config' };
      version: number;
    }
  | { state: 'unavailable'; configured: string; reason: string }
  | { state: 'forbidden'; reason: string };

export interface SignInHelpSettingsProps {
  view: SignInHelpSettingsView;
  actions: { set: FormAction; clear: FormAction };
  /** Where "Sign in again to confirm" goes (a change needs a recent sign-in). */
  stepUpHref?: string;
}

/**
 * Settings → "Sign-in help" (Super admins, `settings.security`): the help address the sign-in page and
 * emails name, changed without a deploy. Every change is audited and the owner is told.
 */
export function SignInHelpSettings(props: SignInHelpSettingsProps): ReactNode {
  const { view } = props;
  const [setResult, setRun, setting] = useActionState(props.actions.set, null);
  const [clearResult, clearRun, clearing] = useActionState(props.actions.clear, null);
  const stepUp = props.stepUpHref !== undefined ? { stepUpHref: props.stepUpHref } : {};
  if (view.state === 'forbidden') return <p className="ak-note">{view.reason}</p>;
  if (view.state === 'unavailable') {
    return (
      <section className="ak-settings ak-unavailable" role="alert">
        <h2>Sign-in help</h2>
        <p>{view.reason}</p>
      </section>
    );
  }
  return (
    <section className="ak-settings">
      <h2>Sign-in help</h2>
      <p>
        People who can’t sign in are told to write to <strong>{view.effective.address}</strong>{' '}
        {view.effective.source === 'override' ? '(set here)' : '(the site’s configured address)'}. It’s on the help screens and in the footer and Reply-To of the
        app’s emails.
      </p>
      {view.override ? (
        <p className="ak-muted">
          Changed {formatDate(view.override.updatedAt)} by {view.override.updatedBy.email ?? 'a Super admin'}
          {view.override.reason ? `: “${view.override.reason}”` : ''}. The configured address is {view.configured}.
        </p>
      ) : null}
      <p className="ak-note">
        Use a role-based mailbox that the people who can reset accounts read. Whoever reads it can be asked to reset authenticators and move accounts to new addresses.
        The owner is told about every change.
      </p>
      <form action={setRun} className="ak-action-form">
        <input type="hidden" name="version" value={view.version} />
        <label className="ak-field">
          <span>Help address</span>
          <input type="email" name="address" required maxLength={254} autoComplete="off" spellCheck={false} defaultValue={view.effective.address} />
        </label>
        <label className="ak-check">
          <input type="checkbox" name="personal" defaultChecked={view.override?.personal === true} />
          <span>This is a person’s own address, on purpose (the site deliberately names one person). Without this, a first.last address is refused.</span>
        </label>
        <ReasonField required label="Reason (goes in the audit log and the owner’s alert)" />
        <p className="ak-note">Changing it needs a sign-in in the last few minutes.</p>
        <button type="submit" className="ak-button ak-button-primary" disabled={setting || clearing}>
          {setting ? 'Saving…' : 'Save the help address'}
        </button>
        <ActionResultMessage result={setResult} {...stepUp} />
      </form>
      {view.override ? (
        <form action={clearRun} className="ak-action-form">
          <input type="hidden" name="version" value={view.version} />
          <ReasonField required />
          <button type="submit" className="ak-button" disabled={setting || clearing}>
            {clearing ? 'Working…' : `Go back to ${view.configured}`}
          </button>
          <ActionResultMessage result={clearResult} {...stepUp} />
        </form>
      ) : null}
    </section>
  );
}
