# 0007. auth-kit verifies tokens itself; the Amplify adapter only refreshes

- **Status:** Accepted, 2026-10-17
- **Standard:** 03 §2 Sessions ("server checks use `@aws-amplify/adapter-nextjs`"), Enforcement

## Context

The standard's client is Amplify with `ssr: true`, which keeps tokens in cookies. The Next adapter can read them, but its validator deliberately treats an expired token as valid (so it can refresh), it needs the full Amplify config at import time, and it returns tokens without the app's capability model.

## Decision

- `auth-kit/server` reads Amplify's cookies (`CognitoIdentityServiceProvider.<clientId>.LastAuthUser`, then `.<username>.accessToken`) or an `Authorization: Bearer` header, and verifies the access token with `aws-jwt-verify`, the same library the adapter uses: signature against the pool's cached JWKS, expiry, issuer, `client_id`, and `token_use = access`. ID tokens are read only for display fields, and only when their `sub` matches.
- Failure to fetch the keys is 503, not 401.
- The proxy can refresh an expired session server-side through the adapter (`amplifyAdapterRefresh`), then verifies the new token itself before letting the request through and forwards the refreshed cookies to the route.
- Cookies stay script-readable because Amplify's browser code reads them; the adapter's httpOnly mode (`createAuthRouteHandlers`) is still marked experimental, needs managed login, and turns off Amplify's client APIs. auth-kit keeps tokens out of localStorage, sets the token cookies to SameSite=Lax with a lifetime no longer than the refresh token (`amplifyCookieRuntimeOptions`), and relies on a strict CSP from the template. Cookies the app sets itself are httpOnly, Secure, SameSite=Lax.

## Consequences

- The standard's wording "server checks use the adapter" should read "server checks verify tokens with `aws-jwt-verify` (auth-kit/server); the adapter refreshes sessions in the proxy".
- Revisit when the adapter's httpOnly handlers reach general availability.
