/**
 * The loop one ambient vehicle drives (spec sections 5.3, 13.1).
 *
 * An ambient vehicle is not steered. It drives one closed route on the road
 * graph for ever, so where it is at a tick is a sum over that route and not the
 * result of every tick before it. The route is a walk from the edge the vehicle
 * was placed on. The walk goes straight on or turns at each node, and turns
 * back only at a dead end. It stops when it comes back to a node it has stood
 * on and the loop from there is long enough to read as a drive, not as a lap of
 * one block. A walk that finds no such loop drives back the way it came, or,
 * where it took a one-way ramp, back by the fastest route to where it began.
 * It never drives a ramp the wrong way, and it turns at a ramp's landing only
 * as `RoadGraph.turnAllowed` lets it.
 *
 * `traffic-timing.ts` says when each leg is driven and where the vehicle waits
 * at a red light; its names come out through here too.
 */
import type { Rng } from '../../core/rng.ts';
import type { RoadEdge, RoadGraph } from '../../world/roads/graph.ts';
import type { RoadTier } from '../../world/types.ts';

export { legAt, legNear, timeTour, type Tour } from './traffic-timing.ts';

/** Metres a loop has to be before a walk ends on it. Shorter is a car circling a block. */
const MIN_LOOP = 400;

/** Legs a walk takes before it gives up on a loop and drives back the way it came. */
const MAX_LEGS = 24;

/** Metres a walk covers before it gives up on a loop, so a route stays near its start. */
const MAX_REACH = 2500;

/** How much likelier the walk is to stay on the tier it started on than to leave it. */
const SAME_TIER = 4;

/** Whether a vehicle may drive an edge: a truck is kept off the tiers that bar trucks. */
export type Permit = (edge: RoadEdge) => boolean;

/**
 * Walk a closed route from one edge. Pure in the stream it is handed: the same
 * graph, edge and stream give the same route.
 */
export function walkTour(graph: RoadGraph, first: number, rng: Rng, permit: Permit): number[] {
  const { route, loop } = walkOut(graph, first, rng, permit);
  if (loop >= 0) return route.slice(loop);
  // No loop: drive back along the same road the other way. A ramp has no other
  // way, so a walk that took one is closed by the fastest route home instead.
  if (route.every((e) => (graph.edges[e] as RoadEdge).twin >= 0)) return route.concat(backOf(graph, route));
  const start = (graph.edges[first] as RoadEdge).from;
  const end = (graph.edges[route[route.length - 1] as number] as RoadEdge).to;
  const home = graph.shortestPath(end, start, permit);
  return home === undefined ? route : route.concat(home.edges);
}

/**
 * The walk from one edge until it closes a loop, and the leg the loop starts
 * at; -1 when the walk gave up first. The legs before the loop lead to it.
 * `reach` and `minLoop` stand in for {@link MAX_REACH} and {@link MIN_LOOP}
 * for a walker, who goes less far than a car.
 */
export function walkOut(graph: RoadGraph, first: number, rng: Rng, permit: Permit, reach = MAX_REACH, minLoop = MIN_LOOP): { route: number[]; loop: number } {
  const home = (graph.edges[first] as RoadEdge).tier;
  const route = [first];
  // `nodes[i]` is where leg `i` starts; the last entry is where the walk stands.
  const nodes = [(graph.edges[first] as RoadEdge).from, (graph.edges[first] as RoadEdge).to];
  let covered = (graph.edges[first] as RoadEdge).length;
  while (route.length < MAX_LEGS && covered < reach) {
    const last = graph.edges[route[route.length - 1] as number] as RoadEdge;
    const next = graph.edges[choose(graph, last, home, rng, permit)] as RoadEdge;
    route.push(next.id);
    nodes.push(next.to);
    covered += next.length;
    const loop = loopBack(graph, route, nodes, minLoop);
    if (loop >= 0) return { route, loop };
  }
  return { route, loop: -1 };
}

/** The legs of a walk driven back the other way, last leg first. A leg with no other way is driven as it is. */
export function backOf(graph: RoadGraph, route: readonly number[]): number[] {
  const back: number[] = [];
  for (let i = route.length - 1; i >= 0; i--) {
    const edge = graph.edges[route[i] as number] as RoadEdge;
    back.push(edge.twin >= 0 ? edge.twin : edge.id);
  }
  return back;
}

/**
 * The leg a loop starts at, when the walk has come back to a node it stood on
 * and the loop from there is at least {@link MIN_LOOP}. -1 when there is none.
 * The latest visit is tried first, so the loop is the tightest that is long
 * enough.
 */
function loopBack(graph: RoadGraph, route: readonly number[], nodes: readonly number[], minLoop: number): number {
  const at = nodes[nodes.length - 1] as number;
  let length = 0;
  for (let i = route.length - 1; i >= 0; i--) {
    length += (graph.edges[route[i] as number] as RoadEdge).length;
    if (nodes[i] === at && length >= minLoop) return i;
  }
  return -1;
}

/**
 * The next leg from the end of the last one. Turning back is the last resort:
 * it is taken only where nothing else leaves the node.
 */
function choose(graph: RoadGraph, last: RoadEdge, home: RoadTier, rng: Rng, permit: Permit): number {
  const out = graph.edgesFrom(last.to);
  const weight = (e: number, uturn: boolean): number => (graph.turnAllowed(last.id, e) ? weightOf(graph.edges[e] as RoadEdge, last, home, permit, uturn) : 0);
  let total = 0;
  for (const e of out) total += weight(e, false);
  const uturn = total === 0;
  if (uturn) for (const e of out) total += weight(e, true);
  if (total === 0) return last.twin >= 0 ? last.twin : last.id;
  let pick = rng.float() * total;
  for (const e of out) {
    pick -= weight(e, uturn);
    if (pick < 0) return e;
  }
  return out[out.length - 1] as number;
}

function weightOf(edge: RoadEdge, last: RoadEdge, home: RoadTier, permit: Permit, uturn: boolean): number {
  if (!permit(edge)) return 0;
  if (!uturn && edge.id === last.twin) return 0;
  return edge.tier === home ? SAME_TIER : 1;
}
