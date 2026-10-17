# 0007. auth-kit verifies tokens itself; the Amplify adapter only refreshes

- **Status:** Accepted, 2026-10-17
- **Standard:** 03 §2 Sessions ("server checks use `@aws-amplify/adapter-nextjs`"), Enforcement

## Context

The standard's client is Amplify with `ssr: true`, which keeps tokens in cookies. The Next adapter can read them, but its validator deliberately treats an expired token as valid (so it can refresh), it needs the full Amplify config at import time, and it returns tokens without the app's capability model.

## Decision

- `auth-kit/server` reads Amplify's cookies (`CognitoIdentityServiceProvider.<clientId>.LastAuthUser`, then `.<username>.accessToken`) or an `Authorization: Bearer` header, and verifies the access token with `aws-jwt-verify`, the same library the adapter uses: signature against the pool's cached JWKS, expiry, issuer, `client_id`, and `token_use = access`. ID tokens are read only for display fields, and only when their `sub` matches.
- Failure to fetch the keys is 503, not 401.
- The proxy can refresh an expired session server-side through the adapter (`amplifyAdapterRefresh`), then verifies the new token itself before letting the request through and forwards the refreshed cookies to the route.
- Cookies stay script-readable because Amplify's browser code reads them; the adapter's httpOnly mode (`createAuthRouteHandlers`) is still marked experimental, needs managed login, and turns off Amplify's client APIs. auth-kit keeps tokens out of localStorage and relies on a strict CSP from the template. The token cookies the **server** writes (the proxy's refresh) are Secure, SameSite=Lax, and no longer-lived than the refresh token (`amplifyCookieRuntimeOptions`, which sets `secure: true` explicitly: the adapter adds Secure itself only in its httpOnly mode, and otherwise relies on an internal default in `aws-amplify/adapter-core`; auth-kit's tests run the real adapter to prove the flag). Cookies the **browser** writes come from Amplify's client `CookieStorage`: Secure and SameSite=Lax by default, but 365 days unless the app passes the same lifetime there (`configureAuthClient` in `auth-kit/client` does). Cookies the app sets itself are httpOnly, Secure, SameSite=Lax.
- The proxy refreshes only a genuine (signed by this pool, issued to this client) but expired access token that comes with a refresh-token cookie, within per-person and per-instance limits ([0004](0004-waf-rate-rule.md)).

## Consequences

- The standard's wording "server checks use the adapter" should read "server checks verify tokens with `aws-jwt-verify` (auth-kit/server); the adapter refreshes sessions in the proxy".
- Revisit when the adapter's httpOnly handlers reach general availability.
