import { CfnWebACL, CfnWebACLAssociation } from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';
import { WAF_POLICY } from '../shared/policy.js';
import { type WafRuleSettings, validateWafRules } from './options.js';

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
 * to WAF and documents `x-amzn-cognito-operation-name` as the way to identify the API operation in
 * WAF logs. AWS doesn't document the header's value format, so the match is a lowercase "contains"
 * on the operation name, and `x-amz-target` (the JSON-protocol operation header) is matched too.
 * Confirm the sign-in rule matches in Count mode on a sandbox before relying on it alone; the
 * overall per-IP rule needs no header match and always applies.
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

function rateRules(waf: WafRuleSettings, metricPrefix: string): CfnWebACL.RuleProperty[] {
  const action = waf.action === 'count' ? { count: {} } : { block: {} };
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
      action,
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
      action,
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
  /** Rate rules. Defaults: the standard's limits (`WAF_POLICY`), blocking. */
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
  const waf = validateWafRules(
    {
      signInLimit: props.waf?.signInLimit ?? WAF_POLICY.signInLimit,
      overallLimit: props.waf?.overallLimit ?? WAF_POLICY.overallLimit,
      evaluationWindowSec: props.waf?.evaluationWindowSec ?? WAF_POLICY.evaluationWindowSec,
      action: props.waf?.action ?? 'block',
    },
    'waf',
  );
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
