import { Annotations, ArnFormat, Stack, Tags } from 'aws-cdk-lib';
import type { CfnIdentityPool, CfnUserPool, CfnUserPoolClient, CfnUserPoolGroup, IUserPool } from 'aws-cdk-lib/aws-cognito';
import {
  AMPLIFY_DEPLOYMENT_TYPE_CONTEXT_KEY,
  type AmplifyDeploymentType,
  DEV_POLICY,
  PASSWORD_POLICY,
  SESSION_POLICY,
} from '../shared/policy.js';
import { type AuthStandardOptions, AuthStandardConfigError, normalizeOptions } from './options.js';
import { type AuthWebAcl, createAuthWebAcl } from './waf.js';

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
  webAcl: AuthWebAcl | null;
  /** True only when the site configured real OAuth callback URLs (hosted-UI / federated sign-in). */
  hostedUiOAuth: boolean;
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
  // Invite-only: Gen 2 leaves self-registration on unless it's switched off here. The exception is a
  // documented preSignUp domain allowlist, checked at synth.
  cfnUserPool.addPropertyOverride('AdminCreateUserConfig.AllowAdminCreateUserOnly', o.selfSignUp === null);
  if (o.selfSignUp) {
    cfnUserPool.node.addValidation({
      validate: () => {
        const lambdaConfig = stack.resolve(cfnUserPool.lambdaConfig) as { PreSignUp?: unknown; preSignUp?: unknown } | undefined;
        return lambdaConfig?.PreSignUp || lambdaConfig?.preSignUp
          ? []
          : ['auth-kit: selfSignUp needs the preSignUp allowlist trigger (triggers: { preSignUp }).'];
      },
    });
  }

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
    from: `${o.email.fromName} <${o.email.fromAddress}>`,
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
  cfnUserPoolClient.authSessionValidity = SESSION_POLICY.authSessionMinutes;

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
  const wafWanted = isSandbox ? o.waf.enabledInSandbox : o.waf.enabled;
  const webAcl = wafWanted
    ? createAuthWebAcl(stack, 'AuthKitWebAcl', { userPoolArn: userPool.userPoolArn, project: o.project, waf: o.waf })
    : null;
  if (!wafWanted && !isSandbox) {
    Annotations.of(userPool).addWarningV2(
      'auth-kit:no-waf',
      'The standard requires a WAF rate rule on every user pool: Cognito does not lock out wrong emailed codes.',
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
    webAcl,
    hostedUiOAuth,
  };
}
