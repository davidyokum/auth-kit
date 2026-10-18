import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import type { AuthUser, ServerAuth } from '../server/auth.js';
import { nextHeadersContext } from '../server/context.js';
import {
  AuthUnavailableError,
  ForbiddenError,
  MfaEnrollmentRequiredError,
  NotFoundError,
  StepUpRequiredError,
  UnauthenticatedError,
} from '../server/errors.js';
import { ADMIN_ROLE_RANK, OWNER_GROUP, STANDARD_GROUPS, type StandardGroup } from '../shared/policy.js';
import { type AuditLogStore, type AuditedRun, runAudited } from './audit.js';
import { PEOPLE_AUDIT_ACTIONS } from './audit-actions.js';
import { describeAwsError } from './aws-errors.js';
import { CognitoAdmin, type CognitoPerson } from './cognito-admin.js';
import { peopleActionDetails, roleLabel } from './copy.js';
import {
  type GuardrailResult,
  type InviteMode,
  type InviteStatus,
  type PeopleAction,
  PEOPLE_ACTION_CAPABILITY,
  adminGroupsOf,
  checkPeopleAction,
  highestAdminRole,
  inviteExpiresAt,
  inviteStatus,
  isKnownRole,
  isStandardGroup,
  roleRank,
} from './guardrails.js';
import type { InviteMailer, OwnerAlertNotifier, OwnerInviteWarningNotifier, OwnershipTransferAlert, SuperadminGrantAlert } from './mailer.js';
import { ADMIN_POLICY } from './policy.js';
import { type QuotaLimiterOptions, type Sleep, createQuotaLimiter } from './quota.js';
import { type SweepResult, sweepFor } from './sweep.js';
import {
  type ActionResult,
  type ActivityPage,
  type AuditActor,
  type AuditEvent,
  type AuditLogQuery,
  type AuditRequestContext,
  type ChangeRoleInput,
  type DeleteUserInput,
  type FormAction,
  type InviteInput,
  MEMBER_ROLE,
  PEOPLE_FORM_FIELDS,
  type PeopleList,
  type PersonRow,
  type TargetInput,
  type TransferOwnershipInput,
} from './types.js';


export interface PeopleAdminConfig<G extends string = string, C extends string = string> {
  /** The app's server auth. Every action re-reads the acting person's status and groups live. */
  auth: ServerAuth<G, C>;
  auditLog: AuditLogStore;
  siteName: string;
  /** Absolute sign-in URL used in invite emails. */
  signInUrl: string;
  /** Default `emailed-code` (everyday pools). The Tier 3 admin pool uses `temporary-password`. */
  inviteMode?: InviteMode;
  /**
   * Sends the branded invite. Required in `emailed-code` mode. `createSesInviteMailer` also sends the
   * owner's alerts (a Super admin grant, an ownership transfer), so it serves as `ownerAlerts` too,
   * and the last-owner warning `expireStaleInvites` sends when it leaves the owner's unused invite open.
   */
  mailer?: InviteMailer & Partial<OwnerAlertNotifier> & Partial<OwnerInviteWarningNotifier>;
  /**
   * The owner's alerts: the owner is told when someone is made Super admin, and the previous and new
   * owner are told when ownership moves. Both changes require it: with no notifier the change is
   * refused, and if the alert fails the change is undone. Default: the mailer's methods (SES, from the
   * site's sender) when it has them.
   */
  ownerAlerts?: Partial<OwnerAlertNotifier>;
  /**
   * Email domains invites normally go to. An invite outside them needs `confirmOutsideDomain`,
   * because an invite to a mistyped address is a live account for whoever owns that inbox.
   */
  inviteDomains?: readonly string[];
  /** Days a disabled account waits before an owner can delete it. Default 90; 0 turns the wait off. */
  deleteRetentionDays?: number;
  /**
   * Removes the person's per-record memberships in the app's own database when they're disabled
   * (reviewers of a report, members of a team). Its return value is logged as part of `after`.
   */
  removeRecordMemberships?: (person: { sub: string; username: string; email: string }) => Promise<unknown>;
  /**
   * Called after each completed change's result row is written: grants and removals should alert a
   * named person (03 §2). Failures are reported to `onError`, never to the admin.
   */
  onChange?: (event: AuditEvent) => void | Promise<void>;
  /** Errors the actions handle without failing (a refused row or an alert that couldn't be written). */
  onError?: (error: unknown, context: string) => void;
  /** Inject a Cognito client (tests). Default: one for the pool's region, with retries left to auth-kit. */
  cognito?: CognitoIdentityProviderClient;
  quota?: QuotaLimiterOptions;
  /** Where the audit log's request context comes from. Default: Next's `headers()`. */
  requestContext?: () => Promise<AuditRequestContext>;
  /** The People list stops here (and says so). Default 5000. */
  maxPeople?: number;
  now?: () => number;
  sleep?: Sleep;
}


export interface PeopleActions {
  /** Everyone, with live status and groups: a ListUsers snapshot joined with ListUsersInGroup. Needs `people.read`. */
  listPeople(): Promise<PeopleList>;
  /** AdminCreateUser with no password and no `email_verified`; AdminAddUserToGroup; the invite email. */
  invite(input: InviteInput): Promise<ActionResult>;
  /** Sends the invite again. Never resets an account; only for an invite nobody has used. */
  resend(input: TargetInput): Promise<ActionResult>;
  /** AdminRemoveUserFromGroup / AdminAddUserToGroup, with a reason; promotions need a recent sign-in. Never grants `owner`. */
  changeRole(input: ChangeRoleInput): Promise<ActionResult>;
  /**
   * The owner hands the site to someone who has signed in: they become the owner, the previous owner
   * becomes Super admin, both are emailed. Owner only, with a reason, their address typed out, and a
   * recent sign-in. The new owner is added before the previous one is removed, so a partial failure
   * can leave two owners (the People page flags it) but never none.
   */
  transferOwnership(input: TransferOwnershipInput): Promise<ActionResult>;
  /** AdminDisableUser, then removes admin roles and record memberships. */
  disable(input: TargetInput): Promise<ActionResult>;
  /** AdminEnableUser. Old sessions stay ended; access is member-only until a role is granted again. */
  enable(input: TargetInput): Promise<ActionResult>;
  /** AdminUserGlobalSignOut. Not removal. */
  signOutEverywhere(input: TargetInput): Promise<ActionResult>;
  /** AdminDeleteUser: the owner and Super admins, after disabling and the retention period, with the address typed out. */
  deleteUser(input: DeleteUserInput): Promise<ActionResult>;
  /**
   * Disables unaccepted invites older than 7 days, as the acting admin, except the site's last
   * owner's: that one is skipped (`skipped`), logged, and the owner warned through the mailer.
   */
  expireStaleInvites(): Promise<SweepResult | { error: ActionResult }>;
  /** The Activity page: merged audit entries, newest first. Needs `audit.read`. */
  listActivity(query?: AuditLogQuery): Promise<ActivityPage>;
  /** The same actions taking FormData, for `useActionState` and `auth-kit/admin/ui`. */
  readonly forms: PeopleFormActions;
}

export interface PeopleFormActions {
  invite: FormAction;
  resend: FormAction;
  changeRole: FormAction;
  transferOwnership: FormAction;
  disable: FormAction;
  enable: FormAction;
  signOutEverywhere: FormAction;
  deleteUser: FormAction;
}

// ---- Input checks (server actions receive untrusted input) -----------------------------------

const SUB_RE = /^[A-Za-z0-9-]{1,128}$/;
const EMAIL_RE = /^[^\s@"\\<>(),;:[\]]+@[^\s@"\\<>(),;:[\]]+\.[^\s@"\\<>(),;:[\]]+$/;

class InputError extends Error {}

function record(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new InputError('Expected an object.');
  return input as Record<string, unknown>;
}

/** Trims and drops control characters. */
function text(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new InputError(`${field} must be text.`);
  const clean = [...value]
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      return c >= 32 && c !== 127;
    })
    .join('')
    .trim();
  if (clean.length > max) throw new InputError(`${field} is too long (at most ${max} characters).`);
  return clean === '' ? undefined : clean;
}

function subOf(value: unknown): string {
  if (typeof value !== 'string' || !SUB_RE.test(value)) throw new InputError('That person ID is invalid.');
  return value;
}

function emailOf(value: unknown): string {
  const email = text(value, 'Email', 254)?.toLowerCase();
  if (!email || !EMAIL_RE.test(email)) throw new InputError('Enter a full email address.');
  return email;
}


// ---- Results ------------------------------------------------------------------------------------

type Fail = Extract<ActionResult, { ok: false }>;

function fail(code: Fail['code'], error: string, extra: Partial<Omit<Fail, 'ok' | 'code' | 'error'>> = {}): Fail {
  return { ok: false, code, error, changed: 'nothing', ...extra };
}

function authFailure(error: unknown): Fail | null {
  if (error instanceof StepUpRequiredError) {
    return fail('step_up_required', 'Please sign in again to confirm this action.', { maxAgeSeconds: error.maxAgeSeconds });
  }
  if (error instanceof MfaEnrollmentRequiredError) return fail('forbidden', error.message);
  if (error instanceof UnauthenticatedError) return fail('unauthenticated', error.message);
  if (error instanceof ForbiddenError) return fail('forbidden', error.message);
  if (error instanceof NotFoundError) return fail('not_found', error.message);
  if (error instanceof AuthUnavailableError) return fail('unavailable', error.message);
  return null;
}


class OwnerAlertFailedError extends Error {
  constructor(cause: unknown, undone: boolean, what: 'grant' | 'transfer') {
    const change = what === 'grant' ? 'the Super admin grant' : 'the ownership transfer';
    const check = what === 'grant' ? "this person's role" : 'who holds the owner role';
    super(
      undone
        ? `Couldn't send the owner's alert (${describeAwsError(cause)}), so ${change} was undone. Nothing changed; try again.`
        : `Couldn't send the owner's alert (${describeAwsError(cause)}), and undoing ${change} failed too: check ${check} now. The audit log shows each call.`,
      { cause },
    );
    this.name = 'OwnerAlertFailedError';
  }
}

class InviteMisconfiguredError extends Error {
  constructor() {
    super(
      'This pool gave the new account a password, so it doesn’t offer emailed codes: a no-password invite can’t work here. Use inviteMode "temporary-password" (the admin pool) or turn on emailed codes.',
    );
    this.name = 'InviteMisconfiguredError';
  }
}

// ---- The actions --------------------------------------------------------------------------------

interface Target {
  person: CognitoPerson;
  groups: string[];
  invite: InviteStatus;
}

interface Acting<C extends string> {
  user: AuthUser<C>;
  actor: AuditActor;
  request: AuditRequestContext;
}

async function defaultRequestContext(): Promise<AuditRequestContext> {
  try {
    const { headers } = await nextHeadersContext();
    const ip = headers.get('x-forwarded-for') ?? headers.get('x-real-ip') ?? undefined;
    const userAgent = headers.get('user-agent') ?? undefined;
    const requestId = headers.get('x-amzn-trace-id') ?? headers.get('x-request-id') ?? undefined;
    return { ...(ip && { ip }), ...(userAgent && { userAgent }), ...(requestId && { requestId }) };
  } catch {
    return {};
  }
}



/**
 * The People page's server actions. Create once (in a server-only module) and call from your own
 * `'use server'` file:
 *
 * ```ts
 * // lib/admin.ts
 * export const people = createPeopleActions({ auth, auditLog, mailer, siteName: 'Example Reports', signInUrl: 'https://reports.example.org/sign-in' });
 *
 * // app/admin/people/actions.ts
 * 'use server';
 * import { people } from '@/lib/admin';
 * export async function invite(previous: ActionResult | null, data: FormData) { return people.forms.invite(previous, data); }
 * ```
 *
 * Every action, in order: `requireCan(<capability>, { live: true })` (status and groups re-read from
 * Cognito); input checks; the target re-read from Cognito; `checkPeopleAction` (with the live owner
 * count when an owner changes another owner's role); a recent sign-in for promotions, transfers, and
 * deletions; then the audit intent row, the Cognito calls, and the result row (`runAudited`). A
 * refusal is logged too.
 */
export function createPeopleActions<G extends string, C extends string>(config: PeopleAdminConfig<G, C>): PeopleActions {
  const { auth, auditLog } = config;
  const mode: InviteMode = config.inviteMode ?? 'emailed-code';
  if (mode === 'emailed-code' && !config.mailer) {
    throw new Error('auth-kit: emailed-code invites need a mailer (Cognito’s own invite is suppressed). See createSesInviteMailer.');
  }
  if (!config.siteName) throw new Error('auth-kit: createPeopleActions needs a siteName.');
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
  const now = config.now ?? Date.now;
  const retentionDays = config.deleteRetentionDays ?? ADMIN_POLICY.deleteRetentionDays;
  const maxPeople = config.maxPeople ?? ADMIN_POLICY.maxPeople;
  const inviteDomains = (config.inviteDomains ?? []).map((d) => d.toLowerCase().replace(/^@/, ''));
  const details = peopleActionDetails(mode);
  // Each owner alert comes from ownerAlerts, else the mailer; a change whose alert isn't configured is refused.
  const alertSource = (method: keyof OwnerAlertNotifier): Partial<OwnerAlertNotifier> | undefined =>
    typeof config.ownerAlerts?.[method] === 'function' ? config.ownerAlerts : typeof config.mailer?.[method] === 'function' ? config.mailer : undefined;
  const grantAlerts = alertSource('superadminGranted');
  const transferAlerts = alertSource('ownershipTransferred');
  const sendGrantAlert = grantAlerts ? (alert: SuperadminGrantAlert) => grantAlerts.superadminGranted!(alert) : undefined;
  const sendTransferAlert = transferAlerts ? (alert: OwnershipTransferAlert) => transferAlerts.ownershipTransferred!(alert) : undefined;
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
  const warningNotifier: OwnerInviteWarningNotifier | undefined =
    typeof config.mailer?.ownerInviteUnused === 'function' ? (config.mailer as OwnerInviteWarningNotifier) : undefined;
  const sweep = () =>
    sweepFor({
      cognito: cognito(),
      auditLog,
      mode,
      now,
      maxPeople,
      ...(warningNotifier !== undefined && {
        ownerWarnings: { notifier: warningNotifier, siteName: config.siteName, signInUrl: signInUrl.toString() },
      }),
      ...(config.sleep !== undefined && { sleep: config.sleep }),
    });

  const groupsKnown = (): string[] => [...new Set<string>([...STANDARD_GROUPS, ...auth.capabilities.groups])];
  const statusOf = (p: CognitoPerson): InviteStatus =>
    inviteStatus(p, new Date(now()), { mode, warnDays: ADMIN_POLICY.inviteWarnDays });

  async function acting(capability: string): Promise<Acting<C>> {
    const user = await auth.requireCan(capability as C, { live: true });
    const request: AuditRequestContext = await (config.requestContext ?? defaultRequestContext)().catch((): AuditRequestContext => ({}));
    return {
      user,
      actor: { sub: user.sub, ...(user.profile?.email !== undefined && { email: user.profile.email }) },
      request: { ...request, requestId: request.requestId ?? globalThis.crypto.randomUUID() },
    };
  }

  const contextOf = (request: AuditRequestContext) => ({
    ...(request.requestId !== undefined && { requestId: request.requestId }),
    ...((request.ip ?? request.userAgent) !== undefined && {
      context: { ...(request.ip !== undefined && { ip: request.ip }), ...(request.userAgent !== undefined && { userAgent: request.userAgent }) },
    }),
  });

  /** A refusal by an authorized person: logged (best effort), never a change. */
  async function refuse(
    who: Acting<C>,
    action: string,
    target: Target | { email: string } | null,
    guardrail: string,
    message: string,
    extra: { after?: unknown; reason?: string } = {},
  ): Promise<Fail> {
    try {
      await auditLog.append({
        phase: 'refused',
        actor: who.actor,
        action,
        ...(target && {
          target: 'person' in target ? { sub: target.person.sub, email: target.person.email } : { email: target.email },
        }),
        ...(target && 'person' in target && { before: { adminRole: highestAdminRole(target.groups), enabled: target.person.enabled } }),
        ...(extra.after !== undefined && { after: extra.after }),
        ...(extra.reason !== undefined && { reason: extra.reason }),
        error: `${guardrail}: ${message}`,
        ...contextOf(who.request),
      });
    } catch (error) {
      report(error, `audit: couldn't log a refused ${action}`);
    }
    return fail('refused', message, { guardrail });
  }

  /** Logs a forbidden attempt when the person is at least signed in (best effort). */
  async function logForbidden(action: string, error: unknown): Promise<void> {
    if (!(error instanceof ForbiddenError)) return;
    try {
      const user = await auth.getUser();
      if (!user) return;
      await auditLog.append({
        phase: 'refused',
        actor: { sub: user.sub, ...(user.profile?.email !== undefined && { email: user.profile.email }) },
        action,
        error: `capability: ${error.message}`,
      });
    } catch (logError) {
      report(logError, `audit: couldn't log a forbidden ${action}`);
    }
  }

  async function loadTarget(sub: string): Promise<Target | null> {
    const person = await cognito().findBySub(sub);
    if (!person) return null;
    const groups = await cognito().groupsOf(person.username);
    return { person, groups, invite: statusOf(person) };
  }

  /** Enabled owners right now, or undefined when Cognito can't say (the guardrail treats that as "no"). */
  async function ownerCount(): Promise<number | undefined> {
    try {
      return (await cognito().listGroupMembers(OWNER_GROUP)).filter((p) => p.enabled).length;
    } catch (error) {
      report(error, 'cognito: owner count');
      return undefined;
    }
  }

  function guard(who: Acting<C>, action: PeopleAction, target: Target | undefined, extra: { toRole?: string; ownerCount?: number; reason?: string }): GuardrailResult {
    return checkPeopleAction({
      action,
      knownRoles: groupsKnown(),
      actor: { sub: who.user.sub, groups: who.user.groups, capabilities: who.user.capabilities },
      ...(target && { target: { sub: target.person.sub, groups: target.groups, enabled: target.person.enabled, invite: target.invite } }),
      ...extra,
    });
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

  /** Turns a run into what the screen says. */
  async function finish<T>(
    run: AuditedRun<T>,
    words: { ok: (value: T) => string; partial?: (error: unknown) => string },
    subject?: (value: T) => { sub: string; email?: string },
  ): Promise<ActionResult> {
    await notify(run);
    switch (run.kind) {
      case 'not-started':
        report(run.error, 'audit: intent write failed');
        return fail('audit_unavailable', "Couldn't write the audit log, so nothing was changed. Try again in a moment.");
      case 'failed': {
        const missing = run.result === undefined;
        if (missing) report(run.resultError, 'audit: result write failed');
        const why =
          run.error instanceof InviteMisconfiguredError || run.error instanceof OwnerAlertFailedError
            ? run.error.message
            : run.changed && words.partial
              ? words.partial(run.error)
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
            `${words.ok(run.value)} But its result couldn't be added to the audit log: the change is logged as attempted, with its outcome not recorded.`,
            { changed: 'yes', auditId: run.intent.id },
          );
        }
        return { ok: true, message: words.ok(run.value), auditId: run.result.id, ...(subject && { subject: subject(run.value) }) };
    }
  }

  /** Authorize, parse, and load the target; any failure becomes an ActionResult. */
  async function begin<P extends { sub: string }>(
    action: PeopleAction,
    input: unknown,
    parse: (raw: Record<string, unknown>) => P,
  ): Promise<{ who: Acting<C>; input: P; target: Target } | Fail> {
    const auditAction = PEOPLE_AUDIT_ACTIONS[action];
    let who: Acting<C>;
    try {
      who = await acting(PEOPLE_ACTION_CAPABILITY[action]);
    } catch (error) {
      await logForbidden(auditAction, error);
      return authFailure(error) ?? fail('unavailable', describeAwsError(error));
    }
    let parsed: P;
    try {
      parsed = parse(record(input));
    } catch (error) {
      return fail('invalid', error instanceof InputError ? error.message : 'That request is invalid.');
    }
    let target: Target | null;
    try {
      target = await loadTarget(parsed.sub);
    } catch (error) {
      return fail('unavailable', `Couldn't read this person from Cognito: ${describeAwsError(error)} Nothing was changed.`);
    }
    if (!target) return fail('not_found', 'That person no longer exists.');
    return { who, input: parsed, target };
  }

  function stepUp(who: Acting<C>, needed: boolean): Fail | null {
    if (!needed) return null;
    try {
      auth.requireRecentSignIn(who.user);
      return null;
    } catch (error) {
      return authFailure(error) ?? fail('step_up_required', 'Please sign in again to confirm this action.');
    }
  }

  const base = (who: Acting<C>, action: string, target: Target) => ({
    actor: who.actor,
    action,
    target: { sub: target.person.sub, email: target.person.email },
    ...contextOf(who.request),
  });

  const parseTarget = (raw: Record<string, unknown>): TargetInput => {
    const reason = text(raw.reason, 'Reason', ADMIN_POLICY.reasonMaxLength);
    return { sub: subOf(raw.sub), ...(reason !== undefined && { reason }) };
  };

  const who = (t: Target) => t.person.name ?? t.person.email;

  // ---- the owner's alerts ----------------------------------------------------------------------
  // Only the owner grants Super admin, and each grant needs a fresh sign-in and an alert to the owner.

  const GRANT_ALERT_MISSING =
    'Granting Super admin alerts the owner, and no owner alert is configured (ownerAlerts, or a mailer that sends them). Nothing changed.';
  const TRANSFER_ALERT_MISSING =
    'Transferring ownership alerts the previous and the new owner, and no owner alert is configured (ownerAlerts, or a mailer that sends them). Nothing changed.';

  /** Reads the owner (after the grant) and alerts them; returns who was told. */
  async function alertOwnerOfGrant(
    steps: Parameters<Parameters<typeof runAudited>[1]['run']>[0],
    who: Acting<C>,
    grantedTo: { sub: string; email: string; name?: string },
    via: 'changeRole' | 'invite',
    reason: string | undefined,
  ): Promise<string[]> {
    const owners = (await cognito().listGroupMembers(OWNER_GROUP))
      .filter((p) => p.enabled)
      .map((p) => ({ sub: p.sub, email: p.email, ...(p.name !== undefined && { name: p.name }) }));
    await steps.call(`Super admin alert (to the owner${owners.length === 1 ? '' : `s, ${owners.length}`})`, () =>
      sendGrantAlert!({
        siteName: config.siteName,
        owners,
        grantedTo,
        grantedBy: who.actor,
        via,
        ...(reason !== undefined && { reason }),
        at: new Date(now()),
        context: who.request,
      }),
    );
    return owners.map((o) => o.email);
  }

  // ---- invite ---------------------------------------------------------------------------------

  async function invite(input: InviteInput): Promise<ActionResult> {
    const auditAction = PEOPLE_AUDIT_ACTIONS.invite;
    let acting_: Acting<C>;
    try {
      acting_ = await acting(PEOPLE_ACTION_CAPABILITY.invite);
    } catch (error) {
      await logForbidden(auditAction, error);
      return authFailure(error) ?? fail('unavailable', describeAwsError(error));
    }
    let email: string, role: string, name: string | undefined, reason: string | undefined, confirmOutside: boolean;
    try {
      const raw = record(input);
      email = emailOf(raw.email);
      // Role names are taken verbatim: no trimming or case folding (a near-miss is refused, not guessed).
      role = typeof raw.role === 'string' ? raw.role : '';
      if (!isKnownRole(role, groupsKnown())) throw new InputError('Choose a role this site has.');
      name = text(raw.name, 'Name', ADMIN_POLICY.nameMaxLength);
      reason = text(raw.reason, 'Reason', ADMIN_POLICY.reasonMaxLength);
      confirmOutside = raw.confirmOutsideDomain === true || raw.confirmOutsideDomain === 'on' || raw.confirmOutsideDomain === 'true';
    } catch (error) {
      return fail('invalid', error instanceof InputError ? error.message : 'That request is invalid.');
    }

    const domain = email.slice(email.lastIndexOf('@') + 1);
    if (inviteDomains.length > 0 && !inviteDomains.includes(domain) && !confirmOutside) {
      return fail(
        'refused',
        `${email} is outside this site's usual domains (${inviteDomains.join(', ')}). An invite to a mistyped address is a live account for whoever owns that inbox. Check it, then confirm to send.`,
        { guardrail: 'domain' },
      );
    }

    const g = guard(acting_, 'invite', undefined, { toRole: role, ...(reason !== undefined && { reason }) });
    if (!g.ok) return refuse(acting_, auditAction, { email }, g.code, g.reason, { after: { role }, ...(reason !== undefined && { reason }) });
    if (roleRank(role) >= ADMIN_ROLE_RANK['admin-content-people'] && (reason ?? '').length < ADMIN_POLICY.reasonMinLength) {
      return refuse(acting_, auditAction, { email }, 'reason_required', `Inviting someone as ${roleLabel(role)} needs a reason (it goes in the audit log).`, { after: { role } });
    }

    try {
      if (await cognito().findByEmail(email)) {
        return fail('refused', 'That address already has an account. Resend never resets an existing account.', { guardrail: 'exists' });
      }
    } catch (error) {
      return fail('unavailable', `Couldn't check for an existing account: ${describeAwsError(error)} Nothing was changed.`);
    }

    const superadminGrant = role === 'superadmin';
    if (superadminGrant && !sendGrantAlert) return refuse(acting_, auditAction, { email }, 'owner_alert_unavailable', GRANT_ALERT_MISSING, { after: { role } });
    const blocked = stepUp(acting_, g.requiresRecentSignIn || superadminGrant);
    if (blocked) return blocked;

    const plannedExpiry = inviteExpiresAt(new Date(now()));
    const run = await runAudited(
      auditLog,
      {
        intent: {
          actor: acting_.actor,
          action: auditAction,
          target: { email },
          before: null,
          after: { email, ...(name !== undefined && { name }), role, status: 'invited', expiresAt: plannedExpiry.toISOString() },
          ...(reason !== undefined && { reason }),
          calls: [...details.invite.calls, ...(superadminGrant ? ['Super admin alert (to the owner)'] : [])],
          ...contextOf(acting_.request),
        },
        run: async (steps) => {
          const created = await steps.call('AdminCreateUser', () =>
            cognito().createInvitedUser({ email, ...(name !== undefined && { name }), mode }),
          );
          if (mode === 'emailed-code' && created.status === 'FORCE_CHANGE_PASSWORD') {
            await steps.rollback('AdminDeleteUser', () => cognito().deleteUser(created.username));
            throw new InviteMisconfiguredError();
          }
          if (role !== MEMBER_ROLE) {
            try {
              await steps.call(`AdminAddUserToGroup ${role}`, () => cognito().addToGroup(created.username, role));
            } catch (error) {
              // A half-made invite is worse than none: it was created seconds ago and never used.
              await steps.rollback('AdminDeleteUser', () => cognito().deleteUser(created.username));
              throw error;
            }
          }
          let ownerAlert: string[] | undefined;
          if (superadminGrant) {
            try {
              ownerAlert = await alertOwnerOfGrant(steps, acting_, { sub: created.sub, email, ...(name !== undefined && { name }) }, 'invite', reason);
            } catch (error) {
              const undone = await steps.rollback('AdminDeleteUser', () => cognito().deleteUser(created.username));
              throw new OwnerAlertFailedError(error, undone, 'grant');
            }
          }
          const expiresAt = inviteExpiresAt(created.createdAt);
          if (mode === 'emailed-code') {
            await steps.call('SES SendEmail', () =>
              config.mailer!.sendInvite({
                email,
                ...(name !== undefined && { name }),
                siteName: config.siteName,
                signInUrl: signInUrl.toString(),
                expiresAt,
              }),
            );
          }
          return {
            value: { created, expiresAt },
            target: { sub: created.sub, email },
            after: {
              email,
              ...(name !== undefined && { name }),
              role,
              status: 'invited',
              invitedAt: created.createdAt.toISOString(),
              expiresAt: expiresAt.toISOString(),
              ...(ownerAlert !== undefined && { ownerAlert: { sentTo: ownerAlert } }),
            },
          };
        },
      },
      config.sleep ? { sleep: config.sleep } : {},
    );
    return finish(
      run,
      {
        ok: ({ expiresAt }) =>
          mode === 'emailed-code'
            ? `Invite sent to ${email}. They can sign in now with a code sent to that address, then save a passkey. The invite expires on ${expiresAt.toISOString().slice(0, 10)} if it isn't used.`
            : `Invite sent to ${email}. Cognito emailed them a one-time password. The invite expires on ${expiresAt.toISOString().slice(0, 10)} if it isn't used.`,
        partial: (error) =>
          `${email}'s account was created as ${roleLabel(role)}, but the invite email didn't send (${describeAwsError(error)}). Use Resend.`,
      },
      ({ created }) => ({ sub: created.sub, email }),
    );
  }

  // ---- resend ---------------------------------------------------------------------------------

  async function resend(input: TargetInput): Promise<ActionResult> {
    const start = await begin('resend', input, parseTarget);
    if ('ok' in start) return start;
    const { who: w, target } = start;
    const auditAction = PEOPLE_AUDIT_ACTIONS.resend;
    const g = guard(w, 'resend', target, {});
    if (!g.ok) return refuse(w, auditAction, target, g.code, g.reason);
    const expiresAt = inviteExpiresAt(target.person.createdAt);
    const run = await runAudited(auditLog, {
      intent: {
        ...base(w, auditAction, target),
        after: { expiresAt: expiresAt.toISOString() },
        calls: [...details.resend.calls],
        ...(start.input.reason !== undefined && { reason: start.input.reason }),
      },
      run: async (steps) => {
        if (mode === 'emailed-code') {
          await steps.call('SES SendEmail', () =>
            config.mailer!.sendInvite({
              email: target.person.email,
              ...(target.person.name !== undefined && { name: target.person.name }),
              siteName: config.siteName,
              signInUrl: signInUrl.toString(),
              expiresAt,
            }),
          );
        } else {
          await steps.call('AdminCreateUser RESEND', () => cognito().resendTemporaryPassword(target.person.username));
        }
        return { value: undefined };
      },
    });
    return finish(run, {
      ok: () =>
        mode === 'emailed-code'
          ? `Invite resent to ${target.person.email}. Nothing about their account changed.`
          : `A new one-time password went to ${target.person.email}; the old one no longer works.`,
    });
  }

  // ---- change role ----------------------------------------------------------------------------

  async function changeRole(input: ChangeRoleInput): Promise<ActionResult> {
    const start = await begin('changeRole', input, (raw) => {
      // Verbatim, like invite: "Owner", " superadmin", and "Super admin" are refused. `owner` itself
      // passes here and is refused (and logged) by the guardrail: it moves only by transfer.
      const toRole = typeof raw.toRole === 'string' ? raw.toRole : '';
      if (toRole !== MEMBER_ROLE && !isStandardGroup(toRole)) throw new InputError('Choose an admin role, or Member for none.');
      const fromRole = typeof raw.fromRole === 'string' && raw.fromRole !== '' ? raw.fromRole : undefined;
      if (fromRole !== undefined && fromRole !== MEMBER_ROLE && !isStandardGroup(fromRole)) throw new InputError('That current role is invalid.');
      const reason = text(raw.reason, 'Reason', ADMIN_POLICY.reasonMaxLength) ?? '';
      return {
        sub: subOf(raw.sub),
        toRole: toRole,
        ...(fromRole !== undefined && { fromRole: fromRole }),
        reason,
      };
    });
    if ('ok' in start) return start;
    const { who: w, target, input: inp } = start;
    const auditAction = PEOPLE_AUDIT_ACTIONS.changeRole;
    const current = adminGroupsOf(target.groups);
    const currentRole = current[0] ?? MEMBER_ROLE;
    if (inp.fromRole !== undefined && inp.fromRole !== currentRole) {
      return fail('stale', `Their role changed to ${roleLabel(currentRole)} since this page loaded. Reload and try again.`);
    }
    const wanted: StandardGroup[] = isStandardGroup(inp.toRole) ? [inp.toRole] : [];
    if (current.length === wanted.length && current.every((g, i) => g === wanted[i])) {
      return fail('refused', `That's already their role (${roleLabel(currentRole)}).`, { guardrail: 'state' });
    }
    // Only an owner changing another owner's role (a site with more than one) needs the live count.
    const ownerTarget = target.groups.includes(OWNER_GROUP) && target.person.enabled && w.user.groups.includes(OWNER_GROUP);
    const owners = ownerTarget ? await ownerCount() : undefined;
    const g = guard(w, 'changeRole', target, { toRole: inp.toRole, reason: inp.reason, ...(owners !== undefined && { ownerCount: owners }) });
    if (!g.ok) return refuse(w, auditAction, target, g.code, g.reason, { after: { adminRole: inp.toRole === MEMBER_ROLE ? null : inp.toRole }, reason: inp.reason });
    const superadminGrant = inp.toRole === 'superadmin' && !target.groups.includes('superadmin');
    if (superadminGrant && !sendGrantAlert) return refuse(w, auditAction, target, 'owner_alert_unavailable', GRANT_ALERT_MISSING, { reason: inp.reason });
    const blocked = stepUp(w, g.requiresRecentSignIn || superadminGrant);
    if (blocked) return blocked;

    const remove = current.filter((g2) => !wanted.includes(g2));
    const add = wanted.filter((g2) => !target.groups.includes(g2));
    const appRoles = target.groups.filter((g2) => !isStandardGroup(g2));
    const run = await runAudited(auditLog, {
      intent: {
        ...base(w, auditAction, target),
        before: { adminRole: current[0] ?? null, groups: target.groups },
        after: { adminRole: wanted[0] ?? null, groups: [...wanted, ...appRoles] },
        reason: inp.reason,
        calls: [
          ...remove.map((r) => `AdminRemoveUserFromGroup ${r}`),
          ...add.map((a) => `AdminAddUserToGroup ${a}`),
          ...(superadminGrant ? ['Super admin alert (to the owner)'] : []),
        ],
      },
      // Removing first: if a call fails halfway, they hold less access than before, never more.
      run: async (steps) => {
        for (const r of remove) await steps.call(`AdminRemoveUserFromGroup ${r}`, () => cognito().removeFromGroup(target.person.username, r));
        for (const a of add) await steps.call(`AdminAddUserToGroup ${a}`, () => cognito().addToGroup(target.person.username, a));
        if (!superadminGrant) return { value: undefined };
        try {
          const sentTo = await alertOwnerOfGrant(
            steps,
            w,
            { sub: target.person.sub, email: target.person.email, ...(target.person.name !== undefined && { name: target.person.name }) },
            'changeRole',
            inp.reason,
          );
          return { value: undefined, after: { adminRole: 'superadmin', groups: [...wanted, ...appRoles], ownerAlert: { sentTo } } };
        } catch (error) {
          // A Super admin grant the owner wasn't told about doesn't stand: put their old roles back.
          let undone = true;
          for (const a of add) {
            if (!(await steps.rollback(`AdminRemoveUserFromGroup ${a}`, () => cognito().removeFromGroup(target.person.username, a)))) undone = false;
          }
          for (const r of remove) {
            if (!(await steps.rollback(`AdminAddUserToGroup ${r}`, () => cognito().addToGroup(target.person.username, r)))) undone = false;
          }
          throw new OwnerAlertFailedError(error, undone, 'grant');
        }
      },
    });
    // This server's admin pages see the change at once; other instances within their ~60 s live cache.
    auth.invalidate({ username: target.person.username, tokenId: '' });
    return finish(run, {
      ok: () =>
        `${who(target)} is now ${roleLabel(inp.toRole)}. ${details.changeRole.says}${superadminGrant ? ' The owner was alerted.' : ''}`,
      partial: (error) =>
        `${describeAwsError(error)} Part of the change was made: ${who(target)} may now hold fewer roles than before (removals go first, so never more). Check their role and try again.`,
    });
  }

  // ---- transfer ownership ---------------------------------------------------------------------

  async function transferOwnership(input: TransferOwnershipInput): Promise<ActionResult> {
    const start = await begin('transferOwnership', input, (raw) => ({
      sub: subOf(raw.sub),
      reason: text(raw.reason, 'Reason', ADMIN_POLICY.reasonMaxLength) ?? '',
      confirmEmail: text(raw.confirmEmail, 'Confirmation', 254) ?? '',
    }));
    if ('ok' in start) return start;
    const { who: w, target, input: inp } = start;
    const auditAction = PEOPLE_AUDIT_ACTIONS.transferOwnership;
    const g = guard(w, 'transferOwnership', target, { reason: inp.reason });
    if (!g.ok) return refuse(w, auditAction, target, g.code, g.reason, { reason: inp.reason });
    if (inp.confirmEmail.toLowerCase() !== target.person.email.toLowerCase()) {
      return fail('refused', 'Type their email address exactly to confirm.', { guardrail: 'confirm' });
    }
    if (!sendTransferAlert) return refuse(w, auditAction, target, 'owner_alert_unavailable', TRANSFER_ALERT_MISSING, { reason: inp.reason });
    const blocked = stepUp(w, true);
    if (blocked) return blocked;

    const previous = { sub: w.user.sub, username: w.user.username, groups: [...w.user.groups] };
    let previousEmail = w.actor.email;
    let previousName: string | undefined;
    try {
      const me = await cognito().findBySub(previous.sub);
      previousEmail = me?.email ?? previousEmail;
      previousName = me?.name;
    } catch (error) {
      return fail('unavailable', `Couldn't read your own account from Cognito: ${describeAwsError(error)} Nothing was changed.`);
    }
    if (!previousEmail) return fail('unavailable', "Couldn't find your email address, so the ownership alert couldn't reach you. Nothing was changed.");

    // The new owner keeps their app roles; their admin role becomes owner. The previous owner keeps
    // their app roles and becomes Super admin.
    const targetAdmin = adminGroupsOf(target.groups);
    const dropFromTarget = targetAdmin.filter((r) => r !== OWNER_GROUP);
    const targetApp = target.groups.filter((r) => !isStandardGroup(r));
    const previousNeedsSuperadmin = !previous.groups.includes('superadmin');
    const previousApp = previous.groups.filter((r) => !isStandardGroup(r));
    const calls = [
      'AdminAddUserToGroup owner (new owner)',
      ...dropFromTarget.map((r) => `AdminRemoveUserFromGroup ${r} (new owner)`),
      ...(previousNeedsSuperadmin ? ['AdminAddUserToGroup superadmin (previous owner)'] : []),
      'AdminRemoveUserFromGroup owner (previous owner)',
      'Ownership alert (previous and new owner)',
    ];
    const run = await runAudited(auditLog, {
      intent: {
        ...base(w, auditAction, target),
        before: {
          adminRole: targetAdmin[0] ?? null,
          groups: target.groups,
          owner: { sub: previous.sub, email: previousEmail },
        },
        after: {
          adminRole: OWNER_GROUP,
          groups: [OWNER_GROUP, ...targetApp],
          previousOwner: { sub: previous.sub, email: previousEmail, adminRole: 'superadmin', groups: ['superadmin', ...previousApp] },
        },
        reason: inp.reason,
        calls,
      },
      // The new owner is added first and the previous owner removed last, so a failure partway leaves
      // two owners (flagged on the People page), never none.
      run: async (steps) => {
        const t = target.person.username;
        await steps.call('AdminAddUserToGroup owner (new owner)', () => cognito().addToGroup(t, OWNER_GROUP));
        for (const r of dropFromTarget) await steps.call(`AdminRemoveUserFromGroup ${r} (new owner)`, () => cognito().removeFromGroup(t, r));
        if (previousNeedsSuperadmin) {
          await steps.call('AdminAddUserToGroup superadmin (previous owner)', () => cognito().addToGroup(previous.username, 'superadmin'));
        }
        await steps.call('AdminRemoveUserFromGroup owner (previous owner)', () => cognito().removeFromGroup(previous.username, OWNER_GROUP));
        const previousOwner = { sub: previous.sub, email: previousEmail, ...(previousName !== undefined && { name: previousName }) };
        const newOwner = { sub: target.person.sub, email: target.person.email, ...(target.person.name !== undefined && { name: target.person.name }) };
        try {
          await steps.call('Ownership alert (previous and new owner)', () =>
            sendTransferAlert({ siteName: config.siteName, previousOwner, newOwner, reason: inp.reason, at: new Date(now()), context: w.request }),
          );
        } catch (error) {
          // A transfer neither owner was told about doesn't stand. Undo in the same safe order: the
          // previous owner is restored before the new one is removed.
          let undone = await steps.rollback('AdminAddUserToGroup owner (previous owner)', () => cognito().addToGroup(previous.username, OWNER_GROUP));
          if (previousNeedsSuperadmin) {
            undone =
              (await steps.rollback('AdminRemoveUserFromGroup superadmin (previous owner)', () => cognito().removeFromGroup(previous.username, 'superadmin'))) &&
              undone;
          }
          for (const r of dropFromTarget) {
            undone = (await steps.rollback(`AdminAddUserToGroup ${r} (new owner)`, () => cognito().addToGroup(t, r))) && undone;
          }
          undone = (await steps.rollback('AdminRemoveUserFromGroup owner (new owner)', () => cognito().removeFromGroup(t, OWNER_GROUP))) && undone;
          throw new OwnerAlertFailedError(error, undone, 'transfer');
        }
        return { value: undefined, after: { adminRole: OWNER_GROUP, groups: [OWNER_GROUP, ...targetApp], previousOwner: { ...previousOwner, adminRole: 'superadmin', groups: ['superadmin', ...previousApp] }, ownershipAlert: { sentTo: [previousEmail, target.person.email] } } };
      },
    });
    auth.invalidate({ username: target.person.username, tokenId: '' });
    auth.invalidate({ username: previous.username, tokenId: '' });
    return finish(run, {
      ok: () => `${who(target)} is now the owner, and you're a Super admin. You were both emailed. ${details.transferOwnership.later}`,
      partial: (error) =>
        `${describeAwsError(error)} Part of the transfer was made: the new owner is added before you're removed, so the site may now have two owners, never none. Check the People page and try again.`,
    });
  }

  // ---- disable / enable / sign out ------------------------------------------------------------

  async function disable(input: TargetInput): Promise<ActionResult> {
    const start = await begin('disable', input, parseTarget);
    if ('ok' in start) return start;
    const { who: w, target, input: inp } = start;
    const auditAction = PEOPLE_AUDIT_ACTIONS.disable;
    const g = guard(w, 'disable', target, {});
    if (!g.ok) return refuse(w, auditAction, target, g.code, g.reason, inp.reason !== undefined ? { reason: inp.reason } : {});

    const remove = adminGroupsOf(target.groups);
    const appRoles = target.groups.filter((g2) => !isStandardGroup(g2));
    const revokingInvite = target.invite === 'pending' || target.invite === 'expiring-soon' || target.invite === 'expired';
    const hook = config.removeRecordMemberships;
    const run = await runAudited(auditLog, {
      intent: {
        ...base(w, auditAction, target),
        before: { enabled: true, adminRole: remove[0] ?? null, groups: target.groups, ...(revokingInvite && { invite: target.invite }) },
        after: { enabled: false, adminRole: null, groups: appRoles },
        ...(inp.reason !== undefined && { reason: inp.reason }),
        calls: ['AdminDisableUser', ...remove.map((r) => `AdminRemoveUserFromGroup ${r}`), ...(hook ? ['App: remove item memberships'] : [])],
      },
      // Disable first: it's the removal step, and it stops sign-in and refresh at once.
      run: async (steps) => {
        await steps.call('AdminDisableUser', () => cognito().disable(target.person.username));
        auth.invalidate({ username: target.person.username, tokenId: '' });
        for (const r of remove) await steps.call(`AdminRemoveUserFromGroup ${r}`, () => cognito().removeFromGroup(target.person.username, r));
        const memberships = hook
          ? await steps.call('App: remove item memberships', () =>
              hook({ sub: target.person.sub, username: target.person.username, email: target.person.email }),
            )
          : undefined;
        return {
          value: undefined,
          after: { enabled: false, adminRole: null, groups: appRoles, ...(memberships !== undefined && { recordMemberships: memberships }) },
        };
      },
    });
    return finish(run, {
      ok: () =>
        revokingInvite
          ? `The invite for ${target.person.email} is revoked. Nobody ever signed in with it.`
          : `${who(target)} is disabled. ${details.disable.says}`,
      partial: (error) =>
        `${who(target)} is disabled (sign-in and refresh stop now), but cleaning up didn't finish: ${describeAwsError(error)} The audit log shows which steps succeeded.`,
    });
  }

  async function enable(input: TargetInput): Promise<ActionResult> {
    const start = await begin('enable', input, parseTarget);
    if ('ok' in start) return start;
    const { who: w, target, input: inp } = start;
    const auditAction = PEOPLE_AUDIT_ACTIONS.enable;
    const g = guard(w, 'enable', target, {});
    if (!g.ok) return refuse(w, auditAction, target, g.code, g.reason);
    if (inviteStatus({ ...target.person, enabled: true }, new Date(now()), { mode }) === 'expired') {
      return refuse(
        w,
        auditAction,
        target,
        'state',
        'This invite expired unused. Re-enabling it would be undone by the next expiry sweep: an owner deletes the old account, then invite them again.',
      );
    }
    const run = await runAudited(auditLog, {
      intent: {
        ...base(w, auditAction, target),
        before: { enabled: false },
        after: { enabled: true, adminRole: highestAdminRole(target.groups) },
        ...(inp.reason !== undefined && { reason: inp.reason }),
        calls: ['AdminEnableUser'],
      },
      run: async (steps) => {
        await steps.call('AdminEnableUser', () => cognito().enable(target.person.username));
        auth.invalidate({ username: target.person.username, tokenId: '' });
        return { value: undefined };
      },
    });
    return finish(run, { ok: () => `${who(target)} is re-enabled. ${details.enable.says} ${details.enable.now}` });
  }

  async function signOutEverywhere(input: TargetInput): Promise<ActionResult> {
    const start = await begin('signOutEverywhere', input, parseTarget);
    if ('ok' in start) return start;
    const { who: w, target, input: inp } = start;
    const auditAction = PEOPLE_AUDIT_ACTIONS.signOutEverywhere;
    const g = guard(w, 'signOutEverywhere', target, {});
    if (!g.ok) return refuse(w, auditAction, target, g.code, g.reason);
    const run = await runAudited(auditLog, {
      intent: {
        ...base(w, auditAction, target),
        after: { refreshTokensRevoked: true },
        ...(inp.reason !== undefined && { reason: inp.reason }),
        calls: ['AdminUserGlobalSignOut'],
      },
      run: async (steps) => {
        await steps.call('AdminUserGlobalSignOut', () => cognito().globalSignOut(target.person.username));
        return { value: undefined };
      },
    });
    return finish(run, { ok: () => `${who(target)} is signed out everywhere. ${details.signOutEverywhere.says}` });
  }

  // ---- delete ---------------------------------------------------------------------------------

  /** When this account was last disabled, from the audit log (newest first). */
  async function disabledAt(sub: string): Promise<Date | null> {
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const out = await auditLog.list({ targetSub: sub, action: 'people.', limit: 100, ...(cursor !== undefined && { cursor }) });
      for (const e of out.events) {
        if (e.phase !== 'result' || e.outcome === 'failed') continue;
        if (e.action === PEOPLE_AUDIT_ACTIONS.enable) return null;
        if (e.action === PEOPLE_AUDIT_ACTIONS.disable || e.action === PEOPLE_AUDIT_ACTIONS.expireInvite) return new Date(e.at);
      }
      if (!out.nextCursor) return null;
      cursor = out.nextCursor;
    }
    return null;
  }

  async function deleteUser(input: DeleteUserInput): Promise<ActionResult> {
    const start = await begin('delete', input, (raw) => ({
      sub: subOf(raw.sub),
      reason: text(raw.reason, 'Reason', ADMIN_POLICY.reasonMaxLength) ?? '',
      confirmEmail: text(raw.confirmEmail, 'Confirmation', 254) ?? '',
    }));
    if ('ok' in start) return start;
    const { who: w, target, input: inp } = start;
    const auditAction = PEOPLE_AUDIT_ACTIONS.delete;
    if (inp.confirmEmail.toLowerCase() !== target.person.email.toLowerCase()) {
      return fail('refused', 'Type their email address exactly to confirm.', { guardrail: 'confirm' });
    }
    if (inp.reason.length < ADMIN_POLICY.reasonMinLength) {
      return fail('refused', 'Deleting an account needs a reason (it goes in the audit log).', { guardrail: 'reason_required' });
    }
    const g = guard(w, 'delete', target, { reason: inp.reason });
    if (!g.ok) return refuse(w, auditAction, target, g.code, g.reason, { reason: inp.reason });

    // Never-used invites have nothing to retain. Anyone else waits out the retention period.
    const neverUsed = inviteStatus({ ...target.person, enabled: true }, new Date(now()), { mode }) !== 'accepted';
    if (retentionDays > 0 && !neverUsed) {
      let since: Date | null;
      try {
        since = await disabledAt(target.person.sub);
      } catch (error) {
        return fail('unavailable', `Couldn't read the audit log to check the retention period: ${describeAwsError(error)} Nothing was deleted.`);
      }
      if (!since) {
        return refuse(
          w,
          auditAction,
          target,
          'retention_unknown',
          "Couldn't find when this account was disabled in the audit log (it may have been disabled outside the admin area), so the retention period can't be confirmed. Nothing was deleted.",
          { reason: inp.reason },
        );
      }
      const allowedFrom = new Date(since.getTime() + retentionDays * 24 * 60 * 60 * 1000);
      if (now() < allowedFrom.getTime()) {
        return refuse(
          w,
          auditAction,
          target,
          'retention',
          `Deleting comes after the ${retentionDays}-day retention period: this account was disabled on ${since.toISOString().slice(0, 10)}, so it can be deleted from ${allowedFrom.toISOString().slice(0, 10)}.`,
          { reason: inp.reason },
        );
      }
    }
    const blocked = stepUp(w, true);
    if (blocked) return blocked;

    const run = await runAudited(auditLog, {
      intent: {
        ...base(w, auditAction, target),
        before: {
          email: target.person.email,
          username: target.person.username,
          createdAt: target.person.createdAt.toISOString(),
          enabled: false,
          groups: target.groups,
        },
        after: { deleted: true },
        reason: inp.reason,
        calls: ['AdminDeleteUser'],
      },
      run: async (steps) => {
        await steps.call('AdminDeleteUser', () => cognito().deleteUser(target.person.username));
        auth.invalidate({ username: target.person.username, tokenId: '' });
        return { value: undefined };
      },
    });
    return finish(run, { ok: () => `${target.person.email} is deleted. ${details.delete.says} Their audit history stays.` });
  }

  // ---- lists ----------------------------------------------------------------------------------

  async function listPeople(): Promise<PeopleList> {
    try {
      // Every admin role can see the list (view-only admins change nothing); actions check their own capability.
      await acting('people.read');
    } catch (error) {
      const f = authFailure(error);
      return { state: 'unavailable', reason: f ? f.error : describeAwsError(error) };
    }
    try {
      const fetchedAt = new Date(now()).toISOString();
      const { users, truncated } = await cognito().listUsers(maxPeople);
      const memberships = new Map<string, string[]>();
      for (const group of groupsKnown()) {
        for (const member of await cognito().listGroupMembers(group)) {
          const list = memberships.get(member.username) ?? [];
          list.push(group);
          memberships.set(member.username, list);
        }
      }
      const people: PersonRow[] = users.map((u) => {
        const groups = memberships.get(u.username) ?? [];
        return {
          sub: u.sub,
          username: u.username,
          email: u.email,
          ...(u.name !== undefined && { name: u.name }),
          enabled: u.enabled,
          emailVerified: u.emailVerified,
          status: u.status,
          groups,
          adminRole: highestAdminRole(groups),
          createdAt: u.createdAt.toISOString(),
          invite: { status: statusOf(u), expiresAt: inviteExpiresAt(u.createdAt).toISOString() },
        };
      });
      people.sort((a, b) => roleRank(b.adminRole) - roleRank(a.adminRole) || a.email.localeCompare(b.email));
      return { state: 'ok', people, fetchedAt, truncated, inviteMode: mode };
    } catch (error) {
      report(error, 'cognito: listPeople');
      return {
        state: 'unavailable',
        reason: `Couldn't load people: ${describeAwsError(error)} This isn't a count of zero.`,
      };
    }
  }

  async function listActivity(query: AuditLogQuery = {}): Promise<ActivityPage> {
    try {
      await acting('audit.read');
    } catch (error) {
      const f = authFailure(error);
      return { state: 'unavailable', reason: f ? f.error : describeAwsError(error) };
    }
    try {
      const q = record(query);
      const pick = (name: keyof AuditLogQuery) => (typeof q[name] === 'string' && q[name] !== '' ? { [name]: q[name] } : {});
      const limit = typeof q.limit === 'number' ? { limit: q.limit } : {};
      const page = await auditLog.listActivity({
        ...pick('actorSub'),
        ...pick('targetSub'),
        ...pick('targetEmail'),
        ...pick('targetRecordId'),
        ...pick('action'),
        ...pick('since'),
        ...pick('until'),
        ...pick('cursor'),
        ...limit,
      });
      return { state: 'ok', ...page };
    } catch (error) {
      report(error, 'audit: listActivity');
      const invalid = error instanceof Error && error.name === 'AuditEventInvalidError';
      return {
        state: 'unavailable',
        reason: invalid ? error.message.replace(/^auth-kit: /, '') : `Couldn't load the activity log: ${describeAwsError(error)}`,
      };
    }
  }

  async function expireStaleInvites(): Promise<SweepResult | { error: ActionResult }> {
    let w: Acting<C>;
    try {
      w = await acting(PEOPLE_ACTION_CAPABILITY.disable);
    } catch (error) {
      return { error: authFailure(error) ?? fail('unavailable', describeAwsError(error)) };
    }
    try {
      return await sweep()(w.actor, w.request);
    } catch (error) {
      return { error: fail('unavailable', `Couldn't list invites: ${describeAwsError(error)}`) };
    }
  }

  // ---- FormData adapters ----------------------------------------------------------------------

  const F = PEOPLE_FORM_FIELDS;
  const field = (data: FormData, name: string): string | undefined => {
    const v = data.get(name);
    return typeof v === 'string' ? v : undefined;
  };
  const formOf = (data: unknown): FormData | null => (data instanceof FormData ? data : null);
  const badForm = () => Promise.resolve(fail('invalid', 'Expected form data.'));
  const targetFrom = (data: FormData) => ({ sub: field(data, F.sub), reason: field(data, F.reason) });

  const forms: PeopleFormActions = {
    invite: (_prev, data) => {
      const d = formOf(data);
      if (!d) return badForm();
      return invite({
        email: field(d, F.email) ?? '',
        role: field(d, F.role) ?? '',
        name: field(d, F.name),
        reason: field(d, F.reason),
        confirmOutsideDomain: field(d, F.confirmOutsideDomain) !== undefined,
      });
    },
    resend: (_prev, data) => (formOf(data) ? resend(targetFrom(data) as TargetInput) : badForm()),
    changeRole: (_prev, data) => {
      const d = formOf(data);
      if (!d) return badForm();
      return changeRole({ sub: field(d, F.sub), toRole: field(d, F.toRole), fromRole: field(d, F.fromRole), reason: field(d, F.reason) } as ChangeRoleInput);
    },
    transferOwnership: (_prev, data) => {
      const d = formOf(data);
      if (!d) return badForm();
      return transferOwnership({ sub: field(d, F.sub), reason: field(d, F.reason), confirmEmail: field(d, F.confirmEmail) } as TransferOwnershipInput);
    },
    disable: (_prev, data) => (formOf(data) ? disable(targetFrom(data) as TargetInput) : badForm()),
    enable: (_prev, data) => (formOf(data) ? enable(targetFrom(data) as TargetInput) : badForm()),
    signOutEverywhere: (_prev, data) => (formOf(data) ? signOutEverywhere(targetFrom(data) as TargetInput) : badForm()),
    deleteUser: (_prev, data) => {
      const d = formOf(data);
      if (!d) return badForm();
      return deleteUser({ sub: field(d, F.sub), reason: field(d, F.reason), confirmEmail: field(d, F.confirmEmail) } as DeleteUserInput);
    },
  };

  return Object.freeze({
    listPeople,
    invite,
    resend,
    changeRole,
    transferOwnership,
    disable,
    enable,
    signOutEverywhere,
    deleteUser,
    expireStaleInvites,
    listActivity,
    forms: Object.freeze(forms),
  });
}

