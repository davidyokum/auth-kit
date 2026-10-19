# 0006. The preset returns `defineAuth` props, then applies L1 overrides

- **Status:** Accepted, 2026-10-17

## Context

Two facts about `@aws-amplify/backend` 1.25 (checked in its source):

1. `defineAuth` records its caller's stack frame and fails synthesis unless the direct caller is `amplify/auth/resource.ts`. A package function that calls `defineAuth` itself would always fail.
2. `defineAuth` has no setting for deletion protection, token lifetimes, the session lifetime, the password policy's minimum length or composition rules, passkey `FactorConfiguration`, an SES domain identity, a WAF web ACL, or tags; it turns self-registration on (the preset always turns it off: [0023](0023-account-creation.md)); it adds `ALLOW_USER_SRP_AUTH` and `ALLOW_CUSTOM_AUTH`; and it refuses passkeys combined with MFA `REQUIRED`.

## Decision

- `standardAuthProps(options)` returns props for the app's own `defineAuth` call in `amplify/auth/resource.ts`.
- `applyAuthStandard(backend.auth, options)` in `amplify/backend.ts` sets the rest directly on the L1 `CfnUserPool` and `CfnUserPoolClient`. Typed L1 properties are used where they exist so Amplify's lazily computed outputs (password policy, MFA) reflect them; `WebAuthnFactorConfiguration` is a raw property override so it works on every `aws-cdk-lib` version Amplify accepts.
- Both take the same options object; `applyAuthStandard` checks that the standard groups exist (props built elsewhere fail loudly) and refuses to run twice on one pool.
- In `accountCreation` domains mode, synthesis fails unless the preSignUp trigger is attached ([0023](0023-account-creation.md)); on every sign-up site (domains, open) it also fails without the site web ACL and the unverified-account sweep (register D3).

## Consequences

- Two calls instead of one, both shown in the README.
- The preset is tested by synthesizing the real `AmplifyAuth` construct and asserting on the CloudFormation template (plus a snapshot), and by running Amplify's own `defineAuth` validation on the props.
- The user pool keeps Amplify's `DeletionPolicy: Delete`. With deletion protection `ACTIVE`, deleting the stack fails at the pool instead of silently orphaning it, which is the loud failure we want.
- Amplify allows one auth resource per backend, so a Tier 3 admin pool (`adminPool: true`) lives in its own Amplify backend.
