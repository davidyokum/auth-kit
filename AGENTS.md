# AGENTS.md

Guidance for AI agents (and people) working on auth-kit.

## What this is

A public TypeScript package (ESM, Node 22+) that implements David Yokum's login standard for his AWS Amplify Gen 2 + Next.js 16 sites. The standard's rule text lives in his private `passwords-flow` repo (`03-gold-standard-and-plan.md` §2 and `00-login-security-primer.md`); the README maps each rule to code. Pre-release: `0.1.9-alpha.3`, not in production. The starter site is [site-auth-kit-template](https://github.com/davidyokum/site-auth-kit-template).

## Rules

- **Public repo.** Never commit secrets, AWS account IDs, pool or client IDs, Amplify app IDs, or real site names. Use placeholders (`us-east-1_TestPool1`, `example.org`). `test/package/hygiene.test.ts` enforces the ID shapes.
- **No AWS calls** from code or tests that create, modify, or delete anything. Tests use the local issuer, the fake Cognito, and CDK synthesis, and run with `AWS_BLOCKED_ENV` (`test/package/no-aws.test.ts` is the canary). Never send a token to a server without a preloaded key set: its verifier would fetch the pool's JWKS from Cognito.
- **Verify API shapes** against the installed packages' type definitions and AWS documentation. Where Amplify lacks a setting, use an L1 override and record why (see `docs/decisions/0006-*`).
- **Fail closed.** "Couldn't check" is 503 (`AuthUnavailableError`), never a pass and never "signed out".
- **Help addresses** are role-based and required (a person's own only with `{ address, personal: true }`, register E4c): never commit a real one, except the personal family's decided defaults in `src/themes` (`help@yokum.app`, `sign-in@yokum.app`; register F11); examples use the placeholder `apps-help@replace-me.invalid` (which the code refuses) or `help@example.org` in tests.
- **Senders** are the site's reply-able `sign-in@` mailbox with the family's display name, never `noreply@` (register A10, E4a); the preset, the SES mailer, and the CDK jobs refuse anything else.
- **Capabilities, not role names**, in any example or code path. The resource roles' site floor is by capability too (`RESOURCE_SITE_FLOOR`).
- **Backdrops are decorative, never security.** No code or copy asks anyone to recognize a picture (ADR 0021). Released style versions and `kernel/v1` never change; see Layout.
- Write files with escapes intact: some tools turn `\uXXXX` escapes into literal characters, which breaks regexes (use `String.fromCharCode` in tests).

## Commands

```sh
npm ci
npm run check      # typecheck + lint + test + build
npm run test:e2e   # after build: the fixture app on real Next.js (test/e2e; CI runs it)
```

## Layout

- `src/amplify` preset (`standardAuthProps`, `applyAuthStandard`, WAF, `accountCreation`, `codeLifetimeMinutes`; Cognito's own `SignUp` is always off and synthesis fails otherwise), `src/amplify/pre-sign-up.ts` (`preSignUpForAccountCreation`) and `src/amplify/custom-message.ts` (Cognito's code emails): both Lambda handlers import nothing but pure modules (hygiene test)
- `src/server` verification, guards, capabilities, redirects, cookies, errors, page guards
- `src/proxy` `withAuthProxy`
- `src/testing` auth matrix (two passes, route coverage; ADR 0014), Next route manifests, test issuer, fakes, `startMatrixServer` and the fixture (`matrix-run.ts`, `fixture.ts`), and `matrix-server.ts`: the matrix server mode (`auth-kit/testing/matrix-server`, ADR 0016), which apps import only behind a dev alias and which carries a marker `check-prod-build` finds
- `src/client` the sign-in card, sign-up, request access, the authenticator gate, and My account (React client components on Amplify JS v6; ADR 0008, ADR 0024); every screen string is in `copy.ts` (the approved copy deck, Card Studio v4; Oxford commas, linted): change words there, never inline; `parity.ts` keeps the screens the same for every address until a factor is proven (ADR 0018): never show Cognito's per-account answer to a first-factor request. Client files import only their own files, `src/shared/`, `src/themes/`, `safeRedirect`, React, and Amplify (hygiene test)
- `src/accounts` account creation (ADR 0023): `routes.ts` (the sign-up and request routes: identical answers, rate limits, the response-time floor), `self-service.ts` (a member's own delete and email change), `sign-in-help.ts` (the help address in effect and the Super admin override, ADR 0024), `stores.ts` and `schema.ts` (requests, rate limits, settings), and the jobs (`unverified-sweep.ts`, `digest.ts`, and their `*-handler.ts` Lambda entries: no Next.js or React). `src/shared/account-creation.ts` (the setting's rules) and `src/shared/emails.ts` (every auth email's words and layout) are pure; `src/themes/` holds the families (pure)
- `src/admin` People actions (including the access-request queue), the audit log, and the invite-expiry sweep (`sweep.ts`, kept free of Next.js and React because `invite-expiry-handler.ts` is bundled into a Lambda); `cdk.ts` holds `AuditLogTable`, `InviteExpirySweep` (ADR 0019), `ResourceAccessTable`, and the account-creation tables and jobs (ADR 0023), the jobs sharing `createScheduledJob`; `action-kit.ts` and `invite-core.ts` are what the People actions and the resource actions share (input checks, failures; the invite's account steps, documented in the file: reuse them for any new way of bringing someone in)
- `src/resources` resource roles (ADR 0022): `policy.ts` (pure: types, the combining rule, `checkAccessChange`, the words; shared by the server and the UI), `types.ts` (plain types, the form fields), `schema.ts` (the table layout, no imports), `store.ts` (the store contract and the in-memory store), `dynamo.ts`, `actions.ts` (`createResourceActions`), `ui.tsx` (`auth-kit/resources/ui`, client only: never import `actions.ts` or `dynamo.ts` from it). `requireResourceRole` lives on `ServerAuth` (`src/server/auth.ts`). Screens never say "resource" or "record", and never show an item's ID: they use the type's noun and the app's `resourceName` ("the project “Roads 2027”", else "this project"); `test/resources/wording.test.ts` checks
- `src/dev` the localhost kit (`auth-kit/dev`, `auth-kit/dev/menu`, `auth-kit/ribbon`, the `auth-kit` command; see `docs/localhost.md`). Only `ribbon.tsx` and `ribbon-model.ts` may reach a production build: never import the marker or other dev modules from them
- `src/backdrops` the art behind the sign-in card (ADR 0021): `kernel/v1/` (generator, noise, colors; **frozen**), `styles/<id>/v<n>.ts` (one file per released style version; **frozen once released**: a change in look is a new version file; heavy data in the style's `data.ts`, subject keys in `subjects.ts`) registered in `styles/registry.ts` through each style's `index.ts`, which declares its versions with `lazyVersion` (metadata there, the code loaded on first use, in its own chunk), `styles/plotter/v1.ts` (the plotted sheets' shared core; **frozen** like the kernel), `subjects.ts` (subject rotation: tour, random, of the day, fixed; per browser, never server-side), `render.ts` (the loop and its rules: reduced motion, a still frame on slow devices, settled drawings at rest, visibility, caps, passive pointer, waiting for a style's code), `card.ts` and `contrast.ts` (the card carries its own contrast; nothing fades the art around it), `variations.ts` (choices, defaults, the lock check), `react.tsx`, and `picker.tsx` (dev only; carries `BACKDROP_PICKER_MARKER`). `test/backdrops/frozen.json` pins every released version; add a version's hash with `AUTH_KIT_FREEZE_NEW=1 npx vitest run test/backdrops/frozen.test.ts`, never by editing an existing one. `npm run demo:backdrops` serves `docs/backdrops/`
- `src/shared/policy.ts` every concrete setting (lifetimes, limits, the site-wide roles and their labels, descriptions, capabilities, and `ROLE_MATRIX`; ADR 0020); `src/shared/matrix-protocol.ts` the proxy ↔ matrix handler-pass contract
- `tsup.lambda.config.ts` the self-contained Lambda bundles (`dist/lambda/invite-expiry`, `unverified-sweep`, `access-request-digest`; AWS SDK included) that `auth-kit/admin/cdk` deploys; `npm run build` runs it after the main build, and the CDK tests build it if it's missing
- `scripts/check-tarball.mjs` release tarball check (CI)
- `test/e2e` a plain-JS Next fixture app and the e2e test that builds, runs, and matrix-tests it (`AUTH_KIT_E2E=1`)
- `docs/decisions` ADRs

## Git

New, non-live repo: commit straight to `main`, small and often. Releases are tags (`v0.1.5-alpha`): bump `package.json` (and `package-lock.json`) and add a `CHANGELOG.md` section for the version, then push the tag. CI's `release` job builds, packs, attests, and attaches the tarball to a GitHub Release; it refuses a tag that doesn't match `package.json` or has no `CHANGELOG.md` section ([ADR 0012](docs/decisions/0012-release-tarballs.md)). There's no install-time build: run `npm run build` locally when you need `dist/`.
