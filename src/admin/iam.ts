/**
 * IAM policy documents for the admin module, as plain JSON, for roles that aren't defined in CDK
 * (Amplify Hosting's SSR compute role is set in the Amplify console). The CDK construct in
 * `auth-kit/admin/cdk` builds the same statements.
 */

export interface IamStatement {
  Sid?: string;
  Effect: 'Allow' | 'Deny';
  Principal?: '*' | Record<string, string | string[]>;
  Action: string[];
  Resource: string | string[];
}

export interface IamPolicyDocument {
  Version: '2012-10-17';
  Statement: IamStatement[];
}

/** The only two calls the audit store makes. */
export const AUDIT_LOG_APP_ACTIONS = { append: ['dynamodb:PutItem'], read: ['dynamodb:Query'] } as const;

/**
 * Item-level edits nobody may make on the audit table, owners and account admins included.
 * `BatchWriteItem` is here too: its puts aren't conditional, so it could replace a row.
 */
export const AUDIT_LOG_DENIED_ITEM_ACTIONS = [
  'dynamodb:UpdateItem',
  'dynamodb:DeleteItem',
  'dynamodb:BatchWriteItem',
  'dynamodb:PartiQLUpdate',
  'dynamodb:PartiQLDelete',
] as const;

/**
 * The app's identity policy for the audit table: `PutItem` on the table and `Query` on the table and
 * its indexes. Nothing else: no `GetItem`, `Scan`, `UpdateItem`, `DeleteItem`, or `BatchWriteItem`.
 *
 * IAM has no condition key for a `ConditionExpression`, so it can't force `attribute_not_exists` on
 * `PutItem`. The store always sends it; a stolen app role could still replace a row it has read. The
 * table's stream and point-in-time recovery keep the original, and the construct's optional
 * tamper alert reports any MODIFY or REMOVE within seconds.
 */
export function auditLogAppPolicy(tableArn: string): IamPolicyDocument {
  return {
    Version: '2012-10-17',
    Statement: [
      { Sid: 'AuditLogAppend', Effect: 'Allow', Action: [...AUDIT_LOG_APP_ACTIONS.append], Resource: tableArn },
      { Sid: 'AuditLogQuery', Effect: 'Allow', Action: [...AUDIT_LOG_APP_ACTIONS.read], Resource: [tableArn, `${tableArn}/index/*`] },
    ],
  };
}

/**
 * The table's resource policy: deny item edits (and, outside sandboxes, deleting the table) to every
 * principal. A resource policy can't reference its own table at creation, so `Resource` is `*`, which
 * in a table's policy means that table.
 */
export function auditLogResourcePolicy(options: { denyDeleteTable?: boolean } = {}): IamPolicyDocument {
  const statements: IamStatement[] = [
    { Sid: 'AuditLogIsAppendOnly', Effect: 'Deny', Principal: '*', Action: [...AUDIT_LOG_DENIED_ITEM_ACTIONS], Resource: '*' },
  ];
  if (options.denyDeleteTable !== false) {
    statements.push({ Sid: 'AuditLogIsKept', Effect: 'Deny', Principal: '*', Action: ['dynamodb:DeleteTable'], Resource: '*' });
  }
  return { Version: '2012-10-17', Statement: statements };
}

/** Cognito calls the People actions make (plus `AdminGetUser`, which auth-kit/server's live checks use). */
export const PEOPLE_ADMIN_COGNITO_ACTIONS = {
  read: ['cognito-idp:ListUsers', 'cognito-idp:ListUsersInGroup', 'cognito-idp:AdminListGroupsForUser', 'cognito-idp:AdminGetUser'],
  write: [
    'cognito-idp:AdminCreateUser',
    'cognito-idp:AdminAddUserToGroup',
    'cognito-idp:AdminRemoveUserFromGroup',
    'cognito-idp:AdminDisableUser',
    'cognito-idp:AdminEnableUser',
    'cognito-idp:AdminUserGlobalSignOut',
  ],
  delete: ['cognito-idp:AdminDeleteUser'],
} as const;

export interface PeopleAdminPolicyOptions {
  userPoolArn: string;
  /** The audit table, to include its append-and-query statements. */
  auditTableArn?: string;
  /** Grant `AdminDeleteUser` (owners delete accounts). Default true. */
  allowDelete?: boolean;
  /** SES identity (and configuration set) ARNs, for the invite mailer. */
  sesResourceArns?: readonly string[];
}

/** Everything the server role needs to run the People page. */
export function peopleAdminPolicy(options: PeopleAdminPolicyOptions): IamPolicyDocument {
  const statements: IamStatement[] = [
    { Sid: 'PeopleRead', Effect: 'Allow', Action: [...PEOPLE_ADMIN_COGNITO_ACTIONS.read], Resource: options.userPoolArn },
    {
      Sid: 'PeopleWrite',
      Effect: 'Allow',
      Action: [...PEOPLE_ADMIN_COGNITO_ACTIONS.write, ...(options.allowDelete === false ? [] : PEOPLE_ADMIN_COGNITO_ACTIONS.delete)],
      Resource: options.userPoolArn,
    },
  ];
  if (options.sesResourceArns && options.sesResourceArns.length > 0) {
    statements.push({ Sid: 'InviteEmail', Effect: 'Allow', Action: ['ses:SendEmail'], Resource: [...options.sesResourceArns] });
  }
  if (options.auditTableArn) statements.push(...auditLogAppPolicy(options.auditTableArn).Statement);
  return { Version: '2012-10-17', Statement: statements };
}

/** The Cognito calls the invite-expiry sweep makes: list, read groups, disable, remove admin roles. */
export const INVITE_EXPIRY_COGNITO_ACTIONS = [
  'cognito-idp:ListUsers',
  'cognito-idp:AdminListGroupsForUser',
  'cognito-idp:AdminDisableUser',
  'cognito-idp:AdminRemoveUserFromGroup',
] as const;

/**
 * Everything the scheduled sweep needs and nothing else: those four calls on one pool and `PutItem`
 * on the audit table (it writes intent and result rows; it never reads the log). Logging permissions
 * belong to whoever runs it (the construct grants its own log group).
 */
export function inviteExpirySweepPolicy(options: { userPoolArn: string; auditTableArn: string }): IamPolicyDocument {
  return {
    Version: '2012-10-17',
    Statement: [
      { Sid: 'InviteExpiryCognito', Effect: 'Allow', Action: [...INVITE_EXPIRY_COGNITO_ACTIONS], Resource: options.userPoolArn },
      { Sid: 'InviteExpiryAudit', Effect: 'Allow', Action: [...AUDIT_LOG_APP_ACTIONS.append], Resource: options.auditTableArn },
    ],
  };
}
