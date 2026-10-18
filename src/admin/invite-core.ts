/**
 * The invite flow's account steps, shared by every way auth-kit brings someone new in: the People
 * page's invite (`people.invite`), a Manager's invite to one item (`auth-kit/resources`), and any
 * later account-creation flow. Internal to the package: not a public export.
 *
 * What these do, and what they leave to the caller:
 *
 * - `createInvitedAccount`: `AdminCreateUser` with **no password and no `email_verified`** (the
 *   "invited, not signed in" signal the expiry sweep relies on), the pool's invite mode respected
 *   (`emailed-code`: Cognito's own message suppressed, the app sends the branded email;
 *   `temporary-password`: Cognito emails a one-time password the app never sees). In `emailed-code`
 *   mode a pool that still gave the account a password can't sign it in with a code, so the account
 *   is deleted again and `InviteMisconfiguredError` thrown.
 * - `removeInvitedAccount`: the undo, for a later step that failed (a group, a membership, an alert,
 *   the email). It never throws; it resolves false when the undo itself failed, so the caller can say
 *   honestly that the account may still exist.
 * - `sendInviteEmail`: the branded email (`emailed-code` mode only). It never contains a password or
 *   a code.
 * - **Not here**, because each flow decides them: who may invite (capability, item access), the
 *   role or group given, memberships, alerts, input checks, and the existing-account check.
 *
 * Each runs as one recorded step of an audited change (`runAudited`, ADR 0010), so the result row
 * lists exactly which calls ran. Plan the intent row's `calls` with `INVITE_CALLS` so the planned and
 * the recorded labels agree. A flow, in order:
 *
 * ```ts
 * const run = await runAudited(auditLog, {
 *   intent: { actor, action: 'people.invite', target: { email }, calls: [INVITE_CALLS.createAccount, …, INVITE_CALLS.sendEmail] },
 *   run: async (steps) => {
 *     const account = await createInvitedAccount(steps, cognito, { email, name, mode });
 *     try {
 *       await steps.call('AdminAddUserToGroup …', () => …); // this flow's own step
 *     } catch (error) {
 *       await removeInvitedAccount(steps, cognito, account); // a half-made invite is worse than none
 *       throw error;
 *     }
 *     if (mode === 'emailed-code') await sendInviteEmail(steps, mailer, { email, name, siteName, signInUrl, expiresAt: inviteExpiresAt(account.createdAt) });
 *     return { value: account, target: { sub: account.sub, email } };
 *   },
 * });
 * ```
 */
import type { ChangeSteps } from './audit.js';
import type { CognitoAdmin, CognitoPerson } from './cognito-admin.js';
import type { InviteMode } from './guardrails.js';
import type { InviteEmail, InviteMailer } from './mailer.js';

/** The labels these steps record in the audit row's `calls` (plan the intent's `calls` with them). */
export const INVITE_CALLS = {
  createAccount: 'AdminCreateUser',
  removeAccount: 'AdminDeleteUser',
  sendEmail: 'SES SendEmail',
} as const;

/** The pool gave a no-password invite a password: it can't sign in with an emailed code. Nothing stands. */
export class InviteMisconfiguredError extends Error {
  constructor() {
    super(
      'This pool gave the new account a password, so it doesn’t offer emailed codes: a no-password invite can’t work here. Use inviteMode "temporary-password" (the admin pool) or turn on emailed codes.',
    );
    this.name = 'InviteMisconfiguredError';
  }
}

export interface InvitedAccountInput {
  /** Already checked and lowercased by the caller. It becomes the username (email-as-username pools). */
  email: string;
  /** Display name, already checked by the caller. */
  name?: string;
  mode: InviteMode;
  /** `signup`: the sign-up route's self-invite (ADR 0023), marked so the sweep and triggers can tell. */
  origin?: 'signup';
}

/**
 * `AdminCreateUser` for an invite, as one step: no password, no `email_verified`, no group. Throws
 * the call's error (nothing was created), or `InviteMisconfiguredError` after deleting the account.
 */
export async function createInvitedAccount(steps: ChangeSteps, cognito: CognitoAdmin, input: InvitedAccountInput): Promise<CognitoPerson> {
  const created = await steps.call(INVITE_CALLS.createAccount, () => cognito.createInvitedUser(input));
  if (input.mode === 'emailed-code' && created.status === 'FORCE_CHANGE_PASSWORD') {
    await removeInvitedAccount(steps, cognito, created);
    throw new InviteMisconfiguredError();
  }
  return created;
}

/**
 * Deletes an account `createInvitedAccount` just made, as a rollback step (the change's outcome then
 * reads "failed, nothing changed" when every undo succeeded). Never throws: resolves false when the
 * delete failed, and the audit row records it.
 */
export function removeInvitedAccount(steps: ChangeSteps, cognito: CognitoAdmin, account: Pick<CognitoPerson, 'username'>): Promise<boolean> {
  return steps.rollback(INVITE_CALLS.removeAccount, () => cognito.deleteUser(account.username));
}

/** The branded invite email, as one step (`emailed-code` mode; Cognito's own is suppressed). Throws the mailer's error. */
export async function sendInviteEmail(steps: ChangeSteps, mailer: InviteMailer, input: InviteEmail): Promise<void> {
  await steps.call(INVITE_CALLS.sendEmail, () => mailer.sendInvite(input));
}
