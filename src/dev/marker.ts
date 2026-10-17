/**
 * The dev sign-in route and the marker the production-build check looks for.
 *
 * The marker string appears in the compiled code of exactly two things: the "Sign in as…" route
 * handler (it sends the marker as a response header) and the persona menu (it renders it as a data
 * attribute). If either reaches a production build, `checkProductionBuild` finds the string.
 *
 * Keep this module imported only by dev-only code. `auth-kit/ribbon` (which runs in production)
 * must never import it, directly or through another module.
 */
import { DEV_POLICY } from '../shared/policy.js';

/** Where the dev sign-in route lives in a Next.js app (`app/api/dev/sign-in/route.dev.ts`). */
export const DEV_SIGN_IN_ROUTE: string = DEV_POLICY.route;

/** The marker string. Changing it breaks the build check for apps on older versions, so don't. */
export const DEV_SIGNIN_MARKER = 'auth-kit-dev-sign-in-7f3a9c2e';

/** The response header the route sets to the marker, so an HTTP check can spot a shipped route. */
export const DEV_SIGNIN_MARKER_HEADER = 'x-auth-kit-dev';
