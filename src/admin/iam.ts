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

/**
 * The calls the resource membership store makes (`auth-kit/resources`): `GetItem` and `Query`
 * (consistent reads, and the `byPerson` index), and transactions of `Put` and `Delete`, which IAM
 * authorizes as `PutItem` and `DeleteItem`. No `UpdateItem`, `Scan`, `BatchWriteItem`, or
 * `ConditionCheckItem`.
 */
export const RESOURCE_ACCESS_APP_ACTIONS = {
  item: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem'],
  query: ['dynamodb:Query'],
} as const;

/**
 * The app's identity policy for the resource membership table (`ResourceAccessTable`): the item calls
 * on the table, and `Query` on the table and its index. Nothing else, and only this table.
 */
export function resourceAccessAppPolicy(tableArn: string): IamPolicyDocument {
  return {
    Version: '2012-10-17',
    Statement: [
      { Sid: 'ResourceAccessItems', Effect: 'Allow', Action: [...RESOURCE_ACCESS_APP_ACTIONS.item], Resource: tableArn },
      { Sid: 'ResourceAccessQuery', Effect: 'Allow', Action: [...RESOURCE_ACCESS_APP_ACTIONS.query], Resource: [tableArn, `${tableArn}/index/*`] },
    ],
  };
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
  /** Grant `AdminDeleteUser` (the owner and Super admins delete accounts). Default true. */
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

/**
 * The Cognito calls the invite-expiry sweep makes: list everyone, read each due invite's groups,
 * list the owners (so it never disables the last one), disable, remove admin roles.
 */
export const INVITE_EXPIRY_COGNITO_ACTIONS = [
  'cognito-idp:ListUsers',
  'cognito-idp:AdminListGroupsForUser',
  'cognito-idp:ListUsersInGroup',
  'cognito-idp:AdminDisableUser',
  'cognito-idp:AdminRemoveUserFromGroup',
] as const;

/**
 * Everything the scheduled sweep needs and nothing else: those calls on one pool, `PutItem` on the
 * audit table (it writes intent, result, and refusal rows; it never reads the log), and, when it
 * warns a last owner by email, `ses:SendEmail` on the sending identity (and configuration set).
 * Logging permissions belong to whoever runs it (the construct grants its own log group).
 */
export function inviteExpirySweepPolicy(options: {
  userPoolArn: string;
  auditTableArn: string;
  /** SES identity (and configuration set) ARNs, for the last-owner warning. */
  sesResourceArns?: readonly string[];
}): IamPolicyDocument {
  const statements: IamStatement[] = [
    { Sid: 'InviteExpiryCognito', Effect: 'Allow', Action: [...INVITE_EXPIRY_COGNITO_ACTIONS], Resource: options.userPoolArn },
    { Sid: 'InviteExpiryAudit', Effect: 'Allow', Action: [...AUDIT_LOG_APP_ACTIONS.append], Resource: options.auditTableArn },
  ];
  if (options.sesResourceArns && options.sesResourceArns.length > 0) {
    statements.push({ Sid: 'InviteExpiryOwnerWarning', Effect: 'Allow', Action: ['ses:SendEmail'], Resource: [...options.sesResourceArns] });
  }
  return { Version: '2012-10-17', Statement: statements };
}

// ---- Account creation (ADR 0023) and site settings (ADR 0024) -----------------------------------

/** The request queue's calls from the app: list (`Query`), read one (`GetItem`), file and settle (`PutItem`). */
export const ACCESS_REQUEST_APP_ACTIONS = ['dynamodb:Query', 'dynamodb:GetItem', 'dynamodb:PutItem'] as const;
/** The daily digest's calls: list, and delete requests past their retention. */
export const ACCESS_REQUEST_DIGEST_ACTIONS = ['dynamodb:Query', 'dynamodb:DeleteItem'] as const;
/** The rate-limit counters: one `UpdateItem` per attempt. */
export const RATE_LIMIT_APP_ACTIONS = ['dynamodb:UpdateItem'] as const;
/** Site settings: read, write with a version check, remove. */
export const SITE_SETTINGS_APP_ACTIONS = ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem'] as const;

/** Cognito calls the sign-up route makes: find the address, create the account (and delete it again if a later step fails). */
export const SIGN_UP_COGNITO_ACTIONS = ['cognito-idp:ListUsers', 'cognito-idp:AdminCreateUser', 'cognito-idp:AdminDeleteUser'] as const;
/** Cognito calls a member's own account actions make (sign-up sites): read themselves, change their address, delete themselves. */
export const SELF_SERVICE_COGNITO_ACTIONS = [
  'cognito-idp:ListUsers',
  'cognito-idp:AdminGetUser',
  'cognito-idp:AdminListGroupsForUser',
  'cognito-idp:AdminUpdateUserAttributes',
  'cognito-idp:AdminUserGlobalSignOut',
  'cognito-idp:AdminDeleteUser',
] as const;
/** The unverified-account sweep: list everyone, read a due account's roles, delete it. */
export const UNVERIFIED_SWEEP_COGNITO_ACTIONS = ['cognito-idp:ListUsers', 'cognito-idp:AdminListGroupsForUser', 'cognito-idp:AdminDeleteUser'] as const;
/** The digest reads who manages people. */
export const ACCESS_REQUEST_DIGEST_COGNITO_ACTIONS = ['cognito-idp:ListUsersInGroup'] as const;

/**
 * The app's policy for account creation: the sign-up and request routes, the request queue on the
 * People page, and (on sign-up sites) members' own account actions. Each table gets only its calls.
 */
export function accountCreationAppPolicy(options: {
  userPoolArn: string;
  /** `RateLimitTable` (the routes and the email change). */
  rateLimitTableArn: string;
  /** `AccessRequestTable`, where the site takes requests. */
  accessRequestTableArn?: string;
  /** Sign-up sites: the sign-up route's and members' own Cognito calls. */
  selfSignUp: boolean;
  /** SES identity (and configuration set) ARNs, for "you already have an account" and the notices. */
  sesResourceArns?: readonly string[];
}): IamPolicyDocument {
  const cognito = [
    ...(options.selfSignUp ? [...SIGN_UP_COGNITO_ACTIONS, ...SELF_SERVICE_COGNITO_ACTIONS] : []),
    // The request route checks whether the address has an account.
    ...(options.accessRequestTableArn ? ['cognito-idp:ListUsers'] : []),
  ];
  const statements: IamStatement[] = [{ Sid: 'AccountCreationRateLimits', Effect: 'Allow', Action: [...RATE_LIMIT_APP_ACTIONS], Resource: options.rateLimitTableArn }];
  if (cognito.length > 0) statements.push({ Sid: 'AccountCreationCognito', Effect: 'Allow', Action: [...new Set(cognito)], Resource: options.userPoolArn });
  if (options.accessRequestTableArn) statements.push({ Sid: 'AccessRequests', Effect: 'Allow', Action: [...ACCESS_REQUEST_APP_ACTIONS], Resource: options.accessRequestTableArn });
  if (options.sesResourceArns && options.sesResourceArns.length > 0) {
    statements.push({ Sid: 'AccountCreationEmail', Effect: 'Allow', Action: ['ses:SendEmail'], Resource: [...options.sesResourceArns] });
  }
  return { Version: '2012-10-17', Statement: statements };
}

/** The app's policy for the site settings table (`createSignInHelp`, `createSignInHelpActions`). */
export function siteSettingsAppPolicy(tableArn: string): IamPolicyDocument {
  return { Version: '2012-10-17', Statement: [{ Sid: 'SiteSettings', Effect: 'Allow', Action: [...SITE_SETTINGS_APP_ACTIONS], Resource: tableArn }] };
}
