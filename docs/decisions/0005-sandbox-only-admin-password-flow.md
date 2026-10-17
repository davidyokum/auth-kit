# 0005. `ADMIN_USER_PASSWORD_AUTH` on sandbox clients only

- **Status:** Accepted, 2026-10-17
- **Standard:** 03 §2 Local development; primer §10 (Chapter 8)

## Context

AI coding tools' built-in browsers can't reach a password manager, and seeing what each role sees means juggling accounts. The fix is seeded test personas and a "Sign in as…" route that signs a persona in for real with `AdminInitiateAuth`, so the app checks real tokens. That flow must never exist on a live pool: a dev bypass gated by one setting is how a demo-admin bypass reached a live site.

## Decision

- The preset reads Amplify's CDK context (`amplify-backend-type`). Only a sandbox deployment gets `ALLOW_ADMIN_USER_PASSWORD_AUTH` on its app client, and only a sandbox pool is tagged `Environment=sandbox`. A branch named `sandbox` is tagged `branch-sandbox`, and the `environment` option can't be set to `sandbox`.
- Anything that seeds accounts or signs people in calls `assertSandboxPool` and refuses a pool without that tag.
- "Sign in as…" answers 404 unless three gates pass: `NODE_ENV === 'development'`, a `localhost` / `*.localhost` host, and `ALLOW_DEV_SIGNIN === '1'`. The dev server binds to `127.0.0.1` so a stranger on the same network can't send `Host: localhost`.
- Phase 2 adds the exchange itself, the persona seeding script (which asserts the AWS account before writing), and the CI check that a production build doesn't contain the route.

## Consequences

- Sandboxes also skip deletion protection (so `ampx sandbox delete` works) and, by default, the billed web ACL.
- Personas use `.test` addresses (a reserved TLD that never delivers mail) and passwords from a git-ignored `.env.local`; `parsePersonas` refuses anything else.
- A local app pointed at a non-sandbox pool shows a red ribbon (`environmentRibbonModel`).
