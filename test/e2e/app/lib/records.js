import { matrixOverrides } from '@/dev-matrix';

const local = new Map();

/** Records by id: shared across the server's bundles while the matrix runs (a route creates, a page reads). */
export function records() {
  return matrixOverrides()?.shared('records', () => new Map()) ?? local;
}
