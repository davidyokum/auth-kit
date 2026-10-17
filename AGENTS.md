# AGENTS.md

Guidance for AI agents (and people) working on auth-kit.

## What this is

A public TypeScript package (ESM, Node 22+) that implements David Yokum's login standard for his AWS Amplify Gen 2 + Next.js 16 sites. The standard's rule text lives in his private `passwords-flow` repo (`03-gold-standard-and-plan.md` §2 and `00-login-security-primer.md`); the README maps each rule to code. Pre-release: `0.1.1-alpha`, not in production.

## Rules

- **Public repo.** Never commit secrets, AWS account IDs, pool or client IDs, Amplify app IDs, or real site names. Use placeholders (`us-east-1_TestPool1`, `example.org`). `test/package/hygiene.test.ts` enforces the ID shapes.
- **No AWS calls** from code or tests that create, modify, or delete anything. Tests use the local issuer, the fake Cognito, and CDK synthesis.
- **Verify API shapes** against the installed packages' type definitions and AWS documentation. Where Amplify lacks a setting, use an L1 override and record why (see `docs/decisions/0006-*`).
- **Fail closed.** "Couldn't check" is 503 (`AuthUnavailableError`), never a pass and never "signed out".
- **Capabilities, not role names**, in any example or code path.
- Write files with escapes intact: some tools turn `\uXXXX` escapes into literal characters, which breaks regexes (use `String.fromCharCode` in tests).

## Commands

```sh
npm ci
npm run check   # typecheck + lint + test + build
```

## Layout

- `src/amplify` preset (`standardAuthProps`, `applyAuthStandard`, WAF), `src/amplify/pre-sign-up.ts`
- `src/server` verification, guards, capabilities, redirects, cookies, errors, page guards
- `src/proxy` `withAuthProxy`
- `src/testing` auth matrix (two passes, route coverage; ADR 0014), Next route manifests, test issuer, fakes
- `src/client` sign-in screens, the authenticator gate, and My account (React client components on Amplify JS v6; ADR 0008)
- `src/admin` phase-2 stubs with implemented pure checks
- `src/dev` the localhost kit (`auth-kit/dev`, `auth-kit/dev/menu`, `auth-kit/ribbon`, the `auth-kit` command; see `docs/localhost.md`). Only `ribbon.tsx` and `ribbon-model.ts` may reach a production build: never import the marker or other dev modules from them
- `src/shared/policy.ts` every concrete setting (lifetimes, limits, roles, capabilities); `src/shared/matrix-protocol.ts` the proxy ↔ matrix handler-pass contract
- `scripts/check-tarball.mjs` release tarball check (CI)
- `docs/decisions` ADRs

## Git

New, non-live repo: commit straight to `main`, small and often. Releases are tags (`v0.1.1-alpha`): bump `package.json` (and `package-lock.json`) and add a `CHANGELOG.md` section for the version, then push the tag. CI's `release` job builds, packs, attests, and attaches the tarball to a GitHub Release; it refuses a tag that doesn't match `package.json` or has no `CHANGELOG.md` section ([ADR 0012](docs/decisions/0012-release-tarballs.md)). There's no install-time build: run `npm run build` locally when you need `dist/`.
