# 0015. The authenticator gate always renders its children

- **Status:** Accepted, 2026-10-17 (amends [ADR 0008](0008-client-in-the-browser.md))
- **Standard:** 03 §2 Sign-in ("the app requires TOTP of password users"), Enforcement
- **Issue:** [#7](https://github.com/davidyokum/auth-kit/issues/7)

## Context

`TOTPEnrollmentGate` started in a "checking" state and rendered only a status until a browser call to Cognito (`GetUserAuthFactors`) answered, so its children never rendered on the server. README §6 put it around a layout's `children`. Building the template showed two effects:

1. **It masked the server's answer.** Next hands a layout its page as a lazily resolved chunk. A page under the gate that called `notFound()` (a second member opening someone else's record) or `redirect()` never threw during server rendering, because React never reached it, so the response went out as **200**. The auth matrix caught it; nothing leaked (the record's data wasn't in the payload), but a status the standard depends on was wrong.
2. **It hid every page** until a browser round trip on each full load, which also counted toward the pool's WAF per-IP rule from the browser.

And it protected nothing there: the layout's `pages.requireUser()` already refuses a password user without an authenticator. React sends a client component's children to the browser whatever the component renders, so a client gate is never a security boundary.

## Decision

- **The gate always renders its children**, on the server and in the browser, in a wrapper that has the `hidden` attribute until the check passes. Everything under it runs during server rendering, so 404s and redirects below it surface exactly as without it. `hidden` is an attribute, not an inline style, so a strict CSP can't undo it.
- **`serverChecked`** for the documented placement (inside a page, after the page's own guard): the children show from the first paint, the browser re-checks, and the gate switches to setup only if the re-check says so. A re-check that can't run changes nothing, because the server's answer for that render stands and the next request is checked on the server again.
- Without `serverChecked` the gate still fails closed on screen: hidden while checking, hidden with the reason and a retry if the check can't run.
- After setup inside the gate, its children remount, so components such as `MyAccount` read the new state.
- The README stops recommending the gate around a layout's `children` and shows it inside `/account` around `MyAccount`.

## Consequences

- The gate's root element is always present (`data-auth-kit="totp-gate"`, `data-auth-kit-state`), with the children in a `content` slot; `authKitStyles` keeps the root full-width and the hidden slot hidden.
- Hidden children are mounted while the check runs, so their own effects (a client component's Cognito calls) start at once rather than after the check.
- Tests render the gate with React's server renderer, including a lazily rejected page as Next produces it, and fail if a child's `notFound()` is swallowed (the previous gate fails them).
