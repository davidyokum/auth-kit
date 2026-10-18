/**
 * The standard's concrete settings, in one place.
 *
 * Mirrors the `POLICY` object in the passwords-flow primer (primer-src/model.js) and the rules in
 * 03-gold-standard-and-plan.md §2. Every other module reads these values; nothing hard-codes them.
 */

/** Admin roles, highest first. Group precedence follows this order (superadmin = 0). */
export const STANDARD_GROUPS = ['superadmin', 'admin', 'editor', 'viewer'] as const;
export type StandardGroup = (typeof STANDARD_GROUPS)[number];

/**
 * Rank of each admin role. People grant only roles below their own (owners may make owners), and
 * nobody changes their own role. App roles (member roles such as `reviewer`) have no rank: they
 * say who someone is in the app, not who can change the site.
 */
export const ADMIN_ROLE_RANK: Readonly<Record<StandardGroup, number>> = {
  viewer: 1,
  editor: 2,
  admin: 3,
  superadmin: 4,
};

/**
 * The group whose enabled members are the site's owners ("Owner" on screens). Each site keeps at
 * least one: the invite-expiry sweep never disables the last enabled holder of this group. Read the
 * owner role from here, not from a literal, so changing which group it is changes it everywhere.
 */
export const OWNER_GROUP = 'superadmin';

/** Display names. `superadmin` is called "Owner" on screens. */
export const ADMIN_ROLE_LABEL: Readonly<Record<StandardGroup, string>> = {
  viewer: 'Viewer',
  editor: 'Editor',
  admin: 'Admin',
  superadmin: 'Owner',
};

/**
 * The standard capability map. Apps copy it into their one capabilities file and add their own.
 * Content and people are separate keys: editors hold content capabilities only, admins add People,
 * and owners alone hold security settings, exports, and deletion.
 */
export const STANDARD_CAPABILITIES = {
  superadmin: [
    'content.read',
    'content.edit',
    'content.publish',
    'people.manage',
    'roles.manage',
    'audit.read',
    'data.export',
    'settings.security',
    'data.delete',
  ],
  admin: ['content.read', 'content.edit', 'content.publish', 'people.manage', 'roles.manage', 'audit.read'],
  editor: ['content.read', 'content.edit', 'content.publish'],
  viewer: ['content.read'],
} as const satisfies Record<StandardGroup, readonly string[]>;

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
  /** Personas: one per admin role plus a member with no group. */
  personaRoles: [...STANDARD_GROUPS, 'member'] as const,
  sandboxTag: { key: 'Environment', value: 'sandbox' },
} as const;

/** The Amplify CDK context key that says which kind of deployment is being synthesized. */
export const AMPLIFY_DEPLOYMENT_TYPE_CONTEXT_KEY = 'amplify-backend-type';
export type AmplifyDeploymentType = 'branch' | 'sandbox' | 'standalone';
