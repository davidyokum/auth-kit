# Security policy

auth-kit is the login and authorization layer for a set of websites, so a flaw here can affect all of them.

## Reporting a vulnerability

Please don't open a public issue. Report it privately through GitHub's **Report a vulnerability** button on this repository's Security tab (private vulnerability reporting). Include what you found, how to reproduce it, and the version or commit.

You'll get an acknowledgment within a few days. Fixes ship as a new version tag, and sites pick them up by bumping their dependency.

## Supported versions

Only the latest `0.x` pre-release gets fixes. auth-kit is pre-release and not yet used in production.

## What's in scope

- Token verification, the proxy, the server guards, `safeRedirect`, cookie and origin helpers.
- The Amplify preset's settings: anything that leaves a pool weaker than the README says.
- The dev kit's gates: any way "Sign in as…" could run outside local development or against a non-sandbox pool.
- The test helpers, if they could mislead a site into believing it's protected when it isn't.

## Design notes

- No secrets, AWS account IDs, pool IDs, or site names belong in this repository; a test fails if something shaped like one appears.
- Tests make no AWS calls.
- Known limits of what a Cognito pool can enforce are listed in the README under "What the pool can't enforce".
