/**
 * `auth-kit/server`: checks that run on the server, for the data, on every request.
 *
 * Every route handler, server action, and data-loading server component calls `requireUser()` or a
 * role check (`requireCan()` for a capability, `requireGroup()` for a coarse gate). The proxy is a
 * first checkpoint, never the only one.
 */
export {
  createServerAuth,
  type ServerAuth,
  type ServerAuthOptions,
  type AuthUser,
  type UserProfile,
  type GuardOptions,
  type GetUserOptions,
  type RequireUserOptions,
  type RequireRoleOptions,
  type ResourceAccessConfig,
  type ResourceGuardOptions,
  type ResourceAccess,
  type MyResources,
  type RecordAccessRule,
} from './auth.js';
export {
  defineResourceTypes,
  decideResourceAccess,
  neededActions,
  resourceAccessCopy,
  resourceRoleOptions,
  isResourceId,
  isResourceType,
  isResourceRole,
  type ResourceTypes,
  type ResourceTypeOptions,
  type ResourceTypeConfig,
  type ResourceDecision,
  type ResourceAccessCopy,
  type ResourceRoleOption,
} from '../resources/policy.js';
export type { ResourceAccessStore, ResourceMembership, ResourceRef } from '../resources/types.js';
export {
  defineCapabilities,
  standardCapabilities,
  STANDARD_CAPABILITIES,
  STANDARD_GROUPS,
  type Capabilities,
  type CapabilityOf,
  type GroupOf,
} from './capabilities.js';
export {
  createTokenVerifier,
  TOKEN_TIME_POLICY,
  type TokenVerifier,
  type TokenVerifierOptions,
  type AccessTokenClaims,
  type IdTokenClaims,
} from './verify.js';
export {
  createCognitoGateway,
  needsTotpEnrollment,
  needsFirstCredential,
  type CognitoGateway,
  type CognitoGatewayOptions,
  type UserAuthFactors,
  type LiveUserState,
} from './cognito.js';
export { resolvePoolConfig, poolConfigFromAmplifyOutputs, type PoolConfig, type ResolvedPoolConfig, type AmplifyOutputsAuth } from './config.js';
export {
  amplifyCookieTokens,
  amplifyCookieNames,
  bearerToken,
  firstTokenSource,
  defaultTokenSource,
  encodeCookieName,
  AMPLIFY_COOKIE_PREFIX,
  type TokenSource,
  type FoundTokens,
  type RequestContext,
  type CookieReader,
  type HeaderReader,
} from './tokens.js';
export { toRequestContext, nextHeadersContext, parseCookieHeader, type RequestInput } from './context.js';
export { safeRedirect, isSafeRedirect, type SafeRedirectOptions } from './redirect.js';
export {
  secureCookieOptions,
  serializeCookie,
  amplifyCookieRuntimeOptions,
  applyNoStore,
  isSameOriginRequest,
  assertSameOrigin,
  SECURE_COOKIE_DEFAULTS,
  PRIVATE_NO_STORE,
  type CookieOptions,
  type AmplifyCookieRuntimeInput,
  type OriginCheckRequest,
  type OriginCheckOptions,
} from './cookies.js';
export {
  AuthError,
  UnauthenticatedError,
  StepUpRequiredError,
  ForbiddenError,
  MfaEnrollmentRequiredError,
  FirstCredentialRequiredError,
  NotFoundError,
  AuthUnavailableError,
  AUTH_UNAVAILABLE_DIGEST,
  isAuthError,
  isAuthUnavailableError,
  authErrorResponse,
  withAuthErrors,
  type AuthErrorCode,
  type AuthErrorStatus,
} from './errors.js';
export {
  createPageGuards,
  handlePageAuthError,
  signInUrl,
  RETURN_PATH_HEADER,
  type PageGuards,
  type PageGuardOptions,
} from './pages.js';
export { TtlCache } from './cache.js';
export type { JwksLike } from './jwks.js';
export {
  SESSION_POLICY,
  OWNER_GROUP,
  MEMBER_ROLE,
  MEMBER_LABEL,
  ADMIN_ROLE_RANK,
  ADMIN_ROLE_LABEL,
  ROLE_DESCRIPTIONS,
  ROLE_MATRIX,
  ROLE_MATRIX_COLUMNS,
  ROLE_MATRIX_CAPABILITIES,
  INVITE_EXPIRY_DAYS,
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
  type StandardGroup,
  type SiteRole,
  type RoleDescription,
  type RoleMatrixColumn,
  type RoleMatrixCell,
  type RoleMatrixRow,
  type AuthTier,
} from '../shared/policy.js';
