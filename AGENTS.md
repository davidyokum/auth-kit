# AGENTS.md

Guidance for AI agents (and people) working on auth-kit.

## What this is

A public TypeScript package (ESM, Node 22+) that implements David Yokum's login standard for his AWS Amplify Gen 2 + Next.js 16 sites. The standard's rule text lives in his private `passwords-flow` repo (`03-gold-standard-and-plan.md` §2 and `00-login-security-primer.md`); the README maps each rule to code. Pre-release: `0.1.0-alpha`, not in production.

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
- `src/testing` auth matrix, test issuer, fakes
- `src/client`, `src/admin`, `src/dev` phase-2 stubs with implemented pure checks
- `src/shared/policy.ts` every concrete setting (lifetimes, limits, roles, capabilities)
- `docs/decisions` ADRs

## Git

New, non-live repo: commit straight to `main`, small and often. Releases are tags (`v0.1.0-alpha`); bump `package.json` and `CHANGELOG.md` with each tag.
