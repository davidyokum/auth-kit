/**
 * Account creation's stores (src/accounts/stores.ts): the access-request queue, the rate-limit
 * counters, and site settings. One contract for the in-memory store and the DynamoDB store (over a
 * small fake table behind aws-sdk-client-mock), then what only DynamoDB has: its exact calls, its
 * conditions, `ttl`, and what it ignores. No AWS.
 */
import { createHash } from 'node:crypto';
import {
  type AttributeValue,
  DeleteItemCommand,
  type DeleteItemCommandInput,
  DynamoDBClient,
  GetItemCommand,
  type GetItemCommandInput,
  PutItemCommand,
  type PutItemCommandInput,
  QueryCommand,
  type QueryCommandInput,
  UpdateItemCommand,
  type UpdateItemCommandInput,
} from '@aws-sdk/client-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { describe, expect, it } from 'vitest';
import {
  AccessRequestConflictError,
  type AccessRequestStore,
  SettingConflictError,
  type SiteSettingsStore,
  createDynamoAccessRequestStore,
  createDynamoRateLimitStore,
  createDynamoSiteSettingsStore,
  createMemoryAccessRequestStore,
  createMemoryRateLimitStore,
  createMemorySiteSettingsStore,
  isRequestId,
  newRequestId,
  rateLimitKey,
} from '../../src/accounts/stores.js';
import { ACCOUNT_CREATION_POLICY } from '../../src/shared/policy.js';

const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const at = (offset: number) => new Date(NOW + offset);
const iso = (offset: number) => at(offset).toISOString();
const ADMIN = { sub: 'admin-1', email: 'admin@example.org' };

type Item = Record<string, AttributeValue>;

const awsError = (name: string) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: 400 } });
const conditionFailed = () => awsError('ConditionalCheckFailedException');

/**
 * One DynamoDB table in memory that understands exactly the expressions these stores send (Query on
 * the partition with an optional sort-key prefix, GetItem, conditional PutItem and DeleteItem, and the
 * rate counter's UpdateItem). Anything else fails the test.
 */
function fakeTable(options: { pageSize?: number } = {}) {
  const client = new DynamoDBClient({ region: 'us-east-1', credentials: { accessKeyId: 'x', secretAccessKey: 'y' } });
  const mock = mockClient(client);
  const items = new Map<string, Item>();
  const keyOf = (key: Item) => `${key.pk?.S ?? ''}|${key.sk?.S ?? ''}`;
  const failures = new Map<string, Error[]>();
  let beforeNextPut: (() => void) | undefined;

  const injected = (command: string) => {
    const error = failures.get(command)?.shift();
    if (error) throw error;
  };

  function check(condition: string | undefined, names: Record<string, string>, values: Item, existing: Item | undefined) {
    if (condition === undefined) return;
    if (condition === 'attribute_not_exists(#sk)') {
      if (names['#sk'] !== 'sk') throw new Error('fake-table: attribute_not_exists must name sk');
      if (existing) throw conditionFailed();
      return;
    }
    if (condition === '#status = :pending AND #expiresAt > :now') {
      if (names['#status'] !== 'status' || names['#expiresAt'] !== 'expiresAt') throw new Error('fake-table: bad names for the settle condition');
      // ISO 8601 strings in one format compare in time order, as DynamoDB compares strings.
      if (!existing || existing.status?.S !== values[':pending']?.S || !((existing.expiresAt?.S ?? '') > (values[':now']?.S ?? ''))) throw conditionFailed();
      return;
    }
    if (condition === '#v = :v') {
      if (names['#v'] !== 'version') throw new Error('fake-table: #v must name version');
      if (!existing || existing.version?.N !== values[':v']?.N) throw conditionFailed();
      return;
    }
    throw new Error(`fake-table: unexpected condition ${condition}`);
  }

  mock.on(QueryCommand).callsFake((input: QueryCommandInput) => {
    injected('Query');
    const names = input.ExpressionAttributeNames ?? {};
    const values = input.ExpressionAttributeValues ?? {};
    let prefix: string | undefined;
    if (input.KeyConditionExpression === '#pk = :pk AND begins_with(#sk, :prefix)') {
      if (names['#sk'] !== 'sk') throw new Error('fake-table: #sk must name sk');
      prefix = values[':prefix']?.S;
    } else if (input.KeyConditionExpression !== '#pk = :pk') {
      throw new Error(`fake-table: unexpected key condition ${input.KeyConditionExpression}`);
    }
    if (names['#pk'] !== 'pk') throw new Error('fake-table: #pk must name pk');
    const forward = input.ScanIndexForward !== false;
    let rows = [...items.values()]
      .filter((i) => i.pk?.S === values[':pk']?.S && (prefix === undefined || (i.sk?.S ?? '').startsWith(prefix)))
      .sort((a, b) => ((a.sk?.S ?? '') < (b.sk?.S ?? '') ? -1 : 1));
    if (!forward) rows.reverse();
    const start = input.ExclusiveStartKey?.sk?.S;
    if (start !== undefined) rows = rows.filter((i) => (forward ? (i.sk?.S ?? '') > start : (i.sk?.S ?? '') < start));
    const size = options.pageSize ?? 1000;
    const page = rows.slice(0, size);
    const last = page[page.length - 1];
    return { Items: structuredClone(page), ...(rows.length > size && last && { LastEvaluatedKey: { pk: last.pk!, sk: last.sk! } }) };
  });

  mock.on(GetItemCommand).callsFake((input: GetItemCommandInput) => {
    injected('GetItem');
    const item = items.get(keyOf(input.Key!));
    return item ? { Item: structuredClone(item) } : {};
  });

  mock.on(PutItemCommand).callsFake((input: PutItemCommandInput) => {
    beforeNextPut?.();
    beforeNextPut = undefined;
    injected('PutItem');
    const key = keyOf(input.Item!);
    check(input.ConditionExpression, input.ExpressionAttributeNames ?? {}, input.ExpressionAttributeValues ?? {}, items.get(key));
    items.set(key, structuredClone(input.Item!));
    return {};
  });

  mock.on(DeleteItemCommand).callsFake((input: DeleteItemCommandInput) => {
    injected('DeleteItem');
    const key = keyOf(input.Key!);
    check(input.ConditionExpression, input.ExpressionAttributeNames ?? {}, input.ExpressionAttributeValues ?? {}, items.get(key));
    items.delete(key);
    return {};
  });

  mock.on(UpdateItemCommand).callsFake((input: UpdateItemCommandInput) => {
    injected('UpdateItem');
    if (input.UpdateExpression !== 'ADD #hits :one SET #ttl = if_not_exists(#ttl, :ttl)') throw new Error(`fake-table: unexpected update ${input.UpdateExpression}`);
    const values = input.ExpressionAttributeValues ?? {};
    const key = keyOf(input.Key!);
    const item: Item = items.get(key) ?? structuredClone(input.Key!);
    item.hits = { N: String(Number(item.hits?.N ?? '0') + Number(values[':one']!.N)) };
    item.ttl ??= values[':ttl']!;
    items.set(key, item);
    return input.ReturnValues === 'UPDATED_NEW' ? { Attributes: { hits: item.hits, ttl: item.ttl } } : {};
  });

  return {
    client,
    mock,
    items,
    /** Puts a raw item, as anything else with write access could. */
    seed: (item: Item) => void items.set(keyOf(item), structuredClone(item)),
    failNext: (command: 'Query' | 'GetItem' | 'PutItem' | 'DeleteItem' | 'UpdateItem', error: Error) => {
      const list = failures.get(command) ?? [];
      list.push(error);
      failures.set(command, list);
    },
    /** Runs `fn` just before the next PutItem is evaluated: another writer getting there first. */
    beforeNextPut: (fn: () => void) => {
      beforeNextPut = fn;
    },
    inputsOf: <T>(command: { new (input: T): unknown }) => mock.commandCalls(command as never).map((c) => (c.args[0] as { input: T }).input),
  };
}

const noSleep = () => Promise.resolve();

// ---- Access requests ------------------------------------------------------------------------------

interface RequestHarness {
  store: AccessRequestStore;
  /** How many requests are actually stored (not just visible). */
  stored: () => number;
}

const requestStores: [string, () => RequestHarness][] = [
  [
    'memory',
    () => {
      const store = createMemoryAccessRequestStore();
      return { store, stored: () => store.all().length };
    },
  ],
  [
    'dynamo',
    () => {
      const table = fakeTable({ pageSize: 2 });
      return { store: createDynamoAccessRequestStore({ tableName: 'access-requests', client: table.client, sleep: noSleep }), stored: () => table.items.size };
    },
  ],
];

describe.each(requestStores)('the %s access-request store', (_name, make) => {
  it('files a pending request that expires 30 days later and is deleted 30 days after that', async () => {
    const { store } = make();
    const { request, created } = await store.create({ email: 'nia@example.com', name: 'Nia', reason: 'Quarterly reports', now: at(0) });
    expect(created).toBe(true);
    expect(request).toEqual({
      id: expect.stringMatching(/^\d{13}-[0-9a-f]{12}$/),
      email: 'nia@example.com',
      name: 'Nia',
      reason: 'Quarterly reports',
      status: 'pending',
      createdAt: iso(0),
      expiresAt: iso(ACCOUNT_CREATION_POLICY.requestExpiryDays * DAY),
      deleteAt: iso((ACCOUNT_CREATION_POLICY.requestExpiryDays + ACCOUNT_CREATION_POLICY.requestRetentionDays) * DAY),
    });
    expect(request.expiresAt).toBe(iso(30 * DAY));
    expect(request.deleteAt).toBe(iso(60 * DAY));
    expect(request.id.startsWith(String(NOW))).toBe(true);
    expect(await store.get(request.id, at(MIN))).toEqual(request);
    // Without a name or reason, neither key is there.
    const bare = await store.create({ email: 'raj@example.com', now: at(MIN) });
    expect(bare.request).not.toHaveProperty('name');
    expect(bare.request).not.toHaveProperty('reason');
  });

  it('one request per address: a second while one is pending returns the same request', async () => {
    const { store } = make();
    const first = await store.create({ email: 'nia@example.com', name: 'Nia', now: at(0) });
    const again = await store.create({ email: 'nia@example.com', name: 'Someone else', reason: 'Again', now: at(MIN) });
    expect(again).toEqual({ request: first.request, created: false });
    expect((await store.list(at(2 * MIN))).requests.map((r) => r.id)).toEqual([first.request.id]);
    // Once it's decided, the address may ask again.
    await store.settle(first.request.id, { status: 'declined', by: ADMIN, now: at(3 * MIN) });
    const third = await store.create({ email: 'nia@example.com', now: at(4 * MIN) });
    expect(third.created).toBe(true);
    expect(third.request.id).not.toBe(first.request.id);
  });

  it('an expired request no longer blocks a new one for the same address', async () => {
    const { store } = make();
    const first = await store.create({ email: 'nia@example.com', now: at(0) });
    const later = await store.create({ email: 'nia@example.com', now: at(31 * DAY) });
    expect(later.created).toBe(true);
    expect(later.request.id).not.toBe(first.request.id);
  });

  it('lists pending requests newest first; includeSettled adds the decided and expired ones', async () => {
    const { store } = make();
    const old = (await store.create({ email: 'old@example.com', now: at(-31 * DAY) })).request; // expired a day ago
    const a = (await store.create({ email: 'a@example.com', now: at(0) })).request;
    const b = (await store.create({ email: 'b@example.com', now: at(MIN) })).request;
    const c = (await store.create({ email: 'c@example.com', now: at(2 * MIN) })).request;
    await store.settle(b.id, { status: 'approved', by: ADMIN, now: at(3 * MIN) });

    const pending = await store.list(at(4 * MIN));
    expect(pending).toEqual({ requests: [c, a], truncated: false });
    const all = await store.list(at(4 * MIN), { includeSettled: true });
    expect(all.truncated).toBe(false);
    expect(all.requests.map((r) => [r.email, r.status])).toEqual([
      ['c@example.com', 'pending'],
      ['b@example.com', 'approved'],
      ['a@example.com', 'pending'],
      ['old@example.com', 'expired'],
    ]);
    expect(all.requests[3]).toEqual({ ...old, status: 'expired', settledAt: old.expiresAt });
  });

  it('list stops at max and says so', async () => {
    const { store } = make();
    for (let i = 0; i < 3; i++) await store.create({ email: `p${i}@example.com`, now: at(i * MIN) });
    const capped = await store.list(at(5 * MIN), { max: 2 });
    expect(capped.requests.map((r) => r.email)).toEqual(['p2@example.com', 'p1@example.com']);
    expect(capped.truncated).toBe(true);
    expect((await store.list(at(5 * MIN), { includeSettled: true, max: 2 })).truncated).toBe(true);
    expect(await store.list(at(5 * MIN))).toMatchObject({ truncated: false, requests: [{}, {}, {}] });
  });

  it('a pending request past its expiry reads as expired (settled when it expired) and leaves the pending list', async () => {
    const { store } = make();
    const { request } = await store.create({ email: 'nia@example.com', now: at(0) });
    expect((await store.get(request.id, at(30 * DAY - 1)))?.status).toBe('pending');
    const expired = await store.get(request.id, at(30 * DAY));
    expect(expired).toEqual({ ...request, status: 'expired', settledAt: request.expiresAt });
    expect(expired).not.toHaveProperty('settledBy');
    expect((await store.list(at(30 * DAY))).requests).toEqual([]);
    expect((await store.list(at(30 * DAY), { includeSettled: true })).requests).toEqual([expired]);
  });

  it('settles once: approved or declined, by whom, and deleted 30 days after the decision', async () => {
    const { store } = make();
    const { request } = await store.create({ email: 'nia@example.com', name: 'Nia', reason: 'Reports', now: at(0) });
    const approved = await store.settle(request.id, { status: 'approved', by: ADMIN, now: at(5 * DAY) });
    expect(approved).toEqual({ ...request, status: 'approved', settledAt: iso(5 * DAY), settledBy: ADMIN, deleteAt: iso(35 * DAY) });
    expect(await store.get(request.id, at(5 * DAY + MIN))).toEqual(approved);
    // A second decision (two admins at once, or a stale page) is refused, and the first stands.
    await expect(store.settle(request.id, { status: 'declined', by: { sub: 'admin-2' }, now: at(6 * DAY) })).rejects.toBeInstanceOf(AccessRequestConflictError);
    expect(await store.get(request.id, at(6 * DAY))).toEqual(approved);

    const other = (await store.create({ email: 'raj@example.com', now: at(DAY) })).request;
    const declined = await store.settle(other.id, { status: 'declined', by: { sub: 'admin-2' }, now: at(2 * DAY) });
    expect(declined).toMatchObject({ status: 'declined', settledAt: iso(2 * DAY), settledBy: { sub: 'admin-2' }, deleteAt: iso(32 * DAY) });
    expect(declined.settledBy).toEqual({ sub: 'admin-2' });
  });

  it('settling an expired, unknown, or malformed request is a conflict', async () => {
    const { store } = make();
    const { request } = await store.create({ email: 'nia@example.com', now: at(0) });
    await expect(store.settle(request.id, { status: 'approved', by: ADMIN, now: at(30 * DAY) })).rejects.toBeInstanceOf(AccessRequestConflictError);
    expect((await store.get(request.id, at(30 * DAY)))?.status).toBe('expired');
    await expect(store.settle(newRequestId(at(0)), { status: 'approved', by: ADMIN, now: at(MIN) })).rejects.toBeInstanceOf(AccessRequestConflictError);
    await expect(store.settle('not-a-request', { status: 'declined', by: ADMIN, now: at(MIN) })).rejects.toBeInstanceOf(AccessRequestConflictError);
  });

  it('retention: a settled request, typed name and reason with it, is gone 30 days after the decision', async () => {
    const { store } = make();
    const { request } = await store.create({ email: 'nia@example.com', name: 'Nia', reason: 'Reports', now: at(0) });
    await store.settle(request.id, { status: 'declined', by: ADMIN, now: at(2 * DAY) });
    expect(await store.get(request.id, at(32 * DAY - 1))).toMatchObject({ name: 'Nia', reason: 'Reports' });
    expect(await store.get(request.id, at(32 * DAY))).toBeNull();
    expect((await store.list(at(32 * DAY), { includeSettled: true })).requests).toEqual([]);
    // One that expired unanswered: 30 days after it expired.
    const unanswered = (await store.create({ email: 'raj@example.com', now: at(0) })).request;
    expect((await store.get(unanswered.id, at(60 * DAY - 1)))?.status).toBe('expired');
    expect(await store.get(unanswered.id, at(60 * DAY))).toBeNull();
  });

  it('purge deletes exactly the requests past retention and says how many', async () => {
    const { store, stored } = make();
    const decidedEarly = (await store.create({ email: 'a@example.com', now: at(0) })).request;
    await store.settle(decidedEarly.id, { status: 'declined', by: ADMIN, now: at(DAY) }); // deleted at 31 days
    await store.create({ email: 'b@example.com', now: at(0) }); // expires at 30, deleted at 60
    const approved = (await store.create({ email: 'c@example.com', now: at(10 * DAY) })).request;
    await store.settle(approved.id, { status: 'approved', by: ADMIN, now: at(25 * DAY) }); // deleted at 55
    const pending = (await store.create({ email: 'd@example.com', now: at(40 * DAY) })).request; // deleted at 100
    expect(stored()).toBe(4);

    expect(await store.purge(at(31 * DAY - 1))).toBe(0);
    expect(stored()).toBe(4);
    expect(await store.purge(at(31 * DAY))).toBe(1);
    expect(stored()).toBe(3);
    expect(await store.purge(at(60 * DAY))).toBe(2);
    expect(stored()).toBe(1);
    expect(await store.purge(at(60 * DAY))).toBe(0);
    expect((await store.list(at(60 * DAY), { includeSettled: true })).requests.map((r) => r.id)).toEqual([pending.id]);
  });
});

describe('request IDs', () => {
  it('start with the zero-padded creation time, then 48 random bits in hex', () => {
    const id = newRequestId(at(0));
    expect(id).toMatch(/^\d{13}-[0-9a-f]{12}$/);
    expect(id.slice(0, 13)).toBe(String(NOW));
    expect(newRequestId(new Date(5)).slice(0, 14)).toBe('0000000000005-');
    expect(newRequestId(at(0))).not.toBe(id);
    // Later IDs sort after earlier ones (the partition reads newest first).
    expect(newRequestId(at(1)) > id).toBe(true);
  });

  it('isRequestId accepts only that shape', () => {
    expect(isRequestId(newRequestId(at(0)))).toBe(true);
    for (const bad of ['', 'nope', `${NOW}`, `${NOW}-abc`, `${NOW}-ABCDEF123456`, `${NOW}-0123456789abc`, `x${NOW}-0123456789ab`, `${NOW}-0123456789ab\n`, 42, null, undefined, {}]) {
      expect(isRequestId(bad), JSON.stringify(bad) ?? 'undefined').toBe(false);
    }
  });
});

describe('the DynamoDB access-request store', () => {
  function setup(pageSize = 1000) {
    const table = fakeTable({ pageSize });
    const store = createDynamoAccessRequestStore({ tableName: 'access-requests', client: table.client, sleep: noSleep });
    return { table, store };
  }

  it('needs a table name', () => {
    expect(() => createDynamoAccessRequestStore({ tableName: '' })).toThrow(/needs a tableName/);
  });

  it('files with a PutItem conditioned on attribute_not_exists; the item carries ttl (epoch seconds of deleteAt)', async () => {
    const { table, store } = setup();
    const { request } = await store.create({ email: 'nia@example.com', name: 'Nia', reason: 'Reports', now: at(0) });
    const puts = table.inputsOf(PutItemCommand);
    expect(puts).toHaveLength(1);
    expect(puts[0]).toEqual({
      TableName: 'access-requests',
      ConditionExpression: 'attribute_not_exists(#sk)',
      ExpressionAttributeNames: { '#sk': 'sk' },
      Item: {
        pk: { S: 'requests' },
        sk: { S: `request#${request.id}` },
        id: { S: request.id },
        email: { S: 'nia@example.com' },
        name: { S: 'Nia' },
        reason: { S: 'Reports' },
        status: { S: 'pending' },
        createdAt: { S: iso(0) },
        expiresAt: { S: iso(30 * DAY) },
        deleteAt: { S: iso(60 * DAY) },
        ttl: { N: String(Math.floor((NOW + 60 * DAY) / 1000)) },
        fv: { N: '1' },
      },
    });
    // Reads are consistent, newest first, within the request prefix.
    const query = table.inputsOf(QueryCommand)[0]!;
    expect(query).toMatchObject({
      TableName: 'access-requests',
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
      ExpressionAttributeValues: { ':pk': { S: 'requests' }, ':prefix': { S: 'request#' } },
      ScanIndexForward: false,
      ConsistentRead: true,
    });
    await store.get(request.id, at(MIN));
    expect(table.inputsOf(GetItemCommand)[0]).toEqual({
      TableName: 'access-requests',
      Key: { pk: { S: 'requests' }, sk: { S: `request#${request.id}` } },
      ConsistentRead: true,
    });
  });

  it("never stores status 'expired', and a decision moves ttl to 30 days after it", async () => {
    const { table, store } = setup(2);
    const lapsed = (await store.create({ email: 'nia@example.com', now: at(0) })).request;
    // It expires, is read as expired, can't be decided, and the address asks again.
    expect((await store.list(at(31 * DAY), { includeSettled: true })).requests[0]?.status).toBe('expired');
    await expect(store.settle(lapsed.id, { status: 'approved', by: ADMIN, now: at(31 * DAY) })).rejects.toBeInstanceOf(AccessRequestConflictError);
    const second = (await store.create({ email: 'nia@example.com', now: at(31 * DAY) })).request;
    await store.settle(second.id, { status: 'approved', by: ADMIN, now: at(32 * DAY) });
    const declined = (await store.create({ email: 'raj@example.com', now: at(32 * DAY) })).request;
    await store.settle(declined.id, { status: 'declined', by: { sub: 'admin-2' }, now: at(33 * DAY) });

    const items = [...table.items.values()];
    expect(items.map((i) => i.status?.S).sort()).toEqual(['approved', 'declined', 'pending']);
    for (const item of table.inputsOf(PutItemCommand).map((p) => p.Item!)) expect(item.status?.S).not.toBe('expired');
    const stale = table.items.get(`requests|request#${lapsed.id}`)!;
    expect(stale.status).toEqual({ S: 'pending' });
    expect(stale).not.toHaveProperty('settledAt');
    expect(stale.ttl).toEqual({ N: String(Math.floor((NOW + 60 * DAY) / 1000)) });
    const settled = table.items.get(`requests|request#${second.id}`)!;
    expect(settled).toMatchObject({
      status: { S: 'approved' },
      settledAt: { S: iso(32 * DAY) },
      settledBy: { S: 'admin-1' },
      settledByEmail: { S: 'admin@example.org' },
      deleteAt: { S: iso(62 * DAY) },
      ttl: { N: String(Math.floor((NOW + 62 * DAY) / 1000)) },
    });
    expect(table.items.get(`requests|request#${declined.id}`)).not.toHaveProperty('settledByEmail');
  });

  it('settles with a PutItem conditioned on still pending and not yet expired', async () => {
    const { table, store } = setup();
    const { request } = await store.create({ email: 'nia@example.com', now: at(0) });
    await store.settle(request.id, { status: 'approved', by: ADMIN, now: at(DAY) });
    const put = table.inputsOf(PutItemCommand).at(-1)!;
    expect(put).toMatchObject({
      TableName: 'access-requests',
      ConditionExpression: '#status = :pending AND #expiresAt > :now',
      ExpressionAttributeNames: { '#status': 'status', '#expiresAt': 'expiresAt' },
      ExpressionAttributeValues: { ':pending': { S: 'pending' }, ':now': { S: iso(DAY) } },
    });
  });

  it('a decision that lost the race (ConditionalCheckFailedException) is a conflict, and the winner stands', async () => {
    const { table, store } = setup();
    const { request } = await store.create({ email: 'nia@example.com', now: at(0) });
    const key = `requests|request#${request.id}`;
    table.beforeNextPut(() => {
      const item = table.items.get(key)!;
      table.items.set(key, { ...item, status: { S: 'declined' }, settledAt: { S: iso(DAY) }, settledBy: { S: 'admin-2' } });
    });
    await expect(store.settle(request.id, { status: 'approved', by: ADMIN, now: at(DAY) })).rejects.toBeInstanceOf(AccessRequestConflictError);
    expect(table.items.get(key)).toMatchObject({ status: { S: 'declined' }, settledBy: { S: 'admin-2' } });

    // Two admins at once: exactly one wins.
    const other = (await store.create({ email: 'raj@example.com', now: at(0) })).request;
    const results = await Promise.allSettled([
      store.settle(other.id, { status: 'approved', by: ADMIN, now: at(DAY) }),
      store.settle(other.id, { status: 'declined', by: { sub: 'admin-2' }, now: at(DAY) }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(AccessRequestConflictError);
  });

  it("any other error from the decision's write is passed on, not called a conflict", async () => {
    const { table, store } = setup();
    const { request } = await store.create({ email: 'nia@example.com', now: at(0) });
    table.failNext('PutItem', awsError('AccessDeniedException'));
    const error = await store.settle(request.id, { status: 'approved', by: ADMIN, now: at(DAY) }).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(AccessRequestConflictError);
    expect((error as Error).name).toBe('AccessDeniedException');
  });

  it("doesn't read the table for an ID that can't be one", async () => {
    const { table, store } = setup();
    expect(await store.get('not-a-request', at(0))).toBeNull();
    await expect(store.settle('not-a-request', { status: 'approved', by: ADMIN, now: at(0) })).rejects.toBeInstanceOf(AccessRequestConflictError);
    expect(table.inputsOf(GetItemCommand)).toHaveLength(0);
  });

  it('purge issues DeleteItem only for due items, across pages, by their keys', async () => {
    const { table, store } = setup(2);
    const due = (await store.create({ email: 'a@example.com', now: at(0) })).request;
    await store.settle(due.id, { status: 'declined', by: ADMIN, now: at(DAY) }); // deleted at 31 days
    const kept = [];
    for (let i = 0; i < 4; i++) kept.push((await store.create({ email: `k${i}@example.com`, now: at(10 * DAY + i * MIN) })).request);
    // An item without deleteAt falls back to its ttl; one with neither is left alone.
    table.seed({ pk: { S: 'requests' }, sk: { S: 'request#ttl-only' }, ttl: { N: String(Math.floor((NOW + 20 * DAY) / 1000)) } });
    table.seed({ pk: { S: 'requests' }, sk: { S: 'request#no-dates' } });
    table.mock.resetHistory();

    expect(await store.purge(at(31 * DAY))).toBe(2);
    const deletes = table.inputsOf(DeleteItemCommand);
    expect(deletes.map((d) => d.Key!.sk!.S).sort()).toEqual([`request#${due.id}`, 'request#ttl-only'].sort());
    for (const d of deletes) {
      expect(d.TableName).toBe('access-requests');
      expect(Object.keys(d.Key!).sort()).toEqual(['pk', 'sk']);
      expect(d.ConditionExpression).toBeUndefined();
    }
    expect(table.inputsOf(QueryCommand).length).toBeGreaterThan(1); // it paged
    expect(table.items.size).toBe(5);
    expect(table.items.has('requests|request#no-dates')).toBe(true);
    for (const r of kept) expect(table.items.has(`requests|request#${r.id}`)).toBe(true);
  });

  it('ignores malformed items: a bad ID, a stored expired status, an unknown status, a missing field, a key that disagrees', async () => {
    const { table, store } = setup(2);
    const good = (await store.create({ email: 'good@example.com', now: at(0) })).request;
    const base = (id: string, over: Item = {}): Item => ({
      pk: { S: 'requests' },
      sk: { S: `request#${id}` },
      id: { S: id },
      email: { S: 'odd@example.com' },
      status: { S: 'pending' },
      createdAt: { S: iso(0) },
      expiresAt: { S: iso(30 * DAY) },
      deleteAt: { S: iso(60 * DAY) },
      ...over,
    });
    const id = (n: number) => `${NOW - n}-00000000000${n}`;
    table.seed(base('bad-id'));
    table.seed(base(id(1), { status: { S: 'expired' } }));
    table.seed(base(id(2), { status: { S: 'maybe' } }));
    table.seed(base(id(3), { email: { NULL: true } }));
    table.seed({ ...base(id(4)), sk: { S: `request#${id(5)}` } });
    table.seed(base(id(6), { deleteAt: { N: '1' } }));

    expect((await store.list(at(MIN), { includeSettled: true })).requests).toEqual([good]);
    expect(await store.get(id(1), at(MIN))).toBeNull();
    expect(await store.get(id(5), at(MIN))).toBeNull(); // the item at that key says it's another request
    // A malformed pending item doesn't hold the address's one request.
    expect((await store.create({ email: 'odd@example.com', now: at(MIN) })).created).toBe(true);
  });

  it('reads retry throttling', async () => {
    const { table, store } = setup();
    table.failNext('Query', awsError('ThrottlingException'));
    expect((await store.list(at(0))).requests).toEqual([]);
    expect(table.inputsOf(QueryCommand)).toHaveLength(2);
  });
});

// ---- Rate limits ----------------------------------------------------------------------------------

const RULE = { limit: 3, windowMinutes: 60 };

describe('rate limits', () => {
  const rateStores: [string, () => { hit: ReturnType<typeof createMemoryRateLimitStore>['hit'] }][] = [
    ['memory', () => createMemoryRateLimitStore()],
    ['dynamo', () => createDynamoRateLimitStore({ tableName: 'rate-limits', client: fakeTable().client, sleep: noSleep })],
  ];

  describe.each(rateStores)('the %s store', (_name, make) => {
    it('counts per fixed window: allowed up to the limit, refused past it, reset in the next window', async () => {
      const store = make();
      const key = rateLimitKey('sign-up', 'nia@example.com');
      // NOW is on the hour, so the window runs NOW .. NOW + 60 minutes.
      expect(await store.hit(key, RULE, at(0))).toEqual({ allowed: true, count: 1, retryAfterSeconds: 3600 });
      expect(await store.hit(key, RULE, at(10 * MIN))).toEqual({ allowed: true, count: 2, retryAfterSeconds: 3000 });
      expect(await store.hit(key, RULE, at(20 * MIN))).toEqual({ allowed: true, count: 3, retryAfterSeconds: 2400 });
      expect(await store.hit(key, RULE, at(59 * MIN + 30_500))).toEqual({ allowed: false, count: 4, retryAfterSeconds: 30 });
      expect(await store.hit(key, RULE, at(59 * MIN + 59_999))).toMatchObject({ allowed: false, count: 5, retryAfterSeconds: 1 });
      // The next window starts again.
      expect(await store.hit(key, RULE, at(60 * MIN))).toEqual({ allowed: true, count: 1, retryAfterSeconds: 3600 });
    });

    it('keeps each key (route and address) separately', async () => {
      const store = make();
      const nia = rateLimitKey('sign-up', 'nia@example.com');
      for (let i = 0; i < 4; i++) await store.hit(nia, RULE, at(0));
      expect((await store.hit(nia, RULE, at(0))).allowed).toBe(false);
      expect(await store.hit(rateLimitKey('sign-up', 'raj@example.com'), RULE, at(0))).toMatchObject({ allowed: true, count: 1 });
      expect(await store.hit(rateLimitKey('request', 'nia@example.com'), RULE, at(0))).toMatchObject({ allowed: true, count: 1 });
    });
  });

  it('the memory store resets', async () => {
    const store = createMemoryRateLimitStore();
    const key = rateLimitKey('sign-up', 'nia@example.com');
    await store.hit(key, RULE, at(0));
    store.reset();
    expect((await store.hit(key, RULE, at(0))).count).toBe(1);
  });

  it('DynamoDB: one UpdateItem per hit, ADD hits with an if_not_exists ttl an hour past the window, read back UPDATED_NEW', async () => {
    const table = fakeTable();
    const store = createDynamoRateLimitStore({ tableName: 'rate-limits', client: table.client, sleep: noSleep });
    const key = rateLimitKey('sign-up', 'nia@example.com');
    await store.hit(key, RULE, at(10 * MIN));
    await store.hit(key, RULE, at(20 * MIN));
    const updates = table.inputsOf(UpdateItemCommand);
    expect(updates).toHaveLength(2);
    const windowEnd = NOW + 60 * MIN;
    expect(updates[0]).toEqual({
      TableName: 'rate-limits',
      Key: { pk: { S: `${key}#${NOW}` } },
      UpdateExpression: 'ADD #hits :one SET #ttl = if_not_exists(#ttl, :ttl)',
      ExpressionAttributeNames: { '#hits': 'hits', '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':one': { N: '1' }, ':ttl': { N: String(Math.floor(windowEnd / 1000) + 3600) } },
      ReturnValues: 'UPDATED_NEW',
    });
    expect(table.items.get(`${key}#${NOW}|`)).toEqual({ pk: { S: `${key}#${NOW}` }, hits: { N: '2' }, ttl: { N: String(Math.floor(windowEnd / 1000) + 3600) } });
    // Nothing but the hash is stored: no address.
    expect(JSON.stringify([...table.items.values()])).not.toMatch(/nia|example/);
  });

  it('DynamoDB: the count is what the update returned; throttling is retried; no count read means the first', async () => {
    const client = new DynamoDBClient({ region: 'us-east-1', credentials: { accessKeyId: 'x', secretAccessKey: 'y' } });
    const mock = mockClient(client);
    mock.on(UpdateItemCommand).rejectsOnce(awsError('ThrottlingException')).resolvesOnce({ Attributes: { hits: { N: '4' } } }).resolves({});
    const store = createDynamoRateLimitStore({ tableName: 'rate-limits', client, sleep: noSleep });
    expect(await store.hit('k', RULE, at(0))).toEqual({ allowed: false, count: 4, retryAfterSeconds: 3600 });
    expect(mock.commandCalls(UpdateItemCommand)).toHaveLength(2);
    expect(await store.hit('k', RULE, at(0))).toMatchObject({ allowed: true, count: 1 });
  });

  it('rateLimitKey: <route>#<sha256>, the same for any case or surrounding space, never the address itself', () => {
    const key = rateLimitKey('sign-up', 'nia@example.com');
    expect(key).toBe(`sign-up#${createHash('sha256').update('nia@example.com').digest('hex')}`);
    expect(key).toMatch(/^sign-up#[0-9a-f]{64}$/);
    expect(rateLimitKey('sign-up', '  NIA@Example.COM ')).toBe(key);
    expect(key).not.toMatch(/nia|example/i);
    expect(rateLimitKey('request', 'nia@example.com')).not.toBe(key);
    expect(rateLimitKey('sign-up', 'raj@example.com')).not.toBe(key);
    expect(rateLimitKey('sign-up-ip', '203.0.113.24')).toMatch(/^sign-up-ip#[0-9a-f]{64}$/);
  });
});

// ---- Site settings --------------------------------------------------------------------------------

const settingsStores: [string, () => SiteSettingsStore][] = [
  ['memory', () => createMemorySiteSettingsStore()],
  ['dynamo', () => createDynamoSiteSettingsStore({ tableName: 'site-settings', client: fakeTable().client, sleep: noSleep })],
];

describe.each(settingsStores)('the %s site settings store', (_name, make) => {
  it('puts, reads, and removes a setting, each change checking the version it read', async () => {
    const store = make();
    expect(await store.get('sign-in-help')).toBeNull();
    const first = await store.put('sign-in-help', { value: { address: 'help@example.org' }, expectedVersion: 0, by: ADMIN, now: at(0) });
    expect(first).toEqual({ value: { address: 'help@example.org' }, version: 1, updatedAt: iso(0), updatedBy: ADMIN });
    expect(await store.get('sign-in-help')).toEqual(first);
    // Someone who read "not set" (0) after it was set is refused.
    await expect(store.put('sign-in-help', { value: { address: 'other@example.org' }, expectedVersion: 0, by: ADMIN, now: at(MIN) })).rejects.toBeInstanceOf(SettingConflictError);
    const second = await store.put('sign-in-help', { value: { address: 'apps-help@example.org' }, expectedVersion: 1, by: { sub: 'admin-2' }, now: at(2 * MIN) });
    expect(second).toEqual({ value: { address: 'apps-help@example.org' }, version: 2, updatedAt: iso(2 * MIN), updatedBy: { sub: 'admin-2' } });
    expect(await store.get('sign-in-help')).toEqual(second);
    await expect(store.put('sign-in-help', { value: {}, expectedVersion: 1, by: ADMIN, now: at(3 * MIN) })).rejects.toBeInstanceOf(SettingConflictError);
    await expect(store.remove('sign-in-help', 1)).rejects.toBeInstanceOf(SettingConflictError);
    expect(await store.get('sign-in-help')).toEqual(second);
    await store.remove('sign-in-help', 2);
    expect(await store.get('sign-in-help')).toBeNull();
    // Gone means "not set" again: version 0 sets it anew.
    expect((await store.put('sign-in-help', { value: 1, expectedVersion: 0, by: ADMIN, now: at(4 * MIN) })).version).toBe(1);
  });

  it('round-trips any JSON value, and settings are independent', async () => {
    const store = make();
    const value = { address: 'help@example.org', reason: 'New “desk”', nested: [1, { on: true, none: null }], text: 'a\nb' };
    await store.put('one', { value, expectedVersion: 0, by: ADMIN, now: at(0) });
    await store.put('two', { value: ['x'], expectedVersion: 0, by: ADMIN, now: at(0) });
    expect((await store.get('one'))?.value).toEqual(value);
    expect((await store.get('two'))?.value).toEqual(['x']);
    // What a caller does with what it read doesn't change what's stored.
    const read = await store.get('one');
    (read!.value as { nested: unknown[] }).nested.push('changed');
    expect((await store.get('one'))?.value).toEqual(value);
  });
});

describe('the DynamoDB site settings store', () => {
  function setup() {
    const table = fakeTable();
    return { table, store: createDynamoSiteSettingsStore({ tableName: 'site-settings', client: table.client, sleep: noSleep }) };
  }

  it('the first write is conditioned on attribute_not_exists, later ones on #v = :v; the item holds JSON and who changed it', async () => {
    const { table, store } = setup();
    await store.put('sign-in-help', { value: { address: 'help@example.org' }, expectedVersion: 0, by: ADMIN, now: at(0) });
    await store.put('sign-in-help', { value: { address: 'apps-help@example.org' }, expectedVersion: 1, by: { sub: 'admin-2' }, now: at(MIN) });
    const [first, second] = table.inputsOf(PutItemCommand);
    expect(first).toEqual({
      TableName: 'site-settings',
      Item: {
        pk: { S: 'setting' },
        sk: { S: 'sign-in-help' },
        value: { S: JSON.stringify({ address: 'help@example.org' }) },
        version: { N: '1' },
        updatedAt: { S: iso(0) },
        updatedBy: { S: 'admin-1' },
        updatedByEmail: { S: 'admin@example.org' },
        fv: { N: '1' },
      },
      ConditionExpression: 'attribute_not_exists(#sk)',
      ExpressionAttributeNames: { '#sk': 'sk' },
    });
    expect(first).not.toHaveProperty('ExpressionAttributeValues');
    expect(second).toMatchObject({
      ConditionExpression: '#v = :v',
      ExpressionAttributeNames: { '#v': 'version' },
      ExpressionAttributeValues: { ':v': { N: '1' } },
      Item: expect.objectContaining({ version: { N: '2' }, updatedBy: { S: 'admin-2' } }),
    });
    expect(second!.Item).not.toHaveProperty('updatedByEmail');
    expect(await store.get('sign-in-help')).toEqual({ value: { address: 'apps-help@example.org' }, version: 2, updatedAt: iso(MIN), updatedBy: { sub: 'admin-2' } });
    expect(table.inputsOf(GetItemCommand)[0]).toEqual({ TableName: 'site-settings', Key: { pk: { S: 'setting' }, sk: { S: 'sign-in-help' } }, ConsistentRead: true });
  });

  it('removes with DeleteItem conditioned on #v = :v', async () => {
    const { table, store } = setup();
    await store.put('sign-in-help', { value: 1, expectedVersion: 0, by: ADMIN, now: at(0) });
    await store.remove('sign-in-help', 1);
    expect(table.inputsOf(DeleteItemCommand)).toEqual([
      {
        TableName: 'site-settings',
        Key: { pk: { S: 'setting' }, sk: { S: 'sign-in-help' } },
        ConditionExpression: '#v = :v',
        ExpressionAttributeNames: { '#v': 'version' },
        ExpressionAttributeValues: { ':v': { N: '1' } },
      },
    ]);
  });

  it('ConditionalCheckFailedException is a SettingConflictError; any other error is passed on', async () => {
    const { table, store } = setup();
    table.failNext('PutItem', conditionFailed());
    await expect(store.put('x', { value: 1, expectedVersion: 0, by: ADMIN, now: at(0) })).rejects.toBeInstanceOf(SettingConflictError);
    table.failNext('DeleteItem', conditionFailed());
    await expect(store.remove('x', 1)).rejects.toBeInstanceOf(SettingConflictError);
    table.failNext('PutItem', awsError('AccessDeniedException'));
    await expect(store.put('x', { value: 1, expectedVersion: 0, by: ADMIN, now: at(0) })).rejects.toMatchObject({ name: 'AccessDeniedException' });
    table.failNext('DeleteItem', awsError('AccessDeniedException'));
    await expect(store.remove('x', 1)).rejects.toMatchObject({ name: 'AccessDeniedException' });
  });

  it('an item it can’t read (bad JSON, no version, no value) reads as not set', async () => {
    const { table, store } = setup();
    const item = (name: string, over: Item): Item => ({ pk: { S: 'setting' }, sk: { S: name }, updatedAt: { S: iso(0) }, updatedBy: { S: 'admin-1' }, ...over });
    table.seed(item('bad-json', { value: { S: '{not json' }, version: { N: '1' } }));
    table.seed(item('no-version', { value: { S: '"x"' } }));
    table.seed(item('no-value', { version: { N: '1' } }));
    table.seed(item('ok', { value: { S: '"x"' }, version: { N: '3' } }));
    expect(await store.get('bad-json')).toBeNull();
    expect(await store.get('no-version')).toBeNull();
    expect(await store.get('no-value')).toBeNull();
    expect(await store.get('ok')).toEqual({ value: 'x', version: 3, updatedAt: iso(0), updatedBy: { sub: 'admin-1' } });
  });
});
