/**
 * The Rapier collision groups of the simulation.
 *
 * Every collider but the ragdoll's keeps Rapier's default: a member of every
 * group, meeting every group. The ragdoll of `ragdoll.ts` is a member of its
 * own group only. A collider that must never touch a ragdoll leaves that group
 * out of what it meets, and so does every query that must not see one.
 *
 * Rapier packs the two masks into one number: the groups a collider is a
 * member of in the high 16 bits, the groups it meets in the low 16. Two
 * colliders touch when each is a member of a group the other meets.
 */

/** Every group. */
const ALL = 0xffff;

/** The group of the ragdolls' bones. */
export const RAGDOLL_BIT = 0x0002;

/** The two masks as one number. It stays unsigned, as the WebAssembly side reads it. */
function groups(member: number, meets: number): number {
  return member * 0x10000 + meets;
}

/** A bone of a ragdoll: it meets the ground, the fixed and kinematic bodies, and other bones. */
export const RAGDOLL_GROUPS = groups(RAGDOLL_BIT, ALL);

/**
 * A collider that never touches a ragdoll, and a query that never sees one:
 * the player's chassis, a promoted car of the city and the player on foot, so
 * a body never pushes a vehicle; and the casts of the wheels, the rounds, the
 * swings and the throws, so they behave as they did before there were ragdolls.
 */
export const SHUNS_RAGDOLL = groups(ALL, ALL & ~RAGDOLL_BIT);
