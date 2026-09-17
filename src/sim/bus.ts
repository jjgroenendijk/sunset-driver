/**
 * Where a bus calls on its route (spec section 20.2).
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
 * Nothing here knows about passengers. The dwell is the same at every stop,
 * because a bus that stood for as long as its passengers took would have to be
 * stepped, and the traffic is never stepped.
 */
import type { RoadEdge, RoadGraph } from '../world/graph.ts';
import { TICK_RATE } from './clock.ts';
import type { SignalApproach, TrafficSignals } from './signals.ts';

/** Metres of route between one call and the next: a stop every few blocks, not at every corner. */
export const STOP_SPACING = 320;

/**
 * Metres past the junction behind it a stop stands. It has to be under
 * `QUEUE_CLEAR` of `traffic-timing.ts`, which is the least road a signalled
 * approach keeps clear behind its queue: a stop further in than that could fall
 * inside the queue, and a bus would dwell in the middle of it.
 * `test/bus.test.ts` holds the two to that.
 */
export const STOP_IN = 15;

/** Metres of leg a bus needs past the stop to pull out again. */
export const STOP_ROOM = 25;

/** Ticks a bus stands at a stop. */
export const BUS_DWELL = 7 * TICK_RATE;

/** No call on this leg. */
export const NO_CALL = -1;

/**
 * Metres along each leg of a route the bus calls at, or {@link NO_CALL} on a
 * leg it drives straight through. The first leg that can hold a stop takes one,
 * and every leg after {@link STOP_SPACING} metres of route since the last call.
 */
export function busCalls(graph: RoadGraph, route: readonly number[], signals?: TrafficSignals): Float64Array {
  const calls = new Float64Array(route.length).fill(NO_CALL);
  // The route opens ready to call, so a line always has a first stop.
  let since = STOP_SPACING;
  for (let i = 0; i < route.length; i++) {
    const edge = graph.edges[route[i] as number] as RoadEdge;
    if (since >= STOP_SPACING && holdsStop(edge, signals?.approachOf(edge.id))) {
      calls[i] = STOP_IN;
      since = edge.length - STOP_IN;
      continue;
    }
    since += edge.length;
  }
  return calls;
}

/**
 * True when a leg has room for a stop: long enough to pull in and out of, and,
 * where it arrives at a light, with its stop line far enough ahead that the
 * kerb is clear of the queue.
 */
function holdsStop(edge: RoadEdge, approach: SignalApproach | undefined): boolean {
  if (edge.length < STOP_IN + STOP_ROOM) return false;
  return approach === undefined || approach.stop > STOP_IN;
}
