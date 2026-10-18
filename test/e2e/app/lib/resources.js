import { createMemoryResourceStore, defineResourceTypes } from 'auth-kit/resources';
import { matrixOverrides } from '@/dev-matrix';

/** The fixture's one resource type: members create records and manage their own (ADR 0022). */
export const resourceTypes = defineResourceTypes({ record: { noun: 'record', selfServiceCreate: true } });

let local;

/** Memberships: under the matrix, the process's store that every bundle shares; otherwise in memory. */
export function resourceStore() {
  return matrixOverrides()?.resources ?? (local ??= createMemoryResourceStore());
}
