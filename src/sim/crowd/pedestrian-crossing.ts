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
import type { RoadEdge, RoadGraph } from '../../world/roads/graph.ts';
import type { Pavements, WalkPoint, WalkRoute } from './pedestrian-route.ts';
import type { TrafficSignals } from '../traffic/signals.ts';

/** Metres before and after the corner of a junction the walk is read over. */
const SCAN = 18;

/** Metres between two readings of the walk. */
const STEP = 0.5;

/** Metres taken off the room ahead of a reading, far more than it is ever rounded by. */
const HAIR = 1e-6;

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
    scanCorner({ pavements, graph, route, signals }, node, junction, [from, to], back, point, out);
  }
  return out.sort((a, b) => a.at - b.at);
}

/** What a scan for crossings reads: the pavements, the roads, the loop and the lights. */
interface CrossingScene {
  pavements: Pavements;
  graph: RoadGraph;
  route: WalkRoute;
  signals: TrafficSignals;
}

/**
 * Walk the loop over `span` round the corner at `node`, on a grid of steps,
 * and push a crossing for every stretch of carriageway under lights it goes
 * over.
 *
 * Between two bends of the walk a place moves no more than a step for each
 * step round the loop. So a reading holds for the steps that stand nearer than
 * both the next bend and the nearest edge of a carriageway, and the walk skips
 * them. It finds the crossings a reading at every step finds from a fraction
 * of the readings (#787).
 */
function scanCorner(
  scene: CrossingScene,
  node: number,
  junction: number,
  span: [number, number],
  back: number,
  point: WalkPoint,
  out: Crossing[],
): void {
  const { pavements, graph, route, signals } = scene;
  const [from, to] = span;
  // The last step stands past `to` when the span is not a whole number of steps, and reads as off the road.
  const last = Math.floor((to - from) / STEP + 0.5);
  const room = { clear: 0 };
  let open = -1;
  let edge = -1;
  for (let k = 0; ; ) {
    const d = from + k * STEP;
    let on = -1;
    if (d <= to) {
      pavements.sample(route, d, point, false);
      on = pavements.carriagewayAt(node, point.x, point.y, room);
    }
    if (on >= 0 && open < 0) {
      open = d;
      edge = on;
    } else if (on < 0 && open >= 0) {
      const axis = axisOf(graph, signals, edge);
      if (axis !== undefined) out.push({ at: wrap(open - back, route.length), end: wrap(d, route.length), junction, axis });
      open = -1;
    }
    if (k === last) return;
    // Every step skipped stands nearer than the nearest kerb and before the next bend. A kerb often
    // stands on a step, so the room is read a hair short, lest rounding carry the walk past it.
    const ahead = Math.min(room.clear, pavements.straightFor(route, d)) - HAIR;
    k = Math.min(last, k + Math.max(1, Math.ceil(ahead / STEP)));
  }
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
