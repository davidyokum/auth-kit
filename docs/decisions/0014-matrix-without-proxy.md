# 0014. The auth matrix checks each route's own guard

- **Status:** Accepted, 2026-10-17
- **Standard:** 03 §2 Enforcement ("the proxy is never the only gate"), Assurance
- **Review:** H1 in [the 2026-10-17 review](../reviews/2026-10-17-fable-review.md)

## Context

The matrix sent every request through the whole app, so the proxy's 401 hid a route handler that forgot `requireUser()`: exactly the route a proxy bypass (CVE-2025-29927) exposes. A mistyped route passed too (proxy 401, then 404 for everyone), and nothing checked that the rows covered the app.

## Decision

- **Two passes.** Every case runs through the proxy and again with the proxy stepped aside; by default both expect the same status. A route whose own answer legitimately differs says so in `expectWithoutProxy`, which is visible in review.
- **How the proxy steps aside.** The matrix marks its second pass with `x-auth-kit-matrix: handlers`. `withAuthProxy` honors it only when `NODE_ENV` isn't `production`, `AUTH_KIT_MATRIX=1` is set for the server, and the host is loopback. `process.env.NODE_ENV` is written literally, so `next build` replaces it with `"production"` and drops the branch: verified on a Next 16 production build, where the gate compiles to a constant `false`. Every response the proxy steps aside for carries `x-auth-kit-proxy: handler-pass`, and every refusal `x-auth-kit-proxy: denied`; the matrix fails a second-pass case the proxy answered, or one it didn't confirm, so a server started without the flag can't produce a false pass. In-process tests pass `handlerRequest` instead.
- **Coverage.** `appRoutes` is required: `routesFromNextBuild('.next')` reads Next's build manifests (pages and route handlers), or the app lists routes by hand, optionally per method (`'POST /api/admin/invite'`). An app route with no row and a row matching no app route both fail.
- **Something must succeed.** Each row must expect at least one persona to get a status below 400, unless it's an `exists: false` row asserting a path is gone.

## Consequences

- CI runs the matrix against a dev server started with `AUTH_KIT_MATRIX=1` on a localhost URL, after `next build` for the manifest. `startMatrixServer` starts it, with the server mode from [ADR 0016](0016-matrix-server-mode.md) so it needs no AWS.
- Verified end to end against a real `next dev`: an unguarded route fails the second pass; page-guard redirects and route-handler 401s pass; without the flag, every second-pass case fails with the reason.
- Server actions aren't routes in the manifest, so they still need rows written by hand. The matrix checks responses for the personas it's given, nothing more.
