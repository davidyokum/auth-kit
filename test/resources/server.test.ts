/**
 * The server check (ADR 0022): `requireResourceRole` through real tokens, for every site role ×
 * every resource role × every action; 404 for anyone who can't see the item (never a hint it
 * exists), 403 for someone who can see it but not do this, 503 when memberships can't be read.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryResourceStore, type ResourceRole } from '../../src/resources/index.js';
import {
  AuthUnavailableError,
  ForbiddenError,
  NotFoundError,
  StepUpRequiredError,
  createServerAuth,
  defineResourceTypes,
  type ResourceAccess,
} from '../../src/server/index.js';
import { CLIENT_ID, POOL_ID, bearer, capabilities, harness } from '../helpers.js';
import { TYPES } from './support.js';

const SITE: Record<string, string[]> = {
  owner: ['owner'],
  superadmin: ['superadmin'],
  'admin-content-people': ['admin-content-people'],
  'admin-content': ['admin-content'],
  'admin-view': ['admin-view'],
  member: [],
};
type Action = 'view' | 'edit' | 'manage-access' | 'invite';
const FLOOR: Record<string, Action[]> = {
  owner: ['view', 'edit', 'manage-access', 'invite'],
  superadmin: ['view', 'edit', 'manage-access', 'invite'],
  'admin-content-people': ['view', 'edit', 'manage-access', 'invite'],
  'admin-content': ['view', 'edit'],
  'admin-view': ['view'],
  member: [],
};
const ROLE: Record<ResourceRole, Action[]> = { manager: ['view', 'edit', 'manage-access', 'invite'], contributor: ['view', 'edit'], reader: ['view'] };
const ACTIONS: Action[] = ['view', 'edit', 'manage-access', 'invite'];

async function world() {
  const store = createMemoryResourceStore();
  const h = harness({ resources: { types: TYPES, store } });
  const give = async (id: string, sub: string, role: ResourceRole) => {
    const current = await store.getAccess({ type: 'project', id });
    await store.commit(
      { type: 'project', id },
      {
        expectedVersion: current.meta?.version ?? null,
        meta: { type: 'project', id, version: (current.meta?.version ?? 0) + 1, managers: role === 'manager' ? 1 : 0, createdAt: 'x', createdBy: 'x', updatedAt: 'x', updatedBy: 'x' },
        put: [{ type: 'project', id, sub, role, addedBy: 'admin', addedAt: '2026-10-17T00:00:00.000Z' }],
      },
    );
  };
  const as = (sub: string, groups: string[], authTimeAgoSeconds = 30) => {
    h.cognito.setLiveState(sub, { enabled: true, groups });
    const nowSec = Math.floor(h.clock.now / 1000);
    return bearer(h.issuer.mintAccessToken({ sub, groups, authTime: nowSec - authTimeAgoSeconds }));
  };
  return { store, h, give, as };
}

async function outcome(run: () => Promise<ResourceAccess>): Promise<200 | 403 | 404> {
  try {
    await run();
    return 200;
  } catch (error) {
    if (error instanceof NotFoundError) return 404;
    if (error instanceof ForbiddenError) return 403;
    throw error;
  }
}

describe('requireResourceRole: every site role × resource role × action', () => {
  const cases = Object.keys(SITE).flatMap((site) => (['manager', 'contributor', 'reader', null] as const).map((role) => ({ site, role })));

  it.each(cases)('$site with role $role', async ({ site, role }) => {
    const { h, give, as } = await world();
    const sub = `${site}-person`;
    if (role) await give('p-1', sub, role);
    const request = as(sub, SITE[site]!);
    for (const action of ACTIONS) {
      const can = (a: Action) => FLOOR[site]!.includes(a) || (role !== null && ROLE[role].includes(a));
      const want = can(action) ? 200 : can('view') ? 403 : 404;
      expect(await outcome(() => h.auth.requireResourceRole('project', 'p-1', action, { request })), `${site}/${role}/${action}`).toBe(want);
    }
  });
});

describe('requireResourceRole', () => {
  it('returns what the person may do, their role, and what their site role alone grants', async () => {
    const { h, give, as } = await world();
    await give('p-1', 'c-1', 'contributor');
    const access = await h.auth.requireResourceRole('project', 'p-1', 'edit', { request: as('c-1', []) });
    expect(access).toMatchObject({ type: 'project', id: 'p-1', role: 'contributor' });
    expect([...access.actions].sort()).toEqual(['edit', 'view']);
    expect([...access.viaSite]).toEqual([]);
    expect(access.can('manage-access')).toBe(false);
    const admin = await h.auth.requireResourceRole('project', 'p-1', 'manage-access', { request: as('a-1', ['admin-content-people']) });
    expect(admin.role).toBeNull();
    expect([...admin.viaSite].sort()).toEqual(['edit', 'invite', 'manage-access', 'view']);
  });

  it('a minimum role means "every action that role has": Admin – content only passes Contributor, not Manager', async () => {
    const { h, as } = await world();
    const request = as('ac-1', ['admin-content']);
    expect(await outcome(() => h.auth.requireResourceRole('project', 'p-1', 'contributor', { request }))).toBe(200);
    expect(await outcome(() => h.auth.requireResourceRole('project', 'p-1', 'manager', { request }))).toBe(403);
    expect(await outcome(() => h.auth.requireResourceRole('project', 'p-1', 'reader', { request: as('av-1', ['admin-view']) }))).toBe(200);
    expect(await outcome(() => h.auth.requireResourceRole('project', 'p-1', 'contributor', { request: as('av-1', ['admin-view']) }))).toBe(403);
  });

  it('answers 404 alike for an item that doesn’t exist, someone else’s item, and an ID that can’t name one', async () => {
    const { h, give, as } = await world();
    await give('p-1', 'm-1', 'manager');
    const stranger = as('m-2', []);
    for (const id of ['p-1', 'p-missing', 'a#b', '../etc', '']) {
      expect(await outcome(() => h.auth.requireResourceRole('project', id, 'view', { request: stranger })), id).toBe(404);
    }
    // Even a site admin gets nothing for an ID that can't name an item.
    expect(await outcome(() => h.auth.requireResourceRole('project', 'a#b', 'view', { request: as('o-1', ['owner']) }))).toBe(404);
  });

  it('needs a valid session first (401 before any membership read)', async () => {
    const { h, store } = await world();
    let reads = 0;
    const get = store.getMembership.bind(store);
    store.getMembership = (r, s) => (reads++, get(r, s));
    await expect(h.auth.requireResourceRole('project', 'p-1', 'view', { request: new Request('https://app.example.org/x') })).rejects.toMatchObject({ status: 401 });
    expect(reads).toBe(0);
  });

  it('fails closed with 503 when memberships can’t be read', async () => {
    const { h, store, as } = await world();
    store.failNext('read');
    await expect(h.auth.requireResourceRole('project', 'p-1', 'view', { request: as('o-1', ['owner']) })).rejects.toBeInstanceOf(AuthUnavailableError);
  });

  it('throws (a programming mistake, not a 404) for a type or action the app didn’t declare', async () => {
    const { h, as } = await world();
    const request = as('m-1', []);
    await expect(h.auth.requireResourceRole('ticket', 'p-1', 'view', { request })).rejects.toThrow(/isn't declared/);
    await expect(h.auth.requireResourceRole('project', 'p-1', 'comment', { request })).rejects.toThrow(/isn't a role or an action/);
  });

  it('with live: true, a demoted admin loses the site floor at once', async () => {
    const { h } = await world();
    const nowSec = Math.floor(h.clock.now / 1000);
    const request = bearer(h.issuer.mintAccessToken({ sub: 'd-1', groups: ['admin-content-people'], authTime: nowSec - 30 }));
    h.cognito.setLiveState('d-1', { enabled: true, groups: [] });
    expect(await outcome(() => h.auth.requireResourceRole('project', 'p-1', 'view', { request }))).toBe(200);
    expect(await outcome(() => h.auth.requireResourceRole('project', 'p-1', 'view', { request, live: true }))).toBe(404);
  });

  it('checks a recent sign-in after access, so someone without access still gets 404', async () => {
    const { h, give, as } = await world();
    await give('p-1', 'm-1', 'manager');
    await expect(h.auth.requireResourceRole('project', 'p-1', 'manage-access', { request: as('m-1', [], 3600), recentSignIn: true })).rejects.toBeInstanceOf(StepUpRequiredError);
    expect(await outcome(() => h.auth.requireResourceRole('project', 'p-1', 'manage-access', { request: as('m-2', [], 3600), recentSignIn: true }))).toBe(404);
  });

  it('takes a user the page already has from this auth, and refuses one from anywhere else', async () => {
    const { h, give, as } = await world();
    await give('p-1', 'm-1', 'reader');
    const user = await h.auth.requireUser({ request: as('m-1', []) });
    expect((await h.auth.requireResourceRole('project', 'p-1', 'view', { user })).role).toBe('reader');
    const forged = { ...user, groups: ['owner'], capabilities: new Set(['content.read']) } as unknown as typeof user;
    await expect(h.auth.requireResourceRole('project', 'p-1', 'view', { user: forged })).rejects.toThrow(/must come from this server auth/);
  });

  it('resourceAccess answers without refusing (possibly nothing)', async () => {
    const { h, as } = await world();
    const access = await h.auth.resourceAccess('project', 'p-1', { request: as('m-2', []) });
    expect(access.role).toBeNull();
    expect(access.actions.size).toBe(0);
  });

  it('page guards render the not-found page for 403 and 404', async () => {
    const { h, as } = await world();
    const { createPageGuards } = await import('../../src/server/index.js');
    const pages = createPageGuards(h.auth);
    // Next's notFound() throws its own error; outside Next it surfaces as a thrown error with its digest.
    const caught = await pages.requireResourceRole('project', 'p-1', 'view', { request: as('m-2', []) }).catch((e: unknown) => e);
    expect(caught).not.toBeInstanceOf(NotFoundError);
    expect((caught as { digest?: string }).digest).toBe('NEXT_HTTP_ERROR_FALLBACK;404');
    const forbidden = await pages.requireResourceRole('project', 'p-1', 'edit', { request: as('av-1', ['admin-view']) }).catch((e: unknown) => e);
    expect((forbidden as { digest?: string }).digest).toBe('NEXT_HTTP_ERROR_FALLBACK;404');
  });
});

describe('listMyResources', () => {
  it('a member gets their own items, with their role on each', async () => {
    const { h, give, as } = await world();
    await give('p-1', 'm-1', 'contributor');
    await give('p-2', 'm-1', 'manager');
    await give('p-3', 'm-2', 'manager');
    const mine = await h.auth.listMyResources('project', { request: as('m-1', []) });
    expect(mine).toMatchObject({ scope: 'mine', truncated: false });
    if (mine.scope !== 'mine') throw new Error('expected mine');
    expect(mine.items.map((i) => [i.id, i.role])).toEqual([
      ['p-1', 'contributor'],
      ['p-2', 'manager'],
    ]);
  });

  it('a site role that sees every item gets "all" (the app lists its own items), with the roles it holds', async () => {
    const { h, give, as } = await world();
    await give('p-1', 'av-1', 'reader');
    for (const groups of [['admin-view'], ['admin-content'], ['owner']]) {
      const all = await h.auth.listMyResources('project', { request: as('av-1', groups) });
      expect(all).toMatchObject({ scope: 'all', reason: 'site-role' });
      if (all.scope === 'all') expect([...all.roles]).toEqual([['p-1', 'reader']]);
    }
  });

  it('a shared directory gives everyone "all", read-only', async () => {
    const { h, as } = await world();
    expect(await h.auth.listMyResources('idea', { request: as('m-1', []) })).toMatchObject({ scope: 'all', reason: 'shared-directory' });
  });

  it('fails closed with 503 when the list can’t be read', async () => {
    const { h, store, as } = await world();
    store.failNext('read');
    await expect(h.auth.listMyResources('project', { request: as('m-1', []) })).rejects.toBeInstanceOf(AuthUnavailableError);
  });
});

describe('createServerAuth({ resources })', () => {
  const base = { userPoolId: POOL_ID, clientId: CLIENT_ID, capabilities };

  it('refuses types that didn’t come from defineResourceTypes and stores missing a method', () => {
    expect(() => createServerAuth({ ...base, resources: { types: { project: { noun: 'project' } } as never, store: createMemoryResourceStore() } })).toThrow(
      /resources.types must come from defineResourceTypes/,
    );
    expect(() => createServerAuth({ ...base, resources: { types: TYPES, store: { getMembership: () => Promise.resolve(null) } as never } })).toThrow(/resources.store needs getAccess/);
  });

  it('without resources, the resource checks say how to set them up', async () => {
    const auth = createServerAuth(base);
    expect(auth.resources).toBeNull();
    await expect(auth.requireResourceRole('project', 'p-1', 'view')).rejects.toThrow(/resource roles need createServerAuth\(\{ resources/);
    expect(createServerAuth({ ...base, resources: { types: defineResourceTypes({ x: { noun: 'x' } }), store: createMemoryResourceStore() } }).resources?.types.names).toEqual(['x']);
  });
});
