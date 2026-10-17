import { assertSameOrigin, withAuthErrors } from 'auth-kit/server';
import { auth } from '../../../lib/auth.js';
import { records } from '../../../lib/records.js';

export const GET = withAuthErrors(async () => {
  const user = await auth.requireUser();
  return Response.json({ records: [...records().values()].filter((r) => r.ownerSub === user.sub) });
});

export const POST = withAuthErrors(async (request) => {
  const user = await auth.requireUser();
  // No expectedOrigin on purpose: under next dev this exercises the Host fallback (#8).
  assertSameOrigin(request);
  const body = await request.json().catch(() => ({}));
  const id = crypto.randomUUID();
  records().set(id, { id, ownerSub: user.sub, title: String(body.title ?? 'Untitled') });
  return Response.json({ id }, { status: 201 });
});
