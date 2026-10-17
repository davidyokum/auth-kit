# 0004. A WAF rate rule on every user pool

- **Status:** Accepted, 2026-10-17
- **Standard:** 03 §2 Sign-in; primer §4 "Guessing codes"

## Context

Tested on 2026-10-12 in a throwaway pool: Cognito didn't lock out wrong emailed codes (five wrong codes in one attempt, then the right one, signed in). An in-app limit can't help, because browsers call Cognito directly with the app's public client ID. Cognito's request quotas are shared by every pool in an account and Region, so a flood against one site slows sign-in on all of them.

## Decision

The preset attaches an AWS WAF web ACL (REGIONAL) to each non-sandbox user pool with two per-IP rate-based rules (default window 5 minutes):

1. **Sign-in attempts**, default 100 per IP: requests whose Cognito operation is `InitiateAuth` or `RespondToAuthChallenge` (code sends, password and passkey starts, every code or TOTP guess). Matched case-insensitively on `x-amzn-cognito-operation-name` (the header Cognito forwards and AWS points to for identifying operations) and on `x-amz-target`.
2. **All inspected requests**, default 1000 per IP, with no header match, so it always applies.

Limits, window, and a `count` mode are options. Sandboxes skip the web ACL by default (it's billed); `waf.enabledInSandbox` turns it on. Turning it off outside a sandbox emits a synthesis warning.

## Consequences

- WAF bills per web ACL, per rule, and per million requests.
- AWS doesn't document the value format of `x-amzn-cognito-operation-name`. Confirm the sign-in rule matches in `count` mode on the first sandbox deploy; until then the overall rule is the guaranteed floor.
- Per-IP limits don't stop a distributed attacker, and an office behind one NAT address shares a budget. The defaults leave room for a busy office.
- IAM-signed Admin* calls (the dev kit's `AdminInitiateAuth`, the admin module) aren't inspected by WAF, so the rules never block them. Server-side token-authorized calls (the TOTP check's `GetUserAuthFactors`) do count, from the server's address.
- A web ACL that uses AWS's account-takeover-prevention managed rule group can't be attached to a user pool; this one doesn't.
