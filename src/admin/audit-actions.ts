/** The audit `action` each People action writes (the invite-expiry sweep writes `expireInvite`). */
export const PEOPLE_AUDIT_ACTIONS = {
  invite: 'people.invite',
  resend: 'people.resend',
  changeRole: 'people.changeRole',
  transferOwnership: 'people.transferOwnership',
  disable: 'people.disable',
  enable: 'people.enable',
  signOutEverywhere: 'people.signOutEverywhere',
  delete: 'people.delete',
  expireInvite: 'people.expireInvite',
} as const;

/**
 * Account creation and self-service (ADR 0023) and site settings (ADR 0024). Sign-ups are logged as
 * the `system:sign-up` actor (there's no signed-in person yet), the unverified-account sweep as
 * `system:unverified-sweep`; a member's own delete and email change as themselves.
 */
export const ACCOUNT_AUDIT_ACTIONS = {
  signUp: 'accounts.signUp',
  deleteUnverified: 'accounts.deleteUnverified',
  approveRequest: 'people.approveRequest',
  declineRequest: 'people.declineRequest',
  deleteOwnAccount: 'account.delete',
  requestOwnEmailChange: 'account.requestEmailChange',
  changeOwnEmail: 'account.changeEmail',
  signInHelp: 'settings.signInHelp',
} as const;

/** The system actors account creation writes as. */
export const SIGN_UP_ACTOR = Object.freeze({ sub: 'system:sign-up', kind: 'system' as const });
export const UNVERIFIED_SWEEP_ACTOR = Object.freeze({ sub: 'system:unverified-sweep', kind: 'system' as const });
