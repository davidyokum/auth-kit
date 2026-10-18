/** The environment variables the account-creation jobs' constructs set and their handlers read. */
export const UNVERIFIED_SWEEP_ENV = {
  userPoolId: 'AUTH_KIT_USER_POOL_ID',
  auditTable: 'AUTH_KIT_AUDIT_TABLE',
  maxPeople: 'AUTH_KIT_MAX_PEOPLE',
  olderThanHours: 'AUTH_KIT_UNVERIFIED_HOURS',
} as const;

export const ACCESS_REQUEST_DIGEST_ENV = {
  userPoolId: 'AUTH_KIT_USER_POOL_ID',
  requestTable: 'AUTH_KIT_REQUEST_TABLE',
  settingsTable: 'AUTH_KIT_SETTINGS_TABLE',
  siteName: 'AUTH_KIT_SITE_NAME',
  family: 'AUTH_KIT_FAMILY',
  signInUrl: 'AUTH_KIT_SIGN_IN_URL',
  peopleUrl: 'AUTH_KIT_PEOPLE_URL',
  helpEmail: 'AUTH_KIT_HELP_EMAIL',
  mailFrom: 'AUTH_KIT_MAIL_FROM',
  mailConfigurationSet: 'AUTH_KIT_MAIL_CONFIGURATION_SET',
  recipientGroups: 'AUTH_KIT_RECIPIENT_GROUPS',
} as const;
