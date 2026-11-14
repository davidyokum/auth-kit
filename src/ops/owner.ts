/**
 * `npx auth-kit owner`: makes the site's one owner and emails them the first-visit invite.
 *
 * It replaces the two hand-typed AWS commands the template's README used to give (AdminCreateUser,
 * then AdminAddUserToGroup) and the "go to /sign-in and choose Email me a code instead" that followed
 * them, which left the owner on the passkey-first screen with nothing saved yet. Here the owner gets
 * the same invite email as anyone the People page invites: its link opens the card in first-visit
 * mode with their address filled in, so the way in is one emailed code, then a passkey.
 *
 * It refuses, before anything is written:
 * - a pool in another AWS account than the one named (`expectedAccountId`, from the pool's ARN);
 * - a pool that already has a different owner (a site has exactly one; move it on the People page);
 * - an address that has already signed in (that account is set up; nothing to invite).
 *
 * An account the command made before and that hasn't signed in yet gets a fresh invite (the 7-day
 * expiry starts again), so the command can be run again safely. It records no audit row: it is the one
 * time the owner role is set outside the app (and the break-glass fix for a pool with none).
 */
import { type CognitoIdentityProviderClient, DescribeUserPoolCommand } from '@aws-sdk/client-cognito-identity-provider';
import { accountFromArn } from '../dev/aws.js';
import { CognitoAdmin, type CognitoPerson } from '../admin/cognito-admin.js';
import type { InviteMailer } from '../admin/mailer.js';
import { createQuotaLimiter } from '../admin/quota.js';
import { INVITE_EXPIRY_DAYS, OWNER_GROUP } from '../shared/policy.js';
import type { ThemeFamily } from '../themes/index.js';

export interface OwnerOptions {
  client: CognitoIdentityProviderClient;
  mailer: InviteMailer;
  userPoolId: string;
  /** Refuse unless the pool's ARN names this 12-digit account. Required: a wrong profile is refused before anything is written. */
  expectedAccountId: string;
  email: string;
  name?: string;
  siteName: string;
  /** The site's absolute sign-in URL on its final address, e.g. `https://reports.example.org/sign-in`. */
  signInUrl: string;
  family: ThemeFamily;
  /** The help address in effect (the email's "Help:" line). */
  helpEmail: string;
  /** Report what would happen; write and send nothing. */
  dryRun?: boolean;
  log?: (line: string) => void;
  now?: () => Date;
}

export type OwnerOutcome = 'created' | 'reinvited' | 'planned';

export interface OwnerReport {
  outcome: OwnerOutcome;
  email: string;
  /** What ran (or would run), in order, for the log. */
  steps: string[];
}

function normalized(email: string): string {
  const e = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error(`auth-kit owner: "${email}" isn't an email address.`);
  return e;
}

function absoluteSignInUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`auth-kit owner: --sign-in-url must be the site's absolute sign-in address, such as https://reports.example.org/sign-in (got "${url}").`);
  }
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && !parsed.hostname.endsWith('.localhost')) {
    throw new Error('auth-kit owner: --sign-in-url must be https (passkeys need the site’s real address).');
  }
  return parsed.toString();
}

/** Makes (or re-invites) the owner. Throws, having written nothing, on any refusal above. */
export async function createOwner(options: OwnerOptions): Promise<OwnerReport> {
  const log = options.log ?? (() => {});
  const email = normalized(options.email);
  const signInUrl = absoluteSignInUrl(options.signInUrl);
  if (!/^\d{12}$/.test(options.expectedAccountId)) throw new Error('auth-kit owner: --account must be the 12-digit AWS account the pool lives in.');
  const pool = await options.client.send(new DescribeUserPoolCommand({ UserPoolId: options.userPoolId }));
  const account = accountFromArn(pool.UserPool?.Arn);
  if (account !== options.expectedAccountId) {
    throw new Error(`auth-kit owner: pool ${options.userPoolId} is in AWS account ${account ?? 'unknown'}, not ${options.expectedAccountId}. Nothing was changed.`);
  }
  log(`Pool ${options.userPoolId} (${pool.UserPool?.Name ?? 'unnamed'}) is in AWS account ${account}.`);

  const admin = new CognitoAdmin(options.client, options.userPoolId, createQuotaLimiter());
  const owners = await admin.listGroupMembers(OWNER_GROUP);
  const otherOwner = owners.find((o) => o.email?.toLowerCase() !== email);
  if (otherOwner) {
    throw new Error(
      `auth-kit owner: this site already has an owner (${otherOwner.email ?? otherOwner.username}). A site has exactly one: the owner moves it on the People page. Nothing was changed.`,
    );
  }
  const existing: CognitoPerson | null = await admin.findByEmail(email);
  if (existing && signedInBefore(existing)) {
    throw new Error(`auth-kit owner: ${email} has already signed in to this site, so there's nothing to invite. ${owners.length > 0 ? 'It is the owner.' : 'Make it the owner on the People page.'}`);
  }

  const steps: string[] = [];
  if (!existing) steps.push(`AdminCreateUser ${email} (no password, Cognito's own email suppressed)`);
  if (!owners.some((o) => o.email?.toLowerCase() === email)) steps.push(`AdminAddUserToGroup ${email} → ${OWNER_GROUP}`);
  steps.push(`SES SendEmail: the invite to ${email}, its link opening ${new URL(signInUrl).host} in first-visit mode`);
  if (options.dryRun) {
    for (const s of steps) log(`Would run: ${s}`);
    return { outcome: 'planned', email, steps };
  }

  const person = existing ?? (await admin.createInvitedUser({ email, ...(options.name !== undefined && { name: options.name }), mode: 'emailed-code' }));
  if (!existing && person.status === 'FORCE_CHANGE_PASSWORD') {
    await admin.deleteUser(person.username).catch(() => undefined);
    throw new Error('auth-kit owner: this pool gave the new account a password, so it can’t sign in with an emailed code. Check the pool uses auth-kit’s preset. The account was deleted again.');
  }
  if (!owners.some((o) => o.email?.toLowerCase() === email)) await admin.addToGroup(person.username, OWNER_GROUP);
  const now = options.now?.() ?? new Date();
  await options.mailer.sendInvite({
    email,
    ...(options.name !== undefined && { name: options.name }),
    siteName: options.siteName,
    signInUrl,
    expiresAt: new Date(now.getTime() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000),
    theme: options.family,
    helpEmail: options.helpEmail,
    roleLabel: 'Owner',
  });
  for (const s of steps) log(`Done: ${s}`);
  return { outcome: existing ? 'reinvited' : 'created', email, steps };
}

/** An invited account that never signed in has no verified email (the invite sets none; ADR 0019's signal). */
function signedInBefore(person: CognitoPerson): boolean {
  return person.emailVerified === true;
}
