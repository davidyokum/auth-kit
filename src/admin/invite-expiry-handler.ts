/**
 * The Lambda handler `InviteExpirySweep` (in `auth-kit/admin/cdk`) deploys. Not a public subpath:
 * the build bundles it, with the AWS SDK clients it calls, into `dist/lambda/invite-expiry/index.mjs`,
 * so the function runs exactly the code in the release tarball.
 *
 * Configuration comes from the function's environment (set by the construct). A run that couldn't
 * disable a due invite, that didn't check everyone, or that left the last owner's invite open but
 * couldn't warn anyone (or log it), throws after logging what it did, so the function's Errors metric
 * (and the construct's alarm) report it. A last-owner skip that warned and logged is not a failure.
 * Never logs addresses.
 */
import { createDynamoAuditLog } from './audit.js';
import { redactAddresses } from './redact.js';
import type { InviteMode } from './guardrails.js';
import { INVITE_EXPIRY_ENV } from './invite-expiry-env.js';
import { createSesInviteMailer } from './mailer.js';
import { type InviteExpirySweepOptions, type SweepResult, type SweepSkip, createInviteExpirySweep, regionOfUserPool } from './sweep.js';


const INVITE_MODES: readonly InviteMode[] = ['emailed-code', 'temporary-password'];

export interface InviteExpiryConfig {
  userPoolId: string;
  auditTable: string;
  inviteMode: InviteMode;
  maxPeople?: number;
  /** Minutes between runs, when the schedule is a rate: last-owner warnings then go out once a day. */
  runEveryMinutes?: number;
  /** How a skipped last owner is warned (SES). Absent: a skip that needed a warning fails the run. */
  ownerWarnings?: {
    siteName: string;
    from: string;
    signInUrl?: string;
    fallbackEmail?: string;
    configurationSet?: string;
  };
}

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

/** A whole number of at least 1 from the environment; undefined when unset; NaN when malformed. */
function wholeNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : Number.NaN;
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
  const maxPeople = wholeNumber(env[INVITE_EXPIRY_ENV.maxPeople]);
  if (Number.isNaN(maxPeople)) problems.push(`${INVITE_EXPIRY_ENV.maxPeople} must be a whole number of at least 1`);
  const runEveryMinutes = wholeNumber(env[INVITE_EXPIRY_ENV.runEveryMinutes]);
  if (Number.isNaN(runEveryMinutes)) problems.push(`${INVITE_EXPIRY_ENV.runEveryMinutes} must be a whole number of at least 1`);

  const value = (name: string) => {
    const v = env[name]?.trim();
    return v === undefined || v === '' ? undefined : v;
  };
  const siteName = value(INVITE_EXPIRY_ENV.siteName);
  const from = value(INVITE_EXPIRY_ENV.mailFrom);
  const signInUrl = value(INVITE_EXPIRY_ENV.signInUrl);
  const fallbackEmail = value(INVITE_EXPIRY_ENV.ownerWarningFallback);
  const configurationSet = value(INVITE_EXPIRY_ENV.mailConfigurationSet);
  let ownerWarnings: InviteExpiryConfig['ownerWarnings'];
  if ([siteName, from, signInUrl, fallbackEmail, configurationSet].some((v) => v !== undefined)) {
    if (!siteName) problems.push(`${INVITE_EXPIRY_ENV.siteName} is required with the owner-warning settings`);
    if (!from || !from.includes('@') || /[\r\n]/.test(from)) problems.push(`${INVITE_EXPIRY_ENV.mailFrom} must be a sender address (\`Site <noreply@example.org>\`)`);
    if (signInUrl !== undefined && !/^https:\/\/[^\s]+$/.test(signInUrl)) problems.push(`${INVITE_EXPIRY_ENV.signInUrl} must be an https URL`);
    if (fallbackEmail !== undefined && !EMAIL_RE.test(fallbackEmail)) problems.push(`${INVITE_EXPIRY_ENV.ownerWarningFallback} must be an email address`);
    ownerWarnings = {
      siteName: siteName ?? '',
      from: from ?? '',
      ...(signInUrl !== undefined && { signInUrl }),
      ...(fallbackEmail !== undefined && { fallbackEmail }),
      ...(configurationSet !== undefined && { configurationSet }),
    };
  }
  if (problems.length > 0) throw new Error(`auth-kit invite-expiry sweep: ${problems.join('; ')}.`);
  return {
    userPoolId,
    auditTable,
    inviteMode: mode as InviteMode,
    ...(maxPeople !== undefined && { maxPeople }),
    ...(runEveryMinutes !== undefined && { runEveryMinutes }),
    ...(ownerWarnings !== undefined && { ownerWarnings }),
  };
}

export { redactAddresses };

/** What one run reports in its log line: counts and subs, never addresses. */
export interface InviteExpiryReport {
  event: 'auth-kit.invite-expiry';
  checked: number;
  disabled: string[];
  failed: { sub: string; error: string }[];
  /** Last owners left enabled, whom this run warned (or, between daily warnings, only skipped). */
  skipped: SweepSkip[];
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
      const warnings = config.ownerWarnings;
      sweep = (options.createSweep ?? createInviteExpirySweep)({
        userPoolId: config.userPoolId,
        auditLog: createDynamoAuditLog({ tableName: config.auditTable }),
        inviteMode: config.inviteMode,
        ...(config.maxPeople !== undefined && { maxPeople: config.maxPeople }),
        ...(config.runEveryMinutes !== undefined && { runEveryMinutes: config.runEveryMinutes }),
        ...(warnings !== undefined && {
          ownerWarnings: {
            notifier: createSesInviteMailer({
              from: warnings.from,
              ...(warnings.configurationSet !== undefined && { configurationSet: warnings.configurationSet }),
            }),
            siteName: warnings.siteName,
            ...(warnings.signInUrl !== undefined && { signInUrl: warnings.signInUrl }),
            ...(warnings.fallbackEmail !== undefined && { fallbackEmail: warnings.fallbackEmail }),
          },
        }),
      });
    }
    const result = await sweep();
    const report: InviteExpiryReport = {
      event: 'auth-kit.invite-expiry',
      ...result,
      failed: result.failed.map((f) => ({ ...f, error: redactAddresses(f.error) })),
      skipped: result.skipped.map((s) => ({ ...s, problems: s.problems.map(redactAddresses) })),
    };
    log(JSON.stringify(report));
    const ownerProblems = report.skipped.flatMap((s) => s.problems);
    const problems = [
      ...(result.failed.length > 0 ? [`${result.failed.length} due invite(s) couldn't be disabled`] : []),
      ...(result.truncated ? [`the pool has more than ${result.checked} accounts, so the rest weren't checked (raise maxPeople)`] : []),
      ...(ownerProblems.length > 0 ? [`the last owner's invite was left open (never disabled), but: ${ownerProblems.join(' ')}`] : []),
    ];
    if (problems.length > 0) throw new Error(`auth-kit invite-expiry sweep: ${problems.join('; ')}. See the log line above.`);
    return report;
  };
}

export { INVITE_EXPIRY_ENV };

/** The Lambda entry point. */
export const handler: () => Promise<InviteExpiryReport> = createInviteExpiryHandler();
