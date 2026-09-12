/**
 * The ground the road network claims (spec section 6.4, steps 1 and 2).
 *
 * Every road is a curve, so the ground it covers is its centreline offset by
 * half the width of its tier — carriageway, verge and pavement, from the tier
 * table in `tiers.ts`. Where roads meet, an apron is laid over the junction so
 * the corner between them is rounded rather than notched. The corridors of
 * spec section 6.3 claim their strips here too, because the ground under a deck
 * and the tram's reserved lane are taken out of the land the same way a
 * carriageway is.
 *
 * A road only claims ground it stands on. A segment carried on a deck or bored
 * through a hill claims nothing: the ground under a deck over land belongs to
 * that road's elevated corridor, the ground under a deck over water is not land
 * at all, and the hill over a bore is untouched. So the footprint is laid along
 * the runs of each curve that are on the ground, and stops at every abutment
 * and portal.
 *
 * The pieces are unioned, so the result does not overlap itself and the blocks
 * between the roads come back as its holes. Subtracting it from the land is
 * step 3 of the parcel model, and what is left are the parcels.
 *
 * Built on demand from the curves like the road graph, not stored in the world
 * description. Pure: the same roads and corridors give the same footprint.
 */
import { areaOf, disc, regionOf, strip, union, type Region } from '../core/geom.ts';
import type { RoadGraph } from './graph.ts';
import { footprintHalfWidth } from './tiers.ts';
import type { Corridor, Point, RoadCurve } from './types.ts';

/** Corners of the apron laid over a junction. Enough that its flats read as a curve. */
const APRON_CORNERS = 8;

/**
 * The pieces the footprint is unioned from, kept apart by what laid them. The
 * union loses that: a tool that asks how much ground the aprons take on top of
 * the carriageways reads these instead.
 */
export interface FootprintParts {
  /** One strip per run of a road that lies on the ground. */
  strips: Region[];
  /** One apron per junction that takes one. */
  aprons: Region[];
  /** One region per corridor of spec section 6.3. */
  corridors: Region[];
}

/** The ground the roads and their corridors claim. */
export interface RoadFootprint {
  /** The pieces of that ground, each with the blocks inside it as holes. They do not overlap. */
  regions: Region[];
  /** Square metres of ground claimed. */
  area: number;
}

/**
 * Build the footprint of a road network. The graph says where roads meet, which
 * is where the junction aprons go.
 */
export function buildFootprint(
  roads: readonly RoadCurve[],
  corridors: readonly Corridor[],
  graph: RoadGraph,
): RoadFootprint {
  const parts = footprintParts(roads, corridors, graph);
  const regions = union([...parts.strips, ...parts.aprons, ...parts.corridors]);
  return { regions, area: areaOf(regions) };
}

/** The pieces the footprint is unioned from, before the union. */
export function footprintParts(
  roads: readonly RoadCurve[],
  corridors: readonly Corridor[],
  graph: RoadGraph,
): FootprintParts {
  const strips: Region[] = [];
  for (const road of roads) {
    const halfWidth = footprintHalfWidth(road.tier);
    for (const run of groundRuns(road)) strips.push(regionOf(strip(run, halfWidth)));
  }
  const aprons: Region[] = [];
  for (const node of graph.nodes) {
    const radius = apronRadius(graph, node.edges);
    if (radius > 0) aprons.push(regionOf(disc(node.x, node.y, radius, APRON_CORNERS)));
  }
  return { strips, aprons, corridors: corridors.map((corridor) => regionOf(corridor.polygon)) };
}

/**
 * The runs of a curve that lie on the ground, in the order they come. A curve
 * with no deck and no bore gives one run: the whole curve.
 */
function groundRuns(road: RoadCurve): Point[][] {
  const segments = road.points.length - 1;
  if (segments < 1) return [];
  const off = new Uint8Array(segments);
  for (const i of road.bridges) off[i] = 1;
  for (const i of road.tunnels) off[i] = 1;
  const runs: Point[][] = [];
  let start = -1;
  for (let i = 0; i <= segments; i++) {
    const onGround = i < segments && off[i] === 0;
    if (onGround && start === -1) start = i;
    if (!onGround && start !== -1) {
      runs.push(road.points.slice(start, i + 1));
      start = -1;
    }
  }
  return runs;
}

/**
 * How far the apron over a junction reaches: as far as the widest road that
 * meets there on the ground. A place where only decks and bores meet gets none,
 * because nothing meets on the ground at all.
 */
function apronRadius(graph: RoadGraph, edges: readonly number[]): number {
  // Two roads that meet end to end need no apron; they hand the strip over in line.
  if (edges.length < 3) return 0;
  let radius = 0;
  for (const id of edges) {
    const edge = graph.edges[id];
    if (edge === undefined || edge.bridge || edge.tunnel) continue;
    radius = Math.max(radius, footprintHalfWidth(edge.tier));
  }
  return radius;
}
