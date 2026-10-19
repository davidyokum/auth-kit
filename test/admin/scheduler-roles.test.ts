/**
 * Every EventBridge Scheduler schedule auth-kit creates (InviteExpirySweep, UnverifiedAccountSweep,
 * AccessRequestDigest), checked in the synthesized template: its execution role trusts
 * `scheduler.amazonaws.com` with a condition Scheduler can satisfy, and the schedule is created only
 * after that role and its policy. No AWS: nothing is deployed.
 *
 * Why: the v0.1.8-alpha demo deploy (2026-10-18) failed with "The execution role you provide must
 * allow AWS EventBridge Scheduler to assume the role". The trust policy's aws:SourceArn named
 * `arn:...:schedule/<group>/*`, but Scheduler presents the schedule GROUP's ARN
 * (`arn:...:schedule-group/<group>`), so the condition never matched and CreateSchedule refused the
 * role. AWS: "Do not scope the aws:SourceArn statement to a specific schedule or a schedule name
 * prefix. The ARN you specify must be a schedule group."
 * (https://docs.aws.amazon.com/scheduler/latest/UserGuide/cross-service-confused-deputy-prevention.html)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { App, Stack, aws_cognito as cognito } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ACCESS_REQUEST_DIGEST_BUNDLE_PATH,
  AccessRequestDigest,
  AccessRequestTable,
  AuditLogTable,
  INVITE_EXPIRY_BUNDLE_PATH,
  InviteExpirySweep,
  SiteSettingsTable,
  UNVERIFIED_SWEEP_BUNDLE_PATH,
  UnverifiedAccountSweep,
} from '../../src/admin/cdk.js';

const ROOT = join(import.meta.dirname, '..', '..');

beforeAll(() => {
  if ([INVITE_EXPIRY_BUNDLE_PATH, UNVERIFIED_SWEEP_BUNDLE_PATH, ACCESS_REQUEST_DIGEST_BUNDLE_PATH].every((p) => existsSync(join(ROOT, p, 'index.mjs')))) return;
  execFileSync(process.execPath, [join(ROOT, 'node_modules', 'tsup', 'dist', 'cli-default.js'), '--config', 'tsup.lambda.config.ts'], { cwd: ROOT, stdio: 'pipe' });
});

type Resource = { Type: string; Properties: Record<string, unknown>; DependsOn?: string | string[] };
type TrustStatement = { Effect: string; Principal: unknown; Action: unknown; Condition?: unknown };
type PolicyStatement = { Effect: string; Action: unknown; Resource: unknown };

/** One stack with every construct that creates a schedule (the ids are the constructs' own names in the README). */
function everyScheduledJob(): Record<string, Resource> {
  const app = new App();
  const stack = new Stack(app, 'Site', { env: { region: 'us-east-1' } });
  const userPool = new cognito.UserPool(stack, 'Pool');
  const auditLog = new AuditLogTable(stack, 'AuditLog');
  new InviteExpirySweep(stack, 'InviteExpiry', { userPool, auditLog });
  new UnverifiedAccountSweep(stack, 'Unverified', { userPool, auditLog });
  new AccessRequestDigest(stack, 'Digest', {
    userPool,
    requests: new AccessRequestTable(stack, 'Requests'),
    settings: new SiteSettingsTable(stack, 'Settings'),
    siteName: 'Example Reports',
    family: 'personal',
    signInUrl: 'https://reports.example.org/sign-in',
    peopleUrl: 'https://reports.example.org/admin/people',
    helpEmail: 'help@example.org',
    from: 'Example Reports <sign-in@mail.example.org>',
  });
  return Template.fromStack(stack).toJSON().Resources as Record<string, Resource>;
}

const dependsOn = (r: Resource) => (r.DependsOn === undefined ? [] : Array.isArray(r.DependsOn) ? r.DependsOn : [r.DependsOn]);

describe('every EventBridge Scheduler schedule auth-kit creates', () => {
  const resources = everyScheduledJob();
  const ofType = (type: string) => Object.entries(resources).filter(([, r]) => r.Type === type);
  const schedules = ofType('AWS::Scheduler::Schedule');

  it('there are three, one per construct (a new one is checked here too)', () => {
    expect(schedules.map(([id]) => id.replace(/Schedule[A-Z0-9]+$/, '')).sort()).toEqual(['Digest', 'InviteExpiry', 'Unverified']);
  });

  for (const [scheduleId, schedule] of schedules) {
    const target = schedule.Properties.Target as { Arn: unknown; RoleArn: { 'Fn::GetAtt': [string, string] } };
    const roleId = target.RoleArn['Fn::GetAtt'][0];
    const groupId = (schedule.Properties.GroupName as { Ref: string }).Ref;
    const role = resources[roleId]!;
    const rolePolicies = ofType('AWS::IAM::Policy').filter(([, p]) => JSON.stringify(p.Properties.Roles) === JSON.stringify([{ Ref: roleId }]));

    describe(scheduleId, () => {
      it('runs in its own schedule group, through an IAM role of its own', () => {
        expect(resources[groupId]?.Type).toBe('AWS::Scheduler::ScheduleGroup');
        expect(role.Type).toBe('AWS::IAM::Role');
        expect(target.RoleArn).toEqual({ 'Fn::GetAtt': [roleId, 'Arn'] });
        expect(schedules.filter(([, s]) => JSON.stringify((s.Properties.Target as { RoleArn: unknown }).RoleArn) === JSON.stringify(target.RoleArn))).toHaveLength(1);
      });

      it("the role's trust: scheduler.amazonaws.com only, this account, and aws:SourceArn = this schedule group's ARN (never a schedule's)", () => {
        const trust = (role.Properties.AssumeRolePolicyDocument as { Statement: TrustStatement[] }).Statement;
        expect(trust).toEqual([
          {
            Effect: 'Allow',
            Principal: { Service: 'scheduler.amazonaws.com' },
            Action: 'sts:AssumeRole',
            Condition: { StringEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' }, 'aws:SourceArn': { 'Fn::GetAtt': [groupId, 'Arn'] } } },
          },
        ]);
        // The broken shape: an ARN pattern on schedules (arn:...:schedule/<group>/*) never matches.
        expect(JSON.stringify(trust)).not.toMatch(/:schedule\/|ArnLike/);
      });

      it('the role may do one thing: invoke this schedule’s target', () => {
        const statements = rolePolicies.flatMap(([, p]) => (p.Properties.PolicyDocument as { Statement: PolicyStatement[] }).Statement);
        expect(statements).toEqual([{ Effect: 'Allow', Action: 'lambda:InvokeFunction', Resource: target.Arn }]);
      });

      it('is created only after its group, its role, and every policy on that role', () => {
        expect(rolePolicies.length).toBeGreaterThan(0);
        const deps = dependsOn(schedule);
        expect(deps).toContain(groupId);
        expect(deps).toContain(roleId);
        for (const [policyId] of rolePolicies) expect(deps).toContain(policyId);
      });
    });
  }
});

describe('schedules come only from the shared scheduled-job helper', () => {
  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? sources(join(dir, e.name)) : /\.(ts|tsx|mts)$/.test(e.name) ? [join(dir, e.name)] : [],
    );
  }

  it('one CfnSchedule in src (createScheduledJob), and no other Scheduler or scheduler-principal code', () => {
    const hits: string[] = [];
    for (const file of sources(join(ROOT, 'src'))) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of [/new\s+\w*\.?CfnSchedule\(/g, /aws-cdk-lib\/aws-scheduler/g, /AWS::Scheduler::Schedule['"]/g, /scheduler\.amazonaws\.com/g, /\bSchedule\s*\(\s*\w+\s*,/g]) {
        for (const _ of text.matchAll(pattern)) hits.push(`${relative(ROOT, file)}: ${pattern.source}`);
      }
    }
    expect(hits.sort()).toEqual(['src/admin/cdk.ts: new\\s+\\w*\\.?CfnSchedule\\(', 'src/admin/cdk.ts: scheduler\\.amazonaws\\.com']);
    const cdk = readFileSync(join(ROOT, 'src/admin/cdk.ts'), 'utf8');
    const helper = cdk.slice(cdk.indexOf('function createScheduledJob('), cdk.indexOf('// ---- The invite-expiry sweep'));
    expect(helper).toMatch(/new scheduler\.CfnSchedule\(/);
    expect(helper).toMatch(/schedule\.node\.addDependency\(schedulerRole\)/);
  });
});
