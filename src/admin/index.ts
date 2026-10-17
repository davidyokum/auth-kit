/**
 * `auth-kit/admin`: the admin area's People page and audit log (primer §9, 03 §2 "Admin area").
 *
 * Phase 1 (0.1.0-alpha) ships the guardrails as tested pure functions and the typed interfaces.
 * The server actions and the DynamoDB audit log are stubs that throw `NotImplementedError`.
 */
import type { ServerAuth } from '../server/auth.js';
import { NotImplementedError } from '../shared/not-implemented.js';

export {
  checkPeopleAction,
  grantableRoles,
  grantCeiling,
  highestAdminRole,
  roleRank,
  inviteStatus,
  PEOPLE_ACTIONS,
  PEOPLE_ACTION_CAPABILITY,
  type PeopleAction,
  type GuardrailActor,
  type GuardrailPerson,
  type GuardrailInput,
  type GuardrailResult,
  type GuardrailCode,
  type InviteStatus,
} from './guardrails.js';
export { NotImplementedError } from '../shared/not-implemented.js';

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
} as const;

// ---- Audit log ----------------------------------------------------------------------------------

/** One row of the append-only audit log: who, to whom, what, before and after, why, when. */
export interface AuditEvent {
  id: string;
  /** ISO 8601. */
  at: string;
  actor: { sub: string; email?: string };
  /** e.g. `people.invite`, `people.changeRole`, `content.publish`. */
  action: string;
  target?: { sub?: string; email?: string; recordId?: string };
  before?: unknown;
  after?: unknown;
  reason?: string;
  /** Correlates the log row with request logs. */
  requestId?: string;
}

export interface AuditLogQuery {
  actorSub?: string;
  targetSub?: string;
  action?: string;
  since?: string;
  limit?: number;
  cursor?: string;
}

/**
 * Append-only by design: there is no update or delete, and the table's IAM policy grants only
 * `PutItem` (conditioned on `attribute_not_exists`) and `Query`, so nobody can edit or delete rows,
 * owners included.
 */
export interface AuditLogStore {
  append(event: Omit<AuditEvent, 'id' | 'at'>): Promise<AuditEvent>;
  list(query?: AuditLogQuery): Promise<{ events: AuditEvent[]; nextCursor?: string }>;
}

export interface DynamoAuditLogOptions {
  tableName: string;
  region?: string;
}

/** TODO(phase-2): DynamoDB-backed AuditLogStore (PutItem with attribute_not_exists; Query by actor/target). */
export function createDynamoAuditLog(_options: DynamoAuditLogOptions): AuditLogStore {
  throw new NotImplementedError('createDynamoAuditLog');
}

// ---- People actions -----------------------------------------------------------------------------

export interface PersonRow {
  sub: string;
  username: string;
  email: string;
  name?: string;
  enabled: boolean;
  emailVerified: boolean;
  /** Cognito status (CONFIRMED, FORCE_CHANGE_PASSWORD, ...). */
  status: string;
  groups: string[];
  createdAt: string;
  lastSignInAt?: string | null;
}

/** A list that can fail honestly: on failure the page shows "—" and the reason, never zero. */
export type PeopleList = { state: 'ok'; people: PersonRow[] } | { state: 'unavailable'; reason: string };

export type ActionResult = { ok: true; message: string } | { ok: false; error: string };

export interface InviteInput {
  email: string;
  role: string;
  name?: string;
  reason?: string;
}

export interface ChangeRoleInput {
  sub: string;
  toRole: string;
  fromRole?: string;
  reason: string;
}

/** Sends the branded invite email through SES (Cognito's own invite is suppressed). */
export interface InviteMailer {
  sendInvite(input: { email: string; name?: string; siteName: string; signInUrl: string; expiresAt: Date }): Promise<void>;
}

export interface PeopleAdminConfig<G extends string = string, C extends string = string> {
  auth: ServerAuth<G, C>;
  auditLog: AuditLogStore;
  mailer: InviteMailer;
  siteName: string;
  /** Absolute sign-in URL used in invite emails. */
  signInUrl: string;
}

export interface PeopleActions {
  /** AdminCreateUser with no password and no `email_verified`, MessageAction SUPPRESS; add group; SES email; audit. */
  invite(input: InviteInput): Promise<ActionResult>;
  /** Re-sends the invite email only; never resets anything. */
  resend(sub: string): Promise<ActionResult>;
  /** AdminAddUserToGroup / AdminRemoveUserFromGroup with a reason; promotions need a recent sign-in. */
  changeRole(input: ChangeRoleInput): Promise<ActionResult>;
  /** AdminDisableUser plus removing admin groups and record memberships. */
  disable(sub: string, reason?: string): Promise<ActionResult>;
  /** AdminEnableUser. Old sessions stay ended. */
  enable(sub: string): Promise<ActionResult>;
  /** AdminUserGlobalSignOut. Not removal. */
  signOutEverywhere(sub: string): Promise<ActionResult>;
  /** AdminDeleteUser, owners only, after the retention period. */
  deleteUser(sub: string, reason: string): Promise<ActionResult>;
  /** Every person with live status and groups. */
  listPeople(): Promise<PeopleList>;
  /** Disables unaccepted invites older than 7 days; returns who was disabled. */
  expireStaleInvites(): Promise<{ disabled: string[] }>;
}

/**
 * TODO(phase-2): People page server actions. Each action: `requireCan(<capability>, { live: true })`,
 * `checkPeopleAction(...)` with live groups and a live owner count, step-up for promotions, the
 * Cognito call, then the audit row in the same server action.
 */
export function createPeopleActions<G extends string, C extends string>(_config: PeopleAdminConfig<G, C>): PeopleActions {
  throw new NotImplementedError('createPeopleActions');
}
