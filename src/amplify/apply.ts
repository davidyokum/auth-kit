import { Annotations, ArnFormat, Stack, Tags, Token } from 'aws-cdk-lib';
import type { CfnIdentityPool, CfnUserPool, CfnUserPoolClient, CfnUserPoolGroup, IUserPool } from 'aws-cdk-lib/aws-cognito';
import type { CfnWebACL, CfnWebACLAssociation } from 'aws-cdk-lib/aws-wafv2';
import { SIGN_UP_ORIGIN_ATTRIBUTE } from '../shared/account-creation.js';
import {
  AMPLIFY_DEPLOYMENT_TYPE_CONTEXT_KEY,
  type AmplifyDeploymentType,
  DEV_POLICY,
  PASSWORD_POLICY,
  SESSION_POLICY,
} from '../shared/policy.js';
import { type AuthStandardOptions, AuthStandardConfigError, normalizeOptions, webAclArnRegion } from './options.js';
import { associateAuthWebAcl, createAuthWebAcl } from './waf.js';

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
  /** What the app client lets people change about themselves (never `email`). */
  writeAttributes: string[];
  /** True only when the site configured real OAuth callback URLs (hosted-UI / federated sign-in). */
  hostedUiOAuth: boolean;
}

const SIGN_UP_ENABLED =
  "auth-kit: Cognito's own SignUp is on for this pool (AdminCreateUserConfig.AllowAdminCreateUserOnly isn't true in the template). " +
  "auth-kit keeps it off in every accountCreation mode (ADR 0023): sign-up is a server route that creates the account like an invite. Remove whatever turns it back on.";

/**
 * True when the pool's synthesized properties, overrides included, keep Cognito's own SignUp off.
 * Reads the rendered resource (`_toCloudFormation`, which applies every override), so a later
 * override or property set anywhere in the app is caught at synth.
 */
function signUpStaysOff(stack: Stack, pool: CfnUserPool): boolean {
  const render = (pool as unknown as { _toCloudFormation?: () => unknown })._toCloudFormation;
  if (typeof render === 'function') {
    const rendered = stack.resolve(render.call(pool)) as { Resources?: Record<string, { Properties?: { AdminCreateUserConfig?: { AllowAdminCreateUserOnly?: unknown } } }> };
    const resource = Object.values(rendered.Resources ?? {})[0];
    return resource?.Properties?.AdminCreateUserConfig?.AllowAdminCreateUserOnly === true;
  }
  const config = stack.resolve(pool.adminCreateUserConfig) as { allowAdminCreateUserOnly?: unknown; AllowAdminCreateUserOnly?: unknown } | undefined;
  return config?.allowAdminCreateUserOnly === true || config?.AllowAdminCreateUserOnly === true;
}

/**
 * Standard attributes a person may set on their own account. Not `email` (changed by the server or
 * an admin, then verified), `phone_number`, or `preferred_username` (a sign-in alias in some pools).
 */
export const CLIENT_WRITABLE_STANDARD_ATTRIBUTES = [
  'name',
  'given_name',
  'family_name',
  'middle_name',
  'nickname',
  'profile',
  'picture',
  'website',
  'gender',
  'birthdate',
  'zoneinfo',
  'locale',
  'address',
  'updated_at',
] as const;

/** The standard ones above, plus the pool's own mutable custom attributes (never auth-kit's sign-up mark). */
function clientWriteAttributes(stack: Stack, pool: CfnUserPool): string[] {
  const schema = (stack.resolve(pool.schema) as { name?: string; Name?: string; mutable?: boolean; Mutable?: boolean }[] | undefined) ?? [];
  const custom = schema
    .map((a) => ({ name: a.name ?? a.Name ?? '', mutable: a.mutable ?? a.Mutable ?? true }))
    .filter((a) => a.name !== '' && a.mutable !== false && !(STANDARD_ATTRIBUTE_NAMES as readonly string[]).includes(a.name))
    .map((a) => (a.name.startsWith('custom:') ? a.name : `custom:${a.name}`))
    .filter((name) => name !== SIGN_UP_ORIGIN_ATTRIBUTE);
  return [...CLIENT_WRITABLE_STANDARD_ATTRIBUTES, ...custom];
}

/** Cognito's standard attribute names (custom attributes are everything else in the schema). */
const STANDARD_ATTRIBUTE_NAMES = [
  ...CLIENT_WRITABLE_STANDARD_ATTRIBUTES,
  'email',
  'email_verified',
  'phone_number',
  'phone_number_verified',
  'preferred_username',
  'sub',
] as const;

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
 * `"`, a backslash, `<`, `>`, and line breaks, so quoting needs no escapes.
 */
export function formatSender(name: string, address: string): string {
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
  if (o.accountCreation.mode === 'domains') {
    cfnUserPool.node.addValidation({
      validate: () => {
        const lambdaConfig = stack.resolve(cfnUserPool.lambdaConfig) as { PreSignUp?: unknown; preSignUp?: unknown } | undefined;
        return lambdaConfig?.PreSignUp || lambdaConfig?.preSignUp
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
    ...(o.email.replyTo !== undefined && { replyToEmailAddress: o.email.replyTo }),
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
  // What a signed-in person may change about themselves with their own token: their name and profile
  // details, never their email address (on sign-up sites the server changes it after a recent sign-in,
  // D4; elsewhere admins do), nor auth-kit's sign-up mark.
  const writeAttributes = clientWriteAttributes(stack, cfnUserPool);
  cfnUserPoolClient.writeAttributes = writeAttributes;

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
  // One web ACL per pool by default, or a shared one per account and Region (ADR 0013).
  let waf: AppliedWaf = { mode: 'none', webAcl: null, webAclArn: null, association: null };
  const wafWanted = o.waf.mode !== 'off' && (!isSandbox || o.waf.enabledInSandbox);
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
    writeAttributes,
  };
}
