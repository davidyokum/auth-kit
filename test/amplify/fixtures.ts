import type { AuthStandardOptions } from '../../src/amplify/index.js';

export const EVERYDAY: AuthStandardOptions = {
  project: 'example-reports',
  owner: 'reports-team',
  tier: 2,
  email: { fromAddress: 'sign-in@example.org', fromName: 'Example Reports', family: 'personal', replyTo: 'help@example.org' },
  passkeys: { relyingPartyId: 'reports.example.org' },
};

export const ADMIN: AuthStandardOptions = { ...EVERYDAY, tier: 3, adminPool: true };
