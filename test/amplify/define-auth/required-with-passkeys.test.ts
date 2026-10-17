import { defineAuth } from '@aws-amplify/backend';
import { expect, it } from 'vitest';
import { standardAuthProps } from '../../../src/amplify/index.js';
import { ADMIN } from '../fixtures.js';

// Why the admin pool raises MFA to ON with an L1 override: defineAuth rejects passkeys combined with
// MFA REQUIRED, although AWS documents that a user-verified passkey satisfies required MFA when
// WebAuthn FactorConfiguration is MULTI_FACTOR_WITH_USER_VERIFICATION (a setting defineAuth lacks).
// If this test starts failing, Amplify has learned the setting and the override can be revisited.
it('defineAuth rejects passkeys with MFA REQUIRED (Amplify @aws-amplify/backend-auth 1.10)', () => {
  expect(() => defineAuth({ ...standardAuthProps(ADMIN), multifactor: { mode: 'REQUIRED', totp: true } })).toThrow(
    /passwordless/i,
  );
});
