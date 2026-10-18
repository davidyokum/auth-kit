/**
 * Plain types and constants shared by the server actions, the audit log, and the UI components.
 * No runtime imports beyond other pure modules, so `auth-kit/admin/ui` can use it in the browser.
 */
import type { InviteMode, InviteStatus } from './guardrails.js';
import type { StandardGroup } from '../shared/policy.js';

// ---- People ------------------------------------------------------------------------------------

/** One person on the People page, from the ListUsers snapshot joined with ListUsersInGroup. */
export interface PersonRow {
  sub: string;
  /** Cognito username: what the Admin* APIs take. */
  username: string;
  email: string;
  name?: string;
  enabled: boolean;
  emailVerified: boolean;
  /** Cognito status (CONFIRMED, FORCE_CHANGE_PASSWORD, ...). */
  status: string;
  /** Every group the app's capability map knows that this person is in. */
  groups: string[];
  /** Their highest admin role, or null for a member with none. */
  adminRole: StandardGroup | null;
  /** ISO 8601. Account creation, which is also when the invite was sent. */
  createdAt: string;
  /** The invite's state and when it expires (7 days after creation; resending doesn't extend it). */
  invite: { status: InviteStatus; expiresAt: string };
  /**
   * Cognito doesn't record a last sign-in. Undefined means "not recorded" (show "—" and why), never
   * "never signed in". An app that installs a sign-in trigger can fill it in.
   */
  lastSignInAt?: string | null;
}

/** A list that can fail honestly: on failure the page shows "—" and the reason, never zero. */
export type PeopleList =
  | {
      state: 'ok';
      people: PersonRow[];
      /** ISO 8601: when the snapshot was read. */
      fetchedAt: string;
      /** True when the list stopped at `maxPeople`; the page says so instead of implying "everyone". */
      truncated: boolean;
      inviteMode: InviteMode;
    }
  | { state: 'unavailable'; reason: string };

export type ActionErrorCode =
  /** Not signed in, or the session ended. */
  | 'unauthenticated'
  /** Signed in, but this needs a sign-in in the last few minutes. */
  | 'step_up_required'
  /** The acting person lacks the capability. */
  | 'forbidden'
  /** A guardrail refused it (see the message). */
  | 'refused'
  /** The input was malformed. */
  | 'invalid'
  /** No such person. */
  | 'not_found'
  /** The person changed since the page loaded (role or state). Reload and try again. */
  | 'stale'
  /** The audit log couldn't be written before the change, so nothing was changed. */
  | 'audit_unavailable'
  /** The change was made and its intent is logged, but the result row couldn't be written. */
  | 'audit_incomplete'
  /** Cognito (or the mailer) refused or couldn't be reached. `changed` says how far it got. */
  | 'failed'
  /** Cognito or AWS couldn't be reached to check the person or the actor. Nothing was changed. */
  | 'unavailable';

/**
 * What an action did. `changed` is honest about partial work: a failure can still have changed
 * something (an invite whose email didn't send), and the screen must say so.
 */
export type ActionResult =
  | { ok: true; message: string; auditId?: string; subject?: { sub: string; email?: string } }
  | {
      ok: false;
      code: ActionErrorCode;
      error: string;
      changed: 'nothing' | 'partly' | 'yes';
      /** For `step_up_required`: the maximum sign-in age. */
      maxAgeSeconds?: number;
      /** The guardrail that refused, for `refused`. */
      guardrail?: string;
      auditId?: string;
    };

/** A server action as `useActionState` calls it. */
export type FormAction = (previous: ActionResult | null, data: FormData) => Promise<ActionResult>;

// ---- Access requests (ADR 0023) ------------------------------------------------------------------

/** One pending request on the People page. The name and reason are as typed: untrusted. */
export interface AccessRequestRow {
  id: string;
  email: string;
  name?: string;
  reason?: string;
  /** ISO 8601. */
  createdAt: string;
  expiresAt: string;
}

/** The "Pending requests" tab: honest when it can't load, and `off` where the site takes no requests. */
export type AccessRequestList =
  | { state: 'ok'; requests: AccessRequestRow[]; truncated: boolean; fetchedAt: string }
  | { state: 'unavailable'; reason: string }
  | { state: 'off' };

export interface ApproveRequestInput {
  id: string;
  /** Default `member`: the least access, as the invite form. */
  role?: string;
  reason?: string;
  /**
   * The account's name, as the approver wrote it (at most 100 characters, trimmed). It becomes the
   * Cognito `name` and the invite's name. Leave it out to keep the name the requester typed; an empty
   * string means no name.
   */
  name?: string;
}

export interface DeclineRequestInput {
  id: string;
  /** Included in the decline note, when the site sends one. */
  note?: string;
}

/** The most requests one bulk decline takes. */
export const DECLINE_REQUESTS_MAX = 100;

/** The most requests the "Pending requests" tab lists at once (then "and N more"). */
export const PENDING_REQUESTS_SHOWN = 50;

export interface DeclineRequestsInput {
  /** The requests to decline: 1 to `DECLINE_REQUESTS_MAX` IDs. */
  ids: readonly string[];
  /** The admin's own words, for the audit log. */
  reason?: string;
}

/**
 * Why a bulk decline left a request alone: already approved or declined, expired, deleted after its
 * retention (`gone`), or decided by someone else while the decline ran (`changed`).
 */
export type DeclineRequestsSkipStatus = 'approved' | 'declined' | 'expired' | 'gone' | 'changed';

export interface DeclineRequestsSkip {
  id: string;
  /** Missing when the request is gone. */
  email?: string;
  status: DeclineRequestsSkipStatus;
}

/** A bulk decline's result: which requests it declined, and which it left alone and why. */
export type DeclineRequestsResult = ActionResult & {
  declined?: readonly { id: string; email: string }[];
  skipped?: readonly DeclineRequestsSkip[];
};

export interface InviteInput {
  email: string;
  /** An admin role (never `owner`), an app role, or `member` for no group. */
  role: string;
  name?: string;
  /** Required when the role is Admin – content & people or Super admin. */
  reason?: string;
  /** Required when the address is outside `inviteDomains`. */
  confirmOutsideDomain?: boolean;
}

export interface TargetInput {
  sub: string;
  reason?: string;
}

export interface ChangeRoleInput {
  sub: string;
  /** The new admin role, or `member` for none. App roles are left as they are. `owner` is refused: it moves only by transfer. */
  toRole: StandardGroup | 'member';
  /** The admin role the page showed. If it changed since, the action refuses (`stale`). */
  fromRole?: StandardGroup | 'member';
  reason: string;
}

export interface TransferOwnershipInput {
  /** The person who becomes the owner. They must be enabled and have signed in. */
  sub: string;
  reason: string;
  /** Their email address, typed out to confirm. */
  confirmEmail: string;
}

export interface DeleteUserInput {
  sub: string;
  reason: string;
  /** The person's email address, typed out to confirm. */
  confirmEmail: string;
}

/** Form field names, shared by the UI components and the FormData adapters. */
export const PEOPLE_FORM_FIELDS = {
  sub: 'sub',
  email: 'email',
  name: 'name',
  role: 'role',
  toRole: 'toRole',
  fromRole: 'fromRole',
  reason: 'reason',
  confirmEmail: 'confirmEmail',
  confirmOutsideDomain: 'confirmOutsideDomain',
} as const;

export { MEMBER_ROLE } from '../shared/policy.js';

// ---- Audit log ---------------------------------------------------------------------------------

/**
 * - `intent`: written before any change. If it can't be written, nothing happens.
 * - `result`: written after the calls, pointing at its intent, with the outcome and the calls made.
 * - `refused`: a guardrail said no; nothing changed.
 * - `event`: a one-row record of something that isn't a change (an export, a View-as start).
 */
export type AuditPhase = 'intent' | 'result' | 'refused' | 'event';
export type AuditOutcome = 'ok' | 'failed' | 'partial';

export interface AuditActor {
  sub: string;
  email?: string;
  /** `system` for scheduled jobs such as the invite-expiry sweep. Default `person`. */
  kind?: 'person' | 'system';
}

export interface AuditTarget {
  sub?: string;
  email?: string;
  recordId?: string;
}

export interface AuditRequestContext {
  /** Correlates the row with request logs. */
  requestId?: string;
  ip?: string;
  userAgent?: string;
}

/** One row of the append-only audit log: who, to whom, what, before and after, why, when. */
export interface AuditEvent {
  id: string;
  /** ISO 8601: when this row was written. */
  at: string;
  phase: AuditPhase;
  /** Result rows only. */
  outcome?: AuditOutcome;
  /** Result rows: the intent row they complete. */
  intentId?: string;
  /** The logical entry's start: the intent's `at` (equal to `at` for single rows). */
  startedAt: string;
  actor: AuditActor;
  /** e.g. `people.invite`, `people.changeRole`, `content.publish`. */
  action: string;
  target?: AuditTarget;
  before?: unknown;
  after?: unknown;
  reason?: string;
  requestId?: string;
  context?: { ip?: string; userAgent?: string };
  /** AWS calls: planned (intent) or made (result), in order. */
  calls?: string[];
  /** Result rows that failed: the error's name and message (never a stack or a secret). */
  error?: string;
}

/** What callers pass to `append`. Result rows name their intent. */
export interface AuditEventInput {
  phase?: AuditPhase;
  outcome?: AuditOutcome;
  /** Required for result rows. */
  intent?: Pick<AuditEvent, 'id' | 'at'>;
  actor: AuditActor;
  action: string;
  target?: AuditTarget;
  before?: unknown;
  after?: unknown;
  reason?: string;
  requestId?: string;
  context?: { ip?: string; userAgent?: string };
  calls?: string[];
  error?: string;
}

export interface AuditLogQuery {
  actorSub?: string;
  targetSub?: string;
  targetEmail?: string;
  targetRecordId?: string;
  /** An exact action (`people.invite`) or a prefix ending in a dot (`people.`). */
  action?: string;
  /** ISO 8601, inclusive. */
  since?: string;
  /** ISO 8601, inclusive. */
  until?: string;
  /** Default 50, at most 200. */
  limit?: number;
  /** From a previous page's `nextCursor`. Opaque. */
  cursor?: string;
}

export interface AuditLogPage {
  events: AuditEvent[];
  nextCursor?: string;
}

/**
 * One line on the Activity page. A completed change shows its result row (which repeats everything
 * the intent said); an intent with no result shows as `unknown`, meaning "attempted; the outcome
 * wasn't recorded", which is never the same as "didn't happen".
 */
export interface ActivityEntry {
  event: AuditEvent;
  status: AuditOutcome | 'refused' | 'recorded' | 'unknown';
}

export type ActivityPage =
  | { state: 'ok'; entries: ActivityEntry[]; nextCursor?: string }
  | { state: 'unavailable'; reason: string };
