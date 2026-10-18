import { pages } from '../../../lib/auth.js';
import { records } from '../../../lib/records.js';
import { notFound } from 'next/navigation';

export default async function RecordPage({ params }) {
  const { id } = await params;
  // The member's role on the record, or an admin's site role: anyone else gets the not-found page.
  await pages.requireResourceRole('record', id, 'view');
  const record = records().get(id);
  if (!record) notFound();
  return (
    <article>
      <h1>{record.title}</h1>
    </article>
  );
}
