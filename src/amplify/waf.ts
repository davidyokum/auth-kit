import { CfnWebACL, CfnWebACLAssociation } from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';
import type { WafOptions } from './options.js';

export interface AuthWebAclProps {
  /** ARN of the user pool to protect. */
  userPoolArn: string;
  /** Used in metric names. */
  project: string;
  waf: Required<WafOptions>;
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

/**
 * An AWS WAF web ACL with two per-IP rate rules, associated with the user pool.
 *
 * Cognito doesn't lock out wrong emailed codes (tested 2026-10-12), and an in-app limit can't help
 * because browsers call Cognito directly with the public client ID. IAM-signed Admin* calls (the dev
 * kit's AdminInitiateAuth, the admin module) aren't inspected by WAF, so these rules never touch them.
 */
export function createAuthWebAcl(scope: Construct, id: string, props: AuthWebAclProps): AuthWebAcl {
  const { waf, project } = props;
  const action = waf.action === 'count' ? { count: {} } : { block: {} };

  const signInScope: CfnWebACL.StatementProperty = {
    orStatement: {
      statements: COGNITO_OPERATION_HEADERS.flatMap((header) =>
        SIGN_IN_OPERATIONS.map((operation) => operationMatch(header, operation)),
      ),
    },
  };

  const webAcl = new CfnWebACL(scope, id, {
    scope: 'REGIONAL',
    description: `auth-kit rate limits for the ${project} user pool`,
    defaultAction: { allow: {} },
    visibilityConfig: {
      cloudWatchMetricsEnabled: true,
      sampledRequestsEnabled: true,
      metricName: metricName(project, 'auth-web-acl'),
    },
    rules: [
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
          metricName: metricName(project, 'sign-in-attempts-per-ip'),
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
          metricName: metricName(project, 'requests-per-ip'),
        },
      },
    ],
  });

  const association = new CfnWebACLAssociation(scope, `${id}Association`, {
    resourceArn: props.userPoolArn,
    webAclArn: webAcl.attrArn,
  });

  return { webAcl, association };
}
