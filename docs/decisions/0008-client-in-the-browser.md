# 0008. The client runs in the browser and fills Amplify v6's gaps with two direct Cognito calls

- **Status:** Accepted, 2026-10-17
- **Standard:** 03 §2 Sign-in, Sessions; primer §4, §5, §8

## Context

`auth-kit/client` builds the sign-in screens and My account on Amplify JS v6 (`aws-amplify/auth`), as the standard asks. Checked against `@aws-amplify/auth` 6.21.2 (shipped with `aws-amplify` 6.22.2) and AWS's documentation, four things don't line up with the standard's wording:

1. **Passkey autofill.** The primer says `autocomplete="username webauthn"` "also offers saved passkeys" in the email field. Browsers do that only while a conditional `navigator.credentials.get({ mediation: 'conditional' })` is waiting, which needs a WebAuthn challenge before anyone types. Cognito issues one only for a named user ("Users must provide a username before Amazon Cognito can initiate passkey authentication"), and Amplify's `getPasskey` calls `navigator.credentials.get({ publicKey })` with no mediation option.
2. **The first password after an invite.** Cognito's `ChangePassword` accepts no `PreviousPassword` for an account that has none, which is how the standard sets a password after an emailed-code invite. Amplify's `updatePassword` asserts a non-empty `oldPassword`.
3. **The person's factors.** The after-sign-in decision, the authenticator gate, and "don't remove the last way in" need `GetUserAuthFactors`. Amplify has no wrapper (`fetchMFAPreference` reports MFA only, not whether a password exists).
4. **Cookie lifetime.** With `ssr: true`, Amplify writes token cookies from the browser with its `CookieStorage` default of 365 days, longer than the refresh token. Only server-written cookies get the adapter's `maxAge`.

Also observed: Amplify's step names differ from Cognito's challenge names (`SELECT_CHALLENGE` is `CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION`, and so on; the table is in `src/client/steps.ts`), `signIn` refuses to start while a session exists, its default flow is SRP (which the standard's app client doesn't allow), `getSetupUri` doesn't encode its inputs and labels the account with the Cognito username (a UUID), and `associateWebAuthnCredential` takes no name.

## Decision

- Everything in `auth-kit/client` runs in the browser (`'use client'`): Amplify's auth calls go straight to Cognito, and WebAuthn needs the browser. No server actions: the server's part is unchanged (`requireUser` and the page guards enforce the authenticator rule on every request), and calling Cognito from the browser counts toward WAF from the person's address, not the server's.
- Passkey first means the passkey is the primary button once the email is filled. The email field keeps `username webauthn` (it lets a password manager fill the email, and costs nothing); auth-kit doesn't fake autofill with a second prompt.
- `GetUserAuthFactors` and the no-previous-password `ChangePassword` are made directly, the way Amplify makes its own calls: a JSON POST to the pool's regional endpoint (or Amplify's configured `userPoolEndpoint`), authorized by the access token from `fetchAuthSession`. Errors carry Cognito's exception name, so one message table covers both.
- `configureAuthClient(outputs, { refreshTokenMinutes })` calls `Amplify.configure(outputs, { ssr: true })`, then gives the token provider a `CookieStorage` with SameSite=Lax, Secure on HTTPS, and an expiry equal to the refresh token's lifetime.
- Every sign-in passes `authFlowType: 'USER_AUTH'` with a preferred challenge. Passwords use `PASSWORD` rather than `PASSWORD_SRP`, so Cognito's compromised-credentials check (Plus) sees them.
- Step-up (`reauth`) and a sign-in on a device that already has a session end the local session (`signOut()`, not global) and start a fresh one, which also renews `auth_time`.
- New passwords are checked against Have I Been Pwned's range API before saving (only a 5-character hash prefix leaves the browser). If the check can't run, the password is allowed: the manager-generated password is the real protection, and an outage shouldn't block joining.

## Consequences

- Two hand-written Cognito calls to maintain. Revisit when Amplify wraps `GetUserAuthFactors` or accepts an empty previous password.
- The primer's passkey-autofill sentence should be corrected; revisit if Cognito adds usernameless (discoverable-credential) sign-in.
- Sites' CSP needs `connect-src` for Cognito (already true for Amplify) and `https://api.pwnedpasswords.com` unless the breach check is turned off.
- Tests mock `aws-amplify/*`; real passkey, emailed-code, and TOTP round trips are first checked on a sandbox deploy.
- AWS documents that once someone turns on an authenticator, Cognito stops offering them emailed codes; asking for one returns a choice of their other methods. That difference comes from Cognito, not the screens, which word every outcome the same way.
