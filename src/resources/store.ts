/**
 * The membership store's shared rules and the in-memory store (tests, the auth matrix, local tools).
 * The DynamoDB store is in `dynamo.ts`.
 */
import { RESOURCE_POLICY, type ResourceRole } from '../shared/policy.js';
import { isPersonSub, isResourceId, isResourceRole, isResourceType } from './policy.js';
import { resourceKey } from './schema.js';
import {
  type PersonMemberships,
  RESOURCE_COMMIT_MAX_ITEMS,
  type ResourceAccessRecord,
  type ResourceAccessStore,
  type ResourceCommit,
  type ResourceMembership,
  type ResourceMeta,
  type ResourceRef,
} from './types.js';

/**
 * Someone changed this item's access since it was read, so nothing was written. Matched by `name`
 * (`isResourceConflict`), because the auth matrix runs one copy of auth-kit per Next.js bundle.
 */
export class ResourceConflictError extends Error {
  constructor(message = 'auth-kit: this item’s access changed since it was read; nothing was written.') {
    super(message);
    this.name = 'ResourceConflictError';
  }
}

export function isResourceConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'ResourceConflictError';
}

/** Checks a ref before it reaches a key. Throws: callers validate untrusted input first. */
export function assertRef(ref: ResourceRef): void {
  if (!isResourceType(ref?.type)) throw new Error(`auth-kit: "${String(ref?.type)}" isn't a resource type name.`);
  if (!isResourceId(ref.id)) throw new Error(`auth-kit: "${String(ref.id)}" isn't a valid item ID.`);
}

/** Checks a commit's shape: the same rules for every store. */
export function assertCommit(ref: ResourceRef, change: ResourceCommit): void {
  assertRef(ref);
  const puts = change.put ?? [];
  const deletes = change.delete ?? [];
  if (puts.length + deletes.length > RESOURCE_COMMIT_MAX_ITEMS) {
    throw new Error(`auth-kit: one access change writes at most ${RESOURCE_COMMIT_MAX_ITEMS} memberships.`);
  }
  if (change.expectedVersion !== null && !(Number.isInteger(change.expectedVersion) && change.expectedVersion >= 0)) {
    throw new Error('auth-kit: expectedVersion must be a whole number or null.');
  }
  if (change.meta) {
    const want = (change.expectedVersion ?? 0) + 1;
    if (change.meta.version !== want) throw new Error(`auth-kit: the access record's next version must be ${want}.`);
    if (change.meta.type !== ref.type || change.meta.id !== ref.id) throw new Error('auth-kit: the access record names another item.');
    if (!Number.isInteger(change.meta.managers) || change.meta.managers < 0) throw new Error('auth-kit: managers must be a whole number.');
  } else if (change.expectedVersion === null && (puts.length > 0 || deletes.length > 0)) {
    throw new Error('auth-kit: a change with no access record to lock must write one.');
  }
  const subs = new Set<string>();
  for (const m of puts) {
    if (m.type !== ref.type || m.id !== ref.id) throw new Error('auth-kit: a membership names another item.');
    if (!isPersonSub(m.sub)) throw new Error('auth-kit: a membership has an invalid sub.');
    if (!isResourceRole(m.role)) throw new Error(`auth-kit: "${String(m.role)}" isn't a resource role.`);
    if (subs.has(m.sub)) throw new Error('auth-kit: a commit names one person twice.');
    subs.add(m.sub);
  }
  for (const sub of deletes) {
    if (!isPersonSub(sub)) throw new Error('auth-kit: a delete has an invalid sub.');
    if (subs.has(sub)) throw new Error('auth-kit: a commit names one person twice.');
    subs.add(sub);
  }
}

// ---- In memory --------------------------------------------------------------------------------

interface MemoryEntry {
  meta: ResourceMeta | null;
  members: Record<string, ResourceMembership>;
}

/**
 * The in-memory store's data: plain objects in a Map, so one copy can be shared by several bundles
 * (the auth matrix's `shared('auth-kit:resources', …)`).
 */
export type MemoryResourceData = Map<string, MemoryEntry>;

export interface MemoryResourceStore extends ResourceAccessStore {
  /** Items with an access record or members. */
  readonly size: number;
  /** Every membership, sorted by item then person (copies). */
  readonly memberships: readonly ResourceMembership[];
  /** The next `count` reads (or commits) fail with `error` (tests of failure handling). */
  failNext(operation: 'read' | 'commit', count?: number, error?: Error): void;
  /** Runs before the next commit applies (tests of concurrent changes). */
  beforeNextCommit(hook: () => void): void;
}

/**
 * The same rules as the DynamoDB store, in memory: consistent reads, and commits that apply only at
 * the version they read. Never in production: it forgets everything on restart.
 */
export function createMemoryResourceStore(options: { data?: MemoryResourceData } = {}): MemoryResourceStore {
  const data: MemoryResourceData = options.data ?? new Map<string, MemoryEntry>();
  const failures = { read: [] as Error[], commit: [] as Error[] };
  // Throws become rejections, as from a real store.
  const settle = <R>(fn: () => R): Promise<R> => {
    try {
      return Promise.resolve(fn());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
  let hook: (() => void) | undefined;
  const failIfPlanned = (op: 'read' | 'commit') => {
    const next = failures[op].shift();
    if (next) throw next;
  };
  const clone = <T>(value: T): T => structuredClone(value);
  const all = () => [...data.values()].flatMap((e) => Object.values(e.members));
  const order = (a: ResourceMembership, b: ResourceMembership) =>
    resourceKey(a.type, a.id).localeCompare(resourceKey(b.type, b.id)) || a.sub.localeCompare(b.sub);

  return {
    get size() {
      return [...data.values()].filter((e) => e.meta !== null || Object.keys(e.members).length > 0).length;
    },
    get memberships() {
      return all().sort(order).map(clone);
    },
    failNext(operation, count = 1, error = new Error(`injected ${operation} failure`)) {
      for (let i = 0; i < count; i++) failures[operation].push(error);
    },
    beforeNextCommit(fn) {
      hook = fn;
    },
    getMembership: (ref, sub) =>
      settle(() => {
        failIfPlanned('read');
        assertRef(ref);
        const found = data.get(resourceKey(ref.type, ref.id))?.members[sub];
        return found ? clone(found) : null;
      }),
    getAccess: (ref) =>
      settle((): ResourceAccessRecord => {
        failIfPlanned('read');
        assertRef(ref);
        const entry = data.get(resourceKey(ref.type, ref.id));
        return { meta: entry?.meta ? clone(entry.meta) : null, members: Object.values(entry?.members ?? {}).sort(order).map(clone) };
      }),
    listForPerson: (sub, type) =>
      settle((): PersonMemberships => {
        failIfPlanned('read');
        if (type !== undefined && !isResourceType(type)) throw new Error(`auth-kit: "${String(type)}" isn't a resource type name.`);
        const mine = all()
          .filter((m) => m.sub === sub && (type === undefined || m.type === type))
          .sort(order);
        const max = RESOURCE_POLICY.maxResourcesPerPerson;
        return { memberships: mine.slice(0, max).map(clone), truncated: mine.length > max };
      }),
    commit: (ref, change) => settle(() => applyCommit(ref, change)),
  };

  function applyCommit(ref: ResourceRef, change: ResourceCommit): void {
    {
      failIfPlanned('commit');
      assertCommit(ref, change);
      const run = hook;
      hook = undefined;
      run?.();
      const key = resourceKey(ref.type, ref.id);
      const entry: MemoryEntry = data.get(key) ?? { meta: null, members: {} };
      const current = entry.meta?.version ?? null;
      if (current !== change.expectedVersion) throw new ResourceConflictError();
      const members = { ...entry.members };
      for (const m of change.put ?? []) members[m.sub] = clone(m);
      for (const sub of change.delete ?? []) delete members[sub];
      const next: MemoryEntry = { meta: change.meta ? clone(change.meta) : null, members };
      if (next.meta === null && Object.keys(members).length === 0) data.delete(key);
      else data.set(key, next);
    }
  }
}

/** How many Managers a list of memberships has. */
export function countManagers(members: readonly { role: ResourceRole }[]): number {
  return members.filter((m) => m.role === 'manager').length;
}
