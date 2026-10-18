/**
 * The Lambda handler `AccessRequestDigest` (in `auth-kit/admin/cdk`) deploys, bundled into
 * `dist/lambda/access-request-digest/index.mjs`. Purges requests past retention, then emails the
 * pending ones to the admins who manage people. A run that fails throws, so the alarm fires. Its log
 * line holds counts only.
 */
import { createSesInviteMailer } from '../admin/mailer.js';
import { regionOfUserPool } from '../admin/sweep.js';
import { isThemeFamily, type ThemeFamily } from '../themes/index.js';
import { type AccessRequestDigestOptions, type AccessRequestDigestResult, createAccessRequestDigest } from './digest.js';
import { ACCESS_REQUEST_DIGEST_ENV as E } from './jobs-env.js';
import { createSignInHelp } from './sign-in-help.js';
import { createDynamoAccessRequestStore, createDynamoSiteSettingsStore } from './stores.js';

export interface AccessRequestDigestConfig {
  userPoolId: string;
  requestTable: string;
  settingsTable?: string;
  siteName: string;
  family: ThemeFamily;
  signInUrl: string;
  peopleUrl: string;
  helpEmail: string;
  mailFrom: string;
  mailConfigurationSet?: string;
  recipientGroups?: string[];
}

const TABLE_RE = /^[A-Za-z0-9_.-]{3,255}$/;

export function accessRequestDigestConfig(env: Readonly<Record<string, string | undefined>>): AccessRequestDigestConfig {
  const problems: string[] = [];
  const value = (name: string) => {
    const v = env[name]?.trim();
    return v === undefined || v === '' ? undefined : v;
  };
  const userPoolId = value(E.userPoolId) ?? '';
  if (!regionOfUserPool(userPoolId)) problems.push(`${E.userPoolId} must be a user pool ID`);
  const requestTable = value(E.requestTable) ?? '';
  if (!TABLE_RE.test(requestTable)) problems.push(`${E.requestTable} must be a DynamoDB table name`);
  const settingsTable = value(E.settingsTable);
  if (settingsTable !== undefined && !TABLE_RE.test(settingsTable)) problems.push(`${E.settingsTable} must be a DynamoDB table name`);
  const siteName = value(E.siteName) ?? '';
  if (!siteName) problems.push(`${E.siteName} is required`);
  const family = value(E.family) ?? 'personal';
  if (!isThemeFamily(family)) problems.push(`${E.family} must be osbm, unc, or personal`);
  for (const key of [E.signInUrl, E.peopleUrl] as const) if (!/^https:\/\/[^\s]+$/.test(value(key) ?? '')) problems.push(`${key} must be an https URL`);
  const helpEmail = value(E.helpEmail) ?? '';
  if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(helpEmail)) problems.push(`${E.helpEmail} must be the help address`);
  const mailFrom = value(E.mailFrom) ?? '';
  if (!mailFrom.includes('@') || /[\r\n]/.test(mailFrom)) problems.push(`${E.mailFrom} must be a sender address`);
  const groups = value(E.recipientGroups)?.split(',').map((g) => g.trim()).filter(Boolean);
  if (problems.length > 0) throw new Error(`auth-kit access-request digest: ${problems.join('; ')}.`);
  const configurationSet = value(E.mailConfigurationSet);
  return {
    userPoolId,
    requestTable,
    ...(settingsTable !== undefined && { settingsTable }),
    siteName,
    family: family as ThemeFamily,
    signInUrl: value(E.signInUrl)!,
    peopleUrl: value(E.peopleUrl)!,
    helpEmail,
    mailFrom,
    ...(configurationSet !== undefined && { mailConfigurationSet: configurationSet }),
    ...(groups !== undefined && groups.length > 0 && { recipientGroups: groups }),
  };
}

export interface AccessRequestDigestReport extends AccessRequestDigestResult {
  event: 'auth-kit.access-request-digest';
}

export interface AccessRequestDigestHandlerOptions {
  env?: Readonly<Record<string, string | undefined>>;
  createDigest?: (options: AccessRequestDigestOptions) => () => Promise<AccessRequestDigestResult>;
  log?: (line: string) => void;
}

export function createAccessRequestDigestHandler(options: AccessRequestDigestHandlerOptions = {}): () => Promise<AccessRequestDigestReport> {
  let digest: (() => Promise<AccessRequestDigestResult>) | undefined;
  // eslint-disable-next-line no-console
  const log = options.log ?? ((line: string) => console.log(line));
  return async () => {
    if (!digest) {
      const config = accessRequestDigestConfig(options.env ?? process.env);
      const help = config.settingsTable
        ? createSignInHelp({ configured: config.helpEmail, store: createDynamoSiteSettingsStore({ tableName: config.settingsTable }) })
        : config.helpEmail;
      digest = (options.createDigest ?? createAccessRequestDigest)({
        requests: createDynamoAccessRequestStore({ tableName: config.requestTable }),
        userPoolId: config.userPoolId,
        mailer: createSesInviteMailer({ from: config.mailFrom, ...(config.mailConfigurationSet !== undefined && { configurationSet: config.mailConfigurationSet }) }),
        site: { siteName: config.siteName, theme: config.family, signInUrl: config.signInUrl, help },
        peopleUrl: config.peopleUrl,
        ...(config.recipientGroups !== undefined && { recipientGroups: config.recipientGroups }),
      });
    }
    const report: AccessRequestDigestReport = { event: 'auth-kit.access-request-digest', ...(await digest()) };
    log(JSON.stringify(report));
    return report;
  };
}

export const handler: () => Promise<AccessRequestDigestReport> = createAccessRequestDigestHandler();
