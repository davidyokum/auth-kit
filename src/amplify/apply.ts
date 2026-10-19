import { Annotations, ArnFormat, Stack, Tags, Token } from 'aws-cdk-lib';
import type { CfnIdentityPool, CfnUserPool, CfnUserPoolClient, CfnUserPoolGroup, IUserPool } from 'aws-cdk-lib/aws-cognito';
import type { CfnWebACL, CfnWebACLAssociation } from 'aws-cdk-lib/aws-wafv2';
import {
  AMPLIFY_DEPLOYMENT_TYPE_CONTEXT_KEY,
  type AmplifyDeploymentType,
  DEV_POLICY,
  PASSWORD_POLICY,
  SESSION_POLICY,
} from '../shared/policy.js';
import { allowsSelfSignUp } from '../shared/account-creation.js';
import { UNVERIFIED_SWEEP_MARK, isUnverifiedSweep } from './sweep-mark.js';
import { CUSTOM_MESSAGE_GATE_ENV } from './custom-message.js';
import { type AuthStandardOptions, AuthStandardConfigError, normalizeOptions, webAclArnRegion } from './options.js';
import { associateAuthWebAcl, createAuthWebAcl } from './waf.js';
import { encodeSenderName } from '../themes/index.js';

/** How the pool is rate limited. */
export interface AppliedWaf {
  /** `created`: a web ACL for this pool; `shared`: an existing one associated; `none`: no rate limit. */
  mode: 'created' | 'shared' | 'none';
  /** The ACL the preset created (`created` only). */
  webAcl: CfnWebACL | null;
  /** The ARN associated with the pool (a token for a created ACL). */
  webAclArn: string | null;
  association: CfnWebACLAssociation | null;
}

/**
 * The parts of an Amplify auth resource the preset changes. `backend.auth` from `defineBackend` fits,
 * and so does an `AmplifyAuth` construct from `@aws-amplify/auth-construct`.
 */
export interface AuthResourceLike {
  resources: {
    userPool: IUserPool;
    cfnResources: {
      cfnUserPool: CfnUserPool;
      cfnUserPoolClient: CfnUserPoolClient;
      cfnIdentityPool: CfnIdentityPool;
    };
    groups: { [groupName: string]: { cfnUserGroup: CfnUserPoolGroup } };
  };
}

/** What `applyAuthStandard` decided, for logging and tests. */
export interface AppliedAuthStandard {
  deploymentType: AmplifyDeploymentType | undefined;
  isSandbox: boolean;
  environment: string;
  relyingPartyId: string | null;
  allowedFirstAuthFactors: string[];
  explicitAuthFlows: string[];
  mfaConfiguration: 'OPTIONAL' | 'ON';
  deletionProtection: 'ACTIVE' | 'INACTIVE';
  userPoolTier: 'ESSENTIALS' | 'PLUS';
  tags: Record<string, string>;
  waf: AppliedWaf;
  /** The sign-in session (and so an emailed code's lifetime), in minutes. */
  codeLifetimeMinutes: number;
  /** The CLOUDFRONT web ACL in front of the sign-up route (required in `open` mode), or null. */
  siteWebAclArn: string | null;

  /** True only when the site configured real OAuth callback URLs (hosted-UI / federated sign-in). */
  hostedUiOAuth: boolean;
}

const SIGN_UP_ENABLED =
  "auth-kit: Cognito's own SignUp is on for this pool (AdminCreateUserConfig.AllowAdminCreateUserOnly isn't true in the template). " +
  "auth-kit keeps it off in every accountCreation mode (ADR 0023): sign-up is a server route that creates the account like an invite. Remove whatever turns it back on.";

const NO_CUSTOM_MESSAGE_TRIGGER =
  'auth-kit: this pool has no custom message trigger. Every pool needs it (ADR 0023): besides the code emails\' words, it refuses email changes made ' +
  "through Cognito's public API (UpdateUserAttributes with a user's token), which would skip the site's recent-sign-in check, domain list, audit log, and notice " +
  'to the old address. Add triggers: { customMessage } built with customMessageHandler from auth-kit/amplify/custom-message.';

/** The pool's properties as they'll be deployed, read from the rendered resource when CDK allows it. */
interface RenderedPool {
  AdminCreateUserConfig?: { AllowAdminCreateUserOnly?: unknown };
  LambdaConfig?: { PreSignUp?: unknown; CustomMessage?: unknown };
}

/**
 * The pool's synthesized properties, overrides included. Reads the rendered resource
 * (`_toCloudFormation`, which applies every override), so a later override or property set anywhere in
 * the app is caught at synth; falls back to the typed properties if that internal ever goes away.
 */
function renderedPool(stack: Stack, pool: CfnUserPool): RenderedPool {
  const render = (pool as unknown as { _toCloudFormation?: () => unknown })._toCloudFormation;
  if (typeof render === 'function') {
    const rendered = stack.resolve(render.call(pool)) as { Resources?: Record<string, { Properties?: RenderedPool }> };
    return Object.values(rendered.Resources ?? {})[0]?.Properties ?? {};
  }
  const config = stack.resolve(pool.adminCreateUserConfig) as { allowAdminCreateUserOnly?: unknown; AllowAdminCreateUserOnly?: unknown } | undefined;
  const lambda = stack.resolve(pool.lambdaConfig) as { preSignUp?: unknown; PreSignUp?: unknown; customMessage?: unknown; CustomMessage?: unknown } | undefined;
  return {
    AdminCreateUserConfig: { AllowAdminCreateUserOnly: config?.allowAdminCreateUserOnly ?? config?.AllowAdminCreateUserOnly },
    LambdaConfig: { PreSignUp: lambda?.preSignUp ?? lambda?.PreSignUp, CustomMessage: lambda?.customMessage ?? lambda?.CustomMessage },
  };
}

const NO_UNVERIFIED_SWEEP = (mode: string) =>
  `auth-kit: accountCreation mode '${mode}' lets people create accounts, and one never verified must be deleted after 24 hours (register D3). ` +
  'Add UnverifiedAccountSweep from auth-kit/admin/cdk for this pool (new UnverifiedAccountSweep(stack, "UnverifiedSweep", { userPool, auditLog })).';

const AMBIGUOUS_SWEEP = (path: string, what: string) =>
  `auth-kit: the UnverifiedAccountSweep at ${path} sweeps ${what}, so synthesis can't tell whether it sweeps this pool (register D3). ` +
  'Pass the pool itself, as Amplify gives it: new UnverifiedAccountSweep(stack, "UnverifiedSweep", { userPool: backend.auth.resources.userPool, auditLog }).';

/** Which pool one sweep sweeps, as far as synthesis can tell: this one, another, or it can't say (and why). */
type SweepTarget = 'this' | 'other' | { ambiguous: string };

const isRef = (value: unknown): value is { Ref: string } =>
  typeof value === 'object' && value !== null && Object.keys(value).length === 1 && typeof (value as { Ref?: unknown }).Ref === 'string';

/**
 * The pool an UnverifiedAccountSweep was given, matched against this one (L6): the L1 itself, the L2
 * whose resource it is, or an imported pool whose ID is this pool's own (`{ Ref }`) count. An L2 with
 * another resource is another pool. Anything synthesis can't tie to a pool (an imported pool with a
 * literal ID or one known only at deploy, a construct that isn't a pool) is ambiguous, never a match.
 */
function sweepTargetOf(pool: CfnUserPool, target: unknown): SweepTarget {
  if (target === pool) return 'this';
  if (typeof target !== 'object' || target === null || !('node' in target)) return { ambiguous: "something that isn't a CDK construct" };
  const child = (target as { node: { defaultChild?: unknown } }).node.defaultChild;
  if (child === pool) return 'this';
  if (child !== undefined) return 'other';
  // No resource of its own: an imported pool (`UserPool.fromUserPoolId` / `fromUserPoolArn`), or not a pool at all.
  const id = (target as { userPoolId?: unknown }).userPoolId;
  if (typeof id !== 'string') return { ambiguous: "a construct that isn't a user pool" };
  const stack = Stack.of(pool);
  const resolved: unknown = stack.resolve(id);
  if (JSON.stringify(resolved) === JSON.stringify(stack.resolve(pool.ref))) return 'this';
  if (isRef(resolved)) return 'other';
  return {
    ambiguous: typeof resolved === 'string' ? `an imported pool with a fixed ID (${resolved})` : 'an imported pool whose ID is known only at deploy',
  };
}

/** Why this pool has no sweep synthesis can tie to it, or `[]` when one sweeps it. */
function unverifiedSweepProblems(pool: CfnUserPool, mode: string): string[] {
  const ambiguous: string[] = [];
  for (const c of pool.node.root.node.findAll()) {
    if (!isUnverifiedSweep(c)) continue;
    const target = sweepTargetOf(pool, c[UNVERIFIED_SWEEP_MARK].userPool);
    if (target === 'this') return [];
    if (target !== 'other') ambiguous.push(AMBIGUOUS_SWEEP(c.node.path, target.ambiguous));
  }
  return ambiguous.length > 0 ? ambiguous : [NO_UNVERIFIED_SWEEP(mode)];
}

const GATE_KEY = Object.keys(CUSTOM_MESSAGE_GATE_ENV)[0]!;
const GATE_VALUE = Object.values(CUSTOM_MESSAGE_GATE_ENV)[0]!;

/** A Lambda function construct (an L2 `Function`, or Amplify's `defineFunction` one) anywhere in the app. */
interface FunctionLike {
  functionArn: string;
  node: { defaultChild?: unknown; path: string };
}

function isFunctionLike(c: unknown): c is FunctionLike {
  const candidate = c as Partial<FunctionLike> | null;
  const child = candidate?.node?.defaultChild as { cfnResourceType?: unknown } | undefined;
  return typeof candidate?.functionArn === 'string' && child?.cfnResourceType === 'AWS::Lambda::Function';
}

/** The function's environment variables as they'll deploy. */
function environmentOf(fn: FunctionLike): Record<string, unknown> {
  const cfn = fn.node.defaultChild as { _toCloudFormation?: () => unknown; environment?: unknown };
  const stack = Stack.of(cfn as never);
  const render = cfn._toCloudFormation;
  if (typeof render === 'function') {
    const rendered = stack.resolve(render.call(cfn)) as { Resources?: Record<string, { Properties?: { Environment?: { Variables?: Record<string, unknown> } } }> };
    return Object.values(rendered.Resources ?? {})[0]?.Properties?.Environment?.Variables ?? {};
  }
  const env = stack.resolve(cfn.environment) as { variables?: Record<string, unknown>; Variables?: Record<string, unknown> } | undefined;
  return env?.variables ?? env?.Variables ?? {};
}

/**
 * Why the custom message trigger can't be trusted to refuse public-API email changes, or `[]`: its
 * function is found in the app (the one whose ARN, resolved in the pool's stack, is the trigger's)
 * and must carry `CUSTOM_MESSAGE_GATE_ENV`, the sign it's `customMessageHandler` or
 * `withAuthKitCustomMessage`.
 */
function customMessageGateProblems(stack: Stack, pool: CfnUserPool): string[] {
  const target = renderedPool(stack, pool).LambdaConfig?.CustomMessage;
  if (!target) return []; // Reported by the missing-trigger check.
  const wanted = JSON.stringify(target);
  const fn = stack.node.root.node.findAll().find((c): c is FunctionLike & typeof c => isFunctionLike(c) && JSON.stringify(stack.resolve(c.functionArn)) === wanted);
  if (!fn) {
    return [
      "auth-kit: can't find the function the custom message trigger runs in this app, so can't check it refuses public-API email changes (ADR 0023). " +
        'Wire a function defined in this app, built with customMessageHandler or withAuthKitCustomMessage from auth-kit/amplify/custom-message.',
    ];
  }
  return environmentOf(fn)[GATE_KEY] === GATE_VALUE
    ? []
    : [
        `auth-kit: the custom message trigger's function (${fn.node.path}) doesn't carry ${GATE_KEY}=${GATE_VALUE}. It's a security control (it refuses email changes made through ` +
          "Cognito's public API, ADR 0023): build it with customMessageHandler, or wrap your own wording with withAuthKitCustomMessage, and give the function " +
          'CUSTOM_MESSAGE_GATE_ENV as its environment.',
      ];
}

/** True when the pool's synthesized properties, overrides included, keep Cognito's own SignUp off. */
function signUpStaysOff(stack: Stack, pool: CfnUserPool): boolean {
  return renderedPool(stack, pool).AdminCreateUserConfig?.AllowAdminCreateUserOnly === true;
}

/** The callback URL CDK fills in when a client has OAuth on and no callback of its own. */
const CDK_PLACEHOLDER_CALLBACK = 'https://example.com';

const applied = new WeakSet<CfnUserPool>();

function environmentFor(
  userPool: IUserPool,
  deploymentType: AmplifyDeploymentType | undefined,
  configured: string | undefined,
): string {
  if (deploymentType === 'sandbox') return DEV_POLICY.sandboxTag.value;
  const branch = userPool.node.tryGetContext('amplify-backend-name') as unknown;
  const value =
    configured ??
    (deploymentType === 'branch' && typeof branch === 'string' && branch ? branch : (deploymentType ?? 'unspecified'));
  // Only a real Amplify sandbox may carry Environment=sandbox; the dev kit trusts that tag.
  return value === DEV_POLICY.sandboxTag.value ? `branch-${value}` : value;
}

/**
 * The pool's From header: `Name <address>`, with the name in double quotes when it holds an RFC 5322
 * special such as parentheses. Unquoted, `Example Site (NC OSBM)` would be read as the name
 * "Example Site" plus a comment, and mail clients may drop the comment. The options check refuses
 * `"`, a backslash, `<`, `>`, and line breaks, so quoting needs no escapes. A name with characters
 * outside ASCII is written as RFC 2047 encoded-words instead (never quoted), as SES requires.
 */
export function formatSender(name: string, address: string): string {
  // A name outside ASCII ("Café Reports"): RFC 2047 encoded-words, which SES (Cognito sends through it) requires.
  if (/[^\x20-\x7e]/.test(name)) return `${encodeSenderName(name)} <${address}>`;
  return /[()<>[\]:;@\\,.]/.test(name) ? `"${name}" <${address}>` : `${name} <${address}>`;
}

/**
 * Applies the settings `defineAuth` can't express. Call it once in `amplify/backend.ts`:
 *
 * ```ts
 * const backend = defineBackend({ auth, data });
 * applyAuthStandard(backend.auth, authOptions);
 * ```
 *
 * Each change is an L1 (`CfnUserPool` / `CfnUserPoolClient`) override, because Amplify's typed API
 * has no setting for it. Sandboxes (`amplify-backend-type` = `sandbox`) are tagged
 * `Environment=sandbox`, get `ALLOW_ADMIN_USER_PASSWORD_AUTH` for the dev kit's "Sign in as…",
 * skip deletion protection (so `ampx sandbox delete` works) and, by default, the billed web ACL.
 */
export function applyAuthStandard(auth: AuthResourceLike, options: AuthStandardOptions): AppliedAuthStandard {
  const o = normalizeOptions(options);
  const { userPool, cfnResources, groups } = auth.resources;
  const { cfnUserPool, cfnUserPoolClient, cfnIdentityPool } = cfnResources;

  if (applied.has(cfnUserPool)) throw new AuthStandardConfigError('applyAuthStandard was already applied to this pool.');
  applied.add(cfnUserPool);

  const deploymentType = userPool.node.tryGetContext(AMPLIFY_DEPLOYMENT_TYPE_CONTEXT_KEY) as
    | AmplifyDeploymentType
    | undefined;
  const isSandbox = deploymentType === 'sandbox';
  const stack = Stack.of(cfnUserPool);

  // The props must have come from standardAuthProps with the same options.
  for (const group of o.groups) {
    if (!groups[group]) {
      throw new AuthStandardConfigError(
        `group "${group}" is missing. Build defineAuth's props with standardAuthProps(sameOptions).`,
      );
    }
  }

  // ---- Identity and lifecycle -------------------------------------------------------------------
  // Cognito's own SignUp is always off (ADR 0023). Gen 2 leaves it on unless it's switched off here.
  // Every account is made on the server with AdminCreateUser: an admin's invite, or auth-kit's
  // sign-up route on a site whose accountCreation mode allows it. The app client ID is public, so a
  // SignUp left on would let anyone skip the domain list, the rate limits, and the bot check, and
  // would answer UsernameExistsException for an address that already has an account.
  cfnUserPool.addPropertyOverride('AdminCreateUserConfig.AllowAdminCreateUserOnly', true);
  cfnUserPool.node.addValidation({
    validate: () => (signUpStaysOff(stack, cfnUserPool) ? [] : [SIGN_UP_ENABLED]),
  });
  // The custom message trigger is a security control on every pool, not only wording: it refuses an
  // email change made through Cognito's public API (ADR 0023, H1). Synthesis fails without it.
  cfnUserPool.node.addValidation({
    validate: () => (renderedPool(stack, cfnUserPool).LambdaConfig?.CustomMessage ? customMessageGateProblems(stack, cfnUserPool) : [NO_CUSTOM_MESSAGE_TRIGGER]),
  });
  if (allowsSelfSignUp(o.accountCreation)) {
    // Register D3: accounts made by sign-up and never verified are deleted after 24 hours. Cognito
    // doesn't do it, so a sign-up site must deploy UnverifiedAccountSweep for this pool.
    cfnUserPool.node.addValidation({
      validate: () => unverifiedSweepProblems(cfnUserPool, o.accountCreation.mode),
    });
  }
  if (o.accountCreation.mode === 'domains') {
    cfnUserPool.node.addValidation({
      validate: () => {
        return renderedPool(stack, cfnUserPool).LambdaConfig?.PreSignUp
          ? []
          : [
              "auth-kit: accountCreation mode 'domains' needs the preSignUp trigger, which re-checks the domain list on accounts the sign-up route creates " +
                '(triggers: { preSignUp }, built with preSignUpForAccountCreation from auth-kit/amplify/pre-sign-up).',
            ];
      },
    });
  }

  // An email change takes effect only once the new address is verified; until then the old address
  // keeps working (D4; members change their own address on sign-up sites).
  cfnUserPool.userAttributeUpdateSettings = { attributesRequireVerificationBeforeUpdate: ['email'] };

  const deletionProtection = isSandbox && !o.deletionProtectionInSandbox ? 'INACTIVE' : 'ACTIVE';
  cfnUserPool.deletionProtection = deletionProtection;

  // ---- Sign-in ----------------------------------------------------------------------------------
  // Feature plan: Essentials is the minimum for choice-based sign-in, emailed codes, and passkeys.
  // Plus adds threat protection (sign-in event logs, compromised-credential checks).
  const userPoolTier = o.threatProtection === 'off' ? 'ESSENTIALS' : 'PLUS';
  cfnUserPool.userPoolTier = userPoolTier;
  if (o.threatProtection !== 'off') {
    cfnUserPool.userPoolAddOns = { advancedSecurityMode: o.threatProtection === 'enforced' ? 'ENFORCED' : 'AUDIT' };
  }

  // Best first: passkey; password (+ authenticator code, required by the app); emailed code as backstop.
  // Admin pools: no emailed codes. PASSWORD stays allowed there because a new admin has to sign in once
  // (with a one-time password and a TOTP enrollment) before Cognito lets them register a passkey.
  const allowedFirstAuthFactors = [
    ...(o.passkeys ? ['WEB_AUTHN'] : []),
    'PASSWORD',
    ...(o.adminPool ? [] : ['EMAIL_OTP']),
  ];
  cfnUserPool.policies = {
    passwordPolicy: { ...PASSWORD_POLICY },
    signInPolicy: { allowedFirstAuthFactors },
  };

  // MFA is set once per pool. OPTIONAL with TOTP for everyday pools; ON for admin pools.
  const mfaConfiguration = o.adminPool ? 'ON' : 'OPTIONAL';
  cfnUserPool.mfaConfiguration = mfaConfiguration;
  cfnUserPool.enabledMfas = ['SOFTWARE_TOKEN_MFA'];

  let relyingPartyId: string | null = null;
  if (o.passkeys) {
    relyingPartyId = isSandbox ? o.passkeys.sandboxRelyingPartyId : o.passkeys.relyingPartyId;
    cfnUserPool.webAuthnRelyingPartyId = relyingPartyId;
    cfnUserPool.webAuthnUserVerification = 'required';
    // A user-verified passkey counts as MFA. Set through a raw override so it works on every
    // aws-cdk-lib version Amplify accepts (older L1s lack the typed property).
    cfnUserPool.addPropertyOverride('WebAuthnFactorConfiguration', 'MULTI_FACTOR_WITH_USER_VERIFICATION');
  }

  // Admin pools recover through an admin only; everyday pools by verified email.
  cfnUserPool.accountRecoverySetting = {
    recoveryMechanisms: o.adminPool ? [{ name: 'admin_only', priority: 1 }] : [{ name: 'verified_email', priority: 1 }],
  };

  // SES from a verified domain identity. Amplify's senders.email derives an address identity from
  // fromEmail; most accounts verify the domain, which authorizes every address under it.
  cfnUserPool.emailConfiguration = {
    emailSendingAccount: 'DEVELOPER',
    sourceArn: stack.formatArn({
      service: 'ses',
      resource: 'identity',
      resourceName: o.email.sesIdentity,
      arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
    }),
    from: formatSender(o.email.fromName, o.email.fromAddress),
    replyToEmailAddress: o.email.replyTo,
    ...(o.email.configurationSet !== undefined && { configurationSet: o.email.configurationSet }),
  };

  // ---- App client and sessions ------------------------------------------------------------------
  // ALLOW_USER_AUTH covers passkeys, passwords (plain and SRP), and emailed codes; nothing else is
  // needed. ADMIN_USER_PASSWORD_AUTH exists only on sandbox clients, for "Sign in as…".
  const explicitAuthFlows = [
    'ALLOW_USER_AUTH',
    'ALLOW_REFRESH_TOKEN_AUTH',
    ...(isSandbox ? ['ALLOW_ADMIN_USER_PASSWORD_AUTH'] : []),
  ];
  cfnUserPoolClient.explicitAuthFlows = explicitAuthFlows;
  cfnUserPoolClient.preventUserExistenceErrors = 'ENABLED';
  cfnUserPoolClient.enableTokenRevocation = true;
  cfnUserPoolClient.accessTokenValidity = SESSION_POLICY.accessTokenMinutes;
  cfnUserPoolClient.idTokenValidity = SESSION_POLICY.idTokenMinutes;
  cfnUserPoolClient.refreshTokenValidity = o.refreshTokenMinutes;
  cfnUserPoolClient.tokenValidityUnits = { accessToken: 'minutes', idToken: 'minutes', refreshToken: 'minutes' };
  // The sign-in session is also an emailed code's lifetime (register A7): one setting, also passed to the screens.
  cfnUserPoolClient.authSessionValidity = o.codeLifetimeMinutes;

  // Sign-in happens in the app (USER_AUTH), not through the hosted UI's OAuth redirect. Amplify still
  // turns the authorization-code flow on, and CDK fills in its placeholder callback
  // (`https://example.com`), which would become a live redirect target the moment the pool gets a
  // managed-login domain. So OAuth is switched off unless the site configured real callback URLs
  // (`loginWith.externalProviders` in its own defineAuth call); the placeholder is never kept.
  const configuredCallbacks = stack.resolve(cfnUserPoolClient.callbackUrLs) as unknown;
  const realCallbacks = Array.isArray(configuredCallbacks)
    ? configuredCallbacks.filter((url): url is string => typeof url === 'string' && url !== CDK_PLACEHOLDER_CALLBACK)
    : [];
  const hostedUiOAuth = realCallbacks.length > 0;
  if (hostedUiOAuth) {
    cfnUserPoolClient.callbackUrLs = realCallbacks;
  } else {
    cfnUserPoolClient.allowedOAuthFlowsUserPoolClient = false;
    cfnUserPoolClient.allowedOAuthFlows = undefined;
    cfnUserPoolClient.allowedOAuthScopes = undefined;
    cfnUserPoolClient.callbackUrLs = undefined;
    cfnUserPoolClient.logoutUrLs = undefined;
    cfnUserPoolClient.defaultRedirectUri = undefined;
  }

  // No guest AWS credentials unless the app asks for them.
  cfnIdentityPool.allowUnauthenticatedIdentities = o.guestAccess;

  // ---- Tags -------------------------------------------------------------------------------------
  const tags: Record<string, string> = {
    Project: o.project,
    Owner: o.owner,
    Environment: environmentFor(userPool, deploymentType, o.environment),
    Tier: String(o.tier),
    PoolRole: o.adminPool ? 'admin' : 'user',
    ManagedBy: 'auth-kit',
  };
  for (const [key, value] of Object.entries(tags)) Tags.of(stack).add(key, value);

  // ---- WAF --------------------------------------------------------------------------------------
  // One shared web ACL per account and Region (register F7, ADR 0013): a deployed branch reuses it
  // (`waf: { webAclArn }`); a pool's own ACL is for sandboxes, or deliberate (`waf: { ownWebAcl: true }`).
  let waf: AppliedWaf = { mode: 'none', webAcl: null, webAclArn: null, association: null };
  const wafWanted = o.waf.mode !== 'off' && (!isSandbox || o.waf.enabledInSandbox);
  if (o.waf.mode === 'create' && !isSandbox && !o.waf.ownWebAcl) {
    throw new AuthStandardConfigError(
      'a deployed pool reuses the account\'s shared web ACL (register F7, ADR 0013): waf: { webAclArn } from createSharedAuthWebAcl. ' +
        'For a site alone in its account, or the first one before the shared ACL exists, say so with waf: { ownWebAcl: true }.',
    );
  }
  if (wafWanted && o.waf.mode === 'create') {
    const created = createAuthWebAcl(stack, 'AuthKitWebAcl', { userPoolArn: userPool.userPoolArn, project: o.project, waf: o.waf });
    waf = { mode: 'created', webAcl: created.webAcl, webAclArn: created.webAcl.attrArn, association: created.association };
  } else if (wafWanted && o.waf.mode === 'shared') {
    const arnRegion = webAclArnRegion(o.waf.webAclArn);
    if (arnRegion !== undefined && !Token.isUnresolved(stack.region) && arnRegion !== stack.region) {
      throw new AuthStandardConfigError(
        `waf.webAclArn is in ${arnRegion} but the pool is in ${stack.region}; a web ACL protects resources in its own Region only.`,
      );
    }
    const association = associateAuthWebAcl(stack, 'AuthKitWebAclAssociation', {
      userPoolArn: userPool.userPoolArn,
      webAclArn: o.waf.webAclArn,
    });
    waf = { mode: 'shared', webAcl: null, webAclArn: o.waf.webAclArn, association };
  }
  if (o.waf.mode === 'off' && !isSandbox) {
    Annotations.of(userPool).addWarningV2(
      'auth-kit:no-waf',
      'This pool has no WAF rate rule (acknowledgeNoRateLimit): Cognito does not lock out wrong emailed codes.',
    );
  }

  return {
    deploymentType,
    isSandbox,
    environment: tags.Environment ?? '',
    relyingPartyId,
    allowedFirstAuthFactors,
    explicitAuthFlows,
    mfaConfiguration,
    deletionProtection,
    userPoolTier,
    tags,
    waf,
    hostedUiOAuth,
    codeLifetimeMinutes: o.codeLifetimeMinutes,
    siteWebAclArn: o.siteWebAclArn,
  };
}
