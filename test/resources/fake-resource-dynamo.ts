import {
  type AttributeValue,
  DynamoDBClient,
  GetItemCommand,
  type GetItemCommandInput,
  QueryCommand,
  type QueryCommandInput,
  TransactWriteItemsCommand,
  type TransactWriteItemsCommandInput,
} from '@aws-sdk/client-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

type Item = Record<string, AttributeValue>;
const s = (item: Item | undefined, name: string) => item?.[name]?.S;

/**
 * DynamoDB behind aws-sdk-client-mock, understanding exactly what the resource store sends: a
 * consistent GetItem by key; a consistent Query on the table's partition, or on the `byPerson` index
 * (with an optional `begins_with` on its sort key), paged by `pageSize`; and TransactWriteItems of
 * Put and Delete whose conditions are `attribute_not_exists(#pk)` or `#v = :v`, all-or-nothing, and
 * idempotent per ClientRequestToken. Anything else fails the test.
 */
export function fakeResourceDynamo(options: { pageSize?: number } = {}) {
  const client = new DynamoDBClient({ region: 'us-east-1', credentials: { accessKeyId: 'x', secretAccessKey: 'y' } });
  const mock = mockClient(client);
  const items = new Map<string, Item>();
  const key = (pk: string, sk: string) => `${pk}\n${sk}`;
  const failures: Error[] = [];
  const landedFailures: Error[] = [];
  const tokens = new Set<string>();
  const pageSize = options.pageSize ?? 1000;

  mock.on(GetItemCommand).callsFake((input: GetItemCommandInput) => {
    const next = failures.shift();
    if (next) throw next;
    if (input.ConsistentRead !== true) throw new Error('fake: access checks read consistently');
    const found = items.get(key(s(input.Key, 'pk')!, s(input.Key, 'sk')!));
    return found ? { Item: structuredClone(found) } : {};
  });

  mock.on(QueryCommand).callsFake((input: QueryCommandInput) => {
    const next = failures.shift();
    if (next) throw next;
    const names = input.ExpressionAttributeNames ?? {};
    const values = input.ExpressionAttributeValues ?? {};
    let rows: Item[];
    if (input.IndexName === undefined) {
      if (input.KeyConditionExpression !== '#pk = :pk' || names['#pk'] !== 'pk') throw new Error(`fake: unexpected table query ${input.KeyConditionExpression}`);
      if (input.ConsistentRead !== true) throw new Error('fake: an item’s access is read consistently');
      rows = [...items.values()].filter((i) => s(i, 'pk') === values[':pk']!.S).sort((a, b) => s(a, 'sk')!.localeCompare(s(b, 'sk')!));
    } else {
      if (input.IndexName !== 'byPerson' || names['#p'] !== 'personKey') throw new Error(`fake: unexpected index query ${input.IndexName}`);
      if (input.ConsistentRead) throw new Error('fake: a GSI can’t be read consistently');
      const prefix = /begins_with\(#r, :r\)/.test(input.KeyConditionExpression ?? '') ? values[':r']!.S! : undefined;
      if (prefix !== undefined && names['#r'] !== 'pk') throw new Error('fake: begins_with on the index sort key (pk)');
      rows = [...items.values()]
        .filter((i) => s(i, 'personKey') === values[':p']!.S && (prefix === undefined || s(i, 'pk')!.startsWith(prefix)))
        .sort((a, b) => s(a, 'pk')!.localeCompare(s(b, 'pk')!));
    }
    const start = input.ExclusiveStartKey;
    if (start) {
      const at = rows.findIndex((i) => s(i, 'pk') === start.pk?.S && s(i, 'sk') === start.sk?.S);
      rows = rows.slice(at + 1);
    }
    const page = rows.slice(0, pageSize);
    const last = page[page.length - 1];
    return {
      Items: structuredClone(page),
      ...(rows.length > pageSize && last && { LastEvaluatedKey: { pk: last.pk!, sk: last.sk!, ...(input.IndexName && { personKey: last.personKey! }) } }),
    };
  });

  mock.on(TransactWriteItemsCommand).callsFake((input: TransactWriteItemsCommandInput) => {
    const next = failures.shift();
    if (next) throw next;
    const token = input.ClientRequestToken;
    if (!token) throw new Error('fake: every transaction carries a ClientRequestToken');
    if (tokens.has(token)) return {}; // already applied: DynamoDB answers success and applies nothing
    const list = input.TransactItems ?? [];
    if (list.length === 0 || list.length > 100) throw new Error('fake: 1 to 100 items per transaction');
    const reasons = list.map((t) => {
      const op = t.Put ?? t.Delete;
      if (!op || (t.Put && t.Delete) || t.Update || t.ConditionCheck) throw new Error('fake: only Put and Delete');
      const k = t.Put ? key(s(t.Put.Item, 'pk')!, s(t.Put.Item, 'sk')!) : key(s(t.Delete!.Key, 'pk')!, s(t.Delete!.Key, 'sk')!);
      const current = items.get(k);
      const cond = op.ConditionExpression;
      if (cond === undefined) return { Code: 'None' };
      if (cond === 'attribute_not_exists(#pk)' && op.ExpressionAttributeNames?.['#pk'] === 'pk') return { Code: current ? 'ConditionalCheckFailed' : 'None' };
      if (cond === '#v = :v' && op.ExpressionAttributeNames?.['#v'] === 'version') {
        return { Code: current?.version?.N === op.ExpressionAttributeValues?.[':v']?.N ? 'None' : 'ConditionalCheckFailed' };
      }
      throw new Error(`fake: unexpected condition ${cond}`);
    });
    if (reasons.some((r) => r.Code !== 'None')) {
      throw Object.assign(new Error('Transaction cancelled'), { name: 'TransactionCanceledException', CancellationReasons: reasons, $metadata: { httpStatusCode: 400 } });
    }
    for (const t of list) {
      if (t.Put) items.set(key(s(t.Put.Item, 'pk')!, s(t.Put.Item, 'sk')!), structuredClone(t.Put.Item!));
      else items.delete(key(s(t.Delete!.Key, 'pk')!, s(t.Delete!.Key, 'sk')!));
    }
    tokens.add(token);
    const after = landedFailures.shift();
    if (after) throw after;
    return {};
  });

  return {
    client,
    mock,
    items,
    /** The next call throws this. */
    failNext: (error: Error) => void failures.push(error),
    /** The next transaction lands, then throws this (a lost response). */
    landThenFail: (error: Error) => void landedFailures.push(error),
    commandNames: () => mock.calls().map((c) => (c.args[0] as { constructor: { name: string } }).constructor.name),
    transactions: () => mock.commandCalls(TransactWriteItemsCommand).map((c) => c.args[0].input),
  };
}
