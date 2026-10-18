/**
 * The Lambda handler `UnverifiedAccountSweep` (in `auth-kit/admin/cdk`) deploys. Not a public
 * subpath: the build bundles it, with the AWS SDK clients it calls, into
 * `dist/lambda/unverified-sweep/index.mjs`. A run that couldn't delete a due account, or didn't check
 * everyone, throws after logging what it did, so the function's Errors metric (and the construct's
 * alarm) report it. Never logs addresses.
 */
import { createDynamoAuditLog } from '../admin/audit.js';
import { redactAddresses } from '../admin/redact.js';
import { regionOfUserPool } from '../admin/sweep.js';
import { UNVERIFIED_SWEEP_ENV } from './jobs-env.js';
import { type UnverifiedSweepOptions, type UnverifiedSweepResult, createUnverifiedAccountSweep } from './unverified-sweep.js';

export interface UnverifiedSweepConfig {
  userPoolId: string;
  auditTable: string;
  maxPeople?: number;
  olderThanHours?: number;
}

function wholeNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : Number.NaN;
}

/** Reads and checks the function's environment. Throws, naming every problem. */
export function unverifiedSweepConfig(env: Readonly<Record<string, string | undefined>>): UnverifiedSweepConfig {
  const problems: string[] = [];
  const userPoolId = env[UNVERIFIED_SWEEP_ENV.userPoolId] ?? '';
  if (!regionOfUserPool(userPoolId)) problems.push(`${UNVERIFIED_SWEEP_ENV.userPoolId} must be a user pool ID`);
  const auditTable = env[UNVERIFIED_SWEEP_ENV.auditTable] ?? '';
  if (!/^[A-Za-z0-9_.-]{3,255}$/.test(auditTable)) problems.push(`${UNVERIFIED_SWEEP_ENV.auditTable} must be a DynamoDB table name`);
  const maxPeople = wholeNumber(env[UNVERIFIED_SWEEP_ENV.maxPeople]);
  if (Number.isNaN(maxPeople)) problems.push(`${UNVERIFIED_SWEEP_ENV.maxPeople} must be a whole number of at least 1`);
  const olderThanHours = wholeNumber(env[UNVERIFIED_SWEEP_ENV.olderThanHours]);
  if (Number.isNaN(olderThanHours)) problems.push(`${UNVERIFIED_SWEEP_ENV.olderThanHours} must be a whole number of at least 1`);
  if (problems.length > 0) throw new Error(`auth-kit unverified-account sweep: ${problems.join('; ')}.`);
  return { userPoolId, auditTable, ...(maxPeople !== undefined && { maxPeople }), ...(olderThanHours !== undefined && { olderThanHours }) };
}

export interface UnverifiedSweepReport extends UnverifiedSweepResult {
  event: 'auth-kit.unverified-sweep';
}

export interface UnverifiedSweepHandlerOptions {
  env?: Readonly<Record<string, string | undefined>>;
  createSweep?: (options: UnverifiedSweepOptions) => () => Promise<UnverifiedSweepResult>;
  log?: (line: string) => void;
}

export function createUnverifiedSweepHandler(options: UnverifiedSweepHandlerOptions = {}): () => Promise<UnverifiedSweepReport> {
  let sweep: (() => Promise<UnverifiedSweepResult>) | undefined;
  // eslint-disable-next-line no-console
  const log = options.log ?? ((line: string) => console.log(line));
  return async () => {
    if (!sweep) {
      const config = unverifiedSweepConfig(options.env ?? process.env);
      sweep = (options.createSweep ?? createUnverifiedAccountSweep)({
        userPoolId: config.userPoolId,
        auditLog: createDynamoAuditLog({ tableName: config.auditTable }),
        ...(config.maxPeople !== undefined && { maxPeople: config.maxPeople }),
        ...(config.olderThanHours !== undefined && { olderThanHours: config.olderThanHours }),
      });
    }
    const result = await sweep();
    const report: UnverifiedSweepReport = { event: 'auth-kit.unverified-sweep', ...result, failed: result.failed.map((f) => ({ ...f, error: redactAddresses(f.error) })) };
    log(JSON.stringify(report));
    // A run that hit maxDeletesPerRun (deferred) isn't a failure: the next run carries on.
    const problems = [
      ...(result.failed.length > 0 ? [`${result.failed.length} due account(s) couldn't be deleted`] : []),
      ...(result.truncated ? [`the pool has more than ${result.checked} enabled accounts, so the rest weren't checked (raise maxPeople)`] : []),
    ];
    if (problems.length > 0) throw new Error(`auth-kit unverified-account sweep: ${problems.join('; ')}. See the log line above.`);
    return report;
  };
}

export const handler: () => Promise<UnverifiedSweepReport> = createUnverifiedSweepHandler();
