# 0003. Code checks capabilities, mapped from groups in one file

- **Status:** Accepted, 2026-10-17
- **Standard:** 03 §2 Roles and lifecycle, Admin area; primer §7, §9

## Context

The audit found seven spellings of "admin" and role names scattered through routes. Splitting a role later (content admins from people admins) meant hunting through every route.

## Decision

- Roles come only from Cognito groups: `superadmin` (shown as Owner), `admin`, `editor`, `viewer`, then the app's own roles. The preset creates them in that order (that's their precedence).
- Each app keeps one capability file, built with `defineCapabilities`, that maps groups to dotted capabilities (`content.edit`, `people.manage`, `reviews.comment`). Routes call `requireCan('people.manage')`, never `groups.includes('admin')`.
- Capability names are type-checked: a typo is a compile error. `defineCapabilities` refuses a capability that reuses a group name.
- Unknown groups grant nothing. The standard map gives editors content only, admins People on top, and owners alone security settings, exports, and deletion.

## Consequences

- Splitting or renaming a role is a change to one file.
- `requireGroup` remains for coarse gates, but `requireCan` is the default.
- A role still doesn't say whose record it is; routes that take a record ID add `requireRecordAccess`, which answers 404.
