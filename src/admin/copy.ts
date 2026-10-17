/**
 * What the People page says: each button's Cognito calls and when the change really lands (primer
 * §9's People page table), the Activity page's wording, and the lost-passkey guide. Pure data and
 * functions, shared by the server actions and `auth-kit/admin/ui`.
 */
import type { InviteMode, PeopleAction } from './guardrails.js';
import { ADMIN_ROLE_LABEL, INVITE_EXPIRY_DAYS, type StandardGroup } from '../shared/policy.js';
import type { ActivityEntry, AuditEvent } from './types.js';

/** What each button says on screen: what it does and when it takes effect. */
export const PEOPLE_ACTION_COPY = {
  invite:
    'They can sign in now with a code sent to their email, then save a passkey. The invite expires in 7 days if they don’t use it.',
  resend: 'Sends the invite email again. Nothing about their account changes.',
  changeRole: 'Takes effect at their next refresh, within 60 minutes. Admin pages check live, so admin access changes now.',
  disable:
    'Stops sign-in and refresh now. A page they have open keeps working for up to 60 minutes; admin pages stop at once.',
  enable: 'They sign in again as normal. Their old sessions stay ended.',
  signOutEverywhere: 'They’ll have to sign in again within 60 minutes. This doesn’t remove them.',
  delete: 'Permanent. If they’re invited again they get a new ID.',
} as const satisfies Record<PeopleAction, string>;

/** Shown wherever the owner role can be granted. */
export const OWNER_GRANT_NOTE =
  'Making someone an owner needs a sign-in in the last few minutes, and every owner gets an email about it. If that email can’t be sent, the grant is undone.';

export interface PeopleActionDetail {
  /** The button label. */
  label: string;
  /** What the screen says (the copy above). */
  says: string;
  /** The calls the server makes, in order, after the audit intent row. */
  calls: readonly string[];
  /** What changes at once. */
  now: string;
  /** What waits, and how long. Empty when nothing waits. */
  later: string;
}

const DETAILS_EMAILED_CODE: Readonly<Record<PeopleAction, PeopleActionDetail>> = {
  invite: {
    label: 'Invite',
    says: PEOPLE_ACTION_COPY.invite,
    calls: ['AdminCreateUser (no password, email unverified, MessageAction SUPPRESS)', 'AdminAddUserToGroup', 'SES SendEmail (branded invite)'],
    now: 'The account exists at once, with no password. Its email stays unverified until the first sign-in: the “invited, not signed in” signal.',
    later: `Unused after ${INVITE_EXPIRY_DAYS} days, it’s disabled automatically. Until then it’s a live account for whoever controls that inbox.`,
  },
  resend: {
    label: 'Resend invite',
    says: PEOPLE_ACTION_COPY.resend,
    calls: ['SES SendEmail (branded invite); no Cognito call'],
    now: 'A new email goes out. The expiry date stays the same.',
    later: '',
  },
  changeRole: {
    label: 'Change role',
    says: PEOPLE_ACTION_COPY.changeRole,
    calls: ['AdminRemoveUserFromGroup (old role)', 'AdminAddUserToGroup (new role)'],
    now: 'Cognito’s groups change, and admin pages, which re-read groups live, follow within a minute.',
    later: 'Their token keeps its old groups until their next refresh, within 60 minutes.',
  },
  disable: {
    label: 'Disable',
    says: PEOPLE_ACTION_COPY.disable,
    calls: ['AdminDisableUser', 'AdminRemoveUserFromGroup (each admin role)', 'App: remove per-record memberships'],
    now: 'Sign-in and refresh fail (“User is disabled”), refresh tokens are revoked, and admin pages refuse them.',
    later: 'A page they already have open works until its token expires, within 60 minutes.',
  },
  enable: {
    label: 'Re-enable',
    says: PEOPLE_ACTION_COPY.enable,
    calls: ['AdminEnableUser'],
    now: 'Sign-in works again, as a member only: admin roles were removed when they were disabled.',
    later: '',
  },
  signOutEverywhere: {
    label: 'Sign out everywhere',
    says: PEOPLE_ACTION_COPY.signOutEverywhere,
    calls: ['AdminUserGlobalSignOut'],
    now: 'Their refresh tokens are revoked.',
    later: 'The token they hold passes the app’s checks until it expires, within 60 minutes. They can sign in again.',
  },
  delete: {
    label: 'Delete',
    says: PEOPLE_ACTION_COPY.delete,
    calls: ['AdminDeleteUser'],
    now: 'The identity is gone from Cognito and can’t be restored. Audit entries about them stay.',
    later: '',
  },
};

const DETAILS_TEMPORARY_PASSWORD: Readonly<Record<PeopleAction, PeopleActionDetail>> = {
  ...DETAILS_EMAILED_CODE,
  invite: {
    label: 'Invite',
    says: 'Cognito emails them a one-time password. They sign in with it, set a password and an authenticator, then save a passkey. The invite expires in 7 days if they don’t use it.',
    calls: ['AdminCreateUser (Cognito emails a one-time password; the app never sees it)', 'AdminAddUserToGroup'],
    now: 'The account exists, waiting for its one-time password (FORCE_CHANGE_PASSWORD).',
    later: `Unused after ${INVITE_EXPIRY_DAYS} days, it’s disabled automatically.`,
  },
  resend: {
    label: 'Resend invite',
    says: 'Sends a new one-time password; the old one stops working. Only for an invite nobody has used.',
    calls: ['AdminCreateUser (MessageAction RESEND)'],
    now: 'A new one-time password goes out. The 7-day expiry stays the same.',
    later: '',
  },
};

/** Each People action's label, copy, Cognito calls, and timing, for the pool's invite mode. */
export function peopleActionDetails(mode: InviteMode = 'emailed-code'): Readonly<Record<PeopleAction, PeopleActionDetail>> {
  return mode === 'temporary-password' ? DETAILS_TEMPORARY_PASSWORD : DETAILS_EMAILED_CODE;
}

/** The screen name for a role: `superadmin` is "Owner"; `member` means no admin role. */
export function roleLabel(role: string | null | undefined): string {
  if (!role || role === 'member') return 'Member';
  return ADMIN_ROLE_LABEL[role as StandardGroup] ?? role;
}

// ---- Lost passkey -------------------------------------------------------------------------------

export interface LostPasskeyGuide {
  /** Why there's no button. */
  why: string;
  steps: readonly string[];
  /** The only call involved, which the admin makes from the first step. */
  calls: readonly string[];
}

/**
 * No admin API lists or deletes someone's passkeys, so a lost passkey is a guided fix through the
 * person's own account. Pass `emailCodes: false` for an admin pool, which has no emailed code to fall
 * back on.
 */
export function lostPasskeyGuidance(options: { emailCodes?: boolean } = {}): LostPasskeyGuide {
  const emailCodes = options.emailCodes ?? true;
  const why = 'No admin call lists or deletes someone’s passkeys. The fix runs through their own account.';
  const signOut = 'Sign them out everywhere, so a stolen device’s session ends at its next refresh (within 60 minutes).';
  const lastResort = 'Last resort: disable them, then (an owner, after the retention period) delete and invite again. They get a new ID.';
  if (emailCodes) {
    return {
      why,
      calls: ['AdminUserGlobalSignOut'],
      steps: [
        signOut,
        'Check it’s really them some other way, such as a call to a number already on file: the inbox is now the key.',
        'They sign in with an emailed code. (A passkey synced by a password manager usually makes this unnecessary.)',
        'They remove the old passkey and add a new one under My account.',
        lastResort,
      ],
    };
  }
  return {
    why,
    calls: ['AdminUserGlobalSignOut'],
    steps: [
      signOut,
      'This pool has no emailed codes, so they can get back in only with a passkey synced to another device, or their password and authenticator if they still have them.',
      'If they can sign in, they remove the old passkey and add a new one under My account.',
      'Otherwise, after checking it’s really them some other way: ' + lastResort.charAt(0).toLowerCase() + lastResort.slice(1),
    ],
  };
}

// ---- Activity wording ---------------------------------------------------------------------------

const DONE: Readonly<Record<string, string>> = {
  'people.invite': 'invited',
  'people.resend': 'resent the invite to',
  'people.changeRole': 'changed the role of',
  'people.disable': 'disabled',
  'people.enable': 're-enabled',
  'people.signOutEverywhere': 'signed out everywhere',
  'people.delete': 'deleted',
  'people.expireInvite': 'disabled the unused invite for',
};

const TRIED: Readonly<Record<string, string>> = {
  'people.invite': 'tried to invite',
  'people.resend': 'tried to resend the invite to',
  'people.changeRole': 'tried to change the role of',
  'people.disable': 'tried to disable',
  'people.enable': 'tried to re-enable',
  'people.signOutEverywhere': 'tried to sign out',
  'people.delete': 'tried to delete',
  'people.expireInvite': 'tried to disable the unused invite for',
};

export interface ActivityLine {
  /** "Bob", or the actor's email, or "Scheduled job". */
  actor: string;
  /** "changed the role of", "tried to disable". */
  verb: string;
  /** The person or record acted on. */
  target: string;
  /** "Editor → Admin", when the row has a before and after worth showing. */
  change?: string;
  reason?: string;
  /** "ok", "refused: …", "partly done", "outcome not recorded". */
  status: string;
  /** "intent logged → AdminDisableUser: ok → result: ok". */
  trail: string;
  /** "203.0.113.24 · Safari". */
  from?: string;
}

function summarize(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if ('adminRole' in v) return roleLabel(v.adminRole as string | null);
    if ('role' in v && typeof v.role === 'string') return roleLabel(v.role);
    if ('enabled' in v) return v.enabled ? 'enabled' : 'disabled';
    if ('deleted' in v) return 'deleted';
  }
  return undefined;
}

/** Plain-language wording for one Activity entry. */
export function describeActivity(entry: ActivityEntry, names: (sub: string) => string | undefined = () => undefined): ActivityLine {
  const e: AuditEvent = entry.event;
  const actor = e.actor.kind === 'system' ? 'Scheduled job' : (names(e.actor.sub) ?? e.actor.email ?? e.actor.sub);
  const failed = entry.status === 'failed' || entry.status === 'refused' || entry.status === 'unknown';
  const verb = (failed ? TRIED[e.action] : DONE[e.action]) ?? e.action;
  const target = e.target ? ((e.target.sub ? names(e.target.sub) : undefined) ?? e.target.email ?? e.target.recordId ?? e.target.sub ?? '') : '';
  const before = summarize(e.before);
  const after = summarize(e.after);
  const change = before !== undefined || after !== undefined ? `${before ?? '—'} → ${after ?? '—'}` : undefined;
  const status =
    entry.status === 'ok'
      ? 'ok'
      : entry.status === 'partial'
        ? 'partly done'
        : entry.status === 'failed'
          ? 'failed, nothing changed'
          : entry.status === 'refused'
            ? `refused${e.error ? `: ${e.error}` : ''}`
            : entry.status === 'unknown'
              ? 'outcome not recorded (in progress, or the result couldn’t be written)'
              : 'recorded';
  const calls = (e.calls ?? []).join(' → ');
  const trail =
    e.phase === 'result'
      ? `intent logged → ${calls || 'no calls'} → result: ${e.outcome ?? 'ok'}`
      : e.phase === 'intent'
        ? `intent logged → ${calls ? `planned: ${calls}` : 'no calls planned'} → no result`
        : e.phase === 'refused'
          ? 'refused, no change made'
          : 'recorded';
  const from = [e.context?.ip, e.context?.userAgent].filter(Boolean).join(' · ') || undefined;
  return {
    actor,
    verb,
    target,
    ...(change !== undefined && { change }),
    ...(e.reason !== undefined && { reason: e.reason }),
    status,
    trail,
    ...(from !== undefined && { from }),
  };
}
