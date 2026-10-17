import { defineAuth } from '@aws-amplify/backend';
import { expect, it } from 'vitest';
import { standardAuthProps } from '../../../src/amplify/index.js';
import { EVERYDAY } from '../fixtures.js';

// Amplify allows one defineAuth per process, so each validator check lives in its own file.
it("passes Amplify's own defineAuth validation (everyday pool)", () => {
  expect(() => defineAuth(standardAuthProps(EVERYDAY))).not.toThrow();
});
