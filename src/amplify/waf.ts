import { CfnWebACL, CfnWebACLAssociation } from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';
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
  /** The rate rule's mode. Default `block`. */
  rateRule?: WafRuleMode;
}

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
  const scope = postTo(paths);
  return [
    {
      name: 'auth-kit-account-creation-challenge',
      priority,
      action: { challenge: {} },
      challengeConfig: { immunityTimeProperty: { immunityTime: immunity } },
      statement: scope,
      visibilityConfig: { cloudWatchMetricsEnabled: true, sampledRequestsEnabled: true, metricName: metricName(prefix, 'challenge') },
    },
    {
      name: 'auth-kit-account-creation-per-ip',
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
}

/**
 * A CLOUDFRONT-scope web ACL with `accountCreationWafRules`, for the Amplify app that serves the
 * sign-up and request routes. Deploy it in `us-east-1` (CloudFront ACLs live there), then associate it
 * with the app in the Amplify console (Hosting → Firewall) or its API. Separate from the shared
 * REGIONAL ACL on the user pools (`createSharedAuthWebAcl`): that one sees Cognito's API, not the
 * site's routes. Optional (ADR 0023).
 */
export function createSiteWebAcl(scope: Construct, id: string, props: SiteWebAclProps = {}): CfnWebACL {
  const name = props.name ?? 'auth-kit-site-routes';
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(name)) throw new Error(`auth-kit: web ACL name "${name}" may use only letters, digits, _ and - (1-128).`);
  return new CfnWebACL(scope, id, {
    name,
    scope: 'CLOUDFRONT',
    description: "auth-kit: a silent challenge and a per-IP limit on the site's sign-up and request routes",
    defaultAction: { allow: {} },
    visibilityConfig: { cloudWatchMetricsEnabled: true, sampledRequestsEnabled: true, metricName: metricName(name) },
    rules: accountCreationWafRules(props),
  });
}
