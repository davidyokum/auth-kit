/** The environment variables `InviteExpirySweep` sets on its function and the handler reads. */
export const INVITE_EXPIRY_ENV = {
  userPoolId: 'AUTH_KIT_USER_POOL_ID',
  auditTable: 'AUTH_KIT_AUDIT_TABLE',
  inviteMode: 'AUTH_KIT_INVITE_MODE',
  maxPeople: 'AUTH_KIT_MAX_PEOPLE',
} as const;
