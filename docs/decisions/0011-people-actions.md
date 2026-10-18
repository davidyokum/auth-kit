# 0011. People actions: live checks, exact roles, owner grants, two invite modes, and where the primer was unclear

- **Status:** Accepted, 2026-10-17. Owner grants are superseded by [0020](0020-site-wide-roles.md) (2026-10-18): the owner role is never granted, it moves only by Transfer ownership, and the alert is now for Super admin grants, to the owner. Ranks and role names below are the old ones.
- **Standard:** 03 §2 Admin area, Roles and lifecycle; primer §8, §9, Chapter 7

## Decision

**Every action**, in order: `requireCan(<capability>, { live: true })` (status and groups re-read from Cognito); input checks (server actions take untrusted input); the target re-read (`ListUsers` by `sub`, `AdminListGroupsForUser`); `checkPeopleAction` with a live count of enabled owners; a recent sign-in when needed; then the audited calls ([0010](0010-audit-log-intent-then-result.md)).

**Guardrails** (`checkPeopleAction`, pure and shared with the UI):

- Capabilities: `people.manage` (invite, resend, disable, re-enable, sign out), `roles.manage` (change role), `data.delete` (delete, owners only).
- Grant and act only below your own rank; owners may make owners. Nobody changes their own role, disables, or deletes themselves.
- The last enabled owner can't be demoted, disabled, or deleted. An owner count that isn't a whole number ≥ 0 (unreadable, NaN, negative) is a refusal.
- Role names match exactly: a standard group, `member`, or one of the app's capability-map groups. "Admin", " admin", and "owner" are refused, not normalized.
- State: resend only an unused invite (it never touches an active account), re-enable only a disabled account, delete only a disabled one. Re-enabling an expired invite is refused, because the next sweep would undo it.

**Reasons and step-up.** A reason is required for every role change, every delete, and an invite that grants admin or owner; optional elsewhere ("disabling is one click"). A recent sign-in (`SESSION_POLICY.stepUpMaxAgeSeconds`, 5 minutes) is required for any grant (a promotion or an invite with an admin role) and for delete.

**Owner grants** (David's decision, 2026-10-17). Owners may make other owners, by role change or by invite. Each grant needs (1) a recent sign-in, always, through `requireRecentSignIn` (Cognito's access token doesn't say which method was used, so "ideally a passkey" can't be enforced server-side), and (2) an alert to every current owner, read live after the grant so the new owner is included. The alert is pluggable (`ownerAlerts`); by default it's the SES mailer's `ownerGranted`, one message from the site's sender to all owners. With no notifier the grant is refused before anything changes. If the alert fails, the grant is undone (the new owner role removed and the old roles restored, or the just-created invite deleted), because an owner grant nobody was told about shouldn't stand. The result row records the alert as a call (`Owner alert (n owners): ok`) and its recipients under `after.ownerAlert`. Admins still grant only editor and viewer.

**Invites.** `emailed-code` (everyday pools): `AdminCreateUser` with no password and no `email_verified`, `MessageAction: SUPPRESS`, then the app's own SES email; accepted means `email_verified`. `temporary-password` (the Tier 3 admin pool, which has no emailed codes): Cognito emails a one-time password the app never sees; accepted means the status left `FORCE_CHANGE_PASSWORD`; resend is `MessageAction: RESEND`. The 7-day clock runs from `UserCreateDate` and never resets. A pool that hands an "emailed-code" invite a password is a misconfiguration: the account is rolled back and the action says why.

**Delete** needs the address typed out and waits out a retention period after the disable (default 90 days, from the audit log). A never-used invite has nothing to retain.

**Lists.** The People page reads a `ListUsers` snapshot joined with `ListUsersInGroup` for each known group, never `AdminGetUser` per row (per-person reads are billed and rate-limited), within an in-process budget of about a third of each shared quota, with backoff and jitter on throttling. Failures show "—" and the reason.

## Where the primer was unclear or contradicted itself

- §9's role table says admins "change roles up to admin"; its own rule ("grant only roles below your own") and the Chapter 7 mock say only owners make admins. Implemented: admins grant editor and viewer.
- Chapter 7 says step-up after 15 minutes; `SESSION_POLICY` and the README say 5. Implemented: 5 (the server's setting).
- The Chapter 7 mock asks for a recent sign-in only for admin and owner invites; 03 §2 calls granting any role risky. Implemented: any grant.
- §9 requires reasons for role changes; the mock also requires them for disable and re-enable, which conflicts with "disabling is one click". Implemented: role changes, deletes, and admin invites.
- The retention period before delete has no number in the standard; the mock implies 90 days.
- "Written in the same transaction as the change" isn't possible across Cognito and DynamoDB; see [0010](0010-audit-log-intent-then-result.md).
- The phase-1 stub said the IAM policy grants `PutItem` "conditioned on `attribute_not_exists`"; IAM can't express that condition.
