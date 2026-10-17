# 0004. A WAF rate rule on every user pool

- **Status:** Accepted, 2026-10-17; amended 2026-10-17 by [0013](0013-shared-web-acl.md) (shared web ACL, acknowledged opt-out), for token refreshes, and by [0017](0017-per-rule-waf-modes.md) (each rule's own mode; the header match verified live)
- **Standard:** 03 §2 Sign-in; primer §4 "Guessing codes"

## Context

Tested on 2026-10-12 in a throwaway pool: Cognito didn't lock out wrong emailed codes (five wrong codes in one attempt, then the right one, signed in). An in-app limit can't help, because browsers call Cognito directly with the app's public client ID. Cognito's request quotas are shared by every pool in an account and Region, so a flood against one site slows sign-in on all of them.

## Decision

The preset attaches an AWS WAF web ACL (REGIONAL) to each non-sandbox user pool with two per-IP rate-based rules (default window 5 minutes):

1. **Sign-in attempts**, default 100 per IP: requests whose Cognito operation is `InitiateAuth` or `RespondToAuthChallenge` (code sends, password and passkey starts, every code or TOTP guess). Matched case-insensitively on `x-amzn-cognito-operation-name` (the header Cognito forwards and AWS points to for identifying operations) and on `x-amz-target`.
2. **All inspected requests**, default 1000 per IP, with no header match, so it always applies.

Limits, window, and each rule's mode (`count` or `block`) are options; by default the sign-in rule counts and the overall rule blocks ([0017](0017-per-rule-waf-modes.md)). Sandboxes skip the web ACL by default (it's billed); `waf.enabledInSandbox` turns it on. Sites can share one web ACL per account and Region (`waf: { webAclArn }`, [0013](0013-shared-web-acl.md)); turning WAF off needs `waf: false` plus `acknowledgeNoRateLimit: true` and still emits a synthesis warning.

## Consequences

- WAF bills per web ACL, per rule, and per million requests.
- AWS doesn't document the value format of `x-amzn-cognito-operation-name`. **Verified live on 2026-10-17:** it's the bare operation name (`InitiateAuth`), and the sign-in rule matched a burst of `InitiateAuth` calls while the overall rule didn't ([0017](0017-per-rule-waf-modes.md)). The overall rule stays the floor while the sign-in rule counts.
- Per-IP limits don't stop a distributed attacker, and an office behind one NAT address shares a budget. The defaults leave room for a busy office.
- IAM-signed Admin* calls (the dev kit's `AdminInitiateAuth`, the admin module) aren't inspected by WAF, so the rules never block them. Server-side token-authorized calls (the TOTP check's `GetUserAuthFactors`) do count, from the server's address.
- **Token refreshes count too**, from the browser's address for client-side refreshes and from the **server's** address for the proxy's (`amplifyAdapterRefresh`). Amplify JS 6.22 refreshes with `GetTokensFromRefreshToken`, which counts toward the overall rule only; older clients and other SDKs use `InitiateAuth` with `REFRESH_TOKEN_AUTH`, which the sign-in rule also matches (it can't see the auth flow). Every server-side refresh shares the server's egress budget, so the proxy refreshes only a genuine expired session that has a refresh-token cookie, never an anonymous or forged request, and limits refreshes per person and per instance with back-off (`refreshLimits`). Keep the `count`-mode check, and confirm from the rules' sampled requests which operations refreshes show up as before tuning limits.
- A web ACL that uses AWS's account-takeover-prevention managed rule group can't be attached to a user pool; this one doesn't.
