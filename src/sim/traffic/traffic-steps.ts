/**
 * The steps of an ambient vehicle's tour and the arithmetic of one drive
 * (spec sections 5.3, 13.1): how many ticks a stretch of road takes a driver,
 * a drive split at a kerb or at a stop line, and the packing of the steps into
 * a {@link Tour}. `traffic-timing.ts` decides where the steps go; the tram's
 * timing (`tram-timing.ts`) lays its own down with the same pieces.
 */
import type { RoadEdge, RoadGraph } from '../../world/roads/graph.ts';
import { TICK_RATE } from '../clock.ts';
import { NO_CALL, type BusRoute } from '../transit/bus.ts';
import type { Driver } from './driver.ts';
import { FREE, rampTicks, throughSpeed } from './traffic-motion.ts';

/** Fraction of the speed limit ambient traffic drives at. */
export const CRUISE = 0.9;

/** One closed route and how it is driven. */
export interface Tour {
  /** The edges in the order they are driven; the last one ends where the first starts. */
  edges: Int32Array;
  /** Metres along the route each leg starts at. */
  startDistance: Float64Array;
  /** Metres once round. */
  length: number;
  /** The leg each step is on. */
  stepLeg: Int32Array;
  /** Metres along its leg each step starts and ends; the same for a wait. */
  stepFrom: Float64Array;
  stepTo: Float64Array;
  /** Ticks each step takes, at least one. */
  stepTicks: Int32Array;
  /** The tick of the route each step starts on. */
  stepStart: Int32Array;
  /** 1 on each step that is a call at a stop on the route: a bus at the kerb (`bus.ts`). */
  stepCall: Uint8Array;
  /**
   * Metres per second the vehicle may run through the join after each leg at:
   * the turn there, and the cruise of the slower of the two roads
   * (`traffic-motion.ts`). {@link FREE} where nothing holds it back.
   */
  turns: Float64Array;
  /** Ticks once round. */
  period: number;
  /**
   * The tick of the signal cycle, 0 to {@link SIGNAL_CYCLE}, that tick 0 of the
   * tour has to fall on; -1 for a tour that meets no signal.
   */
  sync: number;
}

/** The steps of a tour while they are laid down. The tram (`tram-timing.ts`) lays its own down with it. */
export class Steps {
  readonly leg: number[] = [];
  readonly from: number[] = [];
  readonly to: number[] = [];
  readonly ticks: number[] = [];
  /** 1 on a step that is a call at a stop, which is a wait nothing on the road is holding. */
  readonly call: number[] = [];
  tick = 0;

  add(leg: number, from: number, to: number, ticks: number, call = false): void {
    if (ticks <= 0) return;
    this.leg.push(leg);
    this.from.push(from);
    this.to.push(to);
    this.ticks.push(ticks);
    this.call.push(call ? 1 : 0);
    this.tick += ticks;
  }

  /**
   * Spread extra ticks over the drives from step `first` on, in proportion to
   * their ticks. A wait is never grown: a driver held longer at a green they
   * were sent away on, or a bus held longer at a kerb, is a vehicle standing
   * still where nothing is holding it. Where there is no drive left to slow,
   * the extra goes on the last step, since the lap still has to close.
   */
  stretch(first: number, extra: number): void {
    if (extra <= 0) return;
    let total = 0;
    let longest = -1;
    for (let i = first; i < this.ticks.length; i++) {
      if (this.from[i] === this.to[i]) continue;
      total += this.ticks[i] as number;
      if (longest < 0 || (this.ticks[i] as number) > (this.ticks[longest] as number)) longest = i;
    }
    if (longest < 0) {
      const last = this.ticks.length - 1;
      this.ticks[last] = (this.ticks[last] as number) + extra;
      this.tick += extra;
      return;
    }
    let given = 0;
    for (let i = first; i < this.ticks.length; i++) {
      if (this.from[i] === this.to[i]) continue;
      const more = Math.floor((extra * (this.ticks[i] as number)) / total);
      this.ticks[i] = (this.ticks[i] as number) + more;
      given += more;
    }
    this.ticks[longest] = (this.ticks[longest] as number) + extra - given;
    this.tick += extra;
  }

  /** Take back the steps from `first` on, to lay that stretch down again. */
  truncate(first: number): void {
    for (let i = first; i < this.ticks.length; i++) this.tick -= this.ticks[i] as number;
    this.leg.length = first;
    this.from.length = first;
    this.to.length = first;
    this.ticks.length = first;
    this.call.length = first;
  }

  /** Ticks the drives from step `first` on take. */
  ticksFrom(first: number): number {
    let total = 0;
    for (let i = first; i < this.ticks.length; i++) total += this.ticks[i] as number;
    return total;
  }
}

/** Ticks a whole edge takes at a cruising speed, {@link CRUISE} of the limit unless a driver says otherwise. */
export function driveTicks(edge: RoadEdge, cruise: number = CRUISE): number {
  return Math.max(1, Math.round((edge.length / (edge.speedLimit * cruise)) * TICK_RATE));
}

/** A call on one leg: where it stands and for how long, or no call at all. */
export interface Call {
  at: number;
  dwell: number;
}

export const NOTHING: Call = { at: NO_CALL, dwell: 0 };

/** The call on one leg of a route that has been walked for its stops. */
export function callOf(calls: BusRoute | undefined, leg: number): Call {
  if (calls === undefined) return NOTHING;
  return { at: calls.at[leg] as number, dwell: calls.dwell[leg] as number };
}

/**
 * Drive a stretch of a leg, standing at the kerb on the way where the route
 * calls there. `call` is metres along the leg, or {@link NO_CALL}; a call
 * beyond the stretch is one this stretch does not reach.
 */
export function driveLeg(steps: Steps, leg: number, edge: RoadEdge, from: number, to: number, call: Call, driver: Driver, enter = FREE, leave = FREE): void {
  const at = call.at;
  if (at <= from || at >= to) {
    steps.add(leg, from, to, share(edge, to - from, driver, enter, leave));
    return;
  }
  steps.add(leg, from, at, share(edge, at - from, driver, enter, 0));
  steps.add(leg, at, at, call.dwell, true);
  steps.add(leg, at, to, share(edge, to - at, driver, 0, leave));
}

/** Ticks {@link driveLeg} will take over a stretch, before it lays anything down. */
export function legTicks(edge: RoadEdge, from: number, to: number, call: Call, driver: Driver, enter = FREE, leave = FREE): number {
  const at = call.at;
  if (at <= from || at >= to) return share(edge, to - from, driver, enter, leave);
  return share(edge, at - from, driver, enter, 0) + call.dwell + share(edge, to - at, driver, 0, leave);
}

/**
 * Drive from `from` to the end of a leg in two, split at its stop line. A
 * vehicle pulling away from a queue picks up speed as it goes
 * (`traffic-motion.ts`), so inside one drive it would reach the line later than
 * an even speed does. Split there, it crosses on the tick the drive to the line
 * ends, which is the tick the light and the tram guard were read at.
 */
export function overLine(steps: Steps, leg: number, edge: RoadEdge, from: number, stop: number, driver: Driver, enter: number, leave: number): void {
  // A vehicle that stood on the line pulls away in the drive past it.
  const line = stop > from ? throughSpeed(topOf(edge, driver), enter, stop - from, leave, edge.length - stop) : enter;
  steps.add(leg, from, stop, share(edge, stop - from, driver, enter, line));
  steps.add(leg, stop, edge.length, share(edge, edge.length - stop, driver, line, leave));
}

/** Metres per second this driver cruises at on an edge. */
export function topOf(edge: RoadEdge, driver: Driver): number {
  return edge.speedLimit * driver.cruise;
}

/**
 * Ticks a stretch of an edge takes at this driver's cruising speed, rounded up
 * so it never drives faster, and the ticks it loses changing speed from
 * `enter` and to `leave` metres per second at its ends (`traffic-motion.ts`).
 */
export function share(edge: RoadEdge, metres: number, driver: Driver, enter = FREE, leave = FREE): number {
  if (metres <= 0) return 0;
  const even = Math.ceil((driveTicks(edge, driver.cruise) * metres) / edge.length);
  return even + rampTicks(metres, topOf(edge, driver), enter, leave);
}

/** Pack the steps of a route into a {@link Tour}. */
export function finish(graph: RoadGraph, route: readonly number[], steps: Steps, sync: number, turns?: Float64Array): Tour {
  const count = route.length;
  const tour: Tour = {
    edges: Int32Array.from(route),
    startDistance: new Float64Array(count),
    length: 0,
    stepLeg: Int32Array.from(steps.leg),
    stepFrom: Float64Array.from(steps.from),
    stepTo: Float64Array.from(steps.to),
    stepTicks: Int32Array.from(steps.ticks),
    stepStart: new Int32Array(steps.ticks.length),
    stepCall: Uint8Array.from(steps.call),
    turns: turns ?? new Float64Array(route.length).fill(FREE),
    period: 0,
    sync,
  };
  for (let i = 0; i < count; i++) {
    tour.startDistance[i] = tour.length;
    tour.length += (graph.edges[route[i] as number] as RoadEdge).length;
  }
  for (let i = 0; i < steps.ticks.length; i++) {
    tour.stepStart[i] = tour.period;
    tour.period += steps.ticks[i] as number;
  }
  return tour;
}

/** The last index whose value is at or below a number, in an ascending list that starts at 0. */
export function legAt(starts: Int32Array | Float64Array, value: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] as number) <= value) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * The same index as {@link legAt}, trying `hint` and the index after it
 * first. A loop read one tick after another moves on by at most one index,
 * so the last answer given for it is nearly always the right hint.
 */
export function legNear(starts: Int32Array | Float64Array, value: number, hint: number): number {
  const n = starts.length;
  if (hint >= 0 && hint < n && (starts[hint] as number) <= value) {
    if (hint + 1 >= n || (starts[hint + 1] as number) > value) return hint;
    if (hint + 2 >= n || (starts[hint + 2] as number) > value) return hint + 1;
  }
  return legAt(starts, value);
}
