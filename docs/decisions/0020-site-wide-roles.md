# 0020. Site-wide roles: one owner, an explicit admin ladder, members per-item

- **Status:** Accepted, 2026-10-18 (David's decision). Supersedes the role list in [0003](0003-capabilities-not-roles.md) and the owner grants in [0011](0011-people-actions.md).
- **Standard:** 03 §2 Roles and lifecycle, Admin area; passwords-flow `06-roles-and-resource-access.md`

## Context

The first ladder was `superadmin` (shown as Owner), `admin`, `editor`, `viewer`, and owners could make other owners. Two things were wrong with it. "Owner" was a group anyone at the top could hand out, so a site could have any number of owners and none of them was accountable for it; and the names said nothing about what each role could touch ("editor" of what? does "viewer" see the admin area?). Separately, what a member can do with their own projects, plans, and other items is a different question from who runs the site, and the ladder was starting to be stretched to answer it.

## Decision

**Two layers.** Site-wide admin roles (this record) decide who runs the site. Resource roles (Manager, Contributor, Reader, attached to one item; built next) decide who can do what to one project, plan, or other item. On any item a person gets whichever of the two allows more. These roles never stand in for resource access.

**The ladder.** Each role includes everything below it. Groups are created in this order, which is their precedence.

| Label (exact, on screens) | Group | Capabilities (`STANDARD_CAPABILITIES`) |
|---|---|---|
| Owner (only one) | `owner` | everything below, plus `owner.private` (owner-only pages) and `owner.transfer` (Transfer ownership) |
| Super admin | `superadmin` | everything below, plus `settings.security`, `data.export`, `data.delete` |
| Admin – content & people | `admin-content-people` | everything below, plus `people.manage`, `roles.manage` (roles below their own) |
| Admin – content only | `admin-content` | everything below, plus `content.edit`, `content.publish` (any content, site-wide) |
| Admin – view only | `admin-view` | `content.read`, `people.read`, `audit.read`: see everything in the admin area, change nothing |
| Member | (no group) | none; access to items comes from resource roles |

The labels use an en dash. Each role has a one-line "can" and "can't" (`ROLE_DESCRIPTIONS`), and `ROLE_MATRIX` is the comparison UIs show ("View everything", "Edit any content", "Manage people", "Security, exports, deletion", "Owner-only pages"), built from the capability map so it can't drift from what the server enforces.

**Grants** (`checkPeopleAction`, run by every People action and by the UI to decide what to offer):

- You grant, and act on, only roles below your own. So only the owner grants Super admin, and a Super admin can't manage another Super admin (only the owner can).
- Nobody changes their own role, disables, or deletes themselves.
- The owner role is never granted, by invite or role change, not even by the owner (`owner_transfer`). It moves only by **Transfer ownership**.
- Nobody disables, demotes, or deletes the owner (`last_owner`). The invite-expiry sweep never disables the last owner either ([0019](0019-invite-expiry-sweep.md)); it warns them instead.

**Transfer ownership** (`people.transferOwnership`): the owner only (the `owner` group itself, whatever an app's map grants), to an enabled account that has signed in (an unused invite would hand the site to whoever controls that inbox), with a reason, the new owner's address typed out, and a sign-in in the last five minutes. The new owner keeps their app roles and their admin role becomes Owner; the previous owner becomes Super admin. Calls run in an order that never leaves the site without an owner: add the new owner to `owner`, remove their old admin role, add the previous owner to `superadmin`, remove the previous owner from `owner`. Then one email goes to both (`ownershipTransferred`); if it can't be sent, the transfer is undone in the same safe order (previous owner restored before the new one is removed). A failure partway can leave two owners, never none. Intent and result go in the audit log as `people.transferOwnership`.

**Super admin grants** alert the owner (`superadminGranted`, every enabled member of `owner`, read live after the grant), need a recent sign-in, and are undone if the alert can't be sent. With no notifier configured the grant, like a transfer, is refused before anything changes.

**Exactly one owner, and what happens when there isn't.** The People table counts enabled owners and flags anything but one. Zero: nobody can grant Super admin or transfer ownership, and the owner role can't be granted in the app, so the fix is the break-glass path (add one person to `owner` in the Cognito console). More than one (a partial transfer, a console edit): an owner may change another owner's role while the live count is two or more; an unknown count is a "no".

**Screens never say "record" or "resource".** The note under every role picker is exactly: "These roles are for running the site. Access to individual projects, plans, and other items is managed on each one." (`RESOURCE_ACCESS_NOTE`). In code the term is "resource": the picker's slot and link props are `resourceAccess` and `resourceAccessHref`, for the resource-roles section that comes next.

## Where the decision left room, and what was chosen

- **Admin – view only reads the audit log.** Yes, read-only: "see everything in the admin area" includes Activity. Because the ladder is strict, Admin – content only reads it too.
- **`people.read` is new.** "See everything in the admin area" includes the People list, which needed `people.manage` before. `listPeople` now needs `people.read` (every admin role); every action still needs its own capability, so view-only and content-only admins see the list with no actions.
- **Super admins don't manage other Super admins.** Only the owner does (rank: you act only below your own level).
- **Transfer needs someone who has signed in, and may go to a member.** An enabled account with a used invite, at any role, Member included.
- **The previous owner becomes Super admin**, keeping any app roles.
- **A failed ownership alert undoes the transfer**, the same rule as Super admin grants: a change neither party was told about doesn't stand.
- **The repair path for more than one owner** (an owner demotes the extra) exists so the flag is actionable; it can only move toward one owner, never to none.
- **Reasons:** every role change, every transfer, every delete, and any invite as Admin – content & people or Super admin. The invite form defaults to Member, the least access.
- **Retired names are refused** (`RETIRED_GROUPS`): `admin`, `editor`, and `viewer` can't be app roles or persona groups, so a migrating site can't keep one by accident as a role with no rank.
- **Group names are lowercase with hyphens.** Cognito group names allow them, Amplify's `defineAuth` validator accepts them, and CDK logical IDs stay distinct.

## Migration from `superadmin` / `admin` / `editor` / `viewer`

Map: `superadmin` → `superadmin` (and pick one person to be the owner), `admin` → `admin-content-people`, `editor` → `admin-content`, `viewer` → `admin-view`.

Deploying the new preset changes the pool's groups: CloudFormation creates `owner`, `admin-content-people`, `admin-content`, and `admin-view`, keeps `superadmin` (its precedence moves from 0 to 1), and **deletes `admin`, `editor`, and `viewer`, and their memberships with them**. So:

1. Before upgrading, write down who holds each old group (Cognito console, or `aws cognito-idp list-users-in-group --profile <the site's profile> --user-pool-id … --group-name admin`, and so on).
2. Upgrade auth-kit and update the site: its capability file (keys from `STANDARD_CAPABILITIES`; app capabilities that were on `admin` go on `admin-content-people` and, by spreading, above it), `personas.json` (one persona per new role, exactly one owner), any `amplify_outputs.json` placeholder, and code that used the renamed exports below. Deploy.
3. Make one person the owner: add them to `owner` in the Cognito console (the one break-glass step; nobody can grant the owner role in the app) and remove them from `superadmin`.
4. From the People page, re-grant the others by the map (each grant is audited; Super admin grants alert the owner).
5. Until step 4, people who held `admin`, `editor`, or `viewer` are members. On a site in daily use, do steps 3 and 4 right after the deploy.

Renamed or changed for code: `ownerGranted` → `superadminGranted` and the new `ownershipTransferred` (`OwnerAlertNotifier`); `OwnerGrantAlert` → `SuperadminGrantAlert`; `renderOwnerAlertEmail` → `renderSuperadminGrantEmail` and `renderOwnershipTransferEmail`; the SES mailer's `renderOwnerAlert` option → `renderSuperadminGrant` and `renderOwnershipTransfer`; `OWNER_GRANT_NOTE` → `SUPERADMIN_GRANT_NOTE`; `listPeople` needs `people.read`; an admin layout gated on `people.manage` can use `people.read` so view-only admins can enter.

## Consequences

- Every site has one accountable owner, and handing a site over is one deliberate, audited, two-party-notified action.
- The labels say what each role touches, and the picker shows it, so choosing a role doesn't need a manual.
- Members' access to items is out of these roles entirely; resource roles come next and combine with them (the site role is a floor everywhere).
- A site with zero owners needs the break-glass path. That's deliberate: the alternative is an in-app way to create an owner, which is the hole this decision closes.
