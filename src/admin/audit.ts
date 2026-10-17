import {
  type AttributeValue,
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
  type QueryCommandInput,
} from '@aws-sdk/client-dynamodb';
import { AUDIT_TABLE_SCHEMA } from './audit-schema.js';
import { ADMIN_POLICY } from './policy.js';
import { type Sleep, isThrottlingError, isTransientError, realSleep, withBackoff } from './quota.js';
import type {
  ActivityEntry,
  AuditEvent,
  AuditEventInput,
  AuditLogPage,
  AuditLogQuery,
  AuditOutcome,
  AuditPhase,
} from './types.js';

/**
 * Append-only by design: there is no update or delete method, every write is a conditional put that
 * refuses to replace an existing row, and the construct in `auth-kit/admin/cdk` grants the app only
 * `PutItem` and `Query` and denies item edits to everyone in the table's resource policy.
 */
export interface AuditLogStore {
  /** Writes one row. Throws `AuditRowExistsError` if a row with the same key exists (never overwrites). */
  append(event: AuditEventInput): Promise<AuditEvent>;
  /** Raw rows, newest first. */
  list(query?: AuditLogQuery): Promise<AuditLogPage>;
  /** Rows merged for the Activity page: each completed change once, intents without a result flagged. */
  listActivity(query?: AuditLogQuery): Promise<{ entries: ActivityEntry[]; nextCursor?: string }>;
}

/** The row's key already exists. For a result row this means it was already written. */
export class AuditRowExistsError extends Error {
  constructor(message = 'auth-kit: that audit row already exists; audit rows are never replaced.') {
    super(message);
    this.name = 'AuditRowExistsError';
  }
}

/** The event can't be stored (malformed, or too big). Raised before anything is written. */
export class AuditEventInvalidError extends Error {
  constructor(message: string) {
    super(`auth-kit: ${message}`);
    this.name = 'AuditEventInvalidError';
  }
}

// ---- Validation and row layout ----------------------------------------------------------------

const ACTION_RE = /^[a-z][a-zA-Z0-9-]*(?:\.[a-zA-Z][a-zA-Z0-9-]*)+$/;
const PHASES: readonly AuditPhase[] = ['intent', 'result', 'refused', 'event'];
const OUTCOMES: readonly AuditOutcome[] = ['ok', 'failed', 'partial'];
const MAX_REASON = 2000;
const MAX_TEXT = 1024;

function json(value: unknown, what: string): string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch (error) {
    throw new AuditEventInvalidError(`the audit ${what} value can't be stored as JSON (${error instanceof Error ? error.message : 'unknown'}).`);
  }
}

function clip(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

interface Row {
  event: AuditEvent;
  beforeJson?: string;
  afterJson?: string;
  entryId: string;
  sk: string;
  actorKey: string;
  targetKey?: string;
}

function targetKeyOf(target: AuditEvent['target']): string | undefined {
  if (!target) return undefined;
  if (target.sub) return `TARGET#${target.sub}`;
  if (target.recordId) return `RECORD#${target.recordId}`;
  if (target.email) return `EMAIL#${target.email.toLowerCase()}`;
  return undefined;
}

function buildRow(input: AuditEventInput, id: string, at: string): Row {
  const phase = input.phase ?? 'event';
  if (!PHASES.includes(phase)) throw new AuditEventInvalidError(`unknown audit phase "${String(phase)}".`);
  if (typeof input.action !== 'string' || input.action.length > 100 || !ACTION_RE.test(input.action)) {
    throw new AuditEventInvalidError(`audit action "${String(input.action)}" must be dotted, like "people.invite".`);
  }
  if (typeof input.actor?.sub !== 'string' || input.actor.sub.length === 0 || input.actor.sub.length > 256) {
    throw new AuditEventInvalidError('every audit row names its actor.');
  }
  if (phase === 'result') {
    if (!input.intent?.id || !input.intent.at) throw new AuditEventInvalidError('a result row must name its intent.');
    if (!input.outcome || !OUTCOMES.includes(input.outcome)) throw new AuditEventInvalidError('a result row needs an outcome.');
  } else if (input.outcome !== undefined || input.intent !== undefined) {
    throw new AuditEventInvalidError('only result rows carry an outcome and an intent.');
  }
  if (input.reason !== undefined && input.reason.length > MAX_REASON) throw new AuditEventInvalidError('the reason is too long.');

  const entryId = phase === 'result' ? input.intent!.id : id;
  const startedAt = phase === 'result' ? input.intent!.at : at;
  const event: AuditEvent = {
    id,
    at,
    phase,
    ...(input.outcome !== undefined && { outcome: input.outcome }),
    ...(phase === 'result' && { intentId: input.intent!.id }),
    startedAt,
    actor: {
      sub: input.actor.sub,
      ...(input.actor.email !== undefined && { email: clip(input.actor.email, MAX_TEXT)! }),
      ...(input.actor.kind !== undefined && { kind: input.actor.kind }),
    },
    action: input.action,
    ...(input.target !== undefined && {
      target: {
        ...(input.target.sub !== undefined && { sub: clip(input.target.sub, MAX_TEXT)! }),
        ...(input.target.email !== undefined && { email: clip(input.target.email, MAX_TEXT)! }),
        ...(input.target.recordId !== undefined && { recordId: clip(input.target.recordId, MAX_TEXT)! }),
      },
    }),
    ...(input.before !== undefined && { before: input.before }),
    ...(input.after !== undefined && { after: input.after }),
    ...(input.reason !== undefined && { reason: input.reason }),
    ...(input.requestId !== undefined && { requestId: clip(input.requestId, 256)! }),
    ...(input.context !== undefined && {
      context: {
        // The whole x-forwarded-for chain, as reported: only the hop the CDN added is trustworthy.
        ...(input.context.ip !== undefined && { ip: clip(input.context.ip, 256)! }),
        ...(input.context.userAgent !== undefined && { userAgent: clip(input.context.userAgent, 512)! }),
      },
    }),
    ...(input.calls !== undefined && { calls: input.calls.map((c) => clip(String(c), 256)!) }),
    ...(input.error !== undefined && { error: clip(input.error, 1000)! }),
  };
  const beforeJson = json(input.before, 'before');
  const afterJson = json(input.after, 'after');
  // Parse back so the returned event holds exactly what's stored (no class instances or undefineds).
  if (beforeJson !== undefined) event.before = JSON.parse(beforeJson) as unknown;
  if (afterJson !== undefined) event.after = JSON.parse(afterJson) as unknown;
  const tk = targetKeyOf(event.target);
  return {
    event,
    ...(beforeJson !== undefined && { beforeJson }),
    ...(afterJson !== undefined && { afterJson }),
    entryId,
    sk: `${startedAt}#${entryId}#${phase === 'result' ? '1' : '0'}`,
    actorKey: `ACTOR#${event.actor.sub}`,
    ...(tk !== undefined && { targetKey: tk }),
  };
}

const S = (value: string): AttributeValue => ({ S: value });

function toItem(row: Row): Record<string, AttributeValue> {
  const e = row.event;
  const item: Record<string, AttributeValue> = {
    [AUDIT_TABLE_SCHEMA.partitionKey]: S(AUDIT_TABLE_SCHEMA.partitionValue),
    [AUDIT_TABLE_SCHEMA.sortKey]: S(row.sk),
    id: S(e.id),
    at: S(e.at),
    startedAt: S(e.startedAt),
    entryId: S(row.entryId),
    phase: S(e.phase),
    action: S(e.action),
    actorSub: S(e.actor.sub),
    [AUDIT_TABLE_SCHEMA.indexes.byActor.partitionKey]: S(row.actorKey),
    v: { N: String(AUDIT_TABLE_SCHEMA.version) },
  };
  const put = (name: string, value: string | undefined) => {
    if (value !== undefined && value !== '') item[name] = S(value);
  };
  put('outcome', e.outcome);
  put('intentId', e.intentId);
  put('actorEmail', e.actor.email);
  put('actorKind', e.actor.kind);
  put('targetSub', e.target?.sub);
  put('targetEmail', e.target?.email);
  put('targetRecordId', e.target?.recordId);
  put(AUDIT_TABLE_SCHEMA.indexes.byTarget.partitionKey, row.targetKey);
  put('before', row.beforeJson);
  put('after', row.afterJson);
  put('reason', e.reason);
  put('requestId', e.requestId);
  put('ip', e.context?.ip);
  put('userAgent', e.context?.userAgent);
  put('error', e.error);
  if (e.calls !== undefined) item.calls = { L: e.calls.map(S) };
  return item;
}

function itemBytes(item: Record<string, AttributeValue>): number {
  const enc = new TextEncoder();
  let total = 0;
  for (const [name, value] of Object.entries(item)) {
    total += enc.encode(name).length;
    if (value.S !== undefined) total += enc.encode(value.S).length;
    else if (value.N !== undefined) total += value.N.length;
    else if (value.L !== undefined) for (const v of value.L) total += 3 + enc.encode(v.S ?? '').length;
  }
  return total;
}

function str(item: Record<string, AttributeValue>, name: string): string | undefined {
  return item[name]?.S;
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function fromItem(item: Record<string, AttributeValue>): AuditEvent {
  const phase = (str(item, 'phase') ?? 'event') as AuditPhase;
  const targetSub = str(item, 'targetSub');
  const targetEmail = str(item, 'targetEmail');
  const targetRecordId = str(item, 'targetRecordId');
  const ip = str(item, 'ip');
  const userAgent = str(item, 'userAgent');
  const before = parseJson(str(item, 'before'));
  const after = parseJson(str(item, 'after'));
  const outcome = str(item, 'outcome') as AuditOutcome | undefined;
  const actorEmail = str(item, 'actorEmail');
  const actorKind = str(item, 'actorKind') as 'person' | 'system' | undefined;
  const at = str(item, 'at') ?? '';
  return {
    id: str(item, 'id') ?? '',
    at,
    phase,
    ...(outcome !== undefined && { outcome }),
    ...(str(item, 'intentId') !== undefined && { intentId: str(item, 'intentId')! }),
    startedAt: str(item, 'startedAt') ?? at,
    actor: {
      sub: str(item, 'actorSub') ?? '',
      ...(actorEmail !== undefined && { email: actorEmail }),
      ...(actorKind !== undefined && { kind: actorKind }),
    },
    action: str(item, 'action') ?? '',
    ...((targetSub ?? targetEmail ?? targetRecordId) !== undefined && {
      target: {
        ...(targetSub !== undefined && { sub: targetSub }),
        ...(targetEmail !== undefined && { email: targetEmail }),
        ...(targetRecordId !== undefined && { recordId: targetRecordId }),
      },
    }),
    ...(before !== undefined && { before }),
    ...(after !== undefined && { after }),
    ...(str(item, 'reason') !== undefined && { reason: str(item, 'reason')! }),
    ...(str(item, 'requestId') !== undefined && { requestId: str(item, 'requestId')! }),
    ...((ip ?? userAgent) !== undefined && {
      context: { ...(ip !== undefined && { ip }), ...(userAgent !== undefined && { userAgent }) },
    }),
    ...(item.calls?.L !== undefined && { calls: item.calls.L.map((v) => v.S ?? '') }),
    ...(str(item, 'error') !== undefined && { error: str(item, 'error')! }),
  };
}

// ---- Paging and the Activity merge -----------------------------------------------------------

type Key = Record<string, string>;
interface FetchedRow {
  event: AuditEvent;
  key: Key;
}
type PageFetcher = (start: Key | undefined, limit: number) => Promise<{ rows: FetchedRow[]; lastKey?: Key }>;

const KEY_NAMES = new Set<string>([
  AUDIT_TABLE_SCHEMA.partitionKey,
  AUDIT_TABLE_SCHEMA.sortKey,
  AUDIT_TABLE_SCHEMA.indexes.byActor.partitionKey,
  AUDIT_TABLE_SCHEMA.indexes.byTarget.partitionKey,
]);

interface CursorState {
  k: Key;
  /** The intent of the last result row on the previous page: its intent row is next, and is done. */
  r?: string;
}

function encodeCursor(state: CursorState): string {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
}

/** Cursors come back from the browser, so they're checked before reaching DynamoDB. */
function decodeCursor(cursor: string | undefined): CursorState | undefined {
  if (cursor === undefined || cursor === '') return undefined;
  const bad = () => new AuditEventInvalidError('that page link is invalid.');
  if (cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw bad();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw bad();
  }
  if (typeof parsed !== 'object' || parsed === null) throw bad();
  const { k, r } = parsed as { k?: unknown; r?: unknown };
  if (typeof k !== 'object' || k === null) throw bad();
  const key: Key = {};
  for (const [name, value] of Object.entries(k)) {
    if (!KEY_NAMES.has(name) || typeof value !== 'string' || value.length > 1024) throw bad();
    key[name] = value;
  }
  if (!key[AUDIT_TABLE_SCHEMA.partitionKey] || !key[AUDIT_TABLE_SCHEMA.sortKey]) throw bad();
  if (r !== undefined && (typeof r !== 'string' || r.length > 128)) throw bad();
  return { k: key, ...(typeof r === 'string' && { r }) };
}

function pageLimit(limit: number | undefined): number {
  const n = limit ?? ADMIN_POLICY.activityPageSize;
  if (!Number.isInteger(n) || n < 1) throw new AuditEventInvalidError('limit must be a positive whole number.');
  return Math.min(n, ADMIN_POLICY.activityMaxPageSize);
}

/**
 * Walks pages until `want` items are accepted. `accept` returns true when a row counts toward the
 * page. The cursor points just past the last row consumed, so nothing is skipped or repeated.
 */
async function collect(
  fetch: PageFetcher,
  want: number,
  cursor: CursorState | undefined,
  accept: (row: AuditEvent) => boolean,
): Promise<{ consumedLast?: FetchedRow; nextKey?: Key }> {
  let start = cursor?.k;
  let accepted = 0;
  let consumedLast: FetchedRow | undefined;
  for (let guard = 0; guard < 1000; guard++) {
    const page = await fetch(start, Math.min(200, (want - accepted) * 2 + 2));
    for (let i = 0; i < page.rows.length; i++) {
      const row = page.rows[i]!;
      consumedLast = row;
      if (accept(row.event)) accepted++;
      if (accepted >= want) {
        const more = i < page.rows.length - 1 || page.lastKey !== undefined;
        return { consumedLast, ...(more && { nextKey: row.key }) };
      }
    }
    if (!page.lastKey) return { ...(consumedLast !== undefined && { consumedLast }) };
    start = page.lastKey;
  }
  throw new Error('auth-kit: the audit log query did not finish.');
}

async function listEvents(fetch: PageFetcher, query: AuditLogQuery): Promise<AuditLogPage> {
  const want = pageLimit(query.limit);
  const cursor = decodeCursor(query.cursor);
  const events: AuditEvent[] = [];
  const { nextKey } = await collect(fetch, want, cursor, (e) => {
    events.push(e);
    return true;
  });
  return { events, ...(nextKey !== undefined && { nextCursor: encodeCursor({ k: nextKey }) }) };
}

/**
 * Newest first. Within a partition a result row sorts just before its intent, so the merge only has
 * to remember the latest result's intent (carried across pages in the cursor).
 */
async function listActivityEntries(
  fetch: PageFetcher,
  query: AuditLogQuery,
): Promise<{ entries: ActivityEntry[]; nextCursor?: string }> {
  const want = pageLimit(query.limit);
  const cursor = decodeCursor(query.cursor);
  const entries: ActivityEntry[] = [];
  let resolved = cursor?.r;
  const { nextKey, consumedLast } = await collect(fetch, want, cursor, (e) => {
    switch (e.phase) {
      case 'result':
        entries.push({ event: e, status: e.outcome ?? 'ok' });
        resolved = e.intentId;
        return true;
      case 'intent':
        if (resolved === e.id) return false;
        entries.push({ event: e, status: 'unknown' });
        return true;
      case 'refused':
        entries.push({ event: e, status: 'refused' });
        return true;
      case 'event':
        entries.push({ event: e, status: 'recorded' });
        return true;
    }
  });
  if (nextKey === undefined) return { entries };
  const r = consumedLast?.event.phase === 'result' ? consumedLast.event.intentId : undefined;
  return { entries, nextCursor: encodeCursor({ k: nextKey, ...(r !== undefined && { r }) }) };
}

function rangeBounds(query: AuditLogQuery): { from?: string; to?: string } {
  const iso = (v: string | undefined, what: string) => {
    if (v === undefined) return undefined;
    if (Number.isNaN(Date.parse(v))) throw new AuditEventInvalidError(`"${what}" must be an ISO 8601 date.`);
    return new Date(v).toISOString();
  };
  const from = iso(query.since, 'since');
  const until = iso(query.until, 'until');
  // The highest code unit, so `until` includes every row that started at that instant.
  return { ...(from !== undefined && { from }), ...(until !== undefined && { to: until + String.fromCharCode(0xffff) }) };
}

function actionMatches(action: string, filter: string | undefined): boolean {
  if (filter === undefined) return true;
  return filter.endsWith('.') ? action.startsWith(filter) : action === filter;
}

function partitionFor(query: AuditLogQuery): { index?: string; keyName: string; keyValue: string } {
  const named = [query.actorSub, query.targetSub, query.targetEmail, query.targetRecordId].filter((v) => v !== undefined);
  if (named.length > 1) throw new AuditEventInvalidError('filter by one of actor, target, email, or record at a time.');
  for (const v of named) if (typeof v !== 'string' || v.length === 0 || v.length > 512) throw new AuditEventInvalidError('invalid filter value.');
  const { byActor, byTarget } = AUDIT_TABLE_SCHEMA.indexes;
  if (query.actorSub !== undefined) return { index: byActor.name, keyName: byActor.partitionKey, keyValue: `ACTOR#${query.actorSub}` };
  if (query.targetSub !== undefined) return { index: byTarget.name, keyName: byTarget.partitionKey, keyValue: `TARGET#${query.targetSub}` };
  if (query.targetEmail !== undefined) {
    return { index: byTarget.name, keyName: byTarget.partitionKey, keyValue: `EMAIL#${query.targetEmail.toLowerCase()}` };
  }
  if (query.targetRecordId !== undefined) {
    return { index: byTarget.name, keyName: byTarget.partitionKey, keyValue: `RECORD#${query.targetRecordId}` };
  }
  return { keyName: AUDIT_TABLE_SCHEMA.partitionKey, keyValue: AUDIT_TABLE_SCHEMA.partitionValue };
}

function keyOfItem(item: Record<string, AttributeValue>, indexKey?: string): Key {
  const key: Key = {
    [AUDIT_TABLE_SCHEMA.partitionKey]: str(item, AUDIT_TABLE_SCHEMA.partitionKey) ?? '',
    [AUDIT_TABLE_SCHEMA.sortKey]: str(item, AUDIT_TABLE_SCHEMA.sortKey) ?? '',
  };
  if (indexKey !== undefined) key[indexKey] = str(item, indexKey) ?? '';
  return key;
}

const toAttributeKey = (key: Key): Record<string, AttributeValue> =>
  Object.fromEntries(Object.entries(key).map(([k, v]) => [k, S(v)]));

const fromAttributeKey = (key: Record<string, AttributeValue>): Key =>
  Object.fromEntries(Object.entries(key).map(([k, v]) => [k, v.S ?? '']));

function validateActionFilter(action: string | undefined): void {
  if (action === undefined) return;
  const base = action.endsWith('.') ? action.slice(0, -1) : action;
  if (!/^[a-z][a-zA-Z0-9-]*(?:\.[a-zA-Z][a-zA-Z0-9-]*)*$/.test(base) || action.length > 100) {
    throw new AuditEventInvalidError(`"${action}" isn't an action or an action prefix.`);
  }
}

// ---- IDs ---------------------------------------------------------------------------------------

let sequence = 0;

/**
 * Row IDs: a per-process sequence, then a random UUID. Rows sort by time, then ID, so two rows written
 * in the same millisecond by one server keep their order; the UUID keeps IDs unique across servers.
 */
export function newAuditId(): string {
  sequence = (sequence + 1) % 36 ** 8;
  return `${sequence.toString(36).padStart(8, '0')}-${globalThis.crypto.randomUUID()}`;
}

// ---- DynamoDB --------------------------------------------------------------------------------

export interface DynamoAuditLogOptions {
  tableName: string;
  /** Default: the SDK's (the server's region). */
  region?: string;
  /** Inject a client (tests, custom credentials). */
  client?: DynamoDBClient;
  /** Milliseconds since the epoch (tests). */
  now?: () => number;
  /** Row IDs. Default `newAuditId()`. */
  newId?: () => string;
  sleep?: Sleep;
}

/**
 * The DynamoDB audit log. Every write is `PutItem` with `attribute_not_exists(pk)`; reads are
 * `Query`. Those are the only two calls this code makes, so the app's role needs nothing else.
 */
export function createDynamoAuditLog(options: DynamoAuditLogOptions): AuditLogStore {
  if (!options.tableName) throw new Error('auth-kit: createDynamoAuditLog needs a tableName.');
  let client = options.client;
  const db = (): DynamoDBClient => (client ??= new DynamoDBClient(options.region ? { region: options.region } : {}));
  const now = options.now ?? Date.now;
  const newId = options.newId ?? newAuditId;
  const sleep = options.sleep ?? realSleep;
  const { partitionKey } = AUDIT_TABLE_SCHEMA;

  async function put(row: Row): Promise<void> {
    const item = toItem(row);
    if (itemBytes(item) > ADMIN_POLICY.auditMaxItemBytes) {
      throw new AuditEventInvalidError('the audit row is too large; log a reference (a version or an ID) instead of the content.');
    }
    try {
      await withBackoff(
        () =>
          db().send(
            new PutItemCommand({
              TableName: options.tableName,
              Item: item,
              ConditionExpression: 'attribute_not_exists(#pk)',
              ExpressionAttributeNames: { '#pk': partitionKey },
            }),
          ),
        { sleep, maxAttempts: 4, retryable: isThrottlingError },
      );
    } catch (error) {
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') throw new AuditRowExistsError();
      throw error;
    }
  }

  const fetcherFor = (query: AuditLogQuery): PageFetcher => {
    validateActionFilter(query.action);
    const part = partitionFor(query);
    const { from, to } = rangeBounds(query);
    const names: Record<string, string> = { '#p': part.keyName, '#s': AUDIT_TABLE_SCHEMA.sortKey };
    const values: Record<string, AttributeValue> = { ':p': S(part.keyValue) };
    let condition = '#p = :p';
    if (from !== undefined && to !== undefined) {
      condition += ' AND #s BETWEEN :from AND :to';
      values[':from'] = S(from);
      values[':to'] = S(to);
    } else if (from !== undefined) {
      condition += ' AND #s >= :from';
      values[':from'] = S(from);
    } else if (to !== undefined) {
      condition += ' AND #s <= :to';
      values[':to'] = S(to);
    }
    let filter: string | undefined;
    if (query.action !== undefined) {
      names['#a'] = 'action';
      values[':a'] = S(query.action);
      filter = query.action.endsWith('.') ? 'begins_with(#a, :a)' : '#a = :a';
    }
    return async (start, limit) => {
      const input: QueryCommandInput = {
        TableName: options.tableName,
        KeyConditionExpression: condition,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ScanIndexForward: false,
        Limit: limit,
        ...(part.index !== undefined && { IndexName: part.index }),
        ...(filter !== undefined && { FilterExpression: filter }),
        ...(start !== undefined && { ExclusiveStartKey: toAttributeKey(start) }),
      };
      const out = await withBackoff(() => db().send(new QueryCommand(input)), {
        sleep,
        retryable: (e) => isThrottlingError(e) || isTransientError(e),
      });
      return {
        rows: (out.Items ?? []).map((item) => ({ event: fromItem(item), key: keyOfItem(item, part.index ? part.keyName : undefined) })),
        ...(out.LastEvaluatedKey !== undefined && { lastKey: fromAttributeKey(out.LastEvaluatedKey) }),
      };
    };
  };

  return {
    async append(input) {
      const at = new Date(now()).toISOString();
      // Result rows get a fixed ID from their intent, so a retried write can't create a second one.
      const id = (input.phase ?? 'event') === 'result' && input.intent ? `${input.intent.id}.result` : newId();
      const row = buildRow(input, id, at);
      try {
        await put(row);
      } catch (error) {
        // A random-ID collision is astronomically unlikely, but it must never overwrite: retry with a new ID.
        if (error instanceof AuditRowExistsError && row.event.phase !== 'result') {
          const retry = buildRow(input, newId(), at);
          await put(retry);
          return retry.event;
        }
        throw error;
      }
      return row.event;
    },
    list: async (query = {}) => listEvents(fetcherFor(query), query),
    listActivity: async (query = {}) => listActivityEntries(fetcherFor(query), query),
  };
}

// ---- In memory -------------------------------------------------------------------------------

export interface MemoryAuditLog extends AuditLogStore {
  /** Every row, oldest first (a copy). */
  readonly rows: readonly AuditEvent[];
  /** Makes the next N appends fail with `error` (tests of failure ordering). */
  failNextAppends(count: number, error?: Error): void;
}

/**
 * An in-memory audit log with the same append-only rules and paging, for tests and local tools.
 * Never use it in production: it forgets everything on restart.
 */
export function createMemoryAuditLog(options: { now?: () => number; newId?: () => string } = {}): MemoryAuditLog {
  const now = options.now ?? Date.now;
  const newId = options.newId ?? newAuditId;
  const rows: Row[] = [];
  const keys = new Set<string>();
  let failures: { count: number; error: Error } = { count: 0, error: new Error('injected audit failure') };

  const fetcherFor = (query: AuditLogQuery): PageFetcher => {
    validateActionFilter(query.action);
    const part = partitionFor(query);
    const { from, to } = rangeBounds(query);
    const matching = () =>
      rows
        .filter((r) => {
          const value =
            part.keyName === AUDIT_TABLE_SCHEMA.partitionKey
              ? AUDIT_TABLE_SCHEMA.partitionValue
              : part.keyName === AUDIT_TABLE_SCHEMA.indexes.byActor.partitionKey
                ? r.actorKey
                : r.targetKey;
          return value === part.keyValue && (from === undefined || r.sk >= from) && (to === undefined || r.sk <= to);
        })
        .sort((a, b) => (a.sk < b.sk ? 1 : a.sk > b.sk ? -1 : 0));
    return (start, limit) => {
      const all = matching();
      const startSk = start?.[AUDIT_TABLE_SCHEMA.sortKey];
      const begin = startSk === undefined ? 0 : all.findIndex((r) => r.sk < startSk);
      const slice = begin < 0 ? [] : all.slice(begin, begin + limit);
      const keyOf = (r: Row): Key => ({
        [AUDIT_TABLE_SCHEMA.partitionKey]: AUDIT_TABLE_SCHEMA.partitionValue,
        [AUDIT_TABLE_SCHEMA.sortKey]: r.sk,
        ...(part.index !== undefined && { [part.keyName]: part.keyValue }),
      });
      const fetched = slice.filter((r) => actionMatches(r.event.action, query.action)).map((r) => ({ event: structuredClone(r.event), key: keyOf(r) }));
      const last = slice[slice.length - 1];
      const more = begin >= 0 && begin + limit < all.length && last !== undefined;
      return Promise.resolve({ rows: fetched, ...(more && { lastKey: keyOf(last) }) });
    };
  };

  return {
    get rows() {
      return rows.map((r) => structuredClone(r.event));
    },
    failNextAppends(count, error) {
      failures = { count, error: error ?? failures.error };
    },
    append(input) {
      if (failures.count > 0) {
        failures.count--;
        return Promise.reject(failures.error);
      }
      try {
        const at = new Date(now()).toISOString();
        const id = (input.phase ?? 'event') === 'result' && input.intent ? `${input.intent.id}.result` : newId();
        const row = buildRow(input, id, at);
        const item = toItem(row);
        if (itemBytes(item) > ADMIN_POLICY.auditMaxItemBytes) throw new AuditEventInvalidError('the audit row is too large.');
        if (keys.has(row.sk)) throw new AuditRowExistsError();
        keys.add(row.sk);
        rows.push(row);
        return Promise.resolve(structuredClone(row.event));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    list: async (query = {}) => listEvents(fetcherFor(query), query),
    listActivity: async (query = {}) => listActivityEntries(fetcherFor(query), query),
  };
}

// ---- Writing a change with its log ------------------------------------------------------------

/** The intent couldn't be written, so the change never started. */
export class AuditUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("auth-kit: couldn't write the audit log, so nothing was changed.", options);
    this.name = 'AuditUnavailableError';
  }
}

/** The change ran (fully or partly) and its intent is logged, but the result row couldn't be written. */
export class AuditIncompleteError<T = unknown> extends Error {
  readonly intent: AuditEvent;
  readonly outcome: AuditOutcome;
  readonly value: T | undefined;
  constructor(intent: AuditEvent, outcome: AuditOutcome, value: T | undefined, options?: { cause?: unknown }) {
    super(
      "auth-kit: the change was made and its intent is in the audit log, but its result couldn't be recorded. The Activity page shows it as \"outcome not recorded\".",
      options,
    );
    this.name = 'AuditIncompleteError';
    this.intent = intent;
    this.outcome = outcome;
    this.value = value;
  }
}

/** Records each call a change makes, in order, for the result row. */
export interface ChangeSteps {
  /** Runs one call and records whether it succeeded. Rethrows its error. */
  call<T>(label: string, fn: () => Promise<T>): Promise<T>;
  /**
   * Undoes earlier work after a failure; resolves true when the undo succeeded (it never throws). When
   * every rollback succeeds, the outcome is `failed` (nothing changed).
   */
  rollback(label: string, fn: () => Promise<unknown>): Promise<boolean>;
  /** Labels of the calls that changed something, in order (rollbacks excluded). */
  readonly changed: readonly string[];
}

export type AuditedRun<T> =
  /** The intent row couldn't be written. Nothing ran. */
  | { kind: 'not-started'; error: unknown }
  | {
      kind: 'done';
      value: T;
      intent: AuditEvent;
      /** Missing when the result row couldn't be written (`resultError` says why). */
      result?: AuditEvent;
      resultError?: unknown;
    }
  | {
      kind: 'failed';
      error: unknown;
      /** True when something changed before the failure and wasn't rolled back. */
      changed: boolean;
      intent: AuditEvent;
      result?: AuditEvent;
      resultError?: unknown;
    };

export interface AuditedChange<T> {
  /** The intent row: who, to whom, what, before, the intended after, why, request context, planned calls. */
  intent: Omit<AuditEventInput, 'phase' | 'outcome' | 'intent'>;
  /** Makes the change through `steps`. Its return value's `after`, if given, is logged as what happened. */
  run: (steps: ChangeSteps) => Promise<{ value: T; after?: unknown; target?: AuditEventInput['target'] }>;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 500);
  return String(error).slice(0, 500);
}

/**
 * The ordering every logged change follows (the primer's "intent row, the calls, a result row"):
 *
 * 1. Write the intent row. If that fails, stop: nothing has changed, so nothing is unlogged.
 * 2. Make the calls, recording each.
 * 3. Write the result row (outcome, calls made, any error, the actual after), retrying on failure.
 *    Its key is fixed by the intent, so a retry can never create a second one.
 *
 * A database and Cognito can't share a transaction, so step 3 can still fail after step 2 changed
 * something. Then the change is logged as an intent without a result, which the Activity page shows
 * as "outcome not recorded" (never as "didn't happen"), and the caller reports the failure.
 */
export async function runAudited<T>(
  log: AuditLogStore,
  change: AuditedChange<T>,
  options: { resultAttempts?: number; sleep?: Sleep } = {},
): Promise<AuditedRun<T>> {
  let intent: AuditEvent;
  try {
    intent = await log.append({ ...change.intent, phase: 'intent' });
  } catch (error) {
    return { kind: 'not-started', error };
  }

  const made: string[] = [];
  const changed: string[] = [];
  let rollbacksFailed = false;
  let rolledBack = false;
  const steps: ChangeSteps = {
    async call(label, fn) {
      try {
        const value = await fn();
        made.push(`${label}: ok`);
        changed.push(label);
        return value;
      } catch (error) {
        made.push(`${label}: failed (${(error as { name?: string }).name ?? 'Error'})`);
        throw error;
      }
    },
    async rollback(label, fn) {
      rolledBack = true;
      try {
        await fn();
        made.push(`${label} (rollback): ok`);
        return true;
      } catch (error) {
        rollbacksFailed = true;
        made.push(`${label} (rollback): failed (${(error as { name?: string }).name ?? 'Error'})`);
        return false;
      }
    },
    get changed() {
      return [...changed];
    },
  };

  let outcome: AuditOutcome;
  let value: T | undefined;
  let after: unknown = change.intent.after;
  let target = change.intent.target;
  let failure: unknown;
  let failed = false;
  try {
    const out = await change.run(steps);
    value = out.value;
    if (out.after !== undefined) after = out.after;
    if (out.target !== undefined) target = out.target;
    outcome = 'ok';
  } catch (error) {
    failed = true;
    failure = error;
    const undone = rolledBack && !rollbacksFailed;
    outcome = changed.length > 0 && !undone ? 'partial' : 'failed';
  }

  // A failed row keeps the intended `after`; its outcome says it didn't (fully) happen, and the
  // Activity page words it as "tried to".
  const resultInput: AuditEventInput = {
    ...change.intent,
    ...(target !== undefined && { target }),
    ...(after !== undefined && { after }),
    phase: 'result',
    outcome,
    intent: { id: intent.id, at: intent.at },
    calls: made,
    ...(failed && { error: describeError(failure) }),
  };

  let result: AuditEvent | undefined;
  let resultError: unknown;
  try {
    result = await withBackoff(
      async () => {
        try {
          return await log.append(resultInput);
        } catch (error) {
          // An earlier attempt landed even though it reported an error: the row is there.
          if (error instanceof AuditRowExistsError) {
            return { ...intent, id: `${intent.id}.result`, phase: 'result', outcome, intentId: intent.id, calls: made };
          }
          throw error;
        }
      },
      {
        maxAttempts: options.resultAttempts ?? 3,
        baseDelayMs: 50,
        retryable: (e) => !(e instanceof AuditEventInvalidError),
        ...(options.sleep !== undefined && { sleep: options.sleep }),
      },
    );
  } catch (error) {
    resultError = error;
  }

  if (failed) {
    const undone = rolledBack && !rollbacksFailed;
    return {
      kind: 'failed',
      error: failure,
      changed: changed.length > 0 && !undone,
      intent,
      ...(result !== undefined && { result }),
      ...(resultError !== undefined && { resultError }),
    };
  }
  return {
    kind: 'done',
    value: value as T,
    intent,
    ...(result !== undefined && { result }),
    ...(resultError !== undefined && { resultError }),
  };
}

/**
 * For an app's own changes (content saves, publishes, settings): the same ordering as the People
 * actions, as one call that throws.
 *
 * ```ts
 * await recordChange(auditLog, {
 *   intent: { actor: { sub: user.sub }, action: 'content.publish', target: { recordId: page.id }, before: { version: 6 }, after: { version: 7 } },
 *   run: async (steps) => ({ value: await steps.call('db.publish', () => publish(page.id, 7)) }),
 * });
 * ```
 *
 * Throws `AuditUnavailableError` (nothing ran), the change's own error (after logging the failure),
 * or `AuditIncompleteError` (the change ran; its result row is missing).
 */
export async function recordChange<T>(log: AuditLogStore, change: AuditedChange<T>): Promise<T> {
  const run = await runAudited(log, change);
  switch (run.kind) {
    case 'not-started':
      throw new AuditUnavailableError({ cause: run.error });
    case 'failed':
      throw run.error instanceof Error ? run.error : new Error(String(run.error));
    case 'done':
      if (run.result === undefined) throw new AuditIncompleteError(run.intent, 'ok', run.value, { cause: run.resultError });
      return run.value;
  }
}
