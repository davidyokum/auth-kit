// The e2e fixture app (test/e2e): a minimal site wired the way the README says, so the e2e test can
// run auth-kit against real `next build`, `next dev`, and `next start`. Not a template to copy.
import { DEV_MATRIX_ALIAS, withDevKit } from 'auth-kit/dev';

const config = { poweredByHeader: false, reactStrictMode: true };

// `@/dev-matrix` means lib/dev/matrix.on.js under `next dev` and lib/dev/matrix.off.js in builds.
export default (phase) => withDevKit(phase, config, { aliases: [{ ...DEV_MATRIX_ALIAS, on: './lib/dev/matrix.on.js', off: './lib/dev/matrix.off.js' }] });
