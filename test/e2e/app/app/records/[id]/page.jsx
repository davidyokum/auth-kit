import { handlePageAuthError } from 'auth-kit/server';
import { auth, pages } from '../../../lib/auth.js';
import { records } from '../../../lib/records.js';

export default async function RecordPage({ params }) {
  const user = await pages.requireUser();
  const { id } = await params;
  let record;
  try {
    record = auth.requireRecordAccess(user, records().get(id), { owner: (r) => r.ownerSub, coveredBy: 'audit.read' });
  } catch (error) {
    await handlePageAuthError(error);
  }
  return (
    <article>
      <h1>{record.title}</h1>
    </article>
  );
}
