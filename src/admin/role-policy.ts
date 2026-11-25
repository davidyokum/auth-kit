/**
 * Guarded Staged Role Builder & Policy Store (ADR 0031).
 *
 * Keeps the site's governance core (`owner` and `superadmin`) and every administration capability
 * strictly code-locked, while letting sites expose editable operational tab/action capabilities
 * and site-specific custom roles stored in `SiteSettingsTable` (`admin-role-policy`) and enforced
 * live on the server.
 */
import { SITE_SETTING } from '../accounts/schema.js';
import type { SiteSettingsStore } from '../accounts/stores.js';
import { ACCOUNT_AUDIT_ACTIONS } from './audit-actions.js';
import { recordChange, type AuditLogStore } from './audit.js';
import { MEMBER_ROLE, OWNER_GROUP, RETIRED_GROUPS, STANDARD_GROUPS } from '../shared/policy.js';

/** Universal governance roles that stay permanently code-locked (never editable in the UI). */
export const CORE_GOVERNANCE_ROLES = ['owner', 'superadmin'] as const;

/** Optional legacy project-portal admin tiers kept for backward compatibility (ADR 0020). */
export const LEGACY_ADMIN_ROLES = ['admin-content-people', 'admin-content', 'admin-view'] as const;

/** Valid custom role ID format: lowercase slug starting with a letter, 2–32 characters. */
export const ROLE_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

/** Maximum custom roles stored in a single site policy document. */
export const MAX_CUSTOM_ROLES = 20;

export type RoleCapabilityGroup = 'tabs' | 'actions' | 'admin';

export interface RoleCapabilityDef {
  readonly id: string;
  readonly label: string;
  readonly group: RoleCapabilityGroup;
  /** True for administration capabilities or governance controls that can never be toggled in UI. */
  readonly locked: boolean;
  /** Plain-language explanation of what this permission allows. */
  readonly plainDescription: string;
  /** Technical enforcement summary (routes, guards, or Cognito groups). */
  readonly technicalNote: string;
}

export type RolePolicyKind = 'governance' | 'legacy' | 'baseline' | 'app' | 'custom';

export interface RolePolicyDefinition {
  readonly id: string;
  readonly label: string;
  readonly summary: string;
  readonly kind: RolePolicyKind;
  /** Governance and legacy admin roles remain code-locked; operational and custom roles are editable. */
  readonly locked: boolean;
  readonly defaultCapabilities: readonly string[];
}

export interface CustomRoleDefinition {
  readonly id: string;
  readonly label: string;
  readonly summary: string;
  readonly capabilities: readonly string[];
  readonly createdAt: string;
  readonly createdBy?: string;
}

export interface StoredRolePolicy {
  readonly overrides: Readonly<Record<string, readonly string[]>>;
  readonly customRoles: readonly CustomRoleDefinition[];
  readonly showLegacyAdminTiers?: boolean;
}

export interface RolePolicyCatalog {
  readonly capabilities: readonly RoleCapabilityDef[];
  readonly builtInRoles: readonly RolePolicyDefinition[];
  /** When true (default when the catalog defines `tabs`), every editable role must keep at least one visible tab. */
  readonly requireAtLeastOneTab?: boolean;
}

export interface RolePolicySnapshot {
  readonly policy: StoredRolePolicy;
  readonly version: number;
  readonly updatedAt: string | null;
  readonly updatedBy: { sub: string; email?: string } | null;
}

export interface RolePolicyValidationResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

export const EMPTY_STORED_ROLE_POLICY: StoredRolePolicy = Object.freeze({
  overrides: Object.freeze({}),
  customRoles: Object.freeze([]),
  showLegacyAdminTiers: false,
});

const RESERVED_SLUGS = new Set<string>([
  ...STANDARD_GROUPS,
  MEMBER_ROLE,
  ...Object.keys(RETIRED_GROUPS),
]);

function normalizeCapabilities(
  caps: readonly string[],
  knownEditable: ReadonlySet<string>,
): string[] {
  const unique = new Set<string>();
  for (const cap of caps) {
    if (knownEditable.has(cap)) unique.add(cap);
  }
  return [...unique].sort();
}

/**
 * Validates a staged Role Builder policy draft against every security and operational guardrail:
 * - Locked governance roles (`owner`, `superadmin`, or any `locked: true` built-in role) cannot be overridden.
 * - Locked capabilities (`locked: true` or `group === 'admin'`) can never be granted through overrides or custom roles.
 * - Every editable/custom role keeps at least one visible tab (`group === 'tabs'`) when tab capabilities exist.
 * - Custom role IDs must match `ROLE_SLUG_PATTERN`, must not collide with standard/retired/built-in roles, and cannot exceed `MAX_CUSTOM_ROLES`.
 * - Any custom role currently assigned to one or more accounts (`assignedCustomRoleIds`) cannot be deleted.
 */
export function validateRolePolicyDraft(
  catalog: RolePolicyCatalog,
  draft: StoredRolePolicy,
  options: { assignedCustomRoleIds?: ReadonlySet<string> } = {},
): RolePolicyValidationResult {
  const errors: string[] = [];
  const capById = new Map(catalog.capabilities.map((c) => [c.id, c]));
  const builtInById = new Map(catalog.builtInRoles.map((r) => [r.id, r]));
  const tabCapIds = new Set(catalog.capabilities.filter((c) => c.group === 'tabs').map((c) => c.id));
  const requireTab = catalog.requireAtLeastOneTab ?? tabCapIds.size > 0;

  for (const [roleId, caps] of Object.entries(draft.overrides ?? {})) {
    const builtIn = builtInById.get(roleId);
    if (!builtIn) {
      errors.push(`Unknown role override "${roleId}".`);
      continue;
    }
    if (builtIn.locked || (CORE_GOVERNANCE_ROLES as readonly string[]).includes(roleId)) {
      errors.push(`Role "${builtIn.label}" is code-locked and cannot be modified.`);
      continue;
    }
    const capList: readonly string[] = Array.isArray(caps) ? caps : [];
    for (const capId of capList) {
      const cap = capById.get(capId);
      if (!cap) {
        errors.push(`Unknown capability "${capId}" on role "${builtIn.label}".`);
      } else if (cap.locked || cap.group === 'admin') {
        errors.push(`Administration capability "${cap.label}" is code-locked and cannot be toggled on "${builtIn.label}".`);
      }
    }
    if (requireTab && !capList.some((c) => tabCapIds.has(c))) {
      errors.push(`Role "${builtIn.label}" must keep at least one visible tab.`);
    }
  }

  const customRoles: readonly CustomRoleDefinition[] = Array.isArray(draft.customRoles) ? draft.customRoles : [];
  if (customRoles.length > MAX_CUSTOM_ROLES) {
    errors.push(`At most ${MAX_CUSTOM_ROLES} custom roles may be defined.`);
  }

  const seenCustom = new Set<string>();
  for (const role of customRoles) {
    if (!ROLE_SLUG_PATTERN.test(role.id)) {
      errors.push(`Custom role ID "${role.id}" must be 2–32 lowercase letters, digits, or hyphens starting with a letter.`);
      continue;
    }
    if (RESERVED_SLUGS.has(role.id) || builtInById.has(role.id)) {
      errors.push(`Custom role ID "${role.id}" is reserved.`);
    }
    if (seenCustom.has(role.id)) {
      errors.push(`Duplicate custom role ID "${role.id}".`);
    }
    seenCustom.add(role.id);

    const label = typeof role.label === 'string' ? role.label.trim() : '';
    if (label.length < 2 || label.length > 48) {
      errors.push(`Custom role "${role.id}" needs a label between 2 and 48 characters.`);
    }

    const caps: readonly string[] = Array.isArray(role.capabilities) ? role.capabilities : [];
    for (const capId of caps) {
      const cap = capById.get(capId);
      if (!cap) {
        errors.push(`Unknown capability "${capId}" on custom role "${label || role.id}".`);
      } else if (cap.locked || cap.group === 'admin') {
        errors.push(`Administration capability "${cap.label}" is code-locked and cannot be assigned to custom role "${label || role.id}".`);
      }
    }
    if (requireTab && !caps.some((c) => tabCapIds.has(c))) {
      errors.push(`Custom role "${label || role.id}" must keep at least one visible tab.`);
    }
  }

  if (options.assignedCustomRoleIds) {
    for (const assignedId of options.assignedCustomRoleIds) {
      if (!seenCustom.has(assignedId)) {
        errors.push(`Cannot delete custom role "${assignedId}" while people are still assigned to it.`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Sanitizes a persisted JSON blob from `SiteSettingsTable` into a safe `StoredRolePolicy`,
 * dropping unknown or locked capabilities so a corrupted record can never escalate privileges.
 */
export function parseStoredRolePolicy(catalog: RolePolicyCatalog, raw: unknown): StoredRolePolicy {
  if (!raw || typeof raw !== 'object') return EMPTY_STORED_ROLE_POLICY;
  const obj = raw as Record<string, unknown>;
  const editableCaps = new Set(
    catalog.capabilities.filter((c) => !c.locked && c.group !== 'admin').map((c) => c.id),
  );
  const builtInById = new Map(catalog.builtInRoles.map((r) => [r.id, r]));

  const overrides: Record<string, readonly string[]> = {};
  if (obj.overrides && typeof obj.overrides === 'object') {
    for (const [roleId, list] of Object.entries(obj.overrides as Record<string, unknown>)) {
      const builtIn = builtInById.get(roleId);
      if (!builtIn || builtIn.locked || !Array.isArray(list)) continue;
      overrides[roleId] = normalizeCapabilities(
        list.filter((c): c is string => typeof c === 'string'),
        editableCaps,
      );
    }
  }

  const customRoles: CustomRoleDefinition[] = [];
  if (Array.isArray(obj.customRoles)) {
    const seen = new Set<string>();
    for (const entry of obj.customRoles) {
      if (!entry || typeof entry !== 'object') continue;
      const item = entry as Record<string, unknown>;
      const id = typeof item.id === 'string' ? item.id : '';
      const label = typeof item.label === 'string' ? item.label.trim() : '';
      const summary = typeof item.summary === 'string' ? item.summary.trim() : '';
      const createdAt = typeof item.createdAt === 'string' ? item.createdAt : '';
      const createdBy = typeof item.createdBy === 'string' ? item.createdBy : undefined;
      if (!ROLE_SLUG_PATTERN.test(id) || RESERVED_SLUGS.has(id) || builtInById.has(id) || seen.has(id) || !label) {
        continue;
      }
      seen.add(id);
      const rawCaps = Array.isArray(item.capabilities) ? item.capabilities.filter((c): c is string => typeof c === 'string') : [];
      customRoles.push({
        id,
        label,
        summary,
        capabilities: normalizeCapabilities(rawCaps, editableCaps),
        createdAt,
        ...(createdBy !== undefined && { createdBy }),
      });
    }
  }

  return {
    overrides,
    customRoles,
    showLegacyAdminTiers: obj.showLegacyAdminTiers === true,
  };
}

/**
 * Resolves the effective capability set for a user's live Cognito groups against the site's
 * catalog and active `StoredRolePolicy`. Locked governance/admin roles always evaluate strictly
 * from `builtInRoles.defaultCapabilities` (never overridden by DynamoDB state).
 */
export function resolveEffectiveRoleCapabilities(
  catalog: RolePolicyCatalog,
  policy: StoredRolePolicy,
  groups: readonly string[],
): ReadonlySet<string> {
  const result = new Set<string>();
  const builtInById = new Map(catalog.builtInRoles.map((r) => [r.id, r]));
  const customById = new Map(policy.customRoles.map((r) => [r.id, r]));
  const editableCaps = new Set(
    catalog.capabilities.filter((c) => !c.locked && c.group !== 'admin').map((c) => c.id),
  );

  // Determine active role IDs. Accounts holding no recognized Cognito group evaluate as `member`.
  const matchedRoles = groups.filter((g) => builtInById.has(g) || customById.has(g));
  const activeRoleIds = matchedRoles.length > 0 ? matchedRoles : [MEMBER_ROLE];

  for (const roleId of activeRoleIds) {
    const builtIn = builtInById.get(roleId);
    if (builtIn) {
      if (builtIn.locked || (CORE_GOVERNANCE_ROLES as readonly string[]).includes(roleId)) {
        for (const cap of builtIn.defaultCapabilities) result.add(cap);
      } else {
        const override = policy.overrides[roleId];
        const effective = override ?? builtIn.defaultCapabilities;
        for (const cap of effective) {
          if (editableCaps.has(cap) || builtIn.defaultCapabilities.includes(cap)) {
            result.add(cap);
          }
        }
      }
      continue;
    }

    const custom = customById.get(roleId);
    if (custom) {
      for (const cap of custom.capabilities) {
        if (editableCaps.has(cap)) result.add(cap);
      }
    }
  }

  // Always guarantee governance lock: owners and superadmins never lose locked capabilities.
  for (const govRole of CORE_GOVERNANCE_ROLES) {
    if (groups.includes(govRole)) {
      const def = builtInById.get(govRole);
      if (def) {
        for (const cap of def.defaultCapabilities) result.add(cap);
      }
    }
  }

  return result;
}

export interface SiteSettingsRolePolicyStore {
  get(): Promise<RolePolicySnapshot>;
  save(input: {
    draft: StoredRolePolicy;
    expectedVersion: number;
    reason: string;
    actor: { sub: string; email?: string };
    assignedCustomRoleIds?: ReadonlySet<string>;
    now?: Date;
  }): Promise<RolePolicySnapshot>;
}

/**
 * `SiteSettingsTable`-backed Role Builder policy store with optimistic locking and `recordChange`
 * audit logging (intent → put → result). Requires no additional DynamoDB tables.
 */
export function createSiteSettingsRolePolicyStore(options: {
  catalog: RolePolicyCatalog;
  settings: SiteSettingsStore;
  auditLog: AuditLogStore;
  settingName?: string;
}): SiteSettingsRolePolicyStore {
  const settingName = options.settingName ?? SITE_SETTING.rolePolicy;

  return {
    async get() {
      const row = await options.settings.get(settingName);
      if (!row) {
        return { policy: EMPTY_STORED_ROLE_POLICY, version: 0, updatedAt: null, updatedBy: null };
      }
      return {
        policy: parseStoredRolePolicy(options.catalog, row.value),
        version: row.version,
        updatedAt: row.updatedAt || null,
        updatedBy: row.updatedBy,
      };
    },

    async save(input) {
      const reason = input.reason.trim();
      if (reason.length < 3) {
        throw new Error('auth-kit: updating the role policy requires a short reason for the audit log.');
      }
      const validation = validateRolePolicyDraft(options.catalog, input.draft, {
        ...(input.assignedCustomRoleIds !== undefined && { assignedCustomRoleIds: input.assignedCustomRoleIds }),
      });
      if (!validation.ok) {
        throw new Error(`auth-kit: invalid role policy: ${validation.errors[0]}`);
      }

      const sanitized = parseStoredRolePolicy(options.catalog, input.draft);
      const before = await this.get();
      const now = input.now ?? new Date();

      const saved = await recordChange(options.auditLog, {
        intent: {
          actor: input.actor,
          action: ACCOUNT_AUDIT_ACTIONS.rolePolicy,
          target: { recordId: `setting:${settingName}` },
          before: { version: before.version, customRoleCount: before.policy.customRoles.length },
          after: {
            version: input.expectedVersion + 1,
            customRoleCount: sanitized.customRoles.length,
            overrideCount: Object.keys(sanitized.overrides).length,
          },
          reason,
        },
        run: async (steps) => {
          const row = await steps.call('SiteSettings.put', () =>
            options.settings.put(settingName, {
              value: sanitized,
              expectedVersion: input.expectedVersion,
              by: input.actor,
              now,
            }),
          );
          return { value: row };
        },
      });

      return {
        policy: parseStoredRolePolicy(options.catalog, saved.value),
        version: saved.version,
        updatedAt: saved.updatedAt || null,
        updatedBy: saved.updatedBy,
      };
    },
  };
}

/** True when a user holds any of the legacy project-portal admin tiers. */
export function hasLegacyAdminRole(groups: readonly string[]): boolean {
  return groups.some((g) => (LEGACY_ADMIN_ROLES as readonly string[]).includes(g));
}

/** True when a role ID is the site's Owner group. */
export function isOwnerRole(roleId: string): boolean {
  return roleId === OWNER_GROUP;
}
