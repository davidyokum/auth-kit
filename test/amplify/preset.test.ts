import { AmplifyAuth, type AuthProps } from '@aws-amplify/auth-construct';
import { App, Fn, Stack } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { UserPoolOperation, type UserPool } from 'aws-cdk-lib/aws-cognito';
import { Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { describe, expect, it } from 'vitest';
import {
  type AuthStandardOptions,
  AuthStandardConfigError,
  applyAuthStandard,
  createSharedAuthWebAcl,
  formatSender,
  normalizeOptions,
  SIGN_IN_OPERATIONS,
  standardAuthProps,
} from '../../src/amplify/index.js';

const BASE: AuthStandardOptions = {
  project: 'example-reports',
  owner: 'reports-team',
  tier: 2,
  email: { fromAddress: 'noreply@example.org', fromName: 'Example Reports', replyTo: 'help@example.org' },
  passkeys: { relyingPartyId: 'reports.example.org' },
  appRoles: ['reviewer'],
};

/** `none` = plain CDK, no Amplify context. */
type DeploymentType = 'branch' | 'sandbox' | 'standalone' | 'none';

function synth(
  options: AuthStandardOptions,
  { type = 'branch', branch = 'main', beforeApply }: { type?: DeploymentType; branch?: string; beforeApply?: (auth: AmplifyAuth, stack: Stack) => void } = {},
) {
  const context: Record<string, string> = {};
  if (type !== 'none') context['amplify-backend-type'] = type;
  if (type === 'branch') Object.assign(context, { 'amplify-backend-name': branch, 'amplify-backend-namespace': 'dexampleapp' });
  if (type === 'sandbox') Object.assign(context, { 'amplify-backend-name': 'dev', 'amplify-backend-namespace': 'sandboxns' });
  const app = new App({ context });
  const stack = new Stack(app, 'AuthStack');
  const auth = new AmplifyAuth(stack, 'auth', standardAuthProps(options) as unknown as AuthProps);
  beforeApply?.(auth, stack);
  const applied = applyAuthStandard(auth, options);
  return { app, stack, auth, applied, template: () => Template.fromStack(stack) };
}

describe('Tier 2 pool on a branch', () => {
  const { template, applied } = synth(BASE);
  const t = template();

  it('is invite-only, deletion-protected, and on the Essentials plan', () => {
    t.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: Match.objectLike({ AllowAdminCreateUserOnly: true }),
      DeletionProtection: 'ACTIVE',
      UserPoolTier: 'ESSENTIALS',
      UsernameAttributes: ['email'],
      UsernameConfiguration: { CaseSensitive: false },
    });
  });

  it('offers passkey, password, and emailed code as first factors, with MFA optional (TOTP only)', () => {
    t.hasResourceProperties('AWS::Cognito::UserPool', {
      Policies: {
        PasswordPolicy: {
          MinimumLength: 15,
          RequireLowercase: false,
          RequireUppercase: false,
          RequireNumbers: false,
          RequireSymbols: false,
          TemporaryPasswordValidityDays: 7,
        },
        SignInPolicy: { AllowedFirstAuthFactors: ['WEB_AUTHN', 'PASSWORD', 'EMAIL_OTP'] },
      },
      MfaConfiguration: 'OPTIONAL',
      EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
    });
  });

  it('binds passkeys to the final domain, requires user verification, and counts them as MFA', () => {
    t.hasResourceProperties('AWS::Cognito::UserPool', {
      WebAuthnRelyingPartyID: 'reports.example.org',
      WebAuthnUserVerification: 'required',
      WebAuthnFactorConfiguration: 'MULTI_FACTOR_WITH_USER_VERIFICATION',
    });
  });

  it('recovers by verified email and sends through SES from the verified domain identity', () => {
    t.hasResourceProperties('AWS::Cognito::UserPool', {
      AccountRecoverySetting: { RecoveryMechanisms: [{ Name: 'verified_email', Priority: 1 }] },
      EmailConfiguration: {
        EmailSendingAccount: 'DEVELOPER',
        From: 'Example Reports <noreply@example.org>',
        ReplyToEmailAddress: 'help@example.org',
        SourceArn: {
          'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':ses:', { Ref: 'AWS::Region' }, ':', { Ref: 'AWS::AccountId' }, ':identity/example.org']],
        },
      },
    });
  });

  it('quotes a sender name with RFC 5322 specials, so "(NC OSBM)" stays part of the name, not a comment', () => {
    expect(formatSender('Example Reports', 'noreply@example.org')).toBe('Example Reports <noreply@example.org>');
    expect(formatSender('Example Site (NC OSBM)', 'sign-in@example.org')).toBe('"Example Site (NC OSBM)" <sign-in@example.org>');
    expect(formatSender('Example Site (UNC)', 'sign-in@example.org')).toBe('"Example Site (UNC)" <sign-in@example.org>');
    expect(formatSender('Reports, Example', 'a@example.org')).toBe('"Reports, Example" <a@example.org>');
    const quoted = synth({ ...BASE, email: { ...BASE.email, fromName: 'Example Site (UNC)' } }).template();
    quoted.hasResourceProperties('AWS::Cognito::UserPool', { EmailConfiguration: Match.objectLike({ From: '"Example Site (UNC)" <noreply@example.org>' }) });
    expect(() => normalizeOptions({ ...BASE, email: { ...BASE.email, fromName: 'Back\\slash' } })).toThrow(/fromName/);
  });

  it('keeps an old email until a new one is verified (Amplify keepOriginal)', () => {
    t.hasResourceProperties('AWS::Cognito::UserPool', {
      UserAttributeUpdateSettings: { AttributesRequireVerificationBeforeUpdate: ['email'] },
    });
  });

  it('tags the pool Project / Owner / Environment / Tier', () => {
    t.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolTags: {
        Project: 'example-reports',
        Owner: 'reports-team',
        Environment: 'main',
        Tier: '2',
        PoolRole: 'user',
        ManagedBy: 'auth-kit',
      },
    });
  });

  it('configures the app client: choice-based sign-in only, existence errors hidden, revocation on, standard lifetimes', () => {
    t.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ExplicitAuthFlows: ['ALLOW_USER_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
      PreventUserExistenceErrors: 'ENABLED',
      EnableTokenRevocation: true,
      AccessTokenValidity: 60,
      IdTokenValidity: 60,
      RefreshTokenValidity: 43200,
      TokenValidityUnits: { AccessToken: 'minutes', IdToken: 'minutes', RefreshToken: 'minutes' },
      AuthSessionValidity: 3,
    });
  });

  it('turns the hosted-UI OAuth flow off and ships no placeholder callback URL', () => {
    const client = Object.values(t.findResources('AWS::Cognito::UserPoolClient'))[0] as { Properties: Record<string, unknown> };
    expect(client.Properties.AllowedOAuthFlowsUserPoolClient).toBe(false);
    for (const key of ['AllowedOAuthFlows', 'AllowedOAuthScopes', 'CallbackURLs', 'LogoutURLs', 'DefaultRedirectURI']) {
      expect(client.Properties, key).not.toHaveProperty(key);
    }
    expect(JSON.stringify(t.toJSON())).not.toContain('https://example.com');
    expect(applied.hostedUiOAuth).toBe(false);
  });

  it('has no admin password flow outside a sandbox', () => {
    const client = Object.values(t.findResources('AWS::Cognito::UserPoolClient'))[0] as { Properties: { ExplicitAuthFlows: string[] } };
    expect(client.Properties.ExplicitAuthFlows).not.toContain('ALLOW_ADMIN_USER_PASSWORD_AUTH');
    expect(client.Properties.ExplicitAuthFlows).not.toContain('ALLOW_USER_SRP_AUTH');
    expect(client.Properties.ExplicitAuthFlows).not.toContain('ALLOW_CUSTOM_AUTH');
  });

  it('gives out no guest AWS credentials', () => {
    t.hasResourceProperties('AWS::Cognito::IdentityPool', { AllowUnauthenticatedIdentities: false });
  });

  it('creates the standard groups in precedence order, then app roles', () => {
    const groups = Object.values(t.findResources('AWS::Cognito::UserPoolGroup')).map(
      (g) => (g as { Properties: { GroupName: string; Precedence: number } }).Properties,
    );
    expect(groups.map((g) => [g.GroupName, g.Precedence])).toEqual([
      ['owner', 0],
      ['superadmin', 1],
      ['admin-content-people', 2],
      ['admin-content', 3],
      ['admin-view', 4],
      ['reviewer', 5],
    ]);
  });

  it('attaches a WAF web ACL with per-IP sign-in and overall rate rules', () => {
    t.resourceCountIs('AWS::WAFv2::WebACL', 1);
    t.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'REGIONAL',
      DefaultAction: { Allow: {} },
      Rules: [
        Match.objectLike({
          Name: 'auth-kit-sign-in-attempts-per-ip',
          Priority: 0,
          Action: { Count: {} }, // counts first by default (ADR 0017)
          Statement: {
            RateBasedStatement: Match.objectLike({
              AggregateKeyType: 'IP',
              Limit: 100,
              EvaluationWindowSec: 300,
              ScopeDownStatement: {
                OrStatement: {
                  Statements: Match.arrayWith([
                    {
                      ByteMatchStatement: {
                        FieldToMatch: { SingleHeader: { Name: 'x-amzn-cognito-operation-name' } },
                        PositionalConstraint: 'CONTAINS',
                        SearchString: 'respondtoauthchallenge',
                        TextTransformations: [{ Priority: 0, Type: 'LOWERCASE' }],
                      },
                    },
                  ]),
                },
              },
            }),
          },
        }),
        Match.objectLike({
          Name: 'auth-kit-requests-per-ip',
          Priority: 1,
          Statement: { RateBasedStatement: { AggregateKeyType: 'IP', Limit: 1000, EvaluationWindowSec: 300 } },
        }),
      ],
    });
    t.hasResourceProperties('AWS::WAFv2::WebACLAssociation', {
      ResourceArn: { 'Fn::GetAtt': [Match.stringLikeRegexp('^authUserPool'), 'Arn'] },
      WebACLArn: { 'Fn::GetAtt': [Match.stringLikeRegexp('^AuthKitWebAcl'), 'Arn'] },
    });
  });

  it('reports what it decided', () => {
    expect(applied).toMatchObject({
      deploymentType: 'branch',
      isSandbox: false,
      environment: 'main',
      relyingPartyId: 'reports.example.org',
      mfaConfiguration: 'OPTIONAL',
      deletionProtection: 'ACTIVE',
      userPoolTier: 'ESSENTIALS',
    });
    expect(applied.waf.mode).toBe('created');
    expect(applied.waf.webAcl).not.toBeNull();
  });

  it('matches the template snapshot', () => {
    const keep = new Set([
      'AWS::Cognito::UserPool',
      'AWS::Cognito::UserPoolClient',
      'AWS::Cognito::UserPoolGroup',
      'AWS::Cognito::IdentityPool',
      'AWS::WAFv2::WebACL',
      'AWS::WAFv2::WebACLAssociation',
    ]);
    const resources = Object.fromEntries(
      Object.entries(t.toJSON().Resources as Record<string, { Type: string }>).filter(([, r]) => keep.has(r.Type)),
    );
    expect(resources).toMatchSnapshot();
  });
});

describe('hosted-UI OAuth opt-in', () => {
  it('keeps OAuth only when the site configured real callback URLs, and drops the placeholder', () => {
    const { template, applied } = synth(BASE, {
      beforeApply: (auth) => {
        auth.resources.cfnResources.cfnUserPoolClient.callbackUrLs = ['https://example.com', 'https://reports.example.org/auth/callback'];
      },
    });
    expect(applied.hostedUiOAuth).toBe(true);
    template().hasResourceProperties('AWS::Cognito::UserPoolClient', {
      AllowedOAuthFlowsUserPoolClient: true,
      CallbackURLs: ['https://reports.example.org/auth/callback'],
    });
  });
});

describe('without passkeys (before the final domain is live)', () => {
  it('offers password and emailed code only, with no WebAuthn settings', () => {
    const t = synth({ ...BASE, passkeys: false }).template();
    t.hasResourceProperties('AWS::Cognito::UserPool', {
      Policies: Match.objectLike({ SignInPolicy: { AllowedFirstAuthFactors: ['PASSWORD', 'EMAIL_OTP'] } }),
      WebAuthnRelyingPartyID: Match.absent(),
      WebAuthnFactorConfiguration: Match.absent(),
    });
  });
});

describe('Amplify sandbox', () => {
  const { template, applied } = synth(BASE, { type: 'sandbox' });
  const t = template();

  it('is tagged Environment=sandbox and adds ADMIN_USER_PASSWORD_AUTH for the dev kit', () => {
    t.hasResourceProperties('AWS::Cognito::UserPool', { UserPoolTags: Match.objectLike({ Environment: 'sandbox' }) });
    t.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ExplicitAuthFlows: ['ALLOW_USER_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH', 'ALLOW_ADMIN_USER_PASSWORD_AUTH'],
    });
  });

  it('can be deleted, uses a localhost relying party, and skips the billed web ACL', () => {
    t.hasResourceProperties('AWS::Cognito::UserPool', { DeletionProtection: 'INACTIVE', WebAuthnRelyingPartyID: 'localhost' });
    t.resourceCountIs('AWS::WAFv2::WebACL', 0);
    expect(applied).toMatchObject({ isSandbox: true, environment: 'sandbox', relyingPartyId: 'localhost' });
  });

  it('honors a custom sandbox relying party, sandbox WAF, and sandbox deletion protection', () => {
    const t2 = synth(
      {
        ...BASE,
        passkeys: { relyingPartyId: 'reports.example.org', sandboxRelyingPartyId: 'reports.localhost' },
        waf: { enabledInSandbox: true },
        deletionProtectionInSandbox: true,
      },
      { type: 'sandbox' },
    ).template();
    t2.hasResourceProperties('AWS::Cognito::UserPool', { WebAuthnRelyingPartyID: 'reports.localhost', DeletionProtection: 'ACTIVE' });
    t2.resourceCountIs('AWS::WAFv2::WebACL', 1);
  });
});

describe('environment tag', () => {
  it('never marks a branch named "sandbox" as a sandbox', () => {
    const { applied, template } = synth(BASE, { branch: 'sandbox' });
    expect(applied.environment).toBe('branch-sandbox');
    template().hasResourceProperties('AWS::Cognito::UserPoolClient', { ExplicitAuthFlows: ['ALLOW_USER_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'] });
  });

  it('uses a configured environment name, and treats standalone and plain CDK as production-like', () => {
    expect(synth({ ...BASE, environment: 'production' }).applied.environment).toBe('production');
    const standalone = synth(BASE, { type: 'standalone' });
    expect(standalone.applied).toMatchObject({ isSandbox: false, environment: 'standalone', deletionProtection: 'ACTIVE' });
    const plain = synth(BASE, { type: 'none' });
    expect(plain.applied).toMatchObject({ isSandbox: false, environment: 'unspecified' });
    plain.template().hasResourceProperties('AWS::Cognito::UserPool', { WebAuthnRelyingPartyID: 'reports.example.org' });
  });
});

describe('Tier 3', () => {
  it('limits refresh tokens to a day and turns on threat protection (Plus) in audit mode', () => {
    const { template, applied } = synth({ ...BASE, tier: 3 });
    const t = template();
    t.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolTier: 'PLUS',
      UserPoolAddOns: { AdvancedSecurityMode: 'AUDIT' },
      UserPoolTags: Match.objectLike({ Tier: '3' }),
    });
    t.hasResourceProperties('AWS::Cognito::UserPoolClient', { RefreshTokenValidity: 1440 });
    expect(applied.userPoolTier).toBe('PLUS');
  });

  it('allows enforced threat protection and shorter refresh tokens', () => {
    const t = synth({ ...BASE, tier: 3, threatProtection: 'enforced', refreshTokenMinutes: 720 }).template();
    t.hasResourceProperties('AWS::Cognito::UserPool', { UserPoolAddOns: { AdvancedSecurityMode: 'ENFORCED' } });
    t.hasResourceProperties('AWS::Cognito::UserPoolClient', { RefreshTokenValidity: 720 });
  });
});

describe('admin pool', () => {
  const options: AuthStandardOptions = { ...BASE, adminPool: true, tier: 3, appRoles: [] };

  it('requires MFA, takes no emailed codes, recovers through an admin only, and keeps sessions short', () => {
    const { template, applied } = synth(options);
    const t = template();
    t.hasResourceProperties('AWS::Cognito::UserPool', {
      MfaConfiguration: 'ON',
      EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
      Policies: Match.objectLike({ SignInPolicy: { AllowedFirstAuthFactors: ['WEB_AUTHN', 'PASSWORD'] } }),
      WebAuthnFactorConfiguration: 'MULTI_FACTOR_WITH_USER_VERIFICATION',
      WebAuthnUserVerification: 'required',
      AccountRecoverySetting: { RecoveryMechanisms: [{ Name: 'admin_only', Priority: 1 }] },
      UserPoolTags: Match.objectLike({ PoolRole: 'admin' }),
    });
    t.hasResourceProperties('AWS::Cognito::UserPoolClient', { RefreshTokenValidity: 1440 });
    expect(applied.mfaConfiguration).toBe('ON');
  });

  it("builds defineAuth props Amplify accepts: no emailed codes, and MFA set OPTIONAL there (it's raised to ON in the L1 override)", () => {
    const props = standardAuthProps(options);
    expect(props.loginWith.email).toMatchObject({ otpLogin: false });
    expect(props.multifactor).toEqual({ mode: 'OPTIONAL', totp: true });
    expect(props.accountRecovery).toBe('NONE');
  });

  it('uses MFA REQUIRED directly when it has no passkeys yet', () => {
    const props = standardAuthProps({ ...options, passkeys: false });
    expect(props.multifactor).toEqual({ mode: 'REQUIRED', totp: true });
    const t = synth({ ...options, passkeys: false }).template();
    t.hasResourceProperties('AWS::Cognito::UserPool', {
      MfaConfiguration: 'ON',
      Policies: Match.objectLike({ SignInPolicy: { AllowedFirstAuthFactors: ['PASSWORD'] } }),
    });
  });

  it('caps sessions at a day even on a Tier 2 site', () => {
    expect(normalizeOptions({ ...BASE, adminPool: true }).refreshTokenMinutes).toBe(1440);
    expect(() => normalizeOptions({ ...BASE, adminPool: true, refreshTokenMinutes: 2880 })).toThrow(/admin pool/);
  });
});

describe('self sign-up allowlist', () => {
  const options: AuthStandardOptions = { ...BASE, selfSignUp: { allowedEmailDomains: ['example.edu'] } };

  it('refuses to synthesize without the preSignUp trigger', () => {
    const { template } = synth(options);
    expect(() => template()).toThrow(/preSignUp allowlist trigger/);
  });

  it('opens sign-up only with the trigger attached', () => {
    const t = synth(options, {
      beforeApply: (auth, stack) => {
        const fn = new LambdaFunction(stack, 'PreSignUp', {
          runtime: Runtime.NODEJS_22_X,
          handler: 'index.handler',
          code: Code.fromInline('exports.handler = async (e) => e;'),
        });
        (auth.resources.userPool as UserPool).addTrigger(UserPoolOperation.PRE_SIGN_UP, fn);
      },
    }).template();
    t.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: Match.objectLike({ AllowAdminCreateUserOnly: false }),
      LambdaConfig: Match.objectLike({ PreSignUp: Match.anyValue() }),
    });
  });
});

describe('WAF options', () => {
  /** The two rules' actions, sign-in first. */
  const actions = (t: Template) => {
    const acl = Object.values(t.findResources('AWS::WAFv2::WebACL'))[0] as { Properties: { Rules: { Name: string; Action: unknown }[] } };
    return acl.Properties.Rules.map((r) => [r.Name, r.Action]);
  };

  it('by default the sign-in rule counts and the overall rule blocks (ADR 0017)', () => {
    expect(actions(synth(BASE).template())).toEqual([
      ['auth-kit-sign-in-attempts-per-ip', { Count: {} }],
      ['auth-kit-requests-per-ip', { Block: {} }],
    ]);
  });

  it('sets each rule\'s mode on its own, with custom limits', () => {
    const t = synth({ ...BASE, waf: { signInRule: 'block', overallRule: 'count', signInLimit: 50, overallLimit: 500, evaluationWindowSec: 600 } }).template();
    t.hasResourceProperties('AWS::WAFv2::WebACL', {
      Rules: [
        Match.objectLike({ Action: { Block: {} }, Statement: { RateBasedStatement: Match.objectLike({ Limit: 50, EvaluationWindowSec: 600 }) } }),
        Match.objectLike({ Action: { Count: {} }, Statement: { RateBasedStatement: Match.objectLike({ Limit: 500 }) } }),
      ],
    });
    expect(actions(synth({ ...BASE, waf: { signInRule: 'block' } }).template())).toEqual([
      ['auth-kit-sign-in-attempts-per-ip', { Block: {} }],
      ['auth-kit-requests-per-ip', { Block: {} }],
    ]);
  });

  it('matches the sign-in operations on the header Cognito forwards (verified live: the bare operation name)', () => {
    const acl = Object.values(synth(BASE).template().findResources('AWS::WAFv2::WebACL'))[0] as {
      Properties: { Rules: { Statement: { RateBasedStatement: { ScopeDownStatement?: { OrStatement: { Statements: unknown[] } } } } }[] };
    };
    const scope = JSON.stringify(acl.Properties.Rules[0]!.Statement.RateBasedStatement.ScopeDownStatement);
    for (const header of ['x-amzn-cognito-operation-name', 'x-amz-target']) {
      for (const op of ['initiateauth', 'respondtoauthchallenge']) {
        expect(scope).toContain(`{"ByteMatchStatement":{"FieldToMatch":{"SingleHeader":{"Name":"${header}"}},"PositionalConstraint":"CONTAINS","SearchString":"${op}"`);
      }
    }
    // The value WAF's samples showed on 2026-10-17 contains the lowercased search string after the LOWERCASE transform.
    expect('InitiateAuth'.toLowerCase()).toContain('initiateauth');
    expect('AWSCognitoIdentityProviderService.InitiateAuth'.toLowerCase()).toContain('initiateauth');
    expect(acl.Properties.Rules[1]!.Statement.RateBasedStatement.ScopeDownStatement).toBeUndefined();
  });

  it('turns the web ACL off only with an explicit acknowledgment, and still warns', () => {
    expect(() => synth({ ...BASE, waf: false })).toThrow(/acknowledgeNoRateLimit: true/);
    const { stack, template, applied } = synth({ ...BASE, waf: false, acknowledgeNoRateLimit: true });
    template().resourceCountIs('AWS::WAFv2::WebACL', 0);
    template().resourceCountIs('AWS::WAFv2::WebACLAssociation', 0);
    expect(applied.waf).toMatchObject({ mode: 'none', association: null });
    Annotations.fromStack(stack).hasWarning('*', Match.stringLikeRegexp('no WAF rate rule'));
  });
});

/** A literal REGIONAL web ACL ARN built at runtime, so the repo holds no 12-digit account ID. */
const ACCOUNT = '1'.repeat(12);
const SHARED_ARN = `arn:aws:wafv2:us-east-1:${ACCOUNT}:regional/webacl/auth-kit-shared-user-pools/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`;

describe('a shared web ACL (one per account and Region)', () => {
  it('associates the existing ACL with the pool and creates no ACL of its own', () => {
    const { template, applied } = synth({ ...BASE, waf: { webAclArn: SHARED_ARN } });
    const t = template();
    t.resourceCountIs('AWS::WAFv2::WebACL', 0);
    t.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
    t.hasResourceProperties('AWS::WAFv2::WebACLAssociation', {
      ResourceArn: { 'Fn::GetAtt': [Match.stringLikeRegexp('^authUserPool'), 'Arn'] },
      WebACLArn: SHARED_ARN,
    });
    expect(applied.waf).toMatchObject({ mode: 'shared', webAcl: null, webAclArn: SHARED_ARN });
  });

  it('accepts a CDK token (an imported value) for the ARN', () => {
    const t = synth({ ...BASE, waf: { webAclArn: Fn.importValue('AuthKitSharedWebAclArn') } }).template();
    t.hasResourceProperties('AWS::WAFv2::WebACLAssociation', { WebACLArn: { 'Fn::ImportValue': 'AuthKitSharedWebAclArn' } });
  });

  it('skips sandboxes by default and associates there on request', () => {
    synth({ ...BASE, waf: { webAclArn: SHARED_ARN } }, { type: 'sandbox' }).template().resourceCountIs('AWS::WAFv2::WebACLAssociation', 0);
    synth({ ...BASE, waf: { webAclArn: SHARED_ARN, enabledInSandbox: true } }, { type: 'sandbox' })
      .template()
      .resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
  });

  it("refuses an ACL in a different Region from the pool's", () => {
    // An environment-agnostic stack can't tell (its Region is a deploy-time token)...
    expect(() => synth({ ...BASE, waf: { webAclArn: SHARED_ARN.replace('us-east-1', 'us-west-2') } })).not.toThrow();
    // ...but a stack with a known Region can.
    const app = new App({ context: { 'amplify-backend-type': 'branch', 'amplify-backend-name': 'main' } });
    const stack = new Stack(app, 'S', { env: { region: 'us-west-2' } });
    const auth = new AmplifyAuth(stack, 'auth', standardAuthProps(BASE) as unknown as AuthProps);
    expect(() => applyAuthStandard(auth, { ...BASE, waf: { webAclArn: SHARED_ARN } })).toThrow(/in us-east-1 but the pool is in us-west-2/);
  });

  it('createSharedAuthWebAcl builds the same rate rules with no association', () => {
    const stack = new Stack(new App(), 'SharedWaf', { env: { region: 'us-east-1' } });
    const acl = createSharedAuthWebAcl(stack, 'SharedAuthWebAcl');
    const t = Template.fromStack(stack);
    t.resourceCountIs('AWS::WAFv2::WebACLAssociation', 0);
    t.hasResourceProperties('AWS::WAFv2::WebACL', {
      Name: 'auth-kit-shared-user-pools',
      Scope: 'REGIONAL',
      Rules: [
        // Defaults: sign-in counts first, the overall rule blocks from day one (ADR 0017).
        Match.objectLike({ Name: 'auth-kit-sign-in-attempts-per-ip', Action: { Count: {} }, Statement: { RateBasedStatement: Match.objectLike({ Limit: 100 }) } }),
        Match.objectLike({ Name: 'auth-kit-requests-per-ip', Action: { Block: {} }, Statement: { RateBasedStatement: Match.objectLike({ Limit: 1000 }) } }),
      ],
    });
    expect(acl.attrArn).toBeTruthy();
    expect(() => createSharedAuthWebAcl(stack, 'Bad', { name: 'has spaces' })).toThrow(/web ACL name/);
    expect(() => createSharedAuthWebAcl(stack, 'Bad2', { waf: { signInLimit: 1 } })).toThrow(/from 10/);
  });

  it('createSharedAuthWebAcl: per-rule modes, after a week of counts the sign-in rule blocks', () => {
    const stack = new Stack(new App(), 'SharedWaf', { env: { region: 'us-east-1' } });
    createSharedAuthWebAcl(stack, 'SharedAuthWebAcl', { waf: { signInRule: 'block' } });
    Template.fromStack(stack).hasResourceProperties('AWS::WAFv2::WebACL', {
      Rules: [Match.objectLike({ Action: { Block: {} } }), Match.objectLike({ Action: { Block: {} } })],
    });
    const stack2 = new Stack(new App(), 'SharedWaf2', { env: { region: 'us-east-1' } });
    createSharedAuthWebAcl(stack2, 'SharedAuthWebAcl', { waf: { signInRule: 'count', overallRule: 'count' } });
    Template.fromStack(stack2).hasResourceProperties('AWS::WAFv2::WebACL', {
      Rules: [Match.objectLike({ Action: { Count: {} } }), Match.objectLike({ Action: { Count: {} } })],
    });
  });

  it('createSharedAuthWebAcl refuses the retired single action, unknown options, and bad modes', () => {
    const stack = new Stack(new App(), 'SharedWaf', { env: { region: 'us-east-1' } });
    expect(() => createSharedAuthWebAcl(stack, 'A', { waf: { action: 'count' } as never })).toThrow(/waf.action is gone.*signInRule.*overallRule/);
    expect(() => createSharedAuthWebAcl(stack, 'B', { waf: { webAclArn: 'x' } as never })).toThrow(/no option "webAclArn"/);
    expect(() => createSharedAuthWebAcl(stack, 'C', { waf: { signInRule: 'allow' as never } })).toThrow(/signInRule must be "block" or "count"/);
  });

  it('counts refreshes only in the overall rule for current Amplify clients (GetTokensFromRefreshToken)', () => {
    // The sign-in rule matches InitiateAuth (which older clients use with REFRESH_TOKEN_AUTH) and
    // RespondToAuthChallenge; Amplify JS 6.22 refreshes with GetTokensFromRefreshToken (see ADR 0004).
    expect(SIGN_IN_OPERATIONS).toEqual(['InitiateAuth', 'RespondToAuthChallenge']);
    expect(SIGN_IN_OPERATIONS.some((op) => 'awscognitoidentityproviderservice.gettokensfromrefreshtoken'.includes(op.toLowerCase()))).toBe(false);
    expect('awscognitoidentityproviderservice.initiateauth'.includes('initiateauth')).toBe(true);
  });
});

describe('sandbox detection is exact', () => {
  it('Amplify itself refuses an unknown amplify-backend-type (so a wrong-case value never synthesizes)', () => {
    expect(() => synth(BASE, { type: 'Sandbox' as never })).toThrow(/Unknown amplify-backend-type/);
  });

  it.each(['Sandbox', 'SANDBOX', ' sandbox', 'sandbox-2'])('and auth-kit treats %j as production on its own', (type) => {
    const app = new App({ context: { 'amplify-backend-type': 'branch', 'amplify-backend-name': 'main' } });
    const stack = new Stack(app, 'S');
    const auth = new AmplifyAuth(stack, 'auth', standardAuthProps(BASE) as unknown as AuthProps);
    // Same pool, but its context lookup answers with the wrong-case deployment type.
    const node = new Proxy(auth.resources.userPool.node, {
      get: (target, prop, receiver) =>
        prop === 'tryGetContext'
          ? (key: string): unknown => (key === 'amplify-backend-type' ? type : (target.tryGetContext(key) as unknown))
          : Reflect.get(target, prop, receiver) as unknown,
    });
    const userPool = new Proxy(auth.resources.userPool, {
      get: (target, prop, receiver) => (prop === 'node' ? node : (Reflect.get(target, prop, receiver) as unknown)),
    });
    const applied = applyAuthStandard({ resources: { ...auth.resources, userPool } }, BASE);
    expect(applied).toMatchObject({ isSandbox: false, deletionProtection: 'ACTIVE' });
    expect(applied.explicitAuthFlows).toEqual(['ALLOW_USER_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH']);
    expect(applied.environment).not.toBe('sandbox');
    expect(applied.waf.mode).toBe('created');
  });
});

describe('guards against misuse', () => {
  it('refuses to apply twice to the same pool', () => {
    const { auth } = synth(BASE);
    expect(() => applyAuthStandard(auth, BASE)).toThrow(/already applied/);
  });

  it('refuses props that were not built from the same options (missing group)', () => {
    const app = new App({ context: { 'amplify-backend-type': 'branch' } });
    const stack = new Stack(app, 'S');
    const auth = new AmplifyAuth(stack, 'auth', standardAuthProps({ ...BASE, appRoles: [] }) as unknown as AuthProps);
    expect(() => applyAuthStandard(auth, BASE)).toThrow(/group "reviewer" is missing/);
  });
});

describe('option validation', () => {
  const bad: [string, Partial<AuthStandardOptions> | Record<string, unknown>, RegExp][] = [
    ['tier 1', { tier: 1 }, /tier must be 2 or 3/],
    ['missing project', { project: '' }, /project is required/],
    ['missing owner', { owner: ' ' }, /owner is required/],
    ['bad from address', { email: { fromAddress: 'not-an-address', fromName: 'X' } }, /fromAddress/],
    ['from name with brackets', { email: { fromAddress: 'a@example.org', fromName: 'X <y>' } }, /fromName/],
    ['SES domain mismatch', { email: { fromAddress: 'a@example.org', fromName: 'X', sesIdentity: 'other.org' } }, /isn't on the SES identity/],
    ['SES address mismatch', { email: { fromAddress: 'a@example.org', fromName: 'X', sesIdentity: 'b@example.org' } }, /address identity/],
    ['RP ID with scheme', { passkeys: { relyingPartyId: 'https://reports.example.org' } }, /bare host name/],
    ['RP ID with port', { passkeys: { relyingPartyId: 'reports.example.org:443' } }, /bare host name/],
    ['RP ID public suffix', { passkeys: { relyingPartyId: 'amplifyapp.com' } }, /public suffix/],
    ['RP ID localhost in production', { passkeys: { relyingPartyId: 'localhost' } }, /final domain/],
    ['RP ID upper case', { passkeys: { relyingPartyId: 'Reports.Example.org' } }, /lowercase/],
    ['RP ID too long', { passkeys: { relyingPartyId: `${'a'.repeat(60)}.example.org` } }, /63-character/],
    ['RP ID single label', { passkeys: { relyingPartyId: 'intranet' } }, /full domain/],
    ['app role reusing a standard group', { appRoles: ['admin-content'] }, /already a standard group/],
    ['app role reusing the owner group', { appRoles: ['owner'] }, /already a standard group/],
    ['app role with a retired admin name', { appRoles: ['editor'] }, /retired admin role: it's "admin-content" now/],
    ['duplicate app roles', { appRoles: ['a', 'a'] }, /duplicates/],
    ['app role with spaces', { appRoles: ['two words'] }, /valid Cognito group/],
    ['refresh above the Tier 2 ceiling', { refreshTokenMinutes: 50000 }, /ceiling/],
    ['refresh below an hour', { refreshTokenMinutes: 30 }, /at least 60/],
    ['Tier 3 refresh above a day', { tier: 3, refreshTokenMinutes: 2000 }, /ceiling/],
    ['Tier 3 without threat protection', { tier: 3, threatProtection: 'off' }, /sign-in event logs/],
    ['environment named sandbox', { environment: 'sandbox' }, /reserved/],
    ['admin pool with self sign-up', { adminPool: true, selfSignUp: { allowedEmailDomains: ['example.edu'] } }, /never allow self sign-up/],
    ['empty self sign-up list', { selfSignUp: { allowedEmailDomains: [] } }, /at least one domain/],
    ['WAF limit below 10', { waf: { signInLimit: 5 } }, /from 10/],
    ['WAF window not allowed', { waf: { evaluationWindowSec: 30 as 60 } }, /60, 120, 300, or 600/],
    ['WAF rule mode not allowed', { waf: { overallRule: 'allow' as 'block' } }, /overallRule must be "block" or "count"/],
    ['the retired single waf.action', { waf: { action: 'count' } as never }, /waf.action is gone/],
    ['a shared ACL with its own rule modes', { waf: { webAclArn: 'x', signInRule: 'block' } }, /can't be combined with waf.webAclArn/],
    ['waf: false without the acknowledgment', { waf: false }, /acknowledgeNoRateLimit: true/],
    ['the acknowledgment without waf: false', { acknowledgeNoRateLimit: true }, /applies only with waf: false/],
    ['the retired waf.enabled', { waf: { enabled: false } }, /waf.enabled is gone/],
    ['an unknown waf option', { waf: { limit: 5 } }, /no option "limit"/],
    ['a shared ACL with its own limits', { waf: { webAclArn: 'x', signInLimit: 50 } }, /can't be combined with waf.webAclArn/],
    ['a malformed web ACL ARN', { waf: { webAclArn: 'arn:aws:wafv2:us-east-1:acct:regional/webacl/x/y' } }, /isn't a REGIONAL web ACL ARN/],
    ['a CloudFront (global) web ACL', { waf: { webAclArn: `arn:aws:wafv2:us-east-1:${'1'.repeat(12)}:global/webacl/x/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee` } }, /REGIONAL/],
  ];
  it.each(bad)('rejects %s', (_label, change, message) => {
    expect(() => normalizeOptions({ ...BASE, ...change })).toThrow(AuthStandardConfigError);
    expect(() => normalizeOptions({ ...BASE, ...change })).toThrow(message);
  });

  it('defaults the SES identity to the sending domain and allows a subdomain sender', () => {
    expect(normalizeOptions(BASE).email.sesIdentity).toBe('example.org');
    expect(
      normalizeOptions({ ...BASE, email: { fromAddress: 'a@mail.example.org', fromName: 'X', sesIdentity: 'example.org' } }).email.sesIdentity,
    ).toBe('example.org');
  });
});

describe('standardAuthProps', () => {
  it('builds props for defineAuth', () => {
    const props = standardAuthProps(BASE, { name: 'exampleAuth' });
    expect(props).toMatchObject({
      name: 'exampleAuth',
      loginWith: {
        email: { otpLogin: true, verificationEmailStyle: 'CODE' },
        webAuthn: { relyingPartyId: 'reports.example.org', userVerification: 'required' },
      },
      multifactor: { mode: 'OPTIONAL', totp: true },
      accountRecovery: 'EMAIL_ONLY',
      groups: ['owner', 'superadmin', 'admin-content-people', 'admin-content', 'admin-view', 'reviewer'],
      senders: { email: { fromEmail: 'noreply@example.org', fromName: 'Example Reports', replyTo: 'help@example.org' } },
    });
  });

  it('passes custom email templates and extras through', () => {
    const verify = (code: () => string) => `Code: ${code()}`;
    const invite = (u: () => string, c: () => string) => `${u()} ${c()}`;
    const props = standardAuthProps(
      { ...BASE, email: { ...BASE.email, verification: { subject: 'Verify', body: verify }, invitation: { subject: 'Hi', body: invite } } },
      { userAttributes: { givenName: { required: false, mutable: true } } },
    );
    expect(props.loginWith.email).toMatchObject({
      verificationEmailSubject: 'Verify',
      verificationEmailBody: verify,
      userInvitation: { emailSubject: 'Hi', emailBody: invite },
    });
    expect(props.userAttributes).toEqual({ givenName: { required: false, mutable: true } });
  });
});
