/**
 * The ground the road network claims (spec section 6.4, steps 1 and 2).
 *
 * Every road is a curve, so the ground it covers is its centreline offset by
 * half the width of its tier — carriageway, verge and pavement, from the tier
 * table in `tiers.ts`. Where roads meet, an apron is laid over the junction so
 * the corner between them is rounded rather than notched. The tram's reserved
 * lane (spec section 6.3) claims its strip here too, because it is taken out of
 * the land the same way a carriageway is.
 *
 * A road claims the ground it stands on. A segment bored through a hill claims
 * nothing, since the hill over a bore is untouched, so the strips are laid
 * along the runs of each curve that are on the ground and stop at every
 * abutment and portal.
 *
 * The ground under a deck over land belongs to that deck's elevated corridor,
 * and the ground under a deck over water is not land at all. What the corridor
 * gave up is the road's: `corridors.ts` cuts a claim at ground another corridor
 * already holds, and gives up whole any segment that touches water, and the dry
 * ground it gave up is under the deck all the same, so the road claims it and
 * nothing is built there (issues #288 and #531).
 *
 * The pieces are unioned, so the result does not overlap itself and the blocks
 * between the roads come back as its holes. Subtracting it from the land is
 * step 3 of the parcel model, and what is left are the parcels.
 *
 * Built on demand from the world like the road graph, not stored in the world
 * description. Pure: the same world and graph give the same footprint.
 */
import { areaOf, difference, disc, regionOf, strip, union, type Region } from '../core/geom.ts';
import type { RoadGraph, RoadNode } from './graph.ts';
import { Heightfield } from './heightfield.ts';
import { deckHalfWidth, dryDeckLines } from './piers.ts';
import { footprintHalfWidth } from './tiers.ts';
import type { Point, RoadCurve, RoadTier, WorldDescription } from './types.ts';

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
  /**
   * One region per tram corridor of spec section 6.3. An elevated corridor is
   * not here: the ground under a deck is a parcel, not footprint.
   */
  corridors: Region[];
  /** The ground under the decks that no elevated corridor claims. */
  decks: Region[];
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
export function buildFootprint(world: WorldDescription, graph: RoadGraph): RoadFootprint {
  const parts = footprintParts(world, graph);
  const regions = union([...parts.strips, ...parts.aprons, ...parts.corridors, ...parts.decks]);
  return { regions, area: areaOf(regions) };
}

/** The pieces the footprint is unioned from, before the union. */
export function footprintParts(world: WorldDescription, graph: RoadGraph): FootprintParts {
  const strips: Region[] = [];
  for (const road of world.roads) {
    const halfWidth = footprintHalfWidth(road.tier);
    for (const run of groundRuns(road)) strips.push(regionOf(strip(run, halfWidth)));
  }
  const aprons: Region[] = [];
  for (const node of graph.nodes) {
    const ring = apronOf(graph, node);
    if (ring !== undefined) aprons.push(regionOf(ring.ring));
  }
  const lanes = world.corridors.filter((corridor) => corridor.kind === 'tram');
  return {
    strips,
    aprons,
    corridors: lanes.map((corridor) => regionOf(corridor.polygon)),
    decks: deckShadows(world),
  };
}

/**
 * The ground under the decks that no elevated corridor claims. A corridor is
 * claimed segment by segment and cut where another corridor already holds the
 * ground (`corridors.ts`), and a cut gives up the whole segment, however little
 * of it the other corridor wants. The ground the cut leaves is still under a
 * deck, so the road claims it: were it left over, `buildParcels` would hand it
 * to a parcel and a building would stand under the deck (issue #288).
 *
 * Only the ground under a deck is left: a deck over water covers none, so the
 * decks are cut at the waterline first (`dryDeckLines`). A corridor gives up a
 * segment that touches water whole, though the segment leaving the shore stands
 * on land for most of its length, and that land is under the deck all the same
 * (issue #531). Cutting at the waterline rather than at the segment also keeps
 * `area` a count of ground, since nothing over the sea is claimed.
 */
function deckShadows(world: WorldDescription): Region[] {
  const hf = new Heightfield(world.terrain);
  const sea = world.water.seaLevel;
  const shadows: Region[] = [];
  for (const road of world.roads) {
    const halfWidth = deckHalfWidth(road);
    for (const line of dryDeckLines(road, hf, sea)) shadows.push(regionOf(strip(line, halfWidth)));
  }
  if (shadows.length === 0) return [];
  const claimed = world.corridors.filter((corridor) => corridor.kind === 'elevated');
  const under = union(shadows);
  if (claimed.length === 0) return under;
  return difference(under, union(claimed.map((corridor) => regionOf(corridor.polygon))));
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
 * The apron over a junction, and the tier that claims it: a disc as wide as the
 * widest road that meets there on the ground. A place where only decks and
 * bores meet gets none, because nothing meets on the ground at all, and nor do
 * two roads that meet end to end, since they hand the strip over in line.
 */
export function apronOf(graph: RoadGraph, node: RoadNode): { ring: Point[]; tier: RoadTier } | undefined {
  if (node.edges.length < 3) return undefined;
  let tier: RoadTier | undefined;
  for (const id of node.edges) {
    const edge = graph.edges[id];
    if (edge === undefined || edge.bridge || edge.tunnel) continue;
    if (tier === undefined || footprintHalfWidth(edge.tier) > footprintHalfWidth(tier)) tier = edge.tier;
  }
  if (tier === undefined) return undefined;
  return { ring: disc(node.x, node.y, footprintHalfWidth(tier), APRON_CORNERS), tier };
}
