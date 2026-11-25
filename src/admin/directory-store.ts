/**
 * Portable `SiteSettingsTable`-backed Admin Mode stores:
 * - Directory profiles (`firstName`, `lastName`, `title` per Cognito `sub`)
 * - Privacy-safe first-party usage ledger (`lastSeenAt` + 30-day rolling visits, throttled per account)
 * - Editable Invite email welcome note override
 *
 * All three live inside the existing `SiteSettingsTable` (`auth-kit/admin/cdk`), so sites gain
 * structured directory metadata, usage visibility, and welcome-note customization without adding
 * new DynamoDB tables or IAM permissions.
 */
import { SITE_SETTING } from '../accounts/schema.js';
import type { SiteSettingsStore } from '../accounts/stores.js';
import { ACCOUNT_AUDIT_ACTIONS } from './audit-actions.js';
import { recordChange, type AuditLogStore } from './audit.js';

// ---- Directory Profiles -------------------------------------------------------------------------

export interface DirectoryProfile {
  readonly firstName: string;
  readonly lastName: string;
  readonly title: string;
  readonly updatedAt?: string;
}

export type DirectoryProfileMap = Readonly<Record<string, DirectoryProfile>>;

const MAX_NAME_LEN = 80;
const MAX_TITLE_LEN = 120;

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function parseProfiles(raw: unknown): Record<string, DirectoryProfile> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, DirectoryProfile> = {};
  for (const [sub, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!sub || !value || typeof value !== 'object') continue;
    const item = value as Record<string, unknown>;
    const firstName = cleanText(item.firstName, MAX_NAME_LEN);
    const lastName = cleanText(item.lastName, MAX_NAME_LEN);
    const title = cleanText(item.title, MAX_TITLE_LEN);
    const updatedAt = typeof item.updatedAt === 'string' ? item.updatedAt : undefined;
    if (!firstName && !lastName && !title) continue;
    out[sub] = {
      firstName,
      lastName,
      title,
      ...(updatedAt !== undefined && { updatedAt }),
    };
  }
  return out;
}

export interface DirectoryProfileStore {
  getAll(): Promise<DirectoryProfileMap>;
  setProfile(input: {
    sub: string;
    email?: string;
    firstName: string;
    lastName: string;
    title: string;
    actor: { sub: string; email?: string };
    now?: Date;
  }): Promise<DirectoryProfile>;
}

export function createDirectoryProfileStore(options: {
  settings: SiteSettingsStore;
  auditLog: AuditLogStore;
  settingName?: string;
}): DirectoryProfileStore {
  const settingName = options.settingName ?? SITE_SETTING.peopleProfiles;

  return {
    async getAll() {
      const row = await options.settings.get(settingName);
      return row ? parseProfiles(row.value) : {};
    },

    async setProfile(input) {
      const sub = input.sub.trim();
      if (!sub) throw new Error('auth-kit: directory profile requires a target sub.');
      const now = input.now ?? new Date();
      const row = await options.settings.get(settingName);
      const current = row ? parseProfiles(row.value) : {};
      const before = current[sub] ?? { firstName: '', lastName: '', title: '' };
      const nextProfile: DirectoryProfile = {
        firstName: cleanText(input.firstName, MAX_NAME_LEN),
        lastName: cleanText(input.lastName, MAX_NAME_LEN),
        title: cleanText(input.title, MAX_TITLE_LEN),
        updatedAt: now.toISOString(),
      };
      const updatedMap: Record<string, DirectoryProfile> = { ...current };
      if (!nextProfile.firstName && !nextProfile.lastName && !nextProfile.title) {
        delete updatedMap[sub];
      } else {
        updatedMap[sub] = nextProfile;
      }

      await recordChange(options.auditLog, {
        intent: {
          actor: input.actor,
          action: ACCOUNT_AUDIT_ACTIONS.personProfile,
          target: { sub, ...(input.email !== undefined && { email: input.email }) },
          before: { firstName: before.firstName, lastName: before.lastName, title: before.title },
          after: { firstName: nextProfile.firstName, lastName: nextProfile.lastName, title: nextProfile.title },
        },
        run: async (steps) => {
          await steps.call('SiteSettings.put', () =>
            options.settings.put(settingName, {
              value: updatedMap,
              expectedVersion: row?.version ?? 0,
              by: input.actor,
              now,
            }),
          );
          return { value: nextProfile };
        },
      });

      return nextProfile;
    },
  };
}

// ---- First-Party Usage Ledger -------------------------------------------------------------------

export interface AccountUsageRecord {
  readonly sub: string;
  readonly email?: string;
  readonly lastSeenAt: string;
  readonly lastPath: string;
  readonly visits30d: number;
}

export interface UsageLedgerSnapshot {
  readonly accounts: Readonly<Record<string, AccountUsageRecord>>;
  readonly dailyCounts: Readonly<Record<string, number>>;
}

const USAGE_THROTTLE_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseUsageLedger(raw: unknown): { accounts: Record<string, AccountUsageRecord>; dailyCounts: Record<string, number> } {
  if (!raw || typeof raw !== 'object') return { accounts: {}, dailyCounts: {} };
  const obj = raw as Record<string, unknown>;
  const accounts: Record<string, AccountUsageRecord> = {};
  if (obj.accounts && typeof obj.accounts === 'object') {
    for (const [sub, entry] of Object.entries(obj.accounts as Record<string, unknown>)) {
      if (!sub || !entry || typeof entry !== 'object') continue;
      const item = entry as Record<string, unknown>;
      const lastSeenAt = typeof item.lastSeenAt === 'string' ? item.lastSeenAt : '';
      const lastPath = typeof item.lastPath === 'string' ? item.lastPath : '/';
      const visits30d = typeof item.visits30d === 'number' && Number.isFinite(item.visits30d) ? Math.max(0, Math.floor(item.visits30d)) : 0;
      const email = typeof item.email === 'string' ? item.email : undefined;
      if (!lastSeenAt) continue;
      accounts[sub] = {
        sub,
        ...(email !== undefined && { email }),
        lastSeenAt,
        lastPath,
        visits30d,
      };
    }
  }
  const dailyCounts: Record<string, number> = {};
  if (obj.dailyCounts && typeof obj.dailyCounts === 'object') {
    for (const [day, count] of Object.entries(obj.dailyCounts as Record<string, unknown>)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && typeof count === 'number' && Number.isFinite(count) && count >= 0) {
        dailyCounts[day] = Math.floor(count);
      }
    }
  }
  return { accounts, dailyCounts };
}

export interface UsageLedgerStore {
  get(): Promise<UsageLedgerSnapshot>;
  /** Records a signed-in visit, throttled to once per 5 minutes per account so writes stay tiny. */
  recordVisit(input: { sub: string; email?: string; path: string; now?: Date }): Promise<boolean>;
}

export function createUsageLedgerStore(options: {
  settings: SiteSettingsStore;
  settingName?: string;
  throttleMs?: number;
}): UsageLedgerStore {
  const settingName = options.settingName ?? SITE_SETTING.usageLedger;
  const throttleMs = options.throttleMs ?? USAGE_THROTTLE_MS;

  return {
    async get() {
      const row = await options.settings.get(settingName);
      return row ? parseUsageLedger(row.value) : { accounts: {}, dailyCounts: {} };
    },

    async recordVisit(input) {
      const sub = input.sub.trim();
      if (!sub) return false;
      const now = input.now ?? new Date();
      const nowMs = now.getTime();
      const row = await options.settings.get(settingName);
      const ledger = row ? parseUsageLedger(row.value) : { accounts: {}, dailyCounts: {} };
      const existing = ledger.accounts[sub];

      if (existing) {
        const lastMs = Date.parse(existing.lastSeenAt);
        if (Number.isFinite(lastMs) && nowMs - lastMs < throttleMs) {
          return false;
        }
      }

      const dayKey = now.toISOString().slice(0, 10);
      const cutoffDay = new Date(nowMs - 30 * DAY_MS).toISOString().slice(0, 10);
      const prunedDays: Record<string, number> = {};
      for (const [day, count] of Object.entries(ledger.dailyCounts)) {
        if (day >= cutoffDay) prunedDays[day] = count;
      }
      prunedDays[dayKey] = (prunedDays[dayKey] ?? 0) + 1;

      const safePath = input.path.startsWith('/') ? input.path.slice(0, 120) : '/';
      const nextAccounts: Record<string, AccountUsageRecord> = {
        ...ledger.accounts,
        [sub]: {
          sub,
          ...(input.email !== undefined && { email: input.email }),
          lastSeenAt: now.toISOString(),
          lastPath: safePath,
          visits30d: (existing?.visits30d ?? 0) + 1,
        },
      };

      try {
        await options.settings.put(settingName, {
          value: { accounts: nextAccounts, dailyCounts: prunedDays },
          expectedVersion: row?.version ?? 0,
          by: { sub, ...(input.email !== undefined && { email: input.email }) },
          now,
        });
        return true;
      } catch {
        // Optimistic lock race on concurrent requests: never fail a page render for telemetry.
        return false;
      }
    },
  };
}

// ---- Invite Welcome Note Override ---------------------------------------------------------------

export interface InviteWelcomeSnapshot {
  readonly note: string | null;
  readonly version: number;
  readonly updatedAt: string | null;
}

export interface InviteWelcomeStore {
  get(): Promise<InviteWelcomeSnapshot>;
  save(input: {
    note: string;
    expectedVersion: number;
    actor: { sub: string; email?: string };
    now?: Date;
  }): Promise<InviteWelcomeSnapshot>;
}

const MAX_WELCOME_NOTE_LEN = 600;

export function createInviteWelcomeStore(options: {
  settings: SiteSettingsStore;
  auditLog: AuditLogStore;
  settingName?: string;
}): InviteWelcomeStore {
  const settingName = options.settingName ?? SITE_SETTING.inviteWelcomeNote;

  return {
    async get() {
      const row = await options.settings.get(settingName);
      if (!row || typeof row.value !== 'string') {
        return { note: null, version: row?.version ?? 0, updatedAt: row?.updatedAt ?? null };
      }
      const trimmed = row.value.trim();
      return {
        note: trimmed.length > 0 ? trimmed : null,
        version: row.version,
        updatedAt: row.updatedAt || null,
      };
    },

    async save(input) {
      const trimmed = input.note.trim().slice(0, MAX_WELCOME_NOTE_LEN);
      const now = input.now ?? new Date();
      const before = await this.get();

      const saved = await recordChange(options.auditLog, {
        intent: {
          actor: input.actor,
          action: ACCOUNT_AUDIT_ACTIONS.inviteWelcomeNote,
          target: { recordId: `setting:${settingName}` },
          before: { hasCustomNote: before.note !== null },
          after: { hasCustomNote: trimmed.length > 0, length: trimmed.length },
        },
        run: async (steps) => {
          const row = await steps.call('SiteSettings.put', () =>
            options.settings.put(settingName, {
              value: trimmed,
              expectedVersion: input.expectedVersion,
              by: input.actor,
              now,
            }),
          );
          return { value: row };
        },
      });

      return {
        note: trimmed.length > 0 ? trimmed : null,
        version: saved.version,
        updatedAt: saved.updatedAt || null,
      };
    },
  };
}
