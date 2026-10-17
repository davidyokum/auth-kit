import { PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_TABLE_SCHEMA,
  AuditEventInvalidError,
  AuditIncompleteError,
  AuditRowExistsError,
  AuditUnavailableError,
  createDynamoAuditLog,
  createMemoryAuditLog,
  recordChange,
  runAudited,
  type AuditLogStore,
} from '../../src/admin/index.js';
import { fakeDynamo } from './fake-dynamo.js';

const actor = { sub: 'admin-sub', email: 'bob@example.org' };
const noSleep = () => Promise.resolve();

function clock(start = Date.parse('2026-10-17T10:00:00.000Z')) {
  const c = { t: start };
  return { c, now: () => (c.t += 1000) };
}

function ids() {
  let n = 0;
  return () => `id-${String(++n).padStart(4, '0')}`;
}

function dynamo() {
  const fake = fakeDynamo();
  const { now } = clock();
  const log = createDynamoAuditLog({ tableName: 'audit-test', client: fake.client, now, newId: ids(), sleep: noSleep });
  return { fake, log };
}

describe('DynamoDB audit log: append-only writes', () => {
  it('writes one conditional PutItem with the documented layout', async () => {
    const { fake, log } = dynamo();
    const e = await log.append({
      phase: 'event',
      actor,
      action: 'security.export',
      target: { recordId: 'people-csv' },
      after: { rows: 12 },
      reason: 'Quarterly review',
      requestId: 'req-1',
      context: { ip: '203.0.113.24', userAgent: 'Safari' },
    });
    const put = fake.mock.commandCalls(PutItemCommand)[0]!.args[0].input;
    expect(put.TableName).toBe('audit-test');
    expect(put.ConditionExpression).toBe('attribute_not_exists(#pk)');
    expect(put.ExpressionAttributeNames).toEqual({ '#pk': AUDIT_TABLE_SCHEMA.partitionKey });
    expect(put.Item).toMatchObject({
      pk: { S: 'LOG' },
      sk: { S: `${e.at}#id-0001#0` },
      actorKey: { S: 'ACTOR#admin-sub' },
      targetKey: { S: 'RECORD#people-csv' },
      after: { S: '{"rows":12}' },
      reason: { S: 'Quarterly review' },
      ip: { S: '203.0.113.24' },
      v: { N: '1' },
    });
    expect(e).toMatchObject({ id: 'id-0001', phase: 'event', startedAt: e.at, after: { rows: 12 } });
  });

  it('offers no update or delete, and sends nothing but PutItem and Query', async () => {
    const { fake, log } = dynamo();
    expect(Object.keys(log).sort()).toEqual(['append', 'list', 'listActivity']);
    const intent = await log.append({ phase: 'intent', actor, action: 'people.disable', target: { sub: 't1' } });
    await log.append({ phase: 'result', outcome: 'ok', intent, actor, action: 'people.disable', target: { sub: 't1' } });
    await log.list();
    await log.listActivity({ targetSub: 't1' });
    expect(new Set(fake.commandNames())).toEqual(new Set(['PutItemCommand', 'QueryCommand']));
  });

  it('never replaces a row: a second result for the same intent is refused', async () => {
    const { log } = dynamo();
    const intent = await log.append({ phase: 'intent', actor, action: 'people.enable', target: { sub: 't1' } });
    await log.append({ phase: 'result', outcome: 'ok', intent, actor, action: 'people.enable' });
    await expect(log.append({ phase: 'result', outcome: 'failed', intent, actor, action: 'people.enable' })).rejects.toBeInstanceOf(
      AuditRowExistsError,
    );
  });

  it('retries a colliding random ID with a fresh one instead of overwriting', async () => {
    const fake = fakeDynamo();
    let n = 0;
    const log = createDynamoAuditLog({ tableName: 't', client: fake.client, now: () => Date.parse('2026-10-17T10:00:00Z'), newId: () => (++n <= 2 ? 'same' : 'fresh'), sleep: noSleep });
    await log.append({ actor, action: 'content.save' });
    const second = await log.append({ actor, action: 'content.save' });
    expect(second.id).toBe('fresh');
    expect(fake.items).toHaveLength(2);
  });

  it('retries throttled writes', async () => {
    const { fake, log } = dynamo();
    fake.failNext(Object.assign(new Error('slow down'), { name: 'ProvisionedThroughputExceededException' }));
    await expect(log.append({ actor, action: 'content.save' })).resolves.toMatchObject({ action: 'content.save' });
    expect(fake.mock.commandCalls(PutItemCommand)).toHaveLength(2);
  });

  it.each([
    [{ actor, action: 'Not An Action' }, /dotted/],
    [{ actor: { sub: '' }, action: 'people.invite' }, /actor/],
    [{ phase: 'result' as const, outcome: 'ok' as const, actor, action: 'people.invite' }, /intent/],
    [{ phase: 'intent' as const, outcome: 'ok' as const, actor, action: 'people.invite' }, /only result rows/],
    [{ actor, action: 'content.save', after: { body: 'x'.repeat(400_000) } }, /too large/],
    [{ actor, action: 'content.save', after: { n: BigInt(1) } }, /JSON/],
  ])('refuses a malformed row before writing: %#', async (input, message) => {
    const { fake, log } = dynamo();
    await expect(log.append(input as never)).rejects.toThrow(message);
    await expect(log.append(input as never)).rejects.toBeInstanceOf(AuditEventInvalidError);
    expect(fake.mock.commandCalls(PutItemCommand)).toHaveLength(0);
  });
});

describe('DynamoDB audit log: queries', () => {
  async function seed(log: AuditLogStore, count: number) {
    for (let i = 0; i < count; i++) {
      await log.append({ actor: i % 2 ? actor : { sub: 'owner-sub' }, action: i % 3 ? 'people.invite' : 'content.publish', target: { sub: `t${i % 4}` } });
    }
  }

  it('reads newest first, on the right index, and pages without gaps or repeats', async () => {
    const { fake, log } = dynamo();
    await seed(log, 25);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await log.list({ limit: 7, ...(cursor !== undefined && { cursor }) });
      seen.push(...page.events.map((e) => e.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    expect(seen[0]).toBe('id-0025');
    expect(seen.at(-1)).toBe('id-0001');

    await log.list({ actorSub: 'admin-sub' });
    const byActor = fake.mock.commandCalls(QueryCommand).at(-1)!.args[0].input;
    expect(byActor).toMatchObject({ IndexName: 'byActor', ScanIndexForward: false, ExpressionAttributeValues: { ':p': { S: 'ACTOR#admin-sub' } } });
    await log.list({ targetSub: 't1' });
    expect(fake.mock.commandCalls(QueryCommand).at(-1)!.args[0].input).toMatchObject({ IndexName: 'byTarget' });
  });

  it('filters by action (exact or prefix) and time, keeping the page full', async () => {
    const { log } = dynamo();
    await seed(log, 30);
    const invites = await log.list({ action: 'people.invite', limit: 5 });
    expect(invites.events).toHaveLength(5);
    expect(invites.events.every((e) => e.action === 'people.invite')).toBe(true);
    const content = await log.list({ action: 'content.', limit: 50 });
    expect(content.events).toHaveLength(10);
    const all = await log.list({ limit: 200 });
    const middle = all.events[10]!.at;
    const recent = await log.list({ since: middle, limit: 200 });
    expect(recent.events).toHaveLength(11);
    const older = await log.list({ until: middle, limit: 200 });
    expect(older.events).toHaveLength(20);
  });

  it('refuses tampered cursors and mixed filters', async () => {
    const { log } = dynamo();
    const forged = Buffer.from(JSON.stringify({ k: { pk: 'LOG', sk: 'x', evil: 'y' } })).toString('base64url');
    await expect(log.list({ cursor: forged })).rejects.toBeInstanceOf(AuditEventInvalidError);
    await expect(log.list({ cursor: 'not base64!' })).rejects.toBeInstanceOf(AuditEventInvalidError);
    await expect(log.list({ actorSub: 'a', targetSub: 'b' })).rejects.toBeInstanceOf(AuditEventInvalidError);
    await expect(log.list({ since: 'yesterday' })).rejects.toBeInstanceOf(AuditEventInvalidError);
    await expect(log.list({ action: 'people.invite; DROP' })).rejects.toBeInstanceOf(AuditEventInvalidError);
    await expect(log.list({ limit: 0 })).rejects.toBeInstanceOf(AuditEventInvalidError);
  });
});

describe('Activity merge', () => {
  it.each(['dynamo', 'memory'] as const)('%s: shows each change once, flags intents with no result, across page boundaries', async (kind) => {
    const log: AuditLogStore =
      kind === 'dynamo' ? dynamo().log : createMemoryAuditLog({ now: clock().now, newId: ids() });
    // Three completed changes, one refused, one intent whose result never landed.
    for (let i = 0; i < 3; i++) {
      const intent = await log.append({ phase: 'intent', actor, action: 'people.disable', target: { sub: `t${i}` } });
      await log.append({ phase: 'result', outcome: i === 1 ? 'partial' : 'ok', intent, actor, action: 'people.disable', target: { sub: `t${i}` } });
    }
    await log.append({ phase: 'refused', actor, action: 'people.changeRole', target: { sub: 'self' }, error: 'self: Nobody can change their own role.' });
    await log.append({ phase: 'intent', actor, action: 'people.delete', target: { sub: 'gone' } });

    const statuses: string[] = [];
    let cursor: string | undefined;
    do {
      // A page of 1 forces every result/intent pair across a page boundary.
      const page = await log.listActivity({ limit: 1, ...(cursor !== undefined && { cursor }) });
      statuses.push(...page.entries.map((e) => `${e.event.action}:${e.status}`));
      cursor = page.nextCursor;
    } while (cursor);
    expect(statuses).toEqual([
      'people.delete:unknown',
      'people.changeRole:refused',
      'people.disable:ok',
      'people.disable:partial',
      'people.disable:ok',
    ]);
  });
});

describe('runAudited: the ordering every change follows', () => {
  const intent = { actor, action: 'people.disable', target: { sub: 't1' }, before: { enabled: true }, after: { enabled: false } };

  it('writes the intent before the change and the result after it', async () => {
    const log = createMemoryAuditLog();
    const order: string[] = [];
    const run = await runAudited(log, {
      intent,
      run: async (steps) => {
        order.push(`rows before change: ${log.rows.length}`);
        await steps.call('AdminDisableUser', () => Promise.resolve());
        return { value: 'done' };
      },
    });
    expect(order).toEqual(['rows before change: 1']);
    expect(run.kind).toBe('done');
    expect(log.rows.map((r) => r.phase)).toEqual(['intent', 'result']);
    expect(log.rows[1]).toMatchObject({ outcome: 'ok', intentId: log.rows[0]!.id, calls: ['AdminDisableUser: ok'], after: { enabled: false } });
  });

  it('never starts the change when the intent cannot be written', async () => {
    const log = createMemoryAuditLog();
    log.failNextAppends(1);
    let ran = false;
    const run = await runAudited(log, {
      intent,
      run: () => {
        ran = true;
        return Promise.resolve({ value: 1 });
      },
    });
    expect(run.kind).toBe('not-started');
    expect(ran).toBe(false);
    expect(log.rows).toEqual([]);
  });

  it('logs a failure before any change as failed, and after a change as partial', async () => {
    const log = createMemoryAuditLog();
    const boom = Object.assign(new Error('nope'), { name: 'UserNotFoundException' });
    const first = await runAudited(log, { intent, run: (steps) => steps.call('AdminDisableUser', () => Promise.reject(boom)) });
    expect(first).toMatchObject({ kind: 'failed', changed: false });
    expect(log.rows[1]).toMatchObject({ outcome: 'failed', calls: ['AdminDisableUser: failed (UserNotFoundException)'], error: 'UserNotFoundException: nope' });

    const second = await runAudited(log, {
      intent,
      run: async (steps) => {
        await steps.call('AdminDisableUser', () => Promise.resolve());
        return steps.call('AdminRemoveUserFromGroup admin', () => Promise.reject(boom));
      },
    });
    expect(second).toMatchObject({ kind: 'failed', changed: true });
    expect(log.rows[3]).toMatchObject({ outcome: 'partial' });
  });

  it('a successful rollback means nothing changed', async () => {
    const log = createMemoryAuditLog();
    const run = await runAudited(log, {
      intent,
      run: async (steps) => {
        await steps.call('AdminCreateUser', () => Promise.resolve());
        try {
          await steps.call('AdminAddUserToGroup', () => Promise.reject(new Error('x')));
        } catch (error) {
          await steps.rollback('AdminDeleteUser', () => Promise.resolve());
          throw error;
        }
        return { value: 1 };
      },
    });
    expect(run).toMatchObject({ kind: 'failed', changed: false });
    expect(log.rows[1]).toMatchObject({
      outcome: 'failed',
      calls: ['AdminCreateUser: ok', 'AdminAddUserToGroup: failed (Error)', 'AdminDeleteUser (rollback): ok'],
    });
  });

  it('when the result row cannot be written, retries, then reports the change as unrecorded (never as not done)', async () => {
    const log = createMemoryAuditLog();
    const run = await runAudited(
      log,
      {
        intent,
        run: async (steps) => {
          await steps.call('AdminDisableUser', () => Promise.resolve());
          log.failNextAppends(3);
          return { value: 'done' };
        },
      },
      { sleep: noSleep },
    );
    expect(run.kind).toBe('done');
    expect(run.kind === 'done' && run.result).toBeUndefined();
    expect(log.rows.map((r) => r.phase)).toEqual(['intent']);
    const page = await log.listActivity();
    expect(page.entries[0]).toMatchObject({ status: 'unknown' });
  });

  it('a result write that landed but reported an error is recognized, not duplicated', async () => {
    const fake = fakeDynamo();
    const log = createDynamoAuditLog({ tableName: 't', client: fake.client, sleep: noSleep });
    const run = await runAudited(
      log,
      {
        intent,
        run: async (steps) => {
          await steps.call('AdminDisableUser', () => Promise.resolve());
          fake.landThenFail(Object.assign(new Error('socket hang up'), { name: 'TimeoutError' }));
          return { value: 'done' };
        },
      },
      { sleep: noSleep },
    );
    expect(run).toMatchObject({ kind: 'done', result: { phase: 'result', outcome: 'ok' } });
    expect(fake.items.filter((i) => i.phase?.S === 'result')).toHaveLength(1);
  });
});

describe('recordChange (for app content changes)', () => {
  it('returns the value, and throws the right error for each failure', async () => {
    const log = createMemoryAuditLog();
    const change = { intent: { actor, action: 'content.publish', target: { recordId: 'home' }, before: { v: 6 }, after: { v: 7 } } };
    await expect(recordChange(log, { ...change, run: (steps) => steps.call('db.publish', () => Promise.resolve({ value: 'v7' })) })).resolves.toBe('v7');

    log.failNextAppends(1);
    await expect(recordChange(log, { ...change, run: () => Promise.resolve({ value: 1 }) })).rejects.toBeInstanceOf(AuditUnavailableError);

    await expect(recordChange(log, { ...change, run: () => Promise.reject(new Error('db down')) })).rejects.toThrow('db down');
    expect(log.rows.at(-1)).toMatchObject({ phase: 'result', outcome: 'failed', error: 'Error: db down' });

    const incomplete = recordChange(log, {
      ...change,
      run: () => {
        log.failNextAppends(5);
        return Promise.resolve({ value: 'v8' });
      },
    });
    await expect(incomplete).rejects.toBeInstanceOf(AuditIncompleteError);
    await expect(incomplete).rejects.toMatchObject({ value: 'v8', outcome: 'ok' });
  });
});
