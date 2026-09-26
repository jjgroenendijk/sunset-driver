/**
 * The people of the crowd who are stepping out of the player's way, and where
 * they look (spec sections 11.2, 20.1).
 *
 * A person of the crowd is a function of the tick, and the player is not, so
 * the step aside is the one part of it that has to be stored: each person near
 * the player on foot carries how far they stand off their lane and which way
 * their head is turned. Somebody keeping out of a car, or walking round what
 * stands in their way, carries how far they stand off their loop. `make-way.ts` steps the list once a tick; this file
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
  /**
   * Metres east and north they stand off their loop to keep out of a car or
   * round something standing in their way (`detour.ts`), and where giving
   * way wants them to stand this tick. Both 0 for somebody on their loop.
   */
  dodgeX: number;
  dodgeY: number;
  wantX: number;
  wantY: number;
}

/** A record of somebody on their lane, looking ahead. */
export function freshAside(id: number): Aside {
  return { id, off: 0, side: 0, look: 0, dodgeX: 0, dodgeY: 0, wantX: 0, wantY: 0 };
}

/**
 * Ask person `id` to stand `(x, y)` metres off their loop, from the next tick
 * on, adding a record for them where they have none. They walk there at a
 * step's pace (`make-way.ts`), and back once nobody asks any more.
 */
export function wantDodge(list: Aside[], id: number, x: number, y: number): void {
  let record = asideOf(list, id);
  if (record === undefined) {
    let i = list.length;
    while (i > 0 && (list[i - 1] as Aside).id > id) i--;
    record = freshAside(id);
    list.splice(i, 0, record);
  }
  record.wantX = x;
  record.wantY = y;
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
