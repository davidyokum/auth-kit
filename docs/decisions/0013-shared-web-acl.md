# 0013. One shared web ACL per account and Region

- **Status:** Accepted, 2026-10-17 (amends [0004](0004-waf-rate-rule.md))

## Context

[0004](0004-waf-rate-rule.md) attaches a WAF web ACL to every pool. AWS WAF bills per web ACL (about $5 a month) and per rule (about $1 a month each) plus requests, so the preset's default of one ACL per pool costs about $7 a month per site: roughly $130–140 a month across twenty sites, for identical rules. A REGIONAL web ACL can be associated with many resources in its Region, Cognito user pools included.

## Decision

- **Default:** the preset still creates a web ACL for the pool, which suits a first site.
- **Recommended for more than one site:** one shared web ACL per AWS account and Region, made once with `createSharedAuthWebAcl` (the same two rate rules, no association) in its own small stack, and each site's preset reuses it with `waf: { webAclArn }`. The preset then only adds an association. The ARN must be a REGIONAL web ACL; a Region different from the pool's fails synthesis when both are known.
- **Off:** `waf: false` is accepted only with `acknowledgeNoRateLimit: true`, and still warns at synthesis. Cognito doesn't lock out wrong emailed codes, so "no rate limit" must be a visible, deliberate choice. `waf.enabled` is retired.

## Consequences

- Cost is one ACL's worth per account and Region, however many sites.
- The rate rules count per IP across **every pool the ACL protects**: an office using three sites shares one budget. Raise `signInLimit` / `overallLimit` on the shared ACL if offices hit it, and watch its metrics (`aws wafv2 get-sampled-requests`) after adding sites.
- The shared stack outlives any one site. Deleting it while pools still use it fails at the association, which is the loud failure we want; remove the sites' associations first.
- Sandboxes skip WAF by default either way (`enabledInSandbox` opts in; associating a shared ACL costs nothing extra).
