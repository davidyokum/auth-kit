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
  type RecordAccessRule,
} from './auth.js';
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
  ADMIN_ROLE_RANK,
  ADMIN_ROLE_LABEL,
  INVITE_EXPIRY_DAYS,
  type StandardGroup,
  type AuthTier,
} from '../shared/policy.js';
