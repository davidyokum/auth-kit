# Changelog

All notable changes to auth-kit. Versions follow [Semantic Versioning](https://semver.org/); `0.x` releases may change APIs between minor versions.

## [Unreleased]

### Added

- `auth-kit/client` (phase 2): `SignIn` (passkey first, password + TOTP, emailed code; every challenge the standard's pools return; step-up), `ChooseFirstCredential` (first sign-in after an invite), `AuthenticatorSetup`, `TOTPEnrollmentGate`, `MyAccount` (passkeys with a last-way-in guard, authenticator, password, sign out everywhere), `PasswordForm` with a Have I Been Pwned range check, `configureAuthClient` (token cookies expire with the refresh token), and the Amplify calls behind them as functions. Unstyled, accessible markup with `data-auth-kit` slots and `classNames`. [ADR 0008](docs/decisions/0008-client-in-the-browser.md) records where Amplify v6 differs from the standard.
- `auth-kit/dev` (phase 2): `personas.json` in the primer's shape and `parsePersonas`; `seedPersonas` and `npx auth-kit init-personas` / `seed-personas` (refuses anything but a sandbox pool, asserts the account from the pool's ARN, converges users, passwords, groups, and authenticators, idempotent, secrets only in git-ignored `.env.local`); `createDevKit` with the "Sign in as…" route (request gates including `127.0.0.1`/`[::1]` and a proxy-header gate, same-site writes, a check of the dev server's listening sockets, a cached sandbox check, 404 on every refusal, Amplify's own cookies); `withDevKit` for `next.config.ts`; `checkProductionBuild`, `checkDevRouteAbsent`, and `npx auth-kit check-prod-build` / `check-dev-route`. Personas are enrolled in TOTP so the authenticator rule holds ([ADR 0009](docs/decisions/0009-localhost-kit.md)).
- `auth-kit/dev/menu`: `PersonaMenu`, the dev-only "Sign in as…" menu.
- `auth-kit/ribbon`: `EnvironmentRibbon`, `ViewAsBanner`, `environmentMetadata`, `viewAsMetadata`, `resolveEnvironment` (safe in production builds).
- The `auth-kit` command (`bin`).

### Changed

- `auth-kit/client`: the phase-1 stubs are replaced. `SignInScreen` is now `SignIn`, `AuthenticatorEnrollmentGate` is `TOTPEnrollmentGate`, sign-in functions return a `SignInStep`, and `NotImplementedError` is no longer exported from this subpath.
- `DEV_POLICY.route` is `/api/dev/sign-in`. `personas.json` entries use `key`/`email`/`groups` instead of `role`/`appRoles`. `checkProductionBuild` returns a result instead of rejecting. `auth-kit/dev` gains a `default` export condition so `next.config.ts` can load it.

### Fixed

- `auth-kit/amplify`: the app client no longer ships Amplify's hosted-UI OAuth code flow with CDK's placeholder callback (`https://example.com`). OAuth stays on only when the site configured real callback URLs; `applyAuthStandard` reports `hostedUiOAuth`.

## [0.1.0-alpha] - 2026-10-17

First pre-release. Not yet used in production.

### Added

- `auth-kit/amplify`: `standardAuthProps` and `applyAuthStandard`, a Gen 2 preset for one pool per app. Invite-only; passkey (user verification required, counts as MFA), password (15+ characters, no composition rules), and emailed code as first factors; MFA optional with TOTP (required, with no emailed codes, for `adminPool`); access and ID tokens 60 minutes, refresh 30 days (Tier 2) or 1 day (Tier 3 and admin pools), sign-in session 3 minutes; token revocation; deletion protection; SES from a verified domain identity; standard groups plus app roles; no guest credentials; Plus threat protection on Tier 3; a WAF web ACL with per-IP sign-in and overall rate rules; sandbox detection (`Environment=sandbox` tag, `ALLOW_ADMIN_USER_PASSWORD_AUTH` on sandbox clients only, no deletion protection or web ACL by default).
- `auth-kit/amplify/pre-sign-up`: `preSignUpAllowlist`, a dependency-free preSignUp handler for domain-allowlisted self-registration.
- `auth-kit/server`: `createServerAuth` with `getUser`, `requireUser` (refuses password users without TOTP), `requireGroup`, `requireCan` (with `live` re-reads and `recentSignIn` step-up), `requireRecordAccess` (404), `verifyAccessToken`; `defineCapabilities`; `safeRedirect`; cookie, origin-check, and no-store helpers; error classes and `withAuthErrors` for the 401/403/404/503 conventions; page guards.
- `auth-kit/proxy`: `withAuthProxy` (default-deny, verifies tokens, public-route allowlist) and `amplifyAdapterRefresh`.
- `auth-kit/testing`: `assertAuthMatrix` and friends, `createTestIssuer`, `amplifyCookiePersona`, `createFakeCognito`, token forgery helpers.
- `auth-kit/admin`: People-page guardrails (`checkPeopleAction`, `grantableRoles`, `inviteStatus`) and typed stubs for the actions and the append-only audit log.
- `auth-kit/dev`: dev sign-in gates, `assertSandboxPool`, persona validation, the ribbon model, and typed stubs for seeding, the sign-in exchange, the ribbon component, and the production-build check.
- `auth-kit/client`: autocomplete tokens, `afterSignInStep`, and typed stubs for the sign-in screens and My account.
- Decision records, CI (typecheck, lint, test, build on Node 22 and 24).

[0.1.0-alpha]: https://github.com/davidyokum/auth-kit/releases/tag/v0.1.0-alpha
