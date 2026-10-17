# auth-kit

Shared login and authorization for David Yokum's websites. Every site runs on AWS Amplify (Gen 2) with an Amazon Cognito user pool and Next.js 16; auth-kit is the one place the login rules live, so a fix ships by bumping a version instead of copying code between sites.

> **Status: pre-release (`0.1.0-alpha`). Not yet used in production.** Phase 1 ships the backend preset, the server checks, the proxy, and the test helpers. The sign-in screens, the admin People page, and the localhost kit are typed stubs that throw `NotImplementedError` until phase 2. The starter site that wires all of this up is [`site-auth-kit-template`](https://github.com/davidyokum/site-auth-kit-template) (coming later).

## What it does

| Subpath | What it gives a site | Phase 1 |
|---|---|---|
| `auth-kit/amplify` | A Gen 2 auth preset: one pool per app, invite-only, passkey first, password + authenticator second, emailed code as the backstop, standard token lifetimes, deletion protection, SES from a verified domain, standard groups, a WAF rate rule, sandbox detection | **Implemented** |
| `auth-kit/amplify/pre-sign-up` | The one sanctioned exception to invite-only: a preSignUp Lambda that allows self-registration from listed email domains | **Implemented** |
| `auth-kit/server` | `verifyAccessToken`, `getUser`, `requireUser`, `requireGroup`, `requireCan`, live group re-reads, step-up, record checks (404), `safeRedirect`, cookie and origin helpers, 401/403/404/503 conventions | **Implemented** |
| `auth-kit/proxy` | `withAuthProxy()` for `proxy.ts`: default-deny, verifies tokens, explicit public routes, optional server-side refresh | **Implemented** |
| `auth-kit/testing` | Auth-matrix tests (anonymous, member, admin, and a second member on record routes), a local test token issuer, cookie personas, a fake Cognito | **Implemented** |
| `auth-kit/client` | Sign-in screens (passkey autofill, password + TOTP, emailed code), the authenticator gate, My account | Interfaces, autocomplete tokens, and the after-sign-in decision; UI stubbed |
| `auth-kit/admin` | The People page actions and an append-only audit log | Guardrails implemented; actions and audit log stubbed |
| `auth-kit/dev` | The localhost kit: personas, triple-gated "Sign in as…", environment ribbon, production-build check | Gates, sandbox guard, persona validation, ribbon model implemented; seeding, sign-in exchange, component, build check stubbed |

## Install

From a GitHub tag (the package isn't on npm):

```sh
npm i github:davidyokum/auth-kit#v0.1.0-alpha
```

npm builds the package on install (its `prepare` script installs the build tools and runs the build), which adds about a minute compared with a registry package.

Peer dependencies, all optional, depending on the subpaths you use: `@aws-amplify/backend`, `aws-cdk-lib`, `constructs` (for `auth-kit/amplify`), `next` (for `auth-kit/proxy` and page helpers), `react`.

## Quick start

### 1. The pool: `amplify/auth/resource.ts` and `amplify/backend.ts`

```ts
// amplify/auth/resource.ts
import { defineAuth } from '@aws-amplify/backend';
import { standardAuthProps, type AuthStandardOptions } from 'auth-kit/amplify';

export const authOptions = {
  project: 'example-reports',
  owner: 'reports-team',
  tier: 2,
  email: { fromAddress: 'noreply@example.org', fromName: 'Example Reports' },
  // Switch passkeys on once the final custom domain is live:
  // passkeys: { relyingPartyId: 'reports.example.org' },
  appRoles: ['reviewer'],
} satisfies AuthStandardOptions;

export const auth = defineAuth(standardAuthProps(authOptions));
```

```ts
// amplify/backend.ts
import { defineBackend } from '@aws-amplify/backend';
import { applyAuthStandard } from 'auth-kit/amplify';
import { auth, authOptions } from './auth/resource';

const backend = defineBackend({ auth });
applyAuthStandard(backend.auth, authOptions);
```

Why two calls: Amplify fails synthesis unless `defineAuth` is called directly from `amplify/auth/resource.ts`, so the preset returns props for your own `defineAuth` call. Settings `defineAuth` can't express are applied in `backend.ts` as CDK overrides ([ADR 0006](docs/decisions/0006-preset-props-plus-l1-overrides.md)).

### 2. One auth file and one capability file per app

```ts
// lib/capabilities.ts: the ONLY place group names appear
import { defineCapabilities, STANDARD_CAPABILITIES } from 'auth-kit/server';

export const capabilities = defineCapabilities({
  ...STANDARD_CAPABILITIES,
  reviewer: ['reviews.read', 'reviews.comment'],
});
```

```ts
// lib/auth.ts
import { createPageGuards, createServerAuth, poolConfigFromAmplifyOutputs } from 'auth-kit/server';
import outputs from '@/amplify_outputs.json';
import { capabilities } from './capabilities';

export const auth = createServerAuth({ ...poolConfigFromAmplifyOutputs(outputs), capabilities });
export const pages = createPageGuards(auth);
```

### 3. Check on the server, for the data, on every request

```ts
// app/api/reports/[id]/route.ts
import { withAuthErrors } from 'auth-kit/server';
import { auth } from '@/lib/auth';

export const GET = withAuthErrors(async (_req, { params }) => {
  const user = await auth.requireCan('reviews.read');
  const report = auth.requireRecordAccess(user, await loadReport((await params).id), {
    owner: (r) => r.ownerSub,
    members: (r) => r.reviewerSubs,
    coveredBy: 'audit.read', // a capability that sees every record
  }); // anyone else gets 404, not 403
  return Response.json(report);
});
```

```ts
// app/admin/people/page.tsx (server component)
const user = await pages.requireCan('people.manage', { live: true }); // re-reads groups from Cognito
```

```ts
// A risky action (grant a role, export data): require a sign-in in the last 5 minutes
await auth.requireCan('roles.manage', { live: true, recentSignIn: true });
```

### 4. The proxy: `proxy.ts`

```ts
import { withAuthProxy } from 'auth-kit/proxy';
import { auth } from '@/lib/auth';

export const proxy = withAuthProxy({ auth, publicRoutes: ['/', '/about', '/legal/*'] });

// Must be a literal: Next reads the matcher at build time.
export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
```

The proxy is the first checkpoint, never the only one. Add `refresh: amplifyAdapterRefresh({ runWithAmplifyServerContext, fetchAuthSession })` so expired sessions refresh server-side instead of bouncing to sign-in every hour.

### 5. Auth-matrix tests

```ts
import { assertAuthMatrix, bearerPersona } from 'auth-kit/testing';

await assertAuthMatrix({
  request: (req) => fetch(req, { redirect: 'manual' }),
  baseUrl: 'http://app.localhost:3000',
  personas: { anonymous: {}, member: bearerPersona(m), otherMember: bearerPersona(m2), admin: bearerPersona(a) },
  params: { id: memberOwnReportId },
  routes: [
    { path: '/api/reports/:id', expect: { anonymous: 401, member: 200, otherMember: 404, admin: 200 } },
    { method: 'POST', path: '/api/admin/invite', expect: { anonymous: 401, member: 403, admin: 200 } },
  ],
});
```

It refuses an incomplete matrix: every route needs anonymous, member, and admin; every route that takes a record ID needs the second member, and expects 404 from them.

## Status codes

| Status | Meaning | Error class |
|---|---|---|
| 401 | No valid session (missing, forged, expired, revoked, disabled) | `UnauthenticatedError` |
| 401 | Signed in, but this action needs a fresh sign-in (`WWW-Authenticate: … insufficient_user_authentication`) | `StepUpRequiredError` |
| 403 | Signed in, and not allowed | `ForbiddenError` |
| 403 | A password user without an authenticator code: send them to setup | `MfaEnrollmentRequiredError` |
| 404 | The record isn't theirs (or doesn't exist; the route doesn't say which) | `NotFoundError` |
| 503 | Couldn't check (Cognito or its keys unreachable). Never treated as signed out or allowed | `AuthUnavailableError` |

Pages turn 401 into a sign-in redirect with a safe `next` path, missing TOTP into the setup page, and 403/404 into Next's not-found page.

## How the standard maps to the code

Keyed to §2 ("the rules") of David's login standard, `03-gold-standard-and-plan.md`, which is kept privately; the rule text lives there. **Pkg** = enforced by this package; **App** = the site's own code or the template; **Ops** = AWS, DNS, or process outside code; **P2** = phase 2; **Gap** = not enforceable by this package (see the row, or the sections below).

| 03 §2 rule | Where | Status |
|---|---|---|
| **Identity** | | |
| One pool per app, defined in `amplify/auth/resource.ts` | `standardAuthProps` → your `defineAuth` | Pkg |
| Deployed by the branch pipeline, never hand-edited | Tags `ManagedBy=auth-kit`; sandboxes tagged apart | Ops |
| Shared pools via `referenceAuth`, own client and groups | Not covered: a referenced pool can't take the preset's overrides | Gap |
| Deletion protection on | `applyAuthStandard` (off in sandboxes so `ampx sandbox delete` works) | Pkg |
| Tagged Project / Owner / Environment / Tier | `applyAuthStandard` | Pkg |
| Machine identities (IAM role, client credentials) | Server refuses machine tokens as people; scope checks not built | P2 |
| **Sign-in** | | |
| Passkey, password + TOTP, emailed code; `ALLOW_USER_AUTH` | Sign-in policy `WEB_AUTHN`/`PASSWORD`/`EMAIL_OTP`; client flows exactly `ALLOW_USER_AUTH` + refresh | Pkg (UI P2) |
| MFA optional, TOTP only; app requires TOTP of password users | Preset; `requireUser` refuses (403 `mfa_enrollment_required`) via `GetUserAuthFactors` | Pkg (setup screen P2) |
| Passwords ≥ 15, no composition rules | Preset password policy | Pkg |
| Breached-password check | Plus threat protection on Tier 3; Have I Been Pwned check for Tier 2 not built | Partial (P2) |
| `autocomplete` tokens, paste never blocked | `SIGN_IN_AUTOCOMPLETE` | Pkg (UI P2) |
| Essentials plan + SES | `UserPoolTier`, `EmailConfiguration` with the domain identity | Pkg |
| WAF web ACL with a per-IP rate rule | `createAuthWebAcl` (sign-in rule + overall rule) | Pkg ([caveat](#verify-on-the-first-sandbox-deploy)) |
| `AuthSessionValidity` 3 minutes | Preset | Pkg |
| Passkeys: user verification, count as MFA, final-domain RP ID | `WebAuthnUserVerification`, `WebAuthnFactorConfiguration`, RP ID validation | Pkg |
| `PreventUserExistenceErrors` | Preset | Pkg |
| Invites with no password and no `email_verified` | `PeopleActions.invite` | P2 |
| **Sessions** | | |
| Access/ID 60 min; refresh 30 days (Tier 2) or ≤ 1 day (Tier 3) | Preset (ceilings enforced; admin pools ≤ 1 day) | Pkg |
| Token revocation on | Preset | Pkg |
| Global sign-out; people manage their own passkeys | `signOutEverywhere`, `MyAccount` | P2 |
| Step-up for risky actions via `auth_time` | `requireRecentSignIn`, `recentSignIn` option | Pkg |
| Five token checks, access tokens only | `verifyAccessToken` (`aws-jwt-verify`) | Pkg |
| Removal is `AdminDisableUser` | Live checks refuse disabled users at once; the action itself is P2 | Partial |
| Secure, SameSite cookies; strict CSP; origin check | `secureCookieOptions`, `amplifyCookieRuntimeOptions`, `assertSameOrigin`; CSP in the template | Pkg / App |
| Amplify `ssr: true` client | Server reads its cookies and verifies them itself; the adapter refreshes in the proxy | Pkg ([ADR 0007](docs/decisions/0007-verify-tokens-in-auth-kit.md)) |
| **Enforcement** | | |
| Default-deny proxy that validates tokens | `withAuthProxy` | Pkg |
| Every route, action, data-loading component checks | `requireUser` / `requireGroup` / `requireCan`; caught by the auth matrix | Pkg + App |
| Record-ID routes check the record; others get 404 | `requireRecordAccess`; the matrix demands 404 for a second member | Pkg |
| Sensitive data only through checked routes | Site code; posture check later | App |
| Private pages `Cache-Control: private, no-store` | Proxy sets it on protected responses; `PRIVATE_NO_STORE` | Pkg + App |
| Post-login redirects through `safeRedirect` | `safeRedirect`; `signInUrl` uses it | Pkg |
| Gen 2 data rules; admin data re-checked live | `liveState` for the function; rules live in the site | App |
| **Roles and lifecycle** | | |
| Roles only from Cognito groups | Preset groups `superadmin`, `admin`, `editor`, `viewer`, + app roles | Pkg |
| Capabilities mapped in one file | `defineCapabilities` | Pkg |
| Admin routes re-read status and groups (~1 min cache) | `requireCan(…, { live: true })` | Pkg |
| Self-signup off; `preSignUp` allowlist exception | Admin-create-only; `selfSignUp` + `preSignUpAllowlist` (synthesis fails without the trigger) | Pkg |
| Unused invites disabled after 7 days, flagged | `inviteStatus`; `expireStaleInvites` | Partial (P2) |
| Recovery defined | Email recovery (everyday), admin-only (admin pool); admin MFA reset P2 | Partial |
| Email changes admin-only | Can't be enforced in the pool ([why](#what-the-pool-cant-enforce)) | Gap |
| First admin bootstrapped once at deploy | Not built | P2 |
| **Admin area** | | |
| Separate keys; grant below your own level; nobody changes their own role; keep an owner | `checkPeopleAction`, `grantableRoles` | Pkg (pages P2) |
| People page buttons and copy | `PeopleActions`, `PEOPLE_ACTION_COPY` | P2 |
| Append-only audit log, written with the change | `AuditLogStore` interface (no update or delete) | P2 |
| Rich text, uploads, drafts | Not in this package yet | App / later |
| **Foundation** | SES domain identity required by the preset; SPF/DKIM/DMARC, private database, compute role, master keys, break-glass, secrets, branch passwords | Ops / App |
| **Local development** | | |
| Sandbox pool tagged `Environment=sandbox`; seeding refuses others | Preset tags it; `assertSandboxPool` | Pkg (seeding P2) |
| Personas from `personas.json`, `.test` addresses | `parsePersonas`, `defaultPersonas` | Pkg (seeding P2) |
| "Sign in as…" behind three gates, loopback, sandbox-only admin flow | `checkDevSignInGates`; `ALLOW_ADMIN_USER_PASSWORD_AUTH` only on sandbox clients | Pkg (exchange P2) |
| Dev sign-in absent from production builds, CI-tested | `checkProductionBuild` | P2 |
| Ribbon naming environment, pool, persona | `environmentRibbonModel` | Pkg (component P2) |
| **Assurance** | | |
| Auth-matrix tests in CI | `assertAuthMatrix` | Pkg |

## Verify on the first sandbox deploy

These were checked against the installed packages and AWS documentation, but not against a live pool. Deploying a sandbox needs David's approval.

- **Admin pool MFA ON with passkeys.** `defineAuth` rejects passkeys with MFA `REQUIRED` (it doesn't model `FactorConfiguration`), so the preset raises `MfaConfiguration` to `ON` in a CDK override. AWS documents that a user-verified passkey satisfies required MFA; whether CloudFormation accepts this exact combination is untested.
- **The WAF sign-in rule's header match.** Cognito forwards `x-amzn-cognito-operation-name` to WAF, but AWS doesn't document its value format. The rule matches case-insensitively on the operation name (and on `x-amz-target`). Run it in `count` mode first; the overall per-IP rule needs no header match.
- **Choice-based sign-in without a managed-login domain.** AWS's overview says passwordless and passkey sign-in need one; other AWS pages say SDK apps don't. The preset doesn't create a domain.

## What the pool can't enforce

- **Email changes admin-only.** Cognito requires app clients to be able to write required attributes, and email is required, so a signed-in person can start an email change. The pool keeps the old address active until the new one is verified with a code (Amplify's `keepOriginal`). The admin-only rule has to live in the app.
- **A strictly passkey-only admin pool.** Cognito won't let someone register a passkey before they've signed in once, and in a pool without emailed codes `AdminCreateUser` needs a temporary password. So an admin pool keeps `PASSWORD` as a first factor: a new admin signs in with a one-time password, sets a password and an authenticator (MFA is required), then saves a passkey. Recovery is admin-only. Phase 2 decides how to neutralize the password afterwards.

## Development

```sh
npm ci
npm run check   # typecheck, lint, test, build
```

Tests make no AWS calls: tokens come from a local test issuer, Cognito is faked, and the preset is checked by CDK synthesis and assertions. Decisions are recorded in [docs/decisions](docs/decisions). Agents: read [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)
