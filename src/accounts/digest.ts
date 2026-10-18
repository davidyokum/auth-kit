/**
 * The daily access-request digest (register D3, ADR 0023): the admins who manage people get one email
 * a day listing the pending requests, instead of one email per request; the People page shows a badge
 * and a "Pending requests" tab meanwhile. Each run also deletes requests past their retention (30 days
 * after they're settled, the typed name and reason with them), so the rule holds even while DynamoDB's
 * TTL lags.
 *
 * The email's subject and preheader are counts and the site name only (anyone can file a request, so
 * its words are the sender's), and its body lists at most 25 requests, then how many more wait. When
 * the store's list stops before the end, the email and the result say so (`truncated`).
 *
 * No Next.js or React: `AccessRequestDigest` bundles this into a Lambda.
 */
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { CognitoAdmin } from '../admin/cognito-admin.js';
import type { EmailSender } from '../admin/mailer.js';
import { type QuotaLimiterOptions, type Sleep, createQuotaLimiter } from '../admin/quota.js';
import { regionOfUserPool } from '../admin/sweep.js';
import { accessRequestDigestEmail, type EmailSite } from '../shared/emails.js';
import { STANDARD_CAPABILITIES, type StandardGroup } from '../shared/policy.js';
import type { SignInHelpSource } from './sign-in-help.js';
import { helpAddressOf } from './sign-in-help.js';
import type { AccessRequestStore } from './stores.js';

/** The standard groups whose roles manage people (`people.manage`): the owner, Super admins, Admin – content & people. */
export const PEOPLE_MANAGER_GROUPS: readonly StandardGroup[] = (Object.keys(STANDARD_CAPABILITIES) as StandardGroup[]).filter((g) =>
  (STANDARD_CAPABILITIES[g] as readonly string[]).includes('people.manage'),
);

export interface AccessRequestDigestOptions {
  requests: AccessRequestStore;
  userPoolId: string;
  region?: string;
  mailer: EmailSender;
  site: Omit<EmailSite, 'helpEmail'> & { help: SignInHelpSource };
  /** The People page's absolute URL, which the email names. */
  peopleUrl: string;
  /** Groups whose enabled members get the digest. Default `PEOPLE_MANAGER_GROUPS`; add the app's own groups that hold `people.manage`. */
  recipientGroups?: readonly string[];
  cognito?: CognitoIdentityProviderClient;
  quota?: QuotaLimiterOptions;
  now?: () => number;
  sleep?: Sleep;
}

export interface AccessRequestDigestResult {
  /** Pending requests read. With `truncated`, more were waiting: this is a floor, not the count. */
  pending: number;
  /** The store's list stopped before the end; the email says "more than" instead of a count. */
  truncated: boolean;
  /** True when the digest went out (nothing is sent when nothing is pending). */
  sent: boolean;
  recipients: number;
  /** Requests deleted because their retention ran out. */
  purged: number;
}

export function createAccessRequestDigest(options: AccessRequestDigestOptions): () => Promise<AccessRequestDigestResult> {
  const region = options.region ?? regionOfUserPool(options.userPoolId);
  if (!region) throw new Error(`auth-kit: userPoolId "${options.userPoolId}" isn't a Cognito user pool ID.`);
  const groups = [...(options.recipientGroups ?? PEOPLE_MANAGER_GROUPS)];
  if (groups.length === 0) throw new Error('auth-kit: the digest needs at least one recipient group.');
  const client = options.cognito ?? new CognitoIdentityProviderClient({ region, maxAttempts: 1 });
  const cognito = new CognitoAdmin(client, options.userPoolId, createQuotaLimiter({ ...(options.sleep !== undefined && { sleep: options.sleep }), ...options.quota }));
  const now = options.now ?? Date.now;

  return async () => {
    const at = new Date(now());
    const purged = await options.requests.purge(at);
    const { requests, truncated } = await options.requests.list(at);
    if (requests.length === 0) return { pending: 0, truncated, sent: false, recipients: 0, purged };
    const recipients = new Set<string>();
    for (const group of groups) for (const p of await cognito.listGroupMembers(group)) if (p.enabled && p.email) recipients.add(p.email);
    if (recipients.size === 0) throw new Error('auth-kit access-request digest: requests are waiting, but nobody who manages people has an email address to send them to.');
    const helpEmail = await helpAddressOf(options.site.help);
    const { help: _help, ...site } = options.site;
    const email = accessRequestDigestEmail(
      { ...site, helpEmail },
      {
        requests: requests.map((r) => ({
          email: r.email,
          ...(r.name !== undefined && { name: r.name }),
          ...(r.reason !== undefined && { reason: r.reason }),
          requestedAt: new Date(r.createdAt),
          expiresAt: new Date(r.expiresAt),
        })),
        peopleUrl: options.peopleUrl,
        truncated,
      },
    );
    await options.mailer.sendEmail({ to: [...recipients], email, replyTo: [helpEmail] });
    return { pending: requests.length, truncated, sent: true, recipients: recipients.size, purged };
  };
}
