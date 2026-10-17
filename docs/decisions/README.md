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
