/**
 * The standard's concrete settings, in one place.
 *
 * Mirrors the `POLICY` object in the passwords-flow primer (primer-src/model.js) and the rules in
 * 03-gold-standard-and-plan.md §2. Every other module reads these values; nothing hard-codes them.
 */

// ---- Site-wide roles (ADR 0020) -----------------------------------------------------------------
//
// One owner, an explicit admin ladder, and members. These roles are for running the site. Access to
// one project, plan, or other item is a resource role on that item (Manager, Contributor, Reader;
// built separately), which adds to the site role there. Each role includes everything below it.

/** The owner's group. Exactly one enabled person holds it; it moves only by "Transfer ownership". */
export const OWNER_GROUP = 'owner';

/** Site-wide admin roles, highest first. Group precedence follows this order (owner = 0). */
export const STANDARD_GROUPS = ['owner', 'superadmin', 'admin-content-people', 'admin-content', 'admin-view'] as const;
export type StandardGroup = (typeof STANDARD_GROUPS)[number];

/**
 * Group names retired with the site-wide roles (ADR 0020), and the role each became. They're refused
 * as app roles and persona groups, so a migrating site can't keep one by accident as a role with no
 * rank. `superadmin` kept its name but not its meaning: it was the owner; now it's the role below
 * the one owner (pick one person to move to `owner`).
 */
export const RETIRED_GROUPS: Readonly<Record<string, StandardGroup>> = Object.freeze({
  admin: 'admin-content-people',
  editor: 'admin-content',
  viewer: 'admin-view',
});

/** "No admin role" in role pickers and role changes. Not a Cognito group: a member holds none. */
export const MEMBER_ROLE = 'member' as const;
/** A site-wide role: an admin role, or `member` for none. */
export type SiteRole = StandardGroup | typeof MEMBER_ROLE;

/**
 * Rank of each admin role. People grant, and act on, only roles below their own, so only the owner
 * grants Super admin and nobody manages someone at their own level; nobody changes their own role;
 * and the owner role is never granted (it moves only by "Transfer ownership"). App roles (member
 * roles such as `reviewer`) have no rank: they say who someone is in the app, not who runs the site.
 */
export const ADMIN_ROLE_RANK: Readonly<Record<StandardGroup, number>> = {
  'admin-view': 1,
  'admin-content': 2,
  'admin-content-people': 3,
  superadmin: 4,
  owner: 5,
};

/** Display names, exactly as screens show them (with an en dash). */
export const ADMIN_ROLE_LABEL: Readonly<Record<StandardGroup, string>> = {
  owner: 'Owner',
  superadmin: 'Super admin',
  'admin-content-people': 'Admin – content & people',
  'admin-content': 'Admin – content only',
  'admin-view': 'Admin – view only',
};

/** The display name for `member` (no admin role). */
export const MEMBER_LABEL = 'Member';

/** What a role can and can't do, one line each, for role pickers. */
export interface RoleDescription {
  can: string;
  cannot: string;
}

export const ROLE_DESCRIPTIONS: Readonly<Record<SiteRole, RoleDescription>> = {
  owner: {
    can: 'Everything, plus owner-only pages, granting Super admin, and transferring ownership.',
    cannot: 'Be granted, demoted, disabled, or deleted: ownership moves only by Transfer ownership.',
  },
  superadmin: {
    can: 'Everything except owner-only: security settings, exports, deletion, people and roles below Super admin, the audit log, all content.',
    cannot: 'Open owner-only pages, grant Super admin, manage other Super admins, or transfer ownership.',
  },
  'admin-content-people': {
    can: 'Read, edit, and publish any content; invite and manage people and roles below their own; read the audit log.',
    cannot: 'Change security settings, export or delete data, or manage anyone at their level or above.',
  },
  'admin-content': {
    can: 'Read, edit, and publish any content, site-wide; see the admin area and the audit log.',
    cannot: 'Invite or manage people, change roles or settings, or export or delete data.',
  },
  'admin-view': {
    can: 'See everything in the admin area and all content, including the audit log.',
    cannot: 'Change anything.',
  },
  member: {
    can: 'Use the site: their own account, and the items they’ve been given access to.',
    cannot: 'Open the admin area. Access to a project, plan, or other item is given on that item, not by a role.',
  },
};

const ADMIN_VIEW_CAPABILITIES = ['content.read', 'people.read', 'audit.read'] as const;
const ADMIN_CONTENT_CAPABILITIES = [...ADMIN_VIEW_CAPABILITIES, 'content.edit', 'content.publish'] as const;
const ADMIN_CONTENT_PEOPLE_CAPABILITIES = [...ADMIN_CONTENT_CAPABILITIES, 'people.manage', 'roles.manage'] as const;
const SUPERADMIN_CAPABILITIES = [...ADMIN_CONTENT_PEOPLE_CAPABILITIES, 'settings.security', 'data.export', 'data.delete'] as const;
const OWNER_CAPABILITIES = [...SUPERADMIN_CAPABILITIES, 'owner.private', 'owner.transfer'] as const;

/**
 * The standard capability map. Apps copy it into their one capabilities file and add their own.
 * Each role holds everything below it:
 * - `admin-view`: `content.read`, `people.read`, `audit.read` (see everything, change nothing);
 * - `admin-content`: adds `content.edit` and `content.publish` (any content, site-wide);
 * - `admin-content-people`: adds `people.manage` and `roles.manage` (roles below their own);
 * - `superadmin`: adds `settings.security`, `data.export`, and `data.delete`;
 * - `owner`: adds `owner.private` (owner-only pages) and `owner.transfer` (Transfer ownership).
 */
export const STANDARD_CAPABILITIES = {
  owner: OWNER_CAPABILITIES,
  superadmin: SUPERADMIN_CAPABILITIES,
  'admin-content-people': ADMIN_CONTENT_PEOPLE_CAPABILITIES,
  'admin-content': ADMIN_CONTENT_CAPABILITIES,
  'admin-view': ADMIN_VIEW_CAPABILITIES,
} as const satisfies Record<StandardGroup, readonly string[]>;

/** The role comparison's columns, in order. */
export const ROLE_MATRIX_COLUMNS = [
  'View everything',
  'Edit any content',
  'Manage people',
  'Security, exports, deletion',
  'Owner-only pages',
] as const;
export type RoleMatrixColumn = (typeof ROLE_MATRIX_COLUMNS)[number];

/** One cell: whether the role has it, and a qualifier where "yes" or "no" alone would mislead. */
export interface RoleMatrixCell {
  allowed: boolean;
  note?: string;
}

export interface RoleMatrixRow extends RoleDescription {
  role: SiteRole;
  label: string;
  cells: Readonly<Record<RoleMatrixColumn, RoleMatrixCell>>;
}

/** The capabilities each column stands for: a role has the column when it holds all of them. */
export const ROLE_MATRIX_CAPABILITIES: Readonly<Record<RoleMatrixColumn, readonly string[]>> = {
  'View everything': ['content.read', 'people.read', 'audit.read'],
  'Edit any content': ['content.edit', 'content.publish'],
  'Manage people': ['people.manage', 'roles.manage'],
  'Security, exports, deletion': ['settings.security', 'data.export', 'data.delete'],
  'Owner-only pages': ['owner.private'],
};

const ROLE_MATRIX_NOTES: Readonly<Partial<Record<SiteRole, Partial<Record<RoleMatrixColumn, string>>>>> = {
  owner: { 'Manage people': 'Everyone but themselves, including Super admins' },
  superadmin: { 'Manage people': 'Roles below Super admin' },
  'admin-content-people': { 'Manage people': 'Roles below their own' },
  member: {
    'View everything': 'Their own account and items',
    'Edit any content': 'Only items they’ve been given access to',
  },
};

function roleMatrixRow(role: SiteRole): RoleMatrixRow {
  const held = new Set<string>(role === MEMBER_ROLE ? [] : STANDARD_CAPABILITIES[role]);
  const notes = ROLE_MATRIX_NOTES[role] ?? {};
  const cells = {} as Record<RoleMatrixColumn, RoleMatrixCell>;
  for (const column of ROLE_MATRIX_COLUMNS) {
    const note = notes[column];
    cells[column] = Object.freeze({
      allowed: ROLE_MATRIX_CAPABILITIES[column].every((c) => held.has(c)),
      ...(note !== undefined && { note }),
    });
  }
  return Object.freeze({
    role,
    label: role === MEMBER_ROLE ? MEMBER_LABEL : ADMIN_ROLE_LABEL[role],
    ...ROLE_DESCRIPTIONS[role],
    cells: Object.freeze(cells),
  });
}

/**
 * The role comparison for UIs ("Compare roles"): one row per role, highest first, then Member; one
 * column per kind of power. Built from `STANDARD_CAPABILITIES`, so it can't drift from what the
 * server enforces.
 */
export const ROLE_MATRIX: Readonly<{ columns: typeof ROLE_MATRIX_COLUMNS; rows: readonly RoleMatrixRow[] }> = Object.freeze({
  columns: ROLE_MATRIX_COLUMNS,
  rows: Object.freeze(([...STANDARD_GROUPS, MEMBER_ROLE] as SiteRole[]).map(roleMatrixRow)),
});

export type AuthTier = 2 | 3;

/** Token and session lifetimes. */
export const SESSION_POLICY = {
  /** Access and ID tokens. */
  accessTokenMinutes: 60,
  idTokenMinutes: 60,
  /** Refresh token ceiling per tier: 30 days on Tier 2, 1 day on Tier 3. */
  refreshTokenMinutesMax: { 2: 30 * 24 * 60, 3: 24 * 60 } as Readonly<Record<AuthTier, number>>,
  /** Cognito's floor for refresh tokens. */
  refreshTokenMinutesMin: 60,
  /** The sign-in session, which is also an emailed code's lifetime. */
  authSessionMinutes: 3,
  /** Step-up: a risky action needs a sign-in at most this old. */
  stepUpMaxAgeSeconds: 5 * 60,
  /** Admin routes re-read the acting person's status and groups at most this often. */
  liveCheckTtlSeconds: 60,
} as const;

/** Passwords are for password managers: long, no composition rules (NIST SP 800-63B-4). */
export const PASSWORD_POLICY = {
  minimumLength: 15,
  requireLowercase: false,
  requireUppercase: false,
  requireNumbers: false,
  requireSymbols: false,
  /** Temporary passwords exist only for the admin-pool bootstrap; they expire with an unused invite. */
  temporaryPasswordValidityDays: 7,
} as const;

/** An invite with no sign-in after this many days is disabled. */
export const INVITE_EXPIRY_DAYS = 7;

/** WAF rate limits (requests per IP per evaluation window). */
export const WAF_POLICY = {
  evaluationWindowSec: 300,
  /** InitiateAuth + RespondToAuthChallenge: sign-in attempts and code guesses. */
  signInLimit: 100,
  /** Every request WAF inspects for the pool, including token-authorized calls. */
  overallLimit: 1000,
  /**
   * The sign-in rule starts in count mode: its header match was verified live on 2026-10-17, but
   * which operations token refreshes arrive as (and so how close real sessions come to the limit)
   * is read from a week of its counts before it blocks (ADR 0017).
   */
  signInRule: 'count',
  /** The overall rule needs no header match, so it blocks from day one: the pool always has a limit. */
  overallRule: 'block',
} as const;

/** Local development (primer Chapter 8). */
export const DEV_POLICY = {
  /** The "Sign in as…" route (`app/api/dev/sign-in/route.dev.ts`). */
  route: '/api/dev/sign-in',
  /** Persona addresses end in `.test`, a reserved TLD that never delivers mail. */
  personaEmailDomain: 'personas.test',
  /** Personas: one per admin role (one owner) plus a member with no group. */
  personaRoles: [...STANDARD_GROUPS, MEMBER_ROLE] as const,
  sandboxTag: { key: 'Environment', value: 'sandbox' },
} as const;

/** The Amplify CDK context key that says which kind of deployment is being synthesized. */
export const AMPLIFY_DEPLOYMENT_TYPE_CONTEXT_KEY = 'amplify-backend-type';
export type AmplifyDeploymentType = 'branch' | 'sandbox' | 'standalone';
