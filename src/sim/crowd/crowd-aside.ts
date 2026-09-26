/**
 * The people of the crowd who are stepping out of the player's way, and where
 * they look (spec sections 11.2, 20.1).
 *
 * A person of the crowd is a function of the tick, and the player is not, so
 * the step aside is the one part of it that has to be stored: each person near
 * the player on foot carries how far they stand off their lane and which way
 * their head is turned. `make-way.ts` steps the list once a tick; this file
 * holds the record and reads it, and nothing else, so the crowd's own poses can
 * read it without importing the step.
 */

/** One person stepping out of the player's way, or watching them pass. */
export interface Aside {
  id: number;
  /** Metres right of their lane they stand, in the way they face. */
  off: number;
  /** The side they chose to step to: +1 right, -1 left, 0 before they chose. */
  side: number;
  /** Radians their head is turned from their body, towards the player. */
  look: number;
}

/** The step aside of a person, or undefined for somebody on their lane and looking ahead. */
export function asideOf(list: readonly Aside[], id: number): Aside | undefined {
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const at = (list[mid] as Aside).id;
    if (at === id) return list[mid];
    if (at < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
}
