/** The environment variables `InviteExpirySweep` sets on its function and the handler reads. */
export const INVITE_EXPIRY_ENV = {
  userPoolId: 'AUTH_KIT_USER_POOL_ID',
  auditTable: 'AUTH_KIT_AUDIT_TABLE',
  inviteMode: 'AUTH_KIT_INVITE_MODE',
  maxPeople: 'AUTH_KIT_MAX_PEOPLE',
  /** Minutes between runs (rate schedules), so last-owner warnings go out once a day. */
  runEveryMinutes: 'AUTH_KIT_RUN_EVERY_MINUTES',
  /** The last-owner warning (`ownerWarnings`): the site's name, the SES sender, and the rest. */
  siteName: 'AUTH_KIT_SITE_NAME',
  mailFrom: 'AUTH_KIT_MAIL_FROM',
  signInUrl: 'AUTH_KIT_SIGN_IN_URL',
  ownerWarningFallback: 'AUTH_KIT_OWNER_WARNING_FALLBACK',
  mailConfigurationSet: 'AUTH_KIT_MAIL_CONFIGURATION_SET',
} as const;
