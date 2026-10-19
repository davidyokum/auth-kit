/**
 * The membership table's construct and least-privilege grant, the app's IAM policy JSON, and the
 * emails a Manager's invite sends (the admins' alert and the invite itself).
 */
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { App, Stack, aws_iam as iam } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { mockClient } from 'aws-sdk-client-mock';
import { describe, expect, it } from 'vitest';
import { ResourceAccessTable } from '../../src/admin/cdk.js';
import {
  RESOURCE_ACCESS_APP_ACTIONS,
  type ResourceInviteAlert,
  createSesInviteMailer,
  renderInviteEmail,
  renderResourceInviteAlertEmail,
  resourceAccessAppPolicy,
} from '../../src/admin/index.js';
import { RESOURCE_TABLE_SCHEMA } from '../../src/resources/index.js';

function synth(build: (stack: Stack) => void, context: Record<string, string> = {}) {
  const app = new App({ context });
  const stack = new Stack(app, 'ResourceStack', { env: { region: 'us-east-1' } });
  build(stack);
  return Template.fromStack(stack);
}

function grantedActions(template: Template): string[] {
  return Object.values(template.findResources('AWS::IAM::Policy')).flatMap((p) =>
    (p as { Properties: { PolicyDocument: { Statement: { Action: string | string[] }[] } } }).Properties.PolicyDocument.Statement.flatMap((s) =>
      Array.isArray(s.Action) ? s.Action : [s.Action],
    ),
  );
}

describe('ResourceAccessTable', () => {
  it('keeps memberships: the documented keys and byPerson index, PITR, deletion protection, retained, table deletion denied', () => {
    const template = synth((stack) => new ResourceAccessTable(stack, 'Access'));
    template.resourceCountIs('AWS::DynamoDB::GlobalTable', 1);
    template.hasResource('AWS::DynamoDB::GlobalTable', { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: RESOURCE_TABLE_SCHEMA.partitionKey, KeyType: 'HASH' },
        { AttributeName: RESOURCE_TABLE_SCHEMA.sortKey, KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        Match.objectLike({
          IndexName: 'byPerson',
          KeySchema: [
            { AttributeName: 'personKey', KeyType: 'HASH' },
            { AttributeName: 'pk', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        }),
      ],
      Replicas: [
        Match.objectLike({
          DeletionProtectionEnabled: true,
          PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
          Tags: Match.arrayWith([
            { Key: 'Component', Value: 'resource-access' },
            { Key: 'ManagedBy', Value: 'auth-kit' },
          ]),
          ResourcePolicy: { PolicyDocument: Match.objectLike({ Statement: [Match.objectLike({ Effect: 'Deny', Action: 'dynamodb:DeleteTable', Principal: '*' })] }) },
        }),
      ],
    });
  });

  it('in a sandbox: no deletion protection, removed with the stack, no resource policy', () => {
    const template = synth((stack) => new ResourceAccessTable(stack, 'Access'), { 'amplify-backend-type': 'sandbox' });
    template.hasResource('AWS::DynamoDB::GlobalTable', { DeletionPolicy: 'Delete' });
    const json = JSON.stringify(template.toJSON());
    expect(json).toContain('"DeletionProtectionEnabled":false');
    expect(json).not.toContain('DeleteTable');
  });

  it('grants the app GetItem, PutItem, DeleteItem, and Query on this table and its index only', () => {
    const template = synth((stack) => {
      const table = new ResourceAccessTable(stack, 'Access');
      table.grantApp(new iam.Role(stack, 'Compute', { assumedBy: new iam.ServicePrincipal('amplify.amazonaws.com') }));
    });
    expect(new Set(grantedActions(template))).toEqual(new Set(['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem', 'dynamodb:Query']));
    const json = JSON.stringify(template.findResources('AWS::IAM::Policy'));
    expect(json).toContain('/index/*');
    for (const forbidden of ['UpdateItem', 'Scan', 'BatchWriteItem', 'ConditionCheckItem', 'dynamodb:*']) expect(json).not.toContain(forbidden);
  });
});

describe('resourceAccessAppPolicy', () => {
  it('is the same grant as plain JSON, for a role defined outside CDK', () => {
    const arn = 'arn:aws:dynamodb:us-east-1:ACCOUNT:table/resource-access';
    expect(resourceAccessAppPolicy(arn)).toEqual({
      Version: '2012-10-17',
      Statement: [
        { Sid: 'ResourceAccessItems', Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem'], Resource: arn },
        { Sid: 'ResourceAccessQuery', Effect: 'Allow', Action: ['dynamodb:Query'], Resource: [arn, `${arn}/index/*`] },
      ],
    });
    expect([...RESOURCE_ACCESS_APP_ACTIONS.item, ...RESOURCE_ACCESS_APP_ACTIONS.query]).toHaveLength(4);
  });
});

const ALERT: ResourceInviteAlert = {
  siteName: 'Example Reports',
  recipients: [
    { sub: 'owner-1', email: 'owner@example.org' },
    { sub: 'acp-1', email: 'admin@example.org' },
    { sub: 'dup', email: 'owner@example.org' },
  ],
  invited: { sub: 'n-1', email: 'new@example.com', name: 'Nia' },
  invitedBy: { sub: 'm-1', email: 'ann@example.org' },
  item: { type: 'project', id: 'p-1', noun: 'project', name: 'Q3 <plan>' },
  role: 'contributor',
  at: new Date('2026-10-17T12:00:00.000Z'),
  context: { ip: '203.0.113.24', userAgent: 'Test Browser', requestId: 'req-1' },
};

describe('the admins’ alert for a Manager’s invite', () => {
  it('says who invited whom, to what, with which role, and what to do if it’s unexpected', () => {
    const email = renderResourceInviteAlertEmail(ALERT);
    expect(email.subject).toBe('Example Reports: ann@example.org invited new@example.com');
    expect(email.text).toContain('ann@example.org invited Nia (new@example.com) to Example Reports, as Contributor of the project “Q3 <plan>”.');
    expect(email.text).toContain('no admin role: it has access to the project “Q3 <plan>”, and nothing else on the site');
    expect(email.text).toContain('From: 203.0.113.24 (Test Browser)');
    expect(email.text).toMatch(/disable the account from the People page/);
    expect(email.html).toContain('Q3 &lt;plan&gt;');
    expect(email.html).not.toContain('<plan>');
    const unnamed = renderResourceInviteAlertEmail({ ...ALERT, item: { type: 'project', id: 'p-9', noun: 'project' } });
    expect(unnamed.text).toContain('as Contributor of a project whose name couldn’t be read');
    expect(unnamed.text + unnamed.html + unnamed.subject).not.toContain('p-9');
  });

  it('the SES mailer sends one message to every recipient, once each, or throws with none', async () => {
    const ses = new SESv2Client({ region: 'us-east-1', credentials: { accessKeyId: 'x', secretAccessKey: 'y' } });
    const mock = mockClient(ses);
    mock.on(SendEmailCommand).resolves({});
    const mailer = createSesInviteMailer({ from: 'Example Reports <sign-in@yokum.app>', site: { siteName: 'Example Reports', theme: 'personal', help: 'help@example.org' }, client: ses });
    await mailer.resourceInviteSent(ALERT);
    const input = mock.commandCalls(SendEmailCommand)[0]!.args[0].input;
    expect(input.Destination?.ToAddresses).toEqual(['owner@example.org', 'admin@example.org']);
    expect(input.Content?.Simple?.Subject?.Data).toBe('Example Reports: ann@example.org invited new@example.com');
    await expect(mailer.resourceInviteSent({ ...ALERT, recipients: [] })).rejects.toThrow(/no admin who manages people/);
    const custom = createSesInviteMailer({ from: 'Example Reports <sign-in@yokum.app>', site: { siteName: 'Example Reports', theme: 'personal', help: 'help@example.org' }, client: ses, renderResourceInvite: () => ({ subject: 'S', text: 'T', html: 'H' }) });
    await custom.resourceInviteSent(ALERT);
    expect(mock.commandCalls(SendEmailCommand).at(-1)!.args[0].input.Content?.Simple?.Subject?.Data).toBe('S');
  });
});

describe('the invite email for one item', () => {
  it('says who invited them and to what, still with no password or code', () => {
    const email = renderInviteEmail({
      email: 'new@example.com',
      name: 'Nia',
      siteName: 'Example Reports',
      signInUrl: 'https://reports.example.org/sign-in',
      expiresAt: new Date('2026-10-24T12:00:00.000Z'),
      item: { noun: 'project', name: 'Q3 plan', role: 'reader', invitedBy: 'ann@example.org' },
    });
    expect(email.subject).toBe('ann@example.org invited you to Example Reports');
    expect(email.text).toContain('ann@example.org added you to the project “Q3 plan” as Reader.');
    expect(email.html).toContain('added you to <strong>the project “Q3 plan”</strong> as Reader.');
    expect(email.text).toContain('This invitation expires on Saturday, October 24 at 8:00 AM Eastern.');
    expect(`${email.text}${email.html}`).not.toMatch(/\{####\}|project:/);
  });
});
