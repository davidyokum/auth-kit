/**
 * `auth-kit/dev`: the localhost kit (primer Chapter 8, 03 §2 "Local development").
 *
 * Phase 1 (0.1.0-alpha) ships the safety checks as tested pure functions: the three dev sign-in
 * gates, the sandbox-tag guard, persona validation, and the ribbon's model. Seeding, the real
 * "Sign in as…" exchange, the ribbon component, and the production-build check are stubs.
 *
 * Never import this module from code that runs in production. The template wires the dev route so
 * it's left out of production builds, and a CI check proves it.
 */
import { DEV_POLICY, STANDARD_GROUPS } from '../shared/policy.js';
import { NotImplementedError } from '../shared/not-implemented.js';

export { NotImplementedError };

// ---- The three gates ----------------------------------------------------------------------------

export type DevGateId = 'nodeEnv' | 'host' | 'flag';

/** One gate alone fails silently when a deploy is misconfigured, so all three must pass. */
export const DEV_GATES: readonly { id: DevGateId; label: string; check: string; failsWhen: string }[] = [
  {
    id: 'nodeEnv',
    label: 'Development mode',
    check: "process.env.NODE_ENV === 'development'",
    failsWhen: 'Every deployed build: next build sets NODE_ENV to production',
  },
  {
    id: 'host',
    label: 'A localhost host name',
    check: 'hostname is localhost or *.localhost',
    failsWhen: 'Never on its own: the sender writes the Host header (hence binding the dev server to 127.0.0.1)',
  },
  {
    id: 'flag',
    label: 'An explicit flag',
    check: "process.env.ALLOW_DEV_SIGNIN === '1'",
    failsWhen: "Wherever the flag isn't set; a flag copied into a branch's settings ships with it",
  },
];

export interface DevGateInput {
  nodeEnv: string | undefined;
  /** The request's Host header. */
  host: string | null | undefined;
  /** `process.env.ALLOW_DEV_SIGNIN`. */
  flag: string | undefined;
}

export interface DevGateResult {
  allowed: boolean;
  failed: DevGateId[];
}

/** True for `localhost` or `*.localhost`, with or without a port. */
export function isLocalhostName(host: string | null | undefined): boolean {
  if (!host) return false;
  const m = /^([a-z0-9.-]+)(?::(\d{1,5}))?$/i.exec(host.trim());
  if (!m?.[1]) return false;
  const name = m[1].toLowerCase().replace(/\.$/, '');
  if (name !== 'localhost' && !name.endsWith('.localhost')) return false;
  // Each label must be a valid DNS label (no empty labels like "a..localhost").
  return name.split('.').every((label) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label));
}

/** Checks all three gates. "Sign in as…" answers 404 unless `allowed` is true. */
export function checkDevSignInGates(input: DevGateInput): DevGateResult {
  const failed: DevGateId[] = [];
  if (input.nodeEnv !== 'development') failed.push('nodeEnv');
  if (!isLocalhostName(input.host)) failed.push('host');
  if (input.flag !== '1') failed.push('flag');
  return { allowed: failed.length === 0, failed };
}

/** The gates for the current process and a request. */
export function devSignInGatesFor(request: { headers: { get(name: string): string | null } }): DevGateResult {
  return checkDevSignInGates({
    nodeEnv: process.env.NODE_ENV,
    host: request.headers.get('host'),
    flag: process.env.ALLOW_DEV_SIGNIN,
  });
}

/** The dev server command: listen on loopback only, so the café Wi-Fi can't send `Host: localhost`. */
export const DEV_SERVER_COMMAND = 'next dev --hostname 127.0.0.1';

// ---- Sandbox guard ------------------------------------------------------------------------------

export class NotASandboxPoolError extends Error {
  constructor(poolId: string) {
    super(
      `auth-kit: pool ${poolId} isn't tagged ${DEV_POLICY.sandboxTag.key}=${DEV_POLICY.sandboxTag.value}. ` +
        'Seeding and "Sign in as…" run only against an Amplify sandbox pool.',
    );
    this.name = 'NotASandboxPoolError';
  }
}

/** Throws unless the pool's tags say it's a sandbox. Anything that seeds or signs people in calls this. */
export function assertSandboxPool(poolId: string, tags: Readonly<Record<string, string | undefined>> | undefined): void {
  if (tags?.[DEV_POLICY.sandboxTag.key] !== DEV_POLICY.sandboxTag.value) throw new NotASandboxPoolError(poolId);
}

// ---- Personas -----------------------------------------------------------------------------------

export type PersonaRole = (typeof DEV_POLICY.personaRoles)[number];

export interface Persona {
  role: PersonaRole;
  /** Ends in `.test`, e.g. `editor@personas.test`. */
  email: string;
  name?: string;
  /** App roles to add on top (e.g. `['reviewer']`). */
  appRoles?: string[];
}

/** `role@personas.test`. */
export function personaEmail(role: PersonaRole): string {
  return `${role}@${DEV_POLICY.personaEmailDomain}`;
}

/** The default personas: one per admin role plus a member with no group. */
export function defaultPersonas(): Persona[] {
  return DEV_POLICY.personaRoles.map((role) => ({ role, email: personaEmail(role) }));
}

/**
 * Validates `personas.json`: one persona per role, every address on a `.test` domain (a reserved TLD
 * that never delivers mail), and no duplicates. Returns the parsed list.
 */
export function parsePersonas(input: unknown): Persona[] {
  if (!Array.isArray(input)) throw new Error('auth-kit: personas.json must be an array.');
  const problems: string[] = [];
  const seenRoles = new Set<string>();
  const seenEmails = new Set<string>();
  const personas: Persona[] = [];
  for (const [i, raw] of input.entries()) {
    const p = raw as Partial<Persona>;
    const where = `personas[${i}]`;
    if (!p || typeof p !== 'object') {
      problems.push(`${where} isn't an object.`);
      continue;
    }
    if (!p.role || !(DEV_POLICY.personaRoles as readonly string[]).includes(p.role)) {
      problems.push(`${where}.role must be one of ${DEV_POLICY.personaRoles.join(', ')}.`);
    } else if (seenRoles.has(p.role)) problems.push(`${where}: a second "${p.role}" persona.`);
    else seenRoles.add(p.role);
    const email = typeof p.email === 'string' ? p.email.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[a-z0-9.-]+\.test$/.test(email)) problems.push(`${where}.email must end in ".test".`);
    else if (seenEmails.has(email)) problems.push(`${where}: duplicate email ${email}.`);
    else seenEmails.add(email);
    if (p.appRoles !== undefined && (!Array.isArray(p.appRoles) || p.appRoles.some((r) => typeof r !== 'string'))) {
      problems.push(`${where}.appRoles must be a list of group names.`);
    }
    if (p.appRoles?.some((r) => (STANDARD_GROUPS as readonly string[]).includes(r))) {
      problems.push(`${where}.appRoles can't include admin roles; use "role".`);
    }
    personas.push({
      role: p.role as PersonaRole,
      email,
      ...(p.name !== undefined && { name: p.name }),
      ...(p.appRoles !== undefined && { appRoles: p.appRoles }),
    });
  }
  for (const role of DEV_POLICY.personaRoles) if (!seenRoles.has(role)) problems.push(`no "${role}" persona.`);
  if (problems.length > 0) throw new Error(`auth-kit: personas.json is invalid:\n- ${problems.join('\n- ')}`);
  return personas;
}

export interface SeedPersonasOptions {
  /** `--profile` for the AWS SDK; the script asserts the account ID before writing. */
  awsProfile: string;
  expectedAccountId: string;
  userPoolId: string;
  personas: Persona[];
  /** Where generated passwords go (git-ignored). Default `.env.local`. */
  envFile?: string;
}

/**
 * TODO(phase-2): AdminCreateUser + AdminSetUserPassword(Permanent) + AdminAddUserToGroup for each
 * persona, after `sts get-caller-identity` matches `expectedAccountId` and `assertSandboxPool` passes.
 */
export function seedPersonas(_options: SeedPersonasOptions): Promise<never> {
  return Promise.reject(new NotImplementedError('seedPersonas'));
}

// ---- "Sign in as…" ------------------------------------------------------------------------------

export interface DevSignInHandlerOptions {
  userPoolId: string;
  clientId: string;
  /** Persona passwords, read from `.env.local`. */
  passwords: () => Record<string, string>;
}

/**
 * The dev sign-in route handler. Phase 1: answers 404 unless all three gates pass, then 501.
 * TODO(phase-2): AdminInitiateAuth (ADMIN_USER_PASSWORD_AUTH, sandbox client only) for the chosen
 * persona after `assertSandboxPool`, then store the real tokens in Amplify's cookies.
 */
export function createDevSignInHandler(_options: DevSignInHandlerOptions): (request: Request) => Promise<Response> {
  return (request) => {
    if (!devSignInGatesFor(request).allowed) {
      return Promise.resolve(new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } }));
    }
    return Promise.resolve(
      new Response('Dev sign-in arrives in auth-kit phase 2.', { status: 501, headers: { 'Cache-Control': 'no-store' } }),
    );
  };
}

// ---- Environment ribbon -------------------------------------------------------------------------

export type RibbonEnvironment = 'local' | 'preview' | 'production';

export interface EnvironmentRibbonInput {
  environment: RibbonEnvironment;
  poolId: string;
  /** True when the pool is the sandbox pool (from its Environment tag or outputs). */
  poolIsSandbox: boolean;
  persona?: string | null;
}

export interface EnvironmentRibbonModel {
  show: boolean;
  label: string;
  tone: 'local' | 'preview' | 'danger';
  titlePrefix: '' | '[DEV] ' | '[PREVIEW] ';
}

/**
 * What the ribbon shows. Every environment except the live site shows it; a local app pointed at a
 * non-sandbox pool turns it red.
 */
export function environmentRibbonModel(input: EnvironmentRibbonInput): EnvironmentRibbonModel {
  if (input.environment === 'production') return { show: false, label: '', tone: 'preview', titlePrefix: '' };
  const who = input.persona ? ` · signed in as ${input.persona} (test)` : '';
  if (input.environment === 'local') {
    if (!input.poolIsSandbox) {
      return {
        show: true,
        label: `LOCAL · NOT A SANDBOX POOL (${input.poolId})${who}`,
        tone: 'danger',
        titlePrefix: '[DEV] ',
      };
    }
    return { show: true, label: `LOCAL · sandbox pool ${input.poolId}${who}`, tone: 'local', titlePrefix: '[DEV] ' };
  }
  return { show: true, label: `PREVIEW · pool ${input.poolId}${who}`, tone: 'preview', titlePrefix: '[PREVIEW] ' };
}

/** TODO(phase-2): the React ribbon component (fixed bar, per-environment color, favicon swap). */
export function EnvironmentRibbon(_props: EnvironmentRibbonInput): never {
  throw new NotImplementedError('EnvironmentRibbon');
}

// ---- Production-build check ---------------------------------------------------------------------

export interface ProductionBuildCheckOptions {
  /** The built app directory, e.g. `.next`. */
  buildDir: string;
  /** Default `/dev/sign-in`. */
  devRoute?: string;
}

/**
 * TODO(phase-2): fails if a production build contains the dev sign-in code or answers its route with
 * anything but 404. Runs in CI.
 */
export function checkProductionBuild(_options: ProductionBuildCheckOptions): Promise<never> {
  return Promise.reject(new NotImplementedError('checkProductionBuild'));
}

export { DEV_POLICY };
