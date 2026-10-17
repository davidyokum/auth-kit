import { withAuthErrors } from 'auth-kit/server';
import { auth } from '../../../../lib/auth.js';
import { records } from '../../../../lib/records.js';

export const GET = withAuthErrors(async (_request, { params }) => {
  const user = await auth.requireUser();
  const record = auth.requireRecordAccess(user, records().get((await params).id), { owner: (r) => r.ownerSub, coveredBy: 'audit.read' });
  return Response.json(record);
});
