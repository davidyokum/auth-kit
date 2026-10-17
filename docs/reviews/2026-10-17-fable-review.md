# auth-kit 0.1.0-alpha: adversarial security and correctness review

- **Date:** 2026-10-17 · **Reviewer:** Claude (Fable 5.1), independent read-only review
- **Scope:** `v0.1.0-alpha` (commit `3f70910`): README, ADRs 0001–0007, `src/**`, `test/**`, build and package config, against `03-gold-standard-and-plan.md` §1–§2 and the primer.
- **Method:** read every source and test file; read the installed `aws-jwt-verify` 5.2.1, `@aws-amplify/adapter-nextjs`, `@aws-amplify/core`, `@aws-amplify/auth-construct`, and `aws-cdk-lib` 2.273 code that auth-kit's claims depend on; ran the suite (372 tests pass); ran ~120 ad-hoc probes against the TypeScript source (safeRedirect attack strings, proxy path probes with real `NextRequest`s, cookie parsing, guardrails, dev gates, token claim edge cases, and the auth matrix against a deliberately broken app). No AWS calls, no edits, no builds into the repo.

**Verdict.** The security core is sound: token verification does the five checks with no fail-open path I could find, `safeRedirect` resisted everything I threw at it, the proxy fails closed on every ambiguous path, and the synthesized CloudFormation matches the README claim for claim. The real defects are at the edges: the assurance helper can't see the one regression the standard most fears (a route that relies on the proxy), the server-side refresh path can be made to trip the pool's own WAF rule, server-refreshed cookies lose `Secure`, and two proxy configuration foot-guns silently turn default-deny off. Nothing here is an unauthenticated bypass of a correctly configured site.

## Findings, ranked

### High

#### H1. The auth matrix passes for a route that has no server check of its own, and for a route that doesn't exist

- **Where:** `src/testing/matrix.ts:105-154` (`authMatrixCases`), `src/testing/matrix.ts:162-184` (`runAuthMatrix`); README rows "Every route … caught by the auth matrix" (`README.md:198`) and "Auth-matrix tests in CI" (`README.md:226`).
- **Scenario (verified by probe):**
  1. An app with `withAuthProxy` in front and a handler `GET /api/secret` that forgot `requireUser()`. Matrix `expect: { anonymous: 401, member: 200, admin: 200 }` **passes**: the proxy supplies the 401, the handler supplies the 200s. This is exactly the route a middleware bypass (CVE-2025-29927 class, which the proxy's own doc cites) exposes, and the standard's rule that "the proxy is never the only gate" is the rule the matrix exists to enforce.
  2. A mistyped record route `/api/reprots/:id` with `expect: { anonymous: 401, member: 404, otherMember: 404, admin: 404 }` **passes** (proxy 401, app 404). The required "second member gets 404" is satisfied by nonexistence.
  3. Nothing checks that `routes` covers the app: an unlisted route is simply untested, yet the README reads as if the matrix proves "every route … checks".
- **Fix:**
  - Run the matrix twice, or add a `mode: 'handlers'` pass that bypasses the proxy (in-process dispatch to the route modules, or a test-only `AUTH_KIT_PROXY=off` honored by `withAuthProxy` when `NODE_ENV === 'test'`), and require the route's own 401 in that pass.
  - Require at least one 2xx/3xx expectation per route (or an explicit `exists: false`) so a 404-everywhere row can't pass.
  - Accept a route manifest (Next's `.next/server/app-paths-manifest.json` plus `routes-manifest.json`) and fail with the list of uncovered routes; make the template's CI pass it.
  - Until then, say in the README that the matrix verifies *responses*, not *where the check lives*.

### Medium

#### M1. Server-side refresh is attempted for every unauthenticated request and can push the server's own IP over the pool's WAF sign-in limit

- **Where:** `src/proxy/index.ts:196-202` (refresh runs whenever `verifies()` is false, including no token and forged token; probe: 2 refresh calls for anonymous + forged), `src/proxy/index.ts:182-191` (`verifies()` discards the reason), `src/proxy/index.ts:236-252` (`amplifyAdapterRefresh`), `src/server/cognito.ts:71` (default `factorLookup: 'access-token'`), `src/amplify/waf.ts:28,78-96` (sign-in rule matches every `InitiateAuth`, which includes `REFRESH_TOKEN_AUTH`).
- **Scenario:** the adapter's validator (`adapter-nextjs/.../isValidCognitoToken.mjs`) accepts any correctly signed token that is merely expired. So a request carrying one expired access token (an attacker's own old session, or any leaked old cookie) plus any refresh-token cookie makes the server call `InitiateAuth(REFRESH_TOKEN_AUTH)` from its egress IP, per request, with no authentication. One hundred such requests in five minutes trip `auth-kit-sign-in-attempts-per-ip` for that IP; WAF then blocks the server's own refreshes **and** its `GetUserAuthFactors` calls (token-authorized Cognito operations are inspected by WAF) → `AuthUnavailableError` 503 for every user served from that IP for the block period. The same budget is consumed organically: all users' server-side refreshes and TOTP checks share the server's egress address(es), and the sign-in rule counts browser refreshes too, which ADR 0004 doesn't mention (an office NAT with many tabs can hit 100/5 min).
- **Fix:**
  - Keep the failure reason: have `verifyAccessToken` surface `JwtExpiredError` (e.g. `UnauthenticatedError('token_expired')`) and only call `refresh` when the presented token was *expired* and a refresh-token cookie exists; never for absent or forged tokens.
  - Default `factorLookup` to `'iam'` (IAM-signed `AdminGetUserAuthFactors` isn't inspected by WAF; document the trade-off that revocation is then seen only by the ~1 min live check and token expiry), or keep token lookup but raise the TTL.
  - Add a small per-request-IP or per-refresh-cookie throttle on refresh attempts in the proxy.
  - Document in ADR 0004 that refreshes count toward the sign-in rule, and keep the count-mode advice.

#### M2. Cookies rewritten by the server-side refresh lose `Secure`; the README and code comment claim otherwise

- **Where:** `src/server/cookies.ts:11` ("Secure is set by the adapter on HTTPS"), `src/server/cookies.ts:79-87` (`amplifyCookieRuntimeOptions` emits `{ sameSite: 'lax', maxAge }` only), README row "Secure, SameSite cookies" (`README.md:194`), ADR 0007.
- **Evidence:** `@aws-amplify/adapter-nextjs/dist/esm/utils/createRunWithAmplifyServerContext.mjs:11-25` merges `{ ...runtimeOptions.cookies, path: '/' }` and adds `secure: isSSLOrigin` **only** inside the `isServerSideAuthEnabled` (experimental httpOnly) block. In the standard mode auth-kit uses, nothing adds `Secure`.
- **Scenario:** sign-in writes Secure cookies from the browser (core `CookieStorage` defaults `secure: true`). After the first proxy-driven refresh, `Set-Cookie` from the server (over HTTPS, so allowed to overwrite) replaces the access, ID, and refresh token cookies **without** `Secure`. Any later plain-http request to the host (a typed `http://` URL before the redirect, a captive portal, mixed content) sends all three tokens in clear.
- **Fix:** `amplifyCookieRuntimeOptions` returns `secure: true` by default (an explicit opt-out for `http://localhost` only), fix the comment and README row, and add a test asserting the option. Also correct the "lifetime no longer than the refresh token" claim: the browser side (`Amplify.configure(..., { ssr: true })` → `new CookieStorage({ sameSite: 'lax' })`, `core/.../selectSsrKeyValueStorage.mjs`) writes 365-day cookies on every client-side refresh; only server-written cookies get `maxAge`. The template should pass the same options to the client `cookieStorage` if the claim is to hold.

#### M3. Two `publicRoutes` shapes silently disable default-deny

- **Where:** `src/proxy/index.ts:83-84` (`'/*'` becomes prefix `'/'`), `src/proxy/index.ts:93` (`p === '/'` matches everything), `src/proxy/index.ts:81-82,94-97` (RegExp tested as-is).
- **Scenario (verified):** `publicRoutes: ['/*']` → `/admin` is public, no error or warning. `publicRoutes: [/\/blog\//]` (unanchored) → `/admin/blog/x` is public. Both are one-token mistakes in the single place an app configures its allowlist.
- **Fix:** throw on `'/*'` (or require `allowAll: true`), and either require anchored regexes (`source` starts with `^` and ends with `$`) or wrap user regexes with implicit `^(?:…)$`. Add tests.

#### M4. Install-from-GitHub builds on every consumer's machine with the full dev toolchain

- **Where:** `package.json:71` (`"prepare": "npm run build"`), README "Install" (`README.md:20-28`), `.github/workflows/ci.yml` (no Dependabot/Renovate; `.github/` has only workflows).
- **Scenario:** `npm i github:davidyokum/auth-kit#v0.1.0-alpha` clones the repo and installs its devDependencies (`aws-cdk-lib`, `next`, `react`, `vitest`, `typescript`, `tsup`/`esbuild`, ~1k packages) in the consumer's dev and CI environments, running their lifecycle scripts there (`esbuild`, `core-js`, `fsevents` have install scripts per the lockfile). The build output depends on whatever resolves at install time, so two sites can ship different `dist/` from one tag; and a git tag is mutable, so `#v0.1.0-alpha` is not a pin. For a package whose job is auth on every site, this is the widest supply-chain surface in the repo.
- **Fix:** publish built artifacts: public npm (03 §6 item 7 already recommends it) with `npm publish --provenance`, or GitHub Packages, or a release branch/tarball with `dist/` committed on tags; tell consumers to pin a commit SHA until then; add Dependabot; keep `files` as-is.

### Low

#### L1. Required token claims are typed but never checked; a missing `jti` makes the TOTP cache key shared across users, and `TtlCache` accepts a `NaN` TTL as "forever"

- **Where:** `src/server/verify.ts:9-27` (types assert `sub`, `jti`, `exp`, `iat`, `auth_time`), `src/server/auth.ts:206` (`tokenId: claims.jti`), `src/server/auth.ts:248-254` (cache keyed by `user.tokenId`), `src/server/cache.ts:21` (`if (ttlMs <= 0) return;` lets `NaN` through).
- **Evidence:** `aws-jwt-verify` only type-checks claims *if present* (`jwt.js assertJwtPayload`) and skips expiry when `exp` is absent. Probe: two different users whose tokens lack `jti` shared one cache entry (second user got the first user's answer with no Cognito call); with `exp` absent, `untilExpiry` is `NaN` and the entry never expires.
- **Risk:** needs a pool-signed token without `jti`/`exp`, which Cognito doesn't issue, so not attacker-reachable today; but the reverse case (a password-only user inheriting another user's "has TOTP" answer) would be fail-open.
- **Fix:** after `verify`, assert the claim shape (`sub`, `jti`, `username` strings; `exp`, `iat`, `auth_time` finite numbers) and throw `UnauthenticatedError('invalid_token')` otherwise; in `TtlCache.set`, use `if (!(ttlMs > 0)) return;`.

#### L2. Cookie parsing differs from Next's, so the proxy and the handler can evaluate different sessions

- **Where:** `src/server/context.ts:15-16` (first duplicate wins) vs Next's `RequestCookies` (last wins; probe confirmed), used by handlers through `nextHeadersContext()`.
- **Scenario:** a sibling subdomain (e.g. another team's app under the same parent domain) tosses `…LastAuthUser` and token cookies with `Domain=parent`; the proxy admits on one token, the handler acts on another. Both are verified tokens, so this is the generic login-CSRF/session-fixation class (Amplify's cookie names preclude `__Host-`), not an auth-kit bypass.
- **Fix:** match Next's semantics (last wins) so both layers agree; consider refusing a request that carries two `LastAuthUser` cookies; document the "no untrusted sibling subdomains" assumption for custom domains.

#### L3. Guardrails accept role-name variants and a `NaN` owner count

- **Where:** `src/admin/guardrails.ts:56-58` (`roleRank` of an unknown string is 0), `:123-125`, `:136` (`input.ownerCount <= 1`).
- **Probe:** `toRole: 'Superadmin'` and `' superadmin'` return `ok: true` (treated as app roles); `ownerCount: NaN` passes the last-owner check. Cognito would reject the nonexistent group today, so no escalation, but phase-2 actions will feed `toRole` from forms and `ownerCount` from a list call that can fail partially.
- **Fix:** take `knownGroups` and reject any `toRole`/`fromRole` not exactly in it; treat `!(ownerCount > 1)` as "no".

#### L4. The app client ships with OAuth code flow on and the CDK placeholder `CallbackURLs: ['https://example.com']`

- **Where:** snapshot `test/amplify/__snapshots__/preset.test.ts.snap` (`AllowedOAuthFlows: ['code']`, `AllowedOAuthFlowsUserPoolClient: true`, `CallbackURLs: ['https://example.com']`, scopes incl. `aws.cognito.signin.user.admin`); `src/amplify/apply.ts` sets nothing for OAuth.
- **Scenario:** inert without a managed-login domain. The README's "Verify on the first sandbox deploy" says a domain may turn out to be required; the moment one exists, the placeholder is a live authorization-code redirect target.
- **Fix:** in `applyAuthStandard`, delete the OAuth properties (`addPropertyDeletionOverride`) and set `AllowedOAuthFlowsUserPoolClient: false`, or require explicit callback URLs whenever a domain is configured; assert it in the preset test.

#### L5. Public routes forward a client-supplied `x-auth-kit-path`

- **Where:** `src/proxy/index.ts:194` (bare `NextResponse.next()`), `src/server/pages.ts:30-37` (`currentPath()` reads it). Downstream it always passes through `safeRedirect`, so the worst case is a chosen same-site `next=`. Strip or overwrite the header on public routes too.

#### L6. `getUser()` skips the TOTP rule

- **Where:** `src/server/auth.ts:217-245` vs `:259-264`. A route written as `const u = await auth.getUser(); if (!u) throw new UnauthenticatedError()` admits a password user with no authenticator. Make `getUser` run the same rule (with `allowMfaEnrollment` to opt out) or document it in red.

#### L7. `isSameOriginRequest` compares against `request.url`'s scheme

- **Where:** `src/server/cookies.ts:120-132`. If Next builds `request.url` as `http://…` behind Amplify's CloudFront → Lambda while browsers send `Origin: https://…`, every state-changing POST is 403 (fail closed, but the kind of failure that gets the check disabled). Verify on the first deploy; consider comparing against a configured `expectedOrigin` in production rather than the reconstructed URL.

#### L8. preSignUp allowlist: loose address parsing, and sign-up enumeration

- **Where:** `src/amplify/pre-sign-up.ts:35` (`lastIndexOf('@')`). Probe: `a@evil.example@example.edu` is allowed. Mail for it still routes to `example.edu`, so not a domain bypass; tighten to exactly one `@` and no control characters. Separately, when `selfSignUp` is on, `SignUp`'s `UsernameExistsException` reveals accounts (`PreventUserExistenceErrors` doesn't cover `SignUp`); note it in the README's exception.

#### L9. Nothing enforces the loopback binding the dev gates rely on

- **Where:** `src/dev/index.ts:85` (`DEV_SERVER_COMMAND` is a string), `:76-82`. A `next dev` on `0.0.0.0` passes all three gates for anyone on the LAN sending `Host: localhost`. Phase 2: have the template's `dev` script own the flag, and have the handler refuse when `x-forwarded-for`/`forwarded` is present or when the request's `host` doesn't match the configured `*.localhost` name; keep the CI production-build check.

### Info and verify-on-first-sandbox-deploy

- **Sandbox misdetection:** `amplify-backend-type` is read from CDK context (`src/amplify/apply.ts:81-84`); absent or unknown → production posture (fail-safe, tested). Amplify's deployer passes it as CLI context, which outranks repo `cdk.json`; verify `ampx pipeline-deploy` sets `branch` on the first real deploy.
- **Issuer formats:** `aws-jwt-verify` 5.2 accepts both `cognito-idp.<region>` and `issuer-cognito-idp.<region>` issuers for the pool (probe: global format accepted, trailing slash rejected). `ResolvedPoolConfig.issuer` names only the regional one; document.
- **`iat` in the future is accepted** (no check in `aws-jwt-verify`); not exploitable without the signing key.
- **`WebAuthnFactorConfiguration`** is a real CloudFormation property in `aws-cdk-lib` 2.273 (typed `webAuthnFactorConfiguration` exists), so the raw override is correct and could become the typed property.
- **Outputs:** `mfa_configuration` and password-policy outputs are `Lazy` reads of the L1 (`auth-construct/lib/construct.js:855-889`), so ADR 0006's claim holds.
- **No-password invites:** the SDK confirms `AdminCreateUser` omits the generated temporary password only when passwordless sign-in is available, which the everyday pool has (`EMAIL_OTP`); the admin pool (no `EMAIL_OTP`) gets a temporary password, as the README says.
- **`/_next/image` stays public** by default; fine, but note the optimizer fetches `?url=` internally.

## What's good

- **Verification:** signature (JWK `alg` enforced, no HS*, `alg:none` rejected, impostor key with our `kid` rejected), expiry, `nbf`, issuer (foreign pool, trailing slash → 401), `client_id` (not `aud`, not an array), `token_use`; fetch and malformed-JWKS failures → 503, never 401 or a pass; JWKS penalty box prevents unknown-`kid` flooding; machine tokens aren't people; ID token read only when `sub` matches.
- **`safeRedirect`:** survived ~40 strings beyond the suite (encoded and mixed-case dot segments, Unicode slashes, triple/quad encoding, every control and space class, scheme tricks, IDN hosts); every accepted result is a same-site path.
- **Proxy:** raw+decoded double match, encoded slash/backslash fail closed, `NextURL` dot-segment normalization confirmed with real requests, unknown errors → 503, return-path header overwritten on protected routes, redirect target built from the URL not the `Host` header.
- **Guards:** clean 401/403/404/503 discipline; TOTP rule before role; live check refuses disabled accounts; step-up fails closed on a missing `auth_time`; record access checks null first and defaults to 404; unknown groups grant nothing; capability names type-checked.
- **Preset:** the snapshot matches the README claim for claim (admin-create-only, deletion protection, Essentials/Plus, 15-char policy, first-factor order, OPTIONAL/ON with TOTP only, UV required + `MULTI_FACTOR_WITH_USER_VERIFICATION` + RP ID, SES `DEVELOPER` from a domain identity, 60/60/43200-minute validity with units, `AuthSessionValidity: 3`, `PreventUserExistenceErrors`, revocation, exactly `ALLOW_USER_AUTH` + refresh outside sandboxes, no guest identities, tags, WAF ACL and association). A branch named `sandbox` isn't a sandbox; `environment: 'sandbox'` is refused.
- **Hygiene:** no real IDs in the repo (enforced by test), SHA-pinned actions, no network in tests, `auth-kit/client` builds to a chunk with no server imports.

## Test gaps worth adding

1. Matrix: the two probes above (unguarded route behind the proxy; mistyped route) as failing-by-design tests once H1 is fixed; coverage against a route manifest.
2. Proxy: `publicRoutes: ['/*']` and an unanchored RegExp throw; refresh is **not** called for anonymous or forged tokens; `x-auth-kit-path` is stripped on public routes; a `Host`-header redirect test built from a raw request rather than a `URL`.
3. Verify: claim-shape validation (missing `jti`, `sub`, `exp`); `TtlCache` rejects `NaN`; decide and test a policy for far-future `iat`.
4. Cookies: `amplifyCookieRuntimeOptions` includes `secure: true`; duplicate-cookie semantics match Next's `RequestCookies`.
5. Preset: OAuth properties absent/disabled on the client; `amplify-backend-type: 'Sandbox'` (wrong case) is not a sandbox.
6. Guardrails: role-name variants and `NaN`/negative owner counts refused.
7. WAF: can't be exercised locally; keep the count-mode verification and add a CloudWatch check that the sign-in rule's sampled requests include `REFRESH_TOKEN_AUTH`, so the limit is tuned with that in mind.

## Appendix: probes run (read-only, from the scratchpad)

safeRedirect fuzz (37 strings); proxy path probes with real `NextRequest`s (28 paths plus `Host` spoof, header pass-through, refresh-call counting, `/*`, unanchored regex); cookie parsing (duplicate names, traversal-shaped `LastAuthUser`, bearer edge cases, Next vs auth-kit duplicate order); `isSameOriginRequest` variants; `TtlCache` NaN and cap; `isLocalhostName` (14 hosts) and gates; persona validation; `isAllowedEmail` (8 strings); guardrails (11 cases); server auth with missing `jti`/`exp`/`sub`, trailing-slash and global issuers, `nbf`, future `iat`, RS512-vs-RS256, `aud`-only and array `client_id`; auth matrix against an unguarded route and a mistyped route. The existing suite: 18 files, 372 tests, all passing.
