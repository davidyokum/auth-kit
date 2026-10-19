/**
 * Account-change notices (register A10: on by default): what the screens ask the site's notice route
 * (`createAccountNoticeRoute` in `auth-kit/accounts`) to email, and where they post by default. Pure.
 */

/** What a notice is about. */
export const ACCOUNT_NOTICE_EVENTS = ['passkey-added', 'password-changed'] as const;
export type AccountNoticeEvent = (typeof ACCOUNT_NOTICE_EVENTS)[number];

/** Where the screens post by default: mount `createAccountNoticeRoute(…).POST` at `app/api/auth-kit/account-notice/route.ts`. */
export const ACCOUNT_NOTICE_PATH = '/api/auth-kit/account-notice';
