/**
 * The loop one ambient vehicle drives (spec sections 5.3, 13.1).
 *
 * An ambient vehicle is not steered. It drives one closed route on the road
 * graph for ever, so where it is at a tick is a sum over that route and not the
 * result of every tick before it. The route is a walk from the edge the vehicle
 * was placed on. The walk goes straight on or turns at each node, and turns
 * back only at a dead end. It stops when it comes back to a node it has stood
 * on and the loop from there is long enough to read as a drive, not as a lap of
 * one block. A walk that finds no such loop drives back the way it came.
 *
 * Every leg takes a whole number of ticks. That is what makes a vehicle stepped
 * one tick at a time land on exactly the tick its route says, with no rounding
 * in between (spec section 3).
 */
import type { Rng } from '../core/rng.ts';
import type { RoadEdge, RoadGraph } from '../world/graph.ts';
import type { RoadTier } from '../world/types.ts';
import { TICK_RATE } from './clock.ts';

/** Metres a loop has to be before a walk ends on it. Shorter is a car circling a block. */
export const MIN_LOOP = 400;

/** Legs a walk takes before it gives up on a loop and drives back the way it came. */
export const MAX_LEGS = 24;

/** Metres a walk covers before it gives up on a loop, so a route stays near its start. */
export const MAX_REACH = 2500;

/** Fraction of the speed limit ambient traffic drives at. */
export const CRUISE = 0.9;

/** How much likelier the walk is to stay on the tier it started on than to leave it. */
const SAME_TIER = 4;

/** One closed route and what each leg of it costs. */
export interface Tour {
  /** The edges in the order they are driven; the last one ends where the first starts. */
  edges: Int32Array;
  /** Ticks each leg takes, at least one. */
  legTicks: Int32Array;
  /** The tick of the route each leg starts on. */
  startTick: Int32Array;
  /** Metres along the route each leg starts at. */
  startDistance: Float64Array;
  /** Ticks once round. */
  period: number;
  /** Metres once round. */
  length: number;
}

/** Whether a vehicle may drive an edge: a truck is kept off the tiers that bar trucks. */
export type Permit = (edge: RoadEdge) => boolean;

/**
 * Walk a closed route from one edge. Pure in the stream it is handed: the same
 * graph, edge and stream give the same route.
 */
export function walkTour(graph: RoadGraph, first: number, rng: Rng, permit: Permit): number[] {
  const home = (graph.edges[first] as RoadEdge).tier;
  const route = [first];
  // `nodes[i]` is where leg `i` starts; the last entry is where the walk stands.
  const nodes = [(graph.edges[first] as RoadEdge).from, (graph.edges[first] as RoadEdge).to];
  let reach = (graph.edges[first] as RoadEdge).length;
  while (route.length < MAX_LEGS && reach < MAX_REACH) {
    const last = graph.edges[route[route.length - 1] as number] as RoadEdge;
    const next = graph.edges[choose(graph, last, home, rng, permit)] as RoadEdge;
    route.push(next.id);
    nodes.push(next.to);
    reach += next.length;
    const loop = loopBack(graph, route, nodes);
    if (loop >= 0) return route.slice(loop);
  }
  // No loop: drive back along the same road the other way.
  const back: number[] = [];
  for (let i = route.length - 1; i >= 0; i--) {
    const edge = graph.edges[route[i] as number] as RoadEdge;
    back.push(edge.twin >= 0 ? edge.twin : edge.id);
  }
  return route.concat(back);
}

/**
 * The leg a loop starts at, when the walk has come back to a node it stood on
 * and the loop from there is at least {@link MIN_LOOP}. -1 when there is none.
 * The latest visit is tried first, so the loop is the tightest that is long
 * enough.
 */
function loopBack(graph: RoadGraph, route: readonly number[], nodes: readonly number[]): number {
  const at = nodes[nodes.length - 1] as number;
  let length = 0;
  for (let i = route.length - 1; i >= 0; i--) {
    length += (graph.edges[route[i] as number] as RoadEdge).length;
    if (nodes[i] === at && length >= MIN_LOOP) return i;
  }
  return -1;
}

/**
 * The next leg from the end of the last one. Turning back is the last resort:
 * it is taken only where nothing else leaves the node.
 */
function choose(graph: RoadGraph, last: RoadEdge, home: RoadTier, rng: Rng, permit: Permit): number {
  const out = graph.edgesFrom(last.to);
  let total = 0;
  for (const e of out) total += weightOf(graph.edges[e] as RoadEdge, last, home, permit, false);
  const uturn = total === 0;
  if (uturn) for (const e of out) total += weightOf(graph.edges[e] as RoadEdge, last, home, permit, true);
  if (total === 0) return last.twin >= 0 ? last.twin : last.id;
  let pick = rng.float() * total;
  for (const e of out) {
    pick -= weightOf(graph.edges[e] as RoadEdge, last, home, permit, uturn);
    if (pick < 0) return e;
  }
  return out[out.length - 1] as number;
}

function weightOf(edge: RoadEdge, last: RoadEdge, home: RoadTier, permit: Permit, uturn: boolean): number {
  if (!permit(edge)) return 0;
  if (!uturn && edge.id === last.twin) return 0;
  return edge.tier === home ? SAME_TIER : 1;
}

/** The timing of a route: the ticks and metres at which each leg starts. */
export function timeTour(graph: RoadGraph, edges: readonly number[]): Tour {
  const count = edges.length;
  const tour: Tour = {
    edges: Int32Array.from(edges),
    legTicks: new Int32Array(count),
    startTick: new Int32Array(count),
    startDistance: new Float64Array(count),
    period: 0,
    length: 0,
  };
  for (let i = 0; i < count; i++) {
    const edge = graph.edges[edges[i] as number] as RoadEdge;
    const ticks = Math.max(1, Math.round((edge.length / (edge.speedLimit * CRUISE)) * TICK_RATE));
    tour.legTicks[i] = ticks;
    tour.startTick[i] = tour.period;
    tour.startDistance[i] = tour.length;
    tour.period += ticks;
    tour.length += edge.length;
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
