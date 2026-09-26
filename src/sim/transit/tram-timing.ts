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
 * waited there would leave its tail across the junction behind it, on the
 * cross traffic's green. So the tram holds at the light before instead, until
 * it can pass the cramped lights ahead of it on their green. Where one wait
 * cannot fit all their greens, it fits the nearest ones.
 *
 * A light is a function of the tick, so the loop has to take a whole number of
 * signal cycles to agree with the lights for ever. Tick 0 is the tram pulling
 * away from the first stop on the green of that stop's light; the dwell back
 * at the first stop is stretched so the lap ends on that green again.
 */
import type { RoadEdge, RoadGraph } from '../../world/roads/graph.ts';
import type { TramStop } from '../../world/types.ts';
import { TICK_RATE } from '../clock.ts';
import { SIGNAL_CYCLE, SIGNAL_GREEN, STOP_BACK, type SignalApproach, type TrafficSignals } from '../traffic/signals.ts';
import { CRUISE, finish, Steps, type Tour } from '../traffic/traffic-timing.ts';

/** Metres per second the tram drives at most: a street tram, not a train. */
const TRAM_TOP = 50 / 3.6;

/** Ticks the tram stands at a stop. */
export const DWELL = 20 * TICK_RATE;

/** Ticks of green the tram needs left at a light to go on: the time it takes to clear the junction. */
export const TRAM_CLEAR = 6 * TICK_RATE;

/** Metres short of a junction's middle the tram halts where no stop line says where. */
const HALT_SHORT = 14;

/** Metres short of the stop line its front halts at. */
const LINE_GAP = 1;

/** Metres of a run the junction behind a halted tram may take, which its tail has to stay clear of. */
const BEHIND_CLEAR = 15;

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
  // The stop each run arrives at, or -1.
  const arrives = new Int32Array(count).fill(-1);
  for (const stop of stops) arrives[(stop.leaves - 1 + count) % count] = stop.id;
  const level = new Uint8Array(graph.nodes.length);
  for (const node of crossings) level[node] = 1;

  const edgeOf = (leg: number): RoadEdge => graph.edges[route[leg] as number] as RoadEdge;
  const last = count - 1;
  const anchor = signals?.approachOf(edgeOf(last).id);
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

  const ticksOf = (leg: number, metres: number): number => Math.ceil((metres / tramSpeed(edgeOf(leg))) * TICK_RATE);
  const drive = (leg: number, from: number, to: number, bell: boolean): void => {
    if (bell) bells.push(steps.ticks.length);
    const before = steps.ticks.length;
    steps.add(leg, from, to, ticksOf(leg, to - from));
    if (bell && steps.ticks.length === before) bells.pop();
  };
  const halts = (leg: number): boolean => {
    const edge = edgeOf(leg);
    return arrives[leg] as number >= 0 || level[edge.to] === 1 || signals?.approachOf(edge.id) !== undefined;
  };
  const haltOf = (leg: number): number => {
    const edge = edgeOf(leg);
    const approach = signals?.approachOf(edge.id);
    const line = approach === undefined ? edge.length - HALT_SHORT : approach.stop + STOP_BACK - LINE_GAP;
    return Math.min(edge.length, Math.max(0, line));
  };
  const cramped = (leg: number): boolean =>
    (arrives[leg] as number) < 0 && signals?.approachOf(edgeOf(leg).id) !== undefined && haltOf(leg) < length + BEHIND_CLEAR;
  /**
   * The ticks to wait at the halt of a run from an absolute tick: until its own
   * light and every cramped light the tram then drives straight on to are green
   * as it reaches them, or as many of the nearest of them as one wait allows.
   */
  const hold = (leg: number, tick: number): number => {
    if (signals === undefined) return 0;
    const lights: { approach: SignalApproach; after: number }[] = [];
    const own = signals.approachOf(edgeOf(leg).id);
    if (own !== undefined) lights.push({ approach: own, after: 0 });
    let after = ticksOf(leg, edgeOf(leg).length - haltOf(leg));
    for (let next = leg + 1; next < count; next++) {
      if (!halts(next)) {
        after += ticksOf(next, edgeOf(next).length);
        continue;
      }
      if (!cramped(next)) break;
      const halt = haltOf(next);
      after += ticksOf(next, halt);
      lights.push({ approach: signals.approachOf(edgeOf(next).id) as SignalApproach, after });
      after += ticksOf(next, edgeOf(next).length - halt);
    }
    // The farthest cramped light is given up first, so the nearest ones are still passed.
    for (; lights.length > 0; lights.pop()) {
      for (let wait = 0; wait < SIGNAL_CYCLE; wait++) {
        if (lights.every((light) => waitFor(signals, light.approach, tick + wait + light.after) === 0)) return wait;
      }
    }
    return 0;
  };
  /** Drive a run up to its halt, and call or wait there. The closing run waits for the end of the lap instead. */
  const arrive = (leg: number, closing: boolean): number => {
    const halt = haltOf(leg);
    drive(leg, 0, halt, false);
    const stop = arrives[leg] as number;
    const at = steps.tick;
    if (stop >= 0) steps.add(leg, halt, halt, DWELL);
    if (closing) steps.add(leg, halt, halt, mod(-steps.tick, SIGNAL_CYCLE));
    else steps.add(leg, halt, halt, hold(leg, sync + steps.tick));
    if (stop >= 0) calls.push({ stop, arrive: at, depart: steps.tick, front: (starts[leg] as number) + halt });
    return halt;
  };

  // Tick 0: the front at the first stop's halt, pulling away on its green.
  drive(last, haltOf(last), edgeOf(last).length, true);
  for (let leg = 0; leg < last; leg++) {
    if (!halts(leg)) {
      drive(leg, 0, edgeOf(leg).length, false);
      continue;
    }
    const halt = arrive(leg, false);
    drive(leg, halt, edgeOf(leg).length, true);
  }
  arrive(last, true);
  // The first stop is called at on the closing run, so its call comes last; the calls go in stop order.
  calls.sort((a, b) => a.stop - b.stop);

  // Tick 0 of the loop falls on this tick of the signal cycle, light or not.
  const tour = finish(graph, route, steps, sync);
  const bell = new Uint8Array(steps.ticks.length);
  for (const step of bells) bell[step] = 1;
  return { tour, bell, calls };
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
