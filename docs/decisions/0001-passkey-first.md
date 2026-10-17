# 0001. Passkey first, then password + authenticator, then emailed code

- **Status:** Accepted, 2026-10-17
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
