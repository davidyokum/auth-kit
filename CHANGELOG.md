# Changelog

All notable changes to auth-kit. Versions follow [Semantic Versioning](https://semver.org/); `0.x` releases may change APIs between minor versions.

## [0.1.9-alpha.1] - 2026-10-19

The register's A5a, decided the same day after v0.1.9-alpha shipped. Pre-release. No breaking changes.

### Changed

- **Continue opens the passkey prompt only where this browser remembers one** (register A5a): a first-time user no longer meets the browser's "no passkey found". Otherwise `SignIn` shows **"How do you want to sign in?"** ("for {email} · Change"): **Use a passkey** (recommended; "Your face, fingerprint, or device PIN."), **Use a password**, and **Email me a code**, with "Trouble signing in?" and the footer. The same screens and the same server traffic for every address until the person chooses ([ADR 0018](docs/decisions/0018-same-screens-for-every-address.md)).
- **The passkey hint:** salted SHA-256 hashes of normalized addresses in this site's `localStorage` (a random per-browser salt beside them), never sent to the server; set after a passkey sign-in or creating a passkey, removed when My account removes the account's last passkey or after choosing another way in twice in a row from the prompt it opened; blocked storage means the choice screen. ADR 0024 amended (including what it means on a shared computer).
- The invite email says to choose **Email me a code**.

## [0.1.9-alpha] - 2026-10-19

auth-kit brought fully in line with the passwords-flow decisions register as answered on 2026-10-19 (A6, A7, A9, A10, B1, C1, C5, D1, D3, E3, E4a, E4c, E4d, E5, E6, E7, F7, F11): the sign-in, email, and account rules ([#22](https://github.com/davidyokum/auth-kit/pull/22)) and the backdrops (six new styles, subject rotation, a still frame on slow devices, each style loaded on first use). Pre-release. Breaking: see Migration.

### Security

- **Every sign-up gets the silent WAF check** (D3): the preset fails synthesis without `siteWebAclArn` in `domains` mode as well as `open`, and the sign-up route refuses requests without AWS WAF's token in both.
- **A sign-up site must deploy the unverified-account sweep** (D3): `applyAuthStandard` fails synthesis on a `domains` or `open` pool that no `UnverifiedAccountSweep` sweeps.
- **The standard's server rules can't be switched off on a site** (A1, A2): `createServerAuth`'s `requireFirstCredential: false` and `requireTotpForPasswordUsers: false` are accepted only in the auth matrix's server mode and throw anywhere else.
- **Account-change notices, on by default** (A10): "A passkey was added to your account" and "Your password was changed", emailed to the account's own address by `createAccountNoticeRoute` (`auth-kit/accounts`), which the screens call after the change. The route checks the session, checks a passkey notice against the account's passkeys, and is rate-limited. ("Your email address changed" already went to the old address.)
- **Every sender is a reply-able `sign-in@` mailbox, never `noreply@`, with the family's suffix** (A10, E4a): checked in the preset, `createSesInviteMailer`, the invite-expiry owner warnings, and the digest.
- **A person's own help address only with an explicit acknowledgement** (E4c): `{ address, personal: true }` in config, and the same rule (an "on purpose" box) for the Super admin's Settings override.
- **One shared web ACL per account** (F7): a deployed pool reuses it (`waf: { webAclArn }`); a pool's own ACL needs `waf: { ownWebAcl: true }` outside a sandbox.

### Added

- `auth-kit/themes`: `cardStyle` (`'quiet'` default, `'monogram'`, `'frosted'`, `'plain'`, `'porcelain'`; register E5, matching Card Studio's directions), `CARD_STYLES`, `cardStyleVariables`; `HelpAddressSetting`, `readHelpSetting`, `helpSettingProblems`; `senderAddressProblems`, `senderNameProblems`, `senderProblems`, `parseSender`, `formatSenderAddress`, `siteSender`, `SENDER_LOCAL_PART`; `theme.senderAddress` and `theme.help.personal`.
- `auth-kit/accounts`: `createAccountNoticeRoute`, `ACCOUNT_NOTICE_PATH` (`/api/auth-kit/account-notice`), `ACCOUNT_NOTICE_EVENTS`. `auth-kit/admin`: `passkeyAddedEmail`, `passwordChangedEmail`, `OWNER_CHOICE_LABEL`, `ACCOUNT_NOTICE_COGNITO_ACTIONS`.
- `auth-kit/client`: the `notices` prop on `SignIn`, `SignUp`, and `MyAccount` (on by default; `false` turns it off), `sendAccountNotice`, `monogramOf`; the envelope icon in every email field (A9; `Field`'s `icon`); the Monogram badge.
- `auth-kit/backdrops`: six styles (register E7): `yokum-magnetic` (Yokum Lab's sign-in: filings, a falling title, the magnet), `ai-survey-dots` and `pulse-dots` (the survey dot fields), and the blueprint family `county-survey` (NC's 100 counties), `river-basins` (the 17 basins), and `star-chart` (40 constellations, 88 optional), drawn with a frozen plotter core. Subject rotation (E3): `subject: { rotation: 'tour' | 'random' | 'day' | 'fixed', key, set }`, `pickSubject`, `stats().subject`; the tour lives in this browser's `localStorage` only. A still frame on slow devices (E6): Save-Data, `deviceMemory` of 2 GB or less, or frames over `frameBudgetMs`; `stillOnSlowDevices`, `stats().stillReason`. `siteName` reaches styles. `settlesAt`: a finished drawing rests until the pointer or a tap. `lazyVersion` and `loadBackdropStyle`: each style loads on first use, in its own chunk. `CARD_WIDTH` (380).
- `auth-kit/amplify`: `waf.ownWebAcl`; `email.family`; `UNVERIFIED_SWEEP_MARK` (on `UnverifiedAccountSweep`).
- `auth-kit/testing`: `itemRoute` (`recordRoute` stays as an alias).

### Changed

- **The button words are decided** (A6), not options: Continue on the email, password, and in-between steps, the sign-up code step included (it said "Verify"); Sign in on the steps that finish.
- **Emailed codes work for 10 minutes by default** (A7): `codeLifetimeMinutes` (and Cognito's `AuthSessionValidity`) default to 10, and every screen and email says so.
- **The card** (E5): 380px, "Trouble signing in?" inside, the defined 3:1 edge, no monogram, by default; the backdrop assumes the same 380px card (it assumed 440px).
- **The card's line names its mode** (D1): "New to {Site}? Request access", "… Create an account with your {domains} email address.", "… Create an account".
- **Open sign-up sites say "the {Site} team"** and leave out the Teams line, automatically (E4c).
- **Admin alerts carry the footer** (E4a): the Super admin grant, ownership transfer, Manager's invite, help-address change, and last-owner warning use the shared email layout.
- **"Owner (only one)"** where roles are chosen or compared; plain "Owner" where it names someone (C1; ADR 0020 amended).
- **The personal family lives on yokum.app** (F11): sender `sign-in@yokum.app`, default help mailbox `help@yokum.app`, family domain `yokum.app`; the backdrop family's label is "Personal".
- **Resource screens always use the type's noun** (C5): `noun` is required on `ResourceAccessTable`, `ResourceRolesSummary`, and `resourceRoleDescriptions`, and a failed access list carries it.
- **My account's passkey line** (E4d): "Sign in with your face, fingerprint, or device PIN. Passkeys saved in a password manager work too."
- `accountCreationAppPolicy` takes `accountCreation` (the preset's setting) instead of `selfSignUp`, and grants the notice route's read.
- **`drawBackdropStill` is async** (it loads the style's code first).
- ADR 0021 amended (E3, E6, E7): play optional and never part of signing in, a still frame on slow devices, no sound unless switched on, subject rotation, lazy loading, the new styles; `THIRD_PARTY_NOTICES.md` adds d3-celestial (BSD-3-Clause), the Yale Bright Star Catalogue, OpenStreetMap (ODbL 1.0), and the Census and USGS sources.
- Docs: B1 ("no role overrides in the browser") in ADR 0009 and the localhost guide; ADRs 0002, 0006, 0013, 0020, 0023, and 0024 amended; "record" → "item" in the matrix docs; "Editor" → "Admin – content only" in the View as examples; the stale "owner line" and "4px rule" comments.

### Removed

- The OSBM authorized-use line (`theme.authorizedUseLine`, `showAuthorizedUse`; A10 dropped it). Nothing hooks MyNCID colours or an NCID slot (backlog).
- `RESOURCE_ROLE_DESCRIPTIONS` (the generic "item" wording).
- `SignIn`'s and `SignUp`'s `securityNotices` (replaced by `notices`, on by default).

### Migration

1. **Senders.** Send from the site's `sign-in@` mailbox with the family's name: the preset's `email: { fromAddress: 'sign-in@…', fromName: senderDisplayName(siteName, family), family, replyTo }` (`family` is new and required). `createSesInviteMailer({ from: siteSender(siteName, family, 'sign-in@…'), site: { siteName, theme: family, help } })` (`site` is new and required). `InviteExpirySweep`'s `ownerWarnings` takes `family` and `helpEmail` (both required) and a `from` with the family's name. Verify the `sign-in@` address's domain in SES first.
2. **WAF.** Sign-up sites in `domains` mode now need `siteWebAclArn` (`createSiteWebAcl`), like `open`. Every deployed pool needs `waf: { webAclArn }` (the account's `createSharedAuthWebAcl`) or `waf: { ownWebAcl: true }`.
3. **Sweep.** Sign-up sites (`domains`, `open`) must add `new UnverifiedAccountSweep(stack, 'UnverifiedSweep', { userPool, auditLog })`.
4. **Notices.** Mount the notice route at `app/api/auth-kit/account-notice/route.ts`: `export const POST = createAccountNoticeRoute({ auth, siteName, signInUrl, theme, help, mailer, rateLimits }).POST` (a `RateLimitTable`). Replace `securityNotices` with nothing (on by default) or `notices={false}`. `accountCreationAppPolicy({ …, accountCreation })` replaces `selfSignUp`.
5. **Help address.** A first.last-shaped help address now needs `{ address, personal: true }`; role mailboxes are unchanged.
6. **Themes.** Remove `showAuthorizedUse` (it throws). Pick a card style with `authTheme(family, { cardStyle })` if the site wants one other than Quiet.
7. **Resources.** Pass `noun` to `ResourceAccessTable` and `ResourceRolesSummary`; use `resourceRoleDescriptions(noun)` instead of `RESOURCE_ROLE_DESCRIPTIONS`.
8. **Server.** Remove `requireFirstCredential: false` and `requireTotpForPasswordUsers: false` from `createServerAuth` (they throw outside the matrix server mode).
9. **Code lifetime.** Sites that passed `codeLifetimeMinutes: 3` keep 3 minutes; the rest get 10. Pass the same value to the preset, the screens, and the custom message trigger.
10. **Backdrops.** `await drawBackdropStill(…)` (it returns a promise now). A site on County Survey, River Basins, or Star Chart may set `subject` (a tour by default); one on Yokum magnetic passes `siteName`. Under a strict CSP nothing changes: the style chunks are same-origin scripts from the site's own bundle. Locked backdrops draw exactly as before.

## [0.1.8-alpha.1] - 2026-10-19

Fixes the scheduled jobs' deploy. Pre-release. No API changes; logical IDs are unchanged, so a deployed job is updated in place.

### Fixed

- **Every Scheduler schedule now deploys** (`InviteExpirySweep`, `UnverifiedAccountSweep`, `AccessRequestDigest`). The scheduler role's trust policy scoped `aws:SourceArn` to `arn:...:schedule/<group>/*`, but EventBridge Scheduler presents the schedule group's ARN, so the condition never matched and CloudFormation's CreateSchedule failed with "The execution role you provide must allow AWS EventBridge Scheduler to assume the role" (the v0.1.8-alpha demo deploy rolled back on it). The trust is now `scheduler.amazonaws.com` with `aws:SourceAccount` and `aws:SourceArn` equal to the job's own schedule group ARN, as AWS documents. Still only this account's scheduler, for this group.
- **Each schedule waits for its role and the role's policy** (an explicit `DependsOn`, not just the role ARN reference), so it's never created against a role that can't yet invoke its function.
- `test/admin/scheduler-roles.test.ts` checks every schedule the kit creates in the synthesized template: the trust principal and condition, `lambda:InvokeFunction` on its own target only, and the dependencies; and that schedules come only from the shared helper.

## [0.1.8-alpha] - 2026-10-18

Account creation ([ADR 0023](docs/decisions/0023-account-creation.md)), and the sign-in card in the approved words with the families as themes ([ADR 0024](docs/decisions/0024-sign-in-copy-and-family-themes.md)): auth-kit brought in line with the passwords-flow decisions register (A1, A3, A4–A7, D1–D4, E1, E2, E4, E4d, E5, P8, and David's 2026-10-18 decisions on emails, the help route, and the passkey icon). Pre-release. Breaking: see Migration.

### Security

- **Cognito's own `SignUp` is always off**, in every mode, and synthesis fails if anything turns it back on (the rendered pool is checked, overrides included). Sign-up is a server route that creates the account like an invite, so nobody can skip the domain list, the rate limits, or the bot check by calling Cognito directly, and Cognito can no longer be asked who's registered.
- **Sign-up and request access answer every address alike**, in at least 800 ms; an address with an account gets an email instead of a different screen. Per-address and per-IP rate limits fail closed; an optional CLOUDFRONT web ACL adds a silent challenge and a per-IP limit (`accountCreationWafRules`, `createSiteWebAcl`).
- **The preSignUp trigger re-checks the domain list** on every account the sign-up route makes (marked with the immutable `custom:authkit_origin`), and refuses Cognito's `SignUp`.
- **Never-verified sign-ups are deleted after 24 hours** (`UnverifiedAccountSweep`): only marked accounts, never one with a role, never the owner, never an admin's invite (those keep the 7-day disable).
- **The first credential is required**: no "Not now" after an invite's or a sign-up's first code, so no account is left on emailed codes alone (A1).
- **Self-service on sign-up sites** needs a recent sign-in: delete my account (never the owner) and change my email (verified before it takes effect; the old address told; the same answer whether or not another account uses the new address).
- **The help address is required and role-based**: synthesis fails while `email.replyTo` is missing, a placeholder, or a person's own address. A Super admin's override (Settings → "Sign-in help") needs `settings.security` and a recent sign-in, is audited, alerts the owner, and is undone if the alert can't be sent.
- **Access requests' typed names and reasons** stay out of the append-only audit log and are deleted 30 days after the request is settled.

### Security review fixes (PR #20, 2026-10-18)

- **Email changes through Cognito's public API are refused** (H1): the custom message trigger refuses `CustomMessage_UpdateUserAttribute` and `CustomMessage_VerifyUserAttribute` unless the admin API made the call, and every pool must have the trigger (synthesis fails without it).
- **The first credential is enforced on the server** (M2): `requireUser` refuses an account with neither a passkey nor a password (403 `first_credential_required`, `FirstCredentialRequiredError`); page guards send it to `firstCredentialPath` (default `/account/sign-in-method`), which passes `allowFirstCredentialEnrollment`. `SignIn` never goes in after a failed factors read.
- **The per-IP limit can't be dodged by a forged header** (M1): `clientIp` is required; `forwardedForClientIp()` takes the proxy-appended (last) `X-Forwarded-For` entry.
- **Refused accounts read like unknown addresses** (M3, L5): a disabled account, an expired invite, or one whose password must be reset gets the decoy passkey prompt and the simulated code on those paths, and the wrong-password message on the password path.
- **Open and domains sign-up can't be used as an amplifier** (M4): per-mailbox limits (`rateLimitAddress`), a site-wide breaker (300 an hour), open mode requires the site web ACL (`siteWebAclArn`) and AWS WAF's token, and the unverified sweep pages through any pool size and re-reads each account before deleting it (L1).
- **Filing a request is constant work** (M5): a per-address marker item instead of a queue read; at most 100 new requests a day; every answer takes the floor, errors and the exported handlers included (L11).
- **Request spam stays out of subjects** (M6): count-only digest subjects, at most 25 listed, `people.declineRequests` (up to 100, one audit entry, silent); approving uses the approver's name (L4).
- **The help-address override stays on allowed domains** (M8): the configured address's domain or the family's (`theme.help.domains`), `allowedDomains` as the escape hatch; every Super admin is alerted with the owner; the local part is a plain mailbox.
- Audit rows cap request IDs and user agents (L2); email changes are limited per new address (L3); the decoy passkey prompt takes the pool's relying-party ID and timeout (`SignIn`'s `passkey`, L6); link props must be paths or http(s) URLs (I6).
- Tests refuse any socket or `fetch` beyond this machine, covering the SDK's unsigned Cognito calls (L7). The PR job packs and checks the tarball (M7). No source maps (L8) or dated reviews (L10) in the package; the Lucide notice names the version (L9). `AccessRequestTable` keeps no point-in-time backups by default (I1).
- Copy: the passkey help's device line uses the theme's `devDesk` ("the device maker's support" on personal sites); "Try again, or use a password instead." when a passkey can't be created; request access's own network message.
- **From the verification review:** `createSiteWebAcl({ accountCreation })` fails synthesis if the challenge rule doesn't challenge or, in open mode, the per-IP rule doesn't block (N1), with an operator smoke test in the README and ADR 0023; `withAuthKitCustomMessage(handler)` keeps the refusal for sites with their own wording, and synthesis checks the trigger's function carries `CUSTOM_MESSAGE_GATE_ENV` (N2); the matrix requires `codeOnlyMember` wherever the first credential is enforced, and `routesFromNextBuild` fails without the chooser page (N3).

### Added

- `accountCreation: { mode: 'invite' | 'request' | 'domains' | 'open', domains?, requestsAlso? }` on the preset (and `normalizeAccountCreation`, `emailDomainAllowed`, `takesAccessRequests`, … from `auth-kit/amplify` and `auth-kit/accounts`); `codeLifetimeMinutes` (default 3; A7) on the preset, the screens, and the custom message trigger.
- `auth-kit/accounts`: `createAccountCreationRoutes` (the sign-up and request routes), `createSelfServiceActions`, `createSignInHelp` and `createSignInHelpActions`, the request, rate-limit, and settings stores (memory and DynamoDB), and the jobs' logic.
- `auth-kit/admin/cdk`: `AccessRequestTable`, `RateLimitTable`, `SiteSettingsTable`, `UnverifiedAccountSweep`, `AccessRequestDigest` (bundled Lambdas, least-privilege roles, alarms). `auth-kit/admin`: `people.listAccessRequests`, `approveRequest` (the ordinary invite), `declineRequest` (silent unless `notifyOnDecline`); `accountCreationAppPolicy`, `siteSettingsAppPolicy`; `renderSignInHelpChangedEmail`; the SES mailer's `sendEmail` and `signInHelpChanged`; every auth email's renderer (`inviteEmail`, `existingAccountEmail`, `requestDeclinedEmail`, `accessRequestDigestEmail`, `emailChangedEmail`, `accountDeletedEmail`, and the code emails).
- `auth-kit/admin/ui`: `PeoplePageTabs`, `PendingRequestsTable`, `PendingRequestsBadge`, `SignInHelpSettings`.
- `auth-kit/amplify/pre-sign-up`: `preSignUpForAccountCreation`. `auth-kit/amplify/custom-message`: `customMessageHandler`.
- `auth-kit/themes`: the families as themes (`FAMILY_THEMES`, `authTheme`, `senderDisplayName`, `themeCssVariables`), the computed card edge (`cardEdge: 'defined' | 'soft'`, `definedCardEdge`, `checkCardEdge`), and `helpAddressProblems`.
- `auth-kit/client`: `SignUp`, `RequestAccess`, `SignedOutEverywhere`; `MyAccount`'s `selfService`; the copy deck (`SIGN_IN`, `FIRST_VISIT`, `TROUBLE`, `ERRORS`, `helpScreen`, …); `saveName`; `wafAwareFetch`; `AuthCard`; `Icon`.
- `auth-kit/testing`: `NEW_MEMBER` and `FRESH_SIGN_UP_MEMBER`, and `assertAuthMatrix({ signUpSite: true })`, which runs a freshly signed-up Member against every route.
- ADR 0023 and ADR 0024; `THIRD_PARTY_NOTICES.md` (Lucide's icons, ISC).

### Changed

- **`SignIn` is the whole card, in the approved words** (Card Studio v4): email first; separate "Use your passkey" (no final button) and "Enter your password" ("for {email} · Change") screens; Continue on the email and password steps and Sign in on the authenticator and emailed-code steps (A6); an error summary that takes focus; "Trouble signing in?" and six help screens (`troubleLink`); the account-creation line (`inviteLine`); the family's footer line, nothing above the heading, no line on top (E4); the fingerprint passkey icon in the family accent and a password-field glyph (E4d). New required prop `help`; new props `theme`, `accountCreation`, `codeLifetimeMinutes`, `securityNotices`, `signUpHref`, `requestAccessHref`. ADR 0018's same screens hold throughout.
- **`ChooseFirstCredential`** is required: `onSkip` is gone; `onDone` receives `'passkey'` or `'password'`. `AuthenticatorSetup` reads "Add an authenticator app" with Continue.
- **Messages** use the approved words (`describeAuthError` takes `{ siteName, codeLifetimeMinutes, helpAddress }`).
- **Every screen word is in the copy deck**, My account's included (`MY_ACCOUNT`, `STATUS`, `SHARED`, `CONTACT` join the exported groups); a test fails when a component writes words of its own. Moved words keep their wording, with the deck's curly apostrophes.
- auth-kit's own tests refuse any `fetch` beyond this machine (Cognito's token-only user APIs need no AWS credentials, so `AWS_BLOCKED_ENV` alone didn't stop them).
- **Emails match the card** (David, 2026-10-18): no letterhead; the footer is the card's identity sentence and "Help: {address}." The invite names the inviter and the role and gives the expiry as an Eastern clock time; it replies to the inviter.
- **`email.replyTo` is required** in the preset (it's the help address).
- `InviteExpirySweep` shares the scheduled-job helper with the new jobs (its template is unchanged). ADRs 0019 and 0020 say "the owner" (one owner); 0001 and 0002 record that admins keep a password-plus-authenticator route (A3); 0021 drops the owner line.

### Migration

- **`selfSignUp` and `preSignUpAllowlist` throw.** Use `accountCreation` and `preSignUpForAccountCreation`; mount `createAccountCreationRoutes`' handlers at `/api/auth/sign-up` and `/api/auth/request-access`; deploy the tables and jobs your mode needs (README section 11).
- **Set `email.replyTo`** to the family's help mailbox (or the site's own): a plain, role-based mailbox (letters, digits, dots, plus, hyphen, or underscore before the @).
- **`SignIn` needs `help={{ address, owner }}`** (read the address in effect on the server with `createSignInHelp(…).effective()`), and renders its own card: drop the site's card wrapper, owner line, footer, and accent rule, and pass `theme`.
- **`ChooseFirstCredential`**: remove `onSkip`.
- Pass the same `codeLifetimeMinutes` to the preset and the screens if you change it from 3.
- **Every pool needs the custom message trigger** (`triggers: { customMessage }` with `customMessageHandler`, or your handler wrapped in `withAuthKitCustomMessage`), and its function needs `environment: { ...CUSTOM_MESSAGE_GATE_ENV }`: synthesis fails without either.
- **Add the chooser page** at `/account/sign-in-method` (or set `firstCredentialPath`): `pages.requireUser({ allowFirstCredentialEnrollment: true })` and `ChooseFirstCredential`.
- **`createAccountCreationRoutes` needs `clientIp`** (`forwardedForClientIp()` behind Amplify Hosting). **Open mode needs `siteWebAclArn`** in the preset and AWS WAF's script on the sign-up page. **`createSiteWebAcl` needs `accountCreation`**. After each deploy of an open site, run the WAF smoke test (README section 11).
- Pass the family to `createSignInHelp({ theme })` so a Super admin's override can use the family's domains.
- `PendingRequestsTable`'s `actions` gains `declineRequests` (`people.forms.declineRequests`).
- The screens' link props (`signUpHref`, `requestAccessHref`, `termsUrl`, `privacyNoticeUrl`, `stepUpHref`, `deletedPath`, `signedOutPath`, `signInHref`) must be a site path or an http(s) URL; anything else throws when the screen renders. Pass `SignIn`'s `passkey={{ relyingPartyId }}` once passkeys are on.
- `AccessRequestTable` keeps no point-in-time backups by default; pass `pointInTimeRecovery: true` only if the privacy notice says backups keep requests longer.
- **The auth matrix needs a `codeOnlyMember` persona** (`EMAILED_CODE_ONLY_MEMBER`) on every site (pass `requireFirstCredential: false` only if the server turns the rule off), and `routesFromNextBuild` needs the chooser page in the build (or `firstCredentialPath`). Sign-up sites' `FRESH_SIGN_UP_MEMBER` now has a passkey.

## [0.1.7-alpha.1] - 2026-10-18

Screens name items by the app's noun and the item's name, never by ID (register rule C5; [ADR 0022, amendment](docs/decisions/0022-resource-roles.md#amendment-2026-10-18-items-by-noun-and-name-never-by-id)). A revision of 0.1.7-alpha: 0.1.8 is the next feature release.

### Fixed

- **Activity lines** named items by key (`project:abc`) and said "item": they now say "the project “Roads 2027”" (or "a project"), from the app's current names (`describeActivity(entry, names, { items })`, `<ActivityLog items>`), else the noun and name recorded on the row, else the type. People without an email on file read "an account with no email on file", never a `sub`.
- **Results and messages** use the item's name where the app can say it (`resourceName`), else "this project": access changes, refusals, the conflict message ("Who has access to this project changed…"), creating ("Created the project “Roads 2027”."), and `requireResourceRole`'s and `listMyResources`'s 503 messages ("Access to this project couldn't be checked").
- **The admins' invite alert** no longer shows an item's ID when its name is unknown.
- **Audit call labels** say the noun ("TransactWriteItems project access", "App: create the project").

### Added

- Access rows record `item: { noun, name }` as of the change. `removeResourceMemberships` returns `message` (what was removed, and which items have no Manager now, by name), and the People page's disable result shows it; its partial-failure error names the items too (`describeAwsError` shows an error's `userMessage`). `itemPhrase`, `ActivityItem`, and `DescribeActivityOptions` from `auth-kit/admin`.
- `src/admin/invite-core.ts` (internal, shared by every invite flow): documented, with `INVITE_CALLS` (the audit labels) and `removeInvitedAccount` (the undo) beside `createInvitedAccount` and `sendInviteEmail`.

## [0.1.7-alpha] - 2026-10-18

Resource roles: Manager, Contributor, Reader on one item, combined with the site-wide roles (David's decision; [ADR 0022](docs/decisions/0022-resource-roles.md)). Pre-release. Two renames keep their old names, deprecated, for one release; see Migration.

### Security

- **One check for every item, combined with the site role.** `requireResourceRole(type, id, need)` allows an action when the site role grants it on every item (by capability: `content.read` sees, `content.edit` edits, `people.manage` manages access and invites) or the person's role on the item does. Someone who can't see the item gets 404, the same as an item that doesn't exist; someone who can see it but not do this gets 403; unreadable memberships are 503, never a pass. An ID that can't name an item gets nothing, not even the site floor.
- **Every item keeps a Manager, even with two Managers acting at once.** Each change to an item's access is one DynamoDB transaction conditioned on the version it read; the last Manager can't be removed, demoted, or leave, except by a site admin who manages people naming the new Manager in the same step.
- **Every access change is audited** (intent → transaction → result, with the person and the item named), and refusals by anyone who can see the item are logged. Access changes re-read the acting person live, so a demoted admin loses the site floor at once.
- **A Manager's invite is Member-level and reported.** It creates an account with no admin role and access to that one item; the admins who manage people (owner included) are alerted every time; if the alert or the invite email fails, the account and the membership are removed again; with no alert configured, invites are refused.
- **Least privilege for the membership table:** the app's role gets `GetItem`, `PutItem`, `DeleteItem`, and `Query` on it (transactions of Put and Delete need nothing more); deletion protection, point-in-time recovery, retained on stack delete, and `DeleteTable` denied to everyone outside sandboxes.

### Added

- `auth-kit/resources`: `defineResourceTypes` (nouns, per-type actions within startup-checked rules, `selfServiceCreate` and `sharedDirectory`, both off by default); `createDynamoResourceStore` and `createMemoryResourceStore` (the `ResourceAccessStore` contract); `createResourceActions` with `listAccess`, `add`, `grant`, `changeRole`, `remove` (and leaving), `invite`, `create` (an item's access and the app's record as one audited change), `deleteResourceAccess`, `removeResourceMemberships`, and `forms`; `checkAccessChange`, `decideResourceAccess`, `neededActions`, `createPermission`, `resourceAccessCopy`; `RESOURCE_AUDIT_ACTIONS` (`resources.create`, `.add`, `.changeRole`, `.remove`, `.invite`, `.delete`); `RESOURCE_TABLE_SCHEMA`.
- The vocabulary in `src/shared/policy.ts` (from `auth-kit/server` and `auth-kit/resources`): `RESOURCE_ROLES`, `RESOURCE_ROLE_LABEL` (Manager, Contributor, Reader), `RESOURCE_ROLE_RANK`, `resourceRoleDescriptions(noun)` and `RESOURCE_ROLE_DESCRIPTIONS`, `RESOURCE_ACTIONS` (`view`, `edit`, `manage-access`, `invite`), `RESOURCE_ACTION_LABEL`, `DEFAULT_RESOURCE_ROLE_ACTIONS`, `RESOURCE_SITE_FLOOR`, `RESOURCE_POLICY`, and `RESOURCE_ACCESS_MATRIX` (site roles and resource roles × actions, built from the constants the server uses).
- `auth-kit/server`: the `resources: { types, store }` option; `requireResourceRole`, `resourceAccess`, `listMyResources`; `pages.requireResourceRole` (403 and 404 render the not-found page).
- `auth-kit/resources/ui`: `WhoHasAccess` ("Who has access to this {noun}": role chips; add by email with a role picker giving each role's can and can't; an address with no account turns into the invite form; remove and leave; the last-Manager messages; "Site admins can also see and edit this {noun} (view-only admins can only see it)."), `ResourceRolePicker`, `ResourceRoleChip`, `ResourceRolesSummary` (for the site role picker's `resourceAccess` slot), `ResourceAccessTable`.
- `auth-kit/admin/cdk`: `ResourceAccessTable` with `grantApp`. `auth-kit/admin`: `resourceAccessAppPolicy`, `RESOURCE_ACCESS_APP_ACTIONS`, `renderResourceInviteAlertEmail`, `ResourceInviteNotifier`; the SES mailer's `resourceInviteSent` (and `renderResourceInvite`); `InviteEmail.item` (the invite email names the inviter and the item).
- `auth-kit/testing/matrix-server`: `resources`, an in-memory membership store shared by every bundle.
- The Activity page describes access changes ("gave access to m-2@example.org · project:p-1: no access → Contributor").

### Changed

- **Deprecated:** `requireRecordAccess` and `RecordAccessRule` (use `requireResourceRole`); `PeopleAdminConfig.removeRecordMemberships` (now `removeResourceMemberships`; both at once, if different, is refused). Both old names work unchanged for this release.
- The disable row records `after.resourceMemberships` (was `recordMemberships`).
- The People invite's account steps moved to `src/admin/invite-core.ts`, shared with a Manager's invite; behavior unchanged.
- The e2e fixture's records are on resource roles: created with their Manager and checked by `requireResourceRole` on real Next.js bundles.

### Migration

Deploy `ResourceAccessTable` and grant the server role (`grantApp`, or `resourceAccessAppPolicy`). Declare the app's types with `defineResourceTypes` and pass `resources: { types, store }` to `createServerAuth`. For records that kept an owner field: give each owner a Manager membership (a one-time script through `create`), then replace `requireRecordAccess(user, record, { owner, coveredBy })` with `requireResourceRole(type, id, 'view')` (the site floor replaces `coveredBy`). Rename `removeRecordMemberships` to `removeResourceMemberships` and pass `createResourceActions(…).removeResourceMemberships`. [ADR 0022](docs/decisions/0022-resource-roles.md#migration) has the details.

## [0.1.6-alpha] - 2026-10-18

Backdrops: a site's identity behind the fixed sign-in card. Pre-release.

### Added

- **`auth-kit/backdrops`** ([ADR 0021](docs/decisions/0021-backdrops.md)): seeded, generative art behind the sign-in card, in each family's palette. Eight styles (`magnetic-dots`, `contours`, `flow-lines`, `watercolor`, `aurora`, `stained-glass`, `constellation`, `ripples`) and `painted`, a slot for a finished image with a blur-up placeholder. Framework-free: `renderBackdrop(canvas | svg, { style, seed, styleVersion, family | palette, interactive, reducedMotion, card })` returns a controller (`pause`, `resume`, `update`, `stats`, `destroy`); `drawBackdropStill` draws one frame anywhere. No dependencies (a seeded generator and simplex noise are in the package).
- Enforced for every style: reduced motion draws one still frame; the loop stops while the tab is hidden or the canvas is off-screen; at most 30 frames per second and 2 backing pixels per CSS pixel; no allocation on the per-frame path; light palettes and slow motion; the canvas is `aria-hidden` and `pointer-events: none`, with passive window-level listeners, so clicks always reach the card and taps on it never reach a style. Nothing fades or veils the art around the card.
- `cardContrast(family)`: the card's text, links, button, and focus ring against WCAG 2.2 AA, and its edge (a 1px family-tinted border, `BACKDROP_FAMILIES[family].card.border`, or its surface) at 3:1 against every color the family's backdrops use.
- Choosing and locking: `backdropVariations({ style?, family, count, salt })` (nine seeds per salt; mixed styles by default), `randomSalt`, `defaultBackdrop(siteName)` (a proposal only), and `backdropLockProblems(stored)` for a site's build to refuse a backdrop that isn't stored as the literal `{ style, seed, styleVersion, locked: true }`.
- **Frozen style versions.** Each released style version is its own file and never changes, and the kernel it draws with (`kernel/v1`) is frozen too, so a locked backdrop draws the same picture on every later auth-kit; `test/backdrops/frozen.json` pins a hash of each version's drawing. A site moves to a newer version only by choosing it in the picker.
- **`auth-kit/backdrops/react`**: `<Backdrop style seed styleVersion family>`, the client component that sits behind the card (server-renders as a block in the page color; never breaks the page on a bad option). `backdropStyles`: an optional fade-in.
- **`auth-kit/backdrops/picker`** (dev only): `<BackdropPicker>`, nine variations behind the site's real card, a style filter, a family preview, a phone or desktop frame, Shuffle, a large view with "Use this one", and side-by-side upgrades when a locked style has a newer version. It carries `BACKDROP_PICKER_MARKER`, and `check-prod-build` now fails a production build that contains it.
- `SignIn` takes `emailHint`: an example address shown as the email field's placeholder, under the always-visible "Email address" label.
- `npm run demo:backdrops`: every style in every family (`docs/backdrops/`), served on 127.0.0.1.

### Changed

- `check-prod-build` (and `checkProductionBuild`'s default markers) also looks for the backdrop picker's marker.
## [0.1.5-alpha] - 2026-10-18

Site-wide roles: one owner, an explicit admin ladder, and Transfer ownership (David's decision; [ADR 0020](docs/decisions/0020-site-wide-roles.md)). Pre-release. **Breaking:** group names, capabilities, and the owner alerts changed; see Migration.

### Security

- **Exactly one owner, never granted.** The owner is the `owner` group. Nobody can grant it by invite or role change, not even the owner (`owner_transfer`); it moves only by `people.transferOwnership`, which only the owner can start, only to an enabled account that has signed in, with a reason, the new owner's address typed out, and a sign-in in the last five minutes. The new owner is added before the previous one is removed (who becomes Super admin), so a failure partway can leave two owners, never none; both are emailed, and if that email can't be sent the transfer is undone. Nobody disables, demotes, or deletes the owner (`last_owner`), and the invite-expiry sweep keeps them (its `OWNER_GROUP` is now `owner`).
- **Only the owner grants Super admin, and the owner is told.** You grant and act only below your own level, so Super admins manage every role below theirs but not each other. A Super admin grant needs a recent sign-in and an alert to the owner (`superadminGranted`), and is undone if the alert fails; before, owners made other owners and every owner was emailed.
- **The People table flags a site without exactly one owner.** Zero: the owner role can't be granted in the app, so the message names the break-glass path. More than one: an owner may change another owner's role while the live count is two or more (an unknown count is a "no").

### Added

- The ladder in `src/shared/policy.ts`: `STANDARD_GROUPS` = `owner`, `superadmin`, `admin-content-people`, `admin-content`, `admin-view` (precedence in that order); `ADMIN_ROLE_RANK`; `ADMIN_ROLE_LABEL` (Owner, Super admin, Admin – content & people, Admin – content only, Admin – view only); `MEMBER_ROLE`, `MEMBER_LABEL`, `SiteRole`; `ROLE_DESCRIPTIONS` (one line each of can and can't, Member included); `ROLE_MATRIX` (rows: each role then Member; columns: View everything, Edit any content, Manage people, Security, exports, deletion, Owner-only pages), built from the capability map; `ROLE_MATRIX_CAPABILITIES`; `OWNER_GROUP = 'owner'`; `RETIRED_GROUPS`.
- `STANDARD_CAPABILITIES` as a ladder: `admin-view` holds `content.read`, `people.read` (new), and `audit.read`; `admin-content` adds `content.edit`, `content.publish`; `admin-content-people` adds `people.manage`, `roles.manage`; `superadmin` adds `settings.security`, `data.export`, `data.delete`; `owner` adds `owner.private` and `owner.transfer` (new).
- `people.transferOwnership` (and `forms.transferOwnership`, `TransferOwnershipInput`, audit action `people.transferOwnership`); `roleOptions` (the picker's choices with can/can't and why each is unavailable), `roleLabel` and `isStandardGroup` from `auth-kit/admin`; `ownerCountWarning`, `SUPERADMIN_GRANT_NOTE`, `TRANSFER_OWNERSHIP_NOTE`, `OWNER_ROLE_NOTE`, `RESOURCE_ACCESS_NOTE`.
- `auth-kit/admin/ui`: `RolePicker` (each role's label and one-line can/can't; unavailable ones disabled with the reason; the owner shown apart, with "Transfer ownership…" for the owner; "Compare roles"; the note "These roles are for running the site. Access to individual projects, plans, and other items is managed on each one."), `RoleMatrixTable`, `CompareRoles`, `ResourceAccessNote`, `TransferOwnershipDialog`. `InviteForm`, `RoleChangeDialog`, and `PeopleTable` take `resourceAccessHref` and `resourceAccess` for the item-access section a site adds; `PeopleTable` takes `actions.transferOwnership`.
- `OwnerAlertNotifier.ownershipTransferred`, `OwnershipTransferAlert`, `renderOwnershipTransferEmail`; the SES mailer sends it to both owners in one message.

### Changed

- **Breaking:** the groups. `superadmin` is now Super admin, one rank below the owner; `admin`, `editor`, and `viewer` are retired (refused as app roles and persona groups, with the new name in the message). Deploying the preset deletes those three groups and their memberships; see Migration.
- **Breaking:** `OwnerAlertNotifier.ownerGranted` → `superadminGranted`; `OwnerGrantAlert` → `SuperadminGrantAlert`; `renderOwnerAlertEmail` → `renderSuperadminGrantEmail`; the SES mailer's `renderOwnerAlert` → `renderSuperadminGrant` (and new `renderOwnershipTransfer`); `OWNER_GRANT_NOTE` → `SUPERADMIN_GRANT_NOTE`; `ownerAlerts` may supply either method.
- `listPeople` needs `people.read` (every admin role) instead of `people.manage`, so view-only and content-only admins see the list; every action still checks its own capability. `data.delete` is held by the owner and Super admins.
- The role picker is radio buttons with descriptions instead of a `<select>`; the invite form defaults to Member. An invite as Admin – content & people or Super admin needs a reason.
- Dev personas: one per new role (`defaultPersonas`), and `parsePersonas` refuses more than one owner persona.
- No screen says "record": People-page copy says "item", and the last sign-in gap reads "— not tracked".

### Migration

Map `superadmin` → `superadmin` (and pick one person as the owner), `admin` → `admin-content-people`, `editor` → `admin-content`, `viewer` → `admin-view`. Write down each old group's members before deploying (the deploy deletes `admin`, `editor`, and `viewer`), deploy, add one person to `owner` in the Cognito console (the only break-glass step), then re-grant the rest from the People page. Update the site's capability file, `personas.json`, and the renamed exports above. [ADR 0020](docs/decisions/0020-site-wide-roles.md#migration-from-superadmin--admin--editor--viewer) has the steps.

## [0.1.4-alpha] - 2026-10-18

The invite-expiry sweep keeps the site's last owner. Pre-release.

### Security

- **The invite-expiry sweep never disables the site's last owner** (David's decision). `people.expireStaleInvites()` and `InviteExpirySweep` disabled every invite unused after 7 days, owners included, so a site whose only owner hadn't signed in yet lost its owner. Now an expired owner invite is disabled only while another enabled owner remains (read live with `ListUsersInGroup`, not counting anyone the run tried to disable): with two owners, the unused one is still disabled. The last owner keeps their account and role; the run writes a refused audit row ("skipped: last owner") and warns them ("Your owner invite to {Site} hasn't been used"), plus a separate copy to an optional fallback address, on the first run after the invite expired and then once a day. Non-owner invites expire as before. The owner role is read from `OWNER_GROUP` in the shared policy (today `superadmin`), not named in the sweep. [ADR 0019](docs/decisions/0019-invite-expiry-sweep.md#amendment-2026-10-18-never-the-owner), amended.
- **Fail closed toward keeping the owner.** An owner count the sweep can't read skips the owner (a refused row, `owner_count_unknown`) and fails the run. A due invite whose groups can't be read is skipped and reported too; before, it was disabled as if it had no groups, keeping its roles.

### Added

- `InviteExpirySweep` `ownerWarnings` (`siteName`, `from`, `sesIdentity`, `signInUrl`, `fallbackEmail`, `configurationSet`): the warning's settings, and `ses:SendEmail` from that identity only. Without it, a run that skips a last owner fails (and alarms) instead of emailing.
- `OwnerInviteWarningNotifier` and `renderOwnerInviteWarningEmail`; `createSesInviteMailer` implements `ownerInviteUnused` (one message per recipient), and `createPeopleActions` uses it for `expireStaleInvites`.
- `SweepResult.skipped` (`SweepSkip`: who was warned, and any problem), `OwnerWarningOptions`, `LAST_OWNER_SKIP_MESSAGE`; `createInviteExpirySweep` takes `ownerWarnings` and `runEveryMinutes`.
- `inviteExpirySweepPolicy` takes `sesResourceArns`.

### Changed

- The sweep's role may also call `ListUsersInGroup` (`INVITE_EXPIRY_COGNITO_ACTIONS`). Redeploy the construct for the new permission.
- The scheduled function fails a run whose last-owner skip couldn't warn anyone or be logged, and its log line redacts any address an AWS error message quotes.

## [0.1.3-alpha] - 2026-10-17

Fixes for what the first live deploy (a demo site made from [site-auth-kit-template](https://github.com/davidyokum/site-auth-kit-template)) revealed. Pre-release.

### Security

- **The sign-in screens are the same for every address until a factor is proven.** Under `PreventUserExistenceErrors` an unknown address was never offered emailed codes, while an unused invite can use only emailed codes, and `SignIn` showed Cognito's per-account answer ("Choose how to sign in" with the account's own methods; "Check your email" only when a code was sent). Now an account without the requested factor gets what an unknown address gets: a passkey prompt that finds nothing, "don't match" for a password, or "Check your email" with nothing sent, naming the typed address. **Changed:** `SignIn` has no method chooser and no longer shows Cognito's masked address. New for custom screens: `isFirstFactorUnavailable`, `decoyPasskeyPrompt`, `answerSimulatedCode`. Cognito's responses still differ on the wire; [ADR 0018](docs/decisions/0018-same-screens-for-every-address.md) says what's verified and what to check live.
- **Invite expiry is enforced.** `InviteExpirySweep` (`auth-kit/admin/cdk`): EventBridge Scheduler runs the sweep hourly in a Lambda, as `system:invite-expiry`, writing audit intent and result rows. The function's role may call only `ListUsers`, `AdminListGroupsForUser`, `AdminDisableUser`, and `AdminRemoveUserFromGroup` on its pool, `PutItem` on the audit table, and write its own log; the scheduler's role may only invoke it. Optional alarms on a failed run and a dropped invocation. Its code is a self-contained bundle in the tarball (`dist/lambda/invite-expiry/index.mjs`). [ADR 0019](docs/decisions/0019-invite-expiry-sweep.md).

### Added

- `waf.signInRule` and `waf.overallRule` (`'count'` or `'block'`) on the preset's web ACL and `createSharedAuthWebAcl`. Defaults: the sign-in rule counts, the overall rule blocks. [ADR 0017](docs/decisions/0017-per-rule-waf-modes.md).
- `AuditLogTable.grantAppend` (`PutItem` only), `inviteExpirySweepPolicy` and `INVITE_EXPIRY_COGNITO_ACTIONS`, `INVITE_EXPIRY_ACTOR`.

### Changed

- **Breaking:** `waf.action` is retired (it set both rules); it's refused with a message naming `signInRule` and `overallRule`. The preset's own web ACL now counts sign-in attempts by default instead of blocking them; set `signInRule: 'block'` after a week of counts.
- The sweep and `describeAwsError` moved to their own modules; `auth-kit/admin` exports them as before.

### Fixed

- The preset quotes the pool's sender name when it holds RFC 5322 specials (`formatSender`): unquoted, `Example Site (NC OSBM)` reads as the name "Example Site" plus a comment, which mail clients may drop. A backslash in `email.fromName` is refused.

### Documentation

- The WAF sign-in rule's header match was verified live: Cognito forwards the bare operation name (`x-amzn-cognito-operation-name: InitiateAuth`). README "Count first, then block the sign-in rule"; ADR 0004 and 0013 amended.
- `FactorConfiguration` is hidden by the AWS CLI's `describe-user-pool` but present in the raw API response, and allowed first factors live on the pool, not the app client (ADR 0001). The README's "Verify on the first sandbox deploy" is now "Verified on a live pool, and what's left".

## [0.1.2-alpha] - 2026-10-17

Fixes for the issues found while building [site-auth-kit-template](https://github.com/davidyokum/site-auth-kit-template) (#7–#11). Pre-release.

### Security

- **`TOTPEnrollmentGate` can't mask the server's answer (#7).** It rendered only a status on the server, so around a layout's children it turned a nested page's `notFound()` 404 into a 200. Its children now always render, server and browser, inside a wrapper that's `hidden` until the check passes. New `serverChecked` shows them from the first paint after the page's own guard. The README places the gate inside `/account`, not around a layout. **Changed:** the gate's root element is always present, with the children in a new `content` slot. [ADR 0015](docs/decisions/0015-gate-renders-its-children.md).
- **The proxy drops client-sent `Content-Security-Policy` request headers**, so the nonce Next stamps on scripts only ever comes from the app.

### Added

- **The auth matrix's server mode (#9).** `auth-kit/testing/matrix-server` (dev only, behind a `withDevKit` alias): `matrixServerOverrides()` gives `createServerAuth` the test issuer's keys (with a fetcher that never reaches the pool's JWKS) and a scripted Cognito, and `createPeopleActions` a read-only People client, a refusing mailer, and an in-memory audit log, built per bundle. `startMatrixServer` (in `auth-kit/testing`) runs `next dev` with the fixture and no AWS and returns cookie personas; `matrixFixture`, `matrixServerEnv`, `parseMatrixFixture`. `withDevKit` takes several aliases (`DEV_ALIAS`, `DEV_MATRIX_ALIAS`). `check-prod-build` also fails on the matrix module's marker. [ADR 0016](docs/decisions/0016-matrix-server-mode.md).
- **`withAuthProxy({ headers })` (#11):** request headers for every pass-through and response headers for every response (redirects and refusals too); reserved session, client-address, auth-kit, and Next headers throw. `nonceCspHeaders(policy)` builds a per-request nonce CSP with it. README section on CSP with the proxy.
- **"Couldn't check" in production error boundaries (#10).** `AuthUnavailableError` carries its own `digest` (`AUTH_KIT_AUTH_UNAVAILABLE;<reference>`), which Next keeps when it redacts server errors; `isAuthUnavailableError(error)` (from `auth-kit/client` and `auth-kit/server`) reads it. README `error.tsx` example.
- `AWS_BLOCKED_ENV` in `auth-kit/testing`; auth-kit's own tests run with it, with a canary.
- An end-to-end test on a real Next 16 fixture app (`npm run test:e2e`, in CI): build, the full matrix on `next dev`, `next start`.

### Fixed

- **The origin check under `next dev` (#8).** Next rewrites `request.url`'s host to `localhost`, so without `expectedOrigin` every POST from `app.localhost` or `127.0.0.1` failed with `origin_mismatch`. In development only, with `request.url` and `Host` both loopback, the browser's origin (`Host`) counts too. A configured `expectedOrigin` still wins, and the README now sets it in every environment.
- **README (#10):** the admin example's step-up link is `signInUrl('/admin/people', { reauth: true })` (it used `?step-up=1`, which the sign-in page doesn't read, with no return path); the template is linked instead of "coming later".

## [0.1.1-alpha] - 2026-10-17

Phase 2 of `auth-kit/client` and `auth-kit/dev`, and the fixes from the [2026-10-17 security review](docs/reviews/2026-10-17-fable-review.md). Pre-release; some APIs changed (marked **Breaking**).

### Security

- **Auth matrix checks each route's own guard (H1).** Every case also runs with the proxy stepped aside (honored only outside production builds, with `AUTH_KIT_MATRIX=1`, on a localhost URL), so a route relying on the proxy for its 401 fails. **Breaking:** `appRoutes` is required (`routesFromNextBuild()` reads Next's build manifests); uncovered and mistyped routes fail; each row must expect some persona to succeed. New: `expectWithoutProxy`, `exists: false`, `handlerRequest`. ADR 0014.
- **Server-side refresh only for genuine expired sessions (M1).** The proxy refreshes only an Amplify cookie session whose access token is signed by this pool for this client and merely expired, with a refresh-token cookie; never anonymous, forged, or bearer requests. Refreshes are limited per person and per instance, back off after failures, and are shared by concurrent requests (`refreshLimits`, `onRefresh`). Tokens that merely expired are now 401 `token_expired`.
- **Secure server-written token cookies (M2).** `amplifyCookieRuntimeOptions` sets `secure: true` explicitly (`localDevOrigin` drops it for http://localhost only). Browser-written cookies get the same lifetime from `configureAuthClient`.
- **Default-deny can't be configured away (M3).** `publicRoutes` that match everything (`'/*'`, catch-all RegExps) or unanchored RegExps throw at startup; malformed paths and unknown options throw.
- **Release tarballs (M4).** **Breaking:** install from the attested release tarball, not `github:`; the `prepare` script is gone. Dependabot added. ADR 0012.
- **Low items.** Token claim shape and time policy checked, `NaN` cache lifetimes refused, authenticator cache keyed by person and token (L1); cookie parsing matches Next's (L2); public routes overwrite `x-auth-kit-path` (L5); **Breaking:** `getUser()` applies the authenticator rule (L6); `expectedOrigin` for the origin check (L7); stricter preSignUp address parsing (L8).

### Added

- `auth-kit/client` (phase 2): `SignIn` (passkey first, password + TOTP, emailed code; every challenge the standard's pools return; step-up), `ChooseFirstCredential` (first sign-in after an invite), `AuthenticatorSetup`, `TOTPEnrollmentGate`, `MyAccount` (passkeys with a last-way-in guard, authenticator, password, sign out everywhere), `PasswordForm` with a Have I Been Pwned range check, `configureAuthClient` (token cookies expire with the refresh token), and the Amplify calls behind them as functions. Unstyled, accessible markup with `data-auth-kit` slots and `classNames`. [ADR 0008](docs/decisions/0008-client-in-the-browser.md) records where Amplify v6 differs from the standard.
- `auth-kit/dev` (phase 2): `personas.json` in the primer's shape and `parsePersonas`; `seedPersonas` and `npx auth-kit init-personas` / `seed-personas` (refuses anything but a sandbox pool, asserts the account from the pool's ARN, converges users, passwords, groups, and authenticators, idempotent, secrets only in git-ignored `.env.local`); `createDevKit` with the "Sign in as…" route (request gates including `127.0.0.1`/`[::1]` and a proxy-header gate, same-site writes, a check of the dev server's listening sockets, a cached sandbox check, 404 on every refusal, Amplify's own cookies); `withDevKit` for `next.config.ts`; `checkProductionBuild`, `checkDevRouteAbsent`, and `npx auth-kit check-prod-build` / `check-dev-route`. Personas are enrolled in TOTP so the authenticator rule holds ([ADR 0009](docs/decisions/0009-localhost-kit.md)).
- `auth-kit/dev/menu`: `PersonaMenu`, the dev-only "Sign in as…" menu.
- `auth-kit/ribbon`: `EnvironmentRibbon`, `ViewAsBanner`, `environmentMetadata`, `viewAsMetadata`, `resolveEnvironment` (safe in production builds).
- The `auth-kit` command (`bin`).
- `auth-kit/admin`: `createPeopleActions` (list, invite, resend, change role, disable, re-enable, sign out everywhere, delete, invite expiry, Activity, FormData adapters), each checked live and guarded, with step-up for grants and deletes; `createDynamoAuditLog` and `createMemoryAuditLog` (append-only: conditional `PutItem` and `Query` only); `runAudited` and `recordChange` (intent → calls → result); `createInviteExpirySweep`; `createSesInviteMailer`; a Cognito quota limiter with backoff; IAM policy builders.
- `auth-kit/admin`: owners may make owners, but each owner grant needs a recent sign-in and alerts every owner (`ownerAlerts`, default the SES mailer's `ownerGranted`); with no notifier it's refused, and if the alert fails the grant is undone.
- `auth-kit/admin/ui`: `PeopleTable`, `InviteForm`, `RoleChangeDialog`, `ActivityLog`, `LostPasskeyGuide`.
- `auth-kit/admin/cdk`: `AuditLogTable` (deletion protection, point-in-time recovery, stream, a resource policy denying item edits, optional tamper alerts).
- Shared web ACL: `waf: { webAclArn }`, `createSharedAuthWebAcl`, `associateAuthWebAcl`. **Breaking:** `waf: false` requires `acknowledgeNoRateLimit: true`; `waf.enabled` is retired; `AppliedAuthStandard.webAcl` became `waf`. ADR 0013.
- `createServerAuth` validates its options at startup; `requireUser` reports `invalid_token` / `token_expired`.

### Changed

- `auth-kit/client`: the phase-1 stubs are replaced. `SignInScreen` is now `SignIn`, `AuthenticatorEnrollmentGate` is `TOTPEnrollmentGate`, sign-in functions return a `SignInStep`, and `NotImplementedError` is no longer exported from this subpath.
- `DEV_POLICY.route` is `/api/dev/sign-in`. `personas.json` entries use `key`/`email`/`groups` instead of `role`/`appRoles`. `checkProductionBuild` returns a result instead of rejecting. `auth-kit/dev` gains a `default` export condition so `next.config.ts` can load it.
- `auth-kit/admin`: `checkPeopleAction` matches role names exactly against the known set, treats any owner count that isn't a whole number ≥ 0 as a refusal, and checks the target's state; `inviteStatus` understands the admin pool's temporary-password invites and treats an unreadable creation date as expired.

### Fixed

- `auth-kit/amplify`: the app client no longer ships Amplify's hosted-UI OAuth code flow with CDK's placeholder callback (`https://example.com`). OAuth stays on only when the site configured real callback URLs; `applyAuthStandard` reports `hostedUiOAuth`.

## [0.1.0-alpha] - 2026-10-17

First pre-release. Not yet used in production.

### Added

- `auth-kit/amplify`: `standardAuthProps` and `applyAuthStandard`, a Gen 2 preset for one pool per app. Invite-only; passkey (user verification required, counts as MFA), password (15+ characters, no composition rules), and emailed code as first factors; MFA optional with TOTP (required, with no emailed codes, for `adminPool`); access and ID tokens 60 minutes, refresh 30 days (Tier 2) or 1 day (Tier 3 and admin pools), sign-in session 3 minutes; token revocation; deletion protection; SES from a verified domain identity; standard groups plus app roles; no guest credentials; Plus threat protection on Tier 3; a WAF web ACL with per-IP sign-in and overall rate rules; sandbox detection (`Environment=sandbox` tag, `ALLOW_ADMIN_USER_PASSWORD_AUTH` on sandbox clients only, no deletion protection or web ACL by default).
- `auth-kit/amplify/pre-sign-up`: `preSignUpAllowlist`, a dependency-free preSignUp handler for domain-allowlisted self-registration.
- `auth-kit/server`: `createServerAuth` with `getUser`, `requireUser` (refuses password users without TOTP), `requireGroup`, `requireCan` (with `live` re-reads and `recentSignIn` step-up), `requireRecordAccess` (404), `verifyAccessToken`; `defineCapabilities`; `safeRedirect`; cookie, origin-check, and no-store helpers; error classes and `withAuthErrors` for the 401/403/404/503 conventions; page guards.
- `auth-kit/proxy`: `withAuthProxy` (default-deny, verifies tokens, public-route allowlist) and `amplifyAdapterRefresh`.
- `auth-kit/testing`: `assertAuthMatrix` and friends, `createTestIssuer`, `amplifyCookiePersona`, `createFakeCognito`, token forgery helpers.
- `auth-kit/admin`: People-page guardrails (`checkPeopleAction`, `grantableRoles`, `inviteStatus`) and typed stubs for the actions and the append-only audit log.
- `auth-kit/dev`: dev sign-in gates, `assertSandboxPool`, persona validation, the ribbon model, and typed stubs for seeding, the sign-in exchange, the ribbon component, and the production-build check.
- `auth-kit/client`: autocomplete tokens, `afterSignInStep`, and typed stubs for the sign-in screens and My account.
- Decision records, CI (typecheck, lint, test, build on Node 22 and 24).

[0.1.3-alpha]: https://github.com/davidyokum/auth-kit/releases/tag/v0.1.3-alpha
[0.1.2-alpha]: https://github.com/davidyokum/auth-kit/releases/tag/v0.1.2-alpha
[0.1.1-alpha]: https://github.com/davidyokum/auth-kit/releases/tag/v0.1.1-alpha
[0.1.0-alpha]: https://github.com/davidyokum/auth-kit/releases/tag/v0.1.0-alpha
