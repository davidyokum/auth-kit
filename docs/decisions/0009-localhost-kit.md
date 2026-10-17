# 0009. The localhost kit: what phase 2 decided

- **Status:** Accepted, 2026-10-17. Amends [0005](0005-sandbox-only-admin-password-flow.md).
- **Standard:** 03 §2 Local development; primer §10 and Chapter 8 ("Under the hood")

## Context

Phase 2 built the kit 0005 promised: seeding, the "Sign in as…" exchange, the ribbon, and the production-build check. Following the primer's design literally would have broken in five places, and a security review found that nothing enforced the loopback binding the primer relies on.

## Decisions

1. **Personas are password + authenticator (TOTP) users.** The primer's seed script sets only a password, but `requireUser` refuses a password user without an authenticator (0002), so every persona would have been sent to TOTP setup. The seed script enrolls each persona (`AssociateSoftwareToken`, `VerifySoftwareToken`, or `MFA_SETUP` in required-MFA pools), keeps the secret in `.env.local`, and the route answers `SOFTWARE_TOKEN_MFA` with a computed code. Personas then pass the same checks real people do. Cognito won't take a code twice, so a second sign-in within 30 seconds waits for the next one.
2. **The loopback binding is checked, not assumed.** The route reads the dev server's own listening sockets (`next dev` serves requests in the process that listens; confirmed against Next 16.4) and refuses unless every one is on 127.0.0.1 or ::1. If it can't see them, it probes this computer's network addresses on the dev port; if it can't tell, it refuses. Headers can't prove where a request came from, because Next fills in X-Forwarded-For only when the caller didn't. A fourth request gate still refuses when proxy headers name a client other than this computer, which catches tunnels (ngrok, cloudflared) that connect from 127.0.0.1.
3. **The host gate also accepts `127.0.0.1` and `[::1]`** (the primer says `localhost` or `*.localhost`). Those addresses are as local as the names, and the dev server listens on 127.0.0.1. The Host, the request URL, and any X-Forwarded-Host must all be loopback names; exact spellings only (no `127.1`, `[0:0:0:0:0:0:0:1]`, or unbracketed `::1`). `*.localhost` names per app are still the recommendation, for separate cookies.
4. **The ribbon ships; the menu doesn't.** The primer swaps "the menu and the ribbon" out of every build, but previews run production builds and must show a PREVIEW ribbon, and View as runs on the live site. So `auth-kit/ribbon` (EnvironmentRibbon, ViewAsBanner, metadata helpers) is safe in production and imports nothing from the dev kit; `auth-kit/dev/menu` (the persona menu) and `auth-kit/dev` (route, seeding, checks) carry the marker and must never be in a build. CI checks the built import graph of `auth-kit/ribbon` for the marker.
5. **The dev route is public in the proxy.** With a default-deny proxy, a production build would answer `/api/dev/sign-in` with 401, which can't prove the route is absent (the primer's e2e test expects 404). Apps list the route in `publicRoutes` in every environment; `check-dev-route` explains a 401 when it sees one.
6. **`personas.json` uses the primer's shape** (`key`, `email`, `groups`, optional `label` and `attributes`), replacing phase 1's `role`/`appRoles`. Several personas may share a role (the auth matrix needs a second member); every admin role and a no-group member must be covered, and with `appRoles` every app role too.
7. **The route is `/api/dev/sign-in`** (primer), not phase 1's `/dev/sign-in`. Writes must come from the page (Origin or `Sec-Fetch-Site`) and be JSON, which blocks another site signing you in or out.
8. **`auth-kit/dev` has a `default` export condition.** Next compiles `next.config.ts` to CommonJS and `require`s it; with only an `import` condition, `require('auth-kit/dev')` doesn't resolve.

## Consequences

- A dev server inside a container (which must listen on `0.0.0.0`) can't use "Sign in as…".
- The account check reads the pool's ARN instead of calling STS: the caller can only describe pools in its own account, and auth-kit needs no STS dependency.
- The HTTP check can't tell "absent" from "present but refused" (both are 404 by design); the build check is the proof of absence.
