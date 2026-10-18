/**
 * Key layouts for the account-creation tables (ADR 0023) and the site settings table (ADR 0024),
 * shared by the stores and the CDK constructs (`auth-kit/admin/cdk`) so they can't drift. No
 * imports: safe anywhere, the Lambda bundles included.
 *
 * **Access requests** (`AccessRequestTable`): one partition, small by nature.
 *
 * | `pk` | `sk` | Holds |
 * |---|---|---|
 * | `requests` | `request#<id>` | `email`, `name`, `reason` (as typed), `status`, `createdAt`, `expiresAt`, `settledAt`, `settledBy`, and `ttl` |
 *
 * `<id>` starts with the creation time (zero-padded milliseconds), so the partition reads newest
 * first. `ttl` (epoch seconds) is when the whole item goes: 30 days after the request is settled,
 * by an admin or by expiring unanswered after 30 days (`ACCOUNT_CREATION_POLICY`). DynamoDB's TTL
 * deletes lazily, so readers ignore items past it and the daily digest deletes them outright.
 *
 * **Rate limits** (`RateLimitTable`): `pk` = `<route>#<sha256 of the address or IP>#<window start>`,
 * `hits` (a counter), `ttl`. Addresses and IPs are stored only as hashes.
 *
 * **Site settings** (`SiteSettingsTable`): `pk` = `setting`, `sk` = the setting's name, `value`
 * (JSON), `version` (the lock every change checks), `updatedAt`, `updatedBy`, `updatedByEmail`.
 */
export const ACCESS_REQUEST_TABLE_SCHEMA = {
  partitionKey: 'pk',
  sortKey: 'sk',
  partition: 'requests',
  requestPrefix: 'request#',
  ttlAttribute: 'ttl',
  formatVersion: 1,
} as const;

export const RATE_LIMIT_TABLE_SCHEMA = {
  partitionKey: 'pk',
  ttlAttribute: 'ttl',
} as const;

export const SITE_SETTINGS_TABLE_SCHEMA = {
  partitionKey: 'pk',
  sortKey: 'sk',
  partition: 'setting',
  formatVersion: 1,
} as const;

/** The site setting names auth-kit uses. */
export const SITE_SETTING = {
  /** The Super admin's override of the help address (`createSignInHelp`). */
  signInHelp: 'sign-in-help',
} as const;
