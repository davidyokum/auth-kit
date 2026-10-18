/**
 * The access actions for items (ADR 0022): who has access, add, change a role, remove (or leave),
 * invite someone new to one item, create an item with its first Manager, delete an item's access,
 * and the People page's disable hook. Server-only: it imports the AWS SDK.
 *
 * Every change, in order: the acting person (live: status and groups re-read from Cognito, so a
 * demoted admin loses the site floor at once); input checks; their access to the item (no `view`:
 * "not found", never a hint the item exists; `view` but not the action: "forbidden"); the item's
 * current access (one consistent read); the guardrails (`checkAccessChange`); then the audit intent
 * row, one transaction that applies only if nobody changed the item's access since it was read, and
 * the result row (`runAudited`). A refusal by someone who can see the item is logged too.
 */
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import {
  type Fail,
  InputError,
  authFailure,
  checked,
  contextOf,
  defaultRequestContext,
  emailOf,
  fail,
  outsideDomains,
  record,
  subOf,
  text,
} from '../admin/action-kit.js';
import { type AuditLogStore, type AuditedRun, type ChangeSteps, runAudited } from '../admin/audit.js';
import { describeAwsError } from '../admin/aws-errors.js';
import { CognitoAdmin, type CognitoPerson } from '../admin/cognito-admin.js';
import { type InviteMode, inviteExpiresAt } from '../admin/guardrails.js';
import { INVITE_CALLS, InviteMisconfiguredError, createInvitedAccount, removeInvitedAccount, sendInviteEmail } from '../admin/invite-core.js';
import type { InviteMailer, ResourceInviteAlert, ResourceInviteNotifier } from '../admin/mailer.js';
import { ADMIN_POLICY } from '../admin/policy.js';
import { type QuotaLimiterOptions, type Sleep, createQuotaLimiter } from '../admin/quota.js';
import type { ActionResult, AuditActor, AuditEvent, AuditRequestContext, FormAction } from '../admin/types.js';
import type { AuthUser, ResourceAccess, ServerAuth } from '../server/auth.js';
import { UnauthenticatedError } from '../server/errors.js';
import { RESOURCE_POLICY, RESOURCE_ROLE_LABEL, RESOURCE_ROLE_RANK, RESOURCE_SITE_FLOOR, type ResourceRole } from '../shared/policy.js';
import {
  type AccessChange,
  type ResourceTypeConfig,
  checkAccessChange,
  createPermission,
  isResourceId,
  isResourceRole,
  isResourceType,
  resourceLabel,
  resourceRoleOptions,
} from './policy.js';
import { countManagers, isResourceConflict } from './store.js';
import {
  RESOURCE_COMMIT_MAX_ITEMS,
  RESOURCE_FORM_FIELDS,
  type ResourceAccessList,
  type ResourceAccessRecord,
  type ResourceAccessStore,
  type ResourceMemberRow,
  type ResourceMembership,
  type ResourceRef,
} from './types.js';

export { RESOURCE_FORM_FIELDS, type ResourceAccessList, type ResourceMemberRow } from './types.js';

/** The audit `action` each change writes. */
export const RESOURCE_AUDIT_ACTIONS = {
  create: 'resources.create',
  add: 'resources.add',
  changeRole: 'resources.changeRole',
  remove: 'resources.remove',
  invite: 'resources.invite',
  delete: 'resources.delete',
} as const;

export interface ResourceActionsConfig<G extends string = string, C extends string = string> {
  /** The app's server auth, created with `resources: { types, store }`. Changes re-read the acting person live. */
  auth: ServerAuth<G, C>;
  auditLog: AuditLogStore;
  siteName: string;
  /** Absolute sign-in URL, for invite emails. */
  signInUrl: string;
  /** Default `emailed-code` (everyday pools). */
  inviteMode?: InviteMode;
  /**
   * Sends the invite email (needed for invites in `emailed-code` mode). `createSesInviteMailer` also
   * sends the admins' alert, so it serves as `inviteAlerts` too.
   */
  mailer?: InviteMailer & Partial<ResourceInviteNotifier>;
  /**
   * The alert the site's admins get whenever a Manager invites someone new. Invites need it: with no
   * notifier they're refused, and if the alert fails the invite is undone. Default: the mailer's.
   */
  inviteAlerts?: ResourceInviteNotifier;
  /**
   * Who gets that alert. Default: every enabled member of the groups whose capabilities include
   * `people.manage` (with the standard map: the owner, Super admins, Admin – content & people).
   */
  inviteAlertRecipients?: () => Promise<readonly { sub: string; email: string; name?: string }[]>;
  /** Email domains invites normally go to; an address outside them needs `confirmOutsideDomain`. */
  inviteDomains?: readonly string[];
  /** The item's display name, from the app's own store (for emails and messages). Never taken from the request. */
  resourceName?: (ref: ResourceRef) => Promise<string | undefined>;
  /** Inject a Cognito client (tests, the auth matrix). Default: one for the pool's region. */
  cognito?: CognitoIdentityProviderClient;
  quota?: QuotaLimiterOptions;
  /** Where the audit log's request context comes from. Default: Next's `headers()`. */
  requestContext?: () => Promise<AuditRequestContext>;
  /** Called after each completed change's result row is written. Failures go to `onError`. */
  onChange?: (event: AuditEvent) => void | Promise<void>;
  /** Errors handled without failing (a refused row or a hook that couldn't run). */
  onError?: (error: unknown, context: string) => void;
  now?: () => number;
  sleep?: Sleep;
}

// ---- Inputs and results -----------------------------------------------------------------------

export interface ResourceTargetInput {
  type: string;
  id: string;
}

export interface AddMemberInput extends ResourceTargetInput {
  email: string;
  role: ResourceRole;
}

export interface ChangeMemberRoleInput extends ResourceTargetInput {
  sub: string;
  toRole: ResourceRole;
  /** The role the page showed. If it changed since, the change is refused (`stale`). */
  fromRole?: ResourceRole;
  /** Site admins only, for the last Manager: the new Manager's email, given the role in the same step. */
  replaceWithEmail?: string;
}

export interface RemoveMemberInput extends ResourceTargetInput {
  sub: string;
  /** Site admins only, for the last Manager: the new Manager's email, given the role in the same step. */
  replaceWithEmail?: string;
}

export interface InviteToResourceInput extends ResourceTargetInput {
  email: string;
  name?: string;
  role: ResourceRole;
  /** Required when the address is outside `inviteDomains`. */
  confirmOutsideDomain?: boolean;
}

export interface CreateResourceInput<T> {
  type: string;
  /** Default: a random UUID. */
  id?: string;
  /** The first Manager's email. Default: the person creating it (the only choice with self-service creation). */
  managerEmail?: string;
  /**
   * Creates the app's own item, after its access is written and before the result row. If it throws,
   * the access is removed again and nothing stands. Its return value comes back as `value`.
   */
  run?: (context: { id: string; manager: { sub: string; email?: string } }) => Promise<T>;
}

export type CreateResourceResult<T> =
  | { ok: true; id: string; value: T; message: string; auditId?: string }
  | Extract<ActionResult, { ok: false }>;

/** What the People page's disable hook removed. */
export interface RemovedMemberships {
  /** Each item's noun and name (when the app's store could say) ride along, for the audit row and screens. */
  removed: { type: string; id: string; role: ResourceRole; item: { noun: string; name?: string } }[];
  /** Items left with no Manager: a site admin who manages people should make someone their Manager. */
  leftWithoutManager: { type: string; id: string; item: { noun: string; name?: string } }[];
  /** The list stopped at `RESOURCE_POLICY.maxResourcesPerPerson` (run it again for the rest). */
  truncated: boolean;
  /**
   * What happened, in the app's words, for the People page to show after "is disabled": "Their roles
   * on 2 projects were removed. The project “Roads 2027” has no Manager now: …". Never an item's ID.
   */
  message: string;
}

/** "2 projects", "1 plan": counted by each type's noun. */
function countedNouns(items: readonly { type: string }[], types: { get(type: string): ResourceTypeConfig }): string {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.type, (counts.get(i.type) ?? 0) + 1);
  return [...counts]
    .map(([type, n]) => {
      const c = types.get(type);
      return `${n} ${n === 1 ? c.noun : c.nounPlural}`;
    })
    .join(' and ');
}

/** "the project “Roads 2027”", or "a project" when the name couldn't be read (out of the item's own context). */
function anItem(item: { noun: string; name?: string }): string {
  return item.name ? `the ${item.noun} “${item.name}”` : `${/^[aeiou]/i.test(item.noun) ? 'an' : 'a'} ${item.noun}`;
}

export interface ResourceFormActions {
  add: FormAction;
  changeRole: FormAction;
  remove: FormAction;
  invite: FormAction;
}

export interface ResourceActions {
  /** Who has access to one item. Needs `view`. */
  listAccess(input: ResourceTargetInput): Promise<ResourceAccessList>;
  /** Gives an existing account a role on the item. Needs `manage-access`. Refuses someone who already has one. */
  add(input: AddMemberInput): Promise<ActionResult>;
  /** Add or change: makes the person's role this one (no change if it already is). For APIs. Needs `manage-access`. */
  grant(input: AddMemberInput): Promise<ActionResult>;
  /** Needs `manage-access`. Never leaves the item without a Manager. */
  changeRole(input: ChangeMemberRoleInput): Promise<ActionResult>;
  /** Removes someone (needs `manage-access`), or yourself (leaving). Never leaves the item without a Manager. */
  remove(input: RemoveMemberInput): Promise<ActionResult>;
  /**
   * A Manager brings in someone with no account: the People page's invite flow with no admin role
   * (access to this one item only), then the membership, then an alert to the site's admins (if it
   * can't be sent, the invite is undone), then the invite email. Needs `invite`.
   */
  invite(input: InviteToResourceInput): Promise<ActionResult>;
  /**
   * A new item and its first Manager. Admins whose site role manages access create items and choose
   * the Manager; with the type's `selfServiceCreate`, any signed-in person creates one and becomes
   * its Manager.
   */
  create<T = undefined>(input: CreateResourceInput<T>): Promise<CreateResourceResult<T>>;
  /**
   * Removes all access to an item, for when the app deletes it. Needs `need` on the item (default
   * `manage-access`: its Managers and admins who manage people).
   */
  deleteResourceAccess(input: ResourceTargetInput, options?: { need?: string }): Promise<ActionResult>;
  /**
   * For `createPeopleActions({ removeResourceMemberships })`: removes every membership the person
   * has, on every type, when they're disabled. **No permission check of its own**: the People page's
   * disable action has already checked. Items left without a Manager are listed, never refused.
   */
  removeResourceMemberships(person: { sub: string }): Promise<RemovedMemberships>;
  /** The same changes taking FormData, for `useActionState` and `auth-kit/resources/ui`. */
  readonly forms: ResourceFormActions;
}

// ---- Errors raised inside a run ---------------------------------------------------------------

class StaleAccessError extends Error {
  constructor(noun: string) {
    super(`Who has access to this ${noun} changed since the page loaded. Reload and try again.`);
    this.name = 'StaleAccessError';
  }
}

/**
 * Some of a disabled person's memberships couldn't be removed. Its `userMessage` names the items by
 * noun and name, which the People page shows (`describeAwsError`).
 */
class AccessCleanupError extends Error {
  readonly userMessage: string;
  constructor(userMessage: string) {
    super(userMessage);
    this.name = 'AccessCleanupError';
    this.userMessage = userMessage;
  }
}

class InviteUndoneError extends Error {
  constructor(step: 'alert' | 'email', cause: unknown, undone: boolean) {
    const what = step === 'alert' ? 'the site’s admins couldn’t be alerted' : 'the invite email didn’t send';
    super(
      undone
        ? `The invite was undone because ${what} (${describeAwsError(cause)}). Nothing changed; try again.`
        : `${what.charAt(0).toUpperCase()}${what.slice(1)} (${describeAwsError(cause)}), and undoing the invite failed too: ask a site admin to check the new account. The Activity page shows each call.`,
      { cause },
    );
    this.name = 'InviteUndoneError';
  }
}

// ---- The actions ------------------------------------------------------------------------------

interface Acting<C extends string> {
  access: ResourceAccess<C>;
  config: ResourceTypeConfig;
  /** The item as screens name it: the type's noun and, when the app's store could say, its name. */
  item: ItemWords;
  actor: AuditActor;
  request: AuditRequestContext;
}

/** An item in words: the app's noun and its name. Screens never show an item's ID. */
interface ItemWords {
  noun: string;
  name?: string;
}

/** "the project “Roads 2027”", or "this project" when the name couldn't be read. */
function thisItem(item: ItemWords): string {
  return item.name ? `the ${item.noun} “${item.name}”` : `this ${item.noun}`;
}

/** The call label the audit trail shows for one access transaction: "TransactWriteItems project access". */
const accessCall = (noun: string) => `TransactWriteItems ${noun} access`;

/** Who the access record says made the change when the People page's disable removes memberships. */
const DISABLE_ACTOR = 'system:people-disable';

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Steps that just run: for a commit made inside another step (an undo) or outside any audited change. */
const directSteps = (): ChangeSteps => ({ call: (_label, fn) => fn(), rollback: () => Promise.resolve(true), changed: [] });

function memberRow(m: ResourceMembership): ResourceMemberRow {
  return {
    sub: m.sub,
    ...(m.email !== undefined && { email: m.email }),
    ...(m.name !== undefined && { name: m.name }),
    role: m.role,
    label: RESOURCE_ROLE_LABEL[m.role],
    addedAt: m.addedAt,
    ...(m.addedByEmail !== undefined && { addedByEmail: m.addedByEmail }),
  };
}

function byRoleThenEmail(a: ResourceMembership, b: ResourceMembership): number {
  return RESOURCE_ROLE_RANK[b.role] - RESOURCE_ROLE_RANK[a.role] || (a.email ?? a.sub).localeCompare(b.email ?? b.sub);
}

/**
 * The access actions. Create once, in a server-only module, after `createServerAuth({ resources })`:
 *
 * ```ts
 * // lib/resources.ts
 * export const resourceActions = createResourceActions({ auth, auditLog, mailer, siteName: 'Example Reports', signInUrl: 'https://reports.example.org/sign-in' });
 * // app/app/projects/[id]/actions.ts
 * 'use server';
 * export async function addMember(previous: ActionResult | null, data: FormData) { return resourceActions.forms.add(previous, data); }
 * ```
 */
export function createResourceActions<G extends string, C extends string>(config: ResourceActionsConfig<G, C>): ResourceActions {
  const { auth, auditLog } = config;
  if (!auth?.resources) throw new Error('auth-kit: createResourceActions needs a server auth created with resources: { types, store }.');
  const { types } = auth.resources;
  const store: ResourceAccessStore = auth.resources.store;
  if (!config.siteName) throw new Error('auth-kit: createResourceActions needs a siteName.');
  let signInUrl: URL;
  try {
    signInUrl = new URL(config.signInUrl);
  } catch {
    throw new Error('auth-kit: signInUrl must be an absolute URL.');
  }
  const localHost = signInUrl.hostname === 'localhost' || signInUrl.hostname.endsWith('.localhost') || signInUrl.hostname === '127.0.0.1';
  if (signInUrl.protocol !== 'https:' && !(signInUrl.protocol === 'http:' && localHost)) {
    throw new Error('auth-kit: signInUrl must use https (http only for localhost).');
  }
  const mode: InviteMode = config.inviteMode ?? 'emailed-code';
  const now = config.now ?? Date.now;
  const inviteDomains = (config.inviteDomains ?? []).map((d) => d.toLowerCase().replace(/^@/, ''));
  const alerts: ResourceInviteNotifier | undefined =
    config.inviteAlerts ?? (typeof config.mailer?.resourceInviteSent === 'function' ? (config.mailer as ResourceInviteNotifier) : undefined);
  const invitesConfigured = alerts !== undefined && (mode === 'temporary-password' || config.mailer !== undefined);
  const report = (error: unknown, context: string) => {
    try {
      config.onError?.(error, context);
    } catch {
      // A broken error hook must not break an action.
    }
  };

  let client = config.cognito;
  let admin: CognitoAdmin | undefined;
  const limiter = createQuotaLimiter({ ...(config.sleep !== undefined && { sleep: config.sleep }), ...config.quota });
  const cognito = (): CognitoAdmin =>
    (admin ??= new CognitoAdmin(
      (client ??= new CognitoIdentityProviderClient({ region: auth.pool.region, maxAttempts: 1 })),
      auth.pool.userPoolId,
      limiter,
    ));

  const iso = () => new Date(now()).toISOString();

  // ---- shared steps ---------------------------------------------------------------------------

  /** Parses the item named by untrusted input. */
  function refOf(raw: Record<string, unknown>): ResourceRef {
    if (!isResourceType(raw.type) || !types.has(raw.type)) throw new InputError('That kind of item isn’t on this site.');
    if (!isResourceId(raw.id)) throw new InputError(`That ${types.get(raw.type).noun} can’t be found.`);
    return { type: raw.type, id: raw.id };
  }

  function roleOf(value: unknown, field = 'Role'): ResourceRole {
    if (!isResourceRole(value)) throw new InputError(`${field}: choose Manager, Contributor, or Reader.`);
    return value;
  }

  async function requestOf(): Promise<AuditRequestContext> {
    const request: AuditRequestContext = await (config.requestContext ?? defaultRequestContext)().catch((): AuditRequestContext => ({}));
    return { ...request, requestId: request.requestId ?? globalThis.crypto.randomUUID() };
  }

  const actorOf = (user: AuthUser<C>): AuditActor => ({ sub: user.sub, ...(user.profile?.email !== undefined && { email: user.profile.email }) });

  /** The item in words: the type's noun, and its name from the app's store when it can be read (best effort). */
  async function wordsFor(ref: ResourceRef): Promise<ItemWords> {
    const noun = types.get(ref.type).noun;
    let name: string | undefined;
    try {
      const found = await config.resourceName?.(ref);
      name = typeof found === 'string' && found.trim() !== '' ? found.trim().slice(0, 200) : undefined;
    } catch (error) {
      report(error, 'resources: resourceName');
    }
    return { noun, ...(name !== undefined && { name }) };
  }

  /**
   * The acting person and their access to the item, read live. No `view`: "not found". `view` but not
   * `need`: "forbidden" (logged). `need` null: any access that can see it.
   */
  async function actingOn(ref: ResourceRef, need: string | null, action: string): Promise<Acting<C> | Fail> {
    let access: ResourceAccess<C>;
    try {
      access = await auth.resourceAccess(ref.type, ref.id, { live: true });
    } catch (error) {
      return authFailure(error) ?? fail('unavailable', describeAwsError(error));
    }
    const typeConfig = types.get(ref.type);
    if (!access.can('view')) return fail('not_found', 'Not found.');
    const who: Acting<C> = { access, config: typeConfig, item: await wordsFor(ref), actor: actorOf(access.user), request: await requestOf() };
    if (need !== null && !access.can(need)) {
      const message =
        need === 'invite'
          ? `Only this ${typeConfig.noun}’s Managers (and site admins who manage people) can invite someone new to it.`
          : `Only this ${typeConfig.noun}’s Managers (and site admins who manage people) can change who has access to it.`;
      await logRefusal(who, action, ref, null, 'capability', message);
      return fail('forbidden', message);
    }
    return who;
  }

  async function readAccess(ref: ResourceRef, item: ItemWords): Promise<ResourceAccessRecord | Fail> {
    try {
      return await store.getAccess(ref);
    } catch (error) {
      report(error, 'resources: getAccess');
      return fail('unavailable', `Couldn’t read who has access to ${thisItem(item)}: ${describeAwsError(error)} Nothing was changed.`);
    }
  }

  async function findPerson(email: string): Promise<CognitoPerson | null | Fail> {
    try {
      return await cognito().findByEmail(email);
    } catch (error) {
      return fail('unavailable', `Couldn’t look up that address: ${describeAwsError(error)} Nothing was changed.`);
    }
  }

  async function logRefusal(
    who: Acting<C>,
    action: string,
    ref: ResourceRef,
    target: { sub?: string; email?: string } | null,
    guardrail: string,
    message: string,
    after?: unknown,
  ): Promise<void> {
    try {
      await auditLog.append({
        phase: 'refused',
        actor: who.actor,
        action,
        target: { ...(target?.sub !== undefined && { sub: target.sub }), ...(target?.email !== undefined && { email: target.email }), recordId: resourceLabel(ref) },
        // The item's noun and name as of now, so the Activity page never has to show its ID.
        after: { ...(typeof after === 'object' && after !== null ? after : {}), item: who.item },
        error: `${guardrail}: ${message}`,
        ...contextOf(who.request),
      });
    } catch (error) {
      report(error, `audit: couldn't log a refused ${action}`);
    }
  }

  async function refuse(
    who: Acting<C>,
    action: string,
    ref: ResourceRef,
    target: { sub?: string; email?: string } | null,
    guardrail: string,
    message: string,
    after?: unknown,
  ): Promise<Fail> {
    await logRefusal(who, action, ref, target, guardrail, message, after);
    return fail('refused', message, { guardrail });
  }

  /** The next access record for an item whose members will be `members`. */
  function nextMeta(ref: ResourceRef, current: ResourceAccessRecord, members: readonly ResourceMembership[], actorSub: string) {
    const at = iso();
    return {
      type: ref.type,
      id: ref.id,
      version: (current.meta?.version ?? 0) + 1,
      managers: countManagers(members),
      createdAt: current.meta?.createdAt ?? at,
      createdBy: current.meta?.createdBy ?? actorSub,
      updatedAt: at,
      updatedBy: actorSub,
    };
  }

  /** Writes `put` and `delete` against the version read, as one transaction (a conflict becomes "stale"). */
  async function commitChange(
    steps: ChangeSteps,
    ref: ResourceRef,
    current: ResourceAccessRecord,
    change: { put?: ResourceMembership[]; delete?: string[] },
    actorSub: string,
  ): Promise<ResourceAccessRecord> {
    const noun = types.get(ref.type).noun;
    const gone = new Set([...(change.delete ?? []), ...(change.put ?? []).map((m) => m.sub)]);
    const members = [...current.members.filter((m) => !gone.has(m.sub)), ...(change.put ?? [])];
    const meta = nextMeta(ref, current, members, actorSub);
    try {
      await steps.call(accessCall(noun), () =>
        store.commit(ref, {
          expectedVersion: current.meta?.version ?? null,
          meta,
          ...(change.put !== undefined && { put: change.put }),
          ...(change.delete !== undefined && { delete: change.delete }),
        }),
      );
    } catch (error) {
      if (isResourceConflict(error)) throw new StaleAccessError(noun);
      throw error;
    }
    return { meta, members };
  }

  async function notify(run: AuditedRun<unknown>): Promise<void> {
    if (run.kind === 'not-started' || !run.result || !config.onChange) return;
    if (run.kind === 'failed' && !run.changed) return;
    try {
      await config.onChange(run.result);
    } catch (error) {
      report(error, 'onChange');
    }
  }

  async function finish<T>(run: AuditedRun<T>, ok: (value: T) => string): Promise<ActionResult> {
    await notify(run);
    switch (run.kind) {
      case 'not-started':
        report(run.error, 'audit: intent write failed');
        return fail('audit_unavailable', "Couldn't write the audit log, so nothing was changed. Try again in a moment.");
      case 'failed': {
        const missing = run.result === undefined;
        if (missing) report(run.resultError, 'audit: result write failed');
        if (run.error instanceof StaleAccessError && !run.changed) return fail('stale', run.error.message, { auditId: run.intent.id });
        const why =
          run.error instanceof InviteUndoneError || run.error instanceof InviteMisconfiguredError
            ? run.error.message
            : `${describeAwsError(run.error)} ${run.changed ? 'Part of the change was made; the audit log shows which calls succeeded.' : 'Nothing was changed.'}`;
        return fail('failed', missing ? `${why} The audit log shows the attempt, but not its result.` : why, {
          changed: run.changed ? 'partly' : 'nothing',
          auditId: run.intent.id,
        });
      }
      case 'done':
        if (run.result === undefined) {
          report(run.resultError, 'audit: result write failed');
          return fail(
            'audit_incomplete',
            `${ok(run.value)} But its result couldn't be added to the audit log: the change is logged as attempted, with its outcome not recorded.`,
            { changed: 'yes', auditId: run.intent.id },
          );
        }
        return { ok: true, message: ok(run.value), auditId: run.result.id };
    }
  }

  // People by name or email; never by their ID.
  const who_ = (m: { email?: string; name?: string; sub: string }) => m.name ?? m.email ?? 'an account with no email on file';
  const runOptions = config.sleep ? { sleep: config.sleep } : {};

  /** The replacement Manager for a last-Manager change: an existing member promoted, or an account added. */
  async function replacementFor(
    email: string | undefined,
    current: ResourceAccessRecord,
  ): Promise<{ person: { sub: string; email: string; name?: string }; existing: ResourceMembership | null } | Fail | undefined> {
    if (email === undefined) return undefined;
    const found = await findPerson(email);
    if (found !== null && 'ok' in found) return found;
    if (!found) return fail('refused', 'No account uses the new Manager’s address. Invite them first, or choose someone with an account.', { guardrail: 'no_account' });
    if (!found.enabled) return fail('refused', 'The new Manager’s account is disabled.', { guardrail: 'disabled' });
    return {
      person: { sub: found.sub, email: found.email, ...(found.name !== undefined && { name: found.name }) },
      existing: current.members.find((m) => m.sub === found.sub) ?? null,
    };
  }

  function guard(who: Acting<C>, change: AccessChange, target: { sub: string; role: ResourceRole | null } | undefined, extra: { toRole?: ResourceRole; managers: number; replacement?: { sub: string } }) {
    return checkAccessChange({
      change,
      actor: { sub: who.access.user.sub, actions: who.access.actions, siteActions: who.access.viaSite },
      ...(target && { target }),
      ...extra,
      noun: who.config.noun,
    });
  }

  const membership = (who: Acting<C>, ref: ResourceRef, person: { sub: string; email?: string; name?: string }, role: ResourceRole, existing?: ResourceMembership | null): ResourceMembership => {
    const at = iso();
    return existing
      ? { ...existing, role, ...(person.email !== undefined && { email: person.email }), ...(person.name !== undefined && { name: person.name }), updatedAt: at, updatedBy: who.actor.sub }
      : {
          type: ref.type,
          id: ref.id,
          sub: person.sub,
          role,
          ...(person.email !== undefined && { email: person.email }),
          ...(person.name !== undefined && { name: person.name }),
          addedBy: who.actor.sub,
          ...(who.actor.email !== undefined && { addedByEmail: who.actor.email }),
          addedAt: at,
        };
  };

  const auditBase = (who: Acting<C>, action: string, ref: ResourceRef, person: { sub?: string; email?: string }) => ({
    actor: who.actor,
    action,
    target: { ...(person.sub !== undefined && { sub: person.sub }), ...(person.email !== undefined && { email: person.email }), recordId: resourceLabel(ref) },
    ...contextOf(who.request),
  });

  // ---- list -----------------------------------------------------------------------------------

  async function listAccess(input: ResourceTargetInput): Promise<ResourceAccessList> {
    let ref: ResourceRef;
    try {
      ref = refOf(record(input));
    } catch {
      return { state: 'not_found' };
    }
    let access: ResourceAccess<C>;
    try {
      access = await auth.resourceAccess(ref.type, ref.id);
    } catch (error) {
      const f = authFailure(error);
      return { state: 'unavailable', reason: f ? f.error : describeAwsError(error) };
    }
    if (!access.can('view')) return { state: 'not_found' };
    const typeConfig = types.get(ref.type);
    try {
      const current = await store.getAccess(ref);
      return {
        state: 'ok',
        type: ref.type,
        id: ref.id,
        noun: typeConfig.noun,
        members: [...current.members].sort(byRoleThenEmail).map(memberRow),
        managers: countManagers(current.members),
        viewer: { sub: access.user.sub, role: access.role, actions: [...access.actions], siteActions: [...access.viaSite] },
        roles: resourceRoleOptions(typeConfig),
        canInvite: invitesConfigured && access.can('invite'),
        inviteMode: mode,
        fetchedAt: iso(),
      };
    } catch (error) {
      report(error, 'resources: listAccess');
      return { state: 'unavailable', reason: `Couldn’t load who has access to this ${typeConfig.noun}: ${describeAwsError(error)} This isn’t an empty list.` };
    }
  }

  // ---- add / grant ----------------------------------------------------------------------------

  async function addOrGrant(input: AddMemberInput, upsert: boolean): Promise<ActionResult> {
    const action = RESOURCE_AUDIT_ACTIONS.add;
    let ref: ResourceRef, email: string, role: ResourceRole;
    try {
      const raw = record(input);
      ref = refOf(raw);
      email = emailOf(raw.email);
      role = roleOf(raw.role);
    } catch (error) {
      return fail('invalid', error instanceof InputError ? error.message : 'That request is invalid.');
    }
    const who = await actingOn(ref, 'manage-access', action);
    if ('ok' in who) return who;
    const current = await readAccess(ref, who.item);
    if ('ok' in current) return current;
    const person = await findPerson(email);
    if (person !== null && 'ok' in person) return person;
    if (!person) return fail('refused', `No account uses that address. Invite them to ${thisItem(who.item)} instead.`, { guardrail: 'no_account' });
    if (!person.enabled) return refuse(who, action, ref, { sub: person.sub, email }, 'disabled', 'That account is disabled, so it can’t be given access.');
    const existing = current.members.find((m) => m.sub === person.sub) ?? null;
    if (existing && upsert) {
      if (existing.role === role) return { ok: true, message: `${who_(existing)} is already ${RESOURCE_ROLE_LABEL[role]}. Nothing changed.` };
      return changeRoleOn(who, ref, current, existing, role, undefined);
    }
    const g = guard(who, 'add', { sub: person.sub, role: existing?.role ?? null }, { toRole: role, managers: countManagers(current.members) });
    if (!g.ok) return refuse(who, action, ref, { sub: person.sub, email }, g.code, g.reason, { resourceRole: role });
    if (current.members.length >= RESOURCE_POLICY.maxMembersPerResource) {
      return refuse(who, action, ref, { sub: person.sub, email }, 'too_many', `A ${who.config.noun} can have at most ${RESOURCE_POLICY.maxMembersPerResource} people.`);
    }
    const added = membership(who, ref, { sub: person.sub, email: person.email, ...(person.name !== undefined && { name: person.name }) }, role);
    const run = await runAudited(
      auditLog,
      {
        intent: {
          ...auditBase(who, action, ref, { sub: person.sub, email: person.email }),
          before: { resource: resourceLabel(ref), item: who.item, resourceRole: null },
          after: { resource: resourceLabel(ref), item: who.item, resourceRole: role },
          calls: [accessCall(who.item.noun)],
        },
        run: async (steps) => {
          await commitChange(steps, ref, current, { put: [added] }, who.actor.sub);
          return { value: undefined };
        },
      },
      runOptions,
    );
    return finish(run, () => `${who_(added)} now has access to ${thisItem(who.item)} as ${RESOURCE_ROLE_LABEL[role]}.`);
  }

  // ---- change role ----------------------------------------------------------------------------

  async function changeRoleOn(
    who: Acting<C>,
    ref: ResourceRef,
    current: ResourceAccessRecord,
    target: ResourceMembership,
    toRole: ResourceRole,
    replaceWithEmail: string | undefined,
  ): Promise<ActionResult> {
    const action = RESOURCE_AUDIT_ACTIONS.changeRole;
    const replacement = await replacementFor(replaceWithEmail, current);
    if (replacement && 'ok' in replacement) return replacement;
    const g = guard(who, 'changeRole', { sub: target.sub, role: target.role }, {
      toRole,
      managers: countManagers(current.members),
      ...(replacement && { replacement: { sub: replacement.person.sub } }),
    });
    if (!g.ok) return refuse(who, action, ref, { sub: target.sub, ...(target.email !== undefined && { email: target.email }) }, g.code, g.reason, { resourceRole: toRole });
    const put = [membership(who, ref, target, toRole, target)];
    if (replacement) put.push(membership(who, ref, replacement.person, 'manager', replacement.existing));
    const run = await runAudited(
      auditLog,
      {
        intent: {
          ...auditBase(who, action, ref, { sub: target.sub, ...(target.email !== undefined && { email: target.email }) }),
          before: { resource: resourceLabel(ref), item: who.item, resourceRole: target.role },
          after: {
            resource: resourceLabel(ref),
            item: who.item,
            resourceRole: toRole,
            ...(replacement && { newManager: { sub: replacement.person.sub, email: replacement.person.email, before: replacement.existing?.role ?? null } }),
          },
          calls: [accessCall(who.item.noun)],
        },
        run: async (steps) => {
          await commitChange(steps, ref, current, { put }, who.actor.sub);
          return { value: undefined };
        },
      },
      runOptions,
    );
    return finish(
      run,
      () =>
        `${who_(target)} is now ${RESOURCE_ROLE_LABEL[toRole]} of ${thisItem(who.item)}.${replacement ? ` ${who_(replacement.person)} is now a Manager.` : ''}`,
    );
  }

  async function changeRole(input: ChangeMemberRoleInput): Promise<ActionResult> {
    const action = RESOURCE_AUDIT_ACTIONS.changeRole;
    let ref: ResourceRef, sub: string, toRole: ResourceRole, fromRole: ResourceRole | undefined, replaceWithEmail: string | undefined;
    try {
      const raw = record(input);
      ref = refOf(raw);
      sub = subOf(raw.sub);
      toRole = roleOf(raw.toRole, 'New role');
      fromRole = raw.fromRole === undefined || raw.fromRole === '' ? undefined : roleOf(raw.fromRole, 'Current role');
      replaceWithEmail = raw.replaceWithEmail === undefined || raw.replaceWithEmail === '' ? undefined : emailOf(raw.replaceWithEmail);
    } catch (error) {
      return fail('invalid', error instanceof InputError ? error.message : 'That request is invalid.');
    }
    const who = await actingOn(ref, 'manage-access', action);
    if ('ok' in who) return who;
    const current = await readAccess(ref, who.item);
    if ('ok' in current) return current;
    const target = current.members.find((m) => m.sub === sub);
    if (!target) return fail('not_found', `They don’t have access to ${thisItem(who.item)} (any more).`);
    if (fromRole !== undefined && fromRole !== target.role) {
      return fail('stale', `Their role changed to ${RESOURCE_ROLE_LABEL[target.role]} since this page loaded. Reload and try again.`);
    }
    return changeRoleOn(who, ref, current, target, toRole, replaceWithEmail);
  }

  // ---- remove ---------------------------------------------------------------------------------

  async function remove(input: RemoveMemberInput): Promise<ActionResult> {
    const action = RESOURCE_AUDIT_ACTIONS.remove;
    let ref: ResourceRef, sub: string, replaceWithEmail: string | undefined;
    try {
      const raw = record(input);
      ref = refOf(raw);
      sub = subOf(raw.sub);
      replaceWithEmail = raw.replaceWithEmail === undefined || raw.replaceWithEmail === '' ? undefined : emailOf(raw.replaceWithEmail);
    } catch (error) {
      return fail('invalid', error instanceof InputError ? error.message : 'That request is invalid.');
    }
    // Leaving needs no more than seeing the item; the guardrail decides the rest.
    const who = await actingOn(ref, null, action);
    if ('ok' in who) return who;
    const current = await readAccess(ref, who.item);
    if ('ok' in current) return current;
    const target = current.members.find((m) => m.sub === sub);
    if (!target) return fail('not_found', `They don’t have access to ${thisItem(who.item)} (any more).`);
    const replacement = await replacementFor(replaceWithEmail, current);
    if (replacement && 'ok' in replacement) return replacement;
    const g = guard(who, 'remove', { sub: target.sub, role: target.role }, {
      managers: countManagers(current.members),
      ...(replacement && { replacement: { sub: replacement.person.sub } }),
    });
    const targetRef = { sub: target.sub, ...(target.email !== undefined && { email: target.email }) };
    if (!g.ok) {
      if (g.code === 'not_allowed') {
        await logRefusal(who, action, ref, targetRef, g.code, g.reason);
        return fail('forbidden', g.reason);
      }
      return refuse(who, action, ref, targetRef, g.code, g.reason);
    }
    const leaving = target.sub === who.access.user.sub;
    const put = replacement ? [membership(who, ref, replacement.person, 'manager', replacement.existing)] : undefined;
    const run = await runAudited(
      auditLog,
      {
        intent: {
          ...auditBase(who, action, ref, targetRef),
          before: { resource: resourceLabel(ref), item: who.item, resourceRole: target.role },
          after: {
            resource: resourceLabel(ref),
            item: who.item,
            resourceRole: null,
            ...(leaving && { left: true }),
            ...(replacement && { newManager: { sub: replacement.person.sub, email: replacement.person.email, before: replacement.existing?.role ?? null } }),
          },
          calls: [accessCall(who.item.noun)],
        },
        run: async (steps) => {
          await commitChange(steps, ref, current, { delete: [target.sub], ...(put && { put }) }, who.actor.sub);
          return { value: undefined };
        },
      },
      runOptions,
    );
    return finish(run, () =>
      leaving
        ? `You no longer have a role on ${thisItem(who.item)}.`
        : `${who_(target)} no longer has access to ${thisItem(who.item)}.${replacement ? ` ${who_(replacement.person)} is now a Manager.` : ''}`,
    );
  }

  // ---- invite ---------------------------------------------------------------------------------

  async function alertRecipients(): Promise<{ sub: string; email: string; name?: string }[]> {
    if (config.inviteAlertRecipients) return [...(await config.inviteAlertRecipients())].filter((r) => r.email);
    const recipients = new Map<string, { sub: string; email: string; name?: string }>();
    for (const group of auth.capabilities.groupsWith(RESOURCE_SITE_FLOOR['manage-access'] as C)) {
      for (const p of await cognito().listGroupMembers(group)) {
        if (p.enabled && p.email) recipients.set(p.sub, { sub: p.sub, email: p.email, ...(p.name !== undefined && { name: p.name }) });
      }
    }
    return [...recipients.values()];
  }

  async function invite(input: InviteToResourceInput): Promise<ActionResult> {
    const action = RESOURCE_AUDIT_ACTIONS.invite;
    let ref: ResourceRef, email: string, role: ResourceRole, name: string | undefined, confirmOutside: boolean;
    try {
      const raw = record(input);
      ref = refOf(raw);
      email = emailOf(raw.email);
      role = roleOf(raw.role);
      name = text(raw.name, 'Name', ADMIN_POLICY.nameMaxLength);
      confirmOutside = checked(raw.confirmOutsideDomain);
    } catch (error) {
      return fail('invalid', error instanceof InputError ? error.message : 'That request is invalid.');
    }
    const who = await actingOn(ref, 'invite', action);
    if ('ok' in who) return who;
    const g = guard(who, 'invite', undefined, { toRole: role, managers: 0 });
    if (!g.ok) return refuse(who, action, ref, { email }, g.code, g.reason, { resourceRole: role });
    if (!invitesConfigured) {
      return refuse(
        who,
        action,
        ref,
        { email },
        'invite_unavailable',
        'Inviting someone new isn’t set up on this site (it needs the invite email and the admins’ alert). Ask a site admin to invite them.',
      );
    }
    if (outsideDomains(email, inviteDomains) && !confirmOutside) {
      return fail(
        'refused',
        `${email} is outside this site's usual domains (${inviteDomains.join(', ')}). An invite to a mistyped address is a live account for whoever owns that inbox. Check it, then confirm to send.`,
        { guardrail: 'domain' },
      );
    }
    const existing = await findPerson(email);
    if (existing !== null && 'ok' in existing) return existing;
    if (existing) return fail('refused', `That address already has an account. Add them to ${thisItem(who.item)} instead.`, { guardrail: 'exists' });
    const current = await readAccess(ref, who.item);
    if ('ok' in current) return current;
    if (current.members.length >= RESOURCE_POLICY.maxMembersPerResource) {
      return refuse(who, action, ref, { email }, 'too_many', `A ${who.config.noun} can have at most ${RESOURCE_POLICY.maxMembersPerResource} people.`);
    }
    let recipients: { sub: string; email: string; name?: string }[];
    try {
      recipients = await alertRecipients();
    } catch (error) {
      return fail('unavailable', `Couldn’t read who to alert: ${describeAwsError(error)} Nothing was changed.`);
    }
    if (recipients.length === 0) {
      return refuse(who, action, ref, { email }, 'alert_unavailable', 'Every invite alerts the site’s admins, and none with an email address was found. Nothing changed; ask a site admin.');
    }
    const itemName = who.item.name;
    // The invite email and the alert say who invited them: from the token's profile, else Cognito.
    let inviterEmail = who.actor.email;
    if (inviterEmail === undefined) {
      try {
        inviterEmail = (await cognito().findBySub(who.actor.sub))?.email || undefined;
      } catch (error) {
        report(error, 'cognito: inviter email');
      }
    }
    const invitedBy = { sub: who.actor.sub, ...(inviterEmail !== undefined && { email: inviterEmail }) };
    const plannedExpiry = inviteExpiresAt(new Date(now()));
    const run = await runAudited(
      auditLog,
      {
        intent: {
          ...auditBase(who, action, ref, { email }),
          before: null,
          after: {
            email,
            ...(name !== undefined && { name }),
            role: 'member',
            resource: resourceLabel(ref),
            item: who.item,
            resourceRole: role,
            status: 'invited',
            expiresAt: plannedExpiry.toISOString(),
          },
          calls: [
            `${INVITE_CALLS.createAccount} (no admin role)`,
            accessCall(who.item.noun),
            `Invite alert (to the site’s admins, ${recipients.length})`,
            ...(mode === 'emailed-code' ? [INVITE_CALLS.sendEmail] : []),
          ],
        },
        run: async (steps) => {
          const created = await createInvitedAccount(steps, cognito(), { email, ...(name !== undefined && { name }), mode });
          const person = { sub: created.sub, email, ...(name !== undefined && { name }) };
          const added = membership(who, ref, person, role);
          let afterAdd: ResourceAccessRecord;
          try {
            afterAdd = await commitChange(steps, ref, current, { put: [added] }, who.actor.sub);
          } catch (error) {
            await removeInvitedAccount(steps, cognito(), created);
            throw error;
          }
          const undo = async (): Promise<boolean> => {
            let undone = await steps.rollback(`${accessCall(who.item.noun)} (remove)`, async () => {
              await commitChange(directSteps(), ref, afterAdd, { delete: [created.sub] }, who.actor.sub);
            });
            undone = (await removeInvitedAccount(steps, cognito(), created)) && undone;
            return undone;
          };
          const alert: ResourceInviteAlert = {
            siteName: config.siteName,
            recipients,
            invited: person,
            invitedBy,
            item: { type: ref.type, id: ref.id, noun: who.config.noun, ...(itemName !== undefined && { name: itemName }) },
            role,
            at: new Date(now()),
            context: who.request,
          };
          try {
            await steps.call(`Invite alert (to the site’s admins, ${recipients.length})`, () => alerts.resourceInviteSent(alert));
          } catch (error) {
            throw new InviteUndoneError('alert', error, await undo());
          }
          const expiresAt = inviteExpiresAt(created.createdAt);
          if (mode === 'emailed-code') {
            try {
              await sendInviteEmail(steps, config.mailer!, {
                email,
                ...(name !== undefined && { name }),
                siteName: config.siteName,
                signInUrl: signInUrl.toString(),
                expiresAt,
                item: { noun: who.config.noun, ...(itemName !== undefined && { name: itemName }), role, ...(inviterEmail !== undefined && { invitedBy: inviterEmail }) },
              });
            } catch (error) {
              throw new InviteUndoneError('email', error, await undo());
            }
          }
          return {
            value: { expiresAt },
            target: { sub: created.sub, email, recordId: resourceLabel(ref) },
            after: {
              email,
              ...(name !== undefined && { name }),
              role: 'member',
              resource: resourceLabel(ref),
              item: who.item,
              resourceRole: role,
              status: 'invited',
              invitedAt: created.createdAt.toISOString(),
              expiresAt: expiresAt.toISOString(),
              inviteAlert: { sentTo: recipients.map((r) => r.email) },
            },
          };
        },
      },
      runOptions,
    );
    return finish(
      run,
      ({ expiresAt }) =>
        `Invite sent to ${email}, with access to ${thisItem(who.item)} as ${RESOURCE_ROLE_LABEL[role]} and nothing else. The site’s admins were told. The invite expires on ${expiresAt.toISOString().slice(0, 10)} if it isn’t used.`,
    );
  }

  // ---- create ---------------------------------------------------------------------------------

  async function create<T = undefined>(input: CreateResourceInput<T>): Promise<CreateResourceResult<T>> {
    const action = RESOURCE_AUDIT_ACTIONS.create;
    let type: string, id: string, managerEmail: string | undefined;
    try {
      const raw = record(input);
      if (!isResourceType(raw.type) || !types.has(raw.type)) throw new InputError('That kind of item isn’t on this site.');
      type = raw.type;
      if (raw.id !== undefined && !isResourceId(raw.id)) throw new InputError('That item ID is invalid.');
      id = typeof raw.id === 'string' ? raw.id : globalThis.crypto.randomUUID();
      managerEmail = raw.managerEmail === undefined || raw.managerEmail === '' ? undefined : emailOf(raw.managerEmail);
      if (input.run !== undefined && typeof input.run !== 'function') throw new InputError('run must be a function.');
    } catch (error) {
      return fail('invalid', error instanceof InputError ? error.message : 'That request is invalid.');
    }
    const typeConfig = types.get(type);
    const ref: ResourceRef = { type, id };
    let user: AuthUser<C>;
    let capabilities: ReadonlySet<C>;
    try {
      user = await auth.requireUser();
      // Live, like every access change: a demoted admin can't hand out access with their old token.
      const live = await auth.liveState(user);
      if (!live.enabled) throw new UnauthenticatedError('account_disabled', 'This account is disabled.');
      capabilities = auth.capabilities.capabilitiesOf(live.groups);
    } catch (error) {
      return authFailure(error) ?? fail('unavailable', describeAwsError(error));
    }
    const actor = actorOf(user);
    const request = await requestOf();
    const permission = createPermission(typeConfig, capabilities);
    if (!permission.allowed) return fail('forbidden', permission.reason);

    let manager: { sub: string; email?: string; name?: string };
    const self = { sub: user.sub, ...(user.profile?.email !== undefined && { email: user.profile.email }), ...(user.profile?.name !== undefined && { name: user.profile.name }) };
    if (managerEmail === undefined || managerEmail === user.profile?.email?.toLowerCase()) {
      manager = self;
    } else {
      if (permission.manager === 'self') return fail('refused', `You become the Manager of a ${typeConfig.noun} you create. Add others once it exists.`, { guardrail: 'self_only' });
      const person = await findPerson(managerEmail);
      if (person !== null && 'ok' in person) return person;
      if (!person) return fail('refused', 'No account uses that address. Invite them from the People page first, or choose someone with an account.', { guardrail: 'no_account' });
      if (!person.enabled) return fail('refused', 'That account is disabled, so it can’t manage anything.', { guardrail: 'disabled' });
      manager = { sub: person.sub, email: person.email, ...(person.name !== undefined && { name: person.name }) };
    }
    let current: ResourceAccessRecord;
    try {
      current = await store.getAccess(ref);
    } catch (error) {
      return fail('unavailable', `Couldn’t check that ID is free: ${describeAwsError(error)} Nothing was created.`);
    }
    if (current.meta !== null || current.members.length > 0) return fail('refused', `That ${typeConfig.noun} already exists.`, { guardrail: 'exists' });

    const at = iso();
    const first: ResourceMembership = {
      type,
      id,
      sub: manager.sub,
      role: 'manager',
      ...(manager.email !== undefined && { email: manager.email }),
      ...(manager.name !== undefined && { name: manager.name }),
      addedBy: actor.sub,
      ...(actor.email !== undefined && { addedByEmail: actor.email }),
      addedAt: at,
    };
    const meta = { type, id, version: 1, managers: 1, createdAt: at, createdBy: actor.sub, updatedAt: at, updatedBy: actor.sub };
    const noun = typeConfig.noun;
    const createCall = `${accessCall(noun)} (access record and first Manager)`;
    const appCall = `App: create the ${noun}`;
    const createdAfter = { resource: resourceLabel(ref), resourceRole: 'manager', manager: { sub: manager.sub, ...(manager.email !== undefined && { email: manager.email }) } };
    let created: ItemWords = { noun };
    const run = await runAudited<T>(
      auditLog,
      {
        intent: {
          actor,
          action,
          target: { sub: manager.sub, ...(manager.email !== undefined && { email: manager.email }), recordId: resourceLabel(ref) },
          before: null,
          after: { ...createdAfter, item: { noun } },
          calls: [createCall, ...(input.run ? [appCall] : [])],
          ...contextOf(request),
        },
        run: async (steps) => {
          try {
            await steps.call(createCall, () => store.commit(ref, { expectedVersion: null, meta, put: [first] }));
          } catch (error) {
            if (isResourceConflict(error)) throw new StaleAccessError(noun);
            throw error;
          }
          if (!input.run) return { value: undefined as T, after: { ...createdAfter, item: (created = await wordsFor(ref)) } };
          try {
            const value = await steps.call(appCall, () => input.run!({ id, manager: { sub: manager.sub, ...(manager.email !== undefined && { email: manager.email }) } }));
            // Its name, now that the app has written it: the result row and the message name it.
            created = await wordsFor(ref);
            return { value, after: { ...createdAfter, item: created } };
          } catch (error) {
            await steps.rollback(`${accessCall(noun)} (remove)`, () => store.commit(ref, { expectedVersion: 1, meta: null, delete: [manager.sub] }));
            throw error;
          }
        },
      },
      runOptions,
    );
    const mine = manager.sub === user.sub;
    const what = created.name ? `the ${noun} “${created.name}”` : `the ${noun}`;
    const result = await finish(run, () =>
      mine
        ? `Created ${what}. You’re its Manager: you can share it from “Who has access”.`
        : `Created ${what}, with ${who_(manager)} as its Manager.`,
    );
    if (!result.ok) return result;
    return { ok: true, id, value: (run as Extract<AuditedRun<T>, { kind: 'done' }>).value, message: result.message, ...(result.auditId !== undefined && { auditId: result.auditId }) };
  }

  // ---- delete an item's access ----------------------------------------------------------------

  async function deleteResourceAccess(input: ResourceTargetInput, options: { need?: string } = {}): Promise<ActionResult> {
    const action = RESOURCE_AUDIT_ACTIONS.delete;
    let ref: ResourceRef;
    try {
      ref = refOf(record(input));
    } catch (error) {
      return fail('invalid', error instanceof InputError ? error.message : 'That request is invalid.');
    }
    const need = options.need ?? 'manage-access';
    if (!types.get(ref.type).allActions.includes(need)) throw new Error(`auth-kit: "${need}" isn't an action of resource type "${ref.type}".`);
    const who = await actingOn(ref, need, action);
    if ('ok' in who) return who;
    const current = await readAccess(ref, who.item);
    if ('ok' in current) return current;
    const subs = current.members.map((m) => m.sub);
    const chunks: string[][] = [];
    for (let i = 0; i < subs.length; i += RESOURCE_COMMIT_MAX_ITEMS) chunks.push(subs.slice(i, i + RESOURCE_COMMIT_MAX_ITEMS));
    if (chunks.length === 0) chunks.push([]);
    const run = await runAudited(
      auditLog,
      {
        intent: {
          ...auditBase(who, action, ref, {}),
          before: { resource: resourceLabel(ref), item: who.item, members: current.members.length, managers: countManagers(current.members) },
          after: { resource: resourceLabel(ref), item: who.item, deleted: true },
          calls: chunks.map((_, i) => `${accessCall(who.item.noun)} (${i + 1} of ${chunks.length})`),
        },
        run: async (steps) => {
          let state = current;
          for (let i = 0; i < chunks.length; i++) {
            const last = i === chunks.length - 1;
            const batch = chunks[i]!;
            const label = `${accessCall(who.item.noun)} (${i + 1} of ${chunks.length})`;
            if (state.meta === null && batch.length > 0 && last) {
              // No access record to lock (an item never created through auth-kit): write one first.
              state = await commitChange(steps, ref, state, {}, who.actor.sub);
            }
            try {
              await steps.call(label, () =>
                store.commit(ref, {
                  expectedVersion: state.meta?.version ?? null,
                  meta: last ? null : nextMeta(ref, state, state.members.filter((m) => !batch.includes(m.sub)), who.actor.sub),
                  delete: batch,
                }),
              );
            } catch (error) {
              if (isResourceConflict(error)) throw new StaleAccessError(who.item.noun);
              throw error;
            }
            const members = state.members.filter((m) => !batch.includes(m.sub));
            state = { meta: last ? null : nextMeta(ref, state, members, who.actor.sub), members };
          }
          return { value: undefined };
        },
      },
      runOptions,
    );
    return finish(run, () => `Nobody has access to ${thisItem(who.item)} any more (${current.members.length} removed).`);
  }

  // ---- the People page's disable hook ---------------------------------------------------------

  async function removeResourceMemberships(person: { sub: string }): Promise<RemovedMemberships> {
    if (!person || typeof person.sub !== 'string' || person.sub === '') throw new Error('auth-kit: removeResourceMemberships needs the person’s sub.');
    const listed = await store.listForPerson(person.sub);
    const removed: RemovedMemberships['removed'] = [];
    const leftWithoutManager: RemovedMemberships['leftWithoutManager'] = [];
    const failures: { item: ItemWords; why: string }[] = [];
    const steps = directSteps();
    for (const m of listed.memberships) {
      if (!types.has(m.type)) continue;
      const ref = { type: m.type, id: m.id };
      const item = await wordsFor(ref);
      let done = false;
      // One retry: a concurrent change to the same item is rare, and a fresh read resolves it.
      for (let attempt = 0; attempt < 2 && !done; attempt++) {
        try {
          const current = await store.getAccess(ref);
          const mine = current.members.find((x) => x.sub === person.sub);
          if (!mine) {
            done = true;
            break;
          }
          const after = await commitChange(steps, ref, current, { delete: [person.sub] }, DISABLE_ACTOR);
          removed.push({ type: m.type, id: m.id, role: mine.role, item });
          if (mine.role === 'manager' && countManagers(after.members) === 0) leftWithoutManager.push({ ...ref, item });
          done = true;
        } catch (error) {
          if (!(error instanceof StaleAccessError) || attempt === 1) {
            failures.push({ item, why: describeAwsError(error).replace(/\.$/, '') });
            done = true;
          }
        }
      }
    }
    const orphaned =
      leftWithoutManager.length === 0
        ? ''
        : ` ${leftWithoutManager.length === 1 ? `${capitalize(anItem(leftWithoutManager[0]!.item))} has` : `${countedNouns(leftWithoutManager, types)} have`} no Manager now: a site admin who manages people can make someone its Manager.`;
    if (failures.length > 0) {
      const which = failures.slice(0, 3).map((f) => `${anItem(f.item)} (${f.why})`).join('; ');
      throw new AccessCleanupError(
        `Their roles on ${countedNouns(removed, types) || 'nothing'} were removed, but ${failures.length === 1 ? 'one' : failures.length} couldn’t be: ${which}${failures.length > 3 ? '; …' : ''}. Disable them again to retry, or remove them under Who has access.${orphaned}`,
      );
    }
    const message =
      removed.length === 0
        ? `They had no role on any ${types.names.map((t) => types.get(t).noun).join(' or ')}.`
        : `Their roles on ${countedNouns(removed, types)} were removed.${orphaned}${listed.truncated ? ' The list stopped partway: disable again to remove the rest.' : ''}`;
    return { removed, leftWithoutManager, truncated: listed.truncated, message };
  }

  // ---- FormData adapters ----------------------------------------------------------------------

  const F = RESOURCE_FORM_FIELDS;
  const field = (data: FormData, name: string): string | undefined => {
    const v = data.get(name);
    return typeof v === 'string' ? v : undefined;
  };
  const badForm = () => Promise.resolve(fail('invalid', 'Expected form data.'));
  const target = (d: FormData) => ({ type: field(d, F.type), id: field(d, F.id) });

  const forms: ResourceFormActions = {
    add: (_prev, data) =>
      data instanceof FormData ? addOrGrant({ ...target(data), email: field(data, F.email), role: field(data, F.role) } as AddMemberInput, false) : badForm(),
    changeRole: (_prev, data) =>
      data instanceof FormData
        ? changeRole({
            ...target(data),
            sub: field(data, F.sub),
            toRole: field(data, F.toRole),
            fromRole: field(data, F.fromRole),
            replaceWithEmail: field(data, F.replaceWithEmail),
          } as ChangeMemberRoleInput)
        : badForm(),
    remove: (_prev, data) =>
      data instanceof FormData ? remove({ ...target(data), sub: field(data, F.sub), replaceWithEmail: field(data, F.replaceWithEmail) } as RemoveMemberInput) : badForm(),
    invite: (_prev, data) =>
      data instanceof FormData
        ? invite({
            ...target(data),
            email: field(data, F.email),
            name: field(data, F.name),
            role: field(data, F.role),
            confirmOutsideDomain: field(data, F.confirmOutsideDomain) !== undefined,
          } as InviteToResourceInput)
        : badForm(),
  };

  return Object.freeze({
    listAccess,
    add: (input: AddMemberInput) => addOrGrant(input, false),
    grant: (input: AddMemberInput) => addOrGrant(input, true),
    changeRole,
    remove,
    invite,
    create,
    deleteResourceAccess,
    removeResourceMemberships,
    forms: Object.freeze(forms),
  });
}
