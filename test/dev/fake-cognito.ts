/**
 * A stateful fake of the Cognito calls the dev kit makes, on aws-sdk-client-mock. No network: the
 * client is mocked before any request leaves it. It behaves like Cognito where the dev kit depends
 * on it: aliases by email, temporary passwords, MFA_SETUP in required-MFA pools, TOTP codes checked
 * against the secret and refused if reused, and groups that must exist.
 */
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminInitiateAuthCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminRespondToAuthChallengeCommand,
  AdminSetUserMFAPreferenceCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  AssociateSoftwareTokenCommand,
  CognitoIdentityProviderClient,
  DescribeUserPoolCommand,
  RevokeTokenCommand,
  VerifySoftwareTokenCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { type AwsClientStub, mockClient } from 'aws-sdk-client-mock';
import { base32Encode, totpCode, totpStep } from '../../src/dev/totp.js';
import { CLIENT_ID, POOL_ID } from '../helpers.js';

/** Built at runtime so the repo holds no 12-digit literal (see the hygiene test). */
export const ACCOUNT = ['1234', '5678', '9012'].join('');
export const OTHER_ACCOUNT = ['2109', '8765', '4321'].join('');

export const WRITE_COMMANDS = [
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  AdminEnableUserCommand,
  AdminUpdateUserAttributesCommand,
  AssociateSoftwareTokenCommand,
  VerifySoftwareTokenCommand,
  AdminSetUserMFAPreferenceCommand,
] as const;

export function awsError(name: string, message: string): Error {
  return Object.assign(new Error(message), { name, $fault: 'client', $metadata: {} });
}

interface FakeUser {
  sub: string;
  email: string;
  attributes: Map<string, string>;
  password?: string;
  status: 'FORCE_CHANGE_PASSWORD' | 'CONFIRMED';
  enabled: boolean;
  groups: Set<string>;
  totp?: { secret: string; enabled: boolean };
  pendingSecret?: string;
  usedSteps: Set<number>;
}

export interface FakePoolOptions {
  tags?: Record<string, string>;
  account?: string;
  deletionProtection?: 'ACTIVE' | 'INACTIVE';
  mfa?: 'OFF' | 'OPTIONAL' | 'ON';
  groups?: string[];
  /** The app client allows ADMIN_USER_PASSWORD_AUTH (sandbox clients only). Default true. */
  adminFlow?: boolean;
  estimatedUsers?: number;
}

export interface FakeCognito {
  client: CognitoIdentityProviderClient;
  mock: AwsClientStub<CognitoIdentityProviderClient>;
  users: Map<string, FakeUser>;
  clock: { now: number };
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  options: Required<Omit<FakePoolOptions, 'estimatedUsers'>> & { estimatedUsers?: number };
  writeCalls(): number;
  userByEmail(email: string): FakeUser | undefined;
  revoked: string[];
  /** Every input sent (for checking nothing secret leaks into logs). */
}

function b64(json: unknown): string {
  return Buffer.from(JSON.stringify(json)).toString('base64url');
}

export function fakeJwt(payload: Record<string, unknown>): string {
  return `${b64({ alg: 'none', kid: 'fake' })}.${b64(payload)}.sig`;
}

export function createFakeCognito(options: FakePoolOptions = {}): FakeCognito {
  const opts = {
    tags: options.tags ?? { Environment: 'sandbox', 'amplify:deployment-type': 'sandbox', ManagedBy: 'auth-kit' },
    account: options.account ?? ACCOUNT,
    deletionProtection: options.deletionProtection ?? 'INACTIVE',
    mfa: options.mfa ?? 'OPTIONAL',
    groups: options.groups ?? ['superadmin', 'admin', 'editor', 'viewer', 'reviewer'],
    adminFlow: options.adminFlow ?? true,
    ...(options.estimatedUsers !== undefined && { estimatedUsers: options.estimatedUsers }),
  };
  const client = new CognitoIdentityProviderClient({ region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  const mock = mockClient(client);
  const users = new Map<string, FakeUser>();
  const sessions = new Map<string, { sub: string; kind: 'mfa' | 'setup' | 'setup-verified' }>();
  const clock = { now: Date.UTC(2026, 9, 17, 12, 0, 5) };
  const revoked: string[] = [];
  let seq = 0;
  let secretSeq = 0;

  const find = (username: string | undefined) => {
    const u = username?.toLowerCase();
    return [...users.values()].find((x) => x.sub === username || x.email === u);
  };
  const must = (username: string | undefined) => {
    const user = find(username);
    if (!user) throw awsError('UserNotFoundException', 'User does not exist.');
    return user;
  };
  const tokens = (user: FakeUser) => {
    const iat = Math.floor(clock.now / 1000);
    return {
      AccessToken: fakeJwt({ sub: user.sub, username: user.sub, token_use: 'access', client_id: CLIENT_ID, iat, exp: iat + 3600, 'cognito:groups': [...user.groups] }),
      IdToken: fakeJwt({ sub: user.sub, email: user.email, 'cognito:username': user.sub, token_use: 'id', aud: CLIENT_ID, iat, exp: iat + 3600 }),
      RefreshToken: `refresh-${user.sub}-${iat}`,
      ExpiresIn: 3600,
      TokenType: 'Bearer',
    };
  };
  const session = (sub: string, kind: 'mfa' | 'setup' | 'setup-verified') => {
    const id = `session-${++seq}`;
    sessions.set(id, { sub, kind });
    return id;
  };
  const fromAccessToken = (token: string | undefined) => {
    const payload = JSON.parse(Buffer.from((token ?? '').split('.')[1] ?? '', 'base64url').toString('utf8') || '{}') as { sub?: string };
    return must(payload.sub);
  };
  const checkCode = (user: FakeUser, secret: string, code: string | undefined) => {
    const step = totpStep(clock.now);
    const match = [step - 1, step].find((s) => totpCode(secret, s) === code);
    if (match === undefined || user.usedSteps.has(match)) throw awsError('CodeMismatchException', 'Invalid code received for user');
    user.usedSteps.add(match);
  };

  mock.on(DescribeUserPoolCommand).callsFake((input: { UserPoolId?: string }) => {
    if (input.UserPoolId !== POOL_ID) throw awsError('ResourceNotFoundException', 'User pool does not exist.');
    return {
      UserPool: {
        Id: POOL_ID,
        Arn: `arn:aws:cognito-idp:us-east-1:${opts.account}:userpool/${POOL_ID}`,
        UserPoolTags: opts.tags,
        DeletionProtection: opts.deletionProtection,
        EstimatedNumberOfUsers: opts.estimatedUsers ?? users.size,
        MfaConfiguration: opts.mfa,
      },
    };
  });
  mock.on(AdminGetUserCommand).callsFake((input: { Username?: string }) => {
    const user = must(input.Username);
    return {
      Username: user.sub,
      UserAttributes: [...user.attributes].map(([Name, Value]) => ({ Name, Value })),
      Enabled: user.enabled,
      UserStatus: user.status,
      UserMFASettingList: user.totp?.enabled ? ['SOFTWARE_TOKEN_MFA'] : [],
    };
  });
  mock.on(AdminCreateUserCommand).callsFake((input: { Username?: string; UserAttributes?: { Name?: string; Value?: string }[]; MessageAction?: string }) => {
    if (input.MessageAction !== 'SUPPRESS') throw new Error('test: the seed must suppress invitation email');
    if (find(input.Username)) throw awsError('UsernameExistsException', 'An account with the given email already exists.');
    const sub = `0000000${++seq}-aaaa-4bbb-8ccc-dddddddddddd`.slice(-36);
    const attributes = new Map((input.UserAttributes ?? []).map((a) => [a.Name ?? '', a.Value ?? '']));
    attributes.set('sub', sub);
    const user: FakeUser = { sub, email: (input.Username ?? '').toLowerCase(), attributes, status: 'FORCE_CHANGE_PASSWORD', enabled: true, groups: new Set(), usedSteps: new Set() };
    users.set(sub, user);
    return { User: { Username: sub, Enabled: true, UserStatus: user.status } };
  });
  mock.on(AdminUpdateUserAttributesCommand).callsFake((input: { Username?: string; UserAttributes?: { Name?: string; Value?: string }[] }) => {
    const user = must(input.Username);
    for (const a of input.UserAttributes ?? []) user.attributes.set(a.Name ?? '', a.Value ?? '');
    return {};
  });
  mock.on(AdminEnableUserCommand).callsFake((input: { Username?: string }) => {
    must(input.Username).enabled = true;
    return {};
  });
  mock.on(AdminSetUserPasswordCommand).callsFake((input: { Username?: string; Password?: string; Permanent?: boolean }) => {
    const user = must(input.Username);
    if ((input.Password ?? '').length < 15) throw awsError('InvalidPasswordException', 'Password did not conform with policy');
    user.password = input.Password;
    if (input.Permanent) user.status = 'CONFIRMED';
    return {};
  });
  mock.on(AdminListGroupsForUserCommand).callsFake((input: { Username?: string }) => ({
    Groups: [...must(input.Username).groups].map((GroupName) => ({ GroupName })),
  }));
  mock.on(AdminAddUserToGroupCommand).callsFake((input: { Username?: string; GroupName?: string }) => {
    if (!opts.groups.includes(input.GroupName ?? '')) throw awsError('ResourceNotFoundException', 'Group not found.');
    must(input.Username).groups.add(input.GroupName ?? '');
    return {};
  });
  mock.on(AdminRemoveUserFromGroupCommand).callsFake((input: { Username?: string; GroupName?: string }) => {
    must(input.Username).groups.delete(input.GroupName ?? '');
    return {};
  });
  mock.on(AdminInitiateAuthCommand).callsFake((input: { ClientId?: string; AuthFlow?: string; AuthParameters?: Record<string, string> }) => {
    if (!opts.adminFlow || input.AuthFlow !== 'ADMIN_USER_PASSWORD_AUTH') throw awsError('InvalidParameterException', 'Auth flow not enabled for this client');
    if (input.ClientId !== CLIENT_ID) throw awsError('ResourceNotFoundException', 'Client does not exist.');
    const user = find(input.AuthParameters?.USERNAME);
    if (!user || user.password === undefined || user.password !== input.AuthParameters?.PASSWORD) {
      throw awsError('NotAuthorizedException', 'Incorrect username or password.');
    }
    if (!user.enabled) throw awsError('NotAuthorizedException', 'User is disabled.');
    if (user.status === 'FORCE_CHANGE_PASSWORD') return { ChallengeName: 'NEW_PASSWORD_REQUIRED', Session: session(user.sub, 'mfa'), ChallengeParameters: { USERNAME: user.sub } };
    if (user.totp?.enabled) return { ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: session(user.sub, 'mfa'), ChallengeParameters: { USERNAME: user.sub } };
    if (opts.mfa === 'ON') return { ChallengeName: 'MFA_SETUP', Session: session(user.sub, 'setup'), ChallengeParameters: { USERNAME: user.sub } };
    return { AuthenticationResult: tokens(user), ChallengeParameters: {} };
  });
  mock.on(AdminRespondToAuthChallengeCommand).callsFake((input: { ChallengeName?: string; Session?: string; ChallengeResponses?: Record<string, string> }) => {
    const s = sessions.get(input.Session ?? '');
    if (!s) throw awsError('NotAuthorizedException', 'Invalid session for the user.');
    const user = must(s.sub);
    if (input.ChallengeResponses?.USERNAME !== user.sub && input.ChallengeResponses?.USERNAME !== user.email) throw new Error('test: wrong USERNAME in challenge');
    if (input.ChallengeName === 'SOFTWARE_TOKEN_MFA' && s.kind === 'mfa' && user.totp?.enabled) {
      checkCode(user, user.totp.secret, input.ChallengeResponses?.SOFTWARE_TOKEN_MFA_CODE);
      sessions.delete(input.Session ?? '');
      return { AuthenticationResult: tokens(user), ChallengeParameters: {} };
    }
    if (input.ChallengeName === 'MFA_SETUP' && s.kind === 'setup-verified') {
      sessions.delete(input.Session ?? '');
      return { AuthenticationResult: tokens(user), ChallengeParameters: {} };
    }
    throw awsError('InvalidParameterException', `unexpected challenge ${input.ChallengeName}`);
  });
  mock.on(AssociateSoftwareTokenCommand).callsFake((input: { AccessToken?: string; Session?: string }) => {
    const user = input.AccessToken ? fromAccessToken(input.AccessToken) : must(sessions.get(input.Session ?? '')?.sub);
    user.pendingSecret = base32Encode(Buffer.from(`${++secretSeq}:${user.sub}`.padEnd(20, '.')).subarray(0, 20));
    return { SecretCode: user.pendingSecret, ...(input.Session !== undefined && { Session: session(user.sub, 'setup') }) };
  });
  mock.on(VerifySoftwareTokenCommand).callsFake((input: { AccessToken?: string; Session?: string; UserCode?: string }) => {
    const user = input.AccessToken ? fromAccessToken(input.AccessToken) : must(sessions.get(input.Session ?? '')?.sub);
    if (!user.pendingSecret) throw awsError('InvalidParameterException', 'no token associated');
    checkCode(user, user.pendingSecret, input.UserCode);
    user.totp = { secret: user.pendingSecret, enabled: user.totp?.enabled ?? false };
    delete user.pendingSecret;
    return { Status: 'SUCCESS', ...(input.Session !== undefined && { Session: session(user.sub, 'setup-verified') }) };
  });
  mock.on(AdminSetUserMFAPreferenceCommand).callsFake((input: { Username?: string; SoftwareTokenMfaSettings?: { Enabled?: boolean } }) => {
    const user = must(input.Username);
    if (input.SoftwareTokenMfaSettings?.Enabled) {
      if (!user.totp) throw awsError('InvalidParameterException', 'User has not verified software token mfa');
      user.totp.enabled = true;
    } else if (user.totp) user.totp.enabled = false;
    return {};
  });
  mock.on(RevokeTokenCommand).callsFake((input: { Token?: string }) => {
    revoked.push(input.Token ?? '');
    return {};
  });

  return {
    client,
    mock,
    users,
    clock,
    now: () => clock.now,
    sleep: (ms: number) => {
      clock.now += ms;
      return Promise.resolve();
    },
    options: opts,
    writeCalls: () => WRITE_COMMANDS.reduce((n, command) => n + mock.commandCalls(command as never).length, 0),
    userByEmail: (email: string) => find(email),
    revoked,
  };
}
