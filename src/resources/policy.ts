/**
 * Resource roles as pure rules (ADR 0022): each app's resource types, the combining rule (site role
 * as a floor on every item, plus the person's role on this one), the guardrails on access changes,
 * and the words screens use. No I/O and no server imports, so the server check, the actions, and
 * `auth-kit/resources/ui` all decide the same way.
 */
import {
  DEFAULT_RESOURCE_ROLE_ACTIONS,
  RESOURCE_ACTIONS,
  RESOURCE_POLICY,
  RESOURCE_ROLES,
  RESOURCE_ROLE_LABEL,
  RESOURCE_ROLE_RANK,
  RESOURCE_SITE_FLOOR,
  type ResourceRole,
  type RoleDescription,
  type StandardResourceAction,
  resourceRoleDescriptions,
} from '../shared/policy.js';

// ---- Names ------------------------------------------------------------------------------------

const TYPE_RE = /^[a-z][a-z0-9-]{0,39}$/;
// No `#` (the key separator), `/`, or spaces: an ID is safe in a key, a URL, and an audit row.
const ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/;
const SUB_RE = /^[A-Za-z0-9-]{1,128}$/;
const ACTION_RE = /^[a-z][a-z0-9-]{0,39}$/;

/** A resource type name: lowercase letters, digits, and hyphens (`project`, `grant-application`). */
export function isResourceType(value: unknown): value is string {
  return typeof value === 'string' && TYPE_RE.test(value);
}

/** An item ID: letters, digits, `_ . : -`, at most 128 characters. Anything else names no item. */
export function isResourceId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}

/** A Cognito `sub`. */
export function isPersonSub(value: unknown): value is string {
  return typeof value === 'string' && SUB_RE.test(value);
}

export function isResourceRole(value: unknown): value is ResourceRole {
  return typeof value === 'string' && (RESOURCE_ROLES as readonly string[]).includes(value);
}

function isStandardAction(value: string): value is StandardResourceAction {
  return (RESOURCE_ACTIONS as readonly string[]).includes(value);
}

/** How an item is named in the audit log's `target.recordId`: `project:abc`. */
export function resourceLabel(ref: { type: string; id: string }): string {
  return `${ref.type}:${ref.id}`;
}

// ---- Resource types ---------------------------------------------------------------------------

/** One resource type, as an app declares it. */
export interface ResourceTypeOptions {
  /** The word screens use: `project` gives "Who has access to this project". */
  noun: string;
  /** Default: the noun plus "s". */
  nounPlural?: string;
  /**
   * Each role's actions, replacing the defaults (`DEFAULT_RESOURCE_ROLE_ACTIONS`) for this type. Any
   * role left out keeps its default. Rules, checked at startup: every role can `view`; each role
   * holds everything the one below it holds; `manage-access` and `invite` are Manager-only, and
   * Managers always keep `manage-access`. Other names are this type's own actions (`comment`).
   */
  actions?: Partial<Record<ResourceRole, readonly string[]>>;
  /**
   * The site floor for this type's own actions: which standard action's floor each shares. Default
   * `edit` (admins who can edit every item can do it); `none` gives it to resource roles only.
   */
  customActionFloor?: Readonly<Record<string, StandardResourceAction | 'none'>>;
  /** Each role's can and can't, when the type's actions differ from the defaults. Default: `resourceRoleDescriptions(noun)`. */
  roleDescriptions?: Partial<Record<ResourceRole, RoleDescription>>;
  /** Members may create items of this type and become their Manager. Default false: admins create them and assign a Manager. */
  selfServiceCreate?: boolean;
  /** Every signed-in person may see (list and open) every item of this type, read-only. Default false: members see only their own. */
  sharedDirectory?: boolean;
}

/** One resource type, checked and complete. */
export interface ResourceTypeConfig {
  readonly type: string;
  readonly noun: string;
  readonly nounPlural: string;
  /** Each role's actions. */
  readonly actions: Readonly<Record<ResourceRole, readonly string[]>>;
  /** Every action this type knows: the standard four, then its own. */
  readonly allActions: readonly string[];
  /** The capability that grants each action on every item (the site floor), or null for none. */
  readonly floor: Readonly<Record<string, string | null>>;
  readonly roleDescriptions: Readonly<Record<ResourceRole, RoleDescription>>;
  readonly selfServiceCreate: boolean;
  readonly sharedDirectory: boolean;
}

const BRAND = Symbol.for('auth-kit.resource-types.v1');

/** An app's resource types, from `defineResourceTypes`. */
export interface ResourceTypes {
  /** Type names, in the order given. */
  readonly names: readonly string[];
  has(type: string): boolean;
  /** The type's config. Throws for a type the app didn't declare (a programming mistake, not a 404). */
  get(type: string): ResourceTypeConfig;
  readonly [BRAND]: true;
}

export function isResourceTypes(value: unknown): value is ResourceTypes {
  return typeof value === 'object' && value !== null && (value as { [BRAND]?: unknown })[BRAND] === true;
}

function checkType(type: string, options: ResourceTypeOptions): ResourceTypeConfig {
  const problems: string[] = [];
  const where = `resource type "${type}"`;
  if (!isResourceType(type)) problems.push(`${where}: the name must be lowercase letters, digits, and hyphens`);
  const noun = typeof options?.noun === 'string' ? options.noun.trim() : '';
  if (!noun || noun.length > 40 || /[<>\n]/.test(noun)) problems.push(`${where}: noun must be a short word, like "project"`);
  const nounPlural = (options?.nounPlural ?? `${noun}s`).trim();
  for (const key of Object.keys(options ?? {})) {
    if (!['noun', 'nounPlural', 'actions', 'customActionFloor', 'roleDescriptions', 'selfServiceCreate', 'sharedDirectory'].includes(key)) {
      problems.push(`${where}: unknown option "${key}"`);
    }
  }
  for (const key of ['selfServiceCreate', 'sharedDirectory'] as const) {
    if (options?.[key] !== undefined && typeof options[key] !== 'boolean') problems.push(`${where}: ${key} must be true or false`);
  }

  const actions = {} as Record<ResourceRole, readonly string[]>;
  for (const role of RESOURCE_ROLES) {
    const given = options?.actions?.[role];
    const list = given === undefined ? [...DEFAULT_RESOURCE_ROLE_ACTIONS[role]] : [...new Set(given)];
    for (const action of list) {
      if (typeof action !== 'string' || !ACTION_RE.test(action)) problems.push(`${where}: "${String(action)}" (${role}) isn't an action name`);
    }
    actions[role] = Object.freeze(list);
  }
  for (const key of Object.keys(options?.actions ?? {})) {
    if (!isResourceRole(key)) problems.push(`${where}: actions has unknown role "${key}"`);
  }
  for (const role of RESOURCE_ROLES) {
    if (!actions[role].includes('view')) problems.push(`${where}: ${RESOURCE_ROLE_LABEL[role]} must be able to view (nobody acts on what they can't see)`);
  }
  if (!actions.reader.every((a) => actions.contributor.includes(a))) problems.push(`${where}: Contributor must hold everything Reader holds`);
  if (!actions.contributor.every((a) => actions.manager.includes(a))) problems.push(`${where}: Manager must hold everything Contributor holds`);
  if (!actions.manager.includes('manage-access')) problems.push(`${where}: Manager must keep manage-access (every item keeps a Manager who can share it)`);
  for (const role of ['reader', 'contributor'] as const) {
    for (const only of ['manage-access', 'invite']) {
      if (actions[role].includes(only)) problems.push(`${where}: ${only} is for Managers only (${RESOURCE_ROLE_LABEL[role]} can't have it)`);
    }
  }

  const custom = [...new Set(RESOURCE_ROLES.flatMap((r) => actions[r]))].filter((a) => !isStandardAction(a));
  const floor: Record<string, string | null> = {};
  for (const action of RESOURCE_ACTIONS) floor[action] = RESOURCE_SITE_FLOOR[action];
  for (const [action, shares] of Object.entries(options?.customActionFloor ?? {})) {
    if (!custom.includes(action)) problems.push(`${where}: customActionFloor names "${action}", which no role has`);
    else if (shares !== 'none' && !isStandardAction(shares)) problems.push(`${where}: customActionFloor.${action} must be a standard action or "none"`);
  }
  for (const action of custom) {
    const shares = options?.customActionFloor?.[action] ?? 'edit';
    floor[action] = shares === 'none' ? null : (RESOURCE_SITE_FLOOR[shares] ?? null);
  }

  const defaults = resourceRoleDescriptions(noun || 'item');
  const roleDescriptions = {} as Record<ResourceRole, RoleDescription>;
  for (const role of RESOURCE_ROLES) {
    const given = options?.roleDescriptions?.[role];
    if (given !== undefined && (typeof given.can !== 'string' || typeof given.cannot !== 'string')) {
      problems.push(`${where}: roleDescriptions.${role} needs "can" and "cannot"`);
    }
    roleDescriptions[role] = Object.freeze({ ...defaults[role], ...given });
  }

  if (problems.length > 0) throw new Error(`auth-kit: defineResourceTypes:\n- ${problems.join('\n- ')}`);
  return Object.freeze({
    type,
    noun,
    nounPlural,
    actions: Object.freeze(actions),
    allActions: Object.freeze([...RESOURCE_ACTIONS, ...custom]),
    floor: Object.freeze(floor),
    roleDescriptions: Object.freeze(roleDescriptions),
    selfServiceCreate: options?.selfServiceCreate ?? RESOURCE_POLICY.selfServiceCreate,
    sharedDirectory: options?.sharedDirectory ?? RESOURCE_POLICY.sharedDirectory,
  });
}

/**
 * Declares the app's resource types, once, next to its capability map:
 *
 * ```ts
 * // lib/resources.ts
 * export const resourceTypes = defineResourceTypes({
 *   project: { noun: 'project' },                          // admins create; members see their own
 *   idea: { noun: 'idea', selfServiceCreate: true, sharedDirectory: true },
 * });
 * ```
 *
 * Throws at startup on a mistake (a role that can't view, a Contributor who can manage access).
 */
export function defineResourceTypes(map: Readonly<Record<string, ResourceTypeOptions>>): ResourceTypes {
  const names = Object.keys(map ?? {});
  if (names.length === 0) throw new Error('auth-kit: defineResourceTypes needs at least one resource type.');
  const configs = new Map(names.map((name) => [name, checkType(name, map[name]!)]));
  return Object.freeze({
    names: Object.freeze([...names]),
    has: (type: string) => configs.has(type),
    get(type: string): ResourceTypeConfig {
      const config = configs.get(type);
      if (!config) throw new Error(`auth-kit: resource type "${String(type)}" isn't declared (defineResourceTypes has ${names.join(', ')}).`);
      return config;
    },
    [BRAND]: true as const,
  });
}

// ---- The combining rule -----------------------------------------------------------------------

/**
 * What a check asks for: a minimum role (`'contributor'`: every action a Contributor has on this
 * type) or one action (`'edit'`, or the type's own, like `'comment'`).
 */
export type ResourceNeed = ResourceRole | StandardResourceAction | (string & Record<never, never>);

/** What one person may do on one item, and why. */
export interface ResourceDecision {
  /** Everything allowed: the union of the two below. */
  readonly actions: ReadonlySet<string>;
  /** What the site role alone grants on every item (or the shared directory's `view`). */
  readonly viaSite: ReadonlySet<string>;
  /** What their role on this item grants. */
  readonly viaRole: ReadonlySet<string>;
}

/**
 * The combining rule: an action is allowed when the site role grants it on every item (the floor:
 * `RESOURCE_SITE_FLOOR`, by capability) or the person's role on this item grants it. A type with
 * `sharedDirectory` adds `view` for everyone signed in.
 */
export function decideResourceAccess(
  config: ResourceTypeConfig,
  input: { capabilities: Iterable<string>; role: ResourceRole | null },
): ResourceDecision {
  const held = new Set(input.capabilities);
  const viaSite = new Set<string>();
  for (const action of config.allActions) {
    const capability = config.floor[action];
    if (capability && held.has(capability)) viaSite.add(action);
  }
  if (config.sharedDirectory) viaSite.add('view');
  const viaRole = new Set<string>(input.role ? config.actions[input.role] : []);
  return Object.freeze({ actions: new Set([...viaSite, ...viaRole]), viaSite, viaRole });
}

/**
 * The actions a check needs: a role means every action that role has on this type ("Contributor or
 * better"), so an admin whose floor covers them passes too. Throws for a name the type doesn't know.
 */
export function neededActions(config: ResourceTypeConfig, need: ResourceNeed): readonly string[] {
  if (isResourceRole(need)) return config.actions[need];
  if (typeof need === 'string' && config.allActions.includes(need)) return [need];
  throw new Error(`auth-kit: "${String(need)}" isn't a role or an action of resource type "${config.type}" (${config.allActions.join(', ')}).`);
}

/** The highest role whose actions are all covered, for "acts as" labels; null when not even Reader's. */
export function equivalentRole(config: ResourceTypeConfig, actions: ReadonlySet<string>): ResourceRole | null {
  for (const role of RESOURCE_ROLES) if (config.actions[role].every((a) => actions.has(a))) return role;
  return null;
}

/** Who may create an item of this type, and whom they may make its first Manager. */
export function createPermission(
  config: ResourceTypeConfig,
  capabilities: Iterable<string>,
): { allowed: true; manager: 'anyone' | 'self' } | { allowed: false; reason: string } {
  const held = new Set(capabilities);
  const capability = config.floor['manage-access'];
  if (capability && held.has(capability)) return { allowed: true, manager: 'anyone' };
  if (config.selfServiceCreate) return { allowed: true, manager: 'self' };
  return { allowed: false, reason: `Site admins create ${config.nounPlural} on this site and choose who manages each one.` };
}

/** Roles sorted highest first. */
export function compareResourceRoles(a: ResourceRole, b: ResourceRole): number {
  return RESOURCE_ROLE_RANK[b] - RESOURCE_ROLE_RANK[a];
}

// ---- Guardrails on access changes -------------------------------------------------------------

export type AccessChange = 'add' | 'changeRole' | 'remove' | 'invite';

export type AccessGuardCode =
  /** The person can't change who has access (or can't invite). */
  | 'not_allowed'
  /** The target has no role on this item. */
  | 'not_member'
  /** The target already has a role on this item. */
  | 'already_member'
  /** Nothing would change (the same role). */
  | 'state'
  /** It would leave the item without a Manager. */
  | 'last_manager'
  /** A replacement Manager was named where it can't be used. */
  | 'replacement_invalid';

export interface AccessGuardInput {
  change: AccessChange;
  /** Who's acting: their actions on this item, and which of them come from their site role. */
  actor: { sub: string; actions: Iterable<string>; siteActions: Iterable<string> };
  /** The person whose access changes, and their current role (null: none). Not used for `invite`. */
  target?: { sub: string; role: ResourceRole | null };
  /** The role given (`add`, `invite`, `changeRole`). */
  toRole?: ResourceRole;
  /** The item's Managers now. */
  managers: number;
  /**
   * A new Manager named in the same step, which lets a site admin who manages access remove or
   * demote the item's last Manager. Only for that case.
   */
  replacement?: { sub: string };
  /** The app's noun, for the messages. Default "item". */
  noun?: string;
}

export type AccessGuardResult = { ok: true } | { ok: false; code: AccessGuardCode; reason: string };

/**
 * The rules every access change follows, on the server and in the UI:
 * - adding, changing a role, and removing someone else need `manage-access` (Managers, and site
 *   admins whose role manages people); inviting someone new needs `invite`;
 * - anyone may leave an item they have a role on;
 * - every item keeps at least one Manager: removing or demoting the last one is refused, unless a
 *   site admin who manages access names the new Manager in the same step.
 */
export function checkAccessChange(input: AccessGuardInput): AccessGuardResult {
  const noun = input.noun ?? 'item';
  const actions = new Set(input.actor.actions);
  const site = new Set(input.actor.siteActions);
  const refuse = (code: AccessGuardCode, reason: string): AccessGuardResult => ({ ok: false, code, reason });
  const manageMessage = `Only this ${noun}’s Managers (and site admins who manage people) can change who has access to it.`;

  if (input.change === 'invite') {
    if (!actions.has('invite')) return refuse('not_allowed', `Only this ${noun}’s Managers (and site admins who manage people) can invite someone new to it.`);
    if (!isResourceRole(input.toRole)) return refuse('state', 'Choose Manager, Contributor, or Reader.');
    if (input.replacement !== undefined) return refuse('replacement_invalid', 'A new Manager is named only when removing the last one.');
    return { ok: true };
  }

  const target = input.target;
  if (!target) return refuse('not_member', 'Choose a person.');
  const self = target.sub === input.actor.sub;
  const leaving = input.change === 'remove' && self && target.role !== null;
  if (!leaving && !actions.has('manage-access')) return refuse('not_allowed', manageMessage);

  if (input.change === 'add') {
    if (target.role !== null) return refuse('already_member', `They already have access as ${RESOURCE_ROLE_LABEL[target.role]}. Change their role instead.`);
    if (!isResourceRole(input.toRole)) return refuse('state', 'Choose Manager, Contributor, or Reader.');
    if (input.replacement !== undefined) return refuse('replacement_invalid', 'A new Manager is named only when removing the last one.');
    return { ok: true };
  }

  if (target.role === null) return refuse('not_member', `They don’t have access to this ${noun}.`);
  if (input.change === 'changeRole') {
    if (!isResourceRole(input.toRole)) return refuse('state', 'Choose Manager, Contributor, or Reader.');
    if (input.toRole === target.role) return refuse('state', `That’s already their role (${RESOURCE_ROLE_LABEL[target.role]}).`);
  }

  const losesManager = target.role === 'manager' && (input.change === 'remove' || input.toRole !== 'manager');
  const lastManager = losesManager && input.managers <= RESOURCE_POLICY.minimumManagers;
  if (input.replacement !== undefined) {
    if (!lastManager) return refuse('replacement_invalid', 'A new Manager is named only when removing or changing the last one.');
    if (!site.has('manage-access')) {
      return refuse('last_manager', `Every ${noun} keeps at least one Manager. Make someone else a Manager first.`);
    }
    if (input.replacement.sub === target.sub) return refuse('replacement_invalid', 'Name someone else as the new Manager.');
    return { ok: true };
  }
  if (lastManager) {
    return refuse(
      'last_manager',
      site.has('manage-access')
        ? `Every ${noun} keeps at least one Manager. Make someone else a Manager first, or name the new Manager in the same step (site admins only).`
        : `Every ${noun} keeps at least one Manager. Make someone else a Manager first.`,
    );
  }
  return { ok: true };
}

// ---- Words ------------------------------------------------------------------------------------

/** What screens say about one item's access, in the app's own words. Screens never say "resource". */
export interface ResourceAccessCopy {
  /** "Who has access to this project" */
  heading: string;
  /** "Share this project" */
  share: string;
  /** "Site admins can also see and edit this project (view-only admins can only see it)." */
  adminNote: string;
  /** "Every project keeps at least one Manager. …" */
  lastManager: string;
  /** "This project has no Manager. …" */
  noManager: string;
  /** Under the invite form. */
  invite: string;
  /** When an address has no account. */
  noAccount: string;
  /** "Leave this project" */
  leave: string;
  /** "Projects you have a role on, and what each lets you do." */
  yours: string;
}

export function resourceAccessCopy(noun: string, nounPlural = `${noun}s`): ResourceAccessCopy {
  return {
    heading: `Who has access to this ${noun}`,
    share: `Share this ${noun}`,
    adminNote: `Site admins can also see and edit this ${noun} (view-only admins can only see it).`,
    lastManager: `Every ${noun} keeps at least one Manager. Make someone else a Manager first.`,
    noManager: `This ${noun} has no Manager. A site admin can make someone its Manager.`,
    invite: `They get an email inviting them to sign in. Their account can see this ${noun} with the role you choose, and nothing else on the site. The site’s admins are told about every invite.`,
    noAccount: `No account uses that address. Invite them to this ${noun} instead.`,
    leave: `Leave this ${noun}`,
    yours: `${nounPlural.charAt(0).toUpperCase()}${nounPlural.slice(1)} you have a role on, and what each lets you do.`,
  };
}

/** One choice in a resource role picker. */
export interface ResourceRoleOption extends RoleDescription {
  role: ResourceRole;
  label: string;
}

/** The picker's choices, highest first, with each role's can and can't for this type. */
export function resourceRoleOptions(config: Pick<ResourceTypeConfig, 'roleDescriptions'>): ResourceRoleOption[] {
  return RESOURCE_ROLES.map((role) => ({ role, label: RESOURCE_ROLE_LABEL[role], ...config.roleDescriptions[role] }));
}
