import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { ACCOUNT_CREATION_ROUTES, accountCreationWafRules, createSiteWebAcl } from '../../src/amplify/index.js';

describe("the site routes' WAF rules (ADR 0023: a silent check and rate limits)", () => {
  it('puts a silent challenge and a per-IP limit on POSTs to the sign-up and request routes', () => {
    const stack = new Stack(new App(), 'Waf', { env: { region: 'us-east-1' } });
    createSiteWebAcl(stack, 'Site');
    const t = Template.fromStack(stack);
    const acl = Object.values(t.findResources('AWS::WAFv2::WebACL'))[0] as { Properties: { Scope: string; Rules: { Name: string; Action: unknown; ChallengeConfig?: unknown; Statement: unknown }[] } };
    expect(acl.Properties.Scope).toBe('CLOUDFRONT');
    expect(acl.Properties.Rules.map((r) => [r.Name, r.Action])).toEqual([
      ['auth-kit-account-creation-challenge', { Challenge: {} }],
      ['auth-kit-account-creation-per-ip', { Block: {} }],
    ]);
    expect(acl.Properties.Rules[0]!.ChallengeConfig).toEqual({ ImmunityTimeProperty: { ImmunityTime: 300 } });
    const json = JSON.stringify(acl.Properties.Rules[0]!.Statement);
    for (const path of ACCOUNT_CREATION_ROUTES) expect(json).toContain(path);
    expect(json).toContain('"SearchString":"POST"');
  });

  it('builds rules for an existing ACL, and checks its options', () => {
    expect(accountCreationWafRules({ paths: ['/join'], priority: 5 }).map((r) => r.priority)).toEqual([5, 6]);
    expect(() => accountCreationWafRules({ paths: ['join'] })).toThrow(/absolute paths/);
    expect(() => accountCreationWafRules({ rateLimit: 5 })).toThrow(/at least 10/);
  });
});
