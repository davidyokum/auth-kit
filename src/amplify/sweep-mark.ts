/**
 * How the preset finds the unverified-account sweep (register D3): `UnverifiedAccountSweep`
 * (`auth-kit/admin/cdk`) carries this mark with the pool it sweeps, and `applyAuthStandard` fails
 * synthesis on a sign-up site (`domains` or `open`) whose pool has none. Pure: no CDK import.
 */
export const UNVERIFIED_SWEEP_MARK: unique symbol = Symbol.for('auth-kit.unverified-account-sweep') as never;

export interface UnverifiedSweepMarked {
  readonly [UNVERIFIED_SWEEP_MARK]: { readonly userPool: unknown };
}

export function isUnverifiedSweep(value: unknown): value is UnverifiedSweepMarked {
  return typeof value === 'object' && value !== null && UNVERIFIED_SWEEP_MARK in value;
}
