/**
 * Seeds the personas into a sandbox pool (primer Chapter 8, "Under the hood"; 03 §2 "Local
 * development"). Idempotent: it converges each persona to `personas.json` and `.env.local`, and a
 * second run with nothing to change makes no writes; it only signs each persona in to prove it works.
 *
 * Before writing anything it reads the pool and refuses unless it's a sandbox (see `sandbox.ts`),
 * optionally asserting the AWS account from the pool's ARN. Passwords and authenticator secrets go
 * to the git-ignored `.env.local` and are never printed.
 */
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  type AdminGetUserCommandOutput,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  type AttributeType,
  type CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { resolve } from 'node:path';
import { generatePersonaPassword, type GitIgnoreStatus, gitIgnoreStatus, readEnvFile, writeEnvValues } from './env-file.js';
import { enrollPersonaTotp, PersonaSignInError, signInPersona } from './exchange.js';
import { type Persona, parsePersonas, personaEnvNames } from './personas.js';
import { assertSandboxInspection, inspectUserPool, type PoolInspection, type SandboxPolicy } from './sandbox.js';

export interface SeedPersonasOptions {
  client: CognitoIdentityProviderClient;
  userPoolId: string;
  /** The app client "Sign in as…" uses; seeding signs each persona in through it. */
  clientId: string;
  /** `personas.json` contents (validated here). */
  personas: unknown;
  /** The app's roles; every group must be an admin role or one of these. */
  appRoles?: readonly string[];
  /** Refuse unless the pool's ARN names this account. */
  expectedAccountId?: string;
  /** Refuse a pool with more users than this. Default 50. */
  maxUsers?: number;
  /** Default `.env.local` in `cwd`. */
  envFile?: string;
  cwd?: string;
  /** Enroll each persona in an authenticator (TOTP). Default true; the standard requires it of password users. */
  totp?: boolean;
  /** Read and report, but write nothing (no AWS writes, no file writes, no sign-ins). */
  dryRun?: boolean;
  /** Progress lines. Never receives a password or secret. */
  log?: (line: string) => void;
  /** Overrides for tests. */
  gitIgnore?: (path: string) => Promise<GitIgnoreStatus>;
  random?: (size: number) => Buffer;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SeededPersona {
  key: string;
  email: string;
  /** What changed, e.g. `created`, `password set`, `added to admin-content`, `authenticator enrolled`, `verified`. */
  actions: string[];
}

export interface SeedReport {
  pool: PoolInspection;
  envFile: string;
  personas: SeededPersona[];
  /** True when nothing needed to change. */
  unchanged: boolean;
  dryRun: boolean;
}

const WRITE_ACTIONS = /^(created|password set|email verified|attributes updated|enabled|added to|removed from|authenticator enrolled|would )/;

function attrs(user: AdminGetUserCommandOutput): Map<string, string> {
  return new Map((user.UserAttributes ?? []).map((a) => [a.Name ?? '', a.Value ?? '']));
}

async function getUser(client: CognitoIdentityProviderClient, userPoolId: string, email: string) {
  try {
    return await client.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email }));
  } catch (error) {
    if (error instanceof Error && error.name === 'UserNotFoundException') return undefined;
    throw error;
  }
}

async function listGroups(client: CognitoIdentityProviderClient, userPoolId: string, username: string): Promise<string[]> {
  const groups: string[] = [];
  let next: string | undefined;
  do {
    const page = await client.send(new AdminListGroupsForUserCommand({ UserPoolId: userPoolId, Username: username, NextToken: next }));
    groups.push(...(page.Groups ?? []).map((g) => g.GroupName ?? '').filter(Boolean));
    next = page.NextToken;
  } while (next);
  return groups;
}

/** Seeds or updates every persona. Throws before any write if the pool isn't a sandbox. */
export async function seedPersonas(options: SeedPersonasOptions): Promise<SeedReport> {
  const log = options.log ?? (() => {});
  const { client, userPoolId, clientId } = options;
  const dryRun = options.dryRun === true;
  const personas = parsePersonas(options.personas, { ...(options.appRoles !== undefined && { appRoles: options.appRoles }) });
  const envFile = resolve(options.cwd ?? process.cwd(), options.envFile ?? '.env.local');

  // 1. The pool must be a sandbox, in the expected account. Nothing is written before this passes.
  const pool = await inspectUserPool(client, userPoolId);
  const policy: SandboxPolicy = {
    ...(options.expectedAccountId !== undefined && { expectedAccountId: options.expectedAccountId }),
    ...(options.maxUsers !== undefined && { maxUsers: options.maxUsers }),
  };
  assertSandboxInspection(pool, policy);
  log(`Pool ${userPoolId} is a sandbox${pool.accountId ? ` in AWS account ${pool.accountId}` : ''}.`);

  // 2. The secrets file must be git-ignored.
  const ignore = await (options.gitIgnore ?? gitIgnoreStatus)(envFile);
  if (ignore === 'not-ignored') {
    throw new Error(`auth-kit: ${envFile} isn't git-ignored (or is already committed). Add it to .gitignore before seeding.`);
  }

  const totpWanted = options.totp !== false && pool.mfaConfiguration !== 'OFF';
  if (options.totp !== false && pool.mfaConfiguration === 'OFF') {
    log('The pool has MFA off, so personas get no authenticator. The standard requires one of password users.');
  }

  const env = (await readEnvFile(envFile)).values;
  const random = options.random;
  const ctx = {
    client,
    userPoolId,
    clientId,
    ...(options.now !== undefined && { now: options.now }),
    ...(options.sleep !== undefined && { sleep: options.sleep }),
  };
  const persist = async (updates: Map<string, string>) => {
    for (const [k, v] of updates) env.set(k, v);
    if (!dryRun) await writeEnvValues(envFile, updates);
  };

  const report: SeededPersona[] = [];
  for (const persona of personas) {
    const actions: string[] = [];
    const act = (done: string, planned: string) => actions.push(dryRun ? planned : done);
    const names = personaEnvNames(persona.key);

    // 3. The user, with a verified .test address and any extra attributes.
    let user = await getUser(client, userPoolId, persona.email);
    let created = false;
    if (!user) {
      act('created', 'would create');
      created = true;
      if (!dryRun) {
        const attributes: AttributeType[] = [
          { Name: 'email', Value: persona.email },
          { Name: 'email_verified', Value: 'true' },
          ...Object.entries(persona.attributes ?? {}).map(([Name, Value]) => ({ Name, Value })),
        ];
        await client.send(
          new AdminCreateUserCommand({ UserPoolId: userPoolId, Username: persona.email, MessageAction: 'SUPPRESS', UserAttributes: attributes }),
        );
        user = await getUser(client, userPoolId, persona.email);
      }
    } else {
      const current = attrs(user);
      const fixes: AttributeType[] = [];
      if (current.get('email_verified') !== 'true') fixes.push({ Name: 'email_verified', Value: 'true' });
      for (const [Name, Value] of Object.entries(persona.attributes ?? {})) if (current.get(Name) !== Value) fixes.push({ Name, Value });
      if (fixes.length > 0) {
        if (fixes.some((f) => f.Name === 'email_verified')) act('email verified', 'would verify email');
        else act('attributes updated', 'would update attributes');
        if (!dryRun) await client.send(new AdminUpdateUserAttributesCommand({ UserPoolId: userPoolId, Username: user.Username, UserAttributes: fixes }));
      }
      if (user.Enabled === false) {
        act('enabled', 'would enable');
        if (!dryRun) await client.send(new AdminEnableUserCommand({ UserPoolId: userPoolId, Username: user.Username }));
      }
    }
    const username = user?.Username ?? persona.email;

    // 4. The password: from .env.local, or generated and saved there before Cognito gets it, so a
    //    failure in between leaves a password the next run can still set.
    const stored = env.get(names.password);
    const password = stored || generatePersonaPassword(random);
    let passwordSet = false;
    const setPassword = async () => {
      act('password set', 'would set password');
      if (!dryRun) await client.send(new AdminSetUserPasswordCommand({ UserPoolId: userPoolId, Username: username, Password: password, Permanent: true }));
      passwordSet = true;
    };
    if (!stored) await persist(new Map([[names.password, password]]));
    if (created || !stored || ['FORCE_CHANGE_PASSWORD', 'RESET_REQUIRED'].includes(user?.UserStatus ?? '')) await setPassword();

    // 5. Groups: exactly the persona's.
    const have = user && !created ? await listGroups(client, userPoolId, username) : [];
    for (const group of persona.groups.filter((g) => !have.includes(g))) {
      act(`added to ${group}`, `would add to ${group}`);
      if (!dryRun) {
        try {
          await client.send(new AdminAddUserToGroupCommand({ UserPoolId: userPoolId, Username: username, GroupName: group }));
        } catch (error) {
          if (error instanceof Error && error.name === 'ResourceNotFoundException') {
            throw new Error(`auth-kit: the pool has no group "${group}" (persona ${persona.key}). Is it in the preset's appRoles?`, { cause: error });
          }
          throw error;
        }
      }
    }
    for (const group of have.filter((g) => !persona.groups.includes(g))) {
      act(`removed from ${group}`, `would remove from ${group}`);
      if (!dryRun) await client.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: userPoolId, Username: username, GroupName: group }));
    }

    // 6. The authenticator, then a real sign-in to prove the persona works as "Sign in as…" will use it.
    if (!dryRun) {
      const enrolled = (user?.UserMFASettingList ?? []).includes('SOFTWARE_TOKEN_MFA');
      const enroll = async () => {
        const { secret } = await enrollPersonaTotp({ ...ctx, email: persona.email, password });
        await persist(new Map([[names.totpSecret, secret]]));
        act('authenticator enrolled', 'would enroll authenticator');
      };
      if (totpWanted && (!enrolled || !env.get(names.totpSecret))) {
        await enroll();
      } else {
        const verify = () => {
          const secret = env.get(names.totpSecret);
          return signInPersona({ ...ctx, email: persona.email, password, ...(secret ? { totpSecret: secret } : {}) });
        };
        let verified = true;
        try {
          await verify();
        } catch (error) {
          if (!(error instanceof PersonaSignInError)) throw error;
          if (error.code === 'wrong_password' && !passwordSet) {
            await setPassword();
            await verify();
          } else if (totpWanted && ['totp_rejected', 'needs_totp_secret', 'needs_mfa_setup'].includes(error.code)) {
            await enroll(); // enrolling signs the persona in, which proves it as well
            verified = false;
          } else throw error;
        }
        if (verified) actions.push('verified');
      }
    } else if (totpWanted && !(user?.UserMFASettingList ?? []).includes('SOFTWARE_TOKEN_MFA')) {
      actions.push('would enroll authenticator');
    }

    report.push({ key: persona.key, email: persona.email, actions });
    log(`${persona.key} (${persona.email}): ${actions.length > 0 ? actions.join(', ') : 'no changes'}`);
  }

  const unchanged = report.every((p) => p.actions.every((a) => !WRITE_ACTIONS.test(a)));
  return { pool, envFile, personas: report, unchanged, dryRun };
}

export type { Persona };
