/**
 * The Lambda handler `InviteExpirySweep` (in `auth-kit/admin/cdk`) deploys. Not a public subpath:
 * the build bundles it, with the AWS SDK clients it calls, into `dist/lambda/invite-expiry/index.mjs`,
 * so the function runs exactly the code in the release tarball.
 *
 * Configuration comes from the function's environment (set by the construct). A run that couldn't
 * disable a due invite, or that didn't check everyone, throws after logging what it did, so the
 * function's Errors metric (and the construct's alarm) report it. Never logs addresses.
 */
import { createDynamoAuditLog } from './audit.js';
import type { InviteMode } from './guardrails.js';
import { INVITE_EXPIRY_ENV } from './invite-expiry-env.js';
import { type InviteExpirySweepOptions, type SweepResult, createInviteExpirySweep, regionOfUserPool } from './sweep.js';


const INVITE_MODES: readonly InviteMode[] = ['emailed-code', 'temporary-password'];

export interface InviteExpiryConfig {
  userPoolId: string;
  auditTable: string;
  inviteMode: InviteMode;
  maxPeople?: number;
}

/** Reads and checks the function's environment. Throws, naming every problem, rather than guess. */
export function inviteExpiryConfig(env: Readonly<Record<string, string | undefined>>): InviteExpiryConfig {
  const problems: string[] = [];
  const userPoolId = env[INVITE_EXPIRY_ENV.userPoolId] ?? '';
  if (!regionOfUserPool(userPoolId)) problems.push(`${INVITE_EXPIRY_ENV.userPoolId} must be a user pool ID`);
  const auditTable = env[INVITE_EXPIRY_ENV.auditTable] ?? '';
  if (!/^[A-Za-z0-9_.-]{3,255}$/.test(auditTable)) problems.push(`${INVITE_EXPIRY_ENV.auditTable} must be a DynamoDB table name`);
  const mode = env[INVITE_EXPIRY_ENV.inviteMode] ?? 'emailed-code';
  if (!(INVITE_MODES as readonly string[]).includes(mode)) problems.push(`${INVITE_EXPIRY_ENV.inviteMode} must be ${INVITE_MODES.join(' or ')}`);
  const rawMax = env[INVITE_EXPIRY_ENV.maxPeople];
  const maxPeople = rawMax === undefined || rawMax === '' ? undefined : Number(rawMax);
  if (maxPeople !== undefined && (!Number.isInteger(maxPeople) || maxPeople < 1)) problems.push(`${INVITE_EXPIRY_ENV.maxPeople} must be a whole number of at least 1`);
  if (problems.length > 0) throw new Error(`auth-kit invite-expiry sweep: ${problems.join('; ')}.`);
  return { userPoolId, auditTable, inviteMode: mode as InviteMode, ...(maxPeople !== undefined && { maxPeople }) };
}

/** What one run reports in its log line: counts and subs, never addresses. */
export interface InviteExpiryReport {
  event: 'auth-kit.invite-expiry';
  checked: number;
  disabled: string[];
  failed: { sub: string; error: string }[];
  truncated: boolean;
}

export interface InviteExpiryHandlerOptions {
  env?: Readonly<Record<string, string | undefined>>;
  /** Tests: build the sweep with injected clients. Default `createInviteExpirySweep`. */
  createSweep?: (options: InviteExpirySweepOptions) => () => Promise<SweepResult>;
  log?: (line: string) => void;
}

/** The handler, built lazily so a bad environment fails the invocation (and its alarm), not the import. */
export function createInviteExpiryHandler(options: InviteExpiryHandlerOptions = {}): () => Promise<InviteExpiryReport> {
  let sweep: (() => Promise<SweepResult>) | undefined;
  // The function's log is its only output: one JSON line per run (CloudWatch keeps it).
  // eslint-disable-next-line no-console
  const log = options.log ?? ((line: string) => console.log(line));
  return async () => {
    if (!sweep) {
      const config = inviteExpiryConfig(options.env ?? process.env);
      sweep = (options.createSweep ?? createInviteExpirySweep)({
        userPoolId: config.userPoolId,
        auditLog: createDynamoAuditLog({ tableName: config.auditTable }),
        inviteMode: config.inviteMode,
        ...(config.maxPeople !== undefined && { maxPeople: config.maxPeople }),
      });
    }
    const result = await sweep();
    const report: InviteExpiryReport = { event: 'auth-kit.invite-expiry', ...result };
    log(JSON.stringify(report));
    const problems = [
      ...(result.failed.length > 0 ? [`${result.failed.length} due invite(s) couldn't be disabled`] : []),
      ...(result.truncated ? [`the pool has more than ${result.checked} accounts, so the rest weren't checked (raise maxPeople)`] : []),
    ];
    if (problems.length > 0) throw new Error(`auth-kit invite-expiry sweep: ${problems.join('; ')}. See the log line above.`);
    return report;
  };
}

export { INVITE_EXPIRY_ENV };

/** The Lambda entry point. */
export const handler: () => Promise<InviteExpiryReport> = createInviteExpiryHandler();
