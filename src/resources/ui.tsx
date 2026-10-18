'use client';
/**
 * `auth-kit/resources/ui`: the "Who has access" panel for one item, and the pieces it's made of.
 * Client components (`'use client'`): render them from a server component, with the item's access
 * list (`resourceActions.listAccess`) and the server actions as props. The server re-checks every
 * change; these only decide what to offer, with the same rules (`checkAccessChange`).
 *
 * Screens use the app's own noun ("Who has access to this project"), never "resource" or "record".
 * Unstyled, semantic HTML with `ak-` class names. Imports nothing server-side.
 */
import { type ReactNode, useActionState, useId, useState } from 'react';
import { ActionResultMessage } from '../admin/ui/index.js';
import type { ActionResult, FormAction } from '../admin/types.js';
import {
  RESOURCE_ACCESS_MATRIX,
  RESOURCE_ACTION_LABEL,
  RESOURCE_ROLE_LABEL,
  type ResourceRole,
  resourceRoleDescriptions,
} from '../shared/policy.js';
import { type ResourceRoleOption, checkAccessChange, resourceAccessCopy } from './policy.js';
import { RESOURCE_FORM_FIELDS as F, type ResourceAccessList, type ResourceMemberRow } from './types.js';

type OkList = Extract<ResourceAccessList, { state: 'ok' }>;

/** A stand-in for an action the page didn't pass (its form isn't rendered, so it never runs). */
const NO_ACTION: FormAction = (previous) => Promise.resolve(previous ?? { ok: false, code: 'invalid', error: 'Not available.', changed: 'nothing' });

// ---- Small pieces -----------------------------------------------------------------------------

/** A role as a chip: "Manager", "Contributor", "Reader". */
export function ResourceRoleChip({ role }: { role: ResourceRole }): ReactNode {
  return <span className={`ak-role-chip ak-role-chip-${role}`}>{RESOURCE_ROLE_LABEL[role]}</span>;
}

export interface ResourceRolePickerProps {
  /** The form field: `role` (add, invite) or `toRole`. */
  name: string;
  options: readonly ResourceRoleOption[];
  value: ResourceRole;
  onChange: (role: ResourceRole) => void;
  legend?: string;
}

/** Manager, Contributor, Reader, each with what it can and can't do on this item. */
export function ResourceRolePicker(props: ResourceRolePickerProps): ReactNode {
  const id = useId();
  return (
    <fieldset className="ak-role-picker ak-resource-role-picker">
      <legend>{props.legend ?? 'Role'}</legend>
      <ul className="ak-role-options">
        {props.options.map((o) => (
          <li key={o.role} className="ak-role-option">
            <label htmlFor={`${id}-${o.role}`}>
              <input
                id={`${id}-${o.role}`}
                type="radio"
                name={props.name}
                value={o.role}
                checked={props.value === o.role}
                onChange={() => props.onChange(o.role)}
              />
              <span className="ak-role-label">{o.label}</span>
              <small className="ak-role-can">Can: {o.can}</small>
              <small className="ak-role-cannot">Can’t: {o.cannot}</small>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

function ItemFields({ access }: { access: OkList }): ReactNode {
  return (
    <>
      <input type="hidden" name={F.type} value={access.type} />
      <input type="hidden" name={F.id} value={access.id} />
    </>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toISOString().slice(0, 10);
}

// ---- One person's row -------------------------------------------------------------------------

interface MemberRowProps {
  access: OkList;
  member: ResourceMemberRow;
  noun: string;
  changeRole?: FormAction;
  remove?: FormAction;
  stepUpHref?: string;
}

function MemberRow(props: MemberRowProps): ReactNode {
  const { access, member: m, noun } = props;
  const copy = resourceAccessCopy(noun);
  const you = m.sub === access.viewer.sub;
  const actor = { sub: access.viewer.sub, actions: access.viewer.actions, siteActions: access.viewer.siteActions };
  const target = { sub: m.sub, role: m.role };
  const otherRole: ResourceRole = m.role === 'manager' ? 'contributor' : 'manager';
  const canChange = checkAccessChange({ change: 'changeRole', actor, target, toRole: otherRole, managers: access.managers, noun });
  const canRemove = checkAccessChange({ change: 'remove', actor, target, managers: access.managers, noun });
  // The last Manager: a site admin who manages access can still act, by naming the new Manager.
  const lastManager = !canRemove.ok && canRemove.code === 'last_manager';
  const adminReplace = lastManager && access.viewer.siteActions.includes('manage-access');
  const manages = access.viewer.actions.includes('manage-access');
  const [toRole, setToRole] = useState<ResourceRole>(m.role);
  const [changeResult, runChange, changing] = useActionState<ActionResult | null, FormData>(props.changeRole ?? NO_ACTION, null);
  const [removeResult, runRemove, removing] = useActionState<ActionResult | null, FormData>(props.remove ?? NO_ACTION, null);
  const stepUp = props.stepUpHref !== undefined ? { stepUpHref: props.stepUpHref } : {};
  const replaceField = (
    <label className="ak-field">
      <span>New Manager’s email (they become a Manager in the same step)</span>
      <input type="email" name={F.replaceWithEmail} required maxLength={254} autoComplete="off" spellCheck={false} />
    </label>
  );
  return (
    <li className="ak-access-member">
      <div className="ak-access-who">
        <strong>{m.name ?? m.email ?? m.sub}</strong>
        {you ? <span className="ak-you"> (you)</span> : null}
        {m.name && m.email ? <small className="ak-email">{m.email}</small> : null}
        <ResourceRoleChip role={m.role} />
        <small className="ak-access-added">
          Added {formatDate(m.addedAt)}
          {m.addedByEmail ? ` by ${m.addedByEmail}` : ''}
        </small>
      </div>
      {manages && props.changeRole && (canChange.ok || adminReplace) ? (
        <form action={runChange} className="ak-action-form ak-access-change">
          <ItemFields access={access} />
          <input type="hidden" name={F.sub} value={m.sub} />
          <input type="hidden" name={F.fromRole} value={m.role} />
          <label className="ak-field">
            <span>Role</span>
            <select name={F.toRole} value={toRole} onChange={(e) => setToRole(e.target.value as ResourceRole)}>
              {access.roles.map((o) => (
                <option key={o.role} value={o.role}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          {adminReplace && toRole !== 'manager' ? replaceField : null}
          <button type="submit" className="ak-button" disabled={changing || toRole === m.role}>
            {changing ? 'Working…' : 'Change role'}
          </button>
          <ActionResultMessage result={changeResult} {...stepUp} />
        </form>
      ) : null}
      {props.remove && (canRemove.ok || adminReplace) ? (
        <form action={runRemove} className="ak-action-form ak-access-remove">
          <ItemFields access={access} />
          <input type="hidden" name={F.sub} value={m.sub} />
          {adminReplace ? replaceField : null}
          <button type="submit" className="ak-button ak-button-danger" disabled={removing}>
            {removing ? 'Working…' : you ? copy.leave : 'Remove'}
          </button>
          <ActionResultMessage result={removeResult} {...stepUp} />
        </form>
      ) : null}
      {lastManager && (you || manages) ? (
        <p className="ak-note ak-access-last-manager">
          {copy.lastManager}
          {adminReplace ? ' As a site admin, you can name the new Manager in the same step.' : ''}
        </p>
      ) : null}
    </li>
  );
}

// ---- Add and invite ---------------------------------------------------------------------------

function AddMemberForm(props: { access: OkList; action: FormAction; noun: string; onNoAccount: (email: string) => void; stepUpHref?: string }): ReactNode {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<ResourceRole>('reader');
  const wrapped: FormAction = async (previous, data) => {
    const result = await props.action(previous, data);
    const email = data.get(F.email);
    if (!result.ok && result.guardrail === 'no_account') props.onNoAccount(typeof email === 'string' ? email : '');
    return result;
  };
  const [result, run, pending] = useActionState(wrapped, null);
  const copy = resourceAccessCopy(props.noun);
  return (
    <form action={run} className="ak-access-add" aria-label={copy.share}>
      <h3>{copy.share}</h3>
      <ItemFields access={props.access} />
      <label className="ak-field">
        <span>Email of someone with an account</span>
        <input type="email" name={F.email} required maxLength={254} autoComplete="off" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value.trim())} />
      </label>
      <ResourceRolePicker name={F.role} options={props.access.roles} value={role} onChange={setRole} />
      <button type="submit" className="ak-button ak-button-primary" disabled={pending}>
        {pending ? 'Adding…' : email ? `Add ${email} as ${RESOURCE_ROLE_LABEL[role]}` : 'Add'}
      </button>
      <ActionResultMessage result={result} {...(props.stepUpHref !== undefined && { stepUpHref: props.stepUpHref })} />
    </form>
  );
}

function InviteToResourceForm(props: {
  access: OkList;
  action: FormAction;
  noun: string;
  email: string;
  open: boolean;
  onToggle: (open: boolean) => void;
  inviteDomains?: readonly string[];
  stepUpHref?: string;
}): ReactNode {
  const [email, setEmail] = useState(props.email);
  const [role, setRole] = useState<ResourceRole>('reader');
  const [result, run, pending] = useActionState(props.action, null);
  const copy = resourceAccessCopy(props.noun);
  const domain = email.includes('@') ? email.slice(email.lastIndexOf('@') + 1).toLowerCase() : '';
  const domains = (props.inviteDomains ?? []).map((d) => d.toLowerCase().replace(/^@/, ''));
  const outside = domain !== '' && domains.length > 0 && !domains.includes(domain);
  return (
    <details className="ak-access-invite" open={props.open} onToggle={(e) => props.onToggle(e.currentTarget.open)}>
      <summary>Invite someone new to this {props.noun}</summary>
      <form action={run}>
        <ItemFields access={props.access} />
        <label className="ak-field">
          <span>Email</span>
          <input type="email" name={F.email} required maxLength={254} autoComplete="off" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value.trim())} />
        </label>
        <label className="ak-field">
          <span>Name (optional)</span>
          <input type="text" name={F.name} maxLength={100} autoComplete="off" />
        </label>
        <ResourceRolePicker name={F.role} options={props.access.roles} value={role} onChange={setRole} />
        {outside ? (
          <label className="ak-field ak-warn">
            <input type="checkbox" name={F.confirmOutsideDomain} required />
            <span>
              {email} is outside the usual domains ({domains.join(', ')}). An invite to a mistyped address is a live account for whoever owns that inbox. I’ve checked it.
            </span>
          </label>
        ) : null}
        <p className="ak-note">{copy.invite}</p>
        <button type="submit" className="ak-button ak-button-primary" disabled={pending}>
          {pending ? 'Sending…' : email ? `Send invite to ${email}` : 'Send invite'}
        </button>
        <ActionResultMessage result={result} {...(props.stepUpHref !== undefined && { stepUpHref: props.stepUpHref })} />
      </form>
    </details>
  );
}

// ---- The panel --------------------------------------------------------------------------------

export interface WhoHasAccessActions {
  add?: FormAction;
  changeRole?: FormAction;
  remove?: FormAction;
  invite?: FormAction;
}

export interface WhoHasAccessProps {
  /** From `resourceActions.listAccess({ type, id })` on the server. */
  access: ResourceAccessList;
  /** The server actions (each wraps `resourceActions.forms.*`). Leave one out to hide it. */
  actions: WhoHasAccessActions;
  /** The app's word for the item. Default: the type's noun. */
  noun?: string;
  /** Usual invite domains; others get a warning and a confirmation box. */
  inviteDomains?: readonly string[];
  /** Where "Sign in again to confirm" goes. */
  stepUpHref?: string;
  /** Show "Site admins can also see and edit this …". Default true. */
  adminNote?: boolean;
}

/**
 * "Who has access to this project": everyone with a role on the item and their role chips; for its
 * Managers (and site admins who manage people), changing roles, removing, adding by email with a
 * role picker that says what each role can and can't do, and inviting someone new. Every item keeps
 * at least one Manager, and the panel says so where it matters. Anyone with a role can leave.
 */
export function WhoHasAccess(props: WhoHasAccessProps): ReactNode {
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const headingId = useId();
  const { access } = props;
  if (access.state === 'not_found') return null;
  const noun = props.noun ?? (access.state === 'ok' ? access.noun : 'item');
  const copy = resourceAccessCopy(noun);
  if (access.state === 'unavailable') {
    return (
      <section className="ak-access ak-unavailable" role="alert">
        <h2>{copy.heading} (—)</h2>
        <p>{access.reason}</p>
      </section>
    );
  }
  const manages = access.viewer.actions.includes('manage-access');
  const count = access.members.length;
  return (
    <section className="ak-access" aria-labelledby={headingId}>
      <h2 id={headingId}>{copy.heading}</h2>
      {props.adminNote !== false ? <p className="ak-note ak-access-admins">{copy.adminNote}</p> : null}
      {access.managers === 0 ? (
        <p className="ak-note ak-warn" role="alert">
          {copy.noManager}
        </p>
      ) : null}
      <p className="ak-source">
        {count} {count === 1 ? 'person' : 'people'} · read {access.fetchedAt.replace('T', ' ').slice(0, 16)} UTC
        {access.viewer.role ? (
          <>
            {' '}
            · your role: <ResourceRoleChip role={access.viewer.role} />
          </>
        ) : access.viewer.siteActions.length > 0 ? (
          ' · you have no role here; your site role lets you ' + access.viewer.siteActions.filter((a) => a in RESOURCE_ACTION_LABEL).map((a) => RESOURCE_ACTION_LABEL[a as keyof typeof RESOURCE_ACTION_LABEL].toLowerCase()).join(', ')
        ) : null}
      </p>
      {count === 0 ? (
        <p className="ak-muted">Nobody has a role on this {noun} yet.</p>
      ) : (
        <ul className="ak-access-list">
          {access.members.map((m) => (
            <MemberRow
              key={m.sub}
              access={access}
              member={m}
              noun={noun}
              {...(props.actions.changeRole && { changeRole: props.actions.changeRole })}
              {...(props.actions.remove && { remove: props.actions.remove })}
              {...(props.stepUpHref !== undefined && { stepUpHref: props.stepUpHref })}
            />
          ))}
        </ul>
      )}
      {manages && props.actions.add ? (
        <AddMemberForm
          access={access}
          action={props.actions.add}
          noun={noun}
          onNoAccount={(email) => {
            setInviteEmail(email);
            setInviteOpen(true);
          }}
          {...(props.stepUpHref !== undefined && { stepUpHref: props.stepUpHref })}
        />
      ) : null}
      {access.canInvite && props.actions.invite ? (
        <InviteToResourceForm
          key={inviteEmail}
          access={access}
          action={props.actions.invite}
          noun={noun}
          email={inviteEmail}
          open={inviteOpen}
          onToggle={setInviteOpen}
          {...(props.inviteDomains !== undefined && { inviteDomains: props.inviteDomains })}
          {...(props.stepUpHref !== undefined && { stepUpHref: props.stepUpHref })}
        />
      ) : null}
    </section>
  );
}

// ---- Explaining resource roles where site roles are chosen ------------------------------------

/** The combining rule as a table: every site role (on every item) and every resource role (on one item). */
export function ResourceAccessTable({ noun = 'item', caption }: { noun?: string; caption?: string }): ReactNode {
  return (
    <table className="ak-table ak-resource-matrix">
      <caption>{caption ?? `What each role allows on a ${noun}. On any ${noun}, a person gets whichever of their two rows allows more.`}</caption>
      <thead>
        <tr>
          <th scope="col">Role</th>
          <th scope="col">Where</th>
          {RESOURCE_ACCESS_MATRIX.actions.map((a) => (
            <th scope="col" key={a}>
              {RESOURCE_ACTION_LABEL[a]}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {RESOURCE_ACCESS_MATRIX.rows.map((row) => (
          <tr key={`${row.kind}-${row.role}`} className={`ak-resource-matrix-${row.kind}`}>
            <th scope="row">{row.label}</th>
            <td>{row.scope === 'every item' ? `Every ${noun} (site role)` : `This ${noun}`}</td>
            {RESOURCE_ACCESS_MATRIX.actions.map((a) => (
              <td key={a} className={row.actions[a] ? 'ak-yes' : 'ak-no'}>
                {row.actions[a] ? 'Yes' : 'No'}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface ResourceRolesSummaryProps {
  /** The app's word for its items. Default "item". */
  noun?: string;
  nounPlural?: string;
  /** Where people manage access to items (the items' list). */
  href?: string;
}

/**
 * For the People page's role picker (`resourceAccess` slot): where access to one item lives, the
 * three resource roles, and how they combine with site roles.
 */
export function ResourceRolesSummary({ noun = 'item', nounPlural, href }: ResourceRolesSummaryProps): ReactNode {
  const plural = nounPlural ?? `${noun}s`;
  const roles = resourceRoleDescriptions(noun);
  return (
    <div className="ak-resource-roles">
      <p>
        On each {noun}, its Managers choose who has access (“Who has access to this {noun}”):
      </p>
      <ul>
        {(['manager', 'contributor', 'reader'] as const).map((role) => (
          <li key={role}>
            <ResourceRoleChip role={role} /> {roles[role].can}
          </li>
        ))}
      </ul>
      <p className="ak-note">
        Site roles count on every {noun} too: Admin – view only sees every {noun}, Admin – content only also edits every {noun}, and Admin – content &amp; people and above also choose who has access to every {noun}. A member sees the {plural} they have a role on.
      </p>
      <details className="ak-compare-roles">
        <summary>Compare access</summary>
        <ResourceAccessTable noun={noun} />
      </details>
      {href ? (
        <p>
          <a href={href}>Go to {plural}</a>
        </p>
      ) : null}
    </div>
  );
}
