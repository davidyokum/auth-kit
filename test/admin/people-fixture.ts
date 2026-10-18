import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  type AdminCreateUserCommandInput,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  ListUsersInGroupCommand,
  type UserType,
} from '@aws-sdk/client-cognito-identity-provider';
import { mockClient } from 'aws-sdk-client-mock';
import {
  type AuditEvent,
  type AuditLogStore,
  createMemoryAuditLog,
  createPeopleActions,
  type InviteMailer,
  type OwnerAlertNotifier,
  type OwnerGrantAlert,
  type OwnerInviteWarning,
  type OwnerInviteWarningNotifier,
  type PeopleAdminConfig,
} from '../../src/admin/index.js';
import { toRequestContext } from '../../src/server/index.js';
import { type AppCapability, type AppGroup, bearer, harness } from '../helpers.js';

export const DAY = 24 * 60 * 60 * 1000;
export const NOW = Date.parse('2026-10-17T12:00:00.000Z');

export interface FakeUser {
  username: string;
  sub: string;
  email: string;
  name?: string;
  emailVerified: boolean;
  enabled: boolean;
  status: string;
  createdAt: Date;
  groups: Set<string>;
}

const WRITE_COMMANDS = new Set([
  'AdminCreateUserCommand',
  'AdminAddUserToGroupCommand',
  'AdminRemoveUserFromGroupCommand',
  'AdminDisableUserCommand',
  'AdminEnableUserCommand',
  'AdminUserGlobalSignOutCommand',
  'AdminDeleteUserCommand',
]);

const awsError = (name: string, message = name) => Object.assign(new Error(message), { name, $metadata: { httpStatusCode: 400 } });

/**
 * A user pool in memory behind aws-sdk-client-mock. It implements the Admin* and List* calls the
 * People actions make, with Cognito's own rules where they matter (UsernameExists, RESEND only while
 * FORCE_CHANGE_PASSWORD, passwordless users CONFIRMED at once, pagination).
 */
export function fakeUserPool(options: { pageSize?: number; passwordless?: boolean; timeline?: string[] } = {}) {
  const client = new CognitoIdentityProviderClient({ region: 'us-east-1', credentials: { accessKeyId: 'x', secretAccessKey: 'y' } });
  const mock = mockClient(client);
  const users: FakeUser[] = [];
  const failures = new Map<string, Error[]>();
  const nth = new Map<string, Map<number, Error>>();
  const counts = new Map<string, number>();
  const timeline = options.timeline ?? [];
  let seq = 0;

  const find = (username: string) => {
    const u = users.find((x) => x.username === username);
    if (!u) throw awsError('UserNotFoundException', 'User does not exist.');
    return u;
  };
  const toType = (u: FakeUser, only?: string[]): UserType => {
    const attrs = [
      { Name: 'sub', Value: u.sub },
      { Name: 'email', Value: u.email },
      { Name: 'email_verified', Value: String(u.emailVerified) },
      ...(u.name !== undefined ? [{ Name: 'name', Value: u.name }] : []),
    ].filter((a) => !only || only.includes(a.Name));
    return { Username: u.username, Attributes: attrs, Enabled: u.enabled, UserStatus: u.status as never, UserCreateDate: u.createdAt };
  };
  const page = <T>(list: T[], token: string | undefined, limit: number | undefined) => {
    const size = Math.min(limit ?? 60, options.pageSize ?? 60);
    const start = token ? Number(token) : 0;
    const next = start + size < list.length ? String(start + size) : undefined;
    return { slice: list.slice(start, start + size), next };
  };
  function handle<I>(name: string, fn: (input: I) => unknown) {
    return (input: I) => {
      timeline.push(`cognito:${name.replace(/Command$/, '')}`);
      const count = (counts.get(name) ?? 0) + 1;
      counts.set(name, count);
      const planned = nth.get(name)?.get(count);
      if (planned) throw planned;
      const queue = failures.get(name);
      const next = queue?.shift();
      if (next) throw next;
      return fn(input);
    };
  }

  mock.on(ListUsersCommand).callsFake(
    handle('ListUsersCommand', (input: { Filter?: string; Limit?: number; PaginationToken?: string; AttributesToGet?: string[] }) => {
      let list = users;
      if (input.Filter) {
        const m = /^(sub|email) = "([^"]*)"$/.exec(input.Filter);
        if (!m) throw awsError('InvalidParameterException', `bad filter ${input.Filter}`);
        list = users.filter((u) => (m[1] === 'sub' ? u.sub : u.email) === m[2]);
      }
      const { slice, next } = page(list, input.PaginationToken, input.Limit);
      return { Users: slice.map((u) => toType(u, input.AttributesToGet)), ...(next && { PaginationToken: next }) };
    }),
  );
  mock.on(ListUsersInGroupCommand).callsFake(
    handle('ListUsersInGroupCommand', (input: { GroupName: string; Limit?: number; NextToken?: string }) => {
      const { slice, next } = page(
        users.filter((u) => u.groups.has(input.GroupName)),
        input.NextToken,
        input.Limit,
      );
      return { Users: slice.map((u) => toType(u)), ...(next && { NextToken: next }) };
    }),
  );
  mock.on(AdminListGroupsForUserCommand).callsFake(
    handle('AdminListGroupsForUserCommand', (input: { Username: string }) => ({
      Groups: [...find(input.Username).groups].map((GroupName) => ({ GroupName })),
    })),
  );
  mock.on(AdminCreateUserCommand).callsFake(
    handle('AdminCreateUserCommand', (input: AdminCreateUserCommandInput) => {
      if (input.MessageAction === 'RESEND') {
        const u = find(input.Username!);
        if (u.status !== 'FORCE_CHANGE_PASSWORD') throw awsError('UnsupportedUserStateException');
        return { User: toType(u) };
      }
      const email = input.UserAttributes?.find((a) => a.Name === 'email')?.Value ?? '';
      if (users.some((u) => u.email === email)) throw awsError('UsernameExistsException', 'An account with the given email already exists.');
      const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
      const verified = input.UserAttributes?.find((a) => a.Name === 'email_verified')?.Value === 'true';
      const name = input.UserAttributes?.find((a) => a.Name === 'name')?.Value;
      const u: FakeUser = {
        username: id,
        sub: id,
        email,
        ...(name !== undefined && { name }),
        emailVerified: verified,
        enabled: true,
        status: options.passwordless !== false && !input.TemporaryPassword ? 'CONFIRMED' : 'FORCE_CHANGE_PASSWORD',
        createdAt: new Date(NOW),
        groups: new Set(),
      };
      users.push(u);
      return { User: toType(u) };
    }),
  );
  mock.on(AdminAddUserToGroupCommand).callsFake(
    handle('AdminAddUserToGroupCommand', (input: { Username: string; GroupName: string }) => void find(input.Username).groups.add(input.GroupName)),
  );
  mock.on(AdminRemoveUserFromGroupCommand).callsFake(
    handle('AdminRemoveUserFromGroupCommand', (input: { Username: string; GroupName: string }) => void find(input.Username).groups.delete(input.GroupName)),
  );
  mock.on(AdminDisableUserCommand).callsFake(handle('AdminDisableUserCommand', (input: { Username: string }) => void (find(input.Username).enabled = false)));
  mock.on(AdminEnableUserCommand).callsFake(handle('AdminEnableUserCommand', (input: { Username: string }) => void (find(input.Username).enabled = true)));
  mock.on(AdminUserGlobalSignOutCommand).callsFake(handle('AdminUserGlobalSignOutCommand', (input: { Username: string }) => void find(input.Username)));
  mock.on(AdminDeleteUserCommand).callsFake(
    handle('AdminDeleteUserCommand', (input: { Username: string }) => {
      const u = find(input.Username);
      users.splice(users.indexOf(u), 1);
    }),
  );

  return {
    client,
    mock,
    users,
    timeline,
    add(u: Partial<FakeUser> & { sub: string; email: string }, ...groups: string[]): FakeUser {
      const user: FakeUser = {
        username: u.sub,
        emailVerified: true,
        enabled: true,
        status: 'CONFIRMED',
        createdAt: new Date(NOW - 100 * DAY),
        ...u,
        groups: new Set(groups),
      };
      users.push(user);
      return user;
    },
    get: (sub: string) => users.find((u) => u.sub === sub),
    failOn(command: string, error: Error = awsError('TooManyRequestsException', 'Rate exceeded'), times = 1) {
      const list = failures.get(command) ?? [];
      for (let i = 0; i < times; i++) list.push(error);
      failures.set(command, list);
    },
    /** Fails only the Nth call (1-based) of a command. */
    failOnCall(command: string, call: number, error: Error = awsError('InternalErrorException')) {
      const map = nth.get(command) ?? new Map<number, Error>();
      map.set(call, error);
      nth.set(command, map);
    },
    /** Commands that change something, in order. */
    writes: () => mock.calls().map((c) => (c.args[0] as { constructor: { name: string } }).constructor.name).filter((n) => WRITE_COMMANDS.has(n)),
    inputsOf: <T>(command: { new (input: T): unknown }) => mock.commandCalls(command as never).map((c) => (c.args[0] as { input: T }).input),
  };
}

export interface SetupOptions {
  actor?: { sub: string; groups: string[]; authTimeAgoSeconds?: number; enabled?: boolean };
  config?: Partial<PeopleAdminConfig<AppGroup, AppCapability>>;
  pool?: { pageSize?: number; passwordless?: boolean };
}

/**
 * Real server auth (local test issuer, fake live state) and real People actions, over the fake pool,
 * an in-memory audit log, and a recording mailer, all writing to one timeline so tests can assert
 * the order of audit rows, Cognito calls, and emails.
 */
export function setup(options: SetupOptions = {}) {
  const timeline: string[] = [];
  const pool = fakeUserPool({ ...options.pool, timeline });
  let token: string | null = null;
  const h = harness({ context: () => Promise.resolve(token ? toRequestContext(bearer(token)) : { cookies: { get: () => undefined }, headers: new Headers() }) });
  const clock = { t: NOW };
  const memory = createMemoryAuditLog({ now: () => clock.t });
  const auditLog: AuditLogStore & { failNextAppends: (n: number) => void; rows: readonly AuditEvent[] } = {
    async append(e) {
      const row = await memory.append(e);
      timeline.push(`audit:${row.phase}`);
      return row;
    },
    list: (q) => memory.list(q),
    listActivity: (q) => memory.listActivity(q),
    failNextAppends: (n) => memory.failNextAppends(n),
    get rows() {
      return memory.rows;
    },
  };
  const sent: Parameters<InviteMailer['sendInvite']>[0][] = [];
  const mailFailures: Error[] = [];
  const ownerAlerts: OwnerGrantAlert[] = [];
  const alertFailures: Error[] = [];
  const ownerWarnings: OwnerInviteWarning[] = [];
  const mailer: InviteMailer & OwnerAlertNotifier & OwnerInviteWarningNotifier = {
    sendInvite(input) {
      timeline.push('mail:sendInvite');
      const f = mailFailures.shift();
      if (f) return Promise.reject(f);
      sent.push(input);
      return Promise.resolve();
    },
    ownerGranted(alert) {
      timeline.push('mail:ownerGranted');
      const f = alertFailures.shift();
      if (f) return Promise.reject(f);
      ownerAlerts.push(alert);
      return Promise.resolve();
    },
    ownerInviteUnused(warning) {
      timeline.push('mail:ownerInviteUnused');
      ownerWarnings.push(warning);
      return Promise.resolve();
    },
  };
  const changes: AuditEvent[] = [];
  const errors: string[] = [];

  const signIn = (actor: { sub: string; groups: string[]; authTimeAgoSeconds?: number; enabled?: boolean }) => {
    if (!pool.get(actor.sub)) pool.add({ sub: actor.sub, email: `${actor.sub}@example.org` }, ...actor.groups);
    h.cognito.setLiveState(actor.sub, { enabled: actor.enabled ?? true, groups: actor.groups });
    const nowSec = Math.floor(h.clock.now / 1000);
    token = h.issuer.mintAccessToken({ sub: actor.sub, groups: actor.groups, authTime: nowSec - (actor.authTimeAgoSeconds ?? 30) });
  };
  const actor = options.actor ?? { sub: 'owner-1', groups: ['superadmin'] };
  signIn(actor);

  const people = createPeopleActions<AppGroup, AppCapability>({
    auth: h.auth,
    auditLog,
    mailer,
    siteName: 'Example Reports',
    signInUrl: 'https://reports.example.org/sign-in',
    cognito: pool.client,
    now: () => clock.t,
    sleep: () => Promise.resolve(),
    quota: { random: () => 0 },
    requestContext: () => Promise.resolve({ ip: '203.0.113.24', userAgent: 'Test Browser', requestId: 'req-test' }),
    onChange: (e) => void changes.push(e),
    onError: (_e, where) => void errors.push(where),
    ...options.config,
  });

  return {
    h,
    pool,
    people,
    auditLog,
    timeline,
    sent,
    changes,
    errors,
    clock,
    failMail: (e: Error = awsError('MessageRejected', 'Email address is not verified.')) => void mailFailures.push(e),
    ownerAlerts,
    ownerWarnings,
    failOwnerAlert: (e: Error = awsError('MessageRejected', 'Email address is not verified.')) => void alertFailures.push(e),
    signOut: () => {
      token = null;
    },
    /** Swap the acting person (same pool and log). */
    actAs: signIn,
  };
}

export { awsError };
