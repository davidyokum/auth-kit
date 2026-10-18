/**
 * The invite-expiry sweep (03 §2 "An invite with no sign-in after 7 days is disabled"): every
 * unaccepted invite older than 7 days is disabled and loses its admin roles, each logged intent →
 * calls → result. Run by an admin (`people.expireStaleInvites`) or on a schedule with no signed-in
 * person (`createInviteExpirySweep`, which `InviteExpirySweep` in `auth-kit/admin/cdk` deploys).
 *
 * One exception (ADR 0019): the sweep never disables, or strips roles from, the site's last owner
 * (the last enabled member of `OWNER_GROUP`, from the shared policy), even one who never signed in.
 * An expired owner invite is disabled only while another enabled owner remains (read live, not
 * counting anyone this run has disabled). Otherwise it's skipped: the skip is logged as a refusal
 * ("skipped: last owner"), and the owner, and an optional fallback address, are warned. When the
 * owner count can't be read, the owner is skipped too, and the run reports a failure.
 *
 * Kept apart from the People module so the scheduled Lambda's bundle holds only the AWS SDK clients
 * it calls: no Next.js, no React.
 */
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { INVITE_EXPIRY_DAYS, OWNER_GROUP } from '../shared/policy.js';
import { type AuditLogStore, runAudited } from './audit.js';
import { PEOPLE_AUDIT_ACTIONS } from './audit-actions.js';
import { describeAwsError } from './aws-errors.js';
import { CognitoAdmin, type CognitoPerson } from './cognito-admin.js';
import { type InviteMode, adminGroupsOf, inviteExpiresAt, inviteStatus } from './guardrails.js';
import type { OwnerInviteWarningNotifier } from './mailer.js';
import { ADMIN_POLICY } from './policy.js';
import { type QuotaLimiterOptions, type Sleep, createQuotaLimiter } from './quota.js';
import type { AuditActor, AuditRequestContext } from './types.js';

/** Who a last-owner warning went to: the owner, or the configured fallback address. */
export type SweepWarningRecipient = 'owner' | 'fallback';

/** A due invite the sweep left enabled on purpose. */
export interface SweepSkip {
  sub: string;
  /** Disabling them would leave the site with no enabled owner. */
  reason: 'last-owner';
  /**
   * Whether this run warned and logged the skip. With `runEveryMinutes` that happens on the first run
   * after the invite expired and then once a day; the runs in between only skip. Without it, every run.
   */
  warningDue: boolean;
  /** Who this run warned. */
  warned: SweepWarningRecipient[];
  /** What went wrong warning them or logging the skip. The scheduled job fails the run (and alarms) on any. */
  problems: string[];
}

export interface SweepResult {
  /** Subs of invites disabled by this run. */
  disabled: string[];
  /** Invites that were due but couldn't be disabled (and why), including owners whose count couldn't be read. */
  failed: { sub: string; error: string }[];
  /** Due invites left enabled on purpose: each is the site's last owner. Not failures. */
  skipped: SweepSkip[];
  /** How many accounts were checked. */
  checked: number;
  /** The pool has more accounts than `maxPeople`: the rest weren't checked. */
  truncated: boolean;
}

/** How the sweep warns a last owner whose invite it left open. */
export interface OwnerWarningOptions {
  /** Sends each message. `createSesInviteMailer` is one. */
  notifier: OwnerInviteWarningNotifier;
  siteName: string;
  /** Absolute sign-in URL, for the owner's message. */
  signInUrl?: string;
  /** Also warn this address (an operator), in a message of its own. */
  fallbackEmail?: string;
}

/** The system actor scheduled sweeps write audit rows as. */
export const INVITE_EXPIRY_ACTOR: AuditActor = Object.freeze({ sub: 'system:invite-expiry', kind: 'system' });

/** What the refusal row says when the sweep leaves the last owner's invite open. */
export const LAST_OWNER_SKIP_MESSAGE =
  'skipped: last owner. Disabling this invite would leave the site with no enabled owner, so it stays open until they sign in, or the owner role goes to someone else (the break-glass path: a site has exactly one owner).';

const OWNER_COUNT_UNKNOWN_MESSAGE = "Couldn't confirm another owner exists, so this owner's invite wasn't disabled.";

const DAY = 24 * 60 * 60 * 1000;

/**
 * True when this run should warn about a skipped last owner: with no window, always; otherwise the
 * first run (of length `windowMs`) after the invite expired, and the first of each day after that.
 * No state is kept: the sweep's role writes the audit log but never reads it.
 */
export function lastOwnerWarningDue(createdAt: Date, nowMs: number, windowMs: number | undefined): boolean {
  if (windowMs === undefined || windowMs >= DAY) return true;
  const expiredAt = inviteExpiresAt(createdAt).getTime();
  // An unreadable creation date still gets one warning a day, at midnight UTC.
  const since = Number.isFinite(expiredAt) ? nowMs - expiredAt : nowMs;
  return ((since % DAY) + DAY) % DAY < windowMs;
}

function isoOrNull(date: Date): string | null {
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function sweepFor(deps: {
  cognito: CognitoAdmin;
  auditLog: AuditLogStore;
  mode: InviteMode;
  now: () => number;
  maxPeople: number;
  ownerWarnings?: OwnerWarningOptions;
  /** How often the sweep runs, in milliseconds: last-owner warnings go out once a day, not every run. */
  reminderWindowMs?: number;
  sleep?: Sleep;
}) {
  return async (actor: AuditActor, request: AuditRequestContext): Promise<SweepResult> => {
    const { users, truncated } = await deps.cognito.listUsers(deps.maxPeople);
    const nowMs = deps.now();
    const today = new Date(nowMs);
    const due = users.filter((u) => inviteStatus(u, today, { mode: deps.mode }) === 'expired');
    const result: SweepResult = { disabled: [], failed: [], skipped: [], checked: users.length, truncated };
    const context = {
      ...(request.requestId !== undefined && { requestId: request.requestId }),
      context: { ...(request.ip && { ip: request.ip }), ...(request.userAgent && { userAgent: request.userAgent }) },
    };
    const reason = `Invite unused for ${INVITE_EXPIRY_DAYS} days`;
    // Everyone this run tried to disable, whatever the outcome: never counted as an owner who remains.
    const attempted = new Set<string>();

    /** A refusal row (best effort: the caller reports a failure to write it where it matters). */
    const refuse = (person: CognitoPerson, before: Record<string, unknown>, error: string, calls?: string[]) =>
      deps.auditLog.append({
        phase: 'refused',
        actor,
        action: PEOPLE_AUDIT_ACTIONS.expireInvite,
        target: { sub: person.sub, email: person.email },
        before,
        reason,
        ...(calls !== undefined && { calls }),
        error,
        ...context,
      });

    async function skipLastOwner(person: CognitoPerson, before: Record<string, unknown>): Promise<SweepSkip> {
      const skip: SweepSkip = {
        sub: person.sub,
        reason: 'last-owner',
        warningDue: lastOwnerWarningDue(person.createdAt, nowMs, deps.reminderWindowMs),
        warned: [],
        problems: [],
      };
      if (!skip.warningDue) return skip;
      const calls: string[] = [];
      const w = deps.ownerWarnings;
      if (!w) {
        skip.problems.push('No owner warning is configured (ownerWarnings), so nobody was told.');
      } else {
        const recipients: { email: string; kind: SweepWarningRecipient }[] = [
          { email: person.email, kind: 'owner' },
          ...(w.fallbackEmail ? [{ email: w.fallbackEmail, kind: 'fallback' as const }] : []),
        ];
        // One message per recipient, so a bad owner address (a likely reason the invite went unused)
        // can't stop the fallback copy.
        for (const to of recipients) {
          const label = `Warning to the ${to.kind === 'owner' ? 'owner' : 'fallback address'}`;
          if (!to.email) {
            calls.push(`${label}: not sent (no address)`);
            skip.problems.push('The owner has no email address to warn.');
            continue;
          }
          try {
            await w.notifier.ownerInviteUnused({
              siteName: w.siteName,
              owner: { sub: person.sub, email: person.email, ...(person.name !== undefined && { name: person.name }) },
              to,
              invitedAt: person.createdAt,
              expiredAt: inviteExpiresAt(person.createdAt),
              ...(w.signInUrl !== undefined && { signInUrl: w.signInUrl }),
              at: new Date(nowMs),
            });
            calls.push(`${label}: ok`);
            skip.warned.push(to.kind);
          } catch (error) {
            calls.push(`${label}: failed (${(error as { name?: string }).name ?? 'Error'})`);
            skip.problems.push(`Couldn't warn the ${to.kind === 'owner' ? 'owner' : 'fallback address'}: ${describeAwsError(error)}`);
          }
        }
      }
      try {
        await refuse(person, before, `last_owner: ${LAST_OWNER_SKIP_MESSAGE}`, calls);
      } catch (error) {
        skip.problems.push(`Couldn't log the skip: ${describeAwsError(error)}`);
      }
      return skip;
    }

    for (const person of due) {
      let held: string[];
      try {
        held = await deps.cognito.groupsOf(person.username);
      } catch (error) {
        // Without their roles there's no telling whether they're the last owner: fail closed.
        result.failed.push({
          sub: person.sub,
          error: `Couldn't read their roles, so couldn't rule out that they're the site's last owner; not disabled. ${describeAwsError(error)}`,
        });
        continue;
      }
      const isOwner = held.includes(OWNER_GROUP);
      // The roles a disable removes: every admin role, and the owner role whichever group holds it.
      const groups: string[] = [...new Set<string>([...(isOwner ? [OWNER_GROUP] : []), ...adminGroupsOf(held)])];
      const before = { enabled: true, invite: 'expired', createdAt: isoOrNull(person.createdAt), groups };

      if (isOwner) {
        const ownerBefore = { adminRole: OWNER_GROUP, ...before };
        let others: number;
        try {
          // Read live for each owner, so the window for a concurrent change stays as small as it can.
          others = (await deps.cognito.listGroupMembers(OWNER_GROUP)).filter(
            (o) => o.enabled && o.sub !== person.sub && !attempted.has(o.sub),
          ).length;
        } catch (error) {
          await refuse(person, ownerBefore, `owner_count_unknown: ${OWNER_COUNT_UNKNOWN_MESSAGE}`).catch(() => undefined);
          result.failed.push({ sub: person.sub, error: `${OWNER_COUNT_UNKNOWN_MESSAGE} ${describeAwsError(error)}` });
          continue;
        }
        if (others === 0) {
          result.skipped.push(await skipLastOwner(person, ownerBefore));
          continue;
        }
      }

      attempted.add(person.sub);
      const run = await runAudited(
        deps.auditLog,
        {
          intent: {
            actor,
            action: PEOPLE_AUDIT_ACTIONS.expireInvite,
            target: { sub: person.sub, email: person.email },
            before,
            after: { enabled: false, groups: [] },
            reason,
            calls: ['AdminDisableUser', ...groups.map((g) => `AdminRemoveUserFromGroup ${g}`)],
            ...context,
          },
          run: async (steps) => {
            await steps.call('AdminDisableUser', () => deps.cognito.disable(person.username));
            for (const g of groups) await steps.call(`AdminRemoveUserFromGroup ${g}`, () => deps.cognito.removeFromGroup(person.username, g));
            return { value: undefined };
          },
        },
        deps.sleep ? { sleep: deps.sleep } : {},
      );
      if (run.kind === 'done') result.disabled.push(person.sub);
      else if (run.kind === 'failed' && run.changed) result.disabled.push(person.sub);
      if (run.kind === 'not-started') result.failed.push({ sub: person.sub, error: "Couldn't write the audit log; not disabled." });
      else if (run.kind === 'failed') result.failed.push({ sub: person.sub, error: describeAwsError(run.error) });
    }
    return result;
  };
}

export interface InviteExpirySweepOptions {
  userPoolId: string;
  region?: string;
  auditLog: AuditLogStore;
  inviteMode?: InviteMode;
  /**
   * Warns the site's last owner (and `fallbackEmail`) when their invite is unused past 7 days, which
   * the sweep never disables. Without it, a skipped last owner is reported as a problem instead.
   */
  ownerWarnings?: OwnerWarningOptions;
  /**
   * How often this sweep runs, in minutes. With it, a skipped last owner is warned, and the skip
   * logged, on the first run after their invite expired and then once a day; without it, every run.
   */
  runEveryMinutes?: number;
  cognito?: CognitoIdentityProviderClient;
  quota?: QuotaLimiterOptions;
  maxPeople?: number;
  now?: () => number;
  sleep?: Sleep;
}

/** The Region in a user pool ID (`us-east-1_AbCdEf123` → `us-east-1`), or undefined. */
export function regionOfUserPool(userPoolId: string): string | undefined {
  return /^([a-z]{2}(?:-[a-z]+)+-\d+)_[A-Za-z0-9]+$/.exec(userPoolId)?.[1];
}

/**
 * The scheduled invite-expiry sweep, for a job with no signed-in person. `InviteExpirySweep` (from
 * `auth-kit/admin/cdk`) deploys it: EventBridge Scheduler → a Lambda with only the calls it makes.
 * Disables every unaccepted invite older than 7 days and removes its admin roles, logging each as
 * `people.expireInvite` by the `system:invite-expiry` actor, except the site's last owner, whom it
 * skips and warns.
 */
export function createInviteExpirySweep(options: InviteExpirySweepOptions): () => Promise<SweepResult> {
  const region = options.region ?? regionOfUserPool(options.userPoolId);
  if (!region) throw new Error(`auth-kit: userPoolId "${options.userPoolId}" isn't a Cognito user pool ID.`);
  const every = options.runEveryMinutes;
  if (every !== undefined && (!Number.isInteger(every) || every < 1)) throw new Error('auth-kit: runEveryMinutes must be a whole number of at least 1.');
  if (options.ownerWarnings && !options.ownerWarnings.siteName) throw new Error('auth-kit: ownerWarnings needs a siteName.');
  const client = options.cognito ?? new CognitoIdentityProviderClient({ region, maxAttempts: 1 });
  const limiter = createQuotaLimiter({ ...(options.sleep !== undefined && { sleep: options.sleep }), ...options.quota });
  const run = sweepFor({
    cognito: new CognitoAdmin(client, options.userPoolId, limiter),
    auditLog: options.auditLog,
    mode: options.inviteMode ?? 'emailed-code',
    now: options.now ?? Date.now,
    maxPeople: options.maxPeople ?? ADMIN_POLICY.maxPeople,
    ...(options.ownerWarnings !== undefined && { ownerWarnings: options.ownerWarnings }),
    ...(every !== undefined && { reminderWindowMs: every * 60 * 1000 }),
    ...(options.sleep !== undefined && { sleep: options.sleep }),
  });
  return () => run(INVITE_EXPIRY_ACTOR, { requestId: globalThis.crypto.randomUUID() });
}
