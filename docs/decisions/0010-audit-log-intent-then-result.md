# 0010. The audit log is append-only, written as an intent row before the change and a result row after

- **Status:** Accepted, 2026-10-17
- **Standard:** 03 §2 Admin area ("one append-only audit log … written on the server with the change"); primer §9, Chapter 7

## Context

The primer says the log is written "in the same transaction as the change". The changes are Cognito calls and the log is DynamoDB, and the two can't share a transaction. Whichever is written second can fail after the first succeeded. Writing the change first risks an unlogged change; writing the log first risks a log row for a change that never happened.

IAM has no condition key for a `ConditionExpression`, so a role allowed `PutItem` can't be limited to conditional puts.

## Decision

**Ordering** (`runAudited`, used by every People action and offered to apps as `recordChange`):

1. Write an **intent** row: who, to whom, what, before, the intended after, reason, request context (IP chain, user agent, request ID), and the planned calls. If it fails, stop and report `audit_unavailable`. Nothing changed, so nothing is unlogged.
2. Make the calls, recording each one's success or failure. Multi-step actions run in the safe order: disable first (it stops sign-in at once); on a role change, remove before adding (a failure halfway leaves less access, never more); a half-made invite is rolled back (`AdminDeleteUser` of the account created seconds earlier).
3. Write a **result** row that repeats the intent and adds the outcome (`ok`, `partial`, `failed`), the calls made, the error, and the actual after. Its key comes from the intent, so it can exist only once: retries (three, with backoff) can't duplicate it, and a retry after a write that landed but reported an error is recognized as done.
4. If step 3 still fails, the action returns `audit_incomplete` with `changed: 'yes'`. The log keeps the intent, which the Activity page shows as "outcome not recorded" (never as "didn't happen").

Guardrail refusals and forbidden attempts are logged as single `refused` rows, best effort: a refusal changes nothing, so it never fails for want of a log row.

**Append-only**:

- The store has `append`, `list`, and `listActivity`, and sends only `PutItem` (always with `attribute_not_exists(pk)`) and `Query`.
- `AuditLogTable` (`auth-kit/admin/cdk`) grants the app exactly those two actions, and its resource policy denies `UpdateItem`, `DeleteItem`, `BatchWriteItem`, PartiQL updates and deletes, and `DeleteTable` to every principal. Deletion protection and point-in-time recovery are on, and the stream carries old and new images.
- Because IAM can't force the condition, a stolen app role could still replace a row it had read. The stream and point-in-time recovery keep the original, and the optional tamper alert (an EventBridge Pipe filtering MODIFY and REMOVE to SNS) reports it within seconds.

**Layout**: one partition (`pk = LOG`), sort key `<startedAt>#<entryId>#<0|1>` so an intent and its result sort together, and `byActor` and `byTarget` indexes. An admin area's log is small; one partition keeps "newest first" a single Query.

## Consequences

- The log can hold an intent with no result: the change may or may not have happened. That is the honest record when the second write fails, and the Activity page says so.
- A failed or partial result row keeps the intended after; the outcome and the "tried to" wording carry the difference.
- Rows over 350 KB are refused before the change; content edits should log a version or ID, not the content.
- The retention period before deleting an account is read from this log (the latest successful disable). An account disabled outside the admin area can't be deleted here until it's disabled here.
