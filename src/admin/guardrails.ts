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

export interface GuardrailPerson {
  sub: string;
  /** Live groups (re-read from Cognito for admin actions). */
  groups: readonly string[];
}

export interface GuardrailActor extends GuardrailPerson {
  /** The actor's capabilities. Default: derived from the standard map. */
  capabilities?: ReadonlySet<string>;
}

export interface GuardrailInput {
  action: PeopleAction;
  actor: GuardrailActor;
  /** The person acted on. Absent for an invite. */
  target?: GuardrailPerson;
  /** The role being granted (invite or change role). Admin roles have ranks; app roles don't. */
  toRole?: string;
  /** For changeRole: the admin role being removed, when it differs from the target's highest. */
  fromRole?: string;
  /** Enabled owners right now, read live. Required whenever the target is an owner. */
  ownerCount?: number;
  /** Why. Every role change records one. */
  reason?: string;
}

export type GuardrailCode = 'capability' | 'self' | 'rank' | 'last_owner' | 'owner_count_unknown' | 'reason_required' | 'invalid';

export type GuardrailResult =
  | { ok: true; requiresRecentSignIn: boolean }
  | { ok: false; code: GuardrailCode; reason: string };

function isStandardGroup(role: string): role is StandardGroup {
  return (STANDARD_GROUPS as readonly string[]).includes(role);
}

/** Rank of a role: admin roles 1-4, app roles 0. */
export function roleRank(role: string | null | undefined): number {
  return role && isStandardGroup(role) ? ADMIN_ROLE_RANK[role] : 0;
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
 * - every role change records a reason, and a promotion needs a recent sign-in.
 */
export function checkPeopleAction(input: GuardrailInput): GuardrailResult {
  const { action, actor, target } = input;
  if (!(PEOPLE_ACTIONS as readonly string[]).includes(action)) return deny('invalid', `Unknown action "${action}".`);

  const capabilities = actor.capabilities ?? standardCapabilities.capabilitiesOf(actor.groups);
  if (!capabilities.has(PEOPLE_ACTION_CAPABILITY[action])) {
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

  // The last owner can't be removed, demoted, disabled, or deleted.
  const targetIsOwner = target?.groups.includes('superadmin') === true;
  const removesOwner =
    targetIsOwner &&
    (action === 'disable' || action === 'delete' || (action === 'changeRole' && input.toRole !== 'superadmin'));
  if (removesOwner) {
    if (input.ownerCount === undefined) {
      return deny('owner_count_unknown', "Couldn't confirm another owner exists, so this owner can't be removed right now.");
    }
    if (input.ownerCount <= 1) return deny('last_owner', 'Each site keeps at least one owner. Add another owner first.');
  }

  if (action === 'changeRole' && (input.reason ?? '').trim().length < 3) {
    return deny('reason_required', 'Every role change records a reason.');
  }

  const promotion =
    (action === 'invite' || action === 'changeRole') && roleRank(input.toRole) > roleRank(currentRole) && roleRank(input.toRole) > 0;
  return { ok: true, requiresRecentSignIn: promotion };
}

export type InviteStatus = 'accepted' | 'pending' | 'expiring-soon' | 'expired' | 'disabled';

/**
 * Where an invite stands. An invite is a live account from creation (an emailed-code sign-in works
 * at once), so "email not yet verified" means "not yet accepted", and an unaccepted invite older than
 * 7 days is expired and should be disabled.
 */
export function inviteStatus(
  user: { createdAt: Date; emailVerified: boolean; enabled: boolean },
  now: Date = new Date(),
  options: { expiryDays?: number; warnDays?: number } = {},
): InviteStatus {
  if (!user.enabled) return 'disabled';
  if (user.emailVerified) return 'accepted';
  const day = 24 * 60 * 60 * 1000;
  const age = now.getTime() - user.createdAt.getTime();
  const expiry = (options.expiryDays ?? INVITE_EXPIRY_DAYS) * day;
  if (age >= expiry) return 'expired';
  if (age >= expiry - (options.warnDays ?? 2) * day) return 'expiring-soon';
  return 'pending';
}
