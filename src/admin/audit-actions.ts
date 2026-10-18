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
