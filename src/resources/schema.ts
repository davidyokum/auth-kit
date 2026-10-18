/**
 * The resource access table's key layout, shared by the store (`createDynamoResourceStore`) and the
 * CDK construct (`ResourceAccessTable` in `auth-kit/admin/cdk`) so they can't drift. No imports:
 * safe anywhere.
 *
 * | Item | `pk` | `sk` | Holds |
 * |---|---|---|---|
 * | Access record | `resource#<type>#<id>` | `meta` | `version` (the lock every change checks), `managers` (how many), who created it and when |
 * | Membership | `resource#<type>#<id>` | `person#<sub>` | `role`, `personKey`, `addedBy`, `addedAt`, and an email and name for display |
 *
 * The `byPerson` index (partition `personKey` = `person#<sub>`, sort `pk`) answers "my items": one
 * Query, narrowed to one type with `begins_with(pk, "resource#<type>#")`. Only memberships carry
 * `personKey`, so the index holds no access records.
 *
 * Every change to one item's access is one transaction that writes the access record with the
 * version it read (`#v = :v`): two Managers editing at once can't leave an item without a Manager.
 */
export const RESOURCE_TABLE_SCHEMA = {
  partitionKey: 'pk',
  sortKey: 'sk',
  /** The access record's sort key. */
  metaSortKey: 'meta',
  resourcePrefix: 'resource#',
  personPrefix: 'person#',
  indexes: {
    byPerson: { name: 'byPerson', partitionKey: 'personKey', sortKey: 'pk' },
  },
  /** Item format version, stored as `fv`. */
  formatVersion: 1,
} as const;

/** `resource#<type>#<id>`. */
export function resourceKey(type: string, id: string): string {
  return `${RESOURCE_TABLE_SCHEMA.resourcePrefix}${type}#${id}`;
}

/** `person#<sub>`. */
export function personKey(sub: string): string {
  return `${RESOURCE_TABLE_SCHEMA.personPrefix}${sub}`;
}
