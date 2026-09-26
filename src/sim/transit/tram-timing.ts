/**
 * The timing of the tram's loop (spec section 13.2): when it drives, where it
 * calls, and where it waits for a light.
 *
 * The loop is laid down as the steps of a traffic tour (`traffic-timing.ts`):
 * a drive over part of a run in a whole number of ticks, or a wait in one
 * place. The tram halts short of every junction that has a stop, a light or a
 * level crossing. At a stop it stands for {@link DWELL}. At a light it goes on
 * only with {@link TRAM_CLEAR} of its green left, so the tram is off the
 * crossing before the traffic across it gets its own green. That is what makes
 * a level crossing one that traffic obeys: the traffic keeps to the lights,
 * and the tram never crosses on theirs.
 *
 * A run too short to hold the whole tram at its light is cramped: a tram that
 * waits there leaves its tail across the junction behind it. That is harmless
 * only until the traffic across that junction gets its green. So at every
 * light the tram tries each wait out over the cramped runs ahead, and takes
 * the shortest one that keeps its tail out of their junctions on the green
 * across them, or else the one that leaves it there least. At a light it
 * could run past, it halts too where running on would do worse.
 *
 * A light is a function of the tick, so the loop has to take a whole number of
 * signal cycles to agree with the lights for ever. Tick 0 is the tram pulling
 * away from the first stop on the green of that stop's light; the dwell back
 * at the first stop is stretched so the lap ends on that green again.
 */
import type { RoadEdge, RoadGraph } from '../../world/roads/graph.ts';
import type { TramStop } from '../../world/types.ts';
import { TICK_RATE } from '../clock.ts';
import { SIGNAL_AMBER, SIGNAL_CLEAR, SIGNAL_CYCLE, SIGNAL_GREEN, STOP_BACK, type SignalApproach, type TrafficSignals } from '../traffic/signals.ts';
import { CRUISE, finish, Steps, type Tour } from '../traffic/traffic-timing.ts';
import { TRAM_ACCEL, tramDriveTicks, tramJoins, TramMotion } from './tram-motion.ts';
import { placeTramStops } from './tram-stop-place.ts';

/** Metres per second the tram drives at most: a street tram, not a train. */
const TRAM_TOP = 50 / 3.6;

/** Ticks the tram stands at a stop. */
export const DWELL = 20 * TICK_RATE;

/** Ticks of green the tram needs left at a light to go on: the time it takes to clear the junction. */
export const TRAM_CLEAR = 7 * TICK_RATE;

/** Metres short of a junction's middle the tram halts where no stop line says where. */
const HALT_SHORT = 14;

/** Metres short of the stop line its front halts at. */
const LINE_GAP = 1;

/** Metres of a run the junction behind a halted tram may take, which its tail has to stay clear of. */
const BEHIND_CLEAR = 15;

/**
 * Metres further back a tram halts at a stop than at a plain light. The
 * platform ends where the tram's front does, so this keeps it clear of the
 * junction ahead, where a car turning off starts to swing across the road.
 */
const STOP_CLEAR = 8;

/** Metres per second the slowest a tram rolls through a light rather than stopping at it, and the step it slows by. */
const ROLL = 4;
const ROLL_STEP = 1.5;

/**
 * Metres short of its light within which a stop is taken to stand at the
 * light: the tram waits for the light where it calls, rather than calling and
 * then creeping up to the line.
 */
const MERGE = 12;

/** Ticks between the waits the tram tries at a halt, for one that keeps its tail out of the junctions ahead. */
const SETTLE_STEP = TICK_RATE / 4;

/** One call at a stop: when the tram arrives and leaves, as ticks of its loop, and where its front stands. */
export interface TramCall {
  stop: number;
  arrive: number;
  depart: number;
  /** Metres round the loop the front of the tram stands at while it calls. */
  front: number;
}

/** The loop and what happens on it. */
export interface TramTiming {
  tour: Tour;
  /** 1 on each step the bell rings at the start of: each drive out of a halt, over a crossing or away from a stop. */
  bell: Uint8Array;
  /** The calls in the order the tram makes them, one per stop. */
  calls: TramCall[];
  /** Where the front is inside each step: the tram eases out of a halt and into the next. */
  motion: TramMotion;
}

/** Metres per second the tram drives a run at. */
function tramSpeed(edge: RoadEdge): number {
  return Math.min(edge.speedLimit * CRUISE, TRAM_TOP);
}

/**
 * Time the loop of runs `route` for a tram `length` metres long, calling at
 * `stops` and halting at every node of `crossings` and at every light of
 * `signals`. Pure: the same inputs give the same timing.
 */
export function timeTram(
  graph: RoadGraph,
  route: readonly number[],
  length: number,
  stops: readonly Pick<TramStop, 'id' | 'leaves'>[],
  crossings: readonly number[],
  signals?: TrafficSignals,
): TramTiming {
  const count = route.length;
  // The stop the tram calls at on each run, or -1, and where on the run its front halts.
  const arrives = new Int32Array(count).fill(-1);
  const stopHalt = new Float64Array(count).fill(Number.NaN);
  const placed = placeTramStops(graph, route, stops, length);
  stops.forEach((stop, i) => {
    const place = placed[i];
    const leg = place?.leg ?? (stop.leaves - 1 + count) % count;
    arrives[leg] = stop.id;
    if (place !== undefined) stopHalt[leg] = place.halt;
  });
  const level = new Uint8Array(graph.nodes.length);
  for (const node of crossings) level[node] = 1;

  const edgeOf = (leg: number): RoadEdge => graph.edges[route[leg] as number] as RoadEdge;
  // The lap starts and ends on the run the first stop is called at.
  const home = Math.max(0, arrives.indexOf(stops[0]?.id ?? 0));
  const anchor = signals?.approachOf(edgeOf(home).id);
  const sync = anchor === undefined || signals === undefined ? 0 : signals.greenStart(anchor);
  const steps = new Steps();
  const bells: number[] = [];
  const calls: TramCall[] = [];
  let distance = 0;
  const starts: number[] = [];
  for (let leg = 0; leg < count; leg++) {
    starts.push(distance);
    distance += edgeOf(leg).length;
  }

  const joins = tramJoins(graph, route, tramSpeed);
  const topOf = (leg: number): number => tramSpeed(edgeOf(leg));
  /** The speed each step is left at, which is the one the next is entered at: 0 into a halt. */
  const leaves: number[] = [];
  /** How fast the tram is going at the end of the steps laid so far. */
  let speed = 0;
  const add = (leg: number, from: number, to: number, ticks: number, leave: number): boolean => {
    const before = steps.ticks.length;
    steps.add(leg, from, to, ticks);
    if (steps.ticks.length === before) return false;
    leaves.push(leave);
    speed = leave;
    return true;
  };
  /** Lay a drive. Its bell rings where `bell` says, and wherever the tram pulls away from rest. */
  const drive = (leg: number, from: number, to: number, leave: number, bell: boolean): void => {
    const ring = bell || speed === 0;
    if (ring) bells.push(steps.ticks.length);
    // No faster at the end than the tram can reach over the drive.
    const reached = Math.min(leave, Math.sqrt(speed * speed + 2 * TRAM_ACCEL * (to - from)));
    const laid = add(leg, from, to, tramDriveTicks(to - from, topOf(leg), speed, reached), reached);
    if (ring && !laid) bells.pop();
  };
  /** Metres along a run the tram halts at for the light or the level crossing at its end, or undefined. */
  const lineOf = (leg: number): number | undefined => {
    const edge = edgeOf(leg);
    const approach = signals?.approachOf(edge.id);
    if (approach === undefined && level[edge.to] !== 1) return undefined;
    const line = approach === undefined ? edge.length - HALT_SHORT : approach.stop + STOP_BACK - LINE_GAP;
    return Math.min(edge.length, Math.max(0, line));
  };
  /** Metres along a run the tram calls at a stop, or undefined where it has none there. */
  const stopOf = (leg: number): number | undefined => {
    if ((arrives[leg] as number) < 0) return undefined;
    const placedHalt = stopHalt[leg] as number;
    if (!Number.isNaN(placedHalt)) return placedHalt;
    // No stretch held the platform: it halts short of the line, but never so far that the tail reaches the junction behind.
    const line = lineOf(leg) ?? edgeOf(leg).length - HALT_SHORT;
    return Math.min(edgeOf(leg).length, Math.max(0, Math.min(line, length + BEHIND_CLEAR), line - STOP_CLEAR));
  };
  /** True where a stop stands so near its light that the tram waits for the light at the stop itself. */
  const merged = (leg: number): boolean => {
    const stop = stopOf(leg);
    const line = lineOf(leg);
    return stop !== undefined && line !== undefined && line - stop < MERGE;
  };
  const halts = (leg: number): boolean => stopOf(leg) !== undefined || lineOf(leg) !== undefined;
  /** The speed the tram runs past a line at when it does not stop: no faster than it can brake to the join from. */
  const passOf = (leg: number, at: number): number =>
    Math.min(topOf(leg), Math.sqrt((joins[leg] as number) ** 2 + 2 * TRAM_ACCEL * (edgeOf(leg).length - at)));
  const cramped = (leg: number): boolean => {
    const line = lineOf(leg);
    return stopOf(leg) === undefined && signals?.approachOf(edgeOf(leg).id) !== undefined && line !== undefined && line < length + BEHIND_CLEAR;
  };
  /** Ticks the tram waits at the light of a run it reaches on an absolute tick, or none where the run has no light. */
  const ownWait = (leg: number, tick: number): number => {
    const light = signals?.approachOf(edgeOf(leg).id);
    return light === undefined || signals === undefined ? 0 : waitFor(signals, light, tick);
  };
  /** Lay a whole run. */
  const lay = (leg: number): void => {
    if (stopOf(leg) === undefined) onward(leg, 0, false);
    else onward(leg, call(leg, false), true);
  };
  /** Ticks the tail stands in the junction behind a halt on the green across it: {@link tailAt}. */
  const tailExposed = (leg: number, at: number, tick: number, ticks: number): number =>
    signals === undefined ? 0 : tailAt(signals, edgeOf((leg + count - 1) % count).id, length, at, tick, ticks);
  /** True while a choice is being tried out, when the tram keeps to its own lights and chooses nothing. */
  let trying = false;
  /**
   * Try `rest`, which lays the rest of run `leg`, then the cramped runs after
   * it up to the next place the tram halts clear of a junction. Return the
   * ticks its tail stands in a junction on the green across it, and take the
   * steps back.
   */
  const exposure = (leg: number, rest: () => void): number => {
    const first = steps.ticks.length;
    const start = steps.tick;
    const was = speed;
    const rung = bells.length;
    trying = true;
    rest();
    for (let next = (leg + 1) % count; next !== home && (!halts(next) || cramped(next)); next = (next + 1) % count) lay(next);
    trying = false;
    let exposed = 0;
    for (let i = first, tick = start; i < steps.ticks.length; tick += steps.ticks[i] as number, i++) {
      if (steps.from[i] === steps.to[i]) exposed += tailExposed(steps.leg[i] as number, steps.to[i] as number, sync + tick, steps.ticks[i] as number);
    }
    rewind(first, rung, was);
    return exposed;
  };
  /** Take back the steps from `first` on, and the bells rung on them. */
  const rewind = (first: number, rung: number, was: number): void => {
    steps.truncate(first);
    leaves.length = first;
    bells.length = rung;
    speed = was;
  };
  /**
   * The ticks to wait at `at` metres along a run before driving on, and the
   * ticks the tail then stands in a junction on the green across it: at the
   * run's own light where `own` says the tram stands at it, and at the cramped
   * lights it drives on to. The shortest wait that keeps the tail out of
   * every junction, or else the one that leaves it there least.
   */
  const settle = (leg: number, at: number, own: boolean): { wait: number; exposed: number } => {
    const now = sync + steps.tick;
    const first = own ? ownWait(leg, now) : 0;
    const best = { wait: first, exposed: 0 };
    if (signals === undefined || trying) return best;
    best.exposed = Number.POSITIVE_INFINITY;
    for (let wait = first; wait < first + SIGNAL_CYCLE; wait += SETTLE_STEP) {
      if (own && ownWait(leg, now + wait) !== 0) break;
      const exposed = exposure(leg, () => {
        add(leg, at, at, wait, 0);
        drive(leg, at, edgeOf(leg).length, joins[leg] as number, true);
      });
      if (exposed < best.exposed) {
        best.exposed = exposed;
        best.wait = wait;
      }
      if (exposed === 0) break;
    }
    return best;
  };
  /**
   * Drive from `from` up to the light or the crossing of a run. Where its
   * light is green as the tram comes up, it runs past without braking, slowing
   * if that meets the green; otherwise it halts at the line and waits. It
   * halts on a green too where a wait keeps its tail out of the junctions
   * of the cramped lights ahead better than running on does.
   */
  const toLine = (leg: number, from: number, bell: boolean): number => {
    const line = lineOf(leg) as number;
    const roll = (through: number): void => drive(leg, from, line, through, bell);
    let pass = 0;
    let passed = Number.POSITIVE_INFINITY;
    // As fast as it may, or slower to meet a light that is about to turn green, but never crawling.
    for (let through = passOf(leg, line); through >= ROLL && passed > 0; through -= ROLL_STEP) {
      const reach = tramDriveTicks(line - from, topOf(leg), speed, through);
      if (ownWait(leg, sync + steps.tick + reach) !== 0) continue;
      const exposed = trying ? 0 : exposure(leg, () => {
        roll(through);
        drive(leg, line, edgeOf(leg).length, joins[leg] as number, true);
      });
      if (exposed < passed) {
        pass = through;
        passed = exposed;
      }
    }
    if (passed === 0) {
      roll(pass);
      return line;
    }
    const first = steps.ticks.length;
    const rung = bells.length;
    const was = speed;
    roll(0);
    const halt = settle(leg, line, true);
    if (passed <= halt.exposed) {
      rewind(first, rung, was);
      roll(pass);
    } else add(leg, line, line, halt.wait, 0);
    return line;
  };
  /** Drive from the start of a run to its stop and call there. The closing run waits for the end of the lap instead. */
  const call = (leg: number, closing: boolean): number => {
    const stop = stopOf(leg) as number;
    drive(leg, 0, stop, 0, false);
    const at = steps.tick;
    add(leg, stop, stop, DWELL, 0);
    if (closing) add(leg, stop, stop, mod(-steps.tick, SIGNAL_CYCLE), 0);
    // A light further on is waited for at its own line; one at the stop is waited for here.
    else if (merged(leg) || lineOf(leg) === undefined) add(leg, stop, stop, settle(leg, stop, merged(leg)).wait, 0);
    calls.push({ stop: arrives[leg] as number, arrive: at, depart: steps.tick, front: (starts[leg] as number) + stop });
    return stop;
  };
  /** The rest of a run from its stop, or from its start: up to its light, and on to its end. */
  const onward = (leg: number, from: number, bell: boolean): void => {
    let at = from;
    let ring = bell;
    if (lineOf(leg) !== undefined && !merged(leg) && (lineOf(leg) as number) > at) {
      at = toLine(leg, at, ring);
      ring = true;
    }
    drive(leg, at, edgeOf(leg).length, joins[leg] as number, ring || at > 0);
  };

  // Tick 0: the front at the first stop's halt, pulling away on its green.
  onward(home, stopOf(home) ?? 0, true);
  for (let lap = 1; lap < count; lap++) lay((home + lap) % count);
  call(home, true);
  // The first stop is called at on the closing run, so its call comes last; the calls go in stop order.
  calls.sort((a, b) => a.stop - b.stop);

  // Tick 0 of the loop falls on this tick of the signal cycle, light or not.
  const tour = finish(graph, route, steps, sync);
  const bell = new Uint8Array(steps.ticks.length);
  for (const step of bells) bell[step] = 1;
  return { tour, bell, calls, motion: new TramMotion(tour, Float64Array.from(leaves)) };
}

/**
 * Ticks of one lap a halted tram `length` metres long stands with its tail in
 * a junction while the traffic across that junction has its green: the time
 * that traffic may drive through the tail.
 */
export function tailAcross(tour: Tour, signals: TrafficSignals, length: number): number {
  const count = tour.edges.length;
  let total = 0;
  for (let step = 0; step < tour.stepTicks.length; step++) {
    if (tour.stepFrom[step] !== tour.stepTo[step]) continue;
    const behind = tour.edges[((tour.stepLeg[step] as number) + count - 1) % count] as number;
    total += tailAt(signals, behind, length, tour.stepTo[step] as number, tour.sync + (tour.stepStart[step] as number), tour.stepTicks[step] as number);
  }
  return total;
}

/**
 * Ticks a halted tram's tail stands in the junction at the end of edge
 * `behind` while the traffic across it has its green: the tram halted `at`
 * metres along the next run for `ticks` from an absolute tick, and pulling its
 * tail clear after.
 */
function tailAt(signals: TrafficSignals, behind: number, length: number, at: number, tick: number, ticks: number): number {
  const reach = length + BEHIND_CLEAR - at;
  const approach = signals.approachOf(behind);
  if (reach <= 0 || approach === undefined) return 0;
  const clear = Math.ceil(Math.sqrt((2 * reach) / TRAM_ACCEL) * TICK_RATE);
  return acrossGreen(signals, approach, tick, tick + ticks + clear);
}

/**
 * Ticks from `from` to `to`, both absolute, in which the traffic across an
 * approach has its green: the approach's own red, but for the moments both
 * axes are red.
 */
function acrossGreen(signals: TrafficSignals, approach: SignalApproach, from: number, to: number): number {
  const open = SIGNAL_GREEN[approach.axis] + SIGNAL_AMBER + SIGNAL_CLEAR;
  const shut = SIGNAL_CYCLE - SIGNAL_CLEAR;
  let total = 0;
  for (let cycle = from - mod(from - signals.greenStart(approach), SIGNAL_CYCLE); cycle < to; cycle += SIGNAL_CYCLE) {
    total += Math.max(0, Math.min(to, cycle + shut) - Math.max(from, cycle + open));
  }
  return total;
}

/**
 * Ticks the tram waits at a light it reaches on an absolute tick: none while
 * enough of its green is left to clear the junction, and otherwise until its
 * next green.
 */
function waitFor(signals: TrafficSignals, approach: SignalApproach, tick: number): number {
  const into = mod(tick - signals.greenStart(approach), SIGNAL_CYCLE);
  return into <= SIGNAL_GREEN[approach.axis] - TRAM_CLEAR ? 0 : SIGNAL_CYCLE - into;
}

function mod(value: number, by: number): number {
  return ((value % by) + by) % by;
}
