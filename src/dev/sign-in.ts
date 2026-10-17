/**
 * "Sign in as…": the dev-only route that signs a persona in for real (primer Chapter 8, Figure 8.1).
 *
 * ```ts
 * // lib/dev/kit.ts (imported only by dev-only files)
 * import { createDevKit } from 'auth-kit/dev';
 * import outputs from '@/amplify_outputs.json';
 * import personas from '@/personas.json';
 * export const devKit = createDevKit({ outputs, personas, appRoles: ['reviewer'] });
 *
 * // app/api/dev/sign-in/route.dev.ts (a route only under next dev; see withDevKit)
 * import { devKit } from '@/lib/dev/kit';
 * export const GET = devKit.route.GET;
 * export const POST = devKit.route.POST;
 * export const DELETE = devKit.route.DELETE;
 * ```
 *
 * Every refusal is a plain 404, so a deployed copy can't even confirm the route exists. In order:
 * 1. The request gates (`gates.ts`): development mode, loopback host names, `ALLOW_DEV_SIGNIN=1`,
 *    no proxy naming another client. Silent.
 * 2. POST and DELETE come from this site (Origin or Sec-Fetch-Site) and POST is JSON. Logged.
 * 3. The dev server listens on loopback only (`bind.ts`). Logged.
 * 4. The pool is a sandbox (`sandbox.ts`, cached). Logged.
 * Then the persona must exist and have a password in `.env.local`. Passwords and secrets are never
 * logged or returned; the log says what to fix.
 */
import type { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { RevokeTokenCommand } from '@aws-sdk/client-cognito-identity-provider';
import type { AmplifyOutputsAuth } from '../server/config.js';
import type { CookieReader } from '../server/tokens.js';
import { SESSION_POLICY } from '../shared/policy.js';
import { amplifySessionCookies, expireAmplifyCookies, readAmplifySession } from './amplify-cookies.js';
import { chooseCredentials, createDevCognitoClient, devPoolConfig } from './aws.js';
import { type BindCheck, checkLoopbackBinding } from './bind.js';
import { PersonaSignInError, signInPersona } from './exchange.js';
import { devSignInGatesFor, isLoopbackHost } from './gates.js';
import { decodeJwtPayload, stringClaim } from './jwt.js';
import { DEV_SIGN_IN_ROUTE, DEV_SIGNIN_MARKER, DEV_SIGNIN_MARKER_HEADER } from './marker.js';
import { type Persona, type PersonaCredentials, parsePersonas, personaCredentialsFromEnv, personaForEmail, personaLabel } from './personas.js';
import { type EnvironmentRibbonInput, resolveEnvironment } from './ribbon-model.js';
import { cachedSandboxCheck, type SandboxCheckResult } from './sandbox.js';

export interface DevKitOptions {
  /** `amplify_outputs.json` from `npx ampx sandbox`. Or give the pool and client directly. */
  outputs?: AmplifyOutputsAuth;
  userPoolId?: string;
  clientId?: string;
  region?: string;
  /** `personas.json` contents. */
  personas: unknown;
  /** The app's roles (the preset's `appRoles`). */
  appRoles?: readonly string[];
  /** AWS profile for the dev server's Cognito calls. Default `AWS_PROFILE` (set it in `.env.local`). */
  awsProfile?: string;
  /** Refuse unless the pool is in this AWS account. Default `AUTH_KIT_AWS_ACCOUNT`. */
  expectedAccountId?: string;
  /** Where a persona's password and authenticator secret come from. Default: `.env.local` via process.env. */
  credentials?: (persona: Persona) => PersonaCredentials | undefined;
  /** Session cookie lifetime. Default 30 days (the Tier 2 refresh token); use 1 day for Tier 3 pools. */
  cookieMaxAgeSeconds?: number;
  /** Refusal reasons for the dev console. Never receives a password or secret. Default `console.warn`. */
  log?: (message: string) => void;
  /** Overrides for tests. */
  client?: CognitoIdentityProviderClient;
  checkBinding?: () => Promise<BindCheck>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type DevRouteHandler = (request: Request) => Promise<Response>;

export interface DevKit {
  /** Route handlers for `app/api/dev/sign-in/route.dev.ts`. */
  route: { GET: DevRouteHandler; POST: DevRouteHandler; DELETE: DevRouteHandler };
  /** Props for `<EnvironmentRibbon>` under `next dev`: the pool, whether it's a sandbox, and the persona. */
  ribbon(cookies: CookieReader | string | null): Promise<EnvironmentRibbonInput>;
  personas: readonly Persona[];
  userPoolId: string;
  clientId: string;
}

/** The JSON a GET returns: what the persona menu lists. Never credentials. */
export interface DevPersonaList {
  personas: { key: string; label: string; email: string; groups: string[] }[];
  current: string | null;
  pool: string;
}

const NO_STORE = 'no-store';

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { 'Cache-Control': NO_STORE, 'Content-Type': 'text/plain' } });
}

function json(body: unknown, status = 200, extra?: (headers: Headers) => void): Response {
  const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': NO_STORE });
  headers.set(DEV_SIGNIN_MARKER_HEADER, DEV_SIGNIN_MARKER);
  extra?.(headers);
  return new Response(JSON.stringify(body), { status, headers });
}

/** Replaces any secret that appears in a message. */
function redact(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('[redacted]');
  return out;
}

/**
 * True when a state-changing request comes from this page: an Origin naming the same loopback host
 * the request was sent to, or (with no Origin) `Sec-Fetch-Site: same-origin`.
 */
function sameSite(request: Request): boolean {
  const host = request.headers.get('host');
  const origin = request.headers.get('origin');
  if (origin !== null) {
    try {
      const url = new URL(origin);
      return origin !== 'null' && (url.protocol === 'http:' || url.protocol === 'https:') && url.host === host?.toLowerCase() && isLoopbackHost(url.host);
    } catch {
      return false;
    }
  }
  return request.headers.get('sec-fetch-site') === 'same-origin';
}

/** Builds the dev kit: the "Sign in as…" route and the ribbon's facts, sharing one config and one sandbox check. */
export function createDevKit(options: DevKitOptions): DevKit {
  const personas = parsePersonas(options.personas, { ...(options.appRoles !== undefined && { appRoles: options.appRoles }) });
  const pool = devPoolConfig({
    ...(options.outputs !== undefined && { outputs: options.outputs }),
    ...(options.userPoolId !== undefined && { userPoolId: options.userPoolId }),
    ...(options.clientId !== undefined && { clientId: options.clientId }),
    ...(options.region !== undefined && { region: options.region }),
  });
  // eslint-disable-next-line no-console
  const log = options.log ?? ((message: string) => console.warn(`[auth-kit dev sign-in] ${message}`));
  const credentialsFor = options.credentials ?? ((p: Persona) => personaCredentialsFromEnv(p));
  const maxAge = options.cookieMaxAgeSeconds ?? SESSION_POLICY.refreshTokenMinutesMax[2] * 60;
  const checkBinding = options.checkBinding ?? (() => checkLoopbackBinding());

  let client = options.client;
  const getClient = () => {
    if (client) return client;
    const choice = chooseCredentials(options.awsProfile);
    client = createDevCognitoClient({ region: pool.region, ...(choice.profile !== undefined && { profile: choice.profile }) });
    return client;
  };
  const expectedAccountId = options.expectedAccountId ?? process.env.AUTH_KIT_AWS_ACCOUNT;
  const sandbox = cachedSandboxCheck({
    getClient,
    userPoolId: pool.userPoolId,
    ...(expectedAccountId ? { policy: { expectedAccountId } } : {}),
    ...(options.now !== undefined && { now: options.now }),
  });

  const signedInEmail = (cookies: string | null | CookieReader): string | undefined =>
    stringClaim(decodeJwtPayload(readAmplifySession(pool.clientId, cookies).idToken), 'email');
  const currentPersona = (cookies: string | null | CookieReader): Persona | undefined => personaForEmail(personas, signedInEmail(cookies));

  function list(request: Request): Response {
    const current = currentPersona(request.headers.get('cookie'));
    const body: DevPersonaList = {
      personas: personas.map((p) => ({ key: p.key, label: personaLabel(p), email: p.email, groups: [...p.groups] })),
      current: current?.key ?? null,
      pool: pool.userPoolId,
    };
    return json(body);
  }

  async function signIn(request: Request): Promise<Response> {
    let key: unknown;
    try {
      key = ((await request.json()) as { persona?: unknown } | null)?.persona;
    } catch {
      key = undefined;
    }
    const persona = typeof key === 'string' ? personas.find((p) => p.key === key) : undefined;
    if (!persona) {
      log(`refused: no persona ${(JSON.stringify(key) ?? 'undefined').slice(0, 60)} in personas.json.`);
      return notFound();
    }
    const creds = credentialsFor(persona);
    if (!creds?.password) {
      log(`refused: no password for "${persona.key}" in .env.local. Run \`npx auth-kit seed-personas --profile <name>\`.`);
      return notFound();
    }
    let tokens;
    try {
      tokens = await signInPersona({
        client: getClient(),
        userPoolId: pool.userPoolId,
        clientId: pool.clientId,
        email: persona.email,
        password: creds.password,
        ...(creds.totpSecret !== undefined && { totpSecret: creds.totpSecret }),
        ...(options.now !== undefined && { now: options.now }),
        ...(options.sleep !== undefined && { sleep: options.sleep }),
      });
    } catch (error) {
      const text = redact(error instanceof Error ? error.message : String(error), [creds.password, creds.totpSecret]);
      log(`signing in as "${persona.key}" failed: ${text}`);
      return json({ error: error instanceof PersonaSignInError ? error.code : 'sign_in_failed', detail: text }, 502);
    }
    const secure = new URL(request.url).protocol === 'https:';
    const session = amplifySessionCookies({ clientId: pool.clientId, tokens, email: persona.email, secure, maxAgeSeconds: maxAge });
    const stale = expireAmplifyCookies(pool.clientId, request.headers.get('cookie'), { keep: session.names, secure });
    return json({ ok: true, persona: persona.key, label: personaLabel(persona) }, 200, (headers) => {
      for (const cookie of [...stale, ...session.headers]) headers.append('Set-Cookie', cookie);
    });
  }

  async function signOut(request: Request): Promise<Response> {
    const cookieHeader = request.headers.get('cookie');
    const { refreshToken } = readAmplifySession(pool.clientId, cookieHeader);
    if (refreshToken) {
      try {
        await getClient().send(new RevokeTokenCommand({ ClientId: pool.clientId, Token: refreshToken }));
      } catch (error) {
        log(`couldn't revoke the refresh token (${error instanceof Error ? error.name : 'error'}); clearing cookies anyway.`);
      }
    }
    const secure = new URL(request.url).protocol === 'https:';
    const expired = expireAmplifyCookies(pool.clientId, cookieHeader, { secure });
    return json({ ok: true }, 200, (headers) => {
      for (const cookie of expired) headers.append('Set-Cookie', cookie);
    });
  }

  const handler: DevRouteHandler = async (request) => {
    // 1. Request gates: silent, because a deployed copy should reveal nothing.
    if (!devSignInGatesFor(request).allowed) return notFound();
    const method = request.method.toUpperCase();
    if (!['GET', 'HEAD', 'POST', 'DELETE'].includes(method)) return notFound();

    // 2. Writes come from this page.
    if (method === 'POST' || method === 'DELETE') {
      if (!sameSite(request)) {
        log(`refused a ${method} from another site (Origin: ${request.headers.get('origin') ?? 'none'}).`);
        return notFound();
      }
      if (method === 'POST' && !/^application\/json\b/i.test(request.headers.get('content-type') ?? '')) {
        log('refused a POST that isn’t JSON.');
        return notFound();
      }
    }

    // 3. Only this computer can reach the dev server.
    const bound = await checkBinding();
    if (!bound.ok) {
      log(`refused: ${bound.reason}`);
      return notFound();
    }

    // 4. The pool is a sandbox.
    const check: SandboxCheckResult = await sandbox();
    if (!check.ok) {
      log(`refused: pool ${pool.userPoolId} ${check.problems.join('; ')}.`);
      return notFound();
    }

    if (method === 'GET' || method === 'HEAD') return list(request);
    if (method === 'POST') return signIn(request);
    return signOut(request);
  };

  async function ribbon(cookies: CookieReader | string | null): Promise<EnvironmentRibbonInput> {
    const environment = resolveEnvironment();
    const email = signedInEmail(cookies);
    const persona = personaForEmail(personas, email);
    const base = {
      environment,
      poolId: pool.userPoolId,
      ...(persona ? { persona: personaLabel(persona) } : email ? { signedInAs: `${email} (not a persona)` } : {}),
    };
    if (environment !== 'local') return { ...base, poolIsSandbox: null };
    let check: SandboxCheckResult;
    try {
      check = await sandbox();
    } catch (error) {
      return { ...base, poolIsSandbox: null, poolCheckError: error instanceof Error ? error.message : String(error) };
    }
    if (check.ok) return { ...base, poolIsSandbox: true };
    if (check.inspection) return { ...base, poolIsSandbox: false };
    const reason = check.error instanceof Error ? `${check.error.name}: ${check.error.message}` : check.problems.join('; ');
    return { ...base, poolIsSandbox: null, poolCheckError: reason };
  }

  return {
    route: { GET: handler, POST: handler, DELETE: handler },
    ribbon,
    personas,
    userPoolId: pool.userPoolId,
    clientId: pool.clientId,
  };
}

/** The route handler alone (all methods), for apps that don't need the ribbon helper. */
export function createDevSignInHandler(options: DevKitOptions): DevRouteHandler {
  return createDevKit(options).route.POST;
}

export { DEV_SIGN_IN_ROUTE };
