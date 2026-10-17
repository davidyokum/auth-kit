/**
 * `auth-kit/admin`: the admin area's people-and-access module (primer §9 and Chapter 7, 03 §2
 * "Admin area"). Server-only: it imports the AWS SDK. The React components are in
 * `auth-kit/admin/ui`, and the audit table's CDK construct is in `auth-kit/admin/cdk`.
 *
 * - `createPeopleActions`: the People page's server actions (invite, resend, change role, disable,
 *   re-enable, sign out everywhere, delete, list, Activity), each checked live and guarded.
 * - `createDynamoAuditLog`: the append-only audit log, and `runAudited` / `recordChange`, the
 *   intent → calls → result ordering for any change an app logs.
 * - `createInviteExpirySweep`: the scheduled job that disables invites unused for 7 days (deployed by
 *   `InviteExpirySweep` from `auth-kit/admin/cdk`).
 */
export {
  checkPeopleAction,
  grantableRoles,
  grantCeiling,
  highestAdminRole,
  isKnownRole,
  roleRank,
  inviteStatus,
  inviteExpiresAt,
  MEMBER_ROLE,
  PEOPLE_ACTIONS,
  PEOPLE_ACTION_CAPABILITY,
  type PeopleAction,
  type GuardrailActor,
  type GuardrailPerson,
  type GuardrailTarget,
  type GuardrailInput,
  type GuardrailResult,
  type GuardrailCode,
  type InviteStatus,
  type InviteMode,
} from './guardrails.js';
export {
  PEOPLE_ACTION_COPY,
  OWNER_GRANT_NOTE,
  peopleActionDetails,
  roleLabel,
  lostPasskeyGuidance,
  describeActivity,
  type PeopleActionDetail,
  type LostPasskeyGuide,
  type ActivityLine,
} from './copy.js';
export { createPeopleActions, type PeopleAdminConfig, type PeopleActions, type PeopleFormActions } from './people.js';
export { createInviteExpirySweep, INVITE_EXPIRY_ACTOR, type SweepResult, type InviteExpirySweepOptions } from './sweep.js';
export { PEOPLE_AUDIT_ACTIONS } from './audit-actions.js';
export { describeAwsError } from './aws-errors.js';
export {
  createDynamoAuditLog,
  createMemoryAuditLog,
  newAuditId,
  runAudited,
  recordChange,
  AuditRowExistsError,
  AuditEventInvalidError,
  AuditUnavailableError,
  AuditIncompleteError,
  type AuditLogStore,
  type DynamoAuditLogOptions,
  type MemoryAuditLog,
  type AuditedChange,
  type AuditedRun,
  type ChangeSteps,
} from './audit.js';
export { AUDIT_TABLE_SCHEMA } from './audit-schema.js';
export {
  createSesInviteMailer,
  renderInviteEmail,
  renderOwnerAlertEmail,
  type InviteMailer,
  type InviteEmail,
  type OwnerAlertNotifier,
  type OwnerGrantAlert,
  type RenderedEmail,
  type SesInviteMailerOptions,
} from './mailer.js';
export {
  auditLogAppPolicy,
  auditLogResourcePolicy,
  peopleAdminPolicy,
  inviteExpirySweepPolicy,
  AUDIT_LOG_APP_ACTIONS,
  AUDIT_LOG_DENIED_ITEM_ACTIONS,
  PEOPLE_ADMIN_COGNITO_ACTIONS,
  INVITE_EXPIRY_COGNITO_ACTIONS,
  type IamPolicyDocument,
  type IamStatement,
  type PeopleAdminPolicyOptions,
} from './iam.js';
export {
  createQuotaLimiter,
  withBackoff,
  TokenBucket,
  isThrottlingError,
  isTransientError,
  type QuotaLimiter,
  type QuotaLimiterOptions,
  type BackoffOptions,
  type Sleep,
} from './quota.js';
export { ADMIN_POLICY, COGNITO_RATE_QUOTAS, DEFAULT_QUOTA_BUDGET, type CognitoQuotaCategory } from './policy.js';
export {
  PEOPLE_FORM_FIELDS,
  type PersonRow,
  type PeopleList,
  type ActionResult,
  type ActionErrorCode,
  type FormAction,
  type InviteInput,
  type TargetInput,
  type ChangeRoleInput,
  type DeleteUserInput,
  type AuditPhase,
  type AuditOutcome,
  type AuditActor,
  type AuditTarget,
  type AuditRequestContext,
  type AuditEvent,
  type AuditEventInput,
  type AuditLogQuery,
  type AuditLogPage,
  type ActivityEntry,
  type ActivityPage,
} from './types.js';
