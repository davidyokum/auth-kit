/**
 * The small protocol between `withAuthProxy` and the auth matrix's "without proxy" pass, which checks
 * that every route handler refuses requests on its own (the proxy is never the only gate).
 *
 * The matrix marks those requests with `x-auth-kit-matrix: handlers`. The proxy honors the mark only
 * when all three hold, so it can never switch off in a deployed site:
 * 1. `NODE_ENV` isn't `production` (every `next build` output, including Amplify's, is production);
 * 2. `AUTH_KIT_MATRIX=1` is set for the server process;
 * 3. the request is for a loopback host (`localhost`, `*.localhost`, `127.0.0.1`, `[::1]`).
 * When it honors the mark it passes the request straight to the route and labels the response
 * `x-auth-kit-proxy: handler-pass`; when it refuses a request itself it labels it `denied`. The matrix
 * fails any "without proxy" check the proxy answered.
 */
export const MATRIX_REQUEST_HEADER = 'x-auth-kit-matrix';
export const MATRIX_HANDLER_PASS_VALUE = 'handlers';
export const MATRIX_ENV_FLAG = 'AUTH_KIT_MATRIX';
export const PROXY_RESPONSE_HEADER = 'x-auth-kit-proxy';
export const PROXY_DENIED = 'denied';
export const PROXY_HANDLER_PASS = 'handler-pass';

/**
 * The matrix server mode (`auth-kit/testing/matrix-server`, ADR 0016): the fixture `startMatrixServer`
 * passes to the dev server, as JSON. Read only under `next dev` with `AUTH_KIT_MATRIX=1`.
 */
export const MATRIX_FIXTURE_ENV = 'AUTH_KIT_MATRIX_FIXTURE';
