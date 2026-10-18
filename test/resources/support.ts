import type { AuditEvent, AuditLogStore, InviteEmail, InviteMailer, ResourceInviteAlert, ResourceInviteNotifier } from '../../src/admin/index.js';
import { createMemoryAuditLog } from '../../src/admin/index.js';
import {
  createMemoryResourceStore,
  createResourceActions,
  defineResourceTypes,
  type ResourceActionsConfig,
  type ResourceMembership,
  type ResourceRole,
  type ResourceTypes,
} from '../../src/resources/index.js';
import { toRequestContext } from '../../src/server/index.js';
import { DAY, NOW, fakeUserPool } from '../admin/people-fixture.js';
import { type AppCapability, type AppGroup, bearer, harness } from '../helpers.js';

export { DAY, NOW };

/**
 * The test site's types:
 * - `project`: the defaults (admins create; members see their own);
 * - `idea`: self-service creation and a shared directory;
 * - `plan`: its own `comment` action (Readers comment; the site floor for it is `view`), and Managers
 *   who can't invite.
 */
export const TYPES = defineResourceTypes({
  project: { noun: 'project' },
  idea: { noun: 'idea', selfServiceCreate: true, sharedDirectory: true },
  plan: {
    noun: 'plan',
    actions: {
      reader: ['view', 'comment'],
      contributor: ['view', 'edit', 'comment'],
      manager: ['view', 'edit', 'comment', 'manage-access'],
    },
    customActionFloor: { comment: 'view' },
  },
});

/** One person per site role, plus three members. Their sub is also their username. */
export const PEOPLE = {
  owner: { sub: 'owner-1', groups: ['owner'] },
  superadmin: { sub: 'super-1', groups: ['superadmin'] },
  adminPeople: { sub: 'acp-1', groups: ['admin-content-people'] },
  adminContent: { sub: 'ac-1', groups: ['admin-content'] },
  adminView: { sub: 'av-1', groups: ['admin-view'] },
  member: { sub: 'm-1', groups: [] as string[] },
  member2: { sub: 'm-2', groups: [] as string[] },
  member3: { sub: 'm-3', groups: [] as string[] },
} as const;

export type PersonKey = keyof typeof PEOPLE;
export const emailOf = (sub: string) => `${sub}@example.org`;

export interface ResourceSetupOptions {
  types?: ResourceTypes;
  config?: Partial<ResourceActionsConfig<AppGroup, AppCapability>>;
  /** Live groups that differ from the token's (a demoted admin), by sub. */
  liveGroups?: Record<string, string[]>;
  /** No mailer and no alert notifier. */
  noMail?: boolean;
}

/**
 * Real server auth (local test issuer) with resource roles over an in-memory store, real resource
 * actions over the fake user pool, an in-memory audit log, and a recording mailer, all writing to one
 * timeline so tests can check the order of audit rows, Cognito calls, commits, and emails.
 */
export function resourceSetup(options: ResourceSetupOptions = {}) {
  const timeline: string[] = [];
  const pool = fakeUserPool({ timeline });
  for (const p of Object.values(PEOPLE)) pool.add({ sub: p.sub, email: emailOf(p.sub) }, ...p.groups);
  const store = createMemoryResourceStore();
  const commit = store.commit.bind(store);
  store.commit = async (ref, change) => {
    timeline.push('store:commit');
    return commit(ref, change);
  };
  let token: string | null = null;
  const types = options.types ?? TYPES;
  const h = harness({
    context: () => Promise.resolve(token ? toRequestContext(bearer(token)) : { cookies: { get: () => undefined }, headers: new Headers() }),
    resources: { types, store },
  });
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
  const invites: InviteEmail[] = [];
  const alerts: ResourceInviteAlert[] = [];
  const failures = { invite: [] as Error[], alert: [] as Error[] };
  const mailer: InviteMailer & ResourceInviteNotifier = {
    sendInvite(input) {
      timeline.push('mail:sendInvite');
      const f = failures.invite.shift();
      if (f) return Promise.reject(f);
      invites.push(input);
      return Promise.resolve();
    },
    resourceInviteSent(alert) {
      timeline.push('mail:resourceInviteSent');
      const f = failures.alert.shift();
      if (f) return Promise.reject(f);
      alerts.push(alert);
      return Promise.resolve();
    },
  };
  const changes: AuditEvent[] = [];
  const errors: string[] = [];

  /** Signs in as one of PEOPLE (or any sub with the given groups). */
  const signIn = (who: PersonKey | { sub: string; groups: string[] }, extra: { authTimeAgoSeconds?: number; enabled?: boolean } = {}) => {
    const person = typeof who === 'string' ? PEOPLE[who] : who;
    if (!pool.get(person.sub)) pool.add({ sub: person.sub, email: emailOf(person.sub) }, ...person.groups);
    h.cognito.setLiveState(person.sub, { enabled: extra.enabled ?? true, groups: options.liveGroups?.[person.sub] ?? [...person.groups] });
    h.auth.invalidate({ username: person.sub });
    const nowSec = Math.floor(h.clock.now / 1000);
    token = h.issuer.mintAccessToken({ sub: person.sub, groups: [...person.groups], authTime: nowSec - (extra.authTimeAgoSeconds ?? 30) });
    return person;
  };
  const signOut = () => {
    token = null;
  };

  const actions = createResourceActions<AppGroup, AppCapability>({
    auth: h.auth,
    auditLog,
    ...(options.noMail ? {} : { mailer }),
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

  /** Writes an item's access straight to the store (no audit rows): the starting state of a test. */
  async function seed(type: string, id: string, members: Partial<Record<string, ResourceRole>>): Promise<void> {
    const at = new Date(NOW - DAY).toISOString();
    const list: ResourceMembership[] = Object.entries(members).map(([sub, role]) => ({
      type,
      id,
      sub,
      role: role!,
      email: emailOf(sub),
      addedBy: PEOPLE.adminPeople.sub,
      addedAt: at,
    }));
    const current = await store.getAccess({ type, id });
    await commit(
      { type, id },
      {
        expectedVersion: current.meta?.version ?? null,
        meta: {
          type,
          id,
          version: (current.meta?.version ?? 0) + 1,
          managers: list.filter((m) => m.role === 'manager').length,
          createdAt: at,
          createdBy: PEOPLE.adminPeople.sub,
          updatedAt: at,
          updatedBy: PEOPLE.adminPeople.sub,
        },
        put: list,
      },
    );
  }

  const roleOf = async (type: string, id: string, sub: string) => (await store.getMembership({ type, id }, sub))?.role ?? null;

  return { h, pool, store, auditLog, actions, timeline, invites, alerts, failures, changes, errors, clock, signIn, signOut, seed, roleOf };
}
