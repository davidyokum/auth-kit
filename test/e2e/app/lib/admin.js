import { createPeopleActions } from 'auth-kit/admin';
import { matrixOverrides } from '@/dev-matrix';
import { auth } from './auth.js';

export function peopleActions() {
  const matrix = matrixOverrides();
  if (!matrix) throw new Error('e2e app: the admin page runs only under the auth matrix');
  return createPeopleActions({
    auth,
    auditLog: matrix.auditLog,
    mailer: matrix.mailer,
    cognito: matrix.peopleCognito,
    siteName: 'E2E',
    signInUrl: 'http://127.0.0.1/sign-in',
  });
}
