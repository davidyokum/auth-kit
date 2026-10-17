/**
 * The audit table's key layout, shared by the store (`createDynamoAuditLog`) and the CDK construct
 * (`auth-kit/admin/cdk`) so they can't drift. No imports: safe anywhere.
 *
 * | Attribute | Holds |
 * |---|---|
 * | `pk` | Always `LOG`. One partition: an admin area's log is small, and one key keeps "newest first" a single Query. |
 * | `sk` | `<startedAt>#<entryId>#<n>`: an intent (`n` = 0) and its result (`n` = 1) sort next to each other. |
 * | `actorKey` | `ACTOR#<sub>`, for the `byActor` index. |
 * | `targetKey` | `TARGET#<sub>`, `RECORD#<id>`, or `EMAIL#<address>`, for the `byTarget` index (sparse). |
 *
 * The result row's `sk` is derived from its intent, so it can be written only once: a retry after an
 * ambiguous failure meets the `attribute_not_exists(pk)` condition and is recognized as already done.
 */
export const AUDIT_TABLE_SCHEMA = {
  partitionKey: 'pk',
  sortKey: 'sk',
  partitionValue: 'LOG',
  indexes: {
    byActor: { name: 'byActor', partitionKey: 'actorKey' },
    byTarget: { name: 'byTarget', partitionKey: 'targetKey' },
  },
  /** Row format version, stored as `v`. */
  version: 1,
} as const;

export type AuditIndexName = (typeof AUDIT_TABLE_SCHEMA.indexes)[keyof typeof AUDIT_TABLE_SCHEMA.indexes]['name'];
