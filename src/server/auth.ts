import { type ResourceNeed, type ResourceTypes, decideResourceAccess, isResourceId, isResourceTypes, neededActions } from '../resources/policy.js';
import type { ResourceAccessStore, ResourceMembership } from '../resources/types.js';
import { type ResourceRole, SESSION_POLICY } from '../shared/policy.js';
import { TtlCache } from './cache.js';
import type { Capabilities } from './capabilities.js';
import { type CognitoGateway, type LiveUserState, createCognitoGateway, needsTotpEnrollment } from './cognito.js';
import { type PoolConfig, type ResolvedPoolConfig, resolvePoolConfig } from './config.js';
import { type RequestInput, nextHeadersContext, toRequestContext } from './context.js';
import {
  AuthUnavailableError,
  ForbiddenError,
  MfaEnrollmentRequiredError,
  NotFoundError,
  StepUpRequiredError,
  UnauthenticatedError,
} from './errors.js';
import type { JwksLike } from './jwks.js';
import { type RequestContext, type TokenSource, defaultTokenSource } from './tokens.js';
import { type AccessTokenClaims, type TokenVerifier, createTokenVerifier } from './verify.js';

export interface ServerAuthOptions<G extends string = string, C extends string = string> extends PoolConfig {
  /** The app's one capability map, from `defineCapabilities`. */
  capabilities: Capabilities<G, C>;
  /** Where to find tokens. Default: `Authorization: Bearer`, then Amplify's `ssr: true` cookies. */
  tokenSource?: TokenSource;
  /**
   * Refuse password users who haven't set up an authenticator code (`MfaEnrollmentRequiredError`).
   * Default `true`. The TOTP setup page itself passes `allowMfaEnrollment: true`.
   */
  requireTotpForPasswordUsers?: boolean;
  /** How the TOTP check reads factors: the person's own token (default) or the server's IAM role. */
  factorLookup?: 'access-token' | 'iam';
  /** How long a "has an authenticator" answer is reused. Default 300 seconds. */
  factorCheckTtlSeconds?: number;
  /** How long a live status-and-groups read is reused. Default 60 seconds. */
  liveCheckTtlSeconds?: number;
  /** Default maximum sign-in age for step-up. Default 300 seconds. */
  stepUpMaxAgeSeconds?: number;
  /** Cognito calls (inject a fake in tests). Default: the AWS SDK with the server's credentials. */
  cognito?: CognitoGateway;
  /** Preloaded JWKS (tests). Production fetches and caches the pool's keys. */
  jwks?: JwksLike;
  /** Replaces the JWKS fetch (tests). */
  jwksFetcher?: (uri: string) => Promise<unknown>;
  /** Token verifier override (tests). */
  verifier?: TokenVerifier;
  /** Milliseconds since the epoch (tests). */
  now?: () => number;
  /** How to read the current request when none is passed. Default: Next's `cookies()` and `headers()`. */
  context?: () => Promise<RequestContext>;
  /**
   * Resource roles (ADR 0022): the app's resource types and where memberships live. Needed by
   * `requireResourceRole`, `resourceAccess`, and `listMyResources`, and by `createResourceActions`.
   */
  resources?: ResourceAccessConfig;
}

/** The app's resource types (`defineResourceTypes`) and its membership store. */
export interface ResourceAccessConfig {
  types: ResourceTypes;
  store: ResourceAccessStore;
}

/** Display fields from a verified ID token whose `sub` matches the access token. */
export interface UserProfile {
  email?: string;
  emailVerified?: boolean;
  name?: string;
}

/** A signed-in person, built from a verified access token. */
export interface AuthUser<C extends string = string> {
  readonly sub: string;
  /** Cognito username: pass this to Admin* APIs. */
  readonly username: string;
  /** Groups from the token, or from Cognito when `live` is true. */
  readonly groups: readonly string[];
  readonly capabilities: ReadonlySet<C>;
  /** When they actually signed in (seconds since the epoch). */
  readonly authTime: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
  /** The access token's `jti`. */
  readonly tokenId: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly profile: UserProfile | null;
  /** True when `groups` were re-read from Cognito for this request. */
  readonly live: boolean;
  readonly claims: Readonly<AccessTokenClaims>;
}

export interface GuardOptions {
  /** The request to read. Omit inside Next.js to use `cookies()` and `headers()`. */
  request?: RequestInput;
}

export interface RequireUserOptions extends GuardOptions {
  /** Let a password user without an authenticator through (only the TOTP setup page should). */
  allowMfaEnrollment?: boolean;
}

/**
 * `getUser` applies the same authenticator rule as `requireUser`: a password user without TOTP comes
 * back as `null` (not signed in for the app's purposes) unless `allowMfaEnrollment` is true.
 */
export type GetUserOptions = RequireUserOptions;

export interface RequireRoleOptions extends RequireUserOptions {
  /**
   * Re-read the person's enabled status and groups from Cognito (cached ~60 s). Use it on admin-area
   * writes, so disabling or demoting an admin takes effect there at once.
   */
  live?: boolean;
  /** Also require a recent sign-in: `true` for the default age, or a number of seconds. */
  recentSignIn?: boolean | number;
}

export interface ResourceGuardOptions<C extends string = string> extends RequireRoleOptions {
  /**
   * The signed-in person, when the page already has them from this auth (`requireUser`, `getUser`, a
   * page guard): skips reading the request again. A user object from anywhere else is refused.
   */
  user?: AuthUser<C>;
}

/** What one person may do on one item: their resource role there, plus their site role's floor. */
export interface ResourceAccess<C extends string = string> {
  readonly user: AuthUser<C>;
  readonly type: string;
  readonly id: string;
  /** Their role on this item, or null for none. */
  readonly role: ResourceRole | null;
  readonly membership: ResourceMembership | null;
  /** Everything they may do on it: what their site role grants on every item, or their role here. */
  readonly actions: ReadonlySet<string>;
  /** What their site role alone grants (or a shared directory's `view`). */
  readonly viaSite: ReadonlySet<string>;
  can(action: string): boolean;
}

/**
 * "My items" for one type. `all`: this person may see every item (a site role whose floor includes
 * `view`, or a type with a shared directory), so list them from the app's own store; `roles` says
 * which they have a role on. `mine`: only the items they have a role on.
 */
export type MyResources =
  | { scope: 'all'; reason: 'site-role' | 'shared-directory'; roles: ReadonlyMap<string, ResourceRole>; truncated: boolean }
  | { scope: 'mine'; items: readonly { id: string; role: ResourceRole; addedAt: string }[]; truncated: boolean };

/** @deprecated Use resource roles: `requireResourceRole` (ADR 0022). Kept for one release. */
export interface RecordAccessRule<R, C extends string> {
  /** The owner's `sub`. */
  owner?: (record: R) => string | null | undefined;
  /** `sub`s of people who belong to the record (reviewers, team members). */
  members?: (record: R) => Iterable<string> | null | undefined;
  /** A capability that covers every record (e.g. `reviews.read-all` for admins). */
  coveredBy?: C;
}

export interface ServerAuth<G extends string = string, C extends string = string> {
  readonly capabilities: Capabilities<G, C>;
  /** The pool and app client this instance accepts tokens from. */
  readonly pool: Readonly<ResolvedPoolConfig>;
  /** Where this instance looks for tokens. */
  readonly tokenSource: TokenSource;
  /** Verifies an access token: signature, expiry, issuer, audience (`client_id`), `token_use`. */
  verifyAccessToken(token: string): Promise<AccessTokenClaims>;
  /**
   * The signed-in person, or `null`, for optional display (a header that says who's signed in).
   * Throws only `AuthUnavailableError` (couldn't check). Applies the authenticator rule: a password
   * user without TOTP is `null` unless `allowMfaEnrollment` is true. Gate routes with `requireUser`
   * or `requireCan`, which say *why* someone is refused (401 vs 403 `mfa_enrollment_required`).
   */
  getUser(options?: GetUserOptions): Promise<AuthUser<C> | null>;
  /** The signed-in person, or throws 401 (and 403 for a password user without an authenticator). */
  requireUser(options?: RequireUserOptions): Promise<AuthUser<C>>;
  /** Requires membership in any of `groups`. Prefer `requireCan`; use this for coarse gates. */
  requireGroup(groups: G | readonly G[], options?: RequireRoleOptions): Promise<AuthUser<C>>;
  /** Requires a capability. The main check for routes, actions, and data-loading components. */
  requireCan(capability: C, options?: RequireRoleOptions): Promise<AuthUser<C>>;
  /** True when the person holds the capability (no throw). */
  can(user: AuthUser<C>, capability: C): boolean;
  /** Throws `StepUpRequiredError` unless the person signed in within `maxAgeSeconds`. */
  requireRecentSignIn(user: AuthUser<C>, maxAgeSeconds?: number): void;
  /** The person's live status and groups from Cognito (cached). */
  liveState(user: AuthUser<C>): Promise<LiveUserState>;
  /** The resource types and membership store this instance checks against (`resources`), or null. */
  readonly resources: Readonly<ResourceAccessConfig> | null;
  /**
   * The check for routes that take an item's ID (ADR 0022): allowed when the person's site role
   * grants it on every item, or their role on this item does. `need` is an action (`'edit'`) or a
   * minimum role (`'contributor'`: every action a Contributor has). Someone who can't see the item
   * gets 404 (`NotFoundError`), never a hint that it exists; someone who can see it but not do this
   * gets 403. Couldn't read memberships: 503.
   */
  requireResourceRole(type: string, id: string, need: ResourceNeed, options?: ResourceGuardOptions<C>): Promise<ResourceAccess<C>>;
  /** The same answer without the refusal: what this person may do on the item (possibly nothing). */
  resourceAccess(type: string, id: string, options?: ResourceGuardOptions<C>): Promise<ResourceAccess<C>>;
  /** "My items" for one type: every item for a site role that sees them all, else the person's own. */
  listMyResources(type: string, options?: ResourceGuardOptions<C>): Promise<MyResources>;
  /**
   * @deprecated Use `requireResourceRole` (resource roles, ADR 0022); this alias stays for one
   * release. Loads-and-checks for routes that take an item's ID: returns it when this person owns
   * it, belongs to it, or holds a capability that covers every item. Otherwise 404, never 403.
   */
  requireRecordAccess<R>(user: AuthUser<C>, record: R | null | undefined, rule: RecordAccessRule<R, C>): R;
  /**
   * Forgets cached results after an enrollment or role change: the live status-and-groups read for
   * `username` (what the admin module knows about another person), and, given `sub` and `tokenId`
   * too (an `AuthUser`), that token's authenticator answer.
   */
  invalidate(user: { username: string; sub?: string; tokenId?: string }): void;
}

const ENROLLMENT_RECHECK_MS = 30_000;

const OPTION_KEYS = new Set<string>([
  'userPoolId',
  'clientId',
  'capabilities',
  'tokenSource',
  'requireTotpForPasswordUsers',
  'factorLookup',
  'factorCheckTtlSeconds',
  'liveCheckTtlSeconds',
  'stepUpMaxAgeSeconds',
  'cognito',
  'jwks',
  'jwksFetcher',
  'verifier',
  'now',
  'context',
  'resources',
]);

/** Fails loudly at startup on a misconfiguration instead of producing odd runtime behavior. */
function validateServerAuthOptions<G extends string, C extends string>(options: ServerAuthOptions<G, C>): void {
  const problems: string[] = [];
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) problems.push(`unknown option "${key}"`);
  }
  if (typeof options.capabilities?.capabilitiesOf !== 'function') {
    problems.push('capabilities must come from defineCapabilities()');
  }
  for (const key of ['factorCheckTtlSeconds', 'liveCheckTtlSeconds', 'stepUpMaxAgeSeconds'] as const) {
    const value = options[key];
    if (value !== undefined && !(typeof value === 'number' && Number.isFinite(value) && value > 0)) {
      problems.push(`${key} must be a positive number of seconds`);
    }
  }
  if (options.factorLookup !== undefined && options.factorLookup !== 'access-token' && options.factorLookup !== 'iam') {
    problems.push(`factorLookup must be 'access-token' or 'iam'`);
  }
  if (options.requireTotpForPasswordUsers !== undefined && typeof options.requireTotpForPasswordUsers !== 'boolean') {
    problems.push('requireTotpForPasswordUsers must be true or false');
  }
  for (const key of ['tokenSource', 'jwksFetcher', 'now', 'context'] as const) {
    if (options[key] !== undefined && typeof options[key] !== 'function') problems.push(`${key} must be a function`);
  }
  if (options.resources !== undefined) {
    const { types, store } = options.resources ?? ({} as Partial<ResourceAccessConfig>);
    if (!isResourceTypes(types)) problems.push('resources.types must come from defineResourceTypes()');
    for (const method of ['getMembership', 'getAccess', 'listForPerson', 'commit'] as const) {
      if (typeof store?.[method] !== 'function') problems.push(`resources.store needs ${method}() (createDynamoResourceStore or createMemoryResourceStore)`);
    }
  }
  if (problems.length > 0) throw new Error(`auth-kit: createServerAuth options are invalid:\n- ${problems.join('\n- ')}`);
}

/**
 * Binds one pool, one app client, and the app's capability map. Create it once per app:
 *
 * ```ts
 * // lib/auth.ts
 * import { createServerAuth } from 'auth-kit/server';
 * import outputs from '@/amplify_outputs.json';
 * import { capabilities } from './capabilities';
 *
 * export const auth = createServerAuth({ ...poolConfigFromAmplifyOutputs(outputs), capabilities });
 * ```
 */
export function createServerAuth<G extends string, C extends string>(
  options: ServerAuthOptions<G, C>,
): ServerAuth<G, C> {
  validateServerAuthOptions(options);
  const pool = resolvePoolConfig(options);
  const now = options.now ?? Date.now;
  const verifier =
    options.verifier ??
    createTokenVerifier({
      userPoolId: pool.userPoolId,
      clientId: pool.clientId,
      ...(options.jwks !== undefined && { jwks: options.jwks }),
      ...(options.jwksFetcher !== undefined && { jwksFetcher: options.jwksFetcher }),
    });
  const tokenSource = options.tokenSource ?? defaultTokenSource(pool.clientId);
  const requireTotp = options.requireTotpForPasswordUsers ?? true;
  const factorTtlMs = (options.factorCheckTtlSeconds ?? 300) * 1000;
  const liveTtlMs = (options.liveCheckTtlSeconds ?? SESSION_POLICY.liveCheckTtlSeconds) * 1000;
  const stepUpMax = options.stepUpMaxAgeSeconds ?? SESSION_POLICY.stepUpMaxAgeSeconds;
  const { capabilities } = options;

  let gateway = options.cognito;
  const cognito = (): CognitoGateway =>
    (gateway ??= createCognitoGateway({
      region: pool.region,
      userPoolId: pool.userPoolId,
      ...(options.factorLookup !== undefined && { factorLookup: options.factorLookup }),
    }));

  const factorCache = new TtlCache<string, boolean>(5000, now);
  const liveCache = new TtlCache<string, LiveUserState>(1000, now);
  // The raw token never sits on the user object, so it can't leak into props or logs.
  const rawTokens = new WeakMap<object, string>();

  async function contextFor(request?: RequestInput): Promise<RequestContext> {
    if (request) return toRequestContext(request);
    return options.context ? options.context() : nextHeadersContext();
  }

  function buildUser(
    claims: AccessTokenClaims,
    accessToken: string,
    profile: UserProfile | null,
    live?: LiveUserState,
  ): AuthUser<C> {
    const groups = Object.freeze([...(live ? live.groups : (claims['cognito:groups'] ?? []))]);
    const user: AuthUser<C> = Object.freeze({
      sub: claims.sub,
      username: claims.username ?? '',
      groups,
      capabilities: capabilities.capabilitiesOf(groups),
      authTime: claims.auth_time,
      issuedAt: claims.iat,
      expiresAt: claims.exp,
      tokenId: claims.jti,
      clientId: claims.client_id,
      scopes: Object.freeze((claims.scope ?? '').split(' ').filter(Boolean)),
      profile,
      live: live !== undefined,
      claims: Object.freeze({ ...claims }),
    });
    rawTokens.set(user, accessToken);
    return user;
  }

  /**
   * The verified person before the authenticator rule, or the reason there isn't one (no token, or
   * the verifier's `invalid_token` / `token_expired`), so `requireUser` can say which.
   */
  async function resolveUser(opts: GuardOptions): Promise<AuthUser<C> | UnauthenticatedError> {
    const found = await tokenSource(await contextFor(opts.request));
    if (!found.accessToken) return new UnauthenticatedError();
    let claims: AccessTokenClaims;
    try {
      claims = await verifier.verifyAccessToken(found.accessToken);
    } catch (error) {
      if (error instanceof UnauthenticatedError) return error;
      throw error;
    }
    // Machine tokens (client credentials) carry no username; they aren't people.
    if (!claims.username) return new UnauthenticatedError('invalid_token', 'This token does not belong to a person.');
    let profile: UserProfile | null = null;
    if (found.idToken) {
      try {
        const id = await verifier.verifyIdToken(found.idToken);
        if (id.sub === claims.sub) {
          profile = {
            ...(typeof id.email === 'string' && { email: id.email }),
            ...(typeof id.email_verified === 'boolean' && { emailVerified: id.email_verified }),
            ...(typeof id.name === 'string' && { name: id.name }),
          };
        }
      } catch (error) {
        if (!(error instanceof UnauthenticatedError)) throw error;
      }
    }
    return buildUser(claims, found.accessToken, profile);
  }

  // Keyed by person and token: claim validation guarantees both are non-empty strings, and pairing
  // them means two people can never share an answer even if a token ID repeated.
  const factorKey = (user: Pick<AuthUser<C>, 'sub' | 'tokenId'>) => `${user.sub}\n${user.tokenId}`;

  /** True when this password user still has to set up an authenticator (cached per token). */
  async function needsEnrollment(user: AuthUser<C>): Promise<boolean> {
    if (!requireTotp) return false;
    const key = factorKey(user);
    const cached = factorCache.get(key);
    if (cached !== undefined) return cached;
    const accessToken = rawTokens.get(user);
    if (!accessToken) throw new UnauthenticatedError();
    const needs = needsTotpEnrollment(await cognito().getUserAuthFactors({ accessToken, username: user.username }));
    const untilExpiry = user.expiresAt * 1000 - now();
    factorCache.set(key, needs, Math.min(needs ? ENROLLMENT_RECHECK_MS : factorTtlMs, untilExpiry));
    return needs;
  }

  async function getUser(opts: GetUserOptions = {}): Promise<AuthUser<C> | null> {
    const user = await resolveUser(opts);
    if (user instanceof UnauthenticatedError) return null;
    if (opts.allowMfaEnrollment === true) return user;
    try {
      return (await needsEnrollment(user)) ? null : user;
    } catch (error) {
      // Cognito says the session was revoked or the account is gone: not signed in.
      if (error instanceof UnauthenticatedError) return null;
      throw error;
    }
  }

  async function requireUser(opts: RequireUserOptions = {}): Promise<AuthUser<C>> {
    const user = await resolveUser(opts);
    if (user instanceof UnauthenticatedError) throw user;
    if (opts.allowMfaEnrollment !== true && (await needsEnrollment(user))) throw new MfaEnrollmentRequiredError();
    return user;
  }

  async function liveState(user: AuthUser<C>): Promise<LiveUserState> {
    const cached = liveCache.get(user.username);
    if (cached) return cached;
    const state = await cognito().getLiveUserState(user.username);
    liveCache.set(user.username, state, liveTtlMs);
    return state;
  }

  async function withLiveGroups(user: AuthUser<C>): Promise<AuthUser<C>> {
    const state = await liveState(user);
    if (!state.enabled) throw new UnauthenticatedError('account_disabled', 'This account is disabled.');
    const accessToken = rawTokens.get(user);
    if (!accessToken) throw new UnauthenticatedError();
    return buildUser(user.claims, accessToken, user.profile, state);
  }

  function requireRecentSignIn(user: AuthUser<C>, maxAgeSeconds: number = stepUpMax): void {
    const age = Math.floor(now() / 1000) - user.authTime;
    if (!Number.isFinite(user.authTime) || age > maxAgeSeconds) throw new StepUpRequiredError(maxAgeSeconds);
  }

  async function requireRole(
    allowed: (user: AuthUser<C>) => boolean,
    opts: RequireRoleOptions,
  ): Promise<AuthUser<C>> {
    let user = await requireUser(opts);
    if (opts.live === true) user = await withLiveGroups(user);
    if (!allowed(user)) throw new ForbiddenError();
    if (opts.recentSignIn !== undefined && opts.recentSignIn !== false) {
      requireRecentSignIn(user, typeof opts.recentSignIn === 'number' ? opts.recentSignIn : stepUpMax);
    }
    return user;
  }

  function resourcesConfig(): ResourceAccessConfig {
    if (!options.resources) {
      throw new Error('auth-kit: resource roles need createServerAuth({ resources: { types: defineResourceTypes({…}), store } }).');
    }
    return options.resources;
  }

  /** The person for a resource check: the one given (if this instance made it) or the request's. */
  async function guardUser(opts: ResourceGuardOptions<C>): Promise<AuthUser<C>> {
    let user: AuthUser<C>;
    if (opts.user !== undefined) {
      if (!rawTokens.has(opts.user)) throw new Error('auth-kit: options.user must come from this server auth (requireUser, getUser, or a page guard).');
      user = opts.user;
    } else {
      user = await requireUser(opts);
    }
    if (opts.live === true && !user.live) user = await withLiveGroups(user);
    return user;
  }

  async function resourceAccess(type: string, id: string, opts: ResourceGuardOptions<C> = {}): Promise<ResourceAccess<C>> {
    const { types, store } = resourcesConfig();
    const config = types.get(type);
    const user = await guardUser(opts);
    let membership: ResourceMembership | null = null;
    // An ID that can't name an item gets nothing, not even the site floor: there's no such item.
    const valid = isResourceId(id);
    if (valid) {
      try {
        membership = await store.getMembership({ type, id }, user.sub);
      } catch (error) {
        throw new AuthUnavailableError(`Access to this ${config.noun} couldn’t be checked right now. Please try again.`, { cause: error });
      }
      if (membership && membership.sub !== user.sub) membership = null;
    }
    const decision = valid
      ? decideResourceAccess(config, { capabilities: user.capabilities, role: membership?.role ?? null })
      : { actions: new Set<string>(), viaSite: new Set<string>() };
    return Object.freeze({
      user,
      type,
      id,
      role: membership?.role ?? null,
      membership,
      actions: decision.actions,
      viaSite: decision.viaSite,
      can: (action: string) => decision.actions.has(action),
    });
  }

  async function requireResourceRole(type: string, id: string, need: ResourceNeed, opts: ResourceGuardOptions<C> = {}): Promise<ResourceAccess<C>> {
    // A misspelled action or type is a programming mistake: fail before reading anything.
    const needed = neededActions(resourcesConfig().types.get(type), need);
    const access = await resourceAccess(type, id, opts);
    if (!access.actions.has('view')) throw new NotFoundError();
    if (!needed.every((action) => access.actions.has(action))) throw new ForbiddenError();
    if (opts.recentSignIn !== undefined && opts.recentSignIn !== false) {
      requireRecentSignIn(access.user, typeof opts.recentSignIn === 'number' ? opts.recentSignIn : stepUpMax);
    }
    return access;
  }

  async function listMyResources(type: string, opts: ResourceGuardOptions<C> = {}): Promise<MyResources> {
    const { types, store } = resourcesConfig();
    const config = types.get(type);
    const user = await guardUser(opts);
    let mine;
    try {
      mine = await store.listForPerson(user.sub, type);
    } catch (error) {
      throw new AuthUnavailableError(`Your ${config.nounPlural} couldn’t be listed right now. Please try again.`, { cause: error });
    }
    const memberships = mine.memberships.filter((m) => m.sub === user.sub && m.type === type);
    const floor = decideResourceAccess({ ...config, sharedDirectory: false }, { capabilities: user.capabilities, role: null });
    if (floor.viaSite.has('view') || config.sharedDirectory) {
      return Object.freeze({
        scope: 'all' as const,
        reason: floor.viaSite.has('view') ? ('site-role' as const) : ('shared-directory' as const),
        roles: new Map(memberships.map((m) => [m.id, m.role])),
        truncated: mine.truncated,
      });
    }
    return Object.freeze({
      scope: 'mine' as const,
      items: Object.freeze(memberships.map((m) => Object.freeze({ id: m.id, role: m.role, addedAt: m.addedAt }))),
      truncated: mine.truncated,
    });
  }

  return {
    capabilities,
    pool: Object.freeze({ ...pool }),
    tokenSource,
    verifyAccessToken: (token) => verifier.verifyAccessToken(token),
    getUser,
    requireUser,
    requireGroup: (groups, opts = {}) => {
      const wanted = (typeof groups === 'string' ? [groups] : [...groups]) as string[];
      return requireRole((user) => user.groups.some((g) => wanted.includes(g)), opts);
    },
    requireCan: (capability, opts = {}) => requireRole((user) => user.capabilities.has(capability), opts),
    can: (user, capability) => user.capabilities.has(capability),
    requireRecentSignIn,
    liveState,
    resources: options.resources ? Object.freeze({ ...options.resources }) : null,
    requireResourceRole,
    resourceAccess,
    listMyResources,
    requireRecordAccess<R>(user: AuthUser<C>, record: R | null | undefined, rule: RecordAccessRule<R, C>): R {
      if (record === null || record === undefined) throw new NotFoundError();
      if (rule.coveredBy !== undefined && user.capabilities.has(rule.coveredBy)) return record;
      const owner = rule.owner?.(record);
      if (owner && owner === user.sub) return record;
      const members = rule.members?.(record);
      if (members) for (const member of members) if (member === user.sub) return record;
      throw new NotFoundError();
    },
    invalidate(user) {
      if (user.sub && user.tokenId) factorCache.delete(factorKey({ sub: user.sub, tokenId: user.tokenId }));
      liveCache.delete(user.username);
    },
  };
}
