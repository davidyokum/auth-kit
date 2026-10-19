/**
 * `InviteExpirySweep` (auth-kit/admin/cdk) by CDK synthesis and assertions: the schedule, the
 * function, and least privilege for both roles. No AWS: nothing is deployed.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { App, Stack, aws_cognito as cognito, aws_kms as kms, aws_sns as sns } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLogTable, INVITE_EXPIRY_BUNDLE_PATH, InviteExpirySweep, type InviteExpirySweepProps, inviteExpiryScheduleMinutes } from '../../src/admin/cdk.js';
import { INVITE_EXPIRY_COGNITO_ACTIONS } from '../../src/admin/index.js';

const ROOT = join(import.meta.dirname, '..', '..');

// The construct deploys the build's bundle. `npm test` runs before `npm run build` in CI, so build
// just the bundle if it's missing (its content doesn't change these templates; dist.test.ts checks it).
beforeAll(() => {
  if (existsSync(join(ROOT, INVITE_EXPIRY_BUNDLE_PATH, 'index.mjs'))) return;
  execFileSync(process.execPath, [join(ROOT, 'node_modules', 'tsup', 'dist', 'cli-default.js'), '--config', 'tsup.lambda.config.ts'], { cwd: ROOT, stdio: 'pipe' });
});

type Statement = { Effect: string; Action: string | string[]; Resource: unknown; Condition?: unknown };
type Props = Omit<InviteExpirySweepProps, 'userPool' | 'auditLog'> & { encrypted?: boolean };

function synth(props: Props = {}) {
  const app = new App();
  const stack = new Stack(app, 'Admin', { env: { region: 'us-east-1' } });
  const userPool = new cognito.UserPool(stack, 'Pool');
  const auditLog = new AuditLogTable(stack, 'AuditLog', props.encrypted ? { encryptionKey: new kms.Key(stack, 'Key') } : {});
  const { encrypted: _encrypted, ...rest } = props;
  const sweep = new InviteExpirySweep(stack, 'InviteExpiry', { userPool, auditLog, ...rest });
  return { template: Template.fromStack(stack), stack, sweep };
}

function policyStatements(template: Template, roleLogicalIdPrefix: string): Statement[] {
  const policies = template.findResources('AWS::IAM::Policy');
  return Object.values(policies)
    .filter((p) => JSON.stringify((p as { Properties: { Roles: unknown } }).Properties.Roles).includes(roleLogicalIdPrefix))
    .flatMap((p) => (p as { Properties: { PolicyDocument: { Statement: Statement[] } } }).Properties.PolicyDocument.Statement);
}

const actionsOf = (statements: Statement[]) => statements.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));

describe('InviteExpirySweep', () => {
  it('schedules the function hourly in UTC, in its own schedule group, with no flexible window', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::Scheduler::ScheduleGroup', 1);
    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'rate(1 hour)',
      ScheduleExpressionTimezone: 'UTC',
      FlexibleTimeWindow: { Mode: 'OFF' },
      State: 'ENABLED',
      GroupName: { Ref: Match.stringLikeRegexp('InviteExpiryGroup') },
      Target: {
        Arn: { 'Fn::GetAtt': [Match.stringLikeRegexp('InviteExpiryFunction'), 'Arn'] },
        RoleArn: { 'Fn::GetAtt': [Match.stringLikeRegexp('InviteExpirySchedulerRole'), 'Arn'] },
        RetryPolicy: { MaximumRetryAttempts: 3, MaximumEventAgeInSeconds: 3600 },
      },
    });
  });

  it('runs the release bundle on Node 22 (ARM), five minutes at most, with no retries, configured by environment', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::Lambda::Function', 1);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      Handler: 'index.handler',
      Timeout: 300,
      MemorySize: 256,
      Code: { S3Bucket: Match.anyValue(), S3Key: Match.stringLikeRegexp('\\.zip$') },
      LoggingConfig: { LogGroup: { Ref: Match.stringLikeRegexp('InviteExpiryLogs') } },
      Environment: {
        Variables: {
          AUTH_KIT_USER_POOL_ID: { Ref: Match.stringLikeRegexp('Pool') },
          AUTH_KIT_AUDIT_TABLE: { Ref: Match.stringLikeRegexp('AuditLogTable') },
          AUTH_KIT_INVITE_MODE: 'emailed-code',
          AUTH_KIT_MAX_PEOPLE: '5000',
          AUTH_KIT_RUN_EVERY_MINUTES: '60',
        },
      },
    });
    template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', { MaximumRetryAttempts: 0, Qualifier: '$LATEST' });
    template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 90 });
    template.hasResource('AWS::Logs::LogGroup', { DeletionPolicy: 'Delete' });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Tags: Match.arrayWith([
        { Key: 'Component', Value: 'invite-expiry' },
        { Key: 'ManagedBy', Value: 'auth-kit' },
      ]),
    });
  });

  it("the function's role: the five Cognito calls on this pool, PutItem on the audit table, its own log group, nothing else", () => {
    const { template } = synth();
    const role = Object.entries(template.findResources('AWS::IAM::Role')).find(([id]) => id.startsWith('InviteExpiryFunctionRole'))![1] as {
      Properties: { AssumeRolePolicyDocument: { Statement: { Principal: unknown }[] }; ManagedPolicyArns?: unknown };
    };
    expect(role.Properties.AssumeRolePolicyDocument.Statement.map((s) => s.Principal)).toEqual([{ Service: 'lambda.amazonaws.com' }]);
    expect(role.Properties.ManagedPolicyArns).toBeUndefined(); // no AWSLambdaBasicExecutionRole (logs:CreateLogGroup on *)

    const statements = policyStatements(template, 'InviteExpiryFunctionRole');
    expect(new Set(actionsOf(statements))).toEqual(
      new Set([...INVITE_EXPIRY_COGNITO_ACTIONS, 'dynamodb:PutItem', 'logs:CreateLogStream', 'logs:PutLogEvents']),
    );
    for (const s of statements) {
      expect(s.Effect).toBe('Allow');
      expect(JSON.stringify(s.Resource)).not.toBe('"*"');
    }
    const cognitoStatement = statements.find((s) => actionsOf([s]).includes('cognito-idp:ListUsers'))!;
    expect(cognitoStatement.Resource).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^Pool/), 'Arn'] });
    const audit = statements.find((s) => actionsOf([s]).includes('dynamodb:PutItem'))!;
    expect(actionsOf([audit])).toEqual(['dynamodb:PutItem']);
    expect(JSON.stringify(audit.Resource)).toMatch(/AuditLogTable/);
    expect(JSON.stringify(audit.Resource)).not.toContain('/index/');
    const logs = statements.find((s) => actionsOf([s]).includes('logs:PutLogEvents'))!;
    expect(JSON.stringify(logs.Resource)).toMatch(/InviteExpiryLogs/);
  });

  it('with ownerWarnings: the warning settings in the environment, and ses:SendEmail from that identity only', () => {
    const { template } = synth({
      ownerWarnings: {
        siteName: 'Example Reports',
        family: 'osbm',
        helpEmail: 'apps-help@example.org',
        from: '"Example Reports (NC OSBM)" <sign-in@mail.example.org>',
        signInUrl: 'https://reports.example.org/sign-in',
        fallbackEmail: 'ops@example.org',
        configurationSet: 'auth',
      },
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          AUTH_KIT_SITE_NAME: 'Example Reports',
          AUTH_KIT_MAIL_FROM: '"Example Reports (NC OSBM)" <sign-in@mail.example.org>',
          AUTH_KIT_FAMILY: 'osbm',
          AUTH_KIT_HELP_EMAIL: 'apps-help@example.org',
          AUTH_KIT_SIGN_IN_URL: 'https://reports.example.org/sign-in',
          AUTH_KIT_OWNER_WARNING_FALLBACK: 'ops@example.org',
          AUTH_KIT_MAIL_CONFIGURATION_SET: 'auth',
        }),
      },
    });
    const statements = policyStatements(template, 'InviteExpiryFunctionRole');
    const sesStatement = statements.find((s) => actionsOf([s]).includes('ses:SendEmail'))!;
    expect(actionsOf([sesStatement])).toEqual(['ses:SendEmail']);
    const resources = JSON.stringify(sesStatement.Resource);
    expect(resources).toContain(':identity/mail.example.org');
    expect(resources).toContain(':configuration-set/auth');
    expect(new Set(actionsOf(statements))).toEqual(
      new Set([...INVITE_EXPIRY_COGNITO_ACTIONS, 'dynamodb:PutItem', 'logs:CreateLogStream', 'logs:PutLogEvents', 'ses:SendEmail']),
    );
    // Without it: no SES at all, and no warning settings.
    const plain = synth().template;
    expect(actionsOf(policyStatements(plain, 'InviteExpiryFunctionRole'))).not.toContain('ses:SendEmail');
    plain.hasResourceProperties('AWS::Lambda::Function', { Environment: { Variables: Match.not(Match.objectLike({ AUTH_KIT_MAIL_FROM: Match.anyValue() })) } });
  });

  it('ownerWarnings: an explicit SES identity, and settings that would send something odd are refused', () => {
    const { template } = synth({ ownerWarnings: { siteName: 'Example Reports', family: 'unc', helpEmail: 'help@example.org', from: '"Example Reports (UNC)" <sign-in@mail.example.org>', sesIdentity: 'example.org' } });
    const sesStatement = policyStatements(template, 'InviteExpiryFunctionRole').find((s) => actionsOf([s]).includes('ses:SendEmail'))!;
    expect(JSON.stringify(sesStatement.Resource)).toContain(':identity/example.org"');
    const base = { siteName: 'Example Reports', family: 'personal' as const, helpEmail: 'help@example.org', from: 'Example Reports <sign-in@yokum.app>' };
    expect(() => synth({ ownerWarnings: { ...base, siteName: ' ' } })).toThrow(/siteName/);
    // Register A10 and E4a: a reply-able sign-in@ sender with the family's suffix, and a usable help address.
    expect(() => synth({ ownerWarnings: { ...base, from: 'Example Reports <noreply@example.org>' } })).toThrow(/never noreply@/);
    expect(() => synth({ ownerWarnings: { ...base, family: 'osbm' } })).toThrow(/Example Reports \(NC OSBM\)/);
    // Register F11: the personal family's sender is its own sign-in@yokum.app.
    expect(() => synth({ ownerWarnings: { ...base, from: 'Example Reports <sign-in@example.org>' } })).toThrow(/Personal sites send from sign-in@yokum\.app/);
    expect(() => synth({ ownerWarnings: { ...base, helpEmail: 'jordan.lee@example.org' } })).toThrow(/personal: true/);
    expect(() => synth({ ownerWarnings: { ...base, from: 'Example Reports' } })).toThrow(/from/);
    expect(() => synth({ ownerWarnings: { ...base, signInUrl: 'http://reports.example.org/sign-in' } })).toThrow(/https/);
    expect(() => synth({ ownerWarnings: { ...base, fallbackEmail: 'ops' } })).toThrow(/fallbackEmail/);
  });

  it("the scheduler's role: assumable only by this account's scheduler for this schedule group, may only invoke the function", () => {
    const { template } = synth();
    const role = Object.entries(template.findResources('AWS::IAM::Role')).find(([id]) => id.startsWith('InviteExpirySchedulerRole'))![1] as {
      Properties: { AssumeRolePolicyDocument: { Statement: { Principal: unknown; Condition: Record<string, Record<string, unknown>> }[] } };
    };
    const trust = role.Properties.AssumeRolePolicyDocument.Statement;
    expect(trust).toHaveLength(1);
    expect(trust[0]!.Principal).toEqual({ Service: 'scheduler.amazonaws.com' });
    // Scheduler presents the schedule group's ARN as aws:SourceArn (test/admin/scheduler-roles.test.ts).
    expect(trust[0]!.Condition).toEqual({
      StringEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' }, 'aws:SourceArn': { 'Fn::GetAtt': [expect.stringMatching(/^InviteExpiryGroup[A-Z0-9]+$/), 'Arn'] } },
    });

    const statements = policyStatements(template, 'InviteExpirySchedulerRole');
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatchObject({ Effect: 'Allow', Action: 'lambda:InvokeFunction', Resource: { 'Fn::GetAtt': [expect.stringMatching(/^InviteExpiryFunction/), 'Arn'] } });
  });

  it('with a customer-managed key on the audit table, the function may use that key (and only it)', () => {
    const { template } = synth({ encrypted: true });
    const statements = policyStatements(template, 'InviteExpiryFunctionRole');
    const kmsStatement = statements.find((s) => actionsOf([s]).some((a) => a.startsWith('kms:')))!;
    expect(kmsStatement.Resource).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^Key/), 'Arn'] });
  });

  it('alarms to the topic on a failed run and on a dropped invocation; none without a topic', () => {
    const app = new App();
    const stack = new Stack(app, 'Admin', { env: { region: 'us-east-1' } });
    const topic = new sns.Topic(stack, 'Alerts');
    new InviteExpirySweep(stack, 'InviteExpiry', {
      userPool: new cognito.UserPool(stack, 'Pool'),
      auditLog: new AuditLogTable(stack, 'AuditLog'),
      alarmTopic: topic,
    });
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::CloudWatch::Alarm', 2);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'Errors',
      Namespace: 'AWS/Lambda',
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
      AlarmActions: [{ Ref: Match.stringLikeRegexp('Alerts') }],
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'InvocationDroppedCount',
      Namespace: 'AWS/Scheduler',
      Dimensions: [{ Name: 'ScheduleGroup', Value: { Ref: Match.stringLikeRegexp('InviteExpiryGroup') } }],
      AlarmActions: [{ Ref: Match.stringLikeRegexp('Alerts') }],
    });
    synth().template.resourceCountIs('AWS::CloudWatch::Alarm', 0);
  });

  it('takes the admin pool’s invite mode, a cron schedule with a time zone, and a larger maxPeople', () => {
    const { template } = synth({ inviteMode: 'temporary-password', schedule: 'cron(15 6 * * ? *)', scheduleTimezone: 'America/New_York', maxPeople: 20000 });
    template.hasResourceProperties('AWS::Scheduler::Schedule', { ScheduleExpression: 'cron(15 6 * * ? *)', ScheduleExpressionTimezone: 'America/New_York' });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ AUTH_KIT_INVITE_MODE: 'temporary-password', AUTH_KIT_MAX_PEOPLE: '20000' }) },
    });
    // A cron's interval is unknown, so the function isn't told one (every skip then warns).
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.not(Match.objectLike({ AUTH_KIT_RUN_EVERY_MINUTES: Match.anyValue() })) },
    });
    synth({ schedule: 'rate(30 minutes)' }).template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ AUTH_KIT_RUN_EVERY_MINUTES: '30' }) },
    });
  });

  it('refuses schedules that would let an invite outlive its 7 days by more than a day, or overlap runs', () => {
    expect(inviteExpiryScheduleMinutes('rate(1 hour)')).toBe(60);
    expect(inviteExpiryScheduleMinutes('rate(30 minutes)')).toBe(30);
    expect(inviteExpiryScheduleMinutes('rate(1 day)')).toBe(1440);
    expect(inviteExpiryScheduleMinutes('cron(0 * * * ? *)')).toBeUndefined();
    for (const bad of ['rate(1 hours)', 'rate(2 hour)', 'rate(0 minutes)', 'daily', 'at(2026-10-24T00:00:00)', 'rate(1 week)']) {
      expect(() => inviteExpiryScheduleMinutes(bad), bad).toThrow(/schedule/);
    }
    expect(() => synth({ schedule: 'rate(5 minutes)' })).toThrow(/every 10 minutes and once a day/);
    expect(() => synth({ schedule: 'rate(2 days)' })).toThrow(/every 10 minutes and once a day/);
    expect(() => synth({ inviteMode: 'magic-link' as never })).toThrow(/inviteMode/);
    expect(() => synth({ maxPeople: 0 })).toThrow(/maxPeople/);
  });

  it('a 10-minute schedule keeps a dropped delivery from spilling into the next run', () => {
    synth({ schedule: 'rate(10 minutes)' }).template.hasResourceProperties('AWS::Scheduler::Schedule', {
      Target: Match.objectLike({ RetryPolicy: { MaximumRetryAttempts: 3, MaximumEventAgeInSeconds: 600 } }),
    });
  });
});
