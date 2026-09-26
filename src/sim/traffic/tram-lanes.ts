/**
 * Where the traffic drives on a road the tram runs down (spec sections 6.3,
 * 13.2): the lanes give up the tram's reserved lane in the middle, and beside
 * a stop the island platform too.
 */
import type { RoadEdge, RoadGraph } from '../../world/roads/graph.ts';
import { PLATFORM_EDGE, TIERS, TRAM_LANE } from '../../world/roads/tiers.ts';
import type { TramStop } from '../../world/types.ts';
import { TRAM_LENGTH } from '../transit/tram.ts';
import { placeTramStops } from '../transit/tram-stop-place.ts';
import { SMOOTH, SWING, type TrafficRoads } from './traffic.ts';

/**
 * Metres from the centreline to the middle of a lane, an index of this run's
 * lanes, 0 nearest the middle. The lanes of one
 * direction share the right half of the carriageway evenly, less the parking
 * strip at the kerb, as the markings of `road-section.ts` divide it. An alley
 * and a dirt road have one lane both ways share, and a vehicle keeps to its
 * right half of it. On a run the tram drives, the lanes also give up the
 * middle of the road, which is the tram's reserved lane (spec section 6.3),
 * and on one that carries a stop they give up the island platform beside it
 * too, so no car drives over the ground a passenger stands on.
 */
export function laneOffset(edge: Pick<RoadEdge, 'tier' | 'lanes'>, lane: number, tram = false, platform = false): number {
  const spec = TIERS[edge.tier];
  // A ramp runs one way, so its lanes share the whole carriageway.
  if (edge.tier === 'ramp') return ((Math.min(lane, edge.lanes - 1) + 0.5) / edge.lanes - 0.5) * spec.width;
  const inner = laneInner(tram, platform);
  const width = (spec.width / 2 - spec.parking - inner) / edge.lanes;
  return inner + (lane + 0.5) * width;
}

/**
 * Metres from the centreline to the inner edge of the lanes of a run: the
 * middle of the road, the tram's reserved lane, or the far side of a tram
 * stop's platform and a margin.
 */
export function laneInner(tram: boolean, platform: boolean): number {
  if (platform) return PLATFORM_EDGE + TRAM_LANE.platformClear;
  return tram ? TRAM_LANE.halfWidth : 0;
}

/** {@link laneOffset} on a run, with the tram flags of {@link tramLanes} read for it. */
export function offsetIn(edge: Pick<RoadEdge, 'id' | 'tier' | 'lanes'>, lane: number, tram: Uint8Array): number {
  const reserved = tram[edge.id] as number;
  return laneOffset(edge, lane, reserved > 0, reserved === PLATFORM_LANE);
}

/** The tram flags of every run of a road network, as {@link tramLaneOf} sets them. */
export function tramLanes(roads: TrafficRoads): Uint8Array {
  return tramLaneOf(roads.graph, roads.tram?.edges ?? [], roads.tram?.stops ?? []);
}

/** The flag of a run that carries a tram stop, whose island platform the traffic keeps off. */
export const PLATFORM_LANE = 2;

/**
 * One flag per edge: 1 on the runs a tram drives, and on the same runs the
 * other way; {@link PLATFORM_LANE} on every run a stop's platform reaches
 * (`tram-stop-place.ts`), which gives it up as well. The reach runs on past
 * each end of the platform by the length a lane takes to swing round a
 * corner, so no car cuts across either end.
 */
function tramLaneOf(graph: RoadGraph, edges: readonly number[], stops: readonly TramStop[]): Uint8Array {
  const flags = new Uint8Array(graph.edges.length);
  const mark = (id: number | undefined, flag: number): void => {
    const edge = id === undefined ? undefined : graph.edges[id];
    if (edge === undefined) return;
    flags[edge.id] = Math.max(flags[edge.id] as number, flag);
    if (edge.twin >= 0) flags[edge.twin] = Math.max(flags[edge.twin] as number, flag);
  };
  for (const id of edges) mark(id, 1);
  if (edges.length === 0) return flags;
  const count = edges.length;
  const starts = new Float64Array(count);
  for (let leg = 1; leg < count; leg++) starts[leg] = (starts[leg - 1] as number) + (graph.edges[edges[leg - 1] as number] as RoadEdge).length;
  const total = (starts[count - 1] as number) + (graph.edges[edges[count - 1] as number] as RoadEdge).length;
  placeTramStops(graph, edges, stops, TRAM_LENGTH).forEach((place, i) => {
    const stop = stops[i] as TramStop;
    const leg = place?.leg ?? (stop.leaves - 1 + count) % count;
    const front = (starts[leg] as number) + (place?.halt ?? (graph.edges[edges[leg] as number] as RoadEdge).length);
    const from = front - TRAM_LENGTH - SWING - SMOOTH;
    const to = front + SWING + SMOOTH;
    for (let k = 0; k < count; k++) {
      const a = starts[k] as number;
      const b = a + (graph.edges[edges[k] as number] as RoadEdge).length;
      if ([-total, 0, total].some((shift) => a + shift < to && b + shift > from)) mark(edges[k], PLATFORM_LANE);
    }
  });
  return flags;
}
