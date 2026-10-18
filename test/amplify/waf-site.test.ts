import { App, Stack } from 'aws-cdk-lib';
import type { CfnWebACL } from 'aws-cdk-lib/aws-wafv2';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { ACCOUNT_CREATION_ROUTES, accountCreationWafRules, createSiteWebAcl } from '../../src/amplify/index.js';

describe("the site routes' WAF rules (ADR 0023: a silent check and rate limits)", () => {
  it('puts a silent challenge and a per-IP limit on POSTs to the sign-up and request routes', () => {
    const stack = new Stack(new App(), 'Waf', { env: { region: 'us-east-1' } });
    createSiteWebAcl(stack, 'Site', { accountCreation: { mode: 'open' } });
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

describe('open sign-up holds the site ACL to acting, at synthesis (N1)', () => {
  const synth = (build: (stack: Stack) => CfnWebACL) => {
    const stack = new Stack(new App(), 'Waf', { env: { region: 'us-east-1' } });
    const acl = build(stack);
    return { acl, template: () => Template.fromStack(stack) };
  };

  it('needs the site’s accountCreation, and refuses the per-IP rule in count mode in open mode', () => {
    expect(() => synth((s) => createSiteWebAcl(s, 'Site', {} as never))).toThrow(/needs accountCreation/);
    expect(() => synth((s) => createSiteWebAcl(s, 'Site', { accountCreation: { mode: 'open' }, rateRule: 'count' }))).toThrow(/can't be in count mode/);
    expect(() => accountCreationWafRules({ accountCreation: { mode: 'open' }, rateRule: 'count' })).toThrow(/can't be in count mode/);
    // Domains mode may measure first.
    expect(() => synth((s) => createSiteWebAcl(s, 'Site', { accountCreation: { mode: 'domains', domains: ['example.org'] }, rateRule: 'count' })).template()).not.toThrow();
  });

  it('fails synthesis when anything later turns the challenge to count, in any mode, or the per-IP rule to count in open mode', () => {
    const withAction = (acl: CfnWebACL, index: number, action: CfnWebACL.RuleActionProperty) =>
      (acl.rules as CfnWebACL.RuleProperty[]).map((rule, i) => (i === index ? { ...rule, action } : rule));

    const challengeCounted = synth((s) => createSiteWebAcl(s, 'Site', { accountCreation: { mode: 'domains', domains: ['example.org'] } }));
    challengeCounted.acl.rules = withAction(challengeCounted.acl, 0, { count: {} });
    expect(() => challengeCounted.template()).toThrow(/auth-kit-account-creation-challenge rule is set to count; it must challenge/);

    const overridden = synth((s) => createSiteWebAcl(s, 'Site', { accountCreation: { mode: 'domains', domains: ['example.org'] } }));
    overridden.acl.addPropertyOverride('Rules', withAction(overridden.acl, 0, { count: {} }).map((r) => ({ Name: r.name, Priority: r.priority, Action: { Count: {} }, Statement: {}, VisibilityConfig: {} })));
    expect(() => overridden.template()).toThrow(/rule is set to count; it must challenge/);

    const perIpCounted = synth((s) => createSiteWebAcl(s, 'Site', { accountCreation: { mode: 'open' } }));
    perIpCounted.acl.rules = withAction(perIpCounted.acl, 1, { count: {} });
    expect(() => perIpCounted.template()).toThrow(/can't be in count mode/);

    const removed = synth((s) => createSiteWebAcl(s, 'Site', { accountCreation: { mode: 'open' } }));
    removed.acl.addPropertyOverride('Rules', []);
    expect(() => removed.template()).toThrow(/challenge rule is missing/);

    expect(() => synth((s) => createSiteWebAcl(s, 'Site', { accountCreation: { mode: 'open' } })).template()).not.toThrow();
  });
});
