import { pages } from '../../lib/auth.js';
import { peopleActions } from '../../lib/admin.js';

export default async function AdminPage() {
  await pages.requireCan('people.manage', { live: true });
  const list = await peopleActions().listPeople();
  return <main>{list.state === 'ok' ? `${list.people.length} people` : `— ${list.reason}`}</main>;
}
