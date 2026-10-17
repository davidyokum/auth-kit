/**
 * `auth-kit/dev`: the localhost kit (primer Chapter 8, 03 §2 "Local development").
 *
 * - Personas from `personas.json`, seeded into your sandbox pool (`seedPersonas`, `npx auth-kit seed-personas`).
 * - "Sign in as…": a dev-only route that signs a persona in for real (`createDevKit`), behind the
 *   request gates, a loopback-binding check, and a sandbox-pool check, answering 404 otherwise.
 * - Keeping it out of production (`withDevKit` for next.config), and proving it in CI
 *   (`checkProductionBuild`, `checkDevRouteAbsent`, `npx auth-kit check-prod-build` / `check-dev-route`).
 *
 * **Never import this module from code that ships.** The UI that does ship (the environment ribbon
 * and the View as banner) is `auth-kit/ribbon`; the persona menu is `auth-kit/dev/menu` (dev only).
 */
export {
  DEV_GATES,
  CLIENT_ADDRESS_HEADERS,
  DEV_SERVER_COMMAND,
  checkDevSignInGates,
  devGateInputFor,
  devSignInGatesFor,
  forwardedClientAddresses,
  isLocalhostName,
  isLoopbackAddress,
  isLoopbackHost,
  localDevServer,
  type DevGate,
  type DevGateId,
  type DevGateInput,
  type DevGateResult,
  type LocalDevServer,
} from './gates.js';
export {
  checkLoopbackBinding,
  listeningSockets,
  networkAddresses,
  probeTcp,
  type BindCheck,
  type BindCheckOptions,
  type ListeningSocket,
  type ProbeResult,
} from './bind.js';
export {
  NotASandboxPoolError,
  assertSandboxPool,
  assertSandboxInspection,
  cachedSandboxCheck,
  clearSandboxCheckCache,
  inspectUserPool,
  sandboxProblems,
  DEFAULT_SANDBOX_MAX_USERS,
  type PoolInspection,
  type SandboxCheckOptions,
  type SandboxCheckResult,
  type SandboxPolicy,
} from './sandbox.js';
export {
  defaultPersonas,
  parsePersonas,
  personaCredentialsFromEnv,
  personaEmail,
  personaEnvNames,
  personaForEmail,
  personaLabel,
  type ParsePersonasOptions,
  type Persona,
  type PersonaCredentials,
  type PersonaRole,
} from './personas.js';
export { seedPersonas, type SeedPersonasOptions, type SeedReport, type SeededPersona } from './seed.js';
export {
  PersonaSignInError,
  enrollPersonaTotp,
  resetPersonaAuthState,
  signInPersona,
  type EnrollTotpInput,
  type PersonaAuthContext,
  type PersonaSignInErrorCode,
  type PersonaTokens,
  type SignInPersonaInput,
} from './exchange.js';
export { createDevKit, createDevSignInHandler, type DevKit, type DevKitOptions, type DevPersonaList, type DevRouteHandler } from './sign-in.js';
export {
  amplifySessionCookies,
  encodeCookieValue,
  expireAmplifyCookies,
  parseCookieHeader,
  readAmplifySession,
  type AmplifySession,
  type AmplifySessionCookieOptions,
} from './amplify-cookies.js';
export { accountFromArn, chooseCredentials, createDevCognitoClient, devPoolConfig, type CredentialChoice, type DevPoolConfig, type DevPoolInput } from './aws.js';
export { generatePersonaPassword, gitIgnoreStatus, parseEnvFile, updateEnvContent, type GitIgnoreStatus } from './env-file.js';
export { base32Decode, base32Encode, totpCode, totpStep, TOTP_STEP_SECONDS } from './totp.js';
export {
  assertProductionBuild,
  checkProductionBuild,
  type ProductionBuildCheckOptions,
  type ProductionBuildCheckResult,
  type ProductionBuildFinding,
  type ProductionBuildFindingKind,
} from './build-check.js';
export { checkDevRouteAbsent, type DevRouteCheckOptions, type DevRouteCheckResult, type DevRouteProbe } from './http-check.js';
export {
  withDevKit,
  isDevServerPhase,
  PHASE_DEVELOPMENT_SERVER,
  DEV_ALIAS,
  DEV_MATRIX_ALIAS,
  type DevKitAlias,
  type DevKitConfigOptions,
  type DevKitNextConfig,
  type DevKitNextConfigResult,
} from './next-config.js';
export { DEV_SIGN_IN_ROUTE, DEV_SIGNIN_MARKER, DEV_SIGNIN_MARKER_HEADER, MATRIX_SERVER_MARKER } from './marker.js';
export {
  environmentRibbonModel,
  resolveEnvironment,
  environmentMetadata,
  viewAsMetadata,
  environmentFavicon,
  RIBBON_COLORS,
  type EnvironmentRibbonInput,
  type EnvironmentRibbonModel,
  type ResolveEnvironmentInput,
  type RibbonEnvironment,
  type RibbonTone,
  type TitleMetadata,
} from './ribbon-model.js';
export { DEV_POLICY } from '../shared/policy.js';
