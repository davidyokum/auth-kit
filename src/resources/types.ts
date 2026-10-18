/**
 * Plain types shared by the store, the server check, the actions, and the UI. No runtime imports
 * beyond pure modules, so `auth-kit/resources/ui` can use it in the browser.
 */
import type { InviteMode } from '../admin/guardrails.js';
import type { ResourceRole } from '../shared/policy.js';
import type { ResourceRoleOption } from './policy.js';

/** One item: its resource type (`project`) and its ID within that type. */
export interface ResourceRef {
  type: string;
  id: string;
}

/** One person's role on one item. */
export interface ResourceMembership {
  type: string;
  id: string;
  /** The person's Cognito `sub`. Never an email: emails change. */
  sub: string;
  role: ResourceRole;
  /** For display only, as of the last change to this membership. Never used to decide access. */
  email?: string;
  /** For display only, as of the last change to this membership. */
  name?: string;
  /** Who gave this access (`sub`), and their email for display. */
  addedBy: string;
  addedByEmail?: string;
  /** ISO 8601. */
  addedAt: string;
  /** ISO 8601: the last role change, if any. */
  updatedAt?: string;
  updatedBy?: string;
}

/** The item's access record: the lock every change checks, and a few facts about it. */
export interface ResourceMeta {
  type: string;
  id: string;
  /** Bumped by every change to this item's access; a change made against an older version is refused. */
  version: number;
  /** How many Managers the item has. */
  managers: number;
  /** ISO 8601. */
  createdAt: string;
  createdBy: string;
  /** ISO 8601. */
  updatedAt: string;
  updatedBy: string;
}

/** Everything about one item's access, read together (one consistent Query). */
export interface ResourceAccessRecord {
  /** Null when the item has no access record (never created through auth-kit, or deleted). */
  meta: ResourceMeta | null;
  members: ResourceMembership[];
}

/** One atomic change to one item's access. */
export interface ResourceCommit {
  /** The version read with `getAccess` (null when there was no access record). If it changed since, nothing is written. */
  expectedVersion: number | null;
  /** The access record to write (its version is `expectedVersion + 1`), or null to delete it. */
  meta: ResourceMeta | null;
  /** Memberships to write (added or changed). */
  put?: readonly ResourceMembership[];
  /** `sub`s whose memberships to delete. */
  delete?: readonly string[];
}

/** A person's memberships, honest about where the list stopped. */
export interface PersonMemberships {
  memberships: ResourceMembership[];
  /** True when the list stopped at `RESOURCE_POLICY.maxResourcesPerPerson`. */
  truncated: boolean;
}

/**
 * Where memberships live. `createDynamoResourceStore` (the table from `ResourceAccessTable`) and
 * `createMemoryResourceStore` (tests, the auth matrix) implement it; an app may implement it over its
 * own database, keeping the same rule: every change goes through `commit`, which applies only if the
 * item's version is still the one read.
 */
export interface ResourceAccessStore {
  /** One person's membership on one item (a consistent read), or null. */
  getMembership(ref: ResourceRef, sub: string): Promise<ResourceMembership | null>;
  /** The item's access record and all its members (a consistent read). */
  getAccess(ref: ResourceRef): Promise<ResourceAccessRecord>;
  /** A person's memberships, optionally of one type. */
  listForPerson(sub: string, type?: string): Promise<PersonMemberships>;
  /**
   * Applies one change atomically. Throws `ResourceConflictError` (matched by `name`, so it works
   * across bundles) when the item's version isn't `expectedVersion`: someone changed its access
   * since it was read. At most `RESOURCE_COMMIT_MAX_ITEMS` memberships per commit.
   */
  commit(ref: ResourceRef, change: ResourceCommit): Promise<void>;
}

/** DynamoDB transactions hold 100 items; one is the access record. */
export const RESOURCE_COMMIT_MAX_ITEMS = 99;

/** Form field names, shared by `auth-kit/resources/ui` and the FormData adapters. */
export const RESOURCE_FORM_FIELDS = {
  type: 'resourceType',
  id: 'resourceId',
  sub: 'sub',
  email: 'email',
  name: 'name',
  role: 'role',
  toRole: 'toRole',
  fromRole: 'fromRole',
  replaceWithEmail: 'replaceWithEmail',
  confirmOutsideDomain: 'confirmOutsideDomain',
} as const;

/** One person on an item's access list. */
export interface ResourceMemberRow {
  sub: string;
  email?: string;
  name?: string;
  role: ResourceRole;
  label: string;
  /** ISO 8601. */
  addedAt: string;
  addedByEmail?: string;
}

/** An item's access list, honest about failure: "unavailable" says why, never an empty list. */
export type ResourceAccessList =
  | {
      state: 'ok';
      type: string;
      id: string;
      noun: string;
      /** Managers first, then Contributors, then Readers; by email within each. */
      members: ResourceMemberRow[];
      managers: number;
      /** Who's looking: their role here, everything they may do, and what their site role alone grants. */
      viewer: { sub: string; role: ResourceRole | null; actions: string[]; siteActions: string[] };
      /** The role picker's choices, with each role's can and can't for this type. */
      roles: ResourceRoleOption[];
      /** The viewer may invite someone new here, and invites are set up on this site. */
      canInvite: boolean;
      inviteMode: InviteMode;
      /** ISO 8601: when the list was read. */
      fetchedAt: string;
    }
  | { state: 'not_found' }
  | { state: 'unavailable'; reason: string };

