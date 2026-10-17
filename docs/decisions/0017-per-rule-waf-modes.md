# 0017. Each WAF rule has its own mode; the sign-in rule counts first

- **Status:** Accepted, 2026-10-17 (amends [0004](0004-waf-rate-rule.md) and [0013](0013-shared-web-acl.md))
- **Standard:** 03 §2 Sign-in; primer §4 "Guessing codes"

## Context

[0004](0004-waf-rate-rule.md) puts two per-IP rate rules on every pool: sign-in attempts (matched on the Cognito operation header) and all requests. Both took one `action`. The first live deploy (the 2026-10-17 demo, on a shared web ACL) wanted the sign-in rule in count mode, because its header match was unverified, while the overall rule blocked from day one, because it needs no header match and the pool must never be without a limit. With one action that took a hand-written override.

That deploy also answered the header question. WAF's sampled requests showed Cognito forwards `x-amzn-cognito-operation-name: InitiateAuth` (the bare operation name) and `x-amz-target: AWSCognitoIdentityProviderService.InitiateAuth`. After 110 unauthenticated `InitiateAuth` calls in 20 seconds from one address, the sign-in rule (100 per 5 minutes) listed that address as over its limit and the overall rule (1000) didn't. The match (a lowercase "contains" on the operation name, on both headers) works end to end.

Still open from 0004: which operations token refreshes arrive as. Amplify JS 6.22 uses `GetTokensFromRefreshToken` (overall rule only); older clients use `InitiateAuth` with `REFRESH_TOKEN_AUTH`, which the sign-in rule also counts, and the proxy's server-side refreshes all come from the server's address.

## Decision

- `waf.signInRule` and `waf.overallRule`, each `'count'` or `'block'`, on the preset's created web ACL and on `createSharedAuthWebAcl`. Defaults (`WAF_POLICY`): **sign-in `count`, overall `block`**.
- The single `waf.action` is retired; it's refused with a message naming the two options.
- **Switch the sign-in rule to `block` after a week of counts.** Read both rules' sampled requests first (README, "WAF"), looking at who comes near 100 sign-in attempts per 5 minutes and whether refreshes show up as `InitiateAuth`. Then set `signInRule: 'block'` and redeploy.

## Consequences

- During the count week, code guessing is limited only by the overall rule (1000 requests per address per 5 minutes) and the 3-minute sign-in session. That's the floor 0004 already guaranteed; the week buys the evidence to block without locking out real sessions.
- A site that wants blocking at once sets `signInRule: 'block'`; nothing else changes.
- Existing shared ACL stacks that passed `action` fail synthesis on upgrade until they name the two modes. The deployed rules don't change until that stack is redeployed.
