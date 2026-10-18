import { Stack } from 'aws-cdk-lib';
import { CfnWebACL, CfnWebACLAssociation } from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';
import { type AccountCreationSettings, normalizeAccountCreation } from '../shared/account-creation.js';
import { type WafRuleMode, type WafRuleSettings, validateWafRules, wafRuleSettings } from './options.js';

export interface AuthWebAclProps {
  /** ARN of the user pool to protect. */
  userPoolArn: string;
  /** Used in metric names. */
  project: string;
  waf: WafRuleSettings;
}

export interface AuthWebAcl {
  webAcl: CfnWebACL;
  association: CfnWebACLAssociation;
}

/**
 * The header names WAF can see for user pool API requests. Cognito forwards selected request headers
 * to WAF and documents `x-amzn-cognito-operation-name` as the way to identify the API operation.
 * Verified live on 2026-10-17 (ADR 0017): WAF's sampled requests show Cognito forwards the bare
 * operation name (`x-amzn-cognito-operation-name: InitiateAuth`) and the JSON-protocol target
 * (`x-amz-target: AWSCognitoIdentityProviderService.InitiateAuth`), and 110 unauthenticated
 * `InitiateAuth` calls in 20 seconds put the sender over the sign-in rule's limit and not the overall
 * rule's. The match is a lowercase "contains" on the operation name, on both headers.
 */
export const COGNITO_OPERATION_HEADERS = ['x-amzn-cognito-operation-name', 'x-amz-target'] as const;
/** Sign-in attempts: password and passkey starts, emailed-code sends, and every code or TOTP guess. */
export const SIGN_IN_OPERATIONS = ['InitiateAuth', 'RespondToAuthChallenge'] as const;

function metricName(...parts: string[]): string {
  const name = parts
    .join('-')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return name.slice(0, 128) || 'auth-kit';
}

function operationMatch(header: string, operation: string): CfnWebACL.StatementProperty {
  return {
    byteMatchStatement: {
      // SingleHeader is passed through to CloudFormation as-is, so its key is spelled `Name`.
      fieldToMatch: { singleHeader: { Name: header } },
      positionalConstraint: 'CONTAINS',
      searchString: operation.toLowerCase(),
      textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
    },
  };
}

const ruleAction = (mode: WafRuleSettings['signInRule']): CfnWebACL.RuleActionProperty => (mode === 'count' ? { count: {} } : { block: {} });

function rateRules(waf: WafRuleSettings, metricPrefix: string): CfnWebACL.RuleProperty[] {
  const signInScope: CfnWebACL.StatementProperty = {
    orStatement: {
      statements: COGNITO_OPERATION_HEADERS.flatMap((header) =>
        SIGN_IN_OPERATIONS.map((operation) => operationMatch(header, operation)),
      ),
    },
  };
  return [
    {
      name: 'auth-kit-sign-in-attempts-per-ip',
      priority: 0,
      action: ruleAction(waf.signInRule),
      statement: {
        rateBasedStatement: {
          aggregateKeyType: 'IP',
          limit: waf.signInLimit,
          evaluationWindowSec: waf.evaluationWindowSec,
          scopeDownStatement: signInScope,
        },
      },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        sampledRequestsEnabled: true,
        metricName: metricName(metricPrefix, 'sign-in-attempts-per-ip'),
      },
    },
    {
      name: 'auth-kit-requests-per-ip',
      priority: 1,
      action: ruleAction(waf.overallRule),
      statement: {
        rateBasedStatement: {
          aggregateKeyType: 'IP',
          limit: waf.overallLimit,
          evaluationWindowSec: waf.evaluationWindowSec,
        },
      },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        sampledRequestsEnabled: true,
        metricName: metricName(metricPrefix, 'requests-per-ip'),
      },
    },
  ];
}

/**
 * An AWS WAF web ACL with two per-IP rate rules, associated with the user pool.
 *
 * Cognito doesn't lock out wrong emailed codes (tested 2026-10-12), and an in-app limit can't help
 * because browsers call Cognito directly with the public client ID. IAM-signed Admin* calls (the dev
 * kit's AdminInitiateAuth, the admin module) aren't inspected by WAF, so these rules never touch them.
 * Token refreshes are public calls and do count: `GetTokensFromRefreshToken` (Amplify JS 6.22) toward
 * the overall rule, `InitiateAuth` with `REFRESH_TOKEN_AUTH` (older clients) toward both.
 */
export function createAuthWebAcl(scope: Construct, id: string, props: AuthWebAclProps): AuthWebAcl {
  const { project } = props;
  const waf = validateWafRules(props.waf, 'waf');
  const webAcl = new CfnWebACL(scope, id, {
    scope: 'REGIONAL',
    description: `auth-kit rate limits for the ${project} user pool`,
    defaultAction: { allow: {} },
    visibilityConfig: {
      cloudWatchMetricsEnabled: true,
      sampledRequestsEnabled: true,
      metricName: metricName(project, 'auth-web-acl'),
    },
    rules: rateRules(waf, project),
  });
  const association = associateAuthWebAcl(scope, `${id}Association`, { userPoolArn: props.userPoolArn, webAclArn: webAcl.attrArn });
  return { webAcl, association };
}

export interface SharedAuthWebAclProps {
  /** The web ACL's name, unique per account and Region. Default `auth-kit-shared-user-pools`. */
  name?: string;
  /**
   * Rate rules. Defaults: the standard's limits (`WAF_POLICY`), the sign-in rule counting
   * (`signInRule: 'count'`) and the overall rule blocking (`overallRule: 'block'`). After a week of
   * the sign-in rule's counts, set `signInRule: 'block'` (ADR 0017).
   */
  waf?: Partial<WafRuleSettings>;
}

/**
 * One web ACL with auth-kit's rate rules and no association, to share across every user pool in an
 * AWS account and Region (ADR 0013). Deploy it once, in its own small stack, and give each site's
 * preset its ARN: `waf: { webAclArn }`. The rate rules count per IP across all the pools it protects.
 *
 * ```ts
 * const stack = new Stack(app, 'AuthKitSharedWaf', { env: { region: 'us-east-1' } });
 * const acl = createSharedAuthWebAcl(stack, 'SharedAuthWebAcl');
 * new CfnOutput(stack, 'WebAclArn', { value: acl.attrArn });
 * ```
 */
export function createSharedAuthWebAcl(scope: Construct, id: string, props: SharedAuthWebAclProps = {}): CfnWebACL {
  const name = props.name ?? 'auth-kit-shared-user-pools';
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(name)) throw new Error(`auth-kit: web ACL name "${name}" may use only letters, digits, _ and - (1-128).`);
  const waf = wafRuleSettings(props.waf, 'waf');
  return new CfnWebACL(scope, id, {
    name,
    scope: 'REGIONAL',
    description: 'auth-kit rate limits shared by the user pools in this account and Region',
    defaultAction: { allow: {} },
    visibilityConfig: {
      cloudWatchMetricsEnabled: true,
      sampledRequestsEnabled: true,
      metricName: metricName(name),
    },
    rules: rateRules(waf, name),
  });
}

/** Associates a REGIONAL web ACL (created here or shared) with a user pool. */
export function associateAuthWebAcl(
  scope: Construct,
  id: string,
  props: { userPoolArn: string; webAclArn: string },
): CfnWebACLAssociation {
  return new CfnWebACLAssociation(scope, id, { resourceArn: props.userPoolArn, webAclArn: props.webAclArn });
}

// ---- The site's own routes: sign-up and request access (ADR 0023) -------------------------------

/** The routes auth-kit's account-creation handlers are usually mounted on (`auth-kit/accounts`). */
export const ACCOUNT_CREATION_ROUTES = ['/api/auth/sign-up', '/api/auth/request-access'] as const;

export interface AccountCreationWafOptions {
  /** URI paths of the sign-up and request routes. Default `ACCOUNT_CREATION_ROUTES`. */
  paths?: readonly string[];
  /** Metric name prefix. Default `auth-kit-account-creation`. */
  metricPrefix?: string;
  /** First priority to use (the rules take this and the next). Default 0. */
  priority?: number;
  /** How long a solved challenge counts, in seconds (AWS WAF's immunity time). Default 300. */
  challengeImmunitySeconds?: number;
  /** POSTs to those routes per IP per window before WAF blocks. Default 50 (the app's own per-IP limits sit behind it). */
  rateLimit?: number;
  /** Window in seconds: 60, 120, 300 (default), or 600. */
  evaluationWindowSec?: 60 | 120 | 300 | 600;
  /** The rate rule's mode. Default `block`; `count` is refused in `open` mode. */
  rateRule?: WafRuleMode;
  /**
   * The site's account-creation setting (the preset's). In `open` mode anyone may create an account,
   * so the rules must act: the per-IP rule can't be left in `count` mode.
   */
  accountCreation?: AccountCreationSettings;
}

const CHALLENGE_RULE = 'auth-kit-account-creation-challenge';
const PER_IP_RULE = 'auth-kit-account-creation-per-ip';

const OPEN_MODE_COUNT =
  "auth-kit: accountCreation mode 'open' needs the account-creation WAF rules to act: the per-IP rule can't be in count mode (it would only measure). " +
  'Leave rateRule at block. The silent challenge is the bot check for open sign-up (ADR 0023).';

function postTo(paths: readonly string[]): CfnWebACL.StatementProperty {
  const methodIsPost: CfnWebACL.StatementProperty = {
    byteMatchStatement: { fieldToMatch: { method: {} }, positionalConstraint: 'EXACTLY', searchString: 'POST', textTransformations: [{ priority: 0, type: 'NONE' }] },
  };
  const path = (p: string): CfnWebACL.StatementProperty => ({
    byteMatchStatement: { fieldToMatch: { uriPath: {} }, positionalConstraint: 'STARTS_WITH', searchString: p, textTransformations: [{ priority: 0, type: 'NONE' }] },
  });
  const onPaths = paths.length === 1 ? path(paths[0]!) : { orStatement: { statements: paths.map(path) } };
  return { andStatement: { statements: [methodIsPost, onPaths] } };
}

/**
 * Two rules for the site's sign-up and request routes (D3: "a silent WAF check and rate limits"),
 * to add to a CLOUDFRONT-scope web ACL associated with the Amplify app:
 *
 * - **A silent challenge** (`challenge`): AWS WAF answers a POST to those routes without a valid token
 *   with a challenge the browser solves in the background, no puzzle. A `fetch` can't solve one by
 *   itself, so the sign-up and request pages load AWS WAF's JavaScript integration (the ACL's
 *   application integration URL), and auth-kit's `SignUp` and `RequestAccess` send through
 *   `window.AwsWafIntegration.fetch` when it's there, which attaches the token.
 * - **A per-IP rate rule** on the same POSTs (WAF sees the real client IP; the app's own per-IP limit
 *   reads a forwarded header).
 *
 * Optional: the routes keep their own per-address and per-IP limits either way.
 */
export function accountCreationWafRules(options: AccountCreationWafOptions = {}): CfnWebACL.RuleProperty[] {
  const paths = [...(options.paths ?? ACCOUNT_CREATION_ROUTES)];
  if (paths.length === 0 || paths.some((p) => !p.startsWith('/'))) throw new Error('auth-kit: account-creation WAF paths must be absolute paths like "/api/auth/sign-up".');
  const prefix = options.metricPrefix ?? 'auth-kit-account-creation';
  const priority = options.priority ?? 0;
  const window = options.evaluationWindowSec ?? 300;
  if (![60, 120, 300, 600].includes(window)) throw new Error('auth-kit: evaluationWindowSec must be 60, 120, 300, or 600.');
  const limit = options.rateLimit ?? 50;
  if (!Number.isInteger(limit) || limit < 10) throw new Error("auth-kit: rateLimit must be a whole number of at least 10 (AWS WAF's minimum).");
  const immunity = options.challengeImmunitySeconds ?? 300;
  if (!Number.isInteger(immunity) || immunity < 60) throw new Error('auth-kit: challengeImmunitySeconds must be a whole number of at least 60.');
  if (options.accountCreation !== undefined && normalizeAccountCreation(options.accountCreation).mode === 'open' && options.rateRule === 'count') throw new Error(OPEN_MODE_COUNT);
  const scope = postTo(paths);
  return [
    {
      name: CHALLENGE_RULE,
      priority,
      action: { challenge: {} },
      challengeConfig: { immunityTimeProperty: { immunityTime: immunity } },
      statement: scope,
      visibilityConfig: { cloudWatchMetricsEnabled: true, sampledRequestsEnabled: true, metricName: metricName(prefix, 'challenge') },
    },
    {
      name: PER_IP_RULE,
      priority: priority + 1,
      action: ruleAction(options.rateRule ?? 'block'),
      statement: { rateBasedStatement: { aggregateKeyType: 'IP', limit, evaluationWindowSec: window, scopeDownStatement: scope } },
      visibilityConfig: { cloudWatchMetricsEnabled: true, sampledRequestsEnabled: true, metricName: metricName(prefix, 'per-ip') },
    },
  ];
}

export interface SiteWebAclProps extends AccountCreationWafOptions {
  /** The web ACL's name, unique per account. Default `auth-kit-site-routes`. */
  name?: string;
  /** The site's account-creation setting, the same as the preset's. Required: open mode holds the rules to acting, at synthesis. */
  accountCreation: AccountCreationSettings;
}

/** The rendered ACL's rules (overrides included), or the typed ones if CDK's internal render goes away. */
function renderedRules(acl: CfnWebACL): { Name?: string; name?: string; Action?: Record<string, unknown>; action?: Record<string, unknown> }[] {
  const stack = Stack.of(acl);
  const render = (acl as unknown as { _toCloudFormation?: () => unknown })._toCloudFormation;
  if (typeof render === 'function') {
    const rendered = stack.resolve(render.call(acl)) as { Resources?: Record<string, { Properties?: { Rules?: unknown[] } }> };
    return (Object.values(rendered.Resources ?? {})[0]?.Properties?.Rules ?? []) as ReturnType<typeof renderedRules>;
  }
  return (stack.resolve(acl.rules) ?? []) as ReturnType<typeof renderedRules>;
}

/**
 * Problems with a site ACL's account-creation rules as they'll deploy: the challenge rule must
 * challenge (in every mode: a challenge left in count mode is no check at all), and in `open` mode the
 * per-IP rule must block.
 */
export function siteWebAclRuleProblems(acl: CfnWebACL, accountCreation: AccountCreationSettings): string[] {
  const open = normalizeAccountCreation(accountCreation).mode === 'open';
  const rules = renderedRules(acl);
  const action = (name: string) => {
    const rule = rules.find((r) => (r.Name ?? r.name) === name);
    // Only the actions actually set (the render lists every key, unset ones as undefined).
    return rule ? Object.entries(rule.Action ?? rule.action ?? {}).filter(([, v]) => v !== undefined && v !== null).map(([k]) => k.toLowerCase()) : null;
  };
  // Exactly one action, the right one: an override that adds Count beside Challenge counts too.
  const only = (actions: string[] | null, want: string) => actions !== null && actions.length === 1 && actions[0] === want;
  const problems: string[] = [];
  const challenge = action(CHALLENGE_RULE);
  if (!only(challenge, 'challenge')) {
    problems.push(`auth-kit: the site web ACL's ${CHALLENGE_RULE} rule ${challenge ? `is set to ${challenge.join(', ') || 'nothing'}` : 'is missing'}; it must challenge, and only challenge (count mode would only measure, and sign-ups would go unchecked).`);
  }
  if (open && !only(action(PER_IP_RULE), 'block')) problems.push(OPEN_MODE_COUNT);
  return problems;
}

/**
 * A CLOUDFRONT-scope web ACL with `accountCreationWafRules`, for the Amplify app that serves the
 * sign-up and request routes. Deploy it in `us-east-1` (CloudFront ACLs live there), then associate it
 * with the app in the Amplify console (Hosting → Firewall) or its API. Separate from the shared
 * REGIONAL ACL on the user pools (`createSharedAuthWebAcl`): that one sees Cognito's API, not the
 * site's routes. Required in `open` mode (the preset's `siteWebAclArn`), optional in `domains` mode
 * (ADR 0023). After associating it, run the smoke test: a POST to the sign-up route without a token
 * must get AWS WAF's challenge (202, `x-amzn-waf-action: challenge`), not the route's JSON.
 */
export function createSiteWebAcl(scope: Construct, id: string, props: SiteWebAclProps): CfnWebACL {
  const name = props.name ?? 'auth-kit-site-routes';
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(name)) throw new Error(`auth-kit: web ACL name "${name}" may use only letters, digits, _ and - (1-128).`);
  if (props?.accountCreation === undefined) throw new Error("auth-kit: createSiteWebAcl needs accountCreation (the preset's setting): open mode holds the rules to acting.");
  const acl = new CfnWebACL(scope, id, {
    name,
    scope: 'CLOUDFRONT',
    description: "auth-kit: a silent challenge and a per-IP limit on the site's sign-up and request routes",
    defaultAction: { allow: {} },
    visibilityConfig: { cloudWatchMetricsEnabled: true, sampledRequestsEnabled: true, metricName: metricName(name) },
    rules: accountCreationWafRules(props),
  });
  // Checked again at synthesis, on the rendered ACL, so an override that turns a rule to count fails too.
  const accountCreation = props.accountCreation;
  acl.node.addValidation({ validate: () => siteWebAclRuleProblems(acl, accountCreation) });
  return acl;
}
