/**
 * An environment in which AWS is unreachable: no credentials can resolve (no keys, a profile that
 * doesn't exist, empty config and credentials files, no instance or container metadata), so an SDK
 * call that slips past a mock fails at credential lookup and never leaves the machine.
 *
 * auth-kit's own tests run with it (vitest.config.ts), `startMatrixServer` gives it to the matrix's
 * dev server, and apps can pass it to their own test runner:
 *
 * ```ts
 * // vitest.config.ts
 * import { AWS_BLOCKED_ENV } from 'auth-kit/testing';
 * export default defineConfig({ test: { env: AWS_BLOCKED_ENV } });
 * ```
 */
export const AWS_BLOCKED_ENV: Readonly<Record<string, string>> = Object.freeze({
  AWS_PROFILE: 'auth-kit-tests-have-no-aws',
  AWS_CONFIG_FILE: '/nonexistent/auth-kit/aws-config',
  AWS_SHARED_CREDENTIALS_FILE: '/nonexistent/auth-kit/aws-credentials',
  AWS_EC2_METADATA_DISABLED: 'true',
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: '',
  AWS_SECRET_ACCESS_KEY: '',
  AWS_SESSION_TOKEN: '',
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '',
  AWS_CONTAINER_CREDENTIALS_FULL_URI: '',
  AWS_CONTAINER_AUTHORIZATION_TOKEN: '',
  AWS_WEB_IDENTITY_TOKEN_FILE: '',
  AWS_ROLE_ARN: '',
  AWS_SSO_SESSION: '',
});
