/**
 * The tram track as the renderer draws it (spec sections 6.3, 13.2).
 *
 * `world.tram.edges` are the runs of the road graph the loop drives. Each run
 * is a stretch of one curve, so the track is the curve segments those runs
 * cover, and it is swept in the same frames as the road under it: on the
 * ground, through a junction and over a deck alike. Where the loop runs down
 * one street twice the track is laid once.
 *
 * Built on demand from the world description and its graph, like the
 * footprint. Pure: the same world gives the same track.
 */
import { hypot } from '../core/libm.ts';
import type { RoadEdge, RoadGraph } from './graph.ts';
import type { Point, RoadCurve, RoadTier, WorldDescription } from './types.ts';

/** Where the tram crosses another road on the flat, and which way the track runs there. */
export interface TramCrossing {
  x: number;
  y: number;
  /** Unit vector along the track. */
  alongX: number;
  alongY: number;
  /** The tier of the road the track runs down, whose junction the crossing is drawn on. */
  tier: RoadTier;
}

/** The track of a world. */
export interface TramTrack {
  /** One mask per curve id, 1 at each segment the track runs down; undefined for a curve it never uses. */
  segments: (Uint8Array | undefined)[];
  crossings: TramCrossing[];
  /**
   * The places the track is paved rather than grassed: every junction the loop
   * passes, every level crossing and every stop. A car turns across the track
   * at a junction and a passenger walks over it at a stop, so the ground there
   * is stone; the open run between two of them is green (`corridor-mesh.ts`).
   */
  paved: Point[];
}

/** Metres each side of a paved place the track is still paved. */
export const PAVED_REACH = 10;
/** The shortest green stretch worth laying. A shorter one is paved instead of leaving a sliver. */
export const MIN_GREEN = 24;

/** The track of a world's tram loop. Empty where the world runs no tram. */
export function tramTrack(world: WorldDescription, graph: RoadGraph): TramTrack {
  const segments: (Uint8Array | undefined)[] = [];
  const runs = world.tram.edges.map((id) => graph.edges[id] as RoadEdge);
  for (const edge of runs) {
    const road = world.roads[edge.curve] as RoadCurve;
    const mask = segments[edge.curve] ?? new Uint8Array(road.points.length - 1);
    for (let i = Math.min(edge.start, edge.end); i < Math.max(edge.start, edge.end); i++) mask[i] = 1;
    segments[edge.curve] = mask;
  }

  const crossings = tramCrossings(world, graph, runs);
  const paved: Point[] = [];
  for (const edge of runs) {
    for (const node of [graph.nodes[edge.from], graph.nodes[edge.to]]) {
      if (node !== undefined) paved.push({ x: node.x, y: node.y });
    }
  }
  for (const crossing of world.tram.crossings) paved.push({ x: crossing.x, y: crossing.y });
  for (const stop of world.tram.stops) paved.push({ x: stop.x, y: stop.y });
  return { segments, crossings, paved };
}

/** Where the loop crosses a road, with the direction of the track through it: from the run arriving to the run leaving. */
function tramCrossings(world: WorldDescription, graph: RoadGraph, runs: readonly RoadEdge[]): TramCrossing[] {
  const crossings: TramCrossing[] = [];
  for (const crossing of world.tram.crossings) {
    // The run that arrives at the crossing and the one that leaves it. The loop
    // closes, so the run after the last is the first.
    const k = runs.findIndex((edge) => edge.to === crossing.node);
    if (k < 0) continue;
    const arriving = graph.edgePoints((runs[k] as RoadEdge).id);
    const leaving = graph.edgePoints((runs[(k + 1) % runs.length] as RoadEdge).id);
    const before = arriving[arriving.length - 2] as Point;
    const after = leaving[1] as Point;
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    const length = hypot(dx, dy);
    if (length === 0) continue;
    const tier = (runs[k] as RoadEdge).tier;
    crossings.push({ x: crossing.x, y: crossing.y, alongX: dx / length, alongY: dy / length, tier });
  }
  return crossings;
}
