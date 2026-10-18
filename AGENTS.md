# AGENTS.md

Guidance for AI agents (and people) working on auth-kit.

## What this is

A public TypeScript package (ESM, Node 22+) that implements David Yokum's login standard for his AWS Amplify Gen 2 + Next.js 16 sites. The standard's rule text lives in his private `passwords-flow` repo (`03-gold-standard-and-plan.md` §2 and `00-login-security-primer.md`); the README maps each rule to code. Pre-release: `0.1.5-alpha`, not in production. The starter site is [site-auth-kit-template](https://github.com/davidyokum/site-auth-kit-template).

## Rules

- **Public repo.** Never commit secrets, AWS account IDs, pool or client IDs, Amplify app IDs, or real site names. Use placeholders (`us-east-1_TestPool1`, `example.org`). `test/package/hygiene.test.ts` enforces the ID shapes.
- **No AWS calls** from code or tests that create, modify, or delete anything. Tests use the local issuer, the fake Cognito, and CDK synthesis, and run with `AWS_BLOCKED_ENV` (`test/package/no-aws.test.ts` is the canary). Never send a token to a server without a preloaded key set: its verifier would fetch the pool's JWKS from Cognito.
- **Verify API shapes** against the installed packages' type definitions and AWS documentation. Where Amplify lacks a setting, use an L1 override and record why (see `docs/decisions/0006-*`).
- **Fail closed.** "Couldn't check" is 503 (`AuthUnavailableError`), never a pass and never "signed out".
- **Capabilities, not role names**, in any example or code path.
- Write files with escapes intact: some tools turn `\uXXXX` escapes into literal characters, which breaks regexes (use `String.fromCharCode` in tests).

## Commands

```sh
npm ci
npm run check      # typecheck + lint + test + build
npm run test:e2e   # after build: the fixture app on real Next.js (test/e2e; CI runs it)
```

## Layout

- `src/amplify` preset (`standardAuthProps`, `applyAuthStandard`, WAF), `src/amplify/pre-sign-up.ts`
- `src/server` verification, guards, capabilities, redirects, cookies, errors, page guards
- `src/proxy` `withAuthProxy`
- `src/testing` auth matrix (two passes, route coverage; ADR 0014), Next route manifests, test issuer, fakes, `startMatrixServer` and the fixture (`matrix-run.ts`, `fixture.ts`), and `matrix-server.ts`: the matrix server mode (`auth-kit/testing/matrix-server`, ADR 0016), which apps import only behind a dev alias and which carries a marker `check-prod-build` finds
- `src/client` sign-in screens, the authenticator gate, and My account (React client components on Amplify JS v6; ADR 0008); `parity.ts` keeps the screens the same for every address until a factor is proven (ADR 0018): never show Cognito's per-account answer to a first-factor request
- `src/admin` People actions, the audit log, and the invite-expiry sweep (`sweep.ts`, kept free of Next.js and React because `invite-expiry-handler.ts` is bundled into a Lambda); `cdk.ts` holds `AuditLogTable` and `InviteExpirySweep` (ADR 0019)
- `src/dev` the localhost kit (`auth-kit/dev`, `auth-kit/dev/menu`, `auth-kit/ribbon`, the `auth-kit` command; see `docs/localhost.md`). Only `ribbon.tsx` and `ribbon-model.ts` may reach a production build: never import the marker or other dev modules from them
- `src/shared/policy.ts` every concrete setting (lifetimes, limits, the site-wide roles and their labels, descriptions, capabilities, and `ROLE_MATRIX`; ADR 0020); `src/shared/matrix-protocol.ts` the proxy ↔ matrix handler-pass contract
- `tsup.lambda.config.ts` the self-contained Lambda bundles (`dist/lambda/*`, AWS SDK included) that `auth-kit/admin/cdk` deploys; `npm run build` runs it after the main build, and the CDK tests build it if it's missing
- `scripts/check-tarball.mjs` release tarball check (CI)
- `test/e2e` a plain-JS Next fixture app and the e2e test that builds, runs, and matrix-tests it (`AUTH_KIT_E2E=1`)
- `docs/decisions` ADRs

## Git

New, non-live repo: commit straight to `main`, small and often. Releases are tags (`v0.1.5-alpha`): bump `package.json` (and `package-lock.json`) and add a `CHANGELOG.md` section for the version, then push the tag. CI's `release` job builds, packs, attests, and attaches the tarball to a GitHub Release; it refuses a tag that doesn't match `package.json` or has no `CHANGELOG.md` section ([ADR 0012](docs/decisions/0012-release-tarballs.md)). There's no install-time build: run `npm run build` locally when you need `dist/`.
