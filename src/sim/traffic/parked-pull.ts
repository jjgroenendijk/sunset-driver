/**
 * A parked car pulling into its bay and out of it (spec section 20.2).
 *
 * `parked.ts` cuts the time at a bay into stays. A car on a street bay spends
 * the first {@link PULL_TICKS} of its stay pulling in from the lane and the last
 * {@link PULL_TICKS} pulling out into it. Between the two it stands still. Like
 * the stay, the manoeuvre is a pure function of the tick: nothing is stepped
 * and nothing is stored.
 *
 * The car comes up the lane from behind the bay and swings in to the kerb. It
 * leaves forwards the same way, out into the lane ahead of the bay. A bay in a
 * car park or on an airfield has no lane beside it, so its car stands still for
 * the whole stay, as before.
 */
import { atan2, cos, sin } from '../../core/libm.ts';
import { TICK_RATE } from '../clock.ts';

/** Ticks a car takes to pull into a street bay, and to pull out of one. */
export const PULL_TICKS = 4 * TICK_RATE;

/**
 * Metres from the middle of a street bay to the middle of the lane beside it:
 * half the parking strip and half a lane of a street (`TIERS.street`).
 */
export const PULL_ACROSS = 2.8;

/** Metres along the kerb the car drives while it pulls in or out. */
export const PULL_ALONG = 8;

/** Where a parked car stands on the map, and which way it faces. */
export interface ParkedPose {
  x: number;
  y: number;
  heading: number;
  /** True while the car is pulling in or out, and false while it stands in the bay. */
  moving: boolean;
}

/**
 * How far through its manoeuvre a car is: -1 to 0 while it pulls in, 0 while it
 * stands, and 0 to 1 while it pulls out. `into` is the ticks since the stay
 * started and `stay` the ticks the stay lasts.
 */
export function pullPhase(into: number, stay: number): number {
  if (stay < 2 * PULL_TICKS) return 0;
  if (into < PULL_TICKS) return into / PULL_TICKS - 1;
  const left = stay - into;
  return left < PULL_TICKS ? 1 - left / PULL_TICKS : 0;
}

/**
 * The next tick, as ticks since the stay started, on which the pose has to be
 * read again: the next tick while the car moves, and the start of its pull out
 * while it stands.
 */
export function pullChange(into: number, stay: number): number {
  if (stay < 2 * PULL_TICKS) return stay;
  if (into < PULL_TICKS || into >= stay - PULL_TICKS) return into + 1;
  return stay - PULL_TICKS;
}

/**
 * The pose of a car at a phase of {@link pullPhase}, standing in a street bay
 * at `(x, y)` that faces `heading`. The lane is on the car's left: a street
 * bay stands inside the kerb on the right of the traffic it faces with.
 */
export function pullPose(x: number, y: number, heading: number, phase: number, out: ParkedPose): ParkedPose {
  const fx = cos(heading);
  const fy = sin(heading);
  out.moving = phase !== 0;
  if (phase === 0) {
    out.x = x;
    out.y = y;
    out.heading = heading;
    return out;
  }
  // The distance covered eases from rest into the bay, and from the bay to a
  // roll, so the car neither starts nor stops dead.
  const t = ease(phase < 0 ? phase + 1 : phase);
  // `along` is metres ahead of the bay, `across` metres out towards the lane,
  // and `slope` is the rate of `across` over `t`.
  const along = phase < 0 ? -PULL_ALONG * (1 - t) : PULL_ALONG * t;
  const across = PULL_ACROSS * (phase < 0 ? 1 - ease(t) : ease(t));
  const slope = PULL_ACROSS * 6 * t * (1 - t) * (phase < 0 ? -1 : 1);
  // The lane lies at `(sin h, -cos h)` from the bay, on the car's left.
  out.x = x + fx * along + fy * across;
  out.y = y + fy * along - fx * across;
  out.heading = heading + atan2(-slope, PULL_ALONG);
  return out;
}

function ease(t: number): number {
  return t * t * (3 - 2 * t);
}
