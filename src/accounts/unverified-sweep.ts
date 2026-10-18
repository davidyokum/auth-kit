/**
 * The unverified-account sweep (register D3, ADR 0023): an account auth-kit's sign-up route made
 * whose address is never verified is deleted after 24 hours. Cognito doesn't do it, and there's
 * nothing to keep: no password, no passkey, no role, and the address never proved it's theirs.
 *
 * Modelled on the invite-expiry sweep (ADR 0019), and as careful:
 * - **Only sign-up accounts.** It deletes only accounts marked `custom:authkit_origin = signup` (set
 *   once, immutable). Admin invites carry no mark, so they never qualify: they keep the 7-day
 *   disable path (`InviteExpirySweep`).
 * - **Never anyone with a role, so never the owner.** A due account that's in any group (an admin
 *   gave it a role) is skipped, and one whose groups can't be read is skipped and reported.
 * - **Never a disabled one.** Disabling is an admin's deliberate act; deleting it would undo that.
 * - **Logged.** Each deletion is intent → `AdminDeleteUser` → result, as `system:unverified-sweep`.
 *
 * No Next.js or React: `UnverifiedAccountSweep` bundles this into a Lambda.
 */
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { type AuditLogStore, runAudited } from '../admin/audit.js';
import { ACCOUNT_AUDIT_ACTIONS, UNVERIFIED_SWEEP_ACTOR } from '../admin/audit-actions.js';
import { describeAwsError } from '../admin/aws-errors.js';
import { CognitoAdmin, type CognitoPerson } from '../admin/cognito-admin.js';
import { ADMIN_POLICY } from '../admin/policy.js';
import { type QuotaLimiterOptions, type Sleep, createQuotaLimiter } from '../admin/quota.js';
import { regionOfUserPool } from '../admin/sweep.js';
import { SIGN_UP_ORIGIN_VALUE } from '../shared/account-creation.js';
import { ACCOUNT_CREATION_POLICY } from '../shared/policy.js';

export interface UnverifiedSweepResult {
  /** Subs deleted by this run. */
  deleted: string[];
  /** Due sign-up accounts left alone on purpose: one with a role (never the owner), or a disabled one. */
  skipped: { sub: string; reason: 'has-role' | 'disabled' }[];
  /** Due accounts that couldn't be deleted (or whose roles couldn't be read), and why. */
  failed: { sub: string; error: string }[];
  /** How many accounts were checked. */
  checked: number;
  /** The pool has more accounts than `maxPeople`: the rest weren't checked. */
  truncated: boolean;
}

export interface UnverifiedSweepOptions {
  userPoolId: string;
  auditLog: AuditLogStore;
  region?: string;
  /** Inject a Cognito client (tests). */
  cognito?: CognitoIdentityProviderClient;
  /** Accounts checked per run. Default 5000. */
  maxPeople?: number;
  /** Default 24 (`ACCOUNT_CREATION_POLICY.unverifiedAccountHours`). Not shorter than an hour. */
  olderThanHours?: number;
  quota?: QuotaLimiterOptions;
  now?: () => number;
  sleep?: Sleep;
}

/** True when a sign-up account is old enough and still unverified (the roles are checked separately). */
export function unverifiedSignUpDue(person: CognitoPerson, nowMs: number, olderThanHours: number = ACCOUNT_CREATION_POLICY.unverifiedAccountHours): boolean {
  if (person.origin !== SIGN_UP_ORIGIN_VALUE || person.emailVerified) return false;
  const created = person.createdAt.getTime();
  // An unreadable creation date isn't proof of age: leave it (the next run tries again).
  return Number.isFinite(created) && nowMs - created >= olderThanHours * 60 * 60 * 1000;
}

export function createUnverifiedAccountSweep(options: UnverifiedSweepOptions): () => Promise<UnverifiedSweepResult> {
  const region = options.region ?? regionOfUserPool(options.userPoolId);
  if (!region) throw new Error(`auth-kit: userPoolId "${options.userPoolId}" isn't a Cognito user pool ID.`);
  const hours = options.olderThanHours ?? ACCOUNT_CREATION_POLICY.unverifiedAccountHours;
  if (!(hours >= 1)) throw new Error('auth-kit: olderThanHours must be at least 1.');
  const client = options.cognito ?? new CognitoIdentityProviderClient({ region, maxAttempts: 1 });
  const cognito = new CognitoAdmin(client, options.userPoolId, createQuotaLimiter({ ...(options.sleep !== undefined && { sleep: options.sleep }), ...options.quota }), { signUpOrigin: true });
  const now = options.now ?? Date.now;
  const maxPeople = options.maxPeople ?? ADMIN_POLICY.maxPeople;

  return async () => {
    const { users, truncated } = await cognito.listUsers(maxPeople);
    const nowMs = now();
    const result: UnverifiedSweepResult = { deleted: [], skipped: [], failed: [], checked: users.length, truncated };
    const requestId = globalThis.crypto.randomUUID();
    for (const person of users.filter((u) => unverifiedSignUpDue(u, nowMs, hours))) {
      if (!person.enabled) {
        result.skipped.push({ sub: person.sub, reason: 'disabled' });
        continue;
      }
      let groups: string[];
      try {
        groups = await cognito.groupsOf(person.username);
      } catch (error) {
        result.failed.push({ sub: person.sub, error: `Couldn't read its roles, so it wasn't deleted: ${describeAwsError(error)}` });
        continue;
      }
      if (groups.length > 0) {
        // Someone gave it a role (the owner role included): an admin's decision, not a stray sign-up.
        result.skipped.push({ sub: person.sub, reason: 'has-role' });
        continue;
      }
      const run = await runAudited(
        options.auditLog,
        {
          intent: {
            actor: UNVERIFIED_SWEEP_ACTOR,
            action: ACCOUNT_AUDIT_ACTIONS.deleteUnverified,
            target: { sub: person.sub, email: person.email },
            before: { email: person.email, origin: SIGN_UP_ORIGIN_VALUE, status: 'unverified', createdAt: person.createdAt.toISOString() },
            after: null,
            reason: `Address never verified within ${hours} hours of signing up`,
            calls: ['AdminDeleteUser'],
            requestId,
          },
          run: async (steps) => {
            await steps.call('AdminDeleteUser', () => cognito.deleteUser(person.username));
            return { value: undefined };
          },
        },
        options.sleep ? { sleep: options.sleep } : {},
      );
      if (run.kind === 'done') result.deleted.push(person.sub);
      else result.failed.push({ sub: person.sub, error: run.kind === 'not-started' ? `The audit row couldn't be written, so it wasn't deleted: ${describeAwsError(run.error)}` : describeAwsError(run.error) });
    }
    return result;
  };
}
