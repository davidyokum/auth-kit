import { STANDARD_CAPABILITIES, STANDARD_GROUPS } from '../shared/policy.js';

/**
 * Code asks about capabilities ("may she manage people?"), never role names. Each app keeps ONE file
 * that maps its Cognito groups to capabilities:
 *
 * ```ts
 * // lib/capabilities.ts
 * import { defineCapabilities, STANDARD_CAPABILITIES } from 'auth-kit/server';
 *
 * export const capabilities = defineCapabilities({
 *   ...STANDARD_CAPABILITIES,
 *   reviewer: ['reviews.read', 'reviews.comment'],
 * });
 * ```
 *
 * Splitting a role later (content admins from people admins) is then a change to this one file.
 */
export interface Capabilities<G extends string = string, C extends string = string> {
  /** The groups this map knows, in the order given. */
  readonly groups: readonly G[];
  /** Every capability any group grants. */
  readonly capabilities: readonly C[];
  /** The map itself (frozen). */
  readonly map: Readonly<Record<G, readonly C[]>>;
  /** True when any of `groups` grants `capability`. Unknown groups grant nothing. */
  can(groups: readonly string[], capability: C): boolean;
  /** All capabilities `groups` grant. */
  capabilitiesOf(groups: readonly string[]): ReadonlySet<C>;
  /** The groups that grant `capability`, e.g. for listing who can publish. */
  groupsWith(capability: C): readonly G[];
}

export type CapabilityOf<T> = T extends Capabilities<string, infer C> ? C : never;
export type GroupOf<T> = T extends Capabilities<infer G, string> ? G : never;

// Dotted names: a namespace, then the verb, e.g. `content.publish` or `reviews.comment`.
const CAPABILITY_RE = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;

/** Builds an app's capability map. Throws if a capability is misnamed or reuses a group name. */
export function defineCapabilities<const M extends Record<string, readonly string[]>>(
  map: M,
): Capabilities<Extract<keyof M, string>, M[keyof M][number]> {
  type G = Extract<keyof M, string>;
  type C = M[keyof M][number];
  const groups = Object.keys(map) as G[];
  if (groups.length === 0) throw new Error('auth-kit: defineCapabilities needs at least one group.');

  const all = new Set<C>();
  const frozen = {} as Record<G, readonly C[]>;
  for (const group of groups) {
    const caps = map[group] as readonly C[];
    for (const cap of caps) {
      if (!CAPABILITY_RE.test(cap)) {
        throw new Error(`auth-kit: capability "${cap}" (group "${group}") must be dotted, like "content.edit".`);
      }
      if ((groups as string[]).includes(cap)) {
        throw new Error(`auth-kit: capability "${cap}" is a group name. Check capabilities, not role names.`);
      }
      all.add(cap);
    }
    frozen[group] = Object.freeze([...new Set(caps)]);
  }
  Object.freeze(frozen);
  const known = new Set<string>(groups);

  const capabilitiesOf = (held: readonly string[]): ReadonlySet<C> => {
    const result = new Set<C>();
    for (const group of held) {
      if (!known.has(group)) continue;
      for (const cap of frozen[group as G]) result.add(cap);
    }
    return result;
  };

  return Object.freeze({
    groups: Object.freeze([...groups]),
    capabilities: Object.freeze([...all]),
    map: frozen,
    can: (held: readonly string[], capability: C) => capabilitiesOf(held).has(capability),
    capabilitiesOf,
    groupsWith: (capability: C) => Object.freeze(groups.filter((g) => frozen[g].includes(capability))),
  });
}

/** The standard map with nothing added. */
export const standardCapabilities = defineCapabilities(STANDARD_CAPABILITIES);

export { STANDARD_CAPABILITIES, STANDARD_GROUPS };
