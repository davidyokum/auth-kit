import { AmplifyAuth, type AuthProps } from '@aws-amplify/auth-construct';
import { App, Stack } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { UserPoolOperation, type UserPool } from 'aws-cdk-lib/aws-cognito';
import { Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { describe, expect, it } from 'vitest';
import {
  type AuthStandardOptions,
  AuthStandardConfigError,
  applyAuthStandard,
  normalizeOptions,
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
      ['superadmin', 0],
      ['admin', 1],
      ['editor', 2],
      ['viewer', 3],
      ['reviewer', 4],
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
          Action: { Block: {} },
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
    expect(applied.webAcl).not.toBeNull();
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
  it('supports count mode and custom limits', () => {
    const t = synth({ ...BASE, waf: { action: 'count', signInLimit: 50, overallLimit: 500, evaluationWindowSec: 600 } }).template();
    t.hasResourceProperties('AWS::WAFv2::WebACL', {
      Rules: [
        Match.objectLike({ Action: { Count: {} }, Statement: { RateBasedStatement: Match.objectLike({ Limit: 50, EvaluationWindowSec: 600 }) } }),
        Match.objectLike({ Action: { Count: {} }, Statement: { RateBasedStatement: Match.objectLike({ Limit: 500 }) } }),
      ],
    });
  });

  it('warns when the web ACL is turned off outside a sandbox', () => {
    const { stack, template } = synth({ ...BASE, waf: { enabled: false } });
    template().resourceCountIs('AWS::WAFv2::WebACL', 0);
    Annotations.fromStack(stack).hasWarning('*', Match.stringLikeRegexp('WAF rate rule'));
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
    ['app role reusing a standard group', { appRoles: ['admin'] }, /already a standard group/],
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
      groups: ['superadmin', 'admin', 'editor', 'viewer', 'reviewer'],
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
