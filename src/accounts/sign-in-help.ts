/**
 * The sign-in help address (David, 2026-10-18; ADR 0024): one role-based help mailbox per family
 * (`theme.help.address`), a site's override in its config, and a Super admin's override in the app's
 * settings table (Settings → "Sign-in help"), changed without a deploy. The sign-in page, the help
 * screens, and the app's emails read the effective one on the server; the override falls back to
 * the configured address whenever it's missing, unreadable, or no longer a usable address.
 *
 * Changing it is a security setting (`settings.security`): it decides where people send "please
 * reset my authenticator" and "move my account to my new address". So it needs a recent sign-in and
 * a reason, it's audited (intent, the write, result), and the owner is alerted; with no alert
 * configured it's refused, and if the alert fails the change is undone.
 */
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { type Fail, InputError, authFailure, contextOf, defaultRequestContext, fail, record, text } from '../admin/action-kit.js';
import { type AuditLogStore, type AuditedRun, runAudited } from '../admin/audit.js';
import { ACCOUNT_AUDIT_ACTIONS } from '../admin/audit-actions.js';
import { describeAwsError } from '../admin/aws-errors.js';
import { CognitoAdmin } from '../admin/cognito-admin.js';
import type { OwnerAlertNotifier, SignInHelpChangedAlert } from '../admin/mailer.js';
import { ADMIN_POLICY } from '../admin/policy.js';
import { type QuotaLimiterOptions, createQuotaLimiter } from '../admin/quota.js';
import type { ActionResult, AuditActor, AuditRequestContext, FormAction } from '../admin/types.js';
import type { ServerAuth } from '../server/auth.js';
import { OWNER_GROUP } from '../shared/policy.js';

/** The Super admin group (the standard roles' second rank). */
const SUPERADMIN_GROUP = 'superadmin';
import { type AuthTheme, type HelpAddressSetting, type ThemeFamily, helpAddressProblems, helpSettingProblems, readHelpSetting, resolveTheme } from '../themes/index.js';
import { emailDomain, emailDomainAllowed } from '../shared/account-creation.js';
import { SITE_SETTING } from './schema.js';
import { SettingConflictError, type SiteSettingsStore, type StoredSetting } from './stores.js';

/** The help address in effect, and where it came from. */
export interface EffectiveSignInHelp {
  address: string;
  source: 'override' | 'config';
}

/** Anything that can say the help address in effect: a plain address, or `createSignInHelp`. */
export type SignInHelpSource = string | { effective(): Promise<EffectiveSignInHelp> };

/** The address in effect from either kind of source. */
export async function helpAddressOf(source: SignInHelpSource): Promise<string> {
  return typeof source === 'string' ? source : (await source.effective()).address;
}

/** What the Settings page shows: honest about a store it couldn't read. */
export type SignInHelpView =
  | {
      state: 'ok';
      configured: string;
      override: { address: string; personal?: true; updatedAt: string; updatedBy: { sub: string; email?: string }; reason?: string } | null;
      effective: EffectiveSignInHelp;
      /** Pass back with a change, so two Super admins can't overwrite each other unseen. */
      version: number;
    }
  | { state: 'unavailable'; configured: string; reason: string };

export interface SignInHelpOptions {
  /**
   * The configured help address: the family's mailbox, or the site's own in its config. Required. A
   * person's own address only with the site's acknowledgement: `{ address, personal: true }` (register E4c).
   */
  configured: HelpAddressSetting;
  /**
   * The site's family or theme: its email domains (`theme.help.domains`, subdomains included) are
   * where a Super admin may point the help address, besides the configured address's own domain.
   * Default personal (no family domains).
   */
  theme?: AuthTheme | ThemeFamily;
  /** More domains a Super admin may use (the escape hatch for a site whose help desk lives elsewhere). */
  allowedDomains?: readonly string[];
  /** Where a Super admin's override lives (`SiteSettingsTable`). Without it, the configured address is the only one. */
  store?: SiteSettingsStore;
  /** How long a read override is reused by this server. Default 60 seconds. */
  cacheSeconds?: number;
  now?: () => number;
  /** A store that couldn't be read (the configured address is used meanwhile). */
  onError?: (error: unknown) => void;
}

export interface SignInHelp {
  readonly configured: string;
  readonly store: SiteSettingsStore | null;
  /** Where an override may point: the configured address's domain, the family's, and `allowedDomains`. */
  readonly allowedDomains: readonly string[];
  /**
   * Why an address can't be the override (a malformed or placeholder address, a domain off the list, or
   * a person's own address without `personal: true`, the same rule as the configured one), or `[]`.
   */
  overrideProblems(address: string, options?: { personal?: boolean }): string[];
  /** For the sign-in page, the help screens, and emails: never throws, falls back to the configured address. */
  effective(): Promise<EffectiveSignInHelp>;
  /** For the Settings page: the override as stored (uncached), or why it couldn't be read. */
  view(): Promise<SignInHelpView>;
  /** Forgets the cached override (after a change). */
  invalidate(): void;
}

interface StoredHelp {
  address: string;
  /** The Super admin acknowledged a person's own address (register E4c). */
  personal?: true;
  reason?: string;
}

function storedHelp(setting: StoredSetting | null): StoredHelp | null {
  const value = setting?.value as Partial<StoredHelp> | undefined;
  if (!value || typeof value.address !== 'string') return null;
  return { address: value.address, ...(value.personal === true && { personal: true as const }), ...(typeof value.reason === 'string' && { reason: value.reason }) };
}

/**
 * The effective help address. The configured one must be a usable help address (it's checked here,
 * as the preset checks `email.replyTo`): a server that starts with a placeholder fails loudly.
 */
export function createSignInHelp(options: SignInHelpOptions): SignInHelp {
  const problems = helpSettingProblems(options.configured);
  if (problems.length > 0) throw new Error(`auth-kit: createSignInHelp: ${problems.join(' ')}`);
  const configured = readHelpSetting(options.configured).address;
  const allowedDomains = Object.freeze(
    [...new Set([emailDomain(configured), ...resolveTheme(options.theme).help.domains, ...(options.allowedDomains ?? [])].map((d) => d.trim().toLowerCase().replace(/^[@.]/, '')).filter((d) => d !== ''))],
  );
  // A Super admin's override (or a value someone wrote straight into the table) stays on these domains:
  // a hijacked session can't point every help screen and Reply-To at an outside mailbox.
  const overrideProblems = (address: string, check: { personal?: boolean } = {}): string[] => {
    const problems = helpAddressProblems(address, { personal: check.personal === true });
    if (problems.length > 0) return problems;
    return emailDomainAllowed(address.trim().toLowerCase(), allowedDomains)
      ? []
      : [`The help address must be on ${allowedDomains.join(', ')} (the configured address's domain or the site family's). A site whose help desk lives elsewhere adds the domain to allowedDomains in its config.`];
  };
  const now = options.now ?? Date.now;
  const ttl = (options.cacheSeconds ?? 60) * 1000;
  let cached: { value: EffectiveSignInHelp; until: number } | null = null;
  const fallback: EffectiveSignInHelp = { address: configured, source: 'config' };

  return {
    configured,
    store: options.store ?? null,
    allowedDomains,
    overrideProblems,
    async effective() {
      if (!options.store) return fallback;
      if (cached && cached.until > now()) return cached.value;
      let value = fallback;
      try {
        const help = storedHelp(await options.store.get(SITE_SETTING.signInHelp));
        if (help && overrideProblems(help.address, { personal: help.personal === true }).length === 0) value = { address: help.address, source: 'override' };
      } catch (error) {
        options.onError?.(error);
        // Not cached: the next request tries the store again.
        return fallback;
      }
      cached = { value, until: now() + ttl };
      return value;
    },
    async view() {
      if (!options.store) return { state: 'ok', configured, override: null, effective: fallback, version: 0 };
      try {
        const setting = await options.store.get(SITE_SETTING.signInHelp);
        const help = storedHelp(setting);
        const usable = help !== null && overrideProblems(help.address, { personal: help.personal === true }).length === 0;
        return {
          state: 'ok',
          configured,
          override: help && setting ? { address: help.address, ...(help.personal === true && { personal: true as const }), updatedAt: setting.updatedAt, updatedBy: setting.updatedBy, ...(help.reason !== undefined && { reason: help.reason }) } : null,
          effective: usable ? { address: help.address, source: 'override' } : fallback,
          version: setting?.version ?? 0,
        };
      } catch (error) {
        return { state: 'unavailable', configured, reason: `Couldn't read the help setting: ${describeAwsError(error)} The configured address (${configured}) is in effect.` };
      }
    },
    invalidate() {
      cached = null;
    },
  };
}

// ---- The Super admin's actions --------------------------------------------------------------------

export interface SignInHelpActionsConfig<G extends string = string, C extends string = string> {
  auth: ServerAuth<G, C>;
  auditLog: AuditLogStore;
  /** From `createSignInHelp`, with a `store`. */
  help: SignInHelp;
  siteName: string;
  /** Tells the owner (`signInHelpChanged`; the SES mailer implements it). Without it, changes are refused. */
  ownerAlerts?: Pick<OwnerAlertNotifier, 'signInHelpChanged'>;
  /** Inject a Cognito client (tests). Reads the owner to alert. */
  cognito?: CognitoIdentityProviderClient;
  quota?: QuotaLimiterOptions;
  requestContext?: () => Promise<AuditRequestContext>;
  now?: () => number;
  onError?: (error: unknown, context: string) => void;
}

export interface SignInHelpActions {
  /** The Settings page's view. Needs `settings.security`. */
  get(): Promise<SignInHelpView | { state: 'forbidden'; reason: string }>;
  /**
   * Overrides the help address. `settings.security`, a recent sign-in, and a reason. A person's own
   * address needs `personal: true` (the form's "This is a person's own address, on purpose" box;
   * register E4c), the same rule as the configured address.
   */
  set(input: { address: unknown; reason: unknown; version: unknown; personal?: unknown }): Promise<ActionResult>;
  /** Goes back to the configured address. The same checks. */
  clear(input: { reason: unknown; version: unknown }): Promise<ActionResult>;
  readonly forms: { set: FormAction; clear: FormAction };
}

const CAPABILITY = 'settings.security';

/** Settings → "Sign-in help": change the help address without a deploy, audited, the owner told. */
export function createSignInHelpActions<G extends string, C extends string>(config: SignInHelpActionsConfig<G, C>): SignInHelpActions {
  const { auth, auditLog, help } = config;
  if (!help.store) throw new Error('auth-kit: createSignInHelpActions needs createSignInHelp({ configured, store }) with a store.');
  const store = help.store;
  const now = config.now ?? Date.now;
  let client = config.cognito;
  let admin: CognitoAdmin | undefined;
  const cognito = () =>
    (admin ??= new CognitoAdmin((client ??= new CognitoIdentityProviderClient({ region: auth.pool.region, maxAttempts: 1 })), auth.pool.userPoolId, createQuotaLimiter(config.quota ?? {})));
  const report = (error: unknown, context: string) => {
    try {
      config.onError?.(error, context);
    } catch {
      // A broken error hook must not break an action.
    }
  };

  async function acting(): Promise<{ actor: AuditActor; request: AuditRequestContext } | Fail> {
    try {
      const user = await auth.requireCan(CAPABILITY as C, { live: true });
      auth.requireRecentSignIn(user);
      const request = await (config.requestContext ?? defaultRequestContext)().catch((): AuditRequestContext => ({}));
      return {
        actor: { sub: user.sub, ...(user.profile?.email !== undefined && { email: user.profile.email }) },
        request: { ...request, requestId: request.requestId ?? globalThis.crypto.randomUUID() },
      };
    } catch (error) {
      return authFailure(error) ?? fail('unavailable', describeAwsError(error));
    }
  }

  function parseVersion(value: unknown): number {
    const n = typeof value === 'number' ? value : typeof value === 'string' && value !== '' ? Number(value) : Number.NaN;
    if (!Number.isInteger(n) || n < 0) throw new InputError('Reload the page and try again.');
    return n;
  }

  async function change(input: unknown, mode: 'set' | 'clear'): Promise<ActionResult> {
    const who = await acting();
    if ('ok' in who) return who;
    let address: string | undefined, reason: string, version: number;
    let personal = false;
    try {
      const raw = record(input);
      reason = text(raw.reason, 'Reason', ADMIN_POLICY.reasonMaxLength) ?? '';
      if (reason.length < ADMIN_POLICY.reasonMinLength) throw new InputError('Give a reason (it goes in the audit log and the owner’s alert).');
      version = parseVersion(raw.version);
      if (mode === 'set') {
        address = (text(raw.address, 'Help address', 254) ?? '').toLowerCase();
        personal = raw.personal === true || raw.personal === 'true' || raw.personal === 'on';
        const problems = help.overrideProblems(address, { personal });
        if (problems.length > 0) throw new InputError(problems.join(' '));
      }
    } catch (error) {
      return fail('invalid', error instanceof InputError ? error.message : 'That request is invalid.');
    }
    const notify = config.ownerAlerts?.signInHelpChanged;
    if (typeof notify !== 'function') {
      return fail('refused', 'Changing the sign-in help address alerts the owner, and no owner alert is configured (ownerAlerts.signInHelpChanged). Nothing changed.', {
        guardrail: 'owner_alert_unavailable',
      });
    }
    let before: StoredSetting | null;
    try {
      before = await store.get(SITE_SETTING.signInHelp);
    } catch (error) {
      return fail('unavailable', `Couldn't read the current setting: ${describeAwsError(error)} Nothing changed.`);
    }
    if ((before?.version ?? 0) !== version) return fail('stale', 'The sign-in help address changed since this page loaded. Reload and try again.');
    const from = storedHelp(before)?.address ?? help.configured;
    const to = mode === 'set' ? address! : help.configured;
    if (mode === 'clear' && !before) return fail('refused', 'The configured address is already in effect.', { guardrail: 'no_change' });
    if (mode === 'set' && from === to && before) return fail('refused', `${to} is already the help address.`, { guardrail: 'no_change' });

    const run: AuditedRun<void> = await runAudited(auditLog, {
      intent: {
        actor: who.actor,
        action: ACCOUNT_AUDIT_ACTIONS.signInHelp,
        before: { address: from, source: before ? 'override' : 'config' },
        after: { address: to, source: mode === 'set' ? 'override' : 'config' },
        reason,
        calls: [mode === 'set' ? 'DynamoDB PutItem sign-in help' : 'DynamoDB DeleteItem sign-in help', 'Owner alert (sign-in help changed)'],
        ...contextOf(who.request),
      },
      run: async (steps) => {
        let written: StoredSetting | null = null;
        if (mode === 'set') {
          written = await steps.call('DynamoDB PutItem sign-in help', () =>
            store.put(SITE_SETTING.signInHelp, { value: { address: to, ...(personal && { personal: true }), reason }, expectedVersion: version, by: who.actor, now: new Date(now()) }),
          );
        } else {
          await steps.call('DynamoDB DeleteItem sign-in help', () => store.remove(SITE_SETTING.signInHelp, version));
        }
        try {
          // The owner and every Super admin: a peer sees a change that isn't theirs.
          const members = async (group: string) =>
            (await cognito().listGroupMembers(group))
              .filter((p) => p.enabled)
              .map((p) => ({ sub: p.sub, email: p.email, ...(p.name !== undefined && { name: p.name }) }));
          const owners = await members(OWNER_GROUP);
          const superAdmins = (await members(SUPERADMIN_GROUP)).filter((p) => !owners.some((o) => o.sub === p.sub));
          const alert: SignInHelpChangedAlert = {
            siteName: config.siteName,
            owners,
            superAdmins,
            changedBy: who.actor,
            from,
            to,
            reverted: mode === 'clear',
            reason,
            at: new Date(now()),
            context: who.request,
          };
          await steps.call('Owner alert (sign-in help changed)', () => notify.call(config.ownerAlerts, alert));
        } catch (error) {
          // A change nobody was told about doesn't stand: put back what was there.
          await steps.rollback('Restore the previous sign-in help', async () => {
            if (mode === 'set') {
              if (before) await store.put(SITE_SETTING.signInHelp, { value: before.value, expectedVersion: written!.version, by: before.updatedBy, now: new Date(now()) });
              else await store.remove(SITE_SETTING.signInHelp, written!.version);
            } else if (before) {
              await store.put(SITE_SETTING.signInHelp, { value: before.value, expectedVersion: 0, by: before.updatedBy, now: new Date(now()) });
            }
          });
          throw error;
        }
        help.invalidate();
        return { value: undefined };
      },
    });
    switch (run.kind) {
      case 'not-started':
        report(run.error, 'audit: intent write failed');
        return fail('audit_unavailable', "Couldn't write the audit log, so nothing was changed. Try again in a moment.");
      case 'failed':
        help.invalidate();
        if (run.error instanceof SettingConflictError) return fail('stale', run.error.message, { auditId: run.intent.id });
        return fail('failed', `${describeAwsError(run.error)} ${run.changed ? 'The change may still be in effect: check Settings.' : 'Nothing was changed.'}`, {
          changed: run.changed ? 'partly' : 'nothing',
          auditId: run.intent.id,
        });
      case 'done':
        return {
          ok: true,
          message:
            mode === 'set'
              ? `People who need help signing in are now sent to ${to}. The owner and every Super admin have been told.`
              : `The sign-in help address is back to the site's configured address, ${to}. The owner and every Super admin have been told.`,
          ...(run.result !== undefined && { auditId: run.result.id }),
        };
    }
  }

  const fromForm = (data: FormData): Record<string, unknown> => Object.fromEntries([...data.entries()].filter(([, v]) => typeof v === 'string'));
  return {
    async get() {
      try {
        await auth.requireCan(CAPABILITY as C);
      } catch (error) {
        const failure = authFailure(error);
        return { state: 'forbidden', reason: failure?.error ?? 'You can’t open this setting.' };
      }
      return help.view();
    },
    set: (input) => change(input, 'set'),
    clear: (input) => change(input, 'clear'),
    forms: {
      set: (_previous, data) => change(fromForm(data), 'set'),
      clear: (_previous, data) => change(fromForm(data), 'clear'),
    },
  };
}
