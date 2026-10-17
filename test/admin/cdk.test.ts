import { App, Stack, aws_iam as iam, aws_sns as sns } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { AuditLogTable } from '../../src/admin/cdk.js';
import { AUDIT_LOG_DENIED_ITEM_ACTIONS, AUDIT_TABLE_SCHEMA } from '../../src/admin/index.js';

function synth(build: (stack: Stack) => void, context: Record<string, string> = {}) {
  const app = new App({ context });
  const stack = new Stack(app, 'AuditStack', { env: { region: 'us-east-1' } });
  build(stack);
  return Template.fromStack(stack);
}

describe('AuditLogTable', () => {
  it('keeps the log: deletion protection, PITR, retained on delete, a full stream, the documented keys and indexes', () => {
    const template = synth((stack) => new AuditLogTable(stack, 'AuditLog'));
    template.resourceCountIs('AWS::DynamoDB::GlobalTable', 1);
    template.hasResource('AWS::DynamoDB::GlobalTable', { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({ IndexName: AUDIT_TABLE_SCHEMA.indexes.byActor.name, KeySchema: [{ AttributeName: 'actorKey', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }] }),
        Match.objectLike({ IndexName: AUDIT_TABLE_SCHEMA.indexes.byTarget.name, KeySchema: [{ AttributeName: 'targetKey', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }] }),
      ]),
      Replicas: [
        Match.objectLike({
          DeletionProtectionEnabled: true,
          PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
          Tags: Match.arrayWith([{ Key: 'ManagedBy', Value: 'auth-kit' }]),
        }),
      ],
    });
  });

  it('denies item edits and table deletion to everyone in the resource policy', () => {
    const template = synth((stack) => new AuditLogTable(stack, 'AuditLog'));
    const table = Object.values(template.findResources('AWS::DynamoDB::GlobalTable'))[0] as {
      Properties: { Replicas: { ResourcePolicy: { PolicyDocument: { Statement: { Effect: string; Principal: unknown; Action: string[] }[] } } }[] };
    };
    const statements = table.Properties.Replicas[0]!.ResourcePolicy.PolicyDocument.Statement;
    const denies = statements.filter((s) => s.Effect === 'Deny');
    expect(denies.every((s) => JSON.stringify(s.Principal).includes('*'))).toBe(true);
    const denied = denies.flatMap((s) => s.Action);
    for (const action of AUDIT_LOG_DENIED_ITEM_ACTIONS) expect(denied).toContain(action);
    expect(denied).toContain('dynamodb:DeleteTable');
    expect(statements.some((s) => s.Effect === 'Allow')).toBe(false);
  });

  it('in a sandbox: no deletion protection, removed with the stack, table deletion allowed, edits still denied', () => {
    const template = synth((stack) => new AuditLogTable(stack, 'AuditLog'), { 'amplify-backend-type': 'sandbox' });
    template.hasResource('AWS::DynamoDB::GlobalTable', { DeletionPolicy: 'Delete' });
    const json = JSON.stringify(template.toJSON());
    expect(json).toContain('"DeletionProtectionEnabled":false');
    expect(json).not.toContain('dynamodb:DeleteTable');
    expect(json).toContain('dynamodb:UpdateItem');
  });

  it('grants the app PutItem and Query only', () => {
    const template = synth((stack) => {
      const log = new AuditLogTable(stack, 'AuditLog');
      log.grantAppendAndQuery(new iam.Role(stack, 'Compute', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') }));
    });
    const policies = template.findResources('AWS::IAM::Policy');
    const actions = Object.values(policies).flatMap((p) =>
      (p as { Properties: { PolicyDocument: { Statement: { Action: string | string[] }[] } } }).Properties.PolicyDocument.Statement.flatMap((s) =>
        Array.isArray(s.Action) ? s.Action : [s.Action],
      ),
    );
    expect(new Set(actions)).toEqual(new Set(['dynamodb:PutItem', 'dynamodb:Query']));
    const json = JSON.stringify(policies);
    expect(json).toContain('/index/*');
    for (const forbidden of ['UpdateItem', 'DeleteItem', 'BatchWriteItem', 'GetItem', 'Scan']) expect(json).not.toContain(`dynamodb:${forbidden}`);
  });

  it('optionally alerts on any MODIFY or REMOVE through an EventBridge Pipe', () => {
    const template = synth((stack) => {
      new AuditLogTable(stack, 'AuditLog', { tamperAlerts: { topic: new sns.Topic(stack, 'Alerts') } });
    });
    template.hasResourceProperties('AWS::Pipes::Pipe', {
      SourceParameters: {
        DynamoDBStreamParameters: { StartingPosition: 'LATEST', BatchSize: 1 },
        FilterCriteria: { Filters: [{ Pattern: JSON.stringify({ eventName: ['MODIFY', 'REMOVE'] }) }] },
      },
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Action: 'sns:Publish' })]) },
    });
  });
});
