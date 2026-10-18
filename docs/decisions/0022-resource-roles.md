# 0022. Resource roles: Manager, Contributor, Reader, combined with site roles

- **Status:** Accepted, 2026-10-18 (David's decision). The second layer of [0020](0020-site-wide-roles.md).
- **Standard:** 03 §2 Enforcement ("record-ID routes check the record"), Roles and lifecycle; passwords-flow `06-roles-and-resource-access.md`

## Context

[0020](0020-site-wide-roles.md) settled who runs the site. What a member can do with one project, plan, or grant was left to `requireRecordAccess(user, record, { owner, members, coveredBy })`: each app stored owners and member lists its own way, there were no roles on an item, nothing was audited, and there was no screen for sharing. David's decision: one vocabulary on every site, attached to one item, that adds to the site role there.

## Decision

**Three roles on one item.** "Resource" is the term in code and docs (as in AWS IAM, Amazon Verified Permissions, and OAuth); screens never show it, or "record": they use the app's noun ("Who has access to this project", "Share this plan").

| Role | Can (on this item) | Can't |
|---|---|---|
| Manager | See and edit it, choose who has access, invite someone new to it | Remove the last Manager; reach anything outside the item |
| Contributor | See and edit it | Change who has access |
| Reader | See it | Edit it or change who has access |

Rank: Manager > Contributor > Reader. Several Managers are allowed; every item keeps at least one.

**Actions.** `view`, `edit`, `manage-access`, `invite` (`RESOURCE_ACTIONS`). Defaults: Reader `view`; Contributor `view`, `edit`; Manager all four. An app may override them per resource type (`defineResourceTypes`), and add its own actions (`comment`), within rules checked at startup: every role can view; each role holds everything below it; `manage-access` and `invite` are Manager-only; Managers always keep `manage-access`.

**The combining rule.** An action on an item is allowed when **either** the person's site role grants it on every item **or** their role on that item grants it. The site floor is by capability (`RESOURCE_SITE_FLOOR`), so it follows the app's one capability map:

| Site role | On every item |
|---|---|
| Owner, Super admin, Admin – content & people | view, edit, manage access, invite (`people.manage`) |
| Admin – content only | view, edit (`content.edit`) |
| Admin – view only | view (`content.read`) |
| Member | nothing: access comes from resource roles |

`RESOURCE_ACCESS_MATRIX` is this table plus the three resource roles, built from the constants the server uses, for screens and docs.

**The check.** `auth.requireResourceRole(type, id, need)`, where `need` is an action (`'edit'`) or a minimum role (`'contributor'`: every action a Contributor has on that type, so Admin – content only passes it and Admin – view only doesn't). Someone who can't **see** the item gets 404, the same answer as an item that doesn't exist; someone who can see it but not do this gets 403; memberships that can't be read are 503 (never a pass). `resourceAccess` gives the same answer without refusing (for showing an Edit button), `listMyResources(type)` gives "my items" (`mine`: the person's own; `all`: a site role that sees every item, or a shared directory, so the app lists from its own store), and `pages.requireResourceRole` renders the not-found page for 403 and 404.

**Where memberships live.** `ResourceAccessTable` (`auth-kit/admin/cdk`): partition `resource#<type>#<id>`, sort `person#<sub>` (role, added by, added at, and an email and name for display only), plus one access record per item (sort `meta`) holding a version and the Manager count; a `byPerson` index for "my items". On-demand, point-in-time recovery, deletion protection, retained on stack delete, a resource policy denying `DeleteTable`. The app's role gets `GetItem`, `PutItem`, `DeleteItem`, and `Query` on that table and its index, nothing else (`grantApp`, or `resourceAccessAppPolicy` as JSON). Every change to one item's access is one `TransactWriteItems` (authorized as `PutItem` and `DeleteItem`) that writes the access record conditioned on the version it read, so two Managers acting at once can't leave an item without a Manager: the second gets "changed since the page loaded". Access checks read consistently. `createMemoryResourceStore` has the same rules for tests and the auth matrix (`matrixServerOverrides().resources`).

**Changes** (`createResourceActions`, `auth-kit/resources`), each re-reading the acting person live, then the item's access, then the guardrails (`checkAccessChange`, shared with the UI), then the audit intent row, the transaction, and the result row ([0010](0010-audit-log-intent-then-result.md)); refusals by someone who can see the item are logged:

- `add` (an existing account, by email), `grant` (add or change; a no-op when nothing changes, for APIs), `changeRole`, `remove` (or leave: anyone with a role may leave). Adding, changing, and removing someone else need `manage-access`.
- **The last Manager** can't be removed, demoted, or leave. A site admin whose role manages access may do it by naming the new Manager in the same step (`replaceWithEmail`: an existing member promoted, or an account added), in the same transaction.
- **A Manager invites someone new** (`invite`, needs `invite`): the People page's invite flow (shared code in `src/admin/invite-core.ts`) with **no admin role**, then the membership, then an alert to the site's admins (`ResourceInviteNotifier.resourceInviteSent`; the SES mailer implements it), then the invite email, which says who invited them and to what. No notifier configured: refused before anything changes. Alert or email fails: the membership and the account are removed again and nothing stands.
- **Create** (`create`): admins whose site role manages access create items and choose the first Manager (default: themselves); with the type's `selfServiceCreate`, any signed-in person creates one and becomes its Manager (and only them). The app's own item is created inside the same audited change (`run`), and if it fails the access is removed again.
- **Delete** (`deleteResourceAccess`): removes everyone, in transactions under DynamoDB's 100-item limit, needing `manage-access` (or the action the app names).
- **Disable** (`removeResourceMemberships`, for `createPeopleActions({ removeResourceMemberships })`): removes every membership the person has. Disabling is never blocked: items left without a Manager are listed in the disable row (`after.resourceMemberships.leftWithoutManager`), the panel flags them, and admins who manage people can still manage them.

**Per-type switches**, both off by default: `selfServiceCreate` (above) and `sharedDirectory` (every signed-in person may see, list and open, every item of the type, read-only). Off, members see only their own items.

**Screens** (`auth-kit/resources/ui`): `WhoHasAccess` for one item, with the noun as a prop: role chips, add by email with a role picker that gives each role's can and can't, the invite flow (an address with no account turns "Add" into "Invite"), remove and leave, the last-Manager messages, the note "Site admins can also see and edit this {noun} (view-only admins can only see it).", and honest failure ("—" and why). `ResourceRolesSummary` fills the site role picker's `resourceAccess` slot ([0020](0020-site-wide-roles.md)) with the three roles and how they combine; `ResourceAccessTable` is the comparison.

## Where the decision left room, and what was chosen

- **403 for someone who can see it.** "Never reveal the item exists" protects people who can't see it; they get 404. Someone who can see it (a Reader, Admin – view only, a shared directory) already knows, so they get 403, and pages show not-found for both.
- **The floor is by capability, not group,** so a site that gives an app role `content.read` gets the floor for it too, and the rule reads from the one capability map. An app's own action shares `edit`'s floor unless its type says otherwise (`customActionFloor`: a standard action's, or `none`).
- **Who creates items: the admins who manage access.** Creating an item includes choosing who manages it, which is managing access, so by default it takes Admin – content & people or above; Admin – content only creates items only where the type has `selfServiceCreate` (then as their own Manager).
- **Who's alerted about an invite:** everyone enabled in a group whose capabilities include `people.manage` (with the standard map: the owner, Super admins, Admin – content & people), read live; an app can supply its own list. Nobody to alert: refused.
- **An invite that can't be fully done is undone,** the alert as for Super admin grants (a change nobody was told about doesn't stand) and the email too, unlike the People page's invite: a Manager has no Resend button, so a half-made invite would be stuck.
- **Pickers default to Reader** for add and invite, the least access, as the People page's invite defaults to Member.
- **Access changes read the acting person live** (status and groups from Cognito), as the People actions do, so a demoted admin loses the floor at once. Plain checks use the token's groups unless the route passes `live: true`.
- **Anyone who can see an item sees who has access to it** (read-only for non-Managers): a Reader can tell whom to ask.
- **Audit rows name the person and the item:** `target: { sub, email, recordId: '<type>:<id>' }`, so the Activity page's person filter shows someone's item access next to their site roles. The audit table's target index keys on the person; an item's access history is the `resources.` action filter, and its current access is the membership table.
- **A membership keeps the email and name it was given with,** for display only (refreshed by any change to it), so the panel doesn't spend the account's shared Cognito read quota on every view. Access never depends on it.
- **The invite-expiry sweep doesn't touch memberships.** A disabled invite can't sign in, so its membership grants nothing; it shows on the panel until a Manager removes it.
- **An optimistic version lock, not counters.** One condition on one item per change gives the last-Manager guarantee without `UpdateItem` or `ConditionCheckItem`, so the app's grant stays at four item actions.
- **At most 500 people per item** (`RESOURCE_POLICY.maxMembersPerResource`), so one item's access is one Query.

## Later: Amazon Verified Permissions (Cedar)

Not built. The same model maps onto Cedar without changing apps: principals are people (with their Cognito groups as parents), resources are typed entities (`Project::"p-1"`), the three roles are relations on each resource, and the rule is two policy groups: `permit (principal in Group::"admin-content", action in [Action::"view", Action::"edit"], resource);` for the floor, and `permit (principal, action in [Action::"view", Action::"edit"], resource) when { principal in resource.contributors };` (and the like) for roles. `requireResourceRole`, `resourceAccess`, and the actions' guardrails are the only places that decide; moving to Verified Permissions replaces `decideResourceAccess` and the membership read with an `IsAuthorized` call (memberships passed as entities, or kept in Verified Permissions), and apps keep the same calls and the same 404/403. Not now: a paid call and a network hop on every check, another service to configure per site, and checks that can't run in local tests without AWS.

## Migration

- `requireRecordAccess(user, record, rule)` → `requireResourceRole(type, id, need)`. The old method and `RecordAccessRule` still work, unchanged and marked deprecated, for one release. An app that kept `ownerSub` on its records: deploy `ResourceAccessTable`, give each owner a Manager membership (a one-time script through `create`, or the store's `commit`), replace each check, and replace a `coveredBy` capability with the site floor (or an app action with its own floor).
- `PeopleAdminConfig.removeRecordMemberships` → `removeResourceMemberships`; the old name is accepted for one release (both at once, if different, is refused). The disable row's `after.recordMemberships` is now `after.resourceMemberships`.
- New exports: `auth-kit/resources` and `auth-kit/resources/ui`; `ResourceAccessTable` in `auth-kit/admin/cdk`; `resourceAccessAppPolicy`, `renderResourceInviteAlertEmail`, and the SES mailer's `resourceInviteSent` in `auth-kit/admin`; `requireResourceRole`, `resourceAccess`, `listMyResources`, and the `resources` option in `auth-kit/server`; `resources` in the matrix server's overrides.

## Consequences

- Every site has the same words for item access, and one table, one check, one panel, and one audit trail behind them.
- One more table per site, with point-in-time recovery: near zero cost at these sizes.
- The site floor is coarse on purpose: an admin who edits content edits every item. A site that needs an item admins can't see needs a type whose actions withhold the floor (`customActionFloor: 'none'` for its own actions) or a different design; the standard actions always keep it.
