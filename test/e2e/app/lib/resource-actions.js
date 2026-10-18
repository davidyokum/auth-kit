import { createMemoryAuditLog } from 'auth-kit/admin';
import { createResourceActions } from 'auth-kit/resources';
import { matrixOverrides } from '@/dev-matrix';
import { auth } from './auth.js';

let actions;

/** The access actions, as the README wires them (the audit log is the matrix's, or in memory). */
export function resourceActions() {
  const matrix = matrixOverrides();
  return (actions ??= createResourceActions({
    auth,
    auditLog: matrix?.auditLog ?? createMemoryAuditLog(),
    siteName: 'E2E',
    signInUrl: 'http://127.0.0.1:3000/sign-in',
    ...(matrix && { cognito: matrix.peopleCognito }),
  }));
}
