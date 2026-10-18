# The localhost kit

Sign in on `localhost` as any role in one click, for you and your AI agent, with real tokens from a sandbox pool, and make that impossible on every deployed site. This is 03 §2 "Local development" and the primer's Chapter 8, as code. Decisions: [ADR 0005](decisions/0005-sandbox-only-admin-password-flow.md), [ADR 0009](decisions/0009-localhost-kit.md).

| Piece | Where |
|---|---|
| Personas (`personas.json`), seeding | `npx auth-kit init-personas`, `npx auth-kit seed-personas`, `seedPersonas` |
| "Sign in as…" route | `createDevKit` from `auth-kit/dev`, in `app/api/dev/sign-in/route.dev.ts` |
| Persona menu (dev only) | `PersonaMenu` from `auth-kit/dev/menu` |
| Environment ribbon, View as banner (ship) | `EnvironmentRibbon`, `ViewAsBanner`, `environmentMetadata` from `auth-kit/ribbon` |
| Keeping it out of builds | `withDevKit` in `next.config.ts` |
| The auth matrix's server mode (dev only) | `auth-kit/testing/matrix-server` behind `@/dev-matrix`; `startMatrixServer` from `auth-kit/testing` ([README §5](../README.md#5-auth-matrix-tests)) |
| Proving it in CI | `npx auth-kit check-prod-build`, `npx auth-kit check-dev-route` |

## Set up an app (once)

**1. The sandbox and personas.** The preset tags a sandbox pool `Environment=sandbox` and gives only its app client `ALLOW_ADMIN_USER_PASSWORD_AUTH`.

```sh
npx ampx sandbox --profile personal                         # writes amplify_outputs.json
npx auth-kit init-personas --domain reports.test --app-roles reviewer
```

`personas.json` is the only list of test accounts: `key`, a `.test` `email`, `groups` (at most one admin role, plus app roles; `[]` for a member), and optional `label` and `attributes`. You need a persona for each admin role (`owner`, exactly one; `superadmin`; `admin-content-people`; `admin-content`; `admin-view`) and a member with no group; add more (a second member for record tests, one per app role) as you like. Passwords never go in this file.

**2. `.env.local`** (git-ignored; the seed script refuses to write it otherwise):

```sh
AWS_PROFILE=personal                 # the dev server's Cognito calls use this profile
AUTH_KIT_AWS_ACCOUNT=<account id>    # optional: refuse a pool in any other account
ALLOW_DEV_SIGNIN=1                   # the third gate; never copy this file into a branch's settings
```

**3. The files.**

```ts
// lib/dev/kit.ts: imported only by dev-only files
import { createDevKit } from 'auth-kit/dev';
import outputs from '@/amplify_outputs.json';
import personas from '@/personas.json';
export const devKit = createDevKit({ outputs, personas, appRoles: ['reviewer'] });
```

```ts
// app/api/dev/sign-in/route.dev.ts: a route only under next dev
import { devKit } from '@/lib/dev/kit';
export const GET = devKit.route.GET;
export const POST = devKit.route.POST;
export const DELETE = devKit.route.DELETE;
```

```tsx
// lib/dev/on.tsx: what `@/dev` means under next dev
import { cookies } from 'next/headers';
import { EnvironmentRibbon } from 'auth-kit/ribbon';
import { PersonaMenu } from 'auth-kit/dev/menu';
import { devKit } from './kit';

export async function DevRibbon() {
  return (
    <EnvironmentRibbon {...await devKit.ribbon(await cookies())}>
      <PersonaMenu />
    </EnvironmentRibbon>
  );
}
```

```tsx
// lib/dev/off.tsx: what `@/dev` means in every build (same exports, no dev code)
import { EnvironmentRibbon, resolveEnvironment } from 'auth-kit/ribbon';
import outputs from '@/amplify_outputs.json';

export function DevRibbon() {
  return <EnvironmentRibbon environment={resolveEnvironment()} poolId={outputs.auth.user_pool_id} poolIsSandbox={null} branch={process.env.AWS_BRANCH} />;
}
```

```tsx
// app/layout.tsx
import { DevRibbon } from '@/dev';
// … <body><DevRibbon />{children}</body>
```

```ts
// next.config.ts
import type { NextConfig } from 'next';
import { DEV_ALIAS, DEV_MATRIX_ALIAS, withDevKit } from 'auth-kit/dev';
const config: NextConfig = { /* yours */ };
// @/dev (this kit) and @/dev-matrix (the auth matrix's server mode, README §5); just @/dev by default.
export default (phase: string) => withDevKit(phase, config, { aliases: [DEV_ALIAS, DEV_MATRIX_ALIAS] });
```

```jsonc
// tsconfig.json: type checks see the off modules, the shape every build uses
"paths": { "@/dev": ["./lib/dev/off.tsx"], "@/dev-matrix": ["./lib/dev/matrix.off.ts"], "@/*": ["./*"] }
```

```ts
// proxy.ts: list the dev route as public in every environment. Under next dev the route runs its own
// checks; in a build it doesn't exist, so the answer is Next's 404 (a 401 from the proxy would hide that).
export const proxy = withAuthProxy({ auth, publicRoutes: ['/', '/api/dev/sign-in'] });
```

```jsonc
// package.json: loopback only, and one *.localhost name per app (cookies ignore ports)
"dev": "next dev --hostname 127.0.0.1 --port 3000"
```

`localDevServer({ app: 'reports', port: 3000 })` returns that command and the URL to open, `http://reports.localhost:3000`. Use a different name and port per app (and per worktree).

Use that URL as `assertSameOrigin`'s `expectedOrigin` under `next dev` too (README step 3). `next dev` rewrites `request.url`'s host to `localhost` whatever the browser asked for, so the origin rebuilt from it never matches `http://reports.localhost:3000`; without `expectedOrigin`, the check falls back to the `Host` header in development (loopback hosts only).

## Every day

```sh
npx ampx sandbox --profile personal
npx auth-kit seed-personas --profile personal --account <account id>   # idempotent; rerun any time
npm run dev                                                            # open http://reports.localhost:3000
```

The seed script refuses unless the pool is a sandbox: tagged `Environment=sandbox`, not an Amplify branch, deletion protection off, at most 50 users, and (with `--account`) in that AWS account per the pool's ARN. It then creates each persona with no invitation email, sets a permanent password, puts it in exactly its groups, enrolls an authenticator (the standard requires one of password users), and proves each persona signs in. Passwords (`PERSONA_PASSWORD_<KEY>`) and authenticator secrets (`PERSONA_TOTP_<KEY>`) go to `.env.local` and are never printed. A rerun with nothing to change makes no writes. `--dry-run` reports without writing.

Pick a persona from **Sign in as…** in the ribbon. The route signs it in with `AdminInitiateAuth`, answers the authenticator challenge, and sets the same cookies Amplify's own sign-in sets, so every server check runs exactly as in production. An agent can do the same: `POST /api/dev/sign-in` with `{"persona":"admin-content"}` from the page's origin, or click the menu.

## What the route checks

Every refusal is a plain 404. In order:

| # | Check | Stops |
|---|---|---|
| 1 | `NODE_ENV === 'development'` | Every deployed build |
| 2 | Host, the request URL, and any X-Forwarded-Host are `localhost`, `*.localhost`, `127.0.0.1`, or `[::1]` | Deployed hosts; DNS rebinding (the browser sends the attacker's name); tunnels that rewrite Host |
| 3 | `ALLOW_DEV_SIGNIN === '1'` | Anywhere you didn't switch it on |
| 4 | Proxy headers (X-Forwarded-For, Forwarded, X-Real-IP, …) name only this computer | Tunnels such as ngrok, and a LAN caller who doesn't forge them (Next fills X-Forwarded-For with the real address) |
| 5 | POST and DELETE come from the page itself (Origin, or `Sec-Fetch-Site: same-origin`), and POST is JSON | Another site signing you in or out (login CSRF) |
| 6 | **The dev server listens on loopback only**: the route reads the server's own listening sockets (`next dev` serves requests in the process that listens) and refuses `0.0.0.0`, `::`, or a network address; if it can't see them, it probes this computer's network addresses on the dev port | A stranger on the café Wi-Fi who sends `Host: localhost`, forged headers and all |
| 7 | The pool is a sandbox (as the seed script checks; cached 5 minutes) | A local app pointed at a live pool |

Checks 1–4 fail silently. From 5 on, the request came from this computer, so the dev server's console says what failed and how to fix it. Passwords and secrets are never logged or returned.

## Out of production, and proven

- **`.dev.ts` routes.** Under `next dev`, `withDevKit` adds `dev.tsx` and `dev.ts` to the page extensions, so `route.dev.ts` is a route. In a build it isn't, and nothing imports it.
- **The `@/dev` alias.** Under `next dev` it resolves to `lib/dev/on.tsx`; in a build, to `lib/dev/off.tsx`. Only `on.tsx` imports `auth-kit/dev` and the menu. `@/dev-matrix` works the same way for the auth matrix's server mode (`matrix.on.ts` / `matrix.off.ts`).
- **The markers.** The route handler and the menu carry a marker string, and `auth-kit/testing/matrix-server` one of its own. No subpath that ships does (CI checks their built import graphs).
- **CI**, after `next build`:

```sh
npx auth-kit check-prod-build            # fails if .next contains either marker or registers /api/dev/sign-in
npx next start --hostname 127.0.0.1 --port 3100 &
npx auth-kit check-dev-route --url http://127.0.0.1:3100   # forged requests (Host: localhost, matching Origin) must all get 404
```

`check-prod-build` skips `.next/dev` (Next 16's `next dev` output) and `.next/cache`, and fails on a directory without `BUILD_ID`: no build isn't a clean build. `check-dev-route` proves the deployed route never signs anyone in; `check-prod-build` proves it isn't there.

## The ribbon on previews and the live site

`auth-kit/ribbon` is safe in production builds. `resolveEnvironment()` is local under `next dev`, preview on any branch but `main`, and production (no ribbon) on `main` or when it can't tell. Amplify passes build variables to the server only if the build writes them out, so add to `amplify.yml`'s build commands: `echo "AWS_BRANCH=$AWS_BRANCH" >> .env.production`.

For the `[DEV]`/`[PREVIEW]` tab title and favicon, spread `environmentMetadata(environmentRibbonModel(input), { template: '%s · Reports', default: 'Reports' })` into the root layout's metadata.

**View as** (the admin area's read-only mode) renders `<ViewAsBanner viewingAs="Editor" exitAction={endViewAs} />`: a hatched border around the page and a sticky "Viewing as Editor · read-only · Exit" bar. The server still blocks every write; the banner makes the mode impossible to miss. `viewAsMetadata('Editor', base)` marks the tab.

## When something's off

- **No Sign in as… menu.** The route answered 404. The dev server's console says why (not bound to 127.0.0.1, pool not a sandbox, no credentials, no password for a persona). A red ribbon means the pool isn't a confirmed sandbox.
- **A sign-in takes up to 30 seconds.** Cognito won't accept the same authenticator code twice, so a second sign-in as one persona within 30 seconds (or right after seeding) waits for the next code.
- **431 Request Header Fields Too Large.** Cookies from many apps on plain `localhost`. Use one `*.localhost` name per app.
- **Docker or a VM.** A dev server that must listen on `0.0.0.0` inside a container fails check 6 by design.
- **Passkeys locally.** WebAuthn works on `localhost`; test with Chrome DevTools' WebAuthn panel or a virtual authenticator through Playwright.
