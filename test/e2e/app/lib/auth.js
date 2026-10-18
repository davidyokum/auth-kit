import { createPageGuards, createServerAuth, poolConfigFromAmplifyOutputs } from 'auth-kit/server';
import { matrixOverrides } from '@/dev-matrix';
import pool from '../pool.json';
import { capabilities } from './capabilities.js';
import { resourceStore, resourceTypes } from './resources.js';

export const auth = createServerAuth({
  ...poolConfigFromAmplifyOutputs(pool),
  capabilities,
  resources: { types: resourceTypes, store: resourceStore() },
  ...matrixOverrides()?.serverAuth,
});
export const pages = createPageGuards(auth);
