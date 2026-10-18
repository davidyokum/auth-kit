import { auth, pages } from '../../lib/auth.js';
import { records } from '../../lib/records.js';

export default async function RecordsPage() {
  const user = await pages.requireUser();
  const mine = await auth.listMyResources('record', { user });
  const all = [...records().values()];
  const visible = mine.scope === 'all' ? all : all.filter((r) => mine.items.some((i) => i.id === r.id));
  return <main>{visible.length} records</main>;
}
