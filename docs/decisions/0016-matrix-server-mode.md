# 0016. The auth matrix's server mode ships in auth-kit

- **Status:** Accepted, 2026-10-17 (extends [ADR 0014](0014-matrix-without-proxy.md))
- **Standard:** 03 §2 Assurance ("auth-matrix tests in CI"), Local development
- **Issue:** [#9](https://github.com/davidyokum/auth-kit/issues/9)

## Context

ADR 0014 says CI runs the matrix against a dev server started with `AUTH_KIT_MATRIX=1`. In CI there's no pool, so that server has to verify tokens from `createTestIssuer`, answer the authenticator check and `{ live: true }` re-reads without Cognito, keep the People page and audit log off AWS, and keep all of it out of production builds. auth-kit shipped none of that server side, and `createFakeCognito` is for tests, so the template built its own: a second `withDevKit` alias, a scripted `CognitoGateway`, a read-only admin client, an in-memory audit log, and the dev marker. It worked, but it's security-relevant plumbing every site would copy, and building it hit two traps:

- **Cross-bundle `instanceof`.** The proxy, each page, and each route handler are separate bundles with their own copy of auth-kit. A gateway memoized on `globalThis` by the proxy throws the proxy's `UnauthenticatedError`, which a page's copy doesn't recognize, so `getUser` rethrows it as a 500.
- **One alias.** `withDevKit` took a single alias; a second needed a nested call.

## Decision

- **`auth-kit/testing/matrix-server`**, imported by the app only from a module behind a `withDevKit` alias (`@/dev-matrix`). `matrixServerOverrides()` returns `null` unless `NODE_ENV` is `development` (written literally, so a production build compiles the rest away) and `AUTH_KIT_MATRIX=1`. With the flag but no fixture it throws: it never guesses and never falls back to AWS. Its result:
  - `serverAuth` to spread into `createServerAuth`: the test issuer's public keys, a key fetcher that serves only those (so a token with an unknown key ID is a 401, never a request to the real pool's JWKS endpoint), and a scripted Cognito that answers per person and refuses a disabled account (`account_disabled`) and a revoked session (`invalid_token`) the way the real gateway does. A person the fixture doesn't know is a loud error, not "signed out".
  - `peopleCognito`, `mailer`, `auditLog` for `createPeopleActions`: the People list reads the fixture, every change is refused, no email is sent, the audit log is in memory.
  - `shared(key, create)` for the app's own in-memory stores.
- **Per bundle.** The overrides are built once per bundle; only plain data (the audit log's rows and `shared` stores) lives on `globalThis`. The audit log is wrapped per bundle so its errors are that bundle's classes.
- **The fixture** travels in `AUTH_KIT_MATRIX_FIXTURE` as JSON: a format version, the issuer's JWKS, and per-person groups, live groups, enabled, revoked, factors. The parser refuses unknown fields and any private key material.
- **`startMatrixServer`** in `auth-kit/testing` mints a session per persona, starts `next dev --hostname 127.0.0.1` with the flag, the fixture, `ALLOW_DEV_SIGNIN=0`, and `AWS_BLOCKED_ENV` (none of which the caller's `env` can override), waits until it answers, returns `cookiePersonas` for `assertAuthMatrix`, and stops the whole process group. `matrixFixture` and `matrixServerEnv` serve apps that run their own server.
- **Out of builds, proven.** The module carries its own marker, which `checkProductionBuild` now looks for by default alongside the dev sign-in marker, and CI checks no shipping subpath's built import graph contains either.
- **`withDevKit({ aliases: [DEV_ALIAS, DEV_MATRIX_ALIAS] })`** sets several aliases in one call, and validates them.

The proxy's own gate (ADR 0014) is unchanged; the server mode doesn't add a request-time loopback check because there is nothing to protect remotely: only tokens signed by the test process's in-memory key verify.

## Consequences

- A site's matrix wiring is two small alias files, a spread in `lib/auth.ts`, and the admin options; the scripted behavior and its fidelity to Cognito live, and get fixed, in one place.
- auth-kit's own CI runs the whole matrix on a real Next 16 fixture app (`test/e2e`): `next build` (no matrix code in the output), `next dev` through `startMatrixServer` with and without the proxy, and `next start` (the proxy never steps aside).
- The scripted Cognito is only as faithful as its fixture. Real Cognito round trips are still checked on a sandbox deploy.
