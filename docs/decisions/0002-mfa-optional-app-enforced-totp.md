# 0002. MFA optional in the pool; the app requires TOTP of password users

- **Status:** Accepted, 2026-10-17; amended 2026-10-18 (admins, below) and 2026-10-19 (no opt-out on a site)
- **Standard:** 03 §2 Sign-in; primer §4 "Requiring the authenticator"

## Context

The standard wants every password user to have an authenticator code. Cognito sets MFA once per pool (off, optional, or required), not per sign-in method, and AWS documents that a pool that requires MFA can't offer emailed codes as a first factor. Requiring MFA would remove the emailed-code backstop that makes no-password invites work.

## Decision

- Everyday pools: `MfaConfiguration = OPTIONAL`, with TOTP (`SOFTWARE_TOKEN_MFA`) as the only MFA method.
- The app closes the gap. `requireUser()` asks Cognito for the person's factors (`GetUserAuthFactors` with their own access token, or `AdminGetUserAuthFactors` with IAM) and refuses anyone who has a password but no TOTP with 403 `mfa_enrollment_required`. The authenticator setup page passes `allowMfaEnrollment: true`; phase 2's client shows only that page until setup is done.
- A passing answer is cached per access token (`jti`) for 5 minutes; a failing one for 30 seconds, so a fresh token after enrollment gets through at once.
- If Cognito can't be reached, the check answers 503. It never lets the person through and never pretends they're signed out.
- Admin pools (`adminPool: true`) use `MfaConfiguration = ON` and no emailed codes.

## Consequences

- One Cognito call per person per token per 5 minutes. With the default token-based lookup, the call is a public API and counts toward the pool's WAF per-IP rule from the server's address; `factorLookup: 'iam'` avoids that but needs `cognito-idp:AdminGetUserAuthFactors` on the compute role.
- Token-based lookup also catches revoked sessions and disabled accounts within the cache window.
- AWS documents that once someone turns on TOTP, Cognito stops offering them emailed-code sign-in. Their backstop is "Forgot password" (the authenticator is still asked), and a lost authenticator needs an admin. That's why password users are also encouraged to save a passkey.
- Amplify's `defineAuth` rejects passkeys combined with MFA `REQUIRED`, so the admin pool sets `ON` through a CDK override ([0006](0006-preset-props-plus-l1-overrides.md)). Verify on the first sandbox deploy.

## Amendment, 2026-10-18: admins (register A3)

In an admin pool (`MfaConfiguration = ON`), every admin has a password and an authenticator: the password is how a new admin's first sign-in works (a one-time password; there are no emailed codes), and it stays as a second way in beside the passkey they use day to day ([0001](0001-passkey-first.md#amendment-2026-10-18-admins-keep-a-password-plus-authenticator-route-register-a3)). Nothing neutralizes it later.

## Amendment, 2026-10-19: no opt-out on a site

`createServerAuth`'s `requireTotpForPasswordUsers: false` (and `requireFirstCredential: false`, register A1) are accepted only in the auth matrix's server mode (`matrixOverrides().serverAuth`, [0016](0016-matrix-server-mode.md)), so a test can reach a persona the standard otherwise refuses. Anywhere else `createServerAuth` throws: a site can't switch the rule off.
