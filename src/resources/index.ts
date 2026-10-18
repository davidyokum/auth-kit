/**
 * `auth-kit/resources`: resource roles (ADR 0022). Who can do what to one project, plan, grant, or
 * other item: Manager, Contributor, Reader, combined with the site-wide roles (the site role is a
 * floor on every item; a resource role adds to it on that item). Server-only: it imports the AWS SDK.
 * The "Who has access" panel is in `auth-kit/resources/ui`; the membership table's CDK construct is
 * `ResourceAccessTable` in `auth-kit/admin/cdk`.
 *
 * - `defineResourceTypes`: the app's types, their nouns, and the two per-type switches
 *   (`selfServiceCreate`, `sharedDirectory`), next to its capability map.
 * - `createDynamoResourceStore` / `createMemoryResourceStore`: where memberships live. Pass the store
 *   and types to `createServerAuth({ resources })`, which adds `requireResourceRole`,
 *   `resourceAccess`, and `listMyResources`.
 * - `createResourceActions`: the audited access changes, a Manager's invite with its alert to the
 *   site's admins, creating an item with its first Manager, and the People page's disable hook.
 */
export {
  defineResourceTypes,
  decideResourceAccess,
  neededActions,
  equivalentRole,
  createPermission,
  checkAccessChange,
  resourceAccessCopy,
  resourceRoleOptions,
  resourceLabel,
  compareResourceRoles,
  isResourceTypes,
  isResourceType,
  isResourceId,
  isResourceRole,
  isPersonSub,
  type ResourceTypes,
  type ResourceTypeOptions,
  type ResourceTypeConfig,
  type ResourceDecision,
  type AccessChange,
  type AccessGuardCode,
  type AccessGuardInput,
  type AccessGuardResult,
  type ResourceAccessCopy,
  type ResourceRoleOption,
} from './policy.js';
export {
  createResourceActions,
  RESOURCE_AUDIT_ACTIONS,
  RESOURCE_FORM_FIELDS,
  type ResourceActionsConfig,
  type ResourceActions,
  type ResourceFormActions,
  type ResourceTargetInput,
  type AddMemberInput,
  type ChangeMemberRoleInput,
  type RemoveMemberInput,
  type InviteToResourceInput,
  type CreateResourceInput,
  type CreateResourceResult,
  type ResourceAccessList,
  type ResourceMemberRow,
  type RemovedMemberships,
} from './actions.js';
export {
  createMemoryResourceStore,
  ResourceConflictError,
  isResourceConflict,
  countManagers,
  type MemoryResourceStore,
  type MemoryResourceData,
} from './store.js';
export { createDynamoResourceStore, type DynamoResourceStoreOptions } from './dynamo.js';
export { RESOURCE_TABLE_SCHEMA } from './schema.js';
export {
  RESOURCE_COMMIT_MAX_ITEMS,
  type ResourceRef,
  type ResourceMembership,
  type ResourceMeta,
  type ResourceAccessRecord,
  type ResourceCommit,
  type ResourceAccessStore,
  type PersonMemberships,
} from './types.js';
export {
  renderResourceInviteAlertEmail,
  type ResourceInviteAlert,
  type ResourceInviteNotifier,
} from '../admin/mailer.js';
export type { ResourceAccess, ResourceGuardOptions, ResourceAccessConfig, MyResources } from '../server/auth.js';
export {
  RESOURCE_ROLES,
  RESOURCE_ROLE_LABEL,
  RESOURCE_ROLE_RANK,
  RESOURCE_ROLE_DESCRIPTIONS,
  RESOURCE_ACTIONS,
  RESOURCE_ACTION_LABEL,
  DEFAULT_RESOURCE_ROLE_ACTIONS,
  RESOURCE_SITE_FLOOR,
  RESOURCE_POLICY,
  RESOURCE_ACCESS_MATRIX,
  resourceRoleDescriptions,
  type ResourceRole,
  type StandardResourceAction,
  type ResourceAccessMatrixRow,
} from '../shared/policy.js';
