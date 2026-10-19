/**
 * `auth-kit/accounts`: how people get an account, and look after their own (register D1–D4,
 * ADR 0023), and the sign-in help address (ADR 0024). Server-only.
 *
 * - `createAccountCreationRoutes`: the sign-up route (a self-invite) and the request-access route,
 *   with the same answer for every address, rate limits, and an origin check.
 * - `createSelfServiceActions`: on sign-up sites, members delete their own account and change their
 *   own email address (a recent sign-in; the new address verified before it takes effect).
 * - `createSignInHelp` and `createSignInHelpActions`: the help address in effect, and the Super
 *   admin's Settings override (audited, the owner alerted).
 * - The stores (`AccessRequestTable`, `RateLimitTable`, `SiteSettingsTable` in `auth-kit/admin/cdk`),
 *   in memory and on DynamoDB.
 * - The scheduled jobs' logic (`UnverifiedAccountSweep`, `AccessRequestDigest` deploy them).
 *
 * The request queue's admin actions (list, approve, decline) are People actions:
 * `createPeopleActions({ accessRequests })` in `auth-kit/admin`.
 */
export {
  createAccountCreationRoutes,
  forwardedForClientIp,
  notOnListMessage,
  type AccountCreationRoutes,
  type AccountCreationRoutesConfig,
  type AccountCreationBody,
  type AccountCreationResult,
  type RequestFacts,
} from './routes.js';
export { createSelfServiceActions, type SelfServiceActions, type SelfServiceConfig } from './self-service.js';
export {
  createSignInHelp,
  createSignInHelpActions,
  helpAddressOf,
  type EffectiveSignInHelp,
  type SignInHelp,
  type SignInHelpActions,
  type SignInHelpActionsConfig,
  type SignInHelpOptions,
  type SignInHelpSource,
  type SignInHelpView,
} from './sign-in-help.js';
export {
  createMemoryAccessRequestStore,
  createDynamoAccessRequestStore,
  createMemoryRateLimitStore,
  createDynamoRateLimitStore,
  createMemorySiteSettingsStore,
  createDynamoSiteSettingsStore,
  rateLimitKey,
  newRequestId,
  isRequestId,
  AccessRequestConflictError,
  SettingConflictError,
  type AccessRequest,
  type AccessRequestStatus,
  type AccessRequestStore,
  type RateLimitResult,
  type RateLimitStore,
  type SiteSettingsStore,
  type StoredSetting,
} from './stores.js';
export { ACCESS_REQUEST_TABLE_SCHEMA, RATE_LIMIT_TABLE_SCHEMA, SITE_SETTINGS_TABLE_SCHEMA, SITE_SETTING } from './schema.js';
export { createUnverifiedAccountSweep, unverifiedSignUpDue, type UnverifiedSweepOptions, type UnverifiedSweepResult } from './unverified-sweep.js';
export { createAccessRequestDigest, PEOPLE_MANAGER_GROUPS, type AccessRequestDigestOptions, type AccessRequestDigestResult } from './digest.js';
export { ACCOUNT_AUDIT_ACTIONS, SIGN_UP_ACTOR, UNVERIFIED_SWEEP_ACTOR } from '../admin/audit-actions.js';
export {
  ACCOUNT_CREATION_MODES,
  INVITE_ONLY,
  normalizeAccountCreation,
  emailDomainAllowed,
  allowsSelfSignUp,
  takesAccessRequests,
  mayCreateOwnAccount,
  listInWords,
  SIGN_UP_ORIGIN_ATTRIBUTE,
  SIGN_UP_ORIGIN_VALUE,
  type AccountCreationMode,
  type AccountCreationSettings,
  type NormalizedAccountCreation,
} from '../shared/account-creation.js';
export { ACCOUNT_CREATION_POLICY, CODE_LIFETIME_POLICY, codeLifetimeMinutes } from '../shared/policy.js';
export {
  createAccountNoticeRoute,
  ACCOUNT_NOTICE_EVENTS,
  ACCOUNT_NOTICE_PATH,
  type AccountNoticeEvent,
  type AccountNoticeRoute,
  type AccountNoticeRouteConfig,
  type AccountNoticeBody,
} from './notices.js';
