/**
 * Where account creation keeps its state (ADR 0023) and the site keeps its settings (ADR 0024):
 * the request queue, the rate-limit counters, and site settings. Each store has an in-memory
 * version (tests, the auth matrix, local development) and a DynamoDB version on the tables
 * `auth-kit/admin/cdk` creates. No Next.js or React: the scheduled digest's Lambda bundles this file.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  type AttributeValue,
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { type Sleep, isThrottlingError, isTransientError, realSleep, withBackoff } from '../admin/quota.js';
import { ACCOUNT_CREATION_POLICY, type RateLimitRule } from '../shared/policy.js';
import { ACCESS_REQUEST_TABLE_SCHEMA as R, RATE_LIMIT_TABLE_SCHEMA as L, SITE_SETTINGS_TABLE_SCHEMA as S_ } from './schema.js';

type Item = Record<string, AttributeValue>;
const S = (value: string): AttributeValue => ({ S: value });
const N = (value: number): AttributeValue => ({ N: String(value) });
const str = (item: Item | undefined, name: string): string | undefined => item?.[name]?.S;
const num = (item: Item | undefined, name: string): number | undefined => {
  const v = item?.[name]?.N;
  return v === undefined ? undefined : Number(v);
};
const DAY = 24 * 60 * 60 * 1000;
const epochSeconds = (ms: number) => Math.floor(ms / 1000);

interface DynamoOptions {
  tableName: string;
  /** Default: the SDK's (the server's region). */
  region?: string;
  /** Inject a client (tests, custom credentials). */
  client?: DynamoDBClient;
  sleep?: Sleep;
}

function dynamo(options: DynamoOptions, label: string) {
  if (!options.tableName) throw new Error(`auth-kit: ${label} needs a tableName.`);
  let client = options.client;
  const db = (): DynamoDBClient => (client ??= new DynamoDBClient(options.region ? { region: options.region } : {}));
  const sleep = options.sleep ?? realSleep;
  // Reads retry throttling and transient failures; conditional writes retry throttling only (it guarantees the write didn't happen).
  const read = <T>(fn: () => Promise<T>) => withBackoff(fn, { sleep, retryable: (e) => isThrottlingError(e) || isTransientError(e) });
  const write = <T>(fn: () => Promise<T>) => withBackoff(fn, { sleep, retryable: isThrottlingError });
  return { db, read, write, TableName: options.tableName };
}

const isConditionFailed = (error: unknown) => (error as { name?: string } | null)?.name === 'ConditionalCheckFailedException';

// ---- Access requests ------------------------------------------------------------------------------

export type AccessRequestStatus = 'pending' | 'approved' | 'declined' | 'expired';

/** One request to join (D3). No account exists for it until it's approved. */
export interface AccessRequest {
  id: string;
  email: string;
  /** As typed, for the admins who decide. Deleted with the request, 30 days after it's settled. */
  name?: string;
  reason?: string;
  /** `expired` is read, not stored: a pending request past `expiresAt`. */
  status: AccessRequestStatus;
  /** ISO 8601. */
  createdAt: string;
  expiresAt: string;
  settledAt?: string;
  settledBy?: { sub: string; email?: string };
  /** When the whole request is deleted (ISO 8601). */
  deleteAt: string;
}

/** The request changed since it was read (someone else decided it, or it expired). */
export class AccessRequestConflictError extends Error {
  constructor(message = 'This request was already decided, or it expired.') {
    super(message);
    this.name = 'AccessRequestConflictError';
  }
}

export interface AccessRequestStore {
  /**
   * Files a request, unless the address already has a pending one (then `created` is false and the
   * existing one is returned, when it can still be read: one request per address at a time). Constant
   * work whatever the queue holds: on DynamoDB, one conditional write of a per-address marker
   * (`pending#<sha256>`) and one of the request, so two requests for one address can't both be filed.
   */
  create(input: { email: string; name?: string; reason?: string; now: Date }): Promise<{ request: AccessRequest; created: boolean }>;
  /** Requests still kept, newest first: pending ones, and with `includeSettled` the decided and expired ones too. */
  list(now: Date, options?: { includeSettled?: boolean; max?: number }): Promise<{ requests: AccessRequest[]; truncated: boolean }>;
  get(id: string, now: Date): Promise<AccessRequest | null>;
  /** Approves or declines a pending request. Throws `AccessRequestConflictError` if it isn't pending any more. */
  settle(id: string, input: { status: 'approved' | 'declined'; by: { sub: string; email?: string }; now: Date }): Promise<AccessRequest>;
  /** Deletes every request past its retention (the typed name and reason with it). Returns how many. */
  purge(now: Date): Promise<number>;
}

const ID_RE = /^\d{13}-[0-9a-f]{12}$/;

/** A new request ID: the creation time (so the partition sorts newest first) and 48 random bits. */
export function newRequestId(now: Date): string {
  return `${String(now.getTime()).padStart(13, '0')}-${randomBytes(6).toString('hex')}`;
}

export function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}

/** The deletion time for a request in this state. */
function deleteAtFor(status: AccessRequestStatus, expiresAt: string, settledAt: string | undefined): string {
  const from = status === 'pending' || status === 'expired' ? Date.parse(expiresAt) : Date.parse(settledAt ?? expiresAt);
  return new Date(from + ACCOUNT_CREATION_POLICY.requestRetentionDays * DAY).toISOString();
}

/** How a stored request reads now: a pending one past its expiry is `expired`; one past retention is gone. */
function asOf(stored: AccessRequest, now: Date): AccessRequest | null {
  if (Date.parse(stored.deleteAt) <= now.getTime()) return null;
  if (stored.status === 'pending' && Date.parse(stored.expiresAt) <= now.getTime()) return { ...stored, status: 'expired', settledAt: stored.expiresAt };
  return stored;
}

function newRequest(input: { email: string; name?: string; reason?: string; now: Date }): AccessRequest {
  const createdAt = input.now.toISOString();
  const expiresAt = new Date(input.now.getTime() + ACCOUNT_CREATION_POLICY.requestExpiryDays * DAY).toISOString();
  return {
    id: newRequestId(input.now),
    email: input.email,
    ...(input.name !== undefined && { name: input.name }),
    ...(input.reason !== undefined && { reason: input.reason }),
    status: 'pending',
    createdAt,
    expiresAt,
    deleteAt: deleteAtFor('pending', expiresAt, undefined),
  };
}

function settled(request: AccessRequest, input: { status: 'approved' | 'declined'; by: { sub: string; email?: string }; now: Date }): AccessRequest {
  const settledAt = input.now.toISOString();
  return { ...request, status: input.status, settledAt, settledBy: { ...input.by }, deleteAt: deleteAtFor(input.status, request.expiresAt, settledAt) };
}

/** The marker's key part for an address: a hash, so the marker holds no address. */
export function requestMarkerKey(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

/** The request queue in memory (tests, the auth matrix, local development). Same marker rule as DynamoDB's. */
export function createMemoryAccessRequestStore(): AccessRequestStore & { readonly all: () => AccessRequest[] } {
  const rows = new Map<string, AccessRequest>();
  const markers = new Map<string, { requestId: string; open: boolean; expiresAt: string }>();
  return {
    all: () => [...rows.values()].map((r) => ({ ...r })),
    create(input) {
      const key = requestMarkerKey(input.email);
      const marker = markers.get(key);
      if (marker && marker.open && Date.parse(marker.expiresAt) > input.now.getTime()) {
        const existing = rows.get(marker.requestId);
        const visible = existing ? asOf(existing, input.now) : null;
        if (visible) return Promise.resolve({ request: { ...visible }, created: false });
      }
      const request = newRequest(input);
      markers.set(key, { requestId: request.id, open: true, expiresAt: request.expiresAt });
      rows.set(request.id, request);
      return Promise.resolve({ request: { ...request }, created: true });
    },
    list(now, options = {}) {
      const max = options.max ?? ACCOUNT_CREATION_POLICY.maxListedRequests;
      const visible = [...rows.values()]
        .map((r) => asOf(r, now))
        .filter((r): r is AccessRequest => r !== null && (options.includeSettled === true || r.status === 'pending'))
        .sort((a, b) => b.id.localeCompare(a.id));
      return Promise.resolve({ requests: visible.slice(0, max).map((r) => ({ ...r })), truncated: visible.length > max });
    },
    get(id, now) {
      const r = rows.get(id);
      return Promise.resolve(r ? asOf({ ...r }, now) : null);
    },
    settle(id, input) {
      const current = rows.get(id);
      const now = current ? asOf(current, input.now) : null;
      if (!now || now.status !== 'pending') return Promise.reject(new AccessRequestConflictError());
      const next = settled(now, input);
      rows.set(id, next);
      const marker = markers.get(requestMarkerKey(next.email));
      if (marker?.requestId === id) marker.open = false;
      return Promise.resolve({ ...next });
    },
    purge(now) {
      let n = 0;
      for (const [id, r] of rows) {
        if (Date.parse(r.deleteAt) <= now.getTime()) {
          rows.delete(id);
          n++;
        }
      }
      return Promise.resolve(n);
    },
  };
}

function requestItem(r: AccessRequest): Item {
  const item: Item = {
    [R.partitionKey]: S(R.partition),
    [R.sortKey]: S(`${R.requestPrefix}${r.id}`),
    id: S(r.id),
    email: S(r.email),
    status: S(r.status === 'expired' ? 'pending' : r.status),
    createdAt: S(r.createdAt),
    expiresAt: S(r.expiresAt),
    deleteAt: S(r.deleteAt),
    [R.ttlAttribute]: N(epochSeconds(Date.parse(r.deleteAt))),
    fv: N(R.formatVersion),
  };
  if (r.name !== undefined) item.name = S(r.name);
  if (r.reason !== undefined) item.reason = S(r.reason);
  if (r.settledAt !== undefined && r.status !== 'expired') item.settledAt = S(r.settledAt);
  if (r.settledBy) {
    item.settledBy = S(r.settledBy.sub);
    if (r.settledBy.email !== undefined) item.settledByEmail = S(r.settledBy.email);
  }
  return item;
}

function toRequest(item: Item | undefined): AccessRequest | null {
  const id = str(item, 'id');
  const email = str(item, 'email');
  const status = str(item, 'status');
  const createdAt = str(item, 'createdAt');
  const expiresAt = str(item, 'expiresAt');
  const deleteAt = str(item, 'deleteAt');
  if (!id || !isRequestId(id) || !email || !createdAt || !expiresAt || !deleteAt) return null;
  if (status !== 'pending' && status !== 'approved' && status !== 'declined') return null;
  if (str(item, R.sortKey) !== `${R.requestPrefix}${id}`) return null;
  const name = str(item, 'name');
  const reason = str(item, 'reason');
  const settledAt = str(item, 'settledAt');
  const settledBy = str(item, 'settledBy');
  const settledByEmail = str(item, 'settledByEmail');
  return {
    id,
    email,
    ...(name !== undefined && { name }),
    ...(reason !== undefined && { reason }),
    status,
    createdAt,
    expiresAt,
    ...(settledAt !== undefined && { settledAt }),
    ...(settledBy !== undefined && { settledBy: { sub: settledBy, ...(settledByEmail !== undefined && { email: settledByEmail }) } }),
    deleteAt,
  };
}

/**
 * The request queue on `AccessRequestTable`. The app's role makes `Query`, `GetItem`, and `PutItem`
 * (`accessRequestAppPolicy`); the digest's role makes `Query` and `DeleteItem`.
 */
export function createDynamoAccessRequestStore(options: DynamoOptions): AccessRequestStore {
  const { db, read, write, TableName } = dynamo(options, 'createDynamoAccessRequestStore');

  async function queryAll(now: Date, max: number): Promise<{ items: AccessRequest[]; truncated: boolean }> {
    const out: AccessRequest[] = [];
    let start: Item | undefined;
    for (let page = 0; page < 50; page++) {
      const res = await read(() =>
        db().send(
          new QueryCommand({
            TableName,
            KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
            ExpressionAttributeNames: { '#pk': R.partitionKey, '#sk': R.sortKey },
            ExpressionAttributeValues: { ':pk': S(R.partition), ':prefix': S(R.requestPrefix) },
            ScanIndexForward: false,
            ConsistentRead: true,
            ...(start !== undefined && { ExclusiveStartKey: start }),
          }),
        ),
      );
      for (const item of res.Items ?? []) {
        const r = toRequest(item);
        const visible = r ? asOf(r, now) : null;
        if (!visible) continue;
        if (out.length >= max) return { items: out, truncated: true };
        out.push(visible);
      }
      if (!res.LastEvaluatedKey) return { items: out, truncated: false };
      start = res.LastEvaluatedKey;
    }
    return { items: out, truncated: true };
  }

  async function getRaw(id: string): Promise<AccessRequest | null> {
    const res = await read(() =>
      db().send(new GetItemCommand({ TableName, Key: { [R.partitionKey]: S(R.partition), [R.sortKey]: S(`${R.requestPrefix}${id}`) }, ConsistentRead: true })),
    );
    return toRequest(res.Item);
  }

  const markerKey = (email: string): Item => ({ [R.partitionKey]: S(R.partition), [R.sortKey]: S(`${R.markerPrefix}${requestMarkerKey(email)}`) });
  const markerItem = (request: AccessRequest, open: boolean): Item => ({
    ...markerKey(request.email),
    requestId: S(request.id),
    open: { BOOL: open },
    expiresAt: S(request.expiresAt),
    // The digest's purge deletes it with the requests; DynamoDB's TTL too.
    deleteAt: S(request.expiresAt),
    [R.ttlAttribute]: N(epochSeconds(Date.parse(request.expiresAt))),
    fv: N(R.formatVersion),
  });

  return {
    async create(input) {
      const request = newRequest(input);
      try {
        // One pending request per address: the marker is free, closed, or expired, or this is refused.
        await write(() =>
          db().send(
            new PutItemCommand({
              TableName,
              Item: markerItem(request, true),
              ConditionExpression: 'attribute_not_exists(#sk) OR #open = :closed OR #expiresAt <= :now',
              ExpressionAttributeNames: { '#sk': R.sortKey, '#open': 'open', '#expiresAt': 'expiresAt' },
              ExpressionAttributeValues: { ':closed': { BOOL: false }, ':now': S(input.now.toISOString()) },
              ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
            }),
          ),
        );
      } catch (error) {
        if (!isConditionFailed(error)) throw error;
        const existingId = str((error as { Item?: Item }).Item, 'requestId');
        const existing = existingId && isRequestId(existingId) ? await getRaw(existingId) : null;
        const visible = existing ? asOf(existing, input.now) : null;
        return { request: visible ?? request, created: false };
      }
      try {
        await write(() => db().send(new PutItemCommand({ TableName, Item: requestItem(request), ConditionExpression: 'attribute_not_exists(#sk)', ExpressionAttributeNames: { '#sk': R.sortKey } })));
      } catch (error) {
        // Release the marker so the address isn't blocked by a request that was never filed.
        await write(() => db().send(new PutItemCommand({ TableName, Item: markerItem(request, false) }))).catch(() => undefined);
        throw error;
      }
      return { request, created: true };
    },
    async list(now, opts = {}) {
      const max = opts.max ?? ACCOUNT_CREATION_POLICY.maxListedRequests;
      const { items, truncated } = await queryAll(now, opts.includeSettled === true ? max : 10_000);
      const requests = opts.includeSettled === true ? items : items.filter((r) => r.status === 'pending');
      return { requests: requests.slice(0, max), truncated: truncated || requests.length > max };
    },
    async get(id, now) {
      if (!isRequestId(id)) return null;
      const r = await getRaw(id);
      return r ? asOf(r, now) : null;
    },
    async settle(id, input) {
      if (!isRequestId(id)) throw new AccessRequestConflictError('That request no longer exists.');
      const raw = await getRaw(id);
      const current = raw ? asOf(raw, input.now) : null;
      if (!current || current.status !== 'pending') throw new AccessRequestConflictError();
      const next = settled(current, input);
      try {
        await write(() =>
          db().send(
            new PutItemCommand({
              TableName,
              Item: requestItem(next),
              // Still pending, and not past its expiry: two admins deciding at once can't both win.
              ConditionExpression: '#status = :pending AND #expiresAt > :now',
              ExpressionAttributeNames: { '#status': 'status', '#expiresAt': 'expiresAt' },
              ExpressionAttributeValues: { ':pending': S('pending'), ':now': S(input.now.toISOString()) },
            }),
          ),
        );
      } catch (error) {
        if (isConditionFailed(error)) throw new AccessRequestConflictError();
        throw error;
      }
      // Close this request's marker so the address can ask again. Best effort: a marker left open
      // still closes when the request would have expired.
      await write(() =>
        db().send(
          new PutItemCommand({
            TableName,
            Item: markerItem(next, false),
            ConditionExpression: '#requestId = :id',
            ExpressionAttributeNames: { '#requestId': 'requestId' },
            ExpressionAttributeValues: { ':id': S(next.id) },
          }),
        ),
      ).catch(() => undefined);
      return next;
    },
    async purge(now) {
      let n = 0;
      let start: Item | undefined;
      for (let page = 0; page < 50; page++) {
        const res = await read(() =>
          db().send(
            new QueryCommand({
              TableName,
              KeyConditionExpression: '#pk = :pk',
              ExpressionAttributeNames: { '#pk': R.partitionKey },
              ExpressionAttributeValues: { ':pk': S(R.partition) },
              ...(start !== undefined && { ExclusiveStartKey: start }),
            }),
          ),
        );
        for (const item of res.Items ?? []) {
          const deleteAt = str(item, 'deleteAt');
          const ttl = num(item, R.ttlAttribute);
          const due = deleteAt !== undefined ? Date.parse(deleteAt) <= now.getTime() : ttl !== undefined && ttl * 1000 <= now.getTime();
          if (!due) continue;
          await write(() => db().send(new DeleteItemCommand({ TableName, Key: { [R.partitionKey]: item[R.partitionKey]!, [R.sortKey]: item[R.sortKey]! } })));
          // Expired markers go too, but only requests are counted.
          if (str(item, R.sortKey)?.startsWith(R.requestPrefix)) n++;
        }
        if (!res.LastEvaluatedKey) break;
        start = res.LastEvaluatedKey;
      }
      return n;
    },
  };
}

// ---- Rate limits ----------------------------------------------------------------------------------

export interface RateLimitResult {
  allowed: boolean;
  /** Attempts in this window, this one included. */
  count: number;
  /** Seconds until the window resets. */
  retryAfterSeconds: number;
}

/** Fixed-window counters. Keys are hashed before they're stored (`rateLimitKey`). */
export interface RateLimitStore {
  hit(key: string, rule: RateLimitRule, now: Date): Promise<RateLimitResult>;
}

/** `<route>#<sha256(value)>`: the counter's key, so no address or IP is stored. */
export function rateLimitKey(route: string, value: string): string {
  return `${route}#${createHash('sha256').update(value.trim().toLowerCase()).digest('hex')}`;
}

function windowOf(rule: RateLimitRule, now: Date): { start: number; end: number } {
  const size = rule.windowMinutes * 60 * 1000;
  const start = Math.floor(now.getTime() / size) * size;
  return { start, end: start + size };
}

export function createMemoryRateLimitStore(): RateLimitStore & { reset(): void } {
  const counters = new Map<string, { count: number; end: number }>();
  return {
    reset: () => counters.clear(),
    hit(key, rule, now) {
      const { start, end } = windowOf(rule, now);
      const id = `${key}#${start}`;
      const c = counters.get(id) ?? { count: 0, end };
      c.count++;
      counters.set(id, c);
      return Promise.resolve({ allowed: c.count <= rule.limit, count: c.count, retryAfterSeconds: Math.ceil((end - now.getTime()) / 1000) });
    },
  };
}

/** The counters on `RateLimitTable`: one `UpdateItem` per attempt (`rateLimitAppPolicy`). */
export function createDynamoRateLimitStore(options: DynamoOptions): RateLimitStore {
  const { db, write, TableName } = dynamo(options, 'createDynamoRateLimitStore');
  return {
    async hit(key, rule, now) {
      const { start, end } = windowOf(rule, now);
      const res = await write(() =>
        db().send(
          new UpdateItemCommand({
            TableName,
            Key: { [L.partitionKey]: S(`${key}#${start}`) },
            UpdateExpression: 'ADD #hits :one SET #ttl = if_not_exists(#ttl, :ttl)',
            ExpressionAttributeNames: { '#hits': 'hits', '#ttl': L.ttlAttribute },
            ExpressionAttributeValues: { ':one': N(1), ':ttl': N(epochSeconds(end) + 3600) },
            ReturnValues: 'UPDATED_NEW',
          }),
        ),
      );
      const count = num(res.Attributes, 'hits') ?? 1;
      return { allowed: count <= rule.limit, count, retryAfterSeconds: Math.ceil((end - now.getTime()) / 1000) };
    },
  };
}

// ---- Site settings --------------------------------------------------------------------------------

export interface StoredSetting {
  value: unknown;
  /** Starts at 1; each change must name the version it read. */
  version: number;
  updatedAt: string;
  updatedBy: { sub: string; email?: string };
}

/** The setting changed since it was read. */
export class SettingConflictError extends Error {
  constructor() {
    super('This setting changed since the page loaded. Reload and try again.');
    this.name = 'SettingConflictError';
  }
}

/** A few named site settings, each changed with an optimistic version check. */
export interface SiteSettingsStore {
  get(name: string): Promise<StoredSetting | null>;
  /** Writes `value` if the stored version is still `expectedVersion` (0: not set yet). */
  put(name: string, input: { value: unknown; expectedVersion: number; by: { sub: string; email?: string }; now: Date }): Promise<StoredSetting>;
  /** Removes it if the stored version is still `expectedVersion`. */
  remove(name: string, expectedVersion: number): Promise<void>;
}

export function createMemorySiteSettingsStore(): SiteSettingsStore {
  const rows = new Map<string, StoredSetting>();
  return {
    get: (name) => Promise.resolve(rows.has(name) ? structuredClone(rows.get(name)!) : null),
    put(name, input) {
      const current = rows.get(name)?.version ?? 0;
      if (current !== input.expectedVersion) return Promise.reject(new SettingConflictError());
      const next: StoredSetting = { value: structuredClone(input.value), version: current + 1, updatedAt: input.now.toISOString(), updatedBy: { ...input.by } };
      rows.set(name, next);
      return Promise.resolve(structuredClone(next));
    },
    remove(name, expectedVersion) {
      // Like DynamoDB's condition: there must be a stored setting at that version.
      const current = rows.get(name)?.version;
      if (current === undefined || current !== expectedVersion) return Promise.reject(new SettingConflictError());
      rows.delete(name);
      return Promise.resolve();
    },
  };
}

/** Settings on `SiteSettingsTable`: `GetItem`, `PutItem`, and `DeleteItem` (`siteSettingsAppPolicy`). */
export function createDynamoSiteSettingsStore(options: DynamoOptions): SiteSettingsStore {
  const { db, read, write, TableName } = dynamo(options, 'createDynamoSiteSettingsStore');
  const key = (name: string) => ({ [S_.partitionKey]: S(S_.partition), [S_.sortKey]: S(name) });
  return {
    async get(name) {
      const res = await read(() => db().send(new GetItemCommand({ TableName, Key: key(name), ConsistentRead: true })));
      const item = res.Item;
      const raw = str(item, 'value');
      const version = num(item, 'version');
      if (raw === undefined || version === undefined) return null;
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        return null;
      }
      const email = str(item, 'updatedByEmail');
      return { value, version, updatedAt: str(item, 'updatedAt') ?? '', updatedBy: { sub: str(item, 'updatedBy') ?? '', ...(email !== undefined && { email }) } };
    },
    async put(name, input) {
      const next: StoredSetting = { value: input.value, version: input.expectedVersion + 1, updatedAt: input.now.toISOString(), updatedBy: { ...input.by } };
      try {
        await write(() =>
          db().send(
            new PutItemCommand({
              TableName,
              Item: {
                ...key(name),
                value: S(JSON.stringify(input.value)),
                version: N(next.version),
                updatedAt: S(next.updatedAt),
                updatedBy: S(input.by.sub),
                ...(input.by.email !== undefined && { updatedByEmail: S(input.by.email) }),
                fv: N(S_.formatVersion),
              },
              ...(input.expectedVersion === 0
                ? { ConditionExpression: 'attribute_not_exists(#sk)', ExpressionAttributeNames: { '#sk': S_.sortKey } }
                : { ConditionExpression: '#v = :v', ExpressionAttributeNames: { '#v': 'version' }, ExpressionAttributeValues: { ':v': N(input.expectedVersion) } }),
            }),
          ),
        );
      } catch (error) {
        if (isConditionFailed(error)) throw new SettingConflictError();
        throw error;
      }
      return next;
    },
    async remove(name, expectedVersion) {
      try {
        await write(() =>
          db().send(
            new DeleteItemCommand({
              TableName,
              Key: key(name),
              ConditionExpression: '#v = :v',
              ExpressionAttributeNames: { '#v': 'version' },
              ExpressionAttributeValues: { ':v': N(expectedVersion) },
            }),
          ),
        );
      } catch (error) {
        if (isConditionFailed(error)) throw new SettingConflictError();
        throw error;
      }
    },
  };
}
