/**
 * The membership store: one contract for the in-memory store and the DynamoDB store (over a fake),
 * then what only DynamoDB has: its exact calls, consistent reads, retries, and idempotent commits.
 */
import { describe, expect, it } from 'vitest';
import {
  createDynamoResourceStore,
  createMemoryResourceStore,
  isResourceConflict,
  RESOURCE_COMMIT_MAX_ITEMS,
  RESOURCE_TABLE_SCHEMA,
  type ResourceAccessStore,
  type ResourceMembership,
  type ResourceMeta,
} from '../../src/resources/index.js';
import { fakeResourceDynamo } from './fake-resource-dynamo.js';

const AT = '2026-10-17T12:00:00.000Z';
const ref = { type: 'project', id: 'p-1' };
const member = (sub: string, role: ResourceMembership['role'], over: Partial<ResourceMembership> = {}): ResourceMembership => ({
  type: ref.type,
  id: ref.id,
  sub,
  role,
  email: `${sub}@example.org`,
  addedBy: 'admin-1',
  addedAt: AT,
  ...over,
});
const meta = (version: number, managers: number, over: Partial<ResourceMeta> = {}): ResourceMeta => ({
  type: ref.type,
  id: ref.id,
  version,
  managers,
  createdAt: AT,
  createdBy: 'admin-1',
  updatedAt: AT,
  updatedBy: 'admin-1',
  ...over,
});

const stores: [string, () => ResourceAccessStore][] = [
  ['memory', () => createMemoryResourceStore()],
  ['dynamo', () => createDynamoResourceStore({ tableName: 'resource-access', client: fakeResourceDynamo({ pageSize: 2 }).client, sleep: () => Promise.resolve() })],
];

describe.each(stores)('the %s store', (_name, make) => {
  it('starts empty: no access record, no members, nobody’s role', async () => {
    const store = make();
    expect(await store.getAccess(ref)).toEqual({ meta: null, members: [] });
    expect(await store.getMembership(ref, 'm-1')).toBeNull();
    expect(await store.listForPerson('m-1')).toEqual({ memberships: [], truncated: false });
  });

  it('creates an item’s access with its first Manager, then reads it back', async () => {
    const store = make();
    await store.commit(ref, { expectedVersion: null, meta: meta(1, 1), put: [member('m-1', 'manager', { name: 'Ann' })] });
    expect(await store.getMembership(ref, 'm-1')).toEqual(member('m-1', 'manager', { name: 'Ann' }));
    const access = await store.getAccess(ref);
    expect(access.meta).toEqual(meta(1, 1));
    expect(access.members).toEqual([member('m-1', 'manager', { name: 'Ann' })]);
  });

  it('applies a change only at the version it read; otherwise nothing is written', async () => {
    const store = make();
    await store.commit(ref, { expectedVersion: null, meta: meta(1, 1), put: [member('m-1', 'manager')] });
    await store.commit(ref, { expectedVersion: 1, meta: meta(2, 1), put: [member('m-2', 'contributor')] });
    // A second writer that read version 1 is refused, and its write doesn't land.
    const conflict = await store.commit(ref, { expectedVersion: 1, meta: meta(2, 1), put: [member('m-3', 'reader')] }).catch((e: unknown) => e);
    expect(isResourceConflict(conflict)).toBe(true);
    expect(await store.getMembership(ref, 'm-3')).toBeNull();
    // Creating twice is a conflict too.
    expect(isResourceConflict(await store.commit(ref, { expectedVersion: null, meta: meta(1, 1), put: [member('m-9', 'manager')] }).catch((e: unknown) => e))).toBe(true);
    expect((await store.getAccess(ref)).members.map((m) => m.sub)).toEqual(['m-1', 'm-2']);
  });

  it('changes and deletes memberships in one step, and deletes the access record with the last change', async () => {
    const store = make();
    await store.commit(ref, { expectedVersion: null, meta: meta(1, 1), put: [member('m-1', 'manager'), member('m-2', 'reader')] });
    await store.commit(ref, { expectedVersion: 1, meta: meta(2, 2), put: [member('m-2', 'manager', { updatedAt: AT, updatedBy: 'm-1' })], delete: [] });
    expect((await store.getMembership(ref, 'm-2'))?.role).toBe('manager');
    await store.commit(ref, { expectedVersion: 2, meta: meta(3, 1), delete: ['m-1'] });
    expect(await store.getMembership(ref, 'm-1')).toBeNull();
    await store.commit(ref, { expectedVersion: 3, meta: null, delete: ['m-2'] });
    expect(await store.getAccess(ref)).toEqual({ meta: null, members: [] });
  });

  it('lists a person’s memberships across items, or of one type', async () => {
    const store = make();
    const other = { type: 'plan', id: 'q-1' };
    await store.commit(ref, { expectedVersion: null, meta: meta(1, 1), put: [member('m-1', 'manager')] });
    await store.commit({ type: 'project', id: 'p-2' }, { expectedVersion: null, meta: meta(1, 1, { id: 'p-2' }), put: [member('m-1', 'reader', { id: 'p-2' })] });
    await store.commit(other, { expectedVersion: null, meta: { ...meta(1, 1), ...other }, put: [{ ...member('m-1', 'contributor'), ...other }, { ...member('m-2', 'manager'), ...other }] });
    const all = await store.listForPerson('m-1');
    expect(all.memberships.map((m) => `${m.type}:${m.id}:${m.role}`)).toEqual(['plan:q-1:contributor', 'project:p-1:manager', 'project:p-2:reader']);
    const projects = await store.listForPerson('m-1', 'project');
    expect(projects.memberships.map((m) => m.id)).toEqual(['p-1', 'p-2']);
    // A type that's a prefix of another doesn't match it ("plan" vs "planning").
    await store.commit({ type: 'planning', id: 'z' }, { expectedVersion: null, meta: { ...meta(1, 1), type: 'planning', id: 'z' }, put: [{ ...member('m-1', 'manager'), type: 'planning', id: 'z' }] });
    expect((await store.listForPerson('m-1', 'plan')).memberships.map((m) => m.type)).toEqual(['plan']);
  });

  it('refuses malformed commits before writing anything', async () => {
    const store = make();
    await expect(store.commit(ref, { expectedVersion: null, meta: meta(2, 1), put: [member('m-1', 'manager')] })).rejects.toThrow(/next version must be 1/);
    await expect(store.commit(ref, { expectedVersion: null, meta: meta(1, 1), put: [member('m-1', 'owner' as never)] })).rejects.toThrow(/isn't a resource role/);
    await expect(store.commit(ref, { expectedVersion: null, meta: meta(1, 1), put: [{ ...member('m-1', 'manager'), id: 'other' }] })).rejects.toThrow(/another item/);
    await expect(store.commit(ref, { expectedVersion: null, meta: meta(1, 1), put: [member('m-1', 'manager')], delete: ['m-1'] })).rejects.toThrow(/twice/);
    await expect(store.commit(ref, { expectedVersion: null, meta: null, delete: ['m-1'] })).rejects.toThrow(/must write one/);
    const many = Array.from({ length: RESOURCE_COMMIT_MAX_ITEMS + 1 }, (_, i) => member(`m-${i}`, 'reader'));
    await expect(store.commit(ref, { expectedVersion: null, meta: meta(1, 0), put: many })).rejects.toThrow(/at most 99/);
    await expect(store.getAccess({ type: 'project', id: 'a#b' })).rejects.toThrow(/valid item ID/);
    await expect(store.getMembership({ type: 'Bad', id: 'x' }, 'm-1')).rejects.toThrow(/resource type name/);
    expect(await store.getAccess(ref)).toEqual({ meta: null, members: [] });
  });
});

describe('the DynamoDB store', () => {
  const make = (pageSize?: number) => {
    const fake = fakeResourceDynamo(pageSize !== undefined ? { pageSize } : {});
    return { fake, store: createDynamoResourceStore({ tableName: 'resource-access', client: fake.client, sleep: () => Promise.resolve() }) };
  };

  it('makes only GetItem, Query, and TransactWriteItems (Put and Delete): exactly what the app is granted', async () => {
    const { fake, store } = make();
    await store.commit(ref, { expectedVersion: null, meta: meta(1, 1), put: [member('m-1', 'manager')] });
    await store.getMembership(ref, 'm-1');
    await store.getAccess(ref);
    await store.listForPerson('m-1', 'project');
    await store.commit(ref, { expectedVersion: 1, meta: null, delete: ['m-1'] });
    expect(new Set(fake.commandNames())).toEqual(new Set(['TransactWriteItemsCommand', 'GetItemCommand', 'QueryCommand']));
    const ops = fake.transactions().flatMap((t) => (t.TransactItems ?? []).flatMap((i) => Object.keys(i)));
    expect(new Set(ops)).toEqual(new Set(['Put', 'Delete']));
  });

  it('lays items out as the schema says: resource#type#id, person#sub, meta, and the byPerson key', async () => {
    const { fake, store } = make();
    await store.commit(ref, { expectedVersion: null, meta: meta(1, 1), put: [member('m-1', 'manager')] });
    const rows = [...fake.items.values()];
    const m = rows.find((r) => r.sk?.S === 'person#m-1')!;
    expect(m).toMatchObject({ pk: { S: 'resource#project#p-1' }, personKey: { S: 'person#m-1' }, role: { S: 'manager' }, fv: { N: '1' } });
    const record = rows.find((r) => r.sk?.S === RESOURCE_TABLE_SCHEMA.metaSortKey)!;
    expect(record).toMatchObject({ pk: { S: 'resource#project#p-1' }, version: { N: '1' }, managers: { N: '1' } });
    expect(record.personKey).toBeUndefined();
  });

  it('pages through long lists, and says when a person’s list stops', async () => {
    const { store } = make(2);
    for (let i = 0; i < 5; i++) {
      const r = { type: 'project', id: `p-${i}` };
      await store.commit(r, { expectedVersion: null, meta: meta(1, 1, r), put: [member('m-1', 'manager', r), member(`x-${i}`, 'reader', r)] });
    }
    expect((await store.listForPerson('m-1')).memberships).toHaveLength(5);
    expect((await store.getAccess({ type: 'project', id: 'p-3' })).members.map((m) => m.sub)).toEqual(['m-1', 'x-3']);
  });

  it('retries a throttled read, and a commit whose response was lost, without applying it twice', async () => {
    const { fake, store } = make();
    fake.failNext(Object.assign(new Error('slow down'), { name: 'ThrottlingException' }));
    expect(await store.getMembership(ref, 'm-1')).toBeNull();
    fake.landThenFail(Object.assign(new Error('socket hang up'), { name: 'TimeoutError' }));
    await store.commit(ref, { expectedVersion: null, meta: meta(1, 1), put: [member('m-1', 'manager')] });
    const tokens = fake.transactions().map((t) => t.ClientRequestToken);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toBe(tokens[1]);
    expect((await store.getAccess(ref)).meta?.version).toBe(1);
  });

  it('turns a failed version check into a conflict, and passes other errors through', async () => {
    const { fake, store } = make();
    await store.commit(ref, { expectedVersion: null, meta: meta(1, 1), put: [member('m-1', 'manager')] });
    const conflict = await store.commit(ref, { expectedVersion: 7, meta: meta(8, 1), put: [member('m-2', 'reader')] }).catch((e: unknown) => e);
    expect(conflict).toMatchObject({ name: 'ResourceConflictError' });
    fake.failNext(Object.assign(new Error('nope'), { name: 'AccessDeniedException', $metadata: { httpStatusCode: 400 } }));
    await expect(store.getAccess(ref)).rejects.toMatchObject({ name: 'AccessDeniedException' });
  });

  it('ignores a row whose key doesn’t match its attributes (it grants nothing)', async () => {
    const { fake, store } = make();
    await store.commit(ref, { expectedVersion: null, meta: meta(1, 1), put: [member('m-1', 'manager')] });
    const row = [...fake.items.values()].find((r) => r.sk?.S === 'person#m-1')!;
    row.sub = { S: 'someone-else' };
    expect(await store.getMembership(ref, 'm-1')).toBeNull();
    expect((await store.getAccess(ref)).members).toEqual([]);
  });

  it('needs a table name', () => {
    expect(() => createDynamoResourceStore({ tableName: '' })).toThrow(/tableName/);
  });
});

describe('the in-memory store', () => {
  it('shares its data, as plain objects, with another store over the same Map (the auth matrix’s bundles)', async () => {
    const data = new Map();
    const a = createMemoryResourceStore({ data });
    const b = createMemoryResourceStore({ data });
    await a.commit(ref, { expectedVersion: null, meta: meta(1, 1), put: [member('m-1', 'manager')] });
    expect((await b.getMembership(ref, 'm-1'))?.role).toBe('manager');
    expect(structuredClone(data)).toEqual(data);
  });

  it('can fail reads and commits on purpose, and run a hook before a commit (concurrency tests)', async () => {
    const store = createMemoryResourceStore();
    store.failNext('read');
    await expect(store.getAccess(ref)).rejects.toThrow(/injected read/);
    store.beforeNextCommit(() => void store.commit(ref, { expectedVersion: null, meta: meta(1, 1), put: [member('m-9', 'manager')] }));
    const lost = await store.commit(ref, { expectedVersion: null, meta: meta(1, 1), put: [member('m-1', 'manager')] }).catch((e: unknown) => e);
    expect(isResourceConflict(lost)).toBe(true);
    expect(store.memberships.map((m) => m.sub)).toEqual(['m-9']);
    expect(store.size).toBe(1);
  });
});
