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
 * Vehicles never read each other, so nothing tells one where the queue at a
 * red light ends. Each takes its own place in it instead, drawn once from its
 * own stream and kept at every light it meets: whole cars back from the line,
 * as far as the road behind the line will hold, and on through a junction
 * without lights onto the road before it. That place is the only thing
 * that holds two vehicles apart, and it holds them apart while they drive too,
 * since a vehicle further back pulls away later and stays behind for the rest
 * of the lap. The lap closes at the anchor the same way, so a light that many
 * tours anchor at spreads them over its approach rather than standing them all
 * on the line.
 *
 * Who is at the wheel is a {@link Driver} from `driver.ts` (spec section 20.2),
 * and it is read here rather than stepped. The driver sets the speed every
 * drive is timed at, the metres each car of the queue takes up, the ticks spent
 * standing after a green before pulling away, and whether an amber is taken or
 * waited out. A personality is therefore a lap timed the way that driver would
 * have driven it, which is what lets it show on the road without a vehicle ever
 * reading the one in front.
 */
import type { RoadEdge, RoadGraph } from '../world/graph.ts';
import { TICK_RATE } from './clock.ts';
import { BUS_DWELL, busCalls, NO_CALL } from './bus.ts';
import { STEADY, type Driver } from './driver.ts';
import { SIGNAL_AMBER, SIGNAL_CYCLE, SIGNAL_GREEN, type SignalApproach, type TrafficSignals } from './signals.ts';

/** Fraction of the speed limit ambient traffic drives at. */
export const CRUISE = 0.9;

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
  /** 1 on each step that is a call at a stop on the route: a bus at the kerb (`bus.ts`). */
  stepCall: Uint8Array;
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

/**
 * The timing of a route. Without signals, or where the route meets none, each
 * leg is one step; otherwise the route is timed from the anchor that stretches
 * it least, and comes back turned so that its first leg follows that anchor.
 *
 * A {@link TourPlan} says who drives it and how.
 */
export function timeTour(graph: RoadGraph, route: readonly number[], signals?: TrafficSignals, plan: TourPlan = {}): Tour {
  const place = plan.place ?? 0;
  const driver = plan.driver ?? STEADY;
  const count = route.length;
  let best: Anchored | undefined;
  if (signals !== undefined) {
    for (let k = 0; k < count; k++) {
      const approach = signals.approachOf(route[k] as number);
      if (approach === undefined) continue;
      const laid = anchoredAt(graph, route, k, approach, signals, place, driver, plan.calls ?? false);
      if (best === undefined || laid.slow < best.slow) best = laid;
    }
  }
  if (best !== undefined) return finish(graph, best.route, best.steps, best.sync);
  const steps = new Steps();
  const calls = plan.calls === true ? busCalls(graph, route, signals) : undefined;
  for (let i = 0; i < count; i++) {
    const edge = graph.edges[route[i] as number] as RoadEdge;
    const call = calls === undefined ? NO_CALL : (calls[i] as number);
    driveLeg(steps, i, edge, 0, edge.length, call, driver);
  }
  return finish(graph, route, steps, -1);
}

/** Who drives a tour and how. */
export interface TourPlan {
  /** Where in a queue this vehicle stands, 0 at the line and 1 at the back of it. */
  place?: number;
  /**
   * Who is at the wheel (`driver.ts`): how fast they cruise, how close they
   * queue, how long they take to pull away on a green and whether they take an
   * amber. The steady driver of the roster when left out.
   */
  driver?: Driver;
  /** True for a vehicle that calls at the stops of its route: a bus (`bus.ts`). */
  calls?: boolean;
}

/**
 * Drive a stretch of a leg, standing at the kerb on the way where the route
 * calls there. `call` is metres along the leg, or {@link NO_CALL}; a call
 * beyond the stretch is one this stretch does not reach.
 */
function driveLeg(steps: Steps, leg: number, edge: RoadEdge, from: number, to: number, call: number, driver: Driver): void {
  if (call <= from || call >= to) {
    steps.add(leg, from, to, share(edge, to - from, driver));
    return;
  }
  steps.add(leg, from, call, share(edge, call - from, driver));
  steps.add(leg, call, call, BUS_DWELL, true);
  steps.add(leg, call, to, share(edge, to - call, driver));
}

/** Ticks {@link driveLeg} will take over a stretch, before it lays anything down. */
function legTicks(edge: RoadEdge, from: number, to: number, call: number, driver: Driver): number {
  if (call <= from || call >= to) return share(edge, to - from, driver);
  return share(edge, call - from, driver) + BUS_DWELL + share(edge, to - call, driver);
}

/** A route timed from one anchor, before it is packed into a {@link Tour}. */
interface Anchored {
  route: number[];
  steps: Steps;
  sync: number;
  /** The share of its last drive the stretch to the anchor slows. */
  slow: number;
}

/** The route timed from the stop line of leg `k`, as `driver` would drive it. */
function anchoredAt(
  graph: RoadGraph,
  route: readonly number[],
  k: number,
  anchor: SignalApproach,
  signals: TrafficSignals,
  place: number,
  driver: Driver,
  calling: boolean,
): Anchored {
  const count = route.length;
  const turned: number[] = [];
  for (let i = 1; i <= count; i++) turned.push(route[(k + i) % count] as number);
  const sync = signals.greenStart(anchor);
  const steps = new Steps();
  const last = graph.edges[turned[count - 1] as number] as RoadEdge;
  // The stops of the turned route, so a bus calls at the same kerbs whichever
  // of its lights the lap ends up anchored at.
  const calls = calling ? busCalls(graph, turned, signals) : undefined;
  const callOn = (leg: number): number => (calls === undefined ? NO_CALL : (calls[leg] as number));
  // The leg a queue for the light at the end of leg `i` may run back onto.
  const spill = (i: number): RoadEdge | undefined => {
    if (i < 1 || callOn(i) !== NO_CALL || callOn(i - 1) !== NO_CALL) return undefined;
    return behind(graph, signals, turned[i - 1] as number, turned[i] as number);
  };
  // Tick 0 is the anchor's green. The driver takes their own moment over it and
  // then pulls away from where they waited, which is their own place back in the
  // queue, on the closing leg or on the leg before it. The stretch below puts
  // them there on amber or red, so no cap on how far back they stand is needed.
  const before = spill(count - 1);
  const back = queueBack(last, before, anchor, place, driver);
  const home = back > anchor.stop ? count - 2 : count - 1;
  const stand = home === count - 1 ? anchor.stop - back : (before as RoadEdge).length - (back - anchor.stop);
  const standing = graph.edges[turned[home] as number] as RoadEdge;
  steps.add(home, stand, stand, driver.react);
  // Where the stretch to the anchor starts. It moves to after every light on
  // the way, since slowing a drive before a light would change the colour the
  // vehicle finds there; only the run from the last light to the anchor is free.
  let free = steps.ticks.length;
  // The leg the queue stands on is driven in two: away from the queue on tick
  // 0, and back round to it at the end of the lap. A call on the closing leg
  // falls in the drive back, since a stop stands near the start of a leg and
  // the queue near its end.
  steps.add(home, stand, standing.length, share(standing, standing.length - stand, driver));
  if (home < count - 1) steps.add(count - 1, 0, last.length, share(last, last.length, driver));
  // The step each leg starts on, so a queue that runs back onto it can lay it again.
  let legFirst = steps.ticks.length;
  for (let i = 0; i < home; i++) {
    const edge = graph.edges[turned[i] as number] as RoadEdge;
    const approach = signals.approachOf(edge.id);
    const call = callOn(i);
    const first = steps.ticks.length;
    if (approach === undefined) {
      driveLeg(steps, i, edge, 0, edge.length, call, driver);
      legFirst = first;
      continue;
    }
    // A call comes before the line, and its dwell is part of how long the drive
    // to the line takes, so the light is read at the tick the bus really gets
    // there. `bus.ts` keeps a stop clear of the queue, so the halt below is
    // always past it and the two never land on the same metre.
    const arrive = steps.tick + legTicks(edge, 0, approach.stop, call, driver);
    const wait = mod(signals.greenStart(approach) - sync - arrive, SIGNAL_CYCLE);
    // A light that is green when the vehicle reaches it is driven through, and
    // so is an amber by a driver who takes ambers. The line is crossed on the
    // tick the drive to it ends, which is the tick the colour was read at, so
    // an amber taken here is an amber the vehicle is really still on.
    const colour = signals.light(approach, sync + arrive);
    const held = colour === 'red' || (colour === 'amber' && !driver.runsAmber);
    if (!held) {
      // Driven in two at the line, so the drive over it starts on the tick
      // the colour was read at. One drive over the whole leg would cross the
      // line a tick early, which on the first tick of a green is still red.
      driveLeg(steps, i, edge, 0, approach.stop, call, driver);
      steps.add(i, approach.stop, edge.length, share(edge, edge.length - approach.stop, driver));
      free = steps.ticks.length;
      legFirst = first;
      continue;
    }
    const prev = spill(i);
    const queued = queueBack(edge, prev, approach, place, driver);
    // Where the vehicle waits: back on the leg before, which is laid again up
    // to the halt, or on this one.
    let leg = i;
    let halt = approach.stop - queued;
    if (prev !== undefined && queued > approach.stop) {
      steps.truncate(legFirst);
      leg = i - 1;
      halt = prev.length - (queued - approach.stop);
    }
    const on = leg === i ? edge : (prev as RoadEdge);
    const drive = steps.ticks.length;
    driveLeg(steps, leg, on, 0, halt, leg === i ? call : NO_CALL, driver);
    // A halt well back in the queue is reached before the line would have
    // been, maybe while the light is still green. The drive to it is slowed
    // instead, so the vehicle comes to rest on the tick after its green ends
    // at the earliest and never stands still on a green.
    steps.stretch(drive, arrive + wait - (SIGNAL_CYCLE - SIGNAL_GREEN[approach.axis]) + 1 - steps.tick);
    steps.add(leg, halt, halt, arrive + wait - steps.tick + driver.react);
    steps.add(leg, halt, on.length, share(on, on.length - halt, driver));
    if (leg < i) steps.add(i, 0, edge.length, share(edge, edge.length, driver));
    free = steps.ticks.length;
    legFirst = first;
  }
  driveLeg(steps, home, standing, 0, stand, callOn(home), driver);
  // Arrive at the back of the anchor's queue on a light this driver will not
  // cross: amber or red for most, and red alone for one who takes ambers. A
  // driver who arrived on an amber they would take would drive over the line
  // instead of closing the lap there.
  const early = steps.tick % SIGNAL_CYCLE;
  const shut = SIGNAL_GREEN[anchor.axis] + (driver.runsAmber ? SIGNAL_AMBER : 0);
  const extra = early < shut ? shut - early : 0;
  const slow = extra / (steps.ticksFrom(free) + extra);
  steps.stretch(free, extra);
  steps.add(home, stand, stand, SIGNAL_CYCLE - (steps.tick % SIGNAL_CYCLE));
  return { route: turned, steps, sync, slow };
}

/**
 * The leg a queue for a light may run back onto: `prev`, which leads into
 * `next`, where the node between them is one a queue may stand in. A queue
 * never runs back onto the same road the other way, which is a turn in the
 * road rather than more of it.
 */
function behind(graph: RoadGraph, signals: TrafficSignals, prev: number, next: number): RoadEdge | undefined {
  const from = graph.edges[prev] as RoadEdge;
  const to = graph.edges[next] as RoadEdge;
  if (from.twin === to.id || signals.keepsClear(to.from)) return undefined;
  return from;
}

/**
 * Metres behind a stop line one vehicle waits: its own place in the queue, in
 * whole cars, at the gap this driver leaves. Two things bound the queue. It
 * never reaches a junction behind it that keeps clear (`keepsClear`): the one
 * the approach starts at, or where the queue may run back onto the leg before
 * (`prev`), the one that leg starts at. And a vehicle at its back still
 * reaches the line within half the green.
 *
 * The place does not depend on when the vehicle arrives, and a short approach
 * does not cut every place down to the same car. Both once stood whole
 * platoons on one spot (issue #357).
 *
 * The queue is counted in cars at the gap a steady driver leaves, so a place
 * is the same car of the queue whoever is at the wheel; what the driver then
 * changes is how far back that car stands. A tailgater is the fourth car half
 * a length off the third, and a careful driver is the fourth car well back.
 * Neither ever stands past the room the approach has, so a queue of careful
 * drivers ends at the last metre that fits rather than out in the junction.
 */
function queueBack(edge: RoadEdge, prev: RoadEdge | undefined, approach: SignalApproach, place: number, driver: Driver): number {
  let pace = edge.length / driveTicks(edge, driver.cruise);
  let road = Math.max(0, approach.stop - QUEUE_CLEAR);
  if (prev !== undefined) {
    pace = Math.min(pace, prev.length / driveTicks(prev, driver.cruise));
    road = approach.stop + Math.max(0, prev.length - QUEUE_CLEAR);
  }
  const room = Math.min(road, (SIGNAL_GREEN[approach.axis] / 2) * pace);
  const cars = Math.floor(place * (Math.floor(room / STEADY.gap) + 1));
  return Math.min(cars * driver.gap, room);
}

/** Ticks a stretch of an edge takes at this driver's cruising speed, rounded up so it never drives faster. */
function share(edge: RoadEdge, metres: number, driver: Driver): number {
  return metres <= 0 ? 0 : Math.ceil((driveTicks(edge, driver.cruise) * metres) / edge.length);
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
    stepCall: Uint8Array.from(steps.call),
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
