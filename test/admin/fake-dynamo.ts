import { type AttributeValue, DynamoDBClient, PutItemCommand, QueryCommand, type QueryCommandInput } from '@aws-sdk/client-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

type Item = Record<string, AttributeValue>;

const s = (item: Item, name: string) => item[name]?.S;

/**
 * A DynamoDB stand-in behind aws-sdk-client-mock that understands exactly the expressions the audit
 * store sends: a conditional PutItem and a Query on the table or a GSI (key range, optional action
 * filter, newest first, Limit before filter, LastEvaluatedKey). Anything else fails the test.
 */
export function fakeDynamo() {
  const client = new DynamoDBClient({ region: 'us-east-1', credentials: { accessKeyId: 'x', secretAccessKey: 'y' } });
  const mock = mockClient(client);
  const items: Item[] = [];
  const failures: Error[] = [];
  /** Errors thrown after the write lands (an ambiguous failure, like a timeout on the way back). */
  const landedFailures: Error[] = [];

  mock.on(PutItemCommand).callsFake((input: { Item: Item; ConditionExpression?: string; ExpressionAttributeNames?: Record<string, string> }) => {
    const next = failures.shift();
    if (next) throw next;
    if (input.ConditionExpression !== 'attribute_not_exists(#pk)' || input.ExpressionAttributeNames?.['#pk'] !== 'pk') {
      throw new Error('fake-dynamo: every PutItem must be conditional on attribute_not_exists(pk)');
    }
    const exists = items.some((i) => s(i, 'pk') === s(input.Item, 'pk') && s(i, 'sk') === s(input.Item, 'sk'));
    if (exists) throw Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });
    items.push(structuredClone(input.Item));
    const after = landedFailures.shift();
    if (after) throw after;
    return {};
  });

  mock.on(QueryCommand).callsFake((input: QueryCommandInput) => {
    const next = failures.shift();
    if (next) throw next;
    const names = input.ExpressionAttributeNames ?? {};
    const values = input.ExpressionAttributeValues ?? {};
    const keyName = names['#p']!;
    const keyValue = values[':p']!.S!;
    const cond = input.KeyConditionExpression ?? '';
    const from = /BETWEEN :from|>= :from/.test(cond) ? values[':from']!.S! : undefined;
    const to = /AND :to|<= :to/.test(cond) ? values[':to']!.S! : undefined;
    const filter = input.FilterExpression;
    const actionValue = values[':a']?.S;
    if (input.ScanIndexForward !== false) throw new Error('fake-dynamo: the audit store always reads newest first');
    let rows = items
      .filter((i) => s(i, keyName) === keyValue)
      .filter((i) => (from === undefined || s(i, 'sk')! >= from) && (to === undefined || s(i, 'sk')! <= to))
      .sort((a, b) => (s(a, 'sk')! < s(b, 'sk')! ? 1 : -1));
    const start = input.ExclusiveStartKey?.sk?.S;
    if (start !== undefined) rows = rows.filter((i) => s(i, 'sk')! < start);
    const limit = input.Limit ?? rows.length;
    const evaluated = rows.slice(0, limit);
    const more = rows.length > limit;
    const matched = evaluated.filter((i) => {
      if (!filter) return true;
      const action = s(i, 'action') ?? '';
      if (filter === '#a = :a') return action === actionValue;
      if (filter === 'begins_with(#a, :a)') return action.startsWith(actionValue!);
      throw new Error(`fake-dynamo: unexpected filter ${filter}`);
    });
    const last = evaluated[evaluated.length - 1];
    const lastKey =
      more && last
        ? { pk: last.pk!, sk: last.sk!, ...(input.IndexName !== undefined && { [keyName]: last[keyName]! }) }
        : undefined;
    return { Items: structuredClone(matched), ...(lastKey && { LastEvaluatedKey: lastKey }) };
  });

  return {
    client,
    mock,
    items,
    /** The next call (put or query) throws this. */
    failNext: (error: Error) => void failures.push(error),
    /** The next put lands, then throws this. */
    landThenFail: (error: Error) => void landedFailures.push(error),
    /** Names of every command sent so far. */
    commandNames: () => mock.calls().map((c) => (c.args[0] as { constructor: { name: string } }).constructor.name),
  };
}
