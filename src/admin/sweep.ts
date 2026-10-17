/**
 * The invite-expiry sweep (03 §2 "An invite with no sign-in after 7 days is disabled"): every
 * unaccepted invite older than 7 days is disabled and loses its admin roles, each logged intent →
 * calls → result. Run by an admin (`people.expireStaleInvites`) or on a schedule with no signed-in
 * person (`createInviteExpirySweep`, which `InviteExpirySweep` in `auth-kit/admin/cdk` deploys).
 *
 * Kept apart from the People module so the scheduled Lambda's bundle holds only the AWS SDK clients
 * it calls: no Next.js, no React.
 */
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { INVITE_EXPIRY_DAYS } from '../shared/policy.js';
import { type AuditLogStore, runAudited } from './audit.js';
import { PEOPLE_AUDIT_ACTIONS } from './audit-actions.js';
import { describeAwsError } from './aws-errors.js';
import { CognitoAdmin } from './cognito-admin.js';
import { type InviteMode, adminGroupsOf, inviteStatus } from './guardrails.js';
import { ADMIN_POLICY } from './policy.js';
import { type QuotaLimiterOptions, type Sleep, createQuotaLimiter } from './quota.js';
import type { AuditActor, AuditRequestContext } from './types.js';

export interface SweepResult {
  /** Subs of invites disabled by this run. */
  disabled: string[];
  /** Invites that were due but couldn't be disabled (and why). */
  failed: { sub: string; error: string }[];
  /** How many accounts were checked. */
  checked: number;
  /** The pool has more accounts than `maxPeople`: the rest weren't checked. */
  truncated: boolean;
}

/** The system actor scheduled sweeps write audit rows as. */
export const INVITE_EXPIRY_ACTOR: AuditActor = Object.freeze({ sub: 'system:invite-expiry', kind: 'system' });

export function sweepFor(deps: {
  cognito: CognitoAdmin;
  auditLog: AuditLogStore;
  mode: InviteMode;
  now: () => number;
  maxPeople: number;
  sleep?: Sleep;
}) {
  return async (actor: AuditActor, request: AuditRequestContext): Promise<SweepResult> => {
    const { users, truncated } = await deps.cognito.listUsers(deps.maxPeople);
    const today = new Date(deps.now());
    const due = users.filter((u) => inviteStatus(u, today, { mode: deps.mode }) === 'expired');
    const result: SweepResult = { disabled: [], failed: [], checked: users.length, truncated };
    for (const person of due) {
      const groups = adminGroupsOf(await deps.cognito.groupsOf(person.username).catch(() => [] as string[]));
      const run = await runAudited(
        deps.auditLog,
        {
          intent: {
            actor,
            action: PEOPLE_AUDIT_ACTIONS.expireInvite,
            target: { sub: person.sub, email: person.email },
            before: { enabled: true, invite: 'expired', createdAt: person.createdAt.toISOString(), groups },
            after: { enabled: false, groups: [] },
            reason: `Invite unused for ${INVITE_EXPIRY_DAYS} days`,
            calls: ['AdminDisableUser', ...groups.map((g) => `AdminRemoveUserFromGroup ${g}`)],
            ...(request.requestId !== undefined && { requestId: request.requestId }),
            context: { ...(request.ip && { ip: request.ip }), ...(request.userAgent && { userAgent: request.userAgent }) },
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
 * `people.expireInvite` by the `system:invite-expiry` actor.
 */
export function createInviteExpirySweep(options: InviteExpirySweepOptions): () => Promise<SweepResult> {
  const region = options.region ?? regionOfUserPool(options.userPoolId);
  if (!region) throw new Error(`auth-kit: userPoolId "${options.userPoolId}" isn't a Cognito user pool ID.`);
  const client = options.cognito ?? new CognitoIdentityProviderClient({ region, maxAttempts: 1 });
  const limiter = createQuotaLimiter({ ...(options.sleep !== undefined && { sleep: options.sleep }), ...options.quota });
  const run = sweepFor({
    cognito: new CognitoAdmin(client, options.userPoolId, limiter),
    auditLog: options.auditLog,
    mode: options.inviteMode ?? 'emailed-code',
    now: options.now ?? Date.now,
    maxPeople: options.maxPeople ?? ADMIN_POLICY.maxPeople,
    ...(options.sleep !== undefined && { sleep: options.sleep }),
  });
  return () => run(INVITE_EXPIRY_ACTOR, { requestId: globalThis.crypto.randomUUID() });
}
