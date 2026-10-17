# Changelog

All notable changes to auth-kit. Versions follow [Semantic Versioning](https://semver.org/); `0.x` releases may change APIs between minor versions.

## [0.1.3-alpha] - 2026-10-17

Fixes for what the first live deploy (a demo site made from [site-auth-kit-template](https://github.com/davidyokum/site-auth-kit-template)) revealed. Pre-release.

### Security

- **The sign-in screens are the same for every address until a factor is proven.** Under `PreventUserExistenceErrors` an unknown address was never offered emailed codes, while an unused invite can use only emailed codes, and `SignIn` showed Cognito's per-account answer ("Choose how to sign in" with the account's own methods; "Check your email" only when a code was sent). Now an account without the requested factor gets what an unknown address gets: a passkey prompt that finds nothing, "don't match" for a password, or "Check your email" with nothing sent, naming the typed address. **Changed:** `SignIn` has no method chooser and no longer shows Cognito's masked address. New for custom screens: `isFirstFactorUnavailable`, `decoyPasskeyPrompt`, `answerSimulatedCode`. Cognito's responses still differ on the wire; [ADR 0018](docs/decisions/0018-same-screens-for-every-address.md) says what's verified and what to check live.
- **Invite expiry is enforced.** `InviteExpirySweep` (`auth-kit/admin/cdk`): EventBridge Scheduler runs the sweep hourly in a Lambda, as `system:invite-expiry`, writing audit intent and result rows. The function's role may call only `ListUsers`, `AdminListGroupsForUser`, `AdminDisableUser`, and `AdminRemoveUserFromGroup` on its pool, `PutItem` on the audit table, and write its own log; the scheduler's role may only invoke it. Optional alarms on a failed run and a dropped invocation. Its code is a self-contained bundle in the tarball (`dist/lambda/invite-expiry/index.mjs`). [ADR 0019](docs/decisions/0019-invite-expiry-sweep.md).

### Added

- `waf.signInRule` and `waf.overallRule` (`'count'` or `'block'`) on the preset's web ACL and `createSharedAuthWebAcl`. Defaults: the sign-in rule counts, the overall rule blocks. [ADR 0017](docs/decisions/0017-per-rule-waf-modes.md).
- `AuditLogTable.grantAppend` (`PutItem` only), `inviteExpirySweepPolicy` and `INVITE_EXPIRY_COGNITO_ACTIONS`, `INVITE_EXPIRY_ACTOR`.

### Changed

- **Breaking:** `waf.action` is retired (it set both rules); it's refused with a message naming `signInRule` and `overallRule`. The preset's own web ACL now counts sign-in attempts by default instead of blocking them; set `signInRule: 'block'` after a week of counts.
- The sweep and `describeAwsError` moved to their own modules; `auth-kit/admin` exports them as before.

### Documentation

- The WAF sign-in rule's header match was verified live: Cognito forwards the bare operation name (`x-amzn-cognito-operation-name: InitiateAuth`). README "Count first, then block the sign-in rule"; ADR 0004 and 0013 amended.
- `FactorConfiguration` is hidden by the AWS CLI's `describe-user-pool` but present in the raw API response, and allowed first factors live on the pool, not the app client (ADR 0001). The README's "Verify on the first sandbox deploy" is now "Verified on a live pool, and what's left".

## [0.1.2-alpha] - 2026-10-17

Fixes for the issues found while building [site-auth-kit-template](https://github.com/davidyokum/site-auth-kit-template) (#7–#11). Pre-release.

### Security

- **`TOTPEnrollmentGate` can't mask the server's answer (#7).** It rendered only a status on the server, so around a layout's children it turned a nested page's `notFound()` 404 into a 200. Its children now always render, server and browser, inside a wrapper that's `hidden` until the check passes. New `serverChecked` shows them from the first paint after the page's own guard. The README places the gate inside `/account`, not around a layout. **Changed:** the gate's root element is always present, with the children in a new `content` slot. [ADR 0015](docs/decisions/0015-gate-renders-its-children.md).
- **The proxy drops client-sent `Content-Security-Policy` request headers**, so the nonce Next stamps on scripts only ever comes from the app.

### Added

- **The auth matrix's server mode (#9).** `auth-kit/testing/matrix-server` (dev only, behind a `withDevKit` alias): `matrixServerOverrides()` gives `createServerAuth` the test issuer's keys (with a fetcher that never reaches the pool's JWKS) and a scripted Cognito, and `createPeopleActions` a read-only People client, a refusing mailer, and an in-memory audit log, built per bundle. `startMatrixServer` (in `auth-kit/testing`) runs `next dev` with the fixture and no AWS and returns cookie personas; `matrixFixture`, `matrixServerEnv`, `parseMatrixFixture`. `withDevKit` takes several aliases (`DEV_ALIAS`, `DEV_MATRIX_ALIAS`). `check-prod-build` also fails on the matrix module's marker. [ADR 0016](docs/decisions/0016-matrix-server-mode.md).
- **`withAuthProxy({ headers })` (#11):** request headers for every pass-through and response headers for every response (redirects and refusals too); reserved session, client-address, auth-kit, and Next headers throw. `nonceCspHeaders(policy)` builds a per-request nonce CSP with it. README section on CSP with the proxy.
- **"Couldn't check" in production error boundaries (#10).** `AuthUnavailableError` carries its own `digest` (`AUTH_KIT_AUTH_UNAVAILABLE;<reference>`), which Next keeps when it redacts server errors; `isAuthUnavailableError(error)` (from `auth-kit/client` and `auth-kit/server`) reads it. README `error.tsx` example.
- `AWS_BLOCKED_ENV` in `auth-kit/testing`; auth-kit's own tests run with it, with a canary.
- An end-to-end test on a real Next 16 fixture app (`npm run test:e2e`, in CI): build, the full matrix on `next dev`, `next start`.

### Fixed

- **The origin check under `next dev` (#8).** Next rewrites `request.url`'s host to `localhost`, so without `expectedOrigin` every POST from `app.localhost` or `127.0.0.1` failed with `origin_mismatch`. In development only, with `request.url` and `Host` both loopback, the browser's origin (`Host`) counts too. A configured `expectedOrigin` still wins, and the README now sets it in every environment.
- **README (#10):** the admin example's step-up link is `signInUrl('/admin/people', { reauth: true })` (it used `?step-up=1`, which the sign-in page doesn't read, with no return path); the template is linked instead of "coming later".

## [0.1.1-alpha] - 2026-10-17

Phase 2 of `auth-kit/client` and `auth-kit/dev`, and the fixes from the [2026-10-17 security review](docs/reviews/2026-10-17-fable-review.md). Pre-release; some APIs changed (marked **Breaking**).

### Security

- **Auth matrix checks each route's own guard (H1).** Every case also runs with the proxy stepped aside (honored only outside production builds, with `AUTH_KIT_MATRIX=1`, on a localhost URL), so a route relying on the proxy for its 401 fails. **Breaking:** `appRoutes` is required (`routesFromNextBuild()` reads Next's build manifests); uncovered and mistyped routes fail; each row must expect some persona to succeed. New: `expectWithoutProxy`, `exists: false`, `handlerRequest`. ADR 0014.
- **Server-side refresh only for genuine expired sessions (M1).** The proxy refreshes only an Amplify cookie session whose access token is signed by this pool for this client and merely expired, with a refresh-token cookie; never anonymous, forged, or bearer requests. Refreshes are limited per person and per instance, back off after failures, and are shared by concurrent requests (`refreshLimits`, `onRefresh`). Tokens that merely expired are now 401 `token_expired`.
- **Secure server-written token cookies (M2).** `amplifyCookieRuntimeOptions` sets `secure: true` explicitly (`localDevOrigin` drops it for http://localhost only). Browser-written cookies get the same lifetime from `configureAuthClient`.
- **Default-deny can't be configured away (M3).** `publicRoutes` that match everything (`'/*'`, catch-all RegExps) or unanchored RegExps throw at startup; malformed paths and unknown options throw.
- **Release tarballs (M4).** **Breaking:** install from the attested release tarball, not `github:`; the `prepare` script is gone. Dependabot added. ADR 0012.
- **Low items.** Token claim shape and time policy checked, `NaN` cache lifetimes refused, authenticator cache keyed by person and token (L1); cookie parsing matches Next's (L2); public routes overwrite `x-auth-kit-path` (L5); **Breaking:** `getUser()` applies the authenticator rule (L6); `expectedOrigin` for the origin check (L7); stricter preSignUp address parsing (L8).

### Added

- `auth-kit/client` (phase 2): `SignIn` (passkey first, password + TOTP, emailed code; every challenge the standard's pools return; step-up), `ChooseFirstCredential` (first sign-in after an invite), `AuthenticatorSetup`, `TOTPEnrollmentGate`, `MyAccount` (passkeys with a last-way-in guard, authenticator, password, sign out everywhere), `PasswordForm` with a Have I Been Pwned range check, `configureAuthClient` (token cookies expire with the refresh token), and the Amplify calls behind them as functions. Unstyled, accessible markup with `data-auth-kit` slots and `classNames`. [ADR 0008](docs/decisions/0008-client-in-the-browser.md) records where Amplify v6 differs from the standard.
- `auth-kit/dev` (phase 2): `personas.json` in the primer's shape and `parsePersonas`; `seedPersonas` and `npx auth-kit init-personas` / `seed-personas` (refuses anything but a sandbox pool, asserts the account from the pool's ARN, converges users, passwords, groups, and authenticators, idempotent, secrets only in git-ignored `.env.local`); `createDevKit` with the "Sign in as…" route (request gates including `127.0.0.1`/`[::1]` and a proxy-header gate, same-site writes, a check of the dev server's listening sockets, a cached sandbox check, 404 on every refusal, Amplify's own cookies); `withDevKit` for `next.config.ts`; `checkProductionBuild`, `checkDevRouteAbsent`, and `npx auth-kit check-prod-build` / `check-dev-route`. Personas are enrolled in TOTP so the authenticator rule holds ([ADR 0009](docs/decisions/0009-localhost-kit.md)).
- `auth-kit/dev/menu`: `PersonaMenu`, the dev-only "Sign in as…" menu.
- `auth-kit/ribbon`: `EnvironmentRibbon`, `ViewAsBanner`, `environmentMetadata`, `viewAsMetadata`, `resolveEnvironment` (safe in production builds).
- The `auth-kit` command (`bin`).
- `auth-kit/admin`: `createPeopleActions` (list, invite, resend, change role, disable, re-enable, sign out everywhere, delete, invite expiry, Activity, FormData adapters), each checked live and guarded, with step-up for grants and deletes; `createDynamoAuditLog` and `createMemoryAuditLog` (append-only: conditional `PutItem` and `Query` only); `runAudited` and `recordChange` (intent → calls → result); `createInviteExpirySweep`; `createSesInviteMailer`; a Cognito quota limiter with backoff; IAM policy builders.
- `auth-kit/admin`: owners may make owners, but each owner grant needs a recent sign-in and alerts every owner (`ownerAlerts`, default the SES mailer's `ownerGranted`); with no notifier it's refused, and if the alert fails the grant is undone.
- `auth-kit/admin/ui`: `PeopleTable`, `InviteForm`, `RoleChangeDialog`, `ActivityLog`, `LostPasskeyGuide`.
- `auth-kit/admin/cdk`: `AuditLogTable` (deletion protection, point-in-time recovery, stream, a resource policy denying item edits, optional tamper alerts).
- Shared web ACL: `waf: { webAclArn }`, `createSharedAuthWebAcl`, `associateAuthWebAcl`. **Breaking:** `waf: false` requires `acknowledgeNoRateLimit: true`; `waf.enabled` is retired; `AppliedAuthStandard.webAcl` became `waf`. ADR 0013.
- `createServerAuth` validates its options at startup; `requireUser` reports `invalid_token` / `token_expired`.

### Changed

- `auth-kit/client`: the phase-1 stubs are replaced. `SignInScreen` is now `SignIn`, `AuthenticatorEnrollmentGate` is `TOTPEnrollmentGate`, sign-in functions return a `SignInStep`, and `NotImplementedError` is no longer exported from this subpath.
- `DEV_POLICY.route` is `/api/dev/sign-in`. `personas.json` entries use `key`/`email`/`groups` instead of `role`/`appRoles`. `checkProductionBuild` returns a result instead of rejecting. `auth-kit/dev` gains a `default` export condition so `next.config.ts` can load it.
- `auth-kit/admin`: `checkPeopleAction` matches role names exactly against the known set, treats any owner count that isn't a whole number ≥ 0 as a refusal, and checks the target's state; `inviteStatus` understands the admin pool's temporary-password invites and treats an unreadable creation date as expired.

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

[0.1.3-alpha]: https://github.com/davidyokum/auth-kit/releases/tag/v0.1.3-alpha
[0.1.2-alpha]: https://github.com/davidyokum/auth-kit/releases/tag/v0.1.2-alpha
[0.1.1-alpha]: https://github.com/davidyokum/auth-kit/releases/tag/v0.1.1-alpha
[0.1.0-alpha]: https://github.com/davidyokum/auth-kit/releases/tag/v0.1.0-alpha
