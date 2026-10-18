# 0003. Code checks capabilities, mapped from groups in one file

- **Status:** Accepted, 2026-10-17. The role list was replaced on 2026-10-18 by [0020](0020-site-wide-roles.md) (one owner and an explicit admin ladder); the rest stands.
- **Standard:** 03 §2 Roles and lifecycle, Admin area; primer §7, §9

## Context

The audit found seven spellings of "admin" and role names scattered through routes. Splitting a role later (content admins from people admins) meant hunting through every route.

## Decision

- Roles come only from Cognito groups: the standard roles, then the app's own roles. The preset creates them in that order (that's their precedence). The standard roles were `superadmin` (shown as Owner), `admin`, `editor`, `viewer`; since [0020](0020-site-wide-roles.md) they're `owner`, `superadmin`, `admin-content-people`, `admin-content`, `admin-view`.
- Each app keeps one capability file, built with `defineCapabilities`, that maps groups to dotted capabilities (`content.edit`, `people.manage`, `reviews.comment`). Routes call `requireCan('people.manage')`, never `groups.includes('admin')`.
- Capability names are type-checked: a typo is a compile error. `defineCapabilities` refuses a capability that reuses a group name.
- Unknown groups grant nothing. The standard map keeps content and people as separate keys; [0020](0020-site-wide-roles.md) has the current ladder.

## Consequences

- Splitting or renaming a role is a change to one file.
- `requireGroup` remains for coarse gates, but `requireCan` is the default.
- A role still doesn't say whose record it is; routes that take a record ID add `requireRecordAccess`, which answers 404.
