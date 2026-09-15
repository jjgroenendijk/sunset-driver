/**
 * The timing of one ambient vehicle's tour (spec sections 5.3, 13.1): when it
 * drives, and where it waits at a red light.
 *
 * A tour is a list of steps. A step drives a stretch of one leg in a whole
 * number of ticks, or stands still at one place. A tour that meets no signal
 * is one step per leg, at {@link CRUISE} of the speed limit.
 *
 * A tour that meets signals must stay a function of the tick, and a light is a
 * function of the tick too. Both agree for ever only when the tour takes a
 * whole number of signal cycles, so the tour is timed from one stop line, the
 * anchor: tick 0 is the moment its green starts. Every other signal on the way
 * is met at the tick the drive reaches it, and a vehicle that finds it amber
 * or red waits for its green. Back at the anchor, the drive after the last
 * other signal is stretched so the vehicle arrives on amber or red, and it
 * waits there for the green that closes the lap. The anchor is the stop line
 * that needs the least stretch for the length of road it is spread over.
 *
 * Vehicles never read each other, so a queue is estimated: a vehicle that
 * arrives later into a red stops further back, by how many vehicles of the
 * lane's density would have come in before it.
 */
import type { RoadEdge, RoadGraph } from '../world/graph.ts';
import { TICK_RATE } from './clock.ts';
import { SIGNAL_CYCLE, SIGNAL_GREEN, type SignalApproach, type TrafficSignals } from './signals.ts';

/** Fraction of the speed limit ambient traffic drives at. */
export const CRUISE = 0.9;

/** Metres one queued vehicle takes up: a car and the gap behind it. */
export const QUEUE_GAP = 7;

/** Metres of a run the junction behind a queue may take: the back of the queue stops short of it. */
export const QUEUE_CLEAR = 20;

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
  /** Ticks once round. */
  period: number;
  /**
   * The tick of the signal cycle, 0 to {@link SIGNAL_CYCLE}, that tick 0 of the
   * tour has to fall on; -1 for a tour that meets no signal.
   */
  sync: number;
}

/** Vehicles per metre of one lane of an edge, which is how long a queue grows. */
export type Crowd = (edge: RoadEdge) => number;

/** The steps of a tour while they are laid down. The tram (`tram-timing.ts`) lays its own down with it. */
export class Steps {
  readonly leg: number[] = [];
  readonly from: number[] = [];
  readonly to: number[] = [];
  readonly ticks: number[] = [];
  tick = 0;

  add(leg: number, from: number, to: number, ticks: number): void {
    if (ticks <= 0) return;
    this.leg.push(leg);
    this.from.push(from);
    this.to.push(to);
    this.ticks.push(ticks);
    this.tick += ticks;
  }

  /** Spread extra ticks over the drives from step `first` on, in proportion to their ticks. */
  stretch(first: number, extra: number): void {
    if (extra <= 0) return;
    let total = 0;
    let longest = first;
    for (let i = first; i < this.ticks.length; i++) {
      total += this.ticks[i] as number;
      if ((this.ticks[i] as number) > (this.ticks[longest] as number)) longest = i;
    }
    let given = 0;
    for (let i = first; i < this.ticks.length; i++) {
      const more = Math.floor((extra * (this.ticks[i] as number)) / total);
      this.ticks[i] = (this.ticks[i] as number) + more;
      given += more;
    }
    this.ticks[longest] = (this.ticks[longest] as number) + extra - given;
    this.tick += extra;
  }

  /** Ticks the drives from step `first` on take. */
  ticksFrom(first: number): number {
    let total = 0;
    for (let i = first; i < this.ticks.length; i++) total += this.ticks[i] as number;
    return total;
  }
}

/** Ticks a whole edge takes at cruising speed. */
export function driveTicks(edge: RoadEdge): number {
  return Math.max(1, Math.round((edge.length / (edge.speedLimit * CRUISE)) * TICK_RATE));
}

/**
 * The timing of a route. Without signals, or where the route meets none, each
 * leg is one step; otherwise the route is timed from the anchor that stretches
 * it least, and comes back turned so that its first leg follows that anchor.
 */
export function timeTour(graph: RoadGraph, route: readonly number[], signals?: TrafficSignals, crowd: Crowd = () => 0): Tour {
  const count = route.length;
  let best: Plan | undefined;
  if (signals !== undefined) {
    for (let k = 0; k < count; k++) {
      const approach = signals.approachOf(route[k] as number);
      if (approach === undefined) continue;
      const plan = anchoredAt(graph, route, k, approach, signals, crowd);
      if (best === undefined || plan.slow < best.slow) best = plan;
    }
  }
  if (best !== undefined) return finish(graph, best.route, best.steps, best.sync);
  const steps = new Steps();
  for (let i = 0; i < count; i++) {
    const edge = graph.edges[route[i] as number] as RoadEdge;
    steps.add(i, 0, edge.length, driveTicks(edge));
  }
  return finish(graph, route, steps, -1);
}

/** A route timed from one anchor, before it is packed into a {@link Tour}. */
interface Plan {
  route: number[];
  steps: Steps;
  sync: number;
  /** The share of its last drive the stretch to the anchor slows. */
  slow: number;
}

/** The route timed from the stop line of leg `k`. */
function anchoredAt(
  graph: RoadGraph,
  route: readonly number[],
  k: number,
  anchor: SignalApproach,
  signals: TrafficSignals,
  crowd: Crowd,
): Plan {
  const count = route.length;
  const turned: number[] = [];
  for (let i = 1; i <= count; i++) turned.push(route[(k + i) % count] as number);
  const sync = signals.greenStart(anchor);
  const steps = new Steps();
  const last = graph.edges[turned[count - 1] as number] as RoadEdge;
  // Tick 0 is the anchor's green: the vehicle pulls away from its stop line.
  steps.add(count - 1, anchor.stop, last.length, share(last, last.length - anchor.stop));
  let free = 0;
  for (let i = 0; i < count - 1; i++) {
    const edge = graph.edges[turned[i] as number] as RoadEdge;
    const approach = signals.approachOf(edge.id);
    if (approach === undefined) {
      steps.add(i, 0, edge.length, driveTicks(edge));
      continue;
    }
    const arrive = steps.tick + share(edge, approach.stop);
    const wait = mod(signals.greenStart(approach) - sync - arrive, SIGNAL_CYCLE);
    // A light that is green when the vehicle reaches it is driven through.
    const held = signals.light(approach, sync + arrive) !== 'green';
    const green = SIGNAL_GREEN[approach.axis];
    const late = held ? SIGNAL_CYCLE - green - wait : 0;
    const pace = edge.length / driveTicks(edge);
    // No longer than the road, and short enough for its back to reach the line in half the green.
    const queue = held ? Math.min(Math.max(0, approach.stop - QUEUE_CLEAR), (green / 2) * pace, Math.floor(late * crowd(edge) * pace) * QUEUE_GAP) : 0;
    const halt = approach.stop - queue;
    steps.add(i, 0, halt, share(edge, halt));
    if (held) steps.add(i, halt, halt, arrive + wait - steps.tick);
    steps.add(i, halt, edge.length, share(edge, edge.length - halt));
    free = steps.ticks.length;
  }
  steps.add(count - 1, 0, anchor.stop, share(last, anchor.stop));
  // Arrive at the anchor on amber or red, never on its green.
  const early = steps.tick % SIGNAL_CYCLE;
  const green = SIGNAL_GREEN[anchor.axis];
  const extra = early < green ? green - early : 0;
  const slow = extra / (steps.ticksFrom(free) + extra);
  steps.stretch(free, extra);
  steps.add(count - 1, anchor.stop, anchor.stop, SIGNAL_CYCLE - (steps.tick % SIGNAL_CYCLE));
  return { route: turned, steps, sync, slow };
}

/** Ticks a stretch of an edge takes at cruising speed, rounded up so it never drives faster. */
function share(edge: RoadEdge, metres: number): number {
  return metres <= 0 ? 0 : Math.ceil((driveTicks(edge) * metres) / edge.length);
}

/** Pack the steps of a route into a {@link Tour}. */
export function finish(graph: RoadGraph, route: readonly number[], steps: Steps, sync: number): Tour {
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

function mod(value: number, by: number): number {
  return ((value % by) + by) % by;
}
