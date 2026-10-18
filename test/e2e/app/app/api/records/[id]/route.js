import { NotFoundError, withAuthErrors } from 'auth-kit/server';
import { auth } from '../../../../lib/auth.js';
import { records } from '../../../../lib/records.js';

export const GET = withAuthErrors(async (_request, { params }) => {
  const { id } = await params;
  await auth.requireResourceRole('record', id, 'view');
  const record = records().get(id);
  if (!record) throw new NotFoundError();
  return Response.json(record);
});
