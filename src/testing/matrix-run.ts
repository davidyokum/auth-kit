/**
 * Starting the app for the auth matrix (ADR 0016): mint a token per persona with a local test
 * issuer, describe each persona to the scripted Cognito (the fixture), and run `next dev` on
 * loopback with `AUTH_KIT_MATRIX=1`, the fixture, and AWS made unreachable. Node only.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { UserAuthFactors } from '../server/cognito.js';
import { amplifyCookieNames } from '../server/tokens.js';
import { MATRIX_ENV_FLAG, MATRIX_FIXTURE_ENV } from '../shared/matrix-protocol.js';
import { AWS_BLOCKED_ENV } from './aws-env.js';
import { MATRIX_FIXTURE_VERSION, type MatrixFixture, type MatrixFixtureUser } from './fixture.js';
import { type TestIssuer, createTestIssuer } from './issuer.js';
import type { PersonaDefinition } from './matrix.js';

/** How the scripted Cognito should describe one test person. */
export interface MatrixPersonaSpec {
  /** Groups in their access token. Default none (a member). */
  groups?: readonly string[];
  /** Groups Cognito reports now, when they differ from the token (a demoted admin). */
  liveGroups?: readonly string[];
  /** `false`: disabled after the token was issued. */
  enabled?: boolean;
  /** `true`: signed out everywhere after the token was issued. */
  sessionRevoked?: boolean;
  /** Default a password and an authenticator; `{ configured: ['PASSWORD'], mfa: [] }` for one without. */
  factors?: UserAuthFactors;
  /** Default `<persona>@matrix.test`. */
  email?: string;
  /** Default a fresh UUID, as in email-as-username pools. */
  sub?: string;
}

/**
 * A freshly signed-up Member (ADR 0023) who has finished signing up: no groups, and the passkey they
 * chose at "Choose how you'll sign in next time" (the first credential is required, register A1).
 * Use it as the `newMember` persona on sign-up sites (`assertAuthMatrix({ signUpSite: true })`).
 */
export const FRESH_SIGN_UP_MEMBER: Readonly<MatrixPersonaSpec> = Object.freeze({
  groups: Object.freeze([]),
  factors: Object.freeze({ configured: Object.freeze(['EMAIL_OTP', 'WEB_AUTHN']), mfa: Object.freeze([]) }),
});

/**
 * An account with only emailed codes: an invitee or a sign-up whose first code signed it in, closed
 * before choosing a passkey or a password. The server refuses it everywhere but the chooser (403
 * `first_credential_required`, M2). Use it as the `codeOnlyMember` persona (required on sign-up sites).
 */
export const EMAILED_CODE_ONLY_MEMBER: Readonly<MatrixPersonaSpec> = Object.freeze({
  groups: Object.freeze([]),
  factors: Object.freeze({ configured: Object.freeze(['EMAIL_OTP']), mfa: Object.freeze([]) }),
});

/** One persona's session, ready to send. */
export interface MatrixPersona {
  readonly username: string;
  readonly sub: string;
  readonly email: string;
  readonly groups: readonly string[];
  readonly accessToken: string;
  readonly idToken: string;
  /** Amplify's `ssr: true` cookies, the way a signed-in browser sends them. */
  readonly cookie: PersonaDefinition;
  /** `Authorization: Bearer <access token>`. */
  readonly bearer: PersonaDefinition;
}

/** Amplify cookies for one session (the same shape `amplifyCookiePersona` sends). */
function cookieHeader(clientId: string, username: string, accessToken: string, idToken: string): string {
  const names = amplifyCookieNames(clientId, username);
  const pairs = [`${names.lastAuthUser}=${encodeURIComponent(username)}`, `${names.accessToken}=${accessToken}`];
  if (names.idToken) pairs.push(`${names.idToken}=${idToken}`);
  return pairs.join('; ');
}

const PERSONA_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/**
 * Tokens and the fixture for a set of personas, without starting anything (for apps that run their
 * own server). Each persona's username is its sub, as in email-as-username pools.
 */
export function matrixFixture<P extends string>(input: {
  issuer: TestIssuer;
  personas: Record<P, MatrixPersonaSpec>;
}): { fixture: MatrixFixture; personas: Record<P, MatrixPersona> } {
  const users: MatrixFixtureUser[] = [];
  const personas = {} as Record<P, MatrixPersona>;
  for (const [name, spec] of Object.entries(input.personas) as [P, MatrixPersonaSpec][]) {
    if (!PERSONA_NAME.test(name) || name === 'anonymous') {
      throw new Error(`auth-kit: matrix persona name "${name}" must be a plain identifier other than "anonymous" (anonymous is always included).`);
    }
    const sub = spec.sub ?? randomUUID();
    const username = sub;
    const email = spec.email ?? `${name.toLowerCase()}@matrix.test`;
    const groups = [...(spec.groups ?? [])];
    users.push({
      username,
      sub,
      email,
      groups,
      ...(spec.liveGroups !== undefined && { liveGroups: [...spec.liveGroups] }),
      ...(spec.enabled !== undefined && { enabled: spec.enabled }),
      ...(spec.sessionRevoked !== undefined && { sessionRevoked: spec.sessionRevoked }),
      ...(spec.factors !== undefined && { factors: { configured: [...spec.factors.configured], mfa: [...spec.factors.mfa] } }),
    });
    const accessToken = input.issuer.mintAccessToken({ sub, username, groups });
    const idToken = input.issuer.mintIdToken({ sub, username, groups, email, emailVerified: true });
    personas[name] = Object.freeze({
      username,
      sub,
      email,
      groups: Object.freeze(groups),
      accessToken,
      idToken,
      cookie: { headers: { cookie: cookieHeader(input.issuer.clientId, username, accessToken, idToken) } },
      bearer: { headers: { authorization: `Bearer ${accessToken}` } },
    });
  }
  return { fixture: { version: MATRIX_FIXTURE_VERSION, jwks: input.issuer.jwks, users }, personas };
}

export interface StartMatrixServerOptions<P extends string> {
  /** The app's root, where `next dev` runs. Default `process.cwd()`. */
  cwd?: string;
  personas: Record<P, MatrixPersonaSpec>;
  /** The pool and app client the app's `createServerAuth` expects. Default: `amplify_outputs.json` in `cwd`. */
  pool?: { userPoolId: string; clientId: string };
  /** Default: a free port on 127.0.0.1. */
  port?: number;
  /**
   * More environment for the dev server (the origin your routes expect, a separate `distDir`). The
   * matrix flag, the fixture, `ALLOW_DEV_SIGNIN=0`, and the AWS block always win; `NODE_ENV` is
   * never passed (`next dev` sets it).
   */
  env?: Record<string, string | undefined>;
  /** The command to run. Default `<cwd>/node_modules/.bin/next dev --hostname 127.0.0.1 --port <port>`. */
  command?: (port: number) => readonly [string, ...string[]];
  /** Ready once `GET <readyPath>` answers below 500 (redirects count). Default `/`. */
  readyPath?: string;
  /** Default 180 seconds: the first compile is slow. */
  readyTimeoutMs?: number;
}

export interface MatrixServer<P extends string> {
  /** `http://127.0.0.1:<port>`: a loopback URL, as the proxy's "without proxy" pass requires. */
  readonly baseUrl: string;
  readonly port: number;
  readonly clientId: string;
  readonly personas: Readonly<Record<P, MatrixPersona>>;
  /** `anonymous` plus each persona's Amplify cookies, for `assertAuthMatrix({ personas })`. */
  readonly cookiePersonas: Readonly<Record<P | 'anonymous', PersonaDefinition>>;
  readonly fixture: MatrixFixture;
  /** The issuer behind the tokens, to mint more (expired, tampered, another app client's). */
  readonly issuer: TestIssuer;
  /** The server's recent output. */
  log(): string;
  /** Stops the server and everything it started. */
  stop(): Promise<void>;
}

/** The dev server's environment: the parent's minus anything that could reach AWS or confuse Next. */
export function matrixServerEnv(
  parent: Readonly<Record<string, string | undefined>>,
  extra: Readonly<Record<string, string | undefined>>,
  fixture: MatrixFixture,
): Record<string, string> {
  const env: Record<string, string> = {};
  const drop = (key: string) => /^AWS_/.test(key) || key === 'NODE_ENV' || key.startsWith('VITEST') || key === 'TEST' || key === 'JEST_WORKER_ID';
  for (const source of [parent, extra]) {
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined || drop(key)) continue;
      env[key] = value;
    }
  }
  return {
    ...env,
    [MATRIX_ENV_FLAG]: '1',
    [MATRIX_FIXTURE_ENV]: JSON.stringify(fixture),
    // Values already in the environment win over .env.local, so "Sign in as…" stays off and the
    // AWS profile in .env.local is never used.
    ALLOW_DEV_SIGNIN: '0',
    NEXT_TELEMETRY_DISABLED: '1',
    ...AWS_BLOCKED_ENV,
  };
}

function readPool(cwd: string): { userPoolId: string; clientId: string } {
  const file = join(cwd, 'amplify_outputs.json');
  let outputs: { auth?: { user_pool_id?: unknown; user_pool_client_id?: unknown } };
  try {
    outputs = JSON.parse(readFileSync(file, 'utf8')) as typeof outputs;
  } catch {
    throw new Error(`auth-kit: startMatrixServer needs ${file} (a placeholder works in CI), or pass { pool: { userPoolId, clientId } }.`);
  }
  const userPoolId = outputs.auth?.user_pool_id;
  const clientId = outputs.auth?.user_pool_client_id;
  if (typeof userPoolId !== 'string' || typeof clientId !== 'string') {
    throw new Error(`auth-kit: ${file} has no auth.user_pool_id / auth.user_pool_client_id.`);
  }
  return { userPoolId, clientId };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_LOG = 256 * 1024;

/**
 * Starts the app under `next dev` for the auth matrix and hands back each persona's session.
 * Run `next build` first if the matrix reads routes from the build (`routesFromNextBuild`).
 *
 * ```ts
 * // vitest globalSetup, or a beforeAll
 * const server = await startMatrixServer({
 *   personas: { member: {}, otherMember: {}, admin: { groups: ['admin-content-people'] }, noAuthenticator: { factors: { configured: ['PASSWORD'], mfa: [] } } },
 *   env: { APP_DEV_ORIGIN: '…' },
 * });
 * await assertAuthMatrix({ baseUrl: server.baseUrl, personas: server.cookiePersonas, … });
 * await server.stop();
 * ```
 */
export async function startMatrixServer<P extends string>(options: StartMatrixServerOptions<P>): Promise<MatrixServer<P>> {
  const cwd = options.cwd ?? process.cwd();
  const pool = options.pool ?? readPool(cwd);
  const issuer = createTestIssuer(pool);
  const { fixture, personas } = matrixFixture({ issuer, personas: options.personas });
  const port = options.port ?? (await freePort());
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`auth-kit: port ${port} is out of range.`);
  const baseUrl = `http://127.0.0.1:${port}`;
  const [command, ...args] = options.command?.(port) ?? [join(cwd, 'node_modules', '.bin', 'next'), 'dev', '--hostname', '127.0.0.1', '--port', String(port)];
  const readyPath = options.readyPath ?? '/';
  const timeout = options.readyTimeoutMs ?? 180_000;

  let output = '';
  const child: ChildProcess = spawn(command, args, {
    cwd,
    // Next's types make NODE_ENV required; it's left out on purpose (`next dev` sets it).
    env: matrixServerEnv(process.env, options.env ?? {}, fixture) as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group, so stop() ends the workers `next dev` starts too.
    detached: process.platform !== 'win32',
  });
  const collect = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-MAX_LOG);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  let spawnError: Error | null = null;
  child.once('error', (error) => (spawnError = error));
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const log = () => output.split('\n').slice(-60).join('\n');

  const signal = (name: NodeJS.Signals) => {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
    try {
      if (process.platform === 'win32') child.kill(name);
      else process.kill(-child.pid, name);
    } catch {
      // already gone
    }
  };
  const onExit = () => signal('SIGKILL');
  process.once('exit', onExit);

  const stop = async () => {
    process.removeListener('exit', onExit);
    if (child.exitCode !== null || child.signalCode !== null) return;
    signal('SIGTERM');
    const gone = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]);
    if (!gone) {
      signal('SIGKILL');
      await Promise.race([exited, sleep(2000)]);
    }
  };

  try {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (spawnError) throw new Error(`auth-kit: couldn't start the matrix server (${command}): ${(spawnError as Error).message}`);
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`auth-kit: the matrix server exited (${child.exitCode ?? child.signalCode}) before it was ready.\n${log()}`);
      }
      try {
        const response = await fetch(new URL(readyPath, baseUrl), { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
        await response.body?.cancel();
        if (response.status < 500) break;
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) throw new Error(`auth-kit: the matrix server wasn't ready within ${Math.round(timeout / 1000)}s.\n${log()}`);
      await sleep(250);
    }
  } catch (error) {
    await stop();
    throw error;
  }

  const cookiePersonas = { anonymous: {} } as Record<P | 'anonymous', PersonaDefinition>;
  for (const [name, persona] of Object.entries(personas) as [P, MatrixPersona][]) cookiePersonas[name] = persona.cookie;
  return Object.freeze({
    baseUrl,
    port,
    clientId: pool.clientId,
    personas,
    cookiePersonas,
    fixture,
    issuer,
    log,
    stop,
  });
}
