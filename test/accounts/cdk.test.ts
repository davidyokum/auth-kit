/**
 * Account creation's AWS resources (auth-kit/admin/cdk, ADR 0023/0024) by CDK synthesis: the three
 * tables and their grants, the unverified-account sweep and the access-request digest (schedule,
 * function, least privilege), the refusals, and the plain-JSON policies. No AWS: nothing is deployed.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { App, Stack, aws_cognito as cognito, aws_iam as iam, aws_kms as kms, aws_sns as sns } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ACCESS_REQUEST_DIGEST_BUNDLE_PATH,
  AccessRequestDigest,
  type AccessRequestDigestProps,
  AccessRequestTable,
  AuditLogTable,
  INVITE_EXPIRY_BUNDLE_PATH,
  InviteExpirySweep,
  RateLimitTable,
  SiteSettingsTable,
  UNVERIFIED_SWEEP_BUNDLE_PATH,
  UnverifiedAccountSweep,
  type UnverifiedAccountSweepProps,
} from '../../src/admin/cdk.js';
import {
  ACCESS_REQUEST_APP_ACTIONS,
  ACCESS_REQUEST_DIGEST_ACTIONS,
  ACCESS_REQUEST_DIGEST_COGNITO_ACTIONS,
  RATE_LIMIT_APP_ACTIONS,
  SELF_SERVICE_COGNITO_ACTIONS,
  SIGN_UP_COGNITO_ACTIONS,
  SITE_SETTINGS_APP_ACTIONS,
  UNVERIFIED_SWEEP_COGNITO_ACTIONS,
  accountCreationAppPolicy,
  siteSettingsAppPolicy,
} from '../../src/admin/iam.js';
import { ACCESS_REQUEST_TABLE_SCHEMA, RATE_LIMIT_TABLE_SCHEMA, SITE_SETTINGS_TABLE_SCHEMA } from '../../src/accounts/schema.js';
import { HELP_ADDRESS_PLACEHOLDER } from '../../src/themes/index.js';

const ROOT = join(import.meta.dirname, '..', '..');

// The constructs deploy the build's bundles. `npm test` runs before `npm run build` in CI, so build
// just the bundles if any is missing (their content doesn't change these templates).
beforeAll(() => {
  if ([INVITE_EXPIRY_BUNDLE_PATH, UNVERIFIED_SWEEP_BUNDLE_PATH, ACCESS_REQUEST_DIGEST_BUNDLE_PATH].every((p) => existsSync(join(ROOT, p, 'index.mjs')))) return;
  execFileSync(process.execPath, [join(ROOT, 'node_modules', 'tsup', 'dist', 'cli-default.js'), '--config', 'tsup.lambda.config.ts'], { cwd: ROOT, stdio: 'pipe' });
});

type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown; Principal?: unknown };
type TableResource = { DeletionPolicy?: string; UpdateReplacePolicy?: string; Properties: Record<string, unknown> & { Replicas: Record<string, unknown>[] } };

function synth(build: (stack: Stack) => void, context: Record<string, string> = {}) {
  const app = new App({ context });
  const stack = new Stack(app, 'Site', { env: { region: 'us-east-1' } });
  build(stack);
  return Template.fromStack(stack);
}

const role = (stack: Stack, id = 'Compute') => new iam.Role(stack, id, { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });

function onlyTable(template: Template): TableResource {
  const tables = Object.values(template.findResources('AWS::DynamoDB::GlobalTable')) as TableResource[];
  expect(tables).toHaveLength(1);
  return tables[0]!;
}

/** Every statement in the policies attached to roles whose logical ID starts with the prefix. */
function policyStatements(template: Template, roleLogicalIdPrefix: string): Statement[] {
  return Object.values(template.findResources('AWS::IAM::Policy'))
    .filter((p) => JSON.stringify((p as { Properties: { Roles: unknown } }).Properties.Roles).includes(`"Ref":"${roleLogicalIdPrefix}`))
    .flatMap((p) => (p as { Properties: { PolicyDocument: { Statement: Statement[] } } }).Properties.PolicyDocument.Statement);
}

const actionsOf = (statements: Statement[]) => statements.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
const statementWith = (statements: Statement[], action: string) => statements.find((s) => actionsOf([s]).includes(action))!;

// ---- The tables -----------------------------------------------------------------------------------

describe('AccessRequestTable', () => {
  it('pk/sk, TTL on ttl, PITR, deletion protection, retained, DeleteTable denied to everyone', () => {
    const template = synth((stack) => new AccessRequestTable(stack, 'Requests'));
    const table = onlyTable(template);
    expect(table.DeletionPolicy).toBe('Retain');
    expect(table.UpdateReplacePolicy).toBe('Retain');
    expect(table.Properties.KeySchema).toEqual([
      { AttributeName: ACCESS_REQUEST_TABLE_SCHEMA.partitionKey, KeyType: 'HASH' },
      { AttributeName: ACCESS_REQUEST_TABLE_SCHEMA.sortKey, KeyType: 'RANGE' },
    ]);
    expect(table.Properties.KeySchema).toEqual([
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ]);
    expect(table.Properties.BillingMode).toBe('PAY_PER_REQUEST');
    expect(table.Properties.TimeToLiveSpecification).toEqual({ AttributeName: 'ttl', Enabled: true });
    expect(table.Properties.Replicas).toHaveLength(1);
    expect(table.Properties.Replicas[0]).toMatchObject({
      DeletionProtectionEnabled: true,
      // Off by default: backups would keep typed names and reasons past the 30-day deletion (I1).
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false },
      ResourcePolicy: { PolicyDocument: { Statement: [{ Sid: 'AccessRequestsAreKept', Effect: 'Deny', Principal: '*', Action: 'dynamodb:DeleteTable', Resource: '*' }] } },
      Tags: expect.arrayContaining([
        { Key: 'Component', Value: 'access-requests' },
        { Key: 'ManagedBy', Value: 'auth-kit' },
      ]),
    });
  });

  it('point-in-time recovery only when the site turns it on (its privacy notice must say backups keep requests longer)', () => {
    const table = onlyTable(synth((stack) => new AccessRequestTable(stack, 'Requests', { pointInTimeRecovery: true })));
    expect(table.Properties.Replicas[0]).toMatchObject({ PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } });
  });

  it('in a sandbox: no deletion protection, no resource policy, removed with the stack (TTL stays)', () => {
    const template = synth((stack) => new AccessRequestTable(stack, 'Requests'), { 'amplify-backend-type': 'sandbox' });
    const table = onlyTable(template);
    expect(table.DeletionPolicy).toBe('Delete');
    expect(table.Properties.Replicas[0]).toMatchObject({ DeletionProtectionEnabled: false, PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false } });
    expect(table.Properties.Replicas[0]).not.toHaveProperty('ResourcePolicy');
    expect(table.Properties.TimeToLiveSpecification).toEqual({ AttributeName: 'ttl', Enabled: true });
    expect(JSON.stringify(template.toJSON())).not.toContain('DeleteTable');
    // An explicit prop wins over the context, both ways.
    expect(onlyTable(synth((stack) => new AccessRequestTable(stack, 'Requests', { sandbox: false }), { 'amplify-backend-type': 'sandbox' })).DeletionPolicy).toBe('Retain');
    expect(onlyTable(synth((stack) => new AccessRequestTable(stack, 'Requests', { sandbox: true }))).DeletionPolicy).toBe('Delete');
  });

  it('grantApp: exactly Query, GetItem, PutItem on the table; grantDigest: exactly Query, DeleteItem', () => {
    const template = synth((stack) => {
      const table = new AccessRequestTable(stack, 'Requests');
      table.grantApp(role(stack, 'Compute'));
      table.grantDigest(role(stack, 'Digest'));
    });
    const app = policyStatements(template, 'Compute');
    expect(app).toHaveLength(1);
    expect(new Set(actionsOf(app))).toEqual(new Set(['dynamodb:Query', 'dynamodb:GetItem', 'dynamodb:PutItem']));
    expect(actionsOf(app)).toHaveLength(3);
    expect(app[0]!.Resource).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^RequestsTable/), 'Arn'] });
    const digest = policyStatements(template, 'Digest');
    expect(digest).toHaveLength(1);
    expect(new Set(actionsOf(digest))).toEqual(new Set(['dynamodb:Query', 'dynamodb:DeleteItem']));
    expect(actionsOf(digest)).toHaveLength(2);
    expect(digest[0]!.Resource).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^RequestsTable/), 'Arn'] });
    expect([...ACCESS_REQUEST_APP_ACTIONS]).toEqual(['dynamodb:Query', 'dynamodb:GetItem', 'dynamodb:PutItem']);
    expect([...ACCESS_REQUEST_DIGEST_ACTIONS]).toEqual(['dynamodb:Query', 'dynamodb:DeleteItem']);
  });

  it('with a customer-managed key, each grant includes that key only', () => {
    const template = synth((stack) => {
      const table = new AccessRequestTable(stack, 'Requests', { encryptionKey: new kms.Key(stack, 'Key') });
      table.grantApp(role(stack));
    });
    const kmsStatement = policyStatements(template, 'Compute').find((s) => actionsOf([s]).some((a) => a.startsWith('kms:')))!;
    expect(kmsStatement.Resource).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^Key/), 'Arn'] });
  });
});

describe('RateLimitTable', () => {
  it('pk only, TTL on ttl, no PITR, no deletion protection, removed with the stack, even outside a sandbox', () => {
    const template = synth((stack) => new RateLimitTable(stack, 'RateLimits'));
    const table = onlyTable(template);
    expect(table.DeletionPolicy).toBe('Delete');
    expect(table.Properties.KeySchema).toEqual([{ AttributeName: RATE_LIMIT_TABLE_SCHEMA.partitionKey, KeyType: 'HASH' }]);
    expect(table.Properties.KeySchema).toEqual([{ AttributeName: 'pk', KeyType: 'HASH' }]);
    expect(table.Properties.TimeToLiveSpecification).toEqual({ AttributeName: 'ttl', Enabled: true });
    expect(table.Properties.Replicas[0]).toMatchObject({
      DeletionProtectionEnabled: false,
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false },
      Tags: expect.arrayContaining([{ Key: 'Component', Value: 'rate-limits' }]),
    });
    expect(table.Properties.Replicas[0]).not.toHaveProperty('ResourcePolicy');
  });

  it('grantApp: exactly UpdateItem on the table', () => {
    const template = synth((stack) => new RateLimitTable(stack, 'RateLimits').grantApp(role(stack)));
    const statements = policyStatements(template, 'Compute');
    expect(statements).toHaveLength(1);
    expect(actionsOf(statements)).toEqual(['dynamodb:UpdateItem']);
    expect(statements[0]!.Resource).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^RateLimitsTable/), 'Arn'] });
    expect([...RATE_LIMIT_APP_ACTIONS]).toEqual(['dynamodb:UpdateItem']);
  });
});

describe('SiteSettingsTable', () => {
  it('pk/sk, no TTL, PITR, deletion protection, retained, DeleteTable denied', () => {
    const template = synth((stack) => new SiteSettingsTable(stack, 'Settings'));
    const table = onlyTable(template);
    expect(table.DeletionPolicy).toBe('Retain');
    expect(table.Properties.KeySchema).toEqual([
      { AttributeName: SITE_SETTINGS_TABLE_SCHEMA.partitionKey, KeyType: 'HASH' },
      { AttributeName: SITE_SETTINGS_TABLE_SCHEMA.sortKey, KeyType: 'RANGE' },
    ]);
    expect(table.Properties).not.toHaveProperty('TimeToLiveSpecification');
    expect(table.Properties.Replicas[0]).toMatchObject({
      DeletionProtectionEnabled: true,
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      ResourcePolicy: { PolicyDocument: { Statement: [{ Sid: 'SiteSettingsAreKept', Effect: 'Deny', Principal: '*', Action: 'dynamodb:DeleteTable', Resource: '*' }] } },
      Tags: expect.arrayContaining([{ Key: 'Component', Value: 'site-settings' }]),
    });
    const sandbox = onlyTable(synth((stack) => new SiteSettingsTable(stack, 'Settings'), { 'amplify-backend-type': 'sandbox' }));
    expect(sandbox.DeletionPolicy).toBe('Delete');
    expect(sandbox.Properties.Replicas[0]).not.toHaveProperty('ResourcePolicy');
  });

  it('grantApp: GetItem, PutItem, DeleteItem; grantRead: GetItem only', () => {
    const template = synth((stack) => {
      const table = new SiteSettingsTable(stack, 'Settings');
      table.grantApp(role(stack, 'Compute'));
      table.grantRead(role(stack, 'Reader'));
    });
    const app = policyStatements(template, 'Compute');
    expect(app).toHaveLength(1);
    expect(actionsOf(app).sort()).toEqual(['dynamodb:DeleteItem', 'dynamodb:GetItem', 'dynamodb:PutItem']);
    expect(app[0]!.Resource).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^SettingsTable/), 'Arn'] });
    const reader = policyStatements(template, 'Reader');
    expect(reader).toHaveLength(1);
    expect(actionsOf(reader)).toEqual(['dynamodb:GetItem']);
    expect([...SITE_SETTINGS_APP_ACTIONS]).toEqual(['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem']);
  });
});

// ---- The unverified-account sweep -----------------------------------------------------------------

describe('UnverifiedAccountSweep', () => {
  function sweep(props: Omit<UnverifiedAccountSweepProps, 'userPool' | 'auditLog'> = {}) {
    let built: UnverifiedAccountSweep | undefined;
    const template = synth((stack) => {
      built = new UnverifiedAccountSweep(stack, 'Unverified', { userPool: new cognito.UserPool(stack, 'Pool'), auditLog: new AuditLogTable(stack, 'AuditLog'), ...props });
    });
    return { template, construct: built! };
  }

  it('runs hourly in UTC by default, in a schedule group of its own, with no flexible window', () => {
    const { template, construct } = sweep();
    template.resourceCountIs('AWS::Scheduler::ScheduleGroup', 1);
    template.resourceCountIs('AWS::Scheduler::Schedule', 1);
    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'rate(1 hour)',
      ScheduleExpressionTimezone: 'UTC',
      FlexibleTimeWindow: { Mode: 'OFF' },
      State: 'ENABLED',
      GroupName: { Ref: Match.stringLikeRegexp('^UnverifiedGroup') },
      Target: {
        Arn: { 'Fn::GetAtt': [Match.stringLikeRegexp('^UnverifiedFunction'), 'Arn'] },
        RoleArn: { 'Fn::GetAtt': [Match.stringLikeRegexp('^UnverifiedSchedulerRole'), 'Arn'] },
        RetryPolicy: { MaximumRetryAttempts: 3, MaximumEventAgeInSeconds: 3600 },
      },
    });
    expect(construct.alarms).toEqual([]);
  });

  it('Node 22 on ARM, five minutes, no retries, its own log group, configured by environment (24 hours)', () => {
    const { template } = sweep();
    template.resourceCountIs('AWS::Lambda::Function', 1);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      Handler: 'index.handler',
      Timeout: 300,
      MemorySize: 256,
      Code: { S3Bucket: Match.anyValue(), S3Key: Match.stringLikeRegexp('\\.zip$') },
      LoggingConfig: { LogGroup: { Ref: Match.stringLikeRegexp('^UnverifiedLogs') } },
      Environment: {
        Variables: {
          AUTH_KIT_USER_POOL_ID: { Ref: Match.stringLikeRegexp('^Pool') },
          AUTH_KIT_AUDIT_TABLE: { Ref: Match.stringLikeRegexp('^AuditLogTable') },
          AUTH_KIT_MAX_PEOPLE: '100000',
          AUTH_KIT_UNVERIFIED_HOURS: '24',
        },
      },
      Tags: Match.arrayWith([
        { Key: 'Component', Value: 'unverified-sweep' },
        { Key: 'ManagedBy', Value: 'auth-kit' },
      ]),
    });
    template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', { MaximumRetryAttempts: 0, Qualifier: '$LATEST' });
    template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 90 });
    template.hasResource('AWS::Logs::LogGroup', { DeletionPolicy: 'Delete' });
  });

  it("the function's role: ListUsers, AdminListGroupsForUser, AdminGetUser, AdminDeleteUser on the pool, PutItem on the audit table, its own log group, nothing else", () => {
    const { template } = sweep();
    const fnRole = Object.entries(template.findResources('AWS::IAM::Role')).find(([id]) => id.startsWith('UnverifiedFunctionRole'))![1] as {
      Properties: { AssumeRolePolicyDocument: { Statement: { Principal: unknown }[] }; ManagedPolicyArns?: unknown };
    };
    expect(fnRole.Properties.AssumeRolePolicyDocument.Statement.map((s) => s.Principal)).toEqual([{ Service: 'lambda.amazonaws.com' }]);
    expect(fnRole.Properties.ManagedPolicyArns).toBeUndefined();

    const statements = policyStatements(template, 'UnverifiedFunctionRole');
    expect(statements).toHaveLength(3);
    for (const s of statements) expect(s.Effect).toBe('Allow');
    const cognitoStatement = statementWith(statements, 'cognito-idp:ListUsers');
    expect(actionsOf([cognitoStatement])).toEqual(['cognito-idp:ListUsers', 'cognito-idp:AdminListGroupsForUser', 'cognito-idp:AdminGetUser', 'cognito-idp:AdminDeleteUser']);
    expect(actionsOf([cognitoStatement])).toEqual([...UNVERIFIED_SWEEP_COGNITO_ACTIONS]);
    expect(cognitoStatement.Resource).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^Pool/), 'Arn'] });
    const audit = statementWith(statements, 'dynamodb:PutItem');
    expect(actionsOf([audit])).toEqual(['dynamodb:PutItem']);
    expect(audit.Resource).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^AuditLogTable/), 'Arn'] });
    const logs = statementWith(statements, 'logs:PutLogEvents');
    expect(actionsOf([logs]).sort()).toEqual(['logs:CreateLogStream', 'logs:PutLogEvents']);
    expect(logs.Resource).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^UnverifiedLogs/), 'Arn'] });
    // Never a ListUsersInGroup, AdminDisableUser, or a group change: it only deletes stray sign-ups.
    expect(actionsOf(statements)).not.toContain('cognito-idp:AdminRemoveUserFromGroup');
  });

  it("the scheduler's role: this account's scheduler for this schedule group only, and it may only invoke the function", () => {
    const { template } = sweep();
    const schedulerRole = Object.entries(template.findResources('AWS::IAM::Role')).find(([id]) => id.startsWith('UnverifiedSchedulerRole'))![1] as {
      Properties: { AssumeRolePolicyDocument: { Statement: { Principal: unknown; Condition: Record<string, Record<string, unknown>> }[] } };
    };
    const trust = schedulerRole.Properties.AssumeRolePolicyDocument.Statement;
    expect(trust).toHaveLength(1);
    expect(trust[0]!.Principal).toEqual({ Service: 'scheduler.amazonaws.com' });
    expect(trust[0]!.Condition).toEqual({
      StringEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' }, 'aws:SourceArn': { 'Fn::GetAtt': [expect.stringMatching(/^UnverifiedGroup[A-Z0-9]+$/), 'Arn'] } },
    });
    const statements = policyStatements(template, 'UnverifiedSchedulerRole');
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatchObject({ Effect: 'Allow', Action: 'lambda:InvokeFunction', Resource: { 'Fn::GetAtt': [expect.stringMatching(/^UnverifiedFunction/), 'Arn'] } });
  });

  it('alarms (a failed run, a dropped invocation) only with an alarm topic', () => {
    let construct: UnverifiedAccountSweep | undefined;
    const template = synth((stack) => {
      construct = new UnverifiedAccountSweep(stack, 'Unverified', {
        userPool: new cognito.UserPool(stack, 'Pool'),
        auditLog: new AuditLogTable(stack, 'AuditLog'),
        alarmTopic: new sns.Topic(stack, 'Alerts'),
      });
    });
    expect(construct!.alarms).toHaveLength(2);
    template.resourceCountIs('AWS::CloudWatch::Alarm', 2);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: 'Errors', Namespace: 'AWS/Lambda', AlarmActions: [{ Ref: Match.stringLikeRegexp('^Alerts') }] });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'InvocationDroppedCount',
      Namespace: 'AWS/Scheduler',
      Dimensions: [{ Name: 'ScheduleGroup', Value: { Ref: Match.stringLikeRegexp('^UnverifiedGroup') } }],
    });
    sweep().template.resourceCountIs('AWS::CloudWatch::Alarm', 0);
  });

  it('takes a cron with a time zone, a longer wait, and a larger maxPeople', () => {
    const { template } = sweep({ schedule: 'cron(0 * * * ? *)', scheduleTimezone: 'America/New_York', olderThanHours: 48, maxPeople: 20000 });
    template.hasResourceProperties('AWS::Scheduler::Schedule', { ScheduleExpression: 'cron(0 * * * ? *)', ScheduleExpressionTimezone: 'America/New_York' });
    template.hasResourceProperties('AWS::Lambda::Function', { Environment: { Variables: Match.objectLike({ AUTH_KIT_UNVERIFIED_HOURS: '48', AUTH_KIT_MAX_PEOPLE: '20000' }) } });
    sweep({ schedule: 'rate(10 minutes)' }).template.hasResourceProperties('AWS::Scheduler::Schedule', {
      Target: Match.objectLike({ RetryPolicy: { MaximumRetryAttempts: 3, MaximumEventAgeInSeconds: 600 } }),
    });
  });

  it('refuses bad schedules, olderThanHours, and maxPeople', () => {
    for (const schedule of ['rate(5 minutes)', 'rate(2 days)']) expect(() => sweep({ schedule }), schedule).toThrow(/every 10 minutes and once a day/);
    for (const schedule of ['hourly', 'rate(1 hours)', 'rate(2 hour)', 'at(2026-10-24T00:00:00)']) expect(() => sweep({ schedule }), schedule).toThrow(/schedule/);
    for (const olderThanHours of [0, -1, 1.5, Number.NaN]) expect(() => sweep({ olderThanHours }), String(olderThanHours)).toThrow(/olderThanHours/);
    expect(() => sweep({ maxPeople: 0 })).toThrow(/maxPeople/);
    expect(() => sweep({ olderThanHours: 1 })).not.toThrow();
  });
});

// ---- The access-request digest --------------------------------------------------------------------

type DigestProps = Omit<AccessRequestDigestProps, 'userPool' | 'requests' | 'settings'> & { withSettings?: boolean };

const DIGEST: DigestProps = {
  siteName: 'Example Reports',
  family: 'personal',
  signInUrl: 'https://reports.example.org/sign-in',
  peopleUrl: 'https://reports.example.org/admin/people',
  helpEmail: 'help@example.org',
  from: 'Example Reports <sign-in@mail.example.org>',
};

describe('AccessRequestDigest', () => {
  function digest(over: Partial<DigestProps> = {}) {
    let built: AccessRequestDigest | undefined;
    const { withSettings, ...props } = { ...DIGEST, ...over };
    const template = synth((stack) => {
      built = new AccessRequestDigest(stack, 'Digest', {
        userPool: new cognito.UserPool(stack, 'Pool'),
        requests: new AccessRequestTable(stack, 'Requests'),
        ...(withSettings && { settings: new SiteSettingsTable(stack, 'Settings') }),
        ...props,
      });
    });
    return { template, construct: built! };
  }

  it('runs daily at 8:00 in America/New_York by default, in its own schedule group', () => {
    const { template, construct } = digest();
    template.resourceCountIs('AWS::Scheduler::ScheduleGroup', 1);
    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'cron(0 8 * * ? *)',
      ScheduleExpressionTimezone: 'America/New_York',
      FlexibleTimeWindow: { Mode: 'OFF' },
      GroupName: { Ref: Match.stringLikeRegexp('^DigestGroup') },
      Target: Match.objectLike({ RetryPolicy: { MaximumRetryAttempts: 3, MaximumEventAgeInSeconds: 3600 } }),
    });
    template.hasResourceProperties('AWS::Lambda::Function', { Runtime: 'nodejs22.x', Architectures: ['arm64'], Timeout: 300 });
    template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', { MaximumRetryAttempts: 0 });
    expect(construct.alarms).toEqual([]);
  });

  it('configures the function by environment', () => {
    digest().template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: {
          AUTH_KIT_USER_POOL_ID: { Ref: Match.stringLikeRegexp('^Pool') },
          AUTH_KIT_REQUEST_TABLE: { Ref: Match.stringLikeRegexp('^RequestsTable') },
          AUTH_KIT_SITE_NAME: 'Example Reports',
          AUTH_KIT_FAMILY: 'personal',
          AUTH_KIT_SIGN_IN_URL: 'https://reports.example.org/sign-in',
          AUTH_KIT_PEOPLE_URL: 'https://reports.example.org/admin/people',
          AUTH_KIT_HELP_EMAIL: 'help@example.org',
          AUTH_KIT_MAIL_FROM: 'Example Reports <sign-in@mail.example.org>',
        },
      },
    });
    digest({ withSettings: true, configurationSet: 'auth', recipientGroups: ['owner', 'people-managers'], family: 'unc' }).template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          AUTH_KIT_SETTINGS_TABLE: { Ref: Match.stringLikeRegexp('^SettingsTable') },
          AUTH_KIT_MAIL_CONFIGURATION_SET: 'auth',
          AUTH_KIT_RECIPIENT_GROUPS: 'owner,people-managers',
          AUTH_KIT_FAMILY: 'unc',
        }),
      },
    });
  });

  it("the function's role: ListUsersInGroup on the pool, Query and DeleteItem on the requests, SendEmail from the sender's identity, its logs", () => {
    const { template } = digest();
    const statements = policyStatements(template, 'DigestFunctionRole');
    expect(statements).toHaveLength(4);
    expect(new Set(actionsOf(statements))).toEqual(
      new Set(['cognito-idp:ListUsersInGroup', 'dynamodb:Query', 'dynamodb:DeleteItem', 'ses:SendEmail', 'logs:CreateLogStream', 'logs:PutLogEvents']),
    );
    expect(actionsOf(statements)).toHaveLength(6);
    const cognitoStatement = statementWith(statements, 'cognito-idp:ListUsersInGroup');
    expect(actionsOf([cognitoStatement])).toEqual([...ACCESS_REQUEST_DIGEST_COGNITO_ACTIONS]);
    expect(cognitoStatement.Resource).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^Pool/), 'Arn'] });
    const requests = statementWith(statements, 'dynamodb:Query');
    expect(actionsOf([requests])).toEqual(['dynamodb:Query', 'dynamodb:DeleteItem']);
    expect(requests.Resource).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^RequestsTable/), 'Arn'] });
    const ses = statementWith(statements, 'ses:SendEmail');
    expect(actionsOf([ses])).toEqual(['ses:SendEmail']);
    // Only the sender's identity (its domain by default): no configuration set unless one is given.
    const sesJson = JSON.stringify(ses.Resource);
    expect(sesJson).toMatch(/:ses:us-east-1:",\{"Ref":"AWS::AccountId"\},":identity\/mail\.example\.org"/);
    expect(sesJson).not.toContain('configuration-set');
    expect(sesJson).not.toContain('*');
    expect(actionsOf(statements)).not.toContain('dynamodb:GetItem');
    expect(JSON.stringify(statementWith(statements, 'logs:PutLogEvents').Resource)).toMatch(/DigestLogs/);
  });

  it('with settings: GetItem on the settings table, nothing more; with a configuration set and an explicit identity: SendEmail on just those', () => {
    const { template } = digest({ withSettings: true, configurationSet: 'auth', sesIdentity: 'example.org' });
    const statements = policyStatements(template, 'DigestFunctionRole');
    expect(statements).toHaveLength(5);
    const settings = statementWith(statements, 'dynamodb:GetItem');
    expect(actionsOf([settings])).toEqual(['dynamodb:GetItem']);
    expect(settings.Resource).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^SettingsTable/), 'Arn'] });
    const ses = statementWith(statements, 'ses:SendEmail');
    const sesJson = JSON.stringify(ses.Resource);
    expect(sesJson).toContain(':identity/example.org"');
    expect(sesJson).toContain(':configuration-set/auth"');
    expect(Array.isArray(ses.Resource) ? ses.Resource : [ses.Resource]).toHaveLength(2);
  });

  it("the scheduler's role may only invoke the function; alarms only with a topic", () => {
    const { template } = digest();
    const statements = policyStatements(template, 'DigestSchedulerRole');
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatchObject({ Action: 'lambda:InvokeFunction', Resource: { 'Fn::GetAtt': [expect.stringMatching(/^DigestFunction/), 'Arn'] } });
    template.resourceCountIs('AWS::CloudWatch::Alarm', 0);
    const withTopic = synth((stack) => {
      new AccessRequestDigest(stack, 'Digest', { userPool: new cognito.UserPool(stack, 'Pool'), requests: new AccessRequestTable(stack, 'Requests'), alarmTopic: new sns.Topic(stack, 'Alerts'), ...DIGEST });
    });
    withTopic.resourceCountIs('AWS::CloudWatch::Alarm', 2);
  });

  it('refuses a placeholder help address, a missing site name, non-https URLs, an unknown family, a bad sender, and schedules more often than hourly', () => {
    expect(HELP_ADDRESS_PLACEHOLDER).toBe('apps-help@replace-me.invalid');
    expect(() => digest({ helpEmail: 'apps-help@replace-me.invalid' })).toThrow(/helpEmail.*placeholder/);
    expect(() => digest({ helpEmail: '' })).toThrow(/helpEmail/);
    expect(() => digest({ helpEmail: 'help' })).toThrow(/helpEmail/);
    expect(() => digest({ siteName: '' })).toThrow(/siteName/);
    expect(() => digest({ siteName: '   ' })).toThrow(/siteName/);
    expect(() => digest({ signInUrl: 'http://reports.example.org/sign-in' })).toThrow(/signInUrl.*https/);
    expect(() => digest({ peopleUrl: '/admin/people' })).toThrow(/peopleUrl.*https/);
    expect(() => digest({ family: 'acme' as never })).toThrow(/family/);
    expect(() => digest({ from: 'Example Reports' })).toThrow(/from/);
    for (const schedule of ['rate(30 minutes)', 'rate(10 minutes)', 'rate(2 days)']) expect(() => digest({ schedule }), schedule).toThrow(/between hourly and once a day/);
    expect(() => digest({ schedule: 'daily' })).toThrow(/schedule/);
    expect(() => digest({ schedule: 'rate(1 hour)' })).not.toThrow();
    expect(() => digest({ schedule: 'rate(1 day)' })).not.toThrow();
  });
});

// ---- The invite-expiry sweep after the shared-helper refactor -------------------------------------

describe('InviteExpirySweep (built by the shared scheduled-job helper)', () => {
  it('keeps every logical ID it had, so a deployed sweep is updated in place, not replaced', () => {
    const template = synth((stack) => {
      new InviteExpirySweep(stack, 'InviteExpiry', { userPool: new cognito.UserPool(stack, 'Pool'), auditLog: new AuditLogTable(stack, 'AuditLog') });
    });
    const ids = Object.keys(template.toJSON().Resources as Record<string, unknown>).filter((id) => id.startsWith('InviteExpiry'));
    expect(ids.sort()).toEqual(
      [
        'InviteExpiryLogs0DDBF169',
        'InviteExpiryFunctionRoleE27BE9C3',
        'InviteExpiryFunctionRoleDefaultPolicy10D21736',
        'InviteExpiryFunction1F4B7F9C',
        'InviteExpiryFunctionEventInvokeConfigB7B1D00D',
        'InviteExpiryGroup7486835A',
        'InviteExpirySchedulerRole0DD0304C',
        'InviteExpirySchedulerRoleDefaultPolicy0AEC3894',
        'InviteExpirySchedule79CA5989',
      ].sort(),
    );
  });
});

// ---- The plain-JSON policies ----------------------------------------------------------------------

describe('accountCreationAppPolicy and siteSettingsAppPolicy (plain JSON, for roles defined outside CDK)', () => {
  const POOL = 'arn:aws:cognito-idp:us-east-1:ACCOUNT:userpool/us-east-1_TestPool1';
  const RATE = 'arn:aws:dynamodb:us-east-1:ACCOUNT:table/rate-limits';
  const REQUESTS = 'arn:aws:dynamodb:us-east-1:ACCOUNT:table/access-requests';

  it('a sign-up site: the sign-up and self-service Cognito calls on the pool, once each, and UpdateItem on the rate table', () => {
    const policy = accountCreationAppPolicy({ userPoolArn: POOL, rateLimitTableArn: RATE, selfSignUp: true });
    expect(policy.Version).toBe('2012-10-17');
    expect(policy.Statement).toEqual([
      { Sid: 'AccountCreationRateLimits', Effect: 'Allow', Action: ['dynamodb:UpdateItem'], Resource: RATE },
      { Sid: 'AccountCreationCognito', Effect: 'Allow', Action: expect.any(Array), Resource: POOL },
    ]);
    const cognitoActions = policy.Statement[1]!.Action;
    expect(new Set(cognitoActions)).toEqual(new Set([...SIGN_UP_COGNITO_ACTIONS, ...SELF_SERVICE_COGNITO_ACTIONS]));
    expect(new Set(cognitoActions)).toEqual(
      new Set([
        'cognito-idp:ListUsers',
        'cognito-idp:AdminCreateUser',
        'cognito-idp:AdminDeleteUser',
        'cognito-idp:AdminGetUser',
        'cognito-idp:AdminListGroupsForUser',
        'cognito-idp:AdminUpdateUserAttributes',
        'cognito-idp:AdminUserGlobalSignOut',
      ]),
    );
    expect(cognitoActions).toHaveLength(new Set(cognitoActions).size);
    // A sign-up site that also takes requests (domains + requestsAlso) adds the request table, nothing more on the pool.
    const both = accountCreationAppPolicy({ userPoolArn: POOL, rateLimitTableArn: RATE, accessRequestTableArn: REQUESTS, selfSignUp: true });
    expect(new Set(both.Statement.find((s) => s.Sid === 'AccountCreationCognito')!.Action)).toEqual(new Set(cognitoActions));
    expect(both.Statement.find((s) => s.Sid === 'AccessRequests')).toEqual({ Sid: 'AccessRequests', Effect: 'Allow', Action: ['dynamodb:Query', 'dynamodb:GetItem', 'dynamodb:PutItem'], Resource: REQUESTS });
  });

  it('a request-only site: only ListUsers on the pool, plus the request table’s calls (and the rate counters)', () => {
    const policy = accountCreationAppPolicy({ userPoolArn: POOL, rateLimitTableArn: RATE, accessRequestTableArn: REQUESTS, selfSignUp: false });
    expect(policy.Statement).toEqual([
      { Sid: 'AccountCreationRateLimits', Effect: 'Allow', Action: ['dynamodb:UpdateItem'], Resource: RATE },
      { Sid: 'AccountCreationCognito', Effect: 'Allow', Action: ['cognito-idp:ListUsers'], Resource: POOL },
      { Sid: 'AccessRequests', Effect: 'Allow', Action: [...ACCESS_REQUEST_APP_ACTIONS], Resource: REQUESTS },
    ]);
    const json = JSON.stringify(policy);
    for (const forbidden of ['AdminCreateUser', 'AdminDeleteUser', 'AdminUpdateUserAttributes', 'DeleteItem', 'Scan', '"*"']) expect(json).not.toContain(forbidden);
  });

  it('adds ses:SendEmail on the given identities; without account creation at all, no Cognito statement', () => {
    const policy = accountCreationAppPolicy({
      userPoolArn: POOL,
      rateLimitTableArn: RATE,
      selfSignUp: true,
      sesResourceArns: ['arn:aws:ses:us-east-1:ACCOUNT:identity/example.org'],
    });
    expect(policy.Statement.at(-1)).toEqual({ Sid: 'AccountCreationEmail', Effect: 'Allow', Action: ['ses:SendEmail'], Resource: ['arn:aws:ses:us-east-1:ACCOUNT:identity/example.org'] });
    expect(accountCreationAppPolicy({ userPoolArn: POOL, rateLimitTableArn: RATE, selfSignUp: false, sesResourceArns: [] }).Statement).toEqual([
      { Sid: 'AccountCreationRateLimits', Effect: 'Allow', Action: ['dynamodb:UpdateItem'], Resource: RATE },
    ]);
  });

  it('siteSettingsAppPolicy: GetItem, PutItem, DeleteItem on the settings table only', () => {
    const arn = 'arn:aws:dynamodb:us-east-1:ACCOUNT:table/site-settings';
    expect(siteSettingsAppPolicy(arn)).toEqual({
      Version: '2012-10-17',
      Statement: [{ Sid: 'SiteSettings', Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem'], Resource: arn }],
    });
  });
});
