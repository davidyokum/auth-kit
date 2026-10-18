/**
 * The DynamoDB membership store, on the table `ResourceAccessTable` (`auth-kit/admin/cdk`) creates.
 * It makes four calls, which is everything the app's role is granted (`resourceAccessAppPolicy`):
 * `GetItem` and `Query` (consistent where it decides access), and `TransactWriteItems` made of `Put`
 * and `Delete` (authorized as `PutItem` and `DeleteItem`).
 */
import {
  type AttributeValue,
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  type QueryCommandInput,
  type TransactWriteItem,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import { type Sleep, isThrottlingError, isTransientError, realSleep, withBackoff } from '../admin/quota.js';
import { RESOURCE_POLICY } from '../shared/policy.js';
import { isResourceRole, isResourceType } from './policy.js';
import { RESOURCE_TABLE_SCHEMA as T, personKey, resourceKey } from './schema.js';
import { ResourceConflictError, assertCommit, assertRef } from './store.js';
import type { PersonMemberships, ResourceAccessRecord, ResourceAccessStore, ResourceMembership, ResourceMeta } from './types.js';

export interface DynamoResourceStoreOptions {
  tableName: string;
  /** Default: the SDK's (the server's region). */
  region?: string;
  /** Inject a client (tests, custom credentials). */
  client?: DynamoDBClient;
  sleep?: Sleep;
}

type Item = Record<string, AttributeValue>;

const S = (value: string): AttributeValue => ({ S: value });
const N = (value: number): AttributeValue => ({ N: String(value) });
const str = (item: Item, name: string): string | undefined => item[name]?.S;
const num = (item: Item, name: string): number | undefined => {
  const value = item[name]?.N;
  return value !== undefined ? Number(value) : undefined;
};

function membershipItem(m: ResourceMembership): Item {
  const item: Item = {
    [T.partitionKey]: S(resourceKey(m.type, m.id)),
    [T.sortKey]: S(personKey(m.sub)),
    [T.indexes.byPerson.partitionKey]: S(personKey(m.sub)),
    entity: S('membership'),
    type: S(m.type),
    id: S(m.id),
    sub: S(m.sub),
    role: S(m.role),
    addedBy: S(m.addedBy),
    addedAt: S(m.addedAt),
    fv: N(T.formatVersion),
  };
  const put = (name: string, value: string | undefined) => {
    if (value !== undefined && value !== '') item[name] = S(value);
  };
  put('email', m.email);
  put('name', m.name);
  put('addedByEmail', m.addedByEmail);
  put('updatedAt', m.updatedAt);
  put('updatedBy', m.updatedBy);
  return item;
}

function metaItem(meta: ResourceMeta): Item {
  return {
    [T.partitionKey]: S(resourceKey(meta.type, meta.id)),
    [T.sortKey]: S(T.metaSortKey),
    entity: S('access'),
    type: S(meta.type),
    id: S(meta.id),
    version: N(meta.version),
    managers: N(meta.managers),
    createdAt: S(meta.createdAt),
    createdBy: S(meta.createdBy),
    updatedAt: S(meta.updatedAt),
    updatedBy: S(meta.updatedBy),
    fv: N(T.formatVersion),
  };
}

/** Null for anything that isn't a well-formed membership (it then grants nothing). */
function toMembership(item: Item | undefined): ResourceMembership | null {
  if (!item) return null;
  const type = str(item, 'type');
  const id = str(item, 'id');
  const sub = str(item, 'sub');
  const role = str(item, 'role');
  const addedBy = str(item, 'addedBy');
  const addedAt = str(item, 'addedAt');
  if (!type || !id || !sub || !isResourceRole(role) || !addedBy || !addedAt) return null;
  // The key must agree with the attributes: a row can't grant access to an item it isn't filed under.
  if (str(item, T.partitionKey) !== resourceKey(type, id) || str(item, T.sortKey) !== personKey(sub)) return null;
  const optional = (name: 'email' | 'name' | 'addedByEmail' | 'updatedAt' | 'updatedBy') => {
    const value = str(item, name);
    return value !== undefined ? { [name]: value } : {};
  };
  return { type, id, sub, role, addedBy, addedAt, ...optional('email'), ...optional('name'), ...optional('addedByEmail'), ...optional('updatedAt'), ...optional('updatedBy') };
}

function toMeta(item: Item): ResourceMeta | null {
  const type = str(item, 'type');
  const id = str(item, 'id');
  const version = num(item, 'version');
  if (!type || !id || version === undefined || !Number.isInteger(version)) return null;
  return {
    type,
    id,
    version,
    managers: num(item, 'managers') ?? 0,
    createdAt: str(item, 'createdAt') ?? '',
    createdBy: str(item, 'createdBy') ?? '',
    updatedAt: str(item, 'updatedAt') ?? '',
    updatedBy: str(item, 'updatedBy') ?? '',
  };
}

const CONFLICT_CODES = new Set(['ConditionalCheckFailed', 'TransactionConflict']);

/** A cancelled transaction whose reason is a failed version check or a concurrent change to the same item. */
function isConflict(error: unknown): boolean {
  if ((error as { name?: string } | null)?.name !== 'TransactionCanceledException') return false;
  const reasons = (error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? [];
  return reasons.some((r) => r.Code !== undefined && CONFLICT_CODES.has(r.Code));
}

export function createDynamoResourceStore(options: DynamoResourceStoreOptions): ResourceAccessStore {
  if (!options.tableName) throw new Error('auth-kit: createDynamoResourceStore needs a tableName.');
  let client = options.client;
  const db = (): DynamoDBClient => (client ??= new DynamoDBClient(options.region ? { region: options.region } : {}));
  const sleep = options.sleep ?? realSleep;
  const read = <R>(fn: () => Promise<R>) => withBackoff(fn, { sleep, retryable: (e) => isThrottlingError(e) || isTransientError(e) });
  const TableName = options.tableName;

  async function queryAll(input: QueryCommandInput, max: number): Promise<{ items: Item[]; truncated: boolean }> {
    const items: Item[] = [];
    let start: Item | undefined;
    for (let page = 0; page < 100; page++) {
      const out = await read(() => db().send(new QueryCommand({ ...input, ...(start !== undefined && { ExclusiveStartKey: start }) })));
      for (const item of out.Items ?? []) {
        if (items.length >= max) return { items, truncated: true };
        items.push(item);
      }
      if (!out.LastEvaluatedKey) return { items, truncated: false };
      start = out.LastEvaluatedKey;
    }
    throw new Error('auth-kit: the membership query did not finish.');
  }

  return {
    async getMembership(ref, sub) {
      assertRef(ref);
      const out = await read(() =>
        db().send(
          new GetItemCommand({
            TableName,
            Key: { [T.partitionKey]: S(resourceKey(ref.type, ref.id)), [T.sortKey]: S(personKey(sub)) },
            ConsistentRead: true,
          }),
        ),
      );
      return toMembership(out.Item);
    },

    async getAccess(ref): Promise<ResourceAccessRecord> {
      assertRef(ref);
      const { items, truncated } = await queryAll(
        {
          TableName,
          KeyConditionExpression: '#pk = :pk',
          ExpressionAttributeNames: { '#pk': T.partitionKey },
          ExpressionAttributeValues: { ':pk': S(resourceKey(ref.type, ref.id)) },
          ConsistentRead: true,
        },
        RESOURCE_POLICY.maxMembersPerResource + 1,
      );
      // No ID in the message: it can reach a screen through the action that read it.
      if (truncated) throw new Error(`auth-kit: this item has more access rows than auth-kit reads (${RESOURCE_POLICY.maxMembersPerResource + 1}).`);
      let meta: ResourceMeta | null = null;
      const members: ResourceMembership[] = [];
      for (const item of items) {
        if (str(item, T.sortKey) === T.metaSortKey) meta = toMeta(item);
        else {
          const m = toMembership(item);
          if (m) members.push(m);
        }
      }
      return { meta, members };
    },

    async listForPerson(sub, type): Promise<PersonMemberships> {
      if (type !== undefined && !isResourceType(type)) throw new Error(`auth-kit: "${String(type)}" isn't a resource type name.`);
      const { byPerson } = T.indexes;
      const names: Record<string, string> = { '#p': byPerson.partitionKey };
      const values: Record<string, AttributeValue> = { ':p': S(personKey(sub)) };
      let condition = '#p = :p';
      if (type !== undefined) {
        names['#r'] = byPerson.sortKey;
        values[':r'] = S(`${T.resourcePrefix}${type}#`);
        condition += ' AND begins_with(#r, :r)';
      }
      const { items, truncated } = await queryAll(
        { TableName, IndexName: byPerson.name, KeyConditionExpression: condition, ExpressionAttributeNames: names, ExpressionAttributeValues: values },
        RESOURCE_POLICY.maxResourcesPerPerson,
      );
      const memberships = items.map(toMembership).filter((m): m is ResourceMembership => m !== null && m.sub === sub);
      return { memberships, truncated };
    },

    async commit(ref, change) {
      assertCommit(ref, change);
      const pk = S(resourceKey(ref.type, ref.id));
      const items: TransactWriteItem[] = [];
      if (change.meta) {
        items.push({
          Put: {
            TableName,
            Item: metaItem(change.meta),
            ...(change.expectedVersion === null
              ? { ConditionExpression: 'attribute_not_exists(#pk)', ExpressionAttributeNames: { '#pk': T.partitionKey } }
              : { ConditionExpression: '#v = :v', ExpressionAttributeNames: { '#v': 'version' }, ExpressionAttributeValues: { ':v': N(change.expectedVersion) } }),
          },
        });
      } else if (change.expectedVersion !== null) {
        items.push({
          Delete: {
            TableName,
            Key: { [T.partitionKey]: pk, [T.sortKey]: S(T.metaSortKey) },
            ConditionExpression: '#v = :v',
            ExpressionAttributeNames: { '#v': 'version' },
            ExpressionAttributeValues: { ':v': N(change.expectedVersion) },
          },
        });
      }
      for (const m of change.put ?? []) items.push({ Put: { TableName, Item: membershipItem(m) } });
      for (const sub of change.delete ?? []) items.push({ Delete: { TableName, Key: { [T.partitionKey]: pk, [T.sortKey]: S(personKey(sub)) } } });
      if (items.length === 0) return;
      // One token for every attempt: DynamoDB applies a retried transaction once (10-minute window),
      // so retrying after a lost response can't apply it twice or report a false conflict.
      const ClientRequestToken = globalThis.crypto.randomUUID();
      try {
        await withBackoff(() => db().send(new TransactWriteItemsCommand({ TransactItems: items, ClientRequestToken })), {
          sleep,
          maxAttempts: 4,
          retryable: (e) => isThrottlingError(e) || isTransientError(e) || (e as { name?: string }).name === 'TransactionInProgressException',
        });
      } catch (error) {
        if (isConflict(error)) throw new ResourceConflictError();
        throw error;
      }
    },
  };
}
