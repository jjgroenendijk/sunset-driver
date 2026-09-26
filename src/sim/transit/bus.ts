/**
 * Where a bus calls on its route, and how long it stands there (spec section 20.2).
 *
 * A bus of the ambient traffic drives the same closed route every other vehicle
 * does (`traffic-tour.ts`), and that route is its line. What makes it a bus is
 * that it pulls in at the kerb along the way instead of driving the whole loop
 * without stopping.
 *
 * A stop is a pure function of the route, so the same bus calls at the same
 * places for ever and two buses on one line call at the same kerbs. It stands
 * {@link STOP_IN} metres past the junction the bus came in through, which is
 * where a stop stands on a real street: clear of the crossing behind it, and
 * far enough from the stop line ahead that a bus at the kerb is never a bus in
 * the queue for the lights. `traffic-timing.ts` lays the call down as a halt in
 * the middle of the leg, and the lap absorbs it the way it absorbs a red light.
 *
 * How long the halt is the stop's own, not the line's: a stop on a busy road
 * gathers more people and the bus stands longer for them ({@link busDwell}).
 * The traffic is never stepped, so nobody is counted on or off. The people at
 * the kerb are a function of the tick instead (`bus-stops.ts`), gathering at
 * {@link ARRIVAL_TICKS} until the stop holds the {@link BusDemand.riders} it
 * was built for, and the dwell is the time that many take to board.
 */
import { rngFor, Subsystem } from '../../core/rng.ts';
import type { RoadEdge, RoadGraph } from '../../world/roads/graph.ts';
import { TIERS } from '../../world/roads/tiers.ts';
import { TICK_RATE } from '../clock.ts';
import type { SignalApproach, TrafficSignals } from '../traffic/signals.ts';

/** Metres of route between one call and the next: a stop every few blocks, not at every corner. */
export const STOP_SPACING = 320;

/**
 * Metres past the junction behind it a stop stands. It has to be under
 * `QUEUE_CLEAR` of `traffic-timing.ts`, which is the least road a signalled
 * approach keeps clear behind its queue: a stop further in than that could fall
 * inside the queue, and a bus would dwell in the middle of it.
 * `test/sim/transit/bus.test.ts` holds the two to that.
 */
export const STOP_IN = 15;

/** Metres of leg a bus needs past the stop to pull out again. */
export const STOP_ROOM = 25;

/** No call on this leg. */
export const NO_CALL = -1;

/** People one stop gathers at most, which is the longest queue one is drawn with. */
export const STOP_CAP = 6;

/** Ticks between one person arriving at a stop and the next. */
export const ARRIVAL_TICKS = 25 * TICK_RATE;

/** Ticks a bus stands with its doors open whether anybody boards or not. */
export const DOOR_TICKS = 2 * TICK_RATE;

/** Ticks one person takes to board. */
const BOARD_TICKS = Math.round(1.2 * TICK_RATE);

/** The people a stop on a leg gathers, which is what the bus stands there for. */
export interface BusDemand {
  riders(edge: RoadEdge): number;
}

/** The people a route timed without a world gathers: every stop the same. */
const EVEN_DEMAND: BusDemand = { riders: () => 3 };

/**
 * The demand of a world's stops. `busyAt` is how busy the road is, 0 to 1, as
 * `traffic.ts` reads it from the district: the same number that says how many
 * vehicles the road carries says how many people wait beside it.
 */
export function busDemandOf(seed: number, busyAt: (edge: RoadEdge) => number): BusDemand {
  return { riders: (edge) => ridersAt(seed, edge, busyAt(edge)) };
}

/** People the stop on one leg gathers: 1 on the quietest road, {@link STOP_CAP} on the busiest. */
export function ridersAt(seed: number, edge: RoadEdge, busy: number): number {
  const share = Math.min(1, Math.max(0, busy));
  const rng = rngFor(seed, 0, Subsystem.Bus, edge.id);
  return Math.min(STOP_CAP, 1 + Math.floor(rng.float() * share * STOP_CAP));
}

/** Ticks a bus stands at a kerb for `riders`: the doors, and the time they take to board. */
export function busDwell(riders: number): number {
  return DOOR_TICKS + boardTicks(riders);
}

/** The part of a dwell the queue is boarding over. The doors are open for the rest of it. */
export function boardTicks(riders: number): number {
  return riders * BOARD_TICKS;
}

/** Where a route calls, and how long it stands at each call. */
export interface BusRoute {
  /** Metres along each leg the bus calls at, or {@link NO_CALL} on a leg it drives straight through. */
  at: Float64Array;
  /** Ticks it stands at that call, and 0 on a leg with no call. */
  dwell: Int32Array;
}

/**
 * The calls of a route. The first leg that can hold a stop takes one, and
 * every leg after {@link STOP_SPACING} metres of route since the last call.
 */
export function busCalls(graph: RoadGraph, route: readonly number[], signals?: TrafficSignals, demand: BusDemand = EVEN_DEMAND): BusRoute {
  const at = new Float64Array(route.length).fill(NO_CALL);
  const dwell = new Int32Array(route.length);
  // The route opens ready to call, so a line stops as soon as it can.
  let since = STOP_SPACING;
  for (let i = 0; i < route.length; i++) {
    const edge = graph.edges[route[i] as number] as RoadEdge;
    if (since >= STOP_SPACING && holdsStop(edge, signals?.approachOf(edge.id))) {
      at[i] = STOP_IN;
      dwell[i] = busDwell(demand.riders(edge));
      since = edge.length - STOP_IN;
      continue;
    }
    since += edge.length;
  }
  return { at, dwell };
}

/**
 * True when a leg has room for a stop: a pavement for the stop to stand on and
 * the queue to wait on, long enough to pull in and out of, and, where it
 * arrives at a light, with its stop line far enough ahead that the kerb is
 * clear of the queue. A highway has no pavement, so a bus drives one through.
 */
function holdsStop(edge: RoadEdge, approach: SignalApproach | undefined): boolean {
  if (TIERS[edge.tier].pavement <= 0) return false;
  if (edge.length < STOP_IN + STOP_ROOM) return false;
  return approach === undefined || approach.stop > STOP_IN;
}
