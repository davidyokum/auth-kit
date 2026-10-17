# Decisions

Short records of the choices behind auth-kit: what was decided, why, and what it costs. New decisions get the next number; a reversed decision is marked superseded, not deleted.

| # | Decision |
|---|---|
| [0001](0001-passkey-first.md) | Passkey first, then password + authenticator, then emailed code |
| [0002](0002-mfa-optional-app-enforced-totp.md) | MFA optional in the pool; the app requires TOTP of password users |
| [0003](0003-capabilities-not-roles.md) | Code checks capabilities, mapped from groups in one file |
| [0004](0004-waf-rate-rule.md) | A WAF rate rule on every user pool |
| [0005](0005-sandbox-only-admin-password-flow.md) | `ADMIN_USER_PASSWORD_AUTH` on sandbox clients only |
| [0006](0006-preset-props-plus-l1-overrides.md) | The preset returns `defineAuth` props, then applies L1 overrides |
| [0007](0007-verify-tokens-in-auth-kit.md) | auth-kit verifies tokens itself; the Amplify adapter only refreshes |
| [0008](0008-client-in-the-browser.md) | The client runs in the browser and fills Amplify v6's gaps with two direct Cognito calls |
| [0009](0009-localhost-kit.md) | The localhost kit: TOTP personas, a checked loopback binding, a ribbon that ships and a menu that doesn't |
| [0010](0010-audit-log-intent-then-result.md) | The audit log is append-only, written as an intent before the change and a result after |
| [0011](0011-people-actions.md) | People actions: live checks, exact roles, owner grants, two invite modes, and where the primer was unclear |
| [0012](0012-release-tarballs.md) | Releases are attested tarballs built once in CI |
| [0013](0013-shared-web-acl.md) | One shared web ACL per account and Region |
| [0014](0014-matrix-without-proxy.md) | The auth matrix checks each route's own guard |
| [0015](0015-gate-renders-its-children.md) | The authenticator gate always renders its children, so it can't mask the server's answer |
| [0016](0016-matrix-server-mode.md) | The auth matrix's server mode ships in auth-kit |
