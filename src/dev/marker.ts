/**
 * The dev sign-in route and the marker the production-build check looks for.
 *
 * The marker string appears in the compiled code of exactly two things: the "Sign in as…" route
 * handler (it sends the marker as a response header) and the persona menu (it renders it as a data
 * attribute). If either reaches a production build, `checkProductionBuild` finds the string. The
 * auth matrix's server mode and the backdrop picker have markers of their own, found the same way.
 *
 * Keep this module imported only by dev-only code. `auth-kit/ribbon` (which runs in production)
 * must never import it, directly or through another module.
 */
import { DEV_POLICY } from '../shared/policy.js';

/** Where the dev sign-in route lives in a Next.js app (`app/api/dev/sign-in/route.dev.ts`). */
export const DEV_SIGN_IN_ROUTE: string = DEV_POLICY.route;

/** The marker string. Changing it breaks the build check for apps on older versions, so don't. */
export const DEV_SIGNIN_MARKER = 'auth-kit-dev-sign-in-7f3a9c2e';

/**
 * The auth matrix's server mode (`auth-kit/testing/matrix-server`) carries this marker, so
 * `checkProductionBuild` also fails a build that bundled it. Don't change it either.
 */
export const MATRIX_SERVER_MARKER = 'auth-kit-matrix-server-4b8d1e6a';

/**
 * The backdrop picker (`auth-kit/backdrops/picker`, a dev-only page that writes the site's config)
 * carries this marker too, so `checkProductionBuild` fails a build that bundled it. Don't change it.
 */
export const BACKDROP_PICKER_MARKER = 'auth-kit-backdrop-picker-2c5e8f91';

/** The response header the route sets to the marker, so an HTTP check can spot a shipped route. */
export const DEV_SIGNIN_MARKER_HEADER = 'x-auth-kit-dev';
