/**
 * The sandbox guard. Anything that seeds accounts or signs people in refuses a pool unless it's an
 * Amplify sandbox: tagged `Environment=sandbox` by the preset, and showing none of the signs of a
 * deployed pool (an Amplify branch, deletion protection, real numbers of users, the wrong account).
 */
import { type CognitoIdentityProviderClient, DescribeUserPoolCommand } from '@aws-sdk/client-cognito-identity-provider';
import { DEV_POLICY } from '../shared/policy.js';
import { accountFromArn } from './aws.js';

export class NotASandboxPoolError extends Error {
  readonly problems: readonly string[];
  constructor(poolId: string, problems: readonly string[] = [`it isn't tagged ${DEV_POLICY.sandboxTag.key}=${DEV_POLICY.sandboxTag.value}`]) {
    super(
      `auth-kit: refusing pool ${poolId}: ${problems.join('; ')}. ` +
        'Seeding and "Sign in as…" run only against your own Amplify sandbox pool (npx ampx sandbox).',
    );
    this.name = 'NotASandboxPoolError';
    this.problems = problems;
  }
}

/** Throws unless the pool's tags say it's a sandbox. */
export function assertSandboxPool(poolId: string, tags: Readonly<Record<string, string | undefined>> | undefined): void {
  if (tags?.[DEV_POLICY.sandboxTag.key] !== DEV_POLICY.sandboxTag.value) throw new NotASandboxPoolError(poolId);
}

/** What the dev kit reads about a pool before trusting it. */
export interface PoolInspection {
  userPoolId: string;
  arn?: string;
  /** From the pool's ARN: the account the pool (and so the caller's credentials) belongs to. */
  accountId?: string;
  tags: Record<string, string>;
  deletionProtection?: string;
  estimatedUsers?: number;
  mfaConfiguration?: string;
}

/** Reads the pool's tags and settings (`DescribeUserPool`, read-only). */
export async function inspectUserPool(client: CognitoIdentityProviderClient, userPoolId: string): Promise<PoolInspection> {
  const { UserPool: pool } = await client.send(new DescribeUserPoolCommand({ UserPoolId: userPoolId }));
  if (!pool) throw new Error(`auth-kit: DescribeUserPool returned nothing for ${userPoolId}.`);
  const accountId = accountFromArn(pool.Arn);
  return {
    userPoolId,
    ...(pool.Arn !== undefined && { arn: pool.Arn }),
    ...(accountId !== undefined && { accountId }),
    tags: { ...(pool.UserPoolTags ?? {}) },
    ...(pool.DeletionProtection !== undefined && { deletionProtection: pool.DeletionProtection }),
    ...(pool.EstimatedNumberOfUsers !== undefined && { estimatedUsers: pool.EstimatedNumberOfUsers }),
    ...(pool.MfaConfiguration !== undefined && { mfaConfiguration: pool.MfaConfiguration }),
  };
}

export interface SandboxPolicy {
  /** Refuse unless the pool's ARN names this AWS account. */
  expectedAccountId?: string;
  /** A sandbox holds a handful of personas; refuse a pool with more users than this. Default 50. */
  maxUsers?: number;
}

export const DEFAULT_SANDBOX_MAX_USERS = 50;

/** Every reason this pool isn't safe to seed or sign personas into. Empty means it's a sandbox. */
export function sandboxProblems(inspection: PoolInspection, policy: SandboxPolicy = {}): string[] {
  const { key, value } = DEV_POLICY.sandboxTag;
  const tags = inspection.tags;
  const problems: string[] = [];
  if (tags[key] !== value) problems.push(`it isn't tagged ${key}=${value} (${key}=${tags[key] ?? 'missing'})`);
  const deploymentType = tags['amplify:deployment-type'];
  if (deploymentType !== undefined && deploymentType !== 'sandbox') problems.push(`Amplify deployed it as a ${deploymentType}, not a sandbox`);
  if (tags['amplify:branch-name'] !== undefined) problems.push(`it belongs to the Amplify branch "${tags['amplify:branch-name']}"`);
  if (inspection.deletionProtection === 'ACTIVE') problems.push('deletion protection is on (the preset turns it off only in sandboxes)');
  const maxUsers = policy.maxUsers ?? DEFAULT_SANDBOX_MAX_USERS;
  if (inspection.estimatedUsers !== undefined && inspection.estimatedUsers > maxUsers) {
    problems.push(`it holds about ${inspection.estimatedUsers} users, more than a sandbox's ${maxUsers}`);
  }
  if (policy.expectedAccountId !== undefined) {
    if (inspection.accountId === undefined) problems.push("its ARN doesn't name an account to check");
    else if (inspection.accountId !== policy.expectedAccountId) {
      problems.push(`it's in AWS account ${inspection.accountId}, not the expected ${policy.expectedAccountId}`);
    }
  }
  return problems;
}

/** Throws `NotASandboxPoolError` with every problem found. */
export function assertSandboxInspection(inspection: PoolInspection, policy: SandboxPolicy = {}): void {
  const problems = sandboxProblems(inspection, policy);
  if (problems.length > 0) throw new NotASandboxPoolError(inspection.userPoolId, problems);
}

// ---- The cached check the route and the ribbon use ---------------------------------------------

export type SandboxCheckResult =
  | { ok: true; inspection: PoolInspection }
  | { ok: false; problems: string[]; inspection?: PoolInspection; error?: unknown };

export interface SandboxCheckOptions {
  getClient: () => CognitoIdentityProviderClient;
  userPoolId: string;
  policy?: SandboxPolicy;
  /** How long a passing check is reused. Default 5 minutes. */
  okTtlMs?: number;
  /** How long a failing check is reused, so a fix shows up quickly. Default 15 seconds. */
  failTtlMs?: number;
  now?: () => number;
}

interface CacheEntry {
  expires: number;
  result: Promise<SandboxCheckResult>;
}

// Shared across module instances: Next may bundle the route and the layout separately.
const CACHE = Symbol.for('auth-kit.dev.sandbox-check');
function store(): Map<string, CacheEntry> {
  const g = globalThis as { [CACHE]?: Map<string, CacheEntry> };
  return (g[CACHE] ??= new Map<string, CacheEntry>());
}

/** Forgets cached sandbox checks (tests, or after re-tagging a pool). */
export function clearSandboxCheckCache(): void {
  store().clear();
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * A sandbox check that calls `DescribeUserPool` at most once per TTL per pool, and never throws:
 * an AWS failure is a failed check ("couldn't confirm it's a sandbox"), never a pass.
 */
export function cachedSandboxCheck(options: SandboxCheckOptions): () => Promise<SandboxCheckResult> {
  const now = options.now ?? Date.now;
  const okTtl = options.okTtlMs ?? 5 * 60_000;
  const failTtl = options.failTtlMs ?? 15_000;
  const key = [options.userPoolId, options.policy?.expectedAccountId ?? '', options.policy?.maxUsers ?? ''].join('|');

  const run = async (): Promise<SandboxCheckResult> => {
    try {
      const inspection = await inspectUserPool(options.getClient(), options.userPoolId);
      const problems = sandboxProblems(inspection, options.policy);
      return problems.length === 0 ? { ok: true, inspection } : { ok: false, problems, inspection };
    } catch (error) {
      return { ok: false, problems: [`couldn't read the pool's tags (${errorText(error)})`], error };
    }
  };

  return async () => {
    const cache = store();
    const hit = cache.get(key);
    if (hit && hit.expires > now()) return hit.result;
    const entry: CacheEntry = { expires: Number.POSITIVE_INFINITY, result: run() };
    cache.set(key, entry);
    const settled = await entry.result;
    entry.expires = now() + (settled.ok ? okTtl : failTtl);
    return settled;
  };
}
