import { ADMIN_ROLE_RANK, INVITE_EXPIRY_DAYS, STANDARD_GROUPS, type StandardGroup } from '../shared/policy.js';
import { standardCapabilities } from '../server/capabilities.js';

/** Every People-page action. */
export const PEOPLE_ACTIONS = ['invite', 'resend', 'changeRole', 'disable', 'enable', 'signOutEverywhere', 'delete'] as const;
export type PeopleAction = (typeof PEOPLE_ACTIONS)[number];

/** The capability each action needs. Owners alone hold `data.delete`. */
export const PEOPLE_ACTION_CAPABILITY: Readonly<Record<PeopleAction, string>> = {
  invite: 'people.manage',
  resend: 'people.manage',
  changeRole: 'roles.manage',
  disable: 'people.manage',
  enable: 'people.manage',
  signOutEverywhere: 'people.manage',
  delete: 'data.delete',
};

/** "No admin role" in role pickers and role changes. */
export const MEMBER_ROLE = 'member';

export interface GuardrailPerson {
  sub: string;
  /** Live groups (re-read from Cognito for admin actions). */
  groups: readonly string[];
}

/** The target's live account state. Each field is checked only when present. */
export interface GuardrailTarget extends GuardrailPerson {
  /** Cognito `Enabled`. */
  enabled?: boolean;
  /** Where their invite stands (`inviteStatus`). */
  invite?: InviteStatus;
}

export interface GuardrailActor extends GuardrailPerson {
  /** The actor's capabilities. Default: derived from the standard map. */
  capabilities?: ReadonlySet<string>;
}

export interface GuardrailInput {
  action: PeopleAction;
  actor: GuardrailActor;
  /** The person acted on. Absent for an invite. */
  target?: GuardrailTarget;
  /**
   * The role being granted (invite or change role): a standard group, `member` (no admin role), or
   * one of `knownRoles`, spelled exactly. Admin roles have ranks; app roles don't.
   */
  toRole?: string;
  /** For changeRole: the admin role being removed, when it differs from the target's highest. Same rules as `toRole`. */
  fromRole?: string;
  /**
   * The app's own roles (its capability map's groups, e.g. `reviewer`). Role names are matched
   * exactly against the standard groups, `member`, and these; anything else ("Admin", " admin",
   * "owner") is refused rather than guessed at.
   */
  knownRoles?: readonly string[];
  /** Enabled owners right now, read live. Required whenever the target is an owner; anything but a whole number ≥ 0 is a "no". */
  ownerCount?: number;
  /** Why. Every role change records one. */
  reason?: string;
}

export type GuardrailCode =
  | 'capability'
  | 'self'
  | 'rank'
  | 'last_owner'
  | 'owner_count_unknown'
  | 'reason_required'
  | 'state'
  | 'invalid';

export type GuardrailResult =
  | { ok: true; requiresRecentSignIn: boolean }
  | { ok: false; code: GuardrailCode; reason: string };

export function isStandardGroup(role: unknown): role is StandardGroup {
  return typeof role === 'string' && (STANDARD_GROUPS as readonly string[]).includes(role);
}

/**
 * True when `role` is exactly a standard group, `member`, or one of `knownRoles`. No trimming, no
 * case folding, no aliases: Cognito group names are case-sensitive, and a near-miss is a mistake or
 * an attack, never a role.
 */
export function isKnownRole(role: unknown, knownRoles: readonly string[] = []): role is string {
  return typeof role === 'string' && (isStandardGroup(role) || role === MEMBER_ROLE || knownRoles.includes(role));
}

/** Rank of a role: admin roles 1-4; app roles, `member`, and anything unrecognized 0. */
export function roleRank(role: string | null | undefined): number {
  return isStandardGroup(role) ? ADMIN_ROLE_RANK[role] : 0;
}

/** The person's admin roles (the standard groups they hold), highest first. App roles are left out. */
export function adminGroupsOf(groups: readonly string[]): StandardGroup[] {
  return groups.filter(isStandardGroup).sort((a, b) => ADMIN_ROLE_RANK[b] - ADMIN_ROLE_RANK[a]);
}

/** The person's highest admin role, or null if they hold none. */
export function highestAdminRole(groups: readonly string[]): StandardGroup | null {
  let best: StandardGroup | null = null;
  for (const g of groups) if (isStandardGroup(g) && (!best || ADMIN_ROLE_RANK[g] > ADMIN_ROLE_RANK[best])) best = g;
  return best;
}

/** Highest rank this person may grant or act on: owners anything (including owners), others below their own. */
export function grantCeiling(groups: readonly string[]): number {
  const top = highestAdminRole(groups);
  if (!top) return 0;
  return top === 'superadmin' ? ADMIN_ROLE_RANK.superadmin : ADMIN_ROLE_RANK[top] - 1;
}

/** Admin roles this person may grant. */
export function grantableRoles(groups: readonly string[]): StandardGroup[] {
  const ceiling = grantCeiling(groups);
  return STANDARD_GROUPS.filter((g) => ADMIN_ROLE_RANK[g] <= ceiling);
}

function deny(code: GuardrailCode, reason: string): GuardrailResult {
  return { ok: false, code, reason };
}

/**
 * The People page's guardrails (03 §2, Admin area), as one pure check every server action runs
 * before calling Cognito:
 * - the action's capability (owners alone delete accounts);
 * - nobody changes their own role, disables themselves, or deletes themselves;
 * - you grant, and act on, only roles below your own (owners may make owners);
 * - nobody removes, disables, or deletes the last owner (and an unknown owner count is a "no");
 * - every role change records a reason, and a promotion needs a recent sign-in;
 * - when the target's state is given: resend only an unused invite (it never touches an active
 *   account), re-enable only a disabled account, disable only an enabled one, and delete only after
 *   disabling (the retention period itself is checked by the action, from the audit log).
 */
export function checkPeopleAction(input: GuardrailInput): GuardrailResult {
  const { action, actor, target } = input;
  if (!(PEOPLE_ACTIONS as readonly string[]).includes(action)) return deny('invalid', `Unknown action "${String(action)}".`);
  if (!isPerson(actor) || (target !== undefined && !isPerson(target))) return deny('invalid', 'Malformed person.');
  for (const [field, role] of [
    ['toRole', input.toRole],
    ['fromRole', input.fromRole],
  ] as const) {
    if (role !== undefined && !isKnownRole(role, input.knownRoles)) {
      return deny('invalid', `Unknown ${field === 'toRole' ? 'role' : 'current role'} "${String(role)}". Roles are spelled exactly, e.g. "superadmin" (shown as Owner).`);
    }
  }

  const capabilities = actor.capabilities ?? standardCapabilities.capabilitiesOf(actor.groups);
  if (typeof capabilities?.has !== 'function' || !capabilities.has(PEOPLE_ACTION_CAPABILITY[action])) {
    return deny('capability', action === 'delete' ? 'Only owners can delete accounts.' : "You don't have permission to do that.");
  }
  if (action !== 'invite' && !target) return deny('invalid', 'This action needs a person.');
  if ((action === 'invite' || action === 'changeRole') && !input.toRole) return deny('invalid', 'Choose a role.');

  const self = target !== undefined && target.sub === actor.sub;
  if (self && (action === 'changeRole' || action === 'disable' || action === 'delete')) {
    return deny(
      'self',
      action === 'changeRole' ? 'Nobody can change their own role.' : `You can't ${action} your own account.`,
    );
  }

  // Signing yourself out everywhere is always fine.
  if (self && action === 'signOutEverywhere') return { ok: true, requiresRecentSignIn: false };

  const ceiling = grantCeiling(actor.groups);
  const currentRole = target ? highestAdminRole(target.groups) : null;
  if (roleRank(currentRole) > ceiling) {
    return deny('rank', 'You can only manage people whose role is below your own.');
  }
  if (input.fromRole !== undefined && roleRank(input.fromRole) > ceiling) {
    return deny('rank', 'You can only remove roles below your own.');
  }
  if (input.toRole !== undefined && roleRank(input.toRole) > ceiling) {
    return deny('rank', 'You can only grant roles below your own.');
  }

  const stateProblem = target ? targetStateProblem(action, target) : null;
  if (stateProblem) return deny('state', stateProblem);

  // The last owner can't be removed, demoted, disabled, or deleted. A disabled owner already isn't one.
  const targetIsOwner = target?.groups.includes('superadmin') === true && target.enabled !== false;
  const removesOwner =
    targetIsOwner &&
    (action === 'disable' || action === 'delete' || (action === 'changeRole' && input.toRole !== 'superadmin'));
  if (removesOwner) {
    // Fail closed: undefined, NaN, Infinity, fractions, and negatives all mean "couldn't confirm".
    const count = input.ownerCount;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
      return deny('owner_count_unknown', "Couldn't confirm another owner exists, so this owner can't be removed right now.");
    }
    if (count <= 1) return deny('last_owner', 'Each site keeps at least one owner. Add another owner first.');
  }

  if (action === 'changeRole' && (typeof input.reason === 'string' ? input.reason.trim() : '').length < 3) {
    return deny('reason_required', 'Every role change records a reason.');
  }

  const promotion =
    (action === 'invite' || action === 'changeRole') && roleRank(input.toRole) > roleRank(currentRole) && roleRank(input.toRole) > 0;
  return { ok: true, requiresRecentSignIn: promotion };
}

function isPerson(value: unknown): value is GuardrailPerson {
  if (typeof value !== 'object' || value === null) return false;
  const { sub, groups } = value as { sub?: unknown; groups?: unknown };
  return typeof sub === 'string' && sub.length > 0 && Array.isArray(groups) && groups.every((g) => typeof g === 'string');
}

function targetStateProblem(action: PeopleAction, target: GuardrailTarget): string | null {
  switch (action) {
    case 'resend':
      if (target.invite === undefined) return null;
      if (target.invite === 'accepted') return 'Resend is only for invites nobody has used. It never changes an active account.';
      if (target.invite === 'expired') return 'This invite expired unused. Invite them again instead.';
      if (target.invite === 'disabled') return 'This invite was revoked. Invite them again instead.';
      return null;
    case 'enable':
      return target.enabled === true ? 'Only a disabled account can be re-enabled.' : null;
    case 'disable':
      return target.enabled === false ? 'Already disabled.' : null;
    case 'delete':
      return target.enabled === true ? 'Disable first. Deleting comes after the retention period.' : null;
    case 'invite':
    case 'changeRole':
    case 'signOutEverywhere':
      return null;
  }
}

export type InviteStatus = 'accepted' | 'pending' | 'expiring-soon' | 'expired' | 'disabled';

/**
 * How invites work in this pool, which decides what "accepted" means:
 * - `emailed-code` (everyday pools): no password; the account is CONFIRMED from creation, so the
 *   signal is `email_verified`, which the first emailed-code sign-in sets.
 * - `temporary-password` (the Tier 3 admin pool, which has no emailed codes): Cognito emails a
 *   one-time password; the account stays FORCE_CHANGE_PASSWORD until it's used.
 */
export type InviteMode = 'emailed-code' | 'temporary-password';

/** When an invite created at `createdAt` expires. The clock never resets (a resend keeps it). */
export function inviteExpiresAt(createdAt: Date, expiryDays: number = INVITE_EXPIRY_DAYS): Date {
  return new Date(createdAt.getTime() + expiryDays * 24 * 60 * 60 * 1000);
}

/**
 * Where an invite stands. An invite is a live account from creation (an emailed-code sign-in works
 * at once), so "email not yet verified" means "not yet accepted", and an unaccepted invite older than
 * 7 days is expired and should be disabled. In `temporary-password` mode (the admin pool) the signal
 * is the Cognito status instead: FORCE_CHANGE_PASSWORD until the one-time password is used.
 */
export function inviteStatus(
  user: { createdAt: Date; emailVerified: boolean; enabled: boolean; status?: string },
  now: Date = new Date(),
  options: { expiryDays?: number; warnDays?: number; mode?: InviteMode } = {},
): InviteStatus {
  if (!user.enabled) return 'disabled';
  const unusedPassword = user.status === 'FORCE_CHANGE_PASSWORD';
  const accepted =
    options.mode === 'temporary-password' && user.status !== undefined ? !unusedPassword : user.emailVerified && !unusedPassword;
  if (accepted) return 'accepted';
  // An unreadable creation date can't keep an unused invite alive: treat it as expired (fail closed).
  if (!Number.isFinite(user.createdAt?.getTime?.())) return 'expired';
  const day = 24 * 60 * 60 * 1000;
  const age = now.getTime() - user.createdAt.getTime();
  const expiry = (options.expiryDays ?? INVITE_EXPIRY_DAYS) * day;
  if (age >= expiry) return 'expired';
  if (age >= expiry - (options.warnDays ?? 2) * day) return 'expiring-soon';
  return 'pending';
}
