/**
 * The admin module's concrete settings. They sit here rather than in `src/shared/policy.ts` only
 * because phase 2 was built in parallel; they can move there with no change to callers.
 */

export const ADMIN_POLICY = {
  /**
   * A disabled account can be deleted only after this many days (by its disable row in the audit
   * log). The primer says "after the retention period" without a number; its mock uses 90 days.
   * A never-used invite has nothing to retain and can be deleted as soon as it's disabled.
   */
  deleteRetentionDays: 90,
  /** Every role change records a reason at least this long. */
  reasonMinLength: 3,
  reasonMaxLength: 500,
  nameMaxLength: 100,
  /** The People list stops here and says so (`truncated`). 84 ListUsers pages at 60 a page. */
  maxPeople: 5000,
  activityPageSize: 50,
  activityMaxPageSize: 200,
  /** DynamoDB's item limit is 400 KB; refuse a bigger row before any change is made. */
  auditMaxItemBytes: 350_000,
  /** Invites this close to expiry are flagged "expiring soon". */
  inviteWarnDays: 2,
} as const;

/** Cognito's request-rate quotas (requests per second), shared by every app in the AWS account and Region. */
export const COGNITO_RATE_QUOTAS = {
  /** ListUsers, ListUsersInGroup. Not adjustable. */
  UserList: 30,
  /** AdminAddUserToGroup, AdminRemoveUserFromGroup, AdminDisableUser, AdminEnableUser, AdminUserGlobalSignOut, AdminDeleteUser. Not adjustable. */
  UserUpdate: 25,
  /** AdminCreateUser. */
  UserCreation: 50,
  /** AdminGetUser. */
  UserRead: 120,
  /** AdminListGroupsForUser. */
  UserResourceRead: 50,
} as const;

export type CognitoQuotaCategory = keyof typeof COGNITO_RATE_QUOTAS;

/**
 * What one server instance spends by default: about a third of each quota, because the quota is
 * shared with every other app (and every other instance) in the account.
 */
export const DEFAULT_QUOTA_BUDGET: Readonly<Record<CognitoQuotaCategory, number>> = {
  UserList: 10,
  UserUpdate: 8,
  UserCreation: 15,
  UserRead: 40,
  UserResourceRead: 15,
};
