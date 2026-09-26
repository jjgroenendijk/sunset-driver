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
import { busCalls, NO_CALL, type BusDemand, type BusRoute } from './bus.ts';
import { STEADY, type Driver } from './driver.ts';
import { SIGNAL_AMBER, SIGNAL_CYCLE, SIGNAL_GREEN, type SignalApproach, type TrafficSignals } from './signals.ts';
import type { TramGuard } from './tram-guard.ts';
import { ACCEL, FREE, rampTicks, throughSpeed } from './traffic-motion.ts';

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
function driveTicks(edge: RoadEdge, cruise: number = CRUISE): number {
  return Math.max(1, Math.round((edge.length / (edge.speedLimit * cruise)) * TICK_RATE));
}

/**
 * The timing of a route. Without signals, or where the route meets none, each
 * leg is one step; otherwise the route is timed from the anchor that stretches
 * it least, and comes back turned so that its first leg follows that anchor.
 *
 * A {@link TourPlan} says who drives it and how. A `guard` holds the turns a
 * tram crosses while it is in the junction (`tram-guard.ts`), and an anchor
 * whose green would send the vehicle into a tram is taken only where every
 * anchor would.
 */
export function timeTour(graph: RoadGraph, route: readonly number[], signals?: TrafficSignals, plan: TourPlan = {}, guard?: TramGuard): Tour {
  const place = plan.place ?? 0;
  const driver = plan.driver ?? STEADY;
  const count = route.length;
  const best = signals === undefined ? undefined : bestAnchor(graph, route, signals, plan, place, driver, guard);
  if (best !== undefined) return finish(graph, best.route, best.steps, best.sync, best.joins);
  const steps = new Steps();
  const calls = plan.calls === true ? busCalls(graph, route, signals, plan.demand) : undefined;
  const joins = joinsOf(graph, route, plan.turns, 0, driver);
  for (let i = 0; i < count; i++) {
    const edge = graph.edges[route[i] as number] as RoadEdge;
    driveLeg(steps, i, edge, 0, edge.length, callOf(calls, i), driver, joins[(i + count - 1) % count] as number, joins[i] as number);
  }
  return finish(graph, route, steps, -1, joins);
}

/**
 * The route timed from each of its lights in turn, and the timing that sends
 * the vehicle into no tram and slows it least. Undefined where the route meets
 * no light.
 */
function bestAnchor(
  graph: RoadGraph,
  route: readonly number[],
  signals: TrafficSignals,
  plan: TourPlan,
  place: number,
  driver: Driver,
  guard: TramGuard | undefined,
): Anchored | undefined {
  const demand = plan.calls === true ? (plan.demand ?? EVEN) : undefined;
  let best: Anchored | undefined;
  for (let k = 0; k < route.length; k++) {
    const approach = signals.approachOf(route[k] as number);
    if (approach === undefined) continue;
    const laid = anchoredAt(graph, route, k, approach, signals, place, driver, demand, guard, plan.turns);
    if (best === undefined || betterAnchor(laid, best)) best = laid;
  }
  return best;
}

/** True where one anchored timing beats another: blocked by no tram first, then slowed least. */
function betterAnchor(laid: Anchored, best: Anchored): boolean {
  return laid.blocked < best.blocked || (laid.blocked === best.blocked && laid.slow < best.slow);
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
  /**
   * The fastest the vehicle takes the turn after each leg of the route, in
   * metres per second (`traffic-motion.ts`). No turn slows it when left out.
   */
  turns?: ArrayLike<number>;
  /**
   * How many people the stops of the route gather, which is how long the bus
   * stands at each of them (`bus.ts`). Every stop the same when left out.
   */
  demand?: BusDemand;
}

/** The demand a plan that names none takes. */
const EVEN: BusDemand = { riders: () => 3 };

/** A call on one leg: where it stands and for how long, or no call at all. */
interface Call {
  at: number;
  dwell: number;
}

const NOTHING: Call = { at: NO_CALL, dwell: 0 };

/** The call on one leg of a route that has been walked for its stops. */
function callOf(calls: BusRoute | undefined, leg: number): Call {
  if (calls === undefined) return NOTHING;
  return { at: calls.at[leg] as number, dwell: calls.dwell[leg] as number };
}

/**
 * Drive a stretch of a leg, standing at the kerb on the way where the route
 * calls there. `call` is metres along the leg, or {@link NO_CALL}; a call
 * beyond the stretch is one this stretch does not reach.
 */
function driveLeg(steps: Steps, leg: number, edge: RoadEdge, from: number, to: number, call: Call, driver: Driver, enter = FREE, leave = FREE): void {
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
function legTicks(edge: RoadEdge, from: number, to: number, call: Call, driver: Driver, enter = FREE, leave = FREE): number {
  const at = call.at;
  if (at <= from || at >= to) return share(edge, to - from, driver, enter, leave);
  return share(edge, at - from, driver, enter, 0) + call.dwell + share(edge, to - at, driver, 0, leave);
}

/**
 * The speed the route may run through the join after each of its legs at,
 * from the turns of a plan for the route as it was walked, `turn` legs round
 * from this one: the turn, and the cruise of the slower of the two roads.
 */
function joinsOf(graph: RoadGraph, route: readonly number[], turns: ArrayLike<number> | undefined, turn: number, driver: Driver): Float64Array {
  const count = route.length;
  const joins = new Float64Array(count);
  const top = (i: number): number => (graph.edges[route[i % count] as number] as RoadEdge).speedLimit * driver.cruise;
  for (let i = 0; i < count; i++) {
    const bend = turns === undefined ? FREE : (turns[(i + turn) % count] as number);
    joins[i] = Math.min(bend, top(i), top(i + 1));
  }
  return joins;
}

/** A route timed from one anchor, before it is packed into a {@link Tour}. */
interface Anchored {
  route: number[];
  steps: Steps;
  sync: number;
  /** The share of its last drive the stretch to the anchor slows. */
  slow: number;
  /** 1 where the vehicle pulls away from the anchor into a tram, else 0. */
  blocked: number;
  /** The speed of the join after each leg of `route` (`joinsOf`). */
  joins: Float64Array;
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
  demand: BusDemand | undefined,
  guard: TramGuard | undefined,
  turns: ArrayLike<number> | undefined,
): Anchored {
  const count = route.length;
  const turned: number[] = [];
  for (let i = 1; i <= count; i++) turned.push(route[(k + i) % count] as number);
  const joins = joinsOf(graph, turned, turns, k + 1, driver);
  // The speed the vehicle runs into leg `i` at, out of the join before it.
  const into = (i: number): number => joins[(i + count - 1) % count] as number;
  const out = (i: number): number => joins[i] as number;
  const sync = signals.greenStart(anchor);
  const steps = new Steps();
  const last = graph.edges[turned[count - 1] as number] as RoadEdge;
  // The stops of the turned route, so a bus calls at the same kerbs whichever
  // of its lights the lap ends up anchored at.
  const calls = demand === undefined ? undefined : busCalls(graph, turned, signals, demand);
  const callOn = (leg: number): Call => callOf(calls, leg);
  // The leg a queue for the light at the end of leg `i` may run back onto.
  const spill = (i: number): RoadEdge | undefined => {
    if (i < 1 || callOn(i).at !== NO_CALL || callOn(i - 1).at !== NO_CALL) return undefined;
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
  // The tick the vehicle crosses the anchor's line, which a tram may be crossing too.
  const reach =
    home === count - 1
      ? share(last, anchor.stop - stand, driver, 0)
      : share(standing, standing.length - stand, driver, 0, out(home)) + share(last, anchor.stop, driver, out(home));
  const blocked = guard?.blocks(anchor.edge, turned[0] as number, sync + driver.react + reach) === true ? 1 : 0;
  // Where the stretch to the anchor starts. It moves to after every light on
  // the way, since slowing a drive before a light would change the colour the
  // vehicle finds there; only the run from the last light to the anchor is free.
  const free = steps.ticks.length;
  // The leg the queue stands on is driven in two: away from the queue on tick
  // 0, and back round to it at the end of the lap. A call on the closing leg
  // falls in the drive back, since a stop stands near the start of a leg and
  // the queue near its end.
  if (home < count - 1) {
    steps.add(home, stand, standing.length, share(standing, standing.length - stand, driver, 0, out(home)));
    overLine(steps, count - 1, last, 0, anchor.stop, driver, out(home), out(count - 1));
  } else {
    overLine(steps, home, last, stand, anchor.stop, driver, 0, out(home));
  }
  const lap: Lap = { graph, turned, signals, guard, sync, place, driver, steps, into, out, callOn, spill, free, legFirst: steps.ticks.length };
  for (let i = 0; i < home; i++) layLeg(lap, i);
  driveLeg(steps, home, standing, 0, stand, callOn(home), driver, into(home), 0);
  // Arrive at the back of the anchor's queue on a light this driver will not
  // cross: amber or red for most, and red alone for one who takes ambers. A
  // driver who arrived on an amber they would take would drive over the line
  // instead of closing the lap there.
  const early = steps.tick % SIGNAL_CYCLE;
  const shut = SIGNAL_GREEN[anchor.axis] + (driver.runsAmber ? SIGNAL_AMBER : 0);
  const extra = early < shut ? shut - early : 0;
  const slow = extra / (steps.ticksFrom(lap.free) + extra);
  steps.stretch(lap.free, extra);
  steps.add(home, stand, stand, SIGNAL_CYCLE - (steps.tick % SIGNAL_CYCLE));
  return { route: turned, steps, sync, slow, blocked, joins };
}

/** What the legs of one anchored lap share while {@link anchoredAt} lays them down. */
interface Lap {
  graph: RoadGraph;
  turned: readonly number[];
  signals: TrafficSignals;
  guard: TramGuard | undefined;
  sync: number;
  place: number;
  driver: Driver;
  steps: Steps;
  /** The speed the vehicle runs into leg `i` at, out of the join before it. */
  into: (i: number) => number;
  /** The speed the vehicle runs out of leg `i` at, into the join after it. */
  out: (i: number) => number;
  callOn: (leg: number) => Call;
  /** The leg a queue for the light at the end of leg `i` may run back onto. */
  spill: (i: number) => RoadEdge | undefined;
  /** The step the stretch to the anchor starts on: after the last light on the way. */
  free: number;
  /** The step each leg starts on, so a queue that runs back onto it can lay it again. */
  legFirst: number;
}

/** Where a vehicle held at a light waits: the leg it stands on, the metres along it, and whether that is the leg before. */
interface Hold {
  on: RoadEdge;
  halt: number;
  spilt: boolean;
}

/** Lay down leg `i` of an anchored lap, meeting the light at its end if it has one. */
function layLeg(lap: Lap, i: number): void {
  const { graph, turned, signals, guard, sync, driver, steps } = lap;
  const edge = graph.edges[turned[i] as number] as RoadEdge;
  const approach = signals.approachOf(edge.id);
  const call = lap.callOn(i);
  const first = steps.ticks.length;
  if (approach === undefined) {
    driveLeg(steps, i, edge, 0, edge.length, call, driver, lap.into(i), lap.out(i));
    lap.legFirst = first;
    return;
  }
  // A call comes before the line, and its dwell is part of how long the drive
  // to the line takes, so the light is read at the tick the bus really gets
  // there. `bus.ts` keeps a stop clear of the queue, so the halt below is
  // always past it and the two never land on the same metre.
  // The speed a vehicle that meets a green crosses the line at.
  const called = call.at > 0 && call.at < approach.stop;
  const line = throughSpeed(topOf(edge, driver), called ? 0 : lap.into(i), approach.stop - (called ? call.at : 0), lap.out(i), edge.length - approach.stop);
  const arrive = steps.tick + legTicks(edge, 0, approach.stop, call, driver, lap.into(i), line);
  const wait = mod(signals.greenStart(approach) - sync - arrive, SIGNAL_CYCLE);
  // A light that is green when the vehicle reaches it is driven through, and
  // so is an amber by a driver who takes ambers. The line is crossed on the
  // tick the drive to it ends, which is the tick the colour was read at, so
  // an amber taken here is an amber the vehicle is really still on. A turn a
  // tram is crossing is held as a red is, unless no green ever lets it
  // through clear of the tram, which is a tram standing in the junction.
  const colour = signals.light(approach, sync + arrive);
  const next = turned[i + 1] as number;
  const red = colour === 'red' || (colour === 'amber' && !driver.runsAmber);
  const guarded = guard !== undefined && guard.guards(edge.id);
  const tram = guarded && !red && guard.blocks(edge.id, next, sync + arrive);
  let hold: Hold | undefined;
  let clear: number | undefined;
  if (red || tram) {
    hold = holdOf(lap, i, edge, approach);
    if (guarded) clear = release(signals, guard, approach, next, sync, arrive, toLineFrom(lap, i, edge, approach, hold), driver);
  }
  if (hold === undefined || (!red && clear === undefined)) {
    // Driven in two at the line, so the drive over it starts on the tick
    // the colour was read at. One drive over the whole leg would cross the
    // line a tick early, which on the first tick of a green is still red.
    driveLeg(steps, i, edge, 0, approach.stop, call, driver, lap.into(i), line);
    steps.add(i, approach.stop, edge.length, share(edge, edge.length - approach.stop, driver, line, lap.out(i)));
  } else {
    // A halt well back in the queue is reached before the line would have
    // been, maybe while the light is still green. The drive to it is slowed
    // instead, so the vehicle comes to rest on the tick after its green ends
    // at the earliest and never stands still on a green. One held on a green
    // by a tram comes to rest no earlier than it would have reached the line.
    const rest = colour === 'green' ? arrive : arrive + wait - (SIGNAL_CYCLE - SIGNAL_GREEN[approach.axis]) + 1;
    waitAtLight(lap, i, edge, approach, hold, call, rest, clear ?? arrive + wait);
  }
  lap.free = steps.ticks.length;
  lap.legFirst = first;
}

/**
 * Where a vehicle held at the light at the end of leg `i` waits: its own place
 * back in the queue, on this leg or back on the leg before.
 */
function holdOf(lap: Lap, i: number, edge: RoadEdge, approach: SignalApproach): Hold {
  const prev = lap.spill(i);
  const queued = queueBack(edge, prev, approach, lap.place, lap.driver);
  if (prev !== undefined && queued > approach.stop) return { on: prev, halt: prev.length - (queued - approach.stop), spilt: true };
  return { on: edge, halt: approach.stop - queued, spilt: false };
}

/** The ticks from pulling away at a hold to crossing the line of leg `i`. */
function toLineFrom(lap: Lap, i: number, edge: RoadEdge, approach: SignalApproach, hold: Hold): number {
  const { on, halt } = hold;
  const driver = lap.driver;
  return (
    driver.react +
    (hold.spilt ? share(on, on.length - halt, driver, 0, lap.into(i)) + share(edge, approach.stop, driver, lap.into(i)) : share(edge, approach.stop - halt, driver, 0))
  );
}

/**
 * Drive to a hold, come to rest there on tick `rest` at the earliest, stand
 * until tick `go`, and pull away over the line of leg `i`.
 */
function waitAtLight(lap: Lap, i: number, edge: RoadEdge, approach: SignalApproach, hold: Hold, call: Call, rest: number, go: number): void {
  const { steps, driver } = lap;
  const { on, halt } = hold;
  // A queue back on the leg before lays that leg again up to the halt.
  if (hold.spilt) steps.truncate(lap.legFirst);
  const leg = hold.spilt ? i - 1 : i;
  const drive = steps.ticks.length;
  driveLeg(steps, leg, on, 0, halt, leg === i ? call : NOTHING, driver, lap.into(leg), 0);
  steps.stretch(drive, rest - steps.tick);
  steps.add(leg, halt, halt, go - steps.tick + driver.react);
  if (leg < i) {
    steps.add(leg, halt, on.length, share(on, on.length - halt, driver, 0, lap.out(leg)));
    overLine(steps, i, edge, 0, approach.stop, driver, lap.out(leg), lap.out(i));
  } else {
    overLine(steps, i, edge, halt, approach.stop, driver, 0, lap.out(i));
  }
}

/**
 * The tick of the lap a vehicle held at a light pulls away on, where a tram
 * may cross its turn: the first tick from `arrive` that is green and brings it
 * to the line `toLine` ticks later with no tram in the junction and on a
 * colour it may cross on. Undefined where no such tick comes within two
 * cycles, which is a turn the windows leave no room for.
 */
function release(
  signals: TrafficSignals,
  guard: TramGuard,
  approach: SignalApproach,
  next: number,
  sync: number,
  arrive: number,
  toLine: number,
  driver: Driver,
): number | undefined {
  const green = arrive + mod(signals.greenStart(approach) - sync - arrive, SIGNAL_CYCLE);
  const windows = guard.windows(approach.edge, next);
  if (windows.length === 0) return green;
  const clears = (at: number): boolean => {
    if (signals.light(approach, sync + at) !== 'green') return false;
    const line = sync + at + toLine;
    const colour = signals.light(approach, line);
    if (colour === 'red' || (colour === 'amber' && !driver.runsAmber)) return false;
    return !guard.blocks(approach.edge, next, line);
  };
  // Pulling away on the green, or on the tick that brings the vehicle to the
  // line as a window closes, over two cycles.
  const candidates = [arrive, green, green + SIGNAL_CYCLE];
  for (let w = 0; w < windows.length; w += 2) {
    const end = (windows[w] as number) + (windows[w + 1] as number);
    const first = arrive + mod(end - toLine - sync - arrive, SIGNAL_CYCLE);
    candidates.push(first, first + SIGNAL_CYCLE);
  }
  candidates.sort((a, b) => a - b);
  for (const at of candidates) if (clears(at)) return at;
  return undefined;
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
 * reaches the line within half the green, pulling away from rest.
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
  // Pulling away from rest loses the ticks half the climb to cruise takes (`traffic-motion.ts`).
  const lose = Math.ceil((topOf(edge, driver) / (2 * ACCEL)) * TICK_RATE);
  const room = Math.min(road, Math.max(0, SIGNAL_GREEN[approach.axis] / 2 - lose) * pace);
  const cars = Math.floor(place * (Math.floor(room / STEADY.gap) + 1));
  return Math.min(cars * driver.gap, room);
}

/**
 * Drive from `from` to the end of a leg in two, split at its stop line. A
 * vehicle pulling away from a queue picks up speed as it goes
 * (`traffic-motion.ts`), so inside one drive it would reach the line later than
 * an even speed does. Split there, it crosses on the tick the drive to the line
 * ends, which is the tick the light and the tram guard were read at.
 */
function overLine(steps: Steps, leg: number, edge: RoadEdge, from: number, stop: number, driver: Driver, enter: number, leave: number): void {
  // A vehicle that stood on the line pulls away in the drive past it.
  const line = stop > from ? throughSpeed(topOf(edge, driver), enter, stop - from, leave, edge.length - stop) : enter;
  steps.add(leg, from, stop, share(edge, stop - from, driver, enter, line));
  steps.add(leg, stop, edge.length, share(edge, edge.length - stop, driver, line, leave));
}

/** Metres per second this driver cruises at on an edge. */
function topOf(edge: RoadEdge, driver: Driver): number {
  return edge.speedLimit * driver.cruise;
}

/**
 * Ticks a stretch of an edge takes at this driver's cruising speed, rounded up
 * so it never drives faster, and the ticks it loses changing speed from
 * `enter` and to `leave` metres per second at its ends (`traffic-motion.ts`).
 */
function share(edge: RoadEdge, metres: number, driver: Driver, enter = FREE, leave = FREE): number {
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

function mod(value: number, by: number): number {
  return ((value % by) + by) % by;
}
