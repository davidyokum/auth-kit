# 0001. Passkey first, then password + authenticator, then emailed code

- **Status:** Accepted, 2026-10-17; verified on a live pool 2026-10-17 (below); amended 2026-10-18 (admins, below)
- **Standard:** 03 §2 Sign-in; primer §4

## Context

Sites need a sign-in that resists phishing, works in one click with a password manager, and still lets someone in after an invite, a lost device, or on a borrowed computer. An emailed code at every sign-in is easy to build but sends people to their inbox each time, and a code or password can be relayed by a fake page.

## Decision

The pool offers three first factors, best first:

1. **Passkey** (`WEB_AUTHN`) with user verification required and `FactorConfiguration = MULTI_FACTOR_WITH_USER_VERIFICATION`, so one passkey sign-in counts as two factors. Its relying-party ID is the site's final domain, so passkeys switch on (`passkeys` option) once the custom domain is live.
2. **Password** (`PASSWORD`, at least 15 characters, no composition rules) plus an authenticator code, both filled by a password manager.
3. **Emailed code** (`EMAIL_OTP`) as the backstop for joining, recovery, and a device without the manager.

The app client allows only `ALLOW_USER_AUTH` (choice-based sign-in, which covers all three, plain and SRP passwords included) and `ALLOW_REFRESH_TOKEN_AUTH`.

## Consequences

- The pool must be on the Essentials plan (choice-based sign-in, emailed codes, and passkeys require it) and send email through SES.
- Passwords stay on, so they get rules, a breached-password check (Plus on Tier 3; a Have I Been Pwned check is phase 2 for Tier 2), and the app-enforced authenticator ([0002](0002-mfa-optional-app-enforced-totp.md)).
- Changing the relying-party ID later forces everyone to register passkeys again. Cognito does accept an `amplifyapp.com` subdomain as the ID (`amplifyapp.com` itself is a public suffix), but passkeys made there won't work on the custom domain, so the standard waits for the final domain.
- `FactorConfiguration` matters for everyday pools too: AWS documents that someone with TOTP turned on can't use a passkey to sign in unless passkeys count as MFA.
- **Verified on the 2026-10-17 demo deploy:** the pool came up with `WebAuthnConfiguration.FactorConfiguration = MULTI_FACTOR_WITH_USER_VERIFICATION`, user verification `required`, and `AllowedFirstAuthFactors` `[WEB_AUTHN, PASSWORD, EMAIL_OTP]`; the app client allows exactly `ALLOW_USER_AUTH` and `ALLOW_REFRESH_TOKEN_AUTH`. Two things to know when checking a pool by hand:
  - **The AWS CLI hides `FactorConfiguration`.** `aws cognito-idp describe-user-pool` (CLI 2.33.20) omits it because the CLI's service model predates the field. The raw API response has it (run the command with `--debug` and read the response body), and so does the CloudFormation template.
  - **Allowed first factors live on the pool, not the app client.** They're `Policies.SignInPolicy.AllowedFirstAuthFactors` in `describe-user-pool`; `describe-user-pool-client` shows only the auth flows (`ALLOW_USER_AUTH`).

## Amendment, 2026-10-18: admins keep a password-plus-authenticator route (register A3)

David's decision, the evening of 2026-10-17, replacing that morning's "admin pools are passkey only".

- **Admins use passkeys day to day, and keep a password plus an authenticator code.** A strictly passkey-only admin pool isn't possible on Cognito: nobody can register a passkey before signing in once, and a pool without emailed codes needs a password to create an account (`AdminCreateUser` with a one-time password). So a new admin signs in once with the one-time password, sets their own password and an authenticator (the admin pool requires MFA, [0002](0002-mfa-optional-app-enforced-totp.md)), then saves a passkey, which is the everyday way in. The password-plus-authenticator route stays: it's not neutralized afterwards. A phished password alone fails (the authenticator is still asked); a real-time relay of both is still possible, which is why admins use the passkey.
- **A Tier 3 admin pool has no emailed codes** (`adminPool: true`: `EMAIL_OTP` is not a first factor), and recovery there is admin-only.
- **Everyday pools are unchanged**: passkey first, then a password plus an authenticator, then an emailed code as the backstop. The first-visit choice after an emailed code is required ([0023](0023-account-creation.md), [0024](0024-sign-in-copy-and-family-themes.md)): an account isn't left on emailed codes alone.
