# 0019. Invite expiry runs hourly, from a Lambda bundled in the package

- **Status:** Accepted, 2026-10-17
- **Standard:** 03 §2 Roles and lifecycle ("An invite with no sign-in after 7 days is disabled")

## Context

An invite is a live account from the moment it's created: anyone who controls that inbox can sign in with an emailed code. auth-kit had the sweep (`createInviteExpirySweep`: disable every unaccepted invite older than 7 days, remove its admin roles, log each as intent → calls → result) and the README said "schedule it daily", but nothing scheduled it. The 2026-10-17 demo sent a real invite saying it expired on a date nothing enforced.

## Decision

- **`InviteExpirySweep`** in `auth-kit/admin/cdk`, next to `AuditLogTable`: EventBridge Scheduler, in a schedule group of its own, invokes a Lambda function that runs the sweep as `system:invite-expiry` (the Activity page shows "Scheduled job").
- **Hourly by default**, so an unused invite is disabled within an hour of its seventh day. A `rate` between 10 minutes and a day, or a `cron`, can replace it; anything slower is refused. Each run costs one `ListUsers` page per 60 accounts, spent against auth-kit's share of the account's Cognito quota.
- **Least privilege.** The function's role may make `ListUsers`, `AdminListGroupsForUser`, `AdminDisableUser`, and `AdminRemoveUserFromGroup` on its pool, `PutItem` on the audit table (`AuditLogTable.grantAppend`: no reads, no edits), and write its own log group; no managed policies. The scheduler's role may only invoke that function, and only this account's scheduler, for this group's schedules, can assume it. `inviteExpirySweepPolicy` gives the same function permissions as plain JSON.
- **Failures are loud.** A run that couldn't disable a due invite, or that stopped at `maxPeople` (default 5000), logs what it did and then fails, so the function's errors metric counts it. With `alarmTopic`, two alarms: a failed run, and an invocation the scheduler dropped. No retries inside a run's slot beyond the scheduler's delivery retries; the next run sweeps again.
- **The function's code ships in the tarball.** `npm run build` also bundles the handler with every dependency, the AWS SDK clients included, into `dist/lambda/invite-expiry/index.mjs` (about 0.9 MB, unminified so stack traces read). The construct deploys that file. Sites don't need esbuild at synthesis, and the function runs exactly the code [0012](0012-release-tarballs.md) attests, not whatever SDK the Lambda runtime has that day. To keep the bundle free of Next.js and React, the sweep lives in its own module (`src/admin/sweep.ts`), not in the People actions.

## Consequences

- One more stack resource set per site (a function, two roles, a schedule and its group, a log group kept three months), all near zero cost.
- Sandboxes get the sweep too. Seeded personas have verified addresses, so it never disables them.
- Raising `maxPeople` past what five minutes of quota-limited `ListUsers` allows needs a longer timeout; at 5000 accounts a run takes well under a minute.
