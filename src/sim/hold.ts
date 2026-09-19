/**
 * How far behind its own timetable a car of the traffic or a person of the
 * crowd has fallen by giving way (`give-way.ts`).
 *
 * A car and a person are each a function of the tick: their loop says where
 * they are. Giving way holds one back, and the ticks it has been held are its
 * lag. It then stands where its loop put it `lag` ticks ago. Only those held
 * near the player have a record; everyone else has a lag of 0. The record is
 * simulation state, so a save and a replay hold the same people back.
 */

/** One car or person held back. */
export interface Hold {
  id: number;
  /** Ticks behind its loop. */
  lag: number;
  /**
   * What the lag changed by on the last tick: 1 when held, 2 when a person
   * walked back, 0 when moving, below 0 when a car caught up.
   */
  step: number;
  /** Ticks in a row it has stood for something that is not a car or a light. */
  waited: number;
}

/** The holds of one kind: the tick they stand at, the middle of the box they were decided in, and the holds ascending by id. */
export interface Holds {
  /** -1 before the first tick anybody gave way on. */
  tick: number;
  x: number;
  y: number;
  list: Hold[];
}

export function createHolds(): Holds {
  return { tick: -1, x: 0, y: 0, list: [] };
}

/** The hold of an id, or undefined for one that is on its loop's time. */
export function holdOf(holds: Holds, id: number): Hold | undefined {
  const list = holds.list;
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const at = (list[mid] as Hold).id;
    if (at === id) return list[mid];
    if (at < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
}

/**
 * The moment of its loop an id stands at, at a moment of the clock. A moment
 * between the last two ticks is the renderer's, and it moves between where
 * the id stood on each, so a car held on the last tick is drawn standing.
 */
export function heldTime(holds: Holds, id: number, time: number): number {
  if (holds.list.length === 0) return time;
  const hold = holdOf(holds, id);
  if (hold === undefined) return time;
  const tick = holds.tick;
  if (time >= tick) return time - hold.lag;
  const before = hold.lag - hold.step;
  if (time <= tick - 1) return time - before;
  return time - before - (time - (tick - 1)) * hold.step;
}

/** What an id's lag changed by on the last tick: 0 for one on its loop's time. */
export function heldStep(holds: Holds, id: number): number {
  if (holds.list.length === 0) return 0;
  return holdOf(holds, id)?.step ?? 0;
}
