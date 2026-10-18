/**
 * The invite flow's account steps, shared by the People page's invite and a Manager's invite to one
 * item (`auth-kit/resources`): create the account with no password and no `email_verified`, refuse
 * a pool that can't do no-password invites, and send the branded email. Each runs as a recorded step
 * of an audited change. Internal: not a public export.
 */
import type { ChangeSteps } from './audit.js';
import type { CognitoAdmin, CognitoPerson } from './cognito-admin.js';
import type { InviteMode } from './guardrails.js';
import type { InviteEmail, InviteMailer } from './mailer.js';

export class InviteMisconfiguredError extends Error {
  constructor() {
    super(
      'This pool gave the new account a password, so it doesn’t offer emailed codes: a no-password invite can’t work here. Use inviteMode "temporary-password" (the admin pool) or turn on emailed codes.',
    );
    this.name = 'InviteMisconfiguredError';
  }
}

/**
 * `AdminCreateUser` for an invite, as one step. In `emailed-code` mode a pool that still gave the
 * account a password can't sign it in with a code: the account is deleted again and the invite
 * refused (`InviteMisconfiguredError`).
 */
export async function createInvitedAccount(
  steps: ChangeSteps,
  cognito: CognitoAdmin,
  input: { email: string; name?: string; mode: InviteMode },
): Promise<CognitoPerson> {
  const created = await steps.call('AdminCreateUser', () => cognito.createInvitedUser(input));
  if (input.mode === 'emailed-code' && created.status === 'FORCE_CHANGE_PASSWORD') {
    await steps.rollback('AdminDeleteUser', () => cognito.deleteUser(created.username));
    throw new InviteMisconfiguredError();
  }
  return created;
}

/** The branded invite email, as one step (`emailed-code` mode; Cognito's own is suppressed). */
export async function sendInviteEmail(steps: ChangeSteps, mailer: InviteMailer, input: InviteEmail): Promise<void> {
  await steps.call('SES SendEmail', () => mailer.sendInvite(input));
}
