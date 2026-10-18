import { Token } from 'aws-cdk-lib';
import {
  type AccountCreationSettings,
  AccountCreationConfigError,
  type NormalizedAccountCreation,
  normalizeAccountCreation,
} from '../shared/account-creation.js';
import {
  type AuthTier,
  SESSION_POLICY,
  STANDARD_GROUPS,
  RETIRED_GROUPS,
  WAF_POLICY,
  codeLifetimeMinutes,
} from '../shared/policy.js';

/** Thrown at synth time when the preset's options can't produce a pool that meets the standard. */
export class AuthStandardConfigError extends Error {
  constructor(message: string) {
    super(`auth-kit: ${message}`);
    this.name = 'AuthStandardConfigError';
  }
}

export interface AuthEmailOptions {
  /** Address auth email comes from, e.g. `noreply@example.org`. Its domain must be verified in SES. */
  fromAddress: string;
  /** Display name, e.g. `Example Reports`. */
  fromName: string;
  replyTo?: string;
  /**
   * The verified SES identity that authorizes `fromAddress`: a domain (the default is `fromAddress`'s
   * domain) or the address itself. Amplify's typed `senders.email` can only point at an address
   * identity, so the preset sets `EmailConfiguration.SourceArn` itself.
   */
  sesIdentity?: string;
  /** Optional SES configuration set (event publishing). */
  configurationSet?: string;
  /** The code email sent when someone verifies or changes an address. */
  verification?: {
    subject?: string;
    body?: (createCode: () => string) => string;
  };
  /**
   * Cognito's own invitation email. Everyday pools invite silently (`MessageAction: SUPPRESS`) and the
   * app sends its own email, so this matters mainly for the admin pool's one-time bootstrap password.
   */
  invitation?: {
    subject?: string;
    body?: (username: () => string, code: () => string) => string;
  };
}

export interface PasskeyOptions {
  /**
   * The site's final domain, e.g. `reports.example.org`. Passkeys are bound to it, and changing it
   * later forces everyone to register again, so switch passkeys on once the final domain is live.
   * (`amplifyapp.com` is on the Public Suffix List; an Amplify default URL would need
   * `<branch>.<appId>.amplifyapp.com`, and passkeys made there won't work on the custom domain.)
   */
  relyingPartyId: string;
  /** Relying-party ID for an Amplify sandbox. Default `localhost`. */
  sandboxRelyingPartyId?: string;
}

/**
 * Rate limiting for the pool's public Cognito API (ADR 0004, ADR 0013).
 *
 * - Default: create a web ACL for this pool. Fine for a first site.
 * - `{ webAclArn }`: reuse an existing REGIONAL web ACL and only associate it with this pool. The
 *   recommended setup once there's more than one site: one shared web ACL per AWS account and Region
 *   (`createSharedAuthWebAcl`), associated with every pool there. AWS WAF bills per web ACL and per
 *   rule, so one shared ACL costs the same for one site or twenty.
 */
export interface WafOptions {
  /**
   * ARN of an existing REGIONAL web ACL (`arn:aws:wafv2:<region>:<account>:regional/webacl/<name>/<id>`)
   * in the pool's Region. The preset associates it and creates nothing else, so the limit and action
   * options below don't apply: they belong to the shared ACL.
   */
  webAclArn?: string;
  /** Protect sandbox pools too (a created ACL is billed; a shared one isn't). Default `false`. */
  enabledInSandbox?: boolean;
  /** Sign-in attempts (InitiateAuth + RespondToAuthChallenge) per IP per window. Default 100. */
  signInLimit?: number;
  /** All inspected requests per IP per window. Default 1000. */
  overallLimit?: number;
  /** Window in seconds: 60, 120, 300 (default), or 600. */
  evaluationWindowSec?: 60 | 120 | 300 | 600;
  /**
   * The sign-in rule's mode. Default `count`: watch a week of its counts (and which operations
   * token refreshes arrive as), then switch it to `block` (ADR 0017).
   */
  signInRule?: WafRuleMode;
  /** The overall per-IP rule's mode. Default `block`, so the pool is never without a limit. */
  overallRule?: WafRuleMode;
}

/** `count` records matches (AWS recommends it while tuning); `block` refuses requests over the limit. */
export type WafRuleMode = 'block' | 'count';

/** The rate rules of a web ACL auth-kit creates. */
export interface WafRuleSettings {
  signInLimit: number;
  overallLimit: number;
  evaluationWindowSec: 60 | 120 | 300 | 600;
  signInRule: WafRuleMode;
  overallRule: WafRuleMode;
}

export type NormalizedWafOptions =
  | ({ mode: 'create'; enabledInSandbox: boolean } & WafRuleSettings)
  | { mode: 'shared'; webAclArn: string; enabledInSandbox: boolean }
  | { mode: 'off' };

/**
 * @deprecated Removed in 0.1.8: `selfSignUp` turned Cognito's own `SignUp` on. Use `accountCreation`
 * (ADR 0023): the server creates every account, and Cognito's `SignUp` stays off. Passing
 * `selfSignUp` throws, explaining the change.
 */
export interface SelfSignUpOptions {
  allowedEmailDomains: readonly string[];
}

/** What `selfSignUp` became, said where it's refused. */
export const SELF_SIGN_UP_REMOVED =
  "selfSignUp was removed in auth-kit 0.1.8 (ADR 0023). It turned Cognito's own SignUp on, which anyone with the public app client ID can call directly, " +
  'skipping the rate limits and the bot check, and which tells callers whether an address already has an account. ' +
  "Use accountCreation: { mode: 'domains', domains: [...] } instead (or 'request' or 'open'): auth-kit's sign-up route creates the account on the server, " +
  "like an invite, and Cognito's SignUp stays off. Keep the preSignUp trigger (auth-kit/amplify/pre-sign-up's preSignUpForAccountCreation), which re-checks the domain list.";

export interface AuthStandardOptions {
  /** Project slug for tags and metric names, e.g. `reports-portal`. */
  project: string;
  /** Who owns the pool (tag), e.g. a team name or address. */
  owner: string;
  /** 2 = named people (default standard); 3 = sensitive (shorter sessions, threat protection). */
  tier: AuthTier;
  /**
   * Configure this backend's pool as a Tier 3 admin pool: MFA required, no emailed codes, recovery by
   * an admin only, and passkeys (once `passkeys` is set) as the way in. Amplify allows one auth
   * resource per backend, so an admin pool lives in its own Amplify backend.
   */
  adminPool?: boolean;
  email: AuthEmailOptions;
  /** Passkey settings, or `false`/omitted until the final domain is live. */
  passkeys?: PasskeyOptions | false;
  /** Groups beyond the standard roles (owner, superadmin, admin-content-people, admin-content, admin-view), e.g. `['reviewer']`. */
  appRoles?: readonly string[];
  /**
   * Rate limiting (see `WafOptions`). `false` leaves the pool with no rate limit at all and must be
   * paired with `acknowledgeNoRateLimit: true`; prefer a shared web ACL (`{ webAclArn }`) instead.
   */
  waf?: WafOptions | false;
  /**
   * Required with `waf: false`, and refused otherwise. Cognito doesn't lock out wrong emailed codes
   * (tested 2026-10-12), so a pool without a rate limit lets anyone keep guessing them.
   */
  acknowledgeNoRateLimit?: boolean;
  /** Refresh-token lifetime in minutes. Default and ceiling: 43200 (30 days) on Tier 2, 1440 (1 day) on Tier 3. */
  refreshTokenMinutes?: number;
  /**
   * Cognito threat protection (Plus plan): sign-in event logs and compromised-credential checks.
   * Default `audit` on Tier 3 (the standard requires sign-in event logs there), `off` on Tier 2.
   */
  threatProtection?: 'off' | 'audit' | 'enforced';
  /** Let the identity pool hand out guest (unauthenticated) AWS credentials. Default `false`. */
  guestAccess?: boolean;
  /** `Environment` tag outside sandboxes. Default: the Amplify branch name. `sandbox` is reserved. */
  environment?: string;
  /** Keep deletion protection on in sandboxes (blocks `ampx sandbox delete`). Default `false`. */
  deletionProtectionInSandbox?: boolean;
  /**
   * How accounts get created on this site (register D1, ADR 0023). Default invite only. In every mode
   * Cognito's own `SignUp` stays off (`AllowAdminCreateUserOnly`): sign-up and request access are
   * auth-kit server routes (`auth-kit/accounts`). In `domains` mode, wire the preSignUp trigger
   * (`preSignUpForAccountCreation` from `auth-kit/amplify/pre-sign-up`), which re-checks the list.
   */
  accountCreation?: AccountCreationSettings;
  /**
   * How long an emailed code works, in minutes: Cognito's sign-in session (`AuthSessionValidity`).
   * Default 3; Cognito allows 3 to 15 (register A7 is choosing between 3 and 10). Pass the same value
   * to the screens (`SignIn`, `SignUp`) and the custom message trigger, which all say it.
   */
  codeLifetimeMinutes?: number;
  /** @deprecated Removed in 0.1.8: throws. Use `accountCreation` (ADR 0023). */
  selfSignUp?: SelfSignUpOptions;
}

export interface NormalizedAuthStandardOptions {
  project: string;
  owner: string;
  tier: AuthTier;
  adminPool: boolean;
  email: Required<Pick<AuthEmailOptions, 'fromAddress' | 'fromName' | 'sesIdentity'>> &
    Pick<AuthEmailOptions, 'replyTo' | 'configurationSet' | 'verification' | 'invitation'>;
  passkeys: Required<PasskeyOptions> | null;
  groups: string[];
  appRoles: string[];
  waf: NormalizedWafOptions;
  refreshTokenMinutes: number;
  threatProtection: 'off' | 'audit' | 'enforced';
  guestAccess: boolean;
  environment: string | undefined;
  deletionProtectionInSandbox: boolean;
  accountCreation: NormalizedAccountCreation;
  codeLifetimeMinutes: number;
}

const EMAIL_RE = /^[^\s@<>"]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const DOMAIN_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
// Cognito tag values: letters, digits, spaces, and _ . : / = + - @ (up to 256 characters).
const TAG_VALUE_RE = /^[\p{L}\p{Z}\p{N}_.:/=+\-@]{1,256}$/u;
// Cognito group names: 1-128 printable characters with no whitespace.
const GROUP_RE = /^[\p{L}\p{M}\p{S}\p{N}\p{P}]{1,128}$/u;
// Public suffixes a relying-party ID can't be (passkeys must be bound to a registrable domain).
const PUBLIC_SUFFIX_RP_IDS = new Set(['amplifyapp.com', 'cloudfront.net', 'amazonaws.com', 'vercel.app', 'github.io']);

function fail(message: string): never {
  throw new AuthStandardConfigError(message);
}

const RULE_KEYS = ['signInLimit', 'overallLimit', 'evaluationWindowSec', 'signInRule', 'overallRule'] as const;
const WAF_KEYS = new Set<string>(['webAclArn', 'enabledInSandbox', ...RULE_KEYS]);
// A REGIONAL web ACL (Cognito can't use CloudFront-scoped ones). WAF IDs are UUIDs.
const WEB_ACL_ARN_RE =
  /^arn:aws(?:-cn|-us-gov|-iso[a-z-]*)?:wafv2:([a-z]{2}(?:-[a-z]+)+-\d):\d{12}:regional\/webacl\/[A-Za-z0-9_-]{1,128}\/[0-9a-f-]{36}$/;

/** The Region in a literal web ACL ARN, or undefined for a CDK token (resolved at deploy). */
export function webAclArnRegion(arn: string): string | undefined {
  return WEB_ACL_ARN_RE.exec(arn)?.[1];
}

function normalizeWaf(input: unknown, acknowledgeNoRateLimit: unknown): NormalizedWafOptions {
  if (acknowledgeNoRateLimit !== undefined && typeof acknowledgeNoRateLimit !== 'boolean') {
    fail('acknowledgeNoRateLimit must be true or false.');
  }
  if (input === false) {
    if (acknowledgeNoRateLimit !== true) {
      fail(
        "waf: false leaves the pool with no rate limit, and Cognito doesn't lock out wrong emailed codes. " +
          'Reuse a shared web ACL with waf: { webAclArn } instead, or set acknowledgeNoRateLimit: true.',
      );
    }
    return { mode: 'off' };
  }
  if (acknowledgeNoRateLimit === true) fail('acknowledgeNoRateLimit applies only with waf: false; remove it.');
  if (input !== undefined && (typeof input !== 'object' || input === null || Array.isArray(input))) {
    fail('waf must be an options object, or false (with acknowledgeNoRateLimit: true).');
  }
  const w = (input ?? {}) as WafOptions & Record<string, unknown>;
  for (const key of Object.keys(w)) {
    if (key === 'enabled') fail('waf.enabled is gone: use waf: false with acknowledgeNoRateLimit: true, or a shared web ACL (waf: { webAclArn }).');
    if (key === 'action') fail(RETIRED_ACTION('waf'));
    if (!WAF_KEYS.has(key)) fail(`waf has no option "${key}".`);
  }
  if (w.enabledInSandbox !== undefined && typeof w.enabledInSandbox !== 'boolean') fail('waf.enabledInSandbox must be true or false.');
  const enabledInSandbox = w.enabledInSandbox === true;

  if (w.webAclArn !== undefined) {
    const extra = RULE_KEYS.filter((k) => w[k] !== undefined);
    if (extra.length > 0) {
      fail(`waf.${extra.join(', waf.')} can't be combined with waf.webAclArn: a shared web ACL's rules are set where it's created.`);
    }
    if (typeof w.webAclArn !== 'string' || w.webAclArn.trim() === '') fail('waf.webAclArn must be a web ACL ARN.');
    const arn = w.webAclArn.trim();
    if (!Token.isUnresolved(arn) && webAclArnRegion(arn) === undefined) {
      fail(
        `waf.webAclArn "${arn}" isn't a REGIONAL web ACL ARN (arn:aws:wafv2:<region>:<account>:regional/webacl/<name>/<id>). ` +
          'Cognito user pools can only use REGIONAL web ACLs.',
      );
    }
    return { mode: 'shared', webAclArn: arn, enabledInSandbox };
  }

  const { webAclArn: _webAclArn, enabledInSandbox: _enabledInSandbox, ...rules } = w;
  return { mode: 'create', enabledInSandbox, ...wafRuleSettings(rules, 'waf') };
}

/** The retired single `action` (it applied to both rules). */
const RETIRED_ACTION = (label: string) =>
  `${label}.action is gone: each rule has its own mode now. Set ${label}.signInRule (default "count") and ${label}.overallRule (default "block") to "count" or "block".`;

/**
 * The rate rules' settings with the standard's defaults filled in (`WAF_POLICY`), checked against
 * AWS WAF's ranges. Refuses unknown keys and the retired `action`. Throws `AuthStandardConfigError`.
 */
export function wafRuleSettings(input: Partial<WafRuleSettings> | undefined, label: string): WafRuleSettings {
  const raw = (input ?? {}) as Partial<WafRuleSettings> & Record<string, unknown>;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail(`${label} must be an options object.`);
  for (const key of Object.keys(raw)) {
    if (key === 'action') fail(RETIRED_ACTION(label));
    if (!(RULE_KEYS as readonly string[]).includes(key)) fail(`${label} has no option "${key}".`);
  }
  return validateWafRules(
    {
      signInLimit: raw.signInLimit ?? WAF_POLICY.signInLimit,
      overallLimit: raw.overallLimit ?? WAF_POLICY.overallLimit,
      evaluationWindowSec: raw.evaluationWindowSec ?? WAF_POLICY.evaluationWindowSec,
      signInRule: raw.signInRule ?? WAF_POLICY.signInRule,
      overallRule: raw.overallRule ?? WAF_POLICY.overallRule,
    },
    label,
  );
}

/** Checks rate-rule settings against AWS WAF's ranges. */
export function validateWafRules(rules: WafRuleSettings, label: string): WafRuleSettings {
  for (const [key, value] of [['signInLimit', rules.signInLimit], ['overallLimit', rules.overallLimit]] as const) {
    if (!Number.isInteger(value) || value < 10 || value > 2_000_000_000) {
      fail(`${label}.${key} must be a whole number from 10 to 2,000,000,000 (AWS WAF's range).`);
    }
  }
  if (![60, 120, 300, 600].includes(rules.evaluationWindowSec)) fail(`${label}.evaluationWindowSec must be 60, 120, 300, or 600.`);
  for (const key of ['signInRule', 'overallRule'] as const) {
    if (rules[key] !== 'block' && rules[key] !== 'count') fail(`${label}.${key} must be "block" or "count".`);
  }
  return rules;
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1).toLowerCase();
}

function validateRelyingPartyId(id: string, label: string): string {
  const rp = id.trim().toLowerCase();
  if (rp !== id.trim()) fail(`${label} must be lowercase: "${id}".`);
  if (rp.includes('://') || rp.includes('/') || rp.includes(':')) {
    fail(`${label} must be a bare host name (no scheme, port, or path): "${id}".`);
  }
  if (rp !== 'localhost' && !DOMAIN_RE.test(rp)) fail(`${label} is not a valid domain: "${id}".`);
  if (rp !== 'localhost' && !rp.includes('.')) fail(`${label} must be a full domain name: "${id}".`);
  // CloudFormation caps WebAuthnRelyingPartyID at 63 characters (the API allows 127).
  if (rp.length > 63) fail(`${label} is longer than CloudFormation's 63-character limit: "${id}".`);
  if (PUBLIC_SUFFIX_RP_IDS.has(rp)) {
    fail(
      `${label} "${id}" is a public suffix. Use the site's own domain, e.g. "<branch>.<appId>.amplifyapp.com" or the custom domain.`,
    );
  }
  return rp;
}

/** Validates options and fills in the standard's defaults. Throws `AuthStandardConfigError`. */
export function normalizeOptions(options: AuthStandardOptions): NormalizedAuthStandardOptions {
  const o = options as Partial<AuthStandardOptions>;
  if (o.tier !== 2 && o.tier !== 3) fail(`tier must be 2 or 3 (got ${String(o.tier)}). Tier 0/1 sites have no pool.`);
  const tier: AuthTier = o.tier;

  const project = (o.project ?? '').trim();
  if (!project || !TAG_VALUE_RE.test(project)) fail('project is required and must be a valid tag value.');
  const owner = (o.owner ?? '').trim();
  if (!owner || !TAG_VALUE_RE.test(owner)) fail('owner is required and must be a valid tag value.');

  // Email through SES from a verified domain.
  const email = o.email;
  if (!email) fail('email settings are required: auth email must go through SES from a verified domain.');
  const fromAddress = (email.fromAddress ?? '').trim();
  if (!EMAIL_RE.test(fromAddress)) fail(`email.fromAddress is not a valid address: "${email.fromAddress}".`);
  const fromName = (email.fromName ?? '').trim();
  if (!fromName || /[<>"\\\r\n]/.test(fromName)) fail('email.fromName is required and may not contain < > " \\ or line breaks.');
  if (email.replyTo !== undefined && !EMAIL_RE.test(email.replyTo.trim())) {
    fail(`email.replyTo is not a valid address: "${email.replyTo}".`);
  }
  const sesIdentity = (email.sesIdentity ?? domainOf(fromAddress)).trim().toLowerCase();
  if (sesIdentity.includes('@')) {
    if (sesIdentity !== fromAddress.toLowerCase()) {
      fail(`email.sesIdentity "${sesIdentity}" is an address identity but doesn't match fromAddress "${fromAddress}".`);
    }
  } else {
    if (!DOMAIN_RE.test(sesIdentity)) fail(`email.sesIdentity is not a valid domain: "${sesIdentity}".`);
    const fromDomain = domainOf(fromAddress);
    if (fromDomain !== sesIdentity && !fromDomain.endsWith(`.${sesIdentity}`)) {
      fail(`email.fromAddress "${fromAddress}" isn't on the SES identity domain "${sesIdentity}".`);
    }
  }

  // Passkeys.
  let passkeys: Required<PasskeyOptions> | null = null;
  if (o.passkeys) {
    const relyingPartyId = validateRelyingPartyId(o.passkeys.relyingPartyId ?? '', 'passkeys.relyingPartyId');
    if (relyingPartyId === 'localhost') {
      fail('passkeys.relyingPartyId is "localhost". Set the final domain; sandboxes use sandboxRelyingPartyId automatically.');
    }
    const sandboxRelyingPartyId = validateRelyingPartyId(
      o.passkeys.sandboxRelyingPartyId ?? 'localhost',
      'passkeys.sandboxRelyingPartyId',
    );
    passkeys = { relyingPartyId, sandboxRelyingPartyId };
  }

  // Groups: the standard roles first (they set precedence), then app roles.
  const appRoles = [...(o.appRoles ?? [])].map((r) => r.trim());
  for (const role of appRoles) {
    if (!GROUP_RE.test(role)) fail(`appRoles entry "${role}" isn't a valid Cognito group name.`);
    if ((STANDARD_GROUPS as readonly string[]).includes(role)) fail(`appRoles entry "${role}" is already a standard group.`);
    const renamed = Object.hasOwn(RETIRED_GROUPS, role) ? RETIRED_GROUPS[role] : undefined;
    if (renamed) fail(`appRoles entry "${role}" is a retired admin role: it's "${renamed}" now (ADR 0020's migration note).`);
  }
  if (new Set(appRoles).size !== appRoles.length) fail('appRoles contains duplicates.');
  const groups = [...STANDARD_GROUPS, ...appRoles];

  // Sessions. Admin areas are held to Tier 3's short sessions even on a Tier 2 site.
  const sessionTier: AuthTier = o.adminPool === true ? 3 : tier;
  const ceiling = SESSION_POLICY.refreshTokenMinutesMax[sessionTier];
  const refreshTokenMinutes = o.refreshTokenMinutes ?? ceiling;
  if (!Number.isInteger(refreshTokenMinutes) || refreshTokenMinutes < SESSION_POLICY.refreshTokenMinutesMin) {
    fail(`refreshTokenMinutes must be a whole number of at least ${SESSION_POLICY.refreshTokenMinutesMin}.`);
  }
  if (refreshTokenMinutes > ceiling) {
    const whose = o.adminPool === true ? 'an admin pool' : `Tier ${tier}`;
    fail(`refreshTokenMinutes ${refreshTokenMinutes} exceeds ${whose}'s ceiling of ${ceiling} minutes.`);
  }

  // WAF.
  const waf = normalizeWaf(o.waf, o.acknowledgeNoRateLimit);

  const threatProtection = o.threatProtection ?? (tier === 3 ? 'audit' : 'off');
  if (tier === 3 && threatProtection === 'off') {
    fail('Tier 3 requires Cognito sign-in event logs: threatProtection must be "audit" or "enforced".');
  }

  const environment = o.environment?.trim();
  if (environment !== undefined) {
    if (!TAG_VALUE_RE.test(environment)) fail('environment must be a valid tag value.');
    if (environment === 'sandbox') fail('environment "sandbox" is reserved for Amplify sandboxes, which are detected automatically.');
  }

  if ((o as Record<string, unknown>).selfSignUp !== undefined) fail(SELF_SIGN_UP_REMOVED);
  let accountCreation: NormalizedAccountCreation;
  try {
    accountCreation = normalizeAccountCreation(o.accountCreation);
  } catch (error) {
    if (error instanceof AccountCreationConfigError) throw new AuthStandardConfigError(error.message.replace(/^auth-kit: /, ''));
    throw error;
  }
  if (o.adminPool && accountCreation.mode !== 'invite') {
    fail(`An admin pool is invite only: accountCreation.mode '${accountCreation.mode}' would let people make their own admin-pool accounts.`);
  }
  let codeLifetime: number;
  try {
    codeLifetime = codeLifetimeMinutes(o.codeLifetimeMinutes);
  } catch (error) {
    fail((error as Error).message.replace(/^auth-kit: /, ''));
  }

  return {
    project,
    owner,
    tier,
    adminPool: o.adminPool === true,
    email: {
      fromAddress,
      fromName,
      sesIdentity,
      ...(email.replyTo !== undefined && { replyTo: email.replyTo.trim() }),
      ...(email.configurationSet !== undefined && { configurationSet: email.configurationSet }),
      ...(email.verification !== undefined && { verification: email.verification }),
      ...(email.invitation !== undefined && { invitation: email.invitation }),
    },
    passkeys,
    groups,
    appRoles,
    waf,
    refreshTokenMinutes,
    threatProtection,
    guestAccess: o.guestAccess === true,
    environment,
    deletionProtectionInSandbox: o.deletionProtectionInSandbox === true,
    accountCreation,
    codeLifetimeMinutes: codeLifetime,
  };
}
