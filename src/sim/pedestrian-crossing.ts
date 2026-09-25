/**
 * Where a pedestrian's walk crosses a road under traffic lights (spec section
 * 13.1, issue #286).
 *
 * A walk crosses roads only near the junctions its loop turns at, and near a
 * junction whose pavement runs straight on over a side road
 * (`pedestrian-route.ts`). So the walk is read round each junction with
 * lights, a step at a time, and every run of it that stands on a carriageway
 * is one crossing. The crossing belongs to the axis of the road it crosses,
 * and the person waits at the kerb until `TrafficSignals.crossingWait` lets
 * them over.
 */
import type { RoadEdge, RoadGraph } from '../world/graph.ts';
import type { Pavements, WalkPoint, WalkRoute } from './pedestrian-route.ts';
import type { TrafficSignals } from './signals.ts';

/** Metres before and after the corner of a junction the walk is read over. */
const SCAN = 18;

/** Metres between two readings of the walk. */
const STEP = 0.5;

/** Metres back from the carriageway a person stands to wait for the light, at the least. */
const KERB_BACK = 0.6;

/**
 * Metres further back a person may stand. Each waits at a depth of their own,
 * so the people who meet at one corner stand spread along the pavement rather
 * than on one spot, inside each other (#721).
 */
export const KERB_SPREAD = 2.4;

/** One stretch of a walk that crosses a road under lights. */
export interface Crossing {
  /** Metres round the loop the person waits at, back from the kerb. */
  at: number;
  /** Metres round the loop they are over the road at. */
  end: number;
  /** The junction, as an index into `TrafficSignals.junctions`. */
  junction: number;
  /** The axis of the road they cross. */
  axis: 0 | 1;
}

/**
 * Every crossing under lights round a loop, ascending by where they wait.
 * `depth` is the share of {@link KERB_SPREAD} this person stands back by.
 */
export function signalCrossings(pavements: Pavements, graph: RoadGraph, route: WalkRoute, signals: TrafficSignals, depth = 0): Crossing[] {
  const back = KERB_BACK + depth * KERB_SPREAD;
  const out: Crossing[] = [];
  const point: WalkPoint = { x: 0, y: 0, height: 0 };
  const count = route.edges.length;
  for (let i = 0; i < count; i++) {
    if (route.jay[i] === 1) continue;
    const node = (graph.edges[route.edges[i] as number] as RoadEdge).to;
    const junction = signals.junctionAt(node);
    if (junction < 0) continue;
    const next = (i + 1) % count;
    const from = (route.toCorner[i] as number) - SCAN;
    const to = (next === 0 ? route.length : (route.start[next] as number)) + SCAN;
    let open = -1;
    let edge = -1;
    for (let d = from; d <= to + STEP / 2; d += STEP) {
      pavements.sample(route, d, point);
      const on = d <= to ? pavements.carriagewayAt(node, point.x, point.y) : -1;
      if (on >= 0 && open < 0) {
        open = d;
        edge = on;
      } else if (on < 0 && open >= 0) {
        const axis = axisOf(graph, signals, edge);
        if (axis !== undefined) out.push({ at: wrap(open - back, route.length), end: wrap(d, route.length), junction, axis });
        open = -1;
      }
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The axis of the road a leaving edge is, read off the approach that arrives along it. */
function axisOf(graph: RoadGraph, signals: TrafficSignals, leaving: number): 0 | 1 | undefined {
  const twin = (graph.edges[leaving] as RoadEdge).twin;
  const approach = signals.approachOf(twin >= 0 ? twin : leaving);
  return approach?.axis;
}

function wrap(value: number, by: number): number {
  return ((value % by) + by) % by;
}
