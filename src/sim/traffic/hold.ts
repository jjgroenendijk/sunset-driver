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
import { cos, sin } from '../../core/libm.ts';
import type { AmbientPose } from './traffic.ts';

/** What {@link heldPose} reads of the traffic. */
interface PoseReader {
  poseAt(id: number, time: number, out: AmbientPose): AmbientPose;
}

/**
 * A car steering round something that stands in its lane (`swerve.ts`). The
 * side is measured to the right of its lane, as the lane's own offset is, so
 * a car passing into the oncoming lane stands at a negative side.
 */
export interface Swerve {
  /** Metres right of its lane the car stands. */
  side: number;
  /** Metres right of its lane it steers towards. */
  aim: number;
  /** What the side changed by on the last tick. */
  drift: number;
  /** Radians the body is turned from the lane, towards where it steers. */
  yaw: number;
  /** Ticks it has stood behind something in its lane, passing it or not: its patience. */
  blocked: number;
}

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
  /** A car steering round what stands in its lane; absent for anybody on their lane. */
  swerve?: Swerve;
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

/**
 * Where a car of the traffic stands at a moment, held back as far as it has
 * given way and steered as far off its lane as it swerves. Every reader of an
 * ambient car's pose asks through this, as it asks for the tick through
 * {@link heldTime}.
 */
export function heldPose(traffic: PoseReader, holds: Holds, id: number, time: number, out: AmbientPose): AmbientPose {
  traffic.poseAt(id, heldTime(holds, id, time), out);
  return swerveOnto(holds, id, time, out);
}

/**
 * Move a pose read at the held time of a car off its lane as far as the car
 * swerves at that moment. A reader that steps a cursor rather than asking
 * {@link heldPose} calls this on the pose it read.
 */
export function swerveOnto(holds: Holds, id: number, time: number, out: AmbientPose): AmbientPose {
  const swerve = holds.list.length === 0 ? undefined : holdOf(holds, id)?.swerve;
  if (swerve === undefined) return out;
  // Between the last two ticks the side moves from where it stood on the one to the other.
  const back = time >= holds.tick ? 0 : Math.min(1, holds.tick - time);
  const side = swerve.side - swerve.drift * back;
  out.x -= sin(out.heading) * side;
  out.y += cos(out.heading) * side;
  out.heading += swerve.yaw;
  return out;
}

/** What an id's lag changed by on the last tick: 0 for one on its loop's time. */
export function heldStep(holds: Holds, id: number): number {
  if (holds.list.length === 0) return 0;
  return holdOf(holds, id)?.step ?? 0;
}
