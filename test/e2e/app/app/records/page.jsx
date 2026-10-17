import { pages } from '../../lib/auth.js';
import { records } from '../../lib/records.js';

export default async function RecordsPage() {
  const user = await pages.requireUser();
  const mine = [...records().values()].filter((r) => r.ownerSub === user.sub);
  return <main>{mine.length} records</main>;
}
