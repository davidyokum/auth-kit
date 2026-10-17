import { TOTPEnrollmentGate } from 'auth-kit/client';
import { pages } from '../../lib/auth.js';

// The placement issue #7 reported: the gate around a layout's children. It must not mask the
// nested record page's 404 for someone else's record.
export default async function RecordsLayout({ children }) {
  await pages.requireUser();
  return <TOTPEnrollmentGate issuer="E2E">{children}</TOTPEnrollmentGate>;
}
