import { defineAuth } from '@aws-amplify/backend';
import { expect, it } from 'vitest';
import { standardAuthProps } from '../../../src/amplify/index.js';
import { ADMIN } from '../fixtures.js';

it("passes Amplify's own defineAuth validation (admin pool with passkeys)", () => {
  expect(() => defineAuth(standardAuthProps(ADMIN))).not.toThrow();
});
