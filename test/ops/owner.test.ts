import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
  DescribeUserPoolCommand,
  ListUsersCommand,
  ListUsersInGroupCommand,
  type UserType,
} from '@aws-sdk/client-cognito-identity-provider';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InviteEmail } from '../../src/admin/mailer.js';
import { createOwner } from '../../src/ops/owner.js';
import { ACCOUNT, OTHER_ACCOUNT } from '../dev/fake-cognito.js';
import { POOL_ID } from '../helpers.js';

const cognito = mockClient(CognitoIdentityProviderClient);
const client = new CognitoIdentityProviderClient({ region: 'us-east-1' });

function user(email: string, extra: { verified?: boolean; status?: string } = {}): UserType {
  return {
    Username: email,
    Enabled: true,
    UserStatus: (extra.status ?? 'CONFIRMED') as UserType['UserStatus'],
    UserCreateDate: new Date('2026-11-01T00:00:00Z'),
    Attributes: [
      { Name: 'sub', Value: `sub-${email}` },
      { Name: 'email', Value: email },
      ...(extra.verified ? [{ Name: 'email_verified', Value: 'true' }] : []),
    ],
  };
}

function pool(account = ACCOUNT) {
  cognito.on(DescribeUserPoolCommand).resolves({ UserPool: { Id: POOL_ID, Name: 'reports', Arn: `arn:aws:cognito-idp:us-east-1:${account}:userpool/${POOL_ID}` } });
}

function run(mailer: { sendInvite: (input: InviteEmail) => Promise<void> }, extra: Partial<Parameters<typeof createOwner>[0]> = {}) {
  return createOwner({
    client,
    mailer,
    userPoolId: POOL_ID,
    expectedAccountId: ACCOUNT,
    email: 'Owner@Example.org',
    siteName: 'Example Reports',
    signInUrl: 'https://reports.example.org/sign-in',
    family: 'personal',
    helpEmail: 'help@example.org',
    now: () => new Date('2026-11-14T12:00:00Z'),
    ...extra,
  });
}

beforeEach(() => {
  cognito.reset();
});

describe('auth-kit owner', () => {
  it('creates the owner with no password, adds them to the owner group, and sends the first-visit invite', async () => {
    pool();
    cognito.on(ListUsersInGroupCommand).resolves({ Users: [] });
    cognito.on(ListUsersCommand).resolves({ Users: [] });
    cognito.on(AdminCreateUserCommand).resolves({ User: user('owner@example.org') });
    cognito.on(AdminAddUserToGroupCommand).resolves({});
    const sendInvite = vi.fn<(input: InviteEmail) => Promise<void>>(() => Promise.resolve());
    const report = await run({ sendInvite });
    expect(report.outcome).toBe('created');
    const create = cognito.commandCalls(AdminCreateUserCommand)[0]!.args[0].input;
    expect(create.Username).toBe('owner@example.org');
    expect(create.MessageAction).toBe('SUPPRESS');
    expect(create).not.toHaveProperty('TemporaryPassword');
    expect(cognito.commandCalls(AdminAddUserToGroupCommand)[0]!.args[0].input.GroupName).toBe('owner');
    const invite = sendInvite.mock.calls[0]![0];
    expect(invite).toMatchObject({ email: 'owner@example.org', roleLabel: 'Owner', signInUrl: 'https://reports.example.org/sign-in', theme: 'personal' });
    expect(invite.expiresAt.toISOString()).toBe('2026-11-21T12:00:00.000Z');
  });

  it('refuses a pool in another account before anything is written', async () => {
    pool(OTHER_ACCOUNT);
    await expect(run({ sendInvite: vi.fn() })).rejects.toThrow(/not \d{12}\. Nothing was changed/);
    expect(cognito.commandCalls(AdminCreateUserCommand)).toHaveLength(0);
  });

  it('refuses when the site already has a different owner', async () => {
    pool();
    cognito.on(ListUsersInGroupCommand).resolves({ Users: [user('someone@example.org', { verified: true })] });
    await expect(run({ sendInvite: vi.fn() })).rejects.toThrow(/already has an owner \(someone@example\.org\)/);
    expect(cognito.commandCalls(AdminCreateUserCommand)).toHaveLength(0);
  });

  it('refuses an address that has already signed in', async () => {
    pool();
    cognito.on(ListUsersInGroupCommand).resolves({ Users: [] });
    cognito.on(ListUsersCommand).resolves({ Users: [user('owner@example.org', { verified: true })] });
    await expect(run({ sendInvite: vi.fn() })).rejects.toThrow(/has already signed in/);
  });

  it('run again for an owner who hasn’t signed in yet: a fresh invite, nothing created twice', async () => {
    pool();
    cognito.on(ListUsersInGroupCommand).resolves({ Users: [user('owner@example.org')] });
    cognito.on(ListUsersCommand).resolves({ Users: [user('owner@example.org')] });
    const sendInvite = vi.fn(() => Promise.resolve());
    const report = await run({ sendInvite });
    expect(report.outcome).toBe('reinvited');
    expect(cognito.commandCalls(AdminCreateUserCommand)).toHaveLength(0);
    expect(cognito.commandCalls(AdminAddUserToGroupCommand)).toHaveLength(0);
    expect(sendInvite).toHaveBeenCalledTimes(1);
  });

  it('a dry run lists the steps and writes and sends nothing', async () => {
    pool();
    cognito.on(ListUsersInGroupCommand).resolves({ Users: [] });
    cognito.on(ListUsersCommand).resolves({ Users: [] });
    const sendInvite = vi.fn();
    const lines: string[] = [];
    const report = await run({ sendInvite }, { dryRun: true, log: (l) => lines.push(l) });
    expect(report.outcome).toBe('planned');
    expect(report.steps.map((s) => s.split(' ')[0])).toEqual(['AdminCreateUser', 'AdminAddUserToGroup', 'SES']);
    expect(lines.filter((l) => l.startsWith('Would run:'))).toHaveLength(3);
    expect(sendInvite).not.toHaveBeenCalled();
    expect(cognito.commandCalls(AdminCreateUserCommand)).toHaveLength(0);
  });

  it('undoes an account the pool gave a password (it couldn’t sign in with a code)', async () => {
    pool();
    cognito.on(ListUsersInGroupCommand).resolves({ Users: [] });
    cognito.on(ListUsersCommand).resolves({ Users: [] });
    cognito.on(AdminCreateUserCommand).resolves({ User: user('owner@example.org', { status: 'FORCE_CHANGE_PASSWORD' }) });
    cognito.on(AdminDeleteUserCommand).resolves({});
    await expect(run({ sendInvite: vi.fn() })).rejects.toThrow(/deleted again/);
    expect(cognito.commandCalls(AdminDeleteUserCommand)).toHaveLength(1);
  });

  it('wants an https sign-in address, a real email address, and a 12-digit account', async () => {
    pool();
    await expect(run({ sendInvite: vi.fn() }, { signInUrl: 'http://reports.example.org/sign-in' })).rejects.toThrow(/https/);
    await expect(run({ sendInvite: vi.fn() }, { email: 'not-an-address' })).rejects.toThrow(/isn't an email address/);
    await expect(run({ sendInvite: vi.fn() }, { expectedAccountId: '123' })).rejects.toThrow(/12-digit/);
  });
});

describe('npx auth-kit owner', () => {
  it('passes the flags through, sends from the family’s sign-in@ address, and needs the account', async () => {
    const { runCli } = await import('../../src/dev/cli.js');
    pool();
    cognito.on(ListUsersInGroupCommand).resolves({ Users: [] });
    cognito.on(ListUsersCommand).resolves({ Users: [] });
    cognito.on(AdminCreateUserCommand).resolves({ User: user('owner@example.org') });
    cognito.on(AdminAddUserToGroupCommand).resolves({});
    const out: string[] = [];
    const err: string[] = [];
    const mailers: { from: string }[] = [];
    const io = {
      cwd: '/nowhere',
      env: {},
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
      createClient: () => client,
      createMailer: (input: { from: string }) => {
        mailers.push(input);
        return { sendInvite: () => Promise.resolve() };
      },
    };
    const base = ['owner', '--email', 'owner@example.org', '--site-name', 'Example Reports', '--sign-in-url', 'https://reports.example.org/sign-in', '--family', 'personal', '--help-address', 'help@example.org', '--profile', 'personal', '--pool', POOL_ID];
    expect(await runCli(base, io)).toBe(2);
    expect(err.join('\n')).toMatch(/needs --account/);
    expect(await runCli([...base, '--account', ACCOUNT], io)).toBe(0);
    expect(mailers[0]!.from).toBe('Example Reports <sign-in@yokum.app>');
    expect(out.at(-1)).toMatch(/^Made owner@example\.org as the owner\./);
  });
});
