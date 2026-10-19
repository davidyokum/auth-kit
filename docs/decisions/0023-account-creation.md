# 0023. Account creation: four modes, sign-up as a self-invite, requests in DynamoDB

- **Status:** Accepted, 2026-10-18 (register D1–D4, David's decisions; the rules marked "chosen here" are Claude's, within them). Amended 2026-10-18 after the security review of PR #20 ([below](#amendment-2026-10-18-the-security-review)), and 2026-10-19 to match the register ([below](#amendment-2026-10-19-the-register)).
- **Standard:** 03 §2 Roles and lifecycle ("How accounts get created is one per-site setting"); the sign-in design report (passwords-flow `design/benchmark/REPORT.md`, kept privately) §3.1a–e and §5.2(g)–(m); the sign-in design studio's screens and emails

## Context

auth-kit was invite only, with one exception: `selfSignUp`, which turned Cognito's own `SignUp` on for a domain allowlist. That exception had three problems. The app client ID is public, so anyone could call `SignUp` directly and skip whatever the site put in front of it (rate limits, a bot check). `SignUp` answers `UsernameExistsException` for an address that already has an account (`PreventUserExistenceErrors` doesn't cover it), so anyone could test who's registered. And an account made that way never went through the invite's path (no-password account, first emailed code, then a passkey or a password plus authenticator).

David decided four ways to get an account (D1), that self-made accounts follow the invite's path with Cognito's `SignUp` off (D2), that sign-up and request screens are the same for every address with a silent WAF check, rate limits, and a 24-hour cleanup (D3), and that every self-made account starts as Member, with members on sign-up sites deleting their own account and changing their own address (D4).

## Decision

**One setting.** `accountCreation: { mode: 'invite' | 'request' | 'domains' | 'open', domains?, requestsAlso? }` on the preset, the routes, the screens, and the preSignUp trigger; invite only by default. `requestsAlso` (domains mode) gives addresses off the list Request access instead of the invite-only line. `selfSignUp` and `preSignUpAllowlist` now throw, explaining the change.

**Cognito's own `SignUp` is always off.** The preset sets `AllowAdminCreateUserOnly`, and synthesis fails if the rendered pool (every override included) has it anything but `true`. An admin pool is invite only.

**Sign-up is a server route, the self-invite** (`createAccountCreationRoutes(…).signUp`):

1. Same-origin POST with a JSON body of at most 4 KB.
2. Check the address, and in `domains` mode the list (public, so saying an address isn't on it reveals nothing about accounts).
3. Rate-limit per mailbox, per IP, and site-wide.
4. An address with an account gets "You already have an account" (REPORT §5.2g); a new one gets an account from invite-core's `createInvitedAccount`: no password, no `email_verified`, no group, Cognito's message suppressed, and the immutable attribute `custom:authkit_origin = signup`.
5. Either way the answer is the identical `{ ok: true }`, and every answer takes at least 800 ms.
6. The browser then runs the invite's emailed-code sign-in; the custom message trigger words that first code as "Your code to create an account". After it: "Your name", the required "Choose how you'll sign in next time", and "You're set up", as Member.

**The preSignUp trigger re-checks** (`preSignUpForAccountCreation`): an account carrying the sign-up mark passes only when the mode lets that address make its own account; admin invites (unmarked) always pass; Cognito's `SignUp` is refused. Required in `domains` mode (synthesis fails without it).

**Never-verified sign-ups are deleted after 24 hours** by `UnverifiedAccountSweep`, modelled on the invite-expiry sweep ([0019](0019-invite-expiry-sweep.md)): hourly, a bundled Lambda, intent → `AdminDeleteUser` → result as `system:unverified-sweep`. Only marked accounts qualify, so admin invites keep their 7-day disable path; an account with any group (the owner included) or a disabled one is skipped.

**Request access** (`…requestAccess`): name, email, and an optional reason, rate-limited, the same answer for every address. A new address becomes a request in the app's DynamoDB (`AccessRequestTable`), never a Cognito user; an address with an account gets the existing-account email instead. Admins with `people.manage` see a "Pending requests" tab with a badge and get a daily digest (`AccessRequestDigest`), not one email per request. **Approve** sends the ordinary invite through the same code path as the invite form (the approved wording, REPORT §5.2j); **Decline** is silent unless the site turns on `notifyOnDecline` (§5.2k). Requests expire after 30 days; a request, with its typed name and reason, is deleted 30 days after it's settled (approved, declined, or expired).

**Members on sign-up sites** (`createSelfServiceActions`, `MyAccount`'s `selfService`):

- **Delete my account:** a sign-in in the last 5 minutes and the address typed out; never the owner (transfer ownership first). Item access removed, signed out everywhere, deleted, "Your account was deleted" sent (§5.2m), audited as the person.
- **Change my email:** a sign-in in the last 5 minutes; the new address must pass the domain list. The server sets it (`AdminUpdateUserAttributes`); the pool's `AttributesRequireVerificationBeforeUpdate` keeps the old address in effect while Cognito sends a code to the new one. The server verifies the code with the person's own token, then tells the old address (§5.2l). On invite-only and request sites admins change addresses, as before.

**Every self-made account starts as Member.** Nothing at sign-up grants a group. `auth-kit/testing` adds a freshly signed-up Member (`FRESH_SIGN_UP_MEMBER`, persona `newMember`): with `signUpSite: true` the matrix requires it and runs it against every route, held to a member's expectations.

## Chosen here

- **The sign-up mark is a custom attribute**, immutable, and in the pool's schema only on sign-up sites. The sweep, the trigger, and the code email all tell sign-ups from invites by it; nothing can set or clear it after creation. Turning a site to `domains` or `open` adds the attribute on the next deploy (an additive schema change).
- **The domain list matches subdomains on a label boundary** (`nc.gov` takes `osbm.nc.gov`, not `evilnc.gov`), and a bare top-level domain (`edu`) is allowed, as the studio's examples need. The words: "Example Reports accounts are for nc.gov addresses."
- **Federated first sign-ins count as sign-ups** in the trigger (refused on invite and request sites). No federation is configured today.
- **An existing address may get two emails.** The route emails it; the browser then asks Cognito for a code, which an account that can use codes also receives. Signing in with that code is a normal sign-in. An address that signed up before and never used its code counts as new: no email from the route, and its next code is fresh.
- **Timing.** An 800 ms floor on every answer past the origin check, so a new address (an account and two audit rows) and an existing one (an email) answer alike. A site can pass `background` (`after` from `next/server`, or `waitUntil`) so the email goes out after the answer and SES's speed can't tell them apart either. If AWS fails, the answer is honest: a failed account creation is 503, while a failed existing-account email is reported to `onError` and still answers 200.
- **Rate limits** (`ACCOUNT_CREATION_POLICY`): sign-up 5 per mailbox and 30 per IP an hour, and 300 site-wide; requests 3 per mailbox a day and 20 per IP an hour, and 100 new a day site-wide; email changes 5 per account and 5 per new address an hour. They're fixed windows in `RateLimitTable`, with addresses and IPs stored only as SHA-256 hashes. A store that can't count is a refusal (503). The per-IP limit reads the `X-Forwarded-For` entry the site names (`clientIp`, required; see the amendment); the WAF rule, which sees the real address, is the one that can't be dodged.
- **The silent WAF check** (`accountCreationWafRules`: a Challenge rule and a per-IP rate rule on POSTs to the two routes) for a CLOUDFRONT-scope web ACL associated with the Amplify app (`createSiteWebAcl`; deploy in `us-east-1`, associate in Amplify Hosting). The screens send through `window.AwsWafIntegration.fetch` when the page loads AWS WAF's script, so the token rides along. Required in `domains` and `open` modes (register D3; amended 2026-10-19: it was optional in `domains` mode).
- **What's audited.** Each sign-up account (`accounts.signUp`, as `system:sign-up`), each sweep deletion, approvals and declines (`people.approveRequest`, `people.declineRequest`), a member's delete and email change. Filing a request isn't: the typed name and reason never enter the append-only log, so they can really be deleted after 30 days. Decline rows carry the address only.
- **Approvals** default to Member, may grant a role the approver can grant (the invite's guardrails, step-up, and reasons apply), skip the outside-domain confirmation (an approval isn't a typo), and close the request if the address already has an account.
- **The digest** goes out at 8:00 Eastern by default, to every enabled member of a group whose role manages people (the owner, Super admins, Admin – content & people). With nothing pending, nothing is sent; with requests waiting and nobody to tell, the run fails and alarms. It also deletes requests past retention, so the rule holds while DynamoDB's TTL lags.
- **One pending request per address** is a per-address marker item (`pending#<sha256>`, conditional write), so two requests for one address can't both be filed (amendment).
- **Email changes go through the server**, which enforces the recent sign-in, the domain list, the rate limit, and the notice to the old address. An address another account uses gets the same answer as a free one and nothing changes; requests take at least 800 ms either way. "Your name" writes `given_name`, `family_name`, and `name` with the person's own token.
- **Email changes through Cognito's own API are refused by the custom message trigger** (amendment). Cognito lets every app client write the pool's required attributes ("All app clients can write user pool required attributes", AWS's user-attributes guide), and `email` is required in an email-login pool, so `WriteAttributes` can't stop it, and there's no pre-update trigger. But both steps of a self-made change need the custom message trigger to send the code, and Cognito fails the call when the trigger throws.
- **Deleting your own account** is refused for the owner only; another admin may delete themselves.
- **The sign-up screen links the privacy notice** in both sign-up modes (D4): "Privacy notice: what {Site} keeps about you, and why." With `termsUrl` on open sign-up, it's the studio's "By creating an account you agree to the {Site} terms and privacy notice." "Your name" says "Create account" (the studio's vote is open; `nameButton: 'finish'` switches it).

## To verify on the first sandbox deploy

- That Cognito's emailed sign-in codes reach the custom message trigger as `CustomMessage_Authentication` (AWS's documentation says so).
- That `AdminUpdateUserAttributes` with `AttributesRequireVerificationBeforeUpdate` keeps the old address and sends a code to the new one (documented for `UpdateUserAttributes`; the admin call is expected to match).
- That `callerContext.clientId` is `CLIENT_ID_NOT_APPLICABLE` for `AdminUpdateUserAttributes` (the literal the trigger checks); that a user's own `UpdateUserAttributes` and `GetUserAttributeVerificationCode` fail with the trigger's message and send no code; and whether a refused `UpdateUserAttributes` leaves a pending address (inert without a code, and replaced by the next change).
- That AWS WAF's Challenge works on Amplify Hosting's association with the integration script loaded, and that the `aws-waf-token` cookie reaches the sign-up route.
- **The operator smoke test, after every deploy of a sign-up site** (`domains` or `open`): from outside, POST to the sign-up route with no token (`curl -si -X POST https://<site>/api/auth/sign-up -H 'origin: https://<site>' -H 'content-type: application/json' -d '{"email":"smoke-test@example.org"}'`) and expect AWS WAF's challenge (`202`, `x-amzn-waf-action: challenge`), never the route's JSON.
- Which `X-Forwarded-For` entry is the client behind Amplify Hosting (`forwardedForClientIp()` takes the last; `trustedProxies` if there's another hop).
- That sign-up accounts are `CONFIRMED` at creation (passwordless) and that a disabled account answers `InitiateAuth` with `NotAuthorizedException` (the screens treat it like an unknown address).
- That the synthesis check's read of the rendered pool (`_toCloudFormation`, a CDK internal) still works after CDK upgrades. It falls back to the typed property.

## Consequences

- Three new tables (requests, rate limits, settings; see [0024](0024-sign-in-copy-and-family-themes.md)) and two scheduled functions on sites that use them, near zero cost.
- Sign-up sites need the preSignUp trigger (domains mode), `RateLimitTable`, and the custom message trigger for the "create an account" wording; request sites need `AccessRequestTable` and the digest.
- Breaking for anyone on `selfSignUp` (none deployed): replace it with `accountCreation`, swap `preSignUpAllowlist` for `preSignUpForAccountCreation`, and mount the routes.

## Amendment 2026-10-18: the security review

A review of PR #20 found one high and eight medium issues. What changed:

- **H1, email changes through Cognito's public API.** The custom message trigger refuses `CustomMessage_UpdateUserAttribute` and `CustomMessage_VerifyUserAttribute` unless `callerContext.clientId` is `CLIENT_ID_NOT_APPLICABLE` (the admin API, which only the site's server calls). A user's own `UpdateUserAttributes` then fails and no code is sent, and a resent code (`GetUserAttributeVerificationCode`) is refused the same way, so a pending address can only be verified through the server route. The preset now requires the trigger on every pool (synthesis fails without it, read from the rendered pool). This replaces "a future pre-token or event check". **Residual risk:** the control is the trigger, so a deploy that drops it (the synthesis check prevents that through the preset) or a change to how Cognito reports the caller would reopen it; a refused call may leave a pending address with no way to verify it, which the next change replaces; an admin with Cognito access can still change any address.
- **M1, forged `X-Forwarded-For`.** `clientIp` is required. `forwardedForClientIp()` takes the last entry, the one Amplify Hosting's CloudFront appends; the client writes the ones to its left. The audit row records the same address.
- **M4, open and domains sign-up as an amplifier.** Per-address limits count the mailbox (`rateLimitAddress`: no `+tag`, Gmail without dots; conservative, so it only ever groups more); a site-wide breaker (300 sign-up attempts an hour) answers every address the same 503 before any lookup, at the price that a flood pauses real sign-ups too; open mode requires the site web ACL (`siteWebAclArn` in the preset) and refuses sign-ups without AWS WAF's token cookie. The unverified sweep lists enabled accounts only and pages through any pool size (no ListUsers filter can name the mark or `email_verified`, and sign-up accounts are `CONFIRMED` at once, so `FORCE_CHANGE_PASSWORD` doesn't find them), at most 1,000 deletions a run.
- **M5, request filing that grew with the queue.** `create` is one conditional write of the marker and one of the request; the queue is capped at 100 new requests a day; every answer takes the floor, early refusals and errors included, and the exported handlers are floored too.
- **M6, request spam.** The digest's subject and preheader are counts and the site name only; it lists at most 25. `people.declineRequests` declines up to 100 in one audited step, always silently.
- **L1:** the sweep re-reads each account (`AdminGetUser`) just before deleting it and leaves it if anything changed. **L2:** request IDs and user agents in audit rows are capped. **L3:** email changes are limited per new address too. **L4:** approving uses the name the approver confirms.
- **I1:** `AccessRequestTable` keeps no point-in-time backups by default, so the 30-day deletion holds (PITR would keep typed names and reasons up to 35 days longer; `pointInTimeRecovery: true` if the privacy notice says so).
- **I2:** a bare top-level domain (`edu`) and subdomain matching are broad by design: every `.edu` mailbox, students and alumni included, can create an account. Say so in the site's config.
- **I3:** federated first sign-ins count as sign-ups; if an identity provider is ever added to an `open` pool, each becomes a Member without the route's limits. None is configured.
- **I4:** a sign-up site must deploy `UnverifiedAccountSweep`. Without it, `InviteExpirySweep` disables unverified sign-ups at 7 days, and the unverified sweep never deletes a disabled account.
- **I5 (left):** the request route emails "You already have an account" to an unverified sign-up while the sign-up route treats that address as new. Same answer either way; harmless.

### The verification review's follow-ups (N1–N6)

- **N1, the WAF requirement.** `siteWebAclArn` and the `aws-waf-token` cookie only detect misconfiguration: the cookie can be forged and the app can't validate it, so the control is AWS WAF at the edge. `createSiteWebAcl` now takes the site's `accountCreation` and fails synthesis if its challenge rule doesn't challenge (any mode) or, in `open` mode, its per-IP rule doesn't block, read from the rendered ACL so a later change or override is caught (`siteWebAclRuleProblems` for a site's own ACL). What synthesis can't see, the association in Amplify Hosting, the operator smoke test above checks after each deploy.
- **N2, the custom message trigger is a security control.** It refuses public-API email changes (H1), so it must be `customMessageHandler` or a site handler wrapped with `withAuthKitCustomMessage` (the refusal first, then the site's wording; `refusePublicAttributeChange` on its own). The function carries `CUSTOM_MESSAGE_GATE_ENV` (`AUTH_KIT_CUSTOM_MESSAGE_GATE=v1`), and the preset finds the trigger's function in the app at synthesis (across stacks) and fails if it lacks the marker or isn't in the app. **Residual:** the marker is a declaration, not proof: a site that sets it on a handler without the refusal defeats the check, and code review is the control for that.
- **N3, the chooser page and the code-only persona.** `assertAuthMatrix` requires `codeOnlyMember` wherever the server enforces the first credential (the default), not only on sign-up sites, since invitees start code-only everywhere; `routesFromNextBuild` fails when the build has no page at `firstCredentialPath`.
- **N4 (residual, accepted): the site-wide breaker is an availability lever.** 300 sign-up attempts in an hour pause real sign-ups for the rest of the window. With the real client IP (M1) at 30 an hour each, that costs an attacker about ten IPs that solve the challenge, every hour. `rateLimitRules.signUpSite` is tunable.
- **N5 (residual, to check live): one appending proxy.** `forwardedForClientIp()` assumes CloudFront is the only hop that appends to `X-Forwarded-For`; if Amplify Hosting's compute adds another, `trustedProxies` must be 2. An entry that isn't an IP literal reads as unknown and skips the per-IP limit (the per-mailbox and site-wide limits still apply).
- **N6 (residual, accepted): pending requests per exact address.** The one-pending marker keys on the exact address, not the mailbox, so `victim+1@` and `victim+2@` can each hold a pending request; the per-mailbox limit (3 a day) bounds it.

## Amendment 2026-10-19: the register

- **The WAF challenge is required in `domains` mode too** (register D3 says every sign-up gets the silent check; the 2026-10-18 amendment had made it optional there). The preset fails synthesis without `siteWebAclArn` in `domains` and `open` modes, and the sign-up route refuses requests without the `aws-waf-token` cookie in both (`requireWafToken: false` for local development only).
- **I4 is enforced.** `applyAuthStandard` fails synthesis on a sign-up pool (`domains`, `open`) that no `UnverifiedAccountSweep` in the app sweeps (the construct carries a mark with its pool; `auth-kit/amplify`'s `UNVERIFIED_SWEEP_MARK`).
- **`accountCreationAppPolicy` takes `accountCreation`** (the preset's setting) instead of a `selfSignUp` flag, and grants the account-change notice route's read (`cognito-idp:ListUsers`), on by default (register A10).
- **The card's line names the mode** (register D1, as Card Studio draws it): "New to {Site}? Request access", "New to {Site}? Create an account with your {domains} email address.", "New to {Site}? Create an account", and the invite-only lines.
- **Open sign-up sites are public**: their screens say "the {Site} team" and leave out the Teams line, whatever the family (register E4c).
