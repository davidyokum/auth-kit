import { assertSameOrigin, withAuthErrors } from 'auth-kit/server';
import { auth } from '../../../lib/auth.js';
import { records } from '../../../lib/records.js';
import { resourceActions } from '../../../lib/resource-actions.js';

export const GET = withAuthErrors(async () => {
  const user = await auth.requireUser();
  const mine = await auth.listMyResources('record', { user });
  const all = [...records().values()];
  return Response.json({ records: mine.scope === 'all' ? all : all.filter((r) => mine.items.some((i) => i.id === r.id)) });
});

export const POST = withAuthErrors(async (request) => {
  await auth.requireUser();
  // No expectedOrigin on purpose: under next dev this exercises the Host fallback (#8).
  assertSameOrigin(request);
  const body = await request.json().catch(() => ({}));
  // The record and its creator's Manager role, in one audited change (self-service creation).
  const result = await resourceActions().create({
    type: 'record',
    run: ({ id, manager }) => {
      records().set(id, { id, ownerSub: manager.sub, title: String(body.title ?? 'Untitled') });
      return Promise.resolve(id);
    },
  });
  if (!result.ok) return Response.json({ error: result.code, message: result.error }, { status: result.code === 'forbidden' ? 403 : 503 });
  return Response.json({ id: result.id }, { status: 201 });
});
