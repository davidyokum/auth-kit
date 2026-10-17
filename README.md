# auth-kit

Shared login and authorization for David Yokum's websites. Every site runs on AWS Amplify (Gen 2) with an Amazon Cognito user pool and Next.js 16; auth-kit is the one place the login rules live, so a fix ships by bumping a version instead of copying code between sites.

> **Status: pre-release (`0.1.2-alpha`). Not yet used in production.** Phase 1 ships the backend preset, the server checks, the proxy, and the test helpers. Phase 2 adds the sign-in screens and My account (`auth-kit/client`), the localhost kit (`auth-kit/dev`, `auth-kit/ribbon`; [guide](docs/localhost.md)), and the admin module (`auth-kit/admin`). The starter site that wires all of this up, with the auth matrix in CI, is [`site-auth-kit-template`](https://github.com/davidyokum/site-auth-kit-template): start a new site from it.

## What it does

| Subpath | What it gives a site | Phase 1 |
|---|---|---|
| `auth-kit/amplify` | A Gen 2 auth preset: one pool per app, invite-only, passkey first, password + authenticator second, emailed code as the backstop, standard token lifetimes, deletion protection, SES from a verified domain, standard groups, a WAF rate rule, sandbox detection | **Implemented** |
| `auth-kit/amplify/pre-sign-up` | The one sanctioned exception to invite-only: a preSignUp Lambda that allows self-registration from listed email domains | **Implemented** |
| `auth-kit/server` | `verifyAccessToken`, `getUser`, `requireUser`, `requireGroup`, `requireCan`, live group re-reads, step-up, record checks (404), `safeRedirect`, cookie and origin helpers, 401/403/404/503 conventions | **Implemented** |
| `auth-kit/proxy` | `withAuthProxy()` for `proxy.ts`: default-deny, verifies tokens, explicit public routes, optional server-side refresh, request and response headers (a nonce CSP) | **Implemented** |
| `auth-kit/testing` | Auth-matrix tests (anonymous, member, admin, and a second member on record routes), `startMatrixServer` (the app under `next dev` with no AWS), a local test token issuer, cookie personas, a fake Cognito, `AWS_BLOCKED_ENV` | **Implemented** |
| `auth-kit/testing/matrix-server` | The matrix server mode the app swaps in while the matrix runs (test issuer's keys, scripted Cognito, read-only People, in-memory audit log). **Dev only, behind an alias; never in a build** | **Implemented** |
| `auth-kit/client` | Sign-in screens (passkey, password + TOTP, emailed code), first sign-in after an invite, the authenticator gate, My account | **Implemented** (phase 2) |
| `auth-kit/admin` | The People page actions and an append-only audit log | **Implemented** (phase 2) |
| `auth-kit/admin/ui` | People table, invite form, role-change dialog, Activity log (React client components) | **Implemented** (phase 2) |
| `auth-kit/admin/cdk` | `AuditLogTable`: the audit log's DynamoDB table (deletion protection, PITR, deny-edits policy, tamper alerts) | **Implemented** (phase 2) |
| `auth-kit/dev` | The localhost kit ([guide](docs/localhost.md)): personas and seeding, gated "Sign in as…", the loopback and sandbox checks, `withDevKit`, the production-build and route checks. **Dev only; never in a build** | **Implemented** (phase 2) |
| `auth-kit/dev/menu` | The "Sign in as…" persona menu (client component). **Dev only** | **Implemented** (phase 2) |
| `auth-kit/ribbon` | The environment ribbon, `[DEV]`/`[PREVIEW]` title and favicon, and the View as banner. Safe in production builds | **Implemented** (phase 2) |

## Install

From the release tarball (the package isn't on npm):

```sh
npm i https://github.com/davidyokum/auth-kit/releases/download/v0.1.2-alpha/auth-kit-0.1.2-alpha.tgz
```

Commit the lockfile: it pins the tarball's `sha512`, so `npm ci` refuses a tarball that changed. Each release is built once by this repo's CI from the tagged commit, and nothing of auth-kit's builds or runs on your machine. To check a tarball came from that CI: `gh attestation verify auth-kit-0.1.2-alpha.tgz --repo davidyokum/auth-kit` ([ADR 0012](docs/decisions/0012-release-tarballs.md)). Don't install from a `github:` URL: there's no install-time build any more, so you'd get a package without `dist/`.

Peer dependencies, all optional, depending on the subpaths you use: `@aws-amplify/backend`, `aws-cdk-lib`, `constructs` (for `auth-kit/amplify`), `next` (for `auth-kit/proxy` and page helpers), `react` and `aws-amplify` (for `auth-kit/client`).

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

`getUser()` is for optional display (a header that says who's signed in). It applies the same authenticator rule as `requireUser()`, so a password user without TOTP comes back as `null` unless you pass `allowMfaEnrollment: true`. Gate with `requireUser` / `requireCan`, which also say *why* someone is refused.

Route handlers that change data call `assertSameOrigin(request, { expectedOrigin })`, with `expectedOrigin` set from configuration **in every environment**:

```ts
// lib/origin.ts: never from request headers
export const expectedOrigin =
  process.env.NODE_ENV === 'development'
    ? (process.env.APP_DEV_ORIGIN ?? 'http://reports.localhost:3000') // localDevServer(...).url; the matrix's server sets its own (step 5)
    : process.env.APP_ORIGIN;

// app/api/reports/route.ts
export const POST = withAuthErrors(async (request: Request) => {
  assertSameOrigin(request, { expectedOrigin });
  // ...
});
```

Without it, `Origin` is compared with the origin rebuilt from `request.url`, which can have the wrong scheme behind a CDN, and whose host `next dev` rewrites to `localhost` whatever the browser asked for (Next 16). So under `next dev`, and only when `request.url` and the `Host` header are both loopback, the check also accepts the origin the browser used (`http://<Host>`); a deployed build never takes that path.

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

The proxy is the first checkpoint, never the only one. Public routes are exact paths, prefixes ending in `/*`, or RegExps anchored as `/^…$/`; a rule that would make every path public (`'/*'`, an unanchored or catch-all pattern) throws at startup, as does any unknown option.

To refresh expired sessions server-side instead of bouncing to sign-in every hour, add the adapter, created with `amplifyCookieRuntimeOptions` so the cookies it writes are Secure, SameSite=Lax, and expire with the refresh token:

```ts
// lib/amplify-server.ts
import { createServerRunner } from '@aws-amplify/adapter-nextjs';
import { amplifyCookieRuntimeOptions } from 'auth-kit/server';
import outputs from '@/amplify_outputs.json';

export const { runWithAmplifyServerContext } = createServerRunner({
  config: outputs,
  runtimeOptions: amplifyCookieRuntimeOptions({
    refreshTokenMinutes: 43200, // the preset's refreshTokenMinutes
    localDevOrigin: process.env.NODE_ENV === 'development' ? 'http://app.localhost:3000' : undefined,
  }),
});

// proxy.ts
export const proxy = withAuthProxy({
  auth,
  publicRoutes: ['/', '/about', '/legal/*'],
  refresh: amplifyAdapterRefresh({ runWithAmplifyServerContext, fetchAuthSession }),
});
```

The proxy refreshes only an Amplify cookie session whose access token is genuine (this pool, this app client) but expired and that has a refresh-token cookie; never an anonymous, forged, or bearer request. Refreshes are public Cognito calls from the server's own IP address, so they count toward the pool's WAF per-IP rules; the proxy limits them per person and per server instance and backs off after failures (`refreshLimits`, `onRefresh` for logging; [ADR 0004](docs/decisions/0004-waf-rate-rule.md)).

The browser writes its own token cookies (sign-in, client-side refreshes) through Amplify's `CookieStorage`, which defaults to a 365-day lifetime; `configureAuthClient` (step 6) gives them the refresh token's lifetime too.

#### A strict Content-Security-Policy with a nonce

The standard asks for a strict CSP because Amplify's token cookies are readable by page scripts. With the App Router that means a fresh nonce per request, set in the proxy: Next reads it from the **request's** `Content-Security-Policy` header and stamps its own scripts with it, and the browser enforces the policy from the response. `nonceCspHeaders` does both through the proxy's `headers` hook:

```ts
// proxy.ts
import { nonceCspHeaders, withAuthProxy } from 'auth-kit/proxy';

const dev = process.env.NODE_ENV === 'development';

export const proxy = withAuthProxy({
  auth,
  publicRoutes: ['/', '/about', '/legal/*'],
  headers: nonceCspHeaders((nonce) =>
    [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`, // React's dev tooling needs eval
      `style-src 'self' ${dev ? "'unsafe-inline'" : `'nonce-${nonce}'`}`,
      "img-src 'self' data: blob:",
      // The browser calls Cognito directly; the breached-password check calls Have I Been Pwned.
      "connect-src 'self' https://cognito-idp.us-east-1.amazonaws.com https://api.pwnedpasswords.com",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  ),
});
```

- **Render per request.** A nonce can't be baked into a static page: call `await connection()` (from `next/server`) in the root layout. Pages get the nonce in `x-nonce` for their own `<Script nonce>`.
- **Every response.** The hook runs once per request, before the auth decision. Its `request` headers reach pages and routes on every pass-through (public or protected); its `response` headers go on every response, sign-in redirects and refusals included. The proxy drops any CSP request header a client sends, so the nonce Next uses only ever comes from the app.
- **Your own headers.** Pass any function: `headers: (request) => ({ request: { … }, response: { … } })`, sync or async. It can't set what auth depends on: the request's `cookie`, `authorization`, `host`, client-address and `x-forwarded-*` headers, auth-kit's `x-auth-kit-*`, or Next's internals; nor the response headers the proxy owns (`set-cookie`, `location`, `cache-control`, and the refusal's body headers). Those throw, and the request fails closed (`RESERVED_REQUEST_HEADERS`, `RESERVED_RESPONSE_HEADERS`).
- **Paths the matcher skips** (`/_next/static/*`) get no proxy headers. Send the nonce-free directives (`object-src`, `base-uri`, `form-action`, `frame-ancestors`), HSTS, and `X-Content-Type-Options` from `next.config.ts` `headers()` as a baseline; the proxy's full policy replaces it on the responses it handles. The [template](https://github.com/davidyokum/site-auth-kit-template) has the full set (`lib/security-headers.ts`).

### 5. Auth-matrix tests

The matrix runs every route as every persona against the real app under `next dev`, in CI, with no AWS at all. `startMatrixServer` mints each persona a session with a local test issuer, starts `next dev` on 127.0.0.1 with `AUTH_KIT_MATRIX=1` and a fixture describing each persona, and hands back their cookies:

```ts
// test/matrix/auth-matrix.test.ts: run after `next build` (the matrix reads its route manifest)
import { assertAuthMatrix, routesFromNextBuild, startMatrixServer } from 'auth-kit/testing';

const server = await startMatrixServer({
  personas: {
    member: {},
    otherMember: {},
    admin: { groups: ['admin'] },
    noAuthenticator: { factors: { configured: ['PASSWORD'], mfa: [] } }, // a password user without TOTP
    demotedAdmin: { groups: ['admin'], liveGroups: [] }, // the token says admin, Cognito no longer does
    disabledAdmin: { groups: ['admin'], enabled: false },
    revokedSession: { groups: ['editor'], sessionRevoked: true }, // signed out everywhere
  },
  env: { APP_DEV_ORIGIN: 'http://127.0.0.1:3210' }, // whatever your expectedOrigin reads in development
  port: 3210,
});
try {
  await assertAuthMatrix({
    request: (req) => fetch(req, { redirect: 'manual' }),
    baseUrl: server.baseUrl,
    appRoutes: routesFromNextBuild('.next'),
    personas: server.cookiePersonas, // anonymous plus each persona's Amplify cookies
    params: { id: memberOwnReportId },
    routes: [
      { path: '/api/reports/:id', expect: { anonymous: 401, member: 200, otherMember: 404, admin: 200, noAuthenticator: 403 /* … */ } },
      { method: 'POST', path: '/api/admin/invite', headers: { origin: server.baseUrl }, expect: { anonymous: 401, member: 403, admin: 200 /* … */ } },
    ],
  });
} finally {
  await server.stop();
}
```

The app swaps in the **matrix server mode** while it runs, through a dev-only alias like `@/dev` ([ADR 0016](docs/decisions/0016-matrix-server-mode.md)):

```ts
// lib/dev/matrix.on.ts: what @/dev-matrix means under next dev
export { matrixServerOverrides as matrixOverrides } from 'auth-kit/testing/matrix-server';

// lib/dev/matrix.off.ts: what it means in every build (tsconfig paths point here too)
import type { MatrixServerOverrides } from 'auth-kit/testing/matrix-server';
export function matrixOverrides(): MatrixServerOverrides | null {
  return null;
}

// next.config.ts
import { DEV_ALIAS, DEV_MATRIX_ALIAS, withDevKit } from 'auth-kit/dev';
export default (phase: string) => withDevKit(phase, config, { aliases: [DEV_ALIAS, DEV_MATRIX_ALIAS] });

// lib/auth.ts
import { matrixOverrides } from '@/dev-matrix';
export const auth = createServerAuth({ ...poolConfigFromAmplifyOutputs(outputs), capabilities, ...matrixOverrides()?.serverAuth });

// lib/admin.ts
const matrix = matrixOverrides();
export const people = createPeopleActions({
  auth,
  auditLog: matrix?.auditLog ?? createDynamoAuditLog({ tableName }),
  mailer: matrix?.mailer ?? createSesInviteMailer({ from }),
  ...(matrix && { cognito: matrix.peopleCognito }),
  // ...
});
// and your own stores: matrix?.shared('tickets', createMemoryTicketStore) ?? dynamoTickets
```

- **What changes while the matrix runs, and nothing else.** Tokens verify against the test issuer's public keys (every claim still checked; a token signed by any other key is a 401, and nothing is fetched from the pool's key endpoint); a scripted Cognito answers the authenticator check and `{ live: true }` re-reads per persona, refusing a disabled account and a revoked session exactly as Cognito does; the People list reads the fixture and every change is refused; no email is sent; the audit log is in memory. The proxy, guards, capability map, pages, and route handlers are the production code.
- **Never in a build.** `matrixServerOverrides()` returns `null` unless `NODE_ENV` is `development` and `AUTH_KIT_MATRIX=1` (and throws, rather than falling back to AWS, if the flag has no fixture). The alias keeps the module out of builds, and `npx auth-kit check-prod-build` fails a build that contains its marker.
- **Per bundle.** Next bundles the proxy, each page, and each route separately, each with its own copy of auth-kit, and auth-kit recognizes its errors with `instanceof`. The overrides are built per bundle; only plain data (the audit log's rows, `shared(...)` stores) is shared across bundles, so a record the API creates shows on a page.
- **No AWS.** The dev server gets `AWS_BLOCKED_ENV` (no credentials can resolve; also exported for your test runner's own `env`), `ALLOW_DEV_SIGNIN=0`, and no `NODE_ENV`; your `env` can't override those or the flag. `startMatrixServer` reads the pool and app client from `amplify_outputs.json` (a placeholder works in CI) or `pool`.

What it checks ([ADR 0014](docs/decisions/0014-matrix-without-proxy.md)):

- **Each route's own guard.** Every case runs through the proxy and again with the proxy stepped aside, so a route that leans on the proxy for its 401 fails. The proxy steps aside only for the matrix's requests, only outside production builds, only with `AUTH_KIT_MATRIX=1`, and only on a localhost URL (a production build compiles the switch out); without the flag, those cases fail and say why. In-process tests pass `handlerRequest` instead.
- **Coverage.** Every route in `appRoutes` needs a row, and every row must match an app route, so a mistyped path fails instead of passing on a 404.
- **The standard's rules.** Every route needs anonymous, member, and admin; record routes need the second member, who gets 404; at least one persona must succeed on each row (`exists: false` marks a row asserting a path is gone).

What it can't see: server actions aren't in the build manifest, so give them rows of your own; and it verifies responses for the personas you give it. To run your own server instead, `matrixFixture({ issuer, personas })` returns the tokens and the fixture and `matrixServerEnv()` the environment.

### 6. Sign-in screens and My account: `auth-kit/client`

Client components on Amplify JS v6. Amplify's auth calls go from the browser to Cognito and passkeys need the browser's prompt, so these run in the browser; `auth-kit/server` keeps enforcing the same rules on every request.

```tsx
// app/amplify-client.tsx: render <AmplifyClient /> once in the root layout
'use client';
import outputs from '@/amplify_outputs.json';
import { configureAuthClient } from 'auth-kit/client';

// ssr: true, SameSite=Lax, and cookies that expire with the app client's refresh token
configureAuthClient(outputs, { refreshTokenMinutes: 30 * 24 * 60 });
export function AmplifyClient() { return null; }
```

```tsx
// app/sign-in/page.tsx (a public route)
import { SignIn } from 'auth-kit/client';

export default async function Page({ searchParams }: { searchParams: Promise<{ next?: string; reauth?: string }> }) {
  const { next, reauth } = await searchParams;
  return <SignIn siteName="Example Reports" passkeysEnabled={false} next={next} reauth={reauth === '1'} />;
}
```

```tsx
// app/(app)/layout.tsx: the server enforces the authenticator rule for every page below
await pages.requireUser(); // a password user without an authenticator goes to /account/authenticator
return children; // no TOTPEnrollmentGate here: the guard above already covers every page

// app/account/page.tsx: the gate inside the page, after its own guard, around client UI
await pages.requireUser();
return (
  <TOTPEnrollmentGate issuer="Example Reports" serverChecked>
    <MyAccount issuer="Example Reports" passkeysEnabled={false} />
  </TOTPEnrollmentGate>
);
```

`TOTPEnrollmentGate` is the screens' mirror of the server's rule, never the enforcement: React sends a client component's children to the browser whatever it renders, so only the server guard protects content. It always renders its children, on the server too, inside a wrapper that's `hidden` until the browser check passes (from the first paint with `serverChecked`), so it can't mask a nested page's `notFound()` or `redirect()`. Wrapping a layout's `children` adds nothing but a hidden page until a browser round trip to Cognito.

The authenticator setup page calls `pages.requireUser({ allowMfaEnrollment: true })` and renders `<AuthenticatorSetup issuer="…" onDone={…} />` from a small client component (function props such as `onDone`, `navigate`, `loadFactors`, and `renderQrCode` can't cross from a server component).

| Export | What it does |
|---|---|
| `SignIn` | Passkey first (`USER_AUTH` + `WEB_AUTHN`); "Use a password instead" (password, then the TOTP code); "Email me a code instead". Handles every step Cognito returns for these pools: first-factor choice, emailed code, TOTP, a temporary password's new password, required TOTP setup, an MFA choice (answered with TOTP), and a required reset. Then: authenticator setup for password users, the first credential after an invite, a one-time "Save a passkey". Redirects through `safeRedirect`; `reauth` for step-up. |
| `ChooseFirstCredential` | After an invite's emailed code: "Save a passkey", or "Set a password" (15+ characters) followed by the authenticator, which isn't optional. |
| `AuthenticatorSetup` | Setup link, setup key, an optional QR code (`renderQrCode`, so the package stays dependency-free), then one code. |
| `TOTPEnrollmentGate` | Shows only setup to a password user without an authenticator. Its children are always server-rendered (hidden until the check passes), so it never changes the page's status. Use it inside a page, after the page's guard, with `serverChecked`. Without `serverChecked`, if the check can't run, the app stays hidden and the reason is shown with a retry. |
| `MyAccount` | Email; passkeys (list, add, remove; never the last way in); authenticator (set up, replace); password (change, or set one, then the authenticator); sign out everywhere. |
| Functions | `signInWithPasskey`, `signInWithPassword`, `requestEmailCode`, `confirmCode`, `enrollAuthenticator`, `registerPasskey`, `listPasskeys`, `deletePasskey`, `setFirstPassword`, `changePassword`, `signOutEverywhere`, `fetchAuthFactors`, `describeAuthError`, … for sites building their own screens. |

- **Errors** are plain and never say whether an account exists (a wrong password, an unknown email, and a disabled account read the same; a reset request looks the same either way). Rate limits, including WAF's, say to wait.
- **Accessibility:** every field has a label; errors are announced (`role="alert"`) and linked to the field (`aria-invalid`, `aria-describedby`); progress is announced (`role="status"`); focus moves to each new step's heading.
- **Styling:** unstyled markup. Each root has `data-auth-kit="sign-in"` (and so on), each element `data-auth-kit-slot="button"` (`input`, `error`, …); pass `className` and `classNames={{ button: '…' }}`. `authKitStyles` is optional zero-specificity CSS to copy into a stylesheet.
- **CSP:** `connect-src` needs `https://cognito-idp.<region>.amazonaws.com` (Amplify needs it too) and `https://api.pwnedpasswords.com` for the breached-password check (`checkBreachedPassword={false}` turns it off on Plus-plan pools).

#### Where Amplify v6 differs from the standard

Checked against `@aws-amplify/auth` 6.21 (via `aws-amplify` 6.22) and AWS's documentation; details in [ADR 0008](docs/decisions/0008-client-in-the-browser.md).

- **No passkey autofill.** Cognito issues a passkey challenge only for a named user ("SDK-based applications must prompt for a username"), and Amplify calls `navigator.credentials.get()` without conditional mediation. So `autocomplete="username webauthn"` lets a password manager fill the email, but saved passkeys can't appear in the autofill list. The passkey is instead the one-click primary button once the email is filled.
- **No first password after an invite through Amplify.** Cognito's `ChangePassword` takes no previous password for a passwordless account, but Amplify's `updatePassword` refuses an empty one. `setFirstPassword` makes that one call directly, authorized by the access token.
- **No `GetUserAuthFactors` in Amplify.** `fetchAuthFactors` calls it the same way; the after-sign-in steps, the gate, and the last-way-in guard need it.
- **Browser-written cookies last 365 days** with Amplify's `ssr: true`; `configureAuthClient` makes them expire with the refresh token.
- **Smaller ones:** Amplify's default sign-in flow (SRP) isn't allowed by the standard's app client, so every call passes `USER_AUTH`; `signIn` refuses while a session exists, so step-up ends the local session first; `getSetupUri` doesn't encode its inputs and labels the account with Cognito's username (a UUID), so auth-kit builds the `otpauth://` link; `associateWebAuthnCredential` takes no passkey name (Cognito names it); once someone has an authenticator, Cognito stops offering them emailed codes, and a request for one comes back as a choice of other methods.

To check on the first sandbox deploy: passkey sign-in and registration on the relying-party domain, the emailed-code and TOTP paths end to end, that `GetUserAuthFactors` from the browser passes the site's CSP, and step-up with a passkey in Safari (ending the local session adds a round trip before the passkey prompt, which may outlast the click's user activation).

### 7. Localhost: personas and "Sign in as…"

```sh
npx ampx sandbox --profile personal
npx auth-kit init-personas --domain reports.test
npx auth-kit seed-personas --profile personal --account <account id>
```

Then a dev-only route (`app/api/dev/sign-in/route.dev.ts` with `createDevKit`), the ribbon in the layout, `withDevKit` in `next.config.ts`, and `npx auth-kit check-prod-build` in CI. The [localhost guide](docs/localhost.md) has every file.

### 8. The admin area: `auth-kit/admin`

```ts
// amplify/backend.ts: the audit table
import { AuditLogTable } from 'auth-kit/admin/cdk';
const auditLog = new AuditLogTable(backend.createStack('audit-log'), 'AuditLog');
backend.addOutput({ custom: { auditLogTable: auditLog.tableName } });
```

```ts
// lib/admin.ts (server-only)
import { createDynamoAuditLog, createPeopleActions, createSesInviteMailer } from 'auth-kit/admin';

export const auditLog = createDynamoAuditLog({ tableName: outputs.custom.auditLogTable });
export const people = createPeopleActions({
  auth,
  auditLog,
  mailer: createSesInviteMailer({ from: 'Example Reports <noreply@example.org>' }),
  siteName: 'Example Reports',
  signInUrl: 'https://reports.example.org/sign-in',
  inviteDomains: ['example.org'],
  onChange: (event) => alertOwners(event), // grants and removals alert a named person
});
```

```ts
// app/admin/people/actions.ts: library code can't be a server action, so wrap each one
'use server';
import { revalidatePath } from 'next/cache';
import type { ActionResult } from 'auth-kit/admin';
import { people } from '@/lib/admin';

export async function invite(previous: ActionResult | null, data: FormData) {
  const result = await people.forms.invite(previous, data);
  if (result.ok) revalidatePath('/admin/people');
  return result;
}
// …and the same for resend, changeRole, disable, enable, signOutEverywhere, deleteUser
```

```tsx
// app/admin/people/page.tsx (server component; admin pages are never cached)
import { InviteForm, PeopleTable } from 'auth-kit/admin/ui';
import { signInUrl } from 'auth-kit/server';
import { changeRole, deleteUser, disable, enable, invite, resend, signOutEverywhere } from './actions';

export const dynamic = 'force-dynamic';

// "Sign in again to confirm": /sign-in?next=%2Fadmin%2Fpeople&reauth=1, which the sign-in page
// (step 6) reads as a step-up and returns from to this page.
const stepUpHref = signInUrl('/admin/people', { reauth: true });

export default async function PeoplePage() {
  const user = await pages.requireCan('people.manage', { live: true });
  const viewer = { sub: user.sub, groups: [...user.groups], capabilities: [...user.capabilities] };
  return (
    <>
      <InviteForm action={invite} viewer={viewer} inviteDomains={['example.org']} stepUpHref={stepUpHref} />
      <PeopleTable
        people={await people.listPeople()}
        viewer={viewer}
        actions={{ resend, changeRole, disable, enable, signOutEverywhere, deleteUser }}
        stepUpHref={stepUpHref}
      />
    </>
  );
}
```

Every action re-reads the acting person and the target from Cognito, runs the guardrails with a live owner count, asks for a recent sign-in before a grant or a delete (making someone an owner also emails every owner, and is undone if that email can't be sent), and writes the audit intent before any Cognito call and the result after ([ADR 0010](docs/decisions/0010-audit-log-intent-then-result.md), [ADR 0011](docs/decisions/0011-people-actions.md)). Each returns `{ ok, message }` or `{ ok: false, code, error, changed }`, where `changed` says honestly whether anything happened. The Activity page is `people.listActivity({ cursor })` with `<ActivityLog>`; apps log their own content changes with `recordChange(auditLog, …)`.

The server role needs `peopleAdminPolicy({ userPoolArn, auditTableArn, sesResourceArns })` (Amplify Hosting's compute role is set in the console, so this returns plain JSON; in CDK, `auditLog.grantAppendAndQuery(role)`). Schedule `createInviteExpirySweep({ userPoolId, auditLog })` daily. The Tier 3 admin pool, which has no emailed codes, uses `inviteMode: 'temporary-password'`: Cognito emails a one-time password the app never sees.

## Status codes

| Status | Meaning | Error class |
|---|---|---|
| 401 | No valid session (missing, forged, expired, revoked, disabled). `token_expired` when a genuine token merely expired, `invalid_token` for anything else wrong with one | `UnauthenticatedError` |
| 401 | Signed in, but this action needs a fresh sign-in (`WWW-Authenticate: … insufficient_user_authentication`) | `StepUpRequiredError` |
| 403 | Signed in, and not allowed | `ForbiddenError` |
| 403 | A password user without an authenticator code: send them to setup | `MfaEnrollmentRequiredError` |
| 404 | The record isn't theirs (or doesn't exist; the route doesn't say which) | `NotFoundError` |
| 503 | Couldn't check (Cognito or its keys unreachable). Never treated as signed out or allowed; on pages, the error boundary says so (`isAuthUnavailableError`) | `AuthUnavailableError` |

Pages turn 401 into a sign-in redirect with a safe `next` path (`&reauth=1` for step-up), missing TOTP into the setup page, and 403/404 into Next's not-found page.

### "Couldn't check" on pages

A 503 is never a sign-in redirect or a not-found page: page guards rethrow `AuthUnavailableError` to the nearest error boundary. In a production build Next replaces server errors with a generic one before the boundary sees it (no name, no message, only `digest`), so `AuthUnavailableError` carries a digest of its own, `AUTH_KIT_AUTH_UNAVAILABLE;<reference>`, which Next keeps. `isAuthUnavailableError(error)` from `auth-kit/client` reads it, in development and production alike:

```tsx
// app/error.tsx (and app/global-error.tsx, which catches errors thrown by the root layout)
'use client';
import { isAuthUnavailableError } from 'auth-kit/client';

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const unavailable = isAuthUnavailableError(error);
  return (
    <main>
      <h1>{unavailable ? 'Can’t check your sign-in right now' : 'This page couldn’t load'}</h1>
      <p>
        {unavailable
          ? 'The sign-in service didn’t answer, so this page stayed closed. Nothing was shown or changed.'
          : 'Something failed on the server. Try again, and if it keeps happening, quote the reference below.'}
      </p>
      {error.digest && <p>Reference: {error.digest}</p>}
      <button type="button" onClick={reset}>Try again</button>
    </main>
  );
}
```

The reference matches the server's log line for that error. The page's own HTTP status is 500 (Next serves error boundaries as 500); the proxy answers 503 itself when it can't check, and route handlers wrapped in `withAuthErrors` answer 503 JSON.

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
| Passkey, password + TOTP, emailed code; `ALLOW_USER_AUTH` | Sign-in policy `WEB_AUTHN`/`PASSWORD`/`EMAIL_OTP`; client flows exactly `ALLOW_USER_AUTH` + refresh | Pkg (UI: `SignIn`) |
| MFA optional, TOTP only; app requires TOTP of password users | Preset; `requireUser` refuses (403 `mfa_enrollment_required`) via `GetUserAuthFactors`, page guards redirect to setup; `TOTPEnrollmentGate` (screens only), `AuthenticatorSetup` | Pkg |
| Passwords ≥ 15, no composition rules | Preset password policy | Pkg |
| Breached-password check | Plus threat protection on Tier 3; a Have I Been Pwned range check before every new password the client saves | Pkg |
| `autocomplete` tokens, paste never blocked | `SIGN_IN_AUTOCOMPLETE` on every field; no paste blocking or `maxlength` ([passkey autofill caveat](#where-amplify-v6-differs-from-the-standard)) | Pkg |
| Essentials plan + SES | `UserPoolTier`, `EmailConfiguration` with the domain identity | Pkg |
| WAF web ACL with a per-IP rate rule | `createAuthWebAcl` (sign-in rule + overall rule), or one [shared ACL](#waf-one-web-acl-for-all-your-sites) per account and Region; off only with `acknowledgeNoRateLimit` | Pkg ([caveat](#verify-on-the-first-sandbox-deploy)) |
| `AuthSessionValidity` 3 minutes | Preset | Pkg |
| Passkeys: user verification, count as MFA, final-domain RP ID | `WebAuthnUserVerification`, `WebAuthnFactorConfiguration`, RP ID validation | Pkg |
| `PreventUserExistenceErrors` | Preset | Pkg |
| Invites with no password and no `email_verified` | `people.invite` (`MessageAction: SUPPRESS` + SES) | Pkg |
| **Sessions** | | |
| Access/ID 60 min; refresh 30 days (Tier 2) or ≤ 1 day (Tier 3) | Preset (ceilings enforced; admin pools ≤ 1 day) | Pkg |
| Token revocation on | Preset | Pkg |
| Global sign-out; people manage their own passkeys | `MyAccount` (with a last-way-in guard); `people.signOutEverywhere` for admins | Pkg |
| Step-up for risky actions via `auth_time` | `requireRecentSignIn`, `recentSignIn` option | Pkg |
| Five token checks, access tokens only | `verifyAccessToken` (`aws-jwt-verify`) | Pkg |
| Removal is `AdminDisableUser` | `people.disable` (then removes admin roles and record memberships); live checks refuse disabled users at once | Pkg |
| Secure, SameSite cookies; strict CSP; origin check | `secureCookieOptions`; `amplifyCookieRuntimeOptions` (Secure, SameSite=Lax, refresh-token lifetime on server-written token cookies; `configureAuthClient` gives browser-written ones the same lifetime); `assertSameOrigin` with `expectedOrigin`; a per-request nonce CSP through the proxy (`nonceCspHeaders`), with the policy in the site ([template](https://github.com/davidyokum/site-auth-kit-template)) | Pkg / App |
| Amplify `ssr: true` client | Server reads its cookies and verifies them itself; the adapter refreshes in the proxy | Pkg ([ADR 0007](docs/decisions/0007-verify-tokens-in-auth-kit.md)) |
| **Enforcement** | | |
| Default-deny proxy that validates tokens | `withAuthProxy` | Pkg |
| Every route, action, data-loading component checks | `requireUser` / `requireGroup` / `requireCan`; the auth matrix's without-proxy pass fails a route that relies on the proxy, and its coverage check fails a route with no row (server actions need rows by hand) | Pkg + App |
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
| Unused invites disabled after 7 days, flagged | `inviteStatus`; `createInviteExpirySweep` (schedule it daily) | Pkg |
| Recovery defined | Email recovery (everyday), admin-only (admin pool); admin MFA reset P2 | Partial |
| Email changes admin-only | Can't be enforced in the pool ([why](#what-the-pool-cant-enforce)) | Gap |
| First admin bootstrapped once at deploy | Not built | P2 |
| **Admin area** | | |
| Separate keys; grant below your own level; nobody changes their own role; keep an owner | `checkPeopleAction`, `grantableRoles`, run live by every action | Pkg |
| People page buttons and copy | `createPeopleActions`, `peopleActionDetails`, `auth-kit/admin/ui` | Pkg |
| Append-only audit log, written with the change | `createDynamoAuditLog`, `runAudited` (intent → calls → result), `AuditLogTable` ([ADR 0010](docs/decisions/0010-audit-log-intent-then-result.md)) | Pkg |
| Grants and removals alert a named person | `onChange` hook on every completed change | Pkg (alert channel: App) |
| Rich text, uploads, drafts | Not in this package yet | App / later |
| **Foundation** | SES domain identity required by the preset; SPF/DKIM/DMARC, private database, compute role, master keys, break-glass, secrets, branch passwords | Ops / App |
| **Local development** | | |
| Sandbox pool tagged `Environment=sandbox`; seeding and sign-in refuse others | Preset tags it; `sandboxProblems` also refuses Amplify branches, deletion protection, many users, the wrong account | Pkg |
| Personas from `personas.json`, `.test` addresses, passwords in `.env.local` | `parsePersonas`, `seedPersonas`, `npx auth-kit seed-personas` (personas get an authenticator too: [ADR 0009](docs/decisions/0009-localhost-kit.md)) | Pkg |
| "Sign in as…" behind three gates, loopback, sandbox-only admin flow | `createDevKit`: request gates, same-site writes, a checked loopback binding, the sandbox check; `ALLOW_ADMIN_USER_PASSWORD_AUTH` only on sandbox clients | Pkg |
| Dev sign-in absent from production builds, CI-tested | `withDevKit` (`.dev.ts` routes, `@/dev` alias); `npx auth-kit check-prod-build` and `check-dev-route` | Pkg + App (CI step) |
| Roles seen as real accounts; View as on the live site | Personas; `ViewAsBanner` (the View as action is the admin module's) | Pkg / App |
| Ribbon naming environment, pool, persona; `[DEV]` title and favicon | `EnvironmentRibbon`, `environmentMetadata` | Pkg |
| One `*.localhost` name per app | `localDevServer` | Pkg + App |
| **Assurance** | | |
| Auth-matrix tests in CI | `startMatrixServer` (`next dev` with the matrix server mode, no AWS) and `assertAuthMatrix` with `appRoutes: routesFromNextBuild()` | Pkg (CI wiring in the [template](https://github.com/davidyokum/site-auth-kit-template)) |

## WAF: one web ACL for all your sites

AWS WAF bills about $5 a month per web ACL and $1 per rule, so the preset's default (a web ACL per pool, two rules) costs about $7 a month per site. With several sites, share one web ACL per AWS account and Region instead ([ADR 0013](docs/decisions/0013-shared-web-acl.md)):

```ts
// A small CDK app of its own, deployed once per account and Region.
import { App, CfnOutput, Stack } from 'aws-cdk-lib';
import { createSharedAuthWebAcl } from 'auth-kit/amplify';

const app = new App();
const stack = new Stack(app, 'AuthKitSharedWaf', { env: { region: 'us-east-1' } });
const acl = createSharedAuthWebAcl(stack, 'SharedAuthWebAcl'); // same rate rules, no association
new CfnOutput(stack, 'WebAclArn', { value: acl.attrArn });
```

```ts
// Each site's amplify/auth/resource.ts
export const authOptions = {
  // ...
  waf: { webAclArn: 'arn:aws:wafv2:us-east-1:<account-id>:regional/webacl/auth-kit-shared-user-pools/<id>' },
} satisfies AuthStandardOptions;
```

The preset then only associates the shared ACL with the pool. Its rate rules count per IP across every pool it protects, so an office using several sites shares one budget: raise the shared ACL's limits if that bites. Turning WAF off entirely takes `waf: false` plus `acknowledgeNoRateLimit: true` (Cognito doesn't lock out wrong emailed codes) and still warns at synthesis.

## Verify on the first sandbox deploy

These were checked against the installed packages and AWS documentation, but not against a live pool. Deploying a sandbox needs David's approval.

- **Admin pool MFA ON with passkeys.** `defineAuth` rejects passkeys with MFA `REQUIRED` (it doesn't model `FactorConfiguration`), so the preset raises `MfaConfiguration` to `ON` in a CDK override. AWS documents that a user-verified passkey satisfies required MFA; whether CloudFormation accepts this exact combination is untested.
- **The WAF sign-in rule's header match.** Cognito forwards `x-amzn-cognito-operation-name` to WAF, but AWS doesn't document its value format. The rule matches case-insensitively on the operation name (and on `x-amz-target`). Run it in `count` mode first; the overall per-IP rule needs no header match.
- **Which rule sees token refreshes.** Amplify JS 6.22 refreshes with `GetTokensFromRefreshToken` (overall rule only); older clients use `InitiateAuth` with `REFRESH_TOKEN_AUTH`, which the sign-in rule also counts. After a sandbox session refreshes, read both rules' samples (read-only) and tune the limits with refreshes in mind: `aws wafv2 get-sampled-requests --profile <profile> --scope REGIONAL --web-acl-arn <arn> --rule-metric-name <project>-sign-in-attempts-per-ip --time-window StartTime=<iso>,EndTime=<iso> --max-items 100` (and `<project>-requests-per-ip`).
- **`request.url`'s scheme behind Amplify Hosting.** If route handlers see `http://` while browsers send `Origin: https://`, every state-changing request without `expectedOrigin` fails the origin check. Set `expectedOrigin` from configuration (step 3) either way.
- **Choice-based sign-in without a managed-login domain.** AWS's overview says passwordless and passkey sign-in need one; other AWS pages say SDK apps don't. The preset doesn't create a domain.

## What the pool can't enforce

- **Sign-up enumeration with the self-signup exception.** With `selfSignUp` on, Cognito's `SignUp` answers `UsernameExistsException` for an address that already has an account (`PreventUserExistenceErrors` doesn't cover `SignUp`), so anyone can test whether an allowed-domain address is registered.
- **Untrusted sibling subdomains.** Amplify's cookie names can't use the `__Host-` prefix, so an app on a sibling subdomain of a custom domain can set cookies for the parent domain and plant a session. auth-kit reads duplicate cookies the way Next does (the last one wins) so every layer agrees, but don't host an app you don't trust under the same parent domain.
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
