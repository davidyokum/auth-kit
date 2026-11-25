# ADR 0031: Guarded Staged Role Builder and Universal Admin Mode

- **Status:** Accepted
- **Date:** 2026-11-25

## Context

ADR 0020 established a five-tier site-wide Cognito admin ladder (`owner`, `superadmin`, `admin-content-people`, `admin-content`, `admin-view`) plus `member`. That five-tier ladder fit multi-project portals well, but in focused single-product apps it creates unnecessary cognitive load: administrators want a clean, universal governance core (`Owner`, `Admin`, `Viewer`) alongside site-specific operational roles (such as deciding which product tabs are visible or who can edit records) without modifying Cognito user-pool groups or risking accidental privilege escalation.

## Decision

1. **Preserve Cognito group compatibility (zero breaking changes).** Existing Cognito groups (`owner`, `superadmin`, `admin-content-people`, `admin-content`, `admin-view`) remain intact so deployed user pools require zero migrations. The simplified default UI presents three universal governance/baseline roles — **Owner** (`owner`), **Admin** (`superadmin`), and **Viewer** (`member`) — while keeping legacy admin tiers hidden behind an opt-in toggle unless a site enables them or an account already holds one.
2. **Guarded Staged Role Builder (`auth-kit/admin`).** Sites declare a `RolePolicyCatalog` of capabilities grouped into three zones:
   - **`tabs`** (visible workspace tabs or sections),
   - **`actions`** (site-specific read/write operations), and
   - **`admin`** (code-locked administration capabilities).
   `Owner`, `Admin`, and all `admin` capabilities stay strictly code-locked. Operational built-in roles and site-created custom roles can toggle `tabs` and `actions` in a staged draft with an audit reason, persisted to `SiteSettingsTable` (`admin-role-policy`) via `recordChange` (intent → write → result), and enforced live on the server via `resolveEffectiveRoleCapabilities` backed by `auth.liveState(user)`.
3. **Hard guardrails.** `validateRolePolicyDraft` refuses:
   - any override on locked governance roles (`owner`, `superadmin`) or locked `admin` capabilities,
   - any editable or custom role left with zero visible tabs,
   - custom role slugs colliding with standard, retired, or built-in roles, and
   - deleting a custom role while any account is still assigned to it.
4. **Admin Mode & existing `SiteSettingsTable` reuse.** Directory profiles (`admin-people-profiles`), privacy-safe throttled usage telemetry (`admin-usage-ledger`), and editable invite welcome notes (`invite-welcome-note`) reuse `SiteSettingsTable` with zero new DynamoDB tables or CDK changes.

## Consequences

- Every site gets a consistent, scannable Admin Mode console (`People`, optional `Feedback`, `Activity`, `Settings & Emails`) without losing its host masthead.
- Non-breaking upgrade: existing sites that do not opt into `createSiteSettingsRolePolicyStore` behave identically to ADR 0020.
