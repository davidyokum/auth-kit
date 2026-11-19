# 0002. MFA optional in the pool; the app requires TOTP of password users

- **Status:** Accepted, 2026-10-17; amended 2026-10-18 (admins, below), 2026-10-19 (no opt-out on a site), and 2026-11-19 (no password without an authenticator, and no cached unfinished setup)
- **Standard:** 03 §2 Sign-in; primer §4 "Requiring the authenticator"

## Context

The standard wants every password user to have an authenticator code. Cognito sets MFA once per pool (off, optional, or required), not per sign-in method, and AWS documents that a pool that requires MFA can't offer emailed codes as a first factor. Requiring MFA would remove the emailed-code backstop that makes no-password invites work.

## Decision

- Everyday pools: `MfaConfiguration = OPTIONAL`, with TOTP (`SOFTWARE_TOKEN_MFA`) as the only MFA method.
- The app closes the gap. `requireUser()` asks Cognito for the person's factors (`GetUserAuthFactors` with their own access token, or `AdminGetUserAuthFactors` with IAM) and refuses anyone who has a password but no TOTP with 403 `mfa_enrollment_required`. The authenticator setup page passes `allowMfaEnrollment: true`; phase 2's client shows only that page until setup is done.
- A passing answer is cached per access token (`jti`) for 5 minutes. A failing one isn't cached (amended 2026-11-19; it was 30 seconds), so a setup finished a moment ago counts on the next request.
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

## Amendment, 2026-11-19: no password without an authenticator, and no cached unfinished setup

A real first sign-in on a deployed 0.1.19 site ended in a loop. Three things let it happen:

- **The password was saved first.** `ChooseFirstCredential` and My account saved a first password, then asked for the authenticator. Stopping in between (a reload, a link, a change of mind) left a password without an authenticator, and this ADR's rule then sent every page to authenticator setup.
- **Each setup screen asked Cognito for a new key.** `setUpTOTP` (AssociateSoftwareToken) replaces the account's pending key. A second setup screen after a redirect replaced the key the person had just scanned, so their app's codes never matched.
- **"Still to set up" was cached for 30 seconds per token.** A passkey saved on the chooser didn't count until the cache ran out, because `registerPasskey` didn't refresh the token either.

Decision:

- **The order is: check the code, save the password, turn the authenticator on.** The screens hold a first password until `verifyTOTPSetup` accepts the code, then save it, then call `updateMFAPreference` (twice if the first try fails). Checking a code ties the key to the account but changes nothing else: sign-in doesn't ask for it, and emailed codes keep working. So stopping at any point before the password is saved leaves the account as it was. The order is deliberately not "turn the authenticator on, then save the password": once the authenticator is on, Cognito stops offering emailed-code sign-in, so an account whose password then failed to save would have neither, and no way in once its session ended. The one remaining gap is `updateMFAPreference` failing twice right after the password saved: the screen then offers "Try again" (no new code needed), and the setup page below still works.
- **The setup key is kept per account per tab** (sessionStorage, 30 minutes, removed once the authenticator is on). Every setup screen shows it; only "Get a new QR code" asks for another. Script on the site's origin could already read the token cookies and call `setUpTOTP`, so keeping the key there exposes nothing new.
- **Only "nothing to set up" is cached.** An unfinished setup is read from Cognito on every request (one `GetUserAuthFactors` per request while someone is setting up). `registerPasskey` also refreshes the token, as the password and authenticator steps already did.
- **The setup page always has a way out.** The template's `/account/authenticator` is a sign-in screen (the card on the backdrop, no site header) with "Sign out everywhere". The rule itself stays: an account with a password and no authenticator, however it got there, is sent to set one up.

To confirm on a sandbox: after `verifyTOTPSetup` and before `updateMFAPreference`, `GetUserAuthFactors` doesn't list `SOFTWARE_TOKEN_MFA` and an emailed code still signs in.
